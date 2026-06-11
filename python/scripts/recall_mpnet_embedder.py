#!/usr/bin/env python3
"""
recall_mpnet_embedder.py — RECALL_EMBEDDING_COMMAND adapter.

Plugs sentence-transformers (all-mpnet-base-v2, 768-dim) into the
Recall TS core via the `RECALL_EMBEDDING_COMMAND` extension point.
When this script is configured, `recall semantic "..."`,
`recall semantic reindex`, and every new write's auto-indexing all
use real semantic embeddings instead of hash:v1.

CONTRACT (defined by src/core/semantic.ts → commandEmbedding):

  Input:  stdin JSON  { "text": "...", "dims": <number> }
  Output: stdout JSON — either a number[] or {"vector": number[]}
  Exit 0 on success, nonzero with a stderr message on failure.

We IGNORE the requested `dims` and always return the model's native
768 dimensions. The TS side records `dims: vector.length` and tags
the backend as `command:<this_command>` automatically.

CONFIGURATION.

  Tell Recall to use this embedder:

    export RECALL_EMBEDDING_COMMAND='python3 /path/to/python/scripts/recall_mpnet_embedder.py'

  Then verify:

    recall semantic "test query"        # uses mpnet via this adapter
    recall semantic reindex              # re-embeds all cells with mpnet

  Environment overrides:

    RECALL_EMBED_MODEL  — model name (default: all-mpnet-base-v2)

PERFORMANCE NOTE — IMPORTANT FOR RELEASE.

  The TS core spawns this script ONCE PER EMBEDDING CALL. Loading the
  mpnet model takes ~3s. That's acceptable for ad-hoc queries (one
  load per query) but BROKEN for `recall semantic reindex` of a large
  graph (500 cells × 3s = 25 minutes of model loads).

  FOR BULK REINDEX, USE THE STANDALONE SCRIPT INSTEAD:

    # Set RECALL_EMBEDDING_COMMAND first so --ts-compatible can
    # derive the matching backend tag (otherwise standalone writes
    # under 'mpnet:v1' and TS queries under 'command:...' don't see
    # each other):
    export RECALL_EMBEDDING_COMMAND='python3 /full/path/to/recall_mpnet_embedder.py'
    python3 python/scripts/recall_semantic_real.py reindex --ts-compatible

  That script batches all embeddings into one model load, completes
  500 cells in ~13 seconds, and writes rows tagged with the same
  backend the TS adapter produces — so `recall semantic` queries find
  the mpnet vectors the standalone script wrote.

  Use this adapter for: per-query semantic search, per-write auto-
  indexing of new cells (where ~3s per write is acceptable).

  Use the standalone script for: initial bulk reindex, periodic full
  re-embedding after model upgrades.

  A persistent-daemon embedder (eliminating model-load latency
  entirely) is on the roadmap; it would let the adapter handle both
  workloads at native speed.

DEPENDENCIES.

  pip install sentence-transformers
"""

from __future__ import annotations

import json
import os
import sys


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"recall_mpnet_embedder: invalid JSON on stdin: {e}", file=sys.stderr)
        return 2
    text = payload.get("text", "")
    if not isinstance(text, str):
        print("recall_mpnet_embedder: 'text' must be a string", file=sys.stderr)
        return 2

    # Silence sentence-transformers / huggingface progress bars and warnings
    # so they don't pollute any caller that redirects 2>&1.
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TQDM_DISABLE", "1")

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("recall_mpnet_embedder: sentence-transformers not installed. "
              "Install with: pip install sentence-transformers", file=sys.stderr)
        return 2

    model_name = os.environ.get("RECALL_EMBED_MODEL", "all-mpnet-base-v2")
    model = SentenceTransformer(model_name)
    vec = model.encode(text or " ", normalize_embeddings=True,
                       show_progress_bar=False).tolist()
    # Output contract: bare number[] is accepted by the TS side
    sys.stdout.write(json.dumps(vec))
    return 0


if __name__ == "__main__":
    sys.exit(main())
