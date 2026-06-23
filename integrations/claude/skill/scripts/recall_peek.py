#!/usr/bin/env python3
"""
recall_peek.py — Token-budget-aware cell summary for Recall.

Solves the read-budget bottleneck where `recall_cell` / `recall_beliefs`
return responses too large for an LLM context window (observed:
85 KB cell expansion, 57 KB beliefs report, both forcing jq-filtering
of disk dumps).

Reads SQLite directly (read-only) for column-level control over what
gets loaded. The cell envelope (title, kind, scope, tags, lifecycle,
confidence) is always small; only the body is huge. This tool returns
the envelope + a configurable body excerpt + relation counts +
hyperedge counts, without ever loading the full body into the response.

Use cases:

- Triage: "what is cell X?" without committing to fetching its full body
- Resolution: "is this cell active or superseded?" (lifecycle + outgoing
  code-superseded-by edges visible)
- Audit: "how connected is this cell?" (incoming/outgoing relation counts)
- Find: "show me cells matching this prefix" (`--match` mode)

CLI:

    # Summary of a cell (default body excerpt 800 chars):
    recall_peek.py 4ae7579e

    # Just the title (cheapest possible probe):
    recall_peek.py 4ae7579e --field title

    # Full body (opt-in, no truncation):
    recall_peek.py 4ae7579e --field body --no-truncate

    # All cells matching a title-prefix or body-keyword:
    recall_peek.py --match "L7" --kind lemma --limit 5

    # Token-aware: cap response to ~N tokens (estimated):
    recall_peek.py 4ae7579e --max-tokens 2000

    # JSON output (default) vs human-readable:
    recall_peek.py 4ae7579e --format human
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import DEFAULT_DB  # noqa: E402


DEFAULT_BODY_EXCERPT_CHARS = 800
APPROX_CHARS_PER_TOKEN = 4  # rough heuristic for token-budget mode


# ---- DB queries ----

def _open_db(db: str) -> sqlite3.Connection:
    """Open the Recall DB read-only."""
    uri = f"file:{db}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def resolve_cell_id(conn: sqlite3.Connection, id_or_prefix: str) -> str | None:
    """Resolve an 8+ char prefix to a full cell ID. Returns None if ambiguous or no match."""
    if len(id_or_prefix) == 36 and id_or_prefix.count("-") == 4:
        # Full UUID
        row = conn.execute("SELECT id FROM graph_nodes WHERE id = ?", (id_or_prefix,)).fetchone()
        return row["id"] if row else None
    rows = conn.execute(
        "SELECT id FROM graph_nodes WHERE id LIKE ? LIMIT 5",
        (id_or_prefix + "%",),
    ).fetchall()
    if len(rows) == 1:
        return rows[0]["id"]
    if len(rows) > 1:
        raise ValueError(f"Prefix {id_or_prefix!r} matches {len(rows)} cells; need more chars")
    return None


def fetch_cell_envelope(conn: sqlite3.Connection, cell_id: str,
                       body_excerpt_chars: int) -> dict | None:
    """Fetch cell envelope + body excerpt. Returns dict or None if not found."""
    row = conn.execute(
        """
        SELECT id, cell_address, kind, title,
               substr(body, 1, ?) AS body_excerpt,
               length(body) AS body_length,
               summary, scope_json, tags_json, provenance_json,
               status, created_at, updated_at
        FROM graph_nodes WHERE id = ?
        """,
        (body_excerpt_chars, cell_id),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def fetch_cell_field(conn: sqlite3.Connection, cell_id: str, field: str) -> str | None:
    """Fetch a single field from a cell (body, title, summary, tags_json, etc.)."""
    if field not in {"body", "title", "summary", "scope_json", "tags_json",
                     "provenance_json", "cell_address", "kind", "status",
                     "created_at", "updated_at"}:
        return None
    row = conn.execute(
        f"SELECT {field} FROM graph_nodes WHERE id = ?",
        (cell_id,),
    ).fetchone()
    return row[field] if row else None


def fetch_relation_counts(conn: sqlite3.Connection, cell_id: str) -> dict:
    """Return counts of incoming/outgoing relations by kind."""
    out = {"outgoing": {}, "incoming": {}}
    for direction, where in (("outgoing", "source_id"), ("incoming", "target_id")):
        rows = conn.execute(
            f"SELECT kind, COUNT(*) AS c FROM graph_relations WHERE {where} = ? GROUP BY kind",
            (cell_id,),
        ).fetchall()
        out[direction] = {r["kind"]: r["c"] for r in rows}
    return out


def fetch_hyperedge_membership(conn: sqlite3.Connection, cell_id: str) -> dict:
    """Return counts of hyperedge memberships by kind + role.

    Uses JSON1's json_each to walk members_json arrays.
    """
    counts: dict[str, dict[str, int]] = {}
    rows = conn.execute(
        """
        SELECT h.kind AS he_kind, m.value ->> '$.role' AS role
        FROM hyperedges h, json_each(h.members_json) m
        WHERE m.value ->> '$.nodeId' = ?
        """,
        (cell_id,),
    ).fetchall()
    for r in rows:
        k = r["he_kind"]
        role = r["role"] or "?"
        counts.setdefault(k, {}).setdefault(role, 0)
        counts[k][role] += 1
    return counts


def search_cells(conn: sqlite3.Connection, *, match: str | None = None,
                 kind: str | None = None, project: str | None = None,
                 limit: int = 20) -> list[dict]:
    """Search for cells by title-prefix or body-substring + optional kind/project filters."""
    where_clauses: list[str] = []
    params: list = []
    if match:
        where_clauses.append("(title LIKE ? OR body LIKE ?)")
        params.extend([f"%{match}%", f"%{match}%"])
    if kind:
        where_clauses.append("kind = ?")
        params.append(kind)
    if project:
        where_clauses.append("scope_json LIKE ?")
        params.append(f'%"project":"{project}"%')
    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT id, cell_address, kind, title, length(body) AS body_length,
               substr(body, 1, 200) AS body_preview,
               created_at, updated_at
        FROM graph_nodes
        WHERE {where_sql}
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


# ---- Output formatting ----

def _parse_json_field(s: str | None) -> dict:
    if not s:
        return {}
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return {}


def cell_to_summary_dict(cell: dict, *, relations: dict, hyperedges: dict,
                         body_truncated: bool) -> dict:
    """Build the structured summary response."""
    scope = _parse_json_field(cell.get("scope_json"))
    tags = _parse_json_field(cell.get("tags_json"))
    provenance = _parse_json_field(cell.get("provenance_json"))
    return {
        "id": cell["id"],
        "cell_address": cell.get("cell_address"),
        "kind": cell.get("kind"),
        "title": cell.get("title"),
        "status": cell.get("status"),
        "scope": {
            "tenant": scope.get("tenant"),
            "project": scope.get("project"),
            "path": scope.get("path"),
            "sensitivity": scope.get("sensitivity"),
        },
        "tags_summary": {
            "topics": tags.get("topics", [])[:8],
            "lifecycle": tags.get("lifecycle", []),
            "category": tags.get("category", []),
            "entities_count": len(tags.get("entities", [])),
            "entities_sample": tags.get("entities", [])[:6],
        },
        "provenance": {
            "origin": provenance.get("origin"),
            "produced_by": provenance.get("produced_by"),
            "verification": provenance.get("verification"),
        },
        "body": {
            "excerpt": cell.get("body_excerpt", ""),
            "full_length": cell.get("body_length", 0),
            "truncated": body_truncated,
        },
        "summary_field": cell.get("summary"),
        "relations": {
            "outgoing_count": sum(relations.get("outgoing", {}).values()),
            "outgoing_by_kind": relations.get("outgoing", {}),
            "incoming_count": sum(relations.get("incoming", {}).values()),
            "incoming_by_kind": relations.get("incoming", {}),
        },
        "hyperedge_memberships": hyperedges,
        "timestamps": {
            "createdAt": cell.get("created_at"),
            "updatedAt": cell.get("updated_at"),
        },
    }


def summary_to_human(summary: dict) -> str:
    """Render a structured summary as compact human-readable text."""
    lines: list[str] = []
    lines.append(f"# {summary['title']}")
    lines.append("")
    lines.append(f"**id:** `{summary['id']}`")
    lines.append(f"**kind:** {summary['kind']}  · **status:** {summary['status']}")
    sc = summary["scope"]
    lines.append(f"**scope:** project={sc.get('project')}  path={sc.get('path') or '—'}")
    tags = summary["tags_summary"]
    lines.append(f"**topics:** {', '.join(tags.get('topics', []))}")
    lines.append(f"**lifecycle:** {', '.join(tags.get('lifecycle', []))}")
    lines.append(f"**entities:** {tags.get('entities_count', 0)} total ({', '.join(tags.get('entities_sample', []))}, ...)")
    pv = summary["provenance"]
    lines.append(f"**provenance:** {pv.get('produced_by')} · {pv.get('origin')} · {pv.get('verification')}")
    ts = summary["timestamps"]
    lines.append(f"**created:** {ts.get('createdAt')}  · **updated:** {ts.get('updatedAt')}")
    lines.append("")
    body = summary["body"]
    lines.append(f"## Body ({body['full_length']} chars total, "
                 f"{'truncated' if body['truncated'] else 'full'})")
    lines.append("")
    lines.append(body["excerpt"])
    if body["truncated"]:
        lines.append("")
        lines.append(f"... [{body['full_length'] - len(body['excerpt'])} more chars; use --field body --no-truncate]")
    lines.append("")
    rel = summary["relations"]
    lines.append(f"## Relations (out={rel['outgoing_count']}, in={rel['incoming_count']})")
    if rel["outgoing_by_kind"]:
        lines.append("Outgoing: " + ", ".join(f"{k}={v}" for k, v in rel["outgoing_by_kind"].items()))
    if rel["incoming_by_kind"]:
        lines.append("Incoming: " + ", ".join(f"{k}={v}" for k, v in rel["incoming_by_kind"].items()))
    if summary["hyperedge_memberships"]:
        lines.append("")
        lines.append("## Hyperedge memberships")
        for kind, by_role in summary["hyperedge_memberships"].items():
            roles = ", ".join(f"{r}×{n}" for r, n in by_role.items())
            lines.append(f"- {kind}: {roles}")
    return "\n".join(lines)


# ---- Token-budget mode ----

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def fit_to_budget(summary: dict, max_tokens: int, *, as_human: bool = False) -> str:
    """Iteratively shrink body excerpt until estimated tokens fit budget."""
    body_chars = len(summary["body"]["excerpt"])
    while body_chars > 100:
        rendered = (summary_to_human(summary) if as_human
                    else json.dumps(summary, indent=2))
        if estimate_tokens(rendered) <= max_tokens:
            return rendered
        body_chars = int(body_chars * 0.7)
        summary["body"]["excerpt"] = summary["body"]["excerpt"][:body_chars] + "...[shrunk for budget]"
        summary["body"]["truncated"] = True
    return (summary_to_human(summary) if as_human else json.dumps(summary, indent=2))


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Token-budget-aware cell summary for Recall.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Summary of a cell:\n"
            "  recall_peek.py 4ae7579e\n\n"
            "  # Just the title (cheapest probe):\n"
            "  recall_peek.py 4ae7579e --field title\n\n"
            "  # Find cells matching a keyword:\n"
            "  recall_peek.py --match \"L7\" --kind lemma --limit 5\n\n"
            "  # Token-budget cap:\n"
            "  recall_peek.py 4ae7579e --max-tokens 2000 --format human\n"
        ),
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("cell", nargs="?", help="Cell ID or 8+ char prefix.")
    src.add_argument("--match", help="Search by title-prefix or body-substring.")

    ap.add_argument("--field", default=None,
                    help="Return only one field (body, title, summary, tags_json, etc.).")
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
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DB path. Default: {DEFAULT_DB}")
    args = ap.parse_args()

    try:
        conn = _open_db(args.db)
    except sqlite3.Error as e:
        print(f"ERROR: cannot open DB: {e}", file=sys.stderr)
        return 2

    try:
        # --match mode: return a list of matching cells
        if args.match:
            results = search_cells(
                conn, match=args.match, kind=args.kind,
                project=args.project, limit=args.limit,
            )
            if args.format == "human":
                print(f"# {len(results)} cells matching {args.match!r}")
                for r in results:
                    print(f"\n## {r['title'][:120]}")
                    print(f"  id: `{r['id']}`  kind: {r['kind']}  body: {r['body_length']} chars")
                    print(f"  preview: {r['body_preview'][:200].strip()}")
            else:
                print(json.dumps({"match": args.match, "results": results}, indent=2))
            return 0

        # Single-cell mode
        try:
            cell_id = resolve_cell_id(conn, args.cell)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        if not cell_id:
            print(f"ERROR: no cell matching {args.cell!r}", file=sys.stderr)
            return 2

        # --field mode: return only one field, raw
        if args.field:
            value = fetch_cell_field(conn, cell_id, args.field)
            if value is None:
                print(f"ERROR: no field {args.field!r} or cell empty", file=sys.stderr)
                return 2
            if args.field == "body" and not args.no_truncate:
                value = value[:args.excerpt_chars]
            sys.stdout.write(value if isinstance(value, str) else json.dumps(value, indent=2))
            sys.stdout.write("\n")
            return 0

        # Summary mode: envelope + body excerpt + relation counts
        cell = fetch_cell_envelope(conn, cell_id, args.excerpt_chars)
        if not cell:
            print(f"ERROR: cell {cell_id} not found", file=sys.stderr)
            return 2
        body_truncated = cell["body_length"] > len(cell["body_excerpt"])
        relations = fetch_relation_counts(conn, cell_id)
        try:
            hyperedges = fetch_hyperedge_membership(conn, cell_id)
        except sqlite3.OperationalError:
            # JSON1 functions not available — skip hyperedge membership
            hyperedges = {}

        summary = cell_to_summary_dict(
            cell, relations=relations, hyperedges=hyperedges,
            body_truncated=body_truncated,
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
    sys.exit(_cli())
