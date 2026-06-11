#!/usr/bin/env python3
"""
recall_diff.py — Diff-aware compile / "what changed since" query for Recall.

Closes the gap where existing tools (`recall_compile`, `recall_search`,
`recall_subgraph`) all answer "what is" questions but none cleanly answer
"what changed". Agents resuming work need this: "what's been added to
project X since I left two hours ago / since cell C was written".

What it returns:

- **new_cells**: cells created since the threshold timestamp
- **updated_cells**: cells whose `updatedAt > createdAt` AND `updatedAt > threshold`
- **new_hyperedges**: hyperedges (typed graph edges) created since threshold
- **supersede_events**: subset of new_hyperedges with kind `code-superseded-by`
  (or any `*superseded*` kind) — surfaced separately because they represent
  retractions / replacements, not additions

Operates by querying the existing Recall CLI verbs (`recall subgraph`,
`recall hyperedge list`) and post-filtering by timestamp. No new core
schema or storage required.

Usage:

    # Everything across the whole graph since 1 day ago (JSON):
    recall_diff.py --since 1d

    # Activity in one project since a specific cell was written:
    recall_diff.py --since-cell abc12345 --project my-project

    # Human-readable summary for agent context at session start:
    recall_diff.py --project my-repo --since 2h --summary

    # Code-only filter (skips non-code cells):
    recall_diff.py --project my-repo --since 1d --code-only --summary

Timestamp inputs accepted by `--since`:

- ISO-8601: `2026-05-24T18:00:00Z` (any timezone)
- Relative shorthand: `Nh` / `Nd` / `Nw` / `Nm` (hours, days, weeks, minutes)
  e.g., `2h`, `30m`, `7d`, `4w`

If you pass `--since-cell <id-or-prefix>`, the tool looks up that cell's
`createdAt` and uses it as the threshold.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import DEFAULT_DB  # noqa: E402


# ---- Timestamp parsing ----

RELATIVE_PAT = re.compile(r"^(\d+)\s*([mhdw])$", re.IGNORECASE)


def parse_since(since: str) -> dt.datetime:
    """Parse `--since` argument into a UTC datetime.

    Accepts ISO-8601 (any timezone, auto-converted to UTC) or relative
    shorthand: 30m, 2h, 7d, 4w. Returns aware UTC datetime.
    """
    m = RELATIVE_PAT.match(since.strip())
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        deltas = {
            "m": dt.timedelta(minutes=n),
            "h": dt.timedelta(hours=n),
            "d": dt.timedelta(days=n),
            "w": dt.timedelta(weeks=n),
        }
        return dt.datetime.now(dt.timezone.utc) - deltas[unit]
    # ISO-8601
    s = since.strip()
    # Python's fromisoformat in 3.11+ accepts 'Z'; earlier versions need replacement
    s = s.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(s)
    except ValueError as e:
        raise ValueError(f"Cannot parse --since {since!r} as ISO-8601 or relative: {e}")
    if parsed.tzinfo is None:
        # Naive → assume UTC
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def to_aware_utc(ts_str: str) -> dt.datetime | None:
    """Parse a Recall-emitted ISO-8601 timestamp string into aware UTC datetime."""
    if not ts_str:
        return None
    try:
        s = ts_str.replace("Z", "+00:00")
        parsed = dt.datetime.fromisoformat(s)
    except (ValueError, AttributeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


# ---- Recall queries ----

def fetch_cells_for_project(project: str | None, db: str,
                            category: str | None = None) -> list[dict]:
    """Query Recall for cells, optionally filtered by project and/or category."""
    cmd = ["recall", "subgraph", "--db", db]
    if project:
        cmd.extend(["--project", project])
    if category:
        cmd.extend(["--category", category])
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"recall subgraph failed: {result.stderr or result.stdout[:300]}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"subgraph returned non-JSON: {e}")
    return payload.get("results", [])


def fetch_all_cells(db: str) -> list[dict]:
    """Best-effort query for all cells in the DB. Uses no-project subgraph."""
    return fetch_cells_for_project(None, db)


def fetch_hyperedges(db: str, limit: int = 10000) -> list[dict]:
    """List hyperedges up to limit."""
    result = subprocess.run(
        ["recall", "hyperedge", "list", "--limit", str(limit), "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return []
    try:
        return json.loads(result.stdout).get("hyperedges", [])
    except json.JSONDecodeError:
        return []


def fetch_cell_by_id_prefix(prefix: str, db: str) -> dict | None:
    """Look up a cell by id prefix (8+ hex chars). Walks all cells."""
    cells = fetch_all_cells(db)
    matches = [c for c in cells if c.get("id", "").startswith(prefix)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"Cell id prefix {prefix!r} is ambiguous; matches {len(matches)} cells")
    # Try cell show as fallback (in case prefix was longer than 8 chars)
    result = subprocess.run(
        ["recall", "cell", "show", prefix, "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode == 0:
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return None
    return None


# ---- Diff computation ----

@dataclass
class DiffResult:
    since: dt.datetime
    project: str | None
    new_cells: list[dict] = field(default_factory=list)
    updated_cells: list[dict] = field(default_factory=list)
    new_hyperedges: list[dict] = field(default_factory=list)
    supersede_events: list[dict] = field(default_factory=list)


def compute_diff(
    *,
    since: dt.datetime,
    db: str,
    project: str | None = None,
    code_only: bool = False,
    include_hyperedges: bool = True,
    include_supersedes: bool = True,
    kinds_filter: set[str] | None = None,
) -> DiffResult:
    """Compute the diff: cells/hyperedges created or updated since `since`."""
    # Cells
    cells = fetch_cells_for_project(
        project, db, category="code" if code_only else None
    )

    new_cells: list[dict] = []
    updated_cells: list[dict] = []
    for c in cells:
        created = to_aware_utc(c.get("createdAt"))
        updated = to_aware_utc(c.get("updatedAt")) or created
        if created and created >= since:
            if kinds_filter is None or c.get("kind") in kinds_filter:
                new_cells.append(c)
        elif updated and updated >= since:
            # Updated but not newly created
            if kinds_filter is None or c.get("kind") in kinds_filter:
                updated_cells.append(c)

    # Hyperedges
    new_hyperedges: list[dict] = []
    supersede_events: list[dict] = []
    if include_hyperedges or include_supersedes:
        hes = fetch_hyperedges(db)
        # If project filter set, only include hyperedges whose members are
        # cells in this project. We have the cell IDs from above as a proxy.
        if project:
            project_cell_ids = {c["id"] for c in cells}
            hes = [
                he for he in hes
                if any(m.get("nodeId") in project_cell_ids
                       for m in he.get("members", []))
            ]
        for he in hes:
            created = to_aware_utc(he.get("createdAt"))
            if not created or created < since:
                continue
            is_supersede = "supersede" in he.get("kind", "").lower()
            if is_supersede:
                if include_supersedes:
                    supersede_events.append(he)
            elif include_hyperedges:
                new_hyperedges.append(he)

    return DiffResult(
        since=since, project=project,
        new_cells=new_cells,
        updated_cells=updated_cells,
        new_hyperedges=new_hyperedges,
        supersede_events=supersede_events,
    )


# ---- Output formats ----

def to_json(diff: DiffResult) -> dict:
    """Serialize diff to a structured JSON dict."""
    def _trim(cell: dict) -> dict:
        return {
            "id": cell.get("id"),
            "cellAddress": cell.get("cellAddress"),
            "kind": cell.get("kind"),
            "title": cell.get("title"),
            "scope": cell.get("scope"),
            "tags": {
                "topics": cell.get("tags", {}).get("topics", []),
                "lifecycle": cell.get("tags", {}).get("lifecycle", []),
                "category": cell.get("tags", {}).get("category", []),
            },
            "createdAt": cell.get("createdAt"),
            "updatedAt": cell.get("updatedAt"),
        }

    def _trim_he(he: dict) -> dict:
        return {
            "id": he.get("id"),
            "kind": he.get("kind"),
            "title": he.get("title"),
            "members": [
                {"nodeId": m.get("nodeId"), "role": m.get("role")}
                for m in he.get("members", [])
            ],
            "createdAt": he.get("createdAt"),
        }

    return {
        "since": diff.since.isoformat(),
        "project": diff.project,
        "summary": {
            "new_cells": len(diff.new_cells),
            "updated_cells": len(diff.updated_cells),
            "new_hyperedges": len(diff.new_hyperedges),
            "supersede_events": len(diff.supersede_events),
        },
        "new_cells": [_trim(c) for c in diff.new_cells],
        "updated_cells": [_trim(c) for c in diff.updated_cells],
        "new_hyperedges": [_trim_he(h) for h in diff.new_hyperedges],
        "supersede_events": [_trim_he(h) for h in diff.supersede_events],
    }


def to_summary(diff: DiffResult, *, max_items: int = 12) -> str:
    """Render a human-readable markdown summary suitable for agent context."""
    lines: list[str] = []
    scope = f" in project `{diff.project}`" if diff.project else " (graph-wide)"
    lines.append(f"# Recall diff{scope} since {diff.since.isoformat()}")
    lines.append("")
    lines.append(
        f"**Summary:** {len(diff.new_cells)} new cells · "
        f"{len(diff.updated_cells)} updated · "
        f"{len(diff.new_hyperedges)} new edges · "
        f"{len(diff.supersede_events)} supersede events"
    )
    lines.append("")

    if diff.new_cells:
        lines.append(f"## New cells ({len(diff.new_cells)})")
        by_kind = Counter(c.get("kind", "?") for c in diff.new_cells)
        lines.append("By kind: " + ", ".join(f"{k}={v}" for k, v in by_kind.most_common()))
        lines.append("")
        for c in diff.new_cells[:max_items]:
            lifecycle = c.get("tags", {}).get("lifecycle", [])
            lc_marker = " [test]" if "test" in lifecycle else ""
            lines.append(f"- `{c.get('id', '?')[:8]}` [{c.get('kind', '?')}]{lc_marker} {c.get('title', '?')[:100]}")
        if len(diff.new_cells) > max_items:
            lines.append(f"- ... ({len(diff.new_cells) - max_items} more)")
        lines.append("")

    if diff.updated_cells:
        lines.append(f"## Updated cells ({len(diff.updated_cells)})")
        for c in diff.updated_cells[:max_items]:
            lines.append(f"- `{c.get('id', '?')[:8]}` [{c.get('kind', '?')}] {c.get('title', '?')[:100]}")
        if len(diff.updated_cells) > max_items:
            lines.append(f"- ... ({len(diff.updated_cells) - max_items} more)")
        lines.append("")

    if diff.supersede_events:
        lines.append(f"## Supersede events ({len(diff.supersede_events)})")
        lines.append("(Old cells replaced by new ones — supersede edges added)")
        for he in diff.supersede_events[:max_items]:
            members = he.get("members", [])
            if len(members) >= 2:
                old = members[0].get("nodeId", "?")[:8]
                new = members[1].get("nodeId", "?")[:8]
                lines.append(f"- `{old}` → `{new}` ({he.get('kind', '?')}) — {he.get('title', '?')[:80]}")
        if len(diff.supersede_events) > max_items:
            lines.append(f"- ... ({len(diff.supersede_events) - max_items} more)")
        lines.append("")

    if diff.new_hyperedges:
        lines.append(f"## New hyperedges ({len(diff.new_hyperedges)})")
        by_kind = Counter(he.get("kind", "?") for he in diff.new_hyperedges)
        lines.append("By kind: " + ", ".join(f"{k}={v}" for k, v in by_kind.most_common()))
        if len(diff.new_hyperedges) > 0:
            lines.append("")
            for he in diff.new_hyperedges[:max_items]:
                members = he.get("members", [])
                if len(members) >= 2:
                    s = members[0]
                    t = members[1]
                    lines.append(
                        f"- [{he.get('kind', '?')}] "
                        f"`{s.get('nodeId', '?')[:8]}`({s.get('role', '?')}) → "
                        f"`{t.get('nodeId', '?')[:8]}`({t.get('role', '?')})"
                    )
            if len(diff.new_hyperedges) > max_items:
                lines.append(f"- ... ({len(diff.new_hyperedges) - max_items} more)")
        lines.append("")

    if not (diff.new_cells or diff.updated_cells or diff.new_hyperedges or diff.supersede_events):
        lines.append("_No activity in this window._")

    return "\n".join(lines)


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Diff-aware compile: what changed in the Recall graph since a timestamp or cell.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Timestamp formats for --since:\n"
            "  ISO-8601: 2026-05-24T18:00:00Z\n"
            "  Relative: 30m, 2h, 7d, 4w (minutes/hours/days/weeks ago)\n\n"
            "Examples:\n"
            "  # JSON: everything that changed in the last day:\n"
            "  recall_diff.py --since 1d\n\n"
            "  # Human-readable summary scoped to one project:\n"
            "  recall_diff.py --project my-repo --since 2h --summary\n\n"
            "  # What's changed since a specific cell was written:\n"
            "  recall_diff.py --since-cell 569d3e16 --summary\n\n"
            "  # Code cells only:\n"
            "  recall_diff.py --project my-repo --since 1w --code-only --summary\n"
        ),
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--since", help="Threshold timestamp: ISO-8601 or relative shorthand.")
    src.add_argument("--since-cell", metavar="CELL_ID",
                     help="Use this cell's createdAt as the threshold. 8+ char prefix OK.")

    ap.add_argument("--project", default=None, help="Filter to a specific project.")
    ap.add_argument("--code-only", action="store_true",
                    help="Filter to cells with category=code.")
    ap.add_argument("--kinds", default=None,
                    help="Comma-separated cell kinds to include (filter).")
    ap.add_argument("--no-hyperedges", action="store_true",
                    help="Skip non-supersede hyperedges in output.")
    ap.add_argument("--no-supersedes", action="store_true",
                    help="Skip supersede-event hyperedges in output.")
    ap.add_argument("--summary", action="store_true",
                    help="Emit a human-readable markdown summary instead of JSON.")
    ap.add_argument("--max-items", type=int, default=12,
                    help="Max items per section in --summary mode (default 12).")
    ap.add_argument("--out", default="-",
                    help="Output path. '-' = stdout (default).")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"Recall DB path. Default: {DEFAULT_DB}")
    args = ap.parse_args()

    # Resolve threshold
    try:
        if args.since:
            since = parse_since(args.since)
        else:
            cell = fetch_cell_by_id_prefix(args.since_cell, args.db)
            if not cell:
                print(f"ERROR: no cell matching {args.since_cell!r}", file=sys.stderr)
                return 2
            ts = to_aware_utc(cell.get("createdAt"))
            if not ts:
                print(f"ERROR: cell {args.since_cell!r} has no createdAt", file=sys.stderr)
                return 2
            since = ts
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    kinds_filter: set[str] | None = None
    if args.kinds:
        kinds_filter = {k.strip() for k in args.kinds.split(",") if k.strip()}

    # Compute diff
    try:
        diff = compute_diff(
            since=since,
            db=args.db,
            project=args.project,
            code_only=args.code_only,
            include_hyperedges=not args.no_hyperedges,
            include_supersedes=not args.no_supersedes,
            kinds_filter=kinds_filter,
        )
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    # Output
    out_text = (
        to_summary(diff, max_items=args.max_items) if args.summary
        else json.dumps(to_json(diff), indent=2)
    )

    if args.out == "-":
        print(out_text)
    else:
        Path(args.out).write_text(out_text + "\n")

    # Brief stats to stderr always
    print(
        f"recall_diff: {len(diff.new_cells)} new, "
        f"{len(diff.updated_cells)} updated, "
        f"{len(diff.new_hyperedges)} new edges, "
        f"{len(diff.supersede_events)} supersedes "
        f"(since {since.isoformat()})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
