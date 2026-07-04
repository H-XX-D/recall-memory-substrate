import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashEmbedding,
  cosine,
  parseEmbeddingHttpResponse,
  embedTextRecord,
  textForEmbedding,
  embedText,
  indexCell,
  reindexSemantic,
  semanticSearch,
} from "./semantic.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";

describe("hashEmbedding", () => {
  it("is deterministic: same text yields identical vector", () => {
    const a = hashEmbedding("hello world");
    const b = hashEmbedding("hello world");
    assert.deepStrictEqual(a, b);
  });

  it("returns a 256-element vector", () => {
    const v = hashEmbedding("test input");
    assert.strictEqual(v.length, 256);
  });

  it("is L2-unit-normalized: |magnitude - 1| < 1e-9", () => {
    const v = hashEmbedding("the quick brown fox");
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-9, `magnitude ${magnitude} not near 1`);
  });

  it("different inputs produce different vectors", () => {
    const a = hashEmbedding("alpha");
    const b = hashEmbedding("beta");
    assert.notDeepStrictEqual(a, b);
  });
});

describe("cosine", () => {
  it("cosine(v, v) === 1 for a unit-normalized vector", () => {
    const v = hashEmbedding("some text here");
    const result = cosine(v, v);
    assert.ok(Math.abs(result - 1) < 1e-9, `cosine(v,v) = ${result}, expected ~1`);
  });

  it("cosine of two orthogonal single-bucket vectors is ~0", () => {
    // Build two vectors with non-overlapping single bucket occupancy:
    // bucket 0 only vs bucket 1 only
    const a = new Array(256).fill(0) as number[];
    const b = new Array(256).fill(0) as number[];
    a[0] = 1;
    b[1] = 1;
    const result = cosine(a, b);
    assert.ok(Math.abs(result) < 1e-9, `cosine of orthogonal vectors = ${result}, expected ~0`);
  });

  it("uses min-length: works when arrays differ in length", () => {
    const a = [1, 0, 0];
    const b = [1, 0];
    // dot product over min-length=2: 1*1 + 0*0 = 1
    assert.strictEqual(cosine(a, b), 1);
  });
});

describe("parseEmbeddingHttpResponse", () => {
  it("parses OpenAI {data:[{embedding:[...]}]} fixture", () => {
    const fixture = JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });
    const result = parseEmbeddingHttpResponse(fixture);
    assert.deepStrictEqual(result, [0.1, 0.2, 0.3]);
  });

  it("parses Ollama {embeddings:[[...]]} fixture", () => {
    const fixture = JSON.stringify({
      embeddings: [[0.4, 0.5, 0.6]],
    });
    const result = parseEmbeddingHttpResponse(fixture);
    assert.deepStrictEqual(result, [0.4, 0.5, 0.6]);
  });

  it("returns null on garbage input", () => {
    assert.strictEqual(parseEmbeddingHttpResponse("not json at all"), null);
  });

  it("returns null on empty JSON object", () => {
    assert.strictEqual(parseEmbeddingHttpResponse("{}"), null);
  });

  it("returns null when vector contains non-finite values", () => {
    const fixture = JSON.stringify({ data: [{ embedding: [1, NaN, 3] }] });
    assert.strictEqual(parseEmbeddingHttpResponse(fixture), null);
  });
});

describe("embedTextRecord", () => {
  it("without RECALL_EMBEDDING_URL returns hash:v1 backend with 256 dims", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const record = embedTextRecord("some text");
    assert.strictEqual(record.backend, "hash:v1");
    assert.strictEqual(record.dims, 256);
    assert.strictEqual(record.vector.length, 256);
  });

  it("vector is unit-normalized", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const record = embedTextRecord("another test string");
    const magnitude = Math.sqrt(record.vector.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-9, `magnitude ${magnitude} not near 1`);
  });
});

describe("embedText", () => {
  it("returns the vector from embedTextRecord", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const vec = embedText("hello");
    assert.strictEqual(vec.length, 256);
  });
});

describe("textForEmbedding", () => {
  it("concatenates strings with newlines", () => {
    const result = textForEmbedding(["hello", "world"]);
    assert.strictEqual(result, "hello\nworld");
  });

  it("JSON.stringify non-string parts", () => {
    const result = textForEmbedding(["text", { key: "val" }]);
    assert.strictEqual(result, 'text\n{"key":"val"}');
  });
});

describe("indexCell", () => {
  it("indexes a cell into store with dims matching vector length and backend hash:v1", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const cell = buildCell({
      kind: "obs",
      title: "Test observation",
      body: "This is a test cell body",
      summary: "A brief summary",
      confidence: 0.8,
      topics: ["testing", "semantic"],
      entities: ["cell", "index"],
    });
    const store = new SqliteStore(":memory:");
    indexCell(cell, store);
    const vec = store.getSemanticVector(cell.key);
    assert.ok(vec, "semantic vector should exist");
    assert.strictEqual(vec.backend, "hash:v1");
    assert.strictEqual(vec.dims, vec.vector.length);
  });
});

describe("semanticSearch", () => {
  it("returns the best-matching cell at the top with score above minScore", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cellA = buildCell({ kind: "obs", title: "quantum physics experiment", body: "quantum entanglement and wave functions", summary: "", confidence: 0.9, topics: [], entities: [] });
    const cellB = buildCell({ kind: "obs", title: "recipe for chocolate cake", body: "flour butter sugar eggs chocolate cocoa baking", summary: "", confidence: 0.9, topics: [], entities: [] });
    const cellC = buildCell({ kind: "obs", title: "typescript compiler internals", body: "type checker emit transform sourcemap", summary: "", confidence: 0.9, topics: [], entities: [] });

    store.put(cellA); store.put(cellB); store.put(cellC);
    indexCell(cellA, store);
    indexCell(cellB, store);
    indexCell(cellC, store);

    const hits = semanticSearch("quantum wave function physics", store, { minScore: 0.01 });
    assert.ok(hits.length > 0, "should return at least one hit");
    assert.strictEqual(hits[0]!.cell.key, cellA.key, "top hit should be cellA (quantum physics)");
    assert.ok(hits[0]!.score > 0.01, `score ${hits[0]!.score} should be > minScore 0.01`);
    assert.strictEqual(hits[0]!.backend, "hash:v1");
  });

  it("skips vectors whose dims do not match the query vector dims", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cell = buildCell({ kind: "obs", title: "wrong dims cell", body: "some content here", summary: "", confidence: 0.9, topics: [], entities: [] });
    store.put(cell);

    // Inject a vector with wrong dims directly (simulates a mid-store model switch)
    store.putSemanticVector({
      nodeId: cell.key,
      backend: "other:model",
      dims: 512,
      vector: new Array(512).fill(0.1),
      indexedAt: new Date().toISOString(),
    });

    const hits = semanticSearch("wrong dims cell content", store);
    // The wrong-dims vector must be skipped; nothing survives
    assert.strictEqual(hits.length, 0, "wrong-dims vector should be skipped and not scored");
  });

  it("minScore filters out low-scoring hits", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cell = buildCell({ kind: "obs", title: "irrelevant topic about cooking pasta", body: "spaghetti carbonara sauce garlic olive oil", summary: "", confidence: 0.9, topics: [], entities: [] });
    store.put(cell);
    indexCell(cell, store);

    // Query something totally unrelated to guarantee a very low score
    const hits = semanticSearch("quantum entanglement physics wave", store, { minScore: 0.99 });
    assert.strictEqual(hits.length, 0, "no cell should exceed minScore 0.99 for a very different query");
  });

  it("returns empty array for an empty store", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");
    const hits = semanticSearch("any query text", store);
    assert.strictEqual(hits.length, 0);
  });

  it("respects limit option", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    // Index 5 cells all with overlapping text to get non-zero scores
    for (let i = 0; i < 5; i++) {
      const cell = buildCell({ kind: "obs", title: `cell number ${i} about dogs pets animals`, body: "dog cat animal pet fur", summary: "", confidence: 0.9, topics: [], entities: [] });
      store.put(cell);
      indexCell(cell, store);
    }

    const hits = semanticSearch("dogs pets animals", store, { limit: 3 });
    assert.ok(hits.length <= 3, `limit 3 should return at most 3 hits, got ${hits.length}`);
  });

  it("sorts by score descending with stable key tiebreak ascending", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cell1 = buildCell({ kind: "obs", title: "aaa identical text dogs", body: "dog pet animal", summary: "", confidence: 0.9, topics: [], entities: [] });
    const cell2 = buildCell({ kind: "obs", title: "bbb identical text dogs", body: "dog pet animal", summary: "", confidence: 0.9, topics: [], entities: [] });

    store.put(cell1); store.put(cell2);
    indexCell(cell1, store);
    indexCell(cell2, store);

    const hits = semanticSearch("dogs pet animal", store, { minScore: 0 });
    assert.ok(hits.length >= 1);
    // Scores must be descending (or equal with key ascending as tiebreak)
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]!;
      const curr = hits[i]!;
      if (prev.score === curr.score) {
        assert.ok(prev.cell.key <= curr.cell.key, "tiebreak: key should be ascending");
      } else {
        assert.ok(prev.score >= curr.score, "scores should be descending");
      }
    }
  });
});

describe("reindexSemantic", () => {
  it("indexes all currently-unindexed cells in a store and returns the correct count", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cellA = buildCell({ kind: "obs", title: "Reindex A", body: "content a", confidence: 0.8 });
    const cellB = buildCell({ kind: "obs", title: "Reindex B", body: "content b", confidence: 0.8 });
    const cellC = buildCell({ kind: "obs", title: "Reindex C", body: "content c", confidence: 0.8 });
    store.put(cellA);
    store.put(cellB);
    store.put(cellC);

    assert.equal(store.listSemanticVectorIds().length, 0);

    const count = reindexSemantic(store);
    assert.equal(count, 3);
    assert.equal(store.listSemanticVectorIds().length, 3);
    assert.ok(store.getSemanticVector(cellA.key));
    assert.ok(store.getSemanticVector(cellB.key));
    assert.ok(store.getSemanticVector(cellC.key));
  });

  it("with onlyMissing: true skips cells that already have a semantic vector, only indexing the missing ones", () => {
    delete process.env["RECALL_EMBEDDING_URL"];
    const store = new SqliteStore(":memory:");

    const cellA = buildCell({ kind: "obs", title: "Missing test A", body: "content a", confidence: 0.8 });
    const cellB = buildCell({ kind: "obs", title: "Missing test B", body: "content b", confidence: 0.8 });
    store.put(cellA);
    store.put(cellB);

    // Pre-index only cellA.
    indexCell(cellA, store);
    assert.equal(store.listSemanticVectorIds().length, 1);

    const count = reindexSemantic(store, { onlyMissing: true });
    assert.equal(count, 1);
    assert.equal(store.listSemanticVectorIds().length, 2);
    assert.ok(store.getSemanticVector(cellB.key));
  });
});
