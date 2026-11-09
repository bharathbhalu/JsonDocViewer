/* 3D Model document. Separate from the older 3D design (public/cad).
   Each body keeps its own shape. A face push lives on that body, in that
   body's frame. Join is a body that owns the bodies it fused. Nothing is
   fused just to draw. Works in the browser and in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ModelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);
  const uid = (p) => (p || 'b') + Math.random().toString(36).slice(2, 9);
  const n = (v, d, lo, hi) => {
    let x = Number(v);
    if (!Number.isFinite(x)) x = d;
    if (lo != null) x = Math.max(lo, x);
    if (hi != null) x = Math.min(hi, x);
    return Math.round(x * 1000) / 1000;
  };
  const vec = (v, d) => [0, 1, 2].map((i) => n(Array.isArray(v) ? v[i] : (d ? d[i] : 0), d ? d[i] : 0, -1e5, 1e5));
  const TYPES = ['box', 'cylinder', 'sphere', 'sketch', 'join', 'cut', 'solid', 'mesh'];
  const DEFAULT_SIZE = {
    box: { x: 40, y: 30, z: 20 },
    cylinder: { d: 24, z: 24 },
    sphere: { d: 24 },
  };

  function normSize(type, s) {
    const d = DEFAULT_SIZE[type];
    if (!d) return undefined;
    const o = s && typeof s === 'object' ? s : {};
    const out = {};
    for (const k of Object.keys(d)) out[k] = n(o[k], d[k], 0.1, 10000);
    return out;
  }

  function v2(v) {
    return [n(v && v[0], 0, -1e5, 1e5), n(v && v[1], 0, -1e5, 1e5)];
  }
  function normExactEdge2(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.k === 'circle') return { k: 'circle', c: v2(e.c), r: n(e.r, 1, 0.05, 1e5) };
    if (e.k === 'arc') return { k: 'arc', a: v2(e.a), b: v2(e.b), mid: v2(e.mid) };
    if (e.k === 'line') return { k: 'line', a: v2(e.a), b: v2(e.b) };
    return null;
  }
  function normExactWires2(list) {
    return (Array.isArray(list) ? list : []).slice(0, 40).map((w) => {
      const edges = (w && Array.isArray(w.edges) ? w.edges : []).slice(0, 400).map(normExactEdge2).filter(Boolean);
      return edges.length ? { edges } : null;
    }).filter(Boolean);
  }
  function normProfile(p) {
    const s = p && typeof p === 'object' ? p : {};
    const x = n(s.x, 0, -1e5, 1e5), y = n(s.y, 0, -1e5, 1e5);
    if (s.k === 'circle') return { k: 'circle', x, y, r: n(s.r, 5, 0.05, 1e4) };
    if (s.k === 'poly' || s.k === 'path') {
      const pts = (Array.isArray(s.pts) ? s.pts : []).slice(0, 400).map((q) => [n(q && q[0], 0, -1e5, 1e5), n(q && q[1], 0, -1e5, 1e5)]);
      const need = s.k === 'path' ? 2 : 3;
      return pts.length >= need ? { k: s.k, pts } : null;
    }
    if (s.k === 'exact') {
      const wires = normExactWires2(s.wires);
      return wires.length ? { k: 'exact', wires } : null;
    }
    return { k: 'rect', x, y, w: n(s.w, 10, 0.05, 1e4), h: n(s.h, 10, 0.05, 1e4) };
  }

  function normCut(c) {
    if (!c || typeof c !== 'object') return null;
    if (c.k === 'circle') {
      const center = vec(c.c);
      return { k: 'circle', c: center, r: n(c.r, 1, 0.05, 1e4) };
    }
    const pts = (Array.isArray(c.pts) ? c.pts : []).slice(0, 400).map((p) => vec(p));
    return pts.length >= 2 ? { k: 'poly', pts, ...(c.closed ? { closed: true } : {}) } : null;
  }
  function normFeature(f) {
    const s = f && typeof f === 'object' ? f : {};
    if (s.op === 'split') return { op: 'split', origin: vec(s.origin), normal: vec(s.normal, [1, 0, 0]) };
    if (s.op === 'imprint') {
      const cuts = (Array.isArray(s.cuts) ? s.cuts : []).slice(0, 40).map(normCut).filter(Boolean);
      return cuts.length ? { op: 'imprint', center: vec(s.center), normal: vec(s.normal, [0, 0, 1]), cuts } : null;
    }
    if (s.op === 'fillet' || s.op === 'chamfer') return { op: s.op, at: vec(s.at), r: n(s.r, 1, 0.05, 1e4) };
    if (s.op === 'length') {
      const scope = s.scope === 'edge' ? 'edge' : 'parallel';
      const at = vec(s.at);
      const raw = vec(s.dir, [1, 0, 0]);
      const dl = Math.hypot(raw[0], raw[1], raw[2]) || 1;
      const dir = raw.map((v) => n(v / dl, 0, -1, 1));
      if (s.round) {
        const loops = (Array.isArray(s.loops) ? s.loops : []).slice(0, 24).map((loop) => (
          Array.isArray(loop) ? loop.slice(0, 64).map((p) => vec(p)) : []
        )).filter((loop) => loop.length >= 8);
        const factor = n(s.factor, 1, 0.02, 100);
        return loops.length ? { op: 'length', round: true, scope, at, dir, factor, loops } : null;
      }
      const delta = n(s.delta, 0, -1e4, 1e4);
      if (Math.abs(delta) < 0.05) return null;
      return { op: 'length', scope, at, dir, delta };
    }
    const loop = (Array.isArray(s.loop) ? s.loop : []).slice(0, 600).map((p) => vec(p));
    if (loop.length < 3) return null;
    const out = { op: 'push', loop, normal: vec(s.normal, [0, 0, 1]), dist: n(s.dist, 0, -1e4, 1e4) };
    if (s.center) out.center = vec(s.center);
    if (s.exact) out.exact = true;
    return out;
  }

  function normMesh(m) {
    const s = m && typeof m === 'object' ? m : {};
    const vertices = Array.isArray(s.vertices) ? s.vertices.slice(0, 13500000).map((v) => n(v, 0, -1e6, 1e6)) : [];
    const triangles = Array.isArray(s.triangles) ? s.triangles.slice(0, 4500000).map((v) => Math.max(0, Math.round(Number(v) || 0))) : [];
    if (vertices.length < 9 || triangles.length < 3) return null;
    return { vertices, triangles };
  }

  function normSurface(s) {
    const o = s && typeof s === 'object' ? s : null;
    if (!o) return null;
    const vertices = Array.isArray(o.vertices) ? o.vertices.slice(0, 600000).map((x) => n(x, 0, -1e6, 1e6)) : [];
    const triangles = Array.isArray(o.triangles) ? o.triangles.slice(0, 600000).map((x) => Math.max(0, Math.round(Number(x) || 0))) : [];
    if (vertices.length < 9 || triangles.length < 3) return null;
    const normals = Array.isArray(o.normals) && o.normals.length === vertices.length
      ? o.normals.slice(0, vertices.length).map((x) => n(x, 0, -2, 2)) : [];
    return { vertices, triangles, ...(normals.length === vertices.length ? { normals } : {}) };
  }
  function normExactEdge3(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.k === 'circle') {
      const c = vec(e.c);
      if (!c) return null;
      const axis = Array.isArray(e.n) ? vec(e.n) : null;
      return { k: 'circle', c, r: n(e.r, 1, 0.001, 1e6), ...(axis ? { n: axis } : {}) };
    }
    if (e.k === 'arc') {
      const a = vec(e.a), b = vec(e.b), mid = vec(e.mid);
      return a && b && mid ? { k: 'arc', a, b, mid } : null;
    }
    if (e.k === 'line') {
      const a = vec(e.a), b = vec(e.b);
      return a && b ? { k: 'line', a, b } : null;
    }
    if (e.k === 'curve') {
      const a = vec(e.a), b = vec(e.b), mid = vec(e.mid);
      const pts = (Array.isArray(e.pts) ? e.pts : []).slice(0, 48).map((p) => vec(p)).filter(Boolean);
      return mid && pts.length >= 2 ? { k: 'curve', a: a || pts[0], b: b || pts[pts.length - 1], mid, pts, len: n(e.len, 0, 0, 1e6) } : null;
    }
    return null;
  }
  function normViewFace(f) {
    const s = f && typeof f === 'object' ? f : {};
    const loop = (Array.isArray(s.loop) ? s.loop : []).slice(0, 600).map((p) => vec(p));
    const surface = normSurface(s.surface);
    const exact = (Array.isArray(s.exact) ? s.exact : []).slice(0, 40).map((w) => {
      const edges = (w && Array.isArray(w.edges) ? w.edges : []).slice(0, 400).map(normExactEdge3).filter(Boolean);
      return edges.length ? { edges } : null;
    }).filter(Boolean);
    const measures = (Array.isArray(s.measures) ? s.measures : []).slice(0, 400).map(normExactEdge3).filter(Boolean);
    if (loop.length < 3 && !surface && !exact.length && !measures.length) return null;
    return {
      center: vec(s.center),
      normal: vec(s.normal, [0, 0, 1]),
      ...(loop.length >= 3 ? { loop } : {}),
      ...(surface ? { surface } : {}),
      ...(exact.length ? { exact } : {}),
      ...(measures.length ? { measures } : {}),
    };
  }
  function normView(v) {
    const s = v && typeof v === 'object' ? v : null;
    if (!s) return null;
    const vertices = Array.isArray(s.vertices) ? s.vertices.slice(0, 600000).map((x) => n(x, 0, -1e6, 1e6)) : [];
    const triangles = Array.isArray(s.triangles) ? s.triangles.slice(0, 600000).map((x) => Math.max(0, Math.round(Number(x) || 0))) : [];
    if (vertices.length < 9 || triangles.length < 3) return null;
    const faces = (Array.isArray(s.faces) ? s.faces : []).slice(0, 800).map(normViewFace).filter(Boolean);
    const edges = Array.isArray(s.edges) ? s.edges.slice(0, 600000).map((x) => n(x, 0, -1e6, 1e6)) : [];
    const normals = Array.isArray(s.normals) && s.normals.length === vertices.length
      ? s.normals.slice(0, vertices.length).map((x) => n(x, 0, -2, 2)) : [];
    return {
      vertices,
      triangles,
      faces,
      ...(edges.length >= 6 ? { edges } : {}),
      ...(normals.length === vertices.length ? { normals } : {}),
    };
  }

  function normObject(s, depth, keepCache) {
    const o = s && typeof s === 'object' ? s : {};
    const type = TYPES.includes(o.type) ? o.type : 'box';
    const kernel = (o.kernel === 'mesh' || type === 'mesh') ? 'mesh' : 'brep';
    const out = {
      id: str(o.id, 40) || uid('b_'),
      name: str(o.name, 80) || 'Body',
      kernel,
      type,
      pos: vec(o.pos),
      rot: vec(o.rot),
      scale: normScale(o.scale),
      ...(o.hidden ? { hidden: true } : {}),
      ...(o.dims === false ? { dims: false } : (o.dims ? { dims: true } : {})),
      features: (Array.isArray(o.features) ? o.features : []).map(normFeature).filter(Boolean).slice(0, 200),
    };
    // A split piece is only its saved solid. Undo, redo, and checkpoints must
    // keep that solid. A rebuilt picture can be dropped to save space.
    if (keepCache !== false) {
      const view = normView(o.view);
      if (view) out.view = view;
    }
    if (keepCache !== false || type === 'solid') {
      if (typeof o.brep === 'string' && o.brep.length > 16 && o.brep.length < 8000000) out.brep = o.brep;
      if (typeof o.brepHash === 'string' && /^[0-9a-f]{1,12}$/.test(o.brepHash)) out.brepHash = o.brepHash;
    }
    const size = normSize(type, o.size);
    if (size) out.size = size;
    if (type === 'sketch') {
      out.profiles = (Array.isArray(o.profiles) ? o.profiles : []).map(normProfile).filter(Boolean).slice(0, 100);
      let h = n(o.height, 1, -1e4, 1e4);
      if (Math.abs(h) < 0.001) h = h < 0 ? -0.001 : 0.001;
      out.height = h;
    }
    if (type === 'join' && (depth || 0) < 4) {
      out.parts = (Array.isArray(o.parts) ? o.parts : []).slice(0, 40).map((p) => normObject(p, (depth || 0) + 1, keepCache));
    }
    if (type === 'cut' && (depth || 0) < 4) {
      out.parts = (Array.isArray(o.parts) ? o.parts : []).slice(0, 2).map((p) => normObject(p, (depth || 0) + 1, keepCache));
      out.cut = o.cut === 'split' ? 'split' : 'delete';
    }
    if (kernel === 'mesh') {
      const mesh = normMesh(o.mesh);
      if (mesh) out.mesh = mesh;
    }
    return out;
  }

  function normScale(v) {
    const src = Array.isArray(v) ? v : [];
    return [0, 1, 2].map((i) => {
      let x = n(src[i], 1, -1000, 1000);
      if (Math.abs(x) < 0.05) x = x < 0 ? -0.05 : 0.05;
      return x;
    });
  }
  function normPoint(p) {
    const s = p && typeof p === 'object' ? p : {};
    const objects = (Array.isArray(s.objects) ? s.objects : []).slice(0, 500).map((o) => normObject(o, 0, false));
    if (!objects.length) return null;
    return { id: str(s.id, 40) || uid('cp_'), name: str(s.name, 80) || 'Point', at: str(s.at, 40), objects };
  }
  function normStack(list) {
    return (Array.isArray(list) ? list : []).slice(-50).map((entry) =>
      (Array.isArray(entry) ? entry : []).slice(0, 500).map((o) => normObject(o, 0, false))
    );
  }
  function normHistory(h) {
    const s = h && typeof h === 'object' ? h : {};
    return { past: normStack(s.past), future: normStack(s.future) };
  }

  function normalize(d) {
    const s = d && typeof d === 'object' ? d : {};
    return {
      version: 1,
      title: str(s.title, 200),
      objects: (Array.isArray(s.objects) ? s.objects : []).slice(0, 500).map((o) => normObject(o, 0)),
      history: normHistory(s.history),
      checkpoints: (Array.isArray(s.checkpoints) ? s.checkpoints : []).slice(-20).map(normPoint).filter(Boolean),
      updatedAt: str(s.updatedAt, 40),
    };
  }

  function createStarter() {
    return normalize({
      objects: [{ name: 'Body', kernel: 'brep', type: 'box', size: { x: 40, y: 30, z: 20 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] }],
    });
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 200);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 1).replace(/</g, '\\u003c');
    const t = String(title || norm.title || '3D Model').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="model">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="model-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  // The viewer draws scale, then X, then Y, then Z, then position. Every
  // dimension uses this same placement, so a stretched circle is measured
  // where it appears, not in the body's unscaled frame.
  function placePoint(p, pos, rot, scale) {
    const sc = scale || [1, 1, 1];
    let x = (p[0] || 0) * (sc[0] == null ? 1 : sc[0]);
    let y = (p[1] || 0) * (sc[1] == null ? 1 : sc[1]);
    let z = (p[2] || 0) * (sc[2] == null ? 1 : sc[2]);
    const rx = ((rot && rot[0]) || 0) * Math.PI / 180;
    const ry = ((rot && rot[1]) || 0) * Math.PI / 180;
    const rz = ((rot && rot[2]) || 0) * Math.PI / 180;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy;
    const x3 = x2 * cz - y1 * sz;
    const y3 = x2 * sz + y1 * cz;
    return [x3 + ((pos && pos[0]) || 0), y3 + ((pos && pos[1]) || 0), z2 + ((pos && pos[2]) || 0)];
  }
  function fitCircle(points) {
    if (!points || points.length < 8) return null;
    const at = (i) => points[Math.min(points.length - 1, i)];
    const a = at(0);
    const b = at(Math.floor(points.length / 3));
    const c = at(Math.floor((2 * points.length) / 3));
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
    if (!(r > 0.05)) return null;
    const tol = Math.max(0.25, r * 0.02);
    for (const p of points) {
      const d = Math.hypot(p[0] - center[0], p[1] - center[1], (p[2] || 0) - center[2]);
      if (Math.abs(d - r) > tol) return null;
    }
    const nl = Math.sqrt(n2);
    return { c: center, r, d: r * 2, n: [n[0] / nl, n[1] / nl, n[2] / nl] };
  }
  // How much one local unit along dir grows once the body scale is applied.
  // The turn is applied after scale and does not change a length.
  function drawnSpan(dir, scale) {
    const s = scale || [1, 1, 1];
    const d = dir || [1, 0, 0];
    const len = Math.hypot(d[0] || 0, d[1] || 0, d[2] || 0) || 1;
    const x = (d[0] || 0) / len * (s[0] == null ? 1 : s[0]);
    const y = (d[1] || 0) / len * (s[1] == null ? 1 : s[1]);
    const z = (d[2] || 0) / len * (s[2] == null ? 1 : s[2]);
    return Math.hypot(x, y, z);
  }
  // Drawn length change, stored in the body frame. measure and next are the
  // lengths on screen. Dividing by the scale along the edge is what makes the
  // edited number come back as the number that was typed.
  function lengthDelta(measure, next, dir, scale) {
    const span = drawnSpan(dir, scale);
    if (!(measure > 1e-6) || !(span > 1e-9) || !Number.isFinite(next)) return 0;
    return (next - measure) / span;
  }
  function planeNormal(points) {
    if (!points || points.length < 3) return null;
    const a = points[0];
    const b = points[Math.floor(points.length / 3)];
    const c = points[Math.floor((2 * points.length) / 3)];
    const ab = [b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)];
    const ac = [c[0] - a[0], c[1] - a[1], (c[2] || 0) - (a[2] || 0)];
    const nrm = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (l < 1e-8) return null;
    return [nrm[0] / l, nrm[1] / l, nrm[2] / l];
  }
  function sameDirection(a, b) {
    if (!a || !b) return false;
    const la = Math.hypot(a[0] || 0, a[1] || 0, a[2] || 0) || 1;
    const lb = Math.hypot(b[0] || 0, b[1] || 0, b[2] || 0) || 1;
    const d = Math.abs((a[0] || 0) / la * (b[0] || 0) / lb + (a[1] || 0) / la * (b[1] || 0) / lb + (a[2] || 0) / la * (b[2] || 0) / lb);
    return d > 0.98;
  }
  // One label per drawn length. Straight edges of one direction and length
  // share a label. Each circle keeps its own label by its drawn center.
  function dimGroupKey(measure, dir, center) {
    const m = Math.round((+measure || 0) * 100);
    if (center && center.length >= 3) {
      return 'o:' + m + ':' + [0, 1, 2].map((i) => Math.round(+center[i] || 0)).join(',');
    }
    let x = +dir[0] || 0, y = +dir[1] || 0, z = +dir[2] || 0;
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    if (x < -1e-4 || (Math.abs(x) <= 1e-4 && (y < -1e-4 || (Math.abs(y) <= 1e-4 && z < 0)))) {
      x = -x; y = -y; z = -z;
    }
    return Math.round(x * 50) + ',' + Math.round(y * 50) + ',' + Math.round(z * 50) + ':' + m;
  }
  // The lowest point of the body moves onto the floor. Z up, floor at 0.
  function floorShift(minZ, floor) {
    const z = +minZ;
    const f = floor == null || !Number.isFinite(+floor) ? 0 : +floor;
    if (!Number.isFinite(z)) return 0;
    return Math.round((f - z) * 1000) / 1000;
  }
  function setAllHidden(objects, hidden) {
    const list = Array.isArray(objects) ? objects : [];
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      if (hidden) o.hidden = true;
      else delete o.hidden;
    }
    return list;
  }
  // The view can turn again when no tool is holding the pointer. A drag that
  // ends on a menu must not leave the orbit locked.
  function navIdle(flags) {
    const f = flags && typeof flags === 'object' ? flags : {};
    return !(f.dragging || f.sketch || f.face);
  }
  // A dimension label edits on a primary press. Right and middle presses must
  // still turn the view, because labels sit on top of the model.
  function dimPressEdits(button, pointerType) {
    return button === 0 || pointerType === 'pen' || pointerType === 'touch';
  }
  // Face mode defaults to extrude. The cut-by-plane preview only shows when
  // that tool is chosen.
  function faceTool(kind) {
    return kind === 'cut' ? 'cut' : 'extrude';
  }
  function faceCutPlaneOn(tool) {
    return faceTool(tool) === 'cut';
  }
  // One label per drawn length. A hidden edge of that length must not be the
  // one that gets drawn, and a cut edge the camera can see is labeled even
  // when its face normal points to the side.
  function dist3(a, b) {
    return Math.hypot((b[0] || 0) - (a[0] || 0), (b[1] || 0) - (a[1] || 0), (b[2] || 0) - (a[2] || 0));
  }
  function frameOf(n) {
    const nl = Math.hypot(n[0] || 0, n[1] || 0, n[2] || 0) || 1;
    const nn = [(n[0] || 0) / nl, (n[1] || 0) / nl, (n[2] || 0) / nl];
    const ref = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let x = [ref[1] * nn[2] - ref[2] * nn[1], ref[2] * nn[0] - ref[0] * nn[2], ref[0] * nn[1] - ref[1] * nn[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [nn[1] * x[2] - nn[2] * x[1], nn[2] * x[0] - nn[0] * x[2], nn[0] * x[1] - nn[1] * x[0]];
    return { x, y };
  }
  function circleSamples(edge) {
    const c = edge.c || [0, 0, 0];
    const r = edge.r || 0;
    let n = edge.n;
    if (!n && edge.faces) {
      const face = (edge.faces || []).find((f) => f && f.normal);
      if (face) n = face.normal;
    }
    if (!n) n = [0, 0, 1];
    const f = frameOf(n);
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([
        c[0] + r * (ca * f.x[0] + sa * f.y[0]),
        c[1] + r * (ca * f.x[1] + sa * f.y[1]),
        (c[2] || 0) + r * (ca * f.x[2] + sa * f.y[2]),
      ]);
    }
    return pts;
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
  function arcSamples(edge) {
    const hit = circum3(edge.a, edge.mid, edge.b);
    if (!hit || !(hit.r > 0.05)) return null;
    const f = frameOf(hit.n);
    const ang = (p) => {
      const v = [p[0] - hit.c[0], p[1] - hit.c[1], (p[2] || 0) - (hit.c[2] || 0)];
      return Math.atan2(v[0] * f.y[0] + v[1] * f.y[1] + v[2] * f.y[2], v[0] * f.x[0] + v[1] * f.x[1] + v[2] * f.x[2]);
    };
    const wrap = (d) => {
      let t = d;
      while (t <= -Math.PI) t += Math.PI * 2;
      while (t > Math.PI) t -= Math.PI * 2;
      return t;
    };
    const a0 = ang(edge.a);
    let sweep = wrap(ang(edge.b) - a0);
    const via = wrap(ang(edge.mid) - a0);
    if (sweep * via < 0) sweep += sweep > 0 ? -Math.PI * 2 : Math.PI * 2;
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const t = a0 + sweep * i / 11;
      const ca = Math.cos(t), sa = Math.sin(t);
      pts.push([
        hit.c[0] + hit.r * (ca * f.x[0] + sa * f.y[0]),
        hit.c[1] + hit.r * (ca * f.x[1] + sa * f.y[1]),
        (hit.c[2] || 0) + hit.r * (ca * f.x[2] + sa * f.y[2]),
      ]);
    }
    return pts;
  }
  // The number on a dimension. Placement is applied first. A stored length, a
  // local radius, and the chord of an arc are not this number.
  function drawnMeasure(edge, place) {
    if (!edge) return null;
    const put = (p) => {
      const q = place ? place(p) : p;
      return [q[0] || 0, q[1] || 0, q[2] || 0];
    };
    let raw = null;
    if (edge.k === 'circle' && edge.c != null && edge.r) raw = circleSamples(edge);
    else if (edge.k === 'arc' && edge.a && edge.mid && edge.b) raw = arcSamples(edge);
    else if (edge.pts && edge.pts.length >= 8) raw = edge.pts;
    if (raw && raw.length >= 8) {
      const fit = fitCircle(raw.map(put));
      if (fit) return { kind: 'diameter', value: fit.d };
    }
    if (edge.k === 'line' && edge.a && edge.b) return { kind: 'length', value: dist3(put(edge.a), put(edge.b)) };
    if (edge.pts && edge.pts.length >= 2) {
      const w = edge.pts.map(put);
      const span = dist3(w[0], w[w.length - 1]);
      const ab = [w[w.length - 1][0] - w[0][0], w[w.length - 1][1] - w[0][1], w[w.length - 1][2] - w[0][2]];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      let off = 0;
      if (len2 > 1e-8) {
        for (const p of w) {
          const ap = [p[0] - w[0][0], p[1] - w[0][1], p[2] - w[0][2]];
          const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2;
          off = Math.max(off, Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t));
        }
      }
      if (off <= Math.max(0.05, span * 0.01)) return { kind: 'length', value: span };
      let sum = 0;
      for (let i = 1; i < w.length; i++) sum += dist3(w[i - 1], w[i]);
      if (span < Math.max(0.5, sum * 0.08) && w.length > 2) sum += dist3(w[w.length - 1], w[0]);
      return { kind: 'length', value: sum };
    }
    if (edge.a && edge.b) return { kind: 'length', value: dist3(put(edge.a), put(edge.b)) };
    return null;
  }
  // A split piece is the saved solid. A later edit is applied on that solid,
  // so the saved shape stays. A primitive is rebuilt from its size.
  function dropBuiltCache(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type !== 'solid') delete obj.brep;
    delete obj.brepHash;
    delete obj.view;
  }
  // Undo and checkpoints drop rebuilt pictures to stay small. A split piece
  // still keeps its solid, or undo would leave a body with no shape.
  function snapObjects(objects) {
    return (objects || []).map((o) => {
      if (!o || (o.view == null && o.brep == null && o.brepHash == null)) return o;
      const c = Object.assign({}, o);
      delete c.view;
      if (c.type !== 'solid') {
        delete c.brep;
        delete c.brepHash;
      }
      return c;
    });
  }
  function pickDim(cands) {
    const open = (Array.isArray(cands) ? cands : []).filter((c) => c && c.open && c.key != null);
    if (!open.length) return null;
    open.sort((a, b) => {
      if (!!a.facing !== !!b.facing) return a.facing ? -1 : 1;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });
    return open[0].key;
  }

  // 0 is the first selected body. A numeric check is required: 0 is false in a condition.
  function cutRoles(ids, toolIndex) {
    const list = Array.isArray(ids) ? ids : [];
    const toolAt = toolIndex === 0 ? 0 : 1;
    return { tool: list[toolAt], target: list[toolAt === 0 ? 1 : 0] };
  }

  function isModelHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']model["']/.test(html);
  }

  function parseHtml(html) {
    if (!isModelHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']model-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  return { normalize, createStarter, serializeToHtml, parseHtml, isModelHtml, normObject, cutRoles, placePoint, fitCircle, drawnSpan, lengthDelta, planeNormal, sameDirection, pickDim, drawnMeasure, dropBuiltCache, snapObjects, dimGroupKey, floorShift, setAllHidden, navIdle, dimPressEdits, faceTool, faceCutPlaneOn, DEFAULT_SIZE };
});
