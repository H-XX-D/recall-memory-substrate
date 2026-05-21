# Recall

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](package.json)
[![Status](https://img.shields.io/badge/status-early%20runtime-orange.svg)](#project-status)

Recall is a local-first active memory substrate for LLM agents.

It stores structured evidence, decisions, risks, tasks, witnesses,
contradictions, eval results, and derivations outside the LLM context window.
Agents interact through a strict write schema and receive compact compiled
context packets instead of raw memory dumps.

Recall is built around one runtime:

- strict `recall.write.v1` admission with firewall checks and rollback
- addressable graph cells and n-ary hyperedges
- category/type/subject/project/idea/timestamp tags for subgraph composition
- semantic search and word-budget context compilation
- encrypted Secrets side graph with explicit user confirmation
- CLI, TUI, MCP server, and quiet daemon maintenance
- sandboxed hyperedge programs, optional DAG overlays, holonomy witnesses, and
  persisted evals

## Requirements

- Node.js 24 or newer
- npm
- macOS, Linux, or any platform supported by Node's built-in SQLite module

The daemon service helper currently generates macOS LaunchAgent plists. The core
CLI, MCP server, database, tests, and E2E checks are local Node processes.

## Quick Start

```bash
git clone https://github.com/hendrixx-cnc/recall-memory-substrate.git
cd recall
npm install
npm test
npm run install:local
recall status
```

For a full release smoke check:

```bash
npm run smoke
npm run e2e
```

## CLI Usage

```bash
recall init
recall status
recall search "context compiler"
recall semantic "active memory graph"
recall semantic reindex
recall subgraph --project Recall --category memory --subject compiler
recall compile "prepare the next agent turn" --words 900
recall tui
```

Runtime state is local by default:

```text
.recall/recall.sqlite3
.recall/secrets.sqlite3
```

These files are ignored by git.

## Agent And MCP Usage

Routine memory is agent-managed through MCP. The user should not need to
manually save ordinary observations, witnesses, risks, decisions, tasks, or
context updates.

Generate an MCP config block:

```bash
recall mcp config --db .recall/recall.sqlite3
```

Start the stdio MCP server:

```bash
recall-mcp
```

Primary MCP tools:

- `recall_write`: submit strict LLM-managed memory proposals
- `recall_compile`: compile a compact context packet for a task
- `recall_search` and `recall_semantic`: retrieve graph evidence
- `recall_subgraph`: compose subgraphs from structured tags
- `recall_daemon_run_once`: run one outside-LLM maintenance pass

See [LLM Integration Guide](docs/LLM_INTEGRATION.md) for the full agent
operating contract and proposal shape.

## Write Model

All durable memory enters Recall as a `recall.write.v1` proposal:

```bash
recall validate --json proposal.json
recall admit --json proposal.json
```

Admission validates schema, blocks secret-looking content, attenuates unsupported
claims, writes graph cells, records provenance, and creates rollback entries.

Rollback is explicit:

```bash
recall rollback list
recall rollback show <journal-id>
recall rollback apply <journal-id>
```

## Secrets

Secrets never enter the primary graph. They are stored only in the encrypted
Secrets side graph, and only when explicitly requested:

```bash
printf 'password\nsecret-value' | recall secrets save \
  --title "service token" \
  --confirm-secret-save \
  --password-stdin \
  --value-stdin

recall secrets list
printf 'password\n' | recall secrets get <secret-id> --password-stdin
```

Secret payloads are encrypted with AES-256-GCM using a scrypt-derived key.
Listing secrets returns metadata only.

## Advanced Graph Runtime

Hyperedges and programs:

```bash
recall hyperedge add --json hyperedge.json
recall program add <hyperedge-id> --json program.json
recall program run <program-id> --derive
recall program runs
```

DAG overlays and holonomy witnesses:

```bash
recall dag add --json overlay.json
recall dag analyze <overlay-id> --derive
```

Eval closure:

```bash
recall eval run --derive
recall eval list
```

The base memory structure is a hypernetwork, not a DAG. DAGs are optional
overlays for ordered workflows, evidence chains, or execution traces.

## Daemon

Run one quiet maintenance pass:

```bash
recall daemon run-once
recall daemon run-once --derive
```

Run continuously:

```bash
recall daemon run --interval-ms 60000
```

Generate or install a macOS LaunchAgent plist:

```bash
recall daemon plist
recall daemon install
recall daemon service-status
recall daemon uninstall
```

`daemon install` writes the plist only. Loading or unloading with `launchctl`
remains an explicit user action.

## Documentation

- [Architecture](docs/01_ARCHITECTURE.md)
- [Strict Write Schema](docs/02_WRITE_SCHEMA.md)
- [Tagging And Subgraphs](docs/03_TAGGING_AND_SUBGRAPHS.md)
- [Context Compiler](docs/04_CONTEXT_COMPILER.md)
- [CLI And TUI](docs/05_CLI_TUI.md)
- [Hyperedge Programs](docs/06_HYPEREDGE_PROGRAMS.md)
- [Evals](docs/07_EVALS.md)
- [Installation](docs/11_INSTALLATION.md)
- [Secrets Side Graph](docs/12_SECRETS_SIDE_GRAPH.md)
- [Daemon, MCP, Semantic Search, And Subgraphs](docs/13_DAEMON_MCP_SEMANTIC_SUBGRAPHS.md)
- [Addressable Cells And Hypernetworks](docs/14_ADDRESSABLE_CELLS_AND_HYPERNETWORKS.md)
- [LLM Managed Memory](docs/15_LLM_MANAGED_MEMORY.md)
- [Derivation Closure](docs/16_DERIVATION_CLOSURE.md)
- [LLM Integration Guide](docs/LLM_INTEGRATION.md)

## Development

```bash
npm install
npm run build
npm test
npm run smoke
npm run e2e
```

`npm run e2e` builds the project and exercises the public paths end to end:
CLI, strict writes, search, semantic search, subgraphs, compiler, TUI, rollback,
secrets, hyperedges, programs, DAG overlays, evals, daemon lease behavior,
LaunchAgent helpers, and MCP tools.

## Project Status

Recall is an early working runtime foundation. It is suitable for local
experimentation and integration work, but it should not claim production-grade
or state-of-the-art behavior without external benchmarks and deployment review.

## Security

Read [SECURITY.md](SECURITY.md) before using Recall with sensitive data.

Important defaults:

- runtime databases and logs are ignored by git
- primary graph writes reject secret-looking content
- encrypted secret saves require explicit confirmation
- hyperedge programs are sandboxed declared operations, not arbitrary code

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep changes schema-first, small,
tested, and aligned with the single-runtime architecture.

## License

Recall is licensed under the [Apache License 2.0](LICENSE).
