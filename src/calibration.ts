// Actor calibration: turn an actor's resolved write history into a trust factor.
// Pure functions, no side effects.

import type { ActorOutcome } from "./types.js";

// A multiplier in [0.5, 1] that attenuates an overconfident actor's effective
// score. Returns 1 (neutral) when there is too little history to judge.
export function calibrationFactor(outcomes: ActorOutcome[]): number {
  if (outcomes.length < 3) return 1;
  return Math.max(0.5, 1 - brierScore(outcomes));
}

// Mean squared error between stated confidence and the realized binary outcome
// (1 = survived, 0 = contradicted). Lower is better; 0 for an empty history.
export function brierScore(outcomes: ActorOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const total = outcomes.reduce((sum, o) => {
    if (!Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
      throw new Error("actor outcome confidence must be a finite number in [0, 1]");
    }
    const outcome = o.contradicted ? 0 : 1;
    const error = o.confidence - outcome;
    return sum + error * error;
  }, 0);
  return total / outcomes.length;
}
