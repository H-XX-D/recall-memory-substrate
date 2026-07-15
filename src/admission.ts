// R1 admission gate: the firewall a write is forced through before it becomes a
// cell. Sequences the store-free checks and assembles the verdict.
//
//   validate (R0 schema)  -> reject on any structural issue
//   screenFindings        -> flag credentials (sensitivity: secret) and downgrade exposed public writes
//   attenuateConfidence   -> cap unsupported high confidence
//   buildCell (R0)        -> scaffold the full cell from the attenuated proposal
//   calibrate             -> fold the actor's track record into effective
//
// supportMass / challengeMass are 0 here: those come from a cell's graph
// neighbors, and the store is R2. R1 calibrates on the actor only.

import { validateProposal } from "./schema.js";
import { templateIssues } from "./template.js";
import { screenFindings, attenuateConfidence } from "./firewall.js";
import { buildCell } from "./build.js";
import { effectiveConfidence } from "./scores.js";
import { neighborMass } from "./mass.js";
import { contentKey, SqliteStore } from "./store.js";
import { indexCell } from "./semantic.js";
import type { AdmissionResult, Store, ValidationIssue, WriteProposal } from "./types.js";

export interface AdmitContext {
  calibrationFactor?: number; // 0.5..1 from R1 calibration; 1 = neutral
  key?: string;
  now?: string;
  store?: Store; // when present, R2 runs dedup, supersede, and real masses
  /** Opt-in agent-integrity contract for interactive LLM writes. */
  integrityGate?: boolean;
}

export function admit(
  proposal: WriteProposal,
  ctx: AdmitContext = {},
): AdmissionResult {
  // In integrity mode, inspect the raw envelope before normalization so an
  // explicit null is distinguishable from an omitted primitive. Null means
  // "not applicable" for optional fields and is removed before v5 validation.
  const filled = templateIssues(proposal, {
    requireComplete: ctx.integrityGate === true,
    requireEdge: ctx.integrityGate === true,
  });
  if (filled.length > 0) {
    return { accepted: false, issues: filled, warnings: [], attenuations: [] };
  }
  if (ctx.integrityGate) proposal = normalizeExplicitNulls(proposal);

  const validation = validateProposal(proposal);
  if (!validation.ok) {
    return { accepted: false, issues: validation.issues, warnings: [], attenuations: [] };
  }

  // Credential and personal-data findings flag, never block: this is a local
  // single-user store, and a note ABOUT a key is legitimate memory. Detected
  // secrets force sensitivity: secret; personal data in a public write
  // downgrades it to private. Both are reported as warnings.
  const screen = screenFindings(proposal);
  const screenWarnings: string[] = [];
  if (screen.secrets.length > 0) {
    if (proposal.sensitivity !== "secret") {
      proposal = { ...proposal, sensitivity: "secret" };
      for (const f of screen.secrets) {
        screenWarnings.push(`${f.message} in ${f.path}; cell marked sensitivity: secret`);
      }
    }
  } else if (screen.publicData.length > 0) {
    proposal = { ...proposal, sensitivity: "private" };
    for (const f of screen.publicData) {
      screenWarnings.push(`${f.message} (${f.path}); sensitivity downgraded to private`);
    }
  }

  // Fill-or-reject: any field still equal to its template description was never
  // filled. Reject; the Stop hook holds the turn until the template is complete.
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
  const relWarnings: string[] = [];

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
    // Bundle memberships resolve like edge targets: a program must be an
    // existing prg cell, a hyperedge must already exist. Dangling memberships
    // reject rather than silently dropping, same contract as edges.
    const watchingPrograms: string[] = [];
    (proposal.programs ?? []).forEach((target, i) => {
      const t = store.get(target) ?? store.getByHandle(target);
      if (!t || t.kind !== "prg") {
        unresolved.push({
          path: `programs[${i}]`,
          message: `program target does not resolve to a prg cell: ${target}`,
        });
        return;
      }
      if (!watchingPrograms.includes(t.key)) watchingPrograms.push(t.key);
    });
    (proposal.hyperedges ?? []).forEach((h, i) => {
      if (!store.getHyperedge(h.id)) {
        unresolved.push({
          path: `hyperedges[${i}].id`,
          message: `hyperedge does not exist: ${h.id}`,
        });
      }
    });
    if (unresolved.length > 0) {
      return { accepted: false, issues: unresolved, warnings: [...screenWarnings, ...att.warnings], attenuations };
    }
    cell.programs = watchingPrograms;

    // Dedup: an identical active cell (same kind+title+body) is a no-op.
    const dup = store.findByContentKey(cell.kind, contentKey(cell.kind, cell.title));
    if (dup && dup.body === cell.body) {
      return {
        accepted: true,
        cell: dup,
        issues: [],
        warnings: [...screenWarnings, ...att.warnings, "deduplicated: identical active cell exists"],
        attenuations,
      };
    }

    store.put(cell); // store first so the new cell's edges exist for the walks

    // Join declared hyperedges: append this cell as a member (next ordinal)
    // unless it already belongs. Resolution above guarantees existence.
    for (const h of proposal.hyperedges ?? []) {
      const bundle = store.getHyperedge(h.id)!;
      if (bundle.members.some((m) => m.key === cell.key)) continue;
      const ordinal = bundle.members.reduce((max, m) => Math.max(max, m.ordinal), -1) + 1;
      bundle.members.push({
        key: cell.key,
        role: h.role ?? "member",
        ordinal,
        ...(h.weight !== undefined ? { weight: h.weight } : {}),
      });
      store.putHyperedge(bundle);
    }

    // Supersede: an explicit supersedes edge demotes its target and extends lineage.
    // Targets resolve by key or handle (the validator above accepts both); the
    // stored edge target is normalized to the full key so lineage and any later
    // resolution stay key-canonical.
    for (const e of cell.edgesOut) {
      if (e.relation !== "supersedes") continue;
      const t = store.get(e.target) ?? store.getByHandle(e.target);
      if (!t) continue;
      e.target = t.key;
      if (t.status === "active") {
        t.status = "superseded";
        store.put(t);
        if (!cell.lineage.includes(t.key)) cell.lineage.unshift(t.key);
      }
    }

    // depends_on is inert in the score walks by design, but a dependency that is
    // no longer active means this cell rests on a retracted foundation. Non-blocking
    // warning: the write still stands, the caller is told what it leaned on.
    for (const e of cell.edgesOut) {
      if (e.relation !== "depends_on") continue;
      const t = store.get(e.target) ?? store.getByHandle(e.target);
      if (t && t.status !== "active") {
        relWarnings.push(`depends_on target is ${t.status}: ${t.key}`);
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
    if (store instanceof SqliteStore) {
      indexCell(cell, store);
    }
  }

  return {
    accepted: true,
    cell,
    issues: [],
    warnings: [...screenWarnings, ...att.warnings, ...relWarnings],
    attenuations,
  };
}

function normalizeExplicitNulls(proposal: WriteProposal): WriteProposal {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposal as unknown as Record<string, unknown>)) {
    if (value !== null) normalized[key] = value;
  }
  return normalized as unknown as WriteProposal;
}
