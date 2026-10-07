// Calendar + to-dos in the left panel footer. A mini month calendar picks a
// day; the list shows that day's, week's (Mon–Sun) or month's to-dos. Stored
// on the server (/api/todos -> webapp/todos.json) as
// { days: { "YYYY-MM-DD": [{ id, text, done }] } }.
(function () {
  const root = document.getElementById('calendar-footer');
  if (!root) return;
  const UI_KEY = 'docviewer-calendar';
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let store = { version: 1, days: {} };
  let ui = { open: false, mode: 'day' };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* defaults */ }
  if (!['day', 'week', 'month'].includes(ui.mode)) ui.mode = 'day';
  let selected = todayKey();
  let shownMonth = monthStart(fromKey(selected)); // month shown in the mini calendar
  let saveTimer = null;
  let editing = null; // id of the to-do being edited

  // ---------- dates (local time) ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayKey() { return keyOf(new Date()); }
  function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function weekStart(d) { return addDays(d, -((d.getDay() + 6) % 7)); } // Monday
  function niceDate(k, withYear) {
    const d = fromKey(k);
    return DOW[(d.getDay() + 6) % 7] + ', ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + (withYear ? ' ' + d.getFullYear() : '');
  }
  function uid() { return 't_' + Math.random().toString(36).slice(2, 10); }

  // ---------- storage ----------
  function list(k) { return store.days[k] || []; }
  function setList(k, items) {
    if (items.length) store.days[k] = items;
    else delete store.days[k];
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/todos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(store) })
        .then((r) => { if (!r.ok) throw new Error('save failed'); })
        .catch(() => { if (typeof setStatus === 'function') setStatus('Could not save to-dos', 'dirty'); });
    }, 300);
  }
  function change(fn) {
    fn();
    save();
    render();
  }
  async function load() {
    try {
      const r = await fetch('/api/todos', { cache: 'no-store' });
      if (r.ok) store = await r.json();
    } catch (e) { /* keep empty */ }
    if (!store.days) store.days = {};
    render();
  }
  function rememberUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
  }

  // ---------- actions ----------
  function addTodo(k, text) {
    const t = String(text || '').trim();
    if (!t) return;
    change(() => setList(k, list(k).concat({ id: uid(), text: t.slice(0, 2000), done: false })));
  }
  function updateTodo(k, id, patch) {
    change(() => setList(k, list(k).map((t) => (t.id === id ? Object.assign({}, t, patch) : t))));
  }
  function removeTodo(k, id) {
    change(() => setList(k, list(k).filter((t) => t.id !== id)));
  }
  function moveTodo(fromK, id, toK) {
    if (fromK === toK) return;
    const item = list(fromK).find((t) => t.id === id);
    if (!item) return;
    change(() => {
      setList(fromK, list(fromK).filter((t) => t.id !== id));
      setList(toK, list(toK).concat(item));
    });
  }
  // Unfinished to-dos on days before today.
  function overdue() {
    const today = todayKey();
    const out = [];
    Object.keys(store.days).forEach((k) => {
      if (k < today) list(k).forEach((t) => { if (!t.done) out.push({ k, t }); });
    });
    return out;
  }
  function carryOver() {
    const items = overdue();
    if (!items.length) return;
    const today = todayKey();
    change(() => {
      items.forEach(({ k, t }) => {
        setList(k, list(k).filter((x) => x.id !== t.id));
        setList(today, list(today).concat(t));
      });
    });
  }

  // ---------- render ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    const today = todayKey();
    const openToday = list(today).filter((t) => !t.done).length;
    root.classList.toggle('is-open', ui.open);
    root.innerHTML = '';

    // Header (always visible)
    const head = el('button', 'cal-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', ui.open ? 'true' : 'false');
    head.title = ui.open ? 'Hide calendar' : 'Show calendar and to-dos';
    head.append(el('span', 'cal-twist', ui.open ? '▾' : '▸'), el('span', 'cal-title', 'Calendar'), el('span', 'cal-today', niceDate(today)));
    if (openToday) {
      const b = el('span', 'cal-badge', String(openToday));
      b.title = openToday + ' open to-do' + (openToday === 1 ? '' : 's') + ' today';
      head.appendChild(b);
    }
    head.addEventListener('click', () => { ui.open = !ui.open; rememberUi(); render(); });
    root.appendChild(head);
    if (!ui.open) return;

    root.appendChild(renderMonth(today));
    root.appendChild(renderModes());
    const late = selected === today ? overdue() : [];
    if (late.length) {
      const bar = el('div', 'cal-carry');
      bar.appendChild(el('span', null, late.length + ' unfinished from earlier'));
      const btn = el('button', null, 'Move to today');
      btn.type = 'button';
      btn.addEventListener('click', carryOver);
      bar.appendChild(btn);
      root.appendChild(bar);
    }
    root.appendChild(renderList(today));
    root.appendChild(renderAdd());
  }

  function renderMonth(today) {
    const wrap = el('div', 'cal-month');
    const nav = el('div', 'cal-nav');
    const prev = el('button', 'cal-navbtn', '‹');
    const next = el('button', 'cal-navbtn', '›');
    prev.type = next.type = 'button';
    prev.title = 'Previous month';
    next.title = 'Next month';
    prev.addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1); render(); });
    next.addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1); render(); });
    const label = el('button', 'cal-monthlabel', MONTHS[shownMonth.getMonth()] + ' ' + shownMonth.getFullYear());
    label.type = 'button';
    label.title = 'Go to today';
    label.addEventListener('click', () => { selected = today; shownMonth = monthStart(new Date()); render(); });
    nav.append(prev, label, next);
    wrap.appendChild(nav);

    const grid = el('div', 'cal-grid');
    DOW.forEach((d) => grid.appendChild(el('span', 'cal-dow', d.slice(0, 2))));
    const start = weekStart(shownMonth);
    const selDate = fromKey(selected);
    const selWeek = keyOf(weekStart(selDate));
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const k = keyOf(d);
      const items = list(k);
      const cell = el('button', 'cal-day', String(d.getDate()));
      cell.type = 'button';
      cell.dataset.day = k;
      if (d.getMonth() !== shownMonth.getMonth()) cell.classList.add('is-out');
      if (k === today) cell.classList.add('is-today');
      if (k === selected) cell.classList.add('is-selected');
      // Highlight the selected week/month range.
      if (ui.mode === 'week' && keyOf(weekStart(d)) === selWeek) cell.classList.add('in-range');
      if (ui.mode === 'month' && d.getMonth() === selDate.getMonth() && d.getFullYear() === selDate.getFullYear()) cell.classList.add('in-range');
      if (items.length) {
        const open = items.filter((t) => !t.done).length;
        cell.appendChild(el('i', open ? 'cal-dot' : 'cal-dot is-done'));
        cell.title = niceDate(k) + ': ' + (open ? open + ' open' : 'all done') + ' (' + items.length + ')';
      } else {
        cell.title = niceDate(k);
      }
      cell.addEventListener('click', () => {
        selected = k;
        if (d.getMonth() !== shownMonth.getMonth()) shownMonth = monthStart(d);
        render();
      });
      // Drop a to-do on a day to move it there.
      cell.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('text/x-todo')) return;
        e.preventDefault();
        cell.classList.add('is-drop');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('is-drop'));
      cell.addEventListener('drop', (e) => {
        cell.classList.remove('is-drop');
        const data = e.dataTransfer.getData('text/x-todo');
        if (!data) return;
        e.preventDefault();
        const [fromK, id] = data.split('|');
        moveTodo(fromK, id, k);
      });
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function renderModes() {
    const bar = el('div', 'cal-modes');
    [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].forEach(([m, label]) => {
      const b = el('button', ui.mode === m ? 'is-on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { ui.mode = m; rememberUi(); render(); });
      bar.appendChild(b);
    });
    const range = el('span', 'cal-range');
    const d = fromKey(selected);
    if (ui.mode === 'day') range.textContent = niceDate(selected);
    else if (ui.mode === 'week') {
      const ws = weekStart(d);
      const we = addDays(ws, 6);
      range.textContent = MONTHS[ws.getMonth()].slice(0, 3) + ' ' + ws.getDate() + ' – ' + MONTHS[we.getMonth()].slice(0, 3) + ' ' + we.getDate();
    } else range.textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    bar.appendChild(range);
    return bar;
  }

  // Days covered by the current mode, in order.
  function daysInRange() {
    const d = fromKey(selected);
    if (ui.mode === 'day') return [selected];
    if (ui.mode === 'week') {
      const ws = weekStart(d);
      return Array.from({ length: 7 }, (_, i) => keyOf(addDays(ws, i)));
    }
    const out = [];
    for (let x = monthStart(d); x.getMonth() === d.getMonth(); x = addDays(x, 1)) out.push(keyOf(x));
    return out;
  }

  function renderList(today) {
    const box = el('div', 'cal-list');
    const days = daysInRange();
    let total = 0;
    days.forEach((k) => {
      const items = list(k);
      // Week view lists every day; month view only days with to-dos.
      if (ui.mode === 'month' && !items.length) return;
      if (ui.mode !== 'day') {
        const h = el('button', 'cal-dayhead' + (k === today ? ' is-today' : '') + (k === selected ? ' is-selected' : ''));
        h.type = 'button';
        h.title = 'Add to-dos to ' + niceDate(k);
        h.append(el('span', null, niceDate(k)), el('span', 'cal-count', items.length ? items.filter((t) => t.done).length + '/' + items.length : ''));
        h.addEventListener('click', () => { selected = k; render(); });
        box.appendChild(h);
      }
      items.forEach((t) => { box.appendChild(renderItem(k, t)); total++; });
    });
    if (!total) {
      box.appendChild(el('div', 'cal-empty', ui.mode === 'day' ? 'Nothing planned. Add a to-do below.'
        : ui.mode === 'week' ? 'No to-dos this week.' : 'No to-dos this month.'));
    }
    return box;
  }

  function renderItem(k, t) {
    const row = el('div', 'cal-item' + (t.done ? ' is-done' : ''));
    row.draggable = editing !== t.id;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-todo', k + '|' + t.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.setAttribute('aria-label', 'Done: ' + t.text);
    cb.addEventListener('change', () => updateTodo(k, t.id, { done: cb.checked }));
    row.appendChild(cb);
    if (editing === t.id) {
      const inp = el('input', 'cal-edit');
      inp.type = 'text';
      inp.value = t.text;
      const finish = (keep) => {
        if (editing !== t.id) return;
        editing = null;
        const v = inp.value.trim();
        if (keep && v && v !== t.text) updateTodo(k, t.id, { text: v.slice(0, 2000) });
        else render();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      row.appendChild(inp);
      requestAnimationFrame(() => { inp.focus(); inp.select(); });
    } else {
      const text = el('span', 'cal-text', t.text);
      text.title = 'Double-click to edit · drag onto a day to move';
      text.addEventListener('dblclick', () => { editing = t.id; render(); });
      row.appendChild(text);
    }
    const del = el('button', 'cal-del', '✕');
    del.type = 'button';
    del.title = 'Delete to-do';
    del.addEventListener('click', () => removeTodo(k, t.id));
    row.appendChild(del);
    return row;
  }

  function renderAdd() {
    const form = el('form', 'cal-add');
    const inp = el('input');
    inp.type = 'text';
    inp.placeholder = 'Add to-do for ' + (selected === todayKey() ? 'today' : niceDate(selected)) + '…';
    inp.maxLength = 2000;
    form.appendChild(inp);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value;
      addTodo(selected, v);
      requestAnimationFrame(() => {
        const next = root.querySelector('.cal-add input');
        if (next) next.focus();
      });
    });
    return form;
  }

  // Keep "today" right if the app stays open past midnight.
  let lastToday = todayKey();
  setInterval(() => {
    const t = todayKey();
    if (t !== lastToday) {
      if (selected === lastToday) selected = t;
      lastToday = t;
      render();
    }
  }, 60 * 1000);

  render();
  load();
})();
