import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  old.prepare(`INSERT INTO hyperedges VALUES (?,?,?,?,?,?)`).run("h1", "cluster", "H", JSON.stringify(["a", "b"]), JSON.stringify({}), "2026-06-01T00:00:00Z");
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
  assert.equal(target.listHyperedges().length, 1);
  target.close();
  rmSync(dir, { recursive: true, force: true });
});
