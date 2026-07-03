import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore, contentKey } from "./store.js";
import { buildCell } from "./build.js";

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
  store.putHyperedge({ id: "h1", kind: "cluster", title: "t", members: ["a", "b"], metadata: { n: 1 }, createdAt: "2026-07-03T00:00:00Z" });
  const all = store.listHyperedges();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.members, ["a", "b"]);
  assert.equal(all[0]!.metadata.n, 1);
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
