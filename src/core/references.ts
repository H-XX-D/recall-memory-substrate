import type { RecallNode } from "./types.js";

export interface ParsedCellReference {
  raw: string;
  target: string;
  path?: string;
}

export interface ResolvedCellReference extends ParsedCellReference {
  node: RecallNode | null;
  targetId: string;
  canonical: string;
  targetAddress?: string;
}

export interface CellReferenceView {
  reference: string;
  targetId: string;
  targetAddress?: string;
  path?: string;
  value?: unknown;
}

export function parseCellReference(reference: string): ParsedCellReference {
  const raw = reference.trim();
  const separator = raw.indexOf("#");
  if (separator < 0) {
    return { raw, target: raw };
  }

  const target = raw.slice(0, separator).trim();
  const path = raw.slice(separator + 1).trim().replace(/^\//, "");
  if (!target || !isValidReferencePath(path)) {
    return { raw, target: raw };
  }

  return { raw, target, path };
}

export function formatCellReference(target: string, path?: string): string {
  return path ? `${target}#${path}` : target;
}

export function cellReferenceTarget(reference: string): string {
  const target = parseCellReference(reference).target;
  // Cell addresses (full recall://cell/<project>/.../<id> and the short
  // recall://cell/<id> form) both end in the node id; id-keyed consumers
  // need that trailing segment, not the address string.
  return target.startsWith("recall://") ? trailingSegment(target) : target;
}

function trailingSegment(address: string): string {
  const segments = address.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? address;
}

export function cellReferencePath(reference: string): string | undefined {
  return parseCellReference(reference).path;
}

export function resolveCellReference(
  reference: string,
  getNode: (id: string) => RecallNode | null,
  getNodeByAddress: (address: string) => RecallNode | null
): ResolvedCellReference {
  const parsed = parseCellReference(reference);
  // Full addresses resolve by address lookup; the short recall://cell/<id>
  // form (what the write helper emits) falls back to an id lookup on the
  // trailing segment.
  const node = parsed.target.startsWith("recall://")
    ? getNodeByAddress(parsed.target) ?? getNode(trailingSegment(parsed.target))
    : getNode(parsed.target) ?? getNodeByAddress(parsed.target);
  const targetId = node?.id ?? parsed.target;
  return {
    ...parsed,
    node,
    targetId,
    targetAddress: node?.cellAddress,
    canonical: formatCellReference(targetId, parsed.path)
  };
}

export function cellReferenceView(node: RecallNode, reference: string): CellReferenceView {
  const parsed = parseCellReference(reference);
  return {
    reference,
    targetId: node.id,
    targetAddress: node.cellAddress,
    path: parsed.path,
    value: parsed.path ? selectCellPath(node, parsed.path) : undefined
  };
}

export function selectCellPath(node: RecallNode, path: string): unknown {
  let current: unknown = cellProjection(node);
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (isRecord(current)) {
      current = current[part];
      continue;
    }
    return undefined;
  }
  return current;
}

export function previewReferenceValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 8));
  }
  return value;
}

function cellProjection(node: RecallNode): Record<string, unknown> {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  const confidence = isRecord(node.data.confidence) ? node.data.confidence : {};
  const policy = isRecord(node.data.policy) ? node.data.policy : {};
  const intent = isRecord(node.data.intent) ? node.data.intent : {};
  return {
    id: node.id,
    cellAddress: node.cellAddress,
    kind: node.kind,
    status: node.status,
    content: {
      title: node.title,
      body: node.body,
      summary: node.summary
    },
    title: node.title,
    body: node.body,
    summary: node.summary,
    scope: node.scope,
    tags: node.tags,
    evidence,
    confidence,
    provenance: node.provenance,
    policy,
    intent,
    data: node.data,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
}

function isValidReferencePath(path: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
