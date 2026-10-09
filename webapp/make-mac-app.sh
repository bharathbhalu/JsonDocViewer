#!/usr/bin/env bash
# Kept for old instructions — everything lives in setup.sh now.
#   ./make-mac-app.sh [DEST_DIR] [--https|--no-https] [--browser]
#   same as: ./setup.sh --app-only [--dest DEST_DIR] [...]
args=()
for a in "$@"; do
  case "$a" in
    -*) args+=("$a") ;;
    *) args+=(--dest "$a") ;;
  esac
done
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.sh" --app-only "${args[@]+"${args[@]}"}"
