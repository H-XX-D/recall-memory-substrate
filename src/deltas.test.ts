import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "./store.js";
import { admit } from "./admission.js";
import { valueSeries, renderDeltasCsv } from "./deltas.js";

function reading(store: SqliteStore, value: number, at: string, supersedes?: string) {
  return admit(
    {
      kind: "obs",
      title: "p99 latency reading",
      body: `measured ${value}ms at ${at}`,
      confidence: 0.6,
      topics: ["latency"],
      value,
      ...(supersedes ? { edges: [{ relation: "supersedes", target: supersedes, weight: 0 }] } : {}),
    },
    { store, now: at },
  ).cell!;
}

test("value flows from proposal to cell and the lineage walk yields the delta series", () => {
  const store = new SqliteStore(":memory:");
  const a = reading(store, 120, "2026-07-01T00:00:00.000Z");
  const b = reading(store, 150, "2026-07-02T00:00:00.000Z", a.key);
  const c = reading(store, 90, "2026-07-03T00:00:00.000Z", b.key);
  assert.equal(store.get(c.key)!.value, 90);

  const rows = valueSeries(store, c.handle);
  assert.deepEqual(rows.map((r) => r.value), [120, 150, 90]);
  assert.deepEqual(rows.map((r) => r.delta), [null, 30, -60]);
  assert.equal(rows[0]!.key, a.key);

  const csv = renderDeltasCsv(rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "timestamp,value,delta,key,title");
  assert.match(lines[1]!, /^2026-07-01T00:00:00\.000Z,120,,/);
  assert.match(lines[3]!, /^2026-07-03T00:00:00\.000Z,90,-60,/);
  store.close();
});

test("topic mode collects readings across cells ordered by time", () => {
  const store = new SqliteStore(":memory:");
  admit({ kind: "obs", title: "reading one", body: "b", confidence: 0.6, topics: ["throughput"], value: 10 }, { store, now: "2026-07-01T00:00:00.000Z" });
  admit({ kind: "obs", title: "reading two", body: "b", confidence: 0.6, topics: ["throughput"], value: 25 }, { store, now: "2026-07-02T00:00:00.000Z" });
  admit({ kind: "obs", title: "unrelated", body: "b", confidence: 0.6, topics: ["other"], value: 999 }, { store, now: "2026-07-02T01:00:00.000Z" });
  const rows = valueSeries(store, "throughput", { topic: true });
  assert.deepEqual(rows.map((r) => r.value), [10, 25]);
  assert.deepEqual(rows.map((r) => r.delta), [null, 15]);
  store.close();
});

test("a watch program can measure the value field directly", async () => {
  const { runProgramCell } = await import("./programs.js");
  const store = new SqliteStore(":memory:");
  admit({ kind: "obs", title: "reading", body: "b", confidence: 0.6, topics: ["latency"], value: 200 }, { store });
  const prg = admit(
    { kind: "prg", title: "watch latency value", body: "standing", confidence: 0.6, props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { topics: ["latency"] }, params: { measure: "value" } } } },
    { store },
  ).cell!;
  const { run } = runProgramCell(store, store.get(prg.key)!, new Date().toISOString(), { derive: false });
  assert.equal(run.output.current, 200);
  store.close();
});
