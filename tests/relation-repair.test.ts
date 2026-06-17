import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { analyzeMemory } from "../src/core/analysis.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// The historical danglers (240 in the dogfood graph as of 2026-06) entered the
// graph BEFORE admission learned to drop unresolved trust edges — written by
// older binaries. Admission now refuses to materialize such an edge, so the
// ONLY way to reproduce that legacy state is to insert a raw trust relation
// whose target node does not exist, bypassing admission entirely.
function injectDangling(dbPath: string, kind: string, sourceId: string, targetId: string): string {
  const db = new DatabaseSync(dbPath);
  const id = randomUUID();
  try {
    db.prepare(
      "INSERT INTO graph_relations (id, kind, source_id, target_id, data_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
    ).run(id, kind, sourceId, targetId, "2026-06-01T00:00:00.000Z");
  } finally {
    db.close();
  }
  return id;
}

function seedCell(store: SQLiteRecallStore, title: string): string {
  const result = admitWriteProposal(
    makeProposal({ content: { title, body: `${title} body`, summary: title } }),
    store,
    { now: new Date("2026-06-01T00:00:00.000Z") }
  );
  assert.equal(result.accepted, true);
  return result.node!.id;
}

describe("unresolvable trust-edge repair", () => {
  it("finds a dangling trust edge whose target resolves to no node", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const source = seedCell(store, "Source cell");
      const relId = injectDangling(temp.path, "contradicts", source, "HIERARCHY_FORCED");
      const found = store.unresolvableTrustEdges();
      assert.equal(found.length, 1);
      assert.equal(found[0]!.id, relId);
      assert.equal(found[0]!.kind, "contradicts");
      assert.equal(found[0]!.targetId, "HIERARCHY_FORCED");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("ignores resolvable trust edges and dangling depends_on (lineage is never scored)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const source = seedCell(store, "Source cell");
      const target = seedCell(store, "Target cell");
      admitWriteProposal(
        makeProposal({ content: { title: "Supporter", body: "supports target", summary: "s" }, evidence: { supports: [target] } }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      injectDangling(temp.path, "depends_on", source, "external-anchor-not-a-cell");
      assert.equal(store.unresolvableTrustEdges().length, 0);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("prunes only the unresolvable trust edges, leaving resolvable ones intact", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const source = seedCell(store, "Source cell");
      const target = seedCell(store, "Target cell");
      admitWriteProposal(
        makeProposal({ content: { title: "Supporter", body: "supports target", summary: "s" }, evidence: { supports: [target] } }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      injectDangling(temp.path, "contradicts", source, "PHANTOM_ONE");
      injectDangling(temp.path, "concerns", source, "PHANTOM_TWO");

      const result = store.pruneUnresolvableTrustEdges();
      assert.equal(result.deleted, 2);
      assert.equal(store.unresolvableTrustEdges().length, 0);
      const survivors = store.listRelations(target, "in", 100).filter((r) => r.kind === "supports");
      assert.equal(survivors.length, 1, "the resolvable supports edge survives the prune");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("is a no-op (deletes nothing) when there are no danglers", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = seedCell(store, "Target cell");
      admitWriteProposal(
        makeProposal({ content: { title: "Supporter", body: "supports target", summary: "s" }, evidence: { supports: [target] } }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      assert.equal(store.pruneUnresolvableTrustEdges().deleted, 0);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("surfaces a dangling-evidence count, by-kind breakdown, and worst offenders in the health report", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const source = seedCell(store, "Source cell");
      injectDangling(temp.path, "contradicts", source, "PHANTOM_A");
      injectDangling(temp.path, "supports", source, "PHANTOM_B");

      const report = analyzeMemory(store);
      assert.equal(report.danglingEvidence.total, 2);
      assert.equal(report.danglingEvidence.byKind.contradicts, 1);
      assert.equal(report.danglingEvidence.byKind.supports, 1);
      assert.equal(report.danglingEvidence.worst.length, 2);
      assert.ok(
        report.nextActions.some((action) => /dangling/i.test(action)),
        "a next action flags the dangling-evidence load"
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("reports zero dangling evidence on a clean graph", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      seedCell(store, "Lonely cell");
      const report = analyzeMemory(store);
      assert.equal(report.danglingEvidence.total, 0);
      assert.deepEqual(report.danglingEvidence.worst, []);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  // Guard: an archived target is NOT a dangler. Rollback archives a node
  // (status flip) but never deletes the row, so getNode still returns it and
  // the edge stays restorable. Pruning it would orphan a recoverable relation
  // AND diverge from the relation-targets-resolve eval, which also uses getNode.
  it("does NOT prune a trust edge whose target exists but is archived (archived != absent)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = seedCell(store, "Target cell");
      admitWriteProposal(
        makeProposal({ content: { title: "Supporter", body: "supports target", summary: "s" }, evidence: { supports: [target] } }),
        store,
        { now: new Date("2026-06-01T00:01:00.000Z") }
      );
      const db = new DatabaseSync(temp.path);
      db.prepare("UPDATE graph_nodes SET status = 'archived' WHERE id = ?").run(target);
      db.close();

      assert.equal(store.unresolvableTrustEdges().length, 0, "edge to an archived-but-present node is not dangling");
      assert.equal(store.pruneUnresolvableTrustEdges().deleted, 0);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli repair", () => {
  it("dry-runs by default (reports, deletes nothing) and prunes only with --apply", () => {
    const temp = tempDbPath();
    let source: string;
    const store = new SQLiteRecallStore(temp.path);
    try {
      source = seedCell(store, "Source cell");
    } finally {
      store.close();
    }
    injectDangling(temp.path, "contradicts", source, "PHANTOM_CLI");
    try {
      const dry = execFileSync(process.execPath, [...CLI, "repair", "--db", temp.path], { encoding: "utf8" });
      assert.match(dry, /"dryRun": true/);
      assert.match(dry, /"count": 1/);

      const afterDry = new SQLiteRecallStore(temp.path);
      assert.equal(afterDry.unresolvableTrustEdges().length, 1, "dry-run must not delete");
      afterDry.close();

      const applied = execFileSync(process.execPath, [...CLI, "repair", "--apply", "--db", temp.path], { encoding: "utf8" });
      assert.match(applied, /"dryRun": false/);
      assert.match(applied, /"count": 1/);

      const afterApply = new SQLiteRecallStore(temp.path);
      assert.equal(afterApply.unresolvableTrustEdges().length, 0, "--apply deletes the dangler");
      afterApply.close();
    } finally {
      temp.cleanup();
    }
  });
});
