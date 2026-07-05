// Actor calibration producer: the read side of R1 calibration. calibration.ts is
// the pure Brier math; this module derives the ActorOutcome history it scores by
// asking the store what later happened to an actor's past writes. The effective
// formula already consumes actorCalibration (admission/operator); this is the
// missing producer that turns a writer's track record into the factor it feeds.
import { calibrationFactor } from "./calibration.js";
import type { ActorOutcome, Store } from "./types.js";

// A past write is judgeable once the graph has reacted to it: it was superseded,
// or it carries an incoming *active* contradicts edge. Those are outcome 0
// (contradicted); every other write by the actor is outcome 1 (survived/held).
// A soft `concerns` edge does not flip the outcome; only a hard contradiction
// or a supersession counts as the claim having been wrong.
export function actorOutcomes(
  store: Store,
  actorId: string,
  opts: { excludeKey?: string } = {},
): ActorOutcome[] {
  const outcomes: ActorOutcome[] = [];
  for (const cell of store.all()) {
    if (cell.provenance.producedBy !== actorId) continue;
    if (opts.excludeKey && cell.key === opts.excludeKey) continue;
    outcomes.push({
      confidence: cell.scores.conf,
      contradicted: cell.status === "superseded" || hasActiveContradiction(store, cell.key),
    });
  }
  return outcomes;
}

function hasActiveContradiction(store: Store, key: string): boolean {
  return store.neighbors(key).some(
    (link) =>
      link.direction === "in" &&
      link.edge.relation === "contradicts" &&
      link.cell.status === "active",
  );
}

// The actor's standing calibration factor in [0.5, 1]. Neutral (1) until the
// actor has at least 3 resolved outcomes (calibrationFactor's own floor for
// "too little history to judge"). Pass excludeKey for the cell being written so
// a write never calibrates against itself.
export function actorCalibrationFactor(
  store: Store,
  actorId: string,
  opts: { excludeKey?: string } = {},
): number {
  return calibrationFactor(actorOutcomes(store, actorId, opts));
}
