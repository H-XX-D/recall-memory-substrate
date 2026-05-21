export const WRITE_SCHEMA_VERSION = "recall.write.v1" as const;

export const NODE_KINDS = [
  "observation",
  "witness",
  "belief",
  "contradiction",
  "task",
  "objective",
  "decision",
  "risk",
  "constraint",
  "artifact",
  "source",
  "program",
  "eval_run",
  "context_packet",
  "work_candidate",
  "proxy_score",
  "verification_result",
  "blind_lock",
  "allocation_plan",
  "miss"
] as const;

export const RELATION_KINDS = [
  "supports",
  "contradicts",
  "concerns",
  "depends_on",
  "derived_from",
  "supersedes",
  "belongs_to",
  "mentions",
  "executes",
  "emits",
  "invalidates"
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type RelationKind = (typeof RELATION_KINDS)[number];

export type ActorKind = "llm" | "human" | "daemon" | "adapter" | "program";
export type IntentKind =
  | "observation"
  | "witness"
  | "belief_update"
  | "task"
  | "decision"
  | "risk"
  | "constraint"
  | "program"
  | "relation";
export type IntentOperation = "create" | "update" | "supersede" | "link" | "archive";
export type SourceQuality = "unknown" | "low" | "medium" | "high";
export type Stability = "ephemeral" | "volatile" | "stable";
export type ProvenanceOrigin = "human" | "llm" | "daemon" | "adapter" | "program" | "external";
export type Verification = "unverified" | "checked" | "tested" | "external";
export type SignatureStatus = "unsigned" | "signed" | "verified";
export type Sensitivity = "public" | "private" | "secret";

export interface Actor {
  kind: ActorKind;
  id: string;
  display?: string;
}

export interface Intent {
  kind: IntentKind;
  operation: IntentOperation;
}

export interface ProposalContent {
  title: string;
  body: string;
  summary?: string;
}

export interface ProposalScope {
  project: string;
  path?: string;
  tenant: string;
  session?: string;
}

export interface ProposalTags {
  category?: string[];
  type?: string[];
  subject?: string[];
  project?: string[];
  idea?: string[];
  timestamp?: string[];
  topics: string[];
  entities: string[];
  identities?: string[];
  rings: string[];
  lifecycle: string[];
  quality: string[];
  sensitivity?: string[];
  permission?: string[];
}

export interface ProposalEvidence {
  source_refs: string[];
  depends_on: string[];
  supports: string[];
  contradicts: string[];
  concerns: string[];
}

export interface ProposalConfidence {
  value: number;
  uncertainty: number;
  concern: number;
  source_quality: SourceQuality;
  stability: Stability;
}

export interface ProposalProvenance {
  created_at: string;
  origin: ProvenanceOrigin;
  produced_by: string;
  verification: Verification;
  signature_status: SignatureStatus;
}

export interface ProposalPolicy {
  sensitivity: Sensitivity;
  allow_background_use: boolean;
  requires_review: boolean;
  expires_at: string | null;
  reverify_after: string | null;
}

export interface WriteProposal {
  schema_version: typeof WRITE_SCHEMA_VERSION;
  actor: Actor;
  intent: Intent;
  content: ProposalContent;
  scope: ProposalScope;
  tags: ProposalTags;
  evidence: ProposalEvidence;
  confidence: ProposalConfidence;
  provenance: ProposalProvenance;
  policy: ProposalPolicy;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export interface RecallNode {
  id: string;
  cellAddress: string;
  kind: NodeKind;
  title: string;
  body: string;
  summary?: string;
  scope: ProposalScope;
  tags: ProposalTags;
  data: Record<string, unknown>;
  provenance: ProposalProvenance;
  createdAt: string;
  updatedAt: string;
  status: "active" | "superseded" | "archived";
}

export interface RecallRelation {
  id: string;
  kind: RelationKind;
  sourceId: string;
  targetId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RollbackEntry {
  id: string;
  action: "insert_node" | "update_node" | "insert_relation";
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface AdmissionResult {
  accepted: boolean;
  duplicateOf?: string;
  node?: RecallNode;
  relations: RecallRelation[];
  rollbackEntries: RollbackEntry[];
  issues: ValidationIssue[];
  warnings: string[];
  attenuations: string[];
}

export interface StoreStats {
  nodes: number;
  relations: number;
  rollbackEntries: number;
  hyperedges?: number;
  programs?: number;
  dagOverlays?: number;
  evalRuns?: number;
}

export interface HyperedgeMember {
  nodeId: string;
  role: string;
  ordinal?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredHyperedgeMember extends HyperedgeMember {
  ordinal: number;
}

export interface Hyperedge {
  id: string;
  kind: string;
  title: string;
  members: StoredHyperedgeMember[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface HyperedgeProgramSpec {
  schemaVersion: "recall.program.v1";
  operation: "score" | "emit_witness" | "tag_projection";
  description?: string;
  params?: Record<string, unknown>;
}

export interface HyperedgeProgram {
  id: string;
  hyperedgeId: string;
  spec: HyperedgeProgramSpec;
  enabled: boolean;
  createdAt: string;
}

export interface ProgramRun {
  id: string;
  programId: string;
  hyperedgeId: string;
  output: Record<string, unknown>;
  createdAt: string;
}

export interface DagOverlayEdge {
  from: string;
  to: string;
  label?: string;
  weight?: number;
}

export interface DagOverlay {
  id: string;
  title: string;
  nodeIds: string[];
  edges: DagOverlayEdge[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DagHolonomyWitness {
  from: string;
  to: string;
  pathCount: number;
  signatures: string[];
  concern: number;
}

export interface DagAnalysis {
  overlayId: string;
  isDag: boolean;
  topologicalOrder: string[];
  cycles: string[][];
  witnesses: DagHolonomyWitness[];
}
