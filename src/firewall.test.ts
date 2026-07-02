import { test } from "node:test";
import assert from "node:assert/strict";
import { screenSecrets, attenuateConfidence } from "./firewall.js";
import type { WriteProposal } from "./types.js";

function proposal(over: Partial<WriteProposal> = {}): WriteProposal {
  return {
    kind: "obs",
    title: "a note",
    body: "some body text",
    confidence: 0.5,
    ...over,
  };
}

test("screenSecrets allows a clean proposal", () => {
  const got = screenSecrets(proposal());
  assert.equal(got.allowed, true);
  assert.deepEqual(got.issues, []);
});

test("screenSecrets catches an OpenAI sk- key", () => {
  const got = screenSecrets(
    proposal({ body: "key is sk-abcdEFGH1234567890ijklMNOP here" })
  );
  assert.equal(got.allowed, false);
  assert.equal(got.issues.length, 1);
  assert.equal(got.issues[0]!.path, "body");
  assert.match(got.issues[0]!.message, /OpenAI/i);
});

test("screenSecrets scans summary, source refs, and props", () => {
  const got = screenSecrets(
    proposal({
      summary: "clean",
      sourceRefs: ["password=super-secret-value"],
      props: { nested: ["Bearer abcdefghijklmnopqrstuvwxyz"] },
    }),
  );
  assert.equal(got.allowed, false);
  assert.ok(got.issues.some((i) => i.path === "sourceRefs[0]"));
  assert.ok(got.issues.some((i) => i.path === "props.nested[0]"));
});

test("screenSecrets blocks public writes with personal data", () => {
  const got = screenSecrets(
    proposal({
      sensitivity: "public",
      body: "contact ada@example.com for details",
    }),
  );
  assert.equal(got.allowed, false);
  assert.ok(got.issues.some((i) => /public write/i.test(i.message)));
});

test("screenSecrets does NOT trip on a bare UUID", () => {
  const got = screenSecrets(
    proposal({ body: "see cell a3ee1234-9b20-4c1a-8f3e-1234567890ab now" })
  );
  assert.equal(got.allowed, true);
  assert.deepEqual(got.issues, []);
});

test("attenuateConfidence caps unsupported high confidence to 0.7", () => {
  const got = attenuateConfidence(proposal({ confidence: 0.9 }));
  assert.equal(got.confidence, 0.7);
  assert.deepEqual(got.warnings, ["unsupported high confidence was attenuated"]);
  assert.deepEqual(got.attenuations, ["confidence 0.90 -> 0.70"]);
});

test("attenuateConfidence leaves high confidence with support evidence unchanged", () => {
  const got = attenuateConfidence(
    proposal({
      confidence: 0.9,
      edges: [{ relation: "supports", target: "obs_01", weight: 1 }],
    })
  );
  assert.equal(got.confidence, 0.9);
  assert.deepEqual(got.warnings, []);
  assert.deepEqual(got.attenuations, []);
});

test("attenuateConfidence treats source refs and checked verification as support", () => {
  const withSource = attenuateConfidence(
    proposal({ confidence: 0.9, sourceRefs: ["src/firewall.ts"] }),
  );
  const checked = attenuateConfidence(
    proposal({ confidence: 0.9, verification: "checked" }),
  );
  assert.equal(withSource.confidence, 0.9);
  assert.equal(checked.confidence, 0.9);
});

test("attenuateConfidence caps high confidence with only non-support edges", () => {
  const got = attenuateConfidence(
    proposal({
      confidence: 0.9,
      edges: [{ relation: "contradicts", target: "obs_01", weight: -1 }],
    }),
  );
  assert.equal(got.confidence, 0.7);
});

test("attenuateConfidence leaves low confidence with no edges unchanged", () => {
  const got = attenuateConfidence(proposal({ confidence: 0.6 }));
  assert.equal(got.confidence, 0.6);
  assert.deepEqual(got.warnings, []);
  assert.deepEqual(got.attenuations, []);
});
