#!/usr/bin/env python3
"""Token-budget-aware cell summary for Recall, reading the v5 cells schema.

Reads SQLite directly (read-only) for column-level control over what gets
loaded. The cell envelope (key, handle, kind, title, status, scores) is
always small; only the body can be huge. This tool returns the envelope plus
a configurable body excerpt, relation counts by relation name, and hyperedge
membership counts, without loading the full body into the response.

Use cases:

- Triage: "what is cell X?" without committing to its full body
- Resolution: "is this cell active or superseded?"
- Audit: "how connected is this cell?" (incoming/outgoing relation counts)
- Find: "show me cells matching this substring" (--match mode)

CLI:

    # Summary of a cell (default body excerpt 800 chars):
    recall_peek.py 4ae7579e

    # Handles resolve as well as key prefixes:
    recall_peek.py obs_4ae7

    # Just the title (cheapest possible probe):
    recall_peek.py 4ae7579e --field title

    # Full body (opt-in, no truncation):
    recall_peek.py 4ae7579e --field body --no-truncate

    # All cells matching a title or body substring:
    recall_peek.py --match "peek" --kind obs --limit 5

    # Token-aware: cap the response to ~N tokens (estimated):
    recall_peek.py 4ae7579e --max-tokens 2000

    # JSON output (default) vs human-readable:
    recall_peek.py 4ae7579e --format human

DB resolution: --db wins, else RECALL_DB, else $RECALL_HOME/db/home.sqlite3,
else ~/.recall/db/home.sqlite3. Routing beyond that belongs to the CLI.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from urllib.parse import quote

DEFAULT_BODY_EXCERPT_CHARS = 800
APPROX_CHARS_PER_TOKEN = 4  # rough heuristic for token-budget mode

# Legacy column names still accepted by --field, mapped to v5 cell JSON fields.
FIELD_ALIASES = {
    "id": "key",
    "cell_address": "handle",
    "created_at": "createdAt",
    "updated_at": "updatedAt",
    "scope_json": "scope",
    "tags_json": "tags",
    "provenance_json": "provenance",
}


def default_db() -> str:
    env_db = os.environ.get("RECALL_DB", "").strip()
    if env_db:
        return env_db
    recall_home = os.environ.get("RECALL_HOME", "").strip()
    if recall_home:
        return os.path.join(recall_home, "db", "home.sqlite3")
    return os.path.expanduser("~/.recall/db/home.sqlite3")


# ---- DB queries ----

def _open_db(db: str) -> sqlite3.Connection:
    """Open the Recall DB read-only. This tool never writes."""
    uri = f"file:{quote(os.path.abspath(db))}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def resolve_cell_key(conn: sqlite3.Connection, target: str) -> str | None:
    """Resolve a full key, a handle, or a key prefix to a full cell key.

    Store keys carry no graph qualifier, but federated surfaces (the diff
    summary, the mini-index) hand back ids like home:1c7fdd22; a target with
    colons retries on its last segment so those ids resolve here too.

    Returns None when nothing matches; raises ValueError on an ambiguous prefix.
    """
    row = conn.execute("SELECT key FROM cells WHERE key = ?", (target,)).fetchone()
    if row:
        return row["key"]
    row = conn.execute("SELECT key FROM cells WHERE handle = ?", (target,)).fetchone()
    if row:
        return row["key"]
    rows = conn.execute(
        "SELECT key FROM cells WHERE key LIKE ? OR replace(key, '-', '') LIKE ? LIMIT 5",
        (target + "%", target + "%"),
    ).fetchall()
    if len(rows) == 1:
        return rows[0]["key"]
    if len(rows) > 1:
        raise ValueError(f"Prefix {target!r} matches {len(rows)} cells; need more chars")
    if ":" in target:
        bare = target.rsplit(":", 1)[-1].strip()
        if bare:
            return resolve_cell_key(conn, bare)
    return None


def fetch_cell(conn: sqlite3.Connection, key: str) -> dict | None:
    """Load the cell JSON blob for a full key."""
    row = conn.execute("SELECT json FROM cells WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    try:
        cell = json.loads(row["json"])
    except (json.JSONDecodeError, TypeError):
        return None
    return cell if isinstance(cell, dict) else None


def fetch_relation_counts(conn: sqlite3.Connection, key: str, handle: str | None = None) -> dict:
    """Return counts of incoming/outgoing edges grouped by relation name."""
    out: dict[str, dict[str, int]] = {"outgoing": {}, "incoming": {}}
    rows = conn.execute(
        "SELECT relation, COUNT(*) AS c FROM edges WHERE source = ? GROUP BY relation",
        (key,),
    ).fetchall()
    out["outgoing"] = {r["relation"]: r["c"] for r in rows}
    # Incoming edges may target the key or, on older writes, the handle.
    targets = [key] + ([handle] if handle else [])
    placeholders = ", ".join("?" for _ in targets)
    rows = conn.execute(
        f"SELECT relation, COUNT(*) AS c FROM edges WHERE target IN ({placeholders}) GROUP BY relation",
        targets,
    ).fetchall()
    out["incoming"] = {r["relation"]: r["c"] for r in rows}
    return out


def fetch_hyperedge_membership(conn: sqlite3.Connection, key: str) -> dict:
    """Return counts of hyperedge memberships by hyperedge kind + member role.

    Uses JSON1's json_each to walk members_json arrays. Member entries may be
    rich objects keyed by "key", legacy objects keyed by "nodeId", or bare
    key strings; all three shapes count.
    """
    counts: dict[str, dict[str, int]] = {}
    rows = conn.execute(
        """
        SELECT h.kind AS he_kind,
               CASE WHEN m.type = 'object'
                    THEN COALESCE(json_extract(m.value, '$.role'), 'member')
                    ELSE 'member' END AS role
        FROM hyperedges h, json_each(h.members_json) m
        WHERE (CASE WHEN m.type = 'object'
                    THEN COALESCE(json_extract(m.value, '$.key'),
                                  json_extract(m.value, '$.nodeId'))
                    ELSE m.value END) = ?
        """,
        (key,),
    ).fetchall()
    for r in rows:
        kind = r["he_kind"]
        role = r["role"] or "member"
        counts.setdefault(kind, {}).setdefault(role, 0)
        counts[kind][role] += 1
    return counts


def search_cells(conn: sqlite3.Connection, *, match: str | None = None,
                 kind: str | None = None, project: str | None = None,
                 limit: int = 20) -> list[dict]:
    """List cells by title/body substring plus optional kind/project filters."""
    where_clauses: list[str] = []
    params: list = []
    if match:
        where_clauses.append(
            "(json_extract(json, '$.title') LIKE ? OR json_extract(json, '$.body') LIKE ?)"
        )
        params.extend([f"%{match}%", f"%{match}%"])
    if kind:
        where_clauses.append("kind = ?")
        params.append(kind)
    if project:
        where_clauses.append("json_extract(json, '$.scope.project') = ?")
        params.append(project)
    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT key, handle, kind, status,
               json_extract(json, '$.title') AS title,
               length(json_extract(json, '$.body')) AS body_length,
               substr(json_extract(json, '$.body'), 1, 200) AS body_preview,
               json_extract(json, '$.createdAt') AS created_at,
               json_extract(json, '$.updatedAt') AS updated_at
        FROM cells
        WHERE {where_sql}
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


# ---- Output formatting ----

def cell_to_summary_dict(cell: dict, *, relations: dict, hyperedges: dict,
                         excerpt_chars: int) -> dict:
    """Build the structured summary response from the v5 cell JSON."""
    body = str(cell.get("body") or "")
    excerpt = body[:max(0, excerpt_chars)]
    scope = cell.get("scope") or {}
    tags = cell.get("tags") or {}
    provenance = cell.get("provenance") or {}
    return {
        "key": cell.get("key"),
        "handle": cell.get("handle"),
        "kind": cell.get("kind"),
        "title": cell.get("title"),
        "status": cell.get("status"),
        "scope": {
            "project": scope.get("project"),
            "tenant": scope.get("tenant"),
        },
        "scores": cell.get("scores") or {},
        "tags_summary": {
            "topics": (tags.get("topics") or [])[:8],
            "lifecycle": tags.get("lifecycle") or [],
            "entities_count": len(tags.get("entities") or []),
            "entities_sample": (tags.get("entities") or [])[:6],
        },
        "provenance": {
            "origin": provenance.get("origin"),
            "produced_by": provenance.get("producedBy"),
            "verification": provenance.get("verification"),
        },
        "body": {
            "excerpt": excerpt,
            "full_length": len(body),
            "truncated": len(body) > len(excerpt),
        },
        "summary_field": cell.get("summary"),
        "relations": {
            "outgoing_count": sum(relations.get("outgoing", {}).values()),
            "outgoing_by_relation": relations.get("outgoing", {}),
            "incoming_count": sum(relations.get("incoming", {}).values()),
            "incoming_by_relation": relations.get("incoming", {}),
        },
        "hyperedge_memberships": hyperedges,
        "timestamps": {
            "createdAt": cell.get("createdAt"),
            "updatedAt": cell.get("updatedAt"),
        },
    }


def summary_to_human(summary: dict) -> str:
    """Render a structured summary as compact human-readable text."""
    lines: list[str] = []
    lines.append(f"# {summary['title']}")
    lines.append("")
    lines.append(f"**key:** `{summary['key']}`  **handle:** `{summary['handle']}`")
    lines.append(f"**kind:** {summary['kind']}  **status:** {summary['status']}")
    sc = summary["scope"]
    lines.append(f"**scope:** project={sc.get('project')} tenant={sc.get('tenant')}")
    scores = summary.get("scores") or {}
    lines.append(
        "**scores:** conf={} effective={} uncertainty={} concern={}".format(
            scores.get("conf"), scores.get("effective"),
            scores.get("uncertainty"), scores.get("concern"),
        )
    )
    tags = summary["tags_summary"]
    if tags.get("topics"):
        lines.append(f"**topics:** {', '.join(map(str, tags['topics']))}")
    if tags.get("lifecycle"):
        lines.append(f"**lifecycle:** {', '.join(map(str, tags['lifecycle']))}")
    if tags.get("entities_count"):
        sample = ", ".join(map(str, tags.get("entities_sample", [])))
        lines.append(f"**entities:** {tags['entities_count']} total ({sample})")
    pv = summary["provenance"]
    lines.append(
        f"**provenance:** {pv.get('produced_by')} / {pv.get('origin')} / {pv.get('verification')}"
    )
    ts = summary["timestamps"]
    lines.append(f"**created:** {ts.get('createdAt')}  **updated:** {ts.get('updatedAt')}")
    if summary.get("summary_field"):
        lines.append(f"**summary:** {summary['summary_field']}")
    lines.append("")
    body = summary["body"]
    lines.append(
        f"## Body ({body['full_length']} chars total, "
        f"{'truncated' if body['truncated'] else 'full'})"
    )
    lines.append("")
    lines.append(body["excerpt"])
    if body["truncated"]:
        lines.append("")
        lines.append(
            f"... [{body['full_length'] - len(body['excerpt'])} more chars; "
            "use --field body --no-truncate]"
        )
    lines.append("")
    rel = summary["relations"]
    lines.append(f"## Relations (out={rel['outgoing_count']}, in={rel['incoming_count']})")
    if rel["outgoing_by_relation"]:
        lines.append("Outgoing: " + ", ".join(f"{k}={v}" for k, v in rel["outgoing_by_relation"].items()))
    if rel["incoming_by_relation"]:
        lines.append("Incoming: " + ", ".join(f"{k}={v}" for k, v in rel["incoming_by_relation"].items()))
    if summary["hyperedge_memberships"]:
        lines.append("")
        lines.append("## Hyperedge memberships")
        for kind, by_role in summary["hyperedge_memberships"].items():
            roles = ", ".join(f"{r}x{n}" for r, n in by_role.items())
            lines.append(f"- {kind}: {roles}")
    return "\n".join(lines)


def match_results_to_human(match: str, results: list[dict]) -> str:
    lines = [f"# {len(results)} cells matching {match!r}"]
    for r in results:
        title = str(r.get("title") or "(untitled)")
        preview = str(r.get("body_preview") or "")
        lines.append("")
        lines.append(f"## {title[:120]}")
        lines.append(
            f"  key: `{r['key']}`  handle: `{r['handle']}`  kind: {r['kind']}  "
            f"status: {r['status']}  body: {r['body_length'] or 0} chars"
        )
        lines.append(f"  preview: {preview[:200].strip()}")
    return "\n".join(lines)


# ---- Token-budget mode ----

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def fit_to_budget(summary: dict, max_tokens: int, *, as_human: bool = False) -> str:
    """Iteratively shrink the body excerpt until estimated tokens fit the budget."""
    body_chars = len(summary["body"]["excerpt"])
    while body_chars > 100:
        rendered = (summary_to_human(summary) if as_human
                    else json.dumps(summary, indent=2))
        if estimate_tokens(rendered) <= max_tokens:
            return rendered
        body_chars = int(body_chars * 0.7)
        summary["body"]["excerpt"] = summary["body"]["excerpt"][:body_chars] + "...[shrunk for budget]"
        summary["body"]["truncated"] = True
    return summary_to_human(summary) if as_human else json.dumps(summary, indent=2)


# ---- CLI ----

def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Token-budget-aware cell summary for Recall (v5 cells schema).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Summary of a cell:\n"
            "  recall_peek.py 4ae7579e\n\n"
            "  # Just the title (cheapest probe):\n"
            "  recall_peek.py 4ae7579e --field title\n\n"
            "  # Find cells matching a keyword:\n"
            "  recall_peek.py --match \"peek\" --kind obs --limit 5\n\n"
            "  # Token-budget cap:\n"
            "  recall_peek.py 4ae7579e --max-tokens 2000 --format human\n"
        ),
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("cell", nargs="?", help="Cell key, handle, or 8+ char key prefix.")
    src.add_argument("--match", help="Search by title or body substring.")

    ap.add_argument("--field", default=None,
                    help="Return only one field (title, body, summary, tags, scores, etc.).")
    ap.add_argument("--no-truncate", action="store_true",
                    help="Don't truncate body (use with --field body for full content).")
    ap.add_argument("--excerpt-chars", type=int, default=DEFAULT_BODY_EXCERPT_CHARS,
                    help=f"Max body excerpt chars in summary mode (default {DEFAULT_BODY_EXCERPT_CHARS}).")
    ap.add_argument("--max-tokens", type=int, default=None,
                    help="Estimated token budget for the response (shrinks body excerpt to fit).")
    ap.add_argument("--format", choices=("json", "human"), default="json",
                    help="Output format. Default: json.")
    ap.add_argument("--kind", default=None, help="Filter --match by cell kind.")
    ap.add_argument("--project", default=None, help="Filter --match by project name.")
    ap.add_argument("--limit", type=int, default=20, help="Result cap for --match. Default 20.")
    ap.add_argument("--db", default=None,
                    help="DB path. Default: RECALL_DB, else RECALL_HOME/db/home.sqlite3, "
                         "else ~/.recall/db/home.sqlite3.")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    db = args.db or default_db()

    try:
        conn = _open_db(db)
    except sqlite3.Error as e:
        print(f"ERROR: cannot open DB {db}: {e}", file=sys.stderr)
        return 2

    try:
        # --match mode: return a list of matching cells
        if args.match:
            try:
                results = search_cells(
                    conn, match=args.match, kind=args.kind,
                    project=args.project, limit=args.limit,
                )
            except sqlite3.Error as e:
                print(f"ERROR: query failed: {e}", file=sys.stderr)
                return 2
            if args.format == "human":
                print(match_results_to_human(args.match, results))
            else:
                print(json.dumps({"match": args.match, "results": results}, indent=2))
            return 0

        # Single-cell mode
        try:
            key = resolve_cell_key(conn, args.cell)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        except sqlite3.Error as e:
            print(f"ERROR: query failed: {e}", file=sys.stderr)
            return 2
        if not key:
            print(f"ERROR: no cell matching {args.cell!r}", file=sys.stderr)
            return 2

        cell = fetch_cell(conn, key)
        if not cell:
            print(f"ERROR: cell {key} not found", file=sys.stderr)
            return 2

        # --field mode: return only one field, raw
        if args.field:
            field = FIELD_ALIASES.get(args.field, args.field)
            if field not in cell:
                print(f"ERROR: no field {args.field!r} on cell {key}", file=sys.stderr)
                return 2
            value = cell[field]
            if field == "body" and isinstance(value, str) and not args.no_truncate:
                value = value[:args.excerpt_chars]
            sys.stdout.write(value if isinstance(value, str) else json.dumps(value, indent=2))
            sys.stdout.write("\n")
            return 0

        # Summary mode: envelope + body excerpt + relation counts
        relations = fetch_relation_counts(conn, key, cell.get("handle"))
        try:
            hyperedges = fetch_hyperedge_membership(conn, key)
        except sqlite3.OperationalError:
            # JSON1 functions unavailable: skip hyperedge membership
            hyperedges = {}

        summary = cell_to_summary_dict(
            cell, relations=relations, hyperedges=hyperedges,
            excerpt_chars=args.excerpt_chars,
        )

        if args.max_tokens:
            print(fit_to_budget(summary, args.max_tokens, as_human=(args.format == "human")))
        elif args.format == "human":
            print(summary_to_human(summary))
        else:
            print(json.dumps(summary, indent=2))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
