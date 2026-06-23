// FederatedReadStore: the "global" read-union over the locals (model-A).
//
// Locals are the single source of truth. "global" is not a writable store; it
// is a federated READ-UNION over the home local plus every registered project
// local. Reads fan out across all members; each returned cell keeps its own
// identity but is re-addressed by a graph prefix, e.g. `acme:abc123`. Writes
// always land in a local, so every mutation method here throws.
//
// The trust machinery (supersession, contradiction edges, effective-confidence)
// stays inside each local and never crosses domains. The union never dedups or
// merges trust across graphs; it only concatenates and prefixes. Relations and
// hyperedges are intra-local, so both endpoints of a relation and every node id
// a hyperedge exposes are prefixed with the SAME member graph.

import { existsSync } from "node:fs";
import { SQLiteRecallStore, type RecallStore, type SimilarCell, type SubgraphFilter, type HyperedgeInput, type DagOverlayInput, type OperatorRunInput, type AcpRequestInput, type DerivedProgramRunResult, type DerivedDagAnalysisResult, type DerivedEvalRunResult, type StoredEvalRun } from "./store.js";
import type { FuseOptions, SearchHit } from "./retrieval.js";
import type { SemanticHit } from "./semantic.js";
import type {
  AcpRequest,
  AcpRequestStatus,
  DagAnalysis,
  DagOverlay,
  Hyperedge,
  HyperedgeProgram,
  HyperedgeProgramSpec,
  OperatorRun,
  ProgramRun,
  RecallNode,
  RecallRelation,
  RollbackEntry,
  StoreStats,
  WriteProposal,
} from "./types.js";
import type { RecallEvalResult, RecallEvalSuite } from "./evals.js";

export interface FederatedMember {
  graph: string;
  path: string;
}

interface OpenMember {
  graph: string;
  store: SQLiteRecallStore;
}

const READ_ONLY_MESSAGE =
  "global read-union is read-only; run `recall init` in a project, or write to the home local";

// Slugs and UUIDs contain no ":", so the first colon cleanly separates the
// graph prefix from the bare id. A value with no ":" is treated as bare (graph
// undefined) and the caller routes it to home first, then scans members.
function encode(graph: string, id: string): string {
  return `${graph}:${id}`;
}

function decode(prefixedId: string): { graph?: string; id: string } {
  const idx = prefixedId.indexOf(":");
  if (idx < 0) return { id: prefixedId };
  return { graph: prefixedId.slice(0, idx), id: prefixedId.slice(idx + 1) };
}

export class FederatedReadStore implements RecallStore {
  private readonly members: OpenMember[] = [];
  private readonly byGraph = new Map<string, SQLiteRecallStore>();

  constructor(members: FederatedMember[]) {
    for (const member of members) {
      // A fresh home may have no file yet, and registered projects can point at
      // a local that has not been initialized; skip those rather than letting
      // SQLite create an empty db as a side effect of opening read-union.
      if (!existsSync(member.path)) continue;
      const store = new SQLiteRecallStore(member.path);
      this.members.push({ graph: member.graph, store });
      this.byGraph.set(member.graph, store);
    }
  }

  // ----- prefix-aware node helpers -----

  private prefixNode(graph: string, node: RecallNode): RecallNode {
    return { ...node, id: encode(graph, node.id) };
  }

  // Route a possibly-prefixed id to its member. When the graph is known we go
  // straight there; otherwise we try home first (matches the write-default) and
  // then scan the remaining members in order.
  private routeNode(prefixedId: string): RecallNode | null {
    const { graph, id } = decode(prefixedId);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const node = this.byGraph.get(graph)!.getNode(id);
      return node ? this.prefixNode(graph, node) : null;
    }
    // No (or unknown) graph prefix: scan, home first by member order.
    for (const member of this.members) {
      const node = member.store.getNode(graph !== undefined ? id : prefixedId);
      if (node) return this.prefixNode(member.graph, node);
    }
    return null;
  }

  // ----- READ methods (real, prefixing) -----

  search(query: string, limit = 10, options?: FuseOptions): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const member of this.members) {
      for (const hit of member.store.search(query, limit, options)) {
        hits.push({ ...hit, id: encode(member.graph, hit.id) });
      }
    }
    // Union-ranking policy (deliberate and tunable): each member already ranks
    // with its own lexical+graph+confidence+recency fusion, but those raw
    // scores are not exposed here, so we re-rank the union by the trust signal
    // we DO carry, effectiveConfidence (falling back to stated confidence),
    // then by recency. This keeps a demoted/superseded cell from outranking a
    // current one across graphs without trying to merge per-member lexical
    // scores that were normalized independently. Tune by swapping the key.
    hits.sort(
      (a, b) =>
        confidenceOf(b) - confidenceOf(a) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
    return hits.slice(0, limit);
  }

  getNode(id: string): RecallNode | null {
    return this.routeNode(id);
  }

  getNodeByAddress(address: string): RecallNode | null {
    return this.lookupByValue(address, (store, value) => store.getNodeByAddress(value));
  }

  getNodeByPrefix(prefix: string): RecallNode | null {
    return this.lookupByValue(prefix, (store, value) => store.getNodeByPrefix(value));
  }

  getNodeByDerivationKey(key: string): RecallNode | null {
    return this.lookupByValue(key, (store, value) => store.getNodeByDerivationKey(value));
  }

  // Shared shape for the by-address / by-prefix / by-derivation-key lookups: if
  // the argument is graph-prefixed, route to that member with the bare value;
  // otherwise scan members in order and return the first hit, re-prefixing.
  private lookupByValue(
    value: string,
    lookup: (store: SQLiteRecallStore, value: string) => RecallNode | null,
  ): RecallNode | null {
    const { graph, id } = decode(value);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const node = lookup(this.byGraph.get(graph)!, id);
      return node ? this.prefixNode(graph, node) : null;
    }
    for (const member of this.members) {
      const node = lookup(member.store, value);
      if (node) return this.prefixNode(member.graph, node);
    }
    return null;
  }

  listRelations(nodeId?: string, direction: "in" | "out" | "both" = "both", limit = 100): RecallRelation[] {
    if (nodeId === undefined) {
      // Whole-graph relation dump: union every member, prefixing both endpoints.
      const out: RecallRelation[] = [];
      for (const member of this.members) {
        for (const relation of member.store.listRelations(undefined, direction, limit)) {
          out.push(this.prefixRelation(member.graph, relation));
        }
      }
      return out;
    }
    const { graph, id } = decode(nodeId);
    const member = graph !== undefined ? this.byGraph.get(graph) : undefined;
    if (!member) {
      // Unknown/missing prefix: locate the owning member by scanning.
      for (const candidate of this.members) {
        if (candidate.store.getNode(graph !== undefined ? id : nodeId)) {
          return candidate.store
            .listRelations(graph !== undefined ? id : nodeId, direction, limit)
            .map((relation) => this.prefixRelation(candidate.graph, relation));
        }
      }
      return [];
    }
    return member
      .listRelations(id, direction, limit)
      .map((relation) => this.prefixRelation(graph!, relation));
  }

  private prefixRelation(graph: string, relation: RecallRelation): RecallRelation {
    return {
      ...relation,
      sourceId: encode(graph, relation.sourceId),
      targetId: encode(graph, relation.targetId),
    };
  }

  hyperedgesForNode(nodeId: string, limit = 50): Hyperedge[] {
    const { graph, id } = decode(nodeId);
    const member = graph !== undefined ? this.byGraph.get(graph) : undefined;
    if (!member) {
      for (const candidate of this.members) {
        if (candidate.store.getNode(graph !== undefined ? id : nodeId)) {
          return candidate.store
            .hyperedgesForNode(graph !== undefined ? id : nodeId, limit)
            .map((edge) => this.prefixHyperedge(candidate.graph, edge));
        }
      }
      return [];
    }
    return member.hyperedgesForNode(id, limit).map((edge) => this.prefixHyperedge(graph!, edge));
  }

  private prefixHyperedge(graph: string, edge: Hyperedge): Hyperedge {
    return {
      ...edge,
      id: encode(graph, edge.id),
      members: edge.members.map((m) => ({ ...m, nodeId: encode(graph, m.nodeId) })),
    };
  }

  listPrograms(limit = 20): HyperedgeProgram[] {
    const out: HyperedgeProgram[] = [];
    for (const member of this.members) {
      for (const program of member.store.listPrograms(limit)) {
        // Prefix BOTH program.id AND program.hyperedgeId with the member graph
        // so the compiler's programsByEdge join (program.hyperedgeId vs the ids
        // returned by hyperedgesForNode) lines up across the union.
        out.push({
          ...program,
          id: encode(member.graph, program.id),
          hyperedgeId: encode(member.graph, program.hyperedgeId),
        });
      }
    }
    return out;
  }

  stats(): StoreStats {
    const total: StoreStats = { nodes: 0, relations: 0, rollbackEntries: 0 };
    for (const member of this.members) {
      const s = member.store.stats();
      total.nodes += s.nodes;
      total.relations += s.relations;
      total.rollbackEntries += s.rollbackEntries;
      total.hyperedges = (total.hyperedges ?? 0) + (s.hyperedges ?? 0);
      total.programs = (total.programs ?? 0) + (s.programs ?? 0);
      total.dagOverlays = (total.dagOverlays ?? 0) + (s.dagOverlays ?? 0);
      total.evalRuns = (total.evalRuns ?? 0) + (s.evalRuns ?? 0);
      total.operatorRuns = (total.operatorRuns ?? 0) + (s.operatorRuns ?? 0);
      total.acpRequests = (total.acpRequests ?? 0) + (s.acpRequests ?? 0);
    }
    return total;
  }

  lexicalBackend(): "fts5-bm25" | "like" {
    return this.members[0]?.store.lexicalBackend?.() ?? "fts5-bm25";
  }

  similarActiveCells(title: string, body: string, limit = 5): SimilarCell[] {
    const out: SimilarCell[] = [];
    for (const member of this.members) {
      for (const cell of member.store.similarActiveCells?.(title, body, limit) ?? []) {
        out.push({ ...cell, node: this.prefixNode(member.graph, cell.node) });
      }
    }
    out.sort((a, b) => b.contentCosine - a.contentCosine || b.titleJaccard - a.titleJaccard);
    return out.slice(0, limit);
  }

  semanticSearch(query: string, limit = 10): SemanticHit<RecallNode>[] {
    const out: SemanticHit<RecallNode>[] = [];
    for (const member of this.members) {
      for (const hit of member.store.semanticSearch(query, limit)) {
        out.push({ score: hit.score, item: this.prefixNode(member.graph, hit.item) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  subgraph(filter: SubgraphFilter): RecallNode[] {
    const out: RecallNode[] = [];
    for (const member of this.members) {
      for (const node of member.store.subgraph(filter)) {
        out.push(this.prefixNode(member.graph, node));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = filter.limit ?? out.length;
    return out.slice(0, limit);
  }

  listNodes(limit = 20): RecallNode[] {
    const out: RecallNode[] = [];
    for (const member of this.members) {
      for (const node of member.store.listNodes(limit)) {
        out.push(this.prefixNode(member.graph, node));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out.slice(0, limit);
  }

  listHyperedges(limit = 20): Hyperedge[] {
    const out: Hyperedge[] = [];
    for (const member of this.members) {
      for (const edge of member.store.listHyperedges(limit)) {
        out.push(this.prefixHyperedge(member.graph, edge));
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  getHyperedge(id: string): Hyperedge | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const edge = this.byGraph.get(graph)!.getHyperedge(bare);
      return edge ? this.prefixHyperedge(graph, edge) : null;
    }
    for (const member of this.members) {
      const edge = member.store.getHyperedge(graph !== undefined ? bare : id);
      if (edge) return this.prefixHyperedge(member.graph, edge);
    }
    return null;
  }

  // ----- Low-traffic lookup/list reads: route or union with prefixing -----

  getProgram(id: string): HyperedgeProgram | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const program = this.byGraph.get(graph)!.getProgram(bare);
      return program ? this.prefixProgram(graph, program) : null;
    }
    for (const member of this.members) {
      const program = member.store.getProgram(graph !== undefined ? bare : id);
      if (program) return this.prefixProgram(member.graph, program);
    }
    return null;
  }

  private prefixProgram(graph: string, program: HyperedgeProgram): HyperedgeProgram {
    return {
      ...program,
      id: encode(graph, program.id),
      hyperedgeId: encode(graph, program.hyperedgeId),
    };
  }

  listProgramRuns(limit = 20): ProgramRun[] {
    const out: ProgramRun[] = [];
    for (const member of this.members) {
      for (const run of member.store.listProgramRuns(limit)) {
        out.push(this.prefixProgramRun(member.graph, run));
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  getProgramRun(id: string): ProgramRun | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const run = this.byGraph.get(graph)!.getProgramRun(bare);
      return run ? this.prefixProgramRun(graph, run) : null;
    }
    for (const member of this.members) {
      const run = member.store.getProgramRun(graph !== undefined ? bare : id);
      if (run) return this.prefixProgramRun(member.graph, run);
    }
    return null;
  }

  private prefixProgramRun(graph: string, run: ProgramRun): ProgramRun {
    return {
      ...run,
      id: encode(graph, run.id),
      programId: encode(graph, run.programId),
      hyperedgeId: encode(graph, run.hyperedgeId),
    };
  }

  getDagOverlay(id: string): DagOverlay | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const overlay = this.byGraph.get(graph)!.getDagOverlay(bare);
      return overlay ? this.prefixDagOverlay(graph, overlay) : null;
    }
    for (const member of this.members) {
      const overlay = member.store.getDagOverlay(graph !== undefined ? bare : id);
      if (overlay) return this.prefixDagOverlay(member.graph, overlay);
    }
    return null;
  }

  listDagOverlays(limit = 20): DagOverlay[] {
    const out: DagOverlay[] = [];
    for (const member of this.members) {
      for (const overlay of member.store.listDagOverlays(limit)) {
        out.push(this.prefixDagOverlay(member.graph, overlay));
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  private prefixDagOverlay(graph: string, overlay: DagOverlay): DagOverlay {
    return { ...overlay, id: encode(graph, overlay.id), nodeIds: overlay.nodeIds.map((n) => encode(graph, n)) };
  }

  getEvalRun(id: string): StoredEvalRun | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const run = this.byGraph.get(graph)!.getEvalRun(bare);
      return run ? { ...run, id: encode(graph, run.id) } : null;
    }
    for (const member of this.members) {
      const run = member.store.getEvalRun(graph !== undefined ? bare : id);
      if (run) return { ...run, id: encode(member.graph, run.id) };
    }
    return null;
  }

  listEvalRuns(limit = 20): StoredEvalRun[] {
    const out: StoredEvalRun[] = [];
    for (const member of this.members) {
      for (const run of member.store.listEvalRuns(limit)) {
        out.push({ ...run, id: encode(member.graph, run.id) });
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  getOperatorRun(id: string): OperatorRun | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const run = this.byGraph.get(graph)!.getOperatorRun(bare);
      return run ? { ...run, id: encode(graph, run.id) } : null;
    }
    for (const member of this.members) {
      const run = member.store.getOperatorRun(graph !== undefined ? bare : id);
      if (run) return { ...run, id: encode(member.graph, run.id) };
    }
    return null;
  }

  listOperatorRuns(limit = 20): OperatorRun[] {
    const out: OperatorRun[] = [];
    for (const member of this.members) {
      for (const run of member.store.listOperatorRuns(limit)) {
        out.push({ ...run, id: encode(member.graph, run.id) });
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  getAcpRequest(id: string): AcpRequest | null {
    const { graph, id: bare } = decode(id);
    if (graph !== undefined && this.byGraph.has(graph)) {
      const req = this.byGraph.get(graph)!.getAcpRequest(bare);
      return req ? { ...req, id: encode(graph, req.id) } : null;
    }
    for (const member of this.members) {
      const req = member.store.getAcpRequest(graph !== undefined ? bare : id);
      if (req) return { ...req, id: encode(member.graph, req.id) };
    }
    return null;
  }

  listAcpRequests(limit = 20, status?: AcpRequestStatus): AcpRequest[] {
    const out: AcpRequest[] = [];
    for (const member of this.members) {
      for (const req of member.store.listAcpRequests(limit, status)) {
        out.push({ ...req, id: encode(member.graph, req.id) });
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  listRollback(limit = 20): RollbackEntry[] {
    const out: RollbackEntry[] = [];
    for (const member of this.members) {
      for (const entry of member.store.listRollback(limit)) {
        out.push({ ...entry, id: encode(member.graph, entry.id), targetId: encode(member.graph, entry.targetId) });
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  // ----- WRITE / mutation methods: always throw -----

  insertAdmittedWrite(
    _node: RecallNode,
    _proposal: WriteProposal,
    _relations: RecallRelation[],
    _rollbackEntries: RollbackEntry[],
    _derivationKey?: string,
  ): void {
    throw new Error(READ_ONLY_MESSAGE);
  }

  reindexSemantic(): { indexed: number; backend: string; dims: number } {
    throw new Error(READ_ONLY_MESSAGE);
  }

  compact(): { beforeBytes?: number; afterBytes?: number; semanticReindex: { indexed: number; backend: string; dims: number } } {
    throw new Error(READ_ONLY_MESSAGE);
  }

  applyRollback(_id: string, _apply?: boolean): { id: string; applied: boolean; actions: string[] } {
    throw new Error(READ_ONLY_MESSAGE);
  }

  addHyperedge(_input: HyperedgeInput): Hyperedge {
    throw new Error(READ_ONLY_MESSAGE);
  }

  attachProgram(_hyperedgeId: string, _spec: HyperedgeProgramSpec): HyperedgeProgram {
    throw new Error(READ_ONLY_MESSAGE);
  }

  runProgram(_programId: string): ProgramRun {
    throw new Error(READ_ONLY_MESSAGE);
  }

  runProgramAndDerive(_programId: string): DerivedProgramRunResult {
    throw new Error(READ_ONLY_MESSAGE);
  }

  addDagOverlay(_input: DagOverlayInput): DagOverlay {
    throw new Error(READ_ONLY_MESSAGE);
  }

  analyzeDagOverlay(_id: string): DagAnalysis {
    throw new Error(READ_ONLY_MESSAGE);
  }

  analyzeDagOverlayAndDerive(_id: string): DerivedDagAnalysisResult {
    throw new Error(READ_ONLY_MESSAGE);
  }

  runEval(_suite?: RecallEvalSuite, _now?: Date): RecallEvalResult {
    throw new Error(READ_ONLY_MESSAGE);
  }

  runEvalAndDerive(): DerivedEvalRunResult {
    throw new Error(READ_ONLY_MESSAGE);
  }

  recordOperatorRun(_input: OperatorRunInput): OperatorRun {
    throw new Error(READ_ONLY_MESSAGE);
  }

  enqueueAcpRequest(_input: AcpRequestInput): AcpRequest {
    throw new Error(READ_ONLY_MESSAGE);
  }

  updateAcpRequest(_id: string, _patch: Partial<AcpRequestInput>): AcpRequest {
    throw new Error(READ_ONLY_MESSAGE);
  }

  close(): void {
    for (const member of this.members) {
      member.store.close();
    }
  }
}

// Ranking key for the search union: prefer the read-time effective confidence
// when the member surfaced it (challenged/superseded cells carry a collapsed
// value), else the stated confidence on the cell, else 0.
function confidenceOf(hit: SearchHit): number {
  if (typeof hit.effectiveConfidence === "number") return hit.effectiveConfidence;
  const confidence = hit.data.confidence;
  if (typeof confidence === "object" && confidence !== null && !Array.isArray(confidence)) {
    const value = (confidence as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}
