import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, contentKey } from "./store.js";
import { buildCell } from "./build.js";

function tempDbDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-storage-stats-"));
}

test("put then get round-trips a cell by key", () => {
  const store = new SqliteStore(":memory:");
  const cell = buildCell(
    { kind: "dec", title: "add watchdog", body: "b", confidence: 0.7 },
    { key: "a3ee1234" },
  );
  store.put(cell);

  const got = store.get("a3ee1234");
  assert.equal(got?.key, "a3ee1234");
  assert.equal(got?.title, "add watchdog");
  assert.equal(got?.kind, "dec");
  assert.equal(got?.scores.conf, 0.7);
  assert.equal(got?.status, "active");
  store.close();
});

test("put/get round-trips edges, which live only in the edges table", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell(
    { kind: "dec", title: "A", body: "b", confidence: 0.8, edges: [{ relation: "supports", target: "bbbb" }] },
    { key: "aaaa" },
  );
  store.put(a);
  const got = store.get("aaaa")!;
  assert.equal(got.edgesOut.length, 1);
  assert.equal(got.edgesOut[0]!.target, "bbbb");
  assert.equal(got.edgesOut[0]!.weight, 1); // signed by relation
  store.close();
});

test("neighbors returns incident links in both directions with the connected cell", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell(
    { kind: "dec", title: "A", body: "b", confidence: 0.8, edges: [{ relation: "supports", target: "bbbb" }] },
    { key: "aaaa" },
  );
  const b = buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.6 }, { key: "bbbb" });
  store.put(a);
  store.put(b);

  const out = store.neighbors("aaaa");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.direction, "out");
  assert.equal(out[0]!.cell.key, "bbbb");

  const inc = store.neighbors("bbbb");
  assert.equal(inc.length, 1);
  assert.equal(inc[0]!.direction, "in");
  assert.equal(inc[0]!.cell.key, "aaaa");
  store.close();
});

test("findByContentKey matches an active cell by kind + normalized title", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "Add Watchdog", body: "b", confidence: 0.7 }, { key: "aaaa" });
  store.put(a);
  // case- and whitespace-insensitive content fingerprint
  assert.equal(store.findByContentKey("dec", contentKey("dec", "  add   watchdog "))?.key, "aaaa");
  assert.equal(store.findByContentKey("obs", contentKey("obs", "Add Watchdog")), undefined);
  store.close();
});

test("getByHandle and active() resolve the cell", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);
  assert.equal(store.getByHandle(a.handle)?.key, "aaaa");
  assert.equal(store.active().length, 1);
  store.close();
});

test("search returns active lexical hits from the store backend", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "watchdog tripwire", body: "eff monitor", confidence: 0.7 }, { key: "hit" }));
  const stale = buildCell({ kind: "obs", title: "watchdog stale", body: "old", confidence: 0.7 }, { key: "old" });
  stale.status = "superseded";
  store.put(stale);
  store.put(buildCell({ kind: "obs", title: "banana", body: "fruit", confidence: 0.7 }, { key: "miss" }));

  const hits = store.search("watchdog tripwire");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.cell.key, "hit");
  assert.equal(hits[0]!.backend, store.lexicalBackend());
  assert.ok(hits[0]!.score >= 0);
  store.close();
});

// Golden regression: store.search must return identical hit keys after swapping
// the private ftsMatchQuery helper to use buildFtsMatchQuery from retrieval.ts.
test("golden: store.search returns same hits before and after buildFtsMatchQuery swap", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "py-sym:foo watchdog monitor", body: "circuit breaker", confidence: 0.9 }, { key: "cell-a" }));
  store.put(buildCell({ kind: "obs", title: "tripwire sentinel loop", body: "alert pipeline", confidence: 0.8 }, { key: "cell-b" }));
  store.put(buildCell({ kind: "obs", title: "banana orange", body: "fruit salad", confidence: 0.7 }, { key: "cell-c" }));

  // Query 1: symbol-like token with punctuation
  const hitsA = store.search("py-sym:foo");
  assert.ok(hitsA.length >= 1, "should find at least one hit for py-sym:foo");
  assert.ok(hitsA.some((h) => h.cell.key === "cell-a"), "cell-a must be in results for py-sym:foo");

  // Query 2: multi-word
  const hitsB = store.search("watchdog monitor");
  assert.ok(hitsB.some((h) => h.cell.key === "cell-a"), "cell-a must be in results for watchdog monitor");

  // Query 3: unrelated query should not surface fruit cell in top hit for watchdog
  const hitsC = store.search("tripwire sentinel");
  assert.ok(hitsC.some((h) => h.cell.key === "cell-b"), "cell-b must be in results for tripwire sentinel");

  store.close();
});

test("stats reports cells, active cells, edges, and lexical indexing state", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "A", body: "a", confidence: 0.7 }, { key: "aaaa" }));
  store.put(
    buildCell(
      { kind: "obs", title: "B", body: "b", confidence: 0.7, edges: [{ relation: "supports", target: "aaaa" }] },
      { key: "bbbb" },
    ),
  );

  const stats = store.stats();
  assert.equal(stats.cells, 2);
  assert.equal(stats.activeCells, 2);
  assert.equal(stats.edges, 1);
  assert.equal(stats.lexicalBackend, store.lexicalBackend());
  if (stats.lexicalBackend === "fts5-bm25") {
    assert.equal(stats.indexedCells, 2);
  }
  store.close();
});

test("store round-trips a hyperedge", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "h1", kind: "cluster", title: "t",
    members: [{ key: "a", role: "member", ordinal: 0 }, { key: "b", role: "member", ordinal: 1 }],
    metadata: { n: 1 }, createdAt: "2026-07-03T00:00:00Z",
  });
  const all = store.listHyperedges();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.members, [
    { key: "a", role: "member", ordinal: 0 },
    { key: "b", role: "member", ordinal: 1 },
  ]);
  assert.equal(all[0]!.metadata.n, 1);
  store.close();
});

test("getHyperedge resolves an exact id", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "11111111-2222-3333-4444-555555555555", kind: "cluster", title: "t",
    members: [{ key: "a", role: "member", ordinal: 0 }],
    metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getHyperedge("11111111-2222-3333-4444-555555555555");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  store.close();
});

test("getHyperedge resolves a unique 8-char prefix", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "11111111-2222-3333-4444-555555555555", kind: "cluster", title: "t",
    members: [], metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getHyperedge("11111111");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  store.close();
});

test("getHyperedge returns undefined for an ambiguous prefix", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "aaaaaaaa-2222-3333-4444-555555555555", kind: "cluster", title: "t1",
    members: [], metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  store.putHyperedge({
    id: "aaaaaaab-2222-3333-4444-555555555555", kind: "cluster", title: "t2",
    members: [], metadata: {}, createdAt: "2026-07-03T00:00:01Z",
  });
  assert.equal(store.getHyperedge("aaaaaaa"), undefined);
  store.close();
});

test("getHyperedge returns undefined for an unknown id", () => {
  const store = new SqliteStore(":memory:");
  assert.equal(store.getHyperedge("does-not-exist"), undefined);
  store.close();
});

test("hyperedgesForCell finds membership by exact key and respects limit", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "h1", kind: "cluster", title: "one",
    members: [{ key: "a", role: "member", ordinal: 0 }, { key: "b", role: "member", ordinal: 1 }],
    metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  store.putHyperedge({
    id: "h2", kind: "cluster", title: "two",
    members: [{ key: "b", role: "member", ordinal: 0 }],
    metadata: {}, createdAt: "2026-07-03T00:00:01Z",
  });
  store.putHyperedge({
    id: "h3", kind: "cluster", title: "three",
    members: [{ key: "c", role: "member", ordinal: 0 }],
    metadata: {}, createdAt: "2026-07-03T00:00:02Z",
  });

  const forB = store.hyperedgesForCell("b");
  assert.deepEqual(forB.map((h) => h.id).sort(), ["h1", "h2"]);

  const forBLimited = store.hyperedgesForCell("b", 1);
  assert.equal(forBLimited.length, 1);

  assert.deepEqual(store.hyperedgesForCell("c").map((h) => h.id), ["h3"]);
  assert.deepEqual(store.hyperedgesForCell("nope"), []);
  store.close();
});

test("hyperedgesForCell does not match a key that is only a JSON-string substring of another key", () => {
  const store = new SqliteStore(":memory:");
  store.putHyperedge({
    id: "h1", kind: "cluster", title: "one",
    members: [{ key: "abcdef", role: "member", ordinal: 0 }],
    metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  // "cde" is a substring of "abcdef" but must not match on exact-key semantics.
  assert.deepEqual(store.hyperedgesForCell("cde"), []);
  store.close();
});

test("listHyperedges normalizes a raw legacy-shaped members array written directly to the db", () => {
  const store = new SqliteStore(":memory:");
  // Simulate a pre-normalizer row: members_json holds legacy {nodeId, role, weight}
  // objects, exactly what an already-migrated store could still hold on disk.
  const raw = [{ nodeId: "n1", role: "driver", weight: 0.5 }, "k2"];
  (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
    .prepare(
      `INSERT OR REPLACE INTO hyperedges (id, kind, title, members_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("h2", "cluster", "legacy shape", JSON.stringify(raw), JSON.stringify({}), "2026-07-03T00:00:00Z");

  const all = store.listHyperedges();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.members, [
    { key: "n1", role: "driver", ordinal: 0, weight: 0.5 },
    { key: "k2", role: "member", ordinal: 1 },
  ]);
  store.close();
});

test("store round-trips a semantic vector and a dag overlay", () => {
  const store = new SqliteStore(":memory:");
  store.putSemanticVector({ nodeId: "a", backend: "hash", dims: 3, vector: [0.1, 0.2, 0.3], indexedAt: "2026-07-03T00:00:00Z" });
  const v = store.getSemanticVector("a");
  assert.equal(v?.dims, 3);
  assert.deepEqual(v?.vector, [0.1, 0.2, 0.3]);
  store.putDagOverlay({ id: "d1", title: "t", nodeIds: ["a"], edges: [{ source: "a", target: "b" }], metadata: {}, createdAt: "2026-07-03T00:00:00Z" });
  assert.equal(store.listDagOverlays().length, 1);
  store.close();
});

test("getDagOverlay resolves an exact id", () => {
  const store = new SqliteStore(":memory:");
  store.putDagOverlay({
    id: "11111111-2222-3333-4444-555555555555", title: "t",
    nodeIds: ["a"], edges: [], metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getDagOverlay("11111111-2222-3333-4444-555555555555");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  store.close();
});

test("getDagOverlay resolves a unique 8-char prefix", () => {
  const store = new SqliteStore(":memory:");
  store.putDagOverlay({
    id: "11111111-2222-3333-4444-555555555555", title: "t",
    nodeIds: ["a"], edges: [], metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getDagOverlay("11111111");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  store.close();
});

test("getDagOverlay returns undefined for an ambiguous prefix", () => {
  const store = new SqliteStore(":memory:");
  store.putDagOverlay({
    id: "aaaaaaaa-2222-3333-4444-555555555555", title: "t1",
    nodeIds: [], edges: [], metadata: {}, createdAt: "2026-07-03T00:00:00Z",
  });
  store.putDagOverlay({
    id: "aaaaaaab-2222-3333-4444-555555555555", title: "t2",
    nodeIds: [], edges: [], metadata: {}, createdAt: "2026-07-03T00:00:01Z",
  });
  assert.equal(store.getDagOverlay("aaaaaaa"), undefined);
  store.close();
});

test("getDagOverlay returns undefined for an unknown id", () => {
  const store = new SqliteStore(":memory:");
  assert.equal(store.getDagOverlay("does-not-exist"), undefined);
  store.close();
});

test("cellsCreatedSince filters and orders by the generated created_at column", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "old", body: "x", confidence: 0.7 }, { key: "o", now: "2026-01-01T00:00:00Z" }));
  store.put(buildCell({ kind: "obs", title: "mid", body: "x", confidence: 0.7 }, { key: "m", now: "2026-06-01T00:00:00Z" }));
  store.put(buildCell({ kind: "obs", title: "new", body: "x", confidence: 0.7 }, { key: "n", now: "2026-07-01T00:00:00Z" }));
  const recent = store.cellsCreatedSince("2026-05-01T00:00:00Z");
  assert.deepEqual(recent.map((c) => c.key), ["n", "m"]); // DESC by created_at, old excluded
  store.close();
});

test("activeWhere pushes kind/project/since predicates into SQL and orders newest-updated first", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "a", body: "x", confidence: 0.7, project: "p1" }, { key: "a" });
  store.put({ ...a, updatedAt: "2026-05-01T00:00:00Z" });
  const b = buildCell({ kind: "dec", title: "b", body: "x", confidence: 0.7, project: "p1" }, { key: "b" });
  store.put({ ...b, updatedAt: "2026-06-01T00:00:00Z" });
  const c = buildCell({ kind: "obs", title: "c", body: "x", confidence: 0.7, project: "p1" }, { key: "c" });
  store.put({ ...c, updatedAt: "2026-07-01T00:00:00Z" });
  const d = buildCell({ kind: "dec", title: "d", body: "x", confidence: 0.7, project: "p2" }, { key: "d" });
  store.put({ ...d, updatedAt: "2026-08-01T00:00:00Z" });

  const rows = store.activeWhere({ kinds: ["dec"], project: "p1" });
  assert.deepEqual(rows.map((r) => r.key), ["b", "a"]); // newest first, kind+project both applied
  store.close();
});

test("activeWhere excludes non-active cells", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "a", body: "x", confidence: 0.7 }, { key: "a" });
  store.put(a);
  store.put({ ...a, status: "superseded" });
  const rows = store.activeWhere({});
  assert.equal(rows.length, 0);
  store.close();
});

test("activeWhere filters on since >= updated_at", () => {
  const store = new SqliteStore(":memory:");
  const old = buildCell({ kind: "dec", title: "old", body: "x", confidence: 0.7 }, { key: "old" });
  store.put({ ...old, updatedAt: "2026-01-01T00:00:00Z" });
  const recent = buildCell({ kind: "dec", title: "recent", body: "x", confidence: 0.7 }, { key: "recent" });
  store.put({ ...recent, updatedAt: "2026-07-01T00:00:00Z" });

  const rows = store.activeWhere({ since: "2026-05-01T00:00:00Z" });
  assert.deepEqual(rows.map((r) => r.key), ["recent"]);
  store.close();
});

test("activeWhere applies LIMIT only when the caller passes it", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.put(buildCell({ kind: "dec", title: `t${i}`, body: "x", confidence: 0.7 }, { key: `k${i}` }));
  }
  const limited = store.activeWhere({ limit: 2 });
  assert.equal(limited.length, 2);
  const unlimited = store.activeWhere({});
  assert.equal(unlimited.length, 5);
  store.close();
});

test("activeByProject returns only that project's active cells, newest-updated first", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "a", body: "x", confidence: 0.7, project: "p1" }, { key: "a" });
  store.put({ ...a, updatedAt: "2026-05-01T00:00:00Z" });
  const b = buildCell({ kind: "obs", title: "b", body: "x", confidence: 0.7, project: "p1" }, { key: "b" });
  store.put({ ...b, updatedAt: "2026-06-01T00:00:00Z" });
  const c = buildCell({ kind: "dec", title: "c", body: "x", confidence: 0.7, project: "p2" }, { key: "c" });
  store.put({ ...c, updatedAt: "2026-07-01T00:00:00Z" });
  const d = buildCell({ kind: "dec", title: "d", body: "x", confidence: 0.7, project: "p1" }, { key: "d" });
  store.put({ ...d, status: "superseded" });

  const rows = store.activeByProject("p1");
  assert.deepEqual(rows.map((r) => r.key), ["b", "a"]); // p2 and superseded excluded, newest first
  store.close();
});

test("activeByProject honors since >= updated_at", () => {
  const store = new SqliteStore(":memory:");
  const old = buildCell({ kind: "dec", title: "old", body: "x", confidence: 0.7, project: "p1" }, { key: "old" });
  store.put({ ...old, updatedAt: "2026-01-01T00:00:00Z" });
  const recent = buildCell({ kind: "dec", title: "recent", body: "x", confidence: 0.7, project: "p1" }, { key: "recent" });
  store.put({ ...recent, updatedAt: "2026-07-01T00:00:00Z" });

  const rows = store.activeByProject("p1", { since: "2026-05-01T00:00:00Z" });
  assert.deepEqual(rows.map((r) => r.key), ["recent"]);
  store.close();
});

test("activeByProject applies LIMIT only when the caller passes it", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.put(buildCell({ kind: "dec", title: `t${i}`, body: "x", confidence: 0.7, project: "p1" }, { key: `k${i}` }));
  }
  const limited = store.activeByProject("p1", { limit: 2 });
  assert.equal(limited.length, 2);
  const unlimited = store.activeByProject("p1");
  assert.equal(unlimited.length, 5);
  store.close();
});

test("listSemanticVectorIds returns all stored node_ids", () => {
  const store = new SqliteStore(":memory:");
  const ts = "2026-07-03T00:00:00Z";
  store.putSemanticVector({ nodeId: "id-a", backend: "cosine", dims: 2, vector: [0.1, 0.2], indexedAt: ts });
  store.putSemanticVector({ nodeId: "id-b", backend: "cosine", dims: 2, vector: [0.3, 0.4], indexedAt: ts });
  store.putSemanticVector({ nodeId: "id-c", backend: "cosine", dims: 2, vector: [0.5, 0.6], indexedAt: ts });
  const ids = store.listSemanticVectorIds();
  assert.deepEqual(ids.sort(), ["id-a", "id-b", "id-c"]);
  store.close();
});

test("recordProgramRun then getProgramRun round-trips an exact id", () => {
  const store = new SqliteStore(":memory:");
  store.recordProgramRun({
    id: "11111111-2222-3333-4444-555555555555",
    programKey: "prog-a",
    operation: "watch",
    createdAt: "2026-07-03T00:00:00Z",
    memberKeys: ["m1", "m2"],
    output: { operation: "watch", memberCount: 2, memberReferences: [] },
  });
  const got = store.getProgramRun("11111111-2222-3333-4444-555555555555");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(got?.programKey, "prog-a");
  assert.equal(got?.operation, "watch");
  assert.deepEqual(got?.memberKeys, ["m1", "m2"]);
  store.close();
});

test("getProgramRun resolves a unique prefix and returns undefined for an ambiguous or unknown one", () => {
  const store = new SqliteStore(":memory:");
  store.recordProgramRun({
    id: "aaaaaaaa-2222-3333-4444-555555555555",
    programKey: "prog-a",
    operation: "watch",
    createdAt: "2026-07-03T00:00:00Z",
    memberKeys: [],
    output: { operation: "watch", memberCount: 0, memberReferences: [] },
  });
  store.recordProgramRun({
    id: "aaaaaaab-2222-3333-4444-555555555555",
    programKey: "prog-a",
    operation: "watch",
    createdAt: "2026-07-03T00:00:01Z",
    memberKeys: [],
    output: { operation: "watch", memberCount: 0, memberReferences: [] },
  });
  const got = store.getProgramRun("aaaaaaaa");
  assert.equal(got?.id, "aaaaaaaa-2222-3333-4444-555555555555");
  assert.equal(store.getProgramRun("aaaaaaa"), undefined); // ambiguous prefix
  assert.equal(store.getProgramRun("does-not-exist"), undefined);
  store.close();
});

test("listProgramRuns filters by programKey and orders newest-first with a default limit of 20", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 25; i += 1) {
    store.recordProgramRun({
      id: `run-a-${i}`,
      programKey: "prog-a",
      operation: "watch",
      createdAt: `2026-07-03T00:00:${String(i).padStart(2, "0")}Z`,
      memberKeys: [],
      output: { operation: "watch", memberCount: 0, memberReferences: [] },
    });
  }
  store.recordProgramRun({
    id: "run-b-0",
    programKey: "prog-b",
    operation: "drift",
    createdAt: "2026-07-03T00:01:00Z",
    memberKeys: [],
    output: { operation: "drift", memberCount: 0, memberReferences: [] },
  });

  const allProgA = store.listProgramRuns({ programKey: "prog-a" });
  assert.equal(allProgA.length, 20); // default limit
  assert.equal(allProgA[0]!.id, "run-a-24"); // newest first
  assert.equal(allProgA.every((run) => run.programKey === "prog-a"), true);

  const limited = store.listProgramRuns({ programKey: "prog-a", limit: 3 });
  assert.deepEqual(limited.map((run) => run.id), ["run-a-24", "run-a-23", "run-a-22"]);

  const onlyB = store.listProgramRuns({ programKey: "prog-b" });
  assert.deepEqual(onlyB.map((run) => run.id), ["run-b-0"]);

  store.close();
});

test("recordEvalRun then getEvalRun round-trips an exact id", () => {
  const store = new SqliteStore(":memory:");
  const result = {
    name: "recall-default",
    passed: true,
    score: 1,
    cases: [{ name: "kh", kind: "invariant" as const, passed: true, score: 1, details: {} }],
    createdAt: "2026-07-03T00:00:00Z",
  };
  store.recordEvalRun({
    id: "11111111-2222-3333-4444-555555555555",
    name: "recall-default",
    result,
    createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getEvalRun("11111111-2222-3333-4444-555555555555");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(got?.name, "recall-default");
  assert.deepEqual(got?.result, result);
  store.close();
});

test("getEvalRun resolves a unique prefix and returns undefined for an ambiguous or unknown one", () => {
  const store = new SqliteStore(":memory:");
  const result = {
    name: "recall-default",
    passed: true,
    score: 1,
    cases: [],
    createdAt: "2026-07-03T00:00:00Z",
  };
  store.recordEvalRun({
    id: "aaaaaaaa-2222-3333-4444-555555555555",
    name: "recall-default",
    result,
    createdAt: "2026-07-03T00:00:00Z",
  });
  store.recordEvalRun({
    id: "aaaaaaab-2222-3333-4444-555555555555",
    name: "recall-default",
    result,
    createdAt: "2026-07-03T00:00:01Z",
  });
  const got = store.getEvalRun("aaaaaaaa");
  assert.equal(got?.id, "aaaaaaaa-2222-3333-4444-555555555555");
  assert.equal(store.getEvalRun("aaaaaaa"), undefined); // ambiguous prefix
  assert.equal(store.getEvalRun("does-not-exist"), undefined);
  store.close();
});

test("listEvalRuns orders newest-first with a default limit of 20", () => {
  const store = new SqliteStore(":memory:");
  const result = {
    name: "recall-default",
    passed: true,
    score: 1,
    cases: [],
    createdAt: "2026-07-03T00:00:00Z",
  };
  for (let i = 0; i < 25; i += 1) {
    store.recordEvalRun({
      id: `run-${i}`,
      name: "recall-default",
      result,
      createdAt: `2026-07-03T00:00:${String(i).padStart(2, "0")}Z`,
    });
  }
  const all = store.listEvalRuns();
  assert.equal(all.length, 20); // default limit
  assert.equal(all[0]!.id, "run-24"); // newest first

  const limited = store.listEvalRuns(3);
  assert.deepEqual(limited.map((run) => run.id), ["run-24", "run-23", "run-22"]);

  store.close();
});

test("recordOperatorRun then getOperatorRun round-trips an exact id", () => {
  const store = new SqliteStore(":memory:");
  store.recordOperatorRun({
    id: "11111111-2222-3333-4444-555555555555",
    status: "ran",
    summary: "ticked 2; programs 1; derived 1",
    result: { ticked: 2, programRuns: 1, derivedAccepted: 1 },
    createdAt: "2026-07-03T00:00:00Z",
  });
  const got = store.getOperatorRun("11111111-2222-3333-4444-555555555555");
  assert.equal(got?.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(got?.status, "ran");
  assert.equal(got?.summary, "ticked 2; programs 1; derived 1");
  assert.deepEqual(got?.result, { ticked: 2, programRuns: 1, derivedAccepted: 1 });
  store.close();
});

test("getOperatorRun resolves a unique prefix and returns undefined for an ambiguous or unknown one", () => {
  const store = new SqliteStore(":memory:");
  store.recordOperatorRun({
    id: "aaaaaaaa-2222-3333-4444-555555555555",
    status: "ran",
    summary: "ticked 0; programs 0; derived 0",
    result: { ticked: 0, programRuns: 0, derivedAccepted: 0 },
    createdAt: "2026-07-03T00:00:00Z",
  });
  store.recordOperatorRun({
    id: "aaaaaaab-2222-3333-4444-555555555555",
    status: "ran",
    summary: "ticked 0; programs 0; derived 0",
    result: { ticked: 0, programRuns: 0, derivedAccepted: 0 },
    createdAt: "2026-07-03T00:00:01Z",
  });
  const got = store.getOperatorRun("aaaaaaaa");
  assert.equal(got?.id, "aaaaaaaa-2222-3333-4444-555555555555");
  assert.equal(store.getOperatorRun("aaaaaaa"), undefined); // ambiguous prefix
  assert.equal(store.getOperatorRun("does-not-exist"), undefined);
  store.close();
});

test("listOperatorRuns orders newest-first with a default limit of 20", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 25; i += 1) {
    store.recordOperatorRun({
      id: `run-${i}`,
      status: "ran",
      summary: "ticked 0; programs 0; derived 0",
      result: { ticked: 0, programRuns: 0, derivedAccepted: 0 },
      createdAt: `2026-07-03T00:00:${String(i).padStart(2, "0")}Z`,
    });
  }
  const all = store.listOperatorRuns();
  assert.equal(all.length, 20); // default limit
  assert.equal(all[0]!.id, "run-24"); // newest first

  const limited = store.listOperatorRuns(3);
  assert.deepEqual(limited.map((run) => run.id), ["run-24", "run-23", "run-22"]);

  store.close();
});

test("recordOperatorRun prunes the ledger to the keep cap, newest surviving", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 12; i += 1) {
    store.recordOperatorRun(
      {
        id: `run-${i}`,
        status: "ran",
        summary: "ticked 0; programs 0; derived 0",
        result: { ticked: 0, programRuns: 0, derivedAccepted: 0 },
        createdAt: `2026-07-03T00:00:${String(i).padStart(2, "0")}Z`,
      },
      10,
    );
  }
  const all = store.listOperatorRuns(20);
  assert.equal(all.length, 10);
  assert.deepEqual(
    all.map((run) => run.id),
    ["run-11", "run-10", "run-9", "run-8", "run-7", "run-6", "run-5", "run-4", "run-3", "run-2"],
  );
  store.close();
});

test("storageStats on an empty :memory: store reports zero counts, no path/bytes, averageCellBytes 0, maximumCell null", () => {
  const store = new SqliteStore(":memory:");
  const report = store.storageStats();
  assert.equal(report.databasePath, undefined);
  assert.equal(report.databaseBytes, undefined);
  assert.deepEqual(report.tables, {
    cells: 0,
    edges: 0,
    hyperedges: 0,
    semanticVectors: 0,
    dagOverlays: 0,
    programRuns: 0,
    evalRuns: 0,
    operatorRuns: 0,
  });
  assert.equal(report.averageCellBytes, 0);
  assert.equal(report.maximumCell, null);
  store.close();
});

test("storageStats counts all eight tables via SQL aggregates", () => {
  const store = new SqliteStore(":memory:");
  store.put(
    buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.7, edges: [{ relation: "supports", target: "bbbb" }] },
      { key: "aaaa" },
    ),
  );
  store.put(buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.7 }, { key: "bbbb" }));
  store.putHyperedge({
    id: "hyper-1",
    kind: "cluster",
    title: "H",
    members: [
      { key: "aaaa", role: "member", ordinal: 0 },
      { key: "bbbb", role: "member", ordinal: 1 },
    ],
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  store.putSemanticVector({
    nodeId: "aaaa",
    backend: "hash256",
    dims: 4,
    vector: [1, 0, 0, 0],
    indexedAt: "2026-07-01T00:00:00.000Z",
  });
  store.putDagOverlay({
    id: "dag-1",
    title: "D",
    nodeIds: ["aaaa", "bbbb"],
    edges: [],
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  store.recordProgramRun({
    id: "prog-1",
    programKey: "aaaa",
    operation: "score",
    memberKeys: ["aaaa"],
    output: { operation: "score", memberCount: 1, memberReferences: [], tripped: false },
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  store.recordEvalRun({
    id: "eval-1",
    name: "suite",
    result: { name: "suite", passed: true, score: 1, cases: [], createdAt: "2026-07-01T00:00:00.000Z" },
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  store.recordOperatorRun({
    id: "op-1",
    status: "ran",
    summary: "ticked",
    result: { ticked: 1, programRuns: 0, derivedAccepted: 0 },
    createdAt: "2026-07-01T00:00:00.000Z",
  });

  const report = store.storageStats();
  assert.deepEqual(report.tables, {
    cells: 2,
    edges: 1,
    hyperedges: 1,
    semanticVectors: 1,
    dagOverlays: 1,
    programRuns: 1,
    evalRuns: 1,
    operatorRuns: 1,
  });
  store.close();
});

test("storageStats computes maximumCell (largest json blob, key ascending tie-break) and integer averageCellBytes", () => {
  const store = new SqliteStore(":memory:");
  const small = buildCell({ kind: "obs", title: "small", body: "x", confidence: 0.7 }, { key: "aaaa" });
  const big = buildCell(
    { kind: "obs", title: "the biggest cell body by far", body: "y".repeat(500), confidence: 0.7 },
    { key: "bbbb" },
  );
  store.put(small);
  store.put(big);

  const report = store.storageStats();
  assert.equal(report.maximumCell?.key, "bbbb");
  assert.equal(report.maximumCell?.handle, big.handle);
  assert.equal(report.maximumCell?.title, "the biggest cell body by far");
  assert.ok(report.maximumCell!.bytes > 0);
  assert.equal(Number.isInteger(report.averageCellBytes), true);
  assert.ok(report.averageCellBytes > 0);
  store.close();
});

test("storageStats breaks a maximumCell tie (equal json length) on key ascending", () => {
  const store = new SqliteStore(":memory:");
  // Same kind/body length so the stored json blobs are byte-identical in length;
  // only the key differs, so key ASC must decide it deterministically.
  store.put(buildCell({ kind: "obs", title: "same", body: "z", confidence: 0.7 }, { key: "zzzz" }));
  store.put(buildCell({ kind: "obs", title: "same", body: "z", confidence: 0.7 }, { key: "aaaa" }));

  const report = store.storageStats();
  assert.equal(report.maximumCell?.key, "aaaa");
  store.close();
});

test("storageStats on an on-disk store reports databasePath and databaseBytes including -wal/-shm sidecars", () => {
  const dir = tempDbDir();
  try {
    const dbPath = join(dir, "recall.sqlite3");
    const store = new SqliteStore(dbPath);
    try {
      // Write enough rows to force real WAL content on disk.
      for (let i = 0; i < 50; i += 1) {
        const key = `k${String(i).padStart(4, "0")}`;
        store.put(
          buildCell(
            { kind: "obs", title: `cell ${i}`, body: "x".repeat(200), confidence: 0.7 },
            { key },
          ),
        );
      }

      const report = store.storageStats();
      assert.equal(report.databasePath, dbPath);
      assert.equal(typeof report.databaseBytes, "number");

      let expected = statSync(dbPath).size;
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) expected += statSync(sidecar).size;
      }
      assert.equal(report.databaseBytes, expected);
      assert.ok(report.databaseBytes! > 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storageStats reports databaseBytes undefined when the on-disk file is missing", () => {
  const dir = tempDbDir();
  try {
    const dbPath = join(dir, "does-not-exist.sqlite3");
    const store = new SqliteStore(":memory:");
    // Simulate a store whose declared path does not correspond to a file on
    // disk: storageStats must guard the missing-file case, not throw.
    Object.defineProperty(store, "path", { value: dbPath });
    const report = store.storageStats();
    assert.equal(report.databasePath, dbPath);
    assert.equal(report.databaseBytes, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
