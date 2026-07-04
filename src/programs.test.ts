import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { runProgramCell, validateProgramSpec, executeProgram } from "./programs.js";
import { SqliteStore } from "./store.js";
import type { Cell, Store } from "./types.js";

test("validateProgramSpec accepts the v1 program operations and rejects bad specs", () => {
  const spec = validateProgramSpec({
    schemaVersion: "recall.program.v1",
    operation: "score",
    target: { keys: ["aaaa"], limit: 5 },
  });
  assert.equal(spec.operation, "score");
  assert.equal(spec.target?.limit, 5);
  assert.throws(() => validateProgramSpec({ schemaVersion: "wrong", operation: "score" }), /schemaVersion/);
  assert.throws(() => validateProgramSpec({ schemaVersion: "recall.program.v1", operation: "exec" }), /operation/);
});

test("runProgramCell scores selected members and persists run history on the prg cell", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8, topics: ["gate"] },
      { key: "aaaaaaaa-0000-0000-0000-000000000000" },
    );
    const b = buildCell(
      { kind: "obs", title: "B", body: "b", confidence: 0.6, topics: ["gate"] },
      { key: "bbbbbbbb-0000-0000-0000-000000000000" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate score",
        body: "score gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            target: { keys: [a.key, b.key] },
          },
        },
      },
      { key: "cccccccc-0000-0000-0000-000000000000" },
    );
    store.put(a);
    store.put(b);
    store.put(program);

    const result = runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z");
    assert.equal(result.run.operation, "score");
    assert.equal(result.run.output.memberCount, 2);
    assert.equal(result.run.output.averageEffective, 0.7);
    assert.equal(store.get(program.key)?.props.runCount, 1);
    assert.equal((store.get(program.key)?.props.lastRun as { id: string }).id, result.run.id);
    assert.deepEqual(store.get(a.key)?.programs, [program.key]);
  } finally {
    store.close();
  }
});

test("watch programs use lastRun as baseline and derive witnesses only after a trip", () => {
  const store = new SqliteStore(":memory:");
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-1111-1111-1111-111111111111" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate watch",
        body: "watch gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "watch",
            target: { keys: [watched.key] },
            params: { delta: 0.1, concernTarget: watched.key },
          },
        },
      },
      { key: "cccccccc-1111-1111-1111-111111111111" },
    );
    store.put(watched);
    store.put(program);

    const baseline = runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z", { derive: true });
    assert.equal(baseline.run.output.tripped, false);
    assert.equal(baseline.derived, undefined);

    store.put({ ...watched, scores: { ...watched.scores, effective: 0.4 } });
    const tripped = runProgramCell(store, program.key, "2026-06-26T12:01:00.000Z", { derive: true });
    assert.equal(tripped.run.output.tripped, true);
    assert.equal(tripped.derived?.accepted, true);
    assert.equal(tripped.derived?.cell?.owner, `program:${program.handle}`);
    assert.equal(tripped.derived?.cell?.edgesOut.some((edge) => edge.relation === "concerns" && edge.target === watched.key), true);
  } finally {
    store.close();
  }
});

test("re-tripping a watch program on the same before/after swing derives one cell, not two (deriveAdmit short-circuit)", () => {
  const store = new SqliteStore(":memory:");
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-2222-2222-2222-222222222222" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate watch repeat",
        body: "watch gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "watch",
            target: { keys: [watched.key] },
            params: { delta: 0.1, concernTarget: watched.key },
          },
        },
      },
      { key: "cccccccc-2222-2222-2222-222222222222" },
    );
    store.put(watched);
    store.put(program);

    runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z", { derive: true }); // baseline (0.9), no trip

    // The value oscillates 0.9 <-> 0.4 across three runs: run 2 (0.9 -> 0.4)
    // and run 4 (0.9 -> 0.4) trip on the exact same previous/current/change,
    // reproducing an identical witness output even though run.id and
    // run.createdAt differ each time.
    store.put({ ...watched, scores: { ...watched.scores, effective: 0.4 } });
    const run2 = runProgramCell(store, program.key, "2026-06-26T12:01:00.000Z", { derive: true });
    assert.equal(run2.run.output.tripped, true);
    assert.equal(run2.derived?.accepted, true);
    assert.equal(run2.derived?.duplicateOf, undefined);
    const countAfterRun2 = store.stats().cells;

    store.put({ ...watched, scores: { ...watched.scores, effective: 0.9 } });
    const run3 = runProgramCell(store, program.key, "2026-06-26T12:02:00.000Z", { derive: true });
    assert.equal(run3.run.output.tripped, true);

    store.put({ ...watched, scores: { ...watched.scores, effective: 0.4 } });
    const run4 = runProgramCell(store, program.key, "2026-06-26T12:03:00.000Z", { derive: true });
    assert.equal(run4.run.output.tripped, true);
    assert.equal(run4.run.output.current, run2.run.output.current);
    assert.equal(run4.run.output.previous, run2.run.output.previous);
    assert.equal(run4.derived?.accepted, true);
    assert.equal(run4.derived?.duplicateOf, run2.derived?.cell?.key);

    // Only run2's and run3's witnesses were newly admitted; run4 collided.
    assert.equal(store.stats().cells, countAfterRun2 + 1);
  } finally {
    store.close();
  }
});

test("runProgramCell against SqliteStore leaves a program_runs ledger row", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8, topics: ["gate"] },
      { key: "aaaaaaaa-3333-3333-3333-333333333333" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate score",
        body: "score gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            target: { keys: [a.key] },
          },
        },
      },
      { key: "cccccccc-3333-3333-3333-333333333333" },
    );
    store.put(a);
    store.put(program);

    const result = runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z");

    const ledgerRun = store.getProgramRun(result.run.id);
    assert.equal(ledgerRun?.id, result.run.id);
    assert.equal(ledgerRun?.programKey, program.key);
    assert.equal(ledgerRun?.operation, "score");
    assert.deepEqual(ledgerRun?.memberKeys, [a.key]);

    const listed = store.listProgramRuns({ programKey: program.key });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, result.run.id);
  } finally {
    store.close();
  }
});

test("listProgramRuns orders newest-first and filters by programKey across multiple runs", () => {
  const store = new SqliteStore(":memory:");
  try {
    const a = buildCell(
      { kind: "obs", title: "A", body: "a", confidence: 0.8, topics: ["gate"] },
      { key: "aaaaaaaa-4444-4444-4444-444444444444" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate score",
        body: "score gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            target: { keys: [a.key] },
          },
        },
      },
      { key: "cccccccc-4444-4444-4444-444444444444" },
    );
    store.put(a);
    store.put(program);

    const run1 = runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z");
    const run2 = runProgramCell(store, program.key, "2026-06-26T12:01:00.000Z");
    const run3 = runProgramCell(store, program.key, "2026-06-26T12:02:00.000Z");

    const listed = store.listProgramRuns({ programKey: program.key });
    assert.deepEqual(listed.map((r) => r.id), [run3.run.id, run2.run.id, run1.run.id]);
  } finally {
    store.close();
  }
});

test("runProgramCell still runs against a store double WITHOUT recordProgramRun (feature-detect)", () => {
  const cells = new Map<string, Cell>();
  const bareStore: Store = {
    put: (cell) => { cells.set(cell.key, cell); },
    get: (key) => cells.get(key),
    getByHandle: (handle) => [...cells.values()].find((c) => c.handle === handle),
    all: () => [...cells.values()],
    active: () => [...cells.values()].filter((c) => c.status === "active"),
    neighbors: () => [],
    findByContentKey: () => undefined,
    search: () => [],
    lexicalBackend: () => "like",
    stats: () => ({ cells: cells.size, activeCells: cells.size, edges: 0, indexedCells: cells.size, lexicalBackend: "like" }),
    close: () => {},
    putSemanticVector: () => {},
    getSemanticVector: () => undefined,
    listSemanticVectorIds: () => [],
    putHyperedge: () => {},
    getHyperedge: () => undefined,
    listHyperedges: () => [],
    hyperedgesForCell: () => [],
    putDagOverlay: () => {},
    getDagOverlay: () => undefined,
    listDagOverlays: () => [],
  };
  assert.equal("recordProgramRun" in bareStore, false);

  const a = buildCell(
    { kind: "obs", title: "A", body: "a", confidence: 0.8, topics: ["gate"] },
    { key: "aaaaaaaa-5555-5555-5555-555555555555" },
  );
  const program = buildCell(
    {
      kind: "prg",
      title: "Gate score",
      body: "score gate members",
      confidence: 0.9,
      topics: ["gate"],
      props: {
        program: {
          schemaVersion: "recall.program.v1",
          operation: "score",
          target: { keys: [a.key] },
        },
      },
    },
    { key: "cccccccc-5555-5555-5555-555555555555" },
  );
  bareStore.put(a);
  bareStore.put(program);

  const result = runProgramCell(bareStore, program.key, "2026-06-26T12:00:00.000Z");
  assert.equal(result.run.output.memberCount, 1);
  assert.equal(bareStore.get(program.key)?.props.runCount, 1);
});

test("tripped drift output carries concernTarget and the derived proposal carries the concerns edge", () => {
  const store = new SqliteStore(":memory:");
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-6666-6666-6666-666666666666" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate drift",
        body: "drift gate members",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "drift",
            target: { keys: [watched.key] },
            params: { delta: 0.1, concernTarget: watched.key },
          },
        },
      },
      { key: "cccccccc-6666-6666-6666-666666666666" },
    );
    store.put(watched);
    store.put(program);

    runProgramCell(store, program.key, "2026-06-26T12:00:00.000Z", { derive: true }); // baseline, no trip

    store.put({ ...watched, scores: { ...watched.scores, effective: 0.4 } });
    const tripped = runProgramCell(store, program.key, "2026-06-26T12:01:00.000Z", { derive: true });
    assert.equal(tripped.run.output.tripped, true);
    assert.equal(tripped.run.output.concernTarget, watched.key);
    assert.equal(tripped.derived?.accepted, true);
    assert.equal(
      tripped.derived?.cell?.edgesOut.some((edge) => edge.relation === "concerns" && edge.target === watched.key),
      true,
    );
  } finally {
    store.close();
  }
});

// A synthetic prior trend run whose output.series already holds [0.1, 0.2, 0.4],
// so a single executeProgram call with a member whose effective is 0.8 appends
// the 4th point and produces the exact target series [0.1, 0.2, 0.4, 0.8].
function fakeTrendRun(series: number[]): ReturnType<typeof executeProgram> {
  return {
    id: "fake-prior",
    programKey: "trend-program",
    operation: "trend",
    createdAt: "2026-06-26T11:59:00.000Z",
    memberKeys: [],
    output: { operation: "trend", memberCount: 0, memberReferences: [], series },
  };
}

function trendProgram(key: string, window = 8, delta = 0.05, streak = 2) {
  return buildCell(
    {
      kind: "prg",
      title: "Trend",
      body: "trend program",
      confidence: 0.9,
      topics: ["gate"],
      props: {
        program: {
          schemaVersion: "recall.program.v1",
          operation: "trend",
          params: { measure: "effective_confidence", window, delta, streak },
        },
      },
    },
    { key },
  );
}

function memberWithEffective(effective: number, key: string): Cell {
  const cell = buildCell({ kind: "obs", title: "m", body: "x", confidence: 0.7 }, { key });
  return { ...cell, scores: { ...cell.scores, effective } };
}

test("trend acceleration is positive for an accelerating series and negative for a decelerating one", () => {
  const positiveProgram = trendProgram("cccccccc-7777-7777-7777-777777777771");
  const positivePrior = fakeTrendRun([0.1, 0.2, 0.4]);
  const positiveRun = executeProgram(
    positiveProgram,
    [memberWithEffective(0.8, "member-pos")],
    "2026-06-26T12:00:00.000Z",
    positivePrior,
  );
  assert.deepEqual(positiveRun.output.series, [0.1, 0.2, 0.4, 0.8]);
  assert.equal((positiveRun.output.acceleration as number) > 0, true);

  const negativeProgram = trendProgram("cccccccc-7777-7777-7777-777777777772");
  const negativePrior = fakeTrendRun([0.1, 0.4, 0.6]);
  const negativeRun = executeProgram(
    negativeProgram,
    [memberWithEffective(0.7, "member-neg")],
    "2026-06-26T12:00:00.000Z",
    negativePrior,
  );
  assert.deepEqual(negativeRun.output.series, [0.1, 0.4, 0.6, 0.7]);
  assert.equal((negativeRun.output.acceleration as number) < 0, true);
});

test("trend witness title includes both slope and acceleration when tripped", () => {
  const program = trendProgram("cccccccc-8888-8888-8888-888888888888");
  const prior = fakeTrendRun([0.1, 0.2, 0.4]);
  const run = executeProgram(program, [memberWithEffective(0.8, "member-w")], "2026-06-26T12:00:00.000Z", prior);

  assert.equal(run.output.tripped, true);
  const title = run.output.witness?.title ?? "";
  assert.match(title, /slope -?\d+(\.\d+)?, accel -?\d+(\.\d+)?/);
});

test("a program with target.hyperedge selects exactly the hyperedge members, and target.role narrows them", () => {
  const store = new SqliteStore(":memory:");
  try {
    const driver = buildCell(
      { kind: "obs", title: "Driver", body: "d", confidence: 0.8 },
      { key: "aaaaaaaa-9999-9999-9999-999999999999" },
    );
    const reviewer = buildCell(
      { kind: "obs", title: "Reviewer", body: "r", confidence: 0.6 },
      { key: "bbbbbbbb-9999-9999-9999-999999999999" },
    );
    const outsider = buildCell(
      { kind: "obs", title: "Outsider", body: "o", confidence: 0.5 },
      { key: "dddddddd-9999-9999-9999-999999999999" },
    );
    store.put(driver);
    store.put(reviewer);
    store.put(outsider);

    store.putHyperedge({
      id: "eeeeeeee-9999-9999-9999-999999999999",
      kind: "cluster",
      title: "quorum group",
      members: [
        { key: driver.key, role: "driver", ordinal: 0 },
        { key: reviewer.key, role: "reviewer", ordinal: 1 },
      ],
      metadata: {},
      createdAt: "2026-06-26T00:00:00.000Z",
    });

    const programAll = buildCell(
      {
        kind: "prg",
        title: "Hyperedge score all",
        body: "score hyperedge members",
        confidence: 0.9,
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            target: { hyperedge: "eeeeeeee-9999-9999-9999-999999999999" },
          },
        },
      },
      { key: "cccccccc-9999-9999-9999-999999999999" },
    );
    store.put(programAll);
    const resultAll = runProgramCell(store, programAll.key, "2026-06-26T12:00:00.000Z");
    assert.deepEqual(
      resultAll.run.memberKeys.sort(),
      [driver.key, reviewer.key].sort(),
    );

    const programRole = buildCell(
      {
        kind: "prg",
        title: "Hyperedge score driver only",
        body: "score hyperedge driver",
        confidence: 0.9,
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "score",
            target: { hyperedge: "eeeeeeee-9999-9999-9999-999999999999", role: "driver" },
          },
        },
      },
      { key: "ffffffff-9999-9999-9999-999999999999" },
    );
    store.put(programRole);
    const resultRole = runProgramCell(store, programRole.key, "2026-06-26T12:00:00.000Z");
    assert.deepEqual(resultRole.run.memberKeys, [driver.key]);
  } finally {
    store.close();
  }
});

// ---------- allocate (allocation-pressure) ----------

function allocateProgram(key: string, params?: Record<string, unknown>) {
  return buildCell(
    {
      kind: "prg",
      title: "Allocation pressure across the backlog",
      body: "allocate program",
      confidence: 0.9,
      props: {
        program: {
          schemaVersion: "recall.program.v1",
          operation: "allocate",
          params,
        },
      },
    },
    { key },
  );
}

function taskCell(key: string, title: string, confidence: number, work?: Record<string, unknown>) {
  return buildCell(
    {
      kind: "tsk",
      title,
      body: title,
      confidence,
      props: work ? { work } : undefined,
    },
    { key },
  );
}

test("executeProgram allocate: fully specified props.work pins the exact hand-computed score", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000001");
  const member = taskCell("aaaaaaaa-a000-a000-a000-000000000001", "Full props task", 0.8, {
    impact: 0.7,
    uncertainty: 0.6,
    concern: 0.5,
    dependencyWeight: 0.8,
    reversibility: 0.4,
    novelty: 0.9,
    cost: 0.5,
  });
  const run = executeProgram(program, [member], "2026-07-03T12:00:00.000Z");
  assert.equal(run.output.operation, "allocate");
  const ranked = run.output.ranked as { key: string; score: number; rationale: string[] }[];
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.score, 2.548);
  assert.equal(ranked[0]!.rationale.length, 7);
  assert.deepEqual(ranked[0]!.rationale, [
    "impact=0.7",
    "uncertainty=0.6",
    "concern=0.5",
    "dependencyWeight=0.8",
    "reversibility=0.4",
    "novelty=0.9",
    "cost=0.5",
  ]);
});

test("executeProgram allocate: bare tsk cell (no props.work) uses live scores for uncertainty/concern and legacy defaults elsewhere", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000002");
  const member = taskCell("aaaaaaaa-a000-a000-a000-000000000002", "Bare task", 0.8);
  // confidence 0.8 -> scores.uncertainty = round3(0.2*0.7) = 0.14, scores.concern = round3(0.2*0.3) = 0.06
  assert.equal(member.scores.uncertainty, 0.14);
  assert.equal(member.scores.concern, 0.06);

  const run = executeProgram(program, [member], "2026-07-03T12:00:00.000Z");
  const ranked = run.output.ranked as { key: string; score: number; rationale: string[] }[];
  assert.equal(ranked[0]!.score, 0.375);
  assert.deepEqual(ranked[0]!.rationale, [
    "impact=0.5",
    "uncertainty=0.14",
    "concern=0.06",
    "dependencyWeight=0.5",
    "reversibility=0.5",
    "novelty=0.3",
    "cost=0.5",
  ]);
});

test("executeProgram allocate: cost floors at 0.05 even when props.work.cost is lower", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000003");
  const member = taskCell("aaaaaaaa-a000-a000-a000-000000000003", "Cheap task", 0.8, { cost: 0.01 });
  const run = executeProgram(program, [member], "2026-07-03T12:00:00.000Z");
  const ranked = run.output.ranked as { key: string; score: number; rationale: string[] }[];
  assert.equal(ranked[0]!.score, 3.75);
  assert.match(ranked[0]!.rationale[6]!, /^cost=0\.05$/);
});

test("executeProgram allocate: limit defaults to 8 and floors at 1 when params.limit is 0 or negative", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000004");
  const members = Array.from({ length: 3 }, (_, i) =>
    taskCell(`aaaaaaaa-a000-a000-a000-00000000001${i}`, `Task ${i}`, 0.8),
  );
  const defaultRun = executeProgram(program, members, "2026-07-03T12:00:00.000Z");
  assert.equal(defaultRun.output.limit, 8);
  assert.equal((defaultRun.output.selected as unknown[]).length, 3);

  const zeroLimitProgram = allocateProgram("cccccccc-a000-a000-a000-000000000005", { limit: 0 });
  const zeroRun = executeProgram(zeroLimitProgram, members, "2026-07-03T12:00:00.000Z");
  assert.equal(zeroRun.output.limit, 1);
  assert.equal((zeroRun.output.selected as unknown[]).length, 1);

  const negativeLimitProgram = allocateProgram("cccccccc-a000-a000-a000-000000000006", { limit: -5 });
  const negativeRun = executeProgram(negativeLimitProgram, members, "2026-07-03T12:00:00.000Z");
  assert.equal(negativeRun.output.limit, 1);
  assert.equal((negativeRun.output.selected as unknown[]).length, 1);
});

test("executeProgram allocate: equal scores tiebreak on key ascending, deterministically", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000007");
  // Identical props.work -> identical scores; only the key differs.
  const work = { impact: 0.6, uncertainty: 0.5, concern: 0.4, dependencyWeight: 0.5, reversibility: 0.5, novelty: 0.3, cost: 0.4 };
  const memberZ = taskCell("zzzzzzzz-a000-a000-a000-000000000001", "Z task", 0.8, work);
  const memberA = taskCell("aaaaaaaa-a000-a000-a000-000000000099", "A task", 0.8, work);
  const memberM = taskCell("mmmmmmmm-a000-a000-a000-000000000050", "M task", 0.8, work);

  const run = executeProgram(program, [memberZ, memberA, memberM], "2026-07-03T12:00:00.000Z");
  const ranked = run.output.ranked as { key: string; score: number }[];
  assert.equal(ranked[0]!.score, ranked[1]!.score);
  assert.equal(ranked[1]!.score, ranked[2]!.score);
  assert.deepEqual(
    ranked.map((r) => r.key),
    [memberA.key, memberM.key, memberZ.key].sort(),
  );
});

test("executeProgram allocate: first run (no previousRun) has changed true and a witness naming top-N of memberCount and the program's first 8 words", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000008", { limit: 1 });
  const memberA = taskCell("aaaaaaaa-a000-a000-a000-000000000101", "Task Alpha", 0.9, { impact: 0.9, cost: 0.2 });
  const memberB = taskCell("bbbbbbbb-a000-a000-a000-000000000102", "Task Beta", 0.5, { impact: 0.1, cost: 0.9 });

  const run = executeProgram(program, [memberA, memberB], "2026-07-03T12:00:00.000Z");
  assert.equal(run.output.changed, true);
  assert.ok(run.output.witness, "first run (no previousRun) must carry a witness");
  const witness = run.output.witness!;
  assert.equal(witness.title, "Allocation: top 1 of 2 for Allocation pressure across the backlog");
  const selected = run.output.selected as { title: string }[];
  assert.equal(selected.length, 1);
  assert.equal(witness.summary, selected.map((s) => s.title).join("; "));
});

test("executeProgram allocate: second run with identical members and scores has changed false and no witness", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000010", { limit: 1 });
  const memberA = taskCell("aaaaaaaa-a000-a000-a000-000000000103", "Task Alpha", 0.9, { impact: 0.9, cost: 0.2 });
  const memberB = taskCell("bbbbbbbb-a000-a000-a000-000000000104", "Task Beta", 0.5, { impact: 0.1, cost: 0.9 });

  const first = executeProgram(program, [memberA, memberB], "2026-07-03T12:00:00.000Z");
  assert.equal(first.output.changed, true);
  assert.ok(first.output.witness);

  const second = executeProgram(program, [memberA, memberB], "2026-07-03T12:01:00.000Z", first);
  assert.equal(second.output.changed, false);
  assert.equal(second.output.witness, undefined, "unchanged selected set must not emit a witness");
});

test("executeProgram allocate: a run where the selected set changes (a higher-scoring member joins) has changed true and a witness", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000011", { limit: 1 });
  const memberA = taskCell("aaaaaaaa-a000-a000-a000-000000000105", "Task Alpha", 0.9, { impact: 0.5, cost: 0.5 });

  const first = executeProgram(program, [memberA], "2026-07-03T12:00:00.000Z");
  assert.equal(first.output.changed, true);
  const firstSelected = first.output.selected as { key: string }[];
  assert.deepEqual(firstSelected.map((s) => s.key), [memberA.key]);

  const memberBetter = taskCell("bbbbbbbb-a000-a000-a000-000000000106", "Task Beta wins", 0.9, {
    impact: 0.9,
    cost: 0.2,
  });
  const second = executeProgram(program, [memberA, memberBetter], "2026-07-03T12:01:00.000Z", first);
  const secondSelected = second.output.selected as { key: string }[];
  assert.deepEqual(secondSelected.map((s) => s.key), [memberBetter.key]);
  assert.equal(second.output.changed, true);
  assert.ok(second.output.witness, "changed selected set must carry a witness");
});

test("executeProgram allocate: witness summary joins multiple selected titles with '; '", () => {
  const program = allocateProgram("cccccccc-a000-a000-a000-000000000009", { limit: 2 });
  const memberA = taskCell("aaaaaaaa-a000-a000-a000-000000000111", "Task Alpha", 0.9, { impact: 0.9, cost: 0.2 });
  const memberB = taskCell("bbbbbbbb-a000-a000-a000-000000000112", "Task Beta", 0.7, { impact: 0.5, cost: 0.4 });

  const run = executeProgram(program, [memberA, memberB], "2026-07-03T12:00:00.000Z");
  const selected = run.output.selected as { title: string }[];
  assert.equal(selected.length, 2);
  assert.equal(run.output.witness?.summary, selected.map((s) => s.title).join("; "));
});

test("runProgramCell allocate: deriving twice over unchanged members grows the cell count only on the first run", () => {
  const store = new SqliteStore(":memory:");
  try {
    const member = taskCell("aaaaaaaa-a000-a000-a000-000000000201", "Steady task", 0.8, { impact: 0.6, cost: 0.4 });
    const program = buildCell(
      {
        kind: "prg",
        title: "Allocate steady",
        body: "allocate program",
        confidence: 0.9,
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "allocate",
            target: { keys: [member.key] },
          },
        },
      },
      { key: "cccccccc-a000-a000-a000-000000000202" },
    );
    store.put(member);
    store.put(program);

    const countBeforeFirst = store.stats().cells;
    const first = runProgramCell(store, program.key, "2026-07-03T12:00:00.000Z", { derive: true });
    assert.equal(first.run.output.changed, true);
    assert.equal(first.derived?.accepted, true);
    const countAfterFirst = store.stats().cells;
    assert.equal(countAfterFirst > countBeforeFirst, true, "the first run's witness admits a new cell");

    // Same member, live scores unchanged (drift in scores.uncertainty/concern
    // would still hash differently through programRunDerivationKey, but
    // changed=false suppresses the witness entirely, so derive has nothing to
    // admit): the selected set is identical, so no witness, so no derive call
    // ever reaches deriveAdmit for this run.
    const second = runProgramCell(store, program.key, "2026-07-03T12:01:00.000Z", { derive: true });
    assert.equal(second.run.output.changed, false);
    assert.equal(second.run.output.witness, undefined);
    assert.equal(second.derived, undefined, "no witness means no proposal, so nothing is derived");
    assert.equal(store.stats().cells, countAfterFirst, "cell count is unchanged by the second run");
  } finally {
    store.close();
  }
});
