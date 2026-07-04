#!/usr/bin/env python3
"""Meta-router for Recall queries: picks the cheapest tool per question shape.

Rule-based pattern matching (stdlib only, explainable, debuggable) maps the
shape of a question to the tool whose retrieval shape matches it:

| Question shape                 | Tool                        | Trigger patterns |
|--------------------------------|-----------------------------|------------------|
| Cell ID lookup                 | recall_peek.py <id>         | 8+ hex chars |
| Temporal ("what changed")      | recall diff --since X       | "since", "ago", "last", "recent", "changed", Nh/Nd/Nw |
| Graph health                   | recall health               | "contradiction", "stale", "warning", "health", "conflict" |
| Known symbol or specific term  | recall_peek.py --match      | snake_case, CamelCase, backticked code, "function/class X" |
| Synthesis, open-ended          | recall compile (fallback)   | anything else |

The peek script lives beside this one; diff, health, and compile are verbs on
the installed recall CLI, which owns DB routing by cwd. Pass --db only to
override that routing.

CLI:

    # Auto-route and execute:
    recall_router.py "what changed in the last 2 hours"

    # Show the routing decision and reasoning, then execute:
    recall_router.py "find the build_proposal function" --explain

    # Try fallback tools if the primary returns empty:
    recall_router.py "L7 gravity closure" --fallback

    # Force a specific tool (override routing):
    recall_router.py "..." --tool compile

    # JSON output (machine-readable):
    recall_router.py "..." --format json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


def _recall_bin() -> str:
    """Resolve the recall CLI: RECALL_CLI override, else PATH, else the bare
    name (subprocess will surface a clean not-found error)."""
    override = os.environ.get("RECALL_CLI", "").strip()
    if override:
        return override
    return shutil.which("recall") or "recall"


# ---- Routing patterns ----

ID_PATTERN = re.compile(r'\b([a-f0-9]{8}(?:-[a-f0-9-]{4,})?)\b', re.IGNORECASE)

TIME_PATTERN = re.compile(
    r'(\d+)\s*(minute|hour|day|week|month|min|hr|h|d|w|m)s?\s*(ago)?',
    re.IGNORECASE,
)

TEMPORAL_KEYWORDS = (
    "since", "ago", "last hour", "last day", "last week",
    "recent", "recently", "changed", "what's new", "what is new",
    "what happened", "today", "yesterday", "this hour",
)

HEALTH_KEYWORDS = (
    "contradiction", "contradictions", "stale", "warning", "warnings",
    "health", "conflict", "conflicts", "critical",
    "stale cells", "graph state",
)

# Identifier-shaped patterns hinting at a specific symbol or term.
# Order matters: most-specific patterns first, so a query like
# "tell me about build_proposal function" matches snake_case (build_proposal)
# rather than the function-keyword pattern.
SYMBOL_PATTERNS = (
    re.compile(r'`([^`]+)`'),                                       # backticked
    re.compile(r'\bcell\s+([a-f0-9]{8,}(?:-[a-f0-9-]+)?)', re.I),   # "cell abc12345"
    re.compile(r'\b([a-z][a-z0-9]*_[a-z][a-z0-9_]*)\b'),            # snake_case_name (high specificity)
    re.compile(r'\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b'),               # CamelCaseName (high specificity)
    re.compile(r'\bfunction\s+([A-Za-z_][\w]*)', re.I),             # "function foo" (after specific identifiers)
    re.compile(r'\bclass\s+([A-Za-z_][\w]*)', re.I),                # "class Foo"
    re.compile(r'\bmethod\s+([A-Za-z_][\w]*)', re.I),               # "method bar"
)

# Short version-string or specific-identifier patterns, tried in order;
# first match wins.
SPECIFIC_TERM_PATTERNS = (
    re.compile(r'\b(v\d+(?:\.\d+){1,2})\b'),                 # v1.4, v1.2.3
    re.compile(r'\b([A-Z]+-\d+[a-z]?)\b'),                   # GR-01e, R-02a
    re.compile(r'\b([A-Z]\d+[a-z]?)\b'),                     # L7, L8, T1
    re.compile(r'\b([a-z]+-[a-z]+(?:-[a-z]+)+)\b'),          # multi-hyphen kebab-case
)


@dataclass
class RouteDecision:
    """A routing decision: which tool, with what argument, and why."""
    tool: str                # peek-id | diff | health | peek-match | compile
    arg: str | None          # tool-specific arg
    reason: str              # explanation
    confidence: float        # 0 to 1: how sure the router is


def route(query: str) -> RouteDecision:
    """Pick the most-appropriate tool for a query.

    Returns RouteDecision with tool name, optional arg, reason, confidence.
    """
    q_lower = query.lower()
    q_stripped = query.strip()

    # 1. Cell ID lookup: highest priority, unambiguous when present
    id_match = ID_PATTERN.search(q_stripped)
    if id_match:
        candidate = id_match.group(1)
        # Only treat as an ID at 8+ chars (key prefix size)
        if len(candidate.replace("-", "")) >= 8:
            return RouteDecision(
                tool="peek-id",
                arg=candidate,
                reason=f"detected cell-ID-like prefix {candidate!r} (8+ hex chars)",
                confidence=0.95,
            )

    # 2. Temporal queries route to `recall diff`
    time_match = TIME_PATTERN.search(q_stripped)
    has_temporal_keyword = any(kw in q_lower for kw in TEMPORAL_KEYWORDS)
    if time_match or has_temporal_keyword:
        if time_match:
            n = time_match.group(1)
            unit = time_match.group(2).lower()
            unit_map = {
                "minute": "m", "min": "m", "m": "m",
                "hour": "h", "hr": "h", "h": "h",
                "day": "d", "d": "d",
                "week": "w", "w": "w",
            }
            if unit == "month":
                # diff has no month unit; approximate 1 month as 4 weeks so
                # "3 months" widens to 12w instead of collapsing to 3w.
                since = f"{int(n) * 4}w"
            else:
                since = f"{n}{unit_map.get(unit, 'd')}"
            return RouteDecision(
                tool="diff",
                arg=since,
                reason=f"detected time expression {time_match.group(0)!r}, --since {since}",
                confidence=0.9,
            )
        return RouteDecision(
            tool="diff",
            arg="1d",
            reason="temporal keyword detected, defaulting to --since 1d",
            confidence=0.7,
        )

    # 3. Graph-health queries route to `recall health`
    if any(kw in q_lower for kw in HEALTH_KEYWORDS):
        return RouteDecision(
            tool="health",
            arg=None,
            reason=f"health keyword in query ({next(k for k in HEALTH_KEYWORDS if k in q_lower)!r})",
            confidence=0.85,
        )

    # 4. Specific symbol or term routes to peek --match
    for pat in SYMBOL_PATTERNS:
        m = pat.search(q_stripped)
        if m:
            symbol = m.group(1) if m.groups() else m.group(0)
            symbol = symbol.strip("`")
            return RouteDecision(
                tool="peek-match",
                arg=symbol,
                reason=f"identifier-shaped pattern matched: {pat.pattern!r} gives {symbol!r}",
                confidence=0.75,
            )

    # 5. Specific terms (version strings, kebab-case, lemma IDs)
    for pat in SPECIFIC_TERM_PATTERNS:
        m = pat.search(q_stripped)
        if m:
            term = m.group(1)
            if len(term) > 1:
                return RouteDecision(
                    tool="peek-match",
                    arg=term,
                    reason=f"specific-term pattern matched: {pat.pattern!r} gives {term!r}",
                    confidence=0.7,
                )

    # 6. Default: compile for synthesis and open-ended queries
    return RouteDecision(
        tool="compile",
        arg=None,
        reason="no specific pattern matched; defaulting to compile for synthesis",
        confidence=0.5,
    )


# ---- Tool execution ----

@dataclass
class ExecutionResult:
    tool: str
    output: str
    bytes_returned: int
    returncode: int
    error: str | None = None


def build_command(decision: RouteDecision, query: str, db: str | None,
                  recall: str = "recall") -> list[str] | None:
    """Command line for a routed tool. Pure, so the mapping is unit-tested.

    Peek runs the sibling script; diff, health, and compile are CLI verbs.
    --db is appended only when the caller gave one: the CLI (and the peek
    script's env resolution) own routing otherwise.
    """
    scripts = Path(__file__).parent
    db_args = ["--db", db] if db else []

    if decision.tool == "peek-id":
        return [sys.executable or "python3", str(scripts / "recall_peek.py"),
                decision.arg or query, "--format", "human", *db_args]
    if decision.tool == "diff":
        return [recall, "diff", "--since", decision.arg or "1d",
                "--summary", "--max-items", "8", *db_args]
    if decision.tool == "health":
        return [recall, "health", *db_args]
    if decision.tool == "peek-match":
        return [sys.executable or "python3", str(scripts / "recall_peek.py"),
                "--match", decision.arg or query,
                "--limit", "5", "--format", "human", *db_args]
    if decision.tool == "compile":
        return [recall, "compile", query, "--words", "300", *db_args]
    return None


def execute(decision: RouteDecision, query: str, db: str | None) -> ExecutionResult:
    """Execute the routed tool."""
    cmd = build_command(decision, query, db, recall=_recall_bin())
    if cmd is None:
        return ExecutionResult(
            tool=decision.tool, output="", bytes_returned=0,
            returncode=1, error=f"unknown tool: {decision.tool}",
        )

    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                check=False, timeout=30)
    except subprocess.TimeoutExpired:
        return ExecutionResult(
            tool=decision.tool, output="", bytes_returned=0,
            returncode=124, error="timeout",
        )
    except OSError as e:
        return ExecutionResult(
            tool=decision.tool, output="", bytes_returned=0,
            returncode=127, error=str(e),
        )

    return ExecutionResult(
        tool=decision.tool,
        output=result.stdout,
        bytes_returned=len(result.stdout.encode("utf-8")),
        returncode=result.returncode,
        error=(result.stderr.strip() if result.returncode != 0 else None),
    )


def _result_looks_empty(execution: ExecutionResult) -> bool:
    """Heuristic: did the result look like nothing useful was found?"""
    if execution.bytes_returned == 0:
        return True
    out_lower = execution.output.lower()
    empty_signals = (
        "no activity in this window",
        "0 cells matching",
        "no cells",
        "_no outstanding",
        "0 hits",
        "no match",
    )
    return any(sig in out_lower for sig in empty_signals)


def _fallback_tools(primary: str) -> list[str]:
    """Fallback tools to try if the primary returned empty."""
    if primary == "compile":
        return ["peek-match"]
    if primary == "peek-match":
        return ["compile"]
    if primary == "peek-id":
        return ["peek-match"]
    if primary == "diff":
        return ["health"]
    if primary == "health":
        return ["compile"]
    return []


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Meta-router for Recall: picks the right tool per query.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # Auto-route and execute:\n"
            "  recall_router.py \"what changed in the last 2 hours\"\n\n"
            "  # Show routing decision and reasoning:\n"
            "  recall_router.py \"find build_proposal\" --explain\n\n"
            "  # Force a tool override:\n"
            "  recall_router.py \"...\" --tool peek-match --arg build_proposal\n\n"
            "  # Fallback if the primary returns empty:\n"
            "  recall_router.py \"v1.4 CI\" --fallback\n"
        ),
    )
    ap.add_argument("query", help="The query string to route.")
    ap.add_argument("--explain", action="store_true",
                    help="Show routing decision and reasoning before executing.")
    ap.add_argument("--explain-only", action="store_true",
                    help="Show routing decision; don't execute.")
    ap.add_argument("--tool", default=None,
                    choices=("peek-id", "diff", "health", "peek-match", "compile"),
                    help="Override routing and force a specific tool.")
    ap.add_argument("--arg", default=None,
                    help="Override the routed tool's arg (used with --tool).")
    ap.add_argument("--fallback", action="store_true",
                    help="Try secondary tools if the primary returns empty.")
    ap.add_argument("--format", choices=("text", "json"), default="text",
                    help="Output format. Default: text (tool output plus optional explanation).")
    ap.add_argument("--db", default=None,
                    help="Explicit DB path. Default: none; the recall CLI routes by cwd "
                         "and the peek script resolves RECALL_DB / RECALL_HOME.")
    args = ap.parse_args()

    # Routing
    if args.tool:
        decision = RouteDecision(
            tool=args.tool,
            arg=args.arg,
            reason="user-forced via --tool",
            confidence=1.0,
        )
    else:
        decision = route(args.query)
        if args.arg:
            decision.arg = args.arg

    if args.explain or args.explain_only:
        explain_line = (
            f"[router] tool={decision.tool} arg={decision.arg!r} "
            f"confidence={decision.confidence:.2f}\n"
            f"[router] reason: {decision.reason}"
        )
        if args.format == "text":
            print(explain_line, file=sys.stderr)

    if args.explain_only:
        if args.format == "json":
            print(json.dumps({
                "tool": decision.tool,
                "arg": decision.arg,
                "confidence": decision.confidence,
                "reason": decision.reason,
            }, indent=2))
        return 0

    # Execute primary
    execution = execute(decision, args.query, args.db)
    executions = [execution]

    # Fallback if empty and --fallback set
    if args.fallback and _result_looks_empty(execution):
        for fb_tool in _fallback_tools(decision.tool):
            if args.explain:
                print(f"[router] primary empty, trying fallback: {fb_tool}",
                      file=sys.stderr)
            fb_decision = RouteDecision(
                tool=fb_tool,
                arg=args.query if fb_tool == "peek-match" else None,
                reason=f"fallback from {decision.tool} (returned empty)",
                confidence=0.5,
            )
            fb_execution = execute(fb_decision, args.query, args.db)
            executions.append(fb_execution)
            if not _result_looks_empty(fb_execution):
                break

    # Output
    if args.format == "json":
        print(json.dumps({
            "query": args.query,
            "decision": {
                "tool": decision.tool,
                "arg": decision.arg,
                "confidence": decision.confidence,
                "reason": decision.reason,
            },
            "executions": [{
                "tool": e.tool,
                "bytes_returned": e.bytes_returned,
                "returncode": e.returncode,
                "output": e.output,
                "error": e.error,
            } for e in executions],
        }, indent=2))
    else:
        for e in executions:
            if e.error:
                print(f"[error from {e.tool}] {e.error}", file=sys.stderr)
            print(e.output, end="" if e.output.endswith("\n") else "\n")

    # Exit 0 if the primary succeeded OR any fallback succeeded
    return 0 if any(e.returncode == 0 for e in executions) else 1


if __name__ == "__main__":
    sys.exit(_cli())
