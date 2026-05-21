import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RecallStore, SubgraphFilter } from "./store.js";
import type { AdmissionResult, ValidationIssue } from "./types.js";

export interface DaemonDerivationSchedule {
  bucket: "day";
  maintenanceObservation: boolean;
  semanticReindex: boolean;
  evalClosure: boolean;
}

export interface DaemonScheduleDecision {
  bucket: string;
  maintenanceObservationDue: boolean;
  semanticReindexDue: boolean;
  evalClosureDue: boolean;
  skipped: string[];
}

export interface DaemonLeaseOptions {
  name?: string;
  ttlMs?: number;
  owner?: string;
}

export interface AcquiredDaemonLease {
  status: "acquired";
  name: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  dbPath: string;
}

export interface BlockedDaemonLease {
  status: "blocked";
  name: string;
  owner: string;
  expiresAt: string;
}

export type DaemonLeaseDecision = AcquiredDaemonLease | BlockedDaemonLease;

export const DEFAULT_DAEMON_DERIVATION_SCHEDULE: DaemonDerivationSchedule = {
  bucket: "day",
  maintenanceObservation: true,
  semanticReindex: true,
  evalClosure: true
};

export const DEFAULT_DAEMON_LEASE_TTL_MS = 120_000;
export const DEFAULT_DAEMON_LEASE_NAME = "recall-daemon";

export function planDaemonDerivation(
  store: RecallStore,
  now: Date,
  schedule: Partial<DaemonDerivationSchedule> = {}
): DaemonScheduleDecision {
  const effective = { ...DEFAULT_DAEMON_DERIVATION_SCHEDULE, ...schedule };
  const bucket = scheduleBucket(now, effective.bucket);
  const maintenanceObservationDue =
    effective.maintenanceObservation && !hasActiveNode(store, maintenanceObservationFilter(bucket));
  const evalClosureDue = effective.evalClosure && !hasActiveNode(store, evalClosureFilter(bucket));
  const skipped: string[] = [];

  if (!effective.maintenanceObservation) {
    skipped.push("maintenance_observation_disabled");
  } else if (!maintenanceObservationDue) {
    skipped.push("maintenance_observation_already_admitted");
  }

  if (!effective.semanticReindex) {
    skipped.push("semantic_reindex_disabled");
  }

  if (!effective.evalClosure) {
    skipped.push("eval_closure_disabled");
  } else if (!evalClosureDue) {
    skipped.push("eval_closure_already_admitted");
  }

  return {
    bucket,
    maintenanceObservationDue,
    semanticReindexDue: effective.semanticReindex,
    evalClosureDue,
    skipped
  };
}

export function acquireDaemonLease(dbPath: string, now: Date, options: DaemonLeaseOptions = {}): DaemonLeaseDecision {
  const name = options.name ?? DEFAULT_DAEMON_LEASE_NAME;
  const owner = options.owner ?? `${process.pid}:${randomUUID()}`;
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_DAEMON_LEASE_TTL_MS)).toISOString();
  const db = new DatabaseSync(dbPath);

  try {
    db.exec("PRAGMA busy_timeout = 250;");
    ensureDaemonLeaseTable(db);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isSqliteBusy(error)) {
        return {
          status: "blocked",
          name,
          owner: "sqlite-writer",
          expiresAt: expiresAt
        };
      }
      throw error;
    }
    try {
      const active = db
        .prepare(
          `SELECT owner, expires_at AS expiresAt
           FROM daemon_leases
           WHERE name = ? AND expires_at > ?
           LIMIT 1`
        )
        .get(name, acquiredAt) as DaemonLeaseRow | undefined;

      if (active) {
        db.exec("ROLLBACK");
        return {
          status: "blocked",
          name,
          owner: active.owner,
          expiresAt: active.expiresAt
        };
      }

      db.prepare(
        `INSERT INTO daemon_leases (name, owner, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           owner = excluded.owner,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at`
      ).run(name, owner, acquiredAt, expiresAt);
      db.exec("COMMIT");
      return {
        status: "acquired",
        name,
        owner,
        acquiredAt,
        expiresAt,
        dbPath
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function releaseDaemonLease(lease: AcquiredDaemonLease): void {
  const db = new DatabaseSync(lease.dbPath);
  try {
    ensureDaemonLeaseTable(db);
    db.prepare("DELETE FROM daemon_leases WHERE name = ? AND owner = ?").run(lease.name, lease.owner);
  } finally {
    db.close();
  }
}

export function skippedAdmissionResult(
  reason: string,
  issue: Partial<Pick<ValidationIssue, "path" | "code">> = {}
): AdmissionResult {
  return {
    accepted: false,
    relations: [],
    rollbackEntries: [],
    issues: [daemonIssue(reason, issue)],
    warnings: [],
    attenuations: []
  };
}

function ensureDaemonLeaseTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
}

function hasActiveNode(store: RecallStore, filter: SubgraphFilter): boolean {
  return store.subgraph({ ...filter, limit: 1 }).length > 0;
}

function maintenanceObservationFilter(bucket: string): SubgraphFilter {
  return {
    category: ["runtime"],
    type: ["maintenance_observation"],
    subject: ["daemon"],
    project: ["Recall"],
    idea: ["derivation_closure"],
    timestamp: [bucket],
    identities: ["daemon:recall"],
    limit: 1
  };
}

function evalClosureFilter(bucket: string): SubgraphFilter {
  return {
    category: ["derivation"],
    type: ["eval_run"],
    subject: ["recall-default"],
    project: ["Recall"],
    timestamp: [bucket],
    identities: ["actor:recall-daemon", "producer:recall-daemon"],
    limit: 1
  };
}

function scheduleBucket(now: Date, bucket: DaemonDerivationSchedule["bucket"]): string {
  void bucket;
  const iso = now.toISOString();
  return iso.slice(0, 10);
}

interface DaemonLeaseRow {
  owner: string;
  expiresAt: string;
}

function daemonIssue(reason: string, issue: Partial<Pick<ValidationIssue, "path" | "code">>): ValidationIssue {
  return {
    path: issue.path ?? "daemon.schedule",
    code: issue.code ?? "daemon_schedule_skipped",
    message: reason
  };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}
