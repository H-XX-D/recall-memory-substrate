# Recall

Recall is the v5 Memory Abstraction Layer (MAL) for durable agent context. It
stores typed memory cells in SQLite, admits writes through schema/firewall
checks, compiles compact ID-first context packets, routes across project DBs,
operates deterministic standing programs, serves an MCP stdio server, and
imports/exports portable memory archives.

This 0.5 release ships the stable core plus the MCP server and the Stop-gate
write-back hooks. Deferred surfaces such as the TUI, service installer, and
hardened keychain-backed secret provider are not included yet.

## Install

```sh
npm install -g recall-memory-substrate
```

Recall requires Node.js 22.5.0 or newer because it uses the built-in
`node:sqlite` module. The package installs two commands: `recall` (the CLI) and
`recall-mcp` (the MCP stdio server).

## CLI

```sh
recall version
recall project init --slug my-project --root .
recall status --project my-project
recall compile "what should I remember before this task?" --project my-project
recall search "routing" --project my-project
recall cell show <key-or-handle> --project my-project
```

Writes enter through proposal JSON:

```sh
recall validate --json proposal.json
recall admit --json proposal.json --project my-project
```

The operator runs deterministic standing programs and can optionally admit
derived witness cells:

```sh
recall operate once --project my-project
recall operate once --derive --project my-project
```

Import commands are dry-run first. Add `--apply` to write:

```sh
recall export --project my-project > recall-archive.json
recall import archive --json recall-archive.json --project my-project
recall import mem0 --json mem0.json --project my-project --apply
recall import zep --json zep.json --project my-project --apply
recall import auto-memory --root ~/.claude/projects --project my-project --apply
```

## MCP server

`recall-mcp` speaks JSON-RPC 2.0 over stdio (no SDK). Point an MCP client at the
`recall-mcp` binary; it resolves its database from `RECALL_DB`, falling back to
the home local at `~/.recall/db/home.sqlite3`.

## Library

```ts
import { SqliteStore, admit, compileContext } from "recall-memory-substrate";

const store = new SqliteStore("./recall.sqlite3");

const result = admit(
  {
    kind: "obs",
    title: "Release check passed",
    body: "The local package passed tests and npm pack dry-run.",
    confidence: 0.92,
    verification: "tested",
    sensitivity: "private",
  },
  { store },
);

const packet = compileContext(store, "prepare the release", { budgetWords: 900 });
store.close();
```

## Python Helpers

The npm package includes thin Python helper scripts in `python/`. They shell out
to `recall`; TypeScript remains the source of truth for validation, routing,
storage, and inspection.

```sh
python3 python/recall_helper.py --kind obs --title "Checked" --body "Done" --confidence 0.9 --validate
python3 python/recall_peek.py <key-or-handle> --project my-project
```

## Development

```sh
npm test
npm run typecheck
npm run build
npm run test:python
npm run test:acceptance
npm run release:check
```

`npm run test:acceptance` packs the npm artifact, installs it into a clean
temporary consumer project, and exercises the installed CLI, library exports,
Python helpers, project routing, write/read/search/compile/operate flows,
import/export, and graph lattice structure. `npm run release:check` includes
that installed-artifact gate before the final npm pack dry-run.

## License

Apache-2.0
