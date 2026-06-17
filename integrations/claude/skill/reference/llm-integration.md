# Recall LLM Integration Reference

> Bundled with the `recall` skill from `Recall-Personal/docs/LLM_INTEGRATION.md`.
> This is the full operating contract and write schema. The skill's `SKILL.md`
> is the lean entry point; read this file before composing your first
> `recall_write` proposal, or when you need the close/derive workflow.
>
> On this machine the global memory DB is `~/.recall/recall.sqlite3`.
> The MCP server `recall` is already pinned to it; CLI calls must pass
> `--db ~/.recall/recall.sqlite3` explicitly.

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

This skill's setup already registered the `recall` MCP server (user scope)
against the global DB. To regenerate a config block for another project:

```bash
recall mcp config --db ~/.recall/recall.sqlite3
```

The generated block uses the `recall-mcp` stdio server:

```json
{
  "mcpServers": {
    "recall": {
      "command": "recall-mcp",
      "env": {
        "RECALL_DB": "~/.recall/recall.sqlite3"
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

## Field Reference (authoritative — from `src/core/schema.ts`)

All nine top-level blocks are required: `actor`, `intent`, `content`, `scope`,
`tags`, `evidence`, `confidence`, `provenance`, `policy`. Plus `schema_version`,
which must equal `recall.write.v1`.

- **actor** — `kind` ∈ `llm | human | daemon | connector | program`;
  `id` required non-empty string; `display` optional string.
- **intent** — `kind` ∈ `observation | witness | belief_update | task |
  objective | goal | decision | risk | constraint | contradiction | conflict |
  hypothesis | lemma | question | assumption | preference | checkpoint |
  artifact | source | domain | transfer | action | trust | meta | reflection |
  identity | handoff | session | benchmark_run | program | relation |
  context_packet | work_candidate | proxy_score | verification_result |
  blind_lock | allocation_plan | miss`;
  `operation` ∈ `create | update | supersede | link | archive`.
- **content** — `title` required string; `body` required string;
  `summary` optional string.
- **scope** — `project` required string; `tenant` required string;
  `path` optional string; `session` optional string.
- **tags** — **required families (each a non-empty string array):** `topics`,
  `entities`, `rings`, `lifecycle`, `quality`. **Optional string arrays:**
  `category`, `type`, `subject`, `project`, `idea`, `timestamp`, `identities`,
  `sensitivity`, `permission`. The optional `category/type/subject/project/idea/
  timestamp` facets are free-form but power `recall_subgraph` — include them when
  known. There is no enforced enum on tag values; use stable, lowercase, kebab
  strings. `rings` has no schema enum but its conventional values are
  `foundation`, `runtime`, and `connector` (the architecture rings); `runtime`
  is the safe default for ordinary agent memory.
- **evidence** — all five are required string arrays (empty `[]` is allowed):
  `source_refs`, `depends_on`, `supports`, `contradicts`, `concerns`.
- **confidence** — `value`, `uncertainty`, `concern` are required numbers in
  `[0, 1]`; `source_quality` ∈ `unknown | low | medium | high`;
  `stability` ∈ `ephemeral | volatile | stable`.
- **provenance** — `created_at` required ISO-8601 date string; `origin` ∈
  `human | llm | daemon | connector | program | external`; `produced_by`
  required string; `verification` ∈ `unverified | checked | tested | external`;
  `signature_status` ∈ `unsigned | signed | verified`.
- **policy** — `sensitivity` ∈ `public | private | secret`;
  `allow_background_use` and `requires_review` are required booleans;
  `expires_at` and `reverify_after` are ISO-8601 date strings OR `null`.

Validate before admitting — a malformed proposal lists every failing field path.

### Filling in judgment fields

Some required fields are schema-valid with any in-range value; use these
conventions for consistency across sessions:

- **`actor.id` and `provenance.produced_by`** — use a stable agent identifier,
  e.g. `claude-code`. Do not invent a new id per write; consistent provenance is
  what makes memory auditable.
- **`confidence`** — for a fact stated directly by the user: `value` ≈ 0.9,
  `uncertainty` ≈ 0.1, `concern` ≈ 0.0, `source_quality` `high`,
  `verification` `checked`. For an inference you drew: `value` ≈ 0.5–0.7,
  higher `uncertainty`, `source_quality` `medium`, `verification` `unverified`.
- **`scope.project`** — use the working project's name. For a genuinely
  cross-project personal fact, use a stable label such as `personal` rather than
  inventing a new project name each time.
- **`stability`** — `stable` for durable facts/preferences, `volatile` for
  things expected to change, `ephemeral` for short-lived task state.

## CLI Write Path

The MCP `recall_write` tool is the routine path. When MCP tools are not loaded
(e.g. before a Claude Code restart picks up the server), write via CLI instead.
Write the proposal to a JSON file, then:

```bash
recall validate --json proposal.json --db ~/.recall/recall.sqlite3
recall admit    --json proposal.json --db ~/.recall/recall.sqlite3
```

`recall validate` reports `"ok": true` with `"issues": []` for a valid proposal
(it also echoes the full normalized proposal under a `"value"` key — check `ok`,
not the exact object shape). `recall admit` returns `"accepted": true` with the new cell `id`,
`cellAddress`, and a rollback journal id. `recall admit` is the CLI equivalent of
`recall_write`; `recall --help` labels it "agent/debug path" but it is the
correct and only CLI write path — admission still runs the full firewall,
attenuation, provenance, and rollback machinery.

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
