import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { importMem0, parseMem0Export } from "../src/core/mem0-adapter.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { tempDbPath } from "./helpers.js";

// Write a Mem0 export JSON file and return its path.
function exportFile(obj: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mem0-export-"));
  const path = join(dir, "mem0.json");
  writeFileSync(path, JSON.stringify(obj));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mem0 adapter — parse", () => {
  it("parses a top-level array, extracting content and categories", () => {
    const mems = parseMem0Export([
      { id: "m1", memory: "User prefers dark mode", categories: ["preferences"], created_at: "2026-01-01T00:00:00Z" },
    ]);
    assert.equal(mems.length, 1);
    assert.equal(mems[0]!.id, "m1");
    assert.equal(mems[0]!.content, "User prefers dark mode");
    assert.deepEqual(mems[0]!.categories, ["preferences"]);
  });

  it("parses the {results:[...]} and {memories:[...]} envelopes and the `content` field", () => {
    assert.equal(parseMem0Export({ results: [{ id: "a", content: "x" }] })[0]!.content, "x");
    assert.equal(parseMem0Export({ memories: [{ id: "b", text: "y" }] })[0]!.content, "y");
  });

  it("reads categories nested under metadata", () => {
    const mems = parseMem0Export([{ id: "m", memory: "z", metadata: { categories: ["food"] } }]);
    assert.deepEqual(mems[0]!.categories, ["food"]);
  });

  it("falls through an empty primary field to a populated fallback field", () => {
    const mems = parseMem0Export([{ id: "x", memory: "", content: "real content here" }]);
    assert.equal(mems[0]!.content, "real content here");
  });

  it("falls back to metadata.categories when top-level categories is not an array", () => {
    const mems = parseMem0Export([{ id: "x", memory: "z", categories: "food", metadata: { categories: ["real"] } }]);
    assert.deepEqual(mems[0]!.categories, ["real"]);
  });
});

describe("mem0 adapter — import", () => {
  it("dry-runs: reports created, writes nothing", () => {
    const f = exportFile([{ id: "m1", memory: "Alpha fact" }, { id: "m2", memory: "Beta fact" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importMem0(store, { file: f.path, apply: false });
      assert.equal(sum.source, "mem0");
      assert.equal(sum.dryRun, true);
      assert.equal(sum.created, 2);
      assert.equal(store.listNodes(100).length, 0);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("apply imports each memory as a cell (title from content, body = content)", () => {
    const f = exportFile([{ id: "m1", memory: "The deploy uses blue-green rollout" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importMem0(store, { file: f.path, apply: true });
      assert.equal(sum.created, 1);
      const nodes = store.listNodes(100);
      assert.equal(nodes.length, 1);
      assert.match(nodes[0]!.title, /deploy uses blue-green/);
      assert.match(nodes[0]!.body, /blue-green rollout/);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("is idempotent — re-importing the same export skips every memory", () => {
    const f = exportFile([{ id: "m1", memory: "stable fact" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importMem0(store, { file: f.path, apply: true });
      const second = importMem0(store, { file: f.path, apply: true });
      assert.equal(second.created, 0);
      assert.equal(second.skipped, 1);
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("supersedes when a memory's content changes (same id, refined memory)", () => {
    const v1 = exportFile([{ id: "m1", memory: "Postgres pool capped at 20" }]);
    const v2 = exportFile([{ id: "m1", memory: "Postgres pool capped at 50" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const first = importMem0(store, { file: v1.path, apply: true });
      const oldId = first.items[0]!.cellId!;
      const second = importMem0(store, { file: v2.path, apply: true });
      assert.equal(second.superseded, 1);
      assert.equal(second.items[0]!.action, "supersede");
      const challenges = store.listRelations(oldId, "in", 100).filter((r) => r.kind === "contradicts");
      assert.equal(challenges.length, 1);
    } finally {
      store.close();
      temp.cleanup();
      v1.cleanup();
      v2.cleanup();
    }
  });

  it("skips a memory whose content trips the secret firewall", () => {
    const f = exportFile([{ id: "ok", memory: "harmless fact" }, { id: "leak", memory: "aws key AKIAABCDEFGHIJKLMNOP" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importMem0(store, { file: f.path, apply: true });
      assert.equal(sum.created, 1);
      assert.equal(sum.skipped, 1);
      const leak = sum.items.find((i) => i.ref === "leak")!;
      assert.equal(leak.action, "skip");
      assert.match(leak.reason ?? "", /firewall|secret/i);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("skips a malformed record (missing id or empty content) without failing the import", () => {
    const f = exportFile([{ id: "good", memory: "real" }, { memory: "no id" }, { id: "empty", memory: "   " }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importMem0(store, { file: f.path, apply: true });
      assert.equal(sum.created, 1);
      assert.equal(sum.skipped, 2);
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("throws a clear error when the export file is missing", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      assert.throws(() => importMem0(store, { file: "/no/such/mem0-export.json", apply: false }), /mem0|file|not found|read/i);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("clamps an oversized memory body instead of storing megabytes", () => {
    const f = exportFile([{ id: "big", memory: "x".repeat(40_000) }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importMem0(store, { file: f.path, apply: true });
      const node = store.listNodes(100)[0]!;
      assert.ok(node.body.length <= 32_768, `body clamped (${node.body.length})`);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("imports a memory even when one of its categories is an empty string", () => {
    const f = exportFile([{ id: "x", memory: "good memory", categories: ["", "ok"] }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importMem0(store, { file: f.path, apply: true });
      assert.equal(sum.created, 1);
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });
});

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli import mem0", () => {
  it("dry-runs by default and imports with --apply", () => {
    const f = exportFile([{ id: "m1", memory: "cli imported fact" }]);
    const temp = tempDbPath();
    try {
      const dry = execFileSync(process.execPath, [...CLI, "import", "mem0", "--file", f.path, "--db", temp.path], { encoding: "utf8" });
      assert.match(dry, /"dryRun": true/);
      assert.match(dry, /"created": 1/);
      const applied = execFileSync(process.execPath, [...CLI, "import", "mem0", "--file", f.path, "--apply", "--db", temp.path], { encoding: "utf8" });
      assert.match(applied, /"created": 1/);
      const store = new SQLiteRecallStore(temp.path);
      assert.equal(store.listNodes(100).length, 1);
      store.close();
    } finally {
      temp.cleanup();
      f.cleanup();
    }
  });

  it("prints a clean error (no raw stack trace) and exits non-zero when the file is missing", () => {
    const temp = tempDbPath();
    try {
      let err: { status?: number; stdout?: string; stderr?: string } | undefined;
      try {
        execFileSync(process.execPath, [...CLI, "import", "mem0", "--file", "/no/such/x.json", "--db", temp.path], { encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        err = e as { status?: number; stdout?: string; stderr?: string };
      }
      assert.ok(err, "exits non-zero");
      const out = `${err!.stdout ?? ""}${err!.stderr ?? ""}`;
      assert.match(out, /cannot read|mem0 import/i, "clean message");
      assert.doesNotMatch(out, /\bat \S+ \(|\.ts:\d+:\d+\)/, "no raw stack trace");
    } finally {
      temp.cleanup();
    }
  });
});
