import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";

test("project init/list/where use the central registry under RECALL_HOME", () => {
  const tmp = tempDir();
  try {
    const env = { RECALL_HOME: join(tmp, "recall-home") } as NodeJS.ProcessEnv;
    const cwd = join(tmp, "repo");
    const init = capture(["project", "init", "--slug", "demo", "--description", "Demo"], { cwd, env });
    assert.equal(init.code, 0);
    const initJson = JSON.parse(init.stdout);
    assert.equal(initJson.project.slug, "demo");
    assert.match(initJson.project.dbPath, /demo\.sqlite3$/);

    const list = capture(["project", "list"], { cwd, env });
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).projects.length, 1);

    const where = capture(["where"], { cwd: join(cwd, "src"), env });
    assert.equal(where.code, 0);
    const whereJson = JSON.parse(where.stdout);
    assert.equal(whereJson.scope, "project");
    assert.equal(whereJson.slug, "demo");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validate, admit, search, compile, and cell show work against a routed db", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "dec",
        title: "watchdog cli decision",
        body: "The CLI should expose compile and search.",
        confidence: 0.8,
        topics: ["cli"],
        entities: ["Recall"],
      }),
    );

    const valid = capture(["validate", "--json", proposalPath]);
    assert.equal(valid.code, 0);
    assert.equal(JSON.parse(valid.stdout).ok, true);

    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(admitted.code, 0);
    const admittedJson = JSON.parse(admitted.stdout);
    assert.equal(admittedJson.accepted, true);
    const key = admittedJson.cell.key as string;

    const search = capture(["search", "watchdog", "--db", db]);
    assert.equal(search.code, 0);
    assert.equal(JSON.parse(search.stdout).hits[0].cell.key, key);

    const compiled = capture(["compile", "watchdog", "--db", db]);
    assert.equal(compiled.code, 0);
    assert.match(compiled.stdout, /objective:\nwatchdog/);
    assert.match(compiled.stdout, new RegExp(key));

    const cell = capture(["cell", "show", key, "--db", db]);
    assert.equal(cell.code, 0);
    assert.equal(JSON.parse(cell.stdout).cell.key, key);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("operate once runs the R3 operator cycle from the CLI", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const memberPath = join(tmp, "member.json");
    const programPath = join(tmp, "program.json");
    writeFileSync(
      memberPath,
      JSON.stringify({
        kind: "obs",
        title: "operator member",
        body: "The operator should see this member.",
        confidence: 0.8,
        topics: ["operator"],
      }),
    );
    const member = capture(["admit", "--json", memberPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(member.code, 0);
    const memberKey = JSON.parse(member.stdout).cell.key as string;

    writeFileSync(
      programPath,
      JSON.stringify({
        kind: "prg",
        title: "operator witness",
        body: "Emit a witness from operate once.",
        confidence: 0.8,
        topics: ["operator"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "emit_witness",
            target: { keys: [memberKey] },
          },
        },
      }),
    );
    const program = capture(["admit", "--json", programPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(program.code, 0);

    const operated = capture(["operate", "once", "--derive", "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(operated.code, 0, operated.stderr);
    const operatedJson = JSON.parse(operated.stdout);
    assert.equal(operatedJson.status, "ran");
    assert.equal(operatedJson.programs.runs.length, 1);
    assert.equal(operatedJson.programs.derived[0].accepted, true);
    assert.equal(operatedJson.stats.after.activeCells, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 is dry-run by default and export emits a portable archive", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const mem0Path = join(tmp, "mem0.json");
    writeFileSync(mem0Path, JSON.stringify({ memories: [{ id: "m1", memory: "CLI imported memory." }] }));

    const dry = capture(["import", "mem0", "--json", mem0Path, "--db", db]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);

    const statusBefore = capture(["status", "--db", db]);
    assert.equal(JSON.parse(statusBefore.stdout).stats.cells, 0);

    const applied = capture(["import", "mem0", "--json", mem0Path, "--apply", "--db", db], {
      now: "2026-06-26T12:00:00.000Z",
    });
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).created, 1);

    const exported = capture(["export", "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(exported.code, 0, exported.stderr);
    const archive = JSON.parse(exported.stdout);
    assert.equal(archive.schemaVersion, "recall.cells.export.v1");
    assert.equal(archive.cells.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("invalid proposal exits nonzero and reports schema issues", () => {
  const tmp = tempDir();
  try {
    const proposalPath = join(tmp, "bad.json");
    writeFileSync(proposalPath, JSON.stringify({ kind: "dec", title: "", body: "x", confidence: 2 }));
    const result = capture(["validate", "--json", proposalPath]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli migrate dry-run reports counts and writes nothing", () => {
  const tmp = tempDir();
  const oldPath = join(tmp, "old.sqlite3");
  const malPath = join(tmp, "mal.sqlite3");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE graph_nodes (id TEXT, cell_address TEXT, kind TEXT, title TEXT, body TEXT, summary TEXT, scope_json TEXT, tags_json TEXT, data_json TEXT, provenance_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE graph_relations (id TEXT, kind TEXT, source_id TEXT, target_id TEXT, data_json TEXT, created_at TEXT);
    CREATE TABLE hyperedges (id TEXT, kind TEXT, title TEXT, members_json TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE semantic_index (node_id TEXT, backend TEXT, dims INTEGER, vector_json TEXT, indexed_at TEXT);`);
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("a", null, "observation", "A", "abody", null, null, JSON.stringify({ topics: ["t"] }), JSON.stringify({ confidence: { value: 0.8 } }), null, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("b", null, "decision", "B", "bbody", null, null, null, null, null, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  old.close();
  try {
    const result = capture(["migrate", "--from", oldPath, "--db", malPath]);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout) as { cells: number; applied: boolean };
    assert.equal(json.cells, 2);
    assert.equal(json.applied, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function capture(
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; now?: string } = {},
): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    ...opts,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-cli-"));
}
