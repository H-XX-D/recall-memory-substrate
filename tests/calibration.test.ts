import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { analyzeMemory } from "../src/core/analysis.js";
import { analyzeCalibration } from "../src/core/calibration.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("actor calibration", () => {
  it("scores actors by how their stated confidence survived contradiction", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const overconfident: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const result = admitWriteProposal(
          makeProposal({
            content: {
              title: `Overconfident claim ${i}`,
              body: `Claim body ${i} asserted with high confidence.`,
              summary: `Claim ${i}.`
            },
            provenance: { produced_by: "actor-a" },
            confidence: { value: 0.9 },
            evidence: { source_refs: ["spec/a.md", "spec/b.md", "spec/c.md"] }
          }),
          store
        );
        assert.ok(result.node);
        overconfident.push(result.node.id);
      }

      admitWriteProposal(
        makeProposal({
          content: {
            title: "Refutation of claims zero and one",
            body: "Direct refutation with reproduction steps.",
            summary: "Refutation."
          },
          provenance: { produced_by: "actor-b" },
          confidence: { value: 0.8 },
          evidence: {
            source_refs: ["spec/refute.md"],
            contradicts: [overconfident[0], overconfident[1]]
          }
        }),
        store
      );

      const report = analyzeCalibration(store);
      const actorA = report.find((entry) => entry.actor === "actor-a");
      const actorB = report.find((entry) => entry.actor === "actor-b");

      assert.ok(actorA, "actor-a missing from calibration report");
      assert.equal(actorA.cells, 3);
      assert.equal(actorA.contradicted, 2);
      // Report values are rounded to 3 decimals for stable JSON output.
      assert.equal(actorA.contradictedRate, 0.667);
      assert.equal(actorA.meanConfidence, 0.9);
      assert.equal(actorA.meanConfidenceContradicted, 0.9);
      // Brier: two contradicted cells at 0.9 -> (0.9-0)^2 each; one surviving -> (0.9-1)^2.
      assert.equal(actorA.brierScore, 0.543);

      assert.ok(actorB, "actor-b missing from calibration report");
      assert.equal(actorB.cells, 1);
      assert.equal(actorB.contradicted, 0);
      assert.equal(actorB.meanConfidenceContradicted, null);
      assert.equal(actorB.brierScore, 0.04);

      // Worst calibration sorts first so the report reads as a triage list.
      assert.equal(report[0]?.actor, "actor-a");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("surfaces calibration inside the memory health report", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const health = analyzeMemory(store);

      assert.ok(Array.isArray(health.calibration));
      assert.equal(health.calibration[0]?.actor, "codex");
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
