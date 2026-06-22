import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listProjects,
  registerProject,
  removeProject,
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

test("missing registry yields global fallback and never throws", () => {
  assert.doesNotThrow(() =>
    resolveDbForCwd("/tmp/anything", {}, "/tmp/nonexistent-recall-global-xyz.sqlite3"),
  );
  assert.equal(resolveDbForSlug("x", "/tmp/nonexistent-recall-global-xyz.sqlite3"), null);
  assert.deepEqual(listProjects("/tmp/nonexistent-recall-global-xyz.sqlite3"), []);
});
