import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, TOOLS, type JsonRpcRequest } from "./mcp-server.js";
import { SqliteStore } from "./store.js";
import { WRITE_TEMPLATE } from "./template.js";

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

test("tools/list returns exactly the five lean tools", () => {
  const store = new SqliteStore(":memory:");
  const res = handleMcpRequest(req("tools/list"), store)?.result as any;
  assert.deepEqual(res.tools.map((t: any) => t.name), [
    "recall_status",
    "recall_search",
    "recall_compile",
    "recall_cell",
    "recall_write",
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

test("TOOLS is the five-tool surface", () => {
  assert.equal(TOOLS.length, 5);
});
