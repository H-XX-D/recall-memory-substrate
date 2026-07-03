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
import type { Cell, Store } from "./types.js";

// A minimal Store stand-in that deliberately omits activeByProject, forcing
// getRecallPage/buildPageIndex down the store.active() + app-side filter
// branch, mirroring subgraph.test.ts's withoutActiveWhere. Other Store
// members throw if pages.ts ever comes to depend on them.
function withoutActiveByProject(store: { active(): Cell[]; stats(): ReturnType<Store["stats"]> }): Store {
  return new Proxy(
    { active: () => store.active(), stats: () => store.stats() },
    {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        throw new Error(`withoutActiveByProject stub: unexpected Store member accessed: ${String(prop)}`);
      },
      has(target, prop) {
        return prop in target;
      },
    },
  ) as unknown as Store;
}

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

test("getRecallPage calls activeByProject (not active) when filter.project is set and the store supports it", () => {
  const store = new SqliteStore();
  seedCell(store, "obj", "goal-p1", { project: "p1" });
  seedCell(store, "obj", "goal-p2", { project: "p2" });

  let activeByProjectCalls = 0;
  let activeCalls = 0;
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "activeByProject") {
        activeByProjectCalls++;
      } else if (prop === "active") {
        activeCalls++;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as SqliteStore;

  const page = getRecallPage("objectives", spy, { project: "p1" });
  assert.equal(page.cells.length, 1);
  assert.equal(activeByProjectCalls, 1, "activeByProject should be called once");
  assert.equal(activeCalls, 0, "active() should not be called on the push-down path");
  store.close();
});

test("golden: getRecallPage over SqliteStore with a project filter equals the same call against a store lacking activeByProject", () => {
  const store = new SqliteStore();
  seedCell(store, "obj", "goal-p1-a", { project: "p1", updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "tsk", "task-p1-b", { project: "p1", updatedAt: "2026-02-01T00:00:00Z" });
  seedCell(store, "rsk", "risk-p1-c", { project: "p1", updatedAt: "2026-03-01T00:00:00Z" });
  seedCell(store, "obj", "goal-p2", { project: "p2", updatedAt: "2026-04-01T00:00:00Z" });
  seedCell(store, "ref", "retro-p1", { project: "p1", updatedAt: "2026-05-01T00:00:00Z" }); // wrong kind

  const filter: PageFilter = { project: "p1" };

  // Fast path: activeByProject push-down inside getRecallPage (SqliteStore branch).
  const fast = getRecallPage("objectives", store, filter);

  // App-side reference: a Store-shaped wrapper without activeByProject, forcing
  // getRecallPage down the store.active() + applyFilter branch, over the same data.
  const plainStore = withoutActiveByProject(store);
  const appSide = getRecallPage("objectives", plainStore, filter);

  assert.deepEqual(fast.cells.map((c) => c.key), appSide.cells.map((c) => c.key));
  assert.equal(fast.cells.length, 3);
  store.close();
});

test("golden: getRecallPage honors since together with project on both the push-down and app-side paths", () => {
  const store = new SqliteStore();
  seedCell(store, "obj", "old-goal", { project: "p1", updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "obj", "new-goal", { project: "p1", updatedAt: "2026-06-01T00:00:00Z" });
  seedCell(store, "obj", "other-project", { project: "p2", updatedAt: "2026-06-01T00:00:00Z" });

  const filter: PageFilter = { project: "p1", since: "2026-03-01T00:00:00Z" };

  const fast = getRecallPage("objectives", store, filter);
  const plainStore = withoutActiveByProject(store);
  const appSide = getRecallPage("objectives", plainStore, filter);

  assert.deepEqual(fast.cells.map((c) => c.key), appSide.cells.map((c) => c.key));
  assert.equal(fast.cells.length, 1);
  assert.equal(fast.cells[0]!.title, "new-goal");
  store.close();
});

test("golden: buildPageIndex is unaffected by activeByProject availability (no project filter applies)", () => {
  const store = new SqliteStore();
  seedCell(store, "ref", "r1", { project: "p1" });
  seedCell(store, "obj", "o1", { project: "p2" });

  const fast = buildPageIndex(store);
  const plainStore = withoutActiveByProject(store);
  const appSide = buildPageIndex(plainStore);

  assert.deepEqual(fast.kindCounts, appSide.kindCounts);
  assert.deepEqual(fast.topProjects, appSide.topProjects);
  store.close();
});

test("getRecallPage still applies topics filter and kind remap after activeByProject seeds the pool", () => {
  const store = new SqliteStore();
  seedCell(store, "obj", "goal-alpha", { project: "p1", topics: ["alpha"] });
  seedCell(store, "obj", "goal-beta", { project: "p1", topics: ["beta"] });
  seedCell(store, "ref", "retro-alpha", { project: "p1", topics: ["alpha"] }); // wrong kind, same project

  const page = getRecallPage("objectives", store, { project: "p1", topics: ["alpha"] });
  assert.equal(page.cells.length, 1);
  assert.equal(page.cells[0]!.title, "goal-alpha");
  store.close();
});

test("getRecallPage with project + limit still caps app-side after activeByProject seeds the pool", () => {
  const store = new SqliteStore();
  for (let i = 0; i < 5; i++) seedCell(store, "ref", `retro-${i}`, { project: "p1" });

  const page = getRecallPage("reflections", store, { project: "p1", limit: 2 });
  assert.equal(page.cells.length, 2);
  store.close();
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
