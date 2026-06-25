import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  homeDbPath,
  listProjects,
  localGraphPaths,
  recallHomeDir,
  registerProject,
  removeProject,
  resolveCwdRouting,
  resolveDbForCwd,
  resolveDbForSlug,
  whereProject,
} from "../src/core/routing.js";
import { tempDbPath } from "./helpers.js";

test("registry CRUD plus cwd and slug routing", () => {
  const temp = tempDbPath();
  const g = temp.path;
  try {
    const rec = registerProject(
      {
        slug: "myproj",
        root: "/tmp/recall-route/myproj",
        dbPath: "/tmp/recall-route/myproj.sqlite3",
        description: "d",
      },
      "2026-06-22T00:00:00Z",
      g,
    );
    assert.equal(rec.slug, "myproj");
    assert.equal(rec.db_path, "/tmp/recall-route/myproj.sqlite3");

    // cwd under the registered root resolves to the project db (deepest match)
    assert.equal(resolveDbForCwd("/tmp/recall-route/myproj/sub/dir", {}, g), "/tmp/recall-route/myproj.sqlite3");
    // unrelated cwd falls back to the (test) global
    assert.equal(resolveDbForCwd("/tmp/somewhere-else", {}, g), g);
    // RECALL_DB env overrides the walk
    assert.equal(
      resolveDbForCwd("/tmp/recall-route/myproj", { RECALL_DB: "/custom/x.sqlite3" } as NodeJS.ProcessEnv, g),
      "/custom/x.sqlite3",
    );

    // slug resolution
    assert.equal(resolveDbForSlug("myproj", g), "/tmp/recall-route/myproj.sqlite3");
    assert.equal(resolveDbForSlug("nope", g), null);

    // list + where
    assert.equal(listProjects(g).some((p) => p.slug === "myproj"), true);
    const w = whereProject("/tmp/recall-route/myproj/x", {}, g);
    assert.equal(w.db, "/tmp/recall-route/myproj.sqlite3");
    assert.match(w.reason, /project root/);

    // remove
    assert.equal(removeProject("myproj", g), true);
    assert.equal(resolveDbForSlug("myproj", g), null);
  } finally {
    temp.cleanup();
  }
});

test("registerProject keeps colliding-basename slugs unique, reserves 'home', and is stable on re-register", () => {
  const temp = tempDbPath();
  const g = temp.path;
  try {
    const a = registerProject({ root: "/work/teamA/api" }, "2026-06-25T00:00:00Z", g);
    const b = registerProject({ root: "/work/teamB/api" }, "2026-06-25T00:00:00Z", g);
    assert.equal(a.slug, "api");
    assert.notEqual(b.slug, a.slug, "a colliding-basename root must get a distinct slug, not silently reuse 'api'");
    assert.notEqual(b.db_path, a.db_path);
    // slug routing now reaches BOTH projects deterministically (no wrong-project leak)
    assert.equal(resolveDbForSlug(a.slug, g), a.db_path);
    assert.equal(resolveDbForSlug(b.slug, g), b.db_path);
    // a project directory named 'home' must not claim the reserved home graph
    const h = registerProject({ root: "/work/home" }, "2026-06-25T00:00:00Z", g);
    assert.notEqual(h.slug, "home");
    // re-registering an existing root keeps its assigned slug stable
    const a2 = registerProject({ root: "/work/teamA/api" }, "2026-06-25T01:00:00Z", g);
    assert.equal(a2.slug, a.slug);
  } finally {
    temp.cleanup();
  }
});

test("missing registry yields global fallback and never throws", () => {
  assert.doesNotThrow(() =>
    resolveDbForCwd("/tmp/anything", {}, "/tmp/nonexistent-recall-global-xyz.sqlite3"),
  );
  assert.equal(resolveDbForSlug("x", "/tmp/nonexistent-recall-global-xyz.sqlite3"), null);
  assert.deepEqual(listProjects("/tmp/nonexistent-recall-global-xyz.sqlite3"), []);
});

test("homeDbPath honors RECALL_HOME and defaults under .recall", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-home-"));
  assert.equal(homeDbPath({ RECALL_HOME: home } as NodeJS.ProcessEnv), join(home, "db", "home.sqlite3"));
  assert.equal(recallHomeDir({ RECALL_HOME: home } as NodeJS.ProcessEnv), home);
  // Default (no RECALL_HOME): under ~/.recall/db/home.sqlite3.
  assert.match(homeDbPath({} as NodeJS.ProcessEnv), /[\\/]\.recall[\\/]db[\\/]home\.sqlite3$/);
});

test("resolveCwdRouting: explicit RECALL_DB, project under a registered root, home otherwise", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-home-"));
  // Point both the home local and the registry at this scratch home.
  const env = { RECALL_HOME: home } as NodeJS.ProcessEnv;
  const prevHome = process.env.RECALL_HOME;
  const prevGlobal = process.env.RECALL_GLOBAL_DB;
  // The registry resolves through globalDbPath() which reads the live process
  // env, so set it on the process for the duration of this test.
  process.env.RECALL_HOME = home;
  delete process.env.RECALL_GLOBAL_DB;
  try {
    const projectRoot = mkdtempSync(join(tmpdir(), "recall-proj-"));
    registerProject({ slug: "acme", root: projectRoot }, "2026-06-23T00:00:00Z");

    // explicit RECALL_DB wins, labeled "explicit".
    const explicit = resolveCwdRouting(projectRoot, {
      RECALL_HOME: home,
      RECALL_DB: "/custom/pin.sqlite3",
    } as NodeJS.ProcessEnv);
    assert.equal(explicit.scope, "explicit");
    assert.equal(explicit.dbPath, "/custom/pin.sqlite3");

    // cwd under the registered root -> project scope, that project's local.
    const inProject = resolveCwdRouting(join(projectRoot, "sub", "dir"), env);
    assert.equal(inProject.scope, "project");
    assert.equal(inProject.slug, "acme");
    assert.equal(inProject.dbPath, join(home, "db", "acme.sqlite3"));

    // unrelated cwd -> home scope, the home local.
    const outside = resolveCwdRouting("/tmp/unrelated-elsewhere", env);
    assert.equal(outside.scope, "home");
    assert.equal(outside.dbPath, join(home, "db", "home.sqlite3"));

    // localGraphPaths: home first, then registered locals.
    const locals = localGraphPaths(env);
    assert.equal(locals[0]!.graph, "home");
    assert.equal(locals[0]!.path, join(home, "db", "home.sqlite3"));
    assert.ok(
      locals.some((m) => m.graph === "acme" && m.path === join(home, "db", "acme.sqlite3")),
      `expected acme local in ${JSON.stringify(locals)}`,
    );

    removeProject("acme");
  } finally {
    if (prevHome === undefined) delete process.env.RECALL_HOME;
    else process.env.RECALL_HOME = prevHome;
    if (prevGlobal === undefined) delete process.env.RECALL_GLOBAL_DB;
    else process.env.RECALL_GLOBAL_DB = prevGlobal;
  }
});
