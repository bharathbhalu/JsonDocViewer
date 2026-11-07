// 3D modeling SCENARIO tests: builds real designs from scratch the way a person
// would (only real clicks, drags, typing), checking the objects after each step.
//
//   node cad-build/test/scenario.test.mjs
//
// (setup below is shared with ui.test.mjs)
// 3D modeling UI tests: drives the real app in headless Chrome with real mouse,
// keyboard and touch input and checks every tool, panel option and export.
//
//   node cad-build/test/ui.test.mjs
//
// It runs a throwaway copy of the app on port 4399 with its own empty data
// folder and settings, so your data and your running Accretion are untouched.
// Needs Google Chrome and the 3D add-on installed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { unzipSync } from 'fflate';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(here, '..', '..');
const PORT = 4398;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
const check = (name, ok, detail) => { lastStep = name; if (ok) pass++; else { fail++; failures.push(name + (detail != null ? ' — ' + detail : '')); } console.log((ok ? '  ✓ ' : '  ✗ ') + name + (!ok && detail != null ? '   [' + String(detail).slice(0, 300) + ']' : '')); };
const section = (t) => console.log('\n' + t);
const near = (a, b, t) => Math.abs(a - b) <= t;

// ---------- throwaway app ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accretion-cad-test-'));
const app = path.join(tmp, 'app'), home = path.join(tmp, 'home'), data = path.join(tmp, 'data');
fs.mkdirSync(home); fs.mkdirSync(data);
fs.cpSync(WEBAPP, app, { recursive: true, filter: (src) => !/node_modules/.test(path.relative(WEBAPP, src)) });
fs.symlinkSync(path.join(WEBAPP, 'node_modules'), path.join(app, 'node_modules'));
fs.writeFileSync(path.join(app, 'server.js'), fs.readFileSync(path.join(app, 'server.js'), 'utf8').replace(/^const PORT = \d+;/m, 'const PORT = ' + PORT + ';'));
fs.mkdirSync(path.join(data, 'models'));
fs.writeFileSync(path.join(data, 'models', 'cube.stl'), Buffer.from(F.binarySTL()));
fs.writeFileSync(path.join(data, 'models', 'pic.png'), Buffer.from(F.PNG_1PX));
const FT_SRC = path.resolve(WEBAPP, '..', '..', 'STL', 'frametap_case_remote.stl');
const HAVE_FT = fs.existsSync(FT_SRC); if (HAVE_FT) fs.copyFileSync(FT_SRC, path.join(data, 'models', 'frametap.stl'));
const WS_SRC = path.resolve(WEBAPP, '..', '..', 'STL', 'waveshare18amoled-noring.stl');
const HAVE_WS = fs.existsSync(WS_SRC);
const server = spawn(process.execPath, ['server.js'], { cwd: app, env: Object.assign({}, process.env, { HOME: home, DATA_DIR: data }), stdio: 'ignore' });
let chrome = null;
const cleanup = () => { try { server.kill(); } catch (e) { /* gone */ } try { chrome && chrome.kill(); } catch (e) { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));
const base = 'http://localhost:' + PORT;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/cad/addon')).ok) break; } catch (e) { /* starting */ } await sleep(250); }
const addon = await (await fetch(base + '/api/cad/addon')).json();
if (!addon.installed) { console.log('3D add-on is not installed — run cad-build/build.sh first.'); process.exit(2); }
const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
await post('/api/file/create', { path: 'test.html', kind: 'cad', template: 'blank' });

// ---------- Chrome over CDP ----------
chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9335', '--user-data-dir=' + path.join(tmp, 'chrome'), '--window-size=1400,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let tabs = [];
for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:9335/json')).json(); if (tabs.find((t) => t.type === 'page')) break; } catch (e) { /* starting */ } await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let mid = 0; const pend = new Map(); const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
});
let lastStep = '';
const cmd = (method, params) => new Promise((r, j) => { const i = ++mid; const t = setTimeout(() => { pend.delete(i); j(new Error('timed out (' + method + ') after: ' + lastStep)); }, 30000); pend.set(i, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text); return r.result.result.value; };
await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('DOM.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: base + '/' }); await sleep(2500);

// input helpers (real events)
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const mouse = async (type, x, y, extra) => cmd('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra || {}));
const click = async (p, modifiers = 0) => { await mouse('mouseMoved', p[0], p[1], { modifiers }); await mouse('mousePressed', p[0], p[1], { button: 'left', clickCount: 1, modifiers }); await mouse('mouseReleased', p[0], p[1], { button: 'left', clickCount: 1, modifiers }); await sleep(250); };
const tap = async (p) => { await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p[0], y: p[1] }] }); await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250); };
const key = async (k, code, vk, modifiers = 0, commands) => { await cmd('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }, commands ? { commands } : {})); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(200); };
const typeText = async (t) => { for (const ch of t) { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } await sleep(100); };
const el = async (sel) => { const r = await ev(`(() => { const e = document.querySelector('.cad-root') && document.querySelector('.cad-root').querySelector(${JSON.stringify(sel)}); if (!e) return null; if (e.scrollIntoView) e.scrollIntoView({ block: 'center', inline: 'center' }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, b.width, b.height]; })()`); if (!r) throw new Error('not found: ' + sel); return r; };
const has = (sel) => ev(`!!(document.querySelector('.cad-root') && document.querySelector('.cad-root').querySelector(${JSON.stringify(sel)}))`);
const press = async (sel, modifiers = 0) => click(await el(sel), modifiers);
const scr = async (x, y, z) => ev(`(() => { const v = new boardEngine.T.Vector3(${x}, ${y}, ${z}).project(boardEngine.camera); const r = boardEngine.renderer.domElement.getBoundingClientRect(); return [(v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top]; })()`);
const idle = async () => { for (let i = 0; i < 400; i++) { if (await ev(`!boardEngine.building && !boardEngine.pendingBuild && !boardEngine._buildT_pending`)) { await sleep(120); if (await ev(`!boardEngine.building && !boardEngine.pendingBuild`)) return; } await sleep(50); } };
const setField = async (f, v) => { await ev(`(() => { const i = document.querySelector('.cad-inspector [data-f="${f}"]'); i.focus(); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('change')); })()`); await sleep(150); await idle(); };
const items = () => ev(`JSON.stringify(boardEngine.data.items)`).then(JSON.parse);
const it = (name) => items().then((a) => a.find((x) => x.name === name));

// Extrude areas of the selected 2D sketch through the real UI: floating-bar icon,
// (all areas), distance, Extrude. op: new | cut | split
const extrude = async (dist, op = 'new', all = true) => {
  await press(`.cad-actbar [data-ab="ext-${op}"]`); await sleep(400);
  if (all && !(await ev(`document.querySelector('[data-exall]').textContent === 'none'`))) await press('[data-exall]');
  await ev(`(() => { const i = document.querySelector('[data-exdist]'); i.focus(); i.value = ${JSON.stringify(String(dist))}; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-exgo]'); await sleep(200); await idle();
};
const selNames = () => ev(`boardEngine._selIds().map((id) => boardEngine._item(id).name).join(',')`);
const dims = () => ev(`(document.querySelector('.cad-dims') || {}).innerText`).then((t) => (t || '').replace(/\s+/g, ' ').trim());
const reset = async (list) => { await ev(`(() => { const E = boardEngine; if (E.faceOn) E._faceMode(false); if (E.sk) E._sketchEnd(false); if (E.measureOn) E._measureMode(false); E.data.items = []; E.data.groups = {}; ${(list || []).map((o) => `E._add(${JSON.stringify(o.type)}, ${JSON.stringify(o)});`).join('')} E._select(null); E.undoStack = []; E.redoStack = []; E._renderChrome(); })()`); await idle(); };
const popupText = () => ev(`(document.querySelector('.ui-pop-msg') || {}).textContent || ''`);
const popup = async (label) => { const p = await ev(`(() => { const b = [...document.querySelectorAll('.ui-pop-acts button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`); if (!p) throw new Error('popup button ' + label); await click(p); await sleep(300); };
// Answer every warning popup in turn (export can show "floating" then "overlapping").
const popupsAll = async (label) => { for (let i = 0; i < 5; i++) { await sleep(400); if (!(await ev(`!!document.querySelector('.ui-pop-title')`))) return i; await popup(label); } return 5; };
const dataFile = (rel) => (fs.existsSync(path.join(data, rel)) ? fs.readFileSync(path.join(data, rel)) : null);

// ---------------- scenario helpers (real input only) ----------------
const vols = () => ev(`(() => { const E = boardEngine; const out = {}; for (const x of E.data.items) { const m = E.meshes[x.id]; if (!m) continue; let s = 0; const v = m.vertices, t = m.triangles; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } out[x.name] = s / 6; } return out; })()`);
const total = () => ev(`(() => { const m = boardEngine.result; if (!m) return 0; const v = m.vertices, t = m.triangles; let s = 0; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
const bounds = () => ev(`(() => { const v = boardEngine.result.vertices; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); } return { lo, hi, size: hi.map((h, k) => Math.round((h - lo[k]) * 100) / 100) }; })()`);
const closed = () => ev(`(() => { const t = boardEngine.result.triangles; const e = new Map(); for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const key = t[i + k] + ',' + t[i + (k + 1) % 3]; e.set(key, (e.get(key) || 0) + 1); } for (const [key, n] of e) { if (n !== 1) return false; const [a, b] = key.split(','); if (e.get(b + ',' + a) !== 1) return false; } return true; })()`);
const status = () => ev(`document.querySelector('.cad-root .cad-status').textContent`);
const errs = () => ev(`JSON.stringify(boardEngine.errors)`);
const dimLabels = () => ev(`[...document.querySelectorAll('.cad-dimlabel')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')`);
const field = async (f, v) => { const p2 = await el(`.cad-inspector [data-f="${f}"]`); await click(p2); await ev(`(() => { const i = document.querySelector('.cad-inspector [data-f="${f}"]'); i.select(); })()`); await typeText(String(v)); await key('Enter', 'Enter', 13); await idle(); };
const selectByName = async (name) => { await ev(`boardEngine.listEl.classList.remove('collapsed')`); await sleep(100); const p2 = await ev(`(() => { const r = [...document.querySelectorAll('.cad-row')].find((x) => x.querySelector('.cad-row-name').textContent.trim().startsWith(${JSON.stringify(name)})); if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.getBoundingClientRect(); return [b.x + 40, b.y + b.height / 2]; })()`); if (!p2) throw new Error('no row ' + name); await click(p2); await idle(); };
const sp = (x, y) => ev(`(() => { const v = new boardEngine.T.Vector3(${x}, ${y}, 0).applyMatrix4(boardEngine.sk.frame.matrixWorld).project(boardEngine.camera); const r = boardEngine.renderer.domElement.getBoundingClientRect(); return [(v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top]; })()`);
const facePick = async (x, y, z, view) => { await press(`[data-view="${view || 'iso'}"]`); await sleep(200); if (!(await ev(`boardEngine.faceOn`))) await key('e', 'KeyE', 69); await click(await scr(x, y, z)); return ev(`!!boardEngine.face`); };
const faceDist = async (d) => { const p2 = await el('.cad-inspector [data-fdist]'); await click(p2); await ev(`document.querySelector('.cad-inspector [data-fdist]').select()`); await typeText(String(d)); await key('Enter', 'Enter', 13); await idle(); };
const step = (t) => console.log('\n  — ' + t);
const healthy = async (label) => { const st = await status(); const e = await errs(); check(label + ': engine healthy (no errors, status ok)', !/fail|memory|error/i.test(st) && e === '{}', st + ' ' + e); };
const exportParts = async (fmt) => {
  for (const f of ['test.3mf', 'test.stl']) fs.rmSync(path.join(data, f), { force: true });
  await press('[data-export]'); await press(`[data-ex="${fmt}"]`); await popupsAll('Export anyway'); await sleep(1500);
  const buf = dataFile('test.' + fmt); if (!buf) return null;
  if (fmt === 'stl') { const sx = F.parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); return [{ name: 'stl', vol: F.meshVolume(sx.vertices, sx.triangles), closed: F.isClosed(sx.triangles), size: F.meshBounds(sx.vertices).size }]; }
  const x = new TextDecoder().decode(unzipSync(new Uint8Array(buf))['3D/3dmodel.model']);
  return [...x.matchAll(/<object id="\d+" type="model" name="([^"]*)"><mesh><vertices>(.*?)<\/vertices><triangles>(.*?)<\/triangles>/g)].map((m) => {
    const v = [...m[2].matchAll(/x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((a) => [+a[1], +a[2], +a[3]]); const t = [...m[3].matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((a) => [+a[1], +a[2], +a[3]]);
    return { name: m[1], vol: F.meshVolume(v, t), closed: F.isClosed(t), size: F.meshBounds(v).size.map((q) => Math.round(q * 100) / 100) };
  });
};

async function run() {
  await ev(`openFile('test.html')`);
  for (let i = 0; i < 200 && !(await ev(`typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready`)); i++) await sleep(100);
  await idle();

  // =====================================================================
  section('Scenario 1 — design a FrameTap-style remote from scratch');
  step('body: a box, then type its size, round its corners and edges');
  await press('[data-add="box"]'); await idle();
  await field('size.x', 41); await field('size.y', 16); await field('size.z', 100); await field('size.corner', 4); await field('round', 1.5);
  await field('pos.0', 0); await field('pos.1', 0);
  await press('[data-view="iso"]'); await idle();
  check('body is 41 × 16 × 100 on the dimension lines', /X 41 mm \| Y 16 mm \| Z 100 mm/.test(await dimLabels()), await dimLabels());
  const vBox = await total();
  check('rounded body is a closed solid, less than a sharp box', (await closed()) && vBox < 41 * 16 * 100 && vBox > 41 * 16 * 100 * 0.95, vBox);
  await healthy('body');

  step('push / pull the top face up to 118 mm — the rounded edges must follow');
  check('tap the top face (it blends into rounded edges)', await facePick(0, 0, 100));
  await faceDist(18);
  await key('Escape', 'Escape', 27);
  const b1 = await bounds();
  check('body is now 118 high (Z 0 … 118), still 41 × 16', JSON.stringify(b1.size) === '[41,16,118]', JSON.stringify(b1));
  check('still one shape (the box grew, no extra slab)', (await items()).length === 1 && (await items())[0].size.z === 118 && (await items())[0].round === 1.5);
  const vBody = await total();
  check('volume grew by about 41·16·18 (rounded profile)', near(vBody - vBox, 41 * 16 * 18, 41 * 16 * 18 * 0.06), vBody - vBox);
  await healthy('pull');

  step('round window near the top: a cylinder through the body, set to Hole');
  await press('[data-add="cylinder"]'); await idle();
  await field('size.d', 18); await field('size.z', 30);
  await press('.cad-inspector [data-q="rx"]'); await idle();
  await field('pos.0', 0); await field('pos.1', 15); await field('pos.2', 92);
  await press('.cad-inspector [data-role="hole"]'); await idle();
  const vWin = await total();
  check('window cuts right through: about π·9²·16 removed', near(vBody - vWin, Math.PI * 81 * 16, Math.PI * 81 * 16 * 0.08), vBody - vWin);
  check('still one closed solid', await closed());
  await healthy('window');

  step('grip grooves: one groove on the front, then a Row pattern of 5');
  await press('[data-add="box"]'); await idle();
  await field('size.x', 45); await field('size.y', 2); await field('size.z', 2);
  await field('pos.0', 0); await field('pos.1', -8); await field('pos.2', 15);
  await press('.cad-inspector [data-role="hole"]'); await idle();
  await ev(`document.querySelector('.cad-inspector .cad-pattern').open = true`);
  await ev(`(() => { const set = (q, v) => { const i = document.querySelector(q); i.value = v; i.dispatchEvent(new Event('change')); }; set('[data-pn]', '5'); set('[data-pdx]', '0'); set('[data-pdy]', '0'); set('[data-pdz]', '10'); })()`);
  await press('[data-pmake]'); await idle();
  const grooves = (await items()).filter((x) => x.role === 'hole' && x.type === 'box');
  check('5 grooves at Z 15, 25, 35, 45, 55', JSON.stringify(grooves.map((x) => x.pos[2]).sort((a, b) => a - b)) === '[15,25,35,45,55]', JSON.stringify(grooves.map((x) => x.pos)));
  const vGr = await total();
  check('grooves remove about 5 × 41 × 1 × 2 (front 1 mm)', near(vWin - vGr, 5 * 41 * 2, 5 * 41 * 2 * 0.25), vWin - vGr);
  await healthy('grooves');

  step('button slot sketched on the front face, cut 1.5 mm in, mirrored to the back');
  await key('Escape', 'Escape', 27);
  check('tap the front face', await facePick(0, -8, 75, 'front'));
  await press('[data-fsketch]'); await sleep(300);
  await press('[data-sktool="slot"]');
  await ev(`(() => { const i = document.querySelector('[data-skslotw]'); i.value = '6'; i.dispatchEvent(new Event('change')); })()`);
  // draw the slot where we want it: horizontal at Z 75 (world), clear of the window and grooves
  const loc = (x, y, z) => ev(`(() => { const T = boardEngine.T; const v = new T.Vector3(${x}, ${y}, ${z}).applyMatrix4(boardEngine.sk.frame.matrixWorld.clone().invert()); return [v.x, v.y]; })()`);
  const s1 = await loc(-8, -8, 75), s2 = await loc(8, -8, 75);
  await click(await sp(...s1)); await click(await sp(...s2));
  await press('[data-skdone]'); await idle();
  await extrude('-1.5', 'cut');
  const vSlot = await total();
  check('slot pocket 22 × 6 × 1.5 cut into the front', near(vGr - vSlot, (16 * 6 + Math.PI * 9) * 1.5, 12), vGr - vSlot);
  // Mirror Y on the slot (a feature on the body) → the same slot on the back
  await press('[data-sym="1"]'); await idle();
  const vSlot2 = await total();
  check('Mirror Y → the same pocket on the back', near(vSlot - vSlot2, vGr - vSlot, 2), (vSlot - vSlot2) + ' vs ' + (vGr - vSlot));
  check('still closed after all cuts', await closed());
  await healthy('slots');

  step('lanyard hole through the bottom, and an inner pocket');
  await press('[data-add="cylinder"]'); await idle();
  await field('size.d', 4); await field('size.z', 50);
  await press('.cad-inspector [data-q="ry"]'); await idle();
  await field('pos.0', -25); await field('pos.1', 0); await field('pos.2', 6);
  await press('.cad-inspector [data-role="hole"]'); await idle();
  const vLan = await total();
  check('lanyard hole: about π·4·41 removed', near(vSlot2 - vLan, Math.PI * 4 * 41, Math.PI * 4 * 41 * 0.25), vSlot2 - vLan);
  await press('[data-add="box"]'); await idle();
  await field('size.x', 30); await field('size.y', 8); await field('size.z', 40); await field('pos.0', 0); await field('pos.1', 0); await field('pos.2', 20);
  await press('.cad-inspector [data-role="hole"]'); await idle();
  const vPk = await total();
  check('hidden inner pocket 30 × 8 × 40 removed (part stays closed)', near(vLan - vPk, 30 * 8 * 40, 30), vLan - vPk);
  check('closed with an inner cavity', await closed());
  await healthy('pocket');

  step('split the top cap off with a plane at Z 80, move it up — no gap, two parts');
  await selectByName('Box'); // the body
  check('body selected', (await selNames()) === 'Box', await selNames());
  await press('[data-cutstart]'); await sleep(200);
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-cutat]'); i.value = '80'; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-cutdo="split"]'); await idle();
  check('two body parts now', (await items()).filter((x) => x.role === 'solid' && !x.draft).length === 2);
  check('the holes (window, grooves, slots, lanyard, pocket) are baked into the parts', (await items()).filter((x) => x.role === 'hole').length === 0 && (await items()).filter((x) => !x.draft).every((x) => (x.cuts || []).length >= 5), JSON.stringify((await items()).map((x) => [x.name, x.role, (x.cuts || []).length])));
  check('the two parts together = the uncut part (no gap)', near(await total(), vPk, 0.5), (await total()) + ' vs ' + vPk);
  // tap the top cap on its front face and raise it 20 mm with Page Up
  await press('[data-view="front"]'); await sleep(200); await key('Escape', 'Escape', 27);
  await click(await scr(15, -8, 110)); await idle();
  const capB = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); return [b.min.z, b.max.z]; })()`);
  check('tapping the top part selects the cap (Z 80 … 118)', near(capB[0], 80, 0.05) && near(capB[1], 118, 0.05), JSON.stringify(capB) + ' ' + (await selNames()));
  const capName = await selNames();
  for (let i = 0; i < 20; i++) await key('PageUp', 'PageUp', 33);
  await idle();
  const parts = await exportParts('3mf');
  check('3MF: 2 printable parts, both closed', parts && parts.length === 2 && parts.every((p2) => p2.closed), JSON.stringify(parts && parts.map((p2) => [p2.name, Math.round(p2.vol), p2.closed])));
  check('3MF parts add up to the design volume', parts && near(parts.reduce((a, p2) => a + p2.vol, 0), await total(), 1), parts && parts.map((p2) => Math.round(p2.vol)).join(' + ') + ' vs ' + (await total()));
  check('moved cap keeps its window and the body keeps its holes (same total volume)', parts && near(parts.reduce((a, p2) => a + p2.vol, 0), vPk, 1), parts && parts.reduce((a, p2) => a + p2.vol, 0) + ' vs ' + vPk);
  void capName;
  await healthy('split');

  step('resize the cut cap (it has baked holes): Scale mode, scale bar All × 1.1');
  await click(await scr(15, -8, 125)); await idle();  // the cap, raised 20 mm
  const cap0 = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); const s = b.getSize(new boardEngine.T.Vector3()); return [s.x, s.y, s.z]; })()`);
  const capV0 = (await vols())[await selNames()];
  await press('[data-mode="scale"]');
  check('scale bar appears in Scale mode', !(await ev(`document.querySelector('.cad-scalebar').classList.contains('hidden')`)));
  const sball = await el('[data-sball]'); await click(sball); await ev(`document.querySelector('[data-sball]').select()`); await typeText('1.1');
  check('typing All × 1.1 previews the new size on the dimension labels', /×1\.1/.test(await dimLabels()), await dimLabels());
  await press('[data-sbapply]'); await idle(); await sleep(300); await idle();
  const cap1 = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); const s = b.getSize(new boardEngine.T.Vector3()); return [s.x, s.y, s.z]; })()`);
  const capV1 = (await vols())[await selNames()];
  check('cut cap grew 10 % on every axis (holes scale with it)', cap1.every((v, k) => near(v, cap0[k] * 1.1, 0.05)), JSON.stringify([cap0, cap1]));
  check('cap volume ×1.331', near(capV1, capV0 * 1.331, capV0 * 0.01), capV1 + ' vs ' + capV0 * 1.331);
  check('no "moved but not resized" message', !/not resized/i.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)));
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('one ⌘Z undoes the scale', (await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); return b.getSize(new boardEngine.T.Vector3()).z; })()`)) - cap0[2] < 0.05);
  await key('m', 'KeyM', 77);

  step('compare with your real FrameTap STL');
  await key('z', 'KeyZ', 90, MOD.meta); await idle(); // one undo: the whole run of 20 Page Up nudges
  const bb = await bounds();
  if (HAVE_FT) {
    const real = F.meshBounds(F.parseSTL(fs.readFileSync(FT_SRC).buffer).vertices).size;
    check('overall size matches the real FrameTap within 1 mm', bb.size.every((v, k) => Math.abs(v - real[k]) < 1), JSON.stringify(bb.size) + ' vs ' + JSON.stringify(real.map((v) => Math.round(v * 100) / 100)));
  }
  const stl = await exportParts('stl');
  check('STL export: one closed solid, same volume as the design', stl && stl[0].closed && near(stl[0].vol, await total(), 1), JSON.stringify(stl));

  step('heavy editing session: 25 quick edits, the engine must stay healthy');
  await click(await scr(15, -8, 110)); await idle();
  for (let i = 0; i < 25; i++) { await key(i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 37 : 39); }
  await idle();
  await healthy('after 25 edits');
  const ur = (await items()).length;
  for (let i = 0; i < 10; i++) await key('z', 'KeyZ', 90, MOD.meta);
  for (let i = 0; i < 10; i++) await key('z', 'KeyZ', 90, MOD.meta | MOD.shift);
  await idle();
  check('undo / redo keeps every part, its role and its baked holes', (await items()).length === ur && (await items()).filter((x) => x.role === 'solid' && !x.draft).length === 2 && (await items()).filter((x) => !x.draft).every((x) => (x.cuts || []).length >= 5) && near(await total(), vPk, 1), JSON.stringify((await items()).map((x) => [x.name, x.role, (x.cuts || []).length])) + ' ' + (await total()));
  await healthy('after undo / redo');

  // =====================================================================
  section('Scenario 2 — a new remote holding BOTH devices (FrameTap on top, board below)');
  if (!HAVE_FT || !HAVE_WS) { console.log('  (skipped: device STLs not found)'); return; }
  await ev(`(() => { const E = boardEngine; E.data.items = []; E.data.groups = {}; E._select(null); E.undoStack = []; E._commit(); })()`); await idle();
  step('import both device STLs with the file picker');
  const doc = (await cmd('DOM.getDocument', {})).result.root.nodeId;
  const fin = await cmd('DOM.querySelector', { nodeId: doc, selector: '.cad-file' });
  await cmd('DOM.setFileInputFiles', { nodeId: fin.result.nodeId, files: [FT_SRC, WS_SRC] }); await sleep(4000); await idle();
  const devs = await items();
  check('both imported as references', devs.length === 2 && devs.every((x) => x.type === 'model' && x.role === 'ref'), JSON.stringify(devs.map((x) => x.name)));
  const ftName = devs.find((x) => /frametap/i.test(x.name)).name, wsName = devs.find((x) => /waveshare/i.test(x.name)).name;

  step('stand the board up and stack: board at the bottom, FrameTap above');
  await selectByName(wsName); await press('.cad-inspector [data-q="rx"]'); await idle();
  await field('pos.0', 0); await field('pos.1', 0); await field('pos.2', 2.4);
  await selectByName(ftName); await field('pos.0', 0); await field('pos.1', 0); await field('pos.2', 54);
  const ftB = await ev(`(() => { const b = boardEngine._boundsOf([boardEngine.sel]); return [b.min.toArray(), b.max.toArray()]; })()`);
  await selectByName(wsName);
  const wsB = await ev(`(() => { const b = boardEngine._boundsOf([boardEngine.sel]); return [b.min.toArray(), b.max.toArray()]; })()`);
  check('board sits below the FrameTap with a gap (no overlap)', wsB[1][2] < ftB[0][2], JSON.stringify([wsB, ftB]));

  step('body around both: a rounded box from the devices\' size + 3 mm walls');
  const W = Math.max(ftB[1][0] - ftB[0][0], wsB[1][0] - wsB[0][0]) + 6, D = Math.max(ftB[1][1] - ftB[0][1], wsB[1][1] - wsB[0][1]) + 6, H = ftB[1][2] - 10;
  await press('[data-add="box"]'); await idle();
  await field('size.x', Math.ceil(W)); await field('size.y', Math.ceil(D)); await field('size.z', Math.ceil(H)); await field('size.corner', 3); await field('round', 1);
  await field('pos.0', 0); await field('pos.1', ((ftB[0][1] + ftB[1][1]) / 2).toFixed(2)); await field('pos.2', 0);
  const vShell = await total();
  check('body is one closed solid', (await closed()) && vShell > 0);

  step('pockets: set both devices to Hole with 0.4 mm clearance');
  for (const n of [ftName, wsName]) { await selectByName(n); await press('.cad-inspector [data-role="hole"]'); await idle(); await field('clearance', 0.4); }
  const vHolder = await total();
  const dv = await vols(); const devVol = (dv[ftName] || 0) + (dv[wsName] || 0);
  check('pockets removed about the devices\' own volume (exact fit)', near(vShell - vHolder, devVol, devVol * 0.3), (vShell - vHolder) + ' removed vs devices ' + devVol);
  await selectByName(ftName); await press('[data-fit="outline"]'); await idle();
  const vOutline = await total();
  check('Outline pocket (easy to slide in) removes more than the exact shape', vOutline < vHolder - 100, vOutline + ' vs ' + vHolder);
  check('holder is closed (printable)', await closed());
  await healthy('pockets');

  step('a cable channel joining the two pockets');
  await press('[data-add="box"]'); await idle();
  await field('size.x', 10); await field('size.y', 6); await field('size.z', ((ftB[0][2] - wsB[1][2]) + 6).toFixed(2));
  await field('pos.0', 0); await field('pos.1', ((ftB[0][1] + ftB[1][1]) / 2).toFixed(2)); await field('pos.2', (wsB[1][2] - 3).toFixed(2));
  await press('.cad-inspector [data-role="hole"]'); await idle();
  check('channel removes material between the pockets', (await total()) < vOutline - 10, (await total()) + ' vs ' + vOutline);
  await healthy('channel');

  step('export: one closed holder, nothing floating or overlapping');
  const h3 = await exportParts('3mf');
  check('3MF: exactly one closed part (the holder)', h3 && h3.length === 1 && h3[0].closed, JSON.stringify(h3 && h3.map((p2) => [p2.name, Math.round(p2.vol), p2.closed, p2.size])));
  check('no floating warning for the holder', !(await ev(`Object.keys(boardEngine.floating || {}).length`)));
  check('holder wraps both devices (taller than the board + FrameTap stack)', h3 && h3[0].size[2] >= H - 0.5);

  step('combine the holder and scale it as one with the scale bar: X × 1.2');
  await press('[data-selall]'); await press('[data-combine]'); await idle();
  const g0 = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); const s = b.getSize(new boardEngine.T.Vector3()); return [s.x, s.y, s.z]; })()`);
  await press('[data-mode="scale"]');
  const sx = await el('[data-sbf="0"]'); await click(sx); await ev(`document.querySelector('[data-sbf="0"]').select()`); await typeText('1.2'); await key('Enter', 'Enter', 13); await idle(); await sleep(300); await idle();
  const g1 = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); const s = b.getSize(new boardEngine.T.Vector3()); return [s.x, s.y, s.z]; })()`);
  check('combined holder: X × 1.2, Y and Z unchanged', near(g1[0], g0[0] * 1.2, 0.1) && near(g1[1], g0[1], 0.05) && near(g1[2], g0[2], 0.05), JSON.stringify([g0, g1]));
  await healthy('after scaling the combined holder');
  await key('z', 'KeyZ', 90, MOD.meta); await idle(); await key('z', 'KeyZ', 90, MOD.meta); await idle(); // undo the scale, then the combine
  check('undo twice → separate objects again, original size', (await items()).every((x) => !x.group) && near((await ev(`(() => { const E = boardEngine; const b = E._boundsOf(E.data.items.map((x) => x.id)); return b.getSize(new E.T.Vector3()).x; })()`)), g0[0], 0.05));
  await key('m', 'KeyM', 77);

  step('memory: 30 edits on this heavy design (3 big meshes) — no crash');
  await selectByName('Box');
  for (let i = 0; i < 30; i++) { await key(i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 37 : 39); if (i % 6 === 5) await idle(); }
  await idle();
  await healthy('after 30 edits on the heavy design');
  check('no "engine restarted" message', !/restarted|memory/i.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)));
}
setTimeout(() => { console.log('\nWATCHDOG: run exceeded 30 min, last passed step: ' + lastStep); process.exit(3); }, 30 * 60 * 1000).unref();
try { await run(); } catch (e) { check('test run finished without crashing', false, e.stack || e.message); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
