import { test } from "node:test";
import assert from "node:assert/strict";
import { addHyperedge, normalizeHyperedgeMembers } from "./hyperedges.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";

test("normalizeHyperedgeMembers maps plain string keys to member objects with ordinal", () => {
  const out = normalizeHyperedgeMembers(["k1"]);
  assert.deepEqual(out, [{ key: "k1", role: "member", ordinal: 0 }]);
});

test("normalizeHyperedgeMembers maps a legacy nodeId object, keeping role/weight", () => {
  const out = normalizeHyperedgeMembers([{ nodeId: "n1", role: "driver", weight: 0.5 }]);
  assert.deepEqual(out, [{ key: "n1", role: "driver", ordinal: 0, weight: 0.5 }]);
});

test("normalizeHyperedgeMembers keeps order and ordinals across a mixed array", () => {
  const out = normalizeHyperedgeMembers([
    "k1",
    { nodeId: "n1", role: "driver", weight: 0.5 },
    { key: "k2", metadata: { note: "x" } },
  ]);
  assert.deepEqual(out, [
    { key: "k1", role: "member", ordinal: 0 },
    { key: "n1", role: "driver", ordinal: 1, weight: 0.5 },
    { key: "k2", role: "member", ordinal: 2, metadata: { note: "x" } },
  ]);
});

test("normalizeHyperedgeMembers drops garbage elements instead of throwing", () => {
  const out = normalizeHyperedgeMembers(["k1", 42, null, {}]);
  assert.deepEqual(out, [{ key: "k1", role: "member", ordinal: 0 }]);
});

test("normalizeHyperedgeMembers returns [] for non-array input", () => {
  assert.deepEqual(normalizeHyperedgeMembers(null), []);
  assert.deepEqual(normalizeHyperedgeMembers(undefined), []);
  assert.deepEqual(normalizeHyperedgeMembers("not an array"), []);
});

test("normalizeHyperedgeMembers fills defaults on an object with key but no role/ordinal", () => {
  const out = normalizeHyperedgeMembers([{ key: "k1" }]);
  assert.deepEqual(out, [{ key: "k1", role: "member", ordinal: 0 }]);
});

test("normalizeHyperedgeMembers keeps an explicit ordinal on a key object", () => {
  const out = normalizeHyperedgeMembers([{ key: "k1", ordinal: 7, role: "lead" }]);
  assert.deepEqual(out, [{ key: "k1", role: "lead", ordinal: 7 }]);
});

test("addHyperedge resolves handles to keys and persists", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  const b = buildCell({ kind: "obs", title: "B", body: "b", confidence: 0.7 }, { key: "bbbb" });
  store.put(a);
  store.put(b);

  const h = addHyperedge(store, {
    kind: "cluster",
    title: "cluster of a+b",
    members: [a.handle, "bbbb"],
  }, "2026-07-03T00:00:00Z");

  assert.ok(h.id);
  assert.equal(h.kind, "cluster");
  assert.equal(h.title, "cluster of a+b");
  assert.equal(h.createdAt, "2026-07-03T00:00:00Z");
  assert.deepEqual(h.members, [
    { key: "aaaa", role: "member", ordinal: 0 },
    { key: "bbbb", role: "member", ordinal: 1 },
  ]);

  const persisted = store.getHyperedge(h.id);
  assert.deepEqual(persisted?.members, h.members);
  store.close();
});

test("addHyperedge throws naming the first unresolved member", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  assert.throws(
    () =>
      addHyperedge(store, {
        kind: "cluster",
        title: "t",
        members: ["aaaa", "ghost-key"],
      }),
    /ghost-key/,
  );
  store.close();
});

test("addHyperedge throws on empty kind or title", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  assert.throws(() => addHyperedge(store, { kind: "", title: "t", members: ["aaaa"] }));
  assert.throws(() => addHyperedge(store, { kind: "cluster", title: "  ", members: ["aaaa"] }));
  store.close();
});

test("addHyperedge accepts a partial member object and normalizes it, and honors an explicit id", () => {
  const store = new SqliteStore(":memory:");
  const a = buildCell({ kind: "dec", title: "A", body: "b", confidence: 0.8 }, { key: "aaaa" });
  store.put(a);

  const h = addHyperedge(store, {
    id: "custom-id",
    kind: "cluster",
    title: "t",
    members: [{ key: "aaaa", role: "lead" }],
    metadata: { note: "x" },
  });

  assert.equal(h.id, "custom-id");
  assert.deepEqual(h.members, [{ key: "aaaa", role: "lead", ordinal: 0 }]);
  assert.equal(h.metadata.note, "x");
  store.close();
});
