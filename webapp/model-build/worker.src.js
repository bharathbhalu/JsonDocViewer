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
  if (f && f.exact) base.push('exact');
  if (f && (f.op === 'fillet' || f.op === 'chamfer')) base.push(f.at, f.r);
  if (f && f.op === 'length') base.push(f.scope, f.at, f.dir, f.delta, f.round ? 1 : 0, f.factor, f.loops);
  return JSON.stringify(base);
}
function bodyStamp(obj) {
  return JSON.stringify({
    k: obj.kernel, t: obj.type, s: obj.size, pr: obj.profiles, h: obj.height, parts: obj.parts,
    ...(obj.type === 'cut' ? { cut: obj.cut === 'split' ? 'split' : 'delete' } : {}),
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
  // A split piece is the solid itself. Its features, if any, are applied on top.
  if (obj.type === 'solid') return 'solid\n' + (obj.features || []).map(featStamp).join('\n');
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

function circum2(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-8) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}
// Arcs that trace one full circle are stored as several pieces. Rebuilding
// those pieces and then closing the wire inserts a straight line in the curve.
function asCircle(edges) {
  if (edges.length === 1 && edges[0].k === 'circle') {
    const e = edges[0];
    return { c: [+e.c[0] || 0, +e.c[1] || 0], r: Math.max(0.05, +e.r || 0.05) };
  }
  if (!edges.length || edges.some((e) => e.k !== 'arc' || !e.a || !e.b || !e.mid)) return null;
  const first = circum2(edges[0].a, edges[0].mid, edges[0].b);
  if (!first || first.r < 0.05) return null;
  let sweep = 0;
  for (const e of edges) {
    const hit = circum2(e.a, e.mid, e.b);
    if (!hit || Math.hypot(hit.c[0] - first.c[0], hit.c[1] - first.c[1]) > 0.05 || Math.abs(hit.r - first.r) > 0.05) return null;
    const ang = (p) => Math.atan2(p[1] - first.c[1], p[0] - first.c[0]);
    let turn = ang(e.b) - ang(e.a);
    let via = ang(e.mid) - ang(e.a);
    while (turn <= -Math.PI) turn += Math.PI * 2;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (via <= -Math.PI) via += Math.PI * 2;
    while (via > Math.PI) via -= Math.PI * 2;
    if (turn * via < 0) turn += turn > 0 ? -Math.PI * 2 : Math.PI * 2;
    sweep += Math.abs(turn);
  }
  const start = edges[0].a;
  const end = edges[edges.length - 1].b;
  if (Math.hypot(start[0] - end[0], start[1] - end[1]) > 0.05 || sweep < Math.PI * 1.5) return null;
  return { c: first.c, r: first.r };
}
function penWire(edges) {
  const circ = asCircle(edges);
  if (circ) return replicad.drawCircle(circ.r).translate(circ.c[0], circ.c[1]);
  const start = edges[0] && (edges[0].a || edges[0].c);
  if (!start) throw new Error('This outline does not close.');
  const last = edges[edges.length - 1];
  const end = (last && last.b) || start;
  if (Math.hypot((+end[0] || 0) - +start[0], (+end[1] || 0) - +start[1]) > 0.05) {
    throw new Error('This outline does not close.');
  }
  let pen = replicad.draw([+start[0], +start[1]]);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const tip = i === edges.length - 1 ? start : e.b;
    if (e.k === 'arc') pen = pen.threePointsArcTo([+tip[0], +tip[1]], [+e.mid[0], +e.mid[1]]);
    else if (e.k === 'line') pen = pen.lineTo([+tip[0], +tip[1]]);
    else throw new Error('This outline cannot be extruded exactly.');
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

// The viewer turns a body with Three.js Euler order ZYX. That matrix is
// Rz * Ry * Rx, so the solid turns about X, then Y, then Z, then moves.
function placeShape(shape, pos, rot) {
  let s = shape;
  const r = rot || [0, 0, 0];
  if (r[0]) { const n = s.rotate(r[0], [0, 0, 0], [1, 0, 0]); if (n !== s) del(s); s = n; }
  if (r[1]) { const n = s.rotate(r[1], [0, 0, 0], [0, 1, 0]); if (n !== s) del(s); s = n; }
  if (r[2]) { const n = s.rotate(r[2], [0, 0, 0], [0, 0, 1]); if (n !== s) del(s); s = n; }
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
// A diagonal scale, including a different length on each axis. Planes and
// cylinders stay exact. A trimmed spline from a boolean is refit. The viewer
// stretches the local solid before it turns, so the boolean has to as well.
function axisScale(sx, sy, sz) {
  const g = new OC.gp_GTrsf();
  const m = [[sx, 0, 0, 0], [0, sy, 0, 0], [0, 0, sz, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) g.SetValue(r + 1, c + 1, m[r][c]);
  g.SetForm();
  return g;
}
function mapPoint(g, pnt) {
  const moved = g.Transforms(pnt.X(), pnt.Y(), pnt.Z());
  return new OC.gp_Pnt(moved.theX, moved.theY, moved.theZ);
}
function scaleEdge(edge, g) {
  const got = OC.BRep_Tool.Curve(edge.wrapped);
  const trimmed = new OC.Geom_TrimmedCurve(got.returnValue, got.First, got.Last, true, true);
  const round = edge.geomType === 'CIRCLE' || edge.geomType === 'ELLIPSE';
  const bs = round
    ? OC.GeomConvert.CurveToBSplineCurve(trimmed, OC.Convert_ParameterisationType.Convert_TgtThetaOver2)
    : OC.GeomConvert.CurveToBSplineCurve(trimmed);
  for (let i = 1; i <= bs.NbPoles(); i++) bs.SetPole(i, mapPoint(g, bs.Pole(i)));
  const maker = new OC.BRepBuilderAPI_MakeEdge(bs);
  if (!maker.IsDone()) throw new Error('That scale could not be applied.');
  const built = maker.Edge();
  maker.delete();
  return built;
}
function edgeEnds(edge) {
  const got = OC.BRep_Tool.Curve(edge);
  const curve = got.returnValue;
  const rev = edge.Orientation() === OC.TopAbs_Orientation.TopAbs_REVERSED;
  const to = (p) => [p.X(), p.Y(), p.Z()];
  const a = to(curve.Value(got.First));
  const b = to(curve.Value(got.Last));
  return rev ? [b, a] : [a, b];
}
function pointsMeet(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5;
}
function scaleWire(wire, g, cache) {
  const oriented = [];
  for (const edge of wire.edges) {
    let scaled = null;
    for (const item of cache) {
      if (item.src.IsSame(edge.wrapped)) { scaled = item.out; break; }
    }
    if (!scaled) {
      scaled = scaleEdge(edge, g);
      cache.push({ src: edge.wrapped, out: scaled });
    }
    const rev = edge.wrapped.Orientation() === OC.TopAbs_Orientation.TopAbs_REVERSED;
    oriented.push(rev ? OC.TopoDS.Edge(scaled.Oriented(OC.TopAbs_Orientation.TopAbs_REVERSED)) : scaled);
  }
  const used = new Array(oriented.length).fill(false);
  const order = [];
  if (oriented.length) {
    used[0] = true;
    order.push(oriented[0]);
    let tip = edgeEnds(oriented[0])[1];
    for (let n = 1; n < oriented.length; n++) {
      let found = -1;
      let nextTip = tip;
      for (let i = 0; i < oriented.length; i++) {
        if (used[i]) continue;
        const [a, b] = edgeEnds(oriented[i]);
        if (pointsMeet(a, tip)) { found = i; nextTip = b; break; }
        if (pointsMeet(b, tip)) { found = i; nextTip = a; break; }
      }
      if (found < 0) break;
      used[found] = true;
      order.push(oriented[found]);
      tip = nextTip;
    }
  }
  if (order.length !== oriented.length) throw new Error('That scale could not be applied.');
  const maker = new OC.BRepBuilderAPI_MakeWire();
  for (const edge of order) maker.Add(edge);
  if (!maker.IsDone()) throw new Error('That scale could not be applied.');
  const built = maker.Wire();
  maker.delete();
  return built;
}
function fitSurface(face, g) {
  const uv = OC.BRepTools.UVBounds(face.wrapped);
  const surf = OC.BRep_Tool.Surface(face.wrapped);
  const n = 21;
  const pts = new OC.NCollection_Array2_gp_Pnt(1, n, 1, n);
  for (let i = 0; i < n; i++) {
    const u = uv.UMin + (uv.UMax - uv.UMin) * i / (n - 1);
    for (let j = 0; j < n; j++) {
      const v = uv.VMin + (uv.VMax - uv.VMin) * j / (n - 1);
      pts.SetValue(i + 1, j + 1, mapPoint(g, surf.EvalD0(u, v)));
    }
  }
  const fit = new OC.GeomAPI_PointsToBSplineSurface(pts, 3, 8, OC.GeomAbs_Shape.GeomAbs_C2, 1e-4);
  if (!fit.IsDone()) throw new Error('That scale could not be applied.');
  return fit.Surface();
}
function affineScale(shape, sx, sy, sz) {
  const g = axisScale(sx, sy, sz);
  const cache = [];
  const sewing = new OC.BRepBuilderAPI_Sewing(1e-4);
  try {
    for (const face of shape.faces) {
      const kind = face.geomType;
      const outerTopo = OC.BRepTools.OuterWire(face.wrapped);
      const wires = face.wires;
      const outerWire = wires.find((w) => w.wrapped.IsSame(outerTopo)) || wires[0];
      const holes = wires.filter((w) => w !== outerWire);
      const rounds = outerWire.edges.filter((e) => e.geomType === 'CIRCLE' || e.geomType === 'ELLIPSE');
      let built = null;
      if (kind === 'PLANE') {
        const maker = new OC.BRepBuilderAPI_MakeFace(scaleWire(outerWire, g, cache), true);
        if (!maker.IsDone()) throw new Error('That scale could not be applied.');
        built = maker.Face();
        maker.delete();
        for (const inner of holes) {
          const add = new OC.BRepBuilderAPI_MakeFace(built, scaleWire(inner, g, cache));
          if (!add.IsDone()) throw new Error('That scale could not be applied.');
          built = add.Face();
          add.delete();
        }
      } else if ((kind === 'CYLINDRE' || kind === 'CYLINDER') && rounds.length === 2 && !holes.length) {
        const loft = new OC.BRepOffsetAPI_ThruSections(false, true, 1e-7);
        for (const edge of rounds) loft.AddWire(scaleWire({ edges: [edge] }, g, cache));
        loft.Build();
        if (!loft.IsDone()) throw new Error('That scale could not be applied.');
        built = replicad.cast(loft.Shape()).faces[0].wrapped;
        loft.delete();
      } else {
        const fixer = new OC.ShapeFix_Face();
        fixer.SetPrecision(1e-4);
        fixer.Init(fitSurface(face, g), 1e-4, true);
        fixer.Add(scaleWire(outerWire, g, cache));
        for (const inner of holes) fixer.Add(scaleWire(inner, g, cache));
        fixer.Perform();
        built = OC.TopoDS.Face(fixer.Result());
        fixer.delete();
      }
      sewing.Add(built);
    }
    sewing.Perform();
    if (sewing.NbFreeEdges()) throw new Error('That scale could not be applied.');
    const sewed = replicad.cast(sewing.SewedShape());
    const type = sewed.wrapped.ShapeType();
    const shells = type === OC.TopAbs_ShapeEnum.TopAbs_SHELL || type === OC.TopAbs_ShapeEnum.TopAbs_SOLID
      ? [sewed]
      : Array.from(replicad.iterTopo(sewed.wrapped, 'shell'), (shell) => replicad.cast(shell));
    const solids = shells.map((shell) => {
      if (shell.wrapped.ShapeType() === OC.TopAbs_ShapeEnum.TopAbs_SOLID) return shell;
      const maker = new OC.BRepBuilderAPI_MakeSolid(OC.TopoDS.Shell(shell.wrapped));
      maker.Build();
      if (!maker.IsDone()) throw new Error('That scale could not be applied.');
      const solid = replicad.cast(maker.Shape());
      maker.delete();
      return solid;
    });
    if (!solids.length) throw new Error('That scale could not be applied.');
    if (solids.length === 1) return solids[0];
    return replicad.compoundShapes(solids);
  } finally {
    g.delete();
    sewing.delete();
  }
}
// Mirror across the named plane through the origin, then scale. A different
// scale on each axis is applied to the solid, so the body the boolean cuts is
// the body on screen.
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
  const mag = [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];
  if (nonUniform(s)) {
    const n = affineScale(out, mag[0], mag[1], mag[2]);
    if (n !== out) del(out);
    out = n;
  } else if (Math.abs(mag[0] - 1) > 1e-6) {
    const n = out.scale(mag[0], [0, 0, 0]);
    if (n !== out) del(out);
    out = n;
  }
  return out;
}
function bodyLocal(obj, notes) {
  return applyPushes(baseShape(obj, notes), obj.features, notes || []);
}
function partShape(p) {
  return placeShape(scaleShape(bodyLocal(p), p.scale), p.pos, p.rot);
}
// The tool as it sits inside the target. The target keeps its own solid.
// Scaling the finished solid to reach the screen, then scaling it back, drops
// faces on a joined body.
function toolInTarget(tool, target) {
  return unplaceShape(partShape(tool), target.pos, target.rot, target.scale);
}
// Inverse of scaleShape then placeShape. The boolean runs where the bodies
// sit on screen. The mesh handed back is the target's own local solid, so
// the viewer can keep that body's position instead of shifting it.
function unscaleShape(shape, scale) {
  const s = scaleVec(scale);
  let out = shape;
  const mag = [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];
  if (nonUniform(s)) {
    const n = affineScale(out, 1 / mag[0], 1 / mag[1], 1 / mag[2]);
    if (n !== out) del(out);
    out = n;
  } else if (Math.abs(mag[0] - 1) > 1e-6) {
    const n = out.scale(1 / mag[0], [0, 0, 0]);
    if (n !== out) del(out);
    out = n;
  }
  const flip = (plane) => {
    const n = out.mirror(plane, [0, 0, 0]);
    if (n !== out) del(out);
    out = n;
  };
  if (s[2] < 0) flip('XY');
  if (s[1] < 0) flip('XZ');
  if (s[0] < 0) flip('YZ');
  return out;
}
function unplaceShape(shape, pos, rot, scale) {
  let s = shape;
  const p = pos || [0, 0, 0];
  if (p[0] || p[1] || p[2]) {
    const n = s.translate([-p[0], -p[1], -p[2]]);
    if (n !== s) del(s);
    s = n;
  }
  const r = rot || [0, 0, 0];
  if (r[2]) { const n = s.rotate(-r[2], [0, 0, 0], [0, 0, 1]); if (n !== s) del(s); s = n; }
  if (r[1]) { const n = s.rotate(-r[1], [0, 0, 0], [0, 1, 0]); if (n !== s) del(s); s = n; }
  if (r[0]) { const n = s.rotate(-r[0], [0, 0, 0], [1, 0, 0]); if (n !== s) del(s); s = n; }
  return unscaleShape(s, scale);
}
function splitBySolid(target, tool) {
  const argumentsList = new OC.NCollection_List_TopoDS_Shape();
  const toolsList = new OC.NCollection_List_TopoDS_Shape();
  const splitter = new OC.BRepAlgoAPI_Splitter();
  try {
    argumentsList.Append(target.wrapped);
    toolsList.Append(tool.wrapped);
    splitter.SetNonDestructive(true);
    splitter.SetArguments(argumentsList);
    splitter.SetTools(toolsList);
    splitter.Build();
    if (splitter.HasErrors() || !splitter.IsDone()) throw new Error('That body does not split the other.');
    const raw = splitter.Shape();
    if (!raw || raw.IsNull()) throw new Error('That body does not split the other.');
    const out = replicad.cast(raw);
    const vol = Math.abs(replicad.measureVolume(out));
    if (!(vol > 1e-6)) throw new Error('That body does not split the other.');
    return out;
  } finally {
    argumentsList.delete();
    toolsList.delete();
    splitter.delete();
  }
}
function countFaces(shape) {
  let n = 0;
  for (const f of shape.faces) { n++; del(f); }
  return n;
}
function baseShape(obj, notes) {
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
  if (obj.type === 'cut') {
    const parts = obj.parts || [];
    if (parts.length < 2) throw new Error('Choose the body that cuts and the body that is cut.');
    if (parts.some((p) => p.kernel === 'mesh' || p.type === 'mesh')) throw new Error('A mesh cannot cut an exact body.');
    const target = bodyLocal(parts[0]);
    const tool = toolInTarget(parts[1], parts[0]);
    const beforeVol = Math.abs(replicad.measureVolume(target));
    const beforeFaces = obj.cut === 'split' ? countFaces(target) : 0;
    let cut = null;
    try {
      cut = obj.cut === 'split' ? splitBySolid(target, tool) : target.cut(tool);
      const vol = Math.abs(replicad.measureVolume(cut));
      if (!(vol > 1e-6)) throw new Error(obj.cut === 'split' ? 'That body does not split the other.' : 'That cut would erase the body.');
      if (notes && obj.cut === 'split' && countFaces(cut) <= beforeFaces) notes.push('That body does not split the other.');
      else if (notes && obj.cut !== 'split' && Math.abs(vol - beforeVol) < 0.5) notes.push('Those bodies do not overlap.');
      return cut;
    } finally {
      del(tool);
      if (cut !== target) del(target);
    }
  }
  if (obj.type === 'sketch') return sketchShape(obj);
  if (obj.type === 'solid') {
    if (!obj.brep) throw new Error('This solid has no shape.');
    return replicad.deserializeShape(obj.brep);
  }
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
// A sampled circle or arc is a polygon. Cutting with it leaves the real curve
// behind as stray edges. Only a face made of corners may use this outline.
function sampledCurve(loop) {
  if (!loop || loop.length < 8) return false;
  let mild = 0;
  let turns = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i + loop.length - 1) % loop.length];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = (b[2] || 0) - (a[2] || 0);
    const vx = c[0] - b[0], vy = c[1] - b[1], vz = (c[2] || 0) - (b[2] || 0);
    const l1 = Math.hypot(ux, uy, uz), l2 = Math.hypot(vx, vy, vz);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const dot = (ux * vx + uy * vy + uz * vz) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    turns++;
    if (ang < Math.PI / 9) mild++;
  }
  return turns > 0 && mild > turns * 0.5;
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
function edgeShape(shape, feature) {
  const r = Math.abs(+feature.r || 0);
  if (!(r >= 0.05)) throw new Error('That edge could not be changed.');
  const at = feature.at || [0, 0, 0];
  const pick = (finder) => finder.near(at, 0.5);
  const next = feature.op === 'chamfer' ? shape.chamfer(r, pick) : shape.fillet(r, pick);
  const vol = Math.abs(replicad.measureVolume(next));
  if (!(vol > 1e-6)) {
    del(next);
    throw new Error('That edge could not be changed.');
  }
  return next;
}
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add3(a, dir, s) { return [a[0] + dir[0] * s, a[1] + dir[1] * s, a[2] + dir[2] * s]; }
function near3(a, b, tol) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < (tol || 0.25); }
function distToSeg(p, a, b) {
  const ab = sub3(b, a);
  const l2 = dot3(ab, ab) || 1;
  let t = dot3(sub3(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = add3(a, ab, t);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
function straightEdges(shape) {
  const out = [];
  for (const edge of shape.edges) {
    try {
      const a = xyz(edge.startPoint);
      const b = xyz(edge.endPoint);
      const mid = xyz(edge.pointAt(0.5));
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, mz = (a[2] + b[2]) / 2;
      if (chord > 0.2 && Math.hypot(mid[0] - mx, mid[1] - my, mid[2] - mz) <= Math.max(0.05, chord * 0.01)) {
        out.push({ a, b, mid });
      }
    } catch (e) { /* a curve is not a length edge */ }
    del(edge);
  }
  return out;
}
function edgeLen(e) { return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]); }
function findCap(shape, point, dir) {
  let best = null;
  let bestD = 0.3;
  for (const f of shape.faces) {
    try {
      if (f.geomType !== 'PLANE') { del(f); continue; }
      const n = unit(f.normalAt());
      if (Math.abs(dot3(n, dir)) < 0.98) { del(f); continue; }
      const c = xyz(f.center);
      const d = Math.abs(dot3(sub3(point, c), n));
      if (d < bestD) {
        if (best) del(best);
        best = f;
        bestD = d;
        continue;
      }
    } catch (e) { /* this face is not a cap */ }
    del(f);
  }
  return best;
}
function moveCap(shape, point, outward, delta) {
  const face = findCap(shape, point, outward);
  if (!face) throw new Error('That edge could not be changed.');
  const tool = extrudeFace(face, { normal: outward, dist: delta });
  const next = delta >= 0 ? shape.fuse(tool) : shape.cut(tool);
  del(tool);
  const vol = Math.abs(replicad.measureVolume(next));
  if (!(vol > 1e-6)) {
    del(next);
    throw new Error('That length would erase the body.');
  }
  return next;
}
function polyWire(pts) {
  const wire = new OC.BRepBuilderAPI_MakeWire();
  try {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ea = new OC.gp_Pnt(a[0], a[1], a[2]);
      const eb = new OC.gp_Pnt(b[0], b[1], b[2]);
      const edge = new OC.BRepBuilderAPI_MakeEdge(ea, eb);
      wire.Add(edge.Edge());
      edge.delete();
      ea.delete();
      eb.delete();
    }
    if (!wire.IsDone()) throw new Error('That edge could not be changed.');
    return wire.Wire();
  } finally {
    wire.delete();
  }
}
function triFace(a, b, c) {
  const wire = polyWire([a, b, c]);
  const maker = new OC.BRepBuilderAPI_MakeFace(wire, true);
  try {
    if (!maker.IsDone()) throw new Error('That edge could not be changed.');
    return maker.Face();
  } finally {
    maker.delete();
  }
}
// The corner between the old end and the new end. Fusing it lengthens one
// edge. Cutting it shortens that edge. The other parallel edges stay.
function tetShape(a, b, c, d) {
  const sewing = new OC.BRepBuilderAPI_Sewing(1e-5);
  try {
    sewing.Add(triFace(a, c, b));
    sewing.Add(triFace(a, b, d));
    sewing.Add(triFace(a, d, c));
    sewing.Add(triFace(b, c, d));
    sewing.Perform();
    if (sewing.NbFreeEdges()) throw new Error('That edge could not be changed.');
    const sewed = replicad.cast(sewing.SewedShape());
    const shell = sewed.wrapped.ShapeType() === OC.TopAbs_ShapeEnum.TopAbs_SHELL
      ? sewed.wrapped
      : Array.from(replicad.iterTopo(sewed.wrapped, 'shell'))[0];
    const maker = new OC.BRepBuilderAPI_MakeSolid(OC.TopoDS.Shell(shell));
    maker.Build();
    if (!maker.IsDone()) throw new Error('That edge could not be changed.');
    const solid = replicad.cast(maker.Shape());
    maker.delete();
    return solid;
  } finally {
    sewing.delete();
  }
}
function neighborsOf(lines, point) {
  const out = [];
  for (const e of lines) {
    const hit = near3(e.a, point, 0.25) ? e.b : (near3(e.b, point, 0.25) ? e.a : null);
    if (hit && !out.some((p) => near3(p, hit, 0.25))) out.push(hit);
  }
  return out;
}
function moveEdgeEnd(shape, edge, dir, delta, lines) {
  const far = dot3(edge.a, dir) >= dot3(edge.b, dir) ? edge.a : edge.b;
  const stay = far === edge.a ? edge.b : edge.a;
  const outward = unit(sub3(far, stay));
  const reach = edgeLen(edge);
  if (delta < 0 && Math.abs(delta) > reach - 0.15) throw new Error('That length would erase the edge.');
  const moved = add3(far, outward, delta);
  const sides = neighborsOf(lines, far).filter((p) => !near3(p, stay, 0.25));
  if (sides.length !== 2) throw new Error('That edge could not be changed.');
  const before = Math.abs(replicad.measureVolume(shape));
  const apply = (a, b) => {
    const tet = tetShape(far, moved, a, b);
    const next = delta >= 0 ? shape.fuse(tet) : shape.cut(tet);
    del(tet);
    return next;
  };
  // The two side vertices can be wound either way. The winding that changes
  // the volume in the asked direction is the one that sits on the body.
  let next = apply(sides[0], sides[1]);
  let vol = Math.abs(replicad.measureVolume(next));
  const rightWay = delta >= 0 ? vol > before + 0.05 : vol < before - 0.05;
  if (!rightWay) {
    del(next);
    next = apply(sides[1], sides[0]);
    vol = Math.abs(replicad.measureVolume(next));
  }
  if (!(vol > 1e-6) || (delta >= 0 ? vol < before + 0.05 : vol > before - 0.05)) {
    del(next);
    throw new Error('That edge could not be changed.');
  }
  return next;
}
function applyEdgeLength(shape, feature) {
  const dir = unit(feature.dir || [1, 0, 0]);
  const at = xyz(feature.at || [0, 0, 0]);
  const delta = +feature.delta || 0;
  if (Math.abs(delta) < 0.05) return shape;
  const lines = straightEdges(shape);
  const parallel = lines.filter((e) => Math.abs(dot3(unit(sub3(e.b, e.a)), dir)) > 0.98);
  let picked = null;
  let best = Infinity;
  for (const e of parallel) {
    const d = distToSeg(at, e.a, e.b);
    if (d < best) { best = d; picked = e; }
  }
  if (!picked || best > 1.5) throw new Error('That edge could not be changed.');
  if (feature.scope === 'edge') return moveEdgeEnd(shape, picked, dir, delta, lines);
  // The far end of this direction. Every parallel edge that meets it changes
  // by the same amount. An edge that stops on an earlier face stays.
  let far = null;
  let farDot = -Infinity;
  for (const edge of parallel) {
    for (const p of [edge.a, edge.b]) {
      const d = dot3(p, dir);
      if (d > farDot) { farDot = d; far = p; }
    }
  }
  return moveCap(shape, far, dir, delta);
}
function loopPrism(pts, axis, t0, t1) {
  const n = unit(axis);
  const base = dot3(pts[0], n);
  const flat = pts.map((p) => {
    const drop = dot3(p, n) - base;
    return [p[0] - n[0] * drop, p[1] - n[1] * drop, p[2] - n[2] * drop];
  });
  const kept = [];
  for (const q of flat) {
    if (kept.some((prev) => near3(prev, q, 0.05))) continue;
    kept.push(q);
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const q of kept) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); }
  const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  let major = null;
  let majorR = 0;
  for (const q of kept) {
    const d = sub3(q, c);
    const r = Math.hypot(d[0], d[1], d[2]);
    if (r > majorR) { majorR = r; major = d; }
  }
  if (!(majorR > 0.05) || !major) throw new Error('That edge could not be changed.');
  const x = unit(major);
  const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  let minorR = 0;
  for (const p of pts) minorR = Math.max(minorR, Math.abs(dot3(sub3(p, c), y)));
  if (!(minorR > 0.05)) throw new Error('That edge could not be changed.');
  let xDir = x;
  let a = majorR;
  let b = minorR;
  if (b > a) { const swap = a; a = b; b = swap; xDir = unit(y); }
  const pen = replicad.drawEllipse(a, b);
  const plane = new replicad.Plane(c, xDir, n);
  const sketch = pen.sketchOnPlane(plane);
  const height = Math.max(0.2, t1 - t0);
  const solid = sketch.extrude(height, { extrusionDirection: n });
  const moved = solid.translate([n[0] * t0, n[1] * t0, n[2] * t0]);
  if (moved !== solid) del(solid);
  plane.delete();
  return moved;
}
function scaleLoop(pts, factor) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  return pts.map((p) => [c[0] + (p[0] - c[0]) * factor, c[1] + (p[1] - c[1]) * factor, c[2] + (p[2] - c[2]) * factor]);
}
function nugget(p) {
  const s = 0.4;
  const box = replicad.makeBaseBox(s, s, s);
  const moved = box.translate([p[0], p[1], p[2] - s / 2]);
  if (moved !== box) del(box);
  return moved;
}
function materialAt(shape, p) {
  const bit = nugget(p);
  let hit = null;
  try {
    hit = shape.intersect(bit);
    return Math.abs(replicad.measureVolume(hit)) > 0.002;
  } catch (e) {
    return false;
  } finally {
    del(bit);
    if (hit) del(hit);
  }
}
function probe(center, sample, axis, t, radial) {
  const o = add3(center, axis, t);
  return [
    o[0] + (sample[0] - center[0]) * radial,
    o[1] + (sample[1] - center[1]) * radial,
    o[2] + (sample[2] - center[2]) * radial,
  ];
}
function holeSpan(shape, pts, axis) {
  const c = [0, 1, 2].map((i) => pts.reduce((sum, p) => sum + p[i], 0) / pts.length);
  const n = unit(axis);
  const sample = pts[0];
  const box = shape.boundingBox;
  const [lo, hi] = box.bounds;
  box.delete();
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [(i & 1) ? hi[0] : lo[0], (i & 2) ? hi[1] : lo[1], (i & 4) ? hi[2] : lo[2]];
    const t = dot3(sub3(p, c), n);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const holeAt = (t) => !materialAt(shape, probe(c, sample, n, t, 0.45)) && materialAt(shape, probe(c, sample, n, t, 1.35));
  const bossAt = (t) => materialAt(shape, probe(c, sample, n, t, 0.45)) && !materialAt(shape, probe(c, sample, n, t, 1.35));
  const walk = (test) => {
    let a = 0;
    let b = 0;
    let hit = false;
    for (let t = 0.6; t <= tMax + 0.4; t += 1) {
      if (!test(t)) break;
      b = t;
      hit = true;
      if (t + 1 > tMax + 0.4) b = tMax;
    }
    for (let t = -0.6; t >= tMin - 0.4; t -= 1) {
      if (!test(t)) break;
      a = t;
      hit = true;
      if (t - 1 < tMin - 0.4) a = tMin;
    }
    return hit ? [a - 0.4, b + 0.4] : null;
  };
  const hole = walk(holeAt);
  if (hole) return { kind: 'hole', span: hole };
  const boss = walk(bossAt);
  if (boss) return { kind: 'boss', span: boss };
  return { kind: 'hole', span: [tMin - 0.4, tMax + 0.4] };
}
function applyOneRound(shape, pts, axis, factor) {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-3) return shape;
  const found = holeSpan(shape, pts, axis);
  const span = found.span;
  const older = loopPrism(pts, axis, span[0], span[1]);
  const newer = loopPrism(scaleLoop(pts, factor), axis, span[0], span[1]);
  let next = null;
  try {
    if (found.kind === 'hole') {
      if (factor > 1) next = shape.cut(newer);
      else {
        const ring = older.cut(newer);
        next = shape.fuse(ring);
        del(ring);
      }
    } else if (factor > 1) next = shape.fuse(newer);
    else {
      const ring = older.cut(newer);
      next = shape.cut(ring);
      del(ring);
    }
  } finally {
    del(older);
    del(newer);
  }
  const vol = next && Math.abs(replicad.measureVolume(next));
  if (!next || !(vol > 1e-6)) {
    if (next) del(next);
    throw new Error('That edge could not be changed.');
  }
  return next;
}
function applyRoundLength(shape, feature) {
  const axis = unit(feature.dir || [0, 0, 1]);
  const factor = +feature.factor || 1;
  const loops = feature.scope === 'edge' ? (feature.loops || []).slice(0, 1) : (feature.loops || []);
  let s = shape;
  for (const loop of loops) {
    if (!loop || loop.length < 8) continue;
    const next = applyOneRound(s, loop.map(xyz), axis, factor);
    if (next !== s) del(s);
    s = next;
  }
  return s;
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
    if (f && f.op === 'length') {
      try {
        const next = f.round ? applyRoundLength(s, f) : applyEdgeLength(s, f);
        if (next !== s) del(s);
        s = next;
      } catch (e) {
        log.push((e && e.message) || 'That edge could not be changed.');
      }
      continue;
    }
    if (f && (f.op === 'fillet' || f.op === 'chamfer')) {
      try {
        const next = edgeShape(s, f);
        if (next !== s) del(s);
        s = next;
      } catch (e) {
        log.push((e && e.message) || 'That edge could not be changed.');
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
      if (!tool && (f.exact || sampledCurve(f.loop))) {
        log.push('That curve was not extruded, because a polyline would leave a gap.');
        continue;
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
function edgeSamples(edge, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    try { pts.push(xyz(edge.pointAt(i / n))); }
    catch (e) { return null; }
  }
  return pts.length === n + 1 ? pts : null;
}
function chordOff(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const ab = [b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (len2 < 1e-12) return Infinity;
  let worst = 0;
  for (const p of pts) {
    const ap = [p[0] - a[0], p[1] - a[1], (p[2] || 0) - (a[2] || 0)];
    const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2;
    const dx = ap[0] - ab[0] * t, dy = ap[1] - ab[1] * t, dz = ap[2] - ab[2] * t;
    worst = Math.max(worst, Math.hypot(dx, dy, dz));
  }
  return worst;
}
function circum3(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)];
  const ac = [c[0] - a[0], c[1] - a[1], (c[2] || 0) - (a[2] || 0)];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const n2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (n2 < 1e-10) return null;
  const ab2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ac2 = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
  const nab = [n[1] * ab[2] - n[2] * ab[1], n[2] * ab[0] - n[0] * ab[2], n[0] * ab[1] - n[1] * ab[0]];
  const nac = [n[1] * ac[2] - n[2] * ac[1], n[2] * ac[0] - n[0] * ac[2], n[0] * ac[1] - n[1] * ac[0]];
  const center = [0, 1, 2].map((i) => a[i] + (ac2 * nab[i] - ab2 * nac[i]) / (2 * n2));
  const r = Math.hypot(a[0] - center[0], a[1] - center[1], (a[2] || 0) - center[2]);
  const nl = Math.sqrt(n2);
  return r > 1e-4 ? { c: center, r, n: [n[0] / nl, n[1] / nl, n[2] / nl] } : null;
}
// A diagonal scale stores a straight edge or a circle as a spline. The
// dimension is still the line or the circle.
function circleFit(pts, a, b) {
  const p1 = pts[Math.floor(pts.length * 0.25)];
  const p2 = pts[Math.floor(pts.length * 0.5)];
  const p3 = pts[Math.floor(pts.length * 0.75)];
  const hit = p1 && p2 && p3 ? circum3(p1, p2, p3) : null;
  if (!hit) return null;
  const tol = Math.max(1e-3, hit.r * 1e-3);
  for (const p of pts) {
    const d = Math.hypot(p[0] - hit.c[0], p[1] - hit.c[1], (p[2] || 0) - hit.c[2]);
    if (Math.abs(d - hit.r) > tol) return null;
  }
  if (nearPt(a, b)) return { k: 'circle', c: hit.c, r: hit.r, n: hit.n };
  return { k: 'arc', a, b, mid: pts[Math.floor(pts.length / 2)] };
}
function exactEdge(edge) {
  const a = xyz(edge.startPoint);
  const b = xyz(edge.endPoint);
  if (edge.geomType === 'LINE') return { k: 'line', a, b };
  if (edge.geomType === 'CIRCLE' && OC) {
    let ad = null;
    try {
      ad = new OC.BRepAdaptor_Curve(edge.wrapped);
      const circ = ad.Circle();
      const loc = circ.Location();
      const c = [loc.X(), loc.Y(), loc.Z()];
      const r = circ.Radius();
      let n = null;
      try {
        const ax = circ.Axis();
        const dir = ax.Direction();
        n = [dir.X(), dir.Y(), dir.Z()];
        dir.delete();
        ax.delete();
      } catch (err) { n = null; }
      const closed = !!(edge.isClosed || nearPt(a, b));
      const mid = xyz(edge.pointAt(0.5));
      loc.delete();
      circ.delete();
      return closed ? { k: 'circle', c, r, ...(n ? { n } : {}) } : { k: 'arc', a, b, mid };
    } catch (e) {
      return null;
    } finally {
      if (ad) ad.delete();
    }
  }
  const pts = edgeSamples(edge, 16);
  if (!pts) return null;
  const span = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1], (pts[pts.length - 1][2] || 0) - (pts[0][2] || 0));
  let leave = 0;
  for (const p of pts) leave = Math.max(leave, Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1], (p[2] || 0) - (pts[0][2] || 0)));
  if (span < 1e-4 && leave < 1e-3) return { k: 'skip' };
  if (span > 1e-4 && chordOff(pts) <= 1e-3) return { k: 'line', a, b };
  const round = circleFit(pts, a, b);
  if (round) return round;
  // A cut can leave a curve that is not a line or a circle. It is still an edge.
  let len = 0;
  try { len = Math.abs(edge.length); } catch (e) { len = 0; }
  if (!(len > 0.05)) {
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], (pts[i][2] || 0) - (pts[i - 1][2] || 0));
    }
  }
  if (!(len > 0.05)) return { k: 'skip' };
  let mid = pts[Math.floor(pts.length / 2)];
  try { mid = xyz(edge.pointAt(0.5)); } catch (e) { /* the sample is on the curve */ }
  return { k: 'curve', a, b, mid, pts, len };
}
function flipExact(e) {
  if (e.k === 'line') return { k: 'line', a: e.b, b: e.a };
  if (e.k === 'arc') return { k: 'arc', a: e.b, b: e.a, mid: e.mid };
  return e;
}
// A complete wire can be copied as a sketch. Edges that are lines, circles,
// or arcs are still measured when the wire also contains a free curve.
function readExact(wire) {
  const edges = wire.edges;
  const raw = [];
  let ordered = true;
  try {
    for (const e of edges) {
      const ex = exactEdge(e);
      if (!ex) { ordered = false; continue; }
      if (ex.k === 'skip') continue;
      if (ex.k === 'curve') ordered = false;
      raw.push(ex);
    }
  } finally {
    edges.forEach((e) => del(e));
  }
  if (!raw.length) return null;
  const listed = () => ({ edges: raw.map(roundExact), ordered: false });
  if (!ordered) return listed();
  if (raw.length === 1) return { edges: raw.map(roundExact), ordered: true };
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
    if (found < 0) return listed();
    used[found] = true;
    const e = flip ? flipExact(raw[found]) : raw[found];
    out.push(e);
    tip = e.b;
  }
  return out.length === raw.length ? { edges: out.map(roundExact), ordered: true } : listed();
}
function roundExact(e) {
  const p = (v) => v.map(rnd);
  if (e.k === 'circle') return { k: 'circle', c: p(e.c), r: rnd(e.r), ...(e.n ? { n: p(e.n) } : {}) };
  if (e.k === 'arc') return { k: 'arc', a: p(e.a), b: p(e.b), mid: p(e.mid) };
  if (e.k === 'curve') return { k: 'curve', a: p(e.a), b: p(e.b), mid: p(e.mid), pts: (e.pts || []).map(p), len: rnd(e.len) };
  return { k: 'line', a: p(e.a), b: p(e.b) };
}
// Outer wire first, then each hole. outerWire() and innerWires() delete the
// face they are called on, so the wires are read from the face without that.
function outlineOf(face) {
  if (!OC) return { exact: null, loop: [], measures: null };
  const wires = face.wires;
  if (face.geomType !== 'PLANE') {
    try {
      const reads = wires.map(readExact);
      const measures = reads.flatMap((r) => (r && r.edges) || []);
      wires.forEach((w) => del(w));
      return { exact: null, loop: [], measures: measures.length ? measures : null };
    } catch (e) {
      wires.forEach((w) => del(w));
      return { exact: null, loop: [], measures: null };
    }
  }
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
      return { exact: null, loop: [], measures: null };
    }
    const reads = [outer, ...holes].map(readExact);
    const exact = reads.every((r) => r && r.ordered) ? reads.map((r) => ({ edges: r.edges })) : null;
    const measures = exact ? null : reads.flatMap((r) => (r && r.edges) || []);
    const loop = faceLoop(outer);
    del(outer);
    holes.forEach((w) => del(w));
    return { exact, loop, measures: measures && measures.length ? measures : null };
  } catch (e) {
    wires.forEach((w) => del(w));
    return { exact: null, loop: [], measures: null };
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
      try {
        const n = xyz(f.normalAt());
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len > 1e-8) normal = [n[0] / len, n[1] / len, n[2] / len];
      } catch (e) { /* a face can still be clicked from its triangles */ }
      const tri = f.triangulation();
      const outline = outlineOf(f);
      const face = { center: c.map(rnd), normal: normal.map(rnd) };
      if (outline.exact) face.exact = outline.exact;
      if (outline.measures && outline.measures.length) face.measures = outline.measures;
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
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    let x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
    let x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
    v[i] = x3 + (pos ? pos[0] : 0);
    v[i + 1] = y3 + (pos ? pos[1] : 0);
    v[i + 2] = z2 + (pos ? pos[2] : 0);
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

function packSolid(shape) {
  const mesh = meshOf(shape);
  const faces = collectFaces(shape);
  let brep = '';
  try { brep = shape.serialize(); } catch (e) { brep = ''; }
  const out = {
    vertices: mesh.vertices,
    triangles: mesh.triangles,
    faces,
    brep,
    brepHash: fnv('solid\n'),
    kernel: 'brep',
  };
  if (mesh.normals) out.normals = mesh.normals;
  if (mesh.edges) out.edges = mesh.edges;
  return out;
}
// Split keeps every piece of the target. Each piece is its own solid, in the
// target's frame, so the bodies can be moved apart.
function buildSplit(obj) {
  const notes = [];
  const parts = obj.parts || [];
  if (parts.length < 2) return { id: obj.id, error: 'Choose the body that cuts and the body that is cut.' };
  if (parts.some((p) => p.kernel === 'mesh' || p.type === 'mesh')) return { id: obj.id, error: 'A mesh cannot cut an exact body.' };
  const target = bodyLocal(parts[0]);
  const tool = toolInTarget(parts[1], parts[0]);
  let world = null;
  try {
    world = splitBySolid(target, tool);
    const clones = [];
    for (const s of world.solids || []) {
      if (Math.abs(replicad.measureVolume(s)) > 1e-4) clones.push(s.clone());
    }
    if (clones.length < 2) {
      notes.push('That body does not split the other.');
      const packed = packSolid(world);
      return Object.assign({ id: obj.id, notes }, packed);
    }
    const pieces = clones.map((s) => {
      const packed = packSolid(s);
      del(s);
      return packed;
    });
    const first = pieces[0];
    return {
      id: obj.id,
      vertices: first.vertices,
      triangles: first.triangles,
      faces: first.faces,
      normals: first.normals,
      edges: first.edges,
      brep: first.brep,
      brepHash: first.brepHash,
      kernel: 'brep',
      notes,
      pieces: pieces.map((p, i) => (i === 0 ? { brep: p.brep, brepHash: p.brepHash } : p)),
    };
  } finally {
    del(tool);
    if (world !== target) del(target);
  }
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
    // A split piece's saved solid is the uncut base. Features are applied on
    // that base, so a finished solid must not be read back as the base.
    const replay = obj.type === 'solid' && (obj.features || []).length;
    if (!replay && obj.brep && obj.brepHash === fnv(key)) {
      try { shape = replicad.deserializeShape(obj.brep); }
      catch (e) { shape = null; notes.push('Saved solid could not be read, so the body was rebuilt.'); }
    }
    if (!shape) {
      shape = applyPushes(baseShape(obj, notes), feats, notes);
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
      try { bodies.push(obj.type === 'cut' && obj.cut === 'split' ? buildSplit(obj) : buildOne(obj)); }
      catch (e) { bodies.push({ id: obj.id, error: String((e && e.message) || e) }); }
    }
    const transfer = [];
    const take = (b) => {
      if (!b) return;
      if (b.vertices) transfer.push(b.vertices.buffer);
      if (b.triangles) transfer.push(b.triangles.buffer);
      if (b.normals) transfer.push(b.normals.buffer);
      if (b.edges) transfer.push(b.edges.buffer);
    };
    for (const b of bodies) {
      take(b);
      for (const p of b.pieces || []) take(p);
    }
    self.postMessage({ type: 'result', id: msg.id, bodies }, transfer);
  } catch (e) {
    self.postMessage({ type: 'result', id: msg.id, error: String((e && e.message) || e) });
  }
};
