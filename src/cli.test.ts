import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import { MAX_IMPORT_BYTES, parseCellArchive } from "./adapters.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    assert.ok(operatedJson.ledger?.id);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("operate list/show round-trip a ledger row written by operate once, with prefix resolution", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");

    const operated = capture(["operate", "once", "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(operated.code, 0, operated.stderr);
    const operatedJson = JSON.parse(operated.stdout);
    const runId = operatedJson.ledger.id as string;

    const list = capture(["operate", "list", "--db", db]);
    assert.equal(list.code, 0, list.stderr);
    const listJson = JSON.parse(list.stdout);
    assert.equal(listJson.runs.length, 1);
    assert.equal(listJson.runs[0].id, runId);
    assert.equal(listJson.runs[0].status, "ran");

    const prefix = runId.slice(0, 8);
    const shown = capture(["operate", "show", prefix, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout);
    assert.equal(shownJson.id, runId);
    assert.equal(shownJson.status, "ran");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("operate show with an unknown id exits nonzero with a clear error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    capture(["operate", "once", "--db", db], { now: "2026-06-26T12:01:00.000Z" });

    const shown = capture(["operate", "show", "does-not-exist", "--db", db]);
    assert.notEqual(shown.code, 0);
    assert.match(shown.stderr, /Unknown operator run/);
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
    assert.equal(archive.schemaVersion, "recall.cells.export.v2");
    assert.equal(archive.cells.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 --json - with an oversized stdin payload fails too-large with exit 1", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    // Build a payload whose JSON-encoded byte length exceeds MAX_IMPORT_BYTES
    // (134_217_728) without ever writing it to disk as a fixture.
    const bigContent = "x".repeat(MAX_IMPORT_BYTES + 1024);
    const stdinInput = JSON.stringify({ memories: [{ id: "m1", memory: bigContent }] });
    assert.ok(Buffer.byteLength(stdinInput, "utf8") > MAX_IMPORT_BYTES);

    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "cli.ts"), "import", "mem0", "--json", "-", "--db", db],
      { input: stdinInput, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /too large/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 --json - stdin cap counts bytes, not string length", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    // A 3-byte UTF-8 character (the euro sign, one UTF-16 code unit) repeated
    // 45,000,000 times gives a string whose .length (45,000,000) stays under
    // MAX_IMPORT_BYTES (134,217,728) while its UTF-8 byte length (135,000,000
    // plus JSON wrapping) exceeds it. A length-only regression would let this
    // payload through; the byte-counting cap must still reject it.
    const bigContent = "€".repeat(45_000_000);
    const stdinInput = JSON.stringify({ memories: [{ id: "m1", memory: bigContent }] });
    assert.ok(stdinInput.length < MAX_IMPORT_BYTES);
    assert.ok(Buffer.byteLength(stdinInput, "utf8") > MAX_IMPORT_BYTES);

    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "cli.ts"), "import", "mem0", "--json", "-", "--db", db],
      { input: stdinInput, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /too large/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 where every record is rejected exits 1 with the summary on stdout", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const mem0Path = join(tmp, "mem0.json");
    // A memory that lands exactly on its template instruction trips the
    // fill-or-reject rule: a deterministic, store-independent rejection.
    // (Credential-shaped strings no longer reject; they import flagged as
    // sensitivity: secret.)
    writeFileSync(
      mem0Path,
      JSON.stringify({
        memories: [{ id: "m1", memory: "non-empty: the claim, the evidence, and the reasoning" }],
      }),
    );

    const applied = capture(["import", "mem0", "--json", mem0Path, "--apply", "--db", db], {
      now: "2026-06-26T12:00:00.000Z",
    });
    assert.equal(applied.code, 1);
    const summary = JSON.parse(applied.stdout);
    assert.equal(summary.created, 0);
    assert.equal(summary.superseded, 0);
    assert.ok(summary.items.some((item: { reason?: string }) => item.reason?.startsWith("rejected")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 with a mixed batch (one clean, one rejected) exits 0 and prints the summary", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const mem0Path = join(tmp, "mem0.json");
    // One record admits cleanly; the other lands exactly on its template
    // instruction and is always rejected by fill-or-reject. With at least
    // one record landed, the run should still exit 0.
    writeFileSync(
      mem0Path,
      JSON.stringify({
        memories: [
          { id: "m1", memory: "CLI imported memory." },
          { id: "m2", memory: "non-empty: the claim, the evidence, and the reasoning" },
        ],
      }),
    );

    const applied = capture(["import", "mem0", "--json", mem0Path, "--apply", "--db", db], {
      now: "2026-06-26T12:00:00.000Z",
    });
    assert.equal(applied.code, 0, applied.stderr);
    const summary = JSON.parse(applied.stdout);
    assert.equal(summary.created, 1);
    assert.ok(summary.items.some((item: { reason?: string }) => item.reason?.startsWith("rejected")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import mem0 re-run where everything is already unchanged stays exit 0", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const mem0Path = join(tmp, "mem0.json");
    writeFileSync(mem0Path, JSON.stringify({ memories: [{ id: "m1", memory: "CLI imported memory." }] }));

    const first = capture(["import", "mem0", "--json", mem0Path, "--apply", "--db", db], {
      now: "2026-06-26T12:00:00.000Z",
    });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).created, 1);

    const second = capture(["import", "mem0", "--json", mem0Path, "--apply", "--db", db], {
      now: "2026-06-26T12:01:00.000Z",
    });
    assert.equal(second.code, 0, second.stderr);
    const summary = JSON.parse(second.stdout);
    assert.equal(summary.created, 0);
    assert.equal(summary.superseded, 0);
    assert.ok(summary.items.every((item: { reason?: string }) => item.reason === "unchanged"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("export --out writes a file containing a valid, parseable archive", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const outPath = join(tmp, "archive.json");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "export out target",
        body: "A cell that should end up in the exported file.",
        confidence: 0.8,
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);

    const exported = capture(["export", "--db", db, "--out", outPath], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(exported.stdout, "");

    const fileContents = readFileSync(outPath, "utf8");
    const parsedJson = JSON.parse(fileContents);
    assert.equal(parsedJson.schemaVersion, "recall.cells.export.v2");
    assert.equal(parsedJson.cells.length, 1);

    const archive = parseCellArchive(parsedJson);
    assert.equal(archive.cells.length, 1);
    assert.equal(archive.cells[0]?.title, "export out target");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import archive --reindex runs a full semantic reindex after an applied import", () => {
  const tmp = tempDir();
  try {
    const sourceDb = join(tmp, "source.sqlite3");
    const targetDb = join(tmp, "target.sqlite3");
    const archivePath = join(tmp, "archive.json");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "reindex target cell",
        body: "A cell that should get a semantic vector after --reindex.",
        confidence: 0.8,
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", sourceDb], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);

    const exported = capture(["export", "--db", sourceDb, "--out", archivePath], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(exported.code, 0, exported.stderr);

    const imported = capture(
      ["import", "archive", "--json", archivePath, "--apply", "--reindex", "--db", targetDb],
      { now: "2026-06-26T12:02:00.000Z" },
    );
    assert.equal(imported.code, 0, imported.stderr);
    const importedJson = JSON.parse(imported.stdout);
    assert.equal(importedJson.imported, 1);
    assert.equal(importedJson.reindexed, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import local --project X --apply round-trips against two temp dbs", () => {
  const tmp = tempDir();
  try {
    const globalDb = join(tmp, "global.sqlite3");
    const localDb = join(tmp, "local.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "global memory to bring local",
        body: "A cell that lives in the global store and should land locally.",
        confidence: 0.75,
        project: "demo",
        topics: ["release"],
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", globalDb], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);

    const dry = capture(
      ["import", "local", "--global-db", globalDb, "--project", "demo", "--db", localDb],
      { now: "2026-06-26T12:01:00.000Z" },
    );
    assert.equal(dry.code, 0, dry.stderr);
    const dryJson = JSON.parse(dry.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.created, 1);

    const statusBefore = capture(["status", "--db", localDb]);
    assert.equal(JSON.parse(statusBefore.stdout).stats.cells, 0);

    const applied = capture(
      ["import", "local", "--global-db", globalDb, "--project", "demo", "--apply", "--db", localDb],
      { now: "2026-06-26T12:02:00.000Z" },
    );
    assert.equal(applied.code, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout);
    assert.equal(appliedJson.created, 1);
    assert.equal(appliedJson.dryRun, false);

    const statusAfter = capture(["status", "--db", localDb]);
    assert.equal(JSON.parse(statusAfter.stdout).stats.cells, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import local without --project or --topics exits nonzero with a clear error", () => {
  const tmp = tempDir();
  try {
    const globalDb = join(tmp, "global.sqlite3");
    const localDb = join(tmp, "local.sqlite3");
    const result = capture(["import", "local", "--global-db", globalDb, "--db", localDb]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /import local needs a scope/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recall reindex indexes all cells, and --missing-only only indexes cells missing a semantic vector", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "standalone reindex cell",
        body: "A cell indexed by the standalone reindex verb.",
        confidence: 0.8,
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);

    const reindexed = capture(["reindex", "--db", db]);
    assert.equal(reindexed.code, 0, reindexed.stderr);
    assert.equal(JSON.parse(reindexed.stdout).indexed, 1);

    const missingOnly = capture(["reindex", "--missing-only", "--db", db]);
    assert.equal(missingOnly.code, 0, missingOnly.stderr);
    assert.equal(JSON.parse(missingOnly.stdout).indexed, 0);
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

test("hyperedge add from stdin JSON then show round-trips, and list respects --limit", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const memberPath = join(tmp, "member.json");
    writeFileSync(
      memberPath,
      JSON.stringify({
        kind: "obs",
        title: "hyperedge member cell",
        body: "A cell that will join a hyperedge.",
        confidence: 0.8,
        topics: ["hyperedge"],
      }),
    );
    const member = capture(["admit", "--json", memberPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(member.code, 0, member.stderr);
    const memberKey = JSON.parse(member.stdout).cell.key as string;

    const edgePath = join(tmp, "edge.json");
    writeFileSync(
      edgePath,
      JSON.stringify({
        kind: "cluster",
        title: "cli hyperedge",
        members: [memberKey],
      }),
    );

    const added = capture(["hyperedge", "add", "--json", edgePath, "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(added.code, 0, added.stderr);
    const addedJson = JSON.parse(added.stdout);
    assert.equal(addedJson.title, "cli hyperedge");
    assert.equal(addedJson.members[0].key, memberKey);
    const edgeId = addedJson.id as string;

    const shown = capture(["hyperedge", "show", edgeId, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).id, edgeId);

    // stdin form: --json -
    const stdinInput = JSON.stringify({ kind: "cluster", title: "second hyperedge", members: [memberKey] });
    const stdinAdd = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "cli.ts"), "hyperedge", "add", "--json", "-", "--db", db],
      { input: stdinInput, encoding: "utf8" },
    );
    assert.equal(stdinAdd.status, 0, stdinAdd.stderr);
    assert.equal(JSON.parse(stdinAdd.stdout).title, "second hyperedge");

    const list = capture(["hyperedge", "list", "--limit", "1", "--db", db]);
    assert.equal(list.code, 0, list.stderr);
    const listJson = JSON.parse(list.stdout);
    assert.equal(listJson.hyperedges.length, 1);

    const listAll = capture(["hyperedge", "list", "--db", db]);
    assert.equal(JSON.parse(listAll.stdout).hyperedges.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hyperedge show with an unknown id exits nonzero with an error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const result = capture(["hyperedge", "show", "no-such-id", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-id/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dag add from stdin JSON then show/list/analyze round-trip", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const nodeAPath = join(tmp, "node-a.json");
    const nodeBPath = join(tmp, "node-b.json");
    writeFileSync(
      nodeAPath,
      JSON.stringify({
        kind: "obs",
        title: "dag node a",
        body: "First node in the overlay.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    writeFileSync(
      nodeBPath,
      JSON.stringify({
        kind: "obs",
        title: "dag node b",
        body: "Second node in the overlay.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    const nodeA = capture(["admit", "--json", nodeAPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(nodeA.code, 0, nodeA.stderr);
    const nodeAKey = JSON.parse(nodeA.stdout).cell.key as string;
    const nodeB = capture(["admit", "--json", nodeBPath, "--db", db], { now: "2026-06-26T12:00:01.000Z" });
    assert.equal(nodeB.code, 0, nodeB.stderr);
    const nodeBKey = JSON.parse(nodeB.stdout).cell.key as string;

    const overlayPath = join(tmp, "overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        title: "cli dag overlay",
        nodeIds: [nodeAKey, nodeBKey],
        edges: [{ source: nodeAKey, target: nodeBKey, label: "leads_to" }],
      }),
    );

    const added = capture(["dag", "add", "--json", overlayPath, "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(added.code, 0, added.stderr);
    const addedJson = JSON.parse(added.stdout);
    assert.equal(addedJson.title, "cli dag overlay");
    assert.deepEqual(addedJson.nodeIds, [nodeAKey, nodeBKey]);
    const overlayId = addedJson.id as string;

    const shown = capture(["dag", "show", overlayId, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).id, overlayId);

    // stdin form: --json -
    const stdinInput = JSON.stringify({ title: "second overlay", nodeIds: [nodeAKey], edges: [] });
    const stdinAdd = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "cli.ts"), "dag", "add", "--json", "-", "--db", db],
      { input: stdinInput, encoding: "utf8" },
    );
    assert.equal(stdinAdd.status, 0, stdinAdd.stderr);
    assert.equal(JSON.parse(stdinAdd.stdout).title, "second overlay");

    const list = capture(["dag", "list", "--limit", "1", "--db", db]);
    assert.equal(list.code, 0, list.stderr);
    const listJson = JSON.parse(list.stdout);
    assert.equal(listJson.dagOverlays.length, 1);

    const listAll = capture(["dag", "list", "--db", db]);
    assert.equal(JSON.parse(listAll.stdout).dagOverlays.length, 2);

    const analyzed = capture(["dag", "analyze", overlayId, "--db", db]);
    assert.equal(analyzed.code, 0, analyzed.stderr);
    const analysis = JSON.parse(analyzed.stdout);
    assert.equal(analysis.overlayId, overlayId);
    assert.equal(analysis.isDag, true);
    assert.deepEqual(analysis.topologicalOrder, [nodeAKey, nodeBKey]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dag analyze --derive reports derived counts and short-circuits duplicates on a second run", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const nodeAPath = join(tmp, "node-a.json");
    const nodeBPath = join(tmp, "node-b.json");
    writeFileSync(
      nodeAPath,
      JSON.stringify({
        kind: "obs",
        title: "derive node a",
        body: "First node in the derive overlay.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    writeFileSync(
      nodeBPath,
      JSON.stringify({
        kind: "obs",
        title: "derive node b",
        body: "Second node in the derive overlay.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    const nodeA = capture(["admit", "--json", nodeAPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(nodeA.code, 0, nodeA.stderr);
    const nodeAKey = JSON.parse(nodeA.stdout).cell.key as string;
    const nodeB = capture(["admit", "--json", nodeBPath, "--db", db], { now: "2026-06-26T12:00:01.000Z" });
    assert.equal(nodeB.code, 0, nodeB.stderr);
    const nodeBKey = JSON.parse(nodeB.stdout).cell.key as string;

    const overlayPath = join(tmp, "derive-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        title: "cli derive overlay",
        nodeIds: [nodeAKey, nodeBKey],
        edges: [
          { source: nodeAKey, target: nodeBKey, label: "x" },
          { source: nodeAKey, target: nodeBKey, label: "y" },
        ],
      }),
    );
    const added = capture(["dag", "add", "--json", overlayPath, "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(added.code, 0, added.stderr);
    const overlayId = JSON.parse(added.stdout).id as string;

    const first = capture(["dag", "analyze", overlayId, "--derive", "--db", db], { now: "2026-06-26T12:02:00.000Z" });
    assert.equal(first.code, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout);
    assert.equal(firstJson.analysis.overlayId, overlayId);
    assert.equal(firstJson.derived.accepted > 0, true);
    assert.equal(firstJson.derived.duplicates, 0);
    assert.equal(firstJson.derived.rejected, 0);

    const second = capture(["dag", "analyze", overlayId, "--derive", "--db", db], { now: "2026-06-26T12:03:00.000Z" });
    assert.equal(second.code, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(secondJson.derived.accepted, 0);
    assert.equal(secondJson.derived.duplicates, firstJson.derived.accepted);
    assert.equal(secondJson.derived.rejected, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dag analyze without --derive omits the derived field", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const nodeAPath = join(tmp, "node-a.json");
    writeFileSync(
      nodeAPath,
      JSON.stringify({
        kind: "obs",
        title: "plain node a",
        body: "Node for a plain analyze.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    const nodeA = capture(["admit", "--json", nodeAPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    const nodeAKey = JSON.parse(nodeA.stdout).cell.key as string;
    const overlayPath = join(tmp, "plain-overlay.json");
    writeFileSync(overlayPath, JSON.stringify({ title: "plain overlay", nodeIds: [nodeAKey], edges: [] }));
    const added = capture(["dag", "add", "--json", overlayPath, "--db", db]);
    const overlayId = JSON.parse(added.stdout).id as string;

    const plain = capture(["dag", "analyze", overlayId, "--db", db]);
    assert.equal(plain.code, 0, plain.stderr);
    const plainJson = JSON.parse(plain.stdout);
    assert.equal(plainJson.overlayId, overlayId);
    assert.equal(plainJson.derived, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dag add rejects a cyclic overlay and exits nonzero", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const nodeAPath = join(tmp, "node-a.json");
    writeFileSync(
      nodeAPath,
      JSON.stringify({
        kind: "obs",
        title: "cycle node a",
        body: "Node that will form a cycle.",
        confidence: 0.8,
        topics: ["dag"],
      }),
    );
    const nodeA = capture(["admit", "--json", nodeAPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(nodeA.code, 0, nodeA.stderr);
    const nodeAKey = JSON.parse(nodeA.stdout).cell.key as string;

    const overlayPath = join(tmp, "cyclic-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        title: "cyclic overlay",
        nodeIds: [nodeAKey],
        edges: [
          { source: nodeAKey, target: nodeAKey },
        ],
      }),
    );

    const added = capture(["dag", "add", "--json", overlayPath, "--db", db]);
    assert.equal(added.code, 1);
    assert.match(added.stderr, new RegExp(nodeAKey));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dag show with an unknown id exits nonzero with an error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const result = capture(["dag", "show", "no-such-id", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-id/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("program run over a seeded prg cell prints the run, records history, and program runs/show-run see it", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const memberPath = join(tmp, "member.json");
    writeFileSync(
      memberPath,
      JSON.stringify({
        kind: "obs",
        title: "program member cell",
        body: "A cell scored by a standing program.",
        confidence: 0.8,
        topics: ["program"],
      }),
    );
    const member = capture(["admit", "--json", memberPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(member.code, 0, member.stderr);
    const memberKey = JSON.parse(member.stdout).cell.key as string;

    const programPath = join(tmp, "program.json");
    writeFileSync(
      programPath,
      JSON.stringify({
        kind: "prg",
        title: "cli score program",
        body: "score program members",
        confidence: 0.9,
        topics: ["program"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            description: "scores the member cell",
            target: { keys: [memberKey] },
          },
        },
      }),
    );
    const program = capture(["admit", "--json", programPath, "--db", db], { now: "2026-06-26T12:00:01.000Z" });
    assert.equal(program.code, 0, program.stderr);
    const programJson = JSON.parse(program.stdout).cell;
    const programKey = programJson.key as string;
    const programHandle = programJson.handle as string;

    const run = capture(["program", "run", programKey, "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(run.code, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.equal(runJson.run.operation, "score");
    assert.equal(runJson.run.programKey, programKey);
    assert.equal(runJson.derived, undefined);

    const list = capture(["program", "list", "--db", db]);
    assert.equal(list.code, 0, list.stderr);
    const listJson = JSON.parse(list.stdout);
    assert.equal(listJson.programs.length, 1);
    assert.equal(listJson.programs[0].key, programKey);
    assert.equal(listJson.programs[0].handle, programHandle);
    assert.equal(listJson.programs[0].operation, "score");
    assert.equal(listJson.programs[0].description, "scores the member cell");
    assert.equal(listJson.programs[0].runCount, 1);

    const runs = capture(["program", "runs", programKey, "--db", db]);
    assert.equal(runs.code, 0, runs.stderr);
    const runsJson = JSON.parse(runs.stdout);
    assert.equal(runsJson.runs.length, 1);
    assert.equal(runsJson.runs[0].id, runJson.run.id);

    const runsAll = capture(["program", "runs", "--db", db]);
    assert.equal(runsAll.code, 0, runsAll.stderr);
    assert.equal(JSON.parse(runsAll.stdout).runs.length, 1);

    // show-run resolves a prefix of the run id
    const prefix = (runJson.run.id as string).slice(0, 8);
    const shown = capture(["program", "show-run", prefix, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).id, runJson.run.id);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("program run resolves by handle and supports --derive", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const watchedPath = join(tmp, "watched.json");
    writeFileSync(
      watchedPath,
      JSON.stringify({
        kind: "obs",
        title: "watched program member",
        body: "A cell watched by a standing program.",
        confidence: 0.9,
        topics: ["program"],
      }),
    );
    const watched = capture(["admit", "--json", watchedPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(watched.code, 0, watched.stderr);
    const watchedKey = JSON.parse(watched.stdout).cell.key as string;

    const programPath = join(tmp, "watch-program.json");
    writeFileSync(
      programPath,
      JSON.stringify({
        kind: "prg",
        title: "cli watch program",
        body: "watch program members",
        confidence: 0.9,
        topics: ["program"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "watch",
            target: { keys: [watchedKey] },
            params: { delta: 0.1, concernTarget: watchedKey },
          },
        },
      }),
    );
    const program = capture(["admit", "--json", programPath, "--db", db], { now: "2026-06-26T12:00:01.000Z" });
    assert.equal(program.code, 0, program.stderr);
    const programHandle = JSON.parse(program.stdout).cell.handle as string;

    const baseline = capture(["program", "run", programHandle, "--db", db], { now: "2026-06-26T12:01:00.000Z" });
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).run.output.tripped, false);

    // Drop the watched cell's effective score to trip the watch on the next run.
    const dbHandle = new DatabaseSync(db);
    dbHandle
      .prepare(`UPDATE cells SET json = json_set(json, '$.scores.effective', 0.2) WHERE key = ?`)
      .run(watchedKey);
    dbHandle.close();

    const tripped = capture(["program", "run", programHandle, "--derive", "--db", db], {
      now: "2026-06-26T12:02:00.000Z",
    });
    assert.equal(tripped.code, 0, tripped.stderr);
    const trippedJson = JSON.parse(tripped.stdout);
    assert.equal(trippedJson.run.output.tripped, true);
    assert.equal(trippedJson.derived.accepted, true);
    assert.equal(trippedJson.derived.duplicateOf, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("program run with an unknown key exits nonzero with a clear error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const result = capture(["program", "run", "no-such-program", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-program/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("program show-run with an unknown id exits nonzero with an error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const result = capture(["program", "show-run", "no-such-run", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-run/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval run prints the default suite result and records it, and eval list/show round-trip with a prefix", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");

    const run = capture(["eval", "run", "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(run.code, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.equal(runJson.name, "recall-default");
    assert.equal(typeof runJson.passed, "boolean");
    assert.equal(typeof runJson.score, "number");
    assert.ok(Array.isArray(runJson.cases));
    assert.equal(runJson.derived, undefined);

    const list = capture(["eval", "list", "--db", db]);
    assert.equal(list.code, 0, list.stderr);
    const listJson = JSON.parse(list.stdout);
    assert.equal(listJson.runs.length, 1);
    assert.equal(listJson.runs[0].name, "recall-default");

    const runId = listJson.runs[0].id as string;
    const prefix = runId.slice(0, 8);
    const shown = capture(["eval", "show", prefix, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout);
    assert.equal(shownJson.id, runId);
    assert.equal(shownJson.name, "recall-default");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval run --derive routes through runEvalAndDerive and reports a derived admission", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");

    const run = capture(["eval", "run", "--derive", "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(run.code, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.equal(runJson.name, "recall-default");
    assert.ok(runJson.derived);
    assert.equal(runJson.derived.accepted, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval run --json runs a custom one-case suite", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const suitePath = join(tmp, "suite.json");
    writeFileSync(
      suitePath,
      JSON.stringify({
        name: "custom-smoke",
        cases: [{ name: "search-smoke", kind: "search", query: "recall", minResults: 0 }],
      }),
    );

    const run = capture(["eval", "run", "--json", suitePath, "--db", db], { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(run.code, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.equal(runJson.name, "custom-smoke");
    assert.equal(runJson.cases.length, 1);
    assert.equal(runJson.cases[0].name, "search-smoke");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval run --json with a malformed suite throws a clear error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const suitePath = join(tmp, "bad-suite.json");
    writeFileSync(suitePath, JSON.stringify({ cases: "not-an-array" }));

    const result = capture(["eval", "run", "--json", suitePath, "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /suite/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval run --json with an unrecognized case kind exits nonzero with a clear error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const suitePath = join(tmp, "bad-kind-suite.json");
    writeFileSync(
      suitePath,
      JSON.stringify({
        name: "x",
        cases: [{ name: "bad", kind: "serach", query: "q" }],
      }),
    );

    const result = capture(["eval", "run", "--json", suitePath, "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown eval case kind/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval show with an unknown id exits nonzero with a clear error", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const result = capture(["eval", "show", "no-such-run", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-run/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health prints a memory health report over a routed db", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "health cli seed cell",
        body: "Seed cell for the health report.",
        confidence: 0.8,
        topics: ["health"],
      }),
    );
    const seeded = capture(["admit", "--json", proposalPath, "--db", db]);
    assert.equal(seeded.code, 0, seeded.stderr);

    const health = capture(["health", "--db", db]);
    assert.equal(health.code, 0, health.stderr);
    const report = JSON.parse(health.stdout);
    assert.equal(typeof report.createdAt, "string");
    assert.ok(Array.isArray(report.beliefs));
    assert.ok(Array.isArray(report.stale));
    assert.ok(Array.isArray(report.contradictions));
    assert.ok(Array.isArray(report.nextActions));
    assert.equal(report.dangling.total, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health --derive admits an obs cell with concerns edges into the store", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const targetPath = join(tmp, "target.json");
    writeFileSync(
      targetPath,
      JSON.stringify({
        kind: "bel",
        title: "belief target for health derive",
        body: "A belief that will attract a contradiction.",
        confidence: 0.7,
        topics: ["health"],
      }),
    );
    const target = capture(["admit", "--json", targetPath, "--db", db]);
    assert.equal(target.code, 0, target.stderr);
    const targetKey = JSON.parse(target.stdout).cell.key as string;

    const contradictorPath = join(tmp, "contradictor.json");
    writeFileSync(
      contradictorPath,
      JSON.stringify({
        kind: "obs",
        title: "contradictor for health derive",
        body: "Contradicts the belief target.",
        confidence: 0.8,
        topics: ["health"],
        edges: [{ relation: "contradicts", target: targetKey }],
      }),
    );
    const contradictor = capture(["admit", "--json", contradictorPath, "--db", db]);
    assert.equal(contradictor.code, 0, contradictor.stderr);

    const derived = capture(["health", "--derive", "--db", db]);
    assert.equal(derived.code, 0, derived.stderr);
    const derivedJson = JSON.parse(derived.stdout);
    assert.equal(derivedJson.derive.accepted, true, JSON.stringify(derivedJson));
    assert.equal(derivedJson.derive.cell.kind, "obs");
    assert.equal(derivedJson.derive.cell.provenance.origin, "daemon");
    assert.ok(derivedJson.derive.cell.edgesOut.every((e: { relation: string }) => e.relation === "concerns"));

    const shown = capture(["cell", "show", derivedJson.derive.cell.key, "--db", db]);
    assert.equal(shown.code, 0, shown.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health --derive twice on the same day admits one witness cell; the second run reports duplicateOf", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const before = capture(["status", "--db", db]);
    assert.equal(before.code, 0, before.stderr);
    const cellsBefore = JSON.parse(before.stdout).stats.cells as number;

    const first = capture(["health", "--derive", "--db", db], { now: "2026-07-03T09:00:00.000Z" });
    assert.equal(first.code, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout);
    assert.equal(firstJson.derive.accepted, true, JSON.stringify(firstJson));
    assert.equal(firstJson.derive.duplicateOf, undefined);
    assert.match(firstJson.derive.cell.key, /^drv_memory_health_[0-9a-f]{24}$/);

    const afterFirst = capture(["status", "--db", db]);
    const cellsAfterFirst = JSON.parse(afterFirst.stdout).stats.cells as number;
    assert.equal(cellsAfterFirst, cellsBefore + 1);

    const second = capture(["health", "--derive", "--db", db], { now: "2026-07-03T21:00:00.000Z" });
    assert.equal(second.code, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(secondJson.derive.accepted, true, JSON.stringify(secondJson));
    assert.match(secondJson.derive.duplicateOf, /^drv_memory_health_[0-9a-f]{24}$/);
    assert.equal(secondJson.derive.cell.key, firstJson.derive.cell.key);

    const afterSecond = capture(["status", "--db", db]);
    const cellsAfterSecond = JSON.parse(afterSecond.stdout).stats.cells as number;
    assert.equal(cellsAfterSecond, cellsAfterFirst);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health --derive on a different day bucket admits a fresh witness cell", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const day1 = capture(["health", "--derive", "--db", db], { now: "2026-07-03T09:00:00.000Z" });
    assert.equal(day1.code, 0, day1.stderr);
    const day1Json = JSON.parse(day1.stdout);
    assert.equal(day1Json.derive.accepted, true, JSON.stringify(day1Json));

    const day2 = capture(["health", "--derive", "--db", db], { now: "2026-07-04T09:00:00.000Z" });
    assert.equal(day2.code, 0, day2.stderr);
    const day2Json = JSON.parse(day2.stdout);
    assert.equal(day2Json.derive.accepted, true, JSON.stringify(day2Json));
    assert.equal(day2Json.derive.duplicateOf, undefined);
    assert.notEqual(day2Json.derive.cell.key, day1Json.derive.cell.key);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health --derive with --project buckets the witness key separately per project", () => {
  const tmp = tempDir();
  try {
    const env = { RECALL_HOME: join(tmp, "recall-home") } as NodeJS.ProcessEnv;
    const alphaCwd = join(tmp, "alpha-repo");
    const betaCwd = join(tmp, "beta-repo");

    const initAlpha = capture(["project", "init", "--slug", "alpha"], { cwd: alphaCwd, env });
    assert.equal(initAlpha.code, 0, initAlpha.stderr);
    const initBeta = capture(["project", "init", "--slug", "beta"], { cwd: betaCwd, env });
    assert.equal(initBeta.code, 0, initBeta.stderr);

    const alpha = capture(["health", "--derive", "--project", "alpha"], { env, now: "2026-07-03T09:00:00.000Z" });
    assert.equal(alpha.code, 0, alpha.stderr);
    const alphaJson = JSON.parse(alpha.stdout);
    assert.equal(alphaJson.derive.accepted, true, JSON.stringify(alphaJson));

    const beta = capture(["health", "--derive", "--project", "beta"], { env, now: "2026-07-03T09:00:00.000Z" });
    assert.equal(beta.code, 0, beta.stderr);
    const betaJson = JSON.parse(beta.stdout);
    assert.equal(betaJson.derive.accepted, true, JSON.stringify(betaJson));
    assert.notEqual(betaJson.derive.cell.key, alphaJson.derive.cell.key);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage prints the storage stats report over a routed on-disk db", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "dec",
        title: "storage verb decision",
        body: "The CLI should expose storage stats.",
        confidence: 0.8,
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], {
      now: "2026-07-03T12:00:00.000Z",
    });
    assert.equal(admitted.code, 0, admitted.stderr);

    const storage = capture(["storage", "--db", db]);
    assert.equal(storage.code, 0, storage.stderr);
    const report = JSON.parse(storage.stdout);
    assert.equal(report.databasePath, db);
    assert.equal(typeof report.databaseBytes, "number");
    assert.equal(report.tables.cells, 1);
    assert.equal(report.tables.edges, 0);
    assert.equal(report.maximumCell.title, "storage verb decision");
    assert.equal(typeof report.averageCellBytes, "number");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("import auto-memory with an explicit --root imports the fixture tree", () => {
  const tmp = tempDir();
  const root = mkdtempSync(join(tmpdir(), "recall-v5-cli-auto-memory-"));
  try {
    const db = join(tmp, "recall.sqlite3");
    const memoryDir = join(root, "demo", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "---\nname: Demo note\ntype: project\n---\nProject memory.");

    const result = capture(["import", "auto-memory", "--root", root, "--apply", "--db", db]);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.created, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("import auto-memory without --root defaults to DEFAULT_AUTO_MEMORY_ROOT under HOME", () => {
  const tmp = tempDir();
  const home = mkdtempSync(join(tmpdir(), "recall-v5-cli-auto-memory-home-"));
  try {
    const db = join(tmp, "recall.sqlite3");
    const memoryDir = join(home, ".claude", "projects", "demo", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "---\nname: Demo note\ntype: project\n---\nProject memory.");

    const result = capture(["import", "auto-memory", "--apply", "--db", db], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.created, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude sync/status round-trip through the CLI against a temp HOME", () => {
  const tmp = tempDir();
  const home = mkdtempSync(join(tmpdir(), "recall-v5-cli-claude-sync-"));
  try {
    const dryRun = capture(["claude", "sync"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryJson = JSON.parse(dryRun.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.ok(dryJson.settingsChanged.length > 0);
    // The auto-memory leg must stay inside the temp HOME, never the real machine.
    assert.ok(dryJson.autoMemoryDb.startsWith(home));
    assert.equal(dryJson.autoMemoryImport, null);

    const statusBefore = capture(["claude", "status"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    assert.equal(JSON.parse(statusBefore.stdout).hooksInstalled, false);

    const db = join(tmp, "recall.sqlite3");
    const apply = capture(["claude", "sync", "--apply", "--keep-automemory", "--db", db], {
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    assert.equal(apply.code, 0, apply.stderr);
    const applyJson = JSON.parse(apply.stdout);
    assert.equal(applyJson.dryRun, false);
    assert.equal(applyJson.autoMemoryImport, null);

    const statusAfter = capture(["claude", "status"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(statusAfter.code, 0, statusAfter.stderr);
    const statusJson = JSON.parse(statusAfter.stdout);
    assert.equal(statusJson.hooksInstalled, true);
    // --keep-automemory maps to disableAutoMemory: false, so auto-memory stays enabled.
    assert.equal(statusJson.autoMemoryDisabled, false);
    assert.equal(statusJson.mcpInstalled, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude sync --write-gate lands the node prompt/stop hook entries in the written settings.json", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-v5-cli-claude-writegate-"));
  try {
    const apply = capture(["claude", "sync", "--apply", "--keep-automemory", "--write-gate"], {
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    assert.equal(apply.code, 0, apply.stderr);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const promptHooks = settings.hooks.UserPromptSubmit[0].hooks;
    const stopHooks = settings.hooks.Stop[0].hooks;
    assert.equal(promptHooks.length, 2);
    assert.equal(promptHooks[1].command, "recall-prompt-hook");
    assert.equal(stopHooks.length, 2);
    assert.equal(stopHooks[1].command, "recall-stop-hook");

    // Nothing outside the temp HOME was touched: the hook asset lands under it.
    assert.equal(existsSync(join(home, ".claude", "hooks", "recall-session-start.py")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex sync/status round-trip through the CLI against a temp HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-v5-cli-codex-sync-"));
  try {
    const dryRun = capture(["codex", "sync"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryJson = JSON.parse(dryRun.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.configChanged, true);
    assert.equal(dryJson.agentsChanged, true);
    assert.equal(dryJson.hooksChanged, true);
    assert.equal(dryJson.hookAssetChanged, true);
    assert.equal(existsSync(join(home, ".codex", "config.toml")), false);

    const statusBefore = capture(["codex", "status"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    const statusBeforeJson = JSON.parse(statusBefore.stdout);
    assert.equal(statusBeforeJson.mcpInstalled, false);
    assert.equal(statusBeforeJson.agentsBlockPresent, false);
    assert.equal(statusBeforeJson.hooksInstalled, false);

    const apply = capture(["codex", "sync", "--apply", "--db", "/tmp/recall-codex-cli.sqlite3"], {
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    assert.equal(apply.code, 0, apply.stderr);
    const applyJson = JSON.parse(apply.stdout);
    assert.equal(applyJson.dryRun, false);
    assert.equal(applyJson.configChanged, true);
    assert.equal(applyJson.agentsChanged, true);
    assert.equal(applyJson.hooksChanged, true);
    assert.equal(applyJson.hookAssetInstalled, true);

    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(config, /RECALL_DB = "\/tmp\/recall-codex-cli\.sqlite3"/);

    const statusAfter = capture(["codex", "status"], { env: { HOME: home } as NodeJS.ProcessEnv });
    assert.equal(statusAfter.code, 0, statusAfter.stderr);
    const statusAfterJson = JSON.parse(statusAfter.stdout);
    assert.equal(statusAfterJson.mcpInstalled, true);
    assert.equal(statusAfterJson.agentsBlockPresent, true);
    assert.equal(statusAfterJson.hooksInstalled, true);
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex sync honors CODEX_HOME through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-v5-cli-codex-home-"));
  const codexHome = join(home, "custom-codex");
  try {
    const result = capture(["codex", "sync", "--apply"], {
      env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(codexHome, "hooks.json")), true);
    assert.equal(existsSync(join(codexHome, "hooks", "recall-session-start.py")), true);
    assert.equal(existsSync(join(home, ".codex")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("maintain runs the routed store by default and prints a single-element JSON list", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "maintain cli seed cell",
        body: "Seed cell for the maintain pass.",
        confidence: 0.8,
        topics: ["maintain"],
      }),
    );
    const seeded = capture(["admit", "--json", proposalPath, "--db", db]);
    assert.equal(seeded.code, 0, seeded.stderr);

    const result = capture(["maintain", "--db", db], { now: "2026-07-03T12:00:00.000Z" });
    assert.equal(result.code, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    assert.equal(results[0].dbPath, db);
    assert.ok("ticked" in results[0].operator);
    assert.ok("passed" in results[0].eval);
    assert.ok("accepted" in results[0].health);
    assert.equal(typeof results[0].reindexed, "number");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("maintain --all-graphs sweeps every local graph under RECALL_HOME", () => {
  const tmp = tempDir();
  try {
    const home = join(tmp, "recall-home");
    const env = { RECALL_HOME: home } as NodeJS.ProcessEnv;

    const initA = capture(["project", "init", "--slug", "repo-a", "--root", join(tmp, "repoA")], { env });
    assert.equal(initA.code, 0, initA.stderr);
    const initB = capture(["project", "init", "--slug", "repo-b", "--root", join(tmp, "repoB")], { env });
    assert.equal(initB.code, 0, initB.stderr);

    const result = capture(["maintain", "--all-graphs"], { env, now: "2026-07-03T12:00:00.000Z" });
    assert.equal(result.code, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 3); // home + repo-a + repo-b
    const graphs = results.map((r: { graph: string }) => r.graph).sort();
    assert.deepEqual(graphs, ["home", "repo-a", "repo-b"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("service install/status/uninstall round-trip against a temp LaunchAgents dir and never invoke launchctl", () => {
  const tmp = tempDir();
  try {
    const env = {
      RECALL_LAUNCH_AGENTS_DIR: join(tmp, "LaunchAgents"),
      RECALL_LOG_DIR: join(tmp, "logs"),
    } as NodeJS.ProcessEnv;

    const before = capture(["service", "status"], { env });
    assert.equal(before.code, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).installed, false);

    const install = capture(["service", "install"], { env });
    assert.equal(install.code, 0, install.stderr);
    const installJson = JSON.parse(install.stdout);
    assert.equal(installJson.label, "io.recall.maintain");
    assert.ok(existsSync(installJson.path));
    if (process.platform === "darwin") {
      assert.match(install.stdout + install.stderr, /launchctl load/);
    } else {
      assert.match(install.stdout + install.stderr, /Crontab equivalent/);
      assert.doesNotMatch(install.stdout + install.stderr, /\*\/\d{2,} \* \* \* \*/);
    }

    const after = capture(["service", "status"], { env });
    assert.equal(JSON.parse(after.stdout).installed, true);

    const uninstall = capture(["service", "uninstall"], { env });
    assert.equal(uninstall.code, 0, uninstall.stderr);
    const finalStatus = capture(["service", "status"], { env });
    assert.equal(JSON.parse(finalStatus.stdout).installed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("service install --interval-min honors a custom interval", () => {
  const tmp = tempDir();
  try {
    const env = {
      RECALL_LAUNCH_AGENTS_DIR: join(tmp, "LaunchAgents"),
      RECALL_LOG_DIR: join(tmp, "logs"),
    } as NodeJS.ProcessEnv;

    const install = capture(["service", "install", "--interval-min", "15"], { env });
    assert.equal(install.code, 0, install.stderr);
    const plist = readFileSync(JSON.parse(install.stdout).path, "utf8");
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("admit output includes guidance with candidate edges by default", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const seedPath = join(tmp, "seed.json");
    writeFileSync(
      seedPath,
      JSON.stringify({
        kind: "bel",
        title: "WAL checkpoints stall under heavy write load",
        body: "Claim to verify.",
        confidence: 0.6,
        topics: ["storage"],
      }),
    );
    const seeded = capture(["admit", "--json", seedPath, "--db", db], { now: "2026-07-04T12:00:00.000Z" });
    assert.equal(seeded.code, 0, seeded.stderr);

    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "WAL mode kept readers unblocked during bulk import",
        body: "Measured on the event store.",
        confidence: 0.6,
        topics: ["storage"],
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-07-04T12:01:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);
    const parsed = JSON.parse(admitted.stdout);
    assert.equal(parsed.accepted, true);
    assert.ok(parsed.guidance, "expected a guidance field");
    assert.ok(parsed.guidance.candidateEdges.length >= 1);
    // Suggestions run by default; empty here because no threshold is met.
    assert.ok(Array.isArray(parsed.guidance.programSuggestions));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("admit --no-guidance omits the guidance field", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "guidance suppressed cell",
        body: "Admitted with --no-guidance.",
        confidence: 0.6,
        topics: ["storage"],
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--no-guidance", "--db", db], {
      now: "2026-07-04T12:00:00.000Z",
    });
    assert.equal(admitted.code, 0, admitted.stderr);
    const parsed = JSON.parse(admitted.stdout);
    assert.equal(parsed.accepted, true);
    assert.ok(!("guidance" in parsed));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("admit --suggest-programs surfaces program suggestions", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    for (let i = 0; i < 5; i++) {
      const seedPath = join(tmp, `seed-${i}.json`);
      writeFileSync(
        seedPath,
        JSON.stringify({
          kind: "obs",
          title: `latency obs number ${i}`,
          body: `cell ${i}`,
          confidence: 0.6,
          topics: ["latency"],
        }),
      );
      const seeded = capture(["admit", "--json", seedPath, "--db", db], { now: "2026-07-04T12:00:00.000Z" });
      assert.equal(seeded.code, 0, seeded.stderr);
    }
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "latency spike observed again",
        body: "b",
        confidence: 0.6,
        topics: ["latency"],
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--suggest-programs", "--db", db], {
      now: "2026-07-04T12:01:00.000Z",
    });
    assert.equal(admitted.code, 0, admitted.stderr);
    const parsed = JSON.parse(admitted.stdout);
    const watch = parsed.guidance.programSuggestions.find(
      (s: { operation: string }) => s.operation === "watch",
    );
    assert.ok(watch, "expected a watch suggestion");
    assert.equal(watch.proposal.kind, "prg");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RECALL_SUGGEST_PROGRAMS=0 disables suggestions even when a threshold is met", () => {
  const tmp = tempDir();
  const previous = process.env.RECALL_SUGGEST_PROGRAMS;
  try {
    const db = join(tmp, "recall.sqlite3");
    for (let i = 0; i < 5; i++) {
      const seedPath = join(tmp, `seed-${i}.json`);
      writeFileSync(
        seedPath,
        JSON.stringify({
          kind: "obs",
          title: `latency obs number ${i}`,
          body: `cell ${i}`,
          confidence: 0.6,
          topics: ["latency"],
        }),
      );
      const seeded = capture(["admit", "--json", seedPath, "--db", db], { now: "2026-07-04T12:00:00.000Z" });
      assert.equal(seeded.code, 0, seeded.stderr);
    }
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "latency spike observed again",
        body: "b",
        confidence: 0.6,
        topics: ["latency"],
      }),
    );
    process.env.RECALL_SUGGEST_PROGRAMS = "0";
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-07-04T12:01:00.000Z" });
    assert.equal(admitted.code, 0, admitted.stderr);
    const parsed = JSON.parse(admitted.stdout);
    assert.deepEqual(parsed.guidance.programSuggestions, []);
  } finally {
    if (previous === undefined) delete process.env.RECALL_SUGGEST_PROGRAMS;
    else process.env.RECALL_SUGGEST_PROGRAMS = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rejected admits carry no guidance", () => {
  const tmp = tempDir();
  try {
    const db = join(tmp, "recall.sqlite3");
    const proposalPath = join(tmp, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        kind: "obs",
        title: "dangling edge proposal",
        body: "Edge target does not exist.",
        confidence: 0.6,
        edges: [{ relation: "supports", target: "no-such-cell" }],
      }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--db", db], { now: "2026-07-04T12:00:00.000Z" });
    assert.equal(admitted.code, 1);
    const parsed = JSON.parse(admitted.stdout);
    assert.equal(parsed.accepted, false);
    assert.ok(!("guidance" in parsed));
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
