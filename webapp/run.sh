#!/usr/bin/env bash
# Start Accretion, installing dependencies on first run.
#   ./run.sh            open the way you chose in ⚙ (browser by default)
#   ./run.sh --window   open in its own app window (Chrome / Edge / Brave)
#   ./run.sh --browser  open in a normal browser tab
#   ./run.sh --no-open  just start the server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:$PATH"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Accretion at http://localhost:4321"
exec node server.js "$@"
