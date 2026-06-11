import {
  cellReferencePath,
  cellReferenceTarget,
  parseCellReference,
  previewReferenceValue,
  selectCellPath
} from "./references.js";
import type { Hyperedge, RecallNode, RecallRelation, RelationKind } from "./types.js";
import type { RecallStore } from "./store.js";

export interface CellDataFootprint {
  titleWords: number;
  summaryWords: number;
  bodyWords: number;
  serializedBytes: number;
  tagCount: number;
  sourceRefCount: number;
  evidenceLinkCount: number;
  relationCount: number;
  connectedCellCount: number;
  hyperedgeCount: number;
  rollbackEntryCount: number;
}

export interface CellContext {
  node: RecallNode;
  requestedField?: {
    path: string;
    valuePreview?: unknown;
  };
  footprint: CellDataFootprint;
  incoming: RecallRelation[];
  outgoing: RecallRelation[];
  evidence: {
    dependsOn: string[];
    supports: string[];
    contradicts: string[];
    concerns: string[];
  };
  fieldReferences: CellFieldReference[];
  connectedCells: RecallNode[];
  hyperedges: Hyperedge[];
  rollbackEntries: string[];
}

export interface CellFieldReference {
  relation: RelationKind;
  reference: string;
  targetId: string;
  targetAddress?: string;
  path: string;
  valuePreview?: unknown;
}

export function inspectCell(store: RecallStore, idOrAddress: string): CellContext {
  const parsed = parseCellReference(idOrAddress);
  const node = parsed.target.startsWith("recall://")
    ? store.getNodeByAddress(parsed.target)
    : store.getNode(parsed.target) ?? store.getNodeByAddress(parsed.target);
  if (!node) {
    throw new Error(`Unknown cell: ${idOrAddress}`);
  }

  const incoming = store.listRelations(node.id, "in", 100);
  const outgoing = store.listRelations(node.id, "out", 100);
  const evidence = evidenceLinks(node);
  const connectedIds = unique([
    ...incoming.map((relation) => relation.sourceId),
    ...outgoing.map((relation) => relation.targetId),
    ...evidence.dependsOn.map(cellReferenceTarget),
    ...evidence.supports.map(cellReferenceTarget),
    ...evidence.contradicts.map(cellReferenceTarget),
    ...evidence.concerns.map(cellReferenceTarget)
  ]).filter((id) => id !== node.id);
  const connectedCells = connectedIds
    .map((id) => store.getNode(id))
    .filter((candidate): candidate is RecallNode => candidate !== null);
  const fieldReferences = evidenceFieldReferences(store, evidence);
  const hyperedges = store
    .listHyperedges(500)
    .filter((edge) => edge.members.some((member) => member.nodeId === node.id));
  const rollbackEntries = store
    .listRollback(500)
    .filter((entry) => entry.targetId === node.id || relationTargetIds(incoming, outgoing).includes(entry.targetId))
    .map((entry) => entry.id);

  return {
    node,
    requestedField: parsed.path
      ? {
          path: parsed.path,
          valuePreview: previewReferenceValue(selectCellPath(node, parsed.path))
        }
      : undefined,
    footprint: {
      titleWords: countWords(node.title),
      summaryWords: countWords(node.summary ?? ""),
      bodyWords: countWords(node.body),
      serializedBytes: Buffer.byteLength(JSON.stringify(node), "utf8"),
      tagCount: countTags(node),
      sourceRefCount: sourceRefs(node).length,
      evidenceLinkCount: evidence.dependsOn.length + evidence.supports.length + evidence.contradicts.length + evidence.concerns.length,
      relationCount: incoming.length + outgoing.length,
      connectedCellCount: connectedCells.length,
      hyperedgeCount: hyperedges.length,
      rollbackEntryCount: rollbackEntries.length
    },
    incoming,
    outgoing,
    evidence,
    fieldReferences,
    connectedCells,
    hyperedges,
    rollbackEntries
  };
}

function evidenceFieldReferences(store: RecallStore, evidence: CellContext["evidence"]): CellFieldReference[] {
  const refs: CellFieldReference[] = [];
  pushFieldReferences(refs, store, "depends_on", evidence.dependsOn);
  pushFieldReferences(refs, store, "supports", evidence.supports);
  pushFieldReferences(refs, store, "contradicts", evidence.contradicts);
  pushFieldReferences(refs, store, "concerns", evidence.concerns);
  return refs;
}

function pushFieldReferences(
  refs: CellFieldReference[],
  store: RecallStore,
  relation: RelationKind,
  references: string[]
): void {
  for (const reference of references) {
    const path = cellReferencePath(reference);
    if (!path) {
      continue;
    }
    const targetId = cellReferenceTarget(reference);
    const target = store.getNode(targetId);
    refs.push({
      relation,
      reference,
      targetId,
      targetAddress: target?.cellAddress,
      path,
      valuePreview: target ? previewReferenceValue(selectCellPath(target, path)) : undefined
    });
  }
}

function evidenceLinks(node: RecallNode): CellContext["evidence"] {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  return {
    dependsOn: stringArray(evidence.depends_on),
    supports: stringArray(evidence.supports),
    contradicts: stringArray(evidence.contradicts),
    concerns: stringArray(evidence.concerns)
  };
}

function sourceRefs(node: RecallNode): string[] {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  return stringArray(evidence.source_refs);
}

function relationTargetIds(incoming: RecallRelation[], outgoing: RecallRelation[]): string[] {
  return [...incoming, ...outgoing].map((relation) => relation.id);
}

function countTags(node: RecallNode): number {
  return Object.values(node.tags).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function countWords(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
