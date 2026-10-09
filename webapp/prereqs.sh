#!/usr/bin/env bash
# Kept for old instructions — everything lives in setup.sh now.
#   ./prereqs.sh [--install] [--yes] [--remote user@host] [--skip-optional]
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.sh" "$@"
