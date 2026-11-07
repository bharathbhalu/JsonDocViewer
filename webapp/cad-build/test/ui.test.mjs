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
const PORT = 4399;
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
chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(tmp, 'chrome'), '--window-size=1400,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let tabs = [];
for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:9334/json')).json(); if (tabs.find((t) => t.type === 'page')) break; } catch (e) { /* starting */ } await sleep(200); }
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

async function run() {
  // ======================================================================
  section('Settings → 3D modeling');
  const st = await (await fetch(base + '/api/cad/addon')).json();
  check('add-on reports installed with versions', st.installed && st.versions && st.versions.opencascade && st.versions.manifold && st.versions.three, JSON.stringify(st.versions));
  check('npm found (needed for Install / Reinstall)', st.npm === true);
  await ev(`openDataFolder()`); for (let i = 0; i < 50 && !(await ev(`/installed/.test((document.querySelector('.df-cad') || {}).textContent || '')`)); i++) await sleep(100);
  const dfc = await ev(`(document.querySelector('.df-cad') || {}).innerText || ''`);
  check('Settings shows "3D modeling: installed" with versions and Reinstall / Remove', /installed/.test(dfc) && /OpenCascade/.test(dfc) && /Reinstall/.test(dfc) && /Remove/.test(dfc), dfc.replace(/\s+/g, ' ').slice(0, 160));
  await ev(`(() => { const x = document.querySelector('.topo-overlay [data-x], [data-x]'); if (x) x.click(); })()`); await sleep(400);
  check('Settings closes again', !(await ev(`!!document.querySelector('.df-cad')`)));
  check('mesh endpoint blocks paths outside the data folder', (await fetch(base + '/api/cad/mesh?path=../../etc/passwd.stl')).status === 400);
  check('mesh endpoint refuses non-model files', (await fetch(base + '/api/cad/mesh?path=test.html')).status === 400);
  check('mesh endpoint serves images with the right type', ((await fetch(base + '/api/cad/mesh?path=models/pic.png')).headers.get('content-type') || '').startsWith('image/png'));

  // ======================================================================
  section('Opening a 3D design');
  await ev(`openFile('test.html')`);
  for (let i = 0; i < 200 && !(await ev(`!!(typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready)`)); i++) await sleep(100);
  if (!(await ev(`!!(typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready)`))) console.log('    debug:', await ev(`JSON.stringify({ engine: !!window.boardEngine, ready: typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready, root: (document.querySelector('.cad-root') || {}).innerText && document.querySelector('.cad-root').innerText.slice(0, 200), path: typeof currentPath !== 'undefined' && currentPath })`));
  check('3D view loads (engine, canvas, toolbar)', await ev(`!!(typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready && document.querySelector('.cad-view canvas') && document.querySelector('.cad-tools'))`));
  check('file shows the 3D icon in the tree', await ev(`[...document.querySelectorAll('.tree-row')].some((r) => /test\\.html/.test(r.textContent) && r.querySelector('.icon-cad'))`));
  await idle();
  check('status says ready / add a shape', /Add a shape|Ready/.test(await ev(`document.querySelector('.cad-status').textContent`)));

  // ======================================================================
  section('Toolbar: shapes');
  await reset();
  await press('[data-add="box"]'); await idle();
  let a = await items();
  check('Box adds a 30×20×15 box and selects it', a.length === 1 && a[0].type === 'box' && a[0].size.x === 30 && (await selNames()) === 'Box');
  check('Size row shows X30 Y20 Z15', /X ?30 .*Y ?20 .*Z ?15/.test(await dims()), await dims());
  await press('[data-add="cylinder"]'); await press('[data-add="sphere"]'); await idle();
  a = await items();
  check('Cylinder and Sphere add shapes with unique names', a.map((x) => x.name).join(',') === 'Box,Cylinder,Sphere', a.map((x) => x.name).join(','));
  await press('[data-add="box"]'); await idle();
  check('second Box gets the name "Box 2"', (await items()).some((x) => x.name === 'Box 2'));
  await press('[data-add="code"]'); await idle();
  check('Script adds a script shape that builds', (await it('Script')).type === 'code' && !(await ev(`boardEngine.errors[boardEngine.sel]`)));

  section('Toolbar: undo / redo');
  const n0 = (await items()).length;
  await press('[data-undo]'); await idle();
  check('Undo removes the last shape', (await items()).length === n0 - 1);
  await press('[data-redo]'); await idle();
  check('Redo brings it back', (await items()).length === n0);
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('⌘Z undoes', (await items()).length === n0 - 1);
  await key('z', 'KeyZ', 90, MOD.meta | MOD.shift); await idle();
  check('⇧⌘Z redoes', (await items()).length === n0);

  // ======================================================================
  section('Panel: single shape');
  await reset([{ type: 'box', name: 'Body', size: { x: 30, y: 20, z: 15 } }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(200);
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-name]'); i.value = 'Case'; i.dispatchEvent(new Event('change')); })()`); await sleep(150);
  check('rename', !!(await it('Case')));
  await setField('size.x', '40+2'); check('size W accepts maths (40+2 → 42)', (await it('Case')).size.x === 42);
  await setField('size.y', '25'); await setField('size.z', '12');
  check('Size row follows W/D/H', /X ?42 .*Y ?25 .*Z ?12/.test(await dims()), await dims());
  await setField('size.corner', '3'); check('corner radius', (await it('Case')).size.corner === 3);
  await setField('round', '1'); check('round edges', (await it('Case')).round === 1 && !(await ev(`boardEngine.errors[boardEngine.sel]`)));
  await setField('round', '0'); await setField('chamfer', '0.5'); check('chamfer', (await it('Case')).chamfer === 0.5);
  await setField('chamfer', '0'); await setField('hollow', '2'); check('hollow', (await it('Case')).hollow === 2 && !(await ev(`boardEngine.errors[boardEngine.sel]`)));
  await setField('hollow', '0');
  await setField('size.x', '-5'); check('negative size is clamped (not accepted)', (await it('Case')).size.x > 0);
  await setField('size.x', '30');
  await setField('pos.0', '10'); await setField('pos.1', '-5'); await setField('pos.2', '3');
  check('position X/Y/Z', JSON.stringify((await it('Case')).pos) === '[10,-5,3]');
  await setField('rot.2', '90'); check('rotation Z, Size row swaps X/Y', (await it('Case')).rot[2] === 90 && /X ?25 .*Y ?30/.test(await dims()), await dims());
  await setField('rot.2', '0');
  await press('[data-q="floor"]'); await idle(); check('Drop to floor → Z 0', (await it('Case')).pos[2] === 0);
  await press('[data-q="center"]'); await idle(); check('Center → X 0, Y 0', (await it('Case')).pos[0] === 0 && (await it('Case')).pos[1] === 0);
  await press('[data-q="rx"]'); await idle(); check('↻X → rotation X 90', (await it('Case')).rot[0] === 90);
  await press('[data-q="ry"]'); await press('[data-q="rz"]'); await idle(); check('↻Y and ↻Z', (await it('Case')).rot[1] === 90 && (await it('Case')).rot[2] === 90);
  await ev(`(() => { const E = boardEngine; E._edit(E.sel, (x) => { x.rot = [0, 0, 0]; }); })()`); await idle();
  // drag a label to scrub a value
  const lab = await el('.cad-inspector [data-scrub="size.x"]');
  await mouse('mouseMoved', lab[0], lab[1]); await mouse('mousePressed', lab[0], lab[1], { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', lab[0] + i * 4, lab[1], { buttons: 1 });
  await mouse('mouseReleased', lab[0] + 40, lab[1], { button: 'left', clickCount: 1 }); await idle();
  check('drag the W label to change it (scrub)', (await it('Case')).size.x > 30, (await it('Case')).size.x);
  for (const r of ['hole', 'ref', 'solid']) { await press(`.cad-inspector [data-role="${r}"]`); await idle(); check('role → ' + r, (await it('Case')).role === r); }
  await press('.cad-inspector [data-role="hole"]'); await idle();
  check('Clearance field appears for holes', await has('.cad-inspector [data-f="clearance"]'));
  await setField('clearance', '0.3'); check('clearance value', (await it('Case')).clearance === 0.3);
  await press('.cad-inspector [data-role="solid"]'); await idle();
  await press('[data-dup]'); await idle();
  check('Duplicate → copy 10 mm to the right, selected', (await items()).length === 2 && (await selNames()).startsWith('Case'));
  await press('[data-del]'); await idle(); check('Delete', (await items()).length === 1);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(150);
  await press('.cad-inspector [data-close]'); check('✕ closes the panel', await ev(`document.querySelector('.cad-inspector').classList.contains('hidden')`));

  // ======================================================================
  section('Selection (mouse, keyboard, touch)');
  await reset([{ type: 'box', name: 'A', size: { x: 20, y: 20, z: 20 }, pos: [-40, 0, 0] }, { type: 'box', name: 'B', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0] }, { type: 'box', name: 'C', size: { x: 20, y: 20, z: 20 }, pos: [40, 0, 0] }]);
  await ev(`boardEngine._view('front')`); await sleep(300);
  const PA = await scr(-40, -10, 16), PB = await scr(0, -10, 16), PC = await scr(40, -10, 16);
  await click(PA); check('click selects', (await selNames()) === 'A');
  await click(PC, MOD.shift); check('Shift-click adds', (await selNames()) === 'A,C');
  await click(PB, MOD.meta); check('⌘-click adds', (await selNames()) === 'A,C,B');
  await click(PA, MOD.shift); check('Shift-click again removes', (await selNames()) === 'C,B');
  await click(PA); check('plain click replaces the selection', (await selNames()) === 'A');
  await key('Escape', 'Escape', 27); check('Esc clears', (await selNames()) === '');
  await click(await scr(0, 0, 60)); await key('a', 'KeyA', 65, MOD.meta, ['selectAll']);
  check('⌘A selects all objects', (await selNames()) === 'A,B,C');
  check('⌘A does not select page text', (await ev(`String(getSelection()).length`)) === 0);
  await key('Escape', 'Escape', 27);
  await press('[data-selall]'); check('All button selects all', (await selNames()) === 'A,B,C');
  await press('[data-selall]'); check('All again clears', (await selNames()) === '');
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await tap(PB); check('touch tap selects', (await selNames()) === 'B');
  await press('[data-multimode]'); await tap(PA); await tap(PC);
  check('Multi mode: taps add', (await selNames()) === 'B,A,C');
  await tap(PA); check('Multi mode: tap again removes', (await selNames()) === 'B,C');
  await press('[data-multimode]'); await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  await key('Escape', 'Escape', 27);
  // list selection
  await ev(`boardEngine.listEl.classList.remove('collapsed')`);
  const rowB = await ev(`(() => { const r = [...document.querySelectorAll('.cad-row')].find((x) => x.innerText.trim().startsWith('B')).getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; })()`);
  await click(rowB); check('click a row in the Shapes list selects it', (await selNames()) === 'B');
  const eyeB = await ev(`(() => { const r = [...document.querySelectorAll('.cad-row')].find((x) => x.innerText.trim().startsWith('B')).querySelector('[data-vis]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await click(eyeB); await idle(); check('eye button hides', (await it('B')).hidden === true);
  await click(eyeB); await idle(); check('eye button shows again', (await it('B')).hidden === false);
  const head = await ev(`document.querySelector('.cad-list-head').getBoundingClientRect().top`);
  const vb = await ev(`(() => { const a = document.querySelector('.cad-list').getBoundingClientRect(), b = document.querySelector('.cad-viewbar > .cad-seg:not(.cad-gizmo)').getBoundingClientRect(); return [a.bottom, b.bottom, a.right, document.querySelector('.cad-viewbar').getBoundingClientRect().left]; })()`);
  check('Shapes list opens upward (rows above the header)', await ev(`[...document.querySelectorAll('.cad-row')].every((r) => r.getBoundingClientRect().bottom <= ${head} + 1)`));
  check('Shapes panel and view bar share a bottom line, no overlap', near(vb[0], vb[1], 1) && vb[2] <= vb[3], JSON.stringify(vb));

  // ======================================================================
  section('Multi-selection: move as one, align, actions');
  await reset([{ type: 'box', name: 'A', size: { x: 20, y: 20, z: 10 }, pos: [60, 30, 5] }, { type: 'box', name: 'B', size: { x: 10, y: 10, z: 30 }, pos: [100, 30, 8] }]);
  await press('[data-selall]');
  const gap = async () => { const [x, y] = await items(); return Math.hypot(x.pos[0] - y.pos[0], x.pos[1] - y.pos[1], x.pos[2] - y.pos[2]).toFixed(3); };
  const g0 = await gap();
  await press('[data-g="center"]'); await idle();
  check('Center: selection centred, spacing kept', (await gap()) === g0 && /centre|0/.test('0'));
  const bb = await ev(`(() => { const b = boardEngine._boundsOf(boardEngine._selIds()); const c = b.getCenter(new boardEngine.T.Vector3()); return [c.x, c.y, b.min.z]; })()`);
  check('Center → selection centre at 0,0', near(bb[0], 0, 0.01) && near(bb[1], 0, 0.01), JSON.stringify(bb));
  await press('[data-g="floor"]'); await idle();
  check('Drop to floor: lowest at Z 0, spacing kept', (await gap()) === g0 && near(await ev(`boardEngine._boundsOf(boardEngine._selIds()).min.z`), 0, 0.01));
  await press('[data-g="rz"]'); await idle(); check('↻Z rotates the group rigidly', (await gap()) === g0 && (await items()).every((x) => x.rot[2] === 90));
  await press('[data-g="cx"]'); await press('[data-g="cy"]'); await idle(); check('Center X / Center Y', (await gap()) === g0);
  await ev(`document.querySelector('.cad-align-sec').open = true`);
  await press('[data-align="z:max"]'); await idle();
  const tops = await ev(`boardEngine.data.items.map((x) => boardEngine._boundsOf([x.id]).max.z.toFixed(2)).join(',')`);
  check('Align to each other → Top lines up the tops', tops.split(',')[0] === tops.split(',')[1], tops);
  for (const r of ['hole', 'solid']) { await press(`.cad-inspector [data-role="${r}"]`); await idle(); check('role for all → ' + r, (await items()).every((x) => x.role === r)); }
  await press('[data-mdup]'); await idle(); check('Duplicate all → 4 shapes, copies selected', (await items()).length === 4 && (await selNames()).split(',').length === 2);
  await press('[data-mdel]'); await idle(); check('Delete all selected', (await items()).length === 2);
  await press('[data-selall]'); await press('[data-mq="hide"]'); await idle(); check('Hide all', (await items()).every((x) => x.hidden));

  // ======================================================================
  section('Combine');
  await reset([{ type: 'box', name: 'A', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0] }, { type: 'box', name: 'B', size: { x: 20, y: 20, z: 10 }, pos: [20, 0, 0] }, { type: 'box', name: 'C', size: { x: 10, y: 10, z: 10 }, pos: [60, 0, 0] }]);
  await ev(`boardEngine._setSel(boardEngine.data.items.slice(0, 2).map((x) => x.id))`); await sleep(200);
  const before = JSON.stringify((await items()).map((x) => x.pos));
  await press('[data-combine]'); await idle();
  check('Combine: positions unchanged', JSON.stringify((await items()).map((x) => x.pos)) === before);
  check('Combine: one row "A + B · 2 parts" in the list', await ev(`[...document.querySelectorAll('.cad-row')].map((r) => r.innerText.trim()).join('|')`).then((t) => /A \+ B\s*2 parts/.test(t)));
  await ev(`boardEngine._select(null)`); await ev(`boardEngine._select(boardEngine.data.items[1].id)`);
  check('selecting a part selects the whole object', (await selNames()) === 'A,B');
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-gname]'); i.value = 'Stand'; i.dispatchEvent(new Event('change')); })()`); await sleep(150);
  check('rename the combined object', await ev(`Object.values(boardEngine.data.groups)[0].name`) === 'Stand');
  const chip = await ev(`(() => { const b = [...document.querySelectorAll('[data-only]')].find((x) => x.textContent.trim() === 'B'); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await click(chip); check('tap a part chip → edit just that part', (await selNames()) === 'B' && await has('[data-selgroup]'));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`);
  await ev(`(() => { const E = boardEngine; E._editMany([E.data.items[1].id], (x) => { x.pos[0] = 60; }); E._inspFor = null; E._renderInspector(); })()`); await idle(); await ev(`boardEngine._inspFor = null; boardEngine._renderInspector()`);
  check('parts not touching → "prints as 2 pieces" warning', /2 separate pieces/.test(await ev(`(document.querySelector('.cad-inspector .cad-msg') || {}).textContent || ''`)));
  await ev(`(() => { const E = boardEngine; E._editMany([E.data.items[1].id], (x) => { x.pos[0] = 20; }); })()`); await idle();
  await key('g', 'KeyG', 71, MOD.meta | MOD.shift); await idle();
  check('⇧⌘G uncombines', Object.keys(await ev(`boardEngine.data.groups`)).length === 0);
  await key('g', 'KeyG', 71, MOD.meta); await idle();
  check('⌘G combines again', Object.keys(await ev(`boardEngine.data.groups`)).length === 1);
  await press('[data-mdup]'); await idle();
  check('duplicate a combined object → its own new combined copy', Object.keys(await ev(`boardEngine.data.groups`)).length === 2);
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('undo restores combined objects too', Object.keys(await ev(`boardEngine.data.groups`)).length === 1);

  // ======================================================================
  section('Views & navigation');
  await ev(`window.__wz = []; window.addEventListener('wheel', (e) => { if (e.ctrlKey) window.__wz.push(e.defaultPrevented); }, { passive: true })`);
  await ev(`boardEngine._select(boardEngine.data.items[0] && boardEngine.data.items[0].id)`); await sleep(150);
  for (const sel of ['.cad-inspector:not(.hidden)', '.cad-tools', '.cad-viewbar', '.cad-view canvas']) {
    if (!(await ev(`!!document.querySelector('.cad-root ${sel}')`))) continue;
    const p3 = await ev(`(() => { const e = document.querySelector('.cad-root ${sel}') || document.querySelector('.cad-root .cad-tools'); const r = e.getBoundingClientRect(); return [r.x + Math.min(20, r.width / 2), r.y + Math.min(20, r.height / 2)]; })()`);
    await mouse('mouseWheel', p3[0], p3[1], { deltaX: 0, deltaY: -10, modifiers: MOD.ctrl }); await sleep(80);
  }
  check('pinch / ctrl+scroll anywhere in the 3D area never zooms the page', (await ev(`window.__wz.length`)) >= 3 && await ev(`window.__wz.every(Boolean)`), await ev(`JSON.stringify(window.__wz)`));

  for (const [v, d] of [['top', [0, 0, -1]], ['bottom', [0, 0, 1]], ['front', [0, 1, 0]], ['back', [0, -1, 0]], ['left', [1, 0, 0]], ['right', [-1, 0, 0]]]) {
    await press(`[data-view="${v}"]`);
    const r = await ev(`(() => { const d = boardEngine.camera.getWorldDirection(new boardEngine.T.Vector3()); return [boardEngine.isOrtho, d.x, d.y, d.z, boardEngine.camera.position.toArray().every(Number.isFinite)]; })()`);
    check(`${v}: orthographic, looking ${JSON.stringify(d)}`, r[0] && r[4] && near(r[1], d[0], 0.01) && near(r[2], d[1], 0.01) && near(r[3], d[2], 0.01), JSON.stringify(r));
  }
  await press('[data-view="iso"]'); check('3D view is perspective', !(await ev(`boardEngine.isOrtho`)));
  await press('[data-axis="x"]'); const ax1 = await ev(`boardEngine.camera.getWorldDirection(new boardEngine.T.Vector3()).x`);
  await press('[data-axis="x"]'); const ax2 = await ev(`boardEngine.camera.getWorldDirection(new boardEngine.T.Vector3()).x`);
  check('X box looks along X, tap again flips', near(ax1, -1, 0.01) && near(ax2, 1, 0.01) && (await ev(`document.querySelector('[data-axis="x"]').textContent`)) === '−X');
  await press('[data-axis="y"]'); await press('[data-axis="z"]'); check('Y and Z boxes', near(await ev(`boardEngine.camera.getWorldDirection(new boardEngine.T.Vector3()).z`), -1, 0.01));
  await mouse('mouseWheel', 800, 450, { deltaX: 30, deltaY: 3 }); await sleep(150);
  check('trackpad scroll orbits and returns to perspective', !(await ev(`boardEngine.isOrtho`)));
  let d0 = await ev(`boardEngine.camera.position.distanceTo(boardEngine.target)`);
  await mouse('mouseWheel', 800, 450, { deltaX: 0, deltaY: 100 }); await sleep(150);
  check('mouse wheel zooms', (await ev(`boardEngine.camera.position.distanceTo(boardEngine.target)`)) > d0);
  d0 = await ev(`boardEngine.camera.position.distanceTo(boardEngine.target)`);
  await mouse('mouseWheel', 800, 450, { deltaX: 0, deltaY: -20, modifiers: MOD.ctrl }); await sleep(150);
  check('pinch (ctrl+wheel) zooms in', (await ev(`boardEngine.camera.position.distanceTo(boardEngine.target)`)) < d0);
  await press('[data-fit]'); check('Fit keeps a valid camera', await ev(`boardEngine.camera.position.toArray().every(Number.isFinite)`));
  await press('[data-holes]'); check('Holes toggle', !(await ev(`boardEngine.showHoles`))); await press('[data-holes]');
  await press('[data-snap]'); check('Snap toggle off', !(await ev(`boardEngine.snapOn`))); await press('[data-snap]');
  check('Snap shows "1 mm"', /1 mm/.test(await ev(`document.querySelector('[data-snap]').textContent`)));
  for (const [k, v] of [['2', 'top'], ['3', 'front'], ['4', 'right'], ['1', 'iso']]) { await key(k, 'Digit' + k, 48 + +k); check(`key ${k} → ${v}`, await ev(`document.querySelector('[data-view="${v}"]').classList.contains('on')`)); }
  await key('2', 'Digit2', 50, MOD.shift); check('⇧2 → bottom', await ev(`document.querySelector('[data-view="bottom"]').classList.contains('on')`));

  // ======================================================================
  section('Gizmo & keyboard moves');
  await reset([{ type: 'box', name: 'G', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`);
  check('Move/Rotate buttons appear when selected', !(await ev(`document.querySelector('.cad-gizmo').classList.contains('hidden')`)));
  await press('[data-mode="rotate"]'); check('Rotate mode', (await ev(`boardEngine.tc.mode`)) === 'rotate');
  await key('m', 'KeyM', 77); check('M → move mode', (await ev(`boardEngine.tc.mode`)) === 'translate');
  await key('r', 'KeyR', 82); check('R → rotate mode', (await ev(`boardEngine.tc.mode`)) === 'rotate'); await key('m', 'KeyM', 77);
  await key('ArrowRight', 'ArrowRight', 39); check('→ nudges +1 mm', (await it('G')).pos[0] === 1);
  await key('ArrowUp', 'ArrowUp', 38, MOD.shift); check('⇧↑ nudges +10 mm Y', (await it('G')).pos[1] === 10);
  await key('PageUp', 'PageUp', 33); check('PageUp raises Z', (await it('G')).pos[2] === 1);
  await key('d', 'KeyD', 68, MOD.meta); await idle(); check('⌘D duplicates', (await items()).length === 2);
  await key('Backspace', 'Backspace', 8); await idle(); check('Backspace deletes', (await items()).length === 1);
  await key('b', 'KeyB', 66); await idle(); check('B adds a box', (await items()).length === 2);
  await key('c', 'KeyC', 67); await idle(); check('C adds a cylinder', (await items()).some((x) => x.type === 'cylinder'));
  await key('h', 'KeyH', 72); check('H toggles holes', !(await ev(`boardEngine.showHoles`))); await key('h', 'KeyH', 72);
  // live-drag regression: object must not jump to 0,0,0 while rebuilds land mid-drag
  await reset([{ type: 'box', name: 'D', size: { x: 20, y: 20, z: 20 }, pos: [140, 40, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`);
  const drag = await ev(`(async () => { const E = boardEngine; const g = () => E.objs[E.sel].group; E.tc.dispatchEvent({ type: 'dragging-changed', value: true }); let minX = 1e9; for (let x = 135; x >= 101; x -= 3) { g().position.x = x; E.tc.dispatchEvent({ type: 'objectChange' }); await new Promise((r) => setTimeout(r, 150)); minX = Math.min(minX, g().position.x); } E.tc.dispatchEvent({ type: 'dragging-changed', value: false }); await new Promise((r) => setTimeout(r, 500)); return [minX, E._item(E.sel).pos[0]]; })()`);
  check('dragging with live rebuilds never jumps to the centre', drag[0] > 90 && near(drag[1], 102, 1.01), JSON.stringify(drag));

  // ======================================================================
  section('Measure');
  await reset([{ type: 'box', name: 'M', size: { x: 30, y: 20, z: 15 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await sleep(300);
  await press('[data-measure]'); check('Measure mode on', await ev(`boardEngine.measureOn`));
  const m1 = await scr(-15, -10, 15), m2 = await scr(15, -10, 15);
  await click([m1[0] + 3, m1[1] + 3]); await click([m2[0] - 3, m2[1] + 3]);
  check('two clicks, corners snap → 30 mm, ΔX 30', /30 mm/.test(await ev(`(document.querySelector('.cad-mlabel') || {}).innerText || ''`)), await ev(`(document.querySelector('.cad-mlabel') || {}).innerText || ''`));
  await press('[data-mclear]'); check('Clear removes measurements', !(await has('.cad-mlabel')));
  // live distance while placing the second point; double-click to type it
  await click([m1[0] + 3, m1[1] + 3]);
  await mouse('mouseMoved', m2[0] - 3, m2[1] + 3); await sleep(200);
  check('after the 1st point, a live label follows the pointer (30 mm)', /^30 mm/.test(await ev(`(document.querySelector('.cad-mlive') || {}).innerText || ''`)), await ev(`(document.querySelector('.cad-mlive') || {}).innerText || ''`));
  const lv = await el('.cad-mlive');
  await mouse('mouseMoved', lv[0], lv[1]); await mouse('mousePressed', lv[0], lv[1], { button: 'left', clickCount: 1 }); await mouse('mouseReleased', lv[0], lv[1], { button: 'left', clickCount: 1 });
  await mouse('mousePressed', lv[0], lv[1], { button: 'left', clickCount: 2 }); await mouse('mouseReleased', lv[0], lv[1], { button: 'left', clickCount: 2 }); await sleep(250);
  check('double-click the live label → distance box, focused', await ev(`document.activeElement && document.activeElement.classList.contains('cad-mlive-in')`));
  await ev(`(() => { const i = document.querySelector('.cad-mlive-in'); i.value = '12'; })()`);
  await key('Enter', 'Enter', 13); await sleep(200);
  const typed = await ev(`[...document.querySelectorAll('.cad-mlabel:not(.cad-mlive)')].map((l) => l.innerText.replace(/\\n/g, ' ')).join(' | ')`);
  check('typed 12 → a 12 mm measurement in that direction (ΔX 12)', /12 mm ΔX 12 · ΔY 0 · ΔZ 0/.test(typed), typed);
  check('live label gone after placing', !(await has('.cad-mlive')));
  await click([m1[0] + 3, m1[1] + 3]); await mouse('mouseMoved', m2[0] - 3, m2[1] + 3); await sleep(150);
  const lv2 = await el('.cad-mlive');
  await mouse('mousePressed', lv2[0], lv2[1], { button: 'left', clickCount: 2 }); await mouse('mouseReleased', lv2[0], lv2[1], { button: 'left', clickCount: 2 }); await sleep(200);
  await key('Escape', 'Escape', 27); await sleep(150);
  check('Esc while typing → back to the live readout, still measuring', await has('.cad-mlive') && !(await has('.cad-mlive-in')) && await ev(`!!boardEngine.mFirst`));
  await press('[data-mclear]');
  await key('d', 'KeyD', 68); check('D toggles measure off', !(await ev(`boardEngine.measureOn`)));

  // ======================================================================
  section('Sketch');
  await reset();
  await press('[data-sketch]'); await sleep(300);
  check('Sketch mode: bar shown, top view', await ev(`!!boardEngine.sk && !document.querySelector('.cad-skbar').classList.contains('hidden') && boardEngine.isOrtho`));
  const sp = (x, y) => ev(`(() => { const v = new boardEngine.T.Vector3(${x}, ${y}, 0).applyMatrix4(boardEngine.sk.frame.matrixWorld).project(boardEngine.camera); const r = boardEngine.renderer.domElement.getBoundingClientRect(); return [(v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top]; })()`);
  await press('[data-sktool="rect"]'); await click(await sp(-20, -10)); await click(await sp(20, 10));
  await press('[data-sktool="circle"]'); await click(await sp(30, 0)); await click(await sp(36, 0));
  await press('[data-sktool="line"]'); for (const p of [[-20, 15], [0, 30], [20, 15]]) await click(await sp(...p));
  await press('[data-skundo]'); check('undo removes the last line point', (await ev(`boardEngine.sk.pts.length`)) === 2);
  await click(await sp(20, 15)); await click(await sp(-20, 15));
  const prof = await ev(`JSON.stringify(boardEngine._sketchItem().profiles)`);
  check('rectangle 40×20, circle r6, closed triangle', /"k":"rect","x":0,"y":0,"w":40,"h":20/.test(prof) && /"k":"circle","x":30,"y":0,"r":6/.test(prof) && /"k":"poly"/.test(prof), prof);
  await press('[data-skdone]'); await idle();
  const sk0 = await it('Sketch');
  check('Done → stays a 2D sketch (nothing solid)', sk0 && sk0.draft === true && !(await ev(`boardEngine.result && boardEngine.result.triangles.length`)));
  check('floating bar shows Extrude / Cut / Split for the sketch', await ev(`!document.querySelector('.cad-actbar').classList.contains('hidden') && !!document.querySelector('.cad-actbar [data-ab="ext-new"]') && !!document.querySelector('.cad-actbar [data-ab="ext-cut"]') && !!document.querySelector('.cad-actbar [data-ab="ext-split"]')`));
  await extrude('0.05');
  const sk = await it('Extrude');
  check('Extrude all → a shape 0.05 mm thick, sketch kept', sk && sk.height === 0.05 && !sk.draft && (await it('Sketch')).draft && !(await ev(`boardEngine.errors[boardEngine.sel]`)), JSON.stringify(sk && sk.height));
  await setField('height', '5'); check('Height field', (await it('Extrude')).height === 5);
  await setField('profiles.0.w', '50'); check('edit a profile size (rect W)', (await it('Extrude')).profiles[0].w === 50);
  await press('[data-editsketch]'); await sleep(200); check('Edit sketch reopens', await ev(`!!boardEngine.sk`));
  await press('[data-skcancel]'); check('Cancel keeps the sketch as it was', (await it('Extrude')).profiles.length === 3);
  await press('[data-sketch]'); await press('[data-skcancel]'); check('Cancel on a new empty sketch removes it', (await items()).length === 2);
  await key('s', 'KeyS', 83); check('S starts a sketch', await ev(`!!boardEngine.sk`)); await key('Escape', 'Escape', 27);

  // ======================================================================
  section('Sketch: slot, polygon, arc, cut-outs');
  await reset();
  const vol = () => ev(`(() => { const m = boardEngine.result; if (!m) return 0; const v = m.vertices, t = m.triangles; let s = 0; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  await press('[data-sketch]'); await sleep(300);
  await press('[data-sktool="rect"]'); await click(await sp(-30, -20)); await click(await sp(30, 20));          // plate 60×40
  await press('[data-skcut]'); check('Cut toggle on', await ev(`boardEngine.sk.cut === true`));
  await press('[data-sktool="circle"]'); await click(await sp(-15, 0)); await click(await sp(-10, 0));        // Ø10 hole
  await press('[data-sktool="slot"]');
  check('Slot width box shown for the Slot tool', !(await ev(`document.querySelector('[data-skslotw-wrap]').classList.contains('hidden')`)));
  await click(await sp(5, -10)); await click(await sp(5, 10));                                                   // vertical slot, 20 between centres, width 6
  await press('[data-sktool="ngon"]');
  await ev(`(() => { const i = document.querySelector('[data-sksides]'); i.value = '6'; i.dispatchEvent(new Event('change')); })()`);
  await click(await sp(20, 0)); await click(await sp(20, 5));                                                    // hexagon r5, corner up
  const pr = await ev(`JSON.stringify(boardEngine._sketchItem().profiles)`);
  check('drawn: plate + cut circle + cut slot + cut hexagon', /"k":"rect".*"w":60,"h":40/.test(pr) && /"k":"circle","x":-15,"y":0,"r":5,"cut":true/.test(pr) && /"k":"slot","x":5,"y":0,"w":26,"h":6,"a":90,"cut":true/.test(pr) && /"k":"ngon","x":20,"y":0,"r":5,"n":6,"a":0,"cut":true/.test(pr), pr);
  await press('[data-skdone]'); await idle(); await extrude('0.05');
  const H0 = 0.05; // default thickness of a new sketch shape
  const expect1 = (2400 - Math.PI * 25 - (20 * 6 + Math.PI * 9) - 1.5 * Math.sqrt(3) * 25) * H0;
  check('plate with 3 cut-outs → exact area × 0.05 mm', near(await vol(), expect1, 0.08), (await vol()) + ' vs ' + expect1);
  check('panel lists 4 shapes with Solid/Cut buttons', (await ev(`document.querySelectorAll('.cad-prof').length`)) === 4 && (await ev(`document.querySelectorAll('[data-pcut].on').length`)) === 3);
  await press('[data-pcut="1"]'); await idle();
  check('Cut → Solid on the circle fills the hole back in', near(await vol(), expect1 + Math.PI * 25 * H0, 0.08), await vol());
  await press('[data-pdel="1"]'); await idle(); check('✕ removes a shape from the sketch', (await it('Extrude')).profiles.length === 3);
  await setField('profiles.2.n', '8'); check('edit hexagon → 8 sides', (await it('Extrude')).profiles[2] ? (await it('Extrude')).profiles.some((q) => q.k === 'ngon' && q.n === 8) : false, JSON.stringify((await it('Extrude')).profiles));
  // arc: a D shape — straight bottom edge, arc over the top
  await reset();
  await press('[data-sketch]'); await sleep(300);
  await press('[data-sktool="line"]');
  await click(await sp(-10, 0)); await click(await sp(10, 0));
  await press('[data-skarc]'); check('Arc on', await ev(`boardEngine.sk.arc === true`));
  await click(await sp(-10, 0));                                     // arc ends back at the first point…
  check('arc waits for its bend point', await ev(`!!boardEngine.sk.pend`));
  await click(await sp(0, 10));                                      // …bending through the top
  const d = await ev(`JSON.stringify(boardEngine._sketchItem().profiles)`);
  check('closed D shape: line + arc', /"k":"poly","pts":\[\[-10,0,0,10\],\[10,0\]\]/.test(d), d);
  await press('[data-skdone]'); await idle(); await extrude('0.05');
  check('D shape (semicircle r10) → area 157.08 × 0.05', near(await vol(), Math.PI * 50 * 0.05, 0.08), await vol());
  await key('s', 'KeyS', 83); await key('o', 'KeyO', 79); check('O → slot tool', await ev(`boardEngine.sk.tool === 'slot'`));
  await key('p', 'KeyP', 80); check('P → polygon tool', await ev(`boardEngine.sk.tool === 'ngon'`));
  await key('x', 'KeyX', 88); check('X → cut on', await ev(`boardEngine.sk.cut === true`));
  await key('a', 'KeyA', 65); check('A → arc (switches to Line)', await ev(`boardEngine.sk.arc === true && boardEngine.sk.tool === 'line'`));
  await key('Escape', 'Escape', 27); check('Esc leaves an empty new sketch', await ev(`!boardEngine.sk`) && (await items()).length === 2);

  // ======================================================================
  section('2D sketches: areas, extrude New / Cut / Split, planes');
  await reset();
  await press('[data-sketch]'); await sleep(300);
  await press('[data-sktool="rect"]'); await click(await sp(-10, -10)); await click(await sp(10, 10));   // 20×20
  await click(await sp(0, 0)); await click(await sp(20, 20));                                              // overlaps 10×10
  await press('[data-skdone]'); await idle(); await sleep(300);
  const skid = await ev(`boardEngine.data.items.find((x) => x.name === 'Sketch').id`);
  // screen point of a sketch-local point on the finished (2D) sketch
  const dp = (x, y) => ev(`(() => { const E = boardEngine; const o = E.objs[${JSON.stringify(skid)}]; o.group.updateMatrixWorld(true); const v = new E.T.Vector3(${x}, ${y}, 0).applyMatrix4(o.group.matrixWorld).project(E.camera); const r = E.renderer.domElement.getBoundingClientRect(); return [(v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top]; })()`);
  check('two overlapping squares → 3 areas shaded', (await ev(`(boardEngine.objs[${JSON.stringify(skid)}].fills || []).length`)) === 3);
  check('Done made nothing solid', !(await ev(`boardEngine.result && boardEngine.result.triangles.length`)));
  await click(await dp(0, 0)); await sleep(500);
  check('tap the overlap → Extrude opens with 1 area picked', await ev(`!!boardEngine.exMode && boardEngine.exMode.sel.size === 1`));
  await click(await dp(-10, -10)); await sleep(200);
  check('tap another area → 2 picked', await ev(`boardEngine.exMode.sel.size === 2`));
  await click(await dp(-10, -10)); await sleep(200);
  check('tap it again → unpicked', await ev(`boardEngine.exMode.sel.size === 1`));
  await ev(`(() => { const i = document.querySelector('[data-exdist]'); i.value = '4'; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-exgo]'); await sleep(200); await idle();
  check('overlap only → 10×10×4 solid = 400 mm³', near(await vol(), 400, 0.5), await vol());
  check('sketch still there as 2D', (await it('Sketch')) && (await it('Sketch')).draft);
  // Cut: the 20×20 square's other area cut 2 mm into a plate
  await reset([{ type: 'box', name: 'Plate', size: { x: 60, y: 60, z: 5 }, pos: [0, 0, 0] }]);
  await press('[data-sketch]'); await sleep(300);
  await press('[data-sktool="rect"]'); await click(await sp(-10, -10)); await click(await sp(10, 10));
  await press('[data-skdone]'); await idle(); await sleep(300);
  const sk2 = await it('Sketch'); await ev(`boardEngine._select(${JSON.stringify(sk2.id)})`); await sleep(100);
  await ev(`boardEngine._setDraftPlane(${JSON.stringify(sk2.id)}, 'xy', 5)`); await idle();
  check('offset → sketch on Z 5 (top of plate)', near((await it('Sketch')).pos[2], 5, 1e-6));
  await extrude('-2', 'cut');
  check('Cut −2 → 20×20×2 pocket: 18000 − 800', near(await vol(), 18000 - 800, 1), (await vol()) + ' ' + JSON.stringify((await items()).map((x) => [x.name, x.role, x.pos, x.rot, x.height, x.draft])));
  // Split
  await ev(`boardEngine._select(${JSON.stringify(sk2.id)})`); await sleep(200);
  await extrude('-5', 'split'); await sleep(300); await idle();
  const sp2 = (await items()).filter((x) => x.role === 'solid' && x.type !== 'sketch' || (x.type === 'sketch' && !x.draft && x.role === 'solid'));
  check('Split → the plate becomes separate parts (≥ 2 solids)', sp2.length >= 2, JSON.stringify(sp2.map((x) => x.name)));
  // planes: quick XY / XZ / YZ buttons on the 2D sketch panel
  await reset();
  await press('[data-sketch]'); await sleep(300);
  check('plane picker shown on a new empty sketch', !(await ev(`document.querySelector('.cad-skplane').classList.contains('hidden')`)));
  await press('[data-skplane="xz"]'); await sleep(300);
  check('XZ → sketching on the front plane', await ev(`Math.abs(boardEngine._sketchItem().rot[0] - 90) < 1e-6`));
  await press('[data-sktool="circle"]'); await click(await sp(0, 10)); await click(await sp(5, 10));
  check('plane picker hides once drawing starts', await ev(`document.querySelector('.cad-skplane').classList.contains('hidden')`));
  await press('[data-skdone]'); await idle();
  await press('.cad-inspector [data-dplane="yz"]'); await sleep(200);
  check('after drawing: YZ button turns the sketch onto the side plane', JSON.stringify((await it('Sketch')).rot) === '[0,90,0]');
  await press('.cad-inspector [data-dplane="xy"]'); await sleep(200);
  check('XY button → back on the floor', JSON.stringify((await it('Sketch')).rot) === '[0,0,0]');
  await press('[data-undo]'); await sleep(200); check('undo plane switch', JSON.stringify((await it('Sketch')).rot) === '[0,90,0]');
  // Extrude from inside sketch mode, then back to drawing
  await reset();
  await press('[data-sketch]'); await sleep(300);
  await press('[data-sktool="rect"]'); await click(await sp(-5, -5)); await click(await sp(5, 5));
  await press('[data-skext]'); await sleep(500);
  await press('[data-exop="new"]');
  check('Extrude in the sketch bar → Extrude panel', await ev(`!!boardEngine.exMode && !boardEngine.sk`));
  await press('[data-exgo]'); await sleep(400); await idle();
  check('…makes the object and goes back to drawing', await ev(`!!boardEngine.sk`) && (await items()).some((x) => x.name === 'Extrude'), JSON.stringify([await ev(`!!boardEngine.sk`), await ev(`!!boardEngine.exMode`), (await items()).map((x) => x.name)]));
  await press('[data-skdone]'); await idle();
  // bottom bar: typed Move / Rotate; selecting defaults to Move
  await reset([{ type: 'box', name: 'M', size: { x: 10, y: 20, z: 5 }, pos: [0, 0, 0] }, { type: 'box', name: 'N', size: { x: 4, y: 4, z: 4 }, pos: [30, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(100);
  await key('t', 'KeyT', 84); check('T → scale mode', await ev(`boardEngine.mode === 'scale'`));
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await sleep(100);
  check('selecting another object → back to Move', await ev(`boardEngine.mode === 'translate'`));
  check('Move bar shows this object\'s position', !(await ev(`document.querySelector('.cad-xfbar').classList.contains('hidden')`)) && (await ev(`document.querySelector('[data-xft]').textContent`)) === 'Position' && (await ev(`document.querySelector('[data-xf="0"]').value`)) === '30');
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(100);
  check('…and follows the selection', (await ev(`document.querySelector('[data-xf="0"]').value`)) === '0');
  await ev(`(() => { const i = document.querySelector('[data-xf="0"]'); i.value = '12.5'; const k = document.querySelector('[data-xf="2"]'); k.value = '3'; })()`);
  await press('[data-xfapply]'); await idle();
  check('typed X 12.5, Z 3 → moved there', JSON.stringify((await it('M')).pos) === '[12.5,0,3]', JSON.stringify((await it('M')).pos));
  await key('ArrowRight', 'ArrowRight', 39); await sleep(200);
  check('arrow-key nudge → bar shows the new X', Number(await ev(`document.querySelector('[data-xf="0"]').value`)) !== 12.5, await ev(`document.querySelector('[data-xf="0"]').value`));
  await key('r', 'KeyR', 82); await sleep(100);
  check('R → bar shows Rotation (°)', (await ev(`document.querySelector('[data-xft]').textContent`)) === 'Rotation');
  await ev(`(() => { const i = document.querySelector('[data-xf="2"]'); i.value = '90'; })()`);
  await press('[data-xfapply]'); await idle();
  check('typed Rotation Z 90°', near((await it('M')).rot[2], 90, 1e-3), JSON.stringify(await it('M')));
  await press('[data-undo]'); await sleep(200); check('one undo step', near((await it('M')).rot[2], 0, 1e-6));
  check('Mirror / Flip are above the Position section', await ev(`(() => { const h = [...document.querySelectorAll('.cad-inspector .cad-sec-t')].map((x) => x.textContent); return h.findIndex((t) => /^Mirror/.test(t)) < h.indexOf('Position') && h.findIndex((t) => /^Mirror/.test(t)) >= 0; })()`));
  // Cut by object (floating bar): the cylinder's shape is cut out of the plate and used up
  await reset([{ type: 'box', name: 'Plate', size: { x: 40, y: 30, z: 6 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'Tool', size: { d: 10, z: 20 }, pos: [0, 0, -5] }]);
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await sleep(200);
  check('floating bar: Cut by plane + Cut by object', await ev(`!!document.querySelector('.cad-actbar [data-ab="plane"]') && !!document.querySelector('.cad-actbar [data-ab="cutobj"]')`));
  await press('.cad-actbar [data-ab="cutobj"]'); await idle(); await sleep(300); await idle();
  check('Cut by object → plate with a Ø10 hole, the tool is used up', (await items()).length === 1 && near(await vol(), 7200 - Math.PI * 25 * 6, 1), (await items()).length + ' ' + (await vol()));
  await press('[data-undo]'); await sleep(300); check('undo → tool back, plate whole', (await items()).length === 2);

  // 2 picked: choose which one is the cutter; a 3rd object it also touches is left alone
  await reset([{ type: 'box', name: 'Plate', size: { x: 40, y: 30, z: 6 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'Tool', size: { d: 10, z: 20 }, pos: [0, 0, -5] }, { type: 'box', name: 'Other', size: { x: 6, y: 6, z: 4 }, pos: [0, 0, 8] }]);
  await ev(`boardEngine._setSel([boardEngine.data.items[0].id, boardEngine.data.items[1].id])`); await sleep(200);
  check('2 picked → bar offers Cut / Split by object', await ev(`!!document.querySelector('.cad-actbar [data-ab="mcut"]') && !!document.querySelector('.cad-actbar [data-ab="msplit"]')`));
  await press('.cad-actbar [data-ab="mcut"]'); await sleep(200);
  check('chooser lists both objects', (await ev(`document.querySelectorAll('.cad-inspector [data-ccid]').length`)) === 2);
  check('smaller object (Tool) listed first as the default cutter', await ev(`(() => { const b = document.querySelector('.cad-inspector [data-ccid]'); return b.dataset.ccid === boardEngine.data.items[1].id && /default/.test(b.textContent); })()`));
  { const tid = await ev(`boardEngine.data.items[1].id`); await press('.cad-inspector [data-ccid="' + tid + '"]'); } await idle(); await sleep(300); await idle();
  { const its = await items();
    check('Tool chosen → Plate gets the hole, Tool used up, Other untouched', its.length === 2 && its.some((x) => x.name === 'Plate' && (x.cuts || []).length === 1) && its.some((x) => x.name === 'Other' && !(x.cuts || []).length), JSON.stringify(its.map((x) => [x.name, (x.cuts || []).length]))); }

  // rotation turns about the object's centre (gizmo pivot, fields, ↻ buttons)
  await reset([{ type: 'box', name: 'R', size: { x: 40, y: 10, z: 6 }, pos: [10, 5, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(100);
  const ctr = () => ev(`(() => { const c = boardEngine._boundsOf([boardEngine.data.items[0].id]).getCenter(new boardEngine.T.Vector3()); return [c.x, c.y, c.z].map((v) => Math.round(v * 100) / 100); })()`);
  const c0 = await ctr();
  await key('r', 'KeyR', 82); await sleep(150);
  check('Rotate mode: gizmo pivot at the object centre', await ev(`boardEngine.tc.object === boardEngine.proxy`) && near(await ev(`boardEngine.proxy.position.z`), 3, 0.01));
  await press('.cad-inspector [data-q="rx"]'); await idle();
  check('↻X keeps the centre in place', JSON.stringify(await ctr()) === JSON.stringify(c0), JSON.stringify([c0, await ctr()]));
  await setField('rot.2', '30'); await idle();
  check('Rotation Z field keeps the centre in place', JSON.stringify(await ctr()) === JSON.stringify(c0), JSON.stringify([c0, await ctr()]));
  // cut by object on a resized object: hole is the cutter's true size
  await reset([{ type: 'box', name: 'P', size: { x: 20, y: 20, z: 5 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'T', size: { d: 6, z: 20 }, pos: [0, 0, -5] }]);
  await ev(`boardEngine._edit(boardEngine.data.items[0].id, (x) => { x.sxyz = [2, 1, 1]; x.cuts = [{ keep: 'outside', m: [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,0,0,1], shape: { type: 'box', size: { x: 1, y: 1, z: 1 } } }]; })`); await idle();
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await sleep(150);
  await press('.cad-actbar [data-ab="cutobj"]'); await idle(); await sleep(300); await idle();
  check('cut on a resized (×2 X) object → true-size Ø6 hole', near(await vol(), 40 * 20 * 5 - Math.PI * 9 * 5, 1), await vol());

  // combined objects: faces of the merged solid push / pull as one face, the result stays in the combined object
  await reset([{ type: 'box', name: 'L', size: { x: 20, y: 20, z: 10 }, pos: [-10, 0, 0] }, { type: 'box', name: 'Rt', size: { x: 20, y: 20, z: 10 }, pos: [10, 0, 0] }]);
  await ev(`boardEngine._setSel(boardEngine.data.items.map((x) => x.id))`); await sleep(100);
  await press('[data-combine]'); await idle(); await sleep(200);
  await ev(`boardEngine._select(null)`); await ev(`boardEngine._view('iso')`); await sleep(200);
  await key('e', 'KeyE', 69); await click(await scr(5, 0, 10)); await sleep(200);
  check('merged top face = one 40 × 20 face', await ev(`!!boardEngine.face && Math.abs(boardEngine.face.size[0] * boardEngine.face.size[1] - 800) < 0.5`), await ev(`boardEngine.face && JSON.stringify(boardEngine.face.size)`));
  check('…not treated as one member\'s side', await ev(`!boardEngine._faceOwn`));
  await ev(`(() => { const i = document.querySelector('[data-fdist]'); i.value = '5'; i.dispatchEvent(new Event('change')); })()`); await idle();
  { const its = await items(); const pull = its.find((x) => /^Pull/.test(x.name));
    check('Pull +5 → a 40×20×5 slab on the whole merged face', near(await vol(), 8000 + 4000, 2), await vol());
    check('…members unchanged, the pull joined the combined object', its.find((x) => x.name === 'L').size.z === 10 && its.find((x) => x.name === 'Rt').size.z === 10 && pull && pull.group && pull.group === its[0].group, JSON.stringify(its.map((x) => [x.name, x.group]))); }
  await ev(`(() => { const i = document.querySelector('[data-fdist]'); i.value = '-2'; i.dispatchEvent(new Event('change')); })()`); await idle();
  check('Push −2 → 2 mm pocket across the merged face', near(await vol(), 8000 - 1600, 2), await vol());
  // drag the Distance label to −4: a live preview, no rebuild until release
  { const lab = await ev(`(() => { const r = document.querySelector('[data-fscrub]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const builds0 = await ev(`boardEngine.buildSeq`);
    await mouse('mousePressed', lab[0], lab[1], { button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', lab[0] - i * 4, lab[1], { button: 'left', buttons: 1 }); await sleep(30); }
    check('dragging −: red preview shown, no rebuild while dragging', await ev(`!!boardEngine._fPrev && boardEngine._faceDist < -2`) && (await ev(`boardEngine.buildSeq`)) === builds0, await ev(`boardEngine._faceDist`));
    await mouse('mouseReleased', lab[0] - 32, lab[1], { button: 'left', clickCount: 1 }); await idle();
    const dd = await ev(`boardEngine._faceDist`);
    check('release → preview gone, pocket built at that depth', !(await ev(`!!boardEngine._fPrev`)) && near(await vol(), 8000 + 800 * dd, 2), dd + ' ' + (await vol())); }
  const vB = await vol();
  await key('Escape', 'Escape', 27); await idle(); await sleep(200); await idle();
  { const its = await items(); const dd2 = await ev(`0`);
    check('leaving face mode → the push stays its own quiet cut shape; the parts are not changed', its.some((x) => /^Push/.test(x.name) && x.role === 'hole' && x.feature) && !its.some((x) => (x.cuts || []).length), JSON.stringify(its.map((x) => [x.name, x.role, !!x.feature, (x.cuts || []).length])));
    check('…no red outline drawn for it', await ev(`(() => { const E = boardEngine; const p = E.data.items.find((x) => /^Push/.test(x.name)); const o = E.objs[p.id]; return !o.edges.material.visible && o.mesh.material.opacity === 0; })()`), await ev(`(() => { const E = boardEngine; const p = E.data.items.find((x) => /^Push/.test(x.name)); const o = E.objs[p.id]; return JSON.stringify({ sel: E.sel, multi: E.multi.length, pid: p.id, hov: E.hov, ev: o.edges.visible, op: o.mesh.material.opacity, err: E.errors[p.id] || '' }); })()`));
    check('…same volume', near(await vol(), vB, 2), (await vol()) + ' vs ' + vB); void dd2; }
  await press('[data-undo]'); await idle(); await sleep(200);
  check('one undo → back to the −2 pocket (before that drag)', near(await vol(), 8000 - 1600, 2), await vol());
  await key('Escape', 'Escape', 27);

  // a face whose triangles repeat their corners (unwelded mesh) is still the whole face
  { const res = await ev(`(() => { const E = boardEngine; const keep = E.result;
      const C = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
      const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
      const vs = [], ts = []; F.forEach((f) => { f.forEach((k) => { ts.push(vs.length / 3); vs.push(...C[k]); }); });
      E.result = { vertices: new Float32Array(vs), triangles: new Uint32Array(ts) }; E._faceAdj = null;
      const r = E._faceRegion(2); E.result = keep; E._faceAdj = null;
      return r ? JSON.stringify({ size: r.size, tris: r.tris.size, outer: r.outer.length }) : 'null'; })()`);
    check('unwelded mesh: tapping one triangle picks the whole 10×10 square (not a triangle)', /"size":\[10,10\],"tris":2,"outer":4/.test(res), res); }

  // FrameTap STL + a box on its front, combined: push / pull the box's outer face
  if (HAVE_FT) {
    await reset([{ type: 'model', name: 'FrameTap', role: 'solid', file: { path: 'models/frametap.stl', ext: 'stl', key: 'models/frametap.stl#t' }, pos: [0, 0, 0] }]);
    await idle(); await sleep(500); await idle();
    const fb = await ev(`(() => { const b = boardEngine._boundsOf([boardEngine.data.items[0].id]); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]; })()`);
    console.log('DBGC ft bounds', JSON.stringify(fb));
    // a 20×10×6 block sitting on the FrameTap's top, overlapping 1 mm
    await ev("boardEngine._add('box', { name: 'Blk', size: { x: 20, y: 10, z: 6 }, pos: [0, " + ((fb[1] + fb[4]) / 2) + ", " + (fb[5] - 1) + "] })"); await idle();
    await ev(`boardEngine._setSel(boardEngine.data.items.map((x) => x.id))`); await sleep(100);
    await press('[data-combine]'); await idle(); await sleep(300);
    const v0 = await vol();
    await ev(`boardEngine._select(null)`); await ev(`boardEngine._view('iso')`); await sleep(200);
    await key('e', 'KeyE', 69); await click(await scr(0, (fb[1] + fb[4]) / 2, fb[5] + 5)); await sleep(300);
    console.log('DBGC face', await ev(`boardEngine.face ? JSON.stringify({ size: boardEngine.face.size, curved: boardEngine.face.curved, own: !!boardEngine._faceOwn }) : 'none'`));
    await ev(`(() => { const i = document.querySelector('[data-fdist]'); if (i) { i.value = '4'; i.dispatchEvent(new Event('change')); } })()`); await idle(); await sleep(300); await idle();
    console.log('DBGC after +4', v0, await vol(), JSON.stringify((await items()).map((x) => [x.name, x.role, x.group, x.height])), JSON.stringify(await ev(`boardEngine.errors`)));
    await key('Escape', 'Escape', 27); await idle(); await sleep(300); await idle();
    console.log('DBGC after esc', await vol(), JSON.stringify((await items()).map((x) => [x.name, x.role, x.group])));
  }

  // Fix body: split pieces + a push pocket → one clean solid (same volume), one undo
  await reset([{ type: 'box', name: 'Body', size: { x: 40, y: 20, z: 10 }, pos: [0, 0, 0] }, { type: 'box', name: 'Pocket', role: 'hole', feature: true, size: { x: 10, y: 10, z: 6 }, pos: [-10, 0, 5] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(100);
  await ev(`(() => { const E = boardEngine; E.cutMode = null; })()`);
  // split Body by a plane at X = 5 into two pieces
  await ev(`(() => { const E = boardEngine; const it = E.data.items[0]; E._snapshot(); const cp = JSON.parse(JSON.stringify(it)); cp.id = 'i_cp'; cp.name = 'Body piece'; cp.clip = [E._cutLocal(it, 0, 5, -1)]; it.clip = [E._cutLocal(it, 0, 5, 1)]; E.data.items.push(cp); E._commit(); E._refreshItems(); E._requestBuild(); })()`); await idle();
  const vSplit = await vol();
  check('setup: 2 body pieces + pocket = 8000 − 500', near(vSplit, 8000 - 500, 1), vSplit);
  await ev(`boardEngine._setSel(boardEngine.data.items.filter((x) => x.role === 'solid').map((x) => x.id))`); await sleep(200);
  check('Fix body on the floating bar', await ev(`!!document.querySelector('.cad-actbar [data-ab="fix"]')`));
  await press('.cad-actbar [data-ab="fix"]'); await sleep(1500);
  check('summary popup: 2 objects → 1 solid, cut shape baked in', /2 objects → 1 solid/.test(await popupText()) && /1 cut shape baked in/.test(await popupText()), await popupText());
  await popup('Fix body'); await sleep(500); await idle(); await sleep(500); await idle();
  { const its = await items();
    check('→ one model object "(fixed)" saved as STL next to the design, pocket shape gone', its.length === 1 && its[0].type === 'model' && /\(fixed\)/.test(its[0].name) && /-fixed-.*\.stl$/.test(its[0].file.path), JSON.stringify(its.map((x) => [x.name, x.type, x.file && x.file.path])));
    check('…same volume, same place', near(await vol(), vSplit, 1) && near((await ev(`(() => { const b = boardEngine._boundsOf([boardEngine.data.items[0].id]); return b.min.x; })()`)), -20, 0.01), await vol()); }
  await press('[data-undo]'); await idle(); await sleep(300);
  check('one undo → the 2 pieces and the pocket are back', (await items()).length === 3 && near(await vol(), vSplit, 1));
  // Join all: one piece, every cut merged back (full 40×20×10 box)
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(200);
  await press('.cad-actbar [data-ab="joinall"]'); await sleep(1500);
  check('Join all popup: 2 objects → 1 solid, cuts merged back', /2 objects → 1 solid/.test(await popupText()) && /merged back/.test(await popupText()), await popupText());
  await popup('Cancel'); await idle(); await sleep(300);
  check('Cancel → exactly as before (2 pieces + pocket)', (await items()).length === 3 && near(await vol(), vSplit, 1), (await items()).length + ' ' + (await vol()));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await sleep(200);
  await press('.cad-actbar [data-ab="joinall"]'); await sleep(1500); await popup('Join all'); await sleep(500); await idle(); await sleep(500); await idle();
  check('Join all → one piece, the full 8000 mm³ (cuts merged back)', (await items()).length === 1 && near(await vol(), 8000, 1), (await items()).length + ' ' + (await vol()));
  await press('[data-undo]'); await idle(); await sleep(300);
  check('one undo → back to 2 pieces + pocket', (await items()).length === 3 && near(await vol(), vSplit, 1));

  // Fill: a 4 mm tunnel through a block — pick its floor, Fill → solid again
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 20 }, pos: [0, 0, 0] }, { type: 'box', name: 'Tunnel', role: 'hole', size: { x: 40, y: 10, z: 4 }, pos: [0, 0, 8] }]);
  await idle();
  const vT = await vol();
  check('setup: block with tunnel = 12000 − 30·10·4', near(vT, 12000 - 1200, 1), vT);
  await key('e', 'KeyE', 69); await sleep(100);
  await ev(`(() => { const E = boardEngine; const v = E.result.vertices, t = E.result.triangles; for (let i = 0; i < t.length / 3; i++) { const zs = [0, 1, 2].map((k) => v[t[i * 3 + k] * 3 + 2]); if (zs.every((z) => Math.abs(z - 8) < 1e-3)) { const f = E._faceRegion(i); if (f && f.n.z > 0.99) { E._faceSet(f); return; } } } })()`);
  check('tunnel floor picked (faces up, 30 × 10)', await ev(`!!boardEngine.face && boardEngine.face.n.z > 0.99 && Math.abs(boardEngine.face.size[0] * boardEngine.face.size[1] - 300) < 0.5`));
  await press('[data-ffill]'); await idle(); await sleep(200); await idle();
  check('Fill → gap measured as 4 mm, block solid again', near(await vol(), 12000, 1) && near(await ev(`boardEngine._faceDist`), 4.01, 0.02), (await vol()) + ' ' + (await ev(`boardEngine._faceDist`)));
  await key('Escape', 'Escape', 27);
  await press('[data-undo]'); await idle(); await sleep(200);
  check('one undo → tunnel back', near(await vol(), vT, 1));
  // an outside face has nothing opposite → explains, no change
  await key('e', 'KeyE', 69); await sleep(100);
  await ev(`(() => { const E = boardEngine; const v = E.result.vertices, t = E.result.triangles; for (let i = 0; i < t.length / 3; i++) { const zs = [0, 1, 2].map((k) => v[t[i * 3 + k] * 3 + 2]); if (zs.every((z) => Math.abs(z - 20) < 1e-3)) { const f = E._faceRegion(i); if (f) { E._faceSet(f); return; } } } })()`);
  await press('[data-ffill]'); await sleep(200);
  check('top (outside) face → "Nothing faces this face", nothing changes', /Nothing faces this face/.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)) && near(await vol(), vT, 1));
  await key('Escape', 'Escape', 27);

  // combined objects scale as one by typing a size
  await reset([{ type: 'box', name: 'A', size: { x: 10, y: 10, z: 10 }, pos: [0, 0, 0] }, { type: 'box', name: 'B', size: { x: 10, y: 10, z: 10 }, pos: [10, 0, 0] }]);
  await ev(`boardEngine._setSel(boardEngine.data.items.map((x) => x.id))`); await sleep(100);
  await press('[data-combine]'); await idle(); await sleep(300);
  check('combined: X label editable', !(await ev(`document.querySelector('.cad-dimlabel').classList.contains('ro')`)));
  await ev(`boardEngine._dimSet(0, 40)`); await idle(); await sleep(300);
  const cA = await it('A'), cB = await it('B');
  check('X 20 → 40: both parts doubled in X, still touching', cA.size.x === 20 && cB.size.x === 20 && near(cB.pos[0] - cA.pos[0], 20, 1e-3), JSON.stringify([cA.size, cA.pos, cB.size, cB.pos]));

  // ======================================================================
  section('Flip, Mirror (same on the other side) & patterns');
  const wverts = (name, mirrorAxis, about) => ev(`(() => { const E = boardEngine; const it = E.data.items.find((x) => x.name === ${JSON.stringify(name)}); const o = E.objs[it.id]; o.group.updateMatrixWorld(true); const p = o.mesh.geometry.attributes.position; const T = E.T; const out = []; for (let i = 0; i < p.count; i++) { const v = new T.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.mesh.matrixWorld); const a = [v.x, v.y, v.z]; ${mirrorAxis == null ? '' : 'a[' + mirrorAxis + '] = 2 * ' + about + ' - a[' + mirrorAxis + '];'} out.push(a.map((x) => Math.round(x * 100) / 100).join(',')); } return JSON.stringify([...new Set(out)].sort()); })()`);
  const mvol = () => ev(`(() => { const m = boardEngine.result; if (!m) return 0; const v = m.vertices, t = m.triangles; let s = 0; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  await reset([{ type: 'sketch', name: 'L', height: 3, profiles: [{ k: 'poly', pts: [[0, 0], [20, 0], [20, 5], [5, 5], [5, 15], [0, 15]] }], pos: [30, 10, 0], rot: [0, 0, 30] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  const cxL = await ev(`(() => { const b = boardEngine._boundsOf([boardEngine.sel]); return (b.min.x + b.max.x) / 2; })()`);
  const n0m = (await items()).length; const before0 = await wverts('L', null);
  check('Flip / Mirror buttons have icons', await ev(`!!document.querySelector('.cad-inspector [data-sym="0"] svg') && !!document.querySelector('.cad-inspector [data-mirror="0"] svg')`));
  await press('[data-mirror="0"]'); await idle();
  check('Flip X turns it over in place: same object, every vertex reflected', (await items()).length === n0m && (await it('L')).flip && (await it('L')).flip[0] === true && (await wverts('L', 0, cxL)) === before0);
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  // a hole on the left of a part → Mirror X puts the same hole on the right
  await reset([{ type: 'box', name: 'Part', size: { x: 40, y: 20, z: 10 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'Hole', role: 'hole', size: { d: 6, z: 20 }, pos: [-12, 0, -5] }]);
  const vOne = await mvol();
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await idle();
  await press('[data-sym="0"]'); await idle();
  const hs = (await items()).filter((x) => x.role === 'hole');
  check('Mirror X on a hole → the same hole on the other side of the part (X +12)', hs.length === 2 && hs.some((x) => x.pos[0] === 12), JSON.stringify(hs.map((x) => x.pos)));
  check('…and it really cuts (volume down by one more hole)', near(vOne - (await mvol()), Math.PI * 9 * 10, 2), vOne - (await mvol()));
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  // select the part itself → its hole is reflected; again → already symmetric
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await press('[data-sym="0"]'); await idle();
  check('Mirror X on the part → its hole is reflected too', (await items()).filter((x) => x.role === 'hole').some((x) => x.pos[0] === 12));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await press('[data-sym="0"]'); await idle();
  check('Mirror X again → "already symmetric", nothing added', (await items()).filter((x) => x.role === 'hole').length === 2 && /already symmetric/i.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)));
  // a part with a baked cut (after Split with a shape) → Mirror reflects the cut
  await reset([{ type: 'box', name: 'Bar', size: { x: 40, y: 20, z: 10 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'Cutter', size: { d: 6, z: 20 }, pos: [-12, 0, -5] }]);
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await idle(); await press('[data-splitwith]'); await idle(); await sleep(300); await idle();
  await ev(`(() => { const E = boardEngine; E._editMany(E.data.items.filter((x) => /piece/.test(x.name)).map((x) => x.id), (x) => { x.pos = [0, 60, 0]; }); })()`); await idle();
  const vBar1 = await ev(`(() => { const E = boardEngine; const x = E.data.items.find((i) => i.name === 'Bar'); const m = E.meshes[x.id]; let s = 0; const v = m.vertices, t = m.triangles; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  await ev(`boardEngine._select(boardEngine.data.items.find((x) => x.name === 'Bar').id)`); await idle();
  await press('[data-sym="0"]'); await idle();
  const bar = await it('Bar');
  const vBar2 = await ev(`(() => { const E = boardEngine; const x = E.data.items.find((i) => i.name === 'Bar'); const m = E.meshes[x.id]; let s = 0; const v = m.vertices, t = m.triangles; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  check('Mirror X on a part with a cut → the same cut on the other side (exact look either side)', bar.cuts.length === 2 && near(vBar1 - vBar2, Math.PI * 9 * 10, 2), JSON.stringify(bar.cuts.map((c) => c.m.slice(12, 15))) + ' ' + (vBar1 - vBar2));
  // a split that leaves separate chunks → each chunk its own object
  await reset([{ type: 'box', name: 'Rod', size: { x: 40, y: 10, z: 10 }, pos: [0, 0, 0] }, { type: 'box', name: 'Wall', size: { x: 4, y: 30, z: 30 }, pos: [0, 0, -10] }]);
  await ev(`boardEngine._select(boardEngine.data.items[1].id)`); await idle(); await press('[data-splitwith]'); await idle(); await sleep(400); await idle(); await sleep(300); await idle();
  const rods = (await items()).filter((x) => /Rod/.test(x.name));
  check('split a rod through its middle → left end, right end and the middle are 3 separate objects', rods.length === 3 && rods.filter((x) => x.piece).length === 2, JSON.stringify(rods.map((x) => [x.name, x.piece])));
  const ends = rods.filter((x) => x.piece);
  await ev(`boardEngine._select(${JSON.stringify(ends[0] ? ends[0].id : '')})`); await idle();
  await key('ArrowUp', 'ArrowUp', 38, MOD.shift); await idle();
  check('one end moves on its own (the other stays put)', (await items()).filter((x) => x.piece).map((x) => x.pos[1]).sort().join(',') === '0,10', JSON.stringify((await items()).map((x) => [x.name, x.pos])));
  check('the parts still add up (no material lost)', near(await mvol(), 40 * 10 * 10, 0.5), await mvol());
  await key('z', 'KeyZ', 90, MOD.meta); await idle(); await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('undo the move, then the split (one step, including the separating)', (await items()).length === 2 && (await items()).some((x) => x.name === 'Wall'), JSON.stringify((await items()).map((x) => x.name)));
  // linear pattern
  await reset([{ type: 'cylinder', name: 'Hole', role: 'hole', size: { d: 3, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await ev(`document.querySelector('.cad-pattern').open = true`); await sleep(100);
  await ev(`(() => { const set = (s, v) => { const i = document.querySelector(s); i.value = v; i.dispatchEvent(new Event('change')); }; set('[data-pn]', '4'); set('[data-pdx]', '12.5'); set('[data-pdy]', '0'); })()`);
  await press('[data-pmake]'); await idle();
  check('Row pattern: count 4, ΔX 12.5 → copies at 12.5, 25, 37.5', JSON.stringify((await items()).map((x) => x.pos[0])) === '[0,12.5,25,37.5]' && (await items()).every((x) => x.role === 'hole'), JSON.stringify((await items()).map((x) => x.pos)));
  // circular pattern
  await reset([{ type: 'box', name: 'Spoke', size: { x: 10, y: 2, z: 2 }, pos: [20, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await ev(`document.querySelector('.cad-pattern').open = true`); await press('[data-pkind="circular"]'); await sleep(100);
  await ev(`(() => { document.querySelector('.cad-pattern').open = true; const set = (s, v) => { const i = document.querySelector(s); i.value = v; i.dispatchEvent(new Event('change')); }; set('[data-pn]', '6'); set('[data-pangle]', '360'); set('[data-pcx]', '0'); set('[data-pcy]', '0'); })()`);
  await press('[data-pmake]'); await idle();
  const cp = await items();
  const okCirc = cp.length === 6 && cp.every((x, k) => near(x.pos[0], 20 * Math.cos(k * Math.PI / 3), 0.01) && near(x.pos[1], 20 * Math.sin(k * Math.PI / 3), 0.01) && near(((x.rot[2] - 60 * k) % 360 + 540) % 360 - 180, 0, 0.01));
  check('Circle pattern: 6 around the centre, each turned 60° more', okCirc, JSON.stringify(cp.map((x) => [x.pos, x.rot[2]])));
  // a flipped object can be rotated with others without losing its flip
  await reset([{ type: 'sketch', name: 'L', height: 3, profiles: [{ k: 'poly', pts: [[0, 0], [20, 0], [20, 5], [5, 5], [5, 15], [0, 15]] }], pos: [0, 0, 0] }, { type: 'box', name: 'Other', size: { x: 5, y: 5, z: 5 }, pos: [40, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await press('[data-mirror="0"]'); await idle();
  await press('[data-selall]'); const beforeM = await wverts('L', null);
  await press('[data-g="rz"]'); await press('[data-g="rz"]'); await press('[data-g="rz"]'); await press('[data-g="rz"]'); await idle();
  check('flipped object survives group rotation (4×90° → back to the same shape, still flipped)', (await wverts('L', null)) === beforeM && (await it('L')).flip && (await it('L')).flip[0] === true);

  // ======================================================================
  section('Face tools: push / pull, sketch on face, lay flat');
  const fvol = () => ev(`(() => { const m = boardEngine.result; if (!m) return 0; const v = m.vertices, t = m.triangles; let s = 0; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  const fbounds = () => ev(`(() => { const v = boardEngine.result.vertices; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); } return [lo, hi]; })()`);
  const setDist = async (d) => { await ev(`(() => { const i = document.querySelector('.cad-inspector [data-fdist]'); i.value = '${d}'; i.dispatchEvent(new Event('change')); })()`); await idle(); };
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await sleep(300);
  await press('[data-face]'); check('Face mode on (button)', await ev(`boardEngine.faceOn === true`));
  await click(await scr(0, 0, 10));
  check('tap the top face → selected, panel shows 30 × 20', await ev(`!!boardEngine.face`) && /30 × 20/.test(await ev(`document.querySelector('.cad-inspector').innerText`)), await ev(`document.querySelector('.cad-inspector').innerText.slice(0, 120)`));
  check('top face normal is +Z', await ev(`(() => { const n = boardEngine.face.n; return Math.abs(n.z - 1) < 1e-6; })()`));
  await setDist(5);
  check('Pull 5 → +3000 mm³, top now at Z 15', near(await fvol(), 9000, 2) && near((await fbounds())[1][2], 15, 0.01), (await fvol()) + ' ' + JSON.stringify(await fbounds()));
  check('pulling a box\'s own face resizes the box (H 10 → 15), no extra shape', (await items()).length === 1 && (await it('Blk')).size.z === 15 && /Resizes/.test(await ev(`document.querySelector('.cad-inspector').innerText`)), JSON.stringify(await items()));
  await setDist(-3);
  check('Push −3 → pocket: 6000 − 30·20·3 = 4200', near(await fvol(), 4200, 2), await fvol());
  check('push −3 → the box is 7 high', (await it('Blk')).size.z === 7);
  await press('[data-fstep="-1"]'); await idle(); check('−1 step → push 4', near(await fvol(), 6000 - 2400, 2), await fvol());
  await setDist(0); check('distance 0 → back to the original size', (await it('Blk')).size.z === 10 && (await items()).length === 1);
  await press('[data-fclose]'); check('✕ leaves face mode', await ev(`!boardEngine.faceOn`));
  // face with a hole in it
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }, { type: 'cylinder', name: 'Bore', role: 'hole', size: { d: 6, z: 20 }, pos: [5, 0, -5] }]);
  await key('e', 'KeyE', 69); check('E → face mode', await ev(`boardEngine.faceOn === true`));
  await click(await scr(-8, 5, 10));
  check('top face with a hole → 1 hole found', await ev(`boardEngine.face && boardEngine.face.holes.length === 1`));
  const v0 = await fvol(); await setDist(5);
  check('pull keeps the hole open: +5·(600 − π·9)', near((await fvol()) - v0, 5 * (600 - Math.PI * 9), 6), ((await fvol()) - v0) + ' vs ' + 5 * (600 - Math.PI * 9));
  await press('[data-fdone]'); check('Done keeps it and selects the resized box', await ev(`!boardEngine.faceOn`) && (await selNames()) === 'Blk' && (await it('Blk')).size.z === 15);
  // side face
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69);
  await click(await scr(0, -10, 5));
  check('front face → normal −Y', await ev(`boardEngine.face && Math.abs(boardEngine.face.n.y + 1) < 1e-6`));
  await setDist(-2); check('push the front face 2 → 6000 − 30·10·2', near(await fvol(), 5400, 2), await fvol());
  await setDist(4); check('pull the front face 4 → part grows to Y −14', near((await fbounds())[0][1], -14, 0.02), JSON.stringify(await fbounds()));
  // arrow drag
  await setDist(0);
  await ev(`boardEngine._view('iso')`); await key('Escape', 'Escape', 27); await key('e', 'KeyE', 69);
  await click(await scr(0, 0, 10));
  const a0 = await scr(0, 0, 12), a1 = await scr(0, 0, 30);
  await mouse('mouseMoved', a0[0], a0[1]); await mouse('mousePressed', a0[0], a0[1], { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', a0[0] + (a1[0] - a0[0]) * i / 8, a0[1] + (a1[1] - a0[1]) * i / 8, { buttons: 1 });
  await mouse('mouseReleased', a1[0], a1[1], { button: 'left', clickCount: 1 }); await idle();
  const dd = await ev(`boardEngine._faceDist`);
  check('drag the arrow up → pulls out (snapped to whole mm), box grows', dd > 5 && Number.isInteger(dd) && (await it('Blk')).size.z === 10 + dd, dd + ' ' + JSON.stringify((await it('Blk')).size));
  check('the camera did not orbit during the arrow drag', await ev(`boardEngine.controls.enabled === true`));
  // rounded box: the rounded edges move with the face
  await reset([{ type: 'box', name: 'Ref', size: { x: 30, y: 20, z: 15, corner: 3 }, round: 1, pos: [0, 0, 0] }]);
  const vR15 = await fvol();
  await reset([{ type: 'box', name: 'Rnd', size: { x: 30, y: 20, z: 10, corner: 3 }, round: 1, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69); await click(await scr(0, 0, 10));
  check('rounded box: E + tap the flat top (it blends into rounded edges) → picked as a flat face', await ev(`!!boardEngine.face && !boardEngine.face.curved`), await ev(`document.querySelector('.cad-root .cad-toast').textContent`));
  await setDist(5);
  check('rounded box: pull the top 5 → identical to a 15-high rounded box (rounded edges moved up)', near(await fvol(), vR15, 0.5) && (await it('Rnd')).size.z === 15 && (await it('Rnd')).round === 1, (await fvol()) + ' vs ' + vR15);
  await key('Escape', 'Escape', 27);
  await reset([{ type: 'box', name: 'Side', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69); await click(await scr(15, 0, 5)); await setDist(10);
  const sb = await fbounds();
  check('pull the right side +10 → grows to the right only (X −15 … 25)', near(sb[0][0], -15, 0.01) && near(sb[1][0], 25, 0.01), JSON.stringify(sb));
  // curved surface
  await reset([{ type: 'cylinder', name: 'Cyl', size: { d: 20, z: 20 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('front')`); await key('e', 'KeyE', 69);
  await click(await scr(0, -10, 10));
  { const cface = await ev(`!!boardEngine.face`), ctoast = await ev(`document.querySelector('.cad-root .cad-toast').textContent`), cmode = await ev(`boardEngine.faceOn`); check('curved side of a cylinder → refused with a message', !cface && /curved/.test(ctoast), JSON.stringify({ cface, ctoast, cmode })); }
  await ev(`boardEngine._view('iso')`); await click(await scr(0, 0, 20));
  check('flat top of a cylinder works (round outline)', await ev(`boardEngine.face && boardEngine.face.outer.length > 20`));
  await key('Escape', 'Escape', 27); check('Esc leaves face mode', await ev(`!boardEngine.faceOn`));
  // sketch on face
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69); await click(await scr(0, 0, 10));
  await press('[data-fsketch]'); await sleep(300);
  check('Sketch on face → sketching on the top face (Z 10)', await ev(`!!boardEngine.sk`) && near(await ev(`boardEngine.sk.frame.position.z`), 10, 0.01));
  await press('[data-sktool="circle"]'); await click(await sp(0, 0)); await click(await sp(4, 0));
  await press('[data-skdone]'); await idle(); await extrude('0.05');
  check('a Ø8 boss on top: +π·16·0.05, top at Z 10.05', near(await fvol(), 6000 + Math.PI * 16 * 0.05, 0.3) && near((await fbounds())[1][2], 10.05, 0.005), (await fvol()) + ' ' + JSON.stringify(await fbounds()));
  // lay flat
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 20], rot: [30, 0, 15] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69);
  const fc = await ev(`(() => { const T = boardEngine.T; const it = boardEngine.data.items[0]; const o = new T.Object3D(); o.rotation.order = 'ZYX'; boardEngine._placeObj(o, it); o.updateMatrixWorld(true); const p = new T.Vector3(0, 0, 10).applyMatrix4(o.matrixWorld); return [p.x, p.y, p.z]; })()`);
  await click(await scr(...fc));
  check('tilted top face picked', await ev(`!!boardEngine.face`));
  await press('[data-fflat]'); await idle();
  const bottom = await ev(`(() => { const m = boardEngine.result, v = m.vertices, t = m.triangles; let a = 0; for (let i = 0; i < t.length; i += 3) { const p = [0, 1, 2].map((k) => [v[t[i + k] * 3], v[t[i + k] * 3 + 1], v[t[i + k] * 3 + 2]]); if (p.every((q) => Math.abs(q[2]) < 1e-3)) { const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1]; a += Math.abs(ux * wy - uy * wx) / 2; } } return a; })()`);
  check('Lay flat → that 30 × 20 face lies on the plate (600 mm² at Z 0)', near(bottom, 600, 0.5), bottom);

  // ======================================================================
  section('Round / chamfer single edges');
  await reset([{ type: 'box', name: 'Cube', size: { x: 20, y: 20, z: 20 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id); boardEngine._view('iso')`); await idle();
  await press('[data-edgemode]'); await sleep(200);
  check('edge mode shows the 12 edges and hides the gizmo', await ev(`boardEngine.edgeMode && boardEngine._edgeObj && boardEngine._edgeObj.children.filter((c) => c.isLineSegments).length === 12 && !boardEngine.tc.object`));
  await click(await scr(10, -10, 10));                              // the vertical edge at the front-right corner
  check('tap an edge → 1 picked', await ev(`boardEngine.edgeMode.sel.size === 1`));
  await click(await scr(10, -10, 10)); check('tap it again → unpicked', await ev(`boardEngine.edgeMode.sel.size === 0`));
  await click(await scr(10, -10, 10));
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-er]'); i.value = '3'; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-eapply="round"]'); await idle();
  check('Round r3 → 8000 − 9·(1 − π/4)·20', near(await fvol(), 8000 - 9 * (1 - Math.PI / 4) * 20, 0.6), await fvol());
  check('saved on the shape, edge marked', (await it('Cube')).edges.length === 1 && (await it('Cube')).edges[0].kind === 'round');
  await click(await scr(-10, 0, 20));                               // top edge on the far side
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-er]'); i.value = '2'; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-eapply="chamfer"]'); await idle();
  check('Chamfer 2 on another edge → −40 more', near(await fvol(), 8000 - 9 * (1 - Math.PI / 4) * 20 - 40, 0.6), await fvol());
  await click(await scr(-10, 0, 20)); await press('[data-eapply="remove"]'); await idle();
  check('Sharp → that edge back to sharp', (await it('Cube')).edges.length === 1 && near(await fvol(), 8000 - 9 * (1 - Math.PI / 4) * 20, 0.6));
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('⌘Z restores the chamfer', (await it('Cube')).edges.length === 2);
  await press('[data-edone]'); check('Done → back to the shape panel, gizmo back', !(await ev(`!!boardEngine.edgeMode`)) && await ev(`!!boardEngine.tc.object`));
  check('panel button shows the count (2)', /\(2\)/.test(await ev(`document.querySelector('[data-edgemode]').textContent`)));
  await press('[data-edgemode]'); await press('[data-eclear]'); await idle();
  check('Make all edges sharp', !((await it('Cube')).edges || []).length && near(await fvol(), 8000, 0.01), JSON.stringify((await it('Cube')).edges) + ' ' + (await fvol()));
  await key('Escape', 'Escape', 27); check('Esc leaves edge mode', !(await ev(`!!boardEngine.edgeMode`)));
  await reset([{ type: 'box', name: 'Cube', size: { x: 20, y: 20, z: 20 }, round: 1, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await press('[data-edgemode]');
  check('warns when "round all edges" is already set', /set it to 0/.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)));
  await key('Escape', 'Escape', 27);

  // ======================================================================
  section('Undo / redo: every step comes back exactly');
  await reset([{ type: 'box', name: 'Body', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  const state = () => ev(`JSON.stringify({ items: boardEngine.data.items, groups: boardEngine.data.groups })`);
  const states = [await state()]; const ops = [];
  const step = async (name, js) => { await ev(js); await idle(); ops.push(name); states.push(await state()); };
  const B = `boardEngine.data.items.find((x) => x.name === 'Body').id`;
  await step('resize', `boardEngine._edit(${B}, (x) => { x.size = Object.assign({}, x.size, { x: 40 }); })`);
  await step('role → hole → solid', `boardEngine._edit(${B}, (x) => { x.role = 'hole'; })`);
  await step('role back to solid', `boardEngine._edit(${B}, (x) => { x.role = 'solid'; })`);
  await step('add a cylinder', `boardEngine._add('cylinder', { name: 'Peg', size: { d: 8, z: 12 }, pos: [30, 0, 0] })`);
  await step('make it a hole', `boardEngine._edit(boardEngine.data.items[1].id, (x) => { x.role = 'hole'; x.pos = [5, 0, -1]; })`);
  await step('round all edges', `boardEngine._edit(${B}, (x) => { x.round = 1; })`);
  await step('gizmo move', `(() => { const E = boardEngine; E._select(${B}); const g = E.objs[E.sel].group; E.tc.dispatchEvent({ type: 'dragging-changed', value: true }); g.position.x = 12; E.tc.dispatchEvent({ type: 'objectChange' }); E.tc.dispatchEvent({ type: 'dragging-changed', value: false }); })()`);
  await step('multi center', `(() => { const E = boardEngine; E._setSel(E.data.items.map((x) => x.id)); E._groupAction('center'); })()`);
  await step('multi rotate', `boardEngine._groupAction('rz')`);
  await step('combine', `boardEngine._combine()`);
  await step('mirror', `boardEngine._mirror(0)`);
  await step('uncombine', `boardEngine._uncombine(boardEngine._gid(boardEngine.data.items[0].id))`);
  await step('pattern', `(() => { const E = boardEngine; E._select(E.data.items[0].id, true); E._pattern({ kind: 'linear', n: 3, dx: 50, dy: 0, dz: 0 }); })()`);
  await step('duplicate', `boardEngine._duplicateMany(boardEngine._selIds())`);
  await step('delete', `boardEngine._deleteMany(boardEngine._selIds())`);
  await ev(`(() => { const E = boardEngine; E._select(null); E._view('iso'); })()`); // view only: not an undo step
  await step('sketch', `(() => { const E = boardEngine; E._sketchStart(null); E._sketchItem().profiles.push(CadCore.normalizeProfile({ k: 'rect', x: 0, y: 0, w: 10, h: 10 })); E._sketchEnd(true); })()`);
  await step('sketch height', `boardEngine._edit(boardEngine.sel, (x) => { x.height = 4; })`);
  await step('edge round', `(() => { const E = boardEngine; const id = E.sel; const e = E.edges[id] && E.edges[id][0]; E._edit(id, (x) => { x.edges = e ? [{ p: e.p, r: 0.5, kind: 'round' }] : []; }); })()`);
  await step('hide', `boardEngine._editMany([boardEngine.data.items[0].id], (x) => { x.hidden = true; })`);
  let undoOk = true, bad1 = '';
  for (let i = states.length - 1; i > 0; i--) {
    await key('z', 'KeyZ', 90, MOD.meta); await idle();
    if ((await state()) !== states[i - 1]) { undoOk = false; bad1 = 'undo of "' + ops[i - 1] + '"'; break; }
  }
  check('undo walks back through ' + ops.length + ' steps, each exactly as it was', undoOk, bad1);
  let redoOk = true, bad2 = '';
  for (let i = 1; i < states.length && undoOk; i++) {
    await key('z', 'KeyZ', 90, MOD.meta | MOD.shift); await idle();
    if ((await state()) !== states[i]) { redoOk = false; bad2 = 'redo of "' + ops[i - 1] + '"'; break; }
  }
  check('redo walks forward through every step exactly', redoOk, bad2);
  check('no shape changed role by itself during undo / redo', (await items()).filter((x) => x.role === 'hole').length === JSON.parse(states[states.length - 1]).items.filter((x) => x.role === 'hole').length);

  // ======================================================================
  section('Cut with a plane');
  await reset([{ type: 'box', name: 'Blk', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await press('[data-cutstart]'); await sleep(200);
  check('Cut panel opens with Z at the middle (5) and a preview plane', await ev(`!!boardEngine.cutMode && boardEngine.cutMode.at === 5 && !!boardEngine._cutPlane`));
  await press('[data-cutdo="split"]'); await idle();
  const halves = await items();
  check('Split → 2 objects', halves.length === 2 && halves.every((x) => x.clip && x.clip.length === 1), JSON.stringify(halves.map((x) => x.clip)));
  check('the two halves add up to the whole (6000) and touch at Z 5', near(await fvol(), 6000, 0.05));
  const hv = await ev(`boardEngine.data.items.map((x) => { const b = boardEngine._boundsOf([x.id]); return [+b.min.z.toFixed(3), +b.max.z.toFixed(3)]; })`);
  check('one half is Z 5–10, the other Z 0–5', JSON.stringify(hv.slice().sort()) === JSON.stringify([[0, 5], [5, 10]]), JSON.stringify(hv));
  check('the new half is selected', (await selNames()) !== '' && (await ev(`boardEngine._selIds().length`)) === 1);
  await press('[data-export]'); await press('[data-ex="3mf"]'); await sleep(1500);
  const z3 = dataFile('test.3mf'); const n3 = z3 ? (new TextDecoder().decode(unzipSync(new Uint8Array(z3))['3D/3dmodel.model']).match(/<object /g) || []).length : 0;
  check('3MF has 2 separate objects', n3 === 2, n3);
  await ev(`(() => { const E = boardEngine; E._editMany([E._selIds()[0]], (x) => { x.pos[0] += 40; }); })()`); await idle();
  check('move one half away → still 3000 each', near(await fvol(), 6000, 0.05));
  await key('z', 'KeyZ', 90, MOD.meta); await idle(); await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('undo removes the split in one step (back to 1 uncut object)', (await items()).length === 1 && !(await items())[0].clip, JSON.stringify(await items()));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await press('[data-cutstart]'); await press('[data-cutaxis="0"]');
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-cutat]'); i.value = '5'; i.dispatchEvent(new Event('change')); })()`);
  await press('[data-cutdo="keep-"]'); await idle();
  check('X at 5, keep left → 20 × 20 × 10 = 4000', near(await fvol(), 4000, 0.05), await fvol());
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  check('panel shows "Cut 1 time"', /Cut 1 time/.test(await ev(`document.querySelector('.cad-inspector').innerText`)));
  await press('[data-uncut]'); await idle(); check('remove cuts → whole again', near(await fvol(), 6000, 0.05));
  await reset([{ type: 'box', name: 'Tilt', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 20], rot: [0, 0, 45] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await press('[data-cutstart]'); await press('[data-cutaxis="0"]'); await press('[data-cutmid]');
  await press('[data-cutdo="split"]'); await idle();
  check('rotated object split down the middle → two equal halves', near(await fvol(), 6000, 0.05) && (await ev(`boardEngine.data.items.map((x) => { const b = boardEngine._boundsOf([x.id]); return (b.max.x - b.min.x).toFixed(2); }).join(',')`)).split(',').every((w, _, a2) => w === a2[0]));
  // choose which objects are cut
  await reset([{ type: 'box', name: 'Keep', size: { x: 20, y: 20, z: 10 }, pos: [-30, 0, 0] }, { type: 'box', name: 'Cut me', size: { x: 20, y: 20, z: 10 }, pos: [30, 0, 0] }, { type: 'cylinder', name: 'Bore', role: 'hole', size: { d: 4, z: 20 }, pos: [30, 0, -5] }]);
  await press('[data-selall]'); await press('[data-cutstart]'); await sleep(200);
  check('Cut panel lists the objects; solids chosen, the hole cannot be', (await ev(`document.querySelectorAll('[data-cuton]').length`)) === 3 && (await ev(`document.querySelectorAll('[data-cuton].on').length`)) === 2 && await ev(`[...document.querySelectorAll('[data-cuton]')].find((b) => /Bore/.test(b.textContent)).disabled`));
  const keepChip = await ev(`(() => { const b = [...document.querySelectorAll('[data-cuton]')].find((x) => /Keep/.test(x.textContent)); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await click(keepChip);
  check('tap a chip → left out of the cut', (await ev(`boardEngine.cutMode.on.size`)) === 1);
  await ev(`boardEngine._view('top')`); await sleep(200);
  await click(await scr(-30, 0, 10)); check('tap the object in the view → chosen again', (await ev(`boardEngine.cutMode.on.size`)) === 2);
  await click(await scr(-30, 0, 10)); check('tap again → left out again', (await ev(`boardEngine.cutMode.on.size`)) === 1);
  await press('[data-cutdo="split"]'); await idle();
  const after = await items();
  check('only "Cut me" was split; "Keep" untouched', after.filter((x) => /Cut me/.test(x.name)).length === 2 && !after.find((x) => x.name === 'Keep').clip, JSON.stringify(after.map((x) => [x.name, !!x.clip])));
  check('the hole through "Cut me" is baked into both pieces (so it moves with them)', after.filter((x) => /Cut me/.test(x.name)).every((x) => x.cuts && x.cuts.some((c) => c.shape.role === 'hole')) && !after.some((x) => x.role === 'hole'), JSON.stringify(after.map((x) => [x.name, x.role, (x.cuts || []).length])));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await press('[data-cutstart]'); await key('Escape', 'Escape', 27);
  check('Esc cancels the cut panel, nothing changed', !(await ev(`!!boardEngine.cutMode`)) && (await items()).length === 3 && !(await has('.cad-inspector [data-cutdo]')));

  // ======================================================================
  section('Dimensions on the selected object & Scale');
  const dimText = () => ev(`[...document.querySelectorAll('.cad-dimlabel')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')`);
  const dimEdit = async (i, v) => { const p2 = await ev(`(() => { const r = document.querySelector('.cad-dimlabel.ax${i}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`); await mouse('mouseMoved', p2[0], p2[1]); await mouse('mousePressed', p2[0], p2[1], { button: 'left', clickCount: 1 }); await mouse('mouseReleased', p2[0], p2[1], { button: 'left', clickCount: 1 }); await mouse('mousePressed', p2[0], p2[1], { button: 'left', clickCount: 2 }); await mouse('mouseReleased', p2[0], p2[1], { button: 'left', clickCount: 2 }); await sleep(200); const ok = await ev(`!!document.querySelector('.cad-dim-in')`); if (ok) { await ev(`document.querySelector('.cad-dim-in').value = ${JSON.stringify(String(v))}`); await key('Enter', 'Enter', 13); await idle(); } return ok; };
  await reset([{ type: 'box', name: 'Bx', size: { x: 30, y: 20, z: 15 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id); boardEngine._view('iso')`); await idle(); await sleep(200);
  check('selected object shows X 30, Y 20, Z 15 on its dimension lines', (await dimText()) === 'X 30 mm | Y 20 mm | Z 15 mm', await dimText());
  check('midpoint dots and a centre dot are drawn', await ev(`boardEngine._dimObj && boardEngine._dimObj.children.filter((c) => c.isPoints).length === 4`));
  check('double-click X, type 42 → box W 42', (await dimEdit(0, '42')) && (await it('Bx')).size.x === 42 && /X 42 mm/.test(await dimText()), JSON.stringify((await it('Bx')).size));
  await dimEdit(2, '10+5'); check('Z accepts maths (10+5 → 15 is unchanged)', (await it('Bx')).size.z === 15);
  const under = await ev(`(() => { const r = document.querySelector('.cad-dimlabel.ax2').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return (e ? (e.className || e.tagName) : 'none') + ' @' + [r.x, r.y, r.width].map(Math.round) + ' editing:' + JSON.stringify(boardEngine._dimLabels.map((l) => !!l.editing)) + ' html:' + document.querySelector('.cad-dimlabel.ax2').innerHTML; })()`);
  check('every dimension label is clickable (not hidden under a panel)', await ev(`[...document.querySelectorAll('.cad-dimlabel')].every((l) => { const r = l.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e && e.closest('.cad-dimlabel') === l; })`), under);
  const zok = await dimEdit(2, '25'); check('Z 25 → H 25', (await it('Bx')).size.z === 25, 'opened:' + zok + ' under:' + under + ' size:' + JSON.stringify((await it('Bx')).size));
  await ev(`boardEngine._edit(boardEngine.sel, (x) => { x.rot = [0, 0, 90]; })`); await idle();
  await dimEdit(0, '12'); check('rotated 90°: world X edits its D (local Y)', (await it('Bx')).size.y === 12 && (await it('Bx')).size.x === 42, JSON.stringify((await it('Bx')).size));
  await ev(`boardEngine._edit(boardEngine.sel, (x) => { x.rot = [0, 0, 30]; })`); await idle();
  check('rotated 30°: labels are read-only and say why', !(await dimEdit(0, '5')) && /Rotated at an angle/.test(await ev(`document.querySelector('.cad-dimlabel.ax0').title`)));
  await reset([{ type: 'sketch', name: 'Sk', height: 2, profiles: [{ k: 'rect', x: 0, y: 0, w: 20, h: 10 }] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await sleep(150);
  check('sketch: X edits the outline (20 → 30), Z sets its height', (await dimEdit(0, '30')) && (await it('Sk')).profiles[0].w === 30 && (await it('Sk')).profiles[0].h === 10 && (await dimEdit(2, '6')) && (await it('Sk')).height === 6, JSON.stringify(await it('Sk')));
  await reset([{ type: 'sketch', name: 'Disc', height: 2, profiles: [{ k: 'circle', x: 0, y: 0, r: 10 }] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await sleep(150);
  check('circle sketch: X 30 → stays round, Ø30 (X 30, Y 30)', (await dimEdit(0, '30')) && (await it('Disc')).profiles[0].r === 15 && /X 30 mm.*Y 30 mm/.test(await dimText()), JSON.stringify((await it('Disc')).profiles) + ' ' + (await dimText()));
  check('circle sketch: Y 12 → Ø12', (await dimEdit(1, '12')) && (await it('Disc')).profiles[0].r === 6, JSON.stringify((await it('Disc')).profiles));
  // Scale mode
  await reset([{ type: 'box', name: 'Sc', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  await press('[data-mode="scale"]'); check('Scale mode in the bottom bar', (await ev(`boardEngine.tc.mode`)) === 'scale' && await ev(`document.querySelector('[data-mode="scale"]').classList.contains('on')`));
  await ev(`(() => { const E = boardEngine; E.tc.dispatchEvent({ type: 'dragging-changed', value: true }); E.objs[E.sel].group.scale.set(2, 1, 1.5); E.tc.dispatchEvent({ type: 'objectChange' }); })()`); await sleep(100);
  check('while scaling, dimensions update live (X 60, Z 15)', /X 60 mm/.test(await dimText()) && /Z 15 mm/.test(await dimText()), await dimText());
  await ev(`boardEngine.tc.dispatchEvent({ type: 'dragging-changed', value: false })`); await idle();
  check('release → real size W 60, H 15 (not a stretched mesh)', JSON.stringify([(await it('Sc')).size.x, (await it('Sc')).size.y, (await it('Sc')).size.z]) === '[60,20,15]' && (await ev(`boardEngine.objs[boardEngine.sel].group.scale.toArray().join(',')`)) === '1,1,1');
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('one ⌘Z undoes the whole scale', (await it('Sc')).size.x === 30 && (await it('Sc')).size.z === 10);
  await key('t', 'KeyT', 84); check('T → scale mode', (await ev(`boardEngine.tc.mode`)) === 'scale');
  // drag the green Y scale handle for real
  await reset([{ type: 'box', name: 'Ys', size: { x: 30, y: 20, z: 10 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id); boardEngine._view('top')`); await idle(); await key('t', 'KeyT', 84); await sleep(300);
  const hy = await ev(`(() => { const E = boardEngine; const T = E.T; const g = E.tc.getHelper(); g.updateMatrixWorld(true); let pk = null; g.traverse((o) => { if (!pk && o.name === 'Y' && o.isMesh && o.parent && o.parent.visible !== false && /picker/i.test((o.parent.name || '') + (o.parent.parent && o.parent.parent.name || '')) ) pk = o; }); if (!pk) g.traverse((o) => { if (!pk && o.name === 'Y' && o.isMesh && o.visible) pk = o; }); const c = new T.Box3().setFromObject(pk).getCenter(new T.Vector3()); const o = new T.Vector3(); E.objs[E.sel].group.getWorldPosition(o); const r = E.renderer.domElement.getBoundingClientRect(); const pr = (v) => { const q = v.clone().project(E.camera); return [(q.x + 1) / 2 * r.width + r.left, (1 - q.y) / 2 * r.height + r.top]; }; return [pr(c), pr(o)]; })()`);
  const [hp, op] = hy; const dirY = [hp[0] - op[0], hp[1] - op[1]]; const dl = Math.hypot(...dirY) || 1;
  await mouse('mouseMoved', hp[0], hp[1]); await sleep(100); await mouse('mousePressed', hp[0], hp[1], { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', hp[0] + dirY[0] / dl * 6 * i, hp[1] + dirY[1] / dl * 6 * i, { buttons: 1, button: 'left' });
  await mouse('mouseReleased', hp[0] + dirY[0] / dl * 60, hp[1] + dirY[1] / dl * 60, { button: 'left', clickCount: 1 }); await idle();
  const ys = (await it('Ys')).size;
  check('dragging the Y scale handle changes only Y (D grows, W and H stay)', ys.y > 20.5 && ys.x === 30 && ys.z === 10, JSON.stringify(ys));
  await key('m', 'KeyM', 77);
  // touch: a single tap on a label edits it
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tz = await ev(`(() => { const r = document.querySelector('.cad-dimlabel.ax2').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await tap(tz); await sleep(200);
  check('iPad: one tap on a dimension opens the editor', await ev(`!!document.querySelector('.cad-dimlabel.ax2 .cad-dim-in')`));
  await ev(`document.querySelector('.cad-dim-in').value = '12'`); await key('Enter', 'Enter', 13); await idle();
  check('…and the typed height applies (H 12)', (await it('Ys')).size.z === 12, JSON.stringify((await it('Ys')).size));
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
  await key('m', 'KeyM', 77);
  await reset([{ type: 'box', name: 'A', size: { x: 5, y: 5, z: 5 }, pos: [0, 0, 0] }, { type: 'box', name: 'B', size: { x: 5, y: 5, z: 5 }, pos: [20, 0, 0] }]);
  await press('[data-selall]'); await press('[data-mode="scale"]');
  check('multi-selection: Scale is allowed', (await ev(`boardEngine.tc.mode`)) === 'scale');
  check('multi-selection shows the whole selection size (X 25)', /X 25 mm/.test(await dimText()), await dimText());
  await ev(`boardEngine._combine()`); await idle(); await press('[data-mode="scale"]');
  await ev(`(() => { const E = boardEngine; E.tc.dispatchEvent({ type: 'dragging-changed', value: true }); E.proxy.scale.set(2, 1, 3); E.tc.dispatchEvent({ type: 'objectChange' }); })()`); await sleep(100);
  check('combined object: live dimensions while scaling (X 50, Z 15)', /X 50 mm/.test(await dimText()) && /Z 15 mm/.test(await dimText()), await dimText());
  await ev(`boardEngine.tc.dispatchEvent({ type: 'dragging-changed', value: false })`); await idle();
  const gs = await items();
  check('combined object scaled as one: each part 10×5×15, spacing doubled (20 → 40)', gs.every((x) => x.size.x === 10 && x.size.y === 5 && x.size.z === 15) && Math.abs(gs[1].pos[0] - gs[0].pos[0]) === 40, JSON.stringify(gs.map((x) => [x.size, x.pos])));
  await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('one ⌘Z undoes the group scale', (await items()).every((x) => x.size.x === 5 && x.size.z === 5));
  await key('m', 'KeyM', 77);
  await key('Escape', 'Escape', 27); check('no selection → no dimension labels', !(await has('.cad-dimlabel')));

  // ======================================================================
  section('Split objects with a shape (your FrameTap + a cylinder)');
  const fvol2 = async () => { await idle(); return fvol(); };
  if (!HAVE_FT) console.log('  (FrameTap STL not found — using a box instead)');
  await reset(HAVE_FT
    ? [{ type: 'model', name: 'FrameTap', role: 'solid', file: { path: 'models/frametap.stl', ext: 'stl', key: 'models/frametap.stl#t' }, pos: [0, 0, 0] }]
    : [{ type: 'box', name: 'FrameTap', size: { x: 41, y: 16, z: 118 }, pos: [0, 0, 0] }]);
  await idle(); await sleep(500); await idle();
  const vWhole = await fvol2();
  await ev(`boardEngine._add('cylinder', { name: 'Cutter', size: { d: 12, z: 60 }, pos: [0, 0, 30] })`); await idle();
  check('cylinder placed through the FrameTap, selected', (await selNames()) === 'Cutter');
  check('"Split objects with this shape" button in its panel', await has('[data-splitwith]'));
  await press('[data-splitwith]'); await idle(); await sleep(300); await idle();
  const splitItems = await items();
  check('→ 2 objects: FrameTap (outside) + FrameTap piece (inside); the cylinder is used up', splitItems.length === 2 && splitItems.some((x) => x.name === 'FrameTap' && x.cuts && x.cuts[0].keep === 'outside') && splitItems.some((x) => /piece/.test(x.name) && x.cuts && x.cuts[0].keep === 'inside') && !splitItems.some((x) => x.name === 'Cutter'), JSON.stringify(splitItems.map((x) => [x.name, x.cuts && x.cuts.map((c) => c.keep)])));
  check('no gap: both pieces together = the original volume', near(await fvol2(), vWhole, Math.max(0.05, vWhole * 1e-6)), (await fvol()) + ' vs ' + vWhole);
  check('the plug is selected, ready to move', /piece/.test(await selNames()));
  const vols = await ev(`(async () => { const E = boardEngine; const out = {}; for (const x of E.data.items) { const m = E.meshes[x.id]; let s = 0; const v = m.vertices, t = m.triangles; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } out[x.name] = s / 6; } return out; })()`);
  check('the plug is round: about π·6²·(part thickness) and much smaller than the remote', vols['FrameTap piece'] > 50 && vols['FrameTap piece'] < vols.FrameTap / 4, JSON.stringify(vols));
  await ev(`(() => { const E = boardEngine; E._editMany(E._selIds(), (x) => { x.pos = [60, 0, 0]; }); })()`); await idle();
  check('move the plug out → the remote keeps its round hole, volumes unchanged', near(await fvol2(), vWhole, Math.max(0.05, vWhole * 1e-6)));
  await press('[data-export]'); await press('[data-ex="3mf"]'); await popupsAll('Export anyway'); await sleep(1500);
  const zz = dataFile('test.3mf'); const nn = zz ? (new TextDecoder().decode(unzipSync(new Uint8Array(zz))['3D/3dmodel.model']).match(/<object /g) || []).length : 0;
  check('3MF export → 2 objects (remote with hole, plug)', nn === 2, nn);
  check('after the export, keyboard shortcuts still work (focus is back in the 3D view)', await ev(`boardEngine.root.contains(document.activeElement)`));
  await key('z', 'KeyZ', 90, MOD.meta); await idle(); await key('z', 'KeyZ', 90, MOD.meta); await idle();
  check('undo → back to the remote + cylinder (one step for the split)', (await items()).length === 2 && (await items()).some((x) => x.name === 'Cutter') && !(await items()).some((x) => x.cuts), JSON.stringify((await items()).map((x) => x.name)));
  // the sketch-on-a-face workflow
  await reset([{ type: 'box', name: 'Plate', size: { x: 40, y: 30, z: 6 }, pos: [0, 0, 0] }]);
  await ev(`boardEngine._view('iso')`); await key('e', 'KeyE', 69); await click(await scr(0, 0, 6)); await press('[data-fsketch]'); await sleep(250);
  await press('[data-sktool="circle"]'); await click(await sp(0, 0)); await click(await sp(5, 0)); await press('[data-skdone]'); await idle(); await extrude('0.05');
  await setField('pos.2', '-1'); await setField('height', '8');
  await press('[data-splitwith]'); await idle();
  const pl = (await items()).filter((x) => !x.draft);
  check('sketch a Ø10 circle on the face, extrude, Split → plate with hole + round plug (2D sketch kept)', pl.length === 2 && (await items()).some((x) => x.draft) && near(await fvol2(), 40 * 30 * 6, 0.05), JSON.stringify(pl.map((x) => x.name)) + ' ' + (await fvol()));
  const plugV = await ev(`(() => { const E = boardEngine; const x = E.data.items.find((i) => /piece/.test(i.name)); const m = E.meshes[x.id]; let s = 0; const v = m.vertices, t = m.triangles; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; })()`);
  check('the plug is exactly the Ø10 × 6 disc (π·25·6 = 471.2)', near(plugV, Math.PI * 25 * 6, 1.5), plugV);
  await ev(`boardEngine._add('box', { name: 'Away', size: { x: 5, y: 5, z: 5 }, pos: [200, 0, 0] })`); await idle();
  await press('[data-splitwith]'); check('a shape that touches nothing → explains, nothing changes', /doesn.t overlap/.test(await ev(`document.querySelector('.cad-root .cad-toast').textContent`)) && (await items()).length === 4);

  // ======================================================================
  section('Import (file picker) & model size');
  await reset();
  const fileInput = await cmd('DOM.querySelector', { nodeId: (await cmd('DOM.getDocument', {})).result.root.nodeId, selector: '.cad-file' });
  const tmpStl = path.join(tmp, 'gadget.stl'); fs.writeFileSync(tmpStl, Buffer.from(F.binarySTL()));
  await cmd('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [tmpStl] }); await sleep(2500); await idle();
  const g = await it('gadget');
  check('STL import → model saved next to the design and added as Reference', g && g.type === 'model' && g.role === 'ref' && fs.existsSync(path.join(data, g.file.path)), JSON.stringify(g));
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle(); await ev(`boardEngine._inspFor = null; boardEngine._renderInspector()`);
  check('panel shows the size in the file', /10 × 10 × 10/.test(await ev(`document.querySelector('.cad-filesize').textContent`)));
  await press('[data-units="cm"]'); await idle(); check('Units cm → 100 mm', /X ?100 .*Y ?100 .*Z ?100/.test(await dims()), await dims());
  await press('[data-units="mm"]'); await idle();
  await ev(`(() => { const i = document.querySelector('.cad-inspector [data-msize="2"]'); i.value = '25'; i.dispatchEvent(new Event('change')); })()`); await idle();
  check('type real height 25 (locked) → all axes 25', /X ?25 .*Y ?25 .*Z ?25/.test(await dims()), await dims());
  await press('[data-lock]'); await ev(`(() => { const i = document.querySelector('.cad-inspector [data-msize="0"]'); i.value = '50'; i.dispatchEvent(new Event('change')); })()`); await idle();
  check('unlocked: W 50 stretches only X', /X ?50 .*Y ?25 .*Z ?25/.test(await dims()), await dims());
  await press('[data-resetsize]'); await idle(); check('Reset to file size', /X ?10 .*Y ?10 .*Z ?10/.test(await dims()), await dims());
  await press('.cad-inspector [data-role="solid"]'); await idle();
  await press('[data-fit="outline"]'); await idle(); check('Outline / Exact switch', (await it('gadget')).fit === 'outline');
  const tmpPng = path.join(tmp, 'photo.png'); fs.writeFileSync(tmpPng, Buffer.from(F.PNG_1PX));
  await cmd('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [tmpPng] }); await sleep(2500);
  const im = await it('photo');
  check('image import → reference picture', im && im.type === 'image' && im.role === 'ref');
  await setField('width', '80'); check('image width', (await it('photo')).width === 80);
  await setField('opacity', '0.3'); check('image opacity', (await it('photo')).opacity === 0.3);
  check('image plane loaded with its texture', await ev(`!!(boardEngine.objs[boardEngine.sel] && boardEngine.objs[boardEngine.sel].mesh.material.map)`));

  // ======================================================================
  section('Script editor');
  await reset([{ type: 'code', name: 'Scr' }]);
  await ev(`boardEngine._select(boardEngine.data.items[0].id)`); await idle();
  check('panel shows a preview, not a code box', await has('.cad-code-peek') && !(await has('.cad-inspector textarea')));
  await press('.cad-inspector [data-editcode].cad-wide-btn'); await sleep(600);
  check('editor opens (Monaco)', await has('.cad-codeov .monaco-editor'));
  await ev(`(() => { const m = monaco.editor.getEditors().find((e) => document.querySelector('.cad-codeov').contains(e.getDomNode())); m.setValue(m.getValue().replace('drawRoundedRectangle(30, 20, 4)', 'drawRoundedRectangle(50, 20, 4)')); m.focus(); })()`);
  await key('Enter', 'Enter', 13, MOD.meta); await sleep(300); await idle();
  check('⌘↵ applies, editor stays open with "Built ✓"', await has('.cad-codeov') && /Built/.test(await ev(`document.querySelector('.cad-codemsg').textContent`)));
  check('applied code → 50 mm wide', /X ?50/.test(await dims()) || (await ev(`boardEngine._item(boardEngine.sel).code.includes('(50, 20, 4)')`)));
  await ev(`boardEngine.flushEdit()`); check('autosave does not steal focus from the editor', await ev(`document.querySelector('.cad-codeov').contains(document.activeElement)`));
  await typeText('x'); check('keys in the editor never trigger shortcuts (x typed, no new shapes)', (await items()).length === 1);
  await key('Escape', 'Escape', 27); if (await has('.cad-codeov')) await key('Escape', 'Escape', 27); // 1st Esc may just close autocomplete
  check('Esc closes the editor (after closing autocomplete)', !(await has('.cad-codeov')));
  await press('.cad-inspector [data-editcode].cad-wide-btn'); await sleep(400);
  check('reopening keeps the unapplied draft', await ev(`monaco.editor.getEditors().some((e) => document.querySelector('.cad-codeov') && document.querySelector('.cad-codeov').contains(e.getDomNode()) && /x/.test(e.getValue()))`));
  await press('[data-cdone]'); await idle(); check('Done closes the editor', !(await has('.cad-codeov')));

  // ======================================================================
  section('Export & warnings');
  for (const f of ['test.3mf', 'test.stl', 'test.step']) fs.rmSync(path.join(data, f), { force: true }); // start clean (earlier sections export too)
  await reset([{ type: 'box', name: 'Base', size: { x: 40, y: 30, z: 10 }, pos: [0, 0, 0] }, { type: 'box', name: 'Top', size: { x: 40, y: 30, z: 4 }, pos: [10, 0, 8] }, { type: 'cylinder', name: 'Float', size: { d: 10, z: 5 }, pos: [60, 0, 20] }]);
  await press('[data-export]'); await press('[data-ex="3mf"]'); await sleep(600);
  check('floating warning appears first, names the part', /Floating/.test(await ev(`document.querySelector('.ui-pop-title').textContent`)) && /Float/.test(await popupText()));
  await popup('Cancel'); check('Cancel → floating part selected, nothing saved', (await selNames()) === 'Float' && !dataFile('test.3mf'));
  await press('[data-dropfloat]'); await idle(); check('Drop to floor from the warning message', (await it('Float')).pos[2] === 0);
  await press('[data-export]'); await press('[data-ex="3mf"]'); await sleep(600);
  check('overlap warning lists Base ↔ Top with shared volume', /Base\s+↔\s+Top/.test(await popupText()) && /\(1800 mm³ shared\)/.test(await popupText()), await popupText());
  await popup('Cancel'); check('Cancel → overlapping parts selected', (await selNames()) === 'Base,Top');
  await press('[data-export]'); await press('[data-ex="3mf"]'); await sleep(600); await popup('Export anyway'); await sleep(1500);
  const z = dataFile('test.3mf');
  let objs = [];
  if (z) { const xm = new TextDecoder().decode(unzipSync(new Uint8Array(z))['3D/3dmodel.model']); objs = [...xm.matchAll(/<object id="\d+" type="model" name="([^"]*)"/g)].map((m) => m[1]); }
  check('Save 3MF → file next to the design with objects "Base + Top" and "Float"', JSON.stringify(objs.sort()) === JSON.stringify(['Base + Top', 'Float']), JSON.stringify(objs));
  await press('[data-export]'); await press('[data-ex="stl"]'); await sleep(600); await popup('Export anyway'); await sleep(1500);
  const stl = dataFile('test.stl'); const s = stl ? F.parseSTL(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)) : null;
  check('Save STL → watertight file', s && F.isClosed(s.triangles));
  await press('[data-export]'); await press('[data-ex="step"]'); await sleep(600); await popup('Export anyway'); await sleep(2500);
  check('Save STEP → ISO-10303 file', /^ISO-10303-21/.test((dataFile('test.step') || '').toString().slice(0, 20)));
  await ev(`window.__dl = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__dl.push(b.size); return o(b); }`);
  await press('[data-export]'); await press('[data-ex="dl"]'); await sleep(600); await popup('Export anyway'); await sleep(1200);
  await press('[data-export]'); await press('[data-ex="dl3mf"]'); await sleep(600); await popup('Export anyway'); await sleep(1200);
  check('Download STL and Download 3MF produce files', (await ev(`window.__dl.length`)) === 2 && (await ev(`window.__dl.every((n) => n > 100)`)));
  await ev(`(() => { const E = boardEngine; E._editMany([E.data.items[1].id], (x) => { x.pos = [0, 0, 10]; x.size = Object.assign({}, x.size, { x: 40 }); }); })()`); await idle();
  await press('[data-export]'); await press('[data-ex="3mf"]'); await sleep(1500);
  check('touching parts → no warning, exports straight away', !(await has('.ui-pop-title')));

  // ======================================================================
  section('Saving & reopening');
  await reset([{ type: 'box', name: 'Keep', size: { x: 12, y: 34, z: 5 }, pos: [1, 2, 3] }, { type: 'box', name: 'K2', size: { x: 5, y: 5, z: 5 }, pos: [20, 0, 0] }]);
  await ev(`boardEngine._setSel(boardEngine.data.items.map((x) => x.id)); boardEngine._combine()`); await idle();
  await ev(`saveFile ? saveFile() : null`).catch(() => null); await sleep(1500);
  await ev(`(async () => { await fetch('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'test.html', content: getSaveContent() }) }); })()`); await sleep(800);
  const saved = fs.readFileSync(path.join(data, 'test.html'), 'utf8');
  check('design saves as a 3D design file', /data-docviewer="cad"/.test(saved) && /"Keep"/.test(saved) && /"groups"/.test(saved));
  await ev(`openFile('test.html', undefined, { force: true, skipDirty: true })`); await sleep(500);
  for (let i = 0; i < 200 && !(await ev(`!!(typeof boardEngine !== 'undefined' && boardEngine && boardEngine.ready && boardEngine.data.items.length)`)); i++) await sleep(100);
  await idle();
  const re = await items();
  check('reopens with shapes, sizes, positions and combined objects', re.length === 2 && re[0].size.y === 34 && JSON.stringify(re[0].pos) === '[1,2,3]' && re[0].group && re[0].group === re[1].group);

  // ======================================================================
  section('Read-only & theme');
  await ev(`boardEngine.setReadOnly(true)`); check('read-only hides the shape tools', await ev(`getComputedStyle(document.querySelector('.cad-tools')).display === 'none'`)); await ev(`boardEngine.setReadOnly(false)`);
  const c1 = await ev(`boardEngine.colors.part.getHexString()`);
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await sleep(300);
  check('dark theme recolours the 3D view', (await ev(`boardEngine.colors.part.getHexString()`)) !== c1);
  await ev(`document.documentElement.setAttribute('data-theme', 'light')`);

  section('Console');
  check('no JavaScript errors in the console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

setTimeout(() => { console.log('\nWATCHDOG: run exceeded 30 min, last passed step: ' + lastStep); process.exit(3); }, 30 * 60 * 1000).unref();
try { await run(); } catch (e) { check('test run finished without crashing', false, e.stack || e.message); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
