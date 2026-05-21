# Recall Agent Instructions

Recall is a clean repo for an active AI memory substrate. Keep it small,
auditable, and schema-first.

## Prime Directive

Do not treat memory as chat history. Recall stores structured evidence,
beliefs, tasks, risks, decisions, contradictions, programs, and provenance
outside the LLM context window. The LLM receives only compiled, task-specific
context packets.

## Development Rules

- All graph writes from an LLM must go through the strict write schema and
  admission/firewall path.
- Prefer structured records over prose blobs.
- Every durable write needs scope, provenance, tags, confidence, uncertainty,
  source quality, and rollback metadata.
- Keep the invisible daemon quiet by default. Users should inspect state through
  CLI or TUI when they want details.
- Daemon work must run outside the LLM and write observations through the same
  admission path.
- MCP surfaces must expose existing Recall operations; do not create a second
  memory API.
- Semantic search and subgraph creation must use the same graph records and
  multi-identity tags.
- Hyperedge programs are allowed only through a declared, versioned, sandboxed
  program interface.
- Do not store secrets in the primary graph. Redact or reject secret-looking
  content there.
- Secrets may be stored only in the encrypted Secrets side graph, only through an
  explicit `recall secrets save --confirm-secret-save` command.

## LLM Operating Instructions

- Use MCP for routine agent operation and CLI/TUI for inspection or explicit
  human actions.
- Start with `recall_compile` for task-specific context, then expand with
  `recall_search`, `recall_semantic`, or `recall_subgraph` only as needed.
- Submit durable observations, decisions, risks, tasks, and witnesses through
  `recall_write`.
- Include category/type/subject/project/idea/timestamp tags when they are known;
  sparse tags are allowed when speed matters.
- Treat context packets as evidence, not unquestionable truth.
- Use rollback rather than overwriting when a write was wrong.
- See `docs/LLM_INTEGRATION.md` for the full adapter contract.

## Ring Model

- Foundation: schema, graph semantics, evidence calculus, context compiler.
- Runtime: daemon, write firewall, scheduler, rollback, eval harness.
- Adapter: CLI, TUI, MCP, LLM bridges, importers, external graph adapters.
