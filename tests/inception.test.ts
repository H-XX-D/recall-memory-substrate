import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { buildInceptionScaffold } from "../src/core/inception.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { WriteProposal } from "../src/core/types.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// Inception gathers a slice of the graph and hands the model a pre-grounded
// write-back template: the generative synthesis stays the model's job, but the
// new row is born linked to its sources and lands as a vettable hypothesis.
describe("inception scaffold", () => {
  function admit(store: SQLiteRecallStore, overrides: Parameters<typeof makeProposal>[0], at: string) {
    const result = admitWriteProposal(makeProposal(overrides), store, { now: new Date(at) });
    assert.equal(result.accepted, true);
    return result.node!;
  }

  it("gathers a slice and pre-grounds the template in its sources", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const a = admit(store, {
        content: { title: "Token rotation gap", body: "Access tokens expire but never rotate.", summary: "No rotation." }
      }, "2026-06-01T00:00:00.000Z");
      const b = admit(store, {
        content: { title: "Token pool cap", body: "Capped the auth token pool to survive expiry load.", summary: "Pool capped." }
      }, "2026-06-01T00:01:00.000Z");

      const scaffold = buildInceptionScaffold(store, {
        objective: "token",
        project: "Recall",
        createdAt: "2026-06-02T00:00:00.000Z"
      });

      const sourceIds = scaffold.sources.map((s) => s.id);
      assert.ok(sourceIds.includes(a.id), "slice includes source A");
      assert.ok(sourceIds.includes(b.id), "slice includes source B");

      const tpl = scaffold.writebackTemplate;
      // Grounding guarantee: the template is born linked to exactly the slice.
      assert.deepEqual([...tpl.evidence.depends_on].sort(), [...sourceIds].sort());
      // Honest unvetted markers instead of a hard review block.
      assert.equal(tpl.intent.kind, "hypothesis");
      assert.ok(tpl.confidence.value <= 0.5, "conservative confidence");
      assert.ok(tpl.tags.quality.includes("unverified"), "marked unverified");
      assert.equal(tpl.policy.requires_review, false, "lands so the graph can vet it");
      // It is a template: content is blank for the model to fill.
      assert.equal(tpl.content.title, "");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("produces a template that admits once the model fills the synthesis", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admit(store, {
        content: { title: "Token rotation gap", body: "Access tokens expire but never rotate.", summary: "No rotation." }
      }, "2026-06-01T00:00:00.000Z");

      const scaffold = buildInceptionScaffold(store, {
        objective: "token",
        project: "Recall",
        createdAt: "2026-06-02T00:00:00.000Z"
      });

      // The model fills the synthesis; the pre-set enums, tags, and grounding stay.
      const filled: WriteProposal = scaffold.writebackTemplate;
      filled.content = {
        title: "Rotate-on-cap: tie token rotation to pool-cap events",
        body: "Synthesized from the rotation-gap and pool-cap cells: rotate tokens when the pool cap is hit, closing the no-rotation gap at the moment load already forces a pool decision.",
        summary: "Rotate tokens on pool-cap events."
      };

      const result = admitWriteProposal(filled, store, { now: new Date("2026-06-02T00:00:00.000Z") });
      assert.equal(result.accepted, true, "filled inception template admits cleanly");
      assert.equal(result.node!.kind, "hypothesis");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
