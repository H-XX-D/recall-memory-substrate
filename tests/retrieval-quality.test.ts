import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { compileContext } from "../src/core/context-compiler.js";
import { fuseCandidates, TASK_CONTEXT_KIND_FACTOR } from "../src/core/retrieval.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { RecallNode } from "../src/core/types.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// Adversarial retrieval gate: each case models a way agent memory retrieval
// has failed (or could fail) in live use. A ranking change that breaks one of
// these reintroduces a known failure class, so they must stay green.
describe("retrieval quality gate", () => {
  it("weighs rare terms above corpus-ubiquitous terms (IDF)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Old cell about the substrate mechanism",
            body: "Discusses the kelvinwake phenomenon in detail alongside substrate notes.",
            summary: "Kelvinwake discussion."
          }
        }),
        store,
        { now: new Date("2026-01-05T00:00:00.000Z") }
      );

      for (let i = 0; i < 8; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Substrate audit note ${i}`,
              body: "Routine substrate bookkeeping entry with no special content.",
              summary: "Routine substrate note."
            }
          }),
          store,
          { now: new Date(`2026-03-0${1 + i}T00:00:00.000Z`) }
        );
      }

      // "substrate" appears in every cell; "kelvinwake" in exactly one older
      // cell's body. The rare term must dominate the ubiquitous one even
      // though the decoys carry "substrate" in their titles and are newer.
      const results = store.search("substrate kelvinwake", 5);

      assert.equal(results[0]?.title, "Old cell about the substrate mechanism");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("matches morphological variants via stemming", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Ranked compile decision records",
            body: "How compile output is ordered for the agent.",
            summary: "Ordering of compile output."
          }
        }),
        store,
        { now: new Date("2026-02-01T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Unrelated daemon scheduling note",
            body: "Background daemon cadence settings.",
            summary: "Daemon cadence."
          }
        }),
        store,
        { now: new Date("2026-02-02T00:00:00.000Z") }
      );

      // "ranking" must reach "Ranked", "decisions" must reach "decision".
      const results = store.search("ranking decisions", 2);

      assert.equal(results[0]?.title, "Ranked compile decision records");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("boosts well-connected cells over unconnected equals (graph prior)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const hub = admitWriteProposal(
        makeProposal({
          content: {
            title: "Flux capacitor calibration decision",
            body: "Calibration approach for the flux capacitor subsystem.",
            summary: "Calibration approach."
          }
        }),
        store,
        { now: new Date("2026-02-01T00:00:00.000Z") }
      );
      assert.ok(hub.node);

      admitWriteProposal(
        makeProposal({
          content: {
            title: "Flux capacitor calibration decision draft",
            body: "Calibration approach for the flux capacitor subsystem.",
            summary: "Calibration approach draft."
          }
        }),
        store,
        { now: new Date("2026-02-03T00:00:00.000Z") }
      );

      for (let i = 0; i < 5; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Witness run ${i} for calibration hub`,
              body: "Confirms the calibration approach held under load.",
              summary: "Calibration witness."
            },
            evidence: {
              depends_on: [hub.node.id]
            }
          }),
          store,
          { now: new Date(`2026-02-1${i}T00:00:00.000Z`) }
        );
      }

      // The hub and the draft match the query equally; five cells depend on
      // the hub. Trust accrued through the graph must outrank mild recency.
      const results = store.search("flux capacitor calibration decision", 3);

      assert.equal(results[0]?.id, hub.node.id);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("prefers newer cells when nothing else separates them (recency decay)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Quantizer sweep alpha",
            body: "Sweep notes for the quantizer experiment.",
            summary: "Quantizer sweep."
          }
        }),
        store,
        { now: new Date("2025-06-01T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Quantizer sweep beta",
            body: "Sweep notes for the quantizer experiment.",
            summary: "Quantizer sweep."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );

      const results = store.search("quantizer sweep", 2);

      assert.equal(results[0]?.title, "Quantizer sweep beta");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("does not let task-phrasing glue words surface unrelated stub cells", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      // Live failure (2026-06-09): compile for a taint refactor surfaced code-extract
      // stubs for variables literally named `to` — the ONLY query overlap was the
      // glue tokens "to"/"into" from natural task phrasing.
      admitWriteProposal(
        makeProposal({
          intent: { kind: "artifact", operation: "create" },
          content: {
            title: "variable: types.ts::to",
            body: "# variable: to\n\n**File:** types.ts (lines 49-49)",
            summary: "Code symbol stub."
          }
        }),
        store,
        { now: new Date("2026-06-08T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          intent: { kind: "decision", operation: "create" },
          content: {
            title: "Shared taint helpers extracted",
            body: "Extracted the shared helpers into taint_common for the bridge frontends.",
            summary: "Taint helper dedup."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );

      const results = store.search("extract shared helpers into taint_common to dedup", 10);
      assert.ok(
        results.every((node) => node.kind !== "artifact"),
        `glue-only match leaked a stub: ${results.map((node) => node.title).join(" | ")}`
      );
      assert.equal(results[0]?.title, "Shared taint helpers extracted");

      // ...but the stub must stay reachable when the query actually names it.
      const direct = store.search("variable types.ts", 5);
      assert.ok(direct.some((node) => node.title === "variable: types.ts::to"));
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("kindLexicalFactor demotes flagged kinds without zeroing them", () => {
    const now = new Date("2026-06-09T00:00:00.000Z");
    const node = (id: string, kind: string): RecallNode =>
      ({
        id,
        kind,
        title: id,
        body: "",
        summary: null,
        status: "active",
        updatedAt: "2026-06-08T00:00:00.000Z",
        data: {},
        tags: {}
      }) as unknown as RecallNode;
    const candidates = [
      { node: node("stub", "artifact"), bm25: -10, degree: 0 },
      { node: node("real", "decision"), bm25: -5, degree: 0 }
    ];

    // Control: without a factor the brevity-inflated stub owns the ceiling.
    assert.equal(fuseCandidates(candidates, 2, now)[0]?.id, "stub");
    // With the task-context profile the stub is demoted but NOT dropped.
    const demoted = fuseCandidates(candidates, 2, now, { kindLexicalFactor: TASK_CONTEXT_KIND_FACTOR });
    assert.deepEqual(demoted.map((entry) => entry.id), ["real", "stub"]);
  });

  it("compile keeps semantic cells above brevity-inflated artifact stubs", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      // Live failure (2026-06-09): 7 of 10 compile lines were `variable: ...::rank*`
      // stubs — tiny docs whose title hit saturates bm25 — above the decisions the
      // packet exists to surface. Stubs are NEWER (auto-admitted constantly).
      // Background corpus: makes the decision's matching terms (compile/quality)
      // corpus-COMMON so their IDF is low — in the live 1650-cell graph the
      // symbol token is rare and everything else is cheap; without this the
      // decision's multi-term coverage wins and the failure does not reproduce.
      for (let i = 0; i < 8; i += 1) {
        admitWriteProposal(
          makeProposal({
            content: {
              title: `Compile quality log ${i}`,
              body: "Routine note about compile quality improvements in the pipeline.",
              summary: "Routine compile note."
            }
          }),
          store,
          { now: new Date(`2026-05-1${i}T00:00:00.000Z`) }
        );
      }
      // Tags mirror the live code-extract shape: the symbol token recurs in
      // entities/subject/idea, so the tags column (fts weight 2.5) reinforces
      // the title hit three more times — that, plus brevity, owns the ceiling.
      for (let i = 0; i < 3; i += 1) {
        admitWriteProposal(
          makeProposal({
            intent: { kind: "artifact", operation: "create" },
            content: {
              title: `variable: file${i}.ts::ranking`,
              body: `# variable: ranking\n\n**File:** file${i}.ts (lines ${50 + i}-${50 + i})`,
              summary: "Code symbol stub."
            },
            tags: {
              topics: ["code", "typescript", "variable"],
              entities: ["lattice", "ts-sym:ranking"],
              type: ["artifact"],
              subject: [`variable-file${i}-ts-ranking`],
              idea: [`variable-file${i}-ts-ranking`]
            }
          }),
          store,
          { now: new Date(`2026-06-0${7 + i}T00:00:00.000Z`) }
        );
      }
      // Decision bodies are LONG in live use (~100+ words), so bm25 length
      // normalization penalizes them against 10-token stubs — that asymmetry IS
      // the failure being modeled; a short body here would dodge it.
      admitWriteProposal(
        makeProposal({
          intent: { kind: "decision", operation: "create" },
          content: {
            title: "Demote stub noise in task packets",
            body: [
              "Compile packets exist to carry decisions, verification results, and constraints",
              "into the next session. When auto-extracted symbol stubs share a token with the",
              "task, their tiny documents saturate the lexical ceiling and crowd the packet.",
              "The chosen design keeps compile ranking honest: semantic cells stay above stub",
              "cells unless the stub is the only material match. This mirrors the live failure",
              "where seven of ten packet lines were variable stubs while the decisions the",
              "packet exists to surface ranked below them. The correction is applied at the",
              "lexical term because additive priors cannot outvote a saturated ceiling, and",
              "plain search stays neutral so exact symbol lookup keeps its full strength."
            ].join(" "),
            summary: "Stub demotion decision."
          },
          confidence: { value: 0.9, uncertainty: 0.1, concern: 0.2, source_quality: "high", stability: "stable" }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );

      const packet = compileContext(store, { task: "improve compile ranking quality", budgetWords: 600 });
      const first = packet.relevantMemory[0] ?? "";
      assert.ok(
        first.includes("[decision:"),
        `expected the decision first in relevant_memory, got: ${first}`
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("keeps code symbols literal across the FTS path", () => {
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

      const results = store.search("py-sym:foo_bar", 5);

      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Underscore symbol cell");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  // F8 (2026-06-11 stress run): in a supersedure chain the challenged
  // predecessor outranked its successor, because incoming contradicts edges
  // RAISE graph degree. Effective confidence must sink challenged cells hard
  // enough that the successor wins even against the degree advantage.
  it("ranks a superseding decision above the predecessor it contradicts", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const v1 = admitWriteProposal(
        makeProposal({
          intent: { kind: "decision", operation: "create" },
          content: {
            title: "Pricing model uses three tiers monthly",
            body: "Pricing model v1: three tiers, monthly billing only.",
            summary: "Three tiers."
          }
        }),
        store,
        { now: new Date("2026-06-01T00:00:00.000Z") }
      );
      const v2 = admitWriteProposal(
        makeProposal({
          intent: { kind: "decision", operation: "create" },
          content: {
            title: "Pricing model uses two tiers with annual billing",
            body: "Pricing model v2: two tiers, annual billing added.",
            summary: "Two tiers annual."
          },
          evidence: { contradicts: [v1.node!.id] }
        }),
        store,
        { now: new Date("2026-06-05T00:00:00.000Z") }
      );
      admitWriteProposal(
        makeProposal({
          intent: { kind: "decision", operation: "create" },
          content: {
            title: "Pricing model raises starter price",
            body: "Pricing model v3: starter price raised, tiers unchanged.",
            summary: "Starter raised."
          },
          evidence: { contradicts: [v2.node!.id] }
        }),
        store,
        { now: new Date("2026-06-09T00:00:00.000Z") }
      );

      const results = store.search("pricing model", 3);
      const titles = results.map((node) => node.title);
      const v2Index = titles.indexOf("Pricing model uses two tiers with annual billing");
      const v3Index = titles.indexOf("Pricing model raises starter price");
      assert.notEqual(v3Index, -1, "successor must be retrieved");
      assert.ok(
        v2Index === -1 || v3Index < v2Index,
        `successor (rank ${v3Index}) must outrank its challenged predecessor (rank ${v2Index}); titles=${JSON.stringify(titles)}`
      );
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
