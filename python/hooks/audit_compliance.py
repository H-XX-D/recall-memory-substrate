#!/usr/bin/env python3
"""
audit_compliance.py — measure whether the agent is actually following
the Recall enforcement hooks.

The hooks emit cues. This script measures whether those cues are being
acted on. It does NOT block — it reports. Use it to decide whether to
escalate from soft enforcement (current hooks) to hard enforcement
(PreToolUse blocking).

What it measures:

1. Write rate per substantive day: for each day in the window, count
   how many days had substantive activity (Recall reads or workspace
   modifications inferred from graph activity) and how many of those
   days produced at least one Recall write. A healthy ratio is > 0.7.

2. Cell-density vs activity-density: are writes happening at the
   moments substantive work is being done, or batched at session ends
   (which suggests the writeback hook is doing more work than the
   live agent)?

3. Confidence calibration over time: if the agent is writing through
   the helper, confidence values should be diverse (not all 0.7) —
   indicating the agent is actually grading findings rather than
   defaulting.

4. Supersedure use: are old cells being superseded via typed
   relations rather than re-derived as new cells? Supersedure-vs-
   duplication is the canonical Recall discipline.

Usage:

    python3 python/hooks/audit_compliance.py --since 7d
    python3 python/hooks/audit_compliance.py --since 30d --json

Exit code:
    0 if compliance is above the warning threshold (default 0.5)
    1 if compliance is below the warning threshold
    2 if the audit could not be run (DB missing or schema mismatch)
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

def _resolve_default_db() -> str:
    """Default to the model-A home local, honoring RECALL_DB / RECALL_GLOBAL_DB /
    RECALL_HOME the way recall_helper and routing.ts do. The pre-model-A
    single-file ~/.recall/recall.sqlite3 is stale: absent on a fresh install, a
    frozen pre-migration backup (or a symlink to it) on a migrated one."""
    explicit = os.environ.get("RECALL_DB", "").strip()
    if explicit:
        return explicit
    override = os.environ.get("RECALL_GLOBAL_DB", "").strip()
    if override:
        return override
    home = os.environ.get("RECALL_HOME", "").strip() or os.path.expanduser("~/.recall")
    return os.path.join(home, "db", "home.sqlite3")


DEFAULT_DB = _resolve_default_db()


def parse_since(s: str) -> datetime:
    now = datetime.now(timezone.utc)
    if s.endswith("d"):
        return now - timedelta(days=int(s[:-1]))
    if s.endswith("h"):
        return now - timedelta(hours=int(s[:-1]))
    if s.endswith("w"):
        return now - timedelta(weeks=int(s[:-1]))
    raise ValueError(f"unrecognized --since value: {s!r} (use Nd, Nh, or Nw)")


def audit(db_path: str, since: datetime) -> dict:
    if not Path(db_path).exists():
        return {"error": f"DB not found: {db_path}", "exit_code": 2}

    conn = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row

    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        # All cells in window. Confidence lives inside data_json (the
        # full recall.write.v1 proposal payload), not as a top-level
        # column, so pull it out below.
        rows = conn.execute(
            "SELECT id, created_at, kind, data_json FROM graph_nodes "
            "WHERE created_at >= ? AND status = 'active'",
            (since_iso,),
        ).fetchall()
    except sqlite3.OperationalError as e:
        return {"error": f"schema mismatch: {e}", "exit_code": 2}

    def _extract_confidence(data_json: str) -> float | None:
        try:
            d = json.loads(data_json)
            c = d.get("confidence")
            if isinstance(c, (int, float)):
                return float(c)
            if isinstance(c, dict):
                v = c.get("value")
                if isinstance(v, (int, float)):
                    return float(v)
        except (json.JSONDecodeError, TypeError):
            pass
        return None

    # ACP (Agent Communication Protocol) cells use a different payload shape —
    # they are inter-agent messages, not epistemic findings, so they should not
    # be counted in the confidence / kind-diversity scoring. Recognize them by
    # kind prefix and skip them in those metrics. The recent-activity count
    # still includes them — agent-to-agent traffic is still evidence the system
    # is alive.
    def _is_acp(kind: str) -> bool:
        k = (kind or "").lower()
        return k.startswith("acp_") or k.startswith("acp-") or k == "acp" or "acp_message" in k

    if not rows:
        return {
            "window_start": since_iso,
            "total_cells": 0,
            "warning": "No cells written in window. Either no work happened "
                       "or the agent is not writing back at all.",
            "exit_code": 1,
        }

    # 1. Writes per day
    writes_by_day: Counter[str] = Counter()
    for r in rows:
        day = r["created_at"][:10]
        writes_by_day[day] += 1
    days_with_writes = len(writes_by_day)
    window_days = max(1, (datetime.now(timezone.utc) - since).days)
    write_day_ratio = days_with_writes / window_days

    # 2. Confidence diversity (epistemic writes only — ACP excluded)
    epistemic_rows = [r for r in rows if not _is_acp(r["kind"])]
    confidences = [c for c in (_extract_confidence(r["data_json"]) for r in epistemic_rows) if c is not None]
    confidence_diversity = len(set(round(c, 2) for c in confidences)) if confidences else 0
    confidence_mean = sum(confidences) / len(confidences) if confidences else 0.0
    # Healthy: 5+ distinct rounded-to-0.01 buckets. Tracking absolute distinct
    # buckets (not ratio of writes) — once you have ~10 buckets you've shown
    # the agent is genuinely grading; more writes shouldn't keep raising the
    # bar linearly.
    diversity_ok = confidence_diversity >= 5

    # 3. Cell-kind diversity (epistemic only)
    kinds = Counter(r["kind"] for r in epistemic_rows)
    kind_diversity = len(kinds)
    # Healthy: at least 3 distinct epistemic kinds
    kind_diversity_ok = kind_diversity >= 3

    # Track ACP traffic separately so users can see it without it skewing the score
    acp_count = sum(1 for r in rows if _is_acp(r["kind"]))

    # 4. Supersedure use — count edges of supersede-type kinds
    try:
        edge_rows = conn.execute(
            "SELECT kind, COUNT(*) as n FROM graph_relations "
            "WHERE created_at >= ? GROUP BY kind",
            (since_iso,),
        ).fetchall()
    except sqlite3.OperationalError:
        edge_rows = []

    edge_kinds = {r["kind"]: r["n"] for r in edge_rows}
    supersede_count = sum(
        n for k, n in edge_kinds.items()
        if any(x in k.lower() for x in ("supersede", "supersedes", "supersed"))
    )
    relation_count = sum(edge_kinds.values())
    # Healthy: some fraction of edges are supersedure (not all just new writes)
    supersede_ratio = supersede_count / relation_count if relation_count else 0.0

    # 5. Compose summary score (0..1)
    score = 0.0
    score += 0.40 * min(1.0, write_day_ratio / 0.7)          # writes-per-day target 0.7
    score += 0.25 * (1.0 if diversity_ok else 0.5)            # confidence diversity
    score += 0.20 * (1.0 if kind_diversity_ok else 0.5)       # kind diversity
    score += 0.15 * min(1.0, supersede_ratio / 0.10)          # supersedure target 10%
    score = round(score, 3)

    conn.close()

    findings = []
    if write_day_ratio < 0.3:
        findings.append(
            f"LOW write-day ratio ({write_day_ratio:.2f}): agent rarely writes back. "
            f"Enable RECALL_WRITEBACK_FORCE=1 to train the pattern."
        )
    if not diversity_ok:
        findings.append(
            f"LOW confidence diversity ({confidence_diversity} distinct values across "
            f"{len(confidences)} writes): agent may be defaulting instead of grading."
        )
    if not kind_diversity_ok:
        findings.append(
            f"LOW kind diversity ({kind_diversity} distinct kinds): agent may be using "
            f"a single fallback kind instead of categorizing findings."
        )
    if supersede_ratio < 0.05 and relation_count > 10:
        findings.append(
            f"LOW supersedure rate ({supersede_ratio:.1%}): agent may be re-deriving "
            f"instead of typed-relation-superseding old cells."
        )
    if not findings:
        findings.append("Compliance is healthy. No remediation needed.")

    return {
        "window_start": since_iso,
        "window_days": window_days,
        "total_cells": len(rows),
        "epistemic_cells": len(epistemic_rows),
        "acp_cells": acp_count,
        "writes_by_day": dict(writes_by_day),
        "days_with_writes": days_with_writes,
        "write_day_ratio": round(write_day_ratio, 3),
        "confidence_mean": round(confidence_mean, 3),
        "confidence_diversity": confidence_diversity,
        "kind_distribution": dict(kinds),
        "kind_diversity": kind_diversity,
        "edge_kinds": edge_kinds,
        "supersede_ratio": round(supersede_ratio, 3),
        "compliance_score": score,
        "findings": findings,
        "exit_code": 0 if score >= 0.5 else 1,
    }


def render_text(result: dict) -> str:
    if "error" in result:
        return f"ERROR: {result['error']}"
    lines = [
        f"Recall Compliance Audit",
        f"  window:           since {result['window_start']} ({result['window_days']} days)",
        f"  total writes:     {result['total_cells']} ({result.get('epistemic_cells', 0)} epistemic, {result.get('acp_cells', 0)} ACP)",
        f"  days with writes: {result['days_with_writes']} / {result['window_days']} ({result['write_day_ratio']:.1%})",
        f"  confidence mean:  {result['confidence_mean']:.2f}",
        f"  confidence buckets: {result['confidence_diversity']} distinct values",
        f"  kind diversity:   {result['kind_diversity']} distinct ({', '.join(result['kind_distribution'].keys())})",
        f"  supersede ratio:  {result['supersede_ratio']:.1%}",
        f"",
        f"  COMPLIANCE SCORE: {result['compliance_score']} / 1.0",
        f"",
        f"  Findings:",
    ]
    for f in result["findings"]:
        lines.append(f"    - {f}")
    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description="Audit Recall enforcement compliance")
    p.add_argument("--since", default="7d", help="window (e.g. 7d, 24h, 2w)")
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args()

    try:
        since = parse_since(args.since)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    result = audit(args.db, since)

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(render_text(result))

    return result.get("exit_code", 0)


if __name__ == "__main__":
    sys.exit(main())
