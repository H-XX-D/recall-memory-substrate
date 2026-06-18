import { createHash } from "node:crypto";
import { admitImportItems, clampBody, readImportFile, type ImportItem, type ImportResultItem, type ImportSummary } from "./import-core.js";
import type { RecallStore } from "./store.js";
import type { WriteProposal } from "./types.js";

export interface ZepFact {
  uuid?: string;
  fact: string;
  relation: string;
  source: string;
  target: string;
  validAt?: string;
  invalidAt?: string;
  createdAt?: string;
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function str(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

// Normalize a Zep graph export (edges / facts) into bi-temporal fact records.
// Accepts a top-level array or an {edges|facts|data:[...]} envelope. The relation
// lives under `name`; invalidation under `invalid_at` or `expired_at`.
export function parseZepExport(json: unknown): ZepFact[] {
  return extractRows(json).map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      uuid: str(rec.uuid, rec.id),
      fact: str(rec.fact, rec.content) ?? "",
      relation: str(rec.name, rec.relation, rec.predicate) ?? "",
      source: str(rec.source_node, rec.source, rec.source_node_name) ?? "",
      target: str(rec.target_node, rec.target, rec.target_node_name) ?? "",
      validAt: str(rec.valid_at),
      invalidAt: str(rec.invalid_at, rec.expired_at),
      createdAt: str(rec.created_at),
    };
  });
}

function extractRows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const key of ["edges", "facts", "data"]) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}

function srcTagFor(uuid: string): string {
  return `zep-src:${sha12(uuid)}`;
}

function titleFrom(fact: string): string {
  const trimmed = fact.trim();
  const words = trimmed.split(/\s+/);
  return words.length <= 20 ? trimmed : words.slice(0, 20).join(" ");
}

function factToProposal(
  fact: ZepFact,
  srcTag: string,
  project: string,
  now: string,
  expired: boolean,
  contradicts: string[]
): WriteProposal {
  const title = titleFrom(fact.fact);
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "connector", id: "zep-adapter", display: "Zep adapter" },
    intent: { kind: "observation", operation: "create" },
    content: { title, body: clampBody(fact.fact), summary: title },
    scope: { project, tenant: "local" },
    tags: {
      category: ["memory"],
      type: ["observation"],
      subject: [title],
      project: [project],
      idea: ["zep-import"],
      timestamp: [(fact.validAt ?? fact.createdAt ?? now).slice(0, 10)],
      topics: ["zep", "imported", ...(fact.relation ? [fact.relation] : [])],
      entities: [
        project,
        srcTag,
        ...(fact.source ? [fact.source] : []),
        ...(fact.target ? [fact.target] : []),
        ...(fact.uuid ? [`zep-uuid:${fact.uuid}`] : []),
      ],
      identities: ["connector:zep"],
      rings: ["runtime"],
      lifecycle: [expired ? "expired" : "active"],
      quality: ["imported", "source-grounded"],
    },
    evidence: { source_refs: [`zep:${fact.uuid ?? "unknown"}`], depends_on: [], supports: [], contradicts, concerns: [] },
    confidence: { value: 0.6, uncertainty: 0.28, concern: 0.12, source_quality: "medium", stability: "stable" },
    provenance: {
      created_at: fact.validAt ?? fact.createdAt ?? now,
      origin: "connector",
      produced_by: "zep-adapter",
      verification: "checked",
      signature_status: "unsigned",
    },
    policy: { sensitivity: "private", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null },
  } as WriteProposal;
}

// Import a Zep graph export. Reconstructs Recall supersession from Zep's
// bi-temporal history: facts are grouped by (source, relation); within a group
// ordered by valid_at, a fact stamped with invalid_at is superseded by the next
// fact in the group (a contradicts edge). Co-existing facts (neither invalidated)
// are NOT chained. A missing/unreadable file or invalid JSON is a hard error;
// a malformed individual fact is a non-fatal skip.
//
// Known limitations (single-snapshot import is the supported path):
//   - Re-importing across snapshots: a fact already imported as active that later
//     gains an invalid_at (text unchanged) is skipped as unchanged, so its cell
//     keeps lifecycle:active — the successor's contradicts edge still carries
//     currency, but the prior cell's lifecycle tag is not re-stamped.
//   - An invalidated predecessor with an EMPTY body is dropped before grouping, so
//     its successor links to nothing (degenerate input).
export function importZep(
  store: RecallStore,
  opts: { file: string; project?: string; apply?: boolean; now?: Date }
): ImportSummary {
  const json = readImportFile(opts.file, "zep");

  const project = opts.project ?? "Recall";
  const now = (opts.now ?? new Date()).toISOString();
  const preSkips: ImportResultItem[] = [];

  // Group by (source, relation); a superseding fact changes the target, so the
  // target is NOT part of the grouping key.
  const groups = new Map<string, ZepFact[]>();
  for (const fact of parseZepExport(json)) {
    if (!fact.uuid) {
      preSkips.push({ ref: "(no uuid)", action: "skip", reason: "malformed: missing uuid" });
      continue;
    }
    if (fact.fact.trim().length === 0) {
      preSkips.push({ ref: fact.uuid, action: "skip", reason: "empty" });
      continue;
    }
    // JSON-encode the key so distinct (source, relation) pairs can never collide
    // (e.g. source "A B"/relation "C" vs source "A"/relation "B C").
    const key = JSON.stringify([fact.source, fact.relation]);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(fact);
  }

  const items: ImportItem[] = [];
  for (const group of groups.values()) {
    group.sort(byValidAt);
    group.forEach((fact, i) => {
      const srcTag = srcTagFor(fact.uuid!);
      // A fact supersedes its immediate predecessor iff Zep marked that
      // predecessor invalid (so co-existing facts are never wrongly chained).
      const prev = group[i - 1];
      const supersedesTags = prev && prev.invalidAt ? [srcTagFor(prev.uuid!)] : undefined;
      const expired = Boolean(fact.invalidAt);
      items.push({
        ref: fact.uuid!,
        derivationKey: `zep:${sha12(fact.uuid!)}:${sha12(fact.fact)}`,
        srcTag,
        supersedesTags,
        toProposal: (contradicts) => factToProposal(fact, srcTag, project, now, expired, contradicts),
      });
    });
  }

  const summary = admitImportItems(store, "zep", items, { apply: opts.apply ?? false, now: opts.now });
  return { ...summary, skipped: summary.skipped + preSkips.length, items: [...preSkips, ...summary.items] };
}

function byValidAt(a: ZepFact, b: ZepFact): number {
  const av = a.validAt ?? a.createdAt ?? "";
  const bv = b.validAt ?? b.createdAt ?? "";
  if (av !== bv) return av < bv ? -1 : 1;
  return (a.uuid ?? "") < (b.uuid ?? "") ? -1 : 1;
}
