#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// v5 MCP stdio server entry: JSON-RPC 2.0 over newline-delimited stdin/stdout.
// Thin glue over handleMcpRequest. DB resolution mirrors the CLI bin: --db,
// then --project via the registry, then RECALL_DB, then the deepest registered
// project for process.cwd(), then the RECALL_HOME-derived home local. The
// parent directory is created before opening so a cold start on a machine with
// no store directory works. The server stays single-store; federated reads
// remain CLI-only.
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, env, argv, exit } from "node:process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { handleMcpRequest, type JsonRpcRequest } from "./mcp-server.js";
import { SqliteStore } from "./store.js";
import { registryDbPath, resolveDbForSlug, whereProject } from "./routing.js";

interface McpRoute {
  dbPath: string;
  project?: string;
}

function resolveRoute(
  args: string[],
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): McpRoute {
  let db: string | undefined;
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--db" || arg === "--project") {
      const value = args[++i];
      if (value === undefined) {
        stderr.write(`recall-mcp: ${arg} requires a value\n`);
        exit(1);
      }
      if (arg === "--db") db = value;
      else project = value;
    }
  }
  if (db) return { dbPath: db };
  if (project) {
    const resolved = resolveDbForSlug(project, registryDbPath(environment));
    if (!resolved) {
      stderr.write(`recall-mcp: unknown project: ${project}\n`);
      exit(1);
    }
    return { dbPath: resolved, project };
  }
  const routed = whereProject(workingDirectory, environment, registryDbPath(environment));
  return { dbPath: routed.dbPath, project: routed.project?.slug };
}

const route = resolveRoute(argv.slice(2), env, process.cwd());
mkdirSync(dirname(route.dbPath), { recursive: true });
const store = new SqliteStore(route.dbPath);

const rl = createInterface({ input: stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(t) as JsonRpcRequest;
  } catch {
    return; // ignore non-JSON lines
  }
  const response = handleMcpRequest(request, store, { project: route.project });
  if (response) stdout.write(JSON.stringify(response) + "\n");
});

// stdio server: when the client closes stdin, the server is done.
rl.on("close", () => {
  store.close();
  process.exit(0);
});
