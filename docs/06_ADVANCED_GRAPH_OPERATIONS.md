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
arbitrary JavaScript. The first deterministic operations are:

- `score`
- `emit_witness`
- `tag_projection`

`--derive` converts operation output into a strict witness proposal and
admits it through the normal write path, producing a rollbackable addressable
cell.

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
