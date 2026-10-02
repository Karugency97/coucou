#!/bin/bash
# Builds Coucou (Release, ad-hoc signed — for this Mac only), installs it in /Applications,
# installs openclaw-bridge in Application Support and (re)starts its launchd agent.
# Re-run after each `git pull` to update both.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT="$HOME/Library/Application Support/NotchBuddy"
BRIDGE_DIR="$APP_SUPPORT/openclaw-bridge"
LABEL="fr.karugency.coucou-openclaw"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/NotchBuddy/openclaw-bridge.log"

# 1. App — ad-hoc signature: no Developer ID needed, but the build only runs on this Mac.
cd "$REPO/NotchBuddy"
xcodegen >/dev/null
xcodebuild -scheme NotchBuddy -configuration Release -derivedDataPath build \
  CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= OTHER_CODE_SIGN_FLAGS= -quiet build
git -C "$REPO" checkout -- NotchBuddy/NotchBuddy.xcodeproj 2>/dev/null || true  # xcodegen churn

pkill -x Coucou 2>/dev/null && sleep 1 || true
rm -rf /Applications/Coucou.app
cp -R build/Build/Products/Release/Coucou.app /Applications/
echo "✓ /Applications/Coucou.app"

# 2. Bridge — copied out of the repo so it does not depend on this checkout.
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node || true)"; do
  [ -x "$candidate" ] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'; then
    NODE="$candidate"; break
  fi
done
[ -n "$NODE" ] || { echo "Node >= 22.19 not found (brew install node)"; exit 1; }

mkdir -p "$BRIDGE_DIR" "$(dirname "$LOG")"
cp "$REPO/openclaw-bridge/"{bridge.mjs,package.json,package-lock.json} "$BRIDGE_DIR/"
(cd "$BRIDGE_DIR" && PATH="$(dirname "$NODE"):$PATH" npm ci --omit=dev --silent)
echo "✓ $BRIDGE_DIR (node $("$NODE" --version))"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$BRIDGE_DIR/bridge.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do  # bootout is asynchronous
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ launchd agent $LABEL"

open /Applications/Coucou.app
echo "Done. Enable Settings → Launch at startup in Coucou once."
