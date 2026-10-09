const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const FlowCore = require(path.join(__dirname, 'public', 'flow', 'core.js'));
const KanbanCore = require(path.join(__dirname, 'public', 'kanban', 'core.js'));
const GanttCore = require(path.join(__dirname, 'public', 'gantt', 'core.js'));
const SlidesCore = require(path.join(__dirname, 'public', 'slides', 'core.js'));
const StocksCore = require(path.join(__dirname, 'public', 'stocks', 'core.js'));
const TerminalCore = require(path.join(__dirname, 'public', 'terminal', 'core.js'));
const RunbookCore = require(path.join(__dirname, 'public', 'runbook', 'core.js'));
const zlib = require('zlib');
const { execFile, execFileSync } = require('child_process');

const app = express();
// Always port 4321: bookmarks, the installed app window and other devices
// rely on a fixed address. The PORT env var is ignored on purpose.
const PORT = 4321;
if (process.env.PORT && Number(process.env.PORT) !== PORT) console.log(`(PORT=${process.env.PORT} ignored — Accretion always uses port ${PORT}.)`);
// --- Where the data lives. The app folder holds only code; the data folder
// (any directory) holds the files, their git history and the app's state
// for that workspace (<data>/.accretion/). Chosen by, in order: the
// DATA_DIR env var, ~/.accretion/config.json, or ../data next to the app.
const APP_CONFIG_DIR = path.join(require('os').homedir(), '.accretion');
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'config.json');
const DEFAULT_DATA_ROOT = path.resolve(__dirname, '..', 'data');
const STATE_DIR_NAME = '.accretion';
function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return require('os').homedir();
  if (s.startsWith('~/')) return path.join(require('os').homedir(), s.slice(2));
  return s;
}
function readAppConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf8'));
    return {
      dataDir: typeof c.dataDir === 'string' && c.dataDir ? c.dataDir : null,
      recent: Array.isArray(c.recent) ? c.recent.filter((x) => typeof x === 'string').slice(0, 10) : [],
      openAs: c.openAs === 'window' ? 'window' : c.openAs === 'browser' ? 'browser' : undefined,
      network: c.network && typeof c.network === 'object' ? c.network : undefined,
      terminal: c.terminal && typeof c.terminal === 'object' ? c.terminal : undefined,
      https: c.https && typeof c.https === 'object' ? c.https : undefined,
    };
  } catch (e) {
    return { dataDir: null, recent: [], openAs: undefined };
  }
}
function writeAppConfig(cfg) {
  fs.mkdirSync(APP_CONFIG_DIR, { recursive: true });
  writeJsonAtomic(APP_CONFIG_FILE, cfg);
}
const DATA_SOURCE = process.env.DATA_DIR ? 'env' : readAppConfig().dataDir ? 'config' : 'default';
let DATA_ROOT = path.resolve(expandHome(process.env.DATA_DIR || readAppConfig().dataDir || DEFAULT_DATA_ROOT));
fs.mkdirSync(DATA_ROOT, { recursive: true });

// Per-workspace state files live in <data>/.accretion/.
const stateFile = (name) => path.join(DATA_ROOT, STATE_DIR_NAME, name);
const LEGACY_STATE = ['favorites.json', 'todos.json', 'tags.json', 'ui-settings.json', 'daily.json', 'ideas.json'];
function prepareStateDir() {
  fs.mkdirSync(path.join(DATA_ROOT, STATE_DIR_NAME), { recursive: true });
  // One-time move of state that used to sit in the app folder.
  for (const name of LEGACY_STATE) {
    const old = path.join(__dirname, name);
    const dest = stateFile(name);
    try {
      if (fs.existsSync(old) && !fs.existsSync(dest)) {
        fs.copyFileSync(old, dest);
        fs.renameSync(old, old + '.migrated');
        console.log(`Moved ${name} into ${path.dirname(dest)}`);
      }
    } catch (e) {
      console.error('Could not move ' + name + ':', e.message);
    }
  }
}
prepareStateDir();
const tlsCerts = require('./tls.js')(APP_CONFIG_DIR);

// --literal-pathspecs: file names are names, never patterns like "*.md".
const GIT_ENV_ARGS = ['--literal-pathspecs', '-c', 'user.email=docviewer@local', '-c', 'user.name=JsonDocViewer'];
const GIT_TIMEOUT_MS = 8000;
let gitDisabled = false;

let gitBusy = false;
function git(args) {
  if (gitDisabled) throw new Error('git disabled');
  if (gitBusy) throw new Error('git busy');
  gitBusy = true;
  try {
    return execFileSync('git', [...GIT_ENV_ARGS, ...args], {
      cwd: DATA_ROOT,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    gitBusy = false;
  }
}

// Raw bytes from git (binary-safe, e.g. restoring an image).
function gitBuffer(args) {
  if (gitDisabled) throw new Error('git disabled');
  if (gitBusy) throw new Error('git busy');
  gitBusy = true;
  try {
    return execFileSync('git', [...GIT_ENV_ARGS, ...args], {
      cwd: DATA_ROOT,
      encoding: 'buffer',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
  } finally {
    gitBusy = false;
  }
}

// Commit ids from the client go into git arguments: only accept hex, so a
// value like "--output=/some/file" can't be read as a git option.
function checkHash(hash) {
  const h = String(hash || '');
  if (!/^[0-9a-f]{4,40}$/i.test(h)) throw new Error('Invalid commit id');
  return h;
}

// A folder we can't read is skipped instead of failing the whole request.
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

// Write JSON via a temp file + rename so a crash never leaves half a file.
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Stream a file to the response; read errors end the response instead of
// crashing the server.
function sendFileStream(full, res) {
  const stream = fs.createReadStream(full);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Could not read file' });
    else res.destroy(err);
  });
  stream.pipe(res);
}

function gitRepoOk() {
  try {
    // The repository must be the data folder itself, never a parent repo
    // that happens to contain it.
    if (!fs.existsSync(path.join(DATA_ROOT, '.git'))) return false;
    const top = execFileSync('git', [...GIT_ENV_ARGS, 'rev-parse', '--show-toplevel'], {
      cwd: DATA_ROOT,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return fs.realpathSync(top) === fs.realpathSync(DATA_ROOT);
  } catch (e) {
    return false;
  }
}

// The app's own state is not part of the file history.
function excludeStateFromGit() {
  try {
    const f = path.join(DATA_ROOT, '.git', 'info', 'exclude');
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('/' + STATE_DIR_NAME + '/')) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '/' + STATE_DIR_NAME + '/\n');
    }
  } catch (e) { /* best effort */ }
}

function initGitRepo() {
  try {
    if (gitRepoOk()) { excludeStateFromGit(); return; }
    const gitDir = path.join(DATA_ROOT, '.git');
    if (fs.existsSync(gitDir)) {
      // A leftover incomplete .git (e.g. interrupted init) makes every git
      // call fail and, without a timeout, can stall the whole HTTP server.
      // Only remove it when it is clearly broken — never a real history.
      if (fs.existsSync(path.join(gitDir, 'HEAD'))) throw new Error('existing .git in ' + DATA_ROOT + ' is not usable');
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
    git(['init']);
    excludeStateFromGit();
    try {
      git(['add', '-A']);
      git(['commit', '-m', 'Initial commit']);
    } catch (e) {
      // nothing to commit yet, that's fine
    }
  } catch (e) {
    gitDisabled = true;
    console.error('Git unavailable, history/commits disabled:', e.message);
  }
}

function knownToGit(relPath) {
  if (fs.existsSync(path.join(DATA_ROOT, relPath))) return true;
  if (gitDisabled) return false;
  try {
    git(['cat-file', '-e', `HEAD:${relPath}`]);
    return true;
  } catch (e) {
    return false; // never existed on disk and never committed - nothing for git to reference
  }
}

function commitFile(relPathOrPaths, message) {
  if (gitDisabled) return null;
  const allPaths = Array.isArray(relPathOrPaths) ? relPathOrPaths : [relPathOrPaths];
  // A path that no longer exists and was never committed (e.g. the "from"
  // side of a move of a file that was never saved to history) is not a
  // valid pathspec for `git add`/`git commit` and would make the whole
  // command error with "did not match any files" - drop those up front.
  const paths = allPaths.filter(knownToGit);
  if (paths.length === 0) return null;
  try {
    for (const p of paths) {
      try {
        git(['add', '--', p]);
      } catch (e) {
        // nothing to stage for this path
      }
    }
    const status = git(['status', '--porcelain', '--', ...paths]);
    if (!status.trim()) return null; // no changes, nothing to commit
    git(['commit', '-m', message, '--', ...paths]);
    return git(['log', '-1', '--pretty=%H']).trim();
  } catch (err) {
    console.error('Git commit failed:', err.message);
    return null;
  }
}

// --- Network access. By default only this computer can connect. With
// "Allow other devices" on (Settings, or HOST=0.0.0.0), the server listens
// on all interfaces and every device except this computer must sign in
// with a password. Settings that touch this computer (data folder, disk
// browsing, launch options, network) can only be changed from this computer.
const crypto = require('crypto');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function networkConfig() {
  const n = readAppConfig().network || {};
  return {
    enabled: !!n.enabled && !!n.passwordHash,
    passwordHash: n.passwordHash || null,
    salt: n.salt || null,
    secret: n.secret || null,
  };
}
function listenHost() {
  if (process.env.HOST) return process.env.HOST;
  return networkConfig().enabled ? '0.0.0.0' : '127.0.0.1';
}
const isLoopbackAddr = (a) => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));
// This computer: connection from loopback AND addressed to a loopback name
// (a DNS-rebinding page on this computer uses another Host, so it is not).
function isLocalRequest(req) {
  const hostname = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return isLoopbackAddr(req.socket.remoteAddress) && LOOPBACK_HOSTS.has(hostname);
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
const SESSION_DAYS = 30;
function sessionToken() {
  const { secret } = networkConfig();
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const mac = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  return exp + '.' + mac;
}
function validSession(req) {
  const { secret, enabled } = networkConfig();
  if (!enabled || !secret) return false;
  const m = /(?:^|;\s*)acc_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, mac] = decodeURIComponent(m[1]).split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
}
// Brute-force guard: 8 tries per 5 minutes per address.
const loginTries = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const list = (loginTries.get(ip) || []).filter((t) => now - t < 5 * 60000);
  loginTries.set(ip, list);
  return list.length >= 8;
}
const LOGIN_PAGE = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accretion · Sign in</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><style>
:root{--bg:#f3f5f8;--panel:#fff;--ink:#1c2330;--muted:#667085;--line:rgba(28,35,48,.14);--accent:#4f6ef7}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--panel:#171c26;--ink:#e8ecf3;--muted:#9aa3b2;--line:rgba(255,255,255,.14);--accent:#8aa8d4}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
form{width:min(360px,100%);padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.12);text-align:center}
img{width:72px;height:72px;border-radius:18px;margin-bottom:10px}h1{margin:0 0 4px;font-size:22px}p{margin:0 0 18px;color:var(--muted);font-size:13px}
input{width:100%;padding:10px 12px;font:inherit;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:inherit;margin-bottom:12px}
button{width:100%;padding:10px;font:inherit;font-weight:600;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}.err{color:#d64545;margin:-4px 0 12px;font-size:13px}
</style></head><body><form method="post" action="/login"><img src="/icon.svg" alt=""><h1>Accretion</h1><p>This workspace is shared on the network.<br>Enter the password to continue.</p>
${msg ? `<div class="err">${msg}</div>` : ''}<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required><button type="submit">Sign in</button></form></body></html>`;

// --- Built-in HTTPS mode (Settings → HTTPS): TLS on the same port 4321.
const httpsCfg = () => { const h = readAppConfig().https || {}; return { enabled: !!h.enabled, httpsOnly: h.httpsOnly !== false }; };
app.use((req, res, next) => {
  const h = httpsCfg();
  if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // Other devices must use https:// (this computer may keep using http://localhost).
  if (h.enabled && h.httpsOnly && !req.socket.encrypted && !isLocalRequest(req) && !isSecureRequest(req) && req.path !== '/accretion-ca.crt') {
    const host = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, '');
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(307, 'https://' + host + req.originalUrl);
    return res.status(403).json({ error: 'Use the https:// address' });
  }
  next();
});
// The CA certificate is public: new devices download it before signing in.
app.get('/accretion-ca.crt', (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="accretion-ca.crt"');
    res.send(tlsCerts.caPem());
  } catch (err) {
    res.status(500).type('text').send('Certificate not available: ' + err.message);
  }
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const net = networkConfig();
  if (!net.enabled) return res.redirect('/');
  const ip = req.socket.remoteAddress;
  if (tooManyTries(ip)) return res.status(429).type('html').send(LOGIN_PAGE('Too many attempts — wait a few minutes.'));
  const pw = String((req.body && req.body.password) || '');
  const got = Buffer.from(hashPassword(pw, net.salt), 'hex');
  const want = Buffer.from(net.passwordHash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    loginTries.get(ip).push(Date.now());
    console.log('Network sign-in failed from ' + ip);
    return res.status(401).type('html').send(LOGIN_PAGE('Wrong password.'));
  }
  loginTries.delete(ip);
  console.log('Network sign-in from ' + ip);
  res.setHeader('Set-Cookie', `acc_session=${encodeURIComponent(sessionToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isSecureRequest(req) ? '; Secure' : ''}`);
  res.redirect('/');
});
app.get('/login', (req, res) => {
  if (isLocalRequest(req) || validSession(req) || !networkConfig().enabled) return res.redirect('/');
  res.type('html').send(LOGIN_PAGE(''));
});
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'acc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.redirect('/login');
});

const LOCAL_ONLY = [/^\/api\/autostart/, /^\/api\/https/, /^\/api\/fs\//, /^\/api\/config\//, /^\/api\/open$/, /^\/api\/apps-manager$/, /^\/api\/network/, /^\/api\/open-in-cursor$/, /^\/api\/quit$/, /^\/api\/term\/(enabled|network)$/];

// Terminals over the network: opt-in (Settings, this computer only), for
// signed-in devices, and by default only over an encrypted connection —
// HTTPS terminated by a proxy on this computer (e.g. `tailscale serve`),
// whose forwarded-proto header is trusted only from loopback.
function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  return isLoopbackAddr(req.socket && req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}
function terminalNetworkConfig() {
  const t = readAppConfig().terminal || {};
  return { network: !!t.network, allowHttp: !!t.allowHttp };
}
function terminalsOverNetwork(req) {
  const t = terminalNetworkConfig();
  if (!t.network || !networkConfig().enabled) return false;
  return isSecureRequest(req) || t.allowHttp;
}
function terminalNetworkRefusal(req) {
  const t = terminalNetworkConfig();
  if (!t.network) return 'Terminals are only available on the computer running Accretion (turn on "Allow terminals over the network" there).';
  if (!isSecureRequest(req) && !t.allowHttp) return 'Terminals over the network need an encrypted (HTTPS) connection, e.g. through Tailscale Serve.';
  return 'Terminals are not available here.';
}
app.use((req, res, next) => {
  if (isLocalRequest(req)) return next();
  // Remote device (or a non-loopback Host): password required.
  if (!networkConfig().enabled) {
    if (!process.env.HOST) return res.status(403).json({ error: 'Forbidden host' });
    return res.status(403).type('text').send('Network access needs a password. On the computer running Accretion, open Settings and turn on "Allow other devices".');
  }
  if (req.path === '/login' || req.path === '/accretion-ca.crt' || /^\/(icon\.svg|icon-\d+\.png|manifest\.webmanifest)$/.test(req.path)) return next();
  if (!validSession(req)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
    return res.status(401).type('html').send(LOGIN_PAGE(''));
  }
  if (LOCAL_ONLY.some((re) => re.test(req.path))) return res.status(403).json({ error: 'Only available on the computer running Accretion' });
  if (req.path.startsWith('/api/term/') && !terminalsOverNetwork(req)) return res.status(403).json({ error: terminalNetworkRefusal(req) });
  next();
});

// Other websites must not be able to drive this API from the browser:
// state-changing requests must come from this app's own pages.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host.toLowerCase() === host; } catch (e) { ok = false; }
      if (!ok) return res.status(403).json({ error: 'Cross-site request blocked' });
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request blocked' });
    }
  }
  next();
});

app.use(express.json({ limit: '40mb' }));
// json() skips non-JSON types but still sets req.body = {} and does not
// consume the stream. A 400 then leaves the unread POST in the socket
// (Chrome Recv-Q megabytes, 6 connections stuck, CSS "pending").
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '40mb' }));
app.use((req, res, next) => {
  const drain = () => {
    if (!req.readableEnded) req.resume();
  };
  res.on('finish', drain);
  res.on('close', drain);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Path depends on the current data folder.
const FAVORITES_FILE_NAME = 'favorites.json';

function bookmarkId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeBookmarks(raw) {
  if (Array.isArray(raw)) {
    const id = 'c_default';
    return {
      categories: [{ id, name: 'Bookmarks', collapsed: false }],
      items: raw.filter((p) => typeof p === 'string' && p).map((path) => ({ path, categoryId: id })),
    };
  }
  const categories = Array.isArray(raw && raw.categories)
    ? raw.categories.filter((c) => c && c.id).map((c) => ({
      id: String(c.id),
      name: String(c.name || 'Untitled').trim() || 'Untitled',
      collapsed: !!c.collapsed,
    }))
    : [];
  const items = Array.isArray(raw && raw.items)
    ? raw.items.filter((it) => it && it.path).map((it) => ({
      path: String(it.path),
      categoryId: String(it.categoryId || ''),
    }))
    : [];
  return { categories, items };
}

// --- Calendar to-dos: { days: { "YYYY-MM-DD": [{ id, text, done }] } } ---
// Path depends on the current data folder.
const TODOS_FILE_NAME = 'todos.json';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function normalizeTodos(raw) {
  const days = {};
  const src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
  Object.keys(src).forEach((day) => {
    if (!DAY_KEY.test(day) || !Array.isArray(src[day])) return;
    const seen = new Set();
    const list = src[day]
      .filter((t) => t && typeof t === 'object' && typeof t.text === 'string' && t.text.trim())
      .slice(0, 500)
      .map((t) => {
        let id = typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id) ? t.id : 't_' + Math.random().toString(36).slice(2, 10);
        if (seen.has(id)) id = 't_' + Math.random().toString(36).slice(2, 10);
        seen.add(id);
        const item = { id, text: t.text.slice(0, 2000), done: !!t.done };
        // Reminder: time of day on that date, optional snooze, and whether it fired.
        if (typeof t.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) item.time = t.time;
        if (typeof t.snooze === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t.snooze)) item.snooze = t.snooze;
        if ((item.time || item.snooze) && t.fired) item.fired = true;
        // Repeating to-do: one stored item on its first day; per-day state
        // (done / skipped / reminder fired) is kept as lists of dates.
        if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(t.repeat)) {
          const dates = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && DAY_KEY.test(x)))].sort().slice(-1000) : []);
          item.repeat = t.repeat;
          item.done = false;
          delete item.fired;
          item.doneDates = dates(t.doneDates);
          item.exDates = dates(t.exDates);
          item.firedDates = dates(t.firedDates);
          if (typeof t.until === 'string' && DAY_KEY.test(t.until)) item.until = t.until;
        }
        return item;
      });
    if (list.length) days[day] = list;
  });
  const rev = Number.isInteger(raw && raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  return { version: 1, rev, days };
}

function readTodos() {
  try {
    return normalizeTodos(JSON.parse(fs.readFileSync(stateFile(TODOS_FILE_NAME), 'utf8')));
  } catch (e) {
    return { version: 1, rev: 0, days: {} };
  }
}

function writeTodos(store) {
  // Write to a temp file then rename, so a crash never leaves half a file.
  writeJsonAtomic(stateFile(TODOS_FILE_NAME), store);
}

function readBookmarks() {
  let text;
  try {
    text = fs.readFileSync(stateFile(FAVORITES_FILE_NAME), 'utf8');
  } catch (e) {
    return { categories: [], items: [] }; // no bookmarks yet
  }
  try {
    const raw = JSON.parse(text);
    const store = normalizeBookmarks(raw);
    if (Array.isArray(raw)) writeBookmarks(store);
    return store;
  } catch (e) {
    // Unreadable file: keep a copy instead of letting the next write wipe it.
    try { fs.copyFileSync(stateFile(FAVORITES_FILE_NAME), stateFile(FAVORITES_FILE_NAME) + '.corrupt-' + Date.now()); } catch (err) { /* ignore */ }
    return { categories: [], items: [] };
  }
}

function writeBookmarks(store) {
  writeJsonAtomic(stateFile(FAVORITES_FILE_NAME), store);
}

function bookmarksPayload(store) {
  return {
    categories: store.categories,
    items: store.items,
    favorites: store.items.map((it) => it.path),
  };
}

// --- File tags: { files: { "path": ["tag", …] } } in webapp/tags.json ---
// Path depends on the current data folder.
const TAGS_FILE_NAME = 'tags.json';
function cleanTag(t) {
  return String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_./-]/gu, '').slice(0, 40);
}
function readTags() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(stateFile(TAGS_FILE_NAME), 'utf8')); } catch (e) { return { files: {} }; }
  const files = {};
  const src = raw && raw.files && typeof raw.files === 'object' ? raw.files : {};
  Object.keys(src).forEach((p) => {
    if (!Array.isArray(src[p])) return;
    const seen = new Set();
    const tags = src[p].map(cleanTag).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 30);
    if (tags.length) files[p] = tags;
  });
  return { files };
}
function writeTags(store) {
  writeJsonAtomic(stateFile(TAGS_FILE_NAME), store);
}
function removeTagsUnder(relPath) {
  const store = readTags();
  let changed = false;
  Object.keys(store.files).forEach((p) => {
    if (p === relPath || p.startsWith(relPath + '/')) { delete store.files[p]; changed = true; }
  });
  if (changed) writeTags(store);
}
function rewriteTagPaths(from, to) {
  const store = readTags();
  let changed = false;
  Object.keys(store.files).forEach((p) => {
    let next = null;
    if (p === from) next = to;
    else if (p.startsWith(from + '/')) next = to + p.slice(from.length);
    if (next) { store.files[next] = store.files[p]; delete store.files[p]; changed = true; }
  });
  if (changed) writeTags(store);
}

function removeFavoritesUnder(relPath) {
  removeTagsUnder(relPath);
  const store = readBookmarks();
  const items = store.items.filter((it) => it.path !== relPath && !it.path.startsWith(relPath + '/'));
  if (items.length !== store.items.length) writeBookmarks({ ...store, items });
}

function rewriteBookmarkPaths(from, to) {
  rewriteTagPaths(from, to);
  const store = readBookmarks();
  let changed = false;
  const items = store.items.map((it) => {
    if (it.path === from) {
      changed = true;
      return { path: to, categoryId: it.categoryId };
    }
    if (it.path.startsWith(from + '/')) {
      changed = true;
      return { path: to + it.path.slice(from.length), categoryId: it.categoryId };
    }
    return it;
  });
  if (changed) writeBookmarks({ ...store, items });
}

// Resolve a relative path from the client against DATA_ROOT, refusing escapes.
function resolveSafe(relPath) {
  const rel = (relPath || '').replace(/^\/+/, '');
  const resolved = path.resolve(DATA_ROOT, rel);
  if (resolved !== DATA_ROOT && !resolved.startsWith(DATA_ROOT + path.sep)) {
    throw new Error('Path escapes data root');
  }
  return resolved;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime() {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const ent of entries) {
    const name = Buffer.from(String(ent.name || '').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(ent.data || '');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); // names are UTF-8
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// limits: { maxFiles, maxBytes } are enforced while inflating, so a small
// archive that expands to gigabytes is refused before it uses the memory.
function readZip(buf, limits) {
  const maxFiles = (limits && limits.maxFiles) || 1000;
  let budget = (limits && limits.maxBytes) || 200 * 1024 * 1024;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  const start = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = buf.readUInt16LE(cd + 10);
    const comp = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name = buf.slice(cd + 46, cd + 46 + nameLen).toString('utf8');
    cd += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('Bad zip entry');
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtra;
    const raw = buf.slice(dataStart, dataStart + comp);
    let data;
    if (out.length >= maxFiles) throw new Error('Too many files in the zip (limit ' + maxFiles + ')');
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
      } catch (e) {
        if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(e.message))) throw new Error('Zip contents are too large');
        throw e;
      }
    } else throw new Error('Unsupported zip compression in ' + name);
    budget -= data.length;
    if (budget < 0) throw new Error('Zip contents are too large');
    out.push({ name, data });
  }
  return out;
}

function listExportFiles(dir, prefix, out) {
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) listExportFiles(full, rel, out);
    else out.push({ name: rel.replace(/\\/g, '/'), data: fs.readFileSync(full) });
  }
  return out;
}

function safeDownloadName(name) {
  return String(name || 'download').replace(/["\\/]/g, '');
}

const transientDownloads = new Map();
const TRANSIENT_MAX = 8;
const TRANSIENT_TTL_MS = 120000;

function pruneTransientDownloads() {
  const now = Date.now();
  for (const [id, item] of transientDownloads) {
    if (!item || now - item.at > TRANSIENT_TTL_MS) transientDownloads.delete(id);
  }
  while (transientDownloads.size > TRANSIENT_MAX) {
    const first = transientDownloads.keys().next().value;
    if (first == null) break;
    transientDownloads.delete(first);
  }
}

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
};

function imageTypeFor(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && IMAGE_TYPES[m[1].toLowerCase()]) || null;
}

function contentTypeFor(name) {
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (imageTypeFor(name)) return imageTypeFor(name);
  if (/\.html?$/i.test(name)) return 'text/html; charset=utf-8';
  if (/\.json$/i.test(name)) return 'application/json; charset=utf-8';
  if (/\.ya?ml$/i.test(name)) return 'text/yaml; charset=utf-8';
  if (/\.zip$/i.test(name)) return 'application/zip';
  return 'application/octet-stream';
}

// Any file type may be imported. Dotfiles are refused because the tree
// hides them, so they would land on disk invisibly.
function allowedShareName(name) {
  const base = path.posix.basename(String(name || ''));
  return !!base && !base.startsWith('.');
}

function safeMemberName(name) {
  const norm = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || /(^|\/)\./.test(norm)) return '';
  if (norm.startsWith('__MACOSX/')) return '';
  return norm;
}

function uniqueRelPath(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel) throw new Error('Invalid path');
  if (!fs.existsSync(resolveSafe(rel))) return rel;
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 2; n < 500; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!fs.existsSync(resolveSafe(next))) return next;
  }
  throw new Error('Could not find a free filename');
}

function joinDest(dest, name) {
  const left = String(dest || '').replace(/^\/+|\/+$/g, '');
  const right = String(name || '').replace(/^\/+/, '');
  return left ? left + '/' + right : right;
}

function isJsonYaml(name) {
  return /\.(json|yaml|yml)$/i.test(name);
}

function isLikelyBinary(fullPath) {
  try {
    const fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.slice(0, bytesRead).includes(0);
  } catch (e) {
    return true;
  }
}

function peekFileKind(full, name) {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (!/\.html?$/i.test(name)) return undefined;
  try {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(400);
    const n = fs.readSync(fd, buf, 0, 400, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    if (head.includes('data-docviewer="mindmap"')) return 'mindmap';
    if (head.includes('data-docviewer="flow"')) return 'flow';
    if (head.includes('data-docviewer="kanban"')) return 'kanban';
    if (head.includes('data-docviewer="gantt"')) return 'gantt';
    if (head.includes('data-docviewer="slides"')) return 'slides';
    if (head.includes('data-docviewer="stocks"')) return 'stocks';
    if (head.includes('data-docviewer="terminal"')) return 'terminal';
    if (head.includes('data-docviewer="runbook"')) return 'runbook';
  } catch (e) {
    return undefined;
  }
  return undefined;
}

function buildTree(dir) {
  const entries = safeReaddir(dir);
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(DATA_ROOT, full);
    if (entry.isDirectory()) {
      children.push({ type: 'dir', name: entry.name, path: rel, children: buildTree(full) });
    } else {
      const node = { type: 'file', name: entry.name, path: rel };
      const kind = peekFileKind(full, entry.name);
      if (kind) node.kind = kind;
      children.push(node);
    }
  }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

// --- UI settings (e.g. sidebar width), kept on disk so they survive the
// server falling back to a random port, which gives the browser a fresh origin.
// Path depends on the current data folder.
const UI_SETTINGS_FILE_NAME = 'ui-settings.json';

function readUiSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(UI_SETTINGS_FILE_NAME), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

app.get('/api/ui-settings', (req, res) => {
  res.json(readUiSettings());
});

app.post('/api/ui-settings', (req, res) => {
  try {
    const next = readUiSettings();
    const width = Number(req.body && req.body.sidebarWidth);
    if (Number.isFinite(width) && width > 0 && width < 10000) next.sidebarWidth = Math.round(width);
    const theme = req.body && req.body.theme;
    if (theme === 'light' || theme === 'dark') next.theme = theme;
    const collapsed = req.body && req.body.sidebarCollapsed;
    if (typeof collapsed === 'boolean') next.sidebarCollapsed = collapsed;
    if (req.body && 'lastFile' in req.body) {
      const lf = req.body.lastFile;
      if (lf === null || lf === '') delete next.lastFile;
      else if (typeof lf === 'string') { resolveSafe(lf); next.lastFile = lf; }
    }
    writeJsonAtomic(stateFile(UI_SETTINGS_FILE_NAME), next);
    res.json(next);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tree', (req, res) => {
  try {
    res.json({ root: 'data', rootPath: DATA_ROOT, children: buildTree(DATA_ROOT) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Live sync: detect files/folders created or removed outside the app ---
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 15000\n\n');
  sseClients.add(res);
  const idle = setTimeout(() => {
    sseClients.delete(res);
    try { res.end(); } catch (e) { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    clearTimeout(idle);
    sseClients.delete(res);
  });
});

setInterval(() => {
  for (const client of [...sseClients]) {
    try {
      client.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 15000).unref();

let fsRev = 1;

function broadcastRefresh() {
  fsRev += 1;
  for (const client of [...sseClients]) {
    try {
      client.write('data: refresh\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

app.get('/api/changes', (req, res) => {
  res.json({ rev: fsRev });
});

function listAllFiles(dir, out) {
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listAllFiles(full, out);
    } else {
      out.push(path.relative(DATA_ROOT, full));
    }
  }
  return out;
}

let knownFiles = new Set(listAllFiles(DATA_ROOT, []));
let watchDebounce = null;
const writingFiles = new Set();

function reconcileWatchedFiles() {
  const current = new Set(listAllFiles(DATA_ROOT, []));
  const added = [...current].filter((p) => !knownFiles.has(p));
  const removed = [...knownFiles].filter((p) => !current.has(p));
  knownFiles = current;
  for (const p of removed) removeFavoritesUnder(p);
  if (added.length || removed.length) broadcastRefresh();
}

let dataWatcher = null;
function startWatcher() {
try {
  if (dataWatcher) dataWatcher.close();
  dataWatcher = fs.watch(DATA_ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.some((part) => part === '.git' || part === STATE_DIR_NAME)) return;
    const rel = parts.join('/');
    if (writingFiles.has(rel) || writingFiles.has(filename)) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(reconcileWatchedFiles, 800);
  });
} catch (err) {
  console.error('File watching unavailable on this platform:', err.message);
}
}
startWatcher();

// --- Data folder settings
function dataFolderInfo() {
  const cfg = readAppConfig();
  return { openAs: readAppConfig().openAs === 'window' ? 'window' : 'browser', windowAvailable: !!findAppBrowser(), installedApp: findInstalledWebApp(), dataDir: DATA_ROOT, source: process.env.DATA_DIR ? 'env' : DATA_SOURCE === 'env' ? 'env' : cfg.dataDir ? 'config' : 'default', recent: cfg.recent.filter((r) => r !== DATA_ROOT), defaultDir: DEFAULT_DATA_ROOT, configFile: APP_CONFIG_FILE, gitEnabled: !gitDisabled };
}
app.get('/api/config', (req, res) => res.json(dataFolderInfo()));

// --- Network access settings (this computer only; see LOCAL_ONLY).
function lanUrls(port) {
  const out = [];
  const ifs = require('os').networkInterfaces();
  for (const [name, list] of Object.entries(ifs)) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}
function networkInfo() {
  const n = networkConfig();
  const port = currentPort || PORT;
  return {
    enabled: n.enabled,
    hasPassword: !!n.passwordHash,
    listening: listenHost(),
    envHost: process.env.HOST || null,
    port,
    urls: lanUrls(port),
  };
}
function httpsUrls(port) {
  const n = tlsCerts.names();
  return ['https://localhost:' + port]
    .concat(n.dns.filter((d) => d.endsWith('.local')).map((d) => `https://${d}:${port}`))
    .concat(n.ips.filter((ip) => !/^127\./.test(ip) && !ip.includes(':')).map((ip) => `https://${ip}:${port}`));
}
function httpsInfo() {
  const h = httpsCfg();
  const port = currentPort || PORT;
  let cert = null;
  try { const m = JSON.parse(fs.readFileSync(path.join(tlsCerts.dir, 'server.json'), 'utf8')); cert = { expires: m.expires, names: m.names }; } catch (e) { /* none yet */ }
  let openssl = true;
  try { require('child_process').execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 3000 }); } catch (e) { openssl = false; }
  return {
    enabled: h.enabled,
    running: !!httpsSrv,
    httpsOnly: h.httpsOnly,
    openssl,
    urls: httpsUrls(port),
    network: networkConfig().enabled,
    hasPassword: !!networkConfig().passwordHash,
    cert,
    fingerprint: fs.existsSync(tlsCerts.caPath) ? tlsCerts.caFingerprint() : '',
    trustedHere: httpsSrv ? tlsCerts.trustedOnThisMac() : null,
    caUrl: '/accretion-ca.crt',
  };
}
function setHttps(patch) {
  const cfg = readAppConfig();
  const h = Object.assign({}, cfg.https || {}, patch);
  writeAppConfig(Object.assign({}, cfg, { https: h }));
  if (h.enabled) {
    // Create / refresh certificates now, so errors surface here.
    try { buildHttps(); } catch (err) {
      writeAppConfig(Object.assign({}, readAppConfig(), { https: Object.assign({}, h, { enabled: false }) }));
      httpsSrv = null;
      throw new Error('Could not create HTTPS certificates: ' + err.message + ' (is openssl installed?)');
    }
  } else {
    httpsSrv = null; // new TLS handshakes are refused from now on
  }
  console.log('HTTPS mode: ' + (h.enabled ? 'ON' + (h.httpsOnly === false ? ' (plain http still allowed)' : ' (other devices: https only)') : 'off'));
}
app.get('/api/https', (req, res) => res.json(httpsInfo()));
app.post('/api/https', (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.httpsOnly === 'boolean') patch.httpsOnly = body.httpsOnly;
    setHttps(patch);
    res.json(httpsInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Trust Accretion's CA on this Mac (macOS asks for your password).
app.post('/api/https/trust-mac', (req, res) => {
  if (process.platform !== 'darwin') return res.status(400).json({ error: 'Only on macOS' });
  const kc = path.join(require('os').homedir(), 'Library/Keychains/login.keychain-db');
  require('child_process').execFile('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', kc, tlsCerts.caPath], { timeout: 120000 }, (err, out, errOut) => {
    if (err) return res.status(400).json({ error: String(errOut || err.message).trim() || 'Not trusted' });
    res.json(httpsInfo());
  });
});

// --- Start at login (macOS LaunchAgent). Runs ./run.sh --no-open when you log
// in; a crash is restarted, but Quit (exit 0) stays quit until the next login
// or launch. ~/Library/LaunchAgents/local.accretion.server.plist
const AGENT_LABEL = 'local.accretion.server';
const AGENT_PLIST = path.join(require('os').homedir(), 'Library', 'LaunchAgents', AGENT_LABEL + '.plist');
function agentPlist() {
  const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const log = path.join(APP_CONFIG_DIR, 'server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-lc</string><string>cd ${xml(JSON.stringify(__dirname))} &amp;&amp; exec ./run.sh --no-open</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
function autostartInfo() {
  if (process.platform !== 'darwin') return { supported: false, enabled: false };
  return { supported: true, enabled: fs.existsSync(AGENT_PLIST), plist: AGENT_PLIST, underLaunchd: !!process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME === AGENT_LABEL };
}
app.get('/api/autostart', (req, res) => res.json(autostartInfo()));
app.post('/api/autostart', (req, res) => {
  if (process.platform !== 'darwin') return res.status(400).json({ error: 'Start at login is available on macOS (on Linux use a systemd user service).' });
  const on = !!(req.body && req.body.enabled);
  const uid = process.getuid();
  const { execFile } = require('child_process');
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
      fs.writeFileSync(AGENT_PLIST, agentPlist());
      // Register for future logins. This running server keeps serving now;
      // the agent's own start sees port 4321 in use by Accretion and exits.
      execFile('launchctl', ['bootstrap', 'gui/' + uid, AGENT_PLIST], () => {
        console.log('Start at login: on (' + AGENT_PLIST + ')');
        res.json(autostartInfo());
      });
    } else {
      // Remove the plist and answer first: if this server was started by the
      // agent, bootout stops it too (Accretion.app / run.sh start it again).
      const was = autostartInfo().underLaunchd;
      try { fs.unlinkSync(AGENT_PLIST); } catch (e) { /* already gone */ }
      console.log('Start at login: off');
      res.json(Object.assign(autostartInfo(), { stopping: was }));
      setTimeout(() => execFile('launchctl', ['bootout', 'gui/' + uid + '/' + AGENT_LABEL], () => {}), 400);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network', (req, res) => res.json(networkInfo()));
app.post('/api/network', (req, res) => {
  try {
    if (process.env.HOST) return res.status(400).json({ error: 'Network access is set by the HOST environment variable; unset it to manage it here.' });
    const body = req.body || {};
    const cfg = readAppConfig();
    const net = Object.assign({}, cfg.network || {});
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
      net.salt = crypto.randomBytes(16).toString('hex');
      net.passwordHash = hashPassword(body.password, net.salt);
      // New password signs every device out.
      net.secret = crypto.randomBytes(32).toString('hex');
    }
    if (body.signOutAll) net.secret = crypto.randomBytes(32).toString('hex');
    if (typeof body.enabled === 'boolean') {
      if (body.enabled && !net.passwordHash) return res.status(400).json({ error: 'Set a password first.' });
      net.enabled = body.enabled;
    }
    if (!net.secret) net.secret = crypto.randomBytes(32).toString('hex');
    const before = listenHost();
    writeAppConfig(Object.assign({}, cfg, { network: net }));
    const after = listenHost();
    res.json(networkInfo());
    // Rebind on the new address (all interfaces vs this computer only).
    if (before !== after && currentServer) {
      const port = currentPort;
      setTimeout(() => {
        relistening = true;
        const old = currentServer;
        old.close(() => listenOn(port));
        if (old.closeAll) old.closeAll();
      }, 150);
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Quit: stop this server process (this computer only). tmux sessions are
// separate processes and keep running unless asked to stop Accretion's.
app.post('/api/quit', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Only available on the computer running Accretion' });
  const killSessions = !!(req.body && req.body.killSessions);
  res.json({ ok: true });
  console.log('Quit requested from the app — stopping Accretion.');
  setTimeout(async () => {
    try { if (killSessions && terminals.stopAutoSessions) await terminals.stopAutoSessions(); } catch (e) { /* best effort */ }
    try { if (currentServer) { currentServer.close(); if (currentServer.closeAll) currentServer.closeAll(); } } catch (e) { /* closing anyway */ }
    setTimeout(() => process.exit(0), 300).unref();
  }, 200);
});

// Open the UI again as a window or a browser tab (from inside the app).
app.post('/api/open', (req, res) => {
  const mode = req.body && req.body.as;
  if (!['window', 'browser'].includes(mode)) return res.status(400).json({ error: 'as must be window or browser' });
  if (mode === 'window' && !findAppBrowser()) return res.status(400).json({ error: 'Opening as a window needs Google Chrome, Microsoft Edge or Brave installed.' });
  openUi(localUrl(), mode);
  res.json({ ok: true });
});

// Open Chrome's app manager (chrome://apps) in the profile Accretion's window
// uses, so the installed Accretion app can be removed or reinstalled there.
app.post('/api/apps-manager', (req, res) => {
  const exe = findAppBrowser();
  if (!exe) return res.status(400).json({ error: 'Chrome / Edge / Brave not found' });
  const which = (req.body && req.body.profile) === 'default' ? null : path.join(APP_CONFIG_DIR, 'window-profile');
  const url = /edge/i.test(exe) ? 'edge://apps' : /brave/i.test(exe) ? 'brave://apps' : 'chrome://apps';
  const args = [...(which ? ['--user-data-dir=' + which] : []), '--no-first-run', '--no-default-browser-check', url];
  const child = require('child_process').spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  res.json({ ok: true, url });
});

// Remember how the app opens on start.
app.post('/api/config/open-as', (req, res) => {
  const mode = req.body && req.body.openAs;
  if (!['window', 'browser'].includes(mode)) return res.status(400).json({ error: 'openAs must be window or browser' });
  const cfg = readAppConfig();
  writeAppConfig(Object.assign({}, cfg, { openAs: mode }));
  res.json(dataFolderInfo());
});

// Switch to another data folder (created if asked) and remember it.
app.post('/api/config/data-dir', (req, res) => {
  try {
    if (process.env.DATA_DIR) return res.status(400).json({ error: 'The data folder is set by the DATA_DIR environment variable; unset it to choose here.' });
    const raw = expandHome((req.body && req.body.path) || '');
    if (!raw || !path.isAbsolute(raw)) return res.status(400).json({ error: 'Enter a full path, e.g. /Users/me/Ideas or ~/Ideas' });
    const target = path.resolve(raw);
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'That path is a file, not a folder' });
    if (!fs.existsSync(target)) {
      if (!(req.body && req.body.create)) return res.status(404).json({ error: 'Folder does not exist', missing: true });
      fs.mkdirSync(target, { recursive: true });
    }
    // The app's own folder is not a data folder.
    const appDir = path.resolve(__dirname);
    if (target === appDir || target.startsWith(appDir + path.sep)) return res.status(400).json({ error: 'Choose a folder outside the app folder' });
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    const cfg = readAppConfig();
    const recent = [DATA_ROOT, ...cfg.recent].filter((r, i, a) => r !== target && a.indexOf(r) === i).slice(0, 10);
    writeAppConfig(Object.assign({}, cfg, { dataDir: target, recent }));
    switchDataRoot(target);
    res.json(dataFolderInfo());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Folder browser for choosing a data folder (the page can't read real
// paths from the browser's own picker). Lists sub-folders only.
app.get('/api/fs/list', (req, res) => {
  try {
    const os = require('os');
    const home = os.homedir();
    const dir = path.resolve(expandHome(req.query.path || '') || home);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).json({ error: 'Not a folder: ' + dir });
    const showHidden = req.query.hidden === '1';
    const appDir = path.resolve(__dirname);
    const dirs = safeReaddir(dir)
      .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (x) { return false; } })()))
        && (showHidden || !e.name.startsWith('.')))
      .map((e) => {
        const full = path.join(dir, e.name);
        return { name: e.name, path: full, isGit: fs.existsSync(path.join(full, '.git')), isWorkspace: fs.existsSync(path.join(full, STATE_DIR_NAME)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    let writable = true;
    try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) { writable = false; }
    const places = [
      { name: 'Home', path: home },
      ...['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs', 'Dropbox', 'OneDrive']
        .map((n) => ({ name: n.includes('CloudDocs') ? 'iCloud Drive' : n, path: path.join(home, n) }))
        .filter((pl) => fs.existsSync(pl.path)),
      ...(process.platform === 'darwin' && fs.existsSync('/Volumes') ? [{ name: 'Volumes', path: '/Volumes' }] : []),
      { name: process.platform === 'win32' ? path.parse(dir).root : 'Computer (/)', path: path.parse(dir).root },
    ];
    const parent = path.dirname(dir);
    res.json({
      path: dir,
      parent: parent !== dir ? parent : null,
      sep: path.sep,
      writable,
      isAppFolder: dir === appDir || dir.startsWith(appDir + path.sep),
      isWorkspace: fs.existsSync(path.join(dir, STATE_DIR_NAME)),
      isGit: fs.existsSync(path.join(dir, '.git')),
      dirs: dirs.slice(0, 2000),
      places,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/fs/mkdir', (req, res) => {
  try {
    const parent = path.resolve(expandHome((req.body && req.body.parent) || ''));
    const name = String((req.body && req.body.name) || '').trim();
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return res.status(400).json({ error: 'Enter a folder name without slashes' });
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return res.status(404).json({ error: 'Parent folder not found' });
    const full = path.join(parent, name);
    if (fs.existsSync(full)) return res.status(400).json({ error: 'Already exists: ' + name });
    fs.mkdirSync(full);
    res.json({ path: full });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function switchDataRoot(target) {
  DATA_ROOT = target;
  prepareStateDir();
  knownFiles = new Set(listAllFiles(DATA_ROOT, []));
  startWatcher();
  gitDisabled = false;
  initGitRepo();
  console.log(`Serving files from: ${DATA_ROOT}`);
  broadcastRefresh();
}

app.post('/api/folder', (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    if (fs.existsSync(full)) {
      return res.status(400).json({ error: 'A file or folder already exists at that path' });
    }
    fs.mkdirSync(full, { recursive: true });
    // Git doesn't track empty directories, so drop a placeholder to commit the folder itself.
    fs.writeFileSync(path.join(full, '.gitkeep'), '');
    const commit = commitFile(relPath, `Create folder ${relPath}`);
    res.json({ ok: true, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function defaultContentFor(relPath, kind, template) {
  if (kind === 'mindmap') return mindmapTemplate();
  if (kind === 'flow') return flowTemplate();
  if (kind === 'kanban') return kanbanTemplate(template);
  if (kind === 'gantt') return ganttTemplate();
  if (kind === 'slides') return SlidesCore.serializeToHtml(SlidesCore.createStarter());
  if (kind === 'stocks') return StocksCore.serializeToHtml(StocksCore.createStarter());
  if (kind === 'terminal') return TerminalCore.serializeToHtml(TerminalCore.createStarter(template || 'local'), path.posix.basename(relPath).replace(/\.html?$/i, ''));
  if (kind === 'runbook') return RunbookCore.serializeToHtml(RunbookCore.createStarter(template || 'blank'), path.posix.basename(relPath).replace(/\.html?$/i, ''));
  if (/\.json$/i.test(relPath)) return '{}\n';
  if (/\.(yaml|yml)$/i.test(relPath)) return '';
  // New Mermaid files start with a small example diagram.
  if (/\.(mmd|mermaid)$/i.test(relPath)) {
    return 'flowchart LR\n  client[Client] --> gw[API Gateway]\n  gw --> svc[Service]\n  svc --> db[(Database)]\n';
  }
  // New markdown files start with a heading named after the file.
  if (/\.(md|markdown)$/i.test(relPath)) {
    const title = path.posix.basename(relPath).replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim();
    return '# ' + (title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Notes') + '\n\n';
  }
  return '';
}

function mindmapTemplate() {
  const id = 'n_root';
  const bases = [210, 198, 168, 148, 38, 22, 350, 328, 268, 186, 16, 250];
  let hue = bases[Math.floor(Math.random() * bases.length)] + Math.floor(Math.random() * 18) - 9;
  hue = ((hue % 360) + 360) % 360;
  let sat = 36 + Math.floor(Math.random() * 14);
  let lit = 76 + Math.floor(Math.random() * 7);
  if (hue >= 28 && hue <= 70) {
    sat = 30 + Math.floor(Math.random() * 10);
    lit = 80 + Math.floor(Math.random() * 5);
  }
  const s = sat / 100;
  const l = lit / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  const fill = '#' + f(0) + f(8) + f(4);
  const data = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    rootIds: [id],
    nodes: {
      [id]: {
        id,
        parentId: null,
        dir: null,
        type: 'text',
        content: '',
        label: '',
        language: 'auto',
        style: { fill, border: fill, textColor: '#1a2130', linkColor: '#8AA8D4', linkWidth: 2.5, fillColorManual: true },
        format: { bold: true, italic: false, underline: false, fontSize: 18, align: 'center' },
        collapsedDirs: { left: false, right: false, up: false, down: false },
        w: 160,
        h: 52,
        x: 0,
        y: 0,
        userSized: false,
      },
    },
    frames: [],
  };
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>\n<html lang="en" data-docviewer="mindmap">\n<head><meta charset="UTF-8"><title>Mindmap</title></head>\n<body>\n<script type="application/json" id="mindmap-data">\n${json}\n</script>\n</body>\n</html>\n`;
}

function flowTemplate() {
  return FlowCore.serializeToHtml(FlowCore.createStarter(), 'Flow');
}

function kanbanTemplate(template) {
  const data = template ? KanbanCore.buildTemplate(template) : KanbanCore.createStarter();
  return KanbanCore.serializeToHtml(data, data.title || 'Kanban');
}

function ganttTemplate() {
  const data = GanttCore.createStarter();
  return GanttCore.serializeToHtml(data, data.title || 'Gantt');
}

// --- Templates: built-in starters for every file type, plus the user's own
// files in a workspace folder named "templates/". Placeholders in text
// templates: {{title}} {{date}} {{weekday}} {{week}}.
const USER_TEMPLATES_DIR = 'templates';
const MD = (lines) => lines.join('\n') + '\n';
const BUILTIN_TEMPLATES = [
  { id: 'md-meeting', kind: 'markdown', ext: '.md', name: 'Meeting notes', description: 'Agenda, notes, decisions and action items.',
    build: () => MD(['# {{title}}', '', '**Date:** {{weekday}}, {{date}}  ', '**Attendees:** ', '', '## Agenda', '', '- ', '', '## Notes', '', '', '## Decisions', '', '- ', '', '## Action items', '', '- [ ] Owner — task — due date']) },
  { id: 'md-standup', kind: 'markdown', ext: '.md', name: 'Daily standup', description: 'Yesterday, today and blockers.',
    build: () => MD(['# Standup — {{weekday}}, {{date}}', '', '## Yesterday', '', '- ', '', '## Today', '', '- ', '', '## Blockers', '', '- None']) },
  { id: 'md-design', kind: 'markdown', ext: '.md', name: 'Design review', description: 'Context, goals, proposal, alternatives, risks.',
    build: () => MD(['# {{title}}', '', '_Status: draft · {{date}}_', '', '## Context', '', '## Goals', '', '- ', '', '## Non-goals', '', '- ', '', '## Proposal', '', '## Alternatives considered', '', '| Option | Pros | Cons |', '| --- | --- | --- |', '|   |   |   |', '', '## Risks', '', '- ', '', '## Open questions', '', '- [ ] ']) },
  { id: 'md-incident', kind: 'markdown', ext: '.md', name: 'Incident report', description: 'Summary, impact, timeline, root cause, follow-ups.',
    build: () => MD(['# Incident: {{title}}', '', '**Date:** {{date}} · **Severity:** SEV-? · **Status:** investigating', '', '## Summary', '', '## Impact', '', '- Who / what was affected:', '- Duration:', '', '## Timeline', '', '| Time | Event |', '| --- | --- |', '|   |   |', '', '## Root cause', '', '## Resolution', '', '## Follow-ups', '', '- [ ] ']) },
  { id: 'md-change', kind: 'markdown', ext: '.md', name: 'Network change plan', description: 'Devices, pre-checks, steps, verification, rollback.',
    build: () => MD(['# Change: {{title}}', '', '**Window:** {{date}} · **Owner:** · **Ticket:**', '', '## Summary', '', '## Devices', '', '| Device | Role | Mgmt IP |', '| --- | --- | --- |', '|   |   |   |', '', '## Pre-checks', '', '- [ ] Backups taken', '- [ ] BGP sessions up', '- [ ] Interfaces / LLDP verified', '', '## Steps', '', '1. ', '', '## Verification', '', '- [ ] ', '', '## Rollback', '', '1. ']) },
  { id: 'md-weekly', kind: 'markdown', ext: '.md', name: 'Weekly report', description: 'Highlights, progress, next week, risks.',
    build: () => MD(['# Weekly report — week {{week}}', '', '_{{date}}_', '', '## Highlights', '', '- ', '', '## Progress', '', '- ', '', '## Next week', '', '- ', '', '## Risks / help needed', '', '- ']) },
  { id: 'md-readme', kind: 'markdown', ext: '.md', name: 'Project README', description: 'Overview, setup, usage, links.',
    build: () => MD(['# {{title}}', '', 'One-line description.', '', '## Overview', '', '## Setup', '', '```bash', '', '```', '', '## Usage', '', '## Links', '', '- ']) },
  { id: 'slides-review', kind: 'slides', ext: '.html', name: 'Design review deck', description: 'Title, agenda, problem, proposal, risks, next steps.',
    build: (c) => SlidesCore.serializeToHtml({ title: c.title, theme: 'light', slides: [
      SlidesCore.createSlide('title', { title: c.title, subtitle: 'Design review · ' + c.date }),
      SlidesCore.createSlide('bullets', { title: 'Agenda', body: 'Problem\nProposal\nAlternatives\nRisks\nNext steps' }),
      SlidesCore.createSlide('title-visual', { title: 'Problem' }),
      SlidesCore.createSlide('visual-text', { title: 'Proposal', body: 'Key idea\nHow it works\nWhat changes' }),
      SlidesCore.createSlide('two-columns', { title: 'Alternatives', body: 'Option A\nPros / cons', body2: 'Option B\nPros / cons' }),
      SlidesCore.createSlide('bullets', { title: 'Risks', body: 'Risk 1 — mitigation\nRisk 2 — mitigation' }),
      SlidesCore.createSlide('bullets', { title: 'Next steps', body: 'Decision needed\nOwners\nTimeline' }),
    ] }) },
  { id: 'slides-status', kind: 'slides', ext: '.html', name: 'Status update deck', description: 'Summary number, progress, plan, risks.',
    build: (c) => SlidesCore.serializeToHtml({ title: c.title, theme: 'light', slides: [
      SlidesCore.createSlide('title', { title: c.title, subtitle: 'Status update · ' + c.date }),
      SlidesCore.createSlide('big-number', { title: '80%', subtitle: 'Milestone progress', body: 'On track for the next release' }),
      SlidesCore.createSlide('title-visual', { title: 'Plan' }),
      SlidesCore.createSlide('two-columns', { title: 'Done / next', body: 'Done item\nDone item', body2: 'Next item\nNext item' }),
      SlidesCore.createSlide('bullets', { title: 'Risks & asks', body: 'Risk\nAsk' }),
    ] }) },
  { id: 'kanban-sprint', kind: 'kanban', ext: '.html', name: 'Sprint board', description: 'Backlog → in progress → review → done.', build: () => kanbanTemplate('sprint') },
  { id: 'kanban-bugs', kind: 'kanban', ext: '.html', name: 'Bug tracker', description: 'Triage, fixing, verifying, closed.', build: () => kanbanTemplate('bugs') },
  { id: 'kanban-personal', kind: 'kanban', ext: '.html', name: 'Personal tasks', description: 'Simple to-do board.', build: () => kanbanTemplate('personal') },
  { id: 'kanban-content', kind: 'kanban', ext: '.html', name: 'Content pipeline', description: 'Ideas to published.', build: () => kanbanTemplate('content') },
  { id: 'gantt-plan', kind: 'gantt', ext: '.html', name: 'Project plan', description: 'Phases, tasks, milestones and dependencies.', build: () => ganttTemplate() },
  { id: 'mindmap-brainstorm', kind: 'mindmap', ext: '.html', name: 'Brainstorm', description: 'Central idea with branches.', build: () => mindmapTemplate() },
  { id: 'flow-process', kind: 'flow', ext: '.html', name: 'Process flow', description: 'Start, steps, decision, end.', build: () => flowTemplate() },
  { id: 'stocks-watchlist', kind: 'stocks', ext: '.html', name: 'Stock watchlist', description: 'NSE / BSE / US tickers with live prices and alerts.', build: () => StocksCore.serializeToHtml(StocksCore.createStarter()) },
  { id: 'terminal-local', kind: 'terminal', ext: '.html', name: 'Terminal: Local', description: 'tmux session on this computer.', build: (c) => TerminalCore.serializeToHtml(TerminalCore.createStarter('local'), c.title) },
  { id: 'terminal-ssh', kind: 'terminal', ext: '.html', name: 'Terminal: SSH', description: 'tmux session on a remote host over SSH.', build: (c) => TerminalCore.serializeToHtml(TerminalCore.createStarter('ssh'), c.title) },
  { id: 'claude-local', kind: 'terminal', ext: '.html', name: 'Claude: Local', description: 'Claude Code in a tmux session on this computer.', build: (c) => TerminalCore.serializeToHtml(TerminalCore.createStarter('claude-local'), c.title) },
  { id: 'claude-remote', kind: 'terminal', ext: '.html', name: 'Claude: Remote', description: 'Claude Code in tmux on an SSH host.', build: (c) => TerminalCore.serializeToHtml(TerminalCore.createStarter('claude-remote'), c.title) },
  { id: 'runbook-change', kind: 'runbook', ext: '.html', name: 'Runbook: Network change', description: 'Pre-checks, change, verify, rollback — runnable.', build: (c) => RunbookCore.serializeToHtml(RunbookCore.createStarter('change'), c.title) },
  { id: 'runbook-incident', kind: 'runbook', ext: '.html', name: 'Runbook: Incident triage', description: 'Gather facts, mitigate, verify.', build: (c) => RunbookCore.serializeToHtml(RunbookCore.createStarter('incident'), c.title) },
  { id: 'runbook-deploy', kind: 'runbook', ext: '.html', name: 'Runbook: Deploy', description: 'Build, release, smoke test, rollback.', build: (c) => RunbookCore.serializeToHtml(RunbookCore.createStarter('deploy'), c.title) },
  { id: 'mermaid-sequence', kind: 'mermaid', ext: '.mmd', name: 'Sequence diagram', description: 'Client / API / database exchange.',
    build: () => MD(['sequenceDiagram', '  participant C as Client', '  participant A as API', '  participant D as Database', '  C->>A: Request', '  A->>D: Query', '  D-->>A: Rows', '  A-->>C: Response']) },
  { id: 'mermaid-fabric', kind: 'mermaid', ext: '.mmd', name: 'Leaf-spine fabric', description: 'Two spines, four leaves.',
    build: () => MD(['flowchart TB', '  subgraph Spines', '    s1[spine-1]', '    s2[spine-2]', '  end', '  subgraph Leaves', '    l1[leaf-1]', '    l2[leaf-2]', '    l3[leaf-3]', '    l4[leaf-4]', '  end', '  s1 --- l1 & l2 & l3 & l4', '  s2 --- l1 & l2 & l3 & l4']) },
];
const TEXT_TEMPLATE = /\.(md|markdown|mmd|mermaid|txt|json|ya?ml|csv)$/i;

function templateContext(title) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return { title: title || 'Untitled', date, weekday: now.toLocaleDateString('en-US', { weekday: 'long' }), week: String(week) };
}
function fillPlaceholders(text, ctx) {
  return String(text).replace(/\{\{\s*(title|date|weekday|week)\s*\}\}/g, (m, k) => ctx[k]);
}

app.get('/api/templates', (req, res) => {
  const user = [];
  const dir = path.join(DATA_ROOT, USER_TEMPLATES_DIR);
  (function walk(d) {
    for (const entry of safeReaddir(d)) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = path.relative(DATA_ROOT, full).split(path.sep).join('/');
      user.push({ path: rel, name: entry.name.replace(/\.[^.]+$/, ''), kind: fileKind(full, entry.name), ext: path.extname(entry.name) });
    }
  })(dir);
  res.json({
    builtin: BUILTIN_TEMPLATES.map(({ id, kind, ext, name, description }) => ({ id, kind, ext, name, description })),
    user,
    folder: USER_TEMPLATES_DIR,
  });
});

// Create a new file from a template: { id } (built-in) or { from } (a file
// in templates/), at { path }. Refuses to overwrite.
app.post('/api/templates/create', (req, res) => {
  try {
    const { id, from } = req.body || {};
    let rel = String((req.body && req.body.path) || '').replace(/^\/+/, '');
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const title = path.posix.basename(rel).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const ctx = templateContext(title.charAt(0).toUpperCase() + title.slice(1));
    let content;
    if (id) {
      const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
      if (!t) return res.status(404).json({ error: 'Unknown template' });
      if (!path.posix.extname(rel)) rel += t.ext;
      content = t.build(ctx);
      if (TEXT_TEMPLATE.test(rel)) content = fillPlaceholders(content, ctx);
    } else if (from) {
      const src = resolveSafe(String(from));
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return res.status(404).json({ error: 'Template file not found' });
      if (!path.posix.extname(rel)) rel += path.extname(src);
      content = fs.readFileSync(src);
      if (TEXT_TEMPLATE.test(rel)) content = fillPlaceholders(content.toString('utf8'), ctx);
    } else return res.status(400).json({ error: 'id or from is required' });
    const full = resolveSafe(rel);
    if (fs.existsSync(full)) return res.status(400).json({ error: 'A file already exists at ' + rel });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const commit = commitFile(rel, `Create ${rel} from template`);
    res.json({ ok: true, path: rel, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Copy a workspace file into templates/ (adds -2, -3… instead of overwriting).
app.post('/api/templates/save', (req, res) => {
  try {
    const rel = String((req.body && req.body.path) || '').replace(/^\/+/, '');
    const src = resolveSafe(rel);
    if (!rel || !fs.existsSync(src) || !fs.statSync(src).isFile()) return res.status(404).json({ error: 'File not found' });
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let dest = `${USER_TEMPLATES_DIR}/${base}${ext}`;
    for (let i = 2; fs.existsSync(resolveSafe(dest)); i++) dest = `${USER_TEMPLATES_DIR}/${base}-${i}${ext}`;
    const full = resolveSafe(dest);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.copyFileSync(src, full);
    const commit = commitFile(dest, `Save ${rel} as template`);
    res.json({ ok: true, path: dest, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/file/create', (req, res) => {
  try {
    const { path: relPath, kind, template } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    if (fs.existsSync(full)) {
      return res.status(400).json({ error: 'A file already exists at that path' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, defaultContentFor(relPath, kind, template), 'utf8');
    const commit = commitFile(relPath, `Create ${relPath}`);
    res.json({ ok: true, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/folder/delete', (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    if (full === DATA_ROOT) return res.status(400).json({ error: 'Cannot delete the data root' });
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    fs.rmSync(full, { recursive: true, force: true });
    removeFavoritesUnder(relPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/file/delete', (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    fs.unlinkSync(full);
    removeFavoritesUnder(relPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tags', (req, res) => {
  res.json(readTags());
});

// Set the tags of one file (empty list removes them).
app.post('/api/tags/set', (req, res) => {
  try {
    const rel = path.relative(DATA_ROOT, resolveSafe(String((req.body && req.body.path) || ''))).split(path.sep).join('/');
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const store = readTags();
    const seen = new Set();
    const tags = (Array.isArray(req.body.tags) ? req.body.tags : []).map(cleanTag)
      .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 30);
    if (tags.length) store.files[rel] = tags;
    else delete store.files[rel];
    writeTags(store);
    res.json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/todos', (req, res) => {
  res.json(readTodos());
});

// Saves carry the revision they were based on; a save based on an older
// revision (another tab saved meanwhile) is refused with 409 so the client
// can reload and re-apply its change instead of overwriting.
function putTodos(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body; // sendBeacon sends text
    const current = readTodos();
    if (!body || !Number.isInteger(body.baseRev) || body.baseRev !== current.rev) {
      return res.status(409).json({ error: 'To-dos changed elsewhere', current });
    }
    const store = normalizeTodos(body);
    store.rev = current.rev + 1;
    writeTodos(store);
    res.json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
app.put('/api/todos', putTodos);
app.post('/api/todos', putTodos);

// --- Habits + daily standups (webapp/daily.json), saved with the same
// revision check as to-dos.
// { rev, habits: [{ id, name, created, archived }],
//   checks: { "YYYY-MM-DD": [habitId] },
//   standups: { "YYYY-MM-DD": { yesterday, today, blockers, notes } } }
// Path depends on the current data folder.
const DAILY_FILE_NAME = 'daily.json';
const STANDUP_FIELDS = ['yesterday', 'today', 'blockers', 'notes'];
function normalizeDaily(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const habits = (Array.isArray(src.habits) ? src.habits : [])
    .filter((h) => h && typeof h.id === 'string' && h.id && typeof h.name === 'string')
    .slice(0, 200)
    .map((h) => ({
      id: h.id.slice(0, 40),
      name: h.name.slice(0, 120),
      created: DAY_KEY.test(h.created) ? h.created : null,
      archived: !!h.archived,
      // Periods the habit was disabled (not tracked): [[from, to|null]].
      off: (Array.isArray(h.off) ? h.off : [])
        .filter((r) => Array.isArray(r) && DAY_KEY.test(r[0]) && (r[1] == null || DAY_KEY.test(r[1])))
        .slice(-200)
        .map((r) => [r[0], r[1] || null]),
    }));
  const ids = new Set(habits.map((h) => h.id));
  const checks = {};
  Object.entries(src.checks && typeof src.checks === 'object' ? src.checks : {}).forEach(([k, list]) => {
    if (!DAY_KEY.test(k) || !Array.isArray(list)) return;
    const keep = [...new Set(list.filter((id) => ids.has(id)))];
    if (keep.length) checks[k] = keep;
  });
  const standups = {};
  Object.entries(src.standups && typeof src.standups === 'object' ? src.standups : {}).forEach(([k, v]) => {
    if (!DAY_KEY.test(k) || !v || typeof v !== 'object') return;
    const entry = {};
    STANDUP_FIELDS.forEach((f) => { if (typeof v[f] === 'string' && v[f].trim()) entry[f] = v[f].slice(0, 20000); });
    if (Object.keys(entry).length) standups[k] = entry;
  });
  return { rev: Number.isInteger(src.rev) ? src.rev : 0, habits, checks, standups };
}
function readDaily() {
  try {
    return normalizeDaily(JSON.parse(fs.readFileSync(stateFile(DAILY_FILE_NAME), 'utf8')));
  } catch (e) {
    return normalizeDaily({});
  }
}
app.get('/api/daily', (req, res) => {
  res.json(readDaily());
});
function putDaily(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const current = readDaily();
    if (!body || !Number.isInteger(body.baseRev) || body.baseRev !== current.rev) {
      return res.status(409).json({ error: 'Habits/standups changed elsewhere', current });
    }
    const store = normalizeDaily(body);
    store.rev = current.rev + 1;
    writeJsonAtomic(stateFile(DAILY_FILE_NAME), store);
    res.json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
app.put('/api/daily', putDaily);
app.post('/api/daily', putDaily);

// --- Ideas inbox (webapp/ideas.json), same revision check as to-dos.
// { rev, ideas: [{ id, text, tags, status, created, updated, remindAt,
//   repeat, note }] }  remindAt: epoch ms or null; repeat: '', 'daily',
//   '3d', 'weekly'; note: workspace path of the idea's markdown note.
// Path depends on the current data folder.
const IDEAS_FILE_NAME = 'ideas.json';
const IDEA_STATUS = ['inbox', 'exploring', 'parked', 'done'];
const IDEA_REPEAT = ['', 'daily', '3d', 'weekly'];
function normalizeIdeas(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ideas = (Array.isArray(src.ideas) ? src.ideas : [])
    .filter((i) => i && typeof i.id === 'string' && i.id && typeof i.text === 'string')
    .slice(0, 5000)
    .map((i) => ({
      id: i.id.slice(0, 40),
      text: i.text.slice(0, 20000),
      tags: (Array.isArray(i.tags) ? i.tags : []).map(cleanTag).filter(Boolean).slice(0, 20),
      status: IDEA_STATUS.includes(i.status) ? i.status : 'inbox',
      created: Number.isFinite(i.created) ? i.created : Date.now(),
      updated: Number.isFinite(i.updated) ? i.updated : null,
      remindAt: Number.isFinite(i.remindAt) ? i.remindAt : null,
      repeat: IDEA_REPEAT.includes(i.repeat) ? i.repeat : '',
      note: typeof i.note === 'string' && i.note ? i.note.slice(0, 500) : null,
    }));
  return { rev: Number.isInteger(src.rev) ? src.rev : 0, ideas };
}
function readIdeas() {
  try {
    return normalizeIdeas(JSON.parse(fs.readFileSync(stateFile(IDEAS_FILE_NAME), 'utf8')));
  } catch (e) {
    return normalizeIdeas({});
  }
}
const terminals = require('./terminal-server.js')(app, {
  dataRoot: () => DATA_ROOT,
  safeReaddir,
  peekFileKind,
  resolveSafe,
  isLocalRequest,
  // WebSocket upgrades skip express, so the module checks these itself.
  remoteTerminalOk: (req) => terminalsOverNetwork(req) && validSession(req),
  remoteRefusal: terminalNetworkRefusal,
  readAppConfig,
  writeAppConfig,
  writeFileCommit(rel, content, message) {
    const full = resolveSafe(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return commitFile(rel, message);
  },
});

require('./stocks-server.js')(app, {
  dataRoot: () => DATA_ROOT,
  stateFile,
  writeJsonAtomic,
  safeReaddir,
  peekFileKind,
  commitFile,
  resolveSafe,
});

app.get('/api/ideas', (req, res) => {
  res.json(readIdeas());
});
function putIdeas(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const current = readIdeas();
    if (!body || !Number.isInteger(body.baseRev) || body.baseRev !== current.rev) {
      return res.status(409).json({ error: 'Ideas changed elsewhere', current });
    }
    const store = normalizeIdeas(body);
    store.rev = current.rev + 1;
    writeJsonAtomic(stateFile(IDEAS_FILE_NAME), store);
    res.json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
app.put('/api/ideas', putIdeas);
app.post('/api/ideas', putIdeas);

app.get('/api/favorites', (req, res) => {
  res.json(bookmarksPayload(readBookmarks()));
});

app.post('/api/favorites/toggle', (req, res) => {
  try {
    const { path: relPath, categoryId } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    resolveSafe(relPath);
    const store = readBookmarks();
    const existing = store.items.find((it) => it.path === relPath);
    if (existing) {
      store.items = store.items.filter((it) => it.path !== relPath);
    } else {
      const cat = store.categories.find((c) => c.id === categoryId) || store.categories[0];
      if (!cat) return res.status(400).json({ error: 'Create a bookmark category first' });
      store.items.push({ path: relPath, categoryId: cat.id });
    }
    writeBookmarks(store);
    res.json(bookmarksPayload(store));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/favorites/assign', (req, res) => {
  try {
    const { path: relPath, categoryId } = req.body;
    if (!relPath || !categoryId) return res.status(400).json({ error: 'path and categoryId are required' });
    resolveSafe(relPath);
    const store = readBookmarks();
    const cat = store.categories.find((c) => c.id === categoryId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const existing = store.items.find((it) => it.path === relPath);
    if (existing) existing.categoryId = categoryId;
    else store.items.push({ path: relPath, categoryId });
    writeBookmarks(store);
    res.json(bookmarksPayload(store));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/favorites/category', (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const store = readBookmarks();
    const category = { id: bookmarkId(), name, collapsed: false };
    store.categories.push(category);
    writeBookmarks(store);
    res.json({ ...bookmarksPayload(store), category });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/favorites/category/update', (req, res) => {
  try {
    const { id, name, collapsed } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const store = readBookmarks();
    const cat = store.categories.find((c) => c.id === id);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    if (name != null) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'name is required' });
      cat.name = trimmed;
    }
    if (collapsed != null) cat.collapsed = !!collapsed;
    writeBookmarks(store);
    res.json(bookmarksPayload(store));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/favorites/category/delete', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const store = readBookmarks();
    if (!store.categories.some((c) => c.id === id)) {
      return res.status(404).json({ error: 'Category not found' });
    }
    store.categories = store.categories.filter((c) => c.id !== id);
    store.items = store.items.filter((it) => it.categoryId !== id);
    writeBookmarks(store);
    res.json(bookmarksPayload(store));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/raw', (req, res) => {
  try {
    const full = resolveSafe(req.query.path);
    const stat = fs.existsSync(full) && fs.statSync(full);
    if (!stat || !stat.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    // PDFs (viewer) and images (slides) only.
    const imageType = imageTypeFor(full);
    if (!/\.pdf$/i.test(full) && !imageType) {
      return res.status(400).json({ error: 'Only PDF and image files can be viewed this way' });
    }
    if (imageType) {
      res.setHeader('Content-Type', imageType);
      res.setHeader('Cache-Control', 'no-cache');
      // An SVG opened directly must not run scripts.
      if (imageType === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
      sendFileStream(full, res);
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(full).replace(/"/g, '') + '"');
    sendFileStream(full, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/transient-download', (req, res) => {
  try {
    const name = safeDownloadName(String((req.body && req.body.name) || 'download')).slice(0, 120);
    const type = String((req.body && req.body.type) || 'application/octet-stream').slice(0, 80);
    const data = String((req.body && req.body.data) || '');
    if (!data) return res.status(400).json({ error: 'No file' });
    const body = Buffer.from(data, 'base64');
    if (!body.length || body.length > 25 * 1024 * 1024) return res.status(400).json({ error: 'Bad file' });
    pruneTransientDownloads();
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    transientDownloads.set(id, { body, type, name, at: Date.now() });
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/transient-download/:id', (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[a-z0-9-]+$/i.test(id)) return res.status(404).json({ error: 'Not found' });
    const item = transientDownloads.get(id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    transientDownloads.delete(id);
    const name = safeDownloadName(String(req.query.name || item.name || 'download')).slice(0, 120);
    res.setHeader('Content-Type', item.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(item.body);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/download', (req, res) => {
  try {
    const rel = String(req.query.path || '');
    const full = resolveSafe(rel);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const prefix = path.basename(full === DATA_ROOT ? 'data' : full);
      const entries = listExportFiles(full, prefix, []);
      if (!entries.length) return res.status(400).json({ error: 'Folder is empty' });
      const zip = buildZip(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeDownloadName(prefix) + '.zip"');
      return res.end(zip);
    }
    if (!stat.isFile()) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', contentTypeFor(full));
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeDownloadName(path.basename(full)) + '"');
    sendFileStream(full, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Website export of a folder: the client renders the pages (markdown and
// board pages need the browser engines); everything else is copied here.
// Body: { folder, pages: [{ path, content }], copy: [workspacePath] }.
app.post('/api/export-site', (req, res) => {
  try {
    const folder = String((req.body && req.body.folder) || '').replace(/^\/+|\/+$/g, '');
    const base = folder ? resolveSafe(folder) : DATA_ROOT;
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return res.status(404).json({ error: 'Folder not found' });
    const root = path.basename(folder ? base : 'site');
    const cleanRel = (p) => {
      const rel = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) throw new Error('Bad path: ' + p);
      return rel;
    };
    const entries = new Map();
    (Array.isArray(req.body.pages) ? req.body.pages : []).forEach((pg) => {
      entries.set(cleanRel(pg.path), Buffer.from(String(pg.content || ''), 'utf8'));
    });
    (Array.isArray(req.body.copy) ? req.body.copy : []).forEach((wsPath) => {
      const full = resolveSafe(String(wsPath));
      if (full !== base && !full.startsWith(base + path.sep)) return; // outside the folder
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (!entries.has(rel)) entries.set(rel, fs.readFileSync(full));
    });
    if (!entries.size) return res.status(400).json({ error: 'Nothing to export' });
    const zip = buildZip([...entries].map(([name, data]) => ({ name: root + '/' + name, data })));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeDownloadName(root) + '-site.zip"');
    res.end(zip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const dest = String((req.body && req.body.dest) || '').replace(/^\/+|\/+$/g, '');
    if (dest) resolveSafe(dest);
    const overwrite = !!(req.body && req.body.overwrite);
    const items = Array.isArray(req.body && req.body.files) ? req.body.files : [];
    if (!items.length) return res.status(400).json({ error: 'No files to import' });
    const incoming = [];
    let total = 0;
    for (const item of items) {
      const rawName = path.posix.basename(String((item && item.name) || ''));
      if (!rawName) continue;
      const encoding = item.encoding === 'base64' ? 'base64' : 'utf8';
      const data = encoding === 'base64'
        ? Buffer.from(String(item.content || ''), 'base64')
        : Buffer.from(String(item.content ?? ''), 'utf8');
      if (/\.zip$/i.test(rawName)) {
        const members = readZip(data, { maxFiles: 100, maxBytes: 40 * 1024 * 1024 });
        for (const member of members) {
          const memberName = safeMemberName(member.name);
          if (!memberName || !allowedShareName(memberName)) continue;
          total += member.data.length;
          if (incoming.length >= 100) return res.status(400).json({ error: 'Too many files in the zip (limit 100)' });
          if (total > 40 * 1024 * 1024) return res.status(400).json({ error: 'Import is too large (limit 40MB)' });
          incoming.push({ name: memberName, data: member.data });
        }
        continue;
      }
      if (!allowedShareName(rawName)) continue;
      total += data.length;
      if (incoming.length >= 100) return res.status(400).json({ error: 'Too many files (limit 100)' });
      if (total > 40 * 1024 * 1024) return res.status(400).json({ error: 'Import is too large (limit 40MB)' });
      incoming.push({ name: rawName, data });
    }
    if (!incoming.length) return res.status(400).json({ error: 'No files to import (hidden dotfiles are skipped).' });
    // Work out and check every destination first, so an import either
    // writes all of its files or none (no half-imports on error).
    const planned = new Set();
    const plan = incoming.map((file) => {
      const wanted = joinDest(dest, file.name);
      let rel = overwrite ? wanted : uniqueRelPath(wanted);
      // Two files with the same name in one import get distinct names too.
      if (!overwrite && planned.has(rel)) {
        const ext = path.posix.extname(wanted);
        const stem = wanted.slice(0, wanted.length - ext.length);
        for (let n = 2; planned.has(rel) || fs.existsSync(resolveSafe(rel)); n++) rel = `${stem}-${n}${ext}`;
      }
      planned.add(rel);
      const full = resolveSafe(rel);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new Error('A folder already exists at ' + rel);
      for (let dir = path.dirname(full); dir.startsWith(DATA_ROOT) && dir !== DATA_ROOT; dir = path.dirname(dir)) {
        if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error('A file is in the way of folder ' + path.relative(DATA_ROOT, dir));
      }
      return { file, rel, full };
    });
    const seenRel = new Set();
    plan.forEach((p) => {
      if (seenRel.has(p.rel)) throw new Error('Duplicate file in import: ' + p.rel);
      seenRel.add(p.rel);
    });
    const imported = [];
    for (const { file, rel, full } of plan) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.data);
      imported.push({ path: rel, kind: peekFileKind(full, path.basename(rel)) || undefined });
    }
    let commit = null;
    try {
      commit = commitFile(imported.map((f) => f.path), imported.length === 1 ? `Import ${imported[0].path}` : `Import ${imported.length} files`);
    } catch (e) {
      commit = null;
    }
    res.json({ ok: true, imported, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const MAX_EDITABLE_SIZE = 40 * 1024 * 1024;

app.get('/api/file', (req, res) => {
  try {
    const full = resolveSafe(req.query.path);
    const stat = fs.existsSync(full) && fs.statSync(full);
    if (!stat || !stat.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (isLikelyBinary(full)) {
      return res.status(400).json({ error: 'This looks like a binary file and cannot be edited here' });
    }
    if (stat.size > MAX_EDITABLE_SIZE) {
      return res.status(400).json({ error: 'File is too large to open in the editor (limit 40MB)' });
    }
    const content = fs.readFileSync(full, 'utf8');
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function parseFilePost(req) {
  const body = req.body;
  let relPath = req.query && req.query.path;
  let content = null;
  if (typeof body === 'string') {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json') || (body.charAt(0) === '{' && body.includes('"content"'))) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          relPath = relPath || parsed.path;
          if (Object.prototype.hasOwnProperty.call(parsed, 'content')) content = parsed.content;
        }
      } catch (e) {
        content = body;
      }
    } else {
      content = body;
    }
  } else if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    relPath = relPath || body.path;
    if (Object.prototype.hasOwnProperty.call(body, 'content')) content = body.content;
  } else if (Buffer.isBuffer(body)) {
    content = body.toString('utf8');
  }
  return { relPath, content };
}

app.post('/api/file', async (req, res) => {
  try {
    const { relPath, content } = parseFilePost(req);
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    if (content == null) return res.status(400).json({ error: 'content is required' });
    const full = resolveSafe(relPath);
    const rel = path.relative(DATA_ROOT, full).split(path.sep).join('/');
    writingFiles.add(rel);
    try {
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, String(content), 'utf8');
      knownFiles.add(rel);
      res.json({ ok: true });
    } finally {
      setTimeout(() => writingFiles.delete(rel), 1200);
    }
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  }
});

app.post('/api/commit', (req, res) => {
  try {
    const { path: relPath, paths: relPaths, message } = req.body;
    const targets = relPaths && relPaths.length ? relPaths : relPath ? [relPath] : null;
    if (!targets) return res.status(400).json({ error: 'path (or paths) is required' });
    targets.forEach((p) => resolveSafe(p));
    const finalMessage = (message && message.trim()) || `Snapshot ${new Date().toISOString()}`;
    const commit = commitFile(targets, finalMessage);
    if (!commit) return res.json({ ok: true, commit: null, message: 'No changes to commit' });
    res.json({ ok: true, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/move', (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const fromFull = resolveSafe(from);
    const toFull = resolveSafe(to);
    if (!fs.existsSync(fromFull)) return res.status(404).json({ error: 'Source not found' });
    // Renaming only the letter case ("Notes.md" -> "notes.md"): on macOS the
    // destination "exists" because it is the same file; go via a temp name.
    const caseOnly = fromFull !== toFull && fromFull.toLowerCase() === toFull.toLowerCase();
    if (!caseOnly && fs.existsSync(toFull)) return res.status(400).json({ error: 'A file or folder already exists at the destination' });
    fs.mkdirSync(path.dirname(toFull), { recursive: true });
    if (caseOnly) {
      const tmp = fromFull + '.renaming-' + Date.now();
      fs.renameSync(fromFull, tmp);
      fs.renameSync(tmp, toFull);
    } else fs.renameSync(fromFull, toFull);
    // Bookmarks are stored as clean workspace paths ("a.md", not "./a.md").
    const relOf = (full) => path.relative(DATA_ROOT, full).split(path.sep).join('/');
    rewriteBookmarkPaths(relOf(fromFull), relOf(toFull));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const relPath = req.query.path;
    resolveSafe(relPath); // validate, throws on escape
    const out = git(['log', '--follow', '--date=iso-strict', '--pretty=format:%H%x1f%ad%x1f%s', '--', relPath]);
    const commits = out.split('\n').filter(Boolean).map((line) => {
      const [hash, date, message] = line.split('\x1f');
      return { hash, date, message };
    });
    res.json({ commits });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/version', (req, res) => {
  try {
    const relPath = req.query.path;
    const hash = req.query.hash;
    resolveSafe(relPath);
    if (!hash) return res.status(400).json({ error: 'hash is required' });
    const content = git(['show', `${checkHash(hash)}:${relPath}`]);
    res.json({ content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/restore', (req, res) => {
  try {
    const { path: relPath, hash } = req.body;
    if (!relPath || !hash) return res.status(400).json({ error: 'path and hash are required' });
    const full = resolveSafe(relPath);
    const content = gitBuffer(['show', `${checkHash(hash)}:${relPath}`]);
    fs.writeFileSync(full, content, 'utf8');
    const commit = commitFile(relPath, `Restore ${relPath} to ${hash.slice(0, 7)}`);
    res.json({ ok: true, content, commit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function fileKind(full, name) {
  const board = peekFileKind(full, name);
  if (board) return board;
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.json$/i.test(name)) return 'json';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

function kindLabel(kind) {
  if (kind === 'mindmap') return 'Mindmap';
  if (kind === 'flow') return 'Flow';
  if (kind === 'kanban') return 'Kanban';
  if (kind === 'gantt') return 'Gantt';
  if (kind === 'slides') return 'Slides';
  if (kind === 'stocks') return 'Stocks';
  if (kind === 'terminal') return 'Terminal';
  if (kind === 'runbook') return 'Runbook';
  if (kind === 'json') return 'JSON';
  if (kind === 'yaml') return 'YAML';
  if (kind === 'markdown') return 'Markdown';
  if (kind === 'pdf') return 'PDF';
  return 'File';
}

app.get('/api/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = String(req.query.type || '').trim().toLowerCase();
    if (!q && !type) return res.json({ results: [] });
    const results = [];
    const needle = q.toLowerCase();

    function walk(dir) {
      const entries = safeReaddir(dir);
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          if (results.length >= 200) return;
          continue;
        }
        const kind = fileKind(full, entry.name);
        if (type && kind !== type) continue;
        const rel = path.relative(DATA_ROOT, full);
        if (!q) {
          results.push({ path: rel, line: null, text: kindLabel(kind), matchType: 'type', kind });
        } else {
          if (rel.toLowerCase().includes(needle)) {
            results.push({ path: rel, line: null, text: kindLabel(kind), matchType: 'filename', kind });
          }
          if (kind !== 'pdf' && !isLikelyBinary(full)) {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(needle)) {
                results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200), matchType: 'content', kind });
                if (results.length >= 200) return;
              }
            }
          }
        }
        if (results.length >= 200) return;
      }
    }
    walk(DATA_ROOT);
    res.json({ results: results.slice(0, 200) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Everything a markdown file can link to or embed inside boards: mindmap and
// flow frames (plus "whole board"), gantt views and slides. Each item has a
// `ref` fragment used in links, e.g. "frame=f_123", "view=sheet", "slide=2".
function boardTargets(full, rel, kind) {
  const content = fs.readFileSync(full, 'utf8');
  const out = [];
  const add = (ref, title, embeddable) => out.push({ path: rel, kind, ref, title: String(title || '').slice(0, 200), embeddable });
  if (kind === 'mindmap') {
    const m = content.match(/<script[^>]*id=["']mindmap-data["'][^>]*>([\s\S]*?)<\/script>/i);
    let frames = [];
    try { frames = (m && JSON.parse(m[1]).frames) || []; } catch (e) { frames = []; }
    frames.forEach((f) => { if (f && f.id) add('frame=' + f.id, f.title || 'Frame', true); });
    add('frame=__all__', 'Whole mindmap', true);
  } else if (kind === 'flow') {
    const data = FlowCore.parseHtml(content);
    ((data && data.frames) || []).forEach((f) => { if (f && f.id) add('frame=' + f.id, f.title || 'Frame', true); });
    add('frame=__all__', 'Whole flow', true);
  } else if (kind === 'gantt') {
    [['chart', 'Timeline'], ['sheet', 'Sheet'], ['analytics', 'Analytics']].forEach(([v, label]) => add('view=' + v, label, true));
  } else if (kind === 'slides') {
    const data = SlidesCore.parseHtml(content);
    ((data && data.slides) || []).forEach((sl, i) => add('slide=' + (i + 1), 'Slide ' + (i + 1) + (sl.title ? ': ' + sl.title : ''), false));
  }
  return out;
}

// Every file with its type and last change (for the Today screen).
app.get('/api/files/summary', (req, res) => {
  try {
    const files = [];
    (function walk(dir, depth) {
      if (depth > 20 || files.length > 20000) return;
      for (const e of safeReaddir(dir)) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        let st;
        try { st = fs.statSync(full); } catch (err) { continue; }
        let kind = fileKind(full, e.name);
        if (kind === 'file') {
          if (/\.(mmd|mermaid)$/i.test(e.name)) kind = 'mermaid';
          else if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|heic)$/i.test(e.name)) kind = 'image';
          else if (/\.html?$/i.test(e.name)) kind = 'html';
          else if (/\.(csv|tsv)$/i.test(e.name)) kind = 'csv';
          else if (/\.(txt|log|conf|cfg|ini|toml|xml|sh|py|js|ts|go|rs|java|c|cpp|h|rb|sql)$/i.test(e.name)) kind = 'text';
        }
        files.push({ path: path.relative(DATA_ROOT, full).split(path.sep).join('/'), kind, mtime: Math.round(st.mtimeMs), size: st.size });
      }
    })(DATA_ROOT, 0);
    res.json({ files, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/frames', (req, res) => {
  try {
    const items = [];
    (function walk(dir) {
      for (const entry of safeReaddir(dir)) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.html?$/i.test(entry.name)) continue;
        const kind = peekFileKind(full, entry.name);
        if (!['mindmap', 'flow', 'gantt', 'slides'].includes(kind)) continue;
        try {
          items.push(...boardTargets(full, path.relative(DATA_ROOT, full).split(path.sep).join('/'), kind));
        } catch (e) { /* unreadable board: skip */ }
        if (items.length > 5000) return;
      }
    })(DATA_ROOT);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Backlinks: which notes / decks point at a file ---
// Markdown links and images ([text](path), ![alt](path)) resolved relative to
// the note, and slide visuals/images/backgrounds that use the file.
const MD_LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

function resolveNoteLink(fromRel, href) {
  if (!href || /^([a-z][\w+.-]*:|#|\/\/)/i.test(href)) return null;
  const hashAt = href.indexOf('#');
  const ref = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  let p = (hashAt >= 0 ? href.slice(0, hashAt) : href).split('?')[0];
  if (!p) return null;
  try { p = decodeURIComponent(p); } catch (e) { /* keep as written */ }
  const base = p.startsWith('/') ? '' : path.posix.dirname(fromRel);
  const resolved = path.posix.normalize(path.posix.join(base === '.' ? '' : base, p.replace(/^\/+/, '')));
  if (resolved.startsWith('..')) return null;
  return { path: resolved, ref };
}

app.get('/api/backlinks', (req, res) => {
  try {
    const target = path.relative(DATA_ROOT, resolveSafe(String(req.query.path || ''))).split(path.sep).join('/');
    if (!target) return res.status(400).json({ error: 'path is required' });
    const links = [];
    (function walk(dir) {
      for (const entry of safeReaddir(dir)) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const rel = path.relative(DATA_ROOT, full).split(path.sep).join('/');
        if (rel === target) continue;
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.size > 4 * 1024 * 1024) continue;
        if (/\.(md|markdown)$/i.test(entry.name)) {
          let text;
          try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
          text.split('\n').forEach((line, i) => {
            MD_LINK_RE.lastIndex = 0;
            let m;
            while ((m = MD_LINK_RE.exec(line))) {
              const r = resolveNoteLink(rel, m[3]);
              if (r && r.path === target) {
                links.push({ from: rel, kind: 'markdown', line: i + 1, text: (m[2] || '').slice(0, 120), ref: r.ref, image: m[1] === '!' });
              }
            }
          });
        } else if (/\.html?$/i.test(entry.name) && peekFileKind(full, entry.name) === 'slides') {
          let deck;
          try { deck = SlidesCore.parseHtml(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
          ((deck && deck.slides) || []).forEach((sl, i) => {
            const uses = [];
            (sl.visuals || []).forEach((v) => {
              if (v.source && v.source.path === target) uses.push(v.source.frameId && v.source.frameId !== '__all__' ? 'visual (' + v.source.frameId + ')' : 'visual');
              if (v.image && v.image.path === target) uses.push('image');
            });
            if (sl.background && sl.background.path === target) uses.push('background');
            if (uses.length) links.push({ from: rel, kind: 'slides', slide: i + 1, text: (sl.title || 'Slide ' + (i + 1)).slice(0, 120), uses: [...new Set(uses)] });
          });
        }
        if (links.length > 2000) return;
      }
    })(DATA_ROOT);
    res.json({ path: target, links });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/convert', (req, res) => {
  try {
    const { content, from, to } = req.body;
    let data;
    if (from === 'json') {
      data = JSON.parse(content);
    } else if (from === 'yaml') {
      data = yaml.load(content);
    } else {
      return res.status(400).json({ error: 'Unsupported source format' });
    }

    let output;
    if (to === 'json') {
      output = JSON.stringify(data, null, 2);
    } else if (to === 'yaml') {
      output = yaml.dump(data);
    } else {
      return res.status(400).json({ error: 'Unsupported target format' });
    }
    res.json({ output });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function printLink(url) {
  // OSC 8 hyperlink escape sequence (rendered as a clickable link by
  // most modern terminals); falls back to plain text elsewhere.
  const hyperlink = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
  console.log(`Accretion running at ${hyperlink}`);
}

// --- How the UI opens: 'window' (its own app window via Chrome/Edge/Brave
// app mode — no tabs or address bar), 'browser' (a normal tab) or 'none'.
// Order: --window / --browser / --no-open flag, ACCRETION_OPEN env var,
// then openAs in ~/.accretion/config.json; default 'browser'.
function launchMode() {
  const argv = process.argv.slice(2);
  if (argv.includes('--window')) return 'window';
  if (argv.includes('--browser')) return 'browser';
  if (argv.includes('--no-open')) return 'none';
  const env = String(process.env.ACCRETION_OPEN || '').toLowerCase();
  if (['window', 'browser', 'none'].includes(env)) return env;
  const cfg = readAppConfig();
  return cfg.openAs === 'window' ? 'window' : 'browser';
}

// Chromium-family browsers that support --app windows.
function findAppBrowser() {
  const home = require('os').homedir();
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  ] : process.platform === 'win32' ? [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium'];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}

// An installed web app (Chrome/Edge "Install Accretion", or Safari "Add to
// Dock") has its own Dock icon. Prefer it over a plain --app window.
function findInstalledWebApp() {
  if (process.platform !== 'darwin') return null;
  const apps = path.join(require('os').homedir(), 'Applications');
  const dirs = [apps, path.join(apps, 'Chrome Apps.localized'), path.join(apps, 'Chrome Apps'), path.join(apps, 'Edge Apps.localized'), path.join(apps, 'Brave Browser Apps.localized')];
  for (const dir of dirs) {
    for (const e of safeReaddir(dir)) {
      if (!e.name.endsWith('.app')) continue;
      const plist = path.join(dir, e.name, 'Contents', 'Info.plist');
      try {
        const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 2000 }));
        const name = info.CFBundleName || info.CFBundleDisplayName || '';
        // Our own launcher (an AppleScript applet) is not the web app.
        if (/^accretion$/i.test(name) && info.CFBundleExecutable !== 'applet') return path.join(dir, e.name);
      } catch (err) { /* not readable */ }
    }
  }
  return null;
}

function openAsWindow(url) {
  const installed = findInstalledWebApp();
  if (installed) {
    execFile('open', ['-a', installed], (err) => { if (err) console.log('(Could not open ' + installed + ': ' + err.message + ')'); });
    return;
  }
  const exe = findAppBrowser();
  if (!exe) {
    console.log('(No Chrome / Edge / Brave found for a window — opening in the browser instead.)');
    return openInBrowser(url);
  }
  // A separate profile gives the app its own Dock/taskbar window that
  // remembers its size and position, independent of normal browsing.
  const profile = path.join(APP_CONFIG_DIR, 'window-profile');
  // First launch fills the screen; after that the window keeps whatever
  // size and position you leave it at.
  const firstRun = !fs.existsSync(profile);
  const child = require('child_process').spawn(exe, [
    '--app=' + url,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    ...(firstRun ? ['--start-maximized'] : []),
  ], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => { console.log('(Could not open a window: ' + err.message + ' — using the browser.)'); openInBrowser(url); });
  child.unref();
}

function openUi(url, mode) {
  const m = mode || launchMode();
  if (m === 'none') return;
  if (m === 'window') openAsWindow(url);
  else openInBrowser(url);
}

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) console.log(`(Could not auto-open browser: ${err.message})`);
  });
}

app.use((err, req, res, next) => {
  console.error('Request failed:', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) || 'Server error' });
});

// Is something already accepting connections on this port (on either
// localhost address)? Another copy of this app bound to a different
// address would otherwise run alongside, and the browser could reach the
// old one instead of this one.
function portAnswers(host, port) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

let serverUrl = null;
// Address the app opens on this computer: https when HTTPS mode is on and
// this computer trusts the certificate (no browser warning), else http.
function localUrl(port) {
  const p = port || currentPort || PORT;
  if (httpsSrv && tlsCerts.trustedOnThisMac() === true) return `https://localhost:${p}`;
  return `http://localhost:${p}`;
}
function onListening(srv) {
  const actualPort = srv.address().port;
  const url = localUrl(actualPort);
  if (relistening) {
    relistening = false;
    console.log(listenHost() === '127.0.0.1' ? 'Network access off — this computer only.' : 'Network access on: ' + lanUrls(actualPort).join('  '));
    return;
  }
  if (listenHost() !== '127.0.0.1') console.log('Network access on: ' + lanUrls(actualPort).join('  '));
  if (httpsSrv) console.log('HTTPS mode on: ' + httpsUrls(actualPort).join('  '));
  printLink(url);
  console.log(`Serving files from: ${DATA_ROOT}`);
  serverUrl = url;
  openUi(url);
  setImmediate(initGitRepo);
}

let relistening = false;
let currentServer = null;
let currentPort = null;
let httpSrv = null;
let httpsSrv = null;
const liveSockets = new Set();

function tuneServer(srv) {
  srv.requestTimeout = 60000;
  srv.headersTimeout = 30000;
  srv.keepAliveTimeout = 5000;
  terminals.attach(srv);
  return srv;
}
// HTTPS listener (no port of its own: connections are handed to it, see listenOn).
function buildHttps() {
  if (!httpsCfg().enabled) { httpsSrv = null; return null; }
  const c = tlsCerts.ensure();
  if (httpsSrv) { httpsSrv.setSecureContext({ key: c.key, cert: c.cert }); return httpsSrv; }
  httpsSrv = tuneServer(require('https').createServer({ key: c.key, cert: c.cert }, app));
  return httpsSrv;
}
// New addresses or a near-expiry certificate: re-issue without restarting.
setInterval(() => { try { if (httpsSrv) buildHttps(); } catch (e) { console.error('HTTPS certificate refresh failed:', e.message); } }, 6 * 3600e3).unref();

// One port for both: a TLS handshake starts with byte 0x16, anything else is HTTP.
function listenOn(port, attempt = 0) {
  if (!httpSrv) httpSrv = tuneServer(require('http').createServer(app));
  try { buildHttps(); } catch (e) { console.error('HTTPS mode is on but could not start:', e.message); }
  const srv = require('net').createServer((sock) => {
    liveSockets.add(sock);
    sock.on('close', () => liveSockets.delete(sock));
    sock.on('error', () => {});
    sock.once('data', (buf) => {
      sock.pause();
      sock.unshift(buf);
      const target = buf[0] === 0x16 ? httpsSrv : httpSrv;
      if (!target) { sock.destroy(); return; }
      target.emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  });
  srv.closeAll = () => liveSockets.forEach((s) => s.destroy());
  srv.listen(port, listenHost(), () => { currentServer = srv; currentPort = srv.address().port; onListening(srv); });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Never move to another port. Retry briefly (e.g. while switching
      // network access the old socket may still be closing), then give up.
      if (attempt < 10) { setTimeout(() => listenOn(port, attempt + 1), 300); return; }
      portBusyExit();
    } else {
      throw err;
    }
  });
  return srv;
}

function portBusyExit() {
  console.error(`\n✖  Port ${PORT} is in use by another program, and Accretion only runs on port ${PORT}.`);
  console.error(`   See what is using it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  console.error(`   Stop it:               lsof -ti tcp:${PORT} | xargs kill`);
  console.error('   Then start Accretion again.\n');
  process.exit(1);
}

// run.sh / Accretion.app flags: --https / --no-https (remembered).
if (process.argv.includes('--https') || process.argv.includes('--no-https')) {
  const on = process.argv.includes('--https');
  const cfg = readAppConfig();
  writeAppConfig(Object.assign({}, cfg, { https: Object.assign({}, cfg.https || {}, { enabled: on }) }));
  console.log('HTTPS mode ' + (on ? 'enabled' : 'disabled') + ' (from the command line).');
}

(async () => {
  const busy = (await portAnswers('127.0.0.1', PORT)) || (await portAnswers('::1', PORT));
  if (busy) {
    // Already running? Then just open it (as a window or tab) and exit.
    try {
      const r = await fetch(`http://localhost:${PORT}/api/config`, { signal: AbortSignal.timeout(1500) });
      const d = r.ok ? await r.json() : null;
      if (d && d.dataDir) {
        // Ask the running server which address to open (http or https).
        let url = `http://localhost:${PORT}`;
        try {
          const h = await (await fetch(`http://localhost:${PORT}/api/https`, { signal: AbortSignal.timeout(3000) })).json();
          if (h && h.running && h.trustedHere === true) url = `https://localhost:${PORT}`;
        } catch (e) { /* older server: http */ }
        console.log(`Accretion is already running at ${url} — opening it.`);
        openUi(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
    } catch (e) { /* not ours */ }
    portBusyExit();
    return;
  }
  listenOn(PORT);
})();
