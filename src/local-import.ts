// local-import.ts: importGlobalToLocal, the MAL reconciliation of the legacy
// local-import.ts adapter. Pulls a project/topic-scoped subgraph out of a
// source Store (typically the home/global db) and lands it in a local Store
// through the shared importItems admission engine, then rehydrates any
// hyperedges whose members all landed. The source store is only ever read.
import { createHash } from "node:crypto";
import { decodeFederatedKey } from "./federated-store.js";
import { importCellKey, importItems, type ImportItem, type ImportSummary } from "./adapters.js";
import { subgraphCells } from "./subgraph.js";
import type { Cell, Hyperedge, HyperedgeMember, Store, WriteProposal } from "./types.js";

export const DEFAULT_SELECT_LIMIT = 500;
export const MAX_HYPEREDGES = 5000;

export interface LocalImportOptions {
  project?: string;
  topics?: string[];
  includeHyperedges?: boolean;
  apply?: boolean;
  limit?: number;
  now?: string;
}

export interface LocalImportSummary extends ImportSummary {
  hyperedgesReattached: number;
  hyperedgesPartial: number;
  selectionLimit: number;
  selectionTruncated: boolean;
}

export function importGlobalToLocal(source: Store, local: Store, opts: LocalImportOptions): LocalImportSummary {
  if (!opts.project && (!opts.topics || opts.topics.length === 0)) {
    throw new Error("import local needs a scope: pass --project <name> and/or --topics <a,b>");
  }

  const apply = opts.apply ?? false;
  const now = opts.now ?? new Date().toISOString();
  const includeHyperedges = opts.includeHyperedges ?? true;
  const cap = opts.limit ?? DEFAULT_SELECT_LIMIT;

  const fetched = subgraphCells(source, { project: opts.project, topics: opts.topics, limit: cap + 1 });
  const selectionTruncated = fetched.length > cap;
  const cells = fetched.slice(0, cap);

  // sourceKey -> decoded (federation-prefix-stripped) key, needed both for the
  // fingerprint/sourceTag stamping below and for hyperedge member remapping.
  const decodedKeyByCellKey = new Map<string, string>();
  const items: ImportItem[] = cells.map((cell) => {
    const decodedKey = decodeFederatedKey(cell.key).key;
    decodedKeyByCellKey.set(cell.key, decodedKey);
    return buildImportItem(cell, decodedKey, opts);
  });

  const summary = importItems(local, "global-import", items, { apply, now });

  const { hyperedgesReattached, hyperedgesPartial } = includeHyperedges
    ? rehydrateHyperedges(source, local, cells, decodedKeyByCellKey, summary, apply)
    : { hyperedgesReattached: 0, hyperedgesPartial: 0 };

  return {
    ...summary,
    hyperedgesReattached,
    hyperedgesPartial,
    selectionLimit: cap,
    selectionTruncated,
  };
}

function buildImportItem(cell: Cell, decodedKey: string, opts: LocalImportOptions): ImportItem {
  const sourceTag = `global-src:${sha12(decodedKey)}`;
  const fingerprint = `global-import:${sha12(decodedKey)}:${sha12(`${cell.title} ${cell.body}`)}`;
  return {
    ref: decodedKey,
    sourceTag,
    fingerprint,
    proposal: (priorKeys) => buildImportProposal(cell, decodedKey, { sourceTag, fingerprint, priorKeys, now: opts.now ?? new Date().toISOString(), project: opts.project }),
  };
}

function buildImportProposal(
  cell: Cell,
  decodedKey: string,
  opts: { sourceTag: string; fingerprint: string; priorKeys: string[]; now: string; project?: string },
): WriteProposal {
  return {
    kind: cell.kind,
    title: cell.title,
    body: cell.body,
    confidence: cell.scores.conf,
    summary: cell.summary,
    owner: cell.owner,
    topics: unique([...cell.tags.topics, "global-import"]),
    entities: unique([opts.sourceTag, ...cell.tags.entities]),
    sourceRefs: [`recall://cell/${decodedKey}`],
    edges: opts.priorKeys.map((target) => ({ relation: "supersedes", target })),
    project: opts.project ?? cell.scope.project,
    tenant: cell.scope.tenant,
    origin: "connector",
    verification: "checked",
    sensitivity: "private",
    stability: "stable",
    quality: ["imported-from-global"],
    props: {
      import: {
        source: "global-import",
        ref: decodedKey,
        sourceTag: opts.sourceTag,
        fingerprint: opts.fingerprint,
        importedAt: opts.now,
        createdAt: cell.createdAt,
      },
    },
  };
}

// Rehydrates hyperedges (dry-run too, as a prediction; writes only gated on
// apply). An edge reattaches only when every member landed locally. "Landed"
// means the import result for that member's fingerprint was created,
// superseded, or skipped-unchanged (an already-present, unchanged local cell).
// Its local key is always the deterministic import key: for created/superseded
// cells that key IS the cell's actual key (importItems admits at that key);
// for skipped-unchanged cells the key already exists locally at that same
// deterministic address, so the prediction is exact in dry-run too.
function rehydrateHyperedges(
  source: Store,
  local: Store,
  cells: Cell[],
  decodedKeyByCellKey: Map<string, string>,
  summary: ImportSummary,
  apply: boolean,
): { hyperedgesReattached: number; hyperedgesPartial: number } {
  // Map each selected cell's *source* key (bare, decoded) to the local key it
  // landed at, or undefined if it did not land (rejected / content-duplicate).
  const landedLocalKeyBySourceKey = new Map<string, string | undefined>();
  cells.forEach((cell, index) => {
    const decodedKey = decodedKeyByCellKey.get(cell.key)!;
    const resultItem = summary.items[index];
    const landed = resultItem?.action === "create" || resultItem?.action === "supersede" || resultItem?.reason === "unchanged";
    if (!landed) {
      landedLocalKeyBySourceKey.set(decodedKey, undefined);
      return;
    }
    const fingerprint = `global-import:${sha12(decodedKey)}:${sha12(`${cell.title} ${cell.body}`)}`;
    landedLocalKeyBySourceKey.set(decodedKey, importCellKey(fingerprint));
  });

  const seenEdgeIds = new Set<string>();
  const uniqueEdges: Hyperedge[] = [];
  for (const cell of cells) {
    if (uniqueEdges.length >= MAX_HYPEREDGES) break;
    const edges = source.hyperedgesForCell(cell.key);
    for (const edge of edges) {
      if (uniqueEdges.length >= MAX_HYPEREDGES) break;
      if (seenEdgeIds.has(edge.id)) continue;
      seenEdgeIds.add(edge.id);
      uniqueEdges.push(edge);
    }
  }

  let hyperedgesReattached = 0;
  let hyperedgesPartial = 0;
  for (const edge of uniqueEdges) {
    const remappedMembers: HyperedgeMember[] = [];
    let allLanded = true;
    for (const member of edge.members) {
      const decodedMemberKey = decodeFederatedKey(member.key).key;
      const localKey = landedLocalKeyBySourceKey.get(decodedMemberKey);
      if (!localKey) {
        allLanded = false;
        break;
      }
      remappedMembers.push({ ...member, key: localKey });
    }

    if (!allLanded) {
      hyperedgesPartial += 1;
      continue;
    }

    const localEdgeId = `he-local-${sha12(edge.id)}`;
    if (local.getHyperedge(localEdgeId)) {
      continue;
    }

    hyperedgesReattached += 1;
    if (apply) {
      local.putHyperedge({
        id: localEdgeId,
        kind: edge.kind,
        title: edge.title,
        members: remappedMembers,
        metadata: { ...edge.metadata, importedFromGlobalHyperedge: edge.id },
        createdAt: edge.createdAt,
      });
    }
  }

  return { hyperedgesReattached, hyperedgesPartial };
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}
