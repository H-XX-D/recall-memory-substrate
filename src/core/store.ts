import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admitWriteProposal } from "./admission.js";
import { analyzeDagOverlay as analyzeDagOverlayRuntime } from "./dag.js";
import {
  dagAnalysisToKeyedProposals,
  evalResultDerivationKey,
  evalResultToEvalRunProposal,
  programRunDerivationKey,
  programRunToWitnessProposal,
  type DagDerivationProposalOptions,
  type DerivationProposalOptions
} from "./derivation.js";
import { runRecallEval, type RecallEvalResult, type RecallEvalSuite } from "./evals.js";
import { executeHyperedgeProgram, validateProgramSpec } from "./programs.js";
import { resolveCellReference, type ResolvedCellReference } from "./references.js";
import { calibrationFactors, effectiveConfidence } from "./evidence.js";
import { buildFtsMatchQuery, fuseCandidates, searchTerms, type FuseOptions, type LexicalCandidate } from "./retrieval.js";
import { cosine, embedTextRecord, hashEmbedding, textForEmbedding, type SemanticHit } from "./semantic.js";
import type {
  AdmissionResult,
  DagAnalysis,
  DagOverlay,
  AcpRequest,
  AcpRequestAction,
  AcpRequestStatus,
  Hyperedge,
  HyperedgeMember,
  HyperedgeProgram,
  HyperedgeProgramSpec,
  OperatorRun,
  ProgramRun,
  ProposalScope,
  RecallNode,
  RecallRelation,
  RollbackEntry,
  StoreStats,
  WriteProposal
} from "./types.js";

export interface SimilarCell {
  node: RecallNode;
  titleJaccard: number;
  contentCosine: number;
}

export interface SubgraphFilter {
  category?: string[];
  type?: string[];
  subject?: string[];
  project?: string[];
  idea?: string[];
  timestamp?: string[];
  topics?: string[];
  entities?: string[];
  identities?: string[];
  rings?: string[];
  lifecycle?: string[];
  quality?: string[];
  limit?: number;
}

export interface HyperedgeInput {
  id?: string;
  kind: string;
  title: string;
  members: HyperedgeMember[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface DagOverlayInput {
  id?: string;
  title: string;
  nodeIds: string[];
  edges: DagOverlay["edges"];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface DerivedProgramRunResult {
  run: ProgramRun;
  derived: AdmissionResult[];
}

export interface DerivedDagAnalysisResult {
  analysis: DagAnalysis;
  derived: AdmissionResult[];
}

export interface DerivedEvalRunResult {
  result: RecallEvalResult;
  derived: AdmissionResult[];
}

export interface StoredEvalRun {
  id: string;
  name: string;
  result: RecallEvalResult;
  createdAt: string;
}

export interface AcpRequestInput {
  id?: string;
  channel?: string;
  fromAgent: string;
  toAgent: string;
  action: AcpRequestAction;
  payload?: Record<string, unknown>;
  status?: AcpRequestStatus;
  response?: Record<string, unknown> | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  processedAt?: string | null;
}

export interface OperatorRunInput {
  id?: string;
  status: OperatorRun["status"];
  summary: string;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface RecallStore {
  insertAdmittedWrite(
    node: RecallNode,
    proposal: WriteProposal,
    relations: RecallRelation[],
    rollbackEntries: RollbackEntry[],
    derivationKey?: string
  ): void;
  getNodeByDerivationKey(derivationKey: string): RecallNode | null;
  stats(): StoreStats;
  search(query: string, limit?: number, options?: FuseOptions): RecallNode[];
  lexicalBackend?(): "fts5-bm25" | "like";
  similarActiveCells?(title: string, body: string, limit?: number): SimilarCell[];
  semanticSearch(query: string, limit?: number): SemanticHit<RecallNode>[];
  reindexSemantic(): { indexed: number; backend: string; dims: number };
  compact(): { beforeBytes?: number; afterBytes?: number; semanticReindex: { indexed: number; backend: string; dims: number } };
  subgraph(filter: SubgraphFilter): RecallNode[];
  getNode(id: string): RecallNode | null;
  getNodeByAddress(address: string): RecallNode | null;
  getNodeByPrefix(prefix: string): RecallNode | null;
  listRelations(nodeId?: string, direction?: "in" | "out" | "both", limit?: number): RecallRelation[];
  listNodes(limit?: number): RecallNode[];
  listRollback(limit?: number): RollbackEntry[];
  applyRollback(id: string, apply?: boolean): { id: string; applied: boolean; actions: string[] };
  addHyperedge(input: HyperedgeInput): Hyperedge;
  getHyperedge(id: string): Hyperedge | null;
  listHyperedges(limit?: number): Hyperedge[];
  hyperedgesForNode?(nodeId: string, limit?: number): Hyperedge[];
  attachProgram(hyperedgeId: string, spec: HyperedgeProgramSpec): HyperedgeProgram;
  getProgram(id: string): HyperedgeProgram | null;
  listPrograms(limit?: number): HyperedgeProgram[];
  runProgram(programId: string): ProgramRun;
  runProgramAndDerive(programId: string, options?: Partial<DerivationProposalOptions>): DerivedProgramRunResult;
  getProgramRun(id: string): ProgramRun | null;
  listProgramRuns(limit?: number): ProgramRun[];
  addDagOverlay(input: DagOverlayInput): DagOverlay;
  getDagOverlay(id: string): DagOverlay | null;
  listDagOverlays(limit?: number): DagOverlay[];
  analyzeDagOverlay(id: string): DagAnalysis;
  analyzeDagOverlayAndDerive(id: string, options?: Partial<DagDerivationProposalOptions>): DerivedDagAnalysisResult;
  runEval(suite?: RecallEvalSuite, now?: Date): RecallEvalResult;
  runEvalAndDerive(suite?: RecallEvalSuite, options?: Partial<DerivationProposalOptions>, now?: Date): DerivedEvalRunResult;
  getEvalRun(id: string): StoredEvalRun | null;
  listEvalRuns(limit?: number): StoredEvalRun[];
  recordOperatorRun(input: OperatorRunInput): OperatorRun;
  getOperatorRun(id: string): OperatorRun | null;
  listOperatorRuns(limit?: number): OperatorRun[];
  enqueueAcpRequest(input: AcpRequestInput): AcpRequest;
  updateAcpRequest(id: string, patch: Partial<AcpRequestInput>): AcpRequest;
  getAcpRequest(id: string): AcpRequest | null;
  listAcpRequests(limit?: number, status?: AcpRequestStatus): AcpRequest[];
  close(): void;
}

export class SQLiteRecallStore implements RecallStore {
  private readonly db: DatabaseSync;
  private ftsEnabled = false;

  constructor(readonly path: string = ".recall/recall.sqlite3") {
    const dbPath = resolve(path);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // WAL: the same file is shared by CLI invocations, the long-running MCP
    // server, the daemon, and ACP workers; readers must not block writers.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  insertAdmittedWrite(
    node: RecallNode,
    proposal: WriteProposal,
    relations: RecallRelation[],
    rollbackEntries: RollbackEntry[],
    derivationKey?: string
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO graph_nodes
            (id, cell_address, kind, title, body, summary, scope_json, tags_json, data_json, provenance_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          node.id,
          node.cellAddress,
          node.kind,
          node.title,
          node.body,
          node.summary ?? null,
          stringify(node.scope),
          stringify(node.tags),
          stringify(node.data),
          stringify(node.provenance),
          node.status,
          node.createdAt,
          node.updatedAt
        );

      this.db
        .prepare(
          `INSERT INTO write_proposals
            (id, node_id, proposal_json, admitted_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(cryptoRandomId(), node.id, stringify(proposal), node.createdAt);

      const embedding = embedTextRecord(textForEmbedding([node.title, node.body, node.summary ?? "", node.tags]));
      this.db
        .prepare(
          `INSERT INTO semantic_index
            (node_id, backend, dims, vector_json, indexed_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(node.id, embedding.backend, embedding.dims, stringify(embedding.vector), node.createdAt);

      const relationStmt = this.db.prepare(
        `INSERT INTO graph_relations
          (id, kind, source_id, target_id, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const relation of relations) {
        relationStmt.run(
          relation.id,
          relation.kind,
          relation.sourceId,
          relation.targetId,
          stringify(relation.data),
          relation.createdAt
        );
      }

      const rollbackStmt = this.db.prepare(
        `INSERT INTO rollback_journal
          (id, action, target_id, before_json, after_json, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      );
      for (const entry of rollbackEntries) {
        rollbackStmt.run(
          entry.id,
          entry.action,
          entry.targetId,
          entry.before === null ? null : stringify(entry.before),
          stringify(entry.after),
          entry.createdAt
        );
      }

      if (derivationKey) {
        this.db
          .prepare(
            `INSERT INTO derivation_index
              (derivation_key, node_id, created_at)
             VALUES (?, ?, ?)`
          )
          .run(derivationKey, node.id, node.createdAt);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getNodeByDerivationKey(derivationKey: string): RecallNode | null {
    const row = this.db
      .prepare(
        `SELECT n.*
         FROM derivation_index d
         JOIN graph_nodes n ON n.id = d.node_id
         WHERE d.derivation_key = ?
           AND n.status = 'active'
         LIMIT 1`
      )
      .get(derivationKey) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  stats(): StoreStats {
    return {
      nodes: count(this.db, "graph_nodes"),
      relations: count(this.db, "graph_relations"),
      rollbackEntries: count(this.db, "rollback_journal"),
      hyperedges: count(this.db, "hyperedges"),
      programs: count(this.db, "hyperedge_programs"),
      dagOverlays: count(this.db, "dag_overlays"),
      evalRuns: count(this.db, "eval_runs"),
      operatorRuns: count(this.db, "operator_runs"),
      acpRequests: count(this.db, "acp_requests")
    };
  }

  search(query: string, limit = 10, options?: FuseOptions): RecallNode[] {
    const terms = searchTerms(query);
    if (this.ftsEnabled && terms.length > 0) {
      const match = buildFtsMatchQuery(terms);
      if (match) {
        try {
          const candidates = this.lexicalCandidates(match, Math.max(40, limit * 4));
          if (candidates.length > 0) {
            // Effective confidence is computed live per candidate, so ranking
            // always reflects the current graph surface: challenged cells
            // sink, supported cells hold, miscalibrated actors discount.
            const factors = calibrationFactors(this);
            for (const candidate of candidates) {
              candidate.effectiveConfidence =
                effectiveConfidence(this, candidate.node, factors).effective;
            }
            return fuseCandidates(candidates, limit, new Date(), options);
          }
        } catch {
          // A MATCH string FTS5 rejects must degrade to substring search, never throw.
        }
      }
    }
    // The LIKE fallback scores in SQL and ignores kind factors — it only runs
    // when FTS5 is unavailable, where degraded ranking is already accepted.
    return this.searchLike(query, limit);
  }

  lexicalBackend(): "fts5-bm25" | "like" {
    return this.ftsEnabled ? "fts5-bm25" : "like";
  }

  similarActiveCells(title: string, body: string, limit = 5): SimilarCell[] {
    // Candidates come from the lexical index; similarity is computed locally
    // (title token Jaccard + hash-embedding cosine over title+body) so the
    // check stays deterministic and independent of external backends.
    const candidates = this.search(title, Math.max(8, limit));
    if (candidates.length === 0) {
      return [];
    }
    const newTitleTokens = titleTokens(title);
    const newVector = hashEmbedding(`${title}\n${body}`, 256);
    return candidates
      .map((node) => ({
        node,
        titleJaccard: jaccard(newTitleTokens, titleTokens(node.title)),
        contentCosine: cosine(newVector, hashEmbedding(`${node.title}\n${node.body}`, 256))
      }))
      .sort((a, b) => Math.max(b.titleJaccard, b.contentCosine) - Math.max(a.titleJaccard, a.contentCosine))
      .slice(0, limit);
  }

  private lexicalCandidates(match: string, poolSize: number): LexicalCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, f.bm25_score
         FROM (
           SELECT node_id, bm25(graph_nodes_fts, 4.0, 2.5, 2.0, 1.0) AS bm25_score
           FROM graph_nodes_fts
           WHERE graph_nodes_fts MATCH ?
           ORDER BY bm25_score
           LIMIT ?
         ) f
         JOIN graph_nodes n ON n.id = f.node_id
         WHERE n.status = 'active'`
      )
      .all(match, poolSize) as unknown as (NodeRow & { bm25_score: number })[];
    if (rows.length === 0) {
      return [];
    }
    const degrees = this.relationDegrees(rows.map((row) => row.id));
    return rows.map((row) => ({
      node: rowToNode(row),
      bm25: row.bm25_score,
      degree: degrees.get(row.id) ?? 0
    }));
  }

  private relationDegrees(ids: string[]): Map<string, number> {
    const degrees = new Map<string, number>();
    if (ids.length === 0) {
      return degrees;
    }
    const wanted = new Set(ids);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT source_id, target_id FROM graph_relations
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
      )
      .all(...ids, ...ids) as unknown as { source_id: string; target_id: string }[];
    for (const row of rows) {
      if (wanted.has(row.source_id)) {
        degrees.set(row.source_id, (degrees.get(row.source_id) ?? 0) + 1);
      }
      if (wanted.has(row.target_id)) {
        degrees.set(row.target_id, (degrees.get(row.target_id) ?? 0) + 1);
      }
    }
    return degrees;
  }

  private searchLike(query: string, limit: number): RecallNode[] {
    const terms = searchTerms(query);
    const effectiveTerms = terms.length > 0 ? terms : [query.trim()].filter(Boolean);
    // Rank by distinct-term coverage weighted by field (title > tags > body) so a
    // cell matching most of the query outranks newer cells matching one ubiquitous
    // term; recency only breaks ties.
    const scoreExpr = effectiveTerms.length > 0
      ? effectiveTerms
          .map(() => "(CASE WHEN title LIKE ? ESCAPE '\\' THEN 3 WHEN tags_json LIKE ? ESCAPE '\\' THEN 2 WHEN body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)")
          .join(" + ")
      : "0";
    const clauses = effectiveTerms
      .map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const likeParams = effectiveTerms.flatMap((term) => {
      const like = `%${escapeLikePattern(term)}%`;
      return [like, like, like];
    });

    const rows = this.db
      .prepare(
        `SELECT *, (${scoreExpr}) AS lexical_score
         FROM graph_nodes
         WHERE status = 'active'
         ${clauses.length > 0 ? `AND (${clauses})` : ""}
         ORDER BY lexical_score DESC, updated_at DESC
         LIMIT ?`
      )
      .all(...likeParams, ...likeParams, limit) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  semanticSearch(query: string, limit = 10): SemanticHit<RecallNode>[] {
    let queryEmbedding = embedTextRecord(query);
    let rows = this.semanticRows(queryEmbedding.backend, queryEmbedding.dims);
    if (rows.length === 0 && queryEmbedding.backend !== "hash:v1") {
      // The configured backend has indexed nothing yet (run `recall compact`
      // to reindex under it); degrade to whatever the hash index knows.
      queryEmbedding = { backend: "hash:v1", dims: 256, vector: hashEmbedding(query, 256) };
      rows = this.semanticRows(queryEmbedding.backend, queryEmbedding.dims);
    }
    return rows
      .map((row) => ({
        item: rowToNode(row),
        score: cosine(queryEmbedding.vector, JSON.parse(row.vector_json) as number[])
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private semanticRows(backend: string, dims: number): SemanticRow[] {
    return this.db
      .prepare(
        `SELECT n.*, s.backend, s.dims, s.vector_json
         FROM graph_nodes n
         JOIN semantic_index s ON s.node_id = n.id
         WHERE n.status = 'active'
         AND s.backend = ?
         AND s.dims = ?`
      )
      .all(backend, dims) as unknown as SemanticRow[];
  }

  reindexSemantic(): { indexed: number; backend: string; dims: number } {
    const rows = this.db.prepare("SELECT * FROM graph_nodes WHERE status = 'active'").all() as unknown as NodeRow[];
    let backend = "hash:v1";
    let dims = 0;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO semantic_index
          (node_id, backend, dims, vector_json, indexed_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const indexedAt = new Date().toISOString();
      for (const row of rows) {
        const node = rowToNode(row);
        const embedding = embedTextRecord(textForEmbedding([node.title, node.body, node.summary ?? "", node.tags]));
        backend = embedding.backend;
        dims = embedding.dims;
        stmt.run(node.id, embedding.backend, embedding.dims, stringify(embedding.vector), indexedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { indexed: rows.length, backend, dims };
  }

  compact(): { beforeBytes?: number; afterBytes?: number; semanticReindex: { indexed: number; backend: string; dims: number } } {
    const dbPath = resolve(this.path);
    const beforeBytes = existsSync(dbPath) ? statSync(dbPath).size : undefined;
    const semanticReindex = this.reindexSemantic();
    this.db.exec("VACUUM");
    const afterBytes = existsSync(dbPath) ? statSync(dbPath).size : undefined;
    return { beforeBytes, afterBytes, semanticReindex };
  }

  subgraph(filter: SubgraphFilter): RecallNode[] {
    const limit = filter.limit ?? 50;
    const families: (keyof Omit<SubgraphFilter, "limit">)[] = [
      "category",
      "type",
      "subject",
      "project",
      "idea",
      "timestamp",
      "topics",
      "entities",
      "identities",
      "rings",
      "lifecycle",
      "quality"
    ];
    const activeFamilies = families.filter((family) => (filter[family]?.length ?? 0) > 0);
    const clauses = activeFamilies.flatMap((family) =>
      filter[family]!.map(() => `tags_json LIKE ? ESCAPE '\\'`)
    );
    // JSON-escape first (quotes match their stored \" form), then LIKE-escape
    // so the added backslashes and any % _ in the value stay literal.
    const params = activeFamilies.flatMap((family) =>
      filter[family]!.map((value) => `%${escapeLikePattern(escapeJsonLikeValue(value))}%`)
    );

    const rows = this.db
      .prepare(
        `SELECT * FROM graph_nodes
         WHERE status = 'active'
         ${clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : ""}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  getNode(id: string): RecallNode | null {
    const row = this.db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodeByAddress(address: string): RecallNode | null {
    const row = this.db.prepare("SELECT * FROM graph_nodes WHERE cell_address = ?").get(address) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodeByPrefix(prefix: string): RecallNode | null {
    // Unique id-prefix resolution. Returns null on no match OR ambiguity (two
    // or more rows), so a short or colliding prefix never resolves to the
    // wrong node — only an unambiguous prefix expands to its full id.
    const rows = this.db
      .prepare("SELECT * FROM graph_nodes WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
      .all(`${escapeLikePattern(prefix)}%`) as unknown as NodeRow[];
    return rows.length === 1 ? rowToNode(rows[0]) : null;
  }

  listRelations(nodeId?: string, direction: "in" | "out" | "both" = "both", limit = 100): RecallRelation[] {
    if (!nodeId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM graph_relations
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(limit) as unknown as RelationRow[];
      return rows.map(rowToRelation);
    }

    const where =
      direction === "in" ? "target_id = ?" :
      direction === "out" ? "source_id = ?" :
      "(source_id = ? OR target_id = ?)";
    const params = direction === "both" ? [nodeId, nodeId, limit] : [nodeId, limit];
    const rows = this.db
      .prepare(
        `SELECT * FROM graph_relations
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params) as unknown as RelationRow[];
    return rows.map(rowToRelation);
  }

  listNodes(limit = 20): RecallNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM graph_nodes
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  listRollback(limit = 20): RollbackEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM rollback_journal
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as RollbackRow[];
    return rows.map(rowToRollback);
  }

  applyRollback(id: string, apply = false): { id: string; applied: boolean; actions: string[] } {
    const row = this.db.prepare("SELECT * FROM rollback_journal WHERE id = ?").get(id) as (RollbackRow & { applied_at: string | null }) | undefined;
    if (!row) {
      throw new Error(`Unknown rollback entry: ${id}`);
    }
    if (row.applied_at) {
      return { id, applied: true, actions: [`already applied at ${row.applied_at}`] };
    }
    const entry = rowToRollback(row);
    const actions = rollbackActions(entry);
    if (!apply) {
      return { id, applied: false, actions };
    }

    this.db.exec("BEGIN");
    try {
      if (entry.action === "insert_node") {
        this.db
          .prepare("UPDATE graph_nodes SET status = 'archived', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), entry.targetId);
        this.db.prepare("DELETE FROM derivation_index WHERE node_id = ?").run(entry.targetId);
        this.db.prepare("DELETE FROM graph_relations WHERE source_id = ? OR target_id = ?").run(entry.targetId, entry.targetId);
      } else if (entry.action === "insert_relation") {
        this.db.prepare("DELETE FROM graph_relations WHERE id = ?").run(entry.targetId);
      } else if (entry.action === "update_node" && entry.before) {
        this.db
          .prepare(
            `UPDATE graph_nodes
             SET title = ?, body = ?, summary = ?, scope_json = ?, tags_json = ?, data_json = ?,
                 provenance_json = ?, status = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            stringValue(entry.before.title),
            stringValue(entry.before.body),
            nullableString(entry.before.summary),
            stringify(entry.before.scope),
            stringify(entry.before.tags),
            stringify(entry.before.data),
            stringify(entry.before.provenance),
            stringValue(entry.before.status),
            new Date().toISOString(),
            entry.targetId
          );
      }
      this.db.prepare("UPDATE rollback_journal SET applied_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, applied: true, actions };
  }

  addHyperedge(input: HyperedgeInput): Hyperedge {
    const now = input.createdAt ?? new Date().toISOString();
    const hyperedge: Hyperedge = {
      id: input.id ?? cryptoRandomId(),
      kind: requireNonEmpty(input.kind, "hyperedge kind"),
      title: requireNonEmpty(input.title, "hyperedge title"),
      members: normalizeMembers(input.members, (reference) => this.resolveReference(reference)),
      metadata: input.metadata ?? {},
      createdAt: now
    };
    this.db
      .prepare(
        `INSERT INTO hyperedges
          (id, kind, title, members_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        hyperedge.id,
        hyperedge.kind,
        hyperedge.title,
        stringify(hyperedge.members),
        stringify(hyperedge.metadata),
        hyperedge.createdAt
      );
    return hyperedge;
  }

  // Resolve a hyperedge/program/run id from either its full id or a unique
  // truncated id-prefix (e.g. the 8-char form shown in listings). Exact id
  // wins; a prefix expands ONLY when exactly one row matches, so a short or
  // colliding prefix resolves to null rather than the wrong row. Mirrors
  // getNodeByPrefix's unique-prefix discipline for cells, so `program run`,
  // `program show`, `program show-run`, and `hyperedge show` accept a prefix
  // the same way cell references do.
  private resolveStoredId(table: "hyperedges" | "hyperedge_programs" | "program_runs" | "eval_runs" | "operator_runs", id: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as { id: string } | undefined;
    if (exact) {
      return exact.id;
    }
    // Only an id-shaped prefix (hex + hyphens, shorter than a full id) is
    // eligible for prefix expansion — never a full-length id that simply
    // does not exist.
    if (id.length < 6 || id.length >= 36 || !/^[0-9a-fA-F-]+$/.test(id)) {
      return null;
    }
    const rows = this.db
      .prepare(`SELECT id FROM ${table} WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(`${escapeLikePattern(id)}%`) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0].id : null;
  }

  getHyperedge(id: string): Hyperedge | null {
    const resolvedId = this.resolveStoredId("hyperedges", id);
    if (!resolvedId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM hyperedges WHERE id = ?").get(resolvedId) as HyperedgeRow | undefined;
    return row ? rowToHyperedge(row) : null;
  }

  listHyperedges(limit = 20): Hyperedge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hyperedges
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as HyperedgeRow[];
    return rows.map(rowToHyperedge);
  }

  hyperedgesForNode(nodeId: string, limit = 50): Hyperedge[] {
    // Membership lives inside members_json; the LIKE prefilter narrows rows,
    // the JS member check makes the match exact.
    const needle = `"nodeId":${JSON.stringify(nodeId)}`;
    const rows = this.db
      .prepare(
        `SELECT * FROM hyperedges
         WHERE members_json LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`%${escapeLikePattern(needle)}%`, limit) as unknown as HyperedgeRow[];
    return rows
      .map(rowToHyperedge)
      .filter((edge) => edge.members.some((member) => member.nodeId === nodeId));
  }

  attachProgram(hyperedgeId: string, spec: HyperedgeProgramSpec): HyperedgeProgram {
    const hyperedge = this.getHyperedge(hyperedgeId);
    if (!hyperedge) {
      throw new Error(`Unknown hyperedge: ${hyperedgeId}`);
    }
    const program: HyperedgeProgram = {
      id: cryptoRandomId(),
      hyperedgeId,
      spec: validateProgramSpec(spec),
      enabled: true,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO hyperedge_programs
          (id, hyperedge_id, spec_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(program.id, program.hyperedgeId, stringify(program.spec), program.enabled ? 1 : 0, program.createdAt);
    return program;
  }

  getProgram(id: string): HyperedgeProgram | null {
    const resolvedId = this.resolveStoredId("hyperedge_programs", id);
    if (!resolvedId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM hyperedge_programs WHERE id = ?").get(resolvedId) as
      | HyperedgeProgramRow
      | undefined;
    return row ? rowToProgram(row) : null;
  }

  listPrograms(limit = 20): HyperedgeProgram[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hyperedge_programs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as HyperedgeProgramRow[];
    return rows.map(rowToProgram);
  }

  runProgram(programId: string): ProgramRun {
    const program = this.getProgram(programId);
    if (!program) {
      throw new Error(`Unknown program: ${programId}`);
    }
    if (!program.enabled) {
      throw new Error(`Program is disabled: ${programId}`);
    }
    const hyperedge = this.getHyperedge(program.hyperedgeId);
    if (!hyperedge) {
      throw new Error(`Unknown hyperedge: ${program.hyperedgeId}`);
    }
    const members = hyperedge.members
      .map((member) => this.getNode(member.nodeId))
      .filter((node): node is RecallNode => node !== null);
    // Price each member from the live graph surface so scored bundles act
    // as tripwires (see ProgramExecutionInput.effectiveConfidence).
    const factors = calibrationFactors(this);
    const effective = new Map(
      members.map((node) => [node.id, effectiveConfidence(this, node, factors).effective])
    );
    // Watch programs baseline against their own last run — history is state.
    // Key on the resolved program.id (not the raw arg, which may be a prefix)
    // so a prefix-invoked run still finds its own history.
    const previousRow = this.db
      .prepare(
        `SELECT * FROM program_runs WHERE program_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(program.id) as ProgramRunRow | undefined;
    const previousRun = previousRow ? rowToProgramRun(previousRow) : null;
    const run = executeHyperedgeProgram({
      program,
      hyperedge,
      members,
      effectiveConfidence: effective,
      previousRun
    });
    this.db
      .prepare(
        `INSERT INTO program_runs
          (id, program_id, hyperedge_id, output_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(run.id, run.programId, run.hyperedgeId, stringify(run.output), run.createdAt);
    return run;
  }

  runProgramAndDerive(programId: string, options: Partial<DerivationProposalOptions> = {}): DerivedProgramRunResult {
    const run = this.runProgram(programId);
    // An untripped reflex derives nothing: silence means verified stability,
    // and a reflex that files paperwork on every quiet tick is alert fatigue.
    const reflexOps = ["watch", "drift"];
    if (reflexOps.includes(run.output.operation as string) && run.output.tripped !== true) {
      return { run, derived: [] };
    }
    const proposal = programRunToWitnessProposal(run, {
      ...options,
      scope: options.scope ?? defaultDerivationScope()
    });
    return {
      run,
      derived: [admitWriteProposal(proposal, this, { derivationKey: programRunDerivationKey(run) })]
    };
  }

  getProgramRun(id: string): ProgramRun | null {
    const resolvedId = this.resolveStoredId("program_runs", id);
    if (!resolvedId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM program_runs WHERE id = ?").get(resolvedId) as ProgramRunRow | undefined;
    return row ? rowToProgramRun(row) : null;
  }

  listProgramRuns(limit = 20): ProgramRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM program_runs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as ProgramRunRow[];
    return rows.map(rowToProgramRun);
  }

  addDagOverlay(input: DagOverlayInput): DagOverlay {
    const overlay: DagOverlay = {
      id: input.id ?? cryptoRandomId(),
      title: requireNonEmpty(input.title, "DAG overlay title"),
      nodeIds: uniqueStrings(input.nodeIds.map((nodeId) => this.resolveReference(nodeId).targetId)),
      edges: input.edges.map((edge) => normalizeDagEdge(edge, (reference) => this.resolveReference(reference).targetId)),
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    const analysis = analyzeDagOverlayRuntime(overlay);
    if (!analysis.isDag) {
      throw new Error(`DAG overlay contains cycles: ${JSON.stringify(analysis.cycles)}`);
    }
    this.db
      .prepare(
        `INSERT INTO dag_overlays
          (id, title, node_ids_json, edges_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        overlay.id,
        overlay.title,
        stringify(overlay.nodeIds),
        stringify(overlay.edges),
        stringify(overlay.metadata),
        overlay.createdAt
      );
    return overlay;
  }

  getDagOverlay(id: string): DagOverlay | null {
    const row = this.db.prepare("SELECT * FROM dag_overlays WHERE id = ?").get(id) as DagOverlayRow | undefined;
    return row ? rowToDagOverlay(row) : null;
  }

  listDagOverlays(limit = 20): DagOverlay[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dag_overlays
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as DagOverlayRow[];
    return rows.map(rowToDagOverlay);
  }

  analyzeDagOverlay(id: string): DagAnalysis {
    const overlay = this.getDagOverlay(id);
    if (!overlay) {
      throw new Error(`Unknown DAG overlay: ${id}`);
    }
    return analyzeDagOverlayRuntime(overlay);
  }

  analyzeDagOverlayAndDerive(id: string, options: Partial<DagDerivationProposalOptions> = {}): DerivedDagAnalysisResult {
    const analysis = this.analyzeDagOverlay(id);
    const proposals = dagAnalysisToKeyedProposals(analysis, {
      ...options,
      scope: options.scope ?? defaultDerivationScope(),
      createdAt: options.createdAt ?? new Date().toISOString()
    });
    return {
      analysis,
      derived: proposals.map(({ proposal, derivationKey }) => admitWriteProposal(proposal, this, { derivationKey }))
    };
  }

  runEval(suite?: RecallEvalSuite, now = new Date()): RecallEvalResult {
    const result = runRecallEval(this, suite, now);
    this.db
      .prepare(
        `INSERT INTO eval_runs
          (id, name, result_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cryptoRandomId(), result.name, stringify(result), result.createdAt);
    return result;
  }

  runEvalAndDerive(suite?: RecallEvalSuite, options: Partial<DerivationProposalOptions> = {}, now = new Date()): DerivedEvalRunResult {
    const result = this.runEval(suite, now);
    const proposal = evalResultToEvalRunProposal(result, {
      ...options,
      scope: options.scope ?? defaultDerivationScope()
    });
    return {
      result,
      derived: [admitWriteProposal(proposal, this, { derivationKey: evalResultDerivationKey(result) })]
    };
  }

  getEvalRun(id: string): StoredEvalRun | null {
    const resolvedId = this.resolveStoredId("eval_runs", id);
    if (!resolvedId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(resolvedId) as EvalRunRow | undefined;
    return row ? rowToEvalRun(row) : null;
  }

  listEvalRuns(limit = 20): StoredEvalRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM eval_runs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as EvalRunRow[];
    return rows.map(rowToEvalRun);
  }

  recordOperatorRun(input: OperatorRunInput): OperatorRun {
    const run: OperatorRun = {
      id: input.id ?? cryptoRandomId(),
      status: input.status,
      summary: input.summary,
      result: input.result,
      createdAt: input.createdAt
    };
    this.db
      .prepare(
        `INSERT INTO operator_runs
          (id, status, summary, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(run.id, run.status, run.summary, stringify(run.result), run.createdAt);
    return run;
  }

  getOperatorRun(id: string): OperatorRun | null {
    const resolvedId = this.resolveStoredId("operator_runs", id);
    if (!resolvedId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM operator_runs WHERE id = ?").get(resolvedId) as OperatorRunRow | undefined;
    return row ? rowToOperatorRun(row) : null;
  }

  listOperatorRuns(limit = 20): OperatorRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM operator_runs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as unknown as OperatorRunRow[];
    return rows.map(rowToOperatorRun);
  }

  enqueueAcpRequest(input: AcpRequestInput): AcpRequest {
    const request: AcpRequest = {
      id: input.id ?? cryptoRandomId(),
      channel: requireNonEmpty(input.channel ?? "inbox", "acp channel"),
      fromAgent: requireNonEmpty(input.fromAgent, "acp fromAgent"),
      toAgent: requireNonEmpty(input.toAgent, "acp toAgent"),
      action: input.action,
      payload: input.payload ?? {},
      status: input.status ?? "queued",
      response: input.response ?? null,
      error: input.error ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      processedAt: input.processedAt ?? null
    };
    this.db
      .prepare(
        `INSERT INTO acp_requests
          (id, channel, from_agent, to_agent, action, payload_json, status, response_json, error_text, created_at, updated_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.id,
        request.channel,
        request.fromAgent,
        request.toAgent,
        request.action,
        stringify(request.payload),
        request.status,
        request.response === null ? null : stringify(request.response),
        request.error,
        request.createdAt,
        request.updatedAt,
        request.processedAt
      );
    return request;
  }

  updateAcpRequest(id: string, patch: Partial<AcpRequestInput>): AcpRequest {
    const current = this.getAcpRequest(id);
    if (!current) {
      throw new Error(`Unknown ACP request: ${id}`);
    }
    const merged: AcpRequest = {
      ...current,
      channel: patch.channel ?? current.channel,
      fromAgent: patch.fromAgent ?? current.fromAgent,
      toAgent: patch.toAgent ?? current.toAgent,
      action: patch.action ?? current.action,
      payload: patch.payload ?? current.payload,
      status: patch.status ?? current.status,
      response: patch.response !== undefined ? patch.response : current.response,
      error: patch.error !== undefined ? patch.error : current.error,
      createdAt: patch.createdAt ?? current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      processedAt: patch.processedAt !== undefined ? patch.processedAt : current.processedAt
    };
    this.db
      .prepare(
        `UPDATE acp_requests
         SET channel = ?, from_agent = ?, to_agent = ?, action = ?, payload_json = ?, status = ?, response_json = ?, error_text = ?, created_at = ?, updated_at = ?, processed_at = ?
         WHERE id = ?`
      )
      .run(
        merged.channel,
        merged.fromAgent,
        merged.toAgent,
        merged.action,
        stringify(merged.payload),
        merged.status,
        merged.response === null ? null : stringify(merged.response),
        merged.error,
        merged.createdAt,
        merged.updatedAt,
        merged.processedAt,
        merged.id
      );
    return merged;
  }

  getAcpRequest(id: string): AcpRequest | null {
    const row = this.db.prepare("SELECT * FROM acp_requests WHERE id = ?").get(id) as AcpRequestRow | undefined;
    return row ? rowToAcpRequest(row) : null;
  }

  listAcpRequests(limit = 20, status?: AcpRequestStatus): AcpRequest[] {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM acp_requests
             WHERE status = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(status, limit) as unknown as AcpRequestRow[])
      : (this.db
          .prepare(
            `SELECT * FROM acp_requests
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit) as unknown as AcpRequestRow[]);
    return rows.map(rowToAcpRequest);
  }

  close(): void {
    this.db.close();
  }

  private resolveReference(reference: string): ResolvedCellReference {
    return resolveCellReference(
      reference,
      (id) => this.getNode(id),
      (address) => this.getNodeByAddress(address),
      (prefix) => this.getNodeByPrefix(prefix)
    );
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        cell_address TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT,
        scope_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_relations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS write_proposals (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        admitted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rollback_journal (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS semantic_index (
        node_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL DEFAULT 'hash:v1',
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hyperedges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        members_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hyperedge_programs (
        id TEXT PRIMARY KEY,
        hyperedge_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS program_runs (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        hyperedge_id TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_overlays (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        node_ids_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS acp_requests (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        processed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS operator_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS derivation_index (
        derivation_key TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_status ON graph_nodes(status);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_updated ON graph_nodes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_source ON graph_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_target ON graph_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_kind ON graph_relations(kind);
      CREATE INDEX IF NOT EXISTS idx_semantic_index_node ON semantic_index(node_id);
      CREATE INDEX IF NOT EXISTS idx_hyperedges_kind ON hyperedges(kind);
      CREATE INDEX IF NOT EXISTS idx_hyperedge_programs_edge ON hyperedge_programs(hyperedge_id);
      CREATE INDEX IF NOT EXISTS idx_program_runs_program ON program_runs(program_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_acp_requests_status ON acp_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_operator_runs_created ON operator_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_derivation_index_node ON derivation_index(node_id);
    `);
    try {
      this.db.exec("ALTER TABLE graph_nodes ADD COLUMN cell_address TEXT;");
    } catch {
      // Existing databases created after the address column already have it.
    }
    try {
      this.db.exec("ALTER TABLE semantic_index ADD COLUMN backend TEXT NOT NULL DEFAULT 'hash:v1';");
    } catch {
      // Existing databases created after backend-aware semantic search already have it.
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_index_backend ON semantic_index(backend, dims);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_cell_address
      ON graph_nodes(cell_address)
      WHERE cell_address IS NOT NULL;
      DELETE FROM acp_requests
      WHERE status = 'queued'
        AND id NOT IN (
          SELECT id FROM acp_requests
          WHERE status = 'queued'
          ORDER BY created_at DESC
          LIMIT 1000
        );
      DELETE FROM derivation_index
      WHERE node_id NOT IN (
        SELECT id FROM graph_nodes WHERE status = 'active'
      );
    `);
    this.ftsEnabled = this.migrateLexicalIndex();
    this.migrateRelationTargets();
  }

  private migrateRelationTargets(): void {
    const update = this.db.prepare("UPDATE graph_relations SET target_id = ? WHERE id = ?");

    // Pass 1: older binaries stored relation targets as recall:// address
    // strings, which made them invisible to every id-keyed lookup (incoming-
    // challenge surfacing, rel in/out counts, search degree prior). Rewrite to
    // bare node ids where the trailing segment resolves.
    const addressRows = this.db
      .prepare("SELECT id, target_id FROM graph_relations WHERE target_id LIKE 'recall://%'")
      .all() as unknown as { id: string; target_id: string }[];
    for (const row of addressRows) {
      const withoutPath = row.target_id.split("#")[0];
      const segments = withoutPath.split("/").filter((segment) => segment.length > 0);
      const candidate = segments[segments.length - 1];
      if (!candidate || candidate === row.target_id) {
        continue;
      }
      const exists = this.db.prepare("SELECT 1 FROM graph_nodes WHERE id = ?").get(candidate);
      if (exists) {
        update.run(candidate, row.id);
        continue;
      }
      // Address form carrying a truncated id-prefix (recall://cell/<8-char>):
      // the trailing segment is a prefix, not a full id, so the exact match
      // above misses AND Pass 2 skips it (it excludes recall:// rows), leaving
      // it dangling. Resolve the unique hex prefix to the full node id (same
      // rule as Pass 2) so prefix-in-address targets resolve uniformly.
      if (candidate.length >= 6 && candidate.length < 36 && !/[^0-9a-fA-F]/.test(candidate)) {
        const matches = this.db
          .prepare("SELECT id FROM graph_nodes WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
          .all(`${escapeLikePattern(candidate)}%`) as unknown as { id: string }[];
        if (matches.length === 1 && matches[0].id !== candidate) {
          update.run(matches[0].id, row.id);
        }
      }
    }

    // Pass 2: repair bare id-prefix targets (e.g. truncated 8-char ids written
    // where a full UUID belongs) to the full node id, but only where the prefix
    // resolves to exactly one node. Free-text anchors (non-hex) and ambiguous
    // prefixes are left untouched. Idempotent: a repaired 36-char id no longer
    // matches the length filter.
    const prefixRows = this.db
      .prepare(
        "SELECT id, target_id FROM graph_relations WHERE target_id NOT LIKE 'recall://%' AND length(target_id) BETWEEN 6 AND 35"
      )
      .all() as unknown as { id: string; target_id: string }[];
    for (const row of prefixRows) {
      if (/[^0-9a-fA-F]/.test(row.target_id)) {
        continue;
      }
      const matches = this.db
        .prepare("SELECT id FROM graph_nodes WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
        .all(`${escapeLikePattern(row.target_id)}%`) as unknown as { id: string }[];
      if (matches.length === 1 && matches[0].id !== row.target_id) {
        update.run(matches[0].id, row.id);
      }
    }
  }

  private migrateLexicalIndex(): boolean {
    // Triggers (not application-level sync) keep the index correct even when
    // an older binary that predates FTS writes to this database file.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
          node_id UNINDEXED, title, tags, summary, body,
          tokenize = 'porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS trg_graph_nodes_fts_insert
        AFTER INSERT ON graph_nodes BEGIN
          INSERT INTO graph_nodes_fts (node_id, title, tags, summary, body)
          VALUES (new.id, new.title, new.tags_json, coalesce(new.summary, ''), new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_graph_nodes_fts_update
        AFTER UPDATE ON graph_nodes BEGIN
          DELETE FROM graph_nodes_fts WHERE node_id = old.id;
          INSERT INTO graph_nodes_fts (node_id, title, tags, summary, body)
          VALUES (new.id, new.title, new.tags_json, coalesce(new.summary, ''), new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_graph_nodes_fts_delete
        AFTER DELETE ON graph_nodes BEGIN
          DELETE FROM graph_nodes_fts WHERE node_id = old.id;
        END;
      `);
      const nodes = count(this.db, "graph_nodes");
      const indexed = count(this.db, "graph_nodes_fts");
      if (indexed !== nodes) {
        this.db.exec(`
          DELETE FROM graph_nodes_fts;
          INSERT INTO graph_nodes_fts (node_id, title, tags, summary, body)
          SELECT id, title, tags_json, coalesce(summary, ''), body FROM graph_nodes;
        `);
      }
      return true;
    } catch {
      // SQLite builds without FTS5 fall back to LIKE-based search.
      return false;
    }
  }
}

interface NodeRow {
  id: string;
  cell_address: string | null;
  kind: RecallNode["kind"];
  title: string;
  body: string;
  summary: string | null;
  scope_json: string;
  tags_json: string;
  data_json: string;
  provenance_json: string;
  status: RecallNode["status"];
  created_at: string;
  updated_at: string;
}

interface SemanticRow extends NodeRow {
  backend: string;
  dims: number;
  vector_json: string;
}

interface RollbackRow {
  id: string;
  action: RollbackEntry["action"];
  target_id: string;
  before_json: string | null;
  after_json: string;
  created_at: string;
  applied_at?: string | null;
}

interface RelationRow {
  id: string;
  kind: RecallRelation["kind"];
  source_id: string;
  target_id: string;
  data_json: string;
  created_at: string;
}

interface HyperedgeRow {
  id: string;
  kind: string;
  title: string;
  members_json: string;
  metadata_json: string;
  created_at: string;
}

interface HyperedgeProgramRow {
  id: string;
  hyperedge_id: string;
  spec_json: string;
  enabled: number;
  created_at: string;
}

interface ProgramRunRow {
  id: string;
  program_id: string;
  hyperedge_id: string;
  output_json: string;
  created_at: string;
}

interface DagOverlayRow {
  id: string;
  title: string;
  node_ids_json: string;
  edges_json: string;
  metadata_json: string;
  created_at: string;
}

interface EvalRunRow {
  id: string;
  name: string;
  result_json: string;
  created_at: string;
}

interface AcpRequestRow {
  id: string;
  channel: string;
  from_agent: string;
  to_agent: string;
  action: AcpRequestAction;
  payload_json: string;
  status: AcpRequestStatus;
  response_json: string | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

interface OperatorRunRow {
  id: string;
  status: OperatorRun["status"];
  summary: string;
  result_json: string;
  created_at: string;
}

function rowToNode(row: NodeRow): RecallNode {
  return {
    id: row.id,
    cellAddress: row.cell_address ?? `recall://cell/legacy/unknown/${row.kind}/unknown/general/${row.created_at.slice(0, 10)}/${row.id}`,
    kind: row.kind,
    title: row.title,
    body: row.body,
    summary: row.summary ?? undefined,
    scope: JSON.parse(row.scope_json) as RecallNode["scope"],
    tags: JSON.parse(row.tags_json) as RecallNode["tags"],
    data: JSON.parse(row.data_json) as RecallNode["data"],
    provenance: JSON.parse(row.provenance_json) as RecallNode["provenance"],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRollback(row: RollbackRow): RollbackEntry {
  return {
    id: row.id,
    action: row.action,
    targetId: row.target_id,
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as Record<string, unknown>),
    after: JSON.parse(row.after_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function rowToRelation(row: RelationRow): RecallRelation {
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.source_id,
    targetId: row.target_id,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function rowToHyperedge(row: HyperedgeRow): Hyperedge {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    members: JSON.parse(row.members_json) as Hyperedge["members"],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function rowToProgram(row: HyperedgeProgramRow): HyperedgeProgram {
  return {
    id: row.id,
    hyperedgeId: row.hyperedge_id,
    spec: JSON.parse(row.spec_json) as HyperedgeProgramSpec,
    enabled: row.enabled === 1,
    createdAt: row.created_at
  };
}

function rowToProgramRun(row: ProgramRunRow): ProgramRun {
  return {
    id: row.id,
    programId: row.program_id,
    hyperedgeId: row.hyperedge_id,
    output: JSON.parse(row.output_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function rowToDagOverlay(row: DagOverlayRow): DagOverlay {
  return {
    id: row.id,
    title: row.title,
    nodeIds: JSON.parse(row.node_ids_json) as string[],
    edges: JSON.parse(row.edges_json) as DagOverlay["edges"],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function rowToEvalRun(row: EvalRunRow): StoredEvalRun {
  return {
    id: row.id,
    name: row.name,
    result: JSON.parse(row.result_json) as RecallEvalResult,
    createdAt: row.created_at
  };
}

function rowToAcpRequest(row: AcpRequestRow): AcpRequest {
  return {
    id: row.id,
    channel: row.channel,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    action: row.action,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    response: row.response_json === null ? null : (JSON.parse(row.response_json) as Record<string, unknown>),
    error: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at
  };
}

function rowToOperatorRun(row: OperatorRunRow): OperatorRun {
  return {
    id: row.id,
    status: row.status,
    summary: row.summary,
    result: JSON.parse(row.result_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

function escapeJsonLikeValue(value: string): string {
  return value.replaceAll('"', '\\"');
}

// Neutralizes LIKE wildcards in user terms; every LIKE consuming these
// patterns must carry ESCAPE '\' or the added backslashes break matching.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function rollbackActions(entry: RollbackEntry): string[] {
  if (entry.action === "insert_node") {
    return [`archive inserted node ${entry.targetId}`, `delete relations attached to ${entry.targetId}`, `delete derivation index rows for ${entry.targetId}`];
  }
  if (entry.action === "insert_relation") {
    return [`delete inserted relation ${entry.targetId}`];
  }
  if (entry.action === "update_node") {
    return [`restore prior node fields for ${entry.targetId}`];
  }
  return [`unsupported rollback action for ${entry.targetId}`];
}

function normalizeMembers(
  members: HyperedgeMember[],
  resolveReference: (reference: string) => ResolvedCellReference
): Hyperedge["members"] {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("Hyperedge requires at least one member");
  }
  return members.map((member, index) => {
    const resolved = resolveReference(requireNonEmpty(member.nodeId, "member nodeId"));
    return {
      nodeId: resolved.targetId,
      role: requireNonEmpty(member.role, "member role"),
      ordinal: member.ordinal ?? index,
      weight: member.weight,
      metadata: memberMetadata(member.metadata, resolved)
    };
  });
}

function normalizeDagEdge(
  edge: DagOverlay["edges"][number],
  resolveReference: (reference: string) => string
): DagOverlay["edges"][number] {
  return {
    from: resolveReference(requireNonEmpty(edge.from, "DAG edge from")),
    to: resolveReference(requireNonEmpty(edge.to, "DAG edge to")),
    label: edge.label,
    weight: edge.weight
  };
}

function memberMetadata(
  metadata: Record<string, unknown> | undefined,
  resolved: ResolvedCellReference
): Record<string, unknown> | undefined {
  const referenceMetadata: Record<string, unknown> = {};
  if (resolved.raw !== resolved.targetId) {
    referenceMetadata.targetRef = resolved.raw;
  }
  if (resolved.targetAddress) {
    referenceMetadata.targetAddress = resolved.targetAddress;
  }
  if (resolved.path) {
    referenceMetadata.targetPath = resolved.path;
  }
  const merged = { ...(metadata ?? {}), ...referenceMetadata };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => requireNonEmpty(value, "node id")))];
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

function defaultDerivationScope(): ProposalScope {
  return {
    project: "Recall",
    tenant: "local",
    session: "derivation"
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Rollback before value is missing a string field");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}
