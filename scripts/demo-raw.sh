#!/usr/bin/env bash
# Recall raw demo — the receipt. The SAME sequence as demo-cross-session.sh, but
# showing the ACTUAL `recall` CLI stdout: admit JSON, the watch program's
# "tripped": true, and the real compile packet with eff:0.27(challenged) vs
# eff:0.9. No narration, nothing hidden. The unvarnished run a skeptic can
# verify and reproduce:  ./scripts/demo-raw.sh
set -euo pipefail
RECALL="${RECALL:-recall}"
DB="$(mktemp -t recall-raw.XXXXXX).sqlite3"
WORK="$(mktemp -d -t recall-raw.XXXXXX)"
trap 'rm -f "$DB" "$DB"-* ; rm -rf "$WORK"' EXIT

note()   { printf "\033[2m%s\033[0m\n" "$*"; }
prompt() { printf "\033[1;32m$ \033[0m\033[1m%s\033[0m\n" "$*"; }
slim()   { python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('result',d);n=r.get('node',{});e=n.get('data',{}).get('evidence',{});print(json.dumps({'accepted':r.get('accepted'),'id':n.get('id'),'title':n.get('title'),'contradicts':e.get('contradicts',[])},indent=2))"; }
id_of()  { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result',d).get('node',{}).get('id') or d.get('id') or '')"; }
mk() { cat > "$2" <<JSON
{ "schema_version":"recall.write.v1","actor":{"kind":"human","id":"you","display":"You"},
  "intent":{"kind":"decision","operation":"create"},
  "content":{"title":"$1","body":"$1","summary":"$1"},
  "scope":{"project":"demo","path":".","tenant":"local"},
  "tags":{"category":["memory"],"type":["decision"],"subject":["infra"],"project":["demo"],"idea":["prod-db"],"timestamp":["2026-06-16"],"topics":["infra","production-db"],"entities":["production-db"],"identities":["you"],"rings":["adapter"],"lifecycle":["active"],"quality":["source-grounded"],"sensitivity":["private"],"permission":["read"]},
  "evidence":{"source_refs":[],"depends_on":[],"supports":[],"contradicts":$3,"concerns":[]},
  "confidence":{"value":0.9,"uncertainty":0.07,"concern":0.03,"source_quality":"high","stability":"stable"},
  "provenance":{"created_at":"2026-06-16T00:00:00.000Z","origin":"human","produced_by":"you","verification":"checked","signature_status":"unsigned"},
  "policy":{"sensitivity":"private","allow_background_use":true,"requires_review":false,"expires_at":null,"reverify_after":null} }
JSON
}

note "# ── RAW RUN · real recall CLI · real SQLite · nothing hidden ──"; echo

note "# process 1 — learn a fact"
mk "Prod DB on db-east-1" "$WORK/v1.json" "[]"
prompt "recall admit --json v1.json --db \$DB    # 'prod DB is on db-east-1'"
"$RECALL" admit --json "$WORK/v1.json" --db "$DB" | tee "$WORK/r1.json" | slim; echo
V1=$(id_of < "$WORK/r1.json")

note "# arm a standing watch program over that belief, and take its baseline NOW"
printf '{ "kind":"evidence-bundle","title":"watch: production DB","members":[{"nodeId":"%s","role":"claim"}] }' "$V1" > "$WORK/edge.json"
HID=$("$RECALL" hyperedge add --json "$WORK/edge.json" --db "$DB" | id_of)
printf '{ "schemaVersion":"recall.program.v1","operation":"watch","params":{"delta":0.1} }' > "$WORK/prog.json"
PID=$("$RECALL" program add "$HID" --json "$WORK/prog.json" --db "$DB" | id_of)
twatch() { "$RECALL" program run "$PID" --db "$DB" | python3 -c "import sys,json;d=json.load(sys.stdin)['output'];print(json.dumps({'previous':d.get('previous'),'current':d.get('current'),'tripped':d.get('tripped')},indent=2))"; }
prompt "recall program run ${PID:0:8} --db \$DB    # baseline, BEFORE any correction"
twatch; echo

note "# process 1 — correct it; the new fact's evidence.contradicts points at the first"
mk "Prod DB migrated to db-west-2" "$WORK/v2.json" "[\"$V1\"]"
prompt "recall admit --json v2.json --db \$DB    # 'migrated to db-west-2', contradicts ${V1:0:8}"
"$RECALL" admit --json "$WORK/v2.json" --db "$DB" | slim; echo

prompt "recall program run ${PID:0:8} --db \$DB    # SAME watch, after the correction landed"
twatch; echo

note "# ── NEW PROCESS. zero shared memory. only the .sqlite3 file persists. ──"; echo
prompt "recall compile \"where does the production database live\" --db \$DB"
"$RECALL" compile "where does the production database live" --db "$DB" | grep -E "relevant_memory:|eff:0|decision:.*db-(east|west)" | sed 's/; facets=.*//' | head -8
echo
note "# ↑ a FRESH process read the persisted graph: db-east-1 -> eff:0.27(challenged), db-west-2 -> eff:0.9."
note "#   it knows the current answer AND that the old one was superseded. nobody re-told it."
