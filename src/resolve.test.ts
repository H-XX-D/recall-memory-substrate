import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCell } from "./build.js";
import { selectField } from "./resolve.js";

test("selectField walks into a cell's fields by name", () => {
  const cell = buildCell({ kind: "dec", title: "hi", body: "b", confidence: 0.7 }, { key: "c1" });
  assert.equal(selectField(cell, ["title"]), "hi");
  assert.equal(selectField(cell, ["scores", "conf"]), 0.7);
});

test("selectField returns undefined for an unknown path", () => {
  const cell = buildCell({ kind: "dec", title: "hi", body: "b", confidence: 0.7 }, { key: "c1" });
  assert.equal(selectField(cell, ["nope"]), undefined);
  assert.equal(selectField(cell, ["scores", "nope"]), undefined);
});
