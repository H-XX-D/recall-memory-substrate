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
    `recall where`, which prints JSON {scope, db, slug?}. Fail-open: any error
    returns a neutral, non-overclaiming label."""
    recall = recall_bin()
    if not recall:
        return "recent graph activity", False
    try:
        out = subprocess.run(
            [recall, "where"],
            capture_output=True, text=True, timeout=6,
        )
        if out.returncode != 0:
            return "recent graph activity", False
        info = json.loads(out.stdout or "{}")
        if info.get("scope") == "project":
            slug = info.get("slug") or "project"
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


def build_mini_index(rel, conflict_lines, stale_lines, flagged_out=None) -> str:
    """Assemble the mini-index from compile section lines (ids + titles only),
    flagging a row only when the cell ITSELF is the superseded side of a
    contradiction or is stale. Pure (no subprocess), so it is unit-tested."""
    if not rel:
        return ""
    # ids may be bare (project scope) or graph-prefixed (home/union scope under
    # model-A, e.g. `home:1750a919-...`). Match the 8-hex core regardless of an
    # optional `graph:` prefix so flagging works in BOTH scopes; without this the
    # whole flag/dig mechanism silently dies at home scope.
    challenged_ids = set(re.findall(r"->(?:[a-z0-9_-]+:)*([0-9a-f]{8})", " ".join(conflict_lines)))
    stale_ids = set(re.findall(r"stale:(?:[a-z0-9_-]+:)*([0-9a-f]{8})", " ".join(stale_lines)))
    index = []
    flagged = False
    for ln in rel[:5]:
        m = re.search(r"\[([a-z_]+):((?:[a-z0-9_-]+:)*[0-9a-f]{8}[0-9a-f-]*)\]\s*$", ln)
        full_id = m.group(2) if m else ""
        core = re.match(r"[0-9a-f]{8}", full_id.split(":")[-1]) if full_id else None
        short = core.group(0) if core else ""
        cid = f"{m.group(1)}:{full_id}" if m else ""  # full (possibly prefixed) id for expansion
        body = re.sub(r"\s*\[[a-z_]+:[a-z0-9_:-]+\]\s*$", "", ln).lstrip("- ").strip()
        tag = ""
        if short and short in stale_ids:
            tag, flagged = "  [STALE]", True
            if flagged_out is not None:
                flagged_out.append({"id": short, "title": body})
        elif short and short in challenged_ids:
            tag, flagged = "  [SUPERSEDED?]", True
            if flagged_out is not None:
                flagged_out.append({"id": short, "title": body})
        index.append(f"- {_trim(body, 110)}" + (f"  [{cid}]" if cid else "") + tag)
    if not index:
        return ""
    parts = ["[Recall mini-index for THIS prompt (ids + titles only). You now know what exists, so do not ask or assert blind:]"]
    parts += index
    if flagged:
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
    return build_mini_index(
        secs.get("relevant_memory", []),
        secs.get("conflicts", []),
        secs.get("stale_or_low_trust", []),
        flagged_out,
    )


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


def write_pending_dig(data: dict, flagged) -> None:
    """Persist (when flagged) or clear (when not) this turn's dig obligation,
    keyed by session id. Records each flagged cell's id AND title (the title is
    what the Stop hook needs to tell whether the turn's reply engaged the cell)
    plus the transcript length at submit time so the Stop hook only scans this
    turn. `flagged` items may be ids (str) or {"id", "title"} dicts. Fail-open."""
    path = _state_path(data.get("session_id") or "")
    if not path:
        return
    try:
        by_id = {}
        for item in (flagged or []):
            if isinstance(item, dict):
                cid = str(item.get("id") or "")
                title = str(item.get("title") or "")
            else:
                cid, title = str(item), ""
            if cid and (cid not in by_id or (not by_id[cid] and title)):
                by_id[cid] = title
        if by_id:
            os.makedirs(STATE_DIR, exist_ok=True)
            ids = sorted(by_id)
            payload = {
                "ids": ids,
                "titles": [by_id[i] for i in ids],
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


# Function words plus a few ultra-generic domain words, dropped before content
# overlap so a flagged title and an unrelated reply do not "engage" on filler.
_ENGAGE_STOP = {
    "this", "that", "with", "from", "into", "your", "have", "will", "when",
    "then", "than", "they", "them", "what", "which", "were", "been", "over",
    "under", "about", "after", "before", "while", "here", "there", "their",
    "would", "could", "should", "does", "done", "like", "just", "yeah", "also",
    "very", "much", "more", "most", "some", "such", "only", "even", "still",
    "back", "onto", "upon", "recall", "memory", "cell", "cells",
}


def _content_tokens(text: str) -> set:
    import re
    return {
        w for w in re.findall(r"[a-z0-9]+", (text or "").lower())
        if len(w) >= 4 and w not in _ENGAGE_STOP
    }


def _assistant_text(transcript_path: str, from_line: int) -> str:
    """The assistant's response text for this turn (transcript lines from the
    submit boundary onward). Used to tell whether the reply engaged a flagged
    cell. Fail-open: unreadable transcript returns ""."""
    try:
        if not transcript_path or not os.path.exists(transcript_path):
            return ""
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return ""
    out = []
    for raw in lines[max(0, from_line):]:
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    out.append(part.get("text") or "")
        elif isinstance(content, str):
            out.append(content)
    return "\n".join(out)


def response_engages(text: str, ids, titles) -> bool:
    """True if the turn's reply actually engaged a flagged cell: it names the
    cell id, or it shares two-plus distinctive content words with the cell's
    title (the signature of propagating that cell's claim). A reply that engages
    no flagged cell did not lean on it, so it owes no dig."""
    if not text:
        return False
    low = text.lower()
    for cid in (ids or []):
        short = str(cid).split(":")[-1]
        if short and short in low:
            return True
    resp = _content_tokens(low)
    if not resp:
        return False
    for title in (titles or []):
        if len(resp & _content_tokens(title)) >= 2:
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
    transcript = data.get("transcript_path", "")
    from_line = int(state.get("from_line", 0) or 0)
    if did_dig(transcript, from_line):
        return ""
    # Precision gate: only hold the turn open if the reply actually engaged a
    # flagged cell. A conversational turn that never touched it owes no dig, so
    # the backstop fires on reliance, not merely on a stale row appearing in the
    # index. Fail-safe: when in doubt (no titles, unreadable transcript), the
    # id check and the empty-response path keep behavior conservative.
    if not response_engages(_assistant_text(transcript, from_line), ids, state.get("titles") or []):
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
        flagged: list = []
        digest = prompt_digest(data.get("prompt", ""), data.get("cwd", ""), flagged)
        if digest:
            ctx = digest + "\n\n" + DIRECTIVE
        write_pending_dig(data, flagged)
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
