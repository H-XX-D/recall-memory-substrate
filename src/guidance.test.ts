import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "./store.js";
import { admit } from "./admission.js";
import { buildWriteGuidance } from "./guidance.js";
import { validateProgramSpec } from "./programs.js";
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

function admitMany(store: SqliteStore, kind: "obs" | "tsk", n: number, topic: string): void {
  for (let i = 0; i < n; i++) {
    admit({ kind, title: `${topic} ${kind} number ${i}`, body: `cell ${i}`, confidence: 0.6, topics: [topic] }, { store });
  }
}

test("recurring topic suggests a watch program only when opted in", () => {
  const store = new SqliteStore(":memory:");
  admitMany(store, "obs", 5, "latency");
  const r = admit({ kind: "obs", title: "latency spike observed again", body: "b", confidence: 0.6, topics: ["latency"] }, { store });
  const off = buildWriteGuidance(store, r.cell!, r);
  assert.deepEqual(off.programSuggestions, []);
  const on = buildWriteGuidance(store, r.cell!, r, { suggestPrograms: true });
  const watch = on.programSuggestions.find((s) => s.operation === "watch");
  assert.ok(watch, "expected a watch suggestion");
  assert.equal(watch!.proposal.kind, "prg");
  assert.doesNotThrow(() => validateProgramSpec((watch!.proposal.props as { program: unknown }).program));
  const admitted = admit(watch!.proposal, { store });
  assert.equal(admitted.accepted, true);
  store.close();
});

test("an existing program covering the topic suppresses the suggestion", () => {
  const store = new SqliteStore(":memory:");
  admitMany(store, "obs", 6, "latency");
  admit(
    { kind: "prg", title: "watch latency", body: "standing", confidence: 0.6, props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { topics: ["latency"] } } } },
    { store },
  );
  const r = admit({ kind: "obs", title: "latency yet again", body: "b", confidence: 0.6, topics: ["latency"] }, { store });
  const g = buildWriteGuidance(store, r.cell!, r, { suggestPrograms: true });
  assert.equal(g.programSuggestions.filter((s) => s.operation === "watch").length, 0);
  store.close();
});

test("a task pool suggests allocate ahead of watch", () => {
  const store = new SqliteStore(":memory:");
  admitMany(store, "tsk", 4, "migration");
  const r = admit({ kind: "tsk", title: "migration cleanup pass", body: "b", confidence: 0.6, topics: ["migration"] }, { store });
  const g = buildWriteGuidance(store, r.cell!, r, { suggestPrograms: true });
  assert.equal(g.programSuggestions[0]?.operation, "allocate");
  store.close();
});

test("a contradicts edge onto a belief suggests a quorum program targeted at it", () => {
  const store = new SqliteStore(":memory:");
  const bel = admit({ kind: "bel", title: "The cache layer is safe to remove", body: "claim", confidence: 0.6 }, { store }).cell!;
  const r = admit(
    { kind: "obs", title: "Removing the cache doubled p99", body: "measured", confidence: 0.6, edges: [{ relation: "contradicts", target: bel.key }] },
    { store },
  );
  const g = buildWriteGuidance(store, r.cell!, r, { suggestPrograms: true });
  const q = g.programSuggestions.find((s) => s.operation === "quorum");
  assert.ok(q);
  const spec = (q!.proposal.props as { program: { target: { keys: string[] } } }).program;
  assert.deepEqual(spec.target.keys, [bel.key]);
  assert.ok(g.programSuggestions.length <= 2);
  store.close();
});
