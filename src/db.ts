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
  return db;
}
