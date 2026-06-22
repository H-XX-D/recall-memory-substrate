import assert from "node:assert/strict";
import { test } from "node:test";
import { executeHyperedgeProgram } from "../src/core/programs.js";
import type { Hyperedge, HyperedgeProgram, RecallNode } from "../src/core/types.js";

const NOW = new Date("2026-06-18T00:00:00.000Z");

function trendProgram(measure: string): HyperedgeProgram {
  return {
    id: "p",
    hyperedgeId: "e",
    spec: { schemaVersion: "recall.program.v1", operation: "trend", params: { measure } },
    enabled: true,
    createdAt: NOW.toISOString(),
  } as HyperedgeProgram;
}

function bundle(ids: string[]): Hyperedge {
  return {
    id: "e",
    kind: "evidence-bundle",
    title: "b",
    members: ids.map((id) => ({ nodeId: id, role: "member" })),
  } as unknown as Hyperedge;
}

function member(id: string, data: Record<string, unknown>): RecallNode {
  return { id, cellAddress: `recall://cell/${id}`, title: id, data } as unknown as RecallNode;
}

function runTrend(measure: string, members: RecallNode[], eff: Record<string, number>): any {
  return executeHyperedgeProgram({
    program: trendProgram(measure),
    hyperedge: bundle(members.map((m) => m.id)),
    members,
    effectiveConfidence: new Map(Object.entries(eff)),
    previousRun: null,
    now: NOW,
  }).output;
}

test("trend with a numeric-field measure tracks that field, not effective_confidence", () => {
  const members = [member("a", { metric: 10 }), member("b", { metric: 20 })];
  // effectiveConfidence is 0.9 for both: if the measure silently fell back, current would be 0.9
  const out = runTrend("metric", members, { a: 0.9, b: 0.9 });
  assert.equal(out.measure, "metric");
  assert.equal(out.current, 15); // mean of 10 and 20
  assert.deepEqual(out.series, [15]);
});

test("trend with a dotted field path reads nested cell data", () => {
  const members = [
    member("a", { confidence: { uncertainty: 0.2 } }),
    member("b", { confidence: { uncertainty: 0.4 } }),
  ];
  const out = runTrend("confidence.uncertainty", members, { a: 0.9, b: 0.9 });
  assert.equal(out.measure, "confidence.uncertainty");
  assert.equal(out.current, 0.3); // mean of 0.2 and 0.4
});

test("a field absent on all members yields 0, not a silent confidence fallback", () => {
  const members = [member("a", {}), member("b", {})];
  const out = runTrend("nonexistent_field", members, { a: 0.9, b: 0.9 });
  assert.equal(out.measure, "nonexistent_field");
  assert.equal(out.current, 0);
});

test("named built-ins still work (no regression)", () => {
  const members = [member("a", {}), member("b", {})];
  const ec = runTrend("effective_confidence", members, { a: 0.5, b: 0.7 });
  assert.equal(ec.measure, "effective_confidence");
  assert.equal(ec.current, 0.6);
  const mc = runTrend("member_count", members, {});
  assert.equal(mc.measure, "member_count");
  assert.equal(mc.current, 2);
});
