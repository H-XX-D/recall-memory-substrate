// Memory health engine (analysis.ts): a MAL reconciliation of the legacy
// health engine. The legacy version scanned payload evidence refs; in MAL,
// edges are the single source of truth, so BeliefPressure reads INCOMING
// links via store.neighbors(belief.key), filtered to active sources with
// relation supports/contradicts/concerns. Pure over the first 1000 active
// cells; analyzeMemory takes no store mutation.
import { stableJson } from "./derivation.js";
import type { Cell, Origin, Provenance, Store, StoreStats, WriteProposal } from "./types.js";

const ANALYZED_POOL_CAP = 1000;

// Local clamp helper, matching the probability() pattern in programs.ts
// (~line 616): Math.max(0, Math.min(1, value)).
function probability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const ORIGIN_TRUST: Record<Origin, number> = {
  external: 1.2,
  human: 1.15,
  daemon: 1.0,
  program: 1.0,
  llm: 0.9,
  connector: 0.8,
};

export function trustMultiplier(p: Provenance): number {
  let value = ORIGIN_TRUST[p.origin];
  if (p.signatureStatus === "verified") value += 0.1;
  if (p.verification === "unverified") value -= 0.12;
  return probability(value);
}

export interface BeliefPressure {
  key: string;
  title: string;
  conf: number;
  uncertainty: number;
  concern: number;
  support: number;
  contradiction: number;
  concernPressure: number;
  evidenceCount: number;
  sourceDiversity: number;
  planningPressure: number;
  recommendation: "trust" | "watch" | "reverify" | "downgrade";
}

export interface StaleFinding {
  key: string;
  title: string;
  reason: string;
  severity: number;
  reverifyAfter?: string | null;
  expiresAt?: string | null;
}

export interface ContradictionFinding {
  sourceKey: string;
  targetKey: string;
  sourceTitle: string;
  targetTitle: string;
  relation: "contradicts" | "concerns";
  severity: number;
}

export interface DanglingEdgeReport {
  total: number;
  byRelation: Record<string, number>;
  worst: { source: string; relation: string; target: string }[];
}

export interface ProvenanceHealth {
  totalCells: number;
  byOrigin: Record<string, number>;
  byProducer: Record<string, number>;
  signedVerifiedCount: number;
  signedVerifiedRatio: number;
  averageTrustMultiplier: number;
  concentrationRisk: number;
}

export interface CriticalWarning {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface MemoryHealthReport {
  createdAt: string;
  stats: StoreStats;
  provenance: ProvenanceHealth;
  beliefs: BeliefPressure[];
  stale: StaleFinding[];
  contradictions: ContradictionFinding[];
  dangling: DanglingEdgeReport;
  criticalWarnings: CriticalWarning[];
  nextActions: string[];
}

// --- BeliefPressure ---

function beliefPressure(store: Store, belief: Cell): BeliefPressure {
  let support = 0;
  let contradiction = 0;
  let concernPressure = 0;
  const producers = new Set<string>();
  let evidenceCount = 0;

  for (const link of store.neighbors(belief.key)) {
    if (link.direction !== "in") continue;
    if (link.cell.status !== "active") continue;
    const relation = link.edge.relation;
    if (relation !== "supports" && relation !== "contradicts" && relation !== "concerns") continue;

    evidenceCount += 1;
    producers.add(link.cell.provenance.producedBy);
    const weight = probability(link.cell.scores.effective * trustMultiplier(link.cell.provenance));
    if (relation === "supports") support += weight;
    else if (relation === "contradicts") contradiction += weight;
    else concernPressure += weight;
  }

  support = round3(support);
  contradiction = round3(contradiction);
  concernPressure = round3(concernPressure);
  const sourceDiversity = evidenceCount === 0 ? 0 : producers.size / evidenceCount;

  const conf = belief.scores.conf;
  const uncertainty = belief.scores.uncertainty;
  const concern = belief.scores.concern;

  let recommendation: BeliefPressure["recommendation"];
  if (contradiction >= 0.8 || conf < 0.35) {
    recommendation = "downgrade";
  } else if (uncertainty >= 0.55 || concernPressure >= 0.8) {
    recommendation = "reverify";
  } else if (uncertainty >= 0.35 || concernPressure >= 0.4) {
    recommendation = "watch";
  } else {
    recommendation = "trust";
  }

  const planningPressure = probability(
    (concern + contradiction * 0.25 + concernPressure * 0.15) * (uncertainty + contradiction * 0.1),
  );

  return {
    key: belief.key,
    title: belief.title,
    conf,
    uncertainty,
    concern,
    support,
    contradiction,
    concernPressure,
    evidenceCount,
    sourceDiversity,
    planningPressure,
    recommendation,
  };
}

// --- StaleFinding ---

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function staleFinding(cell: Cell, now: Date): StaleFinding | undefined {
  const nowMs = now.getTime();
  const ageMs = nowMs - Date.parse(cell.updatedAt);

  if (cell.policy.expiresAt && Date.parse(cell.policy.expiresAt) <= nowMs) {
    return {
      key: cell.key,
      title: cell.title,
      reason: "expired",
      severity: 1,
      reverifyAfter: cell.policy.reverifyAfter,
      expiresAt: cell.policy.expiresAt,
    };
  }
  if (cell.policy.reverifyAfter && Date.parse(cell.policy.reverifyAfter) <= nowMs) {
    return {
      key: cell.key,
      title: cell.title,
      reason: "reverifyAfter elapsed",
      severity: 0.85,
      reverifyAfter: cell.policy.reverifyAfter,
      expiresAt: cell.policy.expiresAt,
    };
  }
  if (cell.stability === "ephemeral" && ageMs > MS_PER_DAY) {
    return {
      key: cell.key,
      title: cell.title,
      reason: "ephemeral older than 1 day",
      severity: 0.7,
      reverifyAfter: cell.policy.reverifyAfter,
      expiresAt: cell.policy.expiresAt,
    };
  }
  if (cell.stability === "volatile" && ageMs > 14 * MS_PER_DAY) {
    return {
      key: cell.key,
      title: cell.title,
      reason: "volatile older than 14 days",
      severity: 0.55,
      reverifyAfter: cell.policy.reverifyAfter,
      expiresAt: cell.policy.expiresAt,
    };
  }
  if (cell.provenance.verification === "unverified" && cell.scores.sourceQuality < 0.4) {
    return {
      key: cell.key,
      title: cell.title,
      reason: "unverified with low source quality",
      severity: 0.45,
      reverifyAfter: cell.policy.reverifyAfter,
      expiresAt: cell.policy.expiresAt,
    };
  }
  return undefined;
}

// --- ContradictionFinding ---

function contradictionFindings(pool: Cell[], byKey: Map<string, Cell>): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  for (const source of pool) {
    for (const edge of source.edgesOut) {
      if (edge.relation !== "contradicts" && edge.relation !== "concerns") continue;
      const target = byKey.get(edge.target);
      if (!target || target.status !== "active") continue;
      const relation = edge.relation;
      const severity =
        relation === "contradicts"
          ? round3(probability(Math.max(source.scores.conf, source.scores.concern || 0.5)))
          : round3(probability(source.scores.concern || 0.4));
      findings.push({
        sourceKey: source.key,
        targetKey: target.key,
        sourceTitle: source.title,
        targetTitle: target.title,
        relation,
        severity,
      });
    }
  }
  return findings;
}

// --- DanglingEdgeReport ---

function danglingEdgeReport(pool: Cell[], store: Store): DanglingEdgeReport {
  const byRelation: Record<string, number> = {};
  const worst: { source: string; relation: string; target: string }[] = [];
  let total = 0;
  for (const cell of pool) {
    for (const edge of cell.edgesOut) {
      if (store.get(edge.target) || store.getByHandle(edge.target)) continue;
      total += 1;
      byRelation[edge.relation] = (byRelation[edge.relation] ?? 0) + 1;
      if (worst.length < 10) {
        worst.push({ source: cell.key, relation: edge.relation, target: edge.target });
      }
    }
  }
  return { total, byRelation, worst };
}

// --- ProvenanceHealth ---

function provenanceHealth(pool: Cell[]): ProvenanceHealth {
  const byOrigin: Record<string, number> = {};
  const byProducer: Record<string, number> = {};
  let signedVerifiedCount = 0;
  let trustSum = 0;

  for (const cell of pool) {
    byOrigin[cell.provenance.origin] = (byOrigin[cell.provenance.origin] ?? 0) + 1;
    byProducer[cell.provenance.producedBy] = (byProducer[cell.provenance.producedBy] ?? 0) + 1;
    if (cell.provenance.signatureStatus === "verified") signedVerifiedCount += 1;
    trustSum += trustMultiplier(cell.provenance);
  }

  const totalCells = pool.length;
  const maxOriginCount = Math.max(0, ...Object.values(byOrigin));
  const maxProducerCount = Math.max(0, ...Object.values(byProducer));
  const maxOriginShare = totalCells === 0 ? 0 : maxOriginCount / totalCells;
  const maxProducerShare = totalCells === 0 ? 0 : maxProducerCount / totalCells;

  return {
    totalCells,
    byOrigin,
    byProducer,
    signedVerifiedCount,
    signedVerifiedRatio: totalCells === 0 ? 0 : signedVerifiedCount / totalCells,
    averageTrustMultiplier: totalCells === 0 ? 0 : trustSum / totalCells,
    concentrationRisk: round3(probability(Math.max(maxOriginShare, maxProducerShare))),
  };
}

// --- CriticalWarning ---

function criticalWarnings(
  provenance: ProvenanceHealth,
  beliefs: BeliefPressure[],
  stale: StaleFinding[],
  contradictions: ContradictionFinding[],
): CriticalWarning[] {
  const warnings: CriticalWarning[] = [];

  if (provenance.signedVerifiedRatio < 0.1) {
    warnings.push({
      code: "low-signed-coverage",
      severity: "info",
      message: `Only ${Math.round(provenance.signedVerifiedRatio * 100)}% of analyzed cells are signed and verified.`,
    });
  }

  const conflicted = beliefs.find((b) => b.support > 0 && b.contradiction > 0);
  if (conflicted) {
    warnings.push({
      code: "active-belief-conflict",
      severity: "warning",
      message: `Belief "${conflicted.title}" (${conflicted.key}) has both support and contradiction pressure.`,
    });
  }

  if (stale.length > 10) {
    warnings.push({
      code: "stale-memory-load",
      severity: "warning",
      message: `${stale.length} cells are stale and due for reverification or pruning.`,
    });
  }

  if (contradictions.length > 10) {
    warnings.push({
      code: "conflict-load",
      severity: "warning",
      message: `${contradictions.length} contradiction/concern edges are active across the analyzed pool.`,
    });
  }

  if (provenance.concentrationRisk >= 0.8 && provenance.totalCells >= 10) {
    warnings.push({
      code: "provenance-concentration",
      severity: "critical",
      message: `Provenance is concentrated: risk ${provenance.concentrationRisk} across ${provenance.totalCells} cells.`,
    });
  }

  return warnings;
}

// --- nextActions ---

function nextActions(
  beliefs: BeliefPressure[],
  stale: StaleFinding[],
  contradictions: ContradictionFinding[],
  dangling: DanglingEdgeReport,
): string[] {
  const actions: string[] = [];

  if (contradictions.length > 0) {
    const worst = contradictions[0]!;
    actions.push(
      `Review ${contradictions.length} contradiction(s), starting with ${worst.sourceTitle} (${worst.sourceKey}) vs ${worst.targetTitle} (${worst.targetKey}).`,
    );
  }

  if (stale.length > 0) {
    const worst = stale[0]!;
    actions.push(
      `Reverify ${stale.length} stale cell(s), starting with ${worst.title} (${worst.key}, severity ${worst.severity}).`,
    );
  }

  const topBelief = beliefs[0];
  if (topBelief && topBelief.recommendation !== "trust") {
    actions.push(
      `Reassess belief "${topBelief.title}" (${topBelief.key}): recommendation is ${topBelief.recommendation}.`,
    );
  }

  if (dangling.total > 0) {
    actions.push(`Prune ${dangling.total} dangling edge(s) whose targets no longer resolve to a cell.`);
  }

  if (actions.length === 0) {
    actions.push("No memory pressure detected: beliefs, staleness, contradictions, and edges are all healthy.");
  }

  return actions;
}

// --- analyzeMemory ---

export function analyzeMemory(store: Store, now: Date = new Date()): MemoryHealthReport {
  const pool = store.active().slice(0, ANALYZED_POOL_CAP);
  const byKey = new Map<string, Cell>();
  for (const cell of pool) byKey.set(cell.key, cell);

  const beliefs = pool
    .filter((cell) => cell.kind === "bel")
    .map((belief) => beliefPressure(store, belief))
    .sort((a, b) => b.planningPressure - a.planningPressure);

  const stale = pool
    .map((cell) => staleFinding(cell, now))
    .filter((finding): finding is StaleFinding => finding !== undefined)
    .sort((a, b) => b.severity - a.severity);

  const contradictions = contradictionFindings(pool, byKey);
  const dangling = danglingEdgeReport(pool, store);
  const provenance = provenanceHealth(pool);
  const warnings = criticalWarnings(provenance, beliefs, stale, contradictions);
  const actions = nextActions(beliefs, stale, contradictions, dangling);

  return {
    createdAt: now.toISOString(),
    stats: store.stats(),
    provenance,
    beliefs,
    stale,
    contradictions,
    dangling,
    criticalWarnings: warnings,
    nextActions: actions,
  };
}

// --- memoryHealthToProposal ---

// Legacy curiosityTargets are deliberately dropped: their only consumer was
// the unported cognitive module.
export function memoryHealthToProposal(
  report: MemoryHealthReport,
  opts: { project?: string; tenant?: string } = {},
): WriteProposal {
  const pressuredCount = report.beliefs.filter((b) => b.recommendation !== "trust").length;
  const title = `Memory health: ${pressuredCount}/${report.stale.length}/${report.contradictions.length} (pressured/stale/conflicts)`;

  const body = stableJson({
    stats: report.stats,
    provenance: report.provenance,
    beliefs: report.beliefs.slice(0, 8),
    stale: report.stale.slice(0, 8),
    contradictions: report.contradictions.slice(0, 8),
    dangling: { total: report.dangling.total, byRelation: report.dangling.byRelation, worst: report.dangling.worst.slice(0, 8) },
    criticalWarnings: report.criticalWarnings.slice(0, 8),
    nextActions: report.nextActions.slice(0, 8),
  });

  const targets: string[] = [];
  for (const finding of report.stale) {
    if (targets.length >= 8) break;
    if (!targets.includes(finding.key)) targets.push(finding.key);
  }
  for (const finding of report.contradictions) {
    if (targets.length >= 8) break;
    if (!targets.includes(finding.targetKey)) targets.push(finding.targetKey);
  }

  const proposal: WriteProposal = {
    kind: "obs",
    title,
    body,
    confidence: 0.78,
    owner: "recall-maintenance",
    origin: "daemon",
    verification: "checked",
    topics: ["maintenance", "memory-health"],
    stability: "volatile",
    edges: targets.map((target) => ({ relation: "concerns", target })),
    project: opts.project,
    tenant: opts.tenant,
  };

  return proposal;
}
