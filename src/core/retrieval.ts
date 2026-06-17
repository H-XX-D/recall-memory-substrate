import type { RecallNode } from "./types.js";

export interface LexicalCandidate {
  node: RecallNode;
  /** Raw FTS5 bm25() output: lower (more negative) is a better match. */
  bm25: number;
  /** Combined in+out relation count for the node. */
  degree: number;
  /**
   * Graph-computed effective confidence (see evidence.ts). When present it
   * replaces stated confidence in ranking, so challenged cells sink even
   * when their challenge edges raise graph degree.
   */
  effectiveConfidence?: number;
}

// Normalized lexical relevance owns the unit range; the three priors sum to
// at most 0.5 so they reorder near-ties but can never outvote a clearly
// better lexical match.
const GRAPH_WEIGHT = 0.25;
const GRAPH_SCALE = Math.log1p(10);
const CONFIDENCE_WEIGHT = 0.15;
const CONFIDENCE_DEFAULT = 0.5;
const RECENCY_WEIGHT = 0.1;
const RECENCY_HALF_LIFE_DAYS = 30;

// Closed-class glue words from natural task phrasing. As OR'd FTS phrases they
// match stub cells whose symbol IS the glue token (a variable literally named
// `to`) while carrying zero retrieval intent. Function words only — content
// words never belong here, and code-collision tokens (out/up/re/...) are
// deliberately excluded so symbol search keeps working.
const STOP_TERMS = new Set([
  "a", "an", "the", "to", "into", "onto", "in", "on", "of", "for", "with",
  "without", "from", "and", "or", "nor", "not", "no", "is", "are", "was",
  "were", "be", "been", "being", "am", "as", "at", "by", "it", "its", "this",
  "that", "these", "those", "then", "than", "so", "but", "if", "else", "via",
  "vs", "we", "you", "he", "she", "they", "them", "us", "him", "her", "our",
  "your", "my", "me", "do", "does", "did", "done", "have", "has", "had",
  "having", "can", "could", "should", "would", "will", "shall", "may", "might",
  "must", "about", "above", "below", "over", "under", "between", "during",
  "through", "after", "before", "while", "when", "where", "how", "what",
  "which", "who", "whom", "whose", "why", "all", "any", "each", "both",
  "some", "such", "also", "too", "very"
]);

export function searchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 1 && !STOP_TERMS.has(term.toLowerCase()))
    .slice(0, 8);
}

export function buildFtsMatchQuery(terms: string[]): string | null {
  // Each term becomes a quoted phrase: FTS5 operator syntax is neutralized,
  // and punctuated symbols like py-sym:foo_bar tokenize into an exact
  // adjacent-token phrase, preserving literal-match semantics.
  const phrases = terms
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return phrases.length > 0 ? phrases.join(" OR ") : null;
}

export interface FuseOptions {
  /** Per-kind multiplier on the NORMALIZED lexical term (default 1). */
  kindLexicalFactor?: Readonly<Partial<Record<RecallNode["kind"], number>>>;
}

/**
 * A search result: the node plus its read-time effective confidence and whether
 * it is currently challenged/superseded. Surfacing this on the search surface (not
 * just compile) keeps a consumer that reads search output from treating a demoted,
 * superseded cell as current.
 */
export type SearchHit = RecallNode & {
  effectiveConfidence?: number;
  challenged?: boolean;
};

// Task-compilation profile. Auto-extracted artifact stubs are ~10-token cells
// whose symbol token echoes through title AND three tag fields, so bm25's
// length normalization hands them the lexical ceiling: measured live, stubs
// score 2-4.5x the decisions a packet exists to surface (normalized lexical
// 1.0 vs 0.22-0.47). Additive priors (cap 0.5) cannot outvote that, so the
// correction is multiplicative on the lexical term; 0.15 puts a saturated
// stub below the weakest relevant semantic cell with margin while keeping
// stubs retrievable when nothing semantic matches. Plain search stays
// neutral — exact symbol lookup must keep full lexical strength.
export const TASK_CONTEXT_KIND_FACTOR: Readonly<Partial<Record<RecallNode["kind"], number>>> = {
  artifact: 0.15
};

export function fuseCandidates(
  candidates: LexicalCandidate[],
  limit: number,
  now: Date,
  options?: FuseOptions
): SearchHit[] {
  const bestLexical = candidates.reduce((best, candidate) => Math.max(best, -candidate.bm25), 0);
  const scored = candidates.map((candidate) => {
    const kindFactor = options?.kindLexicalFactor?.[candidate.node.kind] ?? 1;
    const lexical = bestLexical > 0 ? (kindFactor * Math.max(0, -candidate.bm25)) / bestLexical : 0;
    const graph = GRAPH_WEIGHT * Math.min(1, Math.log1p(candidate.degree) / GRAPH_SCALE);
    const stated = confidenceValue(candidate.node);
    const eff = candidate.effectiveConfidence ?? stated;
    const confidence = CONFIDENCE_WEIGHT * eff;
    const recency = RECENCY_WEIGHT * recencyDecay(candidate.node.updatedAt, now);
    return { candidate, eff, stated, score: lexical + graph + confidence + recency };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.node.updatedAt.localeCompare(a.candidate.node.updatedAt) ||
      a.candidate.node.id.localeCompare(b.candidate.node.id)
  );
  return scored.slice(0, limit).map((entry) => {
    if (entry.candidate.effectiveConfidence === undefined) {
      return entry.candidate.node as SearchHit;
    }
    // Copy (never mutate the shared node) and annotate. `challenged` marks a cell
    // whose read-time effective confidence has collapsed to well under HALF its stated
    // value — the signature of being superseded/contradicted. A milder dip (e.g. an
    // actor-calibration discount on a still-current cell) is left unflagged but the raw
    // effectiveConfidence is always exposed so the consumer can judge for itself.
    return {
      ...entry.candidate.node,
      effectiveConfidence: entry.eff,
      challenged: entry.eff < entry.stated * 0.5
    } satisfies SearchHit;
  });
}

function confidenceValue(node: RecallNode): number {
  const confidence = node.data.confidence;
  if (typeof confidence === "object" && confidence !== null && !Array.isArray(confidence)) {
    const value = (confidence as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value));
    }
  }
  return CONFIDENCE_DEFAULT;
}

function recencyDecay(updatedAt: string, now: Date): number {
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) {
    return 0;
  }
  const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000);
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}
