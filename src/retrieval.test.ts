import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFtsMatchQuery, searchTerms } from "./retrieval.js";

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
