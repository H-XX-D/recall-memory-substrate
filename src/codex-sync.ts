// R8 Codex sync: file IO plumbing around the pure codex-integration transforms.
// Dry-run by default like every other adapter surface; writes are gated on
// apply, with a .bak backup of any prior file content that is actually being
// changed. Mirrors claude-sync.ts.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasInlineCodexHooks,
  mergeAgentsMd,
  mergeCodexHooks,
  upsertCodexMcpServer,
} from "./codex-integration.js";
import { RECALL_BLOCK_BEGIN, recallSlashPrompt } from "./agent-integration.js";

export interface CodexSyncOptions {
  home?: string;
  /** Explicit Codex config root. Otherwise CODEX_HOME, then <home>/.codex. */
  codexHome?: string;
  hookCommandPath?: string;
  mcpCommand?: string;
  recallDb?: string;
  apply?: boolean;
  installHook?: boolean;
}

export interface CodexSyncResult {
  dryRun: boolean;
  configPath: string;
  configChanged: boolean;
  agentsPath: string;
  agentsChanged: boolean;
  skillPath: string;
  skillChanged: boolean;
  skillAssetInstalled: boolean;
  skillWarning?: string;
  promptPath: string;
  promptChanged: boolean;
  promptInstalled: boolean;
  hooksPath: string;
  hooksChanged: boolean;
  hookPath: string;
  hookAssetChanged: boolean;
  hookAssetInstalled: boolean;
  hooksWarning?: string;
  backups: string[];
}

export function codexSyncStatus(
  opts: Pick<CodexSyncOptions, "home" | "codexHome"> = {},
): {
  codexHome: string;
  configPath: string;
  mcpInstalled: boolean;
  agentsPath: string;
  agentsBlockPresent: boolean;
  skillPath: string;
  skillInstalled: boolean;
  skillCurrent: boolean;
  promptPath: string;
  promptInstalled: boolean;
  promptCurrent: boolean;
  hooksPath: string;
  hookPath: string;
  hooksInstalled: boolean;
  inlineHooksConflict: boolean;
} {
  const codexHome = resolveCodexHome(opts);
  const configFile = join(codexHome, "config.toml");
  const agentsFile = join(codexHome, "AGENTS.md");

  const configText = readTextSafe(configFile);
  const mcpInstalled = /\[mcp_servers\.recall\]/.test(configText ?? "");

  const agentsText = readTextSafe(agentsFile);
  const agentsBlockPresent = (agentsText ?? "").includes(RECALL_BLOCK_BEGIN);

  const skillFile = join(codexHome, "skills", "recall", "SKILL.md");
  const skillSource = findCodexSkillAssetSource();
  const installedSkill = readTextSafe(skillFile);
  const currentSkill = skillSource ? readTextSafe(skillSource) : null;
  const skillInstalled = installedSkill !== null;
  const skillCurrent = skillInstalled && currentSkill !== null && installedSkill === currentSkill;

  const promptFile = join(codexHome, "prompts", "recall.md");
  const installedPrompt = readTextSafe(promptFile);
  const promptInstalled = installedPrompt !== null;
  const promptCurrent = promptInstalled && installedPrompt === recallSlashPrompt();

  const hooksFile = join(codexHome, "hooks.json");
  const hookPath = join(codexHome, "hooks", "recall-session-start.py");
  const hookConfig = readJsonSafe(hooksFile);
  const hooksInstalled = hookConfig !== null && !mergeCodexHooks(hookConfig, hookPath).changed;

  return {
    codexHome,
    configPath: configFile,
    mcpInstalled,
    agentsPath: agentsFile,
    agentsBlockPresent,
    skillPath: skillFile,
    skillInstalled,
    skillCurrent,
    promptPath: promptFile,
    promptInstalled,
    promptCurrent,
    hooksPath: hooksFile,
    hookPath,
    hooksInstalled: hooksInstalled && existsSync(hookPath),
    inlineHooksConflict: hasInlineCodexHooks(configText),
  };
}

export function runCodexSync(opts: CodexSyncOptions = {}): CodexSyncResult {
  const codexHome = resolveCodexHome(opts);
  const apply = opts.apply ?? false;
  const mcpCommand = opts.mcpCommand ?? "recall-mcp";
  const installHook = opts.installHook ?? true;
  const backups: string[] = [];

  const configFile = join(codexHome, "config.toml");
  const existingConfig = readTextSafe(configFile);
  const configMerge = upsertCodexMcpServer(existingConfig, { mcpCommand, recallDb: opts.recallDb });
  if (apply && configMerge.changed) {
    const backup = backupIfExists(configFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(configFile, configMerge.next);
  }
  if (apply && existsSync(configFile)) chmodSync(configFile, 0o600);

  const agentsFile = join(codexHome, "AGENTS.md");
  const existingAgents = readTextSafe(agentsFile);
  const agentsMerge = mergeAgentsMd(existingAgents);
  if (apply && agentsMerge.changed) {
    const backup = backupIfExists(agentsFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(agentsFile, agentsMerge.next);
  }
  if (apply && existsSync(agentsFile)) chmodSync(agentsFile, 0o600);

  const skillFile = join(codexHome, "skills", "recall", "SKILL.md");
  const skillSource = findCodexSkillAssetSource();
  const skillContents = skillSource ? readTextSafe(skillSource) : null;
  const skillChanged = skillContents !== null && readTextSafe(skillFile) !== skillContents;
  let skillAssetInstalled = false;
  if (apply && skillChanged && skillContents !== null) {
    const backup = backupIfExists(skillFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(skillFile, skillContents);
    skillAssetInstalled = true;
  }
  if (apply && existsSync(skillFile)) chmodSync(skillFile, 0o600);

  const promptFile = join(codexHome, "prompts", "recall.md");
  const promptContents = recallSlashPrompt();
  const promptChanged = readTextSafe(promptFile) !== promptContents;
  let promptInstalled = false;
  if (apply && promptChanged) {
    const backup = backupIfExists(promptFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(promptFile, promptContents);
    promptInstalled = true;
  }
  if (apply && existsSync(promptFile)) chmodSync(promptFile, 0o600);

  const hooksFile = join(codexHome, "hooks.json");
  const hookPath = join(codexHome, "hooks", "recall-session-start.py");
  const hookCommandPath = opts.hookCommandPath ?? hookPath;
  const hookSource = installHook ? findHookAssetSource() : null;
  const hookAssetChanged = installHook && hookSource !== null
    ? !existsSync(hookPath) || !readFileSync(hookPath).equals(readFileSync(hookSource))
    : false;
  let hookAssetInstalled = false;
  if (apply && installHook && hookSource && hookAssetChanged) {
    const backup = backupIfExists(hookPath);
    if (backup) backups.push(backup);
    writePrivateAtomic(hookPath, readFileSync(hookSource), 0o700);
    hookAssetInstalled = true;
  }
  if (apply && existsSync(hookPath)) chmodSync(hookPath, 0o700);

  const hookIsAvailable = !installHook || hookSource !== null || existsSync(hookPath);
  const existingHooks = readJsonSafe(hooksFile) ?? {};
  const hooksMerge = hookIsAvailable
    ? mergeCodexHooks(existingHooks, hookCommandPath)
    : { next: existingHooks, changed: false };
  if (apply && hooksMerge.changed) {
    const backup = backupIfExists(hooksFile);
    if (backup) backups.push(backup);
    writePrivateAtomic(hooksFile, `${JSON.stringify(hooksMerge.next, null, 2)}\n`);
  }
  if (apply && existsSync(hooksFile)) chmodSync(hooksFile, 0o600);

  let hooksWarning: string | undefined;
  if (hasInlineCodexHooks(existingConfig)) {
    hooksWarning = "Codex also found inline [hooks] in config.toml; keep one hook representation per config layer to avoid startup warnings.";
  } else if (installHook && !hookSource && !existsSync(hookPath)) {
    hooksWarning = "Packaged Recall hook asset was not found; hooks.json was left unchanged.";
  }

  return {
    dryRun: !apply,
    configPath: configFile,
    configChanged: configMerge.changed,
    agentsPath: agentsFile,
    agentsChanged: agentsMerge.changed,
    skillPath: skillFile,
    skillChanged,
    skillAssetInstalled,
    ...(!skillSource ? { skillWarning: "Packaged Recall Codex skill asset was not found; the skill was left unchanged." } : {}),
    promptPath: promptFile,
    promptChanged,
    promptInstalled,
    hooksPath: hooksFile,
    hooksChanged: hooksMerge.changed,
    hookPath,
    hookAssetChanged,
    hookAssetInstalled,
    ...(hooksWarning ? { hooksWarning } : {}),
    backups,
  };
}

function backupIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  writePrivateAtomic(backupPath, readFileSync(file));
  return backupPath;
}

function resolveCodexHome(opts: Pick<CodexSyncOptions, "home" | "codexHome">): string {
  if (opts.codexHome) return opts.codexHome;
  if (!opts.home && process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return join(opts.home ?? homedir(), ".codex");
}

function findHookAssetSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "integrations", "claude", "hooks", "recall-session-start.py"),
    join(here, "..", "..", "integrations", "claude", "hooks", "recall-session-start.py"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findCodexSkillAssetSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "integrations", "codex", "skill", "SKILL.md"),
    join(here, "..", "..", "integrations", "codex", "skill", "SKILL.md"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

function readTextSafe(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  const text = readTextSafe(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
