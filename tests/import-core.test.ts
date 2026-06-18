import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { admitImportItems, readImportFile, type ImportItem } from "../src/core/import-core.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import type { WriteProposal } from "../src/core/types.js";
import { tempDbPath } from "./helpers.js";

// A minimal valid recall.write.v1 proposal for exercising the import core.
// The core finds priors to supersede by `subgraph({entities:[srcTag]})`, so each
// proposal MUST carry its own srcTag in `entities` — that is the contract every
// adapter (mem0/zep) honors.
function proposalFor(title: string, body: string, contradicts: string[], srcTag: string): WriteProposal {
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "connector", id: "test-importer", display: "Test importer" },
    intent: { kind: "observation", operation: "create" },
    content: { title, body, summary: title },
    scope: { project: "Test", tenant: "local" },
    tags: {
      category: ["memory"],
      type: ["observation"],
      subject: [title],
      project: ["Test"],
      idea: ["import-core-test"],
      timestamp: ["2026-06-17"],
      topics: ["imported", "test"],
      entities: ["test", srcTag],
      identities: ["connector:test"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["imported"],
    },
    evidence: { source_refs: ["test"], depends_on: [], supports: [], contradicts, concerns: [] },
    confidence: { value: 0.6, uncertainty: 0.28, concern: 0.12, source_quality: "medium", stability: "stable" },
    provenance: {
      created_at: "2026-06-17T00:00:00.000Z",
      origin: "connector",
      produced_by: "test-importer",
      verification: "checked",
      signature_status: "unsigned",
    },
    policy: { sensitivity: "private", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null },
  } as WriteProposal;
}

function item(opts: {
  ref: string;
  body: string;
  srcTag: string;
  derivationKey: string;
  supersedesTags?: string[];
  title?: string;
}): ImportItem {
  return {
    ref: opts.ref,
    derivationKey: opts.derivationKey,
    srcTag: opts.srcTag,
    supersedesTags: opts.supersedesTags,
    toProposal: (contradicts) => proposalFor(opts.title ?? opts.ref, opts.body, contradicts, opts.srcTag),
  };
}

describe("import core — admitImportItems", () => {
  it("creates a cell for a fresh item", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const sum = admitImportItems(store, "test", [item({ ref: "a", body: "Alpha", srcTag: "t-src:a", derivationKey: "t:a:1" })], { apply: true });
      assert.equal(sum.created, 1);
      assert.equal(sum.superseded, 0);
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("is idempotent — re-admitting the same derivationKey skips with reason 'unchanged'", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const items = [item({ ref: "a", body: "Alpha", srcTag: "t-src:a", derivationKey: "t:a:1" })];
      admitImportItems(store, "test", items, { apply: true });
      const second = admitImportItems(store, "test", items, { apply: true });
      assert.equal(second.created, 0);
      assert.equal(second.skipped, 1);
      assert.equal(second.items[0]!.reason, "unchanged");
      assert.equal(store.listNodes(100).length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("supersedes a prior version of the same source unit (same srcTag, new derivationKey)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      const first = admitImportItems(store, "test", [item({ ref: "a", body: "v1", srcTag: "t-src:a", derivationKey: "t:a:1" })], { apply: true });
      const oldId = first.items[0]!.cellId!;
      const second = admitImportItems(store, "test", [item({ ref: "a", body: "v2", srcTag: "t-src:a", derivationKey: "t:a:2" })], { apply: true });
      assert.equal(second.superseded, 1);
      assert.equal(second.items[0]!.action, "supersede");
      assert.deepEqual(second.items[0]!.supersedes, [oldId]);
      const challenges = store.listRelations(oldId, "in", 100).filter((r) => r.kind === "contradicts");
      assert.equal(challenges.length, 1);
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("supersedes a DIFFERENT source unit named in supersedesTags (Zep bi-temporal reconstruction)", () => {
    const temp = tempDbPath();
    const store = new SQLiteRecallStore(temp.path);
    try {
      // A then B, where B supersedes A — both in one batch, in valid_at order.
      const sum = admitImportItems(
        store,
        "zep",
        [
          item({ ref: "A", body: "lives in Berlin", srcTag: "z-src:A", derivationKey: "z:A:1" }),
          item({ ref: "B", body: "lives in Munich", srcTag: "z-src:B", derivationKey: "z:B:1", supersedesTags: ["z-src:A"] }),
        ],
        { apply: true }
      );
      assert.equal(sum.created, 1, "A created");
      assert.equal(sum.superseded, 1, "B supersedes A");
      const aCell = sum.items.find((i) => i.ref === "A")!.cellId!;
      const challenges = store.listRelations(aCell, "in", 100).filter((r) => r.kind === "contradicts");
      assert.equal(challenges.length, 1, "A is contradicted by B");
    } finally {
      store.close();
      temp.cleanup();
    }
  });

  it("skips a firewall-tripping item with a reason, in BOTH dry-run and apply (count parity)", () => {
    const body = "aws key AKIAABCDEFGHIJKLMNOP here"; // trips the AWS-key firewall pattern
    const mk = () => [item({ ref: "leak", body, srcTag: "t-src:leak", derivationKey: "t:leak:1" })];
    const a = tempDbPath();
    const sa = new SQLiteRecallStore(a.path);
    const b = tempDbPath();
    const sb = new SQLiteRecallStore(b.path);
    try {
      const dry = admitImportItems(sa, "test", mk(), { apply: false });
      const wet = admitImportItems(sb, "test", mk(), { apply: true });
      assert.equal(dry.created, wet.created);
      assert.equal(dry.skipped, wet.skipped);
      assert.equal(wet.created, 0);
      assert.match(wet.items[0]!.reason ?? "", /firewall|secret|reject/i);
    } finally {
      sa.close();
      a.cleanup();
      sb.close();
      b.cleanup();
    }
  });

  it("dry-run reports create/supersede without writing, matching apply counts", () => {
    const items = [
      item({ ref: "a", body: "Alpha", srcTag: "t-src:a", derivationKey: "t:a:1" }),
      item({ ref: "b", body: "Beta", srcTag: "t-src:b", derivationKey: "t:b:1", supersedesTags: ["t-src:a"] }),
    ];
    const a = tempDbPath();
    const sa = new SQLiteRecallStore(a.path);
    const b = tempDbPath();
    const sb = new SQLiteRecallStore(b.path);
    try {
      const dry = admitImportItems(sa, "test", items, { apply: false });
      const wet = admitImportItems(sb, "test", items, { apply: true });
      assert.equal(dry.dryRun, true);
      assert.equal(sa.listNodes(100).length, 0, "dry-run writes nothing");
      assert.equal(dry.created, wet.created);
      assert.equal(dry.superseded, wet.superseded);
      assert.equal(dry.created, 1);
      assert.equal(dry.superseded, 1);
    } finally {
      sa.close();
      a.cleanup();
      sb.close();
      b.cleanup();
    }
  });

  it("dry-run and apply agree when a superseded predecessor is itself skipped (firewall)", () => {
    // A trips the firewall and is skipped; B names A as predecessor. With A never
    // admitted, B must be a CREATE in BOTH modes — not a phantom supersede in dry-run.
    const mk = (): ImportItem[] => [
      item({ ref: "A", body: "deploy key AKIAABCDEFGHIJKLMNOP", srcTag: "z-src:A", derivationKey: "z:A:1" }),
      item({ ref: "B", body: "Alice works at Globex", srcTag: "z-src:B", derivationKey: "z:B:1", supersedesTags: ["z-src:A"] }),
    ];
    const a = tempDbPath();
    const sa = new SQLiteRecallStore(a.path);
    const b = tempDbPath();
    const sb = new SQLiteRecallStore(b.path);
    try {
      const dry = admitImportItems(sa, "zep", mk(), { apply: false });
      const wet = admitImportItems(sb, "zep", mk(), { apply: true });
      assert.equal(dry.created, wet.created, "created parity");
      assert.equal(dry.superseded, wet.superseded, "superseded parity");
      assert.equal(dry.skipped, wet.skipped, "skipped parity");
      assert.equal(wet.created, 1, "B is a create — predecessor A was skipped");
      assert.equal(wet.superseded, 0, "no phantom supersede");
    } finally {
      sa.close();
      a.cleanup();
      sb.close();
      b.cleanup();
    }
  });
});

describe("import core — readImportFile", () => {
  function jsonFile(text: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "imp-"));
    const path = join(dir, "x.json");
    writeFileSync(path, text);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("parses JSON within the size cap", () => {
    const f = jsonFile(JSON.stringify({ ok: true }));
    try {
      assert.deepEqual(readImportFile(f.path, "test", 10_000), { ok: true });
    } finally {
      f.cleanup();
    }
  });

  it("throws 'too large' when the file exceeds the size cap (no OOM)", () => {
    const f = jsonFile(JSON.stringify({ some: "content here that exceeds four bytes" }));
    try {
      assert.throws(() => readImportFile(f.path, "test", 4), /too large/i);
    } finally {
      f.cleanup();
    }
  });

  it("throws clear errors on a missing file and on invalid JSON", () => {
    assert.throws(() => readImportFile("/no/such/import-file.json", "test"), /read|file/i);
    const f = jsonFile("{ not valid json");
    try {
      assert.throws(() => readImportFile(f.path, "test"), /json/i);
    } finally {
      f.cleanup();
    }
  });
});
