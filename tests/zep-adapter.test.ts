import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { importZep, parseZepExport } from "../src/core/zep-adapter.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { tempDbPath } from "./helpers.js";

function exportFile(obj: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zep-export-"));
  const path = join(dir, "zep.json");
  writeFileSync(path, JSON.stringify(obj));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("zep adapter — parse", () => {
  it("normalizes edge fields (uuid/fact/name→relation/source_node/target_node/valid_at)", () => {
    const facts = parseZepExport({
      edges: [{ uuid: "e1", fact: "Alice works at Acme", name: "WORKS_AT", source_node: "Alice", target_node: "Acme", valid_at: "2025-01-01T00:00:00Z" }],
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.uuid, "e1");
    assert.equal(facts[0]!.fact, "Alice works at Acme");
    assert.equal(facts[0]!.relation, "WORKS_AT");
    assert.equal(facts[0]!.source, "Alice");
    assert.equal(facts[0]!.target, "Acme");
    assert.equal(facts[0]!.validAt, "2025-01-01T00:00:00Z");
  });

  it("accepts the {facts:[...]} envelope and a top-level array, with id/expired_at fallbacks", () => {
    assert.equal(parseZepExport({ facts: [{ id: "f", fact: "x", relation: "R", source: "A", target: "B" }] })[0]!.uuid, "f");
    assert.equal(parseZepExport([{ uuid: "g", fact: "y", name: "R", source: "A", target: "B", expired_at: "2025-06-01" }])[0]!.invalidAt, "2025-06-01");
  });
});

describe("zep adapter — import", () => {
  it("apply imports each fact as a cell", () => {
    const f = exportFile([{ uuid: "f1", fact: "Cache TTL is 60 seconds", name: "HAS_TTL", source: "Cache", target: "60s" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importZep(store, { file: f.path, apply: true });
      assert.equal(sum.source, "zep");
      assert.equal(sum.created, 1);
      assert.match(store.listNodes(100)[0]!.title, /Cache TTL is 60 seconds/);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("reconstructs supersession from bi-temporal history (invalidated fact ← superseding fact)", () => {
    // Same (source, relation), target changed; the old fact carries invalid_at.
    // Deliberately listed out of valid_at order to exercise sorting.
    const f = exportFile([
      { uuid: "newer", fact: "Alice works at Globex", name: "WORKS_AT", source: "Alice", target: "Globex", valid_at: "2025-06-01T00:00:00Z" },
      { uuid: "older", fact: "Alice works at Acme", name: "WORKS_AT", source: "Alice", target: "Acme", valid_at: "2025-01-01T00:00:00Z", invalid_at: "2025-06-01T00:00:00Z" },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importZep(store, { file: f.path, apply: true });
      assert.equal(sum.created, 1, "the older fact is created");
      assert.equal(sum.superseded, 1, "the newer fact supersedes the older");
      const olderCell = sum.items.find((i) => i.ref === "older")!.cellId!;
      const challenges = store.listRelations(olderCell, "in", 100).filter((r) => r.kind === "contradicts");
      assert.equal(challenges.length, 1, "the older fact is contradicted by the newer one");
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("does NOT chain co-existing facts (same source+relation, neither invalidated)", () => {
    const f = exportFile([
      { uuid: "k1", fact: "Alice knows Bob", name: "KNOWS", source: "Alice", target: "Bob", valid_at: "2025-01-01T00:00:00Z" },
      { uuid: "k2", fact: "Alice knows Carol", name: "KNOWS", source: "Alice", target: "Carol", valid_at: "2025-02-01T00:00:00Z" },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importZep(store, { file: f.path, apply: true });
      assert.equal(sum.created, 2, "both facts are independent creates");
      assert.equal(sum.superseded, 0, "no wrongful supersession");
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("does not collide distinct (source, relation) pairs in the grouping key", () => {
    // "A B" / "C" and "A" / "B C" both space-join to "A B C" — they must NOT chain.
    const f = exportFile([
      { uuid: "p", fact: "old colliding fact", name: "C", source: "A B", target: "T1", valid_at: "2025-01-01T00:00:00Z", invalid_at: "2025-02-01T00:00:00Z" },
      { uuid: "q", fact: "unrelated fact", name: "B C", source: "A", target: "T2", valid_at: "2025-03-01T00:00:00Z" },
    ]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importZep(store, { file: f.path, apply: true });
      assert.equal(sum.created, 2, "distinct pairs are independent");
      assert.equal(sum.superseded, 0, "no spurious supersession from a key collision");
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("is idempotent across re-imports", () => {
    const f = exportFile([{ uuid: "f1", fact: "stable fact", name: "R", source: "A", target: "B" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      importZep(store, { file: f.path, apply: true });
      const second = importZep(store, { file: f.path, apply: true });
      assert.equal(second.created, 0);
      assert.equal(second.skipped, 1);
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
      f.cleanup();
    }
  });

  it("skips a fact whose text trips the secret firewall", () => {
    const f = exportFile([{ uuid: "leak", fact: "token is AKIAABCDEFGHIJKLMNOP", name: "HAS_TOKEN", source: "svc", target: "key" }]);
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = importZep(store, { file: f.path, apply: true });
      assert.equal(sum.created, 0);
      assert.equal(sum.skipped, 1);
      assert.match(sum.items[0]!.reason ?? "", /firewall|secret/i);
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
      assert.throws(() => importZep(store, { file: "/no/such/zep.json", apply: false }), /zep|file|not found|read/i);
    } finally {
      store.close();
      temp.cleanup();
    }
  });
});

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli import zep", () => {
  it("dry-runs by default and imports with --apply", () => {
    const f = exportFile([{ uuid: "z1", fact: "cli zep fact", name: "R", source: "A", target: "B" }]);
    const temp = tempDbPath();
    try {
      const dry = execFileSync(process.execPath, [...CLI, "import", "zep", "--file", f.path, "--db", temp.path], { encoding: "utf8" });
      assert.match(dry, /"dryRun": true/);
      assert.match(dry, /"created": 1/);
      const applied = execFileSync(process.execPath, [...CLI, "import", "zep", "--file", f.path, "--apply", "--db", temp.path], { encoding: "utf8" });
      assert.match(applied, /"created": 1/);
      const store = new SQLiteRecallStore(temp.path);
      assert.equal(store.listNodes(100).length, 1);
      store.close();
    } finally {
      temp.cleanup();
      f.cleanup();
    }
  });
});
