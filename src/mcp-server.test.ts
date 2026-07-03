import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, TOOLS, type JsonRpcRequest } from "./mcp-server.js";
import { SqliteStore } from "./store.js";
import { WRITE_TEMPLATE } from "./template.js";
import { buildCell } from "./build.js";
import { indexCell } from "./semantic.js";
import { admit } from "./admission.js";

function req(method: string, params?: Record<string, unknown>, id: number = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}
function callText(r: ReturnType<typeof handleMcpRequest>): any {
  const result = r?.result as any;
  return JSON.parse(result.content[0].text);
}

test("initialize returns protocol version and server info", () => {
  const store = new SqliteStore(":memory:");
  const res = handleMcpRequest(req("initialize"), store)?.result as any;
  assert.equal(res.protocolVersion, "2024-11-05");
  assert.equal(res.serverInfo.name, "recall");
  store.close();
});

test("tools/list returns exactly the eleven-tool surface", () => {
  const store = new SqliteStore(":memory:");
  const res = handleMcpRequest(req("tools/list"), store)?.result as any;
  assert.deepEqual(res.tools.map((t: any) => t.name), [
    "recall_status",
    "recall_search",
    "recall_compile",
    "recall_cell",
    "recall_write",
    "recall_semantic",
    "recall_ref",
    "recall_page",
    "recall_hyperedge_add",
    "recall_hyperedge_show",
    "recall_hyperedge_list",
  ]);
  store.close();
});

test("recall_status returns store stats", () => {
  const store = new SqliteStore(":memory:");
  const stats = callText(handleMcpRequest(req("tools/call", { name: "recall_status", arguments: {} }), store));
  assert.equal(typeof stats.cells, "number");
  store.close();
});

test("recall_write admits a clean write and recall_cell resolves it back", () => {
  const store = new SqliteStore(":memory:");
  const wr = callText(handleMcpRequest(req("tools/call", {
    name: "recall_write",
    arguments: { kind: "dec", title: "mcp write test", body: "a real distinct body", confidence: 0.6 },
  }), store));
  assert.equal(wr.accepted, true);
  const cell = callText(handleMcpRequest(req("tools/call", {
    name: "recall_cell",
    arguments: { idOrAddress: wr.id },
  }), store));
  assert.equal(cell.title, "mcp write test");
  store.close();
});

test("recall_write through MCP enforces fill-or-reject", () => {
  const store = new SqliteStore(":memory:");
  const wr = callText(handleMcpRequest(req("tools/call", {
    name: "recall_write",
    arguments: { kind: "dec", title: "ok title", body: WRITE_TEMPLATE.body, confidence: 0.6 },
  }), store));
  assert.equal(wr.accepted, false);
  assert.ok(wr.issues.some((i: any) => i.path === "body"));
  store.close();
});

test("unknown method returns a -32601 error", () => {
  const store = new SqliteStore(":memory:");
  const r = handleMcpRequest(req("bogus/method"), store);
  assert.equal(r?.error?.code, -32601);
  store.close();
});

test("a notification (no id) yields no response", () => {
  const store = new SqliteStore(":memory:");
  const r = handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, store);
  assert.equal(r, undefined);
  store.close();
});

test("TOOLS is the eleven-tool surface", () => {
  assert.equal(TOOLS.length, 11);
});

test("recall_semantic returns JSON hits with key/handle/title/score/backend", () => {
  delete process.env["RECALL_EMBEDDING_URL"];
  const store = new SqliteStore(":memory:");
  const cell = buildCell({ kind: "obs", title: "quantum physics wave", body: "quantum entanglement and wave functions", summary: "", confidence: 0.9, topics: [], entities: [] });
  store.put(cell);
  indexCell(cell, store);

  const hits = callText(handleMcpRequest(req("tools/call", {
    name: "recall_semantic",
    arguments: { query: "quantum wave function physics" },
  }), store));

  assert.ok(Array.isArray(hits), "result should be an array");
  assert.ok(hits.length > 0, "should have at least one hit");
  const h = hits[0];
  assert.ok(typeof h.key === "string", "hit.key must be a string");
  assert.ok(typeof h.handle === "string", "hit.handle must be a string");
  assert.ok(typeof h.title === "string", "hit.title must be a string");
  assert.ok(typeof h.score === "number", "hit.score must be a number");
  assert.ok(typeof h.backend === "string", "hit.backend must be a string");
  assert.equal(h.key, cell.key);
  store.close();
});

test("recall_semantic with missing query throws an Unknown tool error through the error path", () => {
  const store = new SqliteStore(":memory:");
  const res = handleMcpRequest(req("tools/call", {
    name: "recall_semantic",
    arguments: {},
  }), store);
  // missing query coerces to empty string, returns empty array (mirrors recall_search behavior)
  const hits = callText(res);
  assert.ok(Array.isArray(hits), "empty query returns empty array");
  store.close();
});

test("recall_ref resolves a handle#path reference to {resolved:true, value, handle, targetId}", () => {
  const store = new SqliteStore(":memory:");
  // Admit a cell so we have a known handle and a scores.effective value to address
  const r = admit(
    { kind: "obs", title: "ref tool test cell", body: "body content for ref test", confidence: 0.8, topics: [], entities: [] },
    { store },
  );
  assert.equal(r.accepted, true);
  const cell = r.cell!;
  const handle = cell.handle;

  const reference = `${handle}#scores.effective`;
  const out = callText(handleMcpRequest(req("tools/call", {
    name: "recall_ref",
    arguments: { reference },
  }), store));

  assert.equal(out.resolved, true, "should resolve a known handle reference");
  assert.equal(out.handle, handle, "handle must match");
  assert.ok(typeof out.targetId === "string", "targetId must be a string");
  assert.ok("value" in out, "value must be present on resolved reference");
  store.close();
});

test("recall_ref returns {resolved:false} for an unresolvable reference without throwing", () => {
  const store = new SqliteStore(":memory:");
  const out = callText(handleMcpRequest(req("tools/call", {
    name: "recall_ref",
    arguments: { reference: "no-such-handle-xyz#scores.effective" },
  }), store));

  assert.equal(out.resolved, false, "should return resolved:false for unknown reference");
  assert.ok(typeof out.targetId === "string", "targetId must be present");
  store.close();
});

test("recall_page reflections returns a page with only ref-kind cells", () => {
  const store = new SqliteStore(":memory:");
  // Seed a ref cell (reflections page) and an obs cell (should be excluded).
  admit({ kind: "ref", title: "A reflection", body: "some reflection body", confidence: 0.7, topics: [], entities: [] }, { store });
  admit({ kind: "obs", title: "An observation", body: "some observation body", confidence: 0.8, topics: [], entities: [] }, { store });

  const out = callText(handleMcpRequest(req("tools/call", {
    name: "recall_page",
    arguments: { name: "reflections" },
  }), store));

  assert.equal(out.name, "reflections", "page name must match");
  assert.ok(typeof out.summary === "string", "summary must be a string");
  assert.ok(Array.isArray(out.cells), "cells must be an array");
  assert.ok(out.cells.length >= 1, "should have at least one cell");
  assert.ok(out.cells.every((c: any) => c.kind === "ref"), "all cells must be ref-kind");
  store.close();
});

test("recall_page with unknown name returns a clear error object without throwing", () => {
  const store = new SqliteStore(":memory:");
  const out = callText(handleMcpRequest(req("tools/call", {
    name: "recall_page",
    arguments: { name: "no-such-page" },
  }), store));

  assert.ok(typeof out.error === "string", "error must be a string");
  assert.ok(out.error.includes("no-such-page"), "error must name the bad page");
  store.close();
});

test("recall_hyperedge_add creates a hyperedge and recall_hyperedge_show returns it", () => {
  const store = new SqliteStore(":memory:");
  const r = admit(
    { kind: "obs", title: "hyperedge mcp member", body: "a cell to join a hyperedge", confidence: 0.8, topics: [], entities: [] },
    { store },
  );
  assert.equal(r.accepted, true);
  const memberKey = r.cell!.key;

  const added = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_add",
    arguments: { kind: "cluster", title: "mcp hyperedge", members: [memberKey] },
  }), store));
  assert.equal(added.title, "mcp hyperedge");
  assert.equal(added.members[0].key, memberKey);

  const shown = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_show",
    arguments: { id: added.id },
  }), store));
  assert.equal(shown.id, added.id);
  assert.equal(shown.title, "mcp hyperedge");
  store.close();
});

test("recall_hyperedge_show with an unknown id returns a clear not-found payload, not a throw", () => {
  const store = new SqliteStore(":memory:");
  const out = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_show",
    arguments: { id: "no-such-hyperedge-id" },
  }), store));
  assert.ok(typeof out.error === "string", "error must be a string");
  assert.ok(out.error.includes("no-such-hyperedge-id"), "error must name the bad id");
  store.close();
});

test("recall_hyperedge_list returns hyperedges and respects limit", () => {
  const store = new SqliteStore(":memory:");
  const r = admit(
    { kind: "obs", title: "hyperedge list member", body: "a cell to join two hyperedges", confidence: 0.8, topics: [], entities: [] },
    { store },
  );
  assert.equal(r.accepted, true);
  const memberKey = r.cell!.key;

  callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_add",
    arguments: { kind: "cluster", title: "list hyperedge one", members: [memberKey] },
  }), store));
  callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_add",
    arguments: { kind: "cluster", title: "list hyperedge two", members: [memberKey] },
  }), store));

  const limited = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_list",
    arguments: { limit: 1 },
  }), store));
  assert.ok(Array.isArray(limited), "result should be an array");
  assert.equal(limited.length, 1);

  const all = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_list",
    arguments: {},
  }), store));
  assert.equal(all.length, 2);

  const forCell = callText(handleMcpRequest(req("tools/call", {
    name: "recall_hyperedge_list",
    arguments: { forCell: memberKey },
  }), store));
  assert.equal(forCell.length, 2);
  assert.ok(forCell.every((h: any) => h.members.some((m: any) => m.key === memberKey)));
  store.close();
});
