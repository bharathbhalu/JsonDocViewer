// Habits + daily standups. Opened from the calendar footer ("Habits &
// standup") for the selected day. Habits are checked off per day with a
// streak and a 14-day strip; the standup has yesterday / today / blockers /
// notes. Everything can be downloaded for a day, week (Mon–Sun), month, year
// or all time as Markdown or CSV. Stored on the server (/api/daily ->
// webapp/daily.json) with the same revision check as the to-dos.
(function () {
  const FIELDS = [
    { id: 'yesterday', label: 'Yesterday', hint: 'What did you finish?' },
    { id: 'today', label: 'Today', hint: 'What will you work on?' },
    { id: 'blockers', label: 'Blockers', hint: 'Anything in your way?' },
    { id: 'notes', label: 'Notes', hint: 'Anything else' },
  ];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const shift = (k, n) => keyOf(addDays(fromKey(k), n));
  const nice = (k) => fromKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const uid = () => 'h_' + Math.random().toString(36).slice(2, 10);

  let store = { rev: 0, habits: [], checks: {}, standups: {} };
  let loaded = false;
  let pending = []; // mutations not yet confirmed by the server
  let saveTimer = null;
  let saving = false;
  let ov = null;
  let day = keyOf(new Date());

  // ---------- storage ----------
  async function load() {
    const r = await fetch('/api/daily', { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load habits');
    store = await r.json();
    loaded = true;
  }
  function change(fn) {
    fn(store);
    pending.push(fn);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
    document.dispatchEvent(new CustomEvent('accretion:daily-changed'));
  }
  async function flush() {
    if (saving || !pending.length) return;
    saving = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    let failed = false;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sent = pending.length;
        const r = await fetch('/api/daily', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, store, { baseRev: store.rev })),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 409 && data.current) {
          // Saved elsewhere meanwhile: take theirs and re-apply ours.
          store = data.current;
          pending.forEach((fn) => fn(store));
          continue;
        }
        if (!r.ok) throw new Error(data.error || 'Save failed');
        // Keep edits made while the request was in flight.
        const rest = pending.slice(sent);
        store = data;
        rest.forEach((fn) => fn(store));
        pending = rest;
        break;
      }
    } catch (err) {
      failed = true;
      setStatus('Habits/standup not saved: ' + ((err && err.message) || err), 'error');
    } finally {
      saving = false;
    }
    if (pending.length) saveTimer = setTimeout(flush, failed ? 5000 : 400);
  }
  window.addEventListener('beforeunload', () => {
    if (pending.length) navigator.sendBeacon('/api/daily', new Blob([JSON.stringify(Object.assign({}, store, { baseRev: store.rev }))], { type: 'application/json' }));
  });

  // ---------- habits ----------
  // Disabled habits keep their history but aren't tracked from the day they
  // were disabled until re-enabled: h.off = [[from, to|null], …], `to`
  // exclusive. They sort below the enabled ones.
  const habitOf = (id) => store.habits.find((h) => h.id === id);
  const isDisabled = (h) => !!(h.off && h.off.length && h.off[h.off.length - 1][1] == null);
  const isOff = (h, k) => !!(h && h.off && h.off.some((r) => r[0] <= k && (r[1] == null || k < r[1])));
  const active = () => {
    const list = store.habits.filter((h) => !h.archived);
    return list.filter((h) => !isDisabled(h)).concat(list.filter(isDisabled));
  };
  const isDone = (k, id) => (store.checks[k] || []).includes(id);
  function setEnabled(id, on) {
    const today = keyOf(new Date());
    change((st) => {
      const h = st.habits.find((x) => x.id === id);
      if (!h) return;
      h.off = (h.off || []).slice();
      const last = h.off[h.off.length - 1];
      if (on && last && last[1] == null) {
        if (last[0] >= today) h.off.pop(); else last[1] = today;
      } else if (!on && !(last && last[1] == null)) h.off.push([today, null]);
    });
  }
  function toggle(k, id) {
    if (isOff(habitOf(id), k)) return;
    change((s) => {
      const list = new Set(s.checks[k] || []);
      if (list.has(id)) list.delete(id); else list.add(id);
      if (list.size) s.checks[k] = [...list]; else delete s.checks[k];
    });
  }
  // Consecutive days done ending at k (or the day before, if k isn't done yet).
  // Disabled days neither count nor break a streak.
  function streak(id, k) {
    const h = habitOf(id);
    let d = isDone(k, id) ? k : shift(k, -1);
    let n = 0;
    for (let i = 0; i < 10000; i++, d = shift(d, -1)) {
      if (isOff(h, d)) continue;
      if (!isDone(d, id)) break;
      n++;
    }
    return n;
  }
  function best(id) {
    const h = habitOf(id);
    const days = Object.keys(store.checks).filter((k) => isDone(k, id)).sort();
    let bestN = 0, run = 0, prev = null;
    days.forEach((k) => {
      let next = prev && shift(prev, 1);
      while (next && next < k && isOff(h, next)) next = shift(next, 1);
      run = next === k ? run + 1 : 1;
      bestN = Math.max(bestN, run);
      prev = k;
    });
    return bestN;
  }

  // ---------- panel ----------
  async function open(k) {
    if (k) day = k;
    if (!loaded) {
      try { await load(); } catch (err) { alert((err && err.message) || err); return; }
    }
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.className = 'topo-overlay';
    ov.innerHTML = `
      <div class="md-dialog-box daily-box" role="dialog" aria-modal="true" aria-label="Habits and standup">
        <div class="md-dialog-head">
          <span class="daily-nav">
            <button type="button" data-prev title="Previous day">‹</button>
            <input type="date" class="daily-date" aria-label="Day">
            <button type="button" data-next title="Next day">›</button>
            <button type="button" data-today>Today</button>
          </span>
          <button type="button" data-x aria-label="Close">×</button>
        </div>
        <div class="md-dialog-body daily-body">
          <section class="daily-habits">
            <h3>Habits</h3>
            <div class="daily-hlist"></div>
            <form class="daily-hadd"><input type="text" placeholder="New habit, e.g. Read 20 min" maxlength="120" aria-label="New habit"><button type="submit">Add</button></form>
          </section>
          <section class="daily-standup">
            <h3>Standup <button type="button" class="daily-carry" title="Copy yesterday's &quot;Today&quot; into &quot;Yesterday&quot;">↧ from yesterday</button></h3>
            ${FIELDS.map((f) => `<label><span>${f.label}</span><textarea data-f="${f.id}" rows="3" placeholder="${esc(f.hint)}"></textarea></label>`).join('')}
          </section>
          <section class="daily-chart">
            <h3>Habit chart
              <select data-crange aria-label="Chart range"><option value="week">Week</option><option value="month" selected>Month</option><option value="year">Year</option></select>
              <span class="dc-label"></span>
            </h3>
            <div class="dc-wrap"></div>
            <div class="dc-legend"><b>●</b> red underline = Sunday · green = done · striped = disabled · click a square to toggle · right-click a habit for more</div>
          </section>
        </div>
        <div class="md-dialog-actions daily-export">
          <span>Download</span>
          <select data-range aria-label="Range"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option><option value="all">All</option></select>
          <select data-fmt aria-label="Format"><option value="html">HTML (habits include chart)</option><option value="md">Markdown</option><option value="csv">CSV</option></select>
          <button type="button" data-dl="habits" title="Habit summary, chart and check-ins">⤓ Habits</button>
          <button type="button" data-dl="standups" title="Standup notes only">⤓ Standups</button>
          <span class="md-spacer"></span>
          <button type="button" class="md-primary" data-done>Done</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => { flushStandup(); flush(); ov.remove(); ov = null; };
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-done]').addEventListener('click', close);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('textarea')) close(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const go = (k) => { flushStandup(); day = k; draw(); };
    ov.querySelector('[data-prev]').addEventListener('click', () => go(shift(day, -1)));
    ov.querySelector('[data-next]').addEventListener('click', () => go(shift(day, 1)));
    ov.querySelector('[data-today]').addEventListener('click', () => go(keyOf(new Date())));
    ov.querySelector('.daily-date').addEventListener('change', (e) => { if (e.target.value) go(e.target.value); });
    ov.querySelector('.daily-hadd').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const name = input.value.trim();
      if (!name) return;
      change((s) => { s.habits.push({ id: uid(), name, created: day, archived: false }); });
      input.value = '';
      drawHabits();
    });
    ov.querySelectorAll('textarea[data-f]').forEach((t) => t.addEventListener('input', () => {
      clearTimeout(t._timer);
      t._timer = setTimeout(flushStandup, 600);
    }));
    ov.querySelector('.daily-carry').addEventListener('click', () => {
      const prev = store.standups[shift(day, -1)];
      const t = ov.querySelector('textarea[data-f="yesterday"]');
      if (!prev || !prev.today) { setStatus('No "Today" in the previous day\'s standup', 'error'); return; }
      t.value = t.value.trim() ? t.value.replace(/\s*$/, '\n') + prev.today : prev.today;
      flushStandup();
    });
    ov.querySelector('[data-crange]').addEventListener('change', drawChart);
    ov.querySelector('.dc-wrap').addEventListener('click', (e) => {
      const c = e.target.closest('[data-k]');
      if (c && c.dataset.h) { toggle(c.dataset.k, c.dataset.h); drawHabits(); }
      else if (c) go(c.dataset.k);
    });
    ov.querySelectorAll('[data-dl]').forEach((btn) => btn.addEventListener('click', () => {
      flushStandup();
      const range = ov.querySelector('[data-range]').value;
      const fmt = ov.querySelector('[data-fmt]').value;
      if (btn.dataset.dl === 'habits') downloadHabits(range, fmt); else downloadStandups(range, fmt);
    }));
    draw();
  }

  // Write the textareas into the store if they differ.
  function flushStandup() {
    if (!ov) return;
    const k = day;
    const entry = {};
    ov.querySelectorAll('textarea[data-f]').forEach((t) => { clearTimeout(t._timer); if (t.value.trim()) entry[t.dataset.f] = t.value; });
    const cur = store.standups[k] || {};
    if (JSON.stringify(cur) === JSON.stringify(entry)) return;
    change((s) => { if (Object.keys(entry).length) s.standups[k] = entry; else delete s.standups[k]; });
  }

  function draw() {
    ov.querySelector('.daily-date').value = day;
    const s = store.standups[day] || {};
    ov.querySelectorAll('textarea[data-f]').forEach((t) => { t.value = s[t.dataset.f] || ''; });
    drawHabits();
  }

  function drawHabits() {
    if (!ov) return;
    const box = ov.querySelector('.daily-hlist');
    const list = active();
    drawChart();
    if (!list.length) { box.innerHTML = '<p class="md-note">No habits yet. Add one below — check it off each day to build a streak.</p>'; return; }
    const strip = Array.from({ length: 14 }, (_, i) => shift(day, i - 13));
    box.innerHTML = list.map((h, i) => {
      const n = streak(h.id, day);
      const dis = isDisabled(h);
      const off = isOff(h, day);
      const sep = dis && (i === 0 || !isDisabled(list[i - 1])) ? '<div class="dh-sep">Disabled</div>' : '';
      return sep + `
      <div class="daily-habit${isDone(day, h.id) ? ' done' : ''}${dis ? ' dis' : ''}" data-id="${esc(h.id)}" title="Right-click for rename, ${dis ? 'enable' : 'disable'}, delete">
        <label class="dh-check"><input type="checkbox"${isDone(day, h.id) ? ' checked' : ''}${off ? ' disabled' : ''}><span class="dh-name">${esc(h.name)}</span></label>
        <span class="dh-streak" title="Current streak · best ${best(h.id)}">${dis ? 'paused' : n ? '🔥 ' + n : '—'}</span>
        <span class="dh-strip">${strip.map((k) => `<i class="${isDone(k, h.id) ? 'on' : ''}${isOff(h, k) ? ' off' : ''}${k === day ? ' cur' : ''}${fromKey(k).getDay() === 0 ? ' sun' : ''}" title="${esc(nice(k))}${isOff(h, k) ? ' · not tracked' : ''}" data-k="${k}"></i>`).join('')}</span>
      </div>`;
    }).join('');
    box.querySelectorAll('.daily-habit').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('input').addEventListener('change', () => { toggle(day, id); drawHabits(); });
      row.querySelectorAll('.dh-strip i').forEach((c) => c.addEventListener('click', () => { toggle(c.dataset.k, id); drawHabits(); }));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); habitMenu(row, id, e.clientX, e.clientY); });
    });
  }

  function closeHabitMenu() { const m = document.querySelector('.dh-ctx'); if (m) m.remove(); }
  function habitMenu(row, id, x, y) {
    closeHabitMenu();
    const h = habitOf(id);
    const dis = isDisabled(h);
    const m = document.createElement('div');
    m.className = 'dh-ctx';
    m.innerHTML = `<button type="button" data-a="rename">Rename</button>
      <button type="button" data-a="toggle">${dis ? 'Enable — track again from today' : 'Disable — stop tracking from today'}</button>
      <hr><button type="button" data-a="delete" class="danger">Delete…</button>`;
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { closeHabitMenu(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      closeHabitMenu();
      document.removeEventListener('mousedown', off, true);
      if (a.dataset.a === 'rename') renameHabit(row, id);
      else if (a.dataset.a === 'toggle') { setEnabled(id, dis); drawHabits(); }
      else deleteHabit(id);
    });
  }
  async function deleteHabit(id) {
    const h = habitOf(id);
    const count = Object.values(store.checks).filter((l) => l.includes(id)).length;
    if (!(await uiConfirm(`Delete the habit "${h.name}"${count ? ` and its ${count} check-in${count === 1 ? '' : 's'}` : ''}? This can't be undone.\n\nTip: Disable keeps its history instead.`, { title: 'Delete habit', okLabel: 'Delete', danger: true }))) return;
    change((st) => {
      st.habits = st.habits.filter((y) => y.id !== id);
      Object.keys(st.checks).forEach((k) => {
        st.checks[k] = st.checks[k].filter((y) => y !== id);
        if (!st.checks[k].length) delete st.checks[k];
      });
    });
    drawHabits();
  }
  function renameHabit(row, id) {
    const h = habitOf(id);
    const nameEl = row.querySelector('.dh-name');
    const input = document.createElement('input');
    input.className = 'dh-rename';
    input.value = h.name;
    input.maxLength = 120;
    input.title = 'Enter to save · Esc to cancel';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v !== h.name) {
        if (v) change((st) => { const x = st.habits.find((y) => y.id === id); if (x) x.name = v; });
      }
      drawHabits();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- chart: habits (rows) against calendar dates (columns) ----------
  function drawChart() {
    if (!ov) return;
    const wrap = ov.querySelector('.dc-wrap');
    const kind = ov.querySelector('[data-crange]').value;
    const list = active();
    if (!list.length) { wrap.innerHTML = ''; ov.querySelector('.dc-label').textContent = ''; return; }
    const [a, b] = rangeOf(kind);
    const days = daysBetween(a, b);
    const today = keyOf(new Date());
    const d0 = fromKey(day);
    ov.querySelector('.dc-label').textContent = kind === 'week' ? nice(a) + ' – ' + nice(b)
      : kind === 'month' ? d0.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : String(d0.getFullYear());
    wrap.innerHTML = chartGrid(days, list, kind, day);
    // Keep the selected day in view on wide (year) charts.
    const cur = wrap.querySelector('.dc-date.cur');
    if (cur && cur.offsetLeft + cur.offsetWidth > wrap.clientWidth) wrap.scrollLeft = Math.max(0, cur.offsetLeft - wrap.clientWidth / 2);
    else wrap.scrollLeft = 0;
  }

  // Chart markup shared by the panel and the HTML download.
  function chartGrid(days, list, kind, curKey) {
    const today = keyOf(new Date());
    const long = days.length > 62;
    const cls = (k) => (k === curKey ? ' cur' : '') + (k > today ? ' future' : '') + ([0, 6].includes(fromKey(k).getDay()) ? ' wknd' : '') + (fromKey(k).getDay() === 0 ? ' sun' : '');
    const head = days.map((k, i) => {
      const d = fromKey(k);
      const show = !long || d.getDate() === 1 || i === 0;
      const txt = long ? d.toLocaleDateString(undefined, { month: 'short' }) + (d.getMonth() === 0 || i === 0 ? ' ' + d.getFullYear() : '')
        : (kind === 'week' ? d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' : '') + d.getDate();
      return `<span class="dc-date${cls(k)}" data-k="${k}" title="${esc(nice(k))}">${show ? esc(txt) : ''}</span>`;
    }).join('');
    // Daily completion bars: share of habits done that day.
    const bars = days.map((k) => {
      const tracked = list.filter((h) => !isOff(h, k));
      const n = tracked.filter((h) => isDone(k, h.id)).length;
      const pct = tracked.length ? Math.round((n / tracked.length) * 100) : 0;
      return `<span class="dc-bar${cls(k)}" data-k="${k}" title="${esc(nice(k))}: ${n}/${tracked.length} (${pct}%)"><i style="height:${pct}%"></i></span>`;
    }).join('');
    const rows = list.map((h) => {
      const past = days.filter((k) => k <= today && !isOff(h, k));
      const done = past.filter((k) => isDone(k, h.id)).length;
      const pct = past.length ? Math.round((done / past.length) * 100) : 0;
      return `<span class="dc-name${isDisabled(h) ? ' dis' : ''}" title="${esc(h.name)}${isDisabled(h) ? ' (disabled)' : ''}">${esc(h.name)}</span>`
        + days.map((k) => (isOff(h, k)
          ? `<span class="dc-cell off${isDone(k, h.id) ? ' on' : ''}${cls(k)}" title="${esc(h.name)} · ${esc(nice(k))} · not tracked"></span>`
          : `<span class="dc-cell${isDone(k, h.id) ? ' on' : ''}${cls(k)}" data-k="${k}" data-h="${esc(h.id)}" title="${esc(h.name)} · ${esc(nice(k))}${isDone(k, h.id) ? ' ✓' : ''}"></span>`)).join('')
        + `<span class="dc-pct" title="${done} of ${past.length} days so far">${pct}%</span>`;
    }).join('');
    return `<div class="dc-grid dc-${long ? 'year' : kind}" style="grid-template-columns: minmax(80px, 140px) repeat(${days.length}, var(--dc-w)) 48px">
      <span class="dc-corner">Done / day</span>${bars}<span></span>
      <span class="dc-corner"></span>${head}<span></span>
      ${rows}
    </div>`;
  }

  // Self-contained HTML report: summary, chart, then each day's standup.
  const REPORT_CSS = `
    :root { --ink:#1c2330; --muted:#667085; --line:rgba(28,35,48,.08); --line-strong:rgba(28,35,48,.14); --accent:#4f6ef7; --panel:#fff; }
    @media (prefers-color-scheme: dark) { :root { --ink:#e8ecf3; --muted:#9aa3b2; --line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.16); --accent:#8aa8d4; --panel:#171c26; } }
    body { margin:0; background:var(--panel); color:var(--ink); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width:1100px; margin:0 auto; padding:28px 20px 60px; }
    h1 { margin:0 0 2px; font-size:24px; } .sub { color:var(--muted); margin:0 0 22px; }
    h2 { font-size:16px; margin:28px 0 10px; border-bottom:1px solid var(--line); padding-bottom:4px; }
    table { border-collapse:collapse; } th, td { padding:5px 12px; border:1px solid var(--line-strong); text-align:left; } th { font-weight:600; }
    td.n { text-align:right; font-variant-numeric:tabular-nums; }
    .dc-wrap { overflow-x:auto; padding-bottom:6px; }
    .dc-grid { --dc-w:22px; display:grid; gap:3px; align-items:center; font-size:11px; width:max-content; }
    .dc-week { --dc-w:56px; } .dc-year { --dc-w:6px; gap:3px 1px; }
    .dc-name, .dc-corner, .dc-grid > span:first-child { position:sticky; left:0; z-index:1; background:var(--panel); align-self:stretch; display:flex; align-items:center; }
    .dc-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:6px; font-size:12px; }
    .dc-corner { color:var(--muted); font-size:10px; }
    .dc-date { text-align:center; color:var(--muted); white-space:nowrap; font-size:10px; } .dc-year .dc-date { text-align:left; }
    .dc-bar { height:34px; display:flex; align-items:flex-end; background:var(--line); border-radius:3px; overflow:hidden; }
    .dc-bar i { display:block; width:100%; background:var(--accent); opacity:.75; }
    .dc-cell { height:18px; border-radius:3px; background:var(--line-strong); } .dc-year .dc-cell { height:14px; border-radius:1px; }
    .wknd { opacity:.75; } .dc-cell.on { background:#22a06b; opacity:1; } .future { opacity:.35; }
    .dc-pct { text-align:right; color:var(--muted); white-space:nowrap; position:sticky; right:0; background:var(--panel); }
    .day { border:1px solid var(--line-strong); border-radius:10px; padding:10px 14px; margin:10px 0; break-inside:avoid; }
    .day h3 { margin:0 0 6px; font-size:14px; } .day h4 { margin:8px 0 2px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
    .day p { margin:0; white-space:pre-wrap; } .habits { margin-top:8px; font-size:12px; } .habits span { margin-right:10px; }
    .habits .on { color:#22a06b; font-weight:600; } .habits .off { color:var(--muted); } .none { color:var(--muted); font-style:italic; }
    .dc-date.sun { color:#d64545; font-weight:600; }
    .dc-cell.sun, .dc-bar.sun { box-shadow: inset 0 -3px 0 #d64545; }
    .dc-year .dc-date.sun:empty::after { content:''; display:block; width:4px; height:4px; margin:0 auto; border-radius:50%; background:#d64545; }
    .dc-cell.off { background:repeating-linear-gradient(45deg, var(--line) 0 3px, transparent 3px 6px); opacity:.6; } .dc-name.dis { color:var(--muted); }
    .dc-legend { font-size:11px; color:var(--muted); margin-top:4px; } .dc-legend b { color:#d64545; }
    @media print { .dc-wrap { overflow:visible; } }`;
  const pageHtml = (title, sub, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head>
<body><main><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>${body}</main>
<script>document.querySelectorAll('.dc-wrap').forEach(function (w) { var c = w.querySelector('.dc-date.cur') || [].slice.call(w.querySelectorAll('.dc-date')).pop(); if (c && c.offsetLeft + c.offsetWidth > w.clientWidth) w.scrollLeft = Math.max(0, c.offsetLeft - w.clientWidth / 2); });</script></body></html>`;
  function habitStats(h, span) {
    const past = span.filter((k) => k <= keyOf(new Date()) && !isOff(h, k));
    const n = past.filter((k) => isDone(k, h.id)).length;
    return { n, of: past.length, pct: past.length ? Math.round((n / past.length) * 100) : 0, best: best(h.id) };
  }
  // A one-day habit report charts the 30 days leading up to it.
  const habitSpan = (kind, a, b) => (kind === 'day' ? daysBetween(shift(b, -29), b) : daysBetween(a, b));
  function habitsHtml(kind, a, b, label, habits) {
    const span = habitSpan(kind, a, b);
    const body = habits.length ? `<h2>Summary</h2><table><thead><tr><th>Habit</th><th>Days done</th><th>Of days</th><th>Rate</th><th>Best streak</th></tr></thead><tbody>${habits.map((h) => {
      const st = habitStats(h, span);
      return `<tr><td>${esc(h.name)}</td><td class="n">${st.n}</td><td class="n">${st.of}</td><td class="n">${st.pct}%</td><td class="n">${st.best}</td></tr>`;
    }).join('')}</tbody></table>
      <h2>Chart</h2>
      <div class="dc-wrap">${chartGrid(span, habits, kind === 'day' ? 'month' : kind, kind === 'day' ? b : null)}</div><div class="dc-legend"><b>●</b> red underline = Sunday · green = done · bar = share of habits done that day</div>` : '<p class="none">No habits.</p>';
    return pageHtml('Habits — ' + (label === 'all' ? 'all time' : label), nice(span[0]) + ' → ' + nice(span[span.length - 1]), body);
  }
  function standupsHtml(kind, a, b, label, days) {
    const entries = days.map((k) => {
      const s = store.standups[k] || {};
      return `<section class="day"><h3>${esc(nice(k))}</h3>
        ${FIELDS.filter((f) => s[f.id]).map((f) => `<h4>${f.label}</h4><p>${esc(s[f.id].trim())}</p>`).join('') || '<p class="none">No standup.</p>'}</section>`;
    }).join('');
    return pageHtml('Standups — ' + (label === 'all' ? 'all time' : label), nice(a) + ' → ' + nice(b), entries || '<p class="none">No standups in this range.</p>');
  }

  // ---------- download ----------
  function rangeOf(kind) {
    const d = fromKey(day);
    if (kind === 'day') return [day, day, day];
    if (kind === 'week') {
      const mon = addDays(d, -((d.getDay() + 6) % 7));
      return [keyOf(mon), keyOf(addDays(mon, 6)), 'week-of-' + keyOf(mon)];
    }
    if (kind === 'month') {
      const a = new Date(d.getFullYear(), d.getMonth(), 1);
      return [keyOf(a), keyOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)), keyOf(a).slice(0, 7)];
    }
    if (kind === 'year') return [d.getFullYear() + '-01-01', d.getFullYear() + '-12-31', String(d.getFullYear())];
    const keys = Object.keys(store.standups).concat(Object.keys(store.checks)).sort();
    return keys.length ? [keys[0], keys[keys.length - 1], 'all'] : [day, day, 'all'];
  }
  function daysBetween(a, b) {
    const out = [];
    for (let k = a; k <= b && out.length < 40000; k = shift(k, 1)) out.push(k);
    return out;
  }
  function rangeFor(kind, what) {
    if (kind !== 'all') return rangeOf(kind);
    const keys = Object.keys(what === 'habits' ? store.checks : store.standups).sort();
    return keys.length ? [keys[0], keys[keys.length - 1], 'all'] : [day, day, 'all'];
  }
  function save(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const csvq = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const weekday = (k) => fromKey(k).toLocaleDateString('en-US', { weekday: 'long' });

  // Habits: summary, chart and per-day check-ins — no standup text.
  function downloadHabits(kind, fmt) {
    const [a, b, label] = rangeFor(kind, 'habits');
    const span = habitSpan(kind, a, b);
    const habits = active().filter((h) => !isDisabled(h) || span.some((k) => isDone(k, h.id) || !isOff(h, k)));
    if (!habits.length) { setStatus('No habits to download', 'error'); return; }
    const title = 'Habits — ' + (label === 'all' ? 'all time' : label);
    let text, type;
    if (fmt === 'html') { text = habitsHtml(kind, a, b, label, habits); type = 'text/html'; }
    else if (fmt === 'csv') {
      const rows = span.map((k) => [k, weekday(k), ...habits.map((h) => (isOff(h, k) ? '' : isDone(k, h.id) ? 1 : 0)), habits.filter((h) => isDone(k, h.id)).length]);
      text = '﻿' + [['date', 'weekday', ...habits.map((h) => h.name), 'done'], ...rows].map((r) => r.map(csvq).join(',')).join('\r\n') + '\r\n';
      type = 'text/csv';
    } else {
      const out = [`# ${title}`, '', `_${nice(span[0])} → ${nice(span[span.length - 1])}_`, '', '## Summary', '', '| Habit | Days done | Of days | Rate | Best streak |', '| --- | --- | --- | --- | --- |'];
      habits.forEach((h) => { const st = habitStats(h, span); out.push(`| ${h.name.replace(/\|/g, '\\|')} | ${st.n} | ${st.of} | ${st.pct}% | ${st.best} |`); });
      out.push('', '## Check-ins', '', '| Date | ' + habits.map((h) => h.name.replace(/\|/g, '\\|')).join(' | ') + ' |', '| --- |' + habits.map(() => ' :-: |').join(''));
      span.forEach((k) => out.push(`| ${nice(k)}${fromKey(k).getDay() === 0 ? ' ☀' : ''} | ` + habits.map((h) => (isOff(h, k) ? '–' : isDone(k, h.id) ? '✅' : '·')).join(' | ') + ' |'));
      text = out.join('\n') + '\n';
      type = 'text/markdown';
    }
    save(`habits-${label}.${fmt}`, text, type);
    setStatus(`Downloaded habits for ${span.length} day${span.length === 1 ? '' : 's'}`, 'ok');
  }

  // Standups only.
  function downloadStandups(kind, fmt) {
    const [a, b, label] = rangeFor(kind, 'standups');
    // Day/week list every day; longer ranges only days with a standup.
    const days = daysBetween(a, b).filter((k) => kind === 'day' || kind === 'week' || store.standups[k]);
    let text, type;
    if (fmt === 'html') { text = standupsHtml(kind, a, b, label, days); type = 'text/html'; }
    else if (fmt === 'csv') {
      const rows = days.map((k) => { const s = store.standups[k] || {}; return [k, weekday(k), ...FIELDS.map((f) => s[f.id] || '')]; });
      text = '﻿' + [['date', 'weekday', ...FIELDS.map((f) => f.id)], ...rows].map((r) => r.map(csvq).join(',')).join('\r\n') + '\r\n';
      type = 'text/csv';
    } else {
      const out = [`# Standups — ${label === 'all' ? 'all time' : label}`, '', `_${nice(a)} → ${nice(b)}_`, ''];
      days.forEach((k) => {
        const s = store.standups[k] || {};
        out.push(`## ${nice(k)}`, '');
        FIELDS.forEach((f) => { if (s[f.id]) out.push(`**${f.label}**`, '', s[f.id].trim(), ''); });
        if (!Object.keys(s).length) out.push('_No standup._', '');
      });
      if (!days.length) out.push('_No standups in this range._');
      text = out.join('\n');
      type = 'text/markdown';
    }
    save(`standups-${label}.${fmt}`, text, type);
    setStatus(`Downloaded ${days.length} standup${days.length === 1 ? '' : 's'}`, 'ok');
  }

  window.openDaily = open;
  // For the Today screen.
  window.dailyApi = {
    async ready() { if (!loaded) { try { await load(); } catch (e) { /* offline */ } } return loaded; },
    habits: () => active(),
    isDone,
    isOff,
    isDisabled,
    streak,
    toggle: (k, id) => toggle(k, id),
    standup: (k) => store.standups[k] || null,
  };
})();
