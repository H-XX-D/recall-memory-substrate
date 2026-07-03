import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFtsMatchQuery, searchTerms, fuseCandidates, TASK_CONTEXT_KIND_FACTOR, type MalLexicalCandidate, degreeMap } from "./retrieval.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";

describe("buildFtsMatchQuery", () => {
  it("wraps a symbol token in a quoted phrase", () => {
    const result = buildFtsMatchQuery(["py-sym:foo"]);
    // Must be non-null and contain the term in quotes
    assert.ok(result !== null);
    assert.ok(result.includes('"py-sym:foo"'), `expected quoted phrase, got: ${result}`);
  });

  it("drops pure-punctuation terms (no Unicode letter or digit)", () => {
    const result = buildFtsMatchQuery(["---", "!!!"]);
    assert.equal(result, null);
  });

  it("returns null for empty input", () => {
    assert.equal(buildFtsMatchQuery([]), null);
  });

  it("returns null when all terms are punctuation-only", () => {
    assert.equal(buildFtsMatchQuery(["---", "...", "!!!"]), null);
  });

  it("keeps terms that have at least one letter or digit", () => {
    const result = buildFtsMatchQuery(["foo", "---", "bar"]);
    assert.ok(result !== null);
    assert.ok(result.includes('"foo"'));
    assert.ok(result.includes('"bar"'));
    assert.ok(!result.includes('"---"'));
  });

  it("OR-joins multiple valid phrases", () => {
    const result = buildFtsMatchQuery(["alpha", "beta"]);
    assert.ok(result !== null);
    assert.ok(result.includes(" OR "), `expected OR join, got: ${result}`);
  });

  it("escapes internal double-quote characters", () => {
    const result = buildFtsMatchQuery(['say "hello"']);
    assert.ok(result !== null);
    // The internal quotes should be doubled for FTS5 escaping
    assert.ok(result.includes('""'), `expected escaped quotes, got: ${result}`);
  });

  it("accepts Unicode letters (non-ASCII) as valid", () => {
    const result = buildFtsMatchQuery(["café"]); // "café"
    assert.ok(result !== null);
  });
});

describe("searchTerms", () => {
  it("splits on whitespace and preserves original casing", () => {
    const result = searchTerms("The quick BROWN fox");
    // 'The' is dropped (stopword), rest preserved in original casing
    assert.ok(!result.includes("The"), "should drop stopword 'The'");
    assert.ok(result.includes("quick"), "should include 'quick'");
    assert.ok(result.includes("BROWN"), "should preserve uppercase 'BROWN'");
    assert.ok(result.includes("fox"), "should include 'fox'");
  });

  it("caps at 8 terms", () => {
    const query = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const result = searchTerms(query);
    assert.ok(result.length <= 8, `expected at most 8 terms, got ${result.length}`);
  });

  it("drops single-character tokens", () => {
    const result = searchTerms("a go run x");
    // 'a' (1 char stopword), 'x' (1 char) dropped
    assert.ok(!result.includes("a"));
    assert.ok(!result.includes("x"));
    // 'go' and 'run' are not stopwords and have length > 1
    assert.ok(result.includes("go"));
    assert.ok(result.includes("run"));
  });

  it("drops stopwords (case-insensitive check)", () => {
    const result = searchTerms("the THE The quick");
    assert.ok(!result.includes("the"));
    assert.ok(!result.includes("THE"));
    assert.ok(!result.includes("The"));
    assert.ok(result.includes("quick"));
  });

  it("handles empty query", () => {
    assert.deepEqual(searchTerms(""), []);
  });

  it("handles query with only stopwords", () => {
    const result = searchTerms("the a an is");
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// fuseCandidates
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: {
    kind?: string;
    confidence?: number;
    effective?: number;
    bm25?: number;
    degree?: number;
    updatedAt?: string;
    key?: string;
  } = {}
): MalLexicalCandidate {
  const cell = buildCell(
    {
      kind: overrides.kind ?? "dec",
      title: "test cell",
      body: "body",
      confidence: overrides.confidence ?? 0.8,
    },
    { key: overrides.key ?? undefined, now: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z" }
  );
  // Override scores and timestamps as needed
  if (overrides.effective !== undefined) {
    cell.scores.effective = overrides.effective;
  }
  if (overrides.updatedAt !== undefined) {
    cell.updatedAt = overrides.updatedAt;
  }
  return {
    cell,
    // bm25 is non-negative, larger = better (matches store.search() convention).
    // store.search() already negates the raw FTS5 rank via Math.max(0, -row.rank).
    bm25: overrides.bm25 ?? 5,
    degree: overrides.degree ?? 0,
  };
}

describe("fuseCandidates", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  it("equal bm25 but higher degree and higher effective ranks first", () => {
    // bm25 convention: non-negative, larger = better (same as store.search() output).
    const low = makeCandidate({ bm25: 5, degree: 1, effective: 0.3 });
    const high = makeCandidate({ bm25: 5, degree: 10, effective: 0.9 });
    const results = fuseCandidates([low, high], 10, NOW);
    assert.equal(results[0]!.cell.key, high.cell.key, "higher degree+effective should rank first");
  });

  it("ref-kind stub with saturated bm25 sinks below a dec with lower bm25 once TASK_CONTEXT_KIND_FACTOR applies", () => {
    // ref gets factor 0.15 so its lexical term is squashed even though its bm25
    // is higher (10 vs 5). In positive convention: larger = better match.
    // ref is the saturated stub (high bm25 = 10); dec has a weaker bm25 (5)
    // but full lexical weight (factor 1). After factor: ref lexical = 0.15,
    // dec lexical = 0.5. dec should win.
    const ref = makeCandidate({ kind: "ref", bm25: 10, degree: 0, effective: 0.8 });
    const dec = makeCandidate({ kind: "dec", bm25: 5, degree: 0, effective: 0.8 });
    const results = fuseCandidates([ref, dec], 10, NOW, {
      kindLexicalFactor: TASK_CONTEXT_KIND_FACTOR,
    });
    assert.equal(results[0]!.cell.key, dec.cell.key, "dec should rank above ref after kind factor");
  });

  it("challenged is true when effective < conf * 0.5", () => {
    // conf = 0.8, effective = 0.3 => 0.3 < 0.4 => challenged
    const candidate = makeCandidate({ confidence: 0.8, effective: 0.3, bm25: 5 });
    const results = fuseCandidates([candidate], 10, NOW);
    assert.equal(results[0]!.challenged, true);
  });

  it("challenged is false when effective >= conf * 0.5", () => {
    // conf = 0.8, effective = 0.5 => 0.5 >= 0.4 => not challenged
    const candidate = makeCandidate({ confidence: 0.8, effective: 0.5, bm25: 5 });
    const results = fuseCandidates([candidate], 10, NOW);
    assert.equal(results[0]!.challenged, false);
  });

  it("equal everything else, more-recent updatedAt ranks first", () => {
    const older = makeCandidate({ bm25: 5, degree: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeCandidate({ bm25: 5, degree: 0, updatedAt: "2026-05-01T00:00:00.000Z" });
    const results = fuseCandidates([older, newer], 10, NOW);
    assert.equal(results[0]!.cell.key, newer.cell.key, "newer updatedAt should rank first");
  });

  it("TASK_CONTEXT_KIND_FACTOR uses the 'ref' key (not 'artifact')", () => {
    const keys = Object.keys(TASK_CONTEXT_KIND_FACTOR);
    assert.ok(keys.includes("ref"), "should have 'ref' key");
    assert.ok(!keys.includes("artifact"), "should NOT have 'artifact' key");
  });

  it("returns up to the limit", () => {
    // bm25 convention: non-negative, larger = better.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ bm25: i + 1, degree: i })
    );
    const results = fuseCandidates(candidates, 3, NOW);
    assert.equal(results.length, 3);
  });

  it("guard: all-zero bm25 does not produce NaN scores", () => {
    const c = makeCandidate({ bm25: 0, degree: 5, effective: 0.7 });
    const results = fuseCandidates([c], 10, NOW);
    assert.ok(Number.isFinite(results[0]!.score), "score should be finite");
  });

  it("higher bm25 ranks first when everything else is equal (proves lexical normalization is live)", () => {
    // Both candidates have identical kind, degree, effective, confidence, updatedAt.
    // The ONLY difference is bm25. Higher bm25 should produce a higher normalized
    // lexical term and rank first. This test would fail under the old negated
    // convention because -c.bm25 would be negative for positive inputs, collapsing
    // bestBm25 to 0 and zeroing the lexical term for all candidates.
    // Key choice is deliberate: "zebra" > "alpha" so key tiebreak would put "alpha"
    // first if scores tied, confirming the result is NOT from the tiebreak.
    const ts = "2026-03-01T00:00:00.000Z";
    const strong = makeCandidate({ bm25: 10, degree: 0, effective: 0.7, updatedAt: ts, key: "zebra" });
    const weak = makeCandidate({ bm25: 2, degree: 0, effective: 0.7, updatedAt: ts, key: "alpha" });
    const results = fuseCandidates([weak, strong], 10, NOW);
    assert.equal(results[0]!.cell.key, "zebra", "higher bm25 (zebra) should rank first despite key tiebreak ordering alpha first");
  });

  it("guard: NaN updatedAt does not produce a NaN score (recency fallback)", () => {
    const ts = "not-a-date";
    const c = makeCandidate({ bm25: 5, degree: 0, effective: 0.7, updatedAt: ts });
    const results = fuseCandidates([c], 10, NOW);
    assert.ok(Number.isFinite(results[0]!.score), "score should be finite even with invalid updatedAt");
  });
});

// ---------------------------------------------------------------------------
// degreeMap
// ---------------------------------------------------------------------------

describe("degreeMap", () => {
  it("returns in+out degree for each key from store.neighbors", () => {
    const store = new SqliteStore(":memory:");

    // Build a small graph: A -> B, A -> C (A has 2 out edges)
    const cellA = buildCell({ kind: "dec", title: "A", body: "cell A", confidence: 0.8 });
    const cellB = buildCell({ kind: "dec", title: "B", body: "cell B", confidence: 0.8 });
    const cellC = buildCell({ kind: "dec", title: "C", body: "cell C", confidence: 0.8 });

    store.put(cellA);
    store.put(cellB);
    store.put(cellC);

    // Add edges: A supports B and A supports C
    const edgeAB: import("./types.js").Edge = {
      relation: "supports",
      source: cellA.key,
      target: cellB.key,
      weight: 1,
    };
    const edgeAC: import("./types.js").Edge = {
      relation: "supports",
      source: cellA.key,
      target: cellC.key,
      weight: 1,
    };

    cellA.edgesOut = [edgeAB, edgeAC];
    store.put(cellA);

    // Query degrees for A, B, C
    const degrees = degreeMap(store, [cellA.key, cellB.key, cellC.key]);

    // A has 2 outgoing edges => degree 2
    assert.equal(degrees.get(cellA.key), 2, `A should have degree 2 (2 out edges)`);

    // B has 1 incoming edge (from A) => degree 1
    assert.equal(degrees.get(cellB.key), 1, `B should have degree 1 (1 in edge from A)`);

    // C has 1 incoming edge (from A) => degree 1
    assert.equal(degrees.get(cellC.key), 1, `C should have degree 1 (1 in edge from A)`);

    store.close();
  });

  it("returns 0 for isolated cells", () => {
    const store = new SqliteStore(":memory:");

    const cellIsolated = buildCell({ kind: "dec", title: "isolated", body: "no edges", confidence: 0.8 });
    store.put(cellIsolated);

    const degrees = degreeMap(store, [cellIsolated.key]);
    assert.equal(degrees.get(cellIsolated.key), 0, "isolated cell should have degree 0");

    store.close();
  });

  it("returns a Map with entries for all queried keys", () => {
    const store = new SqliteStore(":memory:");

    const cell1 = buildCell({ kind: "dec", title: "1", body: "cell", confidence: 0.8 });
    const cell2 = buildCell({ kind: "dec", title: "2", body: "cell", confidence: 0.8 });

    store.put(cell1);
    store.put(cell2);

    const degrees = degreeMap(store, [cell1.key, cell2.key]);

    assert.ok(degrees instanceof Map, "result should be a Map");
    assert.equal(degrees.size, 2, "should have entries for both keys");
    assert.ok(degrees.has(cell1.key), "should have key for cell1");
    assert.ok(degrees.has(cell2.key), "should have key for cell2");

    store.close();
  });
});
