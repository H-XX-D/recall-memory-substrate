// Thin proposal builder: turns minimal agent inputs into a schema-valid
// recall.write.v1 proposal, scaffolding the nine blocks (tag families, entity
// extraction, confidence -> source_quality, timestamps, policy defaults). The
// admission firewall is unchanged; this only thins the client-supplied syntax.
// Ported from the Python helper (scripts/recall_helper.py::build_proposal) so
// MCP and CLI share one TS-native builder.

import { INTENT_KINDS } from "./schema.js";
import type {
  IntentKind,
  Sensitivity,
  SourceQuality,
  Stability,
  Verification,
  WriteProposal,
} from "./types.js";

const STABILITIES = new Set<Stability>(["ephemeral", "volatile", "stable"]);
const VERIFICATIONS = new Set<Verification>(["unverified", "checked", "tested", "external"]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "private", "secret"]);
const KIND_SET = new Set<string>(INTENT_KINDS as readonly string[]);

export interface BuildProposalInput {
  kind: string;
  title: string;
  body: string;
  confidence: number; // (0, 1]; required, no default, to keep calibration honest
  topics: string[]; // non-empty
  summary?: string;
  dependsOn?: string[];
  supports?: string[];
  contradicts?: string[];
  concerns?: string[];
  sourceFiles?: string[];
  project?: string;
  subject?: string;
  tenant?: string;
  path?: string;
  session?: string;
  rings?: string[];
  lifecycle?: string[];
  quality?: string[];
  category?: string[];
  idea?: string[];
  extraEntities?: string[];
  identities?: string[];
  actorId?: string;
  actorDisplay?: string;
  uncertainty?: number;
  concern?: number;
  stability?: Stability;
  verification?: Verification;
  sensitivity?: Sensitivity;
  allowBackgroundUse?: boolean;
  requiresReview?: boolean;
  expiresAt?: string | null;
  reverifyAfter?: string | null;
  now?: Date; // injectable clock for tests
}

function kebab(text: string, maxLen = 80): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  return s || "untitled";
}

function confToQuality(v: number): SourceQuality {
  if (v >= 0.8) return "high";
  if (v >= 0.5) return "medium";
  if (v > 0) return "low";
  return "unknown";
}

function confToQualityTags(v: number): string[] {
  if (v >= 0.85) return ["verified", "calibrated"];
  if (v >= 0.7) return ["calibrated", "structural"];
  if (v >= 0.5) return ["calibrated", "speculative"];
  return ["speculative", "low-confidence"];
}

function normCellRef(ref: string): string {
  let r = ref.trim();
  if (r.startsWith("recall://")) return r;
  if (r.toLowerCase().startsWith("cell-")) r = r.slice(5);
  if (/^[a-f0-9]{8}[a-f0-9-]*$/i.test(r)) return `recall://cell/${r}`;
  return ref;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function extractEntities(
  title: string,
  body: string,
  sourceFiles: string[],
  cellRefs: string[],
): string[] {
  const out = new Set<string>();
  for (const ref of sourceFiles) {
    const path = ref.split("#", 1)[0];
    const base = path.split("/").pop() ?? "";
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem) out.add(stem);
  }
  for (const ref of cellRefs) {
    const m = /(?:recall:\/\/cell\/)?([a-f0-9]{8})[a-f0-9-]*/i.exec(ref);
    if (m) out.add(`cell-${m[1].toLowerCase()}`);
  }
  const text = `${title}\n${body.slice(0, 1000)}`;
  for (const m of text.matchAll(/\bfile[ -](\d+[a-z]*)\b/gi)) out.add(`file-${m[1].toLowerCase()}`);
  for (const m of text.matchAll(/\bA[_-][A-Za-z0-9]+\b/g)) out.add(m[0]);
  return [...out].sort().slice(0, 15);
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildProposal(input: BuildProposalInput): WriteProposal {
  const { kind, title, body, confidence } = input;
  if (!KIND_SET.has(kind)) throw new Error(`invalid kind: ${kind}`);
  if (!(confidence > 0 && confidence <= 1)) {
    throw new Error(`confidence must be in (0,1]: ${confidence}`);
  }
  if (!input.topics || input.topics.length === 0) throw new Error("topics must be non-empty");
  const stability: Stability = input.stability ?? "stable";
  const verification: Verification = input.verification ?? "checked";
  const sensitivity: Sensitivity = input.sensitivity ?? "private";
  if (!STABILITIES.has(stability)) throw new Error(`invalid stability: ${stability}`);
  if (!VERIFICATIONS.has(verification)) throw new Error(`invalid verification: ${verification}`);
  if (!SENSITIVITIES.has(sensitivity)) throw new Error(`invalid sensitivity: ${sensitivity}`);

  const project = input.project ?? "Substrate-V2";
  const actorId = input.actorId ?? "claude-code";
  const now = input.now ?? new Date();
  const summary = input.summary ?? title;
  const dependsOn = (input.dependsOn ?? []).map(normCellRef);
  const supports = (input.supports ?? []).map(normCellRef);
  const contradicts = (input.contradicts ?? []).map(normCellRef);
  const concerns = (input.concerns ?? []).map(normCellRef);
  const sourceFiles = input.sourceFiles ?? [];
  const cellRefs = [
    ...(input.dependsOn ?? []),
    ...(input.supports ?? []),
    ...(input.contradicts ?? []),
    ...(input.concerns ?? []),
  ];

  const entities = extractEntities(title, body, sourceFiles, cellRefs);
  for (const e of input.extraEntities ?? []) if (!entities.includes(e)) entities.push(e);
  if (!entities.includes(project)) entities.unshift(project);

  const uncertainty = input.uncertainty ?? round3((1 - confidence) * 0.7);
  const concern = input.concern ?? round3((1 - confidence) * 0.3);
  const tenant = input.tenant ?? `hendrixx-${kebab(project, 30)}`;

  const proposal: WriteProposal = {
    schema_version: "recall.write.v1",
    actor: input.actorDisplay
      ? { kind: "llm", id: actorId, display: input.actorDisplay }
      : { kind: "llm", id: actorId },
    intent: { kind: kind as IntentKind, operation: "create" },
    content: { title, body, summary },
    scope: {
      project,
      tenant,
      ...(input.path ? { path: input.path } : {}),
      ...(input.session ? { session: input.session } : {}),
    },
    tags: {
      topics: [...input.topics],
      entities,
      rings: input.rings ?? ["runtime"],
      lifecycle: input.lifecycle ?? ["active"],
      quality: input.quality ?? confToQualityTags(confidence),
      category: input.category ?? ["memory"],
      type: [kind],
      subject: [kebab(input.subject ?? title, 80)],
      project: [project],
      idea: input.idea ?? [kebab(title, 80)],
      timestamp: [isoZ(now).slice(0, 10)],
      ...(input.identities ? { identities: input.identities } : {}),
    },
    evidence: {
      source_refs: [...sourceFiles],
      depends_on: dependsOn,
      supports,
      contradicts,
      concerns,
    },
    confidence: {
      value: confidence,
      uncertainty,
      concern,
      stability,
      source_quality: confToQuality(confidence),
    },
    provenance: {
      created_at: isoZ(now),
      origin: "llm",
      produced_by: actorId,
      verification,
      signature_status: "unsigned",
    },
    policy: {
      sensitivity,
      allow_background_use: input.allowBackgroundUse ?? true,
      requires_review: input.requiresReview ?? false,
      expires_at: input.expiresAt ?? null,
      reverify_after: input.reverifyAfter ?? null,
    },
  };
  return proposal;
}
