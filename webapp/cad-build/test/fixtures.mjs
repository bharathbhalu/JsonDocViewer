// Test fixtures for the 3D modeling tests: small model files built in memory.
import { zipSync, strToU8 } from 'fflate';

// A 10 mm cube from (0,0,0) to (10,10,10), outward-facing triangles.
export const CUBE_V = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
export const CUBE_F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

export function binarySTL(faces = CUBE_F, verts = CUBE_V) {
  const buf = new ArrayBuffer(84 + faces.length * 50); const dv = new DataView(buf);
  dv.setUint32(80, faces.length, true);
  faces.forEach((f, i) => f.forEach((vi, k) => verts[vi].forEach((x, j) => dv.setFloat32(84 + i * 50 + 12 + k * 12 + j * 4, x, true))));
  return buf;
}
export function asciiSTL(faces = CUBE_F, verts = CUBE_V) {
  let s = 'solid t\n';
  for (const f of faces) s += 'facet normal 0 0 0\nouter loop\n' + f.map((vi) => 'vertex ' + verts[vi].join(' ') + '\n').join('') + 'endloop\nendfacet\n';
  return strToU8(s + 'endsolid t\n').buffer;
}
export const brokenSTL = () => binarySTL(CUBE_F.slice(0, 10)); // top two faces missing: not watertight
export function obj() {
  return strToU8(CUBE_V.map((v) => 'v ' + v.join(' ')).join('\n') + '\n' + CUBE_F.map((f) => 'f ' + f.map((i) => i + 1).join(' ')).join('\n') + '\n').buffer;
}
// 3MF in centimetres, cube referenced through a component scaled 2× on X → 20 × 10 × 10 mm.
export function threeMF() {
  const verts = CUBE_V.map(([x, y, z]) => `<vertex x="${x / 10}" y="${y / 10}" z="${z / 10}"/>`).join('');
  const tris = CUBE_F.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  const model = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
    <object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object>
    <object id="2" type="model"><components><component objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
  </resources><build><item objectid="2"/></build></model>`;
  const z = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(model) });
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
}
// A 1×1 PNG (red), for the image import test.
export const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)).buffer;

// Volume of an indexed triangle mesh (divergence theorem); positive = closed, outward.
export function meshVolume(v, t) {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
}
export function meshBounds(v) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  return { lo, hi, size: hi.map((h, k) => h - lo[k]) };
}
// Every edge used by exactly two triangles, in opposite directions → watertight & consistently oriented.
export function isClosed(t) {
  const e = new Map();
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const a = t[i + k], b = t[i + (k + 1) % 3]; const key = a + ',' + b; e.set(key, (e.get(key) || 0) + 1); }
  for (const [key, n] of e) { if (n !== 1) return false; const [a, b] = key.split(','); if (e.get(b + ',' + a) !== 1) return false; }
  return true;
}
// Binary STL → {vertices, triangles} with welded vertices.
export function parseSTL(buf) {
  const dv = new DataView(buf); const n = dv.getUint32(80, true);
  const map = new Map(); const v = []; const t = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const o = 84 + i * 50 + 12 + k * 12; const p = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    const key = p.map((x) => Math.round(x * 1e4)).join(',');
    let j = map.get(key); if (j === undefined) { j = v.length / 3; v.push(...p); map.set(key, j); } t.push(j);
  }
  return { vertices: v, triangles: t, count: n };
}
