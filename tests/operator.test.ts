import assert from "node:assert/strict";
import { test } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { acquireDaemonLease, releaseDaemonLease } from "../src/core/daemon-scheduler.js";
import { runOperatingCycle } from "../src/core/operator.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { makeProposal, tempDbPath } from "./helpers.js";

test("operator cycle orchestrates mechanical runtime phases with closure and postflight reporting", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const admitted = admitWriteProposal(
      makeProposal({
        content: {
          title: "Operator cycle seed memory",
          body: "The mechanical operator should see this seed memory during eval, tick, and daemon phases.",
          summary: "Operator seed memory exists."
        },
        tags: {
          subject: ["operator"],
          idea: ["mechanical-cycle"]
        }
      }),
      store
    );
    assert.equal(admitted.accepted, true);

    const result = runOperatingCycle(store, new Date("2026-05-22T12:00:00.000Z"), {
      derive: true,
      compact: true,
      lease: {
        owner: "operator-test"
      }
    });

    assert.equal(result.status, "ran");
    assert.equal(result.phases.map((phase) => phase.name).join(","), "preflight,semantic_reindex,eval_closure,daemon_maintenance,cognitive_tick,compaction,postflight");
    assert.equal(result.phases.every((phase) => phase.status === "completed"), true);
    assert.equal(result.preflight?.stats.nodes, 1);
    assert.equal((result.postflight?.stats.nodes ?? 0) > result.preflight!.stats.nodes, true);
    assert.equal(result.writes.accepted >= 2, true);
    assert.equal(result.writes.rejected, 0);
    assert.match(result.summary, /Operator cycle completed/);
    assert.equal(typeof result.ledger?.id, "string");
    assert.equal(result.ledger?.status, "ran");
    const storedRun = store.getOperatorRun(result.ledger!.id);
    assert.equal(storedRun?.summary, result.summary);
    assert.equal(storedRun?.status, "ran");
    assert.equal(storedRun?.result.summary, result.summary);
    assert.equal(result.recommendations.length >= 1, true);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["eval_run"] }).length >= 1, true);

    // id-prefix resolution for eval/operator run lookups (regression): a unique
    // truncated id must resolve, matching program/hyperedge/program-run lookups.
    const evalRunId = store.listEvalRuns(1)[0]?.id;
    assert.ok(evalRunId, "eval closure recorded an eval run");
    assert.equal(store.getEvalRun(evalRunId.slice(0, 8))?.id, evalRunId, "eval run resolves by id-prefix");
    assert.equal(store.getOperatorRun(result.ledger!.id.slice(0, 8))?.id, result.ledger!.id, "operator run resolves by id-prefix");
    assert.equal(store.getEvalRun("ffffffff"), null, "non-matching prefix stays null");

    const followUp = runOperatingCycle(store, new Date("2026-05-22T12:05:00.000Z"), {
      derive: true,
      semanticReindex: false,
      evalClosure: false,
      cognitiveTick: false,
      daemonMaintenance: false,
      lease: {
        owner: "operator-test-follow-up"
      }
    });
    assert.equal(followUp.status, "ran");
    assert.equal(followUp.phases.some((phase) => phase.status === "skipped"), true);
    assert.equal(store.listOperatorRuns().length, 2);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("operator cycle respects its lease", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  const now = new Date("2026-05-22T12:00:00.000Z");
  const lease = acquireDaemonLease(temp.path, now, {
    name: "recall-operator",
    owner: "active-operator-test"
  });
  assert.equal(lease.status, "acquired");

  try {
    const result = runOperatingCycle(store, now, {
      lease: {
        owner: "blocked-operator-test"
      }
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.result?.accepted, false);
    assert.equal(result.result?.issues[0]?.code, "operator_lease_active");
    assert.equal(result.phases[0]?.name, "lease");
    assert.equal(result.ledger?.status, "skipped");
    assert.equal(store.listOperatorRuns().length, 1);
    assert.equal(store.stats().nodes, 0);
  } finally {
    releaseDaemonLease(lease);
    store.close();
    temp.cleanup();
  }
});

test("MCP exposes the operator cycle as a single mechanical tool", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    admitWriteProposal(makeProposal(), store);
    const response = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "recall_operate_once",
          arguments: {
            derive: false,
            semanticReindex: true,
            evalClosure: true,
            cognitiveTick: false,
            daemonMaintenance: false
          }
        }
      },
      store
    );

    assert.equal(response.error, undefined);
    const text = (response.result as { content: { text: string }[] }).content[0]!.text;
    const parsed = JSON.parse(text) as { status: string; phases: { name: string }[]; ledger: { id: string } };
    assert.equal(parsed.status, "ran");
    assert.equal(parsed.phases.some((phase) => phase.name === "semantic_reindex"), true);
    assert.equal(parsed.phases.some((phase) => phase.name === "eval_closure"), true);

    const listResponse = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "recall_operate_list",
          arguments: {
            limit: 5
          }
        }
      },
      store
    );
    assert.equal(listResponse.error, undefined);
    const listText = (listResponse.result as { content: { text: string }[] }).content[0]!.text;
    const listParsed = JSON.parse(listText) as { runs: { id: string }[] };
    assert.equal(listParsed.runs.some((run) => run.id === parsed.ledger.id), true);

    const showResponse = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "recall_operate_show",
          arguments: {
            runId: parsed.ledger.id
          }
        }
      },
      store
    );
    assert.equal(showResponse.error, undefined);
    const showText = (showResponse.result as { content: { text: string }[] }).content[0]!.text;
    const showParsed = JSON.parse(showText) as { id: string; result: { status: string } };
    assert.equal(showParsed.id, parsed.ledger.id);
    assert.equal(showParsed.result.status, "ran");
  } finally {
    store.close();
    temp.cleanup();
  }
});
