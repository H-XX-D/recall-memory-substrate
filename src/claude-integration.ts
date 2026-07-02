// R7 Claude integration helpers. Pure settings/config transforms only; bundled
// hook assets and full sync commands are later surfaces.
const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const HOOK_MARKER = "recall-session-start.py";
const MCP_NAME = "recall";

export interface ClaudeHookGroups {
  SessionStart: unknown;
  UserPromptSubmit: unknown;
  Stop: unknown;
}

export function recallHookGroups(hookCommandPath: string): ClaudeHookGroups {
  const quoted = JSON.stringify(hookCommandPath);
  return {
    SessionStart: {
      hooks: [{ type: "command", command: `python3 ${quoted}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command: `python3 ${quoted} --prompt`, timeout: 10 }],
    },
    Stop: {
      hooks: [{ type: "command", command: `python3 ${quoted} --stop`, timeout: 10 }],
    },
  };
}

export function mergeClaudeSettings(
  existing: Record<string, unknown> | undefined | null,
  opts: { hookCommandPath: string; disableAutoMemory?: boolean },
): { next: Record<string, unknown>; changed: string[] } {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const changed: string[] = [];
  const groups = recallHookGroups(opts.hookCommandPath);
  const hooks: Record<string, unknown> = { ...((next.hooks as Record<string, unknown>) ?? {}) };

  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"] as const) {
    const previous = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const withoutRecall = previous.filter((group) => !isRecallHookGroup(group));
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

function isRecallHookGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    const command = (hook as { command?: unknown })?.command;
    return typeof command === "string" && command.includes(HOOK_MARKER);
  });
}
