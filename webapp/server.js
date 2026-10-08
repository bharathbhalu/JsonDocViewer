const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const FlowCore = require(path.join(__dirname, 'public', 'flow', 'core.js'));
const KanbanCore = require(path.join(__dirname, 'public', 'kanban', 'core.js'));
const GanttCore = require(path.join(__dirname, 'public', 'gantt', 'core.js'));
const SlidesCore = require(path.join(__dirname, 'public', 'slides', 'core.js'));
const zlib = require('zlib');
const { execFile, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4321;
const DATA_ROOT = path.resolve(__dirname, '..', 'data');

if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

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
    execFileSync('git', [...GIT_ENV_ARGS, 'rev-parse', '--is-inside-work-tree'], {
      cwd: DATA_ROOT,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (e) {
    return false;
  }
}

function initGitRepo() {
  try {
    if (gitRepoOk()) return;
    const gitDir = path.join(DATA_ROOT, '.git');
    if (fs.existsSync(gitDir)) {
      // A leftover incomplete .git (e.g. interrupted init) makes every git
      // call fail and, without a timeout, can stall the whole HTTP server.
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
    git(['init']);
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

// Listen on this computer only (set HOST=0.0.0.0 to share on the network).
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Other websites must not be able to drive this API from the browser:
// - Host must be this machine (blocks DNS-rebinding),
// - state-changing requests must come from this app's own pages.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  if (LOOPBACK_HOSTS.has(HOST) && !LOOPBACK_HOSTS.has(hostname)) {
    return res.status(403).json({ error: 'Forbidden host' });
  }
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

const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

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
const TODOS_FILE = path.join(__dirname, 'todos.json');
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
        return item;
      });
    if (list.length) days[day] = list;
  });
  const rev = Number.isInteger(raw && raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  return { version: 1, rev, days };
}

function readTodos() {
  try {
    return normalizeTodos(JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8')));
  } catch (e) {
    return { version: 1, rev: 0, days: {} };
  }
}

function writeTodos(store) {
  // Write to a temp file then rename, so a crash never leaves half a file.
  writeJsonAtomic(TODOS_FILE, store);
}

function readBookmarks() {
  let text;
  try {
    text = fs.readFileSync(FAVORITES_FILE, 'utf8');
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
    try { fs.copyFileSync(FAVORITES_FILE, FAVORITES_FILE + '.corrupt-' + Date.now()); } catch (err) { /* ignore */ }
    return { categories: [], items: [] };
  }
}

function writeBookmarks(store) {
  writeJsonAtomic(FAVORITES_FILE, store);
}

function bookmarksPayload(store) {
  return {
    categories: store.categories,
    items: store.items,
    favorites: store.items.map((it) => it.path),
  };
}

function removeFavoritesUnder(relPath) {
  const store = readBookmarks();
  const items = store.items.filter((it) => it.path !== relPath && !it.path.startsWith(relPath + '/'));
  if (items.length !== store.items.length) writeBookmarks({ ...store, items });
}

function rewriteBookmarkPaths(from, to) {
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
const UI_SETTINGS_FILE = path.join(__dirname, 'ui-settings.json');

function readUiSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, 'utf8'));
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
    writeJsonAtomic(UI_SETTINGS_FILE, next);
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

try {
  fs.watch(DATA_ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.some((part) => part === '.git')) return;
    const rel = parts.join('/');
    if (writingFiles.has(rel) || writingFiles.has(filename)) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(reconcileWatchedFiles, 800);
  });
} catch (err) {
  console.error('File watching unavailable on this platform:', err.message);
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
  if (/\.json$/i.test(relPath)) return '{}\n';
  if (/\.(yaml|yml)$/i.test(relPath)) return '';
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

const server = app.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  const url = `http://localhost:${actualPort}`;
  printLink(url);
  console.log(`Serving files from: ${DATA_ROOT}`);
  openInBrowser(url);
  setImmediate(initGitRepo);
});
server.requestTimeout = 60000;
server.headersTimeout = 30000;
server.keepAliveTimeout = 5000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is in use, picking a random free port instead...`);
    const fallback = app.listen(0, HOST, () => {
      const actualPort = fallback.address().port;
      const url = `http://localhost:${actualPort}`;
      printLink(url);
      console.log(`Serving files from: ${DATA_ROOT}`);
      openInBrowser(url);
    });
  } else {
    throw err;
  }
});
