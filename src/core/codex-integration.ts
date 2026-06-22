import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Codex CLI integration sync.
 *
 * Idempotently installs (and on re-run, refreshes to the bundled "best
 * functional version") everything that makes an OpenAI Codex agent adopt Recall:
 *   1. the recall skill (~/.codex/skills/recall/),
 *   2. the recall MCP server registration in ~/.codex/config.toml
 *      ([mcp_servers.recall]),
 *   3. a custom prompt slash command at ~/.codex/prompts/recall.md,
 *   4. a marker-delimited "consult Recall" directive in ~/.codex/AGENTS.md —
 *      Codex's always-read global instruction surface, the analog of Claude
 *      Code's SessionStart hook.
 *
 * Unlike Claude Code, Codex exposes no single native-memory kill switch
 * (CLAUDE_CODE_DISABLE_AUTO_MEMORY has no Codex equivalent). Displacement is
 * therefore prompt-level: the AGENTS.md directive positions Recall as THE
 * durable memory layer over Codex's native memory/ambient-suggestions. This is
 * load-bearing because Codex concatenates AGENTS.md into every session.
 *
 * All paths are injectable so the pure merge logic can be unit-tested against
 * temp directories without touching the real ~/.codex config.
 */

const MCP_NAME = "recall";
/** Markers that uniquely delimit the Recall-owned block in AGENTS.md. */
export const AGENTS_BEGIN = "<!-- recall:begin (managed by `recall codex sync`) -->";
export const AGENTS_END = "<!-- recall:end -->";

export interface CodexIntegrationOptions {
  /** Defaults to ~/.codex */
  codexHome?: string;
  /** Defaults to <codexHome>/config.toml */
  configPath?: string;
  /** Defaults to <codexHome>/AGENTS.md */
  agentsPath?: string;
  /** Defaults to <codexHome>/prompts/recall.md */
  slashPromptPath?: string;
  /** Defaults to the bundled integrations/codex directory */
  assetsRoot?: string;
  /** Shared skill scripts/reference root. Defaults to the bundled integrations/claude/skill. */
  sharedSkillRoot?: string;
  /** MCP launch command. Default "recall-mcp". */
  mcpCommand?: string;
  /** Optional RECALL_DB to pin the MCP to a specific DB. Omitted from the portable default. */
  recallDb?: string;
}

export interface CodexIntegrationResult {
  codexHome: string;
  skillDir: string;
  configPath: string;
  agentsPath: string;
  slashPromptPath: string;
  mcpRegistered: boolean;
  slashCommandInstalled: boolean;
  agentsDirectiveInstalled: boolean;
  configBackup: string | null;
  agentsBackup: string | null;
  slashPromptBackup: string | null;
  actions: string[];
  notice: string;
}

export interface CodexIntegrationStatus {
  codexHome: string;
  skillInstalled: boolean;
  mcpRegistered: boolean;
  slashCommandInstalled: boolean;
  agentsDirectiveInstalled: boolean;
  configPath: string;
  agentsPath: string;
  slashPromptPath: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no filesystem access)
// ---------------------------------------------------------------------------

/** The canonical, portable Recall directive block for AGENTS.md. */
export function recallAgentsBlock(): string {
  return [
    AGENTS_BEGIN,
    "## Recall — durable memory",
    "",
    "Recall is your durable memory layer. Consult it before relying on recollection,",
    "and write durable findings back — do not treat scratch notes or native memory as",
    "the system of record.",
    "",
    "- Read first: `recall compile \"<task>\"` for a compiled context packet; `recall search \"<query>\"` for lookup.",
    "- Expand lazily: `recall cell show <id>` only when exact content matters.",
    "- Write back routine durable memory via the `recall_write` MCP tool (or `recall admit`).",
    "- Corrections supersede — never overwrite or duplicate. Admit the new cell with",
    "  `evidence.contradicts` pointing at the prior cell id so the old one is demoted and",
    "  every future session sees the current answer and that the old was overruled.",
    "- Never store secrets in normal memory.",
    AGENTS_END,
    "",
  ].join("\n");
}

/** The documented Codex custom-prompt slash entry installed by `recall codex sync`. */
export function recallSlashPrompt(): string {
  return [
    "---",
    "description: Use Recall active memory for this task",
    "argument-hint: [TASK=\"what to work on\"]",
    "---",
    "",
    "Use Recall as the durable memory layer for this request before relying on recollection.",
    "",
    "If arguments were supplied, treat them as the task: $ARGUMENTS.",
    "If no arguments were supplied, infer the task from the current user request.",
    "",
    "Start by compiling an ID-first Recall context packet:",
    "",
    "```bash",
    "recall compile \"$ARGUMENTS\" --words 900",
    "```",
    "",
    "When $ARGUMENTS is empty, replace it with a concise description of the current task.",
    "Use the returned cell IDs as evidence handles, expand lazily with `recall cell show <id>`",
    "only when exact content matters, then do the work.",
    "",
    "Write durable outcomes back through `recall_write` or `recall admit`. If the new memory",
    "corrects or invalidates an older cell, first find the prior cell and write the update with",
    "`evidence.contradicts` pointing at that prior cell id.",
    "",
  ].join("\n");
}

/**
 * Merge the Recall directive into an existing AGENTS.md. Idempotent and
 * refresh-safe: any prior Recall-owned marker block is stripped and replaced
 * with the canonical one, so re-running upgrades a stale block instead of
 * duplicating it. All non-Recall content is preserved. Returns the new text
 * plus whether anything changed.
 */
export function mergeAgentsMd(existing: string | undefined | null): { next: string; changed: boolean } {
  const block = recallAgentsBlock();
  const prior = existing ?? "";
  // Strip EVERY prior Recall-owned marker block (not just the first), so duplicates
  // from an earlier sync / manual copy / merge conflict heal to a single block. A
  // dangling begin with no end is removed through end-of-file.
  let stripped = prior;
  for (;;) {
    const begin = stripped.indexOf(AGENTS_BEGIN);
    if (begin === -1) break;
    const end = stripped.indexOf(AGENTS_END, begin);
    stripped = end !== -1
      ? stripped.slice(0, begin) + stripped.slice(end + AGENTS_END.length)
      : stripped.slice(0, begin);
  }
  stripped = stripped.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const next = stripped.length > 0 ? `${stripped}\n\n${block}` : block;
  return { next, changed: next !== prior };
}

/** Split a dotted TOML key path into segments, respecting "..."/'...' quoting. */
function parseDottedPath(s: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ".") { segs.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** True for any key path Recall owns: mcp_servers.recall and everything under it. */
function ownsRecall(path: string[]): boolean {
  return path[0] === "mcp_servers" && path[1] === MCP_NAME;
}

/** Parse a TOML table header line `[a.b.c]` (allowing a trailing comment) -> path, else null. */
function tableHeaderPath(line: string): string[] | null {
  const m = line.trim().match(/^\[([^\]]+)\]\s*(#.*)?$/);
  return m ? parseDottedPath(m[1]) : null;
}

/** The canonical Recall MCP block for config.toml. */
export function recallMcpToml(mcpCommand: string, recallDb?: string): string {
  let s = `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(mcpCommand)}\n`;
  if (recallDb) s += `\n[mcp_servers.${MCP_NAME}.env]\nRECALL_DB = ${JSON.stringify(recallDb)}\n`;
  return s;
}

/**
 * Idempotently upsert the recall MCP server into a config.toml text. Strips any
 * prior `[mcp_servers.recall]` / `[mcp_servers.recall.env]` tables (line-based,
 * each table spans until the next table header or EOF) and appends the canonical
 * block. All other TOML is preserved. Returns text + whether it changed.
 */
export function upsertCodexMcpServer(
  tomlText: string | undefined | null,
  opts: { mcpCommand: string; recallDb?: string },
): { next: string; changed: boolean } {
  const prior = tomlText ?? "";
  const lines = prior.split("\n");
  const kept: string[] = [];
  let skippingTable = false; // inside a recall-owned [table] whose body we drop
  let inTopLevel = true; // before any table header (where dotted top-level keys live)
  for (const line of lines) {
    const header = tableHeaderPath(line);
    if (header !== null) {
      if (ownsRecall(header)) { skippingTable = true; continue; } // drop header + its body
      skippingTable = false;
      inTopLevel = false; // now inside a non-recall table
      kept.push(line);
      continue;
    }
    if (skippingTable) continue;
    // Top-level dotted-key forms of the recall server (inline table / dotted keys):
    //   mcp_servers.recall = { ... }   |   mcp_servers.recall.command = "..."
    if (inTopLevel) {
      const eq = line.indexOf("=");
      if (eq !== -1 && ownsRecall(parseDottedPath(line.slice(0, eq)))) continue;
    }
    kept.push(line);
  }
  const body = kept.join("\n").replace(/\s+$/, "");
  const block = recallMcpToml(opts.mcpCommand, opts.recallDb);
  const next = body.length > 0 ? `${body}\n\n${block}` : block;
  return { next, changed: next !== prior };
}

// ---------------------------------------------------------------------------
// Filesystem orchestration
// ---------------------------------------------------------------------------

function defaultAssetsRoot(): string {
  // dist/src/core/codex-integration.js -> <pkgroot>/integrations/codex
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "integrations", "codex");
}

function defaultSharedSkillRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "integrations", "claude", "skill");
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
    ? process.env.CODEX_HOME
    : join(homedir(), ".codex");
}

function backupStamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupAndWrite(path: string, text: string): string | null {
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.recall-bak-${backupStamp()}`;
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return backup;
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/**
 * Install/refresh the full Codex integration. Idempotent: safe to run on every
 * `recall` update to pull forward the latest bundled skill/config/directive.
 */
export function syncCodexIntegration(options: CodexIntegrationOptions = {}): CodexIntegrationResult {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const configPath = options.configPath ?? join(codexHome, "config.toml");
  const agentsPath = options.agentsPath ?? join(codexHome, "AGENTS.md");
  const slashPromptPath = options.slashPromptPath ?? join(codexHome, "prompts", "recall.md");
  const assetsRoot = options.assetsRoot ?? defaultAssetsRoot();
  const sharedSkillRoot = options.sharedSkillRoot ?? defaultSharedSkillRoot();
  const mcpCommand = options.mcpCommand ?? "recall-mcp";
  const actions: string[] = [];

  // 1. skill: Codex-flavored SKILL.md + shared runtime-agnostic scripts/reference
  const skillDir = join(codexHome, "skills", MCP_NAME);
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(join(assetsRoot, "skill", "SKILL.md"), join(skillDir, "SKILL.md"));
  for (const sub of ["scripts", "reference"]) {
    const src = join(sharedSkillRoot, sub);
    if (existsSync(src)) cpSync(src, join(skillDir, sub), { recursive: true, force: true });
  }
  // make shell/python scripts executable
  try { chmodSync(join(skillDir, "scripts", "recall_boot.sh"), 0o755); } catch { /* optional */ }
  actions.push(`skill installed: ${skillDir}`);

  // 2. MCP registration (config.toml), backed up before edit
  const mcp = upsertCodexMcpServer(readText(configPath), { mcpCommand, recallDb: options.recallDb });
  let configBackup: string | null = null;
  if (mcp.changed) {
    configBackup = backupAndWrite(configPath, `${mcp.next.replace(/\s+$/, "")}\n`);
    actions.push(`mcp registered: ${configPath}`);
  }

  // 3. custom prompt slash command, backed up before edit
  const slashPrompt = recallSlashPrompt();
  let slashPromptBackup: string | null = null;
  if (readText(slashPromptPath) !== slashPrompt) {
    slashPromptBackup = backupAndWrite(slashPromptPath, slashPrompt);
    actions.push(`slash command installed: ${slashPromptPath}`);
  }

  // 4. AGENTS.md directive, backed up before edit
  const agents = mergeAgentsMd(readText(agentsPath));
  let agentsBackup: string | null = null;
  if (agents.changed) {
    agentsBackup = backupAndWrite(agentsPath, agents.next.endsWith("\n") ? agents.next : `${agents.next}\n`);
    actions.push(`AGENTS.md directive installed: ${agentsPath}`);
  }

  const notice =
    "Recall wired into Codex: skill + MCP server + /prompts:recall slash prompt + AGENTS.md directive. Codex has no single native-memory "
    + "kill switch, so Recall is positioned as the durable memory layer via the always-read AGENTS.md directive. "
    + "Re-run `recall codex sync` anytime to refresh to the latest bundled version. Restart Codex or open a new chat "
    + "after installing/updating custom prompts so the slash menu reloads.";

  return {
    codexHome,
    skillDir,
    configPath,
    agentsPath,
    slashPromptPath,
    mcpRegistered: true,
    slashCommandInstalled: true,
    agentsDirectiveInstalled: true,
    configBackup,
    agentsBackup,
    slashPromptBackup,
    actions,
    notice,
  };
}

export function codexIntegrationStatus(options: CodexIntegrationOptions = {}): CodexIntegrationStatus {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const configPath = options.configPath ?? join(codexHome, "config.toml");
  const agentsPath = options.agentsPath ?? join(codexHome, "AGENTS.md");
  const slashPromptPath = options.slashPromptPath ?? join(codexHome, "prompts", "recall.md");
  const config = readText(configPath);
  const agents = readText(agentsPath);
  const slashPrompt = readText(slashPromptPath);
  return {
    codexHome,
    skillInstalled: existsSync(join(codexHome, "skills", MCP_NAME, "SKILL.md")),
    mcpRegistered: /\[mcp_servers\.recall\]/.test(config),
    slashCommandInstalled: slashPrompt.includes("Use Recall active memory for this task")
      && slashPrompt.includes("recall compile"),
    agentsDirectiveInstalled: agents.includes(AGENTS_BEGIN),
    configPath,
    agentsPath,
    slashPromptPath,
  };
}
