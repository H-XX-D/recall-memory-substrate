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

export function embedText(text: string, dims = DEFAULT_DIMS): number[] {
  return embedTextRecord(text, dims).vector;
}

export function embedTextRecord(text: string, dims = DEFAULT_DIMS): EmbeddingRecord {
  const command = process.env.RECALL_EMBEDDING_COMMAND;
  if (command && command.trim() !== "") {
    return commandEmbedding(command, text, dims);
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
