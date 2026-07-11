import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasInlineCodexHooks,
  mergeAgentsMd,
  mergeCodexHooks,
  recallAgentsBlock,
  recallCodexHookGroups,
  recallMcpToml,
  recallSlashPrompt,
  upsertCodexMcpServer,
} from "./codex-integration.js";
import { RECALL_BLOCK_BEGIN } from "./agent-integration.js";

test("mergeAgentsMd preserves project content and refreshes the Recall block", () => {
  const merged = mergeAgentsMd("# Project rules\n\n- Run tests.\n");
  assert.equal(merged.changed, true);
  assert.match(merged.next, /Project rules/);
  assert.match(merged.next, /Recall durable memory/);

  const again = mergeAgentsMd(merged.next);
  assert.equal(again.changed, false);
  assert.equal(again.next.split(RECALL_BLOCK_BEGIN).length - 1, 1);
});

test("recallAgentsBlock and slash prompt expose Codex-facing instructions", () => {
  assert.match(recallAgentsBlock(), /managed by Recall v5/);
  assert.match(recallSlashPrompt(), /Use Recall active memory/);
});

test("recallCodexHookGroups installs only Codex-supported portable events", () => {
  const hook = "/home/user/.codex/hooks/recall-session-start.py";
  const groups = recallCodexHookGroups(hook);
  assert.deepEqual(Object.keys(groups).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.doesNotMatch(JSON.stringify(groups), /UserPromptExpansion|--expansion/);
  assert.match(JSON.stringify(groups.PostToolUse), /Bash\|mcp__recall__\.\*/);
  assert.match(JSON.stringify(groups.PostToolUse), /--tool/);
});

test("mergeCodexHooks is idempotent and preserves mixed sibling handlers", () => {
  const hook = "/home/user/.codex/hooks/recall-session-start.py";
  const existing = {
    hooks: {
      Stop: [{
        matcher: "ignored",
        hooks: [
          { type: "command", command: "python3 /old/recall-session-start.py --stop" },
          { type: "command", command: "python3 /custom/stop-rules.py" },
        ],
      }],
      PreToolUse: [{ hooks: [{ type: "command", command: "python3 custom.py" }] }],
    },
  };
  const first = mergeCodexHooks(existing, hook);
  assert.equal(first.changed, true);
  const hooks = first.next.hooks as Record<string, unknown[]>;
  const stop = hooks.Stop;
  const preToolUse = hooks.PreToolUse;
  assert.ok(stop);
  assert.ok(preToolUse);
  assert.equal(stop.length, 2);
  assert.match(JSON.stringify(stop[0]), /custom\/stop-rules\.py/);
  assert.doesNotMatch(JSON.stringify(stop[0]), /recall-session-start\.py/);
  assert.equal(preToolUse.length, 1);
  const second = mergeCodexHooks(first.next, hook);
  assert.equal(second.changed, false);
  assert.deepEqual(second.next, first.next);
});

test("hasInlineCodexHooks detects hooks tables but not the feature flag", () => {
  assert.equal(hasInlineCodexHooks("[hooks]\n"), true);
  assert.equal(hasInlineCodexHooks("[[hooks.Stop]]\n"), true);
  assert.equal(hasInlineCodexHooks("[hooks.state]\n[hooks.state.\"trusted-id\"]\n"), false);
  assert.equal(hasInlineCodexHooks("[features]\nhooks = true\n"), false);
});

test("recallMcpToml includes optional RECALL_DB env", () => {
  const toml = recallMcpToml("recall-mcp", "/tmp/project.sqlite3");
  assert.match(toml, /\[mcp_servers\.recall\]/);
  assert.match(toml, /command = "recall-mcp"/);
  assert.match(toml, /\[mcp_servers\.recall\.env\]/);
  assert.match(toml, /RECALL_DB = "\/tmp\/project\.sqlite3"/);
});

test("upsertCodexMcpServer preserves other TOML and is idempotent", () => {
  const existing = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`;
  const first = upsertCodexMcpServer(existing, { mcpCommand: "recall-mcp" });
  assert.equal(first.changed, true);
  assert.match(first.next, /model = "gpt-5"/);
  assert.match(first.next, /\[mcp_servers\.other\]/);
  assert.match(first.next, /\[mcp_servers\.recall\]/);

  const second = upsertCodexMcpServer(first.next, { mcpCommand: "recall-mcp" });
  assert.equal(second.changed, false);
  assert.equal(second.next.match(/\[mcp_servers\.recall\]/g)?.length, 1);
});

test("upsertCodexMcpServer removes stale table and dotted-key variants", () => {
  const cases = [
    'mcp_servers.recall = { command = "old" }\n',
    'mcp_servers.recall.command = "old"\nmcp_servers.recall.env.RECALL_DB = "/old"\n',
    '[mcp_servers."recall"]\ncommand = "old"\n',
    '[mcp_servers.recall] # stale\ncommand = "old"\n\n[mcp_servers.recall.env]\nRECALL_DB = "/old"\n',
  ];
  for (const input of cases) {
    const { next } = upsertCodexMcpServer(`model = "x"\n\n${input}`, { mcpCommand: "recall-mcp" });
    assert.equal(next.match(/\[mcp_servers\.recall\]/g)?.length, 1, input);
    assert.doesNotMatch(next, /"old"|"\/old"/);
    assert.match(next, /model = "x"/);
  }
});
