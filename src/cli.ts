#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { admitWriteProposal } from "./core/admission.js";
import { compileContext, formatContextPacket } from "./core/context-compiler.js";
import { runDaemonOnce } from "./core/daemon.js";
import { defaultEvalSuite, type RecallEvalSuite } from "./core/evals.js";
import { validateWriteProposal } from "./core/schema.js";
import { SecretGraphStore } from "./core/secrets.js";
import { installLaunchAgent, launchAgentStatus, renderLaunchAgentPlist, uninstallLaunchAgent } from "./core/service.js";
import { SQLiteRecallStore, type DagOverlayInput, type HyperedgeInput } from "./core/store.js";
import { renderTui } from "./core/tui.js";
import type { HyperedgeProgramSpec } from "./core/types.js";

interface ParsedArgs {
  command: string[];
  db: string;
  secretsDb: string;
  jsonPath?: string;
  words: number;
  query?: string;
  review: boolean;
  title?: string;
  tags: string[];
  scope: string;
  category: string[];
  type: string[];
  subject: string[];
  project: string[];
  idea: string[];
  timestamp: string[];
  topics: string[];
  entities: string[];
  identities: string[];
  rings: string[];
  passwordStdin: boolean;
  valueStdin: boolean;
  confirmSecretSave: boolean;
  intervalMs: number;
  label?: string;
  launchAgentsDir?: string;
  nodeBin: string;
  cwd: string;
  limit: number;
  watch: boolean;
  derive: boolean;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.command;

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "secrets") {
    handleSecrets(args);
    return;
  }

  if (command === "mcp" && subcommand === "config") {
    console.log(JSON.stringify(mcpConfig(args.db), null, 2));
    return;
  }

  if (command === "daemon" && subcommand === "plist") {
    console.log(renderLaunchAgentPlist(launchAgentOptions(args)));
    return;
  }

  if (command === "daemon" && subcommand === "install") {
    console.log(JSON.stringify(installLaunchAgent(launchAgentOptions(args)), null, 2));
    return;
  }

  if (command === "daemon" && subcommand === "uninstall") {
    console.log(JSON.stringify(uninstallLaunchAgent(args.label, args.launchAgentsDir), null, 2));
    return;
  }

  if (command === "daemon" && subcommand === "service-status") {
    console.log(JSON.stringify(launchAgentStatus(args.label, args.launchAgentsDir), null, 2));
    return;
  }

  const store = new SQLiteRecallStore(args.db);
  try {
    if (command === "init") {
      console.log(JSON.stringify({ status: "initialized", db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "status") {
      console.log(JSON.stringify({ db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "tui") {
      if (args.watch) {
        runTuiLoop(store, args.intervalMs);
      }
      console.log(renderTui(store));
      return;
    }

    if (command === "validate") {
      const proposal = readJsonArg(args);
      const result = validateWriteProposal(proposal);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (command === "admit" || command === "write-propose") {
      const proposal = readJsonArg(args);
      const result = admitWriteProposal(proposal, store, { overrideReview: args.review });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.accepted ? 0 : 1;
      return;
    }

    if (command === "search") {
      const query = args.query ?? args.command.slice(1).join(" ");
      const results = store.search(query, 20);
      console.log(JSON.stringify({ query, results }, null, 2));
      return;
    }

    if (command === "semantic" && subcommand === "reindex") {
      console.log(JSON.stringify(store.reindexSemantic(), null, 2));
      return;
    }

    if (command === "semantic") {
      const query = args.query ?? args.command.slice(1).join(" ");
      const results = store.semanticSearch(query, 20);
      console.log(JSON.stringify({ query, results }, null, 2));
      return;
    }

    if (command === "subgraph") {
      const results = store.subgraph({
        category: args.category,
        type: args.type,
        subject: args.subject,
        project: args.project,
        idea: args.idea,
        timestamp: args.timestamp,
        topics: args.topics,
        entities: args.entities,
        identities: args.identities,
        rings: args.rings,
        limit: 50
      });
      console.log(JSON.stringify({ filter: subgraphFilterForOutput(args), results }, null, 2));
      return;
    }

    if (command === "compile") {
      const task = args.query ?? args.command.slice(1).join(" ");
      const packet = compileContext(store, { task, budgetWords: args.words });
      console.log(formatContextPacket(packet));
      return;
    }

    if (command === "rollback" && subcommand === "list") {
      console.log(JSON.stringify({ rollback: store.listRollback() }, null, 2));
      return;
    }

    if (command === "rollback" && subcommand === "show") {
      const id = requireCommandValue(args.command, 2, "rollback id");
      console.log(JSON.stringify(store.applyRollback(id, false), null, 2));
      return;
    }

    if (command === "rollback" && subcommand === "apply") {
      const id = requireCommandValue(args.command, 2, "rollback id");
      console.log(JSON.stringify(store.applyRollback(id, true), null, 2));
      return;
    }

    if (command === "hyperedge" && subcommand === "add") {
      console.log(JSON.stringify(store.addHyperedge(readJsonArg(args) as HyperedgeInput), null, 2));
      return;
    }

    if (command === "hyperedge" && subcommand === "show") {
      const hyperedgeId = requireCommandValue(args.command, 2, "hyperedge id");
      console.log(JSON.stringify(store.getHyperedge(hyperedgeId), null, 2));
      return;
    }

    if (command === "hyperedge" && (!subcommand || subcommand === "list")) {
      console.log(JSON.stringify({ hyperedges: store.listHyperedges(args.limit) }, null, 2));
      return;
    }

    if (command === "program" && subcommand === "add") {
      const hyperedgeId = requireCommandValue(args.command, 2, "hyperedge id");
      console.log(JSON.stringify(store.attachProgram(hyperedgeId, readJsonArg(args) as HyperedgeProgramSpec), null, 2));
      return;
    }

    if (command === "program" && subcommand === "show") {
      const programId = requireCommandValue(args.command, 2, "program id");
      console.log(JSON.stringify(store.getProgram(programId), null, 2));
      return;
    }

    if (command === "program" && (!subcommand || subcommand === "list")) {
      console.log(JSON.stringify({ programs: store.listPrograms(args.limit) }, null, 2));
      return;
    }

    if (command === "program" && subcommand === "run") {
      const programId = requireCommandValue(args.command, 2, "program id");
      console.log(JSON.stringify(args.derive ? store.runProgramAndDerive(programId, derivationOptions(args)) : store.runProgram(programId), null, 2));
      return;
    }

    if (command === "program" && subcommand === "show-run") {
      const runId = requireCommandValue(args.command, 2, "program run id");
      console.log(JSON.stringify(store.getProgramRun(runId), null, 2));
      return;
    }

    if (command === "program" && subcommand === "runs") {
      console.log(JSON.stringify({ runs: store.listProgramRuns(args.limit) }, null, 2));
      return;
    }

    if (command === "dag" && subcommand === "add") {
      console.log(JSON.stringify(store.addDagOverlay(readJsonArg(args) as DagOverlayInput), null, 2));
      return;
    }

    if (command === "dag" && subcommand === "show") {
      const overlayId = requireCommandValue(args.command, 2, "DAG overlay id");
      console.log(JSON.stringify(store.getDagOverlay(overlayId), null, 2));
      return;
    }

    if (command === "dag" && subcommand === "analyze") {
      const overlayId = requireCommandValue(args.command, 2, "DAG overlay id");
      console.log(JSON.stringify(args.derive ? store.analyzeDagOverlayAndDerive(overlayId, dagDerivationOptions(args)) : store.analyzeDagOverlay(overlayId), null, 2));
      return;
    }

    if (command === "dag" && (!subcommand || subcommand === "list")) {
      console.log(JSON.stringify({ overlays: store.listDagOverlays(args.limit) }, null, 2));
      return;
    }

    if (command === "eval" && (!subcommand || subcommand === "run")) {
      const suite = args.jsonPath ? (readJsonArg(args) as RecallEvalSuite) : defaultEvalSuite();
      console.log(JSON.stringify(args.derive ? store.runEvalAndDerive(suite, derivationOptions(args)) : store.runEval(suite), null, 2));
      return;
    }

    if (command === "eval" && subcommand === "list") {
      console.log(JSON.stringify({ evalRuns: store.listEvalRuns(args.limit) }, null, 2));
      return;
    }

    if (command === "eval" && subcommand === "show") {
      const evalRunId = requireCommandValue(args.command, 2, "eval run id");
      console.log(JSON.stringify(store.getEvalRun(evalRunId), null, 2));
      return;
    }

    if (command === "daemon" && (!subcommand || subcommand === "status")) {
      console.log(JSON.stringify({ mode: "outside-llm", db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "daemon" && subcommand === "run-once") {
      console.log(JSON.stringify(runDaemonOnce(store, new Date(), { derive: args.derive }), null, 2));
      return;
    }

    if (command === "daemon" && subcommand === "run") {
      runDaemonLoop(store, args.intervalMs, args.derive);
      return;
    }

    fail(`Unknown command: ${args.command.join(" ")}`);
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let db = ".recall/recall.sqlite3";
  let secretsDb = ".recall/secrets.sqlite3";
  let jsonPath: string | undefined;
  let words = 900;
  let query: string | undefined;
  let review = false;
  let title: string | undefined;
  let tags: string[] = [];
  let scope = "local";
  let category: string[] = [];
  let type: string[] = [];
  let subject: string[] = [];
  let project: string[] = [];
  let idea: string[] = [];
  let timestamp: string[] = [];
  let topics: string[] = [];
  let entities: string[] = [];
  let identities: string[] = [];
  let rings: string[] = [];
  let passwordStdin = false;
  let valueStdin = false;
  let confirmSecretSave = false;
  let intervalMs = 60_000;
  let label: string | undefined;
  let launchAgentsDir: string | undefined;
  let nodeBin = process.execPath;
  let cwd = process.cwd();
  let limit = 20;
  let watch = false;
  let derive = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      db = requireValue(argv, ++index, "--db");
    } else if (arg === "--secrets-db") {
      secretsDb = requireValue(argv, ++index, "--secrets-db");
    } else if (arg === "--json") {
      jsonPath = requireValue(argv, ++index, "--json");
    } else if (arg === "--words") {
      words = Number.parseInt(requireValue(argv, ++index, "--words"), 10);
    } else if (arg === "--query") {
      query = requireValue(argv, ++index, "--query");
    } else if (arg === "--review") {
      review = true;
    } else if (arg === "--title") {
      title = requireValue(argv, ++index, "--title");
    } else if (arg === "--tags") {
      tags = splitCsv(requireValue(argv, ++index, "--tags"));
    } else if (arg === "--scope") {
      scope = requireValue(argv, ++index, "--scope");
    } else if (arg === "--category" || arg === "--categories") {
      category = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--type" || arg === "--types") {
      type = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--subject" || arg === "--subjects") {
      subject = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--project" || arg === "--projects") {
      project = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--idea" || arg === "--ideas") {
      idea = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--timestamp" || arg === "--timestamps") {
      timestamp = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--topic" || arg === "--topics") {
      topics = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--entity" || arg === "--entities") {
      entities = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--identity" || arg === "--identities") {
      identities = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--ring" || arg === "--rings") {
      rings = splitCsv(requireValue(argv, ++index, arg));
    } else if (arg === "--password-stdin") {
      passwordStdin = true;
    } else if (arg === "--value-stdin") {
      valueStdin = true;
    } else if (arg === "--confirm-secret-save") {
      confirmSecretSave = true;
    } else if (arg === "--interval-ms") {
      intervalMs = Number.parseInt(requireValue(argv, ++index, "--interval-ms"), 10);
    } else if (arg === "--label") {
      label = requireValue(argv, ++index, "--label");
    } else if (arg === "--launch-agents-dir") {
      launchAgentsDir = requireValue(argv, ++index, "--launch-agents-dir");
    } else if (arg === "--node-bin") {
      nodeBin = requireValue(argv, ++index, "--node-bin");
    } else if (arg === "--cwd") {
      cwd = requireValue(argv, ++index, "--cwd");
    } else if (arg === "--limit") {
      limit = Number.parseInt(requireValue(argv, ++index, "--limit"), 10);
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--derive") {
      derive = true;
    } else {
      command.push(arg);
    }
  }

  if (!Number.isFinite(words) || words <= 0) {
    fail("--words must be a positive integer");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    fail("--interval-ms must be a positive integer");
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    fail("--limit must be a positive integer");
  }

  return {
    command,
    db,
    secretsDb,
    jsonPath,
    words,
    query,
    review,
    title,
    tags,
    scope,
    category,
    type,
    subject,
    project,
    idea,
    timestamp,
    topics,
    entities,
    identities,
    rings,
    passwordStdin,
    valueStdin,
    confirmSecretSave,
    intervalMs,
    label,
    launchAgentsDir,
    nodeBin,
    cwd,
    limit,
    watch,
    derive
  };
}

function handleSecrets(args: ParsedArgs): void {
  const [, subcommand, id] = args.command;
  const secrets = new SecretGraphStore(args.secretsDb);
  try {
    if (!subcommand || subcommand === "status") {
      console.log(JSON.stringify({ db: args.secretsDb, stats: secrets.stats() }, null, 2));
      return;
    }

    if (subcommand === "list") {
      console.log(JSON.stringify({ db: args.secretsDb, secrets: secrets.list() }, null, 2));
      return;
    }

    if (subcommand === "save") {
      if (!args.confirmSecretSave) {
        fail("Refusing to save secret without --confirm-secret-save");
      }
      if (!args.title) {
        fail("Expected --title for secrets save");
      }
      if (!args.passwordStdin || !args.valueStdin) {
        fail("secrets save requires --password-stdin and --value-stdin. Stdin format: first line password, remaining bytes secret.");
      }
      const bundle = readPasswordAndRemainingStdin();
      const node = secrets.save({
        title: args.title,
        plaintext: bundle.remaining,
        password: bundle.password,
        tags: args.tags,
        scope: args.scope
      });
      console.log(JSON.stringify({ saved: true, secret: node }, null, 2));
      return;
    }

    if (subcommand === "get") {
      if (!id) {
        fail("Expected secret id for secrets get");
      }
      if (!args.passwordStdin) {
        fail("secrets get requires --password-stdin");
      }
      const password = readPasswordLineFromStdin();
      const node = secrets.get(id, password);
      if (!node) {
        fail(`Secret not found: ${id}`);
      }
      console.log(JSON.stringify(node, null, 2));
      return;
    }

    fail(`Unknown secrets command: ${args.command.join(" ")}`);
  } finally {
    secrets.close();
  }
}

function readJsonArg(args: ParsedArgs): unknown {
  if (!args.jsonPath) {
    fail("Expected --json <path>");
  }
  return JSON.parse(readFileSync(args.jsonPath, "utf8"));
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    fail(`Expected value after ${flag}`);
  }
  return value;
}

function requireCommandValue(command: string[], index: number, label: string): string {
  const value = command[index];
  if (!value) {
    fail(`Expected ${label}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Recall CLI

Commands:
  recall init [--db path]
  recall status [--db path]
  recall validate --json proposal.json [--db path]
  recall admit --json proposal.json [--db path] [--review]        agent/debug path; normal memory uses MCP recall_write
  recall write-propose --json proposal.json [--db path] [--review] agent/debug alias; not the user-facing memory flow
  recall search "query" [--db path]
  recall semantic "query" [--db path]
  recall semantic reindex [--db path]
  recall subgraph [--category memory] [--type witness] [--subject compiler] [--project Recall] [--idea active-memory] [--timestamp 2026-05-21]
  recall subgraph [--topic a,b] [--entity x] [--identity agent:codex] [--ring runtime]
  recall compile "task" [--words 900] [--db path]
  recall rollback list [--db path]
  recall rollback show <journal-id> [--db path]
  recall rollback apply <journal-id> [--db path]
  recall hyperedge add --json hyperedge.json [--db path]
  recall hyperedge show <hyperedge-id> [--db path]
  recall hyperedge list [--limit 20] [--db path]
  recall program add <hyperedge-id> --json program.json [--db path]
  recall program list [--limit 20] [--db path]
  recall program show <program-id> [--db path]
  recall program run <program-id> [--derive] [--db path]
  recall program runs [--limit 20] [--db path]
  recall program show-run <program-run-id> [--db path]
  recall dag add --json overlay.json [--db path]
  recall dag show <overlay-id> [--db path]
  recall dag analyze <overlay-id> [--derive] [--db path]
  recall dag list [--limit 20] [--db path]
  recall eval run [--derive] [--json suite.json] [--db path]
  recall eval list [--limit 20] [--db path]
  recall eval show <eval-run-id> [--db path]
  recall mcp config [--db path]
  recall tui [--watch] [--interval-ms 5000] [--db path]
  recall daemon status [--db path]
  recall daemon plist [--db path] [--interval-ms 60000]
  recall daemon install [--db path] [--interval-ms 60000]
  recall daemon service-status
  recall daemon uninstall
  recall daemon run-once [--derive] [--db path]
  recall daemon run [--derive] [--interval-ms 60000] [--db path]
  recall secrets status [--secrets-db path]
  recall secrets list [--secrets-db path]
  recall secrets save --title "name" --confirm-secret-save --password-stdin --value-stdin [--tags a,b] [--scope local]
    stdin format for save: first line password, remaining bytes secret
  recall secrets get <id> --password-stdin [--secrets-db path]
`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function subgraphFilterForOutput(args: ParsedArgs): Record<string, string[]> {
  return {
    category: args.category,
    type: args.type,
    subject: args.subject,
    project: args.project,
    idea: args.idea,
    timestamp: args.timestamp,
    topics: args.topics,
    entities: args.entities,
    identities: args.identities,
    rings: args.rings
  };
}

function runDaemonLoop(store: SQLiteRecallStore, intervalMs: number, derive: boolean): never {
  console.error(`Recall daemon running outside the LLM every ${intervalMs}ms. Press Ctrl-C to stop.`);
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepArray = new Int32Array(sleepBuffer);
  for (;;) {
    console.log(JSON.stringify(runDaemonOnce(store, new Date(), { derive }), null, 2));
    Atomics.wait(sleepArray, 0, 0, intervalMs);
  }
}

function runTuiLoop(store: SQLiteRecallStore, intervalMs: number): never {
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepArray = new Int32Array(sleepBuffer);
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(renderTui(store));
    Atomics.wait(sleepArray, 0, 0, intervalMs);
  }
}

function launchAgentOptions(args: ParsedArgs) {
  return {
    label: args.label,
    dbPath: args.db,
    intervalMs: args.intervalMs,
    nodeBin: args.nodeBin,
    cliPath: resolve(process.argv[1] ?? "dist/src/cli.js"),
    cwd: args.cwd,
    launchAgentsDir: args.launchAgentsDir
  };
}

function mcpConfig(db: string): Record<string, unknown> {
  return {
    mcpServers: {
      recall: {
        command: "recall-mcp",
        env: {
          RECALL_DB: db
        }
      }
    }
  };
}

function derivationOptions(args: ParsedArgs) {
  return {
    scope: {
      project: args.project[0] ?? "Recall",
      tenant: args.scope,
      session: "cli-derivation"
    },
    actorId: "recall-cli",
    actorDisplay: "Recall CLI",
    producedBy: "recall-cli"
  };
}

function dagDerivationOptions(args: ParsedArgs) {
  return {
    ...derivationOptions(args),
    createdAt: new Date().toISOString()
  };
}

function readPasswordAndRemainingStdin(): { password: string; remaining: string } {
  const stdin = readFileSync(0, "utf8");
  const newline = stdin.indexOf("\n");
  if (newline === -1) {
    fail("Expected first stdin line to be password and remaining stdin to be secret value");
  }
  const password = stdin.slice(0, newline).trimEnd();
  const remaining = stdin.slice(newline + 1);
  if (remaining.length === 0) {
    fail("Secret value cannot be empty");
  }
  return { password, remaining };
}

function readPasswordLineFromStdin(): string {
  const stdin = readFileSync(0, "utf8");
  const newline = stdin.indexOf("\n");
  const password = (newline === -1 ? stdin : stdin.slice(0, newline)).trimEnd();
  if (password.length === 0) {
    fail("Password cannot be empty");
  }
  return password;
}

main();
