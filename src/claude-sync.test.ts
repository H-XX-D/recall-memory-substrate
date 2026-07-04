import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("runClaudeSync with home and no dbPath/autoMemoryRoot resolves under home and touches no disk on dry-run", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: false });
    const expectedDb = join(home, ".recall", "db", "home.sqlite3");
    assert.equal(result.autoMemoryDb, expectedDb);
    assert.equal(result.autoMemoryImport, null);
    assert.equal(existsSync(join(home, ".recall")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync dry-run against a pre-created store predicts the lift, and apply performs it", () => {
  const home = tempHome();
  try {
    const dbPath = join(home, ".recall", "db", "home.sqlite3");
    mkdirSync(dirname(dbPath), { recursive: true });
    const seedStore = new SqliteStore(dbPath);
    seedStore.close();

    const projectsDir = join(home, ".claude", "projects");
    const memoryDir = join(projectsDir, "demo", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "---\nname: Demo note\ntype: project\n---\nProject memory.");

    const dryRun = runClaudeSync({ home, apply: false, now: NOW });
    assert.ok(dryRun.autoMemoryImport);
    assert.equal(dryRun.autoMemoryImport?.created, 1);
    assert.equal(dryRun.autoMemoryImport?.dryRun, true);
    assert.equal(dryRun.autoMemoryDb, dbPath);

    const store = new SqliteStore(dbPath);
    try {
      assert.equal(store.active().length, 0);
    } finally {
      store.close();
    }

    const apply = runClaudeSync({ home, apply: true, now: NOW });
    assert.ok(apply.autoMemoryImport);
    assert.equal(apply.autoMemoryImport?.created, dryRun.autoMemoryImport?.created);
    assert.equal(apply.autoMemoryImport?.dryRun, false);

    const storeAfter = new SqliteStore(dbPath);
    try {
      assert.equal(storeAfter.active().length, 1);
    } finally {
      storeAfter.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
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

function hookAssetPath(home: string): string {
  return join(home, ".claude", "hooks", "recall-session-start.py");
}

test("runClaudeSync apply installs the recall-session-start.py hook asset and reports it", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.equal(existsSync(hookAssetPath(home)), true);
    assert.deepEqual(result.assetsInstalled, [hookAssetPath(home)]);
    assert.equal(result.assetsSkipped, undefined);
    const installed = readFileSync(hookAssetPath(home), "utf8");
    const source = readFileSync(join(process.cwd(), "integrations", "claude", "hooks", "recall-session-start.py"), "utf8");
    assert.equal(installed, source);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync second apply run reports no asset changes (idempotent, no backup)", () => {
  const home = tempHome();
  try {
    runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    const second = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.deepEqual(second.assetsInstalled, []);
    assert.equal(existsSync(`${hookAssetPath(home)}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync backs up the hook asset only when overwriting a changed existing file", () => {
  const home = tempHome();
  try {
    mkdirSync(dirname(hookAssetPath(home)), { recursive: true });
    writeFileSync(hookAssetPath(home), "# stale local copy\n");

    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.deepEqual(result.assetsInstalled, [hookAssetPath(home)]);
    assert.equal(existsSync(`${hookAssetPath(home)}.bak`), true);
    assert.equal(readFileSync(`${hookAssetPath(home)}.bak`, "utf8"), "# stale local copy\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync installAssets: false skips asset install entirely", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: true, importMemory: false, installAssets: false, now: NOW });
    assert.equal(existsSync(hookAssetPath(home)), false);
    assert.deepEqual(result.assetsInstalled, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync dry-run does not install the hook asset", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: false, importMemory: false, now: NOW });
    assert.equal(existsSync(hookAssetPath(home)), false);
    assert.deepEqual(result.assetsInstalled, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync degrades with assetsSkipped when the asset cannot be found", () => {
  const home = tempHome();
  const realAsset = join(process.cwd(), "integrations", "claude", "hooks", "recall-session-start.py");
  const movedAside = `${realAsset}.moved-for-test`;
  let moved = false;
  try {
    // Simulate a packaging state where the source asset is absent (e.g. an
    // npm install that did not ship integrations/): rename the real file
    // aside for the duration of this test only, then restore it in finally.
    renameSync(realAsset, movedAside);
    moved = true;

    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.equal(existsSync(hookAssetPath(home)), false);
    assert.deepEqual(result.assetsInstalled, []);
    assert.equal(result.assetsSkipped, "asset not found");
  } finally {
    if (moved) renameSync(movedAside, realAsset);
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync writeGate wires the node prompt/stop hook bin names into written settings.json", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: true, importMemory: false, writeGate: true, now: NOW });
    assert.ok(result.settingsChanged.length > 0);
    const settings = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    const promptHooks = settings.hooks.UserPromptSubmit[0].hooks;
    const stopHooks = settings.hooks.Stop[0].hooks;
    assert.equal(promptHooks.length, 2);
    assert.equal(promptHooks[1].command, "recall-prompt-hook");
    assert.equal(stopHooks.length, 2);
    assert.equal(stopHooks[1].command, "recall-stop-hook");
    // SessionStart is untouched by writeGate.
    assert.equal(settings.hooks.SessionStart[0].hooks.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync default (no writeGate) settings.json has only the python hook entries", () => {
  const home = tempHome();
  try {
    runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    const settings = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
