// MCP-layer response compaction. The core read functions (store.search,
// store.semanticSearch, store.subgraph, inspectCell) stay full-fidelity because
// the CLI and the context-compiler depend on full nodes. These projectors run
// only in the MCP serialization layer so default tool responses fit a token
// budget; pass compact:false (or full:true) to get the raw payload.

import type { RecallNode } from "../core/types.js";
import type { SearchHit } from "../core/retrieval.js";
import type { SemanticHit } from "../core/semantic.js";
import type { CellContext } from "../core/cell-context.js";

const EXCERPT_CHARS = 180;

export interface CompactNode {
  id: string;
  cellAddress: string;
  kind: string;
  title: string;
  effectiveConfidence?: number;
  challenged?: boolean;
  excerpt: string;
}

export function excerpt(node: RecallNode): string {
  const text = node.summary ?? node.body ?? "";
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}...` : text;
}

export function compactNode(
  node: RecallNode & { effectiveConfidence?: number; challenged?: boolean },
): CompactNode {
  const out: CompactNode = {
    id: node.id,
    cellAddress: node.cellAddress,
    kind: node.kind,
    title: node.title,
    excerpt: excerpt(node),
  };
  if (typeof node.effectiveConfidence === "number") out.effectiveConfidence = node.effectiveConfidence;
  if (typeof node.challenged === "boolean") out.challenged = node.challenged;
  return out;
}

export function compactHit(hit: SearchHit): CompactNode {
  return compactNode(hit);
}

export function compactSemanticHit(hit: SemanticHit<RecallNode>): { score: number; item: CompactNode } {
  return { score: hit.score, item: compactNode(hit.item) };
}

export function compactCell(cell: CellContext): unknown {
  return {
    node: compactNode(cell.node),
    footprint: cell.footprint,
    evidence: cell.evidence,
    relationCounts: { incoming: cell.incoming.length, outgoing: cell.outgoing.length },
    connectedCells: cell.connectedCells.map((n) => ({ id: n.id, kind: n.kind, title: n.title })),
    hyperedgeCount: cell.hyperedges.length,
    rollbackEntryCount: cell.rollbackEntries.length,
    ...(cell.requestedField ? { requestedField: cell.requestedField } : {}),
  };
}

// The admission receipt's bloat is rollbackEntries[], each echoing the full
// inserted node. Keep the node (the useful confirmation: id, kind, stored
// confidence) but collapse relations and rollback entries to counts.
export function compactReceipt(result: unknown): unknown {
  const r = result as Record<string, any>;
  if (!r || typeof r !== "object") return result;
  return {
    accepted: r.accepted,
    ...(r.node ? { node: r.node } : {}),
    relationCount: Array.isArray(r.relations) ? r.relations.length : 0,
    rollbackEntryCount: Array.isArray(r.rollbackEntries) ? r.rollbackEntries.length : 0,
    ...(r.issues ? { issues: r.issues } : {}),
    ...(r.warnings ? { warnings: r.warnings } : {}),
    ...(r.attenuations ? { attenuations: r.attenuations } : {}),
  };
}
