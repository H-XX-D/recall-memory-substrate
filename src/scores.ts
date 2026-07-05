// MAL score math: the derived effective confidence and time-decayed currency.
// Pure functions over numbers; no I/O, no cell mutation.

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// effective = clamp01(stated*calibration + 0.15*tanh(supportMass) - 0.6*tanh(challengeMass))
export function effectiveConfidence({
  stated,
  calibration,
  supportMass,
  challengeMass,
}: {
  stated: number;
  calibration: number;
  supportMass: number;
  challengeMass: number;
}): number {
  return clamp01(
    stated * calibration +
      0.15 * Math.tanh(supportMass) -
      0.6 * Math.tanh(challengeMass),
  );
}

// currency = cFloor + (c0 - cFloor) * exp(-dt/tau)
// dt and tau in days; cFloor defaults to 0.1. At dt=0 returns c0; as dt grows
// it decays asymptotically toward cFloor.
export function currency({
  c0,
  dt,
  tau,
  cFloor = 0.1,
}: {
  c0: number;
  dt: number;
  tau: number;
  cFloor?: number;
}): number {
  return cFloor + (c0 - cFloor) * Math.exp(-dt / tau);
}

// Salience is attention, not freshness: it accrues on retrieval and leaks on
// idle. SALIENCE_TAU_DAYS is the idle leak time-constant; SALIENCE_FLOOR is the
// resting attention a never-retrieved cell settles toward; SALIENCE_GAIN is the
// per-retrieval accumulator step in salienceBump.
export const SALIENCE_TAU_DAYS = 30;
export const SALIENCE_FLOOR = 0.05;
export const SALIENCE_GAIN = 0.2;

// Idle leak: salience = floor + (seed - floor) * exp(-dt/tau). At dt=0 returns
// the seed (so a just-retrieved or brand-new cell holds its salience); as idle
// time grows it decays toward the floor. Anchored to lastSalientAt so, like the
// currency tick, it is idempotent and never compounds.
export function salienceDecay({
  seed,
  dt,
  tau = SALIENCE_TAU_DAYS,
  floor = SALIENCE_FLOOR,
}: {
  seed: number;
  dt: number;
  tau?: number;
  floor?: number;
}): number {
  return floor + (seed - floor) * Math.exp(-dt / tau);
}

// Retrieval bump: a leaky-accumulator step toward 1. seed' = seed + (1-seed)*gain,
// clamped to [0, 1]. Diminishing returns as a cell is retrieved repeatedly.
export function salienceBump(seed: number, gain = SALIENCE_GAIN): number {
  return clamp01(seed + (1 - seed) * gain);
}
