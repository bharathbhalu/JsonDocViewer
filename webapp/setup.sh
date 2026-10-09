#!/usr/bin/env bash
# Accretion setup — one script to get a machine ready and build the launcher.
#
# Check / install prerequisites (Node, git, tmux, openssl, node-pty, …):
#   ./setup.sh                           check only, change nothing
#   ./setup.sh --install                 install what's missing (asks first)
#   ./setup.sh --install --yes           install without asking
#   ./setup.sh --remote user@host        also check a remote SSH host (tmux + claude there)
#   ./setup.sh --skip-optional           only required items
#
# Build the macOS launcher (Accretion.app):
#   ./setup.sh --app                     check, then build ../Accretion.app
#   ./setup.sh --app-only                build it without checking
#   ./setup.sh --app --dest ~/Applications
#   ./setup.sh --app --https|--no-https  launcher turns HTTPS mode on / off at start
#   ./setup.sh --app --browser           open in a browser tab instead of a window
#
# Everything at once on a new Mac:   ./setup.sh --install --app
# Works on macOS (Homebrew) and Linux (apt / dnf / yum / pacman); the launcher is macOS only.
# Nothing is installed with sudo unless you run --install and confirm.

set -u

INSTALL=0
YES=0
SKIP_OPTIONAL=0
REMOTES=""
BUILD_APP=0
CHECK=1
APP_DEST=""
APP_MODE="${ACCRETION_LAUNCH:---window}"
APP_HTTPS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --yes|-y) YES=1 ;;
    --skip-optional) SKIP_OPTIONAL=1 ;;
    --remote) shift; REMOTES="$REMOTES ${1:-}" ;;
    --app) BUILD_APP=1 ;;
    --app-only) BUILD_APP=1; CHECK=0 ;;
    --dest) shift; APP_DEST="${1:-}" ;;
    --https|--no-https) APP_HTTPS="$1" ;;
    --window|--browser) APP_MODE="$1" ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"
NODE_MIN_MAJOR=20

# ---------- output helpers ----------
if [ -t 1 ]; then
  G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; B=$'\033[1m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=''; R=''; Y=''; B=''; D=''; N=''
fi
OK=0; MISSING=0; WARN=0
MISSING_REQ=""
ok()   { OK=$((OK + 1));   printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
bad()  { MISSING=$((MISSING + 1)); printf '  %s✘%s %s\n' "$R" "$N" "$*"; }
warn() { WARN=$((WARN + 1)); printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
info() { printf '    %s%s%s\n' "$D" "$*" "$N"; }
section() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  [ "$YES" -eq 1 ] && return 0
  printf '    %s? [y/N] ' "$1"
  read -r ans </dev/tty || return 1
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Package manager
PM=""
if [ "$OS" = "Darwin" ]; then
  have brew && PM="brew"
else
  for p in apt-get dnf yum pacman zypper; do have "$p" && { PM="$p"; break; }; done
fi
SUDO=""
[ "$OS" != "Darwin" ] && [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

pkg_install() { # pkg_install <brew-name> <apt-name> <dnf-name> <pacman-name>
  local name=""
  case "$PM" in
    brew) name="$1"; [ -n "$name" ] && brew install $name ;;
    apt-get) name="$2"; [ -n "$name" ] && $SUDO apt-get update -qq && $SUDO apt-get install -y $name ;;
    dnf|yum) name="$3"; [ -n "$name" ] && $SUDO "$PM" install -y $name ;;
    pacman) name="$4"; [ -n "$name" ] && $SUDO pacman -S --noconfirm $name ;;
    zypper) name="$3"; [ -n "$name" ] && $SUDO zypper install -y $name ;;
    *) return 1 ;;
  esac
}

# offer_install "<what>" "<brew>" "<apt>" "<dnf>" "<pacman>" "<manual hint>"
offer_install() {
  local what="$1" hint="$6"
  if [ "$INSTALL" -eq 1 ] && [ -n "$PM" ]; then
    if confirm "Install $what with $PM"; then
      if pkg_install "$2" "$3" "$4" "$5"; then ok "$what installed"; return 0; fi
      bad "$what install failed"
    fi
  fi
  info "Install: $hint"
  return 1
}

ver_major() { echo "$1" | sed -E 's/^v?([0-9]+).*/\1/'; }

if [ "$CHECK" -eq 1 ]; then
printf '%sAccretion setup — prerequisites%s  %s(%s %s)%s\n' "$B" "$N" "$D" "$OS" "$ARCH" "$N"
[ "$INSTALL" -eq 1 ] && printf '%sInstall mode: missing items will be offered for install.%s\n' "$Y" "$N"

# ---------- platform ----------
section "Platform"
if [ "$OS" = "Darwin" ]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null)"
  if have brew; then
    ok "Homebrew $(brew --version 2>/dev/null | head -1 | awk '{print $2}')"
  else
    bad "Homebrew not found (used to install tmux, node, git)"
    info 'Install: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    [ -x /opt/homebrew/bin/brew ] && info "Found /opt/homebrew/bin/brew — add it to PATH: eval \"\$(/opt/homebrew/bin/brew shellenv)\""
  fi
elif [ "$OS" = "Linux" ]; then
  ok "Linux $( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -r)"
  [ -n "$PM" ] && ok "Package manager: $PM" || warn "No known package manager found — install items manually"
else
  warn "Unsupported OS: $OS (Windows: use WSL2 and run this script inside it)"
fi

# ---------- required ----------
section "Required — app"

# Node.js
if have node; then
  NV="$(node -v)"
  if [ "$(ver_major "$NV")" -ge "$NODE_MIN_MAJOR" ]; then ok "Node.js $NV"
  else
    bad "Node.js $NV is too old (need $NODE_MIN_MAJOR+)"; MISSING_REQ="$MISSING_REQ node"
    offer_install "Node.js" "node" "nodejs" "nodejs" "nodejs" "https://nodejs.org (LTS), or: brew install node / nvm install --lts"
  fi
else
  bad "Node.js not found (need $NODE_MIN_MAJOR+)"; MISSING_REQ="$MISSING_REQ node"
  offer_install "Node.js" "node" "nodejs npm" "nodejs npm" "nodejs npm" "https://nodejs.org (LTS), or: brew install node / nvm install --lts" && have node && ok "Node.js $(node -v)"
fi
if have npm; then ok "npm $(npm -v)"; else bad "npm not found (comes with Node.js)"; MISSING_REQ="$MISSING_REQ npm"; fi

# git — file history, commits
if have git; then ok "git $(git --version | awk '{print $3}')"
else
  bad "git not found (needed for version history and commits)"; MISSING_REQ="$MISSING_REQ git"
  if [ "$OS" = "Darwin" ]; then info "Install: xcode-select --install   (or: brew install git)"
  else offer_install "git" "git" "git" "git" "git" "your package manager"; fi
fi

# openssl — creates the certificates for HTTPS mode
if have openssl; then ok "openssl $(openssl version 2>/dev/null | awk '{print $2}') (HTTPS mode certificates)"
else
  bad "openssl not found (needed for HTTPS mode)"
  offer_install "openssl" "openssl" "openssl" "openssl" "openssl" "brew install openssl  /  sudo apt install openssl"
fi

# curl — used by stop.sh and remote checks
have curl && ok "curl" || { warn "curl not found (used by stop.sh)"; offer_install "curl" "curl" "curl" "curl" "curl" "your package manager"; }

# Port 4321
if have lsof && lsof -nP -iTCP:4321 -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -s -m 2 http://localhost:4321/api/config 2>/dev/null | grep -q '"dataDir"'; then ok "Port 4321 — Accretion is running there"
  else bad "Port 4321 is used by another program: $(lsof -nP -iTCP:4321 -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}')"; info "Accretion only runs on port 4321 — stop that program first"; fi
else
  ok "Port 4321 is free"
fi

# App dependencies
if [ -f "$SCRIPT_DIR/package.json" ]; then
  if [ -d "$SCRIPT_DIR/node_modules/express" ]; then ok "App dependencies installed (node_modules)"
  else
    bad "App dependencies not installed"
    if [ "$INSTALL" -eq 1 ] && have npm && confirm "Run npm install in $SCRIPT_DIR"; then
      (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund) && ok "App dependencies installed"
    else info "Install: cd \"$SCRIPT_DIR\" && npm install   (run.sh also does this on first start)"; fi
  fi
fi

# ---------- required for terminal / tmux ----------
section "Required — terminal & tmux sessions"

if have tmux; then
  TV="$(tmux -V | awk '{print $2}')"
  case "$TV" in [12].*) warn "tmux $TV is old (3.0+ recommended)" ;; *) ok "tmux $TV" ;; esac
else
  bad "tmux not found (keeps terminal sessions alive)"
  offer_install "tmux" "tmux" "tmux" "tmux" "tmux" "brew install tmux  /  sudo apt install tmux" && have tmux && ok "tmux $(tmux -V | awk '{print $2}')"
fi

have ssh && ok "ssh client $(ssh -V 2>&1 | awk '{print $1}' | sed 's/,$//')" || { bad "ssh client not found (needed for SSH terminals / remote Claude)"; offer_install "OpenSSH client" "openssh" "openssh-client" "openssh-clients" "openssh" "your package manager"; }

# Build tools for node-pty (native module the terminal uses)
if [ "$OS" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode command-line tools ($(xcode-select -p))"
  else
    bad "Xcode command-line tools missing (needed to build node-pty)"
    if [ "$INSTALL" -eq 1 ] && confirm "Start the Xcode command-line tools installer"; then xcode-select --install; info "Finish the installer window, then run this script again."
    else info "Install: xcode-select --install"; fi
  fi
else
  MISS_BUILD=""
  have make || MISS_BUILD="$MISS_BUILD make"
  { have g++ || have c++; } || MISS_BUILD="$MISS_BUILD g++"
  if [ -z "$MISS_BUILD" ]; then ok "C/C++ build tools (make, g++)"
  else
    bad "Build tools missing:$MISS_BUILD (needed to build node-pty)"
    offer_install "build tools" "" "build-essential" "gcc-c++ make" "base-devel" "sudo apt install build-essential  /  sudo dnf install gcc-c++ make"
  fi
fi
if have python3; then ok "python3 $(python3 -V 2>&1 | awk '{print $2}') (used by node-gyp)"
else bad "python3 not found (node-gyp needs it to build node-pty)"; offer_install "python3" "python@3" "python3" "python3" "python" "your package manager"; fi

# Real test: can node-pty be built and spawn a shell here? (temp dir; the app is untouched)
if have npm && have node; then
  printf '  … building node-pty in a temporary folder (about 30–90 s)\n'
  TMPD="$(mktemp -d 2>/dev/null || mktemp -d -t accretion)"
  if (cd "$TMPD" && npm init -y >/dev/null 2>&1 && npm install node-pty --no-audit --no-fund --loglevel=error >"$TMPD/npm.log" 2>&1); then
    # Known node-pty packaging bug: its spawn-helper ships without the
    # execute bit ("posix_spawnp failed"). The app's install fixes the same.
    chmod +x "$TMPD"/node_modules/node-pty/prebuilds/*/spawn-helper "$TMPD"/node_modules/node-pty/build/Release/spawn-helper 2>/dev/null
    if (cd "$TMPD" && node -e "
      const pty = require('node-pty');
      const p = pty.spawn(process.env.SHELL || '/bin/sh', ['-c', 'echo pty-ok'], { cols: 80, rows: 24 });
      let out = ''; p.onData((d) => { out += d; });
      p.onExit(() => { process.exit(out.includes('pty-ok') ? 0 : 1); });
      setTimeout(() => process.exit(2), 8000);
    " >/dev/null 2>&1); then ok "node-pty builds and runs a shell"
    else bad "node-pty built but could not start a shell"; info "Log: $TMPD/npm.log"; fi
  else
    bad "node-pty failed to build"
    info "Usually missing build tools (above). Last lines of the log:"
    tail -5 "$TMPD/npm.log" 2>/dev/null | sed 's/^/      /'
    info "Full log: $TMPD/npm.log"
  fi
  [ "$MISSING" -eq 0 ] && rm -rf "$TMPD"
fi

# ---------- optional ----------
if [ "$SKIP_OPTIONAL" -eq 0 ]; then
  section "Optional"

  # Browser for "its own window" mode
  BROWSER=""
  if [ "$OS" = "Darwin" ]; then
    for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium" "Vivaldi"; do
      { [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; } && { BROWSER="$app"; break; }
    done
  else
    for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do have "$b" && { BROWSER="$b"; break; }; done
  fi
  [ -n "$BROWSER" ] && ok "$BROWSER (for opening Accretion in its own window)" || warn "No Chrome / Edge / Brave — Accretion opens in a normal browser tab instead"

  # Claude Code (local Claude terminals)
  if have claude; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"
  else
    warn "Claude Code not found (only needed for local Claude terminals)"
    if [ "$INSTALL" -eq 1 ] && have npm && confirm "Install Claude Code (npm install -g @anthropic-ai/claude-code)"; then
      npm install -g @anthropic-ai/claude-code && ok "Claude Code installed — run 'claude' once to sign in"
    else info "Install: npm install -g @anthropic-ai/claude-code   then run: claude   (to sign in)"; fi
  fi

  # Cursor
  if have cursor || [ -d "/Applications/Cursor.app" ]; then ok "Cursor (for 'Open in Cursor')"
  else warn "Cursor not found (only needed for 'Open in Cursor')"; info "Install from https://cursor.com, then in Cursor: Shell Command → Install 'cursor' command"; fi
  have cursor-agent && ok "cursor-agent CLI" || info "cursor-agent CLI not found (optional, for Cursor's agent in a terminal)"

  # SSH key / agent for SSH terminals
  if ls "$HOME"/.ssh/id_* >/dev/null 2>&1 || [ -f "$HOME/.ssh/config" ]; then ok "SSH keys / config present in ~/.ssh"
  else warn "No SSH keys in ~/.ssh (needed for SSH terminals)"; info "Create one: ssh-keygen -t ed25519   then: ssh-copy-id user@host"; fi
  if ssh-add -l >/dev/null 2>&1; then ok "ssh-agent has keys loaded"
  else info "ssh-agent has no keys loaded (fine if your keys have no passphrase or use the macOS Keychain)"; fi

  # HTTPS mode
  if [ -f "$HOME/.accretion/tls/ca.crt" ]; then
    ok "HTTPS certificate authority exists (~/.accretion/tls/ca.crt)"
    if [ "$OS" = "Darwin" ] && [ -f "$HOME/.accretion/tls/server.crt" ]; then
      if security verify-cert -c "$HOME/.accretion/tls/server.crt" -p ssl >/dev/null 2>&1; then ok "HTTPS certificate trusted on this Mac"
      else info "HTTPS certificate not trusted on this Mac yet (Settings → HTTPS → Trust on this Mac)"; fi
    fi
  else
    info "HTTPS mode not set up yet (turn it on in Accretion: ⚙ Settings → HTTPS, or ./run.sh --https)"
  fi

  # Notifications (macOS)
  if [ "$OS" = "Darwin" ]; then
    have osascript && ok "osascript (desktop notifications for alerts)" || warn "osascript missing — no desktop notifications"
    info "First alert may ask to allow notifications from 'Script Editor' — choose Allow"
  else
    have notify-send && ok "notify-send (desktop notifications)" || info "notify-send not found — alerts show inside Accretion only"
  fi
fi

# ---------- remote hosts ----------
for HOST in $REMOTES; do
  [ -z "$HOST" ] && continue
  section "Remote host: $HOST"
  if ! have ssh; then bad "ssh client missing — cannot check $HOST"; continue; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null; then
    ok "SSH key login works (no password prompt)"
  else
    bad "SSH key login failed (Accretion needs key-based login)"
    info "Set up: ssh-copy-id $HOST   (or add the host to ~/.ssh/config), then test: ssh $HOST"
    continue
  fi
  R_OUT="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" '
    printf "os=%s\n" "$(uname -s) $(uname -m)"
    if command -v tmux >/dev/null 2>&1; then printf "tmux=%s\n" "$(tmux -V | awk "{print \$2}")"; else echo "tmux="; fi
    if command -v claude >/dev/null 2>&1; then printf "claude=%s\n" "$(claude --version 2>/dev/null | head -1)"; else
      for p in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do [ -x "$p" ] && { printf "claude=%s (at %s, not on PATH)\n" "$("$p" --version 2>/dev/null | head -1)" "$p"; break; }; done
    fi
    command -v node >/dev/null 2>&1 && printf "node=%s\n" "$(node -v)"
    printf "sessions=%s\n" "$(tmux ls 2>/dev/null | wc -l | tr -d " ")"
  ' 2>/dev/null)"
  get() { echo "$R_OUT" | sed -n "s/^$1=//p" | head -1; }
  ok "Remote OS: $(get os)"
  if [ -n "$(get tmux)" ]; then ok "tmux $(get tmux) ($(get sessions) session(s) running)"
  else bad "tmux not installed on $HOST"; info "On $HOST: sudo apt install tmux  /  brew install tmux"; fi
  if [ -n "$(get claude)" ]; then
    case "$(get claude)" in *"not on PATH"*) warn "Claude Code: $(get claude)"; info "Add it to PATH in ~/.bashrc / ~/.zshrc on $HOST" ;; *) ok "Claude Code $(get claude)" ;; esac
    info "Make sure you've signed in once on $HOST: ssh -t $HOST claude"
  else
    bad "Claude Code not installed on $HOST (needed for remote Claude)"
    [ -n "$(get node)" ] && info "On $HOST: npm install -g @anthropic-ai/claude-code   then: claude (to sign in)" \
      || info "On $HOST: install Node.js 20+ first, then: npm install -g @anthropic-ai/claude-code"
  fi
done
fi

# ---------- macOS launcher (Accretion.app) ----------
build_app() {
  section "Launcher"
  if [ "$OS" != "Darwin" ]; then warn "Accretion.app is macOS only — start with ./run.sh on this system"; return 0; fi
  local DEST_DIR="${APP_DEST:-$SCRIPT_DIR/..}"
  DEST_DIR="${DEST_DIR/#\~/$HOME}"
  mkdir -p "$DEST_DIR"
  local APP="$DEST_DIR/Accretion.app"
  local FLAGS="$APP_MODE${APP_HTTPS:+ $APP_HTTPS}"
  local TMP ICON_SRC ICONSET s d
  TMP="$(mktemp -d)"
  cat > "$TMP/launch.applescript" <<OSA
do shell script "mkdir -p ~/.accretion; export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH; cd " & quoted form of "$SCRIPT_DIR" & " && (nohup ./run.sh $FLAGS >> ~/.accretion/server.log 2>&1 &)"
OSA
  rm -rf "$APP"
  osacompile -o "$APP" "$TMP/launch.applescript" 2>&1 | grep -v "replacing existing signature" >&2 || true

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
  rm -rf "$TMP"
    ok "Built $APP  (starts with: run.sh $FLAGS)"
    info "Drag it to the Dock. Server log: ~/.accretion/server.log"
}

# ---------- summary ----------
if [ "$BUILD_APP" -eq 1 ]; then
  if [ "$CHECK" -eq 1 ] && [ "$MISSING" -gt 0 ]; then
    warn "Building the launcher anyway — fix the missing items above or Accretion won't start"
  fi
  build_app
fi
[ "$CHECK" -eq 0 ] && exit 0

section "Summary"
printf '  %s%d ok%s   %s%d missing%s   %s%d warnings%s\n' "$G" "$OK" "$N" "$R" "$MISSING" "$N" "$Y" "$WARN" "$N"
if [ "$MISSING" -eq 0 ]; then
  if [ "$BUILD_APP" -eq 1 ] && [ "$OS" = "Darwin" ]; then printf '  %sReady.%s Double-click Accretion.app (or run %s/run.sh --window)\n' "$G" "$N" "$SCRIPT_DIR"
  else printf '  %sReady.%s Start Accretion with: %s/run.sh --window%s\n' "$G" "$N" "$SCRIPT_DIR" "$([ "$OS" = "Darwin" ] && echo '   (or ./setup.sh --app for a Dock launcher)')"; fi
  exit 0
fi
if [ "$INSTALL" -eq 0 ]; then
  printf '  Run %s./setup.sh --install%s to install what is missing (asks before each item).\n' "$B" "$N"
else
  printf '  Some items still need attention (see above). Re-run this script after fixing them.\n'
fi
exit 1
