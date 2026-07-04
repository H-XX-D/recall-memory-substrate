import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "./store.js";
import { admit } from "./admission.js";
import { buildWriteGuidance } from "./guidance.js";
import type { Cell } from "./types.js";

function seeded(): { store: SqliteStore; wal: Cell } {
  const store = new SqliteStore(":memory:");
  const wal = admit(
    { kind: "dec", title: "Use SQLite WAL mode for the event store", body: "Single writer, concurrent readers.", confidence: 0.6, topics: ["storage"] },
    { store },
  ).cell!;
  admit(
    { kind: "bel", title: "WAL checkpoints stall under heavy write load", body: "Claim to verify.", confidence: 0.6, topics: ["storage"] },
    { store },
  );
  return { store, wal };
}

test("candidate edges surface similar active cells, exclude self and existing targets", () => {
  const { store } = seeded();
  const r = admit(
    { kind: "obs", title: "WAL mode kept readers unblocked during bulk import", body: "Measured on the event store.", confidence: 0.6, topics: ["storage"] },
    { store },
  );
  const g = buildWriteGuidance(store, r.cell!, r);
  assert.ok(g.candidateEdges.length >= 1);
  assert.ok(g.candidateEdges.every((c) => c.target !== r.cell!.key));
  const toBelief = g.candidateEdges.find((c) => c.kind === "bel");
  assert.ok(toBelief, "similar belief should be a candidate");
  assert.equal(toBelief!.relation, "supports");
  assert.ok(toBelief!.handle.length > 0 && toBelief!.title.length > 0);
  store.close();
});

test("candidate edges skip targets the cell already links", () => {
  const { store, wal } = seeded();
  const r = admit(
    { kind: "obs", title: "WAL mode verified again on the event store", body: "b", confidence: 0.6, topics: ["storage"], edges: [{ relation: "supports", target: wal.key }] },
    { store },
  );
  const g = buildWriteGuidance(store, r.cell!, r);
  assert.ok(g.candidateEdges.every((c) => c.target !== wal.key));
  store.close();
});

test("same-kind near-identical title suggests supersedes", () => {
  const { store } = seeded();
  const r = admit(
    { kind: "dec", title: "Use SQLite WAL mode for the event store going forward", body: "Revised.", confidence: 0.6, topics: ["storage"] },
    { store },
  );
  const g = buildWriteGuidance(store, r.cell!, r);
  const dup = g.candidateEdges.find((c) => c.kind === "dec");
  assert.ok(dup);
  assert.equal(dup!.relation, "supersedes");
  store.close();
});

test("kind hint fires for task-like and risk-like text on obs/dec, not on tsk", () => {
  const store = new SqliteStore(":memory:");
  const r1 = admit({ kind: "obs", title: "Need to fix the flaky import retry", body: "todo", confidence: 0.6 }, { store });
  assert.match(buildWriteGuidance(store, r1.cell!, r1).kindHint ?? "", /tsk/);
  const r2 = admit({ kind: "obs", title: "The single sqlite file is a single point of failure", body: "could break restores", confidence: 0.6 }, { store });
  assert.match(buildWriteGuidance(store, r2.cell!, r2).kindHint ?? "", /rsk/);
  const r3 = admit({ kind: "tsk", title: "Need to fix the flaky import retry", body: "todo", confidence: 0.6 }, { store });
  assert.equal(buildWriteGuidance(store, r3.cell!, r3).kindHint, undefined);
  store.close();
});

test("evidence hint appears exactly when confidence was attenuated", () => {
  const store = new SqliteStore(":memory:");
  const capped = admit({ kind: "obs", title: "Unsupported strong claim", body: "b", confidence: 0.9 }, { store });
  const g1 = buildWriteGuidance(store, capped.cell!, capped);
  assert.match(g1.evidenceHint ?? "", /verification|sourceRefs|supports/);
  const fine = admit({ kind: "obs", title: "Tested strong claim", body: "b", confidence: 0.9, verification: "tested" }, { store });
  const g2 = buildWriteGuidance(store, fine.cell!, fine);
  assert.equal(g2.evidenceHint, undefined);
  assert.deepEqual(g2.programSuggestions, []);
  store.close();
});
