import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, compileContext, formatContextPacket } from "./compile.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";

test("compile ranks a matching cell and excludes a non-matching one", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "add watchdog op", body: "tripwire on eff", confidence: 0.8 }, { key: "k1" }));
  store.put(buildCell({ kind: "obs", title: "unrelated banana", body: "fruit", confidence: 0.7 }, { key: "k2" }));

  const r = compile(store, "watchdog tripwire");
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.cell.key, "k1");
  store.close();
});

test("compile renders mini-index lines and respects the limit", () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.put(buildCell({ kind: "obs", title: `watchdog ${i}`, body: "x", confidence: 0.6 }, { key: `k${i}` }));
  }
  const r = compile(store, "watchdog", { limit: 3 });
  assert.equal(r.hits.length, 3);
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0]!, /^obs_\w+ "watchdog/); // a rendered mini-index line
  store.close();
});

test("compile returns no hits for a zero-vocabulary query (loud miss, not garbage)", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "watchdog", body: "x", confidence: 0.8 }, { key: "k1" }));
  const r = compile(store, "zxqv nonexistent");
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.lines, []);
  store.close();
});

test("compile ranks the more on-topic cell first via BM25", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "watchdog watchdog watchdog", body: "watchdog", confidence: 0.6 }, { key: "hot" }));
  store.put(buildCell({ kind: "obs", title: "a watchdog mention", body: "mostly other words here", confidence: 0.6 }, { key: "cold" }));
  const r = compile(store, "watchdog");
  assert.equal(r.hits[0]!.cell.key, "hot"); // higher term frequency, shorter doc
  store.close();
});

test("compileContext emits an ID-first packet with expansion handles", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "add watchdog op", body: "tripwire on eff", confidence: 0.8 }, { key: "k1" }));

  const packet = compileContext(store, "watchdog tripwire", { limit: 5 });
  assert.equal(packet.objective, "watchdog tripwire");
  assert.ok(packet.compilerState.some((line) => /retrieval=/.test(line)));
  assert.ok(packet.relevantMemory.some((line) => /\[dec:k1\]/.test(line)));
  assert.deepEqual(packet.expansionHandles, ["k1"]);

  const formatted = formatContextPacket(packet);
  assert.match(formatted, /compiler_state:/);
  assert.match(formatted, /expansion_handles:/);
  store.close();
});

test("compileContext routes beliefs, risks, and tasks to packet sections", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "bel", title: "watchdog belief", body: "belief", confidence: 0.6 }, { key: "bel1" }));
  store.put(buildCell({ kind: "rsk", title: "watchdog risk", body: "risk", confidence: 0.6 }, { key: "rsk1" }));
  store.put(buildCell({ kind: "tsk", title: "watchdog task", body: "task", confidence: 0.6 }, { key: "tsk1" }));

  const packet = compileContext(store, "watchdog", { limit: 10 });
  assert.ok(packet.activeBeliefs.some((line) => /\[bel:bel1\]/.test(line)));
  assert.ok(packet.risks.some((line) => /\[rsk:rsk1\]/.test(line)));
  assert.ok(packet.tasks.some((line) => /\[tsk:tsk1\]/.test(line)));
  store.close();
});

test("compileContext surfaces incoming contradictions for selected cells", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "watchdog claim", body: "claim", confidence: 0.8 }, { key: "claim" }));
  store.put(
    buildCell(
      { kind: "obs", title: "watchdog counterexample", body: "nope", confidence: 0.8, edges: [{ relation: "contradicts", target: "claim" }] },
      { key: "challenge" },
    ),
  );

  const packet = compileContext(store, "watchdog claim", { limit: 1 });
  assert.ok(packet.conflicts.some((line) => /contradicts/.test(line)));
  assert.ok(packet.expansionHandles.includes("challenge"));
  store.close();
});

test("compileContext marks review-required cells for expansion", () => {
  const store = new SqliteStore(":memory:");
  store.put(
    buildCell(
      { kind: "obs", title: "watchdog review", body: "needs review", confidence: 0.6, flags: { requiresReview: true } },
      { key: "review" },
    ),
  );

  const packet = compileContext(store, "watchdog review");
  assert.ok(packet.relevantMemory.some((line) => line.startsWith("^")));
  assert.ok(packet.staleOrLowTrust.some((line) => /requires_review/.test(line)));
  store.close();
});

test("compileContext surfaces a cell's depends_on dependency", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "postgres config", body: "db settings", confidence: 0.8 }, { key: "dep1" }));
  store.put(buildCell({ kind: "dec", title: "watchdog rollout plan", body: "rests on the config", confidence: 0.8, edges: [{ relation: "depends_on", target: "dep1" }] }, { key: "down1" }));
  const packet = compileContext(store, "watchdog rollout");
  assert.ok(packet.dependencies.some((line) => /watchdog rollout/.test(line) && /postgres config/.test(line)));
  assert.match(formatContextPacket(packet), /dependencies:/);
  store.close();
});

test("compileContext flags a depends_on dependency that is superseded", () => {
  const store = new SqliteStore(":memory:");
  const dep = buildCell({ kind: "obs", title: "postgres config", body: "db settings", confidence: 0.8 }, { key: "dep1" });
  dep.status = "superseded";
  store.put(dep);
  store.put(buildCell({ kind: "dec", title: "watchdog rollout plan", body: "rests on the config", confidence: 0.8, edges: [{ relation: "depends_on", target: "dep1" }] }, { key: "down1" }));
  const packet = compileContext(store, "watchdog rollout");
  assert.ok(packet.dependencies.some((line) => /superseded/.test(line)));
  store.close();
});
