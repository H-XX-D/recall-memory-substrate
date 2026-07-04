import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerProject } from "./routing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-mcp-cli-"));
}

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n";

// Spawns the real mcp-cli entry (via tsx, matching how stop-hook.test.ts
// drives its bin) with a controlled environment: RECALL_DB and RECALL_HOME
// are scrubbed from the inherited env so only the overrides apply.
function runMcpCli(opts: {
  args?: string[];
  env?: Record<string, string>;
  input?: string;
}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RECALL_DB;
  delete env.RECALL_HOME;
  Object.assign(env, opts.env ?? {});
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      join(__dirname, "mcp-cli.ts"),
      ...(opts.args ?? []),
    ],
    { input: opts.input ?? INITIALIZE, encoding: "utf8", env },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function firstResponse(stdout: string): any {
  const line = stdout.split("\n").find((l) => l.trim() !== "");
  assert.ok(line, `no JSON-RPC response on stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}

test("cold start with no store directory answers initialize and creates the db under RECALL_HOME", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  try {
    const result = runMcpCli({ env: { HOME: emptyHome, RECALL_HOME: recallHome } });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    assert.equal(response.result.serverInfo.name, "recall");
    assert.ok(existsSync(join(recallHome, "db", "home.sqlite3")), "db created under RECALL_HOME/db");
    assert.ok(!existsSync(join(emptyHome, ".recall")), "nothing created under HOME/.recall");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
  }
});

test("--db places the store at the given path, creating missing parents", () => {
  const emptyHome = tempDir();
  const tmp = tempDir();
  try {
    const dbPath = join(tmp, "nested", "x.sqlite3");
    const result = runMcpCli({ args: ["--db", dbPath], env: { HOME: emptyHome } });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    assert.equal(response.result.serverInfo.name, "recall");
    assert.ok(existsSync(dbPath), "store created at the --db path");
    assert.ok(!existsSync(join(emptyHome, ".recall")), "nothing created under HOME/.recall");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--db overrides RECALL_DB (argv beats env, routing parity with the CLI)", () => {
  const emptyHome = tempDir();
  const tmp = tempDir();
  try {
    const argvDb = join(tmp, "argv.sqlite3");
    const envDb = join(tmp, "env.sqlite3");
    const result = runMcpCli({
      args: ["--db", argvDb],
      env: { HOME: emptyHome, RECALL_DB: envDb },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(argvDb), "store created at the --db path");
    assert.ok(!existsSync(envDb), "RECALL_DB path untouched when --db is given");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--project resolves the store through the registry under RECALL_HOME", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const projectRoot = tempDir();
  try {
    const registryDb = join(recallHome, "db", "registry.sqlite3");
    const record = registerProject(
      { slug: "demo", root: projectRoot },
      "2026-07-04T00:00:00.000Z",
      registryDb,
    );
    const result = runMcpCli({
      args: ["--project", "demo"],
      env: { HOME: emptyHome, RECALL_HOME: recallHome },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    assert.equal(response.result.serverInfo.name, "recall");
    assert.ok(existsSync(record.dbPath), "store created at the registered project db path");
    assert.ok(!existsSync(join(recallHome, "db", "home.sqlite3")), "home local untouched");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("--project with an unknown slug exits nonzero with a diagnostic", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  try {
    const result = runMcpCli({
      args: ["--project", "no-such-project"],
      env: { HOME: emptyHome, RECALL_HOME: recallHome },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown project/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
  }
});
