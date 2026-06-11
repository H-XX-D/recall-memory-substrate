import { analyzeMemory, type MemoryHealthReport } from "./analysis.js";
import {
  previewReferenceValue,
  resolveCellReference,
  selectCellPath
} from "./references.js";
import { calibrationFactors, effectiveConfidence, type CalibrationFactors } from "./evidence.js";
import { TASK_CONTEXT_KIND_FACTOR } from "./retrieval.js";
import type { RecallStore } from "./store.js";
import type { ProposalConfidence, ProposalPolicy, RecallNode } from "./types.js";

export interface ContextCompileOptions {
  task: string;
  budgetWords: number;
  includeConflicts?: boolean;
  includeStaleWarnings?: boolean;
  includeNextActions?: boolean;
  inlineReferenceValues?: boolean;
  includeReferenceParameters?: boolean;
}

export interface ContextPacket {
  objective: string;
  compilerState: string[];
  relevantMemory: string[];
  activeBeliefs: string[];
  conflicts: string[];
  risks: string[];
  tasks: string[];
  cellState: string[];
  standingPrograms: string[];
  translatedReferences: string[];
  referenceParameters: string[];
  staleOrLowTrust: string[];
  suggestedNextActions: string[];
  expansionHandles: string[];
  wordCount: number;
}

// Packets are ids-first: long titles live behind expansion handles, so lines
// carry only enough of a title to recognize the cell. Reference fan-out is
// capped so one dense cell cannot flood the packet.
const RELEVANT_TITLE_WORDS = 20;
const HANDLE_TITLE_WORDS = 12;
const MAX_REFERENCE_LINES_PER_NODE = 6;
const MAX_CHALLENGES_PER_NODE = 6;

export function compileContext(store: RecallStore, options: ContextCompileOptions): ContextPacket {
  const budget = Math.max(80, options.budgetWords);
  // Task packets demote auto-extracted artifact stubs (see TASK_CONTEXT_KIND_FACTOR):
  // stubs are expansion material, not primary context — plain search stays neutral.
  const nodes = store.search(options.task, 30, { kindLexicalFactor: TASK_CONTEXT_KIND_FACTOR });
  const health = analyzeMemory(store);

  const packet: ContextPacket = {
    objective: trimWords(options.task, 40),
    compilerState: compilerState(store, options, nodes, health),
    relevantMemory: [],
    activeBeliefs: [],
    conflicts: [],
    risks: [],
    tasks: [],
    cellState: [],
    standingPrograms: [],
    translatedReferences: [],
    referenceParameters: [],
    staleOrLowTrust: [],
    suggestedNextActions: [],
    expansionHandles: [],
    wordCount: 0
  };

  const seenChallenges = new Set<string>();
  // One calibration pass per packet; every cell-state line reuses it.
  const actorFactors = calibrationFactors(store);
  // One program fetch per packet: standing programs (watch/drift/quorum/
  // score) are surfaced on the cells they cover, so an agent writing new
  // evidence knows which bundles to tie it into instead of orphaning it.
  const programsByEdge = new Map<string, { id: string; operation: string; params?: Record<string, unknown> }[]>();
  for (const program of store.listPrograms?.(200) ?? []) {
    if (!program.enabled) {
      continue;
    }
    const list = programsByEdge.get(program.hyperedgeId) ?? [];
    list.push({ id: program.id, operation: program.spec.operation, params: program.spec.params });
    programsByEdge.set(program.hyperedgeId, list);
  }
  const seenPrograms = new Set<string>();
  for (const node of nodes) {
    placeNode(packet, node);
    surfaceIncomingChallenges(packet, store, node, seenChallenges);
    surfaceStandingPrograms(packet, store, node, programsByEdge, seenPrograms);
    pushUnique(packet.cellState, cellStateLine(store, node, actorFactors));
    pushUnique(packet.expansionHandles, node.id);
    translateNodeReferences(packet, store, node, options);
    packet.wordCount = countPacketWords(packet);
    if (packet.wordCount >= budget) {
      break;
    }
  }

  addHealthSignals(packet, health, options, seenChallenges);

  if (options.includeNextActions !== false && packet.suggestedNextActions.length === 0) {
    packet.suggestedNextActions.push("Use recall search or expansion handles for more evidence before making durable claims.");
  }

  trimPacket(packet, budget);
  return packet;
}

// An agent about to trust a selected cell must see its challengers without
// asking: incoming contradicts/concerns relations surface regardless of the
// global conflicts overlay, which only carries the graph-wide top findings.
// Truth-layer verdicts (checker-contradicts, test-contradicts hyperedges)
// count as challengers too — their evidence lives outside the graph, so the
// line carries the external run pointer instead of an expansion handle.
function surfaceIncomingChallenges(
  packet: ContextPacket,
  store: RecallStore,
  node: RecallNode,
  seen: Set<string>
): void {
  const incoming = store
    .listRelations(node.id, "in", 100)
    .filter((relation) => relation.kind === "contradicts" || relation.kind === "concerns");
  let surfaced = 0;
  let overflow = 0;
  for (const relation of incoming) {
    const source = store.getNode(relation.sourceId);
    if (!source || source.status !== "active") {
      continue;
    }
    const key = `${relation.kind}:${relation.sourceId}->${node.id}`;
    if (seen.has(key)) {
      continue;
    }
    if (surfaced >= MAX_CHALLENGES_PER_NODE) {
      overflow += 1;
      continue;
    }
    seen.add(key);
    surfaced += 1;
    pushUnique(
      packet.conflicts,
      `${trimWords(source.title, HANDLE_TITLE_WORDS)} ${relation.kind} ${trimWords(node.title, HANDLE_TITLE_WORDS)} [${relation.kind}:${source.id}->${node.id}]`
    );
    pushUnique(packet.expansionHandles, source.id);
  }
  const challengingEdges = (store.hyperedgesForNode?.(node.id, 100) ?? [])
    .filter((edge) => edge.kind.endsWith("-contradicts"));
  for (const edge of challengingEdges) {
    const key = `${edge.kind}:${edge.id}->${node.id}`;
    if (seen.has(key)) {
      continue;
    }
    if (surfaced >= MAX_CHALLENGES_PER_NODE) {
      overflow += 1;
      continue;
    }
    seen.add(key);
    surfaced += 1;
    const evidencePointer = edge.metadata?.["checker_run"];
    const pointerSuffix = typeof evidencePointer === "string" ? ` (${evidencePointer})` : "";
    pushUnique(
      packet.conflicts,
      `${trimWords(edge.title, HANDLE_TITLE_WORDS)} ${edge.kind} ${trimWords(node.title, HANDLE_TITLE_WORDS)}${pointerSuffix} [${edge.kind}:${edge.id}->${node.id}]`
    );
  }
  if (overflow > 0) {
    pushUnique(
      packet.conflicts,
      `+${overflow} more challenges to ${trimWords(node.title, HANDLE_TITLE_WORDS)}; expand ${node.id} for the rest`
    );
  }
}

function addHealthSignals(
  packet: ContextPacket,
  health: MemoryHealthReport,
  options: ContextCompileOptions,
  seenChallenges: Set<string>
): void {
  for (const belief of health.beliefs.slice(0, 6)) {
    if (belief.recommendation !== "trust") {
      pushUnique(
        packet.activeBeliefs,
        `${trimWords(belief.title, HANDLE_TITLE_WORDS)}: recommendation=${belief.recommendation}, confidence=${belief.confidence}, uncertainty=${belief.uncertainty}, contradiction=${belief.contradiction} [belief:${belief.nodeId}]`
      );
    }
  }

  if (options.includeConflicts !== false) {
    for (const conflict of health.contradictions.slice(0, 6)) {
      if (seenChallenges.has(`${conflict.relation}:${conflict.sourceId}->${conflict.targetId}`)) {
        continue;
      }
      pushUnique(
        packet.conflicts,
        `${trimWords(conflict.sourceTitle, HANDLE_TITLE_WORDS)} ${conflict.relation} ${trimWords(conflict.targetTitle, HANDLE_TITLE_WORDS)}; severity=${conflict.severity} [${conflict.relation}:${conflict.sourceId}->${conflict.targetId}]`
      );
    }
  }

  if (options.includeStaleWarnings !== false) {
    for (const stale of health.stale.slice(0, 6)) {
      pushUnique(packet.staleOrLowTrust, `${trimWords(stale.title, HANDLE_TITLE_WORDS)}: ${stale.reason}; severity=${stale.severity} [stale:${stale.nodeId}]`);
    }
  }

  if (options.includeNextActions !== false) {
    for (const action of health.nextActions.slice(0, 4)) {
      pushUnique(packet.suggestedNextActions, action);
    }
  }
}

export function formatContextPacket(packet: ContextPacket): string {
  return [
    `objective:\n${packet.objective}`,
    section("compiler_state", packet.compilerState),
    section("relevant_memory", packet.relevantMemory),
    section("active_beliefs", packet.activeBeliefs),
    section("conflicts", packet.conflicts),
    section("risks", packet.risks),
    section("tasks", packet.tasks),
    section("cell_state", packet.cellState),
    section("standing_programs", packet.standingPrograms),
    section("translated_references", packet.translatedReferences),
    section("reference_parameters", packet.referenceParameters),
    section("stale_or_low_trust", packet.staleOrLowTrust),
    section("suggested_next_actions", packet.suggestedNextActions),
    section("expansion_handles", packet.expansionHandles)
  ].join("\n\n");
}

// Surface standing programs covering a selected cell. The line carries both
// handles — program id and hyperedge id — so the reading agent can run the
// gate, inspect the bundle, or wire fresh evidence into it.
function surfaceStandingPrograms(
  packet: ContextPacket,
  store: RecallStore,
  node: RecallNode,
  programsByEdge: ReadonlyMap<string, { id: string; operation: string; params?: Record<string, unknown> }[]>,
  seen: Set<string>
): void {
  if (programsByEdge.size === 0) {
    return;
  }
  for (const edge of store.hyperedgesForNode?.(node.id, 50) ?? []) {
    const programs = programsByEdge.get(edge.id);
    if (!programs) {
      continue;
    }
    for (const program of programs) {
      if (seen.has(program.id)) {
        continue;
      }
      seen.add(program.id);
      packet.standingPrograms.push(
        `${program.operation}${programParamsSummary(program.operation, program.params)} guards "${trimWords(edge.title, 8)}" covering ${node.kind}:${node.id} [program:${program.id} hyperedge:${edge.id}]`
      );
    }
  }
}

function programParamsSummary(operation: string, params?: Record<string, unknown>): string {
  if (!params) {
    return "";
  }
  const parts: string[] = [];
  if ((operation === "watch" || operation === "drift") && typeof params.delta === "number") {
    parts.push(`delta=${params.delta}`);
  }
  if (operation === "quorum") {
    if (typeof params.k === "number") {
      parts.push(`k=${params.k}`);
    }
    if (typeof params.minEff === "number") {
      parts.push(`minEff=${params.minEff}`);
    }
  }
  return parts.length > 0 ? `(${parts.join(",")})` : "";
}

function placeNode(packet: ContextPacket, node: RecallNode): void {
  const line = `${trimWords(node.title, RELEVANT_TITLE_WORDS)}: ${node.summary ?? trimWords(node.body, 28)} [${node.kind}:${node.id}]`;
  if (node.kind === "belief") {
    packet.activeBeliefs.push(line);
  } else if (node.kind === "contradiction") {
    packet.conflicts.push(line);
  } else if (node.kind === "risk") {
    packet.risks.push(line);
  } else if (node.kind === "task" || node.kind === "objective") {
    packet.tasks.push(line);
  } else {
    packet.relevantMemory.push(line);
  }

  const confidence = node.data.confidence as { source_quality?: string; stability?: string } | undefined;
  if (confidence?.source_quality === "unknown" || confidence?.stability === "ephemeral") {
    packet.staleOrLowTrust.push(`${trimWords(node.title, HANDLE_TITLE_WORDS)} has weak or temporary support [${node.kind}:${node.id}]`);
  }
}

function compilerState(
  store: RecallStore,
  options: ContextCompileOptions,
  nodes: RecallNode[],
  health: MemoryHealthReport
): string[] {
  const stats = store.stats();
  return [
    `retrieval=${store.lexicalBackend?.() ?? "lexical_search"}; query="${trimWords(options.task, 24)}"; selected_cells=${nodes.length}; budget_words=${Math.max(80, options.budgetWords)}`,
    `graph=nodes:${stats.nodes}, relations:${stats.relations}, hyperedges:${stats.hyperedges ?? 0}, programs:${stats.programs ?? 0}, dag_overlays:${stats.dagOverlays ?? 0}, eval_runs:${stats.evalRuns ?? 0}`,
    `health=beliefs:${health.beliefs.length}, contradictions:${health.contradictions.length}, stale_or_low_trust:${health.stale.length}, critical_warnings:${health.criticalWarnings.length}`,
    "policy=ids-first; translated_references return handles; call recall_cell/recall_search to expand only what is needed"
  ];
}

function cellStateLine(
  store: RecallStore,
  node: RecallNode,
  calibration?: CalibrationFactors
): string {
  const confidence = confidenceRecord(node);
  const policy = policyRecord(node);
  const relationsIn = store.listRelations(node.id, "in", 100).length;
  const relationsOut = store.listRelations(node.id, "out", 100).length;
  const policyHints = [
    policy.requires_review ? "review_required" : "",
    policy.expires_at ? `expires:${policy.expires_at}` : "",
    policy.reverify_after ? `reverify:${policy.reverify_after}` : "",
    policy.sensitivity && policy.sensitivity !== "public" ? `sensitivity:${policy.sensitivity}` : ""
  ].filter(Boolean).join(",");
  // eff: the graph-computed effective confidence — recomputed on every
  // compile, so the packet always carries the current standing of the claim,
  // not the author's original optimism. The cause tag says why it moved.
  const breakdown = effectiveConfidence(store, node, calibration);
  const causes = [
    breakdown.challengers > 0 ? "challenged" : "",
    breakdown.supporters > 0 ? "supported" : "",
    breakdown.calibrationFactor < 1 ? "actor-discounted" : ""
  ].filter(Boolean).join(",");
  const eff = `/eff:${round2(breakdown.effective)}${causes ? `(${causes})` : ""}`;
  return `${node.kind}:${node.id}; title=${trimWords(node.title, HANDLE_TITLE_WORDS)}; state=${node.status}/conf:${confidence.value ?? "?"}${eff}/unc:${confidence.uncertainty ?? "?"}/concern:${confidence.concern ?? "?"}/stability:${confidence.stability ?? "?"}/source:${confidence.source_quality ?? "?"}; facets=${facetSummary(node)}; rel=in:${relationsIn},out:${relationsOut}${policyHints ? `; policy=${policyHints}` : ""}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function translateNodeReferences(
  packet: ContextPacket,
  store: RecallStore,
  node: RecallNode,
  options: ContextCompileOptions
): void {
  const evidence = evidenceRecord(node);
  const entries: { relation: string; reference: string }[] = [
    ...evidence.depends_on.map((reference) => ({ relation: "depends_on", reference })),
    ...evidence.supports.map((reference) => ({ relation: "supports", reference })),
    ...evidence.contradicts.map((reference) => ({ relation: "contradicts", reference })),
    ...evidence.concerns.map((reference) => ({ relation: "concerns", reference }))
  ];
  for (const entry of entries.slice(0, MAX_REFERENCE_LINES_PER_NODE)) {
    translateReference(packet, store, node, entry.relation, entry.reference, options);
  }
  if (entries.length > MAX_REFERENCE_LINES_PER_NODE) {
    pushUnique(
      packet.translatedReferences,
      `${trimWords(node.title, HANDLE_TITLE_WORDS)} has ${entries.length - MAX_REFERENCE_LINES_PER_NODE} more references; expand ${node.id} for the rest`
    );
  }
}

function translateReference(
  packet: ContextPacket,
  store: RecallStore,
  source: RecallNode,
  relation: string,
  reference: string,
  options: ContextCompileOptions
): void {
  const sourceTitle = trimWords(source.title, HANDLE_TITLE_WORDS);
  const resolved = resolveCellReference(
    reference,
    (id) => store.getNode(id),
    (address) => store.getNodeByAddress(address)
  );
  if (!resolved.node) {
    pushUnique(packet.translatedReferences, `${sourceTitle} ${relation} unresolved reference ${reference} [${source.id}->${resolved.targetId}]`);
    return;
  }

  const targetTitle = trimWords(resolved.node.title, HANDLE_TITLE_WORDS);
  const handle = resolved.path
    ? `${resolved.node.id}#${resolved.path}`
    : resolved.node.id;
  pushUnique(packet.expansionHandles, handle);

  if (resolved.path) {
    const value = previewReferenceValue(selectCellPath(resolved.node, resolved.path));
    pushUnique(
      packet.translatedReferences,
      options.inlineReferenceValues
        ? `${sourceTitle} ${relation} ${targetTitle}#${resolved.path}: ${renderValue(value)} [${source.id}->${resolved.node.id}#${resolved.path}]`
        : `${sourceTitle} ${relation} ${targetTitle}#${resolved.path}; handle=${handle}; source=${source.id}; target=${resolved.node.id}`
    );
    if (options.includeReferenceParameters) {
      pushUnique(
        packet.referenceParameters,
        referenceParameterLine(source, relation, reference, resolved.node, resolved.path, value)
      );
    }
  } else {
    pushUnique(
      packet.translatedReferences,
      `${sourceTitle} ${relation} ${targetTitle}; handle=${handle}; source=${source.id}; target=${resolved.node.id}`
    );
    if (options.includeReferenceParameters) {
      pushUnique(
        packet.referenceParameters,
        referenceParameterLine(source, relation, reference, resolved.node, undefined, resolved.node.summary ?? resolved.node.body)
      );
    }
  }
}

function referenceParameterLine(
  source: RecallNode,
  relation: string,
  originalRef: string,
  target: RecallNode,
  path: string | undefined,
  value: unknown
): string {
  const targetConfidence = confidenceRecord(target);
  return `${trimWords(source.title, HANDLE_TITLE_WORDS)} ${relation} ${trimWords(target.title, HANDLE_TITLE_WORDS)}; source=${source.id}; target=${target.id}; handle=${path ? `${target.id}#${path}` : target.id}; path=${path ?? "whole_cell"}; value_kind=${valueKind(value)}; value=${trimWords(renderValue(value), 28)}; target_state=${target.kind}/${target.status}/conf:${targetConfidence.value ?? "?"}/unc:${targetConfidence.uncertainty ?? "?"}/concern:${targetConfidence.concern ?? "?"}/stability:${targetConfidence.stability ?? "?"}; original_ref=${originalRef}`;
}

function section(name: string, lines: string[]): string {
  return `${name}:\n${lines.length === 0 ? "- none" : lines.map((line) => `- ${line}`).join("\n")}`;
}

function pushUnique(lines: string[], line: string): void {
  if (!lines.includes(line)) {
    lines.push(line);
  }
}

function trimPacket(packet: ContextPacket, budget: number): void {
  const sections: (keyof Pick<
    ContextPacket,
    | "compilerState"
    | "relevantMemory"
    | "activeBeliefs"
    | "conflicts"
    | "risks"
    | "tasks"
    | "cellState"
    | "translatedReferences"
    | "referenceParameters"
    | "staleOrLowTrust"
    | "suggestedNextActions"
    | "expansionHandles"
  >)[] = [
    "referenceParameters",
    "cellState",
    "translatedReferences",
    "relevantMemory",
    "expansionHandles",
    "suggestedNextActions",
    "tasks",
    "risks",
    "activeBeliefs",
    "compilerState",
    "conflicts",
    "staleOrLowTrust"
  ];

  while (countPacketWords(packet) > budget) {
    const sectionToTrim = sections.find((key) => packet[key].length > 1);
    if (!sectionToTrim) {
      break;
    }
    packet[sectionToTrim].pop();
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
    ...packet.risks,
    ...packet.tasks,
    ...packet.cellState,
    ...packet.standingPrograms,
    ...packet.translatedReferences,
    ...packet.referenceParameters,
    ...packet.staleOrLowTrust,
    ...packet.suggestedNextActions,
    ...packet.expansionHandles
  ].reduce((total, text) => total + countWords(text), 0);
}

function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function trimWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function evidenceRecord(node: RecallNode): {
  depends_on: string[];
  supports: string[];
  contradicts: string[];
  concerns: string[];
} {
  const evidence = isRecord(node.data.evidence) ? node.data.evidence : {};
  return {
    depends_on: stringArray(evidence.depends_on),
    supports: stringArray(evidence.supports),
    contradicts: stringArray(evidence.contradicts),
    concerns: stringArray(evidence.concerns)
  };
}

function confidenceRecord(node: RecallNode): Partial<ProposalConfidence> {
  return isRecord(node.data.confidence) ? node.data.confidence as Partial<ProposalConfidence> : {};
}

function policyRecord(node: RecallNode): Partial<ProposalPolicy> {
  return isRecord(node.data.policy) ? node.data.policy as Partial<ProposalPolicy> : {};
}

function facetSummary(node: RecallNode): string {
  return [
    tagsSummary("category", node.tags.category),
    tagsSummary("type", node.tags.type),
    tagsSummary("subject", node.tags.subject),
    tagsSummary("project", node.tags.project),
    tagsSummary("idea", node.tags.idea),
    tagsSummary("topics", node.tags.topics),
    tagsSummary("entities", node.tags.entities),
    tagsSummary("lifecycle", node.tags.lifecycle)
  ].filter(Boolean).join("|");
}

function tagsSummary(label: string, values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return "";
  }
  return `${label}:${values.slice(0, 2).join(",")}`;
}

function renderValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
