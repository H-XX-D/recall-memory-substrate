import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { RecallStore } from "./store.js";
import type { RecallNode } from "./types.js";

export interface RecallStorageStats {
  databasePath?: string;
  databaseBytes?: number;
  cells: number;
  relations: number;
  hyperedges: number;
  rollbackEntries: number;
  averageCell: {
    serializedBytes: number;
    contentWords: number;
    tagCount: number;
    sourceRefs: number;
    evidenceLinks: number;
    directRelations: number;
  };
  maximumCell: {
    id: string | null;
    title: string | null;
    serializedBytes: number;
  };
  note: string;
}

export function storageStats(store: RecallStore, limit = 10_000): RecallStorageStats {
  const cells = store.listNodes(limit);
  const relations = store.listRelations(undefined, "both", limit * 4);
  const hyperedges = store.listHyperedges(limit);
  const rollback = store.listRollback(limit);
  const footprints = cells.map((node) => cellFootprint(node, relations.length));
  const max = footprints.reduce<typeof footprints[number] | null>((best, item) => {
    if (!best || item.serializedBytes > best.serializedBytes) {
      return item;
    }
    return best;
  }, null);
  const dbPath = storePath(store);
  const dbBytes = dbPath && existsSync(dbPath) ? statSync(dbPath).size : undefined;

  return {
    databasePath: dbPath,
    databaseBytes: dbBytes,
    cells: cells.length,
    relations: relations.length,
    hyperedges: hyperedges.length,
    rollbackEntries: rollback.length,
    averageCell: {
      serializedBytes: average(footprints.map((item) => item.serializedBytes)),
      contentWords: average(footprints.map((item) => item.contentWords)),
      tagCount: average(footprints.map((item) => item.tagCount)),
      sourceRefs: average(footprints.map((item) => item.sourceRefs)),
      evidenceLinks: average(footprints.map((item) => item.evidenceLinks)),
      directRelations: cells.length === 0 ? 0 : round(relations.length / cells.length)
    },
    maximumCell: {
      id: max?.id ?? null,
      title: max?.title ?? null,
      serializedBytes: max?.serializedBytes ?? 0
    },
    note: "Average cell size counts the serialized graph cell. SQLite page overhead, semantic vectors, rollback copies, and hyperedge membership add storage outside the cell body."
  };
}

function cellFootprint(node: RecallNode, relationCount: number): {
  id: string;
  title: string;
  serializedBytes: number;
  contentWords: number;
  tagCount: number;
  sourceRefs: number;
  evidenceLinks: number;
  relationCount: number;
} {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  const sourceRefs = stringArray(evidence.source_refs);
  const evidenceLinks = [
    ...stringArray(evidence.depends_on),
    ...stringArray(evidence.supports),
    ...stringArray(evidence.contradicts),
    ...stringArray(evidence.concerns)
  ];
  return {
    id: node.id,
    title: node.title,
    serializedBytes: Buffer.byteLength(JSON.stringify(node), "utf8"),
    contentWords: countWords([node.title, node.summary ?? "", node.body].join(" ")),
    tagCount: Object.values(node.tags).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0),
    sourceRefs: sourceRefs.length,
    evidenceLinks: evidenceLinks.length,
    relationCount
  };
}

function storePath(store: RecallStore): string | undefined {
  const value = (store as unknown as { path?: unknown }).path;
  return typeof value === "string" ? resolve(value) : undefined;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function countWords(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
