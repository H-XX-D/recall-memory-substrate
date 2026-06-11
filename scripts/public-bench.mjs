#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  SecretGraphStore,
  SQLiteRecallStore,
  admitWriteProposal,
  allocateWork,
  analyzeMemory,
  buildPageIndex,
  defaultEvalSuite,
  compileContext,
  formatContextPacket,
  inspectCell,
  getRecallPage,
  renderTui,
  runAcpExchange,
  runCognitiveTick,
  runDaemonOnce,
  runRecallEval,
  runOperatingCycle,
  storageStats
} from "../dist/src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(os.tmpdir(), "recall-public-bench-"));
const dbPath = join(tempRoot, "recall.sqlite3");
const seedCount = 250;
let store;
let secretsStore;

try {
  store = new SQLiteRecallStore(dbPath);
  seed(store, seedCount);

  const nodes = store.listNodes(3);
  const firstNode = nodes[0];
  const secondNode = nodes[1];
  const thirdNode = nodes[2];
  const rollbackEntry = store.listRollback(1)[0];
  store.enqueueAcpRequest({
    channel: "inbox",
    fromAgent: "agent:bench",
    toAgent: "recall-acp-manager",
    action: "search",
    payload: {
      query: "Benchmark item 42",
      limit: 5
    }
  });

  const overlay = store.addDagOverlay({
    title: "Public benchmark DAG",
    nodeIds: [firstNode.id, secondNode.id, thirdNode.id],
    edges: [
      { from: firstNode.id, to: secondNode.id },
      { from: secondNode.id, to: thirdNode.id }
    ],
    metadata: {
      purpose: "public-benchmark"
    }
  });
  secretsStore = new SecretGraphStore(join(tempRoot, "secrets.sqlite3"));
  const secretSave = secretsStore.save({
    title: "public-benchmark-secret",
    plaintext: "benchmark-secret-value",
    password: "correct horse battery staple",
    tags: ["public", "benchmark"],
    scope: "local"
  });

  const featureMatrix = [
    {
      feature: "addressable_cells",
      recall: "inspectCell resolves cell ids and address handles into structured field views.",
      competitorDocs: "No first-class equivalent surfaced in the public docs reviewed for Mem0, Zep, or Letta.",
      inference: true
    },
    {
      feature: "rollbackable_writes",
      recall: "Writes land with rollback journal entries and can be previewed or applied later.",
      competitorDocs: "Public docs reviewed emphasize memory edit/search flows, not a rollback journal.",
      inference: true
    },
    {
      feature: "acp_internal_manager",
      recall: "ACP exchanges route requests to an inside graph manager and return a processed response.",
      competitorDocs: "Public docs reviewed emphasize external memory APIs and agent memory blocks, not an internal graph-manager protocol.",
      inference: true
    },
    {
      feature: "operator_ledger",
      recall: "Mechanical runtime cycles persist a durable operator ledger separate from normal memory cells.",
      competitorDocs: "Not surfaced as a first-class public memory feature in the docs reviewed.",
      inference: true
    },
    {
      feature: "dag_holonomy",
      recall: "Optional DAG overlays can be analyzed into holonomy witnesses and concerns.",
      competitorDocs: "Not surfaced as a first-class memory primitive in the docs reviewed.",
      inference: true
    },
    {
      feature: "workflow_allocator",
      recall: "Recall can score and allocate work candidates, then optionally admit the allocation plan.",
      competitorDocs: "Public docs reviewed focus on memory retrieval/editing, not attention allocation over work candidates.",
      inference: true
    },
    {
      feature: "page_views",
      recall: "Recall has page-oriented graph views for index, witnesses, workbench, objectives, handoffs, and ACP state.",
      competitorDocs: "Public docs reviewed emphasize memory records and retrieval, not graph pages with operational metrics.",
      inference: true
    },
    {
      feature: "tui_rendering",
      recall: "Recall renders an operator TUI over the live graph, rollback journal, operator runs, and ACP queue.",
      competitorDocs: "Public docs reviewed do not surface a comparable built-in terminal TUI for the memory graph.",
      inference: true
    },
    {
      feature: "secret_side_graph",
      recall: "Recall stores encrypted secrets in a separate side graph with explicit save semantics.",
      competitorDocs: "Public docs reviewed emphasize memory stores and chat history; explicit encrypted secret side-graph handling is not surfaced as a core memory primitive.",
      inference: true
    },
    {
      feature: "eval_execution",
      recall: "Recall can run eval suites against the live graph and persist eval runs.",
      competitorDocs: "Public docs reviewed discuss evaluation-like capabilities, but not the same persisted graph-native eval surface.",
      inference: true
    },
    {
      feature: "memory_health_analysis",
      recall: "Recall continuously analyzes belief pressure, stale memory, contradictions, provenance, and curiosity targets.",
      competitorDocs: "Public docs reviewed emphasize memory retrieval and memory editing, but not the same graph-native health analysis report.",
      inference: true
    },
    {
      feature: "cognitive_tick",
      recall: "Recall has a structured cognitive tick that turns graph state into a planner report and optional maintenance write.",
      competitorDocs: "Public docs reviewed emphasize agent memory management, but not this full tick/report loop.",
      inference: true
    },
    {
      feature: "daemon_maintenance",
      recall: "Recall runs outside-LLM daemon maintenance with lease control and scheduled closure work.",
      competitorDocs: "Public docs reviewed mention background or consolidation behavior, but not the same leased runtime maintenance loop.",
      inference: true
    },
    {
      feature: "storage_telemetry",
      recall: "Recall exposes storage stats and average cell footprint over the live graph database.",
      competitorDocs: "Public docs reviewed focus on memory APIs and retrieval; storage telemetry is not a core surfaced primitive there.",
      inference: true
    }
  ];

  const result = {
    benchmark: "Recall Public Benchmark",
    version: "v1",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      memoryGiB: round(os.totalmem() / 1024 / 1024 / 1024, 2)
    },
    corpus: {
      seedCount,
      nodes: store.stats().nodes,
      rollbackEntries: store.stats().rollbackEntries,
      acpRequests: store.stats().acpRequests,
      dagOverlays: store.stats().dagOverlays,
      secretNodes: secretsStore.stats().secretNodes,
      storage: storageStats(store)
    },
    benchmarkSurface: {
      admit_write: benchmark("admit_write", 50, 5, () => {
        const proposal = makeProposal(store.stats().nodes);
        return admitWriteProposal(proposal, store);
      }),
      search: benchmark("search", 200, 20, () => store.search("Benchmark item 42", 20)),
      semantic_search: benchmark("semantic_search", 100, 10, () => store.semanticSearch("Benchmark item 42", 20)),
      compile_context: benchmark("compile_context", 100, 10, () => formatContextPacket(compileContext(store, {
        task: "Benchmark item 42",
        budgetWords: 220,
        inlineReferenceValues: false,
        includeReferenceParameters: false
      }))),
      addressable_cell_expand: benchmark("addressable_cell_expand", 200, 20, () => inspectCell(store, firstNode.cellAddress)),
      page_index: benchmark("page_index", 200, 20, () => buildPageIndex(store)),
      page_witnesses: benchmark("page_witnesses", 200, 20, () => getRecallPage(store, "witnesses", { project: "Recall", limit: 10 })),
      tui_render: benchmark("tui_render", 100, 10, () => renderTui(store)),
      memory_health: benchmark("memory_health", 100, 10, () => analyzeMemory(store)),
      cognitive_tick: benchmark("cognitive_tick", 100, 10, () => runCognitiveTick(store, new Date(), false)),
      rollback_preview: benchmark("rollback_preview", 200, 20, () => store.applyRollback(rollbackEntry.id, false)),
      dag_analysis: benchmark("dag_analysis", 100, 10, () => store.analyzeDagOverlay(overlay.id)),
      eval_run: benchmark("eval_run", 50, 5, () => runRecallEval(store, defaultEvalSuite())),
      workflow_allocate: benchmark("workflow_allocate", 200, 20, () => allocateWork([
        {
          id: "docs",
          title: "Polish install docs",
          impact: 0.4,
          uncertainty: 0.2,
          concern: 0.2,
          dependencyWeight: 0.2,
          cost: 0.3,
          reversibility: 0.9
        },
        {
          id: "runtime",
          title: "Verify runtime memory health",
          impact: 0.9,
          uncertainty: 0.8,
          concern: 0.8,
          dependencyWeight: 0.9,
          cost: 0.4,
          reversibility: 0.7,
          novelty: 0.5
        }
      ], 1)),
      acp_exchange: benchmark("acp_exchange", 100, 10, () => runAcpExchange(store, {
        fromAgent: "agent:bench",
        toAgent: "recall-acp-manager",
        action: "search",
        payload: {
          query: "Benchmark item 42",
          limit: 5
        }
      }, new Date(), {
        manager: "recall-acp-manager",
        toAgent: "recall-acp-manager"
      })),
      secret_save: benchmark("secret_save", 100, 10, () => secretsStore.save({
        title: "public-benchmark-secret",
        plaintext: "benchmark-secret-value",
        password: "correct horse battery staple",
        tags: ["public", "benchmark"],
        scope: "local"
      })),
      secret_get: benchmark("secret_get", 100, 10, () => secretsStore.get(secretSave.id, "correct horse battery staple")),
      secret_list: benchmark("secret_list", 200, 20, () => secretsStore.list(10)),
      storage_stats: benchmark("storage_stats", 200, 20, () => storageStats(store)),
      daemon_run_once: benchmark("daemon_run_once", 10, 2, () => runDaemonOnce(store, new Date(), { derive: false })),
      operate_once: benchmark("operate_once", 10, 2, () => runOperatingCycle(store, new Date(), {
        derive: false,
        semanticReindex: true,
        evalClosure: false,
        cognitiveTick: false,
        daemonMaintenance: false,
        compact: false,
        lease: { owner: "recall-public-bench" }
      }))
    },
    featureMatrix
  };

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  printSummary(result);
} finally {
  try {
    store?.close();
  } catch {}
  try {
    secretsStore?.close();
  } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}

function seed(store, count) {
  for (let index = 0; index < count; index += 1) {
    admitWriteProposal(makeProposal(index), store);
  }
}

function makeProposal(index) {
  return {
    schema_version: "recall.write.v1",
    actor: {
      kind: "llm",
      id: "benchmark-agent",
      display: "Benchmark Agent"
    },
    intent: {
      kind: "observation",
      operation: "create"
    },
    content: {
      title: `Benchmark item ${index}`,
      body: `Benchmark body ${index} for Recall active-memory runtime measurement.`,
      summary: `Benchmark item ${index} summary.`
    },
    scope: {
      project: "Recall",
      path: repoRoot,
      tenant: "local"
    },
    tags: {
      category: ["memory"],
      type: ["observation"],
      subject: ["benchmark"],
      project: ["Recall"],
      idea: ["benchmark"],
      timestamp: ["2026-05-22"],
      topics: ["benchmark", "memory"],
      entities: ["Recall"],
      identities: ["agent:benchmark"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["source-grounded"],
      sensitivity: ["public"],
      permission: ["read"]
    },
    evidence: {
      source_refs: ["scripts/public-bench.mjs"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      value: 0.82,
      uncertainty: 0.12,
      concern: 0.08,
      source_quality: "medium",
      stability: "stable"
    },
    provenance: {
      created_at: new Date().toISOString(),
      origin: "llm",
      produced_by: "benchmark",
      verification: "checked",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "public",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: null
    }
  };
}

function benchmark(name, iterations, warmups, fn) {
  for (let i = 0; i < warmups; i += 1) {
    fn();
  }

  const samples = [];
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const sampleStart = performance.now();
    fn();
    samples.push(performance.now() - sampleStart);
  }
  const totalMs = performance.now() - startedAt;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations,
    warmups,
    totalMs: round(totalMs, 3),
    avgMs: round(totalMs / iterations, 3),
    p50Ms: round(percentile(sorted, 0.5), 3),
    p95Ms: round(percentile(sorted, 0.95), 3),
    opsPerSec: round((iterations / totalMs) * 1000, 2)
  };
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printSummary(result) {
  const rows = Object.entries(result.benchmarkSurface).map(([name, stats]) => ({
    name,
    avgMs: stats.avgMs,
    p95Ms: stats.p95Ms,
    opsPerSec: stats.opsPerSec
  }));
  console.log("Benchmark summary:");
  for (const row of rows) {
    console.log(`${row.name}: avg ${row.avgMs} ms, p95 ${row.p95Ms} ms, ${row.opsPerSec} ops/sec`);
  }
}
