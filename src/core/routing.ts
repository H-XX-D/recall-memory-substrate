// Project routing: resolve which sqlite DB a request hits, and a writable
// registry of project roots. Extracted from the MCP server's launch-time
// resolveDbPath so both the server (per request) and the CLI can share it.
// Reads are read-only and tolerate a missing registry (fresh install ->
// global fallback); writes ensure the table exists first.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function globalDbPath(): string {
  const override = process.env.RECALL_GLOBAL_DB;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".recall", "db", "global.sqlite3");
}

export interface ProjectRecord {
  slug: string;
  root_path: string;
  db_path: string;
  description: string | null;
  created_at: string;
}

const PROJECTS_DDL = `CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  db_path TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);`;

/** resolve(root_path) -> db_path. Read-only; a missing table yields an empty map. */
export function loadRegistry(globalDb: string = globalDbPath()): Map<string, string> {
  const byRoot = new Map<string, string>();
  try {
    const db = new DatabaseSync(globalDb, { readOnly: true });
    const rows = db
      .prepare("SELECT root_path, db_path FROM projects")
      .all() as unknown as Array<{ root_path: string; db_path: string }>;
    db.close();
    for (const r of rows) byRoot.set(resolve(r.root_path), r.db_path);
  } catch {
    // registry missing / unreadable -> empty (global fallback upstream)
  }
  return byRoot;
}

/** Precedence: RECALL_DB env > deepest registered ancestor of cwd > global default. */
export function resolveDbForCwd(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  globalDb: string = globalDbPath(),
): string {
  const explicit = env.RECALL_DB;
  if (explicit && explicit.trim() !== "") return explicit;
  const byRoot = loadRegistry(globalDb);
  let dir = resolve(cwd);
  for (;;) {
    const hit = byRoot.get(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return globalDb;
}

/** Map a project slug to its db_path, or null if unknown. Read-only. */
export function resolveDbForSlug(slug: string, globalDb: string = globalDbPath()): string | null {
  try {
    const db = new DatabaseSync(globalDb, { readOnly: true });
    const row = db.prepare("SELECT db_path FROM projects WHERE slug = ?").get(slug) as
      | { db_path?: string }
      | undefined;
    db.close();
    return row?.db_path ?? null;
  } catch {
    return null;
  }
}

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "project";
}

export function registerProject(
  input: { slug?: string; root: string; dbPath?: string; description?: string },
  nowIso: string,
  globalDb: string = globalDbPath(),
): ProjectRecord {
  const root = resolve(input.root);
  const slug = slugify(input.slug ?? root.split("/").pop() ?? "project");
  const dbPath = input.dbPath ?? join(dirname(globalDb), `${slug}.sqlite3`);
  const db = new DatabaseSync(globalDb);
  db.exec(PROJECTS_DDL);
  db.prepare(
    "INSERT INTO projects(slug, root_path, db_path, description, created_at) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(slug) DO UPDATE SET root_path=excluded.root_path, db_path=excluded.db_path, description=excluded.description",
  ).run(slug, root, dbPath, input.description ?? null, nowIso);
  db.close();
  return { slug, root_path: root, db_path: dbPath, description: input.description ?? null, created_at: nowIso };
}

export function listProjects(globalDb: string = globalDbPath()): ProjectRecord[] {
  try {
    const db = new DatabaseSync(globalDb, { readOnly: true });
    const rows = db
      .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects ORDER BY created_at")
      .all() as unknown as ProjectRecord[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}

export function removeProject(slug: string, globalDb: string = globalDbPath()): boolean {
  try {
    const db = new DatabaseSync(globalDb);
    db.exec(PROJECTS_DDL);
    const res = db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
    db.close();
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function whereProject(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  globalDb: string = globalDbPath(),
): { db: string; reason: string } {
  const explicit = env.RECALL_DB;
  if (explicit && explicit.trim() !== "") return { db: explicit, reason: "RECALL_DB env override" };
  const byRoot = loadRegistry(globalDb);
  let dir = resolve(cwd);
  for (;;) {
    const hit = byRoot.get(dir);
    if (hit) return { db: hit, reason: `project root ${dir}` };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { db: globalDb, reason: "no project match (global)" };
}
