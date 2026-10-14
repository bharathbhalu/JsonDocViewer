#!/usr/bin/env bash
# Start Accretion, installing dependencies on first run.
#   ./run.sh            open the way you chose in ⚙ (browser by default)
#   ./run.sh --window   open in its own app window (Chrome / Edge / Brave)
#   ./run.sh --browser  open in a normal browser tab
#   ./run.sh --no-open  just start the server
#   ./run.sh --https    turn HTTPS mode on (remembered; also in ⚙ Settings → HTTPS)
#   ./run.sh --no-https turn HTTPS mode off
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:$PATH"

if [ ! -d node_modules ] || [ ! -d node_modules/node-pty ] || [ ! -d node_modules/ws ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi
# node-pty sometimes ships spawn-helper without +x ("posix_spawnp failed").
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper node_modules/node-pty/build/Release/spawn-helper 2>/dev/null || true
# node-pty is a native module: after a Node upgrade, a copied app folder or a
# different CPU it may not load ("terminal keeps reconnecting"). Rebuild it.
if ! node -e "require('node-pty')" >/dev/null 2>&1; then
  echo "Terminal support (node-pty) doesn't load with $(node -v) — rebuilding it (one time, ~1 min)…"
  npm rebuild node-pty --build-from-source --no-audit --no-fund >/dev/null 2>&1 \
    && echo "node-pty rebuilt." \
    || echo "Could not rebuild node-pty — terminals will be unavailable. Run ./setup.sh --install for details."
  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper node_modules/node-pty/build/Release/spawn-helper 2>/dev/null || true
fi

echo "Starting Accretion at http://localhost:4321"
exec node server.js "$@"
