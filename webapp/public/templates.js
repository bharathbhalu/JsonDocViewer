// Templates gallery: New → "From template…" shows built-in starters plus the
// user's own templates (files in data/templates/). Right-click a file →
// "Save as template" copies it there. Text templates fill {{title}}, {{date}},
// {{weekday}} and {{week}}. Uses app.js globals.
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KIND_LABEL = { markdown: 'Markdown', slides: 'Slides', kanban: 'Kanban', gantt: 'Gantt', mindmap: 'Mindmap', flow: 'Flow', mermaid: 'Mermaid', stocks: 'Stocks', json: 'JSON', yaml: 'YAML', file: 'File' };
  const KIND_ICON = { markdown: '📝', slides: '▶', kanban: '▦', gantt: '▤', mindmap: '✺', flow: '⇢', mermaid: '◇', stocks: '📈', json: '{ }', yaml: '≡', file: '📄' };

  async function openGallery(parentPath) {
    let data;
    try {
      const r = await fetch('/api/templates', { cache: 'no-store' });
      data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not load templates');
    } catch (err) {
      alert((err && err.message) || err);
      return;
    }
    const items = data.builtin.map((t) => ({ ...t, key: 'b:' + t.id }))
      .concat(data.user.map((t) => ({ ...t, key: 'u:' + t.path, user: true, description: t.path })));
    const kinds = [...new Set(items.map((t) => t.kind))];
    let filter = '';
    let chosen = null;

    const ov = document.createElement('div');
    ov.className = 'topo-overlay';
    ov.innerHTML = `
      <div class="md-dialog-box tpl-box" role="dialog" aria-modal="true" aria-label="New from template">
        <div class="md-dialog-head"><span>New from template${parentPath ? ' · in ' + esc(parentPath) : ''}</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <div class="tpl-filters"><button type="button" class="on" data-k="">All</button>${kinds.map((k) => `<button type="button" data-k="${esc(k)}">${esc(KIND_LABEL[k] || k)}</button>`).join('')}</div>
          <div class="tpl-grid"></div>
          <p class="md-note">Your own templates live in <code>${esc(data.folder)}/</code> — right-click any file → Save as template.</p>
          <label class="tpl-name">Name <input type="text" placeholder="Pick a template first" disabled></label>
        </div>
        <div class="md-dialog-actions"><span class="md-spacer"></span><button type="button" data-cancel>Cancel</button><button type="button" class="md-primary" data-ok disabled>Create</button></div>
      </div>`;
    document.body.appendChild(ov);
    const grid = ov.querySelector('.tpl-grid');
    const name = ov.querySelector('.tpl-name input');
    const ok = ov.querySelector('[data-ok]');
    const close = () => ov.remove();

    const draw = () => {
      const list = items.filter((t) => !filter || t.kind === filter);
      grid.innerHTML = list.map((t) => `
        <button type="button" class="tpl-card${chosen && chosen.key === t.key ? ' on' : ''}" data-key="${esc(t.key)}">
          <span class="tpl-icon">${KIND_ICON[t.kind] || '📄'}</span>
          <span class="tpl-title">${esc(t.name)}${t.user ? ' <em>yours</em>' : ''}</span>
          <span class="tpl-kind">${esc(KIND_LABEL[t.kind] || t.kind)}</span>
          <span class="tpl-desc">${esc(t.description || '')}</span>
        </button>`).join('') || '<p class="md-note">No templates of this type.</p>';
    };
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-key]');
      if (!card) return;
      chosen = items.find((t) => t.key === card.getAttribute('data-key'));
      name.disabled = false;
      ok.disabled = false;
      if (!name.value) name.value = chosen.name.toLowerCase().replace(/\s+/g, '-');
      name.placeholder = 'file name (extension added)';
      draw();
      name.focus();
      name.select();
    });
    grid.addEventListener('dblclick', (e) => { if (e.target.closest('[data-key]')) create(); });
    ov.querySelector('.tpl-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      filter = b.getAttribute('data-k');
      ov.querySelectorAll('.tpl-filters button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    });

    async function create() {
      if (!chosen) return;
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      const dest = parentPath ? `${parentPath}/${n}` : n;
      const body = chosen.user ? { from: chosen.path, path: dest } : { id: chosen.id, path: dest };
      ok.disabled = true;
      try {
        const r = await fetch('/api/templates/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res.error || 'Could not create file');
        close();
        if (parentPath && typeof expandedFolders !== 'undefined') expandedFolders.add(parentPath);
        await loadTree();
        setStatus('Created from template', 'ok');
        await openFile(res.path);
      } catch (err) {
        ok.disabled = false;
        alert((err && err.message) || err);
      }
    }

    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    ok.addEventListener('click', create);
    draw();
    const first = grid.querySelector('.tpl-card');
    if (first) first.focus();
  }

  async function saveAsTemplate(p) {
    try {
      const r = await fetch('/api/templates/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || 'Could not save template');
      await loadTree();
      setStatus('Saved as template: ' + res.path, 'ok');
    } catch (err) {
      alert((err && err.message) || err);
    }
  }

  window.openTemplateGallery = openGallery;
  window.saveAsTemplate = saveAsTemplate;
})();
