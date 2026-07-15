import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(Object.keys(settings.hooks).sort(), [
      "PostToolUse", "SessionStart", "Stop", "UserPromptExpansion", "UserPromptSubmit",
    ]);
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

    assert.equal(existsSync(mcpPath(home)), true);
    const mcp = JSON.parse(readFileSync(mcpPath(home), "utf8"));
    assert.deepEqual(mcp.mcpServers.recall, { type: "stdio", command: "recall-mcp", args: [], env: {} });
    if (process.platform !== "win32") {
      // NTFS has no POSIX mode bits; Windows stat reports 0o666 for any writable file.
      assert.equal(statSync(settingsPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(mcpPath(home)).mode & 0o777, 0o600);
    }
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
    assert.ok(result.assetsInstalled.includes(hookAssetPath(home)));
    assert.equal(result.assetsSkipped, undefined);
    if (process.platform !== "win32") {
      // NTFS has no POSIX mode bits; Windows stat reports 0o666 for any writable file.
      assert.equal(statSync(hookAssetPath(home)).mode & 0o777, 0o700);
    }
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
    assert.ok(result.assetsInstalled.includes(hookAssetPath(home)));
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

test("runClaudeSync degrades with assetsSkipped when an asset cannot be found, and still installs the rest", () => {
  const home = tempHome();
  const assetsRoot = mkdtempSync(join(tmpdir(), "recall-v5-claude-assets-"));
  try {
    // Use an isolated incomplete package tree; never rename the shared source
    // while other test files may be reading it concurrently.
    const skillDir = join(assetsRoot, "claude", "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Isolated skill fixture\n");

    const result = runClaudeSync({ home, assetsRoot, apply: true, importMemory: false, now: NOW });
    assert.equal(existsSync(hookAssetPath(home)), false);
    assert.equal(result.assetsInstalled.includes(hookAssetPath(home)), false);
    assert.equal(result.assetsSkipped, "asset not found");
    // The miss is per asset: the skills tree still lands.
    assert.equal(existsSync(join(home, ".claude", "skills", "recall", "SKILL.md")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Skills tree install: apply lands SKILL.md plus the peek and router scripts
// under ~/.claude/skills/recall/, with the same .bak discipline as the hook.
// ---------------------------------------------------------------------------

function skillPath(home: string, ...parts: string[]): string {
  return join(home, ".claude", "skills", "recall", ...parts);
}

const SKILL_FILES = ["SKILL.md", join("scripts", "recall_peek.py"), join("scripts", "recall_router.py")];

test("runClaudeSync apply installs the recall skills tree and reports it", () => {
  const home = tempHome();
  try {
    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    for (const rel of SKILL_FILES) {
      const dest = skillPath(home, rel);
      assert.equal(existsSync(dest), true, `skill file not installed: ${dest}`);
      assert.ok(result.assetsInstalled.includes(dest), `skill file not reported installed: ${dest}`);
    }
    const installed = readFileSync(skillPath(home, "SKILL.md"), "utf8");
    const source = readFileSync(join(process.cwd(), "integrations", "claude", "skill", "SKILL.md"), "utf8");
    assert.equal(installed, source);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync second apply is a no-op for the skills tree (idempotent, no backups)", () => {
  const home = tempHome();
  try {
    runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    const second = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.deepEqual(second.assetsInstalled, []);
    assert.deepEqual(second.backups, []);
    for (const rel of SKILL_FILES) {
      assert.equal(existsSync(`${skillPath(home, rel)}.bak`), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync backs up a locally modified skill file before overwriting it", () => {
  const home = tempHome();
  try {
    mkdirSync(dirname(skillPath(home, "SKILL.md")), { recursive: true });
    writeFileSync(skillPath(home, "SKILL.md"), "# stale local skill\n");

    const result = runClaudeSync({ home, apply: true, importMemory: false, now: NOW });
    assert.ok(result.assetsInstalled.includes(skillPath(home, "SKILL.md")));
    assert.equal(readFileSync(`${skillPath(home, "SKILL.md")}.bak`, "utf8"), "# stale local skill\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runClaudeSync installAssets: false installs no skills tree either", () => {
  const home = tempHome();
  try {
    runClaudeSync({ home, apply: true, importMemory: false, installAssets: false, now: NOW });
    assert.equal(existsSync(skillPath(home, "SKILL.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skill scripts/recall_peek.py is a byte-identical copy of python/recall_peek.py", () => {
  const skillCopy = readFileSync(
    join(process.cwd(), "integrations", "claude", "skill", "scripts", "recall_peek.py"),
    "utf8",
  );
  const canonical = readFileSync(join(process.cwd(), "python", "recall_peek.py"), "utf8");
  assert.equal(skillCopy, canonical);
});

// Doc truth: every `recall <verb>` SKILL.md mentions must be a verb the CLI
// help actually lists, so the skill never documents a command that exits 1.
test("SKILL.md documents only recall verbs the CLI help lists", () => {
  const cliSource = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
  const cliVerbs = new Set<string>();
  for (const m of cliSource.matchAll(/^ {2}recall ([a-z-]+)/gm)) cliVerbs.add(m[1]!);
  assert.ok(
    cliVerbs.has("compile") && cliVerbs.has("diff") && cliVerbs.has("health"),
    "failed to parse the CLI help text out of src/cli.ts",
  );

  const skill = readFileSync(join(process.cwd(), "integrations", "claude", "skill", "SKILL.md"), "utf8");
  const documented = new Set<string>();
  for (const m of skill.matchAll(/`recall ([a-z-]+)/g)) documented.add(m[1]!);
  const fenceParts = skill.split("```");
  for (let i = 1; i < fenceParts.length; i += 2) {
    for (const m of fenceParts[i]!.matchAll(/^\s*recall ([a-z-]+)/gm)) documented.add(m[1]!);
  }

  const required = ["compile", "search", "cell", "diff", "health", "admit", "hyperedge", "program", "maintain"];
  for (const verb of required) {
    assert.ok(documented.has(verb), `SKILL.md must document 'recall ${verb}'`);
  }
  for (const verb of documented) {
    assert.ok(cliVerbs.has(verb), `SKILL.md documents 'recall ${verb}' but the CLI help does not list that verb`);
  }
});

test("the Codex skill asset is MCP-first and uses the current write contract", () => {
  const skillPath = join(process.cwd(), "integrations", "codex", "skill", "SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\nname: recall\ndescription:/);
  assert.match(skill, /Recall 0\.12\.1 write contract/);
  assert.match(skill, /`recall_compile`/);
  assert.match(skill, /`recall_write`/);
  assert.match(skill, /`supersedes`/);
  assert.doesNotMatch(skill, /evidence\.contradicts|recall\.write\.v1|required tag families|\blemma\b/);
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
