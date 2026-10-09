// Command palette (Cmd/Ctrl+K): jump to any file, mindmap/flow frame, gantt
// view or slide, find ideas, and run commands — all from the keyboard.
//   type to search everything      > commands only      @ frames & slides
//   # files with a tag             todo <text>  adds a to-do for today
//   idea <text>  captures an idea
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl+';
  let ov = null;
  let frames = null; // cached /api/frames
  let framesAt = 0;
  let tags = null;

  const click = (id) => () => { const b = document.getElementById(id); if (b && !b.disabled) b.click(); };
  const has = (fn) => typeof fn === 'function';
  const fileOpen = () => typeof currentPath !== 'undefined' && !!currentPath;

  // ---------- commands ----------
  function commands() {
    const list = [
      { id: 'today', title: 'Go to Today', hint: MOD + '⇧H', icon: '🏠', run: () => showToday() },
      { id: 'idea', title: 'Capture an idea', hint: MOD + '⇧I', icon: '💡', run: () => openIdeaCapture() },
      { id: 'ideas', title: 'Open ideas inbox', icon: '📥', run: () => openIdeas() },
      { id: 'todo', title: 'Add a to-do for today…', icon: '☑', keep: true, run: () => setQuery('todo ') },
      { id: 'calendar', title: 'Open calendar', icon: '📅', run: () => calendarApi.open(calendarApi.todayKey()) },
      { id: 'habits', title: 'Habits & standup', icon: '🔥', run: () => openDaily() },
      { id: 'new', title: 'New file…', icon: '＋', run: () => openCreateDialog('') },
      { id: 'template', title: 'New from template…', icon: '🧩', run: () => openTemplateGallery('') },
      { id: 'import', title: 'Import files…', icon: '↑', run: () => pickImport('') },
      { id: 'search', title: 'Search inside files', icon: '🔎', run: () => { const s = document.getElementById('search-input'); if (s) { s.focus(); s.select(); } } },
      { id: 'theme', title: 'Toggle dark mode', icon: '◐', run: click('theme-btn') },
      { id: 'sidebar', title: 'Show / hide the Project panel', hint: 'Alt+1', icon: '⇤', run: click('sidebar-toggle') },
      { id: 'settings', title: 'Settings (data folder, window, network)', icon: '⚙', run: () => openDataFolder() },
      { id: 'refresh', title: 'Refresh file tree', icon: '↻', run: () => loadTree() },
      { id: 'termhere', title: 'Open terminal (workspace folder)', icon: '>_', run: () => openTerminalHere('') },
      { id: 'newterm', title: 'New terminal / Claude from template…', icon: '✳', run: () => openTemplateGallery('') },
      { id: 'cursorws', title: 'Open workspace in Cursor', icon: '⌁', run: () => openInCursor('') },
      { id: 'quit', title: 'Quit Accretion (stop the server)', hint: MOD + '⇧Q', icon: '⏻', run: () => quitApp() },
    ];
    if (fileOpen()) {
      list.push(
        { id: 'save', title: 'Save', hint: MOD + 'S', icon: '💾', run: click('save-btn') },
        { id: 'commit', title: 'Commit a version…', icon: '✓', run: click('commit-btn') },
        { id: 'history', title: 'Version history', icon: '🕘', run: click('history-btn') },
        { id: 'tags', title: 'Edit tags of this file', icon: '#', run: () => openTagEditor(currentPath) },
        { id: 'rename', title: 'Rename this file…', icon: '✎', run: () => renamePath(currentPath, false) },
        { id: 'export', title: 'Export this file', icon: '⤓', run: click('export-file-btn') },
        { id: 'fullscreen', title: 'Fullscreen', icon: '⛶', run: click('fullscreen-btn') },
        { id: 'saveastpl', title: 'Save this file as a template', icon: '🧩', run: () => saveAsTemplate(currentPath) },
        { id: 'askclaude', title: 'Ask Claude about this file…', icon: '✳', run: () => askClaudeAbout(currentPath) },
        { id: 'cursorfile', title: 'Open this file in Cursor', icon: '⌁', run: () => openInCursor(currentPath) },
        { id: 'copypath', title: 'Copy path of this file', icon: '⧉', run: () => navigator.clipboard.writeText(currentPath).then(() => setStatus('Path copied', 'ok')) },
      );
    }
    return list.filter((c) => {
      // Only offer what exists in this build.
      const deps = { idea: 'openIdeaCapture', ideas: 'openIdeas', calendar: 'calendarApi', habits: 'openDaily', template: 'openTemplateGallery', settings: 'openDataFolder', tags: 'openTagEditor', saveastpl: 'saveAsTemplate', today: 'showToday', termhere: 'openTerminalHere', newterm: 'openTemplateGallery', cursorws: 'openInCursor', askclaude: 'askClaudeAbout', cursorfile: 'openInCursor', quit: 'quitApp' };
      return !deps[c.id] || typeof window[deps[c.id]] !== 'undefined' || has(globalThis[deps[c.id]]);
    }).map((c) => Object.assign({ type: 'cmd' }, c));
  }

  // ---------- items ----------
  function allFiles() {
    const out = [];
    (function walk(nodes) {
      for (const n of nodes || []) {
        if (n.type === 'dir') walk(n.children);
        else out.push({ type: 'file', path: n.path, kind: n.kind || '', title: n.path.split('/').pop(), sub: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '' });
      }
    })(typeof lastTreeChildren !== 'undefined' ? lastTreeChildren : []);
    return out;
  }
  async function loadFrames() {
    if (frames && Date.now() - framesAt < 30000) return frames;
    try {
      const r = await fetch('/api/frames', { cache: 'no-store' });
      const d = await r.json();
      frames = (d.items || d.frames || d || []).filter((x) => x && x.path);
      framesAt = Date.now();
    } catch (e) { frames = frames || []; }
    return frames;
  }
  async function loadTags() {
    if (tags) return tags;
    try { const r = await fetch('/api/tags', { cache: 'no-store' }); tags = (await r.json()).files || {}; } catch (e) { tags = {}; }
    setTimeout(() => { tags = null; }, 30000);
    return tags;
  }

  // Fuzzy score: all query chars in order; bonuses for word starts and runs.
  function score(text, q) {
    if (!q) return 1;
    const t = text.toLowerCase();
    const idx = t.indexOf(q);
    if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1 + (idx === 0 || /[\s/_.-]/.test(t[idx - 1]) ? 200 : 0);
    let ti = 0, s = 0, run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === ' ') continue;
      let found = false;
      while (ti < t.length) {
        if (t[ti] === c) {
          found = true;
          run = ti > 0 && t[ti - 1] === q[qi - 1] ? run + 1 : 0;
          s += 10 + run * 5 + (ti === 0 || /[\s/_.-]/.test(t[ti - 1]) ? 15 : 0);
          ti++;
          break;
        }
        ti++;
      }
      if (!found) return 0;
    }
    return s - t.length * 0.2;
  }

  let items = [];
  let sel = 0;
  let seq = 0;
  async function search(raw) {
    const my = ++seq;
    let q = raw.trim();
    let mode = 'all';
    if (q.startsWith('>')) { mode = 'cmd'; q = q.slice(1).trim(); }
    else if (q.startsWith('@')) { mode = 'frames'; q = q.slice(1).trim(); }
    else if (q.startsWith('#')) { mode = 'tag'; q = q.slice(1).trim(); }
    const lq = q.toLowerCase();
    let out = [];

    // Quick actions from what's typed.
    const m = /^(todo|idea)\s+(.+)/i.exec(raw.trim());
    if (m && window.calendarApi && m[1].toLowerCase() === 'todo') out.push({ type: 'action', icon: '☑', title: 'Add to-do for today: “' + m[2] + '”', run: () => { calendarApi.add(calendarApi.todayKey(), m[2]); setStatus('To-do added for today', 'ok'); }, s: 1e6 });
    if (m && window.openIdeaCapture && m[1].toLowerCase() === 'idea') out.push({ type: 'action', icon: '💡', title: 'Capture idea: “' + m[2] + '”', run: () => openIdeaCapture(m[2]), s: 1e6 });

    if (mode === 'all' || mode === 'cmd') {
      out = out.concat(commands().map((c) => Object.assign(c, { s: score(c.title, lq) * (mode === 'cmd' ? 1 : 0.9) })).filter((c) => c.s > 0));
    }
    if (mode === 'all' || mode === 'tag') {
      let files = allFiles();
      if (mode === 'tag') {
        const t = await loadTags();
        if (my !== seq) return;
        files = files.filter((f) => (t[f.path] || []).some((x) => x.toLowerCase().startsWith(lq)));
        files.forEach((f) => { f.sub = (t[f.path] || []).map((x) => '#' + x).join(' ') + (f.sub ? ' · ' + f.sub : ''); f.s = 500; });
      } else {
        const recent = (typeof recentFiles === 'function' ? recentFiles() : []).map((r) => r.path);
        files.forEach((f) => {
          f.s = Math.max(score(f.title, lq) * 1.2, score(f.path, lq));
          const ri = recent.indexOf(f.path);
          if (f.s > 0 && ri >= 0) f.s += 300 - ri * 10; // recently opened first
          if (!lq && ri < 0) f.s = 0;
        });
        files = files.filter((f) => f.s > 0);
      }
      out = out.concat(files);
    }
    if (mode === 'all' || mode === 'frames') {
      if (lq || mode === 'frames') {
        const fr = await loadFrames();
        if (my !== seq) return;
        out = out.concat(fr.map((x) => ({ type: 'frame', path: x.path, ref: x.ref, kind: x.kind, title: x.title || x.ref, sub: x.path, s: Math.max(score(x.title || '', lq), score(x.path, lq) * 0.5) * (mode === 'frames' ? 1 : 0.7) })).filter((x) => x.s > 0 || (!lq && mode === 'frames')));
      }
    }
    if (mode === 'all' && lq && window.ideasApi) {
      out = out.concat(ideasApi.list().map((i) => ({ type: 'idea', id: i.id, title: i.text.split('\n')[0], sub: (i.status) + (i.tags.length ? ' · ' + i.tags.map((t) => '#' + t).join(' ') : ''), s: Math.max(score(i.text.split('\n')[0], lq), i.tags.some((t) => t.toLowerCase().includes(lq)) ? 300 : 0) * 0.8 })).filter((x) => x.s > 0));
    }
    out.sort((a, b) => b.s - a.s);
    items = out.slice(0, 60);
    sel = 0;
    draw(raw);
  }

  const KIND_LABEL = { terminal: 'Terminal', runbook: 'Runbook', mindmap: 'Mindmap', flow: 'Flow', kanban: 'Kanban', gantt: 'Gantt', slides: 'Slides', stocks: 'Stocks', markdown: 'Markdown', json: 'JSON', yaml: 'YAML', pdf: 'PDF' };
  function draw(raw) {
    const list = ov.querySelector('.pl-list');
    if (!items.length) {
      list.innerHTML = `<div class="pl-empty">${raw.trim() ? 'No matches.' : 'Start typing…'}<br><span>Tips: <b>&gt;</b> commands · <b>@</b> frames &amp; slides · <b>#</b> tags · <b>todo</b> buy milk · <b>idea</b> …</span></div>`;
      return;
    }
    let lastGroup = '';
    const group = (it) => (it.type === 'cmd' || it.type === 'action' ? 'Commands' : it.type === 'file' ? (raw.trim() ? 'Files' : 'Recent files') : it.type === 'frame' ? 'Frames, views & slides' : 'Ideas');
    list.innerHTML = items.map((it, i) => {
      const g = group(it);
      const head = g !== lastGroup ? `<div class="pl-group">${g}</div>` : '';
      lastGroup = g;
      const icon = it.type === 'file' || it.type === 'frame' ? `<span class="icon" data-icon="${esc(it.path)}" data-kind="${esc(it.kind)}"></span>` : `<span class="pl-ic">${it.type === 'idea' ? '💡' : esc(it.icon || '›')}</span>`;
      return head + `<div class="pl-item fi-host${i === sel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">${icon}<span class="pl-title">${esc(it.title)}</span>${it.sub ? `<span class="pl-sub">${esc(it.sub)}</span>` : ''}${it.type === 'frame' && KIND_LABEL[it.kind] ? `<span class="pl-kind">${KIND_LABEL[it.kind]}</span>` : ''}${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</div>`;
    }).join('');
    list.querySelectorAll('[data-icon]').forEach((el) => { if (typeof applyFileIcon === 'function') applyFileIcon(el, el.dataset.icon, el.dataset.kind || undefined); });
    const cur = list.querySelector('.pl-item.sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function setQuery(v) {
    const input = ov && ov.querySelector('.pl-input');
    if (!input) return;
    input.value = v;
    input.focus();
    search(v);
  }

  async function run(it) {
    if (!it) return;
    if (!it.keep) close();
    try {
      if (it.type === 'file') await openFile(it.path);
      else if (it.type === 'frame') await openFileAt(it.path, it.ref);
      else if (it.type === 'idea') openIdeas(it.id);
      else await it.run();
    } catch (err) { if (typeof setStatus === 'function') setStatus(String((err && err.message) || err), 'error'); }
  }

  function close() { if (ov) { ov.remove(); ov = null; } }

  function open(initial) {
    if (ov) { ov.querySelector('.pl-input').focus(); return; }
    ov = document.createElement('div');
    ov.className = 'pl-ov';
    ov.innerHTML = `<div class="pl-box" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="pl-top"><span class="pl-glass">⌕</span><input class="pl-input" type="text" placeholder="Search files, frames, ideas and commands…" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true"><kbd>esc</kbd></div>
      <div class="pl-list" role="listbox"></div>
      <div class="pl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><b>&gt;</b> commands</span><span><b>@</b> frames</span><span><b>#</b> tags</span><span><b>todo</b> / <b>idea</b> + text</span></div>
    </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('.pl-input');
    input.addEventListener('input', () => search(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(input.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(input.value); }
      else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('.pl-list').addEventListener('click', (e) => { const it = e.target.closest('.pl-item'); if (it) run(items[Number(it.dataset.i)]); });
    ov.querySelector('.pl-list').addEventListener('mousemove', (e) => {
      const it = e.target.closest('.pl-item');
      if (it && Number(it.dataset.i) !== sel) { sel = Number(it.dataset.i); ov.querySelectorAll('.pl-item').forEach((x) => x.classList.toggle('sel', x === it)); }
    });
    input.value = initial || '';
    input.focus();
    search(input.value);
    loadFrames(); // warm the cache
  }

  // ---------- shortcuts ----------
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Inside the code editor its own commands (below) handle these keys.
    if (e.target && e.target.closest && e.target.closest('.monaco-editor') && window.monaco) return;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); e.stopPropagation();
      if (ov) close(); else open();
    } else if (mod && e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); e.stopPropagation(); open('>');
    } else if (mod && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H') && typeof showToday === 'function') {
      e.preventDefault(); e.stopPropagation(); showToday();
    }
  }, true);
  // Monaco swallows keys; register there too.
  const hook = setInterval(() => {
    if (typeof editor === 'undefined' || !editor || !window.monaco) return;
    clearInterval(hook);
    try {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        // Selected text in markdown: Cmd+K makes it a link (as before).
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (model && model.getLanguageId() === 'markdown' && selection && !selection.isEmpty() && window.mdInsertLink) { window.mdInsertLink(); return; }
        open();
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => open('>'));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyH, () => showToday());
    } catch (e) { /* older monaco */ }
  }, 1000);

  window.openPalette = open;
})();
