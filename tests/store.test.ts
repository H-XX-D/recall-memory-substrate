import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { compileContext, formatContextPacket } from "../src/core/context-compiler.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

describe("sqlite store and compiler", () => {
  it("searches admitted graph nodes", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const results = store.search("structured memory");

      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Recall schema initialized");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("compiles a compact context packet with expansion handles", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      admitWriteProposal(makeProposal(), store);

      const packet = compileContext(store, {
        task: "Recall schema memory",
        budgetWords: 120
      });
      const formatted = formatContextPacket(packet);

      assert.equal(packet.expansionHandles.length, 1);
      assert.match(packet.expansionHandles[0] ?? "", /^recall:\/\/cell\//);
      assert.match(formatted, /objective:/);
      assert.match(formatted, /expansion_handles:/);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});
