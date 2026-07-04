import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProposal } from "./schema.js";

const valid = {
  kind: "dec",
  title: "Pick a database",
  body: "We will use Postgres.",
  confidence: 0.7,
};

test("a fully valid proposal passes with no issues", () => {
  const r = validateProposal(valid);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test("a kind outside KINDS fails with a kind issue", () => {
  const r = validateProposal({ ...valid, kind: "nope" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "kind"));
});

test("an empty title fails with a title issue", () => {
  const r = validateProposal({ ...valid, title: "" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "title"));
});

test("a non-string title fails with a title issue", () => {
  const r = validateProposal({ ...valid, title: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "title"));
});

test("a non-string body fails with a body issue", () => {
  const r = validateProposal({ ...valid, body: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "body"));
});

test("an empty string body is allowed", () => {
  const r = validateProposal({ ...valid, body: "" });
  assert.equal(r.ok, true);
});

test("confidence of 0 fails (interval is open at 0)", () => {
  const r = validateProposal({ ...valid, confidence: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});

test("confidence above 1 fails", () => {
  const r = validateProposal({ ...valid, confidence: 1.5 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});

test("confidence of exactly 1 is allowed (interval is closed at 1)", () => {
  const r = validateProposal({ ...valid, confidence: 1 });
  assert.equal(r.ok, true);
});

test("a non-finite confidence fails", () => {
  const r = validateProposal({ ...valid, confidence: Number.NaN });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});

test("a non-number confidence fails", () => {
  const r = validateProposal({ ...valid, confidence: "0.5" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});

test("omitting edges is allowed", () => {
  const r = validateProposal(valid);
  assert.equal(r.ok, true);
});

test("a valid edge passes", () => {
  const r = validateProposal({
    ...valid,
    edges: [{ relation: "supports", target: "dec_a3ee" }],
  });
  assert.equal(r.ok, true);
});

test("valid optional proposal fields pass", () => {
  const r = validateProposal({
    ...valid,
    owner: "alice",
    summary: "",
    topics: ["recall-v5"],
    entities: ["Recall"],
    lifecycle: ["active"],
    quality: ["verified"],
    subject: ["infra"],
    sourceRefs: ["src/schema.ts"],
    uncertainty: 0.2,
    concern: 0.1,
    operation: "create",
    origin: "human",
    verification: "checked",
    sensitivity: "public",
    project: "recall",
    tenant: "local-recall",
    stability: "volatile",
    expiresAt: null,
    reverifyAfter: "2026-06-23T00:00:00.000Z",
    flags: { pinned: true, allowBackgroundUse: false },
    props: { priority: 1 },
  });
  assert.equal(r.ok, true);
});

test("invalid optional arrays and probabilities fail with indexed paths", () => {
  const r = validateProposal({
    ...valid,
    topics: ["ok", ""],
    entities: "Recall",
    uncertainty: -0.1,
    concern: 1.1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "topics[1]"));
  assert.ok(r.issues.some((i) => i.path === "entities"));
  assert.ok(r.issues.some((i) => i.path === "uncertainty"));
  assert.ok(r.issues.some((i) => i.path === "concern"));
});

test("invalid lifecycle/quality/subject entries fail with indexed paths", () => {
  const r = validateProposal({
    ...valid,
    lifecycle: ["expired", 7],
    quality: "verified",
    subject: ["ok", ""],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "lifecycle[1]"));
  assert.ok(r.issues.some((i) => i.path === "quality"));
  assert.ok(r.issues.some((i) => i.path === "subject[1]"));
});

test("invalid optional enums, flags, dates, and props fail", () => {
  const r = validateProposal({
    ...valid,
    operation: "archive",
    origin: "robot",
    verification: "sure",
    sensitivity: "classified",
    stability: "forever",
    expiresAt: "not a date",
    flags: { pinned: "yes" },
    props: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "operation"));
  assert.ok(r.issues.some((i) => i.path === "origin"));
  assert.ok(r.issues.some((i) => i.path === "verification"));
  assert.ok(r.issues.some((i) => i.path === "sensitivity"));
  assert.ok(r.issues.some((i) => i.path === "stability"));
  assert.ok(r.issues.some((i) => i.path === "expiresAt"));
  assert.ok(r.issues.some((i) => i.path === "flags.pinned"));
  assert.ok(r.issues.some((i) => i.path === "props"));
});

test("an edge relation outside RELATIONS fails with an indexed path", () => {
  const r = validateProposal({
    ...valid,
    edges: [{ relation: "nope", target: "dec_a3ee" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges[0].relation"));
});

test("an edge with an empty target fails with an indexed path", () => {
  const r = validateProposal({
    ...valid,
    edges: [{ relation: "supports", target: "" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges[0].target"));
});

test("an edge with a non-string target fails", () => {
  const r = validateProposal({
    ...valid,
    edges: [{ relation: "supports", target: 7 }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges[0].target"));
});

test("edge weights must be finite and match relation polarity", () => {
  const r = validateProposal({
    ...valid,
    edges: [
      { relation: "supports", target: "obs_a3ee", weight: -1 },
      { relation: "contradicts", target: "obs_b4ff", weight: 1 },
      { relation: "concerns", target: "obs_c5aa", weight: 0 },
      { relation: "depends_on", target: "tsk_d6bb", weight: 0.5 },
      { relation: "derived_from", target: "obs_e7cc", weight: Number.POSITIVE_INFINITY },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges[0].weight"));
  assert.ok(r.issues.some((i) => i.path === "edges[1].weight"));
  assert.ok(r.issues.some((i) => i.path === "edges[2].weight"));
  assert.ok(r.issues.some((i) => i.path === "edges[3].weight"));
  assert.ok(r.issues.some((i) => i.path === "edges[4].weight"));
});

test("the failing edge is reported at its own index", () => {
  const r = validateProposal({
    ...valid,
    edges: [
      { relation: "supports", target: "dec_a3ee" },
      { relation: "nope", target: "dec_b4ff" },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges[1].relation"));
  assert.ok(!r.issues.some((i) => i.path === "edges[0].relation"));
});

test("a non-array edges value fails with an edges issue", () => {
  const r = validateProposal({ ...valid, edges: "supports" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "edges"));
});

test("a null input does not throw and fails on the required fields", () => {
  const r = validateProposal(null);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "kind"));
  assert.ok(r.issues.some((i) => i.path === "title"));
  assert.ok(r.issues.some((i) => i.path === "body"));
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});

test("a non-object input does not throw and is rejected", () => {
  const r = validateProposal("not a proposal");
  assert.equal(r.ok, false);
});

test("an empty object collects one issue per required field", () => {
  const r = validateProposal({});
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "kind"));
  assert.ok(r.issues.some((i) => i.path === "title"));
  assert.ok(r.issues.some((i) => i.path === "body"));
  assert.ok(r.issues.some((i) => i.path === "confidence"));
});
