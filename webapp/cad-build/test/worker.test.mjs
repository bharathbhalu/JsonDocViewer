// 3D modeling engine tests: runs the built worker (public/cad/vendor/cad-worker.js)
// in Node and checks real geometry — sizes, volumes, closed meshes and exports.
//
//   node cad-build/test/worker.test.mjs
//
// Needs the add-on installed (Settings → 3D modeling, or cad-build/build.sh).
import path from 'path';
import { fileURLToPath } from 'url';
import { unzipSync } from 'fflate';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', '..', 'public', 'cad', 'vendor', 'cad-worker.js');

let pass = 0, fail = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); } console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail && !ok ? '   [' + detail + ']' : '')); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = (t) => console.log('\n' + t);

// ---- run the worker in-process
const inbox = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => inbox.push(m);
const origLog = console.log; const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };
await quiet(async () => import(bundle))();
const take = async (pred, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 20)); } throw new Error('worker timeout'); };
const ready = await take((m) => /ready|init-error/.test(m.type));
check('worker starts (OpenCascade + manifold load)', ready.type === 'ready', ready.message);
let seq = 0;
const files = {
  cube: F.binarySTL(), ascii: F.asciiSTL(), broken: F.brokenSTL(), obj: F.obj(), tmf: F.threeMF(),
};
const extOf = { cube: 'stl', ascii: 'stl', broken: 'stl', obj: 'obj', tmf: '3mf' };
const send = quiet(async (msg) => { const id = ++seq; self.onmessage({ data: Object.assign({ id }, msg) }); return take((m) => m.id === id); });
// Builds, answering 'need' with the requested model files.
async function build(items, groups) {
  let r = await send({ type: 'build', items, groups: groups || {} });
  if (r.type === 'need') { const f = {}; r.keys.forEach((k) => { f[k] = files[k].slice(0); }); r = await send({ type: 'build', items, groups: groups || {}, files: f }); }
  return r;
}
const item = (o) => Object.assign({ id: o.name, role: 'solid', pos: [0, 0, 0], rot: [0, 0, 0], clearance: 0, round: 0, chamfer: 0, hollow: 0 }, o);
const model = (name, key, o) => item(Object.assign({ name, type: 'model', role: 'ref', file: { key, ext: extOf[key] }, scale: 1, units: 'mm', stretch: [1, 1, 1], fit: 'exact' }, o));
const vol = (m) => (m ? F.meshVolume(m.vertices, m.triangles) : 0);
const size = (m) => F.meshBounds(m.vertices).size.map((x) => Math.round(x * 100) / 100);

// ======================================================================
section('Shapes');
{
  let r = await build([item({ name: 'box', type: 'box', size: { x: 30, y: 20, z: 15, corner: 0 } })]);
  check('box 30×20×15 → size', JSON.stringify(size(r.result)) === '[30,20,15]', JSON.stringify(size(r.result)));
  check('box volume 9000', near(vol(r.result), 9000, 0.5), vol(r.result));
  check('box mesh closed', F.isClosed(r.result.triangles));
  check('box sits on the floor, centred', near(F.meshBounds(r.result.vertices).lo[2], 0, 1e-6) && near(F.meshBounds(r.result.vertices).lo[0], -15, 1e-6));
  r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 15, corner: 4 } })]);
  check('box corner 4 → volume 8794 (600 − 4²·(4−π)) × 15', near(vol(r.result), (600 - 16 * (4 - Math.PI)) * 15, 5), vol(r.result));
  r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 15, corner: 0 }, round: 1 })]);
  check('round 1 → less material, same outer size', vol(r.result) < 9000 && vol(r.result) > 8900 && JSON.stringify(size(r.result)) === '[30,20,15]', vol(r.result) + ' ' + size(r.result));
  r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 15, corner: 0 }, chamfer: 1 })]);
  check('chamfer 1 → less material', vol(r.result) < 9000 && vol(r.result) > 8800, vol(r.result));
  r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 15, corner: 0 }, hollow: 2 })]);
  check('hollow 2 (open top) → 9000 − 26×16×13 = 3592', near(vol(r.result), 3592, 2), vol(r.result));
  r = await build([item({ name: 'c', type: 'cylinder', size: { d: 20, z: 20 } })]);
  check('cylinder Ø20×20 → volume ≈ 6283', near(vol(r.result), Math.PI * 100 * 20, 40), vol(r.result));
  check('cylinder size 20×20×20', size(r.result).every((v) => near(v, 20, 0.05)), size(r.result));
  r = await build([item({ name: 's', type: 'sphere', size: { d: 20 } })]);
  check('sphere Ø20 → volume ≈ 4189, bottom on floor', near(vol(r.result), 4 / 3 * Math.PI * 1000, 40) && near(F.meshBounds(r.result.vertices).lo[2], 0, 0.05), vol(r.result));
  r = await build([item({ name: 'b', type: 'box', size: { x: 5, y: 5, z: 5, corner: 0 }, round: 9 })]);
  check('rounding too large → friendly error, no crash', r.type === 'result' && /smaller value/.test(r.errors.b || ''), JSON.stringify(r.errors));
}

section('Position & rotation');
{
  let r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 }, rot: [0, 0, 90], pos: [5, 6, 7] })]);
  const b = F.meshBounds(r.result.vertices);
  check('rotate Z 90 → 20×30×10', JSON.stringify(size(r.result)) === '[20,30,10]', size(r.result));
  check('position 5,6,7 → centre X5 Y6, bottom Z7', near((b.lo[0] + b.hi[0]) / 2, 5, 1e-4) && near((b.lo[1] + b.hi[1]) / 2, 6, 1e-4) && near(b.lo[2], 7, 1e-4));
  r = await build([item({ name: 'b', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 }, rot: [90, 0, 0] })]);
  check('rotate X 90 → 30×10×20', JSON.stringify(size(r.result)) === '[30,10,20]', size(r.result));
  r = await build([item({ name: 'h', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 }, hidden: true }), item({ name: 'k', type: 'box', size: { x: 5, y: 5, z: 5, corner: 0 } })]);
  check('hidden shapes are left out', near(vol(r.result), 125, 0.1), vol(r.result));
}

section('Holes & clearance');
{
  const body = item({ name: 'body', type: 'box', size: { x: 30, y: 30, z: 30, corner: 0 } });
  let r = await build([body, item({ name: 'h', type: 'box', role: 'hole', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 10] })]);
  check('box hole 10³ inside 30³ → 26000', near(vol(r.result), 26000, 0.5), vol(r.result));
  check('result with hole is closed', F.isClosed(r.result.triangles));
  r = await build([body, item({ name: 'h', type: 'box', role: 'hole', clearance: 0.5, size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 10] })]);
  check('clearance 0.5 → hole 11³ → 25669', near(vol(r.result), 27000 - 1331, 0.5), vol(r.result));
  r = await build([body, item({ name: 'c', type: 'cylinder', role: 'hole', size: { d: 10, z: 40 }, pos: [0, 0, -5] })]);
  check('through-hole cylinder Ø10 → 27000 − π·25·30', near(vol(r.result), 27000 - Math.PI * 25 * 30, 30), vol(r.result));
  r = await build([body, model('cube', 'cube', { role: 'hole', clearance: 0.5, pos: [0, 0, 10] })]);
  check('imported STL as hole with 0.5 clearance → 25669', near(vol(r.result), 27000 - 1331, 1), vol(r.result));
  r = await build([item({ name: 'h', type: 'box', role: 'hole', size: { x: 10, y: 10, z: 10, corner: 0 } })]);
  check('only a hole → nothing to print (no result)', r.result === null);
  r = await build([body, item({ name: 'r', type: 'box', role: 'ref', size: { x: 50, y: 50, z: 50, corner: 0 } })]);
  check('reference shapes are not printed', near(vol(r.result), 27000, 0.5), vol(r.result));
}

section('Sketches');
{
  let r = await build([item({ name: 'sk', type: 'sketch', height: 1, profiles: [{ k: 'rect', x: 0, y: 0, w: 40, h: 20 }, { k: 'circle', x: 20, y: 0, r: 8 }] })]);
  check('rect 40×20 + circle r8 on its edge, height 1 → area 900.5', near(vol(r.result), 800 + Math.PI * 64 / 2, 3), vol(r.result));
  check('sketch thickness 1', near(size(r.result)[2], 1, 1e-6), size(r.result));
  r = await build([item({ name: 'tri', type: 'sketch', height: 2, profiles: [{ k: 'poly', pts: [[0, 0], [20, 0], [0, 10]] }] })]);
  check('triangle 20×10, height 2 → 200', near(vol(r.result), 200, 0.01), vol(r.result));
  r = await build([item({ name: 'quad', type: 'sketch', height: 2, profiles: [{ k: 'poly', pts: [[-5, -5], [5, -5], [5, 5]] }, { k: 'poly', pts: [[-5, -5], [5, 5], [-5, 5]] }] })]);
  check('two coplanar triangles fuse into a 10×10×2 slab', near(vol(r.result), 200, 1) && !(r.errors && r.errors.quad), JSON.stringify(r.errors) + ' vol ' + vol(r.result));
  r = await build([item({ name: 'e', type: 'sketch', height: 1, profiles: [] })]);
  check('empty sketch → clear error', /empty/.test(r.errors.e || ''), JSON.stringify(r.errors));
  r = await build([item({ name: 'sk', type: 'sketch', height: 5, hollow: 1, profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 20 }] })]);
  check('sketch hollow 1 → 2000 − 18×18×4 = 704', near(vol(r.result), 704, 1), vol(r.result));
}

section('Sketch: slots, polygons, arcs, cut-outs');
{
  const sk = (profiles, h = 1) => build([item({ name: 'sk', type: 'sketch', height: h, profiles })]);
  let r = await sk([{ k: 'slot', x: 0, y: 0, w: 30, h: 6, a: 0 }]);
  check('slot 30×6 → area 24·6 + π·3² = 172.27', near(vol(r.result), 24 * 6 + Math.PI * 9, 0.6), vol(r.result));
  check('slot size 30×6', near(size(r.result)[0], 30, 0.02) && near(size(r.result)[1], 6, 0.02), size(r.result));
  r = await sk([{ k: 'slot', x: 0, y: 0, w: 30, h: 6, a: 90 }]);
  check('slot rotated 90° → 6×30', near(size(r.result)[0], 6, 0.02) && near(size(r.result)[1], 30, 0.02), size(r.result));
  r = await sk([{ k: 'ngon', x: 0, y: 0, r: 10, n: 6, a: 0 }]);
  check('hexagon r10 → area 3√3/2·100 = 259.81', near(vol(r.result), 1.5 * Math.sqrt(3) * 100, 0.05), vol(r.result));
  r = await sk([{ k: 'ngon', x: 0, y: 0, r: 10, n: 4, a: 0 }]);
  check('square ngon r10 → area 200', near(vol(r.result), 200, 0.05), vol(r.result));
  r = await sk([{ k: 'rect', x: 0, y: 0, w: 40, h: 40 }, { k: 'circle', x: 0, y: 0, r: 5, cut: true }]);
  check('plate 40×40 with a Ø10 cut-out hole → 1600 − 78.54', near(vol(r.result), 1600 - Math.PI * 25, 0.8), vol(r.result));
  check('cut-out goes right through (mesh closed)', F.isClosed(r.result.triangles));
  r = await sk([{ k: 'circle', x: 0, y: 0, r: 10 }, { k: 'circle', x: 0, y: 0, r: 6, cut: true }], 3);
  check('ring: Ø20 minus Ø12, height 3 → π·(100−36)·3 = 603.2', near(vol(r.result), Math.PI * 64 * 3, 4), vol(r.result));
  r = await sk([{ k: 'rect', x: 0, y: 0, w: 60, h: 20 }, { k: 'slot', x: -15, y: 0, w: 14, h: 4, a: 0, cut: true }, { k: 'ngon', x: 15, y: 0, r: 4, n: 6, a: 0, cut: true }]);
  check('plate with a slot cut-out and a hex cut-out', near(vol(r.result), 1200 - (10 * 4 + Math.PI * 4) - 1.5 * Math.sqrt(3) * 16, 0.6), vol(r.result));
  r = await sk([{ k: 'poly', pts: [[-10, 0], [10, 0], [-10, 0, 0, 10]] }]);
  check('poly + arc: semicircle r10 (line + 3-point arc) → 157.08', near(vol(r.result), Math.PI * 50, 1), vol(r.result));
  r = await sk([{ k: 'poly', pts: [[0, 0], [20, 0], [20, 10], [0, 10, 10, 15]] }]);
  check('poly with one arc edge (bulging top) → more than 200', vol(r.result) > 200 && vol(r.result) < 300, vol(r.result));
  r = await sk([{ k: 'rect', x: 0, y: 0, w: 10, h: 10 }], -3);
  check('height −3 extrudes into the face: Z −3 … 0, 300 mm³', near(vol(r.result), 300, 0.01) && near(F.meshBounds(r.result.vertices).lo[2], -3, 1e-6) && near(F.meshBounds(r.result.vertices).hi[2], 0, 1e-6), JSON.stringify(F.meshBounds(r.result.vertices)));
  r = await sk([{ k: 'circle', x: 0, y: 0, r: 5, cut: true }]);
  check('only cut-outs → clear error', /only has cut-outs/.test(r.errors.sk || ''), JSON.stringify(r.errors));
}

section('Mirror (flip)');
{
  const L = { k: 'poly', pts: [[0, 0], [20, 0], [20, 5], [5, 5], [5, 15], [0, 15]] }; // L-shape: not symmetric
  let r = await build([item({ name: 'L', type: 'sketch', height: 2, profiles: [L], pos: [10, 0, 0] })]);
  const v0 = vol(r.result), b0 = F.meshBounds(r.result.vertices);
  r = await build([item({ name: 'L', type: 'sketch', height: 2, profiles: [L], pos: [10, 0, 0], flip: [true, false, false] })]);
  const b1 = F.meshBounds(r.result.vertices);
  check('flip X keeps volume and makes a closed, outward mesh', near(vol(r.result), v0, 1e-6) && vol(r.result) > 0 && F.isClosed(r.result.triangles), vol(r.result) + ' vs ' + v0);
  check('flip X mirrors about the item origin (x → 2·10 − x)', near(b1.lo[0], 20 - b0.hi[0], 1e-6) && near(b1.hi[0], 20 - b0.lo[0], 1e-6), JSON.stringify([b0, b1]));
  r = await build([item({ name: 'L', type: 'sketch', height: 2, profiles: [L], flip: [false, false, true] })]);
  check('flip Z → shape below its origin, still closed', near(F.meshBounds(r.result.vertices).hi[2], 0, 1e-6) && F.isClosed(r.result.triangles));
  r = await build([model('cube', 'cube', { role: 'solid', flip: [true, true, false] })]);
  check('flipped imported model stays closed', near(vol(r.result), 1000, 0.01) && F.isClosed(r.result.triangles));
  await build([item({ name: 'B', type: 'box', size: { x: 20, y: 10, z: 5, corner: 2 }, flip: [true, false, false], pos: [5, 0, 0] })]);
  const f = await send({ type: 'export', format: 'step' });
  check('STEP export works with mirrored shapes', f.type === 'file' && /MANIFOLD_SOLID_BREP/.test(new TextDecoder().decode(f.buffer)), f.message);
}

section('Per-edge rounding / chamfer');
{
  const cube = (o) => item(Object.assign({ name: 'C', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 } }, o));
  let r = await build([cube()]);
  const edges = r.edges.C;
  check('a box reports its 12 edges with middle points', edges && edges.length === 12, edges && edges.length);
  const vEdge = edges.find((e) => near(e.p[0], 10, 1e-6) && near(e.p[1], 10, 1e-6)); // vertical edge at x=10,y=10, middle z=10
  check('vertical edge middle is at (10, 10, 10)', vEdge && near(vEdge.p[2], 10, 1e-6), JSON.stringify(vEdge && vEdge.p));
  r = await build([cube({ edges: [{ p: vEdge.p, r: 3, kind: 'round' }] })]);
  check('round one edge r3 → 8000 − 9·(1 − π/4)·20', near(vol(r.result), 8000 - 9 * (1 - Math.PI / 4) * 20, 0.6), vol(r.result));
  check('rounded mesh is closed', F.isClosed(r.result.triangles));
  check('edge list is from the shape before rounding (still 12)', r.edges.C.length === 12);
  r = await build([cube({ edges: [{ p: vEdge.p, r: 2, kind: 'chamfer' }] })]);
  check('chamfer one edge 2 → 8000 − ½·2·2·20 = 7960', near(vol(r.result), 7960, 0.05), vol(r.result));
  const top = edges.filter((e) => near(e.p[2], 20, 1e-6));
  r = await build([cube({ edges: top.map((e) => ({ p: e.p, r: 2, kind: 'round' })) })]);
  check('round the 4 top edges r2 → 8000 − 4·4·(1 − π/4)·20 + corner bits', vol(r.result) < 8000 - 4 * 4 * (1 - Math.PI / 4) * 20 + 10 && vol(r.result) > 7900 && F.isClosed(r.result.triangles), vol(r.result));
  const farTop = top.find((e) => near(e.p[0], -10, 1e-6)); // top edge on the far side: no shared corner with vEdge
  r = await build([cube({ edges: [{ p: vEdge.p, r: 3, kind: 'round' }, { p: farTop.p, r: 1, kind: 'chamfer' }] })]);
  check('round one edge and chamfer another (separate edges)', r.result && near(vol(r.result), 8000 - 9 * (1 - Math.PI / 4) * 20 - 10, 0.6) && F.isClosed(r.result.triangles), (r.result && vol(r.result)) + JSON.stringify(r.errors));
  const nearTop = top.find((e) => near(e.p[0], 10, 1e-6)); // shares the corner (10,10,20) with vEdge
  r = await build([cube({ edges: [{ p: vEdge.p, r: 3, kind: 'round' }, { p: nearTop.p, r: 1, kind: 'chamfer' }] })]);
  check('round + chamfer meeting at one corner → either works or explains (no crash)', r.type === 'result' && (r.result ? F.isClosed(r.result.triangles) : /smaller value|could not/i.test(r.errors.C || '')), JSON.stringify(r.errors));
  r = await build([cube({ round: 1, edges: [{ p: vEdge.p, r: 3, kind: 'round' }] })]);
  check('"Round all edges" takes over from per-edge settings', near(vol(r.result), (await build([cube({ round: 1 })])).result && vol((await build([cube({ round: 1 })])).result), 0.01));
  r = await build([cube({ edges: [{ p: [99, 99, 99], r: 3, kind: 'round' }] })]);
  check('an edge that no longer exists → note, no crash', near(vol(r.result), 8000, 0.01) && /no longer match/.test(r.notes.C || ''), JSON.stringify(r.notes));
  r = await build([item({ name: 'Cy', type: 'cylinder', size: { d: 20, z: 10 } })]);
  const rim = r.edges.Cy.find((e) => near(e.p[2], 10, 1e-6));
  r = await build([item({ name: 'Cy', type: 'cylinder', size: { d: 20, z: 10 }, edges: [{ p: rim.p, r: 2, kind: 'round' }] })]);
  check('round the top rim of a cylinder', vol(r.result) < Math.PI * 100 * 10 - 20 && F.isClosed(r.result.triangles), vol(r.result));
  r = await build([item({ name: 'Sk', type: 'sketch', height: 5, profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 10 }] })]);
  const ske = r.edges.Sk.find((e) => near(e.p[2], 5, 1e-6) && near(e.p[1], 5, 1e-6));
  r = await build([item({ name: 'Sk', type: 'sketch', height: 5, profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 10 }], edges: [{ p: ske.p, r: 1, kind: 'chamfer' }] })]);
  check('chamfer an edge of a sketch shape → 1000 − ½·1·1·20', near(vol(r.result), 990, 0.05), vol(r.result));
}

section('Cut with a plane');
{
  const bx = (o) => item(Object.assign({ name: 'B', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 } }, o));
  let r = await build([bx({ clip: [{ n: [0, 0, 1], d: 5 }] })]);
  check('keep top half (z ≥ 5) → 3000, Z 5…10, closed', near(vol(r.result), 3000, 0.01) && near(F.meshBounds(r.result.vertices).lo[2], 5, 1e-6) && F.isClosed(r.result.triangles), vol(r.result));
  check('display mesh is the cut piece too', near(F.meshBounds(r.items.B.vertices).lo[2], 5, 1e-6));
  r = await build([bx({ clip: [{ n: [0, 0, -1], d: -5 }] })]);
  check('keep bottom half (z ≤ 5) → 3000', near(vol(r.result), 3000, 0.01), vol(r.result));
  r = await build([bx({ clip: [{ n: [1, 0, 0], d: 0 }, { n: [0, 1, 0], d: 0 }] })]);
  check('two cuts → a quarter (1500)', near(vol(r.result), 1500, 0.01), vol(r.result));
  r = await build([bx({ clip: [{ n: [0, 0, 1], d: 5 }], pos: [0, 0, 20], rot: [0, 90, 0] })]);
  check('cut plane is in the object\'s own frame (moves / rotates with it)', near(vol(r.result), 3000, 0.01), vol(r.result));
  r = await build([bx({ clip: [{ n: [0, 0, 1], d: 50 }] })]);
  check('cutting everything away → clear error', /Nothing is left/.test(r.errors.B || ''), JSON.stringify(r.errors));
  r = await build([model('cube', 'cube', { role: 'solid', clip: [{ n: [1, 0, 0], d: 2 }] })]);
  check('imported STL can be cut (keep x ≥ 2 → 3×10×10)', near(vol(r.result), 300, 0.01), vol(r.result));
  r = await build([model('cube', 'cube', { role: 'ref', clip: [{ n: [1, 0, 0], d: 0 }] })]);
  check('a cut reference shows only its kept half', r.items.cube && near(F.meshBounds(r.items.cube.vertices).lo[0], 0, 1e-6));
  await build([bx({ clip: [{ n: [0, 0, 1], d: 5 }] })]);
  const f = await send({ type: 'export', format: 'step' });
  check('STEP of a cut part → explains to use STL / 3MF', f.type === 'error' && /Cut tool/.test(f.message), f.message);
}

section('Split with a shape (hole + plug, no gap)');
{
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];               // translation, column-major
  const RZ90 = (x, y, z) => [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, x, y, z, 1];           // rotate 90° about Z, then move
  const cyl = { type: 'cylinder', size: { d: 10, z: 30 } };
  const box = (o) => item(Object.assign({ name: 'B', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 } }, o));
  const hole = Math.PI * 25 * 10;
  let r = await build([box({ name: 'Out', cuts: [{ keep: 'outside', m: T(0, 0, -5), shape: cyl }] })]);
  const vOut = vol(r.result);
  check('outside piece: box minus the Ø10 cylinder (6000 − 785.4)', near(vOut, 6000 - hole, 2) && F.isClosed(r.result.triangles), vOut);
  r = await build([box({ name: 'In', cuts: [{ keep: 'inside', m: T(0, 0, -5), shape: cyl }] })]);
  const vIn = vol(r.result);
  check('inside piece: the round plug (785.4)', near(vIn, hole, 2) && F.isClosed(r.result.triangles), vIn);
  check('no gap, no overlap: outside + inside = the whole box (6000)', near(vOut + vIn, 6000, 0.01), vOut + vIn);
  r = await build([box({ name: 'Out', cuts: [{ keep: 'outside', m: T(0, 0, -5), shape: cyl }] }), box({ name: 'In', cuts: [{ keep: 'inside', m: T(0, 0, -5), shape: cyl }] })]);
  check('both pieces in place → together exactly the box', near(vol(r.result), 6000, 0.01), vol(r.result));
  r = await build([box({ name: 'In', pos: [60, 5, 3], rot: [0, 0, 30], cuts: [{ keep: 'inside', m: T(0, 0, -5), shape: cyl }] })]);
  check('plug moved and rotated keeps its exact shape', near(vol(r.result), vIn, 0.01) && near((F.meshBounds(r.result.vertices).lo[2]), 3, 1e-6), vol(r.result));
  r = await build([box({ name: 'Out', cuts: [{ keep: 'outside', m: RZ90(8, 0, -5), shape: { type: 'box', size: { x: 4, y: 12, z: 30, corner: 0 } } }] })]);
  check('rotated cutter (a 4×12 slot turned 90°, so 12×4 in X×Y)', near(vol(r.result), 6000 - 12 * 4 * 10, 0.01), vol(r.result));
  r = await build([box({ name: 'Out', cuts: [{ keep: 'outside', m: T(0, 0, -5), shape: { type: 'sketch', height: 30, profiles: [{ k: 'circle', x: 0, y: 0, r: 5 }] } }] })]);
  check('a sketch circle as the cutter = same as the cylinder', near(vol(r.result), vOut, 2), vol(r.result));
  r = await build([box({ name: 'Out', cuts: [{ keep: 'outside', m: T(0, 0, -1), shape: { type: 'model', file: { key: 'cube', ext: 'stl' }, scale: 1, units: 'mm', stretch: [1, 1, 1], fit: 'exact' } }] })]);
  check('an STL as the cutter (10³ cube, 9 mm inside the 10 mm box)', near(vol(r.result), 6000 - 10 * 10 * 9, 0.01), vol(r.result));
  r = await build([box({ name: 'Out', cuts: [{ keep: 'inside', m: T(100, 0, 0), shape: cyl }] })]);
  check('cutter no longer overlapping → clear message', /no longer overlaps/.test(r.errors.Out || ''), JSON.stringify(r.errors));
}

section('Split your FrameTap STL with a cylinder');
{
  const fp = path.resolve(here, '..', '..', '..', '..', 'STL', 'frametap_case_remote.stl');
  let have = false; try { const b = (await import('fs')).readFileSync(fp); files.ft = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); extOf.ft = 'stl'; have = true; } catch (e) { /* not on this machine */ }
  if (!have) console.log('  (skipped: ' + fp + ' not found)');
  else {
    const ft = (o) => model('ft', 'ft', Object.assign({ role: 'solid' }, o));
    let r = await build([ft()]); const vAll = vol(r.result);
    const cut = (keep) => ({ keep, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 30], shape: { type: 'cylinder', size: { d: 12, z: 60 } } });
    const [tOut, tIn] = [Date.now()];
    r = await build([ft({ id: 'o', cuts: [cut('outside')] })]); const vO = vol(r.result); const closedO = F.isClosed(r.result.triangles);
    r = await build([ft({ id: 'i', cuts: [cut('inside')] })]); const vI = vol(r.result); const closedI = F.isClosed(r.result.triangles); void tIn;
    check('FrameTap: outside piece is closed and smaller', closedO && vO < vAll - 100, vO + ' of ' + vAll);
    check('FrameTap: inside plug is closed and not empty', closedI && vI > 100, vI);
    check('FrameTap: outside + inside = original volume (no gap)', near(vO + vI, vAll, vAll * 1e-6 + 0.05), (vO + vI) + ' vs ' + vAll);
    r = await build([ft({ id: 'o', cuts: [cut('outside')] }), ft({ id: 'i', cuts: [cut('inside')] })]);
    check('FrameTap: both pieces in place rebuild the original exactly', near(vol(r.result), vAll, vAll * 1e-6 + 0.05), vol(r.result));
    check('FrameTap split builds fast (< 3 s)', Date.now() - tOut < 3000 * 4, (Date.now() - tOut) + ' ms for 4 builds');
  }
}

section('Imported models');
{
  let r = await build([model('cube', 'cube')]);
  check('STL as reference → shown, not printed', r.result === null && r.items.cube && JSON.stringify(size(r.items.cube)) === '[10,10,10]');
  check('file size reported (10×10×10)', JSON.stringify(r.info.cube && r.info.cube.base) === '[10,10,10]', JSON.stringify(r.info.cube));
  r = await build([model('cube', 'cube', { role: 'solid' })]);
  check('binary STL as solid → 1000 mm³, closed', near(vol(r.result), 1000, 0.01) && F.isClosed(r.result.triangles));
  r = await build([model('ascii', 'ascii', { role: 'solid' })]);
  check('ASCII STL → 1000 mm³', near(vol(r.result), 1000, 0.01), vol(r.result));
  r = await build([model('obj', 'obj', { role: 'solid' })]);
  check('OBJ → 1000 mm³', near(vol(r.result), 1000, 0.01), vol(r.result));
  r = await build([model('tmf', 'tmf', { role: 'solid' })]);
  check('3MF in cm with component ×2 → 20×10×10 mm', JSON.stringify(size(r.result)) === '[20,10,10]', size(r.result));
  r = await build([model('broken', 'broken', { role: 'solid' })]);
  check('broken (open) STL → falls back to outline, with a note', near(vol(r.result), 1000, 0.5) && /outline/.test(r.notes.broken || ''), vol(r.result) + ' ' + JSON.stringify(r.notes));
  r = await build([model('cube', 'cube', { role: 'solid', units: 'cm' })]);
  check('units cm → 100×100×100', JSON.stringify(size(r.result)) === '[100,100,100]', size(r.result));
  r = await build([model('cube', 'cube', { role: 'solid', units: 'in' })]);
  check('units inch → 254', near(size(r.result)[0], 254, 0.01), size(r.result));
  r = await build([model('cube', 'cube', { role: 'solid', scale: 2 })]);
  const b = F.meshBounds(r.result.vertices);
  check('scale 2 → 20³ and still sitting on the floor (bottom Z 0)', JSON.stringify(size(r.result)) === '[20,20,20]' && near(b.lo[2], 0, 1e-6), JSON.stringify(b));
  r = await build([model('cube', 'cube', { role: 'solid', stretch: [2, 1, 0.5] })]);
  check('stretch X2 Z0.5 → 20×10×5', JSON.stringify(size(r.result)) === '[20,10,5]', size(r.result));
  r = await build([model('cube', 'cube', { role: 'solid', fit: 'outline' })]);
  check('outline mode on a good STL → 1000', near(vol(r.result), 1000, 0.5), vol(r.result));
}

section('Overlap check');
{
  const A = item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 } });
  await build([A, item({ name: 'B', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 }, pos: [10, 0, 0] })]);
  let c = await send({ type: 'check' });
  check('overlapping boxes reported with shared volume 4000', c.overlaps.length === 1 && near(c.overlaps[0].volume, 4000, 0.5), JSON.stringify(c.overlaps));
  await build([A, item({ name: 'B', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 }, pos: [20, 0, 0] })]);
  c = await send({ type: 'check' });
  check('touching (not overlapping) boxes → no warning', c.overlaps.length === 0, JSON.stringify(c.overlaps));
  await build([A, item({ name: 'B', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 }, pos: [10, 0, 0] }), item({ name: 'R', type: 'box', role: 'ref', size: { x: 50, y: 50, z: 50, corner: 0 } }), item({ name: 'H', type: 'box', role: 'hole', size: { x: 5, y: 5, z: 50, corner: 0 } })]);
  c = await send({ type: 'check' });
  check('holes and references are never reported as overlaps', c.overlaps.length === 1 && c.overlaps[0].aName === 'A' && c.overlaps[0].bName === 'B', JSON.stringify(c.overlaps));
  await build([Object.assign({}, A, { group: 'g' }), item({ name: 'B', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 }, pos: [10, 0, 0], group: 'g' })], { g: { name: 'Stand' } });
  c = await send({ type: 'check' });
  check('combined objects: their own parts are not reported', c.overlaps.length === 0, JSON.stringify(c.overlaps));
}

section('Floating');
{
  let r = await build([item({ name: 'A', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 5] })]);
  check('box at Z 5 → floating 5 mm', r.floating.A === 5, JSON.stringify(r.floating));
  r = await build([item({ name: 'A', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 } }), item({ name: 'B', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 10] })]);
  check('box stacked on another (touching) → not floating', Object.keys(r.floating).length === 0, JSON.stringify(r.floating));
  r = await build([item({ name: 'A', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 } }), item({ name: 'B', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 12] })]);
  check('box 2 mm above another → floating', r.floating.B === 12 && r.floating.A === undefined, JSON.stringify(r.floating));
  r = await build([item({ name: 'R', type: 'box', role: 'ref', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 30] })]);
  check('references never count as floating', Object.keys(r.floating).length === 0);
}

section('Combined objects');
{
  const g = { g: { name: 'Stand' } };
  let r = await build([item({ name: 'A', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, group: 'g' }), item({ name: 'B', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [10, 0, 0], group: 'g' })], g);
  check('touching parts → 1 piece', r.groupPieces.g === 1, JSON.stringify(r.groupPieces));
  r = await build([item({ name: 'A', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, group: 'g' }), item({ name: 'B', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [30, 0, 0], group: 'g' })], g);
  check('separated parts → 2 pieces (warning)', r.groupPieces.g === 2, JSON.stringify(r.groupPieces));
}

section('Export: STL');
{
  const r = await build([item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 } }), item({ name: 'B', type: 'cylinder', size: { d: 10, z: 30 }, pos: [40, 0, 0] }), item({ name: 'H', type: 'box', role: 'hole', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [0, 0, 15] })]);
  const f = await send({ type: 'export', format: 'stl' });
  const s = F.parseSTL(f.buffer);
  check('STL is binary with the right byte length', f.buffer.byteLength === 84 + s.count * 50);
  check('STL is closed and outward (watertight)', F.isClosed(s.triangles));
  check('STL volume equals the design', near(F.meshVolume(s.vertices, s.triangles), vol(r.result), 0.5), F.meshVolume(s.vertices, s.triangles) + ' vs ' + vol(r.result));
  const dv = new DataView(f.buffer); let inward = 0;
  for (let i = 0; i < s.count; i++) { const o = 84 + i * 50; const n = [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true)); const p = [...Array(9)].map((_, k) => dv.getFloat32(o + 12 + k * 4, true)); const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], w = [p[6] - p[0], p[7] - p[1], p[8] - p[2]]; const g2 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; if (n[0] * g2[0] + n[1] * g2[1] + n[2] * g2[2] < 0) inward++; }
  check('STL stored normals all point outward', inward === 0, inward + ' inward');
}

section('Export: 3MF');
{
  const g = { g: { name: 'Stand <&>' } };
  await build([
    item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 }, group: 'g' }),
    item({ name: 'B', type: 'box', size: { x: 10, y: 10, z: 10, corner: 0 }, pos: [30, 0, 0], group: 'g' }),
    item({ name: 'Lid', type: 'box', size: { x: 20, y: 20, z: 4, corner: 0 }, pos: [80, 0, 0] }),
    item({ name: 'Peg', type: 'box', size: { x: 4, y: 4, z: 10, corner: 0 }, pos: [80, 0, 2] }),
    item({ name: 'Solo', type: 'cylinder', size: { d: 10, z: 10 }, pos: [-60, 0, 0] }),
    item({ name: 'H', type: 'box', role: 'hole', size: { x: 4, y: 4, z: 40, corner: 0 }, pos: [0, 0, -5] }),
  ], g);
  const f = await send({ type: 'export', format: '3mf', name: 'test' });
  let z; try { z = unzipSync(new Uint8Array(f.buffer)); } catch (e) { z = null; }
  check('3MF is a valid zip with the 3 required parts', z && z['3D/3dmodel.model'] && z['[Content_Types].xml'] && z['_rels/.rels']);
  const x = new TextDecoder().decode(z['3D/3dmodel.model']);
  check('3MF unit is millimetre', /unit="millimeter"/.test(x));
  const objs = [...x.matchAll(/<object id="(\d+)" type="model" name="([^"]*)"><mesh><vertices>(.*?)<\/vertices><triangles>(.*?)<\/triangles>/g)].map((m) => {
    const v = [...m[3].matchAll(/x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((a) => [+a[1], +a[2], +a[3]]);
    const t = [...m[4].matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((a) => [+a[1], +a[2], +a[3]]);
    return { name: m[2], vol: F.meshVolume(v, t), closed: F.isClosed(t) };
  });
  const names = objs.map((o) => o.name).sort();
  check('3MF objects: combined "Stand", overlapping "Lid + Peg", "Solo"', JSON.stringify(names) === JSON.stringify(['Lid + Peg', 'Solo', 'Stand &lt;&amp;&gt;'].sort()), JSON.stringify(names));
  check('3MF names are XML-escaped', /name="Stand &lt;&amp;&gt;"/.test(x));
  check('every 3MF object is closed', objs.every((o) => o.closed));
  const stand = objs.find((o) => o.name.startsWith('Stand'));
  check('combined object has the hole cut (8000 + 1000 − 4·4·20)', stand && near(stand.vol, 8000 + 1000 - 320, 0.5), stand && stand.vol);
  check('3MF build lists every object once', (x.match(/<item objectid=/g) || []).length === objs.length);
}

section('Export: STEP');
{
  await build([item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 2 }, round: 1 }), item({ name: 'H', type: 'cylinder', role: 'hole', size: { d: 8, z: 30 }, pos: [0, 0, -5] })]);
  let f = await send({ type: 'export', format: 'step' });
  const txt = f.buffer ? new TextDecoder().decode(f.buffer) : '';
  check('STEP from drawn shapes is a valid ISO-10303 file', /^ISO-10303-21;/.test(txt) && /END-ISO-10303-21;/.test(txt), f.message);
  check('STEP contains a solid (MANIFOLD_SOLID_BREP)', /MANIFOLD_SOLID_BREP/.test(txt));
  await build([item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 } }), model('cube', 'cube', { role: 'solid', pos: [30, 0, 0] })]);
  f = await send({ type: 'export', format: 'step' });
  check('STEP with an STL solid → refuses with an explanation', f.type === 'error' && /mesh/.test(f.message), f.message);
  await build([item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 20, corner: 0 } }), model('cube', 'cube', { role: 'ref', pos: [30, 0, 0] })]);
  f = await send({ type: 'export', format: 'step' });
  check('STEP with the STL only as reference → allowed', f.type === 'file', f.message);
}

section('Scripts');
{
  let r = await build([item({ name: 'S', type: 'code', code: 'function main() { return drawRoundedRectangle(30, 20, 4).sketchOnPlane().extrude(10); }' })]);
  check('script builds 30×20×10', JSON.stringify(size(r.result)) === '[30,20,10]', size(r.result) + ' ' + JSON.stringify(r.errors));
  r = await build([item({ name: 'S', type: 'code', code: 'function main() { return drawCircle(5).sketchOnPlane(); }' })]);
  check('script returning a 2D sketch → helpful error', /extrude/.test(r.errors.S || ''), JSON.stringify(r.errors));
  r = await build([item({ name: 'S', type: 'code', code: 'function main() { return makeBaseBox(10, 10, 10' })]);
  check('script with a syntax error → error, no crash', r.type === 'result' && !!r.errors.S, JSON.stringify(r.errors));
  r = await build([item({ name: 'S', type: 'code', code: 'const x = 1;' })]);
  check('script without main() → tells you to define it', /main/.test(r.errors.S || ''), JSON.stringify(r.errors));
}

section('A later + extrude fills a − extrude');
{
  const box = item({ name: 'Body', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 } });
  const push = item({ name: 'Push', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [0, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 30, h: 20 }] });
  const pull = item({ name: 'Pull', type: 'sketch', role: 'solid', feature: true, height: 2.02, pos: [0, 0, 7.98], profiles: [{ k: 'rect', x: 0, y: 0, w: 30, h: 20 }] });
  let r = await build([box, push]);
  check('− extrude cuts a 2 mm pocket off the top', near(vol(r.result), 6000 - 1200, 2), vol(r.result));
  check('− extrude stays a few clean faces', r.result.triangles.length < 80, r.result.triangles.length);
  const cutBody = F.meshBounds(r.items.Body.vertices);
  check('the body’s mesh is the 8 mm that is left, not the uncut box', near(vol(r.items.Body), 4800, 30) && near(cutBody.hi[2], 8, 0.4) && near(cutBody.lo[2], 0, 0.2), vol(r.items.Body) + ' z ' + cutBody.lo[2] + '…' + cutBody.hi[2]);
  r = await build([box, push, pull]);
  check('+ extrude afterwards fills that pocket back', near(vol(r.result), 6000, 2), vol(r.result));
  const bore = item({ name: 'Bore', type: 'cylinder', role: 'hole', size: { d: 6, z: 30 }, pos: [0, 0, -5] });
  r = await build([box, push, pull, bore]);
  check('a real hole still cuts the filled part', near(vol(r.result), 6000 - Math.PI * 9 * 10, 8), vol(r.result));
}

section('A later − extrude cuts a fill');
{
  const box = item({ name: 'Body', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 } });
  const push = item({ name: 'Push', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [0, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 30, h: 20 }] });
  const fill = item({ name: 'Fill', type: 'sketch', role: 'solid', feature: true, fill: true, height: 2.02, pos: [0, 0, 7.98], profiles: [{ k: 'rect', x: 0, y: 0, w: 30, h: 20 }] });
  const again = item({ name: 'Push 2', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [0, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 10, h: 10 }] });
  let r = await build([box, push, fill]);
  check('a fill after a − extrude puts that material back', near(vol(r.result), 6000, 2), vol(r.result));
  r = await build([box, push, fill, again]);
  check('a later − extrude cuts the fill', near(vol(r.result), 6000 - 200, 8), vol(r.result));
}

section('A moved, rotated cut is meshed back in its own frame');
{
  const moved = item({ name: 'Moved', type: 'box', size: { x: 30, y: 20, z: 10, corner: 0 }, pos: [40, 0, 0], rot: [0, 0, 90] });
  const cut = item({ name: 'PushM', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [40, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 30 }] });
  const r = await build([moved, cut]);
  const b = F.meshBounds(r.items.Moved.vertices);
  check('rotated cut body stays in its own frame', near(b.lo[0], -15, 0.8) && near(b.hi[0], 15, 0.8) && near(b.lo[1], -10, 0.8) && near(b.hi[1], 10, 0.8) && near(b.hi[2], 8, 0.5), JSON.stringify({ lo: b.lo, hi: b.hi }));
  check('rotated cut body volume is the pocket that is left', near(vol(r.items.Moved), 4800, 40), vol(r.items.Moved));
}

section('A face cut does not change a separate object');
{
  const a = item({ name: 'A', type: 'box', size: { x: 20, y: 20, z: 10, corner: 0 }, pos: [0, 0, 0] });
  const b = item({ name: 'B', type: 'box', size: { x: 20, y: 20, z: 10, corner: 0 }, pos: [80, 0, 0] });
  const push = item({ name: 'Push', type: 'sketch', role: 'hole', feature: true, height: 2.02, pos: [0, 0, 8], profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 20 }] });
  const r = await build([a, b, push]);
  const bb = F.meshBounds(r.result.vertices);
  check('the other box keeps its full volume', near(vol(r.items.B), 4000, 1), vol(r.items.B));
  check('only the bitten box loses the pocket', near(vol(r.items.A), 3200, 30), vol(r.items.A));
  check('the printed pair is both boxes, pocket only on the first', near(vol(r.result), 7200, 8), vol(r.result));
  check('the other box stays where it was', near(bb.lo[0], -10, 0.5) && near(bb.hi[0], 90, 0.5), JSON.stringify(bb));
}

section('Speed');
{
  const big = []; for (let i = 0; i < 30; i++) big.push(item({ name: 'b' + i, type: 'box', size: { x: 8, y: 8, z: 8, corner: 1 }, round: 0.5, pos: [(i % 6) * 12, Math.floor(i / 6) * 12, 0] }));
  const t0 = Date.now(); await build(big); const t1 = Date.now() - t0;
  big[0].pos = [0, 0, 1]; const t2s = Date.now(); await build(big); const t2 = Date.now() - t2s;
  check('30 rounded boxes build in < 10 s', t1 < 10000, t1 + ' ms');
  check('moving one of them rebuilds in < 1 s (cached shapes)', t2 < 1000, t2 + ' ms');
}

origLog(`\n${pass} passed, ${fail} failed`);
if (fail) { origLog('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
