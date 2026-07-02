import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveConfidence, currency } from "./scores.js";

test("effectiveConfidence with zero masses equals clamp01(stated*calibration)", () => {
  const stated = 0.8;
  const calibration = 0.9;
  const got = effectiveConfidence({ stated, calibration, supportMass: 0, challengeMass: 0 });
  assert.equal(got, stated * calibration);
});

test("effectiveConfidence applies support and challenge masses through tanh", () => {
  const got = effectiveConfidence({
    stated: 0.5,
    calibration: 1,
    supportMass: 1,
    challengeMass: 0,
  });
  const expected = 0.5 + 0.15 * Math.tanh(1) - 0.6 * Math.tanh(0);
  assert.equal(got, expected);
  assert.ok(got > 0.5);
});

test("effectiveConfidence drives a small stated below 0 and clamps to 0", () => {
  // stated*calibration = 0.1; challenge term ~ -0.6 pulls it negative, clamp to 0.
  const got = effectiveConfidence({
    stated: 0.1,
    calibration: 1,
    supportMass: 0,
    challengeMass: 100,
  });
  assert.equal(got, 0);
});

test("effectiveConfidence clamps above 1 back to 1", () => {
  const got = effectiveConfidence({
    stated: 1,
    calibration: 1,
    supportMass: 100,
    challengeMass: 0,
  });
  assert.equal(got, 1);
});

test("currency at dt=0 equals c0", () => {
  assert.equal(currency({ c0: 1, dt: 0, tau: 30 }), 1);
});

test("currency at very large dt approaches cFloor", () => {
  const got = currency({ c0: 1, dt: 1e9, tau: 30, cFloor: 0.1 });
  assert.ok(Math.abs(got - 0.1) < 1e-9, `expected ~0.1, got ${got}`);
});

test("currency cFloor defaults to 0.1", () => {
  const withDefault = currency({ c0: 1, dt: 30, tau: 30 });
  const explicit = currency({ c0: 1, dt: 30, tau: 30, cFloor: 0.1 });
  assert.equal(withDefault, explicit);
});

test("currency after one tau has decayed by a factor of e", () => {
  const tau = 30;
  const got = currency({ c0: 1, dt: tau, tau });
  const expected = 0.1 + (1 - 0.1) * Math.exp(-1);
  assert.equal(got, expected);
});

test("currency stays at c0 when dt=0 for any tau and floor", () => {
  for (const tau of [3650, 30, 7]) {
    assert.equal(currency({ c0: 0.7, dt: 0, tau, cFloor: 0.2 }), 0.7);
  }
});
