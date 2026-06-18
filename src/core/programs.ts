import type { Hyperedge, HyperedgeProgram, HyperedgeProgramSpec, ProgramRun, RecallNode } from "./types.js";

export interface ProgramExecutionInput {
  program: HyperedgeProgram;
  hyperedge: Hyperedge;
  members: RecallNode[];
  /**
   * Live effective confidence per member node id (see evidence.ts). When
   * present, the score operation prices the bundle from the current graph
   * surface instead of the authors' stated claims — turning a scored bundle
   * into a tripwire: contradict any member anywhere in the graph and the
   * bundle's score falls on the next run, with no model involved.
   */
  effectiveConfidence?: ReadonlyMap<string, number>;
  /**
   * The program's most recent prior run, if any. Watch programs use it as
   * their baseline: the run history IS the memory, so a reflex needs no
   * extra state — it trips when the watched value moved more than `delta`
   * since the last time anyone looked.
   */
  previousRun?: ProgramRun | null;
  now?: Date;
}

export function executeHyperedgeProgram(input: ProgramExecutionInput): ProgramRun {
  const now = input.now ?? new Date();
  const output = executeSpec(
    input.program.spec,
    input.hyperedge,
    input.members,
    input.effectiveConfidence,
    input.previousRun ?? null
  );
  return {
    id: globalThis.crypto.randomUUID(),
    programId: input.program.id,
    hyperedgeId: input.hyperedge.id,
    output,
    createdAt: now.toISOString()
  };
}

export function validateProgramSpec(value: unknown): HyperedgeProgramSpec {
  if (!isRecord(value)) {
    throw new Error("Program spec must be an object");
  }
  if (value.schemaVersion !== "recall.program.v1") {
    throw new Error("Program spec schemaVersion must be recall.program.v1");
  }
  const operations: HyperedgeProgramSpec["operation"][] = [
    "score", "emit_witness", "tag_projection", "watch", "drift", "quorum", "trend"
  ];
  if (
    typeof value.operation !== "string" ||
    !operations.includes(value.operation as HyperedgeProgramSpec["operation"])
  ) {
    throw new Error(`Program operation must be one of: ${operations.join(", ")}`);
  }
  const operation = value.operation as HyperedgeProgramSpec["operation"];
  const params = value.params === undefined ? undefined : assertRecord(value.params, "params");
  return {
    schemaVersion: "recall.program.v1",
    operation,
    description: typeof value.description === "string" ? value.description : undefined,
    params
  };
}

function executeSpec(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[],
  effective?: ReadonlyMap<string, number>,
  previousRun?: ProgramRun | null
): Record<string, unknown> {
  if (spec.operation === "watch") {
    return executeWatch(spec, hyperedge, members, effective, previousRun ?? null);
  }
  if (spec.operation === "drift") {
    return executeDrift(spec, hyperedge, members, effective, previousRun ?? null);
  }
  if (spec.operation === "quorum") {
    return executeQuorum(spec, hyperedge, members, effective);
  }
  if (spec.operation === "trend") {
    return executeTrend(spec, hyperedge, members, effective, previousRun ?? null);
  }
  if (spec.operation === "score") {
    const confidenceValues = members
      .map((node) => confidenceValue(node))
      .filter((value): value is number => value !== null);
    const averageConfidence =
      confidenceValues.length === 0
        ? 0
        : confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
    // Live values: effective confidence when supplied, stated otherwise.
    // The score is computed from these, so a contradiction landing against
    // any member moves the bundle's score on the next run.
    const liveValues = members
      .map((node) => effective?.get(node.id) ?? confidenceValue(node))
      .filter((value): value is number => value !== null);
    const averageEffectiveConfidence =
      liveValues.length === 0
        ? 0
        : liveValues.reduce((sum, value) => sum + value, 0) / liveValues.length;
    const concernValues = members
      .map((node) => concernValue(node))
      .filter((value): value is number => value !== null);
    const maxConcern = concernValues.length === 0 ? 0 : Math.max(...concernValues);
    return {
      operation: spec.operation,
      hyperedgeId: hyperedge.id,
      memberCount: members.length,
      memberReferences: memberReferences(hyperedge, members),
      averageConfidence,
      averageEffectiveConfidence: round(averageEffectiveConfidence),
      maxConcern,
      score: round((averageEffectiveConfidence + (1 - maxConcern)) / 2)
    };
  }

  if (spec.operation === "tag_projection") {
    const family = typeof spec.params?.family === "string" ? spec.params.family : "topics";
    const values = new Set<string>();
    for (const node of members) {
      const tags = node.tags as unknown as Record<string, unknown>;
      const tagValues = tags[family];
      if (Array.isArray(tagValues)) {
        for (const value of tagValues) {
          if (typeof value === "string") {
            values.add(value);
          }
        }
      }
    }
    return {
      operation: spec.operation,
      hyperedgeId: hyperedge.id,
      memberReferences: memberReferences(hyperedge, members),
      family,
      values: [...values].sort()
    };
  }

  return {
    operation: spec.operation,
    hyperedgeId: hyperedge.id,
    witness: {
      title: `Program witness for ${hyperedge.title}`,
      summary: `Sandboxed program observed ${members.length} member cells.`,
      memberAddresses: members.map((node) => node.cellAddress),
      memberReferences: memberReferences(hyperedge, members)
    }
  };
}

// Watch: the reflex primitive. Computes the bundle's live value (mean
// effective confidence of members), compares it to the previous run's value,
// and trips when the move exceeds `delta`. Consequents never poke values —
// a tripped watch run derived with --derive files a CLAIM through admission
// (a concern against `concernTarget` when configured, a witness otherwise),
// attributed to the program, so reflexes are calibrated actors like everyone
// else. First run establishes the baseline and never trips: silence means
// stable, and there is no stability to compare against yet.
function executeWatch(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[],
  effective: ReadonlyMap<string, number> | undefined,
  previousRun: ProgramRun | null
): Record<string, unknown> {
  const delta = typeof spec.params?.delta === "number" && spec.params.delta > 0
    ? spec.params.delta
    : 0.15;
  const concernTarget =
    typeof spec.params?.concernTarget === "string" ? spec.params.concernTarget : null;

  const liveValues = members
    .map((node) => effective?.get(node.id) ?? confidenceValue(node))
    .filter((value): value is number => value !== null);
  const current =
    liveValues.length === 0
      ? 0
      : round(liveValues.reduce((sum, value) => sum + value, 0) / liveValues.length);

  const previous =
    previousRun && typeof previousRun.output.current === "number"
      ? (previousRun.output.current as number)
      : null;
  const change = previous === null ? 0 : round(current - previous);
  const tripped = previous !== null && Math.abs(change) >= delta;

  const output: Record<string, unknown> = {
    operation: spec.operation,
    hyperedgeId: hyperedge.id,
    memberCount: members.length,
    memberReferences: memberReferences(hyperedge, members),
    current,
    previous,
    change,
    delta,
    tripped
  };
  if (concernTarget) {
    output.concernTarget = concernTarget;
  }
  if (tripped) {
    const direction = change < 0 ? "fell" : "rose";
    output.witness = {
      title: `Watch tripped: ${hyperedge.title} ${direction} ${Math.abs(change)} (delta ${delta})`,
      summary:
        `Watched value moved ${previous} -> ${current} since the last run, ` +
        `exceeding the ${delta} threshold. ${members.length} member cells observed.`,
      memberAddresses: members.map((node) => node.cellAddress),
      memberReferences: memberReferences(hyperedge, members)
    };
  }
  return output;
}

// Drift: watch with attribution. Same trip semantics as watch, but the
// baseline keeps per-member values, so a tripped run names WHICH member
// moved — the on-call question ("the gate fell; because of what?") answered
// by the bundle itself.
function executeDrift(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[],
  effective: ReadonlyMap<string, number> | undefined,
  previousRun: ProgramRun | null
): Record<string, unknown> {
  const delta = typeof spec.params?.delta === "number" && spec.params.delta > 0
    ? spec.params.delta
    : 0.15;
  const concernTarget =
    typeof spec.params?.concernTarget === "string" ? spec.params.concernTarget : null;

  const memberValues: Record<string, number> = {};
  for (const node of members) {
    const value = effective?.get(node.id) ?? confidenceValue(node);
    if (value !== null) {
      memberValues[node.id] = round(value);
    }
  }
  const values = Object.values(memberValues);
  const current = values.length === 0 ? 0 : round(values.reduce((s, v) => s + v, 0) / values.length);

  const previousValues =
    previousRun && isRecord(previousRun.output.memberValues)
      ? (previousRun.output.memberValues as Record<string, number>)
      : null;
  const previous =
    previousRun && typeof previousRun.output.current === "number"
      ? (previousRun.output.current as number)
      : null;
  const change = previous === null ? 0 : round(current - previous);
  const tripped = previous !== null && Math.abs(change) >= delta;

  const byId = new Map(members.map((node) => [node.id, node]));
  const movers = previousValues
    ? Object.entries(memberValues)
        .filter(([id]) => typeof previousValues[id] === "number")
        .map(([id, value]) => ({
          nodeId: id,
          reference: byId.get(id)?.cellAddress ?? id,
          title: byId.get(id)?.title ?? id,
          previous: previousValues[id]!,
          current: value,
          change: round(value - previousValues[id]!)
        }))
        .filter((entry) => entry.change !== 0)
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 5)
    : [];
  const topMover = movers[0] ?? null;

  const output: Record<string, unknown> = {
    operation: spec.operation,
    hyperedgeId: hyperedge.id,
    memberCount: members.length,
    memberReferences: memberReferences(hyperedge, members),
    current,
    previous,
    change,
    delta,
    tripped,
    memberValues,
    movers
  };
  if (topMover) {
    output.topMover = topMover;
  }
  if (concernTarget) {
    output.concernTarget = concernTarget;
  }
  if (tripped) {
    const direction = change < 0 ? "fell" : "rose";
    const culprit = topMover
      ? ` Top mover: "${topMover.title}" (${topMover.previous} -> ${topMover.current}).`
      : "";
    output.witness = {
      title: `Drift tripped: ${hyperedge.title} ${direction} ${Math.abs(change)} (delta ${delta})`,
      summary:
        `Bundle moved ${previous} -> ${current} since the last run.${culprit}`,
      memberAddresses: members.map((node) => node.cellAddress),
      memberReferences: memberReferences(hyperedge, members)
    };
  }
  return output;
}

// Quorum: k-of-m sign-off as a graph object. A member "approves" when its
// live effective confidence clears minEff; approvals are counted across
// DISTINCT actors by default, so one enthusiast cannot stack the gate.
// Approvals here are calibrated cells, not checkbox clicks — a chronically
// wrong approver's effective confidence sinks, and their approval stops
// counting, with no policy code written anywhere.
function executeQuorum(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[],
  effective: ReadonlyMap<string, number> | undefined
): Record<string, unknown> {
  const k = typeof spec.params?.k === "number" && spec.params.k >= 1
    ? Math.floor(spec.params.k)
    : 2;
  const minEff = typeof spec.params?.minEff === "number" ? spec.params.minEff : 0.7;
  const distinctActors = spec.params?.distinctActors !== false;
  const role = typeof spec.params?.role === "string" ? spec.params.role : null;

  const eligibleIds = new Set(
    hyperedge.members
      .filter((member) => role === null || member.role === role)
      .map((member) => member.nodeId)
  );
  const eligible = members.filter((node) => eligibleIds.has(node.id));

  const approving = eligible
    .map((node) => ({
      nodeId: node.id,
      reference: node.cellAddress,
      title: node.title,
      actor: node.provenance?.produced_by ?? "unknown",
      effective: round(effective?.get(node.id) ?? confidenceValue(node) ?? 0)
    }))
    .filter((entry) => entry.effective >= minEff);

  const approverCount = distinctActors
    ? new Set(approving.map((entry) => entry.actor)).size
    : approving.length;
  const passed = approverCount >= k;
  const shortfall = Math.max(0, k - approverCount);

  return {
    operation: spec.operation,
    hyperedgeId: hyperedge.id,
    memberReferences: memberReferences(hyperedge, members),
    k,
    minEff,
    distinctActors,
    role,
    eligibleCount: eligible.length,
    approving,
    approverCount,
    passed,
    shortfall,
    score: round(Math.min(1, k === 0 ? 1 : approverCount / k)),
    witness: {
      title: passed
        ? `Quorum passed: ${hyperedge.title} (${approverCount}/${k} distinct approvals at eff>=${minEff})`
        : `Quorum SHORT: ${hyperedge.title} (${approverCount}/${k}, shortfall ${shortfall})`,
      summary:
        `${approving.length} of ${eligible.length} eligible members cleared minEff=${minEff}; ` +
        `${approverCount} ${distinctActors ? "distinct actors" : "approvals"} toward k=${k}.`,
      memberAddresses: members.map((node) => node.cellAddress),
      memberReferences: memberReferences(hyperedge, members)
    }
  };
}

// Trend: discrete calculus over the run-history series. Each run appends the
// bundle's current value (mean effective confidence, or member count) to a
// sliding window carried in the output, then reads off finite differences:
// direction (sign of the overall slope), slope (the first difference, a
// discrete rate), and acceleration (late slope minus early slope, a discrete
// second difference). These are finite differences, not continuous calculus —
// no limit is taken, because the data is a discrete series. It trips on a
// directional streak at or past `streak`, or a slope at or past `delta`, and
// files a witness through admission like watch and drift. The first run
// establishes the series and never trips: there is no prior step to compare.
function executeTrend(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[],
  effective: ReadonlyMap<string, number> | undefined,
  previousRun: ProgramRun | null
): Record<string, unknown> {
  const window = typeof spec.params?.window === "number" && spec.params.window >= 2
    ? Math.floor(spec.params.window)
    : 8;
  const delta = typeof spec.params?.delta === "number" && spec.params.delta > 0
    ? spec.params.delta
    : 0.1;
  const streakThreshold = typeof spec.params?.streak === "number" && spec.params.streak >= 1
    ? Math.floor(spec.params.streak)
    : 3;
  const measure = spec.params?.measure === "member_count" ? "member_count" : "effective_confidence";

  let current: number;
  if (measure === "member_count") {
    current = members.length;
  } else {
    const liveValues = members
      .map((node) => effective?.get(node.id) ?? confidenceValue(node))
      .filter((value): value is number => value !== null);
    current = liveValues.length === 0
      ? 0
      : round(liveValues.reduce((sum, value) => sum + value, 0) / liveValues.length);
  }

  const prior = previousRun && Array.isArray(previousRun.output.series)
    ? (previousRun.output.series as unknown[]).filter((value): value is number => typeof value === "number")
    : [];
  let series = [...prior, current];
  if (series.length > window) {
    series = series.slice(-window);
  }
  const n = series.length;

  // first differences (the discrete derivative): the step between each pair
  const steps: number[] = [];
  for (let i = 0; i + 1 < n; i += 1) {
    steps.push(round(series[i + 1]! - series[i]!));
  }

  // overall slope = mean step = (last - first) / (points - 1)
  const slope = n >= 2 ? round((series[n - 1]! - series[0]!) / (n - 1)) : 0;
  const direction = slope > 0 ? "ascending" : slope < 0 ? "descending" : "stable";

  // streak: trailing steps that share the latest step's sign (signed count)
  let streak = 0;
  if (steps.length > 0) {
    const lastSign = Math.sign(steps[steps.length - 1]!);
    if (lastSign !== 0) {
      let count = 0;
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (Math.sign(steps[i]!) === lastSign) {
          count += 1;
        } else {
          break;
        }
      }
      streak = lastSign * count;
    }
  }
  const streakMagnitude = Math.abs(streak);

  // acceleration = late-half slope minus early-half slope (second difference)
  let acceleration = 0;
  if (n >= 3) {
    const mid = Math.floor(n / 2);
    const earlySlope = (series[mid]! - series[0]!) / mid;
    const lateSlope = (series[n - 1]! - series[mid]!) / (n - 1 - mid);
    acceleration = round(lateSlope - earlySlope);
  }

  const tripped = n >= 2 && (streakMagnitude >= streakThreshold || Math.abs(slope) >= delta);

  const output: Record<string, unknown> = {
    operation: spec.operation,
    hyperedgeId: hyperedge.id,
    memberCount: members.length,
    memberReferences: memberReferences(hyperedge, members),
    measure,
    current,
    series,
    direction,
    slope,
    acceleration,
    streak,
    streakMagnitude,
    window,
    delta,
    streakThreshold,
    tripped
  };
  if (tripped) {
    const word = direction === "ascending" ? "rising" : direction === "descending" ? "falling" : "moving";
    output.witness = {
      title: `Trend tripped: ${hyperedge.title} ${word} (slope ${slope}, accel ${acceleration}, streak ${streakMagnitude})`,
      summary:
        `Tracked value moved ${series[0]} -> ${series[n - 1]} over ${n} runs, ${direction} ` +
        `with slope ${slope} and acceleration ${acceleration}; streak ${streakMagnitude} vs ` +
        `threshold ${streakThreshold}, delta ${delta}. ${members.length} member cells observed.`,
      memberAddresses: members.map((node) => node.cellAddress),
      memberReferences: memberReferences(hyperedge, members)
    };
  }
  return output;
}

function memberReferences(hyperedge: Hyperedge, members: RecallNode[]): Record<string, unknown>[] {
  const byId = new Map(members.map((node) => [node.id, node]));
  return hyperedge.members.map((member) => {
    const node = byId.get(member.nodeId);
    const metadata = member.metadata ?? {};
    return {
      role: member.role,
      nodeId: member.nodeId,
      address: typeof metadata.targetAddress === "string" ? metadata.targetAddress : node?.cellAddress,
      path: typeof metadata.targetPath === "string" ? metadata.targetPath : undefined,
      reference: typeof metadata.targetRef === "string" ? metadata.targetRef : node?.cellAddress ?? member.nodeId
    };
  });
}

function confidenceValue(node: RecallNode): number | null {
  const confidence = node.data.confidence;
  if (isRecord(confidence)) {
    return numberAt(confidence, "value");
  }
  return numberAt(node.data, "confidence");
}

function concernValue(node: RecallNode): number | null {
  const confidence = node.data.confidence;
  if (isRecord(confidence)) {
    return numberAt(confidence, "concern");
  }
  return numberAt(node.data, "concern");
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
