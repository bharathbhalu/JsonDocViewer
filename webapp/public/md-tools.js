// Markdown authoring toolbar: formatting, and inserting tables, links,
// images, workspace files and cross-links / live images of board frames,
// gantt views and slides. Shown for .md files (source and rendered views);
// edits go into the Monaco model at the cursor.
// Uses app.js globals (editor, currentPath, viewMode, setViewMode, ...).
(function () {
  const bar = document.getElementById('md-toolbar');
  if (!bar) return;
  const dlg = document.getElementById('md-dialog');
  const dlgTitle = dlg.querySelector('.md-dialog-title');
  const dlgBody = dlg.querySelector('.md-dialog-body');
  const dlgFoot = dlg.querySelector('.md-dialog-foot');
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const KIND_LABEL = { mindmap: 'Mindmap', flow: 'Flow', gantt: 'Gantt', slides: 'Slides' };
  const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- show / hide ----------
  window.syncMarkdownToolbar = function syncMarkdownToolbar() {
    const on = !!currentPath && isMarkdownPath(currentPath) && (viewMode === 'code' || viewMode === 'render');
    bar.classList.toggle('hidden', !on);
    syncOutline(on);
    if (!on) closeDialog();
    else ensureTurndown().catch(() => {}); // ready before the first paste
    if (editor) requestAnimationFrame(() => editor.layout());
  };

  // ---------- editing primitives ----------
  function model() {
    return editor && editor.getModel();
  }

  // Apply edits as one undo step; re-render the preview if it is showing.
  function edit(edits, selection) {
    const m = model();
    if (!m) return;
    editor.pushUndoStop();
    editor.executeEdits('md-tools', edits, selection ? [selection] : undefined);
    editor.pushUndoStop();
    if (viewMode === 'render') setViewMode('render');
    else editor.focus();
  }

  function selection() {
    return editor.getSelection() || new monaco.Selection(1, 1, 1, 1);
  }

  function selectedText() {
    const m = model();
    return m ? m.getValueInRange(selection()) : '';
  }

  // Wrap the selection (or a placeholder) with markers, e.g. **bold**.
  function wrap(before, after, placeholder) {
    const sel = selection();
    const text = model().getValueInRange(sel) || placeholder;
    const range = new monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
    const startCol = sel.startColumn + before.length;
    const lines = text.split('\n');
    const endLine = sel.startLineNumber + lines.length - 1;
    const endCol = (lines.length === 1 ? startCol : 1) + lines[lines.length - 1].length;
    edit([{ range, text: before + text + after, forceMoveMarkers: true }],
      new monaco.Selection(sel.startLineNumber, startCol, endLine, endCol));
  }

  // Toggle a line prefix (heading, list, quote...) on every selected line.
  // Toggle a block prefix on the selected lines. `ownRe` matches this exact
  // prefix (all lines have it -> remove it); `stripRe` matches any competing
  // prefix of the same family, which is replaced (H1 -> H2, bullet -> task).
  // Indentation is kept.
  function prefixLines(makePrefix, ownRe, stripRe) {
    const m = model();
    const sel = selection();
    // A drag that ends at the very start of the next line doesn't include it.
    const last = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    const edits = [];
    let n = 0;
    let allHave = true;
    for (let ln = sel.startLineNumber; ln <= last; ln++) {
      if (!ownRe.test(m.getLineContent(ln))) allHave = false;
    }
    for (let ln = sel.startLineNumber; ln <= last; ln++) {
      const line = m.getLineContent(ln);
      const indent = (line.match(/^[ \t]*/) || [''])[0];
      const body = line.replace(stripRe || ownRe, '').replace(/^[ \t]*/, '');
      const next = allHave ? indent + body : indent + makePrefix(n++) + body;
      edits.push({ range: new monaco.Range(ln, 1, ln, line.length + 1), text: next });
    }
    edit(edits);
  }

  const HEADING = /^[ \t]*#{1,6}[ \t]+/;
  const ANY_LIST = /^[ \t]*([-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/;

  // Wrap the selected lines (or a placeholder) in a fenced code block.
  function codeBlock() {
    const m = model();
    const sel = selection();
    if (sel.isEmpty()) {
      insertBlock('```\ncode\n```');
      return;
    }
    const last = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    const lines = [];
    for (let ln = sel.startLineNumber; ln <= last; ln++) lines.push(m.getLineContent(ln));
    const range = new monaco.Range(sel.startLineNumber, 1, last, m.getLineMaxColumn(last));
    const text = '```\n' + lines.join('\n') + '\n```';
    edit([{ range, text }], new monaco.Selection(sel.startLineNumber + lines.length + 1, 4, sel.startLineNumber + lines.length + 1, 4));
  }

  // Insert a block on its own lines at the cursor (blank line around it).
  function insertBlock(text) {
    const m = model();
    const sel = selection();
    const pos = sel.getEndPosition();
    const line = m.getLineContent(pos.lineNumber);
    const atLineStart = pos.column === 1;
    const lineEmpty = !line.trim();
    let before = '';
    if (!lineEmpty) before = atLineStart ? '' : '\n\n';
    else if (pos.lineNumber > 1 && m.getLineContent(pos.lineNumber - 1).trim()) before = '\n';
    const insertPos = lineEmpty ? new monaco.Position(pos.lineNumber, 1) : (atLineStart ? pos : new monaco.Position(pos.lineNumber, line.length + 1));
    const after = '\n\n';
    const range = new monaco.Range(insertPos.lineNumber, insertPos.column, insertPos.lineNumber, lineEmpty ? line.length + 1 : insertPos.column);
    const full = before + text + after;
    const added = full.split('\n');
    const endLine = insertPos.lineNumber + added.length - 1;
    edit([{ range, text: full, forceMoveMarkers: true }], new monaco.Selection(endLine, 1, endLine, 1));
  }

  // Insert inline text (link, image) replacing the selection, with a space
  // before it when it would otherwise run into the previous word or link.
  function insertInline(text) {
    const sel = selection();
    if (sel.startColumn > 1) {
      const prev = model().getLineContent(sel.startLineNumber).charAt(sel.startColumn - 2);
      if (prev && !/\s|[(\[]/.test(prev)) text = ' ' + text;
    }
    const range = new monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
    const lines = text.split('\n');
    const endLine = sel.startLineNumber + lines.length - 1;
    const endCol = (lines.length === 1 ? sel.startColumn : 1) + lines[lines.length - 1].length;
    edit([{ range, text, forceMoveMarkers: true }], new monaco.Selection(endLine, endCol, endLine, endCol));
  }

  // ---------- paths ----------
  // Link from the open .md file to a workspace path, relative and URL-safe.
  function relLink(target) {
    const from = (currentPath || '').split('/').slice(0, -1);
    const to = target.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = from.slice(i).map(() => '..');
    const rel = up.concat(to.slice(i)).join('/') || to[to.length - 1];
    return rel.split('/').map((seg) => encodeURIComponent(seg).replace(/%2E/g, '.')).join('/');
  }

  function mdText(v) {
    return String(v || '').replace(/([\[\]\\])/g, '\\$1');
  }

  // ---------- table of contents & outline ----------
  // Insert "- [Heading](#slug)" for every heading after the cursor's position
  // ignores the TOC's own heading; nested by level.
  function insertToc() {
    const heads = markdownHeadings(editor.getValue());
    if (!heads.length) {
      if (typeof setStatus === 'function') setStatus('Add some headings first (# Title, ## Section …)', 'dirty');
      return;
    }
    const min = Math.min(...heads.map((h) => h.level));
    const lines = heads.map((h) => '  '.repeat(h.level - min) + '- [' + mdText(h.text) + '](#' + h.slug + ')');
    insertBlock('**Contents**\n\n' + lines.join('\n'));
  }

  const OUTLINE_KEY = 'docviewer-md-outline';
  let outlineOpen = false;
  try { outlineOpen = localStorage.getItem(OUTLINE_KEY) === '1'; } catch (e) { /* ignore */ }
  const area = document.getElementById('editor-area');
  const outline = document.createElement('aside');
  outline.id = 'md-outline';
  outline.className = 'hidden';
  outline.setAttribute('aria-label', 'Outline');
  area.appendChild(outline);
  let outlineTimer = null;

  function toggleOutline() {
    outlineOpen = !outlineOpen;
    try { localStorage.setItem(OUTLINE_KEY, outlineOpen ? '1' : '0'); } catch (e) { /* ignore */ }
    syncOutline(true);
  }
  function syncOutline(mdActive) {
    const show = mdActive && outlineOpen;
    outline.classList.toggle('hidden', !show);
    area.classList.toggle('has-outline', show);
    const btn = bar.querySelector('[data-md="outline"]');
    if (btn) btn.classList.toggle('is-on', show);
    if (show) renderOutline();
    if (editor) requestAnimationFrame(() => editor.layout());
  }
  function renderOutline() {
    if (!editor || !editor.getModel()) return;
    const heads = markdownHeadings(editor.getValue());
    const pos = editor.getPosition();
    let current = -1;
    heads.forEach((h, i) => { if (pos && h.line <= pos.lineNumber) current = i; });
    const min = heads.length ? Math.min(...heads.map((h) => h.level)) : 1;
    outline.innerHTML = '<div class="mo-head">Outline</div>' + (heads.length
      ? heads.map((h, i) => `<button type="button" class="mo-item mo-l${h.level - min + 1}${i === current && viewMode === 'code' ? ' on' : ''}" data-i="${i}" title="${escHtml(h.text)}">${escHtml(h.text)}</button>`).join('')
      : '<div class="mo-empty">No headings yet. Start a line with # for a title, ## for a section.</div>');
    outline.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-i'));
      const h = heads[i];
      if (viewMode === 'render') {
        const frame = document.getElementById('html-preview-frame');
        if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'docviewer-scroll', index: i }, '*');
      } else {
        editor.revealLineNearTop(h.line);
        editor.setPosition({ lineNumber: h.line, column: 1 });
        editor.focus();
      }
    }));
  }
  (function hookOutline() {
    if (!editor || !window.monaco) { setTimeout(hookOutline, 300); return; }
    const later = () => {
      if (outline.classList.contains('hidden')) return;
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(renderOutline, 250);
    };
    editor.onDidChangeModelContent(later);
    editor.onDidChangeModel(later);
    editor.onDidChangeCursorPosition(later);
  })();

  // ---------- toolbar ----------
  const ACTIONS = {
    h1: () => prefixLines(() => '# ', /^[ \t]*#[ \t]+/, HEADING),
    h2: () => prefixLines(() => '## ', /^[ \t]*##[ \t]+/, HEADING),
    h3: () => prefixLines(() => '### ', /^[ \t]*###[ \t]+/, HEADING),
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('_', '_', 'italic text'),
    strike: () => wrap('~~', '~~', 'struck text'),
    code: () => wrap('`', '`', 'code'),
    ul: () => prefixLines(() => '- ', /^[ \t]*[-*+][ \t]+(?!\[[ xX]\])/, ANY_LIST),
    ol: () => prefixLines((n) => (n + 1) + '. ', /^[ \t]*\d+[.)][ \t]+/, ANY_LIST),
    task: () => prefixLines(() => '- [ ] ', /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, ANY_LIST),
    quote: () => prefixLines(() => '> ', /^>[ \t]?/),
    hr: () => insertBlock('---'),
    codeblock: () => codeBlock(),
    table: () => openTableDialog(),
    toc: () => insertToc(),
    outline: () => toggleOutline(),
    mermaid: () => insertBlock('```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```'),
    link: () => openLinkDialog(),
    image: () => openImageDialog(),
    file: () => openFileDialog(),
    frame: () => openBoardDialog('frames'),
    slide: () => openBoardDialog('slides'),
  };

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-md]');
    if (!b || !editor || !model()) return;
    const menu = b.getAttribute('data-md');
    if (menu === 'headings') return toggleHeadingMenu(b);
    closeHeadingMenu();
    const fn = ACTIONS[menu];
    if (fn) fn();
  });

  let headingMenu = null;
  function toggleHeadingMenu(btn) {
    if (headingMenu) return closeHeadingMenu();
    headingMenu = document.createElement('div');
    headingMenu.className = 'md-menu';
    headingMenu.innerHTML = '<button type="button" data-h="h1"><b style="font-size:16px">Heading 1</b></button>'
      + '<button type="button" data-h="h2"><b style="font-size:14px">Heading 2</b></button>'
      + '<button type="button" data-h="h3"><b>Heading 3</b></button>';
    const r = btn.getBoundingClientRect();
    headingMenu.style.left = r.left + 'px';
    headingMenu.style.top = r.bottom + 4 + 'px';
    document.body.appendChild(headingMenu);
    headingMenu.addEventListener('click', (e) => {
      const h = e.target.closest('[data-h]');
      if (!h) return;
      closeHeadingMenu();
      ACTIONS[h.getAttribute('data-h')]();
    });
  }
  function closeHeadingMenu() {
    if (headingMenu) headingMenu.remove();
    headingMenu = null;
  }
  document.addEventListener('mousedown', (e) => {
    if (headingMenu && !headingMenu.contains(e.target) && !e.target.closest('[data-md="headings"]')) closeHeadingMenu();
  });

  // ---------- dialog ----------
  let onDialogClose = null;
  function openDialog(title, body, foot, wide) {
    dlgTitle.textContent = title;
    dlgBody.innerHTML = '';
    dlgFoot.innerHTML = '';
    dlgBody.appendChild(body);
    if (foot) dlgFoot.appendChild(foot);
    dlg.classList.toggle('is-wide', !!wide);
    dlg.classList.remove('hidden');
  }
  function closeDialog() {
    if (dlg.classList.contains('hidden')) return;
    dlg.classList.add('hidden');
    dlgBody.innerHTML = '';
    dlgFoot.innerHTML = '';
    if (onDialogClose) { const f = onDialogClose; onDialogClose = null; f(); }
  }
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) closeDialog();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); }
  });
  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }
  function footer(buttons) {
    const f = el('<div class="md-dialog-actions"><span class="md-spacer"></span></div>');
    buttons.forEach((b) => f.appendChild(b));
    return f;
  }
  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- table ----------
  function openTableDialog() {
    const MAXR = 8;
    const MAXC = 8;
    let rows = 3;
    let cols = 3;
    const body = el(`<div class="md-table-pick">
      <div class="md-grid">${Array.from({ length: MAXR * MAXC }, (_, i) => `<span data-r="${Math.floor(i / MAXC) + 1}" data-c="${(i % MAXC) + 1}"></span>`).join('')}</div>
      <div class="md-grid-size"></div>
      <label class="md-check"><input type="checkbox" data-header checked> First row is a header</label>
    </div>`);
    const size = body.querySelector('.md-grid-size');
    const paint = (r, c) => {
      body.querySelectorAll('.md-grid span').forEach((s) => {
        s.classList.toggle('on', Number(s.dataset.r) <= r && Number(s.dataset.c) <= c);
      });
      size.textContent = `${r} × ${c}  (rows × columns)`;
    };
    body.querySelector('.md-grid').addEventListener('mouseover', (e) => {
      const s = e.target.closest('[data-r]');
      if (s) paint(Number(s.dataset.r), Number(s.dataset.c));
    });
    body.querySelector('.md-grid').addEventListener('mouseleave', () => paint(rows, cols));
    body.querySelector('.md-grid').addEventListener('click', (e) => {
      const s = e.target.closest('[data-r]');
      if (!s) return;
      rows = Number(s.dataset.r);
      cols = Number(s.dataset.c);
      insert();
    });
    const insert = () => {
      const header = body.querySelector('[data-header]').checked;
      const head = Array.from({ length: cols }, (_, i) => header ? 'Column ' + (i + 1) : ' ');
      const lines = ['| ' + head.join(' | ') + ' |', '|' + Array(cols).fill(' --- ').join('|') + '|'];
      for (let r = 0; r < (header ? rows - 1 : rows); r++) lines.push('|' + Array(cols).fill('   ').join('|') + '|');
      closeDialog();
      insertBlock(lines.join('\n'));
    };
    paint(rows, cols);
    openDialog('Insert table', body, footer([button('Cancel', '', closeDialog), button('Insert 3 × 3', 'md-primary', () => { rows = 3; cols = 3; insert(); })]));
  }

  // ---------- external link ----------
  function openLinkDialog() {
    const sel = selectedText();
    const isUrl = /^https?:\/\/\S+$/i.test(sel.trim());
    const body = el(`<div class="md-form">
      <label>Text <input type="text" data-text placeholder="Link text"></label>
      <label>Web address <input type="url" data-url placeholder="https://example.com"></label>
    </div>`);
    const text = body.querySelector('[data-text]');
    const url = body.querySelector('[data-url]');
    text.value = isUrl ? '' : sel;
    url.value = isUrl ? sel.trim() : '';
    const go = button('Insert link', 'md-primary', () => {
      const u = url.value.trim();
      if (!/^(https?:\/\/|mailto:)\S+$/i.test(u)) { url.focus(); url.classList.add('bad'); return; }
      const t = text.value.trim() || u;
      closeDialog();
      insertInline(`[${mdText(t)}](${u.replace(/\s/g, '%20').replace(/\)/g, '%29')})`);
    });
    [text, url].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); }));
    openDialog('Insert web link', body, footer([button('Cancel', '', closeDialog), go]));
    (url.value ? text : url).focus();
  }

  // ---------- workspace files ----------
  async function workspaceFiles() {
    const tree = await (await fetch('/api/tree', { cache: 'no-store' })).json();
    const out = [];
    (function walk(nodes) {
      (nodes || []).forEach((n) => {
        if (n.type === 'dir') walk(n.children);
        else out.push(n);
      });
    })(tree.children);
    return out;
  }

  function openFileDialog() {
    const body = el(`<div class="md-pick">
      <input type="search" class="md-search" placeholder="Search files…">
      <div class="md-list"><div class="md-note">Loading…</div></div>
    </div>`);
    const list = body.querySelector('.md-list');
    const search = body.querySelector('.md-search');
    let files = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = files.filter((f) => f.path !== currentPath && (!q || f.path.toLowerCase().includes(q))).slice(0, 300);
      list.innerHTML = shown.length ? shown.map((f) => `
        <button type="button" class="md-item" data-path="${escHtml(f.path)}">
          <span class="md-kind">${escHtml(KIND_LABEL[f.kind] || (f.path.split('.').pop() || '').toUpperCase().slice(0, 5))}</span>
          <span class="md-item-path">${escHtml(f.path)}</span>
        </button>`).join('') : '<div class="md-note">No matching files.</div>';
    };
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-path]');
      if (!b) return;
      const p = b.getAttribute('data-path');
      const name = p.split('/').pop();
      closeDialog();
      if (IMAGE_EXT.test(p)) insertInline(`![${mdText(name.replace(/\.[^.]+$/, ''))}](${relLink(p)})`);
      else insertInline(`[${mdText(selectedText() || name)}](${relLink(p)})`);
    });
    search.addEventListener('input', draw);
    openDialog('Link to a workspace file', body, footer([button('Cancel', '', closeDialog)]));
    search.focus();
    workspaceFiles().then((f) => { files = f; draw(); }).catch(() => { list.innerHTML = '<div class="md-note">Could not load files.</div>'; });
  }

  // ---------- image ----------
  function assetsFolder() {
    const p = currentPath || '';
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const base = p.split('/').pop().replace(/\.(md|markdown)$/i, '');
    return (dir ? dir + '/' : '') + base + '-assets';
  }

  function openImageDialog() {
    const body = el(`<div class="md-pick">
      <div class="md-tabs">
        <button type="button" data-tab="upload" class="on">Upload</button>
        <button type="button" data-tab="workspace">From workspace</button>
        <button type="button" data-tab="url">Web address</button>
      </div>
      <div data-pane="upload">
        <label class="md-drop"><input type="file" accept="image/*" hidden><strong>Choose an image</strong><span>or drop it here · saved in ${escHtml(assetsFolder())}/</span></label>
        <div class="md-note" data-status></div>
      </div>
      <div data-pane="workspace" class="hidden">
        <input type="search" class="md-search" placeholder="Filter images…">
        <div class="md-img-grid"><div class="md-note">Loading…</div></div>
      </div>
      <div data-pane="url" class="hidden md-form">
        <label>Web address <input type="url" data-url placeholder="https://example.com/picture.png"></label>
        <div class="md-url-preview"></div>
      </div>
      <div class="md-form"><label>Alt text <input type="text" data-alt placeholder="Describe the image (optional)"></label></div>
    </div>`);
    const alt = body.querySelector('[data-alt]');
    const done = (target, isUrl) => {
      const a = alt.value.trim() || (isUrl ? 'image' : target.split('/').pop().replace(/\.[^.]+$/, ''));
      closeDialog();
      insertInline(`![${mdText(a)}](${isUrl ? target.replace(/\s/g, '%20') : relLink(target)})`);
    };
    let wsLoaded = false;
    const useUrl = button('Insert image', 'md-primary hidden', () => {
      const u = body.querySelector('[data-url]').value.trim();
      if (/^https?:\/\/\S+$/i.test(u)) done(u, true);
    });
    body.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
      const name = t.getAttribute('data-tab');
      body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
      body.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.getAttribute('data-pane') !== name));
      useUrl.classList.toggle('hidden', name !== 'url');
      if (name === 'workspace' && !wsLoaded) { wsLoaded = true; loadWs(); }
    }));
    // upload
    const input = body.querySelector('input[type="file"]');
    const status = body.querySelector('[data-status]');
    const drop = body.querySelector('.md-drop');
    const upload = async (file) => {
      if (!file || (!/^image\//.test(file.type || '') && !IMAGE_EXT.test(file.name || ''))) { status.textContent = 'Please choose an image file.'; return; }
      status.textContent = 'Uploading ' + file.name + '…';
      try {
        const content = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dest: assetsFolder(), files: [{ name: file.name || 'image.png', content, encoding: 'base64' }] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.imported || !data.imported.length) throw new Error(data.error || 'Upload failed');
        if (typeof loadTree === 'function') loadTree();
        done(data.imported[0].path, false);
      } catch (err) {
        status.textContent = (err && err.message) || 'Upload failed';
      }
    };
    input.addEventListener('change', () => upload(input.files && input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files && e.dataTransfer.files[0]); });
    // workspace
    const grid = body.querySelector('.md-img-grid');
    const filter = body.querySelector('[data-pane="workspace"] .md-search');
    let images = [];
    const drawGrid = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = images.filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 200);
      grid.innerHTML = shown.length ? shown.map((p) => `
        <button type="button" class="md-img-card" data-path="${escHtml(p)}" title="${escHtml(p)}">
          <img alt="" loading="lazy" src="/api/raw?path=${encodeURIComponent(p)}"><span>${escHtml(p.split('/').pop())}</span>
        </button>`).join('') : '<div class="md-note">No images in the workspace yet.</div>';
    };
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-path]');
      if (b) done(b.getAttribute('data-path'), false);
    });
    filter.addEventListener('input', drawGrid);
    const loadWs = () => workspaceFiles().then((f) => { images = f.map((x) => x.path).filter((p) => IMAGE_EXT.test(p)); drawGrid(); })
      .catch(() => { grid.innerHTML = '<div class="md-note">Could not load files.</div>'; });
    // url
    const urlIn = body.querySelector('[data-url]');
    urlIn.addEventListener('input', () => {
      const ok = /^https?:\/\/\S+$/i.test(urlIn.value.trim());
      body.querySelector('.md-url-preview').innerHTML = ok ? `<img alt="" src="${escHtml(urlIn.value.trim())}">` : '';
    });
    openDialog('Insert image', body, footer([button('Cancel', '', closeDialog), useUrl]));
  }

  // ---------- board frames / gantt views / slides ----------
  let renderer = null;
  async function boardRenderer() {
    await ensureSlidesAssets();
    if (!renderer) renderer = window.SlidesEngine.createRenderer(SLIDES_SOURCE_ASSETS);
    return renderer;
  }

  // mode 'frames' starts on frames/views, 'slides' on slides; chips switch.
  async function openBoardDialog(mode) {
    let kindFilter = mode === 'slides' ? 'slides' : 'boards';
    const body = el(`<div class="md-board">
      <div class="md-board-left">
        <input type="search" class="md-search" placeholder="Search frames, views and slides…">
        <div class="md-chips">
          <button type="button" data-k="boards">Frames &amp; views</button>
          <button type="button" data-k="mindmap">Mindmaps</button>
          <button type="button" data-k="flow">Flows</button>
          <button type="button" data-k="gantt">Gantt</button>
          <button type="button" data-k="slides">Slides</button>
        </div>
        <div class="md-list"><div class="md-note">Loading…</div></div>
      </div>
      <div class="md-board-right">
        <div class="md-preview"><span class="md-note">Select an item to preview it</span></div>
        <div class="md-form"><label>Text <input type="text" data-text placeholder="Link text / alt text"></label></div>
        <p class="md-note md-help">A <b>link</b> opens the board at that frame, view or slide. An <b>image</b> shows the frame live in the rendered markdown (it updates when the board changes).</p>
      </div>
    </div>`);
    const list = body.querySelector('.md-list');
    const search = body.querySelector('.md-search');
    const preview = body.querySelector('.md-preview');
    const text = body.querySelector('[data-text]');
    let items = [];
    let picked = null;
    let previewToken = 0;
    const linkBtn = button('Insert link', '', () => insertPicked(false));
    const imgBtn = button('Insert image', 'md-primary', () => insertPicked(true));
    linkBtn.disabled = true;
    imgBtn.disabled = true;
    const chips = body.querySelectorAll('[data-k]');
    const syncChips = () => chips.forEach((c) => c.classList.toggle('on', c.getAttribute('data-k') === kindFilter));
    chips.forEach((c) => c.addEventListener('click', () => { kindFilter = c.getAttribute('data-k'); syncChips(); draw(); }));
    syncChips();
    const label = (it) => `${it.title} — ${it.path.split('/').pop().replace(/\.html?$/i, '')}`;
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = items.filter((it) => {
        if (kindFilter === 'boards' ? it.kind === 'slides' : it.kind !== kindFilter) return false;
        return !q || (it.title + ' ' + it.path).toLowerCase().includes(q);
      }).slice(0, 400);
      list.innerHTML = shown.length ? shown.map((it) => `
        <button type="button" class="md-item${picked === it ? ' on' : ''}" data-i="${items.indexOf(it)}">
          <span class="md-kind md-kind-${it.kind}">${KIND_LABEL[it.kind]}</span>
          <span class="md-item-main"><span class="md-item-title">${escHtml(it.title)}</span><span class="md-item-path">${escHtml(it.path)}</span></span>
        </button>`).join('') : '<div class="md-note">Nothing found.</div>';
    };
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      picked = items[Number(b.getAttribute('data-i'))];
      list.querySelectorAll('.md-item').forEach((x) => x.classList.toggle('on', x === b));
      text.value = label(picked);
      linkBtn.disabled = false;
      imgBtn.disabled = !picked.embeddable;
      imgBtn.title = picked.embeddable ? '' : 'Slides can be linked, not embedded';
      const token = ++previewToken;
      if (!picked.embeddable) {
        preview.innerHTML = '<span class="md-note">Slides open in the deck at this slide.</span>';
        return;
      }
      preview.innerHTML = '<span class="md-note">Rendering…</span>';
      try {
        const r = await boardRenderer();
        const url = await r.renderImage(picked.path, decodeURIComponent(picked.ref.split('=')[1] || ''));
        if (token === previewToken) preview.innerHTML = `<img alt="" src="${url}">`;
      } catch (err) {
        if (token === previewToken) preview.innerHTML = `<span class="md-note">${escHtml((err && err.message) || 'Could not render')}</span>`;
      }
    });
    list.addEventListener('dblclick', (e) => { if (e.target.closest('[data-i]') && picked) insertPicked(!!picked.embeddable); });
    search.addEventListener('input', draw);
    const insertPicked = (asImage) => {
      if (!picked) return;
      const t = text.value.trim() || label(picked);
      const href = relLink(picked.path) + '#' + picked.ref;
      closeDialog();
      if (asImage) insertBlock(`![${mdText(t)}](${href})`);
      else insertInline(`[${mdText(t)}](${href})`);
    };
    openDialog(mode === 'slides' ? 'Link to a slide' : 'Insert a frame', body, footer([button('Cancel', '', closeDialog), linkBtn, imgBtn]), true);
    search.focus();
    try {
      const res = await fetch('/api/frames', { cache: 'no-store' });
      items = (await res.json()).items || [];
      if (renderer) renderer.clear();
      draw();
    } catch (e) {
      list.innerHTML = '<div class="md-note">Could not load boards.</div>';
    }
  }

  // ---------- keyboard shortcuts in the markdown source ----------
  (function addEditorActions() {
    if (!window.monaco || !editor) { setTimeout(addEditorActions, 300); return; }
    const K = monaco.KeyMod;
    const C = monaco.KeyCode;
    const add = (id, label, keys, fn) => editor.addAction({
      id: 'md-' + id, label: 'Markdown: ' + label, keybindings: keys,
      precondition: 'editorLangId == markdown', run: () => fn(),
    });
    add('bold', 'Bold', [K.CtrlCmd | C.KeyB], ACTIONS.bold);
    add('italic', 'Italic', [K.CtrlCmd | C.KeyI], ACTIONS.italic);
    add('link', 'Insert link', [K.CtrlCmd | C.KeyK], ACTIONS.link);
    add('frame', 'Insert frame', [K.CtrlCmd | K.Shift | C.KeyF], ACTIONS.frame);
  })();

  // ---------- paste clean-up in the markdown source ----------
  // Text from chat tools carries invisible characters, and a pasted text
  // diagram outside a code block would be reflowed into a paragraph. Clean
  // the text and fence diagrams as ```text so they keep their layout.
  function insideCodeFence(lineNumber) {
    const m = model();
    let fences = 0;
    for (let ln = 1; ln < lineNumber; ln++) {
      if (/^\s*(```|~~~)/.test(m.getLineContent(ln))) fences++;
    }
    return fences % 2 === 1;
  }

  // Monaco's onDidPaste fires for every paste (a DOM paste listener can be
  // pre-empted while the editor has focus); fix the pasted range in place.
  // ---------- rich paste: HTML (web pages, ChatGPT, docs) -> Markdown ----------
  let turndownP = null;
  function ensureTurndown() {
    if (!turndownP) {
      turndownP = ensureMarkdownLibs()
        .then(() => loadGlobalScript('/vendor/turndown.js', () => !!window.TurndownService, ['TurndownService']))
        .then(() => loadGlobalScript('/vendor/turndown-plugin-gfm.js', () => !!window.turndownPluginGfm, ['turndownPluginGfm']));
      turndownP.catch(() => { turndownP = null; });
    }
    return turndownP;
  }
  let turndown = null;
  function htmlToMarkdown(html) {
    if (!turndown) {
      turndown = new window.TurndownService({
        headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '_', strongDelimiter: '**', hr: '---',
      });
      turndown.use(window.turndownPluginGfm.gfm);
      // "- item" (turndown's default pads list markers to 4 characters).
      turndown.addRule('tightListItem', {
        filter: 'li',
        replacement: (content, node, options) => {
          const text = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
          const parent = node.parentNode;
          let prefix = options.bulletListMarker + ' ';
          if (parent && parent.nodeName === 'OL') {
            const start = Number(parent.getAttribute('start')) || 1;
            prefix = (start + Array.prototype.indexOf.call(parent.children, node)) + '. ';
          }
          const isTask = /^\[[ xX]\] /.test(text);
          return (isTask ? '- ' : prefix) + text + (node.nextSibling && !/\n$/.test(text) ? '\n' : '');
        },
      });
      // Copy buttons, icons and styles from the source page aren't content.
      turndown.remove(['script', 'style', 'button', 'noscript', 'svg', 'canvas', 'iframe']);
      // Code blocks: keep only the code (ChatGPT adds a header with the
      // language name and a "Copy code" button inside <pre>).
      turndown.addRule('fencedPre', {
        filter: (node) => node.nodeName === 'PRE',
        replacement: (content, node) => {
          const code = node.querySelector('code') || node;
          const lang = ((code.getAttribute('class') || '') + ' ' + (node.getAttribute('class') || '')).match(/(?:language|lang)-([\w+#.-]+)/);
          const text = code.textContent.replace(/\n+$/, '');
          const fence = text.includes('```') ? '~~~' : '```';
          return '\n\n' + fence + (lang ? lang[1] : '') + '\n' + text + '\n' + fence + '\n\n';
        },
      });
    }
    const clean = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return turndown.turndown(clean).replace(/\n{3,}/g, '\n\n').trim();
  }
  // Worth converting: the HTML has structure, and the plain text isn't
  // already markdown (e.g. ChatGPT's copy button gives markdown text).
  function isRichHtml(html, text) {
    if (!html || !/<(h[1-6]|table|ul|ol|pre|blockquote|strong|b|em|i|a\s|img|code)\b/i.test(html)) return false;
    if (/^\s{0,3}(#{1,6}\s|```|~~~|- \[[ x]\]|\|.*\|\s*$)|\*\*\S|\]\(\S+\)/m.test(text || '')) return false;
    return true;
  }
  function replaceRange(range, text) {
    const lines = text.split('\n');
    const endLine = range.startLineNumber + lines.length - 1;
    const endCol = (lines.length === 1 ? range.startColumn : 1) + lines[lines.length - 1].length;
    editor.executeEdits('md-paste', [{ range, text, forceMoveMarkers: true }], [new monaco.Selection(endLine, endCol, endLine, endCol)]);
    editor.pushUndoStop();
  }

  (function hookPaste() {
    if (!editor || !window.monaco) { setTimeout(hookPaste, 300); return; }
    editor.onDidPaste((e) => {
      const P = window.DocPaste;
      const m = model();
      if (!P || !m || !isMarkdownPath(currentPath) || !e || !e.range) return;
      const range = e.range;
      const raw = m.getValueInRange(range);
      if (!raw) return;
      // Rich HTML on the clipboard (read now: it's gone after the event).
      const cd = e.clipboardEvent && e.clipboardEvent.clipboardData;
      const html = cd ? cd.getData('text/html') : '';
      if (html && isRichHtml(html, raw) && !insideCodeFence(range.startLineNumber)) {
        const path = currentPath;
        ensureTurndown().then(() => {
          if (currentPath !== path || m !== model() || m.getValueInRange(range) !== raw) return; // changed meanwhile
          let md = P.normalize(htmlToMarkdown(html));
          if (!md || md === raw) return;
          // Block content (several lines) gets blank lines around it when it
          // lands next to other text, so it doesn't merge into that line.
          if (md.includes('\n')) {
            const lineBefore = m.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1);
            const lineAfter = m.getLineContent(range.endLineNumber).slice(range.endColumn - 1);
            if (lineBefore.trim()) md = '\n\n' + md;
            if (lineAfter.trim()) md += '\n\n';
          }
          replaceRange(range, md);
        }).catch(() => { /* keep the plain-text paste */ });
        return;
      }
      const fence = P.isDiagram(raw) && !insideCodeFence(range.startLineNumber);
      let text = fence ? '```text\n' + P.cleanDiagram(raw) + '\n```' : P.normalize(raw);
      if (!fence && text === raw) return;
      if (fence) {
        // Keep the fence on its own lines.
        const before = m.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1);
        const after = m.getLineContent(range.endLineNumber).slice(range.endColumn - 1);
        if (before.trim()) text = '\n\n' + text;
        text += after.trim() ? '\n\n' : '\n';
      }
      const lines = text.split('\n');
      const endLine = range.startLineNumber + lines.length - 1;
      const endCol = (lines.length === 1 ? range.startColumn : 1) + lines[lines.length - 1].length;
      editor.executeEdits('md-paste', [{ range, text, forceMoveMarkers: true }], [new monaco.Selection(endLine, endCol, endLine, endCol)]);
      editor.pushUndoStop();
    });
  })();

  window.syncMarkdownToolbar();
})();
