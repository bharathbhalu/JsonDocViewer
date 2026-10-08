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
  let reminderFor = null; // id of the to-do whose reminder editor is open

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
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function stamp(d) { return keyOf(d) + 'T' + hhmm(d); } // local "YYYY-MM-DDTHH:MM"
  function fromStamp(v) { const [k, t] = v.split('T'); const d = fromKey(k); const [h, m] = t.split(':').map(Number); d.setHours(h, m, 0, 0); return d; }
  // When a to-do's reminder is due (snooze wins over its time), or null.
  function dueAt(k, t) {
    if (t.snooze) return fromStamp(t.snooze);
    if (t.time) return fromStamp(k + 'T' + t.time);
    return null;
  }
  function timeLabel(t) {
    if (t.snooze) return '⏰ ' + hhmm(fromStamp(t.snooze)) + ' (snoozed)';
    return '⏰ ' + t.time;
  }
  // Trailing repeat word: "Standup @9:30 weekdays", "Water plants weekly".
  const REPEAT_WORDS = { daily: 'daily', 'every day': 'daily', weekdays: 'weekdays', 'every weekday': 'weekdays', weekly: 'weekly', 'every week': 'weekly', monthly: 'monthly', 'every month': 'monthly', yearly: 'yearly', 'every year': 'yearly' };
  function parseRepeatSuffix(raw) {
    const m = String(raw).match(/^(.*\S)\s+(daily|weekdays|weekly|monthly|yearly|every (?:day|weekday|week|month|year))\s*$/i);
    return m ? { text: m[1], repeat: REPEAT_WORDS[m[2].toLowerCase()] } : { text: raw, repeat: null };
  }
  // "Call Sam @14:30" / "@9" / "@2pm" / "@9:15am" -> { text, time }
  function parseTimeSuffix(raw) {
    const m = String(raw).match(/^(.*\S)\s+@\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
    if (!m) return { text: raw, time: null };
    let h = Number(m[2]);
    const min = m[3] ? Number(m[3]) : 0;
    const ap = (m[4] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return { text: raw, time: null };
    return { text: m[1], time: pad(h) + ':' + pad(min) };
  }

  // ---------- storage ----------
  function list(k) { return store.days[k] || []; }
  function setList(k, items) {
    if (items.length) store.days[k] = items;
    else delete store.days[k];
  }

  // ---------- repeating to-dos ----------
  // Stored once on their first day; occurrences are worked out per day.
  const REPEAT_LABEL = { daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function occursOn(t, startK, k) {
    if (k < startK || (t.until && k > t.until) || (t.exDates || []).includes(k)) return false;
    const s = fromKey(startK);
    const d = fromKey(k);
    // A 31st repeats on the last day of shorter months.
    const sameDate = () => d.getDate() === Math.min(s.getDate(), daysInMonth(d.getFullYear(), d.getMonth()));
    switch (t.repeat) {
      case 'daily': return true;
      case 'weekdays': return d.getDay() >= 1 && d.getDay() <= 5;
      case 'weekly': return d.getDay() === s.getDay();
      case 'monthly': return sameDate();
      case 'yearly': return d.getMonth() === s.getMonth() && sameDate();
      default: return false;
    }
  }
  function series() {
    const out = [];
    Object.keys(store.days).forEach((k) => list(k).forEach((t) => { if (t.repeat) out.push({ k, t }); }));
    return out;
  }
  // What shows on a day: its one-off to-dos plus repeating ones falling on it
  // (with that day's done / fired / snooze state; _series = its first day).
  function itemsOn(k) {
    const own = list(k).filter((t) => !t.repeat);
    const reps = series().filter(({ k: sk, t }) => occursOn(t, sk, k)).map(({ k: sk, t }) => Object.assign({}, t, {
      done: (t.doneDates || []).includes(k),
      fired: (t.firedDates || []).includes(k),
      snooze: t.snooze && t.snooze.slice(0, 10) === k ? t.snooze : undefined,
      _series: sk,
    }));
    return own.concat(reps);
  }
  function findItem(id) {
    for (const k of Object.keys(store.days)) {
      const t = list(k).find((x) => x.id === id);
      if (t) return { k, t };
    }
    return null;
  }
  function patchItem(id, fn) {
    const loc = findItem(id);
    if (loc) setList(loc.k, list(loc.k).map((x) => (x.id === id ? fn(Object.assign({}, x)) : x)));
  }
  function setDay(x, field, k, on) {
    const set = new Set(x[field] || []);
    if (on) set.add(k); else set.delete(k);
    x[field] = [...set].sort();
  }
  function isRepeating(id) {
    const loc = findItem(id);
    return !!(loc && loc.t.repeat);
  }
  // Turn repetition on/off/change it. Turning it on keeps the to-do on the
  // day it is stored on, which becomes the first day of the series.
  function setRepeat(id, repeat) {
    change(() => patchItem(id, (x) => {
      if (repeat) {
        if (!x.repeat) {
          const loc = findItem(id);
          x.doneDates = x.done && loc ? [loc.k] : [];
          x.exDates = [];
          x.firedDates = [];
          x.done = false;
          delete x.fired;
        }
        x.repeat = repeat;
      } else if (x.repeat) {
        delete x.repeat; delete x.doneDates; delete x.exDates; delete x.firedDates; delete x.until;
      }
      return x;
    }));
  }
  // Every change is kept as an operation until the server has it. If another
  // tab saved first (409) or the list wasn't loaded yet, the operations are
  // replayed on the server's latest list, so nothing overwrites anything.
  let loaded = false;
  let loadError = false;
  let pendingOps = [];
  let saving = false;
  function replay(base) {
    store = { version: 1, rev: base.rev || 0, days: JSON.parse(JSON.stringify(base.days || {})) };
    pendingOps.forEach((op) => { try { op(); } catch (e) { /* stale op */ } });
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  }
  async function flush(attempt) {
    if (!loaded || saving || !pendingOps.length) return;
    saving = true;
    const sent = pendingOps.length;
    try {
      const r = await fetch('/api/todos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, store, { baseRev: store.rev || 0 })),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409 && data.current && (attempt || 0) < 3) {
        replay(data.current); // someone else saved: re-apply ours on top
        saving = false;
        render();
        return flush((attempt || 0) + 1);
      }
      if (!r.ok) throw new Error(data.error || 'save failed');
      pendingOps.splice(0, sent);
      replay(data); // the server's list plus anything changed while saving
    } catch (e) {
      if (typeof setStatus === 'function') setStatus('Could not save to-dos — will retry', 'dirty');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 5000);
    } finally {
      saving = false;
    }
    if (pendingOps.length) save();
  }
  function change(fn) {
    pendingOps.push(fn);
    fn();
    save();
    render();
  }
  async function load() {
    try {
      const r = await fetch('/api/todos', { cache: 'no-store' });
      if (!r.ok) throw new Error('load failed');
      const fresh = await r.json();
      loaded = true;
      loadError = false;
      replay(fresh); // keeps anything added before the list arrived
      if (pendingOps.length) save();
    } catch (e) {
      // Never save over the server's list if we couldn't read it.
      loadError = true;
      setTimeout(load, 10000);
    }
    render();
  }
  // Pick up changes saved from another tab when coming back to this one.
  window.addEventListener('focus', () => {
    if (loaded && !pendingOps.length && !saving) load();
  });
  // Don't lose the last change when the tab closes during the save delay.
  window.addEventListener('pagehide', () => {
    if (!loaded || !pendingOps.length || !navigator.sendBeacon) return;
    const body = JSON.stringify(Object.assign({}, store, { baseRev: store.rev || 0 }));
    navigator.sendBeacon('/api/todos', new Blob([body], { type: 'text/plain' }));
  });
  function rememberUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
  }

  // ---------- actions ----------
  function addTodo(k, text) {
    const rep1 = parseRepeatSuffix(String(text || '').trim());
    const parsed = parseTimeSuffix(rep1.text.trim());
    const t = parsed.text.trim();
    if (!t) return;
    const item = { id: uid(), text: t.slice(0, 2000), done: false };
    if (parsed.time) { item.time = parsed.time; askNotifyPermission(); }
    if (rep1.repeat) Object.assign(item, { repeat: rep1.repeat, doneDates: [], exDates: [], firedDates: [] });
    change(() => setList(k, list(k).concat(item)));
  }
  // k is the day shown; for a repeating to-do, done/fired apply to that day
  // only, the text to every day.
  function updateTodo(k, id, patch) {
    if (isRepeating(id)) {
      change(() => patchItem(id, (x) => {
        if ('done' in patch) setDay(x, 'doneDates', k, patch.done);
        if ('fired' in patch) setDay(x, 'firedDates', k, patch.fired);
        if ('text' in patch) x.text = patch.text;
        return x;
      }));
      return;
    }
    change(() => setList(k, list(k).map((t) => (t.id === id ? Object.assign({}, t, patch) : t))));
  }
  async function removeTodo(k, id) {
    const loc = findItem(id);
    if (loc && loc.t.repeat && typeof showAsk === 'function') {
      const choice = await showAsk({
        title: 'Delete repeating to-do',
        label: '“' + loc.t.text.slice(0, 80) + '” repeats ' + (REPEAT_LABEL[loc.t.repeat] || '').toLowerCase() + '.',
        mode: 'leave',
        confirmLabel: 'Only this day',
        discardLabel: 'Every day',
      });
      if (choice === 'save') change(() => patchItem(id, (x) => { setDay(x, 'exDates', k, true); return x; }));
      else if (choice === 'discard') change(() => setList(loc.k, list(loc.k).filter((t) => t.id !== id)));
      return;
    }
    change(() => setList(k, list(k).filter((t) => t.id !== id)));
  }
  // Set a reminder at an exact moment; moves the to-do if that's another day.
  // For a repeating to-do: an explicit time applies to every day; a quick
  // "+15 min" style reminder (oneTime) only to the day shown.
  function remindAt(k, id, when, oneTime) {
    if (isRepeating(id)) {
      change(() => patchItem(id, (x) => {
        if (oneTime) x.snooze = stamp(when);
        else { x.time = hhmm(when); delete x.snooze; }
        setDay(x, 'firedDates', oneTime ? keyOf(when) : k, false);
        return x;
      }));
      askNotifyPermission();
      return;
    }
    const toK = keyOf(when);
    const item = list(k).find((t) => t.id === id);
    if (!item) return;
    const next = Object.assign({}, item, { time: hhmm(when), fired: false });
    delete next.snooze;
    change(() => {
      if (toK === k) setList(k, list(k).map((t) => (t.id === id ? next : t)));
      else {
        setList(k, list(k).filter((t) => t.id !== id));
        setList(toK, list(toK).concat(next));
      }
    });
    askNotifyPermission();
  }
  function clearReminder(k, id) {
    if (isRepeating(id)) {
      change(() => patchItem(id, (x) => { delete x.time; delete x.snooze; return x; }));
      return;
    }
    change(() => setList(k, list(k).map((t) => {
      if (t.id !== id) return t;
      const n = Object.assign({}, t);
      delete n.time; delete n.snooze; delete n.fired;
      return n;
    })));
  }
  function snooze(k, id, minutes) {
    const when = new Date(Date.now() + minutes * 60000);
    if (isRepeating(id)) {
      change(() => patchItem(id, (x) => { x.snooze = stamp(when); setDay(x, 'firedDates', k, false); return x; }));
      return;
    }
    change(() => setList(k, list(k).map((t) => (t.id === id ? Object.assign({}, t, { snooze: stamp(when), fired: false }) : t))));
  }

  function moveTodo(fromK, id, toK) {
    if (fromK === toK || isRepeating(id)) return; // repeating ones follow their rule
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
      if (k < today) list(k).forEach((t) => { if (!t.done && !t.repeat) out.push({ k, t }); });
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
    // Re-rendering (e.g. when a reminder fires) must not throw away what
    // the user is typing.
    const addIn = root.querySelector('.cal-add input');
    const editIn = root.querySelector('.cal-edit');
    const timeIn = root.querySelector('.cal-remind input[type="time"]');
    const keep = {
      add: addIn ? addIn.value : '',
      addFocus: addIn && document.activeElement === addIn,
      edit: editIn ? editIn.value : null,
      time: timeIn ? timeIn.value : null,
    };
    renderNow();
    const a = root.querySelector('.cal-add input');
    if (a && keep.add) a.value = keep.add;
    if (a && keep.addFocus) a.focus();
    const e = root.querySelector('.cal-edit');
    if (e && keep.edit != null) e.value = keep.edit;
    const t = root.querySelector('.cal-remind input[type="time"]');
    if (t && keep.time) t.value = keep.time;
  }

  function renderNow() {
    const today = todayKey();
    const openToday = itemsOn(today).filter((t) => !t.done).length;
    root.classList.toggle('is-open', ui.open);
    root.innerHTML = '';

    // Header (always visible)
    const head = el('button', 'cal-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', ui.open ? 'true' : 'false');
    head.title = ui.open ? 'Hide calendar' : 'Show calendar and to-dos';
    head.append(el('span', 'cal-twist', ui.open ? '▾' : '▸'), el('span', 'cal-title', 'Calendar'), el('span', 'cal-today', niceDate(today)));
    const next = nextReminder();
    if (next) {
      const r = el('span', 'cal-next', '⏰ ' + hhmm(next.when));
      r.title = 'Next reminder: ' + next.t.text;
      head.insertBefore(r, head.querySelector('.cal-today'));
    }
    if (openToday) {
      const b = el('span', 'cal-badge', String(openToday));
      b.title = openToday + ' open to-do' + (openToday === 1 ? '' : 's') + ' today';
      head.appendChild(b);
    }
    head.addEventListener('click', () => { ui.open = !ui.open; rememberUi(); render(); });
    root.appendChild(head);
    if (!ui.open) return;
    if (loadError) {
      const bar = el('div', 'cal-carry');
      bar.appendChild(el('span', null, 'Couldn\'t load to-dos. Changes are kept and saved once it loads.'));
      const retry = el('button', null, 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', load);
      bar.appendChild(retry);
      root.appendChild(bar);
    }

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
    if (window.openDaily) {
      const daily = el('button', 'cal-daily', '🔥 Habits & standup · ' + niceDate(selected));
      daily.type = 'button';
      daily.title = 'Check off habits and write the standup for the selected day; download by day/week/month/year';
      daily.addEventListener('click', () => window.openDaily(selected));
      root.appendChild(daily);
    }
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
      const items = itemsOn(k);
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
      const items = itemsOn(k);
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
    row.draggable = editing !== t.id && !t.repeat; // repeating ones follow their rule
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
    const due = dueAt(k, t);
    if (t.repeat) {
      const r = el('span', 'cal-repeat', '↻');
      r.title = REPEAT_LABEL[t.repeat] || 'Repeats';
      row.insertBefore(r, row.querySelector('.cal-text, .cal-edit'));
    }
    const bell = el('button', 'cal-bell' + (due ? ' has-time' : '') + (due && t.fired && !t.done ? ' is-late' : ''), due ? timeLabel(t) : '⏰');
    bell.type = 'button';
    bell.title = due ? 'Reminder ' + (t.fired ? 'went off' : 'set') + ' for ' + hhmm(due) + ' — click to change' : 'Add a reminder';
    bell.addEventListener('click', () => { reminderFor = reminderFor === t.id ? null : t.id; render(); });
    row.appendChild(bell);
    const del = el('button', 'cal-del', '✕');
    del.type = 'button';
    del.title = 'Delete to-do';
    del.addEventListener('click', () => removeTodo(k, t.id));
    row.appendChild(del);
    if (reminderFor !== t.id) return row;
    const wrap = el('div', 'cal-item-wrap');
    wrap.append(row, renderReminderEditor(k, t));
    return wrap;
  }

  function renderReminderEditor(k, t) {
    const box = el('div', 'cal-remind');
    const time = el('input');
    time.type = 'time';
    time.value = t.time || (t.repeat ? '' : hhmm(new Date(Date.now() + 60 * 60000)));
    time.setAttribute('aria-label', 'Reminder time');
    const repeat = el('select', 'cal-remind-repeat');
    repeat.setAttribute('aria-label', 'Repeat');
    [['', 'Does not repeat']].concat(Object.entries(REPEAT_LABEL)).forEach(([v, label]) => {
      const o = el('option', null, label);
      o.value = v;
      if ((t.repeat || '') === v) o.selected = true;
      repeat.appendChild(o);
    });
    const set = el('button', 'cal-remind-set', 'Set');
    set.type = 'button';
    set.addEventListener('click', () => {
      const hasTime = /^\d{2}:\d{2}$/.test(time.value);
      reminderFor = null;
      if ((t.repeat || '') !== repeat.value) setRepeat(t.id, repeat.value || null);
      if (hasTime) remindAt(k, t.id, fromStamp(k + 'T' + time.value));
      else if (!repeat.value || (t.repeat || '') === repeat.value) render();
    });
    time.addEventListener('keydown', (e) => { if (e.key === 'Enter') set.click(); if (e.key === 'Escape') { reminderFor = null; render(); } });
    const quick = (label, fn) => {
      const b = el('button', 'cal-remind-q', label);
      b.type = 'button';
      b.addEventListener('click', () => { reminderFor = null; fn(); });
      return b;
    };
    const tomorrow9 = () => { const d = addDays(new Date(), 1); d.setHours(9, 0, 0, 0); return d; };
    box.append(time, repeat, set,
      quick('+15 min', () => remindAt(k, t.id, new Date(Date.now() + 15 * 60000), true)),
      quick('+1 hour', () => remindAt(k, t.id, new Date(Date.now() + 60 * 60000), true)),
      quick('Tomorrow 9:00', () => remindAt(k, t.id, tomorrow9(), true)));
    if (t.time || t.snooze) box.append(quick('Remove', () => clearReminder(k, t.id)));
    requestAnimationFrame(() => time.focus());
    return box;
  }

  function renderAdd() {
    const form = el('form', 'cal-add');
    const inp = el('input');
    inp.type = 'text';
    inp.placeholder = 'Add to-do for ' + (selected === todayKey() ? 'today' : niceDate(selected)) + '…  (@14:30 reminder · "daily", "weekly"… repeats)';
    inp.maxLength = 2000;
    form.appendChild(inp);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value;
      inp.value = ''; // so the re-render doesn't restore it
      addTodo(selected, v);
      requestAnimationFrame(() => {
        const next = root.querySelector('.cal-add input');
        if (next) next.focus();
      });
    });
    return form;
  }

  // ---------- reminders ----------
  // Fire while the app is open: an in-app alert, a desktop notification if
  // allowed, and a short chime. Missed reminders from the last day still fire
  // when the app is next opened.
  const toasts = document.createElement('div');
  toasts.id = 'reminder-toasts';
  toasts.setAttribute('aria-live', 'polite');
  document.body.appendChild(toasts);

  function askNotifyPermission() {
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (e) { /* unsupported */ }
  }

  function nextReminder() {
    const now = Date.now();
    let best = null;
    [todayKey(), keyOf(addDays(new Date(), 1))].forEach((k) => itemsOn(k).forEach((t) => {
      const when = dueAt(k, t);
      if (!when || t.done || t.fired || when.getTime() < now - 60000) return;
      if (keyOf(when) !== todayKey()) return;
      if (!best || when < best.when) best = { k, t, when };
    }));
    return best;
  }

  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = chime.ctx || (chime.ctx = new AC());
      [0, 0.18].forEach((delay, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = i ? 1046.5 : 784;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.4);
      });
    } catch (e) { /* no audio */ }
  }

  function showToast(k, t, when) {
    const existing = toasts.querySelector('[data-id="' + t.id + '"]');
    if (existing) existing.remove();
    const card = el('div', 'rem-toast');
    card.dataset.id = t.id;
    card.setAttribute('role', 'alert');
    const head = el('div', 'rem-head');
    head.append(el('span', 'rem-icon', '⏰'), el('span', 'rem-when', 'Reminder · ' + hhmm(when) + (k !== todayKey() ? ' · ' + niceDate(k) : '')));
    const close = el('button', 'rem-x', '✕');
    close.type = 'button';
    close.title = 'Dismiss';
    close.addEventListener('click', () => card.remove());
    head.appendChild(close);
    card.append(head, el('div', 'rem-text', t.text));
    const actions = el('div', 'rem-actions');
    const act = (label, cls, fn) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', () => { card.remove(); fn(); });
      actions.appendChild(b);
    };
    act('Done', 'rem-primary', () => updateTodo(k, t.id, { done: true }));
    act('Snooze 10 min', '', () => snooze(k, t.id, 10));
    act('Snooze 1 hour', '', () => snooze(k, t.id, 60));
    act('Show', '', () => { ui.open = true; selected = k; shownMonth = monthStart(fromKey(k)); rememberUi(); render(); });
    card.appendChild(actions);
    toasts.appendChild(card);
  }

  function notify(k, t, when) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification('Reminder · ' + hhmm(when), { body: t.text, tag: 'todo-' + t.id, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* unsupported */ }
  }

  function checkReminders() {
    const now = Date.now();
    const due = [];
    const yesterday = keyOf(addDays(new Date(), -1));
    // Yesterday and today: one-off to-dos plus repeating occurrences.
    [yesterday, todayKey()].forEach((k) => {
      itemsOn(k).forEach((t) => {
        const when = dueAt(k, t);
        // Due now, or missed within the last day while the app was closed.
        if (when && !t.done && !t.fired && when.getTime() <= now && now - when.getTime() < 24 * 3600000) due.push({ k, t, when });
      });
    });
    if (!loaded || !due.length) return;
    // Only one open tab shows a given reminder.
    const mine = due.filter(({ t, when }) => {
      const key = 'docviewer-rem:' + t.id + ':' + when.getTime();
      try {
        if (localStorage.getItem(key)) return false;
        localStorage.setItem(key, String(Date.now()));
      } catch (e) { /* no storage: fire anyway */ }
      return true;
    });
    change(() => due.forEach(({ k, t }) => {
      if (t._series) {
        patchItem(t.id, (x) => {
          setDay(x, 'firedDates', k, true);
          if (x.snooze && x.snooze.slice(0, 10) === k) delete x.snooze; // the one-time reminder is used up
          return x;
        });
      } else setList(k, list(k).map((x) => (x.id === t.id ? Object.assign({}, x, { fired: true }) : x)));
    }));
    mine.forEach(({ k, t, when }) => { showToast(k, t, when); notify(k, t, when); });
    if (mine.length) chime();
  }
  setInterval(checkReminders, 15 * 1000);

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
  load().then(checkReminders);
})();
