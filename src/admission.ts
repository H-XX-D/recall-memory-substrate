// R1 admission gate: the firewall a write is forced through before it becomes a
// cell. Sequences the store-free checks and assembles the verdict.
//
//   validate (R0 schema)  -> reject on any structural issue
//   screenSecrets         -> reject if a credential pattern is present
//   attenuateConfidence   -> cap unsupported high confidence
//   buildCell (R0)        -> scaffold the full cell from the attenuated proposal
//   calibrate             -> fold the actor's track record into effective
//
// supportMass / challengeMass are 0 here: those come from a cell's graph
// neighbors, and the store is R2. R1 calibrates on the actor only.

import { validateProposal } from "./schema.js";
import { templateIssues } from "./template.js";
import { screenSecrets, attenuateConfidence } from "./firewall.js";
import { buildCell } from "./build.js";
import { effectiveConfidence } from "./scores.js";
import { neighborMass } from "./mass.js";
import { contentKey } from "./store.js";
import type { AdmissionResult, Store, ValidationIssue, WriteProposal } from "./types.js";

export interface AdmitContext {
  calibrationFactor?: number; // 0.5..1 from R1 calibration; 1 = neutral
  key?: string;
  now?: string;
  store?: Store; // when present, R2 runs dedup, supersede, and real masses
}

export function admit(
  proposal: WriteProposal,
  ctx: AdmitContext = {},
): AdmissionResult {
  const validation = validateProposal(proposal);
  if (!validation.ok) {
    return { accepted: false, issues: validation.issues, warnings: [], attenuations: [] };
  }

  const screen = screenSecrets(proposal);
  if (!screen.allowed) {
    return { accepted: false, issues: screen.issues, warnings: [], attenuations: [] };
  }

  // Fill-or-reject: any field still equal to its template description was never
  // filled. Reject; the Stop hook holds the turn until the template is complete.
  const filled = templateIssues(proposal);
  if (filled.length > 0) {
    return { accepted: false, issues: filled, warnings: [], attenuations: [] };
  }

  const factor = ctx.calibrationFactor ?? 1;
  if (!Number.isFinite(factor) || factor < 0.5 || factor > 1) {
    return {
      accepted: false,
      issues: [{ path: "calibrationFactor", message: "calibrationFactor must be in [0.5, 1]" }],
      warnings: [],
      attenuations: [],
    };
  }

  const att = attenuateConfidence(proposal);

  const cell = buildCell(
    { ...proposal, confidence: att.confidence },
    { key: ctx.key, now: ctx.now },
  );

  cell.scores.actorCalibration = factor;
  cell.scores.effective = effectiveConfidence({
    stated: att.confidence,
    calibration: factor,
    supportMass: 0,
    challengeMass: 0,
  });

  const attenuations = [...att.attenuations];
  if (factor < 1) {
    attenuations.push(
      `calibration x${factor.toFixed(2)} -> effective ${cell.scores.effective.toFixed(2)}`,
    );
  }

  // R2: with a store, run the relational layer. Without one, behaves as R1.
  if (ctx.store) {
    const store = ctx.store;

    // Every edge target must resolve to a cell (the new cell counts; its own key
    // is not stored yet at check time). A dangling evidence target is rejected
    // here, not silently dropped, so it cannot leave the trust surface inert.
    const unresolved: ValidationIssue[] = [];
    cell.edgesOut.forEach((e, i) => {
      if (e.target === cell.key) return;
      if (store.get(e.target) || store.getByHandle(e.target)) return;
      unresolved.push({
        path: `edges[${i}].target`,
        message: `edge target does not resolve to a cell: ${e.target}`,
      });
    });
    if (unresolved.length > 0) {
      return { accepted: false, issues: unresolved, warnings: att.warnings, attenuations };
    }

    // Dedup: an identical active cell (same kind+title+body) is a no-op.
    const dup = store.findByContentKey(cell.kind, contentKey(cell.kind, cell.title));
    if (dup && dup.body === cell.body) {
      return {
        accepted: true,
        cell: dup,
        issues: [],
        warnings: [...att.warnings, "deduplicated: identical active cell exists"],
        attenuations,
      };
    }

    store.put(cell); // store first so the new cell's edges exist for the walks

    // Supersede: an explicit supersedes edge demotes its target and extends lineage.
    for (const e of cell.edgesOut) {
      if (e.relation !== "supersedes") continue;
      const t = store.get(e.target);
      if (t && t.status === "active") {
        t.status = "superseded";
        store.put(t);
        if (!cell.lineage.includes(t.key)) cell.lineage.unshift(t.key);
      }
    }

    // Recompute every evidential target's effective: contradiction pressure
    // sinks them, corroboration lifts them, now that this cell points at them.
    for (const e of cell.edgesOut) {
      if (e.weight === 0) continue;
      const t = store.get(e.target);
      if (!t) continue;
      const m = neighborMass(store, t.key);
      t.scores.effective = effectiveConfidence({
        stated: t.scores.conf,
        calibration: t.scores.actorCalibration,
        supportMass: m.supportMass,
        challengeMass: m.challengeMass,
      });
      store.put(t);
    }

    // The new cell's own effective from any pre-existing incoming edges (0 for a
    // fresh key, so this matches R1 for a brand-new cell).
    const mSelf = neighborMass(store, cell.key);
    cell.scores.effective = effectiveConfidence({
      stated: att.confidence,
      calibration: factor,
      supportMass: mSelf.supportMass,
      challengeMass: mSelf.challengeMass,
    });
    store.put(cell);
  }

  return {
    accepted: true,
    cell,
    issues: [],
    warnings: att.warnings,
    attenuations,
  };
}
