import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("admission", () => {
  it("warns on titles over 20 words without rejecting them", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const longTitle = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
      const result = admitWriteProposal(makeProposal({ content: { title: longTitle } }), store);

      assert.equal(result.accepted, true);
      assert.ok(
        result.warnings.some((warning) => /title has 30 words/.test(warning)),
        `expected long-title warning, got: ${JSON.stringify(result.warnings)}`
      );

      const shortResult = admitWriteProposal(
        makeProposal({ content: { title: "Short title cell", body: "Different body for derivation." } }),
        store
      );
      assert.equal(shortResult.accepted, true);
      assert.equal(shortResult.warnings.some((warning) => /title has/.test(warning)), false);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("warns when a new cell nearly duplicates an existing one", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Flux capacitor calibration approach decided",
            body: "We calibrate the flux capacitor against the reference oscillator at startup, recording drift per session.",
            summary: "Calibration approach."
          }
        }),
        store
      );

      const nearDup = admitWriteProposal(
        makeProposal({
          content: {
            title: "Decided the flux capacitor calibration approach",
            body: "We calibrate the flux capacitor against the reference oscillator at startup, recording drift per session.",
            summary: "Calibration approach again."
          }
        }),
        store
      );
      assert.equal(nearDup.accepted, true);
      assert.ok(
        nearDup.warnings.some((warning) => /similar to existing cell/.test(warning)),
        `expected near-duplicate warning, got: ${JSON.stringify(nearDup.warnings)}`
      );

      const different = admitWriteProposal(
        makeProposal({
          content: {
            title: "Daemon lease renewal cadence observed",
            body: "Lease renewal happens every thirty seconds under contention; no starvation seen in the soak run.",
            summary: "Lease cadence."
          }
        }),
        store
      );
      assert.equal(different.accepted, true);
      assert.equal(different.warnings.some((warning) => /similar to existing cell/.test(warning)), false);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("admits a valid proposal into the graph and rollback journal", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(makeProposal(), store);

      assert.equal(result.accepted, true);
      assert.equal(store.stats().nodes, 1);
      assert.equal(store.stats().rollbackEntries, 1);
      assert.equal(result.node?.kind, "observation");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("creates evidence relations from proposal evidence arrays", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          evidence: {
            supports: ["belief:recall-active-memory"],
            concerns: ["risk:context-flooding"]
          }
        }),
        store
      );

      assert.equal(result.accepted, true);
      assert.equal(store.stats().relations, 2);
      assert.equal(result.relations.map((relation) => relation.kind).sort().join(","), "concerns,supports");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("normalizes cell-address evidence links to existing cell ids", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(makeProposal({ content: { title: "Addressable target cell" } }), store);
      assert.ok(target.node);

      const linked = admitWriteProposal(
        makeProposal({
          content: { title: "Address link witness" },
          evidence: {
            supports: [target.node.cellAddress]
          }
        }),
        store
      );

      assert.equal(linked.accepted, true);
      assert.equal(linked.relations[0]?.targetId, target.node.id);
      const evidence = linked.node?.data.evidence as { supports: string[] } | undefined;
      assert.equal(evidence?.supports[0], target.node.id);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("normalizes cell-address field references while preserving the entry parameter", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(
        makeProposal({
          content: {
            title: "Target with summary",
            body: "The full body should not be copied into later cells.",
            summary: "Reusable compact summary."
          }
        }),
        store
      );
      assert.ok(target.node);

      const linked = admitWriteProposal(
        makeProposal({
          content: { title: "Field link witness" },
          evidence: {
            supports: [`${target.node.cellAddress}#content.summary`]
          }
        }),
        store
      );

      assert.equal(linked.accepted, true);
      assert.equal(linked.relations[0]?.targetId, target.node.id);
      assert.deepEqual(linked.relations[0]?.data, {
        targetPath: "content.summary",
        targetRef: `${target.node.id}#content.summary`
      });
      const evidence = linked.node?.data.evidence as { supports: string[] } | undefined;
      assert.equal(evidence?.supports[0], `${target.node.id}#content.summary`);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("rejects secret-looking content", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          content: {
            body: `Never store this key: ${"sk-" + "test123456789012345678901234567890"}`
          }
        }),
        store
      );

      assert.equal(result.accepted, false);
      assert.equal(result.issues.some((issue) => issue.code === "secret_pattern"), true);
      assert.equal(store.stats().nodes, 0);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("attenuates unsupported high confidence", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          evidence: {
            source_refs: []
          },
          confidence: {
            value: 0.96,
            source_quality: "unknown"
          },
          provenance: {
            verification: "unverified"
          }
        }),
        store
      );

      assert.equal(result.accepted, true);
      const confidence = result.node?.data.confidence as { value: number } | undefined;
      assert.equal(confidence?.value, 0.7);
      assert.equal(result.attenuations.length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("requires review for program writes", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(
        makeProposal({
          intent: {
            kind: "program"
          }
        }),
        store
      );

      assert.equal(result.accepted, false);
      assert.equal(result.issues.some((issue) => issue.code === "program_requires_review"), true);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
