'use strict';
/* Generates PWA icons (icon-192, icon-512, maskable-512) as PNGs.
 * Pure Node: hand-rolled PNG encoder + supersampled shape rendering. No deps.
 * Design: warm gradient rounded square, white timer ring, white lightning bolt. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function writePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- shape helpers (unit square 0..1) ---------- */

function inRoundedRect(u, v, r) {
  const qx = Math.abs(u - 0.5) - (0.5 - r);
  const qy = Math.abs(v - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= r;
}

function inPoly(u, v, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Lightning bolt in unit-square coords (centered ~0.5,0.5)
const BOLT = [[0.58, 0.10], [0.25, 0.55], [0.45, 0.55], [0.42, 0.90], [0.75, 0.45], [0.53, 0.45]];
const BOLT_BOX = 0.62;

function inBolt(u, v) {
  if (u < 0.14 || u > 0.86 || v < 0.06 || v > 0.94) return false; // quick reject
  const bu = (u - 0.5) / BOLT_BOX + 0.5;
  const bv = (v - 0.5) / BOLT_BOX + 0.5;
  return inPoly(bu, bv, BOLT);
}

const RING_R = 0.36;
const RING_T = 0.0275; // half thickness
const RADIUS = 0.225;
const C1 = [255, 138, 92]; // top-left  #ff8a5c
const C2 = [255, 46, 99];  // bottom-right #ff2e63

/* ---------- render ---------- */

function render(size, maskable) {
  const SS = 4; // supersampling factor per axis
  const out = Buffer.alloc(size * size * 4);
  const shrink = maskable ? 0.74 : 1; // maskable: keep art inside safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) / (size * SS);
          const py = (y * SS + sy + 0.5) / (size * SS);
          const u = (px - 0.5) / shrink + 0.5;
          const v = (py - 0.5) / shrink + 0.5;

          const inBg = maskable ? true : inRoundedRect(u, v, RADIUS);
          if (!inBg) continue;

          // diagonal gradient background
          const t = (u + v) / 2;
          let cr = C1[0] + (C2[0] - C1[0]) * t;
          let cg = C1[1] + (C2[1] - C1[1]) * t;
          let cb = C1[2] + (C2[2] - C1[2]) * t;

          // timer ring
          const d = Math.hypot(u - 0.5, v - 0.5);
          if (Math.abs(d - RING_R) <= RING_T) {
            const w = 0.95;
            cr = cr * (1 - w) + 255 * w;
            cg = cg * (1 - w) + 255 * w;
            cb = cb * (1 - w) + 255 * w;
          }

          // lightning bolt
          if (inBolt(u, v)) { cr = 255; cg = 255; cb = 255; }

          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const count = a / 255;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round((count / n) * 255);
    }
  }
  return writePng(size, out);
}

/* ---------- main ---------- */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true]
];

for (const [name, size, maskable] of jobs) {
  const png = render(size, maskable);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
