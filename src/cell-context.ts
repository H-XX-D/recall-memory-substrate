// Lazy expansion for an R4 context packet handle. Packets stay ID-first; exact
// cell content and field previews are pulled only when the caller expands one.
import { selectField } from "./resolve.js";
import type { Cell, NeighborLink, Store } from "./types.js";

export interface CellContext {
  cell: Cell;
  requestedField?: {
    path: string;
    value: unknown;
    preview: string;
  };
  footprint: {
    titleWords: number;
    summaryWords: number;
    bodyWords: number;
    serializedBytes: number;
    tagCount: number;
    sourceRefCount: number;
    outgoingEdges: number;
    incomingEdges: number;
    connectedCells: number;
  };
  incoming: NeighborLink[];
  outgoing: NeighborLink[];
  derivedFrom: string[]; // keys this cell was derived_from (outgoing provenance)
  derivations: string[]; // keys derived_from this cell (incoming provenance)
  expansionHandles: string[];
}

export function inspectCell(store: Store, handle: string): CellContext {
  const parsed = parseExpansionHandle(handle);
  const cell = resolveCell(store, parsed.target);
  if (!cell) throw new Error(`Unknown cell: ${parsed.target}`);
  const neighbors = store.neighbors(cell.key);
  const incoming = neighbors.filter((link) => link.direction === "in");
  const outgoing = neighbors.filter((link) => link.direction === "out");
  // derived_from is a provenance marker (weight 0, no score effect). Surface both
  // directions so a caller can trace where a cell came from and what came from it.
  const derivedFrom = outgoing.filter((l) => l.edge.relation === "derived_from").map((l) => l.cell.key);
  const derivations = incoming.filter((l) => l.edge.relation === "derived_from").map((l) => l.cell.key);
  const expansionHandles = [...new Set(neighbors.map((link) => link.cell.key))];
  const requestedValue = parsed.path ? selectField(cell, parsed.path) : undefined;
  return {
    cell,
    requestedField: parsed.path
      ? {
          path: parsed.path.join("."),
          value: requestedValue,
          preview: previewValue(requestedValue),
        }
      : undefined,
    footprint: {
      titleWords: countWords(cell.title),
      summaryWords: countWords(cell.summary ?? ""),
      bodyWords: countWords(cell.body),
      serializedBytes: Buffer.byteLength(JSON.stringify(cell), "utf8"),
      tagCount: countTags(cell),
      sourceRefCount: cell.sourceRefs.length,
      outgoingEdges: outgoing.length,
      incomingEdges: incoming.length,
      connectedCells: expansionHandles.length,
    },
    incoming,
    outgoing,
    derivedFrom,
    derivations,
    expansionHandles,
  };
}

// Resolve a cell reference the way an agent supplies it: a full key, an id
// prefix (>=4 hex), a handle, or a graph-qualified address (graph:uuid). This is
// the fix for the recall_cell id-format gap (927f3e06): the read path accepts
// every id form the CLI and peek accept, not only full graph:uuid addresses.
export function resolveCell(store: Store, ref: string): Cell | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  // graph-qualified address (graph:uuid): resolve on the part after the colon.
  const bare = r.includes(":") ? r.slice(r.indexOf(":") + 1).trim() : r;
  const exact = store.get(r) ?? store.get(bare);
  if (exact) return exact;
  const byHandle = store.getByHandle(r) ?? store.getByHandle(bare);
  if (byHandle) return byHandle;
  // id prefix: a unique hex prefix (>=4 chars) resolves; an ambiguous one errors.
  if (/^[a-f0-9]{4,}$/i.test(bare)) {
    const matches = store.all().filter((c) => c.key.startsWith(bare));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`ambiguous cell id prefix: ${bare} (${matches.length} matches)`);
    }
  }
  return undefined;
}

function parseExpansionHandle(value: string): { target: string; path?: string[] } {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("cell expansion handle is required");
  const [target, rawPath] = trimmed.split("#", 2);
  if (!target) throw new Error("cell expansion target is required");
  if (!rawPath) return { target };
  const path = rawPath.split(/[.-]/).filter(Boolean);
  if (path.length === 0) throw new Error("cell expansion field path is required");
  return { target, path };
}

function countTags(cell: Cell): number {
  return Object.values(cell.tags).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
}

function countWords(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}

function previewValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}
