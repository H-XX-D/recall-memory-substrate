import { test } from "node:test";
import assert from "node:assert/strict";
import { stopDecision, renderWriteTemplate, stopHookResponse } from "./stop.js";
import { WRITE_TEMPLATE } from "./template.js";

test("stop releases the turn when a durable write happened this turn", () => {
  const d = stopDecision({ wroteThisTurn: true });
  assert.equal(d.release, true);
});

test("stop holds the turn when nothing was written this turn and offers the template", () => {
  const d = stopDecision({ wroteThisTurn: false });
  assert.equal(d.release, false);
  assert.ok(d.reason.length > 0);
  assert.deepEqual(d.template, { ...WRITE_TEMPLATE });
});

test("renderWriteTemplate returns every template field as its fill instruction", () => {
  const t = renderWriteTemplate();
  assert.equal(t.kind, WRITE_TEMPLATE.kind);
  assert.equal(Object.keys(t).length, Object.keys(WRITE_TEMPLATE).length);
});

test("stopHookResponse releases with an empty object when something was written", () => {
  assert.deepEqual(stopHookResponse({ wroteThisTurn: true }), {});
});

test("stopHookResponse blocks with the template appended when nothing was written", () => {
  const r = stopHookResponse({ wroteThisTurn: false });
  assert.equal(r.decision, "block");
  assert.ok(r.reason && r.reason.includes("Template to fill"));
});
