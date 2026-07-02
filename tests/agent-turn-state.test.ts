import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnState } from "../src/agent/turn-state.js";

describe("agent turn state", () => {
  it("allows a write on an unflagged turn", () => {
    const t = new TurnState();
    t.beginTurn([]);
    assert.equal(t.gate("mcp__recall__recall_write").behavior, "allow");
  });

  it("blocks a write on a flagged turn until a read opens the gate", () => {
    const t = new TurnState();
    t.beginTurn(["1750a919"]);
    assert.equal(t.gate("mcp__recall__recall_write").behavior, "deny");
    assert.equal(t.gate("mcp__recall__recall_compile").behavior, "allow"); // the read
    assert.equal(t.gate("mcp__recall__recall_write").behavior, "allow"); // gate now open
  });

  it("re-arms on the next turn (a fresh flagged turn blocks again)", () => {
    const t = new TurnState();
    t.beginTurn(["1750a919"]);
    t.gate("mcp__recall__recall_compile"); // dig satisfied this turn
    assert.equal(t.gate("mcp__recall__recall_write").behavior, "allow");
    t.beginTurn(["abcd1234"]); // new turn, new flag
    assert.equal(t.gate("mcp__recall__recall_write").behavior, "deny");
  });
});
