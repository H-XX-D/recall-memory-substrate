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
