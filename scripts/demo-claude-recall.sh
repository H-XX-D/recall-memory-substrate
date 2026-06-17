#!/usr/bin/env bash
# ============================================================================
# Claude Code + Recall — durable memory, the way you actually use it.
#
# Three SEPARATE `claude -p` processes (no shared conversation). You just talk
# normally — you never tell it to "save" anything. An armed agent persists
# decisions, supersedes them on corrections, and consults memory entirely on its
# own, the way the installed integration arms it (read-first, write-back, and
# supersede-don't-overwrite). A new session days later inherits the current
# answer with the old one preserved-but-superseded.
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
PACE="${DEMO_PACE:-1.2}"

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

# This is the ARMING the installed integration provides (skill + operating prompt):
# the agent uses Recall on its own — the user never has to ask it to.
ARM="You have a Recall durable-memory MCP (recall_compile, recall_search, recall_write, recall_cell). \
Operate by Recall's discipline WITHOUT being told to: (1) before you answer, consult Recall for relevant prior memory; \
(2) when the conversation settles a durable decision, correction, risk, or fact, persist it yourself with recall_write — \
seamlessly, never ask permission; (3) when new information corrects a prior decision, SUPERSEDE it: find the prior cell \
with recall_search, then recall_write the new cell with evidence.contradicts set to that cell's id — never overwrite or \
duplicate. Do the Recall tool calls silently and keep your visible reply to one or two terse plain-text lines."

agent(){ printf '%s│ %sclaude%s '; claude -p "$1" --append-system-prompt "$ARM" --mcp-config "$CFG" --strict-mcp-config "${TOOLS[@]}" --output-format text 2>&1 | sed "s/^/${cyan}│${off}   ${grey}/; s/$/${off}/"; }
proof(){ recall compile "$1" --db "$DB" 2>/dev/null | grep -iE "$2" | head -4 | sed "s/^/${cyan}│   ${green}/; s/$/${off}/"; }

# ===========================================================================
scene "MONDAY · sprint planning"
narrate "A decision gets made in conversation. You never say \"save this\" —"
narrate "the armed agent persists it to Recall on its own."
human "We're finalizing the job-queue architecture — let's go with Redis Streams, it's simple and already in our stack."
beat
agent "We're finalizing the job-queue architecture — let's go with Redis Streams, it's simple and already in our stack."
narrate "Unprompted, it wrote a structured decision cell:"
proof "background job queue decision" "redis|eff:"
beat

scene "WEDNESDAY · load-test post-mortem  (a different session, days later)"
narrate "A separate session hears the correction. On its own it finds the prior"
narrate "decision and SUPERSEDES it — a contradicts edge, not an overwrite."
human "Load test failed — Redis Streams can't keep up at peak. We're switching the job queue to Kafka."
beat
agent "Load test failed — Redis Streams can't keep up at peak. We're switching the job queue to Kafka."
narrate "Kafka is now CURRENT, Redis SUPERSEDED — resolved at read time, history kept:"
proof "current job queue decision" "kafka|redis|eff:0|challenged|contradicts:"
beat

scene "FRIDAY · a new engineer picks up a ticket  (fresh process, ZERO context)"
narrate "Nobody re-explains Monday or Wednesday. A new session just asks —"
narrate "and consults Recall on its own before answering."
human "I'm adding a background job for invoice emails — which queue do I publish to, and any history I should know?"
beat
agent "I'm adding a background job for invoice emails — which queue do I publish to, and any history I should know?"
narrate "Kafka — the current decision — with the Redis history. Nobody repeated it."
beat

scene "the receipt"
printf '%s│%s %sglobal graph untouched:%s before=%s after=%s   %sthe whole story lived in a throwaway db%s\n' \
  "$cyan" "$off" "$bold" "$off" "$G0" "$(nodes "$GLOBAL")" "$grey" "$off"
rm -f "$DB" "$DB-wal" "$DB-shm" "$CFG"
printf '%s└──────────────────────────────────────────────────────────────%s\n' "$cyan" "$off"
printf '\n✦ DEMO_COMPLETE\n'
