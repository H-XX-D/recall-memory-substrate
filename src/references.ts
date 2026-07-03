// Pure string utilities for cell references, plus MAL cell field addressing.
// Tasks 12+: cellProjection and selectCellPath require Cell from types and
// selectField from resolve. Lower-level string helpers have no such imports.

import type { Cell } from "./types.js";
import { selectField } from "./resolve.js";

export interface ParsedCellReference {
  raw: string;
  target: string;
  path?: string;
}

// Split on the FIRST # only. The tail after # is a dot-path (e.g. "items.0").
// If the path is syntactically invalid, the entire string is treated as the
// target (no split), matching the old model-A fallback behaviour.
export function parseCellReference(ref: string): ParsedCellReference {
  const raw = ref.trim();
  const sep = raw.indexOf("#");
  if (sep < 0) {
    return { raw, target: raw };
  }
  const target = raw.slice(0, sep).trim();
  const tail = raw.slice(sep + 1).trim().replace(/^\//, "");
  if (!target || !isValidPath(tail)) {
    return { raw, target: raw };
  }
  return { raw, target, path: tail };
}

export function formatCellReference(target: string, path?: string): string {
  return path ? `${target}#${path}` : target;
}

// Return the id portion of a cell reference, discarding the #path if present.
// Two different prefix forms are handled:
//   recall://cell/<project>/.../<id>  ->  trailing path segment (the UUID)
//   graph:<uuid>                       ->  everything after the first colon
// Plain bare keys (no prefix) are returned as-is.
// Both strips are applied because cell addresses use the recall:// form while
// graph-qualified keys use the graph:<uuid> form; they are distinct and must
// not be conflated.
export function cellReferenceTarget(ref: string): string {
  const target = parseCellReference(ref).target;
  if (target.startsWith("recall://")) {
    return trailingSegment(target);
  }
  if (target.includes(":")) {
    // graph-qualified address: strip the graph label before the first colon.
    return target.slice(target.indexOf(":") + 1).trim();
  }
  return target;
}

export function cellReferencePath(ref: string): string | undefined {
  return parseCellReference(ref).path;
}

// Truncate values for display in context packets:
//   strings  -> at most 180 characters total (truncated with ...)
//   arrays   -> at most 8 items
//   objects  -> at most 8 key/value pairs
// Primitives (number, boolean, null, undefined) pass through unchanged.
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

// MAL cell field addressing (Task 12).
//
// cellProjection: returns a plain object with the addressable MAL fields.
// Only real MAL names are exposed; no compat aliases (confirmed by audit of
// compile.ts, render.ts, mcp-server.ts -- no live consumer addresses
// confidence.value, data.evidence, intent.*, or any scores/props compat keys).
export function cellProjection(cell: Cell): Record<string, unknown> {
  return {
    key: cell.key,
    handle: cell.handle,
    kind: cell.kind,
    title: cell.title,
    body: cell.body,
    summary: cell.summary,
    scope: cell.scope,
    status: cell.status,
    scores: cell.scores,
    flags: cell.flags,
    tags: cell.tags,
    policy: cell.policy,
    provenance: cell.provenance,
    props: cell.props,
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  };
}

// selectCellPath: walk a dot-path into a cell's projected fields.
// Delegates fully to resolve.selectField; does not reimplement the walk.
export function selectCellPath(cell: Cell, path: string): unknown {
  return selectField(cellProjection(cell), path.split("."));
}

// Helpers

function trailingSegment(address: string): string {
  const parts = address.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? address;
}

function isValidPath(path: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
