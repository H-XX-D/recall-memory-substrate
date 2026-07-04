import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PRIOR_VERSIONS,
  exportCellArchive,
  importAutoMemory,
  importCellArchive,
  importCellKey,
  importedRecordToItem,
  importItems,
  importMem0,
  importZep,
  parseAutoMemoryFile,
  parseMem0Export,
} from "./adapters.js";
import { buildCell } from "./build.js";
import { SqliteStore } from "./store.js";
import { subgraphCells } from "./subgraph.js";

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
    assert.equal(store.stats().cells, 1);

    const unchangedAgain = importMem0(store, first, { apply: true, now: "2026-06-26T12:01:30.000Z" });
    assert.equal(unchangedAgain.skipped, 1);
    assert.equal(unchangedAgain.items[0]?.reason, "unchanged");
    assert.equal(store.stats().cells, 1);

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

test("importing the same mem0 export twice creates once then skips all as unchanged with store counts unchanged", () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = { memories: [{ id: "m1", memory: "Twice-imported fact.", categories: ["release"] }] };
    const applied = importMem0(store, first, { apply: true, now: "2026-06-26T12:00:00.000Z" });
    assert.equal(applied.created, 1);
    assert.equal(store.stats().cells, 1);

    const repeatOne = importMem0(store, first, { apply: true, now: "2026-06-26T12:05:00.000Z" });
    assert.equal(repeatOne.skipped, 1);
    assert.equal(repeatOne.created, 0);
    assert.equal(repeatOne.items[0]?.reason, "unchanged");
    assert.equal(store.stats().cells, 1);

    const repeatTwo = importMem0(store, first, { apply: true, now: "2026-06-26T12:06:00.000Z" });
    assert.equal(repeatTwo.skipped, 1);
    assert.equal(repeatTwo.created, 0);
    assert.equal(repeatTwo.items[0]?.reason, "unchanged");
    assert.equal(store.stats().cells, 1);
  } finally {
    store.close();
  }
});

test("a pre-0.9 cell with a random key but a matching props.import.fingerprint still dedups", () => {
  const store = new SqliteStore(":memory:");
  try {
    const item = importedRecordToItem(
      {
        ref: "legacy-1",
        source: "mem0",
        title: "Legacy fact",
        body: "Legacy fact body.",
      },
      "2026-06-26T12:00:00.000Z",
    );
    const proposal = item.proposal([]);
    const legacyCell = buildCell(
      { ...proposal, confidence: proposal.confidence },
      { key: "random-legacy-key", now: "2026-06-26T12:00:00.000Z" },
    );
    store.put(legacyCell);
    assert.equal(store.stats().cells, 1);

    const summary = importItems(store, "mem0", [item], { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.created, 0);
    assert.equal(summary.items[0]?.reason, "unchanged");
    assert.equal(store.stats().cells, 1);
  } finally {
    store.close();
  }
});

test("a same-batch duplicate (identical record listed twice in one export) skips identically in apply and dry-run", () => {
  const record = {
    ref: "dup-1",
    source: "mem0",
    title: "Duplicate fact",
    body: "Same record appears twice in one export.",
  };
  const now = "2026-06-26T12:00:00.000Z";
  // Two ImportItems built from the identical record share the same
  // fingerprint. byFingerprint is a pre-loop snapshot of the store, so it
  // cannot see the first item's cell, and dry-run never writes a cell for
  // probe 1 (store.get(importCellKey)) to find either. The in-batch
  // fingerprintsThisBatch set is what catches the second item in both
  // modes, so apply and dry-run must report the same create+skip counts.
  const item1 = importedRecordToItem(record, now);
  const item2 = importedRecordToItem(record, now);
  assert.equal(item1.fingerprint, item2.fingerprint);

  const dryStore = new SqliteStore(":memory:");
  try {
    const dry = importItems(dryStore, "mem0", [item1, item2], { apply: false, now });
    assert.equal(dry.created, 1);
    assert.equal(dry.skipped, 1);
    assert.equal(dry.items[0]?.action, "create");
    assert.equal(dry.items[1]?.action, "skip");
    assert.equal(dry.items[1]?.reason, "unchanged");
    assert.equal(dryStore.stats().cells, 0);
  } finally {
    dryStore.close();
  }

  const applyStore = new SqliteStore(":memory:");
  try {
    const applied = importItems(applyStore, "mem0", [item1, item2], { apply: true, now });
    assert.equal(applied.created, 1);
    assert.equal(applied.skipped, 1);
    assert.equal(applied.items[0]?.action, "create");
    assert.equal(applied.items[1]?.action, "skip");
    assert.equal(applied.items[1]?.reason, "unchanged");
    assert.equal(applyStore.stats().cells, 1);
  } finally {
    applyStore.close();
  }
});

test("probe 1 (deterministic import key) alone dedups a cell whose fingerprint prop is gone", () => {
  const store = new SqliteStore(":memory:");
  try {
    const item = importedRecordToItem(
      {
        ref: "probe-only-1",
        source: "mem0",
        title: "Probe only fact",
        body: "Only the key probe should catch this one.",
      },
      "2026-06-26T12:00:00.000Z",
    );
    const key = importCellKey(item.fingerprint);
    const proposal = item.proposal([]);
    // Build a cell at the deterministic import key but strip props.import
    // entirely, so byFingerprint (which reads props.import.fingerprint) has
    // nothing to index for this cell. Only probe 1's store.get(key) lookup
    // can find it.
    const { import: _import, ...propsWithoutImport } = proposal.props as Record<string, unknown>;
    const seeded = buildCell(
      { ...proposal, props: propsWithoutImport },
      { key, now: "2026-06-26T12:00:00.000Z" },
    );
    store.put(seeded);
    assert.equal(store.get(key)?.props.import, undefined);
    assert.equal(store.stats().cells, 1);

    const summary = importItems(store, "mem0", [item], { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.created, 0);
    assert.equal(summary.items[0]?.reason, "unchanged");
    assert.equal(store.stats().cells, 1);
  } finally {
    store.close();
  }
});

test("the created cell's key equals importCellKey(fingerprint)", () => {
  const store = new SqliteStore(":memory:");
  try {
    const item = importedRecordToItem(
      {
        ref: "m-key-1",
        source: "mem0",
        title: "Keyed fact",
        body: "Body for keyed fact.",
      },
      "2026-06-26T12:00:00.000Z",
    );
    const summary = importItems(store, "mem0", [item], { apply: true, now: "2026-06-26T12:00:00.000Z" });
    assert.equal(summary.created, 1);
    assert.equal(summary.items[0]?.cellKey, importCellKey(item.fingerprint));
    assert.ok(store.get(importCellKey(item.fingerprint)));
  } finally {
    store.close();
  }
});

test("re-importing an old export after its record's cell was superseded skips it as unchanged and does not demote the newer cell", () => {
  const store = new SqliteStore(":memory:");
  try {
    const v1 = { memories: [{ id: "m1", memory: "Version one of the fact.", categories: ["release"] }] };
    importMem0(store, v1, { apply: true, now: "2026-06-26T12:00:00.000Z" });

    const v2 = { memories: [{ id: "m1", memory: "Version two of the fact.", categories: ["release"] }] };
    const v2Result = importMem0(store, v2, { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(v2Result.superseded, 1);
    const v2Key = v2Result.items[0]?.cellKey;
    assert.ok(v2Key);
    assert.equal(store.get(v2Key!)?.status, "active");

    const reimportV1 = importMem0(store, v1, { apply: true, now: "2026-06-26T12:02:00.000Z" });
    assert.equal(reimportV1.skipped, 1);
    assert.equal(reimportV1.items[0]?.reason, "unchanged");
    assert.equal(store.get(v2Key!)?.status, "active");
    assert.equal(store.active().length, 1);
  } finally {
    store.close();
  }
});

test("importing v1 then v2 then v3 of a record yields exactly one supersedes target on each import", () => {
  const store = new SqliteStore(":memory:");
  try {
    const v1 = { memories: [{ id: "m1", memory: "Version one of the fact.", categories: ["release"] }] };
    importMem0(store, v1, { apply: true, now: "2026-06-26T12:00:00.000Z" });

    const v2 = { memories: [{ id: "m1", memory: "Version two of the fact.", categories: ["release"] }] };
    const v2Result = importMem0(store, v2, { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(v2Result.superseded, 1);
    assert.equal(v2Result.items[0]?.supersedes?.length, 1);

    const v3 = { memories: [{ id: "m1", memory: "Version three of the fact.", categories: ["release"] }] };
    const v3Result = importMem0(store, v3, { apply: true, now: "2026-06-26T12:02:00.000Z" });
    assert.equal(v3Result.superseded, 1);
    assert.equal(v3Result.items[0]?.supersedes?.length, 1);
    assert.equal(v3Result.items[0]?.supersedes?.[0], v2Result.items[0]?.cellKey);
  } finally {
    store.close();
  }
});

test("the batch-local prior lookup caps the deduped prior list at MAX_PRIOR_VERSIONS", () => {
  const store = new SqliteStore(":memory:");
  try {
    const sharedEntity = "capped-entity-tag";
    for (let i = 0; i < MAX_PRIOR_VERSIONS + 5; i += 1) {
      const cell = buildCell(
        { kind: "obs", title: `Prior ${i}`, body: `Prior body ${i}`, confidence: 0.6, entities: [sharedEntity] },
        { key: `prior-${i}`, now: "2026-06-26T12:00:00.000Z" },
      );
      store.put(cell);
    }
    assert.equal(store.active().length, MAX_PRIOR_VERSIONS + 5);

    const item = importedRecordToItem(
      {
        ref: "capped-1",
        source: "mem0",
        title: "Capped fact",
        body: "New fact that supersedes a huge prior set.",
        entities: [sharedEntity],
        sourceTag: sharedEntity,
      },
      "2026-06-26T12:01:00.000Z",
    );
    const summary = importItems(store, "mem0", [item], { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(summary.items[0]?.action, "supersede");
    assert.ok((summary.items[0]?.supersedes?.length ?? 0) <= MAX_PRIOR_VERSIONS);
  } finally {
    store.close();
  }
});

test("an item's priorKeys union a pre-batch active cell (via byEntity) with a same-batch admitted cell (via admittedThisBatch)", () => {
  const now = "2026-06-26T12:00:00.000Z";
  const buildBatch = () => {
    const itemX = importedRecordToItem(
      { ref: "x-1", source: "mem0", title: "Pre-batch fact", body: "Fact X exists before the batch.", sourceTag: "TX" },
      now,
    );
    const itemA = importedRecordToItem(
      { ref: "a-1", source: "mem0", title: "Fresh batch fact", body: "Fact A is fresh in this batch.", sourceTag: "TA" },
      now,
    );
    const itemB = importedRecordToItem(
      {
        ref: "b-1",
        source: "mem0",
        title: "Combining fact",
        body: "Fact B supersedes both the pre-batch cell and the same-batch cell.",
        sourceTag: "TB",
        supersedesTags: ["TX", "TA"],
      },
      now,
    );
    return { itemX, itemA, itemB };
  };

  const applyStore = new SqliteStore(":memory:");
  try {
    const { itemX } = buildBatch();
    const seed = importItems(applyStore, "mem0", [itemX], { apply: true, now });
    assert.equal(seed.created, 1);
    const xKey = seed.items[0]?.cellKey;
    assert.ok(xKey);

    const { itemA, itemB } = buildBatch();
    const batch = importItems(applyStore, "mem0", [itemA, itemB], { apply: true, now });
    assert.equal(batch.items[0]?.action, "create");
    const aKey = batch.items[0]?.cellKey;
    assert.ok(aKey);

    assert.equal(batch.items[1]?.action, "supersede");
    const supersedes = batch.items[1]?.supersedes ?? [];
    assert.equal(supersedes.length, 2);
    assert.ok(supersedes.includes(xKey!));
    assert.ok(supersedes.includes(aKey!));

    assert.equal(applyStore.get(xKey!)?.status, "superseded");
    assert.equal(applyStore.get(aKey!)?.status, "superseded");
  } finally {
    applyStore.close();
  }

  const dryStore = new SqliteStore(":memory:");
  try {
    const { itemX } = buildBatch();
    importItems(dryStore, "mem0", [itemX], { apply: true, now });

    const { itemA, itemB } = buildBatch();
    const dryBatch = importItems(dryStore, "mem0", [itemA, itemB], { apply: false, now });
    assert.equal(dryBatch.items[0]?.action, "create");
    assert.equal(dryBatch.items[1]?.action, "supersede");
    assert.equal(dryBatch.created, 1);
    assert.equal(dryBatch.superseded, 1);
  } finally {
    dryStore.close();
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

test("importZep stamps lifecycle expired/active from invalid_at, findable via subgraphCells", () => {
  const store = new SqliteStore(":memory:");
  try {
    const json = {
      facts: [
        {
          uuid: "z-expired",
          fact: "Alice worked on Recall v4.",
          source_node: "Alice",
          name: "worked_on",
          target_node: "Recall v4",
          valid_at: "2026-01-01T00:00:00.000Z",
          invalid_at: "2026-02-01T00:00:00.000Z",
        },
        {
          uuid: "z-active",
          fact: "Bob works on Recall v5.",
          source_node: "Bob",
          name: "works_on",
          target_node: "Recall v5",
          valid_at: "2026-02-02T00:00:00.000Z",
        },
      ],
    };

    importZep(store, json, { apply: true, now: "2026-06-26T12:00:00.000Z" });

    const cells = store.all();
    const expiredCell = cells.find((c) => c.sourceRefs.some((r) => r.includes("z-expired")));
    const activeCell = cells.find((c) => c.sourceRefs.some((r) => r.includes("z-active")));
    assert.deepEqual(expiredCell?.tags.lifecycle, ["expired"]);
    assert.deepEqual(activeCell?.tags.lifecycle, ["active"]);

    const found = subgraphCells(store, { lifecycle: ["expired"] });
    assert.ok(found.some((c) => c.key === expiredCell?.key));
    assert.ok(!found.some((c) => c.key === activeCell?.key));
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

test("a second source importing identical kind+title+body reports content-duplicate skip in both dry-run and apply, with matching counts", () => {
  const now = "2026-06-26T12:00:00.000Z";
  const first = importedRecordToItem(
    { ref: "src-a-1", source: "mem0", title: "Shared Fact", body: "Exact same body across sources." },
    now,
  );
  const second = importedRecordToItem(
    { ref: "src-b-1", source: "zep", title: "Shared Fact", body: "Exact same body across sources." },
    now,
  );
  assert.notEqual(first.fingerprint, second.fingerprint);

  const applyStore = new SqliteStore(":memory:");
  try {
    const seed = importItems(applyStore, "mem0", [first], { apply: true, now });
    assert.equal(seed.created, 1);
    const firstKey = seed.items[0]?.cellKey;
    assert.ok(firstKey);

    const applied = importItems(applyStore, "zep", [second], { apply: true, now });
    assert.equal(applied.created, 0);
    assert.equal(applied.superseded, 0);
    assert.equal(applied.skipped, 1);
    assert.equal(applied.items[0]?.action, "skip");
    assert.equal(applied.items[0]?.reason, `content-duplicate of ${firstKey}`);
    assert.equal(applyStore.stats().cells, 1);
    assert.equal(applyStore.get(firstKey!)?.status, "active");
  } finally {
    applyStore.close();
  }

  const dryStore = new SqliteStore(":memory:");
  try {
    const seed = importItems(dryStore, "mem0", [first], { apply: true, now });
    const firstKey = seed.items[0]?.cellKey;
    assert.ok(firstKey);

    const dry = importItems(dryStore, "zep", [second], { apply: false, now });
    assert.equal(dry.created, 0);
    assert.equal(dry.superseded, 0);
    assert.equal(dry.skipped, 1);
    assert.equal(dry.items[0]?.action, "skip");
    assert.equal(dry.items[0]?.reason, `content-duplicate of ${firstKey}`);
  } finally {
    dryStore.close();
  }
});

test("a content-duplicate that also carries supersedesTags leaves the priors active and reports skip, not supersede", () => {
  const now = "2026-06-26T12:00:00.000Z";
  const store = new SqliteStore(":memory:");
  try {
    const prior = importedRecordToItem(
      { ref: "prior-1", source: "mem0", title: "Prior Fact", body: "Prior fact body.", sourceTag: "PRIOR" },
      now,
    );
    const seed = importItems(store, "mem0", [prior], { apply: true, now });
    const priorKey = seed.items[0]?.cellKey;
    assert.ok(priorKey);

    const dup = importedRecordToItem(
      { ref: "dup-1", source: "mem0", title: "Prior Fact", body: "Prior fact body.", supersedesTags: ["PRIOR"] },
      now,
    );
    const result = importItems(store, "mem0", [dup], { apply: true, now });
    assert.equal(result.items[0]?.action, "skip");
    assert.equal(result.items[0]?.reason, `content-duplicate of ${priorKey}`);
    assert.equal(result.superseded, 0);
    assert.equal(store.get(priorKey!)?.status, "active");
    assert.equal(store.active().length, 1);
  } finally {
    store.close();
  }
});

test("re-running an import whose record is a content-duplicate is stable across repeated runs (no flapping)", () => {
  const now = "2026-06-26T12:00:00.000Z";
  const store = new SqliteStore(":memory:");
  try {
    const first = importedRecordToItem(
      { ref: "stable-a", source: "mem0", title: "Stable Fact", body: "Stable body." },
      now,
    );
    const seed = importItems(store, "mem0", [first], { apply: true, now });
    const firstKey = seed.items[0]?.cellKey;
    assert.ok(firstKey);

    const second = importedRecordToItem(
      { ref: "stable-b", source: "zep", title: "Stable Fact", body: "Stable body." },
      now,
    );

    const run1 = importItems(store, "zep", [second], { apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(run1.items[0]?.action, "skip");
    assert.equal(run1.items[0]?.reason, `content-duplicate of ${firstKey}`);
    assert.equal(store.stats().cells, 1);

    const run2 = importItems(store, "zep", [second], { apply: true, now: "2026-06-26T12:02:00.000Z" });
    assert.equal(run2.items[0]?.action, "skip");
    assert.equal(run2.items[0]?.reason, `content-duplicate of ${firstKey}`);
    assert.equal(store.stats().cells, 1);

    const run3 = importItems(store, "zep", [second], { apply: true, now: "2026-06-26T12:03:00.000Z" });
    assert.equal(run3.items[0]?.action, "skip");
    assert.equal(run3.items[0]?.reason, `content-duplicate of ${firstKey}`);
    assert.equal(store.stats().cells, 1);
  } finally {
    store.close();
  }
});
