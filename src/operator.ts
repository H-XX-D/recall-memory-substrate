// The operator: the between-turn deterministic tick (HAL's "thread"). No LLM.
// Each tick decays currency from the anchor (updatedAt, not the last tick, so it
// never compounds) and recomputes effective from current neighbor masses. Pinned
// cells are exempt from currency decay. Computed from a pre-tick snapshot of
// neighbor effectives, then written, so a tick is order-independent.
import type { AdmissionResult, Cell, Stability, Store, StoreStats } from "./types.js";
import { currency, effectiveConfidence } from "./scores.js";
import { neighborMass } from "./mass.js";
import { runStandingPrograms, type ProgramRun } from "./programs.js";

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
  return {
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
      after: store.stats(),
    },
  };
}
