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

# Icon: the accretion-disk logo (padded macOS version when present)
ICON_SRC="$SCRIPT_DIR/public/icon-mac-1024.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$SCRIPT_DIR/public/icon-512.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$TMP/icon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z $d $d "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
  # osacompile also ships a default icon catalog that newer macOS prefers
  # over applet.icns — remove it so our icon is used.
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile applet" "$APP/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet" "$APP/Contents/Info.plist"
  # Finder caches icons; nudge it.
  touch "$APP" "$APP/Contents/Info.plist"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleName Accretion" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.accretion.launcher" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.accretion.launcher" "$APP/Contents/Info.plist"
# Edits above invalidate osacompile's signature; sign again (ad hoc).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
# Refresh Finder/Dock's icon cache for this app.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
