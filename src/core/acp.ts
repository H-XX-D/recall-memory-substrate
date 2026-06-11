import { admitWriteProposal } from "./admission.js";
import { analyzeMemory } from "./analysis.js";
import { compileContext } from "./context-compiler.js";
import { runCognitiveTick } from "./cognitive.js";
import { runDaemonOnce } from "./daemon.js";
import { runOperatingCycle } from "./operator.js";
import type { RecallStore, SubgraphFilter } from "./store.js";
import type { AcpRequest, AcpRequestAction, AcpRequestStatus } from "./types.js";

export const ACP_ACTIONS: readonly AcpRequestAction[] = [
  "status",
  "search",
  "semantic",
  "subgraph",
  "compile",
  "write",
  "maintenance",
  "tick",
  "daemon_run_once",
  "operate_once"
] as const;

export const ACP_STATUSES: readonly AcpRequestStatus[] = [
  "queued",
  "processing",
  "completed",
  "failed"
] as const;

export interface AcpCycleOptions {
  limit?: number;
  toAgent?: string;
  manager?: string;
  derive?: boolean;
}

export interface AcpLoopOptions extends AcpCycleOptions {
  intervalMs?: number;
}

export interface AcpCycleResult {
  manager: string;
  processed: AcpRequestResult[];
  queued: number;
  completed: number;
  failed: number;
  summary: string;
  createdAt: string;
}

export interface AcpLoopResult extends AcpCycleResult {
  intervalMs: number;
  managerIdentity: string;
}

export interface AcpExchangeResult {
  manager: string;
  request: AcpRequest;
  response?: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

export interface AcpRequestResult {
  id: string;
  action: AcpRequestAction;
  status: AcpRequestStatus;
  response?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface AcpRequestInput {
  channel?: string;
  fromAgent: string;
  toAgent: string;
  action: AcpRequestAction;
  payload?: Record<string, unknown>;
}

export function enqueueAcpRequest(store: RecallStore, input: AcpRequestInput): AcpRequest {
  return store.enqueueAcpRequest({
    channel: input.channel ?? "inbox",
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    action: input.action,
    payload: input.payload ?? {}
  });
}

export function isAcpRequestAction(value: unknown): value is AcpRequestAction {
  return typeof value === "string" && (ACP_ACTIONS as readonly string[]).includes(value);
}

export function isAcpRequestStatus(value: unknown): value is AcpRequestStatus {
  return typeof value === "string" && (ACP_STATUSES as readonly string[]).includes(value);
}

export function runAcpCycle(store: RecallStore, now = new Date(), options: AcpCycleOptions = {}): AcpCycleResult {
  const manager = options.manager ?? "recall-acp-manager";
  const queued = store.listAcpRequests(options.limit ?? 20, "queued").filter((request) => request.toAgent === (options.toAgent ?? manager));
  const processed: AcpRequestResult[] = [];

  for (const request of queued) {
    store.updateAcpRequest(request.id, {
      status: "processing",
      updatedAt: now.toISOString()
    });
    try {
      const response = processAcpRequest(store, request, now, options);
      store.updateAcpRequest(request.id, {
        status: "completed",
        response,
        error: null,
        processedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      processed.push({ id: request.id, action: request.action, status: "completed", response });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateAcpRequest(request.id, {
        status: "failed",
        response: {
          action: request.action,
          error: message
        },
        error: message,
        processedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      processed.push({ id: request.id, action: request.action, status: "failed", error: message });
    }
  }

  return {
    manager,
    processed,
    queued: queued.length,
    completed: processed.filter((item) => item.status === "completed").length,
    failed: processed.filter((item) => item.status === "failed").length,
    summary: `ACP manager ${manager} processed ${processed.length} request(s).`,
    createdAt: now.toISOString()
  };
}

export function runAcpLoop(store: RecallStore, options: AcpLoopOptions = {}): never {
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 5_000));
  console.error(`Recall ACP manager running every ${intervalMs}ms. Press Ctrl-C to stop.`);
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepArray = new Int32Array(sleepBuffer);
  for (;;) {
    const result: AcpLoopResult = {
      ...runAcpCycle(store, new Date(), options),
      intervalMs,
      managerIdentity: options.manager ?? "recall-acp-manager"
    };
    console.log(JSON.stringify(result, null, 2));
    Atomics.wait(sleepArray, 0, 0, intervalMs);
  }
}

export function runAcpExchange(
  store: RecallStore,
  input: AcpRequestInput,
  now = new Date(),
  options: AcpCycleOptions = {}
): AcpExchangeResult {
  const request = enqueueAcpRequest(store, input);
  const manager = options.manager ?? "recall-acp-manager";
  store.updateAcpRequest(request.id, {
    status: "processing",
    updatedAt: now.toISOString()
  });
  try {
    const response = processAcpRequest(store, request, now, options);
    store.updateAcpRequest(request.id, {
      status: "completed",
      response,
      error: null,
      processedAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    return {
      manager,
      request: store.getAcpRequest(request.id) ?? request,
      response,
      createdAt: now.toISOString()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateAcpRequest(request.id, {
      status: "failed",
      response: {
        action: request.action,
        error: message
      },
      error: message,
      processedAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    return {
      manager,
      request: store.getAcpRequest(request.id) ?? request,
      error: message,
      createdAt: now.toISOString()
    };
  }
}

function processAcpRequest(
  store: RecallStore,
  request: AcpRequest,
  now: Date,
  options: AcpCycleOptions
): Record<string, unknown> {
  switch (request.action) {
    case "status":
      return { stats: store.stats() };
    case "search": {
      const query = stringParam(request.payload, "query");
      return { query, results: store.search(query, numberParam(request.payload, "limit", 10)) };
    }
    case "semantic": {
      const query = stringParam(request.payload, "query");
      return { query, results: store.semanticSearch(query, numberParam(request.payload, "limit", 10)) };
    }
    case "subgraph": {
      const filter = subgraphFilter(request.payload);
      return { filter, results: store.subgraph(filter) };
    }
    case "compile": {
      const task = stringParam(request.payload, "task");
      return {
        packet: compileContext(store, {
          task,
          budgetWords: numberParam(request.payload, "words", 900),
          inlineReferenceValues: booleanParam(request.payload, "inlineReferenceValues", false),
          includeReferenceParameters: booleanParam(request.payload, "includeReferenceParameters", false)
        })
      };
    }
    case "write": {
      const proposal = recordParam(request.payload, "proposal");
      return { result: admitWriteProposal(proposal, store) };
    }
    case "maintenance":
      return { report: analyzeMemory(store, now) };
    case "tick":
      return { result: runCognitiveTick(store, now, booleanParam(request.payload, "derive", false)) };
    case "daemon_run_once":
      return { result: runDaemonOnce(store, now, { derive: booleanParam(request.payload, "derive", false) }) };
    case "operate_once":
      return {
        result: runOperatingCycle(store, now, {
          derive: booleanParam(request.payload, "derive", false),
          compact: booleanParam(request.payload, "compact", false),
          semanticReindex: booleanParam(request.payload, "semanticReindex", true),
          evalClosure: booleanParam(request.payload, "evalClosure", true),
          cognitiveTick: booleanParam(request.payload, "cognitiveTick", true),
          daemonMaintenance: booleanParam(request.payload, "daemonMaintenance", true)
        })
      };
    default:
      throw new Error(`Unsupported ACP action: ${request.action}`);
  }
}

function recordParam(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Expected payload.${key} object`);
  }
  return candidate as Record<string, unknown>;
}

function subgraphFilter(payload: Record<string, unknown>): SubgraphFilter {
  return {
    category: stringArrayParam(payload, "category"),
    type: stringArrayParam(payload, "type"),
    subject: stringArrayParam(payload, "subject"),
    project: stringArrayParam(payload, "project"),
    idea: stringArrayParam(payload, "idea"),
    timestamp: stringArrayParam(payload, "timestamp"),
    topics: stringArrayParam(payload, "topics"),
    entities: stringArrayParam(payload, "entities"),
    identities: stringArrayParam(payload, "identities"),
    rings: stringArrayParam(payload, "rings"),
    limit: numberParam(payload, "limit", 50)
  };
}

function stringParam(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`Expected payload.${key} string`);
  }
  return candidate;
}

function numberParam(value: Record<string, unknown>, key: string, fallback: number): number {
  const candidate = value[key];
  if (candidate === undefined) {
    return fallback;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error(`Expected payload.${key} number`);
  }
  return candidate;
}

function booleanParam(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const candidate = value[key];
  if (candidate === undefined) {
    return fallback;
  }
  if (typeof candidate !== "boolean") {
    throw new Error(`Expected payload.${key} boolean`);
  }
  return candidate;
}

function stringArrayParam(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) {
    throw new Error(`Expected payload.${key} to be string[]`);
  }
  return candidate;
}
