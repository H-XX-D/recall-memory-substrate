# LLM Integration Guide

This guide is for LLM agents, MCP clients, and adapter authors that want Recall
to operate as active memory rather than passive notes.

Recall only works well when the LLM follows a strict operating contract. The
LLM is allowed to decide what ordinary memory should be written, but Recall is
responsible for validation, admission, indexing, rollback, and compact context
compilation.

For a pasteable system/developer prompt, see
[LLM System Prompt](LLM_SYSTEM_PROMPT.md).

## User Setup For LLM Apps

Recall needs two pieces in every LLM environment that should use it:

1. MCP access to the Recall server.
2. Persistent instructions telling the LLM how to use Recall.

Install and initialize Recall:

```bash
npm install -g github:H-XX-D/recall-memory-substrate
recall init
recall mcp config --db .recall/recall.sqlite3
```

Add the generated MCP config to your LLM desktop app or agent runtime. Then add
the instructions from [LLM System Prompt](LLM_SYSTEM_PROMPT.md) anywhere that
LLM stores persistent behavior:

- desktop app custom instructions
- desktop app memory or project memory file
- workspace memory files
- repo-level `AGENTS.md`
- `CLAUDE.md`, `.cursorrules`, Cursor project rules, Windsurf rules, or similar
- MCP client profile instructions
- local agent runner system prompt
- team onboarding docs for agents that will use Recall

If more than one LLM app will use Recall, add the same instruction to each app.
The MCP server gives the LLM tools; the persistent instruction tells it when to
read, when to write, what not to store, and how to handle contradictions.

## Mental Model

Every accepted `recall.write.v1` proposal becomes one addressable graph cell.
The proposal blocks do not become separate cells. They are stored as structured
fields on the cell:

- `content` becomes title, body, and summary
- `scope` and `tags` become retrieval and address facets
- `intent`, `evidence`, `confidence`, and `policy` become structured data
- `provenance` records where the claim came from
- evidence arrays create graph relations only when they contain existing cell
  ids
- Recall adds semantic index rows and rollback journal entries automatically

Subgraphs, "pages", and layers are composed views over many cells. Use tags,
relations, hyperedges, and optional DAG overlays to collect cells into larger
structures.

## Operating Contract

1. Read before relying on memory. Use `recall_compile` first, then expand with
   `recall_search`, `recall_semantic`, or `recall_subgraph` only when needed.
2. Write only through `recall_write`. Never write SQLite rows directly.
3. Use `recall.write.v1` exactly. Include actor, intent, content, scope, tags,
   evidence, confidence, provenance, and policy.
4. Keep routine memory seamless. The user should not have to manually save
   ordinary observations, decisions, tasks, risks, witnesses, or constraints.
5. Do not write every message. Write only durable, useful memory that should
   affect future work.
6. Keep secrets out of routine memory. Secret storage requires the explicit CLI
   command `recall secrets save --confirm-secret-save`.
7. Prefer structured evidence. Use `supports`, `contradicts`, `concerns`, and
   `depends_on` with existing cell ids instead of burying relationships in
   prose.
8. Compile compact context back to the LLM. Use expansion handles when more
   detail is needed instead of dumping large graph neighborhoods.
9. Treat daemon output as normal evidence. Daemon, eval, program, and DAG
   derivations must pass through admission like any other write.
10. If a write is rejected, fix the proposal or ask for explicit review. Do not
    bypass admission.

## Agent Loop

Use this loop for normal operation:

```text
new user task
  -> recall_compile({ task, words: 700-1200 })
  -> inspect conflicts, low-trust notes, risks, and expansion handles
  -> use recall_semantic / recall_search / recall_subgraph for missing evidence
  -> do the work
  -> write only durable memory through recall_write
  -> if maintenance is useful, run recall_daemon_run_once
  -> if continuity matters, compile a short final context packet
```

The LLM should be quiet about this loop unless the user asks for memory state,
debug output, or CLI commands.

## Write Decision Table

Write a memory cell when the information is durable and future-relevant:

| Situation | Intent kind | Notes |
| --- | --- | --- |
| User gives a stable project preference or constraint | `constraint` | Include source ref such as `user:<date>` |
| A technical decision is made | `decision` | Link supporting cells if known |
| A verified fact about the project is learned | `observation` | Use source-grounded evidence |
| A claim changes belief state | `belief_update` | Use lower confidence if evidence is weak |
| A future action remains open | `task` | Keep body actionable |
| A risk or blocker appears | `risk` | Use `concern` when not a direct contradiction |
| Work produces a test result, eval result, or witness | `witness` | Prefer checked/tested provenance |
| Existing memory is wrong or conflicts | `witness` or `belief_update` | Link via `contradicts` or `concerns` |

Do not write:

- transient chat filler
- guesses with no future value
- raw command logs unless they are evidence for a durable result
- secrets, tokens, passwords, keys, recovery codes, or private credentials
- duplicate memory that already exists unless it supersedes or contradicts it

## Retrieval Rules

Start each meaningful task with:

```json
{
  "task": "the user's task in concrete terms",
  "words": 900
}
```

Call `recall_compile` with that payload. Treat the returned context packet as
evidence, not absolute truth.

Use expansion handles when the packet points at useful cells:

- use `recall_search` for exact titles, ids, or phrases
- use `recall_semantic` for fuzzy continuity
- use `recall_subgraph` for structured facets such as project, subject, or idea

Do not ask Recall for all memory unless the user explicitly wants inspection.

## Tagging Rules

Tags are how Recall composes subgraphs. Use stable, low-cardinality names where
possible.

Address facets:

- `project`: the product, repo, client, or working project
- `category`: broad domain such as `memory`, `architecture`, `security`,
  `release`, `research`, or `workflow`
- `type`: the memory object type such as `observation`, `decision`, `risk`,
  `task`, `witness`, or `constraint`
- `subject`: concrete thing the memory is about
- `idea`: local theme, hypothesis, feature, or thread
- `timestamp`: ISO date, usually `YYYY-MM-DD`

Required retrieval families:

- `topics`: broad searchable topics
- `entities`: named systems, people, libraries, files, or products
- `rings`: architecture layer such as `foundation`, `runtime`, `adapter`,
  `workflow`, or `release`
- `lifecycle`: usually `active`, `stale`, `superseded`, `candidate`, or
  `resolved`
- `quality`: evidence state such as `source-grounded`, `tested`, `inferred`,
  `unverified`, or `needs-review`

Optional identity tags help cross-agent composition:

- `agent:<name>`
- `user:<name-or-local>`
- `project:<name>`
- `session:<id>`
- `source:<system>`

Use sparse optional facets when necessary, but always include required tag
families.

## Evidence And Confidence

Evidence must be explicit:

- `source_refs`: human-readable sources such as files, URLs, command names, or
  user statements
- `depends_on`: existing cell ids required by this claim
- `supports`: existing cell ids this claim supports
- `contradicts`: existing cell ids this claim contradicts
- `concerns`: existing cell ids this claim weakens or flags without fully
  contradicting

Confidence should match evidence:

- `0.9-1.0`: directly tested, verified, or externally authoritative
- `0.7-0.89`: checked against source material
- `0.4-0.69`: plausible but partial or inferred
- `0.0-0.39`: weak, speculative, or high uncertainty

Use `source_quality: "unknown"` for unsupported or vague claims. Recall will
attenuate unsupported high confidence.

## Contradictions And Stale Memory

Do not silently overwrite memory. When new evidence conflicts with old memory:

1. Search for the older cell.
2. Write a new `witness` or `belief_update` cell.
3. Put the older cell id in `evidence.contradicts` or `evidence.concerns`.
4. Use `intent.operation: "supersede"` only when the new write clearly replaces
   the old claim.
5. Use rollback only for bad writes, not for normal changes of belief.

If memory may decay, set `policy.reverify_after`. If memory should expire, set
`policy.expires_at`.

## Secrets Rule

Never write secrets into `recall_write`. The primary graph must not contain:

- API keys, npm tokens, GitHub tokens, SSH keys, private keys
- passwords, recovery codes, 2FA seeds, QR setup secrets
- session cookies or bearer tokens
- private credentials copied from user messages

If the user explicitly wants to save a secret, tell them to use the encrypted
side graph:

```bash
printf 'password\nsecret-value' | recall secrets save \
  --title "service token" \
  --confirm-secret-save \
  --password-stdin \
  --value-stdin
```

The LLM should not save secrets silently.

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
- `recall_compile`: return a compact task-specific context packet.
- `recall_daemon_run_once`: run one outside-LLM maintenance pass.
- `recall_hyperedge_*`, `recall_program_*`, `recall_dag_*`, and
  `recall_eval_*`: operate advanced graph, derivation, and evaluation features.

## Tool Use Recipes

Start a task:

```json
{
  "tool": "recall_compile",
  "arguments": {
    "task": "implement the next Recall install improvement",
    "words": 900
  }
}
```

Find fuzzy continuity:

```json
{
  "tool": "recall_semantic",
  "arguments": {
    "query": "previous install and release decisions"
  }
}
```

Compose a project subgraph:

```json
{
  "tool": "recall_subgraph",
  "arguments": {
    "project": ["Recall"],
    "category": ["release"],
    "subject": ["installation"],
    "limit": 25
  }
}
```

Write a memory cell:

```json
{
  "tool": "recall_write",
  "arguments": {
    "proposal": {
      "schema_version": "recall.write.v1"
    }
  }
}
```

The `proposal` must be the full schema shown below, not only the
`schema_version`.

Run one maintenance pass:

```json
{
  "tool": "recall_daemon_run_once",
  "arguments": {
    "derive": false
  }
}
```

Use `derive: true` only when the caller wants daemon findings admitted back into
memory through the normal write path.

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

## Fill-In Guidance

`content.title`: short, stable, and specific. Avoid timestamp-only titles.

`content.body`: one durable claim, decision, risk, task, or witness. Avoid
mixing unrelated facts.

`content.summary`: one retrieval-friendly sentence. The compiler prefers this
when building compact context.

`scope.project`: the project name users would expect to search.

`scope.path`: repo path, file path, URL, or empty when not applicable.

`actor.id` and `provenance.produced_by`: stable agent identifier.

`provenance.verification`:

- `checked`: read from source material
- `tested`: verified by a command, test, or eval
- `external`: verified by an outside source
- `unverified`: user statement, inference, or tentative claim

`policy.requires_review`: set `true` when the write is high-impact, sensitive,
or requires human confirmation. Recall rejects review-required writes unless
the caller explicitly overrides review.

## Accepted Write Handling

If `recall_write` returns `accepted: true`, the response contains:

- `node.id`: stable cell id for evidence links
- `node.cellAddress`: addressable cell URI
- `relations`: graph links created from evidence arrays
- `rollbackEntries`: rollback journal entries
- `warnings` and `attenuations`: trust or policy notes

Store and cite the returned `node.id` when future writes support, contradict,
depend on, or concern this cell.

If `accepted: false`, do not claim memory was saved. Read `issues`, fix the
proposal, and try again only if the memory is still worth storing.

## CLI Equivalents

Use these when MCP is unavailable:

```bash
recall compile "task description" --words 900
recall semantic "fuzzy continuity query"
recall subgraph --project Recall --category release --subject installation
recall validate --json proposal.json
recall admit --json proposal.json
recall rollback list
recall rollback show <journal-id>
recall rollback apply <journal-id>
```

Use CLI/TUI for inspection, correction, rollback, and explicit human actions.
Use MCP for the routine agent path.
