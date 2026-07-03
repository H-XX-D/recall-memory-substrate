import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { admit } from "./admission.js";
import { SqliteStore } from "./store.js";
import {
  analyzeMemory,
  memoryHealthToProposal,
  trustMultiplier,
} from "./analysis.js";
import type { Cell, Provenance } from "./types.js";

function provenance(partial: Partial<Provenance> = {}): Provenance {
  return {
    origin: "llm",
    producedBy: "actor",
    verification: "unverified",
    signatureStatus: "unsigned",
    ...partial,
  };
}

function putBelief(
  store: SqliteStore,
  key: string,
  overrides: Partial<Cell> = {},
): Cell {
  const cell = buildCell(
    { kind: "bel", title: `belief ${key}`, body: "b", confidence: 0.7 },
    { key },
  );
  Object.assign(cell, overrides);
  if (overrides.scores) cell.scores = { ...cell.scores, ...overrides.scores };
  if (overrides.provenance) cell.provenance = { ...cell.provenance, ...overrides.provenance };
  if (overrides.policy) cell.policy = { ...cell.policy, ...overrides.policy };
  store.put(cell);
  return cell;
}

function putSource(
  store: SqliteStore,
  key: string,
  target: string,
  relation: "supports" | "contradicts" | "concerns",
  overrides: Partial<Cell> = {},
): Cell {
  const weight = relation === "supports" ? 1 : relation === "contradicts" ? -1 : -0.5;
  const cell = buildCell(
    {
      kind: "obs",
      title: `source ${key}`,
      body: "b",
      confidence: 0.8,
      edges: [{ relation, target, weight }],
    },
    { key },
  );
  Object.assign(cell, overrides);
  if (overrides.scores) cell.scores = { ...cell.scores, ...overrides.scores };
  if (overrides.provenance) cell.provenance = { ...cell.provenance, ...overrides.provenance };
  store.put(cell);
  return cell;
}

// --- trustMultiplier ---

test("trustMultiplier: origin base values in ascending order external > human > daemon = program > llm > connector", () => {
  // verification "checked" (not "unverified") so no penalty masks the pure
  // origin ordering; external/human still clamp at the 1.0 ceiling, so the
  // ordering check below only distinguishes the pairs that do not collide there.
  const checked = { verification: "checked" as const };
  const external = trustMultiplier(provenance({ origin: "external", ...checked }));
  const human = trustMultiplier(provenance({ origin: "human", ...checked }));
  const daemon = trustMultiplier(provenance({ origin: "daemon", ...checked }));
  const program = trustMultiplier(provenance({ origin: "program", ...checked }));
  const llm = trustMultiplier(provenance({ origin: "llm", ...checked }));
  const connector = trustMultiplier(provenance({ origin: "connector", ...checked }));
  assert.equal(external, 1); // 1.2 clamped to 1
  assert.equal(human, 1); // 1.15 clamped to 1
  assert.ok(human >= daemon, `${human} >= ${daemon}`);
  assert.equal(daemon, program);
  assert.ok(daemon > llm, `${daemon} > ${llm}`);
  assert.ok(llm > connector, `${llm} > ${connector}`);
});

test("trustMultiplier: verified external source outweighs unverified llm", () => {
  const externalVerified = trustMultiplier(
    provenance({ origin: "external", signatureStatus: "verified", verification: "checked" }),
  );
  const llmUnverified = trustMultiplier(provenance({ origin: "llm", verification: "unverified" }));
  assert.ok(externalVerified > llmUnverified, `${externalVerified} > ${llmUnverified}`);
});

test("trustMultiplier: signed+verified adds 0.10, unverified subtracts 0.12, clamped to [0,1]", () => {
  const base = trustMultiplier(provenance({ origin: "daemon", verification: "checked" }));
  assert.equal(base, 1); // daemon 1.0, no bonus/penalty
  const daemonUnverified = trustMultiplier(provenance({ origin: "daemon", verification: "unverified" }));
  assert.ok(Math.abs(daemonUnverified - 0.88) < 1e-9, String(daemonUnverified));
  const connectorVerifiedButUnverifiedCheck = trustMultiplier(
    provenance({ origin: "connector", signatureStatus: "verified", verification: "checked" }),
  );
  assert.ok(Math.abs(connectorVerifiedButUnverifiedCheck - 0.9) < 1e-9, String(connectorVerifiedButUnverifiedCheck));
  // clamp: connector (0.8) - unverified (0.12) stays within [0,1]; never negative.
  const connectorUnverified = trustMultiplier(provenance({ origin: "connector", verification: "unverified" }));
  assert.ok(connectorUnverified >= 0);
  const externalVerified = trustMultiplier(
    provenance({ origin: "external", signatureStatus: "verified", verification: "checked" }),
  );
  assert.ok(externalVerified <= 1, String(externalVerified));
});

// --- BeliefPressure ---

test("analyzeMemory: a belief with two strong contradicting neighbors recommends downgrade and carries contradiction pressure", () => {
  const store = new SqliteStore(":memory:");
  try {
    const belief = putBelief(store, "b111", {
      scores: { conf: 0.6, uncertainty: 0.3, concern: 0.2, sourceQuality: 0.6, actorCalibration: 1, effective: 0.6, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
    });
    putSource(store, "s001", belief.key, "contradicts", {
      scores: { conf: 0.9, uncertainty: 0.1, concern: 0.1, sourceQuality: 0.9, actorCalibration: 1, effective: 0.95, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
      provenance: provenance({ origin: "human", producedBy: "actor-1", verification: "checked" }),
    });
    putSource(store, "s002", belief.key, "contradicts", {
      scores: { conf: 0.9, uncertainty: 0.1, concern: 0.1, sourceQuality: 0.9, actorCalibration: 1, effective: 0.95, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
      provenance: provenance({ origin: "external", producedBy: "actor-2", verification: "checked" }),
    });
    const report = analyzeMemory(store);
    const pressure = report.beliefs.find((b) => b.key === belief.key);
    assert.ok(pressure, "belief pressure entry missing");
    assert.equal(pressure!.recommendation, "downgrade");
    assert.ok(pressure!.contradiction >= 0.8, String(pressure!.contradiction));
    assert.equal(pressure!.evidenceCount, 2);
    assert.equal(pressure!.sourceDiversity, 1); // 2 distinct producedBy / 2 evidence
  } finally {
    store.close();
  }
});

test("analyzeMemory: a belief with no incoming evidential links has zero pressures, zero sourceDiversity, and recommends trust", () => {
  const store = new SqliteStore(":memory:");
  try {
    const belief = putBelief(store, "b222", {
      scores: { conf: 0.8, uncertainty: 0.1, concern: 0.05, sourceQuality: 0.8, actorCalibration: 1, effective: 0.8, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
    });
    const report = analyzeMemory(store);
    const pressure = report.beliefs.find((b) => b.key === belief.key);
    assert.ok(pressure);
    assert.equal(pressure!.evidenceCount, 0);
    assert.equal(pressure!.sourceDiversity, 0);
    assert.equal(pressure!.support, 0);
    assert.equal(pressure!.contradiction, 0);
    assert.equal(pressure!.concernPressure, 0);
    assert.equal(pressure!.recommendation, "trust");
  } finally {
    store.close();
  }
});

test("analyzeMemory: beliefs are sorted by planningPressure descending", () => {
  const store = new SqliteStore(":memory:");
  try {
    const low = putBelief(store, "b300", {
      scores: { conf: 0.9, uncertainty: 0.05, concern: 0.02, sourceQuality: 0.9, actorCalibration: 1, effective: 0.9, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
    });
    const high = putBelief(store, "b301", {
      scores: { conf: 0.4, uncertainty: 0.8, concern: 0.8, sourceQuality: 0.4, actorCalibration: 1, effective: 0.4, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
    });
    putSource(store, "s300", high.key, "contradicts", {
      scores: { conf: 0.9, uncertainty: 0.1, concern: 0.1, sourceQuality: 0.9, actorCalibration: 1, effective: 0.9, currencyC0: 1, currency: 1, salienceSeed: 0.5, salience: 0.5 },
    });
    const report = analyzeMemory(store);
    const idxLow = report.beliefs.findIndex((b) => b.key === low.key);
    const idxHigh = report.beliefs.findIndex((b) => b.key === high.key);
    assert.ok(idxHigh < idxLow, `expected ${high.key} pressure before ${low.key}`);
  } finally {
    store.close();
  }
});

test("analyzeMemory: inactive (superseded) neighbor cells are excluded from belief pressure", () => {
  const store = new SqliteStore(":memory:");
  try {
    const belief = putBelief(store, "b400", {});
    const superseded = putSource(store, "s400", belief.key, "contradicts", {
      status: "superseded",
    });
    void superseded;
    const report = analyzeMemory(store);
    const pressure = report.beliefs.find((b) => b.key === belief.key);
    assert.ok(pressure);
    assert.equal(pressure!.evidenceCount, 0);
  } finally {
    store.close();
  }
});

// --- StaleFinding ---

test("analyzeMemory: an expired cell (policy.expiresAt in the past) is stale with severity 1", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "expired obs", body: "b", confidence: 0.7, expiresAt: "2026-01-01T00:00:00.000Z" },
      { key: "e001", now: "2026-01-01T00:00:00.000Z" },
    );
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.ok(finding, "expected stale finding for expired cell");
    assert.equal(finding!.severity, 1);
  } finally {
    store.close();
  }
});

test("analyzeMemory: a cell past its reverifyAfter clock (not expired) is stale with severity 0.85", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "reverify due", body: "b", confidence: 0.7, reverifyAfter: "2026-06-01T00:00:00.000Z" },
      { key: "e002", now: "2026-01-01T00:00:00.000Z" },
    );
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.ok(finding, "expected stale finding for reverify-elapsed cell");
    assert.equal(finding!.severity, 0.85);
  } finally {
    store.close();
  }
});

test("analyzeMemory: an ephemeral cell older than 1 day (updatedAt) is stale with severity 0.7", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "old ephemeral", body: "b", confidence: 0.7, stability: "ephemeral" },
      { key: "e003", now: "2026-07-01T00:00:00.000Z" }, // 2 days old
    );
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.ok(finding, "expected stale finding for old ephemeral cell");
    assert.equal(finding!.severity, 0.7);
  } finally {
    store.close();
  }
});

test("analyzeMemory: a volatile cell older than 14 days (updatedAt) is stale with severity 0.55", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "old volatile", body: "b", confidence: 0.7, stability: "volatile" },
      { key: "e004", now: "2026-06-01T00:00:00.000Z" }, // > 14 days old
    );
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.ok(finding, "expected stale finding for old volatile cell");
    assert.equal(finding!.severity, 0.55);
  } finally {
    store.close();
  }
});

test("analyzeMemory: unverified low-sourceQuality cell is stale with severity 0.45", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "low quality unverified", body: "b", confidence: 0.2, stability: "stable" },
      { key: "e005", now: "2026-07-02T23:00:00.000Z" },
    );
    cell.scores.sourceQuality = 0.2;
    cell.provenance.verification = "unverified";
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.ok(finding, "expected stale finding for unverified low-quality cell");
    assert.equal(finding!.severity, 0.45);
  } finally {
    store.close();
  }
});

test("analyzeMemory: a fresh stable cell with no stale triggers produces no stale finding", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const cell = buildCell(
      { kind: "obs", title: "fresh cell", body: "b", confidence: 0.9, stability: "stable", verification: "checked" },
      { key: "e006", now: "2026-07-02T23:00:00.000Z" },
    );
    cell.scores.sourceQuality = 0.9;
    store.put(cell);
    const report = analyzeMemory(store, now);
    const finding = report.stale.find((s) => s.key === cell.key);
    assert.equal(finding, undefined);
  } finally {
    store.close();
  }
});

test("analyzeMemory: stale findings are sorted by severity descending", () => {
  const store = new SqliteStore(":memory:");
  try {
    const now = new Date("2026-07-03T00:00:00.000Z");
    const volatile = buildCell(
      { kind: "obs", title: "volatile", body: "b", confidence: 0.7, stability: "volatile" },
      { key: "e010", now: "2026-06-01T00:00:00.000Z" },
    );
    const expired = buildCell(
      { kind: "obs", title: "expired", body: "b", confidence: 0.7, expiresAt: "2026-01-01T00:00:00.000Z" },
      { key: "e011", now: "2026-01-01T00:00:00.000Z" },
    );
    store.put(volatile);
    store.put(expired);
    const report = analyzeMemory(store, now);
    assert.equal(report.stale[0]!.key, expired.key);
  } finally {
    store.close();
  }
});

// --- ContradictionFinding ---

test("analyzeMemory: a contradicts edge between two active cells produces a contradiction finding", () => {
  const store = new SqliteStore(":memory:");
  try {
    const target = buildCell({ kind: "bel", title: "target belief", body: "b", confidence: 0.7 }, { key: "c001" });
    store.put(target);
    const source = buildCell(
      {
        kind: "obs",
        title: "contradicting source",
        body: "b",
        confidence: 0.8,
        concern: 0.6,
        edges: [{ relation: "contradicts", target: target.key, weight: -1 }],
      },
      { key: "c002" },
    );
    store.put(source);
    const report = analyzeMemory(store);
    const finding = report.contradictions.find((c) => c.sourceKey === source.key && c.targetKey === target.key);
    assert.ok(finding, "expected contradiction finding");
    assert.equal(finding!.relation, "contradicts");
  } finally {
    store.close();
  }
});

test("analyzeMemory: a contradicts/concerns edge to an inactive target is not reported", () => {
  const store = new SqliteStore(":memory:");
  try {
    const target = buildCell({ kind: "bel", title: "gone belief", body: "b", confidence: 0.7 }, { key: "c010" });
    target.status = "superseded";
    store.put(target);
    const source = buildCell(
      {
        kind: "obs",
        title: "dangling contradiction",
        body: "b",
        confidence: 0.8,
        edges: [{ relation: "contradicts", target: target.key, weight: -1 }],
      },
      { key: "c011" },
    );
    store.put(source);
    const report = analyzeMemory(store);
    const finding = report.contradictions.find((c) => c.sourceKey === source.key);
    assert.equal(finding, undefined);
  } finally {
    store.close();
  }
});

// --- DanglingEdgeReport ---

test("analyzeMemory: an edge whose target resolves to no cell lands in the dangling report", () => {
  const store = new SqliteStore(":memory:");
  try {
    const source = buildCell(
      {
        kind: "obs",
        title: "dangling source",
        body: "b",
        confidence: 0.8,
        edges: [{ relation: "concerns", target: "does-not-exist", weight: -0.5 }],
      },
      { key: "d001" },
    );
    store.put(source);
    const report = analyzeMemory(store);
    assert.equal(report.dangling.total, 1);
    assert.equal(report.dangling.byRelation.concerns, 1);
    assert.equal(report.dangling.worst.length, 1);
    assert.equal(report.dangling.worst[0]!.source, source.key);
    assert.equal(report.dangling.worst[0]!.target, "does-not-exist");
  } finally {
    store.close();
  }
});

test("analyzeMemory: dangling worst list is capped at 10", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (let i = 0; i < 15; i++) {
      const source = buildCell(
        {
          kind: "obs",
          title: `dangling source ${i}`,
          body: "b",
          confidence: 0.8,
          edges: [{ relation: "concerns", target: `missing-${i}`, weight: -0.5 }],
        },
        { key: `d${100 + i}` },
      );
      store.put(source);
    }
    const report = analyzeMemory(store);
    assert.equal(report.dangling.total, 15);
    assert.equal(report.dangling.worst.length, 10);
  } finally {
    store.close();
  }
});

// --- ProvenanceHealth ---

test("analyzeMemory: a single-producer store yields concentrationRisk >= 0.8", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (let i = 0; i < 12; i++) {
      const cell = buildCell(
        { kind: "obs", title: `single producer ${i}`, body: "b", confidence: 0.6, owner: "solo-actor" },
        { key: `p${200 + i}` },
      );
      store.put(cell);
    }
    const report = analyzeMemory(store);
    assert.ok(report.provenance.concentrationRisk >= 0.8, String(report.provenance.concentrationRisk));
    assert.equal(report.provenance.totalCells, 12);
  } finally {
    store.close();
  }
});

test("analyzeMemory: provenance.signedVerifiedRatio reflects verified+signed cell share", () => {
  const store = new SqliteStore(":memory:");
  try {
    const verified = buildCell(
      { kind: "obs", title: "verified cell", body: "b", confidence: 0.8, verification: "checked" },
      { key: "p300" },
    );
    verified.provenance.signatureStatus = "verified";
    store.put(verified);
    const unverified = buildCell(
      { kind: "obs", title: "unverified cell", body: "b", confidence: 0.8 },
      { key: "p301" },
    );
    store.put(unverified);
    const report = analyzeMemory(store);
    assert.equal(report.provenance.signedVerifiedCount, 1);
    assert.ok(Math.abs(report.provenance.signedVerifiedRatio - 0.5) < 1e-9);
  } finally {
    store.close();
  }
});

// --- CriticalWarning ---

test("analyzeMemory: low-signed coverage under 10 percent emits an info warning", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (let i = 0; i < 5; i++) {
      const cell = buildCell({ kind: "obs", title: `unsigned ${i}`, body: "b", confidence: 0.6 }, { key: `w${400 + i}` });
      store.put(cell);
    }
    const report = analyzeMemory(store);
    const warning = report.criticalWarnings.find((w) => w.code === "low-signed-coverage");
    assert.ok(warning);
    assert.equal(warning!.severity, "info");
  } finally {
    store.close();
  }
});

// --- nextActions ---

test("analyzeMemory: an empty store produces a single no-pressure nextActions line", () => {
  const store = new SqliteStore(":memory:");
  try {
    const report = analyzeMemory(store);
    assert.equal(report.nextActions.length, 1);
    assert.equal(report.beliefs.length, 0);
    assert.equal(report.stale.length, 0);
    assert.equal(report.contradictions.length, 0);
  } finally {
    store.close();
  }
});

test("analyzeMemory: nextActions names dangling edge pruning when dangling edges exist", () => {
  const store = new SqliteStore(":memory:");
  try {
    const source = buildCell(
      {
        kind: "obs",
        title: "dangling source for actions",
        body: "b",
        confidence: 0.8,
        edges: [{ relation: "concerns", target: "does-not-exist-either", weight: -0.5 }],
      },
      { key: "d500" },
    );
    store.put(source);
    const report = analyzeMemory(store);
    assert.ok(report.nextActions.some((line) => /prune/i.test(line) && /1/.test(line)));
  } finally {
    store.close();
  }
});

// --- memoryHealthToProposal ---

test("memoryHealthToProposal: builds an obs proposal with counts in the title and concerns edges to stale/contradiction targets", () => {
  const store = new SqliteStore(":memory:");
  try {
    const target = buildCell({ kind: "bel", title: "target belief for proposal", body: "b", confidence: 0.7 }, { key: "m001" });
    store.put(target);
    const contradictor = buildCell(
      {
        kind: "obs",
        title: "contradictor for proposal",
        body: "b",
        confidence: 0.8,
        concern: 0.6,
        edges: [{ relation: "contradicts", target: target.key, weight: -1 }],
      },
      { key: "m002" },
    );
    store.put(contradictor);
    const stale = buildCell(
      { kind: "obs", title: "stale for proposal", body: "b", confidence: 0.7, expiresAt: "2026-01-01T00:00:00.000Z" },
      { key: "m003", now: "2026-01-01T00:00:00.000Z" },
    );
    store.put(stale);

    const report = analyzeMemory(store, new Date("2026-07-03T00:00:00.000Z"));
    const proposal = memoryHealthToProposal(report, { project: "demo", tenant: "demo-tenant" });

    assert.equal(proposal.kind, "obs");
    assert.match(proposal.title, /Memory health: \d+\/\d+\/\d+ \(pressured\/stale\/conflicts\)/);
    assert.equal(proposal.confidence, 0.78);
    assert.equal(proposal.owner, "recall-maintenance");
    assert.equal(proposal.origin, "daemon");
    assert.equal(proposal.verification, "checked");
    assert.deepEqual(proposal.topics, ["maintenance", "memory-health"]);
    assert.equal(proposal.stability, "volatile");
    assert.equal(proposal.project, "demo");
    assert.equal(proposal.tenant, "demo-tenant");
    assert.ok(Array.isArray(proposal.edges));
    assert.ok(proposal.edges!.length <= 8);
    assert.ok(proposal.edges!.every((e) => e.relation === "concerns"));
    assert.ok(typeof proposal.body === "string" && proposal.body.length > 0);
  } finally {
    store.close();
  }
});

test("memoryHealthToProposal proposal admits cleanly through the admission gate with concerns edges", () => {
  const store = new SqliteStore(":memory:");
  try {
    const target = buildCell({ kind: "bel", title: "belief to concern", body: "b", confidence: 0.7 }, { key: "m100" });
    store.put(target);
    const contradictor = buildCell(
      {
        kind: "obs",
        title: "contradictor",
        body: "b",
        confidence: 0.8,
        edges: [{ relation: "contradicts", target: target.key, weight: -1 }],
      },
      { key: "m101" },
    );
    store.put(contradictor);

    const report = analyzeMemory(store);
    const proposal = memoryHealthToProposal(report);
    const result = admit(proposal, { store, now: new Date().toISOString() });
    assert.equal(result.accepted, true, JSON.stringify(result.issues));
    assert.equal(result.cell?.provenance.origin, "daemon");
  } finally {
    store.close();
  }
});
