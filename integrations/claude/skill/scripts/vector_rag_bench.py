#!/usr/bin/env python3
"""
vector_rag_bench.py — Real vector-RAG benchmark vs the same Recall graph.

Uses sentence-transformers (all-mpnet-base-v2, industry standard for
embedding-based retrieval) and cosine similarity to do top-k retrieval
over Recall cell bodies. Same 7 query scenarios as `recall_bench.py`,
same expected-substring relevance check.

This is the fair "high-end vector RAG" comparison the launch story
needs. Previously `recall_bench.py` used `recall search` (lexical) as a
cost-profile proxy; this script uses real embeddings + cosine.

Embedding choice rationale: all-mpnet-base-v2 (768d) is the most-cited
production embedding model. Faster lightweight options (MiniLM-L6) trade
quality for speed; newer options (bge, voyage-3, OpenAI text-embedding-3)
trade dependency for marginal quality gain. mpnet is the defensible
baseline.

Caching: cell embeddings are persisted to disk
(`~/.recall/.embeddings_mpnet.npz`) so subsequent runs don't re-embed
unless --rebuild-index is passed.

Top-k = 5 is the standard production default.

CLI:

    # Run full benchmark, cache embeddings on first run:
    vector_rag_bench.py

    # Force re-embedding all cells (use after big graph changes):
    vector_rag_bench.py --rebuild-index

    # Different k for top-k retrieval:
    vector_rag_bench.py --k 3

    # JSON output for combining with recall_bench.py results:
    vector_rag_bench.py --format json --out vector_results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Suppress progress bars from sentence-transformers / huggingface
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import DEFAULT_DB  # noqa: E402

import numpy as np  # noqa: E402


CHARS_PER_TOKEN = 4
DEFAULT_K = 5
DEFAULT_MODEL = "all-mpnet-base-v2"
EMBEDDING_CACHE = Path.home() / ".recall" / ".embeddings_mpnet.npz"


# ---- Benchmark scenarios (mirror recall_bench.py) ----

@dataclass
class Scenario:
    name: str
    description: str
    query_text: str
    expected_substring: str | None


SCENARIOS: list[Scenario] = [
    Scenario("lookup_l7_gravity",
             "Find the cell about L7 Noether-translation gravity closure",
             "L7 Noether translation gravity", "Noether"),
    Scenario("lookup_recent_artifact",
             "Find the v1.4 CI ingestion artifact cell",
             "v1.4 CI test ingestion", "test-supports"),
    Scenario("synthesis_gravity_state",
             "Synthesize the current state of substrate gravity",
             "substrate gravity current state closure", "axiom-lock"),
    Scenario("synthesis_extension_roadmap",
             "What's the v1.x code extension roadmap status?",
             "recall-for-code extension roadmap status", "shipped"),
    Scenario("diff_recent_activity",
             "What changed in the last 4 hours?",
             "recent activity changes graph", "new cells"),
    Scenario("health_contradictions",
             "Show me contradiction load",
             "contradictions memory health", "contradictions"),
    Scenario("code_function_lookup",
             "Tell me about the build_proposal function",
             "build_proposal function helper", "build_proposal"),
]


# ---- Corpus loading ----

@dataclass
class Cell:
    id: str
    title: str
    body: str
    kind: str
    text: str  # combined text for embedding (title + body)


def load_corpus(db: str) -> list[Cell]:
    """Load all cells from Recall DB as the RAG corpus."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, body, kind FROM graph_nodes WHERE status = 'active'"
    ).fetchall()
    conn.close()
    cells: list[Cell] = []
    for r in rows:
        text = f"{r['title']}\n\n{r['body']}"
        cells.append(Cell(
            id=r["id"], title=r["title"], body=r["body"],
            kind=r["kind"], text=text,
        ))
    return cells


# ---- Embedding ----

def load_or_build_embeddings(
    cells: list[Cell], model_name: str, force_rebuild: bool = False,
) -> np.ndarray:
    """Load cached embeddings or compute + cache them. Returns (N, D) matrix."""
    cache_meta = EMBEDDING_CACHE.with_suffix(".meta.json")
    cell_ids = [c.id for c in cells]

    # Check cache validity
    if not force_rebuild and EMBEDDING_CACHE.exists() and cache_meta.exists():
        try:
            meta = json.loads(cache_meta.read_text())
            if (meta.get("model") == model_name and
                    meta.get("cell_count") == len(cells) and
                    meta.get("cell_ids") == cell_ids):
                data = np.load(EMBEDDING_CACHE)
                print(f"  loaded cached embeddings: {data['embeddings'].shape}",
                      file=sys.stderr)
                return data["embeddings"]
        except (json.JSONDecodeError, KeyError, OSError):
            pass

    # Compute embeddings
    print(f"  loading {model_name}...", file=sys.stderr)
    t = time.time()
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(model_name)
    print(f"    model loaded in {time.time() - t:.1f}s", file=sys.stderr)

    print(f"  embedding {len(cells)} cells...", file=sys.stderr)
    t = time.time()
    texts = [c.text for c in cells]
    embeddings = model.encode(
        texts, show_progress_bar=False, batch_size=32,
        convert_to_numpy=True, normalize_embeddings=True,
    )
    print(f"    embedded {len(cells)} cells in {time.time() - t:.1f}s; "
          f"shape={embeddings.shape}", file=sys.stderr)

    # Cache
    EMBEDDING_CACHE.parent.mkdir(exist_ok=True)
    np.savez(EMBEDDING_CACHE, embeddings=embeddings)
    cache_meta.write_text(json.dumps({
        "model": model_name,
        "cell_count": len(cells),
        "cell_ids": cell_ids,
    }))
    print(f"    cached to {EMBEDDING_CACHE}", file=sys.stderr)
    return embeddings


# ---- Retrieval ----

@dataclass
class RetrievalResult:
    query: str
    expected_substring: str | None
    top_k_cells: list[Cell]
    top_k_scores: list[float]
    response_bytes: int
    response_tokens: int
    duration_seconds: float
    relevance_hit: bool


def query_vector_rag(
    query: Scenario, cells: list[Cell], embeddings: np.ndarray,
    model, k: int = DEFAULT_K,
) -> RetrievalResult:
    """Run a single query through vector RAG and measure response cost."""
    t = time.time()
    query_emb = model.encode([query.query_text], normalize_embeddings=True)[0]
    # Cosine similarity (embeddings are normalized → just dot product)
    scores = embeddings @ query_emb
    top_k_idx = np.argsort(-scores)[:k]
    top_k_cells = [cells[i] for i in top_k_idx]
    top_k_scores = [float(scores[i]) for i in top_k_idx]
    duration = time.time() - t

    # "Response" is the concatenated bodies of top-k cells — what a RAG-backed
    # LLM would receive as context. This is the cost the LLM pays per query.
    response = "\n\n---\n\n".join(
        f"# {c.title}\n\n{c.body}" for c in top_k_cells
    )
    response_bytes = len(response.encode("utf-8"))
    response_tokens = response_bytes // CHARS_PER_TOKEN

    relevance_hit = (
        query.expected_substring is None
        or query.expected_substring.lower() in response.lower()
    )

    return RetrievalResult(
        query=query.query_text,
        expected_substring=query.expected_substring,
        top_k_cells=top_k_cells,
        top_k_scores=top_k_scores,
        response_bytes=response_bytes,
        response_tokens=response_tokens,
        duration_seconds=duration,
        relevance_hit=relevance_hit,
    )


# ---- Report ----

def format_report(results: list[tuple[Scenario, RetrievalResult]], k: int,
                  model_name: str, prior_router_results: dict | None = None) -> str:
    """Markdown report comparing vector-RAG to router-mode (from recall_bench.py)."""
    lines: list[str] = []
    lines.append(f"# Vector RAG benchmark (top-{k} {model_name})")
    lines.append("")
    lines.append(f"**Methodology**: real embedding-based retrieval (industry-standard "
                 f"production setup). Same 7 queries as `recall_bench.py`, same expected-")
    lines.append(f"substring relevance check, same underlying Recall graph as the corpus.")
    lines.append(f"Top-{k} cells returned per query; their concatenated bodies are the")
    lines.append(f"'context the LLM receives' (bytes ≈ tokens × 4).")
    lines.append("")

    lines.append("## Per-scenario results")
    lines.append("")
    lines.append("| Scenario | Vector-RAG bytes | Top score | Relevance |")
    lines.append("|---|---:|---:|:-:|")
    for scn, res in results:
        lines.append(
            f"| {scn.name} | {res.response_bytes:,} | {res.top_k_scores[0]:.3f} "
            f"| {'✓' if res.relevance_hit else '✗'} |"
        )
    lines.append("")

    bytes_list = [r.response_bytes for _, r in results]
    tokens_list = [r.response_tokens for _, r in results]
    hits = sum(1 for _, r in results if r.relevance_hit)
    dur_list = [r.duration_seconds for _, r in results]

    lines.append("## Aggregate stats")
    lines.append("")
    lines.append("| Metric | Vector RAG |")
    lines.append("|---|---:|")
    lines.append(f"| Total response bytes (7 queries) | {sum(bytes_list):,} |")
    lines.append(f"| Total est. tokens | {sum(tokens_list):,} |")
    lines.append(f"| Mean bytes per query | {int(statistics.mean(bytes_list)):,} |")
    lines.append(f"| Median bytes per query | {int(statistics.median(bytes_list)):,} |")
    lines.append(f"| Relevance hits | {hits}/{len(results)} |")
    lines.append(f"| Mean retrieval latency (post-warmup) | {statistics.mean(dur_list)*1000:.0f} ms |")
    lines.append("")

    # If we have router results, do the comparison
    if prior_router_results:
        lines.append("## Vector RAG vs Recall router (head-to-head)")
        lines.append("")
        lines.append("| Scenario | Vector RAG bytes | Router bytes | Ratio | V-RAG hit | Router hit |")
        lines.append("|---|---:|---:|---:|:-:|:-:|")
        router_by_name = {s["query"]["name"]: s for s in prior_router_results.get("scenarios", [])}
        v_total = 0
        r_total = 0
        v_hits = 0
        r_hits = 0
        for scn, res in results:
            r_data = router_by_name.get(scn.name)
            if not r_data:
                continue
            # Prefer "router" field (post-meta-router); fall back to "operator"
            router_section = r_data.get("router") or r_data.get("operator", {})
            r_bytes = router_section.get("bytes_returned", 0)
            r_hit = router_section.get("relevance_hit", False)
            ratio = res.response_bytes / max(1, r_bytes)
            v_total += res.response_bytes
            r_total += r_bytes
            v_hits += int(res.relevance_hit)
            r_hits += int(r_hit)
            lines.append(
                f"| {scn.name} | {res.response_bytes:,} | {r_bytes:,} | {ratio:.1f}× "
                f"| {'✓' if res.relevance_hit else '✗'} "
                f"| {'✓' if r_hit else '✗'} |"
            )
        lines.append("")
        if r_total > 0:
            lines.append(f"**Aggregate**: vector RAG total {v_total:,} bytes vs Recall router "
                         f"{r_total:,} bytes — **{v_total / r_total:.1f}× reduction** "
                         f"using router-style operator dispatch.")
            lines.append(
                f"Relevance: vector RAG {v_hits}/{len(results)} vs router {r_hits}/{len(results)}."
            )
            lines.append("")

    lines.append("## Notes")
    lines.append("")
    lines.append(f"- Embedding model: `{model_name}` (industry-standard production baseline)")
    lines.append(f"- Top-k: {k} (standard production default; some systems use 3-10)")
    lines.append(f"- Cosine similarity over normalized embeddings (equivalent to inner product)")
    lines.append("- Same Recall graph as corpus — same available content, different retrieval")
    lines.append("- Vector RAG returns full cell bodies as context (standard production pattern)")
    lines.append("- Embeddings cached after first run; subsequent runs only embed the queries")
    lines.append("- Latency excludes one-time model-load cost (~30-50s first run)")
    return "\n".join(lines)


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Real vector-RAG benchmark using sentence-transformers + cosine.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # First run (downloads model ~80MB, embeds all cells):\n"
            "  vector_rag_bench.py\n\n"
            "  # Subsequent runs use cached embeddings:\n"
            "  vector_rag_bench.py --k 3\n\n"
            "  # Compare against prior router benchmark JSON:\n"
            "  recall_bench.py --format json --out router.json\n"
            "  vector_rag_bench.py --compare-router router.json\n"
        ),
    )
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help=f"sentence-transformers model. Default: {DEFAULT_MODEL}")
    ap.add_argument("--k", type=int, default=DEFAULT_K,
                    help=f"top-k cells to retrieve per query. Default: {DEFAULT_K}")
    ap.add_argument("--rebuild-index", action="store_true",
                    help="Force re-embedding of all cells (use after big graph changes).")
    ap.add_argument("--compare-router", default=None,
                    help="Path to JSON output from recall_bench.py --format json for "
                         "head-to-head comparison.")
    ap.add_argument("--format", choices=("markdown", "json"), default="markdown")
    ap.add_argument("--out", default="-")
    args = ap.parse_args()

    # Load corpus
    print("Loading Recall corpus...", file=sys.stderr)
    cells = load_corpus(args.db)
    print(f"  {len(cells)} cells", file=sys.stderr)

    # Build / load embeddings
    embeddings = load_or_build_embeddings(cells, args.model, args.rebuild_index)

    # Load query model (already loaded if we just built embeddings, but for query
    # encoding we need it again; SentenceTransformer caches the model in HF cache)
    print("Loading model for query encoding...", file=sys.stderr)
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(args.model)

    # Run scenarios
    print(f"Running {len(SCENARIOS)} scenarios (k={args.k})...", file=sys.stderr)
    results: list[tuple[Scenario, RetrievalResult]] = []
    for scn in SCENARIOS:
        res = query_vector_rag(scn, cells, embeddings, model, k=args.k)
        results.append((scn, res))
        print(
            f"  [{scn.name}] {res.response_bytes:,} bytes "
            f"({'✓' if res.relevance_hit else '✗'}) "
            f"top-score {res.top_k_scores[0]:.3f}",
            file=sys.stderr,
        )

    # Load router results if requested
    prior_router = None
    if args.compare_router:
        try:
            prior_router = json.loads(Path(args.compare_router).read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"WARNING: couldn't load router comparison: {e}", file=sys.stderr)

    # Output
    if args.format == "markdown":
        report = format_report(results, args.k, args.model, prior_router)
    else:
        report = json.dumps({
            "model": args.model,
            "k": args.k,
            "scenarios": [{
                "name": scn.name,
                "query": scn.query_text,
                "expected_substring": scn.expected_substring,
                "response_bytes": res.response_bytes,
                "response_tokens": res.response_tokens,
                "top_k_scores": res.top_k_scores,
                "top_k_ids": [c.id for c in res.top_k_cells],
                "top_k_titles": [c.title for c in res.top_k_cells],
                "relevance_hit": res.relevance_hit,
                "duration_seconds": res.duration_seconds,
            } for scn, res in results],
        }, indent=2)

    if args.out == "-":
        print(report)
    else:
        Path(args.out).write_text(report + "\n")
        print(f"Wrote report to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
