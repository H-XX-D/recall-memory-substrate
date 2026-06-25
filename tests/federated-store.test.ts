import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { FederatedReadStore } from "../src/core/federated-store.js";
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
