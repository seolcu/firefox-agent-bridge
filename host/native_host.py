#!/usr/bin/env python3
"""Native-messaging host for Agent Bridge.

Firefox starts this process when the extension calls connectNative(). It
relays newline-delimited JSON requests from local MCP servers (over a Unix
socket in $XDG_RUNTIME_DIR) to the extension, and routes replies back.
Standard library only.
"""
import json
import os
import socket
import struct
import sys
import threading
import time

SOCK_DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", "firefox-agent-bridge")
SOCK_PATH = os.path.join(SOCK_DIR, "bridge.sock")

out_lock = threading.Lock()
pending = {}  # host id -> (conn, client id)
pending_lock = threading.Lock()
next_id = 0


def log(*a):
    print("firefox-agent-bridge-host:", *a, file=sys.stderr, flush=True)


def send_to_firefox(obj):
    data = json.dumps(obj, separators=(",", ":")).encode()
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()


def read_from_firefox():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        return None
    return json.loads(data)


def send_line(conn, obj):
    try:
        conn.sendall(json.dumps(obj, separators=(",", ":")).encode() + b"\n")
    except OSError:
        pass


def serve_client(conn):
    global next_id
    buf = b""
    try:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                with pending_lock:
                    next_id += 1
                    hid = next_id
                    pending[hid] = (conn, req.get("id"))
                send_to_firefox({"id": hid, "tool": req.get("tool"), "args": req.get("args") or {}})
    except OSError:
        pass
    finally:
        with pending_lock:
            for k in [k for k, v in pending.items() if v[0] is conn]:
                del pending[k]
        conn.close()


def accept_loop(srv):
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


my_ino = None


def bind():
    """(Re)create the listening socket; the newest Firefox takes it over."""
    global my_ino
    os.makedirs(SOCK_DIR, mode=0o700, exist_ok=True)
    os.chmod(SOCK_DIR, 0o700)
    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    srv.bind(SOCK_PATH)
    os.umask(old)
    srv.listen(8)
    my_ino = os.stat(SOCK_PATH).st_ino
    threading.Thread(target=accept_loop, args=(srv,), daemon=True).start()
    log("listening on", SOCK_PATH)


def watchdog():
    # With two Firefox instances, the later one takes the socket and removes
    # it when it exits. Take it back once it is gone so this Firefox stays
    # reachable; never steal a socket another live host owns.
    while True:
        time.sleep(2)
        if not os.path.exists(SOCK_PATH):
            try:
                bind()
            except OSError as e:
                log("rebind failed:", e)


def main():
    bind()
    threading.Thread(target=watchdog, daemon=True).start()

    try:
        while True:
            msg = read_from_firefox()
            if msg is None:
                break
            with pending_lock:
                target = pending.pop(msg.get("id"), None)
            if target:
                conn, cid = target
                msg["id"] = cid
                send_line(conn, msg)
    finally:
        try:
            if os.stat(SOCK_PATH).st_ino == my_ino:
                os.unlink(SOCK_PATH)
        except OSError:
            pass


if __name__ == "__main__":
    main()
