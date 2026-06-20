#!/usr/bin/env node
// Deterministic stress harness for long-horizon LLM memory-substrate operation.
//
// This is not a prose-quality benchmark. It checks whether Recall's graph state
// exposes the machine-operable invariants an LLM controller needs across turns:
// supersession/currentness, edge watchers before actions, DAG order, live
// effective confidence, provenance/trust, and cold-session continuity.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(REPO, "dist", "src", "index.js");

if (!existsSync(API)) {
  console.error(`Build output missing at ${API}. Run npm run build first.`);
  process.exit(1);
}

const {
  SQLiteRecallStore,
  admitWriteProposal,
  analyzeMemory,
  compileContext,
  formatContextPacket
} = await import(pathToFileURL(API).href);

const NOW = new Date("2026-06-18T00:00:00.000Z");

function makeTempStore(prefix = "recall-substrate-stress-") {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  const db = join(dir, "recall.sqlite3");
  const store = new SQLiteRecallStore(db);
  return {
    db,
    store,
    cleanup() {
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function proposal(opts) {
  const kind = opts.kind ?? "observation";
  const producer = opts.producer ?? "substrate-stress";
  const confidence = opts.confidence ?? 0.8;
  const sourceQuality = opts.sourceQuality ?? "high";
  const verification = opts.verification ?? "checked";
  const topics = ["substrate-stress", ...(opts.topics ?? [])];
  return {
    schema_version: "recall.write.v1",
    actor: { kind: opts.actorKind ?? "llm", id: producer, display: producer },
    intent: { kind, operation: opts.operation ?? "create" },
    content: {
      title: opts.title,
      body: opts.body ?? opts.title,
      summary: opts.summary ?? opts.title
    },
    scope: { project: "SubstrateStress", tenant: "local" },
    tags: {
      category: ["memory"],
      type: [kind],
      subject: opts.subject ?? [opts.title],
      project: ["SubstrateStress"],
      idea: [opts.idea ?? "memory-substrate-stress"],
      timestamp: [NOW.toISOString().slice(0, 10)],
      topics,
      entities: ["SubstrateStress", ...(opts.entities ?? [])],
      identities: [`actor:${producer}`],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["synthetic", "tested"]
    },
    evidence: {
      source_refs: opts.sourceRefs ?? [`stress:${opts.title}`],
      depends_on: opts.dependsOn ?? [],
      supports: opts.supports ?? [],
      contradicts: opts.contradicts ?? [],
      concerns: opts.concerns ?? []
    },
    confidence: {
      value: confidence,
      uncertainty: opts.uncertainty ?? 0.08,
      concern: opts.concern ?? 0.1,
      source_quality: sourceQuality,
      stability: opts.stability ?? "stable"
    },
    provenance: {
      created_at: NOW.toISOString(),
      origin: opts.origin ?? "llm",
      produced_by: producer,
      verification,
      signature_status: opts.signatureStatus ?? "unsigned"
    },
    policy: {
      sensitivity: "private",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: opts.reverifyAfter ?? null
    }
  };
}

function admit(store, opts) {
  const result = admitWriteProposal(proposal(opts), store, { now: NOW });
  if (!result.accepted || !result.node) {
    throw new Error(`Admission failed for "${opts.title}": ${JSON.stringify(result.issues)}`);
  }
  return result.node;
}

function packetText(store, task, words = 520) {
  return formatContextPacket(compileContext(store, { task, budgetWords: words }));
}

function findHit(store, query, needle) {
  return store.search(query, 10).find((hit) => hit.title.includes(needle));
}

function firstCurrentHit(store, query) {
  return store.search(query, 10).find((hit) => hit.challenged !== true);
}

function guardedToolAction(programRun) {
  if (programRun.output.tripped === true) {
    return { allowed: false, reason: "watcher-tripped-before-tool" };
  }
  return { allowed: true, reason: "watcher-stable" };
}

function topologicalTitles(store, analysis) {
  return analysis.topologicalOrder.map((id) => store.getNode(id)?.title ?? id);
}

function respectsOrder(order, before, after) {
  return order.indexOf(before) >= 0 && order.indexOf(after) >= 0 && order.indexOf(before) < order.indexOf(after);
}

function result(name, pass, evidence) {
  return { name, pass: Boolean(pass), evidence };
}

function scenarioSupersededCells() {
  const env = makeTempStore();
  try {
    const oldCell = admit(env.store, {
      kind: "decision",
      title: "S1 deploy endpoint is api-old.internal",
      body: "The deploy endpoint is api-old.internal.",
      confidence: 0.92,
      topics: ["s1", "deploy", "endpoint"],
      producer: "planner"
    });
    const current = admit(env.store, {
      kind: "decision",
      title: "S1 deploy endpoint is api-new.internal",
      body: "The deploy endpoint is api-new.internal and replaces api-old.internal.",
      confidence: 0.94,
      topics: ["s1", "deploy", "endpoint"],
      producer: "release-checker",
      contradicts: [oldCell.id]
    });
    admit(env.store, {
      kind: "witness",
      title: "S1 deploy smoke test confirmed api-new.internal",
      body: "A release smoke test confirmed api-new.internal and invalidated api-old.internal.",
      confidence: 0.88,
      topics: ["s1", "deploy", "endpoint"],
      producer: "release-smoke",
      verification: "tested",
      supports: [current.id],
      contradicts: [oldCell.id]
    });

    const oldHit = findHit(env.store, "S1 deploy endpoint", "api-old.internal");
    const currentHit = findHit(env.store, "S1 deploy endpoint", "api-new.internal");
    const first = firstCurrentHit(env.store, "S1 deploy endpoint");
    const packet = packetText(env.store, "S1 current deploy endpoint");
    const pass =
      oldHit?.challenged === true &&
      (currentHit?.effectiveConfidence ?? 0) > (oldHit?.effectiveConfidence ?? 1) &&
      first?.title.includes("api-new.internal") &&
      /api-new\.internal/.test(packet) &&
      /contradicts|challenged|eff:/.test(packet);
    return result("avoid acting on superseded cells", pass, {
      firstCurrentTitle: first?.title,
      oldChallenged: oldHit?.challenged,
      oldEffective: oldHit?.effectiveConfidence,
      currentEffective: currentHit?.effectiveConfidence
    });
  } finally {
    env.cleanup();
  }
}

function scenarioWatcherBeforeTool() {
  const env = makeTempStore();
  try {
    const permit = admit(env.store, {
      kind: "decision",
      title: "S2 release-deploy tool edge is permitted",
      body: "The release-deploy tool edge is permitted while approvals remain valid.",
      confidence: 0.9,
      topics: ["s2", "release-deploy", "tool-edge"],
      producer: "ops-policy"
    });
    const edge = env.store.addHyperedge({
      kind: "tool-edge-constraint",
      title: "S2 release-deploy edge watcher",
      members: [{ nodeId: permit.id, role: "permit" }],
      metadata: { tool: "release-deploy", phase: "pre-tool" }
    });
    const program = env.store.attachProgram(edge.id, {
      schemaVersion: "recall.program.v1",
      operation: "watch",
      params: { delta: 0.1, concernTarget: permit.id }
    });
    const baseline = env.store.runProgram(program.id);
    admit(env.store, {
      kind: "risk",
      title: "S2 release-deploy tool edge blocked by missing approval",
      body: "The release-deploy tool edge must not run because approval was revoked.",
      confidence: 0.95,
      topics: ["s2", "release-deploy", "tool-edge"],
      producer: "guard",
      contradicts: [permit.id]
    });
    const after = env.store.runProgram(program.id);
    const action = guardedToolAction(after);
    const packet = packetText(env.store, "S2 release-deploy tool action");
    const pass =
      baseline.output.tripped === false &&
      after.output.tripped === true &&
      action.allowed === false &&
      /standing_programs:/.test(packet) &&
      /watch/.test(packet) &&
      /blocked by missing approval/.test(packet);
    return result("respect watcher and edge constraints before tool actions", pass, {
      baselineTripped: baseline.output.tripped,
      afterTripped: after.output.tripped,
      toolAllowed: action.allowed,
      reason: action.reason
    });
  } finally {
    env.cleanup();
  }
}

function scenarioDagOrdering() {
  const env = makeTempStore();
  try {
    const plan = admit(env.store, { title: "S3 plan migration", topics: ["s3", "dag"], producer: "planner" });
    const schema = admit(env.store, { title: "S3 apply schema", topics: ["s3", "dag"], producer: "planner" });
    const deploy = admit(env.store, { title: "S3 deploy service", topics: ["s3", "dag"], producer: "planner" });
    const overlay = env.store.addDagOverlay({
      title: "S3 release DAG",
      nodeIds: [plan.id, schema.id, deploy.id],
      edges: [
        { from: plan.id, to: schema.id, label: "before" },
        { from: schema.id, to: deploy.id, label: "before" }
      ],
      metadata: { scenario: "dag-order" }
    });
    const analysis = env.store.analyzeDagOverlay(overlay.id);
    const order = topologicalTitles(env.store, analysis);
    let cycleRejected = false;
    try {
      env.store.addDagOverlay({
        title: "S3 invalid release cycle",
        nodeIds: [plan.id, schema.id, deploy.id],
        edges: [
          { from: plan.id, to: schema.id },
          { from: schema.id, to: deploy.id },
          { from: deploy.id, to: plan.id }
        ],
        metadata: {}
      });
    } catch (error) {
      cycleRejected = /cycle/i.test(String(error?.message ?? error));
    }
    const wrongOrder = ["S3 deploy service", "S3 apply schema", "S3 plan migration"];
    const pass =
      analysis.isDag === true &&
      respectsOrder(order, "S3 plan migration", "S3 apply schema") &&
      respectsOrder(order, "S3 apply schema", "S3 deploy service") &&
      !respectsOrder(wrongOrder, "S3 plan migration", "S3 deploy service") &&
      cycleRejected;
    return result("order work according to DAG dependencies", pass, {
      order,
      cycleRejected,
      witnessCount: analysis.witnesses.length
    });
  } finally {
    env.cleanup();
  }
}

function scenarioEffectiveConfidence() {
  const env = makeTempStore();
  try {
    const oldCell = admit(env.store, {
      kind: "decision",
      title: "S4 cache TTL is 60 seconds",
      body: "Cache TTL is 60 seconds.",
      confidence: 0.95,
      topics: ["s4", "cache", "ttl"],
      producer: "old-doc"
    });
    const current = admit(env.store, {
      kind: "decision",
      title: "S4 cache TTL is 30 seconds",
      body: "Cache TTL is 30 seconds.",
      confidence: 0.82,
      topics: ["s4", "cache", "ttl"],
      producer: "runtime-check",
      verification: "tested",
      contradicts: [oldCell.id]
    });
    admit(env.store, {
      kind: "witness",
      title: "S4 runtime probe confirmed cache TTL 30 seconds",
      body: "A runtime probe observed cache expiration after 30 seconds.",
      confidence: 0.9,
      topics: ["s4", "cache", "ttl"],
      producer: "runtime-probe",
      verification: "tested",
      supports: [current.id],
      contradicts: [oldCell.id]
    });
    admit(env.store, {
      kind: "witness",
      title: "S4 deployment log confirmed cache TTL 30 seconds",
      body: "Deployment log shows CACHE_TTL_SECONDS=30.",
      confidence: 0.86,
      topics: ["s4", "cache", "ttl"],
      producer: "deploy-log",
      verification: "checked",
      supports: [current.id],
      contradicts: [oldCell.id]
    });

    const oldHit = findHit(env.store, "S4 cache TTL seconds", "60 seconds");
    const currentHit = findHit(env.store, "S4 cache TTL seconds", "30 seconds");
    const first = firstCurrentHit(env.store, "S4 cache TTL seconds");
    const pass =
      oldHit?.challenged === true &&
      (currentHit?.effectiveConfidence ?? 0) > (oldHit?.effectiveConfidence ?? 1) &&
      first?.title.includes("30 seconds");
    return result("choose higher effective-confidence evidence over stale claims", pass, {
      firstCurrentTitle: first?.title,
      oldChallenged: oldHit?.challenged,
      oldEffective: oldHit?.effectiveConfidence,
      currentEffective: currentHit?.effectiveConfidence
    });
  } finally {
    env.cleanup();
  }
}

function scenarioProvenanceAndTrust() {
  const env = makeTempStore();
  try {
    for (let i = 0; i < 3; i += 1) {
      const bad = admit(env.store, {
        kind: "observation",
        title: `S5 overconfident stale claim ${i}`,
        body: `Bad calibration claim ${i}.`,
        confidence: 0.95,
        topics: ["s5", "calibration"],
        producer: "overconfident-bot"
      });
      admit(env.store, {
        kind: "witness",
        title: `S5 checker refuted stale claim ${i}`,
        body: `Checker refuted bad calibration claim ${i}.`,
        confidence: 0.9,
        topics: ["s5", "calibration"],
        producer: "ci-checker",
        verification: "tested",
        contradicts: [bad.id]
      });
    }
    admit(env.store, {
      kind: "decision",
      title: "S5 payment endpoint is sandbox",
      body: "Payment endpoint is sandbox.",
      confidence: 0.95,
      topics: ["s5", "payment", "endpoint"],
      producer: "overconfident-bot"
    });
    const trusted = admit(env.store, {
      kind: "decision",
      title: "S5 payment endpoint is production",
      body: "Payment endpoint is production.",
      confidence: 0.74,
      topics: ["s5", "payment", "endpoint"],
      producer: "ci-checker",
      verification: "tested",
      sourceQuality: "high"
    });
    admit(env.store, {
      kind: "witness",
      title: "S5 smoke test used production payment endpoint",
      body: "CI smoke test used the production payment endpoint.",
      confidence: 0.88,
      topics: ["s5", "payment", "endpoint"],
      producer: "ci-smoke",
      verification: "tested",
      supports: [trusted.id]
    });

    const health = analyzeMemory(env.store, NOW);
    const bot = health.calibration.find((row) => row.actor === "overconfident-bot");
    const trustedHit = findHit(env.store, "S5 payment endpoint", "production");
    const botHit = findHit(env.store, "S5 payment endpoint", "sandbox");
    const first = firstCurrentHit(env.store, "S5 payment endpoint");
    const packet = packetText(env.store, "S5 payment endpoint decision");
    const pass =
      (bot?.contradicted ?? 0) >= 3 &&
      first?.title.includes("production") &&
      trustedHit?.provenance?.produced_by === "ci-checker" &&
      trustedHit?.provenance?.verification === "tested" &&
      (trustedHit?.effectiveConfidence ?? 0) > (botHit?.effectiveConfidence ?? 1) &&
      /eff:/.test(packet) &&
      /source:high/.test(packet);
    return result("preserve provenance and trust when deciding", pass, {
      botCalibration: bot,
      firstCurrentTitle: first?.title,
      botEffective: botHit?.effectiveConfidence,
      trustedEffective: trustedHit?.effectiveConfidence,
      trustedProducer: trustedHit?.provenance?.produced_by,
      trustedVerification: trustedHit?.provenance?.verification
    });
  } finally {
    env.cleanup();
  }
}

function scenarioCrossSessionCoherence() {
  const dir = mkdtempSync(join(os.tmpdir(), "recall-substrate-session-"));
  const db = join(dir, "recall.sqlite3");
  let store = new SQLiteRecallStore(db);
  let dagId;
  try {
    const oldCell = admit(store, {
      kind: "decision",
      title: "S6 resume deploy endpoint is api-old.internal",
      confidence: 0.91,
      topics: ["s6", "resume", "endpoint"],
      producer: "prior-session"
    });
    const current = admit(store, {
      kind: "decision",
      title: "S6 resume deploy endpoint is api-new.internal",
      confidence: 0.93,
      topics: ["s6", "resume", "endpoint"],
      producer: "current-session",
      contradicts: [oldCell.id]
    });
    admit(store, {
      kind: "witness",
      title: "S6 resume smoke confirmed api-new.internal",
      confidence: 0.88,
      topics: ["s6", "resume", "endpoint"],
      producer: "resume-smoke",
      verification: "tested",
      supports: [current.id],
      contradicts: [oldCell.id]
    });
    const permit = admit(store, {
      kind: "decision",
      title: "S6 resume deploy gate permit",
      confidence: 0.88,
      topics: ["s6", "resume", "gate"],
      producer: "guard"
    });
    const edge = store.addHyperedge({
      kind: "tool-edge-constraint",
      title: "S6 resume deploy gate watcher",
      members: [{ nodeId: permit.id, role: "permit" }],
      metadata: { tool: "resume-deploy" }
    });
    const program = store.attachProgram(edge.id, {
      schemaVersion: "recall.program.v1",
      operation: "watch",
      params: { delta: 0.1 }
    });
    store.runProgram(program.id);
    admit(store, {
      kind: "risk",
      title: "S6 resume deploy gate blocked",
      confidence: 0.95,
      topics: ["s6", "resume", "gate"],
      producer: "guard",
      contradicts: [permit.id]
    });
    store.runProgram(program.id);
    const inspect = admit(store, { title: "S6 inspect state", topics: ["s6", "dag"], producer: "planner" });
    const plan = admit(store, { title: "S6 plan action", topics: ["s6", "dag"], producer: "planner" });
    const execute = admit(store, { title: "S6 execute action", topics: ["s6", "dag"], producer: "planner" });
    dagId = store.addDagOverlay({
      title: "S6 resume DAG",
      nodeIds: [inspect.id, plan.id, execute.id],
      edges: [
        { from: inspect.id, to: plan.id },
        { from: plan.id, to: execute.id }
      ],
      metadata: { scenario: "cross-session" }
    }).id;
    store.close?.();

    store = new SQLiteRecallStore(db);
    const oldHit = findHit(store, "S6 resume deploy endpoint", "api-old.internal");
    const first = firstCurrentHit(store, "S6 resume deploy endpoint");
    const trippedRuns = store.listProgramRuns(20).filter((run) => run.output.tripped === true);
    const order = topologicalTitles(store, store.analyzeDagOverlay(dagId));
    const packet = packetText(store, "S6 resume deploy work");
    const pass =
      oldHit?.challenged === true &&
      first?.title.includes("api-new.internal") &&
      trippedRuns.length >= 1 &&
      respectsOrder(order, "S6 inspect state", "S6 execute action") &&
      /api-new\.internal/.test(packet) &&
      /S6 resume deploy gate blocked/.test(packet);
    return result("behave coherently across sessions without re-explaining invariants", pass, {
      firstCurrentTitle: first?.title,
      oldChallenged: oldHit?.challenged,
      trippedRuns: trippedRuns.length,
      order
    });
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenarios = [
  scenarioSupersededCells,
  scenarioWatcherBeforeTool,
  scenarioDagOrdering,
  scenarioEffectiveConfidence,
  scenarioProvenanceAndTrust,
  scenarioCrossSessionCoherence
];

const results = scenarios.map((run) => run());
const passed = results.filter((entry) => entry.pass).length;
const failed = results.length - passed;

console.log("==================== MEMORY SUBSTRATE STRESS ====================");
console.log("Deterministic LLM-operating-state checks over Recall graph machinery.\n");
for (const entry of results) {
  console.log(`${entry.pass ? "PASS" : "FAIL"} ${entry.name}`);
  console.log(`  ${JSON.stringify(entry.evidence)}`);
}
console.log(`\nscore: ${passed}/${results.length} passed`);
console.log("JSON " + JSON.stringify({ passed, failed, results }));

if (failed > 0) {
  process.exitCode = 1;
}
