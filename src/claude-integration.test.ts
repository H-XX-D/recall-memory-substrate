import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClaudeSettings, recallHookGroups, upsertClaudeMcpServer } from "./claude-integration.js";

const HOOK = "/Users/hendrixx./.claude/hooks/recall-session-start.py";

test("recallHookGroups wires SessionStart, prompt, and stop modes", () => {
  const groups = recallHookGroups(HOOK);
  assert.match(JSON.stringify(groups.SessionStart), /recall-session-start\.py/);
  assert.doesNotMatch(JSON.stringify(groups.SessionStart), /--prompt|--stop/);
  assert.match(JSON.stringify(groups.UserPromptSubmit), /--prompt/);
  assert.match(JSON.stringify(groups.Stop), /--stop/);
});

test("mergeClaudeSettings injects Recall hooks and disables native auto-memory", () => {
  const first = mergeClaudeSettings({}, { hookCommandPath: HOOK });
  assert.deepEqual(
    first.changed.sort(),
    [
      "env.CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "hooks.SessionStart",
      "hooks.Stop",
      "hooks.UserPromptSubmit",
    ].sort(),
  );
  assert.equal((first.next.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

  const second = mergeClaudeSettings(first.next, { hookCommandPath: HOOK });
  assert.deepEqual(second.changed, []);
  const sessionStart = (second.next.hooks as Record<string, unknown[]>).SessionStart;
  assert.ok(sessionStart);
  assert.equal(sessionStart.length, 1);
});

test("mergeClaudeSettings refreshes stale Recall hooks and preserves unrelated hooks", () => {
  const existing = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "node unrelated.js" }] },
        { hooks: [{ type: "command", command: "python3 /old/recall-session-start.py", timeout: 99 }] },
      ],
    },
  };
  const merged = mergeClaudeSettings(existing, { hookCommandPath: HOOK });
  const sessionStart = (merged.next.hooks as Record<string, unknown[]>).SessionStart;
  assert.ok(sessionStart);
  assert.equal(sessionStart.length, 2);
  assert.match(JSON.stringify(sessionStart[0]!), /unrelated\.js/);
  assert.match(JSON.stringify(sessionStart[1]!), /hendrixx/);
  assert.doesNotMatch(JSON.stringify(sessionStart), /\/old\//);
});

test("mergeClaudeSettings can remove the auto-memory disable env", () => {
  const enabled = mergeClaudeSettings(
    { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } },
    { hookCommandPath: HOOK, disableAutoMemory: false },
  );
  assert.ok(enabled.changed.includes("env.CLAUDE_CODE_DISABLE_AUTO_MEMORY (removed)"));
  assert.ok(!("CLAUDE_CODE_DISABLE_AUTO_MEMORY" in (enabled.next.env as Record<string, unknown>)));
});

test("upsertClaudeMcpServer adds recall and preserves other servers", () => {
  const first = upsertClaudeMcpServer({ mcpServers: { other: { command: "x" } } }, "recall-mcp");
  assert.equal(first.changed, true);
  assert.ok("other" in (first.next.mcpServers as Record<string, unknown>));
  assert.deepEqual((first.next.mcpServers as Record<string, unknown>).recall, {
    type: "stdio",
    command: "recall-mcp",
    args: [],
    env: {},
  });

  const second = upsertClaudeMcpServer(first.next, "recall-mcp");
  assert.equal(second.changed, false);
});
