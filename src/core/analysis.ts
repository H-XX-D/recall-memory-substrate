import { calibrationFromNodes, type ActorCalibration } from "./calibration.js";
import { cellReferenceTarget } from "./references.js";
import { WRITE_SCHEMA_VERSION, type ProposalScope, type RecallNode, type StoreStats, type WriteProposal } from "./types.js";
import type { RecallStore } from "./store.js";

export interface BeliefPressure {
  nodeId: string;
  title: string;
  confidence: number;
  uncertainty: number;
  concern: number;
  support: number;
  contradiction: number;
  concernPressure: number;
  evidenceCount: number;
  supportIndependence: number;
  contradictionIndependence: number;
  sourceDiversity: number;
  unknownOriginCount: number;
  weightedSupport: number;
  weightedContradiction: number;
  planningPressure: number;
  recommendation: "trust" | "watch" | "reverify" | "downgrade";
}

export interface StaleMemoryFinding {
  nodeId: string;
  title: string;
  reason: string;
  severity: number;
  reverifyAfter?: string | null;
  expiresAt?: string | null;
}

export interface ContradictionFinding {
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  targetTitle: string;
  severity: number;
  relation: "contradicts" | "concerns";
}

export interface ProvenanceHealth {
  totalWitnesses: number;
  byOrigin: Record<string, number>;
  byProducer: Record<string, number>;
  unknownOriginCount: number;
  unknownOriginRatio: number;
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

export interface CuriosityTarget {
  kind: "belief" | "stale" | "conflict" | "provenance" | "coverage";
  targetId?: string;
  title: string;
  priority: number;
  why: string;
  suggestedAction: string;
}

export interface MemoryHealthReport {
  createdAt: string;
  stats: StoreStats;
  provenance: ProvenanceHealth;
  beliefs: BeliefPressure[];
  stale: StaleMemoryFinding[];
  contradictions: ContradictionFinding[];
  calibration: ActorCalibration[];
  criticalWarnings: CriticalWarning[];
  curiosityTargets: CuriosityTarget[];
  nextActions: string[];
}

export function analyzeMemory(store: RecallStore, now = new Date()): MemoryHealthReport {
  const nodes = store.listNodes(1000).filter((node) => node.status === "active");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const provenance = provenanceHealth(nodes);
  const beliefs = nodes
    .filter((node) => node.kind === "belief")
    .map((belief) => scoreBelief(belief, nodes))
    .sort((a, b) => b.planningPressure - a.planningPressure);
  const stale = nodes
    .flatMap((node) => staleFindings(node, now))
    .sort((a, b) => b.severity - a.severity);
  const contradictions = contradictionFindings(nodes, byId)
    .sort((a, b) => b.severity - a.severity);

  return {
    createdAt: now.toISOString(),
    stats: store.stats(),
    provenance,
    beliefs,
    stale,
    contradictions,
    calibration: calibrationFromNodes(nodes),
    criticalWarnings: criticalWarnings(provenance, beliefs, stale, contradictions),
    curiosityTargets: curiosityTargets(provenance, beliefs, stale, contradictions),
    nextActions: nextActions(provenance, beliefs, stale, contradictions)
  };
}

export function memoryHealthToProposal(
  report: MemoryHealthReport,
  scope: ProposalScope = { project: "Recall", tenant: "local", session: "daemon" }
): WriteProposal {
  const topBeliefs = report.beliefs.slice(0, 8);
  const topStale = report.stale.slice(0, 8);
  const topContradictions = report.contradictions.slice(0, 8);
  const concern = probability(
    Math.max(
      topBeliefs[0]?.planningPressure ?? 0,
      topStale[0]?.severity ?? 0,
      topContradictions[0]?.severity ?? 0
    )
  );

  return {
    schema_version: WRITE_SCHEMA_VERSION,
    actor: {
      kind: "daemon",
      id: "recall-maintenance",
      display: "Recall Maintenance"
    },
    intent: {
      kind: "witness",
      operation: "create"
    },
    content: {
      title: "Recall memory health report",
      summary: `${topBeliefs.length} belief pressures, ${topStale.length} stale findings, ${topContradictions.length} contradiction findings.`,
      body: stableJson({
        kind: "memory_health_report",
        createdAt: report.createdAt,
        stats: report.stats,
        provenance: report.provenance,
        beliefs: topBeliefs,
        stale: topStale,
        contradictions: topContradictions,
        criticalWarnings: report.criticalWarnings,
        curiosityTargets: report.curiosityTargets,
        nextActions: report.nextActions
      })
    },
    scope,
    tags: {
      category: ["runtime"],
      type: ["maintenance_observation", "memory_health"],
      subject: ["daemon", "beliefs", "stale-memory", "contradictions"],
      project: [scope.project],
      idea: ["outside_llm_maintenance", "derivation_closure"],
      timestamp: [report.createdAt.slice(0, 10)],
      topics: ["daemon", "maintenance", "beliefs", "stale-memory", "contradictions"],
      entities: ["Recall"],
      identities: ["daemon:recall", "engine:memory-health"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["source-grounded", "derived"],
      sensitivity: ["public"],
      permission: ["background", "read"]
    },
    evidence: {
      source_refs: ["recall:graph_nodes", "recall:graph_relations", "recall:store.stats"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: [
        ...topStale.map((item) => item.nodeId),
        ...topContradictions.map((item) => item.targetId)
      ]
    },
    confidence: {
      value: 0.78,
      uncertainty: probability(0.15 + concern / 2),
      concern,
      source_quality: "high",
      stability: "volatile"
    },
    provenance: {
      created_at: report.createdAt,
      origin: "daemon",
      produced_by: "recall-maintenance",
      verification: "checked",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "public",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: null
    }
  };
}

function scoreBelief(belief: RecallNode, nodes: RecallNode[]): BeliefPressure {
  const base = confidenceValue(belief);
  const baseUncertainty = confidenceNumber(belief, "uncertainty", 0.25);
  const baseConcern = confidenceNumber(belief, "concern", 0.4);
  let support = 0;
  let contradiction = 0;
  let concernPressure = 0;
  let evidenceCount = 0;
  const supportOrigins = new Set<string>();
  const supportProducers = new Set<string>();
  const contradictionOrigins = new Set<string>();
  const contradictionProducers = new Set<string>();
  let unknownOriginCount = 0;

  for (const node of nodes) {
    const evidence = evidenceRecord(node);
    const origin = provenanceOrigin(node);
    const producer = node.provenance.produced_by || "unknown";
    const weight = probability(confidenceValue(node) * trustMultiplier(node));
    if (targetsCell(evidence.supports, belief.id)) {
      support += weight;
      evidenceCount += 1;
      supportOrigins.add(origin);
      supportProducers.add(producer);
      if (origin === "unknown") {
        unknownOriginCount += 1;
      }
    }
    if (targetsCell(evidence.contradicts, belief.id)) {
      contradiction += weight;
      evidenceCount += 1;
      contradictionOrigins.add(origin);
      contradictionProducers.add(producer);
      if (origin === "unknown") {
        unknownOriginCount += 1;
      }
    }
    if (targetsCell(evidence.concerns, belief.id)) {
      concernPressure += Math.max(weight, confidenceNumber(node, "concern", 0.3));
      evidenceCount += 1;
    }
  }

  const pressure = probability((baseConcern + contradiction * 0.25 + concernPressure * 0.15) * (baseUncertainty + contradiction * 0.1));
  const confidence = probability(base + support * 0.08 - contradiction * 0.18 - concernPressure * 0.1);
  const uncertainty = probability(baseUncertainty + contradiction * 0.1 + concernPressure * 0.06 - support * 0.03);
  const supportIndependence = independenceScore(evidenceCountFor(belief.id, nodes, "supports"), supportOrigins.size, supportProducers.size);
  const contradictionIndependence = independenceScore(evidenceCountFor(belief.id, nodes, "contradicts"), contradictionOrigins.size, contradictionProducers.size);
  const sourceDiversity = evidenceCount === 0
    ? 0
    : probability((supportOrigins.size + contradictionOrigins.size + supportProducers.size + contradictionProducers.size) / (2 * evidenceCount));

  return {
    nodeId: belief.id,
    title: belief.title,
    confidence,
    uncertainty,
    concern: baseConcern,
    support: round(support),
    contradiction: round(contradiction),
    concernPressure: round(concernPressure),
    evidenceCount,
    supportIndependence,
    contradictionIndependence,
    sourceDiversity: round(sourceDiversity),
    unknownOriginCount,
    weightedSupport: round(support),
    weightedContradiction: round(contradiction),
    planningPressure: round(pressure),
    recommendation: recommendation(confidence, uncertainty, contradiction, concernPressure)
  };
}

function staleFindings(node: RecallNode, now: Date): StaleMemoryFinding[] {
  const findings: StaleMemoryFinding[] = [];
  const policy = policyRecord(node);
  const confidence = confidenceRecord(node);
  const ageDays = Math.max(0, (now.getTime() - Date.parse(node.updatedAt)) / 86_400_000);

  if (policy.expires_at && Date.parse(policy.expires_at) <= now.getTime()) {
    findings.push(finding(node, "expired", 1, policy));
  }
  if (policy.reverify_after && Date.parse(policy.reverify_after) <= now.getTime()) {
    findings.push(finding(node, "reverify_after elapsed", 0.85, policy));
  }
  if (confidence.stability === "ephemeral" && ageDays > 1) {
    findings.push(finding(node, "ephemeral memory older than one day", 0.7, policy));
  }
  if (confidence.stability === "volatile" && ageDays > 14) {
    findings.push(finding(node, "volatile memory older than fourteen days", 0.55, policy));
  }
  if (confidence.source_quality === "unknown" || node.provenance.verification === "unverified") {
    findings.push(finding(node, "low-source or unverified memory", 0.45, policy));
  }

  return findings;
}

function contradictionFindings(nodes: RecallNode[], byId: Map<string, RecallNode>): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  for (const node of nodes) {
    const evidence = evidenceRecord(node);
    for (const targetRef of evidence.contradicts) {
      const targetId = cellReferenceTarget(targetRef);
      const target = byId.get(targetId);
      if (target) {
        findings.push({
          sourceId: node.id,
          targetId,
          sourceTitle: node.title,
          targetTitle: target.title,
          severity: round(probability(Math.max(confidenceValue(node), confidenceNumber(node, "concern", 0.5)))),
          relation: "contradicts"
        });
      }
    }
    for (const targetRef of evidence.concerns) {
      const targetId = cellReferenceTarget(targetRef);
      const target = byId.get(targetId);
      if (target) {
        findings.push({
          sourceId: node.id,
          targetId,
          sourceTitle: node.title,
          targetTitle: target.title,
          severity: round(probability(confidenceNumber(node, "concern", 0.4))),
          relation: "concerns"
        });
      }
    }
  }
  return findings;
}

function provenanceHealth(nodes: RecallNode[]): ProvenanceHealth {
  const witnesses = nodes.filter((node) => node.kind === "witness");
  const byOrigin: Record<string, number> = {};
  const byProducer: Record<string, number> = {};
  let signedVerifiedCount = 0;
  let trustTotal = 0;

  for (const witness of witnesses) {
    const origin = provenanceOrigin(witness);
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
    byProducer[witness.provenance.produced_by] = (byProducer[witness.provenance.produced_by] ?? 0) + 1;
    if (witness.provenance.signature_status === "verified") {
      signedVerifiedCount += 1;
    }
    trustTotal += trustMultiplier(witness);
  }

  const totalWitnesses = witnesses.length;
  const unknownOriginCount = byOrigin.unknown ?? 0;
  const maxOriginShare = totalWitnesses === 0 ? 0 : Math.max(...Object.values(byOrigin), 0) / totalWitnesses;
  const maxProducerShare = totalWitnesses === 0 ? 0 : Math.max(...Object.values(byProducer), 0) / totalWitnesses;
  return {
    totalWitnesses,
    byOrigin: sortRecord(byOrigin),
    byProducer: sortRecord(byProducer),
    unknownOriginCount,
    unknownOriginRatio: round(totalWitnesses === 0 ? 0 : unknownOriginCount / totalWitnesses),
    signedVerifiedCount,
    signedVerifiedRatio: round(totalWitnesses === 0 ? 0 : signedVerifiedCount / totalWitnesses),
    averageTrustMultiplier: round(totalWitnesses === 0 ? 0 : trustTotal / totalWitnesses),
    concentrationRisk: round(probability(Math.max(maxOriginShare, maxProducerShare)))
  };
}

function criticalWarnings(
  provenance: ProvenanceHealth,
  beliefs: BeliefPressure[],
  stale: StaleMemoryFinding[],
  contradictions: ContradictionFinding[]
): CriticalWarning[] {
  const warnings: CriticalWarning[] = [];
  if (provenance.totalWitnesses >= 10 && provenance.unknownOriginRatio >= 0.4) {
    warnings.push({
      code: "provenance-strain",
      severity: "critical",
      message: `${provenance.unknownOriginCount}/${provenance.totalWitnesses} witness cells have unknown origin.`
    });
  }
  if (provenance.totalWitnesses >= 10 && provenance.signedVerifiedRatio < 0.1) {
    warnings.push({
      code: "low-signed-coverage",
      severity: "warning",
      message: `${provenance.signedVerifiedCount}/${provenance.totalWitnesses} witness cells are signature-verified.`
    });
  }
  for (const belief of beliefs.slice(0, 6)) {
    if (belief.confidence >= 0.8 && belief.supportIndependence < 0.35 && belief.evidenceCount >= 3) {
      warnings.push({
        code: "weak-support-independence",
        severity: "warning",
        message: `${belief.title} has high confidence with weak independent support.`
      });
    }
    if (belief.weightedContradiction > 0 && belief.weightedSupport > 0) {
      warnings.push({
        code: "active-belief-conflict",
        severity: "warning",
        message: `${belief.title} has both supporting and contradicting evidence.`
      });
    }
  }
  if (stale.length > 10) {
    warnings.push({
      code: "stale-memory-load",
      severity: "warning",
      message: `${stale.length} active cells are stale, expired, or low-trust.`
    });
  }
  if (contradictions.length > 10) {
    warnings.push({
      code: "conflict-load",
      severity: "warning",
      message: `${contradictions.length} contradiction/concern relations need triage.`
    });
  }
  return warnings;
}

function curiosityTargets(
  provenance: ProvenanceHealth,
  beliefs: BeliefPressure[],
  stale: StaleMemoryFinding[],
  contradictions: ContradictionFinding[]
): CuriosityTarget[] {
  const targets: CuriosityTarget[] = [];
  for (const belief of beliefs.filter((item) => item.recommendation !== "trust").slice(0, 5)) {
    targets.push({
      kind: "belief",
      targetId: belief.nodeId,
      title: belief.title,
      priority: round(belief.planningPressure),
      why: `belief recommendation is ${belief.recommendation}; uncertainty=${belief.uncertainty}, contradiction=${belief.weightedContradiction}`,
      suggestedAction: "collect independent witness evidence or write a verified belief update"
    });
  }
  for (const conflict of contradictions.slice(0, 5)) {
    targets.push({
      kind: "conflict",
      targetId: conflict.targetId,
      title: conflict.targetTitle,
      priority: conflict.severity,
      why: `${conflict.sourceTitle} ${conflict.relation} this cell`,
      suggestedAction: "resolve, supersede, or add a concern/contradiction witness"
    });
  }
  for (const staleItem of stale.slice(0, 5)) {
    targets.push({
      kind: "stale",
      targetId: staleItem.nodeId,
      title: staleItem.title,
      priority: staleItem.severity,
      why: staleItem.reason,
      suggestedAction: "reverify, supersede, or archive the cell"
    });
  }
  if (provenance.unknownOriginRatio > 0.2) {
    targets.push({
      kind: "provenance",
      title: "Witness provenance repair",
      priority: provenance.unknownOriginRatio,
      why: `${provenance.unknownOriginCount} witness cells have unknown origin`,
      suggestedAction: "backfill provenance or mark legacy witnesses as low-trust"
    });
  }
  if (targets.length === 0) {
    targets.push({
      kind: "coverage",
      title: "Memory graph coverage",
      priority: 0.1,
      why: "no urgent belief, stale, conflict, or provenance pressure detected",
      suggestedAction: "continue normal LLM-managed write-back"
    });
  }
  return targets.sort((a, b) => b.priority - a.priority);
}

function nextActions(
  provenance: ProvenanceHealth,
  beliefs: BeliefPressure[],
  stale: StaleMemoryFinding[],
  contradictions: ContradictionFinding[]
): string[] {
  const actions: string[] = [];
  if (provenance.unknownOriginRatio > 0.2) {
    actions.push(`Repair provenance for ${provenance.unknownOriginCount} unknown-origin witness cell(s).`);
  }
  if (contradictions.length > 0) {
    actions.push(`Review ${contradictions.length} contradiction/concern relation(s), starting with ${contradictions[0]!.targetTitle}.`);
  }
  if (stale.length > 0) {
    actions.push(`Reverify or archive ${stale.length} stale/low-trust memory cell(s), starting with ${stale[0]!.title}.`);
  }
  const pressured = beliefs.find((belief) => belief.recommendation !== "trust");
  if (pressured) {
    actions.push(`Reassess belief "${pressured.title}" because recommendation is ${pressured.recommendation}.`);
  }
  if (actions.length === 0) {
    actions.push("No urgent belief, stale-memory, or contradiction pressure detected.");
  }
  return actions;
}

function evidenceRecord(node: RecallNode): { supports: string[]; contradicts: string[]; concerns: string[] } {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  return {
    supports: stringArray(evidence.supports),
    contradicts: stringArray(evidence.contradicts),
    concerns: stringArray(evidence.concerns)
  };
}

function policyRecord(node: RecallNode): { expires_at?: string | null; reverify_after?: string | null } {
  if (!isRecord(node.data.policy)) {
    return {};
  }
  return {
    expires_at: typeof node.data.policy.expires_at === "string" || node.data.policy.expires_at === null ? node.data.policy.expires_at : undefined,
    reverify_after: typeof node.data.policy.reverify_after === "string" || node.data.policy.reverify_after === null ? node.data.policy.reverify_after : undefined
  };
}

function confidenceRecord(node: RecallNode): Record<string, unknown> {
  return isRecord(node.data.confidence) ? node.data.confidence : {};
}

function confidenceValue(node: RecallNode): number {
  return confidenceNumber(node, "value", 0.5);
}

function evidenceCountFor(nodeId: string, nodes: RecallNode[], relation: "supports" | "contradicts"): number {
  return nodes.filter((node) => targetsCell(evidenceRecord(node)[relation], nodeId)).length;
}

function targetsCell(references: string[], nodeId: string): boolean {
  return references.some((reference) => cellReferenceTarget(reference) === nodeId);
}

function independenceScore(count: number, originCount: number, producerCount: number): number {
  if (count === 0) {
    return 0;
  }
  return round(probability(((originCount + producerCount) / 2) / count));
}

function provenanceOrigin(node: RecallNode): string {
  return node.provenance.origin;
}

function trustMultiplier(node: RecallNode): number {
  const origin = provenanceOrigin(node);
  const sourceQuality = confidenceRecord(node).source_quality;
  const signature = node.provenance.signature_status;
  const verification = node.provenance.verification;
  let multiplier =
    origin === "external" ? 1.2 :
    origin === "human" ? 1.15 :
    origin === "daemon" || origin === "program" ? 1 :
    origin === "llm" ? 0.9 :
    0.7;
  if (sourceQuality === "high") {
    multiplier += 0.08;
  } else if (sourceQuality === "low" || sourceQuality === "unknown") {
    multiplier -= 0.12;
  }
  if (signature === "verified") {
    multiplier += 0.1;
  }
  if (verification === "unverified") {
    multiplier -= 0.12;
  }
  return probability(multiplier);
}

function confidenceNumber(node: RecallNode, key: string, fallback: number): number {
  const value = confidenceRecord(node)[key];
  return typeof value === "number" && Number.isFinite(value) ? probability(value) : fallback;
}

function recommendation(
  confidence: number,
  uncertainty: number,
  contradiction: number,
  concernPressure: number
): BeliefPressure["recommendation"] {
  if (contradiction >= 0.8 || confidence < 0.35) {
    return "downgrade";
  }
  if (uncertainty >= 0.55 || concernPressure >= 0.8) {
    return "reverify";
  }
  if (uncertainty >= 0.35 || concernPressure >= 0.4) {
    return "watch";
  }
  return "trust";
}

function finding(
  node: RecallNode,
  reason: string,
  severity: number,
  policy: { expires_at?: string | null; reverify_after?: string | null }
): StaleMemoryFinding {
  return {
    nodeId: node.id,
    title: node.title,
    reason,
    severity,
    expiresAt: policy.expires_at,
    reverifyAfter: policy.reverify_after
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function probability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
