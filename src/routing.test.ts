import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  listProjects,
  localGraphPaths,
  projectDbPath,
  registerProject,
  resolveDbForCwd,
  resolveDbForSlug,
  slugify,
  whereProject,
} from "./routing.js";

const NOW = "2026-06-26T12:00:00.000Z";

test("slugify normalizes labels and falls back to project", () => {
  assert.equal(slugify(" Total Recall!!! "), "total-recall");
  assert.equal(slugify("!!!"), "project");
  assert.equal(slugify("a".repeat(80)).length, 60);
  assert.ok(
    projectDbPath("home", { RECALL_HOME: "/tmp/recall-home" } as NodeJS.ProcessEnv).endsWith(
      "project-home.sqlite3",
    ),
  );
});

test("registerProject creates a central project record and is idempotent by root", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "home.sqlite3");
    const root = join(tmp, "work", "demo");
    const record = registerProject({ root, description: "Demo project" }, NOW, registry);

    assert.equal(record.slug, "demo");
    assert.equal(record.rootPath, resolve(root));
    assert.equal(record.dbPath, join(dirname(registry), "demo.sqlite3"));
    assert.equal(record.description, "Demo project");
    assert.equal(resolveDbForSlug("demo", registry), record.dbPath);

    const again = registerProject(
      { root, slug: "renamed", description: "Updated description" },
      "2026-06-26T12:01:00.000Z",
      registry,
    );
    assert.equal(again.slug, "demo");
    assert.equal(again.dbPath, record.dbPath);
    assert.equal(again.createdAt, NOW);
    assert.equal(listProjects(registry)[0]?.description, "Updated description");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveDbForCwd honors RECALL_DB, deepest project ancestor, then home", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "home.sqlite3");
    const repo = registerProject({ root: join(tmp, "repo"), slug: "repo" }, NOW, registry);
    const app = registerProject(
      { root: join(tmp, "repo", "packages", "app"), slug: "app" },
      "2026-06-26T12:01:00.000Z",
      registry,
    );

    assert.equal(resolveDbForCwd(join(app.rootPath, "src"), {}, registry), app.dbPath);
    assert.equal(resolveDbForCwd(join(repo.rootPath, "docs"), {}, registry), repo.dbPath);
    assert.equal(resolveDbForCwd(join(tmp, "outside"), {}, registry), registry);

    const explicit = join(tmp, "explicit.sqlite3");
    const env = { RECALL_DB: explicit } as NodeJS.ProcessEnv;
    assert.equal(resolveDbForCwd(join(app.rootPath, "src"), env, registry), explicit);
    assert.equal(whereProject(join(app.rootPath, "src"), env, registry).scope, "explicit");
    assert.equal(whereProject(join(app.rootPath, "src"), {}, registry).scope, "project");
    assert.equal(whereProject(join(tmp, "outside"), {}, registry).scope, "home");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("project routing canonicalizes symlinked roots and cwd paths", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "home.sqlite3");
    const realRoot = join(tmp, "real", "repo");
    const linkRoot = join(tmp, "linked-repo");
    mkdirSync(realRoot, { recursive: true });
    try {
      symlinkSync(realRoot, linkRoot, "dir");
    } catch {
      return;
    }
    mkdirSync(join(realRoot, "src"), { recursive: true });
    const project = registerProject({ root: linkRoot, slug: "linked" }, NOW, registry);
    assert.equal(project.rootPath, realpathSync(realRoot));
    assert.equal(whereProject(join(realRoot, "src"), {}, registry).scope, "project");
    assert.equal(resolveDbForCwd(join(linkRoot, "src"), {}, registry), project.dbPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("registerProject disambiguates slug collisions and the reserved home graph", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "home.sqlite3");
    const first = registerProject({ root: join(tmp, "team-a", "api") }, NOW, registry);
    const second = registerProject(
      { root: join(tmp, "team-b", "api") },
      "2026-06-26T12:01:00.000Z",
      registry,
    );
    const homeNamed = registerProject(
      { root: join(tmp, "home") },
      "2026-06-26T12:02:00.000Z",
      registry,
    );

    assert.equal(first.slug, "api");
    assert.match(second.slug, /^api-[a-f0-9]{6}$/);
    assert.notEqual(second.dbPath, first.dbPath);
    assert.match(homeNamed.slug, /^project-home-[a-f0-9]{6}$/);
    assert.notEqual(homeNamed.slug, "home");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("localGraphPaths returns home first then registered project locals", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "home.sqlite3");
    const project = registerProject({ root: join(tmp, "repo"), slug: "repo" }, NOW, registry);
    const graphs = localGraphPaths({}, registry);

    assert.deepEqual(
      graphs.map((member) => member.graph),
      ["home", "repo"],
    );
    assert.equal(graphs[0]?.path, registry);
    assert.equal(graphs[1]?.path, project.dbPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-routing-"));
}
