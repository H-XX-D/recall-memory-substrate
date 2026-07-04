# Integrations

Recall wires into your coding assistant two ways: an MCP server for read and write tools, and a set of lifecycle hooks that push memory context into every turn without you asking for it. This guide covers setup for Claude Code and Codex, the scheduled maintenance that keeps a Recall store healthy, the bundled Python helpers, and common troubleshooting steps.

All sync commands are dry run by default. They print what would change and touch nothing on disk until you pass `--apply`. Any existing file that would change is copied to a `.bak` alongside it first, so a sync can always be undone by hand.

## Claude Code

### Sync

```
recall claude sync --apply
```

This updates two files under your home directory:

- `~/.claude/settings.json`: adds `SessionStart`, `UserPromptSubmit`, and `Stop` hook entries, sets `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` to `"1"`, and installs the bundled hook script to `~/.claude/hooks/recall-session-start.py`.
- `~/.claude.json`: registers the `recall` MCP server (`type: stdio`, `command: recall-mcp`) so Claude Code can call the `recall_search`, `recall_compile`, `recall_cell`, `recall_write`, and `recall_status` tools.

Run without `--apply` first to preview the diff: the command reports which settings keys would change (`settingsChanged`), whether the MCP block would change (`mcpChanged`), and where backups would land, without writing anything.

Flags:

- `--apply`: write the changes. Without it, the command only reports what it would do.
- `--keep-automemory`: leave Claude Code's built-in auto-memory feature enabled instead of disabling it, and skip the one-time lift of existing auto-memory transcripts into Recall's home store.
- `--write-gate`: add the optional write-back gate hooks (see below).
- `--root path`: override where auto-memory transcripts are read from (defaults to `~/.claude/projects`).
- `--db path`: override the Recall database the auto-memory import writes into (defaults to the home store).

By default (without `--keep-automemory`), sync also imports any existing Claude Code auto-memory transcripts into Recall's home database, so history you already have does not get lost when auto-memory is turned off.

### Status

```
recall claude status
```

Reports whether the three hooks are installed, whether auto-memory is disabled, and whether the MCP server is registered, without changing anything.

### What each hook does

- **SessionStart**: runs `recall-session-start.py` with no arguments. It prints a standing directive telling the assistant to consult Recall before trusting its own recollection, plus a 7-day recent-activity summary scoped to whichever database the current directory routes to (a registered project, or the global store).
- **UserPromptSubmit**: runs `recall-session-start.py --prompt` on every prompt. It compiles a mini index (just cell ids and titles, not bodies) of memory relevant to that prompt, and flags any row that is stale or has been superseded so the assistant cannot act on outdated context without noticing. This hook is deliberately incomplete: it points at what exists so the assistant runs a real `recall compile` or `recall search` for the full picture, rather than replacing that step.
- **Stop**: runs `recall-session-start.py --stop`. If the prompt hook flagged a stale or superseded cell during this turn, this hook checks whether the transcript shows Recall actually being read since the flag was raised. If not, and if the reply appears to have relied on that cell, it blocks the turn once with a message asking the assistant to dig into the flagged cell and correct anything asserted from it. It never blocks more than once per flagged turn.

The Python hooks are fail-open: any crash, timeout, or missing dependency falls back to emitting the directive alone (or nothing) rather than blocking your session.

### The write gate (opt-in)

`--write-gate` adds a second command to the `UserPromptSubmit` and `Stop` hook entries: `recall-prompt-hook` and `recall-stop-hook`, two small Node binaries bundled with the package. These implement a stricter, fail-closed gate:

- `recall-prompt-hook` stamps the turn's start time to a marker file.
- `recall-stop-hook` checks whether any durable cell was created in Recall since that marker. If nothing was written, it holds the turn open with a prompt to admit a finding or explicitly decline; if something was written, it releases the turn and runs a background maintenance tick.

This is fail-closed: if the turn-start marker is missing or the store cannot be opened, the gate holds by default rather than letting the turn through. Because of this, treat it as an opt-in enforcement mechanism, not a default: it will interrupt turns that produce no durable memory write. The Python hooks above always run first and are unaffected by this flag; `--write-gate` only appends the stricter Node hooks alongside them.

### Uninstalling

There is no dedicated uninstall command. To remove the integration:

- Restore `~/.claude/settings.json` and `~/.claude.json` from the `.bak` files sync created, if you still have them (each sync overwrites the previous `.bak`, so restore before running sync again).
- Or edit `~/.claude/settings.json` by hand: remove the `SessionStart`, `UserPromptSubmit`, and `Stop` hook entries whose command references `recall-session-start.py` (and `recall-prompt-hook` / `recall-stop-hook` if you used `--write-gate`), and remove `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` if you want auto-memory back.
- Remove the `recall` entry from `mcpServers` in `~/.claude.json`.
- Optionally delete `~/.claude/hooks/recall-session-start.py`.

## Codex

```
recall codex sync --apply
```

This updates two files under your home directory:

- `~/.codex/config.toml`: adds an `[mcp_servers.recall]` table pointing at the `recall-mcp` command (and, if `--db` is given, an `[mcp_servers.recall.env]` table setting `RECALL_DB`).
- `~/.codex/AGENTS.md`: inserts a managed block (bounded by `<!-- recall:begin -->` / `<!-- recall:end -->` markers) describing Recall as the durable memory layer and how to read from and write back to it.

Re-running sync replaces only the managed table or block; anything else you have in either file is left untouched. `recall codex status` reports whether the MCP table and the AGENTS.md block are present without changing anything.

Flags:

- `--apply`: write the changes.
- `--db path`: set `RECALL_DB` for the MCP server entry.

To remove the integration, delete the `[mcp_servers.recall]` table from `config.toml` and the block between the `recall:begin` / `recall:end` markers in `AGENTS.md`, or restore both files from their `.bak` backups.

## Scheduled maintenance

Recall stores benefit from a periodic maintenance pass so that derived witnesses, evaluation scores, and semantic vectors stay current without you running commands by hand.

### `recall maintain`

```
recall maintain --all-graphs
```

One maintenance pass runs, in order:

1. An operator tick, which advances any standing programs and derives new witness cells from their output.
2. The default evaluation suite, scoring the current graph and deriving a witness of the result.
3. A daily health witness, summarizing memory health (staleness, contradictions, and similar signals) for the graph.
4. A semantic reindex of any cells missing a vector embedding.

Each of these four steps runs independently: if one fails, the others still run, and the failure is reported per-step rather than aborting the whole pass. Every step is idempotent, so running maintenance repeatedly (on a schedule or by hand) is always safe: an unchanged result collapses onto the prior witness instead of creating a duplicate, and only a genuinely changed result produces a new one.

Without `--all-graphs`, maintenance runs once against whichever single database the current directory (or `--db`/`--project`) routes to. With `--all-graphs`, it runs once against the home store and once against every registered project, skipping duplicates if two routes resolve to the same file.

### `recall service install`

```
recall service install [--interval-min 60]
```

On macOS, this writes a launchd agent plist to `~/Library/LaunchAgents` that runs `recall maintain --all-graphs` on a fixed interval (default 60 minutes). The command only writes the plist; it does not load it. After installing, run the `launchctl load` command the CLI prints to activate the schedule, and `recall service uninstall` followed by the printed `launchctl unload` command to deactivate and remove it. `recall service status` reports whether the plist file is present.

The agent is interval-based (`StartInterval`), not a persistent daemon, and does not run immediately on install: it waits for the first interval to elapse. Logs are written to `~/.recall/logs/`.

On non-macOS platforms, the same plist file is still written (harmless, and portable if you copy it to a Mac later), but there is no launchd to load it. Instead, the CLI prints an equivalent crontab line you can add yourself with `crontab -e`.

## Python helpers

Two bundled scripts under `python/` give command-line and scripting access to Recall without duplicating its logic; both shell out to the `recall` (or `recall-mal`) CLI rather than touching SQLite directly, so all validation, admission, and routing stay in one place.

- **`recall_helper.py`**: builds a v5 write proposal from flags (`--kind`, `--title`, `--body`, `--confidence`, plus optional edges, topics, entities, and scope fields) and can optionally submit it by shelling out to `recall validate` or `recall admit --json`. It also exposes `resolve_cli()`, used by the other helper, which finds the CLI via the `--cli` flag, the `RECALL_CLI` environment variable, a local `dist/cli.js` build, or the `recall-mal` binary on `PATH`, in that order.
- **`recall_peek.py`**: a compact preview over `recall cell show <target>`, printing a trimmed summary (title, kind, status, scope, scores, tags, a body preview, and connected edges) in human-readable or JSON form. Useful for a quick look at a cell without paging through its full body.

Both scripts are thin by design: they never read the SQLite store directly, and they perform only light client-side checks before deferring to the CLI's own validation.

## Troubleshooting

- **Server not found (`recall-mcp` or `recall` command missing)**: confirm the package's bin directory is on `PATH`. If you installed with `npm install -g`, check `npm bin -g`; if running from a local checkout, the `dist/` build must exist (`npm run build`) before the bin scripts resolve.
- **No semantic search hits after a restore or migrate**: newly imported or migrated cells have no vector embedding yet. Run `recall reindex` (or `recall reindex --missing-only` to only index cells that lack one) to backfill them.
- **Hooks not firing**: run `recall claude status` to confirm the hook entries, the auto-memory environment flag, and the MCP registration are all in place. If they are missing or stale, re-run `recall claude sync --apply`.
