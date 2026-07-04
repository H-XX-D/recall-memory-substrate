// R1 firewall: pure pre-admission checks on a write proposal.
// (1) screenSecrets scans proposal text for credential patterns and blocks
//     public writes that appear to carry personal data.
// (2) attenuateConfidence caps high confidence unless the proposal carries
//     actual support evidence.

import type { WriteProposal, ValidationIssue } from "./types.js";

// Precision-first secret patterns. Each entry names the secret type for the
// emitted ValidationIssue. Anchored with word boundaries to avoid tripping on
// bare UUIDs and other benign hex/identifier strings.
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "OpenAI API key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  { name: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  {
    name: "secret-named assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?\S{6,}/i,
  },
];

export function screenSecrets(
  proposal: WriteProposal
): { allowed: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const fields = textFields(proposal);
  for (const field of fields) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(field.text)) {
        issues.push({ path: field.path, message: `possible ${name} detected` });
      }
    }
  }
  if (proposal.sensitivity === "public") {
    for (const field of fields) {
      for (const { name, re } of PUBLIC_DATA_PATTERNS) {
        if (re.test(field.text)) {
          issues.push({ path: field.path, message: `public write may expose ${name}` });
        }
      }
    }
  }
  return { allowed: issues.length === 0, issues };
}

export function attenuateConfidence(
  proposal: WriteProposal
): { confidence: number; warnings: string[]; attenuations: string[] } {
  const weakSupport = !hasSupportEvidence(proposal);
  if (weakSupport && proposal.confidence > 0.7) {
    const old = proposal.confidence;
    return {
      confidence: 0.7,
      warnings: ["unsupported high confidence was attenuated"],
      attenuations: [`confidence ${old.toFixed(2)} -> 0.70`],
    };
  }
  return { confidence: proposal.confidence, warnings: [], attenuations: [] };
}

const PUBLIC_DATA_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email address", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "US social security number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "phone number", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
];

function hasSupportEvidence(proposal: WriteProposal): boolean {
  if ((proposal.sourceRefs?.length ?? 0) > 0) return true;
  if (
    proposal.verification === "checked" ||
    proposal.verification === "tested" ||
    proposal.verification === "external"
  ) {
    return true;
  }
  return (proposal.edges ?? []).some((edge) => {
    if (edge.relation === "derived_from") return true;
    if (edge.relation !== "supports") return false;
    return (edge.weight ?? 1) > 0;
  });
}

function textFields(proposal: WriteProposal): { path: string; text: string }[] {
  const fields: { path: string; text: string }[] = [
    { path: "title", text: proposal.title },
    { path: "body", text: proposal.body },
  ];
  pushString(fields, "owner", proposal.owner);
  pushString(fields, "summary", proposal.summary);
  pushStrings(fields, "topics", proposal.topics);
  pushStrings(fields, "entities", proposal.entities);
  pushStrings(fields, "lifecycle", proposal.lifecycle);
  pushStrings(fields, "quality", proposal.quality);
  pushStrings(fields, "subject", proposal.subject);
  pushStrings(fields, "sourceRefs", proposal.sourceRefs);
  pushStrings(fields, "programs", proposal.programs);
  proposal.hyperedges?.forEach((h, i) => {
    pushString(fields, `hyperedges[${i}].id`, h.id);
    pushString(fields, `hyperedges[${i}].role`, h.role);
  });
  pushString(fields, "project", proposal.project);
  pushString(fields, "tenant", proposal.tenant);
  collectPropStrings(fields, "props", proposal.props);
  return fields;
}

function pushString(
  fields: { path: string; text: string }[],
  path: string,
  value: unknown,
): void {
  if (typeof value === "string") fields.push({ path, text: value });
}

function pushStrings(
  fields: { path: string; text: string }[],
  path: string,
  values: string[] | undefined,
): void {
  values?.forEach((text, i) => fields.push({ path: `${path}[${i}]`, text }));
}

function collectPropStrings(
  fields: { path: string; text: string }[],
  path: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    fields.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectPropStrings(fields, `${path}[${i}]`, item));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectPropStrings(fields, `${path}.${key}`, item);
    }
  }
}
