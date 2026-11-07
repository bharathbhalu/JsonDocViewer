/* DocViewer CAD core — a 3D design as a list of shapes. Works in browser and Node.
 *
 * Every item is built centred on X/Y and sitting on Z=0, then rotated (X, Y, Z
 * in degrees) and moved to `pos` (mm). Solids are joined, holes are cut from
 * them, references are only shown (e.g. the device a case is built around).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CadCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);
  const uid = (p) => (p || 'x') + Math.random().toString(36).slice(2, 9);
  const n = (v, d, lo, hi) => {
    let x = Number(v);
    if (!Number.isFinite(x)) x = d;
    if (lo != null) x = Math.max(lo, x);
    if (hi != null) x = Math.min(hi, x);
    return Math.round(x * 1000) / 1000;
  };
  const vec = (v) => [0, 1, 2].map((i) => n(Array.isArray(v) ? v[i] : 0, 0, -1e5, 1e5));

  const TYPES = ['box', 'cylinder', 'sphere', 'sketch', 'model', 'image', 'code'];
  const ROLES = ['solid', 'hole', 'ref'];
  const MODEL_EXT = ['stl', '3mf', 'obj', 'step', 'stp'];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  const TYPE_LABEL = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', sketch: 'Sketch', model: 'Model', image: 'Image', code: 'Script' };

  // Sketch profiles, in the sketch's own plane (mm): rectangles and circles by
  // centre, polygons by points. Overlapping profiles are joined.
  // Profiles: rect / circle (centre), slot (centre, length, width, angle), ngon
  // (centre, corner radius, sides, angle), poly (points; a point [x, y, mx, my]
  // means the segment arriving at it is an arc through (mx, my); the first
  // point with 4 values makes the closing segment an arc). cut: true makes the
  // profile a cut-out (hole) in the joined profiles.
  function normProfile(p) {
    const s = p && typeof p === 'object' ? p : {};
    const c = (o) => (s.cut ? Object.assign(o, { cut: true }) : o);
    const X = n(s.x, 0, -1e5, 1e5), Y = n(s.y, 0, -1e5, 1e5);
    if (s.k === 'circle') return c({ k: 'circle', x: X, y: Y, r: n(s.r, 5, 0.05, 1e4) });
    if (s.k === 'slot') { const w = n(s.w, 20, 0.1, 1e4), h = n(s.h, 6, 0.05, 1e4); return c({ k: 'slot', x: X, y: Y, w: Math.max(w, h), h, a: n(s.a, 0, -360, 360) }); }
    if (s.k === 'ngon') return c({ k: 'ngon', x: X, y: Y, r: n(s.r, 10, 0.05, 1e4), n: Math.round(n(s.n, 6, 3, 64)), a: n(s.a, 0, -360, 360) });
    if (s.k === 'poly') {
      const pts = (Array.isArray(s.pts) ? s.pts : []).slice(0, 1000).map((q) => {
        const a = [n(q && q[0], 0, -1e5, 1e5), n(q && q[1], 0, -1e5, 1e5)];
        return q && q.length >= 4 && Number.isFinite(+q[2]) && Number.isFinite(+q[3]) ? a.concat([n(q[2], 0, -1e5, 1e5), n(q[3], 0, -1e5, 1e5)]) : a;
      });
      return pts.length >= 3 || (pts.length >= 2 && pts.some((q) => q.length === 4)) ? c({ k: 'poly', pts }) : null;
    }
    return c({ k: 'rect', x: X, y: Y, w: n(s.w, 10, 0.05, 1e4), h: n(s.h, 10, 0.05, 1e4) });
  }

  const DEFAULT_SIZE = { box: { x: 30, y: 20, z: 15, corner: 0 }, cylinder: { d: 20, z: 20 }, sphere: { d: 20 } };
  const DEFAULT_CODE = 'function main() {\n  // replicad: https://replicad.xyz/docs\n  return drawRoundedRectangle(30, 20, 4)\n    .sketchOnPlane()\n    .extrude(10)\n    .fillet(1);\n}\n';

  function normSize(type, s) {
    const d = DEFAULT_SIZE[type];
    if (!d) return undefined;
    const o = s && typeof s === 'object' ? s : {};
    const out = {};
    for (const k of Object.keys(d)) out[k] = n(o[k], d[k], k === 'corner' ? 0 : 0.1, 10000);
    return out;
  }
  function normItem(it) {
    const s = it && typeof it === 'object' ? it : {};
    const type = TYPES.includes(s.type) ? s.type : 'box';
    const out = {
      id: str(s.id, 40) || uid('i_'),
      name: str(s.name, 80) || TYPE_LABEL[type],
      type,
      role: ROLES.includes(s.role) ? s.role : (type === 'model' ? 'ref' : 'solid'),
      pos: vec(s.pos),
      rot: vec(s.rot),
      hidden: !!s.hidden,
      ...(s.group ? { group: str(s.group, 40) } : {}),
      // Mirrored copies: flip the shape on its own X / Y / Z before rotating.
      ...(Array.isArray(s.flip) && s.flip.some(Boolean) ? { flip: [0, 1, 2].map((i) => !!s.flip[i]) } : {}),
    };
    if (type === 'sketch') {
      if (s.draft) out.draft = true; // a 2D sketch (outlines only) — extrude its areas into shapes
      out.profiles = (Array.isArray(s.profiles) ? s.profiles : []).map(normProfile).filter(Boolean).slice(0, 300);
      // new sketch shapes start 0.05 mm thick; a negative height extrudes into the face it was drawn on
      { const h = n(s.height, 0.05, -10000, 10000); out.height = Math.abs(h) < 0.05 ? (h < 0 ? -0.05 : 0.05) : h; }
      out.round = n(s.round, 0, 0, 1000);
      out.chamfer = n(s.chamfer, 0, 0, 1000);
      out.hollow = n(s.hollow, 0, 0, 1000);
    }
    if (type === 'image') {
      const f = s.file && typeof s.file === 'object' ? s.file : {};
      out.role = 'ref';
      out.file = { path: str(f.path, 1000) };
      out.width = n(s.width, 100, 1, 10000);
      out.opacity = n(s.opacity, 0.6, 0.05, 1);
    }
    if (type === 'box' || type === 'cylinder' || type === 'sphere') {
      out.size = normSize(type, s.size);
      out.round = n(s.round, 0, 0, 1000);
      out.chamfer = n(s.chamfer, 0, 0, 1000);
      out.hollow = n(s.hollow, 0, 0, 1000);
    }
    if (type === 'model') {
      const f = s.file && typeof s.file === 'object' ? s.file : {};
      const ext = str(f.ext || String(f.path || '').split('.').pop(), 8).toLowerCase();
      out.file = { path: str(f.path, 1000), ext: MODEL_EXT.includes(ext) ? ext : 'stl', key: str(f.key, 1100) || str(f.path, 1000) };
      out.scale = n(s.scale, 1, 0.001, 1000);
      // Units the file was saved in (STL has none; mm is the usual) and an optional per-axis stretch.
      out.units = ['mm', 'cm', 'in', 'm'].includes(s.units) ? s.units : 'mm';
      out.stretch = [0, 1, 2].map((i) => n(Array.isArray(s.stretch) ? s.stretch[i] : 1, 1, 0.001, 1000));
      out.fit = s.fit === 'outline' ? 'outline' : 'exact';
    }
    if (type === 'code') out.code = str(s.code, 100000) || DEFAULT_CODE;
    out.clearance = n(s.clearance, type === 'model' ? 0.3 : 0, 0, 50);
    // one of several separate pieces of this shape (after a split): keep piece k
    if (type !== 'image' && s.piece && Number.isInteger(s.piece.k) && s.piece.k >= 0) out.piece = { k: s.piece.k, n: Math.max(2, Math.round(n(s.piece.n, 2, 2, 1000))) };
    if (type !== 'image' && Array.isArray(s.sxyz) && s.sxyz.some((v) => Math.abs(+v - 1) > 1e-9)) out.sxyz = [0, 1, 2].map((i) => n(s.sxyz[i], 1, 0.001, 1000));
    if (type !== 'image' && Array.isArray(s.cuts) && s.cuts.length) {
      out.cuts = s.cuts.slice(0, 16).filter((c) => c && c.shape && Array.isArray(c.m) && c.m.length === 16).map((c) => {
        const isHole = c.shape.role === 'hole';
        const sh = normItem(Object.assign({}, c.shape, { role: isHole ? 'hole' : 'solid', pos: [0, 0, 0], rot: [0, 0, 0] }));
        ['id', 'name', 'pos', 'rot', 'hidden', 'group', 'flip', 'cuts'].forEach((k) => delete sh[k]);
        if (!isHole) { delete sh.role; if (!sh.clearance) delete sh.clearance; }
        return { keep: c.keep === 'inside' ? 'inside' : 'outside', m: c.m.map((v) => n(v, 0, -1e6, 1e6)), shape: sh };
      });
      if (!out.cuts.length) delete out.cuts;
    }
    if (type !== 'image' && Array.isArray(s.clip) && s.clip.length) {
      out.clip = s.clip.slice(0, 8).map((c) => ({ n: [0, 1, 2].map((i) => n(c && c.n && c.n[i], 0, -1, 1)), d: n(c && c.d, 0, -1e5, 1e5) })).filter((c) => Math.hypot(...c.n) > 0.5);
      if (!out.clip.length) delete out.clip;
    }
    // Per-edge rounding / chamfer: p = a point on the edge (its middle) in the
    // shape's own frame, r = radius / size, kind = 'round' | 'chamfer'.
    if (['box', 'cylinder', 'sphere', 'sketch', 'code'].includes(type) && Array.isArray(s.edges) && s.edges.length) {
      out.edges = s.edges.slice(0, 300).map((e) => ({ p: [0, 1, 2].map((i) => n(e && e.p && e.p[i], 0, -1e5, 1e5)), r: n(e && e.r, 1, 0.01, 1000), kind: e && e.kind === 'chamfer' ? 'chamfer' : 'round' }));
    }
    return out;
  }
  function normalize(data) {
    const d = data && typeof data === 'object' ? data : {};
    const st = d.settings && typeof d.settings === 'object' ? d.settings : {};
    const items = (Array.isArray(d.items) ? d.items : []).map(normItem).slice(0, 500);
    // Combined objects: items sharing a `group` id act and export as one part.
    // A group needs 2+ members; its name lives in `groups`.
    const count = {};
    items.forEach((it) => { if (it.group) count[it.group] = (count[it.group] || 0) + 1; });
    items.forEach((it) => { if (it.group && count[it.group] < 2) delete it.group; });
    const gin = d.groups && typeof d.groups === 'object' ? d.groups : {};
    const groups = {};
    Object.keys(count).filter((g) => count[g] >= 2).forEach((g) => { groups[g] = { name: str(gin[g] && gin[g].name, 80) || 'Combined' }; });
    return {
      version: 1,
      title: str(d.title, 200),
      items,
      groups,
      settings: { snap: n(st.snap, 1, 0, 100), angleSnap: n(st.angleSnap, 15, 0, 90) },
      updatedAt: str(d.updatedAt, 40),
    };
  }

  function newItem(type, extra) { return normItem(Object.assign({ type }, extra || {})); }

  const TEMPLATES = {
    blank: () => ({ items: [] }),
    box: () => ({ items: [
      { name: 'Body', type: 'box', size: { x: 60, y: 40, z: 25, corner: 4 }, round: 1, hollow: 2 },
    ] }),
    holder: () => ({ items: [
      { name: 'Body', type: 'box', size: { x: 50, y: 26, z: 80, corner: 3 }, round: 1 },
      { name: 'Pocket', type: 'box', role: 'hole', size: { x: 44, y: 20, z: 80 }, pos: [0, 0, 2.4] },
      { name: 'Front window', type: 'box', role: 'hole', size: { x: 36, y: 10, z: 70 }, pos: [0, -10, 8] },
      { name: 'Cable slot', type: 'box', role: 'hole', size: { x: 14, y: 8, z: 6, corner: 2 }, pos: [0, 0, -1] },
    ] }),
    vase: () => ({ items: [
      { name: 'Vase', type: 'cylinder', size: { d: 70, z: 150 }, round: 3, hollow: 1.6 },
    ] }),
  };
  function createStarter(kind) { return normalize((TEMPLATES[kind] || TEMPLATES.blank)()); }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 200);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 1).replace(/</g, '\\u003c');
    const t = String(title || norm.title || '3D design').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="cad">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="cad-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }
  function isCadHtml(html) { return typeof html === 'string' && /data-docviewer\s*=\s*["']cad["']/.test(html); }
  function parseHtml(html) {
    if (!isCadHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']cad-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  return { TYPES, ROLES, MODEL_EXT, IMAGE_EXT, TYPE_LABEL, normalizeProfile: normProfile, DEFAULT_CODE, uid, normalize, normalizeItem: normItem, newItem, TEMPLATES, createStarter, serializeToHtml, isCadHtml, parseHtml };
});
