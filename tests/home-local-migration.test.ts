import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admitWriteProposal } from "../src/core/admission.js";
import { ensureHomeLocal, homeDbPath } from "../src/core/routing.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal } from "./helpers.js";

// Seed a pre-model-A global.sqlite3 with one cell and NO home.sqlite3, then drive
// a home-local open through ensureHomeLocal (what `recall status`/`search` run
// first) and confirm the memory is carried forward, the original is kept, and a
// second run does not re-copy.
test("first-run global.sqlite3 -> home.sqlite3 migration is non-destructive and idempotent (FIX 2)", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-migrate-"));
  const env = { RECALL_HOME: home } as NodeJS.ProcessEnv;
  const homePath = homeDbPath(env);
  const globalPath = join(dirname(homePath), "global.sqlite3");
  try {
    // Seed db/global.sqlite3 with a couple of cells; no home.sqlite3 yet.
    mkdirSync(dirname(globalPath), { recursive: true });
    const legacy = new SQLiteRecallStore(globalPath);
    let seededId: string;
    try {
      const r1 = admitWriteProposal(
        makeProposal({
          content: { title: "Legacy narwhal decision", body: "saved before model-A", summary: "legacy" },
          tags: { topics: ["narwhal"], entities: ["Recall"] },
        }),
        legacy,
      );
      assert.equal(r1.accepted, true);
      seededId = r1.node!.id;
      const r2 = admitWriteProposal(
        makeProposal({
          content: { title: "Legacy second narwhal note", body: "also pre-model-A", summary: "legacy2" },
          tags: { topics: ["narwhal"], entities: ["Recall"] },
        }),
        legacy,
      );
      assert.equal(r2.accepted, true);
    } finally {
      legacy.close();
    }
    assert.ok(!existsSync(homePath), "home.sqlite3 must not exist before migration");

    // Trigger the home-local open path.
    ensureHomeLocal(env);

    // home.sqlite3 now exists and carries the legacy cells.
    assert.ok(existsSync(homePath), "home.sqlite3 should be created by the migration");
    assert.ok(existsSync(globalPath), "global.sqlite3 must be kept as a backup");
    const migrated = new SQLiteRecallStore(homePath);
    try {
      assert.equal(migrated.stats().nodes, 2, "both legacy cells should be carried forward");
      const node = migrated.getNode(seededId);
      assert.ok(node, "the seeded cell should be present in the home local");
      assert.match(node!.title, /narwhal/);
    } finally {
      migrated.close();
    }

    // Idempotent: mutate home.sqlite3, run again, and confirm it was NOT re-copied
    // over (the legacy backup is never re-applied once home exists).
    const after = new SQLiteRecallStore(homePath);
    try {
      const extra = admitWriteProposal(
        makeProposal({
          content: { title: "Post-migration octopus note", body: "added after migration", summary: "post" },
          tags: { topics: ["octopus"], entities: ["Recall"] },
        }),
        after,
      );
      assert.equal(extra.accepted, true);
    } finally {
      after.close();
    }
    const mtimeBefore = statSync(homePath).mtimeMs;
    ensureHomeLocal(env); // second run
    const reopened = new SQLiteRecallStore(homePath);
    try {
      assert.equal(reopened.stats().nodes, 3, "second run must not re-copy and clobber the post-migration write");
    } finally {
      reopened.close();
    }
    assert.equal(statSync(homePath).mtimeMs, mtimeBefore, "second run must not rewrite home.sqlite3");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
