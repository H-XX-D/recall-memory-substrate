// R7 Codex integration helpers. Pure text/config transforms only; filesystem
// sync and CLI command wiring belong to R8.
import { mergeRecallDirective, recallDirectiveBlock, recallSlashPrompt } from "./agent-integration.js";

const MCP_NAME = "recall";
const HOOK_MARKER = "recall-session-start.py";
const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;

export function recallAgentsBlock(): string {
  return recallDirectiveBlock();
}

export function mergeAgentsMd(existing: string | undefined | null): { next: string; changed: boolean } {
  return mergeRecallDirective(existing);
}

export { recallSlashPrompt };

/** Native Codex subset of the portable Recall lifecycle hook. */
export interface CodexHookGroupsOptions {
  writeGate?: { stopHookCommand: string; promptHookCommand: string; receiptHookCommand: string };
}

export function recallCodexHookGroups(
  hookCommandPath: string,
  opts: CodexHookGroupsOptions = {},
): Record<string, unknown> {
  const quoted = JSON.stringify(hookCommandPath);
  const promptHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --prompt`, timeout: 10 }];
  const stopHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --stop`, timeout: 10 }];
  const toolHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --tool`, timeout: 10 }];
  if (opts.writeGate) {
    promptHooks.push({ type: "command", command: opts.writeGate.promptHookCommand });
    stopHooks.push({ type: "command", command: opts.writeGate.stopHookCommand });
    toolHooks.push({ type: "command", command: opts.writeGate.receiptHookCommand });
  }
  return {
    SessionStart: {
      hooks: [{
        type: "command",
        command: `python3 ${quoted}`,
        timeout: 15,
        statusMessage: "Consulting Recall memory...",
      }],
    },
    UserPromptSubmit: {
      hooks: promptHooks,
    },
    PostToolUse: {
      matcher: "Bash|mcp__recall__.*",
      hooks: toolHooks,
    },
    Stop: {
      hooks: stopHooks,
    },
  };
}

/** Merge Recall-owned handlers without deleting unrelated siblings. */
export function mergeCodexHooks(
  existing: Record<string, unknown> | undefined | null,
  hookCommandPath: string,
  opts: CodexHookGroupsOptions = {},
): { next: Record<string, unknown>; changed: boolean } {
  const prior = existing ?? {};
  const next: Record<string, unknown> = { ...prior };
  const hooks: Record<string, unknown> = { ...((next.hooks as Record<string, unknown>) ?? {}) };
  const desired = recallCodexHookGroups(hookCommandPath, opts);

  for (const event of CODEX_HOOK_EVENTS) {
    const previous = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const kept = previous.map(stripRecallHandlers).filter((group) => group !== null);
    hooks[event] = [...kept, desired[event]];
  }
  next.hooks = hooks;
  return { next, changed: JSON.stringify(next) !== JSON.stringify(prior) };
}

/** Codex warns when hooks.json and inline hooks coexist in one config layer. */
export function hasInlineCodexHooks(tomlText: string | undefined | null): boolean {
  return /^\s*\[\[?hooks(?:\]\]?|\.(?!state(?:\.|\]\]?)))/m.test(tomlText ?? "");
}

function stripRecallHandlers(group: unknown): unknown | null {
  const handlers = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(handlers)) return group;
  const remaining = handlers.filter((handler) => {
    const command = (handler as { command?: unknown })?.command;
    return typeof command !== "string" || !(command.includes(HOOK_MARKER)
      || /(^|\s)recall-(?:prompt|stop|receipt)-hook(?:\s|$)/.test(command));
  });
  return remaining.length > 0 ? { ...(group as Record<string, unknown>), hooks: remaining } : null;
}

export function recallMcpToml(mcpCommand: string, recallDb?: string, integrityGate = false): string {
  let text = `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(mcpCommand)}\n`;
  if (recallDb || integrityGate) {
    text += `\n[mcp_servers.${MCP_NAME}.env]\n`;
    if (recallDb) text += `RECALL_DB = ${JSON.stringify(recallDb)}\n`;
    if (integrityGate) text += `RECALL_INTEGRITY_GATE = "1"\n`;
  }
  return text;
}

export function upsertCodexMcpServer(
  tomlText: string | undefined | null,
  opts: { mcpCommand: string; recallDb?: string; integrityGate?: boolean },
): { next: string; changed: boolean } {
  const prior = tomlText ?? "";
  const lines = prior.split("\n");
  const kept: string[] = [];
  let skippingRecallTable = false;
  let inTopLevel = true;

  for (const line of lines) {
    const header = tableHeaderPath(line);
    if (header) {
      if (ownsRecallPath(header)) {
        skippingRecallTable = true;
        continue;
      }
      skippingRecallTable = false;
      inTopLevel = false;
      kept.push(line);
      continue;
    }
    if (skippingRecallTable) continue;
    if (inTopLevel) {
      const eq = line.indexOf("=");
      if (eq >= 0 && ownsRecallPath(parseDottedPath(line.slice(0, eq)))) continue;
    }
    kept.push(line);
  }

  const body = kept.join("\n").replace(/\s+$/, "");
  const block = recallMcpToml(opts.mcpCommand, opts.recallDb, opts.integrityGate);
  const next = body ? `${body}\n\n${block}` : block;
  return { next, changed: next !== prior };
}

function tableHeaderPath(line: string): string[] | null {
  const match = line.trim().match(/^\[([^\]]+)\]\s*(#.*)?$/);
  return match ? parseDottedPath(match[1] ?? "") : null;
}

function parseDottedPath(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function ownsRecallPath(path: string[]): boolean {
  return path[0] === "mcp_servers" && path[1] === MCP_NAME;
}
