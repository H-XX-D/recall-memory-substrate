import type { ValidationIssue, WriteProposal } from "./types.js";

export interface FirewallResult {
  allowed: boolean;
  issues: ValidationIssue[];
  warnings: string[];
}

const SECRET_PATTERNS: readonly { name: string; regex: RegExp }[] = [
  { name: "OpenAI API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic bearer token", regex: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/i }
];

export function reviewFirewall(proposal: WriteProposal): FirewallResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const searchable = JSON.stringify({
    content: proposal.content,
    evidence: proposal.evidence,
    tags: proposal.tags
  });

  if (proposal.policy.sensitivity === "secret") {
    issues.push({
      path: "policy.sensitivity",
      code: "secret_rejected",
      message: "Recall rejects secret writes by default"
    });
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(searchable)) {
      issues.push({
        path: "content",
        code: "secret_pattern",
        message: `Secret-looking content detected: ${pattern.name}`
      });
    }
  }

  if (proposal.policy.sensitivity === "private") {
    warnings.push("private write accepted only as local scoped memory");
  }

  if (proposal.confidence.stability === "ephemeral" && proposal.policy.expires_at === null) {
    warnings.push("ephemeral writes should usually include expires_at");
  }

  return {
    allowed: issues.length === 0,
    issues,
    warnings
  };
}

