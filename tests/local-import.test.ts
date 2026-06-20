import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { importGlobalToLocal } from "../src/core/local-import.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { RecallNode } from "../src/core/types.js";
import { makeProposal, tempDbPath } from "./helpers.js";

function seed(
  store: SQLiteRecallStore,
  opts: {
    project: string;
    topics: string[];
    title: string;
    body: string;
    confidence?: number;
    intentKind?: string;
    session?: string;
    overrideReview?: boolean;
  },
): RecallNode {
  const proposal = makeProposal({
    intent: { kind: (opts.intentKind ?? "observation") as never, operation: "create" },
    scope: { project: opts.project, tenant: "local", session: opts.session },
    tags: { project: [opts.project], topics: opts.topics, subject: [opts.title] },
    content: { title: opts.title, body: opts.body, summary: opts.body },
    confidence: { value: opts.confidence ?? 0.7 },
  });
  const result = admitWriteProposal(proposal, store, opts.overrideReview ? { overrideReview: true } : undefined);
  assert.ok(result.accepted && result.node, `seed admitted: ${opts.title}`);
  return result.node!;
}

describe("import-local (global cells into a local db)", () => {
  it("copies only the global cells matching --project (apply)", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["auth"], title: "alpha-fact", body: "Alpha body" });
      seed(gs, { project: "beta", topics: ["ui"], title: "beta-fact", body: "Beta body" });

      const sum = importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      assert.equal(sum.created, 1);
      const nodes = ls.listNodes(100);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]!.title, "alpha-fact");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("preserves the source cell's stated confidence on the local copy", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["auth"], title: "c", body: "Body c", confidence: 0.83 });
      importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      const node = ls.listNodes(100)[0]!;
      assert.equal((node.data.confidence as { value: number }).value, 0.83, "confidence copied, not reset");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("filters by --tags (topics)", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["auth"], title: "auth-fact", body: "Auth body" });
      seed(gs, { project: "alpha", topics: ["billing"], title: "billing-fact", body: "Billing body" });

      const sum = importGlobalToLocal(gs, ls, { tags: ["auth"], apply: true });
      assert.equal(sum.created, 1);
      assert.equal(ls.listNodes(100)[0]!.title, "auth-fact");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("requires a scope: throws with neither --project nor --tags", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      assert.throws(() => importGlobalToLocal(gs, ls, { apply: true }), /scope|project|tags/i);
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("dry-runs by default: predicts a create but writes nothing", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["auth"], title: "alpha-fact", body: "Alpha body" });
      const sum = importGlobalToLocal(gs, ls, { project: "alpha" });
      assert.equal(sum.dryRun, true);
      assert.equal(sum.created, 1);
      assert.equal(ls.listNodes(100).length, 0, "dry-run admits nothing");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("is idempotent: a second import of unchanged cells creates nothing new", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["auth"], title: "alpha-fact", body: "Alpha body" });
      importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      const second = importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      assert.equal(second.created, 0);
      assert.equal(second.skipped, 1);
      assert.equal(ls.listNodes(100).length, 1, "no duplicate cell");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("rehydrates a hyperedge whose members all land, and leaves a partial one as loose cells", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      const a = seed(gs, { project: "alpha", topics: ["x"], title: "A", body: "body a" });
      const b = seed(gs, { project: "alpha", topics: ["x"], title: "B", body: "body b" });
      const c = seed(gs, { project: "beta", topics: ["y"], title: "C", body: "body c" });

      // Fully inside the alpha selection.
      gs.addHyperedge({
        kind: "bundle",
        title: "AB",
        members: [
          { nodeId: a.id, role: "member" },
          { nodeId: b.id, role: "member" },
        ],
      });
      // Straddles the boundary: a is alpha, c is beta (won't land).
      gs.addHyperedge({
        kind: "bundle",
        title: "AC",
        members: [
          { nodeId: a.id, role: "member" },
          { nodeId: c.id, role: "member" },
        ],
      });

      const sum = importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      assert.equal(sum.created, 2, "a and b imported");
      assert.equal(sum.hyperedgesReattached, 1, "AB rehydrated");
      assert.equal(sum.hyperedgesPartial, 1, "AC left as loose cells");

      const edges = ls.listHyperedges(100);
      assert.equal(edges.length, 1);
      assert.equal(edges[0]!.title, "AB");
      const memberTitles = edges[0]!.members.map((m) => ls.getNode(m.nodeId)?.title).sort();
      assert.deepEqual(memberTitles, ["A", "B"], "members remapped to local ids");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("imports a belief cell, mapping its kind back to a valid intent (belief stays belief)", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      const seeded = seed(gs, { project: "alpha", topics: ["x"], title: "belief-fact", body: "A belief", intentKind: "belief_update" });
      assert.equal(seeded.kind, "belief", "seeded global cell is a belief");

      const sum = importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      assert.equal(sum.created, 1, "belief cell is importable (not skipped invalid)");
      assert.equal(ls.listNodes(100)[0]!.kind, "belief", "kind preserved as belief locally");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("imports a program cell with dry-run/apply parity (firewall still applies)", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    try {
      seed(gs, { project: "alpha", topics: ["x"], title: "prog", body: "A program cell", intentKind: "program", overrideReview: true });
      const ld = tempDbPath();
      const ls1 = new SQLiteRecallStore(ld.path);
      const dry = importGlobalToLocal(gs, ls1, { project: "alpha" });
      ls1.close();
      ld.cleanup();

      const la = tempDbPath();
      const ls2 = new SQLiteRecallStore(la.path);
      const wet = importGlobalToLocal(gs, ls2, { project: "alpha", apply: true });
      assert.equal(dry.created, wet.created, "dry-run created matches apply for a program cell");
      assert.equal(wet.created, 1, "program cell imported on apply");
      ls2.close();
      la.cleanup();
    } finally {
      gs.close();
      g.cleanup();
    }
  });

  it("previews hyperedge rehydration in dry-run (without writing)", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      const a = seed(gs, { project: "alpha", topics: ["x"], title: "A", body: "body a" });
      const b = seed(gs, { project: "alpha", topics: ["x"], title: "B", body: "body b" });
      gs.addHyperedge({
        kind: "bundle",
        title: "AB",
        members: [
          { nodeId: a.id, role: "member" },
          { nodeId: b.id, role: "member" },
        ],
      });

      const sum = importGlobalToLocal(gs, ls, { project: "alpha" });
      assert.equal(sum.dryRun, true);
      assert.equal(sum.hyperedgesReattached, 1, "dry-run predicts the rehydration");
      assert.equal(ls.listNodes(100).length, 0, "dry-run writes no cells");
      assert.equal(ls.listHyperedges(100).length, 0, "dry-run writes no hyperedges");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("reports selection truncation when more cells match than the limit", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      seed(gs, { project: "alpha", topics: ["x"], title: "one", body: "b1" });
      seed(gs, { project: "alpha", topics: ["x"], title: "two", body: "b2" });
      seed(gs, { project: "alpha", topics: ["x"], title: "three", body: "b3" });

      const sum = importGlobalToLocal(gs, ls, { project: "alpha", apply: true, limit: 2 });
      assert.equal(sum.created, 2, "only the limit is imported");
      assert.equal(sum.selectionTruncated, true, "truncation is reported, not silent");
      assert.equal(sum.selectionLimit, 2);
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });

  it("preserves scope.path and scope.session on the copy", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    const l = tempDbPath();
    const ls = new SQLiteRecallStore(l.path);
    try {
      const seeded = seed(gs, { project: "alpha", topics: ["x"], title: "scoped", body: "b", session: "sess-1" });
      importGlobalToLocal(gs, ls, { project: "alpha", apply: true });
      const local = ls.listNodes(100)[0]!;
      assert.equal(local.scope.path, seeded.scope.path, "scope.path preserved");
      assert.equal(local.scope.session, "sess-1", "scope.session preserved");
    } finally {
      gs.close();
      g.cleanup();
      ls.close();
      l.cleanup();
    }
  });
});

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli import local", () => {
  it("dry-runs by default and imports with --apply, reading global via --global-db", () => {
    const g = tempDbPath();
    const gs = new SQLiteRecallStore(g.path);
    seed(gs, { project: "alpha", topics: ["auth"], title: "alpha-fact", body: "Alpha body" });
    gs.close();
    const l = tempDbPath();
    try {
      const dry = execFileSync(
        process.execPath,
        [...CLI, "import", "local", "--project", "alpha", "--global-db", g.path, "--db", l.path],
        { encoding: "utf8" },
      );
      assert.match(dry, /"dryRun": true/);
      assert.match(dry, /"created": 1/);

      const applied = execFileSync(
        process.execPath,
        [...CLI, "import", "local", "--project", "alpha", "--apply", "--global-db", g.path, "--db", l.path],
        { encoding: "utf8" },
      );
      assert.match(applied, /"created": 1/);

      const ls = new SQLiteRecallStore(l.path);
      assert.equal(ls.listNodes(100).length, 1);
      ls.close();
    } finally {
      g.cleanup();
      l.cleanup();
    }
  });
});
