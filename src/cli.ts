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
import { inspectCell } from "./cell-context.js";
import { compileContext, formatContextPacket } from "./compile.js";
import { FederatedReadStore } from "./federated-store.js";
import { runOperatorCycle } from "./operator.js";
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
import type { Store, WriteProposal } from "./types.js";

export const CLI_NAME = "recall-memory-substrate";
export const CLI_VERSION = "0.6.1";

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
        out(`${formatContextPacket(compileContext(store, objective, { budgetWords: args.words, limit: args.limit }))}\n`);
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

    if (command === "operate" && (!subcommand || subcommand === "once")) {
      const store = openWriteStore(route.dbPath);
      try {
        outJson(out, runOperatorCycle(store, options.now ?? new Date().toISOString(), { derive: args.derive }));
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
  const parsed: ParsedArgs = { command, derive: false, apply: false, words: 900, limit: 10 };
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
  recall compile "task" [--words 900] [--limit 10] [--db path] [--project slug]
  recall search "query" [--limit 10] [--db path] [--project slug]
  recall cell show <key-or-handle> [--db path] [--project slug]
  recall operate once [--derive] [--db path] [--project slug]
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
