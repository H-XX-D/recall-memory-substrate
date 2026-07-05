import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";
import { actorCalibrationFactor, actorOutcomes } from "./actors.js";
import { admit } from "./admission.js";
import type { Cell } from "./types.js";

// Build and store a cell owned by `actor` with a given confidence and key.
function write(
  store: SqliteStore,
  actor: string,
  key: string,
  confidence: number,
  extra: Partial<Cell> = {},
): Cell {
  const cell = { ...buildCell({ kind: "obs", title: key, body: "b", confidence, owner: actor }, { key }), ...extra };
  store.put(cell);
  return cell;
}

// A hard contradiction: an active cell by a critic pointing contradicts -> target.
function contradict(store: SqliteStore, targetKey: string, key: string): void {
  store.put(
    buildCell(
      { kind: "obs", title: key, body: "b", confidence: 0.8, owner: "critic", edges: [{ relation: "contradicts", target: targetKey }] },
      { key },
    ),
  );
}

test("actorCalibrationFactor is neutral (1) below 3 resolved outcomes", () => {
  const store = new SqliteStore(":memory:");
  write(store, "alice", "a1", 0.9);
  write(store, "alice", "a2", 0.9);
  assert.equal(actorCalibrationFactor(store, "alice"), 1);
  store.close();
});

test("all-survived history still carries the Brier penalty for hedged confidence", () => {
  const store = new SqliteStore(":memory:");
  write(store, "alice", "a1", 0.9);
  write(store, "alice", "a2", 0.9);
  write(store, "alice", "a3", 0.9);
  // brier = mean((0.9 - 1)^2) = 0.01 -> factor 0.99
  assert.ok(Math.abs(actorCalibrationFactor(store, "alice") - 0.99) < 1e-9);
  store.close();
});

test("a confident writer who is repeatedly contradicted floors at 0.5", () => {
  const store = new SqliteStore(":memory:");
  write(store, "bob", "b1", 1);
  write(store, "bob", "b2", 1);
  write(store, "bob", "b3", 1);
  contradict(store, "b1", "x1");
  contradict(store, "b2", "x2");
  contradict(store, "b3", "x3");
  // brier = mean((1 - 0)^2) = 1 -> 1 - 1 = 0, floored to 0.5
  assert.equal(actorCalibrationFactor(store, "bob"), 0.5);
  store.close();
});

test("a superseded write counts as contradicted", () => {
  const store = new SqliteStore(":memory:");
  write(store, "carol", "c1", 1, { status: "superseded" });
  write(store, "carol", "c2", 1, { status: "superseded" });
  write(store, "carol", "c3", 1, { status: "superseded" });
  assert.equal(actorCalibrationFactor(store, "carol"), 0.5);
  store.close();
});

test("a soft concerns edge does NOT flip the outcome to contradicted", () => {
  const store = new SqliteStore(":memory:");
  write(store, "dana", "d1", 0.9);
  write(store, "dana", "d2", 0.9);
  write(store, "dana", "d3", 0.9);
  store.put(
    buildCell(
      { kind: "obs", title: "concern", body: "b", confidence: 0.8, owner: "critic", edges: [{ relation: "concerns", target: "d1" }] },
      { key: "cc1" },
    ),
  );
  // still all survived -> 0.99, not the contradicted floor
  assert.ok(Math.abs(actorCalibrationFactor(store, "dana") - 0.99) < 1e-9);
  store.close();
});

test("outcomes are scoped to the actor and exclude the cell being written", () => {
  const store = new SqliteStore(":memory:");
  write(store, "erin", "e1", 0.9);
  write(store, "erin", "e2", 0.9);
  write(store, "erin", "e3", 0.9);
  write(store, "someone-else", "z1", 0.1); // different actor, ignored
  const scoped = actorOutcomes(store, "erin");
  assert.equal(scoped.length, 3);
  const excluding = actorOutcomes(store, "erin", { excludeKey: "e3" });
  assert.equal(excluding.length, 2);
  store.close();
});

test("the derived factor feeds admit and deflates a proven-miscalibrated actor's effective", () => {
  const store = new SqliteStore(":memory:");
  // frank overclaims (conf 1) and is contradicted three times.
  write(store, "frank", "f1", 1);
  write(store, "frank", "f2", 1);
  write(store, "frank", "f3", 1);
  contradict(store, "f1", "y1");
  contradict(store, "f2", "y2");
  contradict(store, "f3", "y3");

  const factor = actorCalibrationFactor(store, "frank", { excludeKey: "f4" });
  assert.equal(factor, 0.5); // floored

  // The exact call the CLI/MCP make: derive the factor, feed it into R1.
  // conf 0.6 stays under the 0.7 unsupported-confidence cap, so effective
  // isolates the calibration effect: 0.6 * 0.5.
  const r = admit(
    { kind: "obs", title: "f4", body: "new claim", confidence: 0.6, owner: "frank" },
    { store, key: "f4", calibrationFactor: factor },
  );
  assert.ok(r.accepted);
  assert.equal(r.cell!.scores.actorCalibration, 0.5);
  assert.ok(Math.abs(r.cell!.scores.effective - 0.3) < 1e-9); // 0.6 * 0.5
  assert.ok(r.attenuations.some((a) => a.includes("calibration")));
  store.close();
});

test("a fresh actor with no track record admits at neutral calibration", () => {
  const store = new SqliteStore(":memory:");
  const factor = actorCalibrationFactor(store, "grace");
  assert.equal(factor, 1);
  const r = admit(
    { kind: "obs", title: "g1", body: "b", confidence: 0.7, owner: "grace" },
    { store, key: "g1", calibrationFactor: factor },
  );
  assert.equal(r.cell!.scores.actorCalibration, 1);
  assert.equal(r.cell!.scores.effective, 0.7);
  store.close();
});
