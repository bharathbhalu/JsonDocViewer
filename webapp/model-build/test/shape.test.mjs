// 3D Model: the document round-trips, and each body is meshed on its own.
//   node model-build/test/shape.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ModelCore = require(path.join(here, '..', '..', 'public', 'model', 'core.js'));
const bundle = path.join(here, '..', '..', 'public', 'model', 'vendor', 'model-worker.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else { fail++; console.log('  ✗ ' + name + (detail ? '   [' + detail + ']' : '')); return; }
  console.log('  ✓ ' + name);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function volume(v, t) {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1])
      - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c])
      + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(s) / 6;
}
function bounds(v) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  }
  return { lo, hi };
}

{
  const doc = ModelCore.createStarter();
  const html = ModelCore.serializeToHtml(doc, 'Part');
  check('file is a 3D Model, not a 3D design', html.includes('data-docviewer="model"') && !html.includes('data-docviewer="cad"'));
  check('kind marker is in the first 400 bytes', html.slice(0, 400).includes('data-docviewer="model"'));
  const back = ModelCore.parseHtml(html);
  check('starter round-trips one box', back && back.objects.length === 1 && back.objects[0].type === 'box' && back.objects[0].kernel === 'brep');
  check('box is 40×30×20', back.objects[0].size.x === 40 && back.objects[0].size.y === 30 && back.objects[0].size.z === 20);
  check('a 3D design file is not read as a model', ModelCore.parseHtml('<html data-docviewer="cad"></html>') === null);
  const hist = ModelCore.normalize({
    title: 'H',
    objects: [{ name: 'A', type: 'box' }],
    history: { past: [[{ name: 'Old', type: 'sphere' }]], future: [[{ name: 'Next', type: 'cylinder' }]] },
  });
  const histHtml = ModelCore.serializeToHtml(hist, 'H');
  const histBack = ModelCore.parseHtml(histHtml);
  check('undo stack survives a save', histBack.history.past.length === 1 && histBack.history.past[0][0].type === 'sphere' && histBack.history.past[0][0].name === 'Old');
  check('redo stack survives a save', histBack.history.future.length === 1 && histBack.history.future[0][0].type === 'cylinder');
  const cached = ModelCore.normalize({
    objects: [{ name: 'A', type: 'box', view: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2], faces: [] }, brep: 'BREP_SAMPLE_TEXT_LONG_ENOUGH', brepHash: 'abc' }],
    history: { past: [[{ name: 'A', type: 'box', brep: 'SHOULD_NOT_STAY', view: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] } }]] },
  });
  const cachedBack = ModelCore.parseHtml(ModelCore.serializeToHtml(cached, 'C'));
  check('the saved picture and solid stay in the file', cachedBack.objects[0].view && cachedBack.objects[0].view.vertices.length === 9 && cachedBack.objects[0].brep === 'BREP_SAMPLE_TEXT_LONG_ENOUGH');
  check('undo does not keep a copy of the solid', cachedBack.history.past.length === 1 && !cachedBack.history.past[0][0].brep && !cachedBack.history.past[0][0].view);
  const exactDoc = ModelCore.normalize({
    objects: [{
      name: 'S', type: 'sketch', height: 2,
      profiles: [{ k: 'exact', wires: [{ edges: [{ k: 'circle', c: [1, 2], r: 4 }] }, { edges: [{ k: 'line', a: [0, 0], b: [1, 0] }, { k: 'arc', a: [1, 0], b: [0, 0], mid: [0.5, 0.5] }] }] }],
      view: {
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2],
        faces: [{ center: [0, 0, 1], normal: [0, 0, 1], exact: [{ edges: [{ k: 'circle', c: [0, 0, 1], r: 3 }] }] }],
      },
    }],
  });
  const exactBack = ModelCore.parseHtml(ModelCore.serializeToHtml(exactDoc, 'S'));
  const ep = exactBack.objects[0].profiles[0];
  check('an exact face sketch survives a save', ep.k === 'exact' && ep.wires[0].edges[0].k === 'circle' && ep.wires[0].edges[0].r === 4 && ep.wires[1].edges[1].k === 'arc');
  check('a face keeps the exact edge it was built from', exactBack.objects[0].view.faces[0].exact[0].edges[0].k === 'circle' && exactBack.objects[0].view.faces[0].exact[0].edges[0].r === 3);
  const scaled = ModelCore.normalize({
    objects: [{ name: 'A', type: 'box', scale: [2, 0, -3] }],
    checkpoints: [{ name: 'Before', objects: [{ name: 'Old', type: 'sphere', brep: 'SHOULD_NOT_STAY' }] }],
    history: { past: Array.from({ length: 60 }, (_, i) => [{ name: 'H' + i, type: 'box' }]) },
  });
  const scaledBack = ModelCore.parseHtml(ModelCore.serializeToHtml(scaled, 'S'));
  check('scale is kept and a zero scale becomes the minimum', scaledBack.objects[0].scale[0] === 2 && scaledBack.objects[0].scale[1] === 0.05 && scaledBack.objects[0].scale[2] === -3);
  check('a body with no scale is full size', ModelCore.normalize({ objects: [{ name: 'A', type: 'box' }] }).objects[0].scale.join(',') === '1,1,1');
  check('a checkpoint survives a save without the solid', scaledBack.checkpoints.length === 1 && scaledBack.checkpoints[0].name === 'Before' && scaledBack.checkpoints[0].objects[0].type === 'sphere' && !scaledBack.checkpoints[0].objects[0].brep);
  check('undo keeps the last 50 steps', scaledBack.history.past.length === 50 && scaledBack.history.past[0][0].name === 'H10' && scaledBack.history.past[49][0].name === 'H59');
  const splitDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [{ op: 'split', origin: [0, 0, 5], normal: [1, 0, 0] }] }] });
  check('a face cut by a plane is saved', splitDoc.objects[0].features[0].op === 'split' && splitDoc.objects[0].features[0].origin[2] === 5 && splitDoc.objects[0].features[0].normal[0] === 1);
  const imprintDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [{ op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: [{ k: 'poly', pts: [[-8, 0, 10], [8, 0, 10]] }, { k: 'circle', c: [0, 0, 10], r: 2 }, { k: 'poly', pts: [[0, 0, 0]] }] }] }] });
  const savedCuts = imprintDoc.objects[0].features[0];
  check('a face partition is saved', savedCuts && savedCuts.op === 'imprint' && savedCuts.cuts.length === 2 && savedCuts.cuts[1].k === 'circle' && savedCuts.cuts[1].r === 2);
  const pathDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'sketch', profiles: [{ k: 'path', pts: [[0, 0], [4, 1]] }, { k: 'poly', pts: [[0, 0]] }] }] });
  check('an open cut line is saved and a short loop is not', pathDoc.objects[0].profiles.length === 1 && pathDoc.objects[0].profiles[0].k === 'path' && pathDoc.objects[0].profiles[0].pts[1][0] === 4);
}

const inbox = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => inbox.push(m);
await import(pathToFileURL(bundle).href);
const take = async (pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('worker timeout');
};
const ready = await take((m) => m.type === 'ready' || m.type === 'init-error');
check('worker starts OpenCascade', ready.type === 'ready', ready.message);

let seq = 0;
const send = async (msg) => {
  const id = ++seq;
  self.onmessage({ data: Object.assign({ id }, msg) });
  return take((m) => m.id === id);
};

{
  const r = await send({ type: 'build', objects: [
    { id: 'a', kernel: 'brep', type: 'box', size: { x: 30, y: 20, z: 15 } },
    { id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } },
  ] });
  const a = (r.bodies || []).find((b) => b.id === 'a');
  const b = (r.bodies || []).find((b) => b.id === 'b');
  check('two bodies come back as two meshes', r.bodies && r.bodies.length === 2 && a && b && a.vertices && b.vertices, r.error);
  if (a && b && a.vertices && b.vertices) {
    check('first box stays 9000, not a fused solid', near(volume(a.vertices, a.triangles), 9000, 1), volume(a.vertices, a.triangles));
    check('second box stays 1000', near(volume(b.vertices, b.triangles), 1000, 1), volume(b.vertices, b.triangles));
    const box = bounds(a.vertices);
    check('box sits on the floor and is centred', near(box.lo[2], 0, 1e-4) && near(box.lo[0], -15, 1e-4) && near(box.hi[0], 15, 1e-4));
  }
}
{
  const r = await send({ type: 'build', objects: [
    { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 20 } },
    { id: 's', kernel: 'brep', type: 'sphere', size: { d: 20 } },
  ] });
  const c = (r.bodies || []).find((b) => b.id === 'c');
  const s = (r.bodies || []).find((b) => b.id === 's');
  if (c && s && c.vertices && s.vertices) {
    check('cylinder volume', near(volume(c.vertices, c.triangles), Math.PI * 100 * 20, 40), volume(c.vertices, c.triangles));
    check('sphere sits on the floor', near(bounds(s.vertices).lo[2], 0, 0.05) && near(volume(s.vertices, s.triangles), 4 / 3 * Math.PI * 1000, 40));
  } else check('cylinder and sphere mesh', false, r.error || 'missing');
}

{
  const r = await send({ type: 'build', objects: [
    { id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [] },
    { id: 'other', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [40, 0, 0] },
  ] });
  const box = (r.bodies || []).find((b) => b.id === 'box');
  const other = (r.bodies || []).find((b) => b.id === 'other');
  check('a box reports its flat faces', box && box.faces && box.faces.length === 6, box && box.faces && box.faces.length);
  const top = box && (box.faces || []).find((f) => f.normal[2] > 0.9 && f.center[2] > 9);
  check('the top face is found', !!top);
  if (top) {
    const cut = await send({ type: 'build', objects: [
      { id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [{ op: 'push', loop: top.loop, normal: top.normal, dist: -2 }] },
      { id: 'other', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } },
    ] });
    const a = (cut.bodies || []).find((b) => b.id === 'box');
    const b = (cut.bodies || []).find((b) => b.id === 'other');
    check('a face push cuts only that body', a && near(volume(a.vertices, a.triangles), 800, 2), a && volume(a.vertices, a.triangles));
    check('the other body stays 1000', b && near(volume(b.vertices, b.triangles), 1000, 1), b && volume(b.vertices, b.triangles));
    if (a) check('the cut stops at 8 mm', near(bounds(a.vertices).hi[2], 8, 0.05), bounds(a.vertices).hi[2]);
  }
}
{
  const r = await send({ type: 'build', objects: [{
    id: 'sk', kernel: 'brep', type: 'sketch', height: 2,
    profiles: [{ k: 'rect', x: 0, y: 0, w: 10, h: 10 }],
  }] });
  const sk = (r.bodies || [])[0];
  check('a sketch extrude is its own solid', sk && sk.vertices && near(volume(sk.vertices, sk.triangles), 200, 1), sk && sk.error);
}
{
  const r = await send({ type: 'build', objects: [{
    id: 'j', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [
      { id: 'a', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
      { id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [30, 0, 0], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const j = (r.bodies || [])[0];
  check('join keeps both volumes and does not bridge them', j && j.vertices && near(volume(j.vertices, j.triangles), 2000, 2) && near(bounds(j.vertices).hi[0] - bounds(j.vertices).lo[0], 40, 0.1), j && (j.error || (j.vertices && volume(j.vertices, j.triangles))));
}

{
  const r = await send({ type: 'build', objects: [{
    id: 'm', kernel: 'mesh', type: 'mesh',
    mesh: { vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0], triangles: [0, 1, 2] },
  }] });
  const m = (r.bodies || [])[0];
  check('an imported mesh is drawn as stored and has no flat faces', m && m.kernel === 'mesh' && m.vertices && m.vertices.length === 9 && (!m.faces || m.faces.length === 0), m && m.error);
}

{
  const base = await send({ type: 'build', objects: [
    { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 }, features: [] },
  ] });
  const cyl = (base.bodies || [])[0];
  const top = cyl && (cyl.faces || []).find((f) => f.normal[2] > 0.9 && f.center[2] > 9);
  check('a cylinder has a round top face', !!top && top.loop.length > 24, top && top.loop.length);
  const wall = cyl && (cyl.faces || []).find((f) => f.surface && (!f.loop || f.loop.length < 3));
  check('a curved face keeps the triangles you can click', !!wall && wall.surface.triangles.length > 24, wall && wall.surface && wall.surface.triangles.length);
  if (top) {
    const pulled = await send({ type: 'build', objects: [{
      id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 },
      features: [{ op: 'push', loop: top.loop, normal: top.normal, center: top.center, dist: 5 }],
    }] });
    const body = (pulled.bodies || [])[0];
    const vol = body && body.vertices && volume(body.vertices, body.triangles);
    const exact = Math.PI * 100 * 15;
    check('pulling the round face keeps a cylinder, not a 12-sided prism', body && body.vertices && near(vol, exact, 50) && near(bounds(body.vertices).hi[2], 15, 0.05), vol);
    if (body && body.vertices) {
      const angs = new Set();
      const v = body.vertices;
      for (let i = 0; i < v.length; i += 3) {
        if (v[i + 2] < 12) continue;
        if (Math.hypot(v[i], v[i + 1]) < 9) continue;
        angs.add(Math.round(Math.atan2(v[i + 1], v[i]) * 16));
      }
      check('the pulled wall stays as round as the cylinder', angs.size > 20, angs.size);
    }
  }
}

{
  const r = await send({ type: 'build', objects: [
    { id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } },
  ] });
  const box = (r.bodies || [])[0];
  const sides = (box && box.faces || []).filter((f) => Math.abs(f.normal[2]) < 0.5);
  const distinct = (loop) => {
    const keys = new Set(loop.map((p) => p.map((v) => Math.round(v * 1000)).join(',')));
    return keys.size;
  };
  check('every cube side outline is a rectangle, not a triangle', sides.length === 4 && sides.every((f) => distinct(f.loop) === 4), sides.map((f) => distinct(f.loop)).join(','));
}

{
  const built = await send({ type: 'build', objects: [
    { id: 'keep', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [] },
  ] });
  const body = (built.bodies || [])[0];
  check('a built solid is saved for the next open', body && typeof body.brep === 'string' && body.brep.length > 16 && body.brepHash, body && body.brep && body.brep.length);
  if (body && body.brep) {
    const t0 = Date.now();
    const restored = await send({ type: 'build', objects: [{
      id: 'restored', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [],
      brep: body.brep, brepHash: body.brepHash,
    }] });
    const back = (restored.bodies || [])[0];
    const ms = Date.now() - t0;
    check('opening a saved solid does not rebuild it', back && back.vertices && near(volume(back.vertices, back.triangles), 1000, 1) && !back.brep, (back && back.error) || ms + 'ms');
    const top = back && (back.faces || []).find((f) => f.normal[2] > 0.9 && f.center[2] > 9);
    if (top) {
      const cut = await send({ type: 'build', objects: [{
        id: 'restored', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
        features: [{ op: 'push', loop: top.loop, normal: top.normal, center: top.center, dist: -2 }],
      }] });
      const a = (cut.bodies || [])[0];
      check('a push on a restored solid cuts it', a && a.vertices && near(volume(a.vertices, a.triangles), 800, 2), a && (a.error || volume(a.vertices, a.triangles)));
    } else check('a restored solid still has its top face', false);
  }
}

{
  const joined = await send({ type: 'build', objects: [{
    id: 'jc', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [
      { id: 'box', kernel: 'brep', type: 'box', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
      { id: 'cyl', kernel: 'brep', type: 'cylinder', size: { d: 10, z: 40 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const body = (joined.bodies || [])[0];
  const vol = body && body.vertices && volume(body.vertices, body.triangles);
  const expect = 8000 + Math.PI * 25 * 40 - Math.PI * 25 * 20;
  check('a cylinder joined through a cube stays one solid', body && body.vertices && near(vol, expect, 80) && near(bounds(body.vertices).hi[2], 40, 0.2), body && (body.error || vol));
  const lines = body && body.edges ? body.edges.length / 6 : 0;
  const tris = body && body.triangles ? body.triangles.length / 3 : 0;
  check('the joined cylinder is drawn with its real edges, not every panel', body && lines > 8 && lines < tris && body.normals && body.normals.length === body.vertices.length, lines + ' lines, ' + tris + ' tris');
}

{
  const top = [[-5, -5, 10], [5, -5, 10], [5, 5, 10], [-5, 5, 10]];
  const joined = await send({ type: 'build', objects: [{
    id: 'moved', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [
      { kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [100, 0, 0], rot: [0, 0, 0], features: [{ op: 'push', loop: top, normal: [0, 0, 1], center: [0, 0, 10], dist: -2 }] },
      { kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const body = (joined.bodies || [])[0];
  let hi = -Infinity;
  if (body && body.vertices) {
    for (let i = 0; i < body.vertices.length; i += 3) if (body.vertices[i] > 50) hi = Math.max(hi, body.vertices[i + 2]);
  }
  check('a moved body keeps the cut it already had', body && body.vertices && near(volume(body.vertices, body.triangles), 1800, 3) && near(hi, 8, 0.05), body && (body.error || hi));
}

{
  const bored = await send({ type: 'build', objects: [{
    id: 'hole', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [
      { kernel: 'brep', type: 'box', size: { x: 30, y: 30, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
      { kernel: 'brep', type: 'cylinder', size: { d: 10, z: 20 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const fused = (bored.bodies || [])[0];
  const cap = fused && (fused.faces || []).find((f) => f.loop && f.loop.length > 24 && f.normal[2] > 0.9 && f.center[2] > 19);
  let inner = null;
  if (cap) {
    const cut = await send({ type: 'build', objects: [{
      id: 'hole', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
      features: [{ op: 'push', loop: cap.loop, normal: cap.normal, center: cap.center, dist: -25 }],
      parts: [
        { kernel: 'brep', type: 'box', size: { x: 30, y: 30, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
        { kernel: 'brep', type: 'cylinder', size: { d: 10, z: 20 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
      ],
    }] });
    const body = (cut.bodies || [])[0];
    const curved = body && (body.faces || []).filter((f) => f.surface && (!f.loop || f.loop.length < 3));
    inner = curved && curved[0];
    const coversHole = (face) => {
      const v = face.surface.vertices, t = face.surface.triangles;
      for (let i = 0; i < t.length; i += 3) {
        const ax = v[t[i] * 3], ay = v[t[i] * 3 + 1];
        const bx = v[t[i + 1] * 3], by = v[t[i + 1] * 3 + 1];
        const cx = v[t[i + 2] * 3], cy = v[t[i + 2] * 3 + 1];
        const c1 = (bx - ax) * (0 - ay) - (by - ay) * (0 - ax);
        const c2 = (cx - bx) * (0 - by) - (cy - by) * (0 - bx);
        const c3 = (ax - cx) * (0 - cy) - (ay - cy) * (0 - cx);
        if ((c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0)) return true;
      }
      return false;
    };
    const top = body && (body.faces || []).find((f) => f.loop && f.normal[2] > 0.9 && f.center[2] > 9);
    check('the face inside a hole can be selected', body && body.vertices && !!inner && inner.surface.triangles.length > 24 && top && top.surface && !coversHole(top), body && (body.error || (inner && inner.surface.triangles.length)));
  } else check('the face inside a hole can be selected', false, 'no cap');
}

{
  const box = await send({ type: 'build', objects: [
    { id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } },
  ] });
  const top = box.bodies && box.bodies[0] && (box.bodies[0].faces || []).find((f) => f.normal[2] > 0.9);
  const lines = top && top.exact && top.exact[0] && top.exact[0].edges;
  check('a flat face is four real edges', lines && lines.length === 4 && lines.every((e) => e.k === 'line') && (!top.exact[1]), lines && lines.map((e) => e.k).join(','));
}
{
  const cyl = await send({ type: 'build', objects: [
    { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 } },
  ] });
  const body = (cyl.bodies || [])[0];
  const cap = body && (body.faces || []).find((f) => f.normal[2] > 0.9 && f.exact);
  const edge = cap && cap.exact[0].edges[0];
  check('a round face is one circle, not a polygon', edge && cap.exact[0].edges.length === 1 && edge.k === 'circle' && near(edge.r, 10, 0.02), edge && JSON.stringify(edge));
  if (edge) {
    const extruded = await send({ type: 'build', objects: [{
      id: 'sk', kernel: 'brep', type: 'sketch', height: 10, pos: [0, 0, 0], rot: [0, 0, 0],
      profiles: [{ k: 'exact', wires: [{ edges: [{ k: 'circle', c: [edge.c[0], edge.c[1]], r: edge.r }] }] }],
    }] });
    const sk = (extruded.bodies || [])[0];
    const want = Math.PI * 100 * 10;
    check('extruding that circle fills the round face', sk && sk.vertices && near(volume(sk.vertices, sk.triangles), want, 40) && near(volume(body.vertices, body.triangles), want, 40), sk && (sk.error || volume(sk.vertices, sk.triangles)));
  }
}
{
  const square = [
    { k: 'line', a: [-10, -10], b: [10, -10] },
    { k: 'line', a: [10, -10], b: [10, 10] },
    { k: 'line', a: [10, 10], b: [-10, 10] },
    { k: 'line', a: [-10, 10], b: [-10, -10] },
  ];
  const holed = await send({ type: 'build', objects: [{
    id: 'h', kernel: 'brep', type: 'sketch', height: 5, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'exact', wires: [{ edges: square }, { edges: [{ k: 'circle', c: [0, 0], r: 4 }] }] }],
  }] });
  const body = (holed.bodies || [])[0];
  const want = (400 - Math.PI * 16) * 5;
  check('a hole in the face stays a hole when extruded', body && body.vertices && near(volume(body.vertices, body.triangles), want, 30), body && (body.error || (body.vertices && volume(body.vertices, body.triangles))));
  const top = body && (body.faces || []).find((f) => f.normal && f.normal[2] > 0.9 && f.exact && f.exact.length > 1);
  const holeEdges = top && top.exact[1].edges;
  const onCircle = (p) => p && near(Math.hypot(p[0], p[1]), 4, 0.05);
  const fullCircle = holeEdges && holeEdges.length === 1 && holeEdges[0].k === 'circle' && near(holeEdges[0].r, 4, 0.05);
  const fullArcs = holeEdges && holeEdges.length >= 2 && holeEdges.every((e) => e.k === 'arc' && onCircle(e.a) && onCircle(e.b) && onCircle(e.mid));
  check('the extruded face still reports its hole', fullCircle || fullArcs, holeEdges && JSON.stringify(holeEdges));
}
{
  const grown = await send({ type: 'build', objects: [{
    id: 'j', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [{ kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [2, 2, 2], features: [] }],
  }] });
  const body = (grown.bodies || [])[0];
  const b = body && body.vertices && bounds(body.vertices);
  check('a uniform scale is part of the joined solid', body && body.vertices && near(volume(body.vertices, body.triangles), 8000, 20) && b && near(b.hi[0] - b.lo[0], 20, 0.1), body && (body.error || (b && (b.hi[0] - b.lo[0]))));
  const flat = await send({ type: 'build', objects: [{
    id: 'j2', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [{ kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [2, 1, 1], features: [] }],
  }] });
  const wide = (flat.bodies || [])[0];
  const wb = wide && wide.vertices && bounds(wide.vertices);
  check('a different scale on each axis is kept', wide && wide.vertices && near(volume(wide.vertices, wide.triangles), 2000, 20) && wb && near(wb.hi[0] - wb.lo[0], 20, 0.1) && near(wb.hi[1] - wb.lo[1], 10, 0.1), wide && (wide.error || (wb && volume(wide.vertices, wide.triangles))));
  const flipped = await send({ type: 'build', objects: [{
    id: 'j3', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [{
      kernel: 'brep', type: 'sketch', height: 2, pos: [0, 0, 0], rot: [0, 0, 0], scale: [-1, 1, 1], features: [],
      profiles: [{ k: 'rect', x: 10, y: 0, w: 4, h: 4 }],
    }],
  }] });
  const mir = (flipped.bodies || [])[0];
  const mb = mir && mir.vertices && bounds(mir.vertices);
  check('mirroring across a plane flips the solid to the other side', mir && mir.vertices && mb && mb.hi[0] < 0 && mb.lo[0] < -7 && near(volume(mir.vertices, mir.triangles), 32, 2), mir && (mir.error || (mb && mb.hi[0])));
}
{
  const cut = await send({ type: 'build', objects: [{
    id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'split', origin: [0, 0, 5], normal: [1, 0, 0] }],
  }] });
  const body = (cut.bodies || [])[0];
  const tops = body && (body.faces || []).filter((f) => f.normal && f.normal[2] > 0.9);
  check('a plane splits a face in two and keeps the solid', body && body.vertices && near(volume(body.vertices, body.triangles), 1000, 20) && tops && tops.length === 2 && tops.some((f) => f.center[0] > 0.5) && tops.some((f) => f.center[0] < -0.5), body && (body.error || (body.notes && body.notes.join('; ')) || (tops && tops.length)));
}
{
  const line = [{ k: 'poly', pts: [[-8, 0, 10], [8, 0, 10]] }];
  const cut = await send({ type: 'build', objects: [{
    id: 'im', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: line }],
  }] });
  const body = (cut.bodies || [])[0];
  const tops = body && (body.faces || []).filter((f) => f.normal && f.normal[2] > 0.9);
  check('a line drawn across a face splits it and keeps the solid', body && body.vertices && near(volume(body.vertices, body.triangles), 1000, 20) && tops && tops.length === 2 && tops.some((f) => f.center[1] > 0.5) && tops.some((f) => f.center[1] < -0.5), body && (body.error || (body.notes && body.notes.join('; ')) || (tops && tops.length)));
  const side = tops && tops.find((f) => f.center[1] > 0.5);
  const pushed = side && await send({ type: 'build', objects: [{
    id: 'im2', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [
      { op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: line },
      { op: 'push', loop: side.loop, normal: side.normal, center: side.center, dist: 2 },
    ],
  }] });
  const grown = pushed && (pushed.bodies || [])[0];
  check('one partition of a split face extrudes on its own', grown && grown.vertices && near(volume(grown.vertices, grown.triangles), 1100, 40), grown && (grown.error || (grown.notes && grown.notes.join('; ')) || (grown.vertices && volume(grown.vertices, grown.triangles))));
  const sunk = side && await send({ type: 'build', objects: [{
    id: 'im3', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [
      { op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: line },
      { op: 'push', loop: side.loop, normal: side.normal, center: side.center, dist: -2 },
    ],
  }] });
  const pocket = sunk && (sunk.bodies || [])[0];
  check('one partition of a split face can be cut inward', pocket && pocket.vertices && near(volume(pocket.vertices, pocket.triangles), 900, 40), pocket && (pocket.error || (pocket.notes && pocket.notes.join('; ')) || (pocket.vertices && volume(pocket.vertices, pocket.triangles))));
  const ring = await send({ type: 'build', objects: [{
    id: 'im4', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: [{ k: 'circle', c: [0, 0, 10], r: 2 }] }],
  }] });
  const disk = (ring.bodies || [])[0];
  const dtops = disk && (disk.faces || []).filter((f) => f.normal && f.normal[2] > 0.9);
  check('a circle drawn on a face splits out that region', disk && disk.vertices && near(volume(disk.vertices, disk.triangles), 1000, 20) && dtops && dtops.length === 2, disk && (disk.error || (disk.notes && disk.notes.join('; ')) || (dtops && dtops.length)));
}

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
