#!/usr/bin/env node
// make-icon.mjs — draw the Codex Fastlane icon (dark rounded square, amber lightning bolt) and write
// assets/codex-fastlane.ico (16…256 px, PNG entries) plus a 256 px PNG preview. No dependencies: a tiny
// supersampled rasteriser and a PNG encoder on node:zlib. Run again after changing the shapes or colours.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "assets");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Design, in unit coordinates (0..1). Bolt: classic seven-point lightning, slightly italic.
const BG = [0x0f, 0x11, 0x17];          // near-black
const BG_EDGE = [0x1c, 0x1f, 0x2a];     // subtle lighter rim
const BOLT = [0xff, 0xb0, 0x00];        // amber
const BOLT_SHADE = [0xff, 0x8a, 0x00];  // darker amber on the lower-right half
const RADIUS = 0.23;                    // corner radius of the square
const BOLT_PTS = [[0.60, 0.10], [0.28, 0.55], [0.47, 0.55], [0.38, 0.90], [0.73, 0.42], [0.54, 0.42], [0.64, 0.10]];

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roundedSquareCoverage(x, y, r) { // 1 inside, 0 outside, for the unit square with corner radius r
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.sqrt(dx * dx + dy * dy) <= r ? 1 : 0;
}

function render(n) {
  const ss = n >= 64 ? 4 : 8; // supersampling per axis
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / n, v = (y + (sy + 0.5) / ss) / n;
      if (!roundedSquareCoverage(u, v, RADIUS)) continue;
      let c;
      if (inPolygon(u, v, BOLT_PTS)) c = (u + v > 1.0) ? BOLT_SHADE : BOLT;
      else {
        const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) > 0.5 - 1.5 / n; // 1.5 px rim
        c = edge ? BG_EDGE : BG;
      }
      a++; r += c[0]; g += c[1]; b += c[2];
    }
    const i = (y * n + x) * 4;
    if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); px[i + 3] = Math.round((255 * a) / (ss * ss)); }
  }
  return px;
}

// --- PNG encoder (RGBA, filter 0) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(n, px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) { raw[y * (n * 4 + 1)] = 0; Buffer.from(px.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// --- ICO container with PNG entries ---
function ico(images) { // [{n, data}]
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = [], blobs = [];
  let offset = 6 + 16 * images.length;
  for (const { n, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const images = SIZES.map((n) => ({ n, data: png(n, render(n)) }));
const icoPath = path.join(OUT_DIR, "codex-fastlane.ico");
fs.writeFileSync(icoPath, ico(images));
fs.writeFileSync(path.join(OUT_DIR, "codex-fastlane-256.png"), images[images.length - 1].data);
console.log(`wrote ${icoPath} (${SIZES.join(", ")} px) and codex-fastlane-256.png`);
