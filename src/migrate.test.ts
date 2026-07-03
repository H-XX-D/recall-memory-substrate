import { test } from "node:test";
import assert from "node:assert/strict";
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
