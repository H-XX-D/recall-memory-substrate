import { calibrationFromNodes } from "./calibration.js";
import type { RecallStore } from "./store.js";
import type { RecallNode } from "./types.js";

// Effective confidence: the living, graph-computed counterpart to a cell's
// stated confidence. Stated confidence is the author's claim at write time —
// it stays immutable because closed-loop calibration scores actors on it.
// Effective confidence is derived from the current graph surface at read
// time, so it is always current by construction and needs no LLM and no
// persistence:
//
//   effective = clamp01(stated × calibration  +  support  −  challenge)
//
//   calibration — the writing actor's track record (1 − Brier, floored).
//     A chronically overconfident actor's claims are discounted before any
//     edge is considered.
//   support — incoming `supports` relations and `*-supports` hyperedges
//     (checker/test verdicts). Corroboration is cheap to mass-produce, so
//     it saturates fast (tanh) under a low ceiling.
//   challenge — incoming `contradicts`/`concerns` relations and
//     `*-contradicts` hyperedges. An active contradiction is the strongest
//     signal the graph carries, so its ceiling is high enough that one
//     confident challenger outweighs any graph-degree advantage in ranking.
//
// One hop, deterministic, O(edges-on-node). Neighbor weight uses the
// neighbor's *stated* confidence — no recursion, no fixed-point iteration,
// every number explainable from the cell's immediate surface.

export interface ConfidenceBreakdown {
  stated: number;
  calibrationFactor: number;
  support: number;
  challenge: number;
  effective: number;
  supporters: number;
  challengers: number;
}

const SUPPORT_CEILING = 0.15;
const CHALLENGE_CEILING = 0.6;
const CONCERN_FACTOR = 0.5; // a concern counts as half a contradiction
// Checker/test hyperedges carry externally-run evidence (a verifier or test
// actually executed), so they weigh more than a peer cell's assertion.
const VERIFIED_EDGE_WEIGHT = 1.25;
const CALIBRATION_FLOOR = 0.5;
// Actors with fewer cells than this keep a neutral factor — too little
// history to judge.
const CALIBRATION_MIN_CELLS = 3;
const CONFIDENCE_DEFAULT = 0.5;

export function statedConfidence(node: RecallNode): number {
  const confidence = node.data.confidence;
  if (typeof confidence === "object" && confidence !== null && !Array.isArray(confidence)) {
    const value = (confidence as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value));
    }
  }
  return CONFIDENCE_DEFAULT;
}

/** Per-actor confidence multipliers from the calibration report. */
export type CalibrationFactors = ReadonlyMap<string, number>;

export function calibrationFactors(store: RecallStore, limit = 1000): CalibrationFactors {
  const factors = new Map<string, number>();
  for (const row of calibrationFromNodes(store.listNodes(limit))) {
    if (row.cells < CALIBRATION_MIN_CELLS) {
      continue;
    }
    // Discount by the overconfidence signal — how often the actor was
    // contradicted, weighted by how confident they were when wrong. Raw
    // Brier would also punish humble actors (low stated confidence on
    // surviving cells scores badly), which is the opposite of the incentive
    // this system exists to create.
    const overconfidence = row.contradictedRate * (row.meanConfidenceContradicted ?? 0);
    factors.set(row.actor, Math.max(CALIBRATION_FLOOR, 1 - overconfidence));
  }
  return factors;
}

export function effectiveConfidence(
  store: RecallStore,
  node: RecallNode,
  calibration?: CalibrationFactors
): ConfidenceBreakdown {
  const stated = statedConfidence(node);
  const producer = node.provenance?.produced_by;
  const calibrationFactor =
    (typeof producer === "string" && calibration?.get(producer)) || 1;

  let supportMass = 0;
  let challengeMass = 0;
  let supporters = 0;
  let challengers = 0;

  for (const relation of store.listRelations(node.id, "in", 100)) {
    if (
      relation.kind !== "supports" &&
      relation.kind !== "contradicts" &&
      relation.kind !== "concerns"
    ) {
      continue;
    }
    const source = store.getNode(relation.sourceId);
    if (!source || source.status !== "active") {
      continue;
    }
    const weight = statedConfidence(source);
    if (relation.kind === "supports") {
      supportMass += weight;
      supporters += 1;
    } else {
      challengeMass += weight * (relation.kind === "concerns" ? CONCERN_FACTOR : 1);
      challengers += 1;
    }
  }

  // Same membership semantics as compile's challenge surfacing: any
  // *-contradicts / *-supports hyperedge the node belongs to counts.
  // (code-superseded-by is deliberately excluded until member roles are
  // inspectable — both ends would sink otherwise.)
  for (const edge of store.hyperedgesForNode?.(node.id, 100) ?? []) {
    if (edge.kind.endsWith("-supports")) {
      supportMass += VERIFIED_EDGE_WEIGHT;
      supporters += 1;
    } else if (edge.kind.endsWith("-contradicts")) {
      challengeMass += VERIFIED_EDGE_WEIGHT;
      challengers += 1;
    }
  }

  const support = SUPPORT_CEILING * Math.tanh(supportMass);
  const challenge = CHALLENGE_CEILING * Math.tanh(challengeMass);
  const effective = clamp01(stated * calibrationFactor + support - challenge);
  return { stated, calibrationFactor, support, challenge, effective, supporters, challengers };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
