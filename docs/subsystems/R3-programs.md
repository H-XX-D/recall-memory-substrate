# R3 Programs / Operator: current deterministic tick contract

Date: 2026-06-26
Status: core program/operator slice implemented on `rewrite/integration`

R3 gives v5 a first standing-program substrate without adding a second storage
model. Programs are ordinary `prg` cells. The program spec lives under
`cell.props.program`, selected member cells stay in the normal graph, and durable
run baseline state is stored back on the program cell as `props.lastRun`.

## Module Map

| Module | Role |
|--------|------|
| `src/programs.ts` | Validates and executes `recall.program.v1` specs stored on `prg` cells |
| `src/operator.ts` | Runs the deterministic operator cycle: tick scores/currency, then run standing programs |
| `src/cli.ts` | Adds `recall-mal operate once [--derive]` |

## Program Contract

Program specs are JSON objects:

```json
{
  "schemaVersion": "recall.program.v1",
  "operation": "watch",
  "target": {
    "keys": ["cell-key"],
    "query": "optional search query",
    "topics": ["optional-topic"],
    "entities": ["optional-entity"],
    "kinds": ["obs"],
    "limit": 50
  },
  "params": {
    "delta": 0.15
  }
}
```

Implemented operations:

- `score`: mean stated/effective confidence, max concern, and a simple bundle score
- `emit_witness`: always emits a witness from selected members
- `tag_projection`: projects a tag family from selected members
- `watch`: trips when mean effective confidence moves by `delta` since the prior run
- `drift`: watch plus per-member mover attribution
- `quorum`: k-of-m effective-confidence gate, distinct actors by default
- `trend`: finite-difference trend over effective confidence, member count, or a numeric field path

Member selection can use explicit keys/handles, lexical query, program outgoing
edges, target topics/entities/kinds, or shared topics as a fallback.

## Operator Contract

`runOperatorCycle(store, now, opts)`:

1. captures preflight store stats
2. ticks every active cell from the pre-tick snapshot
3. runs every active `prg` cell with a valid `props.program`
4. stores each program's `lastRun` and `runCount`
5. attaches the program key to each observed member's `programs[]`
6. when `derive` is true, admits emitted program witnesses back through R1/R2
7. returns postflight store stats plus program run and admission summaries

The CLI entry point is:

```text
recall-mal operate once [--derive] [--db path] [--project slug]
```

## Deferred From This Slice

- separate hyperedge/program/run tables
- daemon scheduler, leases, launch agents, and background service operation
- semantic reindex/eval/compaction phases
- rich graph-adjust actions beyond witnessed observations
- workflow allocation and blind-lock proposal helpers
