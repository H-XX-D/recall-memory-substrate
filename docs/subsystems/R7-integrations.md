# R7 Integrations: current agent-runtime contract

Date: 2026-06-26
Status: core agent-integration slice implemented on `rewrite/integration`

R7 connects the current v5 memory core to agent runtimes without adding the
later CLI, MCP server, asset installer, or daemon surfaces. The implemented
slice is pure and testable: it produces directives, prompt context pushes, and
idempotent config merges that later surfaces can apply.

## Module Map

| Module | Role |
|--------|------|
| `src/agent-integration.ts` | Platform-neutral Recall directive block, slash prompt text, prompt context push, stop reminder |
| `src/codex-integration.ts` | Codex AGENTS.md merge, slash prompt export, `[mcp_servers.recall]` TOML upsert |
| `src/claude-integration.ts` | Claude hook-group settings merge, auto-memory env toggle, `.claude.json` MCP upsert |

## Runtime Contract

`buildPromptContextPush(store, objective, opts)` compiles the current Store with
R4 and emits agent-readable text containing:

- the managed Recall durable-memory directive
- the ID-first context packet
- expansion handles
- an explicit expansion warning when conflicts or low-trust cells are present

The directive teaches the stable loop:

1. Read first with `recall compile`.
2. Expand only exact evidence with `recall cell show`.
3. Write durable outcomes back through Recall.
4. Supersede corrections with `evidence.contradicts`.
5. Keep secrets out of normal memory.

## Config Merge Contract

Codex:

- `mergeAgentsMd()` replaces any stale managed Recall block and preserves
  unrelated AGENTS.md content.
- `recallSlashPrompt()` emits the future `/prompts:recall` body.
- `upsertCodexMcpServer()` repairs stale TOML spellings and appends one
  canonical `[mcp_servers.recall]` block.

Claude:

- `mergeClaudeSettings()` installs canonical SessionStart, UserPromptSubmit, and
  Stop hook groups and disables native auto-memory with
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` by default.
- stale Recall hook groups are replaced, unrelated hooks are preserved.
- `upsertClaudeMcpServer()` preserves other MCP servers and registers Recall.

## Deferred From This Slice

- actual filesystem sync/install commands
- bundled hook and skill asset copying
- CLI commands such as `recall codex sync` and `recall claude sync`
- auto-memory import/migration wiring from R6
- ACP, launch-agent service, and MCP server runtime
