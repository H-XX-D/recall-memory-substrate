import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateToolCall, isRecallReadTool } from "../src/agent/gate.js";

describe("agent dig gate", () => {
  it("allows everything when nothing was flagged this turn", () => {
    assert.deepEqual(gateToolCall("mcp__recall__recall_write", new Set(), false), { behavior: "allow" });
    assert.deepEqual(gateToolCall("Bash", new Set(), false), { behavior: "allow" });
  });

  it("blocks a write when a cell was flagged and not yet dug", () => {
    const d = gateToolCall("mcp__recall__recall_write", new Set(["1750a919"]), false);
    assert.equal(d.behavior, "deny");
    if (d.behavior === "deny") {
      assert.match(d.message, /DIG REQUIRED/);
      assert.match(d.message, /1750a919/);
    }
  });

  it("allows the write once a Recall read has happened this turn", () => {
    assert.deepEqual(
      gateToolCall("mcp__recall__recall_write", new Set(["1750a919"]), true),
      { behavior: "allow" },
    );
  });

  it("always allows a Recall read, even on a flagged not-yet-dug turn", () => {
    assert.deepEqual(
      gateToolCall("mcp__recall__recall_compile", new Set(["1750a919"]), false),
      { behavior: "allow" },
    );
  });

  it("does not block non-write tools (the gate governs assertion, not an allowlist)", () => {
    assert.deepEqual(gateToolCall("Bash", new Set(["1750a919"]), false), { behavior: "allow" });
  });

  it("recognizes recall read tools by mcp and cli name", () => {
    assert.equal(isRecallReadTool("mcp__recall__recall_compile"), true);
    assert.equal(isRecallReadTool("recall_search"), true);
    assert.equal(isRecallReadTool("mcp__recall__recall_write"), false);
    assert.equal(isRecallReadTool("Bash"), false);
  });
});
