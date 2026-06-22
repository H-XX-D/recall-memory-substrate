import type { RecallStore } from "./store.js";
import type { HyperedgeProgramSpec } from "./types.js";

// The trend scaffold is the agent-native counterpart to a blocking prompt, the
// same idea as Inception: instead of asking questions interactively, it hands
// the agent a fillable trend-program spec template (the parameters, the mover,
// and the trip constraints) plus candidate member cells from an objective
// search and a directive. The agent fills the template, bundles the movers it
// wants into a hyperedge, and attaches the program. The generative choice stays
// with the agent; the substrate only scaffolds and guarantees a valid spec.

export interface TrendMover {
  id: string;
  cellAddress: string;
  kind: string;
  title: string;
}

export interface TrendScaffold {
  objective: string;
  movers: TrendMover[];
  directive: string;
  specTemplate: HyperedgeProgramSpec;
}

export interface TrendScaffoldOptions {
  objective: string;
  maxMovers?: number;
  measure?: "effective_confidence" | "member_count" | "numeric";
  path?: string;
  window?: number;
  delta?: number;
  streak?: number;
}

const DEFAULT_MAX_MOVERS = 12;
const TITLE_CLIP = 96;

export function buildTrendScaffold(store: RecallStore, options: TrendScaffoldOptions): TrendScaffold {
  const maxMovers = Math.max(1, options.maxMovers ?? DEFAULT_MAX_MOVERS);
  const movers: TrendMover[] = store.search(options.objective, maxMovers).map((node) => ({
    id: node.id,
    cellAddress: node.cellAddress,
    kind: node.kind,
    title: node.title.length > TITLE_CLIP ? `${node.title.slice(0, TITLE_CLIP - 1)}...` : node.title
  }));

  const params: Record<string, unknown> = {
    measure: options.measure ?? "effective_confidence",
    window: options.window ?? 8,
    delta: options.delta ?? 0.1,
    streak: options.streak ?? 3
  };
  if (options.path && options.path.trim().length > 0) {
    params.path = options.path.trim().replace(/^#/, "");
  }

  const specTemplate: HyperedgeProgramSpec = {
    schemaVersion: "recall.program.v1",
    operation: "trend",
    description: "",
    params
  };

  const directive =
    "Fill this trend program in three parts, then attach it. " +
    "PARAMETERS: window is how many runs the sliding series keeps. " +
    "MOVER: measure is what the trend tracks across runs: effective_confidence (the bundle's mean live trust), member_count, or numeric. " +
    "For numeric trends, use member references with `#path` such as `recall://cell/...#data.metrics.updates_per_s`, or set params.path as a fallback for members without their own path. " +
    "CONSTRAINTS: the trip conditions, where streak is how many consecutive same-direction runs trip it and delta is the slope magnitude that trips it on its own. " +
    "Choose which of the candidate movers below to bundle into a hyperedge, set description to what this trend watches and why, then attach with `recall program add <hyperedgeId>` and run it on a schedule. " +
    "Each run appends the bundle's current value to the series and reads off direction, slope (a discrete rate), and acceleration (the second difference); a tripped run files a witness through admission like any other actor.";

  return { objective: options.objective, movers, directive, specTemplate };
}
