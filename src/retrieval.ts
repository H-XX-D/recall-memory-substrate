// Shared FTS phrase layer used by store.ts (lexical search) and compile.ts
// (query-time tokenization). Fusion scoring lives in Task 8; this module owns
// the phrase format only.

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
