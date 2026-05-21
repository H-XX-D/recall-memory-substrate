import { mkdirSync } from "node:fs";
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
import { cosine, embedTextRecord, textForEmbedding, type SemanticHit } from "./semantic.js";
import type {
  AdmissionResult,
  DagAnalysis,
  DagOverlay,
  Hyperedge,
  HyperedgeMember,
  HyperedgeProgram,
  HyperedgeProgramSpec,
  ProgramRun,
  ProposalScope,
  RecallNode,
  RecallRelation,
  RollbackEntry,
  StoreStats,
  WriteProposal
} from "./types.js";

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
  search(query: string, limit?: number): RecallNode[];
  semanticSearch(query: string, limit?: number): SemanticHit<RecallNode>[];
  reindexSemantic(): { indexed: number; backend: string; dims: number };
  subgraph(filter: SubgraphFilter): RecallNode[];
  getNode(id: string): RecallNode | null;
  getNodeByAddress(address: string): RecallNode | null;
  listNodes(limit?: number): RecallNode[];
  listRollback(limit?: number): RollbackEntry[];
  applyRollback(id: string, apply?: boolean): { id: string; applied: boolean; actions: string[] };
  addHyperedge(input: HyperedgeInput): Hyperedge;
  getHyperedge(id: string): Hyperedge | null;
  listHyperedges(limit?: number): Hyperedge[];
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
  runEval(suite?: RecallEvalSuite): RecallEvalResult;
  runEvalAndDerive(suite?: RecallEvalSuite, options?: Partial<DerivationProposalOptions>): DerivedEvalRunResult;
  getEvalRun(id: string): StoredEvalRun | null;
  listEvalRuns(limit?: number): StoredEvalRun[];
  close(): void;
}

export class SQLiteRecallStore implements RecallStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string = ".recall/recall.sqlite3") {
    const dbPath = resolve(path);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
      evalRuns: count(this.db, "eval_runs")
    };
  }

  search(query: string, limit = 10): RecallNode[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 1)
      .slice(0, 8);
    const effectiveTerms = terms.length > 0 ? terms : [query.trim()].filter(Boolean);
    const clauses = effectiveTerms.map(() => "(title LIKE ? OR body LIKE ? OR tags_json LIKE ?)").join(" OR ");
    const params = effectiveTerms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like];
    });

    const rows = this.db
      .prepare(
        `SELECT * FROM graph_nodes
         WHERE status = 'active'
         ${clauses.length > 0 ? `AND (${clauses})` : ""}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  semanticSearch(query: string, limit = 10): SemanticHit<RecallNode>[] {
    const queryEmbedding = embedTextRecord(query);
    const rows = this.db
      .prepare(
        `SELECT n.*, s.backend, s.dims, s.vector_json
         FROM graph_nodes n
         JOIN semantic_index s ON s.node_id = n.id
         WHERE n.status = 'active'
         AND s.backend = ?
         AND s.dims = ?`
      )
      .all(queryEmbedding.backend, queryEmbedding.dims) as unknown as SemanticRow[];
    return rows
      .map((row) => ({
        item: rowToNode(row),
        score: cosine(queryEmbedding.vector, JSON.parse(row.vector_json) as number[])
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
      filter[family]!.map(() => `tags_json LIKE ?`)
    );
    const params = activeFamilies.flatMap((family) =>
      filter[family]!.map((value) => `%${escapeJsonLikeValue(value)}%`)
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
      members: normalizeMembers(input.members),
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

  getHyperedge(id: string): Hyperedge | null {
    const row = this.db.prepare("SELECT * FROM hyperedges WHERE id = ?").get(id) as HyperedgeRow | undefined;
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
    const row = this.db.prepare("SELECT * FROM hyperedge_programs WHERE id = ?").get(id) as
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
    const run = executeHyperedgeProgram({ program, hyperedge, members });
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
    const row = this.db.prepare("SELECT * FROM program_runs WHERE id = ?").get(id) as ProgramRunRow | undefined;
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
      nodeIds: uniqueStrings(input.nodeIds),
      edges: input.edges.map(normalizeDagEdge),
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

  runEval(suite?: RecallEvalSuite): RecallEvalResult {
    const result = runRecallEval(this, suite);
    this.db
      .prepare(
        `INSERT INTO eval_runs
          (id, name, result_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cryptoRandomId(), result.name, stringify(result), result.createdAt);
    return result;
  }

  runEvalAndDerive(suite?: RecallEvalSuite, options: Partial<DerivationProposalOptions> = {}): DerivedEvalRunResult {
    const result = this.runEval(suite);
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
    const row = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as EvalRunRow | undefined;
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

  close(): void {
    this.db.close();
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
      DELETE FROM derivation_index
      WHERE node_id NOT IN (
        SELECT id FROM graph_nodes WHERE status = 'active'
      );
    `);
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

function normalizeMembers(members: HyperedgeMember[]): Hyperedge["members"] {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("Hyperedge requires at least one member");
  }
  return members.map((member, index) => ({
    nodeId: requireNonEmpty(member.nodeId, "member nodeId"),
    role: requireNonEmpty(member.role, "member role"),
    ordinal: member.ordinal ?? index,
    weight: member.weight,
    metadata: member.metadata
  }));
}

function normalizeDagEdge(edge: DagOverlay["edges"][number]): DagOverlay["edges"][number] {
  return {
    from: requireNonEmpty(edge.from, "DAG edge from"),
    to: requireNonEmpty(edge.to, "DAG edge to"),
    label: edge.label,
    weight: edge.weight
  };
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
