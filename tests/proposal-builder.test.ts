import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProposal } from "../src/core/proposal-builder.js";
import { validateWriteProposal } from "../src/core/schema.js";

const base = {
  kind: "decision",
  title: "Adopt buf for protobuf schema management",
  body: "Use buf for lint + breaking-change checks.",
  confidence: 0.8,
  topics: ["grpc-migration", "schema-tooling"],
  now: new Date("2026-06-22T06:00:00Z"),
};

test("buildProposal emits a schema-valid recall.write.v1 proposal", () => {
  const p = buildProposal(base);
  assert.equal(validateWriteProposal(p).ok, true);
  assert.equal(p.schema_version, "recall.write.v1");
  assert.equal(p.actor.id, "claude-code");
  assert.equal(p.intent.operation, "create");
  assert.equal(p.content.summary, base.title);
  assert.deepEqual(p.tags.rings, ["runtime"]);
  assert.deepEqual(p.tags.lifecycle, ["active"]);
  assert.deepEqual(p.tags.type, ["decision"]);
  assert.equal(p.tags.topics.includes("grpc-migration"), true);
  assert.deepEqual(p.tags.timestamp, ["2026-06-22"]);
});

test("confidence -> source_quality buckets", () => {
  assert.equal(buildProposal({ ...base, confidence: 0.85 }).confidence.source_quality, "high");
  assert.equal(buildProposal({ ...base, confidence: 0.8 }).confidence.source_quality, "high");
  assert.equal(buildProposal({ ...base, confidence: 0.6 }).confidence.source_quality, "medium");
  assert.equal(buildProposal({ ...base, confidence: 0.2 }).confidence.source_quality, "low");
});

test("confidence -> quality tags buckets", () => {
  assert.deepEqual(buildProposal({ ...base, confidence: 0.9 }).tags.quality, ["verified", "calibrated"]);
  assert.deepEqual(buildProposal({ ...base, confidence: 0.75 }).tags.quality, ["calibrated", "structural"]);
  assert.deepEqual(buildProposal({ ...base, confidence: 0.55 }).tags.quality, ["calibrated", "speculative"]);
  assert.deepEqual(buildProposal({ ...base, confidence: 0.3 }).tags.quality, ["speculative", "low-confidence"]);
});

test("uncertainty/concern split residual 70/30 when not supplied", () => {
  const p = buildProposal({ ...base, confidence: 0.8 });
  assert.equal(p.confidence.uncertainty, 0.14);
  assert.equal(p.confidence.concern, 0.06);
});

test("bare cell ids in contradicts normalize to recall://cell/<id>", () => {
  const p = buildProposal({
    ...base,
    contradicts: ["b0ebbee6-0526-4b96-8102-98fbd591fd18", "cell-09b43a4b"],
  });
  assert.equal(p.evidence.contradicts[0], "recall://cell/b0ebbee6-0526-4b96-8102-98fbd591fd18");
  assert.equal(p.evidence.contradicts[1].startsWith("recall://cell/09b43a4b"), true);
});

test("entity auto-extraction pulls file stems, cell prefixes, axioms; project prepended", () => {
  const p = buildProposal({
    ...base,
    project: "acme",
    sourceFiles: ["docs/adr/0007-grpc-schema.md#section-3"],
    contradicts: ["abc12345-dead-beef-0000-000000000000"],
    body: "Per file-12 and axiom A_excl this supersedes the prior.",
  });
  assert.equal(p.tags.entities[0], "acme");
  assert.equal(p.tags.entities.includes("0007-grpc-schema"), true);
  assert.equal(p.tags.entities.includes("cell-abc12345"), true);
  assert.equal(p.tags.entities.includes("file-12"), true);
  assert.equal(p.tags.entities.includes("A_excl"), true);
});

test("required-field guards throw", () => {
  assert.throws(() => buildProposal({ ...base, confidence: 0 }), /confidence/);
  assert.throws(() => buildProposal({ ...base, confidence: 1.5 }), /confidence/);
  assert.throws(() => buildProposal({ ...base, topics: [] }), /topics/);
  assert.throws(() => buildProposal({ ...base, kind: "not-a-kind" }), /kind/);
});
