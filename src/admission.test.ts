import { test } from "node:test";
import assert from "node:assert/strict";
import { admit } from "./admission.js";
import { SqliteStore } from "./store.js";
import type { WriteProposal } from "./types.js";
import { WRITE_TEMPLATE } from "./template.js";

const base: WriteProposal = { kind: "dec", title: "t", body: "b", confidence: 0.6 };

test("admit accepts a clean proposal and builds a cell with effective = confidence", () => {
  const r = admit({ ...base }, { key: "c1", now: "2026-06-23T00:00:00Z" });
  assert.equal(r.accepted, true);
  assert.equal(r.cell?.kind, "dec");
  assert.equal(r.cell?.scores.conf, 0.6);
  assert.equal(r.cell?.scores.effective, 0.6); // calibration 1, no edges
  assert.deepEqual(r.issues, []);
});

test("admit rejects a schema-invalid proposal and builds no cell", () => {
  const r = admit({ ...base, kind: "nope" });
  assert.equal(r.accepted, false);
  assert.equal(r.cell, undefined);
  assert.ok(r.issues.some((i) => i.path === "kind"));
});

test("admit rejects a proposal carrying a secret and builds no cell", () => {
  const r = admit({ ...base, body: "token sk-abcdEFGH1234567890ijklMNOP stored" });
  assert.equal(r.accepted, false);
  assert.equal(r.cell, undefined);
  assert.ok(r.issues.some((i) => /OpenAI/i.test(i.message)));
});

test("admit attenuates unsupported high confidence and warns", () => {
  const r = admit({ ...base, confidence: 0.9 }, { key: "c2" }); // no edges
  assert.equal(r.accepted, true);
  assert.equal(r.cell?.scores.conf, 0.7); // capped at write time
  assert.ok(r.warnings.includes("unsupported high confidence was attenuated"));
  assert.ok(r.attenuations.length >= 1);
});

test("admit folds a calibration factor below 1 into effective", () => {
  const r = admit({ ...base }, { key: "c3", calibrationFactor: 0.5 });
  assert.equal(r.accepted, true);
  assert.equal(r.cell?.scores.actorCalibration, 0.5);
  assert.equal(r.cell?.scores.effective, 0.3); // clamp01(0.6 * 0.5)
  assert.ok(r.attenuations.some((a) => /calibration/i.test(a)));
});

test("admit rejects an invalid calibration factor", () => {
  const high = admit({ ...base }, { key: "bad1", calibrationFactor: 1.2 });
  const nan = admit({ ...base }, { key: "bad2", calibrationFactor: Number.NaN });
  assert.equal(high.accepted, false);
  assert.ok(high.issues.some((i) => i.path === "calibrationFactor"));
  assert.equal(nan.accepted, false);
  assert.ok(nan.issues.some((i) => i.path === "calibrationFactor"));
});

test("admit with a store dedups an identical cell to a no-op", () => {
  const store = new SqliteStore(":memory:");
  admit({ kind: "dec", title: "same", body: "same body", confidence: 0.7 }, { key: "k1", store });
  const r2 = admit({ kind: "dec", title: "same", body: "same body", confidence: 0.7 }, { key: "k2", store });
  assert.equal(r2.cell?.key, "k1"); // returns the existing cell, not the new key
  assert.ok(r2.warnings.some((w) => /dedup/i.test(w)));
  assert.equal(store.all().length, 1); // no second cell stored
  store.close();
});

test("admit with a store: a contradicting write demotes its target's effective", () => {
  const store = new SqliteStore(":memory:");
  const x = admit({ kind: "dec", title: "X", body: "x", confidence: 0.8 }, { key: "xxxx", store });
  assert.equal(x.cell?.scores.effective, 0.7); // 0.8 capped to 0.7 (unsupported, no edges)
  admit(
    { kind: "obs", title: "Y", body: "y", confidence: 0.9, edges: [{ relation: "contradicts", target: "xxxx" }] },
    { key: "yyyy", store },
  );
  const xAfter = store.get("xxxx")!;
  assert.ok(xAfter.scores.effective < 0.7); // demoted further by Y's contradiction
  store.close();
});

test("admit with a store: a supersedes edge demotes the target and extends lineage", () => {
  const store = new SqliteStore(":memory:");
  admit({ kind: "dec", title: "old", body: "v1", confidence: 0.7 }, { key: "oldk", store });
  const r = admit(
    { kind: "dec", title: "new", body: "v2", confidence: 0.8, edges: [{ relation: "supersedes", target: "oldk" }] },
    { key: "newk", store },
  );
  assert.equal(store.get("oldk")?.status, "superseded");
  assert.ok(r.cell?.lineage.includes("oldk"));
  store.close();
});

test("admit with a store rejects an edge whose target does not resolve and stores nothing", () => {
  const store = new SqliteStore(":memory:");
  const r = admit(
    {
      kind: "obs",
      title: "Z",
      body: "z",
      confidence: 0.6,
      edges: [{ relation: "contradicts", target: "deadbeef-does-not-exist" }],
    },
    { key: "zzzz", store },
  );
  assert.equal(r.accepted, false);
  assert.ok(r.issues.some((i) => i.path === "edges[0].target"));
  assert.equal(store.get("zzzz"), undefined); // rejected write leaves nothing behind
  store.close();
});

test("admit with a store accepts a self-referential edge target (the new cell)", () => {
  const store = new SqliteStore(":memory:");
  const r = admit(
    {
      kind: "dec",
      title: "self",
      body: "s",
      confidence: 0.6,
      edges: [{ relation: "depends_on", target: "selfk" }],
    },
    { key: "selfk", store },
  );
  assert.equal(r.accepted, true);
  store.close();
});

test("admit rejects a field left as its template description (fill-or-reject)", () => {
  const r = admit({ kind: "dec", title: "a distinct real title", body: WRITE_TEMPLATE.body, confidence: 0.6 });
  assert.equal(r.accepted, false);
  assert.ok(r.issues.some((i) => i.path === "body"));
  assert.equal(r.cell, undefined);
});

test("admit accepts when every field differs from its template description", () => {
  const r = admit({ kind: "dec", title: "real distinct title", body: "real distinct body content", confidence: 0.6 });
  assert.equal(r.accepted, true);
});
