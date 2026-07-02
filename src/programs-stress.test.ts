// Stress sweep: every program op, authored from the netlist, must run over 0 / 1 / many
// members without crashing or emitting a non-finite number, and degrade cleanly on
// bad input. Guards the "new op = additive vocabulary" property: ops stay robust as
// the palette grows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "./store.js";
import { admit } from "./admission.js";
import { parseNetlist, loadNetlist } from "./netlist.js";
import { runStandingPrograms, PROGRAM_OPERATIONS } from "./programs.js";

const NOW = "2026-06-23T00:00:00Z";
const hasNonFinite = (o: unknown): boolean =>
  JSON.stringify(o, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? "__BAD__" : v)).includes("__BAD__");

function seed(n: number): SqliteStore {
  const s = new SqliteStore();
  for (let i = 0; i < n; i++) {
    const r = admit({ kind: "obs", title: `m${i}`, body: "b", confidence: 0.5 + 0.4 * (i % 2), topics: ["g"] }, { key: `k${i}`, store: s, now: NOW });
    if (r.cell) s.put(r.cell);
  }
  return s;
}

for (const op of PROGRAM_OPERATIONS) {
  for (const n of [0, 1, 25]) {
    test(`stress: ${op} runs clean over ${n} member(s)`, () => {
      const store = seed(n);
      loadNetlist(parseNetlist(`addf ${op} tick [topics: g]`).nodes, store, "merge");
      const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === op);
      assert.ok(run, `${op} produced a run`);
      assert.equal(run!.output.memberCount, n);
      assert.ok(!hasNonFinite(run!.output), `${op} emitted a non-finite number`);
    });
  }
}

test("stress: numeric trend on a missing field path stays finite", () => {
  const store = seed(2);
  loadNetlist(parseNetlist("addf trend tick [topics: g] [measure: props.nope.nope]").nodes, store, "merge");
  const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === "trend")!;
  assert.ok(!hasNonFinite(run.output));
});

test("stress: quorum with k greater than member count does not crash", () => {
  const store = seed(2);
  loadNetlist(parseNetlist("addf quorum tick [topics: g] [k: 9] [minEff: 0.6]").nodes, store, "merge");
  const run = runStandingPrograms(store, NOW).runs.find((r) => r.operation === "quorum")!;
  assert.ok(!hasNonFinite(run.output));
});

test("stress: an unknown op degrades to unsupported, not a crash", () => {
  const res = loadNetlist(parseNetlist("addf not_a_real_op tick").nodes, seed(1), "merge");
  assert.equal(res.unsupported.length, 1);
  assert.equal(res.programsCreated.length, 0);
});
