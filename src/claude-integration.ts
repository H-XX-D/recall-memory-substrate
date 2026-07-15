// R7 Claude integration helpers. Pure settings/config transforms only; bundled
// hook assets and full sync commands are later surfaces.
const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const HOOK_MARKER = "recall-session-start.py";
const MCP_NAME = "recall";

export interface ClaudeHookGroups {
  SessionStart: unknown;
  UserPromptSubmit: unknown;
  UserPromptExpansion: unknown;
  PostToolUse: unknown;
  Stop: unknown;
}

const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PostToolUse",
  "Stop",
] as const;

export interface RecallHookGroupsOpts {
  writeGate?: { stopHookCommand: string; promptHookCommand: string; receiptHookCommand: string };
}

export function recallHookGroups(hookCommandPath: string, opts?: RecallHookGroupsOpts): ClaudeHookGroups {
  const quoted = JSON.stringify(hookCommandPath);
  const writeGate = opts?.writeGate;

  // Matching command hooks run concurrently in Claude Code. The portable
  // Python hook therefore keeps its own turn-scoped state, independent of the
  // optional Node write-gate hooks below. Every Python mode is fail-open.
  const promptHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --prompt`, timeout: 10 }];
  const stopHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --stop`, timeout: 10 }];
  const toolHooks: unknown[] = [{ type: "command", command: `python3 ${quoted} --tool`, timeout: 10 }];
  if (writeGate) {
    promptHooks.push({ type: "command", command: writeGate.promptHookCommand });
    stopHooks.push({ type: "command", command: writeGate.stopHookCommand });
    toolHooks.push({ type: "command", command: writeGate.receiptHookCommand });
  }

  return {
    SessionStart: {
      hooks: [{ type: "command", command: `python3 ${quoted}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
    },
    UserPromptSubmit: {
      hooks: promptHooks,
    },
    UserPromptExpansion: {
      hooks: [{ type: "command", command: `python3 ${quoted} --expansion`, timeout: 10 }],
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

export function mergeClaudeSettings(
  existing: Record<string, unknown> | undefined | null,
  opts: { hookCommandPath: string; disableAutoMemory?: boolean; writeGate?: RecallHookGroupsOpts["writeGate"] },
): { next: Record<string, unknown>; changed: string[] } {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const changed: string[] = [];
  const groups = recallHookGroups(opts.hookCommandPath, opts.writeGate ? { writeGate: opts.writeGate } : undefined);
  const hooks: Record<string, unknown> = { ...((next.hooks as Record<string, unknown>) ?? {}) };

  for (const event of CLAUDE_HOOK_EVENTS) {
    const previous = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const withoutRecall = previous
      .map(stripRecallHandlers)
      .filter((group): group is unknown => group !== null);
    const replacement = [...withoutRecall, groups[event]];
    if (JSON.stringify(previous) !== JSON.stringify(replacement)) changed.push(`hooks.${event}`);
    hooks[event] = replacement;
  }
  next.hooks = hooks;

  const env: Record<string, unknown> = { ...((next.env as Record<string, unknown>) ?? {}) };
  const disableAutoMemory = opts.disableAutoMemory ?? true;
  if (disableAutoMemory) {
    if (env[AUTO_MEMORY_ENV] !== "1") {
      env[AUTO_MEMORY_ENV] = "1";
      changed.push(`env.${AUTO_MEMORY_ENV}`);
    }
  } else if (AUTO_MEMORY_ENV in env) {
    delete env[AUTO_MEMORY_ENV];
    changed.push(`env.${AUTO_MEMORY_ENV} (removed)`);
  }
  next.env = env;

  return { next, changed };
}

export function upsertClaudeMcpServer(
  existing: Record<string, unknown> | undefined | null,
  mcpCommand: string,
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const servers: Record<string, unknown> = { ...((next.mcpServers as Record<string, unknown>) ?? {}) };
  const desired = { type: "stdio", command: mcpCommand, args: [] as string[], env: {} as Record<string, string> };
  const changed = JSON.stringify(servers[MCP_NAME]) !== JSON.stringify(desired);
  servers[MCP_NAME] = desired;
  next.mcpServers = servers;
  return { next, changed };
}

function stripRecallHandlers(group: unknown): unknown | null {
  const hooks = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return group;
  const remaining = hooks.filter((hook) => !isRecallOwnedHandler(hook));
  return remaining.length > 0 ? { ...(group as Record<string, unknown>), hooks: remaining } : null;
}

function isRecallOwnedHandler(handler: unknown): boolean {
  const command = (handler as { command?: unknown })?.command;
  if (typeof command !== "string") return false;
  return command.includes(HOOK_MARKER)
    || /(^|\s)recall-(?:prompt|stop|receipt)-hook(?:\s|$)/.test(command);
}
