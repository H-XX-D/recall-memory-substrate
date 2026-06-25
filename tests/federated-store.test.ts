import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { analyzeMemory } from "../src/core/analysis.js";
import { FederatedReadStore } from "../src/core/federated-store.js";
import { cellReferenceTarget } from "../src/core/references.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// Admit one cell into a fresh local and return its bare (un-prefixed) id.
function seed(path: string, title: string, body: string, marker: string): string {
  const store = new SQLiteRecallStore(path);
  try {
    const result = admitWriteProposal(
      makeProposal({
        content: { title, body, summary: `${marker} summary` },
        tags: { topics: [marker], entities: ["Recall"] },
      }),
      store,
    );
    assert.equal(result.accepted, true, `seed ${marker} should be accepted`);
    return result.node!.id;
  } finally {
    store.close();
  }
}

describe("FederatedReadStore", () => {
  it("prefixes the bare ids inside node.data.evidence so trust analysis matches under the union", () => {
    const db = tempDbPath();
    const store = new SQLiteRecallStore(db.path);
    let beliefId: string;
    let witnessId: string;
    try {
      const belief = admitWriteProposal(
        makeProposal({
          content: { title: "Postgres is the primary store", body: "chosen as primary", summary: "pg" },
          tags: { topics: ["pg"], entities: ["Recall"] },
        }),
        store,
      );
      assert.equal(belief.accepted, true);
      beliefId = belief.node!.id;
      const witness = admitWriteProposal(
        makeProposal({
          content: { title: "Postgres was dropped for SQLite", body: "reversed the choice", summary: "drop" },
          tags: { topics: ["pg"], entities: ["Recall"] },
          evidence: { contradicts: [belief.node!.cellAddress] },
        }),
        store,
      );
      assert.equal(witness.accepted, true);
      witnessId = witness.node!.id;
    } finally {
      store.close();
    }
    const federated = new FederatedReadStore([{ graph: "acme", path: db.path }]);
    try {
      const witness = federated.getNode(`acme:${witnessId}`);
      assert.ok(witness, "the witness resolves under the union");
      const evidence = witness!.data.evidence as { contradicts?: string[] };
      assert.ok(evidence.contradicts && evidence.contradicts.length === 1);
      // The bare contradicts ref must be re-prefixed to the same graph as the
      // belief's union id, so id-keyed trust analysis (scoreBelief, calibration)
      // matches instead of silently counting zero contradictions.
      assert.equal(cellReferenceTarget(evidence.contradicts![0]), `acme:${beliefId}`);
    } finally {
      federated.close();
      db.cleanup();
    }
  });

  it("scores a contradicted belief under the union instead of reading it as trustworthy (end to end)", () => {
    const db = tempDbPath();
    const store = new SQLiteRecallStore(db.path);
    let beliefId: string;
    try {
      const belief = admitWriteProposal(
        makeProposal({
          intent: { kind: "belief_update", operation: "create" },
          content: { title: "Cache TTL is sixty seconds", body: "the agreed cache lifetime", summary: "ttl" },
          tags: { type: ["belief_update"], topics: ["cache"] },
        }),
        store,
      );
      assert.equal(belief.node!.kind, "belief");
      beliefId = belief.node!.id;
      admitWriteProposal(
        makeProposal({
          content: { title: "Cache TTL was changed to ten minutes", body: "the lifetime was revised", summary: "revised" },
          tags: { topics: ["cache"] },
          evidence: { contradicts: [belief.node!.id] },
          confidence: { value: 0.9, uncertainty: 0.1, concern: 0.9, source_quality: "high" },
        }),
        store,
      );
    } finally {
      store.close();
    }
    const federated = new FederatedReadStore([{ graph: "acme", path: db.path }]);
    try {
      const report = analyzeMemory(federated);
      const scored = report.beliefs.find((b) => b.nodeId === `acme:${beliefId}`);
      assert.ok(scored, "the belief is scored under the union");
      assert.ok(
        scored!.contradiction > 0,
        "the contradiction must be counted under the union, not silently zero (a challenged belief reading as trust)",
      );
    } finally {
      federated.close();
      db.cleanup();
    }
  });

  it("getNodeByAddress scans members and is not mis-routed by a project slug matching the address scheme", () => {
    const homeDb = tempDbPath();
    const recallDb = tempDbPath();
    let addr: string;
    let bareId: string;
    const homeStore = new SQLiteRecallStore(homeDb.path);
    try {
      const r = admitWriteProposal(
        makeProposal({
          content: { title: "Home addressable cell", body: "lives in the home local", summary: "addr" },
          tags: { topics: ["addr"], entities: ["Recall"] },
        }),
        homeStore,
      );
      assert.equal(r.accepted, true);
      addr = r.node!.cellAddress;
      bareId = r.node!.id;
    } finally {
      homeStore.close();
    }
    // A registered project whose slug is exactly "recall" (the address scheme word).
    new SQLiteRecallStore(recallDb.path).close();

    const federated = new FederatedReadStore([
      { graph: "home", path: homeDb.path },
      { graph: "recall", path: recallDb.path },
    ]);
    try {
      // decode(addr) splits on the first ":" -> graph "recall"; the old code routed
      // to the recall member with a truncated address and returned null. The lookup
      // must scan members with the raw address instead.
      const node = federated.getNodeByAddress(addr);
      assert.ok(node, "the home cell must resolve by address despite a 'recall' member");
      assert.equal(node!.id, `home:${bareId}`);
    } finally {
      federated.close();
      homeDb.cleanup();
      recallDb.cleanup();
    }
  });

  it("unions reads across members with graph-prefixed ids and refuses writes", () => {
    const homeDb = tempDbPath();
    const projDb = tempDbPath();
    const homeId = seed(homeDb.path, "Home zeta marker decision", "lives in the home local", "homezeta");
    const projId = seed(projDb.path, "Project zeta marker decision", "lives in the acme local", "projzeta");

    const federated = new FederatedReadStore([
      { graph: "home", path: homeDb.path },
      { graph: "acme", path: projDb.path },
    ]);
    try {
      // search returns ids prefixed by their graph and includes BOTH members.
      const hits = federated.search("zeta marker", 20);
      const ids = hits.map((h) => h.id);
      assert.ok(ids.includes(`home:${homeId}`), `expected home:${homeId} in ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(`acme:${projId}`), `expected acme:${projId} in ${JSON.stringify(ids)}`);
      // every returned id carries a graph prefix.
      for (const id of ids) {
        assert.match(id, /^(home|acme):/);
      }

      // getNode(prefixedId) round-trips and re-prefixes the returned node id.
      const homeNode = federated.getNode(`home:${homeId}`);
      assert.ok(homeNode, "home node should resolve");
      assert.equal(homeNode!.id, `home:${homeId}`);
      const projNode = federated.getNode(`acme:${projId}`);
      assert.ok(projNode, "project node should resolve");
      assert.equal(projNode!.id, `acme:${projId}`);

      // a bare id (no prefix) still resolves by scanning members.
      const byBare = federated.getNode(homeId);
      assert.ok(byBare, "bare id should resolve by scan");
      assert.equal(byBare!.id, `home:${homeId}`);

      // stats() sums element-wise across members (one node each here).
      const stats = federated.stats();
      assert.equal(stats.nodes, 2);

      // listNodes unions and prefixes.
      const listed = federated.listNodes(50).map((n) => n.id).sort();
      assert.deepEqual(listed, [`acme:${projId}`, `home:${homeId}`].sort());

      // a write method throws the read-only error.
      assert.throws(
        () =>
          federated.insertAdmittedWrite(
            homeNode!,
            makeProposal(),
            [],
            [],
          ),
        /read-only/,
      );
      assert.throws(() => federated.reindexSemantic(), /read-only/);
    } finally {
      federated.close();
      homeDb.cleanup();
      projDb.cleanup();
    }
  });

  it("prefixes both endpoints of intra-local relations", () => {
    const db = tempDbPath();
    const store = new SQLiteRecallStore(db.path);
    let supporterId = "";
    let targetId = "";
    try {
      // target first.
      const target = admitWriteProposal(
        makeProposal({
          content: { title: "Relation target alpha", body: "the supported claim", summary: "target" },
          tags: { topics: ["reltarget"], entities: ["Recall"] },
        }),
        store,
      );
      assert.equal(target.accepted, true);
      targetId = target.node!.id;

      // supporter that supports the target by its cell address, so admission
      // writes a real intra-local relation edge.
      const supporter = admitWriteProposal(
        makeProposal({
          content: { title: "Relation supporter beta", body: "backs the target", summary: "supporter" },
          tags: { topics: ["relsupporter"], entities: ["Recall"] },
          evidence: { supports: [target.node!.cellAddress] },
        }),
        store,
      );
      assert.equal(supporter.accepted, true);
      supporterId = supporter.node!.id;
    } finally {
      store.close();
    }

    const federated = new FederatedReadStore([{ graph: "acme", path: db.path }]);
    try {
      const relations = federated.listRelations(`acme:${targetId}`, "in", 100);
      assert.ok(relations.length >= 1, "expected at least one incoming relation");
      const rel = relations.find((r) => r.targetId === `acme:${targetId}`);
      assert.ok(rel, "expected a relation pointing at the prefixed target");
      assert.equal(rel!.targetId, `acme:${targetId}`);
      assert.equal(rel!.sourceId, `acme:${supporterId}`);
    } finally {
      federated.close();
      db.cleanup();
    }
  });

  it("skips members whose file does not exist yet", () => {
    const homeDb = tempDbPath();
    const homeId = seed(homeDb.path, "Only home gamma marker", "the sole local", "homegamma");
    // point a second member at a path that was never created.
    const federated = new FederatedReadStore([
      { graph: "home", path: homeDb.path },
      { graph: "ghost", path: `${homeDb.path}.missing` },
    ]);
    try {
      const hits = federated.search("gamma marker", 20);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.id, `home:${homeId}`);
    } finally {
      federated.close();
      homeDb.cleanup();
    }
  });
});
