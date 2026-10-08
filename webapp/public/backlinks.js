// "Linked from" for the open file: markdown notes that link to it or embed
// it (including frames / gantt views / slides inside it), and slide decks
// that use it as a visual, image or background. Uses app.js globals.
(function () {
  const btn = document.getElementById('backlinks-btn');
  if (!btn) return;
  let forPath = null;
  let links = [];
  let loadedAt = 0;
  let pop = null;
  let reqSeq = 0;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function refLabel(ref) {
    if (!ref) return '';
    const [k, v] = ref.split('=');
    if (k === 'frame') return v === '__all__' ? 'whole board' : 'frame';
    if (k === 'view') return 'gantt ' + (v === 'chart' ? 'timeline' : v);
    if (k === 'slide') return 'slide ' + v;
    return '#' + ref;
  }

  function paint() {
    const n = links.length;
    btn.classList.toggle('hidden', !currentPath || !n);
    btn.textContent = '↩ Linked from ' + n;
    btn.title = n === 1 ? '1 note or deck links here' : n + ' links from notes and decks';
  }

  async function refresh(force) {
    const p = currentPath;
    if (!p) { forPath = null; links = []; paint(); closePop(); return; }
    // Re-check at most every 20s for the same file (it's a workspace scan).
    if (!force && p === forPath && Date.now() - loadedAt < 20000) { paint(); return; }
    const seq = ++reqSeq;
    try {
      const res = await fetch('/api/backlinks?path=' + encodeURIComponent(p), { cache: 'no-store' });
      const data = await res.json();
      if (seq !== reqSeq || currentPath !== p) return;
      forPath = p;
      links = res.ok ? (data.links || []) : [];
      loadedAt = Date.now();
    } catch (e) {
      if (seq !== reqSeq) return;
      links = [];
    }
    paint();
    if (pop) renderPop();
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
  }

  function renderPop() {
    if (!pop) return;
    // Group by source file.
    const groups = new Map();
    links.forEach((l) => {
      if (!groups.has(l.from)) groups.set(l.from, []);
      groups.get(l.from).push(l);
    });
    pop.innerHTML = `<div class="bl-head">Linked from <b>${groups.size}</b> file${groups.size === 1 ? '' : 's'}</div>`
      + [...groups].map(([from, list]) => `
        <div class="bl-group">
          <div class="bl-file"><span class="bl-kind">${list[0].kind === 'slides' ? 'Slides' : 'MD'}</span>${esc(from)}</div>
          ${list.map((l, i) => `<button type="button" class="bl-item" data-from="${esc(from)}" data-i="${i}">
            <span class="bl-text">${esc(l.text || (l.image ? 'image' : 'link'))}</span>
            <span class="bl-meta">${l.kind === 'slides' ? 'slide ' + l.slide + ' · ' + esc((l.uses || []).join(', ')) : (l.image ? 'embedded' : 'link') + (l.ref ? ' · ' + esc(refLabel(l.ref)) : '') + ' · line ' + l.line}</span>
          </button>`).join('')}
        </div>`).join('');
    pop.querySelectorAll('.bl-item').forEach((b) => b.addEventListener('click', () => {
      const from = b.getAttribute('data-from');
      const l = groups.get(from)[Number(b.getAttribute('data-i'))];
      closePop();
      if (l.kind === 'slides') openFileAt(from, 'slide=' + l.slide);
      else openMarkdownAtLine(from, l.line);
    }));
  }

  // Open a note in source view with the linking line selected.
  async function openMarkdownAtLine(p, line) {
    await openFile(p);
    if (currentPath !== p) return;
    if (viewMode === 'render') setViewMode('code');
    editor.revealLineInCenter(line);
    editor.setSelection(new monaco.Selection(line, 1, line, editor.getModel().getLineMaxColumn(line)));
    editor.focus();
  }

  btn.addEventListener('click', () => {
    if (pop) { closePop(); return; }
    pop = document.createElement('div');
    pop.className = 'bl-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Linked from');
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    document.body.appendChild(pop);
    renderPop();
    refresh(true);
  });
  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.contains(e.target) && e.target !== btn) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  window.addEventListener('focus', () => refresh());

  // Called by app.js when the view changes (file opened, saved, toggled).
  window.refreshBacklinks = (force) => { if (currentPath !== forPath) closePop(); refresh(force); };
})();
