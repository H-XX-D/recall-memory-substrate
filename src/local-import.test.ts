import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildCell } from "./build.js";
import { importCellKey } from "./adapters.js";
import { SqliteStore } from "./store.js";
import { subgraphCells } from "./subgraph.js";
import { importGlobalToLocal, DEFAULT_SELECT_LIMIT, MAX_HYPEREDGES } from "./local-import.js";
import type { Cell, Kind, WriteProposal } from "./types.js";

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function seedCell(
  store: SqliteStore,
  kind: Kind,
  title: string,
  body: string,
  opts: {
    project?: string;
    tenant?: string;
    conf?: number;
    topics?: string[];
    entities?: string[];
    now?: string;
    key?: string;
  } = {},
): Cell {
  const proposal: WriteProposal = {
    kind,
    title,
    body,
    confidence: opts.conf ?? 0.7,
    project: opts.project ?? "demo",
    tenant: opts.tenant ?? "local",
    topics: opts.topics ?? ["alpha"],
    entities: opts.entities ?? [],
  };
  const cell = buildCell(proposal, { key: opts.key, now: opts.now ?? "2026-06-26T12:00:00.000Z" });
  store.put(cell);
  return cell;
}

test("importGlobalToLocal throws when neither project nor topics scope is given", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    assert.throws(
      () => importGlobalToLocal(source, local, {}),
      /import local needs a scope: pass --project <name> and\/or --topics <a,b>/,
    );
  } finally {
    source.close();
    local.close();
  }
});

test("importing by project copies cells with sourceTag/quality/topics stamped and confidence preserved", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    seedCell(source, "obs", "Global fact one", "Body of the global fact.", {
      project: "demo",
      conf: 0.83,
      topics: ["release"],
      entities: ["svc-a"],
    });

    const summary = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(summary.created, 1);
    assert.equal(local.stats().cells, 1);

    const [cell] = local.all();
    assert.ok(cell);
    assert.equal(cell!.scores.conf, 0.83);
    assert.ok(cell!.tags.topics.includes("release"));
    assert.ok(cell!.tags.topics.includes("global-import"));
    assert.ok(cell!.tags.quality?.includes("imported-from-global"));
    assert.ok(cell!.tags.entities.includes("svc-a"));
    const importProps = cell!.props.import as Record<string, unknown>;
    assert.equal(importProps.source, "global-import");
    assert.match(importProps.sourceTag as string, /^global-src:/);
    assert.ok(typeof importProps.fingerprint === "string");
  } finally {
    source.close();
    local.close();
  }
});

test("unscoped call throws before touching either store", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    seedCell(source, "obs", "Untouched", "Body.");
    assert.throws(() => importGlobalToLocal(source, local, { topics: undefined, project: undefined }));
    assert.equal(local.stats().cells, 0);
  } finally {
    source.close();
    local.close();
  }
});

test("re-import skips all as unchanged", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    seedCell(source, "obs", "Stable fact", "Body of the stable fact.", { project: "demo" });
    const first = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(first.created, 1);

    const second = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(second.created, 0);
    assert.equal(second.superseded, 0);
    assert.equal(second.skipped, 1);
    assert.equal(local.stats().cells, 1);
  } finally {
    source.close();
    local.close();
  }
});

test("a changed source cell (title-only change included) supersedes the local prior", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    const original = seedCell(source, "obs", "Original title", "Same body forever.", {
      project: "demo",
      now: "2026-06-26T12:00:00.000Z",
    });
    const first = importGlobalToLocal(source, local, { project: "demo", apply: true, now: "2026-06-26T12:01:00.000Z" });
    assert.equal(first.created, 1);

    // Title-only edit on the source cell: body unchanged, title changed.
    const retitled: Cell = { ...original, title: "Retitled", updatedAt: "2026-06-26T13:00:00.000Z" };
    source.put(retitled);

    const second = importGlobalToLocal(source, local, { project: "demo", apply: true, now: "2026-06-26T13:01:00.000Z" });
    assert.equal(second.superseded, 1);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 0);

    const activeCells = local.active();
    assert.equal(activeCells.length, 1);
    assert.equal(activeCells[0]?.title, "Retitled");
  } finally {
    source.close();
    local.close();
  }
});

test("hyperedge whose members all land reattaches with remapped member keys and preserved roles", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    const a = seedCell(source, "obs", "Member A", "Body A.", { project: "demo" });
    const b = seedCell(source, "obs", "Member B", "Body B.", { project: "demo" });
    source.putHyperedge({
      id: "edge-1",
      kind: "cluster",
      title: "A and B",
      members: [
        { key: a.key, role: "lead", ordinal: 0, weight: 1 },
        { key: b.key, role: "support", ordinal: 1 },
      ],
      metadata: { note: "original" },
      createdAt: "2026-06-26T12:00:00.000Z",
    });

    const summary = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(summary.created, 2);
    assert.equal(summary.hyperedgesReattached, 1);
    assert.equal(summary.hyperedgesPartial, 0);

    const localEdgeId = `he-local-${sha12("edge-1")}`;
    const localEdge = local.getHyperedge(localEdgeId);
    assert.ok(localEdge);
    assert.equal(localEdge!.members.length, 2);
    const localA = local.get(importCellKey(`global-import:${sha12(a.key)}:${sha12(`${a.title} ${a.body}`)}`));
    const localB = local.get(importCellKey(`global-import:${sha12(b.key)}:${sha12(`${b.title} ${b.body}`)}`));
    assert.ok(localA);
    assert.ok(localB);
    const leadMember = localEdge!.members.find((m) => m.role === "lead");
    const supportMember = localEdge!.members.find((m) => m.role === "support");
    assert.equal(leadMember?.key, localA!.key);
    assert.equal(leadMember?.weight, 1);
    assert.equal(supportMember?.key, localB!.key);
    assert.equal(localEdge!.metadata.importedFromGlobalHyperedge, "edge-1");
  } finally {
    source.close();
    local.close();
  }
});

test("hyperedge with a member outside the selection counts partial and is not written", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    const inScope = seedCell(source, "obs", "In scope", "In scope body.", { project: "demo" });
    const outOfScope = seedCell(source, "obs", "Out of scope", "Out of scope body.", { project: "other" });
    source.putHyperedge({
      id: "edge-2",
      kind: "cluster",
      title: "mixed scope",
      members: [
        { key: inScope.key, role: "member", ordinal: 0 },
        { key: outOfScope.key, role: "member", ordinal: 1 },
      ],
      metadata: {},
      createdAt: "2026-06-26T12:00:00.000Z",
    });

    const summary = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(summary.created, 1);
    assert.equal(summary.hyperedgesReattached, 0);
    assert.equal(summary.hyperedgesPartial, 1);
    assert.equal(local.listHyperedges(10).length, 0);
  } finally {
    source.close();
    local.close();
  }
});

test("dry-run counts (including reattach counts) equal apply counts", () => {
  const source = new SqliteStore(":memory:");
  const local1 = new SqliteStore(":memory:");
  const local2 = new SqliteStore(":memory:");
  try {
    const a = seedCell(source, "obs", "Member A", "Body A.", { project: "demo" });
    const b = seedCell(source, "obs", "Member B", "Body B.", { project: "demo" });
    source.putHyperedge({
      id: "edge-3",
      kind: "cluster",
      title: "A and B again",
      members: [
        { key: a.key, role: "member", ordinal: 0 },
        { key: b.key, role: "member", ordinal: 1 },
      ],
      metadata: {},
      createdAt: "2026-06-26T12:00:00.000Z",
    });

    const dry = importGlobalToLocal(source, local1, { project: "demo", apply: false });
    const applied = importGlobalToLocal(source, local2, { project: "demo", apply: true });

    assert.equal(dry.created, applied.created);
    assert.equal(dry.superseded, applied.superseded);
    assert.equal(dry.skipped, applied.skipped);
    assert.equal(dry.hyperedgesReattached, applied.hyperedgesReattached);
    assert.equal(dry.hyperedgesPartial, applied.hyperedgesPartial);
    assert.equal(local1.stats().cells, 0);
    assert.equal(local2.stats().cells, 2);
  } finally {
    source.close();
    local1.close();
    local2.close();
  }
});

test("selectionTruncated flips when the cap is exceeded", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    for (let i = 0; i < 5; i++) {
      seedCell(source, "obs", `Fact ${i}`, `Body ${i}.`, {
        project: "demo",
        now: `2026-06-26T12:0${i}:00.000Z`,
      });
    }

    const capped = importGlobalToLocal(source, local, { project: "demo", limit: 3, apply: false });
    assert.equal(capped.selectionTruncated, true);
    assert.equal(capped.selectionLimit, 3);
    assert.equal(capped.items.length, 3);

    const local2 = new SqliteStore(":memory:");
    try {
      const uncapped = importGlobalToLocal(source, local2, { project: "demo", limit: 10, apply: false });
      assert.equal(uncapped.selectionTruncated, false);
      assert.equal(uncapped.items.length, 5);
    } finally {
      local2.close();
    }
  } finally {
    source.close();
    local.close();
  }
});

test("topics-only scope selects via subgraphCells semantics (AND across topics)", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    seedCell(source, "obs", "Matches both topics", "Body.", {
      project: "demo",
      topics: ["alpha", "beta"],
    });
    seedCell(source, "obs", "Matches only alpha", "Body.", {
      project: "demo",
      topics: ["alpha"],
    });

    const summary = importGlobalToLocal(source, local, { topics: ["alpha", "beta"], apply: true });
    assert.equal(summary.created, 1);
    const [cell] = local.all();
    assert.equal(cell?.title, "Matches both topics");
  } finally {
    source.close();
    local.close();
  }
});

test("includeHyperedges: false skips hyperedge rehydration entirely", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    const a = seedCell(source, "obs", "Member A", "Body A.", { project: "demo" });
    const b = seedCell(source, "obs", "Member B", "Body B.", { project: "demo" });
    source.putHyperedge({
      id: "edge-4",
      kind: "cluster",
      title: "no rehydrate",
      members: [
        { key: a.key, role: "member", ordinal: 0 },
        { key: b.key, role: "member", ordinal: 1 },
      ],
      metadata: {},
      createdAt: "2026-06-26T12:00:00.000Z",
    });

    const summary = importGlobalToLocal(source, local, { project: "demo", includeHyperedges: false, apply: true });
    assert.equal(summary.hyperedgesReattached, 0);
    assert.equal(summary.hyperedgesPartial, 0);
    assert.equal(local.listHyperedges(10).length, 0);
  } finally {
    source.close();
    local.close();
  }
});

test("re-importing a hyperedge a second time does not duplicate it (already-present local edge id skips)", () => {
  const source = new SqliteStore(":memory:");
  const local = new SqliteStore(":memory:");
  try {
    const a = seedCell(source, "obs", "Member A", "Body A.", { project: "demo" });
    const b = seedCell(source, "obs", "Member B", "Body B.", { project: "demo" });
    source.putHyperedge({
      id: "edge-5",
      kind: "cluster",
      title: "reimport edge",
      members: [
        { key: a.key, role: "member", ordinal: 0 },
        { key: b.key, role: "member", ordinal: 1 },
      ],
      metadata: {},
      createdAt: "2026-06-26T12:00:00.000Z",
    });

    const first = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(first.hyperedgesReattached, 1);
    assert.equal(local.listHyperedges(10).length, 1);

    const second = importGlobalToLocal(source, local, { project: "demo", apply: true });
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 2);
    assert.equal(local.listHyperedges(10).length, 1);
  } finally {
    source.close();
    local.close();
  }
});

test("default selection limit and MAX_HYPEREDGES constants are exported with the brief's values", () => {
  assert.equal(DEFAULT_SELECT_LIMIT, 500);
  assert.equal(MAX_HYPEREDGES, 5000);
});
