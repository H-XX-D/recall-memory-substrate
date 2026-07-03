import { test } from "node:test";
import assert from "node:assert/strict";
import { mapKind } from "./migrate.js";

test("mapKind maps old vocabulary to MAL kinds with obs fallback", () => {
  assert.equal(mapKind("observation"), "obs");
  assert.equal(mapKind("verification_result"), "ver");
  assert.equal(mapKind("decision"), "dec");
  assert.equal(mapKind("lemma"), "bel");
  assert.equal(mapKind("objective"), "obj");
  assert.equal(mapKind("something_unknown"), "obs");
});
