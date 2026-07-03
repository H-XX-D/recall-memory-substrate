import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";

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
