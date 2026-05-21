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

## User Role

The user inspects, corrects, rolls back, reviews, or explicitly commands the
system through CLI/TUI.

The user should not have to become the memory clerk.

## Exception: Secrets

Secrets are never automatic. They require explicit user-directed save:

```bash
recall secrets save --confirm-secret-save --password-stdin --value-stdin
```

