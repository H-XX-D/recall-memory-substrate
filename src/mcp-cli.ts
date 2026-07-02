#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// v5 MCP stdio server entry: JSON-RPC 2.0 over newline-delimited stdin/stdout.
// Thin glue over handleMcpRequest. DB resolves from RECALL_DB, else the home
// local (filesystem-presence routing reconciliation is a later increment).
import { createInterface } from "node:readline";
import { stdin, stdout, env } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleMcpRequest, type JsonRpcRequest } from "./mcp-server.js";
import { SqliteStore } from "./store.js";

const dbPath = env.RECALL_DB ?? join(homedir(), ".recall", "db", "home.sqlite3");
const store = new SqliteStore(dbPath);

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
  const response = handleMcpRequest(request, store);
  if (response) stdout.write(JSON.stringify(response) + "\n");
});

// stdio server: when the client closes stdin, the server is done.
rl.on("close", () => {
  store.close();
  process.exit(0);
});
