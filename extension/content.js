// Page-side half of Agent Bridge. Runs in the extension's isolated content
// world (Firefox Xray), loaded at document_start on every page so console
// capture starts before page scripts run. The background script calls into it
// with tabs.executeScript({code: "window.__agentBridge.call(...)"}).
(() => {
  if (window.__agentBridge) return;

  // ---------------------------------------------------------------- console
  const consoleBuf = [];
  const MAX_CONSOLE = 1000;

  function fmt(a) {
    try {
      if (typeof a === "string") return a;
      if (a === undefined) return "undefined";
      if (a && typeof a === "object" && "stack" in a && "message" in a) {
        return String(a.stack || a.message);
      }
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch (_) {
      try { return String(a); } catch (__) { return "[unserializable]"; }
    }
  }

  function record(level, args) {
    let text = Array.from(args, fmt).join(" ");
    if (text.length > 4000) text = text.slice(0, 4000) + "…";
    consoleBuf.push({ ts: Date.now(), level, text, url: location.href });
    if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift();
  }

  try {
    const pageWin = window.wrappedJSObject;
    const pageConsole = pageWin.console;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = pageConsole[level];
      exportFunction(function (...args) {
        try { record(level, args); } catch (_) { /* never break the page */ }
        // The rest array lives in the content compartment; the page-side
        // console needs a page-compartment array or it can't read .length.
        const pageArgs = new pageWin.Array();
        for (const a of args) pageArgs.push(a);
        return pageWin.Reflect.apply(orig, pageConsole, pageArgs);
      }, pageConsole, { defineAs: level });
    }
  } catch (_) { /* privileged/odd pages: no console capture */ }

  window.addEventListener("error", (e) => {
    record("exception", [`${e.message} (${e.filename}:${e.lineno}:${e.colno})`]);
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    record("exception", ["Unhandled rejection:", e.reason]);
  });

  // ------------------------------------------------------------------- refs
  // Refs carry the frame they live in (ref_f<frameId>_N outside the top
  // frame) so the background can route a call straight to that frame.
  let MY_FRAME = 0;
  try { MY_FRAME = browser.runtime.getFrameId(window); } catch (_) { /* top frame */ }
  const REF_PREFIX = MY_FRAME ? `ref_f${MY_FRAME}_` : "ref_";
  let refSeq = 0;
  const el2ref = new WeakMap();
  const ref2el = new Map();

  function refOf(el) {
    let r = el2ref.get(el);
    if (!r) {
      r = REF_PREFIX + (++refSeq);
      el2ref.set(el, r);
      ref2el.set(r, new WeakRef(el));
    }
    return r;
  }

  function elOf(ref) {
    const w = ref2el.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ${ref} not found (page changed?). Call read_page or find again.`);
    }
    return el;
  }

  // ---------------------------------------------------------- a11y helpers
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n = 100) => (s.length > n ? s.slice(0, n) + "…" : s);

  // Same-origin iframes are walked into, so every helper resolves the
  // element's own document/window instead of assuming the top one.
  const docOf = (el) => (el && el.ownerDocument) || document;
  const winOf = (el) => docOf(el).defaultView || window;
  const css = (el) => winOf(el).getComputedStyle(el);

  // A same-origin (i)frame's document, or null when cross-origin / not loaded.
  function frameDoc(el) {
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) return null;
    try {
      const d = el.contentDocument;
      return d && d.documentElement ? d : null;
    } catch (_) { return null; }
  }

  // The extension frameId of a cross-origin (i)frame element, else null.
  function xframeId(el) {
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME") || frameDoc(el)) return null;
    try {
      const id = browser.runtime.getFrameId(el);
      return id >= 0 ? id : null;
    } catch (_) { return null; }
  }
  const MARK = "\u0001";

  // Top-left of a frame element's content box in its parent's viewport.
  function frameContentOrigin(fe) {
    const r = fe.getBoundingClientRect(), st = css(fe);
    return [r.left + fe.clientLeft + parseFloat(st.paddingLeft), r.top + fe.clientTop + parseFloat(st.paddingTop)];
  }

  const TAG_ROLES = {
    BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
    ASIDE: "complementary", FORM: "form", TABLE: "table", TR: "row", TD: "cell",
    TH: "columnheader", UL: "list", OL: "list", LI: "listitem", DIALOG: "dialog",
    SUMMARY: "button", LABEL: "label", P: "paragraph", OPTION: "option",
    ARTICLE: "article", IFRAME: "iframe", VIDEO: "video", AUDIO: "audio",
  };
  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button",
    reset: "button", image: "button", file: "button", range: "slider",
    search: "searchbox", number: "spinbutton",
  };
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
    "switch", "slider", "spinbutton", "treeitem",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);

  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return "none";
      return INPUT_ROLES[ty] || "textbox";
    }
    if (t === "SELECT" && el.multiple) return "listbox";
    if (t === "svg" || t === "SVG") return el.getAttribute("aria-label") ? "img" : "none";
    return TAG_ROLES[t] || "generic";
  }

  function accName(el) {
    const al = el.getAttribute("aria-label");
    if (al) return clean(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const s = clean(lb.split(/\s+/).map((id) => docOf(el).getElementById(id)?.textContent || "").join(" "));
      if (s) return s;
    }
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      if (el.id) {
        const l = docOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return clean(l.textContent);
      }
      const pl = el.closest("label");
      if (pl) return clean(pl.textContent);
      if (el.placeholder) return clean(el.placeholder);
      if (t === "INPUT" && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
    }
    if (t === "IMG") return clean(el.alt);
    if (el.title) return clean(el.title);
    return "";
  }

  function textName(el) {
    return clean(el.innerText !== undefined ? el.innerText : el.textContent);
  }

  function isHidden(el, st) {
    if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse") return true;
    if (st.display === "contents") return false;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 && el.children.length === 0;
  }

  function isInteractive(el, r, st) {
    if (INTERACTIVE_ROLES.has(r)) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    if (el.hasAttribute("onclick")) return true;
    if (st.cursor === "pointer") {
      const p = el.parentElement;
      if (!p || css(p).cursor !== "pointer") return true;
    }
    return false;
  }

  function directText(el) {
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return clean(s);
  }

  function describe(el, r) {
    const name = accName(el) || (["link", "button", "heading", "option", "tab", "menuitem", "listitem", "cell", "columnheader", "label"].includes(r) ? textName(el) : "");
    let line = r;
    if (name) line += ` "${clip(name)}"`;
    else {
      const dt = directText(el);
      if (dt) line += ` "${clip(dt, 200)}"`;
    }
    line += ` [${refOf(el)}]`;
    const t = el.tagName;
    if (r === "heading" && /^H[1-6]$/.test(t)) line += ` level=${t[1]}`;
    if (t === "IFRAME" || t === "FRAME") {
      const fd = frameDoc(el);
      const xid = xframeId(el);
      line += fd ? ` src="${clip(fd.location.href, 120)}"` : ` src="${clip(el.getAttribute("src") || "", 120)}"` +
        (xid === null ? " (contents not accessible)" : "");
    }
    if (t === "A" && el.getAttribute("href")) line += ` href="${clip(el.getAttribute("href"), 120)}"`;
    if (t === "INPUT" || t === "TEXTAREA") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "INPUT") line += ` type=${ty}`;
      if (ty === "checkbox" || ty === "radio") line += el.checked ? " checked" : " unchecked";
      else if (ty === "password") line += el.value ? ' value="••••"' : "";
      else if (el.value) line += ` value="${clip(el.value, 80)}"`;
    }
    if (t === "SELECT") {
      const o = el.selectedOptions && el.selectedOptions[0];
      if (o) line += ` value="${clip(clean(o.textContent), 80)}"`;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) line += " editable";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
    const exp = el.getAttribute("aria-expanded");
    if (exp) line += ` expanded=${exp}`;
    const sel = el.getAttribute("aria-selected") || el.getAttribute("aria-checked");
    if (sel === "true") line += " selected";
    return line;
  }

  function children(el) {
    const out = [];
    const fd = frameDoc(el);
    if (fd) { out.push(fd.body || fd.documentElement); return out; }
    if (el.shadowRoot) out.push(...el.shadowRoot.children);
    out.push(...el.children);
    return out;
  }

  function readPage({ filter = "all", ref_id, depth = 15, max_chars = 50000, bare = false } = {}) {
    const root = ref_id ? elOf(ref_id) : document.body || document.documentElement;
    const lines = [];
    let chars = 0;
    let truncated = false;
    const interactiveOnly = filter === "interactive";

    function walk(el, d, indent) {
      if (d > depth) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      let st;
      try { st = css(el); } catch (_) { return; }
      if (isHidden(el, st) || el.getAttribute("aria-hidden") === "true") return;
      const r = role(el);
      if (r === "none" && el.tagName !== "svg") { /* fallthrough to children */ }
      const inter = r !== "none" && isInteractive(el, r, st);
      let include;
      let line;
      if (interactiveOnly) {
        include = inter;
        if (include) line = describe(el, r);
      } else if (r !== "generic" && r !== "none") {
        include = true;
        line = describe(el, r);
      } else if (inter) {
        include = true;
        line = describe(el, r);
      } else {
        const dt = directText(el);
        if (dt) { include = true; line = `text "${clip(dt, 200)}"`; }
      }
      if (include) {
        const s = "  ".repeat(interactiveOnly ? 0 : indent) + "- " + line;
        chars += s.length + 1;
        if (chars > max_chars) truncated = true;
        else lines.push(s);
      }
      // Cross-origin frame: the background splices in that frame's own tree here.
      const xid = xframeId(el);
      if (xid !== null) lines.push(`${MARK}FRAME ${xid} ${interactiveOnly ? 0 : indent + (include ? 1 : 0)} ${depth - d - 1}`);
      // Leaf-ish controls: their text is already in the name.
      if (include && ["button", "link", "heading", "option", "textbox", "img"].includes(r) && !interactiveOnly) return;
      for (const c of children(el)) walk(c, d + 1, include ? indent + 1 : indent);
    }

    walk(root, 0, 0);
    if (bare) return lines.join("\n") + (truncated ? `\n(frame truncated at ${max_chars} chars)` : "");
    let header = `Page: ${document.title}\nURL: ${location.href}\nViewport: ${innerWidth}x${innerHeight} scroll=(${Math.round(scrollX)},${Math.round(scrollY)})\n`;
    if (truncated) header += `(truncated at ${max_chars} of ${chars} chars; pass a larger max_chars, or use ref_id / depth / filter="interactive")\n`;
    return header + "\n" + lines.join("\n");
  }

  function find({ query, limit = 20, bare = false } = {}) {
    const q = clean(query).toLowerCase();
    const tokens = q.split(" ").filter(Boolean);
    const results = [];
    const all = [];
    (function collect(el) {
      if (SKIP_TAGS.has(el.tagName)) return;
      all.push(el);
      for (const c of children(el)) collect(c);
    })(document.body || document.documentElement);
    for (const el of all) {
      let st;
      try { st = css(el); } catch (_) { continue; }
      if (isHidden(el, st)) continue;
      const r = role(el);
      if (r === "none") continue;
      const inter = isInteractive(el, r, st);
      if (!inter && r !== "heading" && r === "generic" && !directText(el)) continue;
      const hay = [r, accName(el), el.placeholder || "", el.getAttribute("name") || "", el.id || "",
        inter || r === "heading" ? textName(el).slice(0, 300) : directText(el)].join(" ").toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      if (!score) continue;
      if (hay.includes(q)) score += tokens.length;
      if (inter) score += 0.5;
      results.push({ score, line: describe(el, r) });
    }
    results.sort((a, b) => b.score - a.score);
    if (bare) return results.slice(0, limit).map((x) => ({ score: x.score, line: "- " + x.line }));
    if (!results.length) return `No elements matched "${query}".`;
    let out = results.slice(0, limit).map((x) => "- " + x.line).join("\n");
    if (results.length > limit) out += `\n(${results.length} matches; showing the best ${limit}. Use a more specific query.)`;
    return out;
  }

  function pageText({ max_chars = 100000, bare = false } = {}) {
    const bodyText = (document.body && document.body.innerText) || document.documentElement.textContent || "";
    // Prefer the main content area when one holds most of the page's text.
    let t = bodyText;
    const cands = Array.from(document.querySelectorAll("article, main, [role=main]"));
    const best = cands.map((e) => e.innerText || "").sort((a, b) => b.length - a.length)[0] || "";
    if (best.length > 500 && best.length > bodyText.length * 0.4) t = best;
    for (const f of document.querySelectorAll("iframe, frame")) {
      const d = frameDoc(f);
      const ft = d && d.body ? d.body.innerText.trim() : "";
      if (ft) t += `\n\n[iframe ${d.location.href}]\n${ft}`;
      const xid = xframeId(f);
      if (xid !== null) t += `\n${MARK}FRAMETEXT ${xid} ${f.getAttribute("src") || ""}`;
    }
    t = t.replace(/\n{3,}/g, "\n\n");
    if (bare) return t.trim();
    let out = `Title: ${document.title}\nURL: ${location.href}\n\n${t}`;
    if (out.length > max_chars) out = out.slice(0, max_chars) + `\n…(truncated at ${max_chars} chars)`;
    return out;
  }

  // ---------------------------------------------------------- input events
  // Element at a top-viewport point, descending into shadow roots and
  // same-origin frames; x/y come back in that element's own viewport.
  function deepPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== el) { el = inner; continue; }
      }
      const fd = frameDoc(el);
      if (fd) {
        const [ox, oy] = frameContentOrigin(el);
        const inner = fd.elementFromPoint(x - ox, y - oy);
        if (inner) { x -= ox; y -= oy; el = inner; continue; }
      }
      const xid = xframeId(el);
      if (xid !== null) {
        const [ox, oy] = frameContentOrigin(el);
        return { el, x, y, xframe: { frameId: xid, x: x - ox, y: y - oy } };
      }
      break;
    }
    return { el, x, y };
  }

  function deepActive() {
    let a = document.activeElement;
    for (;;) {
      if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      const fd = frameDoc(a);
      if (fd && fd.activeElement) { a = fd.activeElement; continue; }
      return a;
    }
  }

  function centerOf(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  // Thrown to hand the current call to a cross-origin child frame; the
  // background re-issues it there with the given argument overrides.
  class Forward {
    constructor(frameId, args) { this.frameId = frameId; this.args = args; }
  }

  function resolveTarget({ ref, coordinate }) {
    if (ref) {
      const el = elOf(ref);
      const [x, y] = centerOf(el);
      return { el, x, y };
    }
    if (!coordinate) throw new Error("Provide coordinate [x, y] or ref.");
    const [x, y] = coordinate;
    const p = deepPoint(x, y);
    if (!p.el) throw new Error(`No element at (${x}, ${y}); is it inside the viewport ${innerWidth}x${innerHeight}?`);
    if (p.xframe) throw new Forward(p.xframe.frameId, { coordinate: [p.xframe.x, p.xframe.y] });
    return p;
  }

  function mods(m = "") {
    const s = m.toLowerCase();
    return {
      ctrlKey: /ctrl|control/.test(s), shiftKey: /shift/.test(s),
      altKey: /alt/.test(s), metaKey: /meta|super|cmd|win/.test(s),
    };
  }

  function mouse(el, type, x, y, extra = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : (type === "wheel" ? WheelEvent : MouseEvent);
    const ev = new Ctor(type, {
      bubbles: !["mouseenter", "mouseleave", "pointerenter", "pointerleave"].includes(type),
      cancelable: true, composed: true, view: winOf(el),
      clientX: x, clientY: y, screenX: x + (winOf(el).mozInnerScreenX || 0), screenY: y + (winOf(el).mozInnerScreenY || 0),
      pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra,
    });
    return el.dispatchEvent(ev);
  }

  function focusable(el) {
    let e = el;
    while (e && e !== docOf(e).body) {
      if (e.tabIndex >= 0 || e.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(e.tagName)) return e;
      e = e.parentElement || (e.getRootNode && e.getRootNode().host);
    }
    return null;
  }

  // Synthetic clicks don't move the caret; do what a real click would.
  function placeCaret(x, y) {
    const a = deepActive();
    if (!a || !(isTextField(a) || a.isContentEditable)) return;
    const d = docOf(a);
    const cp = d.caretPositionFromPoint && d.caretPositionFromPoint(x, y);
    if (!cp) return;
    try {
      if (isTextField(a)) {
        if (cp.offsetNode === a) a.setSelectionRange(cp.offset, cp.offset);
      } else if (a.contains(cp.offsetNode)) {
        d.getSelection().collapse(cp.offsetNode, cp.offset);
      }
    } catch (_) { /* input types without selection API */ }
  }

  function moveCaret(el, key, shift) {
    const dir = key === "ArrowLeft" || key === "ArrowUp" || key === "Home" || key === "PageUp" ? "backward" : "forward";
    if (isTextField(el)) {
      const [s, e] = selRange(el);
      const len = el.value.length;
      let back = false;
      try { back = el.selectionDirection === "backward"; } catch (_) { /* unsupported type */ }
      const anchor = back ? e : s;
      const focus = back ? s : e;
      // Without shift, Left/Right on a selection collapse to its edge.
      if (!shift && s !== e && (key === "ArrowLeft" || key === "ArrowRight")) {
        const p = key === "ArrowLeft" ? s : e;
        try { el.setSelectionRange(p, p); } catch (_) { /* unsupported type */ }
        return true;
      }
      let pos;
      if (key === "Home" || key === "PageUp" || (key === "ArrowUp" && el.tagName !== "TEXTAREA")) pos = 0;
      else if (key === "End" || key === "PageDown" || (key === "ArrowDown" && el.tagName !== "TEXTAREA")) pos = len;
      else if (key === "ArrowLeft") pos = Math.max(0, focus - 1);
      else if (key === "ArrowRight") pos = Math.min(len, focus + 1);
      else {
        // Up/Down inside a textarea: jump to the same column on the adjacent line.
        const v = el.value, lineStart = v.lastIndexOf("\n", focus - 1) + 1, col = focus - lineStart;
        if (key === "ArrowUp") { const prevEnd = lineStart - 1; if (prevEnd < 0) pos = 0; else { const ps = v.lastIndexOf("\n", prevEnd - 1) + 1; pos = Math.min(ps + col, prevEnd); } }
        else { const ne = v.indexOf("\n", focus); if (ne < 0) pos = len; else { const nn = v.indexOf("\n", ne + 1); pos = Math.min(ne + 1 + col, nn < 0 ? len : nn); } }
      }
      try {
        if (shift) el.setSelectionRange(Math.min(anchor, pos), Math.max(anchor, pos), pos < anchor ? "backward" : "forward");
        else el.setSelectionRange(pos, pos);
      } catch (_) { /* unsupported type */ }
      return true;
    }
    if (el.isContentEditable) {
      const gran = key === "Home" || key === "End" ? "lineboundary" : key === "ArrowUp" || key === "ArrowDown" ? "line" : key === "PageUp" || key === "PageDown" ? "documentboundary" : "character";
      docOf(el).getSelection().modify(shift ? "extend" : "move", dir, gran);
      return true;
    }
    return false;
  }

  function label(el) {
    const r = role(el);
    const n = accName(el) || clip(textName(el), 60);
    return `<${el.tagName.toLowerCase()}${r !== "generic" ? " role=" + r : ""}${n ? ` "${n}"` : ""}>`;
  }

  function click({ ref, coordinate, button = "left", clicks = 1, modifiers }) {
    const { el, x, y } = resolveTarget({ ref, coordinate });
    const btn = button === "right" ? 2 : button === "middle" ? 1 : 0;
    const m = mods(modifiers);
    mouse(el, "pointerover", x, y, m); mouse(el, "mouseover", x, y, m);
    mouse(el, "pointermove", x, y, m); mouse(el, "mousemove", x, y, m);
    for (let i = 1; i <= clicks; i++) {
      const base = { ...m, button: btn, detail: i };
      mouse(el, "pointerdown", x, y, { ...base, buttons: 1 << (btn === 2 ? 1 : btn === 1 ? 2 : 0) });
      const ok = mouse(el, "mousedown", x, y, { ...base, buttons: 1 });
      if (i === 1 && ok) {
        const f = focusable(el);
        if (f && f !== deepActive()) f.focus();
        placeCaret(x, y);
      }
      mouse(el, "pointerup", x, y, { ...base, buttons: 0 });
      mouse(el, "mouseup", x, y, { ...base, buttons: 0 });
      if (btn === 0) mouse(el, "click", x, y, base);
      else if (btn === 1) mouse(el, "auxclick", x, y, base);
      if (btn === 2) mouse(el, "contextmenu", x, y, base);
      if (btn === 0 && i === 2) mouse(el, "dblclick", x, y, base);
    }
    if (clicks === 3 && el.select) try { el.select(); } catch (_) { /* not selectable */ }
    let note = "";
    if (el.tagName === "SELECT") note = " (native <select> dropdowns can't be opened synthetically; use form_input)";
    if (el.tagName === "IFRAME") note = " (target is an iframe; clicks inside cross-origin frames are not supported)";
    const top = topPoint(el, x, y);
    return { text: `${button} click x${clicks} on ${label(el)} at (${Math.round(top[0])}, ${Math.round(top[1])})${note}`, at: top };
  }

  // Convert a point in el's own (i)frame viewport to top-viewport coordinates.
  function topPoint(el, x, y) {
    let w = winOf(el);
    while (w && w.frameElement) {
      const [ox, oy] = frameContentOrigin(w.frameElement);
      x += ox; y += oy;
      w = winOf(w.frameElement);
    }
    return [x, y];
  }

  function pointOf({ ref }) {
    const el = elOf(ref);
    const [x, y] = centerOf(el);
    return topPoint(el, x, y);
  }

  function hover({ ref, coordinate }) {
    const { el, x, y } = resolveTarget({ ref, coordinate });
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t, x, y);
    return `Hovered ${label(el)} at (${Math.round(x)}, ${Math.round(y)})`;
  }

  function drag({ start_coordinate, coordinate }) {
    if (!start_coordinate || !coordinate) throw new Error("left_click_drag needs start_coordinate and coordinate.");
    const [x0, y0] = start_coordinate;
    const [x1, y1] = coordinate;
    const src = deepPoint(x0, y0);
    if (!src.el) throw new Error("No element at start_coordinate.");
    if (src.xframe) {
      const dx = x0 - src.xframe.x, dy = y0 - src.xframe.y;
      throw new Forward(src.xframe.frameId, { start_coordinate: [x0 - dx, y0 - dy], coordinate: [x1 - dx, y1 - dy] });
    }
    mouse(src.el, "pointerdown", src.x, src.y, { buttons: 1 }); mouse(src.el, "mousedown", src.x, src.y, { buttons: 1 });
    const steps = 10;
    let cur = src;
    for (let i = 1; i <= steps; i++) {
      const p = deepPoint(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      if (p.el) cur = p;
      mouse(cur.el, "pointermove", cur.x, cur.y, { buttons: 1 }); mouse(cur.el, "mousemove", cur.x, cur.y, { buttons: 1 });
    }
    mouse(cur.el, "pointerup", cur.x, cur.y); mouse(cur.el, "mouseup", cur.x, cur.y);
    return `Dragged from (${x0}, ${y0}) to (${x1}, ${y1})`;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const ty = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color", "hidden"].includes(ty);
  }

  function selRange(el) {
    try {
      if (typeof el.selectionStart === "number") return [el.selectionStart, el.selectionEnd];
    } catch (_) { /* email/number inputs */ }
    return [el.value.length, el.value.length];
  }

  function insertIntoField(el, text) {
    const [s, e] = selRange(el);
    const v = el.value.slice(0, s) + text + el.value.slice(e);
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text }));
    setNativeValue(el, v);
    try { el.setSelectionRange(s + text.length, s + text.length); } catch (_) { /* unsupported type */ }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  }

  function forwardIfFrameFocused(el) {
    const xid = xframeId(el);
    if (xid !== null) throw new Forward(xid, {});
  }

  function type({ text }) {
    const el = deepActive();
    forwardIfFrameFocused(el);
    if (isTextField(el)) {
      insertIntoField(el, text);
      return `Typed ${text.length} chars into ${label(el)}`;
    }
    if (el && el.isContentEditable) {
      const d = docOf(el);
      if (!d.execCommand("insertText", false, text)) {
        const sel = d.getSelection();
        if (sel.rangeCount) { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(d.createTextNode(text)); r.collapse(false); }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      }
      return `Typed ${text.length} chars into ${label(el)}`;
    }
    throw new Error("No focused text field. Click an input first (or use form_input with a ref).");
  }

  const KEY_ALIASES = {
    return: "Enter", enter: "Enter", kp_enter: "Enter", tab: "Tab", backspace: "Backspace",
    delete: "Delete", del: "Delete", escape: "Escape", esc: "Escape", space: " ",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", page_up: "PageUp", pagedown: "PageDown", page_down: "PageDown",
  };
  const KEY_CODES = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

  function tabbables(doc) {
    return Array.from(doc.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable='true']"))
      .filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length);
  }

  function pressOne(combo) {
    const parts = combo.split("+");
    let key = parts.pop();
    const m = mods(parts.join("+"));
    key = KEY_ALIASES[key.toLowerCase()] || (/^f\d+$/i.test(key) ? key.toUpperCase() : key);
    if (key.length === 1 && m.shiftKey) key = key.toUpperCase();
    const el = deepActive() || document.body;
    const d = docOf(el);
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : key === " " ? "Space" : "") : key;
    const init = { key, code, keyCode: KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), bubbles: true, cancelable: true, composed: true, ...m };
    const ok = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (ok) {
      const ctrl = m.ctrlKey || m.metaKey;
      if (ctrl && key.toLowerCase() === "a") {
        if (isTextField(el)) el.select(); else d.execCommand("selectAll");
      } else if (key === "Enter") {
        if (el.tagName === "TEXTAREA") insertIntoField(el, "\n");
        else if (el.isContentEditable) d.execCommand("insertParagraph");
        else if (isTextField(el) && el.form) {
          const btn = el.form.querySelector("button[type=submit],input[type=submit],button:not([type])");
          if (btn) btn.click(); else el.form.requestSubmit();
        } else if (el.tagName === "A" || el.tagName === "BUTTON" || role(el) === "button" || role(el) === "link") el.click();
      } else if (key === " " && !ctrl) {
        if (isTextField(el)) insertIntoField(el, " ");
        else if (el.isContentEditable) d.execCommand("insertText", false, " ");
        else if (el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["checkbox", "radio", "button", "submit"].includes(el.type)) || role(el) === "button") el.click();
      } else if (key === "Backspace" || key === "Delete") {
        if (isTextField(el)) {
          let [s, e] = selRange(el);
          if (s === e) { if (key === "Backspace") s = Math.max(0, s - 1); else e = Math.min(el.value.length, e + 1); }
          setNativeValue(el, el.value.slice(0, s) + el.value.slice(e));
          try { el.setSelectionRange(s, s); } catch (_) { /* unsupported type */ }
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: key === "Backspace" ? "deleteContentBackward" : "deleteContentForward" }));
        } else if (el.isContentEditable) d.execCommand(key === "Backspace" ? "delete" : "forwardDelete");
      } else if (key === "Tab") {
        const list = tabbables(d);
        const i = list.indexOf(el);
        const next = list[(i + (m.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) next.focus();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key) && moveCaret(el, key, m.shiftKey)) {
        // caret moved
      } else if (key.length === 1 && !ctrl && !m.altKey) {
        if (isTextField(el)) insertIntoField(el, key);
        else if (el.isContentEditable) d.execCommand("insertText", false, key);
      } else if (["PageDown", "PageUp", "Home", "End"].includes(key) && !isTextField(el) && !el.isContentEditable) {
        const se = d.scrollingElement, vh = winOf(el).innerHeight;
        if (key === "PageDown") se.scrollBy(0, vh * 0.9);
        if (key === "PageUp") se.scrollBy(0, -vh * 0.9);
        if (key === "Home") se.scrollTo(0, 0);
        if (key === "End") se.scrollTo(0, se.scrollHeight);
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return label(el);
  }

  function key({ text, repeat = 1 }) {
    forwardIfFrameFocused(deepActive());
    const combos = text.trim().split(/\s+/);
    let target = "";
    for (let r = 0; r < repeat; r++) for (const c of combos) target = pressOne(c);
    return `Pressed "${text}"${repeat > 1 ? " x" + repeat : ""} on ${target}`;
  }

  function scrollableAncestor(el) {
    let e = el;
    while (e && e !== docOf(e).body && e !== docOf(e).documentElement) {
      const st = css(e);
      if (/(auto|scroll|overlay)/.test(st.overflowY + st.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) return e;
      e = e.parentElement || (e.getRootNode && e.getRootNode().host);
    }
    return docOf(el).scrollingElement || docOf(el).documentElement;
  }

  function scroll({ coordinate, scroll_direction = "down", scroll_amount = 3 }) {
    const p = deepPoint(...(coordinate || [innerWidth / 2, innerHeight / 2]));
    if (p.xframe) throw new Forward(p.xframe.frameId, { coordinate: [p.xframe.x, p.xframe.y] });
    const { x, y } = p;
    const el = p.el || document.body;
    const px = scroll_amount * 100;
    const dx = scroll_direction === "right" ? px : scroll_direction === "left" ? -px : 0;
    const dy = scroll_direction === "down" ? px : scroll_direction === "up" ? -px : 0;
    const ok = mouse(el, "wheel", x, y, { deltaX: dx, deltaY: dy, deltaMode: 0 });
    if (!ok) return `Wheel event at (${x}, ${y}) was handled by the page (preventDefault).`;
    const sc = scrollableAncestor(el);
    const before = [sc.scrollLeft, sc.scrollTop];
    sc.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return `Scrolled ${scroll_direction} ${px}px in ${sc === document.scrollingElement ? "page" : sc === docOf(sc).scrollingElement ? "iframe" : label(sc)}: (${Math.round(before[0])},${Math.round(before[1])}) -> (${Math.round(sc.scrollLeft)},${Math.round(sc.scrollTop)})`;
  }

  function scrollTo({ ref }) {
    const el = elOf(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return `Scrolled ${label(el)} into view`;
  }

  function formInput({ ref, value }) {
    const el = elOf(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const fire = () => {
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    if (el.tagName === "SELECT") {
      const want = String(value);
      const opt = Array.from(el.options).find((o) => o.value === want) || Array.from(el.options).find((o) => clean(o.textContent) === want) ||
        Array.from(el.options).find((o) => clean(o.textContent).toLowerCase().includes(want.toLowerCase()));
      if (!opt) throw new Error(`No option matching "${want}". Options: ${Array.from(el.options).map((o) => clean(o.textContent)).join(" | ")}`);
      setNativeValue(el, opt.value);
      fire();
      return `Selected "${clean(opt.textContent)}" in ${label(el)}`;
    }
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      const want = value === true || value === "true" || value === "on" || value === 1;
      if (el.checked !== want) el.click();
      return `${label(el)} is now ${el.checked ? "checked" : "unchecked"}`;
    }
    if (isTextField(el)) {
      el.focus();
      setNativeValue(el, String(value));
      fire();
      return `Set ${label(el)} to ${el.type === "password" ? "(hidden)" : JSON.stringify(String(value))}`;
    }
    if (el.isContentEditable) {
      el.focus();
      docOf(el).execCommand("selectAll");
      docOf(el).execCommand("insertText", false, String(value));
      return `Set contents of ${label(el)}`;
    }
    throw new Error(`${label(el)} is not a form field.`);
  }

  function readConsole({ pattern, onlyErrors = false, clear = false, limit = 100 } = {}) {
    let re = null;
    if (pattern) re = new RegExp(pattern, "i");
    let items = consoleBuf.filter((m) => (!onlyErrors || m.level === "error" || m.level === "exception") && (!re || re.test(m.text)));
    const total = items.length;
    items = items.slice(-limit);
    if (clear) consoleBuf.length = 0;
    if (!items.length) return `No console messages${pattern ? ` matching /${pattern}/` : ""} on ${location.href} (captured since page load).`;
    return `${total} message(s)${total > items.length ? `, showing last ${items.length}` : ""}:\n` +
      items.map((m) => `[${new Date(m.ts).toISOString().slice(11, 23)}] ${m.level.toUpperCase()}: ${m.text}`).join("\n");
  }

  // Runs user code in the page's own JS world (like DevTools). Falls back to
  // the content world when the page CSP forbids eval; the caller handles that.
  // Split code at the last top-level statement boundary so the final
  // expression can be returned from an async function (enables top-level await).
  function withReturn(code) {
    let depth = 0, q = null, last = -1;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
      if (ch === "/" && code[i + 1] === "/") { const nl = code.indexOf("\n", i); if (nl < 0) break; i = nl - 1; continue; }
      if (ch === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 1; continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (depth === 0 && (ch === ";" || ch === "\n") && code.slice(i + 1).trim()) last = i;
    }
    const head = last < 0 ? "" : code.slice(0, last + 1);
    let tail = (last < 0 ? code : code.slice(last + 1)).trim().replace(/;\s*$/, "");
    if (!tail || /^(const|let|var|if|for|while|do|switch|try|throw|return|function|class|import|export)\b/.test(tail)) return null;
    return `${head}\nreturn (${tail}\n);`;
  }

  function evalPage({ code, timeout_ms = 30000 }) {
    const wr = withReturn(code);
    const wrapped = `(async () => {
      const AF = (async function () {}).constructor;
      const make = (s) => { if (s === null) return null; try { return new AF(s); } catch (e) { if (e instanceof SyntaxError) return null; throw e; } };
      const fn = make(${JSON.stringify(wr)}) || make(${JSON.stringify(code)});
      if (!fn) return eval(${JSON.stringify(code)});
      return await fn();
    })().then((v) => {
      if (v === undefined) return "undefined";
      if (typeof v === "string") return v;
      try { const s = JSON.stringify(v, null, 2); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
    })`;
    let p;
    try {
      p = window.wrappedJSObject.eval(wrapped);
    } catch (e) {
      return Promise.resolve({ csp: true, error: String(e) });
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: `Timed out after ${timeout_ms}ms` }), timeout_ms);
      p.then(
        exportFunction((v) => { clearTimeout(t); resolve({ ok: true, value: String(v) }); }, window),
        exportFunction((e) => { clearTimeout(t); let s; try { s = String(e); if (e && e.stack) s += "\n" + String(e.stack); } catch (_) { s = "error"; } resolve({ ok: false, error: s }); }, window),
      );
    });
  }

  // Files for file_upload / upload_image / GIF export: set them on a file
  // input, or drop them on an element the way a drag from the desktop would.
  // Built with the page's own constructors: a DataTransfer from the content
  // script's compartment reaches page drop handlers with no files.
  function pageDataTransfer(files) {
    const pw = window.wrappedJSObject;
    const dt = new pw.DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const u8 = new pw.Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const parts = new pw.Array();
      parts.push(u8);
      dt.items.add(new pw.File(parts, f.name, cloneInto({ type: f.type }, pw)));
    }
    return dt;
  }

  function attachFiles({ ref, coordinate, files }) {
    const dt = pageDataTransfer(files);
    const names = files.map((f) => `${f.name} (${Math.round((f.b64.length * 3) / 4 / 1024)} KB)`).join(", ");
    let el, x, y;
    if (ref) {
      el = elOf(ref);
      if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file") {
        if (files.length > 1 && !el.multiple) throw new Error(`${label(el)} accepts a single file; ${files.length} were given.`);
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return `Set ${names} on ${label(el)}`;
      }
      [x, y] = centerOf(el);
    } else if (coordinate) {
      const p = deepPoint(coordinate[0], coordinate[1]);
      if (p.xframe) throw new Forward(p.xframe.frameId, { coordinate: [p.xframe.x, p.xframe.y] });
      ({ el, x, y } = p);
      if (!el) throw new Error(`No element at (${coordinate[0]}, ${coordinate[1]}).`);
    } else {
      throw new Error("Give ref or coordinate.");
    }
    // The page-side DataTransfer can't go through the event init dict (it is a
    // cross-compartment object there), so it is defined on the event itself.
    const W = winOf(el).wrappedJSObject || window.wrappedJSObject;
    const make = (type) => {
      const ev = new W.DragEvent(type, cloneInto({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }, W));
      Object.defineProperty(ev.wrappedJSObject || ev, "dataTransfer", { value: dt, configurable: true });
      return ev;
    };
    el.dispatchEvent(make("dragenter")); el.dispatchEvent(make("dragover"));
    const handled = !el.dispatchEvent(make("drop"));
    return `Dropped ${names} on ${label(el)}${handled ? "" : " (the page did not handle the drop; a file input ref may work better)"}`;
  }

  // Helpers for trusted mode (real input sent over WebDriver BiDi).
  function labelAt({ coordinate }) {
    return label(resolveTarget({ coordinate }).el);
  }

  function focusedLabel() {
    const el = deepActive();
    forwardIfFrameFocused(el);
    return el && el !== document.body ? label(el) : "the page";
  }

  // Lets the MCP server find this tab among BiDi browsing contexts.
  function setMark({ token }) {
    const de = document.documentElement;
    if (token) de.setAttribute("data-agent-bridge-mark", token);
    else de.removeAttribute("data-agent-bridge-mark");
    return true;
  }

  function frameOrigin({ frameId }) {
    const frames = [];
    (function collect(doc) {
      for (const f of doc.querySelectorAll("iframe, frame")) {
        frames.push(f);
        const d = frameDoc(f);
        if (d) collect(d);
      }
    })(document);
    const fe = frames.find((f) => xframeId(f) === frameId);
    if (!fe) throw new Error(`Frame ${frameId} not found in this document.`);
    const [ox, oy] = frameContentOrigin(fe);
    return topPoint(fe, ox, oy);
  }

  function viewport() {
    return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY, url: location.href, title: document.title };
  }

  const methods = { readPage, find, pageText, click, hover, drag, type, key, scroll, scrollTo, formInput, readConsole, evalPage, viewport, attachFiles, pointOf, frameOrigin, labelAt, focusedLabel, setMark };

  // alert/confirm/prompt block the page until a human answers, which used to
  // hang the tool call until the MCP timeout. Wrap them (only once Claude has
  // touched this page) so the pending call returns at once and says so; the
  // dialog itself is left for the user, never auto-answered.
  let dialogWaiter = null;
  let dialogsHooked = false;
  let openDialog = null; // {kind, message} while a dialog is up
  const dialogText = (d) => `${d.kind === "alert" ? "An" : "A"} ${d.kind}() dialog is open in the page: ` +
    `${JSON.stringify(clip(d.message, 300))}. It blocks the page until answered and extensions cannot dismiss it: ` +
    "ask the user to answer it in Firefox, then continue.";
  function hookDialogs() {
    if (dialogsHooked) return;
    dialogsHooked = true;
    try {
      const pageWin = window.wrappedJSObject;
      for (const kind of ["alert", "confirm", "prompt"]) {
        const orig = pageWin[kind];
        if (typeof orig !== "function") continue;
        exportFunction(function (...args) {
          const d = { kind, message: String(args[0] ?? "") };
          openDialog = d;
          try { if (dialogWaiter) dialogWaiter(d); } catch (_) { /* never break the page */ }
          const pageArgs = new pageWin.Array();
          for (const a of args) pageArgs.push(a);
          try {
            return pageWin.Reflect.apply(orig, pageWin, pageArgs);
          } finally {
            if (openDialog === d) openDialog = null;
          }
        }, pageWin, { defineAs: kind });
      }
    } catch (_) { /* privileged/odd pages */ }
  }

  window.__agentBridge = {
    call(method, args) {
      hookDialogs();
      // Timers are suspended while a dialog is up, so fail fast instead of
      // waiting for the background's page timeout.
      if (openDialog) return Promise.resolve({ ok: false, error: dialogText(openDialog) });
      return new Promise((resolve) => {
        let settled = false;
        const done = (r) => {
          if (settled) return;
          settled = true;
          dialogWaiter = null;
          resolve(r);
        };
        dialogWaiter = (d) => done({ ok: true, value: dialogText(d) });
        // Run in a separate task: a dialog opened from inside a microtask would
        // block the microtask checkpoint that delivers this reply.
        setTimeout(async () => {
          try {
            const fn = methods[method];
            if (!fn) throw new Error("unknown method " + method);
            done({ ok: true, value: await fn(args || {}) });
          } catch (e) {
            if (e instanceof Forward) done({ ok: true, forward: { frameId: e.frameId, args: e.args } });
            else done({ ok: false, error: String((e && e.message) || e) });
          }
        }, 0);
      });
    },
  };
})();
