import type { ValidationIssue, WriteProposal } from "./types.js";

export interface FirewallResult {
  allowed: boolean;
  issues: ValidationIssue[];
  warnings: string[];
}

// Credential firewall: rejects content matching known secret shapes so an agent cannot
// paste a live credential into the primary graph. Patterns are anchored on distinctive
// vendor prefixes, structural key formats, and secret-named assignments, and are
// deliberately precision-first: they do NOT trip on the graph's own UUID/hex cell
// identifiers (every `recall://cell/<uuid>` reference). Credentials you actually need to
// keep go in the encrypted side graph (`recall secrets save`).
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
  { name: "secret env assignment", regex: /\b(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*["']?\S{6,}/ },
  // Vendor tokens with distinctive prefixes — high precision, no collision with UUID/hex ids.
  { name: "GitLab PAT", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "npm token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "Hugging Face token", regex: /\bhf_[A-Za-z0-9]{20,}\b/ },
  { name: "SendGrid API key", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: "Shopify access token", regex: /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{16,}\b/ },
  { name: "DigitalOcean token", regex: /\bdop_v1_[a-f0-9]{32,}\b/ },
  { name: "Doppler token", regex: /\bdp\.pt\.[A-Za-z0-9]{32,}\b/ },
  { name: "Square access token", regex: /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Telegram bot token", regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "Twilio API key", regex: /\bSK[0-9a-fA-F]{32}\b/ },
  { name: "Mailgun key", regex: /\bkey-[0-9a-f]{32}\b/ }
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

