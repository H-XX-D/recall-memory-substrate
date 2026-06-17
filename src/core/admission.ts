import { randomUUID } from "node:crypto";
import { deriveCellAddress } from "./cells.js";
import { reviewFirewall } from "./firewall.js";
import { cellReferencePath, cellReferenceTarget, formatCellReference, resolveCellReference } from "./references.js";
import { validateWriteProposal } from "./schema.js";
import type {
  AdmissionResult,
  NodeKind,
  RecallNode,
  RecallRelation,
  RelationKind,
  RollbackEntry,
  ValidationIssue,
  WriteProposal
} from "./types.js";
import type { RecallStore } from "./store.js";

export interface AdmitOptions {
  overrideReview?: boolean;
  now?: Date;
  derivationKey?: string;
}

export function admitWriteProposal(
  input: unknown,
  store: RecallStore,
  options: AdmitOptions = {}
): AdmissionResult {
  const validated = validateWriteProposal(input);
  if (!validated.ok || !validated.value) {
    return rejected(validated.issues);
  }

  const derivationKey = normalizeDerivationKey(options.derivationKey);
  if (derivationKey) {
    const existing = store.getNodeByDerivationKey(derivationKey);
    if (existing) {
      return duplicateAccepted(existing, derivationKey);
    }
  }

  const proposal = cloneProposal(validated.value);
  if (derivationKey) {
    attachDerivationIdentity(proposal, derivationKey);
  }
  const warnings: string[] = [];
  const attenuations: string[] = [];
  const firewall = reviewFirewall(proposal);
  warnings.push(...firewall.warnings);

  if (!firewall.allowed) {
    return rejected(firewall.issues, warnings);
  }

  const reviewIssue = reviewRequired(proposal, options);
  if (reviewIssue) {
    return rejected([reviewIssue], warnings);
  }

  attenuateUnsupportedConfidence(proposal, warnings, attenuations);
  warnOversizedTitle(proposal, warnings);
  warnOversizedBody(proposal, warnings);
  warnNearDuplicate(proposal, store, warnings, derivationKey);
  normalizeEvidenceTargets(proposal, store);

  const now = (options.now ?? new Date()).toISOString();
  const node = proposalToNode(proposal, now);
  const relations = proposalToRelations(proposal, node.id, now, store, warnings);
  const rollbackEntries = rollbackFor(node, relations, now);

  try {
    store.insertAdmittedWrite(node, proposal, relations, rollbackEntries, derivationKey);
  } catch (error) {
    if (derivationKey) {
      const existing = store.getNodeByDerivationKey(derivationKey);
      if (existing) {
        return duplicateAccepted(existing, derivationKey);
      }
    }
    throw error;
  }

  return {
    accepted: true,
    node,
    relations,
    rollbackEntries,
    issues: [],
    warnings,
    attenuations
  };
}

function attachDerivationIdentity(proposal: WriteProposal, derivationKey: string): void {
  const identity = `derivation:${derivationKey}`;
  proposal.tags.identities = [...new Set([...(proposal.tags.identities ?? []), identity])];
}

function reviewRequired(proposal: WriteProposal, options: AdmitOptions): ValidationIssue | null {
  if (options.overrideReview) {
    return null;
  }
  if (proposal.policy.requires_review) {
    return {
      path: "policy.requires_review",
      code: "requires_review",
      message: "write proposal requires explicit review override"
    };
  }
  if (proposal.intent.kind === "program") {
    return {
      path: "intent.kind",
      code: "program_requires_review",
      message: "program writes require explicit review override"
    };
  }
  if (proposal.intent.kind === "belief_update" && proposal.confidence.concern >= 0.8) {
    return {
      path: "confidence.concern",
      code: "high_concern_requires_review",
      message: "high-concern belief updates require explicit review override"
    };
  }
  return null;
}

// Near-duplicate cells silt the graph: ranking splits across copies and
// supersedure never happens. Warn (never reject) on fresh creates only —
// derived writes (derivationKey) have their own exact-dedup path, and
// update/supersede/link/archive operations intentionally touch existing cells.
const NEAR_DUP_TITLE_JACCARD = 0.6;
const NEAR_DUP_CONTENT_COSINE = 0.9;

function warnNearDuplicate(
  proposal: WriteProposal,
  store: RecallStore,
  warnings: string[],
  derivationKey?: string
): void {
  if (derivationKey || proposal.intent.operation !== "create" || !store.similarActiveCells) {
    return;
  }
  const [closest] = store.similarActiveCells(proposal.content.title, proposal.content.body, 1);
  if (!closest) {
    return;
  }
  if (closest.titleJaccard >= NEAR_DUP_TITLE_JACCARD || closest.contentCosine >= NEAR_DUP_CONTENT_COSINE) {
    const excerpt = closest.node.title.split(/\s+/).slice(0, 12).join(" ");
    warnings.push(
      `similar to existing cell ${closest.node.id} ("${excerpt}"; titleJaccard=${closest.titleJaccard.toFixed(2)}, contentCosine=${closest.contentCosine.toFixed(2)}); consider operation=update/supersede or referencing it instead of duplicating`
    );
  }
}

// Long titles get echoed across compile packets and dominate title-weighted
// ranking, so they cost every future read. Warn, never reject: extractors and
// older agents must keep working.
const TITLE_WORD_LIMIT = 20;
// A single oversized body inflates every compile packet that references the cell,
// defeating the bounded-context guarantee. Warn (never reject) above this.
const BODY_WARN_BYTES = 32 * 1024;

function warnOversizedTitle(proposal: WriteProposal, warnings: string[]): void {
  const words = proposal.content.title.trim().split(/\s+/).length;
  if (words > TITLE_WORD_LIMIT) {
    warnings.push(
      `title has ${words} words; titles over ${TITLE_WORD_LIMIT} bloat compile packets and weaken ranking — move detail into body or summary`
    );
  }
}

function warnOversizedBody(proposal: WriteProposal, warnings: string[]): void {
  const bytes = Buffer.byteLength(proposal.content.body ?? "", "utf8");
  if (bytes > BODY_WARN_BYTES) {
    warnings.push(
      `body is ${Math.round(bytes / 1024)}KB; bodies over ${BODY_WARN_BYTES / 1024}KB bloat every compile packet that references this cell — split it or move detail to a linked source`
    );
  }
}

function attenuateUnsupportedConfidence(
  proposal: WriteProposal,
  warnings: string[],
  attenuations: string[]
): void {
  const evidenceCount =
    proposal.evidence.source_refs.length +
    proposal.evidence.supports.length +
    proposal.evidence.contradicts.length +
    proposal.evidence.concerns.length;

  const weakSupport =
    proposal.provenance.verification === "unverified" ||
    proposal.confidence.source_quality === "unknown" ||
    evidenceCount === 0;

  if (weakSupport && proposal.confidence.value > 0.7) {
    const oldValue = proposal.confidence.value;
    proposal.confidence.value = 0.7;
    warnings.push("unsupported high confidence was attenuated");
    attenuations.push(`confidence.value ${oldValue.toFixed(2)} -> ${proposal.confidence.value.toFixed(2)}`);
  }
}

function normalizeEvidenceTargets(proposal: WriteProposal, store: RecallStore): void {
  proposal.evidence.depends_on = proposal.evidence.depends_on.map((target) => normalizeTarget(target, store));
  proposal.evidence.supports = proposal.evidence.supports.map((target) => normalizeTarget(target, store));
  proposal.evidence.contradicts = proposal.evidence.contradicts.map((target) => normalizeTarget(target, store));
  proposal.evidence.concerns = proposal.evidence.concerns.map((target) => normalizeTarget(target, store));
}

function normalizeTarget(target: string, store: RecallStore): string {
  const resolved = resolveCellReference(
    target,
    (id) => store.getNode(id),
    (address) => store.getNodeByAddress(address)
  );
  if (resolved.node) {
    return resolved.canonical;
  }
  // Resolution miss: try unique id-prefix expansion. A truncated id (e.g. an
  // 8-char prefix written where a full UUID belongs, a common write-path slip)
  // would otherwise dangle and stay invisible to effective-confidence reads.
  const bare = cellReferenceTarget(target);
  if (looksLikeIdPrefix(bare)) {
    const byPrefix = store.getNodeByPrefix(bare);
    if (byPrefix) {
      return formatCellReference(byPrefix.id, cellReferencePath(target));
    }
  }
  return resolved.canonical;
}

function looksLikeIdPrefix(value: string): boolean {
  return value.length >= 6 && value.length < 36 && /^[0-9a-fA-F]+$/.test(value);
}

function proposalToNode(proposal: WriteProposal, now: string): RecallNode {
  const id = randomUUID();
  return {
    id,
    cellAddress: deriveCellAddress(proposal, id),
    kind: intentToNodeKind(proposal.intent.kind),
    title: proposal.content.title,
    body: proposal.content.body,
    summary: proposal.content.summary,
    scope: proposal.scope,
    tags: proposal.tags,
    data: {
      intent: proposal.intent,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
      policy: proposal.policy
    },
    provenance: proposal.provenance,
    createdAt: now,
    updatedAt: now,
    status: "active"
  };
}

const TRUST_RELATION_KINDS: ReadonlySet<RelationKind> = new Set(["supports", "contradicts", "concerns"]);

function proposalToRelations(
  proposal: WriteProposal,
  sourceId: string,
  now: string,
  store: RecallStore,
  warnings: string[]
): RecallRelation[] {
  const relations: RecallRelation[] = [];
  pushRelations(relations, "depends_on", sourceId, proposal.evidence.depends_on, now, store, warnings);
  pushRelations(relations, "supports", sourceId, proposal.evidence.supports, now, store, warnings);
  pushRelations(relations, "contradicts", sourceId, proposal.evidence.contradicts, now, store, warnings);
  pushRelations(relations, "concerns", sourceId, proposal.evidence.concerns, now, store, warnings);
  return relations;
}

function pushRelations(
  relations: RecallRelation[],
  kind: RelationKind,
  sourceId: string,
  targetIds: string[],
  now: string,
  store: RecallStore,
  warnings: string[]
): void {
  for (const targetId of targetIds) {
    const targetPath = cellReferencePath(targetId);
    const resolvedId = cellReferenceTarget(targetId);
    // Trust-bearing edges (supports/contradicts/concerns) feed effective
    // confidence; a target that resolves to no node is inert pollution that
    // silently distorts the graph surface. Drop it and surface a warning
    // rather than materialize a dangling edge. depends_on stays lenient: it is
    // documentary grounding and is never read by the score.
    if (TRUST_RELATION_KINDS.has(kind) && !store.getNode(resolvedId)) {
      const shown = targetId.length > 60 ? `${targetId.slice(0, 57)}...` : targetId;
      warnings.push(`dropped unresolved ${kind} reference: ${shown}`);
      continue;
    }
    relations.push({
      id: randomUUID(),
      kind,
      sourceId,
      targetId: resolvedId,
      data: targetPath ? { targetPath, targetRef: targetId } : {},
      createdAt: now
    });
  }
}

function rollbackFor(node: RecallNode, relations: RecallRelation[], now: string): RollbackEntry[] {
  return [
    {
      id: randomUUID(),
      action: "insert_node",
      targetId: node.id,
      before: null,
      after: node as unknown as Record<string, unknown>,
      createdAt: now
    },
    ...relations.map((relation) => ({
      id: randomUUID(),
      action: "insert_relation" as const,
      targetId: relation.id,
      before: null,
      after: relation as unknown as Record<string, unknown>,
      createdAt: now
    }))
  ];
}

function intentToNodeKind(kind: WriteProposal["intent"]["kind"]): NodeKind {
  if (kind === "belief_update") {
    return "belief";
  }
  if (kind === "relation") {
    return "observation";
  }
  return kind;
}

function rejected(
  issues: ValidationIssue[],
  warnings: string[] = [],
  attenuations: string[] = []
): AdmissionResult {
  return {
    accepted: false,
    relations: [],
    rollbackEntries: [],
    issues,
    warnings,
    attenuations
  };
}

function duplicateAccepted(node: RecallNode, derivationKey: string): AdmissionResult {
  return {
    accepted: true,
    duplicateOf: node.id,
    node,
    relations: [],
    rollbackEntries: [],
    issues: [],
    warnings: [`derivation key already admitted: ${derivationKey}`],
    attenuations: []
  };
}

function normalizeDerivationKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cloneProposal(proposal: WriteProposal): WriteProposal {
  return JSON.parse(JSON.stringify(proposal)) as WriteProposal;
}
