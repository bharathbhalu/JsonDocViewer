// 3D modeling (CAD docs): the optional add-on that builds the CAD libraries
// (replicad + OpenCascade WASM + Three.js) into public/cad/vendor, plus file
// access for CAD docs — reading reference meshes and saving exports.
//
//   GET  /api/cad/addon                 {installed, versions, busy, log, error, npm}
//   POST /api/cad/addon/install         start (re)install — runs cad-build/build.sh
//   POST /api/cad/addon/remove          delete the built libraries
//   GET  /api/cad/mesh?path=…           a .stl / .step / .3mf file under the data folder
//   POST /api/cad/export {path, content(base64), message}  write + commit an export
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const BUILD_DIR = path.join(__dirname, 'cad-build');
const VENDOR_DIR = path.join(__dirname, 'public', 'cad', 'vendor');
const REQUIRED = ['cad-worker.js', 'three-bundle.js', 'replicad_single.wasm', 'VERSION.json'];
const MESH_EXT = /\.(stl|3mf|obj|step|stp)$/i;
const IMAGE_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_MESH = 80 * 1024 * 1024;

// Servers started from a LaunchAgent or the Dock app get a minimal PATH.
function toolEnv() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  return Object.assign({}, process.env, { PATH: parts.join(':') });
}
function hasNpm() {
  try { execFileSync('npm', ['--version'], { env: toolEnv(), stdio: 'ignore', timeout: 15000 }); return true; } catch (e) { return false; }
}

module.exports = function setupCad(app, deps) {
  const { resolveSafe, commitFile, isLocalRequest } = deps;
  // Installing runs npm on this computer, so only this computer may do it.
  const localOnly = (req, res) => { if (isLocalRequest && !isLocalRequest(req)) { res.status(403).json({ error: 'Install or remove 3D modeling from Accretion on this computer.' }); return false; } return true; };
  const job = { busy: false, action: '', log: [], error: '', finishedAt: 0 };
  let npmOk = null;

  function status() {
    const installed = REQUIRED.every((f) => fs.existsSync(path.join(VENDOR_DIR, f)));
    let versions = null;
    if (installed) { try { versions = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VERSION.json'), 'utf8')); } catch (e) { /* unreadable */ } }
    if (npmOk === null) npmOk = hasNpm();
    return { installed, versions, busy: job.busy, action: job.action, log: job.log.slice(-40), error: job.error, finishedAt: job.finishedAt, npm: npmOk };
  }
  function addLog(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) job.log.push(line.slice(0, 400));
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  }

  app.get('/api/cad/addon', (req, res) => res.json(status()));

  app.post('/api/cad/addon/install', (req, res) => {
    if (!localOnly(req, res)) return;
    if (job.busy) return res.status(409).json({ error: 'An install is already running' });
    npmOk = hasNpm();
    if (!npmOk) return res.status(400).json({ error: 'npm was not found. Install Node.js (e.g. brew install node), then try again.' });
    Object.assign(job, { busy: true, action: 'install', log: [], error: '', finishedAt: 0 });
    addLog('Building the 3D modeling libraries (downloads ~30 MB the first time)…');
    const child = spawn('sh', [path.join(BUILD_DIR, 'build.sh')], { cwd: BUILD_DIR, env: toolEnv() });
    child.stdout.on('data', addLog);
    child.stderr.on('data', addLog);
    child.on('error', (e) => { job.error = e.message; });
    child.on('close', (code) => {
      job.busy = false;
      job.finishedAt = Date.now();
      if (code !== 0 && !job.error) job.error = 'Install failed (exit ' + code + ') — see the log.';
    });
    res.json({ ok: true });
  });

  app.post('/api/cad/addon/remove', (req, res) => {
    if (!localOnly(req, res)) return;
    if (job.busy) return res.status(409).json({ error: 'An install is running' });
    try {
      fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
      fs.rmSync(path.join(BUILD_DIR, 'node_modules'), { recursive: true, force: true });
      Object.assign(job, { action: 'remove', log: ['Removed the 3D modeling libraries.'], error: '', finishedAt: Date.now() });
      res.json(status());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/cad/mesh', (req, res) => {
    try {
      const rel = String(req.query.path || '');
      const ext = (rel.split('.').pop() || '').toLowerCase();
      if (!MESH_EXT.test(rel) && !IMAGE_TYPE[ext]) return res.status(400).json({ error: 'Only STL, 3MF, OBJ, STEP and image files' });
      const full = resolveSafe(rel);
      const st = fs.existsSync(full) && fs.statSync(full);
      if (!st || !st.isFile()) return res.status(404).json({ error: 'File not found: ' + rel });
      if (st.size > MAX_MESH) return res.status(400).json({ error: 'File is too large (limit 80 MB)' });
      res.setHeader('Content-Type', IMAGE_TYPE[ext] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/cad/export', (req, res) => {
    try {
      const { path: rel, content, message } = req.body || {};
      if (!rel || typeof content !== 'string') return res.status(400).json({ error: 'path and content are required' });
      if (!MESH_EXT.test(rel)) return res.status(400).json({ error: 'Exports must be STL, 3MF, OBJ or STEP' });
      const full = resolveSafe(rel);
      const buf = Buffer.from(content, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'Empty export' });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      const commit = commitFile(rel, String(message || '').trim() || 'Export ' + rel);
      res.json({ ok: true, path: rel, size: buf.length, commit });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
};
