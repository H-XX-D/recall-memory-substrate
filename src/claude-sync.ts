// R7 Claude sync: file IO plumbing around the pure claude-integration
// transforms and the auto-memory lift. Dry-run by default like every other
// adapter surface; writes are gated on apply, with a .bak backup of any prior
// file content that is actually being changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { importAutoMemory, type ImportSummary } from "./adapters.js";
import { mergeClaudeSettings, upsertClaudeMcpServer } from "./claude-integration.js";
import { homeDbPath } from "./routing.js";
import { SqliteStore } from "./store.js";

export const DEFAULT_AUTO_MEMORY_ROOT = join(homedir(), ".claude", "projects");

export interface ClaudeSyncOptions {
  home?: string;
  hookCommandPath?: string;
  mcpCommand?: string;
  disableAutoMemory?: boolean;
  importMemory?: boolean;
  autoMemoryRoot?: string;
  dbPath?: string;
  apply?: boolean;
  now?: string;
}

export interface ClaudeSyncResult {
  dryRun: boolean;
  settingsPath: string;
  settingsChanged: string[];
  mcpPath: string;
  mcpChanged: boolean;
  backups: string[];
  autoMemoryImport: ImportSummary | null;
  autoMemoryDb: string | null;
}

export function claudeSyncStatus(
  opts: Pick<ClaudeSyncOptions, "home"> = {},
): {
  settingsPath: string;
  hooksInstalled: boolean;
  autoMemoryDisabled: boolean;
  mcpPath: string;
  mcpInstalled: boolean;
} {
  const home = opts.home ?? homedir();
  const settingsFile = join(home, ".claude", "settings.json");
  const mcpFile = join(home, ".claude.json");

  const settings = readJsonSafe(settingsFile);
  const hooks = isRecord(settings?.hooks) ? (settings!.hooks as Record<string, unknown>) : {};
  const hooksInstalled = ["SessionStart", "UserPromptSubmit", "Stop"].every((event) =>
    hasRecallHook(hooks[event]),
  );
  const env = isRecord(settings?.env) ? (settings!.env as Record<string, unknown>) : {};
  const autoMemoryDisabled = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1";

  const mcpConfig = readJsonSafe(mcpFile);
  const mcpServers = isRecord(mcpConfig?.mcpServers) ? (mcpConfig!.mcpServers as Record<string, unknown>) : {};
  const mcpInstalled = isRecord(mcpServers.recall);

  return {
    settingsPath: settingsFile,
    hooksInstalled,
    autoMemoryDisabled,
    mcpPath: mcpFile,
    mcpInstalled,
  };
}

export function runClaudeSync(opts: ClaudeSyncOptions = {}): ClaudeSyncResult {
  const home = opts.home ?? homedir();
  const apply = opts.apply ?? false;
  const hookCommandPath = opts.hookCommandPath ?? join(home, ".claude", "hooks", "recall-session-start.py");
  const mcpCommand = opts.mcpCommand ?? "recall-mcp";
  const importMemory = opts.importMemory ?? true;
  const backups: string[] = [];

  const settingsFile = join(home, ".claude", "settings.json");
  const existingSettings = readJsonSafe(settingsFile) ?? {};
  const settingsMerge = mergeClaudeSettings(existingSettings, {
    hookCommandPath,
    disableAutoMemory: opts.disableAutoMemory,
  });
  if (apply && settingsMerge.changed.length > 0) {
    const backup = backupIfExists(settingsFile);
    if (backup) backups.push(backup);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify(settingsMerge.next, null, 2)}\n`);
  }

  const mcpFile = join(home, ".claude.json");
  const existingMcp = readJsonSafe(mcpFile) ?? {};
  const mcpMerge = upsertClaudeMcpServer(existingMcp, mcpCommand);
  if (apply && mcpMerge.changed) {
    const backup = backupIfExists(mcpFile);
    if (backup) backups.push(backup);
    mkdirSync(dirname(mcpFile), { recursive: true });
    writeFileSync(mcpFile, `${JSON.stringify(mcpMerge.next, null, 2)}\n`);
  }

  let autoMemoryImport: ImportSummary | null = null;
  let autoMemoryDb: string | null = null;
  if (importMemory) {
    const dbPath = opts.dbPath ?? homeDbPath(process.env);
    autoMemoryDb = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = new SqliteStore(dbPath);
    try {
      autoMemoryImport = importAutoMemory(store, opts.autoMemoryRoot ?? DEFAULT_AUTO_MEMORY_ROOT, {
        apply,
        now: opts.now,
      });
    } finally {
      store.close();
    }
  }

  return {
    dryRun: !apply,
    settingsPath: settingsFile,
    settingsChanged: settingsMerge.changed,
    mcpPath: mcpFile,
    mcpChanged: mcpMerge.changed,
    backups,
    autoMemoryImport,
    autoMemoryDb,
  };
}

function backupIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  writeFileSync(backupPath, readFileSync(file));
  return backupPath;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasRecallHook(group: unknown): boolean {
  if (!Array.isArray(group)) return false;
  return group.some((entry) => {
    const hooks = isRecord(entry) ? entry.hooks : undefined;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((hook) => {
      const command = isRecord(hook) ? hook.command : undefined;
      return typeof command === "string" && command.includes("recall-session-start.py");
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
