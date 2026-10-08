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

  function filesCard() {
    const tree = typeof lastTreeChildren !== 'undefined' ? lastTreeChildren : [];
    const rec = (typeof recentFiles === 'function' ? recentFiles() : []).filter((r) => fileNode(r.path, tree)).slice(0, 8);
    const bm = bookmarks.filter((b) => fileNode(b.path, tree)).slice(0, 8);
    return `<section class="td-card td-files">
      <h3>🕘 Recent</h3>
      <div class="td-flist">${rec.map((r) => fileLink(r.path)).join('') || '<p class="td-empty">Files you open show up here.</p>'}</div>
      ${bm.length ? `<h3 class="td-h2">★ Bookmarks</h3><div class="td-flist">${bm.map((b) => fileLink(b.path)).join('')}</div>` : ''}
    </section>`;
  }

  // ---------- render ----------
  function render() {
    if (!visible()) return;
    const now = new Date();
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
      <div class="td-grid">${todosCard()}${habitsCard()}${ideasCard()}${marketsCard()}${filesCard()}</div>`;
    root.querySelectorAll('[data-icon]').forEach((el) => { if (typeof applyFileIcon === 'function') applyFileIcon(el, el.dataset.icon, el.dataset.kind || undefined); });
    bind();
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
    on('[data-new-stocks]', () => openCreateDialog(''));
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
      const [m, b] = await Promise.all([
        fetch('/api/stocks/overview', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/favorites', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
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

  window.renderToday = () => { render(); loadRemote(); };
})();
