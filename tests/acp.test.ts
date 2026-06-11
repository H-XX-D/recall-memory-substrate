import assert from "node:assert/strict";
import { test } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { enqueueAcpRequest, runAcpCycle } from "../src/core/acp.js";
import { buildPageIndex, getRecallPage } from "../src/core/pages.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { makeProposal, tempDbPath } from "./helpers.js";

test("ACP queue processes requests from the internal manager", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const admitted = admitWriteProposal(
      makeProposal({
        content: {
          title: "ACP seed memory",
          body: "The ACP manager should be able to inspect and act on graph state from inside the runtime.",
          summary: "ACP seed memory exists."
        },
        tags: {
          subject: ["acp"],
          idea: ["internal-agent-manager"]
        }
      }),
      store
    );
    assert.equal(admitted.accepted, true);

    const searchRequest = enqueueAcpRequest(store, {
      fromAgent: "agent:codex",
      toAgent: "recall-acp-manager",
      action: "search",
      payload: {
        query: "ACP seed memory",
        limit: 5
      }
    });
    const writeRequest = enqueueAcpRequest(store, {
      fromAgent: "agent:codex",
      toAgent: "recall-acp-manager",
      action: "write",
      payload: {
        proposal: makeProposal({
          content: {
            title: "ACP write response",
            body: "The ACP manager can close a graph write from inside the system.",
            summary: "ACP write response exists."
          },
          tags: {
            subject: ["acp"],
            idea: ["write-response"]
          }
        })
      }
    });

    const cycle = runAcpCycle(store, new Date("2026-05-22T12:00:00.000Z"), {
      manager: "recall-acp-manager",
      toAgent: "recall-acp-manager",
      limit: 10
    });

    assert.equal(cycle.queued, 2);
    assert.equal(cycle.completed, 2);
    assert.equal(cycle.failed, 0);
    assert.equal(store.listAcpRequests().every((request) => request.status === "completed"), true);

    const searchResult = store.getAcpRequest(searchRequest.id);
    assert.equal(searchResult?.response && Array.isArray(searchResult.response.results), true);
    assert.equal((searchResult?.response?.results as unknown[]).length >= 1, true);

    const writeResult = store.getAcpRequest(writeRequest.id);
    const writeResponse = writeResult?.response as { result?: { accepted?: boolean } } | null;
    assert.equal(writeResponse?.result?.accepted === true, true);
    assert.equal(store.stats().nodes >= 2, true);

    const pageIndex = buildPageIndex(store);
    assert.equal(pageIndex.pages.some((page) => page.name === "acp-queue"), true);
    assert.equal(pageIndex.pages.some((page) => page.name === "acp-manager"), true);
    const queuePage = getRecallPage(store, "acp-queue");
    const queueMetrics = queuePage.metrics as { byStatus: Record<string, number> };
    assert.equal((queueMetrics.byStatus.completed ?? 0) >= 2, true);
    const managerPage = getRecallPage(store, "acp-manager");
    const managerMetrics = managerPage.metrics as { identity: string; manager: string };
    assert.equal(managerMetrics.identity, "agent:acp-manager");
    assert.equal(managerMetrics.manager, "recall-acp-manager");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("MCP exposes ACP tools for internal agent communication", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const toolList = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, store);
    assert.equal(toolList.error, undefined);
    const tools = (toolList.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    assert.equal(tools.includes("recall_acp_status"), true);
    assert.equal(tools.includes("recall_acp_send"), true);
    assert.equal(tools.includes("recall_acp_list"), true);
    assert.equal(tools.includes("recall_acp_show"), true);
    assert.equal(tools.includes("recall_acp_process"), true);
    assert.equal(tools.includes("recall_acp_exchange"), true);

    const status = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "recall_acp_status",
          arguments: {}
        }
      },
      store
    );
    assert.equal(status.error, undefined);

    const send = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "recall_acp_send",
          arguments: {
            request: {
              fromAgent: "agent:mcp",
              toAgent: "recall-acp-manager",
              action: "status",
              payload: {}
            }
          }
        }
      },
      store
    );
    assert.equal(send.error, undefined);
    const sendText = mcpText(send);
    const sendJson = JSON.parse(sendText) as { request: { id: string } };

    const process = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "recall_acp_process",
          arguments: {
            manager: "recall-acp-manager",
            toAgent: "recall-acp-manager",
            limit: 5
          }
        }
      },
      store
    );
    assert.equal(process.error, undefined);

    const exchange = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "recall_acp_exchange",
          arguments: {
            manager: "recall-acp-manager",
            toAgent: "recall-acp-manager",
            request: {
              fromAgent: "agent:mcp",
              toAgent: "recall-acp-manager",
              action: "search",
              payload: {
                query: "ACP seed memory",
                limit: 5
              }
            }
          }
        }
      },
      store
    );
    assert.equal(exchange.error, undefined);
    const exchangeJson = JSON.parse(mcpText(exchange)) as { request: { id: string; status: string }; response?: { results?: unknown[] } };
    assert.equal(exchangeJson.request.status, "completed");
    assert.equal(Array.isArray(exchangeJson.response?.results), true);

    const list = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "recall_acp_list",
          arguments: {
            status: "completed",
            limit: 5
          }
        }
      },
      store
    );
    assert.equal(list.error, undefined);
    const listJson = JSON.parse(mcpText(list)) as { requests: { id: string }[] };
    assert.equal(listJson.requests.some((request) => request.id === sendJson.request.id), true);
    assert.equal(listJson.requests.some((request) => request.id === exchangeJson.request.id), true);

    const show = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "recall_acp_show",
          arguments: {
            requestId: exchangeJson.request.id
          }
        }
      },
      store
    );
    assert.equal(show.error, undefined);
    const showJson = JSON.parse(mcpText(show)) as { id: string; status: string };
    assert.equal(showJson.id, exchangeJson.request.id);
    assert.equal(showJson.status, "completed");
  } finally {
    store.close();
    temp.cleanup();
  }
});

function mcpText(response: { result?: unknown }): string {
  const content = response.result as { content?: { text: string }[] } | undefined;
  return content?.content?.[0]?.text ?? "";
}
