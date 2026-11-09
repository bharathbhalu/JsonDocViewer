// 3D Model regression suite. Every change to public/model or model-build
// runs this file, and a new behavior gets a new check in this file.
//   model-build/test/regression.sh
import fs from 'fs';
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
function lineLengths(body) {
  const lens = [];
  for (const f of (body && body.faces) || []) {
    const groups = (f.exact && f.exact.length) ? f.exact.map((w) => w.edges || []) : [f.measures || []];
    for (const edges of groups) for (const e of edges) {
      if (e.k === 'line' && e.a && e.b) lens.push(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], (e.b[2] || 0) - (e.a[2] || 0)));
    }
  }
  return lens;
}
function hasLen(lens, want, tol) {
  return lens.some((v) => Math.abs(v - want) <= tol);
}
function curveEdges(body) {
  const out = [];
  const seen = new Set();
  for (const f of (body && body.faces) || []) {
    const groups = (f.exact && f.exact.length) ? f.exact.map((w) => w.edges || []) : [f.measures || []];
    for (const edges of groups) for (const e of edges) {
      if (e.k !== 'curve' && e.k !== 'arc' && e.k !== 'circle') continue;
      const key = e.k + ':' + (e.mid || e.c || []).map((v) => Math.round(v * 10)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}
function bounds(v) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  }
  return { lo, hi };
}
// The viewer turns a point with scale, then X, then Y, then Z, then position.
function worldBounds(v, pos, rot, scale) {
  const sc = scale || [1, 1, 1];
  const rx = ((rot && rot[0]) || 0) * Math.PI / 180;
  const ry = ((rot && rot[1]) || 0) * Math.PI / 180;
  const rz = ((rot && rot[2]) || 0) * Math.PI / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    let x = v[i] * sc[0], y = v[i + 1] * sc[1], z = v[i + 2] * sc[2];
    const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
    const x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
    const p = [x3 + ((pos && pos[0]) || 0), y3 + ((pos && pos[1]) || 0), z2 + ((pos && pos[2]) || 0)];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
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
  check('undo does not keep a copy of a rebuilt primitive', cachedBack.history.past.length === 1 && !cachedBack.history.past[0][0].brep && !cachedBack.history.past[0][0].view);
  const solidHist = ModelCore.normalize({
    objects: [{ name: 'Piece', type: 'solid', brep: '0123456789abcdefEXTRA', brepHash: 'abc' }],
    history: { past: [[{ name: 'Piece', type: 'solid', brep: '0123456789abcdefEXTRA', brepHash: 'abc', view: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] } }]] },
    checkpoints: [{ name: 'Keep', objects: [{ name: 'Piece', type: 'solid', brep: '0123456789abcdefEXTRA', brepHash: 'abc' }] }],
  });
  const solidSnap = ModelCore.snapObjects([{ name: 'Piece', type: 'solid', brep: '0123456789abcdefEXTRA', brepHash: 'abc', view: { vertices: [0, 0, 0] } }]);
  check('undo keeps the saved shape of a split piece', solidHist.history.past[0][0].brep === '0123456789abcdefEXTRA' && solidHist.history.past[0][0].brepHash === 'abc' && !solidHist.history.past[0][0].view, solidHist.history.past[0] && solidHist.history.past[0][0] && solidHist.history.past[0][0].brep);
  check('a checkpoint keeps the saved shape of a split piece', solidHist.checkpoints[0].objects[0].brep === '0123456789abcdefEXTRA' && solidSnap[0].brep === '0123456789abcdefEXTRA' && !('view' in solidSnap[0]), solidHist.checkpoints[0] && solidHist.checkpoints[0].objects[0] && solidHist.checkpoints[0].objects[0].brep);
  const exactDoc = ModelCore.normalize({
    objects: [{
      name: 'S', type: 'sketch', height: 2,
      profiles: [{ k: 'exact', wires: [{ edges: [{ k: 'circle', c: [1, 2], r: 4 }] }, { edges: [{ k: 'line', a: [0, 0], b: [1, 0] }, { k: 'arc', a: [1, 0], b: [0, 0], mid: [0.5, 0.5] }] }] }],
      view: {
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2],
        faces: [{ center: [0, 0, 1], normal: [0, 0, 1], exact: [{ edges: [{ k: 'circle', c: [0, 0, 1], r: 3 }] }], measures: [{ k: 'line', a: [0, 0, 0], b: [4, 0, 0] }, { k: 'curve', a: [0, 0, 1], b: [2, 0, 1], mid: [1, 0.4, 1], pts: [[0, 0, 1], [1, 0.4, 1], [2, 0, 1]], len: 2.2 }] }],
      },
    }],
  });
  const exactBack = ModelCore.parseHtml(ModelCore.serializeToHtml(exactDoc, 'S'));
  const ep = exactBack.objects[0].profiles[0];
  check('an exact face sketch survives a save', ep.k === 'exact' && ep.wires[0].edges[0].k === 'circle' && ep.wires[0].edges[0].r === 4 && ep.wires[1].edges[1].k === 'arc');
  check('a face keeps the exact edge it was built from', exactBack.objects[0].view.faces[0].exact[0].edges[0].k === 'circle' && exactBack.objects[0].view.faces[0].exact[0].edges[0].r === 3);
  check('a cut face keeps the straight edges a dimension can show', exactBack.objects[0].view.faces[0].measures && exactBack.objects[0].view.faces[0].measures[0].k === 'line' && exactBack.objects[0].view.faces[0].measures[0].b[0] === 4);
  const keptCurve = exactBack.objects[0].view.faces[0].measures[1];
  check('a cut curve stays selectable after a save', keptCurve && keptCurve.k === 'curve' && keptCurve.mid[1] === 0.4 && keptCurve.pts.length === 3 && keptCurve.len === 2.2);
  const scaled = ModelCore.normalize({
    objects: [{ name: 'A', type: 'box', scale: [2, 0, -3] }],
    checkpoints: [{ name: 'Before', objects: [{ name: 'Old', type: 'sphere', brep: 'SHOULD_NOT_STAY' }] }],
    history: { past: Array.from({ length: 60 }, (_, i) => [{ name: 'H' + i, type: 'box' }]) },
  });
  const scaledBack = ModelCore.parseHtml(ModelCore.serializeToHtml(scaled, 'S'));
  check('scale is kept and a zero scale becomes the minimum', scaledBack.objects[0].scale[0] === 2 && scaledBack.objects[0].scale[1] === 0.05 && scaledBack.objects[0].scale[2] === -3);
  check('a body with no scale is full size', ModelCore.normalize({ objects: [{ name: 'A', type: 'box' }] }).objects[0].scale.join(',') === '1,1,1');
  check('a checkpoint survives a save without a rebuilt primitive', scaledBack.checkpoints.length === 1 && scaledBack.checkpoints[0].name === 'Before' && scaledBack.checkpoints[0].objects[0].type === 'sphere' && !scaledBack.checkpoints[0].objects[0].brep);
  check('undo keeps the last 50 steps', scaledBack.history.past.length === 50 && scaledBack.history.past[0][0].name === 'H10' && scaledBack.history.past[49][0].name === 'H59');
  const splitDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [{ op: 'split', origin: [0, 0, 5], normal: [1, 0, 0] }] }] });
  check('a face cut by a plane is saved', splitDoc.objects[0].features[0].op === 'split' && splitDoc.objects[0].features[0].origin[2] === 5 && splitDoc.objects[0].features[0].normal[0] === 1);
  const imprintDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [{ op: 'imprint', center: [0, 0, 10], normal: [0, 0, 1], cuts: [{ k: 'poly', pts: [[-8, 0, 10], [8, 0, 10]] }, { k: 'circle', c: [0, 0, 10], r: 2 }, { k: 'poly', pts: [[0, 0, 0]] }] }] }] });
  const savedCuts = imprintDoc.objects[0].features[0];
  check('a face partition is saved', savedCuts && savedCuts.op === 'imprint' && savedCuts.cuts.length === 2 && savedCuts.cuts[1].k === 'circle' && savedCuts.cuts[1].r === 2);
  const exactPush = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [{ op: 'push', loop: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], normal: [0, 0, 1], dist: -2, exact: true }] }] });
  check('an exact face extrude is saved', exactPush.objects[0].features[0].exact === true && exactPush.objects[0].features[0].dist === -2);
  const pathDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'sketch', profiles: [{ k: 'path', pts: [[0, 0], [4, 1]] }, { k: 'poly', pts: [[0, 0]] }] }] });
  check('an open cut line is saved and a short loop is not', pathDoc.objects[0].profiles.length === 1 && pathDoc.objects[0].profiles[0].k === 'path' && pathDoc.objects[0].profiles[0].pts[1][0] === 4);
  const cutDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'cut', cut: 'split', parts: [{ type: 'box', size: { x: 10, y: 10, z: 10 } }, { type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [6, 0, 0] }] }] });
  check('a body cut keeps which body and whether pieces stay', cutDoc.objects[0].type === 'cut' && cutDoc.objects[0].cut === 'split' && cutDoc.objects[0].parts.length === 2 && cutDoc.objects[0].parts[1].pos[0] === 6);
  const joinedCuts = ModelCore.cutRoles(['Joined', 'Cylinder'], 0);
  const cylinderCuts = ModelCore.cutRoles(['Joined', 'Cylinder'], 1);
  check('the named cutter is the tool', joinedCuts.tool === 'Joined' && joinedCuts.target === 'Cylinder' && cylinderCuts.tool === 'Cylinder' && cylinderCuts.target === 'Joined');
  const multiBarJs = fs.readFileSync(path.join(here, '..', '..', 'public', 'model', 'engine.js'), 'utf8');
  check('multi-select bottom menu offers join with cut', multiBarJs.includes('data-barjoin') && multiBarJs.includes('mdl-cutgroup') && multiBarJs.includes('data-cutbar') && multiBarJs.includes('n >= 2') && multiBarJs.includes('n === 2'));
  const piece = ModelCore.normalize({ objects: [{ name: 'Piece', type: 'solid', pos: [1, 2, 3], brep: '0123456789abcdefEXTRA', brepHash: 'abc' }] });
  check('a split piece is saved as its own solid', piece.objects[0].type === 'solid' && piece.objects[0].pos[0] === 1 && piece.objects[0].brep === '0123456789abcdefEXTRA' && piece.objects[0].brepHash === 'abc');
  const dimDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', dims: true }, { name: 'B', type: 'box' }, { name: 'C', type: 'box', dims: false }] });
  check('a new body shows dimensions and a hidden one stays hidden', dimDoc.objects[0].dims === true && !('dims' in dimDoc.objects[1]) && dimDoc.objects[2].dims === false);
  const arcOf = (r, a0, a1) => {
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const a = a0 + (a1 - a0) * i / 11;
      pts.push([r * Math.cos(a), r * Math.sin(a), 1]);
    }
    return pts;
  };
  const quarter = ModelCore.fitCircle(arcOf(5, 0, Math.PI / 2));
  const whole = ModelCore.fitCircle(arcOf(5, 0, Math.PI * 2));
  const square = ModelCore.fitCircle([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0], [5, 0, 0], [10, 5, 0], [5, 10, 0]]);
  check('a circular edge keeps its drawn diameter when it is only an arc', quarter && near(quarter.d, 10, 0.05) && whole && near(whole.d, 10, 0.05) && !square, quarter && whole && (quarter.d.toFixed(2) + ' / ' + whole.d.toFixed(2)));
  const placeAt = (rot, scale) => (p) => ModelCore.placePoint(p, [0, 0, 0], rot, scale);
  const turned = [-90, 0, 180];
  const scaledCircle = ModelCore.drawnMeasure(
    { k: 'circle', c: [0, 0, 4], r: 5, n: [0, 0, 1], len: 31.4 },
    placeAt(turned, [2, 2, 1]),
  );
  check('a scaled circle is not labeled with its local radius', scaledCircle && scaledCircle.kind === 'diameter' && near(scaledCircle.value, 20, 0.05) && Math.abs(scaledCircle.value - 10) > 1, scaledCircle && scaledCircle.value);
  const scaledEdge = ModelCore.drawnMeasure(
    { k: 'line', a: [0, 0, 0], b: [0, 10, 0], len: 99 },
    placeAt(turned, [1, 1.194, 1]),
  );
  check('a stretched edge is not labeled with its stored length', scaledEdge && scaledEdge.kind === 'length' && near(scaledEdge.value, 11.94, 0.05) && Math.abs(scaledEdge.value - 99) > 1 && Math.abs(scaledEdge.value - 10) > 0.5, scaledEdge && scaledEdge.value);
  const quarterArc = ModelCore.drawnMeasure(
    { k: 'arc', a: [5, 0, 0], mid: [5 * Math.cos(Math.PI / 4), 5 * Math.sin(Math.PI / 4), 0], b: [0, 5, 0], r: 5, len: 7.85 },
    placeAt(turned, [1, 1, 1]),
  );
  check('a round arc is not labeled with its chord', quarterArc && quarterArc.kind === 'diameter' && near(quarterArc.value, 10, 0.05) && Math.abs(quarterArc.value - 7.07) > 0.5 && Math.abs(quarterArc.value - 7.85) > 0.5, quarterArc && quarterArc.value);
  const straightCurve = ModelCore.drawnMeasure(
    { k: 'curve', a: [0, 0, 0], b: [10, 0, 0], mid: [5, 0, 0], pts: [[0, 0, 0], [2, 0, 0], [4, 0, 0], [6, 0, 0], [8, 0, 0], [10, 0, 0]], len: 25 },
    placeAt(turned, [1, 1.194, 1]),
  );
  check('a straight curve is not labeled with its stored length', straightCurve && straightCurve.kind === 'length' && near(straightCurve.value, 10, 0.05) && Math.abs(straightCurve.value - 25) > 1, straightCurve && straightCurve.value);
  const bent = ModelCore.drawnMeasure(
    { k: 'curve', a: [0, 0, 0], b: [6, 0, 0], mid: [3, 4, 0], pts: [[0, 0, 0], [3, 4, 0], [6, 0, 0]], len: 100 },
    placeAt([0, 0, 0], [1, 1, 1]),
  );
  check('a bent edge is not labeled with its chord', bent && bent.kind === 'length' && near(bent.value, 10, 0.05) && Math.abs(bent.value - 6) > 1 && Math.abs(bent.value - 100) > 1, bent && bent.value);
  const ellipsePts = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    ellipsePts.push([3 * Math.cos(a), 3 / 1.194 * Math.sin(a), 0]);
  }
  const drawnHole = ModelCore.drawnMeasure(
    { k: 'curve', pts: ellipsePts, len: 18, r: 3 },
    placeAt(turned, [1, 1.194, 1]),
  );
  check('a stretched hole is not labeled with its local radius or its curve length', drawnHole && drawnHole.kind === 'diameter' && near(drawnHole.value, 6, 0.05) && Math.abs(drawnHole.value - 18) > 1 && Math.abs(drawnHole.value - 3) > 1, drawnHole && drawnHole.value);
  const stretchedCircle = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    stretchedCircle.push([5 * Math.cos(a), 5 / 1.194 * Math.sin(a), 0]);
  }
  const drawnFlat = ModelCore.fitCircle(stretchedCircle.map((p) => ModelCore.placePoint(p, [0, 0, 0], [0, 0, 0], [1, 1.194, 1])));
  const drawnTurn = ModelCore.fitCircle(stretchedCircle.map((p) => ModelCore.placePoint(p, [0, 0, 0], [-90, 0, 180], [1, 1.194, 1])));
  check('a stretched circle is measured where it is drawn', drawnFlat && near(drawnFlat.d, 10, 0.05) && drawnTurn && near(drawnTurn.d, 10, 0.05), drawnFlat && drawnTurn && (drawnFlat.d.toFixed(2) + ' / ' + drawnTurn.d.toFixed(2)));
  const lengthDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [
    { op: 'length', at: [0, 0, 5], dir: [2, 0, 0], delta: 4 },
    { op: 'length', scope: 'edge', at: [0, 0, 5], dir: [0, 1, 0], delta: -2 },
  ] }] });
  const lengthFeatures = lengthDoc.objects[0].features;
  check('a length edit is every parallel edge', lengthFeatures[0].op === 'length' && lengthFeatures[0].scope === 'parallel' && lengthFeatures[0].delta === 4 && lengthFeatures[0].dir[0] === 1);
  check('an old single-edge length still loads', lengthFeatures[1].scope === 'edge' && lengthFeatures[1].delta === -2);
  const edited = ModelCore.lengthDelta(11.94, 20, [0, 1, 0], [1, 1.194, 1]);
  const editedLen = (rot) => {
    const a = ModelCore.placePoint([0, -5, 0], [0, 0, 0], rot, [1, 1.194, 1]);
    const b = ModelCore.placePoint([0, -5 + 10 + edited, 0], [0, 0, 0], rot, [1, 1.194, 1]);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  };
  check('an edited length is the length on screen after the stretch turns', near(editedLen([0, 0, 0]), 20, 0.05) && near(editedLen([-90, 0, 180]), 20, 0.05), editedLen([0, 0, 0]).toFixed(2) + ' / ' + editedLen([-90, 0, 180]).toFixed(2));
  check('opposite edges count as parallel', ModelCore.sameDirection([1, 0, 0], [-1, 0, 0]) && !ModelCore.sameDirection([1, 0, 0], [0, 1, 0]));
  const hiddenFirst = ModelCore.pickDim([
    { key: 'back', facing: false, open: false },
    { key: 'front', facing: true, open: true },
  ]);
  const cutRim = ModelCore.pickDim([{ key: 'hole', facing: false, open: true }]);
  const noneOpen = ModelCore.pickDim([
    { key: 'a', facing: true, open: false },
    { key: 'b', facing: false, open: false },
  ]);
  const facingWins = ModelCore.pickDim([
    { key: 'a', facing: false, open: true },
    { key: 'b', facing: true, open: true },
  ]);
  check('a dimension uses an edge the camera can see', hiddenFirst === 'front' && cutRim === 'hole' && noneOpen == null && facingWins === 'b');
  const sameLenA = ModelCore.dimGroupKey(10, [1, 0, 0]);
  const sameLenB = ModelCore.dimGroupKey(10, [-1, 0, 0]);
  const otherLen = ModelCore.dimGroupKey(12, [1, 0, 0]);
  const rimA = ModelCore.dimGroupKey(10, [0, 0, 1], [0, 0, 0]);
  const rimB = ModelCore.dimGroupKey(10, [0, 0, 1], [0, 0, 20]);
  check('edges of one length share one dimension', sameLenA === sameLenB && sameLenA !== otherLen && rimA !== rimB);
  check('drop to floor puts the lowest point on z 0', ModelCore.floorShift(4.2) === -4.2 && ModelCore.floorShift(-3) === 3 && ModelCore.floorShift(0) === 0 && ModelCore.floorShift(1.5, 0) === -1.5);
  const hideList = [{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }];
  ModelCore.setAllHidden(hideList, true);
  const allHidden = hideList.every((o) => o.hidden === true);
  ModelCore.setAllHidden(hideList, false);
  check('hide all and show all cover every body', allHidden && hideList.every((o) => !('hidden' in o)));
  // The view sat stuck when a drag ended on a menu, or when a dimension label
  // ate the right-drag and trackpad turn. Keep both contracts in the suite.
  const viewFree = ModelCore.navIdle({}) && ModelCore.navIdle({ dragging: false, sketch: false, face: false }) && ModelCore.navIdle(null);
  const viewHeld = !ModelCore.navIdle({ dragging: true }) && !ModelCore.navIdle({ sketch: true }) && !ModelCore.navIdle({ face: true }) && !ModelCore.navIdle({ dragging: true, sketch: true });
  check('the view can turn again after a drag ends on a menu', viewFree && viewHeld);
  const dimEdits = ModelCore.dimPressEdits(0, 'mouse') && ModelCore.dimPressEdits(0, 'pen') && ModelCore.dimPressEdits(0, 'touch');
  // Right and middle mouse on a label must reach the view. Pen and touch edit
  // on their primary press; they do not use those mouse buttons.
  const dimLeavesOrbit = !ModelCore.dimPressEdits(2, 'mouse') && !ModelCore.dimPressEdits(1, 'mouse');
  check('a dimension label does not steal the view turn', dimEdits && dimLeavesOrbit);
  check('the view still turns when a drag ends on a dimension label', viewFree && dimLeavesOrbit && ModelCore.dimPressEdits(0, 'mouse'));
  // Dimensions edit on double-click so a single press still places a sketch point.
  const dimEditJs = fs.readFileSync(path.join(here, '..', '..', 'public', 'model', 'engine.js'), 'utf8');
  check('a dimension edits on double-click only', dimEditJs.includes('_dimArmEdit') && dimEditJs.includes('_openDimEdit(el)') && dimEditJs.includes('_openSketchMeasEdit(el)') && dimEditJs.includes('el.textContent !== it.text') && !/addEventListener\('pointerdown'[\s\S]{0,180}_openDimEdit/.test(dimEditJs));
  check('a sketch dimension edit stays on that segment', dimEditJs.includes('_applySketchMove') && dimEditJs.includes('shares coordinates') && !dimEditJs.includes('_rewriteSketchPoint'));
  // A line press places one point. Drag must not write start and end together.
  check('a sketch line places one point at a time', dimEditJs.includes('Lines are click-to-click') && dimEditJs.includes('invent the start and end together') && !/tool === 'line'\) \{\s*const a = d\.p0, b = d\.p;\s*if \(Math\.hypot\(b\[0\] - a\[0\], b\[1\] - a\[1\]\) >= 0\.05\) this\.sk\.profiles\.push\(\{ k: 'path'/.test(dimEditJs));
  const onLine = ModelCore.sketchSnapToLines([3, 0.3], [{ a: [0, 0], b: [10, 0] }], { tol: 1 });
  const onEnd = ModelCore.sketchSnapToLines([0.2, 0.2], [{ a: [0, 0], b: [10, 0] }], { tol: 1 });
  const onMid = ModelCore.sketchSnapToLines([5.1, 0.2], [{ a: [0, 0], b: [10, 0] }], { tol: 1 });
  check('a sketch point snaps onto a line', onLine.snapped && onLine.kind === 'line' && near(onLine.point[1], 0, 1e-6) && onEnd.snapped && onEnd.kind === 'end' && onMid.snapped && onMid.kind === 'mid' && near(onMid.point[0], 5, 1e-6));
  check('face mode defaults to extrude, not cut by plane', ModelCore.faceTool() === 'extrude' && ModelCore.faceTool('extrude') === 'extrude' && ModelCore.faceTool('cut') === 'cut' && !ModelCore.faceCutPlaneOn('extrude') && ModelCore.faceCutPlaneOn('cut') && !ModelCore.faceCutPlaneOn());
  // Sketch from a face outline must open an editable sketch (rect/circle/poly), not fail closed.
  const outlineRect = ModelCore.faceOutlineProfiles([{ edges: [
    { k: 'line', a: [0, 0], b: [10, 0] }, { k: 'line', a: [10, 0], b: [10, 6] },
    { k: 'line', a: [10, 6], b: [0, 6] }, { k: 'line', a: [0, 6], b: [0, 0] },
  ] }]);
  const outlineCircle = ModelCore.faceOutlineProfiles([{ edges: [{ k: 'circle', c: [1, 2], r: 4 }] }]);
  const outlinePoly = ModelCore.faceOutlineProfiles([{ edges: [
    { k: 'line', a: [0, 0], b: [4, 1] }, { k: 'line', a: [4, 1], b: [2, 5] }, { k: 'line', a: [2, 5], b: [0, 0] },
  ] }]);
  check('a face outline becomes an editable sketch', outlineRect[0].k === 'rect' && near(outlineRect[0].w, 10, 1e-6) && near(outlineRect[0].h, 6, 1e-6) && outlineCircle[0].k === 'circle' && near(outlineCircle[0].r, 4, 1e-6) && outlinePoly[0].k === 'poly' && outlinePoly[0].pts.length === 3);
  // Dimension values stay upright on a soft chip; the measure line shows direction.
  const dimCss = fs.readFileSync(path.join(here, '..', '..', 'public', 'model', 'engine.css'), 'utf8');
  const dimJs = fs.readFileSync(path.join(here, '..', '..', 'public', 'model', 'engine.js'), 'utf8');
  const chipStyle = dimCss.includes('--mdl-dim-chip') && dimCss.includes('.mdl-dim') && dimCss.includes('border-radius: 999px') && !/text-shadow:\s*[\s\S]*0 0 2px var\(--mdl-bg\)/.test(dimCss);
  const uprightOk = dimJs.includes("el.style.transform = 'translate(-50%, -50%)'") && !/translate\(-50%, -50%\) rotate\(/.test(dimJs);
  check('dimension labels stay upright on chips', chipStyle && uprightOk, chipStyle ? (uprightOk ? '' : 'js') : 'css');
  // Selected edges stay a bright thick mark (WebGL lines are 1px; a thin tube is ~2×).
  const edgeMarkJs = fs.readFileSync(path.join(here, '..', '..', 'public', 'model', 'engine.js'), 'utf8');
  check('a selected edge is drawn as a bright thick mark', edgeMarkJs.includes('TubeGeometry') && edgeMarkJs.includes('0xff9a2e') && !edgeMarkJs.includes('_edgeHoverAt') && !edgeMarkJs.includes('_edgeMarkGroup'));
  const edgeDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', features: [
    { op: 'fillet', at: [0, 5, 10], r: 1 },
    { op: 'chamfer', at: [0, -5, 10], r: 0.5 },
  ] }] });
  const edgeFeatures = edgeDoc.objects[0].features;
  check('a round and a chamfer are saved on the edge', edgeFeatures.length === 2 && edgeFeatures[0].op === 'fillet' && edgeFeatures[0].r === 1 && edgeFeatures[1].op === 'chamfer' && edgeFeatures[1].r === 0.5);
  const hiddenDoc = ModelCore.normalize({ objects: [{ name: 'A', type: 'box', hidden: true }, { name: 'B', type: 'cylinder' }] });
  check('a hidden body stays hidden and the other stays visible', hiddenDoc.objects[0].hidden === true && !hiddenDoc.objects[1].hidden);
  // Sketch lines show length and angle, snap near 90°, and can be edited.
  const prevDir = [1, 0];
  const perpAt = ModelCore.sketchPerpPoint([10, 0], prevDir, [14, 6]);
  check('a perpendicular line leaves the previous direction', near(perpAt[0], 10, 1e-6) && near(perpAt[1], 6, 1e-6) && Math.abs(prevDir[0] * (perpAt[0] - 10) + prevDir[1] * (perpAt[1] - 0)) < 1e-6);
  const ang = ModelCore.sketchAngleBetween([1, 0], [0, 1]);
  check('the angle between sketch lines is measured', near(ang, 90, 1e-6) && near(ModelCore.sketchSegLen([0, 0], [3, 4]), 5, 1e-6));
  const snap90 = ModelCore.sketchSnapPoint([0, 0], [1, 0], [0.2, 4], { tol: 10 });
  check('a sketch line snaps near 90°', snap90.snapped && (snap90.kind === 'perp' || snap90.kind === 'axis') && near(snap90.point[0], 0, 0.05) && near(Math.abs(snap90.angle), 90, 0.6));
  const lenEdit = ModelCore.sketchSetSegLen([0, 0], [3, 4], 10);
  const angEdit = ModelCore.sketchSetAngle([0, 0], [1, 0], 90, 5);
  check('a sketch length and angle can be edited', near(ModelCore.sketchSegLen([0, 0], lenEdit), 10, 1e-6) && near(angEdit[0], 0, 1e-6) && near(angEdit[1], 5, 1e-6));
  // A cut snapped onto the outline shares a coordinate. Editing that cut must
  // not rewrite the outline point that happens to sit at the same place.
  const outline = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const cut = [[0, 0], [4, 3]];
  const cutNext = ModelCore.sketchEditSegLen(cut, 0, 1, 10);
  check('editing one sketch length leaves other paths alone', near(ModelCore.sketchSegLen(cutNext[0], cutNext[1]), 10, 1e-6) && outline[0][0] === 0 && outline[0][1] === 0 && cut[1][0] === 4 && cut[1][1] === 3 && (cutNext[1][0] !== 4 || cutNext[1][1] !== 3));
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
{
  const base = await send({ type: 'build', objects: [
    { id: 'cyl', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 } },
  ] });
  const cyl = (base.bodies || [])[0];
  const top = cyl && (cyl.faces || []).find((f) => f.normal && f.normal[2] > 0.9 && f.exact);
  const cut = top && await send({ type: 'build', objects: [{
    id: 'cyl2', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 },
    features: [{ op: 'push', loop: top.loop, normal: top.normal, center: top.center, dist: -3, exact: true }],
  }] });
  const body = cut && (cut.bodies || [])[0];
  const cap = body && (body.faces || []).find((f) => f.normal && f.normal[2] > 0.9 && f.center && f.center[2] > 6 && f.center[2] < 8);
  const capEdges = cap && cap.exact && cap.exact[0] && cap.exact[0].edges;
  const curveOnly = capEdges && capEdges.every((e) => e.k === 'circle' || e.k === 'arc');
  check('cutting a round face keeps the curve and does not leave lines', body && body.vertices && near(volume(body.vertices, body.triangles), Math.PI * 100 * 7, 40) && curveOnly && capEdges.length <= 2, body && (body.error || (body.notes && body.notes.join('; ')) || (capEdges && capEdges.map((e) => e.k).join(','))));
  const missed = top && await send({ type: 'build', objects: [{
    id: 'cyl3', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 },
    features: [{ op: 'push', loop: top.loop, normal: top.normal, center: [0, 0, 0], dist: -3, exact: true }],
  }] });
  const kept = missed && (missed.bodies || [])[0];
  check('a curve is left unchanged instead of being cut as a polygon', kept && kept.vertices && near(volume(kept.vertices, kept.triangles), Math.PI * 100 * 10, 40) && kept.notes && kept.notes.some((t) => t.indexOf('polyline') >= 0), kept && (kept.error || (kept.notes && kept.notes.join('; ')) || (kept.vertices && volume(kept.vertices, kept.triangles))));
  const arcs = await send({ type: 'build', objects: [{
    id: 'arcs', kernel: 'brep', type: 'sketch', height: -4, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'exact', wires: [{ edges: [
      { k: 'arc', a: [10, 0], b: [-10, 0], mid: [0, 10] },
      { k: 'arc', a: [-10, 0], b: [10, 0], mid: [0, -10] },
    ] }] }],
  }] });
  const arcBody = (arcs.bodies || [])[0];
  const arcCap = arcBody && (arcBody.faces || []).find((f) => f.exact && f.exact[0] && f.exact[0].edges && f.exact[0].edges.some((e) => e.k === 'circle' || e.k === 'arc'));
  const arcEdges = arcCap && arcCap.exact[0].edges;
  check('a circle stored as arcs extrudes as a circle, with no closing line', arcBody && arcBody.vertices && near(volume(arcBody.vertices, arcBody.triangles), Math.PI * 100 * 4, 40) && arcEdges && arcEdges.every((e) => e.k !== 'line'), arcBody && (arcBody.error || (arcEdges && arcEdges.map((e) => e.k).join(','))));
  const corner = await send({ type: 'build', objects: [{
    id: 'corner', kernel: 'brep', type: 'sketch', height: -2, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'exact', wires: [{ edges: [
      { k: 'line', a: [0, 0], b: [10, 0] },
      { k: 'arc', a: [10, 0], b: [12, 2], mid: [11.414, 0.586] },
      { k: 'line', a: [12, 2], b: [12, 8] },
      { k: 'line', a: [12, 8], b: [0, 8] },
      { k: 'line', a: [0, 8], b: [0, 0] },
    ] }] }],
  }] });
  const cornerBody = (corner.bodies || [])[0];
  const cornerCap = cornerBody && (cornerBody.faces || []).find((f) => f.exact && f.exact[0] && f.exact[0].edges && f.exact[0].edges.some((e) => e.k === 'arc'));
  const cornerEdges = cornerCap && cornerCap.exact[0].edges;
  const cornerLines = cornerEdges ? cornerEdges.filter((e) => e.k === 'line').length : 0;
  check('a rounded corner keeps its arc and gains no extra line', cornerBody && cornerBody.vertices && cornerEdges && cornerEdges.some((e) => e.k === 'arc') && cornerLines === 4, cornerBody && (cornerBody.error || (cornerEdges && cornerEdges.map((e) => e.k).join(','))));

  const part = (pos) => ({ id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos, rot: [0, 0, 0], features: [] });
  const cutGone = await send({ type: 'build', objects: [{ id: 'del', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts: [part([0, 0, 0]), part([6, 0, 0])] }] });
  const cutGoneBody = (cutGone.bodies || [])[0];
  check('delete removes the overlap of the other body', cutGoneBody && cutGoneBody.vertices && near(volume(cutGoneBody.vertices, cutGoneBody.triangles), 600, 1), cutGoneBody && (cutGoneBody.error || (cutGoneBody.vertices && volume(cutGoneBody.vertices, cutGoneBody.triangles))));
  const cutKept = await send({ type: 'build', objects: [{ id: 'spl', kernel: 'brep', type: 'cut', cut: 'split', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts: [part([0, 0, 0]), part([6, 0, 0])] }] });
  const cutKeptBody = (cutKept.bodies || [])[0];
  const splitPieces = cutKeptBody && cutKeptBody.pieces && cutKeptBody.pieces.length >= 2 ? [cutKeptBody, ...cutKeptBody.pieces.slice(1)] : [];
  const splitVols = splitPieces.map((p) => p.vertices ? volume(p.vertices, p.triangles) : 0);
  const splitSum = splitVols.reduce((a, b) => a + b, 0);
  check('split makes each piece its own solid', splitPieces.length >= 2 && splitVols.every((v) => v > 50 && v < 950) && near(splitSum, 1000, 2) && splitPieces.every((p) => p.brep && p.brep.length > 16), cutKeptBody && (cutKeptBody.error || (cutKeptBody.notes && cutKeptBody.notes.join('; ')) || (splitVols.join('+') + '=' + splitSum)));

  const moved = await send({ type: 'build', objects: [{
    id: 'moved', kernel: 'brep', type: 'cut', cut: 'delete', pos: [10, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], features: [],
    parts: [part([10, 0, 0]), part([14, 0, 0])],
  }] });
  const movedBody = (moved.bodies || [])[0];
  const movedBox = movedBody && movedBody.vertices && bounds(movedBody.vertices);
  check('a moved cut stays in the target frame', movedBody && movedBody.vertices && !movedBody.error && near(volume(movedBody.vertices, movedBody.triangles), 400, 1) && movedBox.lo[0] > -6 && movedBox.hi[0] < 0, movedBody && (movedBody.error || (movedBox && (movedBox.lo[0].toFixed(2) + '..' + movedBox.hi[0].toFixed(2) + ' vol ' + volume(movedBody.vertices, movedBody.triangles)))));
  const apart = await send({ type: 'build', objects: [{
    id: 'apart', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], features: [],
    parts: [part([0, 0, 0]), part([30, 0, 0])],
  }] });
  const apartBody = (apart.bodies || [])[0];
  check('bodies that miss are reported and left unmoved', apartBody && apartBody.vertices && near(volume(apartBody.vertices, apartBody.triangles), 1000, 1) && apartBody.notes && apartBody.notes.some((t) => t.indexOf('do not overlap') >= 0) && bounds(apartBody.vertices).hi[0] < 6, apartBody && (apartBody.error || (apartBody.notes && apartBody.notes.join('; ')) || (apartBody.vertices && volume(apartBody.vertices, apartBody.triangles))));
  const turned = await send({ type: 'build', objects: [{
    id: 'turned', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 90], scale: [1, 1, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 20, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 90], features: [] },
      part([0, 8, 0]),
    ],
  }] });
  const turnedBody = (turned.bodies || [])[0];
  const turnedBox = turnedBody && turnedBody.vertices && bounds(turnedBody.vertices);
  check('a rotated cut is returned in the target frame', turnedBody && turnedBody.vertices && !turnedBody.error && near(volume(turnedBody.vertices, turnedBody.triangles), 1300, 2) && turnedBox.hi[1] < 6 && turnedBox.lo[0] < -8, turnedBody && (turnedBody.error || (turnedBox && ('x ' + turnedBox.lo[0].toFixed(2) + '..' + turnedBox.hi[0].toFixed(2) + ' y ' + turnedBox.lo[1].toFixed(2) + '..' + turnedBox.hi[1].toFixed(2) + ' vol ' + volume(turnedBody.vertices, turnedBody.triangles)))));
  const tilted = await send({ type: 'build', objects: [{
    id: 'tilted', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 90, -90], scale: [1, 1, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 90, -90], features: [] },
      part([0, -8, 0]),
    ],
  }] });
  const tiltedBody = (tilted.bodies || [])[0];
  const tiltedBox = tiltedBody && tiltedBody.vertices && bounds(tiltedBody.vertices);
  check('a cut uses the same turn as the viewer', tiltedBody && tiltedBody.vertices && !tiltedBody.error && !(tiltedBody.notes || []).some((t) => t.indexOf('overlap') >= 0) && near(volume(tiltedBody.vertices, tiltedBody.triangles), 650, 2) && tiltedBox.lo[1] > -6 && tiltedBox.hi[2] < 11 && tiltedBox.lo[2] > -1, tiltedBody && (tiltedBody.error || ((tiltedBody.notes || []).join('; ')) || (tiltedBox && ('y ' + tiltedBox.lo[1].toFixed(2) + '..' + tiltedBox.hi[1].toFixed(2) + ' z ' + tiltedBox.lo[2].toFixed(2) + '..' + tiltedBox.hi[2].toFixed(2) + ' vol ' + volume(tiltedBody.vertices, tiltedBody.triangles)))));

  const raised = await send({ type: 'build', objects: [{
    id: 'raised', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], features: [],
    parts: [part([0, 0, 0]), part([0, 0, 6])],
  }] });
  const raisedBody = (raised.bodies || [])[0];
  const raisedBox = raisedBody && raisedBody.vertices && bounds(raisedBody.vertices);
  check('a cut shifted in z keeps that z', raisedBody && raisedBody.vertices && !raisedBody.error && !(raisedBody.notes || []).length && near(volume(raisedBody.vertices, raisedBody.triangles), 600, 1) && near(raisedBox.lo[2], 0, 0.05) && near(raisedBox.hi[2], 6, 0.15), raisedBody && (raisedBody.error || ((raisedBody.notes || []).join('; ')) || (raisedBox && ('z ' + raisedBox.lo[2].toFixed(2) + '..' + raisedBox.hi[2].toFixed(2) + ' vol ' + volume(raisedBody.vertices, raisedBody.triangles)))));

  const stretched = await send({ type: 'build', objects: [{
    id: 'stretched', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 2, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 2, 1], features: [] },
      part([0, 0, 0]),
    ],
  }] });
  const stretchedBody = (stretched.bodies || [])[0];
  const stretchedBox = stretchedBody && stretchedBody.vertices && bounds(stretchedBody.vertices);
  check('a stretched body is cut where it is drawn', stretchedBody && stretchedBody.vertices && !stretchedBody.error && !(stretchedBody.notes || []).some((t) => t.indexOf('overlap') >= 0) && near(volume(stretchedBody.vertices, stretchedBody.triangles), 500, 2) && stretchedBox.hi[1] > 4 && stretchedBox.lo[1] < -4, stretchedBody && (stretchedBody.error || ((stretchedBody.notes || []).join('; ')) || (stretchedBox && ('y ' + stretchedBox.lo[1].toFixed(2) + '..' + stretchedBox.hi[1].toFixed(2) + ' vol ' + volume(stretchedBody.vertices, stretchedBody.triangles)))));
  const stretchLens = lineLengths(stretchedBody);
  check('a stretched cut still has the edges a dimension can show', hasLen(stretchLens, 10, 0.05) && hasLen(stretchLens, 2.5, 0.15), stretchLens.map((v) => v.toFixed(2)).slice(0, 20).join(','));
  const slanted = await send({ type: 'build', objects: [{
    id: 'slanted', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], features: [],
    parts: [
      part([0, 0, 0]),
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 40 }, pos: [-8, 0, 2], rot: [0, 45, 0], features: [] },
    ],
  }] });
  const slantedBody = (slanted.bodies || [])[0];
  const slantLens = lineLengths(slantedBody);
  check('a cut that is not a circle keeps the straight edges', slantedBody && slantedBody.vertices && !slantedBody.error && !(slantedBody.notes || []).some((t) => t.indexOf('overlap') >= 0) && hasLen(slantLens, 10, 0.05), slantedBody && (slantedBody.error || ((slantedBody.notes || []).join('; ')) || slantLens.map((v) => v.toFixed(2)).slice(0, 16).join(',')));
  const slantCurves = curveEdges(slantedBody);
  check('the new cut edge can be selected', slantCurves.some((e) => e.mid && e.pts && e.pts.length >= 4 && e.len > 2), slantCurves.map((e) => e.k + ':' + (e.len || 0).toFixed(1)).join(','));

  const ellipse = await send({ type: 'build', objects: [{
    id: 'ell', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const ellipseBody = (ellipse.bodies || [])[0];
  const ellipseEdge = curveEdges(ellipseBody).find((e) => e.k === 'curve' && e.mid && e.len > 5);
  const ellipseVol = ellipseBody && ellipseBody.vertices && volume(ellipseBody.vertices, ellipseBody.triangles);
  check('a stretched cut leaves the new edge', ellipseBody && !ellipseBody.error && ellipseEdge && ellipseEdge.pts.length >= 8, ellipseBody && (ellipseBody.error || ((ellipseBody.notes || []).join('; ')) || curveEdges(ellipseBody).map((e) => e.k).join(',')));
  const drawn = ellipseEdge && ModelCore.fitCircle(ellipseEdge.pts.map((p) => ModelCore.placePoint(p, [0, 0, 0], [0, 0, 0], [1, 1.194, 1])));
  const drawnTurned = ellipseEdge && ModelCore.fitCircle(ellipseEdge.pts.map((p) => ModelCore.placePoint(p, [0, 0, 0], [-90, 0, 180], [1, 1.194, 1])));
  check('the cutter diameter is the diameter on the drawn edge', drawn && near(drawn.d, 6, 0.25) && drawnTurned && near(drawnTurned.d, 6, 0.25), (drawn && drawn.d) + ' / ' + (drawnTurned && drawnTurned.d));
  const rounded = ellipseEdge && await send({ type: 'build', objects: [{
    id: 'ell2', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1],
    features: [{ op: 'fillet', at: ellipseEdge.mid, r: 0.3 }],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const roundedBody = rounded && (rounded.bodies || [])[0];
  const roundedVol = roundedBody && roundedBody.vertices && volume(roundedBody.vertices, roundedBody.triangles);
  check('rounding the new cut edge changes that edge', roundedBody && roundedBody.vertices && !roundedBody.error && !(roundedBody.notes || []).some((t) => t.indexOf('could not be changed') >= 0) && ellipseVol - roundedVol > 0.15 && curveEdges(roundedBody).length > 0, roundedBody && (roundedBody.error || ((roundedBody.notes || []).join('; ')) || (ellipseVol && roundedVol && ('vol ' + ellipseVol.toFixed(1) + ' -> ' + roundedVol.toFixed(1)))));

  const turnedScale = [-90, 0, 180];
  const turnedStretch = await send({ type: 'build', objects: [{
    id: 'zstretch', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: turnedScale, scale: [1, 2, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: turnedScale, scale: [1, 2, 1], features: [] },
      part([0, -5, 8]),
    ],
  }] });
  const turnedStretchBody = (turnedStretch.bodies || [])[0];
  const turnedWorld = turnedStretchBody && turnedStretchBody.vertices && worldBounds(turnedStretchBody.vertices, [0, 0, 0], turnedScale, [1, 2, 1]);
  check('a stretch turned onto z is cut on that z', turnedStretchBody && turnedStretchBody.vertices && !turnedStretchBody.error && !(turnedStretchBody.notes || []).some((t) => t.indexOf('overlap') >= 0) && near(volume(turnedStretchBody.vertices, turnedStretchBody.triangles), 900, 3) && turnedWorld && near(turnedWorld.hi[2], 8, 0.2) && turnedWorld.lo[2] < -9, turnedStretchBody && (turnedStretchBody.error || ((turnedStretchBody.notes || []).join('; ')) || (turnedWorld && ('z ' + turnedWorld.lo[2].toFixed(2) + '..' + turnedWorld.hi[2].toFixed(2) + ' vol ' + volume(turnedStretchBody.vertices, turnedStretchBody.triangles)))));
}

function lineEdges(body) {
  const out = [];
  for (const f of (body && body.faces) || []) {
    const groups = (f.exact && f.exact.length) ? f.exact.map((w) => w.edges || []) : [f.measures || []];
    for (const edges of groups) for (const e of edges) {
      if (!e || e.k !== 'line' || !e.a || !e.b) continue;
      const d = [e.b[0] - e.a[0], e.b[1] - e.a[1], (e.b[2] || 0) - (e.a[2] || 0)];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len < 0.2) continue;
      out.push({
        len, d, a: e.a, b: e.b,
        mid: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, ((e.a[2] || 0) + (e.b[2] || 0)) / 2],
      });
    }
  }
  return out;
}
function axisLens(body, axis) {
  return lineEdges(body).filter((e) => Math.abs(e.d[axis]) > 0.98 * e.len).map((e) => e.len);
}
{
  const base = await send({ type: 'build', objects: [{ id: 'box', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [] }] });
  const box = (base.bodies || [])[0];
  const xEdge = lineEdges(box).find((e) => Math.abs(e.d[0]) > 0.98 * e.len && e.len > 9);
  const one = xEdge && await send({ type: 'build', objects: [{
    id: 'one', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'length', scope: 'edge', at: xEdge.mid, dir: [1, 0, 0], delta: 4 }],
  }] });
  const oneBody = one && (one.bodies || [])[0];
  const oneX = oneBody && axisLens(oneBody, 0);
  check('editing one edge leaves the parallel edges', oneBody && oneBody.vertices && !oneBody.error && !(oneBody.notes || []).length && hasLen(oneX, 14, 0.3) && hasLen(oneX, 10, 0.15) && near(volume(oneBody.vertices, oneBody.triangles), 1000 + 200 / 3, 8), oneBody && (oneBody.error || ((oneBody.notes || []).join('; ')) || (oneX && oneX.map((v) => v.toFixed(1)).slice(0, 12).join(',')) || (oneBody && volume(oneBody.vertices, oneBody.triangles))));
  const all = xEdge && await send({ type: 'build', objects: [{
    id: 'all', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'length', scope: 'parallel', at: xEdge.mid, dir: [1, 0, 0], delta: 4 }],
  }] });
  const allBody = all && (all.bodies || [])[0];
  const allX = allBody && axisLens(allBody, 0);
  const allBox = allBody && allBody.vertices && bounds(allBody.vertices);
  check('editing parallel edges changes every edge in that direction', allBody && allBody.vertices && !allBody.error && !(allBody.notes || []).length && allX.length > 0 && allX.every((v) => near(v, 14, 0.3)) && near(volume(allBody.vertices, allBody.triangles), 1400, 8) && near(Math.max(Math.abs(allBox.lo[0]), Math.abs(allBox.hi[0])), 9, 0.2), allBody && (allBody.error || ((allBody.notes || []).join('; ')) || (allX && allX.map((v) => v.toFixed(1)).slice(0, 8).join(',')) || (allBox && allBox.hi[0])));

  const stepParts = [
    { id: 'a', kernel: 'brep', type: 'box', size: { x: 20, y: 10, z: 5 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    { id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 5 }, pos: [5, 0, 5], rot: [0, 0, 0], features: [] },
  ];
  const step = await send({ type: 'build', objects: [{ id: 'step', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts: stepParts }] });
  const stepBody = (step.bodies || [])[0];
  const top = lineEdges(stepBody).find((e) => Math.abs(e.d[0]) > 0.98 * e.len && near(e.len, 10, 0.2) && e.mid[2] > 9);
  const stepOne = top && await send({ type: 'build', objects: [{
    id: 'step1', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
    features: [{ op: 'length', scope: 'edge', at: top.mid, dir: [1, 0, 0], delta: 4 }],
    parts: stepParts,
  }] });
  const stepOneBody = stepOne && (stepOne.bodies || [])[0];
  const stepOneX = stepOneBody && axisLens(stepOneBody, 0);
  check('one edge of a step does not change the other parallel edges', stepOneBody && stepOneBody.vertices && !stepOneBody.error && !(stepOneBody.notes || []).length && hasLen(stepOneX, 14, 0.35) && hasLen(stepOneX, 20, 0.35) && !hasLen(stepOneX, 24, 0.35), stepOneBody && (stepOneBody.error || ((stepOneBody.notes || []).join('; ')) || (stepOneX && stepOneX.map((v) => v.toFixed(1)).slice(0, 16).join(','))));
  const stepAll = top && await send({ type: 'build', objects: [{
    id: 'step2', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
    features: [{ op: 'length', scope: 'parallel', at: top.mid, dir: [1, 0, 0], delta: 4 }],
    parts: stepParts,
  }] });
  const stepAllBody = stepAll && (stepAll.bodies || [])[0];
  const stepAllX = stepAllBody && axisLens(stepAllBody, 0);
  check('parallel edges of a step change together', stepAllBody && stepAllBody.vertices && !stepAllBody.error && !(stepAllBody.notes || []).length && hasLen(stepAllX, 14, 0.35) && hasLen(stepAllX, 24, 0.35), stepAllBody && (stepAllBody.error || ((stepAllBody.notes || []).join('; ')) || (stepAllX && stepAllX.map((v) => v.toFixed(1)).slice(0, 16).join(','))));

  // Short step on the -x side: its +x end is an earlier face than the long
  // base. Editing that short label must grow 10→14 and leave the 20 base.
  const stepLeftParts = [
    { id: 'a', kernel: 'brep', type: 'box', size: { x: 20, y: 10, z: 5 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    { id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 5 }, pos: [-5, 0, 5], rot: [0, 0, 0], features: [] },
  ];
  const stepLeft = await send({ type: 'build', objects: [{ id: 'stepl', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts: stepLeftParts }] });
  const stepLeftBody = (stepLeft.bodies || [])[0];
  const topLeft = lineEdges(stepLeftBody).find((e) => Math.abs(e.d[0]) > 0.98 * e.len && near(e.len, 10, 0.2) && e.mid[2] > 9);
  const stepShort = topLeft && await send({ type: 'build', objects: [{
    id: 'stepShort', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
    features: [{ op: 'length', scope: 'parallel', at: topLeft.mid, dir: [1, 0, 0], delta: 4 }],
    parts: stepLeftParts,
  }] });
  const stepShortBody = stepShort && (stepShort.bodies || [])[0];
  const stepShortX = stepShortBody && axisLens(stepShortBody, 0);
  check('editing a short step length leaves the longer parallel edges', stepShortBody && stepShortBody.vertices && !stepShortBody.error && !(stepShortBody.notes || []).length && hasLen(stepShortX, 14, 0.35) && hasLen(stepShortX, 20, 0.35) && !hasLen(stepShortX, 24, 0.35), stepShortBody && (stepShortBody.error || ((stepShortBody.notes || []).join('; ')) || (stepShortX && stepShortX.map((v) => v.toFixed(1)).slice(0, 16).join(','))));

  // A tower on a base: mesh order can point a→b into the attached face.
  // The free top must still move when that labeled height is edited.
  const towerParts = [
    { id: 'base', kernel: 'brep', type: 'box', size: { x: 20, y: 10, z: 5 }, pos: [0, 0, 0], rot: [0, 0, 0], features: [] },
    { id: 'tower', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 20 }, pos: [0, 0, 12.5], rot: [0, 0, 0], features: [] },
  ];
  const tower = await send({ type: 'build', objects: [{ id: 'tower0', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts: towerParts }] });
  const towerBody = (tower.bodies || [])[0];
  const tall = lineEdges(towerBody).find((e) => Math.abs(e.d[2]) > 0.98 * e.len && near(e.len, 20, 0.25) && e.mid[2] > 5);
  const intoBase = tall && (tall.a[2] >= tall.b[2]
    ? { a: tall.a, b: tall.b, mid: tall.mid, dir: [0, 0, -1] }
    : { a: tall.b, b: tall.a, mid: tall.mid, dir: [0, 0, -1] });
  const towerUp = intoBase && await send({ type: 'build', objects: [{
    id: 'tower1', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
    features: [{ op: 'length', scope: 'parallel', at: intoBase.mid, a: intoBase.a, b: intoBase.b, dir: intoBase.dir, delta: 4 }],
    parts: towerParts,
  }] });
  const towerUpBody = towerUp && (towerUp.bodies || [])[0];
  const towerUpZ = towerUpBody && axisLens(towerUpBody, 2);
  check('a length edit moves the free end when a→b points into the body', towerUpBody && towerUpBody.vertices && !towerUpBody.error && !(towerUpBody.notes || []).length && hasLen(towerUpZ, 24, 0.35) && !hasLen(towerUpZ, 20, 0.35), towerUpBody && (towerUpBody.error || ((towerUpBody.notes || []).join('; ')) || (towerUpZ && towerUpZ.map((v) => v.toFixed(1)).slice(0, 16).join(','))));
  const towerShort = intoBase && await send({ type: 'build', objects: [{
    id: 'tower2', kernel: 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0],
    features: [{ op: 'length', scope: 'parallel', at: intoBase.mid, a: intoBase.a, b: intoBase.b, dir: intoBase.dir, delta: -12 }],
    parts: towerParts,
  }] });
  const towerShortBody = towerShort && (towerShort.bodies || [])[0];
  const towerShortZ = towerShortBody && axisLens(towerShortBody, 2);
  check('a large shorten still changes the labeled length', towerShortBody && towerShortBody.vertices && !towerShortBody.error && !(towerShortBody.notes || []).length && hasLen(towerShortZ, 8, 0.35) && !hasLen(towerShortZ, 20, 0.35), towerShortBody && (towerShortBody.error || ((towerShortBody.notes || []).join('; ')) || (towerShortZ && towerShortZ.map((v) => v.toFixed(1)).slice(0, 16).join(','))));

  const hole = await send({ type: 'build', objects: [{
    id: 'hole', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const holeBody = (hole.bodies || [])[0];
  const holeEdge = curveEdges(holeBody).find((e) => e.k === 'curve' && e.pts && e.pts.length >= 8);
  const wider = holeEdge && await send({ type: 'build', objects: [{
    id: 'wider', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1],
    features: [{ op: 'length', round: true, scope: 'edge', at: holeEdge.mid, dir: ModelCore.planeNormal(holeEdge.pts) || [0, 0, 1], factor: 8 / 6, loops: [holeEdge.pts] }],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const widerBody = wider && (wider.bodies || [])[0];
  const widerCurves = widerBody && curveEdges(widerBody);
  const widerFit = (widerCurves || []).map((e) => e.pts && ModelCore.fitCircle(e.pts.map((p) => ModelCore.placePoint(p, [0, 0, 0], [0, 0, 0], [1, 1.194, 1])))).find((fit) => fit && fit.d > 5);
  check('editing the cut diameter changes the drawn diameter', widerBody && widerBody.vertices && !widerBody.error && !(widerBody.notes || []).length && widerFit && near(widerFit.d, 8, 0.35) && hasLen(lineLengths(widerBody), 10, 0.2), widerBody && (widerBody.error || ((widerBody.notes || []).join('; ')) || (widerFit && widerFit.d)));
  const xOnHole = lineEdges(holeBody).find((e) => Math.abs(e.d[0]) > 0.98 * e.len && near(e.len, 10, 0.2));
  const longer = xOnHole && await send({ type: 'build', objects: [{
    id: 'longer', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1],
    features: [{ op: 'length', scope: 'parallel', at: xOnHole.mid, dir: [1, 0, 0], delta: ModelCore.lengthDelta(10, 16, [1, 0, 0], [1, 1.194, 1]) }],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const longerBody = longer && (longer.bodies || [])[0];
  const longerCurve = longerBody && curveEdges(longerBody).find((e) => e.pts && e.pts.length >= 8);
  const longerFit = longerCurve && ModelCore.fitCircle(longerCurve.pts.map((p) => ModelCore.placePoint(p, [0, 0, 0], [-90, 0, 180], [1, 1.194, 1])));
  const longerX = longerBody && axisLens(longerBody, 0);
  check('lengthening an edge keeps the drawn hole diameter', longerBody && longerBody.vertices && !longerBody.error && !(longerBody.notes || []).length && hasLen(longerX, 16, 0.35) && longerFit && near(longerFit.d, 6, 0.35), longerBody && (longerBody.error || ((longerBody.notes || []).join('; ')) || ((longerX && longerX.map((v) => v.toFixed(1)).slice(0, 8).join(',')) + ' d ' + (longerFit && longerFit.d))));

  const joinedParts = [
    { id: 'a', kernel: 'brep', type: 'box', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], features: [] },
    { id: 'b', kernel: 'brep', type: 'box', size: { x: 20, y: 20, z: 20 }, pos: [30, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], features: [] },
  ];
  const joinedPose = { pos: [100, 200, 50], rot: [-90, 0, 180], scale: [1, 1.194, 1] };
  const joined = { id: 'joined', kernel: 'brep', type: 'join', ...joinedPose, features: [], parts: joinedParts };
  const cutter = { id: 'rod', kernel: 'brep', type: 'cylinder', size: { d: 8, z: 40 }, pos: [100, 190, 30], rot: [0, 0, 0], scale: [1, 1, 1], features: [] };
  const joinedCut = await send({ type: 'build', objects: [{
    id: 'jcut', kernel: 'brep', type: 'cut', cut: 'delete', ...joinedPose, features: [],
    parts: [joined, cutter],
  }] });
  const joinedCutBody = (joinedCut.bodies || [])[0];
  const joinedVol = joinedCutBody && joinedCutBody.vertices && volume(joinedCutBody.vertices, joinedCutBody.triangles);
  check('a cylinder cuts a moved joined body', joinedCutBody && joinedCutBody.vertices && !joinedCutBody.error && !(joinedCutBody.notes || []).length && joinedVol < 15500 && joinedVol > 14000, joinedCutBody && (joinedCutBody.error || ((joinedCutBody.notes || []).join('; ')) || joinedVol));
  const again = await send({ type: 'build', objects: [{
    id: 'jcut2', kernel: 'brep', type: 'cut', cut: 'delete', ...joinedPose, features: [],
    parts: [
      { id: 'jcut', kernel: 'brep', type: 'cut', cut: 'delete', ...joinedPose, features: [], parts: [joined, cutter] },
      { id: 'rod2', kernel: 'brep', type: 'cylinder', size: { d: 8, z: 40 }, pos: [70, 190, 30], rot: [0, 0, 0], scale: [1, 1, 1], features: [] },
    ],
  }] });
  const againBody = (again.bodies || [])[0];
  const againVol = againBody && againBody.vertices && volume(againBody.vertices, againBody.triangles);
  check('a cylinder cuts a joined body that was already cut', againBody && againBody.vertices && !againBody.error && !(againBody.notes || []).length && againVol < joinedVol - 400, againBody && (againBody.error || ((againBody.notes || []).join('; ')) || (againVol + ' from ' + joinedVol)));

  const cornerEdge = [0, 5, 10];
  const rounded = await send({ type: 'build', objects: [{
    id: 'rounded', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'fillet', at: cornerEdge, r: 1 }],
  }] });
  const roundedBody = (rounded.bodies || [])[0];
  const roundedVol = roundedBody && roundedBody.vertices && volume(roundedBody.vertices, roundedBody.triangles);
  check('rounding an edge removes that corner', roundedBody && roundedBody.vertices && !roundedBody.error && !(roundedBody.notes || []).length && roundedVol < 999 && roundedVol > 990, roundedBody && (roundedBody.error || ((roundedBody.notes || []).join('; ')) || roundedVol));
  const sharp = await send({ type: 'build', objects: [{ id: 'sharp', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [] }] });
  const sharpBody = (sharp.bodies || [])[0];
  check('removing the round restores the box', sharpBody && sharpBody.vertices && near(volume(sharpBody.vertices, sharpBody.triangles), 1000, 1));
  const chamfered = await send({ type: 'build', objects: [{
    id: 'cham', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'chamfer', at: cornerEdge, r: 1 }],
  }] });
  const chamferedBody = (chamfered.bodies || [])[0];
  const chamferedVol = chamferedBody && chamferedBody.vertices && volume(chamferedBody.vertices, chamferedBody.triangles);
  check('chamfering an edge cuts a flat across that corner', chamferedBody && chamferedBody.vertices && !chamferedBody.error && !(chamferedBody.notes || []).length && near(chamferedVol, 995, 2), chamferedBody && (chamferedBody.error || ((chamferedBody.notes || []).join('; ')) || chamferedVol));

  const cap = [[-5, -5, 10], [5, -5, 10], [5, 5, 10], [-5, 5, 10]];
  const grownFace = await send({ type: 'build', objects: [{
    id: 'grownface', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'push', loop: cap, normal: [0, 0, 1], center: [0, 0, 10], dist: 2 }],
  }] });
  const grownFaceBody = (grownFace.bodies || [])[0];
  check('pushing a face outward grows the body', grownFaceBody && grownFaceBody.vertices && !grownFaceBody.error && !(grownFaceBody.notes || []).length && near(volume(grownFaceBody.vertices, grownFaceBody.triangles), 1200, 2) && near(bounds(grownFaceBody.vertices).hi[2], 12, 0.05), grownFaceBody && (grownFaceBody.error || ((grownFaceBody.notes || []).join('; ')) || (grownFaceBody.vertices && volume(grownFaceBody.vertices, grownFaceBody.triangles))));
  const erased = await send({ type: 'build', objects: [{
    id: 'erased', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'push', loop: cap, normal: [0, 0, 1], center: [0, 0, 10], dist: -100 }],
  }] });
  const erasedBody = (erased.bodies || [])[0];
  check('a push that would erase the body is skipped', erasedBody && erasedBody.vertices && near(volume(erasedBody.vertices, erasedBody.triangles), 1000, 1) && (erasedBody.notes || []).some((t) => t.indexOf('erase') >= 0), erasedBody && (erasedBody.error || ((erasedBody.notes || []).join('; ')) || (erasedBody.vertices && volume(erasedBody.vertices, erasedBody.triangles))));

  const rect = await send({ type: 'build', objects: [{
    id: 'rect', kernel: 'brep', type: 'sketch', height: 2, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'rect', x: 0, y: 0, w: 10, h: 4 }],
  }] });
  const rectBody = (rect.bodies || [])[0];
  const rectBox = rectBody && rectBody.vertices && bounds(rectBody.vertices);
  check('a rectangle sketch extrudes to a box', rectBody && rectBody.vertices && !rectBody.error && near(volume(rectBody.vertices, rectBody.triangles), 80, 1) && rectBox && near(rectBox.hi[0] - rectBox.lo[0], 10, 0.05) && near(rectBox.hi[1] - rectBox.lo[1], 4, 0.05) && near(rectBox.hi[2], 2, 0.05), rectBody && (rectBody.error || (rectBox && volume(rectBody.vertices, rectBody.triangles))));
  const diskSketch = await send({ type: 'build', objects: [{
    id: 'disksk', kernel: 'brep', type: 'sketch', height: 2, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'circle', x: 1, y: 2, r: 5 }],
  }] });
  const diskBody = (diskSketch.bodies || [])[0];
  const diskBox = diskBody && diskBody.vertices && bounds(diskBody.vertices);
  const diskCurves = diskBody ? curveEdges(diskBody) : [];
  check('a circle sketch extrudes to a cylinder', diskBody && diskBody.vertices && !diskBody.error && near(volume(diskBody.vertices, diskBody.triangles), Math.PI * 25 * 2, 8) && diskBox && near(diskBox.hi[0] - diskBox.lo[0], 10, 0.15) && near(diskBox.hi[1] - diskBox.lo[1], 10, 0.15) && near(diskBox.hi[2], 2, 0.05) && diskCurves.length >= 2, diskBody && (diskBody.error || (diskBox && (diskBox.hi[0] - diskBox.lo[0]).toFixed(2) + 'x' + (diskBox.hi[1] - diskBox.lo[1]).toFixed(2)) || diskCurves.map((e) => e.k).join(',')));
  const down = await send({ type: 'build', objects: [{
    id: 'down', kernel: 'brep', type: 'sketch', height: -2, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'rect', x: 0, y: 0, w: 10, h: 4 }],
  }] });
  const downBody = (down.bodies || [])[0];
  const downBox = downBody && downBody.vertices && bounds(downBody.vertices);
  check('a sketch extrude keeps a downward length', downBody && downBody.vertices && !downBody.error && near(volume(downBody.vertices, downBody.triangles), 80, 1) && downBox && near(downBox.lo[2], -2, 0.05) && near(downBox.hi[2], 0, 0.05), downBody && (downBody.error || (downBox && (downBox.lo[2] + '..' + downBox.hi[2]))));
  const angle = await send({ type: 'build', objects: [{
    id: 'angle', kernel: 'brep', type: 'sketch', height: 2, pos: [0, 0, 0], rot: [0, 0, 0],
    profiles: [{ k: 'poly', pts: [[0, 0], [8, 0], [8, 5]] }],
  }] });
  const angleBody = (angle.bodies || [])[0];
  const angleBox = angleBody && angleBody.vertices && bounds(angleBody.vertices);
  check('a perpendicular sketch extrudes both legs', angleBody && angleBody.vertices && !angleBody.error && near(volume(angleBody.vertices, angleBody.triangles), 40, 1) && angleBox && near(angleBox.hi[0] - angleBox.lo[0], 8, 0.05) && near(angleBox.hi[1] - angleBox.lo[1], 5, 0.05), angleBody && (angleBody.error || (angleBox && volume(angleBody.vertices, angleBody.triangles))));

  const shortBase = await send({ type: 'build', objects: [{ id: 'shortbase', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } }] });
  const shortEdge = lineEdges((shortBase.bodies || [])[0]).find((e) => Math.abs(e.d[0]) > 0.98 * e.len && e.len > 9);
  const shorter = shortEdge && await send({ type: 'build', objects: [{
    id: 'shorter', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 },
    features: [{ op: 'length', scope: 'edge', at: shortEdge.mid, dir: [1, 0, 0], delta: -4 }],
  }] });
  const shorterBody = shorter && (shorter.bodies || [])[0];
  const shorterX = shorterBody && axisLens(shorterBody, 0);
  check('shortening one edge leaves the parallel edges', shorterBody && shorterBody.vertices && !shorterBody.error && !(shorterBody.notes || []).length && hasLen(shorterX, 6, 0.35) && hasLen(shorterX, 10, 0.15) && near(volume(shorterBody.vertices, shorterBody.triangles), 1000 - 200 / 3, 8), shorterBody && (shorterBody.error || ((shorterBody.notes || []).join('; ')) || (shorterX && shorterX.map((v) => v.toFixed(1)).slice(0, 12).join(','))));

  const narrower = holeEdge && await send({ type: 'build', objects: [{
    id: 'narrower', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1],
    features: [{ op: 'length', round: true, scope: 'edge', at: holeEdge.mid, dir: ModelCore.planeNormal(holeEdge.pts) || [0, 0, 1], factor: 4 / 6, loops: [holeEdge.pts] }],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const narrowerBody = narrower && (narrower.bodies || [])[0];
  const narrowerFit = narrowerBody && curveEdges(narrowerBody).map((e) => e.pts && ModelCore.fitCircle(e.pts.map((p) => ModelCore.placePoint(p, [0, 0, 0], [0, 0, 0], [1, 1.194, 1])))).find((fit) => fit && fit.d > 2 && fit.d < 5.5);
  check('shrinking the cut diameter changes the drawn diameter', narrowerBody && narrowerBody.vertices && !narrowerBody.error && !(narrowerBody.notes || []).length && narrowerFit && near(narrowerFit.d, 4, 0.35) && hasLen(lineLengths(narrowerBody), 10, 0.2), narrowerBody && (narrowerBody.error || ((narrowerBody.notes || []).join('; ')) || (narrowerFit && narrowerFit.d)));
}

function rawEdges(body) {
  const out = [];
  for (const f of (body && body.faces) || []) {
    const groups = (f.exact && f.exact.length) ? f.exact.map((w) => w.edges || []) : [f.measures || []];
    for (const edges of groups) for (const e of edges || []) if (e) out.push(e);
  }
  return out;
}
{
  const place = (rot, scale) => (p) => ModelCore.placePoint(p, [0, 0, 0], rot, scale);
  const turn = [-90, 0, 180];
  const built = await send({ type: 'build', objects: [
    { id: 'dimcyl', kernel: 'brep', type: 'cylinder', size: { d: 20, z: 10 } },
    { id: 'dimbox', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } },
  ] });
  const cyl = (built.bodies || []).find((b) => b.id === 'dimcyl');
  const box = (built.bodies || []).find((b) => b.id === 'dimbox');
  const circ = rawEdges(cyl).find((e) => e.k === 'circle');
  const circMeasure = circ && ModelCore.drawnMeasure(Object.assign({}, circ, { len: 999 }), place(turn, [2, 2, 1]));
  check('a real circle is not labeled with its unscaled radius', circMeasure && circMeasure.kind === 'diameter' && near(circMeasure.value, 40, 0.2) && Math.abs(circMeasure.value - circ.r * 2) > 1, circMeasure && (circMeasure.value + ' local ' + (circ.r * 2)));
  const yEdge = rawEdges(box).find((e) => e.k === 'line' && e.a && e.b && Math.abs(e.b[1] - e.a[1]) > 9);
  const yMeasure = yEdge && ModelCore.drawnMeasure(Object.assign({}, yEdge, { len: 4 }), place(turn, [1, 1.194, 1]));
  check('a real edge is not labeled with its unscaled length', yMeasure && yMeasure.kind === 'length' && near(yMeasure.value, 11.94, 0.08) && Math.abs(yMeasure.value - 10) > 0.5 && Math.abs(yMeasure.value - 4) > 1, yMeasure && yMeasure.value);
  const hole = await send({ type: 'build', objects: [{
    id: 'dimhole', kernel: 'brep', type: 'cut', cut: 'delete', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [],
    parts: [
      { id: 'p', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1.194, 1], features: [] },
      { id: 'c', kernel: 'brep', type: 'cylinder', size: { d: 6, z: 20 }, pos: [0, 0, -5], rot: [0, 0, 0], features: [] },
    ],
  }] });
  const holeBody = (hole.bodies || [])[0];
  const holeEdge = rawEdges(holeBody).find((e) => e.pts && e.pts.length >= 8);
  const holeMeasure = holeEdge && ModelCore.drawnMeasure(holeEdge, place(turn, [1, 1.194, 1]));
  check('a real cut is not labeled with its curve length', holeMeasure && holeMeasure.kind === 'diameter' && near(holeMeasure.value, 6, 0.35) && Math.abs(holeMeasure.value - (holeEdge.len || 0)) > 1, holeMeasure && (holeMeasure.value + ' len ' + (holeEdge && holeEdge.len)));

  const kept = { type: 'solid', brep: 'SHAPE', brepHash: 'ab', view: { edges: [] } };
  ModelCore.dropBuiltCache(kept);
  const rebuilt = { type: 'box', brep: 'SHAPE', brepHash: 'ab', view: { edges: [] } };
  ModelCore.dropBuiltCache(rebuilt);
  check('editing a dimension keeps the saved shape of a split piece', kept.brep === 'SHAPE' && !('brepHash' in kept) && !('view' in kept), JSON.stringify(kept));
  check('editing a dimension rebuilds a primitive from its size', !('brep' in rebuilt) && !('brepHash' in rebuilt), JSON.stringify(rebuilt));

  const xEdge = rawEdges(box).find((e) => e.k === 'line' && e.a && e.b && Math.abs(e.b[0] - e.a[0]) > 9);
  const xMid = xEdge && [0, 1, 2].map((i) => ((xEdge.a[i] || 0) + (xEdge.b[i] || 0)) / 2);
  const missing = await send({ type: 'build', objects: [{
    id: 'nosolid', kernel: 'brep', type: 'solid', pos: [0, 0, 0], rot: [0, 0, 0], features: [
      { op: 'length', scope: 'parallel', at: xMid || [0, 0, 5], dir: [1, 0, 0], delta: 4 },
    ],
  }] });
  const missingBody = (missing.bodies || [])[0];
  check('a dimension edit without the saved shape says the solid has no shape', missingBody && /no shape/i.test(missingBody.error || ''), missingBody && (missingBody.error || 'built'));
  const resized = box && box.brep && xMid && await send({ type: 'build', objects: [{
    id: 'splitbox', kernel: 'brep', type: 'solid', pos: [0, 0, 0], rot: [0, 0, 0], brep: box.brep, features: [
      { op: 'length', scope: 'parallel', at: xMid, dir: [1, 0, 0], delta: 4 },
    ],
  }] });
  const resizedBody = resized && (resized.bodies || [])[0];
  const resizedX = resizedBody && axisLens(resizedBody, 0);
  check('editing a dimension of a split piece changes that piece', resizedBody && resizedBody.vertices && !resizedBody.error && !(resizedBody.notes || []).length && resizedX && resizedX.length > 0 && resizedX.every((v) => near(v, 14, 0.3)) && near(volume(resizedBody.vertices, resizedBody.triangles), 1400, 8), resizedBody && (resizedBody.error || ((resizedBody.notes || []).join('; ')) || (resizedX && resizedX.map((v) => v.toFixed(1)).slice(0, 8).join(','))));
}

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
