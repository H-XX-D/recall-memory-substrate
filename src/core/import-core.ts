import { readFileSync, statSync } from "node:fs";
import { admitWriteProposal } from "./admission.js";
import { reviewFirewall } from "./firewall.js";
import { validateWriteProposal } from "./schema.js";
import type { RecallStore } from "./store.js";
import type { WriteProposal } from "./types.js";

// One source record normalized for admission. The adapter (mem0/zep) turns its
// export format into a list of these; the core handles dedup, supersession, the
// admission firewall, and dry-run/apply parity uniformly.
export interface ImportItem {
  // Stable identifier for reporting (e.g. mem0 memory id, zep fact uuid).
  ref: string;
  // Idempotency key (source id + content hash). Re-importing an unchanged record skips.
  derivationKey: string;
  // This record's stable identity tag. Re-importing the SAME record with changed
  // content supersedes the prior version found by this tag. The proposal MUST
  // carry this tag in `tags.entities` so the prior is findable.
  srcTag: string;
  // srcTags of OTHER source records this record supersedes (e.g. a Zep fact that
  // invalidates an earlier fact about the same predicate). Resolved to prior cell
  // ids and added to the contradicts set.
  supersedesTags?: string[];
  // Build the proposal with the resolved contradicts cell ids injected.
  toProposal: (contradicts: string[]) => WriteProposal;
}

export interface ImportResultItem {
  ref: string;
  action: "create" | "supersede" | "skip";
  cellId?: string;
  supersedes?: string[];
  // Present only on skips: unchanged / invalid / firewall / rejected.
  reason?: string;
}

export interface ImportSummary {
  source: string;
  dryRun: boolean;
  created: number;
  superseded: number;
  skipped: number;
  items: ImportResultItem[];
}

const MAX_PRIORS = 1000;

// Bound memory: an export larger than this is rejected before reading, so a
// pathological multi-GB file can never OOM the process (also under V8's string
// limit). Generous enough for real exports; split a larger one.
export const MAX_IMPORT_BYTES = 134_217_728; // 128 MB
// Per-record body cap. Bounds both stored size and the firewall's per-record
// regex scan cost. Admission itself warns around this size for a single body.
export const MAX_BODY = 32_768;

// Read and JSON-parse an import export file, bounding memory first. A missing or
// unreadable file, an oversized file, or invalid JSON each raise a clear, labeled
// Error (the caller routes it through the CLI's fail() path).
export function readImportFile(file: string, label: string, maxBytes: number = MAX_IMPORT_BYTES): unknown {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new Error(`${label} import: cannot read export file: ${file}`);
  }
  if (size > maxBytes) {
    throw new Error(`${label} import: export file too large (${size} bytes > ${maxBytes}); split it before importing`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${label} import: cannot read export file: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} import: export file is not valid JSON: ${file}`);
  }
}

// Clamp a record body so a single huge record can't bloat storage or amplify the
// firewall scan. The clamped text is exactly what the firewall scans and what is
// stored — the truncated tail is never admitted, so this cannot bypass the firewall.
export function clampBody(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

// Admit a list of normalized import items. Processed in order, so a record that
// supersedes an earlier record in the same batch (Zep bi-temporal chains) sees
// its predecessor already admitted and links to it. Dry-run predicts admission
// (validate + firewall) so its counts match apply exactly.
export function admitImportItems(
  store: RecallStore,
  source: string,
  items: ImportItem[],
  opts: { apply: boolean; now?: Date }
): ImportSummary {
  const apply = opts.apply;
  const result: ImportResultItem[] = [];
  let created = 0;
  let superseded = 0;
  let skipped = 0;
  // srcTags that have been (predicted-)admitted this run, so dry-run can resolve a
  // same-batch predecessor the same way apply does (via the store).
  const admitted = new Set<string>();

  const skip = (ref: string, reason: string): void => {
    skipped += 1;
    result.push({ ref, action: "skip", reason });
  };

  for (const item of items) {
    // Already imported this exact version of this record.
    if (store.getNodeByDerivationKey(item.derivationKey)) {
      skip(item.ref, "unchanged");
      continue;
    }

    // Resolve priors to supersede: prior versions of this same record (own
    // srcTag) plus any other records named in supersedesTags. In dry-run a
    // same-batch predecessor is not yet admitted, so its cell id is unresolved —
    // intent is still tracked via supersedesTags below.
    const tags = [item.srcTag, ...(item.supersedesTags ?? [])];
    const priorIds = uniquePriorIds(store, tags);

    const proposal = item.toProposal(priorIds);

    // Predict admission so dry-run counts match apply.
    const validated = validateWriteProposal(proposal);
    if (!validated.ok) {
      skip(item.ref, `invalid: ${validated.issues[0]?.message ?? "schema"}`);
      continue;
    }
    const firewall = reviewFirewall(proposal);
    if (!firewall.allowed) {
      skip(item.ref, `firewall: ${firewall.issues[0]?.message ?? "rejected"}`);
      continue;
    }

    // Does this record supersede anything? A resolved store-resident prior, or a
    // same-batch predecessor that was actually (predicted-)admitted. A predecessor
    // that got skipped (firewall/invalid) must NOT count — otherwise dry-run would
    // report a phantom supersede that apply (which only sees real cells) never does.
    const supersedesBatch = (item.supersedesTags ?? []).some((t) => admitted.has(t));
    const willSupersede = priorIds.length > 0 || supersedesBatch;

    if (!apply) {
      if (willSupersede) {
        superseded += 1;
        result.push({ ref: item.ref, action: "supersede", supersedes: priorIds });
      } else {
        created += 1;
        result.push({ ref: item.ref, action: "create" });
      }
      admitted.add(item.srcTag);
      continue;
    }

    const admission = admitWriteProposal(proposal, store, { derivationKey: item.derivationKey, now: opts.now });
    if (!admission.accepted || !admission.node) {
      skip(item.ref, `rejected: ${admission.issues[0]?.message ?? "admission"}`);
      continue;
    }
    admitted.add(item.srcTag);
    if (priorIds.length > 0) {
      superseded += 1;
      result.push({ ref: item.ref, action: "supersede", cellId: admission.node.id, supersedes: priorIds });
    } else {
      created += 1;
      result.push({ ref: item.ref, action: "create", cellId: admission.node.id });
    }
  }

  return { source, dryRun: !apply, created, superseded, skipped, items: result };
}

function uniquePriorIds(store: RecallStore, tags: string[]): string[] {
  const ids = new Set<string>();
  for (const tag of tags) {
    for (const node of store.subgraph({ entities: [tag], limit: MAX_PRIORS })) {
      ids.add(node.id);
    }
  }
  return [...ids];
}
