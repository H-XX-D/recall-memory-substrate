import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { resolve } from "node:path";
import { SQLiteRecallStore } from "./store.js";
import { RECALL_VERSION } from "./version.js";

export const RECALL_EXPORT_SCHEMA_VERSION = "recall.export.v1" as const;

export interface RecallExportArchive {
  schemaVersion: typeof RECALL_EXPORT_SCHEMA_VERSION;
  recallVersion: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface RecallImportResult {
  importedTables: Record<string, number>;
}

const EXPORT_TABLES = [
  "graph_nodes",
  "graph_relations",
  "write_proposals",
  "rollback_journal",
  "semantic_index",
  "hyperedges",
  "hyperedge_programs",
  "program_runs",
  "dag_overlays",
  "eval_runs",
  "acp_requests",
  "operator_runs",
  "derivation_index"
] as const;

export function exportRecallArchive(dbPath: string, now = new Date()): RecallExportArchive {
  const store = new SQLiteRecallStore(dbPath);
  store.close();

  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const tables: RecallExportArchive["tables"] = {};
    for (const table of EXPORT_TABLES) {
      tables[table] = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    }
    return {
      schemaVersion: RECALL_EXPORT_SCHEMA_VERSION,
      recallVersion: RECALL_VERSION,
      exportedAt: now.toISOString(),
      tables
    };
  } finally {
    db.close();
  }
}

export function importRecallArchive(dbPath: string, archive: unknown, options: { replace?: boolean } = {}): RecallImportResult {
  const parsed = parseArchive(archive);
  const store = new SQLiteRecallStore(dbPath);
  const stats = store.stats();
  store.close();

  if (!options.replace && Object.values(stats).some((count) => count > 0)) {
    throw new Error("Refusing to import into a non-empty Recall database; pass --force to replace it");
  }

  const db = new DatabaseSync(resolve(dbPath));
  const importedTables: Record<string, number> = {};
  try {
    db.exec("BEGIN");
    if (options.replace) {
      for (const table of [...EXPORT_TABLES].reverse()) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    }

    for (const table of EXPORT_TABLES) {
      const rows = parsed.tables[table] ?? [];
      const allowedColumns = tableColumns(db, table);
      for (const row of rows) {
        const columns = Object.keys(row);
        for (const column of columns) {
          if (!allowedColumns.has(column)) {
            throw new Error(`Archive table ${table} contains unknown column ${column}`);
          }
        }
        if (columns.length === 0) {
          continue;
        }
        const columnSql = columns.map((column) => `"${column}"`).join(", ");
        const valueSql = columns.map(() => "?").join(", ");
        db.prepare(`INSERT INTO ${table} (${columnSql}) VALUES (${valueSql})`).run(
          ...columns.map((column) => row[column] as SQLInputValue)
        );
        importedTables[table] = (importedTables[table] ?? 0) + 1;
      }
      importedTables[table] = importedTables[table] ?? 0;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  const migrated = new SQLiteRecallStore(dbPath);
  migrated.reindexSemantic();
  migrated.close();
  return { importedTables };
}

function parseArchive(input: unknown): RecallExportArchive {
  if (!isRecord(input)) {
    throw new Error("Recall export archive must be an object");
  }
  if (input.schemaVersion !== RECALL_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Expected ${RECALL_EXPORT_SCHEMA_VERSION}`);
  }
  if (!isRecord(input.tables)) {
    throw new Error("Recall export archive must contain a tables object");
  }

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows = input.tables[table];
    if (rows === undefined) {
      tables[table] = [];
      continue;
    }
    if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
      throw new Error(`Archive table ${table} must be an array of row objects`);
    }
    tables[table] = rows as Record<string, unknown>[];
  }

  return {
    schemaVersion: RECALL_EXPORT_SCHEMA_VERSION,
    recallVersion: typeof input.recallVersion === "string" ? input.recallVersion : "unknown",
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date(0).toISOString(),
    tables
  };
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
