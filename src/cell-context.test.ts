import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectCell, resolveCell } from "./cell-context.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";

test("inspectCell expands a cell by key with footprint and incident edges", () => {
  const store = new SqliteStore(":memory:");
  const target = buildCell(
    { kind: "dec", title: "target claim", body: "body words", confidence: 0.7, summary: "short summary" },
    { key: "target" },
  );
  const source = buildCell(
    { kind: "obs", title: "supporting obs", body: "support", confidence: 0.8, edges: [{ relation: "supports", target: "target" }] },
    { key: "source" },
  );
  store.put(target);
  store.put(source);

  const context = inspectCell(store, "target");
  assert.equal(context.cell.key, "target");
  assert.equal(context.footprint.titleWords, 2);
  assert.equal(context.footprint.summaryWords, 2);
  assert.equal(context.footprint.bodyWords, 2);
  assert.equal(context.footprint.incomingEdges, 1);
  assert.equal(context.footprint.outgoingEdges, 0);
  assert.deepEqual(context.expansionHandles, ["source"]);
  store.close();
});

test("inspectCell expands by handle and previews a requested field", () => {
  const store = new SqliteStore(":memory:");
  const cell = buildCell(
    { kind: "dec", title: "field target", body: "body", confidence: 0.7 },
    { key: "target" },
  );
  store.put(cell);

  const context = inspectCell(store, `${cell.handle}#scores.effective`);
  assert.equal(context.cell.key, "target");
  assert.equal(context.requestedField?.path, "scores.effective");
  assert.equal(context.requestedField?.value, cell.scores.effective);
  assert.equal(context.requestedField?.preview, String(cell.scores.effective));
  store.close();
});

test("inspectCell rejects unknown expansion handles", () => {
  const store = new SqliteStore(":memory:");
  assert.throws(() => inspectCell(store, "missing"), /Unknown cell/);
  store.close();
});

test("resolveCell resolves by full key, id prefix, handle, and graph-qualified address", () => {
  const store = new SqliteStore(":memory:");
  const cell = buildCell({ kind: "dec", title: "resolvable", body: "b", confidence: 0.7 }, { key: "abcd1234ef99" });
  store.put(cell);
  assert.equal(resolveCell(store, "abcd1234ef99")?.key, "abcd1234ef99"); // full key
  assert.equal(resolveCell(store, "abcd1234")?.key, "abcd1234ef99"); // id prefix
  assert.equal(resolveCell(store, cell.handle)?.key, "abcd1234ef99"); // handle
  assert.equal(resolveCell(store, "home:abcd1234ef99")?.key, "abcd1234ef99"); // graph-qualified
  assert.equal(resolveCell(store, "no-such-ref"), undefined); // unknown
  store.close();
});

test("resolveCell throws on an ambiguous id prefix", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "a", body: "b", confidence: 0.7 }, { key: "dead0001aaaa" }));
  store.put(buildCell({ kind: "dec", title: "c", body: "d", confidence: 0.7 }, { key: "dead0002bbbb" }));
  assert.throws(() => resolveCell(store, "dead000"), /ambiguous/i);
  store.close();
});

test("inspectCell surfaces derived_from provenance in both directions", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "source", body: "s", confidence: 0.8 }, { key: "src1" }));
  store.put(buildCell({ kind: "obs", title: "derived", body: "d", confidence: 0.8, edges: [{ relation: "derived_from", target: "src1" }] }, { key: "der1" }));
  const derived = inspectCell(store, "der1");
  assert.deepEqual(derived.derivedFrom, ["src1"]);
  const source = inspectCell(store, "src1");
  assert.deepEqual(source.derivations, ["der1"]);
  store.close();
});
