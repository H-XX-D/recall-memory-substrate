import { createHash } from "node:crypto";
import { WRITE_SCHEMA_VERSION, type DagAnalysis, type ProgramRun, type ProposalScope, type WriteProposal } from "./types.js";
import type { RecallEvalResult } from "./evals.js";

export interface DerivationProposalOptions {
  scope: ProposalScope;
  actorId?: string;
  actorDisplay?: string;
  producedBy?: string;
}

export interface DagDerivationProposalOptions extends DerivationProposalOptions {
  createdAt: string;
  concernThreshold?: number;
}

export interface KeyedWriteProposal {
  derivationKey: string;
  proposal: WriteProposal;
}

export function programRunDerivationKey(run: ProgramRun): string {
  return derivationKey("program-run", {
    programId: run.programId,
    hyperedgeId: run.hyperedgeId,
    output: run.output
  });
}

export function evalResultDerivationKey(result: RecallEvalResult): string {
  return derivationKey("eval-run", {
    name: result.name,
    passed: result.passed,
    score: result.score,
    cases: result.cases
  });
}

export function programRunToWitnessProposal(
  run: ProgramRun,
  options: DerivationProposalOptions
): WriteProposal {
  const witness = recordAt(run.output, "witness");
  const outputTitle = stringAt(witness, "title");
  const outputSummary = stringAt(witness, "summary");
  const score = numberAt(run.output, "score");
  const maxConcern = numberAt(run.output, "maxConcern");

  return makeDerivedProposal({
    options,
    createdAt: run.createdAt,
    actorKind: "program",
    intentKind: "witness",
    title: outputTitle ?? `Program run witness: ${run.id}`,
    summary: outputSummary ?? `Program ${run.programId} produced deterministic output.`,
    body: stableJson({
      kind: "program_run",
      id: run.id,
      programId: run.programId,
      hyperedgeId: run.hyperedgeId,
      output: run.output,
      createdAt: run.createdAt
    }),
    sourceRefs: [`program_runs/${run.id}`, `programs/${run.programId}`, `hyperedges/${run.hyperedgeId}`],
    dependsOn: [run.hyperedgeId],
    topics: ["runtime", "program"],
    entities: [run.programId, run.hyperedgeId],
    rings: ["runtime"],
    typeTags: ["program_run", "witness"],
    subjectTags: [run.id],
    confidenceValue: score ?? 0.7,
    uncertainty: score === null ? 0.2 : round(1 - score),
    concern: maxConcern ?? 0.2,
    sourceQuality: "high",
    stability: "stable",
    verification: "checked"
  });
}

export function dagAnalysisToProposals(
  analysis: DagAnalysis,
  options: DagDerivationProposalOptions
): WriteProposal[] {
  return dagAnalysisToKeyedProposals(analysis, options).map((item) => item.proposal);
}

export function dagAnalysisToKeyedProposals(
  analysis: DagAnalysis,
  options: DagDerivationProposalOptions
): KeyedWriteProposal[] {
  const proposals: KeyedWriteProposal[] = [];
  const concernThreshold = options.concernThreshold ?? 0.5;

  for (const witness of analysis.witnesses) {
    const sourceRefs = [`dag_overlays/${analysis.overlayId}`, `dag_overlays/${analysis.overlayId}/holonomy/${witness.from}/${witness.to}`];
    const proposal = makeDerivedProposal({
        options,
        createdAt: options.createdAt,
        actorKind: "daemon",
        intentKind: "witness",
        title: `DAG holonomy witness: ${witness.from} -> ${witness.to}`,
        summary: `${witness.pathCount} paths expose ${witness.signatures.length} distinct signatures.`,
        body: stableJson({
          kind: "dag_holonomy_witness",
          overlayId: analysis.overlayId,
          witness
        }),
        sourceRefs,
        dependsOn: [analysis.overlayId],
        topics: ["dag", "holonomy"],
        entities: [analysis.overlayId, witness.from, witness.to],
        rings: ["runtime"],
        typeTags: ["dag_holonomy", "witness"],
        subjectTags: [analysis.overlayId, witness.from, witness.to],
        confidenceValue: round(1 - witness.concern / 2),
        uncertainty: round(witness.concern / 2),
        concern: witness.concern,
        sourceQuality: "high",
        stability: "stable",
        verification: "checked"
      });
    proposals.push({
      derivationKey: derivationKey("dag-holonomy-witness", {
        overlayId: analysis.overlayId,
        from: witness.from,
        to: witness.to,
        pathCount: witness.pathCount,
        signatures: witness.signatures
      }),
      proposal
    });

    if (witness.concern >= concernThreshold) {
      const concernProposal = makeDerivedProposal({
          options,
          createdAt: options.createdAt,
          actorKind: "daemon",
          intentKind: "risk",
          title: `DAG holonomy concern: ${witness.from} -> ${witness.to}`,
          summary: `Multiple path signatures disagree with concern ${round(witness.concern)}.`,
          body: stableJson({
            kind: "dag_holonomy_concern",
            overlayId: analysis.overlayId,
            witness
          }),
          sourceRefs,
          dependsOn: [analysis.overlayId],
          concerns: [witness.from, witness.to],
          topics: ["dag", "holonomy", "concern"],
          entities: [analysis.overlayId, witness.from, witness.to],
          rings: ["runtime"],
          typeTags: ["dag_holonomy", "concern"],
          subjectTags: [analysis.overlayId, witness.from, witness.to],
          confidenceValue: witness.concern,
          uncertainty: round(1 - witness.concern),
          concern: witness.concern,
          sourceQuality: "high",
          stability: "volatile",
          verification: "checked"
        });
      proposals.push({
        derivationKey: derivationKey("dag-holonomy-concern", {
          overlayId: analysis.overlayId,
          from: witness.from,
          to: witness.to,
          concern: witness.concern,
          signatures: witness.signatures
        }),
        proposal: concernProposal
      });
    }
  }

  for (const cycle of analysis.cycles) {
    const proposal = makeDerivedProposal({
        options,
        createdAt: options.createdAt,
        actorKind: "daemon",
        intentKind: "risk",
        title: `DAG cycle concern: ${cycle.join(" -> ")}`,
        summary: `Overlay ${analysis.overlayId} is not acyclic.`,
        body: stableJson({
          kind: "dag_cycle_concern",
          overlayId: analysis.overlayId,
          cycle
        }),
        sourceRefs: [`dag_overlays/${analysis.overlayId}`, `dag_overlays/${analysis.overlayId}/cycles`],
        dependsOn: [analysis.overlayId],
        concerns: cycle,
        topics: ["dag", "cycle", "concern"],
        entities: [analysis.overlayId, ...cycle],
        rings: ["runtime"],
        typeTags: ["dag_cycle", "concern"],
        subjectTags: [analysis.overlayId],
        confidenceValue: 0.95,
        uncertainty: 0.05,
        concern: 0.95,
        sourceQuality: "high",
        stability: "volatile",
        verification: "checked"
      });
    proposals.push({
      derivationKey: derivationKey("dag-cycle-concern", {
        overlayId: analysis.overlayId,
        cycle
      }),
      proposal
    });
  }

  return proposals;
}

export function evalResultToEvalRunProposal(
  result: RecallEvalResult,
  options: DerivationProposalOptions
): WriteProposal {
  return makeDerivedProposal({
    options,
    createdAt: result.createdAt,
    actorKind: "program",
    intentKind: "witness",
    title: `Eval run: ${result.name}`,
    summary: `${result.passed ? "Passed" : "Failed"} with score ${result.score}.`,
    body: stableJson({
      kind: "eval_run",
      result
    }),
    sourceRefs: [`eval_runs/${result.name}/${result.createdAt}`],
    topics: ["eval", "verification"],
    entities: [result.name],
    rings: ["runtime"],
    typeTags: ["eval_run", result.passed ? "passed" : "failed"],
    subjectTags: [result.name],
    confidenceValue: result.score,
    uncertainty: round(1 - result.score),
    concern: round(1 - result.score),
    sourceQuality: "high",
    stability: "stable",
    verification: "tested"
  });
}

interface DerivedProposalInput {
  options: DerivationProposalOptions;
  createdAt: string;
  actorKind: WriteProposal["actor"]["kind"];
  intentKind: WriteProposal["intent"]["kind"];
  title: string;
  body: string;
  summary: string;
  sourceRefs: string[];
  dependsOn?: string[];
  supports?: string[];
  contradicts?: string[];
  concerns?: string[];
  topics: string[];
  entities: string[];
  rings: string[];
  typeTags: string[];
  subjectTags: string[];
  confidenceValue: number;
  uncertainty: number;
  concern: number;
  sourceQuality: WriteProposal["confidence"]["source_quality"];
  stability: WriteProposal["confidence"]["stability"];
  verification: WriteProposal["provenance"]["verification"];
}

function makeDerivedProposal(input: DerivedProposalInput): WriteProposal {
  const actorId = input.options.actorId ?? input.options.producedBy ?? "recall-derivation";
  const producedBy = input.options.producedBy ?? actorId;
  const dateTag = input.createdAt.slice(0, 10);

  return {
    schema_version: WRITE_SCHEMA_VERSION,
    actor: {
      kind: input.actorKind,
      id: actorId,
      display: input.options.actorDisplay
    },
    intent: {
      kind: input.intentKind,
      operation: "create"
    },
    content: {
      title: input.title,
      body: input.body,
      summary: input.summary
    },
    scope: input.options.scope,
    tags: {
      category: ["derivation"],
      type: unique(["derived", ...input.typeTags]),
      subject: unique(input.subjectTags),
      project: [input.options.scope.project],
      timestamp: [dateTag],
      topics: unique(input.topics),
      entities: unique(input.entities),
      identities: unique([`actor:${actorId}`, `producer:${producedBy}`]),
      rings: unique(input.rings),
      lifecycle: ["active"],
      quality: ["source-grounded", "deterministic"],
      sensitivity: ["public"],
      permission: ["read"]
    },
    evidence: {
      source_refs: unique(input.sourceRefs),
      depends_on: unique(input.dependsOn ?? []),
      supports: unique(input.supports ?? []),
      contradicts: unique(input.contradicts ?? []),
      concerns: unique(input.concerns ?? [])
    },
    confidence: {
      value: probability(input.confidenceValue),
      uncertainty: probability(input.uncertainty),
      concern: probability(input.concern),
      source_quality: input.sourceQuality,
      stability: input.stability
    },
    provenance: {
      created_at: input.createdAt,
      origin: input.actorKind === "daemon" ? "daemon" : "program",
      produced_by: producedBy,
      verification: input.verification,
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

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function derivationKey(kind: string, value: unknown): string {
  const hash = createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
  return `${kind}:${hash}`;
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function probability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return round(Math.min(1, Math.max(0, value)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAt(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
