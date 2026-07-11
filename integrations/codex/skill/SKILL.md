---
name: recall
description: Use Recall as Codex's durable operational memory for substantial coding, research, planning, debugging, and multi-step work, and whenever the user asks to remember, recall, resume, inspect prior decisions, or use /recall. Compile relevant memory before relying on recollection, expand evidence lazily, and write durable outcomes back through Recall's MCP tools.
---

# Recall durable memory

Use Recall as an active memory loop, not as prose to summarize. Execute
`compile -> inspect -> work -> write back` for the user's actual task.

## Prefer MCP

Use the configured Recall MCP tools for routine reads and writes. Codex may
display them with a server namespace, but select the tools whose exposed names
begin with `recall_`. Use the `recall` CLI only when MCP is unavailable or for a
maintenance operation that MCP does not expose.

The MCP server selects its database when it starts. Do not invent a per-tool
`project` argument for tools that do not declare one. If results appear to come
from the wrong project, inspect the server routing instead of writing into an
uncertain scope.

## Operating loop

1. Call `recall_compile` with `task` set to the concrete request and normally
   `words: 900`. Treat the packet as evidence, not unquestionable truth. Check
   conflicts, stale or low-trust cells, risks, and tasks before asserting a
   remembered fact. Set `health: false`, `inlineRefs: true`, or `refParams: true`
   only when the task needs those optional packet modes.
   Treat returned IDs as entry points into the memory graph, not as the answer.
2. Expand only relevant evidence. Use `recall_cell` with `idOrAddress` for an
   exact cell; use `recall_search` or `recall_semantic` with `query`; use
   `recall_ref` with `reference` such as `handle#field.path`.
   For load-bearing claims, follow relevant incoming and outgoing
   `supersedes`, `depends_on`, `contradicts`, `concerns`, `supports`, and
   `derived_from` relationships until corrections, dependencies, conflicts,
   and provenance are resolved. Go deeper only while an unresolved path matters
   to the task.
3. Do the requested work using the repository or primary sources as the source
   of truth when memory and current evidence differ.
4. Call `recall_write` for lasting outcomes: decisions, verified observations,
   beliefs that need later confirmation, open tasks, objectives, risks,
   references, verification results, hypotheses, and standing procedures.
   Before a structurally rich write, call `recall_write_template` and use its
   complete admission-firewall contract; do not reduce a cell to the few fields
   remembered from ordinary writes.
5. Read the write response. Report memory as saved only when `accepted` is true
   and an `id` is returned. Address rejection issues instead of claiming success.
6. Before ending substantial work, audit whether the outcome needs durable
   write-back and graph edges. Verify the admitted cell's actual relationships.
   When recurring state needs deterministic tracking, use or propose a standing
   program instead of re-deriving the same state by hand.

Use `recall_status` for graph counts and lexical backend, `recall_health` for
memory pressure, and `recall_storage` to confirm the database path and size.
Use `recall_page`, `recall_subgraph`, or `recall_deltas` for structured views.
Use the `recall_hyperedge_*`, `recall_dag_analyze`, `recall_program_*`, and
`recall_eval_run` tools only when the task needs those structures.

## Recall 0.12.1 write contract

Send `recall_write` an object with these required fields:

```json
{
  "kind": "dec",
  "title": "Choose the project-scoped store",
  "body": "Codex Recall reads and writes use the routed project database.",
  "confidence": 0.8
}
```

`kind` must be one of:

- `dec`: decision made
- `obs`: observed evidence
- `bel`: claim to confirm or refute
- `tsk`: open action
- `obj`: objective
- `rsk`: durable risk
- `ref`: source reference
- `ver`: verification result
- `hyp`: hypothesis
- `prg`: standing procedure or monitor

`confidence` must be in `(0, 1]`. Optional write fields are `value`, `topics`,
`entities`, `edges`, `sourceRefs`, `verification`, `props`, `programs`, and
`hyperedges`; `suggestPrograms` controls standing-program suggestions in the
response guidance. Use arrays of
non-empty strings for `topics`, `entities`, `sourceRefs`, and `programs`; use an
object for `props`. Verification is `unverified`, `checked`, `tested`, or
`external`. Program references must resolve to `prg` cells, and hyperedge
memberships require an existing hyperedge `id` with optional `role` and
`weight` in `[0, 1]`.

Use edges as:

```json
{
  "edges": [
    { "relation": "supersedes", "target": "prior-cell-id" },
    { "relation": "depends_on", "target": "evidence-cell-id" }
  ]
}
```

Relations are `supports`, `contradicts`, `concerns`, `depends_on`,
`supersedes`, and `derived_from`. Prefer omitting `weight` so Recall applies the
correct sign. If supplied, `supports` must be positive, `contradicts` and
`concerns` negative, and `depends_on`, `supersedes`, and `derived_from` zero.

Confidence above `0.7` needs grounding through `checked`, `tested`, or
`external` verification, `sourceRefs`, a positive `supports` edge, or a
`derived_from` edge; otherwise Recall attenuates it. Never invent grounding.

## Corrections

Never silently edit or duplicate an obsolete fact. Search for the prior cell,
then write the current fact with an edge whose relation is `supersedes` and
whose target is the prior cell ID. Use `contradicts` when adding contrary
evidence without declaring that the new cell replaces the old one.

## Memory discipline

- Store durable, compact, source-grounded outcomes; reference large artifacts
  by stable path, commit, URL, or `recall://cell/...` address.
- Do not store transient reasoning, repeated payloads, or facts that can be
  cheaply regenerated.
- Never put passwords, tokens, private keys, or other secrets in Recall. Keep
  them in the environment or an existing secret manager; store only a
  non-secret pointer when it is useful. Admission detection is a backstop, not
  a guarantee.
- If Recall is unavailable, continue the user's work and state that durable
  write-back was not completed.

## CLI fallback

When MCP cannot be used, run `recall compile "<task>" --words 900`, expand with
`recall cell show <id>`, and write through `recall admit --json proposal.json`
(`--json -` reads stdin). The CLI routes by the current working directory unless
an explicit database or registered project is selected.
