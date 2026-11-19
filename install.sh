#!/usr/bin/env bash
# Install Firefox Agent Bridge on this machine.
#   1. extension  -> system scope (unsigned allowed by Fedora's Firefox build)
#   2. native-messaging host manifest -> /usr/lib64/mozilla/native-messaging-hosts
#      (system dir; the per-user lookup is ~/.mozilla, which we keep out of $HOME)
#   3. profile pref so Firefox scans the system scope at startup
#   4. autoconfig (firefox-agent-bridge.cfg) in the Firefox install dir: opens Firefox's
#      remote control only while Claude Code uses the bridge, for real input
#   5. MCP server registered with Claude Code (user scope) when `claude` is on PATH
# Usage: ./install.sh [profile-dir]   (default: the default-release profile)
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="firefox-agent-bridge@seolcu.github.io"
HOST_NAME="firefox_agent_bridge"
APP_ID="{ec8030f7-c20a-464f-9b0e-13a3a9e97384}"
SYS_EXT_DIR="/usr/lib64/mozilla/extensions/${APP_ID}"
# Firefox 147+ uses the XDG dir on fresh installs; older profiles stay in ~/.mozilla.
MOZ_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla"
[[ -f "${MOZ_DIR}/firefox/installs.ini" ]] || MOZ_DIR="$HOME/.mozilla"
NMH_DIR="/usr/lib64/mozilla/native-messaging-hosts"
FF_DIR="/usr/lib64/firefox"

profile="${1:-}"
if [[ -z "$profile" ]]; then
  rel="$(awk -F= '/^Default=/{print $2; exit}' "${MOZ_DIR}/firefox/installs.ini")"
  profile="${MOZ_DIR}/firefox/${rel}"
fi
[[ -f "$profile/prefs.js" ]] || { echo "not a Firefox profile: $profile" >&2; exit 1; }

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
(cd "${HERE}/extension" && zip -qr -X "${build}/${EXT_ID}.xpi" .)
sudo install -m 0644 -D "${build}/${EXT_ID}.xpi" "${SYS_EXT_DIR}/${EXT_ID}.xpi"
echo "extension_installed=${SYS_EXT_DIR}/${EXT_ID}.xpi"

chmod 0755 "${HERE}/host/native_host.py" "${HERE}/host/mcp_server.py"
cat > "${build}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Agent Bridge native host",
  "path": "${HERE}/host/native_host.py",
  "type": "stdio",
  "allowed_extensions": ["${EXT_ID}"]
}
EOF
sudo install -m 0644 -D "${build}/${HOST_NAME}.json" "${NMH_DIR}/${HOST_NAME}.json"
echo "native_host_manifest=${NMH_DIR}/${HOST_NAME}.json"

# System scope (8) must be scanned at startup or Firefox only notices the
# extension after an application upgrade. User scope (2) is added too: Fedora's
# firefox-langpacks RPM links the UI langpack there, and it must be rescanned
# after each Firefox update. Other bits of an existing value are kept.
userjs="${profile}/user.js"
cur="$(sed -n 's/.*"extensions\.startupScanScopes", *\([0-9]\+\).*/\1/p' "$userjs" 2>/dev/null | tail -1 || true)"
want=$(( ${cur:-0} | 10 ))
if [[ "$cur" != "$want" ]]; then
  if [[ -f "$userjs" ]]; then sed -i '/extensions\.startupScanScopes/d' "$userjs"; fi
  echo "user_pref(\"extensions.startupScanScopes\", ${want});" >> "$userjs"
fi
echo "profile_pref=${userjs} startupScanScopes=${want}"

# Firefox reads one autoconfig file; refuse to replace someone else's.
other="$(grep -l 'general.config.filename' "${FF_DIR}"/defaults/pref/*.js 2>/dev/null | grep -v '/firefox-agent-bridge-autoconfig.js$' || true)"
if [[ -n "$other" ]]; then
  echo "autoconfig=skipped: ${other} already sets general.config.filename (real input stays off)" >&2
else
  sudo install -m 0644 -D "${HERE}/autoconfig/firefox-agent-bridge-autoconfig.js" "${FF_DIR}/defaults/pref/firefox-agent-bridge-autoconfig.js"
  sudo install -m 0644 -D "${HERE}/autoconfig/firefox-agent-bridge.cfg" "${FF_DIR}/firefox-agent-bridge.cfg"
  echo "autoconfig=${FF_DIR}/firefox-agent-bridge.cfg"
fi

if command -v claude >/dev/null 2>&1; then
  current="$(claude mcp get firefox 2>/dev/null || true)"
  if grep -qF "${HERE}/host/mcp_server.py" <<<"$current"; then
    echo "mcp_server=already registered (claude mcp get firefox)"
  else
    # Missing, or registered from another checkout: point it here.
    [[ -n "$current" ]] && claude mcp remove --scope user firefox >/dev/null 2>&1 || true
    claude mcp add --scope user firefox -- python3 "${HERE}/host/mcp_server.py"
    echo "mcp_server=registered"
  fi
else
  echo "mcp_server=skipped (claude not on PATH); run: claude mcp add --scope user firefox -- python3 \"${HERE}/host/mcp_server.py\""
fi
echo "Restart Firefox to load the extension and autoconfig, and start a new Claude Code session."
