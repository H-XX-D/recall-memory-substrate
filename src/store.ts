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
    const rows = this.db.prepare(`SELECT * FROM hyperedges ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ id: string; kind: string; title: string; members_json: string; metadata_json: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, members: JSON.parse(r.members_json), metadata: JSON.parse(r.metadata_json), createdAt: r.created_at }));
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

  listDagOverlays(limit = 100): DagOverlay[] {
    const rows = this.db.prepare(`SELECT * FROM dag_overlays ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ id: string; title: string; node_ids_json: string; edges_json: string; metadata_json: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, title: r.title, nodeIds: JSON.parse(r.node_ids_json), edges: JSON.parse(r.edges_json), metadata: JSON.parse(r.metadata_json), createdAt: r.created_at }));
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
