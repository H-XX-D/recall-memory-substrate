# LLM-Managed Memory

Recall should be seamless once running.

The LLM provides and manages normal memory writes. The user should not need to
manually save routine observations, witnesses, tasks, risks, decisions, or
context updates.

## Normal Flow

```text
LLM observes useful durable state
  -> creates write proposal
  -> Recall admission/firewall validates it
  -> graph stores addressable cell
  -> context compiler retrieves it later
```

## MCP Write Path

The MCP tool for normal LLM-managed writes is:

```text
recall_write
```

It accepts a strict `recall.write.v1` proposal and returns the admission result.
The LLM never writes raw graph rows.

## Ambient push and the dig backstop

Under the Claude Code integration (`recall claude sync`), the agent does not have
to remember to read. Before each prompt, a hook pushes a mini index of the cells
relevant to that prompt (ids, titles, and a count of the tripwires on the topic),
so memory is ambient rather than something the agent must think to consult. The
index is deliberately incomplete, which keeps the agent running a real
`recall compile` for anything load-bearing instead of treating the index as the
answer.

The push marks a row `[SUPERSEDED?]` or `[STALE]` only when that row is itself
the superseded or stale cell, escalating to `DIG REQUIRED` only then. When that
fires, a Stop hook backstops it: the turn cannot end until the transcript shows
the agent actually read the flagged cell. The push, the dig, and the firewalled
write together are the closed loop, and the backstop is the one structural point
that keeps the dig from being optional. See
[`17_ENFORCING_USAGE.md`](17_ENFORCING_USAGE.md).

## User Role

The user inspects, corrects, rolls back, reviews, or explicitly commands the
system through CLI/TUI.

The user should not have to become the memory clerk.

## Exception: Secrets

Secrets are never automatic. They require explicit user-directed save:

```bash
recall secrets save --confirm-secret-save --password-stdin --value-stdin
```

