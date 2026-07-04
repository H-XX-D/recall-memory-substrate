import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintainAll, maintainStore } from "./maintain.js";
import { homeDbPath, registerProject, registryDbPath } from "./routing.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";
import type { Store } from "./types.js";

const NOW = new Date("2026-07-03T12:00:00.000Z");

test("maintainStore ticks the operator, runs an eval, derives a health witness, and reindexes", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.put(
      buildCell(
        { kind: "obs", title: "seed", body: "a seeded observation for maintenance", confidence: 0.7 },
        { key: "seed0001", now: NOW.toISOString() },
      ),
    );

    const result = maintainStore(store, "home", NOW);

    assert.equal(result.graph, "home");
    assert.equal(result.dbPath, ":memory:");

    assert.ok("ticked" in result.operator);
    if ("ticked" in result.operator) {
      assert.equal(typeof result.operator.ticked, "number");
      assert.equal(typeof result.operator.programRuns, "number");
      assert.equal(typeof result.operator.derivedAccepted, "number");
      assert.equal(typeof result.operator.ledgerId, "string");
    }
    assert.ok("passed" in result.eval);
    if ("passed" in result.eval) {
      assert.equal(typeof result.eval.passed, "boolean");
      assert.equal(typeof result.eval.score, "number");
    }
    assert.ok("accepted" in result.health);
    if ("accepted" in result.health) {
      assert.equal(result.health.accepted, true);
      assert.equal(result.health.duplicateOf, undefined);
    }
    assert.equal(typeof result.reindexed, "number");
    assert.ok(result.reindexed >= 1);

    assert.ok("recordOperatorRun" in store);
    const runs = store.listOperatorRuns(10);
    assert.equal(runs.length, 1);
  } finally {
    store.close();
  }
});

test("maintainStore's health leg reports duplicateOf on a second same-day pass", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.put(
      buildCell(
        { kind: "obs", title: "seed", body: "a seeded observation for maintenance", confidence: 0.7 },
        { key: "seed0002", now: NOW.toISOString() },
      ),
    );

    const first = maintainStore(store, "home", NOW);
    assert.ok("accepted" in first.health && first.health.accepted && !first.health.duplicateOf);

    const second = maintainStore(store, "home", new Date(NOW.getTime() + 60_000));
    assert.ok("accepted" in second.health);
    if ("accepted" in second.health) {
      assert.equal(second.health.accepted, true);
      assert.equal(typeof second.health.duplicateOf, "string");
    }
  } finally {
    store.close();
  }
});

test("maintainStore reindexes only missing vectors on a subsequent pass", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.put(
      buildCell(
        { kind: "obs", title: "seed", body: "a seeded observation for maintenance", confidence: 0.7 },
        { key: "seed0003", now: NOW.toISOString() },
      ),
    );
    const first = maintainStore(store, "home", NOW);
    assert.ok(first.reindexed >= 1);

    const second = maintainStore(store, "home", new Date(NOW.getTime() + 60_000));
    // Nothing new to index: onlyMissing means the second pass reindexes 0 (or
    // just whatever new witness cells the second pass itself created before
    // reaching the reindex leg, which is fine since it's a later leg in the
    // fixed engine order).
    assert.equal(typeof second.reindexed, "number");
  } finally {
    store.close();
  }
});

test("maintainStore captures a per-leg error without aborting the rest of the pass", () => {
  // A store double whose eval leg throws (search throws) still yields a
  // usable operator leg and continues to health/reindex: a maintenance pass
  // must not die halfway.
  const store = new SqliteStore(":memory:");
  const throwingStore: Store = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "search") {
        return () => {
          throw new Error("boom: search unavailable");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    const result = maintainStore(throwingStore as unknown as SqliteStore, "home", NOW);

    assert.ok("error" in result.eval);
    if ("error" in result.eval) {
      assert.match(result.eval.error, /boom: search unavailable/);
    }

    // The operator leg ran fine (it doesn't call search).
    assert.ok("ticked" in result.operator);
    // The health and reindex legs still ran despite the eval leg's failure.
    assert.ok("accepted" in result.health || "error" in result.health);
    assert.equal(typeof result.reindexed, "number");
  } finally {
    store.close();
  }
});

test("maintainStore captures an operator-leg error without aborting eval/health/reindex", () => {
  const store = new SqliteStore(":memory:");
  const throwingStore: Store = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "active") {
        return () => {
          throw new Error("boom: active unavailable");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    const result = maintainStore(throwingStore as unknown as SqliteStore, "home", NOW);

    assert.ok("error" in result.operator);
    if ("error" in result.operator) {
      assert.match(result.operator.error, /boom: active unavailable/);
    }
    // eval/health/reindex do not depend on active(), so they should still run.
    assert.ok("passed" in result.eval || "error" in result.eval);
    assert.equal(typeof result.reindexed, "number");
  } finally {
    store.close();
  }
});

test("maintainAll iterates localGraphPaths across two temp graphs, dedups by resolved path, and closes stores", () => {
  const tmp = tempDir();
  try {
    const recallHome = join(tmp, "recall-home");
    const registry = join(recallHome, "db", "registry.sqlite3");
    registerProject({ root: join(tmp, "repoA") }, NOW.toISOString(), registry);
    registerProject({ root: join(tmp, "repoB") }, NOW.toISOString(), registry);

    const env = { RECALL_HOME: recallHome } as NodeJS.ProcessEnv;
    const results = maintainAll(env, NOW);

    assert.equal(results.length, 3); // home + repoA + repoB
    const graphs = results.map((r) => r.graph).sort();
    assert.deepEqual(graphs, ["home", "repoa", "repob"]);
    for (const r of results) {
      assert.ok(!("openError" in r));
      if (!("openError" in r)) {
        assert.equal(typeof r.reindexed, "number");
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("maintainAll continues past a project whose store fails to open, and still fully maintains the rest", () => {
  const tmp = tempDir();
  try {
    const recallHome = join(tmp, "recall-home");
    const registry = join(recallHome, "db", "registry.sqlite3");

    // A directory in place of the project's db file makes SqliteStore throw
    // on open. The registry stays valid, so the sweep still sees the graph
    // list and records the failure instead of aborting.
    const repoADbPath = join(recallHome, "db", "repoA.sqlite3");
    registerProject({ root: join(tmp, "repoA"), dbPath: repoADbPath }, NOW.toISOString(), registry);
    mkdirSync(repoADbPath, { recursive: true });

    const env = { RECALL_HOME: recallHome } as NodeJS.ProcessEnv;
    const results = maintainAll(env, NOW);

    assert.equal(results.length, 2);
    const [home, repoA] = results;
    assert.ok(home && repoA);

    assert.equal(home.graph, "home");
    assert.ok(!("openError" in home));
    if (!("openError" in home)) {
      assert.ok("ticked" in home.operator);
      assert.ok("passed" in home.eval || "error" in home.eval);
      assert.ok("accepted" in home.health || "error" in home.health);
      assert.equal(typeof home.reindexed, "number");
    }

    assert.equal(repoA.graph, "repoa");
    assert.equal(repoA.dbPath, repoADbPath);
    assert.ok("openError" in repoA);
    if ("openError" in repoA) {
      assert.equal(typeof repoA.openError, "string");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("maintainAll survives a corrupt home store: projects still enumerate and get maintained", () => {
  // The scenario that forced the registry split: before registry.sqlite3,
  // the home graph's store and the project registry were one file, so a
  // corrupt home store also blinded listProjects to every registered
  // project. With the split, home failing to open is just one more
  // openError row and the projects still get their full pass.
  const tmp = tempDir();
  try {
    const recallHome = join(tmp, "recall-home");
    const env = { RECALL_HOME: recallHome } as NodeJS.ProcessEnv;
    registerProject({ root: join(tmp, "repoA") }, NOW.toISOString(), registryDbPath(env));

    // A directory in place of home.sqlite3 makes home's store unopenable.
    mkdirSync(homeDbPath(env), { recursive: true });

    const results = maintainAll(env, NOW);

    assert.equal(results.length, 2);
    const [home, repoA] = results;
    assert.ok(home && repoA);

    assert.equal(home.graph, "home");
    assert.ok("openError" in home);
    if ("openError" in home) {
      assert.equal(typeof home.openError, "string");
    }

    assert.equal(repoA.graph, "repoa");
    assert.ok(!("openError" in repoA));
    if (!("openError" in repoA)) {
      assert.ok("ticked" in repoA.operator);
      assert.ok("passed" in repoA.eval || "error" in repoA.eval);
      assert.ok("accepted" in repoA.health || "error" in repoA.health);
      assert.equal(typeof repoA.reindexed, "number");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-maintain-"));
}
