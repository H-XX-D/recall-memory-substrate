import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnState } from "../src/agent/turn-state.js";

describe("agent stop write-back gate", () => {
  it("releases a trivial turn with no tool use", () => {
    const t = new TurnState();
    t.beginTurn([]);
    assert.deepEqual(t.stopDecision(), { block: false });
  });

  it("nudges once when the turn did work but wrote nothing back", () => {
    const t = new TurnState();
    t.beginTurn([]);
    t.gate("Edit"); // did real work
    const d = t.stopDecision();
    assert.equal(d.block, true);
    if (d.block) assert.match(d.reason, /write back|persist|wire/i);
    assert.deepEqual(t.stopDecision(), { block: false }); // single-shot, never traps
  });

  it("releases when the turn already wrote back to Recall", () => {
    const t = new TurnState();
    t.beginTurn([]);
    t.gate("Edit");
    t.gate("mcp__recall__recall_write"); // wrote back (unflagged turn, allowed)
    assert.deepEqual(t.stopDecision(), { block: false });
  });

  it("does not nudge a read-only turn (compiling to answer is not a durable finding)", () => {
    const t = new TurnState();
    t.beginTurn([]);
    t.gate("mcp__recall__recall_compile");
    assert.deepEqual(t.stopDecision(), { block: false });
  });

  it("re-arms the write-back nudge on the next turn", () => {
    const t = new TurnState();
    t.beginTurn([]);
    t.gate("Edit");
    t.stopDecision(); // nudged this turn
    t.beginTurn([]); // new turn
    t.gate("Bash"); // did work again, no write
    assert.equal(t.stopDecision().block, true);
  });
});
