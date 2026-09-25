let editor = null;
let currentPath = null;
let currentLang = null; // Monaco language id used for syntax highlighting
let currentDataFormat = null; // 'json' | 'yaml' | null - drives validation & conversion
let isDirty = false;
let autoSaveEnabled = true;
let autoSaveTimer = null;

const treeEl = document.getElementById('tree');
const currentPathEl = document.getElementById('current-path');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save-btn');
const convertBtn = document.getElementById('convert-btn');
const historyBtn = document.getElementById('history-btn');
const commitBtn = document.getElementById('commit-btn');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyTitle = document.getElementById('history-title');
const autosaveCheckbox = document.getElementById('autosave-checkbox');
const backToLatestBtn = document.getElementById('back-to-latest-btn');
const favoritesList = document.getElementById('favorites-list');
const findInFileBtn = document.getElementById('find-in-file-btn');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const expandAllBtn = document.getElementById('expand-all-btn');
const viewToggleBtn = document.getElementById('view-toggle-btn');
const htmlPreviewFrame = document.getElementById('html-preview-frame');
let viewMode = 'code'; // 'code' | 'render' - only meaningful for .html/.htm files
const newFolderBtn = document.getElementById('new-folder-btn');
const newFileBtn = document.getElementById('new-file-btn');
const saveAsBtn = document.getElementById('saveas-btn');

function setStatus(text, cls) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function langForPath(p) {
  if (/\.json$/i.test(p)) return 'json';
  if (/\.(yaml|yml)$/i.test(p)) return 'yaml';
  return null;
}

const EXTENSION_TO_MONACO_LANG = {
  json: 'json', yaml: 'yaml', yml: 'yaml',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  xml: 'xml', sql: 'sql', md: 'markdown', markdown: 'markdown',
  ini: 'ini', toml: 'ini', env: 'ini', conf: 'ini',
  dockerfile: 'dockerfile', txt: 'plaintext', log: 'plaintext',
};

function monacoLanguageForPath(p) {
  const name = p.split('/').pop();
  const match = name.match(/\.([^.]+)$/);
  const ext = match ? match[1].toLowerCase() : name.toLowerCase();
  return EXTENSION_TO_MONACO_LANG[ext] || 'plaintext';
}

function iconForFile(p) {
  const fmt = langForPath(p);
  if (fmt === 'json') return '{}';
  if (fmt === 'yaml') return 'y:';
  return '📄';
}

// --- Minimal JSON tokenizer/parser used only to find line numbers of
// duplicate keys within the same object literal (JSON.parse silently
// overwrites duplicates and gives no way to detect them).
function findJsonDuplicateKeys(text) {
  const issues = [];
  const len = text.length;
  let i = 0;
  let line = 1;

  function advance(n) {
    for (let k = 0; k < n; k++) {
      if (text[i] === '\n') line++;
      i++;
    }
  }
  function skipWs() {
    while (i < len && /\s/.test(text[i])) advance(1);
  }
  function parseString() {
    const start = i;
    advance(1); // opening quote
    while (i < len) {
      if (text[i] === '\\') { advance(2); continue; }
      if (text[i] === '"') { advance(1); break; }
      advance(1);
    }
    return text.slice(start, i);
  }
  function parseValue() {
    skipWs();
    if (i >= len) return;
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') { parseString(); return; }
    // number / true / false / null
    while (i < len && !/[\s,}\]]/.test(text[i])) advance(1);
  }
  function parseArray() {
    advance(1); // [
    skipWs();
    while (i < len && text[i] !== ']') {
      parseValue();
      skipWs();
      if (text[i] === ',') { advance(1); skipWs(); }
    }
    if (text[i] === ']') advance(1);
  }
  function parseObject() {
    advance(1); // {
    const seen = new Map();
    skipWs();
    while (i < len && text[i] !== '}') {
      skipWs();
      if (text[i] !== '"') { // malformed, bail
        while (i < len && text[i] !== '}' && text[i] !== ',') advance(1);
      } else {
        const keyLine = line;
        const raw = parseString();
        let key;
        try { key = JSON.parse(raw); } catch (e) { key = raw; }
        skipWs();
        if (text[i] === ':') advance(1);
        if (seen.has(key)) {
          issues.push({ line: keyLine, message: `Duplicate key "${key}" (first defined on line ${seen.get(key)})` });
        } else {
          seen.set(key, keyLine);
        }
        parseValue();
      }
      skipWs();
      if (text[i] === ',') { advance(1); skipWs(); }
    }
    if (text[i] === '}') advance(1);
  }

  try {
    skipWs();
    parseValue();
  } catch (e) {
    // best-effort only; real syntax errors are reported by JSON.parse separately
  }
  return issues;
}

function jsonParseErrorToMarker(text, err) {
  const msg = err.message || 'Invalid JSON';
  const match = msg.match(/position (\d+)/);
  let line = 1, col = 1;
  if (match) {
    const pos = parseInt(match[1], 10);
    const before = text.slice(0, pos);
    const lines = before.split('\n');
    line = lines.length;
    col = lines[lines.length - 1].length + 1;
  }
  return { line, col, message: msg };
}

function validateJson(text) {
  const markers = [];
  try {
    JSON.parse(text);
    const dups = findJsonDuplicateKeys(text);
    for (const d of dups) {
      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        startLineNumber: d.line, startColumn: 1,
        endLineNumber: d.line, endColumn: 1000,
        message: d.message,
      });
    }
    return { valid: true, markers };
  } catch (err) {
    const m = jsonParseErrorToMarker(text, err);
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: m.line, startColumn: m.col,
      endLineNumber: m.line, endColumn: m.col + 1,
      message: m.message,
    });
    return { valid: false, markers };
  }
}

function validateYaml(text) {
  const markers = [];
  try {
    jsyaml.load(text);
    return { valid: true, markers };
  } catch (err) {
    let line = 1, col = 1;
    if (err.mark) {
      line = err.mark.line + 1;
      col = err.mark.column + 1;
    }
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: line, startColumn: col,
      endLineNumber: line, endColumn: col + 1,
      message: err.reason || err.message,
    });
    return { valid: false, markers };
  }
}

function runValidation() {
  if (!editor || !currentPath) return;
  convertBtn.disabled = !currentDataFormat;

  if (!currentDataFormat) {
    monaco.editor.setModelMarkers(editor.getModel(), 'corruption', []);
    setStatus(isDirty ? 'Modified (unsaved)' : '', isDirty ? 'dirty' : '');
    return;
  }

  const text = editor.getValue();
  const model = editor.getModel();
  const result = currentDataFormat === 'json' ? validateJson(text) : validateYaml(text);
  monaco.editor.setModelMarkers(model, 'corruption', result.markers);

  const errorCount = result.markers.filter(m => m.severity === monaco.MarkerSeverity.Error).length;
  const warnCount = result.markers.filter(m => m.severity === monaco.MarkerSeverity.Warning).length;

  if (errorCount > 0) {
    setStatus(`Invalid ${currentDataFormat.toUpperCase()} — ${errorCount} error(s)`, 'error');
  } else if (warnCount > 0) {
    setStatus(`Valid, but ${warnCount} duplicate key warning(s)`, 'dirty');
  } else if (isDirty) {
    setStatus('Modified (unsaved)', 'dirty');
  } else {
    setStatus('Valid', 'ok');
  }
  convertBtn.disabled = errorCount > 0;
}

// --- Monaco bootstrap ---
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs' } });
require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '',
    language: 'json',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 13,
  });
  editor.onDidChangeModelContent(() => {
    if (currentPath) {
      isDirty = true;
      saveBtn.disabled = false;
      runValidation();
      if (autoSaveEnabled) scheduleAutoSave();
    }
  });
  loadTree();
});

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveCurrentFile();
  }, 800);
}

// --- File tree ---
let favorites = [];
let expandedFolders = new Set();
let lastTreeChildren = [];

async function loadTree() {
  const [treeRes] = await Promise.all([fetch('/api/tree'), loadFavorites()]);
  const data = await treeRes.json();
  lastTreeChildren = data.children;
  treeEl.innerHTML = '';
  treeEl.appendChild(renderNodes(data.children));
  renderFavorites();
}

function findNodeByPath(nodes, targetPath) {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.type === 'dir') {
      const found = findNodeByPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function revealInTree(relPath) {
  const segments = relPath.split('/');
  let prefix = '';
  for (let i = 0; i < segments.length - 1; i++) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
    expandedFolders.add(prefix);
  }
  expandedFolders.add(relPath);
  loadTree().then(() => {
    const row = document.querySelector(`.tree-row[data-path="${CSS.escape(relPath)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('drop-target');
      setTimeout(() => row.classList.remove('drop-target'), 900);
    }
  });
}

treeEl.addEventListener('dragover', (e) => {
  if (e.target === treeEl) e.preventDefault();
});
treeEl.addEventListener('drop', (e) => {
  if (e.target !== treeEl) return; // only handle drops on empty tree space, not bubbled from rows
  e.preventDefault();
  const fromPath = e.dataTransfer.getData('text/plain');
  if (fromPath) moveFile(fromPath, null);
});

const sidebarHeaderEl = document.getElementById('sidebar-header');
sidebarHeaderEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  sidebarHeaderEl.classList.add('drop-target');
});
sidebarHeaderEl.addEventListener('dragleave', () => sidebarHeaderEl.classList.remove('drop-target'));
sidebarHeaderEl.addEventListener('drop', (e) => {
  e.preventDefault();
  sidebarHeaderEl.classList.remove('drop-target');
  const fromPath = e.dataTransfer.getData('text/plain');
  if (fromPath) moveFile(fromPath, null);
});

async function loadFavorites() {
  const res = await fetch('/api/favorites');
  const data = await res.json();
  favorites = data.favorites || [];
}

function makeStarButton(relPath) {
  const star = document.createElement('button');
  star.className = 'star-btn' + (favorites.includes(relPath) ? ' favorited' : '');
  star.textContent = favorites.includes(relPath) ? '★' : '☆';
  star.title = favorites.includes(relPath) ? 'Remove from favorites' : 'Add to favorites';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await fetch('/api/favorites/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath }),
    });
    const data = await res.json();
    favorites = data.favorites || [];
    document.querySelectorAll(`.star-btn[data-fav-path="${CSS.escape(relPath)}"]`).forEach((btn) => {
      const isFav = favorites.includes(relPath);
      btn.classList.toggle('favorited', isFav);
      btn.textContent = isFav ? '★' : '☆';
      btn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
    });
    renderFavorites();
  });
  star.dataset.favPath = relPath;
  return star;
}

function renderFavorites() {
  favoritesList.innerHTML = '';
  for (const favPath of favorites) {
    const node = findNodeByPath(lastTreeChildren, favPath);
    const isDir = node ? node.type === 'dir' : false;

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = favPath;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = isDir ? '📁' : iconForFile(favPath);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = favPath;
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(makeStarButton(favPath));
    if (isDir) {
      row.addEventListener('click', () => revealInTree(favPath));
    } else {
      row.appendChild(makeDeleteFileButton(favPath));
      row.addEventListener('click', () => openFile(favPath));
    }
    favoritesList.appendChild(row);
  }
}

async function deleteItem(relPath, { endpoint, kind, confirmMessage }) {
  if (!confirm(confirmMessage)) return;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Delete failed: ' + data.error);
    return;
  }
  favorites = favorites.filter((p) => p !== relPath && !p.startsWith(relPath + '/'));
  expandedFolders.forEach((p) => {
    if (p === relPath || p.startsWith(relPath + '/')) expandedFolders.delete(p);
  });
  if (currentPath && (currentPath === relPath || currentPath.startsWith(relPath + '/'))) {
    currentPath = null;
    currentLang = null;
    currentDataFormat = null;
    currentPathEl.textContent = 'No file open';
    saveBtn.disabled = true;
    saveAsBtn.disabled = true;
    convertBtn.disabled = true;
    historyBtn.disabled = true;
    commitBtn.disabled = true;
    findInFileBtn.disabled = true;
    collapseAllBtn.disabled = true;
    expandAllBtn.disabled = true;
    viewToggleBtn.classList.add('hidden');
    setViewMode('code');
  }
  await loadTree();

  const commitMsg = prompt(
    `${kind} deleted. Commit this deletion to history?\nEnter a commit message, or cancel to leave it uncommitted:`,
    `Delete ${kind.toLowerCase()} ${relPath}`
  );
  if (commitMsg === null) return;
  const commitRes = await fetch('/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, message: commitMsg.trim() }),
  });
  const commitData = await commitRes.json();
  if (!commitRes.ok) {
    alert('Commit failed: ' + commitData.error);
  } else if (!commitData.commit) {
    setStatus('Nothing to commit for that deletion', 'dirty');
  } else {
    setStatus('Deletion committed', 'ok');
  }
}

function makeDeleteFolderButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn';
  btn.textContent = '✖';
  btn.title = 'Delete folder';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(relPath, {
      endpoint: '/api/folder/delete',
      kind: 'Folder',
      confirmMessage: `Delete folder "${relPath}" and everything inside it? This cannot be undone on disk.`,
    });
  });
  return btn;
}

function makeDeleteFileButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn';
  btn.textContent = '✖';
  btn.title = 'Delete file';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(relPath, {
      endpoint: '/api/file/delete',
      kind: 'File',
      confirmMessage: `Delete "${relPath}"? This cannot be undone on disk.`,
    });
  });
  return btn;
}

async function createFolder(parentPath) {
  const promptLabel = parentPath
    ? `New subfolder name inside "${parentPath}":`
    : 'New folder path (relative to data/, e.g. "reports" or "reports/2026"):';
  const name = prompt(promptLabel);
  if (!name || !name.trim()) return;
  const fullPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();

  const res = await fetch('/api/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Could not create folder: ' + data.error);
    return;
  }
  if (parentPath) expandedFolders.add(parentPath);
  await loadTree();
  setStatus('Folder created and committed', 'ok');
}

newFolderBtn.addEventListener('click', () => createFolder(null));

function makeNewSubfolderButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn';
  btn.textContent = '+📁';
  btn.title = 'New subfolder here';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    createFolder(relPath);
  });
  return btn;
}

async function createFile(parentPath) {
  const promptLabel = parentPath
    ? `New file name inside "${parentPath}" (any file type, e.g. "config.json", "notes.md"):`
    : 'New file path (relative to data/, e.g. "config.json" or "reports/notes.md"):';
  const name = prompt(promptLabel);
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  const fullPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;

  const res = await fetch('/api/file/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Could not create file: ' + data.error);
    return;
  }
  if (parentPath) expandedFolders.add(parentPath);
  await loadTree();
  setStatus('File created and committed', 'ok');
  await openFile(fullPath);
}

newFileBtn.addEventListener('click', () => createFile(null));

function makeNewFileButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn';
  btn.textContent = '+📄';
  btn.title = 'New file here';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    createFile(relPath);
  });
  return btn;
}

saveAsBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  const newPath = prompt('Save as (relative to data/):', currentPath);
  if (newPath === null) return;
  const trimmed = newPath.trim();
  if (!trimmed) {
    alert('Filename cannot be empty.');
    return;
  }
  const content = editor.getValue();
  const res = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: trimmed, content }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Save As failed: ' + data.error);
    return;
  }
  await loadTree();
  await openFile(trimmed);
});

// --- Move (drag and drop) ---
async function moveFile(fromPath, toFolderPath) {
  if (toFolderPath && (toFolderPath === fromPath || toFolderPath.startsWith(fromPath + '/'))) {
    alert('Cannot move a folder into itself or one of its own subfolders.');
    return;
  }
  const name = fromPath.split('/').pop();
  const toPath = toFolderPath ? `${toFolderPath}/${name}` : name;
  if (toPath === fromPath) return;

  const res = await fetch('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromPath, to: toPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Move failed: ' + data.error);
    return;
  }
  const wasCurrent = currentPath === fromPath;
  const updatedExpanded = new Set();
  expandedFolders.forEach((p) => {
    if (p === fromPath) updatedExpanded.add(toPath);
    else if (p.startsWith(fromPath + '/')) updatedExpanded.add(toPath + p.slice(fromPath.length));
    else updatedExpanded.add(p);
  });
  if (toFolderPath) updatedExpanded.add(toFolderPath);
  expandedFolders = updatedExpanded;
  await loadTree();
  if (wasCurrent) {
    currentPath = toPath;
    currentPathEl.textContent = toPath;
    highlightActiveRow(toPath);
  }

  const commitMsg = prompt(
    `Moved "${fromPath}" to "${toPath}". Commit this move to history?\nEnter a commit message, or cancel to leave it uncommitted:`,
    `Move ${fromPath} -> ${toPath}`
  );
  if (commitMsg === null) return;
  const commitRes = await fetch('/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [fromPath, toPath], message: commitMsg.trim() }),
  });
  const commitData = await commitRes.json();
  if (!commitRes.ok) {
    alert('Commit failed: ' + commitData.error);
  } else if (!commitData.commit) {
    setStatus('Nothing to commit for that move', 'dirty');
  } else {
    setStatus('Move committed', 'ok');
  }
}

function renderNodes(nodes) {
  const container = document.createElement('div');
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node.path;

    if (node.type === 'dir') {
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '▸';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(makeStarButton(node.path));
      row.appendChild(makeNewFileButton(node.path));
      row.appendChild(makeNewSubfolderButton(node.path));
      row.appendChild(makeDeleteFolderButton(node.path));

      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target');
        const fromPath = e.dataTransfer.getData('text/plain');
        if (fromPath && fromPath !== node.path) moveFile(fromPath, node.path);
      });

      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-node';
      const childrenEl = renderNodes(node.children);
      const isExpanded = expandedFolders.has(node.path);
      childrenEl.classList.add('tree-children');
      if (!isExpanded) childrenEl.classList.add('collapsed');
      icon.textContent = isExpanded ? '▾' : '▸';
      childrenWrap.appendChild(childrenEl);

      row.addEventListener('click', () => {
        const collapsed = childrenEl.classList.toggle('collapsed');
        icon.textContent = collapsed ? '▸' : '▾';
        if (collapsed) expandedFolders.delete(node.path);
        else expandedFolders.add(node.path);
      });

      container.appendChild(row);
      container.appendChild(childrenWrap);
    } else {
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = iconForFile(node.name);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(makeStarButton(node.path));
      row.appendChild(makeDeleteFileButton(node.path));
      row.addEventListener('click', () => openFile(node.path));

      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));

      container.appendChild(row);
    }
  }
  return container;
}

function highlightActiveRow(path) {
  document.querySelectorAll('.tree-row').forEach(r => r.classList.remove('active'));
  const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.classList.add('active');
}

async function openFile(relPath, lineToReveal) {
  if (isDirty && !confirm('Discard unsaved changes?')) return;
  const res = await fetch('/api/file?path=' + encodeURIComponent(relPath));
  const data = await res.json();
  if (!res.ok) {
    alert('Failed to open file: ' + data.error);
    return;
  }
  currentPath = relPath;
  currentLang = monacoLanguageForPath(relPath);
  currentDataFormat = langForPath(relPath);
  currentPathEl.textContent = relPath;
  isDirty = false;
  saveBtn.disabled = false;
  historyBtn.disabled = false;
  commitBtn.disabled = false;
  findInFileBtn.disabled = false;
  saveAsBtn.disabled = false;
  collapseAllBtn.disabled = false;
  expandAllBtn.disabled = false;
  backToLatestBtn.classList.add('hidden');

  const model = monaco.editor.createModel(data.content, currentLang);
  editor.setModel(model);
  highlightActiveRow(relPath);
  runValidation();

  if (lineToReveal) {
    editor.revealLineInCenter(lineToReveal);
    editor.setPosition({ lineNumber: lineToReveal, column: 1 });
    editor.focus();
  }

  const isHtml = /\.html?$/i.test(relPath);
  if (isHtml) {
    viewToggleBtn.classList.remove('hidden');
    setViewMode('render');
  } else {
    viewToggleBtn.classList.add('hidden');
    setViewMode('code');
  }
}

function setViewMode(mode) {
  viewMode = mode;
  if (mode === 'render') {
    htmlPreviewFrame.srcdoc = editor.getValue();
    htmlPreviewFrame.classList.remove('hidden');
    document.getElementById('editor').classList.add('hidden');
    viewToggleBtn.textContent = 'View Source 💻';
  } else {
    htmlPreviewFrame.classList.add('hidden');
    document.getElementById('editor').classList.remove('hidden');
    viewToggleBtn.textContent = 'View Rendered 👁️';
  }
}

viewToggleBtn.addEventListener('click', () => {
  setViewMode(viewMode === 'render' ? 'code' : 'render');
});

// --- Save ---
async function saveCurrentFile() {
  if (!currentPath) return;
  const content = editor.getValue();
  const res = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, content }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Save failed: ' + data.error);
    return;
  }
  isDirty = false;
  runValidation();
}

saveBtn.addEventListener('click', saveCurrentFile);

collapseAllBtn.addEventListener('click', () => {
  if (!editor) return;
  editor.getAction('editor.foldAll').run();
});

expandAllBtn.addEventListener('click', () => {
  if (!editor) return;
  editor.getAction('editor.unfoldAll').run();
});

findInFileBtn.addEventListener('click', () => {
  if (!editor) return;
  editor.focus();
  editor.getAction('actions.find').run();
});

function defaultCommitMessage() {
  const now = new Date();
  return `Snapshot ${now.toLocaleString()}`;
}

commitBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  if (isDirty) await saveCurrentFile();

  const message = prompt('Commit message for this version:', defaultCommitMessage());
  if (message === null) return; // cancelled

  const res = await fetch('/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, message: message.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Commit failed: ' + data.error);
    return;
  }
  if (!data.commit) {
    setStatus('Nothing to commit — no changes since last version', 'dirty');
  } else {
    setStatus('Committed new version', 'ok');
  }
});

autosaveCheckbox.addEventListener('change', () => {
  autoSaveEnabled = autosaveCheckbox.checked;
  if (autoSaveEnabled && isDirty) scheduleAutoSave();
});

// --- Search ---
let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 300);
});

document.addEventListener('click', (e) => {
  if (!searchResultsEl.contains(e.target) && e.target !== searchInput) {
    searchResultsEl.classList.add('hidden');
  }
});

async function runSearch(q) {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const data = await res.json();
  searchResultsEl.innerHTML = '';
  if (!data.results || data.results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No matches';
    searchResultsEl.appendChild(empty);
  } else {
    for (const r of data.results) {
      const item = document.createElement('div');
      item.className = 'search-item';
      const pathEl = document.createElement('span');
      pathEl.className = 'sr-path';
      pathEl.textContent = r.line ? `${r.path}:${r.line}` : r.path;
      item.appendChild(pathEl);
      if (r.text) {
        const snippet = document.createElement('span');
        snippet.className = 'sr-snippet';
        snippet.textContent = r.text;
        item.appendChild(snippet);
      }
      item.addEventListener('click', () => {
        openFile(r.path, r.line || undefined);
        searchResultsEl.classList.add('hidden');
      });
      searchResultsEl.appendChild(item);
    }
  }
  searchResultsEl.classList.remove('hidden');
}

// --- History / versioning ---
historyBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  historyTitle.textContent = `History: ${currentPath}`;
  historyList.innerHTML = '<div class="search-empty">Loading...</div>';
  historyModal.classList.remove('hidden');

  const res = await fetch('/api/history?path=' + encodeURIComponent(currentPath));
  const data = await res.json();
  historyList.innerHTML = '';
  if (!res.ok) {
    historyList.innerHTML = `<div class="search-empty">Error: ${data.error}</div>`;
    return;
  }
  if (!data.commits || data.commits.length === 0) {
    historyList.innerHTML = '<div class="search-empty">No versions yet for this file. Use Commit to create the first one.</div>';
    return;
  }
  data.commits.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item' + (idx === 0 ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'hi-info';
    const msg = document.createElement('div');
    msg.className = 'hi-msg';
    msg.textContent = c.message + (idx === 0 ? ' (current)' : '');
    const meta = document.createElement('div');
    meta.className = 'hi-meta';
    meta.textContent = `${c.hash.slice(0, 7)} • ${new Date(c.date).toLocaleString()}`;
    info.appendChild(msg);
    info.appendChild(meta);
    item.appendChild(info);

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => viewVersion(c.hash));
    item.appendChild(viewBtn);

    if (idx !== 0) {
      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', () => restoreVersion(c.hash));
      item.appendChild(restoreBtn);
    }

    historyList.appendChild(item);
  });
});

document.getElementById('history-close').addEventListener('click', () => {
  historyModal.classList.add('hidden');
});
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) historyModal.classList.add('hidden');
});

async function viewVersion(hash) {
  const res = await fetch(`/api/version?path=${encodeURIComponent(currentPath)}&hash=${encodeURIComponent(hash)}`);
  const data = await res.json();
  if (!res.ok) {
    alert('Failed to load version: ' + data.error);
    return;
  }
  const model = monaco.editor.createModel(data.content, currentLang);
  editor.setModel(model);
  editor.updateOptions({ readOnly: true });
  currentPathEl.textContent = `${currentPath} @ ${hash.slice(0, 7)} (read-only preview)`;
  historyModal.classList.add('hidden');
  saveBtn.disabled = true;
  setStatus('Viewing old version', 'dirty');
  backToLatestBtn.classList.remove('hidden');
}

backToLatestBtn.addEventListener('click', () => {
  editor.updateOptions({ readOnly: false });
  backToLatestBtn.classList.add('hidden');
  openFile(currentPath);
});

async function restoreVersion(hash) {
  if (!confirm(`Restore this file to commit ${hash.slice(0, 7)}? This creates a new version with that content.`)) return;
  const res = await fetch('/api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, hash }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Restore failed: ' + data.error);
    return;
  }
  editor.updateOptions({ readOnly: false });
  historyModal.classList.add('hidden');
  await openFile(currentPath);
}


// --- Convert JSON <-> YAML ---
convertBtn.addEventListener('click', async () => {
  if (!currentPath || !currentDataFormat) return;
  const from = currentDataFormat;
  const to = from === 'json' ? 'yaml' : 'json';
  const content = editor.getValue();

  const res = await fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, from, to }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Conversion failed: ' + data.error);
    return;
  }

  const defaultPath = currentPath.replace(/\.[^.]+$/, to === 'json' ? '.json' : '.yaml');
  const newPath = prompt(
    `Convert ${from.toUpperCase()} -> ${to.toUpperCase()}\nEnter filename to save as (relative to data/), or cancel to just preview unsaved:`,
    defaultPath
  );

  if (newPath === null) {
    // Cancelled: just preview the converted content, unsaved.
    currentLang = to;
    currentDataFormat = to;
    const model = monaco.editor.createModel(data.output, to);
    editor.setModel(model);
    isDirty = true;
    saveBtn.disabled = false;
    currentPathEl.textContent = defaultPath + ' (unsaved conversion)';
    runValidation();
    return;
  }

  const trimmed = newPath.trim();
  if (!trimmed) {
    alert('Filename cannot be empty.');
    return;
  }

  const saveRes = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: trimmed, content: data.output }),
  });
  if (!saveRes.ok) {
    const err = await saveRes.json();
    alert('Save failed: ' + err.error);
    return;
  }
  await loadTree();
  await openFile(trimmed);
});

document.getElementById('refresh-btn').addEventListener('click', loadTree);

// --- Live sync with files changed outside the app ---
function connectLiveSync() {
  const source = new EventSource('/api/events');
  source.onmessage = () => {
    loadTree();
    setStatus('Detected external changes — tree refreshed', 'dirty');
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectLiveSync, 2000);
  };
}
connectLiveSync();
