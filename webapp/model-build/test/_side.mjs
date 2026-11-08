import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', '..', 'public', 'model', 'vendor', 'model-worker.js');
const inbox = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => inbox.push(m);
await import(pathToFileURL(bundle).href);
const take = async (pred) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};
await take((m) => m.type === 'ready' || m.type === 'init-error');
let seq = 0;
const send = async (msg) => {
  const id = ++seq;
  self.onmessage({ data: Object.assign({ id }, msg) });
  return take((m) => m.id === id);
};
function volume(v, t) {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(s) / 6;
}
const base = await send({ type: 'build', objects: [{ id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 } }] });
const box = base.bodies[0];
console.log(JSON.stringify(box.faces.map((f) => ({ n: f.normal, c: f.center, loop: f.loop })), null, 1));
const side = box.faces.find((f) => f.normal[0] > 0.9);
const pulled = await send({ type: 'build', objects: [{ id: 'b', kernel: 'brep', type: 'box', size: { x: 10, y: 10, z: 10 }, features: [{ op: 'push', loop: side.loop, normal: side.normal, center: side.center, dist: 2 }] }] });
const body = pulled.bodies[0];
console.log('side pull', body.error || volume(body.vertices, body.triangles));
