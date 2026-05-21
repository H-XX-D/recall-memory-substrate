import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateWriteProposal } from "../src/core/schema.js";
import { makeProposal } from "./helpers.js";

describe("write proposal schema", () => {
  it("accepts a complete strict write proposal", () => {
    const result = validateWriteProposal(makeProposal());

    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
  });

  it("rejects missing required blocks", () => {
    const proposal = makeProposal();
    delete (proposal as unknown as Record<string, unknown>).provenance;

    const result = validateWriteProposal(proposal);

    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.path === "provenance"), true);
  });

  it("rejects invalid probability fields", () => {
    const result = validateWriteProposal(
      makeProposal({
        confidence: {
          value: 1.7
        }
      })
    );

    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.path === "confidence.value"), true);
  });

  it("requires all structured tag families", () => {
    const proposal = makeProposal();
    delete (proposal.tags as unknown as Record<string, unknown>).rings;

    const result = validateWriteProposal(proposal);

    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.path === "tags.rings"), true);
  });

  it("accepts category/type/subject/project/idea/timestamp facet tags", () => {
    const result = validateWriteProposal(
      makeProposal({
        tags: {
          category: ["memory"],
          type: ["witness"],
          subject: ["compiler"],
          project: ["Recall"],
          idea: ["active-memory"],
          timestamp: ["2026-05-21"]
        }
      })
    );

    assert.equal(result.ok, true);
  });
});
