import {
  WRITE_SCHEMA_VERSION,
  type ActorKind,
  type IntentKind,
  type IntentOperation,
  type ProposalTags,
  type ProvenanceOrigin,
  type Sensitivity,
  type SignatureStatus,
  type SourceQuality,
  type Stability,
  type ValidationIssue,
  type ValidationResult,
  type Verification,
  type WriteProposal
} from "./types.js";

const ACTOR_KINDS: readonly ActorKind[] = ["llm", "human", "daemon", "adapter", "program"];
const INTENT_KINDS: readonly IntentKind[] = [
  "observation",
  "witness",
  "belief_update",
  "task",
  "decision",
  "risk",
  "constraint",
  "program",
  "relation"
];
const INTENT_OPERATIONS: readonly IntentOperation[] = ["create", "update", "supersede", "link", "archive"];
const SOURCE_QUALITIES: readonly SourceQuality[] = ["unknown", "low", "medium", "high"];
const STABILITIES: readonly Stability[] = ["ephemeral", "volatile", "stable"];
const ORIGINS: readonly ProvenanceOrigin[] = ["human", "llm", "daemon", "adapter", "program", "external"];
const VERIFICATIONS: readonly Verification[] = ["unverified", "checked", "tested", "external"];
const SIGNATURE_STATUSES: readonly SignatureStatus[] = ["unsigned", "signed", "verified"];
const SENSITIVITIES: readonly Sensitivity[] = ["public", "private", "secret"];

const TAG_FAMILIES: readonly (keyof ProposalTags)[] = ["topics", "entities", "rings", "lifecycle", "quality"];

export function validateWriteProposal(input: unknown): ValidationResult<WriteProposal> {
  const issues: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return fail("proposal", "type", "Write proposal must be an object");
  }

  requiredString(input, "schema_version", issues);
  if (input.schema_version !== WRITE_SCHEMA_VERSION) {
    issues.push({
      path: "schema_version",
      code: "schema_version",
      message: `Expected ${WRITE_SCHEMA_VERSION}`
    });
  }

  validateActor(input.actor, issues);
  validateIntent(input.intent, issues);
  validateContent(input.content, issues);
  validateScope(input.scope, issues);
  validateTags(input.tags, issues);
  validateEvidence(input.evidence, issues);
  validateConfidence(input.confidence, issues);
  validateProvenance(input.provenance, issues);
  validatePolicy(input.policy, issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: input as unknown as WriteProposal, issues: [] };
}

function validateActor(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("actor", "required", "actor block is required"));
    return;
  }
  enumValue(value, "kind", ACTOR_KINDS, issues, "actor.kind");
  requiredString(value, "id", issues, "actor.id");
  optionalString(value, "display", issues, "actor.display");
}

function validateIntent(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("intent", "required", "intent block is required"));
    return;
  }
  enumValue(value, "kind", INTENT_KINDS, issues, "intent.kind");
  enumValue(value, "operation", INTENT_OPERATIONS, issues, "intent.operation");
}

function validateContent(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("content", "required", "content block is required"));
    return;
  }
  requiredString(value, "title", issues, "content.title");
  requiredString(value, "body", issues, "content.body");
  optionalString(value, "summary", issues, "content.summary");
}

function validateScope(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("scope", "required", "scope block is required"));
    return;
  }
  requiredString(value, "project", issues, "scope.project");
  requiredString(value, "tenant", issues, "scope.tenant");
  optionalString(value, "path", issues, "scope.path");
  optionalString(value, "session", issues, "scope.session");
}

function validateTags(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("tags", "required", "tags block is required"));
    return;
  }
  for (const family of TAG_FAMILIES) {
    stringArray(value[family], issues, `tags.${family}`);
  }
  optionalStringArray(value.category, issues, "tags.category");
  optionalStringArray(value.type, issues, "tags.type");
  optionalStringArray(value.subject, issues, "tags.subject");
  optionalStringArray(value.project, issues, "tags.project");
  optionalStringArray(value.idea, issues, "tags.idea");
  optionalStringArray(value.timestamp, issues, "tags.timestamp");
  optionalStringArray(value.identities, issues, "tags.identities");
  optionalStringArray(value.sensitivity, issues, "tags.sensitivity");
  optionalStringArray(value.permission, issues, "tags.permission");
}

function validateEvidence(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("evidence", "required", "evidence block is required"));
    return;
  }
  stringArray(value.source_refs, issues, "evidence.source_refs");
  stringArray(value.depends_on, issues, "evidence.depends_on");
  stringArray(value.supports, issues, "evidence.supports");
  stringArray(value.contradicts, issues, "evidence.contradicts");
  stringArray(value.concerns, issues, "evidence.concerns");
}

function validateConfidence(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("confidence", "required", "confidence block is required"));
    return;
  }
  probability(value.value, issues, "confidence.value");
  probability(value.uncertainty, issues, "confidence.uncertainty");
  probability(value.concern, issues, "confidence.concern");
  enumValue(value, "source_quality", SOURCE_QUALITIES, issues, "confidence.source_quality");
  enumValue(value, "stability", STABILITIES, issues, "confidence.stability");
}

function validateProvenance(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("provenance", "required", "provenance block is required"));
    return;
  }
  isoDateString(value.created_at, issues, "provenance.created_at");
  enumValue(value, "origin", ORIGINS, issues, "provenance.origin");
  requiredString(value, "produced_by", issues, "provenance.produced_by");
  enumValue(value, "verification", VERIFICATIONS, issues, "provenance.verification");
  enumValue(value, "signature_status", SIGNATURE_STATUSES, issues, "provenance.signature_status");
}

function validatePolicy(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("policy", "required", "policy block is required"));
    return;
  }
  enumValue(value, "sensitivity", SENSITIVITIES, issues, "policy.sensitivity");
  booleanValue(value.allow_background_use, issues, "policy.allow_background_use");
  booleanValue(value.requires_review, issues, "policy.requires_review");
  nullableIsoDateString(value.expires_at, issues, "policy.expires_at");
  nullableIsoDateString(value.reverify_after, issues, "policy.reverify_after");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  path = key
): void {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    issues.push(issue(path, "required_string", `${path} must be a non-empty string`));
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  path = key
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    issues.push(issue(path, "string", `${path} must be a string when present`));
  }
}

function stringArray(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    issues.push(issue(path, "string_array", `${path} must be an array of non-empty strings`));
  }
}

function optionalStringArray(value: unknown, issues: ValidationIssue[], path: string): void {
  if (value !== undefined) {
    stringArray(value, issues, path);
  }
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
  path = key
): void {
  if (typeof record[key] !== "string" || !allowed.includes(record[key] as T)) {
    issues.push(issue(path, "enum", `${path} must be one of: ${allowed.join(", ")}`));
  }
}

function probability(value: unknown, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(issue(path, "probability", `${path} must be a number from 0 to 1`));
  }
}

function booleanValue(value: unknown, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "boolean") {
    issues.push(issue(path, "boolean", `${path} must be a boolean`));
  }
}

function isoDateString(value: unknown, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(issue(path, "iso_date", `${path} must be an ISO-8601 date string`));
  }
}

function nullableIsoDateString(value: unknown, issues: ValidationIssue[], path: string): void {
  if (value !== null) {
    isoDateString(value, issues, path);
  }
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function fail(path: string, code: string, message: string): ValidationResult<WriteProposal> {
  return { ok: false, issues: [issue(path, code, message)] };
}
