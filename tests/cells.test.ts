import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { deriveCellAddress, parseCellAddress } from "../src/core/cells.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("addressable cells", () => {
  it("derives stable address facets from full tag metadata", () => {
    const proposal = makeProposal();
    const address = deriveCellAddress(proposal, "node-123");
    const parsed = parseCellAddress(address);

    assert.equal(parsed.project, "recall");
    assert.equal(parsed.category, "memory");
    assert.equal(parsed.type, "observation");
    assert.equal(parsed.subject, "schema");
    assert.equal(parsed.idea, "strict-write-schema");
    assert.equal(parsed.timestamp, "2026-05-21");
    assert.equal(parsed.id, "node-123");
  });

  it("derives usable addresses when facet tags are sparse", () => {
    const proposal = makeProposal();
    delete proposal.tags.category;
    delete proposal.tags.type;
    delete proposal.tags.subject;
    delete proposal.tags.project;
    delete proposal.tags.idea;
    delete proposal.tags.timestamp;
    const parsed = parseCellAddress(deriveCellAddress(proposal, "node-456"));

    assert.equal(parsed.project, "recall");
    assert.equal(parsed.category, "memory");
    assert.equal(parsed.type, "observation");
    assert.equal(parsed.subject, "recall-schema-initialized");
    assert.equal(parsed.idea, "general");
    assert.equal(parsed.timestamp, "2026-05-21");
  });

  it("persists nodes with addressable cell addresses", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = admitWriteProposal(makeProposal(), store);
      assert.equal(result.accepted, true);
      assert.ok(result.node?.cellAddress.startsWith("recall://cell/"));

      const found = store.getNodeByAddress(result.node!.cellAddress);
      assert.equal(found?.id, result.node?.id);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
