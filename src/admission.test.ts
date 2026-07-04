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

test("supersede by handle demotes the target and preserves lineage", () => {
  const store = new SqliteStore(":memory:");
  const a = admit({ kind: "dec", title: "Original decision", body: "b", confidence: 0.6 }, { store }).cell!;
  const b = admit(
    { kind: "dec", title: "Replacement decision", body: "b", confidence: 0.6, edges: [{ relation: "supersedes", target: a.handle, weight: 0 }] },
    { store },
  ).cell!;
  assert.equal(store.get(a.key)?.status, "superseded");
  assert.ok(b.lineage.includes(a.key)); // same lineage record as the full-key path
  const storedEdge = store.get(b.key)?.edgesOut.find((e) => e.relation === "supersedes");
  assert.equal(storedEdge?.target, a.key); // edge target normalized to the full key
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

test("admit warns when a depends_on target is already superseded", () => {
  const store = new SqliteStore(":memory:");
  admit({ kind: "obs", title: "old config", body: "v1", confidence: 0.8 }, { key: "oldc", store });
  admit({ kind: "obs", title: "new config", body: "v2", confidence: 0.85, edges: [{ relation: "supersedes", target: "oldc" }] }, { key: "newc", store });
  const r = admit({ kind: "dec", title: "plan", body: "rests on config", confidence: 0.8, edges: [{ relation: "depends_on", target: "oldc" }] }, { key: "plan1", store });
  assert.equal(r.accepted, true);
  assert.ok(r.warnings.some((w) => /depends_on/.test(w) && /superseded/.test(w)));
  store.close();
});

test("auto-index: admitted cell through SqliteStore has a semantic vector", () => {
  const store = new SqliteStore(":memory:");
  const r = admit({ kind: "dec", title: "indexed", body: "some content", confidence: 0.6 }, { key: "idx1", store });
  assert.equal(r.accepted, true);
  const vec = store.getSemanticVector("idx1");
  assert.ok(vec !== undefined, "semantic vector must be defined after admit");
  store.close();
});

test("auto-index: admit without a store does not crash and produces no vector error", () => {
  const r = admit({ kind: "dec", title: "no store", body: "no store body", confidence: 0.6 }, { key: "ns1" });
  assert.equal(r.accepted, true);
  // no crash, no assertion about vectors (there is no store)
});

test("auto-index: dedup path does not double-write a semantic vector", () => {
  const store = new SqliteStore(":memory:");
  admit({ kind: "dec", title: "dup", body: "dup body", confidence: 0.6 }, { key: "d1", store });
  // second admit is a dedup no-op
  const r2 = admit({ kind: "dec", title: "dup", body: "dup body", confidence: 0.6 }, { key: "d2", store });
  assert.ok(r2.warnings.some((w) => /dedup/i.test(w)), "second admit should be a dedup");
  // vector for d1 must still exist; no vector for d2 (dedup never reached final put)
  const v1 = store.getSemanticVector("d1");
  assert.ok(v1 !== undefined, "original cell vector must be defined");
  const v2 = store.getSemanticVector("d2");
  assert.equal(v2, undefined, "dedup no-op must not create a second vector");
  store.close();
});

test("fill-or-reject covers the facet, flags, and props template entries", () => {
  const store = new SqliteStore(":memory:");
  for (const field of ["lifecycle", "quality", "subject", "flags", "props", "programs", "hyperedges", "value"] as const) {
    const proposal = {
      kind: "obs",
      title: "Template coverage probe",
      body: "b",
      confidence: 0.6,
      [field]: WRITE_TEMPLATE[field],
    } as unknown as Parameters<typeof admit>[0];
    const r = admit(proposal, { store });
    assert.equal(r.accepted, false, `${field} left as its instruction must reject`);
    assert.ok(r.issues.some((i) => i.path === field), `${field} issue expected`);
  }
  store.close();
});

test("proposal programs resolve to prg cells and land on cell.programs", () => {
  const store = new SqliteStore(":memory:");
  const prg = admit(
    { kind: "prg", title: "watch storage", body: "standing", confidence: 0.6, props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { topics: ["storage"] } } } },
    { store },
  ).cell!;
  const r = admit(
    { kind: "obs", title: "Storage observation", body: "b", confidence: 0.6, topics: ["storage"], programs: [prg.handle] },
    { store },
  );
  assert.equal(r.accepted, true);
  assert.deepEqual(r.cell!.programs, [prg.key]);
  assert.deepEqual(store.get(r.cell!.key)!.programs, [prg.key]);
  store.close();
});

test("proposal programs reject dangling targets and non-prg cells", () => {
  const store = new SqliteStore(":memory:");
  const obs = admit({ kind: "obs", title: "Not a program", body: "b", confidence: 0.6 }, { store }).cell!;
  const dangling = admit({ kind: "obs", title: "A", body: "b", confidence: 0.6, programs: ["nope"] }, { store });
  assert.equal(dangling.accepted, false);
  assert.ok(dangling.issues.some((i) => i.path === "programs[0]"));
  const wrongKind = admit({ kind: "obs", title: "B", body: "b", confidence: 0.6, programs: [obs.key] }, { store });
  assert.equal(wrongKind.accepted, false);
  assert.ok(wrongKind.issues.some((i) => i.path === "programs[0]"));
  store.close();
});

test("proposal hyperedges join existing bundles with role and weight", () => {
  const store = new SqliteStore(":memory:");
  const seed = admit({ kind: "obs", title: "Seed member", body: "b", confidence: 0.6 }, { store }).cell!;
  store.putHyperedge({
    id: "he-1", kind: "evidence-set", title: "Storage evidence",
    members: [{ key: seed.key, role: "member", ordinal: 0 }],
    metadata: {}, createdAt: "2026-07-04T00:00:00.000Z",
  });
  const r = admit(
    { kind: "obs", title: "Joins the bundle", body: "b", confidence: 0.6, hyperedges: [{ id: "he-1", role: "driver", weight: 0.8 }] },
    { store },
  );
  assert.equal(r.accepted, true);
  const he = store.getHyperedge("he-1")!;
  const member = he.members.find((m) => m.key === r.cell!.key);
  assert.ok(member, "new cell should be a member");
  assert.equal(member!.role, "driver");
  assert.equal(member!.weight, 0.8);
  assert.equal(member!.ordinal, 1);
  const unknown = admit({ kind: "obs", title: "C", body: "b", confidence: 0.6, hyperedges: [{ id: "missing" }] }, { store });
  assert.equal(unknown.accepted, false);
  assert.ok(unknown.issues.some((i) => i.path === "hyperedges[0].id"));
  store.close();
});
