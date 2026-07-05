// The operator: the between-turn deterministic tick (HAL's "thread"). No LLM.
// Each tick decays currency from the anchor (updatedAt, not the last tick, so it
// never compounds) and recomputes effective from current neighbor masses. Pinned
// cells are exempt from currency decay. Computed from a pre-tick snapshot of
// neighbor effectives, then written, so a tick is order-independent.
import { randomUUID } from "node:crypto";
import type { AdmissionResult, Cell, Stability, Store, StoreStats } from "./types.js";
import { currency, effectiveConfidence, salienceDecay } from "./scores.js";
import { neighborMass } from "./mass.js";
import { runStandingPrograms, type ProgramRun } from "./programs.js";
import type { SqliteStore } from "./store.js";

export interface OperatorCycleOptions {
  derive?: boolean;
  programs?: boolean;
}

export interface OperatorCycleResult {
  status: "ran";
  createdAt: string;
  ticked: number;
  programs: {
    enabled: boolean;
    runs: ProgramRun[];
    derived: AdmissionResult[];
  };
  stats: {
    before: StoreStats;
    after: StoreStats;
  };
  ledger?: { id: string };
}

// The operator run ledger. status is the literal "ran" only, deliberately: MAL
// has no lease machinery here (unlike program/eval runs elsewhere), because the
// tick is idempotent by design (decay anchors to cell.updatedAt, not "time since
// last tick"), so concurrent or repeated cycles are always safe and there is
// nothing for a "skipped" status to report.
export interface OperatorRun {
  id: string;
  status: "ran";
  summary: string;
  result: Record<string, unknown>;
  createdAt: string;
}

const TAU_DAYS: Record<Stability, number> = {
  stable: 3650,
  volatile: 30,
  ephemeral: 7,
};
const DAY_MS = 86_400_000;

function recompute(store: Store, cell: Cell, now: string): Cell {
  const scores = { ...cell.scores };
  if (!cell.flags.pinned) {
    const dt = Math.max(0, (Date.parse(now) - Date.parse(cell.updatedAt)) / DAY_MS);
    scores.currency = currency({
      c0: cell.scores.currencyC0,
      dt,
      tau: TAU_DAYS[cell.stability],
      cFloor: 0.1,
    });
    // Salience leaks from its own anchor (last retrieval, else updatedAt), so
    // attention fades on idle without touching the currency/freshness anchor.
    const dtSal = Math.max(0, (Date.parse(now) - Date.parse(cell.lastSalientAt ?? cell.updatedAt)) / DAY_MS);
    scores.salience = salienceDecay({ seed: cell.scores.salienceSeed, dt: dtSal });
  }
  const m = neighborMass(store, cell.key);
  scores.effective = effectiveConfidence({
    stated: cell.scores.conf,
    calibration: cell.scores.actorCalibration,
    supportMass: m.supportMass,
    challengeMass: m.challengeMass,
  });
  return { ...cell, scores }; // updatedAt preserved: a tick is not a reinforcement
}

// Tick a single cell (currency decay + effective recompute).
export function tickCell(store: Store, key: string, now: string): void {
  const cell = store.get(key);
  if (cell) store.put(recompute(store, cell, now));
}

// Tick every active cell from a pre-tick snapshot. Returns the count ticked.
export function tick(store: Store, now: string): number {
  const cells = store.active();
  const updated = cells.map((c) => recompute(store, c, now)); // reads pre-tick state
  for (const u of updated) store.put(u);
  return updated.length;
}

// Run one deterministic operator cycle: tick active cell scores, then run
// standing `prg` cells. Derived program witnesses re-enter through admission.
export function runOperatorCycle(
  store: Store,
  now: string,
  opts: OperatorCycleOptions = {},
): OperatorCycleResult {
  const before = store.stats();
  const ticked = tick(store, now);
  const programsEnabled = opts.programs ?? true;
  const programs = programsEnabled ? runStandingPrograms(store, now, { derive: opts.derive }) : { runs: [], derived: [] };
  const after = store.stats();
  // A duplicate re-derivation still has accepted true (it short-circuited onto
  // the existing cell), so derivedAccepted counts non-duplicate accepted results
  // only: accepted && !duplicateOf. Otherwise the count would double-report
  // witnesses that were already recorded on an earlier cycle.
  const derivedAccepted = programs.derived.filter((d) => d.accepted && !d.duplicateOf).length;
  const result: OperatorCycleResult = {
    status: "ran",
    createdAt: now,
    ticked,
    programs: {
      enabled: programsEnabled,
      runs: programs.runs,
      derived: programs.derived,
    },
    stats: {
      before,
      after,
    },
  };
  if ("recordOperatorRun" in store) {
    const run = (store as SqliteStore).recordOperatorRun({
      id: randomUUID(),
      status: "ran",
      summary: `ticked ${ticked}; programs ${programs.runs.length}; derived ${derivedAccepted}`,
      result: { ticked, programRuns: programs.runs.length, derivedAccepted, stats: after },
      createdAt: now,
    });
    result.ledger = { id: run.id };
  }
  return result;
}
