# LLM Integration Guide

This guide is for LLM agents, MCP clients, and adapter authors that want Recall
to operate as active memory rather than passive notes.

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
7. Compile compact context back to the LLM. Use expansion handles when more
   detail is needed instead of dumping large graph neighborhoods.
8. Treat daemon output as normal evidence. Daemon, eval, program, and DAG
   derivations must pass through admission like any other write.

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

## Agent Loop

```text
user task
  -> recall_compile task packet
  -> do work
  -> recall_write source-grounded observations, decisions, risks, and tasks
  -> run recall_daemon_run_once when maintenance is useful
  -> recall_compile final packet if the next turn needs continuity
```

Use CLI/TUI for inspection, correction, rollback, and explicit human actions.
Use MCP for the routine agent path.
