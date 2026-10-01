const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const FlowCore = require(path.join(__dirname, 'public', 'flow', 'core.js'));
const zlib = require('zlib');
const { execFile, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4321;
const DATA_ROOT = path.resolve(__dirname, '..', 'data');

if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

const GIT_ENV_ARGS = ['-c', 'user.email=docviewer@local', '-c', 'user.name=JsonDocViewer'];
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

function readBookmarks() {
  try {
    const raw = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    const store = normalizeBookmarks(raw);
    if (Array.isArray(raw)) writeBookmarks(store);
    return store;
  } catch (e) {
    return { categories: [], items: [] };
  }
}

function writeBookmarks(store) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(store, null, 2), 'utf8');
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

function readZip(buf) {
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
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('Unsupported zip compression in ' + name);
    out.push({ name, data });
  }
  return out;
}

function listExportFiles(dir, prefix, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
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

function contentTypeFor(name) {
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (/\.html?$/i.test(name)) return 'text/html; charset=utf-8';
  if (/\.json$/i.test(name)) return 'application/json; charset=utf-8';
  if (/\.ya?ml$/i.test(name)) return 'text/yaml; charset=utf-8';
  if (/\.zip$/i.test(name)) return 'application/zip';
  return 'application/octet-stream';
}

function allowedShareName(name, allowZip) {
  if (allowZip && /\.zip$/i.test(name)) return true;
  return /\.(html?|json|ya?ml|pdf|md|txt|csv)$/i.test(name);
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
  } catch (e) {
    return undefined;
  }
  return undefined;
}

function buildTree(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
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

app.get('/api/tree', (req, res) => {
  try {
    res.json({ root: 'data', children: buildTree(DATA_ROOT) });
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
  const entries = fs.readdirSync(dir, { withFileTypes: true });
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

function defaultContentFor(relPath, kind) {
  if (kind === 'mindmap') return mindmapTemplate();
  if (kind === 'flow') return flowTemplate();
  if (/\.json$/i.test(relPath)) return '{}\n';
  if (/\.(yaml|yml)$/i.test(relPath)) return '';
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

app.post('/api/file/create', (req, res) => {
  try {
    const { path: relPath, kind } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    if (fs.existsSync(full)) {
      return res.status(400).json({ error: 'A file already exists at that path' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, defaultContentFor(relPath, kind), 'utf8');
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
    if (!/\.pdf$/i.test(full)) {
      return res.status(400).json({ error: 'Only PDF files can be viewed this way' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(full).replace(/"/g, '') + '"');
    fs.createReadStream(full).pipe(res);
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
    fs.createReadStream(full).pipe(res);
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
        const members = readZip(data);
        for (const member of members) {
          const memberName = safeMemberName(member.name);
          if (!memberName || !allowedShareName(memberName, false)) continue;
          total += member.data.length;
          if (incoming.length >= 100) return res.status(400).json({ error: 'Too many files in the zip (limit 100)' });
          if (total > 40 * 1024 * 1024) return res.status(400).json({ error: 'Import is too large (limit 40MB)' });
          incoming.push({ name: memberName, data: member.data });
        }
        continue;
      }
      if (!allowedShareName(rawName, false)) continue;
      total += data.length;
      if (incoming.length >= 100) return res.status(400).json({ error: 'Too many files (limit 100)' });
      if (total > 40 * 1024 * 1024) return res.status(400).json({ error: 'Import is too large (limit 40MB)' });
      incoming.push({ name: rawName, data });
    }
    if (!incoming.length) return res.status(400).json({ error: 'No supported files. Use html, json, yaml, pdf, or a zip of those.' });
    const imported = [];
    for (const file of incoming) {
      const wanted = joinDest(dest, file.name);
      const rel = overwrite ? wanted : uniqueRelPath(wanted);
      const full = resolveSafe(rel);
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
    if (fs.existsSync(toFull)) return res.status(400).json({ error: 'A file or folder already exists at the destination' });
    fs.mkdirSync(path.dirname(toFull), { recursive: true });
    fs.renameSync(fromFull, toFull);
    rewriteBookmarkPaths(from, to);
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
    const content = git(['show', `${hash}:${relPath}`]);
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
    const content = git(['show', `${hash}:${relPath}`]);
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
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

function kindLabel(kind) {
  if (kind === 'mindmap') return 'Mindmap';
  if (kind === 'flow') return 'Flow';
  if (kind === 'json') return 'JSON';
  if (kind === 'yaml') return 'YAML';
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
      const entries = fs.readdirSync(dir, { withFileTypes: true });
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

const server = app.listen(PORT, () => {
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
    const fallback = app.listen(0, () => {
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
