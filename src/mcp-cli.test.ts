import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerProject } from "./routing.js";
import { SqliteStore } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxImport = import.meta.resolve("tsx");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-mcp-cli-"));
}

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n";

// Spawns the real mcp-cli entry (via tsx, matching how stop-hook.test.ts
// drives its bin) with a controlled environment: RECALL_DB and RECALL_HOME
// are scrubbed from the inherited env so only the overrides apply.
function runMcpCli(opts: {
  args?: string[];
  cwd?: string;
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
      tsxImport,
      join(__dirname, "mcp-cli.ts"),
      ...(opts.args ?? []),
    ],
    { input: opts.input ?? INITIALIZE, encoding: "utf8", env, cwd: opts.cwd },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function firstResponse(stdout: string): any {
  const line = stdout.split("\n").find((l) => l.trim() !== "");
  assert.ok(line, `no JSON-RPC response on stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}

test("unregistered cwd falls back to the home store on a cold start", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const unregisteredCwd = tempDir();
  try {
    const result = runMcpCli({
      cwd: unregisteredCwd,
      env: { HOME: emptyHome, RECALL_HOME: recallHome },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    assert.equal(response.result.serverInfo.name, "recall");
    assert.ok(existsSync(join(recallHome, "db", "home.sqlite3")), "db created under RECALL_HOME/db");
    assert.ok(!existsSync(join(emptyHome, ".recall")), "nothing created under HOME/.recall");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(unregisteredCwd, { recursive: true, force: true });
  }
});

test("registered cwd selects the deepest project store", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const projectRoot = tempDir();
  try {
    const nestedRoot = join(projectRoot, "packages", "app");
    const workingDirectory = join(nestedRoot, "src");
    mkdirSync(workingDirectory, { recursive: true });
    const registryDb = join(recallHome, "db", "registry.sqlite3");
    const parent = registerProject(
      { slug: "parent", root: projectRoot },
      "2026-07-04T00:00:00.000Z",
      registryDb,
    );
    const nested = registerProject(
      { slug: "nested", root: nestedRoot },
      "2026-07-04T00:00:01.000Z",
      registryDb,
    );

    const result = runMcpCli({
      cwd: workingDirectory,
      env: { HOME: emptyHome, RECALL_HOME: recallHome },
      input:
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "recall_write",
            arguments: {
              kind: "obs",
              title: "MCP registered cwd routing witness",
              body: "Written through the real MCP process from the nested registered project.",
              confidence: 0.7,
            },
          },
        }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    const write = JSON.parse(response.result.content[0].text) as { accepted: boolean; id: string };
    assert.equal(write.accepted, true);
    assert.ok(existsSync(nested.dbPath), "deepest registered project store created");
    assert.ok(!existsSync(parent.dbPath), "ancestor project store untouched");
    assert.ok(!existsSync(join(recallHome, "db", "home.sqlite3")), "home local untouched");
    const store = new SqliteStore(nested.dbPath);
    try {
      assert.equal(store.get(write.id)?.scope.project, nested.slug);
    } finally {
      store.close();
    }
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
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

test("--db overrides --project, RECALL_DB, and registered cwd", () => {
  const emptyHome = tempDir();
  const tmp = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const projectRoot = tempDir();
  try {
    const registryDb = join(recallHome, "db", "registry.sqlite3");
    const project = registerProject(
      { slug: "demo", root: projectRoot },
      "2026-07-04T00:00:00.000Z",
      registryDb,
    );
    const argvDb = join(tmp, "argv.sqlite3");
    const envDb = join(tmp, "env.sqlite3");
    const result = runMcpCli({
      args: ["--project", "demo", "--db", argvDb],
      cwd: projectRoot,
      env: { HOME: emptyHome, RECALL_HOME: recallHome, RECALL_DB: envDb },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(argvDb), "store created at the --db path");
    assert.ok(!existsSync(envDb), "RECALL_DB path untouched when --db is given");
    assert.ok(!existsSync(project.dbPath), "project path untouched when --db is given");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("--project overrides RECALL_DB and registered cwd", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const cwdProjectRoot = tempDir();
  const selectedProjectRoot = tempDir();
  const tmp = tempDir();
  try {
    const registryDb = join(recallHome, "db", "registry.sqlite3");
    const cwdProject = registerProject(
      { slug: "cwd-project", root: cwdProjectRoot },
      "2026-07-04T00:00:00.000Z",
      registryDb,
    );
    const selectedProject = registerProject(
      { slug: "selected", root: selectedProjectRoot },
      "2026-07-04T00:00:01.000Z",
      registryDb,
    );
    const envDb = join(tmp, "env.sqlite3");
    const result = runMcpCli({
      args: ["--project", "selected"],
      cwd: cwdProjectRoot,
      env: { HOME: emptyHome, RECALL_HOME: recallHome, RECALL_DB: envDb },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = firstResponse(result.stdout);
    assert.equal(response.result.serverInfo.name, "recall");
    assert.ok(existsSync(selectedProject.dbPath), "store created at the selected project db path");
    assert.ok(!existsSync(cwdProject.dbPath), "cwd project store untouched");
    assert.ok(!existsSync(envDb), "RECALL_DB path untouched when --project is given");
    assert.ok(!existsSync(join(recallHome, "db", "home.sqlite3")), "home local untouched");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(cwdProjectRoot, { recursive: true, force: true });
    rmSync(selectedProjectRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RECALL_DB overrides a registered cwd", () => {
  const emptyHome = tempDir();
  const recallHome = join(tempDir(), "rhome");
  const projectRoot = tempDir();
  const tmp = tempDir();
  try {
    const registryDb = join(recallHome, "db", "registry.sqlite3");
    const project = registerProject(
      { slug: "demo", root: projectRoot },
      "2026-07-04T00:00:00.000Z",
      registryDb,
    );
    const envDb = join(tmp, "env.sqlite3");
    const result = runMcpCli({
      cwd: projectRoot,
      env: { HOME: emptyHome, RECALL_HOME: recallHome, RECALL_DB: envDb },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(envDb), "store created at the RECALL_DB path");
    assert.ok(!existsSync(project.dbPath), "registered cwd store untouched");
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(dirname(recallHome), { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
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
