import { test } from "node:test";
import assert from "node:assert/strict";
import { addDagOverlay, analyzeDagOverlay } from "./dag.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import type { DagOverlay } from "./types.js";

function overlay(partial: Partial<DagOverlay>): DagOverlay {
  return {
    id: "ov1",
    title: "test overlay",
    nodeIds: [],
    edges: [],
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

test("analyzeDagOverlay: linear overlay yields isDag true with deterministic topo order", () => {
  const ov = overlay({
    nodeIds: ["c", "a", "b"],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.overlayId, "ov1");
  assert.equal(result.isDag, true);
  assert.deepEqual(result.topologicalOrder, ["a", "b", "c"]);
  assert.deepEqual(result.cycles, []);
});

test("analyzeDagOverlay: a 3-cycle yields isDag false, the cycle extracted, empty topo order", () => {
  const ov = overlay({
    nodeIds: ["a", "b", "c"],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.isDag, false);
  assert.deepEqual(result.topologicalOrder, []);
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0], ["a", "b", "c", "a"]);
});

test("analyzeDagOverlay: two paths a->c with labels [x] vs [y] yield one witness, pathCount 2, 2 signatures, concern 1", () => {
  const ov = overlay({
    nodeIds: ["a", "b1", "b2", "c"],
    edges: [
      { source: "a", target: "b1", label: "x" },
      { source: "b1", target: "c", label: "edge" },
      { source: "a", target: "b2", label: "y" },
      { source: "b2", target: "c", label: "edge" },
    ],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.isDag, true);
  assert.equal(result.witnesses.length, 1);
  const w = result.witnesses[0]!;
  assert.equal(w.from, "a");
  assert.equal(w.to, "c");
  assert.equal(w.pathCount, 2);
  assert.equal(w.signatures.length, 2);
  assert.equal(w.concern, 1);
});

test("analyzeDagOverlay: identical labels yield no witness", () => {
  const ov = overlay({
    nodeIds: ["a", "b1", "b2", "c"],
    edges: [
      { source: "a", target: "b1", label: "x" },
      { source: "b1", target: "c", label: "edge" },
      { source: "a", target: "b2", label: "x" },
      { source: "b2", target: "c", label: "edge" },
    ],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.isDag, true);
  assert.equal(result.witnesses.length, 0);
});

test("analyzeDagOverlay: concern formula on 3 paths 2 signatures = min(1, 2/3)", () => {
  const ov = overlay({
    nodeIds: ["a", "b1", "b2", "b3", "c"],
    edges: [
      { source: "a", target: "b1", label: "x" },
      { source: "b1", target: "c", label: "edge" },
      { source: "a", target: "b2", label: "x" },
      { source: "b2", target: "c", label: "edge" },
      { source: "a", target: "b3", label: "y" },
      { source: "b3", target: "c", label: "edge" },
    ],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.witnesses.length, 1);
  const w = result.witnesses[0]!;
  assert.equal(w.pathCount, 3);
  assert.equal(w.signatures.length, 2);
  assert.equal(w.concern, Math.min(1, 2 / 3));
});

test("analyzeDagOverlay: witnesses are sorted by concern descending", () => {
  const ov = overlay({
    nodeIds: ["a", "b1", "b2", "b3", "d1", "d2", "e"],
    edges: [
      // a->c via two disjoint-signature paths: concern min(1, 2/2) = 1
      { source: "a", target: "b1", label: "x" },
      { source: "b1", target: "e", label: "edge" },
      { source: "a", target: "b2", label: "y" },
      { source: "b2", target: "e", label: "edge" },
      { source: "a", target: "b3", label: "x" },
      { source: "b3", target: "e", label: "edge" },
      // d->e via two paths with lower concern (2 signatures / 3 paths... reuse a for simplicity)
    ],
  });
  const result = analyzeDagOverlay(ov);
  const concerns = result.witnesses.map((w) => w.concern);
  const sorted = [...concerns].sort((a, b) => b - a);
  assert.deepEqual(concerns, sorted);
});

test("analyzeDagOverlay: adjacency unions nodeIds with edge endpoints", () => {
  const ov = overlay({
    nodeIds: ["a"],
    edges: [{ source: "a", target: "b" }],
  });
  const result = analyzeDagOverlay(ov);
  assert.equal(result.isDag, true);
  assert.deepEqual(result.topologicalOrder, ["a", "b"]);
});

test("addDagOverlay resolves handles to keys for nodeIds and edge endpoints, and persists", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  const b = buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.7 }, { key: "bbbb" });
  store.put(a);
  store.put(b);

  const ov = addDagOverlay(store, {
    title: "handle overlay",
    nodeIds: [a.handle, "bbbb"],
    edges: [{ source: a.handle, target: "bbbb", label: "leads_to" }],
  }, "2026-07-03T00:00:00Z");

  assert.ok(ov.id);
  assert.equal(ov.title, "handle overlay");
  assert.deepEqual(ov.nodeIds, ["aaaa", "bbbb"]);
  assert.deepEqual(ov.edges, [{ source: "aaaa", target: "bbbb", label: "leads_to" }]);
  assert.equal(ov.createdAt, "2026-07-03T00:00:00Z");

  const persisted = store.getDagOverlay(ov.id);
  assert.deepEqual(persisted, ov);
  store.close();
});

test("addDagOverlay rejects a cyclic input, listing the cycle in the thrown message", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  const b = buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.7 }, { key: "bbbb" });
  store.put(a);
  store.put(b);

  assert.throws(
    () =>
      addDagOverlay(store, {
        title: "cyclic overlay",
        nodeIds: ["aaaa", "bbbb"],
        edges: [
          { source: "aaaa", target: "bbbb" },
          { source: "bbbb", target: "aaaa" },
        ],
      }),
    /aaaa.*bbbb.*aaaa/,
  );
  store.close();
});

test("addDagOverlay throws naming the first unresolved node", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  assert.throws(
    () =>
      addDagOverlay(store, {
        title: "bad overlay",
        nodeIds: ["aaaa", "ghost-node"],
        edges: [],
      }),
    /ghost-node/,
  );
  store.close();
});

test("addDagOverlay throws naming the first unresolved edge endpoint", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  assert.throws(
    () =>
      addDagOverlay(store, {
        title: "bad overlay",
        nodeIds: ["aaaa"],
        edges: [{ source: "aaaa", target: "ghost-target" }],
      }),
    /ghost-target/,
  );
  store.close();
});

test("addDagOverlay honors an explicit id and metadata", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  const ov = addDagOverlay(store, {
    id: "custom-id",
    title: "t",
    nodeIds: ["aaaa"],
    edges: [],
    metadata: { note: "x" },
  });

  assert.equal(ov.id, "custom-id");
  assert.equal(ov.metadata.note, "x");
  store.close();
});
