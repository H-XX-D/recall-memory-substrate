import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import {
  dagAnalysisToProposals,
  programRunDerivationKey,
  evalResultToEvalRunProposal,
  programRunToWitnessProposal
} from "../src/core/derivation.js";
import { validateWriteProposal } from "../src/core/schema.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { DagAnalysis, ProgramRun, ProposalScope } from "../src/core/types.js";
import type { RecallEvalResult } from "../src/core/evals.js";
import { tempDbPath } from "./helpers.js";

const scope: ProposalScope = {
  project: "Recall",
  path: "/tmp/recall",
  tenant: "local",
  session: "derivation-test"
};

test("program runs derive strict witness proposals admissible by the write path", () => {
  const run: ProgramRun = {
    id: "run-1",
    programId: "program-1",
    hyperedgeId: "hyperedge-1",
    output: {
      operation: "emit_witness",
      score: 0.82,
      maxConcern: 0.15,
      witness: {
        title: "Program observed linked cells",
        summary: "Program emitted a deterministic witness."
      }
    },
    createdAt: "2026-05-21T18:00:00.000Z"
  };

  const proposal = programRunToWitnessProposal(run, { scope, actorId: "program-1" });
  const validation = validateWriteProposal(proposal);
  assert.equal(validation.ok, true);
  assert.equal(proposal.intent.kind, "witness");
  assert.equal(proposal.content.title, "Program observed linked cells");
  assert.deepEqual(proposal.evidence.depends_on, ["hyperedge-1"]);
  assert.match(proposal.content.body, /"kind": "program_run"/);

  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const result = admitWriteProposal(proposal, store);
    assert.equal(result.accepted, true);
    assert.equal(result.node?.kind, "witness");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("rolled back derivations can be derived again into a new active cell", () => {
  const run: ProgramRun = {
    id: "run-rollback-1",
    programId: "program-rollback",
    hyperedgeId: "hyperedge-rollback",
    output: {
      operation: "emit_witness",
      score: 0.91,
      maxConcern: 0.1,
      witness: {
        title: "Program observed rollback-safe derivation",
        summary: "Program emitted a witness that can be re-derived after rollback."
      }
    },
    createdAt: "2026-05-21T18:02:00.000Z"
  };
  const derivationKey = programRunDerivationKey(run);
  const proposal = programRunToWitnessProposal(run, { scope, actorId: "program-rollback" });

  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const first = admitWriteProposal(proposal, store, { derivationKey });
    assert.equal(first.accepted, true);
    assert.ok(first.node);
    assert.equal(store.getNodeByDerivationKey(derivationKey)?.id, first.node.id);

    const rollback = store.applyRollback(first.rollbackEntries[0]!.id, true);
    assert.equal(rollback.applied, true);
    assert.equal(store.getNode(first.node.id)?.status, "archived");
    assert.equal(store.getNodeByDerivationKey(derivationKey), null);

    const second = admitWriteProposal(proposal, store, { derivationKey });
    assert.equal(second.accepted, true);
    assert.ok(second.node);
    assert.notEqual(second.node.id, first.node.id);
    assert.equal(second.duplicateOf, undefined);
    assert.equal(store.getNode(second.node.id)?.status, "active");
    assert.equal(store.getNodeByDerivationKey(derivationKey)?.id, second.node.id);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("rollback of inserted derived nodes also removes attached relations", () => {
  const run: ProgramRun = {
    id: "run-relation-rollback-1",
    programId: "program-relation-rollback",
    hyperedgeId: "hyperedge-relation-rollback",
    output: {
      operation: "emit_witness",
      score: 0.91,
      maxConcern: 0.1,
      witness: {
        title: "Program observed relation rollback",
        summary: "Program emitted a relation-bearing witness."
      }
    },
    createdAt: "2026-05-21T18:03:00.000Z"
  };
  const derivationKey = programRunDerivationKey(run);
  const proposal = programRunToWitnessProposal(run, { scope, actorId: "program-relation-rollback" });

  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const result = admitWriteProposal(proposal, store, { derivationKey });
    assert.equal(result.accepted, true);
    assert.equal(store.stats().relations, 1);

    const rollback = store.applyRollback(result.rollbackEntries[0]!.id, true);
    assert.equal(rollback.applied, true);
    assert.equal(store.stats().relations, 0);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("stale derivation index rows are cleaned during store migration", () => {
  const run: ProgramRun = {
    id: "run-stale-index-1",
    programId: "program-stale-index",
    hyperedgeId: "hyperedge-stale-index",
    output: {
      operation: "emit_witness",
      score: 0.88,
      maxConcern: 0.1
    },
    createdAt: "2026-05-21T18:04:00.000Z"
  };
  const derivationKey = programRunDerivationKey(run);
  const proposal = programRunToWitnessProposal(run, { scope, actorId: "program-stale-index" });

  const temp = tempDbPath();
  const firstStore = new SQLiteRecallStore(temp.path);
  try {
    const result = admitWriteProposal(proposal, firstStore, { derivationKey });
    assert.equal(result.accepted, true);
    firstStore.applyRollback(result.rollbackEntries[0]!.id, true);
  } finally {
    firstStore.close();
  }

  const db = new DatabaseSync(temp.path);
  try {
    db.prepare(
      `INSERT INTO derivation_index (derivation_key, node_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(derivation_key) DO UPDATE SET node_id = excluded.node_id`
    ).run(derivationKey, "missing-or-archived-node", "2026-05-21T18:04:01.000Z");
  } finally {
    db.close();
  }

  const secondStore = new SQLiteRecallStore(temp.path);
  try {
    const result = admitWriteProposal(proposal, secondStore, { derivationKey });
    assert.equal(result.accepted, true);
    assert.equal(result.duplicateOf, undefined);
    assert.equal(secondStore.getNodeByDerivationKey(derivationKey)?.id, result.node?.id);
  } finally {
    secondStore.close();
    temp.cleanup();
  }
});

test("DAG holonomy analysis derives witness and concern proposals", () => {
  const analysis: DagAnalysis = {
    overlayId: "overlay-1",
    isDag: true,
    topologicalOrder: ["a", "b", "c"],
    cycles: [],
    witnesses: [
      {
        from: "a",
        to: "c",
        pathCount: 2,
        signatures: ["direct", "via/indirect"],
        concern: 0.75
      }
    ]
  };

  const proposals = dagAnalysisToProposals(analysis, {
    scope,
    actorId: "recall-dag",
    createdAt: "2026-05-21T18:05:00.000Z"
  });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0]?.intent.kind, "witness");
  assert.equal(proposals[1]?.intent.kind, "risk");
  assert.deepEqual(proposals[1]?.evidence.concerns, ["a", "c"]);

  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    for (const proposal of proposals) {
      assert.equal(validateWriteProposal(proposal).ok, true);
      assert.equal(admitWriteProposal(proposal, store).accepted, true);
    }
    assert.equal(store.stats().nodes, 2);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("eval results derive eval_run-tagged proposals", () => {
  const evalResult: RecallEvalResult = {
    name: "runtime-regression",
    passed: true,
    score: 1,
    createdAt: "2026-05-21T18:10:00.000Z",
    cases: [
      {
        name: "find cell",
        kind: "search",
        passed: true,
        score: 1,
        details: {
          resultCount: 2
        }
      }
    ]
  };

  const proposal = evalResultToEvalRunProposal(evalResult, { scope, actorId: "recall-eval" });
  assert.equal(validateWriteProposal(proposal).ok, true);
  assert.equal(proposal.intent.kind, "witness");
  assert.ok(proposal.tags.type?.includes("eval_run"));
  assert.match(proposal.content.body, /"kind": "eval_run"/);

  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const result = admitWriteProposal(proposal, store);
    assert.equal(result.accepted, true);
    assert.equal(result.node?.tags.type?.includes("eval_run"), true);
  } finally {
    store.close();
    temp.cleanup();
  }
});
