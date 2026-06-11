import assert from "node:assert/strict";
import test from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { analyzeMemory, memoryHealthToProposal } from "../src/core/analysis.js";
import { inspectCell } from "../src/core/cell-context.js";
import { compileContext } from "../src/core/context-compiler.js";
import { runCognitiveTick } from "../src/core/cognitive.js";
import { buildPageIndex, getRecallPage } from "../src/core/pages.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { storageStats } from "../src/core/storage-stats.js";
import { allocateWork, allocationToProposal, blindLockToProposal } from "../src/core/workflow.js";
import { makeProposal, tempDbPath } from "./helpers.js";

test("memory health finds belief pressure, stale cells, and contradiction relations", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const belief = admitWriteProposal(
      makeProposal({
        intent: { kind: "belief_update", operation: "create" },
        content: {
          title: "Compiler packets improve recall",
          body: "Compiled context packets should improve retrieval usefulness.",
          summary: "Compiler packets are believed useful."
        },
        tags: {
          type: ["belief_update"],
          subject: ["compiler"],
          idea: ["belief-pressure"]
        }
      }),
      store
    );
    assert.ok(belief.node);
    assert.equal(belief.node.kind, "belief");

    admitWriteProposal(
      makeProposal({
        content: {
          title: "Compiler packet support witness",
          body: "The compiler returns compact packets from graph evidence.",
          summary: "Compiler packet support exists."
        },
        evidence: { supports: [belief.node.id] },
        confidence: { value: 0.9, uncertainty: 0.1, concern: 0.15, source_quality: "high" }
      }),
      store
    );

    admitWriteProposal(
      makeProposal({
        content: {
          title: "Compiler packet contradiction witness",
          body: "A stale compiler packet can omit newer contradiction evidence.",
          summary: "Compiler packet contradiction exists."
        },
        evidence: { contradicts: [belief.node.id] },
        confidence: { value: 0.85, uncertainty: 0.25, concern: 0.9, source_quality: "high" }
      }),
      store
    );

    admitWriteProposal(
      makeProposal({
        content: {
          title: "Stale temporary runtime note",
          body: "This temporary note needs re-verification.",
          summary: "Temporary note is stale."
        },
        confidence: { value: 0.4, uncertainty: 0.8, concern: 0.7, source_quality: "unknown", stability: "ephemeral" },
        provenance: {
          created_at: "2026-05-18T00:00:00.000Z",
          verification: "unverified"
        },
        policy: {
          reverify_after: "2026-05-19T00:00:00.000Z"
        }
      }),
      store
    );

    const report = analyzeMemory(store, new Date("2026-05-21T20:00:00.000Z"));
    assert.equal(report.beliefs.length, 1);
    assert.equal(report.beliefs[0]?.nodeId, belief.node.id);
    assert.equal(report.contradictions.some((item) => item.targetId === belief.node?.id), true);
    assert.equal(report.stale.some((item) => item.title === "Stale temporary runtime note"), true);
    assert.ok(report.nextActions.length >= 1);

    const healthWrite = admitWriteProposal(memoryHealthToProposal(report), store);
    assert.equal(healthWrite.accepted, true);
    assert.equal(healthWrite.node?.kind, "witness");

    const packet = compileContext(store, { task: "compiler packets recall", budgetWords: 220 });
    assert.equal(packet.conflicts.some((line) => line.includes("contradicts Compiler packets improve recall")), true);
    assert.equal(packet.staleOrLowTrust.some((line) => line.includes("Stale temporary runtime note")), true);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("paged graph views, cell inspection, storage stats, and cognitive ticks expose CC-style runtime state", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const reflection = admitWriteProposal(
      makeProposal({
        intent: { kind: "reflection", operation: "create" },
        content: {
          title: "Session continuity reflection",
          body: "Recall should show a compact page instead of dumping the whole graph.",
          summary: "Compact page continuity exists."
        },
        tags: {
          category: ["memory"],
          type: ["reflection"],
          subject: ["continuity"],
          idea: ["paged-graph"],
          topics: ["reflection", "continuity"],
          identities: ["agent:codex"]
        }
      }),
      store
    );
    const lemma = admitWriteProposal(
      makeProposal({
        intent: { kind: "lemma", operation: "create" },
        content: {
          title: "Address reuse compresses memory",
          body: "Once a cell has an address, later cells should link to it instead of copying its full body.",
          summary: "Address reuse is the compression primitive."
        },
        evidence: { supports: [`${reflection.node!.cellAddress}#content.summary`] },
        tags: {
          type: ["lemma"],
          subject: ["compression"],
          idea: ["addressable-cells"],
          topics: ["memory", "compression"]
        }
      }),
      store
    );
    assert.equal(reflection.accepted, true);
    assert.equal(reflection.node?.kind, "reflection");
    assert.equal(lemma.accepted, true);
    assert.equal(lemma.node?.kind, "lemma");
    assert.equal(lemma.relations[0]?.targetId, reflection.node?.id);

    const pageIndex = buildPageIndex(store);
    assert.equal(pageIndex.pages.some((page) => page.name === "reflections" && page.count === 1), true);
    assert.equal(getRecallPage(store, "workbench").nodes.some((node) => node.kind === "lemma"), true);

    const cell = inspectCell(store, lemma.node!.id);
    assert.equal(cell.footprint.connectedCellCount, 1);
    assert.equal(cell.connectedCells[0]?.id, reflection.node?.id);
    assert.equal(cell.fieldReferences[0]?.path, "content.summary");
    assert.equal(cell.fieldReferences[0]?.valuePreview, "Compact page continuity exists.");
    assert.equal(cell.footprint.serializedBytes > 0, true);
    const fieldCell = inspectCell(store, `${reflection.node!.id}#content.summary`);
    assert.equal(fieldCell.requestedField?.path, "content.summary");
    assert.equal(fieldCell.requestedField?.valuePreview, "Compact page continuity exists.");

    const storage = storageStats(store);
    assert.equal(storage.cells, 2);
    assert.equal(storage.averageCell.serializedBytes > 0, true);

    const tick = runCognitiveTick(store, new Date("2026-05-21T21:00:00.000Z"), true);
    assert.equal(tick.report.phases.some((phase) => phase.name === "epistemic_repair"), true);
    assert.equal(tick.result?.accepted, true);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("workflow allocation and blind locks admit as typed graph cells", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const allocation = allocateWork(
      [
        {
          id: "low-risk-docs",
          title: "Polish docs",
          impact: 0.4,
          uncertainty: 0.2,
          concern: 0.2,
          dependencyWeight: 0.2,
          cost: 0.3,
          reversibility: 0.9
        },
        {
          id: "runtime-health",
          title: "Verify daemon memory health",
          impact: 0.9,
          uncertainty: 0.8,
          concern: 0.8,
          dependencyWeight: 0.9,
          cost: 0.4,
          reversibility: 0.7,
          novelty: 0.6
        }
      ],
      1,
      new Date("2026-05-21T20:30:00.000Z")
    );

    assert.equal(allocation.selected.length, 1);
    assert.equal(allocation.selected[0]?.id, "runtime-health");

    const allocationWrite = admitWriteProposal(allocationToProposal(allocation), store);
    assert.equal(allocationWrite.accepted, true);
    assert.equal(allocationWrite.node?.kind, "allocation_plan");

    const blindLockWrite = admitWriteProposal(
      blindLockToProposal({
        title: "Recall compiler blind lock",
        prediction: "The compiler will include stale-memory warnings after health analysis is integrated.",
        expectedBy: "2026-05-22T00:00:00.000Z",
        falsifier: "Compiled packets omit stale-memory warnings when stale cells exist.",
        confidence: 0.7,
        createdAt: "2026-05-21T20:35:00.000Z",
        tags: ["compiler", "memory-health"]
      }),
      store
    );
    assert.equal(blindLockWrite.accepted, true);
    assert.equal(blindLockWrite.node?.kind, "blind_lock");
    assert.equal(store.subgraph({ type: ["allocation_plan"] }).length, 1);
    assert.equal(store.subgraph({ type: ["blind_lock"] }).length, 1);
  } finally {
    store.close();
    temp.cleanup();
  }
});
