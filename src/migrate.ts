import type { Kind } from "./types.js";

const KIND_MAP: Record<string, Kind> = {
  observation: "obs", verification_result: "ver", decision: "dec",
  reflection: "ref", lemma: "bel", risk: "rsk", task: "tsk",
  hypothesis: "hyp", preference: "bel", benchmark_run: "ver",
  checkpoint: "obs", objective: "obj", contradiction: "obs",
  meta: "obs", source: "ref", witness: "ver",
};

export function mapKind(old: string): Kind {
  return KIND_MAP[old] ?? "obs";
}
