#!/usr/bin/env bash
# Start JsonDocViewer, installing dependencies on first run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:$PATH"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting JsonDocViewer at http://localhost:${PORT:-4321}"
exec node server.js
