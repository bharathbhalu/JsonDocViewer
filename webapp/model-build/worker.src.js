/* 3D Model worker. Separate from cad-build/worker.src.js.
   OpenCascade builds each exact body on its own: a primitive, a sketch
   extrude, then that body's own face pushes. Bodies are never unioned
   just to draw. Join is an explicit body. Manifold is only for a body
   that is already a mesh, and for a join that includes one. */
import opencascade from 'replicad-opencascadejs';
import * as replicad from 'replicad';
import ManifoldModule from 'manifold-3d';

const OC_WASM = new URL('./replicad_single.wasm', import.meta.url).href;
const MF_WASM = new URL('./manifold.wasm', import.meta.url).href;
const Q = { tolerance: 0.05, angularTolerance: 0.2 };
let MF = null;
let OC = null;

const ready = Promise.all([
  opencascade({ locateFile: () => OC_WASM }),
  ManifoldModule({ locateFile: () => MF_WASM }),
]).then(([oc, mf]) => {
  replicad.setOC(oc);
  OC = oc;
  mf.setup();
  MF = mf;
});

ready.then(
  () => self.postMessage({ type: 'ready' }),
  (e) => self.postMessage({ type: 'init-error', message: String((e && e.message) || e) })
);

const del = (s) => { try { if (s && s.delete) s.delete(); } catch (e) { /* already released */ } };
// The last exact solid for each body. A new push is applied to that solid.
// Replaying every past push on every edit is what made one extrusion take as
// long as opening the file.
const shapeCache = new Map();
function featStamp(f) {
  const base = [f && f.op, f && f.dist, f && f.normal, f && f.center, f && f.loop];
  if (f && f.op === 'split') base.push(f.origin);
  if (f && f.op === 'imprint') base.push(f.cuts);
  return JSON.stringify(base);
}
function bodyStamp(obj) {
  return JSON.stringify({
    k: obj.kernel, t: obj.type, s: obj.size, pr: obj.profiles, h: obj.height, parts: obj.parts,
  });
}
function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
function shapeKey(obj) {
  // join2: a part's face pushes belong to that part's own frame. Older saved
  // joins applied those pushes after the part was moved, which sliced it up.
  const rev = obj.type === 'join' ? 'join2\n' : '';
  return rev + bodyStamp(obj) + '\n' + (obj.features || []).map(featStamp).join('\n');
}
function dropShape(id) {
  const hit = shapeCache.get(id);
  if (!hit) return;
  del(hit.shape);
  shapeCache.delete(id);
}
const xyz = (v) => Array.isArray(v) ? v : [v.x, v.y, v.z];
const rnd = (x) => Math.round(x * 1000) / 1000;

function penWire(edges) {
  if (edges.length === 1 && edges[0].k === 'circle') {
    const e = edges[0];
    return replicad.drawCircle(Math.max(0.05, +e.r || 0.05)).translate(+e.c[0] || 0, +e.c[1] || 0);
  }
  let pen = replicad.draw(edges[0].a);
  for (const e of edges) {
    if (e.k === 'arc') pen = pen.threePointsArcTo(e.b, e.mid);
    else pen = pen.lineTo(e.b);
  }
  return pen.close();
}
function profileDrawing(p) {
  if (p.k === 'path') return null;
  if (p.k === 'exact') {
    const wires = p.wires || [];
    if (!wires.length || !(wires[0].edges || []).length) throw new Error('This face sketch has no outline.');
    let drawing = penWire(wires[0].edges);
    for (let i = 1; i < wires.length; i++) {
      if ((wires[i].edges || []).length) drawing = drawing.cut(penWire(wires[i].edges));
    }
    return drawing;
  }
  if (p.k === 'circle') return replicad.drawCircle(Math.max(0.05, +p.r || 5)).translate(+p.x || 0, +p.y || 0);
  if (p.k === 'poly') {
    const pts = p.pts || [];
    let pen = replicad.draw([+pts[0][0], +pts[0][1]]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo([+pts[i][0], +pts[i][1]]);
    return pen.close();
  }
  return replicad.drawRectangle(Math.max(0.05, +p.w || 10), Math.max(0.05, +p.h || 10)).translate(+p.x || 0, +p.y || 0);
}

function primitive(obj) {
  const d = obj.size || {};
  if (obj.type === 'cylinder') return replicad.makeCylinder(Math.max(0.05, (+d.d || 24) / 2), Math.max(0.1, +d.z || 24));
  if (obj.type === 'sphere') {
    const r = Math.max(0.05, (+d.d || 24) / 2);
    return replicad.makeSphere(r).translate([0, 0, r]);
  }
  return replicad.makeBaseBox(Math.max(0.1, +d.x || 40), Math.max(0.1, +d.y || 30), Math.max(0.1, +d.z || 20));
}

function sketchShape(obj) {
  const profs = obj.profiles || [];
  if (!profs.length) throw new Error('This sketch is empty.');
  let drawing = null;
  for (const p of profs) {
    if (p.k === 'path') continue;
    const d = profileDrawing(p);
    if (!d) continue;
    drawing = drawing ? drawing.fuse(d) : d;
  }
  if (!drawing) throw new Error('Draw a closed shape to extrude.');
  const depth = Math.max(0.001, Math.abs(+obj.height || 1));
  return drawing.sketchOnPlane('XY').extrude((+obj.height || 1) < 0 ? -depth : depth);
}

// The viewer's rotation order is Z, then Y, then X, then the move.
function placeShape(shape, pos, rot) {
  let s = shape;
  const r = rot || [0, 0, 0];
  if (r[2]) { const n = s.rotate(r[2], [0, 0, 0], [0, 0, 1]); if (n !== s) del(s); s = n; }
  if (r[1]) { const n = s.rotate(r[1], [0, 0, 0], [0, 1, 0]); if (n !== s) del(s); s = n; }
  if (r[0]) { const n = s.rotate(r[0], [0, 0, 0], [1, 0, 0]); if (n !== s) del(s); s = n; }
  const p = pos || [0, 0, 0];
  if (p[0] || p[1] || p[2]) { const n = s.translate(p); if (n !== s) del(s); s = n; }
  return s;
}

function scaleVec(scale) {
  const s = scale || [1, 1, 1];
  return [0, 1, 2].map((i) => {
    const v = Number(s[i]);
    return Number.isFinite(v) && Math.abs(v) >= 0.05 ? v : (v < 0 ? -1 : 1);
  });
}
function nonUniform(scale) {
  const s = scaleVec(scale).map(Math.abs);
  return Math.abs(s[0] - s[1]) > 1e-6 || Math.abs(s[1] - s[2]) > 1e-6;
}
// Mirror across the named plane through the origin, then one scale for every
// axis. A different scale on each axis cannot stay an exact solid here, so
// the caller meshes that part instead.
function scaleShape(shape, scale) {
  const s = scaleVec(scale);
  let out = shape;
  const flip = (plane) => {
    const n = out.mirror(plane, [0, 0, 0]);
    if (n !== out) del(out);
    out = n;
  };
  if (s[0] < 0) flip('YZ');
  if (s[1] < 0) flip('XZ');
  if (s[2] < 0) flip('XY');
  const mag = Math.abs(s[0]);
  if (!nonUniform(s) && Math.abs(mag - 1) > 1e-6) {
    const n = out.scale(mag, [0, 0, 0]);
    if (n !== out) del(out);
    out = n;
  }
  return out;
}
function partShape(p) {
  const cut = applyPushes(baseShape(p), p.features, []);
  return placeShape(scaleShape(cut, p.scale), p.pos, p.rot);
}
function baseShape(obj) {
  if (obj.type === 'join') {
    let acc = null;
    for (const p of obj.parts || []) {
      if (p.kernel === 'mesh' || p.type === 'mesh') continue;
      const s = partShape(p);
      if (!acc) acc = s;
      else {
        const n = acc.fuse(s);
        del(s); del(acc); acc = n;
      }
    }
    if (!acc) throw new Error('Nothing exact to join.');
    return acc;
  }
  if (obj.type === 'sketch') return sketchShape(obj);
  return primitive(obj);
}

// A prism that starts 0.02 mm inside the solid so the boolean actually bites.
// The outline is the face loop, with no extra pad.
function unit(v) {
  const n = xyz(v);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}
function loopCenter(loop) {
  const c = [0, 0, 0];
  for (const p of loop) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return c.map((v) => v / loop.length);
}
// The stored outline is only how the face was picked. A circle sampled into
// line segments would extrude as a polygon, so the prism is the real face.
function takeFace(shape, feature) {
  const wantN = unit(feature.normal);
  const wantC = feature.center ? xyz(feature.center) : loopCenter(feature.loop);
  let best = null;
  let bestD = 0.75;
  for (const f of shape.faces) {
    try {
      if (f.geomType !== 'PLANE') { del(f); continue; }
      const c = xyz(f.center);
      const n = unit(f.normalAt());
      const align = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2];
      const d = Math.hypot(c[0] - wantC[0], c[1] - wantC[1], c[2] - wantC[2]);
      if (align > 0.98 && d < bestD) {
        if (best) del(best);
        best = f;
        bestD = d;
        continue;
      }
    } catch (e) { /* this face is not usable */ }
    del(f);
  }
  return best;
}
function extrudeFace(face, feature) {
  const n = unit(feature.normal);
  const depth = Math.abs(+feature.dist || 0);
  const eps = 0.02;
  const start = (+feature.dist || 0) >= 0 ? -eps : -depth;
  const moved = face.clone().translate([n[0] * start, n[1] * start, n[2] * start]);
  del(face);
  const vec = new replicad.Vector(n).multiply(depth + eps);
  try { return replicad.basicFaceExtrusion(moved, vec); }
  finally { del(moved); del(vec); }
}
function pushTool(f) {
  const loop = f.loop;
  const n = xyz(f.normal);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const nz = [n[0] / len, n[1] / len, n[2] / len];
  const depth = Math.abs(+f.dist || 0);
  const eps = 0.02;
  const start = (+f.dist || 0) >= 0 ? -eps : -depth;
  const ax = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = [ax[1] * nz[2] - ax[2] * nz[1], ax[2] * nz[0] - ax[0] * nz[2], ax[0] * nz[1] - ax[1] * nz[0]];
  const xl = Math.hypot(x[0], x[1], x[2]) || 1;
  const xd = [x[0] / xl, x[1] / xl, x[2] / xl];
  const yd = [nz[1] * xd[2] - nz[2] * xd[1], nz[2] * xd[0] - nz[0] * xd[2], nz[0] * xd[1] - nz[1] * xd[0]];
  const o = loop[0];
  const flat = loop.map((p) => {
    const d0 = p[0] - o[0], d1 = p[1] - o[1], d2 = p[2] - o[2];
    return [d0 * xd[0] + d1 * xd[1] + d2 * xd[2], d0 * yd[0] + d1 * yd[1] + d2 * yd[2]];
  });
  let pen = replicad.draw(flat[0]);
  for (let i = 1; i < flat.length; i++) pen = pen.lineTo(flat[i]);
  pen = pen.close();
  const origin = [o[0] + nz[0] * start, o[1] + nz[1] * start, o[2] + nz[2] * start];
  return pen.sketchOnPlane(new replicad.Plane(origin, xd, nz)).extrude(depth + eps);
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
// The plane cuts the solid. Both pieces stay in this one body, so a face the
// plane crosses becomes two faces and nothing is thrown away.
function splitShape(shape, origin, normal) {
  const n = unit(normal);
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = unit(cross(ref, n));
  const plane = new replicad.Plane(origin || [0, 0, 0], x, n);
  const tool = replicad.drawRectangle(1e4, 1e4).sketchOnPlane(plane).face();
  const argumentsList = new OC.NCollection_List_TopoDS_Shape();
  const toolsList = new OC.NCollection_List_TopoDS_Shape();
  const splitter = new OC.BRepAlgoAPI_Splitter();
  try {
    argumentsList.Append(shape.wrapped);
    toolsList.Append(tool.wrapped);
    splitter.SetNonDestructive(true);
    splitter.SetArguments(argumentsList);
    splitter.SetTools(toolsList);
    splitter.Build();
    if (splitter.HasErrors() || !splitter.IsDone()) throw new Error('This plane does not cut the body.');
    const raw = splitter.Shape();
    if (!raw || raw.IsNull()) throw new Error('This plane does not cut the body.');
    const out = replicad.cast(raw);
    const vol = Math.abs(replicad.measureVolume(out));
    if (!(vol > 1e-6)) throw new Error('This plane does not cut the body.');
    return out;
  } finally {
    del(tool);
    plane.delete();
    argumentsList.delete();
    toolsList.delete();
    splitter.delete();
  }
}
// How many planar faces point the same way. Used to tell a real partition
// from a curve that never reached the other side of the face.
function alignedFaces(shape, normal) {
  const want = unit(normal);
  let n = 0;
  for (const f of shape.faces) {
    try {
      if (f.geomType === 'PLANE') {
        const a = unit(f.normalAt());
        if (a[0] * want[0] + a[1] * want[1] + a[2] * want[2] > 0.98) n++;
      }
    } catch (e) { /* this face is not usable */ }
    del(f);
  }
  return n;
}
// One cutting sheet: the sketch curve, moved just outside the face, swept
// through the solid. A face tool splits the face without adding a sliver.
function cutSheet(p, q, normal, keep) {
  const n = unit(normal);
  const pad = 1;
  const a = [p[0] + n[0] * pad, p[1] + n[1] * pad, p[2] + n[2] * pad];
  const b = [q[0] + n[0] * pad, q[1] + n[1] * pad, q[2] + n[2] * pad];
  if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-4) return null;
  const p1 = new OC.gp_Pnt(a[0], a[1], a[2]);
  const p2 = new OC.gp_Pnt(b[0], b[1], b[2]);
  const maker = new OC.BRepBuilderAPI_MakeEdge(p1, p2);
  const vec = new OC.gp_Vec(-n[0] * 1e4, -n[1] * 1e4, -n[2] * 1e4);
  const prism = new OC.BRepPrimAPI_MakePrism(maker.Edge(), vec, false, true);
  prism.Build();
  keep.push(p1, p2, maker, vec, prism);
  const tool = prism.Shape();
  return tool && !tool.IsNull() ? tool : null;
}
function circleSheet(center, radius, normal, keep) {
  const n = unit(normal);
  const pad = 1;
  const c = [center[0] + n[0] * pad, center[1] + n[1] * pad, center[2] + n[2] * pad];
  const pnt = new OC.gp_Pnt(c[0], c[1], c[2]);
  const dir = new OC.gp_Dir(n[0], n[1], n[2]);
  const ax = new OC.gp_Ax2(pnt, dir);
  const circ = new OC.gp_Circ(ax, Math.max(0.05, +radius || 0.05));
  const maker = new OC.BRepBuilderAPI_MakeEdge(circ);
  const vec = new OC.gp_Vec(-n[0] * 1e4, -n[1] * 1e4, -n[2] * 1e4);
  const prism = new OC.BRepPrimAPI_MakePrism(maker.Edge(), vec, false, true);
  prism.Build();
  keep.push(pnt, dir, ax, circ, maker, vec, prism);
  const tool = prism.Shape();
  return tool && !tool.IsNull() ? tool : null;
}
// The sketch curves are pressed into the face. The solid stays one body, and
// each region the curves close off becomes its own face.
function imprintShape(shape, feature) {
  const normal = feature.normal || [0, 0, 1];
  const keep = [];
  const tools = [];
  const argumentsList = new OC.NCollection_List_TopoDS_Shape();
  const toolsList = new OC.NCollection_List_TopoDS_Shape();
  const splitter = new OC.BRepAlgoAPI_Splitter();
  try {
    for (const cut of feature.cuts || []) {
      if (cut && cut.k === 'circle' && cut.c) {
        const tool = circleSheet(cut.c, cut.r, normal, keep);
        if (tool) tools.push(tool);
        continue;
      }
      const pts = (cut && cut.pts) || [];
      for (let i = 1; i < pts.length; i++) {
        const tool = cutSheet(pts[i - 1], pts[i], normal, keep);
        if (tool) tools.push(tool);
      }
      if (cut && cut.closed && pts.length > 2) {
        const tool = cutSheet(pts[pts.length - 1], pts[0], normal, keep);
        if (tool) tools.push(tool);
      }
    }
    if (!tools.length) throw new Error('That sketch does not split the face.');
    const before = alignedFaces(shape, normal);
    argumentsList.Append(shape.wrapped);
    for (const tool of tools) toolsList.Append(tool);
    splitter.SetNonDestructive(true);
    splitter.SetArguments(argumentsList);
    splitter.SetTools(toolsList);
    splitter.Build();
    if (splitter.HasErrors() || !splitter.IsDone()) throw new Error('That sketch does not split the face.');
    const raw = splitter.Shape();
    if (!raw || raw.IsNull()) throw new Error('That sketch does not split the face.');
    const out = replicad.cast(raw);
    const vol = Math.abs(replicad.measureVolume(out));
    if (!(vol > 1e-6) || alignedFaces(out, normal) <= before) {
      del(out);
      throw new Error('That sketch does not split the face.');
    }
    return out;
  } finally {
    keep.forEach(del);
    argumentsList.delete();
    toolsList.delete();
    splitter.delete();
  }
}
function applyPushes(shape, features, notes) {
  const log = notes || [];
  let s = shape;
  for (const f of features || []) {
    if (f && f.op === 'imprint') {
      try {
        const next = imprintShape(s, f);
        if (next !== s) del(s);
        s = next;
      } catch (e) {
        log.push((e && e.message) || 'That sketch does not split the face.');
      }
      continue;
    }
    if (f && f.op === 'split') {
      try {
        const next = splitShape(s, f.origin, f.normal);
        if (next !== s) del(s);
        s = next;
      } catch (e) {
        log.push((e && e.message) || 'This plane does not cut the body.');
      }
      continue;
    }
    if (!f || f.op !== 'push' || Math.abs(+f.dist || 0) < 0.05) continue;
    let tool = null;
    try {
      const matched = takeFace(s, f);
      if (matched) {
        try { tool = extrudeFace(matched, f); }
        catch (e) { log.push('Exact face push failed (' + ((e && e.message) || e) + ').'); }
      }
      if (!tool) tool = pushTool(f);
      const next = (+f.dist || 0) >= 0 ? s.fuse(tool) : s.cut(tool);
      const vol = Math.abs(replicad.measureVolume(next));
      if (!(vol > 1e-6)) {
        log.push('A push of ' + f.dist + ' mm was skipped because it would erase the body.');
        if (next !== s) del(next);
        continue;
      }
      if (next !== s) del(s);
      s = next;
    } catch (e) {
      log.push('A push of ' + f.dist + ' mm was skipped (' + ((e && e.message) || e) + ').');
    } finally {
      del(tool);
    }
  }
  return s;
}

function meshOf(shape) {
  const f = shape.mesh(Q);
  const normals = f.normals && f.normals.length === f.vertices.length ? new Float32Array(f.normals) : null;
  let edges = null;
  try {
    const lines = shape.meshEdges(Q).lines;
    if (lines && lines.length >= 6) edges = new Float32Array(lines);
  } catch (e) { /* the view can fall back to triangle edges */ }
  return { vertices: new Float32Array(f.vertices), triangles: new Uint32Array(f.triangles), normals, edges };
}

function nearPt(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3;
}
// Edge explorers do not walk a wire in order, and a line only contributes its
// start. On a cube side that repeats one corner and drops another, so the
// outline becomes a triangle. Chain each edge onto the loose end instead.
function faceLoop(wire) {
  const edges = wire.edges;
  const ends = edges.map((e) => ({ e, a: xyz(e.pointAt(0)), b: xyz(e.pointAt(1)) }));
  const walk = (firstForward) => {
    const used = new Array(ends.length).fill(false);
    const order = [];
    if (!ends.length) return order;
    used[0] = true;
    order.push({ i: 0, forward: firstForward });
    let tip = firstForward ? ends[0].b : ends[0].a;
    for (let n = 1; n < ends.length; n++) {
      let found = -1;
      let forward = true;
      for (let i = 0; i < ends.length; i++) {
        if (used[i]) continue;
        if (nearPt(ends[i].a, tip)) { found = i; forward = true; break; }
        if (nearPt(ends[i].b, tip)) { found = i; forward = false; break; }
      }
      if (found < 0) break;
      used[found] = true;
      order.push({ i: found, forward });
      tip = forward ? ends[found].b : ends[found].a;
    }
    return order;
  };
  let order = walk(true);
  if (order.length < ends.length) {
    const back = walk(false);
    if (back.length > order.length) order = back;
  }
  const loop = [];
  for (const step of order) {
    const e = ends[step.i].e;
    const steps = e.geomType === 'LINE' ? 1 : 64;
    for (let s = 0; s < steps; s++) {
      const t = step.forward ? s / steps : 1 - s / steps;
      const p = xyz(e.pointAt(t)).map(rnd);
      const prev = loop[loop.length - 1];
      if (prev && nearPt(prev, p)) continue;
      loop.push(p);
    }
  }
  if (loop.length > 1 && nearPt(loop[0], loop[loop.length - 1])) loop.pop();
  ends.forEach((item) => del(item.e));
  return loop;
}
// The face outline kept as lines, circles, and arcs. A sampled polyline
// extrudes smaller than the face and leaves gaps.
function exactEdge(edge) {
  const a = xyz(edge.startPoint);
  const b = xyz(edge.endPoint);
  if (edge.geomType === 'LINE') return { k: 'line', a, b };
  if (edge.geomType !== 'CIRCLE' || !OC) return null;
  let ad = null;
  try {
    ad = new OC.BRepAdaptor_Curve(edge.wrapped);
    const circ = ad.Circle();
    const loc = circ.Location();
    const c = [loc.X(), loc.Y(), loc.Z()];
    const r = circ.Radius();
    const closed = !!(edge.isClosed || nearPt(a, b));
    const mid = xyz(edge.pointAt(0.5));
    loc.delete();
    circ.delete();
    return closed ? { k: 'circle', c, r } : { k: 'arc', a, b, mid };
  } catch (e) {
    return null;
  } finally {
    if (ad) ad.delete();
  }
}
function flipExact(e) {
  if (e.k === 'line') return { k: 'line', a: e.b, b: e.a };
  if (e.k === 'arc') return { k: 'arc', a: e.b, b: e.a, mid: e.mid };
  return e;
}
function orderExact(wire) {
  const edges = wire.edges;
  const raw = [];
  try {
    for (const e of edges) {
      const ex = exactEdge(e);
      if (!ex) return null;
      raw.push(ex);
    }
  } finally {
    edges.forEach((e) => del(e));
  }
  if (!raw.length) return null;
  if (raw.length === 1) return raw;
  const used = new Array(raw.length).fill(false);
  used[0] = true;
  const out = [raw[0]];
  let tip = raw[0].b;
  for (let n = 1; n < raw.length; n++) {
    let found = -1;
    let flip = false;
    for (let i = 0; i < raw.length; i++) {
      if (used[i] || raw[i].k === 'circle') continue;
      if (nearPt(raw[i].a, tip)) { found = i; flip = false; break; }
      if (nearPt(raw[i].b, tip)) { found = i; flip = true; break; }
    }
    if (found < 0) return null;
    used[found] = true;
    const e = flip ? flipExact(raw[found]) : raw[found];
    out.push(e);
    tip = e.b;
  }
  return out.length === raw.length ? out : null;
}
function roundExact(e) {
  const p = (v) => v.map(rnd);
  if (e.k === 'circle') return { k: 'circle', c: p(e.c), r: rnd(e.r) };
  if (e.k === 'arc') return { k: 'arc', a: p(e.a), b: p(e.b), mid: p(e.mid) };
  return { k: 'line', a: p(e.a), b: p(e.b) };
}
// Outer wire first, then each hole. outerWire() and innerWires() delete the
// face they are called on, so the wires are read from the face without that.
function outlineOf(face) {
  if (face.geomType !== 'PLANE' || !OC) return { exact: null, loop: [] };
  const wires = face.wires;
  let outerH = null;
  try {
    outerH = OC.BRepTools.OuterWire(face.wrapped);
    let outer = null;
    const holes = [];
    for (const w of wires) {
      if (!outer && w.wrapped.IsSame(outerH)) outer = w;
      else holes.push(w);
    }
    if (!outer) {
      wires.forEach((w) => del(w));
      return { exact: null, loop: [] };
    }
    let exact = null;
    const ordered = orderExact(outer);
    if (ordered) {
      exact = [{ edges: ordered.map(roundExact) }];
      for (const hole of holes) {
        const hw = orderExact(hole);
        if (!hw) { exact = null; break; }
        exact.push({ edges: hw.map(roundExact) });
      }
    }
    const loop = faceLoop(outer);
    del(outer);
    holes.forEach((w) => del(w));
    return { exact, loop };
  } catch (e) {
    wires.forEach((w) => del(w));
    return { exact: null, loop: [] };
  } finally {
    if (outerH) outerH.delete();
  }
}
// Every face the solid has, including the wall of a hole and a face that
// itself has a hole. The triangles are the clickable surface. A loop is kept
// only for a flat face, because that is what a push extrudes.
function collectFaces(shape) {
  const faces = [];
  for (const f of shape.faces) {
    try {
      const c = xyz(f.center);
      let normal = [0, 0, 1];
      try { normal = xyz(f.normalAt()); } catch (e) { /* a face can still be clicked from its triangles */ }
      const tri = f.triangulation();
      const outline = outlineOf(f);
      const face = { center: c.map(rnd), normal: normal.map(rnd) };
      if (outline.exact) face.exact = outline.exact;
      const loop = outline.loop;
      if (loop.length >= 3) face.loop = loop;
      if (tri && tri.vertices && tri.vertices.length >= 9 && tri.trianglesIndexes && tri.trianglesIndexes.length >= 3) {
        face.surface = { vertices: tri.vertices, triangles: tri.trianglesIndexes };
        if (tri.verticesNormals && tri.verticesNormals.length === tri.vertices.length) face.surface.normals = tri.verticesNormals;
      }
      if (face.loop || face.surface) faces.push(face);
    } catch (e) { /* skip a face the kernel will not outline */ }
    del(f);
  }
  return faces;
}

function weldMesh(mesh) {
  const map = new Map();
  const verts = [];
  const tris = [];
  const v = mesh.vertices;
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const ids = [];
    for (let k = 0; k < 3; k++) {
      const p = t[i + k] * 3;
      const key = Math.round(v[p] * 1000) + ',' + Math.round(v[p + 1] * 1000) + ',' + Math.round(v[p + 2] * 1000);
      let id = map.get(key);
      if (id == null) {
        id = verts.length / 3;
        map.set(key, id);
        verts.push(v[p], v[p + 1], v[p + 2]);
      }
      ids.push(id);
    }
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[2] !== ids[0]) tris.push(ids[0], ids[1], ids[2]);
  }
  return { vertices: new Float32Array(verts), triangles: new Uint32Array(tris) };
}
function toManifold(mesh) {
  const welded = weldMesh(mesh);
  const man = new MF.Mesh({ numProp: 3, vertProperties: welded.vertices, triVerts: welded.triangles });
  return new MF.Manifold(man);
}
function fromManifold(man) {
  const m = man.getMesh();
  const np = m.numProp || 3;
  let v = m.vertProperties;
  if (np !== 3) {
    const o = new Float32Array((v.length / np) * 3);
    for (let i = 0, j = 0; i < v.length; i += np, j += 3) { o[j] = v[i]; o[j + 1] = v[i + 1]; o[j + 2] = v[i + 2]; }
    v = o;
  }
  return { vertices: new Float32Array(v), triangles: new Uint32Array(m.triVerts) };
}
function transformMesh(mesh, pos, rot, scale) {
  const v = new Float32Array(mesh.vertices);
  const sc = scaleVec(scale);
  const rz = (rot && rot[2] || 0) * Math.PI / 180, ry = (rot && rot[1] || 0) * Math.PI / 180, rx = (rot && rot[0] || 0) * Math.PI / 180;
  const cz = Math.cos(rz), sz = Math.sin(rz), cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  for (let i = 0; i < v.length; i += 3) {
    let x = v[i] * sc[0], y = v[i + 1] * sc[1], z = v[i + 2] * sc[2];
    let x1 = x * cz - y * sz, y1 = x * sz + y * cz;
    let x2 = x1 * cy + z * sy, z2 = -x1 * sy + z * cy;
    let y3 = y1 * cx - z2 * sx, z3 = y1 * sx + z2 * cx;
    v[i] = x2 + (pos ? pos[0] : 0);
    v[i + 1] = y3 + (pos ? pos[1] : 0);
    v[i + 2] = z3 + (pos ? pos[2] : 0);
  }
  return { vertices: v, triangles: mesh.triangles };
}

function partMesh(p) {
  if (p.kernel === 'mesh' || p.type === 'mesh') {
    if (!p.mesh) throw new Error('This mesh body has no triangles.');
    return transformMesh(p.mesh, p.pos, p.rot, p.scale);
  }
  if (nonUniform(p.scale)) {
    const local = applyPushes(baseShape(p), p.features, []);
    try { return transformMesh(meshOf(local), p.pos, p.rot, p.scale); }
    finally { del(local); }
  }
  const s = partShape(p);
  try { return meshOf(s); }
  finally { del(s); }
}

function buildOne(obj) {
  if ((obj.kernel === 'mesh' || obj.type === 'mesh') && obj.type !== 'join') {
    if (!obj.mesh) return { id: obj.id, error: 'This mesh body has no triangles.' };
    return {
      id: obj.id,
      vertices: new Float32Array(obj.mesh.vertices),
      triangles: new Uint32Array(obj.mesh.triangles),
      kernel: 'mesh',
      faces: [],
    };
  }
  if (obj.type === 'join' && (obj.kernel === 'mesh' || (obj.parts || []).some((p) => p.kernel === 'mesh' || p.type === 'mesh' || nonUniform(p.scale)))) {
    const mans = (obj.parts || []).map((p) => toManifold(partMesh(p)));
    let u = null;
    try {
      u = mans.length === 1 ? mans[0] : MF.Manifold.union(mans);
      const mesh = fromManifold(u);
      return { id: obj.id, vertices: mesh.vertices, triangles: mesh.triangles, kernel: 'mesh', faces: [] };
    } finally {
      mans.forEach((m) => { if (m !== u) del(m); });
      del(u);
    }
  }
  const notes = [];
  const stamp = bodyStamp(obj);
  const feats = obj.features || [];
  const stamps = feats.map(featStamp);
  const hit = shapeCache.get(obj.id);
  const extend = hit && hit.stamp === stamp && hit.stamps.length <= stamps.length
    && hit.stamps.every((s, i) => s === stamps[i]);
  let shape;
  let made = false;
  if (extend) {
    const added = feats.slice(hit.stamps.length);
    if (added.length) { shape = applyPushes(hit.shape, added, notes); made = true; }
    else shape = hit.shape;
  } else {
    dropShape(obj.id);
    const key = shapeKey(obj);
    if (obj.brep && obj.brepHash === fnv(key)) {
      try { shape = replicad.deserializeShape(obj.brep); }
      catch (e) { shape = null; notes.push('Saved solid could not be read, so the body was rebuilt.'); }
    }
    if (!shape) {
      shape = applyPushes(baseShape(obj), feats, notes);
      made = true;
    }
  }
  shapeCache.set(obj.id, { stamp, stamps, shape });
  try {
    const mesh = meshOf(shape);
    const faces = collectFaces(shape);
    const out = { id: obj.id, vertices: mesh.vertices, triangles: mesh.triangles, kernel: 'brep', faces, notes };
    if (mesh.normals) out.normals = mesh.normals;
    if (mesh.edges) out.edges = mesh.edges;
    if (made) {
      try { out.brep = shape.serialize(); out.brepHash = fnv(shapeKey(obj)); }
      catch (e) { /* the mesh still draws; the next open rebuilds this body */ }
    }
    return out;
  } catch (e) {
    dropShape(obj.id);
    throw e;
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'drop') {
    if (Array.isArray(msg.alive)) {
      const keep = new Set(msg.alive);
      for (const id of shapeCache.keys()) if (!keep.has(id)) dropShape(id);
    }
    return;
  }
  if (msg.type !== 'build') return;
  try {
    await ready;
    if (Array.isArray(msg.alive)) {
      const keep = new Set(msg.alive);
      for (const id of shapeCache.keys()) if (!keep.has(id)) dropShape(id);
    }
    const bodies = [];
    for (const obj of msg.objects || []) {
      try { bodies.push(buildOne(obj)); }
      catch (e) { bodies.push({ id: obj.id, error: String((e && e.message) || e) }); }
    }
    const transfer = [];
    for (const b of bodies) {
      if (b.vertices) transfer.push(b.vertices.buffer);
      if (b.triangles) transfer.push(b.triangles.buffer);
      if (b.normals) transfer.push(b.normals.buffer);
      if (b.edges) transfer.push(b.edges.buffer);
    }
    self.postMessage({ type: 'result', id: msg.id, bodies }, transfer);
  } catch (e) {
    self.postMessage({ type: 'result', id: msg.id, error: String((e && e.message) || e) });
  }
};
