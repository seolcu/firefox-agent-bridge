// Minimal animated GIF89a encoder: one global 256-colour palette built from
// a colour histogram of all frames, LZW-compressed frames, infinite loop.
// No dependencies; used by the background script for gif_creator exports.
"use strict";

const GifEncoder = (() => {
  // Overlay colours are pinned into the palette so markers stay exact.
  const PINNED = [[0, 0, 0], [255, 255, 255], [255, 140, 0], [220, 38, 38], [40, 40, 40]];

  function buildPalette(frames, step) {
    const hist = new Uint32Array(32768);
    for (const f of frames) {
      const d = f.data;
      for (let i = 0; i < d.length; i += 4 * step) hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
    }
    const bins = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) bins.push(k);
    bins.sort((a, b) => hist[b] - hist[a]);
    const pal = PINNED.slice();
    for (const k of bins) {
      if (pal.length >= 256) break;
      pal.push([((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);
    }
    while (pal.length < 256) pal.push([0, 0, 0]);
    const lut = new Uint8Array(32768);
    for (let k = 0; k < 32768; k++) {
      const r = ((k >> 10) & 31) * 8 + 4, g = ((k >> 5) & 31) * 8 + 4, b = (k & 31) * 8 + 4;
      let best = 0, bd = Infinity;
      for (let p = 0; p < 256; p++) {
        const q = pal[p], dr = r - q[0], dg = g - q[1], db = b - q[2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bd) { bd = dd; best = p; if (!dd) break; }
      }
      lut[k] = best;
    }
    return { pal, lut };
  }

  function lzw(indices, out) {
    const minCode = 8, clear = 256, eoi = 257;
    let size = minCode + 1, next = eoi + 1, table = new Map();
    const bytes = [];
    let cur = 0, nbits = 0;
    const emit = (code) => {
      cur |= code << nbits;
      nbits += size;
      while (nbits >= 8) { bytes.push(cur & 255); cur >>>= 8; nbits -= 8; }
    };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const hit = table.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        next = eoi + 1; size = minCode + 1; table = new Map();
      } else {
        if (next >= (1 << size)) size++;
        table.set(key, next++);
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (nbits > 0) bytes.push(cur & 255);
    out.push(minCode);
    for (let i = 0; i < bytes.length; i += 255) {
      const n = Math.min(255, bytes.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(bytes[i + j]);
    }
    out.push(0);
  }

  // frames: [{imageData, delayMs}] all the same size. quality 1-30 = sampling step.
  function encode(frames, width, height, quality = 10) {
    const { pal, lut } = buildPalette(frames.map((f) => f.imageData), Math.max(1, Math.min(30, Math.round(quality))));
    const out = [];
    const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
    for (const c of "GIF89a") out.push(c.charCodeAt(0));
    u16(width); u16(height);
    out.push(0xf7, 0, 0);
    for (const [r, g, b] of pal) out.push(r, g, b);
    out.push(0x21, 0xff, 11);
    for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0));
    out.push(3, 1, 0, 0, 0);
    for (const f of frames) {
      out.push(0x21, 0xf9, 4, 0);
      u16(Math.max(2, Math.round((f.delayMs || 1000) / 10)));
      out.push(0, 0);
      out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
      const d = f.imageData.data;
      const idx = new Uint8Array(width * height);
      for (let i = 0, p = 0; p < idx.length; i += 4, p++) idx[p] = lut[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)];
      lzw(idx, out);
    }
    out.push(0x3b);
    return new Uint8Array(out);
  }

  return { encode };
})();
