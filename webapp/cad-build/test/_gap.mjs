import path from 'path';
import { fileURLToPath } from 'url';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', '..', 'public', 'cad', 'vendor', 'cad-worker.js');
const inbox = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => inbox.push(m);
const orig = console.log;
console.log = () => {};
await import(bundle);
console.log = orig;
const take = async (pred) => { const t0 = Date.now(); while (Date.now() - t0 < 60000) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };
await take((m) => /ready|init-error/.test(m.type));
let seq = 0;
const item = (o) => Object.assign({ id: o.name, role: 'solid', pos: [0, 0, 0], rot: [0, 0, 0], clearance: 0, round: 0, chamfer: 0, hollow: 0 }, o);
const send = async (msg) => { const id = ++seq; self.onmessage({ data: Object.assign({ id }, msg) }); return take((m) => m.id === id); };
const build = (items) => send({ type: 'build', items });
const vol = (m) => F.meshVolume(m.vertices, m.triangles);
const bb = (m) => F.meshBounds(m.vertices);

const box = (name, pos) => item({ name, type: 'box', size: { x: 20, y: 20, z: 10, corner: 0 }, pos });
const push = item({ name: 'Push', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [0, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 20 }] });

const skinny = (name, pos, rot) => item({ name, type: 'box', size: { x: 40, y: 8, z: 10, corner: 0 }, pos, rot: rot || [0, 0, 0] });
const wide = item({ name: 'Push', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [25, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 80, h: 20 }] });
const cases = [
  ['wide cutter two boxes', [box('A', [0, 0, 0]), box('B', [50, 0, 0]), wide]],
  ['aabb overlap cut', [skinny('A', [0, 0, 0]), skinny('B', [0, 14, 0], [0, 0, 40]), push]],
  ['cross cut', [box('A', [0, 0, 0]), item({ name: 'B', type: 'box', size: { x: 40, y: 8, z: 10, corner: 0 }, pos: [0, 0, 0], rot: [0, 0, 90] }), push]],
  ['apart no cut', [box('A', [0, 0, 0]), box('B', [80, 0, 0])]],
  ['apart cut', [box('A', [0, 0, 0]), box('B', [80, 0, 0]), push]],
  ['touch cut', [box('A', [0, 0, 0]), box('B', [20, 0, 0]), push]],
  ['overlap 2 cut', [box('A', [0, 0, 0]), box('B', [18, 0, 0]), push]],
  ['overlap 2 no cut', [box('A', [0, 0, 0]), box('B', [18, 0, 0])]],
  ['stack cut', [box('A', [0, 0, 0]), box('B', [0, 0, 10]), push]],
  ['beside y cut', [box('A', [0, 0, 0]), box('B', [0, 20, 0]), push]],
];
function outsideCross(x, y, z) {
  const inA = Math.abs(x) <= 10.2 && Math.abs(y) <= 10.2 && z >= -0.2 && z <= 10.2;
  const inB = Math.abs(x) <= 4.2 && Math.abs(y) <= 20.2 && z >= -0.2 && z <= 10.2;
  return !inA && !inB;
}
for (const [name, items] of cases) {
  const r = await build(items);
  const b = bb(r.result);
  let bad = 0;
  if (name === 'cross cut') {
    const v = r.result.vertices, t = r.result.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const xs = [0, 1, 2].map((k) => v[t[i + k] * 3]);
      const ys = [0, 1, 2].map((k) => v[t[i + k] * 3 + 1]);
      const zs = [0, 1, 2].map((k) => v[t[i + k] * 3 + 2]);
      if (outsideCross((xs[0] + xs[1] + xs[2]) / 3, (ys[0] + ys[1] + ys[2]) / 3, (zs[0] + zs[1] + zs[2]) / 3)) bad++;
    }
  }
  console.log(name, 'vol', Math.round(vol(r.result)), 'tris', r.result.triangles.length, 'lo', b.lo.map((x) => +x.toFixed(2)), 'hi', b.hi.map((x) => +x.toFixed(2)), 'outside', bad, 'err', JSON.stringify(r.errors || {}));
}

import fs from 'fs';
const html = fs.readFileSync('/Users/bharath/Documents/accretion_data/3D Printing/frametap.html', 'utf8');
const data = JSON.parse(html.match(/<script type="application\/json" id="cad-data">([\s\S]*?)<\/script>/)[1]);
const live = data.items.filter((it) => !it.hidden && !it.draft);
console.log('live', live.map((it) => it.name + ' ' + it.role).join(' | '));
const solids = data.items.filter((it) => it.role === 'solid');
const holes = data.items.filter((it) => it.role === 'hole');
let sum = 0;
for (const s of solids.filter((it) => !it.hidden && !it.draft)) {
  const r = await build([s]);
  if (!r.result) { console.log('alone', s.name, 'NO RESULT', r.errors); continue; }
  const b = bb(r.result);
  const v = vol(r.result);
  sum += v;
  console.log('alone', s.name, 'vol', Math.round(v), 'lo', b.lo.map((x) => +x.toFixed(1)), 'hi', b.hi.map((x) => +x.toFixed(1)), r.errors);
}
const pair = solids.filter((it) => !it.hidden && !it.draft);
const rp = await build(pair);
console.log('solids together', Math.round(vol(rp.result)), 'sum of alones', Math.round(sum), 'tris', rp.result.triangles.length, 'bounds', bb(rp.result));
let cutSum = 0;
for (const s of pair) {
  const r = await build([s, ...holes]);
  if (!r.result) { console.log('cut alone', s.name, r.errors); continue; }
  const v = vol(r.result);
  cutSum += v;
  const b = bb(r.result);
  console.log('cut alone', s.name, Math.round(v), 'lo', b.lo.map((x) => +x.toFixed(1)), 'hi', b.hi.map((x) => +x.toFixed(1)), 'tris', r.result.triangles.length);
}
console.log('sum of cut alones', Math.round(cutSum));
const fr = await build(data.items);
{
  const v = fr.result.vertices, t = fr.result.triangles;
  const inA = (x) => x >= 20.4 && x <= 38.6;
  const inB = (x) => x >= -3.6 && x <= 2.1;
  let span = 0, out = 0;
  for (let i = 0; i < t.length; i += 3) {
    const xs = [0, 1, 2].map((k) => v[t[i + k] * 3]);
    const a = xs.filter(inA).length, b = xs.filter(inB).length;
    if (a && b) span++;
    if (xs.some((x) => !inA(x) && !inB(x))) out++;
  }
  console.log('triangles spanning both objects', span, 'triangles outside both', out, 'of', t.length / 3);
  const lines = fr.result.lines || new Float32Array(0);
  let bridge = 0;
  for (let i = 0; i < lines.length; i += 6) {
    const x0 = lines[i], x1 = lines[i + 3];
    if ((inA(x0) && inB(x1)) || (inB(x0) && inA(x1))) bridge++;
  }
  console.log('edge lines', lines.length / 6, 'bridging', bridge);
}
const fb = bb(fr.result);
console.log('with pushes', Math.round(vol(fr.result)), 'tris', fr.result.triangles.length, 'lo', fb.lo.map((x) => +x.toFixed(1)), 'hi', fb.hi.map((x) => +x.toFixed(1)));
console.log('errors', fr.errors);
