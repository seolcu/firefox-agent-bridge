// Background half of Agent Bridge: talks to the native host over
// native messaging and executes tool requests against tabs in the
// "Agent" tab group. Only tabs in that group are ever touched.
"use strict";

const HOST = "firefox_agent_bridge";
const GROUP_TITLE = "Agent";
const GROUP_COLOR = "orange";

let port = null;
let enabled = true;
let retryMs = 2000;
const agentTabIds = new Set();
const netBuf = new Map(); // tabId -> [{...}]
const tabHost = new Map(); // tabId -> host of the current top-level document
const MAX_NET = 500;
const staged = new Map(); // key -> {chunks, total, ts}, payloads sent in pieces by the MCP server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- UI state
function updateBadge() {
  let text = "", color = "#888", title;
  if (!enabled) { text = "off"; title = "Agent Bridge: paused (click to resume)"; }
  else if (!port) { text = "!"; color = "#c0392b"; title = "Agent Bridge: native host not connected"; }
  else if (recording.active) { text = "REC"; color = "#c0392b"; title = "Agent Bridge: recording a GIF (click to pause)"; }
  else { text = ""; title = "Agent Bridge: ready (click to pause)"; }
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setTitle({ title });
}

browser.browserAction.onClicked.addListener(async () => {
  enabled = !enabled;
  await browser.storage.local.set({ enabled });
  updateBadge();
});

// ------------------------------------------------------- native host link
function connect() {
  try {
    port = browser.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    scheduleReconnect();
    return;
  }
  const me = port;
  me.onMessage.addListener(onRequest);
  me.onDisconnect.addListener((p) => {
    console.warn("Agent Bridge: native host disconnected", p.error && p.error.message);
    clearTimeout(healthy);
    if (port === me) port = null;
    updateBadge();
    scheduleReconnect();
  });
  // connectNative() reports a missing/crashing host only via onDisconnect, so
  // reset the backoff once the port has stayed up, not on every attempt.
  const healthy = setTimeout(() => { retryMs = 2000; }, 10000);
  updateBadge();
}

function scheduleReconnect() {
  setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 60000);
}

function reply(id, payload) {
  if (port) port.postMessage({ id, ...payload });
}

async function onRequest(msg) {
  const { id, tool, args } = msg || {};
  if (id === undefined) return;
  if (!enabled && !["_stage", "_browser_info"].includes(tool)) {
    reply(id, { ok: false, error: "Agent Bridge is paused by the user (toolbar button in Firefox). Ask the user to resume it." });
    return;
  }
  const fn = TOOLS[tool];
  if (!fn) { reply(id, { ok: false, error: `Unknown tool: ${tool}` }); return; }
  try {
    // Clicks and drags are recorded before they run, so the marker sits on the
    // page that was clicked rather than on the page the click led to.
    if (recording.active && isPointerAction(tool, args || {})) await recordFrame(tool, args || {}).catch(() => {});
    const out = await fn(args || {});
    const content = typeof out === "string" ? [{ type: "text", text: out }] : out;
    if (recording.active && !isPointerAction(tool, args || {})) await recordFrame(tool, args || {}).catch(() => {});
    reply(id, { ok: true, content });
  } catch (e) {
    reply(id, { ok: false, error: String((e && e.message) || e) });
  }
}

// ------------------------------------------------------------ tab group
async function findGroup() {
  const groups = await browser.tabGroups.query({ title: GROUP_TITLE });
  return groups.length ? groups[0] : null;
}

async function groupTabs() {
  const g = await findGroup();
  if (!g) return [];
  const tabs = await browser.tabs.query({});
  return tabs.filter((t) => t.groupId === g.id);
}

async function refreshTabSet() {
  const tabs = await groupTabs();
  agentTabIds.clear();
  for (const t of tabs) agentTabIds.add(t.id);
}

// A new group lives in its own new window, like Claude in Chrome; later tabs
// join the group wherever it is.
async function createTab() {
  const g = await findGroup();
  let tab;
  if (g) {
    tab = await browser.tabs.create({ url: "about:blank", active: true, windowId: g.windowId });
    await browser.tabs.group({ tabIds: [tab.id], groupId: g.id });
  } else {
    const w = await browser.windows.create({ url: "about:blank" });
    tab = w.tabs[0];
    const gid = await browser.tabs.group({ tabIds: [tab.id] });
    await browser.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR });
  }
  agentTabIds.add(tab.id);
  return browser.tabs.get(tab.id);
}

async function requireTab(tabId) {
  if (typeof tabId !== "number") throw new Error("tabId is required. Call tabs_context_mcp first to get one.");
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch (_) {
    throw new Error(`Tab ${tabId} does not exist. Call tabs_context_mcp for current tab IDs.`);
  }
  const g = await findGroup();
  if (!g || tab.groupId !== g.id) {
    throw new Error(`Tab ${tabId} is not in the "${GROUP_TITLE}" tab group. Only tabs in that group can be controlled; the user can drag a tab into it, or use tabs_create_mcp.`);
  }
  return tab;
}

async function contextText(createIfEmpty) {
  let tabs = await groupTabs();
  if (!tabs.length && createIfEmpty) tabs = [await createTab()];
  await refreshTabSet();
  if (!tabs.length) {
    return { tabs, text: `No "${GROUP_TITLE}" tab group exists. Call tabs_context_mcp with createIfEmpty=true to create one.` };
  }
  const list = tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
  return { tabs, text: `Tabs in the "${GROUP_TITLE}" group (only these can be controlled):\n${JSON.stringify(list, null, 2)}` };
}

browser.tabs.onUpdated.addListener((tabId, info) => {
  if ("groupId" in info) refreshTabSet();
});
browser.tabs.onRemoved.addListener((tabId) => {
  agentTabIds.delete(tabId);
  netBuf.delete(tabId);
  tabHost.delete(tabId);
});
if (browser.tabGroups.onUpdated) browser.tabGroups.onUpdated.addListener(() => refreshTabSet());
if (browser.tabGroups.onRemoved) browser.tabGroups.onRemoved.addListener(() => refreshTabSet());

// --------------------------------------------------------------- network
const SECRET_PARAM = /token|key|auth|secret|pass|session|sig|code|credential|jwt|bearer/i;

function redactUrl(u) {
  try {
    const x = new URL(u);
    if (x.username || x.password) { x.username = "REDACTED"; x.password = ""; }
    for (const k of [...x.searchParams.keys()]) if (SECRET_PARAM.test(k)) x.searchParams.set(k, "REDACTED");
    return x.toString();
  } catch (_) { return u; }
}

function recordNet(d, extra) {
  if (!agentTabIds.has(d.tabId)) return;
  let arr = netBuf.get(d.tabId);
  if (!arr) { arr = []; netBuf.set(d.tabId, arr); }
  arr.push({ ts: d.timeStamp, method: d.method, url: redactUrl(d.url), type: d.type, status: d.statusCode, ...extra });
  if (arr.length > MAX_NET) arr.shift();
}
// Like Chrome: the log starts over when the tab moves to another domain.
browser.webRequest.onBeforeRequest.addListener((d) => {
  if (d.type !== "main_frame") return;
  let host = "";
  try { host = new URL(d.url).hostname; } catch (_) { /* odd URL */ }
  if (tabHost.has(d.tabId) && tabHost.get(d.tabId) !== host) netBuf.delete(d.tabId);
  tabHost.set(d.tabId, host);
}, { urls: ["<all_urls>"] });
browser.webRequest.onCompleted.addListener((d) => recordNet(d, {}), { urls: ["<all_urls>"] });
browser.webRequest.onErrorOccurred.addListener((d) => recordNet(d, { error: d.error }), { urls: ["<all_urls>"] });

// ----------------------------------------------------- page-side helper
const PAGE_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what)), ms); }),
  ]);
}

// Refs made inside a cross-origin frame name it: ref_f<frameId>_N.
function frameOfRef(ref) {
  const m = /^ref_f(\d+)_\d+$/.exec(ref || "");
  return m ? Number(m[1]) : 0;
}

// Runs a page method in the right frame and follows hand-offs into
// cross-origin child frames. Returns {value, frameId} (the frame that answered).
async function callPageEx(tabId, method, args, frameId) {
  args = args || {};
  if (frameId === undefined) frameId = frameOfRef(args.ref || args.ref_id);
  for (let hops = 0; hops < 8; hops++) {
    const res = await callFrame(tabId, frameId, method, args);
    if (!res.forward) return { value: res.value, frameId, args };
    frameId = res.forward.frameId;
    args = { ...args, ...res.forward.args };
  }
  throw new Error("Too many nested frames.");
}

async function callPage(tabId, method, args, frameId) {
  return (await callPageEx(tabId, method, args, frameId)).value;
}

// A point in a frame's viewport -> the tab's top viewport.
async function toTop(tabId, frameId, pt) {
  let [x, y] = pt;
  while (frameId) {
    const f = await browser.webNavigation.getFrame({ tabId, frameId });
    if (!f) break;
    const [ox, oy] = await callPage(tabId, "frameOrigin", { frameId }, f.parentFrameId);
    x += ox; y += oy;
    frameId = f.parentFrameId;
  }
  return [x, y];
}

// read_page / get_page_text leave a marker line where a cross-origin frame
// sits; replace each with that frame's own output (recursively).
async function expandFrames(tabId, text, method, args, budget = { n: 0 }) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("\u0001")) { out.push(line); continue; }
    const parts = line.slice(1).split(" ");
    const frameId = Number(parts[1]);
    if (++budget.n > 30) { out.push("  (more frames not expanded)"); continue; }
    try {
      if (parts[0] === "FRAME") {
        const indent = Number(parts[2]), depth = Number(parts[3]);
        if (depth < 0) continue;
        let sub = await callPage(tabId, "readPage", { ...args, ref_id: undefined, depth, bare: true }, frameId);
        sub = await expandFrames(tabId, sub, method, args, budget);
        if (sub) out.push(sub.split("\n").map((l) => "  ".repeat(indent) + l).join("\n"));
      } else if (parts[0] === "FRAMETEXT") {
        let sub = await callPage(tabId, "pageText", { bare: true }, frameId);
        sub = await expandFrames(tabId, sub, method, args, budget);
        if (sub) out.push(`\n[iframe ${parts.slice(2).join(" ")}]\n${sub}`);
      }
    } catch (e) {
      out.push(`  (frame ${frameId} not readable: ${e.message})`);
    }
  }
  return out.join("\n");
}

async function callFrame(tabId, frameId, method, args) {
  const code = `window.__agentBridge ? window.__agentBridge.call(${JSON.stringify(method)}, ${JSON.stringify(args || {})}) : null`;
  const exec = (details) => withTimeout(browser.tabs.executeScript(tabId, { ...details, frameId }), PAGE_TIMEOUT_MS, "PAGE_TIMEOUT");
  let res;
  try {
    [res] = await exec({ code });
    if (res === null) {
      await exec({ file: "/content.js" });
      [res] = await exec({ code });
    }
  } catch (e) {
    if (e.message === "PAGE_TIMEOUT") {
      throw new Error(`The page did not respond within ${PAGE_TIMEOUT_MS / 1000}s. It may be blocked by a dialog ` +
        "(alert/confirm/prompt/beforeunload, possibly in an iframe) or a long-running script; take a screenshot or ask the user.");
    }
    if (frameId) throw new Error(`Cannot access frame ${frameId}: ${e.message}.`);
    const tab = await browser.tabs.get(tabId);
    throw new Error(`Cannot access page ${tab.url}: ${e.message}. (about:, view-source:, addons.mozilla.org and other privileged pages are off-limits to extensions.)`);
  }
  if (!res) throw new Error("Page helper did not respond.");
  if (!res.ok) throw new Error(res.error);
  return res;
}

async function waitForLoad(tabId, timeoutMs = 30000) {
  const start = Date.now();
  await sleep(250);
  while (Date.now() - start < timeoutMs) {
    const t = await browser.tabs.get(tabId);
    if (t.status === "complete") return t;
    await sleep(200);
  }
  return browser.tabs.get(tabId);
}

async function afterInput(tabId, out) {
  await sleep(150);
  const t = await browser.tabs.get(tabId);
  if (t.status === "loading") { const t2 = await waitForLoad(tabId); return `${out}\nPage navigated to ${t2.url}`; }
  return out;
}

// ------------------------------------------------------------ screenshot
async function activate(tab) {
  if (!tab.active) {
    await browser.tabs.update(tab.id, { active: true });
    await sleep(350);
  }
}

const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);

async function toBitmap(dataUrl) {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

async function screenshot(tab, { region, scale } = {}) {
  await activate(tab);
  const vp = await callPage(tab.id, "viewport", {}).catch(() => null);
  let dataUrl = await browser.tabs.captureTab(tab.id, { format: "jpeg", quality: 80, scale: 1 });
  let note = vp ? `Viewport ${vp.w}x${vp.h} CSS px (screenshot pixels = CSS px; use these coordinates for clicks). Scroll (${Math.round(vp.sx)},${Math.round(vp.sy)}). ${vp.url}` : "";
  if (region) {
    const [x0, y0, x1, y1] = region;
    const img = await toBitmap(dataUrl);
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const z = Math.min(4, Math.max(1, 1200 / Math.max(w, h)));
    const c = canvas(w * z, h * z);
    c.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, c.width, c.height);
    dataUrl = c.toDataURL("image/jpeg", 0.9);
    note = `Zoomed region [${x0},${y0},${x1},${y1}] at ${z.toFixed(2)}x. Coordinates for clicks are still full-viewport CSS px.`;
  }
  const image = { type: "image", data: b64(dataUrl), mimeType: "image/jpeg" };
  const s = Number(scale);
  if (s && s < 1) {
    const img = await toBitmap(dataUrl);
    const c = canvas(img.width * Math.max(0.1, s), img.height * Math.max(0.1, s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    image._full = image.data; // kept by the MCP server for upload_image, never sent to the model
    image.data = b64(c.toDataURL("image/jpeg", 0.85));
    note += ` Image scaled to ${c.width}x${c.height}; coordinates are still in the full-size frame.`;
  }
  return [image, { type: "text", text: note }];
}

// ------------------------------------------------------------ GIF capture
const recording = { active: false, frames: [], groupId: null };
const MAX_FRAMES = 150;

function frameAction(tool, a) {
  if (tool === "navigate") return { label: a.url === "back" || a.url === "forward" ? `Go ${a.url}` : `Navigate to ${a.url}` };
  if (tool === "form_input") return { label: a.action_summary || "Fill form field" };
  if (tool !== "computer") return null;
  if (["wait", "zoom"].includes(a.action)) return null;
  if (a.action === "screenshot") return { label: "" };
  const words = { left_click: "Click", right_click: "Right-click", double_click: "Double-click", triple_click: "Triple-click",
    type: "Type", key: "Press", scroll: "Scroll", scroll_to: "Scroll to element", left_click_drag: "Drag", hover: "Hover" };
  let label = a.action_summary || words[a.action] || a.action;
  if (!a.action_summary && a.action === "type") label += ` "${String(a.text || "").slice(0, 40)}"`;
  if (!a.action_summary && a.action === "key") label += ` ${a.text || ""}`;
  return {
    label,
    click: /click/.test(a.action) && a.action !== "left_click_drag" ? a.coordinate || null : null,
    drag: a.action === "left_click_drag" ? [a.start_coordinate, a.coordinate] : null,
  };
}

function isPointerAction(tool, a) {
  return tool === "computer" && /click/.test(a.action || "");
}

async function recordFrame(tool, a) {
  const act = frameAction(tool, a);
  if (!act || typeof a.tabId !== "number" || !agentTabIds.has(a.tabId)) return;
  const tab = await browser.tabs.get(a.tabId);
  // A ref click has no coordinate yet: scroll the element into view (the
  // click would anyway) and mark its centre.
  if (act.click === null && a.ref && /click/.test(a.action) && a.action !== "left_click_drag") {
    act.click = await callPageEx(tab.id, "pointOf", { ref: a.ref })
      .then((r) => toTop(tab.id, r.frameId, r.value)).catch(() => null);
  }
  await activate(tab);
  const vp = await callPage(tab.id, "viewport", {}).catch(() => null);
  const dataUrl = await browser.tabs.captureTab(tab.id, { format: "jpeg", quality: 75, scale: 1 });
  recording.frames.push({ dataUrl, vpW: vp ? vp.w : null, ts: Date.now(), ...act });
  if (recording.frames.length > MAX_FRAMES) recording.frames.shift();
}

function drawArrow(ctx, [x0, y0], [x1, y1]) {
  ctx.strokeStyle = "rgb(220,38,38)"; ctx.fillStyle = "rgb(220,38,38)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 14 * Math.cos(a - 0.45), y1 - 14 * Math.sin(a - 0.45));
  ctx.lineTo(x1 - 14 * Math.cos(a + 0.45), y1 - 14 * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
}

async function buildGif(opts = {}) {
  const o = { showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, showWatermark: true, quality: 10, ...opts };
  const frames = recording.frames;
  if (!frames.length) throw new Error("No frames recorded. Use start_recording, act, then take a screenshot before stop_recording.");
  const first = await toBitmap(frames[0].dataUrl);
  const W = Math.min(800, first.width), H = Math.round(first.height * (W / first.width));
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const img = i === 0 ? first : await toBitmap(f.dataUrl);
    const c = canvas(W, H), ctx = c.getContext("2d");
    ctx.fillStyle = "rgb(0,0,0)"; ctx.fillRect(0, 0, W, H);
    const k = Math.min(W / img.width, H / img.height);
    const dw = img.width * k, dh = img.height * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
    ctx.drawImage(img, ox, oy, dw, dh);
    const css = (f.vpW ? img.width / f.vpW : 1) * k; // CSS px -> GIF px
    const P = (p) => [ox + p[0] * css, oy + p[1] * css];
    if (o.showClickIndicators && f.click) {
      const [x, y] = P(f.click);
      ctx.strokeStyle = "rgb(255,140,0)"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = "rgb(255,140,0)"; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
    }
    if (o.showDragPaths && f.drag && f.drag[0] && f.drag[1]) drawArrow(ctx, P(f.drag[0]), P(f.drag[1]));
    if (o.showActionLabels && f.label) {
      ctx.font = "bold 15px sans-serif";
      const text = f.label.length > 70 ? f.label.slice(0, 69) + "…" : f.label;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgb(0,0,0)"; ctx.fillRect(10, H - 44, tw + 20, 28);
      ctx.fillStyle = "rgb(255,255,255)"; ctx.fillText(text, 20, H - 25);
    }
    if (o.showWatermark) {
      ctx.font = "bold 13px sans-serif"; ctx.textAlign = "right";
      ctx.fillStyle = "rgb(40,40,40)"; ctx.fillText("Agent Bridge", W - 9, 21);
      ctx.fillStyle = "rgb(255,255,255)"; ctx.fillText("Agent Bridge", W - 10, 20);
      ctx.textAlign = "left";
    }
    if (o.showProgressBar) {
      ctx.fillStyle = "rgb(255,140,0)"; ctx.fillRect(0, H - 6, Math.round(W * (i + 1) / frames.length), 6);
    }
    out.push({ imageData: ctx.getImageData(0, 0, W, H), delayMs: i === frames.length - 1 ? 2500 : 1000 });
  }
  return { bytes: GifEncoder.encode(out, W, H, o.quality), W, H, n: frames.length };
}

function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------- uploads
function takeStaged(key) {
  const s = staged.get(key);
  if (!s || s.chunks.length !== s.total || s.chunks.some((c) => c === undefined)) throw new Error("Upload data incomplete; retry.");
  staged.delete(key);
  return s.chunks.join("");
}

async function convertImage(dataB64, fromType, toType) {
  if (!toType || toType === fromType || !/^image\/(png|jpeg|webp)$/.test(toType)) return { data: dataB64, type: fromType };
  const img = await toBitmap(`data:${fromType};base64,${dataB64}`);
  const c = canvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return { data: b64(c.toDataURL(toType, 0.92)), type: toType };
}

// ------------------------------------------------------------------ tools
const ZOOM_KEYS = /^(ctrl|cmd|meta|control)\+(=|\+|-|_|0|plus|minus|equal)$/i;

const TOOLS = {
  async tabs_context_mcp({ createIfEmpty = false }) {
    return (await contextText(createIfEmpty)).text;
  },

  async tabs_create_mcp() {
    const t = await createTab();
    return `Created tab ${t.id} in the "${GROUP_TITLE}" group.`;
  },

  async tabs_close_mcp({ tabId }) {
    await requireTab(tabId);
    await browser.tabs.remove(tabId);
    agentTabIds.delete(tabId);
    const left = await groupTabs();
    return `Closed tab ${tabId}.` + (left.length ? "" : ` That was the last tab, so the "${GROUP_TITLE}" group is gone.`);
  },

  async navigate({ tabId, url }) {
    if (!url) throw new Error("url is required (or 'back' / 'forward').");
    let appended = "";
    if (tabId === undefined || tabId === null) {
      if (url === "back" || url === "forward") throw new Error("tabId is required for back/forward.");
      const ctx = await contextText(true);
      tabId = ctx.tabs[0].id;
      appended = `\n\n${ctx.text}`;
    }
    await requireTab(tabId);
    if (url === "back") await browser.tabs.goBack(tabId);
    else if (url === "forward") await browser.tabs.goForward(tabId);
    else {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
      await browser.tabs.update(tabId, { url });
    }
    const t = await waitForLoad(tabId);
    return `Navigated tab ${tabId} to ${t.url}\nTitle: ${t.title}${t.status !== "complete" ? "\n(still loading after 30s)" : ""}${appended}`;
  },

  async computer(args) {
    const tab = await requireTab(args.tabId);
    const a = args.action;
    switch (a) {
      case "screenshot":
        return screenshot(tab, { scale: args.scale });
      case "zoom":
        if (!args.region) throw new Error("zoom needs region [x0, y0, x1, y1].");
        return screenshot(tab, { region: args.region, scale: args.scale });
      case "wait": {
        const s = Math.min(Math.max(Number(args.duration) || 1, 0), 10);
        await sleep(s * 1000);
        return `Waited ${s}s`;
      }
      case "left_click": case "right_click": case "double_click": case "triple_click": {
        const button = a === "right_click" ? "right" : "left";
        const clicks = a === "double_click" ? 2 : a === "triple_click" ? 3 : 1;
        const { value: res, frameId } = await callPageEx(tab.id, "click", { ref: args.ref, coordinate: args.coordinate, button, clicks, modifiers: args.modifiers });
        // A string means the click opened a dialog (see content.js); otherwise {text, at}.
        if (typeof res === "string") return res;
        let text = res.text;
        if (frameId) {
          const [tx, ty] = await toTop(tab.id, frameId, res.at).catch(() => res.at);
          text = text.replace(/ at \([^)]*\)/, ` at (${Math.round(tx)}, ${Math.round(ty)}) in cross-origin frame ${frameId}`);
        }
        return afterInput(tab.id, text);
      }
      case "hover":
        return callPage(tab.id, "hover", { ref: args.ref, coordinate: args.coordinate });
      case "left_click_drag":
        return callPage(tab.id, "drag", { start_coordinate: args.start_coordinate, coordinate: args.coordinate });
      case "type":
        if (typeof args.text !== "string") throw new Error("type needs text.");
        return callPage(tab.id, "type", { text: args.text });
      case "key": {
        if (typeof args.text !== "string") throw new Error("key needs text, e.g. \"Enter\" or \"ctrl+a Backspace\".");
        if (args.text.trim().split(/\s+/).some((k) => ZOOM_KEYS.test(k))) {
          throw new Error("Page zoom shortcuts are not supported; use the zoom action to magnify a region instead.");
        }
        const repeat = Math.min(Math.max(Math.round(Number(args.repeat) || 1), 1), 100);
        return afterInput(tab.id, await callPage(tab.id, "key", { text: args.text, repeat }));
      }
      case "scroll":
        return callPage(tab.id, "scroll", { coordinate: args.coordinate, scroll_direction: args.scroll_direction,
          scroll_amount: Math.min(Math.max(Number(args.scroll_amount) || 3, 1), 10) });
      case "scroll_to":
        return callPage(tab.id, "scrollTo", { ref: args.ref });
      default:
        throw new Error(`Unknown computer action: ${a}`);
    }
  },

  async read_page({ tabId, filter, ref_id, depth, max_chars }) {
    await requireTab(tabId);
    const args = { filter, ref_id, depth, max_chars };
    return expandFrames(tabId, await callPage(tabId, "readPage", args), "readPage", { filter, max_chars });
  },

  // Keyword search over every frame (the MCP server tries a model-based
  // search first and falls back to this).
  async find({ tabId, query }) {
    await requireTab(tabId);
    if (!query) throw new Error("query is required.");
    const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0 }]);
    let hits = [];
    for (const f of frames) {
      const r = await callPage(tabId, "find", { query, bare: true, limit: 200 }, f.frameId).catch(() => []);
      hits = hits.concat(r);
    }
    hits.sort((a, b) => b.score - a.score);
    if (!hits.length) return `No elements matched "${query}".`;
    let out = hits.slice(0, 20).map((h) => h.line).join("\n");
    if (hits.length > 20) out += `\n(${hits.length} matches; showing the best 20. Use a more specific query.)`;
    return out;
  },

  async form_input({ tabId, ref, value }) {
    await requireTab(tabId);
    return callPage(tabId, "formInput", { ref, value });
  },

  async get_page_text({ tabId }) {
    await requireTab(tabId);
    return expandFrames(tabId, await callPage(tabId, "pageText", {}), "pageText", {});
  },

  async javascript_tool({ tabId, text, action }) {
    await requireTab(tabId);
    if (action !== undefined && action !== "javascript_exec") throw new Error("action must be 'javascript_exec'.");
    if (!text) throw new Error("text (JavaScript code) is required.");
    const r = await callPage(tabId, "evalPage", { code: text });
    if (r.csp) {
      // Page CSP blocks eval in the page world; run in the extension's
      // content world instead (DOM access works, page globals via window.wrappedJSObject).
      const [v] = await browser.tabs.executeScript(tabId, { code: text });
      let s;
      try { s = v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch (_) { s = String(v); }
      return `(page CSP blocks eval; ran in the isolated content world)\n${s}`;
    }
    if (!r.ok) throw new Error(r.error);
    let s = r.value;
    if (s.length > 50000) s = s.slice(0, 50000) + "\n…(truncated)";
    return s;
  },

  async read_console_messages({ tabId, pattern, onlyErrors, clear, limit }) {
    await requireTab(tabId);
    return callPage(tabId, "readConsole", { pattern, onlyErrors, clear, limit });
  },

  async read_network_requests({ tabId, urlPattern, clear, limit = 100 }) {
    await requireTab(tabId);
    let arr = netBuf.get(tabId) || [];
    if (urlPattern) arr = arr.filter((r) => r.url.includes(urlPattern));
    const total = arr.length;
    const shown = arr.slice(-limit);
    if (clear) netBuf.delete(tabId);
    if (!shown.length) return `No network requests recorded for tab ${tabId}${urlPattern ? ` matching "${urlPattern}"` : ""} (recording starts once a tab is in the "${GROUP_TITLE}" group and restarts on a change of domain).`;
    return `${total} request(s)${total > shown.length ? `, showing last ${shown.length}` : ""}:\n` +
      shown.map((r) => `${new Date(r.ts).toISOString().slice(11, 23)} ${r.method} ${r.error ? "ERR " + r.error : r.status} [${r.type}] ${r.url}`).join("\n");
  },

  async resize_window({ tabId, width, height }) {
    const tab = await requireTab(tabId);
    await browser.windows.update(tab.windowId, { width, height });
    const w = await browser.windows.get(tab.windowId);
    return `Window ${w.id} is now ${w.width}x${w.height} (the window manager may refuse or adjust sizes).`;
  },

  async gif_creator({ tabId, action, download, coordinate, filename, options }) {
    const tab = await requireTab(tabId);
    switch (action) {
      case "start_recording":
        recording.active = true; recording.frames = []; recording.groupId = tab.groupId;
        updateBadge();
        return "Recording started. Take a screenshot now to capture the first frame.";
      case "stop_recording":
        recording.active = false;
        updateBadge();
        return `Recording stopped with ${recording.frames.length} frame(s). Use export to make the GIF, or clear to discard.`;
      case "clear": {
        const n = recording.frames.length;
        recording.frames = [];
        return `Discarded ${n} frame(s).`;
      }
      case "export": {
        const gif = await buildGif(options);
        const name = (filename || `recording-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.gif`).replace(/[\\/]/g, "_");
        if (coordinate) {
          const out = await callPage(tab.id, "attachFiles", { coordinate, files: [{ name, type: "image/gif", b64: bytesToB64(gif.bytes) }] });
          return `GIF (${gif.n} frames, ${gif.W}x${gif.H}, ${(gif.bytes.length / 1024).toFixed(0)} KB) dropped onto the page: ${out}`;
        }
        if (!download) throw new Error("Set download: true (or give coordinate) for export.");
        const url = URL.createObjectURL(new Blob([gif.bytes], { type: "image/gif" }));
        const id = await browser.downloads.download({ url, filename: name, saveAs: false, conflictAction: "uniquify" });
        let item;
        for (let i = 0; i < 50; i++) {
          [item] = await browser.downloads.search({ id });
          if (item && item.state !== "in_progress") break;
          await sleep(100);
        }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return `GIF exported: ${gif.n} frames, ${gif.W}x${gif.H}, ${(gif.bytes.length / 1024).toFixed(0)} KB -> ${item ? item.filename : name}`;
      }
      default:
        throw new Error("action must be start_recording, stop_recording, export or clear.");
    }
  },

  // ---- internal calls from the MCP server (not exposed as tools)
  async _stage({ key, seq, total, chunk }) {
    const now = Date.now();
    for (const [k, v] of staged) if (now - v.ts > 120000) staged.delete(k);
    let s = staged.get(key);
    if (!s) { s = { chunks: new Array(total), total, ts: now }; staged.set(key, s); }
    s.chunks[seq] = chunk;
    return "ok";
  },

  async _upload({ tabId, ref, coordinate, files, convertTo }) {
    await requireTab(tabId);
    const prepared = [];
    for (const f of files) {
      let data = takeStaged(f.key), type = f.type;
      if (convertTo) ({ data, type } = await convertImage(data, type, convertTo));
      prepared.push({ name: f.name, type, b64: data });
    }
    return callPage(tabId, "attachFiles", { ref, coordinate, files: prepared });
  },

  // ---- trusted mode (the MCP server sends real input over WebDriver BiDi)
  async _prepare({ tabId, token }) {
    const tab = await requireTab(tabId);
    await activate(tab);
    if (token !== undefined) await callPage(tabId, "setMark", { token });
    return JSON.stringify({ url: tab.url });
  },

  async _point({ tabId, ref }) {
    await requireTab(tabId);
    const r = await callPageEx(tabId, "pointOf", { ref });
    return JSON.stringify(await toTop(tabId, r.frameId, r.value));
  },

  async _label_at({ tabId, coordinate }) {
    await requireTab(tabId);
    return callPage(tabId, "labelAt", { coordinate }).catch(() => "the element there");
  },

  // Which frame a top-viewport point lands in, the point in that frame's
  // viewport, and what is there. Cross-origin frames run in their own
  // process, so real input has to be sent to that frame's BiDi context.
  async _locate({ tabId, coordinate, mark }) {
    await requireTab(tabId);
    let r;
    try { r = await callPageEx(tabId, "labelAt", { coordinate }); } catch (_) {
      return JSON.stringify({ frameId: 0, coordinate, label: "the element there" });
    }
    if (r.frameId && mark !== undefined) await callPage(tabId, "setMark", { token: mark }, r.frameId);
    return JSON.stringify({ frameId: r.frameId, coordinate: r.args.coordinate, label: r.value });
  },

  async _unmark_frame({ tabId, frameId }) {
    await requireTab(tabId);
    await callPage(tabId, "setMark", { token: "" }, frameId).catch(() => {});
    return "ok";
  },

  // The focused element and the frame it is in (marked for BiDi if asked).
  async _focused({ tabId, mark }) {
    await requireTab(tabId);
    let r;
    try { r = await callPageEx(tabId, "focusedLabel", {}); } catch (_) {
      return JSON.stringify({ frameId: 0, label: "the focused element" });
    }
    if (r.frameId && mark !== undefined) await callPage(tabId, "setMark", { token: mark }, r.frameId);
    return JSON.stringify({ frameId: r.frameId, label: r.value });
  },

  async _record({ tool, args, phase }) {
    if (!recording.active) return "off";
    if ((phase === "before") === isPointerAction(tool, args)) await recordFrame(tool, args).catch(() => {});
    return "ok";
  },

  async _settle({ tabId, text }) {
    await requireTab(tabId);
    return afterInput(tabId, text);
  },

  async _browser_info() {
    const info = await browser.runtime.getBrowserInfo();
    const plat = await browser.runtime.getPlatformInfo();
    let { deviceId } = await browser.storage.local.get("deviceId");
    if (!deviceId) {
      deviceId = "firefox-" + crypto.randomUUID().slice(0, 8);
      await browser.storage.local.set({ deviceId });
    }
    return JSON.stringify({ deviceId, name: `${info.name} ${info.version}`, platform: plat.os, connected: !!port });
  },
};

// ------------------------------------------------------------------ init
(async () => {
  const s = await browser.storage.local.get("enabled");
  enabled = s.enabled !== false;
  await refreshTabSet();
  connect();
})();
