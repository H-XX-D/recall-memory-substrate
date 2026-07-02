import { test } from "node:test";
import assert from "node:assert/strict";
import { brierScore, calibrationFactor } from "./calibration.js";
import type { ActorOutcome } from "./types.js";

test("calibrationFactor returns 1 when fewer than 3 outcomes (too little history)", () => {
  const outcomes: ActorOutcome[] = [
    { confidence: 0.9, contradicted: true },
    { confidence: 0.8, contradicted: true },
  ];
  assert.equal(calibrationFactor(outcomes), 1);
});

test("calibrationFactor is 1 - Brier score floored at 0.5", () => {
  const outcomes: ActorOutcome[] = [
    { confidence: 0.9, contradicted: true },
    { confidence: 0.9, contradicted: true },
    { confidence: 0.9, contradicted: true },
    { confidence: 0.9, contradicted: true },
  ];
  assert.equal(calibrationFactor(outcomes), 0.5);
});

test("calibrationFactor uses Brier score even when writes survived", () => {
  const outcomes: ActorOutcome[] = [
    { confidence: 0.9, contradicted: false },
    { confidence: 0.7, contradicted: false },
    { confidence: 0.6, contradicted: false },
  ];
  assert.ok(Math.abs(calibrationFactor(outcomes) - 0.9133333333333333) < 1e-12);
});

test("brierScore is near 0 for confident writes that survived", () => {
  // High confidence, none contradicted -> outcome target is 1, error per cell
  // is (0.95 - 1)^2 = 0.0025, mean stays small.
  const outcomes: ActorOutcome[] = [
    { confidence: 0.95, contradicted: false },
    { confidence: 0.96, contradicted: false },
    { confidence: 0.97, contradicted: false },
  ];
  assert.ok(brierScore(outcomes) < 0.01);
});

test("brierScore returns 0 for an empty history", () => {
  assert.equal(brierScore([]), 0);
});

test("brierScore rejects malformed confidence", () => {
  assert.throws(() => brierScore([{ confidence: Number.NaN, contradicted: false }]));
  assert.throws(() => calibrationFactor([
    { confidence: 0.9, contradicted: false },
    { confidence: 1.2, contradicted: false },
    { confidence: 0.8, contradicted: false },
  ]));
});
