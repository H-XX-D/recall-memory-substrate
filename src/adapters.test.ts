import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportCellArchive,
  importAutoMemory,
  importCellArchive,
  importMem0,
  importZep,
  parseAutoMemoryFile,
  parseMem0Export,
} from "./adapters.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";

test("parseMem0Export accepts common envelopes and metadata categories", () => {
  const rows = parseMem0Export({
    memories: [
      { id: "m1", memory: "Keep the package dry-run safe.", metadata: { categories: ["release"] } },
      { id: "m2", content: "Second memory", categories: ["ops"] },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.content, "Keep the package dry-run safe.");
  assert.deepEqual(rows[0]?.categories, ["release"]);
  assert.deepEqual(rows[1]?.categories, ["ops"]);
});

test("importMem0 is dry-run by default, apply writes, and changed records supersede priors", () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = { memories: [{ id: "m1", memory: "Initial imported fact.", categories: ["release"] }] };
    const dry = importMem0(store, first, { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created, 1);
    assert.equal(store.stats().cells, 0);

    const applied = importMem0(store, first, { apply: true, now: "2026-06-26T12:00:00.000Z" });
    assert.equal(applied.created, 1);
    assert.equal(store.stats().activeCells, 1);

    const unchanged = importMem0(store, first, { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(unchanged.skipped, 1);
    assert.equal(unchanged.items[0]?.reason, "unchanged");

    const changed = { memories: [{ id: "m1", memory: "Updated imported fact.", categories: ["release"] }] };
    const superseded = importMem0(store, changed, { apply: true, now: "2026-06-26T12:02:00.000Z" });
    assert.equal(superseded.superseded, 1);
    assert.equal(superseded.items[0]?.action, "supersede");
    assert.equal(store.stats().cells, 2);
    assert.equal(store.active().length, 1);
    assert.equal(store.all().filter((cell) => cell.status === "superseded").length, 1);
  } finally {
    store.close();
  }
});

test("importZep reconstructs invalidated predecessor supersession", () => {
  const store = new SqliteStore(":memory:");
  try {
    const json = {
      facts: [
        {
          uuid: "z1",
          fact: "Alice works on Recall v5.",
          source_node: "Alice",
          name: "works_on",
          target_node: "Recall v5",
          valid_at: "2026-01-01T00:00:00.000Z",
          invalid_at: "2026-02-01T00:00:00.000Z",
        },
        {
          uuid: "z2",
          fact: "Alice works on Substrate.",
          source_node: "Alice",
          name: "works_on",
          target_node: "Substrate",
          valid_at: "2026-02-02T00:00:00.000Z",
        },
      ],
    };

    const dry = importZep(store, json, { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(dry.created, 1);
    assert.equal(dry.superseded, 1);

    const applied = importZep(store, json, { apply: true, now: "2026-06-26T12:00:00.000Z" });
    assert.equal(applied.created, 1);
    assert.equal(applied.superseded, 1);
    assert.equal(store.all().filter((cell) => cell.status === "superseded").length, 1);
  } finally {
    store.close();
  }
});

test("auto-memory parser and directory import handle frontmatter safely", () => {
  const parsed = parseAutoMemoryFile("---\nname: Architecture note\ntype: decision\nignored: x\n---\nUse the v5 graph.");
  assert.equal(parsed.name, "Architecture note");
  assert.equal(parsed.type, "decision");
  assert.equal(parsed.body, "Use the v5 graph.");

  const root = mkdtempSync(join(tmpdir(), "recall-v5-auto-memory-"));
  const store = new SqliteStore(":memory:");
  try {
    const memoryDir = join(root, "demo", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "---\nname: Demo note\ntype: project\n---\nProject memory.");

    const dry = importAutoMemory(store, root, { now: "2026-06-26T12:00:00.000Z" });
    assert.equal(dry.created, 1);
    assert.equal(dry.dryRun, true);

    const applied = importAutoMemory(store, root, { apply: true, now: "2026-06-26T12:00:00.000Z" });
    assert.equal(applied.created, 1);
    assert.equal(store.active()[0]?.kind, "dec");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cell archives round-trip exact cells and edges", () => {
  const source = new SqliteStore(":memory:");
  const target = new SqliteStore(":memory:");
  try {
    const a = buildCell({ kind: "obs", title: "A", body: "a", confidence: 0.7 }, { key: "aaaa" });
    const b = buildCell(
      { kind: "obs", title: "B", body: "b", confidence: 0.8, edges: [{ relation: "supports", target: "aaaa" }] },
      { key: "bbbb" },
    );
    source.put(a);
    source.put(b);

    const archive = exportCellArchive(source, "2026-06-26T12:00:00.000Z");
    assert.equal(archive.schemaVersion, "recall.cells.export.v1");
    assert.equal(archive.cells.length, 2);

    const dry = importCellArchive(target, archive);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.imported, 2);
    assert.equal(target.stats().cells, 0);

    const applied = importCellArchive(target, archive, { apply: true });
    assert.equal(applied.imported, 2);
    assert.equal(target.get("bbbb")?.edgesOut[0]?.target, "aaaa");
  } finally {
    source.close();
    target.close();
  }
});
