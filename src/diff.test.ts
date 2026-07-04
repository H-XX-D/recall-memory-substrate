import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit } from "./admission.js";
import { addHyperedge } from "./hyperedges.js";
import { diffStore, parseSince, renderDiffSummary } from "./diff.js";
import { SqliteStore } from "./store.js";
import { runCli } from "./cli.js";

const BEFORE = "2026-07-01T00:00:00.000Z";
const SINCE = "2026-07-03T00:00:00.000Z";
const AFTER = "2026-07-04T00:00:00.000Z";

function seededStore(): {
  store: SqliteStore;
  oldDecKey: string;
  oldObsKey: string;
  newBelKey: string;
  replacementKey: string;
  hyperedgeId: string;
} {
  const store = new SqliteStore(":memory:");
  const oldDec = admit(
    { kind: "dec", title: "Old decision A", body: "Original decision body.", confidence: 0.8 },
    { store, now: BEFORE },
  ).cell!;
  const oldObs = admit(
    { kind: "obs", title: "Old observation B", body: "Old observation body.", confidence: 0.8 },
    { store, now: BEFORE },
  ).cell!;
  const newBel = admit(
    { kind: "bel", title: "New belief C", body: "Fresh in-window belief.", confidence: 0.8 },
    { store, now: AFTER },
  ).cell!;
  const replacement = admit(
    {
      kind: "dec",
      title: "Replacement decision",
      body: "Supersedes the original decision.",
      confidence: 0.8,
      edges: [{ relation: "supersedes", target: oldDec.key, weight: 0 }],
    },
    { store, now: AFTER },
  ).cell!;
  // Simulate an in-window update to a pre-window cell.
  const touched = store.get(oldObs.key)!;
  touched.updatedAt = AFTER;
  store.put(touched);
  const hyperedge = addHyperedge(
    store,
    { kind: "grouping", title: "New group", members: [newBel.key] },
    AFTER,
  );
  return {
    store,
    oldDecKey: oldDec.key,
    oldObsKey: oldObs.key,
    newBelKey: newBel.key,
    replacementKey: replacement.key,
    hyperedgeId: hyperedge.id,
  };
}

test("diffStore buckets new, updated, superseded, and hyperedges correctly", () => {
  const seeded = seededStore();
  try {
    const d = diffStore(seeded.store, { since: SINCE });
    assert.equal(d.since, SINCE);
    assert.deepEqual(
      new Set(d.newCells.map((c) => c.key)),
      new Set([seeded.newBelKey, seeded.replacementKey]),
    );
    assert.deepEqual(d.updatedCells.map((c) => c.key), [seeded.oldObsKey]);
    assert.deepEqual(d.supersedeEvents, [
      {
        oldKey: seeded.oldDecKey,
        newKey: seeded.replacementKey,
        kind: "dec",
        title: "Replacement decision",
      },
    ]);
    assert.deepEqual(d.newHyperedges.map((h) => h.id), [seeded.hyperedgeId]);
  } finally {
    seeded.store.close();
  }
});

test("diffStore filters by kinds and caps each bucket at maxItems", () => {
  const seeded = seededStore();
  try {
    const bel = diffStore(seeded.store, { since: SINCE, kinds: ["bel"] });
    assert.deepEqual(bel.newCells.map((c) => c.key), [seeded.newBelKey]);
    assert.deepEqual(bel.updatedCells, []);
    assert.deepEqual(bel.supersedeEvents, []);

    const capped = diffStore(seeded.store, { since: SINCE, maxItems: 1 });
    assert.equal(capped.newCells.length, 1);
  } finally {
    seeded.store.close();
  }
});

test("diffStore filters by project", () => {
  const store = new SqliteStore(":memory:");
  try {
    admit(
      { kind: "obs", title: "Scoped observation", body: "b", confidence: 0.8, project: "px" },
      { store, now: AFTER },
    );
    admit(
      { kind: "obs", title: "Unscoped observation", body: "b", confidence: 0.8 },
      { store, now: AFTER },
    );
    const d = diffStore(store, { since: SINCE, project: "px" });
    assert.equal(d.newCells.length, 1);
    assert.equal(d.newCells[0]!.title, "Scoped observation");
  } finally {
    store.close();
  }
});

test("parseSince resolves relative durations against now and passes ISO through", () => {
  const now = "2026-07-04T12:00:00.000Z";
  assert.equal(parseSince("30m", now), "2026-07-04T11:30:00.000Z");
  assert.equal(parseSince("2h", now), "2026-07-04T10:00:00.000Z");
  assert.equal(parseSince("7d", now), "2026-06-27T12:00:00.000Z");
  assert.equal(parseSince("4w", now), "2026-06-06T12:00:00.000Z");
  assert.equal(parseSince("2026-07-01T00:00:00.000Z", now), "2026-07-01T00:00:00.000Z");
  assert.throws(() => parseSince("notatime", now));
  assert.throws(() => parseSince("", now));
});

// The middle dots, arrow, and em dash in these assertions are ported contract
// strings from the legacy recall_diff.py summary; they stay byte-identical.
test("renderDiffSummary emits the pinned markdown format", () => {
  const seeded = seededStore();
  try {
    const d = diffStore(seeded.store, { since: SINCE });
    const md = renderDiffSummary(d, "");
    assert.match(md, /^# Recall diff \(graph-wide\) since 2026-07-03T00:00:00\.000Z$/m);
    assert.match(md, /^\*\*Summary:\*\* 2 new cells · 1 updated · 1 new edges · 1 supersede events$/m);
    assert.match(md, /^## New cells \(2\)$/m);
    assert.match(md, new RegExp(`^- \`${seeded.newBelKey.slice(0, 8)}\` \\[bel\\] New belief C$`, "m"));
    assert.match(md, /^## Updated cells \(1\)$/m);
    assert.match(md, /^## Supersede events \(1\)$/m);
    assert.match(
      md,
      new RegExp(
        `^- \`${seeded.oldDecKey.slice(0, 8)}\` → \`${seeded.replacementKey.slice(0, 8)}\` \\(dec\\) — Replacement decision$`,
        "m",
      ),
    );
    assert.match(md, /^## New hyperedges \(1\)$/m);

    const scoped = renderDiffSummary(d, "px");
    assert.match(scoped, /^# Recall diff in project `px` since 2026-07-03T00:00:00\.000Z$/m);
  } finally {
    seeded.store.close();
  }
});

test("renderDiffSummary renders the no-activity line for an empty window", () => {
  const store = new SqliteStore(":memory:");
  try {
    const d = diffStore(store, { since: SINCE });
    const md = renderDiffSummary(d, "");
    assert.match(md, /^_No activity in this window\._$/m);
    assert.match(md, /^\*\*Summary:\*\* 0 new cells · 0 updated · 0 new edges · 0 supersede events$/m);
  } finally {
    store.close();
  }
});

test("recall diff CLI: relative --since, JSON default, --summary markdown, and argument errors", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recall-diff-cli-"));
  try {
    const db = join(tmp, "diff.sqlite3");
    const oldPath = join(tmp, "old.json");
    const newPath = join(tmp, "new.json");
    writeFileSync(
      oldPath,
      JSON.stringify({ kind: "dec", title: "Aged decision", body: "b", confidence: 0.8 }),
    );
    writeFileSync(
      newPath,
      JSON.stringify({ kind: "obs", title: "Fresh observation", body: "b", confidence: 0.8 }),
    );
    assert.equal(capture(["admit", "--json", oldPath, "--db", db], { now: "2026-06-26T12:00:00.000Z" }).code, 0);
    const admitted = capture(["admit", "--json", newPath, "--db", db], { now: "2026-07-04T11:30:00.000Z" });
    assert.equal(admitted.code, 0);
    const freshKey = JSON.parse(admitted.stdout).cell.key as string;

    const json = capture(["diff", "--since", "2h", "--db", db], { now: "2026-07-04T12:00:00.000Z" });
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.since, "2026-07-04T10:00:00.000Z");
    assert.deepEqual(parsed.newCells.map((c: { key: string }) => c.key), [freshKey]);
    assert.deepEqual(parsed.updatedCells, []);
    assert.deepEqual(parsed.supersedeEvents, []);
    assert.deepEqual(parsed.newHyperedges, []);

    const summary = capture(["diff", "--since", "2h", "--summary", "--db", db], { now: "2026-07-04T12:00:00.000Z" });
    assert.equal(summary.code, 0);
    assert.match(summary.stdout, /^# Recall diff \(graph-wide\) since 2026-07-04T10:00:00\.000Z$/m);
    assert.match(summary.stdout, /^\*\*Summary:\*\* 1 new cells · 0 updated · 0 new edges · 0 supersede events$/m);
    assert.match(summary.stdout, new RegExp(`^- \`${freshKey.slice(0, 8)}\` \\[obs\\] Fresh observation$`, "m"));

    const empty = capture(["diff", "--since", "30m", "--summary", "--db", db], { now: "2026-07-04T13:00:00.000Z" });
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /^_No activity in this window\._$/m);

    assert.equal(capture(["diff", "--db", db]).code, 1);
    assert.equal(capture(["diff", "--since", "notatime", "--db", db]).code, 1);
    assert.equal(capture(["diff", "--since", "2h", "--kinds", "zzz", "--db", db]).code, 1);

    const kinds = capture(["diff", "--since", "2h", "--kinds", "dec,bel", "--db", db], { now: "2026-07-04T12:00:00.000Z" });
    assert.equal(kinds.code, 0);
    assert.deepEqual(JSON.parse(kinds.stdout).newCells, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function capture(
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; now?: string } = {},
): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    ...opts,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
