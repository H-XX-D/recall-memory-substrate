#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admitWriteProposal } from "../core/admission.js";
import { analyzeMemory, memoryHealthToProposal } from "../core/analysis.js";
import { enqueueAcpRequest, isAcpRequestAction, isAcpRequestStatus, runAcpCycle, runAcpExchange } from "../core/acp.js";
import { inspectCell } from "../core/cell-context.js";
import { runDaemonOnce } from "../core/daemon.js";
import { defaultEvalSuite } from "../core/evals.js";
import { compileContext, formatContextPacket } from "../core/context-compiler.js";
import { runCognitiveTick } from "../core/cognitive.js";
import { buildPageIndex, getRecallPage, type RecallPageName } from "../core/pages.js";
import { runOperatingCycle } from "../core/operator.js";
import { SQLiteRecallStore, type DagOverlayInput, type HyperedgeInput, type SubgraphFilter } from "../core/store.js";
import { storageStats } from "../core/storage-stats.js";
import { RECALL_VERSION } from "../core/version.js";
import { allocateWork, allocationToProposal, blindLockToProposal, type BlindLockInput, type WorkCandidateInput } from "../core/workflow.js";
import { createIdleExit } from "./idle.js";
import type { AcpRequest, HyperedgeProgramSpec, OperatorRun } from "../core/types.js";

type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcRequestWithId extends JsonRpcRequest {
  id: JsonRpcId;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export function handleMcpRequest(request: JsonRpcRequestWithId, store: SQLiteRecallStore): JsonRpcResponse;
export function handleMcpRequest(request: JsonRpcRequest, store: SQLiteRecallStore): JsonRpcResponse | undefined;
export function handleMcpRequest(request: JsonRpcRequest, store: SQLiteRecallStore): JsonRpcResponse | undefined {
  if (!hasResponseId(request)) {
    return undefined;
  }

  try {
    if (typeof request.method !== "string") {
      return err(request, -32600, "Invalid request: method must be a string");
    }

    if (request.method === "initialize") {
      return ok(request, {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "recall",
          version: RECALL_VERSION
        },
        capabilities: {
          tools: {}
        }
      });
    }

    if (request.method === "tools/list") {
      return ok(request, { tools: tools() });
    }

    if (request.method === "tools/call") {
      const name = stringParam(request.params, "name");
      const args = recordParam(request.params, "arguments");
      return ok(request, callTool(name, args, store));
    }

    return err(request, -32601, `Unknown method: ${request.method}`);
  } catch (error) {
    return err(request, -32000, error instanceof Error ? error.message : String(error));
  }
}

function callTool(name: string, args: Record<string, unknown>, store: SQLiteRecallStore): unknown {
  if (name === "recall_status") {
    return textResult(JSON.stringify({ stats: store.stats() }, null, 2));
  }
  if (name === "recall_acp_status") {
    return textResult(JSON.stringify({ mode: "agent-communication-protocol", stats: store.stats() }, null, 2));
  }
  if (name === "recall_storage") {
    return textResult(JSON.stringify(storageStats(store), null, 2));
  }
  if (name === "recall_compact") {
    const result = store.compact();
    return textResult(JSON.stringify({ result, storage: storageStats(store) }, null, 2));
  }
  if (name === "recall_beliefs") {
    return textResult(JSON.stringify({ report: analyzeMemory(store) }, null, 2));
  }
  if (name === "recall_maintenance") {
    const report = analyzeMemory(store);
    const result = booleanArg(args, "derive", false)
      ? admitWriteProposal(
          memoryHealthToProposal(report, {
            project: "Recall",
            tenant: "local",
            session: "mcp-maintenance"
          }),
          store
        )
      : undefined;
    return textResult(JSON.stringify({ report, result }, null, 2));
  }
  if (name === "recall_trust") {
    const report = analyzeMemory(store);
    return textResult(JSON.stringify({ provenance: report.provenance, warnings: report.criticalWarnings }, null, 2));
  }
  if (name === "recall_tick") {
    return textResult(JSON.stringify(runCognitiveTick(store, new Date(), booleanArg(args, "derive", false)), null, 2));
  }
  if (name === "recall_acp_send") {
    return textResult(JSON.stringify({ request: enqueueAcpRequest(store, acpRequestInput(recordArg(args, "request"))) }, null, 2));
  }
  if (name === "recall_acp_list") {
    return textResult(JSON.stringify({ requests: store.listAcpRequests(numberArg(args, "limit", 20), acpStatusArg(args)).map(acpRequestListItem) }, null, 2));
  }
  if (name === "recall_acp_show") {
    return textResult(JSON.stringify(store.getAcpRequest(stringArg(args, "requestId")), null, 2));
  }
  if (name === "recall_acp_process") {
    return textResult(JSON.stringify(runAcpCycle(store, new Date(), {
      limit: numberArg(args, "limit", 20),
      manager: optionalStringArg(args, "manager"),
      toAgent: optionalStringArg(args, "toAgent")
    }), null, 2));
  }
  if (name === "recall_acp_exchange") {
    return textResult(JSON.stringify(runAcpExchange(store, acpRequestInput(recordArg(args, "request")), new Date(), {
      manager: optionalStringArg(args, "manager"),
      toAgent: optionalStringArg(args, "toAgent")
    }), null, 2));
  }
  if (name === "recall_operate_once") {
    return textResult(JSON.stringify(runOperatingCycle(store, new Date(), {
      derive: booleanArg(args, "derive", false),
      compact: booleanArg(args, "compact", false),
      semanticReindex: booleanArg(args, "semanticReindex", true),
      evalClosure: booleanArg(args, "evalClosure", true),
      cognitiveTick: booleanArg(args, "cognitiveTick", true),
      daemonMaintenance: booleanArg(args, "daemonMaintenance", true),
      lease: {
        owner: "recall-mcp"
      }
    }), null, 2));
  }
  if (name === "recall_operate_list") {
    return textResult(JSON.stringify({ runs: store.listOperatorRuns(numberArg(args, "limit", 20)).map(operatorRunListItem) }, null, 2));
  }
  if (name === "recall_operate_show") {
    return textResult(JSON.stringify(store.getOperatorRun(stringArg(args, "runId")), null, 2));
  }
  if (name === "recall_page") {
    const page = stringArg(args, "page") as RecallPageName;
    const output = page === "index"
      ? buildPageIndex(store)
      : getRecallPage(store, page, {
          project: optionalStringArg(args, "project"),
          topic: optionalStringArg(args, "topic"),
          identity: optionalStringArg(args, "identity"),
          limit: numberArg(args, "limit", 25)
        });
    return textResult(JSON.stringify(output, null, 2));
  }
  if (name === "recall_cell") {
    return textResult(JSON.stringify(inspectCell(store, stringArg(args, "idOrAddress")), null, 2));
  }
  if (name === "recall_search") {
    const query = stringArg(args, "query");
    return textResult(JSON.stringify({ query, results: store.search(query, 20) }, null, 2));
  }
  if (name === "recall_semantic") {
    const query = stringArg(args, "query");
    return textResult(JSON.stringify({ query, results: store.semanticSearch(query, 20) }, null, 2));
  }
  if (name === "recall_compile") {
    const task = stringArg(args, "task");
    const words = typeof args.words === "number" ? args.words : 900;
    return textResult(formatContextPacket(compileContext(store, {
      task,
      budgetWords: words,
      inlineReferenceValues: booleanArg(args, "inlineReferenceValues", false),
      includeReferenceParameters: booleanArg(args, "includeReferenceParameters", false)
    })));
  }
  if (name === "recall_subgraph") {
    const filter: SubgraphFilter = {
      category: stringArrayArg(args, "category"),
      type: stringArrayArg(args, "type"),
      subject: stringArrayArg(args, "subject"),
      project: stringArrayArg(args, "project"),
      idea: stringArrayArg(args, "idea"),
      timestamp: stringArrayArg(args, "timestamp"),
      topics: stringArrayArg(args, "topics"),
      entities: stringArrayArg(args, "entities"),
      identities: stringArrayArg(args, "identities"),
      rings: stringArrayArg(args, "rings"),
      limit: typeof args.limit === "number" ? args.limit : 50
    };
    return textResult(JSON.stringify({ filter, results: store.subgraph(filter) }, null, 2));
  }
  if (name === "recall_write") {
    const proposal = recordArg(args, "proposal");
    return textResult(JSON.stringify(admitWriteProposal(proposal, store), null, 2));
  }
  if (name === "recall_workflow_allocate") {
    const candidates = objectArrayArg(args, "candidates") as unknown as WorkCandidateInput[];
    const limit = numberArg(args, "limit", 8);
    const report = allocateWork(candidates, limit);
    const result = booleanArg(args, "derive", false)
      ? admitWriteProposal(
          allocationToProposal(report, {
            project: "Recall",
            tenant: "local",
            session: "mcp-workflow"
          }),
          store
        )
      : undefined;
    return textResult(JSON.stringify({ report, result }, null, 2));
  }
  if (name === "recall_blind_lock") {
    return textResult(JSON.stringify({ result: admitWriteProposal(blindLockToProposal(recordArg(args, "blindLock") as unknown as BlindLockInput), store) }, null, 2));
  }
  if (name === "recall_hyperedge_add") {
    return textResult(JSON.stringify(store.addHyperedge(recordArg(args, "hyperedge") as unknown as HyperedgeInput), null, 2));
  }
  if (name === "recall_hyperedge_show") {
    return textResult(JSON.stringify(store.getHyperedge(stringArg(args, "hyperedgeId")), null, 2));
  }
  if (name === "recall_hyperedge_list") {
    return textResult(JSON.stringify({ hyperedges: store.listHyperedges(numberArg(args, "limit", 20)) }, null, 2));
  }
  if (name === "recall_program_add") {
    return textResult(
      JSON.stringify(
        store.attachProgram(stringArg(args, "hyperedgeId"), recordArg(args, "program") as unknown as HyperedgeProgramSpec),
        null,
        2
      )
    );
  }
  if (name === "recall_program_show") {
    return textResult(JSON.stringify(store.getProgram(stringArg(args, "programId")), null, 2));
  }
  if (name === "recall_program_list") {
    return textResult(JSON.stringify({ programs: store.listPrograms(numberArg(args, "limit", 20)) }, null, 2));
  }
  if (name === "recall_program_run") {
    const programId = stringArg(args, "programId");
    return textResult(JSON.stringify(booleanArg(args, "derive", false) ? store.runProgramAndDerive(programId, mcpDerivationOptions()) : store.runProgram(programId), null, 2));
  }
  if (name === "recall_program_runs") {
    return textResult(JSON.stringify({ runs: store.listProgramRuns(numberArg(args, "limit", 20)) }, null, 2));
  }
  if (name === "recall_program_run_show") {
    return textResult(JSON.stringify(store.getProgramRun(stringArg(args, "runId")), null, 2));
  }
  if (name === "recall_dag_add") {
    return textResult(JSON.stringify(store.addDagOverlay(recordArg(args, "overlay") as unknown as DagOverlayInput), null, 2));
  }
  if (name === "recall_dag_show") {
    return textResult(JSON.stringify(store.getDagOverlay(stringArg(args, "overlayId")), null, 2));
  }
  if (name === "recall_dag_list") {
    return textResult(JSON.stringify({ overlays: store.listDagOverlays(numberArg(args, "limit", 20)) }, null, 2));
  }
  if (name === "recall_dag_analyze") {
    const overlayId = stringArg(args, "overlayId");
    return textResult(
      JSON.stringify(
        booleanArg(args, "derive", false)
          ? store.analyzeDagOverlayAndDerive(overlayId, { ...mcpDerivationOptions(), createdAt: new Date().toISOString() })
          : store.analyzeDagOverlay(overlayId),
        null,
        2
      )
    );
  }
  if (name === "recall_eval_run") {
    const suite = args.suite === undefined ? defaultEvalSuite() : (recordArg(args, "suite") as unknown as ReturnType<typeof defaultEvalSuite>);
    return textResult(JSON.stringify(booleanArg(args, "derive", false) ? store.runEvalAndDerive(suite, mcpDerivationOptions()) : store.runEval(suite), null, 2));
  }
  if (name === "recall_eval_list") {
    return textResult(JSON.stringify({ evalRuns: store.listEvalRuns(numberArg(args, "limit", 20)) }, null, 2));
  }
  if (name === "recall_eval_show") {
    return textResult(JSON.stringify(store.getEvalRun(stringArg(args, "evalRunId")), null, 2));
  }
  if (name === "recall_daemon_run_once") {
    return textResult(JSON.stringify(runDaemonOnce(store, new Date(), { derive: booleanArg(args, "derive", false) }), null, 2));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function tools(): unknown[] {
  return [
    tool("recall_status", "Return Recall graph stats.", {}),
    tool("recall_acp_status", "Return ACP queue and mode status.", {}),
    tool("recall_storage", "Return average memory-cell footprint and database storage stats.", {}),
    tool("recall_compact", "Reindex semantic vectors and run SQLite VACUUM compaction.", {}),
    tool("recall_beliefs", "Return evidence-weighted belief pressure, stale-memory findings, and contradiction pressure.", {}),
    tool("recall_maintenance", "Run a memory-health analysis and optionally admit the maintenance witness.", {
      derive: { type: "boolean" }
    }),
    tool("recall_trust", "Return provenance, source-diversity, and trust warnings.", {}),
    tool("recall_tick", "Run the integrated cognitive tick loop and optionally persist the tick witness.", {
      derive: { type: "boolean" }
    }),
    tool("recall_acp_send", "Enqueue an ACP request for the internal graph manager.", {
      request: { type: "object" }
    }),
    tool("recall_acp_list", "List ACP requests.", {
      limit: { type: "number" },
      status: { type: "string" }
    }),
    tool("recall_acp_show", "Show one ACP request.", {
      requestId: { type: "string" }
    }),
    tool("recall_acp_process", "Process queued ACP requests with the internal manager.", {
      limit: { type: "number" },
      manager: { type: "string" },
      toAgent: { type: "string" }
    }),
    tool("recall_acp_exchange", "Send one ACP request to the internal manager and return its response in the same call.", {
      request: { type: "object" },
      manager: { type: "string" },
      toAgent: { type: "string" }
    }),
    tool("recall_operate_once", "Run one leased mechanical operator cycle: reindex, eval, tick, daemon maintenance, optional compaction, and postflight report.", {
      derive: { type: "boolean" },
      compact: { type: "boolean" },
      semanticReindex: { type: "boolean" },
      evalClosure: { type: "boolean" },
      cognitiveTick: { type: "boolean" },
      daemonMaintenance: { type: "boolean" }
    }),
    tool("recall_operate_list", "List persisted operator cycle reports.", {
      limit: { type: "number" }
    }),
    tool("recall_operate_show", "Show one persisted operator cycle report.", {
      runId: { type: "string" }
    }),
    tool("recall_page", "Return a paged graph view such as witnesses, workbench, handoffs, objectives, team-metrics, or index.", {
      page: { type: "string" },
      project: { type: "string" },
      topic: { type: "string" },
      identity: { type: "string" },
      limit: { type: "number" }
    }),
    tool("recall_cell", "Inspect one addressable memory cell and summarize all connected data.", {
      idOrAddress: { type: "string" }
    }),
    tool("recall_search", "Lexical search over Recall graph nodes.", {
      query: { type: "string" }
    }),
    tool("recall_semantic", "Semantic search over Recall graph nodes.", {
      query: { type: "string" }
    }),
    tool("recall_compile", "Compile a compact context packet for an LLM task.", {
      task: { type: "string" },
      words: { type: "number" },
      inlineReferenceValues: { type: "boolean" },
      includeReferenceParameters: { type: "boolean" }
    }),
    tool("recall_subgraph", "Return a tag-composed subgraph.", {
      category: { type: "array", items: { type: "string" } },
      type: { type: "array", items: { type: "string" } },
      subject: { type: "array", items: { type: "string" } },
      project: { type: "array", items: { type: "string" } },
      idea: { type: "array", items: { type: "string" } },
      timestamp: { type: "array", items: { type: "string" } },
      topics: { type: "array", items: { type: "string" } },
      entities: { type: "array", items: { type: "string" } },
      identities: { type: "array", items: { type: "string" } },
      rings: { type: "array", items: { type: "string" } }
    }),
    tool("recall_write", "Persist a durable fact/decision/observation to Recall (your memory) through admission. This is where durable memory lives — do not keep durable facts in scratch files. CORRECTIONS: if this write changes or invalidates an existing memory, set proposal.evidence.contradicts to the prior cell id(s) so Recall supersedes the old value (demotes + flags it) instead of leaving two competing cells. Find the prior id with recall_search first.", {
      proposal: { type: "object" }
    }),
    tool("recall_workflow_allocate", "Score and select workflow candidates using the integrated attention allocator.", {
      candidates: { type: "array", items: { type: "object" } },
      limit: { type: "number" },
      derive: { type: "boolean" }
    }),
    tool("recall_blind_lock", "Write a pre-registered blind-lock prediction through admission.", {
      blindLock: { type: "object" }
    }),
    tool("recall_hyperedge_add", "Create an n-ary hyperedge over addressable cells.", {
      hyperedge: { type: "object" }
    }),
    tool("recall_hyperedge_show", "Show one hyperedge.", {
      hyperedgeId: { type: "string" }
    }),
    tool("recall_hyperedge_list", "List hyperedges.", {
      limit: { type: "number" }
    }),
    tool("recall_program_add", "Attach a sandboxed recall.program.v1 spec to a hyperedge.", {
      hyperedgeId: { type: "string" },
      program: { type: "object" }
    }),
    tool("recall_program_show", "Show one hyperedge program.", {
      programId: { type: "string" }
    }),
    tool("recall_program_list", "List hyperedge programs.", {
      limit: { type: "number" }
    }),
    tool("recall_program_run", "Run a sandboxed hyperedge program.", {
      programId: { type: "string" },
      derive: { type: "boolean" }
    }),
    tool("recall_program_runs", "List program runs.", {
      limit: { type: "number" }
    }),
    tool("recall_program_run_show", "Show one program run.", {
      runId: { type: "string" }
    }),
    tool("recall_dag_add", "Create an optional DAG overlay over cells.", {
      overlay: { type: "object" }
    }),
    tool("recall_dag_show", "Show one DAG overlay.", {
      overlayId: { type: "string" }
    }),
    tool("recall_dag_list", "List DAG overlays.", {
      limit: { type: "number" }
    }),
    tool("recall_dag_analyze", "Analyze a DAG overlay and produce holonomy witnesses.", {
      overlayId: { type: "string" },
      derive: { type: "boolean" }
    }),
    tool("recall_eval_run", "Run a Recall eval suite and persist the eval result.", {
      suite: { type: "object" },
      derive: { type: "boolean" }
    }),
    tool("recall_eval_list", "List eval runs.", {
      limit: { type: "number" }
    }),
    tool("recall_eval_show", "Show one eval run.", {
      evalRunId: { type: "string" }
    }),
    tool("recall_daemon_run_once", "Run one daemon maintenance pass outside the LLM.", {
      derive: { type: "boolean" }
    })
  ];
}

function tool(name: string, description: string, properties: Record<string, unknown>): unknown {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      additionalProperties: false
    }
  };
}

function textResult(text: string): unknown {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function hasResponseId(request: JsonRpcRequest): request is JsonRpcRequestWithId {
  return typeof request.id === "string" || typeof request.id === "number";
}

function ok(request: JsonRpcRequestWithId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id, result };
}

function err(request: JsonRpcRequestWithId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id, error: { code, message } };
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected params.${key} string`);
  }
  return value;
}

function recordParam(params: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = params?.[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected argument ${key} object`);
  }
  return value as Record<string, unknown>;
}

function objectArrayArg(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw new Error(`Expected argument ${key} object[]`);
  }
  return value as Record<string, unknown>[];
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected argument ${key}`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected argument ${key} string`);
  }
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected argument ${key} number`);
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected argument ${key} boolean`);
  }
  return value;
}

function mcpDerivationOptions() {
  return {
    scope: {
      project: "Recall",
      tenant: "local",
      session: "mcp-derivation"
    },
    actorId: "recall-mcp",
    actorDisplay: "Recall MCP",
    producedBy: "recall-mcp"
  };
}

function operatorRunListItem(run: OperatorRun): Record<string, unknown> {
  const phases = Array.isArray(run.result.phases) ? run.result.phases.filter(isRecord) : [];
  const writes = isRecord(run.result.writes) ? run.result.writes : {};
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    summary: run.summary,
    phases: phases.length,
    failedPhases: phases.filter((phase) => phase.status === "failed").length,
    skippedPhases: phases.filter((phase) => phase.status === "skipped").length,
    acceptedWrites: typeof writes.accepted === "number" ? writes.accepted : 0,
    rejectedWrites: typeof writes.rejected === "number" ? writes.rejected : 0
  };
}

function acpRequestListItem(request: AcpRequest): Record<string, unknown> {
  return {
    id: request.id,
    status: request.status,
    action: request.action,
    channel: request.channel,
    fromAgent: request.fromAgent,
    toAgent: request.toAgent,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    processedAt: request.processedAt,
    payloadKeys: Object.keys(request.payload).length,
    hasResponse: request.response !== null,
    error: request.error
  };
}

function acpRequestInput(value: Record<string, unknown>): {
  channel?: string;
  fromAgent: string;
  toAgent: string;
  action: import("../core/types.js").AcpRequestAction;
  payload?: Record<string, unknown>;
} {
  if (!isAcpRequestAction(value.action)) {
    throw new Error("Expected argument request.action to be a supported ACP action");
  }
  return {
    channel: optionalStringArg(value, "channel"),
    fromAgent: stringArg(value, "fromAgent"),
    toAgent: stringArg(value, "toAgent"),
    action: value.action,
    payload: isRecord(value.payload) ? (value.payload as Record<string, unknown>) : undefined
  };
}

function acpStatusArg(args: Record<string, unknown>): import("../core/types.js").AcpRequestStatus | undefined {
  const status = optionalStringArg(args, "status");
  return isAcpRequestStatus(status) ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected argument ${key} to be string[]`);
  }
  return value;
}

/**
 * Resolve which SQLite DB this server instance targets. Mirrors the CLI
 * wrapper's precedence so MCP and CLI agree on routing:
 *   1. explicit RECALL_DB env       -> honored verbatim (escape hatch / migrations)
 *   2. cwd registry walk            -> deepest registered project root wins
 *   3. global fallback
 * The server has no per-call cwd, so the walk runs once at launch against
 * process.cwd() — correct for the common one-Claude-session-per-project case.
 */
function resolveDbPath(): string {
  const explicit = process.env.RECALL_DB;
  if (explicit && explicit.trim() !== "") {
    return explicit;
  }
  const globalDb = join(homedir(), ".recall", "db", "global.sqlite3");
  try {
    const registry = new DatabaseSync(globalDb, { readOnly: true });
    const rows = registry
      .prepare("SELECT root_path, db_path FROM projects")
      .all() as Array<{ root_path: string; db_path: string }>;
    registry.close();
    const byRoot = new Map(rows.map((r) => [resolve(r.root_path), r.db_path]));
    let dir = resolve(process.cwd());
    for (;;) {
      const hit = byRoot.get(dir);
      if (hit) {
        return hit;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // registry missing / unreadable (fresh install) -> global fallback
  }
  return globalDb;
}

export function startStdioServer(): void {
  const dbPath = resolveDbPath();
  const store = new SQLiteRecallStore(dbPath);
  const reader = createInterface({ input: process.stdin });
  const idleTimeoutMs = readMsEnv("RECALL_MCP_IDLE_EXIT_MS", 30 * 60 * 1000);
  const idleCheckMs = readMsEnv("RECALL_MCP_IDLE_CHECK_MS", 60_000);
  const idle = createIdleExit({
    timeoutMs: idleTimeoutMs,
    intervalMs: idleCheckMs,
    onIdle: () => {
      process.stderr.write(
        `[recall-mcp] idle-exit: no requests for ${idleTimeoutMs}ms; shutting down (clients respawn on demand)\n`
      );
      store.close();
      process.exit(0);
    }
  });
  reader.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    idle.touch();
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = handleMcpRequest(request, store);
      if (response !== undefined) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[recall-mcp] Ignoring invalid JSON-RPC input: ${message}\n`);
    }
  });
  reader.on("close", () => {
    idle.stop();
    store.close();
  });
}

function readMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(`[recall-mcp] Ignoring invalid ${name}=${raw}; using ${fallback}\n`);
    return fallback;
  }
  return parsed;
}
