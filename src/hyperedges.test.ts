import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHyperedgeMembers } from "./hyperedges.js";

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
