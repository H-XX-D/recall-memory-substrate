// R5 routing: deterministic residency for home/project SQLite locals.
//
// The home DB is both the default writable local and the project registry. A
// registered project gets a central DB under RECALL_HOME/db, and cwd routing
// chooses the deepest registered ancestor unless RECALL_DB explicitly overrides.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectRecord {
  slug: string;
  rootPath: string;
  dbPath: string;
  description: string | null;
  createdAt: string;
}

export type RoutingScope = "explicit" | "project" | "home";

export interface RoutedDb {
  scope: RoutingScope;
  dbPath: string;
  reason: string;
  project?: ProjectRecord;
}

interface ProjectRow {
  slug: string;
  root_path: string;
  db_path: string;
  description: string | null;
  created_at: string;
}

const PROJECTS_DDL = `CREATE TABLE IF NOT EXISTS projects (
  root_path TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  db_path TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
)`;

export function recallHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECALL_HOME?.trim();
  return override ? override : join(homedir(), ".recall");
}

export function homeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(recallHomeDir(env), "db", "home.sqlite3");
}

export function registryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return homeDbPath(env);
}

export function globalDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return homeDbPath(env);
}

export function projectDbPath(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = slugify(slug);
  const filename = normalized === "home" ? "project-home" : normalized;
  return join(recallHomeDir(env), "db", `${filename}.sqlite3`);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

export function registerProject(
  input: { slug?: string; root: string; dbPath?: string; description?: string },
  nowIso = new Date().toISOString(),
  registryDb = registryDbPath(),
): ProjectRecord {
  const rootPath = canonicalPath(input.root);
  mkdirSync(dirname(registryDb), { recursive: true });
  const db = new DatabaseSync(registryDb);
  try {
    ensureProjectsTable(db);
    const existing = getProjectByRoot(db, rootPath);
    if (existing) {
      const description = input.description ?? existing.description;
      db.prepare("UPDATE projects SET description = ? WHERE root_path = ?").run(description, rootPath);
      return { ...existing, description };
    }

    const baseSlug = slugify(input.slug ?? basename(rootPath) ?? "project");
    const slug = uniqueSlug(db, baseSlug, rootPath);
    const dbPath = input.dbPath ? resolve(input.dbPath) : join(dirname(registryDb), `${slug}.sqlite3`);
    db.prepare(
      "INSERT INTO projects(root_path, slug, db_path, description, created_at) VALUES(?,?,?,?,?)",
    ).run(rootPath, slug, dbPath, input.description ?? null, nowIso);
    return { slug, rootPath, dbPath, description: input.description ?? null, createdAt: nowIso };
  } finally {
    db.close();
  }
}

export function listProjects(registryDb = registryDbPath()): ProjectRecord[] {
  try {
    const db = new DatabaseSync(registryDb, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT slug, root_path, db_path, description, created_at FROM projects ORDER BY created_at, slug",
        )
        .all() as unknown as ProjectRow[];
      return rows.map(rowToRecord);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function loadRegistry(registryDb = registryDbPath()): Map<string, ProjectRecord> {
  const byRoot = new Map<string, ProjectRecord>();
  for (const project of listProjects(registryDb)) {
    byRoot.set(canonicalPath(project.rootPath), project);
  }
  return byRoot;
}

export function resolveDbForSlug(slug: string, registryDb = registryDbPath()): string | null {
  try {
    const db = new DatabaseSync(registryDb, { readOnly: true });
    try {
      const row = db.prepare("SELECT db_path FROM projects WHERE slug = ?").get(slug) as
        | { db_path: string }
        | undefined;
      return row?.db_path ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function resolveDbForCwd(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  registryDb = registryDbPath(env),
): string {
  return whereProject(cwd, env, registryDb).dbPath;
}

export function whereProject(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  registryDb = registryDbPath(env),
): RoutedDb {
  const explicit = env.RECALL_DB?.trim();
  if (explicit) {
    return { scope: "explicit", dbPath: explicit, reason: "RECALL_DB env override" };
  }

  const project = findProjectForCwd(cwd, listProjects(registryDb));
  if (project) {
    return {
      scope: "project",
      dbPath: project.dbPath,
      reason: `project root ${project.rootPath}`,
      project,
    };
  }

  return { scope: "home", dbPath: registryDb, reason: "no registered project ancestor" };
}

export function localGraphPaths(
  env: NodeJS.ProcessEnv = process.env,
  registryDb = registryDbPath(env),
): Array<{ graph: string; path: string }> {
  const members = [{ graph: "home", path: registryDb, root: "home" }];
  for (const project of listProjects(registryDb)) {
    members.push({ graph: project.slug, path: project.dbPath, root: project.rootPath });
  }

  const seenPath = new Set<string>();
  const seenGraph = new Set<string>();
  const out: Array<{ graph: string; path: string }> = [];
  for (const member of members) {
    const pathKey = resolve(member.path);
    if (seenPath.has(pathKey)) continue;
    seenPath.add(pathKey);

    let graph = member.graph;
    while (seenGraph.has(graph)) {
      graph = `${member.graph}-${rootHash(`${member.root}:${pathKey}`)}`;
    }
    seenGraph.add(graph);
    out.push({ graph, path: member.path });
  }
  return out;
}

function ensureProjectsTable(db: DatabaseSync): void {
  db.exec(PROJECTS_DDL);
}

function getProjectByRoot(db: DatabaseSync, rootPath: string): ProjectRecord | undefined {
  const row = db
    .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects WHERE root_path = ?")
    .get(rootPath) as ProjectRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

function uniqueSlug(db: DatabaseSync, baseSlug: string, rootPath: string): string {
  let candidate = baseSlug;
  if (candidate === "home" || slugOwnedByDifferentRoot(db, candidate, rootPath)) {
    const prefix = candidate === "home" ? "project-home" : candidate;
    candidate = `${prefix}-${rootHash(rootPath)}`;
  }
  while (candidate === "home" || slugOwnedByDifferentRoot(db, candidate, rootPath)) {
    candidate = `${baseSlug}-${rootHash(`${rootPath}:${candidate}`)}`;
  }
  return candidate;
}

function slugOwnedByDifferentRoot(db: DatabaseSync, slug: string, rootPath: string): boolean {
  const row = db.prepare("SELECT root_path FROM projects WHERE slug = ?").get(slug) as
    | { root_path: string }
    | undefined;
  return row !== undefined && canonicalPath(row.root_path) !== rootPath;
}

function findProjectForCwd(cwd: string, projects: ProjectRecord[]): ProjectRecord | undefined {
  const byRoot = new Map(projects.map((project) => [canonicalPath(project.rootPath), project]));
  let dir = canonicalPath(cwd);
  for (;;) {
    const hit = byRoot.get(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return {
    slug: row.slug,
    rootPath: canonicalPath(row.root_path),
    dbPath: row.db_path,
    description: row.description,
    createdAt: row.created_at,
  };
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function rootHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}
