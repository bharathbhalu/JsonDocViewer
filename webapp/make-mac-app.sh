#!/usr/bin/env bash
# Build Accretion.app: a double-clickable launcher that starts the server in
# the background (if it isn't running) and opens the app window.
#   ./make-mac-app.sh                 -> ../Accretion.app
#   ./make-mac-app.sh ~/Applications  -> ~/Applications/Accretion.app
# Drag the result to the Dock. Server log: ~/.accretion/server.log
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${1:-$SCRIPT_DIR/..}"
APP="$DEST_DIR/Accretion.app"
MODE="${ACCRETION_LAUNCH:---window}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/launch.applescript" <<OSA
do shell script "mkdir -p ~/.accretion; export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH; cd " & quoted form of "$SCRIPT_DIR" & " && (nohup ./run.sh $MODE >> ~/.accretion/server.log 2>&1 &)"
OSA
rm -rf "$APP"
osacompile -o "$APP" "$TMP/launch.applescript"

# Icon from public/icon-512.png
if [ -f "$SCRIPT_DIR/public/icon-512.png" ]; then
  ICONSET="$TMP/icon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$SCRIPT_DIR/public/icon-512.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$SCRIPT_DIR/public/icon-512.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
  touch "$APP"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleName Accretion" "$APP/Contents/Info.plist" 2>/dev/null || true
echo "Built $APP"
