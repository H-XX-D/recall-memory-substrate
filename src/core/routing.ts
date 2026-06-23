// Project routing: resolve which sqlite DB a request hits, and a writable
// registry of project roots. Extracted from the MCP server's launch-time
// resolveDbPath so both the server (per request) and the CLI can share it.
// Reads are read-only and tolerate a missing registry (fresh install -> home
// fallback); writes ensure the table exists first.
//
// Model-A central model: locals are the single source of truth and live under
// the Recall home dir's db/ folder. The registry table lives in the home local
// (globalDbPath now resolves to homeDbPath unless RECALL_GLOBAL_DB overrides
// it). "global" is not a writable store; outside any project, reads fan out as
// a read-union over the locals (see localGraphPaths / FederatedReadStore) while
// writes land in the home local. Inside a registered project, reads and writes
// go to that project's local only.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FederatedReadStore } from "./federated-store.js";
import type { RecallStore } from "./store.js";

// Recall home dir. RECALL_HOME relocates the entire central model (registry +
// every local) under one root, which is exactly what manual testing needs to
// avoid touching the real user graphs.
export function recallHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECALL_HOME?.trim();
  return override && override !== "" ? override : join(homedir(), ".recall");
}

// The default "home" local. Outside any project this is both the writable store
// and the first member of the federated read union. It replaces the old
// "global" graph: the registry now lives here too (see globalDbPath below).
export function homeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(recallHomeDir(env), "db", "home.sqlite3");
}

// The default secrets side graph, routed through model A like the home local:
// a single central store under the Recall home dir, the same regardless of cwd,
// so `secrets list` never silently misses secrets saved from another directory.
// Override with --secrets-db. RECALL_HOME relocates it (used by tests).
export function homeSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(recallHomeDir(env), "db", "secrets.sqlite3");
}

// Back-compat alias. The registry used to live in a separate "global.sqlite3";
// it now lives in the home local. RECALL_GLOBAL_DB is still honored as an
// explicit override so existing callers and tests can point the registry at a
// scratch file.
export function globalDbPath(): string {
  const override = process.env.RECALL_GLOBAL_DB;
  if (override && override.trim() !== "") return override;
  return homeDbPath();
}

export interface ProjectRecord {
  slug: string;
  root_path: string;
  db_path: string;
  description: string | null;
  created_at: string;
}

// root_path is the project's real identity, so it is the primary key. slug is a
// human-facing label only (non-unique: two roots can share a basename). db_path
// is UNIQUE so two roots never share a local; registerProject disambiguates a
// colliding default filename with a short hash of the root before insert.
const PROJECTS_DDL = `CREATE TABLE IF NOT EXISTS projects (
  root_path TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  db_path TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);`;

// A pre-fix registry keyed the table on `slug TEXT PRIMARY KEY`. If a copied- or
// upgraded-forward db still carries that shape, rebuild it onto the root_path PK
// in place. Detected by reading the PK column from PRAGMA table_info: the new
// schema reports root_path as pk=1, the old one reports slug. The rebuild keeps
// one row per distinct resolved root_path (the last writer wins for a given
// root) and is a no-op once the new schema is present.
function ensureProjectsSchema(db: DatabaseSync): void {
  db.exec(PROJECTS_DDL);
  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const pkColumn = columns.find((c) => Number(c.pk) === 1)?.name;
  if (pkColumn === "root_path") return; // already migrated
  // Old shape (slug PK, or any non-root_path PK): safe rebuild.
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE projects_new (
      root_path TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      db_path TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL
    );`);
    const rows = db
      .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects ORDER BY created_at")
      .all() as unknown as Array<{
      slug: string;
      root_path: string;
      db_path: string;
      description: string | null;
      created_at: string;
    }>;
    // De-dupe by resolved root_path AND by db_path so the UNIQUE(db_path)
    // constraint cannot trip on legacy rows that collided onto one filename.
    const seenRoot = new Set<string>();
    const seenDb = new Set<string>();
    const insert = db.prepare(
      "INSERT INTO projects_new(root_path, slug, db_path, description, created_at) VALUES(?,?,?,?,?)",
    );
    for (const r of rows) {
      const root = resolve(r.root_path);
      if (seenRoot.has(root) || seenDb.has(r.db_path)) continue;
      seenRoot.add(root);
      seenDb.add(r.db_path);
      insert.run(root, r.slug, r.db_path, r.description ?? null, r.created_at);
    }
    db.exec("DROP TABLE projects");
    db.exec("ALTER TABLE projects_new RENAME TO projects");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

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

// A short, stable suffix derived from the resolved root_path. Used to keep two
// roots that slugify to the same basename (teamA/api, teamB/api) on distinct
// db files, so neither reads or writes the other's private cells.
function rootHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 6);
}

export function registerProject(
  input: { slug?: string; root: string; dbPath?: string; description?: string },
  nowIso: string,
  globalDb: string = globalDbPath(),
): ProjectRecord {
  const root = resolve(input.root);
  const slug = slugify(input.slug ?? basename(root) ?? "project");
  // The registry lives in the home local; on a fresh RECALL_HOME the db/ dir
  // does not exist yet and SQLite will not create it, so ensure it first.
  mkdirSync(dirname(globalDb), { recursive: true });
  const db = new DatabaseSync(globalDb);
  try {
    ensureProjectsSchema(db);

    // Idempotent re-register: if this exact root is already known, keep its
    // db_path (never re-point an existing root's local) and just refresh the
    // label/description.
    const existing = db
      .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects WHERE root_path = ?")
      .get(root) as
      | { slug: string; root_path: string; db_path: string; description: string | null; created_at: string }
      | undefined;

    let dbPath: string;
    let createdAt: string;
    if (input.dbPath) {
      // An explicit db_path is honored verbatim (power users place the local
      // where they want); a different root must not steal it.
      dbPath = input.dbPath;
      createdAt = existing?.created_at ?? nowIso;
    } else if (existing) {
      dbPath = existing.db_path;
      createdAt = existing.created_at;
    } else {
      // New root with the default filename. If the basename already maps to a
      // DIFFERENT root's local, disambiguate with a hash so we never collide.
      const baseCandidate = join(dirname(globalDb), `${slug}.sqlite3`);
      const owner = db.prepare("SELECT root_path FROM projects WHERE db_path = ?").get(baseCandidate) as
        | { root_path?: string }
        | undefined;
      dbPath =
        owner && resolve(owner.root_path ?? "") !== root
          ? join(dirname(globalDb), `${slug}-${rootHash(root)}.sqlite3`)
          : baseCandidate;
      createdAt = nowIso;
    }

    // Upsert on root_path: a re-register updates in place, a new root inserts.
    db.prepare(
      "INSERT INTO projects(root_path, slug, db_path, description, created_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(root_path) DO UPDATE SET slug=excluded.slug, db_path=excluded.db_path, description=excluded.description",
    ).run(root, slug, dbPath, input.description ?? null, createdAt);
    return { slug, root_path: root, db_path: dbPath, description: input.description ?? null, created_at: createdAt };
  } finally {
    db.close();
  }
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

// slug is now non-unique, so removing by slug deletes every row that carries it.
// In practice slugs are still distinct per machine; the broader match only
// matters for the rare basename-collision case, where dropping both is the
// conservative choice.
export function removeProject(slug: string, globalDb: string = globalDbPath()): boolean {
  try {
    const db = new DatabaseSync(globalDb);
    ensureProjectsSchema(db);
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

// Model-A scoped routing for a cwd. Three outcomes:
//   - "explicit": RECALL_DB is set, so a single store is used verbatim (escape
//     hatch for migrations and one-off scripts). It is neither the union nor a
//     registered project; the caller just opens that one db.
//   - "project": cwd is inside (or below) a registered project root, so reads
//     and writes go to that project's local only, never the union.
//   - "home": no project match, so writes land in the home local and reads fan
//     out over the union (built separately from localGraphPaths).
export function resolveCwdRouting(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { scope: "project" | "home" | "explicit"; dbPath: string; slug?: string } {
  const explicit = env.RECALL_DB?.trim();
  if (explicit && explicit !== "") {
    return { scope: "explicit", dbPath: explicit };
  }
  const registry = globalDbPath();
  const projects = listProjects(registry);
  const byRoot = new Map(projects.map((p) => [resolve(p.root_path), p]));
  let dir = resolve(cwd);
  for (;;) {
    const hit = byRoot.get(dir);
    if (hit) return { scope: "project", dbPath: hit.db_path, slug: hit.slug };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { scope: "home", dbPath: homeDbPath(env) };
}

// The members of the home read union: the home local first, then every
// registered project local. De-duped by resolved path so a project whose
// db_path happens to coincide with the home local is not opened twice.
export function localGraphPaths(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ graph: string; path: string }> {
  const members: Array<{ graph: string; path: string }> = [
    { graph: "home", path: homeDbPath(env) },
  ];
  for (const project of listProjects(globalDbPath())) {
    members.push({ graph: project.slug, path: project.db_path });
  }
  const seen = new Set<string>();
  const deduped: Array<{ graph: string; path: string }> = [];
  for (const member of members) {
    const key = resolve(member.path);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(member);
  }
  return deduped;
}

// First-run migration from the pre-model-A "global.sqlite3" to the home local.
//
// Before model-A the default store was ~/.recall/db/global.sqlite3. globalDbPath
// now aliases homeDbPath (home.sqlite3), so on a fresh upgrade nothing reads the
// old file and an empty home.sqlite3 would be created, stranding the user's
// memory. This copies global.sqlite3 forward exactly once: only when the home
// local does NOT yet exist and a sibling global.sqlite3 does. It COPIES (never
// renames or deletes), so global.sqlite3 stays on disk as a backup, and it
// carries the projects registry table forward with the data.
//
// Idempotent: once home.sqlite3 exists this is a no-op, so it is safe to call at
// every home-local open site (CLI and MCP) and the copy happens at most once
// regardless of which entry point runs first. RECALL_GLOBAL_DB is intentionally
// ignored here: the migration is about the on-disk sibling layout, not the
// registry override used by tests.
export function ensureHomeLocal(env: NodeJS.ProcessEnv = process.env): void {
  const home = homeDbPath(env);
  const dbDir = dirname(home);
  // Always make sure the db directory exists so a later open does not fail.
  mkdirSync(dbDir, { recursive: true });
  if (existsSync(home)) return; // home local already present -> nothing to do
  const legacyGlobal = join(dbDir, "global.sqlite3");
  if (!existsSync(legacyGlobal)) return; // nothing to migrate from
  // Checkpoint any uncheckpointed WAL pages into the main file before copying.
  // If a pre-model-A process last exited uncleanly (crash, kill, power loss)
  // with a hot global.sqlite3-wal, a bare copy of the main file alone would
  // strand that memory behind an effectively empty home.sqlite3.
  // wal_checkpoint(TRUNCATE) folds those pages in (and is a no-op on a non-WAL
  // or already-checkpointed file), leaving the copy self-contained. Best-effort:
  // a checkpoint failure must never block the migration, so fall through to a
  // plain copy.
  try {
    const source = new DatabaseSync(legacyGlobal);
    try {
      source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      source.close();
    }
  } catch {
    // fall through to a plain copy
  }
  copyFileSync(legacyGlobal, home);
  process.stderr.write(
    "Recall: migrated existing global.sqlite3 to home.sqlite3 (original kept as backup).\n",
  );
}

// The one shared home-scope read resolver. Both the CLI and the MCP server call
// this so there is a single routing implementation for "outside any project,
// read the union over every local". It runs the first-run migration first
// (ensureHomeLocal), then opens a FederatedReadStore over localGraphPaths(). The
// caller owns the returned store and must close() it.
//
// Use this only when routing has already resolved to home scope (cwd is not
// inside a registered project and RECALL_DB is unset). Project scope and
// explicit-db scope use a single SQLiteRecallStore instead.
export function openHomeReadUnion(env: NodeJS.ProcessEnv = process.env): FederatedReadStore {
  ensureHomeLocal(env);
  return new FederatedReadStore(localGraphPaths(env));
}

// Convenience wrapper: open the home read-union, run the body, always close.
export function withHomeReadUnion<T>(
  run: (read: RecallStore) => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const union = openHomeReadUnion(env);
  try {
    return run(union);
  } finally {
    union.close();
  }
}
