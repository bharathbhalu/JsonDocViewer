#!/usr/bin/env bash
# Stop every running Accretion: all server copies (this folder or any other
# copy of the app) and the Accretion app windows.
#   ./stop.sh                 stop servers and close Accretion windows
#   ./stop.sh --keep-windows  stop servers only
#   ./stop.sh --dry-run       only list what would be stopped
# Only Accretion processes are touched: a node process counts as Accretion
# when it runs server.js from a folder that contains this app's files.
set -uo pipefail

KEEP_WINDOWS=0
DRY=0
for a in "$@"; do
  case "$a" in
    --keep-windows) KEEP_WINDOWS=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "Unknown option: $a"; exit 2 ;;
  esac
done

is_accretion_dir() {
  [ -f "$1/server.js" ] && [ -f "$1/public/ideas.js" ] && grep -q "Accretion" "$1/server.js" 2>/dev/null
}

pids=()
# 1. node processes running server.js from an Accretion folder.
while read -r pid; do
  [ -z "$pid" ] && continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  args="$(ps -o args= -p "$pid" 2>/dev/null)"
  script="$(printf '%s\n' "$args" | grep -oE '[^ ]*server\.js' | head -1)"
  case "$script" in
    /*) dir="$(dirname "$script")" ;;
    *)  dir="$cwd/$(dirname "$script")" ;;
  esac
  if is_accretion_dir "$dir"; then pids+=("$pid"); fi
done < <(pgrep -f 'node.*server\.js' 2>/dev/null)

# 2. Whatever node process holds port 4321 if it is Accretion.
for pid in $(lsof -ti tcp:4321 -sTCP:LISTEN 2>/dev/null); do
  if curl -s -m 2 http://localhost:4321/api/config 2>/dev/null | grep -q '"dataDir"'; then pids+=("$pid"); fi
done

# Unique
uniq_pids=()
for p in "${pids[@]+"${pids[@]}"}"; do
  case " ${uniq_pids[*]-} " in *" $p "*) ;; *) uniq_pids+=("$p") ;; esac
done

if [ ${#uniq_pids[@]} -eq 0 ]; then
  echo "No Accretion server running."
else
  for p in "${uniq_pids[@]}"; do
    echo "$([ "$DRY" -eq 1 ] && echo "Would stop" || echo "Stopping") Accretion server (pid $p): $(ps -o args= -p "$p" 2>/dev/null)  [$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)]"
    [ "$DRY" -eq 1 ] || kill "$p" 2>/dev/null
  done
  # Give them a moment, then force any that are still alive.
  [ "$DRY" -eq 1 ] || sleep 1
  for p in "${uniq_pids[@]}"; do
    if [ "$DRY" -eq 0 ] && kill -0 "$p" 2>/dev/null; then echo "  pid $p did not exit — forcing"; kill -9 "$p" 2>/dev/null; fi
  done
fi

if [ "$DRY" -eq 1 ]; then
  wp="$(pgrep -f -- "--user-data-dir=$HOME/.accretion/window-profile" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$KEEP_WINDOWS" -eq 1 ] || echo "Would close Accretion windows ($wp window process(es))."
  echo "(dry run — nothing was stopped)"
  exit 0
fi

# 3. Accretion app windows (Chrome/Edge/Brave app mode with Accretion's own
#    profile). Installed web apps are closed by name.
if [ "$KEEP_WINDOWS" -eq 0 ]; then
  wpids="$(pgrep -f -- "--user-data-dir=$HOME/.accretion/window-profile" 2>/dev/null || true)"
  if [ -n "$wpids" ]; then
    echo "Closing Accretion windows."
    # Main browser process first (the one without --type=), then the rest.
    for p in $wpids; do ps -o args= -p "$p" 2>/dev/null | grep -q -- '--type=' || kill "$p" 2>/dev/null; done
    sleep 1
    for p in $(pgrep -f -- "--user-data-dir=$HOME/.accretion/window-profile" 2>/dev/null); do kill "$p" 2>/dev/null; done
  fi
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e 'tell application "System Events" to set names to name of every process whose name is "Accretion"' \
      -e 'if names is not {} then tell application "Accretion" to quit' >/dev/null 2>&1 || true
  fi
fi

if lsof -ti tcp:4321 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 4321 is still in use by: $(ps -o args= -p "$(lsof -ti tcp:4321 -sTCP:LISTEN | head -1)" 2>/dev/null)"
  echo "(Not an Accretion server, so it was left alone.)"
else
  echo "Done. Port 4321 is free."
fi
