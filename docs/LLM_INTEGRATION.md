# LLM Integration Guide

This guide is for LLM agents and MCP clients that want Recall to operate as
active memory rather than passive notes.

## Operating Contract

1. Read before writing. Use `recall_compile`, `recall_search`,
   `recall_semantic`, or `recall_subgraph` before relying on memory.
2. Write only through `recall_write`. Do not write SQLite rows directly.
3. Use `recall.write.v1` exactly. Include actor, intent, content, scope, tags,
   evidence, confidence, provenance, and policy.
4. Keep routine memory seamless. The agent should propose observations, tasks,
   risks, decisions, witnesses, and context updates without asking the user to
   manually save them.
5. Keep secrets out of routine memory. Secret storage requires the explicit CLI
   command `recall secrets save --confirm-secret-save`.
6. Prefer structured evidence. Use `supports`, `contradicts`, `concerns`, and
   `depends_on` instead of burying relationships in prose.
7. Compile compact context back to the LLM. The compiler is the translation
   boundary: by default it returns IDs, addresses, `#field.path` handles,
   minimal state, and compact evidence lines under the active word budget.
8. Check memory health when the task depends on old or contested state. Use
   `recall_beliefs` or `recall_maintenance` before trusting a fragile claim.
9. Prefer addresses over repetition. Once a memory has a `recall://cell/...`
   address, future proposals should link to that address in evidence arrays
   instead of copying the old body.
10. Reference fields by address plus path. If only a part of an entry is needed,
    use `recall://cell/...#content.summary`, `<cell-id>#confidence.value`, or
    another dotted field path instead of copying that field into a new body.
11. Treat daemon output as normal evidence. Daemon, eval, program, and DAG
    derivations must pass through admission like any other write.
12. Expand lazily. Use `recall_cell` for one cell or field handle when exact
    content is needed; do not request inline reference values or full parameter
    metadata by default.
13. Use ACP when the task should be handed to an inside graph-manager agent.
    `recall_acp_*` tools are the protocol surface for bounded agent-to-agent
    requests, not a second memory system.

## MCP Configuration

After installing Recall globally, generate the local MCP configuration:

```bash
recall mcp config --db .recall/recall.sqlite3
```

The generated block uses the `recall-mcp` stdio server:

```json
{
  "mcpServers": {
    "recall": {
      "command": "recall-mcp",
      "env": {
        "RECALL_DB": ".recall/recall.sqlite3"
      }
    }
  }
}
```

## Core Tools

- `recall_status`: inspect graph counts.
- `recall_write`: submit a strict memory proposal.
- `recall_search`: lexical search over graph nodes.
- `recall_semantic`: semantic search over graph nodes.
- `recall_subgraph`: compose a subgraph from tags and facets.
- `recall_compile`: return an ID-first task-specific context packet.
- `recall_beliefs`: inspect belief pressure, stale cells, and contradiction
  pressure.
- `recall_maintenance`: run memory health analysis and optionally admit it.
- `recall_storage` and `recall_compact`: monitor average cell footprint and
  reclaim SQLite space after archival/rollback.
- `recall_page`: retrieve paged graph views such as `witnesses`, `workbench`,
  `handoffs`, `objectives`, and `team-metrics`.
- `recall_cell`: expand one addressable cell or field handle and its connected
  data on demand.
- `recall_tick`: run the integrated cognitive tick loop and optionally admit
  the tick as a maintenance witness.
- `recall_acp_status`, `recall_acp_send`, `recall_acp_list`,
  `recall_acp_show`, `recall_acp_process`, and `recall_acp_exchange`: queue,
  process, and one-shot exchange bounded internal agent communication requests.
- `recall_operate_once`: run the full leased mechanical cycle and persist an
  operator ledger report.
- `recall_operate_list` and `recall_operate_show`: inspect operator ledger
  reports without writing them into normal memory.
- `recall_workflow_allocate`: score work candidates and optionally write an
  allocation plan.
- `recall_blind_lock`: pre-register a prediction as a typed cell.
- `recall_daemon_run_once`: run one outside-LLM maintenance pass.
- advanced graph operation tools, `recall_dag_*`, and `recall_eval_*`: operate
  graph derivation and evaluation features.

## Minimal Write Proposal

```json
{
  "schema_version": "recall.write.v1",
  "actor": {
    "kind": "llm",
    "id": "agent-id",
    "display": "Agent"
  },
  "intent": {
    "kind": "observation",
    "operation": "create"
  },
  "content": {
    "title": "Short stable title",
    "body": "Specific source-grounded memory claim.",
    "summary": "Compact retrieval text."
  },
  "scope": {
    "project": "ExampleProject",
    "path": "/path/to/project",
    "tenant": "local"
  },
  "tags": {
    "category": ["memory"],
    "type": ["observation"],
    "subject": ["compiler"],
    "project": ["ExampleProject"],
    "idea": ["context-packet"],
    "timestamp": ["2026-05-21"],
    "topics": ["memory"],
    "entities": ["Recall"],
    "identities": ["agent:example"],
    "rings": ["runtime"],
    "lifecycle": ["active"],
    "quality": ["source-grounded"],
    "sensitivity": ["public"],
    "permission": ["read"]
  },
  "evidence": {
    "source_refs": ["README.md"],
    "depends_on": [],
    "supports": [],
    "contradicts": [],
    "concerns": []
  },
  "confidence": {
    "value": 0.7,
    "uncertainty": 0.2,
    "concern": 0.3,
    "source_quality": "medium",
    "stability": "stable"
  },
  "provenance": {
    "created_at": "2026-05-21T00:00:00.000Z",
    "origin": "llm",
    "produced_by": "agent-id",
    "verification": "checked",
    "signature_status": "unsigned"
  },
  "policy": {
    "sensitivity": "public",
    "allow_background_use": true,
    "requires_review": false,
    "expires_at": null,
    "reverify_after": null
  }
}
```

## Reference Policy

Use the smallest reference that preserves meaning:

```text
recall://cell/...                     whole cell
recall://cell/...#content.summary     summary only
<cell-id>#confidence.value            confidence value only
<cell-id>#tags.subject                subject tag list only
```

Evidence arrays accept IDs, addresses, and field references. Admission resolves
known addresses to cell IDs, stores relation metadata for the field path, and
keeps graph traversal pointed at the target cell. Multi-party relation
members, DAG overlays, and operation outputs follow the same rule: refer to
cells by ID/address and use `#field.path` when the mechanical part only needs
one parameter.

Do not paste an existing cell body into a new write unless the new memory is
making a new claim about that body. Use `recall_cell` to inspect the cell and
then write a compact relation to the existing address.

`recall_compile` is where compact references become usable context again. The
default packet is ID-first: it includes `compiler_state`, compact memory lines,
minimal `cell_state`, `translated_references` with short handles such as
`<cell-id>#content.summary`, and `expansion_handles`. Treat it as a handle menu
plus enough evidence to decide what to inspect next, not as complete memory.

Three packet signals govern how much to trust and where to dig:

- `cell_state` lines carry `eff:<value>` (the cell's **live effective
  confidence**, recomputed from supports, challenges, and the writer's
  calibration on every compile) with a cause tag
  (`challenged`/`supported`/`actor-discounted`). An unchallenged high-eff
  cell is safe at title level; `eff` well below stated confidence means
  peek the challenger before relying on the claim.
- `conflicts` lists each selected cell's incoming challengers with handles.
  A cell appearing here is contested, no matter how confident its line reads.
- `standing_programs` lists the gates (watch, drift, quorum, score) covering
  selected cells, with program and hyperedge handles. When writing new
  evidence about a guarded cell, reference the listed bundle so the gate
  sees it. Do not orphan evidence next to an existing gate.

The LLM should expand lazily with `recall_cell` when it needs more:

```text
recall_cell <cell-id>
recall_cell <cell-id>#content.summary
```

Inline reference values and full parameter metadata are explicit opt-ins:
`inlineReferenceValues: true` and `includeReferenceParameters: true`. Use them
only when the compiled packet itself must contain resolved values, such as for
an audit, quote, migration, or offline handoff.

## Close/Derive Agent Workflow

Use derive mode when runtime output should become future retrievable evidence,
not merely terminal output:

```text
recall_maintenance({ derive: true })
recall_tick({ derive: true })
recall_workflow_allocate({ derive: true })
recall_program_run({ programId, derive: true })
recall_dag_analyze({ overlayId, derive: true })
recall_eval_run({ derive: true })
recall_daemon_run_once({ derive: true })
```

The agent contract is:

1. Read first with `recall_compile`; expand only the handles needed for the
   decision.
2. Run the work or runtime analysis.
3. Use derive mode only for outputs that should re-enter Recall as durable
   evidence.
4. Inspect the admission result. Treat `accepted` and `duplicateOf` cells as
   addressable memory; treat rejected, review-blocked, or secret-looking output
   as non-memory until explicit review resolves it.
5. Reference accepted derived cells by ID or address in later writes. Do not
   paste the derived body into a new proposal unless the new proposal makes a
   distinct claim about it.

After closure, later `recall_compile` calls still remain ID-first. They may
surface the derived witness, concern, eval result, or maintenance observation as
a compact line plus expansion handle; use `recall_cell` only when the exact
derived payload is needed.

## Agent Loop

```text
user task
  -> recall_compile task packet
  -> recall_beliefs or recall_maintenance when old/conflicted memory matters
  -> recall_cell when deciding whether to reference an existing memory by address
  -> do work
  -> derive runtime outputs that should become future evidence
  -> recall_write source-grounded observations, decisions, risks, and tasks
  -> recall_workflow_allocate for multi-step work when attention is scarce
  -> recall_blind_lock before checking an outcome that should be judged blind
  -> run recall_daemon_run_once when maintenance is useful
  -> recall_compile final packet if the next turn needs continuity
```

Use CLI/TUI for inspection, correction, rollback, and explicit human actions.
Use MCP for the routine agent path.

## Making the Loop Stick: Enforcement Hooks

The contract above tells an agent how to use Recall. It does not keep the
agent using it: long sessions drift, and a system prompt fades like any
other instruction. Recall ships hook templates (in
[`python/hooks/`](../python/hooks/)) that make the loop ambient instead of
announced once:

- **UserPromptSubmit** prepends a tiny Recall status header to every
  prompt, so each turn arrives with a fresh pointer to what the graph
  holds (`recall_inject_context.py.sample`).
- **Stop** prompts for writeback before a turn ends with unsaved findings
  (`recall_writeback_reminder.py.sample`).
- **PreToolUse guard** is the hard tier: it blocks substantive mutations
  (Edit, Write, destructive Bash) unless a recent Recall cell records the
  rationale for the change (`recall_pretooluse_guard.py.sample`).

The soft layers nudge; the guard enforces. Setup, decision rules,
configuration controls, and compliance auditing live in
[Enforcing Recall Usage](17_ENFORCING_USAGE.md).
