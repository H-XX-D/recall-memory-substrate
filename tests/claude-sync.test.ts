import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  globalDbPath,
  importAutoMemoryToGlobal,
  runClaudeSync,
} from "../src/core/claude-sync.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { tempDbPath } from "./helpers.js";

function fm(name: string, description: string, type: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
}

function makeMemoryRoot(files: { slug: string; name: string; content: string }[]): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "claudesync-root-"));
  for (const f of files) {
    const dir = join(root, f.slug, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, f.name), f.content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("importAutoMemoryToGlobal", () => {
  it("imports existing auto-memory into the given global db and leaves the .md files in place", () => {
    const mem = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("alpha-fact", "da", "note", "Body A") },
      { slug: "p", name: "b.md", content: fm("beta-fact", "db", "decision", "Body B") },
    ]);
    const gdb = tempDbPath();
    try {
      const { summary, db } = importAutoMemoryToGlobal({ globalDbPath: gdb.path, autoMemoryRoot: mem.root });
      assert.equal(summary.created, 2, "both auto-memory files imported");
      assert.equal(db, gdb.path);

      const g = new SQLiteRecallStore(gdb.path);
      assert.equal(g.listNodes(100).length, 2, "cells landed in the global db");
      g.close();

      assert.ok(existsSync(join(mem.root, "p", "memory", "a.md")), "a.md left on disk");
      assert.ok(existsSync(join(mem.root, "p", "memory", "b.md")), "b.md left on disk");
    } finally {
      gdb.cleanup();
      mem.cleanup();
    }
  });

  it("is idempotent — a second import of unchanged files creates nothing new", () => {
    const mem = makeMemoryRoot([{ slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A") }]);
    const gdb = tempDbPath();
    try {
      importAutoMemoryToGlobal({ globalDbPath: gdb.path, autoMemoryRoot: mem.root });
      const second = importAutoMemoryToGlobal({ globalDbPath: gdb.path, autoMemoryRoot: mem.root });
      assert.equal(second.summary.created, 0);
      assert.equal(second.summary.skipped, 1);
      const g = new SQLiteRecallStore(gdb.path);
      assert.equal(g.listNodes(100).length, 1, "no duplicate cell");
      g.close();
    } finally {
      gdb.cleanup();
      mem.cleanup();
    }
  });

  it("creates the global db's parent directory if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "claudesync-fresh-"));
    const mem = makeMemoryRoot([{ slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A") }]);
    try {
      const nested = join(base, "deep", "db", "global.sqlite3");
      const { summary } = importAutoMemoryToGlobal({ globalDbPath: nested, autoMemoryRoot: mem.root });
      assert.equal(summary.created, 1);
      assert.ok(existsSync(nested), "global db created under a fresh nested path");
    } finally {
      rmSync(base, { recursive: true, force: true });
      mem.cleanup();
    }
  });

  it("globalDbPath resolves under ~/.recall/db", () => {
    assert.match(globalDbPath(), /\.recall\/db\/global\.sqlite3$/);
  });
});

describe("runClaudeSync (integration: config wiring + auto-memory lift)", () => {
  const assetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations", "claude");

  it("wires the integration and imports auto-memory into global, with auto-memory disabled", () => {
    if (!existsSync(assetsRoot)) return; // bundled assets only present in a built checkout
    const home = mkdtempSync(join(tmpdir(), "claudesync-home-"));
    const mem = makeMemoryRoot([{ slug: "p", name: "a.md", content: fm("alpha-fact", "da", "note", "Body A") }]);
    const gdb = tempDbPath();
    try {
      const result = runClaudeSync({
        claudeHome: join(home, ".claude"),
        claudeJsonPath: join(home, ".claude.json"),
        assetsRoot,
        globalDbPath: gdb.path,
        autoMemoryRoot: mem.root,
      });
      assert.equal(result.autoMemoryDisabled, true, "native auto-memory turned off");
      assert.ok(result.autoMemoryImport, "import summary present");
      assert.equal(result.autoMemoryImport!.created, 1);
      assert.equal(result.autoMemoryImportDb, gdb.path);

      const g = new SQLiteRecallStore(gdb.path);
      assert.equal(g.listNodes(100).length, 1, "auto-memory cell landed in global");
      g.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
      gdb.cleanup();
      mem.cleanup();
    }
  });

  it("skips the import when keeping native auto-memory (importMemory: false)", () => {
    if (!existsSync(assetsRoot)) return;
    const home = mkdtempSync(join(tmpdir(), "claudesync-home-"));
    const mem = makeMemoryRoot([{ slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A") }]);
    const gdb = tempDbPath();
    try {
      const result = runClaudeSync({
        claudeHome: join(home, ".claude"),
        claudeJsonPath: join(home, ".claude.json"),
        assetsRoot,
        globalDbPath: gdb.path,
        autoMemoryRoot: mem.root,
        importMemory: false,
        disableAutoMemory: false,
      });
      assert.equal(result.autoMemoryImport, null, "no import when keeping auto-memory");
      const g = new SQLiteRecallStore(gdb.path);
      assert.equal(g.listNodes(100).length, 0, "nothing imported");
      g.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
      gdb.cleanup();
      mem.cleanup();
    }
  });
});
