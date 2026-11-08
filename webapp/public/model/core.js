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
  const TYPES = ['box', 'cylinder', 'sphere', 'sketch', 'join', 'mesh'];
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
    if (s.op !== 'push') return null;
    const loop = (Array.isArray(s.loop) ? s.loop : []).slice(0, 600).map((p) => vec(p));
    if (loop.length < 3) return null;
    const out = { op: 'push', loop, normal: vec(s.normal, [0, 0, 1]), dist: n(s.dist, 0, -1e4, 1e4) };
    if (s.center) out.center = vec(s.center);
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
      return c ? { k: 'circle', c, r: n(e.r, 1, 0.001, 1e6) } : null;
    }
    if (e.k === 'arc') {
      const a = vec(e.a), b = vec(e.b), mid = vec(e.mid);
      return a && b && mid ? { k: 'arc', a, b, mid } : null;
    }
    if (e.k === 'line') {
      const a = vec(e.a), b = vec(e.b);
      return a && b ? { k: 'line', a, b } : null;
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
    if (loop.length < 3 && !surface && !exact.length) return null;
    return {
      center: vec(s.center),
      normal: vec(s.normal, [0, 0, 1]),
      ...(loop.length >= 3 ? { loop } : {}),
      ...(surface ? { surface } : {}),
      ...(exact.length ? { exact } : {}),
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
      features: (Array.isArray(o.features) ? o.features : []).map(normFeature).filter(Boolean).slice(0, 200),
    };
    if (keepCache !== false) {
      const view = normView(o.view);
      if (view) out.view = view;
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

  function isModelHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']model["']/.test(html);
  }

  function parseHtml(html) {
    if (!isModelHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']model-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  return { normalize, createStarter, serializeToHtml, parseHtml, isModelHtml, normObject, DEFAULT_SIZE };
});
