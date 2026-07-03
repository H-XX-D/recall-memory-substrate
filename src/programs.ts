// R3 standing programs: deterministic, no-LLM checks stored as ordinary `prg`
// cells. A program cell carries its spec in props.program; run history is stored
// back on props.lastRun so watch/trend/drift have durable baseline state without
// introducing a second persistence surface.
import { randomUUID } from "node:crypto";
import { deriveAdmit, programRunDerivationKey } from "./derivation.js";
import { selectField } from "./resolve.js";
import type { AdmissionResult, Cell, Kind, Store, WriteProposal } from "./types.js";

export const PROGRAM_SCHEMA_VERSION = "recall.program.v1";

export const PROGRAM_OPERATIONS = [
  "score",
  "emit_witness",
  "tag_projection",
  "watch",
  "drift",
  "quorum",
  "trend",
  "reflex",
] as const;
export type ProgramOperation = (typeof PROGRAM_OPERATIONS)[number];

export interface ProgramSpec {
  schemaVersion: typeof PROGRAM_SCHEMA_VERSION;
  operation: ProgramOperation;
  description?: string;
  target?: ProgramTarget;
  params?: Record<string, unknown>;
}

export interface ProgramTarget {
  keys?: string[];
  query?: string;
  topics?: string[];
  entities?: string[];
  kinds?: Kind[];
  limit?: number;
}

export interface ProgramRun {
  id: string;
  programKey: string;
  operation: ProgramOperation;
  createdAt: string;
  memberKeys: string[];
  output: ProgramOutput;
}

export type ProgramOutput = Record<string, unknown> & {
  operation: ProgramOperation;
  memberCount: number;
  memberReferences: ProgramMemberReference[];
  tripped?: boolean;
  witness?: ProgramWitness;
};

export interface ProgramMemberReference {
  key: string;
  handle: string;
  title: string;
}

export interface ProgramWitness {
  title: string;
  summary: string;
}

export interface StandingProgramResult {
  runs: ProgramRun[];
  derived: AdmissionResult[];
}

export function validateProgramSpec(value: unknown): ProgramSpec {
  if (!isRecord(value)) throw new Error("program spec must be an object");
  if (value.schemaVersion !== PROGRAM_SCHEMA_VERSION) {
    throw new Error(`program spec schemaVersion must be ${PROGRAM_SCHEMA_VERSION}`);
  }
  if (!PROGRAM_OPERATIONS.includes(value.operation as ProgramOperation)) {
    throw new Error(`program operation must be one of ${PROGRAM_OPERATIONS.join(", ")}`);
  }
  const target = value.target === undefined ? undefined : validateTarget(value.target);
  const params = value.params === undefined ? undefined : assertRecord(value.params, "params");
  return {
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    operation: value.operation as ProgramOperation,
    description: typeof value.description === "string" ? value.description : undefined,
    target,
    params,
  };
}

export function programSpecFromCell(cell: Cell): ProgramSpec | undefined {
  if (cell.kind !== "prg") return undefined;
  const raw = cell.props.program;
  return raw === undefined ? undefined : validateProgramSpec(raw);
}

export function executeProgram(
  program: Cell,
  members: Cell[],
  now: string,
  previousRun?: ProgramRun,
): ProgramRun {
  const spec = programSpecFromCell(program);
  if (!spec) throw new Error(`cell is not a program: ${program.key}`);
  const output = executeSpec(spec, program, members, previousRun);
  return {
    id: randomUUID(),
    programKey: program.key,
    operation: spec.operation,
    createdAt: now,
    memberKeys: members.map((member) => member.key),
    output,
  };
}

export function runProgramCell(
  store: Store,
  programKeyOrCell: string | Cell,
  now: string,
  opts: { derive?: boolean } = {},
): { run: ProgramRun; derived?: AdmissionResult } {
  const program = typeof programKeyOrCell === "string" ? store.get(programKeyOrCell) : programKeyOrCell;
  if (!program) throw new Error(`unknown program: ${programKeyOrCell}`);
  const spec = programSpecFromCell(program);
  if (!spec) throw new Error(`cell is not a program: ${program.key}`);

  const members = selectProgramMembers(store, program, spec);
  const previousRun = previousRunFrom(program);
  const run = executeProgram(program, members, now, previousRun);
  persistProgramRun(store, program, run);
  attachProgramToMembers(store, program.key, members);

  const proposal = opts.derive ? programRunToProposal(program, run) : undefined;
  return {
    run,
    derived: proposal ? deriveAdmit(store, proposal, programRunDerivationKey(run), now) : undefined,
  };
}

// HAL thread ordering: functions run in position order within the tick. `position`
// (a reserved program param) sorts like `addf <func> <thread> [position]`: positive
// integers order from the start (default 0), negatives count from the end (-1 last).
// Ties break by insertion order (createdAt), i.e. "the order they are in the file".
const TICK_END = 1e9;
function tickPosition(cell: Cell): number {
  const raw = (cell.props.program as { params?: { position?: unknown } } | undefined)?.params?.position;
  const pos = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return pos >= 0 ? pos : TICK_END + pos; // -1 -> TICK_END-1 (runs last); -3 earlier in the tail
}

export function runStandingPrograms(
  store: Store,
  now: string,
  opts: { derive?: boolean } = {},
): StandingProgramResult {
  const programs = store
    .active()
    .filter((cell) => cell.kind === "prg" && cell.props.program !== undefined)
    .sort((a, b) => tickPosition(a) - tickPosition(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const runs: ProgramRun[] = [];
  const derived: AdmissionResult[] = [];
  for (const program of programs) {
    const result = runProgramCell(store, program, now, opts);
    runs.push(result.run);
    if (result.derived) derived.push(result.derived);
  }
  return { runs, derived };
}

export function selectProgramMembers(store: Store, program: Cell, spec: ProgramSpec): Cell[] {
  const target = spec.target ?? {};
  const limit = positiveInt(target.limit, 50);
  const byKey = new Map<string, Cell>();

  for (const key of target.keys ?? []) {
    const cell = store.get(key) ?? store.getByHandle(key);
    if (cell && cell.status === "active" && cell.key !== program.key) byKey.set(cell.key, cell);
  }

  if (target.query) {
    for (const hit of store.search(target.query, { limit })) {
      if (hit.cell.kind !== "prg" && hit.cell.status === "active") byKey.set(hit.cell.key, hit.cell);
    }
  }

  for (const edge of program.edgesOut) {
    const cell = store.get(edge.target);
    if (cell && cell.status === "active" && cell.kind !== "prg") byKey.set(cell.key, cell);
  }

  const topicSet = new Set(target.topics ?? []);
  const entitySet = new Set(target.entities ?? []);
  const kindSet = new Set(target.kinds ?? []);
  if (topicSet.size > 0 || entitySet.size > 0 || kindSet.size > 0) {
    for (const cell of store.active()) {
      if (cell.kind === "prg" || cell.key === program.key) continue;
      if (kindSet.size > 0 && !kindSet.has(cell.kind)) continue;
      if (topicSet.size > 0 && !cell.tags.topics.some((topic) => topicSet.has(topic))) continue;
      if (entitySet.size > 0 && !cell.tags.entities.some((entity) => entitySet.has(entity))) continue;
      byKey.set(cell.key, cell);
    }
  }

  if (byKey.size === 0 && !target.keys && !target.query && !target.topics && !target.entities && !target.kinds) {
    const programTopics = new Set(program.tags.topics);
    for (const cell of store.active()) {
      if (cell.kind === "prg" || cell.key === program.key) continue;
      if (programTopics.size === 0 || cell.tags.topics.some((topic) => programTopics.has(topic))) {
        byKey.set(cell.key, cell);
      }
    }
  }

  return [...byKey.values()].slice(0, limit);
}

export function programRunToProposal(program: Cell, run: ProgramRun): WriteProposal | undefined {
  const witness = run.output.witness;
  if (!witness) return undefined;
  const target = typeof run.output.concernTarget === "string" ? run.output.concernTarget : undefined;
  const edges: WriteProposal["edges"] = [{ relation: "derived_from", target: program.key }];
  if (target) edges.push({ relation: "concerns", target });
  return {
    kind: run.operation === "quorum" ? "ver" : "obs",
    title: witness.title,
    summary: witness.summary,
    body: JSON.stringify({ program: program.handle, run }, null, 2),
    confidence: 0.72,
    owner: `program:${program.handle}`,
    topics: ["program", run.operation, ...program.tags.topics],
    entities: [program.handle, ...run.memberKeys.slice(0, 8)],
    sourceRefs: [`recall://cell/${program.key}`, ...run.memberKeys.map((key) => `recall://cell/${key}`)],
    edges,
    project: program.scope.project,
    tenant: program.scope.tenant,
    verification: "checked",
    sensitivity: program.policy.sensitivity === "public" ? "private" : program.policy.sensitivity,
    stability: "volatile",
  };
}

function executeSpec(
  spec: ProgramSpec,
  program: Cell,
  members: Cell[],
  previousRun: ProgramRun | undefined,
): ProgramOutput {
  if (spec.operation === "watch") return executeWatch(spec, program, members, previousRun);
  if (spec.operation === "drift") return executeDrift(spec, program, members, previousRun);
  if (spec.operation === "quorum") return executeQuorum(spec, program, members);
  if (spec.operation === "trend") return executeTrend(spec, program, members, previousRun);
  if (spec.operation === "tag_projection") return executeTagProjection(spec, members);
  if (spec.operation === "emit_witness") return executeEmitWitness(program, members);
  if (spec.operation === "reflex") return executeReflex(spec, program, members);
  return executeScore(spec, members);
}

// lut5: the configurable boolean op (mal-language.md §5). Behavior is a 32-entry
// truth table (a uint32 "personality"), NOT a formula: the 5 boolean inputs form a
// 5-bit index, and the output is that bit of the personality. Deterministic, total,
// model-free. This is the spec's escape hatch for user-configurable logic without an
// expression language.
export function lut5(personality: number, inputs: readonly [boolean, boolean, boolean, boolean, boolean]): boolean {
  let index = 0;
  for (let i = 0; i < 5; i += 1) if (inputs[i]) index |= 1 << i;
  return ((toUint32(personality) >>> index) & 1) === 1;
}

function toUint32(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value); // Number("0xCAFE") parses hex
  return Number.isFinite(n) ? n >>> 0 : 0;
}

// The 5 reflex inputs read from a member cell's state (documented, fixed order):
//  i0 weak (eff < 0.5)  i1 stale (curr < 0.5)  i2 requiresReview  i3 pinned  i4 annexed
function reflexInputs(cell: Cell): [boolean, boolean, boolean, boolean, boolean] {
  return [
    cell.scores.effective < 0.5,
    cell.scores.currency < 0.5,
    cell.flags.requiresReview,
    cell.flags.pinned,
    cell.flags.annexed,
  ];
}

function executeReflex(spec: ProgramSpec, program: Cell, members: Cell[]): ProgramOutput {
  const personality = toUint32(spec.params?.personality);
  const fired = members.filter((m) => lut5(personality, reflexInputs(m)));
  const out: ProgramOutput = {
    operation: "reflex",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    personality,
    firedCount: fired.length,
    fired: memberReferences(fired),
  };
  if (fired.length > 0) {
    out.witness = {
      title: `Reflex fired: ${program.title} on ${fired.length}/${members.length} member(s)`,
      summary: `lut5 personality 0x${(personality >>> 0).toString(16)} fired on ${fired.length} member cell(s).`,
    };
  }
  return out;
}

function executeScore(spec: ProgramSpec, members: Cell[]): ProgramOutput {
  const values = members.map((cell) => cell.scores.effective);
  const averageEffective = average(values);
  const maxConcern = members.length === 0 ? 0 : Math.max(...members.map((cell) => cell.scores.concern));
  return {
    operation: spec.operation,
    memberCount: members.length,
    memberReferences: memberReferences(members),
    averageConfidence: round(average(members.map((cell) => cell.scores.conf))),
    averageEffective: round(averageEffective),
    maxConcern: round(maxConcern),
    score: round((averageEffective + (1 - maxConcern)) / 2),
  };
}

function executeTagProjection(spec: ProgramSpec, members: Cell[]): ProgramOutput {
  const family = typeof spec.params?.family === "string" ? spec.params.family : "topics";
  const values = new Set<string>();
  for (const member of members) {
    const raw = selectField(member.tags, family.split("."));
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (typeof value === "string") values.add(value);
      }
    }
  }
  return {
    operation: spec.operation,
    memberCount: members.length,
    memberReferences: memberReferences(members),
    family,
    values: [...values].sort(),
  };
}

function executeEmitWitness(program: Cell, members: Cell[]): ProgramOutput {
  return {
    operation: "emit_witness",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    witness: {
      title: `Program witness: ${program.title}`,
      summary: `Program observed ${members.length} member cell(s).`,
    },
  };
}

function executeWatch(
  spec: ProgramSpec,
  program: Cell,
  members: Cell[],
  previousRun: ProgramRun | undefined,
): ProgramOutput {
  const delta = positiveNumber(spec.params?.delta, 0.15);
  const current = round(meanEffective(members));
  const previous = typeof previousRun?.output.current === "number" ? previousRun.output.current : null;
  const change = previous === null ? 0 : round(current - previous);
  const tripped = previous !== null && Math.abs(change) >= delta;
  const out: ProgramOutput = {
    operation: "watch",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    current,
    previous,
    change,
    delta,
    tripped,
  };
  const concernTarget = typeof spec.params?.concernTarget === "string" ? spec.params.concernTarget : undefined;
  if (concernTarget) out.concernTarget = concernTarget;
  if (tripped) {
    const direction = change < 0 ? "fell" : "rose";
    out.witness = {
      title: `Watch tripped: ${program.title} ${direction} ${Math.abs(change)} (delta ${delta})`,
      summary: `Watched value moved ${previous} -> ${current} since the last run across ${members.length} member cell(s).`,
    };
  }
  return out;
}

function executeDrift(
  spec: ProgramSpec,
  program: Cell,
  members: Cell[],
  previousRun: ProgramRun | undefined,
): ProgramOutput {
  const delta = positiveNumber(spec.params?.delta, 0.15);
  const memberValues = Object.fromEntries(members.map((cell) => [cell.key, round(cell.scores.effective)]));
  const current = round(meanEffective(members));
  const previous = typeof previousRun?.output.current === "number" ? previousRun.output.current : null;
  const previousValues = isRecord(previousRun?.output.memberValues)
    ? (previousRun.output.memberValues as Record<string, unknown>)
    : {};
  const movers = members
    .map((cell) => {
      const prior = previousValues[cell.key];
      if (typeof prior !== "number") return undefined;
      return {
        key: cell.key,
        handle: cell.handle,
        title: cell.title,
        previous: prior,
        current: memberValues[cell.key]!,
        change: round(memberValues[cell.key]! - prior),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const change = previous === null ? 0 : round(current - previous);
  const tripped = previous !== null && Math.abs(change) >= delta;
  const out: ProgramOutput = {
    operation: "drift",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    current,
    previous,
    change,
    delta,
    tripped,
    memberValues,
    movers: movers.slice(0, 5),
  };
  if (movers[0]) out.topMover = movers[0];
  if (tripped) {
    const direction = change < 0 ? "fell" : "rose";
    out.witness = {
      title: `Drift tripped: ${program.title} ${direction} ${Math.abs(change)} (delta ${delta})`,
      summary: `Bundle moved ${previous} -> ${current}; top mover ${movers[0]?.title ?? "unknown"}.`,
    };
  }
  return out;
}

function executeQuorum(spec: ProgramSpec, program: Cell, members: Cell[]): ProgramOutput {
  const k = Math.max(1, Math.floor(positiveNumber(spec.params?.k, 2)));
  const minEff = probability(typeof spec.params?.minEff === "number" ? spec.params.minEff : 0.7);
  const distinctActors = spec.params?.distinctActors !== false;
  const approving = members
    .map((cell) => ({
      key: cell.key,
      handle: cell.handle,
      title: cell.title,
      actor: cell.provenance.producedBy,
      effective: round(cell.scores.effective),
    }))
    .filter((entry) => entry.effective >= minEff);
  const approverCount = distinctActors ? new Set(approving.map((entry) => entry.actor)).size : approving.length;
  const passed = approverCount >= k;
  const shortfall = Math.max(0, k - approverCount);
  return {
    operation: "quorum",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    k,
    minEff,
    distinctActors,
    approving,
    approverCount,
    passed,
    shortfall,
    score: round(Math.min(1, approverCount / k)),
    witness: {
      title: passed
        ? `Quorum passed: ${program.title} (${approverCount}/${k})`
        : `Quorum short: ${program.title} (${approverCount}/${k}, shortfall ${shortfall})`,
      summary: `${approving.length} of ${members.length} member cell(s) cleared effective >= ${minEff}.`,
    },
  };
}

function executeTrend(
  spec: ProgramSpec,
  program: Cell,
  members: Cell[],
  previousRun: ProgramRun | undefined,
): ProgramOutput {
  const window = Math.max(2, Math.floor(positiveNumber(spec.params?.window, 8)));
  const delta = positiveNumber(spec.params?.delta, 0.1);
  const streakThreshold = Math.max(1, Math.floor(positiveNumber(spec.params?.streak, 3)));
  const measure = typeof spec.params?.measure === "string" ? spec.params.measure : "effective_confidence";
  const current = round(measuredValue(measure, members));
  const prior = Array.isArray(previousRun?.output.series)
    ? previousRun.output.series.filter((value): value is number => typeof value === "number")
    : [];
  const series = [...prior, current].slice(-window);
  const slope = series.length < 2 ? 0 : round((series[series.length - 1]! - series[0]!) / (series.length - 1));
  const direction = slope > 0 ? "ascending" : slope < 0 ? "descending" : "stable";
  const steps = series.slice(1).map((value, i) => round(value - series[i]!));
  const streak = trailingStreak(steps);
  const tripped = series.length >= 2 && (Math.abs(slope) >= delta || Math.abs(streak) >= streakThreshold);
  const out: ProgramOutput = {
    operation: "trend",
    memberCount: members.length,
    memberReferences: memberReferences(members),
    measure,
    current,
    series,
    slope,
    direction,
    streak,
    streakMagnitude: Math.abs(streak),
    delta,
    window,
    streakThreshold,
    tripped,
  };
  if (tripped) {
    out.witness = {
      title: `Trend tripped: ${program.title} ${direction} (slope ${slope})`,
      summary: `Tracked ${measure} moved ${series[0]} -> ${series[series.length - 1]} over ${series.length} run(s).`,
    };
  }
  return out;
}

function persistProgramRun(store: Store, program: Cell, run: ProgramRun): void {
  store.put({
    ...program,
    props: {
      ...program.props,
      lastRun: run,
      runCount: typeof program.props.runCount === "number" ? program.props.runCount + 1 : 1,
    },
  });
}

function attachProgramToMembers(store: Store, programKey: string, members: Cell[]): void {
  for (const member of members) {
    if (member.programs.includes(programKey)) continue;
    store.put({ ...member, programs: [...member.programs, programKey] });
  }
}

function previousRunFrom(program: Cell): ProgramRun | undefined {
  return isProgramRun(program.props.lastRun) ? program.props.lastRun : undefined;
}

function isProgramRun(value: unknown): value is ProgramRun {
  return isRecord(value) && typeof value.id === "string" && typeof value.programKey === "string";
}

function validateTarget(value: unknown): ProgramTarget {
  const target = assertRecord(value, "target");
  return {
    keys: optionalStringArray(target.keys, "target.keys"),
    query: typeof target.query === "string" ? target.query : undefined,
    topics: optionalStringArray(target.topics, "target.topics"),
    entities: optionalStringArray(target.entities, "target.entities"),
    kinds: optionalStringArray(target.kinds, "target.kinds") as Kind[] | undefined,
    limit: target.limit === undefined ? undefined : positiveInt(target.limit, 50),
  };
}

function memberReferences(members: Cell[]): ProgramMemberReference[] {
  return members.map((cell) => ({ key: cell.key, handle: cell.handle, title: cell.title }));
}

function measuredValue(measure: string, members: Cell[]): number {
  if (measure === "member_count") return members.length;
  if (measure === "effective_confidence") return meanEffective(members);
  const values = members
    .map((cell) => selectField(cell, measure.split(/[.-]/).filter(Boolean)))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return average(values);
}

function meanEffective(members: Cell[]): number {
  return average(members.map((cell) => cell.scores.effective));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trailingStreak(steps: number[]): number {
  const sign = Math.sign(steps[steps.length - 1] ?? 0);
  if (sign === 0) return 0;
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (Math.sign(steps[i]!) !== sign) break;
    count += 1;
  }
  return sign * count;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function probability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
