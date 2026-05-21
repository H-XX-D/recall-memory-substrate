# CLI And TUI

## CLI Shape

```text
recall init
recall status
recall search "query"
recall semantic "query"
recall semantic reindex
recall compile "task" --words 900
recall subgraph --category memory --type witness --subject compiler --project Recall --idea context-packet --timestamp 2026-05-21
recall subgraph --topic compiler --identity agent:codex --ring runtime
recall rollback list
recall rollback show <journal-id>
recall rollback apply <journal-id>
recall secrets status
recall secrets list
recall secrets save --title "name" --confirm-secret-save --password-stdin --value-stdin
recall secrets get <id> --password-stdin
recall hyperedge add --json hyperedge.json
recall hyperedge list
recall program add <hyperedge-id> --json program.json
recall program run <program-id> [--derive]
recall program runs
recall dag add --json overlay.json
recall dag analyze <overlay-id> [--derive]
recall dag list
recall eval run [--derive]
recall mcp config
recall tui
recall daemon status
recall daemon plist
recall daemon install
recall daemon service-status
recall daemon run-once [--derive]
recall daemon run [--derive]
recall daemon uninstall
```

Routine memory writes are not a user workflow. Once Recall is running, the LLM
submits strict write proposals through MCP `recall_write`, and admission/firewall
decide what can land. CLI write/admit commands may exist for adapter plumbing,
tests, migrations, and debugging, but they are not the primary interaction model.

## TUI Panels

Implemented now:

- Overview: graph size, rollback count, hyperedges, programs, DAG overlays,
  eval runs.
- Recent Cells: latest addressable cells and handles.
- Rollback Journal: latest rollback entries and dry-run/apply path.

Target panels:

- Overview: health, daemon status, graph size, pending writes.
- Write Queue: proposals awaiting admission.
- Beliefs: belief values, confidence, evidence counts.
- Conflicts: contradictions and concern edges.
- Subgraphs: saved graph filters and compiled packets.
- Programs: hyperedge programs, permissions, last run, failures.
- Rollback: journal entries and dry-run previews.
- Evals: recall, stale suppression, contradiction detection, task continuity.
- Logs: daemon activity without raw noisy dumps.

## Invisible Operation

The daemon should not chat with the user. It should maintain state quietly,
produce audit logs, and surface only severe alerts through CLI/TUI status.
