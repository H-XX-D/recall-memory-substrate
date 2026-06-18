import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeHyperedgeProgram } from "../src/core/programs.js";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";
import type { Hyperedge, HyperedgeProgram, ProgramRun, RecallNode } from "../src/core/types.js";

// trend: discrete calculus over the run-history series. Each run appends the
// bundle's current value to a sliding window carried in the output, then reads
// off direction (sign of the overall slope), slope (first difference), and
// acceleration (late slope minus early slope) — finite differences, not
// continuous calculus. It trips on a directional streak or a slope past delta,
// and files a witness through admission like watch and drift.

const NOW = new Date("2026-06-18T00:00:00.000Z");

function program(params: Record<string, unknown>): HyperedgeProgram {
  return {
    id: "prog-trend",
    hyperedgeId: "edge-1",
    spec: { schemaVersion: "recall.program.v1", operation: "trend", params },
    enabled: true,
    createdAt: NOW.toISOString()
  } as HyperedgeProgram;
}

function bundle(ids: string[]): Hyperedge {
  return {
    id: "edge-1",
    kind: "evidence-bundle",
    title: "Trend bundle",
    members: ids.map((id) => ({ nodeId: id, role: "member" }))
  } as unknown as Hyperedge;
}

function nodes(ids: string[]): RecallNode[] {
  return ids.map((id) => ({ id, cellAddress: `recall://cell/${id}`, title: id })) as unknown as RecallNode[];
}

// Run trend once with members whose live values come from `eff`, and an
// optional prior series carried as a previous run.
function runTrend(
  params: Record<string, unknown>,
  ids: string[],
  eff: Record<string, number>,
  priorSeries: number[] | null
): Record<string, unknown> {
  const previousRun: ProgramRun | null =
    priorSeries === null
      ? null
      : ({ id: "prev", programId: "prog-trend", hyperedgeId: "edge-1", output: { series: priorSeries }, createdAt: NOW.toISOString() } as ProgramRun);
  const result = executeHyperedgeProgram({
    program: program(params),
    hyperedge: bundle(ids),
    members: nodes(ids),
    effectiveConfidence: new Map(Object.entries(eff)),
    previousRun,
    now: NOW
  });
  return result.output;
}

describe("trend program (discrete calculus over the series)", () => {
  it("first run establishes the series and never trips", () => {
    const out = runTrend({}, ["m1"], { m1: 0.5 }, null);
    assert.deepEqual(out.series, [0.5]);
    assert.equal(out.direction, "stable");
    assert.equal(out.slope, 0);
    assert.equal(out.acceleration, 0);
    assert.equal(out.tripped, false);
    assert.equal(out.witness, undefined);
  });

  it("an ascending series reports ascending with a positive slope and trips on the streak", () => {
    const out = runTrend({}, ["m1"], { m1: 0.5 }, [0.2, 0.3, 0.4]);
    assert.deepEqual(out.series, [0.2, 0.3, 0.4, 0.5]);
    assert.equal(out.direction, "ascending");
    assert.equal(out.slope, 0.1);
    assert.equal(out.streak, 3); // three consecutive rising steps
    assert.equal(out.tripped, true);
    assert.ok(out.witness, "a tripped trend files a witness");
  });

  it("a small single step stays below both thresholds and does not trip", () => {
    const out = runTrend({}, ["m1"], { m1: 0.49 }, [0.5]);
    assert.equal(out.direction, "descending");
    assert.equal(out.slope, -0.01);
    assert.equal(out.streak, -1);
    assert.equal(out.tripped, false);
  });

  it("acceleration is late slope minus early slope (second difference)", () => {
    const out = runTrend({}, ["m1"], { m1: 0.4 }, [0.1, 0.2]); // series 0.1, 0.2, 0.4
    assert.deepEqual(out.series, [0.1, 0.2, 0.4]);
    assert.equal(out.acceleration, 0.1); // late slope 0.2 minus early slope 0.1
  });

  it("a flat series is stable and does not trip", () => {
    const out = runTrend({}, ["m1"], { m1: 0.3 }, [0.3, 0.3, 0.3]);
    assert.equal(out.direction, "stable");
    assert.equal(out.slope, 0);
    assert.equal(out.streak, 0);
    assert.equal(out.tripped, false);
  });

  it("respects the window: the series is capped to the last `window` values", () => {
    const out = runTrend({ window: 3 }, ["m1"], { m1: 5 }, [1, 2, 3, 4]);
    assert.deepEqual(out.series, [3, 4, 5]);
  });

  it("measure 'member_count' tracks the number of members, not their confidence", () => {
    const out = runTrend({ measure: "member_count" }, ["a", "b", "c"], { a: 0.1, b: 0.1, c: 0.1 }, null);
    assert.equal(out.current, 3);
  });

  it("trips on a steep slope even when the streak is short", () => {
    const out = runTrend({ delta: 0.1, streak: 9 }, ["m1"], { m1: 0.1 }, [0.5]);
    assert.equal(out.slope, -0.4);
    assert.equal(out.tripped, true); // |slope| 0.4 >= delta 0.1, streak rule not reached
  });
});

describe("trend program: wired through the store", () => {
  it("attaches as a program and a baseline run carries a series without tripping", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const a = admitWriteProposal(makeProposal({
        content: { title: "Decision A", body: "x", summary: "x" }
      }), store, { now: new Date("2026-06-01T00:00:00.000Z") }).node!;
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Tracked decision",
        members: [{ nodeId: a.id, role: "claim" }]
      });
      const prog = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "trend",
        params: { window: 8, delta: 0.1, streak: 3 }
      });
      const baseline = store.runProgram(prog.id);
      assert.equal(baseline.output.tripped, false);
      assert.ok(Array.isArray(baseline.output.series), "baseline run carries a series");
      assert.equal((baseline.output.series as number[]).length, 1);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
