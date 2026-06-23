#!/usr/bin/env python3
"""SessionStart + UserPromptSubmit + Stop hook for the Recall active-memory substrate.

Three modes:

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

  --stop (Stop): the dig backstop. The push can flag a row DIG REQUIRED, but a
    UserPromptSubmit hook cannot enforce the dig because it returns before the
    model acts. So the push records the obligation as per-session state, and
    this mode blocks the turn from ending until the transcript shows a real
    Recall read during the turn. Single-shot and loop-guarded: it nudges once,
    never hard-traps.

Fail-open by design: any error, timeout, or missing dependency falls back to the
directive alone. A prompt/session hook must never break submission. The
per-prompt compile is given a hard 4s timeout because it runs on every prompt.
"""
import hashlib
import json
import os
import re
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
    "Write durable findings back via the write helper / `recall admit`, and pick the kind that fits so "
    "the write enriches the working state and is not just one more flat note: belief for a claim that can "
    "later be confirmed, contradicted, or superseded; task for an open action; objective for a goal; risk "
    "for a hazard worth tracking; observation, decision, or reflection otherwise. "
    "Do not assert from memory you have not checked here.\n"
    "You can also stand up a hyperedge PROGRAM that runs OUTSIDE the loop and keeps a rolling read "
    "(trend, watch, drift, quorum, score). When a value worth tracking over time, a state to watch "
    "for change, an attribution to monitor, or a claim needing k-of-m sign-off recurs, OFFER to "
    "create one instead of re-deriving it by hand."
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


def prompt_digest(prompt: str, cwd: str, flagged_out=None) -> str:
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

    # Danger sets: which cells are the SUPERSEDED side of a contradiction (the
    # target after `->`) or are flagged stale. Used to mark a row only when the
    # row ITSELF may not be current, so the dig call scales with real risk
    # instead of crying wolf on every dense-graph supersession trail.
    conflict_lines = secs.get("conflicts", [])
    stale_lines = secs.get("stale_or_low_trust", [])
    challenged_ids = set(re.findall(r"->([0-9a-f]{8})", " ".join(conflict_lines)))
    stale_ids = set(re.findall(r"stale:([0-9a-f]{8})", " ".join(stale_lines)))

    # ids + titles only: strip the trailing [kind:id], keep a short id, truncate
    # the rest (title-first), and flag the row if the cell is itself stale/superseded.
    index = []
    flagged = False
    for ln in rel[:5]:
        m = re.search(r"\[([a-z_]+):([0-9a-f]{8})[0-9a-f-]*\]\s*$", ln)
        short = m.group(2) if m else ""
        cid = f"{m.group(1)}:{m.group(2)}" if m else ""
        body = re.sub(r"\s*\[[a-z_]+:[0-9a-f-]+\]\s*$", "", ln).lstrip("- ").strip()
        tag = ""
        if short and short in stale_ids:
            tag, flagged = "  [STALE]", True
            if flagged_out is not None:
                flagged_out.append(short)
        elif short and short in challenged_ids:
            tag, flagged = "  [SUPERSEDED?]", True
            if flagged_out is not None:
                flagged_out.append(short)
        index.append(f"- {_trim(body, 110)}" + (f"  [{cid}]" if cid else "") + tag)
    if not index:
        return ""

    parts = ["[Recall mini-index for THIS prompt (ids + titles only). You now know what exists, so do not ask or assert blind:]"]
    parts += index

    if flagged:
        # A SHOWN row may not be current: reading its title alone is unsafe.
        parts.append(
            "DIG REQUIRED: a row above is marked [SUPERSEDED?] or [STALE]; its title may be out of date. "
            'Run recall compile "<task>" and recall cell show <id> on it BEFORE you act on it.'
        )
    elif conflict_lines or stale_lines:
        bits = []
        if conflict_lines:
            bits.append(f"{len(conflict_lines)} challenged")
        if stale_lines:
            bits.append(f"{len(stale_lines)} stale/low-trust")
        parts.append(
            "tripwires elsewhere on this topic (" + ", ".join(bits) + "). "
            'If you act here, run recall compile "<task>" for the conflict trace first.'
        )
    else:
        parts.append(
            "This is awareness, not a substitute. For anything load-bearing, run "
            'recall compile "<task>" for bodies and calibration, and search / subgraph / cell show to dig.'
        )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Dig backstop (Stop hook)
# ---------------------------------------------------------------------------
# The per-prompt push can flag a row DIG REQUIRED, but a UserPromptSubmit hook
# cannot enforce the dig: it has already returned before the model acts. So the
# push records the obligation as per-session state, and the Stop hook below
# refuses to let the turn end until the transcript shows a real Recall read.
# Single-shot + loop-guarded: it nudges once, never hard-traps.

STATE_DIR = os.path.expanduser("~/.recall/.dig_pending")

# A Recall READ inside a transcript tool_use line: CLI verbs or the MCP read tools.
RECALL_READ_RE = re.compile(
    r"recall\s+(?:compile|search|semantic|cell\s+show|subgraph|beliefs|maintenance)"
    r"|recall_peek\.py"
    r"|mcp__recall__recall_(?:compile|search|semantic|cell|subgraph|beliefs|status)",
    re.IGNORECASE,
)


def _state_path(session_id: str) -> str:
    if not session_id:
        return ""
    safe = hashlib.sha1(session_id.encode("utf-8")).hexdigest()[:16]
    return os.path.join(STATE_DIR, safe + ".json")


def _transcript_len(transcript_path: str) -> int:
    try:
        if transcript_path and os.path.exists(transcript_path):
            with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
                return sum(1 for _ in f)
    except Exception:
        pass
    return 0


def write_pending_dig(data: dict, flagged_ids) -> None:
    """Persist (when flagged) or clear (when not) this turn's dig obligation,
    keyed by session id. Records the transcript length at submit time so the
    Stop hook only scans tool calls made during this turn. Fail-open."""
    path = _state_path(data.get("session_id") or "")
    if not path:
        return
    try:
        if flagged_ids:
            os.makedirs(STATE_DIR, exist_ok=True)
            payload = {
                "ids": sorted(set(flagged_ids)),
                "from_line": _transcript_len(data.get("transcript_path", "")),
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
        elif os.path.exists(path):
            os.remove(path)  # no obligation this turn: clear any stale one
    except Exception:
        pass


def did_dig(transcript_path: str, from_line: int) -> bool:
    """True if a Recall READ tool call appears in transcript lines [from_line:].
    Requires the line to be a tool_use so a prose mention does not count.
    Fail-open: if the transcript cannot be read, return True (allow)."""
    try:
        if not transcript_path or not os.path.exists(transcript_path):
            return True
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return True
    for raw in lines[max(0, from_line):]:
        if "tool_use" in raw and RECALL_READ_RE.search(raw):
            return True
    return False


def stop_backstop(data: dict) -> str:
    """Return a block reason if the turn must not end yet, else "". The
    obligation is consumed on read, so the backstop fires at most once per
    flagged turn (a nudge with teeth, never a hard trap). Fail-open."""
    if data.get("stop_hook_active"):
        return ""  # already blocked once this cycle; never loop
    path = _state_path(data.get("session_id") or "")
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        return ""
    try:
        os.remove(path)  # single-shot: consume the obligation now
    except Exception:
        pass
    ids = state.get("ids") or []
    if not ids:
        return ""
    if did_dig(data.get("transcript_path", ""), int(state.get("from_line", 0) or 0)):
        return ""
    shown = ", ".join(ids[:5])
    return (
        "DIG REQUIRED fired this turn on superseded/stale Recall cell(s): "
        f"{shown}. The turn ended without reading them. Run "
        'recall compile "<task>" (or recall cell show <id>) on the flagged '
        "cell(s), and correct anything asserted from a stale row, before finishing."
    )


def main() -> int:
    # --stop:   dig backstop (block the turn end until a flagged row was dug).
    # --prompt: per-prompt push (directive + mini relevance index).
    # default:  full SessionStart payload (directive + 7d recent-activity diff).
    argv = sys.argv[1:]
    data = read_hook_input()

    if "--stop" in argv:
        reason = stop_backstop(data)
        print(json.dumps({"decision": "block", "reason": reason} if reason else {}))
        return 0

    prompt_mode = "--prompt" in argv
    event = "UserPromptSubmit" if prompt_mode else "SessionStart"

    ctx = DIRECTIVE
    if prompt_mode:
        flagged_ids: list = []
        digest = prompt_digest(data.get("prompt", ""), data.get("cwd", ""), flagged_ids)
        if digest:
            ctx = digest + "\n\n" + DIRECTIVE
        write_pending_dig(data, flagged_ids)
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
