# CLI And TUI

## CLI Shape

```text
recall init
recall status
recall storage
recall acp status
recall acp send --json request.json
recall acp list [--limit 20] [--acp-status completed]
recall acp show <request-id>
recall acp process [--limit 20] [--acp-manager recall-acp-manager]
recall acp run [--interval-ms 5000] [--limit 20]
recall compact
recall beliefs
recall maintenance [--derive]
recall tick [--derive]
recall operate once [--derive] [--compact]
recall operate once --no-eval --no-tick --no-daemon
recall operate list [--limit 20]
recall operate show <operator-run-id>
recall page index
recall page witnesses [--project Recall]
recall cell show <cell-id-or-address>
recall cell show '<cell-id>#content.summary'
recall search "query"
recall semantic "query"
recall semantic reindex
recall compile "task" --words 900
recall compile "task" --words 900 --inline-refs --reference-parameters
recall subgraph --category memory --type witness --subject compiler --project Recall --idea context-packet --timestamp 2026-05-21
recall subgraph --topic compiler --identity agent:codex --ring runtime
recall rollback list
recall rollback show <journal-id>
recall rollback apply <journal-id>
recall workflow allocate --json candidates.json [--limit 8] [--derive]
recall blind-lock add --json blind-lock.json
recall secrets status
recall secrets list
recall secrets save --title "name" --confirm-secret-save --password-stdin --value-stdin
recall secrets get <id> --password-stdin
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
decide what can land. CLI write/admit commands may exist for connector plumbing,
tests, migrations, and debugging, but they are not the primary interaction model.

For compact references, use cell IDs or addresses instead of copied content.
When a command or JSON file needs only one parameter from a cell, use a dotted
field path after `#`, for example `<cell-id>#content.summary` or
`recall://cell/...#confidence.value`. Multi-party relation members and DAG
overlay nodes also accept addresses and normalize them to cell IDs.

Compiler output is ID-first by default. `expansion_handles` are short IDs that
can be passed to `recall cell show`; use `--inline-refs` and
`--reference-parameters` only when the caller really needs resolved values in
the packet.

## TUI Panels

Implemented now:

- Overview: graph size, rollback count, advanced operation counts, DAG
  overlays, eval runs, operator runs, ACP request counts, belief pressure,
  stale/low-trust cells, contradiction pressure, and the top next action.
- Recent Cells: latest addressable cells and handles.
- Rollback Journal: latest rollback entries and dry-run/apply path.
- Operator Runs: latest mechanical cycle reports and ledger IDs.

Target panels:

- Write Queue: proposals awaiting admission.
- Beliefs: expanded belief values, confidence, evidence counts.
- Conflicts: expanded contradictions and concern edges.
- Subgraphs: saved graph filters and compiled packets.
- Programs: declared graph operations, permissions, last run, failures.
- Rollback: journal entries and dry-run previews.
- Evals: recall, stale suppression, contradiction detection, task continuity.
- Logs: daemon activity without raw noisy dumps.

## Invisible Operation

The daemon should not chat with the user. It should maintain state quietly,
produce audit logs, and surface only severe alerts through CLI/TUI status.

`recall operate once` is the highest-level mechanical pass. It acquires an
operator lease, captures preflight health, refreshes semantic search, runs the
default eval suite, lets daemon maintenance write through admission, runs the
cognitive tick, optionally compacts SQLite, and returns postflight counters plus
accepted/rejected write counts. It also records a compact operator-run ledger
entry so previous mechanical passes can be listed or shown without becoming
normal graph memory. Disable individual phases with `--no-eval`, `--no-tick`,
`--no-daemon`, or `--no-semantic` when a narrower pass is needed.

ACP is the internal agent communication protocol. It gives an inside manager a
bounded request queue for graph work, status checks, search, writes, and other
runtime actions without turning the exchange into ordinary memory cells.
`recall acp run` keeps that manager active on a timer so it can keep draining
the queue without a user in the loop.
