import { test } from "node:test";
import assert from "node:assert/strict";
import { runOperatorCycle, tick } from "./operator.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";

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
