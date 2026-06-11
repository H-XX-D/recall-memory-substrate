#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "src", "cli.js");
const tempDir = mkdtempSync(join(tmpdir(), "recall-e2e-"));
const db = join(tempDir, "recall.sqlite3");
const secretsDb = join(tempDir, "secrets.sqlite3");
const launchAgentsDir = join(tempDir, "LaunchAgents");

const steps = [];

try {
  const firstProposal = writeJson("proposal-one.json", proposal({
    title: "E2E context compiler witness",
    body: "The context compiler returns compact packets from admitted graph memory.",
    summary: "Context compiler packet evidence exists.",
    intent: "witness",
    subject: "compiler",
    idea: "context-packet"
  }));
  const secondProposal = writeJson("proposal-two.json", proposal({
    title: "E2E daemon runtime observation",
    body: "The daemon can run outside the LLM and write through admission.",
    summary: "Daemon runtime path exists.",
    intent: "observation",
    subject: "daemon",
    idea: "outside-llm-maintenance"
  }));
  const beliefProposal = writeJson("proposal-belief.json", proposal({
    title: "E2E belief pressure target",
    body: "Belief cells are scored with support, contradiction, uncertainty, and concern pressure.",
    summary: "Belief pressure target exists.",
    intent: "belief_update",
    subject: "beliefs",
    idea: "belief-pressure"
  }));

  assertJson(runCli(["init"]), (value) => value.status === "initialized", "init creates the graph database");
  assertJson(runCli(["validate", "--json", firstProposal]), (value) => value.ok === true, "strict write proposal validates");
  const firstAdmission = parseJson(runCli(["admit", "--json", firstProposal]));
  expect(firstAdmission.accepted === true, "first proposal admitted");
  expect(firstAdmission.node?.cellAddress?.startsWith("recall://cell/"), "first node has an addressable cell");
  const secondAdmission = parseJson(runCli(["admit", "--json", secondProposal]));
  expect(secondAdmission.accepted === true, "second proposal admitted");
  const beliefAdmission = parseJson(runCli(["admit", "--json", beliefProposal]));
  expect(beliefAdmission.accepted === true, "belief proposal admitted");
  const fieldReferenceProposal = writeJson("proposal-field-reference.json", proposal({
    title: "E2E field reference witness",
    body: "The compiler should return a short field handle by default and resolve the field only on demand.",
    summary: "Field reference witness exists.",
    intent: "witness",
    subject: "compiler",
    idea: "id-first-reference",
    evidence: {
      supports: [`${firstAdmission.node.cellAddress}#content.summary`]
    }
  }));
  const fieldReferenceAdmission = parseJson(runCli(["admit", "--json", fieldReferenceProposal]));
  expect(fieldReferenceAdmission.accepted === true, "field reference proposal admitted");

  assertJson(runCli(["status"]), (value) => value.stats.nodes >= 3, "status reports admitted nodes");
  assertJson(runCli(["storage"]), (value) => value.cells >= 3 && value.averageCell.serializedBytes > 0, "storage reports average cell footprint");
  assertJson(runCli(["search", "context compiler"]), (value) => value.results.length >= 1, "lexical search returns memory");
  assertJson(runCli(["semantic", "reindex"]), (value) => value.indexed >= 2, "semantic reindex covers graph nodes");
  assertJson(runCli(["semantic", "compact packets"]), (value) => value.results.length >= 1, "semantic search returns memory");
  assertJson(
    runCli(["subgraph", "--category", "memory", "--type", "witness", "--subject", "compiler", "--project", "Recall"]),
    (value) => value.results.length >= 1,
    "tag-composed subgraph returns the compiler witness"
  );
  expect(runCli(["compile", "context compiler packet", "--words", "120"]).includes("expansion_handles:"), "context compiler returns handles");
  const fieldCompile = runCli(["compile", "field reference witness", "--words", "220"]);
  expect(fieldCompile.includes("translated_references:"), "context compiler returns translated references section");
  expect(fieldCompile.includes(`${firstAdmission.node.id}#content.summary`), "default compiler returns short id field handles");
  expect(
    !sectionText(fieldCompile, "translated_references").includes("Context compiler packet evidence exists."),
    "default compiler does not inline referenced field values in translated references"
  );
  const inlineFieldCompile = runCli(["compile", "field reference witness", "--words", "260", "--inline-refs", "--reference-parameters"]);
  expect(inlineFieldCompile.includes("Context compiler packet evidence exists."), "inline compiler option resolves referenced field values");
  expect(runCli(["tui"]).includes("Recall TUI"), "TUI renders a human inspection view");
  assertJson(runCli(["rollback", "list"]), (value) => value.rollback.length >= 2, "rollback journal is populated");
  assertJson(runCli(["beliefs"]), (value) => Array.isArray(value.report.beliefs), "belief pressure command returns a report");
  assertJson(runCli(["trust"]), (value) => typeof value.provenance.totalWitnesses === "number", "trust command returns provenance health");
  assertJson(runCli(["maintenance"]), (value) => Array.isArray(value.report.nextActions), "maintenance command analyzes memory health");
  const maintenanceWrite = parseJson(runCli(["maintenance", "--derive"]));
  expect(maintenanceWrite.result.accepted === true, "maintenance health can derive into graph memory");
  assertJson(runCli(["tick"]), (value) => Array.isArray(value.report.phases), "cognitive tick returns phase report");
  const tickWrite = parseJson(runCli(["tick", "--derive"]));
  expect(tickWrite.result.accepted === true, "cognitive tick can derive into graph memory");
  assertJson(runCli(["page", "index"]), (value) => Array.isArray(value.pages), "paged graph index works");
  assertJson(runCli(["page", "witnesses"]), (value) => value.name === "witnesses", "witness page works");
  assertJson(runCli(["cell", "show", firstAdmission.node.cellAddress]), (value) => value.node.id === firstAdmission.node.id, "cell inspection works by address");
  assertJson(
    runCli(["cell", "show", `${firstAdmission.node.id}#content.summary`]),
    (value) => value.requestedField?.valuePreview === "Context compiler packet evidence exists.",
    "cell inspection resolves id field handles"
  );
  assertJson(runCli(["compact"]), (value) => value.storage.cells >= 1, "compact reports storage after vacuum");
  const operatorRun = assertJson(
    runCli(["operate", "once", "--no-eval", "--no-tick", "--no-daemon"]),
    (value) =>
      value.status === "ran" &&
      value.ledger?.id &&
      value.phases.some((phase) => phase.name === "semantic_reindex" && phase.status === "completed") &&
      value.phases.some((phase) => phase.name === "postflight" && phase.status === "completed"),
    "operator cycle runs a bounded mechanical pass"
  );
  assertJson(
    runCli(["operate", "list"]),
    (value) => value.runs.some((run) => run.id === operatorRun.ledger.id),
    "operator ledger lists persisted mechanical reports"
  );
  assertJson(
    runCli(["operate", "show", operatorRun.ledger.id]),
    (value) => value.id === operatorRun.ledger.id && value.result.summary === operatorRun.summary,
    "operator ledger shows a persisted mechanical report"
  );
  assertJson(runCli(["acp", "status"]), (value) => value.mode === "agent-communication-protocol", "ACP mode reports status");
  const acpRequestFile = writeJson("acp-request.json", {
    channel: "inbox",
    fromAgent: "agent:e2e",
    toAgent: "recall-acp-manager",
    action: "search",
    payload: {
      query: "context compiler",
      limit: 5
    }
  });
  const acpSend = parseJson(runCli(["acp", "send", "--json", acpRequestFile]));
  expect(acpSend.request.id, "ACP request can be enqueued");
  const acpProcess = parseJson(runCli(["acp", "process", "--acp-manager", "recall-acp-manager", "--acp-to-agent", "recall-acp-manager", "--limit", "5"]));
  expect(acpProcess.completed === 1, "ACP process handles a queued request");
  assertJson(runCli(["acp", "list", "--acp-status", "completed"]), (value) => value.requests.some((request) => request.id === acpSend.request.id), "ACP list shows the processed request");
  assertJson(runCli(["acp", "show", acpSend.request.id]), (value) => value.status === "completed", "ACP show returns the stored request");
  assertJson(runCli(["page", "acp-queue"]), (value) => value.name === "acp-queue" && value.metrics.byStatus.completed >= 1, "ACP queue page works");
  assertJson(runCli(["page", "acp-manager"]), (value) => value.name === "acp-manager" && value.metrics.identity === "agent:acp-manager", "ACP manager page works");

  const workflowFile = writeJson("workflow-candidates.json", {
    candidates: [
      {
        id: "docs",
        title: "Polish install docs",
        impact: 0.4,
        uncertainty: 0.2,
        concern: 0.2,
        dependencyWeight: 0.2,
        cost: 0.3,
        reversibility: 0.9
      },
      {
        id: "runtime",
        title: "Verify runtime memory health",
        impact: 0.9,
        uncertainty: 0.8,
        concern: 0.8,
        dependencyWeight: 0.9,
        cost: 0.4,
        reversibility: 0.7,
        novelty: 0.5
      }
    ]
  });
  const workflowAllocation = parseJson(runCli(["workflow", "allocate", "--json", workflowFile, "--limit", "1", "--derive"]));
  expect(workflowAllocation.report.selected[0].id === "runtime", "workflow allocator selects highest pressure candidate");
  expect(workflowAllocation.result.accepted === true, "workflow allocation derives into graph memory");

  const blindLockFile = writeJson("blind-lock.json", {
    title: "E2E compiler blind lock",
    prediction: "Compiled packets include health-derived warnings after memory analysis.",
    expectedBy: "2026-05-22T00:00:00.000Z",
    falsifier: "Compiled packets omit stale or contradiction warnings when they exist.",
    confidence: 0.7,
    tags: ["compiler", "memory-health"]
  });
  const blindLock = parseJson(runCli(["blind-lock", "add", "--json", blindLockFile]));
  expect(blindLock.result.accepted === true, "blind lock admits as a typed cell");

  const secretSave = parseJson(runCli(
    [
      "secrets",
      "save",
      "--title",
      "e2e-secret",
      "--confirm-secret-save",
      "--password-stdin",
      "--value-stdin",
      "--tags",
      "e2e,local",
      "--scope",
      "test"
    ],
    { input: "correct horse battery staple\ne2e-secret-value" }
  ));
  expect(secretSave.saved === true, "encrypted secret save requires explicit confirmation");
  assertJson(runCli(["secrets", "list"]), (value) => value.secrets.length === 1, "secret list exposes metadata");
  const secretGet = parseJson(runCli(["secrets", "get", secretSave.secret.id, "--password-stdin"], {
    input: "correct horse battery staple\n"
  }));
  expect(secretGet.plaintext === "e2e-secret-value", "secret decrypts with the password");

  const hyperedgeFile = writeJson("hyperedge.json", {
    kind: "supports",
    title: "E2E support edge",
    members: [
      { nodeId: firstAdmission.node.id, role: "source" },
      { nodeId: secondAdmission.node.id, role: "target" }
    ],
    metadata: { purpose: "e2e" }
  });
  const hyperedge = parseJson(runCli(["hyperedge", "add", "--json", hyperedgeFile]));
  expect(hyperedge.id, "hyperedge is created");
  assertJson(runCli(["hyperedge", "show", hyperedge.id]), (value) => value.id === hyperedge.id, "hyperedge can be read");
  assertJson(runCli(["hyperedge", "list"]), (value) => value.hyperedges.length >= 1, "hyperedge list works");

  const programFile = writeJson("program.json", {
    schemaVersion: "recall.program.v1",
    operation: "emit_witness",
    description: "E2E deterministic witness emitter"
  });
  const program = parseJson(runCli(["program", "add", hyperedge.id, "--json", programFile]));
  expect(program.id, "program attaches to a hyperedge");
  const programRun = parseJson(runCli(["program", "run", program.id, "--derive"]));
  expect(programRun.run.id, "program run is persisted");
  expect(programRun.derived[0]?.accepted === true, "program derivation is admitted");
  assertJson(runCli(["program", "runs"]), (value) => value.runs.length >= 1, "program run list works");
  assertJson(runCli(["program", "show-run", programRun.run.id]), (value) => value.id === programRun.run.id, "program run can be read");

  const dagFile = writeJson("dag.json", {
    title: "E2E optional DAG overlay",
    nodeIds: [firstAdmission.node.id, secondAdmission.node.id, "e2e-third"],
    edges: [
      { from: firstAdmission.node.id, to: secondAdmission.node.id, label: "direct" },
      { from: firstAdmission.node.id, to: "e2e-third", label: "via" },
      { from: "e2e-third", to: secondAdmission.node.id, label: "indirect" }
    ]
  });
  const dag = parseJson(runCli(["dag", "add", "--json", dagFile]));
  const dagAnalysis = parseJson(runCli(["dag", "analyze", dag.id, "--derive"]));
  expect(dagAnalysis.analysis.isDag === true, "DAG overlay analysis confirms acyclic overlay");
  expect(dagAnalysis.derived.length >= 1, "DAG analysis derives admitted witnesses");
  assertJson(runCli(["dag", "list"]), (value) => value.overlays.length >= 1, "DAG overlay list works");

  const evalRun = parseJson(runCli(["eval", "run", "--derive"]));
  expect(evalRun.result.passed === true, "default eval suite passes");
  expect(evalRun.derived[0]?.accepted === true, "eval result derives into graph memory");
  assertJson(runCli(["eval", "list"]), (value) => value.evalRuns.length >= 1, "eval list works");
  assertJson(runCli(["eval", "show", evalRun.result.id ?? parseJson(runCli(["eval", "list"])).evalRuns[0].id]), () => true, "eval show works");

  const { acquireDaemonLease, releaseDaemonLease } = await import(pathToFileURL(join(repoRoot, "dist", "src", "core", "daemon-scheduler.js")).href);
  const lease = acquireDaemonLease(db, new Date(), { owner: "recall-e2e-active-lease" });
  expect(lease.status === "acquired", "daemon lease can be acquired");
  const skippedDaemon = parseJson(runCli(["daemon", "run-once", "--derive"]));
  expect(skippedDaemon.status === "skipped", "daemon skips when another lease is active");
  releaseDaemonLease(lease);
  const daemonRun = parseJson(runCli(["daemon", "run-once", "--derive"]));
  expect(daemonRun.status === "ran", "daemon runs outside the LLM after lease release");
  assertJson(runCli(["daemon", "status"]), (value) => value.mode === "outside-llm", "daemon status reports outside-LLM mode");

  const plist = runCli([
    "daemon",
    "plist",
    "--label",
    "io.recall.memory.e2e",
    "--launch-agents-dir",
    launchAgentsDir,
    "--cwd",
    repoRoot
  ]);
  expect(plist.includes("io.recall.memory.e2e"), "LaunchAgent plist renders with neutral label");
  assertJson(
    runCli(["daemon", "install", "--label", "io.recall.memory.e2e", "--launch-agents-dir", launchAgentsDir, "--cwd", repoRoot]),
    (value) => value.exists === true,
    "LaunchAgent install writes a plist without loading it"
  );
  assertJson(
    runCli(["daemon", "service-status", "--label", "io.recall.memory.e2e", "--launch-agents-dir", launchAgentsDir]),
    (value) => value.exists === true,
    "LaunchAgent status sees installed plist"
  );
  assertJson(
    runCli(["daemon", "uninstall", "--label", "io.recall.memory.e2e", "--launch-agents-dir", launchAgentsDir]),
    (value) => value.exists === false,
    "LaunchAgent uninstall removes the plist"
  );

  const { SQLiteRecallStore } = await import(pathToFileURL(join(repoRoot, "dist", "src", "core", "store.js")).href);
  const { handleMcpRequest } = await import(pathToFileURL(join(repoRoot, "dist", "src", "mcp", "server.js")).href);
  const store = new SQLiteRecallStore(db);
  try {
    const toolList = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, store);
    expect(Array.isArray(toolList.result?.tools), "MCP lists tools");
    const mcpWrite = handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "recall_write",
        arguments: {
          proposal: proposal({
            title: "E2E MCP managed memory",
            body: "The MCP recall_write tool submits LLM-managed memory through admission.",
            summary: "MCP recall_write works.",
            intent: "observation",
            subject: "mcp",
            idea: "llm-managed-memory"
          })
        }
      }
    }, store);
    expect(mcpWrite.error === undefined, "MCP recall_write succeeds");
    const mcpCompile = handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "recall_compile",
        arguments: {
          task: "MCP managed memory",
          words: 120
        }
      }
    }, store);
    expect(mcpCompile.error === undefined, "MCP recall_compile succeeds");
    const mcpMaintenance = handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "recall_maintenance",
        arguments: {
          derive: false
        }
      }
    }, store);
    expect(mcpMaintenance.error === undefined, "MCP recall_maintenance succeeds");
    const mcpStorage = handleMcpRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "recall_storage",
        arguments: {}
      }
    }, store);
    expect(mcpStorage.error === undefined, "MCP recall_storage succeeds");
    const mcpPage = handleMcpRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "recall_page",
        arguments: {
          page: "index"
        }
      }
    }, store);
    expect(mcpPage.error === undefined, "MCP recall_page succeeds");
    const mcpCell = handleMcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "recall_cell",
        arguments: {
          idOrAddress: firstAdmission.node.cellAddress
        }
      }
    }, store);
    expect(mcpCell.error === undefined, "MCP recall_cell succeeds");
    const mcpWorkflow = handleMcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "recall_workflow_allocate",
        arguments: {
          candidates: [
            {
              id: "mcp-runtime",
              title: "MCP runtime check",
              impact: 0.8,
              uncertainty: 0.7,
              concern: 0.7,
              cost: 0.4
            }
          ],
          limit: 1,
          derive: true
        }
      }
    }, store);
    expect(mcpWorkflow.error === undefined, "MCP recall_workflow_allocate succeeds");
    const mcpBlindLock = handleMcpRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "recall_blind_lock",
        arguments: {
          blindLock: {
            title: "MCP blind lock",
            prediction: "MCP can admit blind locks as private typed cells.",
            confidence: 0.6
          }
        }
      }
    }, store);
    expect(mcpBlindLock.error === undefined, "MCP recall_blind_lock succeeds");
    const mcpTick = handleMcpRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "recall_tick",
        arguments: {
          derive: false
        }
      }
    }, store);
    expect(mcpTick.error === undefined, "MCP recall_tick succeeds");
    const mcpOperate = handleMcpRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "recall_operate_once",
        arguments: {
          derive: false,
          semanticReindex: true,
          evalClosure: false,
          cognitiveTick: false,
          daemonMaintenance: false
        }
      }
    }, store);
    expect(mcpOperate.error === undefined, "MCP recall_operate_once succeeds");
    const mcpOperateJson = parseJson(mcpText(mcpOperate));
    expect(mcpOperateJson.ledger?.id, "MCP recall_operate_once returns a ledger id");
    const mcpAcpSend = handleMcpRequest({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "recall_acp_send",
        arguments: {
          request: {
            channel: "inbox",
            fromAgent: "agent:mcp",
            toAgent: "recall-acp-manager",
            action: "status",
            payload: {}
          }
        }
      }
    }, store);
    expect(mcpAcpSend.error === undefined, "MCP recall_acp_send succeeds");
    const mcpAcpSendJson = parseJson(mcpText(mcpAcpSend));
    const mcpAcpProcess = handleMcpRequest({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "recall_acp_process",
        arguments: {
          manager: "recall-acp-manager",
          toAgent: "recall-acp-manager",
          limit: 5
        }
      }
    }, store);
    expect(mcpAcpProcess.error === undefined, "MCP recall_acp_process succeeds");
    const mcpAcpExchange = handleMcpRequest({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "recall_acp_exchange",
        arguments: {
          manager: "recall-acp-manager",
          toAgent: "recall-acp-manager",
          request: {
            channel: "inbox",
            fromAgent: "agent:mcp",
            toAgent: "recall-acp-manager",
            action: "status",
            payload: {}
          }
        }
      }
    }, store);
    expect(mcpAcpExchange.error === undefined, "MCP recall_acp_exchange succeeds");
    const mcpAcpExchangeJson = parseJson(mcpText(mcpAcpExchange));
    const mcpAcpList = handleMcpRequest({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "recall_acp_list",
        arguments: {
          status: "completed",
          limit: 5
        }
      }
    }, store);
    expect(mcpAcpList.error === undefined, "MCP recall_acp_list succeeds");
    const mcpAcpListJson = parseJson(mcpText(mcpAcpList));
    expect(mcpAcpListJson.requests.some((request) => request.id === mcpAcpSendJson.request.id), "MCP recall_acp_list returns the processed ACP request");
    expect(mcpAcpListJson.requests.some((request) => request.id === mcpAcpExchangeJson.request.id), "MCP recall_acp_list returns the exchanged ACP request");
    const mcpAcpShow = handleMcpRequest({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "recall_acp_show",
        arguments: {
          requestId: mcpAcpExchangeJson.request.id
        }
      }
    }, store);
    expect(mcpAcpShow.error === undefined, "MCP recall_acp_show succeeds");
    const mcpAcpShowJson = parseJson(mcpText(mcpAcpShow));
    expect(mcpAcpShowJson.status === "completed", "MCP recall_acp_show returns the exchanged ACP request");
    const mcpOperateList = handleMcpRequest({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "recall_operate_list",
        arguments: {
          limit: 5
        }
      }
    }, store);
    expect(mcpOperateList.error === undefined, "MCP recall_operate_list succeeds");
    const mcpOperateListJson = parseJson(mcpText(mcpOperateList));
    expect(
      mcpOperateListJson.runs.some((run) => run.id === mcpOperateJson.ledger.id),
      "MCP recall_operate_list returns the latest ledger id"
    );
    const mcpOperateShow = handleMcpRequest({
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: {
        name: "recall_operate_show",
        arguments: {
          runId: mcpOperateJson.ledger.id
        }
      }
    }, store);
    expect(mcpOperateShow.error === undefined, "MCP recall_operate_show succeeds");
    const mcpOperateShowJson = parseJson(mcpText(mcpOperateShow));
    expect(mcpOperateShowJson.result.status === "ran", "MCP recall_operate_show returns the stored report");
  } finally {
    store.close();
  }

  console.log(`Recall E2E passed (${steps.length} checks). Temp db: ${db}`);
} finally {
  if (process.env.RECALL_E2E_KEEP_TEMP !== "1") {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    cliPath,
    "--db",
    db,
    "--secrets-db",
    secretsDb,
    ...args
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input
  });
}

function writeJson(name, value) {
  const path = join(tempDir, name);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

function parseJson(text) {
  return JSON.parse(text);
}

function mcpText(response) {
  return response.result?.content?.[0]?.text ?? "";
}

function assertJson(text, predicate, label) {
  const value = parseJson(text);
  expect(predicate(value), label);
  return value;
}

function sectionText(text, name) {
  const start = text.indexOf(`${name}:\n`);
  if (start < 0) {
    return "";
  }
  const rest = text.slice(start + name.length + 2);
  const next = rest.search(/\n\n[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function expect(condition, label) {
  if (!condition) {
    throw new Error(`E2E failed: ${label}`);
  }
  steps.push(label);
}

function proposal({ title, body, summary, intent, subject, idea, evidence = {} }) {
  return {
    schema_version: "recall.write.v1",
    actor: {
      kind: "llm",
      id: "recall-e2e",
      display: "Recall E2E"
    },
    intent: {
      kind: intent,
      operation: "create"
    },
    content: {
      title,
      body,
      summary
    },
    scope: {
      project: "Recall",
      path: "/tmp/recall-e2e",
      tenant: "local",
      session: "e2e"
    },
    tags: {
      category: ["memory"],
      type: [intent],
      subject: [subject],
      project: ["Recall"],
      idea: [idea],
      timestamp: ["2026-05-21"],
      topics: ["memory", subject],
      entities: ["Recall"],
      identities: ["agent:recall-e2e", "project:recall"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["tested"],
      sensitivity: ["public"],
      permission: ["read"]
    },
    evidence: {
      source_refs: ["scripts/e2e.mjs"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: [],
      ...evidence
    },
    confidence: {
      value: 0.78,
      uncertainty: 0.16,
      concern: 0.3,
      source_quality: "high",
      stability: "stable"
    },
    provenance: {
      created_at: "2026-05-21T00:00:00.000Z",
      origin: "llm",
      produced_by: "recall-e2e",
      verification: "tested",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "public",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: null
    }
  };
}
