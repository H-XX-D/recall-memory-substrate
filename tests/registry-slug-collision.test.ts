import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, registerProject, resolveDbForCwd } from "../src/core/routing.js";
import { tempDbPath } from "./helpers.js";

// Two roots with the SAME directory basename ("api") must not collide onto one
// DB. Before FIX 3 both slugified to "api", mapped to .../api.sqlite3, and the
// second init overwrote the first's registry row so both read each other's cells.
test("two different roots with a colliding basename get distinct db_paths (FIX 3)", () => {
  const registry = tempDbPath();
  const g = registry.path;
  const base = mkdtempSync(join(tmpdir(), "recall-collision-"));
  const rootA = join(base, "teamA", "api");
  const rootB = join(base, "teamB", "api");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  try {
    const a = registerProject({ root: rootA }, "2026-06-23T00:00:00Z", g);
    const b = registerProject({ root: rootB }, "2026-06-23T00:00:01Z", g);

    // DISTINCT slugs AND distinct db files. The slug is both the MCP routing key
    // and the federated graph prefix, so the colliding basename is disambiguated
    // at both layers; the second never overwrote the first.
    assert.equal(a.slug, "api");
    assert.notEqual(b.slug, "api", "the colliding root must get a distinct slug, not silently reuse 'api'");
    assert.notEqual(a.db_path, b.db_path, "colliding basenames must map to different db_paths");

    // Both rows survive (the second did not overwrite the first's registry row).
    const projects = listProjects(g);
    assert.equal(projects.length, 2, `expected both roots registered, got ${JSON.stringify(projects)}`);
    const byRoot = new Map(projects.map((p) => [p.root_path, p.db_path]));
    assert.equal(byRoot.get(a.root_path), a.db_path);
    assert.equal(byRoot.get(b.root_path), b.db_path);

    // Each resolves to its own db from its own cwd.
    assert.equal(resolveDbForCwd(join(rootA, "src"), {}, g), a.db_path);
    assert.equal(resolveDbForCwd(join(rootB, "src"), {}, g), b.db_path);

    // Re-registering the SAME root is idempotent: same db_path, no new row, never
    // re-points the other root's db.
    const aAgain = registerProject({ root: rootA, description: "updated" }, "2026-06-23T00:00:02Z", g);
    assert.equal(aAgain.db_path, a.db_path, "re-registering the same root keeps its db_path");
    assert.equal(listProjects(g).length, 2, "re-register must not add a row");
    assert.equal(resolveDbForCwd(join(rootB, "src"), {}, g), b.db_path, "root B's db must be untouched");
  } finally {
    registry.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});
