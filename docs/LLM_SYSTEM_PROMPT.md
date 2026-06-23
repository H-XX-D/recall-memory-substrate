# Recall LLM System Prompt

Use this as a system prompt, developer instruction, project memory entry, or
agent rules file for any LLM that should use Recall.

## Pasteable Instruction

```text
You have access to Recall, a local-first active memory substrate for LLM agents.
Treat Recall as the durable memory layer for this project, not as passive notes.

At the start of a meaningful task:
1. Call recall_compile with the user's task and a 700-1200 word budget.
2. Treat the returned context packet as memory evidence, not unquestionable
   truth. Heed its trust signals: per-cell eff values (live effective
   confidence: a challenged or discounted cell warrants inspection before
   reliance), the conflicts section (contested claims arrive flagged), and
   standing_programs (gates covering cells, tie new evidence into the
   listed bundles).
3. If context is missing, expand with recall_semantic, recall_search, or
   recall_subgraph.

During work:
1. Use retrieved memory to preserve cross-session continuity.
2. Prefer source-grounded facts over vibes.
3. Notice contradictions, stale memory, weak evidence, unresolved tasks, and
   risks.
4. Keep Recall operation quiet unless the user asks to inspect memory state.

When writing memory:
1. Write only durable, future-relevant memory.
2. Submit all memory through recall_write using schema_version
   "recall.write.v1".
3. One proposal equals one addressable graph cell.
4. Include actor, intent, content, scope, tags, evidence, confidence,
   provenance, and policy.
5. Use category/type/subject/project/idea/timestamp tags when known.
6. Always include topics, entities, rings, lifecycle, and quality tags.
7. Use source_refs and evidence links. Put existing cell ids in supports,
   contradicts, concerns, or depends_on when relevant.
8. Match confidence to evidence. Use lower confidence and higher uncertainty
   for inferred or weak claims.
9. If recall_write rejects a proposal, do not claim memory was saved. Fix the
   issues or ask for explicit review.

Do not write:
1. Secrets, API keys, tokens, passwords, private keys, recovery codes, 2FA
   setup secrets, or session cookies.
2. Raw chat filler or temporary conversation noise.
3. Duplicate memory unless it supersedes, contradicts, or materially updates an
   existing cell.
4. Unsupported high-confidence claims.

For contradictions:
1. Do not silently overwrite older memory.
2. Search for the older cell.
3. Write a new witness or belief_update.
4. Link the older cell id in contradicts or concerns.
5. Use rollback only for bad writes, not ordinary belief changes.

For secrets:
1. Never save secrets with recall_write.
2. Save secrets only if the user explicitly asks, using the encrypted Secrets
   side graph and explicit confirmation.

At the end of substantial work:
1. Write source-grounded decisions, observations, risks, open tasks, witnesses,
   or eval results that should survive into the next session.
2. Keep each memory cell focused on one durable claim.
3. Prefer compact summaries that will compile well into future context packets.
```

## Running under the Claude Code hook

If you installed the integration with `recall claude sync`, three hooks already
enforce most of the above, so the agent does not rely on prompt discipline alone:

- **SessionStart** injects this directive plus a short summary of recent graph
  activity.
- **UserPromptSubmit** pushes a mini index of the cells relevant to each prompt
  (ids and titles plus tripwire counts) before the model sees it. Treat the
  index as a map, not the answer: run a real `recall compile` for anything
  load-bearing, and especially when a row is marked `[SUPERSEDED?]`, `[STALE]`,
  or `DIG REQUIRED`.
- **Stop** is the dig backstop: if a row was flagged `DIG REQUIRED` and the turn
  ends without a real Recall read, it blocks the turn until you read the flagged
  cell. The simplest way to never hit it is to compile when the push flags
  something.

See [`17_ENFORCING_USAGE.md`](17_ENFORCING_USAGE.md).

## Where To Put This

Put the pasteable instruction anywhere your LLM or agent framework stores
persistent project instructions:

- desktop app custom instructions
- desktop app memory or project memory file
- workspace memory files
- repo-level `AGENTS.md`
- `CLAUDE.md`, `.cursorrules`, Cursor project rules, Windsurf rules, or similar
- MCP client profile instructions
- local agent runner system prompt
- team onboarding docs for agents that will use Recall

For repo-backed agents, commit the instruction file with the project so future
agent sessions inherit the same memory policy.

## Minimum MCP Setup

Install Recall, initialize a local DB, and generate MCP config:

```bash
npm install -g github:H-XX-D/recall-memory-substrate
recall init
recall mcp config
```

Add the generated MCP block to the LLM desktop app or agent runtime that
supports MCP servers.

## Quick Verification

Ask the LLM:

```text
Use Recall to compile memory for: verify the installation.
Then write one source-grounded observation that Recall is connected.
```

The LLM should call `recall_compile`, perform the check, and then use
`recall_write` with a valid `recall.write.v1` proposal. If it cannot access the
MCP tools, the setup is incomplete.
