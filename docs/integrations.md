# Integrations

Recall wires into your coding assistant two ways: an MCP server for read and write tools, and a set of lifecycle hooks that push memory context into every turn without you asking for it. This guide covers setup for Claude Code and Codex, the scheduled maintenance that keeps a Recall store healthy, the bundled Python helpers, and common troubleshooting steps.

All sync commands are dry run by default. They print what would change and touch nothing on disk until you pass `--apply`. Any existing file that would change is copied to a `.bak` alongside it first, so a sync can always be undone by hand.

## Claude Code

### Sync

```
recall claude sync --apply
```

This updates two settings files under your home directory and installs the bundled assets:

- `~/.claude/settings.json`: adds `SessionStart`, `UserPromptSubmit`, and `Stop` hook entries and sets `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` to `"1"`.
- `~/.claude.json`: registers the `recall` MCP server (`type: stdio`, `command: recall-mcp`) so Claude Code can call all nineteen Recall tools (see `docs/mcp.md`).
- `~/.claude/hooks/recall-session-start.py`: the bundled hook script that serves all the hook events.
- `~/.claude/skills/recall/`: the Recall skills tree (see below).

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

One script serves every event; the argument selects the mode.

- **SessionStart**: runs `recall-session-start.py` with no arguments. It prints a standing directive telling the assistant to consult Recall before trusting its own recollection, plus a 7-day recent-activity summary produced by `recall diff --since 7d --summary` and labelled with the scope `recall where` reports (a registered project, or the graph-wide home store). If the installed CLI predates the `diff` verb, the summary degrades silently and only the directive is emitted. Timeouts: 12 seconds for the diff, 6 for the scope label.
- **UserPromptSubmit** (the prompt digest): runs `recall-session-start.py --prompt` on every prompt. It runs `recall compile` against the prompt (hard 4 second cap, routed by the session's working directory) and pushes a mini index into context: up to five relevant cells as ids and titles only, each row ending in a `[kind:id]` token. A row whose cell appears in the packet's stale or low-trust section is tagged `[STALE]`; a row whose cell is the superseded side of a conflict is tagged `[SUPERSEDED?]`. The digest ends with exactly one footer: a DIG REQUIRED demand when a shown row is flagged, a tripwire count when conflicts or stale cells exist elsewhere on the topic, or a reminder that the index is awareness, not a substitute for a real read. A short prompt, a missing binary, a timeout, or an empty relevance section pushes nothing beyond the primer. The digest is deliberately incomplete: bodies, the conflict trace, and calibration are withheld so the assistant still runs a real `recall compile`.
- **Stop**: runs `recall-session-start.py --stop`. Two independent gates, loop-guarded so neither ever blocks more than once per turn:
  - The **dig gate**. When the prompt digest flags a row, the obligation is recorded as a per-session state file (under `$RECALL_HOME/.dig_pending/`, or `~/.recall/.dig_pending/` when `RECALL_HOME` is unset). At turn end this gate consumes the state file and checks the transcript for a real Recall read since the flag was raised (a `recall compile`, `recall search`, `recall cell show`, a peek script call, or an MCP recall tool). If no read happened and the reply engaged with the flagged cell (it names the id or shares distinctive title tokens), the turn is blocked once with instructions to read the flagged cell and correct anything asserted from it.
  - The **evidence gate**. If the turn's reply claims something works, passes, or is done, and no test, build, or run command appears in the turn's tool use, the turn is held once with a request to run the verification or soften the claim. Opt out by setting `RECALL_GATE_EVIDENCE=0` in the environment.
- **UserPromptExpansion**: the script also implements `--expansion`, which pushes the same thin mini index scoped to an expanded slash command and its arguments (index only, no primer, dig obligations recorded the same way). Sync manages the three events above and leaves any existing `UserPromptExpansion` registration in place; to enable this mode, add a `UserPromptExpansion` hook entry pointing at the same script with `--expansion`.

The Python hook is fail-open in every mode: any crash, timeout, or missing dependency falls back to emitting the directive alone (or nothing) rather than blocking your session. The read loop never writes to any Recall database; its only filesystem state is the per-session dig obligation file.

### The skills tree

`recall claude sync --apply` installs a small skills tree at `~/.claude/skills/recall/`, refreshed on every apply with the same `.bak` backup discipline as the settings files:

- `SKILL.md`: task-oriented usage notes for the assistant (compile first, cheap reads via peek, `recall diff` for what changed, `recall health` for pressure, the ten cell kinds, and how to write back).
- `scripts/recall_peek.py`: token-budget-aware single-cell preview, reading the store directly but strictly read-only. The same script ships under `python/` in the package.
- `scripts/recall_router.py`: a rule-based router that picks the cheapest tool for a question shape (hex ids go to peek, temporal wording to `recall diff`, health wording to `recall health`, code-symbol shapes to peek `--match`, everything else to `recall compile`).

Every command the tree documents exists on the current CLI; the session hook's remediation text points at these installed paths, so following its instructions always works after a sync.

### The write gate (opt-in)

`--write-gate` adds a second command to the `UserPromptSubmit` and `Stop` hook entries: `recall-prompt-hook` and `recall-stop-hook`, two small Node binaries bundled with the package. These implement a stricter, fail-closed gate:

- `recall-prompt-hook` stamps the turn's start time to a marker file (per session under `~/.recall/state/stop/`; the `RECALL_STOP_STATE` environment variable overrides the marker path for both hooks).
- `recall-stop-hook` checks whether any durable cell was created in Recall since that marker. If nothing was written, it holds the turn open and re-injects the full write template JSON: every field must be replaced with a real value, because admission rejects a field whose submitted value still equals its template description (the fill-or-reject rule). If something was written, it releases the turn and runs a background maintenance tick.

The hold is fail-closed on the marker: a missing turn-start marker holds the turn. A store that fails to open releases the turn instead, since a gate that cannot read the store cannot judge it. Treat the gate as an opt-in enforcement mechanism, not a default: it will interrupt turns that produce no durable memory write. The Python hooks above always run first and are unaffected by this flag; `--write-gate` only appends the stricter Node hooks alongside them.

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

## Cutting over from a legacy install

A machine that has been running a pre-0.6 Recall (the old `graph_nodes` schema, often with a routing wrapper script shadowing the real binary on `PATH`) moves to the current line in this order. Do not interleave the steps.

1. **Back up first.** Copy the whole database directory (`~/.recall/db`) aside and record a checksum manifest of every `.sqlite3` file, so any step can be verified and undone.
2. **Migrate each store.** For every legacy database, run `recall migrate --from <legacy.sqlite3> --db <fresh-target.sqlite3>` as a dry run, check the counts, then re-run with `--apply`. The legacy source is opened read-only and never mutated; verify its checksum is unchanged afterward. Migrating a legacy home store also imports its `projects` table into the central registry, with any reserved-slug renames reported in the output.
3. **Reindex.** Run `recall reindex --db <target>` on each migrated store so semantic search works over the migrated cells.
4. **Swap the files and upgrade.** Move each migrated target into place, upgrade the global npm package, and confirm `recall version` reports the new version.
5. **Re-sync the assistant.** Run `recall claude sync --apply` (and `recall codex sync --apply` if used) so the installed hook, skills tree, and MCP registration match the new CLI.
6. **Retire the wrapper.** If a routing wrapper shadows `recall` on `PATH`, remove it: the CLI routes by cwd through the project registry natively, and the wrapper's legacy verbs no longer match.
7. **Verify the loop.** Start a session and confirm the directive and activity summary appear, submit a prompt that touches known memory and confirm the mini index, and confirm the MCP tools respond.

Rollback is the reverse: restore the database directory from the backup, restore the settings files from their `.bak` copies, and reinstall the previous package version.

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

The agent is interval-based (`StartInterval`), not a persistent daemon, and does not run immediately on install: it waits for the first interval to elapse. Logs are written to `~/.recall/logs/` (the `RECALL_LOG_DIR` environment variable relocates them; `RECALL_LAUNCH_AGENTS_DIR` relocates the plist directory).

On non-macOS platforms, the same plist file is still written (harmless, and portable if you copy it to a Mac later), but there is no launchd to load it. Instead, the CLI prints an equivalent crontab line you can add yourself with `crontab -e`.

## Python helpers

Two bundled scripts under `python/` give command-line and scripting access to Recall without duplicating its logic. Neither one ever writes to the store directly: all writes go through the CLI's validation and admission gate.

- **`recall_helper.py`**: builds a v5 write proposal from flags (`--kind`, `--title`, `--body`, `--confidence`, plus optional edges, topics, entities, and scope fields) and can optionally submit it by shelling out to `recall validate` or `recall admit --json`. It also exposes `resolve_cli()`, which finds the CLI via the `--cli` flag, the `RECALL_CLI` environment variable, a local `dist/cli.js` build, or the `recall` binary on `PATH`, in that order.
- **`recall_peek.py`**: a token-budget-aware preview of one cell (envelope, body excerpt, relation counts by relation name, hyperedge membership count) or a `--match` listing, in JSON or human-readable form. It reads the store's SQLite file directly but strictly read-only (`mode=ro`), for column-level control over how much of a large body gets loaded. Keys, handles, and 8-plus character key prefixes all resolve. The database resolves from `--db`, else `RECALL_DB`, else the home store under `RECALL_HOME` or `~/.recall`; routing beyond that belongs to the CLI. The same script is installed into the Claude skills tree by `recall claude sync --apply`.

## Troubleshooting

- **Server not found (`recall-mcp` or `recall` command missing)**: confirm the package's bin directory is on `PATH`. If you installed with `npm install -g`, check `npm bin -g`; if running from a local checkout, the `dist/` build must exist (`npm run build`) before the bin scripts resolve.
- **No semantic search hits after a restore or migrate**: newly imported or migrated cells have no vector embedding yet. Run `recall reindex` (or `recall reindex --missing-only` to only index cells that lack one) to backfill them.
- **Hooks not firing**: run `recall claude status` to confirm the hook entries, the auto-memory environment flag, and the MCP registration are all in place. If they are missing or stale, re-run `recall claude sync --apply`.

Next: `docs/import-export.md` for moving memory in and out of a store.
