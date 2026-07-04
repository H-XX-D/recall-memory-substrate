import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultEvalSuite,
  evalResultDerivationKey,
  evalResultToProposal,
  runAndRecordEval,
  runEvalAndDerive,
  runRecallEval,
} from "./evals.js";
import type { RecallEvalCase, RecallEvalResult } from "./evals.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import { indexCell } from "./semantic.js";
import type { Cell, Store } from "./types.js";
import { resolveCell } from "./cell-context.js";

function seededStore(): SqliteStore {
  const store = new SqliteStore(":memory:");
  const a = buildCell(
    { kind: "obs", title: "Deployment pipeline uses blue-green rollout", body: "The deployment pipeline uses a blue-green rollout strategy.", confidence: 0.8, topics: ["deploy"] },
    { key: "aaaaaaaa-0000-0000-0000-000000000000" },
  );
  const b = buildCell(
    { kind: "bel", title: "Team believes rollout strategy is stable", body: "Team believes the current rollout strategy is stable.", confidence: 0.7, topics: ["deploy"] },
    { key: "bbbbbbbb-0000-0000-0000-000000000000" },
  );
  store.put(a);
  store.put(b);
  indexCell(a, store);
  indexCell(b, store);
  return store;
}

test("defaultEvalSuite is named recall-default with 8 invariant cases plus search/semantic/compile cases", () => {
  const suite = defaultEvalSuite();
  assert.equal(suite.name, "recall-default");
  const invariantCases = suite.cases.filter((c) => c.kind === "invariant");
  assert.equal(invariantCases.length, 5);
  const invariantNames = new Set(invariantCases.map((c) => (c as { invariant: string }).invariant));
  assert.deepEqual(
    [...invariantNames].sort(),
    [
      "depends-on-acyclic",
      "edge-targets-resolve",
      "effective-confidence-bounds",
      "key-handle-consistency",
      "prefix-resolution",
    ].sort(),
  );
  assert.equal(suite.cases.filter((c) => c.kind === "search").length, 1);
  assert.equal(suite.cases.filter((c) => c.kind === "semantic").length, 1);
  assert.equal(suite.cases.filter((c) => c.kind === "compile").length, 1);
  assert.equal(suite.cases.length, 8);
});

test("runRecallEval default suite passes on an empty store", () => {
  const store = new SqliteStore(":memory:");
  try {
    const result = runRecallEval(store);
    assert.equal(result.passed, true);
    assert.equal(result.name, "recall-default");
    assert.equal(result.cases.length, 8);
    assert.ok(result.cases.every((c) => c.passed));
  } finally {
    store.close();
  }
});

test("runRecallEval default suite passes on a seeded healthy store", () => {
  const store = seededStore();
  try {
    const result = runRecallEval(store);
    assert.equal(result.passed, true);
    assert.ok(result.cases.every((c) => c.passed), JSON.stringify(result.cases.filter((c) => !c.passed)));
  } finally {
    store.close();
  }
});

test("runRecallEval score is the mean of case scores rounded to 3 decimals", () => {
  const store = new SqliteStore(":memory:");
  try {
    const result = runRecallEval(store);
    const mean = result.cases.reduce((sum, c) => sum + c.score, 0) / result.cases.length;
    assert.equal(result.score, Math.round(mean * 1000) / 1000);
  } finally {
    store.close();
  }
});

test("search case passes when hits meet minResults and, if expectContains set, some hit title/handle includes it", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "s1", kind: "search" as const, query: "blue-green", minResults: 1, expectContains: "blue-green" },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);

    const failing = {
      name: "custom2",
      cases: [{ name: "s2", kind: "search" as const, query: "blue-green", minResults: 50 }],
    };
    const failResult = runRecallEval(store, failing);
    assert.equal(failResult.cases[0]!.passed, false);
  } finally {
    store.close();
  }
});

test("semantic case passes when hits meet minResults and expectContains matches", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "sem1", kind: "semantic" as const, query: "rollout strategy", minResults: 1 },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.kind, "semantic");
    assert.equal(result.cases[0]!.passed, true);
  } finally {
    store.close();
  }
});

test("compile case passes when wordCount <= maxWords and expectContains matches the formatted packet", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "c1", kind: "compile" as const, task: "deployment rollout", maxWords: 900 },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);
    assert.ok(typeof result.cases[0]!.details.wordCount === "number");
  } finally {
    store.close();
  }
});

test("subgraph case passes when subgraphCells returns at least minResults", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "sub1", kind: "subgraph" as const, filter: { topics: ["deploy"] }, minResults: 1 },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.kind, "subgraph");
    assert.equal(result.cases[0]!.passed, true);
  } finally {
    store.close();
  }
});

test("subgraph case fails when subgraphCells returns fewer than minResults", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "sub1", kind: "subgraph" as const, filter: { topics: ["nonexistent-topic"] }, minResults: 1 },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, false);
  } finally {
    store.close();
  }
});

test("subgraph case defaults minResults to 0 and passes with zero results", () => {
  const store = seededStore();
  try {
    const suite = {
      name: "custom",
      cases: [
        { name: "sub1", kind: "subgraph" as const, filter: { topics: ["nonexistent-topic"] } },
      ],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);
  } finally {
    store.close();
  }
});

test("edge-targets-resolve fails with a dangling edge triple in details when a cell has an edge to a nonexistent target", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8, edges: [{ relation: "supports", target: "does-not-exist" }] },
      { key: "aaaaaaaa-0000-0000-0000-000000000000" },
    );
    store.put(a);
    const suite = { name: "custom", cases: [{ name: "edges", kind: "invariant" as const, invariant: "edge-targets-resolve" as const }] };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, false);
    const dangling = result.cases[0]!.details.dangling as string[];
    assert.ok(Array.isArray(dangling) && dangling.length >= 1);
    assert.ok(dangling.some((d) => d.includes("supports") && d.includes("does-not-exist")));
  } finally {
    store.close();
  }
});

test("effective-confidence-bounds fails when a Scores field is out of [0, 1]", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8 },
      { key: "aaaaaaaa-0000-0000-0000-000000000000" },
    );
    a.scores.effective = 1.5; // out of bounds
    store.put(a);
    const suite = { name: "custom", cases: [{ name: "bounds", kind: "invariant" as const, invariant: "effective-confidence-bounds" as const }] };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, false);
    const offenders = result.cases[0]!.details.offenders as unknown[];
    assert.ok(Array.isArray(offenders) && offenders.length >= 1);
  } finally {
    store.close();
  }
});

test("depends-on-acyclic fails when a depends_on cycle exists among active cells", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8, edges: [{ relation: "depends_on", target: "bbbbbbbb-0000-0000-0000-000000000000" }] },
      { key: "aaaaaaaa-0000-0000-0000-000000000000" },
    );
    const b = buildCell(
      { kind: "obs", title: "B", body: "b", confidence: 0.8, edges: [{ relation: "depends_on", target: "aaaaaaaa-0000-0000-0000-000000000000" }] },
      { key: "bbbbbbbb-0000-0000-0000-000000000000" },
    );
    store.put(a);
    store.put(b);
    const suite = { name: "custom", cases: [{ name: "cycle", kind: "invariant" as const, invariant: "depends-on-acyclic" as const }] };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, false);
  } finally {
    store.close();
  }
});

test("key-handle-consistency passes trivially on empty store and reports collisions without failing", () => {
  const store = new SqliteStore(":memory:");
  try {
    const suite = { name: "custom", cases: [{ name: "kh", kind: "invariant" as const, invariant: "key-handle-consistency" as const }] };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);
    assert.equal(typeof result.cases[0]!.details.collisions, "number");
  } finally {
    store.close();
  }
});

test("prefix-resolution passes on empty store trivially and passes on a seeded store via an 8-char prefix", () => {
  const empty = new SqliteStore(":memory:");
  try {
    const suite = { name: "custom", cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }] };
    const emptyResult = runRecallEval(empty, suite);
    assert.equal(emptyResult.cases[0]!.passed, true);
  } finally {
    empty.close();
  }

  const store = seededStore();
  try {
    const suite = { name: "custom", cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }] };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);
  } finally {
    store.close();
  }
});

test("runAndRecordEval leaves an eval_runs row readable via getEvalRun prefix", () => {
  const store = new SqliteStore(":memory:");
  try {
    const result = runAndRecordEval(store);
    assert.equal(result.passed, true);
    const rows = store.listEvalRuns();
    assert.equal(rows.length, 1);
    const fullId = rows[0]!.id;
    const prefix = fullId.slice(0, 8);
    const got = store.getEvalRun(prefix);
    assert.equal(got?.id, fullId);
    assert.equal(got?.name, "recall-default");
    assert.equal(got?.result.passed, true);
  } finally {
    store.close();
  }
});

test("evalResultToProposal builds a ver proposal with confidence clamped to at least 0.05", () => {
  const store = new SqliteStore(":memory:");
  try {
    const result = runRecallEval(store);
    const proposal = evalResultToProposal(result);
    assert.equal(proposal.kind, "ver");
    assert.equal(proposal.title, `Eval ${result.name}: ${result.passed ? "passed" : "failed"} (score ${result.score})`);
    assert.equal(proposal.owner, "eval:recall");
    assert.equal(proposal.origin, "program");
    assert.equal(proposal.verification, "tested");
    assert.deepEqual(proposal.topics, ["eval", "verification"]);
    assert.equal(proposal.stability, "volatile");
    assert.ok(proposal.confidence > 0 && proposal.confidence <= 1);

    const zeroResult = { ...result, score: 0 };
    const zeroProposal = evalResultToProposal(zeroResult);
    assert.equal(zeroProposal.confidence, 0.05);
  } finally {
    store.close();
  }
});

test("evalResultDerivationKey is stable for identical results and uses the eval_run kind", () => {
  const store = new SqliteStore(":memory:");
  try {
    const result = runRecallEval(store);
    const k1 = evalResultDerivationKey(result);
    const k2 = evalResultDerivationKey(result);
    assert.equal(k1, k2);
    assert.match(k1, /^drv_eval_run_[0-9a-f]{24}$/);
  } finally {
    store.close();
  }
});

test("evalResultDerivationKey buckets by day, suite, and project, not by volatile result content", () => {
  const base: RecallEvalResult = {
    name: "recall-default",
    passed: true,
    score: 1,
    cases: [],
    createdAt: "2026-07-03T08:00:00.000Z",
  };
  // Same day, same suite, different outcome: the pass/fail counts and case
  // payloads are volatile between runs (the store changes under the suite as
  // maintain admits its own witnesses), so they must not perturb the key.
  const laterSameDay: RecallEvalResult = {
    ...base,
    passed: false,
    score: 0.875,
    cases: [{ name: "prefix", kind: "invariant", passed: false, score: 0, details: {} }],
    createdAt: "2026-07-03T20:00:00.000Z",
  };
  assert.equal(evalResultDerivationKey(base), evalResultDerivationKey(laterSameDay));

  const nextDay: RecallEvalResult = { ...base, createdAt: "2026-07-04T00:00:00.000Z" };
  assert.notEqual(evalResultDerivationKey(base), evalResultDerivationKey(nextDay));

  const otherSuite: RecallEvalResult = { ...base, name: "custom" };
  assert.notEqual(evalResultDerivationKey(base), evalResultDerivationKey(otherSuite));

  assert.notEqual(evalResultDerivationKey(base), evalResultDerivationKey(base, "someproject"));
  assert.match(evalResultDerivationKey(base), /^drv_eval_run_[0-9a-f]{24}$/);
});

test("prefix-resolution targets the first hex-prefixable key and treats derived drv_ keys as legal", () => {
  const store = new SqliteStore(":memory:");
  try {
    // Insertion order puts the derived-key witness first: exactly the state
    // a maintain pass leaves behind on a fresh store. Derived keys
    // (drv_<kind>_<hex24>) are the documented derivation scheme, not a
    // resolver violation; the case must move on to a hex-prefixable target.
    store.put(
      buildCell(
        { kind: "ver", title: "Eval recall-default: passed (score 1)", body: "w", confidence: 0.9 },
        { key: `drv_eval_run_${"a".repeat(24)}` },
      ),
    );
    store.put(
      buildCell(
        { kind: "obs", title: "Normal", body: "n", confidence: 0.8 },
        { key: "cccccccc-0000-0000-0000-000000000000" },
      ),
    );
    const suite = {
      name: "custom",
      cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true, JSON.stringify(result.cases[0]!.details));
    assert.equal(result.cases[0]!.details.prefix, "cccccccc");
  } finally {
    store.close();
  }
});

test("prefix-resolution passes trivially on a store holding only derived drv_ keys", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.put(
      buildCell(
        { kind: "ver", title: "Eval recall-default: passed (score 1)", body: "w", confidence: 0.9 },
        { key: `drv_eval_run_${"b".repeat(24)}` },
      ),
    );
    const suite = {
      name: "custom",
      cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true, JSON.stringify(result.cases[0]!.details));
  } finally {
    store.close();
  }
});

test("runEvalAndDerive twice with an identical result returns duplicateOf on the second call", () => {
  const store = new SqliteStore(":memory:");
  try {
    // A case-free suite keeps the eval outcome fully independent of store
    // state: every case kind (search/semantic/compile/invariant) reads the
    // store, so the ver cell the first call admits would otherwise change
    // what the second call observes (e.g. active() count). With zero cases
    // the result content ({name, passed: true, score: 0, cases: []}) is
    // identical on both calls, which is exactly what should collide on the
    // same derivation key.
    const suite: Parameters<typeof runEvalAndDerive>[1] = { name: "empty-suite", cases: [] };
    const now = new Date("2026-07-03T00:00:00.000Z");
    const first = runEvalAndDerive(store, suite, now);
    assert.equal(first.derived.accepted, true);
    assert.equal(first.derived.duplicateOf, undefined);

    const second = runEvalAndDerive(store, suite, now);
    assert.equal(second.derived.accepted, true);
    assert.equal(second.derived.duplicateOf, first.derived.cell?.key);
  } finally {
    store.close();
  }
});

// Store-typed double (no SqliteStore-only methods behind it): if semanticSearch
// ever grew a real SqliteStore-only dependency, this bare object literal would
// fail to satisfy the Store type and the test would not compile.
function bareStoreWithCells(cells: Cell[]): Store {
  const byKey = new Map(cells.map((c) => [c.key, c]));
  return {
    put: (cell) => { byKey.set(cell.key, cell); },
    get: (key) => byKey.get(key),
    getByHandle: (handle) => [...byKey.values()].find((c) => c.handle === handle),
    all: () => [...byKey.values()],
    active: () => [...byKey.values()].filter((c) => c.status === "active"),
    neighbors: () => [],
    findByContentKey: () => undefined,
    search: () => [],
    lexicalBackend: () => "like",
    stats: () => ({
      cells: byKey.size,
      activeCells: [...byKey.values()].filter((c) => c.status === "active").length,
      edges: 0,
      indexedCells: byKey.size,
      lexicalBackend: "like",
    }),
    close: () => {},
    putSemanticVector: () => {},
    getSemanticVector: () => undefined,
    listSemanticVectorIds: () => [],
    putHyperedge: () => {},
    getHyperedge: () => undefined,
    listHyperedges: () => [],
    hyperedgesForCell: () => [],
    putDagOverlay: () => {},
    getDagOverlay: () => undefined,
    listDagOverlays: () => [],
  };
}

test("runRecallEval DEFAULT suite runs against a bare Store double (no SqliteStore-only methods) and passes", () => {
  const a = buildCell(
    { kind: "obs", title: "Deployment pipeline uses blue-green rollout", body: "The deployment pipeline uses a blue-green rollout strategy.", confidence: 0.8, topics: ["deploy"] },
    { key: "aaaaaaaa-0000-0000-0000-000000000000" },
  );
  const b = buildCell(
    { kind: "bel", title: "Team believes rollout strategy is stable", body: "Team believes the current rollout strategy is stable.", confidence: 0.7, topics: ["deploy"] },
    { key: "bbbbbbbb-0000-0000-0000-000000000000" },
  );
  const store = bareStoreWithCells([a, b]);
  assert.equal("recordEvalRun" in store, false);

  const result = runRecallEval(store);
  assert.equal(result.name, "recall-default");
  assert.equal(result.cases.length, 8);
  assert.ok(result.passed, JSON.stringify(result.cases.filter((c) => !c.passed)));
  const semanticCase = result.cases.find((c) => c.kind === "semantic");
  assert.ok(semanticCase);
  assert.equal(semanticCase!.passed, true);
});

test("prefix-resolution invariant passes with details.ambiguous set when two cells share an 8-char key prefix", () => {
  const store = new SqliteStore(":memory:");
  try {
    const shared = "aaaaaaaa";
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8 },
      { key: `${shared}-0000-0000-0000-000000000001` },
    );
    const b = buildCell(
      { kind: "obs", title: "B", body: "b", confidence: 0.8 },
      { key: `${shared}-0000-0000-0000-000000000002` },
    );
    store.put(a);
    store.put(b);
    const suite = {
      name: "custom",
      cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }],
    };
    const result = runRecallEval(store, suite);
    assert.equal(result.cases[0]!.passed, true);
    assert.equal(result.cases[0]!.details.ambiguous, true);
  } finally {
    store.close();
  }
});

test("prefix-resolution invariant fails when the resolver returns a different cell (or none) than the first active cell", () => {
  const a = buildCell(
    { kind: "obs", title: "A", body: "a", confidence: 0.8 },
    { key: "aaaaaaaa-0000-0000-0000-000000000000" },
  );
  const wrong = buildCell(
    { kind: "obs", title: "Wrong", body: "wrong", confidence: 0.8 },
    { key: "ffffffff-0000-0000-0000-000000000000" },
  );

  // get/getByHandle resolve to a DIFFERENT cell than active()[0] for any
  // input, which is exactly the "wrong resolution" branch of the invariant
  // (resolveCell falls through get/getByHandle before its prefix scan).
  const wrongResolutionStore: Store = {
    put: () => {},
    get: () => wrong,
    getByHandle: () => wrong,
    all: () => [a, wrong],
    active: () => [a, wrong],
    neighbors: () => [],
    findByContentKey: () => undefined,
    search: () => [],
    lexicalBackend: () => "like",
    stats: () => ({ cells: 2, activeCells: 2, edges: 0, indexedCells: 2, lexicalBackend: "like" }),
    close: () => {},
    putSemanticVector: () => {},
    getSemanticVector: () => undefined,
    listSemanticVectorIds: () => [],
    putHyperedge: () => {},
    getHyperedge: () => undefined,
    listHyperedges: () => [],
    hyperedgesForCell: () => [],
    putDagOverlay: () => {},
    getDagOverlay: () => undefined,
    listDagOverlays: () => [],
  };
  const suite = {
    name: "custom",
    cases: [{ name: "prefix", kind: "invariant" as const, invariant: "prefix-resolution" as const }],
  };
  const wrongResult = runRecallEval(wrongResolutionStore, suite);
  assert.equal(wrongResult.cases[0]!.passed, false);
  assert.equal(wrongResult.cases[0]!.details.resolvedKey, wrong.key);
  // Sanity: resolveCell itself indeed resolves to the wrong cell for this double.
  assert.equal(resolveCell(wrongResolutionStore, a.key.slice(0, 8))?.key, wrong.key);

  // get/getByHandle return undefined and the prefix scan (store.all()) is
  // empty, so resolveCell returns undefined: the "no resolution" branch.
  const undefinedResolutionStore: Store = {
    ...wrongResolutionStore,
    get: () => undefined,
    getByHandle: () => undefined,
    all: () => [],
    active: () => [a],
  };
  const undefinedResult = runRecallEval(undefinedResolutionStore, suite);
  assert.equal(undefinedResult.cases[0]!.passed, false);
  assert.equal(undefinedResult.cases[0]!.details.resolvedKey, undefined);
});

test("runRecallEval throws a clear error for a case with an unrecognized kind", () => {
  const store = new SqliteStore(":memory:");
  try {
    const suite = {
      name: "bad-kind",
      cases: [{ name: "bad", kind: "serach", query: "q" } as unknown as RecallEvalCase],
    };
    assert.throws(() => runRecallEval(store, suite), /unknown eval case kind: serach/);
  } finally {
    store.close();
  }
});
