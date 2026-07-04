// v5 MCP server: a hand-rolled JSON-RPC-2.0-over-stdio dispatcher (mirrors the
// shipped recall MCP, no SDK). handleMcpRequest is the pure, testable core; the
// stdio readline loop is thin glue in mcp-cli.ts. Nineteen tools: recall_status,
// recall_search, recall_compile, recall_cell, recall_write, recall_semantic,
// recall_ref, recall_page, recall_hyperedge_add, recall_hyperedge_show,
// recall_hyperedge_list, recall_dag_analyze, recall_program_run,
// recall_program_runs, recall_eval_run, recall_subgraph, recall_health,
// recall_storage. The daemon/operator tick runs from the Stop hook, not here.
import { analyzeMemory, memoryHealthToProposal } from "./analysis.js";
import { compileContext, formatContextPacket } from "./compile.js";
import { inspectCell, resolveCell } from "./cell-context.js";
import { admit } from "./admission.js";
import { buildWriteGuidance } from "./guidance.js";
import { semanticSearch } from "./semantic.js";
import { resolveCellReference, cellReferenceView } from "./references.js";
import { getRecallPage } from "./pages.js";
import type { PageName, PageFilter } from "./pages.js";
import { addHyperedge, type HyperedgeInput } from "./hyperedges.js";
import { analyzeDagOverlay } from "./dag.js";
import { dagAnalysisToKeyedProposals, deriveAdmit, memoryHealthDerivationKey } from "./derivation.js";
import { renderDeltasCsv, valueSeries } from "./deltas.js";
import { runProgramCell } from "./programs.js";
import { runAndRecordEval, runEvalAndDerive } from "./evals.js";
import { subgraphCells, type SubgraphFilter } from "./subgraph.js";
import type { AdmissionResult, Store, WriteProposal } from "./types.js";
import type { SqliteStore } from "./store.js";

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
const SERVER_VERSION = "0.12.0";
const PROTOCOL_VERSION = "2024-11-05";

export const TOOLS = [
  { name: "recall_status", description: "Graph counts and lexical backend.", inputSchema: { type: "object", properties: {} } },
  { name: "recall_search", description: "Lexical search; returns id, kind, title, score.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "recall_compile", description: "Compile a budgeted context packet for a task.", inputSchema: { type: "object", properties: { task: { type: "string" }, words: { type: "number" }, health: { type: "boolean" }, inlineRefs: { type: "boolean" }, refParams: { type: "boolean" } }, required: ["task"] } },
  { name: "recall_cell", description: "Expand one cell by id, prefix, handle, or address.", inputSchema: { type: "object", properties: { idOrAddress: { type: "string" } }, required: ["idOrAddress"] } },
  { name: "recall_write", description: "Admit a durable write through the admission gate. kind: dec (decision made), obs (observation), bel (claim to later confirm or refute), tsk (open action), obj (objective), rsk (risk), ref (source reference), ver (verification result), hyp (hypothesis). Prefer bel, tsk, rsk over flat observations when they fit; contradicts and depends_on edges feed the compile packet's conflicts and dependencies sections. Confidence above 0.7 needs verification, sourceRefs, or a weighted supports edge, else it is attenuated. The response includes guidance (candidate edges to similar cells; standing-program suggestions on by default, suggestPrograms false to opt out).", inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, confidence: { type: "number" }, value: { type: "number" }, topics: { type: "array", items: { type: "string" } }, entities: { type: "array", items: { type: "string" } }, edges: { type: "array" }, sourceRefs: { type: "array", items: { type: "string" } }, verification: { type: "string", enum: ["unverified", "checked", "tested", "external"] }, props: { type: "object" }, programs: { type: "array", items: { type: "string" } }, hyperedges: { type: "array" }, suggestPrograms: { type: "boolean" } }, required: ["kind", "title", "body", "confidence"] } },
  { name: "recall_semantic", description: "Semantic (vector) search; returns key, handle, title, score, backend.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, minScore: { type: "number" } }, required: ["query"] } },
  { name: "recall_ref", description: "Resolve a cell reference (handle#field.path) to the addressed value.", inputSchema: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] } },
  { name: "recall_page", description: "Return a curated kind-filtered page view (reflections, objectives, workbench, witnesses, handoffs, team-metrics, agent-profile, user-profile, index).", inputSchema: { type: "object", properties: { name: { type: "string" }, project: { type: "string" }, topics: { type: "array", items: { type: "string" } }, since: { type: "string" }, limit: { type: "number" } }, required: ["name"] } },
  { name: "recall_hyperedge_add", description: "Create a hyperedge grouping cell members under a kind and title.", inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, members: { type: "array" }, metadata: { type: "object" } }, required: ["kind", "title", "members"] } },
  { name: "recall_hyperedge_show", description: "Expand one hyperedge by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "recall_hyperedge_list", description: "List hyperedges, optionally filtered to those containing a given cell.", inputSchema: { type: "object", properties: { limit: { type: "number" }, forCell: { type: "string" } } } },
  { name: "recall_dag_analyze", description: "Analyze a DAG overlay for cycles and holonomy witnesses; with derive:true, admit keyed derived writes and report accepted/duplicate/rejected counts.", inputSchema: { type: "object", properties: { id: { type: "string" }, derive: { type: "boolean" } }, required: ["id"] } },
  { name: "recall_program_run", description: "Run a standing program cell by key or handle; with derive:true, admit its witness as a keyed derived write.", inputSchema: { type: "object", properties: { key: { type: "string" }, derive: { type: "boolean" } }, required: ["key"] } },
  { name: "recall_program_runs", description: "List program run history, optionally filtered to one program key or handle.", inputSchema: { type: "object", properties: { key: { type: "string" }, limit: { type: "number" } } } },
  { name: "recall_eval_run", description: "Run the default model-free eval suite; with derive:true, admit its witness as a keyed derived write (day-bucketed per project).", inputSchema: { type: "object", properties: { derive: { type: "boolean" }, project: { type: "string" } } } },
  { name: "recall_subgraph", description: "Tag-composed retrieval over active cells (AND across kinds/project/topics/entities/since; every listed value within an array family required), newest-updated first.", inputSchema: { type: "object", properties: { kinds: { type: "array", items: { type: "string" } }, project: { type: "string" }, topics: { type: "array", items: { type: "string" } }, entities: { type: "array", items: { type: "string" } }, since: { type: "string" }, limit: { type: "number" } } } },
  { name: "recall_deltas", description: "Numeric value series with deltas: walks a cell's supersede lineage (or a topic's readings) oldest-first; csv:true returns CSV text.", inputSchema: { type: "object", properties: { target: { type: "string" }, topic: { type: "boolean" }, csv: { type: "boolean" }, limit: { type: "number" } }, required: ["target"] } },
  { name: "recall_health", description: "Memory health report: belief pressure, staleness, contradictions, dangling edges, and provenance concentration; with derive:true, admit a day-bucketed witness cell and report accepted/duplicateOf.", inputSchema: { type: "object", properties: { derive: { type: "boolean" } } } },
  { name: "recall_storage", description: "Storage stats: database path/bytes (including WAL sidecars), per-table row counts, average and maximum cell size.", inputSchema: { type: "object", properties: {} } },
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
      return formatContextPacket(compileContext(store, task, {
        budgetWords: words,
        includeHealth: args.health !== false,
        inlineReferenceValues: args.inlineRefs === true,
        includeReferenceParameters: args.refParams === true,
      }));
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
      const suggest = args.suggestPrograms === false ? false : args.suggestPrograms === true ? true : process.env.RECALL_SUGGEST_PROGRAMS !== "0";
      const guidance = r.accepted && r.cell ? buildWriteGuidance(store, r.cell, r, { suggestPrograms: suggest }) : undefined;
      return JSON.stringify({
        accepted: r.accepted,
        id: r.cell?.key,
        issues: r.issues,
        warnings: r.warnings,
        attenuations: r.attenuations,
        ...(guidance ? { guidance } : {}),
      });
    }
    case "recall_semantic": {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const minScore = typeof args.minScore === "number" ? args.minScore : undefined;
      const hits = semanticSearch(query, store, { limit, minScore }).map((h) => ({
        key: h.cell.key,
        handle: h.cell.handle,
        title: h.cell.title,
        score: round2(h.score),
        backend: h.backend,
      }));
      return JSON.stringify(hits);
    }
    case "recall_ref": {
      const reference = String(args.reference ?? "");
      const res = resolveCellReference(reference, store);
      if (res.cell !== null) {
        const view = cellReferenceView(res.cell, reference);
        return JSON.stringify({ targetId: view.targetId, handle: view.handle, path: view.path, value: view.value, resolved: true });
      }
      return JSON.stringify({ targetId: res.targetId, resolved: false });
    }
    case "recall_page": {
      const pageName = String(args.name ?? "");
      const validNames: PageName[] = [
        "index", "reflections", "objectives", "workbench", "witnesses",
        "handoffs", "team-metrics", "agent-profile", "user-profile",
      ];
      if (!validNames.includes(pageName as PageName)) {
        return JSON.stringify({ error: `unknown page: ${pageName}` });
      }
      const filter: PageFilter = {};
      if (typeof args.project === "string") filter.project = args.project;
      if (Array.isArray(args.topics)) filter.topics = args.topics as string[];
      if (typeof args.since === "string") filter.since = args.since;
      if (typeof args.limit === "number") filter.limit = args.limit;
      const page = getRecallPage(pageName as PageName, store, filter);
      return JSON.stringify(page);
    }
    case "recall_hyperedge_add": {
      const input: HyperedgeInput = {
        kind: String(args.kind ?? ""),
        title: String(args.title ?? ""),
        members: Array.isArray(args.members) ? (args.members as HyperedgeInput["members"]) : [],
        metadata: args.metadata && typeof args.metadata === "object" ? (args.metadata as Record<string, unknown>) : undefined,
      };
      const hyperedge = addHyperedge(store, input);
      return JSON.stringify(hyperedge);
    }
    case "recall_hyperedge_show": {
      const id = String(args.id ?? "");
      const hyperedge = store.getHyperedge(id);
      if (!hyperedge) return JSON.stringify({ error: `unknown hyperedge: ${id}` });
      return JSON.stringify(hyperedge);
    }
    case "recall_hyperedge_list": {
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const forCell = typeof args.forCell === "string" ? args.forCell : undefined;
      const hyperedges = forCell ? store.hyperedgesForCell(forCell, limit) : store.listHyperedges(limit);
      return JSON.stringify(hyperedges);
    }
    case "recall_dag_analyze": {
      const id = String(args.id ?? "");
      const overlay = store.getDagOverlay(id);
      if (!overlay) return JSON.stringify({ error: `unknown dag overlay: ${id}` });
      const analysis = analyzeDagOverlay(overlay);
      if (args.derive !== true) return JSON.stringify({ analysis });
      const now = new Date().toISOString();
      const results = dagAnalysisToKeyedProposals(analysis).map((kp) => deriveAdmit(store, kp.proposal, kp.key, now));
      return JSON.stringify({ analysis, derived: summarizeDerived(results) });
    }
    case "recall_program_run": {
      const key = String(args.key ?? "");
      const program = resolveCell(store, key);
      if (!program) return JSON.stringify({ error: `unknown program: ${key}` });
      const now = new Date().toISOString();
      const { run, derived } = runProgramCell(store, program, now, { derive: args.derive === true });
      return JSON.stringify({
        id: run.id,
        operation: run.operation,
        tripped: run.output.tripped,
        witness: run.output.witness?.title,
        derived: derived
          ? { accepted: derived.accepted, duplicateOf: derived.duplicateOf }
          : undefined,
      });
    }
    case "recall_program_runs": {
      if (!("listProgramRuns" in store)) {
        return JSON.stringify({ error: "program run history is unavailable on this store" });
      }
      const key = typeof args.key === "string" ? args.key : undefined;
      const programKey = key ? resolveCell(store, key)?.key : undefined;
      if (key && !programKey) return JSON.stringify({ error: `unknown program: ${key}` });
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const runs = (store as SqliteStore).listProgramRuns({ programKey, limit });
      return JSON.stringify(
        runs.map((run) => ({
          id: run.id,
          operation: run.operation,
          tripped: run.output.tripped,
          witness: run.output.witness?.title,
        })),
      );
    }
    case "recall_eval_run": {
      const derive = args.derive === true;
      const now = new Date();
      if (derive) {
        const { result, derived } = runEvalAndDerive(store, undefined, now, {
          project: typeof args.project === "string" ? args.project : undefined,
        });
        return JSON.stringify({
          name: result.name,
          passed: result.passed,
          score: result.score,
          cases: result.cases.map((c) => ({ name: c.name, passed: c.passed })),
          derived: { accepted: derived.accepted, duplicateOf: derived.duplicateOf },
        });
      }
      const result = runAndRecordEval(store, undefined, now);
      return JSON.stringify({
        name: result.name,
        passed: result.passed,
        score: result.score,
        cases: result.cases.map((c) => ({ name: c.name, passed: c.passed })),
      });
    }
    case "recall_subgraph": {
      const filter: SubgraphFilter = {};
      if (Array.isArray(args.kinds)) filter.kinds = args.kinds as SubgraphFilter["kinds"];
      if (typeof args.project === "string") filter.project = args.project;
      if (Array.isArray(args.topics)) filter.topics = args.topics as string[];
      if (Array.isArray(args.entities)) filter.entities = args.entities as string[];
      if (typeof args.since === "string") filter.since = args.since;
      if (typeof args.limit === "number") filter.limit = args.limit;
      const cells = subgraphCells(store, filter).map((c) => ({
        key: c.key,
        handle: c.handle,
        kind: c.kind,
        title: c.title,
        updatedAt: c.updatedAt,
      }));
      return JSON.stringify(cells);
    }
    case "recall_deltas": {
      const target = String(args.target ?? "");
      if (target === "") throw new Error("missing string param: target");
      const rows = valueSeries(store, target, {
        topic: args.topic === true,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      if (args.csv === true) return renderDeltasCsv(rows);
      return JSON.stringify({ rows });
    }
    case "recall_health": {
      const now = new Date();
      const report = analyzeMemory(store, now);
      if (args.derive !== true) return JSON.stringify(report);
      const proposal = memoryHealthToProposal(report, {});
      const derived = deriveAdmit(store, proposal, memoryHealthDerivationKey(now), now.toISOString());
      return JSON.stringify({ ...report, derived: { accepted: derived.accepted, duplicateOf: derived.duplicateOf } });
    }
    case "recall_storage": {
      if (!("storageStats" in store)) {
        return JSON.stringify({ error: "storage stats are unavailable on this store" });
      }
      return JSON.stringify((store as SqliteStore).storageStats());
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
    // Passed through unvalidated: schema rejects a present non-object props,
    // so a malformed value surfaces as a fill-or-reject issue, not a drop.
    props: args.props === undefined ? undefined : (args.props as WriteProposal["props"]),
    value: typeof args.value === "number" ? args.value : undefined,
    programs: Array.isArray(args.programs) ? (args.programs as string[]) : undefined,
    hyperedges: Array.isArray(args.hyperedges) ? (args.hyperedges as WriteProposal["hyperedges"]) : undefined,
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
function summarizeDerived(results: AdmissionResult[]): { accepted: number; duplicates: number; rejected: number } {
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const result of results) {
    if (!result.accepted) rejected += 1;
    else if (result.duplicateOf) duplicates += 1;
    else accepted += 1;
  }
  return { accepted, duplicates, rejected };
}
