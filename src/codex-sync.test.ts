import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSyncStatus, runCodexSync } from "./codex-sync.js";
import { RECALL_BLOCK_BEGIN } from "./agent-integration.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-codex-sync-"));
}

function configPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function agentsPath(home: string): string {
  return join(home, ".codex", "AGENTS.md");
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
    assert.equal(existsSync(configPath(home)), false);
    assert.equal(existsSync(agentsPath(home)), false);
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCodexSync backs up prior config and agents files only when they existed and changed", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(home), 'model = "gpt-5"\n');
    writeFileSync(agentsPath(home), "# Project rules\n\n- Run tests.\n");

    const result = runCodexSync({ home, apply: true });
    assert.equal(result.backups.length, 2);
    assert.ok(result.backups.includes(`${configPath(home)}.bak`));
    assert.ok(result.backups.includes(`${agentsPath(home)}.bak`));

    const configBackup = readFileSync(`${configPath(home)}.bak`, "utf8");
    assert.equal(configBackup, 'model = "gpt-5"\n');
    const agentsBackup = readFileSync(`${agentsPath(home)}.bak`, "utf8");
    assert.equal(agentsBackup, "# Project rules\n\n- Run tests.\n");

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

    const second = runCodexSync({ home, apply: true });
    assert.equal(second.configChanged, false);
    assert.equal(second.agentsChanged, false);
    assert.deepEqual(second.backups, []);
    assert.equal(existsSync(`${configPath(home)}.bak`), false);
    assert.equal(existsSync(`${agentsPath(home)}.bak`), false);
    assert.equal(readFileSync(configPath(home), "utf8"), configBefore);
    assert.equal(readFileSync(agentsPath(home), "utf8"), agentsBefore);
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

test("codexSyncStatus reports false for missing files and flips to installed after apply", () => {
  const home = tempHome();
  try {
    const before = codexSyncStatus({ home });
    assert.equal(before.mcpInstalled, false);
    assert.equal(before.agentsBlockPresent, false);
    assert.equal(before.configPath, configPath(home));
    assert.equal(before.agentsPath, agentsPath(home));

    runCodexSync({ home, apply: true });

    const after = codexSyncStatus({ home });
    assert.equal(after.mcpInstalled, true);
    assert.equal(after.agentsBlockPresent, true);
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
