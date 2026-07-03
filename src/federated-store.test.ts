import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { FederatedReadStore, FEDERATED_READ_ONLY_MESSAGE } from "./federated-store.js";
import { SqliteStore, contentKey } from "./store.js";

test("federated search and lookup return graph-prefixed cells", () => {
  const home = new SqliteStore(":memory:");
  const project = new SqliteStore(":memory:");
  const homeCell = buildCell(
    { kind: "obs", title: "home marker", body: "shared federation marker", confidence: 0.7 },
    { key: "aaaa", now: "2026-06-26T12:00:00.000Z" },
  );
  const projectCell = buildCell(
    { kind: "obs", title: "project marker", body: "shared federation marker", confidence: 0.7 },
    { key: "bbbb", now: "2026-06-26T12:01:00.000Z" },
  );
  home.put(homeCell);
  project.put(projectCell);

  const fed = new FederatedReadStore([
    { graph: "home", store: home, ownsStore: true },
    { graph: "proj", store: project, ownsStore: true },
  ]);
  try {
    const hitKeys = new Set(fed.search("federation marker", { limit: 10 }).map((hit) => hit.cell.key));
    assert.deepEqual(hitKeys, new Set(["home:aaaa", "proj:bbbb"]));
    assert.equal(fed.get("proj:bbbb")?.key, "proj:bbbb");
    assert.equal(fed.get("aaaa")?.key, "home:aaaa");
    assert.equal(fed.getByHandle(homeCell.handle)?.key, "home:aaaa");
    assert.equal(fed.getByHandle(`proj:${projectCell.handle}`)?.key, "proj:bbbb");
    assert.equal(fed.findByContentKey("obs", contentKey("obs", "project marker"))?.key, "proj:bbbb");
  } finally {
    fed.close();
  }
});

test("federated neighbors prefix incident edges and connected cells", () => {
  const store = new SqliteStore(":memory:");
  store.put(
    buildCell(
      { kind: "dec", title: "source", body: "a", confidence: 0.8, edges: [{ relation: "supports", target: "bbbb" }] },
      { key: "aaaa" },
    ),
  );
  store.put(buildCell({ kind: "obs", title: "target", body: "b", confidence: 0.7 }, { key: "bbbb" }));

  const fed = new FederatedReadStore([{ graph: "proj", store, ownsStore: true }]);
  try {
    const out = fed.neighbors("proj:aaaa");
    assert.equal(out.length, 1);
    assert.equal(out[0]?.direction, "out");
    assert.equal(out[0]?.edge.source, "proj:aaaa");
    assert.equal(out[0]?.edge.target, "proj:bbbb");
    assert.equal(out[0]?.cell.key, "proj:bbbb");

    const inc = fed.neighbors("proj:bbbb");
    assert.equal(inc.length, 1);
    assert.equal(inc[0]?.direction, "in");
    assert.equal(inc[0]?.edge.source, "proj:aaaa");
    assert.equal(inc[0]?.cell.key, "proj:aaaa");
  } finally {
    fed.close();
  }
});

test("federated stats aggregate members and writes are blocked", () => {
  const first = new SqliteStore(":memory:");
  const second = new SqliteStore(":memory:");
  first.put(
    buildCell(
      { kind: "dec", title: "first", body: "a", confidence: 0.8, edges: [{ relation: "supports", target: "bbbb" }] },
      { key: "aaaa" },
    ),
  );
  second.put(buildCell({ kind: "obs", title: "second", body: "b", confidence: 0.7 }, { key: "bbbb" }));

  const fed = new FederatedReadStore([
    { graph: "one", store: first, ownsStore: true },
    { graph: "two", store: second, ownsStore: true },
  ]);
  try {
    assert.throws(
      () => fed.put(buildCell({ kind: "obs", title: "blocked", body: "x", confidence: 0.7 }, { key: "cccc" })),
      new RegExp(FEDERATED_READ_ONLY_MESSAGE),
    );
    assert.deepEqual(
      fed.all().map((cell) => cell.key).sort(),
      ["one:aaaa", "two:bbbb"],
    );
    assert.deepEqual(
      fed.active().map((cell) => cell.key).sort(),
      ["one:aaaa", "two:bbbb"],
    );
    const stats = fed.stats();
    assert.equal(stats.cells, 2);
    assert.equal(stats.activeCells, 2);
    assert.equal(stats.edges, 1);
    assert.equal(stats.lexicalBackend, "federated");
  } finally {
    fed.close();
  }
});

test("federated putSemanticVector throws read-only error", () => {
  const store = new SqliteStore(":memory:");
  const fed = new FederatedReadStore([{ graph: "home", store, ownsStore: true }]);
  try {
    assert.throws(
      () =>
        fed.putSemanticVector({
          nodeId: "x",
          backend: "cosine",
          dims: 2,
          vector: [0.1, 0.2],
          indexedAt: "2026-07-03T00:00:00Z",
        }),
      new RegExp(FEDERATED_READ_ONLY_MESSAGE),
    );
  } finally {
    fed.close();
  }
});

test("federated getSemanticVector resolves across members by prefixed key", () => {
  const home = new SqliteStore(":memory:");
  const proj = new SqliteStore(":memory:");
  const ts = "2026-07-03T00:00:00Z";
  home.putSemanticVector({ nodeId: "node-1", backend: "cosine", dims: 2, vector: [0.1, 0.2], indexedAt: ts });
  proj.putSemanticVector({ nodeId: "node-2", backend: "cosine", dims: 2, vector: [0.3, 0.4], indexedAt: ts });

  const fed = new FederatedReadStore([
    { graph: "home", store: home, ownsStore: true },
    { graph: "proj", store: proj, ownsStore: true },
  ]);
  try {
    const v1 = fed.getSemanticVector("home:node-1");
    assert.equal(v1?.nodeId, "node-1");
    assert.deepEqual(v1?.vector, [0.1, 0.2]);

    const v2 = fed.getSemanticVector("proj:node-2");
    assert.equal(v2?.nodeId, "node-2");
    assert.deepEqual(v2?.vector, [0.3, 0.4]);

    assert.equal(fed.getSemanticVector("home:node-2"), undefined);

    const ids = fed.listSemanticVectorIds().sort();
    assert.deepEqual(ids, ["home:node-1", "proj:node-2"]);
  } finally {
    fed.close();
  }
});
