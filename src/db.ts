// R2 store substrate: the node:sqlite connection + schema. Two normalized
// tables, cells and edges. Edges are the single source of truth for relations
// and are never stored inside the cell JSON. WAL for durability.
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cells (
      key TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_key TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_cells_handle ON cells(handle)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cells_content ON cells(kind, content_key)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      source TEXT NOT NULL,
      relation TEXT NOT NULL,
      target TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (source, relation, target)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS hyperedges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
      members_json TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_hyperedges_kind ON hyperedges(kind)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_index (
      node_id TEXT PRIMARY KEY, backend TEXT NOT NULL, dims INTEGER NOT NULL,
      vector_json TEXT NOT NULL, indexed_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dag_overlays (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, node_ids_json TEXT NOT NULL,
      edges_json TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS program_runs (
      id TEXT PRIMARY KEY, program_key TEXT NOT NULL, operation TEXT NOT NULL,
      output_json TEXT NOT NULL, member_keys_json TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_program_runs_program ON program_runs(program_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_program_runs_created ON program_runs(created_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, summary TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_operator_runs_created ON operator_runs(created_at)");
  ensureGeneratedColumns(db);
  return db;
}

// The queryable surface of the cell blob. Each column is DERIVED from the json
// via json_extract (VIRTUAL, so no write duplication and no drift), then indexed.
// This is what lets MAL push temporal/scope/rank predicates down into SQLite
// instead of scanning and parsing every row in app code. Adding a promotable
// field later is one entry here plus its index; the blob stays canonical.
const GENERATED_COLUMNS: { name: string; type: string; path: string }[] = [
  { name: "created_at", type: "TEXT", path: "$.createdAt" },
  { name: "updated_at", type: "TEXT", path: "$.updatedAt" },
  { name: "project", type: "TEXT", path: "$.scope.project" },
  { name: "effective", type: "REAL", path: "$.scores.effective" },
];

// Idempotent: adds any missing generated column (works on both fresh and already
// populated DBs, since VIRTUAL generated columns can be added via ALTER TABLE),
// then ensures each column's index. Safe to run on every open.
function ensureGeneratedColumns(db: Db): void {
  // table_xinfo (not table_info) is required: table_info omits generated columns,
  // so on reopen the check would miss them and re-run ALTER (duplicate column).
  const existing = new Set(
    (db.prepare("PRAGMA table_xinfo(cells)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const col of GENERATED_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(
        `ALTER TABLE cells ADD COLUMN ${col.name} ${col.type} GENERATED ALWAYS AS (json_extract(json, '${col.path}')) VIRTUAL`,
      );
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cells_${col.name} ON cells(${col.name})`);
  }
}
