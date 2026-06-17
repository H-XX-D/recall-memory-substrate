#!/usr/bin/env bash
# Recall hero demo — correct the AI once, and a brand-new session already knows.
#
# ACT 1: tell Recall a fact, correct it, then open a NEW session with zero context —
#        it already knows the current answer AND that the old one was superseded.
# ACT 2: a standing tripwire fires the moment a watched belief is overruled (no query),
#        and the correction goes both ways — flip it back and the chain re-resolves.
#
# Self-contained: real `recall` CLI, a throwaway database, no API key, no network.
#   ./scripts/demo-cross-session.sh
set -euo pipefail

RECALL="${RECALL:-recall}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/dist/src/index.js"
EVID="$ROOT/dist/src/core/evidence.js"
if [ ! -f "$INDEX" ]; then echo "Build first:  npm run build"; exit 1; fi
DB="$(mktemp -t recall-demo.XXXXXX).sqlite3"
WORK="$(mktemp -d -t recall-demo.XXXXXX)"
trap 'rm -f "$DB" "$DB"-* ; rm -rf "$WORK"' EXIT

# helper: print each active belief as CURRENT (uncontradicted) or SUPERSEDED
# (something contradicts it) — read straight from the persisted graph.
cat > "$WORK/believes.mjs" <<'MJS'
const [,, db, indexPath, evidPath] = process.argv;
const { SQLiteRecallStore } = await import(indexPath);
const { effectiveConfidence, calibrationFactors } = await import(evidPath);
const store = new SQLiteRecallStore(db);
const f = calibrationFactors(store);
const rows = store.listNodes(50).filter((n) => n.status === "active")
  .map((n) => ({ t: n.title, ch: effectiveConfidence(store, n, f).challengers }))
  .sort((a, b) => a.ch - b.ch);
for (const r of rows) {
  if (r.ch > 0) console.log(`   \x1b[2m✗ SUPERSEDED  ${r.t}\x1b[0m`);
  else console.log(`   \x1b[32m✓ CURRENT     ${r.t}\x1b[0m`);
}
store.close?.();
MJS

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
green(){ printf "\033[32m%s\033[0m\n" "$1"; }
red()  { printf "\033[31m%s\033[0m\n" "$1"; }
# reveal pacing for screen-recording (DEMO_PACE=1); no-op otherwise
pace() { [ -n "${DEMO_PACE:-}" ] && sleep "${1:-1}" || true; }

# recall.write.v1 proposal: file title body [contradicts-id]
write_proposal() {
  local file="$1" title="$2" body="$3" contradicts="${4:-}"
  local cjson="[]"; [ -n "$contradicts" ] && cjson="[\"$contradicts\"]"
  cat > "$file" <<JSON
{ "schema_version": "recall.write.v1",
  "actor": { "kind": "human", "id": "you", "display": "You" },
  "intent": { "kind": "decision", "operation": "create" },
  "content": { "title": "$title", "body": "$body", "summary": "$title" },
  "scope": { "project": "demo", "path": ".", "tenant": "local" },
  "tags": { "category": ["memory"], "type": ["decision"], "subject": ["infra"],
    "project": ["demo"], "idea": ["prod-db"], "timestamp": ["2026-06-16"],
    "topics": ["infra","production-db"], "entities": ["production-db"], "identities": ["you"],
    "rings": ["adapter"], "lifecycle": ["active"], "quality": ["source-grounded"],
    "sensitivity": ["private"], "permission": ["read"] },
  "evidence": { "source_refs": [], "depends_on": [], "supports": [], "contradicts": $cjson, "concerns": [] },
  "confidence": { "value": 0.9, "uncertainty": 0.07, "concern": 0.03, "source_quality": "high", "stability": "stable" },
  "provenance": { "created_at": "2026-06-16T00:00:00.000Z", "origin": "human", "produced_by": "you", "verification": "checked", "signature_status": "unsigned" },
  "policy": { "sensitivity": "private", "allow_background_use": true, "requires_review": false, "expires_at": null, "reverify_after": null } }
JSON
}
jq_id() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result',d).get('node',{}).get('id') or d.get('id') or '')"; }

# arm a standing tripwire (watch program) over a belief; echoes the program id
arm_tripwire() {
  local cell="$1"
  printf '{ "kind": "evidence-bundle", "title": "watch: production DB", "members": [ { "nodeId": "%s", "role": "claim" } ] }' "$cell" > "$WORK/edge.json"
  local hid; hid=$("$RECALL" hyperedge add --json "$WORK/edge.json" --db "$DB" | jq_id)
  printf '{ "schemaVersion": "recall.program.v1", "operation": "watch", "params": { "delta": 0.1 } }' > "$WORK/prog.json"
  local pid; pid=$("$RECALL" program add "$hid" --json "$WORK/prog.json" --db "$DB" | jq_id)
  "$RECALL" program run "$pid" --db "$DB" >/dev/null   # baseline tick (never trips)
  echo "$pid"
}
# run a tripwire; prints a banner iff it fired
check_tripwire() {
  local pid="$1"
  if "$RECALL" program run "$pid" --db "$DB" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('output',{}).get('tripped') is True else 1)"; then
    pace 0.8
    red "   🚨 TRIPWIRE: the 'production DB' belief was overruled — surfaced unprompted, no query."
  fi
}
# what a fresh session believes — current vs superseded, read from the graph
believes() { pace 0.8; node --disable-warning=ExperimentalWarning "$WORK/believes.mjs" "$DB" "$INDEX" "$EVID"; }

echo; bold "════════════════ ACT 1 · it remembers your correction ════════════════"
echo; bold "── SESSION 1 ──  you tell Recall a fact"
write_proposal "$WORK/v1.json" "Prod DB on db-east-1" "Production Postgres is on db-east-1.internal (us-east)."
V1=$("$RECALL" admit --json "$WORK/v1.json" --db "$DB" | jq_id)
dim "   you: \"our production DB is on db-east-1\""
TRIP1=$(arm_tripwire "$V1"); dim "   (a standing tripwire is now watching this belief)"

echo; bold "── SESSION 2 ──  later, you correct it"
write_proposal "$WORK/v2.json" "Prod DB migrated to db-west-2" "We migrated production Postgres off db-east-1 to db-west-2.internal during the June cutover." "$V1"
V2=$("$RECALL" admit --json "$WORK/v2.json" --db "$DB" | jq_id)
dim "   you: \"actually we migrated — it's db-west-2 now\""
check_tripwire "$TRIP1"

echo; pace 1; dim "   …close the chat. close the laptop. zero context carried over."; pace 1.2

echo; bold "── SESSION 3 ──  a BRAND-NEW session. it never saw sessions 1 or 2."
dim "   you: \"where does the production database live?\""; echo
believes "where does the production database live"
echo; green "   → current: db-west-2.  superseded: db-east-1.  You never re-told it."; pace 1.5

echo; echo; bold "════════════════ ACT 2 · it goes both ways, and it watches ════════════════"
echo; bold "── SESSION 4 ──  the migration gets rolled back"
TRIP2=$(arm_tripwire "$V2"); dim "   (tripwire now watching the db-west-2 belief)"
write_proposal "$WORK/v3.json" "Prod DB rolled back to db-east-1" "db-west-2 had latency issues; we rolled production back to db-east-1.internal." "$V2"
"$RECALL" admit --json "$WORK/v3.json" --db "$DB" >/dev/null
dim "   you: \"west-2 had problems — we rolled back to db-east-1\""
check_tripwire "$TRIP2"

echo; pace 0.8; bold "── SESSION 5 ──  another brand-new session. just ask again."
dim "   you: \"where does the production database live?\""; echo
believes "where does the production database live"
echo
green "   → the chain re-resolved: db-east-1 is current again, db-west-2 is now superseded."; pace 1.5
dim   "     east → west → back to east. The latest correction always wins; the history stays intact."
echo
dim   "   Every memory system can store a fact. Recall hands each new session the RESOLUTION —"
dim   "   what's current, what was overruled, and a tripwire that fires the moment it changes."
echo
