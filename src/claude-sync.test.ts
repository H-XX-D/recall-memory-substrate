import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTO_MEMORY_ROOT, claudeSyncStatus, runClaudeSync } from "./claude-sync.js";
import { SqliteStore } from "./store.js";

const NOW = "2026-06-26T12:00:00.000Z";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-claude-sync-"));
}

function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function mcpPath(home: string): string {
  return join(home, ".claude.json");
}

test("runClaudeSync dry-run reports changes without writing files", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, importMemory: false });
    assert.equal(result.dryRun, true);
    assert.ok(result.settingsChanged.length > 0);
    assert.equal(result.mcpChanged, true);
    assert.deepEqual(result.backups, []);
    assert.equal(result.autoMemoryImport, null);
    assert.equal(existsSync(settingsPath(home)), false);
    assert.equal(existsSync(mcpPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync apply writes settings.json with recall hooks and disables auto-memory, and upserts mcp server", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.equal(result.dryRun, false);
    assert.ok(result.settingsChanged.length > 0);
    assert.equal(result.mcpChanged, true);
    // No backups on first write: neither file existed before.
    assert.deepEqual(result.backups, []);

    assert.equal(existsSync(settingsPath(home)), true);
    const settings = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    assert.match(JSON.stringify(settings.hooks.SessionStart), /recall-session-start\.py/);
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

    assert.equal(existsSync(mcpPath(home)), true);
    const mcp = JSON.parse(readFileSync(mcpPath(home), "utf8"));
    assert.deepEqual(mcp.mcpServers.recall, { type: "stdio", command: "recall-mcp", args: [], env: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync backs up prior settings and mcp files only when they existed and changed", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(home), JSON.stringify({ existing: true }, null, 2));
    writeFileSync(mcpPath(home), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));

    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.equal(result.backups.length, 2);
    assert.ok(result.backups.includes(`${settingsPath(home)}.bak`));
    assert.ok(result.backups.includes(`${mcpPath(home)}.bak`));

    const settingsBackup = JSON.parse(readFileSync(`${settingsPath(home)}.bak`, "utf8"));
    assert.deepEqual(settingsBackup, { existing: true });
    const mcpBackup = JSON.parse(readFileSync(`${mcpPath(home)}.bak`, "utf8"));
    assert.deepEqual(mcpBackup, { mcpServers: { other: { command: "x" } } });

    const mcp = JSON.parse(readFileSync(mcpPath(home), "utf8"));
    assert.ok("other" in mcp.mcpServers);
    assert.ok("recall" in mcp.mcpServers);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync second apply run is idempotent: no changes, no backups, no rewrites", () => {
  const home = tempHome();
  try {
    runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    const settingsBefore = readFileSync(settingsPath(home), "utf8");
    const mcpBefore = readFileSync(mcpPath(home), "utf8");

    const second = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.deepEqual(second.settingsChanged, []);
    assert.equal(second.mcpChanged, false);
    assert.deepEqual(second.backups, []);
    assert.equal(existsSync(`${settingsPath(home)}.bak`), false);
    assert.equal(existsSync(`${mcpPath(home)}.bak`), false);
    assert.equal(readFileSync(settingsPath(home), "utf8"), settingsBefore);
    assert.equal(readFileSync(mcpPath(home), "utf8"), mcpBefore);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keep-automemory leaves auto-memory enabled and skips the import", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({
      home,
      apply: true,
      disableAutoMemory: false,
      importMemory: false,
      now: NOW,
    });
    const settings = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    assert.equal("CLAUDE_CODE_DISABLE_AUTO_MEMORY" in settings.env, false);
    assert.equal(result.autoMemoryImport, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync auto-memory lift imports a fixture tree into a temp db and reports the summary", () => {
  const home = tempHome();
  const root = mkdtempSync(join(tmpdir(), "recall-v5-claude-sync-root-"));
  try {
    const memoryDir = join(root, "demo", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "---\nname: Demo note\ntype: project\n---\nProject memory.");

    const dbPath = join(home, "recall-db", "home.sqlite3");
    const result = runClaudeSync({
      home,
      apply: true,
      autoMemoryRoot: root,
      dbPath,
      now: NOW,
    });

    assert.ok(result.autoMemoryImport);
    assert.equal(result.autoMemoryImport?.created, 1);
    assert.equal(result.autoMemoryImport?.dryRun, false);
    assert.equal(result.autoMemoryDb, dbPath);
    assert.equal(existsSync(dbPath), true);

    const store = new SqliteStore(dbPath);
    try {
      assert.equal(store.active().length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("runClaudeSync auto-memory lift mkdirs a fresh-machine db parent directory", () => {
  const home = tempHome();
  const root = mkdtempSync(join(tmpdir(), "recall-v5-claude-sync-root-"));
  try {
    const dbPath = join(home, "nested", "does", "not", "exist", "home.sqlite3");
    const result = runClaudeSync({ home, apply: true, autoMemoryRoot: root, dbPath, now: NOW });
    assert.equal(existsSync(dbPath), true);
    assert.equal(result.autoMemoryDb, dbPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("claudeSyncStatus reports false for missing files and flips to installed after apply", () => {
  const home = tempHome();
  try {
    const before = claudeSyncStatus({ home });
    assert.equal(before.hooksInstalled, false);
    assert.equal(before.autoMemoryDisabled, false);
    assert.equal(before.mcpInstalled, false);

    runClaudeSync({ home, apply: true, importMemory: false, now: NOW });

    const after = claudeSyncStatus({ home });
    assert.equal(after.hooksInstalled, true);
    assert.equal(after.autoMemoryDisabled, true);
    assert.equal(after.mcpInstalled, true);
    assert.equal(after.settingsPath, settingsPath(home));
    assert.equal(after.mcpPath, mcpPath(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeSyncStatus never throws on malformed json files", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(home), "{ not json");
    writeFileSync(mcpPath(home), "{ also not json");

    const status = claudeSyncStatus({ home });
    assert.equal(status.hooksInstalled, false);
    assert.equal(status.autoMemoryDisabled, false);
    assert.equal(status.mcpInstalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("DEFAULT_AUTO_MEMORY_ROOT points at ~/.claude/projects", () => {
  assert.match(DEFAULT_AUTO_MEMORY_ROOT, /\.claude[/\\]projects$/);
});
