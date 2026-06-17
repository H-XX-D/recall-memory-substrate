import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Claude Code integration sync.
 *
 * Idempotently installs (and on re-run, refreshes to the bundled "best
 * functional version") everything that makes a Claude Code agent adopt Recall:
 *   1. the consult-recall hook script (SessionStart + UserPromptSubmit),
 *   2. the recall skill,
 *   3. the recall MCP server registration (user scope, ~/.claude.json),
 *   4. CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 so Recall is not shadowed by Claude
 *      Code's built-in auto-memory (default on; opt out with disableAutoMemory:false).
 *
 * All paths are injectable so the pure merge logic can be unit-tested against
 * temp directories without touching the real ~/.claude config.
 */

const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const HOOK_FILENAME = "recall-session-start.py";
/** Substring that uniquely identifies a Recall-owned hook entry. */
const HOOK_MARKER = HOOK_FILENAME;
const MCP_NAME = "recall";

export interface ClaudeIntegrationOptions {
  /** Defaults to ~/.claude */
  claudeHome?: string;
  /** Defaults to ~/.claude.json (user-scope MCP registry) */
  claudeJsonPath?: string;
  /** Defaults to the bundled integrations/claude directory */
  assetsRoot?: string;
  /** Disable Claude Code built-in auto-memory. Default true. */
  disableAutoMemory?: boolean;
  /** MCP launch command. Default "recall-mcp". */
  mcpCommand?: string;
}

export interface ClaudeIntegrationResult {
  claudeHome: string;
  hookPath: string;
  skillDir: string;
  mcpRegistered: boolean;
  autoMemoryDisabled: boolean;
  settingsBackup: string | null;
  actions: string[];
  notice: string;
}

export interface AutoMemoryResult {
  autoMemoryDisabled: boolean;
  changed: boolean;
  settingsPath: string;
  settingsBackup: string | null;
}

export interface ClaudeIntegrationStatus {
  claudeHome: string;
  hookInstalled: boolean;
  skillInstalled: boolean;
  mcpRegistered: boolean;
  autoMemoryDisabled: boolean;
  settingsPath: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no filesystem access)
// ---------------------------------------------------------------------------

/** The canonical SessionStart + UserPromptSubmit hook groups for a given script path. */
export function recallHookGroups(hookCommandPath: string): {
  SessionStart: unknown;
  UserPromptSubmit: unknown;
} {
  const q = JSON.stringify(hookCommandPath);
  return {
    SessionStart: {
      hooks: [{ type: "command", command: `python3 ${q}`, timeout: 15, statusMessage: "Consulting Recall memory…" }],
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command: `python3 ${q} --prompt`, timeout: 10 }],
    },
  };
}

function isRecallGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => typeof (h as { command?: unknown })?.command === "string"
    && (h as { command: string }).command.includes(HOOK_MARKER));
}

/**
 * Merge Recall's hook groups + auto-memory env var into an existing
 * settings.json object. Idempotent and refresh-safe: any prior Recall hook
 * groups are stripped and replaced with the canonical ones, so re-running
 * upgrades stale entries instead of duplicating them. Non-Recall settings are
 * preserved untouched. Returns a new object plus the list of changed keys.
 */
export function mergeSettings(
  existing: Record<string, unknown> | undefined | null,
  opts: { hookCommandPath: string; disableAutoMemory: boolean },
): { next: Record<string, unknown>; changed: string[] } {
  const changed: string[] = [];
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const groups = recallHookGroups(opts.hookCommandPath);

  const hooks: Record<string, unknown> = { ...((next.hooks as Record<string, unknown>) ?? {}) };
  for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
    const prev = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const withoutRecall = prev.filter((g) => !isRecallGroup(g));
    const nextArr = [...withoutRecall, groups[event]];
    if (JSON.stringify(prev) !== JSON.stringify(nextArr)) changed.push(`hooks.${event}`);
    hooks[event] = nextArr;
  }
  next.hooks = hooks;

  const env: Record<string, unknown> = { ...((next.env as Record<string, unknown>) ?? {}) };
  if (opts.disableAutoMemory) {
    if (env[AUTO_MEMORY_ENV] !== "1") { env[AUTO_MEMORY_ENV] = "1"; changed.push(`env.${AUTO_MEMORY_ENV}`); }
  } else if (AUTO_MEMORY_ENV in env) {
    delete env[AUTO_MEMORY_ENV];
    changed.push(`env.${AUTO_MEMORY_ENV} (removed)`);
  }
  next.env = env;

  return { next, changed };
}

/** Idempotently upsert the recall MCP server into a ~/.claude.json object. */
export function upsertMcpServer(
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

// ---------------------------------------------------------------------------
// Filesystem orchestration
// ---------------------------------------------------------------------------

function defaultAssetsRoot(): string {
  // dist/src/core/claude-integration.js -> <pkgroot>/integrations/claude
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "integrations", "claude");
}

function defaultClaudeHome(): string {
  return join(homedir(), ".claude");
}

function defaultClaudeJson(): string {
  return join(homedir(), ".claude.json");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function backupStamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupAndWrite(path: string, data: unknown): string | null {
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.recall-bak-${backupStamp()}`;
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return backup;
}

/**
 * Install/refresh the full Claude Code integration. Idempotent: safe to run on
 * every `recall` update to pull forward the latest bundled hook/skill/config.
 */
export function syncClaudeIntegration(options: ClaudeIntegrationOptions = {}): ClaudeIntegrationResult {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const claudeJsonPath = options.claudeJsonPath ?? defaultClaudeJson();
  const assetsRoot = options.assetsRoot ?? defaultAssetsRoot();
  const disableAutoMemory = options.disableAutoMemory ?? true;
  const mcpCommand = options.mcpCommand ?? "recall-mcp";
  const actions: string[] = [];

  // 1. hook script
  const hooksDir = join(claudeHome, "hooks");
  const hookPath = join(hooksDir, HOOK_FILENAME);
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(join(assetsRoot, "hooks", HOOK_FILENAME), hookPath);
  chmodSync(hookPath, 0o755);
  actions.push(`hook installed: ${hookPath}`);

  // 2. skill (merge-overwrite so updates refresh files in place)
  const skillDir = join(claudeHome, "skills", "recall");
  mkdirSync(dirname(skillDir), { recursive: true });
  cpSync(join(assetsRoot, "skill"), skillDir, { recursive: true, force: true });
  actions.push(`skill installed: ${skillDir}`);

  // 3. MCP registration (~/.claude.json)
  const claudeJson = readJson(claudeJsonPath);
  const mcp = upsertMcpServer(claudeJson, mcpCommand);
  if (mcp.changed) {
    backupAndWrite(claudeJsonPath, mcp.next);
    actions.push(`mcp registered: ${claudeJsonPath}`);
  }

  // 4. settings.json (hooks + auto-memory env), backed up before edit
  const settingsPath = join(claudeHome, "settings.json");
  const merged = mergeSettings(readJson(settingsPath), { hookCommandPath: hookPath, disableAutoMemory });
  let settingsBackup: string | null = null;
  if (merged.changed.length > 0) {
    settingsBackup = backupAndWrite(settingsPath, merged.next);
    actions.push(`settings.json updated (${merged.changed.join(", ")})`);
  }

  const notice = disableAutoMemory
    ? `Claude Code built-in auto-memory DISABLED (${AUTO_MEMORY_ENV}=1) so agents adopt Recall instead of native .md memory. `
      + "Revert anytime: `recall claude enable-auto-memory`. Skip during install with RECALL_KEEP_AUTOMEMORY=1."
    : "Claude Code auto-memory left ENABLED — agents may write native .md memory instead of Recall. "
      + "Enable adoption with: `recall claude disable-auto-memory`.";

  return {
    claudeHome,
    hookPath,
    skillDir,
    mcpRegistered: true,
    autoMemoryDisabled: disableAutoMemory,
    settingsBackup,
    actions,
    notice,
  };
}

/** Toggle only the auto-memory env var (no asset re-copy). enabled=true re-enables Claude Code auto-memory. */
export function setClaudeAutoMemory(enabled: boolean, options: ClaudeIntegrationOptions = {}): AutoMemoryResult {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const settingsPath = join(claudeHome, "settings.json");
  const existing = readJson(settingsPath);
  const merged = mergeSettingsEnvOnly(existing, !enabled);
  let settingsBackup: string | null = null;
  if (merged.changed) settingsBackup = backupAndWrite(settingsPath, merged.next);
  return { autoMemoryDisabled: !enabled, changed: merged.changed, settingsPath, settingsBackup };
}

function mergeSettingsEnvOnly(
  existing: Record<string, unknown>,
  disableAutoMemory: boolean,
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...existing };
  const env: Record<string, unknown> = { ...((next.env as Record<string, unknown>) ?? {}) };
  let changed = false;
  if (disableAutoMemory) {
    if (env[AUTO_MEMORY_ENV] !== "1") { env[AUTO_MEMORY_ENV] = "1"; changed = true; }
  } else if (AUTO_MEMORY_ENV in env) {
    delete env[AUTO_MEMORY_ENV];
    changed = true;
  }
  next.env = env;
  return { next, changed };
}

export function claudeIntegrationStatus(options: ClaudeIntegrationOptions = {}): ClaudeIntegrationStatus {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const claudeJsonPath = options.claudeJsonPath ?? defaultClaudeJson();
  const settingsPath = join(claudeHome, "settings.json");
  const settings = readJson(settingsPath);
  const env = (settings.env as Record<string, unknown>) ?? {};
  const mcp = (readJson(claudeJsonPath).mcpServers as Record<string, unknown>) ?? {};
  return {
    claudeHome,
    hookInstalled: existsSync(join(claudeHome, "hooks", HOOK_FILENAME)),
    skillInstalled: existsSync(join(claudeHome, "skills", "recall", "SKILL.md")),
    mcpRegistered: MCP_NAME in mcp,
    autoMemoryDisabled: env[AUTO_MEMORY_ENV] === "1",
    settingsPath,
  };
}
