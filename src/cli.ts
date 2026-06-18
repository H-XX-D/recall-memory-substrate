#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { admitWriteProposal } from "./core/admission.js";
import { analyzeMemory, memoryHealthToProposal } from "./core/analysis.js";
import { analyzeCalibration } from "./core/calibration.js";
import { inspectCell } from "./core/cell-context.js";
import { compileContext, formatContextPacket } from "./core/context-compiler.js";
import { buildInceptionScaffold } from "./core/inception.js";
import { buildTrendScaffold } from "./core/trend-scaffold.js";
import { runCognitiveTick } from "./core/cognitive.js";
import { enqueueAcpRequest, isAcpRequestAction, isAcpRequestStatus, runAcpCycle } from "./core/acp.js";
import { runAcpLoop } from "./core/acp.js";
import { runDaemonOnce } from "./core/daemon.js";
import { defaultEvalSuite, type RecallEvalSuite } from "./core/evals.js";
import { exportRecallArchive, importRecallArchive } from "./core/export.js";
import { importAutoMemory } from "./core/auto-memory-adapter.js";
import { importMem0 } from "./core/mem0-adapter.js";
import { importZep } from "./core/zep-adapter.js";
import { buildPageIndex, getRecallPage, type RecallPageName } from "./core/pages.js";
import { runOperatingCycle } from "./core/operator.js";
import { validateWriteProposal } from "./core/schema.js";
import { SecretGraphStore } from "./core/secrets.js";
import { installLaunchAgent, launchAgentStatus, renderLaunchAgentPlist, uninstallLaunchAgent } from "./core/service.js";
import { claudeIntegrationStatus, setClaudeAutoMemory, syncClaudeIntegration } from "./core/claude-integration.js";
import { codexIntegrationStatus, syncCodexIntegration } from "./core/codex-integration.js";
import { SQLiteRecallStore, type DagOverlayInput, type HyperedgeInput } from "./core/store.js";
import { storageStats } from "./core/storage-stats.js";
import { renderTui } from "./core/tui.js";
import { RECALL_PACKAGE_NAME, RECALL_VERSION } from "./core/version.js";
import { allocateWork, allocationToProposal, blindLockToProposal, type BlindLockInput, type WorkCandidateInput } from "./core/workflow.js";
import type { AcpRequest, HyperedgeProgramSpec, OperatorRun } from "./core/types.js";

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
  limitProvided: boolean;
  watch: boolean;
  derive: boolean;
  operatorCompact: boolean;
  skipSemanticReindex: boolean;
  skipEvalClosure: boolean;
  skipCognitiveTick: boolean;
  skipDaemonMaintenance: boolean;
  inlineReferenceValues: boolean;
  includeReferenceParameters: boolean;
  acpStatus?: string;
  acpManager?: string;
  acpToAgent?: string;
  force: boolean;
  apply: boolean;
  root?: string;
  file?: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.command;

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(JSON.stringify({ name: RECALL_PACKAGE_NAME, version: RECALL_VERSION }, null, 2));
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

  if (command === "claude" && (!subcommand || subcommand === "sync")) {
    const keep = process.env.RECALL_KEEP_AUTOMEMORY === "1";
    console.log(JSON.stringify(syncClaudeIntegration({ disableAutoMemory: !keep }), null, 2));
    return;
  }

  if (command === "claude" && subcommand === "status") {
    console.log(JSON.stringify(claudeIntegrationStatus(), null, 2));
    return;
  }

  if (command === "claude" && (subcommand === "disable-auto-memory" || subcommand === "disable")) {
    console.log(JSON.stringify(setClaudeAutoMemory(false), null, 2));
    return;
  }

  if (command === "claude" && (subcommand === "enable-auto-memory" || subcommand === "enable")) {
    console.log(JSON.stringify(setClaudeAutoMemory(true), null, 2));
    return;
  }

  if (command === "codex" && (!subcommand || subcommand === "sync")) {
    console.log(JSON.stringify(syncCodexIntegration(), null, 2));
    return;
  }

  if (command === "codex" && subcommand === "status") {
    console.log(JSON.stringify(codexIntegrationStatus(), null, 2));
    return;
  }

  if (command === "export") {
    console.log(JSON.stringify(exportRecallArchive(args.db), null, 2));
    return;
  }

  if (command === "import" && subcommand !== "auto-memory" && subcommand !== "mem0" && subcommand !== "zep") {
    const archive = readJsonArg(args);
    console.log(JSON.stringify({ result: importRecallArchive(args.db, archive, { replace: args.force }) }, null, 2));
    return;
  }

  const store = new SQLiteRecallStore(args.db);
  try {
    if (command === "init") {
      console.log(JSON.stringify({ status: "initialized", db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "status") {
      console.log(JSON.stringify({ name: RECALL_PACKAGE_NAME, version: RECALL_VERSION, db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "storage") {
      console.log(JSON.stringify(storageStats(store), null, 2));
      return;
    }

    if (command === "acp" && (!subcommand || subcommand === "status")) {
      console.log(JSON.stringify({ mode: "agent-communication-protocol", db: args.db, stats: store.stats() }, null, 2));
      return;
    }

    if (command === "acp" && subcommand === "send") {
      const request = readJsonArg(args);
      console.log(JSON.stringify({ request: enqueueAcpRequest(store, normalizeAcpRequest(request)) }, null, 2));
      return;
    }

    if (command === "acp" && subcommand === "list") {
      console.log(JSON.stringify({ requests: store.listAcpRequests(args.limit, acpStatusFilter(args)).map(acpRequestListItem) }, null, 2));
      return;
    }

    if (command === "acp" && subcommand === "show") {
      const requestId = requireCommandValue(args.command, 2, "ACP request id");
      console.log(JSON.stringify(store.getAcpRequest(requestId), null, 2));
      return;
    }

    if (command === "acp" && subcommand === "process") {
      console.log(JSON.stringify(runAcpCycle(store, new Date(), { limit: args.limit, manager: args.acpManager, toAgent: args.acpToAgent }), null, 2));
      return;
    }

    if (command === "acp" && subcommand === "run") {
      runAcpLoop(store, {
        intervalMs: args.intervalMs,
        limit: args.limit,
        manager: args.acpManager,
        toAgent: args.acpToAgent
      });
      return;
    }

    if (command === "compact") {
      const result = store.compact();
      console.log(JSON.stringify({ result, storage: storageStats(store) }, null, 2));
      return;
    }

    if (command === "beliefs") {
      const report = analyzeMemory(store);
      console.log(JSON.stringify({ report }, null, 2));
      return;
    }

    if (command === "maintenance") {
      const report = analyzeMemory(store);
      const result = args.derive
        ? admitWriteProposal(
            memoryHealthToProposal(report, {
              project: "Recall",
              tenant: "local",
              session: "maintenance"
            }),
            store
          )
        : undefined;
      console.log(JSON.stringify({ report, result }, null, 2));
      process.exitCode = result && !result.accepted ? 1 : 0;
      return;
    }

    if (command === "repair") {
      if (args.apply) {
        const pruned = store.pruneUnresolvableTrustEdges();
        console.log(JSON.stringify({ dryRun: false, count: pruned.deleted, relations: pruned.relations }, null, 2));
      } else {
        const relations = store.unresolvableTrustEdges();
        console.log(JSON.stringify({ dryRun: true, count: relations.length, relations }, null, 2));
      }
      return;
    }

    if (command === "import" && subcommand === "auto-memory") {
      const summary = importAutoMemory(store, { root: args.root, project: args.project[0], apply: args.apply });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    if (command === "import" && subcommand === "mem0") {
      const file = args.file;
      if (!file) {
        fail("recall import mem0 requires --file <export.json>");
        return;
      }
      let summary;
      try {
        summary = importMem0(store, { file, project: args.project[0], apply: args.apply });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    if (command === "import" && subcommand === "zep") {
      const file = args.file;
      if (!file) {
        fail("recall import zep requires --file <export.json>");
        return;
      }
      let summary;
      try {
        summary = importZep(store, { file, project: args.project[0], apply: args.apply });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    if (command === "trust") {
      const report = analyzeMemory(store);
      console.log(JSON.stringify({ provenance: report.provenance, warnings: report.criticalWarnings }, null, 2));
      return;
    }

    if (command === "calibration") {
      console.log(JSON.stringify({ calibration: analyzeCalibration(store) }, null, 2));
      return;
    }

    if (command === "tick") {
      console.log(JSON.stringify(runCognitiveTick(store, new Date(), args.derive), null, 2));
      return;
    }

    if (command === "page") {
      const page = (subcommand ?? "index") as RecallPageName;
      const output = page === "index"
        ? buildPageIndex(store)
        : getRecallPage(store, page, pageOptions(args));
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    if (command === "cell" && (!subcommand || subcommand === "show")) {
      const idOrAddress = subcommand === "show"
        ? requireCommandValue(args.command, 2, "cell id or address")
        : requireCommandValue(args.command, 1, "cell id or address");
      console.log(JSON.stringify(inspectCell(store, idOrAddress), null, 2));
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
      const packet = compileContext(store, {
        task,
        budgetWords: args.words,
        inlineReferenceValues: args.inlineReferenceValues,
        includeReferenceParameters: args.includeReferenceParameters
      });
      console.log(formatContextPacket(packet));
      return;
    }

    if (command === "incept") {
      const objective = args.query ?? args.command.slice(1).join(" ");
      const scaffold = buildInceptionScaffold(store, {
        objective,
        project: args.project?.[0] ?? "recall",
        createdAt: new Date().toISOString(),
        budgetWords: args.words
      });
      console.log(JSON.stringify(scaffold, null, 2));
      return;
    }

    if (command === "trend") {
      const objective = args.query ?? args.command.slice(1).join(" ");
      const scaffold = buildTrendScaffold(store, { objective });
      console.log(JSON.stringify(scaffold, null, 2));
      return;
    }

    if (command === "workflow" && subcommand === "allocate") {
      const input = readJsonArg(args);
      const candidates = parseWorkCandidates(input);
      const limit = workflowLimit(input, args.limitProvided ? args.limit : 8);
      const report = allocateWork(candidates, limit);
      const result = args.derive
        ? admitWriteProposal(
            allocationToProposal(report, {
              project: "Recall",
              tenant: "local",
              session: "workflow"
            }),
            store
          )
        : undefined;
      console.log(JSON.stringify({ report, result }, null, 2));
      process.exitCode = result && !result.accepted ? 1 : 0;
      return;
    }

    if (command === "blind-lock" && subcommand === "add") {
      const input = parseBlindLockInput(readJsonArg(args));
      const result = admitWriteProposal(blindLockToProposal(input), store);
      console.log(JSON.stringify({ result }, null, 2));
      process.exitCode = result.accepted ? 0 : 1;
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

    if (command === "operate" && subcommand === "list") {
      console.log(JSON.stringify({ runs: store.listOperatorRuns(args.limit).map(operatorRunListItem) }, null, 2));
      return;
    }

    if (command === "operate" && subcommand === "show") {
      const runId = requireCommandValue(args.command, 2, "operator run id");
      console.log(JSON.stringify(store.getOperatorRun(runId), null, 2));
      return;
    }

    if (command === "operate" && (!subcommand || subcommand === "once")) {
      console.log(JSON.stringify(runOperatingCycle(store, new Date(), operatingCycleOptions(args)), null, 2));
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
  // Precedence: explicit --db flag (set in the loop below) > RECALL_DB env
  // > local default. RECALL_DB is the same escape hatch the MCP server reads,
  // so a shared store set once in the environment routes both paths alike.
  const envDb = process.env.RECALL_DB?.trim();
  let db = envDb ? envDb : ".recall/recall.sqlite3";
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
  let limitProvided = false;
  let watch = false;
  let derive = false;
  let operatorCompact = false;
  let skipSemanticReindex = false;
  let skipEvalClosure = false;
  let skipCognitiveTick = false;
  let skipDaemonMaintenance = false;
  let inlineReferenceValues = false;
  let includeReferenceParameters = false;
  let acpStatus: string | undefined;
  let acpManager: string | undefined;
  let acpToAgent: string | undefined;
  let force = false;
  let apply = false;
  let root: string | undefined;
  let file: string | undefined;

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
      limitProvided = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--derive") {
      derive = true;
    } else if (arg === "--compact") {
      operatorCompact = true;
    } else if (arg === "--no-semantic") {
      skipSemanticReindex = true;
    } else if (arg === "--no-eval") {
      skipEvalClosure = true;
    } else if (arg === "--no-tick") {
      skipCognitiveTick = true;
    } else if (arg === "--no-daemon") {
      skipDaemonMaintenance = true;
    } else if (arg === "--inline-refs") {
      inlineReferenceValues = true;
    } else if (arg === "--reference-parameters") {
      includeReferenceParameters = true;
    } else if (arg === "--acp-status") {
      acpStatus = requireValue(argv, ++index, "--acp-status");
    } else if (arg === "--acp-manager") {
      acpManager = requireValue(argv, ++index, "--acp-manager");
    } else if (arg === "--acp-to-agent") {
      acpToAgent = requireValue(argv, ++index, "--acp-to-agent");
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--root") {
      root = requireValue(argv, ++index, "--root");
    } else if (arg === "--file") {
      file = requireValue(argv, ++index, "--file");
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
    limitProvided,
    watch,
    derive,
    operatorCompact,
    skipSemanticReindex,
    skipEvalClosure,
    skipCognitiveTick,
    skipDaemonMaintenance,
    inlineReferenceValues,
    includeReferenceParameters,
    acpStatus,
    acpManager,
    acpToAgent,
    force,
    apply,
    root,
    file
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
  let raw: string;
  try {
    raw = readFileSync(args.jsonPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    fail(code === "ENOENT" ? `No such --json file: ${args.jsonPath}` : `Cannot read --json file ${args.jsonPath}: ${(error as Error).message}`);
  }
  if (raw.trim() === "") {
    fail(`--json file is empty: ${args.jsonPath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`--json file is not valid JSON (${args.jsonPath}): ${(error as Error).message}`);
  }
}

function parseWorkCandidates(input: unknown): WorkCandidateInput[] {
  const candidates = Array.isArray(input) ? input : isRecord(input) ? input.candidates : undefined;
  if (!Array.isArray(candidates)) {
    fail("Expected --json to contain an array of candidates or { \"candidates\": [...] }");
  }
  return candidates.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.title !== "string" || candidate.title.trim() === "") {
      fail(`Expected candidate ${index + 1} to contain a non-empty title`);
    }
    return {
      id: typeof candidate.id === "string" ? candidate.id : undefined,
      title: candidate.title,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
      impact: optionalNumber(candidate.impact, "impact", index),
      uncertainty: optionalNumber(candidate.uncertainty, "uncertainty", index),
      concern: optionalNumber(candidate.concern, "concern", index),
      dependencyWeight: optionalNumber(candidate.dependencyWeight, "dependencyWeight", index),
      cost: optionalNumber(candidate.cost, "cost", index),
      reversibility: optionalNumber(candidate.reversibility, "reversibility", index),
      novelty: optionalNumber(candidate.novelty, "novelty", index),
      tags: optionalStringArray(candidate.tags, "tags", index)
    };
  });
}

function workflowLimit(input: unknown, fallback: number): number {
  const limit = isRecord(input) && typeof input.limit === "number" ? input.limit : fallback;
  if (!Number.isFinite(limit) || limit <= 0) {
    fail("workflow allocate limit must be a positive number");
  }
  return Math.floor(limit);
}

function parseBlindLockInput(input: unknown): BlindLockInput {
  if (!isRecord(input) || typeof input.title !== "string" || typeof input.prediction !== "string") {
    fail("Expected blind-lock JSON with title and prediction strings");
  }
  return {
    title: input.title,
    prediction: input.prediction,
    expectedBy: typeof input.expectedBy === "string" ? input.expectedBy : undefined,
    falsifier: typeof input.falsifier === "string" ? input.falsifier : undefined,
    project: typeof input.project === "string" ? input.project : undefined,
    path: typeof input.path === "string" ? input.path : undefined,
    tenant: typeof input.tenant === "string" ? input.tenant : undefined,
    confidence: optionalNumber(input.confidence, "confidence"),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : undefined,
    tags: optionalStringArray(input.tags, "tags")
  };
}

function optionalNumber(value: unknown, key: string, index?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(index === undefined ? `Expected ${key} to be a number` : `Expected candidate ${index + 1} ${key} to be a number`);
  }
  return value;
}

function optionalStringArray(value: unknown, key: string, index?: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(index === undefined ? `Expected ${key} to be string[]` : `Expected candidate ${index + 1} ${key} to be string[]`);
  }
  return value;
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
  recall version
  recall status [--db path]
  recall storage [--db path]
  recall export [--db path]                                      print a portable JSON archive to stdout
  recall import --json recall-export.json [--db path] [--force]  restore an archive into an empty db; --force replaces rows
  recall import auto-memory [--root path] [--project name] [--apply] [--db path]  import Claude Code auto-memory files (dry-run default; --apply writes)
  recall import mem0 --file export.json [--project name] [--apply] [--db path]  import a Mem0 export (get_all/create_memory_export) as calibrated cells (dry-run default)
  recall import zep --file export.json [--project name] [--apply] [--db path]   import a Zep graph export; reconstructs supersession from bi-temporal facts (dry-run default)
  recall acp [status] [--db path]
  recall acp send --json request.json [--db path]
  recall acp list [--limit 20] [--acp-status queued] [--db path]
  recall acp show <request-id> [--db path]
  recall acp process [--limit 20] [--acp-manager recall-acp-manager] [--acp-to-agent recall-acp-manager] [--db path]
  recall acp run [--interval-ms 5000] [--limit 20] [--acp-manager recall-acp-manager] [--acp-to-agent recall-acp-manager] [--db path]
  recall compact [--db path]
  recall beliefs [--db path]
  recall trust [--db path]
  recall calibration [--db path]                                   per-actor stated-confidence vs contradiction outcomes
  recall maintenance [--derive] [--db path]
  recall repair [--apply] [--db path]                              prune dangling/unresolvable trust edges (dry-run default; --apply deletes)
  recall tick [--derive] [--db path]
  recall page [index|reflections|agent-profile|user-profile|team-metrics|witnesses|workbench|handoffs|objectives|acp-queue|acp-manager] [--project Recall] [--topic memory] [--identity agent:codex] [--limit 25]
  recall cell show <cell-id-or-address> [--db path]
  recall validate --json proposal.json [--db path]
  recall admit --json proposal.json [--db path] [--review]        agent/debug path; normal memory uses MCP recall_write
  recall write-propose --json proposal.json [--db path] [--review] agent/debug alias; not the user-facing memory flow
  recall search "query" [--db path]
  recall semantic "query" [--db path]
  recall semantic reindex [--db path]
  recall subgraph [--category memory] [--type witness] [--subject compiler] [--project Recall] [--idea active-memory] [--timestamp 2026-05-21]
  recall subgraph [--topic a,b] [--entity x] [--identity agent:codex] [--ring runtime]
  recall compile "task" [--words 900] [--inline-refs] [--reference-parameters] [--db path]
  recall incept "open objective" [--words 700] [--project name] [--db path]
  recall workflow allocate --json candidates.json [--limit 8] [--derive] [--db path]
  recall blind-lock add --json blind-lock.json [--db path]
  recall rollback list [--db path]
  recall rollback show <journal-id> [--db path]
  recall rollback apply <journal-id> [--db path]
  recall hyperedge add --json hyperedge.json [--db path]
      hyperedge.json = { "kind": "evidence-bundle", "title": "<required>", "members": [{ "nodeId": "<cell-id>", "role": "claim|verification" }] }
  recall hyperedge show <hyperedge-id> [--db path]
  recall hyperedge list [--limit 20] [--db path]
  recall program add <hyperedge-id> --json program.json [--db path]
      program.json = { "schemaVersion": "recall.program.v1", "operation": "score|watch|drift|quorum|trend", "params": { "delta": 0.1, "concernTarget": "<cell-id>", "k": 2, "minEff": 0.7, "window": 8, "streak": 3, "measure": "effective_confidence|member_count" } }
  recall trend "<objective>" [--query q]   scaffold a trend program (direction, slope, acceleration over a series) for the agent to fill and attach
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
  recall operate once [--derive] [--compact] [--no-semantic] [--no-eval] [--no-tick] [--no-daemon] [--db path]
  recall operate list [--limit 20] [--db path]
  recall operate show <operator-run-id> [--db path]
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
  recall claude sync                  install/refresh the Claude Code integration (hook, skill, MCP) and disable
                                      built-in auto-memory so agents adopt Recall (RECALL_KEEP_AUTOMEMORY=1 to keep it)
  recall claude status                report which integration pieces are installed
  recall claude disable-auto-memory   set CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 only
  recall claude enable-auto-memory    re-enable Claude Code built-in auto-memory
  recall codex sync                   install/refresh the Codex integration (skill, MCP server in config.toml,
                                      and a Recall directive in ~/.codex/AGENTS.md). Codex has no native-memory
                                      kill switch, so displacement is prompt-level via the AGENTS.md directive
  recall codex status                 report which Codex integration pieces are installed
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizeAcpRequest(value: unknown): {
  channel?: string;
  fromAgent: string;
  toAgent: string;
  action: import("./core/types.js").AcpRequestAction;
  payload?: Record<string, unknown>;
} {
  if (!isRecord(value)) {
    fail("Expected ACP request JSON object");
  }
  if (typeof value.fromAgent !== "string" || typeof value.toAgent !== "string" || !isAcpRequestAction(value.action)) {
    fail("ACP request JSON requires fromAgent, toAgent, and a supported action");
  }
  return {
    channel: typeof value.channel === "string" ? value.channel : undefined,
    fromAgent: value.fromAgent,
    toAgent: value.toAgent,
    action: value.action,
    payload: isRecord(value.payload) ? value.payload : undefined
  };
}

function acpStatusFilter(args: ParsedArgs): import("./core/types.js").AcpRequestStatus | undefined {
  return isAcpRequestStatus(args.acpStatus) ? args.acpStatus : undefined;
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

function pageOptions(args: ParsedArgs) {
  return {
    project: args.project[0],
    topic: args.topics[0],
    identity: args.identities[0],
    limit: args.limitProvided ? args.limit : 25
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

function operatingCycleOptions(args: ParsedArgs) {
  return {
    derive: args.derive,
    compact: args.operatorCompact,
    semanticReindex: !args.skipSemanticReindex,
    evalClosure: !args.skipEvalClosure,
    cognitiveTick: !args.skipCognitiveTick,
    daemonMaintenance: !args.skipDaemonMaintenance,
    lease: {
      owner: "recall-cli"
    }
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
