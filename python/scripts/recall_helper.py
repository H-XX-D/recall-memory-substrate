#!/usr/bin/env python3
"""
recall_helper.py — Conversational write helper for Recall.

Constructs schema-valid recall.write.v1 proposals from a minimal
agent-friendly input format. The agent provides only the load-bearing
fields (kind, title, body, confidence, topics, evidence refs); the helper
fills in schema scaffolding, sensible defaults, and derived tag families.

Design intent (per Recall reference policy and operating contract):

- Eliminate schema-retry friction. Required fields, enums, and tag-family
  shape are handled by the helper.
- Preserve calibration discipline. The agent must still commit to a
  numeric confidence; the helper does NOT default to "high" or "0.8".
- Stable provenance. Defaults `actor.id` and `provenance.produced_by` to
  a constant identifier rather than inventing a new one per write
  (per llm-integration.md "Filling in judgment fields").
- Optional fields default to null/omitted rather than placeholders.

Library use:

    from recall_helper import build_proposal
    proposal = build_proposal(
        kind="lemma",
        title="...",
        body="...",
        confidence=0.85,
        topics=["topic-1", "topic-2"],
        depends_on=["abc12345-..."],  # bare IDs auto-normalized
        contradicts=[],
        source_files=["spec/foo.md#section-3"],
        project="my-project",
    )
    # Then pass `proposal` to mcp__recall__recall_write or the CLI admit path.

CLI use (emits JSON to stdout; pipe to `recall admit --json -`):

    python recall_helper.py --kind lemma --title "..." --body-file body.md \\
        --confidence 0.85 --topics topic-1,topic-2 \\
        --depends-on abc12345,def67890 \\
        --source-files "spec/foo.md#section-3,spec/bar.md"

    # Convenience: validate and admit in one shot via wrapper.
    python recall_helper.py --kind lemma ... --admit

The helper does not call the MCP tool itself — that's the agent's job —
but it produces a proposal that should pass `recall validate` on the
first try.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable

# ---- Schema enums (from llm-integration.md Field Reference) ----

KINDS = frozenset({
    "observation", "witness", "belief_update", "task", "objective", "goal",
    "decision", "risk", "constraint", "contradiction", "conflict",
    "hypothesis", "lemma", "question", "assumption", "preference",
    "checkpoint", "artifact", "source", "domain", "transfer", "action",
    "trust", "meta", "reflection", "identity", "handoff", "session",
    "benchmark_run", "program", "relation", "context_packet",
    "work_candidate", "proxy_score", "verification_result", "blind_lock",
    "allocation_plan", "miss",
})

ACTOR_KINDS = frozenset({"llm", "human", "daemon", "connector", "program"})
INTENT_OPERATIONS = frozenset({"create", "update", "supersede", "link", "archive"})
ORIGINS = frozenset({"human", "llm", "daemon", "connector", "program", "external"})
VERIFICATIONS = frozenset({"unverified", "checked", "tested", "external"})
SIGNATURE_STATUSES = frozenset({"unsigned", "signed", "verified"})
STABILITIES = frozenset({"ephemeral", "volatile", "stable"})
SOURCE_QUALITIES = frozenset({"unknown", "low", "medium", "high"})
SENSITIVITIES = frozenset({"public", "private", "secret"})

# Conventional values, not enforced enums.
RING_DEFAULTS = ("runtime",)  # llm-integration.md: safe default for ordinary memory

# Stable agent identifier — do not invent per-write per the operating contract.
DEFAULT_ACTOR_ID = "claude-code"

def _resolve_default_db() -> str:
    """Resolve the default Recall DB path.

    Resolution order:
    1. RECALL_DB environment variable (if set and non-empty)
    2. ~/.recall/recall.sqlite3 (XDG-ish standard location)
    3. ./.recall/recall.sqlite3 (per-project location, useful for repo-scoped use)

    Note: a missing DB file is not an error here; the CLI tools error at
    use-time if the resolved path doesn't exist. The default just picks the
    most likely location for a typical install.
    """
    env_db = os.environ.get("RECALL_DB", "").strip()
    if env_db:
        return env_db
    home_db = os.path.expanduser("~/.recall/recall.sqlite3")
    if os.path.exists(home_db):
        return home_db
    cwd_db = os.path.abspath("./.recall/recall.sqlite3")
    if os.path.exists(cwd_db):
        return cwd_db
    # Fall back to the home location even if it doesn't exist yet — `recall init`
    # creates it there by default.
    return home_db


DEFAULT_DB = _resolve_default_db()


# ---- Derivation helpers ----

def _confidence_to_quality(value: float) -> str:
    """Map confidence numeric to source_quality enum."""
    if value >= 0.8:
        return "high"
    if value >= 0.5:
        return "medium"
    if value > 0:
        return "low"
    return "unknown"


def _confidence_to_quality_tags(value: float) -> list[str]:
    """Derive `tags.quality` family from confidence — descriptive labels."""
    if value >= 0.85:
        return ["verified", "calibrated"]
    if value >= 0.7:
        return ["calibrated", "structural"]
    if value >= 0.5:
        return ["calibrated", "speculative"]
    return ["speculative", "low-confidence"]


def _kebab(text: str, max_len: int = 80) -> str:
    """Lowercase kebab-case slug. Strips non-alphanumeric chars."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return s[:max_len] if s else "untitled"


def _extract_entities(
    title: str,
    body: str,
    source_files: Iterable[str],
    cell_refs: Iterable[str],
    cap: int = 15,
) -> list[str]:
    """Auto-derive `tags.entities` from file paths, cell IDs, axiom mentions."""
    entities: set[str] = set()

    # File-path bases (without extension)
    for ref in source_files:
        path = ref.split("#", 1)[0]
        name = Path(path).stem
        if name:
            entities.add(name)

    # Cell ID short prefixes (first 8 hex chars after "cell/" or bare)
    cell_pat = re.compile(r"(?:recall://cell/)?([a-f0-9]{8})[a-f0-9-]*", re.I)
    for ref in cell_refs:
        m = cell_pat.search(ref)
        if m:
            entities.add(f"cell-{m.group(1)}")

    # Spec-style file refs in prose (file-NN or file-NNa)
    for text in (title, body[:1000]):
        for m in re.finditer(r"\bfile[ -](\d+[a-z]*)\b", text, re.I):
            entities.add(f"file-{m.group(1).lower()}")
        # Axiom names like A_excl, A_45, A_charge
        for m in re.finditer(r"\bA[_-][A-Za-z0-9]+\b", text):
            entities.add(m.group(0))

    return sorted(entities)[:cap]


def _norm_cell_ref(ref: str) -> str:
    """Normalize a cell reference to `recall://cell/<id>` form.

    Accepts bare UUID, `cell-<id>`, or full `recall://cell/<id>` already-normalized.
    """
    ref = ref.strip()
    if ref.startswith("recall://"):
        return ref
    # Strip optional cell- prefix
    if ref.lower().startswith("cell-"):
        ref = ref[5:]
    # If it looks like a UUID (with or without hyphens), prefix it
    if re.match(r"^[a-f0-9]{8}([a-f0-9-]*)$", ref, re.I):
        return f"recall://cell/{ref}"
    # Otherwise pass through (file ref, foreign address, etc.)
    return ref


def _isoformat_z(dt: datetime.datetime | None = None) -> str:
    """ISO-8601 in UTC with Z suffix, no fractional seconds."""
    if dt is None:
        dt = datetime.datetime.now(datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- Main builder ----

def build_proposal(
    *,
    kind: str,
    title: str,
    body: str,
    confidence: float,
    topics: list[str],

    # Optional fields with defaults
    summary: str | None = None,
    depends_on: list[str] | None = None,
    supports: list[str] | None = None,
    contradicts: list[str] | None = None,
    concerns: list[str] | None = None,
    source_files: list[str] | None = None,

    project: str = "my-project",
    subject: str | None = None,
    tenant: str | None = None,
    path: str | None = None,
    session: str | None = None,

    rings: list[str] | None = None,
    lifecycle: list[str] | None = None,
    quality: list[str] | None = None,
    category: list[str] | None = None,
    idea: list[str] | None = None,
    extra_entities: list[str] | None = None,
    identities: list[str] | None = None,

    actor_id: str = DEFAULT_ACTOR_ID,
    actor_display: str | None = None,

    uncertainty: float | None = None,
    concern: float | None = None,
    stability: str = "stable",
    verification: str = "checked",

    sensitivity: str = "private",
    allow_background_use: bool = True,
    requires_review: bool = False,
    expires_at: str | None = None,
    reverify_after: str | None = None,
) -> dict:
    """Build a schema-valid `recall.write.v1` proposal.

    Required from caller:
        kind: one of KINDS
        title: short stable title
        body: full claim text
        confidence: float in (0, 1] — DO NOT let helper default this
        topics: non-empty list of topic strings (highest-signal tag family)

    Everything else has sensible defaults aligned with the operating contract.

    Raises ValueError on invalid kind/confidence/topics.
    """
    if kind not in KINDS:
        raise ValueError(
            f"kind={kind!r} not in allowed set "
            f"(see KINDS constant; e.g. lemma, observation, reflection, decision)"
        )
    if not (0 < confidence <= 1):
        raise ValueError(f"confidence must be in (0, 1], got {confidence!r}")
    if not topics:
        raise ValueError("topics is required and must be non-empty")
    if stability not in STABILITIES:
        raise ValueError(f"stability={stability!r} not in {sorted(STABILITIES)}")
    if verification not in VERIFICATIONS:
        raise ValueError(f"verification={verification!r} not in {sorted(VERIFICATIONS)}")
    if sensitivity not in SENSITIVITIES:
        raise ValueError(f"sensitivity={sensitivity!r} not in {sorted(SENSITIVITIES)}")

    depends_on = list(depends_on or [])
    supports = list(supports or [])
    contradicts = list(contradicts or [])
    concerns = list(concerns or [])
    source_files = list(source_files or [])

    today = datetime.date.today().isoformat()
    now_iso = _isoformat_z()

    # Default tenant uses RECALL_TENANT env var if set, otherwise a
    # project-derived slug (anonymous-friendly default for OSS use).
    if not tenant:
        env_tenant = os.environ.get("RECALL_TENANT", "").strip()
        tenant = env_tenant if env_tenant else f"recall-{_kebab(project, 30)}"
    subject_slug = _kebab(subject or title, 80)
    summary = summary or title
    idea_tags = idea or [_kebab(title, 80)]

    # Auto-derive entities, then merge with explicit extras and project name.
    all_cell_refs = depends_on + supports + contradicts + concerns
    entities = _extract_entities(title, body, source_files, all_cell_refs)
    if extra_entities:
        for e in extra_entities:
            if e not in entities:
                entities.append(e)
    if project not in entities:
        entities.insert(0, project)

    derived_quality = quality or _confidence_to_quality_tags(confidence)
    derived_rings = rings or list(RING_DEFAULTS)
    derived_lifecycle = lifecycle or ["active"]
    derived_category = category or ["memory"]

    # Confidence sub-fields — split (1 - value) between uncertainty and concern.
    if uncertainty is None:
        uncertainty = round((1 - confidence) * 0.7, 3)
    if concern is None:
        concern = round((1 - confidence) * 0.3, 3)

    proposal: dict = {
        "schema_version": "recall.write.v1",
        "actor": {
            "kind": "llm",
            "id": actor_id,
        },
        "intent": {
            "operation": "create",
            "kind": kind,
            "summary": summary,
        },
        "content": {
            "title": title,
            "body": body,
        },
        "scope": {
            "tenant": tenant,
            "project": project,
            "sensitivity": sensitivity,
        },
        "tags": {
            # Required families
            "topics": list(topics),
            "entities": entities,
            "rings": derived_rings,
            "lifecycle": derived_lifecycle,
            "quality": derived_quality,
            # Optional but useful facets — power recall_subgraph
            "category": derived_category,
            "type": [kind],
            "subject": [subject_slug],
            "project": [project],
            "idea": idea_tags,
            "timestamp": [today],
        },
        "evidence": {
            "source_refs": list(source_files),
            "depends_on": [_norm_cell_ref(r) for r in depends_on],
            "supports": [_norm_cell_ref(r) for r in supports],
            "contradicts": [_norm_cell_ref(r) for r in contradicts],
            "concerns": [_norm_cell_ref(r) for r in concerns],
        },
        "confidence": {
            "value": float(confidence),
            "uncertainty": float(uncertainty),
            "concern": float(concern),
            "stability": stability,
            "source_quality": _confidence_to_quality(confidence),
        },
        "provenance": {
            "created_at": now_iso,
            "origin": "llm",
            "produced_by": actor_id,
            "verification": verification,
            "signature_status": "unsigned",
        },
        "policy": {
            "sensitivity": sensitivity,
            "allow_background_use": allow_background_use,
            "requires_review": requires_review,
            "expires_at": expires_at,
            "reverify_after": reverify_after,
        },
    }

    # Optional fields only added when set, to keep proposal minimal.
    if actor_display:
        proposal["actor"]["display"] = actor_display
    if path:
        proposal["scope"]["path"] = path
    if session:
        proposal["scope"]["session"] = session
    if identities:
        proposal["tags"]["identities"] = identities

    return proposal


# ---- CLI ----

def _split_csv(s: str) -> list[str]:
    """Split a comma-separated CLI arg into a clean list (empty → [])."""
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def _validate_via_cli(proposal_path: Path, db: str) -> tuple[bool, str]:
    """Shell out to `recall validate` and return (ok, full_json_output)."""
    out = subprocess.run(
        ["recall", "validate", "--json", str(proposal_path), "--db", db],
        capture_output=True, text=True, check=False,
    )
    try:
        result = json.loads(out.stdout)
    except json.JSONDecodeError:
        return False, out.stdout + out.stderr
    return bool(result.get("ok")), out.stdout


def _admit_via_cli(proposal_path: Path, db: str) -> tuple[bool, str]:
    """Shell out to `recall admit` and return (accepted, full_json_output)."""
    out = subprocess.run(
        ["recall", "admit", "--json", str(proposal_path), "--db", db],
        capture_output=True, text=True, check=False,
    )
    try:
        result = json.loads(out.stdout)
    except json.JSONDecodeError:
        return False, out.stdout + out.stderr
    return bool(result.get("accepted")), out.stdout


def _cli() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Build a schema-valid Recall write proposal from minimal inputs. "
            "Emits proposal JSON to stdout, or admits it directly via --admit."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Build proposal, print JSON:\n"
            "  recall_helper.py --kind lemma --title 'X' --body-file b.md \\\n"
            "      --confidence 0.85 --topics 'cone-stability,A1-invariance'\n\n"
            "  # Build and admit in one shot:\n"
            "  recall_helper.py --kind reflection --title 'Y' --body 'Z' \\\n"
            "      --confidence 0.7 --topics 'graph-hygiene' --admit\n"
        ),
    )
    ap.add_argument("--kind", required=True, choices=sorted(KINDS))
    ap.add_argument("--title", required=True)
    body_grp = ap.add_mutually_exclusive_group()
    body_grp.add_argument("--body", help="Body text inline.")
    body_grp.add_argument("--body-file", help="Read body from file (- for stdin).")
    ap.add_argument("--confidence", type=float, required=True,
                    help="Numeric in (0, 1]. Required — no default to enforce calibration.")
    ap.add_argument("--topics", required=True, help="Comma-separated topic tags.")
    ap.add_argument("--summary", default=None)

    ap.add_argument("--depends-on", default="")
    ap.add_argument("--supports", default="")
    ap.add_argument("--contradicts", default="")
    ap.add_argument("--concerns", default="")
    ap.add_argument("--source-files", default="",
                    help="Comma-separated file refs (path or path#section).")

    ap.add_argument("--project", default="my-project")
    ap.add_argument("--subject", default=None)
    ap.add_argument("--tenant", default=None)
    ap.add_argument("--path", default=None)
    ap.add_argument("--session", default=None)

    ap.add_argument("--rings", default="runtime",
                    help="Comma-separated. Default: runtime.")
    ap.add_argument("--lifecycle", default="active")
    ap.add_argument("--category", default="memory")
    ap.add_argument("--extra-entities", default="")
    ap.add_argument("--idea", default=None)
    ap.add_argument("--quality", default=None,
                    help="Override derived quality tags. Comma-separated.")

    ap.add_argument("--actor-id", default=DEFAULT_ACTOR_ID)
    ap.add_argument("--actor-display", default=None)

    ap.add_argument("--stability", default="stable", choices=sorted(STABILITIES))
    ap.add_argument("--verification", default="checked", choices=sorted(VERIFICATIONS))
    ap.add_argument("--sensitivity", default="private", choices=sorted(SENSITIVITIES))
    ap.add_argument("--uncertainty", type=float, default=None)
    ap.add_argument("--concern", type=float, default=None)

    ap.add_argument("--expires-at", default=None, help="ISO-8601 or omit for null.")
    ap.add_argument("--reverify-after", default=None, help="ISO-8601 or omit for null.")

    ap.add_argument("--validate", action="store_true",
                    help="Shell out to `recall validate` after building.")
    ap.add_argument("--admit", action="store_true",
                    help="Shell out to `recall admit` after building (implies validate).")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"Recall DB path. Default: {DEFAULT_DB}")
    ap.add_argument("--out", default="-",
                    help="Write proposal JSON to file path (default stdout).")
    args = ap.parse_args()

    # Resolve body
    if args.body_file == "-":
        body = sys.stdin.read()
    elif args.body_file:
        body = Path(args.body_file).read_text()
    elif args.body:
        body = args.body
    else:
        if sys.stdin.isatty():
            print("ERROR: no body provided. Use --body, --body-file, or pipe stdin.",
                  file=sys.stderr)
            return 2
        body = sys.stdin.read()

    proposal = build_proposal(
        kind=args.kind,
        title=args.title,
        body=body,
        confidence=args.confidence,
        topics=_split_csv(args.topics),
        summary=args.summary,
        depends_on=_split_csv(args.depends_on),
        supports=_split_csv(args.supports),
        contradicts=_split_csv(args.contradicts),
        concerns=_split_csv(args.concerns),
        source_files=_split_csv(args.source_files),
        project=args.project,
        subject=args.subject,
        tenant=args.tenant,
        path=args.path,
        session=args.session,
        rings=_split_csv(args.rings),
        lifecycle=_split_csv(args.lifecycle),
        quality=_split_csv(args.quality) if args.quality else None,
        category=_split_csv(args.category),
        idea=[args.idea] if args.idea else None,
        extra_entities=_split_csv(args.extra_entities),
        actor_id=args.actor_id,
        actor_display=args.actor_display,
        uncertainty=args.uncertainty,
        concern=args.concern,
        stability=args.stability,
        verification=args.verification,
        sensitivity=args.sensitivity,
        expires_at=args.expires_at,
        reverify_after=args.reverify_after,
    )

    proposal_json = json.dumps(proposal, indent=2)

    # Write proposal to file or stdout
    if args.out == "-":
        if not (args.validate or args.admit):
            sys.stdout.write(proposal_json + "\n")
    else:
        Path(args.out).write_text(proposal_json + "\n")

    # Validate / admit paths require the proposal on disk
    if args.validate or args.admit:
        if args.out == "-":
            import tempfile
            tmp = tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False
            )
            tmp.write(proposal_json)
            tmp.close()
            proposal_path = Path(tmp.name)
        else:
            proposal_path = Path(args.out)

        ok, validate_out = _validate_via_cli(proposal_path, args.db)
        sys.stderr.write(validate_out)
        if not ok:
            sys.stderr.write("\nVALIDATION FAILED — proposal not admitted.\n")
            return 1

        if args.admit:
            accepted, admit_out = _admit_via_cli(proposal_path, args.db)
            sys.stdout.write(admit_out)
            if not accepted:
                sys.stderr.write("\nADMISSION FAILED.\n")
                return 1

    return 0


if __name__ == "__main__":
    sys.exit(_cli())
