# Changelog

## 0.5.0 - 2026-07-02

Transitions the published `recall-memory-substrate` package onto the v5 Memory
Abstraction Layer core and ships two previously deferred surfaces.

- Adds the MCP stdio server (`recall-mcp`): a hand-rolled JSON-RPC 2.0 dispatcher over stdin/stdout with a lean tool set, database resolved from `RECALL_DB` or the home local.
- Adds the Stop-gate write-back lifecycle: a `UserPromptSubmit` hook stamps turn start, and the `Stop` hook holds the turn until a durable cell was admitted this turn, re-injecting a fill-or-reject write template.
- Adds admission fill-or-reject (a field still equal to its template description is rejected) and dangling-edge rejection (an edge target that resolves to no cell is rejected, not silently dropped).
- Adds `resolveCell`, accepting every id form the CLI and peek accept: full key, `>=4`-hex id prefix, handle, and `graph:uuid` address.
- Keeps the published npm identity `recall-memory-substrate` and the `recall` CLI command; the CLI/library/docs no longer reference the interim `recall-mal` name.

## 0.1.0 - 2026-06-26

Initial public preview of Recall MAL.

- Adds typed v5 memory cells, handles, MAL row rendering, and strict proposal validation.
- Adds admission checks for schema, public-data safety, secret screening, calibration, and encrypted secret aliases.
- Adds SQLite storage, FTS5/BM25 search with fallback, evidence mass walks, and store stats.
- Adds context packet compile/formatting, lazy cell inspection, and expansion handles.
- Adds central project routing, local graph discovery, and federated home reads.
- Adds deterministic standing programs and `recall operate once`.
- Adds CLI commands for project routing, status, compile, search, cell inspection, validation, admission, operation, export, and dry-run-first imports.
- Adds Mem0, Zep, Claude auto-memory, and portable cell archive import/export adapters.
- Adds Python helper scripts that delegate validation, admission, and inspection to `recall`.
- Adds installed-artifact release acceptance coverage for CLI/library/Python behavior and graph lattice structure.
- Fixes project routing across canonicalized/symlinked roots so nested cwd resolution matches registered project roots.
