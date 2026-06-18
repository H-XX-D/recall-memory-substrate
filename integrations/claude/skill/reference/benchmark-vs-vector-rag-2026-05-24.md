# Vector RAG benchmark (top-5 all-mpnet-base-v2)

**Methodology**: real embedding-based retrieval (industry-standard production setup). Same 7 queries as `recall_bench.py`, same expected-
substring relevance check, same underlying Recall graph as the corpus.
Top-5 cells returned per query; their concatenated bodies are the
'context the LLM receives' (bytes ≈ tokens × 4).

## Per-scenario results

| Scenario | Vector-RAG bytes | Top score | Relevance |
|---|---:|---:|:-:|
| lookup_l7_gravity | 24,197 | 0.551 | ✓ |
| lookup_recent_artifact | 10,076 | 0.407 | ✓ |
| synthesis_gravity_state | 7,322 | 0.564 | ✗ |
| synthesis_extension_roadmap | 37,339 | 0.656 | ✓ |
| diff_recent_activity | 45,263 | 0.366 | ✓ |
| health_contradictions | 24,811 | 0.617 | ✓ |
| code_function_lookup | 8,481 | 0.540 | ✓ |

## Aggregate stats

| Metric | Vector RAG |
|---|---:|
| Total response bytes (7 queries) | 157,489 |
| Total est. tokens | 39,369 |
| Mean bytes per query | 22,498 |
| Median bytes per query | 24,197 |
| Relevance hits | 6/7 |
| Mean retrieval latency (post-warmup) | 80 ms |

## Vector RAG vs Recall router (head-to-head)

| Scenario | Vector RAG bytes | Router bytes | Ratio | V-RAG hit | Router hit |
|---|---:|---:|---:|:-:|:-:|
| lookup_l7_gravity | 24,197 | 2,109 | 11.5× | ✓ | ✓ |
| lookup_recent_artifact | 10,076 | 1,692 | 6.0× | ✓ | ✓ |
| synthesis_gravity_state | 7,322 | 3,410 | 2.1× | ✗ | ✗ |
| synthesis_extension_roadmap | 37,339 | 2,073 | 18.0× | ✓ | ✓ |
| diff_recent_activity | 45,263 | 3,012 | 15.0× | ✓ | ✓ |
| health_contradictions | 24,811 | 3,182 | 7.8× | ✓ | ✓ |
| code_function_lookup | 8,481 | 1,877 | 4.5× | ✓ | ✓ |

**Aggregate**: vector RAG total 157,489 bytes vs Recall router 17,355 bytes, **9.1× reduction** using router-style operator dispatch.
Relevance: vector RAG 6/7 vs router 6/7.

## Notes

- Embedding model: `all-mpnet-base-v2` (industry-standard production baseline)
- Top-k: 5 (standard production default; some systems use 3-10)
- Cosine similarity over normalized embeddings (equivalent to inner product)
- Same Recall graph as corpus; same available content, different retrieval
- Vector RAG returns full cell bodies as context (standard production pattern)
- Embeddings cached after first run; subsequent runs only embed the queries
- Latency excludes one-time model-load cost (~30-50s first run)
