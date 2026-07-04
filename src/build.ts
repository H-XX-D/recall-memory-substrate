// buildCell: the front door. Turns a thin WriteProposal into a full v5 Cell,
// deriving the handle and scaffolding the scores/flags. Assumes the proposal is
// already schema-valid (R1 admission validates, then builds).
import { randomUUID } from "node:crypto";
import {
  type Cell,
  type Edge,
  type Flags,
  HANDLE_HEX_LENGTH,
  KINDS,
  type Kind,
  type Relation,
  type Scores,
  type WriteProposal,
} from "./types.js";

export interface BuildOpts {
  key?: string;
  now?: string;
  owner?: string;
}

const SIGN_BY_RELATION: Record<Relation, number> = {
  supports: 1,
  contradicts: -1,
  concerns: -0.5,
  depends_on: 0,
  supersedes: 0,
  derived_from: 0,
};

export function buildCell(proposal: WriteProposal, opts: BuildOpts = {}): Cell {
  const key = opts.key ?? randomUUID();
  const now = opts.now ?? new Date().toISOString();
  if (!(KINDS as readonly string[]).includes(proposal.kind)) {
    throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence <= 0 || proposal.confidence > 1) {
    throw new Error("confidence must be a finite number in (0, 1]");
  }
  const kind = proposal.kind as Kind;
  const conf = proposal.confidence;
  const project = proposal.project ?? "default";
  const owner = proposal.owner ?? opts.owner ?? "claude-code";

  const scores: Scores = {
    conf,
    uncertainty: proposal.uncertainty ?? round3((1 - conf) * 0.7),
    concern: proposal.concern ?? round3((1 - conf) * 0.3),
    sourceQuality: sourceQuality(conf),
    actorCalibration: 1, // neutral until the actor has a track record
    effective: conf, // no edges yet: clamp01(stated * calibration(1))
    currencyC0: 1,
    currency: 1,
    salienceSeed: 0.5,
    salience: 0.5,
  };

  const flags: Flags = {
    annexed: false,
    locked: false,
    pinned: false,
    requiresReview: false,
    allowBackgroundUse: true,
    ...proposal.flags,
  };

  const edgesOut: Edge[] = (proposal.edges ?? []).map((e) => {
    const relation = e.relation as Relation;
    return {
      relation,
      source: key,
      target: e.target,
      weight: checkedWeight(relation, e.weight),
    };
  });

  return {
    key,
    handle: `${kind}_${shortHex(key)}`,
    kind,
    owner,
    title: proposal.title,
    body: proposal.body,
    summary: proposal.summary,
    ...(proposal.value !== undefined ? { value: proposal.value } : {}),
    scope: { project, tenant: proposal.tenant ?? `local-${project}` },
    scores,
    stability: proposal.stability ?? "stable",
    flags,
    edgesOut,
    sourceRefs: proposal.sourceRefs ?? [],
    lineage: [],
    programs: [],
    provenance: {
      origin: proposal.origin ?? "llm",
      producedBy: owner, // the calibration key; unsigned until a key signs it
      verification: proposal.verification ?? "unverified",
      signatureStatus: "unsigned",
    },
    tags: {
      topics: proposal.topics ?? [],
      entities: proposal.entities ?? [],
      ...(proposal.lifecycle !== undefined ? { lifecycle: proposal.lifecycle } : {}),
      ...(proposal.quality !== undefined ? { quality: proposal.quality } : {}),
      ...(proposal.subject !== undefined ? { subject: proposal.subject } : {}),
    },
    policy: {
      sensitivity: proposal.sensitivity ?? "private",
      expiresAt: proposal.expiresAt ?? null,
      reverifyAfter: proposal.reverifyAfter ?? null,
    },
    props: proposal.props ?? {},
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

function sourceQuality(conf: number): number {
  if (conf >= 0.8) return 1;
  if (conf >= 0.5) return 0.66;
  if (conf > 0) return 0.33;
  return 0;
}

function shortHex(key: string): string {
  const hex = key.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return (hex + "0".repeat(HANDLE_HEX_LENGTH)).slice(0, HANDLE_HEX_LENGTH);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function checkedWeight(relation: Relation, override: number | undefined): number {
  const weight = override ?? SIGN_BY_RELATION[relation];
  if (!Number.isFinite(weight)) throw new Error(`edge weight must be finite: ${weight}`);
  if (relation === "supports" && weight <= 0) throw new Error("supports weight must be positive");
  if ((relation === "contradicts" || relation === "concerns") && weight >= 0) {
    throw new Error(`${relation} weight must be negative`);
  }
  if (
    (relation === "depends_on" || relation === "supersedes" || relation === "derived_from") &&
    weight !== 0
  ) {
    throw new Error(`${relation} weight must be 0`);
  }
  return weight;
}
