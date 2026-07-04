#!/usr/bin/env python3
"""
Compact preview over `recall cell show`.

The helper shells out to the v5 CLI and only trims/render its JSON output. It
does not read SQLite directly, so routing and storage behavior stay in TypeScript.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any

from recall_helper import resolve_cli


def fetch_cell_context(
    target: str,
    *,
    db: str | None = None,
    route_project: str | None = None,
    cli: str | None = None,
) -> dict[str, Any]:
    cmd = resolve_cli(cli) + ["cell", "show", target]
    if db:
        cmd += ["--db", db]
    if route_project:
        cmd += ["--project", route_project]
    result = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "recall cell show failed"
        raise RuntimeError(message)
    return json.loads(result.stdout)


def summarize_context(ctx: dict[str, Any], *, chars: int) -> dict[str, Any]:
    cell = ctx.get("cell", {})
    body = str(cell.get("body") or "")
    summary = {
        "key": cell.get("key"),
        "handle": cell.get("handle"),
        "kind": cell.get("kind"),
        "title": cell.get("title"),
        "status": cell.get("status"),
        "owner": cell.get("owner"),
        "scope": cell.get("scope", {}),
        "policy": cell.get("policy", {}),
        "scores": {
            "conf": cell.get("scores", {}).get("conf"),
            "effective": cell.get("scores", {}).get("effective"),
            "uncertainty": cell.get("scores", {}).get("uncertainty"),
            "concern": cell.get("scores", {}).get("concern"),
        },
        "tags": {
            "topics": cell.get("tags", {}).get("topics", []),
            "entities": cell.get("tags", {}).get("entities", []),
        },
        "summary": cell.get("summary"),
        "bodyPreview": clip(body, chars),
        "bodyChars": len(body),
        "bodyTruncated": len(body) > chars,
        "sourceRefs": cell.get("sourceRefs", []),
        "footprint": ctx.get("footprint", {}),
        "incomingCount": len(ctx.get("incoming", [])),
        "outgoingCount": len(ctx.get("outgoing", [])),
        "expansionHandles": ctx.get("expansionHandles", []),
    }
    if ctx.get("requestedField"):
        summary["requestedField"] = ctx["requestedField"]
    return summary


def render_human(summary: dict[str, Any]) -> str:
    scope = summary.get("scope", {})
    policy = summary.get("policy", {})
    scores = summary.get("scores", {})
    tags = summary.get("tags", {})
    lines = [
        str(summary.get("title") or "(untitled)"),
        f"key: {summary.get('key')}",
        f"handle: {summary.get('handle')}  kind: {summary.get('kind')}  status: {summary.get('status')}",
        f"scope: project={scope.get('project')} tenant={scope.get('tenant')} sensitivity={policy.get('sensitivity')}",
        (
            "scores: "
            f"conf={scores.get('conf')} effective={scores.get('effective')} "
            f"uncertainty={scores.get('uncertainty')} concern={scores.get('concern')}"
        ),
    ]
    topics = tags.get("topics") or []
    entities = tags.get("entities") or []
    if topics:
        lines.append(f"topics: {', '.join(map(str, topics))}")
    if entities:
        lines.append(f"entities: {', '.join(map(str, entities))}")
    if summary.get("summary"):
        lines.append(f"summary: {summary['summary']}")
    lines.append(f"body[{summary.get('bodyChars')} chars]: {summary.get('bodyPreview')}")
    lines.append(
        f"edges: incoming={summary.get('incomingCount')} outgoing={summary.get('outgoingCount')} "
        f"connected={len(summary.get('expansionHandles') or [])}"
    )
    handles = summary.get("expansionHandles") or []
    if handles:
        lines.append(f"expansion_handles: {', '.join(map(str, handles))}")
    if summary.get("sourceRefs"):
        lines.append(f"source_refs: {', '.join(map(str, summary['sourceRefs']))}")
    if summary.get("requestedField"):
        requested = summary["requestedField"]
        lines.append(f"requested_field: {requested.get('path')} = {requested.get('preview')}")
    return "\n".join(lines) + "\n"


def clip(value: str, chars: int) -> str:
    if chars < 1:
        return ""
    if len(value) <= chars:
        return value
    if chars <= 3:
        return value[:chars]
    return value[: chars - 3].rstrip() + "..."


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Show a compact Recall cell preview.")
    p.add_argument("target", help="Cell key, handle, or expansion handle.")
    p.add_argument("--chars", type=int, default=800, help="Body preview character budget.")
    p.add_argument("--format", choices=["human", "json"], default="human")
    p.add_argument("--db")
    p.add_argument("--route-project")
    p.add_argument("--cli", help="recall command/path override; also supported by RECALL_CLI.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        ctx = fetch_cell_context(args.target, db=args.db, route_project=args.route_project, cli=args.cli)
        summary = summarize_context(ctx, chars=args.chars)
        if args.format == "json":
            sys.stdout.write(json.dumps(summary, indent=2) + "\n")
        else:
            sys.stdout.write(render_human(summary))
        return 0
    except (RuntimeError, json.JSONDecodeError, OSError) as exc:
        sys.stderr.write(f"{exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
