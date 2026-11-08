import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', '..', 'public', 'cad', 'vendor', 'cad-worker.js');
const inbox = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => inbox.push(m);
const orig = console.log; console.log = () => {};
await import(bundle);
console.log = orig;
const take = async (pred) => { const t0 = Date.now(); while (Date.now() - t0 < 60000) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };
await take((m) => /ready|init-error/.test(m.type));
let seq = 0;
const send = async (msg) => { const id = ++seq; self.onmessage({ data: Object.assign({ id }, msg) }); return take((m) => m.id === id); };
const html = fs.readFileSync('/Users/bharath/Documents/accretion_data/3D Printing/frametap.html', 'utf8');
const data = JSON.parse(html.match(/<script type="application\/json" id="cad-data">([\s\S]*?)<\/script>/)[1]);
const F = await import('./fixtures.mjs');
const vol = (m) => m && m.vertices ? F.meshVolume(m.vertices, m.triangles) : 0;
const bb = (m) => m && m.vertices ? F.meshBounds(m.vertices) : null;
const solids = data.items.filter((it) => it.role === 'solid' && !it.hidden && !it.draft);
for (const s of solids) {
  const a = await send({ type: 'build', items: [s] });
  const b = bb(a.result);
  console.log('alone', s.name, a.result ? Math.round(vol(a.result)) : 'NONE', b ? b.lo.map((x) => +x.toFixed(1)) : '', b ? b.hi.map((x) => +x.toFixed(1)) : '', JSON.stringify(a.errors || {}));
}
const part = solids.find((s) => s.name === 'Extrude part 1');
const own = data.items.filter((it) => !it.hidden && !it.draft && (it === part || it.role === 'hole' && (!it.host || it.host === part.id)));
const ro = await send({ type: 'build', items: own });
console.log('part + its own pushes', ro.result ? Math.round(vol(ro.result)) : 'NONE', bb(ro.result) && bb(ro.result).lo.map((x) => +x.toFixed(1)), bb(ro.result) && bb(ro.result).hi.map((x) => +x.toFixed(1)));
const all = await send({ type: 'build', items: data.items });
const b = bb(all.result);
console.log('together', all.result ? Math.round(vol(all.result)) : 'NONE', 'tris', all.result && all.result.triangles.length, b && b.lo.map((x) => +x.toFixed(1)), b && b.hi.map((x) => +x.toFixed(1)));
console.log('errors', JSON.stringify(all.errors || {}));
const r = all;
const v = r.result.vertices, t = r.result.triangles;
const W = 720, H = 420;
function crc(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c; }
function png(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const data = deflateSync(raw);
  const chunk = (type, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(type, 4); d.copy(b, 8); b.writeInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0))]);
}
function view(axis) {
  const buf = new Uint8Array(W * H * 3); buf.fill(248);
  const plot = (x, y) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; buf[o] = 20; buf[o + 1] = 70; buf[o + 2] = 150; };
  const A = axis[0], B = axis[1];
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (let i = 0; i < v.length; i += 3) { minA = Math.min(minA, v[i + A]); maxA = Math.max(maxA, v[i + A]); minB = Math.min(minB, v[i + B]); maxB = Math.max(maxB, v[i + B]); }
  const pad = 20, s = Math.min((W - pad * 2) / (maxA - minA || 1), (H - pad * 2) / (maxB - minB || 1));
  const X = (q) => pad + (q - minA) * s, Y = (q) => H - pad - (q - minB) * s;
  const line = (x0, y0, x1, y1) => {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx - dy;
    for (;;) { plot(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 > -dy) { err -= dy; x0 += sx; } if (e2 < dx) { err += dx; y0 += sy; } }
  };
  for (let i = 0; i < t.length; i += 3) {
    const p = [0, 1, 2].map((k) => { const q = t[i + k] * 3; return [X(v[q + A]), Y(v[q + B])]; });
    line(p[0][0], p[0][1], p[1][0], p[1][1]); line(p[1][0], p[1][1], p[2][0], p[2][1]); line(p[2][0], p[2][1], p[0][0], p[0][1]);
  }
  return buf;
}
const names = ['xy', 'xz', 'yz'];
[[0, 1], [0, 2], [1, 2]].forEach((a, i) => fs.writeFileSync(path.join(here, '_gap_' + names[i] + '.png'), png(view(a), W, H)));
console.log('tris', t.length / 3);
