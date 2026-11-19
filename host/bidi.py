"""Minimal WebDriver BiDi client for Firefox (standard library only).

Used for real input: while Firefox's remote control server is open (see
autoconfig/firefox-agent-bridge.cfg), the MCP server sends isTrusted input through
BiDi instead of the extension's synthetic events. Firefox writes the
listening port to <profile>/WebDriverBiDiServer.json while it is up.
"""
import base64
import configparser
import json
import os
import socket
import struct

MOZ_DIRS = [os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "mozilla", "firefox"),
            os.path.expanduser("~/.mozilla/firefox")]


def default_profile():
    """Path of the profile Firefox starts by default (installs.ini), or None."""
    for base in MOZ_DIRS:
        ini = os.path.join(base, "installs.ini")
        if not os.path.isfile(ini):
            continue
        cp = configparser.ConfigParser()
        cp.read(ini)
        for sec in cp.sections():
            rel = cp[sec].get("Default")
            if rel:
                return rel if os.path.isabs(rel) else os.path.join(base, rel)
    return None


def endpoint(profile=None):
    """(host, port) of a live BiDi server for the profile, or None."""
    profile = profile or os.environ.get("AGENT_BRIDGE_PROFILE") or default_profile()
    if not profile:
        return None
    try:
        with open(os.path.join(profile, "WebDriverBiDiServer.json")) as f:
            info = json.load(f)
        host, port = info["ws_host"], int(info["ws_port"])
        with socket.create_connection((host, port), timeout=0.5):
            pass
        return host, port
    except (OSError, ValueError, KeyError):
        return None


class BidiError(Exception):
    pass


class Bidi:
    """One BiDi session. Firefox allows a single session at a time and does
    not end it when the socket drops, so always close() (session.end)."""

    def __init__(self, host, port, timeout=30):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /session HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise BidiError("BiDi handshake failed")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise BidiError("BiDi handshake refused: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))
        self.seq = 0
        self.events = []
        self.cmd("session.new", {"capabilities": {"alwaysMatch": {"unhandledPromptBehavior": {"default": "ignore"}}}})

    # -- websocket framing
    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise BidiError("BiDi connection closed")
            buf += chunk
        return buf

    def _read(self):
        while True:
            b0, b1 = self._recv(2)
            n = b1 & 127
            if n == 126:
                n = struct.unpack(">H", self._recv(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv(8))[0]
            data = self._recv(n)
            op = b0 & 0x0F
            if op == 8:
                raise BidiError("BiDi connection closed")
            if op in (1, 2):
                return json.loads(data)

    def _send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            hdr = bytes([0x81, 0x80 | n])
        elif n < 65536:
            hdr = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))

    def cmd(self, method, params=None, stop_event=None):
        """Send a command and return its result. With stop_event, return
        {"_event": msg} as soon as that event arrives instead (e.g. a dialog
        that keeps input.performActions from finishing); the late reply is
        skipped by later reads because its id no longer matches."""
        self.seq += 1
        self._send({"id": self.seq, "method": method, "params": params or {}})
        while True:
            msg = self._read()
            if msg.get("id") == self.seq:
                if msg.get("type") == "error":
                    raise BidiError(f"{method}: {msg.get('error')}: {msg.get('message')}")
                return msg.get("result") or {}
            if msg.get("type") == "event":
                self.events.append(msg)
                if stop_event and msg.get("method") == stop_event:
                    return {"_event": msg}

    def wait_event(self, method, timeout):
        """Return the first matching event within timeout seconds, else None."""
        for e in self.events:
            if e.get("method") == method:
                return e
        self.sock.settimeout(timeout)
        try:
            while True:
                msg = self._read()
                if msg.get("type") == "event":
                    self.events.append(msg)
                    if msg.get("method") == method:
                        return msg
        except (socket.timeout, TimeoutError):
            return None
        finally:
            self.sock.settimeout(30)

    def close(self):
        try:
            self.sock.settimeout(2)
            self.cmd("session.end")
        except (BidiError, OSError):
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# WebDriver key values for named keys.
KEYS = {
    "enter": "", "return": "", "kp_enter": "", "tab": "", "backspace": "",
    "delete": "", "del": "", "escape": "", "esc": "", "space": " ",
    "up": "", "down": "", "left": "", "right": "",
    "arrowup": "", "arrowdown": "", "arrowleft": "", "arrowright": "",
    "home": "", "end": "", "pageup": "", "page_up": "", "pagedown": "",
    "page_down": "", "insert": "",
    "ctrl": "", "control": "", "shift": "", "alt": "",
    "meta": "", "cmd": "", "super": "", "win": "", "windows": "",
}
KEYS.update({f"f{i}": chr(0xE031 + i - 1) for i in range(1, 13)})
MODIFIER_NAMES = ("ctrl", "control", "shift", "alt", "meta", "cmd", "super", "win", "windows")


def key_value(name):
    v = KEYS.get(name.lower())
    if v:
        return v
    if len(name) == 1:
        return name
    raise BidiError(f"Unknown key {name!r}")


def modifier_values(spec):
    if not spec:
        return []
    out = []
    for part in spec.replace(" ", "").split("+"):
        if part and part.lower() in MODIFIER_NAMES:
            out.append(KEYS[part.lower()])
    return out


def combo_actions(combo):
    """'ctrl+shift+a' -> key actions for one press."""
    parts = combo.split("+")
    keys = [key_value(p) for p in parts if p]
    return ([{"type": "keyDown", "value": k} for k in keys] +
            [{"type": "keyUp", "value": k} for k in reversed(keys)])
