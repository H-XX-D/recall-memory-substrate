import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { tempDbPath } from "./helpers.js";

test("MCP suppresses responses for notifications and invalid null ids", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    assert.equal(
      handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, store),
      undefined
    );
    assert.equal(handleMcpRequest({ jsonrpc: "2.0", method: "missing/notification" }, store), undefined);
    assert.equal(handleMcpRequest({ jsonrpc: "2.0", id: null, method: "initialize", params: {} }, store), undefined);

    const response = handleMcpRequest({ jsonrpc: "2.0", id: "req-1", method: "tools/list" }, store);
    assert.equal(response.id, "req-1");
    assert.equal(response.error, undefined);
    assert.equal(Boolean(response.result), true);
  } finally {
    store.close();
    temp.cleanup();
  }
});
