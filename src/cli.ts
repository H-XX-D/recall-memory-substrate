#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// R8 CLI surface over the implemented v5 core. Server, TUI, import adapters,
// and installer sync commands stay deferred; this is the npm/bin entry point.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { admit } from "./admission.js";
import {
  exportCellArchive,
  importAutoMemory,
  importCellArchive,
  importMem0,
  importZep,
  readJsonFile,
} from "./adapters.js";
import { migrate } from "./migrate.js";
import { analyzeMemory, memoryHealthToProposal } from "./analysis.js";
import { addDagOverlay, analyzeDagOverlay, type DagOverlayInput } from "./dag.js";
import { dagAnalysisToKeyedProposals, deriveAdmit } from "./derivation.js";
import { runAndRecordEval, runEvalAndDerive, type RecallEvalSuite } from "./evals.js";
import { addHyperedge, type HyperedgeInput } from "./hyperedges.js";
import { inspectCell, resolveCell } from "./cell-context.js";
import { compileContext, formatContextPacket } from "./compile.js";
import { FederatedReadStore } from "./federated-store.js";
import { runOperatorCycle } from "./operator.js";
import { runProgramCell } from "./programs.js";
import { serializeGraph, parseNetlist, loadNetlist, type LoadMode } from "./netlist.js";
import {
  homeDbPath,
  listProjects,
  localGraphPaths,
  registerProject,
  registryDbPath,
  resolveDbForSlug,
  whereProject,
} from "./routing.js";
import { validateProposal } from "./schema.js";
import { SqliteStore } from "./store.js";
import type { AdmissionResult, Store, WriteProposal } from "./types.js";

export const CLI_NAME = "recall-memory-substrate";
export const CLI_VERSION = "0.7.0";

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface RunCliOptions extends CliIo {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}

interface ParsedArgs {
  command: string[];
  db?: string;
  from?: string;
  project?: string;
  jsonPath?: string;
  slug?: string;
  description?: string;
  root?: string;
  file?: string;
  mode?: string;
  derive: boolean;
  apply: boolean;
  words: number;
  limit: number;
  noHealth: boolean;
  inlineRefs: boolean;
  refParams: boolean;
}

interface Route {
  scope: "explicit" | "project" | "home";
  dbPath: string;
  reason: string;
  slug?: string;
}

export function runCli(argv: string[], options: RunCliOptions = {}): number {
  const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  try {
    const args = parseArgs(argv);
    const [command, subcommand] = args.command;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      out(helpText());
      return 0;
    }
    if (command === "version" || command === "--version" || command === "-v") {
      out(`${JSON.stringify({ name: CLI_NAME, version: CLI_VERSION })}\n`);
      return 0;
    }

    if (command === "project" && (!subcommand || subcommand === "list")) {
      outJson(out, { projects: listProjects(registryDbPath(env)) });
      return 0;
    }
    if ((command === "project" && subcommand === "where") || command === "where") {
      outJson(out, routeOutput(resolveRoute(args, cwd, env), env));
      return 0;
    }
    if ((command === "project" && subcommand === "init") || command === "init") {
      const record = registerProject(
        {
          root: args.root ?? cwd,
          slug: args.slug,
          dbPath: args.db,
          description: args.description,
        },
        options.now ?? new Date().toISOString(),
        registryDbPath(env),
      );
      ensureDbParent(record.dbPath);
      const store = new SqliteStore(record.dbPath);
      try {
        outJson(out, { status: "initialized", project: record, stats: store.stats() });
      } finally {
        store.close();
      }
      return 0;
    }

    if (command === "validate") {
      const proposal = readProposal(args);
      const result = validateProposal(proposal);
      outJson(out, result);
      return result.ok ? 0 : 1;
    }

    const route = resolveRoute(args, cwd, env);
    if (command === "status") {
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, { name: CLI_NAME, version: CLI_VERSION, route: routeOutput(route, env), stats: store.stats() });
      } finally {
        store.close();
      }
      return 0;
    }

    if (command === "admit" || command === "write-propose") {
      const proposal = readProposal(args);
      const store = openWriteStore(route.dbPath);
      try {
        const result = admit(proposal, { store, now: options.now });
        outJson(out, result);
        return result.accepted ? 0 : 1;
      } finally {
        store.close();
      }
    }

    if (command === "export") {
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, exportCellArchive(store, options.now ?? new Date().toISOString()));
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "import") {
      const store = openWriteStore(route.dbPath);
      try {
        if (subcommand === "archive") {
          outJson(out, importCellArchive(store, readJsonValue(args, "archive import"), { apply: args.apply }));
          return 0;
        }
        if (subcommand === "mem0") {
          outJson(out, importMem0(store, readJsonValue(args, "mem0 import"), {
            apply: args.apply,
            now: options.now,
            project: route.slug ?? args.project,
          }));
          return 0;
        }
        if (subcommand === "zep") {
          outJson(out, importZep(store, readJsonValue(args, "zep import"), {
            apply: args.apply,
            now: options.now,
            project: route.slug ?? args.project,
          }));
          return 0;
        }
        if (subcommand === "auto-memory") {
          if (!args.root) throw new Error("import auto-memory requires --root <path>");
          outJson(out, importAutoMemory(store, args.root, {
            apply: args.apply,
            now: options.now,
            project: route.slug ?? args.project,
          }));
          return 0;
        }
        throw new Error("import requires one of: archive, mem0, zep, auto-memory");
      } finally {
        store.close();
      }
    }

    if (command === "compile") {
      const objective = queryFrom(args, 1, "compile requires a task");
      return withReadStore(args, route, env, (store) => {
        out(`${formatContextPacket(compileContext(store, objective, {
          budgetWords: args.words,
          limit: args.limit,
          includeHealth: !args.noHealth,
          inlineReferenceValues: args.inlineRefs,
          includeReferenceParameters: args.refParams,
        }))}\n`);
        return 0;
      });
    }

    if (command === "search") {
      const query = queryFrom(args, 1, "search requires a query");
      return withReadStore(args, route, env, (store) => {
        outJson(out, { query, hits: store.search(query, { limit: args.limit }) });
        return 0;
      });
    }

    if (command === "cell" && (!subcommand || subcommand === "show")) {
      const target = args.command[subcommand === "show" ? 2 : 1];
      if (!target) throw new Error("cell show requires a key or handle");
      return withReadStore(args, route, env, (store) => {
        outJson(out, inspectCell(store, target));
        return 0;
      });
    }

    if (command === "hyperedge" && subcommand === "add") {
      const input = readJsonValue(args, "hyperedge add") as HyperedgeInput;
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, addHyperedge(store, input, options.now));
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "hyperedge" && subcommand === "show") {
      const id = args.command[2];
      if (!id) throw new Error("hyperedge show requires an id");
      return withReadStore(args, route, env, (store) => {
        const hyperedge = store.getHyperedge(id);
        if (!hyperedge) throw new Error(`Unknown hyperedge: ${id}`);
        outJson(out, hyperedge);
        return 0;
      });
    }

    if (command === "hyperedge" && subcommand === "list") {
      return withReadStore(args, route, env, (store) => {
        outJson(out, { hyperedges: store.listHyperedges(args.limit) });
        return 0;
      });
    }

    if (command === "dag" && subcommand === "add") {
      const input = readJsonValue(args, "dag add") as DagOverlayInput;
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, addDagOverlay(store, input, options.now));
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "dag" && subcommand === "show") {
      const id = args.command[2];
      if (!id) throw new Error("dag show requires an id");
      return withReadStore(args, route, env, (store) => {
        const overlay = store.getDagOverlay(id);
        if (!overlay) throw new Error(`Unknown dag overlay: ${id}`);
        outJson(out, overlay);
        return 0;
      });
    }

    if (command === "dag" && subcommand === "list") {
      return withReadStore(args, route, env, (store) => {
        outJson(out, { dagOverlays: store.listDagOverlays(args.limit) });
        return 0;
      });
    }

    if (command === "dag" && subcommand === "analyze") {
      const id = args.command[2];
      if (!id) throw new Error("dag analyze requires an id");
      if (!args.derive) {
        return withReadStore(args, route, env, (store) => {
          const overlay = store.getDagOverlay(id);
          if (!overlay) throw new Error(`Unknown dag overlay: ${id}`);
          outJson(out, analyzeDagOverlay(overlay));
          return 0;
        });
      }
      const store = openWriteStore(route.dbPath);
      try {
        const overlay = store.getDagOverlay(id);
        if (!overlay) throw new Error(`Unknown dag overlay: ${id}`);
        const analysis = analyzeDagOverlay(overlay);
        const now = options.now ?? new Date().toISOString();
        const results = dagAnalysisToKeyedProposals(analysis, { project: route.slug ?? args.project }).map((kp) =>
          deriveAdmit(store, kp.proposal, kp.key, now),
        );
        outJson(out, { analysis, derived: summarizeDerived(results) });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "program" && subcommand === "run") {
      const target = args.command[2];
      if (!target) throw new Error("program run requires a key or handle");
      const store = openWriteStore(route.dbPath);
      try {
        const program = resolveCell(store, target);
        if (!program) throw new Error(`unknown program: ${target}`);
        const now = options.now ?? new Date().toISOString();
        const { run, derived } = runProgramCell(store, program, now, { derive: args.derive });
        outJson(out, {
          run,
          derived: derived ? { accepted: derived.accepted, duplicateOf: derived.duplicateOf } : undefined,
        });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "program" && subcommand === "list") {
      return withReadStore(args, route, env, (store) => {
        const programs = store
          .active()
          .filter((cell) => cell.kind === "prg" && cell.props.program !== undefined)
          .map((cell) => {
            const spec = cell.props.program as { operation?: string; description?: string };
            return {
              key: cell.key,
              handle: cell.handle,
              operation: spec?.operation,
              description: spec?.description,
              runCount: typeof cell.props.runCount === "number" ? cell.props.runCount : 0,
            };
          });
        outJson(out, { programs });
        return 0;
      });
    }

    if (command === "program" && subcommand === "runs") {
      const target = args.command[2];
      const store = openWriteStore(route.dbPath);
      try {
        if (!("listProgramRuns" in store)) throw new Error("program run history is unavailable on this store");
        let programKey: string | undefined;
        if (target) {
          const program = resolveCell(store, target);
          if (!program) throw new Error(`unknown program: ${target}`);
          programKey = program.key;
        }
        const runs = store.listProgramRuns({ programKey, limit: args.limit });
        outJson(out, { runs });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "program" && subcommand === "show-run") {
      const id = args.command[2];
      if (!id) throw new Error("program show-run requires an id");
      const store = openWriteStore(route.dbPath);
      try {
        if (!("getProgramRun" in store)) throw new Error("program run history is unavailable on this store");
        const run = store.getProgramRun(id);
        if (!run) throw new Error(`Unknown program run: ${id}`);
        outJson(out, run);
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "eval" && subcommand === "run") {
      const suite = args.jsonPath ? readEvalSuite(args) : undefined;
      const store = openWriteStore(route.dbPath);
      try {
        const now = options.now ? new Date(options.now) : new Date();
        if (args.derive) {
          const { result, derived } = runEvalAndDerive(store, suite, now);
          outJson(out, { ...result, derived: { accepted: derived.accepted, duplicateOf: derived.duplicateOf } });
        } else {
          const result = runAndRecordEval(store, suite, now);
          outJson(out, result);
        }
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "eval" && subcommand === "list") {
      const store = openWriteStore(route.dbPath);
      try {
        if (!("listEvalRuns" in store)) throw new Error("eval run history is unavailable on this store");
        outJson(out, { runs: store.listEvalRuns(args.limit) });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "eval" && subcommand === "show") {
      const id = args.command[2];
      if (!id) throw new Error("eval show requires an id");
      const store = openWriteStore(route.dbPath);
      try {
        if (!("getEvalRun" in store)) throw new Error("eval run history is unavailable on this store");
        const run = store.getEvalRun(id);
        if (!run) throw new Error(`Unknown eval run: ${id}`);
        outJson(out, run);
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "health") {
      if (!args.derive) {
        return withReadStore(args, route, env, (store) => {
          outJson(out, analyzeMemory(store, options.now ? new Date(options.now) : undefined));
          return 0;
        });
      }
      const store = openWriteStore(route.dbPath);
      try {
        const now = options.now ? new Date(options.now) : new Date();
        const report = analyzeMemory(store, now);
        const proposal = memoryHealthToProposal(report, { project: route.slug ?? args.project });
        const derived = admit(proposal, { store, now: now.toISOString() });
        outJson(out, { report, derive: derived });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "operate" && (!subcommand || subcommand === "once")) {
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, runOperatorCycle(store, options.now ?? new Date().toISOString(), { derive: args.derive }));
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "operate" && subcommand === "list") {
      const store = openWriteStore(route.dbPath);
      try {
        if (!("listOperatorRuns" in store)) throw new Error("operator run history is unavailable on this store");
        outJson(out, { runs: store.listOperatorRuns(args.limit) });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "operate" && subcommand === "show") {
      const id = args.command[2];
      if (!id) throw new Error("operate show requires an id");
      const store = openWriteStore(route.dbPath);
      try {
        if (!("getOperatorRun" in store)) throw new Error("operator run history is unavailable on this store");
        const run = store.getOperatorRun(id);
        if (!run) throw new Error(`Unknown operator run: ${id}`);
        outJson(out, run);
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "render") {
      const store = openWriteStore(route.dbPath);
      try {
        out(`${serializeGraph(store.active())}\n`);
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "load") {
      if (!args.file) throw new Error("load requires --file <netlist.mal>");
      const mode = (args.mode ?? "replay") as LoadMode;
      if (!["replay", "verify", "merge"].includes(mode)) throw new Error("--mode must be replay, verify, or merge");
      const store = openWriteStore(route.dbPath);
      try {
        const { nodes, errors } = parseNetlist(readFileSync(args.file, "utf8"));
        outJson(out, { parseErrors: errors, ...loadNetlist(nodes, store, mode) });
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "migrate") {
      if (!args.from) throw new Error("migrate requires --from <old.sqlite3>");
      const dbPath = args.db ?? homeDbPath(env);
      const store = openWriteStore(dbPath);
      try {
        const result = migrate(args.from, store, { apply: args.apply });
        outJson(out, result);
        return 0;
      } finally {
        store.close();
      }
    }

    throw new Error(`Unknown command: ${args.command.join(" ")}`);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const parsed: ParsedArgs = { command, derive: false, apply: false, words: 900, limit: 10, noHealth: false, inlineRefs: false, refParams: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") parsed.db = requireValue(argv, ++i, arg);
    else if (arg === "--from") parsed.from = requireValue(argv, ++i, arg);
    else if (arg === "--project") parsed.project = requireValue(argv, ++i, arg);
    else if (arg === "--json") parsed.jsonPath = requireValue(argv, ++i, arg);
    else if (arg === "--slug") parsed.slug = requireValue(argv, ++i, arg);
    else if (arg === "--description") parsed.description = requireValue(argv, ++i, arg);
    else if (arg === "--root") parsed.root = requireValue(argv, ++i, arg);
    else if (arg === "--file") parsed.file = requireValue(argv, ++i, arg);
    else if (arg === "--mode") parsed.mode = requireValue(argv, ++i, arg);
    else if (arg === "--derive") parsed.derive = true;
    else if (arg === "--apply") parsed.apply = true;
    else if (arg === "--no-health") parsed.noHealth = true;
    else if (arg === "--inline-refs") parsed.inlineRefs = true;
    else if (arg === "--ref-params") parsed.refParams = true;
    else if (arg === "--words") parsed.words = positiveInt(requireValue(argv, ++i, arg), arg);
    else if (arg === "--limit") parsed.limit = positiveInt(requireValue(argv, ++i, arg), arg);
    else command.push(arg);
  }
  return parsed;
}

function resolveRoute(args: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): Route {
  if (args.db) return { scope: "explicit", dbPath: args.db, reason: "--db override" };
  if (args.project) {
    const dbPath = resolveDbForSlug(args.project, registryDbPath(env));
    if (!dbPath) throw new Error(`unknown project: ${args.project}`);
    return { scope: "project", dbPath, reason: `--project ${args.project}`, slug: args.project };
  }
  const route = whereProject(cwd, env, registryDbPath(env));
  return {
    scope: route.scope,
    dbPath: route.dbPath,
    reason: route.reason,
    slug: route.project?.slug,
  };
}

function withReadStore<T>(
  args: ParsedArgs,
  route: Route,
  env: NodeJS.ProcessEnv,
  run: (store: Store) => T,
): T {
  if (!args.db && !args.project && route.scope === "home") {
    const store = new FederatedReadStore(localGraphPaths(env, registryDbPath(env)));
    try {
      return run(store);
    } finally {
      store.close();
    }
  }
  const store = openWriteStore(route.dbPath);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function openWriteStore(dbPath: string): SqliteStore {
  ensureDbParent(dbPath);
  return new SqliteStore(dbPath);
}

function summarizeDerived(results: AdmissionResult[]): {
  accepted: number;
  duplicates: number;
  rejected: number;
} {
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

function ensureDbParent(dbPath: string): void {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
}

function routeOutput(route: Route, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {
    scope: route.scope,
    dbPath: route.dbPath,
    reason: route.reason,
  };
  if (route.slug) out.slug = route.slug;
  if (route.scope === "home") {
    const locals = localGraphPaths(env, registryDbPath(env));
    out.unionMembers = locals.length;
    out.locals = locals.map((member) => member.graph);
  }
  return out;
}

function readProposal(args: ParsedArgs): WriteProposal {
  if (!args.jsonPath) throw new Error("--json <proposal.json> is required");
  const text = args.jsonPath === "-" ? readFileSync(0, "utf8") : readFileSync(args.jsonPath, "utf8");
  return JSON.parse(text) as WriteProposal;
}

function readJsonValue(args: ParsedArgs, label: string): unknown {
  if (!args.jsonPath) throw new Error("--json <file> is required");
  if (args.jsonPath === "-") return JSON.parse(readFileSync(0, "utf8")) as unknown;
  return readJsonFile(args.jsonPath, label);
}

// Minimal shape validation for a custom eval suite JSON payload: enough to
// give a clear error before it reaches runRecallEval, not full schema
// validation (case-kind validity is left to runRecallEval's own switch).
function readEvalSuite(args: ParsedArgs): RecallEvalSuite {
  const value = readJsonValue(args, "eval suite");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("eval suite: expected an object with name and cases");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) {
    throw new Error("eval suite: name must be a non-empty string");
  }
  if (!Array.isArray(record.cases)) {
    throw new Error("eval suite: cases must be an array");
  }
  return { name: record.name, cases: record.cases as RecallEvalSuite["cases"] };
}

function outJson(out: (text: string) => void, value: unknown): void {
  out(`${JSON.stringify(value, null, 2)}\n`);
}

function queryFrom(args: ParsedArgs, start: number, error: string): string {
  const query = args.command.slice(start).join(" ").trim();
  if (!query) throw new Error(error);
  return query;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function helpText(): string {
  return `Recall MAL CLI

Commands:
  recall project init [--slug name] [--description text] [--root path] [--db path]
  recall project list
  recall project where
  recall where
  recall status [--db path] [--project slug]
  recall compile "task" [--words 900] [--limit 10] [--no-health] [--inline-refs] [--ref-params] [--db path] [--project slug]
  recall search "query" [--limit 10] [--db path] [--project slug]
  recall cell show <key-or-handle> [--db path] [--project slug]
  recall hyperedge add --json edge.json [--db path] [--project slug]
  recall hyperedge show <id> [--db path] [--project slug]
  recall hyperedge list [--limit 10] [--db path] [--project slug]
  recall dag add --json overlay.json [--db path] [--project slug]
  recall dag show <id> [--db path] [--project slug]
  recall dag list [--limit 10] [--db path] [--project slug]
  recall dag analyze <id> [--derive] [--db path] [--project slug]
  recall program run <key-or-handle> [--derive] [--db path] [--project slug]
  recall program list [--db path] [--project slug]
  recall program runs [<key-or-handle>] [--limit 10] [--db path] [--project slug]
  recall program show-run <id> [--db path] [--project slug]
  recall eval run [--derive] [--json suite.json|-] [--db path] [--project slug]
  recall eval list [--limit 10] [--db path] [--project slug]
  recall eval show <id> [--db path] [--project slug]
  recall health [--derive] [--db path] [--project slug]
  recall operate once [--derive] [--db path] [--project slug]
  recall operate list [--limit 20] [--db path] [--project slug]
  recall operate show <id> [--db path] [--project slug]
  recall render [--db path] [--project slug]
  recall load --file netlist.mal [--mode replay|verify|merge] [--db path] [--project slug]
  recall export [--db path] [--project slug]
  recall import archive --json archive.json [--apply] [--db path] [--project slug]
  recall import mem0 --json mem0.json [--apply] [--db path] [--project slug]
  recall import zep --json zep.json [--apply] [--db path] [--project slug]
  recall import auto-memory --root path [--apply] [--db path] [--project slug]
  recall migrate --from old.sqlite3 [--apply] [--db path]
  recall validate --json proposal.json
  recall admit --json proposal.json [--db path] [--project slug]
  recall version
`;
}

function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return modulePath === realpathSync(entry);
  } catch {
    return modulePath === entry;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
