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

echo "Recall installed locally. Try: recall status"

