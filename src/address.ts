// MAL addressing: handles, separators (_ name, - field, . edge), values.
// A handle is `kind_hex` (snake_case); CAPS marks an immutable cell.
import { HANDLE_HEX_LENGTH, HANDLE_SOFT_LENGTH_CAP, KINDS, RELATIONS } from "./types.js";

export interface ParsedHandle {
  kind: string;
  id: string;
  immutable: boolean;
}

export function parseHandle(handle: string): ParsedHandle {
  const h = handle.trim();
  if (h.length === 0) throw new Error("handle must be non-empty");
  if (h.length > HANDLE_SOFT_LENGTH_CAP) {
    throw new Error(`handle exceeds ${HANDLE_SOFT_LENGTH_CAP} character soft cap: ${handle}`);
  }
  const parts = h.split("_");
  if (parts.length < 2 || parts.some((p) => p.length === 0)) {
    throw new Error(`malformed handle: ${handle}`);
  }
  const immutable = /[A-Z]/.test(h);
  const head = parts[0]!;
  const id = parts[parts.length - 1]!;
  const kind = head.toLowerCase();

  if ((KINDS as readonly string[]).includes(kind)) {
    if (!new RegExp(`^[a-f0-9]{${HANDLE_HEX_LENGTH},}$`).test(id)) {
      throw new Error(`handle id must be at least ${HANDLE_HEX_LENGTH} lowercase hex characters: ${handle}`);
    }
    if (!immutable && h !== h.toLowerCase()) {
      throw new Error(`mutable handles must be lowercase: ${handle}`);
    }
    for (const facet of parts.slice(1, -1)) {
      if (!/^[a-z][a-z0-9]*$/.test(facet)) throw new Error(`malformed handle facet: ${facet}`);
    }
    return { kind, id, immutable };
  }

  if (!immutable) throw new Error(`handle kind must be one of ${KINDS.join(", ")}: ${handle}`);
  if (!/^[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/.test(h)) {
    throw new Error(`malformed immutable handle: ${handle}`);
  }
  return {
    kind: head,
    id,
    immutable,
  };
}

// A written value: `field(value)`, or `field(value!)` where `!` marks it immutable.
export interface ParsedValue {
  field: string;
  value: number;
  immutable: boolean;
}

export function parseValue(token: string): ParsedValue {
  const m = /^([^(]+)\(([^)]*)\)$/.exec(token.trim());
  if (!m) throw new Error(`malformed value token: ${token}`);
  const field = m[1]!;
  if (field.trim().length === 0) throw new Error(`empty value field: ${token}`);
  let inner = m[2]!;
  const immutable = inner.endsWith("!");
  if (immutable) inner = inner.slice(0, -1);
  if (inner.trim().length === 0) throw new Error(`empty value in token: ${token}`);
  const value = Number(inner);
  if (!Number.isFinite(value)) throw new Error(`non-finite value in token: ${token}`);
  return { field, value, immutable };
}

export function renderValue(field: string, value: number, immutable: boolean): string {
  const num = formatNumber(value);
  return `${field}(${num}${immutable ? "!" : ""})`;
}

// Quote/unquote free text for the netlist's quoted-string exception. Escapes
// backslash, double-quote, and newline so a body/title can carry any of them on
// one physical line. Inverses: unquoteString(quoteString(s)) === s.
export function quoteString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function unquoteString(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    throw new Error(`not a quoted string: ${token}`);
  }
  return token.slice(1, -1).replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
}

// Sane number formatting: drop trailing zeros, no exponent for small magnitudes,
// keep integers integral.
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot render non-finite value: ${value}`);
  if (Number.isInteger(value)) return String(value);
  // Round to a stable precision, then strip trailing zeros.
  let s = value.toFixed(6);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// One step of an address: a cell, a field walk within a cell (`-`), or an edge
// hop to a neighbor (`.`). `>` / `<` on an edge segment sets traversal direction.
export interface PathSegment {
  kind: "cell" | "field" | "edge";
  name: string;
  direction?: "fwd" | "rev";
  version?: number;
}

export function parsePath(addr: string): PathSegment[] {
  if (addr.trim().length === 0) throw new Error("path must be non-empty");
  const segments: PathSegment[] = [];
  // First split on edge hops; each hop crosses an edge to a neighbor cell.
  const hops = addr.split(".");
  hops.forEach((hop, hopIndex) => {
    if (hop.length === 0) throw new Error(`empty path segment in: ${addr}`);
    // Each hop may carry "-" field walks: head is the edge (or first cell),
    // the rest are fields within whatever cell the hop lands on.
    const walks = hop.split("-");
    const head = walks[0]!;
    if (head.length === 0) throw new Error(`empty path head in: ${addr}`);
    if (hopIndex === 0) {
      const parsed = parseVersionedHead(head);
      parseHandle(parsed.name);
      const cell: PathSegment = { kind: "cell", name: parsed.name };
      if (parsed.version !== undefined) cell.version = parsed.version;
      segments.push(cell);
    } else {
      // Everything after a "." is an edge crossing. A leading ">"/"<" sets direction.
      const dir = directionOf(head);
      const edge: PathSegment = { kind: "edge", name: dir ? head.slice(1) : head };
      if (dir) edge.direction = dir;
      if (edge.name.length === 0) throw new Error(`empty edge segment in: ${addr}`);
      if (edge.name !== "*" && !(RELATIONS as readonly string[]).includes(edge.name)) {
        throw new Error(`edge must be one of ${RELATIONS.join(", ")} or *: ${edge.name}`);
      }
      segments.push(edge);
    }
    for (let i = 1; i < walks.length; i++) {
      const name = walks[i]!;
      if (name.length === 0) throw new Error(`empty field segment in: ${addr}`);
      segments.push({ kind: "field", name });
    }
  });
  return segments;
}

function directionOf(seg: string): "fwd" | "rev" | undefined {
  if (seg.startsWith(">")) return "fwd";
  if (seg.startsWith("<") || seg.startsWith("~")) return "rev";
  return undefined;
}

function parseVersionedHead(head: string): { name: string; version?: number } {
  const match = /^(.*)@v([1-9][0-9]*)$/.exec(head);
  if (!match) return { name: head };
  return { name: match[1]!, version: Number(match[2]) };
}
