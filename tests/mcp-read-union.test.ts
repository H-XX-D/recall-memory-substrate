import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitWriteProposal } from "../src/core/admission.js";
import { homeDbPath, listProjects, registerProject } from "../src/core/routing.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { closeRoutedStores, handleMcpRequest } from "../src/mcp/server.js";
import { makeProposal } from "./helpers.js";

// Drive the same handler the stdio server uses, at home scope, with NO project
// arg. This is the agent-facing read path: it must serve the cross-local union.
// Returns the raw text payload (callers parse JSON tools themselves; recall_compile
// returns a plain-text context packet).
function callHomeText(store: SQLiteRecallStore, name: string, args: unknown): string {
  const res: any = handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    store,
    { homeScope: true },
  );
  if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
  return res.result.content[0].text;
}

function callHomeJson(store: SQLiteRecallStore, name: string, args: unknown): any {
  return JSON.parse(callHomeText(store, name, args));
}

// Admit one cell into a local and return its bare id.
function seed(path: string, title: string, body: string, marker: string): string {
  const store = new SQLiteRecallStore(path);
  try {
    const result = admitWriteProposal(
      makeProposal({
        content: { title, body, summary: `${marker} summary` },
        tags: { topics: [marker], entities: ["Recall"] },
      }),
      store,
    );
    assert.equal(result.accepted, true, `seed ${marker} should be accepted`);
    return result.node!.id;
  } finally {
    store.close();
  }
}

test("MCP read tools fan out over the home read-union at home scope (FIX 1)", () => {
  const home = mkdtempSync(join(tmpdir(), "recall-mcp-union-"));
  const prevHome = process.env.RECALL_HOME;
  const prevGlobal = process.env.RECALL_GLOBAL_DB;
  // Relocate the whole central model (home local + registry) under the sandbox.
  process.env.RECALL_HOME = home;
  delete process.env.RECALL_GLOBAL_DB;
  const projectRootA = mkdtempSync(join(tmpdir(), "recall-proj-a-"));
  const projectRootB = mkdtempSync(join(tmpdir(), "recall-proj-b-"));
  // The server's launch-resolved default store is the home local.
  const defaultStore = new SQLiteRecallStore(homeDbPath());
  try {
    // Register two distinct project locals in the home registry.
    const a = registerProject({ slug: "alpha", root: projectRootA }, "2026-06-23T00:00:00Z");
    const b = registerProject({ slug: "bravo", root: projectRootB }, "2026-06-23T00:00:01Z");
    assert.equal(listProjects().length, 2);

    // Seed one distinct cell in each project local (NOT in the home local), so a
    // cross-graph hit can only come from the union, never from the home local
    // alone.
    const idA = seed(a.db_path, "Alpha quokka marker decision", "lives in the alpha local", "quokka");
    const idB = seed(b.db_path, "Bravo quokka marker decision", "lives in the bravo local", "quokka");

    // recall_search at home scope, no project arg -> graph-prefixed cross-graph hits.
    const search = callHomeJson(defaultStore, "recall_search", { query: "quokka marker" });
    const ids: string[] = search.results.map((r: any) => r.id);
    assert.ok(ids.length >= 2, `expected >=2 union hits, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(`alpha:${idA}`), `expected alpha:${idA} in ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(`bravo:${idB}`), `expected bravo:${idB} in ${JSON.stringify(ids)}`);
    for (const id of ids) assert.match(id, /^(home|alpha|bravo):/);

    // recall_compile at home scope also draws from the union (cross-graph). The
    // packet is plain text whose expansion handles carry graph-prefixed ids.
    const text = callHomeText(defaultStore, "recall_compile", { task: "quokka marker" });
    assert.match(text, /alpha:/, `compile packet should reference the alpha local: ${text}`);
    assert.match(text, /bravo:/, `compile packet should reference the bravo local: ${text}`);
  } finally {
    defaultStore.close();
    closeRoutedStores();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRootA, { recursive: true, force: true });
    rmSync(projectRootB, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.RECALL_HOME;
    else process.env.RECALL_HOME = prevHome;
    if (prevGlobal === undefined) delete process.env.RECALL_GLOBAL_DB;
    else process.env.RECALL_GLOBAL_DB = prevGlobal;
  }
});
