import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { runDaemonOnce } from "../src/core/daemon.js";
import { acquireDaemonLease, releaseDaemonLease } from "../src/core/daemon-scheduler.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("daemon, semantic search, subgraphs, and MCP", () => {
  it("runs daemon maintenance outside the LLM through the same admission path", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = runDaemonOnce(store);

      assert.equal(result.status, "ran");
      assert.equal(result.result.accepted, true);
      assert.equal(store.stats().nodes, 1);
      assert.equal(store.search("Daemon maintenance pass").filter((node) => node.title === "Daemon maintenance pass").length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("can run daemon closure derivations through admission", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const result = runDaemonOnce(store, new Date("2026-05-21T19:00:00.000Z"), { derive: true });

      assert.equal(result.status, "ran");
      assert.equal(result.result.accepted, true);
      assert.equal(result.evalClosure?.derived[0]?.accepted, true);
      assert.equal(result.semanticReindex?.backend, "hash:v1");
      assert.equal(store.subgraph({ category: ["derivation"], type: ["eval_run"] }).length >= 1, true);
      assert.equal(store.search("Daemon maintenance pass").filter((node) => node.title === "Daemon maintenance pass").length, 1);

      const statsAfterFirstRun = store.stats();
      const duplicate = runDaemonOnce(store, new Date("2026-05-21T19:05:00.000Z"), { derive: true });
      assert.equal(duplicate.result.accepted, false);
      assert.equal(duplicate.result.issues[0]?.code, "daemon_schedule_skipped");
      assert.equal(duplicate.evalClosure, undefined);
      assert.equal(duplicate.schedule?.skipped.includes("maintenance_observation_already_admitted"), true);
      assert.equal(duplicate.schedule?.skipped.includes("eval_closure_already_admitted"), true);
      assert.deepEqual(store.stats(), statsAfterFirstRun);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("skips derive-mode daemon work when an active lease exists", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    const now = new Date("2026-05-21T19:00:00.000Z");
    const activeLease = acquireDaemonLease(temp.path, now, { owner: "test-active-owner" });
    assert.equal(activeLease.status, "acquired");

    try {
      const result = runDaemonOnce(store, now, { derive: true });

      assert.equal(result.status, "skipped");
      assert.equal(result.result.accepted, false);
      assert.equal(result.result.issues[0]?.code, "daemon_lease_active");
      assert.equal(result.result.issues[0]?.path, "daemon.lease");
      assert.equal(result.lease?.owner, "test-active-owner");
      assert.deepEqual(store.stats(), {
        nodes: 0,
        relations: 0,
        rollbackEntries: 0,
        hyperedges: 0,
        programs: 0,
        dagOverlays: 0,
        evalRuns: 0
      });
    } finally {
      releaseDaemonLease(activeLease);
      store.close();
      temp.cleanup();
    }
  });

  it("skips non-derive daemon maintenance when an active lease exists", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    const now = new Date("2026-05-21T19:00:00.000Z");
    const activeLease = acquireDaemonLease(temp.path, now, { owner: "test-active-owner" });
    assert.equal(activeLease.status, "acquired");

    try {
      const result = runDaemonOnce(store, now);

      assert.equal(result.status, "skipped");
      assert.equal(result.result.accepted, false);
      assert.equal(result.result.issues[0]?.code, "daemon_lease_active");
      assert.equal(store.stats().nodes, 0);
    } finally {
      releaseDaemonLease(activeLease);
      store.close();
      temp.cleanup();
    }
  });

  it("reacquires an expired derive-mode daemon lease", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    const activeAt = new Date("2026-05-21T19:00:00.000Z");
    const runAt = new Date("2026-05-21T19:00:00.002Z");
    const expiredLease = acquireDaemonLease(temp.path, activeAt, { owner: "test-expired-owner", ttlMs: 1 });
    assert.equal(expiredLease.status, "acquired");

    try {
      const result = runDaemonOnce(store, runAt, { derive: true, lease: { owner: "test-reacquired-owner" } });

      assert.equal(result.status, "ran");
      assert.equal(result.result.accepted, true);
      assert.equal(result.lease?.owner, "test-reacquired-owner");
      assert.equal(result.evalClosure?.derived[0]?.accepted, true);
      assert.equal(store.search("Daemon maintenance pass").filter((node) => node.title === "Daemon maintenance pass").length, 1);
    } finally {
      releaseDaemonLease(expiredLease);
      store.close();
      temp.cleanup();
    }
  });

  it("returns semantic hits and identity-composed subgraphs", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Semantic compiler memory",
            body: "The compiler builds compact packets from graph evidence."
          },
          tags: {
            category: ["memory"],
            type: ["witness"],
            subject: ["compiler"],
            project: ["Recall"],
            idea: ["context-packet"],
            timestamp: ["2026-05-21"],
            topics: ["compiler", "memory"],
            entities: ["Recall"],
            identities: ["agent:codex", "project:recall"],
            rings: ["runtime"],
            lifecycle: ["active"],
            quality: ["source-grounded"]
          }
        }),
        store
      );

      assert.equal(store.semanticSearch("compact evidence packet", 5).length, 1);
      assert.equal(
        store.subgraph({
          category: ["memory"],
          type: ["witness"],
          subject: ["compiler"],
          project: ["Recall"],
          idea: ["context-packet"],
          timestamp: ["2026-05-21"],
          topics: ["compiler"],
          identities: ["agent:codex"],
          rings: ["runtime"]
        }).length,
        1
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("exposes status and semantic tools through the lightweight MCP handler", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const list = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, store);
      assert.equal(Boolean(list.result), true);

      const semantic = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "recall_semantic",
            arguments: {
              query: "structured memory"
            }
          }
        },
        store
      );

      assert.equal(Boolean(semantic.result), true);
      assert.equal(semantic.error, undefined);

      const subgraph = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "recall_subgraph",
            arguments: {
              category: ["memory"],
              subject: ["schema"],
              project: ["Recall"],
              timestamp: ["2026-05-21"]
            }
          }
        },
        store
      );

      assert.equal(Boolean(subgraph.result), true);
      assert.equal(subgraph.error, undefined);

      const write = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "recall_write",
            arguments: {
              proposal: makeProposal({
                content: {
                  title: "LLM managed memory write",
                  body: "The LLM writes routine memory through MCP admission, not through user manual entry."
                },
                tags: {
                  subject: ["llm-managed-memory"],
                  idea: ["seamless-memory-write"]
                }
              })
            }
          }
        },
        store
      );

      assert.equal(Boolean(write.result), true);
      assert.equal(write.error, undefined);
      assert.equal(
        store.search("LLM managed memory write").some((node) => node.title === "LLM managed memory write"),
        true
      );

      const baseNode = store.search("Recall schema initialized")[0]!;
      const hyperedge = store.addHyperedge({
        kind: "derived_from",
        title: "MCP derivation edge",
        members: [{ nodeId: baseNode.id, role: "source" }]
      });
      const program = store.attachProgram(hyperedge.id, {
        schemaVersion: "recall.program.v1",
        operation: "emit_witness"
      });
      const programRun = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "recall_program_run",
            arguments: {
              programId: program.id,
              derive: true
            }
          }
        },
        store
      );

      assert.equal(programRun.error, undefined);
      assert.equal(store.subgraph({ category: ["derivation"], type: ["program_run"] }).length, 1);

      const programList = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "recall_program_list",
            arguments: {}
          }
        },
        store
      );
      assert.equal(programList.error, undefined);

      const evalRun = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "recall_eval_run",
            arguments: {
              derive: true
            }
          }
        },
        store
      );

      assert.equal(evalRun.error, undefined);
      assert.equal(store.subgraph({ category: ["derivation"], type: ["eval_run"] }).length, 1);

      const evalList = handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "recall_eval_list",
            arguments: {}
          }
        },
        store
      );
      assert.equal(evalList.error, undefined);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
