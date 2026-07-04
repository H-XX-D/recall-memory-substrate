# Recall

Durable, local memory for AI agents. Recall stores typed memory cells in a SQLite graph, admits every write through a validation gate, and compiles budgeted context packets ranked by evidence rather than keywords. One engine serves three surfaces: a CLI, an MCP server for assistants, and a TypeScript library.

No services, no cloud, no external database. One file per graph, on your machine.

## What it does

- **Typed memory with provenance.** Ten cell kinds (decisions, observations, beliefs, tasks, risks, hypotheses, and more), each carrying confidence, origin, verification level, and policy. Relations are first-class signed edges: support raises a belief's effective confidence, contradiction lowers it, supersession preserves history.
- **A single write gate.** Schema validation, credential screening, deduplication, dangling-reference rejection, and confidence attenuation on every write, with guidance on every accepted write: candidate edges to similar cells, kind and evidence hints, and opt-in standing-program suggestions. Derived writes use deterministic keys, so nothing is ever recorded twice.
- **Hybrid retrieval.** FTS5 BM25 fused with graph degree, effective confidence, and recency decay; semantic search over auto-maintained embeddings; a compile step that turns a task description into a sectioned context packet under a word budget.
- **Deterministic standing programs.** Watch, trend, drift, quorum, allocation, and reflex programs run over the graph without a model in the loop, emitting witness cells only when something actually changed.
- **Self-maintenance.** A built-in eval suite audits store invariants, a health engine tracks belief pressure and staleness, and one idempotent `maintain` pass keeps every graph current, on demand or on a schedule.
- **Portable memory.** Full-graph JSON archives, plus importers for mem0, Zep, and Claude Code auto-memory, all dry-run first and exactly idempotent on re-import.

## Requirements

Node.js 22.5.0 or newer (Recall uses the built-in `node:sqlite`; SQLite is flagged experimental by Node, which prints a startup warning). macOS, Linux, and other POSIX platforms; the scheduled-service helper generates launchd agents on macOS and prints an equivalent crontab line elsewhere.

## Install

From npm:

```sh
npm install -g recall-memory-substrate
```

From GitHub (builds on install):

```sh
npm install -g github:H-XX-D/recall-memory-substrate
```

Two commands are installed: `recall` (the CLI) and `recall-mcp` (the MCP server).

## Quick start

```sh
# Register a project; its memory lives in its own graph.
cd ~/code/my-project
recall project init

# Record a decision.
cat > decision.json <<'JSON'
{
  "kind": "dec",
  "title": "Use SQLite WAL mode for the event store",
  "body": "Chosen for single-writer durability with concurrent readers.",
  "confidence": 0.9,
  "topics": ["storage", "architecture"]
}
JSON
recall admit --json decision.json

# Get context back when you need it.
recall compile "how should the event store handle concurrent reads?"
recall search "WAL"
```

Commands route automatically: an explicit `--db` wins, then `--project <slug>`, then the deepest registered project containing your current directory, then the home graph at `~/.recall/db/home.sqlite3`.

## Use it from an assistant

`recall-mcp` speaks MCP over stdio. Point any MCP client at it:

```json
{
  "mcpServers": {
    "recall": { "type": "stdio", "command": "recall-mcp" }
  }
}
```

Eighteen tools cover search, semantic retrieval, context compilation, writes through the gate, graph structures, standing programs, and health. For Claude Code there is a one-command setup that wires session hooks, registers the server, and imports existing auto-memory:

```sh
recall claude sync --apply
```

Codex gets the same treatment with `recall codex sync --apply`. Both commands preview their changes by default and back up any file they modify.

## Use it as a library

```ts
import { SqliteStore, admit, compileContext } from "recall-memory-substrate";

const store = new SqliteStore("./recall.sqlite3");

admit(
  {
    kind: "obs",
    title: "Release check passed",
    body: "Tests, typecheck, and the packaging dry run all succeeded.",
    confidence: 0.92,
    verification: "tested",
  },
  { store },
);

const packet = compileContext(store, "prepare the release", { budgetWords: 900 });
store.close();
```

Python helpers ship in `python/` for scripted writes and inspection; they shell out to the CLI, which remains the source of truth.

## Keep it maintained

```sh
recall maintain --all-graphs     # one idempotent upkeep pass over every graph
recall service install           # schedule it (launchd on macOS; prints a crontab line elsewhere)
recall health                    # belief pressure, staleness, contradictions
recall storage                   # database size and per-table footprint
```

## Documentation

- [How Recall works](docs/overview.md): cells, edges, scores, the gate, retrieval, programs.
- [CLI reference](docs/cli.md): every command and flag.
- [MCP reference](docs/mcp.md): every tool, with parameters and payloads.
- [Integrations](docs/integrations.md): Claude Code, Codex, scheduled maintenance, hooks.
- [Import and export](docs/import-export.md): archives, mem0, Zep, auto-memory, legacy migration.
- [CHANGELOG](CHANGELOG.md).

## Development

```sh
npm test                 # unit tests
npm run typecheck
npm run test:python      # python helper tests
npm run test:acceptance  # packs, installs into a clean project, exercises the installed artifact
npm run release:check    # all of the above plus a packaging dry run
```

## License

Apache-2.0
