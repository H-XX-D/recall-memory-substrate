import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { compileContext, formatContextPacket } from "../src/core/context-compiler.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// Graph reflexes: watch programs baseline against their own run history,
// trip on deltas in the bundle's live effective confidence, and — via
// --derive — file CLAIMS through admission (a concern against the named
// target), never value assignments. Silence means verified stability.
describe("watch reflexes", () => {
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

  it("first run establishes a baseline and never trips", () => {
    const { temp, store, admit } = setup();
    try {
      const claim = admit({
        content: { title: "Deploy is safe", body: "All green.", summary: "Safe." }
      }, "2026-06-01T00:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Deploy gate",
        members: [{ nodeId: claim.id, role: "claim" }]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "watch",
        params: { delta: 0.1 }
      });
      const run = store.runProgram(program.id);
      assert.equal(run.output.tripped, false);
      assert.equal(run.output.previous, null);
      assert.ok(typeof run.output.current === "number");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("trips when the bundle's live value moves more than delta, stays quiet otherwise", () => {
    const { temp, store, admit } = setup();
    try {
      const claim = admit({
        content: { title: "Load test validates the deploy", body: "Held 2x.", summary: "Load OK." }
      }, "2026-06-01T00:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Watched gate",
        members: [{ nodeId: claim.id, role: "verification" }]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "watch",
        params: { delta: 0.1 }
      });

      store.runProgram(program.id); // baseline
      const quiet = store.runProgram(program.id); // nothing changed
      assert.equal(quiet.output.tripped, false);
      assert.equal(quiet.output.change, 0);

      // The world changes: the verification gets contradicted.
      admit({
        content: { title: "Load test was invalid", body: "Cache-only path.", summary: "Invalid." },
        evidence: { contradicts: [claim.id] }
      }, "2026-06-02T00:00:00.000Z");

      const tripped = store.runProgram(program.id);
      assert.equal(tripped.output.tripped, true);
      assert.ok((tripped.output.change as number) < -0.1);
      assert.ok(typeof (tripped.output.witness as { title?: string })?.title === "string");
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("a tripped watch with a concernTarget files a concern claim through the gate", () => {
    const { temp, store, admit } = setup();
    try {
      const verification = admit({
        content: { title: "Perf verified", body: "p95 fine.", summary: "Perf OK." }
      }, "2026-06-01T00:00:00.000Z");
      // The third cell: a decision that silently depends on the verification.
      const decision = admit({
        intent: { kind: "decision", operation: "create" },
        content: { title: "Ship Friday", body: "Based on perf verification.", summary: "Ship." }
      }, "2026-06-01T01:00:00.000Z");

      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Perf reflex",
        members: [{ nodeId: verification.id, role: "verification" }]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "watch",
        params: { delta: 0.1, concernTarget: decision.id }
      });

      store.runProgram(program.id); // baseline
      admit({
        content: { title: "Perf numbers were stale", body: "Wrong build measured.", summary: "Stale." },
        evidence: { contradicts: [verification.id] }
      }, "2026-06-02T00:00:00.000Z");

      const result = store.runProgramAndDerive(program.id);
      assert.equal(result.run.output.tripped, true);
      assert.equal(result.derived.length, 1);
      assert.equal(result.derived[0]!.accepted, true);

      // The reflex's claim lands as a concerns relation on the decision,
      // attributed to the program.
      const incoming = store
        .listRelations(decision.id, "in", 50)
        .filter((relation) => relation.kind === "concerns");
      assert.equal(incoming.length, 1);
      const filer = store.getNode(incoming[0]!.sourceId)!;
      assert.equal(filer.provenance?.produced_by, `program:${program.id}`);

      // And the decision's effective confidence now reflects the concern.
      const challenged = store.search("Ship Friday", 3)[0];
      assert.ok(challenged);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("compile surfaces standing programs on the cells they cover", () => {
    const { temp, store, admit } = setup();
    try {
      const decision = admit({
        intent: { kind: "decision", operation: "create" },
        content: {
          title: "Guarded rollout decision for the billing flank",
          body: "Rollout proceeds while the gate holds.",
          summary: "Guarded rollout."
        }
      }, "2026-06-01T00:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Billing rollout gate",
        members: [{ nodeId: decision.id, role: "claim" }]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "watch",
        params: { delta: 0.2 }
      });

      const packet = compileContext(store, { task: "billing rollout guarded", budgetWords: 400 });
      const formatted = formatContextPacket(packet);
      assert.match(formatted, /standing_programs:/);
      const line = packet.standingPrograms.find((entry) => entry.includes(program.id));
      assert.ok(line, "packet must surface the watch guarding the selected cell");
      assert.ok(line!.includes("watch(delta=0.2)"));
      assert.ok(line!.includes(`hyperedge:${edge.id}`), "line must carry the bundle handle for tying in new evidence");
      assert.ok(line!.includes(`${decision.kind}:${decision.id}`));
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });

  it("an untripped watch derives nothing — silence means stable", () => {
    const { temp, store, admit } = setup();
    try {
      const claim = admit({
        content: { title: "Steady claim", body: "Unchanging.", summary: "Steady." }
      }, "2026-06-01T00:00:00.000Z");
      const edge = store.addHyperedge({
        kind: "evidence-bundle",
        title: "Quiet gate",
        members: [{ nodeId: claim.id, role: "claim" }]
      });
      const program = store.attachProgram(edge.id, {
        schemaVersion: "recall.program.v1",
        operation: "watch",
        params: { delta: 0.1 }
      });
      store.runProgram(program.id); // baseline
      const result = store.runProgramAndDerive(program.id);
      assert.equal(result.run.output.tripped, false);
      assert.equal(result.derived.length, 0);
    } finally {
      store.close?.();
      temp.cleanup();
    }
  });
});
