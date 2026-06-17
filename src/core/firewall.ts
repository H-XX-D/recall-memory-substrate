import type { ValidationIssue, WriteProposal } from "./types.js";

export interface FirewallResult {
  allowed: boolean;
  issues: ValidationIssue[];
  warnings: string[];
}

// High-recall heuristic, NOT a guarantee: this catches common secret shapes so an
// agent does not casually paste credentials into the primary graph. It is a backstop,
// not a control — never rely on it as the only thing keeping a secret out. Real secrets
// belong in the encrypted side graph (`recall secrets save`). Tuned to favor recall;
// it may occasionally reject a benign write that looks credential-shaped (rephrase it).
const SECRET_PATTERNS: readonly { name: string; regex: RegExp }[] = [
  { name: "OpenAI API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Stripe secret key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "AWS access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "AWS secret access key", regex: /\baws_?secret_?access_?key\b\s*[:=]\s*["']?[A-Za-z0-9/+]{40}/i },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "private key block", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "generic bearer token", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  { name: "URI-embedded credentials", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
  // a secret-named key assigned a contiguous value (catches `password: hunter2`,
  // `db_password=...`, `client_secret = ...`); the 6+ non-space run avoids prose like
  // "password reset flow" or "see the vault".
  { name: "secret-named assignment", regex: /\b(?:passwd|password|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|db[_-]?password)\b["']?\s*[:=]\s*["']?\S{6,}/i },
  // KEY=value env dumps where the key name itself screams secret (`export DB_PASSWORD=...`).
  { name: "secret env assignment", regex: /\b(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*["']?\S{6,}/ }
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

