import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  homeDbPath,
  listProjects,
  localGraphPaths,
  projectDbPath,
  registerProject,
  registryDbPath,
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
  assert.ok(
    projectDbPath("registry", { RECALL_HOME: "/tmp/recall-home" } as NodeJS.ProcessEnv).endsWith(
      "project-registry.sqlite3",
    ),
  );
});

test("registry and home stores are distinct files under RECALL_HOME/db", () => {
  const env = { RECALL_HOME: "/tmp/recall-home" } as NodeJS.ProcessEnv;
  assert.equal(registryDbPath(env), join("/tmp/recall-home", "db", "registry.sqlite3"));
  assert.equal(homeDbPath(env), join("/tmp/recall-home", "db", "home.sqlite3"));
  assert.notEqual(registryDbPath(env), homeDbPath(env));
});

test("registerProject creates a central project record and is idempotent by root", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "registry.sqlite3");
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
    const registry = join(tmp, "db", "registry.sqlite3");
    const home = join(tmp, "db", "home.sqlite3");
    const repo = registerProject({ root: join(tmp, "repo"), slug: "repo" }, NOW, registry);
    const app = registerProject(
      { root: join(tmp, "repo", "packages", "app"), slug: "app" },
      "2026-06-26T12:01:00.000Z",
      registry,
    );

    assert.equal(resolveDbForCwd(join(app.rootPath, "src"), {}, registry, home), app.dbPath);
    assert.equal(resolveDbForCwd(join(repo.rootPath, "docs"), {}, registry, home), repo.dbPath);
    // The home fallback routes to the home store, not to the registry file.
    assert.equal(resolveDbForCwd(join(tmp, "outside"), {}, registry, home), home);

    const explicit = join(tmp, "explicit.sqlite3");
    const env = { RECALL_DB: explicit } as NodeJS.ProcessEnv;
    assert.equal(resolveDbForCwd(join(app.rootPath, "src"), env, registry, home), explicit);
    assert.equal(whereProject(join(app.rootPath, "src"), env, registry, home).scope, "explicit");
    assert.equal(whereProject(join(app.rootPath, "src"), {}, registry, home).scope, "project");
    const outside = whereProject(join(tmp, "outside"), {}, registry, home);
    assert.equal(outside.scope, "home");
    assert.equal(outside.dbPath, home);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("project routing canonicalizes symlinked roots and cwd paths", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "registry.sqlite3");
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
    const registry = join(tmp, "db", "registry.sqlite3");
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

test("localGraphPaths returns the home store first then registered project locals", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "registry.sqlite3");
    const home = join(tmp, "db", "home.sqlite3");
    const project = registerProject({ root: join(tmp, "repo"), slug: "repo" }, NOW, registry);
    const graphs = localGraphPaths({}, registry, home);

    assert.deepEqual(
      graphs.map((member) => member.graph),
      ["home", "repo"],
    );
    // The home graph member is the home store; the registry file itself is
    // pure metadata and never appears as a graph.
    assert.equal(graphs[0]?.path, home);
    assert.equal(graphs[1]?.path, project.dbPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a project slugged registry cannot claim the registry file as its db", () => {
  const tmp = tempDir();
  try {
    const registry = join(tmp, "db", "registry.sqlite3");
    const record = registerProject({ root: join(tmp, "registry") }, NOW, registry);
    assert.equal(record.slug, "registry");
    assert.equal(record.dbPath, join(tmp, "db", "project-registry.sqlite3"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("listProjects lazily migrates a legacy combined home.sqlite3 into registry.sqlite3", () => {
  const tmp = tempDir();
  try {
    // Old layout: the projects table lived inside home.sqlite3.
    const legacy = join(tmp, "db", "home.sqlite3");
    const record = registerProject({ root: join(tmp, "repo"), slug: "repo" }, NOW, legacy);

    const registry = join(tmp, "db", "registry.sqlite3");
    const projects = listProjects(registry);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.slug, "repo");
    assert.equal(projects[0]?.dbPath, record.dbPath);
    assert.ok(existsSync(registry));

    // Non-destructive: the legacy rows stay in home.sqlite3 so an older
    // binary pointed at the same RECALL_HOME keeps working.
    assert.equal(listProjects(legacy).length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("registerProject migrates legacy registry rows before adding new ones", () => {
  const tmp = tempDir();
  try {
    const legacy = join(tmp, "db", "home.sqlite3");
    const repoA = registerProject({ root: join(tmp, "repoA"), slug: "repo-a" }, NOW, legacy);

    const registry = join(tmp, "db", "registry.sqlite3");
    const repoB = registerProject(
      { root: join(tmp, "repoB"), slug: "repo-b" },
      "2026-06-26T12:01:00.000Z",
      registry,
    );

    const slugs = listProjects(registry)
      .map((project) => project.slug)
      .sort();
    assert.deepEqual(slugs, ["repo-a", "repo-b"]);
    assert.equal(resolveDbForSlug("repo-a", registry), repoA.dbPath);
    assert.equal(resolveDbForSlug("repo-b", registry), repoB.dbPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-routing-"));
}
