import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import { subgraphCells, type SubgraphFilter } from "./subgraph.js";
import type { Cell, Kind, Store } from "./types.js";

// A minimal Store stand-in that deliberately omits activeWhere, forcing
// subgraphCells down the app-side JS-filter branch. subgraphCells only calls
// store.active() on that branch, so the rest of Store is never touched; other
// members throw if something in subgraphCells ever comes to depend on them.
function withoutActiveWhere(store: { active(): Cell[] }): Store {
  return new Proxy(
    { active: () => store.active() },
    {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        throw new Error(`withoutActiveWhere stub: unexpected Store member accessed: ${String(prop)}`);
      },
      has(target, prop) {
        return prop in target;
      },
    },
  ) as unknown as Store;
}

// Helper: create and insert a cell of a given kind, mirroring pages.test.ts's
// seedCell pattern. lifecycle/quality/subject are set by direct tag mutation
// since buildCell/WriteProposal only carries topics/entities.
function seedCell(
  store: SqliteStore,
  kind: Kind,
  title: string,
  opts: {
    updatedAt?: string;
    project?: string;
    topics?: string[];
    entities?: string[];
    lifecycle?: string[];
    quality?: string[];
    subject?: string[];
  } = {},
): Cell {
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
  const stored = opts.updatedAt ? { ...cell, updatedAt: opts.updatedAt } : cell;
  if (opts.lifecycle) stored.tags = { ...stored.tags, lifecycle: opts.lifecycle };
  if (opts.quality) stored.tags = { ...stored.tags, quality: opts.quality };
  if (opts.subject) stored.tags = { ...stored.tags, subject: opts.subject };
  store.put(stored);
  return stored;
}

test("subgraphCells: AND semantics across topics and kind", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "match-both", { topics: ["alpha"], updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "obs", "wrong-kind", { topics: ["alpha"], updatedAt: "2026-01-02T00:00:00Z" });
  seedCell(store, "dec", "wrong-topic", { topics: ["beta"], updatedAt: "2026-01-03T00:00:00Z" });

  const filter: SubgraphFilter = { kinds: ["dec"], topics: ["alpha"] };
  const results = subgraphCells(store, filter);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "match-both");
  store.close();
});

test("subgraphCells: within-family conjunction requires every listed topic", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "has-both", { topics: ["alpha", "beta"], updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "has-one", { topics: ["alpha"], updatedAt: "2026-01-02T00:00:00Z" });

  const results = subgraphCells(store, { topics: ["alpha", "beta"] });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "has-both");
  store.close();
});

test("subgraphCells: within-family conjunction requires every listed entity", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "has-both", { entities: ["e1", "e2"], updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "has-one", { entities: ["e1"], updatedAt: "2026-01-02T00:00:00Z" });

  const results = subgraphCells(store, { entities: ["e1", "e2"] });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "has-both");
  store.close();
});

test("subgraphCells: since filters on updatedAt", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "old", { updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "mid", { updatedAt: "2026-06-01T00:00:00Z" });
  seedCell(store, "dec", "new", { updatedAt: "2026-07-01T00:00:00Z" });

  const results = subgraphCells(store, { since: "2026-05-01T00:00:00Z" });

  assert.deepEqual(results.map((c) => c.title), ["new", "mid"]);
  store.close();
});

test("subgraphCells: sorts updatedAt descending and slices to limit", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "a", { updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "b", { updatedAt: "2026-01-03T00:00:00Z" });
  seedCell(store, "dec", "c", { updatedAt: "2026-01-02T00:00:00Z" });

  const results = subgraphCells(store, { limit: 2 });

  assert.deepEqual(results.map((c) => c.title), ["b", "c"]);
  store.close();
});

test("subgraphCells: defaults limit to 50 when not provided", () => {
  const store = new SqliteStore();
  for (let i = 0; i < 60; i++) {
    seedCell(store, "dec", `item-${i}`, { updatedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z` });
  }
  const results = subgraphCells(store, {});
  assert.equal(results.length, 50);
  store.close();
});

test("subgraphCells: filters lifecycle, quality, subject families with AND conjunction", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "match", {
    lifecycle: ["handoff"],
    quality: ["verified"],
    subject: ["infra"],
    updatedAt: "2026-01-01T00:00:00Z",
  });
  seedCell(store, "dec", "missing-quality", {
    lifecycle: ["handoff"],
    subject: ["infra"],
    updatedAt: "2026-01-02T00:00:00Z",
  });

  const results = subgraphCells(store, { lifecycle: ["handoff"], quality: ["verified"], subject: ["infra"] });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "match");
  store.close();
});

test("subgraphCells: project filter matches scope.project", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "in-proj", { project: "proj-a", updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "other-proj", { project: "proj-b", updatedAt: "2026-01-02T00:00:00Z" });

  const results = subgraphCells(store, { project: "proj-a" });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "in-proj");
  store.close();
});

test("subgraphCells: excludes non-active (superseded) cells", () => {
  const store = new SqliteStore();
  const superseded = seedCell(store, "dec", "gone", { topics: ["alpha"] });
  store.put({ ...superseded, status: "superseded" });
  seedCell(store, "dec", "still-active", { topics: ["alpha"], updatedAt: "2026-01-02T00:00:00Z" });

  const results = subgraphCells(store, { topics: ["alpha"] });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "still-active");
  store.close();
});

test("golden: subgraphCells over SqliteStore equals the same filter applied app-side to store.active()", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "a", { topics: ["alpha", "beta"], project: "p1", updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "obs", "b", { topics: ["alpha"], project: "p1", updatedAt: "2026-02-01T00:00:00Z" });
  seedCell(store, "dec", "c", { topics: ["alpha", "beta"], project: "p2", updatedAt: "2026-03-01T00:00:00Z" });
  seedCell(store, "dec", "d", { entities: ["e1"], updatedAt: "2026-04-01T00:00:00Z" });
  seedCell(store, "dec", "e", { lifecycle: ["handoff"], updatedAt: "2026-05-01T00:00:00Z" });

  const filter: SubgraphFilter = { kinds: ["dec"], project: "p1", topics: ["alpha", "beta"] };

  // Fast path: activeWhere push-down inside subgraphCells (SqliteStore branch).
  const fast = subgraphCells(store, filter);

  // App-side reference: a Store-shaped wrapper without activeWhere, forcing
  // subgraphCells down the JS-filter branch, over the same data.
  const plainStore = withoutActiveWhere(store);
  const appSide = subgraphCells(plainStore, filter);

  assert.deepEqual(fast.map((c) => c.key).sort(), appSide.map((c) => c.key).sort());
  assert.deepEqual(fast.map((c) => c.key), appSide.map((c) => c.key)); // order too
  store.close();
});

test("golden: activeWhere kind/project push-down returns the same rows as the JS filter", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "a", { project: "p1", updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "obs", "b", { project: "p1", updatedAt: "2026-02-01T00:00:00Z" });
  seedCell(store, "dec", "c", { project: "p2", updatedAt: "2026-03-01T00:00:00Z" });

  const pushed = store.activeWhere({ kinds: ["dec"], project: "p1" });
  const jsFiltered = store
    .active()
    .filter((c) => c.kind === "dec" && c.scope.project === "p1")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  assert.deepEqual(pushed.map((c) => c.key), jsFiltered.map((c) => c.key));
  store.close();
});

test("subgraphCells: falls back to app-side filtering when the store lacks activeWhere", () => {
  const store = new SqliteStore();
  seedCell(store, "dec", "a", { topics: ["alpha"], updatedAt: "2026-01-01T00:00:00Z" });
  seedCell(store, "dec", "b", { topics: ["beta"], updatedAt: "2026-01-02T00:00:00Z" });

  const plainStore = withoutActiveWhere(store);

  const results = subgraphCells(plainStore, { topics: ["alpha"] });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "a");
  store.close();
});

test("golden: equal updatedAt breaks ties on key ascending, identically on both paths", () => {
  const store = new SqliteStore();
  // Three cells share the exact same updatedAt; insertion order is deliberately
  // scrambled relative to key order (dec-tie-charlie < dec-tie-mike < dec-tie-yankee)
  // so a passing test can't be explained by insertion order or SQLite's
  // unspecified tie order, only by the explicit key-ascending tie-break.
  const tiedAt = "2026-01-01T00:00:00Z";
  seedCell(store, "dec", "tie-yankee", { updatedAt: tiedAt });
  seedCell(store, "dec", "tie-charlie", { updatedAt: tiedAt });
  seedCell(store, "dec", "tie-mike", { updatedAt: tiedAt });
  seedCell(store, "dec", "newer", { updatedAt: "2026-01-02T00:00:00Z" });

  const expectedKeys = ["dec-newer", "dec-tie-charlie", "dec-tie-mike", "dec-tie-yankee"];

  // Fast path: SqliteStore.activeWhere push-down (ORDER BY updated_at DESC, key ASC).
  const fast = subgraphCells(store, {});
  assert.deepEqual(fast.map((c) => c.key), expectedKeys);

  // App-side fallback: same data, store shaped without activeWhere so
  // subgraphCells sorts with sortNewestFirst's JS tie-break instead.
  const plainStore = withoutActiveWhere(store);
  const appSide = subgraphCells(plainStore, {});
  assert.deepEqual(appSide.map((c) => c.key), expectedKeys);

  // Both paths must agree on the full order, not just the key set.
  assert.deepEqual(fast.map((c) => c.key), appSide.map((c) => c.key));
  store.close();
});
