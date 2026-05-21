import assert from "node:assert/strict";
import test from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { renderTui } from "../src/core/tui.js";
import { installLaunchAgent, launchAgentStatus, renderLaunchAgentPlist, uninstallLaunchAgent } from "../src/core/service.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hyperedges, sandboxed programs, DAG overlays, evals, rollback, and TUI share one store", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const first = admitWriteProposal(makeProposal({ content: { title: "Cell A", body: "A supports the runtime graph." } }), store);
    const second = admitWriteProposal(
      makeProposal({ content: { title: "Cell B", body: "B supports a second route." }, evidence: { supports: [first.node!.id] } }),
      store
    );
    assert.ok(first.node);
    assert.ok(second.node);

    const hyperedge = store.addHyperedge({
      kind: "supports",
      title: "Runtime support relation",
      members: [
        { nodeId: first.node.id, role: "source" },
        { nodeId: second.node.id, role: "target" }
      ],
      metadata: { purpose: "test" }
    });
    const program = store.attachProgram(hyperedge.id, {
      schemaVersion: "recall.program.v1",
      operation: "score"
    });
    assert.equal(store.getProgram(program.id)?.id, program.id);
    assert.equal(store.listPrograms().length, 1);
    const run = store.runProgram(program.id);
    assert.equal(run.hyperedgeId, hyperedge.id);
    assert.equal(run.output.memberCount, 2);
    assert.equal(run.output.averageConfidence, 0.72);
    assert.equal(run.output.maxConcern, 0.4);
    assert.equal(store.getProgramRun(run.id)?.id, run.id);
    const derivedRun = store.runProgramAndDerive(program.id);
    assert.equal(derivedRun.derived.length, 1);
    assert.equal(derivedRun.derived[0]?.accepted, true);
    assert.equal(derivedRun.derived[0]?.node?.kind, "witness");
    const duplicateRun = store.runProgramAndDerive(program.id);
    assert.equal(duplicateRun.derived[0]?.accepted, true);
    assert.equal(duplicateRun.derived[0]?.duplicateOf, derivedRun.derived[0]?.node?.id);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["program_run"] }).length, 1);

    const overlay = store.addDagOverlay({
      title: "Two path overlay",
      nodeIds: [first.node.id, second.node.id, "third"],
      edges: [
        { from: first.node.id, to: second.node.id, label: "direct" },
        { from: first.node.id, to: "third", label: "via" },
        { from: "third", to: second.node.id, label: "indirect" }
      ]
    });
    assert.equal(store.getDagOverlay(overlay.id)?.id, overlay.id);
    const analysis = store.analyzeDagOverlay(overlay.id);
    assert.equal(analysis.isDag, true);
    assert.equal(analysis.witnesses.length, 1);
    const derivedAnalysis = store.analyzeDagOverlayAndDerive(overlay.id);
    assert.equal(derivedAnalysis.derived.length, 2);
    assert.equal(derivedAnalysis.derived.every((item) => item.accepted), true);
    const duplicateAnalysis = store.analyzeDagOverlayAndDerive(overlay.id);
    assert.equal(duplicateAnalysis.derived.every((item) => item.duplicateOf), true);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["dag_holonomy"] }).length, 2);

    const evalClosure = store.runEvalAndDerive({
      name: "runtime-regression",
      cases: []
    });
    assert.equal(evalClosure.result.passed, true);
    assert.equal(evalClosure.derived[0]?.accepted, true);
    const duplicateEvalClosure = store.runEvalAndDerive({
      name: "runtime-regression",
      cases: []
    });
    assert.equal(duplicateEvalClosure.derived[0]?.duplicateOf, evalClosure.derived[0]?.node?.id);
    assert.equal(store.listEvalRuns().length, 2);
    assert.equal(store.getEvalRun(store.listEvalRuns()[0]!.id)?.name, "runtime-regression");
    assert.equal(store.subgraph({ category: ["derivation"], type: ["eval_run"] }).length, 1);

    const reindex = store.reindexSemantic();
    assert.equal(reindex.indexed, store.stats().nodes);
    assert.equal(reindex.backend, "hash:v1");

    const rollback = store.applyRollback(first.rollbackEntries[0]!.id, true);
    assert.equal(rollback.applied, true);
    assert.equal(store.getNode(first.node.id)?.status, "archived");

    const tui = renderTui(store);
    assert.match(tui, /Recall TUI/);
    assert.equal(store.stats().hyperedges, 1);
    assert.equal(store.stats().programs, 1);
    assert.equal(store.stats().dagOverlays, 1);
    assert.equal(store.stats().evalRuns, 2);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("LaunchAgent helpers render, install, report, and uninstall without loading system services", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-launchagent-"));
  try {
    const options = {
      label: "io.recall.memory.test",
      dbPath: ".recall/test.sqlite3",
      intervalMs: 1000,
      nodeBin: process.execPath,
      cliPath: join(process.cwd(), "dist/src/cli.js"),
      cwd: process.cwd(),
      launchAgentsDir: dir
    };
    assert.match(renderLaunchAgentPlist(options), /io.recall.memory.test/);
    const installed = installLaunchAgent(options);
    assert.equal(installed.exists, true);
    assert.equal(launchAgentStatus(options.label, dir).exists, true);
    assert.equal(uninstallLaunchAgent(options.label, dir).exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
