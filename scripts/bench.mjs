#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { admitWriteProposal, compileContext, formatContextPacket, runAcpExchange, runOperatingCycle, SQLiteRecallStore } from "../dist/src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(os.tmpdir(), "recall-bench-"));
const dbPath = join(tempRoot, "recall.sqlite3");
const seedCount = 250;
let seedStore;
let admissionStore;

try {
  seedStore = new SQLiteRecallStore(dbPath);
  seed(seedStore, seedCount);

  admissionStore = new SQLiteRecallStore(join(tempRoot, "admission.sqlite3"));
  const admission = benchmark("admit_write", 50, 5, () => {
    const index = admissionStore.stats().nodes;
    const proposal = makeProposal(index);
    return admitWriteProposal(proposal, admissionStore);
  });
  admissionStore.close();
  admissionStore = undefined;

  const search = benchmark("search", 200, 20, () => seedStore.search("Benchmark item 42", 20));
  const semantic = benchmark("semantic_search", 100, 10, () => seedStore.semanticSearch("Benchmark item 42", 20));
  const compile = benchmark("compile_context", 100, 10, () => {
    const packet = compileContext(seedStore, {
      task: "Benchmark item 42",
      budgetWords: 220,
      inlineReferenceValues: false,
      includeReferenceParameters: false
    });
    return formatContextPacket(packet);
  });
  const acpExchange = benchmark("acp_exchange", 100, 10, () => runAcpExchange(seedStore, {
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
  }));
  const operatingCycle = benchmark("operate_once", 10, 2, () => runOperatingCycle(seedStore, new Date(), {
    derive: false,
    semanticReindex: true,
    evalClosure: false,
    cognitiveTick: false,
    daemonMaintenance: false,
    compact: false,
    lease: { owner: "recall-bench" }
  }));

  const result = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      memoryGiB: round(os.totalmem() / 1024 / 1024 / 1024, 2)
    },
    seedCount,
    storeStats: seedStore.stats(),
    benchmarks: {
      admit_write: admission,
      search,
      semantic_search: semantic,
      compile_context: compile,
      acp_exchange: acpExchange,
      operate_once: operatingCycle
    }
  };

  console.log(JSON.stringify(result, null, 2));
  console.log("");
  printSummary(result);
} finally {
  try {
    admissionStore?.close();
  } catch {}
  try {
    seedStore?.close();
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
      source_refs: ["scripts/bench.mjs"],
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
  const rows = Object.entries(result.benchmarks).map(([name, stats]) => ({
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
