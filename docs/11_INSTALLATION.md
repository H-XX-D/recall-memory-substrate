# Installation

Recall should remain easy to install regardless of implementation language.
Current implementation target: TypeScript on Node 24+.

## Local Development

```bash
git clone https://github.com/hendrixx-cnc/recall-memory-substrate.git
cd recall
npm install
npm test
```

## Local CLI Use

```bash
npm run build
node dist/src/cli.js status
```

## Global Local Install

```bash
npm run install:local
recall status
```

## MCP Server

```bash
npm run build
recall-mcp
```

The MCP server is stdio JSON-RPC. It exposes Recall status, lexical search,
semantic search, context compilation, tag-composed subgraphs, and daemon
run-once.

Generate a local MCP config block:

```bash
recall mcp config --db .recall/recall.sqlite3
```

## Daemon LaunchAgent

Generate or install a macOS LaunchAgent plist for background operation:

```bash
recall daemon plist
recall daemon install
recall daemon service-status
recall daemon uninstall
```

`daemon install` writes the plist but does not call `launchctl`; loading a user
service remains an explicit shell step.

## Direct Script Install

```bash
./scripts/install-local.sh
recall status
```

## Installability Requirements

- One package manager command should install dependencies.
- One test command should verify the package.
- One global install path should expose `recall`.
- CLI should create its local `.recall` directory automatically.
- No database server should be required for the local-first install.
- Runtime databases, logs, and generated build output stay out of git.
