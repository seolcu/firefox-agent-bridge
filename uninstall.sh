#!/usr/bin/env bash
# Remove Firefox Agent Bridge. Restart Firefox afterwards.
set -Eeuo pipefail
APP_ID="{ec8030f7-c20a-464f-9b0e-13a3a9e97384}"
sudo rm -f "/usr/lib64/mozilla/extensions/${APP_ID}/firefox-agent-bridge@seolcu.github.io.xpi" \
           "/usr/lib64/mozilla/native-messaging-hosts/firefox_agent_bridge.json" \
           /usr/lib64/firefox/defaults/pref/firefox-agent-bridge-autoconfig.js \
           /usr/lib64/firefox/firefox-agent-bridge.cfg
claude mcp remove --scope user firefox 2>/dev/null || true
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/firefox-agent-bridge"   # screenshots saved with save_to_disk
rm -rf "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/firefox-agent-bridge/active"   # activity markers
echo "Removed. extensions.startupScanScopes stays in the profile's user.js (harmless); delete that line if you want."
