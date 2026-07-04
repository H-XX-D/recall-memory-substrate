// R8 Codex sync: file IO plumbing around the pure codex-integration transforms.
// Dry-run by default like every other adapter surface; writes are gated on
// apply, with a .bak backup of any prior file content that is actually being
// changed. Mirrors claude-sync.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeAgentsMd, upsertCodexMcpServer } from "./codex-integration.js";
import { RECALL_BLOCK_BEGIN } from "./agent-integration.js";

export interface CodexSyncOptions {
  home?: string;
  mcpCommand?: string;
  recallDb?: string;
  apply?: boolean;
}

export interface CodexSyncResult {
  dryRun: boolean;
  configPath: string;
  configChanged: boolean;
  agentsPath: string;
  agentsChanged: boolean;
  backups: string[];
}

export function codexSyncStatus(
  opts: Pick<CodexSyncOptions, "home"> = {},
): {
  configPath: string;
  mcpInstalled: boolean;
  agentsPath: string;
  agentsBlockPresent: boolean;
} {
  const home = opts.home ?? homedir();
  const configFile = join(home, ".codex", "config.toml");
  const agentsFile = join(home, ".codex", "AGENTS.md");

  const configText = readTextSafe(configFile);
  const mcpInstalled = /\[mcp_servers\.recall\]/.test(configText ?? "");

  const agentsText = readTextSafe(agentsFile);
  const agentsBlockPresent = (agentsText ?? "").includes(RECALL_BLOCK_BEGIN);

  return {
    configPath: configFile,
    mcpInstalled,
    agentsPath: agentsFile,
    agentsBlockPresent,
  };
}

export function runCodexSync(opts: CodexSyncOptions = {}): CodexSyncResult {
  const home = opts.home ?? homedir();
  const apply = opts.apply ?? false;
  const mcpCommand = opts.mcpCommand ?? "recall-mcp";
  const backups: string[] = [];

  const configFile = join(home, ".codex", "config.toml");
  const existingConfig = readTextSafe(configFile);
  const configMerge = upsertCodexMcpServer(existingConfig, { mcpCommand, recallDb: opts.recallDb });
  if (apply && configMerge.changed) {
    const backup = backupIfExists(configFile);
    if (backup) backups.push(backup);
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, configMerge.next);
  }

  const agentsFile = join(home, ".codex", "AGENTS.md");
  const existingAgents = readTextSafe(agentsFile);
  const agentsMerge = mergeAgentsMd(existingAgents);
  if (apply && agentsMerge.changed) {
    const backup = backupIfExists(agentsFile);
    if (backup) backups.push(backup);
    mkdirSync(dirname(agentsFile), { recursive: true });
    writeFileSync(agentsFile, agentsMerge.next);
  }

  return {
    dryRun: !apply,
    configPath: configFile,
    configChanged: configMerge.changed,
    agentsPath: agentsFile,
    agentsChanged: agentsMerge.changed,
    backups,
  };
}

function backupIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  writeFileSync(backupPath, readFileSync(file));
  return backupPath;
}

function readTextSafe(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
