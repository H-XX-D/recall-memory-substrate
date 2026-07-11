// R7 Claude sync: file IO plumbing around the pure claude-integration
// transforms and the auto-memory lift. Dry-run by default like every other
// adapter surface; writes are gated on apply, with a .bak backup of any prior
// file content that is actually being changed.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importAutoMemory, type ImportSummary } from "./adapters.js";
import { mergeClaudeSettings, upsertClaudeMcpServer } from "./claude-integration.js";
import { homeDbPath } from "./routing.js";
import { SqliteStore } from "./store.js";

export const DEFAULT_AUTO_MEMORY_ROOT = join(homedir(), ".claude", "projects");

// Assets installed under the user's home on apply: the session hook, plus the
// recall skills tree (SKILL.md and the peek/router helper scripts) that the
// hook's directive and remediation text point at. `source` is relative to the
// packaged integrations/ directory; `dest` is relative to the user's home.
interface AssetSpec {
  source: string[];
  dest: string[];
}

const INSTALL_ASSETS: AssetSpec[] = [
  {
    source: ["claude", "hooks", "recall-session-start.py"],
    dest: [".claude", "hooks", "recall-session-start.py"],
  },
  {
    source: ["claude", "skill", "SKILL.md"],
    dest: [".claude", "skills", "recall", "SKILL.md"],
  },
  {
    source: ["claude", "skill", "scripts", "recall_peek.py"],
    dest: [".claude", "skills", "recall", "scripts", "recall_peek.py"],
  },
  {
    source: ["claude", "skill", "scripts", "recall_router.py"],
    dest: [".claude", "skills", "recall", "scripts", "recall_router.py"],
  },
];

export interface ClaudeSyncOptions {
  home?: string;
  /** Override packaged integrations root for isolated tests/embedders. */
  assetsRoot?: string;
  hookCommandPath?: string;
  mcpCommand?: string;
  disableAutoMemory?: boolean;
  importMemory?: boolean;
  autoMemoryRoot?: string;
  dbPath?: string;
  apply?: boolean;
  now?: string;
  writeGate?: boolean;
  installAssets?: boolean;
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
  assetsInstalled: string[];
  assetsSkipped?: string;
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
  const hooksInstalled = ["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PostToolUse", "Stop"].every((event) =>
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
  const installAssets = opts.installAssets ?? true;
  const backups: string[] = [];

  const settingsFile = join(home, ".claude", "settings.json");
  const existingSettings = readJsonSafe(settingsFile) ?? {};
  const settingsMerge = mergeClaudeSettings(existingSettings, {
    hookCommandPath,
    disableAutoMemory: opts.disableAutoMemory,
    // The node hooks resolve by bin name (not an absolute path) so PATH
    // resolution matches how npm installs expose them, same as mcpCommand
    // above defaulting to the "recall-mcp" bin name rather than a path.
    writeGate: opts.writeGate ? { promptHookCommand: "recall-prompt-hook", stopHookCommand: "recall-stop-hook" } : undefined,
  });
  if (apply && settingsMerge.changed.length > 0) {
    const backup = backupIfExists(settingsFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(settingsFile, `${JSON.stringify(settingsMerge.next, null, 2)}\n`);
  }
  if (apply && existsSync(settingsFile)) chmodSync(settingsFile, 0o600);

  const mcpFile = join(home, ".claude.json");
  const existingMcp = readJsonSafe(mcpFile) ?? {};
  const mcpMerge = upsertClaudeMcpServer(existingMcp, mcpCommand);
  if (apply && mcpMerge.changed) {
    const backup = backupIfExists(mcpFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(mcpFile, `${JSON.stringify(mcpMerge.next, null, 2)}\n`);
  }
  if (apply && existsSync(mcpFile)) chmodSync(mcpFile, 0o600);

  const assetsInstalled: string[] = [];
  let assetsSkipped: string | undefined;
  if (apply && installAssets) {
    for (const asset of INSTALL_ASSETS) {
      const sourceAsset = findAssetSource(asset.source, opts.assetsRoot);
      if (!sourceAsset) {
        // Degrade per asset: a packaging miss of one file must not block the
        // rest of the install (or the sync as a whole).
        assetsSkipped = "asset not found";
        continue;
      }
      const destAsset = join(home, ...asset.dest);
      const contents = readFileSync(sourceAsset);
      const changed = !existsSync(destAsset) || !readFileSync(destAsset).equals(contents);
      if (changed) {
        const backup = backupIfExists(destAsset);
        if (backup) backups.push(backup);
        writePrivateAtomic(destAsset, contents, assetMode(destAsset));
        assetsInstalled.push(destAsset);
      }
      try { chmodSync(destAsset, assetMode(destAsset)); } catch { /* best effort */ }
    }
  }

  let autoMemoryImport: ImportSummary | null = null;
  let autoMemoryDb: string | null = null;
  if (importMemory) {
    const resolvedDb =
      opts.dbPath ?? (opts.home ? join(opts.home, ".recall", "db", "home.sqlite3") : homeDbPath(process.env));
    const resolvedRoot =
      opts.autoMemoryRoot ?? (opts.home ? join(opts.home, ".claude", "projects") : DEFAULT_AUTO_MEMORY_ROOT);
    autoMemoryDb = resolvedDb;

    if (apply) {
      mkdirSync(dirname(resolvedDb), { recursive: true });
      const store = new SqliteStore(resolvedDb);
      try {
        autoMemoryImport = importAutoMemory(store, resolvedRoot, { apply, now: opts.now });
      } finally {
        store.close();
      }
    } else if (existsSync(resolvedDb)) {
      // Dry-run against a store that already exists: open it to predict the
      // lift, but never create anything on disk.
      const store = new SqliteStore(resolvedDb);
      try {
        autoMemoryImport = importAutoMemory(store, resolvedRoot, { apply, now: opts.now });
      } finally {
        store.close();
      }
    } else {
      // Dry-run with no store yet: report where the lift would land without
      // touching disk.
      autoMemoryImport = null;
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
    assetsInstalled,
    ...(assetsSkipped !== undefined ? { assetsSkipped } : {}),
  };
}

// Resolves a packaged asset under integrations/. Tries the path relative to
// this module first (works for both the src/ tsx dev path and the compiled
// dist/ path, since integrations/ and dist/ are both direct children of the
// package root), then a packaged-path fallback one level up from that (covers
// a module nested one directory deeper than expected). Returns null, never
// throws, if neither location has the file: runClaudeSync degrades to
// assetsSkipped rather than failing the whole sync.
function findAssetSource(relative: string[], assetsRoot?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = assetsRoot
    ? [join(assetsRoot, ...relative)]
    : [
        join(here, "..", "integrations", ...relative),
        join(here, "..", "..", "integrations", ...relative),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function backupIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  writePrivateAtomic(backupPath, readFileSync(file));
  return backupPath;
}

function assetMode(file: string): number {
  return file.endsWith(".py") ? 0o700 : 0o600;
}

function writePrivateAtomic(file: string, contents: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, file);
    chmodSync(file, mode);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
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
