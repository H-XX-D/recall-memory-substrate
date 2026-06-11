import type { Hyperedge, HyperedgeProgram, HyperedgeProgramSpec, ProgramRun, RecallNode } from "./types.js";

export interface ProgramExecutionInput {
  program: HyperedgeProgram;
  hyperedge: Hyperedge;
  members: RecallNode[];
  now?: Date;
}

export function executeHyperedgeProgram(input: ProgramExecutionInput): ProgramRun {
  const now = input.now ?? new Date();
  const output = executeSpec(input.program.spec, input.hyperedge, input.members);
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
  if (value.operation !== "score" && value.operation !== "emit_witness" && value.operation !== "tag_projection") {
    throw new Error("Program operation must be score, emit_witness, or tag_projection");
  }
  const params = value.params === undefined ? undefined : assertRecord(value.params, "params");
  return {
    schemaVersion: "recall.program.v1",
    operation: value.operation,
    description: typeof value.description === "string" ? value.description : undefined,
    params
  };
}

function executeSpec(
  spec: HyperedgeProgramSpec,
  hyperedge: Hyperedge,
  members: RecallNode[]
): Record<string, unknown> {
  if (spec.operation === "score") {
    const confidenceValues = members
      .map((node) => confidenceValue(node))
      .filter((value): value is number => value !== null);
    const averageConfidence =
      confidenceValues.length === 0
        ? 0
        : confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
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
      maxConcern,
      score: round((averageConfidence + (1 - maxConcern)) / 2)
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
