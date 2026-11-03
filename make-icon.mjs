#!/usr/bin/env node
// make-icon.mjs — build assets/chatgpt-fastlane.ico and a 256 px PNG preview. Composition, like the ChatGPT
// Start-menu tile: a dark rounded square with the white OpenAI mark (the app's own
// Square44x44Logo.targetsize-256_altform-unplated.png), plus the Fysics Sub2API portrait circle as a badge
// in the lower-right corner and a small amber lightning bolt in the upper-right corner ("fast").
// No dependencies: PNG decode/encode on node:zlib, an exact box-filter resampler, a supersampled rasteriser.
// Sources are only read: the installed Store package (or --logo <png>) and the Sub2API portrait
// (--portrait <png>, default: the fysics-infra repo's asset_images\fysics_sub2api\sub2api_portrait.png).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "assets");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

// ---- design (unit coordinates of the icon) ----
const TILE = [0x2f, 0x2f, 0x2f], TILE_RADIUS = 0.22;         // dark plate like the Start tile
const MARK = { x: 0.07, y: 0.07, size: 0.62 };                // OpenAI mark: top-left square
const PORTRAIT = { cx: 0.715, cy: 0.715, r: 0.255, ring: 0.03 }; // Sub2API circle, white ring, bottom-right
const BOLT_BADGE = { cx: 0.80, cy: 0.20, r: 0.14, ring: 0.025 }; // amber disc with white bolt, top-right
const AMBER = [0xff, 0xb0, 0x00], AMBER_DARK = [0xf5, 0x8a, 0x00], WHITE = [0xff, 0xff, 0xff];
const BOLT = [[0.58, 0.14], [0.30, 0.56], [0.47, 0.56], [0.40, 0.88], [0.72, 0.44], [0.55, 0.44], [0.64, 0.14]];

function installedAssets() {
  try {
    const loc = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", windowsHide: true }).trim();
    if (loc) return path.join(loc, "assets");
  } catch { /* fall through */ }
  return null;
}
const LOGO = opt("--logo", null) ?? (installedAssets() && path.join(installedAssets(), "Square44x44Logo.targetsize-256_altform-unplated.png"));
const PORTRAIT_FILE = opt("--portrait", path.join(HERE, "..", "fysics-infra", "asset_images", "fysics_sub2api", "sub2api_portrait.png"));
if (!LOGO || !fs.existsSync(LOGO)) throw new Error("OpenAI mark not found; pass --logo <white-on-transparent png>");
if (!fs.existsSync(PORTRAIT_FILE)) throw new Error(`portrait not found at ${PORTRAIT_FILE}; pass --portrait <png>`);

// ---- PNG decode (8-bit, colour types 0/2/4/6, no interlace) -> {w, h, rgba} ----
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, depth = 0, interlace = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString("latin1", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; interlace = d[12]; }
    else if (t === "IDAT") idat.push(d);
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(ct)) throw new Error(`unsupported PNG (depth ${depth}, type ${ct}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct], stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat));
  const img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = img.subarray(y * stride, (y + 1) * stride), prev = y ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0, b = prev ? prev[i] : 0, c = prev && i >= ch ? prev[i - ch] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 0xff;
    }
  }
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    if (ct === 6) { rgba[i * 4] = img[s]; rgba[i * 4 + 1] = img[s + 1]; rgba[i * 4 + 2] = img[s + 2]; rgba[i * 4 + 3] = img[s + 3]; }
    else if (ct === 2) { rgba[i * 4] = img[s]; rgba[i * 4 + 1] = img[s + 1]; rgba[i * 4 + 2] = img[s + 2]; rgba[i * 4 + 3] = 255; }
    else if (ct === 4) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = img[s]; rgba[i * 4 + 3] = img[s + 1]; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = img[s]; rgba[i * 4 + 3] = 255; }
  }
  return { w, h, rgba };
}

// Exact box-filter resample of a square RGBA image to n×n (premultiplied so edges stay clean).
function resample({ w, rgba }, n) {
  const out = new Float32Array(n * n * 4), k = w / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const x0 = x * k, x1 = (x + 1) * k, y0 = y * k, y1 = (y + 1) * k;
    let r = 0, g = 0, b = 0, a = 0, area = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx)), i = (sy * w + sx) * 4, al = rgba[i + 3] * wgt;
        r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al; area += wgt;
      }
    }
    const o = (y * n + x) * 4;
    if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a / area; }
  }
  return { w: n, h: n, rgba: out };
}

// Sub2API portrait: the PNG is a black disc with white art on an opaque white background -> keep the disc only.
function portraitDisc(img) {
  const { w, rgba } = img, c = (w - 1) / 2, r = w / 2 - 4; // the artwork's circle is 7..953 of 960
  const out = Float32Array.from(rgba);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - c, y - c), i = (y * w + x) * 4;
    out[i + 3] = d <= r - 1 ? 255 : d >= r + 1 ? 0 : 255 * (r + 1 - d) / 2;
  }
  return { w, h: w, rgba: out };
}

// ---- compositing helpers (straight alpha, colours 0..255) ----
function over(dst, i, r, g, b, a) { // a in 0..1
  const da = dst[i + 3] / 255, oa = a + da * (1 - a);
  if (oa <= 0) return;
  dst[i] = (r * a + dst[i] * da * (1 - a)) / oa; dst[i + 1] = (g * a + dst[i + 1] * da * (1 - a)) / oa; dst[i + 2] = (b * a + dst[i + 2] * da * (1 - a)) / oa; dst[i + 3] = oa * 255;
}
function blit(dst, n, src, x0, y0) { // src is already sized; top-left at integer (x0, y0)
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const dx = x0 + x, dy = y0 + y; if (dx < 0 || dy < 0 || dx >= n || dy >= n) continue;
    const s = (y * src.w + x) * 4; if (src.rgba[s + 3] <= 0) continue;
    over(dst, (dy * n + dx) * 4, src.rgba[s], src.rgba[s + 1], src.rgba[s + 2], src.rgba[s + 3] / 255);
  }
}
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Rasterise a shape given as sample(u, v) -> colour | null, supersampled, over the whole icon.
function rasterise(dst, n, sample) {
  const ss = n >= 64 ? 4 : 8;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let cov = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample((x + (sx + 0.5) / ss) / n, (y + (sy + 0.5) / ss) / n);
      if (c) { cov++; r += c[0]; g += c[1]; b += c[2]; }
    }
    if (cov) over(dst, (y * n + x) * 4, r / cov, g / cov, b / cov, cov / (ss * ss));
  }
}

function compose(n, logo, portrait) {
  const px = new Float32Array(n * n * 4);
  // 1. dark rounded tile
  rasterise(px, n, (u, v) => {
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - TILE_RADIUS), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - TILE_RADIUS), 0);
    return Math.hypot(dx, dy) <= TILE_RADIUS ? TILE : null;
  });
  // 2. OpenAI mark
  const ms = Math.round(MARK.size * n);
  blit(px, n, resample(logo, ms), Math.round(MARK.x * n), Math.round(MARK.y * n));
  // 3. portrait disc with a white ring
  const pr = PORTRAIT.r, ring = n < 32 ? Math.max(PORTRAIT.ring, 1 / n) : PORTRAIT.ring;
  rasterise(px, n, (u, v) => (Math.hypot(u - PORTRAIT.cx, v - PORTRAIT.cy) <= pr ? WHITE : null));
  const ps = Math.round((pr - ring) * 2 * n);
  blit(px, n, resample(portrait, ps), Math.round(PORTRAIT.cx * n - ps / 2), Math.round(PORTRAIT.cy * n - ps / 2));
  // 4. bolt badge (bolt drawn only where it can still be read)
  const br = BOLT_BADGE.r, bring = n < 32 ? Math.max(BOLT_BADGE.ring, 1 / n) : BOLT_BADGE.ring;
  rasterise(px, n, (u, v) => {
    const dx = u - BOLT_BADGE.cx, dy = v - BOLT_BADGE.cy, d = Math.hypot(dx, dy);
    if (d > br) return null;
    if (d > br - bring) return WHITE;
    const r = br - bring, lx = (dx + r) / (2 * r), ly = (dy + r) / (2 * r);
    if (n >= 40 && inPolygon(lx, ly, BOLT)) return WHITE;
    return lx + ly > 1 ? AMBER_DARK : AMBER;
  });
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(px[i])));
  return out;
}

// ---- PNG encoder (RGBA, filter 0) and ICO container ----
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(n, px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) Buffer.from(px.buffer, px.byteOffset + y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = [], blobs = []; let offset = 6 + 16 * images.length;
  for (const { n, data } of images) {
    const e = Buffer.alloc(16); e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const logo = decodePng(fs.readFileSync(LOGO));
const portrait = portraitDisc(decodePng(fs.readFileSync(PORTRAIT_FILE)));
console.log(`mark: ${LOGO} (${logo.w} px)\nportrait: ${PORTRAIT_FILE} (${portrait.w} px)`);
const images = SIZES.map((n) => ({ n, data: encodePng(n, compose(n, logo, portrait)) }));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "chatgpt-fastlane.ico"), ico(images));
fs.writeFileSync(path.join(OUT_DIR, "chatgpt-fastlane-256.png"), images[images.length - 1].data);
fs.writeFileSync(path.join(OUT_DIR, "chatgpt-fastlane-32.png"), images.find((i) => i.n === 32).data);
console.log(`wrote assets/chatgpt-fastlane.ico (${SIZES.join(", ")} px), chatgpt-fastlane-256.png, chatgpt-fastlane-32.png`);
