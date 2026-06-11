# Installation

Recall installs as a single Node.js package that provides two binaries:
`recall` (CLI + TUI) and `recall-mcp` (stdio MCP server).

## Requirements

- **Node.js 24 or newer** (Recall uses Node's built-in SQLite: no database
  server, no native compilation)
- **npm** (ships with Node)
- Linux, macOS, or Windows. The CI suite (build, tests, e2e, smoke) runs
  green on all three. The core runtime is plain local Node; only the daemon
  *service* helper is platform-specific (it emits macOS LaunchAgent plists).
  On Linux/Windows, run the daemon directly instead (see below).

Check your Node version first:

```bash
node --version   # must be v24.0.0 or newer
```

## Option A: npm global install (recommended)

```bash
npm install -g github:H-XX-D/recall-memory-substrate
```

This fetches the repository, builds it, and links `recall` and `recall-mcp`
onto your PATH.

## Option B: installer script

```bash
curl -fsSL https://raw.githubusercontent.com/H-XX-D/recall-memory-substrate/main/scripts/install.sh | bash
```

The script verifies Node 24+, clones the repository into
`~/.recall-memory-substrate/source` (override with `RECALL_INSTALL_DIR`),
builds it, and links the binaries. Re-running the script updates the
checkout and rebuilds. It is also the upgrade path for this option.

## Option C: from source (development)

```bash
git clone https://github.com/H-XX-D/recall-memory-substrate.git
cd recall-memory-substrate
npm install
npm test             # verify the checkout: 83 tests
npm run install:local   # build + npm link → global `recall` / `recall-mcp`
```

Or equivalently: `./scripts/install-local.sh`.

## Verify the install

```bash
recall init       # creates ./.recall/recall.sqlite3 in the current directory
recall status     # prints store health, counts, and config
```

`recall init` creates the local graph database wherever you run it. One
`.recall/` per project is the intended pattern. Runtime databases and logs
are git-ignored by default.

From a source checkout you can also run the full verification suite:

```bash
npm test          # 83 unit/integration tests
npm run e2e       # 94 end-to-end checks
npm run smoke     # init + status on a throwaway db
```

## Set up the MCP server (for agents)

```bash
recall mcp config --db .recall/recall.sqlite3   # prints an MCP config block
```

Paste the block into any MCP-capable client (Claude Code, desktop apps,
agent runtimes). The server is stdio JSON-RPC and exposes 42 tools:
compile, write, search, subgraphs, hyperedges, programs, DAGs, evals, ACP
coordination, calibration, and more. It exits on its own after 30 idle
minutes (`RECALL_MCP_IDLE_EXIT_MS` to tune, `0` to disable); clients respawn
it on demand.

Then give your agent its operating instructions: drop the
[LLM System Prompt](LLM_SYSTEM_PROMPT.md) into its custom instructions, and
see the [LLM Integration Guide](LLM_INTEGRATION.md) for the full contract.

## Optional: background daemon (macOS)

```bash
recall daemon plist            # generate a LaunchAgent plist
recall daemon install          # write the plist (does not call launchctl)
recall daemon service-status
recall daemon uninstall
```

`daemon install` writes the plist but does not load it. Loading a user
service stays an explicit step:

```bash
launchctl load ~/Library/LaunchAgents/io.recall.memory.daemon.plist
```

On Linux and Windows (and macOS if you prefer not to use LaunchAgent), run
maintenance directly instead:

```bash
recall daemon run-once --derive
recall daemon run --interval-ms 60000
```

## Upgrading

| Installed via | Upgrade with |
|---|---|
| Option A (npm) | `npm install -g github:H-XX-D/recall-memory-substrate` again |
| Option B (script) | Re-run the installer script |
| Option C (source) | `git pull && npm install && npm run install:local` |

Databases migrate forward automatically on first open; existing data is
preserved. (FTS indexes backfill on first open after an upgrade.)

## Uninstalling

```bash
npm uninstall -g recall-memory-substrate
rm -rf ~/.recall-memory-substrate        # only if you used the installer script
```

Your data is never deleted by an uninstall: each project's graph lives in
its own `.recall/` directory. Remove those explicitly if you want the data
gone too.

## Troubleshooting

**`Recall requires Node 24 or newer`**: install a current Node (e.g.
`brew install node`, or via nvm: `nvm install 24 && nvm use 24`) and rerun.

**`recall: command not found` after npm install**: your npm global bin
directory isn't on PATH. Find it with `npm prefix -g` (binaries are in
`<prefix>/bin`) and add it to your shell profile.

**`ExperimentalWarning: SQLite is an experimental feature`**: harmless;
Node 24's built-in SQLite is flagged experimental upstream. Recall's own
scripts suppress it with `--disable-warning=ExperimentalWarning`.

**Wrong database**: database routing has a clear precedence: an explicit
`--db <path>` flag wins, otherwise the `RECALL_DB` environment variable is
used if set, otherwise Recall falls back to `./.recall/recall.sqlite3`
relative to where you run it. `RECALL_DB` is the same variable the MCP
server reads, so setting it once points the CLI, agents, and helper
scripts at one shared store. `recall status` shows which database you're
talking to.

## Installability requirements (project policy)

- One package manager command installs everything.
- One test command verifies the package.
- One global install path exposes `recall`.
- The CLI creates its local `.recall` directory automatically.
- No database server required for the local-first install.
- Runtime databases, logs, and build output stay out of git.
