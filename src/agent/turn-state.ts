import { gateToolCall, isRecallReadTool, isRecallWriteTool, type GateDecision } from "./gate.js";

export type StopDecision = { block: false } | { block: true; reason: string };

const WRITE_BACK_REASON =
  "[Write back before release] You changed durable state this turn but wrote nothing to Recall. " +
  "Persist the finding with recall_write: pick the kind that fits " +
  "(decision|belief|risk|task|objective|observation|reflection) and WIRE it to what it relates to " +
  "(supports/contradicts/depends_on/supersedes). An unwired cell orphans and drops from retrieval.";

/**
 * Per-turn dig state for the agent harness.
 *
 * The harness feeds it two things: the flagged ids surfaced by the push at the
 * start of each turn (beginTurn), and every tool call before it runs (gate). It
 * remembers whether a Recall read has happened this turn and returns the gate
 * decision, re-arming on the next turn. This is the in-process state the Python
 * Stop-hook kept on disk; here it lives in the loop.
 */
export class TurnState {
  private pendingDig = new Set<string>();
  private sawRead = false;
  private didWork = false;
  private wroteBack = false;
  private stopNudged = false;

  // A new turn begins. The flagged ids are the SUPERSEDED/STALE cells the push
  // surfaced for this prompt; every per-turn obligation resets here.
  beginTurn(flaggedIds: Iterable<string>): void {
    this.pendingDig = new Set(flaggedIds);
    this.sawRead = false;
    this.didWork = false;
    this.wroteBack = false;
    this.stopNudged = false;
  }

  // Called before each tool runs. Returns the dig decision and tracks the turn's
  // shape: a Recall read opens the gate, an allowed recall_write records the
  // write-back, any other allowed tool counts as durable work.
  gate(toolName: string): GateDecision {
    const decision = gateToolCall(toolName, this.pendingDig, this.sawRead);
    if (isRecallReadTool(toolName)) {
      this.sawRead = true;
    } else if (decision.behavior === "allow") {
      this.didWork = true;
      if (isRecallWriteTool(toolName)) this.wroteBack = true;
    }
    return decision;
  }

  // Stage 3: at turn-end, nudge once to write back if the turn changed durable
  // state but persisted nothing. Single-shot, so it never traps the turn.
  stopDecision(): StopDecision {
    if (this.stopNudged) return { block: false };
    if (this.didWork && !this.wroteBack) {
      this.stopNudged = true;
      return { block: true, reason: WRITE_BACK_REASON };
    }
    return { block: false };
  }
}
