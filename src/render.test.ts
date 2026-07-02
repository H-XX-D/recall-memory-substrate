import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMiniIndexLine, renderCell } from "./render.js";
import type { Cell, Edge } from "./types.js";

function makeCell(over: Partial<Cell> = {}): Cell {
  const base: Cell = {
    key: "k1",
    handle: "dec_a3ee",
    kind: "dec",
    owner: "alice",
    title: "ship v5",
    body: "the body",
    scope: { project: "p", tenant: "t" },
    scores: {
      conf: 0.7,
      uncertainty: 0.2,
      concern: 0.1,
      sourceQuality: 0.8,
      actorCalibration: 1,
      effective: 0.42,
      currencyC0: 1,
      currency: 0.91,
      salienceSeed: 0.5,
      salience: 0.5,
    },
    stability: "stable",
    flags: {
      annexed: false,
      locked: false,
      pinned: false,
      requiresReview: false,
      allowBackgroundUse: true,
    },
    edgesOut: [],
    sourceRefs: [],
    lineage: [],
    programs: [],
    provenance: {
      origin: "llm",
      producedBy: "alice",
      verification: "unverified",
      signatureStatus: "unsigned",
    },
    tags: { topics: [], entities: [] },
    policy: { sensitivity: "private", expiresAt: null, reverifyAfter: null },
    props: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
  };
  return { ...base, ...over };
}

test("renderMiniIndexLine emits handle, title, conf(!), eff, curr and out count", () => {
  const cell = makeCell();
  assert.equal(
    renderMiniIndexLine(cell),
    'dec_a3ee "ship v5" conf(0.7!) eff(0.42) curr(0.91) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:0 programs:0]',
  );
});

test("renderMiniIndexLine prepends ^ when opts.expand is set and counts edges", () => {
  const edges: Edge[] = [
    { relation: "supports", source: "k1", target: "obs_01", weight: 1 },
    { relation: "contradicts", source: "k1", target: "bel_02", weight: -1 },
  ];
  const cell = makeCell({ edgesOut: edges });
  assert.equal(
    renderMiniIndexLine(cell, { expand: true }),
    '^dec_a3ee "ship v5" conf(0.7!) eff(0.42) curr(0.91) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:2 programs:0]',
  );
});

test("renderMiniIndexLine emits active flags and program count", () => {
  const cell = makeCell({
    programs: ["watchdog"],
    flags: {
      annexed: false,
      locked: true,
      pinned: true,
      requiresReview: true,
      allowBackgroundUse: false,
    },
  });
  assert.equal(
    renderMiniIndexLine(cell),
    'dec_a3ee "ship v5" conf(0.7!) eff(0.42) curr(0.91) sal(0.5) annexed(0) locked(1) pinned(1) review(1) bg(0) [out:0 programs:1]',
  );
});

test("renderCell appends one line per edge after the mini-index line", () => {
  const edges: Edge[] = [
    { relation: "supports", source: "k1", target: "obs_01", weight: 1 },
    { relation: "concerns", source: "k1", target: "rsk_07", weight: -0.5 },
  ];
  const cell = makeCell({ edgesOut: edges });
  assert.equal(
    renderCell(cell),
    [
      'dec_a3ee "ship v5" conf(0.7!) eff(0.42) curr(0.91) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:2 programs:0]',
      "supports> obs_01(1)",
      "concerns> rsk_07(-0.5)",
    ].join("\n"),
  );
});

test("renderCell of an edgeless cell is just the mini-index line", () => {
  const cell = makeCell();
  assert.equal(
    renderCell(cell),
    'dec_a3ee "ship v5" conf(0.7!) eff(0.42) curr(0.91) sal(0.5) annexed(0) locked(0) pinned(0) review(0) bg(1) [out:0 programs:0]',
  );
});
