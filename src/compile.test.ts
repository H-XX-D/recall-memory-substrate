import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, compileContext, formatContextPacket } from "./compile.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";
import { PROGRAM_SCHEMA_VERSION } from "./programs.js";

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
  // Node builds whose bundled SQLite lacks FTS5 (22.13 to 22.20) degrade to
  // LIKE by design; BM25 ordering is only a contract on the fts5 backend.
  if (store.lexicalBackend() === "fts5-bm25") {
    assert.equal(r.hits[0]!.cell.key, "hot"); // higher term frequency, shorter doc
  } else {
    assert.equal(r.hits.length, 2);
  }
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

  // Use limit: 2 so both cells are in the fused packet. Under the fused ranker
  // the challenger cell may rank above the claim cell (it has an outgoing edge,
  // boosting degree), but both need to be present for contradiction surfacing.
  const packet = compileContext(store, "watchdog claim", { limit: 2 });
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

// Task 10: wide-pool fused ranking
test("compileContext: fused ranking places a decision above a ref that out-BM25s it", () => {
  const store = new SqliteStore(":memory:");

  // A ref stub that spams the query term 6 times in a short title/body,
  // giving it a high raw-BM25 score due to term density. But it has degree 0
  // and low effective confidence (0.5).
  const refCell = buildCell(
    {
      kind: "ref",
      title: "watchdog watchdog watchdog watchdog watchdog watchdog",
      body: "watchdog watchdog watchdog",
      confidence: 0.5,
    },
    { key: "ref-stub", now: new Date().toISOString() },
  );

  // A decision that mentions the query token in a longer text (lower BM25 term
  // density) but has high effective confidence (0.9) and 3 in-edges (degree 3).
  const decCell = buildCell(
    {
      kind: "dec",
      title: "watchdog decision",
      body: "decision body text with a lot of other words to reduce term density so BM25 scores lower than the ref stub that spams watchdog many times in a short title",
      confidence: 0.9,
    },
    { key: "dec-main", now: new Date().toISOString() },
  );

  // Three supporter obs cells that point INTO dec-main, giving it in-degree 3.
  // They do NOT mention the query term, so they stay out of the result set.
  for (let i = 0; i < 3; i++) {
    const supporter = buildCell(
      {
        kind: "obs",
        title: `supporting observation ${i}`,
        body: "evidence",
        confidence: 0.8,
        edges: [{ relation: "supports", target: "dec-main" }],
      },
      { key: `sup-${i}`, now: new Date().toISOString() },
    );
    store.put(supporter);
  }

  store.put(refCell);
  store.put(decCell);

  // With raw BM25: ref-stub scores ~0.69, dec-main ~0.42 (ref comes first).
  // With fusion: ref kind factor 0.15 crushes ref's lexical term; dec wins
  // via higher effective confidence (0.9) and degree (3 vs 0).
  const packet = compileContext(store, "watchdog", { limit: 5 });

  const memLines = packet.relevantMemory;
  const decIdx = memLines.findIndex((l) => /dec:dec-main/.test(l));
  const refIdx = memLines.findIndex((l) => /ref:ref-stub/.test(l));
  assert.ok(decIdx !== -1, "dec-main should appear in relevantMemory");
  assert.ok(refIdx !== -1, "ref-stub should appear in relevantMemory");
  assert.ok(
    decIdx < refIdx,
    `fused ranking should put dec-main (idx ${decIdx}) before ref-stub (idx ${refIdx})`,
  );

  store.close();
});

test("compileContext: a challenged cell appears in staleOrLowTrust", () => {
  const store = new SqliteStore(":memory:");

  // Build a cell whose effective score will be below 0.5 * conf.
  // effective starts as conf=0.8, we manually set it lower after building.
  const cell = buildCell(
    { kind: "dec", title: "watchdog decision challenged", body: "claim body", confidence: 0.8 },
    { key: "challenged-cell", now: new Date().toISOString() },
  );
  // Collapse effective below 0.5 * conf (0.8*0.5=0.4) to trigger challenged.
  cell.scores.effective = 0.1;
  store.put(cell);

  const packet = compileContext(store, "watchdog decision", { limit: 5 });

  assert.ok(
    packet.staleOrLowTrust.some((l) => /challenged-cell/.test(l)),
    "challenged cell should appear in staleOrLowTrust",
  );

  store.close();
});

test("compileContext: budget/word-count trimming still bounds the packet", () => {
  const store = new SqliteStore(":memory:");
  // Insert many cells so the packet would overflow a tight budget without trimming.
  for (let i = 0; i < 15; i++) {
    store.put(
      buildCell(
        {
          kind: "obs",
          title: `watchdog observation with many extra words to inflate count ${i}`,
          body: `body text that is very long and full of words to push over the word budget threshold for observation cell number ${i}`,
          confidence: 0.7,
        },
        { key: `obs-${i}`, now: new Date().toISOString() },
      ),
    );
  }

  const tightBudget = 100; // very low to force trimming
  const packet = compileContext(store, "watchdog observation", {
    limit: 15,
    budgetWords: tightBudget,
  });

  assert.ok(
    packet.wordCount <= tightBudget + 20, // slight tolerance for final trim pass
    `wordCount ${packet.wordCount} should be near or below budget ${tightBudget}`,
  );

  store.close();
});

// ---------------------------------------------------------------------------
// BM25 sign-convention test: lexical score is the SOLE discriminator
// ---------------------------------------------------------------------------
// This test isolates the bm25 sign bug: two cells with identical kind, degree,
// effective-confidence, and updatedAt, but one mentions the query term far more
// often (higher BM25 score from the store). Under the OLD (negated) convention
// store.search() returns a POSITIVE score that fuseCandidates then negates to
// NEGATIVE, making Math.max(m, -c.bm25) produce 0 for every candidate and
// zeroing the lexical term. The cell order then falls through to the tiebreak
// (updatedAt tie -> key lexicographic), which is not the relevance order.
// Under the CORRECT (non-negated) convention, the higher-BM25 cell ranks first.
test("fuseCandidates via compile: higher BM25 cell ranks above lower BM25 cell when all other factors are equal", () => {
  const store = new SqliteStore(":memory:");

  // "hot" repeats the query term many times in a short doc (high term frequency,
  // high BM25) and has exactly the same kind/confidence/updatedAt as "cold".
  const ts = "2026-01-15T00:00:00.000Z";
  store.put(
    buildCell(
      {
        kind: "obs",
        title: "zircon zircon zircon zircon zircon",
        body: "zircon zircon zircon",
        confidence: 0.7,
      },
      { key: "hot", now: ts },
    ),
  );

  // "cold" mentions the term once (low BM25) but has same kind/conf/updatedAt.
  store.put(
    buildCell(
      {
        kind: "obs",
        title: "zircon mention",
        body: "unrelated words here to dilute the term frequency significantly",
        confidence: 0.7,
      },
      { key: "cold", now: ts },
    ),
  );

  // compileContext goes through fuseCandidates; compile() skips fusion and goes
  // straight to store.search(), so we must use compileContext to exercise the bug.
  const packet = compileContext(store, "zircon", { limit: 5 });

  const memLines = packet.relevantMemory;
  const hotIdx = memLines.findIndex((l) => /obs:hot/.test(l));
  const coldIdx = memLines.findIndex((l) => /obs:cold/.test(l));

  assert.ok(hotIdx !== -1, "hot should be in relevantMemory");
  assert.ok(coldIdx !== -1, "cold should be in relevantMemory");

  // LIKE-backend builds (Node without FTS5) have no BM25 signal to fuse;
  // ordering is only a contract on the fts5 backend.
  if (store.lexicalBackend() !== "fts5-bm25") {
    store.close();
    return;
  }

  // The high-frequency cell must rank first. Under the zeroed-lexical bug the
  // lexical term collapses to 0 for every candidate (because -c.bm25 <= 0
  // when c.bm25 is already positive from store.search), so bestBm25 becomes 0
  // and normalizedLexical is always 0. Both cells tie on every other factor
  // (same kind, degree, effective, recency). The sort then falls through to the
  // tiebreak: updatedAt tie -> key lexicographic. "cold" < "hot", so "cold"
  // would land at index 0 under the bug, not "hot".
  assert.ok(
    hotIdx < coldIdx,
    `expected hot (idx ${hotIdx}, high BM25) to rank before cold (idx ${coldIdx})`,
  );

  store.close();
});

// ---------------------------------------------------------------------------
// Task 15: health signals, standing programs, translated references
// ---------------------------------------------------------------------------

test("compileContext: a prg cell watching a selected cell renders in standing_programs with its delta", () => {
  const store = new SqliteStore(":memory:");
  const watched = buildCell(
    { kind: "dec", title: "watchdog rollout plan", body: "the plan body", confidence: 0.8 },
    { key: "watched" },
  );
  const program = buildCell(
    {
      kind: "prg",
      title: "guard the rollout effective confidence closely",
      body: "watch program",
      confidence: 0.9,
      props: {
        program: {
          schemaVersion: PROGRAM_SCHEMA_VERSION,
          operation: "watch",
          target: { keys: ["watched"] },
          params: { delta: 0.2 },
        },
      },
    },
    { key: "prog1" },
  );
  // The watched cell records the watching program key.
  watched.programs = ["prog1"];
  store.put(watched);
  store.put(program);

  const packet = compileContext(store, "watchdog rollout", { limit: 5 });
  assert.ok(
    packet.standingPrograms.some((l) => /^watch\(delta 0\.2\)/.test(l)),
    `expected a watch(delta 0.2) standing-program line, got ${JSON.stringify(packet.standingPrograms)}`,
  );
  assert.ok(packet.standingPrograms.some((l) => /\[program:prg_/.test(l)));
  assert.ok(packet.standingPrograms.some((l) => /covering dec:watched/.test(l)));
  assert.match(formatContextPacket(packet), /standing_programs:/);
  store.close();
});

test("compileContext: depends_on + contradicts edges render in relation order and targets join expansionHandles", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "obs", title: "postgres config foundation", body: "db", confidence: 0.8 }, { key: "dep" }));
  store.put(buildCell({ kind: "obs", title: "counter observation", body: "nope", confidence: 0.8 }, { key: "con" }));
  store.put(
    buildCell(
      {
        kind: "dec",
        title: "watchdog rollout plan",
        body: "plan",
        confidence: 0.8,
        edges: [
          { relation: "contradicts", target: "con" },
          { relation: "depends_on", target: "dep" },
        ],
      },
      { key: "src" },
    ),
  );

  const packet = compileContext(store, "watchdog rollout", { limit: 5 });
  const tr = packet.translatedReferences;
  const dependsIdx = tr.findIndex((l) => /depends_on/.test(l) && /postgres config/.test(l));
  const contradictsIdx = tr.findIndex((l) => /contradicts/.test(l) && /counter observation/.test(l));
  assert.ok(dependsIdx !== -1, `expected depends_on translated ref, got ${JSON.stringify(tr)}`);
  assert.ok(contradictsIdx !== -1, `expected contradicts translated ref, got ${JSON.stringify(tr)}`);
  // Relation order: depends_on before contradicts.
  assert.ok(dependsIdx < contradictsIdx, "depends_on must render before contradicts");
  assert.ok(packet.expansionHandles.includes("dep"));
  assert.ok(packet.expansionHandles.includes("con"));
  assert.match(formatContextPacket(packet), /translated_references:/);
  store.close();
});

test("compileContext: 8 edges on one cell yield 6 translated lines plus an overflow line", () => {
  const store = new SqliteStore(":memory:");
  const edges: { relation: string; target: string }[] = [];
  for (let i = 0; i < 8; i++) {
    store.put(buildCell({ kind: "obs", title: `support target ${i}`, body: "t", confidence: 0.7 }, { key: `t${i}` }));
    edges.push({ relation: "supports", target: `t${i}` });
  }
  store.put(
    buildCell({ kind: "dec", title: "watchdog fanned decision", body: "d", confidence: 0.8, edges }, { key: "fan" }),
  );

  const packet = compileContext(store, "watchdog fanned", { limit: 1 });
  const forCell = packet.translatedReferences.filter((l) => /watchdog fanned/.test(l));
  const overflow = forCell.filter((l) => /more references; expand fan/.test(l));
  const normal = forCell.filter((l) => !/more references; expand fan/.test(l));
  assert.equal(normal.length, 6, `expected 6 capped lines, got ${normal.length}: ${JSON.stringify(normal)}`);
  assert.equal(overflow.length, 1, `expected 1 overflow line, got ${JSON.stringify(overflow)}`);
  assert.match(overflow[0]!, /has 8 more references; expand fan for the rest/);
  store.close();
});

test("compileContext: a handle#path sourceRef inlines its value only when inlineReferenceValues", () => {
  const store = new SqliteStore(":memory:");
  const target = buildCell({ kind: "obs", title: "score holder", body: "h", confidence: 0.8 }, { key: "holder" });
  store.put(target);
  const ref = `${target.handle}#scores.effective`;
  store.put(
    buildCell(
      { kind: "dec", title: "watchdog scored decision", body: "d", confidence: 0.8, sourceRefs: [ref] },
      { key: "scored" },
    ),
  );

  const withoutInline = compileContext(store, "watchdog scored", { limit: 5 });
  assert.ok(
    withoutInline.translatedReferences.some((l) => /score holder/.test(l)),
    "the sourceRef reference should surface even without inline",
  );
  assert.ok(
    !withoutInline.translatedReferences.some((l) => /value=/.test(l)),
    "no value should be inlined without inlineReferenceValues",
  );

  const withInline = compileContext(store, "watchdog scored", { limit: 5, inlineReferenceValues: true });
  assert.ok(
    withInline.translatedReferences.some((l) => /value=/.test(l)),
    `value should be inlined with inlineReferenceValues, got ${JSON.stringify(withInline.translatedReferences)}`,
  );
  store.close();
});

test("compileContext: referenceParameters appear only when opted in and trim first under a tight budget", () => {
  const store = new SqliteStore(":memory:");
  const t1 = buildCell({ kind: "obs", title: "param source one", body: "h", confidence: 0.8 }, { key: "psrc1" });
  const t2 = buildCell({ kind: "obs", title: "param source two", body: "h", confidence: 0.8 }, { key: "psrc2" });
  store.put(t1);
  store.put(t2);
  store.put(
    buildCell(
      {
        kind: "dec",
        title: "watchdog param decision",
        body: "d",
        confidence: 0.8,
        sourceRefs: [`${t1.handle}#scores.effective`, `${t2.handle}#scores.conf`],
      },
      { key: "pdec" },
    ),
  );

  const off = compileContext(store, "watchdog param", { limit: 5 });
  assert.equal(off.referenceParameters.length, 0, "referenceParameters must be empty unless opted in");

  const on = compileContext(store, "watchdog param", { limit: 5, includeReferenceParameters: true });
  assert.ok(
    on.referenceParameters.some((l) => /value_kind=/.test(l) && /target_state=/.test(l)),
    `expected a reference-parameter line, got ${JSON.stringify(on.referenceParameters)}`,
  );
  assert.equal(on.referenceParameters.length, 2, "both path sourceRefs should yield reference parameters");

  // Under a tight budget, referenceParameters is the first section trimmed:
  // it shrinks below its untrimmed count before other sections give ground.
  const tight = compileContext(store, "watchdog param", {
    limit: 5,
    includeReferenceParameters: true,
    budgetWords: 90,
  });
  assert.ok(
    tight.referenceParameters.length < 2,
    `referenceParameters should be trimmed first, got ${tight.referenceParameters.length}`,
  );
  store.close();
});

test("compileContext: a degraded store surfaces health lines and the health compilerState line", () => {
  const store = new SqliteStore(":memory:");
  // A pressured belief: high uncertainty + concern drive a non-trust recommendation.
  const belief = buildCell(
    { kind: "bel", title: "watchdog fragile belief", body: "b", confidence: 0.4, uncertainty: 0.6, concern: 0.5 },
    { key: "belH" },
  );
  store.put(belief);
  // An expired cell: staleFinding flags it as stale.
  const expired = buildCell(
    {
      kind: "obs",
      title: "watchdog expired note",
      body: "e",
      confidence: 0.6,
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    { key: "expH" },
  );
  store.put(expired);

  const packet = compileContext(store, "watchdog", { limit: 10 });
  assert.ok(
    packet.compilerState.some((l) => /^health=beliefs:/.test(l)),
    `expected a health compilerState line, got ${JSON.stringify(packet.compilerState)}`,
  );
  assert.ok(
    packet.activeBeliefs.some((l) => /\[bel:belH\]/.test(l) && /recommendation=/.test(l)),
    `expected a health belief line, got ${JSON.stringify(packet.activeBeliefs)}`,
  );
  assert.ok(
    packet.staleOrLowTrust.some((l) => /\[stale:expH\]/.test(l)),
    `expected a health stale line, got ${JSON.stringify(packet.staleOrLowTrust)}`,
  );
  store.close();
});

test("compileContext: includeHealth false suppresses all health lines", () => {
  const store = new SqliteStore(":memory:");
  const belief = buildCell(
    { kind: "bel", title: "watchdog fragile belief", body: "b", confidence: 0.4, uncertainty: 0.6, concern: 0.5 },
    { key: "belH" },
  );
  store.put(belief);

  const packet = compileContext(store, "watchdog", { limit: 10, includeHealth: false });
  assert.ok(!packet.compilerState.some((l) => /^health=/.test(l)), "no health compilerState line");
  assert.ok(!packet.activeBeliefs.some((l) => /\[bel:belH\].*recommendation=/.test(l)), "no health belief line");
  assert.ok(!packet.staleOrLowTrust.some((l) => /\[stale:/.test(l)), "no health stale line");
  store.close();
});

test("compileContext: budget trimming never drops standingPrograms", () => {
  const store = new SqliteStore(":memory:");
  const watched = buildCell(
    { kind: "dec", title: "watchdog rollout plan for trimming coverage", body: "the plan body", confidence: 0.8 },
    { key: "watched" },
  );
  const program = buildCell(
    {
      kind: "prg",
      title: "guard the rollout effective confidence very closely across runs",
      body: "watch program",
      confidence: 0.9,
      props: {
        program: {
          schemaVersion: PROGRAM_SCHEMA_VERSION,
          operation: "watch",
          target: { keys: ["watched"] },
          params: { delta: 0.2 },
        },
      },
    },
    { key: "prog1" },
  );
  watched.programs = ["prog1"];
  store.put(watched);
  store.put(program);
  // Add filler cells so the packet overflows a tight budget.
  for (let i = 0; i < 12; i++) {
    store.put(
      buildCell(
        {
          kind: "obs",
          title: `watchdog filler observation with many words to inflate the packet count ${i}`,
          body: `filler body text long enough to push over the budget threshold number ${i}`,
          confidence: 0.7,
        },
        { key: `fill-${i}` },
      ),
    );
  }

  const packet = compileContext(store, "watchdog rollout", { limit: 12, budgetWords: 100 });
  assert.ok(
    packet.standingPrograms.length >= 1,
    `standingPrograms must survive trimming, got ${JSON.stringify(packet.standingPrograms)}`,
  );
  store.close();
});

test("empty packet sections say what would populate them", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "dec", title: "Lone decision", body: "b", confidence: 0.6 }, { key: "k1" }));
  const text = formatContextPacket(compileContext(store, "anything"));
  assert.match(text, /active_beliefs:\n- none \(populated by bel cells\)/);
  assert.match(text, /conflicts:\n- none \(populated by contradicts edges\)/);
  assert.match(text, /dependencies:\n- none \(populated by depends_on edges\)/);
  assert.match(text, /risks:\n- none \(populated by rsk cells\)/);
  assert.match(text, /tasks:\n- none \(populated by tsk cells\)/);
  store.close();
});

test("expansion handles render categorized with handle, title, and full key; raw keys preserved", () => {
  const store = new SqliteStore(":memory:");
  store.put(buildCell({ kind: "bel", title: "watchdog trips are usually real", body: "claim", confidence: 0.6 }, { key: "belk" }));
  store.put(buildCell({ kind: "dec", title: "add watchdog op to the operator", body: "tripwire on eff", confidence: 0.8 }, { key: "deck" }));

  const packet = compileContext(store, "watchdog", { limit: 5 });
  assert.deepEqual([...packet.expansionHandles].sort(), ["belk", "deck"]);
  assert.ok(packet.expansionIndex.length === 2);

  const formatted = formatContextPacket(packet);
  const section = formatted.split("expansion_handles:")[1]!;
  assert.match(section, /- decisions: dec_[0-9a-f]+ "add watchdog op to the operator" \[deck\]/);
  assert.match(section, /- beliefs: bel_[0-9a-f]+ "watchdog trips are usually real" \[belk\]/);
  assert.ok(section.indexOf("- decisions:") < section.indexOf("- beliefs:"), "decisions category comes first");
  store.close();
});
