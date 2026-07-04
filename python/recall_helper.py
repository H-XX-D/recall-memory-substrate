#!/usr/bin/env python3
"""
Build small Recall write proposals and optionally pass them to the recall CLI.

This helper is deliberately thin: TypeScript remains the source of truth for
schema validation, admission, routing, storage, and secret screening.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


KINDS = {"dec", "obs", "bel", "tsk", "obj", "rsk", "ref", "ver", "hyp", "prg"}
RELATIONS = {"supports", "contradicts", "concerns", "depends_on", "supersedes", "derived_from"}
OPERATIONS = {"create", "update", "supersede", "link", "annex"}
ORIGINS = {"human", "llm", "daemon", "connector", "program", "external"}
VERIFICATIONS = {"unverified", "checked", "tested", "external"}
SENSITIVITIES = {"public", "private", "secret"}
STABILITIES = {"ephemeral", "volatile", "stable"}


def build_proposal(
    *,
    kind: str,
    title: str,
    body: str,
    confidence: float,
    owner: str | None = None,
    summary: str | None = None,
    topics: list[str] | None = None,
    entities: list[str] | None = None,
    edges: list[dict[str, Any]] | None = None,
    source_refs: list[str] | None = None,
    uncertainty: float | None = None,
    concern: float | None = None,
    operation: str | None = None,
    origin: str | None = None,
    verification: str | None = None,
    sensitivity: str | None = None,
    expires_at: str | None = None,
    reverify_after: str | None = None,
    flags: dict[str, Any] | None = None,
    props: dict[str, Any] | None = None,
    project: str | None = None,
    tenant: str | None = None,
    stability: str | None = None,
) -> dict[str, Any]:
    """Return a v5 WriteProposal-shaped dict.

    The function performs light client-side checks for operator ergonomics. The
    authoritative checks still happen in `recall validate` or `admit`.
    """

    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(sorted(KINDS))}")
    if not title.strip():
        raise ValueError("title must be non-empty")
    if not (0 < confidence <= 1):
        raise ValueError("confidence must be in (0, 1]")

    proposal: dict[str, Any] = {
        "kind": kind,
        "title": title,
        "body": body,
        "confidence": confidence,
    }
    _put(proposal, "owner", owner)
    _put(proposal, "summary", summary)
    _put_list(proposal, "topics", topics)
    _put_list(proposal, "entities", entities)
    _put_list(proposal, "edges", edges)
    _put_list(proposal, "sourceRefs", source_refs)
    _put(proposal, "uncertainty", uncertainty)
    _put(proposal, "concern", concern)
    _put(proposal, "operation", operation)
    _put(proposal, "origin", origin)
    _put(proposal, "verification", verification)
    _put(proposal, "sensitivity", sensitivity)
    _put(proposal, "expiresAt", expires_at)
    _put(proposal, "reverifyAfter", reverify_after)
    _put(proposal, "flags", flags)
    _put(proposal, "props", props)
    _put(proposal, "project", project)
    _put(proposal, "tenant", tenant)
    _put(proposal, "stability", stability)
    return proposal


def run_cli_with_proposal(
    proposal: dict[str, Any],
    *,
    action: str,
    db: str | None = None,
    route_project: str | None = None,
    cli: str | None = None,
) -> subprocess.CompletedProcess[str]:
    if action not in {"validate", "admit"}:
        raise ValueError("action must be validate or admit")

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as fh:
        json.dump(proposal, fh, indent=2)
        fh.write("\n")
        proposal_path = fh.name

    try:
        cmd = resolve_cli(cli) + [action, "--json", proposal_path]
        if db:
            cmd += ["--db", db]
        if route_project:
            cmd += ["--project", route_project]
        return subprocess.run(cmd, text=True, capture_output=True, check=False)
    finally:
        Path(proposal_path).unlink(missing_ok=True)


def resolve_cli(cli: str | None = None) -> list[str]:
    explicit = cli or os.environ.get("RECALL_CLI")
    if explicit:
        return _command_for(explicit)

    local = Path(__file__).resolve().parents[1] / "dist" / "cli.js"
    if local.exists():
        return _command_for(str(local))
    return ["recall"]


def _command_for(value: str) -> list[str]:
    parts = shlex.split(value)
    if len(parts) != 1:
        return parts
    path = Path(parts[0]).expanduser()
    if path.exists():
        resolved = str(path)
        if path.suffix == ".js" and not os.access(path, os.X_OK):
            return ["node", resolved]
        return [resolved]
    return parts


def _put(proposal: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        proposal[key] = value


def _put_list(proposal: dict[str, Any], key: str, value: list[Any] | None) -> None:
    if value:
        proposal[key] = value


def csv_items(values: list[str] | None) -> list[str]:
    items: list[str] = []
    for value in values or []:
        for part in value.split(","):
            item = part.strip()
            if item:
                items.append(item)
    return items


def json_object(raw: str | None, name: str) -> dict[str, Any] | None:
    if raw is None:
        return None
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must decode to a JSON object")
    return value


def parse_edge(value: str) -> dict[str, Any]:
    parts = value.split(":", 2)
    if len(parts) < 2:
        raise ValueError("edge must be relation:target or relation:target:weight")
    relation, target = parts[0].strip(), parts[1].strip()
    if relation not in RELATIONS:
        raise ValueError(f"edge relation must be one of {', '.join(sorted(RELATIONS))}")
    if not target:
        raise ValueError("edge target must be non-empty")
    edge: dict[str, Any] = {"relation": relation, "target": target}
    if len(parts) == 3 and parts[2].strip():
        edge["weight"] = float(parts[2])
    return edge


def relation_edges(relation: str, values: list[str] | None) -> list[dict[str, Any]]:
    return [{"relation": relation, "target": target} for target in csv_items(values)]


def read_body(args: argparse.Namespace) -> str:
    if args.body_file:
        return Path(args.body_file).read_text(encoding="utf-8")
    return args.body


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Build or submit a Recall v5 WriteProposal.")
    p.add_argument("--kind", required=True, choices=sorted(KINDS))
    p.add_argument("--title", required=True)
    p.add_argument("--body", default="")
    p.add_argument("--body-file")
    p.add_argument("--confidence", required=True, type=float)
    p.add_argument("--owner")
    p.add_argument("--summary")
    p.add_argument("--topics", action="append", help="Comma-separated topic list; may repeat.")
    p.add_argument("--entities", action="append", help="Comma-separated entity list; may repeat.")
    p.add_argument("--source-refs", "--source-ref", action="append", help="Comma-separated refs; may repeat.")
    p.add_argument("--edge", action="append", help="relation:target or relation:target:weight.")
    p.add_argument("--supports", action="append", help="Comma-separated support targets.")
    p.add_argument("--contradicts", action="append", help="Comma-separated contradiction targets.")
    p.add_argument("--concerns", action="append", help="Comma-separated concern targets.")
    p.add_argument("--depends-on", action="append", help="Comma-separated dependency targets.")
    p.add_argument("--supersedes", action="append", help="Comma-separated supersession targets.")
    p.add_argument("--derived-from", action="append", help="Comma-separated derivation targets.")
    p.add_argument("--uncertainty", type=float)
    p.add_argument("--concern", type=float)
    p.add_argument("--operation", choices=sorted(OPERATIONS))
    p.add_argument("--origin", choices=sorted(ORIGINS))
    p.add_argument("--verification", choices=sorted(VERIFICATIONS))
    p.add_argument("--sensitivity", choices=sorted(SENSITIVITIES), default="private")
    p.add_argument("--expires-at")
    p.add_argument("--reverify-after")
    p.add_argument("--flags-json")
    p.add_argument("--props-json")
    p.add_argument("--project", help="Proposal project scope.")
    p.add_argument("--tenant", help="Proposal tenant scope.")
    p.add_argument("--stability", choices=sorted(STABILITIES))
    p.add_argument("--out", help="Write proposal JSON to this path.")
    p.add_argument("--validate", action="store_true", help="Run recall validate and print its JSON.")
    p.add_argument("--admit", action="store_true", help="Run recall admit and print its JSON.")
    p.add_argument("--db", help="Route validate/admit to a concrete DB.")
    p.add_argument("--route-project", help="Route validate/admit through a registered project slug.")
    p.add_argument("--cli", help="recall command/path override; also supported by RECALL_CLI.")
    return p


def proposal_from_args(args: argparse.Namespace) -> dict[str, Any]:
    edges = [parse_edge(value) for value in args.edge or []]
    edges += relation_edges("supports", args.supports)
    edges += relation_edges("contradicts", args.contradicts)
    edges += relation_edges("concerns", args.concerns)
    edges += relation_edges("depends_on", args.depends_on)
    edges += relation_edges("supersedes", args.supersedes)
    edges += relation_edges("derived_from", args.derived_from)

    return build_proposal(
        kind=args.kind,
        title=args.title,
        body=read_body(args),
        confidence=args.confidence,
        owner=args.owner,
        summary=args.summary,
        topics=csv_items(args.topics),
        entities=csv_items(args.entities),
        edges=edges,
        source_refs=csv_items(args.source_refs),
        uncertainty=args.uncertainty,
        concern=args.concern,
        operation=args.operation,
        origin=args.origin,
        verification=args.verification,
        sensitivity=args.sensitivity,
        expires_at=args.expires_at,
        reverify_after=args.reverify_after,
        flags=json_object(args.flags_json, "--flags-json"),
        props=json_object(args.props_json, "--props-json"),
        project=args.project,
        tenant=args.tenant,
        stability=args.stability,
    )


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        proposal = proposal_from_args(args)
        if args.out:
            Path(args.out).write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf-8")

        if args.admit or args.validate:
            action = "admit" if args.admit else "validate"
            result = run_cli_with_proposal(
                proposal,
                action=action,
                db=args.db,
                route_project=args.route_project,
                cli=args.cli,
            )
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            return result.returncode

        sys.stdout.write(json.dumps(proposal, indent=2) + "\n")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"{exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
