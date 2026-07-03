// Shared FTS phrase layer and fusion scoring for retrieval.
// FTS phrase building used by store.ts and compile.ts; fusion re-ranking
// implemented here for Task 8.
import type { Cell, Kind, SearchHit, Store } from "./types.js";

// Closed-class glue words that carry no retrieval intent. Code-collision tokens
// (out, up, re, ...) are deliberately excluded so symbol search keeps working.
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
  "some", "such", "also", "too", "very",
]);

/**
 * Unicode-aware tokenizer used at compile time. Splits on whitespace, drops
 * stopwords (case-insensitive check) and single-character tokens, caps at 8
 * terms, and preserves the original casing of surviving tokens.
 */
export function searchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 1 && !STOP_TERMS.has(term.toLowerCase()))
    .slice(0, 8);
}

/**
 * Builds a FTS5 MATCH expression from an array of terms. Each term becomes a
 * double-quoted phrase so that FTS5 operator syntax is neutralized and
 * punctuated symbols like `py-sym:foo_bar` tokenize into adjacent-token
 * phrases, preserving exact-match semantics.
 *
 * Terms that contain no Unicode letter or digit (e.g. `---`, `!!!`) are
 * dropped because they cannot match any tokenized FTS5 content.
 *
 * Returns null when no usable terms remain (empty list or all punctuation).
 */
export function buildFtsMatchQuery(terms: string[]): string | null {
  const phrases = terms
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return phrases.length > 0 ? phrases.join(" OR ") : null;
}

// ---------------------------------------------------------------------------
// Fusion re-ranking (Task 8)
// ---------------------------------------------------------------------------

/**
 * A lexical search candidate ready for fusion scoring. bm25 is the raw FTS5
 * bm25() value (lower/more-negative = better match). degree is the combined
 * in+out edge count for the cell in the graph.
 */
export interface MalLexicalCandidate {
  cell: Cell;
  bm25: number;
  degree: number;
}

/**
 * A fused, re-ranked search result. Extends the shared SearchHit from types.ts
 * with an optional effectiveConfidence read directly from the cell and a
 * challenged flag set when effective confidence has collapsed below half the
 * stated anchor.
 */
export type RankedHit = SearchHit & {
  effectiveConfidence?: number;
  challenged?: boolean;
};

// Per-kind multipliers on the normalized lexical term for the task-compilation
// profile. Auto-extracted ref stubs echo their symbol token through title and
// tags, inflating bm25 length-normalization up to 4x over the decisions a
// packet exists to surface. The 0.15 factor puts a saturated stub below the
// weakest relevant semantic cell with margin while keeping refs retrievable
// when nothing else matches. Plain search stays neutral (no factor applied).
// Old model-A used kind "artifact"; MAL kind equivalent is "ref".
export const TASK_CONTEXT_KIND_FACTOR: Readonly<Partial<Record<Kind, number>>> = {
  ref: 0.15,
};

const GRAPH_WEIGHT = 0.25;
const CONFIDENCE_WEIGHT = 0.15;
const RECENCY_WEIGHT = 0.1;
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Fuse and re-rank lexical candidates using graph-degree, effective-confidence,
 * and recency priors. Pure: reads only from candidates, limit, now, and options.
 * No store access.
 *
 * Scoring formula per candidate:
 *   score = lexical + degreePrior + effectivePrior + recencyPrior
 *
 * where:
 *   lexical       = normalizedBm25 * (kindLexicalFactor[kind] ?? 1)
 *   degreePrior   = 0.25 * log1p(degree) / log1p(maxDegreeInBatch)
 *   effectivePrior = 0.15 * cell.scores.effective
 *   recencyPrior  = 0.1 * exp(-ageDays / 30)
 */
export function fuseCandidates(
  candidates: MalLexicalCandidate[],
  limit: number,
  now: Date,
  options?: { kindLexicalFactor?: Readonly<Partial<Record<Kind, number>>> }
): RankedHit[] {
  if (candidates.length === 0) return [];

  // bm25 from FTS5 is negative (lower = better). Negate to get positive relevance.
  const bestBm25 = candidates.reduce(
    (best, c) => Math.max(best, -c.bm25),
    0
  );

  const maxDegree = candidates.reduce((m, c) => Math.max(m, c.degree), 0);

  const kindFactor = options?.kindLexicalFactor;

  const scored = candidates.map((c) => {
    const normalizedLexical = bestBm25 > 0 ? Math.max(0, -c.bm25) / bestBm25 : 0;
    const lexical = normalizedLexical * (kindFactor?.[c.cell.kind] ?? 1);

    const degreePrior =
      maxDegree > 0
        ? GRAPH_WEIGHT * Math.log1p(c.degree) / Math.log1p(maxDegree)
        : 0;

    const effectivePrior = CONFIDENCE_WEIGHT * c.cell.scores.effective;

    const ageDays = Math.max(
      0,
      (now.getTime() - Date.parse(c.cell.updatedAt)) / 86_400_000
    );
    const recencyPrior = RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);

    const score = lexical + degreePrior + effectivePrior + recencyPrior;
    const challenged = c.cell.scores.effective < c.cell.scores.conf * 0.5;

    return { c, score, challenged };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.c.cell.updatedAt) - Date.parse(a.c.cell.updatedAt) ||
      a.c.cell.key.localeCompare(b.c.cell.key)
  );

  return scored.slice(0, limit).map(({ c, score, challenged }): RankedHit => ({
    cell: c.cell,
    score,
    backend: "fused",
    effectiveConfidence: c.cell.scores.effective,
    challenged,
  }));
}

// ---------------------------------------------------------------------------
// Degree batching (Task 9)
// ---------------------------------------------------------------------------

/**
 * Compute the total in+out edge degree for each key. Returns a Map where each
 * key is paired with its degree: the count of neighbors() links in both
 * directions (store.neighbors already returns both in and out edges combined).
 */
export function degreeMap(store: Store, keys: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of keys) {
    result.set(key, store.neighbors(key).length);
  }
  return result;
}
