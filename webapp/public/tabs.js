// File tabs: every file you open gets a tab above the toolbar. Click to
// switch (unsaved changes are saved first when auto-save is on), × or
// middle-click to close, drag to reorder. Tabs are remembered per browser.
(function () {
  const main = document.getElementById('main');
  const toolbar = document.getElementById('toolbar');
  if (!main || !toolbar) return;
  const KEY = 'docviewer-tabs';
  const MAX = 24;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let tabs = [];
  try { tabs = (JSON.parse(localStorage.getItem(KEY) || '[]') || []).filter((p) => typeof p === 'string' && p).slice(0, MAX); } catch (e) { tabs = []; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(tabs)); } catch (e) { /* session only */ } };

  const bar = document.createElement('div');
  bar.id = 'file-tabs';
  bar.setAttribute('role', 'tablist');
  main.insertBefore(bar, toolbar);
  const strip = document.createElement('div');
  strip.className = 'ft-strip';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'ft-more';
  more.title = 'Search tabs · close all (⌥T)';
  more.setAttribute('aria-label', 'Tab list');
  more.textContent = '▾';
  bar.append(strip, more);

  const active = () => (typeof currentPath !== 'undefined' ? currentPath : null);
  const name = (p) => p.split('/').pop();
  const kind = (p) => {
    const m = /\.([a-z0-9]+)$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  };

  let dragFrom = -1;
  function render() {
    const cur = active();
    const dirty = typeof isDirty !== 'undefined' && isDirty;
    bar.hidden = !tabs.length;
    more.textContent = tabs.length > 1 ? tabs.length + ' ▾' : '▾';
    strip.innerHTML = tabs.map((p, i) => {
      const on = p === cur;
      // Same file name in two folders: show the folder too.
      const dup = tabs.some((q) => q !== p && name(q) === name(p));
      const label = dup ? p.split('/').slice(-2).join('/') : name(p);
      return `<div class="ft-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" draggable="true" data-i="${i}" title="${esc(p)}">`
        + `<span class="ft-kind">${esc(kind(p) || 'file')}</span><span class="ft-name">${esc(label)}</span>`
        + `${on && dirty ? '<span class="ft-dirty" title="Unsaved changes">●</span>' : ''}`
        + `<button type="button" class="ft-x" data-close="${i}" title="Close tab" aria-label="Close tab">×</button></div>`;
    }).join('');
    const el = strip.querySelector('.ft-tab.on');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function leaveCurrent() {
    // Auto-save on: keep the edits without asking. Off: openFile asks.
    if (typeof isDirty !== 'undefined' && isDirty && typeof autoSaveEnabled !== 'undefined' && autoSaveEnabled && typeof saveCurrentFile === 'function') {
      await saveCurrentFile();
    }
  }

  async function activate(i) {
    const p = tabs[i];
    if (!p || p === active()) return;
    await leaveCurrent();
    openFile(p);
  }

  async function close(i) {
    const p = tabs[i];
    if (!p) return;
    const wasActive = p === active();
    if (wasActive) {
      await leaveCurrent();
      if (typeof confirmLeaveIfDirty === 'function' && !(await confirmLeaveIfDirty())) return;
      if (typeof markClean === 'function') markClean();
    }
    tabs.splice(i, 1);
    save();
    if (wasActive) {
      const next = tabs[Math.min(i, tabs.length - 1)];
      if (next) openFile(next, undefined, { skipDirty: true });
      else if (typeof closeOpenFile === 'function') closeOpenFile();
    }
    render();
  }

  // ---- Tab list menu: search, switch, close others / all ----
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', outside, true);
  }
  function outside(e) { if (menu && !menu.contains(e.target) && e.target !== more) closeMenu(); }

  async function closeMany(keep) {
    const cur = active();
    const keepCur = keep && keep === cur;
    if (!keepCur && cur && tabs.includes(cur)) {
      await leaveCurrent();
      if (typeof confirmLeaveIfDirty === 'function' && !(await confirmLeaveIfDirty())) return;
      if (typeof markClean === 'function') markClean();
    }
    tabs = keep ? tabs.filter((p) => p === keep) : [];
    save();
    if (keep && keep !== cur) openFile(keep, undefined, { skipDirty: true });
    else if (!keep && typeof closeOpenFile === 'function') closeOpenFile();
    render();
  }

  function openMenu() {
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.className = 'ft-menu';
    menu.innerHTML = `<input type="search" class="ft-q" placeholder="Search open tabs…" spellcheck="false" autocomplete="off">
      <div class="ft-list" role="listbox"></div>
      <div class="ft-acts"><button type="button" data-act="others">Close other tabs</button><button type="button" data-act="all" class="danger">Close all tabs</button></div>`;
    document.body.appendChild(menu);
    const r = more.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    const q = menu.querySelector('.ft-q');
    const list = menu.querySelector('.ft-list');
    let sel = 0;
    const matches = () => {
      const t = q.value.trim().toLowerCase();
      return tabs.map((p, i) => ({ p, i })).filter(({ p }) => !t || t.split(/\s+/).every((w) => p.toLowerCase().includes(w)));
    };
    const draw = () => {
      const m = matches();
      sel = Math.min(sel, Math.max(0, m.length - 1));
      list.innerHTML = m.length ? m.map(({ p, i }, k) => `<div class="ft-row${p === active() ? ' on' : ''}${k === sel ? ' sel' : ''}" data-i="${i}" title="${esc(p)}">`
        + `<span class="ft-kind">${esc(kind(p) || 'file')}</span><span class="ft-rname">${esc(name(p))}</span><span class="ft-rdir">${esc(p.split('/').slice(0, -1).join('/'))}</span>`
        + `<button type="button" class="ft-x" data-rclose="${i}" title="Close tab">×</button></div>`).join('')
        : '<div class="ft-empty">No open tab matches</div>';
      const s2 = list.querySelector('.sel');
      if (s2) s2.scrollIntoView({ block: 'nearest' });
    };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', (e) => {
      const m = matches();
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(m.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); const hit = m[sel]; if (hit) { closeMenu(); activate(hit.i); } }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    });
    menu.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-rclose]');
      if (x) { e.stopPropagation(); await close(Number(x.dataset.rclose)); if (!tabs.length) closeMenu(); else draw(); return; }
      const row = e.target.closest('.ft-row');
      if (row) { closeMenu(); activate(Number(row.dataset.i)); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const what = act.dataset.act;
        closeMenu();
        if (what === 'all') closeMany(null);
        else closeMany(active() && tabs.includes(active()) ? active() : null);
      }
    });
    document.addEventListener('pointerdown', outside, true);
    draw();
    q.focus();
  }
  more.addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });

  bar.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); close(Number(x.dataset.close)); return; }
    const t = e.target.closest('.ft-tab');
    if (t) activate(Number(t.dataset.i));
  });
  bar.addEventListener('auxclick', (e) => {
    const t = e.target.closest('.ft-tab');
    if (t && e.button === 1) { e.preventDefault(); close(Number(t.dataset.i)); }
  });
  bar.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.ft-tab');
    if (!t) return;
    dragFrom = Number(t.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', tabs[dragFrom]); } catch (err) { /* ignore */ }
  });
  bar.addEventListener('dragover', (e) => { if (dragFrom >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
  bar.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const t = e.target.closest('.ft-tab');
    const to = t ? Number(t.dataset.i) : tabs.length - 1;
    const [p] = tabs.splice(dragFrom, 1);
    tabs.splice(to, 0, p);
    dragFrom = -1;
    save();
    render();
  });
  bar.addEventListener('dragend', () => { dragFrom = -1; });
  // Vertical wheel scrolls the strip sideways when it overflows.
  bar.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && strip.scrollWidth > strip.clientWidth) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  // Ctrl+Tab / Ctrl+Shift+Tab cycle; Alt+W closes the current tab.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.metaKey && e.key === 'Tab' && tabs.length > 1) {
      e.preventDefault();
      const i = Math.max(0, tabs.indexOf(active()));
      activate((i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length);
    } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyT' && tabs.length) {
      e.preventDefault();
      openMenu();
    } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyW' && active() && tabs.includes(active())) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      close(tabs.indexOf(active()));
    }
  }, true);

  window.FileTabs = {
    // Called by openFile/openPdf once a file is showing.
    opened(p) {
      if (!p) return;
      if (!tabs.includes(p)) {
        const i = tabs.indexOf(active());
        tabs.splice(i >= 0 ? i + 1 : tabs.length, 0, p);
        // Too many: drop the oldest tab that isn't this one.
        while (tabs.length > MAX) tabs.splice(tabs[0] === p ? 1 : 0, 1);
        save();
      }
      render();
    },
    // A tab whose file no longer opens (deleted / renamed) goes away.
    failed(p) {
      const i = tabs.indexOf(p);
      if (i >= 0) { tabs.splice(i, 1); save(); render(); }
    },
    // A file or folder moved/renamed: tabs follow it.
    renamed(from, to) {
      let changed = false;
      tabs = tabs.map((p) => {
        if (p === from) { changed = true; return to; }
        if (p.startsWith(from + '/')) { changed = true; return to + p.slice(from.length); }
        return p;
      });
      if (changed) { save(); render(); }
    },
    refresh: render,
  };
  render();
  // Cheap way to keep the unsaved dot in sync with the editor.
  let lastDirty = null;
  setInterval(() => {
    const d = typeof isDirty !== 'undefined' && isDirty;
    if (d !== lastDirty) { lastDirty = d; render(); }
  }, 600);
})();
