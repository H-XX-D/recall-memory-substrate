import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClaudeSettings, recallHookGroups, upsertClaudeMcpServer } from "./claude-integration.js";

const HOOK = "/home/user/.claude/hooks/recall-session-start.py";

test("recallHookGroups wires all five portable Claude lifecycle modes", () => {
  const groups = recallHookGroups(HOOK);
  assert.match(JSON.stringify(groups.SessionStart), /recall-session-start\.py/);
  assert.doesNotMatch(JSON.stringify(groups.SessionStart), /--prompt|--expansion|--tool|--stop/);
  assert.match(JSON.stringify(groups.UserPromptSubmit), /--prompt/);
  assert.match(JSON.stringify(groups.UserPromptExpansion), /--expansion/);
  assert.match(JSON.stringify(groups.PostToolUse), /--tool/);
  assert.match(JSON.stringify(groups.PostToolUse), /Bash\|mcp__recall__/);
  assert.match(JSON.stringify(groups.Stop), /--stop/);
});

test("recallHookGroups default output has the canonical five-event shape", () => {
  const groups = recallHookGroups(HOOK);
  assert.deepEqual(groups, {
    SessionStart: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)}`, timeout: 15, statusMessage: "Consulting Recall memory..." }],
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --prompt`, timeout: 10 }],
    },
    UserPromptExpansion: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --expansion`, timeout: 10 }],
    },
    PostToolUse: {
      matcher: "Bash|mcp__recall__.*",
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --tool`, timeout: 10 }],
    },
    Stop: {
      hooks: [{ type: "command", command: `python3 ${JSON.stringify(HOOK)} --stop`, timeout: 10 }],
    },
  });
});

test("recallHookGroups writeGate appends the node prompt/stop hooks after the python entries", () => {
  const withGate = recallHookGroups(HOOK, {
    writeGate: { stopHookCommand: "recall-stop-hook", promptHookCommand: "recall-prompt-hook" },
  });
  const withoutGate = recallHookGroups(HOOK);

  // Events unrelated to the optional write gate are untouched.
  assert.deepEqual(withGate.SessionStart, withoutGate.SessionStart);
  assert.deepEqual(withGate.UserPromptExpansion, withoutGate.UserPromptExpansion);
  assert.deepEqual(withGate.PostToolUse, withoutGate.PostToolUse);

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
      "hooks.PostToolUse",
      "hooks.Stop",
      "hooks.UserPromptExpansion",
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

test("mergeClaudeSettings preserves unrelated sibling handlers in a mixed matcher group", () => {
  const existing = {
    hooks: {
      Stop: [{
        matcher: "anything",
        hooks: [
          { type: "command", command: "python3 /old/recall-session-start.py --stop" },
          { type: "command", command: "python3 /custom/stop-rules.py" },
        ],
      }],
    },
  };
  const merged = mergeClaudeSettings(existing, { hookCommandPath: HOOK });
  const stop = (merged.next.hooks as Record<string, unknown[]>).Stop;
  assert.ok(stop);
  assert.equal(stop.length, 2);
  assert.match(JSON.stringify(stop[0]), /custom\/stop-rules\.py/);
  assert.doesNotMatch(JSON.stringify(stop[0]), /recall-session-start\.py/);
  assert.match(JSON.stringify(stop[1]), /home\/user.*--stop/);
});

test("mergeClaudeSettings toggles optional node write gates without leftovers or duplicates", () => {
  const gate = { stopHookCommand: "recall-stop-hook", promptHookCommand: "recall-prompt-hook" };
  const enabled = mergeClaudeSettings({}, { hookCommandPath: HOOK, writeGate: gate });
  const disabled = mergeClaudeSettings(enabled.next, { hookCommandPath: HOOK });
  assert.doesNotMatch(JSON.stringify(disabled.next.hooks), /recall-(?:prompt|stop)-hook/);
  const reenabled = mergeClaudeSettings(disabled.next, { hookCommandPath: HOOK, writeGate: gate });
  assert.equal((JSON.stringify(reenabled.next.hooks).match(/recall-prompt-hook/g) ?? []).length, 1);
  assert.equal((JSON.stringify(reenabled.next.hooks).match(/recall-stop-hook/g) ?? []).length, 1);
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
