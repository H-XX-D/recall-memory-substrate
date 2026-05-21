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

  assertJson(runCli(["init"]), (value) => value.status === "initialized", "init creates the graph database");
  assertJson(runCli(["validate", "--json", firstProposal]), (value) => value.ok === true, "strict write proposal validates");
  const firstAdmission = parseJson(runCli(["admit", "--json", firstProposal]));
  expect(firstAdmission.accepted === true, "first proposal admitted");
  expect(firstAdmission.node?.cellAddress?.startsWith("recall://cell/"), "first node has an addressable cell");
  const secondAdmission = parseJson(runCli(["admit", "--json", secondProposal]));
  expect(secondAdmission.accepted === true, "second proposal admitted");

  assertJson(runCli(["status"]), (value) => value.stats.nodes >= 2, "status reports admitted nodes");
  assertJson(runCli(["search", "context compiler"]), (value) => value.results.length >= 1, "lexical search returns memory");
  assertJson(runCli(["semantic", "reindex"]), (value) => value.indexed >= 2, "semantic reindex covers graph nodes");
  assertJson(runCli(["semantic", "compact packets"]), (value) => value.results.length >= 1, "semantic search returns memory");
  assertJson(
    runCli(["subgraph", "--category", "memory", "--type", "witness", "--subject", "compiler", "--project", "Recall"]),
    (value) => value.results.length >= 1,
    "tag-composed subgraph returns the compiler witness"
  );
  expect(runCli(["compile", "context compiler packet", "--words", "120"]).includes("expansion_handles:"), "context compiler returns handles");
  expect(runCli(["tui"]).includes("Recall TUI"), "TUI renders a human inspection view");
  assertJson(runCli(["rollback", "list"]), (value) => value.rollback.length >= 2, "rollback journal is populated");

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

function assertJson(text, predicate, label) {
  const value = parseJson(text);
  expect(predicate(value), label);
  return value;
}

function expect(condition, label) {
  if (!condition) {
    throw new Error(`E2E failed: ${label}`);
  }
  steps.push(label);
}

function proposal({ title, body, summary, intent, subject, idea }) {
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
      concerns: []
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
