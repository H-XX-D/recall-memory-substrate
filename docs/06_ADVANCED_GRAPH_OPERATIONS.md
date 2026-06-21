# Advanced Graph Operations

Advanced graph operations let Recall attach controlled behavior to multi-party
relationships without turning the memory store into uncontrolled agent code.

## Implemented Runtime

Recall stores multi-party relations in the same SQLite graph runtime.

Use the CLI help for the current command surface:

```bash
recall --help
```

Example relation shape:

```json
{
  "kind": "supports",
  "title": "Evidence supports belief",
  "members": [
    { "nodeId": "source-cell-id", "role": "source" },
    { "nodeId": "target-cell-id", "role": "target" }
  ],
  "metadata": { "purpose": "evidence-link" }
}
```

Declared operations are sandboxed `recall.program.v1` specs. They are not
arbitrary JavaScript. The deterministic operations are:

- `score`: bundle health, the mean **live effective confidence** of members
  (stated-confidence average retained for explainability) combined with the
  worst member concern. Because scoring reads the live graph surface, a
  scored bundle is a *tripwire*: contradict any member anywhere and the
  score falls on the next run, with no model involved.
- `emit_witness`: freeze the bundle's current state as a witness record.
- `tag_projection`: project a tag family (set union) across members.
- `watch`: a standing reflex. Baselines against the program's own previous
  run (run history is the state), trips when the bundle's live effective
  confidence moves more than `params.delta` (default 0.15). First run
  establishes the baseline and never trips. Untripped runs derive nothing:
  silence means verified stability.
- `drift`: watch with attribution: a tripped run names which member moved
  (`topMover`, ranked `movers`).
- `quorum`: k-of-m sign-off as a graph object: a member approves when its
  live effective confidence clears `params.minEff` (default 0.7), counted
  across distinct actors by default (`params.role` filters eligible
  members). A contradicted approver's approval stops counting. Quorum runs
  always derive their attestation.
- `trend`: finite-difference calculus over the program's run history. Each run
  appends the bundle's current value to a sliding window; the operation reports
  direction, slope, and acceleration and trips on a sustained directional streak
  or a slope past `params.delta`. Where `watch` asks whether a value moved,
  `trend` asks which way it has been moving and how fast, so a bundle whose
  effective confidence is quietly eroding over many runs trips before it ever
  crosses a hard threshold.

`--derive` converts operation output into a strict witness proposal and
admits it through the normal write path, producing a rollbackable
addressable cell. A tripped `watch`/`drift` with `params.concernTarget`
additionally carries a `concerns` reference against that cell (reflexes
file claims, never value assignments) and program derivations are
attributed `produced_by: program:<id>`, so programs accumulate per-actor
calibration like any other writer.

Compile packets surface enabled programs covering selected cells in a
`standing_programs:` section (with program and hyperedge handles), so
agents tie new evidence into existing bundles.

Implemented operation spec:

```json
{
  "schemaVersion": "recall.program.v1",
  "operation": "score",
  "description": "Score graph-local support"
}
```

## Rules

- Declared operations can emit write proposals; they should not mutate the
  graph directly.
- Declared operations require explicit permissions.
- Operations with side effects require human review.
- Operation output must be reproducible or marked nondeterministic.
- Failed operation runs become evidence, not hidden logs.
- Operation versions are immutable after admission.

## First Operation Candidates

- stale-memory scorer
- duplicate detector
- contradiction hunter
- source-quality scorer
- subgraph summarizer
- context packet compressor
- belief pressure calculator
