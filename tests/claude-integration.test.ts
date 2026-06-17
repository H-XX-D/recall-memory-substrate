import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  claudeIntegrationStatus,
  mergeSettings,
  recallHookGroups,
  setClaudeAutoMemory,
  syncClaudeIntegration,
  upsertMcpServer,
} from "../src/core/claude-integration.js";

const HOOK = "/home/u/.claude/hooks/recall-session-start.py";

describe("mergeSettings", () => {
  it("injects both hook events and the auto-memory env var into an empty config", () => {
    const { next, changed } = mergeSettings({}, { hookCommandPath: HOOK, disableAutoMemory: true });
    assert.deepEqual(changed.sort(), ["env.CLAUDE_CODE_DISABLE_AUTO_MEMORY", "hooks.SessionStart", "hooks.UserPromptSubmit"].sort());
    assert.equal((next.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    const ss = (next.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(ss.length, 1);
    assert.match(JSON.stringify(ss), /recall-session-start\.py/);
  });

  it("is idempotent — a second merge reports no changes and does not duplicate hooks", () => {
    const first = mergeSettings({}, { hookCommandPath: HOOK, disableAutoMemory: true });
    const second = mergeSettings(first.next, { hookCommandPath: HOOK, disableAutoMemory: true });
    assert.deepEqual(second.changed, []);
    assert.equal((second.next.hooks as Record<string, unknown[]>).SessionStart.length, 1);
  });

  it("refreshes a stale Recall hook entry instead of appending a duplicate", () => {
    const stale = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "python3 \"/old/path/recall-session-start.py\"", timeout: 99 }] },
        ],
      },
    };
    const { next, changed } = mergeSettings(stale, { hookCommandPath: HOOK, disableAutoMemory: true });
    const ss = (next.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(ss.length, 1, "stale recall group replaced, not duplicated");
    assert.match(JSON.stringify(ss), /home\/u\/\.claude/);
    assert.ok(changed.includes("hooks.SessionStart"));
  });

  it("preserves unrelated hooks and settings", () => {
    const existing = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node other.js" }] }] },
    };
    const { next } = mergeSettings(existing, { hookCommandPath: HOOK, disableAutoMemory: true });
    assert.deepEqual(next.permissions, existing.permissions);
    const ss = (next.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(ss.length, 2, "kept the unrelated hook and added ours");
    assert.match(JSON.stringify(ss[0]), /other\.js/);
  });

  it("opt-out removes the auto-memory env var", () => {
    const on = mergeSettings({}, { hookCommandPath: HOOK, disableAutoMemory: true });
    const off = mergeSettings(on.next, { hookCommandPath: HOOK, disableAutoMemory: false });
    assert.ok(off.changed.includes("env.CLAUDE_CODE_DISABLE_AUTO_MEMORY (removed)"));
    assert.ok(!("CLAUDE_CODE_DISABLE_AUTO_MEMORY" in (off.next.env as Record<string, unknown>)));
  });
});

describe("upsertMcpServer", () => {
  it("adds the recall server and is idempotent", () => {
    const first = upsertMcpServer({}, "recall-mcp");
    assert.equal(first.changed, true);
    assert.deepEqual((first.next.mcpServers as Record<string, unknown>).recall, {
      type: "stdio", command: "recall-mcp", args: [], env: {},
    });
    const second = upsertMcpServer(first.next, "recall-mcp");
    assert.equal(second.changed, false);
  });

  it("preserves other registered MCP servers", () => {
    const { next } = upsertMcpServer({ mcpServers: { other: { command: "x" } } }, "recall-mcp");
    assert.ok("other" in (next.mcpServers as Record<string, unknown>));
    assert.ok("recall" in (next.mcpServers as Record<string, unknown>));
  });
});

describe("recallHookGroups", () => {
  it("uses --prompt for UserPromptSubmit and the bare command for SessionStart", () => {
    const g = recallHookGroups(HOOK);
    assert.match(JSON.stringify(g.SessionStart), /recall-session-start\.py/);
    assert.doesNotMatch(JSON.stringify(g.SessionStart), /--prompt/);
    assert.match(JSON.stringify(g.UserPromptSubmit), /--prompt/);
  });
});

describe("syncClaudeIntegration (filesystem round-trip)", () => {
  const assetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations", "claude");

  it("installs hook + skill + mcp + settings, then re-runs idempotently", () => {
    if (!existsSync(assetsRoot)) return; // bundled assets only present in a built checkout
    const home = mkdtempSync(join(tmpdir(), "recall-claude-"));
    try {
      const claudeHome = join(home, ".claude");
      const claudeJsonPath = join(home, ".claude.json");
      const opts = { claudeHome, claudeJsonPath, assetsRoot };

      const r1 = syncClaudeIntegration(opts);
      assert.ok(existsSync(r1.hookPath));
      assert.ok(existsSync(join(r1.skillDir, "SKILL.md")));
      assert.equal(r1.autoMemoryDisabled, true);

      const status = claudeIntegrationStatus(opts);
      assert.deepEqual(
        { hook: status.hookInstalled, skill: status.skillInstalled, mcp: status.mcpRegistered, off: status.autoMemoryDisabled },
        { hook: true, skill: true, mcp: true, off: true },
      );

      const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      assert.equal(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

      // second run: settings already canonical -> no settings backup created
      const r2 = syncClaudeIntegration(opts);
      assert.equal(r2.settingsBackup, null, "idempotent re-run leaves settings unchanged");

      // opt-out toggle
      const off = setClaudeAutoMemory(true, opts);
      assert.equal(off.autoMemoryDisabled, false);
      assert.equal(claudeIntegrationStatus(opts).autoMemoryDisabled, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
