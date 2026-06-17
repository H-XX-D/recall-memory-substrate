import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  discoverAutoMemoryFiles,
  importAutoMemory,
  parseAutoMemoryFile,
} from "../src/core/auto-memory-adapter.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { tempDbPath } from "./helpers.js";

// A Claude Code auto-memory file: frontmatter (name/description/type) + body.
function fm(name: string, description: string, type: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
}

// Build a temp `projects/<slug>/memory/*.md` tree like Claude Code's.
function makeMemoryRoot(files: { slug: string; name: string; content: string }[]): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "automem-root-"));
  for (const f of files) {
    const dir = join(root, f.slug, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, f.name), f.content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("auto-memory adapter", () => {
  it("parses frontmatter (name/description/type) and the body", () => {
    const p = parseAutoMemoryFile(fm("cone-status", "the cone", "project", "Body line one.\nBody line two."));
    assert.equal(p.name, "cone-status");
    assert.equal(p.description, "the cone");
    assert.equal(p.type, "project");
    assert.match(p.body, /Body line one\./);
    assert.doesNotMatch(p.body, /^---/, "frontmatter is stripped from the body");
  });

  it("parses a file with no frontmatter as body-only", () => {
    const p = parseAutoMemoryFile("just some notes, no frontmatter");
    assert.equal(p.name, undefined);
    assert.match(p.body, /just some notes/);
  });

  it("discovers memory .md files across slugs and skips the MEMORY.md index", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "proj-a", name: "MEMORY.md", content: "# Memory Index" },
      { slug: "proj-a", name: "alpha.md", content: fm("alpha", "a", "project", "A body") },
      { slug: "proj-b", name: "beta.md", content: fm("beta", "b", "note", "B body") },
    ]);
    try {
      const found = discoverAutoMemoryFiles(root);
      const names = found.map((f) => f.filePath.split("/").pop()).sort();
      assert.deepEqual(names, ["alpha.md", "beta.md"]);
    } finally {
      cleanup();
    }
  });

  it("dry-runs: reports what it would import and writes nothing", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A") },
      { slug: "p", name: "b.md", content: fm("b", "db", "note", "Body B") },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importAutoMemory(store, { root, apply: false });
      assert.equal(sum.dryRun, true);
      assert.equal(sum.created, 2);
      assert.equal(store.listNodes(100).length, 0, "dry-run admits nothing");
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("apply imports each file as a cell with title, body, and source ref", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("alpha-fact", "desc a", "project", "The body of alpha.") },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importAutoMemory(store, { root, apply: true });
      assert.equal(sum.created, 1);
      const nodes = store.listNodes(100);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]!.title, "alpha-fact");
      assert.match(nodes[0]!.body, /The body of alpha\./);
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("is idempotent — re-importing unchanged files skips them (no duplicates)", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A unchanged") },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importAutoMemory(store, { root, apply: true });
      const second = importAutoMemory(store, { root, apply: true });
      assert.equal(second.created, 0);
      assert.equal(second.skipped, 1);
      assert.equal(store.listNodes(100).length, 1, "no duplicate cell");
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("supersedes the prior cell when a memory file's content changes", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("db-host", "the db", "decision", "Runs on db-east-1.") },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const first = importAutoMemory(store, { root, apply: true });
      const oldId = first.items[0]!.cellId!;

      writeFileSync(join(root, "p", "memory", "a.md"), fm("db-host", "the db", "decision", "Migrated to db-west-2."));
      const second = importAutoMemory(store, { root, apply: true });

      assert.equal(second.superseded, 1);
      assert.equal(second.items[0]!.action, "supersede");
      assert.deepEqual(second.items[0]!.supersedes, [oldId]);
      assert.equal(store.listNodes(100).length, 2, "a new version cell was created");
      const challenges = store.listRelations(oldId, "in", 100).filter((r) => r.kind === "contradicts");
      assert.equal(challenges.length, 1, "the new cell contradicts (supersedes) the old one");
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });
});

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli import auto-memory", () => {
  it("dry-runs by default and imports with --apply", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "a.md", content: fm("a", "da", "note", "Body A") },
    ]);
    const temp = tempDbPath();
    try {
      const dry = execFileSync(process.execPath, [...CLI, "import", "auto-memory", "--root", root, "--db", temp.path], { encoding: "utf8" });
      assert.match(dry, /"dryRun": true/);
      assert.match(dry, /"created": 1/);

      const applied = execFileSync(process.execPath, [...CLI, "import", "auto-memory", "--root", root, "--apply", "--db", temp.path], { encoding: "utf8" });
      assert.match(applied, /"created": 1/);

      const store = new SQLiteRecallStore(temp.path);
      assert.equal(store.listNodes(100).length, 1);
      store.close();
    } finally {
      temp.cleanup();
      cleanup();
    }
  });
});

describe("auto-memory adapter — robustness", () => {
  it("parses CRLF frontmatter", () => {
    const p = parseAutoMemoryFile("---\r\nname: crlf-fact\r\ndescription: d\r\ntype: note\r\n---\r\n\r\nBody here.\r\n");
    assert.equal(p.name, "crlf-fact");
    assert.match(p.body, /Body here\./);
  });

  it("falls back to the filename when the name field is empty", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "the-file.md", content: "---\nname:\ndescription: d\ntype: note\n---\n\nBody." },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importAutoMemory(store, { root, apply: true });
      const nodes = store.listNodes(100);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]!.title, "the-file.md", "empty name falls back to the filename");
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("skips an oversized file with a reason instead of importing or crashing", () => {
    const { root, cleanup } = makeMemoryRoot([{ slug: "p", name: "big.md", content: "x".repeat(2_000_000) }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importAutoMemory(store, { root, apply: true });
      assert.equal(sum.created, 0);
      assert.equal(sum.skipped, 1);
      assert.equal(sum.items[0]!.action, "skip");
      assert.match(sum.items[0]!.reason ?? "", /large|size/i);
      assert.equal(store.listNodes(100).length, 0);
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("skips an empty file", () => {
    const { root, cleanup } = makeMemoryRoot([{ slug: "p", name: "empty.md", content: "   \n\n  " }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importAutoMemory(store, { root, apply: true });
      assert.equal(sum.skipped, 1);
      assert.equal(store.listNodes(100).length, 0);
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
    }
  });

  it("dry-run and apply agree (and give a reason) when the firewall rejects a file", () => {
    const body = "deploy key AKIAABCDEFGHIJKLMNOP committed here"; // trips the AWS-key firewall pattern
    const { root, cleanup } = makeMemoryRoot([{ slug: "p", name: "leak.md", content: fm("leak", "d", "note", body) }]);
    const a = tempDbPath();
    const sa = new SQLiteRecallStore(a.path);
    const b = tempDbPath();
    const sb = new SQLiteRecallStore(b.path);
    try {
      const dry = importAutoMemory(sa, { root, apply: false });
      const wet = importAutoMemory(sb, { root, apply: true });
      assert.equal(dry.created, wet.created, "dry-run created matches apply");
      assert.equal(dry.skipped, wet.skipped, "dry-run skipped matches apply");
      assert.equal(wet.created, 0, "the secret-bearing file is not imported");
      assert.match(wet.items[0]!.reason ?? "", /firewall|secret|reject/i);
    } finally {
      sa.close();
      a.cleanup();
      sb.close();
      b.cleanup();
      cleanup();
    }
  });

  it("does not follow a symlinked memory entry out of the tree", () => {
    const { root, cleanup } = makeMemoryRoot([
      { slug: "p", name: "real.md", content: fm("real-note", "d", "note", "Real body.") },
    ]);
    const outside = mkdtempSync(join(tmpdir(), "automem-outside-"));
    writeFileSync(join(outside, "secret.md"), fm("evil-note", "d", "note", "Should NOT be imported."));
    let linked = false;
    try {
      symlinkSync(join(outside, "secret.md"), join(root, "p", "memory", "linked.md"));
      linked = true;
    } catch {
      /* symlinks unsupported on this platform — skip the negative assertion */
    }
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importAutoMemory(store, { root, apply: true });
      const titles = store.listNodes(100).map((n) => n.title);
      assert.ok(titles.includes("real-note"), "the real file is imported");
      if (linked) assert.ok(!titles.includes("evil-note"), "the symlinked file is NOT imported");
    } finally {
      store.close();
      temp.cleanup();
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
