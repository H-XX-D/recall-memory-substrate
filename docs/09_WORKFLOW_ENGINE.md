# Workflow Engine

The workflow engine is Substrate-Guided Workflow rebuilt as executable runtime
logic.

## Work Cycle

```text
map
  -> approximate
  -> allocate
  -> verify
  -> recalibrate
  -> write back
  -> compile next packet
```

## Graph Nodes

- `work_candidate`: possible file, source, action, hypothesis, benchmark, or
  connector path.
- `proxy_score`: cheap estimate of impact, risk, uncertainty, cost,
  reversibility, dependency, and expected information gain.
- `verification_result`: expensive check result.
- `miss`: case where proxy under-ranked an important region.
- `blind_lock`: pre-registered prediction or expected outcome.
- `allocation_plan`: selected candidates and reason.

## Allocation Formula

Initial planning pressure:

```text
pressure = impact * uncertainty * concern * dependency_weight / estimated_cost
```

This is not truth. It is attention allocation. Verified results update the graph
after checks run.

## Required Separation

- proxy score is not proof
- verification result is not global certainty
- measured result is not aggressive envelope
- stale result is not current evidence
- concern is not contradiction

## CLI Commands

```text
recall workflow allocate --json candidates.json --limit 8
recall workflow allocate --json candidates.json --limit 8 --derive
recall blind-lock add --json blind-lock.json
recall beliefs
recall maintenance --derive
```

`workflow allocate` accepts either an array of candidates or:

```json
{
  "candidates": [
    {
      "id": "runtime-health",
      "title": "Verify daemon memory health",
      "impact": 0.9,
      "uncertainty": 0.8,
      "concern": 0.8,
      "dependencyWeight": 0.9,
      "cost": 0.4,
      "reversibility": 0.7,
      "novelty": 0.6,
      "tags": ["daemon", "memory-health"]
    }
  ],
  "limit": 8
}
```

With `--derive`, the selected allocation plan is admitted as an
`allocation_plan` cell. `blind-lock add` admits a pre-registered prediction as a
`blind_lock` cell.
