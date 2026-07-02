// neighborMass: the support/challenge masses a cell earns from the evidence
// pointing AT it. Reads the cell's INCOMING evidential edges, each weighted by
// the neighbor's effective confidence. This is what fills the masses R1
// admission pinned to 0; it feeds effectiveConfidence in scores.ts.
import type { Store } from "./types.js";

export function neighborMass(
  store: Store,
  key: string,
): { supportMass: number; challengeMass: number } {
  let supportMass = 0;
  let challengeMass = 0;
  for (const link of store.neighbors(key)) {
    if (link.direction !== "in") continue; // evidence points at this cell
    const w = link.edge.weight; // signed: supports +, contradicts/concerns -
    const eff = link.cell.scores.effective;
    if (w > 0) supportMass += w * eff;
    else if (w < 0) challengeMass += -w * eff;
  }
  return { supportMass, challengeMass };
}
