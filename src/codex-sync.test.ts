import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSyncStatus, runCodexSync } from "./codex-sync.js";
import { RECALL_BLOCK_BEGIN, recallSlashPrompt } from "./agent-integration.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-codex-sync-"));
}

function configPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function agentsPath(home: string): string {
  return join(home, ".codex", "AGENTS.md");
}

function skillPath(home: string): string {
  return join(home, ".codex", "skills", "recall", "SKILL.md");
}

function promptPath(home: string): string {
  return join(home, ".codex", "prompts", "recall.md");
}

function hooksPath(home: string): string {
  return join(home, ".codex", "hooks.json");
}

function hookPath(home: string): string {
  return join(home, ".codex", "hooks", "recall-session-start.py");
}

test("runCodexSync dry-run reports changes without writing files", () => {
  const home = tempHome();
  try {
    const result = runCodexSync({ home });
    assert.equal(result.dryRun, true);
    assert.equal(result.configChanged, true);
    assert.equal(result.agentsChanged, true);
    assert.deepEqual(result.backups, []);
    assert.equal(result.configPath, configPath(home));
    assert.equal(result.agentsPath, agentsPath(home));
    assert.equal(result.skillPath, skillPath(home));
    assert.equal(result.skillChanged, true);
    assert.equal(result.skillAssetInstalled, false);
    assert.equal(result.promptPath, promptPath(home));
    assert.equal(result.promptChanged, true);
    assert.equal(result.promptInstalled, false);
    assert.equal(result.hooksPath, hooksPath(home));
    assert.equal(result.hookPath, hookPath(home));
    assert.equal(result.hooksChanged, true);
    assert.equal(result.hookAssetChanged, true);
    assert.equal(existsSync(configPath(home)), false);
    assert.equal(existsSync(agentsPath(home)), false);
    assert.equal(existsSync(skillPath(home)), false);
    assert.equal(existsSync(promptPath(home)), false);
    assert.equal(existsSync(hooksPath(home)), false);
    assert.equal(existsSync(hookPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync apply writes config.toml with the recall MCP block and AGENTS.md with the recall block", () => {
  const home = tempHome();
  try {
    const result = runCodexSync({ home, apply: true });
    assert.equal(result.dryRun, false);
    assert.equal(result.configChanged, true);
    assert.equal(result.agentsChanged, true);
    // No backups on first write: neither file existed before.
    assert.deepEqual(result.backups, []);

    assert.equal(existsSync(configPath(home)), true);
    const config = readFileSync(configPath(home), "utf8");
    assert.match(config, /\[mcp_servers\.recall\]/);
    assert.match(config, /command = "recall-mcp"/);

    assert.equal(existsSync(agentsPath(home)), true);
    const agents = readFileSync(agentsPath(home), "utf8");
    assert.match(agents, /Recall durable memory/);
    assert.equal(agents.split(RECALL_BLOCK_BEGIN).length - 1, 1);

    const skill = readFileSync(skillPath(home), "utf8");
    const skillSource = readFileSync(join(process.cwd(), "integrations", "codex", "skill", "SKILL.md"), "utf8");
    assert.equal(skill, skillSource);
    assert.match(skill, /Prefer MCP/);
    assert.equal(result.skillAssetInstalled, true);

    const prompt = readFileSync(promptPath(home), "utf8");
    assert.equal(prompt, recallSlashPrompt());
    assert.match(prompt, /recall_compile/);
    assert.equal(result.promptInstalled, true);

    assert.equal(existsSync(hookPath(home)), true);
    assert.equal(result.hookAssetInstalled, true);
    const hooks = JSON.parse(readFileSync(hooksPath(home), "utf8"));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    assert.match(JSON.stringify(hooks.hooks.PostToolUse), /--tool/);
    assert.doesNotMatch(JSON.stringify(hooks), /UserPromptExpansion|--expansion/);
    if (process.platform !== "win32") {
      // NTFS has no POSIX mode bits; Windows stat reports 0o666 for any writable file.
      assert.equal(statSync(configPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(agentsPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(skillPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(promptPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(hooksPath(home)).mode & 0o777, 0o600);
      assert.equal(statSync(hookPath(home)).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync backs up prior config, agents, skill, and prompt files only when they existed and changed", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex", "skills", "recall"), { recursive: true });
    mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
    writeFileSync(configPath(home), 'model = "gpt-5"\n');
    writeFileSync(agentsPath(home), "# Project rules\n\n- Run tests.\n");
    writeFileSync(skillPath(home), "# stale skill\n");
    writeFileSync(promptPath(home), "# stale prompt\n");

    const result = runCodexSync({ home, apply: true });
    assert.equal(result.backups.length, 4);
    assert.ok(result.backups.includes(`${configPath(home)}.bak`));
    assert.ok(result.backups.includes(`${agentsPath(home)}.bak`));
    assert.ok(result.backups.includes(`${skillPath(home)}.bak`));
    assert.ok(result.backups.includes(`${promptPath(home)}.bak`));

    const configBackup = readFileSync(`${configPath(home)}.bak`, "utf8");
    assert.equal(configBackup, 'model = "gpt-5"\n');
    const agentsBackup = readFileSync(`${agentsPath(home)}.bak`, "utf8");
    assert.equal(agentsBackup, "# Project rules\n\n- Run tests.\n");
    assert.equal(readFileSync(`${skillPath(home)}.bak`, "utf8"), "# stale skill\n");
    assert.equal(readFileSync(`${promptPath(home)}.bak`, "utf8"), "# stale prompt\n");

    const config = readFileSync(configPath(home), "utf8");
    assert.match(config, /model = "gpt-5"/);
    assert.match(config, /\[mcp_servers\.recall\]/);

    const agents = readFileSync(agentsPath(home), "utf8");
    assert.match(agents, /Project rules/);
    assert.match(agents, /Recall durable memory/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync second apply run is idempotent: no changes, no backups, no rewrites", () => {
  const home = tempHome();
  try {
    runCodexSync({ home, apply: true });
    const configBefore = readFileSync(configPath(home), "utf8");
    const agentsBefore = readFileSync(agentsPath(home), "utf8");
    const skillBefore = readFileSync(skillPath(home), "utf8");
    const promptBefore = readFileSync(promptPath(home), "utf8");
    const hooksBefore = readFileSync(hooksPath(home), "utf8");
    const hookBefore = readFileSync(hookPath(home), "utf8");

    const second = runCodexSync({ home, apply: true });
    assert.equal(second.configChanged, false);
    assert.equal(second.agentsChanged, false);
    assert.equal(second.skillChanged, false);
    assert.equal(second.skillAssetInstalled, false);
    assert.equal(second.promptChanged, false);
    assert.equal(second.promptInstalled, false);
    assert.equal(second.hooksChanged, false);
    assert.equal(second.hookAssetChanged, false);
    assert.equal(second.hookAssetInstalled, false);
    assert.deepEqual(second.backups, []);
    assert.equal(existsSync(`${configPath(home)}.bak`), false);
    assert.equal(existsSync(`${agentsPath(home)}.bak`), false);
    assert.equal(existsSync(`${skillPath(home)}.bak`), false);
    assert.equal(existsSync(`${promptPath(home)}.bak`), false);
    assert.equal(readFileSync(configPath(home), "utf8"), configBefore);
    assert.equal(readFileSync(agentsPath(home), "utf8"), agentsBefore);
    assert.equal(readFileSync(skillPath(home), "utf8"), skillBefore);
    assert.equal(readFileSync(promptPath(home), "utf8"), promptBefore);
    assert.equal(readFileSync(hooksPath(home), "utf8"), hooksBefore);
    assert.equal(readFileSync(hookPath(home), "utf8"), hookBefore);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync honors mcpCommand and recallDb options", () => {
  const home = tempHome();
  try {
    const result = runCodexSync({ home, apply: true, mcpCommand: "custom-mcp", recallDb: "/tmp/recall.sqlite3" });
    assert.equal(result.configChanged, true);
    const config = readFileSync(configPath(home), "utf8");
    assert.match(config, /command = "custom-mcp"/);
    assert.match(config, /RECALL_DB = "\/tmp\/recall\.sqlite3"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync writeGate wires strict MCP admission and the owned closure set", () => {
  const home = tempHome();
  try {
    runCodexSync({ home, apply: true, writeGate: true });
    assert.match(readFileSync(configPath(home), "utf8"), /RECALL_INTEGRITY_GATE = "1"/);
    const hooks = readFileSync(hooksPath(home), "utf8");
    assert.equal((hooks.match(/recall-prompt-hook/g) ?? []).length, 1);
    assert.equal((hooks.match(/recall-stop-hook/g) ?? []).length, 1);
    assert.equal((hooks.match(/recall-receipt-hook/g) ?? []).length, 1);
    const status = codexSyncStatus({ home });
    assert.equal(status.hooksInstalled, true);
    assert.equal(status.writeGateInstalled, true);

    runCodexSync({ home, apply: true, writeGate: false });
    assert.doesNotMatch(readFileSync(configPath(home), "utf8"), /RECALL_INTEGRITY_GATE/);
    assert.doesNotMatch(readFileSync(hooksPath(home), "utf8"), /recall-(?:prompt|stop|receipt)-hook/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codexSyncStatus reports false for missing files and flips to installed after apply", () => {
  const home = tempHome();
  try {
    const before = codexSyncStatus({ home });
    assert.equal(before.mcpInstalled, false);
    assert.equal(before.agentsBlockPresent, false);
    assert.equal(before.skillInstalled, false);
    assert.equal(before.skillCurrent, false);
    assert.equal(before.promptInstalled, false);
    assert.equal(before.promptCurrent, false);
    assert.equal(before.hooksInstalled, false);
    assert.equal(before.configPath, configPath(home));
    assert.equal(before.agentsPath, agentsPath(home));
    assert.equal(before.skillPath, skillPath(home));
    assert.equal(before.promptPath, promptPath(home));

    runCodexSync({ home, apply: true });

    const after = codexSyncStatus({ home });
    assert.equal(after.mcpInstalled, true);
    assert.equal(after.agentsBlockPresent, true);
    assert.equal(after.skillInstalled, true);
    assert.equal(after.skillCurrent, true);
    assert.equal(after.promptInstalled, true);
    assert.equal(after.promptCurrent, true);
    assert.equal(after.hooksInstalled, true);

    writeFileSync(skillPath(home), "# locally modified\n");
    writeFileSync(promptPath(home), "# locally modified\n");
    const staleAssets = codexSyncStatus({ home });
    assert.equal(staleAssets.skillInstalled, true);
    assert.equal(staleAssets.skillCurrent, false);
    assert.equal(staleAssets.promptInstalled, true);
    assert.equal(staleAssets.promptCurrent, false);

    const partial = JSON.parse(readFileSync(hooksPath(home), "utf8"));
    delete partial.hooks.PostToolUse;
    writeFileSync(hooksPath(home), JSON.stringify(partial));
    assert.equal(codexSyncStatus({ home }).hooksInstalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync preserves unrelated sibling handlers and warns about inline hooks", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(home), "[hooks]\n\n[features]\nhooks = true\n");
    writeFileSync(hooksPath(home), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: "python3 /old/recall-session-start.py --stop" },
            { type: "command", command: "python3 /custom/stop-rules.py" },
          ],
        }],
      },
    }, null, 2));

    const result = runCodexSync({ home, apply: true });
    assert.match(result.hooksWarning ?? "", /inline \[hooks\]/);
    const hooks = JSON.parse(readFileSync(hooksPath(home), "utf8")).hooks;
    assert.equal(hooks.Stop.length, 2);
    assert.match(JSON.stringify(hooks.Stop[0]), /custom\/stop-rules\.py/);
    assert.doesNotMatch(JSON.stringify(hooks.Stop[0]), /recall-session-start\.py/);
    assert.match(JSON.stringify(hooks.Stop[1]), /recall-session-start\.py.*--stop/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync honors an explicit CODEX_HOME-style root", () => {
  const home = tempHome();
  const codexHome = join(home, "custom-codex-home");
  try {
    const result = runCodexSync({ codexHome, apply: true });
    assert.equal(result.configPath, join(codexHome, "config.toml"));
    assert.equal(result.skillPath, join(codexHome, "skills", "recall", "SKILL.md"));
    assert.equal(result.promptPath, join(codexHome, "prompts", "recall.md"));
    assert.equal(result.hooksPath, join(codexHome, "hooks.json"));
    const status = codexSyncStatus({ codexHome });
    assert.equal(status.skillCurrent, true);
    assert.equal(status.promptCurrent, true);
    assert.equal(status.hooksInstalled, true);
    assert.equal(existsSync(join(home, ".codex")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codexSyncStatus detects the recall block even when surrounding AGENTS.md content has drifted", () => {
  const home = tempHome();
  try {
    runCodexSync({ home, apply: true });
    const drifted = `${readFileSync(agentsPath(home), "utf8")}\nExtra project note.\n`;
    writeFileSync(agentsPath(home), drifted);

    const status = codexSyncStatus({ home });
    assert.equal(status.agentsBlockPresent, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codexSyncStatus never throws on missing .codex directory or malformed files", () => {
  const home = tempHome();
  try {
    const status = codexSyncStatus({ home });
    assert.equal(status.mcpInstalled, false);
    assert.equal(status.agentsBlockPresent, false);
    assert.equal(status.skillInstalled, false);
    assert.equal(status.skillCurrent, false);
    assert.equal(status.promptInstalled, false);
    assert.equal(status.promptCurrent, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the packaged Codex skill is MCP-first and documents the Recall 0.12.1 write schema", () => {
  const skill = readFileSync(join(process.cwd(), "integrations", "codex", "skill", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: recall\ndescription:/);
  assert.match(skill, /Prefer MCP/);
  assert.match(skill, /Recall 0\.12\.1 write contract/);
  assert.match(skill, /`recall_compile`/);
  assert.match(skill, /`recall_cell`.*`idOrAddress`/s);
  assert.match(skill, /required fields[\s\S]*"kind"[\s\S]*"title"[\s\S]*"body"[\s\S]*"confidence"/);
  assert.match(skill, /`supersedes`/);
  assert.doesNotMatch(skill, /evidence\.contradicts|recall\.write\.v1|\blemma\b|required tag families/);
});
