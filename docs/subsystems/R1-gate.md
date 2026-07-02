# R1 Gate: current MAL admission contract

Date: 2026-06-26
Status: implemented on `rewrite/integration`

R1 is the first trust gate after R0 structural validation. It does not define the
cell shape; it decides whether a schema-valid proposal is allowed to become a
cell, and how its effective confidence is initially attenuated.

## Module Map

| Module | Role |
|--------|------|
| `src/firewall.ts` | Secret/public-data screening and unsupported-confidence attenuation |
| `src/admission.ts` | Gate sequence: validate, screen, attenuate, build, calibrate; delegates store-backed relational work when a store is present |
| `src/calibration.ts` | Brier-score actor calibration primitives |
| `src/secrets.ts` | Encrypted project-DB side store for secret values that must not become cells |

R1 consumes R0's `WriteProposal` and `Cell` contract. R2 starts where graph
persistence, deduplication, supersession, neighbor masses, and store-backed
recomputes are needed.

## Gate Sequence

`admit(proposal, ctx)` runs:

1. `validateProposal(proposal)` from R0.
2. `screenSecrets(proposal)`.
3. Calibration context validation: `calibrationFactor` must be finite in `[0.5, 1]`.
4. `attenuateConfidence(proposal)`.
5. `buildCell()` from R0.
6. Effective-confidence calculation from the attenuated confidence and actor
   calibration.

With no store, R1 has no graph context and support/challenge masses are zero.
With a store, the current integration also runs R2 relational work: dedup,
supersede, target recompute, and self recompute.

## Firewall

`screenSecrets()` scans all proposal text surfaces:

- `title`
- `body`
- `owner`
- `summary`
- `topics`
- `entities`
- `sourceRefs`
- `project`
- `tenant`
- nested string values under `props`

It rejects detected credentials such as OpenAI keys, AWS access keys, GitHub
tokens, Slack tokens, JWTs, private-key blocks, bearer tokens, and common
secret-named assignments.

For `sensitivity: "public"` writes, it also blocks likely personal data: email
addresses, US social security numbers, and phone numbers. That is the current
public-port rule. It is deliberately precision-first, not a complete DLP system.

## Confidence Attenuation

High confidence above `0.7` is capped to `0.7` unless the proposal carries actual
support evidence:

- a `supports` edge with positive weight
- a `derived_from` edge
- at least one `sourceRef`
- `verification` of `checked`, `tested`, or `external`

Non-support edges such as `contradicts`, `concerns`, `depends_on`, or `supersedes`
do not justify high confidence.

## Calibration

`calibrationFactor(outcomes)` is neutral until an actor has at least three resolved
outcomes. After that, it returns:

```text
max(0.5, 1 - brierScore(outcomes))
```

`brierScore()` compares stated confidence against realized outcome, where
survived = `1` and contradicted = `0`. Malformed confidence values are rejected
instead of silently poisoning the factor.

`admit()` rejects context calibration factors outside `[0.5, 1]`.

## R1 Boundary

R1 does not:

- store accepted cells by itself
- resolve handles or edge hops through the graph
- compute neighbor-derived support/challenge masses without a store
- put secret values into normal cells
- provide the future OS/OEM keychain adapter, lock/unlock CLI, or Total-Recall
  hardened alias policy
- run standing programs or operator ticks
- expose CLI/MCP surfaces

Those remain R2+ or later-surface work.
