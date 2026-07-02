import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeAgentsMd,
  recallAgentsBlock,
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
