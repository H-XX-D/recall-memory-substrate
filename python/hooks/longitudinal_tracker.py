#!/usr/bin/env python3
"""
longitudinal_tracker.py — measure whether Recall enforcement is producing
better outcomes OVER TIME, not just that it behaved correctly on one query.

The audit_compliance script gives a point-in-time score. The PreToolUse
guard tests prove the hook behaves as specified. Neither answers the
question that actually matters: "is the enforcement loop producing
better work?" That question only has a meaningful answer in trajectory.

This tracker measures four trajectory dimensions:

  1. RATIONALE QUALITY: are the rationale cells substantive, or
     perfunctory? Body length, evidence-link density, confidence-grading
     variance, topic specificity. A healthy trajectory: quality steady
     or rising over time.

  2. REWORK / CHURN: how often do cells get contradicted or superseded
     after being written? How often is the same file mutated with
     different rationale cells? A healthy trajectory: churn falling
     after an initial calibration period.

  3. ENFORCEMENT COMPLIANCE: from guard event log — approve rate, block
     rate, bypass rate, time-from-block-to-rationale-write. A healthy
     trajectory: bypass rate near zero, block→write latency falling.

  4. CONTINUITY VALUE: are cells being referenced by later writes (via
     handle reuse / `supports`/`depends_on` edges to prior cells), or
     are old cells dead-weight? Also: rediscovery rate — how often is
     a new cell substantially duplicative of an older cell, indicating
     the agent didn't read before writing.

Snapshots are stored in `~/.recall/longitudinal_snapshots.jsonl`
(append-only, one snapshot per line). The trend report compares the
most recent snapshot to prior snapshots and surfaces directional
movement.

Usage:
    # Take a snapshot now (run from cron daily, or manually)
    python3 python/hooks/longitudinal_tracker.py snapshot

    # Report current snapshot + comparison to prior
    python3 python/hooks/longitudinal_tracker.py report

    # Show trajectory for a specific metric across all snapshots
    python3 python/hooks/longitudinal_tracker.py trend --metric quality_score

    # Show recent guard events (last N)
    python3 python/hooks/longitudinal_tracker.py events --limit 20

    # Show all snapshots as JSON (for plotting / further analysis)
    python3 python/hooks/longitudinal_tracker.py history --json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
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
SNAPSHOT_LOG = os.environ.get(
    "RECALL_LONGITUDINAL_LOG",
    os.path.expanduser("~/.recall/longitudinal_snapshots.jsonl"),
)
EVENT_LOG = os.environ.get(
    "RECALL_GUARD_EVENT_LOG",
    os.path.expanduser("~/.recall/guard_events.jsonl"),
)

# ANSI
G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; B = "\033[34m"; D = "\033[2m"; X = "\033[0m"


# =========================================================
# METRIC COMPUTATION
# =========================================================

def _iso_cutoff(seconds_ago: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds_ago))


def _normalize_tokens(text: str) -> set[str]:
    """Lowercase, split on non-alphanumeric, drop short words."""
    return {t for t in re.split(r"\W+", (text or "").lower()) if len(t) > 3}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def measure_rationale_quality(conn: sqlite3.Connection, window_seconds: int) -> dict:
    """Compute rationale-quality metrics over the window.

    A rationale cell is one whose kind is in the set the guard recognizes.
    Quality components (each 0..1):
      - substance:    fraction with body length > 100 chars
      - linked:       fraction with at least one evidence ref (supports/depends_on/etc.)
      - graded:       fraction with confidence not equal to default values (0.5, 0.7)
      - specific:     fraction with >=2 distinct topic tags

    Overall quality_score is the unweighted mean of the four components.
    """
    cutoff = _iso_cutoff(window_seconds)
    rationale_kinds = ("decision", "task", "hypothesis", "lemma", "risk",
                       "verification_result", "reflection", "blind_lock")
    kinds_clause = ",".join("?" * len(rationale_kinds))
    rows = conn.execute(
        f"SELECT id, body, data_json, tags_json FROM graph_nodes "
        f"WHERE status='active' AND created_at >= ? AND kind IN ({kinds_clause})",
        (cutoff, *rationale_kinds),
    ).fetchall()
    if not rows:
        return {"count": 0, "quality_score": None,
                "substance": None, "linked": None, "graded": None, "specific": None}

    substance = sum(1 for r in rows if len(r[1] or "") > 100) / len(rows)

    linked = 0
    confidences = []
    topics_per_cell = []
    for _id, _body, data_json, tags_json in rows:
        try:
            d = json.loads(data_json)
            ev = d.get("evidence", {})
            # Count any non-empty typed-edge list as "linked"
            for k in ("supports", "contradicts", "depends_on", "concerns"):
                if ev.get(k):
                    linked += 1
                    break
            c = d.get("confidence", {})
            v = c.get("value") if isinstance(c, dict) else c
            if isinstance(v, (int, float)):
                confidences.append(round(v, 2))
        except (json.JSONDecodeError, TypeError, KeyError):
            pass
        try:
            tags = json.loads(tags_json)
            topics_per_cell.append(len(tags.get("topics", [])))
        except (json.JSONDecodeError, TypeError, KeyError):
            topics_per_cell.append(0)

    linked_frac = linked / len(rows)
    # Graded = confidence not 0.50 or 0.70 (the two default-y values)
    if confidences:
        non_default = sum(1 for c in confidences if c not in (0.50, 0.70))
        graded_frac = non_default / len(confidences)
    else:
        graded_frac = 0.0
    specific_frac = sum(1 for n in topics_per_cell if n >= 2) / len(topics_per_cell) if topics_per_cell else 0.0

    components = (substance, linked_frac, graded_frac, specific_frac)
    return {
        "count": len(rows),
        "quality_score": round(sum(components) / len(components), 3),
        "substance": round(substance, 3),
        "linked": round(linked_frac, 3),
        "graded": round(graded_frac, 3),
        "specific": round(specific_frac, 3),
    }


def measure_rework(conn: sqlite3.Connection, window_seconds: int) -> dict:
    """How often do cells get contradicted / superseded / re-derived?

    Three signals:
      - contradicts_per_cell: edges of kind 'contradicts' / total cells
      - supersedes_per_cell: edges of kind 'supersedes' (or matching) / total cells
      - rediscovery_rate: fraction of recent cells whose body has high
        token-overlap with an older cell (Jaccard >= 0.4)
    """
    cutoff = _iso_cutoff(window_seconds)
    rows = conn.execute(
        "SELECT id, body, created_at FROM graph_nodes "
        "WHERE status='active' AND created_at >= ?", (cutoff,),
    ).fetchall()
    if not rows:
        return {"cells_in_window": 0, "contradicts_rate": None,
                "supersedes_rate": None, "rediscovery_rate": None}

    # Edges in window
    edges = conn.execute(
        "SELECT kind, source_id, target_id FROM graph_relations "
        "WHERE created_at >= ?", (cutoff,),
    ).fetchall()
    contradicts = sum(1 for e in edges if e[0] == "contradicts")
    supersedes = sum(1 for e in edges if "supersed" in (e[0] or ""))

    # Rediscovery: compare each recent cell's body to all OLDER cells
    older = conn.execute(
        "SELECT id, body FROM graph_nodes "
        "WHERE status='active' AND created_at < ?", (cutoff,),
    ).fetchall()
    older_tokens = [(oid, _normalize_tokens(obody)) for oid, obody in older]
    rediscovered = 0
    for _id, body, _ts in rows:
        toks = _normalize_tokens(body)
        if not toks:
            continue
        for _oid, otoks in older_tokens:
            if _jaccard(toks, otoks) >= 0.4:
                rediscovered += 1
                break

    return {
        "cells_in_window": len(rows),
        "contradicts_rate": round(contradicts / len(rows), 3),
        "supersedes_rate": round(supersedes / len(rows), 3),
        "rediscovery_rate": round(rediscovered / len(rows), 3),
    }


def measure_enforcement(window_seconds: int) -> dict:
    """Read the guard event log and summarize outcomes in the window."""
    if not Path(EVENT_LOG).exists():
        return {"event_log_missing": True}
    cutoff_iso = _iso_cutoff(window_seconds)
    counts = Counter()
    block_targets = []
    bypass_targets = []
    block_to_write_latencies = []
    pending_blocks: dict[str, str] = {}  # target -> block_ts

    with open(EVENT_LOG) as f:
        for line in f:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("ts", "") < cutoff_iso:
                continue
            outcome = ev.get("outcome", "")
            counts[outcome] += 1
            target = ev.get("target", "")
            if outcome == "block":
                pending_blocks[target] = ev["ts"]
                block_targets.append(target[:60])
            elif outcome == "approve" and target in pending_blocks:
                # Block followed by approve on same target = recovery
                t1 = datetime.fromisoformat(pending_blocks.pop(target).replace("Z", "+00:00"))
                t2 = datetime.fromisoformat(ev["ts"].replace("Z", "+00:00"))
                block_to_write_latencies.append((t2 - t1).total_seconds())
            elif outcome == "bypass":
                bypass_targets.append(target[:60])

    total = sum(counts.values())
    if total == 0:
        return {"events_in_window": 0}

    return {
        "events_in_window": total,
        "approve_rate": round(counts["approve"] / total, 3),
        "block_rate": round(counts["block"] / total, 3),
        "bypass_rate": round(counts["bypass"] / total, 3),
        "cold_start_count": counts["cold_start"],
        "dry_run_blocks": counts["dry_run"],
        "median_block_to_write_seconds": (
            round(statistics.median(block_to_write_latencies), 1)
            if block_to_write_latencies else None
        ),
        "recent_block_targets": block_targets[-5:],
        "recent_bypass_targets": bypass_targets[-5:],
    }


def measure_continuity(conn: sqlite3.Connection, window_seconds: int) -> dict:
    """Are cells being referenced (handle-reused) by later cells?

      - handle_reuse_rate: fraction of recent cells that have at least
        one incoming edge from a NEWER cell
      - avg_incoming_edges: mean incoming-edge count for cells in window
    """
    cutoff = _iso_cutoff(window_seconds)
    rows = conn.execute(
        "SELECT id, created_at FROM graph_nodes WHERE status='active' AND created_at >= ?",
        (cutoff,),
    ).fetchall()
    if not rows:
        return {"cells_in_window": 0, "handle_reuse_rate": None,
                "avg_incoming_edges": None}

    referenced = 0
    incoming_counts = []
    for cid, ts in rows:
        edges = conn.execute(
            "SELECT created_at FROM graph_relations "
            "WHERE target_id = ? AND created_at > ?",
            (cid, ts),
        ).fetchall()
        if edges:
            referenced += 1
        incoming_counts.append(len(edges))
    return {
        "cells_in_window": len(rows),
        "handle_reuse_rate": round(referenced / len(rows), 3),
        "avg_incoming_edges": round(statistics.mean(incoming_counts), 2) if incoming_counts else 0,
    }


def take_snapshot(window_seconds: int = 7 * 86400) -> dict:
    """Compute all metrics, return a snapshot dict."""
    if not Path(DEFAULT_DB).exists():
        return {"error": f"DB not found: {DEFAULT_DB}"}
    conn = sqlite3.connect(f"file:{DEFAULT_DB}?immutable=1", uri=True)
    snap = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "window_seconds": window_seconds,
        "rationale_quality": measure_rationale_quality(conn, window_seconds),
        "rework": measure_rework(conn, window_seconds),
        "enforcement": measure_enforcement(window_seconds),
        "continuity": measure_continuity(conn, window_seconds),
    }
    conn.close()
    return snap


# =========================================================
# SNAPSHOT STORAGE
# =========================================================

def append_snapshot(snap: dict) -> None:
    Path(SNAPSHOT_LOG).parent.mkdir(parents=True, exist_ok=True)
    with open(SNAPSHOT_LOG, "a") as f:
        f.write(json.dumps(snap) + "\n")


def load_snapshots(limit: int | None = None) -> list[dict]:
    if not Path(SNAPSHOT_LOG).exists():
        return []
    out = []
    with open(SNAPSHOT_LOG) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if limit:
        out = out[-limit:]
    return out


def _delta(now, prev, fmt="{:+.3f}"):
    """Format the change between two numeric values."""
    if now is None or prev is None:
        return "n/a"
    try:
        return fmt.format(now - prev)
    except (TypeError, ValueError):
        return "n/a"


def _arrow(now, prev, higher_better=True):
    if now is None or prev is None:
        return D + "·" + X
    if now == prev:
        return "→"
    rising = now > prev
    good = rising == higher_better
    color = G if good else R
    arrow = "↑" if rising else "↓"
    return color + arrow + X


# =========================================================
# COMMANDS
# =========================================================

def cmd_snapshot(args):
    snap = take_snapshot(window_seconds=args.window)
    if "error" in snap:
        print(f"{R}ERROR: {snap['error']}{X}", file=sys.stderr)
        return 2
    append_snapshot(snap)
    print(f"{G}Snapshot recorded at {snap['ts']}{X}")
    print(f"  rationale_quality: {snap['rationale_quality'].get('quality_score')}")
    print(f"  cells in window:   {snap['rationale_quality'].get('count')}")
    print(f"  guard events:      {snap['enforcement'].get('events_in_window', 0)}")
    return 0


def cmd_report(args):
    snaps = load_snapshots()
    if not snaps:
        print(f"{Y}No snapshots yet. Run `longitudinal_tracker.py snapshot` first.{X}")
        return 1
    cur = snaps[-1]
    prev = snaps[-2] if len(snaps) >= 2 else None

    print(f"\n{B}Current snapshot{X} ({cur['ts']}, window={cur['window_seconds']}s)")
    print(f"  Snapshots on record: {len(snaps)}")

    def line(label, current_val, prev_val, higher_better=True, fmt="{:.3f}"):
        try:
            cur_str = fmt.format(current_val) if current_val is not None else "n/a"
        except (TypeError, ValueError):
            cur_str = str(current_val)
        arrow = _arrow(current_val, prev_val, higher_better) if prev else ""
        delta = f" Δ {_delta(current_val, prev_val)}" if prev else ""
        print(f"  {label:<32} {cur_str:>10}  {arrow}{delta}")

    rq = cur["rationale_quality"]; rqp = (prev or {}).get("rationale_quality", {})
    print(f"\n{B}1. Rationale quality{X}")
    line("quality_score", rq.get("quality_score"), rqp.get("quality_score"))
    line("substance (body > 100 chars)", rq.get("substance"), rqp.get("substance"))
    line("linked (has evidence ref)", rq.get("linked"), rqp.get("linked"))
    line("graded (non-default conf)", rq.get("graded"), rqp.get("graded"))
    line("specific (≥2 topics)", rq.get("specific"), rqp.get("specific"))
    line("count of rationale cells", rq.get("count"), rqp.get("count"), fmt="{:.0f}")

    rw = cur["rework"]; rwp = (prev or {}).get("rework", {})
    print(f"\n{B}2. Rework / churn{X} (lower is better)")
    line("contradicts_rate", rw.get("contradicts_rate"), rwp.get("contradicts_rate"), higher_better=False)
    line("supersedes_rate", rw.get("supersedes_rate"), rwp.get("supersedes_rate"), higher_better=False)
    line("rediscovery_rate", rw.get("rediscovery_rate"), rwp.get("rediscovery_rate"), higher_better=False)

    en = cur["enforcement"]; enp = (prev or {}).get("enforcement", {})
    print(f"\n{B}3. Enforcement (guard events){X}")
    if en.get("event_log_missing"):
        print(f"  {Y}guard event log not present — install guard hook to enable{X}")
    elif en.get("events_in_window", 0) == 0:
        print(f"  {D}no guard events in window{X}")
    else:
        line("approve_rate", en.get("approve_rate"), enp.get("approve_rate"))
        line("block_rate", en.get("block_rate"), enp.get("block_rate"), higher_better=False)
        line("bypass_rate", en.get("bypass_rate"), enp.get("bypass_rate"), higher_better=False)
        if en.get("median_block_to_write_seconds") is not None:
            line("median block→write (sec)",
                 en.get("median_block_to_write_seconds"),
                 enp.get("median_block_to_write_seconds"),
                 higher_better=False, fmt="{:.1f}")
        if en.get("recent_bypass_targets"):
            print(f"  {Y}recent bypasses:{X} {', '.join(en['recent_bypass_targets'])}")

    co = cur["continuity"]; cop = (prev or {}).get("continuity", {})
    print(f"\n{B}4. Continuity{X}")
    line("handle_reuse_rate", co.get("handle_reuse_rate"), cop.get("handle_reuse_rate"))
    line("avg_incoming_edges", co.get("avg_incoming_edges"), cop.get("avg_incoming_edges"), fmt="{:.2f}")

    # Final assessment
    score = rq.get("quality_score") or 0
    if score >= 0.6:
        verdict = f"{G}HEALTHY{X} ({score:.2f})"
    elif score >= 0.4:
        verdict = f"{Y}DEVELOPING{X} ({score:.2f})"
    else:
        verdict = f"{R}WEAK{X} ({score:.2f})"
    print(f"\n  Overall trajectory: {verdict}")
    return 0


def cmd_trend(args):
    snaps = load_snapshots()
    if len(snaps) < 2:
        print(f"{Y}Need at least 2 snapshots for trend. Have {len(snaps)}.{X}")
        return 1

    def _resolve(path, snap):
        cur = snap
        for part in path.split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                return None
        return cur

    paths = args.metric if isinstance(args.metric, list) else [args.metric]
    print(f"\n{B}Trend across {len(snaps)} snapshots{X}\n")
    for path in paths:
        print(f"  {path}")
        prev_v = None
        for s in snaps:
            v = _resolve(path, s)
            arrow = ""
            if prev_v is not None and v is not None:
                if v > prev_v: arrow = f"{G}↑{X}"
                elif v < prev_v: arrow = f"{R}↓{X}"
                else: arrow = "→"
            v_str = f"{v:.3f}" if isinstance(v, float) else (str(v) if v is not None else "n/a")
            print(f"    {s['ts']}  {v_str:>10}  {arrow}")
            prev_v = v
        print()
    return 0


def cmd_events(args):
    if not Path(EVENT_LOG).exists():
        print(f"{Y}No event log at {EVENT_LOG}.{X}")
        return 1
    lines = Path(EVENT_LOG).read_text().splitlines()
    recent = lines[-args.limit:]
    print(f"\n{B}Recent {len(recent)} guard events{X}\n")
    color_for = {"approve": G, "block": R, "bypass": Y, "cold_start": D, "dry_run": D}
    for line in recent:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        color = color_for.get(ev.get("outcome", ""), "")
        print(f"  {ev['ts']}  {color}{ev.get('outcome',''):<10}{X}  "
              f"{ev.get('tool',''):<6}  {ev.get('target','')[:70]}")
    return 0


def cmd_history(args):
    snaps = load_snapshots()
    if args.json:
        print(json.dumps(snaps, indent=2))
    else:
        for s in snaps:
            rq = s.get("rationale_quality", {})
            print(f"{s['ts']}  q={rq.get('quality_score')}  n={rq.get('count')}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Longitudinal Recall enforcement tracker")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("snapshot", help="record a snapshot of current metrics")
    p.add_argument("--window", type=int, default=7*86400, help="window seconds (default 7d)")
    p.set_defaults(func=cmd_snapshot)

    p = sub.add_parser("report", help="show latest snapshot + delta vs prior")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("trend", help="show one metric across all snapshots")
    p.add_argument("--metric", default="rationale_quality.quality_score",
                   help="dot-path into snapshot (e.g. rationale_quality.quality_score)")
    p.set_defaults(func=cmd_trend)

    p = sub.add_parser("events", help="show recent guard events")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("history", help="dump all snapshots")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_history)

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
