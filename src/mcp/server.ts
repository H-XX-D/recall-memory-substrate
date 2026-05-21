#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { createInterface } from "node:readline";
import { admitWriteProposal } from "../core/admission.js";
import { runDaemonOnce } from "../core/daemon.js";
import { defaultEvalSuite } from "../core/evals.js";
import { compileContext, formatContextPacket } from "../core/context-compiler.js";
import { SQLiteRecallStore, type DagOverlayInput, type HyperedgeInput, type SubgraphFilter } from "../core/store.js";
import type { HyperedgeProgramSpec } from "../core/types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export function handleMcpRequest(request: JsonRpcRequest, store: SQLiteRecallStore): JsonRpcResponse {
  try {
    if (request.method === "initialize") {
      return ok(request, {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "recall",
          version: "0.1.0"
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
    return textResult(formatContextPacket(compileContext(store, { task, budgetWords: words })));
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
    tool("recall_search", "Lexical search over Recall graph nodes.", {
      query: { type: "string" }
    }),
    tool("recall_semantic", "Semantic search over Recall graph nodes.", {
      query: { type: "string" }
    }),
    tool("recall_compile", "Compile a compact context packet for an LLM task.", {
      task: { type: "string" },
      words: { type: "number" }
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
    tool("recall_write", "Submit an LLM-managed memory write proposal through Recall admission.", {
      proposal: { type: "object" }
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

function ok(request: JsonRpcRequest, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id ?? null, result };
}

function err(request: JsonRpcRequest, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id ?? null, error: { code, message } };
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

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected argument ${key}`);
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

export function startStdioServer(): void {
  const dbPath = process.env.RECALL_DB ?? ".recall/recall.sqlite3";
  const store = new SQLiteRecallStore(dbPath);
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    const request = JSON.parse(line) as JsonRpcRequest;
    process.stdout.write(`${JSON.stringify(handleMcpRequest(request, store))}\n`);
  });
  reader.on("close", () => {
    store.close();
  });
}
