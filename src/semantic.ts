import { spawnSync } from "node:child_process";
import type { Cell, Store } from "./types.js";

export interface EmbeddingRecord {
  backend: string;
  dims: number;
  vector: number[];
}

const DEFAULT_DIMS = 256;
const HTTP_TIMEOUT_SECONDS = 10;

export function embedText(text: string): number[] {
  return embedTextRecord(text).vector;
}

export function embedTextRecord(text: string): EmbeddingRecord {
  const url = process.env["RECALL_EMBEDDING_URL"];
  if (url && url.trim() !== "") {
    const record = httpEmbedding(url.trim(), text);
    if (record) {
      return record;
    }
  }
  return {
    backend: "hash:v1",
    dims: DEFAULT_DIMS,
    vector: hashEmbedding(text),
  };
}

export function hashEmbedding(text: string, dims = DEFAULT_DIMS): number[] {
  const vector = Array.from({ length: dims }, () => 0) as number[];
  for (const token of tokenize(text)) {
    const bucket = Math.abs(hash(`${token}:bucket`)) % dims;
    const sign = hash(`${token}:sign`) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  return normalize(vector);
}

export function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

export function textForEmbedding(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .filter(Boolean)
    .join("\n");
}

export function parseEmbeddingHttpResponse(payload: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  // Accepted shapes: OpenAI {data:[{embedding:[...]}]}, Ollama {embeddings:[[...]]}
  let vector: unknown = null;
  if (isRecord(parsed)) {
    if (Array.isArray(parsed["data"]) && isRecord(parsed["data"][0])) {
      vector = (parsed["data"][0] as Record<string, unknown>)["embedding"];
    } else if (Array.isArray(parsed["embeddings"])) {
      vector = parsed["embeddings"][0];
    }
  }
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    vector.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    return null;
  }
  return vector as number[];
}

function httpEmbedding(url: string, text: string): EmbeddingRecord | null {
  const model = process.env["RECALL_EMBEDDING_MODEL"]?.trim() ?? "";
  const backend = `http:${model || "default"}@${url}`;
  const args = ["-sS", "--max-time", String(HTTP_TIMEOUT_SECONDS), "-H", "Content-Type: application/json"];
  const apiKey = process.env["RECALL_EMBEDDING_API_KEY"]?.trim();
  if (apiKey) {
    args.push("-H", `Authorization: Bearer ${apiKey}`);
  }
  args.push("-d", "@-", url);
  const result = spawnSync("curl", args, {
    input: JSON.stringify(model ? { model, input: text } : { input: text }),
    encoding: "utf8",
    timeout: (HTTP_TIMEOUT_SECONDS + 5) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `recall: embedding backend ${backend} unavailable (${result.error?.message ?? result.stderr?.trim() ?? `curl exit ${result.status}`}); using hash:v1\n`
    );
    return null;
  }
  const vector = parseEmbeddingHttpResponse(result.stdout);
  if (!vector) {
    process.stderr.write(`recall: embedding backend ${backend} returned no usable vector; using hash:v1\n`);
    return null;
  }
  return { backend, dims: vector.length, vector: normalize(vector) };
}

function tokenize(text: string): string[] {
  // Keep Unicode letters/digits so non-ASCII content contributes real tokens to
  // the hash:v1 fallback embedding instead of a degenerate vector. ASCII-only
  // text tokenizes identically to the prior [^a-z0-9_:-] split, so existing
  // embeddings are unchanged; only non-ASCII-bearing text gains coverage.
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_:-]+/gu)
    .filter((t) => t.length > 1);
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((v) => v / magnitude);
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value | 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SemanticHit {
  cell: Cell;
  score: number;
  backend: string;
}

export function semanticSearch(
  query: string,
  store: Store,
  opts?: { limit?: number; minScore?: number }
): SemanticHit[] {
  const limit = opts?.limit ?? 10;
  const minScore = opts?.minScore ?? 0;

  const qRec = embedTextRecord(query);
  const qv = qRec.vector;
  const queryBackend = qRec.backend;

  const ids = store.listSemanticVectorIds();
  const candidates: Array<{ id: string; score: number }> = [];

  for (const id of ids) {
    const vec = store.getSemanticVector(id);
    if (!vec) continue;
    if (vec.dims !== qv.length) continue;
    const score = cosine(qv, vec.vector);
    if (score < minScore) continue;
    candidates.push({ id, score });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const top = candidates.slice(0, limit);
  const hits: SemanticHit[] = [];

  for (const { id, score } of top) {
    const cell = store.get(id);
    if (!cell) continue;
    hits.push({ cell, score, backend: queryBackend });
  }

  return hits;
}

export function indexCell(cell: Cell, store: Store): void {
  const text = textForEmbedding([cell.title, cell.summary, cell.body, ...cell.tags.topics, ...cell.tags.entities]);
  const rec = embedTextRecord(text);
  store.putSemanticVector({
    nodeId: cell.key,
    backend: rec.backend,
    dims: rec.dims,
    vector: rec.vector,
    indexedAt: new Date().toISOString(),
  });
}

// Reindexes cells into the semantic vector table. With onlyMissing, cells
// already carrying a semantic vector are skipped, so a large store can be
// brought up to date incrementally instead of re-embedding everything.
// Returns the count of cells actually indexed.
export function reindexSemantic(store: Store, opts: { onlyMissing?: boolean } = {}): number {
  const skip = opts.onlyMissing ? new Set(store.listSemanticVectorIds()) : undefined;
  let count = 0;
  for (const cell of store.all()) {
    if (skip?.has(cell.key)) continue;
    indexCell(cell, store);
    count += 1;
  }
  return count;
}
