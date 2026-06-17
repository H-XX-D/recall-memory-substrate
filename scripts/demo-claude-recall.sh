#!/usr/bin/env bash
# ============================================================================
# Claude Code + Recall — a real cross-session use case.
#
# A sprint's worth of work, three SEPARATE `claude -p` processes (no shared
# conversation). An architecture decision is made, a load test changes it days
# later, and a brand-new engineer's agent — zero prior context — picks up a
# ticket and gets the CURRENT decision straight from the graph. That is the
# whole point of durable agent memory: it stays correct across sessions and
# corrections, with the old answer preserved-but-superseded, not lost.
#
# Fully isolated in a throwaway graph; a tripwire asserts your real graph is
# never touched. Requirements: `recall`, `recall-mcp`, `claude` on PATH (logged in).
# ============================================================================
set -u
command -v claude     >/dev/null || { echo "needs the 'claude' CLI on PATH (and logged in)"; exit 1; }
command -v recall     >/dev/null || { echo "needs 'recall' on PATH (npm link / install)"; exit 1; }
command -v recall-mcp >/dev/null || { echo "needs 'recall-mcp' on PATH"; exit 1; }

DB="$(mktemp -t recall-demo.XXXXXX.sqlite3)"; rm -f "$DB"
CFG="$(mktemp -t recall-demo-mcp.XXXXXX.json)"
GLOBAL="$HOME/.recall/db/global.sqlite3"
PACE="${DEMO_PACE:-1.2}"   # seconds between beats; set DEMO_PACE=0 for no pauses

# ---- presentation helpers ------------------------------------------------
bold=$'\033[1m'; dim=$'\033[2m'; off=$'\033[0m'
cyan=$'\033[1;36m'; yellow=$'\033[1;33m'; green=$'\033[1;32m'; grey=$'\033[90m'
scene(){ printf '\n%s┌─ %s ─────────────────────────────────────────%s\n' "$cyan" "$1" "$off"; }
narrate(){ printf '%s│%s %s▸ %s%s\n' "$cyan" "$off" "$yellow" "$1" "$off"; }
human(){ printf '%s│%s %s🧑 you →%s %s\n' "$cyan" "$off" "$bold" "$off" "$1"; }
sleep "$PACE" 2>/dev/null || true
beat(){ sleep "$PACE" 2>/dev/null || true; }

nodes(){ recall status --db "$1" 2>/dev/null | grep -oE '"nodes": *[0-9]+' | head -1 | grep -oE '[0-9]+'; }
G0=$(nodes "$GLOBAL")
recall init --db "$DB" >/dev/null 2>&1
printf '{"mcpServers":{"recall":{"type":"stdio","command":"recall-mcp","env":{"RECALL_DB":"%s"}}}}\n' "$DB" > "$CFG"
TOOLS=(--allowedTools mcp__recall__recall_write mcp__recall__recall_compile mcp__recall__recall_search mcp__recall__recall_cell)
TERSE="Be terse: reply in at most two short plain-text lines. No markdown headers, no bullet lists, no insight blocks, no preamble — just the answer."
agent(){ printf '%s│ %sclaude%s '; claude -p "$1" --append-system-prompt "$TERSE" --mcp-config "$CFG" --strict-mcp-config "${TOOLS[@]}" --output-format text 2>&1 | sed "s/^/${cyan}│${off}   ${grey}/; s/$/${off}/"; }
proof(){ printf '%s│   %s%s\n' "$cyan" "$dim" "$off"; recall compile "$1" --db "$DB" 2>/dev/null | grep -iE "$2" | head -4 | sed "s/^/${cyan}│   ${green}/; s/$/${off}/"; }

# ===========================================================================
scene "MONDAY · sprint planning"
narrate "The team settles the background-job queue. The agent writes the decision"
narrate "to Recall — durable memory that outlives this chat window."
human "We're finalizing architecture. Decision: the background job queue uses Redis Streams — simple, already in our stack. Save this decision to Recall (recall_write) for future sessions."
beat
agent "We're finalizing architecture. Decision: the background job queue uses Redis Streams — simple, already in our stack. Save this decision to Recall (recall_write, kind decision, topics queue,architecture, confidence 0.9) for future sessions. Reply with the cell id."
narrate "It is now a structured cell in the graph — not a line in a context window that vanishes when the session ends."
proof "background job queue decision" "redis|eff:"
# Capture the decision's cell id the way a teammate would cite it next session (a
# PR/ticket reference). Makes the supersede deterministic instead of relying on the
# agent re-finding the cell by search — which can miss, and then it (correctly)
# refuses to fabricate a contradicts link to a cell it cannot see.
PRIOR=$(recall search "background job queue Redis Streams" --db "$DB" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
beat

scene "WEDNESDAY · load-test post-mortem  (a different session, days later)"
narrate "Throughput tanks under load. A SEPARATE session corrects the plan — and"
narrate "Recall records it as a SUPERSESSION (a contradicts edge), not an overwrite."
human "Load test failed: Redis Streams can't keep up at peak. Moving the job queue to Kafka — supersede the prior decision (cell ${PRIOR:-<id>})."
beat
agent "Record an architecture correction in Recall: the background job queue is moving from Redis Streams to Kafka because Redis Streams could not keep up under load. Use recall_write (kind decision, topics queue,architecture, confidence 0.9) and set evidence.contradicts to the array [\"$PRIOR\"] so the prior decision (cell $PRIOR) is superseded, not duplicated. Reply with the new cell id and confirm the contradicts edge to $PRIOR."
narrate "Both facts now coexist: Kafka is CURRENT, Redis is SUPERSEDED — the history"
narrate "survives, the current answer is unambiguous, computed at read time."
proof "current job queue decision" "kafka|redis|eff:0|challenged|contradicts:"
beat

scene "FRIDAY · a new engineer picks up a ticket  (fresh process, ZERO context)"
narrate "Nobody re-explains Monday or Wednesday. The new agent just asks Recall."
human "I'm adding a background job for invoice emails — what queue should I publish to, and is there any history I should know?"
beat
agent "Using ONLY your Recall memory (recall_compile), answer concisely: for a new background job, what queue should I publish to right now, and what previous choice did it supersede and why?"
narrate "It answered Kafka — the CURRENT decision — and knew Redis was the superseded"
narrate "predecessor, without anyone repeating it. That is memory that stays correct."
beat

scene "the receipt"
printf '%s│%s %sglobal graph untouched:%s before=%s after=%s   %sthe whole story lived in a throwaway db%s\n' \
  "$cyan" "$off" "$bold" "$off" "$G0" "$(nodes "$GLOBAL")" "$grey" "$off"
rm -f "$DB" "$DB-wal" "$DB-shm" "$CFG"
printf '%s└──────────────────────────────────────────────────────────────%s\n' "$cyan" "$off"
printf '\n✦ DEMO_COMPLETE\n'
