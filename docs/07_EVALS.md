# Evaluation Plan

Recall should not claim SOTA until measured.

## Core Evals

- Long-horizon recall precision.
- Contradiction detection.
- Stale-memory suppression.
- Provenance accuracy.
- Cross-session task continuity.
- Rollback recovery.
- Context packet usefulness.
- Background maintenance improvement.

## Implemented Harness

Recall now has a small eval runner that stores eval results in the same runtime.

```bash
recall eval run
recall eval run --derive
recall eval run --json suite.json
```

`--derive` converts the eval result into an admitted eval witness cell, so eval
evidence is searchable, rollbackable, and available to the context compiler.

Suite shape:

```json
{
  "name": "continuity-regression",
  "cases": [
    {
      "name": "find compiler memory",
      "kind": "search",
      "query": "context compiler",
      "expectContains": "compiler",
      "minResults": 1
    },
    {
      "name": "subgraph facet hit",
      "kind": "subgraph",
      "filter": { "project": ["Recall"], "limit": 10 },
      "minResults": 1
    }
  ]
}
```

Supported case kinds:

- `search`
- `semantic`
- `compile`
- `subgraph`

## Baselines

Compare against:

- raw chat history
- vector-only memory
- graph-only retrieval
- manually curated notes
- existing public memory systems when practical

## Reporting Rule

Report:

- accuracy
- latency
- word budget
- miss cases
- stale-memory leakage
- contradiction misses
- human review burden

No SOTA claim without benchmark evidence.
