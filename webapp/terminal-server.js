// Terminals: terminal files (data-docviewer="terminal") describe a tmux
// session, local or on an SSH host; this module lists / creates / rebuilds
// those sessions, streams a live pane to the browser over a WebSocket
// (node-pty + xterm.js), sends commands (snippets, runbooks, "Ask Claude"),
// and captures output. Everything here is for THIS computer only: the HTTP
// routes are in LOCAL_ONLY in server.js and WebSocket upgrades are refused
// unless they come from Accretion's own page on localhost with a one-time
// token.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const TerminalCore = require(path.join(__dirname, 'public', 'terminal', 'core.js'));

let pty = null;
let ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = String(e.message).split('\n')[0]; }
let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch (e) { ptyError = ptyError || e.message; }

// tmux / ssh / claude may live in Homebrew paths that a launcher's PATH lacks.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
const ENV = Object.assign({}, process.env, {
  PATH: [...new Set([...(process.env.PATH || '/usr/bin:/bin').split(':'), ...EXTRA_PATH])].join(':'),
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG || 'en_US.UTF-8',
});
// Started from inside tmux? Attaching would be refused as "nested".
delete ENV.TMUX;
delete ENV.TMUX_PANE;

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// A directory for sh: keep ~ expansion working, quote the rest.
function qdir(d) {
  const s = String(d || '').trim();
  if (!s) return '"$HOME"';
  if (s === '~') return '"$HOME"';
  if (s.startsWith('~/')) return '"$HOME"/' + q(s.slice(2));
  return q(s);
}
const MARK = '\x1b]777;accretion;';

module.exports = function setupTerminals(app, deps) {
  const { dataRoot, safeReaddir, peekFileKind, resolveSafe, isLocalRequest, remoteTerminalOk, readAppConfig, writeAppConfig, writeFileCommit } = deps;

  const enabled = () => { const c = readAppConfig().terminal; return !(c && c.enabled === false); };

  // ---------- terminal files ----------
  const parsed = new Map();
  function readTerminalFile(rel) {
    const full = resolveSafe(rel);
    const mtime = fs.statSync(full).mtimeMs;
    const hit = parsed.get(full);
    if (hit && hit.mtime === mtime) return hit.data;
    const data = TerminalCore.parseHtml(fs.readFileSync(full, 'utf8'));
    if (!data) throw new Error('Not a terminal file: ' + rel);
    parsed.set(full, { mtime, data });
    return data;
  }
  function terminalFiles() {
    const root = dataRoot();
    const out = [];
    (function walk(dir, depth) {
      if (depth > 12) return;
      for (const e of safeReaddir(dir)) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.html?$/i.test(e.name) || peekFileKind(full, e.name) !== 'terminal') continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        try { out.push({ path: rel, data: readTerminalFile(rel) }); } catch (err) { /* skip */ }
      }
    })(root, 0);
    return out;
  }
  // Session name: the file's, or one derived from the file name.
  function sessionOf(d, rel) {
    return d.session || TerminalCore.cleanSession(path.basename(rel).replace(/\.html?$/i, '')) || 'accretion';
  }
  function localDir(d) {
    const s = String(d.dir || '').trim();
    if (!s) return dataRoot();
    if (s === '~') return os.homedir();
    if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
    return path.isAbsolute(s) ? s : path.join(dataRoot(), s);
  }

  // ---------- shell scripts that make a session exist ----------
  // interactive: print an OSC marker (stripped before the browser) instead
  // of plain text, then attach.
  function ensureScript(d, rel, interactive) {
    const S = sessionOf(d, rel);
    const dir = d.mode === 'ssh' ? qdir(d.dir) : q(localDir(d));
    const startup = TerminalCore.startupCommands(d);
    const lines = [];
    lines.push(`S=${q(S)}`);
    lines.push(`if ! command -v tmux >/dev/null 2>&1; then echo "tmux is not installed${d.mode === 'ssh' ? ' on this host' : ''} — opening a plain shell."; ${interactive ? `printf '${MARK.replace(/\x1b/g, '\\033')}notmux\\007'; exec "\${SHELL:-/bin/sh}" -l` : 'echo ACC_NOTMUX; exit 3'}; fi`);
    lines.push('if ! tmux has-session -t "=$S" 2>/dev/null; then');
    const ws = d.layout && d.layout.windows && d.layout.windows.length ? d.layout.windows : null;
    const send = (target, cmd) => `tmux send-keys -t "${target}" -l ${q(cmd)} && tmux send-keys -t "${target}" Enter`;
    if (ws) {
      ws.forEach((w, wi) => {
        const wdir = w.dir ? (d.mode === 'ssh' ? qdir(w.dir) : q(w.dir.startsWith('~') ? path.join(os.homedir(), w.dir.slice(1)) : w.dir)) : dir;
        const nameOpt = w.name ? ` -n ${q(w.name)}` : '';
        if (wi === 0) {
          lines.push(`  tmux new-session -d -s "$S" -c ${wdir}${nameOpt} || exit 4`);
          lines.push('  W=$(tmux display-message -p -t "=$S:" "#{window_id}"); FIRST=$W');
        } else {
          lines.push(`  W=$(tmux new-window -d -P -F "#{window_id}" -t "=$S:" -c ${wdir}${nameOpt})`);
        }
        (w.panes.length ? w.panes : [{ dir: '', cmd: '' }]).forEach((p, pi) => {
          const pdir = p.dir ? (d.mode === 'ssh' ? qdir(p.dir) : q(p.dir)) : wdir;
          if (pi === 0) lines.push('  P=$(tmux display-message -p -t "$W" "#{pane_id}")');
          else lines.push(`  P=$(tmux split-window -d -P -F "#{pane_id}" -t "$W" -${p.split === 'v' ? 'v' : 'h'} -c ${pdir})`);
          if (wi === 0 && pi === 0) { lines.push('  FIRSTP=$P'); return; }
          if (p.cmd && !d.claude) lines.push('  ' + send('$P', p.cmd));
        });
        lines.push('  tmux select-layout -t "$W" tiled >/dev/null 2>&1');
      });
      lines.push('  tmux select-window -t "$FIRST"');
      const firstCmd = ws[0].panes[0] && ws[0].panes[0].cmd && !d.claude ? [ws[0].panes[0].cmd] : [];
      firstCmd.concat(startup).forEach((c) => lines.push('  ' + send('$FIRSTP', c)));
    } else {
      lines.push(`  tmux new-session -d -s "$S" -c ${dir} || exit 4`);
      startup.forEach((c) => lines.push('  ' + send('=$S:', c)));
    }
    lines.push(interactive ? `  printf '${MARK.replace(/\x1b/g, '\\033')}rebuilt\\007'` : '  echo ACC_REBUILT');
    lines.push('fi');
    if (interactive) lines.push('exec tmux attach-session -t "=$S"');
    else lines.push('echo ACC_READY');
    return lines.join('\n');
  }

  function sshArgs(d, batch) {
    const a = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
    if (batch) a.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');
    if (d.port) a.push('-p', String(d.port));
    if (d.jump) a.push('-J', d.jump);
    return a;
  }
  // Run a script on the session's machine (non-interactive).
  function runScript(d, script, timeout) {
    return new Promise((resolve) => {
      const done = (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code || 1) : 0, out: String(stdout || ''), err: String(stderr || '').trim() });
      if (d.mode === 'ssh') {
        if (!d.host) return resolve({ ok: false, code: 2, out: '', err: 'No SSH host set in this terminal file' });
        execFile('ssh', [...sshArgs(d, true), d.host, 'exec "${SHELL:-/bin/sh}" -lc ' + q(script)], { env: ENV, timeout: timeout || 20000, maxBuffer: 8 << 20 }, done);
      } else {
        execFile('/bin/sh', ['-c', script], { env: ENV, cwd: os.homedir(), timeout: timeout || 15000, maxBuffer: 8 << 20 }, done);
      }
    });
  }
  const sshHint = (r) => (r.code === 255 || /Permission denied|Host key|Could not resolve|Connection refused|timed out/i.test(r.err)
    ? (r.err || 'SSH failed') + ' — Accretion needs key-based SSH (no password prompt) for this; the terminal pane itself can still ask for a password.'
    : r.err);

  // ---------- auto-connect / status ----------
  const status = new Map(); // rel -> { state, error, at, session }
  async function ensure(rel, d) {
    status.set(rel, { state: 'checking', at: Date.now(), session: sessionOf(d, rel) });
    const r = await runScript(d, ensureScript(d, rel, false), 30000);
    let st;
    if (/ACC_NOTMUX/.test(r.out)) st = { state: 'failed', error: 'tmux is not installed' + (d.mode === 'ssh' ? ' on ' + d.host : '') };
    else if (r.ok && /ACC_REBUILT/.test(r.out)) st = { state: 'rebuilt' };
    else if (r.ok && /ACC_READY/.test(r.out)) st = { state: 'ready' };
    else st = { state: 'failed', error: (d.mode === 'ssh' ? sshHint(r) : r.err) || 'exit ' + r.code };
    Object.assign(st, { at: Date.now(), session: sessionOf(d, rel) });
    status.set(rel, st);
    if (st.state === 'rebuilt') console.log(`Terminal: rebuilt tmux session "${st.session}" for ${rel}`);
    if (st.state === 'failed') console.log(`Terminal: could not prepare ${rel}: ${st.error}`);
    return st;
  }
  async function autoConnectAll() {
    if (!enabled()) return;
    const files = terminalFiles().filter((f) => f.data.autoConnect);
    // A few at a time; SSH hosts can be slow.
    const list = files.slice();
    const worker = async () => { while (list.length) { const f = list.shift(); await ensure(f.path, f.data); } };
    await Promise.all([1, 2, 3].map(worker));
  }
  setTimeout(autoConnectAll, 3000).unref();
  // Re-check auto-connect sessions every 10 minutes (rebuild if they died).
  setInterval(autoConnectAll, 10 * 60000).unref();

  // ---------- routes ----------
  function fileFromReq(req) {
    const rel = String((req.body && req.body.path) || req.query.path || '').replace(/^\/+/, '');
    if (!rel) throw new Error('path is required');
    return { rel, d: readTerminalFile(rel) };
  }
  const guard = (fn) => async (req, res) => {
    try {
      if (!enabled()) return res.status(403).json({ error: 'Terminals are turned off in Settings' });
      await fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  let tmuxVersion = null;
  execFile('tmux', ['-V'], { env: ENV }, (err, out) => { tmuxVersion = err ? null : String(out).trim(); });

  app.get('/api/term/info', (req, res) => {
    const t = readAppConfig().terminal || {};
    res.json({ enabled: enabled(), pty: !!pty && !!WebSocketServer, ptyError, tmux: tmuxVersion, home: os.homedir(), dataRoot: dataRoot(), network: !!t.network, allowHttp: !!t.allowHttp, remote: !isLocalRequest(req) });
  });

  app.post('/api/term/network', (req, res) => {
    const cfg = readAppConfig();
    const t = Object.assign({}, cfg.terminal || {});
    if (typeof req.body.network === 'boolean') t.network = req.body.network;
    if (typeof req.body.allowHttp === 'boolean') t.allowHttp = req.body.allowHttp;
    writeAppConfig(Object.assign({}, cfg, { terminal: t }));
    console.log(`Terminal network access: ${t.network ? 'ON' : 'off'}${t.network && t.allowHttp ? ' (plain http allowed)' : ''}`);
    res.json({ network: !!t.network, allowHttp: !!t.allowHttp });
  });

  // Why can't a live pane open? The browser can't read the reason a WebSocket
  // upgrade was refused, so the pane asks here after a failed attempt.
  app.get('/api/term/preflight', async (req, res) => {
    const problems = [];
    const warnings = [];
    if (!enabled()) problems.push({ code: 'disabled', message: 'Terminals are turned off.', fix: 'Turn them on in ⚙ Settings → Terminals (on the computer running Accretion).' });
    if (!pty) problems.push({ code: 'pty', message: 'Terminal support (node-pty) is not installed or failed to load' + (ptyError ? ': ' + ptyError : '') + '.', fix: 'In the app folder run: npm rebuild node-pty --build-from-source (or ./setup.sh --install), then restart Accretion. (Restarting with ./run.sh also tries this automatically.)' });
    if (!WebSocketServer) problems.push({ code: 'ws', message: 'The ws package is missing.', fix: 'In the app folder run npm install, then restart Accretion.' });
    let d = null;
    try { d = readTerminalFile(String(req.query.path || '')); } catch (err) { problems.push({ code: 'file', message: err.message, fix: 'Check the terminal file still exists.' }); }
    if (d && d.mode === 'ssh' && !d.host) problems.push({ code: 'host', message: 'No SSH host set.', fix: 'Set the host in the terminal\'s ⚙ settings.' });
    if (d && d.mode === 'local' && !tmuxVersion) warnings.push({ code: 'tmux', message: 'tmux is not installed here — you get a plain shell that ends when the pane closes.', fix: 'brew install tmux  /  sudo apt install tmux' });
    res.json({ ok: !problems.length, problems, warnings, pty: !!pty, tmux: tmuxVersion, node: process.version });
  });

  app.post('/api/term/enabled', (req, res) => {
    const cfg = readAppConfig();
    writeAppConfig(Object.assign({}, cfg, { terminal: Object.assign({}, cfg.terminal || {}, { enabled: !!(req.body && req.body.enabled) }) }));
    res.json({ enabled: enabled() });
  });

  // Sessions on the file's machine (or ?mode=local / ?host=… without a file).
  app.get('/api/term/sessions', guard(async (req, res) => {
    let d;
    if (req.query.path) d = fileFromReq(req).d;
    else d = TerminalCore.normalize({ mode: req.query.host ? 'ssh' : 'local', host: req.query.host || '' });
    const fmt = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_created}\t#{pane_current_path}';
    const r = await runScript(d, 'command -v tmux >/dev/null 2>&1 || { echo ACC_NOTMUX; exit 0; }; tmux list-sessions -F ' + q(fmt) + ' 2>/dev/null; exit 0');
    if (!r.ok) return res.status(502).json({ error: d.mode === 'ssh' ? sshHint(r) : r.err || 'tmux failed' });
    if (/ACC_NOTMUX/.test(r.out)) return res.json({ sessions: [], noTmux: true, where: d.mode === 'ssh' ? d.host : 'local' });
    const sessions = r.out.split('\n').filter((l) => l.includes('\t')).map((l) => {
      const [name, windows, attached, activity, created, cwd] = l.split('\t');
      return { name, windows: Number(windows), attached: Number(attached), activity: Number(activity) * 1000, created: Number(created) * 1000, cwd };
    }).sort((a, b) => b.activity - a.activity);
    res.json({ sessions, where: d.mode === 'ssh' ? d.host : 'local' });
  }));

  // Windows + panes of a session, for "save layout" / adopting a session.
  app.get('/api/term/layout', guard(async (req, res) => {
    const { d } = fileFromReq(req);
    const S = TerminalCore.cleanSession(req.query.session || '') || sessionOf(d, req.query.path);
    const shells = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|login)$/;
    const r = await runScript(d, `tmux list-panes -s -t ${q('=' + S)} -F '#{window_id}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_left}\t#{pane_top}\t#{pane_index}'`);
    if (!r.ok) return res.status(502).json({ error: d.mode === 'ssh' ? sshHint(r) : r.err || 'No such session' });
    const wins = [];
    const byId = new Map();
    r.out.split('\n').filter((l) => l.includes('\t')).forEach((l) => {
      const [wid, wname, cwd, cmd, left, top] = l.split('\t');
      let w = byId.get(wid);
      if (!w) { w = { name: wname, dir: cwd, panes: [], _prev: null }; byId.set(wid, w); wins.push(w); }
      const split = w._prev && Number(left) > w._prev.left ? 'h' : 'v';
      w.panes.push({ dir: cwd, cmd: shells.test(cmd) ? '' : cmd, split: w.panes.length ? split : 'h' });
      w._prev = { left: Number(left), top: Number(top) };
    });
    wins.forEach((w) => delete w._prev);
    res.json({ layout: { windows: wins } });
  }));

  app.post('/api/term/ensure', guard(async (req, res) => {
    const { rel, d } = fileFromReq(req);
    res.json(await ensure(rel, d));
  }));

  app.get('/api/term/status', guard(async (req, res) => {
    const files = terminalFiles().map((f) => Object.assign({ path: f.path, title: f.data.title, mode: f.data.mode, host: f.data.host, claude: f.data.claude, autoConnect: f.data.autoConnect, session: sessionOf(f.data, f.path), live: liveCount(f.path) }, status.get(f.path) || { state: 'unknown' }));
    res.json({ files });
  }));

  app.post('/api/term/kill', guard(async (req, res) => {
    const { d } = fileFromReq(req);
    const S = TerminalCore.cleanSession(req.body.session || '');
    if (!S) throw new Error('session is required');
    const r = await runScript(d, `tmux kill-session -t ${q('=' + S)}`);
    if (!r.ok) return res.status(502).json({ error: (d.mode === 'ssh' ? sshHint(r) : r.err) || 'Could not kill the session' });
    res.json({ ok: true });
  }));

  app.post('/api/term/rename', guard(async (req, res) => {
    const { d } = fileFromReq(req);
    const from = TerminalCore.cleanSession(req.body.from || '');
    const to = TerminalCore.cleanSession(req.body.to || '');
    if (!from || !to) throw new Error('from and to are required');
    const r = await runScript(d, `tmux rename-session -t ${q('=' + from)} ${q(to)}`);
    if (!r.ok) return res.status(502).json({ error: (d.mode === 'ssh' ? sshHint(r) : r.err) || 'Could not rename' });
    res.json({ ok: true, session: to });
  }));

  // Type text into the session's active pane (snippets, "Ask Claude", runbooks).
  async function sendText(rel, d, text, enter) {
    // An open pane is the most direct path (works with password-only SSH too).
    const live = [...conns].find((c) => c.rel === rel && c.term);
    if (live) {
      live.term.write(text + (enter ? '\r' : ''));
      return { ok: true, via: 'pane' };
    }
    const S = sessionOf(d, rel);
    const st = await ensure(rel, d);
    if (st.state === 'failed') throw new Error(st.error || 'Session unavailable');
    const r = await runScript(d, `tmux send-keys -t ${q('=' + S + ':')} -l ${q(text)}${enter ? ` && tmux send-keys -t ${q('=' + S + ':')} Enter` : ''}`);
    if (!r.ok) throw new Error((d.mode === 'ssh' ? sshHint(r) : r.err) || 'send failed');
    return { ok: true, via: 'tmux' };
  }
  app.post('/api/term/send', guard(async (req, res) => {
    const { rel, d } = fileFromReq(req);
    const text = String(req.body.text || '');
    if (!text) throw new Error('text is required');
    res.json(await sendText(rel, d, text.slice(0, 20000), req.body.enter !== false));
  }));

  app.get('/api/term/capture', guard(async (req, res) => {
    const { rel, d } = fileFromReq(req);
    const S = sessionOf(d, rel);
    const r = await runScript(d, `tmux capture-pane -p -J -t ${q('=' + S + ':')} -S -${Math.min(50000, Number(req.query.lines) || 3000)}`);
    if (!r.ok) return res.status(502).json({ error: (d.mode === 'ssh' ? sshHint(r) : r.err) || 'capture failed' });
    res.json({ text: r.out.replace(/\s+$/, '') });
  }));

  // ---------- runbook execution with output capture ----------
  // The command is wrapped in markers built at run time (so the typed line
  // itself never contains them); the pane is polled until the end marker.
  const runs = new Map();
  app.post('/api/term/run', guard(async (req, res) => {
    const { rel, d } = fileFromReq(req);
    if (d.claude) throw new Error('This terminal is Claude-only — pick a regular terminal for runbook commands.');
    const cmd = String(req.body.cmd || '').trim();
    if (!cmd) throw new Error('cmd is required');
    const id = crypto.randomBytes(5).toString('hex');
    const timeoutMs = Math.min(4 * 3600e3, Math.max(5000, Number(req.body.timeoutSec || 1800) * 1000));
    // One line, so nothing is typed ahead while the command runs (the shell
    // would echo it into the output). Multi-line commands go through eval.
    const clean = cmd.replace(/[;\s]+$/, '');
    // Comments, trailing & or several lines can't be inlined safely.
    const body = /\n|(^|\s)#|&$/.test(clean) ? `eval "$(printf %s ${q(Buffer.from(cmd).toString('base64'))} | base64 --decode)"` : clean;
    const wrapped = `printf '\\n__ACC_%s_%s__\\n' S ${id}; ${body}; printf '\\n__ACC_%s_%s__ %s\\n' E ${id} "$?"`;
    const run = { id, rel, state: 'running', output: '', exit: null, startedAt: Date.now(), endedAt: null, error: null };
    runs.set(id, run);
    setTimeout(() => runs.delete(id), 6 * 3600e3).unref();
    try { await sendText(rel, d, wrapped, true); } catch (err) { run.state = 'failed'; run.error = err.message; return res.json(run); }
    res.json(run);
    const S = sessionOf(d, rel);
    const start = `__ACC_S_${id}__`;
    const end = new RegExp(`__ACC_E_${id}__ (\\d+)`);
    const poll = async () => {
      if (run.state !== 'running') return;
      const r = await runScript(d, `tmux capture-pane -p -J -t ${q('=' + S + ':')} -S -20000`);
      if (r.ok) {
        const txt = r.out;
        const si = txt.lastIndexOf(start);
        if (si >= 0) {
          const after = txt.slice(si + start.length);
          const m = end.exec(after);
          run.output = (m ? after.slice(0, m.index) : after).replace(/^\s*\n/, '').replace(/\s+$/, '').slice(-200000);
          if (m) { run.exit = Number(m[1]); run.state = run.exit === 0 ? 'done' : 'failed'; run.endedAt = Date.now(); return; }
        }
      } else if (d.mode === 'ssh') {
        // No key-based SSH: we can't read the pane; the command was still sent.
        run.state = 'sent'; run.error = 'Output capture needs key-based SSH'; run.endedAt = Date.now(); return;
      }
      if (Date.now() - run.startedAt > timeoutMs) { run.state = 'timeout'; run.endedAt = Date.now(); return; }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 700);
  }));
  app.get('/api/term/run/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Unknown run' });
    res.json(run);
  });

  // "Open terminal here": a terminal file for a workspace folder.
  app.post('/api/term/quick', guard(async (req, res) => {
    const folder = String((req.body && req.body.folder) || '').replace(/^\/+|\/+$/g, '');
    const abs = folder ? resolveSafe(folder) : dataRoot();
    const base = TerminalCore.cleanSession(path.basename(abs)) || 'workspace';
    const data = TerminalCore.normalize({ title: 'Terminal · ' + (folder || 'workspace'), mode: 'local', session: base, dir: abs });
    let rel = `terminals/${base}.html`;
    for (let i = 2; fs.existsSync(resolveSafe(rel)); i++) rel = `terminals/${base}-${i}.html`;
    writeFileCommit(rel, TerminalCore.serializeToHtml(data), 'Create terminal ' + rel);
    res.json({ path: rel });
  }));

  // Open a workspace file or folder in Cursor.
  app.post('/api/open-in-cursor', (req, res) => {
    try {
      const rel = String((req.body && req.body.path) || '');
      const abs = rel ? resolveSafe(rel) : dataRoot();
      const fallback = () => {
        if (process.platform !== 'darwin') return res.status(400).json({ error: "Cursor's 'cursor' command isn't installed (in Cursor: Shell Command → Install 'cursor' command)" });
        execFile('open', ['-a', 'Cursor', abs], { env: ENV }, (err) => (err ? res.status(400).json({ error: 'Cursor is not installed' }) : res.json({ ok: true })));
      };
      execFile('cursor', [abs], { env: ENV, timeout: 15000 }, (err) => (err ? fallback() : res.json({ ok: true })));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- live panes over WebSocket ----------
  const tokens = new Map(); // token -> { rel, exp }
  app.post('/api/term/token', guard(async (req, res) => {
    const { rel } = fileFromReq(req);
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { rel, exp: Date.now() + 60000 });
    res.json({ token });
  }));
  setInterval(() => { const now = Date.now(); tokens.forEach((v, k) => { if (v.exp < now) tokens.delete(k); }); }, 60000).unref();

  const conns = new Set();
  const liveCount = (rel) => [...conns].filter((c) => c.rel === rel).length;
  let wss = null;

  function attach(server) {
    if (pty && WebSocketServer && !wss) wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/term') return; // not ours
      const refuse = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
      // Missing node-pty / ws: say so instead of leaving the request hanging.
      if (!wss) return refuse(503, 'Terminal support not installed');
      if (!enabled()) return refuse(403, 'Terminals off');
      const local = isLocalRequest(req);
      if (!local && !(remoteTerminalOk && remoteTerminalOk(req))) return refuse(403, 'Forbidden');
      const origin = req.headers.origin;
      try { if (!origin || new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return refuse(403, 'Bad origin'); } catch (e) { return refuse(403, 'Bad origin'); }
      const tok = tokens.get(url.searchParams.get('token') || '');
      tokens.delete(url.searchParams.get('token') || '');
      if (!tok || tok.exp < Date.now()) return refuse(401, 'Bad token');
      const who = local ? null : String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
      wss.handleUpgrade(req, socket, head, (ws) => openPane(ws, tok.rel, url.searchParams, who));
    });
  }

  function notifyRemote(who, rel) {
    console.log(`Terminal: ${rel} opened from network device ${who}`);
    if (process.platform !== 'darwin' || process.env.ACCRETION_NO_NATIVE_NOTIFY) return;
    const e = (x) => String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${e(rel)} was opened from ${e(who)}" with title "Accretion · terminal opened remotely" sound name "Submarine"`], () => {});
  }

  function openPane(ws, rel, params, who) {
    if (who) notifyRemote(who, rel);
    let d;
    try { d = readTerminalFile(rel); } catch (err) { ws.send(JSON.stringify({ t: 'exit', reason: 'file', message: err.message })); ws.close(); return; }
    const cols = Math.max(20, Math.min(500, Number(params.get('cols')) || 100));
    const rows = Math.max(5, Math.min(200, Number(params.get('rows')) || 30));
    const plain = params.get('plain') === '1';
    const override = TerminalCore.cleanSession(params.get('session') || '');
    if (override) d = Object.assign({}, d, { session: override });
    let file;
    let args;
    if (d.mode === 'ssh') {
      if (!d.host) { ws.send(JSON.stringify({ t: 'exit', reason: 'config', message: 'Set the SSH host for this terminal first.' })); ws.close(); return; }
      file = 'ssh';
      args = ['-t', ...sshArgs(d, false), d.host];
      if (!plain) args.push('exec "${SHELL:-/bin/sh}" -lc ' + q(ensureScript(d, rel, true)));
    } else if (plain) {
      file = d.shell || process.env.SHELL || '/bin/zsh';
      args = ['-l'];
    } else {
      file = '/bin/sh';
      args = ['-c', ensureScript(d, rel, true)];
    }
    let term;
    try {
      term = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: d.mode === 'ssh' ? os.homedir() : (fs.existsSync(localDir(d)) ? localDir(d) : os.homedir()), env: ENV });
    } catch (err) {
      ws.send(JSON.stringify({ t: 'exit', reason: 'spawn', message: err.message }));
      ws.close();
      return;
    }
    const conn = { ws, term, rel, startedAt: Date.now() };
    conns.add(conn);
    ws.send(JSON.stringify({ t: 'ready', session: sessionOf(d, rel), mode: d.mode, host: d.host, plain }));
    let pendingMark = '';
    term.onData((chunk) => {
      let s = pendingMark + chunk;
      pendingMark = '';
      // Strip our OSC markers and turn them into events.
      s = s.replace(/\x1b\]777;accretion;(\w+)\x07/g, (m, ev) => { try { ws.send(JSON.stringify({ t: 'event', ev })); } catch (e) { /* closed */ } return ''; });
      const cut = s.lastIndexOf('\x1b]777');
      if (cut >= 0 && s.indexOf('\x07', cut) < 0) { pendingMark = s.slice(cut); s = s.slice(0, cut); }
      // Output is binary; control messages are JSON text.
      if (s && ws.readyState === 1) ws.send(Buffer.from(s, 'utf8'), { binary: true });
    });
    term.onExit(({ exitCode, signal }) => {
      conns.delete(conn);
      const reason = d.mode === 'ssh' && exitCode === 255 ? 'ssh' : exitCode === 4 ? 'create' : 'exit';
      try { ws.send(JSON.stringify({ t: 'exit', code: exitCode, signal, reason })); ws.close(); } catch (e) { /* closed */ }
    });
    ws.on('message', (msg, isBinary) => {
      // Keystrokes arrive as binary; control messages as JSON text.
      if (isBinary) { term.write(msg.toString('utf8')); return; }
      try {
        const m = JSON.parse(String(msg));
        if (m.t === 'resize') term.resize(Math.max(20, Math.min(500, m.cols | 0)), Math.max(5, Math.min(200, m.rows | 0)));
        else if (m.t === 'in') term.write(String(m.d || ''));
      } catch (e) { /* ignore malformed control */ }
    });
    ws.on('close', () => {
      conns.delete(conn);
      // Detach only: tmux keeps the session (and Claude) running.
      try { term.kill(); } catch (e) { /* gone */ }
    });
  }

  // On quit (if asked): kill the tmux sessions of auto-connect terminal files.
  async function stopAutoSessions() {
    const files = terminalFiles().filter((f) => f.data.autoConnect);
    await Promise.all(files.map((f) => runScript(f.data, `tmux kill-session -t ${q('=' + sessionOf(f.data, f.path))} 2>/dev/null; true`, 8000)));
  }

  return { attach, terminalFiles, autoConnectAll, stopAutoSessions };
};
