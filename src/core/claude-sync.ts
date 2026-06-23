import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { importAutoMemory, type ImportSummary } from "./auto-memory-adapter.js";
import {
  syncClaudeIntegration,
  type ClaudeIntegrationOptions,
  type ClaudeIntegrationResult,
} from "./claude-integration.js";
import { homeDbPath } from "./routing.js";
import { SQLiteRecallStore } from "./store.js";

// `recall claude sync` does two things now: it wires the integration (hook, skill,
// MCP, and turning OFF Claude Code's native auto-memory) AND it lifts whatever
// auto-memory the user has already accumulated into the HOME local, so the
// facts they saved before adopting Recall are not stranded in files the agent
// will no longer read. The import is non-destructive: importAutoMemory only reads
// the .md files, never deletes them.

/**
 * Canonical home-local path, the same one the MCP server and CLI resolve to
 * outside any project. Kept named `globalDbPath` for the existing call sites;
 * model-A renamed the "global" graph to the "home" local (see routing.ts).
 */
export function globalDbPath(): string {
  return homeDbPath();
}

export interface ImportToGlobalResult {
  summary: ImportSummary;
  db: string;
}

/**
 * Import existing Claude Code auto-memory files into the HOME local (apply).
 * Read-only over the source .md files, idempotent per file content. Ensures the
 * home local's parent directory exists first so a fresh machine does not fail.
 */
export function importAutoMemoryToGlobal(
  opts: { globalDbPath?: string; autoMemoryRoot?: string } = {},
): ImportToGlobalResult {
  const db = opts.globalDbPath ?? globalDbPath();
  // Fresh machine: the global db may not exist yet, and SQLite will not create
  // the parent directory for us.
  mkdirSync(dirname(db), { recursive: true });
  const store = new SQLiteRecallStore(db);
  try {
    const summary = importAutoMemory(store, { root: opts.autoMemoryRoot, apply: true });
    return { summary, db };
  } finally {
    store.close();
  }
}

export interface ClaudeSyncResult extends ClaudeIntegrationResult {
  autoMemoryImport: ImportSummary | null;
  autoMemoryImportDb: string | null;
}

export interface RunClaudeSyncOptions extends ClaudeIntegrationOptions {
  globalDbPath?: string;
  autoMemoryRoot?: string;
  /** Skip importing existing auto-memory (when keeping native auto-memory). Default true. */
  importMemory?: boolean;
}

export function runClaudeSync(options: RunClaudeSyncOptions = {}): ClaudeSyncResult {
  const integration = syncClaudeIntegration(options);
  const shouldImport = options.importMemory ?? true;
  if (!shouldImport) {
    return { ...integration, autoMemoryImport: null, autoMemoryImportDb: null };
  }
  const { summary, db } = importAutoMemoryToGlobal({
    globalDbPath: options.globalDbPath,
    autoMemoryRoot: options.autoMemoryRoot,
  });
  return { ...integration, autoMemoryImport: summary, autoMemoryImportDb: db };
}
