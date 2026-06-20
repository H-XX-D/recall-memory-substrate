#!/usr/bin/env python3
"""SessionStart + UserPromptSubmit hook for the Recall active-memory substrate.

Two modes:

  default (SessionStart): emit the standing directive plus a cheap 7d
    recent-activity summary, scoped to whichever Recall DB the current
    directory routes to (a registered project's DB, or the global DB when the
    cwd matches no project). The scope is labelled accurately.

  --prompt (UserPromptSubmit): emit the directive plus a MINI index of the
    cells relevant to the incoming prompt (ids + titles only) and a count of
    the tripwires (challenged / stale cells) touching the topic. This is the
    push step: instead of telling the agent to go read Recall (which it can
    route around), the relevant ids and titles are pushed into context so the
    agent cannot ask or assert blind. It is deliberately INCOMPLETE: bodies, the
    conflict trace, and calibration are withheld on purpose, so the agent still
    runs a real `recall compile` and keeps the deeper tooling (search, subgraph,
    cell expansion) in play. The push is the invitation, not the substitute.

Fail-open by design: any error, timeout, or missing dependency falls back to the
directive alone. A prompt/session hook must never break submission. The
per-prompt compile is given a hard 4s timeout because it runs on every prompt.
"""
import json
import os
import shutil
import subprocess
import sys

DIFF = os.path.expanduser("~/.claude/skills/recall/scripts/recall_diff.py")
# One-time-per-environment marker so a missing diff script is reported once, not every launch.
_MISSING_DIFF_SENTINEL = os.path.expanduser("~/.claude/.recall-diff-missing.warned")

DIRECTIVE = (
    "[Recall active memory is available. Consult it before trusting recollection.]\n"
    "Before relying on memory for a task this session, read from Recall first:\n"
    '  - recall compile "<task>"   : compiled context packet for what you are about to do\n'
    '  - recall search "<query>"   : lexical / semantic lookup\n'
    "  - python3 ~/.claude/skills/recall/scripts/recall_peek.py <id>   : cheap cell preview\n"
    "Asking the user for a fact you could retrieve is the same failure as asserting from "
    "unchecked memory: search Recall before asking.\n"
    "Write durable findings back via the write helper / `recall admit`. "
    "Do not assert from memory you have not checked here."
)


def recall_bin() -> str:
    """Resolve the recall wrapper (does the cwd-based DB routing). Wrapper first, then PATH."""
    for cand in (
        os.path.expanduser("~/.recall/bin/recall"),
        shutil.which("recall"),
        "/opt/homebrew/bin/recall",
    ):
        if cand and os.path.exists(cand):
            return cand
    return ""


def read_hook_input() -> dict:
    """Parse the hook stdin JSON. Returns {} on tty / empty / malformed input."""
    try:
        if sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def _scope_label():
    """Describe the DB the cwd routes to, so the activity summary is labelled
    honestly. Returns (label, ok). Mirrors the recall wrapper's CWD routing via
    `recall project where`. Fail-open: any error returns a neutral, non-overclaiming label."""
    try:
        out = subprocess.run(
            ["recall", "project", "where"],
            capture_output=True, text=True, timeout=6,
        )
        if out.returncode != 0:
            return "recent graph activity", False
        text = out.stdout or ""
        # `recall project where` prints a `db:` line and a `reason:` line.
        if "using global" in text or "no project match" in text:
            return "graph-wide (global memory)", True
        for line in text.splitlines():
            if line.strip().startswith("db:"):
                base = os.path.basename(line.split(":", 1)[1].strip())
                slug = base[:-len(".sqlite3")] if base.endswith(".sqlite3") else base
                if slug and slug != "global":
                    return f"scoped to project '{slug}'", True
        return "graph-wide (global memory)", True
    except Exception:
        return "recent graph activity", False


def recent_summary() -> str:
    """Recent-activity summary text, or '' on any problem. Honors the diff's own
    cwd-based DB routing; we only gate on a clean exit so partial/garbage stdout
    from a failed run is never injected into model context."""
    if not os.path.exists(DIFF):
        if not os.path.exists(_MISSING_DIFF_SENTINEL):
            print(f"[recall hook] diff script not found at {DIFF}; emitting directive only. "
                  "Install/refresh with: recall claude sync", file=sys.stderr)
            try:
                open(_MISSING_DIFF_SENTINEL, "w").close()
            except Exception:
                pass
        return ""
    try:
        out = subprocess.run(
            [sys.executable, DIFF, "--since", "7d", "--summary"],
            capture_output=True, text=True, timeout=12,
        )
        if out.returncode != 0:
            return ""  # do not inject partial/garbage stdout from a failed diff
        return (out.stdout or "").strip()[:2000]
    except Exception:
        return ""


def _sections(text: str, names) -> dict:
    """Slice top-level sections out of a `recall compile` text packet.

    A section starts at a line `^<name>:` and runs until the next such header.
    Returns {name: [content_lines]} for the requested names, dropping blanks and
    the literal `- none` placeholder.
    """
    import re

    lines = text.splitlines()
    headers = [
        (i, m.group(1))
        for i, ln in enumerate(lines)
        for m in [re.match(r"^([a-z_]+):\s*$", ln)]
        if m
    ]
    out = {}
    for idx, (i, name) in enumerate(headers):
        if name not in names:
            continue
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(lines)
        body = [l for l in lines[i + 1:end] if l.strip() and l.strip() != "- none"]
        out[name] = body
    return out


def _trim(line: str, n: int) -> str:
    line = line.strip()
    return (line[: n - 1] + "…") if len(line) > n else line


def prompt_digest(prompt: str, cwd: str) -> str:
    """Build a MINI index of cells relevant to `prompt`: ids + titles only, plus
    a count of the tripwires (challenged / stale cells) touching the topic.

    Deliberately incomplete. It makes Recall ambient and names what exists so the
    agent cannot ask or assert blind, but it withholds bodies, the conflict trace,
    and calibration ON PURPOSE, so the agent still runs a real `recall compile`
    and keeps the deeper tooling (search, subgraph, cell expansion) in play.

    Returns "" on short prompt, missing binary, error, timeout, or no match
    (relevance gating: a weak/empty match pushes nothing extra).
    """
    import re

    prompt = (prompt or "").strip()
    if len(prompt) < 6:
        return ""
    recall = recall_bin()
    if not recall:
        return ""
    try:
        res = subprocess.run(
            [recall, "compile", prompt[:400]],
            capture_output=True, text=True, timeout=4,
            cwd=(cwd if cwd and os.path.isdir(cwd) else None),
        )
        out = res.stdout or ""
    except Exception:
        return ""

    secs = _sections(out, ["relevant_memory", "conflicts", "stale_or_low_trust"])
    rel = secs.get("relevant_memory", [])
    if not rel:
        return ""

    # ids + titles only: strip the trailing [kind:id], keep a short id, and
    # truncate what remains (which is title-first) so summaries do not bleed in.
    index = []
    for ln in rel[:5]:
        m = re.search(r"\[([a-z_]+):([0-9a-f]{8})[0-9a-f-]*\]\s*$", ln)
        cid = f"{m.group(1)}:{m.group(2)}" if m else ""
        body = re.sub(r"\s*\[[a-z_]+:[0-9a-f-]+\]\s*$", "", ln).lstrip("- ").strip()
        index.append(f"- {_trim(body, 110)}" + (f"  [{cid}]" if cid else ""))
    if not index:
        return ""

    parts = ["[Recall mini-index for THIS prompt (ids + titles only). You now know what exists, so do not ask or assert blind:]"]
    parts += index

    n_conf = len(secs.get("conflicts", []))
    n_stale = len(secs.get("stale_or_low_trust", []))
    flags = []
    if n_conf:
        flags.append(f"{n_conf} challenged")
    if n_stale:
        flags.append(f"{n_stale} stale/low-trust")
    if flags:
        parts.append("tripwires touching this topic: " + ", ".join(flags) + ".")

    parts.append(
        "This is awareness, NOT a substitute. For anything load-bearing, run "
        'recall compile "<task>" for bodies, the full conflict trace, and calibration, '
        "and use search / subgraph / recall cell show <id> to dig."
    )
    return "\n".join(parts)


def main() -> int:
    # --prompt: per-prompt push (directive + mini relevance index).
    # default: full SessionStart payload (directive + 7d recent-activity diff).
    prompt_mode = "--prompt" in sys.argv[1:]
    event = "UserPromptSubmit" if prompt_mode else "SessionStart"
    data = read_hook_input()

    ctx = DIRECTIVE
    if prompt_mode:
        digest = prompt_digest(data.get("prompt", ""), data.get("cwd", ""))
        if digest:
            ctx = digest + "\n\n" + DIRECTIVE
    else:
        summary = recent_summary()
        if summary:
            label, _ = _scope_label()
            ctx += f"\n\nRecent graph activity (last 7d, {label}):\n" + summary

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": ctx,
        }
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
