import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import {
  buildPageIndex,
  getRecallPage,
  type PageName,
  type PageFilter,
} from "./pages.js";

// Helper: create and insert a cell of a given kind at the given updatedAt time.
function seedCell(
  store: SqliteStore,
  kind: string,
  title: string,
  opts: {
    updatedAt?: string;
    project?: string;
    topics?: string[];
    entities?: string[];
    lifecycle?: string[];
  } = {},
) {
  const cell = buildCell(
    {
      kind,
      title,
      body: "seed",
      confidence: 0.8,
      topics: opts.topics ?? [],
      entities: opts.entities ?? [],
      project: opts.project ?? "default",
    },
    { key: `${kind}-${title.replace(/\s/g, "-")}` },
  );
  // Override updatedAt if requested (test-only time travel).
  const stored = opts.updatedAt ? { ...cell, updatedAt: opts.updatedAt } : cell;
  if (opts.lifecycle) {
    stored.tags = { ...stored.tags, lifecycle: opts.lifecycle };
  }
  store.put(stored);
  return stored;
}

test("getRecallPage reflections returns only kind=ref cells", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "retro-1");
  seedCell(store, "ref", "retro-2");
  seedCell(store, "obj", "goal-1");
  seedCell(store, "bel", "belief-1");

  const page = getRecallPage("reflections", store);
  assert.equal(page.name, "reflections");
  assert.ok(page.cells.every((c) => c.kind === "ref"), "all cells must be ref");
  assert.equal(page.cells.length, 2);
});

test("getRecallPage objectives returns obj, tsk, rsk cells", () => {
  const store = new SqliteStore();
  seedCell(store, "obj", "goal-a");
  seedCell(store, "tsk", "task-a");
  seedCell(store, "rsk", "risk-a");
  seedCell(store, "ref", "retro-x");
  seedCell(store, "hyp", "hyp-x");

  const page = getRecallPage("objectives", store);
  assert.ok(
    page.cells.every((c) => ["obj", "tsk", "rsk"].includes(c.kind)),
    "only obj/tsk/rsk",
  );
  assert.equal(page.cells.length, 3);
});

test("getRecallPage workbench returns hyp, bel, rsk cells", () => {
  const store = new SqliteStore();
  seedCell(store, "hyp", "hypothesis-1");
  seedCell(store, "bel", "belief-1");
  seedCell(store, "rsk", "risk-1");
  seedCell(store, "dec", "decision-1");

  const page = getRecallPage("workbench", store);
  assert.ok(
    page.cells.every((c) => ["hyp", "bel", "rsk"].includes(c.kind)),
    "only hyp/bel/rsk",
  );
  assert.equal(page.cells.length, 3);
});

test("getRecallPage witnesses returns obs cells", () => {
  const store = new SqliteStore();
  seedCell(store, "obs", "witness-1");
  seedCell(store, "obs", "witness-2");
  seedCell(store, "bel", "belief-x");

  const page = getRecallPage("witnesses", store);
  assert.ok(page.cells.every((c) => c.kind === "obs"), "only obs");
  assert.equal(page.cells.length, 2);
});

test("getRecallPage handoffs returns obs cells gated on lifecycle=handoff", () => {
  const store = new SqliteStore();
  seedCell(store, "obs", "handoff-1", { lifecycle: ["handoff"] });
  seedCell(store, "obs", "handoff-2", { lifecycle: ["handoff", "session"] });
  seedCell(store, "obs", "plain-obs", { lifecycle: ["active"] });
  seedCell(store, "obs", "no-lifecycle");

  const page = getRecallPage("handoffs", store);
  assert.ok(
    page.cells.every(
      (c) =>
        c.kind === "obs" &&
        Array.isArray(c.tags.lifecycle) &&
        c.tags.lifecycle.some((l) => ["handoff", "session"].includes(l)),
    ),
    "only obs with lifecycle handoff or session",
  );
  assert.equal(page.cells.length, 2);
});

test("getRecallPage team-metrics returns ver and bel cells", () => {
  const store = new SqliteStore();
  seedCell(store, "ver", "eval-run-1");
  seedCell(store, "bel", "calibration-1");
  seedCell(store, "obj", "goal-x");

  const page = getRecallPage("team-metrics", store);
  assert.ok(
    page.cells.every((c) => ["ver", "bel"].includes(c.kind)),
    "only ver/bel",
  );
  assert.equal(page.cells.length, 2);
});

test("getRecallPage agent-profile returns bel cells gated on entities tag", () => {
  const store = new SqliteStore();
  seedCell(store, "bel", "agent-identity", { entities: ["agent:claude", "model:sonnet"] });
  seedCell(store, "bel", "plain-belief");

  const page = getRecallPage("agent-profile", store);
  assert.equal(page.cells.length, 1);
  assert.ok(
    page.cells.every((c) => c.kind === "bel" && c.tags.entities.length > 0),
    "only bel with entities",
  );
});

test("getRecallPage user-profile returns bel cells gated on entities tag", () => {
  const store = new SqliteStore();
  seedCell(store, "bel", "user-profile-bel", { entities: ["user:alice"] });
  seedCell(store, "bel", "bare-bel");

  const page = getRecallPage("user-profile", store);
  assert.equal(page.cells.length, 1);
});

test("since filter excludes cells with older updatedAt", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "old-retro", { updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "ref", "new-retro", { updatedAt: "2026-06-01T00:00:00Z" });

  const filter: PageFilter = { since: "2026-03-01T00:00:00Z" };
  const page = getRecallPage("reflections", store, filter);
  assert.equal(page.cells.length, 1);
  assert.equal(page.cells[0]!.title, "new-retro");
});

test("project filter narrows by scope.project app-side", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "retro-p1", { project: "alpha" });
  seedCell(store, "ref", "retro-p2", { project: "beta" });

  const page = getRecallPage("reflections", store, { project: "alpha" });
  assert.equal(page.cells.length, 1);
  assert.equal(page.cells[0]!.scope.project, "alpha");
});

test("limit filter caps result length", () => {
  const store = new SqliteStore();
  for (let i = 0; i < 10; i++) seedCell(store, "ref", `retro-${i}`);

  const page = getRecallPage("reflections", store, { limit: 3 });
  assert.equal(page.cells.length, 3);
});

test("buildPageIndex per-kind counts match store.active() totals", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "r1");
  seedCell(store, "ref", "r2");
  seedCell(store, "obj", "o1");
  seedCell(store, "bel", "b1");
  seedCell(store, "ver", "v1");
  seedCell(store, "hyp", "h1");

  const idx = buildPageIndex(store);
  assert.equal(idx.kindCounts["ref"], 2);
  assert.equal(idx.kindCounts["obj"], 1);
  assert.equal(idx.kindCounts["bel"], 1);
  assert.equal(idx.kindCounts["ver"], 1);
  assert.equal(idx.kindCounts["hyp"], 1);
  assert.ok(typeof idx.stats.activeCells === "number");
  assert.equal(idx.plannerHint, "");
});

test("buildPageIndex top projects and topics are correct", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "r-alpha-1", { project: "alpha", topics: ["perf"] });
  seedCell(store, "ref", "r-alpha-2", { project: "alpha", topics: ["perf", "mem"] });
  seedCell(store, "obj", "o-beta", { project: "beta", topics: ["mem"] });

  const idx = buildPageIndex(store);
  const topProject = idx.topProjects[0];
  assert.ok(topProject, "should have at least one project");
  assert.equal(topProject.project, "alpha");
  assert.equal(topProject.count, 2);

  const topTopic = idx.topTopics[0];
  assert.ok(topTopic, "should have at least one topic");
  assert.equal(topTopic.topic, "perf");
});

// Compile-time exhaustiveness: if PageName union had unknown keys,
// the type system would catch them. We cover all dispatched page names here.
test("all valid page names dispatch without throwing", () => {
  const store = new SqliteStore();
  const names: PageName[] = [
    "index",
    "reflections",
    "objectives",
    "workbench",
    "witnesses",
    "handoffs",
    "team-metrics",
    "agent-profile",
    "user-profile",
  ];
  for (const name of names) {
    assert.doesNotThrow(() => getRecallPage(name, store));
  }
});
