// MAL Stop gate: the write-side twin of the dig backstop. The turn cannot end
// until a durable write was admitted THIS turn. "This turn" is decided by the
// store, not a write-path marker: the UserPromptSubmit hook stamps a turn-start
// timestamp, and the Stop hook checks whether any cell was created at/after it.
// On hold, the gate re-injects the fill-or-reject template (a field left equal to
// its description is rejected by admission). A hook script calls stopHookResponse
// and, when release is false, returns {decision:"block", reason} so the turn stays alive.
import { WRITE_TEMPLATE } from "./template.js";

export interface StopState {
  wroteThisTurn: boolean; // did any durable cell get created this turn
  noWriteReceipt?: boolean; // explicit attestation that no durable outcome exists
}

export interface StopDecision {
  release: boolean; // true: let the turn end
  reason: string; // the block reason shown while held; empty on release
  template?: Record<string, string>; // the fill-or-reject template to inject when held
}

export function renderWriteTemplate(): Record<string, string> {
  return { ...WRITE_TEMPLATE };
}

export function stopDecision(state: StopState): StopDecision {
  if (state.wroteThisTurn || state.noWriteReceipt) {
    return { release: true, reason: "" };
  }
  const reason = [
    "[Recall Stop gate] The turn cannot end until a durable write-back is admitted this turn.",
    "Write what you learned. Fill every template field with a real value (use null only when genuinely not applicable); a missing field or a field left as its description is rejected.",
    "At least one honest, resolvable edge is required. Never invent memory or an edge to satisfy this gate.",
    "If this turn produced no durable outcome, end with exactly: [Recall no-write: no durable outcome]",
  ].join("\n");
  return { release: false, reason, template: renderWriteTemplate() };
}

export const NO_WRITE_RECEIPT = "[Recall no-write: no durable outcome]";

// Map a stop decision to the Claude Code Stop-hook output. Release is `{}` (the
// turn ends). Hold is `{decision:"block", reason}` with the template appended so
// the model sees the fields to fill before it can close the turn.
export function stopHookResponse(state: StopState): { decision?: "block"; reason?: string } {
  const d = stopDecision(state);
  if (d.release) return {};
  const tmpl = d.template
    ? `\n\nTemplate to fill (every field must differ from its instruction):\n${JSON.stringify(d.template, null, 2)}`
    : "";
  return { decision: "block", reason: d.reason + tmpl };
}
