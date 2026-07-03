// v5 MCP server: a hand-rolled JSON-RPC-2.0-over-stdio dispatcher (mirrors the
// shipped recall MCP, no SDK). handleMcpRequest is the pure, testable core; the
// stdio readline loop is thin glue in mcp-cli.ts. Lean tool set: the five the
// model actually uses. The daemon/operator tick runs from the Stop hook, not here.
import { compileContext, formatContextPacket } from "./compile.js";
import { inspectCell } from "./cell-context.js";
import { admit } from "./admission.js";
import type { Store, WriteProposal } from "./types.js";

type JsonRpcId = string | number;
export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const SERVER_NAME = "recall";
const SERVER_VERSION = "0.5.2";
const PROTOCOL_VERSION = "2024-11-05";

export const TOOLS = [
  { name: "recall_status", description: "Graph counts and lexical backend.", inputSchema: { type: "object", properties: {} } },
  { name: "recall_search", description: "Lexical search; returns id, kind, title, score.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "recall_compile", description: "Compile a budgeted context packet for a task.", inputSchema: { type: "object", properties: { task: { type: "string" }, words: { type: "number" } }, required: ["task"] } },
  { name: "recall_cell", description: "Expand one cell by id, prefix, handle, or address.", inputSchema: { type: "object", properties: { idOrAddress: { type: "string" } }, required: ["idOrAddress"] } },
  { name: "recall_write", description: "Admit a durable write through the admission gate.", inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, confidence: { type: "number" }, topics: { type: "array" }, edges: { type: "array" } }, required: ["kind", "title", "body", "confidence"] } },
] as const;

export function handleMcpRequest(request: JsonRpcRequest, store: Store): JsonRpcResponse | undefined {
  const id = request.id;
  if (id === undefined || id === null) return undefined; // a notification gets no response
  try {
    if (typeof request.method !== "string") return err(id, -32600, "method must be a string");
    switch (request.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        });
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call": {
        const name = stringParam(request.params, "name");
        const args = recordParam(request.params, "arguments");
        return ok(id, { content: [{ type: "text", text: callTool(name, args, store) }] });
      }
      default:
        return err(id, -32601, `Unknown method: ${request.method}`);
    }
  } catch (e) {
    return err(id, -32000, e instanceof Error ? e.message : String(e));
  }
}

function callTool(name: string, args: Record<string, unknown>, store: Store): string {
  switch (name) {
    case "recall_status":
      return JSON.stringify(store.stats());
    case "recall_search": {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const hits = store.search(query, { limit }).map((h) => ({
        id: h.cell.key,
        kind: h.cell.kind,
        title: h.cell.title,
        score: round2(h.score),
      }));
      return JSON.stringify(hits);
    }
    case "recall_compile": {
      const task = String(args.task ?? args.objective ?? "");
      const words = typeof args.words === "number" ? args.words : 900;
      return formatContextPacket(compileContext(store, task, { budgetWords: words }));
    }
    case "recall_cell": {
      const ref = String(args.idOrAddress ?? args.id ?? "");
      const c = inspectCell(store, ref).cell;
      return JSON.stringify({
        id: c.key,
        handle: c.handle,
        kind: c.kind,
        title: c.title,
        body: c.body,
        scores: c.scores,
        status: c.status,
        edgesOut: c.edgesOut,
      });
    }
    case "recall_write": {
      const r = admit(toProposal(args), { store });
      return JSON.stringify({
        accepted: r.accepted,
        id: r.cell?.key,
        issues: r.issues,
        warnings: r.warnings,
        attenuations: r.attenuations,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toProposal(args: Record<string, unknown>): WriteProposal {
  return {
    kind: String(args.kind ?? ""),
    title: String(args.title ?? ""),
    body: typeof args.body === "string" ? args.body : "",
    confidence: typeof args.confidence === "number" ? args.confidence : Number.NaN,
    topics: Array.isArray(args.topics) ? (args.topics as string[]) : undefined,
    entities: Array.isArray(args.entities) ? (args.entities as string[]) : undefined,
    edges: Array.isArray(args.edges) ? (args.edges as WriteProposal["edges"]) : undefined,
    sourceRefs: Array.isArray(args.sourceRefs) ? (args.sourceRefs as string[]) : undefined,
    verification: typeof args.verification === "string" ? (args.verification as WriteProposal["verification"]) : undefined,
  };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function stringParam(params: Record<string, unknown> | undefined, key: string): string {
  const v = params?.[key];
  if (typeof v !== "string") throw new Error(`missing string param: ${key}`);
  return v;
}
function recordParam(params: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const v = params?.[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
