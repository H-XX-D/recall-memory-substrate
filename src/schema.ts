// MAL schema validation: check a WriteProposal against the v5 type contract.
// Returns collected issues; ok is true only when there are none.

import {
  KINDS,
  OPERATIONS,
  ORIGINS,
  RELATIONS,
  SENSITIVITIES,
  STABILITIES,
  VERIFICATIONS,
} from "./types.js";
import type { ValidationIssue, ValidationResult } from "./types.js";

export function validateProposal(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = isRecord(input) ? input : {};

  if (!(KINDS as readonly string[]).includes(p.kind as string)) {
    issues.push({ path: "kind", message: `kind must be one of ${KINDS.join(", ")}` });
  }

  if (!nonEmptyString(p.title)) {
    issues.push({ path: "title", message: "title must be a non-empty string" });
  }

  if (typeof p.body !== "string") {
    issues.push({ path: "body", message: "body must be a string" });
  }

  const c = p.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c <= 0 || c > 1) {
    issues.push({ path: "confidence", message: "confidence must be a finite number in (0, 1]" });
  }

  optionalString(p.owner, "owner", issues);
  optionalString(p.summary, "summary", issues, { allowEmpty: true });
  optionalString(p.project, "project", issues);
  optionalString(p.tenant, "tenant", issues);
  optionalStringArray(p.topics, "topics", issues);
  optionalStringArray(p.entities, "entities", issues);
  optionalStringArray(p.lifecycle, "lifecycle", issues);
  optionalStringArray(p.quality, "quality", issues);
  optionalStringArray(p.subject, "subject", issues);
  optionalStringArray(p.programs, "programs", issues);
  if (p.hyperedges !== undefined) {
    if (!Array.isArray(p.hyperedges)) {
      issues.push({ path: "hyperedges", message: "hyperedges must be an array of {id, role?, weight?}" });
    } else {
      p.hyperedges.forEach((h, i) => {
        if (typeof h !== "object" || h === null || typeof (h as { id?: unknown }).id !== "string" || (h as { id: string }).id.trim() === "") {
          issues.push({ path: `hyperedges[${i}]`, message: "hyperedge membership needs a non-empty string id" });
          return;
        }
        const role = (h as { role?: unknown }).role;
        if (role !== undefined && typeof role !== "string") {
          issues.push({ path: `hyperedges[${i}].role`, message: "role must be a string" });
        }
        const weight = (h as { weight?: unknown }).weight;
        if (weight !== undefined && (typeof weight !== "number" || weight < 0 || weight > 1)) {
          issues.push({ path: `hyperedges[${i}].weight`, message: "weight must be a number in [0, 1]" });
        }
      });
    }
  }
  optionalStringArray(p.sourceRefs, "sourceRefs", issues);
  optionalProbability(p.uncertainty, "uncertainty", issues);
  if (p.value !== undefined && (typeof p.value !== "number" || !Number.isFinite(p.value))) {
    issues.push({ path: "value", message: "value must be a finite number" });
  }
  optionalProbability(p.concern, "concern", issues);
  optionalEnum(p.operation, "operation", OPERATIONS, issues);
  optionalEnum(p.origin, "origin", ORIGINS, issues);
  optionalEnum(p.verification, "verification", VERIFICATIONS, issues);
  optionalEnum(p.sensitivity, "sensitivity", SENSITIVITIES, issues);
  optionalEnum(p.stability, "stability", STABILITIES, issues);
  optionalIsoOrNull(p.expiresAt, "expiresAt", issues);
  optionalIsoOrNull(p.reverifyAfter, "reverifyAfter", issues);
  optionalFlags(p.flags, "flags", issues);
  if (p.props !== undefined && !isRecord(p.props)) {
    issues.push({ path: "props", message: "props must be an object" });
  }

  if (p.edges !== undefined) {
    if (!Array.isArray(p.edges)) {
      issues.push({ path: "edges", message: "edges must be an array" });
    } else {
      p.edges.forEach((edge, i) => {
        const e = isRecord(edge) ? edge : {};
        const relation = e.relation as string;
        if (!(RELATIONS as readonly string[]).includes(relation)) {
          issues.push({
            path: `edges[${i}].relation`,
            message: `relation must be one of ${RELATIONS.join(", ")}`,
          });
        }
        if (!nonEmptyString(e.target)) {
          issues.push({
            path: `edges[${i}].target`,
            message: "target must be a non-empty string",
          });
        }
        if (e.weight !== undefined) {
          if (typeof e.weight !== "number" || !Number.isFinite(e.weight)) {
            issues.push({
              path: `edges[${i}].weight`,
              message: "weight must be a finite number",
            });
          } else if ((RELATIONS as readonly string[]).includes(relation)) {
            const issue = edgeWeightIssue(relation, e.weight);
            if (issue) issues.push({ path: `edges[${i}].weight`, message: issue });
          }
        }
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function optionalString(
  x: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { allowEmpty?: boolean } = {},
): void {
  if (x === undefined) return;
  if (typeof x !== "string" || (!opts.allowEmpty && x.trim().length === 0)) {
    issues.push({ path, message: opts.allowEmpty ? `${path} must be a string` : `${path} must be a non-empty string` });
  }
}

function optionalStringArray(x: unknown, path: string, issues: ValidationIssue[]): void {
  if (x === undefined) return;
  if (!Array.isArray(x)) {
    issues.push({ path, message: `${path} must be an array of non-empty strings` });
    return;
  }
  x.forEach((v, i) => {
    if (!nonEmptyString(v)) {
      issues.push({ path: `${path}[${i}]`, message: `${path}[${i}] must be a non-empty string` });
    }
  });
}

function optionalProbability(x: unknown, path: string, issues: ValidationIssue[]): void {
  if (x === undefined) return;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) {
    issues.push({ path, message: `${path} must be a finite number in [0, 1]` });
  }
}

function optionalEnum(
  x: unknown,
  path: string,
  values: readonly string[],
  issues: ValidationIssue[],
): void {
  if (x === undefined) return;
  if (!values.includes(x as string)) {
    issues.push({ path, message: `${path} must be one of ${values.join(", ")}` });
  }
}

function optionalIsoOrNull(x: unknown, path: string, issues: ValidationIssue[]): void {
  if (x === undefined || x === null) return;
  if (typeof x !== "string" || Number.isNaN(Date.parse(x))) {
    issues.push({ path, message: `${path} must be an ISO-8601 date string or null` });
  }
}

function optionalFlags(x: unknown, path: string, issues: ValidationIssue[]): void {
  if (x === undefined) return;
  if (!isRecord(x)) {
    issues.push({ path, message: "flags must be an object" });
    return;
  }
  for (const name of ["annexed", "locked", "pinned", "requiresReview", "allowBackgroundUse"]) {
    const value = x[name];
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({ path: `${path}.${name}`, message: `${path}.${name} must be a boolean` });
    }
  }
}

function edgeWeightIssue(relation: string, weight: number): string | undefined {
  if (relation === "supports" && weight <= 0) return "supports weight must be positive";
  if ((relation === "contradicts" || relation === "concerns") && weight >= 0) {
    return `${relation} weight must be negative`;
  }
  if (
    (relation === "depends_on" || relation === "supersedes" || relation === "derived_from") &&
    weight !== 0
  ) {
    return `${relation} weight must be 0`;
  }
  return undefined;
}
