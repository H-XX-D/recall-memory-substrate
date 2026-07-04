import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-stop-hook-"));
}

// Seed a store with an emit_witness standing program that always trips (its
// target is a plain cell, so the program always has something to witness).
function seedEmitWitnessProgram(dbPath: string): { programKey: string; watchedKey: string } {
  const store = new SqliteStore(dbPath);
  try {
    const watched = buildCell(
      { kind: "obs", title: "Watched", body: "watched", confidence: 0.9, topics: ["gate"] },
      { key: "aaaaaaaa-3333-3333-3333-333333333333" },
    );
    const program = buildCell(
      {
        kind: "prg",
        title: "Gate witness",
        body: "always emit a witness",
        confidence: 0.9,
        topics: ["gate"],
        props: {
          program: {
            schemaVersion: "recall.program.v1",
            operation: "emit_witness",
            target: { keys: [watched.key] },
          },
        },
      },
      { key: "cccccccc-3333-3333-3333-333333333333" },
    );
    store.put(watched);
    store.put(program);
    return { programKey: program.key, watchedKey: watched.key };
  } finally {
    store.close();
  }
}

// Runs the real stop-hook script (spawned, not imported) so the test exercises
// the actual endcap path main() drives, matching how the hook is invoked in
// production. wroteThisTurn is forced true (turnStart in the far past) so the
// gate always releases and the endcap always runs.
function runStopHook(opts: { dbPath: string; stateDir: string; sessionId?: string }): { stdout: string } {
  const sessionId = opts.sessionId ?? "sess-1";
  const statePath = join(opts.stateDir, `${sessionId}.json`);
  mkdirSync(opts.stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ turnStart: "2000-01-01T00:00:00.000Z" }));

  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "stop-hook.ts")],
    {
      input: JSON.stringify({ session_id: sessionId }),
      encoding: "utf8",
      env: {
        ...process.env,
        RECALL_DB: opts.dbPath,
        RECALL_STOP_STATE: statePath,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout };
}

test("stop endcap admits a standing-program witness cell", () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp, "recall.sqlite3");
    seedEmitWitnessProgram(dbPath);

    const before = new SqliteStore(dbPath);
    const beforeCount = before.stats().activeCells;
    before.close();
    assert.equal(beforeCount, 2); // watched + program only, no witness yet

    runStopHook({ dbPath, stateDir: join(tmp, "state") });

    const after = new SqliteStore(dbPath);
    try {
      assert.equal(after.stats().activeCells, 3); // witness admitted
    } finally {
      after.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a second stop endcap run with unchanged output admits nothing new", () => {
  const tmp = tempDir();
  try {
    const dbPath = join(tmp, "recall.sqlite3");
    seedEmitWitnessProgram(dbPath);
    const stateDir = join(tmp, "state");

    runStopHook({ dbPath, stateDir, sessionId: "sess-a" });
    const mid = new SqliteStore(dbPath);
    const midCount = mid.stats().activeCells;
    mid.close();
    assert.equal(midCount, 3);

    runStopHook({ dbPath, stateDir, sessionId: "sess-b" });
    const after = new SqliteStore(dbPath);
    try {
      assert.equal(after.stats().activeCells, midCount); // duplicateOf, no new cell
    } finally {
      after.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a store that fails to open fails open: exit 0, empty response", () => {
  const tmp = tempDir();
  try {
    // RECALL_DB points at a non-sqlite file, so the SqliteStore constructor
    // throws before the gate can run. The hook must degrade the same way as
    // the other fail-open paths (no db path, malformed stdin): exit 0, "{}".
    const dbPath = join(tmp, "not-a-db.txt");
    writeFileSync(dbPath, "this is not a sqlite database\n");

    const { stdout } = runStopHook({ dbPath, stateDir: join(tmp, "state"), sessionId: "sess-bad-db" });
    assert.deepEqual(JSON.parse(stdout), {});
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stop endcap still swallows store errors and releases the turn", () => {
  const tmp = tempDir();
  try {
    // A valid sqlite file (so store construction succeeds) with one active
    // cell's json blob replaced by a structurally empty (but syntactically
    // valid) object directly at the row level. tick() inside runOperatorCycle
    // hydrates every active row and then reads cell.flags.pinned, which
    // throws on this row. The endcap's inner try/catch must still swallow
    // that and the hook must still emit its response.
    const dbPath = join(tmp, "recall.sqlite3");
    const { programKey } = seedEmitWitnessProgram(dbPath);

    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE cells SET json = '{}' WHERE key = ?`).run(programKey);
    raw.close();

    const stateDir = join(tmp, "state");
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, "sess-err.json");
    writeFileSync(statePath, JSON.stringify({ turnStart: "2000-01-01T00:00:00.000Z" }));

    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(__dirname, "stop-hook.ts")],
      {
        input: JSON.stringify({ session_id: "sess-err" }),
        encoding: "utf8",
        env: {
          ...process.env,
          RECALL_DB: dbPath,
          RECALL_STOP_STATE: statePath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
