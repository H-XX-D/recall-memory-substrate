import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivationHash,
  deriveAdmit,
  dagAnalysisToKeyedProposals,
  programRunDerivationKey,
  sortJson,
  stableJson,
} from "./derivation.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import type { DagAnalysis } from "./dag.js";
import type { ProgramRun } from "./programs.js";
import type { WriteProposal } from "./types.js";

test("sortJson rebuilds records with sorted keys and maps arrays recursively", () => {
  const value = { b: 1, a: { d: 2, c: 3 } };
  assert.deepEqual(Object.keys(sortJson(value) as Record<string, unknown>), ["a", "b"]);
  const nested = sortJson(value) as { a: Record<string, unknown> };
  assert.deepEqual(Object.keys(nested.a), ["c", "d"]);

  const arr = sortJson([{ b: 1, a: 2 }, { d: 3, c: 4 }]) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(arr[0]!), ["a", "b"]);
  assert.deepEqual(Object.keys(arr[1]!), ["c", "d"]);
});

test("stableJson equals JSON.stringify of the sorted value with 2-space indent", () => {
  const value = { b: 1, a: { d: 2, c: 3 } };
  const preSorted = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(stableJson(value), JSON.stringify(preSorted, null, 2));
  // The 2-space indentation is part of the hashed bytes: assert it is present.
  assert.ok(stableJson(value).includes("\n  \""));
});

test("derivationHash is stable across repeated calls and distinct across kinds", () => {
  const value = { overlayId: "ov1", witness: { from: "a", to: "b" } };
  const h1 = derivationHash("dag_witness", value);
  const h2 = derivationHash("dag_witness", value);
  assert.equal(h1, h2);
  assert.match(h1, /^drv_dag_witness_[0-9a-f]{24}$/);

  const h3 = derivationHash("dag_concern", value);
  assert.notEqual(h1, h3);
  assert.match(h3, /^drv_dag_concern_[0-9a-f]{24}$/);
});

test("derivationHash keys never contain a colon", () => {
  const kinds = ["program_run", "eval_run", "dag_witness", "dag_concern", "dag_cycle"] as const;
  for (const kind of kinds) {
    const key = derivationHash(kind, { any: "value" });
    assert.equal(key.includes(":"), false);
  }
});

function proposal(overrides: Partial<WriteProposal> = {}): WriteProposal {
  return {
    kind: "obs",
    title: "t",
    body: "b",
    confidence: 0.8,
    ...overrides,
  };
}

test("deriveAdmit admits once for a new key then short-circuits with duplicateOf on the second call, store counts unchanged", () => {
  const store = new SqliteStore(":memory:");
  try {
    const key = derivationHash("program_run", { programKey: "p1", output: {} });
    const now = "2026-07-03T00:00:00Z";

    const first = deriveAdmit(store, proposal(), key, now);
    assert.equal(first.accepted, true);
    assert.equal(first.cell?.key, key);
    assert.equal(first.duplicateOf, undefined);
    const countAfterFirst = store.stats().cells;

    const second = deriveAdmit(store, proposal(), key, now);
    assert.equal(second.accepted, true);
    assert.equal(second.duplicateOf, key);
    assert.equal(second.cell?.key, key);
    assert.deepEqual(second.issues, []);
    assert.ok(second.warnings.some((w) => w.includes(key)));
    assert.equal(store.stats().cells, countAfterFirst);
  } finally {
    store.close();
  }
});

test("deriveAdmit duplicate path does not put, supersede-walk, or index: an unrelated cell's effective is untouched", () => {
  const store = new SqliteStore(":memory:");
  try {
    const key = derivationHash("program_run", { programKey: "p2", output: {} });
    const now = "2026-07-03T00:00:00Z";
    deriveAdmit(store, proposal(), key, now);

    const before = store.get(key)!;
    const second = deriveAdmit(store, proposal({ title: "different title should not matter" }), key, now);
    const after = store.get(key)!;
    assert.equal(second.accepted, true);
    assert.equal(second.duplicateOf, key);
    // unchanged store: same title as originally admitted, not the second proposal's title
    assert.equal(after.title, before.title);
    assert.equal(after.updatedAt, before.updatedAt);
  } finally {
    store.close();
  }
});

test("deriveAdmit admits fresh when the key is not found in the store", () => {
  const store = new SqliteStore(":memory:");
  try {
    const key = derivationHash("dag_witness", { overlayId: "ov1", witness: {} });
    const result = deriveAdmit(store, proposal(), key, "2026-07-03T00:00:00Z");
    assert.equal(result.accepted, true);
    assert.equal(result.duplicateOf, undefined);
    assert.equal(result.cell?.key, key);
  } finally {
    store.close();
  }
});

test("programRunDerivationKey excludes id/createdAt: identical programKey+output collide", () => {
  const runA: ProgramRun = {
    id: "run-a",
    programKey: "p1",
    operation: "watch",
    createdAt: "2026-07-03T00:00:00Z",
    memberKeys: ["m1"],
    output: { operation: "watch", memberCount: 1, memberReferences: [], tripped: true },
  };
  const runB: ProgramRun = {
    ...runA,
    id: "run-b",
    createdAt: "2026-07-03T00:01:00Z",
  };
  assert.equal(programRunDerivationKey(runA), programRunDerivationKey(runB));

  const runC: ProgramRun = {
    ...runA,
    id: "run-c",
    output: { ...runA.output, tripped: false },
  };
  assert.notEqual(programRunDerivationKey(runA), programRunDerivationKey(runC));
});

function dagAnalysis(overrides: Partial<DagAnalysis> = {}): DagAnalysis {
  return {
    overlayId: "ov1",
    isDag: true,
    topologicalOrder: [],
    cycles: [],
    witnesses: [],
    ...overrides,
  };
}

test("dagAnalysisToKeyedProposals emits a witness obs proposal keyed by dag_witness with correct shape", () => {
  const analysis = dagAnalysis({
    witnesses: [{ from: "a", to: "b", pathCount: 2, signatures: ["x", "y"], concern: 0.2 }],
  });
  const proposals = dagAnalysisToKeyedProposals(analysis);
  assert.equal(proposals.length, 1);
  const kp = proposals[0]!;
  assert.equal(kp.key, derivationHash("dag_witness", { overlayId: "ov1", witness: analysis.witnesses[0] }));
  assert.equal(kp.proposal.kind, "obs");
  assert.equal(kp.proposal.title, "DAG holonomy: a to b disagrees on 2 signature(s)");
  assert.equal(kp.proposal.confidence, Math.max(0.05, 1 - 0.2 / 2));
  assert.deepEqual(kp.proposal.topics, ["dag", "holonomy"]);
  assert.deepEqual(kp.proposal.sourceRefs, ["recall://dag/ov1"]);
});

test("dagAnalysisToKeyedProposals also emits a concern rsk proposal when witness.concern meets the threshold", () => {
  const witness = { from: "a", to: "b", pathCount: 2, signatures: ["x", "y"], concern: 0.6 };
  const analysis = dagAnalysis({ witnesses: [witness] });
  const proposals = dagAnalysisToKeyedProposals(analysis);
  assert.equal(proposals.length, 2);
  const concernProposal = proposals.find((p) => p.proposal.kind === "rsk")!;
  assert.equal(concernProposal.key, derivationHash("dag_concern", { overlayId: "ov1", witness }));
  assert.equal(concernProposal.proposal.stability, "volatile");
  assert.deepEqual(concernProposal.proposal.edges, [
    { relation: "concerns", target: "a" },
    { relation: "concerns", target: "b" },
  ]);
});

test("dagAnalysisToKeyedProposals respects a custom concernThreshold", () => {
  const witness = { from: "a", to: "b", pathCount: 2, signatures: ["x", "y"], concern: 0.4 };
  const analysis = dagAnalysis({ witnesses: [witness] });
  const belowDefault = dagAnalysisToKeyedProposals(analysis);
  assert.equal(belowDefault.length, 1); // 0.4 < default 0.5, no concern proposal

  const withLowThreshold = dagAnalysisToKeyedProposals(analysis, { concernThreshold: 0.3 });
  assert.equal(withLowThreshold.length, 2);
});

test("dagAnalysisToKeyedProposals emits one rsk proposal per cycle with a concerns edge per member", () => {
  const analysis = dagAnalysis({
    isDag: false,
    topologicalOrder: [],
    cycles: [["a", "b", "c", "a"]],
  });
  const proposals = dagAnalysisToKeyedProposals(analysis);
  assert.equal(proposals.length, 1);
  const kp = proposals[0]!;
  assert.equal(kp.key, derivationHash("dag_cycle", { overlayId: "ov1", cycle: analysis.cycles[0] }));
  assert.equal(kp.proposal.kind, "rsk");
  assert.equal(kp.proposal.confidence, 0.95);
  assert.equal(kp.proposal.concern, 0.95);
  assert.deepEqual(
    kp.proposal.edges,
    analysis.cycles[0]!.map((member) => ({ relation: "concerns", target: member })),
  );
});

test("dagAnalysisToKeyedProposals threads project/tenant through to proposals", () => {
  const analysis = dagAnalysis({
    witnesses: [{ from: "a", to: "b", pathCount: 2, signatures: ["x", "y"], concern: 0.9 }],
  });
  const proposals = dagAnalysisToKeyedProposals(analysis, { project: "proj1", tenant: "ten1" });
  for (const kp of proposals) {
    assert.equal(kp.proposal.project, "proj1");
    assert.equal(kp.proposal.tenant, "ten1");
  }
});

test("dagAnalysisToKeyedProposals returns [] for a clean, cycle-free, witness-free analysis", () => {
  const analysis = dagAnalysis();
  assert.deepEqual(dagAnalysisToKeyedProposals(analysis), []);
});

test("deriveAdmit end-to-end with dagAnalysisToKeyedProposals: admitting the same analysis twice yields duplicates the second time", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
    const b = buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.7 }, { key: "bbbb" });
    store.put(a);
    store.put(b);

    const analysis = dagAnalysis({
      witnesses: [{ from: "aaaa", to: "bbbb", pathCount: 2, signatures: ["x", "y"], concern: 0.9 }],
    });
    const proposals = dagAnalysisToKeyedProposals(analysis);
    const now = "2026-07-03T00:00:00Z";

    const firstPass = proposals.map((kp) => deriveAdmit(store, kp.proposal, kp.key, now));
    assert.ok(firstPass.every((r) => r.accepted && r.duplicateOf === undefined));

    const secondPass = proposals.map((kp) => deriveAdmit(store, kp.proposal, kp.key, now));
    assert.ok(secondPass.every((r) => r.accepted && r.duplicateOf !== undefined));
  } finally {
    store.close();
  }
});
