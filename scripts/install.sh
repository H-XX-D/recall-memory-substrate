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

echo
echo "Recall installed."
echo "Try: recall status"
echo "Docs: $install_dir/README.md"
