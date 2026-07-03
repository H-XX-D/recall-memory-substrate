// Hyperedge member normalization: read-path defense against the shapes a
// members array can arrive in, plain cell key strings, already-rich member
// objects, or legacy migrated objects keyed by nodeId instead of key.
import type { HyperedgeMember } from "./types.js";

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
