// Notes panel on the right of every file (markdown, boards, code, PDFs…):
// "This file" holds a note attached to the open file, "Scratchpad" one note
// shared everywhere. Saved to the server as you type; minimise it to a slim
// tab on the edge (⌥N toggles). Width and state are remembered.
(function () {
  const main = document.getElementById('main');
  if (!main || !main.parentElement) return;
  const KEY = 'docviewer-notes-panel';
  let ui = { open: false, tab: 'file', width: 320 };
  try { ui = Object.assign(ui, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* defaults */ }
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch (e) { /* session only */ } };

  const panel = document.createElement('aside');
  panel.id = 'notes-panel';
  panel.innerHTML = `
    <div class="np-grip" title="Drag to resize"></div>
    <div class="np-head">
      <div class="np-tabs"><button type="button" data-tab="file">This file</button><button type="button" data-tab="scratch">Scratchpad</button></div>
      <button type="button" class="np-min" title="Minimise (⌥N)" aria-label="Minimise notes">⟩</button>
    </div>
    <div class="np-sub"></div>
    <textarea class="np-text" spellcheck="true"></textarea>
    <div class="np-foot"><span class="np-state"></span></div>`;
  const rail = document.createElement('button');
  rail.type = 'button';
  rail.id = 'notes-rail';
  rail.title = 'Notes (⌥N)';
  rail.innerHTML = '<span>📝 Notes</span>';
  main.parentElement.insertBefore(panel, main.nextSibling);
  main.parentElement.insertBefore(rail, panel.nextSibling);

  const ta = panel.querySelector('.np-text');
  const sub = panel.querySelector('.np-sub');
  const state = panel.querySelector('.np-state');
  const filePath = () => (typeof currentPath !== 'undefined' && currentPath) || null;

  let loadedFor = undefined; // path (or 'scratch') whose text is in the box
  let dirty = false;
  let timer = 0;
  let saving = Promise.resolve();
  let hasNote = false;

  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  function save() {
    if (!dirty || loadedFor === undefined) return saving;
    const scope = loadedFor === 'scratch' ? 'scratch' : 'file';
    const body = { scope, path: scope === 'file' ? loadedFor : undefined, text: ta.value };
    dirty = false;
    state.textContent = 'Saving…';
    saving = fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        state.textContent = d && d.ok ? 'Saved ' + when(d.updatedAt) : 'Not saved: ' + ((d && d.error) || 'error');
        if (scope === 'file') { hasNote = !!ta.value.trim(); paintRail(); }
      })
      .catch(() => { state.textContent = 'Not saved (offline?)'; dirty = true; });
    return saving;
  }

  async function load() {
    const target = ui.tab === 'scratch' ? 'scratch' : filePath();
    if (target === loadedFor) return;
    await save();
    loadedFor = target;
    if (ui.tab === 'file' && !target) {
      ta.value = '';
      ta.disabled = true;
      ta.placeholder = 'Open a file to keep notes about it.';
      sub.textContent = 'No file open';
      state.textContent = '';
      hasNote = false;
      paintRail();
      return;
    }
    ta.disabled = false;
    ta.placeholder = ui.tab === 'scratch' ? 'Scratchpad — shared across every file.' : 'Notes about this file — ideas, to-dos, context…';
    sub.textContent = ui.tab === 'scratch' ? 'Shared across all files' : target;
    sub.title = sub.textContent;
    state.textContent = 'Loading…';
    try {
      const r = await fetch('/api/notes?path=' + encodeURIComponent(ui.tab === 'file' ? target : ''));
      const d = await r.json();
      if (loadedFor !== target) return;
      const entry = ui.tab === 'scratch' ? d.scratch : d.file;
      ta.value = (entry && entry.text) || '';
      state.textContent = entry && entry.updatedAt ? 'Saved ' + when(entry.updatedAt) : '';
      if (ui.tab === 'file') hasNote = !!ta.value.trim();
    } catch (e) {
      state.textContent = 'Could not load notes';
    }
    paintRail();
  }

  // The rail shows a dot when the open file has a note.
  async function checkFileNote() {
    const p = filePath();
    if (!p) { hasNote = false; paintRail(); return; }
    if (ui.open && ui.tab === 'file') return;
    try {
      const d = await (await fetch('/api/notes?path=' + encodeURIComponent(p))).json();
      if (filePath() === p) { hasNote = !!(d.file && d.file.text && d.file.text.trim()); paintRail(); }
    } catch (e) { /* ignore */ }
  }

  function paintRail() {
    rail.classList.toggle('has-note', hasNote);
    rail.title = hasNote ? 'Notes — this file has a note (⌥N)' : 'Notes (⌥N)';
  }

  function relayout() {
    // Let the code editor / boards fit the narrower space.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function apply() {
    panel.hidden = !ui.open;
    rail.hidden = ui.open;
    panel.style.width = Math.max(220, Math.min(720, ui.width)) + 'px';
    panel.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
    keep();
    relayout();
  }

  function setOpen(v) {
    ui.open = v;
    apply();
    if (v) { load().then(() => { if (!ta.disabled) ta.focus(); }); } else { save(); checkFileNote(); }
  }

  ta.addEventListener('input', () => {
    dirty = true;
    state.textContent = 'Editing…';
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
  ta.addEventListener('blur', () => { clearTimeout(timer); save(); });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger board / editor shortcuts
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  });
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { ui.tab = t.dataset.tab; apply(); load(); return; }
    if (e.target.closest('.np-min')) setOpen(false);
  });
  rail.addEventListener('click', () => setOpen(true));
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyN') { e.preventDefault(); setOpen(!ui.open); }
  }, true);

  // Resize by dragging the left edge.
  const grip = panel.querySelector('.np-grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = panel.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => { ui.width = Math.max(220, Math.min(720, w0 + (x0 - ev.clientX))); panel.style.width = ui.width + 'px'; };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); keep(); relayout(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // Follow the open file.
  let lastPath = filePath();
  setInterval(() => {
    const p = filePath();
    if (p === lastPath) return;
    lastPath = p;
    if (ui.open && ui.tab === 'file') load(); else checkFileNote();
  }, 400);
  window.addEventListener('beforeunload', () => {
    if (!dirty || loadedFor === undefined) return;
    const scope = loadedFor === 'scratch' ? 'scratch' : 'file';
    try {
      navigator.sendBeacon('/api/notes', new Blob([JSON.stringify({ scope, path: scope === 'file' ? loadedFor : undefined, text: ta.value })], { type: 'application/json' }));
    } catch (e) { /* best effort */ }
  });

  window.NotesPanel = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!ui.open) };
  apply();
  if (ui.open) load(); else checkFileNote();
})();
