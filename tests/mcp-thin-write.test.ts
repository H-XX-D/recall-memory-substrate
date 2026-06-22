import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteRecallStore } from "../src/core/store.js";
import { handleMcpRequest } from "../src/mcp/server.js";
import { tempDbPath } from "./helpers.js";

function callTool(store: SQLiteRecallStore, name: string, args: unknown): any {
  const res: any = handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    store,
  );
  return JSON.parse(res.result.content[0].text);
}

test("recall_write thin form scaffolds a valid proposal and admits it", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const out = callTool(store, "recall_write", {
      write: {
        kind: "decision",
        title: "Adopt buf for protobuf schema management",
        body: "Use buf for lint and breaking-change checks during the dual-run.",
        confidence: 0.8,
        topics: ["grpc-migration", "schema-tooling"],
        sourceFiles: ["docs/adr/0007.md"],
        verification: "checked",
      },
    });
    assert.equal(out.accepted, true);
    assert.equal(out.node.kind, "decision");
    // supported (source ref + verification checked) so 0.8 is retained
    assert.equal(out.node.data.confidence.value, 0.8);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("recall_write thin form still attenuates unsupported high confidence (discipline preserved)", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const out = callTool(store, "recall_write", {
      write: {
        kind: "task",
        title: "Author billing.v1 protobufs",
        body: "Define the billing.v1 messages and RPCs.",
        confidence: 0.9, // unsupported: no evidence refs
        topics: ["grpc-migration"],
      },
    });
    assert.equal(out.accepted, true);
    assert.equal(out.node.data.confidence.value, 0.7); // firewall clamped it
    assert.equal(
      out.attenuations.some((a: string) => a.includes("0.7")),
      true,
    );
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("recall_write full proposal form still works (back-compat)", () => {
  const temp = tempDbPath();
  const store = new SQLiteRecallStore(temp.path);
  try {
    const out = callTool(store, "recall_write", {
      proposal: {
        schema_version: "recall.write.v1",
        actor: { kind: "llm", id: "claude-code" },
        intent: { kind: "observation", operation: "create" },
        content: { title: "back-compat probe", body: "still works" },
        scope: { project: "p", tenant: "t", sensitivity: "private" },
        tags: {
          topics: ["x"], entities: ["p"], rings: ["runtime"],
          lifecycle: ["active"], quality: ["calibrated"],
        },
        evidence: { source_refs: [], depends_on: [], supports: [], contradicts: [], concerns: [] },
        confidence: { value: 0.6, uncertainty: 0.2, concern: 0.1, source_quality: "medium", stability: "stable" },
        provenance: { created_at: "2026-06-22T06:00:00Z", origin: "llm", produced_by: "claude-code", verification: "checked", signature_status: "unsigned" },
        policy: { sensitivity: "private", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null },
      },
    });
    assert.equal(out.accepted, true);
  } finally {
    store.close();
    temp.cleanup();
  }
});
