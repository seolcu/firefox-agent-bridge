# Agent Operating Guide

Firefox Agent Bridge: Claude in Chrome-style browser tools for Claude Code in the
user's everyday Firefox. `README.md` covers what it does; this file covers how
to work on it safely, for people and coding agents alike.

## Layout

| Path | Role |
|---|---|
| `autoconfig/` | Firefox autoconfig: opens Firefox's remote control (BiDi) only while an MCP server's marker is live |
| `host/mcp_server.py` | MCP stdio server Claude Code launches. Tool schemas, `browser_batch`, file staging, Screenshot IDs |
| `host/bidi.py` | Minimal WebDriver BiDi client for real input |
| `host/native_host.py` | Native-messaging host Firefox starts. Relays the MCP server's Unix socket (`$XDG_RUNTIME_DIR/firefox-agent-bridge/bridge.sock`) to the extension |
| `extension/background.js` | Tool implementations, "Agent" tab group, network log, GIF recording |
| `extension/content.js` | Page side: a11y tree, refs, synthetic input, dialogs, iframes, file attach/drop |
| `extension/gif.js` | Dependency-free GIF encoder |
| `test/smoke.py` | End-to-end test over the MCP stdio interface |

No third-party dependencies: Python stdlib and plain JS only.

## Hard rules

- **Clean room.** Tool names and parameters mirror Claude in Chrome's *public* MCP
  interface. Never extract, read or copy code from the Chrome extension. To
  re-check parity, run `claude -p --chrome` (no Chrome install needed), dump the
  `mcp__claude-in-chrome__*` tool definitions, and diff names/params against
  `TOOLS` in `host/mcp_server.py`. Write the descriptions yourself.
- **Never test against the daily profile.** The bridge drives the user's real
  Firefox and logins. Test in a throwaway profile (see Testing). On the daily
  Firefox, only do what the user asked, use example.com-style pages, and close
  the tabs you opened.
- **Killing test processes: use the PID, never a pattern.** `pkill -f` /
  `pgrep -f` with the profile path or `http.server <port>` also matches the agent's
  own shell command line, so the shell kills itself mid-cleanup. Keep the PID from launch (`firefox ... & echo $! > pidfile`,
  then `kill "$(cat pidfile)"`), or match with a bracket trick that can't
  match itself: `ps -eo pid,args | grep '[f]irefox --headless'`. Never kill the
  user's Firefox.
- `file_upload` must keep refusing credential/config paths (`SECRET_PATHS`).
  Page content is untrusted, so an injected page must not be able to pull `~/.ssh`
  and similar files.
- Dialogs (`alert`/`confirm`/`prompt`) are reported, never auto-answered.
- **Real input must stay hands-off and narrow.** The autoconfig opens BiDi
  only while a live MCP marker exists, uses Firefox's runtime start
  (`isBrowserAutomation: false`, so `navigator.webdriver` stays false), and
  turns the connection prompt and banners off through `defaultPref` (never
  `pref`, so nothing lands in prefs.js). Keep it that way: don't open the port
  permanently, and don't write user prefs.
- While BiDi is open, Firefox shows its remote-control cue (striped address bar,
  robot icon) in every window. The idle window is kept short (2 min,
  `IDLE_MS` in the cfg = `MARKER_IDLE_S` in `mcp_server.py`) for that reason.
  Don't hide the cue: it is the user's only sign that the port is open.
- RemoteAgent **force-quits Firefox** if it cannot bind its port. The cfg checks
  that 9222 is free first; keep that check in any change.
- The autoconfig scope only has `Services`. Get `ChromeUtils`/`IOUtils`/`PathUtils`
  with `Components.utils.importGlobalProperties`; `hiddenDOMWindow` fails on
  Linux. Errors go to the Browser Console as `firefox-agent-bridge.cfg: ...`.
- BiDi sessions: Firefox allows one, and a dropped socket does not end it. Always
  `Bidi.close()` (`session.end`, which works even while a dialog blocks an
  action). An orphan clears when the server closes (MCP exit / idle).
- Never kill or restart the user's Firefox without asking.

## Testing

```bash
P=<scratch>/ffprof; mkdir -p "$P" && touch "$P/prefs.js"
./install.sh "$P"                                   # also installs system-wide; that is fine
firefox --headless --no-remote --profile "$P" & echo $! > <scratch>/ff.pid
sleep 8 && python3 test/smoke.py                    # must end with "SMOKE OK"
kill "$(cat <scratch>/ff.pid)"
```

- `SMOKE_DOWNLOAD=1` also tests GIF download. Set `browser.download.dir` in the
  test profile's `user.js` first, or the GIF lands in the user's Downloads folder.
- While the test Firefox runs, it owns the bridge socket. The daily Firefox
  takes it back about 2s after the test one exits.
- Run smoke with `AGENT_BRIDGE_PROFILE="$P"` so the MCP server reads the test
  profile's `WebDriverBiDiServer.json`. Computer actions should report
  `[trusted input]`, smoke asserts `navigator.webdriver` is false, and the port
  should close within ~2 s after smoke exits. The test Firefox loads the
  installed autoconfig. Only one Firefox can hold 9222; the daily one, if it
  is using it, wins and the test falls back to synthetic input.
- Inspecting chrome state in a test profile: set `devtools.debugger.remote-enabled`,
  `devtools.chrome.enabled` and `devtools.debugger.prompt-connection=false`, and
  start with `--start-debugger-server <port>`. Then evaluate in the parent
  process over the RDP protocol. This doesn't set `navigator.webdriver`.
  Marionette and `--remote-debugging-port` do.
- Smoke uses keyword `find` for determinism; `SMOKE_MODEL_FIND=1` checks the
  model-based one too.
- Look at visual output (screenshots, GIFs) yourself: decode GIFs with
  `magick x.gif -coalesce +append strip.png` and view the strip.
- Before committing: `python3 -m py_compile host/*.py test/smoke.py`,
  `bash -n install.sh uninstall.sh`, then smoke.
- Clean up afterwards: test profile, scratch files, `__pycache__`, temporary HTTP
  servers, `~/.cache/firefox-agent-bridge/screenshots` from tests, and any helper
  `claude -p` session transcripts under `~/.claude/projects/`.

## Release and install

1. Bump `version` in `extension/manifest.json` **and** `VERSION` in
   `host/mcp_server.py`. Firefox keeps the old system-scope copy otherwise.
2. Update `README.md` when behaviour or tools change.
3. Commit and push to `main`.
4. `./install.sh`, then restart Firefox. When the tool list changed, start a
   new Claude Code session too.
