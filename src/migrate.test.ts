import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";
import { listProjects, registerProject } from "./routing.js";
import { SqliteStore } from "./store.js";
import { migrate } from "./migrate.js";
import { mapKind, mapNodeToCell, mapRelationToEdge, type OldNodeRow } from "./migrate.js";

test("mapKind maps old vocabulary to MAL kinds with obs fallback", () => {
  assert.equal(mapKind("observation"), "obs");
  assert.equal(mapKind("verification_result"), "ver");
  assert.equal(mapKind("decision"), "dec");
  assert.equal(mapKind("lemma"), "bel");
  assert.equal(mapKind("objective"), "obj");
  assert.equal(mapKind("something_unknown"), "obs");
});

test("mapNodeToCell builds a MAL cell losslessly", () => {
  const row: OldNodeRow = {
    id: "n1", cell_address: "recall://cell/n1", kind: "observation",
    title: "wrapper smoke test", body: "the body",
    summary: null, scope_json: JSON.stringify({ project: "p", tenant: "default" }),
    tags_json: JSON.stringify({ topics: ["t1"], entities: ["e1"] }),
    data_json: JSON.stringify({ confidence: { value: 0.7, uncertainty: 0.07, concern: 0.03, stability: "stable", source_quality: "high" }, policy: { sensitivity: "private", expires_at: null, reverify_after: null } }),
    provenance_json: JSON.stringify({ origin: "llm", produced_by: "claude-code", verification: "checked" }),
    status: "active", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-02T00:00:00Z",
  };
  const cell = mapNodeToCell(row);
  assert.equal(cell.key, "n1");
  assert.equal(cell.kind, "obs");
  assert.equal(cell.title, "wrapper smoke test");
  assert.equal(cell.scores.conf, 0.7);
  assert.equal(cell.tags.topics[0], "t1");
  assert.equal(cell.status, "active");
  assert.equal(cell.createdAt, "2026-06-01T00:00:00Z");
  // lossless: the raw old row is preserved
  assert.equal((cell.props._migrated as { cell_address?: string }).cell_address, "recall://cell/n1");
});

test("mapNodeToCell preserves legacy archived cells as non-active annexed cells", () => {
  const row: OldNodeRow = {
    id: "archived-1", cell_address: null, kind: "observation",
    title: "retired memory", body: "kept for provenance",
    summary: null, scope_json: null, tags_json: null,
    data_json: JSON.stringify({ confidence: { value: 0.8 } }),
    provenance_json: null,
    status: "archived", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
  };
  const cell = mapNodeToCell(row);
  assert.equal(cell.status, "annexed");
  assert.equal(cell.flags.annexed, true);
});

test("migrate tolerates legacy DB with only graph_nodes (no hyperedges/semantic_index)", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-legacy-"));
  const oldPath = join(dir, "legacy.sqlite3");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE graph_nodes (id TEXT, cell_address TEXT, kind TEXT, title TEXT, body TEXT, summary TEXT, scope_json TEXT, tags_json TEXT, data_json TEXT, provenance_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);`);
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("x", null, "observation", "X", "xbody", null, null, null, null, null, "active", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("y", null, "decision", "Y", "ybody", null, null, null, null, null, "active", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  old.close();

  const target = new SqliteStore(":memory:");
  // must not throw "no such table: graph_relations" or "no such table: hyperedges" etc.
  let res: Awaited<ReturnType<typeof migrate>>;
  assert.doesNotThrow(() => { res = migrate(oldPath, target, { apply: true }); });
  assert.equal(res!.cells, 2);
  assert.equal(res!.edges, 0);
  assert.equal(res!.hyperedges, 0);
  assert.equal(res!.semanticVectors, 0);
  assert.equal(res!.projects, 0);
  assert.equal(target.all().length, 2);
  target.close();
  rmSync(dir, { recursive: true, force: true });
});

test("mapNodeToCell coerces non-array topics/entities to []", () => {
  const row: OldNodeRow = {
    id: "n2", cell_address: null, kind: "observation",
    title: "array guard test", body: "",
    summary: null, scope_json: null,
    tags_json: JSON.stringify({ topics: "notarray", entities: 42 }),
    data_json: null, provenance_json: null,
    status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const cell = mapNodeToCell(row);
  assert.deepEqual(cell.tags.topics, []);
  assert.deepEqual(cell.tags.entities, []);
});

test("mapNodeToCell maps confidence value 0 to 0.01 not 0.5", () => {
  const row: OldNodeRow = {
    id: "n3", cell_address: null, kind: "observation",
    title: "zero-conf test", body: "",
    summary: null, scope_json: null, tags_json: null,
    data_json: JSON.stringify({ confidence: { value: 0 } }),
    provenance_json: null,
    status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const cell = mapNodeToCell(row);
  assert.equal(cell.scores.conf, 0.01);
});

test("mapRelationToEdge maps known relations and drops unknown", () => {
  assert.deepEqual(mapRelationToEdge({ source_id: "a", target_id: "b", kind: "supports" }), { relation: "supports", source: "a", target: "b", weight: 1 });
  assert.equal(mapRelationToEdge({ source_id: "a", target_id: "b", kind: "supports" })!.weight, 1);
  assert.equal(mapRelationToEdge({ source_id: "a", target_id: "b", kind: "concerns" })!.weight, -0.5);
  assert.equal(mapRelationToEdge({ source_id: "a", target_id: "b", kind: "not_a_relation" }), null);
});

test("migrate copies nodes, relations, hyperedges, and semantic vectors", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-"));
  const oldPath = join(dir, "old.sqlite3");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE graph_nodes (id TEXT, cell_address TEXT, kind TEXT, title TEXT, body TEXT, summary TEXT, scope_json TEXT, tags_json TEXT, data_json TEXT, provenance_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE graph_relations (id TEXT, kind TEXT, source_id TEXT, target_id TEXT, data_json TEXT, created_at TEXT);
    CREATE TABLE hyperedges (id TEXT, kind TEXT, title TEXT, members_json TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE semantic_index (node_id TEXT, backend TEXT, dims INTEGER, vector_json TEXT, indexed_at TEXT);`);
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("a", null, "observation", "A", "abody", null, null, JSON.stringify({ topics: ["t"] }), JSON.stringify({ confidence: { value: 0.8 } }), null, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("b", null, "decision", "B", "bbody", null, null, null, null, null, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  old.prepare(`INSERT INTO graph_relations VALUES (?,?,?,?,?,?)`).run("r1", "supports", "b", "a", null, "2026-06-01T00:00:00Z");
  // legacy hyperedge rows store member OBJECTS, not plain keys; the fixture
  // mixes both shapes to exercise the migrate mapping fix end to end.
  old.prepare(`INSERT INTO hyperedges VALUES (?,?,?,?,?,?)`).run(
    "h1", "cluster", "H",
    JSON.stringify(["a", { nodeId: "b", role: "driver", weight: 0.5 }]),
    JSON.stringify({}), "2026-06-01T00:00:00Z",
  );
  old.prepare(`INSERT INTO semantic_index VALUES (?,?,?,?,?)`).run("a", "hash", 2, JSON.stringify([0.1, 0.2]), "2026-06-01T00:00:00Z");
  old.close();

  const target = new SqliteStore(":memory:");
  const dry = migrate(oldPath, target, { apply: false });
  assert.equal(dry.cells, 2);
  assert.equal(dry.applied, false);
  assert.equal(target.all().length, 0); // dry-run wrote nothing

  const res = migrate(oldPath, target, { apply: true });
  assert.equal(res.cells, 2);
  assert.equal(res.edges, 1);
  assert.equal(res.hyperedges, 1);
  assert.equal(res.semanticVectors, 1);
  assert.equal(target.all().length, 2);
  assert.equal(target.get("a")?.kind, "obs");
  const b = target.get("b");
  assert.equal(b?.edgesOut[0]?.relation, "supports");
  assert.equal(b?.edgesOut[0]?.target, "a");
  assert.equal(target.getSemanticVector("a")?.dims, 2);
  const migratedHyperedges = target.listHyperedges();
  assert.equal(migratedHyperedges.length, 1);
  // legacy node id becomes the cell key unchanged; the string member gets
  // defaulted, the object member keeps its stated role/weight.
  assert.deepEqual(migratedHyperedges[0]!.members[0], { key: "a", role: "member", ordinal: 0 });
  assert.deepEqual(migratedHyperedges[0]!.members[1], { key: "b", role: "driver", ordinal: 1, weight: 0.5 });
  target.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate copies dag_overlays, mapping legacy from/to edges to source/target", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-dag-"));
  const oldPath = join(dir, "old.sqlite3");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE graph_nodes (id TEXT, cell_address TEXT, kind TEXT, title TEXT, body TEXT, summary TEXT, scope_json TEXT, tags_json TEXT, data_json TEXT, provenance_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dag_overlays (id TEXT, title TEXT, node_ids_json TEXT, edges_json TEXT, metadata_json TEXT, created_at TEXT);`);
  old.prepare(`INSERT INTO graph_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("a", null, "observation", "A", "abody", null, null, null, null, null, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  old.prepare(`INSERT INTO dag_overlays VALUES (?,?,?,?,?,?)`).run(
    "ov1", "legacy overlay",
    JSON.stringify(["a", "b"]),
    JSON.stringify([{ from: "a", to: "b", label: "supports", weight: 0.9 }]),
    JSON.stringify({}), "2026-06-01T00:00:00Z",
  );
  old.close();

  const target = new SqliteStore(":memory:");
  const res = migrate(oldPath, target, { apply: true });
  assert.equal(res.dagOverlays, 1);
  const overlays = target.listDagOverlays();
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.id, "ov1");
  assert.deepEqual(overlays[0]!.edges[0], { source: "a", target: "b", label: "supports", weight: 0.9 });
  target.close();
  rmSync(dir, { recursive: true, force: true });
});

// Legacy home stores carry a projects registry table (slug, root_path,
// db_path, created_at, description). The fixture name avoids "home.sqlite3"
// so routing's lazy legacy-registry copy cannot mask what migrate imports.
function writeLegacyDbWithProjects(
  path: string,
  rows: Array<[slug: string, root: string, dbPath: string, createdAt: string, description: string | null]>,
): void {
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE graph_nodes (id TEXT, cell_address TEXT, kind TEXT, title TEXT, body TEXT, summary TEXT, scope_json TEXT, tags_json TEXT, data_json TEXT, provenance_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE projects (slug TEXT, root_path TEXT, db_path TEXT, created_at TEXT, description TEXT);`);
  const insert = old.prepare(`INSERT INTO projects VALUES (?,?,?,?,?)`);
  for (const row of rows) insert.run(...row);
  old.close();
}

test("migrate --apply imports the legacy projects registry with visible slug renames", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-projects-"));
  try {
    const recallHome = join(dir, "recall-home");
    const oldPath = join(dir, "legacy-graph.sqlite3");
    const targetPath = join(dir, "target.sqlite3");
    writeLegacyDbWithProjects(oldPath, [
      ["defi", join(dir, "roots", "defi"), join(recallHome, "db", "defi.sqlite3"), "2026-06-01T00:00:00Z", "DeFi memory"],
      ["aide", join(dir, "roots", "aide"), join(recallHome, "db", "aide.sqlite3"), "2026-06-02T00:00:00Z", null],
      ["home", join(dir, "roots", "home-named"), join(recallHome, "db", "home-named.sqlite3"), "2026-06-03T00:00:00Z", null],
    ]);

    const env = { RECALL_HOME: recallHome } as NodeJS.ProcessEnv;
    const first = captureCli(["migrate", "--from", oldPath, "--db", targetPath, "--apply"], env);
    assert.equal(first.code, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout) as {
      projects: number;
      projectRenames: { from: string; to: string }[];
      applied: boolean;
    };
    assert.equal(firstJson.applied, true);
    assert.equal(firstJson.projects, 3);
    assert.equal(firstJson.projectRenames.length, 1);
    assert.equal(firstJson.projectRenames[0]!.from, "home");
    assert.match(firstJson.projectRenames[0]!.to, /^project-home-[a-f0-9]{6}$/);

    const registry = join(recallHome, "db", "registry.sqlite3");
    const listed = listProjects(registry);
    assert.equal(listed.length, 3);
    const slugs = listed.map((p) => p.slug).sort();
    assert.ok(slugs.includes("defi"));
    assert.ok(slugs.includes("aide"));
    assert.ok(!slugs.includes("home"));
    assert.equal(slugs.filter((s) => /^project-home-[a-f0-9]{6}$/.test(s)).length, 1);
    const defi = listed.find((p) => p.slug === "defi");
    assert.equal(defi?.dbPath, join(recallHome, "db", "defi.sqlite3"));
    assert.equal(defi?.description, "DeFi memory");
    assert.equal(defi?.createdAt, "2026-06-01T00:00:00Z");

    const second = captureCli(["migrate", "--from", oldPath, "--db", targetPath, "--apply"], env);
    assert.equal(second.code, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout) as { projects: number; projectRenames: unknown[] };
    assert.equal(secondJson.projects, 0);
    assert.equal(secondJson.projectRenames.length, 0);
    assert.deepEqual(listProjects(registry).map((p) => p.slug).sort(), slugs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate dry-run counts legacy projects without writing the registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-projects-dry-"));
  try {
    const oldPath = join(dir, "legacy-graph.sqlite3");
    const registry = join(dir, "db", "registry.sqlite3");
    writeLegacyDbWithProjects(oldPath, [
      ["defi", join(dir, "roots", "defi"), join(dir, "db", "defi.sqlite3"), "2026-06-01T00:00:00Z", null],
      ["aide", join(dir, "roots", "aide"), join(dir, "db", "aide.sqlite3"), "2026-06-02T00:00:00Z", null],
    ]);

    const target = new SqliteStore(":memory:");
    const res = migrate(oldPath, target, { apply: false, registryDb: registry });
    assert.equal(res.applied, false);
    assert.equal(res.projects, 2);
    assert.equal(existsSync(registry), false);
    assert.deepEqual(listProjects(registry), []);
    target.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy project slug already registered to a different root is skipped, not renamed", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-mig-projects-skip-"));
  try {
    const oldPath = join(dir, "legacy-graph.sqlite3");
    const registry = join(dir, "db", "registry.sqlite3");
    const keeper = registerProject(
      { slug: "defi", root: join(dir, "elsewhere") },
      "2026-05-01T00:00:00.000Z",
      registry,
    );
    writeLegacyDbWithProjects(oldPath, [
      ["defi", join(dir, "roots", "defi"), join(dir, "db", "legacy-defi.sqlite3"), "2026-06-01T00:00:00Z", null],
    ]);

    const target = new SqliteStore(":memory:");
    const res = migrate(oldPath, target, { apply: true, registryDb: registry });
    assert.equal(res.projects, 0);
    assert.equal(res.projectRenames.length, 0);
    const listed = listProjects(registry);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.slug, "defi");
    assert.equal(listed[0]!.rootPath, keeper.rootPath);
    target.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureCli(argv: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
