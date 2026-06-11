import assert from "node:assert/strict";
import test from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { inspectCell } from "../src/core/cell-context.js";
import { compileContext, formatContextPacket } from "../src/core/context-compiler.js";
import { runCognitiveTick } from "../src/core/cognitive.js";
import { runDaemonOnce } from "../src/core/daemon.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { ProposalScope } from "../src/core/types.js";
import { makeProposal, tempDbPath } from "./helpers.js";

const scope: ProposalScope = {
  project: "Recall",
  path: "/tmp/recall",
  tenant: "local",
  session: "closure-derive-test"
};

test("runtime derivations close into ID-first compiler handles", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const source = admitWriteProposal(
      makeProposal({
        content: {
          title: "Alpha handle source",
          body: "DO_NOT_INLINE_SOURCE_BODY. This body is only for expansion-handle regression coverage.",
          summary: "EXPAND_ONLY_SOURCE_SUMMARY"
        },
        tags: {
          subject: ["handle-source"],
          idea: ["expansion-handle-source"],
          topics: ["source-only"],
          entities: ["alpha-source"]
        },
        confidence: {
          value: 0.84,
          uncertainty: 0.1,
          concern: 0.17,
          source_quality: "high",
          stability: "stable"
        },
        provenance: {
          created_at: "2026-05-21T10:00:00.000Z"
        }
      }),
      store
    );
    const target = admitWriteProposal(
      makeProposal({
        content: {
          title: "Beta closure target",
          body: "Target cell for runtime closure checks.",
          summary: "Target summary for DAG closure."
        },
        tags: {
          subject: ["closure-target"],
          idea: ["closure-target"],
          topics: ["closure-target"],
          entities: ["beta-target"]
        },
        provenance: {
          created_at: "2026-05-21T10:01:00.000Z"
        }
      }),
      store
    );
    assert.ok(source.node);
    assert.ok(target.node);

    const hyperedge = store.addHyperedge({
      id: "closure-program-hyperedge",
      kind: "supports",
      title: "Closure runtime program edge",
      members: [
        { nodeId: `${source.node.cellAddress}#content.summary`, role: "source" },
        { nodeId: target.node.cellAddress, role: "target" }
      ],
      metadata: { purpose: "closure-derive-test" }
    });
    const program = store.attachProgram(hyperedge.id, {
      schemaVersion: "recall.program.v1",
      operation: "score",
      description: "closure derive integration score"
    });
    const programClosure = store.runProgramAndDerive(program.id, {
      scope,
      actorId: "closure-program",
      producedBy: "closure-program"
    });
    assert.equal(programClosure.derived.length, 1);
    assert.equal(programClosure.derived[0]?.accepted, true);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["program_run"] }).length, 1);

    const overlay = store.addDagOverlay({
      id: "closure-dag-overlay",
      title: "Closure DAG overlay",
      nodeIds: [source.node.cellAddress, target.node.cellAddress, "third-runtime-node"],
      edges: [
        { from: source.node.cellAddress, to: target.node.cellAddress, label: "direct" },
        { from: source.node.cellAddress, to: "third-runtime-node", label: "via" },
        { from: "third-runtime-node", to: target.node.cellAddress, label: "indirect" }
      ]
    });
    const dagClosure = store.analyzeDagOverlayAndDerive(overlay.id, {
      scope,
      actorId: "closure-dag",
      producedBy: "closure-dag",
      createdAt: "2026-05-21T10:05:00.000Z"
    });
    assert.equal(dagClosure.derived.length, 2);
    assert.equal(dagClosure.derived.every((result) => result.accepted), true);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["dag_holonomy"] }).length, 2);

    const evalClosure = store.runEvalAndDerive(
      {
        name: "closure-eval-suite",
        cases: [
          {
            name: "program derivation is retrievable",
            kind: "search",
            query: "closure-program-hyperedge",
            expectContains: "program_run",
            minResults: 1
          },
          {
            name: "compiler can see derivations",
            kind: "compile",
            task: "closure-program-hyperedge derivation",
            expectContains: "Program run witness",
            maxWords: 900
          }
        ]
      },
      {
        scope,
        actorId: "closure-eval",
        producedBy: "closure-eval"
      },
      new Date("2026-05-21T10:10:00.000Z")
    );
    assert.equal(evalClosure.result.passed, true);
    assert.equal(evalClosure.derived[0]?.accepted, true);

    const daemonClosure = runDaemonOnce(store, new Date("2026-05-21T10:15:00.000Z"), {
      derive: true,
      lease: {
        name: "recall-daemon-closure-test",
        owner: "closure-derive-test",
        ttlMs: 1000
      }
    });
    assert.equal(daemonClosure.status, "ran");
    assert.equal(daemonClosure.result.accepted, true);
    assert.equal(daemonClosure.evalClosure?.derived[0]?.accepted, true);
    assert.equal((daemonClosure.semanticReindex?.indexed ?? 0) > 0, true);

    const tickClosure = runCognitiveTick(store, new Date("2026-05-21T10:20:00.000Z"), true);
    assert.equal(tickClosure.result?.accepted, true);
    assert.equal(store.subgraph({ category: ["runtime"], type: ["maintenance_observation"], idea: ["derivation_closure"] }).length >= 1, true);
    assert.equal(store.subgraph({ category: ["runtime"], type: ["cognitive_tick"] }).length, 1);
    assert.equal(store.subgraph({ category: ["derivation"], type: ["eval_run"] }).length >= 2, true);

    const sourceSummaryHandle = `${source.node.id}#content.summary`;
    const packet = compileContext(store, {
      task: "closure-program-hyperedge closure-dag-overlay closure-eval-suite daemon cognitive tick derivation program",
      budgetWords: 2500
    });
    const formatted = formatContextPacket(packet);

    assert.match(formatted, /Program run witness/);
    assert.match(formatted, /DAG holonomy witness/);
    assert.match(formatted, /Eval run: closure-eval-suite/);
    assert.match(formatted, /Daemon maintenance pass/);
    assert.match(formatted, /Recall cognitive tick/);
    assert.match(packet.compilerState.join("\n"), /policy=ids-first/);
    assert.equal(packet.expansionHandles.every((handle) => !handle.startsWith("recall://cell/")), true);
    assert.equal(packet.expansionHandles.includes(sourceSummaryHandle), true);
    assert.equal(packet.translatedReferences.some((line) => line.includes(`handle=${sourceSummaryHandle}`)), true);
    assert.equal(packet.cellState.every((line) => !line.includes("body=")), true);
    assert.equal(packet.translatedReferences.some((line) => line.includes("EXPAND_ONLY_SOURCE_SUMMARY")), false);
    assert.doesNotMatch(formatted, /DO_NOT_INLINE_SOURCE_BODY/);

    const expanded = inspectCell(store, sourceSummaryHandle);
    assert.equal(expanded.requestedField?.path, "content.summary");
    assert.equal(expanded.requestedField?.valuePreview, "EXPAND_ONLY_SOURCE_SUMMARY");

    const inlinePacket = compileContext(store, {
      task: "closure-program-hyperedge program derivation",
      budgetWords: 1200,
      inlineReferenceValues: true,
      includeReferenceParameters: true
    });
    assert.equal(inlinePacket.translatedReferences.some((line) => line.includes("EXPAND_ONLY_SOURCE_SUMMARY")), true);
    assert.equal(
      inlinePacket.referenceParameters.some((line) => line.includes(`handle=${sourceSummaryHandle}`) && line.includes("value_kind=string")),
      true
    );
  } finally {
    store.close();
    temp.cleanup();
  }
});
