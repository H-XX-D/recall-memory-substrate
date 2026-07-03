// Hyperedge member normalization: read-path defense against the shapes a
// members array can arrive in, plain cell key strings, already-rich member
// objects, or legacy migrated objects keyed by nodeId instead of key.
import { randomUUID } from "node:crypto";
import type { Hyperedge, HyperedgeMember, Store } from "./types.js";

// Accepts three element shapes and always returns a well-formed member list.
// Non-array input or garbage elements are dropped rather than thrown: a bad
// members_json blob from an old store must never brick a read.
export function normalizeHyperedgeMembers(raw: unknown): HyperedgeMember[] {
  if (!Array.isArray(raw)) return [];

  const out: HyperedgeMember[] = [];
  for (const el of raw) {
    if (typeof el === "string") {
      out.push({ key: el, role: "member", ordinal: out.length });
      continue;
    }
    if (el && typeof el === "object") {
      const obj = el as Record<string, unknown>;
      const key = typeof obj.key === "string" ? obj.key : typeof obj.nodeId === "string" ? obj.nodeId : undefined;
      if (!key) continue; // garbage object: no usable key on either shape
      const member: HyperedgeMember = {
        key,
        role: typeof obj.role === "string" ? obj.role : "member",
        ordinal: typeof obj.ordinal === "number" ? obj.ordinal : out.length,
      };
      if (typeof obj.weight === "number") member.weight = obj.weight;
      if (obj.metadata && typeof obj.metadata === "object") {
        member.metadata = obj.metadata as Record<string, unknown>;
      }
      out.push(member);
      continue;
    }
    // number, boolean, null, undefined, etc: dropped, not thrown.
  }
  return out;
}

// A thin write proposal for a hyperedge: members may be bare cell key/handle
// strings or partial member objects; both are resolved and normalized before
// the write lands.
export interface HyperedgeInput {
  id?: string;
  kind: string;
  title: string;
  members: (string | Partial<HyperedgeMember>)[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

// Builds and persists a Hyperedge from a thin input. Every member reference is
// resolved against the store (by key, falling back to handle) so a hyperedge
// can never point at a cell that does not exist; the first unresolved member
// is named in the thrown error to make the bad reference easy to find.
export function addHyperedge(store: Store, input: HyperedgeInput, now?: string): Hyperedge {
  if (!input.kind.trim()) throw new Error("hyperedge kind must be non-empty");
  if (!input.title.trim()) throw new Error("hyperedge title must be non-empty");

  const resolvedMembers = input.members.map((m) => {
    const ref = typeof m === "string" ? m : m.key;
    if (typeof ref !== "string" || !ref) {
      throw new Error(`hyperedge member missing a key: ${JSON.stringify(m)}`);
    }
    const cell = store.get(ref) ?? store.getByHandle(ref);
    if (!cell) throw new Error(`hyperedge member not found: ${ref}`);
    return typeof m === "string" ? cell.key : { ...m, key: cell.key };
  });

  const hyperedge: Hyperedge = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    title: input.title,
    members: normalizeHyperedgeMembers(resolvedMembers),
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? now ?? new Date().toISOString(),
  };

  store.putHyperedge(hyperedge);
  return hyperedge;
}
