import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { admitWriteProposal } from "./admission.js";
import { reviewFirewall } from "./firewall.js";
import { validateWriteProposal } from "./schema.js";
import type { RecallStore } from "./store.js";
import type { NodeKind, WriteProposal } from "./types.js";

export interface ParsedAutoMemory {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}

export interface DiscoveredFile {
  slug: string;
  project: string;
  filePath: string;
}

export interface ImportItem {
  filePath: string;
  action: "create" | "supersede" | "skip";
  cellId?: string;
  supersedes?: string[];
  // Why a file was skipped (unchanged / empty / too-large / unreadable / firewall / invalid).
  // Present only on skips; lets dry-run and apply explain themselves.
  reason?: string;
}

export interface ImportSummary {
  dryRun: boolean;
  created: number;
  superseded: number;
  skipped: number;
  items: ImportItem[];
}

const DEFAULT_ROOT = join(process.env.HOME ?? "", ".claude", "projects");
// Auto-memory notes are small; anything larger is skipped rather than read into
// memory, so a stray multi-GB file can never OOM the import.
const MAX_FILE_BYTES = 1_000_000;
// Supersession ceiling per file. Practically unbounded for real corpora (memory
// files rarely accrue dozens of versions) while still capping a pathological scan.
const MAX_PRIOR_VERSIONS = 1000;
// Only these frontmatter keys are kept; an arbitrary/pathological key block is ignored.
const FRONTMATTER_KEYS = new Set(["name", "description", "type"]);
const MAX_FIELD_LEN = 2000;

// Parse a Claude Code auto-memory file: flat `key: value` frontmatter between
// `---` fences, then the markdown body. The frontmatter is flat key/value, so a
// line scan suffices — no YAML dependency, and an unfenced file is body-only.
// CRLF is normalized first so Windows-authored files parse identically.
export function parseAutoMemoryFile(content: string): ParsedAutoMemory {
  const text = content.replace(/\r\n/g, "\n");
  const fence = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fence) {
    return { body: text.trim() };
  }
  const front: Record<string, string> = {};
  for (const line of fence[1]!.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && FRONTMATTER_KEYS.has(m[1]!)) {
      front[m[1]!] = m[2]!.trim().slice(0, MAX_FIELD_LEN);
    }
  }
  return {
    name: front.name,
    description: front.description,
    type: front.type,
    body: text.slice(fence[0].length).trim(),
  };
}

// Walk <root>/<slug>/memory/*.md, skipping the MEMORY.md index. Symlinks are
// skipped at every level (slug dir, memory dir, file) via lstat, so a symlink
// planted under the root can never make the import read a file outside the tree.
// Deterministic order.
export function discoverAutoMemoryFiles(root: string = DEFAULT_ROOT): DiscoveredFile[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: DiscoveredFile[] = [];
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    // lstat (not stat): a symlinked slug dir reports isDirectory()===false and is skipped.
    if (!safeIsDir(slugDir)) {
      continue;
    }
    const memoryDir = join(slugDir, "memory");
    if (!existsSync(memoryDir) || !safeIsDir(memoryDir)) {
      continue;
    }
    for (const entry of readdirSync(memoryDir)) {
      if (!entry.endsWith(".md") || entry === "MEMORY.md") {
        continue;
      }
      const filePath = join(memoryDir, entry);
      // Only regular files that live in the tree — never a symlinked entry.
      if (!safeIsFile(filePath)) {
        continue;
      }
      out.push({ slug, project: slug, filePath });
    }
  }
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function safeIsDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function sha12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function kindFor(type: string | undefined): NodeKind {
  switch ((type ?? "").toLowerCase()) {
    case "project":
    case "decision":
    case "architecture":
      return "decision";
    default:
      return "observation";
  }
}

function autoMemoryToProposal(
  parsed: ParsedAutoMemory,
  opts: { filePath: string; project: string; srcTag: string; contradicts: string[]; now: string }
): WriteProposal {
  const title = (parsed.name && parsed.name.trim()) || basename(opts.filePath) || "auto-memory";
  const summary = parsed.description ?? title;
  const kind = kindFor(parsed.type);
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "connector", id: "auto-memory-adapter", display: "Auto-memory adapter" },
    intent: { kind, operation: "create" },
    content: { title, body: parsed.body || summary, summary },
    scope: { project: opts.project, tenant: "local" },
    tags: {
      category: ["memory"],
      type: [kind],
      subject: [title],
      project: [opts.project],
      idea: ["auto-memory-import"],
      timestamp: [opts.now.slice(0, 10)],
      topics: ["auto-memory", "imported", parsed.type ?? "note"],
      entities: [opts.project, opts.srcTag],
      identities: ["connector:auto-memory"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["imported", "source-grounded"],
    },
    evidence: {
      source_refs: [opts.filePath],
      depends_on: [],
      supports: [],
      contradicts: opts.contradicts,
      concerns: [],
    },
    confidence: { value: 0.6, uncertainty: 0.28, concern: 0.12, source_quality: "medium", stability: "stable" },
    provenance: {
      created_at: opts.now,
      origin: "connector",
      produced_by: "auto-memory-adapter",
      verification: "checked",
      signature_status: "unsigned",
    },
    policy: {
      sensitivity: "private",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: null,
    },
  } as WriteProposal;
}

// Import Claude Code auto-memory files into the graph. Idempotent per file
// CONTENT (derivation key = file + content hash): re-importing an unchanged file
// is skipped; a changed file admits a new cell that SUPERSEDES the prior
// version(s) of that file via a contradicts edge (found by a stable per-file
// entity tag). Dry-run by default.
//
// Robustness: every file is bounded (oversized skipped, never read), read errors
// are non-fatal skips, and admission is PREDICTED in dry-run (same validate +
// firewall gates apply()'s admit runs) so dry-run counts match apply exactly —
// a file that would be rejected is reported as a skip in both modes, with a reason.
export function importAutoMemory(
  store: RecallStore,
  opts: { root?: string; project?: string; apply?: boolean; now?: Date } = {}
): ImportSummary {
  const root = opts.root ?? DEFAULT_ROOT;
  const apply = opts.apply ?? false;
  const now = (opts.now ?? new Date()).toISOString();
  const items: ImportItem[] = [];
  let created = 0;
  let superseded = 0;
  let skipped = 0;

  const skip = (filePath: string, reason: string): void => {
    skipped += 1;
    items.push({ filePath, action: "skip", reason });
  };

  for (const file of discoverAutoMemoryFiles(root)) {
    // Bound memory before reading: an oversized file is skipped, never loaded.
    let size: number;
    try {
      size = statSync(file.filePath).size;
    } catch {
      skip(file.filePath, "unreadable");
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skip(file.filePath, `too-large (${size} bytes > ${MAX_FILE_BYTES})`);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(file.filePath, "utf8");
    } catch {
      // Deleted or permission-revoked between discovery and read — skip, never fatal.
      skip(file.filePath, "unreadable");
      continue;
    }

    const srcTag = `auto-memory-src:${sha12(file.filePath)}`;
    const derivationKey = `auto-memory:${sha12(file.filePath)}:${sha12(raw)}`;

    // Already imported this exact version of this file.
    if (store.getNodeByDerivationKey(derivationKey)) {
      skip(file.filePath, "unchanged");
      continue;
    }

    const parsed = parseAutoMemoryFile(raw);
    // Nothing worth importing — no name and no body.
    if (!(parsed.name && parsed.name.trim()) && parsed.body.trim().length === 0) {
      skip(file.filePath, "empty");
      continue;
    }

    // Prior versions of this same file (stable src tag) are superseded.
    const priors = store.subgraph({ entities: [srcTag], limit: MAX_PRIOR_VERSIONS });
    const contradicts = priors.map((p) => p.id);

    const proposal = autoMemoryToProposal(parsed, {
      filePath: file.filePath,
      project: opts.project ?? file.project,
      srcTag,
      contradicts,
      now,
    });

    // Predict admission so dry-run counts match apply: the same validate + firewall
    // gates admitWriteProposal applies. A file that would be rejected is a skip in
    // BOTH modes, with the reason — never a silent count mismatch.
    const validated = validateWriteProposal(proposal);
    if (!validated.ok) {
      skip(file.filePath, `invalid: ${validated.issues[0]?.message ?? "schema"}`);
      continue;
    }
    const firewall = reviewFirewall(proposal);
    if (!firewall.allowed) {
      skip(file.filePath, `firewall: ${firewall.issues[0]?.message ?? "rejected"}`);
      continue;
    }

    if (!apply) {
      if (contradicts.length > 0) {
        superseded += 1;
        items.push({ filePath: file.filePath, action: "supersede", supersedes: contradicts });
      } else {
        created += 1;
        items.push({ filePath: file.filePath, action: "create" });
      }
      continue;
    }

    const result = admitWriteProposal(proposal, store, { derivationKey, now: opts.now });
    if (!result.accepted || !result.node) {
      // Defensive: predicted admit but admission still rejected (e.g. a review gate).
      skip(file.filePath, `rejected: ${result.issues[0]?.message ?? "admission"}`);
      continue;
    }
    if (contradicts.length > 0) {
      superseded += 1;
      items.push({ filePath: file.filePath, action: "supersede", cellId: result.node.id, supersedes: contradicts });
    } else {
      created += 1;
      items.push({ filePath: file.filePath, action: "create", cellId: result.node.id });
    }
  }

  return { dryRun: !apply, created, superseded, skipped, items };
}
