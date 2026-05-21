import { admitWriteProposal } from "./admission.js";
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
      })
    : undefined;
  const stats = store.stats();
  const proposal: WriteProposal = {
    schema_version: "recall.write.v1",
    actor: {
      kind: "daemon",
      id: "recall-daemon",
      display: "Recall Daemon"
    },
    intent: {
      kind: "observation",
      operation: "create"
    },
    content: {
      title: "Daemon maintenance pass",
      body: `Daemon ran outside the LLM. Current graph stats: ${JSON.stringify(stats)}. Closure: ${JSON.stringify({
        semanticReindex,
        evalClosure: evalClosure
          ? {
              name: evalClosure.result.name,
              passed: evalClosure.result.passed,
              score: evalClosure.result.score,
              derivedAccepted: evalClosure.derived.filter((result) => result.accepted).length
            }
          : null
      })}.`,
      summary: `Daemon observed ${stats.nodes} nodes, ${stats.relations} relations, ${stats.rollbackEntries} rollback entries.`
    },
    scope: {
      project: "Recall",
      tenant: "local",
      session: "daemon"
    },
    tags: {
      category: ["runtime"],
      type: ["maintenance_observation"],
      subject: ["daemon"],
      project: ["Recall"],
      idea: options.derive ? ["outside_llm_maintenance", "derivation_closure"] : ["outside_llm_maintenance"],
      timestamp: [now.toISOString().slice(0, 10)],
      topics: options.derive ? ["daemon", "maintenance", "derivation"] : ["daemon", "maintenance"],
      entities: ["Recall"],
      identities: ["daemon:recall"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["source-grounded"],
      sensitivity: ["public"],
      permission: ["background", "write"]
    },
    evidence: {
      source_refs: ["recall:store.stats"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      value: 0.62,
      uncertainty: 0.2,
      concern: 0.2,
      source_quality: "medium",
      stability: "volatile"
    },
    provenance: {
      created_at: now.toISOString(),
      origin: "daemon",
      produced_by: "recall-daemon",
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

  return {
    status: "ran",
    result:
      options.derive && schedule && !schedule.maintenanceObservationDue
        ? skippedAdmissionResult("daemon maintenance observation already admitted for this schedule bucket")
        : admitWriteProposal(proposal, store),
    semanticReindex,
    schedule,
    evalClosure,
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
