#!/usr/bin/env bash
set -euo pipefail

repo_url="${RECALL_REPO_URL:-https://github.com/H-XX-D/recall-memory-substrate.git}"
install_dir="${RECALL_INSTALL_DIR:-$HOME/.recall-memory-substrate/source}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need git
need node
need npm

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "Recall requires Node 24 or newer. Current: $(node --version)" >&2
  echo "Install Node 24+ first, then rerun this installer." >&2
  exit 1
fi

mkdir -p "$(dirname "$install_dir")"

if [ -d "$install_dir/.git" ]; then
  echo "Updating Recall in $install_dir"
  git -C "$install_dir" fetch origin main
  git -C "$install_dir" checkout main
  git -C "$install_dir" pull --ff-only origin main
elif [ -e "$install_dir" ]; then
  echo "Install path exists but is not a git checkout: $install_dir" >&2
  echo "Set RECALL_INSTALL_DIR to another path or move the existing directory." >&2
  exit 1
else
  echo "Installing Recall into $install_dir"
  git clone --depth 1 "$repo_url" "$install_dir"
fi

cd "$install_dir"
npm install
npm run build
npm link

# Install / refresh the Claude Code integration (hook, skill, MCP registration,
# and — unless RECALL_KEEP_AUTOMEMORY=1 — disabling Claude Code's built-in
# auto-memory so agents adopt Recall). Idempotent: re-runs on every update to
# pull forward the latest bundled "best functional version". Fail-soft: a
# problem here must never block the core install.
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

# Install / refresh the Codex integration (skill, MCP server in config.toml, and a
# Recall directive in ~/.codex/AGENTS.md) only when the Codex CLI is present.
# Idempotent and fail-soft: a problem here must never block the core install.
if command -v codex >/dev/null 2>&1; then
  echo
  echo "Configuring Codex integration…"
  if recall codex sync; then
    echo "Recall wired into Codex (skill, MCP, AGENTS.md directive)."
  else
    echo "Note: Codex integration sync was skipped or failed (non-fatal)." >&2
    echo "You can run it manually later: recall codex sync" >&2
  fi
fi

echo
echo "Recall installed."
echo "Try: recall status"
echo "Docs: $install_dir/README.md"
