import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { tempDbPath } from "./helpers.js";

function callTool(store: SQLiteRecallStore, name: string, args: unknown): any {
  const res: any = handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    store,
  );
  return JSON.parse(res.result.content[0].text);
}

function seed(store: SQLiteRecallStore): string {
  const out = callTool(store, "recall_write", {
    write: {
      kind: "decision",
      title: "Quetzalcoatl deployment topology decision",
      body: "A deliberately long body ".repeat(60),
      confidence: 0.8,
      topics: ["quetzalcoatl-topology"],
      sourceFiles: ["docs/x.md"],
    },
  });
  return out.node.id;
}

test("recall_search is compact by default (no body/data, has excerpt)", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    seed(store);
    const out = callTool(store, "recall_search", { query: "Quetzalcoatl topology" });
    assert.ok(out.results.length >= 1);
    const hit = out.results[0];
    assert.equal("body" in hit, false);
    assert.equal("data" in hit, false);
    assert.equal(typeof hit.excerpt, "string");
    assert.ok(hit.excerpt.length <= 184); // 180 + ellipsis
    assert.equal(typeof hit.id, "string");
    assert.equal(typeof hit.title, "string");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("recall_search full:true returns the full body", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    seed(store);
    const out = callTool(store, "recall_search", { query: "Quetzalcoatl topology", full: true });
    assert.ok(out.results.length >= 1);
    assert.equal("body" in out.results[0], true);
    assert.ok(out.results[0].body.length > 184);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("recall_cell is compact by default (no node.body, relation counts present)", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const id = seed(store);
    const out = callTool(store, "recall_cell", { idOrAddress: id });
    assert.equal("body" in out.node, false);
    assert.equal(typeof out.node.excerpt, "string");
    assert.equal(typeof out.relationCounts.incoming, "number");
    assert.equal(typeof out.relationCounts.outgoing, "number");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("recall_cell full:true returns the full node body", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const id = seed(store);
    const out = callTool(store, "recall_cell", { idOrAddress: id, full: true });
    assert.equal("body" in out.node, true);
  } finally {
    store.close();
    temp.cleanup();
  }
});
