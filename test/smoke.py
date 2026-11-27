#!/usr/bin/env python3
"""End-to-end smoke test: drives mcp_server.py over stdio like Claude Code does.
Requires a running Firefox with the extension loaded."""
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Deterministic keyword find unless the model-based one is under test.
if not os.environ.get("SMOKE_MODEL_FIND"):
    os.environ["AGENT_BRIDGE_FIND"] = "keyword"
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "..", "host", "mcp_server.py")],
                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
seq = 0


def rpc(method, params=None):
    global seq
    seq += 1
    srv.stdin.write(json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params or {}}) + "\n")
    srv.stdin.flush()
    return json.loads(srv.stdout.readline())


def call(name, **args):
    r = rpc("tools/call", {"name": name, "arguments": args})["result"]
    parts = []
    for c in r["content"]:
        if c["type"] == "text":
            parts.append(c["text"])
        else:
            parts.append(f"<image {c['mimeType']} {len(base64.b64decode(c['data']))} bytes>")
    out = "\n".join(parts)
    print(f"--- {name} {json.dumps({k: v for k, v in args.items() if k != 'tabId'})}{' ERROR' if r.get('isError') else ''}\n{out[:1500]}\n")
    return r, out


print(rpc("initialize", {"protocolVersion": "2025-06-18"})["result"]["serverInfo"])
print(len(rpc("tools/list")["result"]["tools"]), "tools")

for _ in range(20):
    r, out = call("tabs_context_mcp", createIfEmpty=True)
    if not r.get("isError"):
        break
    time.sleep(1)
assert "versions differ" not in out, out
tab = json.loads(out.split("\n", 1)[1])[0]["tabId"]

TEST_HTML = """
<title>Bridge test</title>
<h1>Hello</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:'+this.q.value">
<label>Query <input name=q id=q></label>
<select id=s><option value=a>Apple</option><option value=b>Banana</option></select>
<input type=checkbox id=c> <label for=c>Agree</label>
<button id=b onclick="console.log('clicked', {n: 1})">Go</button>
</form>
<p id=out></p>
<div contenteditable id=ed>edit me</div>
<script>try { console.warn('page warn'); window.consoleOk = 'yes'; } catch (e) { window.consoleOk = String(e); } fetch('/nope').catch(()=>{});</script>
"""
import http.server, threading, tempfile
_d = tempfile.mkdtemp()
open(os.path.join(_d, "index.html"), "w").write(TEST_HTML)
_h = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a: http.server.SimpleHTTPRequestHandler(*a, directory=_d))
threading.Thread(target=_h.serve_forever, daemon=True).start()
TEST_PAGE = f"http://127.0.0.1:{_h.server_port}/index.html"
open(os.path.join(_d, "frame.html"), "w").write(
    '<title>inner</title><p>Inside frame text</p><input id=fi placeholder="frame input">'
    '<button id=fb onclick="this.textContent=\'frame clicked\'">FrameBtn</button>')
open(os.path.join(_d, "outer.html"), "w").write(
    '<title>outer</title><button onclick="alert(\'hi from alert\')">Alert</button>'
    '<iframe src="frame.html" style="width:400px;height:150px;border:5px solid"></iframe>')
OUTER_PAGE = f"http://127.0.0.1:{_h.server_port}/outer.html"

call("navigate", tabId=tab, url="https://example.com")
call("get_page_text", tabId=tab)
call("read_network_requests", tabId=tab)
call("navigate", tabId=tab, url=TEST_PAGE)
call("read_network_requests", tabId=tab, urlPattern="127.0.0.1")
call("read_page", tabId=tab)
_, inter = call("read_page", tabId=tab, filter="interactive")
call("find", tabId=tab, query="query input")
ref = lambda word: next(l for l in inter.splitlines() if word in l).split("[")[1].split("]")[0]
call("computer", tabId=tab, action="left_click", ref=ref("Query"))
call("computer", tabId=tab, action="type", text="hello world")
call("computer", tabId=tab, action="key", text="ctrl+a Backspace")
call("computer", tabId=tab, action="type", text="bridge")
_, out = call("computer", tabId=tab, action="left_click", ref=ref("combobox"))
assert "options:" in out and '"Banana"' in out, out  # native popup can't be screenshotted: choices are reported
call("form_input", tabId=tab, ref=ref("combobox"), value="Banana")
call("form_input", tabId=tab, ref=ref("checkbox"), value=True)
call("computer", tabId=tab, action="left_click", ref=ref('button "Go"'))
call("javascript_tool", tabId=tab, action="javascript_exec", text="({out: document.getElementById('out').textContent, q: q.value, s: s.value, c: c.checked})")
call("javascript_tool", tabId=tab, action="javascript_exec", text="await new Promise(r => setTimeout(r, 100)); 6 * 7")
call("javascript_tool", tabId=tab, action="javascript_exec", text="window.consoleOk")
call("javascript_tool", tabId=tab, action="javascript_exec", text="const a = 2;\nconst b = await Promise.resolve(3);\na * b")
call("javascript_tool", tabId=tab, action="javascript_exec", text="document.querySelectorAll('input').length")
call("javascript_tool", tabId=tab, action="javascript_exec", text="throw new TypeError('boom')")
call("javascript_tool", tabId=tab, action="javascript_exec", text="this is not js")
call("computer", tabId=tab, action="left_click", ref=ref("edit me"))
call("computer", tabId=tab, action="key", text="End")
call("computer", tabId=tab, action="type", text=" — typed")
call("javascript_tool", tabId=tab, action="javascript_exec", text="ed.textContent")
call("computer", tabId=tab, action="left_click", ref=ref("Query"))
call("computer", tabId=tab, action="key", text="Home")
call("computer", tabId=tab, action="type", text="X")
call("computer", tabId=tab, action="key", text="End shift+Left shift+Left Backspace")
call("javascript_tool", tabId=tab, action="javascript_exec", text="q.value")
call("read_console_messages", tabId=tab)
r, out = call("computer", tabId=tab, action="zoom", region=[0, 0, 200, 100])
assert not r.get("isError") and "rendered at" in out, out
r, _ = call("computer", tabId=tab, action="screenshot")
img = next(c for c in r["content"] if c["type"] == "image")
open(os.path.join(os.environ.get("SHOT_DIR", "/tmp"), "bridge-shot.jpg"), "wb").write(base64.b64decode(img["data"]))
call("computer", tabId=tab, action="left_click", coordinate=[30, 30])
call("computer", tabId=tab, action="scroll", scroll_direction="down")

# same-origin iframe: read, find, click by ref and by coordinate, type
call("navigate", tabId=tab, url=OUTER_PAGE)
_, outer = call("read_page", tabId=tab)
assert "Inside frame text" in outer, "iframe contents missing from read_page"
_, found = call("find", tabId=tab, query="frame input")
assert "frame input" in found
fref = lambda word: next(l for l in outer.splitlines() if word in l).split("[")[1].split("]")[0]
call("computer", tabId=tab, action="left_click", ref=fref("frame input"))
call("computer", tabId=tab, action="type", text="in frame")
_, v = call("javascript_tool", tabId=tab, action="javascript_exec", text="document.querySelector('iframe').contentDocument.getElementById('fi').value")
assert v == "in frame", v
_, pt = call("get_page_text", tabId=tab)
assert "Inside frame text" in pt
_, js = call("javascript_tool", tabId=tab, action="javascript_exec", text="(() => { const f = document.querySelector('iframe'), b = f.contentDocument.getElementById('fb').getBoundingClientRect(), o = f.getBoundingClientRect(); return [Math.round(o.left + 5 + b.left + b.width / 2), Math.round(o.top + 5 + b.top + b.height / 2)]; })()")
call("computer", tabId=tab, action="left_click", coordinate=json.loads(js))
_, v = call("javascript_tool", tabId=tab, action="javascript_exec", text="document.querySelector('iframe').contentDocument.getElementById('fb').textContent")
assert v == "frame clicked", v

# a click that opens alert() must return promptly with the dialog text
t0 = time.time()
r, out = call("computer", tabId=tab, action="left_click", ref=fref('button "Alert"'))
assert "alert() dialog" in out and time.time() - t0 < 10, out
t0 = time.time()
r, out = call("get_page_text", tabId=tab)
assert r.get("isError") and "dialog is open" in out and time.time() - t0 < 5, out

# --- Claude in Chrome parity
open(os.path.join(_d, "upload.html"), "w").write(
    '<title>upload</title><input type=file id=f multiple><div id=drop style="width:300px;height:120px;background:#ddd">drop here</div>'
    '<p id=log></p><script>'
    'f.onchange = () => log.textContent = "input:" + [...f.files].map(x => x.name + ":" + x.size).join(",");'
    'drop.ondragover = e => e.preventDefault();'
    'drop.ondrop = e => { e.preventDefault(); log.textContent = "drop:" + [...e.dataTransfer.files].map(x => x.name + ":" + x.type).join(","); };'
    '</script>' + "".join(f"<a href=#{i}>link {i}</a> " for i in range(30)))
UPLOAD_PAGE = f"http://127.0.0.1:{_h.server_port}/upload.html"
up_file = os.path.join(_d, "hello.txt")
open(up_file, "w").write("hello upload")

r, out = call("browser_batch", actions=[
    {"name": "navigate", "input": {"tabId": tab, "url": UPLOAD_PAGE}},
    {"name": "find", "input": {"tabId": tab, "query": "link"}},
    {"name": "computer", "input": {"tabId": tab, "action": "screenshot", "scale": 0.5}},
])
assert not r.get("isError") and "[3/3] computer" in out and "Screenshot ID: ss_" in out and "Use a more specific query" in out, out
shot_id = out.split("Screenshot ID: ")[1].split()[0]
r, out = call("browser_batch", actions=[{"name": "computer", "input": {"action": "screenshot"}}])
assert r.get("isError") and "tabId is required" in out
r, out = call("browser_batch", actions=[{"name": "navigate", "input": {"tabId": tab, "url": "back"}},
                                        {"name": "browser_batch", "input": {"actions": []}}])
assert r.get("isError") and "cannot be nested" in out

call("navigate", tabId=tab, url=UPLOAD_PAGE)
_, page = call("read_page", tabId=tab, filter="interactive")
fref = next(l for l in page.splitlines() if "type=file" in l).split("[")[1].split("]")[0]
r, out = call("file_upload", tabId=tab, ref=fref, paths=[up_file])
_, v = call("javascript_tool", tabId=tab, action="javascript_exec", text="log.textContent")
assert v == "input:hello.txt:12", v
r, out = call("file_upload", tabId=tab, ref=fref, paths=[os.path.expanduser("~/.ssh/config")])
assert r.get("isError") and "credential" in out, out
call("upload_image", tabId=tab, imageId=shot_id, coordinate=[150, 80], filename="shot.png")
_, v = call("javascript_tool", tabId=tab, action="javascript_exec", text="log.textContent")
assert v == "drop:shot.png:image/png", v
r, out = call("upload_image", tabId=tab, imageId="ss_nope", ref=fref)
assert r.get("isError") and "expired" in out

r, out = call("computer", tabId=tab, action="key", text="ctrl+=")
assert r.get("isError") and "zoom" in out
r, out = call("computer", tabId=tab, action="screenshot", save_to_disk=True)
saved = out.split("Saved to ")[1].split()[0]
assert os.path.getsize(saved) > 1000
os.unlink(saved)

r, out = call("javascript_tool", tabId=tab, action="javascript_exec", text="fetch('/x?token=abc123&page=2').catch(()=>0).then(()=>1)")
time.sleep(0.5)
_, out = call("read_network_requests", tabId=tab, urlPattern="/x?")
assert "token=REDACTED" in out and "abc123" not in out and "page=2" in out, out

_, out = call("list_connected_browsers")
dev = json.loads(out)[0]["deviceId"]
r, out = call("select_browser", deviceId=dev)
assert not r.get("isError")

# GIF: record a few actions, then drop the export onto the page
call("gif_creator", tabId=tab, action="start_recording")
call("computer", tabId=tab, action="screenshot")
call("computer", tabId=tab, action="left_click", coordinate=[150, 80], action_summary="Clicks the drop zone")
call("computer", tabId=tab, action="scroll", scroll_direction="down")
call("computer", tabId=tab, action="screenshot")
call("gif_creator", tabId=tab, action="stop_recording")
r, out = call("gif_creator", tabId=tab, action="export", coordinate=[150, 80], filename="rec.gif")
assert not r.get("isError") and "frames" in out, out
_, v = call("javascript_tool", tabId=tab, action="javascript_exec", text="log.textContent")
assert v == "drop:rec.gif:image/gif", v
if os.environ.get("SMOKE_DOWNLOAD"):
    r, out = call("gif_creator", tabId=tab, action="export", download=True, filename="smoke-rec.gif")
    assert not r.get("isError") and out.split("-> ")[1].endswith(".gif"), out
    print("GIF at", out.split("-> ")[1])
call("gif_creator", tabId=tab, action="clear")

# cross-origin iframe: localhost and 127.0.0.1 are different origins
port = _h.server_port
open(os.path.join(_d, "xframe.html"), "w").write(
    '<title>x</title><p>Cross frame text</p>'
    '<button id=xb style="position:absolute;left:10px;top:40px;width:120px;height:30px" '
    'onclick="this.textContent=\'xclicked \'+event.isTrusted">CrossBtn</button>'
    '<input id=xi placeholder="cross input" style="position:absolute;left:10px;top:90px">')
open(os.path.join(_d, "xo.html"), "w").write(
    f'<title>xo</title><h1>Outer</h1><iframe src="http://localhost:{port}/xframe.html" '
    'style="position:absolute;left:50px;top:100px;width:400px;height:200px;border:0"></iframe>')
call("navigate", tabId=tab, url=f"http://127.0.0.1:{port}/xo.html")
time.sleep(0.5)
_, tree = call("read_page", tabId=tab)
assert "Cross frame text" in tree and "ref_f" in tree, tree
xref = lambda word: next(l for l in tree.splitlines() if word in l).split("[")[1].split("]")[0]
_, out = call("find", tabId=tab, query="CrossBtn")
assert "ref_f" in out, out
call("computer", tabId=tab, action="left_click", ref=xref("cross input"))
call("computer", tabId=tab, action="type", text="typed in frame")
_, tree2 = call("read_page", tabId=tab, filter="interactive")
assert 'value="typed in frame"' in tree2, tree2
_, out = call("computer", tabId=tab, action="left_click", coordinate=[50 + 70, 100 + 55])
assert "cross-origin frame" in out, out
_, pt = call("get_page_text", tabId=tab)
assert "xclicked" in pt and "Cross frame text" in pt, pt
if os.environ.get("SMOKE_MODEL_FIND"):
    _, out = call("find", tabId=tab, query="the text field inside the embedded frame")
    assert out.startswith("- ") and "cross input" in out.splitlines()[0], out

# real input must not mark the browser as automated
# accessible roles and names
open(os.path.join(_d, "a11y.html"), "w").write(
    '<title>a11y</title><fieldset><legend>Shipping</legend><input id=zip required aria-describedby=h><span id=h>5 digits</span></fieldset>'
    '<table><caption>Prices</caption><tr><th>Item</th></tr></table><img src=x alt=""><button aria-pressed=true>Bold</button>'
    '<section aria-label="Results"><h2>Found</h2></section><div hidden><button>Ghost</button></div>'
    '<script>console.log("a11y page log")</script>')
call("navigate", tabId=tab, url=f"http://127.0.0.1:{port}/a11y.html")
_, tree = call("read_page", tabId=tab)
for want in ('group "Shipping"', 'required', 'description="5 digits"', 'table "Prices"', 'pressed=true', 'region "Results"'):
    assert want in tree, (want, tree)
assert "Ghost" not in tree and "img" not in tree, tree

# deep wrapper nesting (Blackboard Ultra style) and a hidden file input behind a styled button
deep = "<div>" * 40 + '<h2>Deep</h2><input type=file id=hf style="display:none"><button>Upload</button>' + "</div>" * 40
open(os.path.join(_d, "deep.html"), "w").write("<title>deep</title>" + deep)
call("navigate", tabId=tab, url=f"http://127.0.0.1:{port}/deep.html")
_, tree = call("read_page", tabId=tab)
assert 'heading "Deep"' in tree and "type=file" in tree and 'button "Upload"' in tree, tree
_, tree = call("read_page", tabId=tab, filter="interactive")
assert "type=file" in tree, tree

# a password manager's autofill dropdown (shaped like Proton Pass's) must not
# take Claude's clicks: it opens on focus over the button below the field
open(os.path.join(_d, "pm.html"), "w").write(
    '<title>pm</title><input id=user style="position:absolute;left:20px;top:20px;width:200px">'
    '<button id=under style="position:absolute;left:20px;top:60px;width:200px;height:40px" '
    'onclick="this.textContent=\'page clicked\'">Under</button><p id=log style="position:absolute;top:200px"></p><script>'
    'user.addEventListener("focus", () => { if (document.querySelector("protonpass-root-t1")) return;'
    ' const r = document.createElement("protonpass-root-t1"); r.setAttribute("data-protonpass-role", "root");'
    ' const s = r.attachShadow({mode: "open"});'
    ' s.innerHTML = "<style>:host{display:block!important;visibility:visible!important;position:fixed!important;'
    'left:0!important;top:50px!important;width:300px!important;height:100px!important;z-index:2147483647!important;'
    'background:#6d4aff!important}</style><button style=\'width:100%;height:100%\'>Autofill</button>";'
    ' s.querySelector("button").onclick = () => { log.textContent = "AUTOFILLED"; };'
    ' setTimeout(() => document.body.appendChild(r), 50); });</script>')
call("navigate", tabId=tab, url=f"http://127.0.0.1:{port}/pm.html")
call("computer", tabId=tab, action="left_click", coordinate=[100, 30])
time.sleep(0.5)
_, out = call("computer", tabId=tab, action="left_click", coordinate=[100, 80])
assert "Autofill" not in out, out
_, pt = call("get_page_text", tabId=tab)
assert "page clicked" in pt and "AUTOFILLED" not in pt, pt

# console history survives same-domain navigation, resets on another domain
call("navigate", tabId=tab, url=f"http://127.0.0.1:{port}/index.html")
_, out = call("read_console_messages", tabId=tab, pattern="a11y page log|page warn")
assert "a11y page log" in out and "page warn" in out, out

_, wd = call("javascript_tool", tabId=tab, action="javascript_exec", text="String(navigator.webdriver)")
assert wd == "false", wd

# navigate without tabId uses the group's first tab and appends the tab list
_, out = call("navigate", url="https://example.org")
_, c = call("read_console_messages", tabId=tab, pattern="a11y page log")
assert "No console messages" in c, c
assert "Tabs in the" in out
r, out = call("tabs_create_mcp")
new_tab = int(out.split("Created tab ")[1].split()[0])
_, out = call("tabs_close_mcp", tabId=new_tab)
assert "Closed tab" in out
call("tabs_context_mcp")
print("SMOKE OK")
srv.stdin.close()
