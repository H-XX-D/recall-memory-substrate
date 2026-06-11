import { spawnSync } from "node:child_process";

export interface SemanticHit<T> {
  item: T;
  score: number;
}

export interface EmbeddingRecord {
  backend: string;
  dims: number;
  vector: number[];
}

const DEFAULT_DIMS = 256;
const HTTP_TIMEOUT_SECONDS = 10;

// External backends that failed once are not retried within this process:
// embedding runs inside synchronous admission writes, and a dead endpoint
// must cost one failure, not one per write. Keyed by backend string so a
// config change mid-process gets a fresh attempt.
const failedBackends = new Set<string>();

export function embedText(text: string, dims = DEFAULT_DIMS): number[] {
  return embedTextRecord(text, dims).vector;
}

export function embedTextRecord(text: string, dims = DEFAULT_DIMS): EmbeddingRecord {
  const url = process.env.RECALL_EMBEDDING_URL;
  if (url && url.trim() !== "") {
    const record = httpEmbedding(url.trim(), text);
    if (record) {
      return record;
    }
  }
  const command = process.env.RECALL_EMBEDDING_COMMAND;
  if (command && command.trim() !== "") {
    const record = commandEmbeddingSafe(command, text, dims);
    if (record) {
      return record;
    }
  }
  return {
    backend: "hash:v1",
    dims,
    vector: hashEmbedding(text, dims)
  };
}

export function hashEmbedding(text: string, dims = DEFAULT_DIMS): number[] {
  const vector = Array.from({ length: dims }, () => 0);
  for (const token of tokenize(text)) {
    const bucket = Math.abs(hash(`${token}:bucket`)) % dims;
    const sign = hash(`${token}:sign`) % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalize(vector);
}

export function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return dot;
}

export function textForEmbedding(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .filter(Boolean)
    .join("\n");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/g)
    .filter((token) => token.length > 1);
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function httpEmbedding(url: string, text: string): EmbeddingRecord | null {
  const model = process.env.RECALL_EMBEDDING_MODEL?.trim() ?? "";
  const backend = `http:${model || "default"}@${url}`;
  if (failedBackends.has(backend)) {
    return null;
  }
  const args = ["-sS", "--max-time", String(HTTP_TIMEOUT_SECONDS), "-H", "Content-Type: application/json"];
  const apiKey = process.env.RECALL_EMBEDDING_API_KEY?.trim();
  if (apiKey) {
    args.push("-H", `Authorization: Bearer ${apiKey}`);
  }
  args.push("-d", "@-", url);
  const result = spawnSync("curl", args, {
    input: JSON.stringify(model ? { model, input: text } : { input: text }),
    encoding: "utf8",
    timeout: (HTTP_TIMEOUT_SECONDS + 5) * 1000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    return disableBackend(backend, result.error?.message ?? result.stderr?.trim() ?? `curl exit ${result.status}`);
  }
  const vector = parseEmbeddingHttpResponse(result.stdout);
  if (!vector) {
    return disableBackend(backend, "endpoint returned no usable embedding vector");
  }
  return { backend, dims: vector.length, vector: normalize(vector) };
}

export function parseEmbeddingHttpResponse(payload: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  // Accepted shapes: OpenAI-compatible {data:[{embedding}]}, Ollama
  // /api/embed {embeddings:[[...]]}, bare {embedding:[...]}, bare array.
  let vector: unknown = null;
  if (Array.isArray(parsed)) {
    vector = parsed;
  } else if (isRecord(parsed)) {
    if (Array.isArray(parsed.data) && isRecord(parsed.data[0])) {
      vector = parsed.data[0].embedding;
    } else if (Array.isArray(parsed.embeddings)) {
      vector = parsed.embeddings[0];
    } else if (Array.isArray(parsed.embedding)) {
      vector = parsed.embedding;
    }
  }
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    return null;
  }
  return vector as number[];
}

function commandEmbeddingSafe(command: string, text: string, dims: number): EmbeddingRecord | null {
  const backend = `command:${command}`;
  if (failedBackends.has(backend)) {
    return null;
  }
  try {
    return commandEmbedding(command, text, dims);
  } catch (error) {
    return disableBackend(backend, error instanceof Error ? error.message : String(error));
  }
}

function disableBackend(backend: string, reason: string): null {
  failedBackends.add(backend);
  process.stderr.write(`recall: embedding backend ${backend} unavailable (${reason}); using hash:v1 for the rest of this process\n`);
  return null;
}

function commandEmbedding(command: string, text: string, dims: number): EmbeddingRecord {
  const result = spawnSync(command, {
    input: JSON.stringify({ text, dims }),
    encoding: "utf8",
    shell: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Embedding command failed${stderr ? `: ${stderr}` : ""}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const vector = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.vector)
      ? parsed.vector
      : null;
  if (!vector || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("Embedding command must return a JSON number[] or {\"vector\": number[]}");
  }
  return {
    backend: `command:${command}`,
    dims: vector.length,
    vector: normalize(vector)
  };
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value | 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
