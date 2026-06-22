import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteRecallStore } from "../src/core/store.js";
import { closeRoutedStores, handleMcpRequest } from "../src/mcp/server.js";
import { tempDbPath } from "./helpers.js";

function call(store: SQLiteRecallStore, name: string, args: unknown): any {
  const res: any = handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    store,
  );
  if (res.error) return { __error: res.error };
  return JSON.parse(res.result.content[0].text);
}

test("MCP per-call project routing writes and reads the routed DB, not the default", () => {
  const registry = tempDbPath();
  const mainDb = tempDbPath();
  const projDb = tempDbPath();
  const prevGlobal = process.env.RECALL_GLOBAL_DB;
  process.env.RECALL_GLOBAL_DB = registry.path;
  const main = new SQLiteRecallStore(mainDb.path); // the server's launch-resolved default store
  try {
    // register a project pointing at projDb
    const reg = call(main, "recall_project_register", {
      root: "/tmp/recall-route-mcp/acme",
      slug: "acme",
      dbPath: projDb.path,
    });
    assert.equal(reg.slug, "acme");
    assert.equal(reg.db_path, projDb.path);

    // it shows up in the registry list
    const list = call(main, "recall_project_list", {});
    assert.equal(list.projects.some((p: any) => p.slug === "acme"), true);

    // write with project:"acme" -> routed to projDb
    const w = call(main, "recall_write", {
      project: "acme",
      write: {
        kind: "decision",
        title: "Acme routed decision marker zebra",
        body: "lands in the acme project db",
        confidence: 0.8,
        topics: ["routing"],
        sourceFiles: ["x.md"],
        verification: "checked",
      },
    });
    assert.equal(w.accepted, true);

    // search WITH project:"acme" finds it
    const hit = call(main, "recall_search", { project: "acme", query: "zebra marker" });
    assert.equal(hit.results.length >= 1, true);

    // search WITHOUT project hits the default store (mainDb) -> not found
    const miss = call(main, "recall_search", { query: "zebra marker" });
    assert.equal(miss.results.length, 0);

    // an unknown slug is an explicit error, never a silent global fallback
    const bad = call(main, "recall_write", {
      project: "does-not-exist",
      write: { kind: "observation", title: "x", body: "y", confidence: 0.5, topics: ["t"] },
    });
    assert.ok(bad.__error, "expected an error for an unknown project slug");
    assert.match(bad.__error.message ?? String(bad.__error), /unknown project/);
  } finally {
    main.close();
    closeRoutedStores();
    if (prevGlobal === undefined) delete process.env.RECALL_GLOBAL_DB;
    else process.env.RECALL_GLOBAL_DB = prevGlobal;
    registry.cleanup();
    mainDb.cleanup();
    projDb.cleanup();
  }
});
