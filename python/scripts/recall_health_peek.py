#!/usr/bin/env python3
"""
recall_health_peek.py — Token-budget-aware graph-health summary.

Companion to `recall_peek.py`. Solves the same read-budget bottleneck for
the health/beliefs side: `recall beliefs` returns 57+ KB (111 contradictions
× ~500 chars each + stale list + critical warnings + provenance + stats),
forcing disk-dump + jq filtering when the full payload exceeds the LLM
token cap.

This tool calls `recall beliefs` once, parses the JSON, and reformats it
into a compact summary suitable for agent context:

- Stats line (one line, graph counts)
- Critical warnings (always shown in full — usually small and always
  load-bearing)
- Stale cells: count + top N by severity (titles + sev only)
- Contradictions: count by severity bucket + top N highest-severity
  (source/target titles only, not full bodies)
- Beliefs: count + top N
- Curiosity targets: count + top N
- Next actions: always shown in full

Default response: ~1-3 KB regardless of how many contradictions exist.
Measured against the 57 KB report observed earlier this session.

CLI:

    # Compact summary (default, human-readable):
    recall_health_peek.py

    # JSON structured output:
    recall_health_peek.py --format json

    # Drill into one section in full:
    recall_health_peek.py --section contradictions --limit 30

    # Filter contradictions by severity threshold:
    recall_health_peek.py --min-severity 0.85

    # Hard token-budget cap:
    recall_health_peek.py --max-tokens 1500
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import DEFAULT_DB  # noqa: E402


APPROX_CHARS_PER_TOKEN = 4
DEFAULT_MAX_ITEMS_PER_SECTION = 5


# ---- Fetch ----

def fetch_beliefs(db: str) -> dict:
    """Call `recall beliefs` and parse the JSON response."""
    result = subprocess.run(
        ["recall", "beliefs", "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"recall beliefs failed: {result.stderr or result.stdout[:300]}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"beliefs returned non-JSON: {e}")
    return payload.get("report", payload)


# ---- Compaction ----

def _severity_bucket(sev: float | None) -> str:
    if sev is None:
        return "unknown"
    if sev >= 0.85:
        return "high (≥0.85)"
    if sev >= 0.5:
        return "medium (0.5-0.85)"
    return "low (<0.5)"


def _trim_contradiction(c: dict) -> dict:
    return {
        "severity": c.get("severity"),
        "source": c.get("sourceTitle") or (c.get("source") or "")[:100],
        "target": c.get("targetTitle") or (c.get("target") or "")[:100],
    }


def _trim_stale(s: dict) -> dict:
    return {
        "id": s.get("id") or (s.get("nodeId") or "")[:8],
        "severity": s.get("severity"),
        "title": (s.get("title") or s.get("reason", ""))[:120],
    }


def compact_report(
    report: dict,
    *,
    max_items_per_section: int = DEFAULT_MAX_ITEMS_PER_SECTION,
    min_severity: float = 0.0,
) -> dict:
    """Produce a compact-but-actionable summary of the health report."""
    contradictions = report.get("contradictions", [])
    stale = report.get("stale", [])
    beliefs = report.get("beliefs", [])
    critical = report.get("criticalWarnings", [])
    curiosity = report.get("curiosityTargets", [])
    next_actions = report.get("nextActions", [])
    stats = report.get("stats", {})
    provenance = report.get("provenance", {})

    # Filter contradictions by severity
    contradictions_filtered = [
        c for c in contradictions
        if (c.get("severity") or 0) >= min_severity
    ]

    # Bucket counts
    contradiction_buckets: Counter = Counter()
    for c in contradictions:
        contradiction_buckets[_severity_bucket(c.get("severity"))] += 1

    # Sort by severity (highest first) and take top N
    contradictions_sorted = sorted(
        contradictions_filtered,
        key=lambda c: -(c.get("severity") or 0),
    )[:max_items_per_section]

    stale_sorted = sorted(
        stale, key=lambda s: -(s.get("severity") or 0),
    )[:max_items_per_section]

    return {
        "stats": stats,
        "provenance_summary": {
            "total_witnesses": provenance.get("totalWitnesses"),
            "signed_verified_ratio": provenance.get("signedVerifiedRatio"),
            "average_trust_multiplier": provenance.get("averageTrustMultiplier"),
            "unknown_origin_ratio": provenance.get("unknownOriginRatio"),
        },
        "critical_warnings": critical,  # always full
        "next_actions": next_actions,    # always full
        "contradictions": {
            "total": len(contradictions),
            "after_min_severity_filter": len(contradictions_filtered),
            "by_bucket": dict(contradiction_buckets),
            "top_by_severity": [_trim_contradiction(c) for c in contradictions_sorted],
            "more_count": max(0, len(contradictions_filtered) - max_items_per_section),
        },
        "stale": {
            "total": len(stale),
            "top_by_severity": [_trim_stale(s) for s in stale_sorted],
            "more_count": max(0, len(stale) - max_items_per_section),
        },
        "beliefs": {
            "total": len(beliefs),
            "sample": beliefs[:max_items_per_section] if beliefs else [],
        },
        "curiosity_targets": {
            "total": len(curiosity),
            "sample": curiosity[:max_items_per_section] if curiosity else [],
        },
        "createdAt": report.get("createdAt"),
    }


def compact_to_human(compact: dict) -> str:
    """Render the compact report as Markdown."""
    lines: list[str] = []
    lines.append(f"# Recall graph health summary")
    lines.append(f"_Report generated: {compact.get('createdAt', '?')}_")
    lines.append("")
    s = compact["stats"]
    lines.append(
        f"**Graph stats:** "
        f"{s.get('nodes', 0)} nodes · "
        f"{s.get('relations', 0)} relations · "
        f"{s.get('hyperedges', 0)} hyperedges · "
        f"{s.get('programs', 0)} programs · "
        f"{s.get('dagOverlays', 0)} dag overlays · "
        f"{s.get('evalRuns', 0)} eval runs"
    )
    p = compact["provenance_summary"]
    lines.append(
        f"**Provenance:** "
        f"{p.get('total_witnesses', 0)} witnesses · "
        f"signed-verified ratio {p.get('signed_verified_ratio', 0):.2f} · "
        f"avg trust {p.get('average_trust_multiplier', 0):.2f} · "
        f"unknown origin {p.get('unknown_origin_ratio', 0):.2f}"
    )
    lines.append("")

    # Critical warnings — always show all
    if compact["critical_warnings"]:
        lines.append("## ⚠ Critical warnings")
        for w in compact["critical_warnings"]:
            code = w.get("code", "?")
            sev = w.get("severity", "?")
            msg = w.get("message", "?")
            lines.append(f"- **[{sev}] {code}**: {msg}")
        lines.append("")

    # Next actions — always show all
    if compact["next_actions"]:
        lines.append("## → Next actions")
        for a in compact["next_actions"]:
            lines.append(f"- {a if isinstance(a, str) else a.get('text', a.get('action', '?'))}"[:300])
        lines.append("")

    # Contradictions
    cs = compact["contradictions"]
    if cs["total"] > 0:
        lines.append(f"## Contradictions ({cs['total']} total)")
        if cs["after_min_severity_filter"] != cs["total"]:
            lines.append(f"_Filtered: {cs['after_min_severity_filter']} above min-severity threshold._")
        bucket_line = " · ".join(f"{k}: {v}" for k, v in cs["by_bucket"].items())
        if bucket_line:
            lines.append(f"By severity: {bucket_line}")
        lines.append("")
        if cs["top_by_severity"]:
            lines.append("Top by severity:")
            for c in cs["top_by_severity"]:
                lines.append(
                    f"- [{c.get('severity', '?')}] "
                    f"{(c.get('source') or '?')[:80]} → "
                    f"{(c.get('target') or '?')[:80]}"
                )
            if cs["more_count"]:
                lines.append(f"- ... ({cs['more_count']} more — use --section contradictions for full list)")
        lines.append("")

    # Stale
    sl = compact["stale"]
    if sl["total"] > 0:
        lines.append(f"## Stale / low-trust cells ({sl['total']})")
        for s in sl["top_by_severity"]:
            lines.append(f"- [{s.get('severity', '?')}] `{s.get('id', '?')[:8]}` {s.get('title', '?')[:100]}")
        if sl["more_count"]:
            lines.append(f"- ... ({sl['more_count']} more)")
        lines.append("")

    # Beliefs
    b = compact["beliefs"]
    if b["total"] > 0:
        lines.append(f"## Active beliefs ({b['total']})")
        for item in b["sample"][:5]:
            if isinstance(item, dict):
                title = item.get("title") or item.get("statement", "")
                lines.append(f"- {title[:120]}")
            else:
                lines.append(f"- {str(item)[:120]}")
        lines.append("")

    # Curiosity targets
    ct = compact["curiosity_targets"]
    if ct["total"] > 0:
        lines.append(f"## Curiosity targets ({ct['total']})")
        for item in ct["sample"][:5]:
            if isinstance(item, dict):
                text = item.get("title") or item.get("question") or item.get("topic", "")
                lines.append(f"- {text[:120]}")
            else:
                lines.append(f"- {str(item)[:120]}")
        lines.append("")

    if not (compact["critical_warnings"] or compact["next_actions"]
            or cs["total"] or sl["total"] or b["total"] or ct["total"]):
        lines.append("_No outstanding health items._")

    return "\n".join(lines)


# ---- Section drill-down ----

def render_section(report: dict, section: str, limit: int) -> str:
    """Full render of one section (escape hatch when summary isn't enough)."""
    if section == "contradictions":
        items = report.get("contradictions", [])
        items_sorted = sorted(items, key=lambda c: -(c.get("severity") or 0))[:limit]
        return json.dumps(items_sorted, indent=2)
    if section == "stale":
        return json.dumps(report.get("stale", [])[:limit], indent=2)
    if section == "beliefs":
        return json.dumps(report.get("beliefs", [])[:limit], indent=2)
    if section == "curiosity":
        return json.dumps(report.get("curiosityTargets", [])[:limit], indent=2)
    if section == "next-actions":
        return json.dumps(report.get("nextActions", []), indent=2)
    if section == "critical":
        return json.dumps(report.get("criticalWarnings", []), indent=2)
    if section == "stats":
        return json.dumps({
            "stats": report.get("stats"),
            "provenance": report.get("provenance"),
        }, indent=2)
    raise ValueError(f"Unknown section: {section}")


# ---- Token budget ----

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def fit_to_budget(report: dict, max_tokens: int, *, as_human: bool = True,
                  min_severity: float = 0.0) -> str:
    """Iteratively shrink max_items per section until estimated tokens fit budget."""
    for items_cap in (DEFAULT_MAX_ITEMS_PER_SECTION, 3, 2, 1):
        compact = compact_report(report, max_items_per_section=items_cap,
                                 min_severity=min_severity)
        rendered = compact_to_human(compact) if as_human else json.dumps(compact, indent=2)
        if estimate_tokens(rendered) <= max_tokens:
            return rendered
    return rendered


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Compact graph-health summary for Recall (fixes the recall_beliefs read-budget bottleneck).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Compact human summary (default):\n"
            "  recall_health_peek.py\n\n"
            "  # JSON structured output:\n"
            "  recall_health_peek.py --format json\n\n"
            "  # Filter contradictions to high-severity only:\n"
            "  recall_health_peek.py --min-severity 0.85\n\n"
            "  # Full contradictions list (escape hatch):\n"
            "  recall_health_peek.py --section contradictions --limit 30\n\n"
            "  # Hard token-budget cap:\n"
            "  recall_health_peek.py --max-tokens 1500\n"
        ),
    )
    ap.add_argument("--section",
                    choices=("contradictions", "stale", "beliefs", "curiosity",
                             "next-actions", "critical", "stats"),
                    default=None,
                    help="Drill into one section in full (escape hatch).")
    ap.add_argument("--limit", type=int, default=20,
                    help="Item cap for --section drill-down. Default 20.")
    ap.add_argument("--min-severity", type=float, default=0.0,
                    help="Filter contradictions to severity ≥ this value. Default 0.")
    ap.add_argument("--max-items-per-section", type=int, default=DEFAULT_MAX_ITEMS_PER_SECTION,
                    help=f"Items shown per section in summary mode. Default {DEFAULT_MAX_ITEMS_PER_SECTION}.")
    ap.add_argument("--max-tokens", type=int, default=None,
                    help="Estimated token-budget cap (iteratively shrinks per-section items).")
    ap.add_argument("--format", choices=("human", "json"), default="human",
                    help="Output format. Default: human.")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DB path. Default: {DEFAULT_DB}")
    args = ap.parse_args()

    try:
        report = fetch_beliefs(args.db)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    # Section drill-down mode
    if args.section:
        try:
            print(render_section(report, args.section, args.limit))
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        return 0

    # Token-budget mode
    if args.max_tokens:
        print(fit_to_budget(report, args.max_tokens,
                            as_human=(args.format == "human"),
                            min_severity=args.min_severity))
        return 0

    # Default: compact summary
    compact = compact_report(
        report,
        max_items_per_section=args.max_items_per_section,
        min_severity=args.min_severity,
    )
    if args.format == "human":
        print(compact_to_human(compact))
    else:
        print(json.dumps(compact, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
