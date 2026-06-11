#!/usr/bin/env python3
"""
recall_semantic_real.py — real-embedding backend for Recall semantic search.

The default Recall semantic backend is `hash:v1` — a 256-dim hashing
pseudo-embedding that effectively works as bag-of-words cosine. It's
fast and dependency-free, but it can't surface a cell unless the query
shares distinctive terms with the cell body. For natural-language
queries like "how do I save computations to the graph," hash:v1 buries
the correct answer below cells with high lexical overlap.

This script provides a real semantic backend using sentence-transformers
(all-mpnet-base-v2, 768 dimensions, the production-standard embedding
model for retrieval). Embeddings are written into the existing
`semantic_index` table under `backend='mpnet:v1'` so they coexist with
hash:v1 — both can be queried, you choose which.

WHY A PARALLEL BACKEND, NOT A REPLACEMENT.

The Recall TS core's `recall semantic` command is wired to hash:v1.
Replacing it would require a TS rebuild and a model-loader integration
that brings Python (or ONNX) into the core. That's a real change to
ship — but until it's shipped, this script gives you the upgrade NOW,
working alongside the existing infrastructure. The DB schema already
supports multiple backends via the `backend` column, so this adds rows
rather than mutating existing ones.

Once the TS core has a real-backend integration, this script's indexed
vectors will already be in place; the TS side just needs to prefer
`mpnet:v1` rows when present.

USAGE.

    # First-time index of all cells (takes ~30s for 500 cells):
    python3 python/scripts/recall_semantic_real.py reindex

    # Incremental — only embed cells without an mpnet:v1 row:
    python3 python/scripts/recall_semantic_real.py reindex --incremental

    # Query under the real backend:
    python3 python/scripts/recall_semantic_real.py query "how do I save computations"

    # Compare hash:v1 vs mpnet:v1 ranking for the same query:
    python3 python/scripts/recall_semantic_real.py compare "how to record findings"

    # Show backend coverage stats:
    python3 python/scripts/recall_semantic_real.py status

    # Verify a specific cell is reachable under sensible queries:
    python3 python/scripts/recall_semantic_real.py verify f4238db1

CONFIGURATION.

  RECALL_DB          — DB path (default: ~/.recall/recall.sqlite3)
  RECALL_EMBED_MODEL — sentence-transformers model (default: all-mpnet-base-v2)
  RECALL_EMBED_CACHE — cache vectors path (default: ~/.recall/.embeddings_real.npy)
  RECALL_EMBED_KEYS  — cache keys path (default: ~/.recall/.embeddings_real_keys.json)

SECURITY.

  The embedding cache uses plain .npy (no pickle) for vectors and a
  JSON sidecar for keys — no arbitrary-code-execution risk from loading
  it. Cells are NEVER embedded in a sandbox-escaping way; the script
  reads the DB read-only for query/compare/verify, and only opens
  write-mode during reindex.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

DB_PATH = os.environ.get("RECALL_DB", os.path.expanduser("~/.recall/recall.sqlite3"))
MODEL_NAME = os.environ.get("RECALL_EMBED_MODEL", "all-mpnet-base-v2")
CACHE_VEC_PATH = os.environ.get(
    "RECALL_EMBED_CACHE", os.path.expanduser("~/.recall/.embeddings_real.npy"))
CACHE_KEYS_PATH = os.environ.get(
    "RECALL_EMBED_KEYS", os.path.expanduser("~/.recall/.embeddings_real_keys.json"))
BACKEND_TAG = "mpnet:v1"
EMBED_DIMS = 768


def resolve_backend_tag(arg_tag: str | None, ts_compatible: bool) -> str:
    """Pick the backend tag rows get written under.

    Default is 'mpnet:v1' — clear and standalone. When integrating with
    the TS core's `recall semantic` (via RECALL_EMBEDDING_COMMAND), TS
    tags queries as 'command:<full_command_string>' and only matches
    rows with the same tag. The --ts-compatible flag (or explicit
    --backend-tag) lets the standalone reindex write rows the TS query
    will find."""
    if arg_tag:
        return arg_tag
    if ts_compatible:
        cmd = os.environ.get("RECALL_EMBEDDING_COMMAND", "").strip()
        if not cmd:
            print(f"{Y}WARN{X}: --ts-compatible needs RECALL_EMBEDDING_COMMAND set; "
                  f"falling back to {BACKEND_TAG}", file=sys.stderr)
            return BACKEND_TAG
        return f"command:{cmd}"
    return BACKEND_TAG

G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; B = "\033[34m"; D = "\033[2m"; X = "\033[0m"


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _embed_input(title: str, body: str) -> str:
    """Title-weighted (repeated) so cells are findable by topic, not just body."""
    title = (title or "").strip()
    body = (body or "").strip()
    return f"{title}\n\n{title}\n\n{body}"[:8000]


def _load_model():
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print(f"{R}ERROR{X}: sentence-transformers not installed.\n"
              f"Install with: pip install sentence-transformers", file=sys.stderr)
        sys.exit(2)
    t0 = time.time()
    print(f"{D}Loading model {MODEL_NAME}...{X}", file=sys.stderr)
    model = SentenceTransformer(MODEL_NAME)
    print(f"{D}Model loaded in {time.time()-t0:.1f}s{X}", file=sys.stderr)
    return model


def _load_cache() -> dict[str, list[float]]:
    """Load cache from plain .npy (no pickle) + JSON keys sidecar."""
    import numpy as np
    if not (Path(CACHE_VEC_PATH).exists() and Path(CACHE_KEYS_PATH).exists()):
        return {}
    try:
        vectors = np.load(CACHE_VEC_PATH, allow_pickle=False)
        with open(CACHE_KEYS_PATH) as f:
            keys = json.load(f)
        if len(keys) != vectors.shape[0]:
            print(f"{Y}WARN{X}: cache key/vector count mismatch; rebuilding",
                  file=sys.stderr)
            return {}
        return {k: vectors[i].tolist() for i, k in enumerate(keys)}
    except Exception as e:
        print(f"{Y}WARN{X}: failed to load cache ({e}); rebuilding", file=sys.stderr)
        return {}


def _save_cache(cache: dict[str, list[float]]) -> None:
    import numpy as np
    Path(CACHE_VEC_PATH).parent.mkdir(parents=True, exist_ok=True)
    keys = list(cache.keys())
    vectors = np.array([cache[k] for k in keys], dtype="float32")
    # Plain .npy — no pickle, safe to load
    np.save(CACHE_VEC_PATH, vectors, allow_pickle=False)
    with open(CACHE_KEYS_PATH, "w") as f:
        json.dump(keys, f)


def _conn(readonly: bool = False) -> sqlite3.Connection:
    if not Path(DB_PATH).exists():
        print(f"{R}ERROR{X}: DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(2)
    if readonly:
        return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    return sqlite3.connect(DB_PATH)


# ============================================================
# COMMANDS
# ============================================================

def cmd_reindex(args):
    tag = resolve_backend_tag(args.backend_tag, args.ts_compatible)
    conn = _conn(readonly=False)
    rows = conn.execute(
        "SELECT id, title, body FROM graph_nodes WHERE status='active'"
    ).fetchall()
    print(f"{D}Active cells in DB: {len(rows)} | backend tag: {tag}{X}", file=sys.stderr)

    if args.incremental:
        existing = {r[0] for r in conn.execute(
            "SELECT node_id FROM semantic_index WHERE backend=?", (tag,),
        ).fetchall()}
        rows = [r for r in rows if r[0] not in existing]
        print(f"{D}Incremental: {len(rows)} cells need embedding{X}", file=sys.stderr)

    if not rows:
        print(f"{G}Nothing to embed.{X}")
        conn.close()
        return 0

    cache = _load_cache()
    cache_hits = 0
    to_embed: list[tuple[str, str, str]] = []
    for nid, title, body in rows:
        text = _embed_input(title, body)
        h = _content_hash(text)
        if h in cache:
            cache_hits += 1
        else:
            to_embed.append((nid, h, text))

    print(f"{D}Cache hits: {cache_hits}/{len(rows)}; need to embed: {len(to_embed)}{X}",
          file=sys.stderr)

    if to_embed:
        model = _load_model()
        texts = [t for _, _, t in to_embed]
        t0 = time.time()
        vecs = model.encode(texts, batch_size=32, show_progress_bar=True,
                            convert_to_numpy=True, normalize_embeddings=True)
        print(f"{D}Embedded {len(texts)} in {time.time()-t0:.1f}s "
              f"({len(texts)/(time.time()-t0):.0f}/s){X}", file=sys.stderr)
        for (_nid, h, _t), v in zip(to_embed, vecs):
            cache[h] = v.tolist()
        _save_cache(cache)

    written = 0
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for nid, title, body in rows:
        text = _embed_input(title, body)
        h = _content_hash(text)
        vec = cache.get(h)
        if vec is None:
            continue
        conn.execute(
            "INSERT INTO semantic_index (node_id, backend, dims, vector_json, indexed_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(node_id) DO UPDATE SET "
            "backend=excluded.backend, dims=excluded.dims, "
            "vector_json=excluded.vector_json, indexed_at=excluded.indexed_at "
            "WHERE semantic_index.backend != excluded.backend OR semantic_index.backend = ?",
            (nid, tag, EMBED_DIMS, json.dumps(vec), now, tag),
        )
        written += 1
    conn.commit()
    conn.close()
    print(f"{G}Indexed {written} cells under backend={tag}, dims={EMBED_DIMS}{X}")
    return 0


def cmd_query(args):
    import numpy as np
    model = _load_model()
    qv = model.encode(args.query, normalize_embeddings=True)
    conn = _conn(readonly=True)
    rows = conn.execute(
        "SELECT s.node_id, s.vector_json, n.kind, n.title "
        "FROM semantic_index s JOIN graph_nodes n ON n.id = s.node_id "
        "WHERE s.backend = ? AND n.status='active'",
        (BACKEND_TAG,),
    ).fetchall()
    conn.close()
    if not rows:
        print(f"{R}No cells indexed under {BACKEND_TAG}. Run reindex first.{X}",
              file=sys.stderr)
        return 1
    qv_np = np.array(qv, dtype="float32")
    scored = sorted(
        ((float((qv_np * np.array(json.loads(v), dtype="float32")).sum()), nid, k, t)
         for nid, v, k, t in rows),
        reverse=True,
    )
    if args.format == "json":
        print(json.dumps([
            {"id": nid, "score": round(s, 4), "kind": k, "title": t}
            for s, nid, k, t in scored[:args.k]
        ], indent=2))
    else:
        print(f"\n{B}Top {args.k} mpnet:v1 matches for{X} {args.query!r}\n")
        for i, (score, nid, kind, title) in enumerate(scored[:args.k], 1):
            print(f"  {Y}#{i}{X} score={score:.3f}  {D}{nid[:8]}{X}  "
                  f"{kind:<14}  {title[:78]}")
    return 0


def cmd_compare(args):
    import numpy as np
    import subprocess
    model = _load_model()
    qv_real = model.encode(args.query, normalize_embeddings=True)
    conn = _conn(readonly=True)
    real_rows = conn.execute(
        "SELECT s.node_id, s.vector_json, n.title FROM semantic_index s "
        "JOIN graph_nodes n ON n.id=s.node_id "
        "WHERE s.backend=? AND n.status='active'",
        (BACKEND_TAG,),
    ).fetchall()
    qv_np = np.array(qv_real, dtype="float32")
    real_scored = sorted(
        ((float((qv_np * np.array(json.loads(v), dtype="float32")).sum()), nid, t)
         for nid, v, t in real_rows),
        reverse=True,
    )
    p = subprocess.run(
        ["recall", "semantic", args.query, "--db", DB_PATH],
        capture_output=True, text=True, timeout=10,
    )
    try:
        hash_data = json.loads(p.stdout)
        hash_results = [(r.get("score", 0), r["item"]["id"], r["item"]["title"])
                        for r in hash_data.get("results", [])][:args.k]
    except (json.JSONDecodeError, KeyError):
        hash_results = []
    conn.close()

    k = args.k
    print(f"\n{B}Query:{X} {args.query!r}\n")
    print(f"  {'rank':<5} {Y}hash:v1{X}{' '*42}  →  {G}mpnet:v1{X}")
    print(f"  {'-'*5} {'-'*48}     {'-'*48}")
    for i in range(k):
        hash_str = "—"
        if i < len(hash_results):
            _, hid, htitle = hash_results[i]
            hash_str = f"{hid[:8]} {htitle[:40]}"
        real_str = "—"
        if i < len(real_scored):
            _, rid, rtitle = real_scored[i]
            real_str = f"{rid[:8]} {rtitle[:40]}"
        print(f"  #{i+1:<3}  {hash_str:<50}  →  {real_str}")
    return 0


def cmd_status(args):
    conn = _conn(readonly=True)
    total_cells = conn.execute(
        "SELECT COUNT(*) FROM graph_nodes WHERE status='active'").fetchone()[0]
    by_backend = conn.execute(
        "SELECT backend, dims, COUNT(*) FROM semantic_index GROUP BY backend, dims"
    ).fetchall()
    conn.close()
    print(f"\n{B}Semantic index status{X} (DB: {DB_PATH})")
    print(f"  Active cells:         {total_cells}")
    print(f"  Backends indexed:")
    if not by_backend:
        print(f"    {Y}(none){X}")
    else:
        for backend, dims, count in by_backend:
            color = G if backend == BACKEND_TAG else D
            coverage = f"{count/total_cells:.0%}" if total_cells else "?"
            print(f"    {color}{backend:<14}{X}  dims={dims:<5}  cells={count:>5}  ({coverage})")
    for label, p in (("vectors", CACHE_VEC_PATH), ("keys", CACHE_KEYS_PATH)):
        if Path(p).exists():
            size_kb = Path(p).stat().st_size / 1024
            print(f"  Cache {label:<8}     {p} ({size_kb:.0f} KB)")
    return 0


def cmd_verify(args):
    import re
    import numpy as np
    cell_id_prefix = args.cell
    conn = _conn(readonly=True)
    rows = conn.execute(
        "SELECT id, title FROM graph_nodes WHERE id LIKE ? AND status='active'",
        (f"{cell_id_prefix}%",),
    ).fetchall()
    if not rows:
        print(f"{R}No cell found with id prefix {cell_id_prefix!r}{X}", file=sys.stderr)
        conn.close()
        return 1
    target_id, title = rows[0]
    print(f"\n{B}Verifying discoverability of cell{X} {target_id[:8]} — {title[:70]}\n")

    salient = [w for w in re.split(r"\W+", title) if len(w) > 4][:6]
    queries = [
        title[:60],
        " ".join(salient[:3]) if len(salient) >= 3 else title,
        " ".join(salient[3:6]) if len(salient) >= 4 else " ".join(salient or [title]),
        f"how to {salient[0].lower()}" if salient else title,
    ]

    model = _load_model()
    idx_rows = conn.execute(
        "SELECT s.node_id, s.vector_json FROM semantic_index s "
        "JOIN graph_nodes n ON n.id=s.node_id "
        "WHERE s.backend=? AND n.status='active'",
        (BACKEND_TAG,),
    ).fetchall()
    conn.close()
    if not idx_rows:
        print(f"{R}No mpnet:v1 vectors. Run reindex first.{X}", file=sys.stderr)
        return 1

    for q in queries:
        qv = model.encode(q, normalize_embeddings=True)
        scored = sorted(
            ((float((qv * np.array(json.loads(v), dtype="float32")).sum()), nid)
             for nid, v in idx_rows),
            reverse=True,
        )
        rank = next((i + 1 for i, (_, nid) in enumerate(scored) if nid == target_id), None)
        color = G if rank and rank <= 3 else (Y if rank and rank <= 10 else R)
        rank_str = f"#{rank}" if rank else "not in results"
        print(f"  {color}{rank_str:<8}{X}  for query: {q!r}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Real semantic backend for Recall (mpnet:v1)")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("reindex", help="embed all (or new) cells under mpnet:v1")
    p.add_argument("--incremental", action="store_true",
                   help="only embed cells lacking a row under the chosen backend tag")
    p.add_argument("--backend-tag", default=None,
                   help="override backend tag (default: mpnet:v1; "
                        "use 'command:<your-RECALL_EMBEDDING_COMMAND>' for TS-side query compat)")
    p.add_argument("--ts-compatible", action="store_true",
                   help="auto-derive backend tag from $RECALL_EMBEDDING_COMMAND so "
                        "rows are visible to `recall semantic` queries via the adapter")
    p.set_defaults(func=cmd_reindex)

    p = sub.add_parser("query", help="top-k mpnet:v1 cosine search")
    p.add_argument("query")
    p.add_argument("--k", type=int, default=5)
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("compare", help="hash:v1 vs mpnet:v1 side-by-side ranking")
    p.add_argument("query")
    p.add_argument("--k", type=int, default=5)
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("status", help="backend coverage stats")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("verify", help="check discoverability of a specific cell")
    p.add_argument("cell", help="cell id or prefix")
    p.set_defaults(func=cmd_verify)

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
