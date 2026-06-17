#!/usr/bin/env python3
"""SessionStart hook: auto-consult the Recall active-memory substrate.

Injects, as model context at the start of every session:
  1. A standing directive to consult Recall before relying on recollection
     (fixes the "agent forgets to look" failure mode), and
  2. A cheap recent-activity summary (last 7d), scoped to whichever Recall DB
     the current directory routes to (a registered project's DB, or the global
     DB when the cwd matches no project). The scope is labelled accurately.

Fail-open by design: if the diff query is slow, missing, or errors, we still
emit the directive alone. A SessionStart hook must never break session launch.
"""
import json
import os
import subprocess
import sys

DIFF = os.path.expanduser("~/.claude/skills/recall/scripts/recall_diff.py")
# One-time-per-environment marker so a missing diff script is reported once, not every launch.
_MISSING_DIFF_SENTINEL = os.path.expanduser("~/.claude/.recall-diff-missing.warned")

DIRECTIVE = (
    "[Recall active memory is available — consult it before trusting recollection.]\n"
    "Before relying on memory for a task this session, read from Recall first:\n"
    '  • recall compile "<task>"   — compiled context packet for what you are about to do\n'
    '  • recall search "<query>"   — lexical / semantic lookup\n'
    "  • python3 ~/.claude/skills/recall/scripts/recall_peek.py <id>   — cheap cell preview\n"
    "Write durable findings back via the write helper / `recall admit`. "
    "Do not assert from memory you have not checked here."
)


def _scope_label():
    """Describe the DB the cwd routes to, so the activity summary is labelled
    honestly. Returns (label, ok). Mirrors the recall wrapper's CWD routing via
    `recall project where`. Fail-open: any error → a neutral, non-overclaiming label."""
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


def main() -> int:
    # --prompt: lightweight per-prompt nudge (directive only, ~126 tokens, no diff).
    # default: full SessionStart payload (directive + 7d recent-activity diff).
    prompt_mode = "--prompt" in sys.argv[1:]
    event = "UserPromptSubmit" if prompt_mode else "SessionStart"
    ctx = DIRECTIVE
    if not prompt_mode:
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
