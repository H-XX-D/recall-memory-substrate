// SqliteStore: the R2 Store contract over node:sqlite. The cell persists as a
// JSON blob (minus its edges) plus indexed columns; edges live only in the
// edges table and are rehydrated on read.
import type {
  Cell,
  DagOverlay,
  Edge,
  Hyperedge,
  Kind,
  LexicalBackend,
  NeighborLink,
  Relation,
  SearchHit,
  SemanticVector,
  Store,
  StoreStats,
} from "./types.js";
import { openDb, type Db } from "./db.js";
import { buildFtsMatchQuery } from "./retrieval.js";
import { normalizeHyperedgeMembers } from "./hyperedges.js";
import type { ProgramRun } from "./programs.js";
import type { StoredEvalRun } from "./evals.js";
import type { OperatorRun } from "./operator.js";

// Content fingerprint for dedup: kind + normalized title. Stable, not relational,
// so it is safe to store and index (it is a content key, not derived graph state).
export function contentKey(kind: string, title: string): string {
  return `${kind}:${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/g)
    .filter((term) => term.length > 1)
    .slice(0, 8);
}

interface CellRow {
  key: string;
  json: string;
}
interface EdgeRow {
  source: string;
  relation: string;
  target: string;
  weight: number;
}
interface FtsRow extends CellRow {
  rank: number;
}
interface CountRow {
  count: number;
}
interface HyperedgeRow {
  id: string;
  kind: string;
  title: string;
  members_json: string;
  metadata_json: string;
  created_at: string;
}
interface ProgramRunRow {
  id: string;
  program_key: string;
  operation: string;
  output_json: string;
  member_keys_json: string;
  created_at: string;
}
interface EvalRunRow {
  id: string;
  name: string;
  result_json: string;
  created_at: string;
}
interface OperatorRunRow {
  id: string;
  status: string;
  summary: string;
  result_json: string;
  created_at: string;
}

export class SqliteStore implements Store {
  private db: Db;
  private ftsEnabled: boolean;

  constructor(readonly path = ":memory:") {
    this.db = openDb(path);
    this.ftsEnabled = this.ensureFts();
  }

  put(cell: Cell): void {
    const { edgesOut, ...rest } = cell; // edges go to their own table, not the blob
    const json = JSON.stringify(rest);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cells (key, handle, kind, content_key, status, json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(cell.key, cell.handle, cell.kind, contentKey(cell.kind, cell.title), cell.status, json);

    this.db.prepare(`DELETE FROM edges WHERE source = ?`).run(cell.key);
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO edges (source, relation, target, weight) VALUES (?, ?, ?, ?)`,
    );
    for (const e of edgesOut) {
      ins.run(e.source, e.relation, e.target, e.weight);
    }

    this.indexCell(cell);
  }

  get(key: string): Cell | undefined {
    const row = this.db.prepare(`SELECT key, json FROM cells WHERE key = ?`).get(key) as
      | CellRow
      | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  getByHandle(handle: string): Cell | undefined {
    const row = this.db
      .prepare(`SELECT key, json FROM cells WHERE handle = ?`)
      .get(handle) as CellRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  all(): Cell[] {
    const rows = this.db.prepare(`SELECT key, json FROM cells`).all() as unknown as CellRow[];
    return rows.map((r) => this.hydrate(r));
  }

  active(): Cell[] {
    const rows = this.db
      .prepare(`SELECT key, json FROM cells WHERE status = 'active'`)
      .all() as unknown as CellRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // Temporal query pushed down to the indexed created_at generated column: no
  // scan-and-parse, SQLite filters and orders. Backs the "what changed since"
  // read without loading the whole graph into app memory.
  cellsCreatedSince(iso: string, limit = 100): Cell[] {
    const rows = this.db
      .prepare(
        `SELECT key, json FROM cells WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(iso, limit) as unknown as CellRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // SqliteStore only (NOT on the Store interface, NOT FederatedReadStore):
  // subgraph.ts feature-detects with "activeWhere" in store to take this fast
  // path instead of filtering store.active() app-side. Pushes status='active'
  // plus kind/project/since down into SQL against the real `kind` column and
  // the indexed `project`/`updated_at` generated columns, newest-updated first,
  // key ascending as a deterministic tie-break for equal updated_at values (SQLite
  // gives no ordering guarantee among tied rows otherwise); sortNewestFirst in
  // subgraph.ts applies the same tie-break so both paths agree.
  // LIMIT is applied only when the caller passes it: subgraphCells omits it
  // whenever tag families (topics/entities/lifecycle/quality/subject) are also
  // present, since app-side tag filtering after a SQL LIMIT would under-fill.
  activeWhere(opts: { kinds?: Kind[]; project?: string; since?: string; limit?: number }): Cell[] {
    const clauses = [`status = 'active'`];
    const params: (string | number)[] = [];
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      clauses.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    if (opts.project !== undefined) {
      clauses.push(`project = ?`);
      params.push(opts.project);
    }
    if (opts.since !== undefined) {
      clauses.push(`updated_at >= ?`);
      params.push(opts.since);
    }
    let sql = `SELECT key, json FROM cells WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, key ASC`;
    if (opts.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as CellRow[];
    return rows.map((r) => this.hydrate(r));
  }

  neighbors(key: string): NeighborLink[] {
    const links: NeighborLink[] = [];
    const out = this.db
      .prepare(`SELECT source, relation, target, weight FROM edges WHERE source = ?`)
      .all(key) as unknown as EdgeRow[];
    for (const e of out) {
      const cell = this.get(e.target);
      if (cell) links.push({ edge: this.toEdge(e), cell, direction: "out" });
    }
    const inc = this.db
      .prepare(`SELECT source, relation, target, weight FROM edges WHERE target = ?`)
      .all(key) as unknown as EdgeRow[];
    for (const e of inc) {
      const cell = this.get(e.source);
      if (cell) links.push({ edge: this.toEdge(e), cell, direction: "in" });
    }
    return links;
  }

  findByContentKey(kind: Kind, ck: string): Cell | undefined {
    const row = this.db
      .prepare(
        `SELECT key, json FROM cells WHERE kind = ? AND content_key = ? AND status = 'active' LIMIT 1`,
      )
      .get(kind, ck) as CellRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  putHyperedge(h: Hyperedge): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO hyperedges (id, kind, title, members_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(h.id, h.kind, h.title, JSON.stringify(h.members), JSON.stringify(h.metadata), h.createdAt);
  }

  listHyperedges(limit = 100): Hyperedge[] {
    const rows = this.db
      .prepare(`SELECT * FROM hyperedges ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as HyperedgeRow[];
    return rows.map((r) => this.hydrateHyperedge(r));
  }

  getHyperedge(id: string): Hyperedge | undefined {
    const resolved = this.resolveStoredId("hyperedges", id);
    if (resolved === null) return undefined;
    const row = this.db.prepare(`SELECT * FROM hyperedges WHERE id = ?`).get(resolved) as
      | HyperedgeRow
      | undefined;
    return row ? this.hydrateHyperedge(row) : undefined;
  }

  // Prefilters with a LIKE on the raw members_json (cheap, index-friendly on the
  // needle substring) then confirms with an exact JS equality check on the
  // normalized member keys, so a key that only appears as a JSON-string
  // substring of another key never false-positives.
  hyperedgesForCell(key: string, limit = 50): Hyperedge[] {
    const needle = `%${escapeLike(JSON.stringify(key))}%`;
    const rows = this.db
      .prepare(`SELECT * FROM hyperedges WHERE members_json LIKE ? ESCAPE '\\' ORDER BY created_at DESC`)
      .all(needle) as unknown as HyperedgeRow[];
    const out: Hyperedge[] = [];
    for (const row of rows) {
      const hyperedge = this.hydrateHyperedge(row);
      if (hyperedge.members.some((m) => m.key === key)) {
        out.push(hyperedge);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  putSemanticVector(v: SemanticVector): void {
    this.db.prepare(`INSERT OR REPLACE INTO semantic_index (node_id, backend, dims, vector_json, indexed_at) VALUES (?, ?, ?, ?, ?)`)
      .run(v.nodeId, v.backend, v.dims, JSON.stringify(v.vector), v.indexedAt);
  }

  getSemanticVector(nodeId: string): SemanticVector | undefined {
    const r = this.db.prepare(`SELECT * FROM semantic_index WHERE node_id = ?`).get(nodeId) as { node_id: string; backend: string; dims: number; vector_json: string; indexed_at: string } | undefined;
    return r ? { nodeId: r.node_id, backend: r.backend, dims: r.dims, vector: JSON.parse(r.vector_json), indexedAt: r.indexed_at } : undefined;
  }

  listSemanticVectorIds(): string[] {
    const rows = this.db.prepare(`SELECT node_id FROM semantic_index`).all() as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  putDagOverlay(d: DagOverlay): void {
    this.db.prepare(`INSERT OR REPLACE INTO dag_overlays (id, title, node_ids_json, edges_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.title, JSON.stringify(d.nodeIds), JSON.stringify(d.edges), JSON.stringify(d.metadata), d.createdAt);
  }

  // Prefix-tolerant via resolveStoredId, a deliberate upgrade over legacy
  // exact-only lookup: a unique id prefix resolves the same way getHyperedge
  // resolves one.
  getDagOverlay(id: string): DagOverlay | undefined {
    const resolved = this.resolveStoredId("dag_overlays", id);
    if (resolved === null) return undefined;
    const row = this.db.prepare(`SELECT * FROM dag_overlays WHERE id = ?`).get(resolved) as
      | { id: string; title: string; node_ids_json: string; edges_json: string; metadata_json: string; created_at: string }
      | undefined;
    return row ? this.hydrateDagOverlay(row) : undefined;
  }

  listDagOverlays(limit = 100): DagOverlay[] {
    const rows = this.db.prepare(`SELECT * FROM dag_overlays ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ id: string; title: string; node_ids_json: string; edges_json: string; metadata_json: string; created_at: string }>;
    return rows.map((r) => this.hydrateDagOverlay(r));
  }

  // Durable run ledger for standing programs. SqliteStore-only (NOT on the Store
  // interface): programs.ts feature-detects with "recordProgramRun" in store
  // before calling, so runProgramCell keeps working against any plain Store.
  recordProgramRun(run: ProgramRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO program_runs (id, program_key, operation, output_json, member_keys_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.programKey, run.operation, JSON.stringify(run.output), JSON.stringify(run.memberKeys), run.createdAt);
  }

  // Prefix-tolerant via resolveStoredId, same convention as getHyperedge/getDagOverlay.
  getProgramRun(id: string): ProgramRun | undefined {
    const resolved = this.resolveStoredId("program_runs", id);
    if (resolved === null) return undefined;
    const row = this.db.prepare(`SELECT * FROM program_runs WHERE id = ?`).get(resolved) as
      | ProgramRunRow
      | undefined;
    return row ? this.hydrateProgramRun(row) : undefined;
  }

  listProgramRuns(opts: { programKey?: string; limit?: number } = {}): ProgramRun[] {
    const limit = opts.limit ?? 20;
    const rows = opts.programKey
      ? (this.db
          .prepare(`SELECT * FROM program_runs WHERE program_key = ? ORDER BY created_at DESC LIMIT ?`)
          .all(opts.programKey, limit) as unknown as ProgramRunRow[])
      : (this.db
          .prepare(`SELECT * FROM program_runs ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as unknown as ProgramRunRow[]);
    return rows.map((r) => this.hydrateProgramRun(r));
  }

  // Durable eval ledger, same convention as recordProgramRun: SqliteStore-only
  // (NOT on the Store interface), feature-detected by callers with
  // "recordEvalRun" in store before calling.
  recordEvalRun(run: StoredEvalRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_runs (id, name, result_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(run.id, run.name, JSON.stringify(run.result), run.createdAt);
  }

  // Prefix-tolerant via resolveStoredId, same convention as getProgramRun.
  getEvalRun(id: string): StoredEvalRun | undefined {
    const resolved = this.resolveStoredId("eval_runs", id);
    if (resolved === null) return undefined;
    const row = this.db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(resolved) as
      | EvalRunRow
      | undefined;
    return row ? this.hydrateEvalRun(row) : undefined;
  }

  listEvalRuns(limit = 20): StoredEvalRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as EvalRunRow[];
    return rows.map((r) => this.hydrateEvalRun(r));
  }

  // Durable operator-tick ledger, same convention as recordProgramRun/recordEvalRun:
  // SqliteStore-only (NOT on the Store interface), feature-detected by callers with
  // "recordOperatorRun" in store. The Stop hook fires a cycle on every turn (best
  // effort), so rows are pruned to `keep` newest immediately after insert to keep
  // the ledger bounded; 1000 covers weeks of turns.
  recordOperatorRun(run: OperatorRun, keep = 1000): OperatorRun {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO operator_runs (id, status, summary, result_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.status, run.summary, JSON.stringify(run.result), run.createdAt);
    this.db
      .prepare(
        `DELETE FROM operator_runs WHERE id NOT IN (SELECT id FROM operator_runs ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(keep);
    return run;
  }

  // Prefix-tolerant via resolveStoredId, same convention as getProgramRun/getEvalRun.
  getOperatorRun(id: string): OperatorRun | undefined {
    const resolved = this.resolveStoredId("operator_runs", id);
    if (resolved === null) return undefined;
    const row = this.db.prepare(`SELECT * FROM operator_runs WHERE id = ?`).get(resolved) as
      | OperatorRunRow
      | undefined;
    return row ? this.hydrateOperatorRun(row) : undefined;
  }

  listOperatorRuns(limit = 20): OperatorRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as OperatorRunRow[];
    return rows.map((r) => this.hydrateOperatorRun(r));
  }

  search(query: string, opts: { limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    const terms = searchTerms(query);
    if (limit <= 0 || terms.length === 0) return [];
    if (this.ftsEnabled) {
      const match = buildFtsMatchQuery(terms);
      if (match) {
        try {
          const rows = this.db
            .prepare(
              `SELECT cells.key, cells.json, bm25(cells_fts, 4.0, 3.0, 2.0, 1.0, 1.0) AS rank
               FROM cells_fts
               JOIN cells ON cells.key = cells_fts.key
               WHERE cells_fts MATCH ? AND cells.status = 'active'
               ORDER BY rank ASC
               LIMIT ?`,
            )
            .all(match, limit) as unknown as FtsRow[];
          return rows.map((row) => ({
            cell: this.hydrate(row),
            score: Math.max(0, -row.rank),
            backend: "fts5-bm25",
          }));
        } catch {
          // Bad MATCH syntax or a runtime FTS issue should degrade to LIKE.
        }
      }
    }
    return this.searchLike(terms, limit);
  }

  lexicalBackend(): LexicalBackend {
    return this.ftsEnabled ? "fts5-bm25" : "like";
  }

  stats(): StoreStats {
    return {
      cells: this.count("cells"),
      activeCells: this.count("cells", "status = 'active'"),
      edges: this.count("edges"),
      indexedCells: this.ftsEnabled ? this.count("cells_fts") : 0,
      lexicalBackend: this.lexicalBackend(),
    };
  }

  close(): void {
    this.db.close();
  }

  private ensureFts(): boolean {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cells_fts USING fts5(
          key UNINDEXED,
          handle,
          title,
          tags,
          summary,
          body,
          tokenize = 'porter unicode61'
        )
      `);
      const cells = this.count("cells");
      const indexed = this.count("cells_fts");
      if (cells !== indexed) {
        this.rebuildFts();
      }
      return true;
    } catch {
      return false;
    }
  }

  private rebuildFts(): void {
    this.db.exec("DELETE FROM cells_fts");
    const rows = this.db.prepare(`SELECT key, json FROM cells`).all() as unknown as CellRow[];
    const insert = this.db.prepare(
      `INSERT INTO cells_fts (key, handle, title, tags, summary, body) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const cell = this.hydrate(row);
      insert.run(cell.key, cell.handle, cell.title, indexTags(cell), cell.summary ?? "", cell.body);
    }
  }

  private indexCell(cell: Cell): void {
    if (!this.ftsEnabled) return;
    this.db.prepare(`DELETE FROM cells_fts WHERE key = ?`).run(cell.key);
    this.db
      .prepare(
        `INSERT INTO cells_fts (key, handle, title, tags, summary, body) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(cell.key, cell.handle, cell.title, indexTags(cell), cell.summary ?? "", cell.body);
  }

  private searchLike(terms: string[], limit: number): SearchHit[] {
    if (terms.length === 0) return [];
    const clauses = terms
      .map(() => `(handle LIKE ? ESCAPE '\\' OR json LIKE ? ESCAPE '\\')`)
      .join(" OR ");
    const score = terms
      .map(() => `(CASE WHEN handle LIKE ? ESCAPE '\\' THEN 3 WHEN json LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
      .join(" + ");
    const clauseParams = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [pattern, pattern];
    });
    const scoreParams = [...clauseParams];
    const rows = this.db
      .prepare(
        `SELECT key, json, (${score}) AS rank
         FROM cells
         WHERE status = 'active' AND (${clauses})
         ORDER BY rank DESC, key ASC
         LIMIT ?`,
      )
      .all(...scoreParams, ...clauseParams, limit) as unknown as FtsRow[];
    return rows.map((row) => ({
      cell: this.hydrate(row),
      score: row.rank,
      backend: "like",
    }));
  }

  private count(table: string, where?: string): number {
    const sql = where ? `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS count FROM ${table}`;
    const row = this.db.prepare(sql).get() as unknown as CountRow;
    return row.count;
  }

  private hydrate(row: CellRow): Cell {
    const cell = JSON.parse(row.json) as Omit<Cell, "edgesOut">;
    const edgeRows = this.db
      .prepare(`SELECT source, relation, target, weight FROM edges WHERE source = ?`)
      .all(row.key) as unknown as EdgeRow[];
    return { ...cell, edgesOut: edgeRows.map((e) => this.toEdge(e)) };
  }

  private hydrateHyperedge(row: HyperedgeRow): Hyperedge {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      members: normalizeHyperedgeMembers(JSON.parse(row.members_json)),
      metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at,
    };
  }

  private hydrateDagOverlay(row: {
    id: string;
    title: string;
    node_ids_json: string;
    edges_json: string;
    metadata_json: string;
    created_at: string;
  }): DagOverlay {
    return {
      id: row.id,
      title: row.title,
      nodeIds: JSON.parse(row.node_ids_json),
      edges: JSON.parse(row.edges_json),
      metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at,
    };
  }

  private hydrateProgramRun(row: ProgramRunRow): ProgramRun {
    return {
      id: row.id,
      programKey: row.program_key,
      operation: row.operation as ProgramRun["operation"],
      createdAt: row.created_at,
      memberKeys: JSON.parse(row.member_keys_json),
      output: JSON.parse(row.output_json),
    };
  }

  private hydrateEvalRun(row: EvalRunRow): StoredEvalRun {
    return {
      id: row.id,
      name: row.name,
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  private hydrateOperatorRun(row: OperatorRunRow): OperatorRun {
    return {
      id: row.id,
      status: row.status as "ran",
      summary: row.summary,
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  // Resolves a stored id: exact match wins. Otherwise, if the value looks like a
  // (partial) hex/uuid id, we try it as a unique prefix, LIMIT 2 so we can tell
  // "exactly one match" from "ambiguous" without scanning the whole table.
  private resolveStoredId(
    table: "hyperedges" | "program_runs" | "eval_runs" | "operator_runs" | "dag_overlays",
    id: string,
  ): string | null {
    const exact = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;

    if (!(id.length >= 6 && id.length < 36 && /^[0-9a-fA-F-]+$/.test(id))) {
      return null;
    }

    const pattern = `${escapeLike(id)}%`;
    const rows = this.db
      .prepare(`SELECT id FROM ${table} WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(pattern) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : null;
  }

  private toEdge(e: EdgeRow): Edge {
    return {
      relation: e.relation as Relation,
      source: e.source,
      target: e.target,
      weight: e.weight,
    };
  }
}

function indexTags(cell: Cell): string {
  return [
    cell.owner,
    cell.scope.project,
    cell.scope.tenant,
    ...cell.tags.topics,
    ...cell.tags.entities,
    ...(cell.tags.lifecycle ?? []),
    ...(cell.tags.quality ?? []),
    ...(cell.tags.subject ?? []),
    ...cell.sourceRefs,
  ].join(" ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
