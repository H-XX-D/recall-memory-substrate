import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// drift: watch with per-member attribution — a tripped run names WHICH
// member moved. quorum: k-of-m distinct-actor sign-off where approvals are
// calibrated cells, not checkboxes.
describe("program vocabulary: drift and quorum", () => {
  function setup() {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    const admit = (overrides: Parameters<typeof makeProposal>[0], at: string) => {
      const result = admitWriteProposal(makeProposal(overrides), store, { now: new Date(at) });
      assert.equal(result.accepted, true);
      return result.node!;
    };
    return { temp, store, admit };
  }

  it("drift names the member that moved", () => {
    const { temp, store, admit } = setup();
    try {
      // Distinct author: otherwise the contradiction below would discount
      // the shared actor's calibration and legitimately move BOTH members.
      const steady = admit({
        actor: { kind: "llm", id: "architect", display: "Architect" },
        provenance: { produced_by: "architect" },
        content: { title: "Steady architecture decision", body: "Unchanged.", summary: "Steady." }
      }, "2026-06-01T00:00:00.000Z");
      const shaky = admit({
        content: { title: "Shaky load verification", body: "Will be contradicted.", summary: "Shaky." }
      }, "2026-06-01T01:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Attributed gate",
        members: [
          { nodeId: steady.id, role: "claim" },
          { nodeId: shaky.id, role: "verification" }
        ]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "drift",
        params: { delta: 0.1 }
      });

      const baseline = store.runProgram(program.id);
      assert.equal(baseline.output.tripped, false);
      assert.ok(typeof baseline.output.memberValues === "object");

      admit({
        content: { title: "Load verification invalid", body: "Cache-only.", summary: "Invalid." },
        evidence: { contradicts: [shaky.id] }
      }, "2026-06-02T00:00:00.000Z");

      const tripped = store.runProgram(program.id);
      assert.equal(tripped.output.tripped, true);
      const topMover = tripped.output.topMover as { nodeId: string; change: number };
      assert.equal(topMover.nodeId, shaky.id, "drift must attribute the move to the contradicted member");
      assert.ok(topMover.change < 0);
      const movers = tripped.output.movers as { nodeId: string; change: number }[];
      assert.ok(!movers.some((m) => m.nodeId === steady.id && Math.abs(m.change) > 0.01),
        "the steady member must not appear as a significant mover");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("quorum counts distinct actors and flips when an approver is contradicted", () => {
    const { temp, store, admit } = setup();
    try {
      const actorCell = (actor: string, title: string, at: string) =>
        admit({
          actor: { kind: "llm", id: actor, display: actor },
          provenance: { produced_by: actor },
          content: { title, body: `${title} body.`, summary: title },
          confidence: { value: 0.85, uncertainty: 0.1, concern: 0.05, source_quality: "high", stability: "stable" }
        }, at);

      const a1 = actorCell("alice", "Alice approves the deploy", "2026-06-01T00:00:00.000Z");
      const a2 = actorCell("bob", "Bob approves the deploy", "2026-06-01T01:00:00.000Z");
      const a3 = actorCell("alice", "Alice approves again", "2026-06-01T02:00:00.000Z");

      const edge = store.addHyperedge({
        kind: "approval-gate",
        title: "Deploy sign-off",
        members: [
          { nodeId: a1.id, role: "approval" },
          { nodeId: a2.id, role: "approval" },
          { nodeId: a3.id, role: "approval" }
        ]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "quorum",
        params: { k: 2, minEff: 0.6, role: "approval" }
      });

      const first = store.runProgram(program.id);
      assert.equal(first.output.passed, true);
      assert.equal(first.output.approverCount, 2, "alice's duplicate approval must not double-count");

      // Bob's approval gets contradicted — his effective confidence sinks
      // below minEff, and the quorum collapses to alice alone.
      admit({
        content: { title: "Bob approved the wrong build", body: "Stale artifact.", summary: "Wrong build." },
        evidence: { contradicts: [a2.id] }
      }, "2026-06-02T00:00:00.000Z");

      const second = store.runProgram(program.id);
      assert.equal(second.output.passed, false);
      assert.equal(second.output.approverCount, 1);
      assert.equal(second.output.shortfall, 1);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("quorum without distinctActors counts approvals, not actors", () => {
    const { temp, store, admit } = setup();
    try {
      const cell = (title: string, at: string) =>
        admit({
          provenance: { produced_by: "solo" },
          content: { title, body: `${title}.`, summary: title },
          confidence: { value: 0.8, uncertainty: 0.1, concern: 0.05, source_quality: "high", stability: "stable" }
        }, at);
      const c1 = cell("Check one passed", "2026-06-01T00:00:00.000Z");
      const c2 = cell("Check two passed", "2026-06-01T01:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "approval-gate",
        title: "Solo checks",
        members: [
          { nodeId: c1.id, role: "approval" },
          { nodeId: c2.id, role: "approval" }
        ]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "quorum",
        params: { k: 2, minEff: 0.6, distinctActors: false }
      });
      const run = store.runProgram(program.id);
      assert.equal(run.output.passed, true);
      assert.equal(run.output.approverCount, 2);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("an untripped drift derives nothing; a quorum run always derives its attestation", () => {
    const { temp, store, admit } = setup();
    try {
      const claim = admit({
        content: { title: "Quiet member", body: "Stable.", summary: "Stable." }
      }, "2026-06-01T00:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Quiet drift gate",
        members: [{ nodeId: claim.id, role: "claim" }]
      });
      const drift = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "drift",
        params: { delta: 0.1 }
      });
      store.runProgram(drift.id); // baseline
      const driftResult = store.runProgramAndDerive(drift.id);
      assert.equal(driftResult.derived.length, 0, "quiet drift must not file paperwork");

      const quorum = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "quorum",
        params: { k: 1, minEff: 0.5 }
      });
      const quorumResult = store.runProgramAndDerive(quorum.id);
      assert.equal(quorumResult.derived.length, 1, "quorum runs are attestations and always derive");
      assert.equal(quorumResult.derived[0]!.accepted, true);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
