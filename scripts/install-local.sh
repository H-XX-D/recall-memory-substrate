#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "Recall requires Node 24 or newer. Current: $(node --version)" >&2
  exit 1
fi

npm install
npm run build
npm link

# Install / refresh the Claude Code integration (hook, skill, MCP registration,
# and — unless RECALL_KEEP_AUTOMEMORY=1 — disabling Claude Code's built-in
# auto-memory so agents adopt Recall). Mirrors scripts/install.sh. Idempotent and
# fail-soft: a problem here must never break a local install.
echo
echo "Configuring Claude Code integration…"
if recall claude sync; then
  if [ "${RECALL_KEEP_AUTOMEMORY:-0}" = "1" ]; then
    echo "Kept Claude Code built-in auto-memory (RECALL_KEEP_AUTOMEMORY=1)."
    echo "Enable Recall adoption later with: recall claude disable-auto-memory"
  else
    echo "Disabled Claude Code built-in auto-memory so agents adopt Recall."
    echo "Revert anytime with: recall claude enable-auto-memory"
  fi
else
  echo "Note: Claude Code integration sync was skipped or failed (non-fatal)." >&2
  echo "You can run it manually later: recall claude sync" >&2
fi

echo
echo "Recall installed locally. Try: recall status"

