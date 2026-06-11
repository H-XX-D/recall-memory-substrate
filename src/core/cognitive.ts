import { analyzeMemory, memoryHealthToProposal, type CuriosityTarget, type MemoryHealthReport } from "./analysis.js";
import { buildPageIndex, type RecallPageIndex } from "./pages.js";
import type { RecallStore } from "./store.js";
import type { AdmissionResult, WriteProposal } from "./types.js";
import { admitWriteProposal } from "./admission.js";

export interface CognitiveTickPhase {
  name: string;
  summary: string;
  metrics?: Record<string, unknown>;
}

export interface CognitiveTickReport {
  createdAt: string;
  phases: CognitiveTickPhase[];
  memoryHealth: MemoryHealthReport;
  pageIndex: RecallPageIndex;
  planner: {
    recommendation: string;
    candidates: CuriosityTarget[];
  };
  emitted: {
    summary: string;
    writeProposal: WriteProposal;
  };
}

export interface CognitiveTickResult {
  report: CognitiveTickReport;
  result?: AdmissionResult;
}

export function runCognitiveTick(store: RecallStore, now = new Date(), derive = false): CognitiveTickResult {
  const report = buildCognitiveTickReport(store, now);
  const result = derive
    ? admitWriteProposal(report.emitted.writeProposal, store, { derivationKey: `cognitive-tick:${report.createdAt.slice(0, 10)}` })
    : undefined;
  return { report, result };
}

export function buildCognitiveTickReport(store: RecallStore, now = new Date()): CognitiveTickReport {
  const memoryHealth = analyzeMemory(store, now);
  const pageIndex = buildPageIndex(store, now);
  const candidates = memoryHealth.curiosityTargets.slice(0, 8);
  const recommendation = candidates[0]?.suggestedAction ?? "continue normal LLM-managed write-back";
  const writeProposal = memoryHealthToProposal(memoryHealth, {
    project: "Recall",
    tenant: "local",
    session: "cognitive-tick"
  });
  writeProposal.content.title = "Recall cognitive tick";
  writeProposal.content.summary = `Tick ran ${candidates.length} curiosity/planner candidate(s); recommendation: ${recommendation}.`;
  writeProposal.content.body = JSON.stringify(
    {
      kind: "cognitive_tick",
      createdAt: now.toISOString(),
      phases: [
        "ingest",
        "decay",
        "evaluate",
        "attend",
        "plan",
        "act",
        "cognition",
        "epistemic_repair",
        "emit",
        "persist"
      ],
      memoryHealth,
      pageIndex,
      planner: { recommendation, candidates }
    },
    null,
    2
  );
  writeProposal.tags.type = ["maintenance_observation", "cognitive_tick"];
  writeProposal.tags.subject = ["daemon", "cognitive-loop", "planner", "epistemic-repair"];
  writeProposal.tags.topics = ["daemon", "maintenance", "cognitive-loop", "planner", "epistemic-repair"];
  writeProposal.tags.identities = ["daemon:recall", "engine:cognitive-tick"];

  return {
    createdAt: now.toISOString(),
    phases: [
      phase("ingest", "Read active graph cells and current runtime counters.", { nodes: memoryHealth.stats.nodes, relations: memoryHealth.stats.relations }),
      phase("decay", "Computed stale, expired, low-trust, volatile, and ephemeral memory pressure.", { stale: memoryHealth.stale.length }),
      phase("evaluate", "Scored beliefs with trust-weighted evidence, contradiction pressure, and source independence.", {
        beliefs: memoryHealth.beliefs.length,
        warnings: memoryHealth.criticalWarnings.length
      }),
      phase("attend", "Built compact page index for bounded focus instead of dumping the full graph.", { pages: pageIndex.pages.length }),
      phase("plan", "Ranked curiosity and repair targets by planning pressure.", { candidates: candidates.length, recommendation }),
      phase("act", "Prepared a rollbackable maintenance witness; no raw graph writes bypass admission.", { durableWrite: "optional" }),
      phase("cognition", "Ran curiosity, contradiction, provenance, stale-memory, and coverage checks.", {
        curiosityTargets: memoryHealth.curiosityTargets.length
      }),
      phase("epistemic_repair", "Produced repair recommendations without silently overwriting belief cells.", {
        repairTargets: memoryHealth.beliefs.filter((belief) => belief.recommendation !== "trust").length
      }),
      phase("emit", "Returned a compact report for CLI, TUI, MCP, or daemon use.", { summary: recommendation }),
      phase("persist", "Can persist the tick through the same strict admission and rollback path when derive=true.", { derive: false })
    ],
    memoryHealth,
    pageIndex,
    planner: {
      recommendation,
      candidates
    },
    emitted: {
      summary: writeProposal.content.summary ?? recommendation,
      writeProposal
    }
  };
}

function phase(name: string, summary: string, metrics?: Record<string, unknown>): CognitiveTickPhase {
  return { name, summary, metrics };
}
