// The "what changed since" read: buckets cells, supersede events, and
// hyperedges against a timestamp window. Pure over the Store contract, so it
// runs identically on a single SqliteStore and the federated home union.
// Replaces the legacy recall_diff.py internals (which walked the retired
// subgraph verb); the markdown summary format is ported from it verbatim.
import { KINDS } from "./types.js";
import type { Cell, Hyperedge, Kind, Store } from "./types.js";

export interface DiffOptions {
  since: string; // ISO timestamp; relative durations are resolved by parseSince before this
  project?: string;
  kinds?: Kind[];
  maxItems?: number;
}

export interface DiffResult {
  since: string;
  newCells: Cell[]; // createdAt >= since
  updatedCells: Cell[]; // updatedAt >= since and createdAt < since
  supersedeEvents: { oldKey: string; newKey: string; kind: Kind; title: string }[];
  newHyperedges: Hyperedge[];
}

// Legacy recall_diff.py default for --max-items.
const DEFAULT_MAX_ITEMS = 12;

// Relative window grammar ported from the legacy recall_diff.py --since flag:
// <n><m|h|d|w> resolves against now; anything else must parse as a timestamp
// and is normalized to ISO.
const RELATIVE_RE = /^(\d+)([mhdw])$/;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseSince(value: string, nowIso: string): string {
  const relative = RELATIVE_RE.exec(value.trim());
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unit = UNIT_MS[relative[2]!]!;
    return new Date(Date.parse(nowIso) - amount * unit).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since must be an ISO timestamp or a relative duration like 30m, 2h, 7d, 4w: ${value}`);
  }
  return new Date(parsed).toISOString();
}

export function parseKinds(value: string): Kind[] {
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind) => kind !== "");
  if (kinds.length === 0) throw new Error("--kinds requires a comma list of kinds");
  for (const kind of kinds) {
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new Error(`--kinds: unknown kind "${kind}" (expected: ${KINDS.join(" ")})`);
    }
  }
  return kinds as Kind[];
}

export function diffStore(store: Store, opts: DiffOptions): DiffResult {
  const sinceMs = Date.parse(opts.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`invalid since timestamp: ${opts.since}`);
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const kinds = opts.kinds;

  const cells = store.all();
  const inScope = (cell: Cell): boolean =>
    (opts.project === undefined || cell.scope.project === opts.project) &&
    (kinds === undefined || kinds.includes(cell.kind));

  const newCells: Cell[] = [];
  const updatedCells: Cell[] = [];
  for (const cell of cells) {
    if (!inScope(cell)) continue;
    const created = Date.parse(cell.createdAt);
    if (created >= sinceMs) {
      newCells.push(cell);
    } else if (Date.parse(cell.updatedAt) >= sinceMs) {
      updatedCells.push(cell);
    }
  }
  newCells.sort(byIsoDesc((cell) => cell.createdAt));
  updatedCells.sort(byIsoDesc((cell) => cell.updatedAt));

  // A demotion has no timestamp of its own: it happens when the superseding
  // cell is admitted, so the superseding cell's createdAt dates the event.
  const superseded = new Set(cells.filter((cell) => cell.status === "superseded").map((cell) => cell.key));
  const supersedeEvents: DiffResult["supersedeEvents"] = [];
  for (const cell of cells) {
    if (Date.parse(cell.createdAt) < sinceMs) continue;
    if (!inScope(cell)) continue;
    for (const edge of cell.edgesOut) {
      if (edge.relation !== "supersedes") continue;
      if (!superseded.has(edge.target)) continue;
      supersedeEvents.push({ oldKey: edge.target, newKey: cell.key, kind: cell.kind, title: cell.title });
    }
  }
  supersedeEvents.sort((a, b) => (a.newKey < b.newKey ? -1 : a.newKey > b.newKey ? 1 : 0));

  const newHyperedges = store
    .listHyperedges(10_000)
    .filter((hyperedge) => Date.parse(hyperedge.createdAt) >= sinceMs)
    .slice(0, maxItems);

  return {
    since: opts.since,
    newCells: newCells.slice(0, maxItems),
    updatedCells: updatedCells.slice(0, maxItems),
    supersedeEvents: supersedeEvents.slice(0, maxItems),
    newHyperedges,
  };
}

// Markdown summary. The section grammar, middle dots, arrow, and em dash are
// ported contract strings from the legacy recall_diff.py --summary output
// (the SessionStart hook prints this); they stay byte-identical.
export function renderDiffSummary(d: DiffResult, scopeLabel: string): string {
  const scope = scopeLabel ? `in project \`${scopeLabel}\`` : "(graph-wide)";
  const lines: string[] = [];
  lines.push(`# Recall diff ${scope} since ${d.since}`);
  lines.push("");
  lines.push(
    `**Summary:** ${d.newCells.length} new cells · ${d.updatedCells.length} updated · ` +
      `${d.newHyperedges.length} new edges · ${d.supersedeEvents.length} supersede events`,
  );
  const empty =
    d.newCells.length === 0 &&
    d.updatedCells.length === 0 &&
    d.supersedeEvents.length === 0 &&
    d.newHyperedges.length === 0;
  if (empty) {
    lines.push("");
    lines.push("_No activity in this window._");
    return lines.join("\n");
  }
  if (d.newCells.length > 0) {
    lines.push("");
    lines.push(`## New cells (${d.newCells.length})`);
    for (const cell of d.newCells) lines.push(cellRow(cell));
  }
  if (d.updatedCells.length > 0) {
    lines.push("");
    lines.push(`## Updated cells (${d.updatedCells.length})`);
    for (const cell of d.updatedCells) lines.push(cellRow(cell));
  }
  if (d.supersedeEvents.length > 0) {
    lines.push("");
    lines.push(`## Supersede events (${d.supersedeEvents.length})`);
    for (const event of d.supersedeEvents) {
      lines.push(
        `- \`${id8(event.oldKey)}\` → \`${id8(event.newKey)}\` (${event.kind}) — ${truncate(event.title, 80)}`,
      );
    }
  }
  if (d.newHyperedges.length > 0) {
    lines.push("");
    lines.push(`## New hyperedges (${d.newHyperedges.length})`);
    for (const hyperedge of d.newHyperedges) {
      lines.push(`- \`${id8(hyperedge.id)}\` [${hyperedge.kind}] ${truncate(hyperedge.title, 100)}`);
    }
  }
  return lines.join("\n");
}

function cellRow(cell: Cell): string {
  return `- \`${id8(cell.key)}\` [${cell.kind}] ${truncate(cell.title, 100)}`;
}

// Short display id. Bare uuid keys shorten to their 8-hex prefix (the legacy
// contract). A federated union key is graph-prefixed (home:<uuid>), so a raw
// slice would print a dead 3-hex id like `home:1c7`; keep the graph and
// shorten the core instead, so cell show / recall_peek can resolve the id.
// Keys without a hex core (derived keys like drv_eval_run_<hex24>) render
// whole: any slice of them resolves to nothing.
function id8(key: string): string {
  const sep = key.lastIndexOf(":");
  const graph = sep >= 0 ? key.slice(0, sep + 1) : "";
  const core = sep >= 0 ? key.slice(sep + 1) : key;
  if (!/^[0-9a-f]{8}/i.test(core)) return key;
  return graph + core.slice(0, 8);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function byIsoDesc<T>(pick: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const am = Date.parse(pick(a));
    const bm = Date.parse(pick(b));
    return bm - am;
  };
}
