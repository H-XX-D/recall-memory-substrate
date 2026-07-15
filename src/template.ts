// MAL write template: the full authoring primitive set, one entry per
// WriteProposal key (types.ts). Each default IS the field's contract: its type,
// enum options, or constraint. A submitted value still equal to its description
// means the field was left unfilled, so admission rejects it and the Stop hook
// holds the turn until every value differs from its template description.
//
// Descriptions are sourced from the type contract (KINDS, RELATIONS, the enum
// constants, and the WriteProposal comments), not freelanced. Computed Cell
// fields (key, handle, scores, provenance, timestamps, status, lineage) are
// builder-set and are deliberately not in the template.

import type { ValidationIssue, WriteProposal } from "./types.js";

export const WRITE_TEMPLATE = {
  kind: "one of: dec|obs|bel|tsk|obj|rsk|ref|ver|hyp|prg",
  title: "non-empty one-line claim, <=20 words",
  body: "non-empty: the claim, the evidence, and the reasoning",
  confidence: "number in (0,1], your calibrated probability it is correct",
  value: "finite number this cell measures, or omit; supersede the prior reading so the lineage forms the delta series",
  topics: "string[] search terms a future asker would use",
  entities: "string[] named entities this is about",
  lifecycle: "string[] lifecycle facet tags for filtering",
  quality: "string[] quality facet tags for filtering",
  subject: "string[] subject facet tags for filtering",
  edges: "[{relation: supports|contradicts|concerns|depends_on|supersedes|derived_from, target: cell-id, weight}] or state none and why in body",
  sourceRefs: "string[] grounding refs (files/commits)",
  uncertainty: "number in [0,1], or omit to derive from confidence",
  concern: "number in [0,1], or omit to derive from confidence",
  operation: "one of: create|update|supersede|link|annex",
  origin: "one of: human|llm|daemon|connector|program|external",
  verification: "one of: unverified|checked|tested|external, and how you know",
  sensitivity: "one of: public|private|secret",
  stability: "one of: ephemeral|volatile|stable",
  expiresAt: "ISO-8601 timestamp or null (staleness clock)",
  reverifyAfter: "ISO-8601 timestamp or null (reverify clock)",
  flags: "{annexed|locked|pinned|requiresReview|allowBackgroundUse: boolean}, or omit for defaults (pinned resists decay)",
  props: "object payload; props.program carries a standing-program spec (recall.program.v1) on prg cells",
  programs: "string[] existing prg cell keys/handles that should watch this cell",
  hyperedges: "[{id: existing-hyperedge-id, role, weight}] bundle memberships to join; create bundles with hyperedge add",
  summary: "optional short summary",
  owner: "actor id",
  project: "project slug for routing",
  tenant: "tenant id",
} as const;

export type WriteTemplateField = keyof typeof WRITE_TEMPLATE;

// Completeness guard: every WriteProposal key must have a template entry, so a
// schema field can never again exist without the authoring contract teaching
// it. Fails typecheck if the template and the proposal type drift.
const _templateCoversProposal: Record<keyof WriteProposal, string> = WRITE_TEMPLATE;
void _templateCoversProposal;

// A field whose submitted value still equals its template description was never
// filled. Returns one issue per such field; admission rejects on any, and the
// Stop hook holds the turn until none remain.
export interface TemplateIssueOptions {
  /** Require an explicit submitted value for every authorable primitive. */
  requireComplete?: boolean;
  /** Require at least one honest graph connection. */
  requireEdge?: boolean;
}

export function templateIssues(
  proposal: WriteProposal,
  opts: TemplateIssueOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const p = proposal as unknown as Record<string, unknown>;
  for (const field of Object.keys(WRITE_TEMPLATE) as WriteTemplateField[]) {
    if (opts.requireComplete && !Object.prototype.hasOwnProperty.call(p, field)) {
      issues.push({
        path: field,
        message: `${field} is missing; submit an explicit value or null when it is not applicable`,
      });
      continue;
    }
    const value = p[field];
    if (typeof value === "string" && value.trim() === WRITE_TEMPLATE[field].trim()) {
      issues.push({
        path: field,
        message: `${field} still holds its template instruction; replace it with a real value`,
      });
    }
  }
  if (opts.requireEdge && (!Array.isArray(p.edges) || p.edges.length === 0)) {
    issues.push({
      path: "edges",
      message: "at least one honest, resolvable edge is required; use a no-write receipt instead of fabricating one",
    });
  }
  return issues;
}
