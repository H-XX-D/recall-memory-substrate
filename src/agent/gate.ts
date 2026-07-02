/**
 * In-process dig gate for the agent harness.
 *
 * Pure decision: given the cells this turn flagged as superseded or stale, and
 * whether a Recall read has already happened this turn, decide whether a
 * load-bearing tool call may proceed. This is the in-process analog of the
 * Stop-hook dig backstop: a write that would assert durable state from a
 * flagged-but-unread cell is blocked until that cell is actually read.
 *
 * The same decision is meant to feed both delivery tiers: the SDK harness calls
 * it from canUseTool, the Claude Code adapter calls it from PreToolUse. Keeping
 * the logic here, single-sourced, is what stops the two tiers from drifting.
 */

export type GateDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

// Recall READ tools, by MCP name and CLI verb. A call to any of these satisfies
// the dig for the turn.
const RECALL_READ =
  /^(?:mcp__recall__recall_(?:compile|search|semantic|cell|subgraph|beliefs|status)|recall_(?:compile|search|semantic|cell|subgraph|beliefs))$/;

// Tools that assert durable state from memory, and so must not run on a turn
// that flagged a cell the model has not yet read.
const LOAD_BEARING = /^(?:mcp__recall__recall_write|recall_write)$/;

export function isRecallReadTool(toolName: string): boolean {
  return RECALL_READ.test(toolName);
}

export function isRecallWriteTool(toolName: string): boolean {
  return LOAD_BEARING.test(toolName);
}

export function gateToolCall(
  toolName: string,
  pendingDig: ReadonlySet<string>,
  sawRead: boolean,
): GateDecision {
  if (pendingDig.size === 0) return { behavior: "allow" };
  if (isRecallReadTool(toolName)) return { behavior: "allow" };
  if (sawRead) return { behavior: "allow" };
  if (LOAD_BEARING.test(toolName)) {
    const ids = [...pendingDig].slice(0, 5).join(", ");
    return {
      behavior: "deny",
      message:
        `DIG REQUIRED: this turn flagged superseded/stale Recall cell(s) ${ids}. ` +
        `Run recall_compile or recall_cell on the flagged cell(s) before writing back.`,
    };
  }
  return { behavior: "allow" };
}
