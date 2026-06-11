import { analyzeMemory, type MemoryHealthReport } from "./analysis.js";
import { runCognitiveTick, type CognitiveTickResult } from "./cognitive.js";
import { runDaemonOnce, type DaemonRunResult } from "./daemon.js";
import {
  acquireDaemonLease,
  releaseDaemonLease,
  skippedAdmissionResult,
  type DaemonLeaseOptions
} from "./daemon-scheduler.js";
import { defaultEvalSuite, type RecallEvalResult } from "./evals.js";
import type { RecallStore } from "./store.js";
import { storageStats, type RecallStorageStats } from "./storage-stats.js";
import type { AdmissionResult, OperatorRun, StoreStats } from "./types.js";

export interface OperatingCycleOptions {
  derive?: boolean;
  semanticReindex?: boolean;
  evalClosure?: boolean;
  cognitiveTick?: boolean;
  daemonMaintenance?: boolean;
  compact?: boolean;
  lease?: DaemonLeaseOptions;
}

export interface OperatingCycleResult {
  status: "ran" | "skipped";
  createdAt: string;
  summary: string;
  options: Required<Omit<OperatingCycleOptions, "lease">>;
  lease?: OperatingLeaseReport;
  ledger?: OperatingLedgerReport;
  phases: OperatingPhase[];
  preflight?: OperatingSnapshot;
  postflight?: OperatingSnapshot;
  writes: OperatingWriteSummary;
  recommendations: string[];
  result?: AdmissionResult;
}

export interface OperatingLeaseReport {
  name: string;
  owner: string;
  expiresAt: string;
}

export interface OperatingLedgerReport {
  id: string;
  status: OperatorRun["status"];
  createdAt: string;
}

export interface OperatingSnapshot {
  stats: StoreStats;
  storage: Pick<RecallStorageStats, "databaseBytes" | "cells" | "relations" | "rollbackEntries" | "averageCell" | "maximumCell">;
  health: OperatingHealthSummary;
}

export interface OperatingHealthSummary {
  createdAt: string;
  nodes: number;
  relations: number;
  rollbackEntries: number;
  beliefs: number;
  stale: number;
  contradictions: number;
  criticalWarnings: number;
  topAction: string;
}

export interface OperatingPhase {
  name: string;
  status: "completed" | "skipped" | "failed";
  summary: string;
  metrics?: Record<string, unknown>;
  issues?: string[];
}

export interface OperatingWriteSummary {
  accepted: number;
  duplicate: number;
  rejected: number;
  nodeIds: string[];
  duplicateOf: string[];
  issueCodes: string[];
}

const DEFAULT_OPERATOR_LEASE_NAME = "recall-operator";
const DEFAULT_OPERATOR_LEASE_TTL_MS = 300_000;

export function runOperatingCycle(
  store: RecallStore,
  now = new Date(),
  options: OperatingCycleOptions = {}
): OperatingCycleResult {
  const effective = operatingOptions(options);
  const createdAt = now.toISOString();
  const phases: OperatingPhase[] = [];
  const writes: OperatingWriteSummary = {
    accepted: 0,
    duplicate: 0,
    rejected: 0,
    nodeIds: [],
    duplicateOf: [],
    issueCodes: []
  };

  const lease = acquireOperatorLease(store, now, options.lease);
  if (lease?.status === "blocked") {
    const result = skippedAdmissionResult(
      `operator lease is active until ${lease.expiresAt} for owner ${lease.owner}`,
      { path: "operator.lease", code: "operator_lease_active" }
    );
    recordAdmission(writes, result);
    return recordOperatorLedger(store, {
      status: "skipped",
      createdAt,
      summary: "Recall operator cycle skipped because another operator owns the lease.",
      options: effective,
      lease: {
        name: lease.name,
        owner: lease.owner,
        expiresAt: lease.expiresAt
      },
      phases: [
        {
          name: "lease",
          status: "skipped",
          summary: result.issues[0]?.message ?? "operator lease is active",
          issues: result.issues.map((issue) => issue.code)
        }
      ],
      writes,
      recommendations: ["Wait for the active operator lease to expire or inspect the daemon lease table."],
      result
    });
  }

  try {
    const preflight = snapshot(store, now);
    phases.push({
      name: "preflight",
      status: "completed",
      summary: "Captured storage, graph counters, and memory-health pressure before mechanical work.",
      metrics: snapshotMetrics(preflight)
    });

    runPhase(phases, "semantic_reindex", effective.semanticReindex, "Rebuilt semantic index over active graph cells.", () => {
      const result = store.reindexSemantic();
      return {
        indexed: result.indexed,
        backend: result.backend,
        dims: result.dims
      };
    });

    let evalResult: RecallEvalResult | undefined;
    runPhase(phases, "eval_closure", effective.evalClosure, "Ran default recall eval suite and optionally closed the result through admission.", () => {
      if (effective.derive) {
        const result = store.runEvalAndDerive(defaultEvalSuite(), derivationOptions("recall-operator", "operator"), now);
        for (const admission of result.derived) {
          recordAdmission(writes, admission);
        }
        evalResult = result.result;
        return {
          passed: result.result.passed,
          score: result.result.score,
          cases: result.result.cases.length,
          derivedAccepted: result.derived.filter((item) => item.accepted).length
        };
      }
      evalResult = store.runEval(defaultEvalSuite(), now);
      return {
        passed: evalResult.passed,
        score: evalResult.score,
        cases: evalResult.cases.length,
        derivedAccepted: 0
      };
    });

    let daemonResult: DaemonRunResult | undefined;
    if (!effective.daemonMaintenance) {
      phases.push({
        name: "daemon_maintenance",
        status: "skipped",
        summary: "daemon_maintenance disabled for this operator cycle."
      });
    } else {
      try {
        daemonResult = runDaemonOnce(store, now, {
          derive: effective.derive,
          schedule: {
            semanticReindex: false,
            evalClosure: false
          },
          lease: {
            name: "recall-daemon",
            owner: options.lease?.owner ? `${options.lease.owner}:daemon` : undefined
          }
        });
        recordAdmission(writes, daemonResult.result);
        for (const admission of daemonResult.evalClosure?.derived ?? []) {
          recordAdmission(writes, admission);
        }
        phases.push({
          name: "daemon_maintenance",
          status: daemonResult.status === "skipped" ? "skipped" : "completed",
          summary:
            daemonResult.status === "skipped"
              ? daemonResult.result.issues[0]?.message ?? "Daemon maintenance skipped."
              : "Ran outside-LLM daemon maintenance without duplicating operator eval/reindex work.",
          metrics: {
            status: daemonResult.status,
            accepted: daemonResult.result.accepted,
            issueCodes: daemonResult.result.issues.map((issue) => issue.code),
            scheduleBucket: daemonResult.schedule?.bucket,
            memoryHealthNodes: daemonResult.memoryHealth?.stats.nodes
          },
          issues: daemonResult.status === "skipped" ? daemonResult.result.issues.map((issue) => issue.code) : undefined
        });
      } catch (error) {
        phases.push({
          name: "daemon_maintenance",
          status: "failed",
          summary: "daemon_maintenance failed; later phases continued where possible.",
          issues: [error instanceof Error ? error.message : String(error)]
        });
      }
    }

    let tickResult: CognitiveTickResult | undefined;
    runPhase(phases, "cognitive_tick", effective.cognitiveTick, "Ran cognitive planner/repair tick and optionally persisted its witness.", () => {
      tickResult = runCognitiveTick(store, now, effective.derive);
      recordAdmission(writes, tickResult.result);
      return {
        phases: tickResult.report.phases.length,
        candidates: tickResult.report.planner.candidates.length,
        recommendation: tickResult.report.planner.recommendation,
        derivedAccepted: tickResult.result?.accepted ? 1 : 0
      };
    });

    runPhase(phases, "compaction", effective.compact, "Reindexed semantic vectors and ran SQLite VACUUM compaction.", () => {
      const result = store.compact();
      return {
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        indexed: result.semanticReindex.indexed,
        backend: result.semanticReindex.backend
      };
    });

    const postflight = snapshot(store, now);
    phases.push({
      name: "postflight",
      status: "completed",
      summary: "Captured final graph, storage, and pressure counters after mechanical work.",
      metrics: snapshotMetrics(postflight)
    });

    const recommendations = recommendationsFor(postflight.health, phases, writes, evalResult);
    return recordOperatorLedger(store, {
      status: "ran",
      createdAt,
      summary: summaryFor(preflight, postflight, writes),
      options: effective,
      lease:
        lease?.status === "acquired"
          ? {
              name: lease.name,
              owner: lease.owner,
              expiresAt: lease.expiresAt
            }
          : undefined,
      phases,
      preflight,
      postflight,
      writes,
      recommendations
    });
  } finally {
    if (lease?.status === "acquired") {
      releaseDaemonLease(lease);
    }
  }
}

function recordOperatorLedger(store: RecallStore, result: OperatingCycleResult): OperatingCycleResult {
  const run = store.recordOperatorRun({
    status: result.status,
    summary: result.summary,
    result: result as unknown as Record<string, unknown>,
    createdAt: result.createdAt
  });
  return {
    ...result,
    ledger: {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt
    }
  };
}

function runPhase(
  phases: OperatingPhase[],
  name: string,
  enabled: boolean,
  completedSummary: string,
  run: () => Record<string, unknown>
): void {
  if (!enabled) {
    phases.push({
      name,
      status: "skipped",
      summary: `${name} disabled for this operator cycle.`
    });
    return;
  }

  try {
    phases.push({
      name,
      status: "completed",
      summary: completedSummary,
      metrics: run()
    });
  } catch (error) {
    phases.push({
      name,
      status: "failed",
      summary: `${name} failed; later phases continued where possible.`,
      issues: [error instanceof Error ? error.message : String(error)]
    });
  }
}

function snapshot(store: RecallStore, now: Date): OperatingSnapshot {
  const stats = store.stats();
  const storage = storageStats(store);
  const health = summarizeHealth(analyzeMemory(store, now));
  return {
    stats,
    storage: {
      databaseBytes: storage.databaseBytes,
      cells: storage.cells,
      relations: storage.relations,
      rollbackEntries: storage.rollbackEntries,
      averageCell: storage.averageCell,
      maximumCell: storage.maximumCell
    },
    health
  };
}

function summarizeHealth(report: MemoryHealthReport): OperatingHealthSummary {
  return {
    createdAt: report.createdAt,
    nodes: report.stats.nodes,
    relations: report.stats.relations,
    rollbackEntries: report.stats.rollbackEntries,
    beliefs: report.beliefs.length,
    stale: report.stale.length,
    contradictions: report.contradictions.length,
    criticalWarnings: report.criticalWarnings.length,
    topAction: report.nextActions[0] ?? "No health action emitted."
  };
}

function snapshotMetrics(snapshotValue: OperatingSnapshot): Record<string, unknown> {
  return {
    nodes: snapshotValue.stats.nodes,
    relations: snapshotValue.stats.relations,
    rollbackEntries: snapshotValue.stats.rollbackEntries,
    databaseBytes: snapshotValue.storage.databaseBytes,
    averageCellBytes: snapshotValue.storage.averageCell.serializedBytes,
    stale: snapshotValue.health.stale,
    contradictions: snapshotValue.health.contradictions,
    criticalWarnings: snapshotValue.health.criticalWarnings
  };
}

function recordAdmission(summary: OperatingWriteSummary, result: AdmissionResult | undefined): void {
  if (!result) {
    return;
  }
  if (result.accepted) {
    summary.accepted += 1;
    if (result.node?.id) {
      summary.nodeIds.push(result.node.id);
    }
    if (result.duplicateOf) {
      summary.duplicate += 1;
      summary.duplicateOf.push(result.duplicateOf);
    }
  } else {
    summary.rejected += 1;
  }
  for (const issue of result.issues) {
    summary.issueCodes.push(issue.code);
  }
}

function recommendationsFor(
  health: OperatingHealthSummary,
  phases: OperatingPhase[],
  writes: OperatingWriteSummary,
  evalResult: RecallEvalResult | undefined
): string[] {
  const recommendations = new Set<string>();
  if (health.topAction) {
    recommendations.add(health.topAction);
  }
  for (const phase of phases.filter((item) => item.status === "failed")) {
    recommendations.add(`Inspect failed operator phase: ${phase.name}.`);
  }
  if (writes.rejected > 0) {
    recommendations.add(`Review ${writes.rejected} rejected operator write(s): ${unique(writes.issueCodes).join(", ")}.`);
  }
  if (evalResult && !evalResult.passed) {
    recommendations.add("Inspect failed Recall eval cases before trusting background maintenance output.");
  }
  if (recommendations.size === 0) {
    recommendations.add("No urgent operator follow-up detected.");
  }
  return [...recommendations];
}

function summaryFor(preflight: OperatingSnapshot, postflight: OperatingSnapshot, writes: OperatingWriteSummary): string {
  const nodeDelta = postflight.stats.nodes - preflight.stats.nodes;
  const relationDelta = postflight.stats.relations - preflight.stats.relations;
  return `Operator cycle completed: nodes ${preflight.stats.nodes}->${postflight.stats.nodes} (${signed(nodeDelta)}), relations ${preflight.stats.relations}->${postflight.stats.relations} (${signed(relationDelta)}), accepted writes=${writes.accepted}, rejected writes=${writes.rejected}.`;
}

function operatingOptions(options: OperatingCycleOptions): Required<Omit<OperatingCycleOptions, "lease">> {
  return {
    derive: options.derive ?? false,
    semanticReindex: options.semanticReindex ?? true,
    evalClosure: options.evalClosure ?? true,
    cognitiveTick: options.cognitiveTick ?? true,
    daemonMaintenance: options.daemonMaintenance ?? true,
    compact: options.compact ?? false
  };
}

function acquireOperatorLease(store: RecallStore, now: Date, options: DaemonLeaseOptions = {}) {
  const dbPath = storePath(store);
  if (!dbPath) {
    return undefined;
  }
  return acquireDaemonLease(dbPath, now, {
    name: options.name ?? DEFAULT_OPERATOR_LEASE_NAME,
    owner: options.owner,
    ttlMs: options.ttlMs ?? DEFAULT_OPERATOR_LEASE_TTL_MS
  });
}

function storePath(store: RecallStore): string | undefined {
  const candidate = store as unknown as { path?: unknown };
  return typeof candidate.path === "string" ? candidate.path : undefined;
}

function derivationOptions(actorId: string, session: string) {
  return {
    scope: {
      project: "Recall",
      tenant: "local",
      session
    },
    actorId,
    actorDisplay: "Recall Operator",
    producedBy: actorId
  };
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
