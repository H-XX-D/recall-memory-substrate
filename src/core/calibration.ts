import { cellReferenceTarget } from "./references.js";
import type { RecallStore } from "./store.js";
import type { RecallNode } from "./types.js";

export interface ActorCalibration {
  actor: string;
  cells: number;
  contradicted: number;
  contradictedRate: number;
  meanConfidence: number;
  /** Mean stated confidence of this actor's contradicted cells — the overconfidence signal. */
  meanConfidenceContradicted: number | null;
  /** Brier score of stated confidence vs survived-contradiction outcomes; lower is better calibrated. */
  brierScore: number;
}

export function analyzeCalibration(store: RecallStore, limit = 1000): ActorCalibration[] {
  return calibrationFromNodes(store.listNodes(limit).filter((node) => node.status === "active"));
}

export function calibrationFromNodes(nodes: RecallNode[]): ActorCalibration[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const contradictedIds = new Set<string>();
  for (const node of nodes) {
    for (const reference of contradictsReferences(node)) {
      const targetId = cellReferenceTarget(reference);
      if (byId.has(targetId)) {
        contradictedIds.add(targetId);
      }
    }
  }

  const byActor = new Map<string, RecallNode[]>();
  for (const node of nodes) {
    const actor = producedBy(node);
    const group = byActor.get(actor);
    if (group) {
      group.push(node);
    } else {
      byActor.set(actor, [node]);
    }
  }

  const report: ActorCalibration[] = [];
  for (const [actor, cells] of byActor) {
    const confidences = cells.map(confidenceValue);
    const contradicted = cells.filter((cell) => contradictedIds.has(cell.id));
    // Outcome model: a cell that attracted a resolved contradiction failed (0);
    // a cell still standing succeeded (1). Brier is a proper scoring rule, so
    // an actor cannot improve their score by hedging dishonestly.
    const brier =
      cells.reduce((sum, cell, index) => {
        const outcome = contradictedIds.has(cell.id) ? 0 : 1;
        return sum + (confidences[index] - outcome) ** 2;
      }, 0) / cells.length;
    report.push({
      actor,
      cells: cells.length,
      contradicted: contradicted.length,
      contradictedRate: round(contradicted.length / cells.length),
      meanConfidence: round(mean(confidences)),
      meanConfidenceContradicted: contradicted.length > 0 ? round(mean(contradicted.map(confidenceValue))) : null,
      brierScore: round(brier)
    });
  }

  // Worst calibration first: the report doubles as a trust triage list.
  report.sort((a, b) => b.brierScore - a.brierScore || b.cells - a.cells || a.actor.localeCompare(b.actor));
  return report;
}

function contradictsReferences(node: RecallNode): string[] {
  const evidence = node.data.evidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return [];
  }
  const contradicts = (evidence as { contradicts?: unknown }).contradicts;
  return Array.isArray(contradicts) ? contradicts.filter((item): item is string => typeof item === "string") : [];
}

function producedBy(node: RecallNode): string {
  const producer = node.provenance?.produced_by;
  return typeof producer === "string" && producer.trim() !== "" ? producer : "unknown";
}

function confidenceValue(node: RecallNode): number {
  const confidence = node.data.confidence;
  if (typeof confidence === "object" && confidence !== null && !Array.isArray(confidence)) {
    const value = (confidence as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value));
    }
  }
  return 0.5;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
