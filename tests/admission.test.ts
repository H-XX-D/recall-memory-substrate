import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("admission", () => {
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
