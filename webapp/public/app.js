let editor = null;
let currentPath = null;
let currentLang = null; // Monaco language id used for syntax highlighting
let currentDataFormat = null; // 'json' | 'yaml' | null - drives validation & conversion
let isDirty = false;
let ignoreDirtyUntil = 0;
let openToken = 0;
let saveInFlight = null;
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
const pdfFrame = document.getElementById('pdf-frame');
const mindmapStage = document.getElementById('mindmap-stage');
const bookmarkAddCatBtn = document.getElementById('bookmark-add-cat');
let viewMode = 'code'; // 'code' | 'render' | 'board' | 'pdf'
let boardEngine = null;
let boardKind = null; // 'mindmap' | 'flow' | null
let suppressEditorChange = false;
const newFileBtn = document.getElementById('new-file-btn');
const importBtn = document.getElementById('import-btn');
const exportAllBtn = document.getElementById('export-all-btn');
const exportFileBtn = document.getElementById('export-file-btn');
const standaloneBtn = document.getElementById('standalone-btn');
const importFileInput = document.getElementById('import-file');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const mainEl = document.getElementById('main');
const saveAsBtn = document.getElementById('saveas-btn');
const askModal = document.getElementById('ask-modal');
const askTitle = document.getElementById('ask-title');
const askLabel = document.getElementById('ask-label');
const askInput = document.getElementById('ask-input');
const askKinds = document.getElementById('ask-kinds');
const askHint = document.getElementById('ask-hint');
const askOk = document.getElementById('ask-ok');
const askCancel = document.getElementById('ask-cancel');
const askExtra = document.getElementById('ask-extra');
const askClose = document.getElementById('ask-close');
const themeBtn = document.getElementById('theme-btn');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const SIDEBAR_KEY = 'docviewer-sidebar';

function sidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
}
function applySidebarCollapsed(collapsed) {
  document.getElementById('app').classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open'); } catch (e) { /* ignore */ }
  if (sidebarToggleBtn) {
    sidebarToggleBtn.title = collapsed ? 'Show Project (Alt+1)' : 'Hide Project (Alt+1)';
    sidebarToggleBtn.setAttribute('aria-label', sidebarToggleBtn.title);
    sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
  }
}
applySidebarCollapsed(sidebarCollapsed());
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => applySidebarCollapsed(!sidebarCollapsed()));
}
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === '1' || e.code === 'Digit1')) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    applySidebarCollapsed(!sidebarCollapsed());
  }
});

const THEME_KEY = 'docviewer-theme';
function currentTheme() {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}
function applyAppTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  if (themeBtn) themeBtn.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
  if (window.monaco) monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
}
applyAppTheme(currentTheme());
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    applyAppTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
}

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

function isPdfPath(p) {
  return /\.pdf$/i.test(p || '');
}

function applyFileIcon(el, p, kind) {
  el.classList.remove('icon-mindmap', 'icon-flow', 'icon-kanban', 'icon-gantt', 'icon-json', 'icon-yaml', 'icon-pdf');
  if (kind === 'pdf' || isPdfPath(p)) {
    el.classList.add('icon-pdf');
    el.textContent = 'PDF';
    el.title = 'PDF';
    return;
  }
  if (kind === 'mindmap') {
    el.classList.add('icon-mindmap');
    el.textContent = 'MM';
    el.title = 'Mindmap';
    return;
  }
  if (kind === 'flow') {
    el.classList.add('icon-flow');
    el.textContent = 'FL';
    el.title = 'Flow';
    return;
  }
  if (kind === 'kanban') {
    el.classList.add('icon-kanban');
    el.textContent = 'KB';
    el.title = 'Kanban';
    return;
  }
  if (kind === 'gantt') {
    el.classList.add('icon-gantt');
    el.textContent = 'GT';
    el.title = 'Gantt';
    return;
  }
  const fmt = langForPath(p);
  if (fmt === 'json') {
    el.classList.add('icon-json');
    el.textContent = '{}';
    return;
  }
  if (fmt === 'yaml') {
    el.classList.add('icon-yaml');
    el.textContent = 'YML';
    return;
  }
  el.textContent = '📄';
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
    theme: currentTheme() === 'light' ? 'vs' : 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 13,
  });
  editor.onDidChangeModelContent(() => {
    if (suppressEditorChange) return;
    noteUnsaved();
  });
  loadTree();
});

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  if (!autoSaveEnabled || !isDirty || saveInFlight) return;
  autoSaveTimer = setTimeout(() => {
    if (!isDirty || saveInFlight) return;
    saveCurrentFile();
  }, 800);
}

// --- File tree ---
let bookmarks = { categories: [], items: [] };
let expandedFolders = new Set();
let lastTreeChildren = [];

let loadTreeInflight = null;
async function loadTree() {
  if (loadTreeInflight) return loadTreeInflight;
  loadTreeInflight = (async () => {
    const [treeRes] = await Promise.all([fetch('/api/tree'), loadFavorites()]);
    const data = await treeRes.json();
    lastTreeChildren = data.children;
    treeEl.innerHTML = '';
    treeEl.appendChild(renderNodes(data.children));
    renderFavorites();
  })().finally(() => {
    loadTreeInflight = null;
  });
  return loadTreeInflight;
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
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    importFileList(e.dataTransfer.files, '');
    return;
  }
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
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    importFileList(e.dataTransfer.files, '');
    return;
  }
  const fromPath = e.dataTransfer.getData('text/plain');
  if (fromPath) moveFile(fromPath, null);
});

function isFavorited(relPath) {
  return bookmarks.items.some((it) => it.path === relPath);
}

function applyBookmarkStore(data) {
  if (data && Array.isArray(data.categories) && Array.isArray(data.items)) {
    bookmarks = { categories: data.categories, items: data.items };
    return;
  }
  const paths = (data && data.favorites) || [];
  bookmarks = {
    categories: paths.length ? [{ id: 'c_default', name: 'Bookmarks', collapsed: false }] : [],
    items: paths.map((path) => ({ path, categoryId: 'c_default' })),
  };
}

function syncStarButtons() {
  document.querySelectorAll('.star-btn[data-fav-path]').forEach((btn) => {
    const on = isFavorited(btn.dataset.favPath);
    btn.classList.toggle('favorited', on);
    btn.textContent = on ? '★' : '☆';
    btn.title = on ? 'Remove bookmark' : 'Bookmark this file';
  });
}

async function loadFavorites() {
  const res = await fetch('/api/favorites');
  const data = await res.json();
  applyBookmarkStore(data);
}

async function postBookmarks(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Bookmark request failed');
  applyBookmarkStore(data);
  syncStarButtons();
  renderFavorites();
  return data;
}

async function pickBookmarkCategory() {
  if (bookmarks.categories.length === 0) {
    const name = await showAsk({
      title: 'New bookmark category',
      label: 'Category name',
      placeholder: 'Work, Reading, …',
      hint: 'Favorites are stored under a category you create.',
      confirmLabel: 'Create',
    });
    if (!name) return null;
    const data = await postBookmarks('/api/favorites/category', { name: String(name).trim() });
    return data.category && data.category.id;
  }
  if (bookmarks.categories.length === 1) return bookmarks.categories[0].id;
  const kinds = bookmarks.categories.map((c) => ({
    id: c.id,
    label: c.name,
    hint: 'Save under “' + c.name + '”',
    needsName: false,
  })).concat({
    id: '__new',
    label: '+ New',
    hint: 'Create a new category for this bookmark.',
    placeholder: 'Category name',
    needsName: true,
  });
  const result = await showAsk({
    title: 'Add bookmark',
    label: 'New category name',
    kinds,
    confirmLabel: 'Add',
  });
  if (!result) return null;
  if (result.kind === '__new') {
    const data = await postBookmarks('/api/favorites/category', { name: result.name.trim() });
    return data.category && data.category.id;
  }
  return result.kind;
}

function makeStarButton(relPath) {
  const star = document.createElement('button');
  star.className = 'star-btn' + (isFavorited(relPath) ? ' favorited' : '');
  star.textContent = isFavorited(relPath) ? '★' : '☆';
  star.title = isFavorited(relPath) ? 'Remove bookmark' : 'Bookmark this file';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (isFavorited(relPath)) {
        await postBookmarks('/api/favorites/toggle', { path: relPath });
        return;
      }
      const categoryId = await pickBookmarkCategory();
      if (!categoryId) return;
      await postBookmarks('/api/favorites/assign', { path: relPath, categoryId });
    } catch (err) {
      setStatus((err && err.message) || 'Bookmark failed', 'dirty');
    }
  });
  star.dataset.favPath = relPath;
  return star;
}

function renderFavorites() {
  if (!favoritesList) return;
  favoritesList.innerHTML = '';
  if (!bookmarks.categories.length) {
    const empty = document.createElement('div');
    empty.className = 'bookmark-empty';
    empty.textContent = 'Create a category, then star files to pin them here';
    favoritesList.appendChild(empty);
    return;
  }
  for (const cat of bookmarks.categories) {
    const group = document.createElement('div');
    group.className = 'bookmark-cat' + (cat.collapsed ? ' is-collapsed' : '');
    const items = bookmarks.items.filter((it) => it.categoryId === cat.id);

    const head = document.createElement('div');
    head.className = 'tree-row is-folder bookmark-cat-head';
    const twist = document.createElement('span');
    twist.className = 'twist';
    twist.textContent = cat.collapsed ? '▸' : '▾';
    const folderIcon = document.createElement('span');
    folderIcon.className = 'icon folder';
    folderIcon.setAttribute('aria-hidden', 'true');
    const catLabel = document.createElement('span');
    catLabel.className = 'label';
    catLabel.textContent = cat.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(items.length);
    const renameBtn = document.createElement('button');
    renameBtn.className = 'delete-btn';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Rename category';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = await showAsk({
        title: 'Rename category',
        label: 'Category name',
        value: cat.name,
        confirmLabel: 'Save',
      });
      if (!name) return;
      try {
        await postBookmarks('/api/favorites/category/update', { id: cat.id, name: String(name).trim() });
      } catch (err) {
        setStatus((err && err.message) || 'Rename failed', 'dirty');
      }
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete category';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showAsk({
        title: 'Delete category',
        label: 'Remove “' + cat.name + '” and its bookmarks?',
        hint: 'Files on disk are not deleted.',
        mode: 'confirm',
        danger: true,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try {
        await postBookmarks('/api/favorites/category/delete', { id: cat.id });
      } catch (err) {
        setStatus((err && err.message) || 'Delete failed', 'dirty');
      }
    });
    head.appendChild(twist);
    head.appendChild(folderIcon);
    head.appendChild(catLabel);
    head.appendChild(count);
    head.appendChild(renameBtn);
    head.appendChild(delBtn);
    head.addEventListener('click', () => {
      postBookmarks('/api/favorites/category/update', { id: cat.id, collapsed: !cat.collapsed }).catch((err) => {
        setStatus((err && err.message) || 'Update failed', 'dirty');
      });
    });
    head.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      head.classList.add('drop-target');
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
    head.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      head.classList.remove('drop-target');
      const fromPath = e.dataTransfer.getData('text/plain');
      if (!fromPath) return;
      try {
        await postBookmarks('/api/favorites/assign', { path: fromPath, categoryId: cat.id });
      } catch (err) {
        setStatus((err && err.message) || 'Bookmark failed', 'dirty');
      }
    });
    group.appendChild(head);

    if (!cat.collapsed) {
      const list = document.createElement('div');
      list.className = 'tree-branch bookmark-cat-items';
      if (!items.length) {
        const hint = document.createElement('div');
        hint.className = 'bookmark-empty';
        hint.textContent = 'Star a file or drop it here';
        list.appendChild(hint);
      }
      for (const it of items) {
        const node = findNodeByPath(lastTreeChildren, it.path);
        const isDir = !!(node && node.type === 'dir');
        const row = document.createElement('div');
        row.className = 'tree-row ' + (isDir ? 'is-folder' : 'is-file');
        row.dataset.path = it.path;
        const icon = document.createElement('span');
        icon.className = 'icon';
        if (isDir) {
          icon.classList.add('folder');
          icon.setAttribute('aria-hidden', 'true');
        } else applyFileIcon(icon, it.path, node && node.kind);
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = it.path;
        row.appendChild(icon);
        row.appendChild(label);
        row.appendChild(makeStarButton(it.path));
        row.addEventListener('click', () => {
          if (isDir) revealInTree(it.path);
          else openFile(it.path);
        });
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/plain', it.path);
          e.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        list.appendChild(row);
      }
      group.appendChild(list);
    }
    favoritesList.appendChild(group);
  }
}

async function deleteItem(relPath, { endpoint, kind, confirmMessage }) {
  const confirmed = await showAsk({
    title: `Delete ${kind.toLowerCase()}`,
    label: confirmMessage,
    hint: 'This cannot be undone on disk.',
    mode: 'confirm',
    danger: true,
    confirmLabel: 'Delete',
  });
  if (!confirmed) return;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus('Delete failed: ' + data.error, 'dirty');
    return;
  }
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
    if (exportFileBtn) exportFileBtn.disabled = true;
    setStandaloneVisible(false);
    if (fullscreenBtn) fullscreenBtn.disabled = true;
    if (document.fullscreenElement === mainEl || document.webkitFullscreenElement === mainEl) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
    convertBtn.disabled = true;
    historyBtn.disabled = true;
    commitBtn.disabled = true;
    findInFileBtn.disabled = true;
    collapseAllBtn.disabled = true;
    expandAllBtn.disabled = true;
    viewToggleBtn.classList.add('hidden');
    destroyBoard();
    setViewMode('code');
  }
  await loadTree();

  const commitMsg = await showAsk({
    title: 'Commit deletion',
    label: 'Commit message',
    hint: 'Cancel to leave this deletion uncommitted.',
    value: `Delete ${kind.toLowerCase()} ${relPath}`,
    placeholder: `Delete ${kind.toLowerCase()} ${relPath}`,
    confirmLabel: 'Commit',
  });
  if (commitMsg === null) return;
  const commitRes = await fetch('/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, message: commitMsg.trim() }),
  });
  const commitData = await commitRes.json();
  if (!commitRes.ok) {
    setStatus('Commit failed: ' + commitData.error, 'dirty');
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

async function createFolder(parentPath, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const fullPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;

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

async function createFile(parentPath, name) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) return;
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

async function createBoardFile(parentPath, name, kind) {
  let trimmed = (name || '').trim();
  if (!trimmed) return;
  if (!/\.html?$/i.test(trimmed)) trimmed += '.html';
  const fullPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;
  const label = BOARD_LABELS[kind] || 'board';

  const res = await fetch('/api/file/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath, kind }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert('Could not create ' + label + ': ' + data.error);
    return;
  }
  if (parentPath) expandedFolders.add(parentPath);
  await loadTree();
  setStatus(label.charAt(0).toUpperCase() + label.slice(1) + ' created and committed', 'ok');
  await openFile(fullPath);
}

const BOARD_LABELS = { mindmap: 'mindmap', flow: 'flow', kanban: 'kanban', gantt: 'gantt' };

const CREATE_KINDS = [
  { id: 'file', label: 'File', hint: 'Any file. Include an extension, e.g. notes.json', placeholder: 'notes.json' },
  { id: 'mindmap', label: 'Mindmap', hint: 'Tree board. .html is added if you omit it', placeholder: 'ideas' },
  { id: 'flow', label: 'Flow', hint: 'Flowchart board. .html is added if you omit it', placeholder: 'process' },
  { id: 'kanban', label: 'Kanban', hint: 'Task board with columns. .html is added if you omit it', placeholder: 'sprint' },
  { id: 'gantt', label: 'Gantt', hint: 'Timeline of tasks and dependencies. .html is added if you omit it', placeholder: 'roadmap' },
  { id: 'folder', label: 'Folder', hint: 'New directory under data/', placeholder: 'folder-name' },
];

let askResolver = null;
let askHasKinds = false;
let askKindMeta = [];
let askMode = 'ask';

function finishAsk(value) {
  askMode = 'ask';
  askHasKinds = false;
  askKindMeta = [];
  if (askModal) askModal.classList.remove('ask-confirm', 'ask-leave');
  if (askOk) askOk.classList.remove('ask-danger');
  if (askExtra) askExtra.classList.add('hidden');
  if (askModal) askModal.classList.add('hidden');
  if (askInput) askInput.classList.remove('hidden');
  if (askLabel) askLabel.classList.remove('hidden');
  const resolve = askResolver;
  askResolver = null;
  if (resolve) resolve(value);
}

function selectedAskKind() {
  const btn = askKinds && askKinds.querySelector('.ask-kind.active');
  return btn ? btn.getAttribute('data-kind') : 'file';
}

function syncAskKindUi() {
  const kind = selectedAskKind();
  const meta = askKindMeta.find((k) => k.id === kind);
  if (askHint) askHint.textContent = (meta && meta.hint) || '';
  if (askInput) {
    askInput.placeholder = (meta && meta.placeholder) || '';
    const needsName = !askHasKinds || !meta || meta.needsName !== false;
    askInput.classList.toggle('hidden', askHasKinds && !needsName);
    if (askLabel) askLabel.classList.toggle('hidden', askHasKinds && !needsName);
  }
}

function showAsk(opts) {
  return new Promise((resolve) => {
    if (!askModal || !askInput) {
      resolve(null);
      return;
    }
    if (askResolver) askResolver(null);
    askResolver = resolve;
    askMode = opts.mode === 'leave' ? 'leave' : (opts.mode === 'confirm' ? 'confirm' : 'ask');
    askHasKinds = !!(opts.kinds && opts.kinds.length);
    askKindMeta = askHasKinds ? opts.kinds : [];
    askModal.classList.toggle('ask-confirm', askMode === 'confirm' || askMode === 'leave');
    askModal.classList.toggle('ask-leave', askMode === 'leave');
    askOk.classList.toggle('ask-danger', !!opts.danger && askMode !== 'leave');
    askTitle.textContent = opts.title || 'Name';
    askLabel.textContent = opts.label || 'Name';
    askOk.textContent = opts.confirmLabel || 'OK';
    if (askExtra) {
      if (askMode === 'leave') {
        askExtra.classList.remove('hidden');
        askExtra.textContent = opts.discardLabel || 'Discard';
      } else {
        askExtra.classList.add('hidden');
      }
    }
    if (askHasKinds) {
      askKinds.classList.remove('hidden');
      askKinds.innerHTML = opts.kinds.map((k, i) => (
        `<button type="button" class="ask-kind${i === 0 ? ' active' : ''}" data-kind="${k.id}">${k.label}</button>`
      )).join('');
      syncAskKindUi();
    } else {
      askKinds.classList.add('hidden');
      askKinds.innerHTML = '';
      askHint.textContent = opts.hint || '';
      askInput.placeholder = opts.placeholder || '';
      askInput.classList.remove('hidden');
      if (askLabel) askLabel.classList.remove('hidden');
    }
    askInput.value = opts.value || '';
    askModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      if (askMode === 'confirm' || askMode === 'leave') {
        askOk.focus();
        return;
      }
      askInput.focus();
      askInput.select();
    });
  });
}

function submitAsk() {
  if (askMode === 'confirm') {
    finishAsk(true);
    return;
  }
  if (askMode === 'leave') {
    finishAsk('save');
    return;
  }
  const name = askInput.value.trim();
  if (askHasKinds) {
    const kind = selectedAskKind();
    const meta = askKindMeta.find((k) => k.id === kind);
    if ((!meta || meta.needsName !== false) && !name) {
      askInput.focus();
      return;
    }
    finishAsk({ name, kind });
    return;
  }
  if (!name) {
    askInput.focus();
    return;
  }
  finishAsk(name);
}

if (askKinds) {
  askKinds.addEventListener('click', (e) => {
    const btn = e.target.closest('.ask-kind');
    if (!btn) return;
    askKinds.querySelectorAll('.ask-kind').forEach((el) => el.classList.toggle('active', el === btn));
    syncAskKindUi();
    askInput.focus();
  });
}
if (askOk) askOk.addEventListener('click', submitAsk);
if (askExtra) askExtra.addEventListener('click', () => finishAsk('discard'));
if (askCancel) askCancel.addEventListener('click', () => finishAsk(null));
if (askClose) askClose.addEventListener('click', () => finishAsk(null));
if (askModal) {
  askModal.addEventListener('click', (e) => {
    if (e.target === askModal) finishAsk(null);
  });
  askModal.addEventListener('keydown', (e) => {
    if (askModal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      finishAsk(null);
    }
  });
}
if (askInput) {
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAsk();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishAsk(null);
    }
  });
}

async function openCreateDialog(parentPath) {
  const result = await showAsk({
    title: parentPath ? `New in ${parentPath}` : 'Create new',
    label: parentPath ? 'Name' : 'Name or path (relative to data/)',
    confirmLabel: 'Create',
    kinds: CREATE_KINDS,
  });
  if (!result || !result.name) return;
  if (result.kind === 'folder') return createFolder(parentPath, result.name);
  if (result.kind === 'mindmap') return createBoardFile(parentPath, result.name, 'mindmap');
  if (result.kind === 'flow') return createBoardFile(parentPath, result.name, 'flow');
  if (result.kind === 'kanban') return createBoardFile(parentPath, result.name, 'kanban');
  if (result.kind === 'gantt') return createBoardFile(parentPath, result.name, 'gantt');
  return createFile(parentPath, result.name);
}

if (newFileBtn) newFileBtn.addEventListener('click', () => openCreateDialog(null));
if (importBtn) importBtn.addEventListener('click', () => pickImport(''));
if (exportAllBtn) exportAllBtn.addEventListener('click', () => downloadHref(''));
if (exportFileBtn) exportFileBtn.addEventListener('click', exportCurrentFile);
if (standaloneBtn) standaloneBtn.addEventListener('click', exportStandaloneFile);
if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleAppFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenBtn);
document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
if (importFileInput) {
  importFileInput.addEventListener('change', () => {
    const files = Array.from(importFileInput.files || []);
    importFileInput.value = '';
    importFileList(files, importDest);
  });
}
if (bookmarkAddCatBtn) {
  bookmarkAddCatBtn.addEventListener('click', async () => {
    const name = await showAsk({
      title: 'New bookmark category',
      label: 'Category name',
      placeholder: 'Work, Reading, …',
      hint: 'Use categories to group starred files.',
      confirmLabel: 'Create',
    });
    if (!name) return;
    try {
      await postBookmarks('/api/favorites/category', { name: String(name).trim() });
    } catch (err) {
      setStatus((err && err.message) || 'Could not create category', 'dirty');
    }
  });
}

async function downloadHref(relPath) {
  const label = relPath ? relPath.split('/').pop() : 'workspace.zip';
  setStatus('Downloading ' + label + '…');
  try {
    const res = await fetch('/api/download?path=' + encodeURIComponent(relPath || ''));
    if (!res.ok) {
      let msg = 'Download failed';
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (e) { /* ignore */ }
      setStatus(msg, 'dirty');
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="([^"]+)"/);
    const name = (match && match[1]) || (relPath ? relPath.split('/').pop() : 'data.zip');
    downloadBlob(blob, name);
    setStatus('Downloaded ' + name, 'ok');
  } catch (err) {
    setStatus('Download failed: ' + ((err && err.message) || err), 'dirty');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function setStandaloneVisible(on) {
  if (!standaloneBtn) return;
  standaloneBtn.classList.toggle('hidden', !on);
}

async function exportStandaloneFile() {
  if (!boardEngine || typeof boardEngine.exportStandalone !== 'function') {
    setStatus('Standalone export is only for mindmaps and flows', 'dirty');
    return;
  }
  if (boardEngine && viewMode === 'board') syncBoardIntoEditor();
  const base = currentPath ? currentPath.split('/').pop().replace(/\.html?$/i, '') : '';
  const name = base ? base + '-standalone.html' : undefined;
  setStatus('Building standalone file…');
  try {
    await boardEngine.exportStandalone(name);
    setStatus('Downloaded ' + (name || 'standalone.html'), 'ok');
  } catch (err) {
    const msg = 'Standalone export failed: ' + ((err && err.message) || err);
    setStatus(msg, 'dirty');
    alert(msg);
  }
}

function exportCurrentFile() {
  if (!currentPath) return;
  const name = currentPath.split('/').pop();
  if (isPdfPath(currentPath)) {
    downloadHref(currentPath);
    setStatus('Exported ' + name, 'ok');
    return;
  }
  if (boardEngine && viewMode === 'board') syncBoardIntoEditor();
  const content = getSaveContent();
  const type = /\.html?$/i.test(name) ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
  downloadBlob(new Blob([content], { type }), name);
  setStatus('Exported ' + name, 'ok');
}

let importDest = '';

function isTextImportName(name) {
  return /\.(html?|json|ya?ml|md|txt|csv)$/i.test(name);
}

function readImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read ' + file.name));
    if (isTextImportName(file.name)) {
      reader.onload = () => resolve({ name: file.name, content: String(reader.result || ''), encoding: 'utf8' });
      reader.readAsText(file);
      return;
    }
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve({ name: file.name, content: i >= 0 ? s.slice(i + 1) : s, encoding: 'base64' });
    };
    reader.readAsDataURL(file);
  });
}

async function importFileList(fileList, dest) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setStatus('Importing ' + (files.length === 1 ? files[0].name : files.length + ' files') + '…');
  try {
    const payload = [];
    for (const file of files) payload.push(await readImportFile(file));
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest: dest || '', files: payload }),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const msg = data.error || ('Import failed (' + res.status + ')');
      setStatus(msg, 'dirty');
      alert(msg);
      return;
    }
    const imported = data.imported || [];
    if (!imported.length) {
      setStatus('Nothing was imported', 'dirty');
      return;
    }
    if (dest) expandedFolders.add(dest);
    imported.forEach((item) => {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      if (parent) expandedFolders.add(parent);
    });
    await loadTree();
    setStatus(imported.length === 1 ? 'Imported ' + imported[0].path : 'Imported ' + imported.length + ' files', 'ok');
    if (imported.length === 1) await openFile(imported[0].path);
  } catch (err) {
    const msg = 'Import failed: ' + ((err && err.message) || err);
    setStatus(msg, 'dirty');
    alert(msg);
  }
}

function pickImport(dest) {
  importDest = dest || '';
  setStatus('Choose files to import…');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'file-hidden';
  input.setAttribute('aria-hidden', 'true');
  const finish = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (!files.length) {
      setStatus('Import cancelled');
      return;
    }
    importFileList(files, importDest);
  };
  input.addEventListener('change', finish);
  document.body.appendChild(input);
  try {
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.click();
  } catch (err) {
    try { input.click(); } catch (e) {
      input.remove();
      if (importFileInput) {
        importFileInput.value = '';
        importFileInput.click();
        return;
      }
      setStatus('Could not open the file picker', 'dirty');
    }
  }
}

function toggleAppFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (active) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  if (!mainEl) return;
  const req = mainEl.requestFullscreen || mainEl.webkitRequestFullscreen;
  if (!req) {
    setStatus('Fullscreen is not available', 'dirty');
    return;
  }
  Promise.resolve(req.call(mainEl)).catch((err) => {
    setStatus('Fullscreen failed: ' + ((err && err.message) || err), 'dirty');
  });
}

function syncFullscreenBtn() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (fullscreenBtn) {
    fullscreenBtn.textContent = on ? 'Exit full' : 'Fullscreen';
    fullscreenBtn.classList.toggle('active', on);
    fullscreenBtn.disabled = !currentPath;
  }
  if (editor && typeof editor.layout === 'function') {
    requestAnimationFrame(() => {
      try { editor.layout(); } catch (e) { /* ignore */ }
    });
  }
}

function makeExportButton(relPath, isDir) {
  const btn = document.createElement('button');
  btn.className = 'export-btn';
  btn.textContent = '↓';
  btn.title = isDir ? 'Export folder as zip' : 'Export file';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadHref(relPath);
  });
  return btn;
}

function makeImportHereButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn new-here-btn';
  btn.textContent = '↑';
  btn.title = 'Import files into this folder';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickImport(relPath);
  });
  return btn;
}

function makeNewHereButton(relPath) {
  const btn = document.createElement('button');
  btn.className = 'delete-btn new-here-btn';
  btn.textContent = '＋';
  btn.title = 'New file, mindmap, flow, or folder here';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCreateDialog(relPath);
  });
  return btn;
}

saveAsBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  const newPath = await showAsk({
    title: 'Save as',
    label: 'Path relative to data/',
    value: currentPath,
    placeholder: currentPath,
    confirmLabel: 'Save',
  });
  if (newPath === null) return;
  const trimmed = String(newPath).trim();
  if (!trimmed) {
    alert('Filename cannot be empty.');
    return;
  }
  const content = getSaveContent();
  const { res, data } = await postFileContent(trimmed, content);
  if (!res.ok) {
    alert('Save As failed: ' + ((data && data.error) || 'unknown error'));
    return;
  }
  await loadTree();
  markClean();
  await openFile(trimmed, undefined, { skipDirty: true, force: true });
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
  container.className = 'tree-list';
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (node.type === 'dir' ? 'is-folder' : 'is-file');
    row.dataset.path = node.path;

    if (node.type === 'dir') {
      const isExpanded = expandedFolders.has(node.path);
      row.classList.toggle('is-open', isExpanded);
      const twist = document.createElement('span');
      twist.className = 'twist';
      twist.textContent = isExpanded ? '▾' : '▸';
      const icon = document.createElement('span');
      icon.className = 'icon folder';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String((node.children || []).length);
      row.appendChild(twist);
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(count);
      row.appendChild(makeStarButton(node.path));
      row.appendChild(makeNewHereButton(node.path));
      row.appendChild(makeImportHereButton(node.path));
      row.appendChild(makeExportButton(node.path, true));
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
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          importFileList(e.dataTransfer.files, node.path);
          return;
        }
        const fromPath = e.dataTransfer.getData('text/plain');
        if (fromPath && fromPath !== node.path) moveFile(fromPath, node.path);
      });

      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-branch';
      const childrenEl = renderNodes(node.children);
      childrenEl.classList.add('tree-children');
      if (!isExpanded) childrenEl.classList.add('collapsed');
      childrenWrap.appendChild(childrenEl);

      row.addEventListener('click', () => {
        const collapsed = childrenEl.classList.toggle('collapsed');
        twist.textContent = collapsed ? '▸' : '▾';
        row.classList.toggle('is-open', !collapsed);
        if (collapsed) expandedFolders.delete(node.path);
        else expandedFolders.add(node.path);
      });

      container.appendChild(row);
      container.appendChild(childrenWrap);
    } else {
      const twist = document.createElement('span');
      twist.className = 'twist is-leaf';
      const icon = document.createElement('span');
      icon.className = 'icon';
      applyFileIcon(icon, node.name, node.kind);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      row.appendChild(twist);
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(makeStarButton(node.path));
      row.appendChild(makeExportButton(node.path, false));
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

function boardKindFromHtml(content) {
  if (typeof content !== 'string') return null;
  if (/data-docviewer\s*=\s*["']mindmap["']/.test(content)) return 'mindmap';
  if (/data-docviewer\s*=\s*["']flow["']/.test(content)) return 'flow';
  if (/data-docviewer\s*=\s*["']kanban["']/.test(content)) return 'kanban';
  if (/data-docviewer\s*=\s*["']gantt["']/.test(content)) return 'gantt';
  return null;
}

function destroyBoard() {
  if (boardEngine) {
    boardEngine.destroy();
    boardEngine = null;
  }
  boardKind = null;
  if (mindmapStage) mindmapStage.classList.add('hidden');
}

function onBoardChange() {
  noteUnsaved();
}

function ensureScript(src, flag, ready) {
  const existing = document.querySelector(`script[${flag}]`);
  if (existing && existing.getAttribute('src') !== src) {
    existing.remove();
    if (flag === 'data-fl-core') window.FlowCore = undefined;
    if (flag === 'data-fl-js') window.FlowEngine = undefined;
    if (flag === 'data-mm-js') window.MindmapEngine = undefined;
    if (flag === 'data-kb-core') window.KanbanCore = undefined;
    if (flag === 'data-kb-js') window.KanbanEngine = undefined;
    if (flag === 'data-gt-core') window.GanttCore = undefined;
    if (flag === 'data-gt-js') window.GanttEngine = undefined;
  } else if (ready()) {
    return Promise.resolve();
  }
  const leftover = document.querySelector(`script[${flag}]`);
  if (leftover) {
    return new Promise((resolve, reject) => {
      leftover.addEventListener('load', () => ready() ? resolve() : reject(new Error('script loaded without API')));
      leftover.addEventListener('error', () => reject(new Error('script failed')));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.setAttribute(flag, '1');
    s.onload = () => ready() ? resolve() : reject(new Error('script loaded without API'));
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.body.appendChild(s);
  });
}

function ensureStylesheet(href, flag) {
  let link = document.querySelector(`link[${flag}]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute(flag, '1');
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function ensureMindmapAssets() {
  ensureStylesheet('/mindmap/engine.css?v=94', 'data-mm-css');
  return ensureScript('/mindmap/engine.js?v=122', 'data-mm-js', () => typeof window.MindmapEngine === 'function');
}

function ensureFlowAssets() {
  ensureStylesheet('/flow/engine.css?v=23', 'data-fl-css');
  return ensureScript('/flow/core.js?v=20', 'data-fl-core', () => !!window.FlowCore)
    .then(() => ensureScript('/flow/engine.js?v=34', 'data-fl-js', () => typeof window.FlowEngine === 'function'));
}

function ensureKanbanAssets() {
  ensureStylesheet('/kanban/engine.css?v=2', 'data-kb-css');
  return ensureScript('/kanban/core.js?v=1', 'data-kb-core', () => !!window.KanbanCore)
    .then(() => ensureScript('/kanban/engine.js?v=4', 'data-kb-js', () => typeof window.KanbanEngine === 'function'));
}

function ensureGanttAssets() {
  ensureStylesheet('/gantt/engine.css?v=18', 'data-gt-css');
  return ensureScript('/gantt/core.js?v=7', 'data-gt-core', () => !!window.GanttCore)
    .then(() => ensureScript('/gantt/engine.js?v=23', 'data-gt-js', () => typeof window.GanttEngine === 'function'));
}

const BOARD_TYPES = {
  mindmap: { engine: 'MindmapEngine', ensure: ensureMindmapAssets },
  flow: { engine: 'FlowEngine', ensure: ensureFlowAssets },
  kanban: { engine: 'KanbanEngine', ensure: ensureKanbanAssets },
  gantt: { engine: 'GanttEngine', ensure: ensureGanttAssets },
};

function getSaveContent() {
  if (boardEngine && viewMode === 'board') {
    return boardEngine.serializeToHtml();
  }
  return editor && editor.getValue ? editor.getValue() : '';
}

function markClean() {
  isDirty = false;
  ignoreDirtyUntil = Date.now() + 1500;
  clearTimeout(autoSaveTimer);
}

function noteUnsaved() {
  if (!currentPath || isPdfPath(currentPath) || saveInFlight) return;
  if (Date.now() < ignoreDirtyUntil) return;
  if (!isDirty) {
    isDirty = true;
    saveBtn.disabled = false;
    setStatus('Modified (unsaved)', 'dirty');
  }
  if (autoSaveEnabled) scheduleAutoSave();
}

async function confirmLeaveIfDirty() {
  if (!isDirty) return true;
  try {
    const choice = await showAsk({
      title: 'Unsaved changes',
      label: 'This file has unsaved changes.',
      hint: '',
      mode: 'leave',
      confirmLabel: 'Save',
      discardLabel: 'Discard',
    });
    if (choice === 'save') {
      await saveCurrentFile();
      return !isDirty;
    }
    return choice === 'discard';
  } catch (err) {
    return true;
  }
}

function syncBoardIntoEditor() {
  if (!boardEngine || !editor || !editor.getModel()) return;
  const html = boardEngine.serializeToHtml();
  suppressEditorChange = true;
  editor.getModel().setValue(html);
  requestAnimationFrame(() => { suppressEditorChange = false; });
}

function hidePdfFrame() {
  if (!pdfFrame) return;
  pdfFrame.classList.add('hidden');
  pdfFrame.removeAttribute('src');
}

async function openPdf(relPath) {
  if (relPath === currentPath) {
    highlightActiveRow(relPath);
    return;
  }
  const token = ++openToken;
  if (!(await confirmLeaveIfDirty())) return;
  if (token !== openToken) return;
  destroyBoard();
  currentPath = relPath;
  currentLang = null;
  currentDataFormat = null;
  currentPathEl.textContent = relPath;
  markClean();
  saveBtn.disabled = true;
  saveAsBtn.disabled = true;
  if (exportFileBtn) exportFileBtn.disabled = false;
  setStandaloneVisible(false);
  if (fullscreenBtn) fullscreenBtn.disabled = false;
  convertBtn.disabled = true;
  historyBtn.disabled = true;
  commitBtn.disabled = true;
  findInFileBtn.disabled = true;
  collapseAllBtn.disabled = true;
  expandAllBtn.disabled = true;
  viewToggleBtn.classList.add('hidden');
  backToLatestBtn.classList.add('hidden');
  if (editor) {
    const model = monaco.editor.createModel('', 'plaintext');
    editor.setModel(model);
    editor.updateOptions({ readOnly: true });
  }
  highlightActiveRow(relPath);
  setStatus('PDF preview', '');
  setViewMode('pdf');
}

async function openFile(relPath, lineToReveal, opts) {
  if (isPdfPath(relPath)) return openPdf(relPath);
  if (relPath === currentPath && lineToReveal == null && !(opts && opts.force)) {
    highlightActiveRow(relPath);
    return;
  }
  const token = ++openToken;
  if (!(opts && opts.skipDirty) && !(await confirmLeaveIfDirty())) return;
  if (token !== openToken) return;
  let res;
  try {
    res = await fetch('/api/file?path=' + encodeURIComponent(relPath));
  } catch (err) {
    if (token !== openToken) return;
    alert('Failed to open file: ' + ((err && err.message) || err));
    return;
  }
  if (token !== openToken) return;
  const data = await res.json();
  if (token !== openToken) return;
  if (!res.ok) {
    alert('Failed to open file: ' + data.error);
    return;
  }
  destroyBoard();
  currentPath = relPath;
  currentLang = monacoLanguageForPath(relPath);
  currentDataFormat = langForPath(relPath);
  currentPathEl.textContent = relPath;
  markClean();
  saveBtn.disabled = false;
  historyBtn.disabled = false;
  commitBtn.disabled = false;
  findInFileBtn.disabled = false;
  saveAsBtn.disabled = false;
  if (exportFileBtn) exportFileBtn.disabled = false;
  if (fullscreenBtn) fullscreenBtn.disabled = false;
  collapseAllBtn.disabled = false;
  expandAllBtn.disabled = false;
  backToLatestBtn.classList.add('hidden');
  if (!editor) {
    alert('Editor is still loading. Try again in a moment.');
    return;
  }
  editor.updateOptions({ readOnly: false });

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
  boardKind = isHtml ? boardKindFromHtml(data.content) : null;
  if (boardKind === 'mindmap') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureMindmapAssets();
      if (token !== openToken) return;
      boardEngine = new window.MindmapEngine(mindmapStage, { onChange: onBoardChange });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Mindmap failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (boardKind === 'flow') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureFlowAssets();
      if (token !== openToken) return;
      boardEngine = new window.FlowEngine(mindmapStage, { onChange: onBoardChange });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Flow failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (boardKind === 'kanban') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureKanbanAssets();
      if (token !== openToken) return;
      boardEngine = new window.KanbanEngine(mindmapStage, { onChange: onBoardChange });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Kanban failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (boardKind === 'gantt') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureGanttAssets();
      if (token !== openToken) return;
      boardEngine = new window.GanttEngine(mindmapStage, { onChange: onBoardChange });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Gantt failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (isHtml) {
    viewToggleBtn.classList.remove('hidden');
    setViewMode('render');
  } else {
    viewToggleBtn.classList.add('hidden');
    setViewMode('code');
  }
  setStandaloneVisible(!!boardKind);
  if (token !== openToken) return;
  markClean();
}

function setViewMode(mode) {
  viewMode = mode;
  htmlPreviewFrame.classList.add('hidden');
  document.getElementById('editor').classList.add('hidden');
  mindmapStage.classList.add('hidden');
  if (mode !== 'pdf') hidePdfFrame();

  if (mode === 'pdf') {
    if (pdfFrame && currentPath) {
      pdfFrame.src = '/api/raw?path=' + encodeURIComponent(currentPath);
      pdfFrame.classList.remove('hidden');
    }
    viewToggleBtn.classList.add('hidden');
    findInFileBtn.disabled = true;
  } else if (mode === 'board') {
    mindmapStage.classList.remove('hidden');
    viewToggleBtn.textContent = 'View Source';
    findInFileBtn.disabled = true;
  } else if (mode === 'render') {
    htmlPreviewFrame.srcdoc = editor.getValue();
    htmlPreviewFrame.classList.remove('hidden');
    viewToggleBtn.textContent = 'View Source';
    findInFileBtn.disabled = false;
  } else {
    if (boardEngine) syncBoardIntoEditor();
    document.getElementById('editor').classList.remove('hidden');
    viewToggleBtn.textContent = boardKind === 'mindmap' ? 'View Mindmap' : boardKind === 'flow' ? 'View Flow' : boardKind === 'kanban' ? 'View Kanban' : boardKind === 'gantt' ? 'View Gantt' : 'View Rendered';
    findInFileBtn.disabled = !currentPath;
    if (boardEngine && editor) {
      editor.layout();
    }
  }
}

viewToggleBtn.addEventListener('click', () => {
  if (boardKind) {
    if (viewMode === 'board') {
      setViewMode('code');
    } else {
      if (boardEngine) boardEngine.loadFromHtml(editor.getValue());
      setViewMode('board');
    }
  } else {
    setViewMode(viewMode === 'render' ? 'code' : 'render');
  }
});

// --- Save ---
async function postFileContent(relPath, content) {
  const res = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, content }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { res, data };
}

async function saveCurrentFile() {
  if (!currentPath || isPdfPath(currentPath)) return false;
  if (saveInFlight) return saveInFlight;
  saveInFlight = (async () => {
    clearTimeout(autoSaveTimer);
    setStatus('Saving…');
    await new Promise((r) => setTimeout(r, 0));
    if (boardEngine && typeof boardEngine.flushEdit === 'function') boardEngine.flushEdit();
    else if (boardEngine && typeof boardEngine.commitEdit === 'function') boardEngine.commitEdit();
    const content = getSaveContent();
    const { res, data } = await postFileContent(currentPath, content);
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || 'Save failed';
      setStatus('Save failed: ' + msg, 'dirty');
      alert('Save failed: ' + msg);
      return false;
    }
    markClean();
    runValidation();
    return true;
  })().finally(() => {
    saveInFlight = null;
  });
  return saveInFlight;
}

saveBtn.addEventListener('click', saveCurrentFile);

collapseAllBtn.addEventListener('click', () => {
  if (boardEngine && viewMode === 'board' && typeof boardEngine.collapseAll === 'function') {
    boardEngine.collapseAll();
    return;
  }
  if (!editor) return;
  editor.getAction('editor.foldAll').run();
});

expandAllBtn.addEventListener('click', () => {
  if (boardEngine && viewMode === 'board' && typeof boardEngine.expandAll === 'function') {
    boardEngine.expandAll();
    return;
  }
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
let searchType = '';
const searchFiltersEl = document.getElementById('search-filters');

function currentSearchQuery() {
  return searchInput.value.trim();
}

function syncSearchPlaceholder() {
  if (searchType === 'mindmap') searchInput.placeholder = 'Filter mindmaps';
  else if (searchType === 'flow') searchInput.placeholder = 'Filter flows';
  else if (searchType === 'json') searchInput.placeholder = 'Filter JSON files';
  else if (searchType === 'yaml') searchInput.placeholder = 'Filter YAML files';
  else if (searchType === 'pdf') searchInput.placeholder = 'Filter PDF files';
  else searchInput.placeholder = 'Search files and content';
}

function requestSearch() {
  const q = currentSearchQuery();
  if (!q && !searchType) {
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    return;
  }
  runSearch(q, searchType);
}

if (searchFiltersEl) {
  searchFiltersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-search-type]');
    if (!btn) return;
    searchType = btn.getAttribute('data-search-type') || '';
    searchFiltersEl.querySelectorAll('.search-filter').forEach((el) => {
      el.classList.toggle('active', el === btn);
    });
    syncSearchPlaceholder();
    requestSearch();
  });
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = currentSearchQuery();
  if (!q && !searchType) {
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q, searchType), 300);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-box')) {
    searchResultsEl.classList.add('hidden');
  }
});

async function runSearch(q, type) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  const res = await fetch('/api/search?' + params.toString());
  const data = await res.json();
  searchResultsEl.innerHTML = '';
  if (!data.results || data.results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = type && !q ? `No ${type === 'pdf' ? 'PDF' : type} files` : 'No matches';
    searchResultsEl.appendChild(empty);
  } else {
    for (const r of data.results) {
      const item = document.createElement('div');
      item.className = 'search-item';
      const pathEl = document.createElement('span');
      pathEl.className = 'sr-path';
      pathEl.textContent = r.line ? `${r.path}:${r.line}` : r.path;
      item.appendChild(pathEl);
      const meta = document.createElement('span');
      meta.className = 'sr-snippet';
      const bits = [];
      if (r.kind === 'mindmap') bits.push('Mindmap');
      else if (r.kind === 'flow') bits.push('Flow');
      else if (r.kind === 'kanban') bits.push('Kanban');
      else if (r.kind === 'gantt') bits.push('Gantt');
      else if (r.kind === 'json') bits.push('JSON');
      else if (r.kind === 'yaml') bits.push('YAML');
      else if (r.kind === 'pdf') bits.push('PDF');
      if (r.text && r.matchType === 'content') bits.push(r.text);
      else if (r.text && r.matchType !== 'type' && r.matchType !== 'filename') bits.push(r.text);
      meta.textContent = bits.join(' · ');
      if (meta.textContent) item.appendChild(meta);
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
  const previewKind = boardKindFromHtml(data.content);
  const board = BOARD_TYPES[previewKind];
  if (board) {
    await board.ensure();
    if (!boardEngine || boardKind !== previewKind) {
      if (boardEngine) boardEngine.destroy();
      boardEngine = new window[board.engine](mindmapStage, { onChange: onBoardChange, readOnly: true });
    }
    boardKind = previewKind;
    boardEngine.setReadOnly(true);
    boardEngine.loadFromHtml(data.content);
    setViewMode('board');
  }
}

backToLatestBtn.addEventListener('click', () => {
  editor.updateOptions({ readOnly: false });
  backToLatestBtn.classList.add('hidden');
  openFile(currentPath, undefined, { force: true });
});

async function restoreVersion(hash) {
  const ok = await showAsk({
    title: 'Restore version',
    label: `Restore this file to commit ${hash.slice(0, 7)}? This creates a new version with that content.`,
    hint: 'The current file is replaced with that snapshot.',
    mode: 'confirm',
    danger: true,
    confirmLabel: 'Restore',
  });
  if (!ok) return;
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
  await openFile(currentPath, undefined, { force: true, skipDirty: true });
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
  const newPath = await showAsk({
    title: `Convert ${from.toUpperCase()} → ${to.toUpperCase()}`,
    label: 'Save as (relative to data/). Cancel to preview unsaved.',
    value: defaultPath,
    placeholder: defaultPath,
    confirmLabel: 'Save',
  });

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

  const saveRes = await postFileContent(trimmed, data.output);
  if (!saveRes.res.ok) {
    alert('Save failed: ' + ((saveRes.data && saveRes.data.error) || 'unknown error'));
    return;
  }
  await loadTree();
  await openFile(trimmed, undefined, { skipDirty: true, force: true });
});

document.getElementById('refresh-btn').addEventListener('click', loadTree);

// --- Live sync with files changed outside the app ---
// Short JSON poll instead of EventSource: a held SSE stream uses 1 of
// Chrome's 6 HTTP/1.1 connections per host and can stall CSS/saves.
let liveSyncRev = null;
let liveSyncTimer = null;

function connectLiveSync() {
  clearTimeout(liveSyncTimer);
  const tick = async () => {
    try {
      const res = await fetch('/api/changes', { cache: 'no-store' });
      const data = await res.json();
      if (liveSyncRev != null && data.rev !== liveSyncRev) {
        loadTree();
        setStatus('Detected external changes — tree refreshed', 'dirty');
      }
      liveSyncRev = data.rev;
    } catch (e) { /* offline / restarting */ }
    liveSyncTimer = setTimeout(tick, 2500);
  };
  tick();
}
connectLiveSync();
window.addEventListener('beforeunload', () => {
  clearTimeout(liveSyncTimer);
});
