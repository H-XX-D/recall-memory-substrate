import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { runProgramCell, validateProgramSpec } from "./programs.js";
import { SqliteStore } from "./store.js";

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
