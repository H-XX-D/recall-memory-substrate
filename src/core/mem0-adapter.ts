import { createHash } from "node:crypto";
import { admitImportItems, clampBody, readImportFile, type ImportItem, type ImportResultItem, type ImportSummary } from "./import-core.js";
import type { RecallStore } from "./store.js";
import type { WriteProposal } from "./types.js";

export interface Mem0Memory {
  id?: string;
  content: string;
  categories: string[];
  createdAt?: string;
  updatedAt?: string;
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// Normalize a Mem0 export (get_all / create_memory_export) into memory records.
// Accepts a top-level array or a {memories|results|data:[...]} envelope. The fact
// text may live under `memory`, `content`, or `text`; categories at top level or
// under `metadata.categories`.
export function parseMem0Export(json: unknown): Mem0Memory[] {
  return extractRows(json).map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    const meta = (rec.metadata ?? {}) as Record<string, unknown>;
    const cats = asStringArray(rec.categories);
    return {
      id: typeof rec.id === "string" ? rec.id : undefined,
      content: firstString(rec.memory, rec.content, rec.text) ?? "",
      categories: cats.length > 0 ? cats : asStringArray(meta.categories),
      createdAt: typeof rec.created_at === "string" ? rec.created_at : undefined,
      updatedAt: typeof rec.updated_at === "string" ? rec.updated_at : undefined,
    };
  });
}

function extractRows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const key of ["memories", "results", "data"]) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

function titleFrom(content: string): string {
  const trimmed = content.trim();
  const words = trimmed.split(/\s+/);
  return words.length <= 20 ? trimmed : words.slice(0, 20).join(" ");
}

function memoryToProposal(mem: Mem0Memory, srcTag: string, project: string, now: string, contradicts: string[]): WriteProposal {
  const title = titleFrom(mem.content);
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "connector", id: "mem0-adapter", display: "Mem0 adapter" },
    intent: { kind: "observation", operation: "create" },
    content: { title, body: clampBody(mem.content), summary: title },
    scope: { project, tenant: "local" },
    tags: {
      category: ["memory"],
      type: ["observation"],
      subject: [title],
      project: [project],
      idea: ["mem0-import"],
      timestamp: [(mem.createdAt ?? now).slice(0, 10)],
      topics: ["mem0", "imported", ...mem.categories],
      entities: [project, srcTag, ...(mem.id ? [`mem0-id:${mem.id}`] : [])],
      identities: ["connector:mem0"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["imported", "source-grounded"],
    },
    evidence: { source_refs: [`mem0:${mem.id ?? "unknown"}`], depends_on: [], supports: [], contradicts, concerns: [] },
    confidence: { value: 0.6, uncertainty: 0.28, concern: 0.12, source_quality: "medium", stability: "stable" },
    provenance: {
      created_at: mem.createdAt ?? now,
      origin: "connector",
      produced_by: "mem0-adapter",
      verification: "checked",
      signature_status: "unsigned",
    },
    policy: { sensitivity: "private", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null },
  } as WriteProposal;
}

// Import a Mem0 export file. A missing/unreadable file or invalid JSON is a hard
// error (the user named the file). A malformed individual record (no id, empty
// content) is a non-fatal skip-with-reason. Idempotent per memory content; a
// refined memory (same id, changed content) supersedes its prior version.
export function importMem0(
  store: RecallStore,
  opts: { file: string; project?: string; apply?: boolean; now?: Date }
): ImportSummary {
  const json = readImportFile(opts.file, "mem0");

  const project = opts.project ?? "Recall";
  const now = (opts.now ?? new Date()).toISOString();
  const preSkips: ImportResultItem[] = [];
  const items: ImportItem[] = [];

  for (const mem of parseMem0Export(json)) {
    if (!mem.id) {
      preSkips.push({ ref: "(no id)", action: "skip", reason: "malformed: missing id" });
      continue;
    }
    if (mem.content.trim().length === 0) {
      preSkips.push({ ref: mem.id, action: "skip", reason: "empty" });
      continue;
    }
    const srcTag = `mem0-src:${sha12(mem.id)}`;
    const derivationKey = `mem0:${sha12(mem.id)}:${sha12(mem.content)}`;
    items.push({
      ref: mem.id,
      derivationKey,
      srcTag,
      toProposal: (contradicts) => memoryToProposal(mem, srcTag, project, now, contradicts),
    });
  }

  const summary = admitImportItems(store, "mem0", items, { apply: opts.apply ?? false, now: opts.now });
  return { ...summary, skipped: summary.skipped + preSkips.length, items: [...preSkips, ...summary.items] };
}
