// compile: the read side. It asks the store for lexical hits (FTS5/BM25 when
// available, LIKE fallback otherwise) and renders the mini-index seeds. A
// zero-vocabulary or no-match query yields zero hits: a loud miss, not garbage.
import type { Cell, SearchHit, Store } from "./types.js";
import { renderMiniIndexLine } from "./render.js";
import {
  degreeMap,
  fuseCandidates,
  TASK_CONTEXT_KIND_FACTOR,
  type RankedHit,
} from "./retrieval.js";

export interface CompileResult {
  hits: SearchHit[];
  lines: string[]; // rendered mini-index, one line per hit
}

export interface ContextCompileOptions {
  limit?: number;
  budgetWords?: number;
  includeConflicts?: boolean;
  includeNextActions?: boolean;
}

export interface ContextPacket {
  objective: string;
  compilerState: string[];
  relevantMemory: string[];
  activeBeliefs: string[];
  conflicts: string[];
  dependencies: string[];
  risks: string[];
  tasks: string[];
  cellState: string[];
  staleOrLowTrust: string[];
  suggestedNextActions: string[];
  expansionHandles: string[];
  wordCount: number;
}

export function compile(
  store: Store,
  query: string,
  opts: { limit?: number } = {},
): CompileResult {
  const limit = opts.limit ?? 10;
  const hits = store.search(query, { limit });
  const lines = hits.map((h) =>
    renderMiniIndexLine(h.cell, { expand: h.cell.flags.requiresReview }),
  );
  return { hits, lines };
}

export function compileContext(
  store: Store,
  objective: string,
  opts: ContextCompileOptions = {},
  now: Date = new Date(),
): ContextPacket {
  const limit = opts.limit ?? 10;
  const budget = Math.max(80, opts.budgetWords ?? 900);

  // Wide candidate pool: fetch 30 hits so fusion has room to reorder.
  const wideHits = store.search(objective, { limit: 30 });
  const allKeys = wideHits.map((h) => h.cell.key);
  const dm = degreeMap(store, allKeys);
  const candidates = wideHits.map((h) => ({
    cell: h.cell,
    bm25: h.score,
    degree: dm.get(h.cell.key) ?? 0,
  }));
  const fusedHits: RankedHit[] = fuseCandidates(
    candidates,
    limit,
    now,
    { kindLexicalFactor: TASK_CONTEXT_KIND_FACTOR },
  );

  const stats = store.stats();
  const packet: ContextPacket = {
    objective: trimWords(objective, 40),
    compilerState: [
      `retrieval=${stats.lexicalBackend}; query="${trimWords(objective, 24)}"; selected_cells=${fusedHits.length}; budget_words=${budget}`,
      `graph=cells:${stats.cells}, active:${stats.activeCells}, edges:${stats.edges}, indexed:${stats.indexedCells}`,
      "policy=ids-first; use expansion_handles with inspectCell() for exact fields",
    ],
    relevantMemory: [],
    activeBeliefs: [],
    conflicts: [],
    dependencies: [],
    risks: [],
    tasks: [],
    cellState: [],
    staleOrLowTrust: [],
    suggestedNextActions: [],
    expansionHandles: [],
    wordCount: 0,
  };

  const seenChallenges = new Set<string>();
  for (const hit of fusedHits) {
    placeHit(packet, hit);
    pushUnique(packet.cellState, cellStateLine(store, hit.cell));
    pushUnique(packet.expansionHandles, hit.cell.key);
    if (opts.includeConflicts !== false) {
      surfaceIncomingChallenges(packet, store, hit.cell, seenChallenges);
    }
    surfaceDependencies(packet, store, hit.cell);
    // Surface challenged cells (effective < conf * 0.5) as low-trust, in
    // addition to the existing requiresReview / expiry checks.
    surfaceLowTrust(packet, hit.cell, hit.challenged);
    packet.wordCount = countPacketWords(packet);
    if (packet.wordCount >= budget) break;
  }

  if (opts.includeNextActions !== false && packet.suggestedNextActions.length === 0) {
    packet.suggestedNextActions.push("Expand only the handles needed for exact evidence before writing durable claims.");
  }

  trimPacket(packet, budget);
  return packet;
}

export function formatContextPacket(packet: ContextPacket): string {
  return [
    `objective:\n${packet.objective}`,
    section("compiler_state", packet.compilerState),
    section("relevant_memory", packet.relevantMemory),
    section("active_beliefs", packet.activeBeliefs),
    section("conflicts", packet.conflicts),
    section("dependencies", packet.dependencies),
    section("risks", packet.risks),
    section("tasks", packet.tasks),
    section("cell_state", packet.cellState),
    section("stale_or_low_trust", packet.staleOrLowTrust),
    section("suggested_next_actions", packet.suggestedNextActions),
    section("expansion_handles", packet.expansionHandles),
  ].join("\n\n");
}

function placeHit(packet: ContextPacket, hit: SearchHit | RankedHit): void {
  const line = `${renderMiniIndexLine(hit.cell, { expand: needsExpansion(hit.cell) })} score(${round2(hit.score)}) [${hit.cell.kind}:${hit.cell.key}]`;
  switch (hit.cell.kind) {
    case "bel":
      pushUnique(packet.activeBeliefs, line);
      break;
    case "rsk":
      pushUnique(packet.risks, line);
      break;
    case "tsk":
    case "obj":
      pushUnique(packet.tasks, line);
      break;
    default:
      pushUnique(packet.relevantMemory, line);
      break;
  }
}

function cellStateLine(store: Store, cell: Cell): string {
  const inCount = store.neighbors(cell.key).filter((link) => link.direction === "in").length;
  const outCount = cell.edgesOut.length;
  const tags = [
    tagsSummary("topics", cell.tags.topics),
    tagsSummary("entities", cell.tags.entities),
    tagsSummary("lifecycle", cell.tags.lifecycle),
    tagsSummary("quality", cell.tags.quality),
    tagsSummary("subject", cell.tags.subject),
  ].filter(Boolean).join("|");
  const policy = [
    cell.policy.sensitivity !== "public" ? `sensitivity:${cell.policy.sensitivity}` : "",
    cell.policy.expiresAt ? `expires:${cell.policy.expiresAt}` : "",
    cell.policy.reverifyAfter ? `reverify:${cell.policy.reverifyAfter}` : "",
    cell.flags.requiresReview ? "review_required" : "",
  ].filter(Boolean).join(",");
  return `${cell.kind}:${cell.key}; handle=${cell.handle}; state=${cell.status}/conf:${round2(cell.scores.conf)}/eff:${round2(cell.scores.effective)}/unc:${round2(cell.scores.uncertainty)}/concern:${round2(cell.scores.concern)}/curr:${round2(cell.scores.currency)}/sal:${round2(cell.scores.salience)}; facets=${tags || "none"}; rel=in:${inCount},out:${outCount}${policy ? `; policy=${policy}` : ""}`;
}

function surfaceIncomingChallenges(
  packet: ContextPacket,
  store: Store,
  cell: Cell,
  seen: Set<string>,
): void {
  for (const link of store.neighbors(cell.key)) {
    if (link.direction !== "in") continue;
    if (link.edge.relation !== "contradicts" && link.edge.relation !== "concerns") continue;
    if (link.cell.status !== "active") continue;
    const key = `${link.edge.relation}:${link.cell.key}->${cell.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushUnique(
      packet.conflicts,
      `${trimWords(link.cell.title, 12)} ${link.edge.relation} ${trimWords(cell.title, 12)} [${key}]`,
    );
    pushUnique(packet.expansionHandles, link.cell.key);
  }
}

// depends_on is weight-0 (inert in the mass/score walks), so it never surfaces
// through the challenge path. Surface it here as read-side context: what this
// cell rests on, flagged when a dependency is no longer active (superseded/etc),
// which is the signal that a plan is built on a retracted foundation.
function surfaceDependencies(packet: ContextPacket, store: Store, cell: Cell): void {
  for (const e of cell.edgesOut) {
    if (e.relation !== "depends_on") continue;
    const target = store.get(e.target) ?? store.getByHandle(e.target);
    if (!target) continue;
    const flag = target.status !== "active" ? ` [${target.status}]` : "";
    pushUnique(
      packet.dependencies,
      `${trimWords(cell.title, 12)} depends_on ${trimWords(target.title, 12)}${flag} [depends_on:${cell.key}->${target.key}]`,
    );
    pushUnique(packet.expansionHandles, target.key);
  }
}

function surfaceLowTrust(packet: ContextPacket, cell: Cell, challenged?: boolean): void {
  const effectiveCollapsed = challenged ?? cell.scores.effective < cell.scores.conf * 0.5;
  if (!needsExpansion(cell) && !effectiveCollapsed) return;
  const reasons = [
    cell.flags.requiresReview ? "requires_review" : "",
    effectiveCollapsed ? "effective_confidence_collapsed" : "",
    cell.policy.reverifyAfter ? `reverify_after:${cell.policy.reverifyAfter}` : "",
    cell.policy.expiresAt ? `expires_at:${cell.policy.expiresAt}` : "",
  ].filter(Boolean);
  pushUnique(packet.staleOrLowTrust, `${cell.handle}: ${reasons.join(",")} [${cell.kind}:${cell.key}]`);
}

function needsExpansion(cell: Cell): boolean {
  return cell.flags.requiresReview || Boolean(cell.policy.reverifyAfter || cell.policy.expiresAt);
}

function section(name: string, lines: string[]): string {
  return `${name}:\n${lines.length === 0 ? "- none" : lines.map((line) => `- ${line}`).join("\n")}`;
}

function tagsSummary(label: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return "";
  return `${label}:${values.slice(0, 2).join(",")}`;
}

function pushUnique(lines: string[], line: string): void {
  if (!lines.includes(line)) lines.push(line);
}

function trimPacket(packet: ContextPacket, budget: number): void {
  const sections: (keyof Pick<
    ContextPacket,
    | "cellState"
    | "relevantMemory"
    | "activeBeliefs"
    | "tasks"
    | "risks"
    | "conflicts"
    | "dependencies"
    | "staleOrLowTrust"
    | "suggestedNextActions"
    | "expansionHandles"
  >)[] = [
    "cellState",
    "relevantMemory",
    "activeBeliefs",
    "tasks",
    "risks",
    "conflicts",
    "dependencies",
    "staleOrLowTrust",
    "suggestedNextActions",
    "expansionHandles",
  ];
  while (countPacketWords(packet) > budget) {
    const key = sections.find((name) => packet[name].length > 1);
    if (!key) break;
    packet[key].pop();
  }
  packet.wordCount = countPacketWords(packet);
}

function countPacketWords(packet: ContextPacket): number {
  return [
    packet.objective,
    ...packet.compilerState,
    ...packet.relevantMemory,
    ...packet.activeBeliefs,
    ...packet.conflicts,
    ...packet.dependencies,
    ...packet.risks,
    ...packet.tasks,
    ...packet.cellState,
    ...packet.staleOrLowTrust,
    ...packet.suggestedNextActions,
    ...packet.expansionHandles,
  ].reduce((sum, line) => sum + countWords(line), 0);
}

function countWords(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}

function trimWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value.trim();
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
