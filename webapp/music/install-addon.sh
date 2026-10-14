#!/bin/bash
# Accretion music analysis add-on: installs a private Python 3.11 venv with
# Demucs (stems), Basic Pitch (notes) and librosa (tempo / key / chords /
# sections) into ~/.accretion/music. Nothing goes into the app or data folder.
#
#   music/install-addon.sh            install or update
#   music/install-addon.sh --remove   delete ~/.accretion/music
#
# Prints "PROGRESS <0-100> <message>" lines (read by the server's install job).
set -euo pipefail

ADDON_DIR="${ACCRETION_MUSIC_DIR:-$HOME/.accretion/music}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION=1

say() { echo "PROGRESS $1 $2"; }

if [ "${1:-}" = "--remove" ]; then
  say 10 "Removing $ADDON_DIR"
  rm -rf "$ADDON_DIR"
  say 100 "Removed"
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$ADDON_DIR"
export UV_PYTHON_INSTALL_DIR="$ADDON_DIR/python"
export UV_CACHE_DIR="$ADDON_DIR/cache"

say 2 "Checking ffmpeg and uv"
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v uv >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is needed to install ffmpeg and uv: https://brew.sh" >&2
    exit 1
  fi
  command -v ffmpeg >/dev/null 2>&1 || { say 4 "Installing ffmpeg (Homebrew)"; brew install ffmpeg; }
  command -v uv >/dev/null 2>&1 || { say 8 "Installing uv (Homebrew)"; brew install uv; }
fi

say 12 "Creating Python 3.11 environment"
uv venv --quiet --allow-existing --python 3.11 "$ADDON_DIR/venv"
PY="$ADDON_DIR/venv/bin/python"

say 20 "Installing PyTorch (largest download)"
uv pip install --quiet --python "$PY" "torch==2.5.1" "torchaudio==2.5.1" "numpy<2"

say 50 "Installing Demucs (stems)"
uv pip install --quiet --python "$PY" "demucs==4.0.1" "soundfile>=0.12"

say 62 "Installing Basic Pitch (notes) and librosa"
uv pip install --quiet --python "$PY" "basic-pitch==0.4.0" "librosa==0.10.2.post1" "numpy<2" "setuptools<81"

say 78 "Downloading models"
"$PY" "$HERE/worker.py" warmup | while IFS= read -r line; do
  case "$line" in
    *'"progress"'*) pct=$("$PY" -c 'import json,sys;print(int(78+json.loads(sys.argv[1])["progress"]*18))' "$line"); msg=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1]).get("msg",""))' "$line"); say "$pct" "$msg" ;;
    *'"error"'*) echo "$line" >&2; exit 1 ;;
  esac
done

say 97 "Cleaning the download cache"
uv cache clean --quiet >/dev/null 2>&1 || true
rm -rf "$UV_CACHE_DIR"

"$PY" - "$ADDON_DIR/addon.json" "$VERSION" <<'PYEOF'
import json, sys, time
json.dump({'version': int(sys.argv[2]), 'installed': time.strftime('%Y-%m-%dT%H:%M:%S')}, open(sys.argv[1], 'w'))
PYEOF
say 100 "Music analysis is ready"
