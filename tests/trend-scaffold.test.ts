import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrendScaffold } from "../src/core/trend-scaffold.js";
import { validateProgramSpec } from "../src/core/programs.js";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";
import type { RecallStore } from "../src/core/store.js";

// The trend scaffold is the agent-native "interactive": instead of a blocking
// prompt, it returns a fillable trend-program spec template (parameters,
// the mover/measure, and the trip constraints) plus candidate member cells
// from the objective search and a directive. The agent fills it and attaches
// it, the same shape as Inception.

function seed(store: RecallStore): void {
  admitWriteProposal(
    makeProposal({ content: { title: "Load verification confidence", body: "tracked", summary: "tracked" } }),
    store,
    { now: new Date("2026-06-01T00:00:00.000Z") }
  );
}

describe("trend scaffold (the agent-fillable interactive)", () => {
  it("returns a valid, fillable trend spec template with parameters and constraints", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      seed(store);
      const scaffold = buildTrendScaffold(store, { objective: "load verification confidence" });
      assert.equal(scaffold.specTemplate.operation, "trend");
      assert.equal(scaffold.specTemplate.schemaVersion, "recall.program.v1");
      const params = scaffold.specTemplate.params as Record<string, unknown>;
      assert.equal(params.measure, "effective_confidence");
      assert.equal(params.window, 8);
      assert.equal(params.delta, 0.1);
      assert.equal(params.streak, 3);
      // the template is a real, attachable spec: it round-trips through validation
      assert.doesNotThrow(() => validateProgramSpec(scaffold.specTemplate));
      assert.ok(typeof scaffold.directive === "string" && scaffold.directive.length > 0);
      assert.ok(Array.isArray(scaffold.movers));
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("candidate movers come from the objective search", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      seed(store);
      const scaffold = buildTrendScaffold(store, { objective: "load verification" });
      assert.ok(scaffold.movers.length >= 1, "a matching cell should surface as a candidate mover");
      assert.ok(scaffold.movers.every((m) => typeof m.cellAddress === "string"));
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("options override the parameter and constraint defaults", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const scaffold = buildTrendScaffold(store, {
        objective: "x",
        window: 5,
        delta: 0.25,
        streak: 4,
        measure: "member_count"
      });
      const params = scaffold.specTemplate.params as Record<string, unknown>;
      assert.equal(params.window, 5);
      assert.equal(params.delta, 0.25);
      assert.equal(params.streak, 4);
      assert.equal(params.measure, "member_count");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("numeric options include a path fallback in the spec template", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const scaffold = buildTrendScaffold(store, {
        objective: "lockout updates per second",
        measure: "numeric",
        path: "#data.metrics.updates_per_s"
      });
      const params = scaffold.specTemplate.params as Record<string, unknown>;
      assert.equal(params.measure, "numeric");
      assert.equal(params.path, "data.metrics.updates_per_s");
      assert.match(scaffold.directive, /#path/);
      assert.doesNotThrow(() => validateProgramSpec(scaffold.specTemplate));
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
