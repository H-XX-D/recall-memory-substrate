import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCellReference,
  formatCellReference,
  cellReferenceTarget,
  cellReferencePath,
  previewReferenceValue,
} from "./references.js";

describe("parseCellReference", () => {
  it("parses target and dot-path when # is present", () => {
    const result = parseCellReference("graph:uuid#a.b");
    assert.deepEqual(result, { raw: "graph:uuid#a.b", target: "graph:uuid", path: "a.b" });
  });

  it("returns no path property when no # is present", () => {
    const result = parseCellReference("graph:uuid");
    assert.equal(result.raw, "graph:uuid");
    assert.equal(result.target, "graph:uuid");
    assert.equal(result.path, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "path"));
  });

  it("treats invalid path as no split (falls back to full string as target)", () => {
    // Path starting with digit is invalid per isValidReferencePath
    const result = parseCellReference("somekey#0invalid");
    assert.equal(result.target, "somekey#0invalid");
    assert.equal(result.path, undefined);
  });

  it("handles numeric array index in path", () => {
    const result = parseCellReference("abc#items.0");
    assert.deepEqual(result, { raw: "abc#items.0", target: "abc", path: "items.0" });
  });

  it("falls back to full string when path contains invalid chars (e.g. second #)", () => {
    // "a.b#extra" is not a valid dot-path, so the whole string becomes the target
    const result = parseCellReference("key#a.b#extra");
    assert.equal(result.target, "key#a.b#extra");
    assert.equal(result.path, undefined);
  });
});

describe("formatCellReference", () => {
  it("includes path when provided", () => {
    assert.equal(formatCellReference("graph:uuid", "a.b"), "graph:uuid#a.b");
  });

  it("returns bare target when no path", () => {
    assert.equal(formatCellReference("graph:uuid"), "graph:uuid");
  });
});

describe("cellReferenceTarget", () => {
  it("strips recall:// prefix and returns trailing segment (UUID)", () => {
    assert.equal(
      cellReferenceTarget("recall://cell/proj/kind/theid"),
      "theid"
    );
  });

  it("handles long recall:// address with many segments", () => {
    const uuid = "70cedb3e-925a-4ee5-a0be-a65995a947ab";
    const addr = `recall://cell/aidde/memory/verification_result/slug/slug/2026-06-29/${uuid}`;
    assert.equal(cellReferenceTarget(addr), uuid);
  });

  it("strips graph: prefix (after-colon strip) for graph:uuid bare key", () => {
    assert.equal(cellReferenceTarget("graph:1a2b"), "1a2b");
  });

  it("strips graph: prefix when # path is present", () => {
    assert.equal(cellReferenceTarget("graph:1a2b#x"), "1a2b");
  });

  it("returns bare key unchanged when no prefix", () => {
    assert.equal(cellReferenceTarget("bareKey"), "bareKey");
  });

  it("returns bare key unchanged for plain UUID", () => {
    const uuid = "70cedb3e-925a-4ee5-a0be-a65995a947ab";
    assert.equal(cellReferenceTarget(uuid), uuid);
  });
});

describe("cellReferencePath", () => {
  it("returns path when # is present", () => {
    assert.equal(cellReferencePath("graph:uuid#a.b"), "a.b");
  });

  it("returns undefined when no path", () => {
    assert.equal(cellReferencePath("graph:uuid"), undefined);
  });
});

describe("previewReferenceValue", () => {
  it("truncates strings longer than 180 chars to 180 chars total (with ...)", () => {
    const long = "x".repeat(300);
    const result = previewReferenceValue(long) as string;
    assert.equal(result.length, 180);
    assert.ok(result.endsWith("..."));
  });

  it("does not truncate strings at or under 180 chars", () => {
    const s = "x".repeat(180);
    assert.equal(previewReferenceValue(s), s);
  });

  it("truncates arrays longer than 8 items to 8 items", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = previewReferenceValue(arr) as unknown[];
    assert.equal(result.length, 8);
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("does not truncate arrays of 8 or fewer items", () => {
    const arr = [1, 2, 3];
    assert.deepEqual(previewReferenceValue(arr), [1, 2, 3]);
  });

  it("truncates objects with more than 8 keys to 8 keys", () => {
    const obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };
    const result = previewReferenceValue(obj) as Record<string, unknown>;
    assert.equal(Object.keys(result).length, 8);
  });

  it("does not truncate objects with 8 or fewer keys", () => {
    const obj = { a: 1, b: 2 };
    assert.deepEqual(previewReferenceValue(obj), { a: 1, b: 2 });
  });

  it("passes through numbers unchanged", () => {
    assert.equal(previewReferenceValue(42), 42);
  });

  it("passes through null unchanged", () => {
    assert.equal(previewReferenceValue(null), null);
  });

  it("passes through undefined unchanged", () => {
    assert.equal(previewReferenceValue(undefined), undefined);
  });
});
