# Recall for Code — Reference

> Companion to `llm-integration.md`. Documents the code-aware extension
> that makes Recall usable as the epistemic-memory substrate for AI
> coding agents working on large codebases.

This file covers what the v1.2 code extension does, what it doesn't yet do,
how to use it from agents, and the conventions for code-cell writes that
make the graph useful across sessions.

## Supported languages

| Language | Extractor | Parser | Extension files |
|---|---|---|---|
| Python | `recall_code_extract.py` | stdlib `ast` (full AST) | `.py` |
| JavaScript | `recall_code_extract_js.py` | regex-based (best-effort) | `.js`, `.jsx`, `.mjs`, `.cjs` |
| TypeScript | `recall_code_extract_js.py` | regex-based + TS-aware | `.ts`, `.tsx` |

The Python extractor uses real AST parsing and catches everything. The
JS/TS extractor uses regex-based scanning — high fidelity for the common
~80% of code, but misses computed property names, decorators, complex
destructuring, and dynamic declarations. Tree-sitter-backed v2 will close
that gap. For the current v1.2 release, regex is the deps-free trade-off.

## What the extension does

1. **Parses source files** for each language and emits one Recall cell per
   module (file) and one per top-level symbol (function, class, async
   function, const arrow function, TypeScript interface, TypeScript type
   alias, optionally methods).
2. **Writes cells through the standard schema** — same `recall.write.v1`
   write path used everywhere else. Code cells are not a separate cell
   type; they are conventional uses of `kind=artifact` with code-specific
   tag families.
3. **Captures structural metadata** — signature, line range, docstring,
   decorators, imports, references, file path. Body excerpt up to 2 KB.
4. **Stays discoverable via entity tags** — `py-sym:<name>`,
   `py-import:<module>`, `py-ref:<name>`, `code`, `python`, the file stem.
   `recall_subgraph` and `recall_search` find code cells by these tags
   without needing typed relations yet.
5. **Integrates via git hooks** — a `post-commit.sample` hook re-extracts
   changed files on every commit, keeping the graph current.

## What the extension does NOT yet do (v1.2 limits)

- **Go / Rust / Java / other languages.** v1.2 ships Python (AST) and
  JS/TS (regex). Tree-sitter-backed multi-language v2 is the planned
  upgrade for higher-fidelity parsing across more languages.
- **Test → function-under-test links.** Test cells are tagged
  `topics: [test]` and `lifecycle: [test]` but the link to the function
  they cover is heuristic-only (test_foo → foo) and not yet a typed edge.
- **Build / CI results.** No cells written by CI yet. Linking test
  results to symbol cells is straightforward additional integration.
- **Diff-aware compile mode.** A "what changed since session N" query
  is not yet a first-class verb; agents can approximate with
  `recall_search` ordered by `updated_at` for now.
- **JS/TS regex parser limits** (computed property names, decorators on
  classes/methods, complex destructuring, dynamically computed symbols).
  Tree-sitter would close these.

## What's new in v1.1

- **Typed relations via `recall_code_link.py`.** A linker pass walks the
  graph for a project, resolves entity-tag-based references against
  symbol definitions, and creates typed **hyperedges** between cells
  (`code-defined-in`, `code-references`, `code-imports`, `code-method-of`).
  Supports `--apply`, `--skip-existing` (idempotence), `--kinds` filter,
  `--out` for JSONL report mode without writes.
- **Idempotent re-extraction via `--rebuild`.** Re-running the extractor
  with `--rebuild --admit` creates new cells AND creates
  `code-superseded-by` hyperedges from each old cell (same `scope.path`)
  to its new counterpart (matched by title). Old cells are preserved in
  the graph (preservation discipline; audit trail) but downstream queries
  can filter on supersedure edges to find the active cells. Symbols
  removed from source between extractions get a fallback supersede edge
  to the new module cell.

## What's new in v1.2

- **JavaScript & TypeScript extractor** (`recall_code_extract_js.py`).
  Regex-based scanner; zero new dependencies. Handles `function`, `class`,
  `const fn = () =>`, ES `import`, CommonJS `require`, TypeScript
  `interface`, TypeScript `type` alias. Emits the same proposal shape as
  the Python extractor so the linker and `--rebuild` flow work without
  changes. Tags topics with `javascript` or `typescript` for filterability.
- **Polyglot linker.** `recall_code_link.py` now auto-recognizes entity
  prefixes for all known languages (`py-`, `js-`, `ts-`). One linker
  invocation per project handles polyglot codebases correctly, including
  cross-language references (e.g., a Python script that calls into a JS
  build tool can be linked if entities resolve).

## What's new in v1.4 (this round)

- **CI test ingestion (`recall_ci_ingest.py`).** Parses test reports
  (pytest JSON, JUnit XML, simple line format) and creates Recall cells
  per test result. Passing tests get `kind=verification_result`, failing
  tests get `kind=risk`, skipped get `kind=observation`. Each test result
  is linked to its function-under-test cell via typed hyperedges:
  `test-supports` for passes, `test-contradicts` for failures. Skipped
  tests get cells only (no edge — they're informational, not contradictory).
- **Function-under-test resolution** strips `test_` prefix and tries both
  the bare name and the underscore-prefixed variant (`test_foo` matches
  both `foo` and `_foo` — handles the common Python pattern of testing
  private helpers by their bare name).
- **Pipeline-ready**: `--run-id` for CI run identifiers (commit SHA,
  build number), `--stats-only` for pre-commit previews, `--no-edges` for
  cell-only ingestion when you want to defer linking.

## What's new in v1.3

- **Diff-aware compile (`recall_diff.py`).** General Recall tool (not
  code-specific, but especially useful for code work). Queries cells +
  hyperedges since a threshold timestamp or since-cell and returns
  new/updated cells plus new hyperedges. Surfaces supersede events
  separately. Accepts ISO-8601 or relative shorthand (`2h`, `7d`, `4w`).
  Two output modes: JSON for tooling, `--summary` markdown for direct
  agent consumption.

  Closes the "what changed since session N" gap noted as a v1.2 limit.
  Agent integration pattern 6 below shows the resume-session use case.

## Cell-shape conventions

### Module cell

```yaml
kind: artifact
title: "module: <relative/path/to/file.py>"
body: |
  # Module: <path>
  Line count: <n>
  ## Module docstring
  <...>
  ## Imports
  - <import1>
  - <import2>
  ## Top-level symbols
  - <sym1>
  - <sym2>
tags:
  topics: [code, python, module]            # + [test-module] if applicable
  category: [code]
  lifecycle: [active, code]                 # + [test] if test module
  entities: [<repo>, <file-stem>, py-import:..., py-sym:...]
scope:
  project: <project-name>
  path: <relative/path/to/file.py>
confidence: {value: 0.9, source_quality: high, stability: volatile}
```

### Symbol cell (function / class / method)

```yaml
kind: artifact
title: "<kind>: <file>::<name>"           # kind ∈ function|class|async-function|method
body: |
  # <kind>: <name>
  **File:** `<path>`
  **Lines:** <start>–<end>
  **Signature:** `def name(...) -> ...`
  **Parent class:** `<class>`              # if method
  **Decorators:** `@dec1, @dec2`
  ## Docstring
  <...>
  ## References (calls / attribute roots)
  - <name1>
  - <name2>
  ## Source excerpt
  ```python
  <up to 2 KB of source>
  ```
tags:
  topics: [code, python, <kind>]            # + [test] if test function, + [method] if method
  category: [code]
  lifecycle: [active, code]                 # + [test] if test
  entities: [<repo>, <file-stem>, py-sym:<name>, py-ref:<called1>, ...]
scope:
  project: <project-name>
  path: <relative/path/to/file.py>
confidence: {value: 0.9, source_quality: high, stability: volatile}
```

### Architectural-decision cell (human/agent writes, not auto-extracted)

Use existing `kind=decision` with code-aware tags:

```yaml
kind: decision
title: "decision: <short title>"
body: |
  Context, options considered, decision made, rationale, consequences.
  Per ADR (architecture decision record) conventions where possible.
tags:
  topics: [code, architecture, <area>]
  category: [code, architecture]
  lifecycle: [active]
  entities: [<repo>, <relevant-modules>, <relevant-symbols>]
scope:
  project: <project-name>
confidence: {value: 0.85, source_quality: high, stability: stable}
evidence:
  depends_on: [<related architectural decision cells>]
  contradicts: [<superseded decision cells>]
  source_refs: ["spec/architecture.md#section-3", "<commit-sha>"]
```

### Bug-pattern cell (post-mortem)

Use `kind=risk` for ongoing risk or `kind=lemma` for resolved root-cause:

```yaml
kind: risk                                  # or lemma if fully understood
title: "bug-pattern: <short symptom>"
body: |
  ## Symptom
  ## Root cause
  ## Fix applied
  ## Prevention
tags:
  topics: [code, bug-pattern, <module>]
  category: [code, debug]
  lifecycle: [active, learned]
  entities: [<repo>, <affected-symbols>, <fix-commit-sha>]
confidence: {value: 0.8, stability: stable}
evidence:
  source_refs: ["<commit-fixing-it>", "<file:line>"]
  depends_on: [<symbol cells affected>]
```

## CLI usage

### Extract proposals to stdout (JSONL)

```bash
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ \
  --project my-repo
```

One JSON object per line, ready for `jq` filtering or piping.

### Extract and admit directly

```bash
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ \
  --project my-repo \
  --admit
```

Each proposal is validated and admitted via the standard CLI write path.
Summary stats go to stderr; admit failures are logged with file context.

### Stats only (no writes)

```bash
python3 ~/.claude/skills/recall/scripts/recall_code_extract.py \
  --path src/ \
  --project my-repo \
  --stats-only
```

Tells you cell count before committing to the writes.

### Useful flags

- `--include-private` — also extract symbols starting with `_`
- `--methods-as-cells` — emit a cell per class method, not just class cells
- `--exclude-tests` — skip files matching test path patterns
- `--limit N` — cap on number of proposals emitted (debugging aid)
- `--repo-label LABEL` — entity tag for cross-cell repo grouping (defaults to `--project`)
- `--rebuild` — idempotent re-extraction. Requires `--admit`. After admitting
  new cells, queries existing cells with the same `scope.path` and creates
  `code-superseded-by` hyperedges (old → new, matched by title). Old cells
  stay in graph; new cells are active.

### Linker (typed relations)

After `--admit`-ing code cells, run the linker to materialize typed edges:

```bash
# Discovery only (JSONL report to stdout, no writes):
python3 ~/.claude/skills/recall/scripts/recall_code_link.py \
  --project my-repo

# Apply (create hyperedges):
python3 ~/.claude/skills/recall/scripts/recall_code_link.py \
  --project my-repo --apply

# Idempotent re-apply (skip edges already in graph):
python3 ~/.claude/skills/recall/scripts/recall_code_link.py \
  --project my-repo --apply --skip-existing

# Filter to specific edge kinds:
python3 ~/.claude/skills/recall/scripts/recall_code_link.py \
  --project my-repo --apply --kinds code-references,code-imports
```

Edge kinds created:

| Kind | Source role | Target role | Resolution |
|---|---|---|---|
| `code-defined-in` | `symbol` | `module` | same `scope.path` |
| `code-references` | `referrer` | `referent` | `py-ref:X` → cell with `py-sym:X` (non-module cells only) |
| `code-imports` | `importer` | `imported` | `py-import:foo.bar.X` → module cell with file stem `X` |
| `code-method-of` | `method` | `class` | method cell's `py-sym:<class>` → class cell with `class` topic |

Inspect edges with `recall hyperedge list --limit 50` (default 20).

## Agent integration patterns

### Pattern 1: "tell me about this function"

```text
1. recall_search "py-sym:validate_user"     # or recall_subgraph by entity tag
2. recall_cell <id> on the most-recent function-kind hit
3. Read signature, docstring, body excerpt, references
```

The agent now has the function's current state without grepping the
repo, plus any architectural-decision cells or bug-pattern cells tagged
with the same symbol.

### Pattern 2: "what depends on this module?"

```text
1. recall_subgraph --entities py-import:my_module
2. The hits are all modules that import my_module
3. Walk each hit's symbols to find specific use sites
```

(In v2 with typed relations, this becomes a single `depends_on` traversal.)

### Pattern 3: "what's been decided about this area?"

```text
1. recall_search "decision: <area>"           # only decision-kind cells
2. recall_compile "<area> architecture"       # broader epistemic state
3. Walk decision cells' contradicts links to find superseded decisions
```

The agent picks up the architectural reasoning, not just the code.

### Pattern 4: "what bugs have we hit in this code?"

```text
1. recall_search "bug-pattern <module>"
2. Filter by lifecycle: [learned] for resolved patterns
3. Read root-cause + fix from each
```

Future bug-fix work starts with the institutional memory, not blank.

### Pattern 5: "I'm starting work on feature X, what's the state?"

```text
1. recall_compile "feature X current state"
2. Returns: relevant cells (decisions, bugs, in-flight WIP), graph
   health (open contradictions in the area), suggested next actions
3. Agent reads the compile packet, decides which cells to deepen on
```

This is the long-horizon agent pattern that current code tools can't do.

### Pattern 6: "I was away — what changed while I was gone?"

```text
1. recall_diff.py --project my-repo --since 1d --summary    (or 2h, 7d, etc.)
2. Returns: new cells (with kinds + lifecycle), updated cells,
   new hyperedges (by kind), and supersede events surfaced separately
3. Agent reads the summary, decides which new cells deserve deepening
4. For a specific resume point: --since-cell <last-cell-id-I-wrote> uses
   that cell's createdAt as the threshold
```

Cheaper than re-reading the full graph; sharper than chronological
log-tailing; structured enough that the agent can decide what to fetch
in full vs. trust the summary for. The supersede-events section is
especially useful — it surfaces "code that was replaced" so the agent
doesn't re-derive things based on now-stale cells.

## Git hook installation

```bash
cp ~/.claude/skills/recall/scripts/git-hooks/post-commit.sample \
   .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

The hook auto-extracts cells from changed `.py` files on every commit.
Set `RECALL_PROJECT=<name>` in your shell to override the auto-detected
project label.

The hook is synchronous by default (~10-100ms per file). For large
commits, wrap the python3 call in `(... &)` to make it background.

## Storage expectations

From measured per-cell footprint (~21 KB amortized, including
rollback journal + write proposal + indexes):

| Codebase size | Estimated DB growth |
|---|---|
| Small (10 files, 50 symbols) | ~1 MB |
| Medium (100 files, 500 symbols) | ~12 MB |
| Large (1,000 files, 5,000 symbols) | ~120 MB |
| Very large (10,000 files, 50,000 symbols) | ~1.2 GB |

For most projects this is fine. For monorepo-scale, plan for either
selective extraction (only key modules) or aggressive compaction.

The semantic-index component grows with cell count; for large codebases
the index can be the largest single table. `recall_compact` periodically
is recommended.

## Roadmap (what's coming after v1.2)

| Feature | Why | Priority | Status |
|---|---|---|---|
| `recall_code_link.py` linker for typed relations | Replaces entity-tag-only links with hyperedge dependencies | High | **shipped v1.1** |
| `--rebuild` flag for idempotent re-extraction | Avoids duplicate-cell accumulation on re-runs | High | **shipped v1.1** |
| JS/TS regex-based extractor + polyglot linker | Multi-language support (most-asked-for) | High | **shipped v1.2** |
| Diff-aware compile (`recall_diff.py`) | "What changed since session N" as a first-class query | Medium | **shipped v1.3** |
| CI test ingestion (`recall_ci_ingest.py`) | Tests as `supports`/`contradicts` hyperedges to symbol cells; pytest JSON + JUnit XML + simple | Medium-High | **shipped v1.4** |
| Tree-sitter-based extractors (Python, JS, TS, Go, Rust) | Higher-fidelity parsing for JS/TS; expand language coverage | High | open |
| Supersede-aware resolution in linker + CI ingest | Skip cells with outgoing `code-superseded-by` when resolving; avoids double-edges to old+new versions of the same symbol | Medium | open |
| CI integration for test → code links | Build/test results as `supports`/`contradicts` edges | Medium | open |
| Cross-file symbol resolution in linker | Current `code-imports` matches by file-stem heuristic; full module-path resolution would tighten resolution accuracy | Medium | open |
| Method-level extraction always-on (with sensible defaults) | Currently opt-in via `--methods-as-cells` | Low | open |
| Branch-aware writes | Feature branches don't pollute main's epistemic state until merge | Medium | open |
| Web UI for graph browsing | Visualize architectural decisions + supersedure chains | Low (v0.x) | open |
| Auto-compaction of superseded chains | Periodic background pass that archives old superseded cells beyond N generations | Medium | open |

## Comparison to other code-context tools

| Tool | What it does | What Recall code adds |
|---|---|---|
| Cursor `@context` | Manual scope per turn, ephemeral | Persistent, structured, multi-session |
| Sourcegraph Cody | RAG over codebase, code search | Reasons over decisions, not just current code |
| Aider repomap | Compact code summary in context | Adds decisions, contradictions, bug patterns, history |
| GitHub Copilot Workspace | Project-aware, session-bound | Cross-session memory of decisions and superseded approaches |
| LangGraph / AutoGen state | Workflow state | Epistemic state for the codebase, not just for the workflow |
| `CLAUDE.md` / `.cursorrules` | User-curated text rules | Structured graph; auto-extracted from code; queryable |

None of the above have typed contradictions, calibrated confidence,
supersedure-preserved history, or curated compile. Recall for Code adds
the epistemic-discipline layer to whatever existing code-context tools
you already use — it complements rather than replaces.

## Dogfood test (this session)

The extension was validated by running it on `recall_helper.py` itself
(the helper module that constructs proposals): 12 cells admitted
(1 module + 11 functions), all queryable via `recall_search`, with
appropriate entity tags for downstream subgraph composition. See Recall
cells under `project=recall-helper-self-test`.
