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
