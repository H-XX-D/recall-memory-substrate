import { test } from "node:test";
import assert from "node:assert/strict";
import { runOperatorCycle, tick } from "./operator.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";
import type { Cell, Store } from "./types.js";

test("tick decays currency from updatedAt by the stability tau", () => {
  const store = new SqliteStore(":memory:");
  const c = buildCell(
    { kind: "obs", title: "T", body: "b", confidence: 0.6, stability: "volatile" },
    { key: "kkkk", now: "2026-01-01T00:00:00.000Z" },
  );
  store.put(c);
  tick(store, "2026-01-31T00:00:00.000Z"); // 30 days, tau(volatile)=30 -> dt/tau=1

  const after = store.get("kkkk")!;
  // currency = cFloor + (c0 - cFloor) * e^-1
  assert.ok(Math.abs(after.scores.currency - (0.1 + 0.9 * Math.exp(-1))) < 1e-6);
  store.close();
});

test("tick leaves a pinned cell's currency untouched", () => {
  const store = new SqliteStore(":memory:");
  const c = buildCell(
    { kind: "obs", title: "T", body: "b", confidence: 0.6, stability: "ephemeral" },
    { key: "kkkk", now: "2026-01-01T00:00:00.000Z" },
  );
  c.flags.pinned = true;
  store.put(c);
  tick(store, "2027-01-01T00:00:00.000Z"); // a year later

  assert.equal(store.get("kkkk")?.scores.currency, 1); // exempt from decay
  store.close();
});

test("tick recomputes effective from current neighbor masses", () => {
  const store = new SqliteStore(":memory:");
  // put X then a contradicting Y directly (bypassing admit's recompute), so X's
  // effective is stale until the tick recomputes it.
  const x = buildCell({ kind: "dec", title: "X", body: "x", confidence: 0.7 }, { key: "xxxx" });
  const y = buildCell(
    { kind: "obs", title: "Y", body: "y", confidence: 0.9, edges: [{ relation: "contradicts", target: "xxxx" }] },
    { key: "yyyy" },
  );
  store.put(x);
  store.put(y);
  assert.equal(store.get("xxxx")?.scores.effective, 0.7); // still stale

  tick(store, x.createdAt); // dt=0 (no decay), recompute only
  assert.ok(store.get("xxxx")!.scores.effective < 0.7); // demoted by Y's contradiction
  store.close();
});

test("runOperatorCycle ticks and runs standing programs with derived witnesses", () => {
  const store = new SqliteStore(":memory:");
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-2222-2222-2222-222222222222" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate witness",
        body: "always emit a witness",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "emit_witness",
            target: { keys: [watched.key] },
          },
        },
      },
      { key: "cccccccc-2222-2222-2222-222222222222" },
    );
    store.put(watched);
    store.put(program);

    const result = runOperatorCycle(store, "2026-06-26T12:00:00.000Z", { derive: true });
    assert.equal(result.status, "ran");
    assert.equal(result.ticked, 2);
    assert.equal(result.programs.runs.length, 1);
    assert.equal(result.programs.derived.length, 1);
    assert.equal(result.programs.derived[0]?.accepted, true);
    assert.equal(store.get(program.key)?.props.runCount, 1);
    assert.equal(store.stats().activeCells, 3);
  } finally {
    store.close();
  }
});

test("runOperatorCycle records a ledger row against SqliteStore and returns its id", () => {
  const store = new SqliteStore(":memory:");
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-2222-2222-2222-222222222222" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate witness",
        body: "always emit a witness",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "emit_witness",
            target: { keys: [watched.key] },
          },
        },
      },
      { key: "cccccccc-2222-2222-2222-222222222222" },
    );
    store.put(watched);
    store.put(program);

    const result = runOperatorCycle(store, "2026-06-26T12:00:00.000Z", { derive: true });
    assert.ok(result.ledger?.id);

    const stored = store.getOperatorRun(result.ledger!.id);
    assert.equal(stored?.status, "ran");
    assert.equal(stored?.summary, "ticked 2; programs 1; derived 1");
    assert.deepEqual(stored?.result, {
      ticked: 2,
      programRuns: 1,
      derivedAccepted: 1,
      stats: result.stats.after,
    });
  } finally {
    store.close();
  }
});

// Store-typed double (no SqliteStore-only methods behind it): a plain Store
// implementation must still cycle, with ledger left undefined.
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

test("runOperatorCycle against a bare Store double still cycles, with ledger left undefined", () => {
  const watched = buildCell(
    { kind: "obs", title: "Watched", body: "watched", confidence: 0.9 },
    { key: "aaaaaaaa-2222-2222-2222-222222222222" },
  );
  const store = bareStoreWithCells([watched]);
  assert.equal("recordOperatorRun" in store, false);

  const result = runOperatorCycle(store, "2026-06-26T12:00:00.000Z");
  assert.equal(result.status, "ran");
  assert.equal(result.ticked, 1);
  assert.equal(result.ledger, undefined);
});

test("tick leaks salience from lastSalientAt toward the floor", () => {
  const store = new SqliteStore(":memory:");
  const c = buildCell(
    { kind: "obs", title: "T", body: "b", confidence: 0.6 },
    { key: "salc", now: "2026-01-01T00:00:00.000Z" },
  );
  store.put(c);
  // 30 days idle from updatedAt (no lastSalientAt): salience decays below seed 0.5
  tick(store, "2026-01-31T00:00:00.000Z");
  const after = store.get("salc")!;
  assert.ok(after.scores.salience < 0.5);
  assert.ok(after.scores.salience >= 0.05); // stays above the floor
  assert.equal(after.scores.salienceSeed, 0.5); // seed is the anchor, unchanged
  store.close();
});

test("tick leaves salience at the seed when there is no idle time", () => {
  const store = new SqliteStore(":memory:");
  const c = buildCell(
    { kind: "obs", title: "T", body: "b", confidence: 0.6 },
    { key: "sal0", now: "2026-01-01T00:00:00.000Z" },
  );
  store.put(c);
  tick(store, "2026-01-01T00:00:00.000Z"); // dt=0
  assert.equal(store.get("sal0")?.scores.salience, 0.5);
  store.close();
});

test("a pinned cell's salience does not leak", () => {
  const store = new SqliteStore(":memory:");
  const c = buildCell(
    { kind: "obs", title: "T", body: "b", confidence: 0.6 },
    { key: "salp", now: "2026-01-01T00:00:00.000Z" },
  );
  c.flags.pinned = true;
  store.put(c);
  tick(store, "2027-01-01T00:00:00.000Z"); // a year later
  assert.equal(store.get("salp")?.scores.salience, 0.5);
  store.close();
});
