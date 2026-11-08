// CAD worker — two kernels, each doing what it is good at:
//   OpenCascade (replicad): exact shapes the user draws — boxes, cylinders,
//     spheres, rounded edges, hollowing, STEP import / export.
//   manifold-3d: fast, robust mesh booleans — joining and cutting everything,
//     including imported STL / 3MF / OBJ meshes of any size.
//
// A design is a list of items (public/cad/core.js). Each item is built in its
// own local frame — centred on X/Y, sitting on Z=0 — then rotated (X, then Y,
// then Z, degrees) and moved to its position. Solids are joined, then holes
// are cut; references are only shown.
//
// Messages in:
//   {type:'build', id, items, files:{[key]: ArrayBuffer}, quality}
//   {type:'export', id, format:'stl'|'step', name}
// Messages out:
//   {type:'ready'} | {type:'init-error', message}
//   {type:'need', id, keys}                        model files the build needs
//   {type:'result', id, result, items, errors, notes, stepOk, ms}
//       result: {vertices, triangles} of the final design (world frame) or null
//       items:  {[id]: {vertices, triangles}} in the item's local frame
//       errors / notes: {[id]: message}
//   {type:'file', id, format, buffer}
//   {type:'error', id, message}
import opencascade from 'replicad-opencascadejs';
import * as replicad from 'replicad';
import ManifoldModule from 'manifold-3d';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const OC_WASM = new URL('./replicad_single.wasm', import.meta.url).href;
const MF_WASM = new URL('./manifold.wasm', import.meta.url).href;
let MF = null;              // manifold-3d API
let lastDesign = null;      // Manifold of the latest build (STL export)
let lastItems = [];         // items of the latest build (STEP export)
let lastSolids = [];        // [{id, name, man}] placed solids of the latest build (overlap check, 3MF)
let lastHoles = null;       // union of placed holes, or null
let lastGroups = {};        // combined objects: {gid: {name}}
// manifold solids live in WebAssembly memory, which JavaScript's garbage collector
// never frees: every one we make must be .delete()d. `arena` owns the solids of the
// latest build (placed parts, holes, design); they are freed when the next build starts.
let arena = [];
const del = (m) => { try { if (m && typeof m.delete === 'function') m.delete(); } catch (e) { /* already freed */ } };
const own = (m) => { if (m) arena.push(m); return m; };
function freeArena() { const a = arena; arena = []; lastDesign = null; lastSolids = []; lastHoles = null; a.forEach(del); }
const fileMeshes = new Map(); // model file key -> {vertices, triangles} (normalised) | {shape} for STEP
const itemCache = new Map();  // geometry signature -> {mesh, manifold, shape?, note?}

const ready = (async () => {
  const [OC, mf] = await Promise.all([
    opencascade({ locateFile: () => OC_WASM }),
    ManifoldModule({ locateFile: () => MF_WASM }),
  ]);
  replicad.setOC(OC);
  mf.setup();
  MF = mf;
})();
ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'init-error', message: String((e && e.message) || e) }));

// ---------- reading model files (any STL / 3MF / OBJ, plus STEP) ----------
function stlToTriangles(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buffer.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      return out;
    }
  }
  const text = new TextDecoder().decode(buffer);
  const out = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) out.push(+m[1], +m[2], +m[3]);
  if (!out.length) throw new Error('No triangles found — is this a valid STL file?');
  return new Float32Array(out);
}
function objToTriangles(text) {
  const v = []; const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') v.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map((s) => { const i = parseInt(s, 10); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const j of [idx[0], idx[k], idx[k + 1]]) if (v[j]) out.push(...v[j]);
    }
  }
  if (!out.length) throw new Error('No faces found in the OBJ file');
  return new Float32Array(out);
}
// 3MF: a zip holding an XML model; objects may reference components with transforms.
function threeMFToTriangles(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(files);
  const name = names.find((f) => /^3D\/.*\.model$/i.test(f)) || names.find((f) => /\.model$/i.test(f));
  if (!name) throw new Error('No 3D model inside the 3MF file');
  const xml = new TextDecoder().decode(files[name]);
  const unit = (xml.match(/<model[^>]*\bunit="(\w+)"/) || [])[1] || 'millimeter';
  const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] || 1;
  const objects = new Map();
  for (const m of xml.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const body = m[2];
    objects.set(m[1], {
      verts: [...body.matchAll(/<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g)].map((a) => [+a[1], +a[2], +a[3]]),
      tris: [...body.matchAll(/<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g)].map((a) => [+a[1], +a[2], +a[3]]),
      comps: [...body.matchAll(/<component\b[^>]*?\bobjectid="(\d+)"(?:[^>]*?\btransform="([^"]+)")?/g)].map((a) => ({ id: a[1], tf: a[2] })),
    });
  }
  const parseTf = (s) => (s ? s.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const apply = (t, p) => [p[0] * t[0] + p[1] * t[3] + p[2] * t[6] + t[9], p[0] * t[1] + p[1] * t[4] + p[2] * t[7] + t[10], p[0] * t[2] + p[1] * t[5] + p[2] * t[8] + t[11]];
  const chain = (a, b) => { // apply a, then b
    const r = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r.concat(apply(b, [a[9], a[10], a[11]]));
  };
  const out = [];
  const emit = (id, tf, depth) => {
    const o = objects.get(id); if (!o || depth > 8) return;
    for (const tri of o.tris) for (const j of tri) if (o.verts[j]) out.push(...apply(tf, o.verts[j]).map((x) => x * scale));
    for (const c of o.comps) emit(c.id, chain(parseTf(c.tf), tf), depth + 1);
  };
  const items = [...xml.matchAll(/<item\b[^>]*?\bobjectid="(\d+)"(?:[^>]*?\btransform="([^"]+)")?/g)];
  if (items.length) items.forEach((it) => emit(it[1], parseTf(it[2]), 0));
  else objects.forEach((o, id) => emit(id, parseTf(), 0));
  if (!out.length) throw new Error('The 3MF file has no triangles');
  return new Float32Array(out);
}
// Triangle soup -> indexed mesh, welding vertices closer than ~0.1 µm.
function weld(tris) {
  const map = new Map(); const verts = []; const idx = new Uint32Array(tris.length / 3);
  for (let i = 0; i < idx.length; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let j = map.get(k);
    if (j === undefined) { j = verts.length / 3; verts.push(x, y, z); map.set(k, j); }
    idx[i] = j;
  }
  return { vertices: new Float32Array(verts), triangles: idx };
}
// Centre on X/Y and sit on Z=0, like every other item.
function normaliseMesh(m) {
  const v = m.vertices; const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  const d = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) v[i + k] += d[k];
  return m;
}
function normaliseShape(shape) {
  const [[x0, y0, z0], [x1, y1]] = shape.boundingBox.bounds;
  return shape.translate([-(x0 + x1) / 2, -(y0 + y1) / 2, -z0]);
}
async function readFile(ext, buffer) {
  const e = String(ext || '').toLowerCase();
  if (e === 'step' || e === 'stp') return { shape: normaliseShape(await replicad.importSTEP(new Blob([buffer]))) };
  let tris;
  if (e === 'stl') tris = stlToTriangles(buffer);
  else if (e === '3mf') tris = threeMFToTriangles(buffer);
  else if (e === 'obj') tris = objToTriangles(new TextDecoder().decode(buffer));
  else throw new Error('Unsupported file type .' + e + ' — use STL, 3MF, OBJ or STEP');
  return normaliseMesh(weld(tris));
}

// ---------- items ----------
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const RNAMES = Object.keys(replicad).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
const RVALUES = RNAMES.map((k) => replicad[k]);
async function runCode(code) {
  const body = '"use strict";\nreturn (async () => {\n' + code + '\n;if (typeof main !== "function") throw new Error("Define function main() that returns a shape.");\nreturn main();\n})();';
  const out = await new Function(...RNAMES, body)(...RVALUES); // eslint-disable-line no-new-func
  const s = Array.isArray(out) ? out[0] : (out && out.shape) || out;
  if (!s || typeof s.mesh !== 'function') throw new Error('main() must return a 3D shape. Did you forget .extrude()?');
  return s;
}

let Q = { tolerance: 0.05, angularTolerance: 0.2 };
function shapeToMesh(shape) {
  const f = shape.mesh(Q);
  return { vertices: new Float32Array(f.vertices), triangles: new Uint32Array(f.triangles) };
}
// Edges of a shape for picking: each with its middle point and a sampled polyline.
function edgeList(shape) {
  const out = [];
  for (const e of shape.edges) {
    try {
      const m = e.pointAt(0.5);
      const pts = []; const N = e.geomType === 'LINE' ? 1 : 24;
      for (let i = 0; i <= N; i++) { const q = e.pointAt(i / N); pts.push(q.x, q.y, q.z); }
      out.push({ p: [m.x, m.y, m.z].map((x) => Math.round(x * 1e4) / 1e4), pts });
    } catch (err) { /* skip odd edges */ }
  }
  return out;
}
const near3 = (a, b) => Math.abs(a[0] - b[0]) < 2e-3 && Math.abs(a[1] - b[1]) < 2e-3 && Math.abs(a[2] - b[2]) < 2e-3;
// Rounding / chamfer on chosen edges, matched by their middle point on `shape`.
function edgeOps(shape, ops) {
  let s = shape; let missed = 0;
  const mid = (e) => { try { const m = e.pointAt(0.5); return [m.x, m.y, m.z]; } catch (err) { return null; } };
  const run = (kind) => {
    const list = ops.filter((o) => o.kind === kind); if (!list.length) return;
    // Match first: a fillet / chamfer call with no edges selected can hang OpenCascade.
    const mids = s.edges.map(mid).filter(Boolean);
    const found = list.filter((o) => mids.some((m) => near3(o.p, m)));
    missed += list.length - found.length;
    if (!found.length) return;
    const fn = (e) => { const m = mid(e); if (!m) return null; const o = found.find((x) => near3(x.p, m)); return o ? o.r : null; };
    s = kind === 'chamfer' ? s.chamfer(fn) : s.fillet(fn);
  };
  run('round'); run('chamfer');
  return { shape: s, missed };
}
function finishShape(shape, it, info) {
  let s = shape;
  const h = s.boundingBox.bounds[1][2];
  if (num(it.hollow, 0) > 0) s = s.shell(num(it.hollow, 0), (f) => f.inPlane('XY', h));
  if (info) info.edges = edgeList(s);
  if (num(it.round, 0) > 0) s = s.fillet(num(it.round, 0));
  else if (num(it.chamfer, 0) > 0) s = s.chamfer(num(it.chamfer, 0));
  else if (Array.isArray(it.edges) && it.edges.length) { const r = edgeOps(s, it.edges); s = r.shape; if (info && r.missed) info.note = r.missed + ' rounded / chamfered edge' + (r.missed > 1 ? 's' : '') + ' no longer match the shape — pick them again.'; }
  return s;
}
// Exact OpenCascade shape for drawn items. Hole clearance is built in exactly:
// the shape grows by `clearance` on every side.
function drawnShape(it) {
  const d = it.size || {};
  const c = it.role === 'hole' ? Math.max(0, num(it.clearance, 0)) : 0;
  let s;
  if (it.type === 'box') {
    const w = Math.max(0.1, num(d.x, 20)) + 2 * c, l = Math.max(0.1, num(d.y, 20)) + 2 * c, h = Math.max(0.1, num(d.z, 20)) + 2 * c;
    const r = Math.min(num(d.corner, 0) + (num(d.corner, 0) > 0 ? c : 0), w / 2 - 0.01, l / 2 - 0.01);
    s = r > 0 ? replicad.drawRoundedRectangle(w, l, r).sketchOnPlane().extrude(h) : replicad.makeBaseBox(w, l, h);
  } else if (it.type === 'cylinder') {
    s = replicad.makeCylinder(Math.max(0.05, num(d.d, 20) / 2) + c, Math.max(0.1, num(d.z, 20)) + 2 * c);
  } else if (it.type === 'sphere') {
    const r = Math.max(0.05, num(d.d, 20) / 2) + c;
    s = replicad.makeSphere(r).translate([0, 0, r]);
  }
  s = finishShape(s, it, it._info);
  return c ? s.translate([0, 0, -c]) : s;
}
const UNIT_MM = { mm: 1, cm: 10, in: 25.4, m: 1000 };
// Models are normalised to sit centred on X/Y with their bottom at Z=0;
// scaling about that origin keeps them centred and on the floor.
function scaleFromBase(mesh, sx, sy, sz) {
  const v = mesh.vertices.slice();
  for (let i = 0; i < v.length; i += 3) { v[i] *= sx; v[i + 1] *= sy; v[i + 2] *= sz; }
  return { vertices: v, triangles: mesh.triangles };
}
function scaleAboutCentre(mesh, sx, sy, sz) {
  const v = mesh.vertices.slice();
  let zlo = Infinity, zhi = -Infinity;
  for (let i = 2; i < v.length; i += 3) { zlo = Math.min(zlo, v[i]); zhi = Math.max(zhi, v[i]); }
  const zc = (zlo + zhi) / 2;
  for (let i = 0; i < v.length; i += 3) { v[i] *= sx; v[i + 1] *= sy; v[i + 2] = zc + (v[i + 2] - zc) * sz; }
  return { vertices: v, triangles: mesh.triangles };
}
function meshExtent(mesh) {
  const v = mesh.vertices; const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}
function toManifold(mesh) {
  const m = new MF.Mesh({ numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles });
  m.merge();
  return new MF.Manifold(m);
}
function fromManifold(man) {
  const m = man.getMesh();
  const np = m.numProp;
  let v = m.vertProperties;
  if (np !== 3) { const o = new Float32Array((v.length / np) * 3); for (let i = 0, j = 0; i < v.length; i += np, j += 3) { o[j] = v[i]; o[j + 1] = v[i + 1]; o[j + 2] = v[i + 2]; } v = o; }
  return { vertices: new Float32Array(v), triangles: new Uint32Array(m.triVerts) };
}

// Builds one item in its local frame: {mesh (for display), manifold (for booleans), shape?, note?}
function profileDrawing(p) {
  const X = num(p.x, 0), Y = num(p.y, 0);
  if (p.k === 'circle') return replicad.drawCircle(Math.max(0.05, num(p.r, 5))).translate(X, Y);
  if (p.k === 'slot') {
    const h = Math.max(0.05, num(p.h, 6)); const w = Math.max(h + 0.01, num(p.w, 20));
    return replicad.drawRoundedRectangle(w, h, h / 2 - 1e-4).rotate(num(p.a, 0), [0, 0]).translate(X, Y);
  }
  if (p.k === 'ngon') return replicad.drawPolysides(Math.max(0.05, num(p.r, 10)), Math.max(3, Math.round(num(p.n, 6)))).rotate(num(p.a, 0), [0, 0]).translate(X, Y);
  if (p.k === 'poly') {
    const at = (q) => [num(q[0], 0), num(q[1], 0)];
    // drop repeated points (a zero-length edge breaks the shape kernel), incl. the closing one
    const P = [];
    for (const q of p.pts) { const prev = P[P.length - 1]; if (prev && Math.hypot(num(q[0], 0) - num(prev[0], 0), num(q[1], 0) - num(prev[1], 0)) < 1e-3 && !(q.length >= 4)) continue; P.push(q); }
    while (P.length > 3 && !(P[0].length >= 4) && Math.hypot(num(P[0][0], 0) - num(P[P.length - 1][0], 0), num(P[0][1], 0) - num(P[P.length - 1][1], 0)) < 1e-3) P.pop();
    // drop points on the line through their neighbours: straight-through points and
    // zero-width spikes that double back (they make the solid invalid)
    if (!P.some((q) => q.length >= 4)) {
      let changed = true;
      while (changed && P.length > 3) {
        changed = false;
        for (let i = 0; i < P.length && P.length > 3; i++) {
          const a0 = at(P[(i + P.length - 1) % P.length]), b0 = at(P[i]), c0 = at(P[(i + 1) % P.length]);
          const cr = (b0[0] - a0[0]) * (c0[1] - a0[1]) - (b0[1] - a0[1]) * (c0[0] - a0[0]);
          const chord = Math.hypot(c0[0] - a0[0], c0[1] - a0[1]);
          const legs = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) * Math.hypot(c0[0] - b0[0], c0[1] - b0[1]);
          const L = chord + Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
          const off = chord > 1e-6 ? Math.abs(cr) / chord : 0;
          const sinTurn = legs > 1e-6 ? Math.abs(cr) / legs : 0;
          // collinear points, and shallow wrinkles a boolean left on a straight edge.
          // a corner or a fillet sample turns, so it is kept
          if (Math.abs(cr) <= 1e-6 * Math.max(1, L * L) || Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) < 1e-3 || (off < 0.2 && sinTurn < 0.05)) { P.splice(i, 1); changed = true; i--; }
        }
      }
    }
    if (P.length < (P.some((q) => q.length >= 4) ? 2 : 3)) throw new Error('This outline has too few distinct points.');
    let pen = replicad.draw(at(P[0]));
    for (const q of P.slice(1)) pen = q.length >= 4 ? pen.threePointsArcTo(at(q), [num(q[2], 0), num(q[3], 0)]) : pen.lineTo(at(q));
    if (P[0].length >= 4) return pen.threePointsArcTo(at(P[0]), [num(P[0][2], 0), num(P[0][3], 0)]).close();
    return pen.close();
  }
  return replicad.drawRectangle(Math.max(0.05, num(p.w, 10)), Math.max(0.05, num(p.h, 10))).translate(X, Y);
}
// A sketch: its profiles joined into one drawing (cut-outs removed), extruded up from Z=0.
function sketchShape(it) {
  const profs = Array.isArray(it.profiles) ? it.profiles : [];
  if (!profs.length) throw new Error('This sketch is empty — tap Edit sketch and draw a shape.');
  const solid = profs.filter((p) => !p.cut), cuts = profs.filter((p) => p.cut);
  if (!solid.length) throw new Error('This sketch only has cut-outs — draw an outer shape too (turn Cut off).');
  let drawing = null;
  for (const p of solid) { const d = profileDrawing(p); drawing = drawing ? drawing.fuse(d) : d; }
  for (const p of cuts) drawing = drawing.cut(profileDrawing(p));
  const h = num(it.height, 0.05), depth = Math.max(0.001, Math.abs(h));
  const solidShape = drawing.sketchOnPlane('XY').extrude(depth);
  // negative height: extrude into the face the sketch sits on (below its plane)
  return finishShape(h < 0 ? solidShape.translate([0, 0, -depth]) : solidShape, it, it._info);
}

async function buildItem(it) {
  if (it.type === 'sketch' || it.type === 'box' || it.type === 'cylinder' || it.type === 'sphere') {
    const info = {}; const shape = (it.type === 'sketch' ? sketchShape : drawnShape)(Object.assign({}, it, { _info: info }));
    const mesh = shapeToMesh(shape);
    return { mesh, shape, manifold: it.role === 'ref' ? null : toManifold(mesh), edges: info.edges, note: info.note };
  }
  if (it.type === 'code') {
    let shape = normaliseShape(await runCode(String(it.code || '')));
    const edges = edgeList(shape); let note = '';
    if (Array.isArray(it.edges) && it.edges.length) { const r = edgeOps(shape, it.edges); shape = r.shape; if (r.missed) note = r.missed + ' rounded / chamfered edges no longer match — pick them again.'; }
    const mesh = shapeToMesh(shape);
    return { mesh, shape, manifold: it.role === 'ref' ? null : toManifold(mesh), edges, note };
  }
  if (it.type === 'model') {
    const f = fileMeshes.get(it.file && it.file.key);
    if (!f) throw new Error('Model file not loaded');
    let mesh = f.shape ? shapeToMesh(f.shape) : f;
    // Size in the file (before units / scale), then real size: units × scale × stretch.
    const base = meshExtent(mesh);
    const k = num(it.scale, 1) * (UNIT_MM[it.units] || 1);
    const st = Array.isArray(it.stretch) ? it.stretch.map((v) => num(v, 1)) : [1, 1, 1];
    if (k !== 1 || st.some((v) => v !== 1)) mesh = scaleFromBase(mesh, k * st[0], k * st[1], k * st[2]);
    if (it.role === 'ref') return { mesh, manifold: null, base };
    let note = '';
    let man = null;
    if (it.fit !== 'outline') {
      try { man = toManifold(mesh); } catch (e) { note = 'This model has gaps (not watertight), so its outline is used instead.'; }
    }
    if (!man) man = MF.Manifold.hull(Array.from({ length: mesh.vertices.length / 3 }, (_, i) => [mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]]));
    const c = it.role === 'hole' ? Math.max(0, num(it.clearance, 0)) : 0;
    if (c) {
      const [ex, ey, ez] = meshExtent(mesh);
      const bb = man.boundingBox(); const zc = (bb.min[2] + bb.max[2]) / 2;
      const a1 = man.translate([0, 0, -zc]); del(man);
      const a2 = a1.scale([(ex + 2 * c) / Math.max(ex, 1e-6), (ey + 2 * c) / Math.max(ey, 1e-6), (ez + 2 * c) / Math.max(ez, 1e-6)]); del(a1);
      man = a2.translate([0, 0, zc]); del(a2);
    }
    const scaled = k !== 1 || st.some((v) => v !== 1);
    return { mesh, manifold: man, shape: f.shape && !c && !scaled && it.fit !== 'outline' ? f.shape : null, note, meshOnly: !f.shape, base };
  }
  throw new Error('Unknown item type ' + it.type);
}
// Cut planes: keep the part of the shape on the side n·x ≥ d (shape's own frame).
function applyClip(c, it) {
  if (!Array.isArray(it.clip) || !it.clip.length) return c;
  let man = c.manifold || toManifold(c.mesh); const own0 = !c.manifold;
  for (const cl of it.clip) { const t = man.trimByPlane(cl.n, cl.d); if (man !== c.manifold || own0) del(man); man = t; }
  if (c.manifold && c.manifold !== man) del(c.manifold);
  const mesh = fromManifold(man);
  if (!mesh.triangles.length) { del(man); throw new Error('Nothing is left of this shape after the cut — move the cut plane.'); }
  return Object.assign({}, c, { mesh, manifold: it.role === 'ref' ? (del(man), null) : man, shape: null, cut: true });
}
// Split with a shape: keep the inside (∩) or outside (−) of a cutter shape.
const cutterCache = new Map(); // signature -> manifold (cutter frame)
async function cutterManifold(shapeDef) {
  const def = Object.assign({ id: '_cutter', name: 'cutter', role: 'solid', pos: [0, 0, 0], rot: [0, 0, 0], clearance: 0 }, shapeDef);
  const key = sig(def);
  if (cutterCache.has(key)) return cutterCache.get(key);
  const c = applyClip(await buildItem(def), def);
  const man = c.manifold || toManifold(c.mesh);
  cutterCache.set(key, man);
  return man;
}
async function applyCuts(c, it) {
  if (!Array.isArray(it.cuts) || !it.cuts.length) return c;
  let man = c.manifold || toManifold(c.mesh); const orig = c.manifold;
  for (const cut of it.cuts) {
    const cm = await cutterManifold(cut.shape);
    const t = cm.transform(cut.m);
    const r = cut.keep === 'inside' ? man.intersect(t) : man.subtract(t);
    del(t); if (man !== orig) del(man); man = r;
  }
  const mesh = fromManifold(man);
  if (!mesh.triangles.length) { del(man); throw new Error('Nothing is left of this piece — the cutting shape no longer overlaps it.'); }
  return Object.assign({}, c, { mesh, manifold: it.role === 'ref' ? (del(man), null) : man, shape: null, cut: true });
}
// Scale factor per own axis, applied to the finished piece (cuts and holes included).
function applyScale(c, it) {
  if (!Array.isArray(it.sxyz) || it.sxyz.every((v) => Math.abs(v - 1) < 1e-9)) return c;
  const base = c.manifold || toManifold(c.mesh);
  const man = base.scale(it.sxyz.map((v) => num(v, 1)));
  if (!c.manifold) del(base); else if (base !== man) del(base);
  return Object.assign({}, c, { mesh: fromManifold(man), manifold: it.role === 'ref' ? (del(man), null) : man, shape: null, edges: undefined, cut: c.cut || true });
}
// Separate pieces: a cut can leave a shape in several disconnected chunks. Count
// them (shown in the panel), or keep only piece k (ordered by position).
function applyPieces(c, it) {
  const cutLike = (Array.isArray(it.cuts) && it.cuts.length) || (Array.isArray(it.clip) && it.clip.length);
  if (!cutLike && !it.piece) return c;
  const man = c.manifold || toManifold(c.mesh);
  const raw = man.decompose();
  // decompose() also returns each inner cavity (a closed void, negative volume) on
  // its own: it belongs to the solid chunk around it, it is not a separate piece.
  const solidsP = [], voids = [];
  raw.forEach((m) => (m.volume() >= 0 ? solidsP : voids).push(m));
  const inside = (a, b) => { const A = a.boundingBox(), B = b.boundingBox(); return [0, 1, 2].every((k) => A.min[k] >= B.min[k] - 1e-6 && A.max[k] <= B.max[k] + 1e-6); };
  const groups = solidsP.map((m) => [m]);
  for (const v of voids) { const i = solidsP.findIndex((sp) => inside(v, sp)); if (i >= 0) groups[i].push(v); else groups.push([v]); }
  if (!it.piece) { const n = solidsP.length; raw.forEach(del); if (!c.manifold) del(man); return Object.assign({}, c, { pieces: n }); }
  const key = (m) => { const b = m.boundingBox(); return [(b.min[2] + b.max[2]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[0] + b.max[0]) / 2].map((v) => Math.round(v * 1000)); };
  const order = groups.filter((g) => g[0].volume() >= 0).sort((a, b) => { const ka = key(a[0]), kb = key(b[0]); return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]; });
  const g = order[Math.min(it.piece.k, order.length - 1)];
  const pick = g.length === 1 ? g[0] : MF.Manifold.compose(g);
  raw.forEach((m) => { if (m !== pick) del(m); }); del(man);
  return Object.assign({}, c, { mesh: fromManifold(pick), manifold: it.role === 'ref' ? (del(pick), null) : pick, shape: null, pieces: 1 });
}
function sig(it) {
  return JSON.stringify([it.type, it.profiles, it.height, it.role === 'ref' ? 'ref' : 'solid', it.role === 'hole' ? num(it.clearance, 0) : 0, it.size, it.round, it.chamfer, it.hollow, it.scale, it.units, it.stretch, it.fit, it.code, it.edges, it.clip, it.cuts, it.sxyz, it.piece, it.file && it.file.key, Q.tolerance]);
}
function placeManifold(man, it) {
  const r = it.rot || [0, 0, 0]; const p = it.pos || [0, 0, 0];
  let m = man;
  const step = (next) => { if (m !== man) del(m); m = next; };
  const fl = Array.isArray(it.flip) ? it.flip : [];
  if (fl[0]) step(m.mirror([1, 0, 0]));
  if (fl[1]) step(m.mirror([0, 1, 0]));
  if (fl[2]) step(m.mirror([0, 0, 1]));
  if (num(r[0], 0) || num(r[1], 0) || num(r[2], 0)) step(m.rotate([num(r[0], 0), num(r[1], 0), num(r[2], 0)]));
  step(m.translate([num(p[0], 0), num(p[1], 0), num(p[2], 0)]));
  return m;
}
// Inverse of the viewer's placement (flip, then ZYX rotation, then translate),
// so a world-space mesh lands back in the item's own frame.
function unplaceMesh(mesh, it) {
  const r = (it.rot || [0, 0, 0]).map((x) => num(x, 0) * Math.PI / 180);
  const p = it.pos || [0, 0, 0];
  const fl = Array.isArray(it.flip) ? it.flip : [];
  const cx = Math.cos(r[0]), sx = Math.sin(r[0]);
  const cy = Math.cos(r[1]), sy = Math.sin(r[1]);
  const cz = Math.cos(r[2]), sz = Math.sin(r[2]);
  const px = num(p[0], 0), py = num(p[1], 0), pz = num(p[2], 0);
  const v = mesh.vertices;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    let x = v[i] - px, y = v[i + 1] - py, z = v[i + 2] - pz;
    const x1 = cz * x + sz * y, y1 = -sz * x + cz * y, z1 = z;
    const x2 = cy * x1 + sy * z1, y2 = y1, z2 = -sy * x1 + cy * z1;
    let x3 = x2, y3 = cx * y2 + sx * z2, z3 = -sx * y2 + cx * z2;
    if (fl[0]) x3 = -x3;
    if (fl[1]) y3 = -y3;
    if (fl[2]) z3 = -z3;
    o[i] = x3; o[i + 1] = y3; o[i + 2] = z3;
  }
  return { vertices: o, triangles: mesh.triangles };
}
function boxesOverlap(a, b, pad) {
  const p = pad || 0;
  return !(a.max[0] + p < b.min[0] || b.max[0] + p < a.min[0] || a.max[1] + p < b.min[1] || b.max[1] + p < a.min[1] || a.max[2] + p < b.min[2] || b.max[2] + p < a.min[2]);
}
// A body that a hole has cut is meshed from that one remaining solid, in the
// body's own frame. An uncut body keeps the mesh it was drawn with.
function refreshVisible(design, solidInfo, items, holes, itemMeshes, keep, transfer) {
  if (!design || !solidInfo.length || !holes.length) return;
  const byId = new Map(items.map((it) => [it.id, it]));
  const holeBoxes = holes.map((h) => { try { return h.boundingBox(); } catch (e) { return null; } }).filter(Boolean);
  if (!holeBoxes.length) return;
  for (const si of solidInfo) {
    const it = byId.get(si.id);
    if (!it || !si.man) continue;
    let box = null;
    try { box = si.man.boundingBox(); } catch (e) { continue; }
    if (!holeBoxes.some((b) => boxesOverlap(box, b, 0.05))) continue;
    let vis = null;
    try {
      vis = design.intersect(si.man);
      if (!vis || vis === si.man || vis === design) { vis = null; continue; }
      const vol = Math.abs(si.man.volume());
      const left = vis.isEmpty() ? 0 : vis.volume();
      if (left > vol - Math.max(0.5, vol * 0.002)) continue;
      const mesh = left < 0.05 ? { vertices: new Float32Array(0), triangles: new Uint32Array(0) } : unplaceMesh(fromManifold(vis), it);
      itemMeshes[si.id] = mesh;
      if (mesh.vertices.byteLength) transfer.push(mesh.vertices.buffer);
      if (mesh.triangles.byteLength) transfer.push(mesh.triangles.buffer);
      const i = keep.indexOf(si.id);
      if (i >= 0) keep.splice(i, 1);
      sentSig.set(si.id, sig(it) + '|vis');
    } catch (e) { /* the mesh from before the cut still draws */ }
    finally { if (vis && vis !== si.man && vis !== design) del(vis); }
  }
}
function placeShape(shape, it) {
  let s = shape.clone();
  const fl = Array.isArray(it.flip) ? it.flip : [];
  if (fl[0]) s = s.mirror('YZ', [0, 0, 0]);
  if (fl[1]) s = s.mirror('XZ', [0, 0, 0]);
  if (fl[2]) s = s.mirror('XY', [0, 0, 0]);
  const r = it.rot || [0, 0, 0]; const p = it.pos || [0, 0, 0];
  if (num(r[0], 0)) s = s.rotate(num(r[0], 0), [0, 0, 0], [1, 0, 0]);
  if (num(r[1], 0)) s = s.rotate(num(r[1], 0), [0, 0, 0], [0, 1, 0]);
  if (num(r[2], 0)) s = s.rotate(num(r[2], 0), [0, 0, 0], [0, 0, 1]);
  return s.translate([num(p[0], 0), num(p[1], 0), num(p[2], 0)]);
}
// Local mesh → world, the same flips / X-then-Y-then-Z / move as placeManifold.
function placeMesh(mesh, it) {
  const r = (it.rot || [0, 0, 0]).map((x) => num(x, 0) * Math.PI / 180);
  const p = it.pos || [0, 0, 0];
  const fl = Array.isArray(it.flip) ? it.flip : [];
  const cx = Math.cos(r[0]), sx = Math.sin(r[0]);
  const cy = Math.cos(r[1]), sy = Math.sin(r[1]);
  const cz = Math.cos(r[2]), sz = Math.sin(r[2]);
  const v = mesh.vertices;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    let x = v[i], y = v[i + 1], z = v[i + 2];
    if (fl[0]) x = -x; if (fl[1]) y = -y; if (fl[2]) z = -z;
    const y1 = cx * y - sx * z, z1 = sx * y + cx * z, x1 = x;
    const x2 = cy * x1 + sy * z1, z2 = -sy * x1 + cy * z1, y2 = y1;
    const x3 = cz * x2 - sz * y2, y3 = sz * x2 + cz * y2, z3 = z2;
    o[i] = x3 + num(p[0], 0); o[i + 1] = y3 + num(p[1], 0); o[i + 2] = z3 + num(p[2], 0);
  }
  return { vertices: o, triangles: new Uint32Array(mesh.triangles) };
}
function concatMeshes(parts) {
  let nv = 0, nt = 0;
  for (const p of parts) { nv += p.vertices.length; nt += p.triangles.length; }
  const vertices = new Float32Array(nv);
  const triangles = new Uint32Array(nt);
  let vo = 0, to = 0, base = 0;
  for (const p of parts) {
    vertices.set(p.vertices, vo);
    const t = p.triangles;
    for (let i = 0; i < t.length; i++) triangles[to + i] = t[i] + base;
    base += p.vertices.length / 3;
    vo += p.vertices.length;
    to += t.length;
  }
  return { vertices, triangles };
}
// True when the two boxes share a slab thicker than a flush-face lip (0.02 mm).
function bitesBox(a, b) {
  const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  return dx > 0.03 && dy > 0.03 && dz > 0.03;
}
// OpenCascade cut of one exact solid by the face pushes that land on it.
function cutSolidExact(it, cutters) {
  const c = itemCache.get(sig(it));
  if (!c || !c.shape) return null;
  const made = [];
  const wipe = () => { for (const s of made) { try { s.delete(); } catch (e) { /* freed */ } } };
  try {
    let shape = placeShape(c.shape, it);
    made.push(shape);
    for (const cutter of cutters) {
      const cc = itemCache.get(sig(cutter));
      if (!cc || !cc.shape) { wipe(); return null; }
      const placed = placeShape(cc.shape, cutter);
      made.push(placed);
      const n = shape.cut(placed);
      made.push(n);
      shape = n;
    }
    const mesh = shapeToMesh(shape);
    wipe();
    if (!mesh || !mesh.triangles || mesh.triangles.length < 3) return null;
    return mesh;
  } catch (e) {
    wipe();
    if (isFatal(e)) throw e;
    return null;
  }
}
// A face cut changes only the solids it bites. Everything else keeps the mesh
// it was drawn with — it is not fused or remeshed.
function buildFaceCuts(seq, solidInfo, items) {
  const cuts = new Map();
  const active = [];
  const real = [];
  for (const step of seq) {
    if (step.kind === 'solid') { active.push(step); if (!cuts.has(step.rec.id)) cuts.set(step.rec.id, []); }
    else if (step.kind === 'feat' && step.man) {
      let box = null; try { box = step.man.boundingBox(); } catch (e) { box = null; }
      if (!box) continue;
      for (const s of active) {
        let sb = null; try { sb = s.rec.man.boundingBox(); } catch (e) { continue; }
        if (!bitesBox(sb, box)) continue;
        cuts.get(s.rec.id).push(step);
      }
    } else if (step.kind === 'hole' && step.man) real.push(step);
  }
  const byId = new Map(items.map((it) => [it.id, it]));
  const pieces = [];
  for (const si of solidInfo) {
    const it = byId.get(si.id);
    const list = cuts.get(si.id) || [];
    let man = si.man;
    let world = null;
    if (list.length && it) {
      world = cutSolidExact(it, list.map((s) => s.it));
      if (world) {
        try { man = own(toManifold(world)); } catch (e) { if (isFatal(e)) throw e; world = null; }
      }
      if (!world) for (const s of list) { try { man = own(man.subtract(s.man)); } catch (e) { if (isFatal(e)) throw e; } }
    }
    let box = null; try { box = man.boundingBox(); } catch (e) { box = null; }
    let orig = null; try { orig = si.man.boundingBox(); } catch (e) { orig = box; }
    pieces.push({ id: si.id, it, man, world, box, orig, cut: list.length > 0 });
  }
  for (const h of real) {
    let hb = null; try { hb = h.man.boundingBox(); } catch (e) { hb = null; }
    if (!hb) continue;
    for (const p of pieces) {
      if (!p.box || !bitesBox(p.box, hb)) continue;
      try { p.man = own(p.man.subtract(h.man)); p.world = null; p.cut = true; p.box = p.man.boundingBox(); } catch (e) { if (isFatal(e)) throw e; }
    }
  }
  // A fill sits inside the solid it repairs, so those two are one volume.
  // Two different objects are never unioned: that join was growing a region
  // that belongs to neither of them.
  const inside = (a, b) => {
    const t = 0.05;
    if (!a || !b) return false;
    return a.min[0] >= b.min[0] - t && a.max[0] <= b.max[0] + t
      && a.min[1] >= b.min[1] - t && a.max[1] <= b.max[1] + t
      && a.min[2] >= b.min[2] - t && a.max[2] <= b.max[2] + t;
  };
  const isFill = (p) => pieces.some((q) => q !== p && q.cut && inside(p.orig, q.orig) && !inside(q.orig, p.orig));
  const hosts = pieces.filter((p) => p.cut && !isFill(p));
  const taken = new Set();
  const show = [];
  const mans = [];
  for (const h of hosts) {
    const extra = pieces.filter((p) => p !== h && !taken.has(p.id) && isFill(p) && inside(p.orig, h.orig));
    extra.forEach((p) => taken.add(p.id));
    let man = h.man;
    if (extra.length) {
      try { man = own(MF.Manifold.union([h.man].concat(extra.map((p) => p.man)))); }
      catch (e) { if (isFatal(e)) throw e; man = h.man; }
    }
    mans.push(man);
    show.push(!extra.length && h.world ? h.world : fromManifold(man));
  }
  for (const p of pieces) {
    if ((p.cut && !isFill(p)) || taken.has(p.id)) continue;
    mans.push(p.man);
    const c = p.it && itemCache.get(sig(p.it));
    show.push(c && c.mesh ? placeMesh(c.mesh, p.it) : fromManifold(p.man));
  }
  const design = mans.length === 1 ? mans[0] : (mans.length ? own(MF.Manifold.union(mans)) : null);
  const mesh = show.length === 1 ? show[0] : (show.length ? concatMeshes(show) : null);
  const locals = new Map();
  for (const p of pieces) {
    if (!p.it || !p.cut || isFill(p)) continue;
    const src = p.world || fromManifold(p.man);
    const local = unplaceMesh(src, p.it);
    local.triangles = new Uint32Array(local.triangles);
    locals.set(p.it.id, local);
  }
  return { design, mesh, locals };
}
// A WebAssembly crash (out of memory, out-of-bounds access, abort) leaves the
// libraries in an unknown state: the page must restart this worker.
const isFatal = (e) => (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) || /memory access out of bounds|out of memory|unreachable|Aborted\(/i.test(String((e && e.message) || e));
// OpenCascade failures arrive as numbers or WebAssembly exceptions with no message.
const errText = (e) => (e instanceof Error && e.message ? e.message : 'This shape could not be built — usually the rounding or hollow is too large for its size. Try a smaller value.');

// ---- incremental combine -------------------------------------------------
// Moving / resizing one object should not re-join the whole design. `combo`
// keeps "everything except the object being edited", ready to merge with it.
let combo = null;            // { kind, hotId, restKey, partial }
let prevKeys = new Map();    // id -> placement key (solids and holes) of the last build
function freeCombo() { if (combo) { del(combo.partial); combo = null; } }
function combineIncremental(solidInfo, holeInfo, holes, holeUnion, holesKey) {
  const cur = new Map(); solidInfo.forEach((s) => cur.set(s.id, 's' + s.key)); holeInfo.forEach((h) => cur.set(h.id, 'h' + h.key));
  const changed = [];
  for (const [id, k] of cur) if (prevKeys.get(id) !== k) changed.push(id);
  for (const id of prevKeys.keys()) if (!cur.has(id)) changed.push(id);
  prevKeys = cur;
  const full = () => {
    freeCombo();
    let d = solidInfo.length === 1 ? solidInfo[0].man : own(MF.Manifold.union(solidInfo.map((s) => s.man)));
    if (holeUnion) d = own(d.subtract(holeUnion));
    return d;
  };
  if (changed.length !== 1 || !cur.has(changed[0])) return full();
  const hot = changed[0];
  const si = solidInfo.find((s) => s.id === hot); const hi = holeInfo.findIndex((h) => h.id === hot);
  if (si) {
    const others = solidInfo.filter((s) => s.id !== hot);
    const restKey = 's:' + others.map((s) => s.id + '=' + s.key).join('\n') + '|' + holesKey;
    if (!combo || combo.kind !== 's' || combo.hotId !== hot || combo.restKey !== restKey) {
      freeCombo();
      if (!others.length) return full();
      let rest = others.length === 1 ? others[0].man.translate([0, 0, 0]) : MF.Manifold.union(others.map((s) => s.man));
      if (holeUnion) { const r2 = rest.subtract(holeUnion); del(rest); rest = r2; }
      combo = { kind: 's', hotId: hot, restKey, partial: rest };
    }
    let piece = si.man; if (holeUnion) piece = own(si.man.subtract(holeUnion));
    return own(combo.partial.add(piece));
  }
  if (hi >= 0) {
    const otherHoles = holes.filter((_, i) => i !== hi);
    const restKey = 'h:' + solidInfo.map((s) => s.id + '=' + s.key).join('\n') + '|' + holeInfo.filter((_, i) => i !== hi).map((h) => h.id + '=' + h.key).join('\n');
    if (!combo || combo.kind !== 'h' || combo.hotId !== hot || combo.restKey !== restKey) {
      freeCombo();
      let all = solidInfo.length === 1 ? solidInfo[0].man.translate([0, 0, 0]) : MF.Manifold.union(solidInfo.map((s) => s.man));
      if (otherHoles.length) { const hu = otherHoles.length === 1 ? otherHoles[0] : MF.Manifold.union(otherHoles); const r2 = all.subtract(hu); del(all); if (otherHoles.length > 1) del(hu); all = r2; }
      combo = { kind: 'h', hotId: hot, restKey, partial: all };
    }
    return own(combo.partial.subtract(holes[hi]));
  }
  return full();
}
// Feature edges of the finished design (sharp creases and open borders), for the viewer.
function featureLines(mesh, deg) {
  const v = mesh.vertices, t = mesh.triangles, n = t.length / 3, cosT = Math.cos((deg || 28) * Math.PI / 180);
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx; const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
  }
  const first = new Map(); const out = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const p = t[i * 3 + k], q = t[i * 3 + (k + 1) % 3]; const key = p < q ? p * 4294967296 + q : q * 4294967296 + p;
    const j = first.get(key);
    if (j === undefined) { first.set(key, i); continue; }
    first.set(key, -1);
    if (j < 0) continue;
    const dot = nrm[i * 3] * nrm[j * 3] + nrm[i * 3 + 1] * nrm[j * 3 + 1] + nrm[i * 3 + 2] * nrm[j * 3 + 2];
    if (dot >= cosT) continue;
    // A wrinkle on one face: both triangles sit within 0.2 mm of the same plane,
    // even when a sliver's normal looks steep. A real corner's far vertex does not.
    const far = (tri) => { for (let s = 0; s < 3; s++) { const r = t[tri * 3 + s]; if (r !== p && r !== q) return r; } return p; };
    const ra = far(i), rb = far(j);
    const off = (r, tri, a) => Math.abs((v[r * 3] - v[a * 3]) * nrm[tri * 3] + (v[r * 3 + 1] - v[a * 3 + 1]) * nrm[tri * 3 + 1] + (v[r * 3 + 2] - v[a * 3 + 2]) * nrm[tri * 3 + 2]);
    if (off(ra, j, p) < 0.2 && off(rb, i, p) < 0.2) continue;
    out.push(v[p * 3], v[p * 3 + 1], v[p * 3 + 2], v[q * 3], v[q * 3 + 1], v[q * 3 + 2]);
  }
  return new Float32Array(out);
}
const sentSig = new Map(); // id -> signature of the item mesh last sent to the page
const placedCache = new Map(); // placement key -> placed manifold (kept between builds)

function resetCaches() {
  freeArena(); freeCombo();
  for (const c of itemCache.values()) { try { c.shape && c.shape.delete(); } catch (e) { /* freed */ } del(c.manifold); }
  itemCache.clear();
  for (const m of placedCache.values()) del(m); placedCache.clear();
  for (const m of cutterCache.values()) del(m); cutterCache.clear();
  sentSig.clear();
}
async function build(msg) {
  await ready;
  const t0 = performance.now();
  Q = msg.quality === 'fine' ? { tolerance: 0.02, angularTolerance: 0.1 } : { tolerance: 0.05, angularTolerance: 0.2 };
  // Images are reference pictures drawn by the viewer only.
  const items = (Array.isArray(msg.items) ? msg.items : []).filter((it) => !it.hidden && it.type !== 'image' && !(it.type === 'sketch' && it.draft));
  for (const [key, buf] of Object.entries(msg.files || {})) {
    if (fileMeshes.has(key)) continue;
    const it = items.find((i) => i.file && i.file.key === key) || items.flatMap((i) => (Array.isArray(i.cuts) ? i.cuts.map((c) => c.shape) : [])).find((sh) => sh && sh.file && sh.file.key === key);
    try { fileMeshes.set(key, await readFile(it ? it.file.ext : key.split('.').pop(), buf)); } catch (e) {
      postMessage({ type: 'error', id: msg.id, message: 'Could not read ' + ((it && it.name) || key) + ': ' + errText(e) });
      return;
    }
  }
  const fileUsers = items.concat(...items.map((i) => (Array.isArray(i.cuts) ? i.cuts.map((c) => c.shape) : [])));
  const missing = [...new Set(fileUsers.filter((i) => i && i.type === 'model' && i.file && !fileMeshes.has(i.file.key)).map((i) => i.file.key))];
  if (missing.length) { postMessage({ type: 'need', id: msg.id, keys: missing }); return; }
  const liveKeys = new Set(fileUsers.filter((i) => i && i.file).map((i) => i.file.key));
  for (const k of fileMeshes.keys()) if (!liveKeys.has(k)) fileMeshes.delete(k);

  const tm = {}; let tq = performance.now(); const lap = (k) => { const n = performance.now(); tm[k] = Math.round((tm[k] || 0) + n - tq); tq = n; };
  freeArena();
  const keep = []; // items whose mesh the page already has
  const pieces = {}; // id -> number of separate pieces (when more than one)
  const usedPlaced = new Set();
  const itemMeshes = {}; const errors = {}; const notes = {}; const transfer = []; const info = {}; const edgeInfo = {};
  const solids = []; const holes = []; const used = new Set(); const solidInfo = []; const holeInfo = [];
  const seq = []; // build order: a later solid is added after an earlier face push, so it can fill that cut
  for (const it of items) {
    const s = sig(it); used.add(s);
    try {
      let c = itemCache.get(s);
      if (!c) {
        const b0 = await buildItem(it);
        // how many loose pieces it had before any cut (imported meshes often have several shells)
        const cutLike = (Array.isArray(it.cuts) && it.cuts.length) || (Array.isArray(it.clip) && it.clip.length);
        let n0 = 1; if (cutLike && !it.piece) { const man = b0.manifold || toManifold(b0.mesh); const raw = man.decompose(); n0 = raw.filter((m) => m.volume() >= 0).length || 1; raw.forEach(del); if (!b0.manifold) del(man); }
        c = applyScale(applyPieces(await applyCuts(applyClip(b0, it), it), it), it); c.pieces0 = n0; itemCache.set(s, c);
      }
      if (c.pieces > Math.max(1, c.pieces0 || 1)) pieces[it.id] = c.pieces;
      if (sentSig.get(it.id) !== s || msg.all) {
        const m = { vertices: c.mesh.vertices.slice(), triangles: c.mesh.triangles.slice() };
        transfer.push(m.vertices.buffer, m.triangles.buffer);
        itemMeshes[it.id] = m; sentSig.set(it.id, s);
      } else keep.push(it.id);
      if (c.note) notes[it.id] = c.note;
      if (c.base) info[it.id] = { base: c.base.map((x) => Math.round(x * 1000) / 1000) };
      if (c.edges) edgeInfo[it.id] = c.edges;
      const pkey = s + '|' + JSON.stringify([it.pos, it.rot, it.flip || null]);
      // placed shapes are kept between builds: only objects that moved / changed are placed again
      const placed = () => { if (!c.manifold) return null; let pm = placedCache.get(pkey); if (!pm) { pm = placeManifold(c.manifold, it); placedCache.set(pkey, pm); } usedPlaced.add(pkey); return pm; };
      if (c.manifold && it.role === 'solid') { const pm = placed(); const rec = { id: it.id, name: it.name || it.type, man: pm, group: it.group || '', key: pkey, fill: !!it.fill }; solids.push(pm); solidInfo.push(rec); seq.push({ kind: 'solid', rec, it }); }
      if (c.manifold && it.role === 'hole') { const pm = placed(); const feature = !!(it.feature || /^Push( \d+)?$/.test(it.name || '')); holes.push(pm); holeInfo.push({ id: it.id, key: pkey, feature }); seq.push({ kind: feature ? 'feat' : 'hole', man: pm, it }); }
    } catch (e) { if (isFatal(e)) throw e; errors[it.id] = errText(e); }
  }
  lap('items');
  // forget placed shapes of objects that moved away / were removed (free their memory)
  for (const [k, m] of placedCache) if (!usedPlaced.has(k)) { del(m); placedCache.delete(k); }
  for (const [s, c] of itemCache) if (!used.has(s)) { try { c.shape && c.shape.delete(); } catch (e) { /* freed */ } del(c.manifold); itemCache.delete(s); for (const [k, m] of placedCache) if (k.startsWith(s + '|')) { del(m); placedCache.delete(k); } }

  let design = null; let holeUnion = null; let faceShow = null; let faceLocals = null;
  try {
    const holesKey = holeInfo.map((h) => h.id + '=' + h.key).join('\n');
    const hasFeat = holeInfo.some((h) => h.feature);
    if (hasFeat) {
      // Each face cut stays on the solid it bites. Other solids are not fused into it.
      const built = buildFaceCuts(seq, solidInfo, items);
      design = built.design; faceShow = built.mesh; faceLocals = built.locals;
      if (holes.length) holeUnion = holes.length === 1 ? holes[0] : own(MF.Manifold.union(holes));
    } else {
      if (holes.length) holeUnion = holes.length === 1 ? holes[0] : own(MF.Manifold.union(holes));
      const sMain = solidInfo.filter((x) => !x.fill), sFill = solidInfo.filter((x) => x.fill);
      if (sMain.length) design = combineIncremental(sMain, holeInfo, holes, holeUnion, holesKey);
      if (sFill.length) { const fu = sFill.length === 1 ? sFill[0].man : own(MF.Manifold.union(sFill.map((x) => x.man))); design = design ? own(design.add(fu)) : fu; }
    }
    if (design && design.isEmpty()) design = null;
  } catch (e) { if (isFatal(e)) throw e; postMessage({ type: 'error', id: msg.id, message: 'Combining shapes failed: ' + errText(e) }); return; }
  lap('combine');
  lastDesign = design;
  lastItems = items;
  lastSolids = solidInfo;
  lastGroups = msg.groups && typeof msg.groups === 'object' ? msg.groups : {};
  lastHoles = holeUnion;
  lap('misc');
  // How many separate printed pieces each combined object makes (1 = one solid part).
  const groupPieces = {};
  const byGroup = {};
  solidInfo.forEach((si) => { if (si.group) (byGroup[si.group] = byGroup[si.group] || []).push(si.man); });
  const featCut = holeInfo.some((h) => h.feature);
  for (const [g, mans] of Object.entries(byGroup)) {
    try {
      const tmp = [];
      const keep = (m) => { tmp.push(m); return m; };
      let u;
      if (!featCut) {
        u = mans.length === 1 ? mans[0] : keep(MF.Manifold.union(mans));
        if (lastHoles) u = keep(u.subtract(lastHoles));
      } else {
        // Same order as the printed solid: a push cuts, a later solid can fill it, a later push cuts that too.
        u = null; const real = [];
        for (const step of seq) {
          if (u && u.isEmpty()) u = null;
          if (step.kind === 'solid' && step.rec.group !== g) continue;
          if (step.kind === 'solid') u = u ? keep(u.add(step.rec.man)) : step.rec.man;
          else if (step.kind === 'feat' && u) u = keep(u.subtract(step.man));
          else if (step.kind === 'hole') real.push(step.man);
        }
        if (u && real.length) u = keep(u.subtract(real.length === 1 ? real[0] : keep(MF.Manifold.union(real))));
      }
      if (!u || u.isEmpty()) groupPieces[g] = 0;
      else { const pcs = u.decompose(); groupPieces[g] = pcs.length; pcs.forEach(del); }
      tmp.forEach(del);
    } catch (e) { /* skip */ }
  }
  lap('groupPieces');
  // Floating: a printed piece (connected solid) whose lowest point is above the
  // plate. Every solid that is part of such a piece is reported with its height.
  const floating = {};
  try {
    // Solids whose boxes touch are treated as one printed piece; a piece floats
    // when its lowest point is above the plate. (Boxes only: cheap enough for every rebuild.)
    const bb = solidInfo.map((si) => si.man.boundingBox()); const nS = bb.length;
    const par = bb.map((_, i) => i); const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const tol = 1e-3;
    for (let i = 0; i < nS; i++) for (let j = i + 1; j < nS; j++) {
      const a = bb[i], b = bb[j];
      if (a.max[0] + tol < b.min[0] || b.max[0] + tol < a.min[0] || a.max[1] + tol < b.min[1] || b.max[1] + tol < a.min[1] || a.max[2] + tol < b.min[2] || b.max[2] + tol < a.min[2]) continue;
      par[find(i)] = find(j);
    }
    const low = new Map(); bb.forEach((b, i) => { const r = find(i); low.set(r, Math.min(low.has(r) ? low.get(r) : Infinity, b.min[2])); });
    solidInfo.forEach((si, i) => { const z = low.get(find(i)); if (z > 0.05) floating[si.id] = Math.round(z * 100) / 100; });
  } catch (e) { /* informational only */ }
  lap('floating');
  if (!faceShow) refreshVisible(design, solidInfo, items, holes, itemMeshes, keep, transfer);
  const result = (faceShow && faceShow.triangles && faceShow.triangles.length) ? faceShow : (design ? fromManifold(design) : null);
  if (faceLocals) for (const [id, local] of faceLocals) {
    const it = items.find((x) => x.id === id); if (!it) continue;
    itemMeshes[id] = local;
    if (local.vertices.byteLength) transfer.push(local.vertices.buffer);
    if (local.triangles.byteLength) transfer.push(local.triangles.buffer);
    const i = keep.indexOf(id);
    if (i >= 0) keep.splice(i, 1);
    sentSig.set(id, sig(it) + '|vis');
  }
  if (result) { result.lines = featureLines(result, 28); transfer.push(result.vertices.buffer, result.triangles.buffer, result.lines.buffer); }
  lap('resultMesh');
  const stepOk = items.every((it) => it.role === 'ref' || it.type !== 'model' || (fileMeshes.get(it.file.key) || {}).shape);
  for (const id of [...sentSig.keys()]) if (!items.some((i) => i.id === id)) sentSig.delete(id);
  // A cached shape was freed while still in use ("…has been deleted"): drop every
  // cache and build everything again from scratch, once.
  if (!msg._fresh && Object.values(errors).some((e) => /has been deleted/i.test(String(e)))) {
    resetCaches();
    return build(Object.assign({}, msg, { _fresh: true, all: true }));
  }
  postMessage({ type: 'result', id: msg.id, timing: tm, pieces, result, items: itemMeshes, keep, errors, notes, stepOk, groupPieces, info, floating, edges: edgeInfo, ms: Math.round(performance.now() - t0) }, transfer);
}

// Join all: the chosen solids of the latest build, as they look (holes cut), made
// into one clean solid. Loose slivers smaller than minVol mm³ are dropped.
function bakeBody(msg) {
  const ids = new Set(msg.ids || []);
  const sel = lastSolids.filter((s) => ids.has(s.id)); const mans = sel.map((s) => s.man);
  if (!mans.length) throw new Error('Nothing to fix — those objects did not build.');
  const tmp = [];
  try {
    const u = withFills(sel); tmp.push(u);
    const vol0 = u.volume();
    const raw = u.decompose(); raw.forEach((m) => tmp.push(m));
    const minVol = Math.max(0, num(msg.minVol, 1));
    // cavities (negative volume) stay with the solid around them
    const solidsP = raw.filter((m) => m.volume() >= 0); const voids = raw.filter((m) => m.volume() < 0);
    const keep = solidsP.filter((m) => m.volume() >= minVol); const dropped = solidsP.filter((m) => m.volume() < minVol);
    if (!keep.length) throw new Error('Nothing is left after removing slivers.');
    const inside = (a, b) => { const A = a.boundingBox(), B = b.boundingBox(); return [0, 1, 2].every((k) => A.min[k] >= B.min[k] - 1e-6 && A.max[k] <= B.max[k] + 1e-6); };
    const parts = keep.concat(voids.filter((v) => keep.some((k) => inside(v, k))));
    const body = parts.length === 1 ? parts[0] : (tmp.push(MF.Manifold.compose(parts)), tmp[tmp.length - 1]);
    const bb = body.boundingBox();
    const stl = stlFromManifold(body);
    return { stl, pieces: keep.length, dropped: dropped.length, droppedVol: Math.round(dropped.reduce((a, m) => a + m.volume(), 0) * 100) / 100, volume0: Math.round(vol0 * 100) / 100, volume: Math.round(body.volume() * 100) / 100, min: bb.min, max: bb.max };
  } finally { tmp.forEach((m) => { if (!mans.includes(m)) del(m); }); }
}
function stlFromManifold(man) {
  const { vertices: v, triangles: t } = fromManifold(man);
  const n = t.length / 3;
  const buf = new ArrayBuffer(84 + n * 50); const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode('Accretion CAD export'));
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = 84 + i * 50;
    [nx, ny, nz, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]].forEach((x, k) => dv.setFloat32(o + k * 4, x, true));
  }
  return buf;
}
// STEP needs exact geometry, so it is rebuilt with OpenCascade booleans.
async function stepExport(name) {
  let design = null;
  const solids = []; const holes = [];
  for (const it of lastItems) {
    if (it.role === 'ref') continue;
    const c = itemCache.get(sig(it));
    if (!c) continue;
    if (!c.shape) throw new Error('"' + (it.name || it.type) + '" ' + (c.cut ? 'was cut with the Cut tool' : 'is a mesh (STL / 3MF / OBJ)') + ' — STEP needs exact shapes. Export STL or 3MF instead' + (c.cut ? '.' : ', or set that model to Reference.'));
    (it.role === 'hole' ? holes : solids).push(placeShape(c.shape, it));
  }
  for (const s of solids) design = design ? design.fuse(s) : s;
  if (!design) throw new Error('Nothing to export — add a solid shape first.');
  for (const h of holes) design = design.cut(h);
  return replicad.exportSTEP([{ shape: design, name: name || 'design' }]).arrayBuffer();
}

// ---------- overlap check & 3MF ----------
// Solids that share volume get fused into one piece on export. Pairs whose
// common volume is above 0.001 mm³ are reported (touching faces are not).
function findOverlaps() {
  const out = [];
  const bb = lastSolids.map((s) => s.man.boundingBox());
  for (let i = 0; i < lastSolids.length; i++) {
    for (let j = i + 1; j < lastSolids.length; j++) {
      if (lastSolids[i].group && lastSolids[i].group === lastSolids[j].group) continue; // combined on purpose
      const a = bb[i], b = bb[j];
      if (a.max[0] <= b.min[0] || b.max[0] <= a.min[0] || a.max[1] <= b.min[1] || b.max[1] <= a.min[1] || a.max[2] <= b.min[2] || b.max[2] <= a.min[2]) continue;
      let v = 0;
      try { const x = lastSolids[i].man.intersect(lastSolids[j].man); v = x.volume(); del(x); } catch (e) { if (isFatal(e)) throw e; v = 0; }
      if (v > 0.001) out.push({ a: lastSolids[i].id, b: lastSolids[j].id, aName: lastSolids[i].name, bName: lastSolids[j].name, volume: Math.round(v * 100) / 100 });
    }
  }
  return out;
}
// Overlapping solids form one printed part; parts that don't share volume stay separate.
// solids (minus all holes) plus their fills, as one new manifold
function withFills(list) {
  const main = list.filter((s) => !s.fill), fills = list.filter((s) => s.fill);
  let man = null;
  if (main.length) { man = main.length === 1 ? main[0].man.translate([0, 0, 0]) : MF.Manifold.union(main.map((s) => s.man)); if (lastHoles) { const sub = man.subtract(lastHoles); del(man); man = sub; } }
  if (fills.length) { const fu = fills.length === 1 ? fills[0].man : MF.Manifold.union(fills.map((s) => s.man)); const r = man ? man.add(fu) : fu.translate([0, 0, 0]); if (man) del(man); if (fills.length > 1) del(fu); man = r; }
  return man;
}
function partsForExport(overlaps) {
  let man;
  const idx = new Map(lastSolids.map((s, i) => [s.id, i]));
  const parent = lastSolids.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const o of overlaps) parent[find(idx.get(o.a))] = find(idx.get(o.b));
  const firstOfGroup = {};
  lastSolids.forEach((s, i) => { if (!s.group) return; if (firstOfGroup[s.group] == null) firstOfGroup[s.group] = i; else parent[find(i)] = find(firstOfGroup[s.group]); });
  const groups = new Map();
  lastSolids.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
  const parts = [];
  for (const g of groups.values()) {
    man = withFills(g); // solids − holes + fills (a fresh manifold we free after export)
    if (man.isEmpty()) { del(man); continue; }
    const names = []; const seen = new Set();
    for (const s of g) { const n = s.group ? ((lastGroups[s.group] && lastGroups[s.group].name) || 'Combined') : s.name; if (!seen.has(n)) { seen.add(n); names.push(n); } }
    parts.push({ name: names.join(' + '), man });
  }
  return parts;
}
const xmlEsc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const f6 = (x) => { const r = Math.round(x * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };
// 3MF: a zip with one XML model; each part is its own named object (millimetres).
function threeMF(parts, title) {
  const objs = []; const build = [];
  parts.forEach((p, k) => {
    const { vertices: v, triangles: t } = fromManifold(p.man);
    const vs = new Array(v.length / 3); for (let i = 0; i < vs.length; i++) vs[i] = '<vertex x="' + f6(v[i * 3]) + '" y="' + f6(v[i * 3 + 1]) + '" z="' + f6(v[i * 3 + 2]) + '"/>';
    const ts = new Array(t.length / 3); for (let i = 0; i < ts.length; i++) ts[i] = '<triangle v1="' + t[i * 3] + '" v2="' + t[i * 3 + 1] + '" v3="' + t[i * 3 + 2] + '"/>';
    objs.push('<object id="' + (k + 1) + '" type="model" name="' + xmlEsc(p.name) + '"><mesh><vertices>' + vs.join('') + '</vertices><triangles>' + ts.join('') + '</triangles></mesh></object>');
    build.push('<item objectid="' + (k + 1) + '"/>');
  });
  const model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + '<metadata name="Title">' + xmlEsc(title || 'design') + '</metadata><metadata name="Application">Accretion CAD</metadata>'
    + '<resources>' + objs.join('') + '</resources><build>' + build.join('') + '</build></model>';
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

// The separate areas of a sketch: where its outlines overlap, each overlap and
// each remaining part is its own area (like Fusion 360's sketch profiles).
function sketchRegions(outlines) {
  const CS = MF.CrossSection; let regions = [];
  for (const pts of outlines) {
    if (!pts || pts.length < 3) continue;
    const P = new CS([pts], 'NonZero'); let rest = P.translate([0, 0]); const next = [];
    for (const R of regions) {
      const a = R.intersect(P), b = R.subtract(P);
      if (!a.isEmpty()) next.push(a); else a.delete();
      if (!b.isEmpty()) next.push(b); else b.delete();
      const r2 = rest.subtract(R); rest.delete(); rest = r2;
      R.delete();
    }
    if (!rest.isEmpty()) next.push(rest); else rest.delete();
    P.delete();
    regions = next;
  }
  const out = [];
  for (const R of regions) {
    for (const piece of R.decompose()) {
      const polys = piece.toPolygons().map((poly) => poly.map((q) => [Math.round(q[0] * 1e4) / 1e4, Math.round(q[1] * 1e4) / 1e4]));
      const area = polys.reduce((acc, poly) => { let a2 = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a2 += p[0] * q[1] - q[0] * p[1]; } return acc + a2 / 2; }, 0);
      if (area > 1e-6) out.push({ polys, area });
      piece.delete();
    }
    R.delete();
  }
  return out;
}

async function exportFile(msg) {
  await ready;
  let buffer;
  if (msg.format === 'step') buffer = await stepExport(msg.name);
  else if (msg.format === '3mf') {
    if (!lastSolids.length) throw new Error('Nothing to export — add a solid shape first.');
    const parts = partsForExport(findOverlaps());
    try {
      if (!parts.length) throw new Error('Nothing to export — the holes remove everything.');
      buffer = threeMF(parts, msg.name);
    } finally { parts.forEach((pt) => del(pt.man)); }
  } else {
    if (!lastDesign) throw new Error('Nothing to export — add a solid shape first.');
    buffer = stlFromManifold(lastDesign);
  }
  postMessage({ type: 'file', id: msg.id, format: msg.format, buffer }, [buffer]);
}

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data || {};
  queue = queue.then(async () => { // the kernels are single-threaded: one job at a time
    try {
      if (msg.type === 'build') await build(msg);
      else if (msg.type === 'export') await exportFile(msg);
      else if (msg.type === 'bake') { await ready; const r = bakeBody(msg); postMessage(Object.assign({ type: 'baked', id: msg.id }, r), [r.stl]); }
      else if (msg.type === 'regions') { await ready; postMessage({ type: 'regions', id: msg.id, regions: sketchRegions(msg.outlines || []) }); }
      else if (msg.type === 'check') { await ready; postMessage({ type: 'check', id: msg.id, overlaps: findOverlaps() }); }
    } catch (e) {
      if (isFatal(e)) { postMessage({ type: 'fatal', id: msg.id, message: String((e && e.message) || e) }); return; }
      postMessage({ type: 'error', id: msg.id, message: errText(e) });
    }
  });
};
