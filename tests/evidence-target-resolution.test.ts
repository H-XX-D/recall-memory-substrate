import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { calibrationFactors, effectiveConfidence } from "../src/core/evidence.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// B1 regression suite: evidence references that should land as live trust
// edges must resolve to a real node id, and references that resolve to nothing
// must not materialize a dangling edge that the effective-confidence read
// would silently skip while still inflating the graph's apparent surface.
describe("evidence target resolution", () => {
  function seedTarget(store: SQLiteRecallStore, at: string): string {
    const result = admitWriteProposal(
      makeProposal({ content: { title: "Target cell", body: "the cell to be referenced", summary: "target" } }),
      store,
      { now: new Date(at) }
    );
    assert.equal(result.accepted, true);
    return result.node!.id;
  }

  it("expands a unique 8-char id-prefix reference to the full node id", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const fullId = seedTarget(store, "2026-06-01T00:00:00.000Z");
      const prefix = fullId.slice(0, 8);

      const result = admitWriteProposal(
        makeProposal({
          content: { title: "Supporter via prefix", body: "supports the target", summary: "supporter" },
          evidence: { supports: [prefix] }
        }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      assert.equal(result.accepted, true);
      const rel = result.relations.find((r) => r.kind === "supports");
      assert.ok(rel, "a supports relation was materialized");
      assert.equal(rel!.targetId, fullId, "the 8-char prefix expanded to the full UUID");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("keeps a full-UUID trust reference unchanged (regression)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const fullId = seedTarget(store, "2026-06-01T00:00:00.000Z");
      const result = admitWriteProposal(
        makeProposal({
          content: { title: "Contradictor", body: "contradicts the target", summary: "contradictor" },
          evidence: { contradicts: [fullId] }
        }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      assert.equal(result.accepted, true);
      const rel = result.relations.find((r) => r.kind === "contradicts");
      assert.ok(rel, "a contradicts relation was materialized");
      assert.equal(rel!.targetId, fullId);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("drops an unresolvable free-text trust reference and warns, but still admits", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: { title: "Free-text contradictor", body: "references a non-cell anchor", summary: "anchor" },
          evidence: { contradicts: ["HIERARCHY_FORCED"] }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );
      assert.equal(result.accepted, true, "the cell still lands");
      assert.equal(
        result.relations.filter((r) => r.kind === "contradicts").length,
        0,
        "no dangling contradicts relation is created"
      );
      assert.ok(
        result.warnings.some((w) => w.includes("dropped unresolved contradicts")),
        "a drop warning is surfaced"
      );
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("keeps an unresolvable depends_on reference (lenient, never scored)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: { title: "Grounded in an external anchor", body: "depends on something not yet a cell", summary: "grounding" },
          evidence: { depends_on: ["external-grounding-anchor"] }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );
      assert.equal(result.accepted, true);
      assert.equal(
        result.relations.filter((r) => r.kind === "depends_on").length,
        1,
        "depends_on is preserved even when unresolved"
      );
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("an expanded prefix support actually contributes effective-confidence mass", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const fullId = seedTarget(store, "2026-06-01T00:00:00.000Z");
      const before = effectiveConfidence(store, store.getNode(fullId)!, calibrationFactors(store));
      assert.equal(before.support, 0, "target starts with no support");

      admitWriteProposal(
        makeProposal({
          content: { title: "Supporter via prefix again", body: "supports the target", summary: "supporter" },
          evidence: { supports: [fullId.slice(0, 8)] }
        }),
        store,
        { now: new Date("2026-06-01T00:02:00.000Z") }
      );

      const after = effectiveConfidence(store, store.getNode(fullId)!, calibrationFactors(store));
      assert.ok(after.support > 0, "the expanded prefix support moves the score");
      assert.equal(after.supporters, 1, "exactly one supporter is counted");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
