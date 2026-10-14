// Music analysis add-on: status / install / remove, analysis jobs (one at a
// time, queued) with live progress over Server-Sent Events, and the analysis
// results stored next to each media file in "<name>.analysis/".
//
//   GET  /api/music/addon                     {installed, version, versions, dir, busy}
//   POST /api/music/addon/install | /remove   → {job}
//   POST /api/music/analyze {media, steps, parts}  → {job}
//   GET  /api/music/jobs                      active / recent jobs
//   GET  /api/music/jobs/:id                  SSE: progress events, then done / error
//   POST /api/music/jobs/:id/cancel
//   GET  /api/music/analysis?media=…          {dir, stems, runs:[analysis.json + notes parts]}
//   GET  /api/music/analysis/notes?media=…&run=…&part=…
//   POST /api/music/analysis/delete {media, run? , stems?}
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ADDON_DIR = process.env.ACCRETION_MUSIC_DIR || path.join(os.homedir(), '.accretion', 'music');
const WORKER = path.join(__dirname, 'music', 'worker.py');
const INSTALLER = path.join(__dirname, 'music', 'install-addon.sh');
const PY = () => process.env.ACCRETION_MUSIC_PY || path.join(ADDON_DIR, 'venv', 'bin', 'python');

function addonInfo() {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(ADDON_DIR, 'addon.json'), 'utf8')); } catch (e) { /* not installed */ }
  const installed = !!meta && fs.existsSync(PY());
  return { installed, version: meta && meta.version, installedAt: meta && meta.installed, dir: ADDON_DIR };
}

// Track media links are data-root links, maybe URL-encoded:
// "/assets/media/music/My%20Song.mp3" → "assets/media/music/My Song.mp3"
function mediaRel(media) {
  return String(media || '').replace(/^\/+/, '').split('#')[0].split('?')[0].split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
}
// → "assets/media/music/My Song.analysis"
function analysisRel(media) { return mediaRel(media).replace(/\.[^./]+$/, '') + '.analysis'; }

function register(app, deps) {
  const { resolveSafe, commitFile, dataRoot } = deps;
  const jobs = new Map();
  const queue = [];
  let running = null;
  let seq = 0;

  function newJob(kind, label, run) {
    const job = { id: 'j' + Date.now().toString(36) + (++seq), kind, label, status: 'queued', progress: 0, msg: 'Waiting…', log: [], listeners: new Set(), result: null, error: null, created: Date.now(), run, proc: null };
    jobs.set(job.id, job);
    // Keep the last 30 finished jobs.
    const done = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');
    done.slice(0, Math.max(0, done.length - 30)).forEach((j) => jobs.delete(j.id));
    queue.push(job);
    pump();
    return job;
  }
  function pub(job) {
    return { id: job.id, kind: job.kind, label: job.label, status: job.status, progress: job.progress, msg: job.msg, result: job.result, error: job.error, created: job.created };
  }
  function send(job, event) {
    const data = 'data: ' + JSON.stringify(Object.assign(pub(job), event ? { event } : {})) + '\n\n';
    job.listeners.forEach((res) => { try { res.write(data); } catch (e) { /* closed */ } });
  }
  function finish(job, status, error) {
    job.status = status;
    if (error) job.error = String(error).slice(0, 2000);
    if (status === 'done') { job.progress = 1; job.msg = 'Done'; }
    send(job, status);
    job.listeners.forEach((res) => { try { res.end(); } catch (e) { /* closed */ } });
    job.listeners.clear();
    running = null;
    pump();
  }
  function pump() {
    if (running || !queue.length) return;
    running = queue.shift();
    if (running.status === 'cancelled') { running = null; pump(); return; }
    running.status = 'running';
    send(running);
    Promise.resolve().then(() => running.run(running)).catch((e) => { if (running && running.status === 'running') finish(running, 'error', e && e.message ? e.message : e); });
  }

  // Spawn a process; stdout lines are JSON (worker) or "PROGRESS n msg" (installer).
  function runProc(job, cmd, args, onResult) {
    return new Promise((resolve) => {
      const env = Object.assign({}, process.env, { PATH: '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || ''), PYTHONUNBUFFERED: '1' });
      const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      job.proc = p;
      let out = '';
      let err = '';
      const line = (l) => {
        l = l.trim();
        if (!l) return;
        const m = /^PROGRESS (\d+) ?(.*)$/.exec(l);
        if (m) { job.progress = Number(m[1]) / 100; job.msg = m[2]; send(job); return; }
        let o = null;
        try { o = JSON.parse(l); } catch (e) { /* plain output */ }
        if (o && typeof o.progress === 'number') { job.progress = o.progress; job.msg = o.msg || job.msg; send(job); return; }
        if (o && o.warning) { job.log.push(o.warning); job.msg = o.warning; send(job); return; }
        if (o && o.result) { onResult && onResult(o.result); return; }
        if (o && o.error) { job.error = o.error; return; }
        job.log.push(l.slice(0, 400));
        if (job.log.length > 200) job.log.shift();
      };
      p.stdout.on('data', (d) => { out += d; const parts = out.split('\n'); out = parts.pop(); parts.forEach(line); });
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', (e) => { job.error = e.message; resolve(1); });
      p.on('close', (code) => { if (out) line(out); job.proc = null; if (code && !job.error) job.error = (err.trim().split('\n').slice(-6).join('\n') || 'exit ' + code); resolve(code == null ? 1 : code); });
    });
  }

  app.get('/api/music/addon', (req, res) => {
    const info = addonInfo();
    info.busy = !!running;
    if (!info.installed || req.query.check !== '1') return res.json(info);
    const job = { log: [], proc: null };
    runProc(job, PY(), [WORKER, 'check'], (r) => { info.versions = r; }).then(() => res.json(info));
  });

  function installJob(remove) {
    return newJob(remove ? 'remove' : 'install', remove ? 'Remove music analysis' : 'Install music analysis', async (job) => {
      job.msg = remove ? 'Removing…' : 'Starting install…';
      send(job);
      const code = await runProc(job, '/bin/bash', [INSTALLER].concat(remove ? ['--remove'] : []));
      if (job.status === 'cancelled') return;
      if (code === 0) { job.result = addonInfo(); finish(job, 'done'); } else finish(job, 'error', job.error || 'Install failed');
    });
  }
  app.post('/api/music/addon/install', (req, res) => res.json({ job: pub(installJob(false)) }));
  app.post('/api/music/addon/remove', (req, res) => {
    if (running && running.kind === 'analyze') return res.status(409).json({ error: 'An analysis is running' });
    res.json({ job: pub(installJob(true)) });
  });

  const STEPS = ['stems', 'notes', 'tempo', 'key', 'chords', 'sections'];
  const PARTS = ['mix', 'vocals', 'bass', 'guitar', 'piano', 'other'];
  app.post('/api/music/analyze', (req, res) => {
    try {
      if (!addonInfo().installed && !process.env.ACCRETION_MUSIC_PY) return res.status(400).json({ error: 'The music analysis add-on is not installed' });
      const media = String((req.body && req.body.media) || '');
      const input = resolveSafe(mediaRel(media));
      if (!fs.existsSync(input)) return res.status(404).json({ error: 'Media file not found: ' + media });
      const steps = (Array.isArray(req.body.steps) ? req.body.steps : STEPS).filter((s) => STEPS.includes(s));
      const parts = (Array.isArray(req.body.parts) ? req.body.parts : ['mix']).filter((p) => PARTS.includes(p));
      if (!steps.length) return res.status(400).json({ error: 'Nothing to do' });
      const aRel = analysisRel(media);
      const outDir = resolveSafe(aRel);
      const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const label = (req.body.label ? String(req.body.label).slice(0, 120) + ' — ' : '') + steps.join(', ');
      const job = newJob('analyze', label, async (j) => {
        fs.mkdirSync(outDir, { recursive: true });
        // Stems are large: keep them out of git history.
        const gi = path.join(outDir, '.gitignore');
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'stems/\n');
        const code = await runProc(j, PY(), [WORKER, 'analyze', '--input', input, '--out', outDir, '--run', runId, '--steps', steps.join(','), '--parts', parts.join(',')], (r) => { j.result = r; });
        if (j.status === 'cancelled') return;
        if (code !== 0 || !j.result) { finish(j, 'error', j.error || 'Analysis failed'); return; }
        j.result.media = media;
        j.result.analysis = '/' + aRel;
        try {
          const runRel = aRel + '/runs/' + runId;
          const files = fs.readdirSync(resolveSafe(runRel)).map((f) => runRel + '/' + f);
          commitFile([aRel + '/.gitignore'].concat(files), 'Music analysis: ' + path.basename(media));
        } catch (e) { /* history is best effort */ }
        finish(j, 'done');
      });
      res.json({ job: pub(job) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/music/jobs', (req, res) => res.json({ jobs: [...jobs.values()].map(pub).reverse() }));
  app.get('/api/music/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'No such job' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify(pub(job)) + '\n\n');
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') { res.end(); return; }
    job.listeners.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 15000);
    req.on('close', () => { clearInterval(ping); job.listeners.delete(res); });
  });
  app.post('/api/music/jobs/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'No such job' });
    if (job.status === 'queued') { job.status = 'cancelled'; send(job, 'cancelled'); return res.json({ ok: true }); }
    if (job.status === 'running') {
      job.status = 'cancelled';
      if (job.proc) { try { job.proc.kill('SIGTERM'); } catch (e) { /* gone */ } }
      finish(job, 'cancelled');
    }
    res.json({ ok: true });
  });

  function readRuns(aRel) {
    const dir = resolveSafe(aRel);
    const runsDir = path.join(dir, 'runs');
    const runs = [];
    if (fs.existsSync(runsDir)) {
      for (const id of fs.readdirSync(runsDir)) {
        try {
          const a = JSON.parse(fs.readFileSync(path.join(runsDir, id, 'analysis.json'), 'utf8'));
          delete a.beats; // large; fetched with the run when applied
          a.run = id;
          runs.push(a);
        } catch (e) { /* incomplete run */ }
      }
    }
    runs.sort((x, y) => String(y.run).localeCompare(String(x.run)));
    let stems = [];
    try { stems = fs.readdirSync(path.join(dir, 'stems')).filter((f) => /\.(mp3|wav)$/.test(f)).map((f) => ({ name: f.replace(/\.[^.]+$/, ''), path: '/' + aRel + '/stems/' + f })); } catch (e) { /* none */ }
    const order = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
    stems.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return { dir: '/' + aRel, exists: fs.existsSync(dir), runs, stems };
  }

  app.get('/api/music/analysis', (req, res) => {
    try { res.json(readRuns(analysisRel(req.query.media))); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/music/analysis/run', (req, res) => {
    try {
      const run = String(req.query.run || '').replace(/[^\w.-]/g, '');
      const dir = resolveSafe(analysisRel(req.query.media) + '/runs/' + run);
      const a = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
      a.run = run;
      a.notes = {};
      for (const f of fs.readdirSync(dir)) {
        const m = /^notes-(\w+)\.json$/.exec(f);
        if (m) a.notes[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
      res.json(a);
    } catch (e) { res.status(404).json({ error: e.message }); }
  });
  app.post('/api/music/analysis/delete', (req, res) => {
    try {
      const aRel = analysisRel(req.body && req.body.media);
      const dir = resolveSafe(aRel);
      const removed = [];
      if (req.body.run) {
        const run = String(req.body.run).replace(/[^\w.-]/g, '');
        const rd = path.join(dir, 'runs', run);
        if (fs.existsSync(rd)) {
          const files = fs.readdirSync(rd).map((f) => aRel + '/runs/' + run + '/' + f);
          fs.rmSync(rd, { recursive: true, force: true });
          commitFile(files, 'Delete music analysis run ' + run);
          removed.push(run);
        }
      }
      if (req.body.stems) { fs.rmSync(path.join(dir, 'stems'), { recursive: true, force: true }); removed.push('stems'); }
      res.json({ ok: true, removed, state: readRuns(aRel) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Called by /api/move: move "<name>.analysis/" along with its media file.
  return {
    moveAnalysisWith(fromRel, toRel) {
      if (!/\.[^./]+$/.test(fromRel)) return null;
      const aFrom = analysisRel(fromRel);
      const aTo = analysisRel(toRel);
      if (aFrom === aTo) return null;
      const src = resolveSafe(aFrom);
      const dst = resolveSafe(aTo);
      if (!fs.existsSync(src) || fs.existsSync(dst)) return null;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return { from: aFrom, to: aTo };
    },
    analysisRel,
    dataRoot,
  };
}

module.exports = { register, analysisRel, ADDON_DIR };
