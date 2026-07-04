import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClaudeSettings, recallHookGroups, upsertClaudeMcpServer } from "./claude-integration.js";

const HOOK = "/home/user/.claude/hooks/recall-session-start.py";

test("recallHookGroups wires SessionStart, prompt, and stop modes", () => {
  const groups = recallHookGroups(HOOK);
  assert.match(JSON.stringify(groups.SessionStart), /recall-session-start\.py/);
  assert.doesNotMatch(JSON.stringify(groups.SessionStart), /--prompt|--stop/);
  assert.match(JSON.stringify(groups.UserPromptSubmit), /--prompt/);
  assert.match(JSON.stringify(groups.Stop), /--stop/);
});

test("recallHookGroups default output (no opts) is byte-identical to the pre-writeGate shape", () => {
  const groups = recallHookGroups(HOOK);
  assert.deepEqual(groups, {
    SessionStart: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --prompt`, timeout: 10 }],
    },
    Stop: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --stop`, timeout: 10 }],
    },
  });
  assert.equal(
    JSON.stringify(groups),
    JSON.stringify({
      SessionStart: {
        hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
      },
      UserPromptSubmit: {
        hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --prompt`, timeout: 10 }],
      },
      Stop: {
        hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --stop`, timeout: 10 }],
      },
    }),
  );
});

test("recallHookGroups writeGate appends the node prompt/stop hooks after the python entries", () => {
  const withGate = recallHookGroups(HOOK, {
    writeGate: { stopHookCommand: "recall-stop-hook", promptHookCommand: "recall-prompt-hook" },
  });
  const withoutGate = recallHookGroups(HOOK);

  // SessionStart is untouched by writeGate.
  assert.deepEqual(withGate.SessionStart, withoutGate.SessionStart);

  const promptHooks = (withGate.UserPromptSubmit as { hooks: unknown[] }).hooks;
  assert.equal(promptHooks.length, 2);
  assert.match(JSON.stringify(promptHooks[0]), /python3 .*--prompt/);
  assert.deepEqual(promptHooks[1], { type: "command", command: "recall-prompt-hook" });

  const stopHooks = (withGate.Stop as { hooks: unknown[] }).hooks;
  assert.equal(stopHooks.length, 2);
  assert.match(JSON.stringify(stopHooks[0]), /python3 .*--stop/);
  assert.deepEqual(stopHooks[1], { type: "command", command: "recall-stop-hook" });
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
  assert.match(JSON.stringify(sessionStart[1]!), /home\/user/);
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
