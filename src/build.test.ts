import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";

test("buildCell sets kind, a lowercase kind_hex handle, conf=confidence, and active status", () => {
  const cell = buildCell(
    { kind: "dec", title: "add watchdog", body: "b", confidence: 0.7 },
    { key: "a3ee1234", now: "2026-06-23T00:00:00Z" },
  );
  assert.equal(cell.kind, "dec");
  assert.match(cell.handle, /^dec_[a-z0-9]+$/);
  assert.equal(cell.scores.conf, 0.7);
  assert.equal(cell.status, "active");
  assert.equal(cell.key, "a3ee1234");
  assert.equal(cell.createdAt, "2026-06-23T00:00:00Z");
});

test("buildCell scaffolds derived scores from confidence", () => {
  const c = buildCell({ kind: "obs", title: "t", body: "b", confidence: 0.6 }, { key: "ffff0000" });
  assert.equal(c.scores.uncertainty, 0.28); // (1-.6)*.7
  assert.equal(c.scores.concern, 0.12); // (1-.6)*.3
  assert.equal(c.scores.sourceQuality, 0.66); // >=.5
  assert.equal(c.scores.effective, 0.6); // stated * calibration(1)
  assert.equal(c.scores.currency, 1);
});

test("buildCell signs edges by relation (supports +, contradicts -, concerns -0.5)", () => {
  const c = buildCell(
    {
      kind: "dec", title: "t", body: "b", confidence: 0.8,
      edges: [
        { relation: "supports", target: "obs_1" },
        { relation: "contradicts", target: "obs_2" },
        { relation: "concerns", target: "obs_3" },
      ],
    },
    { key: "aaaa1111" },
  );
  assert.deepEqual(c.edgesOut.map((e) => e.weight), [1, -1, -0.5]);
  assert.equal(c.edgesOut[0]!.source, "aaaa1111");
  assert.equal(c.edgesOut[0]!.target, "obs_1");
});

test("buildCell applies defaults: owner, tenant, flags", () => {
  const c = buildCell(
    { kind: "tsk", title: "t", body: "b", confidence: 0.5, project: "recall" },
    { key: "bbbb2222" },
  );
  assert.equal(c.owner, "claude-code");
  assert.equal(c.scope.tenant, "local-recall");
  assert.equal(c.flags.allowBackgroundUse, true);
  assert.equal(c.flags.annexed, false);
  assert.deepEqual(c.programs, []);
});

test("buildCell populates provenance, tags, policy, and sourceRefs defaults", () => {
  const c = buildCell(
    { kind: "dec", title: "t", body: "b", confidence: 0.6 },
    { key: "cccc3333" },
  );
  assert.equal(c.provenance.origin, "llm");
  assert.equal(c.provenance.producedBy, "claude-code"); // the calibration key
  assert.equal(c.provenance.verification, "unverified");
  assert.equal(c.provenance.signatureStatus, "unsigned");
  assert.deepEqual(c.tags.topics, []);
  assert.deepEqual(c.tags.entities, []);
  assert.equal(c.policy.sensitivity, "private");
  assert.equal(c.policy.expiresAt, null);
  assert.deepEqual(c.sourceRefs, []);
});

test("buildCell carries stated uncertainty/concern, facets, policy, props, and provenance", () => {
  const c = buildCell(
    {
      kind: "obs", title: "t", body: "b", confidence: 0.6,
      uncertainty: 0.2, concern: 0.1,
      topics: ["recall-v5"], entities: ["Recall"],
      sourceRefs: ["src/build.ts"], origin: "human", verification: "checked",
      sensitivity: "public", expiresAt: "2026-12-31T00:00:00.000Z",
      reverifyAfter: "2026-07-01T00:00:00.000Z",
      flags: { pinned: true, allowBackgroundUse: false },
      props: { priority: 1 },
    },
    { key: "dddd4444" },
  );
  assert.equal(c.scores.uncertainty, 0.2); // stated, not derived from confidence
  assert.equal(c.scores.concern, 0.1); // stated, not derived
  assert.deepEqual(c.tags.topics, ["recall-v5"]);
  assert.deepEqual(c.tags.entities, ["Recall"]);
  assert.deepEqual(c.sourceRefs, ["src/build.ts"]);
  assert.equal(c.provenance.origin, "human");
  assert.equal(c.provenance.verification, "checked");
  assert.equal(c.policy.sensitivity, "public");
  assert.equal(c.policy.expiresAt, "2026-12-31T00:00:00.000Z");
  assert.equal(c.policy.reverifyAfter, "2026-07-01T00:00:00.000Z");
  assert.equal(c.flags.pinned, true);
  assert.equal(c.flags.allowBackgroundUse, false);
  assert.deepEqual(c.props, { priority: 1 });
});

test("buildCell rejects explicit edge weights that violate relation polarity", () => {
  assert.throws(() =>
    buildCell({
      kind: "obs",
      title: "bad support",
      body: "b",
      confidence: 0.6,
      edges: [{ relation: "supports", target: "dec_a3ee", weight: -1 }],
    }),
  );
});

test("buildCell rejects invalid kind and confidence even when called directly", () => {
  assert.throws(() => buildCell({ kind: "nope", title: "t", body: "b", confidence: 0.6 }));
  assert.throws(() => buildCell({ kind: "obs", title: "t", body: "b", confidence: 0 }));
});

test("buildCell threads lifecycle/quality/subject tags when provided", () => {
  const c = buildCell(
    {
      kind: "obs", title: "t", body: "b", confidence: 0.6,
      lifecycle: ["expired"], quality: ["verified"], subject: ["infra"],
    },
    { key: "eeee5555" },
  );
  assert.deepEqual(c.tags.lifecycle, ["expired"]);
  assert.deepEqual(c.tags.quality, ["verified"]);
  assert.deepEqual(c.tags.subject, ["infra"]);
});

test("buildCell omits lifecycle/quality/subject tags when not provided", () => {
  const c = buildCell({ kind: "obs", title: "t", body: "b", confidence: 0.6 }, { key: "ffff6666" });
  assert.equal(c.tags.lifecycle, undefined);
  assert.equal(c.tags.quality, undefined);
  assert.equal(c.tags.subject, undefined);
});
