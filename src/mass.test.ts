import { test } from "node:test";
import assert from "node:assert/strict";
import { neighborMass } from "./mass.js";
import { SqliteStore } from "./store.js";
import { buildCell } from "./build.js";

test("neighborMass sums incoming support and challenge, weighted by neighbor effective", () => {
  const store = new SqliteStore(":memory:");
  const x = buildCell({ kind: "dec", title: "X", body: "b", confidence: 0.6 }, { key: "xxxx" });
  const a = buildCell(
    { kind: "obs", title: "A", body: "b", confidence: 0.9, edges: [{ relation: "supports", target: "xxxx" }] },
    { key: "aaaa" },
  );
  const b = buildCell(
    { kind: "obs", title: "B", body: "b", confidence: 0.8, edges: [{ relation: "contradicts", target: "xxxx" }] },
    { key: "bbbb" },
  );
  store.put(x);
  store.put(a);
  store.put(b);

  const m = neighborMass(store, "xxxx");
  assert.ok(Math.abs(m.supportMass - 0.9) < 1e-9); // +1 * a.effective(0.9)
  assert.ok(Math.abs(m.challengeMass - 0.8) < 1e-9); // |-1| * b.effective(0.8)
  store.close();
});

test("neighborMass ignores outgoing edges and zero-weight relations", () => {
  const store = new SqliteStore(":memory:");
  // X points OUT at Y (supports) and depends_on Z; neither should give X mass.
  const x = buildCell(
    {
      kind: "dec", title: "X", body: "b", confidence: 0.6,
      edges: [{ relation: "supports", target: "yyyy" }, { relation: "depends_on", target: "zzzz" }],
    },
    { key: "xxxx" },
  );
  const y = buildCell({ kind: "obs", title: "Y", body: "b", confidence: 0.5 }, { key: "yyyy" });
  store.put(x);
  store.put(y);

  const m = neighborMass(store, "xxxx");
  assert.equal(m.supportMass, 0); // X's own outgoing supports does not lift X
  assert.equal(m.challengeMass, 0);
  store.close();
});
