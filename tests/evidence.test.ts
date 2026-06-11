import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { calibrationFactors, effectiveConfidence } from "../src/core/evidence.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// Effective confidence is the living counterpart to stated confidence:
// recomputed from the graph surface on every read, no LLM, no persistence.
// These tests pin the calculus: supports lift (capped), challenges sink
// (hard), concerns count half, calibration discounts overconfident actors,
// and the stated value is never mutated.
describe("effective confidence", () => {
  function admit(store: SQLiteRecallStore, overrides: Parameters<typeof makeProposal>[0], at: string) {
    const result = admitWriteProposal(makeProposal(overrides), store, { now: new Date(at) });
    assert.equal(result.accepted, true);
    return result.node!;
  }

  it("equals stated confidence for an untouched cell", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const node = admit(store, {
        content: { title: "Lone claim", body: "Nothing links here.", summary: "Lone." }
      }, "2026-06-01T00:00:00.000Z");
      const breakdown = effectiveConfidence(store, node);
      assert.equal(breakdown.effective, breakdown.stated);
      assert.equal(breakdown.challengers, 0);
      assert.equal(breakdown.supporters, 0);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("sinks a challenged cell below its stated confidence and never mutates stated", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admit(store, {
        content: { title: "Pricing has three tiers", body: "Three tiers exist.", summary: "Three tiers." }
      }, "2026-06-01T00:00:00.000Z");
      admit(store, {
        content: { title: "Pricing has two tiers now", body: "Team tier retired.", summary: "Two tiers." },
        evidence: { contradicts: [target.id] }
      }, "2026-06-02T00:00:00.000Z");

      const breakdown = effectiveConfidence(store, target);
      assert.equal(breakdown.challengers, 1);
      assert.ok(breakdown.effective < breakdown.stated,
        `effective ${breakdown.effective} should be below stated ${breakdown.stated}`);
      // The stored claim is untouched — calibration depends on it.
      const reread = store.getNode(target.id)!;
      assert.equal((reread.data.confidence as { value: number }).value, breakdown.stated);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("weighs a concern at half a contradiction", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const contradicted = admit(store, {
        content: { title: "Claim alpha", body: "Alpha body.", summary: "Alpha." }
      }, "2026-06-01T00:00:00.000Z");
      const concerned = admit(store, {
        content: { title: "Claim beta", body: "Beta body.", summary: "Beta." }
      }, "2026-06-01T00:00:00.000Z");
      admit(store, {
        content: { title: "Challenger gamma", body: "Gamma challenges alpha.", summary: "Gamma." },
        evidence: { contradicts: [contradicted.id], concerns: [concerned.id] }
      }, "2026-06-02T00:00:00.000Z");

      const hard = effectiveConfidence(store, contradicted);
      const soft = effectiveConfidence(store, concerned);
      assert.ok(hard.challenge > soft.challenge,
        `contradiction ${hard.challenge} should outweigh concern ${soft.challenge}`);
      assert.ok(soft.challenge > 0);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("lifts a supported cell, but support saturates under its ceiling", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admit(store, {
        content: { title: "Supported claim", body: "Will gather support.", summary: "Supported." }
      }, "2026-06-01T00:00:00.000Z");
      for (let i = 0; i < 5; i += 1) {
        admit(store, {
          content: { title: `Corroboration ${i}`, body: `Backs the claim ${i}.`, summary: "Backs it." },
          evidence: { supports: [target.id] }
        }, `2026-06-0${2 + i}T00:00:00.000Z`);
      }
      const breakdown = effectiveConfidence(store, target);
      assert.equal(breakdown.supporters, 5);
      assert.ok(breakdown.effective > breakdown.stated);
      // Five supporters must not lift more than the ceiling allows.
      assert.ok(breakdown.support <= 0.15 + 1e-9);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("discounts actors with a record of confident wrongness, not humble ones", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      // Overconfident actor: three cells, all contradicted.
      const wrongIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const node = admit(store, {
          actor: { kind: "llm", id: "braggart", display: "Braggart" },
          provenance: { produced_by: "braggart" },
          content: { title: `Bold wrong claim ${i}`, body: `Wrong ${i}.`, summary: "Wrong." },
          confidence: { value: 0.95, uncertainty: 0.02, concern: 0.1, source_quality: "low", stability: "stable" }
        }, `2026-06-0${1 + i}T00:00:00.000Z`);
        wrongIds.push(node.id);
      }
      // Humble actor: three quiet cells, never contradicted.
      for (let i = 0; i < 3; i += 1) {
        admit(store, {
          actor: { kind: "llm", id: "humble", display: "Humble" },
          provenance: { produced_by: "humble" },
          content: { title: `Modest claim ${i}`, body: `Modest ${i}.`, summary: "Modest." },
          confidence: { value: 0.55, uncertainty: 0.3, concern: 0.2, source_quality: "medium", stability: "stable" }
        }, `2026-06-0${1 + i}T00:00:00.000Z`);
      }
      for (const id of wrongIds) {
        admit(store, {
          content: { title: `Refutation of ${id.slice(0, 8)}`, body: "Checked and wrong.", summary: "Refuted." },
          evidence: { contradicts: [id] }
        }, "2026-06-05T00:00:00.000Z");
      }

      const factors = calibrationFactors(store);
      const braggart = factors.get("braggart") ?? 1;
      const humble = factors.get("humble") ?? 1;
      assert.ok(braggart < 1, `braggart factor ${braggart} should be discounted`);
      assert.equal(humble, 1, "a never-contradicted humble actor stays neutral");
      assert.ok(braggart >= 0.5, "discount is floored");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
