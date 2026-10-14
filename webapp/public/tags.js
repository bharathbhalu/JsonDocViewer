// File tags: tag any file (right-click → Tags…, or the tag chips next to
// the open file's name), see tags in the file tree, and filter the tree by
// tags (a file must have every selected tag). Stored on the server
// (/api/tags -> webapp/tags.json). Uses app.js globals.
(function () {
  const bar = document.getElementById('tag-filter');
  const fileTags = document.getElementById('file-tags');
  if (!bar) return;
  let store = { files: {} };
  const selected = new Set(); // lower-case tag names
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function tagsOf(p) { return store.files[p] || []; }
  function allTags() {
    const counts = new Map();
    Object.values(store.files).forEach((list) => list.forEach((t) => {
      const k = t.toLowerCase();
      const e = counts.get(k) || { name: t, count: 0 };
      e.count += 1;
      counts.set(k, e);
    }));
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function matches(p) {
    if (!selected.size) return true;
    const have = new Set(tagsOf(p).map((t) => t.toLowerCase()));
    return [...selected].every((t) => have.has(t));
  }

  async function load() {
    try {
      const r = await fetch('/api/tags', { cache: 'no-store' });
      if (r.ok) store = await r.json();
    } catch (e) { /* keep */ }
    renderBar();
    decorate();
    renderFileTags();
  }
  async function save(p, tags) {
    const r = await fetch('/api/tags/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, tags }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not save tags');
    store = data;
    // Drop filters for tags that no longer exist.
    const live = new Set(allTags().map((t) => t.name.toLowerCase()));
    [...selected].forEach((t) => { if (!live.has(t)) selected.delete(t); });
    renderBar();
    decorate();
    renderFileTags();
  }

  // ---------- sidebar filter ----------
  function renderBar() {
    const tags = allTags();
    bar.classList.toggle('hidden', !tags.length);
    if (!tags.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = '<span class="tf-label">Tags</span>' + tags.map((t) => `
      <button type="button" class="tf-chip${selected.has(t.name.toLowerCase()) ? ' on' : ''}" data-tag="${esc(t.name.toLowerCase())}" title="${t.count} file${t.count === 1 ? '' : 's'}">#${esc(t.name)}<span>${t.count}</span></button>`).join('')
      + (selected.size ? '<button type="button" class="tf-clear" data-clear>Clear</button>' : '');
    bar.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => {
      const t = b.getAttribute('data-tag');
      if (selected.has(t)) selected.delete(t); else selected.add(t);
      renderBar();
      decorate();
    }));
    const clear = bar.querySelector('[data-clear]');
    if (clear) clear.addEventListener('click', () => { selected.clear(); renderBar(); decorate(); });
  }

  // ---------- tree: chips + filtering ----------
  function decorate() {
    const tree = document.getElementById('tree');
    if (!tree) return;
    tree.classList.toggle('is-tag-filtered', selected.size > 0);
    // Which folders contain a matching file (they stay visible and open).
    const keepDirs = new Set();
    if (selected.size) {
      const walk = (nodes) => (nodes || []).reduce((any, n) => {
        if (n.type === 'dir') {
          const inside = walk(n.children);
          if (inside) keepDirs.add(n.path);
          return any || inside;
        }
        return any || matches(n.path);
      }, false);
      walk(lastTreeChildren);
    }
    tree.querySelectorAll('.tree-row').forEach((row) => {
      const p = row.dataset.path;
      const isDir = row.classList.contains('is-folder');
      row.querySelectorAll('.tag-chips').forEach((n) => n.remove());
      if (!isDir) {
        const tags = tagsOf(p);
        if (tags.length) {
          const box = document.createElement('span');
          box.className = 'tag-chips';
          box.title = tags.map((t) => '#' + t).join(' ');
          box.textContent = tags.slice(0, 2).map((t) => '#' + t).join(' ') + (tags.length > 2 ? ' +' + (tags.length - 2) : '');
          const label = row.querySelector('.label');
          if (label) label.after(box);
        }
      }
      const visible = !selected.size || (isDir ? keepDirs.has(p) : matches(p));
      row.classList.toggle('tag-hidden', !visible);
      // The folder's children follow their folder row.
      const branch = isDir ? row.nextElementSibling : null;
      if (branch && branch.classList.contains('tree-branch')) {
        branch.classList.toggle('tag-hidden', !visible);
        const list = branch.querySelector(':scope > .tree-children');
        if (list && selected.size && keepDirs.has(p)) list.classList.remove('collapsed');
      }
    });
  }

  // ---------- tag editor ----------
  function openEditor(p) {
    const existing = tagsOf(p).slice();
    const all = allTags();
    const ov = document.createElement('div');
    ov.className = 'topo-overlay';
    ov.innerHTML = `
      <div class="md-dialog-box" role="dialog" aria-modal="true" aria-label="Tags">
        <div class="md-dialog-head"><span>Tags · ${esc(p.split('/').pop())}</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <div class="te-box"><span class="te-chips"></span><input type="text" class="te-input" placeholder="Add a tag and press Enter" list="te-suggest" aria-label="New tag"></div>
          <datalist id="te-suggest">${all.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
          ${all.length ? `<div class="te-known"><span class="md-note">Existing:</span>${all.map((t) => `<button type="button" data-add="${esc(t.name)}">#${esc(t.name)}</button>`).join('')}</div>` : ''}
        </div>
        <div class="md-dialog-actions"><span class="md-spacer"></span><button type="button" data-cancel>Cancel</button><button type="button" class="md-primary" data-save>Save</button></div>
      </div>`;
    document.body.appendChild(ov);
    const chips = ov.querySelector('.te-chips');
    const input = ov.querySelector('.te-input');
    const tags = existing;
    const draw = () => {
      chips.innerHTML = tags.map((t, i) => `<span class="te-chip">#${esc(t)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('');
      chips.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { tags.splice(Number(b.getAttribute('data-rm')), 1); draw(); input.focus(); }));
    };
    const add = (raw) => {
      String(raw || '').split(/[,\s]+/).map((t) => t.replace(/^#+/, '').trim()).filter(Boolean).forEach((t) => {
        if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      });
      draw();
    };
    const close = () => ov.remove();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); input.value = ''; }
      else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); }
      else if (e.key === 'Escape') close();
    });
    ov.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { add(b.getAttribute('data-add')); input.focus(); }));
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    ov.querySelector('[data-save]').addEventListener('click', async () => {
      if (input.value.trim()) add(input.value);
      try {
        await save(p, tags);
        close();
      } catch (err) {
        alert((err && err.message) || err);
      }
    });
    draw();
    input.focus();
  }

  // ---------- open file's tags in the toolbar ----------
  function renderFileTags() {
    if (!fileTags) return;
    const p = currentPath;
    if (!p) { fileTags.innerHTML = ''; return; }
    const tags = tagsOf(p);
    fileTags.innerHTML = tags.map((t) => `<span class="ft-chip">#${esc(t)}</span>`).join('')
      + `<button type="button" class="ft-edit" title="Edit tags">${tags.length ? '✎' : '+ tag'}</button>`;
    fileTags.querySelector('.ft-edit').addEventListener('click', () => openEditor(p));
    fileTags.querySelectorAll('.ft-chip').forEach((c) => c.addEventListener('click', () => {
      // Clicking a tag filters the tree by it.
      selected.clear();
      selected.add(c.textContent.slice(1).toLowerCase());
      renderBar();
      decorate();
    }));
  }

  window.openTagEditor = openEditor;
  window.decorateTreeTags = decorate;
  window.refreshFileTags = renderFileTags;
  load();
})();
