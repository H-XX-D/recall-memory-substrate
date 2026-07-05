// MAL core types: the v5 cell, its directed signed edges, and the scores legend.
// This is the shared contract every R0 module builds against. Declarations only.

export const KINDS = [
  "dec", "obs", "bel", "tsk", "obj", "rsk", "ref", "ver", "hyp", "prg",
] as const;
export type Kind = (typeof KINDS)[number];
export const HANDLE_HEX_LENGTH = 4;
export const HANDLE_SOFT_LENGTH_CAP = 41;

export const RELATIONS = [
  "supports", "contradicts", "concerns", "depends_on", "supersedes", "derived_from",
] as const;
export type Relation = (typeof RELATIONS)[number];

// The ordered scores legend (positions 0..9, all floats in 0..1 unless noted).
// conf is the immutable stated anchor; effective/currency/salience are derived/live.
export interface Scores {
  conf: number;             // 0 stated anchor (immutable)
  uncertainty: number;      // 1
  concern: number;          // 2
  sourceQuality: number;    // 3
  actorCalibration: number; // 4
  effective: number;        // 5 derived
  currencyC0: number;       // 6 seed
  currency: number;         // 7 live
  salienceSeed: number;     // 8
  salience: number;         // 9 live
}

// The boolean actuators (bits).
export interface Flags {
  annexed: boolean;
  locked: boolean;
  pinned: boolean;
  requiresReview: boolean;
  allowBackgroundUse: boolean;
}

export const STABILITIES = ["ephemeral", "volatile", "stable"] as const;
export type Stability = (typeof STABILITIES)[number];

// A directed, signed edge. weight is signed: supports +, contradicts -, concerns -0.5.
export interface Edge {
  relation: Relation;
  source: string; // a stable key
  target: string; // a stable key
  weight: number;
}

// A single participant in a hyperedge. key is the cell key; role and ordinal
// give the membership meaning and stable order beyond a plain set of keys.
export interface HyperedgeMember {
  key: string;
  role: string;
  ordinal: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

// Rich overlays ported from model-A. Keyed by cell key; orthogonal to cells/edges.
export interface Hyperedge {
  id: string;
  kind: string;
  title: string;
  members: HyperedgeMember[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SemanticVector {
  nodeId: string; // cell key
  backend: string;
  dims: number;
  vector: number[];
  indexedAt: string;
}

export interface DagOverlayEdge {
  source: string;
  target: string;
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

// Provenance: who produced the cell and how trustworthy the production was.
// producedBy is the actor id calibration keys on; signatureStatus is the
// cryptographic-attestation upgrade path (unsigned by default until a key signs).
export const ORIGINS = ["human", "llm", "daemon", "connector", "program", "external"] as const;
export type Origin = (typeof ORIGINS)[number];
export const VERIFICATIONS = ["unverified", "checked", "tested", "external"] as const;
export type Verification = (typeof VERIFICATIONS)[number];
export const SIGNATURE_STATUSES = ["unsigned", "signed", "verified"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];
export const SENSITIVITIES = ["public", "private", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const OPERATIONS = ["create", "update", "supersede", "link", "annex"] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface Provenance {
  origin: Origin;
  producedBy: string; // the actor id; the calibration key, unspoofable once signed
  verification: Verification;
  signatureStatus: SignatureStatus;
}

// Faceted tags: the retrieval surface the push/compile rank and filter on.
// topics + entities are load-bearing; the rest are optional facets.
export interface Tags {
  topics: string[];
  entities: string[];
  lifecycle?: string[];
  quality?: string[];
  subject?: string[];
}

// Policy: governance plus the staleness clocks. expiresAt / reverifyAfter drive
// the staleness reflexes; sensitivity gates scope.
export interface Policy {
  sensitivity: Sensitivity;
  expiresAt: string | null;
  reverifyAfter: string | null;
}

export interface Cell {
  key: string;        // stable internal id (the foreign-key target)
  handle: string;     // kind_hex, snake_case; CAPS handle = immutable cell
  kind: Kind;
  owner: string;
  title: string;
  body: string;
  summary?: string;
  value?: number; // measured numeric reading; supersede chains form its delta series
  scope: { project: string; tenant: string };
  scores: Scores;
  stability: Stability;
  flags: Flags;
  edgesOut: Edge[];
  sourceRefs: string[]; // grounding refs (files/commits); distinct from edges
  lineage: string[];  // supersede chain, newest-first (keys)
  programs: string[]; // R3+ standing program ids watching this cell; R0 defaults empty
  provenance: Provenance;
  tags: Tags;
  policy: Policy;
  props: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // The salience anchor: when this cell was last reinforced by a retrieval. The
  // operator decays salience from this timestamp, distinct from updatedAt (the
  // currency anchor), so a read reinforces attention without refreshing freshness.
  // Absent until the cell is first retrieved; decay then falls back to updatedAt.
  lastSalientAt?: string;
  status: "active" | "superseded" | "annexed";
}

// A thin write proposal: the minimal input an actor supplies. The model fills
// what it has; buildCell defaults the rest. Care stays small, the cell stays rich.
export interface WriteProposal {
  kind: string;
  title: string;
  body: string;
  confidence: number; // (0, 1], required, no default
  owner?: string;
  summary?: string;
  topics?: string[];
  entities?: string[];
  lifecycle?: string[];
  quality?: string[];
  subject?: string[];
  edges?: { relation: string; target: string; weight?: number }[];
  sourceRefs?: string[];
  uncertainty?: number;       // model may state it; else derived from confidence
  concern?: number;           // model may state it; else derived from confidence
  operation?: Operation;      // create | update | supersede | link | annex
  origin?: Origin;            // defaults to "llm"
  verification?: Verification; // defaults to "unverified"
  sensitivity?: Sensitivity;  // defaults to "private"
  expiresAt?: string | null;
  reverifyAfter?: string | null;
  flags?: Partial<Flags>;
  props?: Record<string, unknown>;
  value?: number; // measured numeric reading this cell records
  programs?: string[]; // prg cell keys or handles that should watch this cell
  hyperedges?: { id: string; role?: string; weight?: number }[]; // join existing hyperedges at admit
  project?: string;
  tenant?: string;
  stability?: Stability;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// The gate's verdict on a write (R1).
export interface AdmissionResult {
  accepted: boolean;
  cell?: Cell;
  issues: ValidationIssue[];
  warnings: string[];
  attenuations: string[];
  duplicateOf?: string; // set when deriveAdmit short-circuited on an existing derivation key
}

// One resolved past write by an actor, for calibration.
export interface ActorOutcome {
  confidence: number; // stated confidence at write time
  contradicted: boolean; // did it later attract a resolved contradiction
}

// R2 store contract. Edges are the single source of truth for relations;
// version depth and transitive relatedness are derived by walking, never stored.
// A NeighborLink pairs an incident edge with the cell on its other end.
export interface NeighborLink {
  edge: Edge;
  cell: Cell;
  direction: "out" | "in"; // out: this cell is the edge source; in: the target
}

export type LexicalBackend = "fts5-bm25" | "like" | "federated" | "cosine" | "fused";

export interface SearchHit {
  cell: Cell;
  score: number;
  backend: LexicalBackend;
}

export interface StoreStats {
  cells: number;
  activeCells: number;
  edges: number;
  indexedCells: number;
  lexicalBackend: LexicalBackend;
}

export interface Store {
  put(cell: Cell): void; // insert or replace by key, with the cell's edgesOut
  get(key: string): Cell | undefined;
  getByHandle(handle: string): Cell | undefined;
  all(): Cell[];
  active(): Cell[]; // status === "active"
  neighbors(key: string): NeighborLink[]; // edges incident in either direction
  findByContentKey(kind: Kind, contentKey: string): Cell | undefined; // dedup probe
  search(query: string, opts?: { limit?: number }): SearchHit[];
  lexicalBackend(): LexicalBackend;
  stats(): StoreStats;
  close(): void;
  putSemanticVector(v: SemanticVector): void;
  getSemanticVector(nodeId: string): SemanticVector | undefined;
  listSemanticVectorIds(): string[];
  putHyperedge(h: Hyperedge): void;
  getHyperedge(id: string): Hyperedge | undefined;
  listHyperedges(limit?: number): Hyperedge[];
  hyperedgesForCell(key: string, limit?: number): Hyperedge[];
  putDagOverlay(d: DagOverlay): void;
  getDagOverlay(id: string): DagOverlay | undefined;
  listDagOverlays(limit?: number): DagOverlay[];
}
