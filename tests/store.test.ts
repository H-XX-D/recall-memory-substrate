import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { compileContext, formatContextPacket } from "../src/core/context-compiler.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("sqlite store and compiler", () => {
  it("runs databases in WAL journal mode", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      store.close();
      const raw = new DatabaseSync(temp.path);
      const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      raw.close();
      assert.equal(mode.journal_mode, "wal");
    } finally {
      temp.cleanup();
    }
  });

  it("searches admitted graph nodes", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const results = store.search("structured memory");

      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Recall schema initialized");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("ranks cells matching more query terms above newer single-term matches", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Compile ranking decision for lexical search",
            body: "The context compiler should rank cells by query term coverage.",
            summary: "Compiler ranking decision."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );

      for (let i = 0; i < 3; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Physics route audit ${i}`,
              body: "Audit notes referencing recall://cell/some-other-cell for evidence.",
              summary: "Physics audit notes."
            }
          }),
          store,
          { now: new Date(`2026-06-0${2 + i}T00:00:00.000Z`) }
        );
      }

      const results = store.search("recall compile ranking decision", 4);

      assert.equal(results[0]?.title, "Compile ranking decision for lexical search");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("matches LIKE metacharacters in search terms literally", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Underscore symbol cell",
            body: "Defines py-sym:foo_bar for the indexer.",
            summary: "Underscore symbol."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Wildcard decoy cell",
            body: "Defines py-sym:fooXbar for the indexer.",
            summary: "Decoy symbol."
          }
        }),
        store,
        { now: new Date("2026-06-02T00:00:00.000Z") }
      );

      const results = store.search("py-sym:foo_bar");

      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Underscore symbol cell");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("matches LIKE metacharacters in subgraph tag filters literally", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Underscore project cell",
            body: "Cell tagged with the ring_zero project.",
            summary: "Underscore project tag."
          },
          tags: { project: ["ring_zero"] }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Wildcard decoy project cell",
            body: "Cell tagged with the ringXzero decoy project.",
            summary: "Decoy project tag."
          },
          tags: { project: ["ringXzero"] }
        }),
        store,
        { now: new Date("2026-06-02T00:00:00.000Z") }
      );

      const results = store.subgraph({ project: ["ring_zero"] });

      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Underscore project cell");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("compiles relevant memory ahead of newer unrelated cells", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Compile ranking decision for lexical search",
            body: "The context compiler should rank cells by query term coverage.",
            summary: "Compiler ranking decision."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );

      for (let i = 0; i < 3; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Physics route audit ${i}`,
              body: "Audit notes referencing recall://cell/some-other-cell for evidence.",
              summary: "Physics audit notes."
            }
          }),
          store,
          { now: new Date(`2026-06-0${2 + i}T00:00:00.000Z`) }
        );
      }

      const packet = compileContext(store, {
        task: "recall compile ranking decision",
        budgetWords: 300
      });

      assert.match(packet.relevantMemory[0] ?? "", /Compile ranking decision for lexical search/);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("compresses long titles and caps reference fan-out in packets", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const targetIds: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const target = admitWriteProposal(
          makeProposal({
            content: {
              title: `Reference target ${i}`,
              body: `Body for reference target ${i}.`,
              summary: `Reference target ${i}.`
            }
          }),
          store
        );
        assert.ok(target.node);
        targetIds.push(target.node.id);
      }

      const longTitle = `Compression probe ${Array.from({ length: 38 }, (_, i) => `filler${i}`).join(" ")}`;
      admitWriteProposal(
        makeProposal({
          content: {
            title: longTitle,
            body: "A cell with an oversized title and many references.",
            summary: "Oversized title probe."
          },
          evidence: {
            supports: targetIds
          }
        }),
        store
      );

      const packet = compileContext(store, {
        task: "compression probe oversized title",
        budgetWords: 2000
      });

      // Long titles must not be echoed in full anywhere in the packet.
      for (const line of [...packet.relevantMemory, ...packet.cellState, ...packet.translatedReferences]) {
        assert.equal(line.includes(longTitle), false, `full title leaked into: ${line.slice(0, 80)}`);
      }

      // A dense cell may not flood the packet: 6 reference lines + 1 overflow marker.
      const probeReferences = packet.translatedReferences.filter((line) => line.includes("Compression probe"));
      assert.equal(probeReferences.length, 7);
      assert.match(probeReferences[6] ?? "", /2 more reference/);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("resolves address-form evidence references to node ids in relations", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(
        makeProposal({
          content: {
            title: "Address reference target cell",
            body: "Cell referenced by full recall address.",
            summary: "Address target."
          }
        }),
        store
      );
      assert.ok(target.node);

      admitWriteProposal(
        makeProposal({
          content: {
            title: "Challenger referencing by address",
            body: "Contradicts the target using its recall:// address form.",
            summary: "Address-form challenger."
          },
          evidence: { contradicts: [target.node.cellAddress] }
        }),
        store
      );

      // Short form recall://cell/<id> is what the write helper emits.
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Challenger referencing by short address",
            body: "Concerns the target using the short recall cell uri form.",
            summary: "Short-form challenger."
          },
          evidence: { concerns: [`recall://cell/${target.node.id}`] }
        }),
        store
      );

      const incoming = store.listRelations(target.node.id, "in", 10);
      assert.ok(
        incoming.some((relation) => relation.kind === "contradicts"),
        `expected incoming contradicts on node id, got: ${JSON.stringify(incoming.map((r) => [r.kind, r.targetId]))}`
      );
      assert.ok(
        incoming.some((relation) => relation.kind === "concerns"),
        `expected incoming concerns from short-form reference, got: ${JSON.stringify(incoming.map((r) => [r.kind, r.targetId]))}`
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("migrates legacy address-form relation targets to node ids", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    let raw: DatabaseSync | null = null;
    try {
      const target = admitWriteProposal(makeProposal(), store);
      assert.ok(target.node);
      const targetId = target.node.id;
      store.close();

      // Plant a legacy relation row the way older binaries wrote them.
      raw = new DatabaseSync(temp.path);
      raw
        .prepare(
          "INSERT INTO graph_relations (id, kind, source_id, target_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("legacy-rel-1", "contradicts", "some-source-id", `recall://cell/${targetId}`, "{}", "2026-06-01T00:00:00.000Z");
      raw.close();
      raw = null;

      const reopened = new SQLiteRecallStore(temp.path);
      try {
        const incoming = reopened.listRelations(targetId, "in", 10);
        assert.ok(
          incoming.some((relation) => relation.kind === "contradicts" && relation.targetId === targetId),
          `expected migrated relation target, got: ${JSON.stringify(incoming.map((r) => [r.kind, r.targetId]))}`
        );
      } finally {
        reopened.close();
      }
    } finally {
      raw?.close();
      temp.cleanup();
    }
  });

  it("surfaces incoming challenges against selected cells in the packet", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const trusted = admitWriteProposal(
        makeProposal({
          content: {
            title: "Hyperdrive coil winding decision",
            body: "Wind the hyperdrive coil clockwise at fourteen turns.",
            summary: "Coil winding decision."
          }
        }),
        store,
        { now: new Date("2026-05-01T00:00:00.000Z") }
      );
      assert.ok(trusted.node);

      admitWriteProposal(
        makeProposal({
          content: {
            title: "Refutation witness: winding burnout reproduced",
            body: "Fourteen clockwise turns burned out under sustained load twice.",
            summary: "Burnout reproduction."
          },
          evidence: { contradicts: [trusted.node.id] }
        }),
        store,
        { now: new Date("2026-05-02T00:00:00.000Z") }
      );

      const packet = compileContext(store, {
        task: "hyperdrive coil winding decision",
        budgetWords: 400
      });

      // Reading the trusted cell must automatically surface its challenger,
      // with an expansion handle to pull the full refutation.
      const challengeLine = packet.conflicts.find((line) => /Refutation witness/.test(line) && /contradicts/.test(line));
      assert.ok(challengeLine, `expected challenge line in conflicts, got: ${JSON.stringify(packet.conflicts)}`);
      assert.ok(packet.expansionHandles.length > 0);
      assert.equal(
        packet.conflicts.filter((line) => /Refutation witness/.test(line) && /contradicts/.test(line)).length,
        1,
        "challenge must not be duplicated by the global health overlay"
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("surfaces checker-contradicts hyperedges as challenges in the packet", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const trusted = admitWriteProposal(
        makeProposal({
          content: {
            title: "Hyperdrive coil winding decision",
            body: "Wind the hyperdrive coil clockwise at fourteen turns.",
            summary: "Coil winding decision."
          }
        }),
        store,
        { now: new Date("2026-05-01T00:00:00.000Z") }
      );
      assert.ok(trusted.node);

      store.addHyperedge({
        kind: "checker-contradicts",
        title: "checker refuted: winding suite passes",
        members: [{ nodeId: trusted.node.id, role: "subject", ordinal: 0 }],
        metadata: { checker_run: "checker://run/7", verdict: "refuted" }
      });

      const packet = compileContext(store, {
        task: "hyperdrive coil winding decision",
        budgetWords: 400
      });

      // A truth-layer refutation must reach the agent exactly like a
      // relation-based challenge, carrying its external evidence pointer.
      const challengeLine = packet.conflicts.find(
        (line) => /checker refuted/.test(line) && /checker-contradicts/.test(line)
      );
      assert.ok(challengeLine, `expected hyperedge challenge in conflicts, got: ${JSON.stringify(packet.conflicts)}`);
      assert.ok(challengeLine.includes("checker://run/7"), "challenge should carry the checker evidence pointer");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("caps surfaced challenges per cell with an overflow marker", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const trusted = admitWriteProposal(
        makeProposal({
          content: {
            title: "Hyperdrive coil winding decision",
            body: "Wind the hyperdrive coil clockwise at fourteen turns.",
            summary: "Coil winding decision."
          }
        }),
        store,
        { now: new Date("2026-05-01T00:00:00.000Z") }
      );
      assert.ok(trusted.node);

      for (let i = 0; i < 8; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Distinct challenge record number ${i} against winding`,
              body: `Independent failure mode ${i} observed in bench rig ${i}.`,
              summary: `Failure mode ${i}.`
            },
            evidence: { contradicts: [trusted.node.id] }
          }),
          store,
          { now: new Date(`2026-05-0${3 + (i % 6)}T0${i}:00:00.000Z`) }
        );
      }

      const packet = compileContext(store, {
        task: "hyperdrive coil winding decision",
        budgetWords: 2000,
        includeConflicts: false
      });

      const challengeLines = packet.conflicts.filter((line) => /winding/i.test(line));
      const overflow = packet.conflicts.find((line) => /more challenges/.test(line));
      assert.ok(overflow, `expected overflow marker, got: ${JSON.stringify(packet.conflicts)}`);
      assert.equal(challengeLines.filter((line) => /contradicts/.test(line)).length, 6);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("compiles a compact context packet with expansion handles", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const packet = compileContext(store, {
        task: "Recall schema memory",
        budgetWords: 120
      });
      const formatted = formatContextPacket(packet);

      assert.equal(packet.expansionHandles.length, 1);
      assert.equal(packet.expansionHandles[0]?.includes("recall://cell/"), false);
      assert.match(formatted, /objective:/);
      assert.match(formatted, /expansion_handles:/);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("translates field references into LLM-readable compiler output", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const target = admitWriteProposal(
        makeProposal({
          content: {
            title: "Compiler reference target",
            body: "This longer body should not be repeated when only the summary is referenced.",
            summary: "Only this summary returns to the LLM."
          }
        }),
        store
      );
      assert.ok(target.node);

      admitWriteProposal(
        makeProposal({
          content: {
            title: "Compiler field reference witness",
            body: "Compiler reference translation should resolve a compact field path.",
            summary: "Compiler translates a compact field reference."
          },
          evidence: {
            supports: [`${target.node.cellAddress}#content.summary`]
          }
        }),
        store
      );

      const packet = compileContext(store, {
        task: "compiler reference translation",
        budgetWords: 220
      });
      const formatted = formatContextPacket(packet);

      assert.equal(packet.translatedReferences.length, 1);
      assert.match(packet.translatedReferences[0] ?? "", /content\.summary/);
      assert.match(packet.translatedReferences[0] ?? "", /handle=.*#content\.summary/);
      assert.match(formatted, /translated_references:/);

      const inlinePacket = compileContext(store, {
        task: "compiler reference translation",
        budgetWords: 220,
        inlineReferenceValues: true,
        includeReferenceParameters: true
      });
      assert.match(inlinePacket.translatedReferences[0] ?? "", /Only this summary returns to the LLM/);
      assert.match(inlinePacket.referenceParameters[0] ?? "", /value_kind=string/);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
