let editor = null;
let currentPath = null;
let currentLang = null; // Monaco language id used for syntax highlighting
let currentDataFormat = null; // 'json' | 'yaml' | null - drives validation & conversion
let isDirty = false;
let ignoreDirtyUntil = 0;
// Bumped on every edit; a save only marks the file clean if no edit
// happened while it was in flight.
let editGen = 0;
// 'history' (viewing an old version) or 'conversion' (unsaved JSON<->YAML
// preview): the editor content isn't the file, so saving it is blocked.
let previewMode = null;
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
const prettyBtn = document.getElementById('pretty-btn');
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
// Persist a UI preference on the server too: localStorage alone is per
// origin, and the server falls back to a random port when 4321 is taken.
function saveUiSetting(patch) {
  fetch('/api/ui-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => { /* localStorage still has it */ });
}
// Fetched once at startup; each setting applies its saved value from it.
const uiSettingsReady = fetch('/api/ui-settings')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));

const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const SIDEBAR_KEY = 'docviewer-sidebar';

function sidebarCollapsed() {
  return document.getElementById('app').classList.contains('sidebar-collapsed');
}
function storedSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch (e) { return false; }
}
function applySidebarCollapsed(collapsed, persist) {
  document.getElementById('app').classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open'); } catch (e) { /* ignore */ }
  if (persist) saveUiSetting({ sidebarCollapsed: collapsed });
  if (sidebarToggleBtn) {
    sidebarToggleBtn.title = collapsed ? 'Show Project (Alt+1)' : 'Hide Project (Alt+1)';
    sidebarToggleBtn.setAttribute('aria-label', sidebarToggleBtn.title);
    sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
  }
}
applySidebarCollapsed(storedSidebarCollapsed());
let sidebarToggledByUser = false;
uiSettingsReady.then((cfg) => {
  if (!sidebarToggledByUser && typeof cfg.sidebarCollapsed === 'boolean') applySidebarCollapsed(cfg.sidebarCollapsed);
});
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    sidebarToggledByUser = true;
    applySidebarCollapsed(!sidebarCollapsed(), true);
  });
}

// --- Sidebar resize (drag the right edge) ---
const SIDEBAR_WIDTH_KEY = 'docviewer-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 304;
const SIDEBAR_MIN_WIDTH = 200;

function clampSidebarWidth(w) {
  // Always leave room for the editor.
  const max = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 360);
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, w)));
}
function applySidebarWidth(w, persist) {
  const width = clampSidebarWidth(w);
  document.getElementById('app').style.setProperty('--sidebar-w', width + 'px');
  if (persist) {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (e) { /* ignore */ }
    saveUiSetting({ sidebarWidth: width });
  }
  return width;
}
(function initSidebarResize() {
  let saved = NaN;
  try { saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10); } catch (e) { /* ignore */ }
  applySidebarWidth(Number.isFinite(saved) ? saved : SIDEBAR_DEFAULT_WIDTH, false);
  // localStorage gives an instant first paint; the server copy wins because it
  // survives port/origin changes. Skip it if the user already started dragging.
  let dragged = false;
  uiSettingsReady
    .then((cfg) => {
      const w = Number(cfg && cfg.sidebarWidth);
      if (!dragged && Number.isFinite(w)) {
        applySidebarWidth(w, false);
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch (e) { /* ignore */ }
      }
    })
    .catch(() => { /* keep the localStorage width */ });

  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  if (!resizer || !sidebar) return;
  let startX = 0;
  let startW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragged = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    // Pointer capture keeps the drag alive over the editor and preview iframes.
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('sidebar-resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    applySidebarWidth(startW + (e.clientX - startX), false);
  });
  const end = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('sidebar-resizing');
    applySidebarWidth(sidebar.getBoundingClientRect().width, true);
  };
  resizer.addEventListener('pointerup', end);
  resizer.addEventListener('pointercancel', end);
  resizer.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, true));
  window.addEventListener('resize', () => {
    const current = parseInt(getComputedStyle(document.getElementById('app')).getPropertyValue('--sidebar-w'), 10);
    if (Number.isFinite(current)) applySidebarWidth(current, false);
  });
})();
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === '1' || e.code === 'Digit1')) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    sidebarToggledByUser = true;
    applySidebarCollapsed(!sidebarCollapsed(), true);
  }
});

const THEME_KEY = 'docviewer-theme';
// Read from the page, not storage, so toggling works even if storage is blocked.
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
}
function applyAppTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  if (persist) saveUiSetting({ theme });
  if (themeBtn) themeBtn.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
  if (window.monaco) monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
  // A rendered markdown preview is themed too. (Throws harmlessly during
  // start-up, before the view state below exists.)
  try { if (viewMode === 'render' && (isMarkdownPath(currentPath) || isMermaidPath(currentPath))) setViewMode('render'); } catch (e) { /* not ready yet */ }
}
applyAppTheme(storedTheme());
let themeToggledByUser = false;
uiSettingsReady.then((cfg) => {
  if (!themeToggledByUser && (cfg.theme === 'light' || cfg.theme === 'dark')) applyAppTheme(cfg.theme);
});
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    themeToggledByUser = true;
    applyAppTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
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

function isMarkdownPath(p) {
  return /\.(md|markdown)$/i.test(p || '');
}

function isMermaidPath(p) {
  return /\.(mmd|mermaid)$/i.test(p || '');
}

// --- Mermaid diagrams (```mermaid blocks in markdown, and .mmd files) ---
// Large library: loaded from the CDN only when a diagram is shown.
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
let mermaidP = null;
let mermaidSeq = 0;
function ensureMermaid() {
  if (!mermaidP) {
    mermaidP = loadGlobalScript(MERMAID_URL, () => !!(window.mermaid && window.mermaid.render));
    mermaidP.catch(() => { mermaidP = null; });
  }
  return mermaidP;
}
// Render one diagram to SVG markup. Labels are sanitised by mermaid
// (securityLevel "strict"). Throws with mermaid's syntax error message.
async function renderMermaidSvg(code, dark) {
  await ensureMermaid();
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'ui-sans-serif, system-ui, sans-serif' });
  const id = 'mmd-' + (++mermaidSeq);
  try {
    const { svg } = await window.mermaid.render(id, String(code || ''));
    return svg;
  } finally {
    // mermaid leaves a temporary element behind on errors
    ['d' + id, id].forEach((x) => { const n = document.getElementById(x); if (n && n.closest('body') && !n.closest('#editor-area')) n.remove(); });
  }
}
// SVGs for every ```mermaid block of a markdown source, in order
// ({ error } for a block that doesn't parse).
async function renderMermaidBlocks(source, dark) {
  const tpl = markdownTemplate(source);
  const blocks = [...tpl.content.querySelectorAll('pre > code.language-mermaid')];
  const out = [];
  for (const code of blocks) {
    try { out.push(await renderMermaidSvg(code.textContent, dark)); } catch (err) { out.push({ error: String((err && err.message) || err).split('\n')[0] }); }
  }
  return out;
}
// Replace ```mermaid code blocks in a parsed markdown template with SVGs.
function applyMermaidSvgs(tpl, svgs) {
  [...tpl.content.querySelectorAll('pre > code.language-mermaid')].forEach((code, i) => {
    const r = (svgs || [])[i];
    const box = document.createElement('div');
    box.className = 'md-mermaid';
    if (typeof r === 'string') box.innerHTML = r;
    else {
      box.classList.add('is-error');
      box.textContent = 'Mermaid: ' + ((r && r.error) || 'diagram could not be rendered');
    }
    code.parentElement.replaceWith(box);
  });
}

function mermaidPageDoc(inner, isError) {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:${dark ? '#0d1117' : '#ffffff'};color:${dark ? '#e6edf3' : '#1f2328'};font:14px/1.5 ui-sans-serif,system-ui,sans-serif}`
    + `.wrap{padding:32px;display:flex;justify-content:center}.wrap svg{max-width:100%;height:auto}.err{color:${dark ? '#f97066' : '#d92d20'};white-space:pre-wrap;max-width:760px;margin:48px auto;padding:0 24px}</style></head>`
    + `<body>${isError ? '<div class="err"></div>' : '<div class="wrap">' + inner + '</div>'}</body></html>`;
}

// --- Markdown preview ---
// marked (parser) + DOMPurify (sanitizer), served with the app (public/vendor)
// so the preview never waits on a CDN; the CDN is only a fallback.
const MARKDOWN_LIBS = [
  { local: '/vendor/marked.min.js', cdn: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', ready: () => !!(window.marked && window.marked.parse) },
  { local: '/vendor/purify.min.js', cdn: 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js', ready: () => !!(window.DOMPurify && window.DOMPurify.sanitize) },
];
const MARKDOWN_LOAD_TIMEOUT_MS = 10000;
let markdownLibsP = null;
// Only the newest preview request may write to the frame.
let markdownRenderToken = 0;

// Run a UMD bundle so it defines a global. The page has Monaco's AMD
// `define`, which a UMD bundle would use instead; it is shadowed for this
// script only (hiding window.define would break Monaco's own loads).
// `names`: top-level `var`s the bundle declares (they would stay local to
// the wrapper below); they are copied onto window.
async function loadGlobalScript(src, ready, names) {
  if (ready()) return;
  // A stalled request must not leave the preview waiting forever.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MARKDOWN_LOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(src, { signal: ctl.signal });
  } catch (err) {
    throw new Error(err && err.name === 'AbortError' ? 'Timed out loading ' + src : 'Failed to load ' + src);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('Failed to load ' + src);
  const code = await res.text();
  // eslint-disable-next-line no-new-func
  const exportVars = (names || []).map((n) => `if(typeof ${n}!=='undefined')window.${n}=${n};`).join('');
  new Function('define', 'module', 'exports', code + '\n;' + exportVars + '\n//# sourceURL=' + src).call(window, undefined, undefined, undefined);
  if (!ready()) throw new Error('Loaded ' + src + ' without its API');
}

function ensureMarkdownLibs() {
  if (!markdownLibsP) {
    markdownLibsP = (async () => {
      for (const lib of MARKDOWN_LIBS) {
        try {
          await loadGlobalScript(lib.local, lib.ready);
        } catch (err) {
          await loadGlobalScript(lib.cdn, lib.ready);
        }
      }
    })();
    // Let a later attempt retry after a failure.
    markdownLibsP.catch(() => { markdownLibsP = null; });
  }
  return markdownLibsP;
}

// Shown in the preview frame (theme-coloured, never a blank white page)
// while the renderer loads, or if it fails.
function markdownStatusDoc(message, isError) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? '#0d1117' : '#ffffff';
  const fg = dark ? '#9198a1' : '#59636e';
  const safe = String(message).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${bg};color:${fg};font:14px/1.5 ui-sans-serif,system-ui,sans-serif}`
    + `p{max-width:640px;margin:48px auto;padding:0 24px}${isError ? 'p{color:' + (dark ? '#f97066' : '#d92d20') + '}' : ''}</style></head>`
    + `<body><p>${safe}</p></body></html>`;
}

// Resolve a link written in a markdown file (relative to that file) to a
// workspace path, or null for external / in-page links.
function resolveWorkspaceLink(fromPath, href) {
  if (!href || /^([a-z][\w+.-]*:|#|\/\/)/i.test(href)) return null;
  const rawPath = href.split('#')[0].split('?')[0];
  let clean;
  try { clean = decodeURIComponent(rawPath); } catch (e) { clean = rawPath; } // e.g. "100%.md"
  if (!clean) return null;
  const parts = clean.startsWith('/') ? [] : (fromPath || '').split('/').slice(0, -1);
  clean.replace(/^\/+/, '').split('/').forEach((seg) => {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  });
  return parts.join('/');
}

const MARKDOWN_CSS = `
:root { color-scheme: light; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --soft: #f6f8fa; --link: #0969da; --bg: #ffffff; }
html[data-theme="dark"] { color-scheme: dark; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --soft: #151b23; --link: #4493f8; --bg: #0d1117; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; }
.md { max-width: 860px; margin: 0 auto; padding: 32px 40px 80px; overflow-wrap: break-word; }
.md > :first-child { margin-top: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 1.5em 0 0.6em; line-height: 1.25; font-weight: 650; }
.md h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
.md h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
.md h3 { font-size: 1.25em; }
.md h6 { color: var(--muted); }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md table { margin: 0 0 1em; }
.md a { color: var(--link); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md ul, .md ol { padding-left: 2em; }
.md li + li { margin-top: 0.25em; }
.md li > input[type="checkbox"] { margin: 0 0.4em 0 -1.3em; vertical-align: middle; }
.md blockquote { padding: 0 1em; color: var(--muted); border-left: 0.25em solid var(--line); }
.md code { font: 0.875em/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 0.2em 0.4em; border-radius: 6px; background: var(--soft); }
.md pre { padding: 16px; overflow: auto; border-radius: 8px; background: var(--soft); }
.md pre code { padding: 0; background: none; font-size: 0.85em; }
.md table { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; }
.md th, .md td { padding: 6px 13px; border: 1px solid var(--line); }
.md th { font-weight: 650; background: var(--soft); }
.md img { max-width: 100%; border-radius: 4px; }
.md hr { height: 1px; border: 0; background: var(--line); margin: 1.5em 0; }
.md .md-missing { color: var(--muted); font-style: italic; }
.md .md-mermaid { margin: 0 0 1em; padding: 12px; border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; text-align: center; }
.md .md-mermaid svg { max-width: 100%; height: auto; }
.md .md-mermaid.is-error { color: #d92d20; text-align: left; font-size: 13px; white-space: pre-wrap; }
.md img.md-board-img { display: block; max-width: 100%; max-height: 70vh; width: auto; margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; }
`;

function markdownTemplate(source) {
  const raw = window.marked.parse(String(source || ''), { gfm: true, breaks: false });
  const clean = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  return tpl;
}

// A link/image target inside a board: "path.html#frame=ID", "#view=sheet",
// "#slide=3". Returns { path, ref } for workspace boards, else null.
function boardTargetOf(fromPath, href) {
  const hash = String(href || '').split('#')[1] || '';
  if (!/^(frame|view|slide)=/.test(hash)) return null;
  const ws = resolveWorkspaceLink(fromPath, href);
  return ws && /\.html?$/i.test(ws) ? { path: ws, ref: hash } : null;
}

let markdownBoardRenderer = null;
// Images that point at a board frame / gantt view are rendered live (from
// the current board) to data URLs before the preview is built.
async function renderMarkdownBoardImages(source, relPath) {
  const tpl = markdownTemplate(source);
  const wanted = new Map();
  tpl.content.querySelectorAll('img[src]').forEach((img) => {
    const t = boardTargetOf(relPath, img.getAttribute('src'));
    if (t && !t.ref.startsWith('slide=')) wanted.set(t.path + '#' + t.ref, t);
  });
  if (!wanted.size) return {};
  await ensureSlidesAssets();
  if (!markdownBoardRenderer) markdownBoardRenderer = window.SlidesEngine.createRenderer(SLIDES_SOURCE_ASSETS);
  markdownBoardRenderer.clear(); // live: always the current board content
  const out = {};
  for (const [key, t] of wanted) {
    const id = decodeURIComponent(t.ref.split('=')[1] || '');
    try {
      out[key] = await markdownBoardRenderer.renderImage(t.path, id);
    } catch (err) {
      out[key] = { error: (err && err.message) || 'Could not render' };
    }
  }
  return out;
}

// Build the sandboxed preview document for a markdown file. `boardImages`
// comes from renderMarkdownBoardImages().
function renderMarkdownDoc(source, relPath, boardImages, mermaidSvgs) {
  const tpl = markdownTemplate(source);
  applyMermaidSvgs(tpl, mermaidSvgs);
  const origin = location.origin;
  // Images relative to the .md file load from the workspace; board frame
  // images use the live renders.
  tpl.content.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    const t = boardTargetOf(relPath, src);
    if (t) {
      const r = (boardImages || {})[t.path + '#' + t.ref];
      if (typeof r === 'string') {
        img.setAttribute('src', r);
        img.classList.add('md-board-img');
      } else {
        const note = document.createElement('span');
        note.className = 'md-missing';
        note.textContent = '[' + (img.getAttribute('alt') || t.path) + ': ' + ((r && r.error) || 'not available') + ']';
        img.replaceWith(note);
      }
      return;
    }
    const ws = resolveWorkspaceLink(relPath, src);
    if (ws) img.setAttribute('src', origin + '/api/raw?path=' + encodeURIComponent(ws));
  });
  // Links: other workspace files (and frames/slides in them) open in the
  // app; external ones in a new tab.
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) return;
    const ws = resolveWorkspaceLink(relPath, href);
    if (ws) {
      const t = boardTargetOf(relPath, href);
      a.setAttribute('data-open', t ? ws + '#' + t.ref : ws);
      a.setAttribute('href', '#');
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  addHeadingIds(tpl.content);
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const body = tpl.innerHTML.trim() || '<p class="md-missing">This file is empty.</p>';
  return `<!DOCTYPE html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${MARKDOWN_CSS}</style></head>`
    + `<body><article class="md">${body}</article>`
    + `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-open]');if(!a)return;e.preventDefault();parent.postMessage({type:'docviewer-open',path:a.getAttribute('data-open')},'*');});<\/script>`
    // In-page "#heading" links and outline clicks (the app sends the heading's index).
    + `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a||a.hasAttribute('data-open'))return;var t=document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));if(t){e.preventDefault();t.scrollIntoView({block:'start'});}});`
    + `window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='docviewer-scroll')return;var hs=document.querySelectorAll('.md h1,.md h2,.md h3,.md h4,.md h5,.md h6');var h=hs[d.index];if(h)h.scrollIntoView({block:'start',behavior:'smooth'});});<\/script>`
    + `</body></html>`;
}

// --- Headings: ids for links, outline and table of contents ---
// GitHub-style slug: lower case, punctuation dropped, spaces to dashes;
// repeats get -1, -2 ….
function headingSlug(text) {
  return String(text || '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}
function addHeadingIds(root) {
  const seen = new Map();
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const base = headingSlug(h.textContent) || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    if (!h.id) h.id = n ? base + '-' + n : base;
  });
}
// Headings of a markdown source (not inside code fences), with the text as
// it renders (inline markdown removed), level, line and slug.
function markdownHeadings(source) {
  const out = [];
  const seen = new Map();
  let fence = null;
  String(source || '').split('\n').forEach((line, i) => {
    const f = line.match(/^\s{0,3}(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m || !m[2]) return;
    const text = m[2]
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|~~|`)/g, '')
      .trim();
    const base = headingSlug(text) || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.push({ level: m[1].length, text, line: i + 1, slug: n ? base + '-' + n : base });
  });
  return out;
}

// Links in the markdown preview ask the app to open a workspace file.
window.addEventListener('message', (e) => {
  if (!htmlPreviewFrame || e.source !== htmlPreviewFrame.contentWindow) return;
  const d = e.data;
  if (!d || d.type !== 'docviewer-open' || typeof d.path !== 'string' || !d.path) return;
  const [path, ref] = d.path.split('#');
  if (!path || path.split('/').includes('..')) return;
  openFileAt(path, ref);
});

// Open a file and, for boards, jump to a frame / gantt view / slide.
async function openFileAt(path, ref) {
  await openFile(path);
  if (!ref || currentPath !== path || !boardEngine) return;
  const [key, raw] = ref.split('=');
  const val = decodeURIComponent(raw || '');
  try {
    if (key === 'frame' && val && val !== '__all__' && typeof boardEngine.focusFrame === 'function') {
      boardEngine.focusFrame(val);
    } else if (key === 'view' && boardEngine.els && boardEngine.els.mode) {
      const b = boardEngine.els.mode.querySelector('[data-mode="' + CSS.escape(val) + '"]');
      if (b) b.click();
    } else if (key === 'slide' && Array.isArray(boardEngine.data && boardEngine.data.slides)) {
      const n = Math.min(boardEngine.data.slides.length, Math.max(1, parseInt(val, 10) || 1));
      boardEngine.current = n - 1;
      boardEngine.render();
    }
  } catch (err) { /* the file is open; the jump is best effort */ }
}

function isPdfPath(p) {
  return /\.pdf$/i.test(p || '');
}

function applyFileIcon(el, p, kind) {
  el.classList.remove('icon-mindmap', 'icon-flow', 'icon-kanban', 'icon-gantt', 'icon-slides', 'icon-stocks', 'icon-json', 'icon-yaml', 'icon-md', 'icon-pdf');
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
  if (kind === 'slides') {
    el.classList.add('icon-slides');
    el.textContent = 'SL';
    el.title = 'Slides';
    return;
  }
  if (kind === 'stocks') {
    el.classList.add('icon-stocks');
    el.textContent = 'ST';
    el.title = 'Stocks';
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
  if (isMermaidPath(p)) {
    el.classList.add('icon-md');
    el.textContent = 'MMD';
    el.title = 'Mermaid diagram';
    return;
  }
  if (isMarkdownPath(p)) {
    el.classList.add('icon-md');
    el.textContent = 'MD';
    el.title = 'Markdown';
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
  // Pretty is only meaningful for an editable JSON model; track model swaps
  // and read-only toggles (history view) rather than each open/close path.
  editor.onDidChangeModel(updatePrettyBtn);
  editor.onDidChangeModelLanguage(updatePrettyBtn);
  editor.onDidChangeConfiguration(updatePrettyBtn);
  updatePrettyBtn();
  loadTree().catch(() => {}).then(restoreLastFile);
});

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  if (!autoSaveEnabled || !isDirty || saveInFlight || previewMode) return;
  autoSaveTimer = setTimeout(() => {
    if (!isDirty || saveInFlight) return;
    saveCurrentFile();
  }, 800);
}

// --- File tree ---
let bookmarks = { categories: [], items: [] };
let expandedFolders = new Set();
let lastTreeChildren = [];
let dataRootPath = ''; // absolute path of the workspace on the server's disk

let loadTreeInflight = null;
async function loadTree() {
  if (loadTreeInflight) return loadTreeInflight;
  loadTreeInflight = (async () => {
    const [treeRes] = await Promise.all([fetch('/api/tree'), loadFavorites()]);
    const data = await treeRes.json();
    lastTreeChildren = data.children;
    dataRootPath = data.rootPath || '';
    treeEl.innerHTML = '';
    treeEl.appendChild(renderNodes(data.children));
    if (typeof decorateTreeTags === 'function') decorateTreeTags();
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

// The "Files" header always accepts drops into the top level, even when the
// tree is too full to leave any empty space to drop on.
const treeHeaderEl = document.getElementById('tree-header');
treeHeaderEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  treeHeaderEl.classList.add('drop-target');
});
treeHeaderEl.addEventListener('dragleave', () => treeHeaderEl.classList.remove('drop-target'));
treeHeaderEl.addEventListener('drop', (e) => {
  e.preventDefault();
  treeHeaderEl.classList.remove('drop-target');
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
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmark(relPath);
  });
  star.dataset.favPath = relPath;
  return star;
}

async function toggleBookmark(relPath) {
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
  if (currentPath && (currentPath === relPath || currentPath.startsWith(relPath + '/'))) closeOpenFile();
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

function deleteFolder(relPath) {
  deleteItem(relPath, {
    endpoint: '/api/folder/delete',
    kind: 'Folder',
    confirmMessage: `Delete folder "${relPath}" and everything inside it? This cannot be undone on disk.`,
  });
}

function deleteFile(relPath) {
  deleteItem(relPath, {
    endpoint: '/api/file/delete',
    kind: 'File',
    confirmMessage: `Delete "${relPath}"? This cannot be undone on disk.`,
  });
}

// --- Tree context menu ---
let treeMenuEl = null;

function closeTreeMenu() {
  if (!treeMenuEl) return;
  treeMenuEl.remove();
  treeMenuEl = null;
  document.querySelectorAll('.tree-row.menu-target').forEach((r) => r.classList.remove('menu-target'));
}

// items: [{ label, action, danger? } | 'sep']
function showTreeMenu(x, y, items) {
  closeTreeMenu();
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'tree-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'tree-menu-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closeTreeMenu();
      item.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // Keep the menu on screen near the edges.
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
  treeMenuEl = menu;
  const first = menu.querySelector('button');
  if (first) first.focus();
}

async function copyPath(relPath) {
  // Fall back to the workspace-relative path if the server didn't send its root.
  const full = dataRootPath ? dataRootPath.replace(/[\\/]+$/, '') + '/' + relPath : relPath;
  try {
    await navigator.clipboard.writeText(full);
    setStatus('Copied path', 'ok');
  } catch (err) {
    setStatus('Copy failed', 'dirty');
  }
}

function treeMenuItems(node, row) {
  const p = node.path;
  const toTop = p.includes('/') ? [{ label: 'Move to top level', action: () => moveFile(p, null) }] : [];
  const bookmark = { label: isFavorited(p) ? 'Remove bookmark' : 'Bookmark…', action: () => toggleBookmark(p) };
  if (node.type === 'dir') {
    return [
      { label: row.classList.contains('is-open') ? 'Collapse' : 'Expand', action: () => row.click() },
      'sep',
      { label: 'New here…', action: () => openCreateDialog(p) },
      { label: 'Import here…', action: () => pickImport(p) },
      'sep',
      { label: 'Rename…', action: () => renamePath(p, true) },
      ...toTop,
      bookmark,
      { label: 'Export as zip', action: () => downloadHref(p) },
      { label: 'Export as website (.zip)', action: () => exportFolderSite(p) },
      { label: 'Export as website (single HTML)', action: () => exportFolderSiteSingle(p) },
      { label: 'Build network topology…', action: () => buildTopology(p) },
      { label: 'Export as PDF', action: () => exportFolderPdf(p) },
      { label: 'Copy path', action: () => copyPath(p) },
      'sep',
      { label: 'Delete folder…', action: () => deleteFolder(p), danger: true },
    ];
  }
  return [
    { label: 'Open', action: () => openFile(p) },
    { label: 'Tags…', action: () => openTagEditor(p) },
    { label: 'Save as template', action: () => saveAsTemplate(p) },
    ...(/\.json$/i.test(p) ? [{ label: 'Build network topology…', action: () => buildTopology(p) }] : []),
    'sep',
    { label: 'Rename…', action: () => renamePath(p, false) },
    ...toTop,
    bookmark,
    { label: 'Export', action: () => downloadHref(p) },
    { label: 'Copy path', action: () => copyPath(p) },
    'sep',
    { label: 'Delete file…', action: () => deleteFile(p), danger: true },
  ];
}

function attachTreeMenu(row, node) {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = treeMenuItems(node, row);
    showTreeMenu(e.clientX, e.clientY, items);
    row.classList.add('menu-target');
  });
}

document.getElementById('tree').addEventListener('contextmenu', (e) => {
  // Rows stop propagation, so this only fires on empty tree space.
  e.preventDefault();
  showTreeMenu(e.clientX, e.clientY, [
    { label: 'New…', action: () => openCreateDialog('') },
    { label: 'Import…', action: () => pickImport('') },
    'sep',
    { label: 'Export workspace as website (.zip)', action: () => exportFolderSite('') },
    { label: 'Export workspace as website (single HTML)', action: () => exportFolderSiteSingle('') },
    { label: 'Export workspace as PDF', action: () => exportFolderPdf('') },
    'sep',
    { label: 'Refresh', action: () => loadTree() },
  ]);
});
document.addEventListener('mousedown', (e) => {
  if (treeMenuEl && !treeMenuEl.contains(e.target)) closeTreeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTreeMenu();
});
window.addEventListener('blur', closeTreeMenu);
window.addEventListener('resize', closeTreeMenu);
document.addEventListener('scroll', closeTreeMenu, true);

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

const BOARD_LABELS = { mindmap: 'mindmap', flow: 'flow', kanban: 'kanban', gantt: 'gantt', slides: 'slides', stocks: 'stock watchlist' };

const CREATE_KINDS = [
  { id: 'file', label: 'File', hint: 'Any file. Include an extension, e.g. notes.json', placeholder: 'notes.json' },
  { id: 'markdown', label: 'Markdown', hint: 'Markdown document. .md is added if you omit it', placeholder: 'notes' },
  { id: 'mermaid', label: 'Mermaid', hint: 'Text-defined diagram (flowchart, sequence, …). .mmd is added if you omit it', placeholder: 'diagram' },
  { id: 'mindmap', label: 'Mindmap', hint: 'Tree board. .html is added if you omit it', placeholder: 'ideas' },
  { id: 'flow', label: 'Flow', hint: 'Flowchart board. .html is added if you omit it', placeholder: 'process' },
  { id: 'kanban', label: 'Kanban', hint: 'Task board with columns. .html is added if you omit it', placeholder: 'sprint' },
  { id: 'gantt', label: 'Gantt', hint: 'Timeline of tasks and dependencies. .html is added if you omit it', placeholder: 'roadmap' },
  { id: 'slides', label: 'Slides', hint: 'Presentation built from mindmap/flow frames and gantt charts. .html is added if you omit it', placeholder: 'deck' },
  { id: 'stocks', label: 'Stocks', hint: 'Watchlist of NSE / BSE / US tickers with live prices and price alerts. .html is added if you omit it', placeholder: 'watchlist' },
  { id: 'folder', label: 'Folder', hint: 'New directory under data/', placeholder: 'folder-name' },
  { id: 'template', label: 'From template…', hint: 'Pick a starter: meeting notes, standup, design review, sprint board, project plan, decks… Press Create to browse.', needsName: false },
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
  if (result && result.kind === 'template') return openTemplateGallery(parentPath);
  if (!result || !result.name) return;
  if (result.kind === 'folder') return createFolder(parentPath, result.name);
  if (result.kind === 'mermaid') {
    const name = result.name.trim();
    return createFile(parentPath, /\.(mmd|mermaid)$/i.test(name) ? name : name + '.mmd');
  }
  if (result.kind === 'markdown') {
    const name = result.name.trim();
    return createFile(parentPath, /\.(md|markdown)$/i.test(name) ? name : name + '.md');
  }
  if (result.kind === 'mindmap') return createBoardFile(parentPath, result.name, 'mindmap');
  if (result.kind === 'flow') return createBoardFile(parentPath, result.name, 'flow');
  if (result.kind === 'kanban') return createBoardFile(parentPath, result.name, 'kanban');
  if (result.kind === 'gantt') return createBoardFile(parentPath, result.name, 'gantt');
  if (result.kind === 'slides') return createBoardFile(parentPath, result.name, 'slides');
  if (result.kind === 'stocks') return createBoardFile(parentPath, result.name, 'stocks');
  return createFile(parentPath, result.name);
}

if (newFileBtn) newFileBtn.addEventListener('click', () => openCreateDialog(null));
if (importBtn) importBtn.addEventListener('click', () => pickImport(''));
document.getElementById('tree-import-btn').addEventListener('click', () => pickImport(''));
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

async function exportStandaloneFile(fileName) {
  if (!boardEngine || typeof boardEngine.exportStandalone !== 'function') {
    setStatus('Standalone export is only for boards (mindmap, flow, kanban, gantt, slides)', 'dirty');
    return;
  }
  if (boardEngine && viewMode === 'board') syncBoardIntoEditor();
  const base = currentPath ? currentPath.split('/').pop().replace(/\.html?$/i, '') : '';
  const name = typeof fileName === 'string' ? fileName : (base ? base + '-standalone.html' : undefined);
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
  // A saved board (mindmap/flow/kanban/gantt) holds only its data and needs
  // the app's engine to draw, so opened on its own it is a blank page.
  // Export the self-contained version instead; it still re-imports as a board.
  if (boardEngine && typeof boardEngine.exportStandalone === 'function') {
    exportStandaloneFile(name);
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
  await movePath(fromPath, toPath, 'Move');
}

async function renamePath(fromPath, isFolder) {
  const slash = fromPath.lastIndexOf('/');
  const parent = slash >= 0 ? fromPath.slice(0, slash) : '';
  const oldName = fromPath.slice(slash + 1);
  const input = await showAsk({
    title: isFolder ? 'Rename folder' : 'Rename file',
    label: 'New name',
    value: oldName,
    confirmLabel: 'Rename',
  });
  if (!input) return;
  const newName = String(input).trim();
  if (!newName || newName === oldName) return;
  if (/[\/\\]/.test(newName) || newName === '.' || newName === '..') {
    alert('Name cannot contain "/" or "\\", or be "." / "..".');
    return;
  }
  if (!isFolder && currentPath === fromPath && isDirty) {
    alert('Save or discard your changes to this file before renaming it.');
    return;
  }
  await movePath(fromPath, parent ? `${parent}/${newName}` : newName, 'Rename');
}

async function movePath(fromPath, toPath, verb) {
  // A move expands the destination folder so the item stays visible.
  const toFolderPath = verb === 'Move' && toPath.includes('/')
    ? toPath.slice(0, toPath.lastIndexOf('/'))
    : '';
  const res = await fetch('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromPath, to: toPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(verb + ' failed: ' + data.error);
    return;
  }
  // The open file may be the moved path itself or live under a moved folder.
  const wasCurrent = !!currentPath
    && (currentPath === fromPath || currentPath.startsWith(fromPath + '/'));
  const newCurrent = wasCurrent ? toPath + currentPath.slice(fromPath.length) : null;
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
    currentPath = newCurrent;
    rememberLastFile(newCurrent);
    currentPathEl.textContent = newCurrent;
    highlightActiveRow(newCurrent);
  }

  const past = verb === 'Rename' ? 'Renamed' : 'Moved';
  const commitMsg = await uiPrompt(
    `${past} "${fromPath}" to "${toPath}". Enter a commit message to save this ${verb.toLowerCase()} to history, or skip to leave it uncommitted.`,
    `${verb} ${fromPath} -> ${toPath}`,
    { title: `Commit ${verb.toLowerCase()}?`, okLabel: 'Commit', cancelLabel: 'Skip' }
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
    setStatus(`Nothing to commit for that ${verb.toLowerCase()}`, 'dirty');
  } else {
    setStatus(`${verb} committed`, 'ok');
  }
}

function renderNodes(nodes) {
  const container = document.createElement('div');
  container.className = 'tree-list';
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (node.type === 'dir' ? 'is-folder' : 'is-file');
    row.dataset.path = node.path;
    row.title = node.path; // full path on hover
    attachTreeMenu(row, node);

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
      row.addEventListener('click', () => openFile(node.path));

      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));

      // Dropping onto a file drops into the folder that holds it.
      const parentPath = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
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
          importFileList(e.dataTransfer.files, parentPath);
          return;
        }
        const fromPath = e.dataTransfer.getData('text/plain');
        if (fromPath && fromPath !== node.path) moveFile(fromPath, parentPath || null);
      });

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
  if (/data-docviewer\s*=\s*["']slides["']/.test(content)) return 'slides';
  if (/data-docviewer\s*=\s*["']stocks["']/.test(content)) return 'stocks';
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
  noteUnsaved(true);
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
    if (flag === 'data-sl-core') window.SlidesCore = undefined;
    if (flag === 'data-sl-js') window.SlidesEngine = undefined;
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
  ensureStylesheet('/mindmap/engine.css?v=97', 'data-mm-css');
  return ensureScript('/mindmap/engine.js?v=136', 'data-mm-js', () => typeof window.MindmapEngine === 'function');
}

function ensureFlowAssets() {
  ensureStylesheet('/flow/engine.css?v=24', 'data-fl-css');
  return ensureScript('/flow/core.js?v=21', 'data-fl-core', () => !!window.FlowCore)
    .then(() => ensureScript('/flow/engine.js?v=39', 'data-fl-js', () => typeof window.FlowEngine === 'function'));
}

function ensureKanbanAssets() {
  ensureStylesheet('/kanban/engine.css?v=2', 'data-kb-css');
  return ensureScript('/kanban/core.js?v=2', 'data-kb-core', () => !!window.KanbanCore)
    .then(() => ensureScript('/kanban/engine.js?v=6', 'data-kb-js', () => typeof window.KanbanEngine === 'function'));
}

function ensureGanttAssets() {
  ensureStylesheet('/gantt/engine.css?v=18', 'data-gt-css');
  return ensureScript('/gantt/core.js?v=8', 'data-gt-core', () => !!window.GanttCore)
    .then(() => ensureScript('/gantt/engine.js?v=25', 'data-gt-js', () => typeof window.GanttEngine === 'function'));
}

function ensureStocksAssets() {
  ensureStylesheet('/stocks/engine.css?v=1', 'data-stk-css');
  return ensureScript('/stocks/core.js?v=1', 'data-stk-core', () => !!window.StocksCore)
    .then(() => ensureScript('/stocks/engine.js?v=2', 'data-stk-js', () => typeof window.StocksEngine === 'function'));
}

function ensureSlidesAssets() {
  ensureStylesheet('/slides/engine.css?v=6', 'data-sl-css');
  return ensureScript('/slides/core.js?v=5', 'data-sl-core', () => !!window.SlidesCore)
    .then(() => ensureScript('/slides/engine.js?v=11', 'data-sl-js', () => typeof window.SlidesEngine === 'function'));
}

// Slides render live windows of mindmap/flow frames and gantt charts, so
// they need to be able to load those editors' code.
const SLIDES_SOURCE_ASSETS = { mindmap: ensureMindmapAssets, flow: ensureFlowAssets, gantt: ensureGanttAssets };

const BOARD_TYPES = {
  mindmap: { engine: 'MindmapEngine', ensure: ensureMindmapAssets },
  flow: { engine: 'FlowEngine', ensure: ensureFlowAssets },
  kanban: { engine: 'KanbanEngine', ensure: ensureKanbanAssets },
  gantt: { engine: 'GanttEngine', ensure: ensureGanttAssets },
  slides: { engine: 'SlidesEngine', ensure: ensureSlidesAssets, opts: { ensureAssets: SLIDES_SOURCE_ASSETS } },
  stocks: { engine: 'StocksEngine', ensure: ensureStocksAssets, opts: { getPath: () => currentPath } },
};

function getSaveContent() {
  if (boardEngine && viewMode === 'board') {
    return boardEngine.serializeToHtml();
  }
  return editor && editor.getValue ? editor.getValue() : '';
}

// After opening a file. Board engines emit change events while they load and
// measure, so board changes are ignored for a moment (not editor typing).
function markClean() {
  isDirty = false;
  ignoreDirtyUntil = Date.now() + 1500;
  clearTimeout(autoSaveTimer);
}

function noteUnsaved(fromBoard) {
  if (!currentPath || isPdfPath(currentPath) || previewMode) return;
  if (fromBoard && Date.now() < ignoreDirtyUntil) return;
  editGen++;
  if (!isDirty) {
    isDirty = true;
    saveBtn.disabled = false;
    setStatus('Modified (unsaved)', 'dirty');
  }
  if (autoSaveEnabled) scheduleAutoSave();
}

async function confirmLeaveIfDirty() {
  if (previewMode === 'conversion') {
    const ok = await showAsk({
      title: 'Discard conversion?',
      label: 'The converted text has not been saved. Use Save as to keep it.',
      mode: 'confirm',
      danger: true,
      confirmLabel: 'Discard',
    });
    return !!ok;
  }
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

// Leave the open file and show the Today screen (no file open).
function closeOpenFile() {
  currentPath = null;
  previewMode = null;
  markClean();
  setWelcomeVisible(true);
  rememberLastFile(null);
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

// --- Welcome banner & last opened file ---
const welcomeEl = document.getElementById('welcome');
const LAST_FILE_KEY = 'docviewer-last-file';

function setWelcomeVisible(on) {
  // 'pending' blanks the card during launch until we know whether a file is restored.
  welcomeEl.classList.remove('pending');
  welcomeEl.classList.toggle('hidden', !on);
}

// Saved in localStorage and on the server (survives port/origin changes).
// Recently opened files (for the Today screen and Cmd+K).
const RECENT_KEY = 'docviewer-recent';
function recentFiles() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x && x.path); } catch (e) { return []; }
}
function noteRecent(relPath) {
  if (!relPath) return;
  try {
    const list = recentFiles().filter((x) => x.path !== relPath);
    list.unshift({ path: relPath, at: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
  } catch (e) { /* ignore */ }
}

// Show Today: asks about unsaved changes first.
async function showToday() {
  if (currentPath) {
    if (!(await confirmLeaveIfDirty())) return;
    closeOpenFile();
  } else setWelcomeVisible(true);
  highlightActiveRow(null);
}

function rememberLastFile(relPath) {
  noteRecent(relPath);
  try {
    if (relPath) localStorage.setItem(LAST_FILE_KEY, relPath);
    else localStorage.removeItem(LAST_FILE_KEY);
  } catch (e) { /* ignore */ }
  saveUiSetting({ lastFile: relPath || null });
}

function treeHasFile(nodes, relPath) {
  for (const n of nodes || []) {
    if (n.path === relPath && n.type !== 'dir') return true;
    if (n.type === 'dir' && relPath.startsWith(n.path + '/') && treeHasFile(n.children, relPath)) return true;
  }
  return false;
}

async function restoreLastFile() {
  let last = null;
  const cfg = await uiSettingsReady;
  last = cfg && cfg.lastFile;
  if (!last) {
    try { last = localStorage.getItem(LAST_FILE_KEY); } catch (e) { /* ignore */ }
  }
  // Something was opened while we were looking it up; leave it alone.
  if (currentPath) return;
  if (!last || !treeHasFile(lastTreeChildren, last)) {
    setWelcomeVisible(true);
    return;
  }
  // Expand the folders leading to it so it's visible in the tree.
  const parts = last.split('/');
  for (let i = 1; i < parts.length; i++) expandedFolders.add(parts.slice(0, i).join('/'));
  try {
    await loadTree();
    await openFile(last);
  } finally {
    if (!currentPath) setWelcomeVisible(true);
  }
}

document.getElementById('welcome-new').addEventListener('click', () => openCreateDialog(''));
document.getElementById('today-btn').addEventListener('click', () => showToday());
document.getElementById('welcome-import').addEventListener('click', () => pickImport(''));

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
  previewMode = null;
  setWelcomeVisible(false);
  rememberLastFile(relPath);
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
  previewMode = null;
  setWelcomeVisible(false);
  rememberLastFile(relPath);
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
      boardEngine = new window.MindmapEngine(mindmapStage, { onChange: onBoardChange, getPath: () => currentPath });
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
      boardEngine = new window.FlowEngine(mindmapStage, { onChange: onBoardChange, getPath: () => currentPath });
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
  } else if (boardKind === 'slides') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureSlidesAssets();
      if (token !== openToken) return;
      boardEngine = new window.SlidesEngine(mindmapStage, { onChange: onBoardChange, ensureAssets: SLIDES_SOURCE_ASSETS, getPath: () => currentPath });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Slides failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (boardKind === 'stocks') {
    viewToggleBtn.classList.remove('hidden');
    try {
      await ensureStocksAssets();
      if (token !== openToken) return;
      boardEngine = new window.StocksEngine(mindmapStage, { onChange: onBoardChange, getPath: () => currentPath });
      boardEngine.loadFromHtml(data.content);
      setViewMode('board');
    } catch (err) {
      if (token !== openToken) return;
      console.error(err);
      alert('Stocks failed to load: ' + ((err && err.message) || err));
      setViewMode('code');
    }
  } else if (isHtml || isMarkdownPath(relPath) || isMermaidPath(relPath)) {
    // HTML and markdown open rendered; the toggle shows the raw file.
    viewToggleBtn.classList.remove('hidden');
    setViewMode('render');
  } else {
    viewToggleBtn.classList.add('hidden');
    setViewMode('code');
  }
  setStandaloneVisible(!!boardKind && boardKind !== 'stocks');
  if (token !== openToken) return;
  markClean();
}

// Load a document into the preview frame. A counter comment makes every
// load a real navigation: re-setting identical srcdoc on a frame that was
// hidden (View Source -> View Rendered) can otherwise leave it blank white.
let previewLoads = 0;
function setPreviewDoc(html) {
  htmlPreviewFrame.srcdoc = html + '\n<!-- docviewer preview ' + (++previewLoads) + ' -->';
}

function setViewMode(mode) {
  viewMode = mode;
  htmlPreviewFrame.classList.add('hidden');
  // Unload the preview when leaving it, so coming back always starts fresh.
  if (mode !== 'render' && htmlPreviewFrame.hasAttribute('srcdoc')) htmlPreviewFrame.removeAttribute('srcdoc');
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
    // Show the frame first so it navigates while visible.
    htmlPreviewFrame.classList.remove('hidden');
    if (isMarkdownPath(currentPath)) {
      const path = currentPath;
      const source = editor.getValue();
      const token = ++markdownRenderToken;
      const stillWanted = () => token === markdownRenderToken && viewMode === 'render' && currentPath === path;
      const ready = MARKDOWN_LIBS.every((lib) => lib.ready());
      if (!ready) setPreviewDoc(markdownStatusDoc('Rendering…'));
      const dark = document.documentElement.dataset.theme === 'dark';
      ensureMarkdownLibs()
        .then(() => Promise.all([
          renderMarkdownBoardImages(source, path).catch(() => ({})),
          /```\s*mermaid/i.test(source) ? renderMermaidBlocks(source, dark).catch((e) => [{ error: 'Mermaid could not load: ' + ((e && e.message) || e) }]) : [],
        ]))
        .then(([boardImages, mermaidSvgs]) => {
        if (!stillWanted()) return;
        try {
          setPreviewDoc(renderMarkdownDoc(source, path, boardImages, mermaidSvgs));
        } catch (err) {
          setPreviewDoc(markdownStatusDoc('Could not render this file: ' + ((err && err.message) || err) + '. Use View Source to see it.', true));
        }
      }).catch((err) => {
        if (!stillWanted()) return;
        setPreviewDoc(markdownStatusDoc('Could not load the markdown renderer (' + ((err && err.message) || err) + '). Use View Source to see the file, or reopen it to retry.', true));
      });
    } else if (isMermaidPath(currentPath)) {
      const path = currentPath;
      const token = ++markdownRenderToken;
      setPreviewDoc(markdownStatusDoc('Rendering diagram…'));
      renderMermaidSvg(editor.getValue(), document.documentElement.dataset.theme === 'dark').then((svg) => {
        if (token === markdownRenderToken && viewMode === 'render' && currentPath === path) setPreviewDoc(mermaidPageDoc(svg));
      }).catch((err) => {
        if (token !== markdownRenderToken || viewMode !== 'render' || currentPath !== path) return;
        setPreviewDoc(markdownStatusDoc('Diagram error: ' + String((err && err.message) || err) + ' — use View Source to fix it.', true));
      });
    } else {
      setPreviewDoc(editor.getValue());
    }
    viewToggleBtn.textContent = 'View Source';
    findInFileBtn.disabled = false;
  } else {
    if (boardEngine) syncBoardIntoEditor();
    document.getElementById('editor').classList.remove('hidden');
    viewToggleBtn.textContent = boardKind === 'mindmap' ? 'View Mindmap' : boardKind === 'flow' ? 'View Flow' : boardKind === 'kanban' ? 'View Kanban' : boardKind === 'gantt' ? 'View Gantt' : boardKind === 'slides' ? 'View Slides' : boardKind === 'stocks' ? 'View Stocks' : 'View Rendered';
    findInFileBtn.disabled = !currentPath;
    if (boardEngine && editor) {
      editor.layout();
    }
  }
  if (typeof syncMarkdownToolbar === 'function') syncMarkdownToolbar();
  if (typeof refreshBacklinks === 'function') refreshBacklinks();
  if (typeof refreshFileTags === 'function') refreshFileTags();
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
  if (!currentPath || isPdfPath(currentPath) || previewMode) return false;
  if (saveInFlight) return saveInFlight;
  saveInFlight = (async () => {
    clearTimeout(autoSaveTimer);
    setStatus('Saving…');
    await new Promise((r) => setTimeout(r, 0));
    if (boardEngine && typeof boardEngine.flushEdit === 'function') boardEngine.flushEdit();
    else if (boardEngine && typeof boardEngine.commitEdit === 'function') boardEngine.commitEdit();
    const savedPath = currentPath;
    const gen = editGen;
    const content = getSaveContent();
    const { res, data } = await postFileContent(savedPath, content);
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || 'Save failed';
      setStatus('Save failed: ' + msg, 'dirty');
      alert('Save failed: ' + msg);
      return false;
    }
    if (currentPath === savedPath && editGen === gen) {
      isDirty = false;
      clearTimeout(autoSaveTimer);
    } else if (currentPath === savedPath) {
      // Edited while saving: still unsaved; autosave runs again below.
      setStatus('Modified (unsaved)', 'dirty');
    }
    runValidation();
    // A saved note may add or remove links to other files.
    if (typeof refreshBacklinks === 'function' && isMarkdownPath(savedPath)) setTimeout(() => refreshBacklinks(true), 0);
    return true;
  })().finally(() => {
    saveInFlight = null;
    if (isDirty && autoSaveEnabled) scheduleAutoSave();
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

function updatePrettyBtn() {
  const model = editor && editor.getModel();
  const isJson = !!model && model.getLanguageId() === 'json';
  // Hidden for non-JSON files; shown but disabled for read-only JSON (history).
  prettyBtn.classList.toggle('hidden', !isJson);
  prettyBtn.disabled = !isJson || editor.getOption(monaco.editor.EditorOption.readOnly);
}

prettyBtn.addEventListener('click', () => {
  if (prettyBtn.disabled) return;
  const model = editor.getModel();
  const text = model.getValue();
  let pretty;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2) + '\n';
  } catch (e) {
    alert('Cannot pretty-print: invalid JSON.\n' + e.message);
    return;
  }
  if (pretty === text) return;
  // executeEdits keeps it undoable and fires the normal dirty/autosave path.
  editor.pushUndoStop();
  editor.executeEdits('pretty', [{ range: model.getFullModelRange(), text: pretty }]);
  editor.pushUndoStop();
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

  const message = await uiPrompt('Commit message for this version:', defaultCommitMessage(), { title: 'Commit', okLabel: 'Commit' });
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
      else if (r.kind === 'slides') bits.push('Slides');
      else if (r.kind === 'stocks') bits.push('Stocks');
      else if (r.kind === 'json') bits.push('JSON');
      else if (r.kind === 'yaml') bits.push('YAML');
      else if (r.kind === 'markdown') bits.push('Markdown');
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
    historyList.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'search-empty';
    msg.textContent = 'Error: ' + (data.error || 'unknown');
    historyList.appendChild(msg);
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
  // Unsaved edits would otherwise be autosaved (or "saved") as the old version.
  if (!(await confirmLeaveIfDirty())) return;
  const path = currentPath;
  const token = ++openToken;
  const res = await fetch(`/api/version?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`);
  const data = await res.json();
  if (token !== openToken || currentPath !== path) return; // another file was opened meanwhile
  if (!res.ok) {
    alert('Failed to load version: ' + data.error);
    return;
  }
  markClean();
  previewMode = 'history';
  commitBtn.disabled = true;
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
      boardEngine = new window[board.engine](mindmapStage, Object.assign({}, board.opts, { onChange: onBoardChange, readOnly: true }));
    }
    boardKind = previewKind;
    boardEngine.setReadOnly(true);
    boardEngine.loadFromHtml(data.content);
    setViewMode('board');
  } else if (boardEngine) {
    // This old version isn't a board: show it as text, not the live board.
    destroyBoard();
    viewToggleBtn.classList.add('hidden');
    setViewMode('code');
  }
}

backToLatestBtn.addEventListener('click', () => {
  previewMode = null;
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
    // A preview: Save would write the converted text into the original file.
    markClean();
    previewMode = 'conversion';
    saveBtn.disabled = true;
    commitBtn.disabled = true;
    setStatus('Conversion preview — use Save as to keep it', 'dirty');
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
