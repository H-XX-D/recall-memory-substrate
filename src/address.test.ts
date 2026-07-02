import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHandle, parseValue, renderValue, parsePath } from "./address.js";

test("parseHandle reads kind, id, and mutability from a lowercase bare handle", () => {
  const h = parseHandle("dec_a3ee");
  assert.equal(h.kind, "dec");
  assert.equal(h.id, "a3ee");
  assert.equal(h.immutable, false);
});

test("parseHandle marks a capitalized handle as immutable", () => {
  assert.equal(parseHandle("RECALL_v5").immutable, true);
});

test("parseHandle rejects malformed mutable handles", () => {
  assert.throws(() => parseHandle("dec"));
  assert.throws(() => parseHandle("dec_xyz"));
  assert.throws(() => parseHandle("unknown_a3ee"));
  assert.throws(() => parseHandle("dec_bad-facet_a3ee"));
  assert.throws(() => parseHandle("dec_a3ee_b4ff_c5aa_d6bb_e7cc_f8dd_99aa_abcd"));
});

test("parseValue reads a mutable field(value) token", () => {
  const v = parseValue("eff(0.42)");
  assert.equal(v.field, "eff");
  assert.equal(v.value, 0.42);
  assert.equal(v.immutable, false);
});

test("parseValue reads the trailing ! as immutable", () => {
  const v = parseValue("conf(0.7!)");
  assert.equal(v.field, "conf");
  assert.equal(v.value, 0.7);
  assert.equal(v.immutable, true);
});

test("parseValue throws on a malformed token", () => {
  assert.throws(() => parseValue("conf 0.7"));
  assert.throws(() => parseValue("conf(Infinity)"));
});

test("renderValue writes a mutable token", () => {
  assert.equal(renderValue("eff", 0.42, false), "eff(0.42)");
});

test("renderValue marks immutable with a trailing !", () => {
  assert.equal(renderValue("conf", 0.7, true), "conf(0.7!)");
});

test("renderValue keeps integers integral and strips trailing zeros", () => {
  assert.equal(renderValue("tau", 3650, false), "tau(3650)");
  assert.equal(renderValue("c0", 1.0, false), "c0(1)");
  assert.equal(renderValue("cFloor", 0.1, false), "cFloor(0.1)");
});

test("renderValue and parseValue round-trip", () => {
  const v = parseValue(renderValue("salience", 0.835, true));
  assert.equal(v.field, "salience");
  assert.equal(v.value, 0.835);
  assert.equal(v.immutable, true);
});

test("parsePath reads a bare cell as one cell segment", () => {
  assert.deepEqual(parsePath("dec_a3ee"), [
    { kind: "cell", name: "dec_a3ee" },
  ]);
});

test("parsePath walks fields within a cell on -", () => {
  assert.deepEqual(parsePath("dec_a3ee-scores-conf"), [
    { kind: "cell", name: "dec_a3ee" },
    { kind: "field", name: "scores" },
    { kind: "field", name: "conf" },
  ]);
});

test("parsePath crosses an edge on . with no direction", () => {
  assert.deepEqual(parsePath("dec_a3ee.supports"), [
    { kind: "cell", name: "dec_a3ee" },
    { kind: "edge", name: "supports" },
  ]);
});

test("parsePath tags > as a forward edge and < as a reverse edge", () => {
  assert.deepEqual(parsePath("dec_a3ee.>supports.<contradicts"), [
    { kind: "cell", name: "dec_a3ee" },
    { kind: "edge", name: "supports", direction: "fwd" },
    { kind: "edge", name: "contradicts", direction: "rev" },
  ]);
});

test("parsePath supports ~ reverse edge, wildcard fanout, and @vN", () => {
  assert.deepEqual(parsePath("dec_a3ee@v2.~supports.*"), [
    { kind: "cell", name: "dec_a3ee", version: 2 },
    { kind: "edge", name: "supports", direction: "rev" },
    { kind: "edge", name: "*" },
  ]);
});

test("parsePath rejects empty or unknown segments", () => {
  assert.throws(() => parsePath(""));
  assert.throws(() => parsePath("dec_a3ee."));
  assert.throws(() => parsePath("dec_a3ee.nope"));
  assert.throws(() => parsePath("dec_a3ee-scores-"));
});

test("parsePath combines field walks and edge hops in order", () => {
  assert.deepEqual(parsePath("dec_a3ee-scores.>supports-title"), [
    { kind: "cell", name: "dec_a3ee" },
    { kind: "field", name: "scores" },
    { kind: "edge", name: "supports", direction: "fwd" },
    { kind: "field", name: "title" },
  ]);
});
