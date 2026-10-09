// Today: the home screen shown when no file is open (🏠 or Cmd+Shift+H).
// One glance at to-dos, habits + standup, ideas that are due, markets,
// recent files and bookmarks — each actionable in place. Reads the other
// modules through window.calendarApi / dailyApi / ideasApi and the server.
(function () {
  const host = document.getElementById('welcome');
  if (!host) return;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

  const root = document.createElement('div');
  root.className = 'today';
  host.appendChild(root);
  let market = null;
  let bookmarks = [];
  let timer = null;

  const visible = () => !host.classList.contains('hidden') && !host.classList.contains('pending');

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  function fileNode(p, nodes) {
    for (const n of nodes || []) {
      if (n.path === p && n.type !== 'dir') return n;
      if (n.type === 'dir' && p.startsWith(n.path + '/')) { const f = fileNode(p, n.children); if (f) return f; }
    }
    return null;
  }
  function fileLink(p, extra) {
    const node = fileNode(p, typeof lastTreeChildren !== 'undefined' ? lastTreeChildren : []);
    const name = p.split('/').pop();
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return `<button type="button" class="td-file fi-host" data-open="${esc(p)}" title="${esc(p)}"><span class="icon" data-icon="${esc(p)}" data-kind="${esc(node && node.kind || '')}"></span><span class="td-fname">${esc(name)}</span>${dir ? `<span class="td-fdir">${esc(dir)}</span>` : ''}${extra || ''}</button>`;
  }
  function spark(points, prev) {
    if (!points || points.length < 2) return '';
    const w = 64, h = 20;
    const ys = points.map((p) => p[1]).concat(prev != null ? [prev] : []);
    const lo = Math.min(...ys), hi = Math.max(...ys), sp = hi - lo || 1;
    const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
    const d = points.map((p, i) => (i ? 'L' : 'M') + (((p[0] - t0) / (t1 - t0 || 1)) * (w - 2) + 1).toFixed(1) + ' ' + (h - 1 - ((p[1] - lo) / sp) * (h - 2)).toFixed(1)).join(' ');
    const up = points[points.length - 1][1] >= (prev != null ? prev : points[0][1]);
    return `<svg class="td-spark ${up ? 'up' : 'down'}" width="${w}" height="${h}"><path d="${d}"/></svg>`;
  }
  const money = (n, cur) => (cur === 'INR' ? '₹' : cur === 'USD' ? '$' : '') + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

  // ---------- cards ----------
  function todosCard() {
    const cal = window.calendarApi;
    if (!cal) return '';
    const k = cal.todayKey();
    const items = cal.itemsOn(k);
    const late = cal.overdue();
    const open = items.filter((t) => !t.done);
    const done = items.filter((t) => t.done);
    const tomorrow = cal.itemsOn(keyOf(new Date(Date.now() + 864e5))).filter((t) => !t.done).length;
    const row = (t, day) => `<label class="td-todo${t.done ? ' done' : ''}"><input type="checkbox" data-todo="${esc(t.id)}" data-day="${day}"${t.done ? ' checked' : ''}><span>${esc(t.text)}</span>${t.time ? `<span class="td-time">⏰ ${esc(t.time)}</span>` : ''}${t.repeat ? '<span class="td-rep" title="Repeats">↻</span>' : ''}</label>`;
    return `<section class="td-card td-todos">
      <h3>☑ To-dos <span class="td-count">${open.length} open</span><button type="button" class="td-link" data-cal>Calendar →</button></h3>
      ${late.length ? `<div class="td-warn">${late.length} unfinished from earlier <button type="button" data-carry>Move to today</button></div>` : ''}
      <div class="td-list">${open.map((t) => row(t, k)).join('') || (cal.isLoaded() ? '<p class="td-empty">Nothing left for today 🎉</p>' : '<p class="td-empty">Loading…</p>')}
      ${done.length ? `<details class="td-done"><summary>${done.length} done</summary>${done.map((t) => row(t, k)).join('')}</details>` : ''}</div>
      <form class="td-add" data-add-todo><input type="text" placeholder="Add a to-do for today… (@14:30 for a reminder)" aria-label="New to-do"><button type="submit">Add</button></form>
      ${tomorrow ? `<p class="td-note">${tomorrow} open for tomorrow</p>` : ''}
    </section>`;
  }

  function habitsCard() {
    const d = window.dailyApi;
    if (!d) return '';
    const k = keyOf(new Date());
    const list = d.habits().filter((h) => !d.isDisabled(h));
    const doneN = list.filter((h) => d.isDone(k, h.id)).length;
    const su = d.standup(k);
    return `<section class="td-card td-habits">
      <h3>🔥 Habits <span class="td-count">${list.length ? doneN + ' / ' + list.length : ''}</span><button type="button" class="td-link" data-daily>Open →</button></h3>
      ${list.length ? `<div class="td-progress"><i style="width:${list.length ? (doneN / list.length) * 100 : 0}%"></i></div>` : ''}
      <div class="td-list">${list.map((h) => {
        const n = d.streak(h.id, k);
        return `<label class="td-todo${d.isDone(k, h.id) ? ' done' : ''}"><input type="checkbox" data-habit="${esc(h.id)}"${d.isDone(k, h.id) ? ' checked' : ''}><span>${esc(h.name)}</span><span class="td-time">${n ? '🔥 ' + n : ''}</span></label>`;
      }).join('') || '<p class="td-empty">No habits yet.</p>'}</div>
      <div class="td-standup ${su ? 'ok' : ''}"><span>${su ? '✓ Standup written' + (su.today ? ': ' + esc(su.today.split('\n')[0].slice(0, 80)) : '') : '✎ Today\'s standup not written yet'}</span><button type="button" data-daily>${su ? 'Edit' : 'Write'}</button></div>
    </section>`;
  }

  function ideasCard() {
    const api = window.ideasApi;
    if (!api) return '';
    const all = api.list();
    const now = Date.now();
    const due = all.filter((i) => i.remindAt && i.remindAt <= now + 3600e3 && i.status !== 'done').sort((a, b) => a.remindAt - b.remindAt).slice(0, 5);
    const inbox = all.filter((i) => i.status === 'inbox');
    const exploring = all.filter((i) => i.status === 'exploring');
    const latest = inbox.filter((i) => !due.includes(i)).slice(0, 3);
    const item = (i, isDue) => `<div class="td-idea${isDue ? ' due' : ''}"><div class="td-itext"><b>${esc(i.text.split('\n')[0])}</b>${i.tags.length ? `<span class="td-tags">${i.tags.map((t) => '#' + esc(t)).join(' ')}</span>` : ''}${isDue ? `<span class="td-time">⏰ ${esc(api.whenLabel(i.remindAt))}</span>` : ''}</div>
      <div class="td-iact">${isDue ? `<button type="button" data-isnooze="${esc(i.id)}" title="Remind tomorrow 9 am">Tomorrow</button>` : ''}<button type="button" data-iexplore="${esc(i.id)}" title="Open as a note">🔍</button><button type="button" data-ipark="${esc(i.id)}" title="Park">🅿</button></div></div>`;
    return `<section class="td-card td-ideas">
      <h3>💡 Ideas <span class="td-count">${inbox.length} in inbox · ${exploring.length} exploring</span><button type="button" class="td-link" data-ideas>Inbox →</button></h3>
      ${due.length ? `<p class="td-sub">Due for review</p>${due.map((i) => item(i, true)).join('')}` : ''}
      ${latest.length ? `<p class="td-sub">Latest</p>${latest.map((i) => item(i, false)).join('')}` : ''}
      ${!due.length && !latest.length ? `<p class="td-empty">${api.isLoaded() ? 'Inbox clear.' : 'Loading…'}</p>` : ''}
      <button type="button" class="td-capture" data-capture>💡 Capture an idea <kbd>⌘⇧I</kbd></button>
    </section>`;
  }

  function marketsCard() {
    if (!market) return `<section class="td-card td-markets"><h3>📈 Markets</h3><p class="td-empty">Loading…</p></section>`;
    if (!market.files.length) return `<section class="td-card td-markets"><h3>📈 Markets</h3><p class="td-empty">No watchlist yet.</p><button type="button" class="td-capture" data-new-stocks>＋ Create a stock watchlist</button></section>`;
    const movers = market.tickers.filter((t) => t.pct != null).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 6);
    const ev = market.events.slice(-4).reverse();
    return `<section class="td-card td-markets">
      <h3>📈 Markets <span class="td-count">${market.tickers.length} tickers</span>${market.files.length === 1 ? `<button type="button" class="td-link" data-open="${esc(market.files[0].path)}">Watchlist →</button>` : ''}</h3>
      ${ev.length ? `<p class="td-sub">Alerts today</p>${ev.map((e) => `<button type="button" class="td-alert ${e.type === 'above' || e.type === 'pctUp' ? 'up' : 'down'}" data-open="${esc(e.file)}"><span>${new Date(e.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>${esc(e.message)}</button>`).join('')}` : ''}
      <p class="td-sub">Biggest moves</p>
      ${movers.map((t) => `<button type="button" class="td-tick" data-open="${esc(t.file)}" title="${esc(t.name || '')}"><b>${esc(t.symbol)}</b><span class="td-mk">${esc(t.market)}</span>${spark(t.points, t.prevClose)}<span class="td-px">${money(t.price, t.currency)}</span><span class="td-pc ${t.pct >= 0 ? 'up' : 'down'}">${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%</span></button>`).join('') || '<p class="td-empty">No prices yet.</p>'}
      ${market.files.length > 1 ? `<p class="td-sub">Watchlists</p>${market.files.map((f) => fileLink(f.path, `<span class="td-fdir">${f.count}</span>`)).join('')}` : ''}
    </section>`;
  }

  let terms = null;
  let summary = null; // { files: [{path, kind, mtime, size}] }
  const expanded = new Set();
  let tagMap = {}; // path -> [tags]
  // Workspace filters (kept while the screen is open).
  const wf = { q: '', time: 'any', sort: 'recent', types: new Set(), tag: '', tileQ: {} , tileOpen: new Set() };

  // File types on the Today screen: label, how to make one, sample icon path.
  const TYPES = [
    { kind: 'markdown', label: 'Notes', sub: 'Markdown', ext: '.md', create: 'file', icon: 'a.md' },
    { kind: 'mindmap', label: 'Mindmaps', create: 'board', icon: 'a.html' },
    { kind: 'flow', label: 'Flows', create: 'board', icon: 'a.html' },
    { kind: 'kanban', label: 'Kanban boards', create: 'board', icon: 'a.html' },
    { kind: 'gantt', label: 'Gantt plans', create: 'board', icon: 'a.html' },
    { kind: 'slides', label: 'Slide decks', create: 'board', icon: 'a.html' },
    { kind: 'mermaid', label: 'Diagrams', sub: 'Mermaid', ext: '.mmd', create: 'file', icon: 'a.mmd' },
    { kind: 'stocks', label: 'Watchlists', sub: 'Stocks', create: 'board', icon: 'a.html' },
    { kind: 'terminal', label: 'Terminals', create: 'board', icon: 'a.html' },
    { kind: 'runbook', label: 'Runbooks', create: 'board', icon: 'a.html' },
    { kind: 'json', label: 'JSON', ext: '.json', create: 'file', icon: 'a.json' },
    { kind: 'yaml', label: 'YAML', ext: '.yaml', create: 'file', icon: 'a.yaml' },
    { kind: 'pdf', label: 'PDFs', create: 'import', icon: 'a.pdf' },
    { kind: 'image', label: 'Images', create: 'import', glyph: '🖼' },
    { kind: 'csv', label: 'Spreadsheets', sub: 'CSV', ext: '.csv', create: 'file', glyph: '▦' },
    { kind: 'text', label: 'Text & code', create: 'import', glyph: '≡' },
    { kind: 'html', label: 'Web pages', sub: 'HTML', create: 'import', glyph: '◫' },
    { kind: 'file', label: 'Other files', create: 'import', glyph: '📄' },
  ];
  const rel = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const typeIcon = (t) => (t.glyph ? `<span class="ws-glyph">${t.glyph}</span>` : `<span class="icon" data-icon="${esc(t.icon)}" data-kind="${esc(t.kind === 'markdown' || t.kind === 'json' || t.kind === 'yaml' || t.kind === 'mermaid' ? '' : t.kind)}"></span>`);

  function statsStrip() {
    if (!summary) return '';
    const f = summary.files;
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const today = f.filter((x) => x.mtime >= day.getTime()).length;
    const week = f.filter((x) => x.mtime >= Date.now() - 7 * 864e5).length;
    const kinds = new Set(f.map((x) => x.kind)).size;
    const size = f.reduce((a, x) => a + (x.size || 0), 0);
    const mb = size > 1e9 ? (size / 1e9).toFixed(1) + ' GB' : size > 1e6 ? (size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1e3)) + ' KB';
    const stat = (n, label) => `<div class="ws-stat"><b>${n}</b><span>${label}</span></div>`;
    return `<div class="ws-stats">${stat(f.length, 'files')}${stat(kinds, 'types')}${stat(today, 'edited today')}${stat(week, 'edited this week')}${stat(mb, 'in workspace')}</div>`;
  }

  // Fuzzy match: substring first, else all chars in order. Returns score (0 = no match).
  function fuzzy(text, q) {
    if (!q) return 1;
    const t = text.toLowerCase();
    const i = t.indexOf(q);
    if (i >= 0) return 1000 - i;
    let ti = 0;
    for (const c of q) { ti = t.indexOf(c, ti); if (ti < 0) return 0; ti++; }
    return 100 - (ti - q.length);
  }
  // Highlight query chars in a name (substring, else each matched char).
  function hl(name, q) {
    if (!q) return esc(name);
    const lower = name.toLowerCase();
    const i = lower.indexOf(q);
    if (i >= 0) return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
    let out = '';
    let qi = 0;
    for (const ch of name) {
      if (qi < q.length && ch.toLowerCase() === q[qi]) { out += '<mark>' + esc(ch) + '</mark>'; qi++; } else out += esc(ch);
    }
    return out;
  }

  function groups() {
    const by = new Map();
    summary.files.forEach((f) => { if (!by.has(f.kind)) by.set(f.kind, []); by.get(f.kind).push(f); });
    const known = new Set(TYPES.map((t) => t.kind));
    by.forEach((list, k) => { if (!known.has(k)) { if (!by.has('file')) by.set('file', []); by.get('file').push(...list); by.delete(k); } });
    return by;
  }

  const TIME_MS = { today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, week: () => Date.now() - 7 * 864e5, month: () => Date.now() - 30 * 864e5 };
  function filtered(list, kind) {
    const q = wf.q.trim().toLowerCase();
    const tq = (wf.tileQ[kind] || '').trim().toLowerCase();
    const since = TIME_MS[wf.time] ? TIME_MS[wf.time]() : 0;
    let out = list.filter((f) => {
      if (since && f.mtime < since) return false;
      const tags = tagMap[f.path] || [];
      if (wf.tag && !tags.some((t) => t.toLowerCase() === wf.tag)) return false;
      const hay = f.path + ' ' + tags.map((t) => '#' + t).join(' ');
      for (const qq of [q, tq]) {
        if (!qq) continue;
        f._s = Math.max(fuzzy(f.path.split('/').pop(), qq) * 2, fuzzy(hay, qq));
        if (!f._s) return false;
      }
      return true;
    });
    const by = { recent: (a, b) => b.mtime - a.mtime, name: (a, b) => a.path.split('/').pop().localeCompare(b.path.split('/').pop(), undefined, { numeric: true }), size: (a, b) => (b.size || 0) - (a.size || 0) };
    out.sort((q || tq) && wf.sort === 'recent' ? (a, b) => (b._s - a._s) || (b.mtime - a.mtime) : by[wf.sort]);
    return out;
  }
  const filtering = () => !!(wf.q.trim() || wf.time !== 'any' || wf.tag || wf.types.size);
  const sizeLabel = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : (n || 0) + ' B');

  function wsTiles() {
    const by = groups();
    const q = wf.q.trim().toLowerCase();
    const active = filtering();
    let shownTotal = 0;
    const tiles = TYPES.filter((t) => by.has(t.kind) && (!wf.types.size || wf.types.has(t.kind))).map((t) => {
      const all = by.get(t.kind);
      const list = filtered(all, t.kind);
      const tq = (wf.tileQ[t.kind] || '').trim().toLowerCase();
      if (!list.length && active && !wf.tileOpen.has(t.kind)) return '';
      shownTotal += list.length;
      const open = expanded.has(t.kind) || !!tq || active;
      const shown = open ? list : list.slice(0, 5);
      const newest = all.slice().sort((a, b) => b.mtime - a.mtime)[0];
      const counter = list.length !== all.length ? `${list.length}<span>/${all.length}</span>` : all.length;
      return `<div class="ws-tile ws-${t.kind}${open ? ' open' : ''}" data-kind="${t.kind}">
        <div class="ws-tile-head fi-host">${typeIcon(t)}<div class="ws-tile-title"><b>${esc(t.label)}</b>${t.sub ? `<span>${esc(t.sub)}</span>` : ''}</div>
          <span class="ws-count">${counter}</span>
          <button type="button" class="ws-new ws-find${wf.tileOpen.has(t.kind) ? ' on' : ''}" data-wsfind="${t.kind}" title="Filter ${esc(t.label.toLowerCase())}">⌕</button>
          ${t.create !== 'import' ? `<button type="button" class="ws-new" data-wsnew="${t.kind}" title="New ${esc(t.label.replace(/s$/, '').toLowerCase())}">＋</button>` : `<button type="button" class="ws-new" data-wsimport title="Import files">↑</button>`}
        </div>
        ${wf.tileOpen.has(t.kind) ? `<input type="search" class="ws-tile-q" data-tileq="${t.kind}" value="${esc(wf.tileQ[t.kind] || '')}" placeholder="Filter ${esc(t.label.toLowerCase())}…" aria-label="Filter ${esc(t.label)}">` : `<div class="ws-meta">Last edited ${rel(newest.mtime)}</div>`}
        <div class="ws-list${open && list.length > 6 ? ' scroll' : ''}">${shown.map((f) => {
          const name = f.path.split('/').pop();
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
          const tags = tagMap[f.path] || [];
          const right = wf.sort === 'size' ? sizeLabel(f.size) : rel(f.mtime);
          return `<button type="button" class="ws-file" data-open="${esc(f.path)}" title="${esc(f.path)}"><span class="ws-fname">${hl(name, q || tq)}</span><span class="ws-fdir">${esc(dir)}${tags.length ? `<i>${tags.slice(0, 3).map((x) => '#' + esc(x)).join(' ')}</i>` : ''}</span><span class="ws-ftime">${right}</span></button>`;
        }).join('') || '<p class="ws-none">No matches.</p>'}</div>
        ${!active && !tq && list.length > 5 ? `<button type="button" class="ws-more" data-wsmore="${t.kind}">${expanded.has(t.kind) ? 'Show less' : 'Show all ' + list.length}</button>` : ''}
      </div>`;
    }).join('');
    return { tiles, shownTotal };
  }

  function workspaceSection() {
    if (!summary) return `<section class="ws"><h2 class="ws-h">Workspace</h2><p class="td-empty">Loading files…</p></section>`;
    const by = groups();
    const present = TYPES.filter((t) => by.has(t.kind));
    const empty = TYPES.filter((t) => !by.has(t.kind) && t.create !== 'import');
    const allTags = [...new Set(Object.entries(tagMap).filter(([p]) => summary.files.some((f) => f.path === p)).flatMap(([, ts]) => ts.map((t) => t.toLowerCase())))].sort();
    const seg = (name, val, label) => `<button type="button" class="${wf[name] === val ? 'on' : ''}" data-wf="${name}" data-v="${val}">${label}</button>`;
    return `<section class="ws">
      <div class="ws-top"><h2 class="ws-h">Workspace</h2>${statsStrip()}</div>
      <div class="ws-filter">
        <div class="ws-search"><span>⌕</span><input type="search" class="ws-q" value="${esc(wf.q)}" placeholder="Filter all files — name, folder or #tag   ( / )" aria-label="Filter workspace files"><span class="ws-found"></span></div>
        <div class="ws-seg" title="Edited">${seg('time', 'any', 'Any time')}${seg('time', 'today', 'Today')}${seg('time', 'week', '7 days')}${seg('time', 'month', '30 days')}</div>
        <div class="ws-seg" title="Sort">${seg('sort', 'recent', 'Recent')}${seg('sort', 'name', 'A–Z')}${seg('sort', 'size', 'Size')}</div>
        <button type="button" class="ws-clear${filtering() ? '' : ' hidden'}" data-wsclear>Clear filters</button>
      </div>
      <div class="ws-chips">${present.map((t) => `<button type="button" class="ws-tchip fi-host ws-${t.kind}${wf.types.has(t.kind) ? ' on' : ''}" data-wstype="${t.kind}">${typeIcon(t)}${esc(t.label)}<span>${by.get(t.kind).length}</span></button>`).join('')}
        ${allTags.length ? `<span class="ws-sep"></span>${allTags.map((t) => `<button type="button" class="ws-tag${wf.tag === t ? ' on' : ''}" data-wstag="${esc(t)}">#${esc(t)}</button>`).join('')}` : ''}</div>
      <div class="ws-grid"></div>
      ${empty.length ? `<div class="ws-start"><span>Start something new:</span>${empty.map((t) => `<button type="button" class="ws-chip fi-host" data-wsnew="${t.kind}">${typeIcon(t)} ${esc(t.label.replace(/s$/, ''))}</button>`).join('')}<button type="button" class="ws-chip" data-palette-tpl>🧩 From template…</button></div>` : ''}
    </section>`;
  }

  // Redraw only the tiles (typing in a filter keeps focus).
  function drawTiles() {
    const grid = root.querySelector('.ws-grid');
    if (!grid || !summary) return;
    const focus = document.activeElement && grid.contains(document.activeElement) && document.activeElement.dataset.tileq
      ? { k: document.activeElement.dataset.tileq, pos: document.activeElement.selectionStart } : null;
    const { tiles, shownTotal } = wsTiles();
    grid.innerHTML = tiles || '<p class="td-empty ws-nomatch">No files match these filters.</p>';
    grid.querySelectorAll('[data-icon]').forEach((el) => { if (typeof applyFileIcon === 'function') applyFileIcon(el, el.dataset.icon, el.dataset.kind || undefined); });
    const found = root.querySelector('.ws-found');
    if (found) found.textContent = filtering() ? shownTotal + ' match' + (shownTotal === 1 ? '' : 'es') : '';
    const clear = root.querySelector('[data-wsclear]');
    if (clear) clear.classList.toggle('hidden', !filtering());
    if (focus) { const el = grid.querySelector(`[data-tileq="${focus.k}"]`); if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch (e) { /* search input */ } } }
  }

  function bindWorkspace() {
    const ws = root.querySelector('.ws');
    if (!ws || !summary) return;
    drawTiles();
    const q = ws.querySelector('.ws-q');
    q.addEventListener('input', () => { wf.q = q.value; drawTiles(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { q.value = ''; wf.q = ''; drawTiles(); }
      if (e.key === 'Enter') { const first = ws.querySelector('.ws-grid .ws-file'); if (first) openFile(first.dataset.open); }
    });
    ws.querySelectorAll('[data-wf]').forEach((b) => b.addEventListener('click', () => {
      wf[b.dataset.wf] = b.dataset.v;
      ws.querySelectorAll(`[data-wf="${b.dataset.wf}"]`).forEach((x) => x.classList.toggle('on', x === b));
      drawTiles();
    }));
    ws.querySelectorAll('[data-wstype]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.wstype;
      if (wf.types.has(k)) wf.types.delete(k); else wf.types.add(k);
      b.classList.toggle('on', wf.types.has(k));
      drawTiles();
    }));
    ws.querySelectorAll('[data-wstag]').forEach((b) => b.addEventListener('click', () => {
      wf.tag = wf.tag === b.dataset.wstag ? '' : b.dataset.wstag;
      ws.querySelectorAll('[data-wstag]').forEach((x) => x.classList.toggle('on', x.dataset.wstag === wf.tag));
      drawTiles();
    }));
    ws.querySelector('[data-wsclear]').addEventListener('click', () => {
      Object.assign(wf, { q: '', time: 'any', sort: wf.sort, tag: '', tileQ: {} });
      wf.types.clear();
      wf.tileOpen.clear();
      render();
    });
    // Tile-level actions (delegated: tiles are redrawn while filtering).
    const grid = ws.querySelector('.ws-grid');
    grid.addEventListener('click', (e) => {
      const el = e.target.closest('[data-open],[data-wsfind],[data-wsnew],[data-wsimport],[data-wsmore]');
      if (!el) return;
      if (el.dataset.open) openFile(el.dataset.open);
      else if (el.dataset.wsfind) {
        const k = el.dataset.wsfind;
        if (wf.tileOpen.has(k)) { wf.tileOpen.delete(k); delete wf.tileQ[k]; } else wf.tileOpen.add(k);
        drawTiles();
        const inp = grid.querySelector(`[data-tileq="${k}"]`);
        if (inp) inp.focus();
      } else if (el.dataset.wsnew) createOfKind(el.dataset.wsnew);
      else if (el.hasAttribute('data-wsimport')) pickImport('');
      else if (el.dataset.wsmore) { const k = el.dataset.wsmore; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); drawTiles(); }
    });
    grid.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.tileq;
      if (!k) return;
      wf.tileQ[k] = e.target.value;
      drawTiles();
    });
    grid.addEventListener('keydown', (e) => {
      const k = e.target.dataset && e.target.dataset.tileq;
      if (!k) return;
      if (e.key === 'Escape') { wf.tileOpen.delete(k); delete wf.tileQ[k]; drawTiles(); }
      if (e.key === 'Enter') { const tile = e.target.closest('.ws-tile'); const first = tile && tile.querySelector('.ws-file'); if (first) openFile(first.dataset.open); }
    });
  }

  async function createOfKind(kind) {
    const t = TYPES.find((x) => x.kind === kind);
    if (!t) return;
    const name = await uiPrompt('Name for the new ' + t.label.replace(/s$/, '').toLowerCase(), '', { title: 'New ' + t.label.replace(/s$/, '').toLowerCase(), okLabel: 'Create', placeholder: 'e.g. ' + (kind === 'markdown' ? 'meeting-notes' : kind === 'terminal' ? 'dev-box' : 'my-' + kind) });
    if (!name || !name.trim()) return;
    const n = name.trim();
    try {
      if (t.create === 'board') await createBoardFile('', n, kind);
      else await createFile('', /\.[a-z0-9]+$/i.test(n) ? n : n + t.ext);
    } catch (err) { uiAlert(String((err && err.message) || err)); }
  }
  function sessionsCard() {
    if (!terms) return '';
    if (terms.error) return '';
    const icon = { ready: '🟢', rebuilt: '♻', failed: '🔴', checking: '🟡', unknown: '⚪' };
    const label = { ready: 'running', rebuilt: 'rebuilt', failed: 'failed', checking: 'checking…', unknown: 'not checked' };
    return `<section class="td-card td-terms">
      <h3>>_ Terminals <span class="td-count">${terms.length}</span><button type="button" class="td-link" data-newterm>＋ New</button></h3>
      ${terms.map((t) => `<div class="td-term"><button type="button" class="td-file fi-host" data-open="${esc(t.path)}" title="${esc(t.path)}"><span class="icon" data-icon="${esc(t.path)}" data-kind="terminal"></span><span class="td-fname">${esc(t.title)}</span><span class="td-fdir">${t.claude ? 'Claude · ' : ''}${t.mode === 'ssh' ? esc(t.host || 'SSH') : 'local'} · ${esc(t.session)}</span></button>
        <span class="td-tstate ${t.state}" title="${esc(t.error || '')}">${icon[t.state] || '⚪'} ${label[t.state] || t.state}${t.autoConnect ? ' · auto' : ''}${t.live ? ' · open' : ''}</span>
        ${t.state === 'failed' ? `<button type="button" class="td-retry" data-ensure="${esc(t.path)}">Retry</button>` : ''}</div>`).join('') || '<p class="td-empty">No terminal files yet. Create one for a local shell, an SSH host or Claude.</p>'}
    </section>`;
  }

  function filesCard() {
    const tree = typeof lastTreeChildren !== 'undefined' ? lastTreeChildren : [];
    const rec = (typeof recentFiles === 'function' ? recentFiles() : []).filter((r) => fileNode(r.path, tree)).slice(0, 8);
    const bm = bookmarks.filter((b) => fileNode(b.path, tree)).slice(0, 8);
    const edited = summary ? summary.files.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 6) : [];
    return `<section class="td-card td-files">
      ${edited.length ? `<h3>✎ Recently edited</h3><div class="td-flist">${edited.map((f) => fileLink(f.path, `<span class="td-fdir">${rel(f.mtime)}</span>`)).join('')}</div><h3 class="td-h2">🕘 Recently opened</h3>` : '<h3>🕘 Recently opened</h3>'}
      <div class="td-flist">${rec.map((r) => fileLink(r.path)).join('') || '<p class="td-empty">Files you open show up here.</p>'}</div>
      ${bm.length ? `<h3 class="td-h2">★ Bookmarks</h3><div class="td-flist">${bm.map((b) => fileLink(b.path)).join('')}</div>` : ''}
    </section>`;
  }

  // ---------- render ----------
  function render() {
    if (!visible()) return;
    const now = new Date();
    const wsFocus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('ws-q') ? { pos: document.activeElement.selectionStart } : null;
    const focus = document.activeElement && root.contains(document.activeElement) && document.activeElement.matches('input[type="text"]') ? { sel: document.activeElement.closest('[data-add-todo]') ? '[data-add-todo] input' : null, value: document.activeElement.value } : null;
    root.innerHTML = `
      <header class="td-head">
        <img src="icon.svg" alt="" width="44" height="44">
        <div><div class="td-hello">${greeting()}</div><div class="td-date">${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
        <span class="td-spacer"></span>
        <button type="button" data-capture>💡 Idea</button>
        <button type="button" data-new>＋ New</button>
        <button type="button" data-import>↑ Import</button>
        <button type="button" class="td-k" data-palette title="Search files and commands">⌘K <span>Search & commands</span></button>
      </header>
      <div class="td-grid">${todosCard()}${habitsCard()}${ideasCard()}${marketsCard()}${sessionsCard()}${filesCard()}</div>
      ${workspaceSection()}`;
    root.querySelectorAll('[data-icon]').forEach((el) => { if (typeof applyFileIcon === 'function') applyFileIcon(el, el.dataset.icon, el.dataset.kind || undefined); });
    bind();
    bindWorkspace();
    if (wsFocus) { const el = root.querySelector('.ws-q'); if (el) { el.focus(); try { el.setSelectionRange(wsFocus.pos, wsFocus.pos); } catch (e) { /* ignore */ } } }
    if (focus && focus.sel) { const el = root.querySelector(focus.sel); if (el) { el.value = focus.value; el.focus(); } }
  }

  function bind() {
    const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener('click', (e) => fn(el, e)));
    on('[data-open]', (el) => openFile(el.dataset.open));
    on('[data-capture]', () => window.openIdeaCapture && openIdeaCapture());
    on('[data-new]', () => openCreateDialog(''));
    on('[data-import]', () => pickImport(''));
    on('[data-palette]', () => window.openPalette && openPalette());
    on('[data-cal]', () => window.calendarApi && calendarApi.open(calendarApi.todayKey()));
    on('[data-carry]', () => calendarApi.carryOver());
    on('[data-daily]', () => window.openDaily && openDaily(keyOf(new Date())));
    on('[data-ideas]', () => window.openIdeas && openIdeas());
    on('[data-new-stocks]', () => createOfKind('stocks'));
    root.querySelectorAll('.ws-start [data-wsnew]').forEach((el) => el.addEventListener('click', () => createOfKind(el.dataset.wsnew)));
    on('[data-palette-tpl]', () => window.openTemplateGallery && openTemplateGallery(''));
    on('[data-newterm]', () => window.openTemplateGallery ? openTemplateGallery('') : openCreateDialog(''));
    on('[data-ensure]', async (el) => { el.disabled = true; el.textContent = '…'; try { await fetch('/api/term/ensure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: el.dataset.ensure }) }); } catch (e) { /* shown on refresh */ } loadRemote(); });
    on('[data-isnooze]', (el) => ideasApi.snooze(el.dataset.isnooze, ideasApi.tomorrow()));
    on('[data-iexplore]', (el) => ideasApi.openNote(el.dataset.iexplore));
    on('[data-ipark]', (el) => ideasApi.setStatus(el.dataset.ipark, 'parked'));
    root.querySelectorAll('[data-todo]').forEach((cb) => cb.addEventListener('change', () => calendarApi.toggle(cb.dataset.day, cb.dataset.todo, cb.checked)));
    root.querySelectorAll('[data-habit]').forEach((cb) => cb.addEventListener('change', () => { dailyApi.toggle(keyOf(new Date()), cb.dataset.habit); render(); }));
    const add = root.querySelector('[data-add-todo]');
    if (add) add.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = add.querySelector('input');
      if (!input.value.trim()) return;
      calendarApi.add(calendarApi.todayKey(), input.value);
      input.value = '';
      setTimeout(() => { const i = root.querySelector('[data-add-todo] input'); if (i) i.focus(); }, 0);
    });
  }

  async function loadRemote() {
    try {
      const [m, b, tm, fs, tg] = await Promise.all([
        fetch('/api/stocks/overview', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/favorites', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/term/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/files/summary', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/tags', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (fs) summary = fs;
      if (tg) tagMap = tg.files || {};
      terms = tm ? tm.files : terms;
      if (m) market = m;
      if (b) bookmarks = b.items || [];
    } catch (e) { /* offline */ }
    render();
  }

  let pendingRender = null;
  const soon = () => { clearTimeout(pendingRender); pendingRender = setTimeout(render, 80); };
  ['accretion:todos-changed', 'accretion:daily-changed', 'accretion:ideas-changed'].forEach((ev) => document.addEventListener(ev, soon));
  // Render whenever the screen becomes visible.
  new MutationObserver(() => { if (visible()) { render(); loadRemote(); } }).observe(host, { attributes: true, attributeFilter: ['class'] });
  timer = setInterval(() => { if (visible() && !document.hidden) loadRemote(); }, 60000);
  if (window.dailyApi) dailyApi.ready().then(soon);

  // "/" focuses the workspace filter while Today is showing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || !visible()) return;
    const t = e.target;
    if (t && (t.matches('input, textarea, select, [contenteditable="true"]') || t.closest('.monaco-editor'))) return;
    const q = root.querySelector('.ws-q');
    if (!q) return;
    e.preventDefault();
    q.focus();
    q.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  window.renderToday = () => { render(); loadRemote(); };
})();
