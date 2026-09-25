const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFile, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4321;
const DATA_ROOT = path.resolve(__dirname, '..', 'data');

if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

const GIT_ENV_ARGS = ['-c', 'user.email=docviewer@local', '-c', 'user.name=JsonDocViewer'];

function git(args) {
  return execFileSync('git', [...GIT_ENV_ARGS, ...args], { cwd: DATA_ROOT, encoding: 'utf8' });
}

function initGitRepo() {
  if (!fs.existsSync(path.join(DATA_ROOT, '.git'))) {
    git(['init']);
    try {
      git(['add', '-A']);
      git(['commit', '-m', 'Initial commit']);
    } catch (e) {
      // nothing to commit yet, that's fine
    }
  }
}
initGitRepo();

function knownToGit(relPath) {
  if (fs.existsSync(path.join(DATA_ROOT, relPath))) return true;
  try {
    git(['cat-file', '-e', `HEAD:${relPath}`]);
    return true;
  } catch (e) {
    return false; // never existed on disk and never committed - nothing for git to reference
  }
}

function commitFile(relPathOrPaths, message) {
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

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

function readFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeFavorites(list) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function removeFavoritesUnder(relPath) {
  const favorites = readFavorites();
  const filtered = favorites.filter((p) => p !== relPath && !p.startsWith(relPath + '/'));
  if (filtered.length !== favorites.length) writeFavorites(filtered);
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

function isJsonYaml(name) {
  return /\.(json|yaml|yml)$/i.test(name);
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
    } else if (isJsonYaml(entry.name)) {
      children.push({ type: 'file', name: entry.name, path: rel });
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
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastRefresh() {
  for (const client of sseClients) client.write('data: refresh\n\n');
}

function listAllJsonYamlFiles(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listAllJsonYamlFiles(full, out);
    } else if (isJsonYaml(entry.name)) {
      out.push(path.relative(DATA_ROOT, full));
    }
  }
  return out;
}

let knownFiles = new Set(listAllJsonYamlFiles(DATA_ROOT, []));
let watchDebounce = null;

function reconcileWatchedFiles() {
  const current = new Set(listAllJsonYamlFiles(DATA_ROOT, []));
  const added = [...current].filter((p) => !knownFiles.has(p));
  const removed = [...knownFiles].filter((p) => !current.has(p));
  knownFiles = current;

  for (const p of added) {
    commitFile(p, `Auto-detected new file ${p}`);
  }
  for (const p of removed) {
    removeFavoritesUnder(p);
  }
  if (added.length || removed.length) broadcastRefresh();
}

try {
  fs.watch(DATA_ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename || filename.split(path.sep).some((part) => part === '.git')) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(reconcileWatchedFiles, 500);
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

function defaultContentFor(relPath) {
  if (/\.json$/i.test(relPath)) return '{}\n';
  if (/\.(yaml|yml)$/i.test(relPath)) return '';
  return '';
}

app.post('/api/file/create', (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    if (!isJsonYaml(relPath)) return res.status(400).json({ error: 'File must end in .json, .yaml or .yml' });
    const full = resolveSafe(relPath);
    if (fs.existsSync(full)) {
      return res.status(400).json({ error: 'A file already exists at that path' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, defaultContentFor(relPath), 'utf8');
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
  res.json({ favorites: readFavorites() });
});

app.post('/api/favorites/toggle', (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    resolveSafe(relPath);
    let favorites = readFavorites();
    if (favorites.includes(relPath)) {
      favorites = favorites.filter((p) => p !== relPath);
    } else {
      favorites.push(relPath);
    }
    writeFavorites(favorites);
    res.json({ favorites });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/file', (req, res) => {
  try {
    const full = resolveSafe(req.query.path);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    const content = fs.readFileSync(full, 'utf8');
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/file', (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

app.get('/api/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const results = [];
    const needle = q.toLowerCase();

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (isJsonYaml(entry.name)) {
          const rel = path.relative(DATA_ROOT, full);
          if (rel.toLowerCase().includes(needle)) {
            results.push({ path: rel, line: null, text: null, matchType: 'filename' });
          }
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200), matchType: 'content' });
              if (results.length >= 200) return;
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
  console.log(`JsonDocViewer running at ${hyperlink}`);
}

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) console.log(`(Could not auto-open browser: ${err.message})`);
  });
}

const server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  const url = `http://localhost:${actualPort}`;
  printLink(url);
  console.log(`Serving files from: ${DATA_ROOT}`);
  openInBrowser(url);
});

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
