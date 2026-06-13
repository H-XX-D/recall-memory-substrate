import { compileContext, formatContextPacket } from "./context-compiler.js";
import type { RecallStore } from "./store.js";
import { WRITE_SCHEMA_VERSION } from "./types.js";
import type { ProposalScope, WriteProposal } from "./types.js";

// Inception: compile a slice of the graph on an open objective, then hand the
// model a pre-grounded write-back template so it can synthesize ONE new cell
// (a "dream") derived from those sources. The generative step stays in the
// model on purpose — putting an LLM inside Recall would break the no-model
// trust loop. Recall's job is to gather the slice, scaffold the synthesis, and
// guarantee the new row is born linked to its sources, then admit it through
// the same firewall as any other write so it earns trust over time.

export interface InceptionSource {
  id: string;
  cellAddress: string;
  kind: string;
  title: string;
}

export interface InceptionScaffold {
  objective: string;
  sources: InceptionSource[];
  packet: string;
  directive: string;
  writebackTemplate: WriteProposal;
}

export interface InceptionOptions {
  objective: string;
  project: string;
  createdAt: string;
  producedBy?: string;
  maxSources?: number;
  budgetWords?: number;
}

const DEFAULT_MAX_SOURCES = 12;
const DEFAULT_BUDGET_WORDS = 700;
const TITLE_CLIP = 96;

export function buildInceptionScaffold(store: RecallStore, options: InceptionOptions): InceptionScaffold {
  const maxSources = Math.max(2, options.maxSources ?? DEFAULT_MAX_SOURCES);
  const nodes = store.search(options.objective, maxSources);
  const sources: InceptionSource[] = nodes.map((node) => ({
    id: node.id,
    cellAddress: node.cellAddress,
    kind: node.kind,
    title: clip(node.title, TITLE_CLIP)
  }));

  const packet = formatContextPacket(
    compileContext(store, {
      task: options.objective,
      budgetWords: options.budgetWords ?? DEFAULT_BUDGET_WORDS
    })
  );

  const producedBy = options.producedBy ?? "recall-inception";
  const scope: ProposalScope = { project: options.project, tenant: "local", session: "inception" };
  const dateTag = options.createdAt.slice(0, 10);

  // The grounding guarantee: depends_on is pre-populated with the slice's cell
  // ids, so any cell incepted through this path is born linked to its sources.
  const writebackTemplate: WriteProposal = {
    schema_version: WRITE_SCHEMA_VERSION,
    actor: { kind: "llm", id: producedBy, display: "Inception synthesis" },
    intent: { kind: "hypothesis", operation: "create" },
    content: { title: "", body: "", summary: "" },
    scope,
    tags: {
      category: ["synthesis"],
      type: ["incepted", "hypothesis"],
      subject: ["inception"],
      project: [options.project],
      timestamp: [dateTag],
      topics: ["inception"],
      entities: [options.project],
      identities: [`actor:${producedBy}`, `producer:${producedBy}`],
      rings: ["runtime"],
      lifecycle: ["active"],
      quality: ["model-synthesized", "unverified"],
      sensitivity: ["public"],
      permission: ["read"]
    },
    evidence: {
      source_refs: [`inception/${slug(options.objective)}`],
      depends_on: sources.map((source) => source.id),
      supports: [],
      contradicts: [],
      concerns: []
    },
    confidence: {
      // A dream is a hypothesis until the graph vets it: conservative by default.
      value: 0.5,
      uncertainty: 0.4,
      concern: 0.2,
      source_quality: "medium",
      stability: "volatile"
    },
    provenance: {
      created_at: options.createdAt,
      origin: "llm",
      produced_by: producedBy,
      verification: "unverified",
      signature_status: "unsigned"
    },
    policy: {
      sensitivity: "public",
      allow_background_use: true,
      // Deliberately false: the synthesis must LAND so the graph can vet it
      // over time. Its unvetted status is carried by kind=hypothesis,
      // conservative confidence, and the "unverified" quality tag, not by a
      // hard review block that would keep it out of the graph entirely.
      requires_review: false,
      expires_at: null,
      reverify_after: null
    }
  };

  const directive = [
    `INCEPTION. Synthesize exactly ONE new cell from the ${sources.length} source cell(s) above.`,
    "Aim for something not already written: a novel method, a connection across distant cells,",
    "or an insight implied by a contradiction between them.",
    "Fill writebackTemplate.content (title, body, summary); in the body, name which sources combined into the idea,",
    "and add real topics/subject tags.",
    "Set an honest confidence. This is a hypothesis until the graph vets it, so do not inflate it.",
    "Leave evidence.depends_on as-is: it already grounds this synthesis in its sources, which is the point.",
    "Then admit the filled template through the normal write path. It lands gated and provenance-stamped,",
    "and earns trust over time like any other cell, supported, contradicted, or superseded as evidence arrives."
  ].join(" ");

  return { objective: options.objective, sources, packet, directive, writebackTemplate };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "inception";
}
