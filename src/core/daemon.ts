import { admitWriteProposal } from "./admission.js";
import { analyzeMemory, memoryHealthToProposal, type MemoryHealthReport } from "./analysis.js";
import {
  acquireDaemonLease,
  planDaemonDerivation,
  releaseDaemonLease,
  skippedAdmissionResult,
  type DaemonDerivationSchedule,
  type DaemonLeaseOptions,
  type DaemonScheduleDecision
} from "./daemon-scheduler.js";
import type { RecallStore } from "./store.js";
import type { AdmissionResult, WriteProposal } from "./types.js";
import { defaultEvalSuite, type RecallEvalResult } from "./evals.js";

export interface DaemonRunResult {
  status: "ran" | "skipped";
  result: AdmissionResult;
  semanticReindex?: { indexed: number; backend: string; dims: number };
  schedule?: DaemonScheduleDecision;
  evalClosure?: {
    result: RecallEvalResult;
    derived: AdmissionResult[];
  };
  memoryHealth?: MemoryHealthReport;
  lease?: DaemonRunLease;
}

export interface DaemonRunLease {
  name: string;
  owner: string;
  expiresAt: string;
}

export interface DaemonRunOptions {
  derive?: boolean;
  schedule?: Partial<DaemonDerivationSchedule>;
  lease?: DaemonLeaseOptions;
}

export function runDaemonOnce(store: RecallStore, now = new Date(), options: DaemonRunOptions = {}): DaemonRunResult {
  const lease = acquireLeaseForStore(store, now, options.lease);
  if (lease?.status === "blocked") {
    return {
      status: "skipped",
      result: skippedAdmissionResult(
        `daemon lease is active until ${lease.expiresAt} for owner ${lease.owner}`,
        {
          path: "daemon.lease",
          code: "daemon_lease_active"
        }
      ),
      lease: {
        name: lease.name,
        owner: lease.owner,
        expiresAt: lease.expiresAt
      }
    };
  }

  try {
    return runDaemonWork(store, now, options, lease);
  } finally {
    if (lease?.status === "acquired") {
      releaseDaemonLease(lease);
    }
  }
}

function runDaemonWork(
  store: RecallStore,
  now: Date,
  options: DaemonRunOptions,
  lease: ReturnType<typeof acquireLeaseForStore>
): DaemonRunResult {
  const schedule = options.derive ? planDaemonDerivation(store, now, options.schedule) : undefined;
  const semanticReindex = schedule?.semanticReindexDue ? store.reindexSemantic() : undefined;
  const evalClosure = schedule?.evalClosureDue
    ? store.runEvalAndDerive(defaultEvalSuite(), {
        scope: {
          project: "Recall",
          tenant: "local",
          session: "daemon"
        },
        actorId: "recall-daemon",
        actorDisplay: "Recall Daemon",
        producedBy: "recall-daemon"
      }, now)
    : undefined;
  const memoryHealth = analyzeMemory(store, now);
  const proposal: WriteProposal = memoryHealthToProposal(memoryHealth, {
      project: "Recall",
      tenant: "local",
      session: "daemon"
  });
  proposal.actor.id = "recall-daemon";
  proposal.actor.display = "Recall Daemon";
  proposal.content.title = "Daemon maintenance pass";
  proposal.content.summary = `Daemon observed ${memoryHealth.stats.nodes} nodes, ${memoryHealth.stats.relations} relations, ${memoryHealth.stats.rollbackEntries} rollback entries; ${memoryHealth.beliefs.length} belief pressure item(s), ${memoryHealth.stale.length} stale item(s), ${memoryHealth.contradictions.length} contradiction/concern item(s).`;
  proposal.content.body = JSON.stringify(
    {
      kind: "daemon_maintenance_pass",
      memoryHealth,
      closure: {
        semanticReindex,
        evalClosure: evalClosure
          ? {
              name: evalClosure.result.name,
              passed: evalClosure.result.passed,
              score: evalClosure.result.score,
              derivedAccepted: evalClosure.derived.filter((result) => result.accepted).length
            }
          : null
      }
    },
    null,
    2
  );
  proposal.tags.idea = options.derive ? ["outside_llm_maintenance", "derivation_closure"] : ["outside_llm_maintenance"];
  proposal.tags.topics = options.derive ? ["daemon", "maintenance", "beliefs", "stale-memory", "contradictions", "derivation"] : ["daemon", "maintenance", "beliefs", "stale-memory", "contradictions"];
  proposal.tags.permission = ["background", "write"];
  proposal.evidence.source_refs = ["recall:graph_nodes", "recall:graph_relations", "recall:store.stats", "recall:analysis.memory_health"];
  proposal.provenance.produced_by = "recall-daemon";

  return {
    status: "ran",
    result:
      options.derive && schedule && !schedule.maintenanceObservationDue
        ? skippedAdmissionResult("daemon maintenance observation already admitted for this schedule bucket")
        : admitWriteProposal(proposal, store),
    semanticReindex,
    schedule,
    evalClosure,
    memoryHealth,
    lease:
      lease?.status === "acquired"
        ? {
            name: lease.name,
            owner: lease.owner,
            expiresAt: lease.expiresAt
          }
        : undefined
  };
}

function acquireLeaseForStore(store: RecallStore, now: Date, options: DaemonLeaseOptions = {}) {
  const dbPath = storePath(store);
  return dbPath ? acquireDaemonLease(dbPath, now, options) : undefined;
}

function storePath(store: RecallStore): string | undefined {
  const candidate = store as unknown as { path?: unknown };
  if (typeof candidate.path === "string") {
    return candidate.path;
  }
  return undefined;
}
