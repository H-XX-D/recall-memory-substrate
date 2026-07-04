import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit } from "./admission.js";
import { addHyperedge } from "./hyperedges.js";
import { diffStore, parseSince, renderDiffSummary } from "./diff.js";
import { FederatedReadStore } from "./federated-store.js";
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

// Short ids in the summary must survive federation: a union key is
// graph-prefixed (home:<uuid>), so slicing the first 8 characters yields a
// dead 3-hex id like `home:1c7`. The short id must keep the graph and an
// 8-hex core so `recall cell show <id>` and recall_peek can resolve it.
test("renderDiffSummary keeps federated ids resolvable: graph plus 8-hex core, derived keys whole", () => {
  const seeded = seededStore();
  const drvKey = `drv_eval_run_${"a".repeat(24)}`;
  const drvSource = admit(
    { kind: "obs", title: "Derived witness row", body: "b", confidence: 0.8 },
    { store: seeded.store, now: AFTER },
  ).cell!;
  seeded.store.put({ ...seeded.store.get(drvSource.key)!, key: drvKey });
  const union = new FederatedReadStore([{ graph: "home", store: seeded.store }]);
  try {
    const md = renderDiffSummary(diffStore(union, { since: SINCE }), "");
    assert.match(md, new RegExp(`^- \`home:${seeded.newBelKey.slice(0, 8)}\` \\[bel\\] New belief C$`, "m"));
    assert.match(
      md,
      new RegExp(
        `^- \`home:${seeded.oldDecKey.slice(0, 8)}\` → \`home:${seeded.replacementKey.slice(0, 8)}\` \\(dec\\) — Replacement decision$`,
        "m",
      ),
    );
    // A derived key has no hex core to shorten; it renders whole.
    assert.match(md, new RegExp(`^- \`home:${drvKey}\` \\[obs\\] Derived witness row$`, "m"));

    const bare = renderDiffSummary(diffStore(seeded.store, { since: SINCE }), "");
    assert.match(bare, new RegExp(`^- \`${drvKey}\` \\[obs\\] Derived witness row$`, "m"));
  } finally {
    union.close();
    seeded.store.close();
  }
});

// End-to-end pin for the SessionStart remediation loop: the id the home-scope
// summary prints must resolve through `recall cell show`.
test("home-scope diff summary prints ids that cell show resolves", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recall-diff-home-"));
  try {
    const env = { RECALL_HOME: join(tmp, "rhome") } as NodeJS.ProcessEnv;
    const proposalPath = join(tmp, "cell.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({ kind: "dec", title: "Switch to postgres for storage", body: "b", confidence: 0.8 }),
    );
    const admitted = capture(["admit", "--json", proposalPath], { env, cwd: tmp, now: "2026-07-04T11:30:00.000Z" });
    assert.equal(admitted.code, 0);
    const key = JSON.parse(admitted.stdout).cell.key as string;

    const summary = capture(["diff", "--since", "2h", "--summary"], { env, cwd: tmp, now: "2026-07-04T12:00:00.000Z" });
    assert.equal(summary.code, 0);
    const shortId = new RegExp(`\`(home:[0-9a-f]{8})\` \\[dec\\]`).exec(summary.stdout)?.[1];
    assert.ok(shortId, `no graph-qualified 8-hex id in summary:\n${summary.stdout}`);

    const shown = capture(["cell", "show", shortId!], { env, cwd: tmp });
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).cell.key, `home:${key}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

// A cell admitted through a project route keeps scope.project === "default";
// the project's own DB file IS the scope. diff must not re-filter that store
// by the routing slug, or every project-routed diff reports zero activity
// (the SessionStart hook's daily-driver case: cwd inside a registered root).
test("recall diff routed to a project reports that project's activity", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recall-diff-route-"));
  try {
    const env = { RECALL_HOME: join(tmp, "rhome") } as NodeJS.ProcessEnv;
    const root = join(tmp, "workroot");
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    assert.equal(capture(["project", "init", "--slug", "work", "--root", root], { env }).code, 0);

    const proposalPath = join(tmp, "cell.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({ kind: "dec", title: "Decision made inside", body: "b", confidence: 0.8 }),
    );
    const admitted = capture(["admit", "--json", proposalPath, "--project", "work"], {
      env,
      now: "2026-07-04T11:30:00.000Z",
    });
    assert.equal(admitted.code, 0);
    const key = JSON.parse(admitted.stdout).cell.key as string;

    // Explicit --project routing.
    const viaFlag = capture(["diff", "--since", "2h", "--project", "work"], {
      env,
      now: "2026-07-04T12:00:00.000Z",
    });
    assert.equal(viaFlag.code, 0);
    assert.deepEqual(JSON.parse(viaFlag.stdout).newCells.map((c: { key: string }) => c.key), [key]);

    // cwd routing from inside the registered root (what the hook does).
    const viaCwd = capture(["diff", "--since", "2h", "--summary"], {
      env,
      cwd: sub,
      now: "2026-07-04T12:00:00.000Z",
    });
    assert.equal(viaCwd.code, 0);
    assert.match(viaCwd.stdout, /^# Recall diff in project `work` since /m);
    assert.match(viaCwd.stdout, /^\*\*Summary:\*\* 1 new cells · 0 updated · 0 new edges · 0 supersede events$/m);
    assert.match(viaCwd.stdout, new RegExp(`^- \`${key.slice(0, 8)}\` \\[dec\\] Decision made inside$`, "m"));
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
