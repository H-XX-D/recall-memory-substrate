import { randomUUID } from "node:crypto";
import { deriveCellAddress } from "./cells.js";
import { reviewFirewall } from "./firewall.js";
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

  const now = (options.now ?? new Date()).toISOString();
  const node = proposalToNode(proposal, now);
  const relations = proposalToRelations(proposal, node.id, now);
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

function proposalToRelations(proposal: WriteProposal, sourceId: string, now: string): RecallRelation[] {
  const relations: RecallRelation[] = [];
  pushRelations(relations, "depends_on", sourceId, proposal.evidence.depends_on, now);
  pushRelations(relations, "supports", sourceId, proposal.evidence.supports, now);
  pushRelations(relations, "contradicts", sourceId, proposal.evidence.contradicts, now);
  pushRelations(relations, "concerns", sourceId, proposal.evidence.concerns, now);
  return relations;
}

function pushRelations(
  relations: RecallRelation[],
  kind: RelationKind,
  sourceId: string,
  targetIds: string[],
  now: string
): void {
  for (const targetId of targetIds) {
    relations.push({
      id: randomUUID(),
      kind,
      sourceId,
      targetId,
      data: {},
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
