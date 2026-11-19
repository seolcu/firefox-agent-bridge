# Firefox Agent Bridge

Browser tools for [Claude Code](https://claude.com/claude-code) in your everyday
Firefox: Claude can read, click, type, upload, record GIFs and debug in the
tabs you give it, with your real profile and logins. The tool set mirrors
Claude in Chrome's, so Claude uses it the same way.

A WebExtension, a native-messaging host and an MCP server. Python standard
library and plain JavaScript only; no third-party dependencies.

> Not affiliated with or endorsed by Anthropic or Mozilla. "Claude" is a
> trademark of Anthropic, PBC; "Firefox" is a trademark of the Mozilla
> Foundation. They are named here only to say what this works with.

## ⚠️ Read this before installing

This tool hands an AI agent your real browser session. Install it only on a
machine you trust and understand what it does:

- **Your logins are in reach.** Claude acts in your own Firefox profile, so it
  can do anything you can do on any site where you are signed in. It only
  touches tabs in the **"Agent" tab group**, and the toolbar button pauses it,
  but pages it reads can contain prompt injection. Watch what it does on
  sensitive sites.
- **It opens Firefox's remote control without asking.** For real input,
  `install.sh` adds a Firefox *autoconfig* that turns on Firefox's built-in
  remote control server (WebDriver BiDi on `localhost:9222`) while a Claude
  Code session is using the bridge, **with Firefox's connection prompt
  disabled**. While it is open, any program on this computer, sandboxed apps
  with network access included, can control the browser. It closes when Claude
  Code exits or after 10 idle minutes.
- **The autoconfig is system-wide.** It goes into the Firefox install
  directory and applies to every Firefox profile on the machine, and it runs
  privileged code at Firefox startup.
- **It relies on experimental Firefox internals**
  (`remote.experimental.dynamicstart`, Firefox 160). An update can change or
  remove them. The bridge then falls back to synthetic input; it does not break.
- **The extension is unsigned** and installs into the system extension
  scope, which Fedora's Firefox build allows. Other builds may refuse it.
- `file_upload` refuses files under credential/config directories (`~/.ssh`,
  `~/.gnupg`, `~/.aws`, `~/.claude`, the Firefox profile, ...).
  Everything else your user can read can be uploaded.

## Requirements

- Linux with Fedora's Firefox package (paths assume `/usr/lib64/firefox` and
  `/usr/lib64/mozilla`). Firefox 139+ for tab groups; real input needs
  Firefox 160's experimental API.
- Python 3, `zip`, `sudo`, and [Claude Code](https://claude.com/claude-code)
  (`claude` on `PATH`).

## Install / uninstall

```bash
git clone https://github.com/seolcu/firefox-agent-bridge.git
cd firefox-agent-bridge
./install.sh      # then restart Firefox and start a new Claude Code session
./uninstall.sh    # removes everything below except the user.js line
```

`install.sh` sets up:

- the extension in `/usr/lib64/mozilla/extensions/` (system scope)
- the native-messaging host manifest in `/usr/lib64/mozilla/native-messaging-hosts/`
- the autoconfig `/usr/lib64/firefox/firefox-agent-bridge.cfg` +
  `defaults/pref/firefox-agent-bridge-autoconfig.js`. It is skipped if another
  autoconfig is installed. It only changes default prefs, so nothing is
  written to your profile.
- `extensions.startupScanScopes` in the default profile's `user.js`, so Firefox
  picks up system-scope extensions at startup. Uninstall leaves this line in
  place; it is harmless.
- the MCP server `firefox` in Claude Code's user config

Update with `git pull && ./install.sh`, then restart Firefox and Claude Code.

## How it works

```
Claude Code ──stdio──> host/mcp_server.py ──unix socket──> host/native_host.py ──native messaging──> extension
                              │                 ($XDG_RUNTIME_DIR/firefox-agent-bridge/bridge.sock, 0600)
                              └──WebDriver BiDi (localhost:9222, only while in use)──> Firefox
```

- The **extension** does the page work: an accessibility-style tree with
  element refs, text extraction, form filling, screenshots, console and
  network logs, uploads, and GIF recording.
- **Real input**: Firefox gives extensions no input API, so their clicks and
  keys are synthetic (`isTrusted: false`), and some sites ignore them. While
  the MCP server runs, it keeps a marker in
  `$XDG_RUNTIME_DIR/firefox-agent-bridge/active/`. The autoconfig sees it
  within ~2 s and starts Firefox's remote control the same way Firefox's own
  "remote control for AI assistants" does: not as browser automation, so pages
  keep `navigator.webdriver === false`. Clicks, typing, keys, drags, hovers
  and scrolls at a point then go over BiDi as real input, including into
  cross-origin frames, and results say `[trusted input]`. Without the server
  (port taken, API gone, or `AGENT_BRIDGE_TRUSTED=off`), input stays synthetic.
- **`find`** asks a small model (`claude -p --model haiku`, about 3 s) to pick
  matching elements from the page tree. Only refs that exist in the tree are
  accepted. It falls back to keyword matching when `claude` is unavailable or
  `AGENT_BRIDGE_FIND=keyword` is set.

## Tools

`tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`,
`computer` (screenshot, zoom, clicks, hover, drag, type, key, scroll,
scroll_to, wait; with `modifiers`, `action_summary`, `scale`,
`save_to_disk`), `read_page`, `find`, `form_input`, `get_page_text`,
`javascript_tool`, `read_console_messages`, `read_network_requests`,
`resize_window`, `file_upload`, `upload_image`, `gif_creator`,
`browser_batch`, `list_connected_browsers`, `select_browser`,
`switch_browser`.

The names and parameters match Claude in Chrome's public MCP interface. The
descriptions and all code are written for this project.

## Behaviour

- `tabs_context_mcp createIfEmpty` opens the "Agent" group in a new window.
  Drag any tab into it to share it.
- The toolbar button pauses and resumes the bridge (badge `off`). `!` means the
  native host is not connected; `REC` means a GIF is recording.
- iframes, cross-origin included, are read, searched, clicked and typed into.
  Refs inside a cross-origin frame look like `ref_f<frameId>_N`.
- `alert`/`confirm`/`prompt`: the call that opens one returns at once with its
  text, and the dialog is never answered automatically. A page call that hangs
  is cut off after 60 s.
- Screenshots get a `Screenshot ID` for `upload_image` (kept 5 minutes).
  `save_to_disk` writes to `~/.cache/firefox-agent-bridge/screenshots/` (pruned
  after 7 days).
- `read_network_requests` starts over on a change of domain, and
  credential-like URL values show as `REDACTED`.
- With two Firefox instances running, the last one started serves the bridge;
  the other takes over again within ~2 s when it exits.

## Differences from Claude in Chrome

- `read_page` builds its tree from the DOM, not from the browser's
  accessibility tree.
- Native `<select>` popups can't be opened; `form_input` sets them.
- One browser per machine: `list_connected_browsers`, `select_browser` and
  `switch_browser` report the local Firefox.
- No side-panel chat.

## Development

See [AGENTS.md](AGENTS.md). `python3 test/smoke.py` runs end to end against a
running Firefox; use a throwaway profile, never your daily one.

## License

[MIT](LICENSE)
