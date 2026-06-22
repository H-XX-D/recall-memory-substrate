import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteRecallStore } from "../src/core/store.js";
import { admitWriteProposal } from "../src/core/admission.js";
import { analyzeMemory } from "../src/core/analysis.js";
import { buildProposal } from "../src/core/proposal-builder.js";
import { tempDbPath } from "./helpers.js";

test("rolling back a contradicts relation retracts the conflict finding (single source of truth)", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const a = admitWriteProposal(
      buildProposal({
        kind: "decision",
        title: "Adopt buf for schema tooling",
        body: "use buf",
        confidence: 0.8,
        topics: ["schema"],
        sourceFiles: ["x.md"],
        verification: "checked",
      }),
      store,
    ) as any;
    const aId = a.node.id;
    const b = admitWriteProposal(
      buildProposal({
        kind: "decision",
        title: "Reverse buf decision, use protoc",
        body: "abandon buf",
        confidence: 0.82,
        topics: ["schema"],
        sourceFiles: ["y.md"],
        contradicts: [aId],
        verification: "checked",
      }),
      store,
    ) as any;

    // before: the contradiction is reported
    const before = analyzeMemory(store).contradictions;
    assert.equal(
      before.some((c) => c.targetId === aId),
      true,
    );

    // roll back only the contradicts relation
    const relEntry = b.rollbackEntries.find(
      (e: any) => e.action === "insert_relation" && e.after?.kind === "contradicts",
    );
    assert.ok(relEntry, "expected an insert_relation rollback entry for the contradicts edge");
    const applied = store.applyRollback(relEntry.id, true);
    assert.equal(applied.applied, true);

    // after: the conflict finding is gone (was previously sourced from the cell
    // payload, which the relation rollback did not touch)
    const after = analyzeMemory(store).contradictions;
    assert.equal(
      after.some((c) => c.targetId === aId),
      false,
    );
  } finally {
    store.close();
    temp.cleanup();
  }
});
