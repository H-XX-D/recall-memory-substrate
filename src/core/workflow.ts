import { WRITE_SCHEMA_VERSION, type ProposalScope, type WriteProposal } from "./types.js";

export interface WorkCandidateInput {
  id?: string;
  title: string;
  description?: string;
  impact?: number;
  uncertainty?: number;
  concern?: number;
  dependencyWeight?: number;
  cost?: number;
  reversibility?: number;
  novelty?: number;
  tags?: string[];
}

export interface ScoredWorkCandidate {
  id: string;
  title: string;
  description?: string;
  impact: number;
  uncertainty: number;
  concern: number;
  dependencyWeight: number;
  cost: number;
  reversibility: number;
  novelty: number;
  score: number;
  rationale: string[];
  tags: string[];
}

export interface WorkAllocationReport {
  createdAt: string;
  candidates: ScoredWorkCandidate[];
  selected: ScoredWorkCandidate[];
  limit: number;
  method: "substrate-lo-nlo-v1";
}

export interface BlindLockInput {
  title: string;
  prediction: string;
  expectedBy?: string;
  falsifier?: string;
  project?: string;
  path?: string;
  tenant?: string;
  confidence?: number;
  createdAt?: string;
  tags?: string[];
}

export function allocateWork(candidates: WorkCandidateInput[], limit = 8, now = new Date()): WorkAllocationReport {
  const scored = candidates.map(scoreCandidate).sort((a, b) => b.score - a.score);
  return {
    createdAt: now.toISOString(),
    candidates: scored,
    selected: scored.slice(0, Math.max(1, limit)),
    limit,
    method: "substrate-lo-nlo-v1"
  };
}

export function allocationToProposal(
  report: WorkAllocationReport,
  scope: ProposalScope = { project: "Recall", tenant: "local", session: "workflow" }
): WriteProposal {
  return {
    schema_version: WRITE_SCHEMA_VERSION,
    actor: {
      kind: "daemon",
      id: "recall-workflow",
      display: "Recall Workflow"
    },
    intent: {
      kind: "allocation_plan",
      operation: "create"
    },
    content: {
      title: "Workflow allocation plan",
      summary: `${report.selected.length} selected from ${report.candidates.length} candidates.`,
      body: stableJson(report)
    },
    scope,
    tags: {
      category: ["workflow"],
      type: ["allocation_plan"],
      subject: ["work-allocation"],
      project: [scope.project],
      idea: ["lo-nlo-allocation"],
      timestamp: [report.createdAt.slice(0, 10)],
      topics: ["workflow", "allocation", "verification"],
      entities: ["Recall"],
      identities: ["engine:workflow"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["derived"],
      sensitivity: ["public"],
      permission: ["read", "background"]
    },
    evidence: {
      source_refs: ["recall:workflow.allocate"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      value: 0.72,
      uncertainty: 0.28,
      concern: report.selected[0]?.concern ?? 0.3,
      source_quality: "medium",
      stability: "volatile"
    },
    provenance: {
      created_at: report.createdAt,
      origin: "daemon",
      produced_by: "recall-workflow",
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
}

export function blindLockToProposal(input: BlindLockInput): WriteProposal {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const project = input.project ?? "Recall";
  return {
    schema_version: WRITE_SCHEMA_VERSION,
    actor: {
      kind: "human",
      id: "user",
      display: "User"
    },
    intent: {
      kind: "blind_lock",
      operation: "create"
    },
    content: {
      title: input.title,
      summary: input.prediction,
      body: stableJson({
        kind: "blind_lock",
        prediction: input.prediction,
        expectedBy: input.expectedBy ?? null,
        falsifier: input.falsifier ?? null,
        lockedAt: createdAt
      })
    },
    scope: {
      project,
      path: input.path,
      tenant: input.tenant ?? "local",
      session: "blind-lock"
    },
    tags: {
      category: ["workflow"],
      type: ["blind_lock"],
      subject: input.tags ?? ["prediction"],
      project: [project],
      idea: ["blind-lock"],
      timestamp: [createdAt.slice(0, 10)],
      topics: ["prediction", "verification", "workflow"],
      entities: [project],
      identities: ["user:local"],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["pre-registered"],
      sensitivity: ["private"],
      permission: ["read"]
    },
    evidence: {
      source_refs: ["user:blind-lock"],
      depends_on: [],
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      value: probability(input.confidence ?? 0.6),
      uncertainty: probability(1 - (input.confidence ?? 0.6)),
      concern: 0.5,
      source_quality: "medium",
      stability: "stable"
    },
    provenance: {
      created_at: createdAt,
      origin: "human",
      produced_by: "user",
      verification: "unverified",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "private",
      allow_background_use: true,
      requires_review: false,
      expires_at: null,
      reverify_after: input.expectedBy ?? null
    }
  };
}

function scoreCandidate(input: WorkCandidateInput, index: number): ScoredWorkCandidate {
  const impact = probability(input.impact ?? 0.5);
  const uncertainty = probability(input.uncertainty ?? 0.5);
  const concern = probability(input.concern ?? 0.4);
  const dependencyWeight = probability(input.dependencyWeight ?? 0.5);
  const cost = Math.max(0.05, input.cost ?? 0.5);
  const reversibility = probability(input.reversibility ?? 0.5);
  const novelty = probability(input.novelty ?? 0.3);
  const score = round((impact * (uncertainty + concern + novelty) * (0.5 + dependencyWeight) * (0.5 + reversibility / 2)) / cost);
  const rationale = [
    `impact=${impact}`,
    `uncertainty=${uncertainty}`,
    `concern=${concern}`,
    `dependency=${dependencyWeight}`,
    `cost=${cost}`,
    `reversibility=${reversibility}`,
    `novelty=${novelty}`
  ];

  return {
    id: input.id ?? `candidate-${index + 1}`,
    title: input.title,
    description: input.description,
    impact,
    uncertainty,
    concern,
    dependencyWeight,
    cost,
    reversibility,
    novelty,
    score,
    rationale,
    tags: input.tags ?? []
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function probability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
