// R7 agent integration core: platform-neutral Recall directives and prompt
// context pushes. This slice stays pure; CLI/MCP/server surfaces wire these
// helpers later.
import { compileContext, formatContextPacket, type ContextCompileOptions, type ContextPacket } from "./compile.js";
import type { Store } from "./types.js";

export const RECALL_BLOCK_BEGIN = "<!-- recall:begin (managed by Recall v5) -->";
export const RECALL_BLOCK_END = "<!-- recall:end -->";

export interface DirectiveOptions {
  includeMcp?: boolean;
  includeCli?: boolean;
}

export interface PromptContextPush {
  objective: string;
  directive: string;
  packet: ContextPacket;
  text: string;
  expansionRequired: boolean;
}

export function recallDirectiveBlock(options: DirectiveOptions = {}): string {
  const includeMcp = options.includeMcp ?? true;
  const includeCli = options.includeCli ?? true;
  const readFirst = includeCli
    ? '`recall compile "<task>"` for an ID-first packet'
    : "use the injected Recall context packet for orientation";
  const expand = includeCli
    ? "`recall cell show <id>` for exact expansion"
    : "expand only the provided Recall handles when exact evidence matters";
  const writeBack = includeMcp
    ? "`recall_write` or `recall admit` for durable write-back"
    : "`recall admit` for durable write-back";

  return [
    RECALL_BLOCK_BEGIN,
    "## Recall durable memory",
    "",
    "Recall is the durable memory layer. Read from it before trusting recollection,",
    "and write durable findings back when the work produces lasting evidence.",
    "",
    `- Read first: ${readFirst}.`,
    `- Expand lazily: ${expand}.`,
    `- Write back: ${writeBack}.`,
    "- Corrections supersede: find the prior cell and admit the new one with `evidence.contradicts` pointing at it.",
    "- Never store secrets in normal memory; use the encrypted secret side store only.",
    "- Project routing is by registered cwd for CLI; detached MCP calls should pass an explicit project slug.",
    RECALL_BLOCK_END,
    "",
  ].join("\n");
}

export function mergeRecallDirective(existing: string | undefined | null, options: DirectiveOptions = {}): {
  next: string;
  changed: boolean;
} {
  const prior = existing ?? "";
  const block = recallDirectiveBlock(options);
  let stripped = prior;
  for (;;) {
    const begin = stripped.indexOf(RECALL_BLOCK_BEGIN);
    if (begin < 0) break;
    const end = stripped.indexOf(RECALL_BLOCK_END, begin);
    stripped = end >= 0
      ? stripped.slice(0, begin) + stripped.slice(end + RECALL_BLOCK_END.length)
      : stripped.slice(0, begin);
  }
  stripped = stripped.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const next = stripped.length > 0 ? `${stripped}\n\n${block}` : block;
  return { next, changed: next !== prior };
}

export function recallSlashPrompt(): string {
  return [
    "---",
    "description: Use Recall active memory for this task",
    "argument-hint: [TASK]",
    "---",
    "",
    "Use Recall as the durable memory layer for this request before relying on recollection.",
    "Treat `$ARGUMENTS` as the task when supplied; otherwise infer the task from the current user request.",
    "",
    "Start with:",
    "",
    "```bash",
    'recall compile "$ARGUMENTS" --words 900',
    "```",
    "",
    "Use returned cell IDs as evidence handles and expand only what matters with `recall cell show <id>`.",
    "Write durable outcomes back through `recall_write` or `recall admit`.",
    "If new information corrects an older cell, admit it with `evidence.contradicts` pointing at that prior cell.",
    "",
  ].join("\n");
}

export function buildPromptContextPush(
  store: Store,
  objective: string,
  options: ContextCompileOptions & DirectiveOptions = {},
): PromptContextPush {
  const packet = compileContext(store, objective, options);
  const directive = recallDirectiveBlock(options);
  const expansionRequired = packet.staleOrLowTrust.length > 0 || packet.conflicts.length > 0;
  const text = [
    "[Recall context push for this prompt]",
    directive.trimEnd(),
    "",
    formatContextPacket(packet),
    expansionRequired
      ? "EXPAND REQUIRED: conflicts or low-trust cells are present; inspect relevant handles before relying on them."
      : "Use expansion_handles only when exact evidence matters.",
    "",
  ].join("\n");
  return { objective, directive, packet, text, expansionRequired };
}

export function buildStopReminder(): string {
  return [
    "[Recall write-back reminder]",
    "Before ending, write durable observations, decisions, risks, tasks, or verification results through Recall.",
    "If this turn corrected prior memory, supersede with `evidence.contradicts`; do not overwrite or duplicate.",
    "Do not put secrets in normal memory.",
  ].join("\n");
}
