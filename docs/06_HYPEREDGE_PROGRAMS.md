# Hyperedge Programs

Hyperedge programs are controlled functions attached to graph relationships.
They add behavior without turning the memory store into uncontrolled agent code.

## Implemented Runtime

Recall now stores n-ary hyperedges in the same SQLite graph runtime.

```bash
recall hyperedge add --json hyperedge.json
recall hyperedge list
```

Example hyperedge:

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

Programs are sandboxed `recall.program.v1` specs. They are not arbitrary
JavaScript. The first deterministic operations are:

- `score`
- `emit_witness`
- `tag_projection`

```bash
recall program add <hyperedge-id> --json program.json
recall program run <program-id>
recall program run <program-id> --derive
recall program runs
```

`--derive` converts the program run output into a strict witness proposal and
admits it through the normal write path, producing a rollbackable addressable
cell.

Implemented program spec:

```json
{
  "schemaVersion": "recall.program.v1",
  "operation": "score",
  "description": "Score graph-local support"
}
```

## Future Manifest

```json
{
  "schema_version": "recall.program.v1",
  "name": "stale-memory-scorer",
  "version": "0.1.0",
  "language": "typescript|wasm",
  "entrypoint": "score",
  "attached_to": "hyperedge-id",
  "inputs": ["node:memory", "node:source"],
  "outputs": ["node:risk", "relation:concerns"],
  "permissions": ["read_graph", "write_proposal"],
  "deterministic": true,
  "side_effects": false,
  "tests": ["tests/programs/stale-memory-scorer.test.ts"],
  "digest": "sha256-placeholder"
}
```

## Rules

- Programs can emit write proposals; they should not mutate the graph directly.
- Programs require explicit permissions.
- Programs with side effects require human review.
- Program output must be reproducible or marked nondeterministic.
- Failed program runs become evidence, not hidden logs.
- Program versions are immutable after admission.

## First Program Candidates

- stale-memory scorer
- duplicate detector
- contradiction hunter
- source-quality scorer
- subgraph summarizer
- context packet compressor
- belief pressure calculator
