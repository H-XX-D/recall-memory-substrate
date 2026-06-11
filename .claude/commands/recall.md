---
description: Wire this session to Recall for the current project. Creates the project memory db if it does not exist, compiles a context packet for what you are about to do, and starts the compile, work, write-back loop.
argument-hint: "[what you are about to work on]"
allowed-tools: Bash(recall:*)
---

## Ensure this project's Recall db exists (idempotent; creates ./.recall/recall.sqlite3 on first run)
!`recall init --db .recall/recall.sqlite3`

## Compiled context for the task
!`recall compile "$ARGUMENTS" --db .recall/recall.sqlite3 --words 600`

## Operate Recall this session
Recall is now wired for this project. The block above is your compiled context packet for "$ARGUMENTS": ranked relevant memory, open risks, open tasks, and any contradictions, fit to a word budget.

Run the loop:
- Read the packet above before starting. Treat it as evidence, not unquestionable truth.
- Pull one cell's full detail with `recall cell <id>` only when its title is not enough.
- Do the work.
- Write durable findings back through the admission firewall: decisions, observations, risks, tasks, verification results. Use the `recall_write` MCP tool, or `recall admit --json <proposal>` from the shell. Every write is schema-checked, provenance-stamped, and rollbackable.
- Do not assert from memory you have not checked in Recall.

One db lives per project in `./.recall/` and is git-ignored by default. The full operating contract is in [docs/LLM_INTEGRATION.md](../../docs/LLM_INTEGRATION.md).
