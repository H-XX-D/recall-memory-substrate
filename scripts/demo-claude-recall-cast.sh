#!/usr/bin/env bash
# Video cast of the Claude Code + Recall cross-session demo (rendered by VHS into
# assets/recall-claude-demo.mp4). The recall graph is REAL and built live; the
# `claude →` lines are the actual responses captured from scripts/demo-claude-recall.sh,
# trimmed to one line each for a shareable length. Fully isolated; nothing leaves /tmp.
set -u
DB="$(mktemp -t recall-cast.XXXXXX.sqlite3)"; rm -f "$DB"
H="$HOME/.claude/skills/recall/scripts/recall_helper.py"
[ -f "$H" ] || H="$(dirname "$0")/../integrations/claude/skill/scripts/recall_helper.py"

b=$'\033[1m'; o=$'\033[0m'; cy=$'\033[1;36m'; ye=$'\033[1;33m'; gn=$'\033[1;32m'; gr=$'\033[90m'; mg=$'\033[1;35m'
p=0.9   # beat pacing
scene(){ printf '\n%s┌─ %s %s\n' "$cy" "$1" "$o"; sleep "$p"; }
nar(){   printf '%s│%s %s▸ %s%s\n' "$cy" "$o" "$ye" "$1" "$o"; sleep "$p"; }
you(){   printf '%s│%s %s🧑 you →%s %s\n' "$cy" "$o" "$b" "$o" "$1"; sleep 1.3; }
cla(){   printf '%s│%s %sclaude →%s %s%s%s\n' "$cy" "$o" "$mg" "$o" "$gn" "$1" "$o"; sleep 1.6; }
adm(){ # build+admit a cell into the live isolated graph (what the agent's recall_write did)
  python3 "$H" --kind decision --title "$1" --body "$2" --confidence 0.9 --topics "queue,architecture" ${3:+--contradicts "$3"} > /tmp/cast_$$.json 2>/dev/null
  recall admit --json /tmp/cast_$$.json --db "$DB" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }
graph(){ printf '%s│%s %s$ recall compile "%s"%s\n' "$cy" "$o" "$gr" "$1" "$o"; sleep 0.6
  local out; out=$(recall compile "$1" --db "$DB" 2>/dev/null)
  # clean memory titles (drop bodies and the long cell_state/edge id noise)
  echo "$out" | grep -E '^- [A-Z]' | grep -vE '^- decision:' | sed -E 's/:.*\[/  [/; s/\[(decision|contradicts):/[/' | sed "s/^- /${cy}│${o}   ${gn}• ${o}/" | cut -c1-78 | head -3
  # compact effective-confidence summary parsed from the live packet
  echo "$out" | grep -oE 'subject=[^|]*eff:[0-9.]+\([a-z]*\)?' >/dev/null 2>&1
  echo "$out" | grep -E 'state=active' | sed -E 's/.*title=([^;]{0,26}).*conf:[0-9.]+\/eff:([0-9.]+)(\(([a-z]+)\))?.*/\1|\2|\4/' | while IFS='|' read -r t e c; do
    [ -n "$t" ] && printf '%s│%s     %seff %-4s%s  %s%s%s\n' "$cy" "$o" "$ye" "$e" "$o" "$([ -n "$c" ] && echo "$gr($c)$o" || echo "${gn}(current)$o")" "" " — ${t}"; done
  echo "$out" | grep -qiE 'contradicts:' && printf '%s│%s     %s↳ contradicts edge: kafka → redis%s\n' "$cy" "$o" "$mg" "$o"
  sleep 2.2; }

clear
printf '%s  Claude Code + Recall — durable memory across sessions%s\n' "$b" "$o"
printf '%s  three separate `claude` sessions · one graph · no shared chat%s\n' "$gr" "$o"; sleep 1.5
recall init --db "$DB" >/dev/null 2>&1

scene "MONDAY · sprint planning"
nar "the agent writes the decision to Recall — memory that outlives the chat"
you "the background job queue will use Redis Streams. save this to Recall."
R=$(adm "Background job queue uses Redis Streams" "Decision: the background job queue runs on Redis Streams — simple, already in our stack.")
cla "saved decision ${R:0:8}.  (conf 0.9→0.70 — Recall makes confidence earn evidence)"
graph "background job queue decision" "Redis Streams|eff:"

scene "WEDNESDAY · load-test post-mortem  (new session, days later)"
nar "a separate session corrects it — as a SUPERSESSION, not an overwrite"
you "Redis can't keep up at peak. moving to Kafka — supersede ${R:0:8}."
K=$(adm "Background job queue moves to Kafka" "Correction: the job queue moves from Redis Streams to Kafka; Redis Streams could not keep up under load." "$R")
cla "wrote Kafka ${K:0:8} — contradicts → ${R:0:8}.  superseded, not overwritten."
graph "current job queue decision" "Kafka|Redis|eff:0|challenged|contradicts:"

scene "FRIDAY · new engineer, fresh process, ZERO prior context"
nar "nobody re-explains Monday or Wednesday — the new agent just asks Recall"
you "adding a background job — what queue do I publish to, any history?"
cla "Publish to Kafka — it superseded Redis Streams (now challenged, eff 0.27)."
sleep 1.5

printf '\n%s│%s %severy session was a fresh process. the answer lived in the graph,%s\n' "$cy" "$o" "$ye" "$o"
printf '%s│%s %scurrent vs stale computed at read time from a contradicts edge.%s\n' "$cy" "$o" "$ye" "$o"
printf '%s└──────────────────────────────────────────────────────────%s\n' "$cy" "$o"; sleep 2.5
rm -f "$DB" "$DB-wal" "$DB-shm" /tmp/cast_$$.json
