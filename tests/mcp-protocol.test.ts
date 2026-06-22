import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("MCP initialize reports package version and tools/list keeps the public contract stable", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const init = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, store);
    assert.equal(init?.error, undefined);
    assert.equal((init?.result as { serverInfo: { version: string } }).serverInfo.version, pkg.version);

    const response = handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, store);
    const tools = ((response?.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    assert.deepEqual(tools, [
      "recall_status",
      "recall_acp_status",
      "recall_storage",
      "recall_compact",
      "recall_beliefs",
      "recall_maintenance",
      "recall_trust",
      "recall_tick",
      "recall_acp_send",
      "recall_acp_list",
      "recall_acp_show",
      "recall_acp_process",
      "recall_acp_exchange",
      "recall_operate_once",
      "recall_operate_list",
      "recall_operate_show",
      "recall_page",
      "recall_cell",
      "recall_search",
      "recall_semantic",
      "recall_compile",
      "recall_subgraph",
      "recall_write",
      "recall_workflow_allocate",
      "recall_blind_lock",
      "recall_hyperedge_add",
      "recall_hyperedge_show",
      "recall_hyperedge_list",
      "recall_program_add",
      "recall_program_show",
      "recall_program_list",
      "recall_program_run",
      "recall_program_runs",
      "recall_program_run_show",
      "recall_dag_add",
      "recall_dag_show",
      "recall_dag_list",
      "recall_dag_analyze",
      "recall_eval_run",
      "recall_eval_list",
      "recall_eval_show",
      "recall_daemon_run_once",
      "recall_project_register",
      "recall_project_list",
      "recall_project_where"
    ]);
  } finally {
    store.close();
    temp.cleanup();
  }
});
