#!/usr/bin/env python3
"""SessionStart hook: auto-consult the Recall active-memory substrate.

Injects, as model context at the start of every session:
  1. A standing directive to consult Recall before relying on recollection
     (fixes the "agent forgets to look" failure mode), and
  2. A cheap recent-activity summary (last 7d), scoped to the current
     directory via the recall wrapper's CWD routing.

Fail-open by design: if the diff query is slow or errors, we still emit the
directive alone. A SessionStart hook must never break session launch.
"""
import json
import os
import subprocess
import sys

DIFF = os.path.expanduser("~/.claude/skills/recall/scripts/recall_diff.py")

DIRECTIVE = (
    "[Recall active memory is available — consult it before trusting recollection.]\n"
    "Before relying on memory for a task this session, read from Recall first:\n"
    '  • recall compile "<task>"   — compiled context packet for what you are about to do\n'
    '  • recall search "<query>"   — lexical / semantic lookup\n'
    "  • python3 ~/.claude/skills/recall/scripts/recall_peek.py <id>   — cheap cell preview\n"
    "Write durable findings back via the write helper / `recall admit`. "
    "Do not assert from memory you have not checked here."
)


def recent_summary() -> str:
    try:
        out = subprocess.run(
            [sys.executable, DIFF, "--since", "7d", "--summary"],
            capture_output=True, text=True, timeout=12,
        )
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
            ctx += "\n\nRecent graph activity (last 7d, scoped to this directory):\n" + summary
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": ctx,
        }
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
