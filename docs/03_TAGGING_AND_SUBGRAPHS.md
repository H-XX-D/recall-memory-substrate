# Tagging And Subgraph Composition

Recall tags must be structured enough to build reliable subgraphs.

## Primary Subgraph Facets

These are the main fields for subgraph creation. They are optional but useful;
Recall should work with sparse tags and derive fallbacks where it can.

- `category`: broad bucket, for example memory, workflow, architecture, secret,
  eval, daemon.
- `type`: object kind or claim kind, for example witness, task, decision,
  risk, observation, maintenance_observation.
- `subject`: what the record is about, for example compiler, schema, daemon,
  secrets, MCP.
- `project`: project or repo, for example Recall or ExampleProject.
- `idea`: conceptual handle, for example active-memory, context-packet,
  outside-llm-maintenance.
- `timestamp`: date/time facet, usually `YYYY-MM-DD` for day-level subgraphs.

## Secondary Tag Families

- `scope`: project, repo, tenant, path, session.
- `topic`: memory, planner, cli, tui, compiler, eval, connector.
- `entity`: named object, system, file, person, theory, artifact.
- `identity`: agent, daemon, project, user, connector, program, model, tenant, or
  role identity.
- `ring`: foundation, runtime, connector.
- `lifecycle`: proposed, active, stale, superseded, archived.
- `quality`: unverified, source-grounded, tested, benchmarked, contradicted.
- `sensitivity`: public, private, secret.
- `permission`: read, write, execute, external, background.

## Subgraph Query Shape

```json
{
  "category": ["memory"],
  "type": ["witness"],
  "subject": ["compiler"],
  "project": ["Recall"],
  "idea": ["context-packet"],
  "timestamp": ["2026-05-21"],
  "topics": ["compiler"],
  "entities": ["Recall"],
  "identities": ["agent:codex", "project:recall"],
  "rings": ["runtime"],
  "lifecycle": ["active"],
  "quality": ["source-grounded"],
  "limit": 50
}
```

The filter is a flat object of facet arrays plus a numeric `limit` (default 50).
Every supplied facet is AND-combined (a cell must match all of them), matching is
include-only over active cells, and results are ordered by recency. There is no
exclude block and no rank step; `sensitivity` and `permission` are writable tag
families but are not queryable subgraph facets.

## Composition Principles

- Tags should narrow the graph before semantic search expands it.
- Not every record needs every tag. Use all facets when precision matters; use
  sparse facets when the write should stay lightweight.
- Missing address facets are derived from scope, intent, title, and provenance
  timestamp.
- Contradictions and concerns travel with the subgraph by default.
- Stale or superseded nodes can be included only when the query asks for history.
- Program permissions are tags, not hidden flags.
- Category/type/subject/project/idea/timestamp are the preferred first-pass
  filters for subgraph creation.
- Identity tags are multi-valued. One node may belong to `agent:codex`,
  `project:recall`, `daemon:eligible`, and `tenant:local` at the same time.
- Context packets should include graph IDs for expansion.

## Facet Examples

```json
{
  "category": ["memory"],
  "type": ["witness"],
  "subject": ["compiler"],
  "project": ["Recall"],
  "idea": ["context-packet"],
  "timestamp": ["2026-05-21"]
}
```

## Identity Tag Examples

```text
agent:codex
agent:claude
daemon:recall
project:recall
tenant:local
connector:pubchem
program:stale-memory-scorer
model:gpt-5
role:reviewer
```

Identity tags let Recall also compose subgraphs by actor, connector, daemon, or
role without duplicating memory stores.
