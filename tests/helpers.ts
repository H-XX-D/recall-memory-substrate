import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WriteProposal } from "../src/core/types.js";

export function makeProposal(overrides: PartialDeep<WriteProposal> = {}): WriteProposal {
  const base: WriteProposal = {
    schema_version: "recall.write.v1",
    actor: {
      kind: "llm",
      id: "codex",
      display: "Codex"
    },
    intent: {
      kind: "observation",
      operation: "create"
    },
    content: {
      title: "Recall schema initialized",
      body: "Recall stores structured memory through strict write proposals.",
      summary: "Strict write proposal path exists."
    },
    scope: {
      project: "Recall",
      path: "/tmp/recall",
      tenant: "local"
    },
    tags: {
      category: ["memory"],
      type: ["observation"],
      subject: ["schema"],
      project: ["Recall"],
      idea: ["strict-write-schema"],
      timestamp: ["2026-05-21"],
      topics: ["memory", "schema"],
      entities: ["Recall"],
      identities: ["agent:codex", "daemon:eligible"],
      rings: ["foundation"],
      lifecycle: ["active"],
      quality: ["source-grounded"],
      sensitivity: ["public"],
      permission: ["read"]
    },
    evidence: {
      source_refs: ["docs/02_WRITE_SCHEMA.md"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      value: 0.72,
      uncertainty: 0.2,
      concern: 0.4,
      source_quality: "medium",
      stability: "stable"
    },
    provenance: {
      created_at: "2026-05-21T17:30:00.000Z",
      origin: "llm",
      produced_by: "codex",
      verification: "checked",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "public",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: null
    }
  };

  return mergeDeep(base, overrides);
}

export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
  return {
    path: join(dir, "recall.sqlite3"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

export function writeJsonFixture(value: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "recall-json-"));
  const path = join(dir, "proposal.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K];
};

function mergeDeep<T>(base: T, patch: PartialDeep<T>): T {
  if (!isRecord(base) || !isRecord(patch)) {
    return (patch === undefined ? base : patch) as T;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeDeep(current, value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
