# Installation

Recall installs as a single Node.js package that provides two binaries:
`recall` (CLI + TUI) and `recall-mcp` (stdio MCP server).

## Requirements

- **Node.js 24 or newer** (Recall uses Node's built-in SQLite: no database
  server, no native compilation)
- **npm** (ships with Node)
- Linux, macOS, or Windows. The CI matrix runs build, tests, e2e, and smoke
  on all three; the readiness lane additionally runs MCP smoke, Python
  hooks/toolkit checks, public benchmarks, and installer validation on Linux.
  The core runtime is plain local Node; only the daemon *service* helper is
  platform-specific (it emits macOS LaunchAgent plists). On Linux/Windows, run
  the daemon directly instead (see below).

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
npm test             # verify the checkout: 162 unit/integration tests
npm run install:local   # build + npm link → global `recall` / `recall-mcp`
```

Or equivalently: `./scripts/install-local.sh`.

## Verify the install

```bash
recall version    # confirms the installed package version
recall init       # creates ./.recall/recall.sqlite3 in the current directory
recall status     # prints store health, counts, and config
```

`recall init` creates the local graph database wherever you run it. One
`.recall/` per project is the intended pattern. Runtime databases and logs
are git-ignored by default.

From a source checkout you can also run the full verification suite:

```bash
npm test          # 162 unit/integration tests
npm run e2e       # 94 end-to-end checks
npm run smoke     # init + status on a throwaway db
npm run smoke:mcp # stdio MCP initialize + tools/list smoke
npm run test:python
npm run verify:full
```

## Put your agent on Recall (one command)

The fastest path — and what `scripts/install.sh` runs automatically for any
supported agent CLI it detects. Each command is idempotent (safe to re-run on
every update) and backs up your config before editing.

**Claude Code:**

```bash
recall claude sync     # installs the recall skill + MCP server + the
                       # SessionStart/UserPromptSubmit consult-Recall hook, and sets
                       # CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 so Recall is THE memory layer
recall claude status   # report which pieces are installed
recall claude enable-auto-memory   # revert: re-enable Claude's native note-memory
```

Keep native auto-memory during sync with `RECALL_KEEP_AUTOMEMORY=1`. Touches
`~/.claude/skills/recall/`, `~/.claude.json` (MCP), and `~/.claude/settings.json`
(hook + env) — nothing else.

Bring your existing Claude Code auto-memory along:

```bash
recall import auto-memory [--root path] [--project name] [--apply] [--db path]
```

This imports `~/.claude/projects/<slug>/memory/*.md` files into Recall as
calibrated cells. It is dry-run by default — pass `--apply` to write. The
import is idempotent per file content, and a changed file supersedes its prior
version via a `contradicts` edge: own your memory, cancel the subscription.

**OpenAI Codex:**

```bash
recall codex sync      # installs the recall skill, registers the MCP server under
                       # [mcp_servers.recall] in ~/.codex/config.toml, and adds a
                       # Recall directive to ~/.codex/AGENTS.md (Codex's always-read instructions)
recall codex status    # report which pieces are installed
```

Codex exposes no native-memory kill switch, so displacement is prompt-level via
the AGENTS.md directive. **Restart the agent after either sync** and it's armed —
it consults memory before relying on recollection and writes durable findings
back on its own; you never have to tell it to "save."

## Other MCP clients (manual setup)

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

`recall repair` prunes dangling or unresolvable trust edges. It is dry-run by
default; pass `--apply` to delete:

```bash
recall repair [--apply] [--db path]
```

## Upgrading

| Installed via | Upgrade with |
|---|---|
| Option A (npm) | `npm install -g github:H-XX-D/recall-memory-substrate` again |
| Option B (script) | Re-run the installer script |
| Option C (source) | `git pull && npm install && npm run install:local` |

Databases migrate forward automatically on first open; existing data is
preserved. (FTS indexes backfill on first open after an upgrade.)
For heavily used stores, export first:

```bash
recall export > recall-before-upgrade.json
```

Restore into a fresh database with:

```bash
recall import --json recall-before-upgrade.json --db .recall/restored.sqlite3
```

See [Backup And Recovery](20_BACKUP_AND_RECOVERY.md).

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
