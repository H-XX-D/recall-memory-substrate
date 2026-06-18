# How to benchmark Recall against your own graph

The benchmark harnesses in `python/scripts/` (`recall_bench.py` and
`vector_rag_bench.py`) measure response cost and answer relevance across
two retrieval strategies on the same underlying graph:

- **Naive retrieval**: `recall search` returns full cell bodies (the cost
  profile of a typical vector-RAG system returning top-k chunks)
- **Operator-style retrieval**: dispatched via the meta-router to
  `peek`, `peek-match`, `diff`, `health-peek`, or `compile` based on
  query shape

A real vector RAG comparison (`vector_rag_bench.py`) additionally embeds
all cells using `sentence-transformers/all-mpnet-base-v2` and retrieves
top-k by cosine similarity.

## Why no reference results are committed

The benchmark output is necessarily specific to the graph state at the
time of the run: which cells exist, which entity tags, which relations,
which contradictions, which superseded chains. We do not commit
snapshot reports because they would be:

- Specific to the maintainer's private graph (we don't ship private content)
- Stale within hours of any meaningful work
- Misleading as a representation of what *your* benchmark would produce

Run the benchmark against your own graph to see your real numbers.

## Setup

```bash
# Core benchmark (operator-vs-naive), stdlib only:
python3 python/scripts/recall_bench.py --out my-bench.md

# Vector RAG comparison, install dependencies:
pip install sentence-transformers numpy
python3 python/scripts/recall_bench.py --format json --out router.json
python3 python/scripts/vector_rag_bench.py --compare-router router.json --out vs-rag.md
```

First vector_rag_bench run downloads the mpnet model (~80 MB) and embeds
all cells in your graph (~1-30 s depending on cell count). Subsequent
runs use cached embeddings.

## Customizing the scenarios

Default scenarios (in `SCENARIOS` arrays in both benchmark scripts) use
generic queries that work against any graph but don't necessarily
exercise YOUR graph well. For meaningful results, edit `SCENARIOS` to
use queries specific to your project:

```python
SCENARIOS: list[BenchmarkQuery] = [
    BenchmarkQuery(
        name="my_known_cell_lookup",
        description="Find the cell about X",
        query_text="exact words that should match cell X",
        expected_substring="known substring in cell X body",
        operator_pattern="compile",
    ),
    # ... add scenarios for your typical query patterns
]
```

The `expected_substring` field is a cheap relevance proxy. Set it to a
string you know exists in a target cell's body; the benchmark counts
how often the retrieved content contains that substring. For
production-grade benchmarking, replace this with an LLM-judge evaluation
(out of scope for the v1 harness).

## What the results mean

| Metric | Interpretation |
|---|---|
| **Bytes returned per query** | Proxy for LLM input tokens (~4 chars / token): direct cost driver |
| **Total bytes** | Cumulative cost across the scenario suite |
| **Reduction ratio** | Naive / operator: higher = more efficient |
| **Relevance hits** | How often each strategy retrieved content containing the expected substring |
| **Latency** | Retrieval time (excludes LLM processing time, which depends on result size) |

A typical reference run on a real project graph might show:
- 5-50× byte reduction for operator-style over naive lexical retrieval
- 3-15× byte reduction for operator-style over real vector RAG (top-5 mpnet)
- Equal or better relevance hit rate (operator side usually wins)
- Higher per-query latency for operator (subprocess overhead) but lower
  agent-level total latency (smaller LLM context to process)

Your numbers will vary substantially based on your graph density, cell
size distribution, query patterns, and what tools the router dispatches
to. The benchmark is most useful as a relative measurement (operator vs
naive, vector-RAG vs operator) rather than as an absolute target.

## Caveats

- **Substring relevance is cheap, not accurate**. Real accuracy
  measurement requires human-graded relevance or LLM judge evaluation.
- **Single-run measurement** characterizes one execution; for production
  benchmarking use 10+ runs to characterize variance.
- **`recall search` is a lexical proxy** for vector RAG cost profile;
  `vector_rag_bench.py` does the real embedding-based comparison.
- **Latency excludes one-time model-load** (~30-50 s on first
  vector-RAG run; cached afterwards).

## Reproducing reference benchmarks

If you want to compare against a published reference number (e.g.,
"9.1× reduction vs vector RAG"), you need to reproduce the original
benchmark conditions:

- Same graph corpus (same cell count, same content)
- Same scenario suite (same queries, same expected substrings)
- Same embedding model (`all-mpnet-base-v2` for the published number)
- Same retrieval parameters (top-5, cosine similarity)

Published numbers are useful for orientation but not directly
comparable to your numbers unless you reproduce the conditions. Run the
benchmark against your own graph to get numbers that mean something for
your use case.
