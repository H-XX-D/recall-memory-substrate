import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import {
  RECALL_BLOCK_BEGIN,
  buildPromptContextPush,
  buildStopReminder,
  mergeRecallDirective,
  recallDirectiveBlock,
  recallSlashPrompt,
} from "./agent-integration.js";
import { SqliteStore } from "./store.js";

test("mergeRecallDirective installs one managed block and is idempotent", () => {
  const first = mergeRecallDirective("# Existing rules\n");
  assert.equal(first.changed, true);
  assert.match(first.next, /Recall durable memory/);
  assert.match(first.next, /# Existing rules/);

  const second = mergeRecallDirective(first.next);
  assert.equal(second.changed, false);
  assert.equal(second.next.split(RECALL_BLOCK_BEGIN).length - 1, 1);
});

test("mergeRecallDirective replaces stale or dangling managed blocks", () => {
  const stale = `# Rules\n\n${RECALL_BLOCK_BEGIN}\nstale body\n<!-- recall:end -->\n\n${RECALL_BLOCK_BEGIN}\ndangling`;
  const { next } = mergeRecallDirective(stale);
  assert.equal(next.split(RECALL_BLOCK_BEGIN).length - 1, 1);
  assert.doesNotMatch(next, /stale body|dangling/);
  assert.match(next, /Corrections supersede/);
});

test("mergeRecallDirective removes the retired codex-sync marker block", () => {
  const legacy = [
    "# Rules",
    "<!-- recall:begin (managed by `recall codex sync`) -->",
    "legacy nested-schema instructions",
    "<!-- recall:end -->",
    recallDirectiveBlock(),
  ].join("\n");
  const { next } = mergeRecallDirective(legacy);
  assert.equal(next.split(RECALL_BLOCK_BEGIN).length - 1, 1);
  assert.doesNotMatch(next, /legacy nested-schema instructions|recall codex sync/);
  assert.match(next, /# Rules/);
});

test("recallDirectiveBlock and slash prompt teach read-first write-back discipline", () => {
  const block = recallDirectiveBlock();
  assert.match(block, /recall compile/);
  assert.match(block, /relation is `supersedes`/);
  assert.doesNotMatch(block, /evidence\.contradicts/);
  assert.match(block, /encrypted secret side store/);

  const prompt = recallSlashPrompt();
  assert.match(prompt, /^---\ndescription:/);
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /recall_compile/);
  assert.match(prompt, /recall_cell.*idOrAddress/);
  assert.match(prompt, /relation: "supersedes"/);
  assert.doesNotMatch(prompt, /evidence\.contradicts/);
});

test("buildPromptContextPush compiles store-backed context for an agent prompt", () => {
  const store = new SqliteStore(":memory:");
  store.put(
    buildCell(
      { kind: "dec", title: "watchdog integration decision", body: "Use Recall before acting.", confidence: 0.8 },
      { key: "dec1" },
    ),
  );
  const review = buildCell(
    {
      kind: "obs",
      title: "watchdog stale note",
      body: "Needs verification.",
      confidence: 0.6,
      flags: { requiresReview: true },
    },
    { key: "obs1" },
  );
  store.put(review);

  const push = buildPromptContextPush(store, "watchdog integration", { limit: 5 });
  assert.equal(push.packet.expansionHandles.includes("dec1"), true);
  assert.equal(push.packet.expansionHandles.includes("obs1"), true);
  assert.equal(push.expansionRequired, true);
  assert.match(push.text, /objective:/);
  assert.match(push.text, /EXPAND REQUIRED/);
  store.close();
});

test("buildStopReminder prompts durable write-back without secrets", () => {
  const reminder = buildStopReminder();
  assert.match(reminder, /write durable/);
  assert.match(reminder, /relation `supersedes`/);
  assert.doesNotMatch(reminder, /evidence\.contradicts/);
  assert.match(reminder, /Do not put secrets/);
});
