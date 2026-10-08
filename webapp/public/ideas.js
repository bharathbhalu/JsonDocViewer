// Ideas: capture an idea in two seconds from anywhere (Cmd/Ctrl+Shift+I or
// the 💡 button), with #tags and a reminder to come back to it. Reminders
// show an in-app card with actions (open, snooze, tomorrow, next week,
// exploring, park, done) plus a desktop notification. The Ideas inbox lists
// everything by status, and "Open as note" turns an idea into a markdown doc
// under ideas/. Stored on the server (/api/ideas -> webapp/ideas.json).
(function () {
  const PREFS_KEY = 'docviewer-ideas';
  const STATUS = [
    { id: 'inbox', label: 'Inbox', icon: '📥' },
    { id: 'exploring', label: 'Exploring', icon: '🔍' },
    { id: 'parked', label: 'Parked', icon: '🅿' },
    { id: 'done', label: 'Done', icon: '✓' },
  ];
  const REPEAT = [
    { id: '', label: 'Once' },
    { id: 'daily', label: 'Daily' },
    { id: '3d', label: 'Every 3 days' },
    { id: 'weekly', label: 'Weekly' },
  ];
  const REPEAT_MS = { daily: 864e5, '3d': 3 * 864e5, weekly: 7 * 864e5 };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pad = (n) => String(n).padStart(2, '0');

  let prefs = { remind: 'tomorrow', repeat: '' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* defaults */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  // ---------- reminder times ----------
  function at(daysAhead, h, m) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(h, m || 0, 0, 0);
    return d.getTime();
  }
  const PRESETS = [
    { id: 'none', label: 'No reminder', when: () => null },
    { id: '1h', label: 'In 1 hour', when: () => Date.now() + 36e5 },
    { id: 'tonight', label: 'Tonight 8 pm', when: () => (new Date().getHours() >= 20 ? at(1, 20) : at(0, 20)) },
    { id: 'tomorrow', label: 'Tomorrow 9 am', when: () => at(1, 9) },
    { id: '3d', label: 'In 3 days', when: () => at(3, 9) },
    { id: 'weekend', label: 'This weekend', when: () => { const d = new Date(); const add = (6 - d.getDay() + 7) % 7 || 7; return at(add, 10); } },
    { id: 'week', label: 'Next week', when: () => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return at(add, 9); } },
    { id: 'custom', label: 'Pick date & time…', when: () => null },
  ];
  function whenLabel(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 864e5);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 0) return 'today ' + time;
    if (days === 1) return 'tomorrow ' + time;
    if (days === -1) return 'yesterday ' + time;
    if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time;
  }
  const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // ---------- storage (same revision scheme as to-dos) ----------
  let store = { rev: 0, ideas: [] };
  let loaded = false;
  let pending = [];
  let saving = false;
  let saveTimer = null;
  async function load() {
    try {
      const r = await fetch('/api/ideas', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      store = await r.json();
      pending.forEach((fn) => fn(store));
      loaded = true;
      if (pending.length) flush();
    } catch (e) { setTimeout(load, 5000); }
    refreshBadge();
  }
  function change(fn) {
    fn(store);
    pending.push(fn);
    clearTimeout(saveTimer);
    if (loaded) saveTimer = setTimeout(flush, 300);
    refreshBadge();
    if (panel) drawPanel();
  }
  async function flush() {
    if (saving || !pending.length || !loaded) return;
    saving = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    let failed = false;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sent = pending.length;
        const r = await fetch('/api/ideas', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, store, { baseRev: store.rev })) });
        const data = await r.json().catch(() => ({}));
        if (r.status === 409 && data.current) { store = data.current; pending.forEach((fn) => fn(store)); continue; }
        if (!r.ok) throw new Error(data.error || 'Save failed');
        const rest = pending.slice(sent);
        store = data;
        rest.forEach((fn) => fn(store));
        pending = rest;
        break;
      }
    } catch (err) {
      failed = true;
      setStatus('Ideas not saved: ' + ((err && err.message) || err), 'error');
    } finally { saving = false; }
    if (pending.length) saveTimer = setTimeout(flush, failed ? 5000 : 300);
  }
  window.addEventListener('beforeunload', () => {
    if (pending.length && loaded) navigator.sendBeacon('/api/ideas', new Blob([JSON.stringify(Object.assign({}, store, { baseRev: store.rev }))], { type: 'application/json' }));
  });
  const ideaOf = (id) => store.ideas.find((i) => i.id === id);
  function patch(id, p) {
    change((s) => { const i = s.ideas.find((x) => x.id === id); if (i) Object.assign(i, p, { updated: Date.now() }); });
  }
  function parseTags(text) {
    const tags = [];
    const clean = text.replace(/(^|\s)#([\p{L}\p{N}_./-]+)/gu, (m, sp, t) => { if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t); return sp; }).replace(/[ \t]+$/gm, '').trim();
    return { text: clean || text.trim(), tags };
  }

  // ---------- capture ----------
  let capture = null;
  function openCapture(prefill) {
    if (capture) { capture.querySelector('textarea').focus(); return; }
    askPermission();
    const ov = document.createElement('div');
    ov.className = 'topo-overlay idea-capture-ov';
    ov.innerHTML = `
      <div class="md-dialog-box idea-capture" role="dialog" aria-modal="true" aria-label="Capture idea">
        <div class="md-dialog-head"><span>💡 Capture idea</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <textarea rows="4" placeholder="What's the idea? Use #tags. First line becomes the title.&#10;&#10;Cmd/Ctrl+Enter to save"></textarea>
          <div class="ic-row"><span class="ic-label">Remind me</span><span class="ic-chips">${PRESETS.map((p) => `<button type="button" data-p="${p.id}" class="${p.id === prefs.remind ? 'on' : ''}">${esc(p.label)}</button>`).join('')}</span></div>
          <div class="ic-row ic-custom${prefs.remind === 'custom' ? '' : ' hidden'}"><span class="ic-label">At</span><input type="datetime-local" class="ic-dt"></div>
          <div class="ic-row"><span class="ic-label">Repeat</span><span class="ic-chips">${REPEAT.map((r) => `<button type="button" data-r="${r.id}" class="${r.id === prefs.repeat ? 'on' : ''}">${esc(r.label)}</button>`).join('')}</span><span class="md-note">until you mark it exploring, parked or done</span></div>
        </div>
        <div class="md-dialog-actions"><button type="button" data-inbox>📥 Open inbox</button><span class="md-spacer"></span><button type="button" data-cancel>Cancel</button><button type="button" class="md-primary" data-save>Save idea</button></div>
      </div>`;
    document.body.appendChild(ov);
    capture = ov;
    const ta = ov.querySelector('textarea');
    const dt = ov.querySelector('.ic-dt');
    dt.value = toLocalInput(at(1, 9));
    if (prefill) ta.value = prefill;
    let preset = prefs.remind;
    let repeat = prefs.repeat;
    const close = () => { ov.remove(); capture = null; };
    ov.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
      preset = b.dataset.p;
      ov.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === b));
      ov.querySelector('.ic-custom').classList.toggle('hidden', preset !== 'custom');
      ta.focus();
    }));
    ov.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
      repeat = b.dataset.r;
      ov.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === b));
      ta.focus();
    }));
    const save = () => {
      const raw = ta.value.trim();
      if (!raw) { ta.focus(); return; }
      const { text, tags } = parseTags(raw);
      let remindAt = null;
      if (preset === 'custom') remindAt = dt.value ? new Date(dt.value).getTime() : null;
      else remindAt = (PRESETS.find((p) => p.id === preset) || PRESETS[0]).when();
      const rep = remindAt ? repeat : '';
      prefs.remind = preset; prefs.repeat = repeat; savePrefs();
      change((s) => { s.ideas.unshift({ id: uid(), text, tags, status: 'inbox', created: Date.now(), updated: null, remindAt, repeat: rep, note: null }); });
      close();
      setStatus('Idea saved' + (remindAt ? ' · reminder ' + whenLabel(remindAt) : ''), 'ok');
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);
    ov.querySelector('[data-save]').addEventListener('click', save);
    ov.querySelector('[data-inbox]').addEventListener('click', () => { close(); openPanel(); });
    ta.focus();
  }

  // ---------- inbox panel ----------
  let panel = null;
  let filter = { status: 'inbox', q: '', tag: '' };
  function openPanel(focusId) {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.className = 'topo-overlay';
    panel.innerHTML = `
      <div class="md-dialog-box idea-panel" role="dialog" aria-modal="true" aria-label="Ideas">
        <div class="md-dialog-head"><span>💡 Ideas</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <div class="ip-bar">
            <span class="ip-tabs"></span>
            <input type="search" class="ip-q" placeholder="Search ideas" value="${esc(filter.q)}">
            <button type="button" class="md-primary" data-new>＋ Capture</button>
          </div>
          <div class="ip-tags"></div>
          <div class="ip-list"></div>
        </div>
      </div>`;
    document.body.appendChild(panel);
    const close = () => { panel.remove(); panel = null; };
    panel.querySelector('[data-x]').addEventListener('click', close);
    panel.addEventListener('mousedown', (e) => { if (e.target === panel) close(); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('textarea, input')) close(); });
    panel.querySelector('.ip-q').addEventListener('input', (e) => { filter.q = e.target.value; drawPanel(); });
    panel.querySelector('[data-new]').addEventListener('click', () => openCapture());
    panel.focusId = focusId || null;
    if (focusId) { const i = ideaOf(focusId); if (i) { filter.status = i.status; filter.tag = ''; filter.q = ''; } }
    drawPanel();
  }
  function drawPanel() {
    if (!panel) return;
    const counts = {};
    store.ideas.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
    const due = store.ideas.filter((i) => i.remindAt && i.remindAt <= Date.now() && i.status !== 'done').length;
    panel.querySelector('.ip-tabs').innerHTML = STATUS.map((s) => `<button type="button" data-s="${s.id}" class="${filter.status === s.id ? 'on' : ''}">${s.icon} ${s.label} <span>${counts[s.id] || 0}</span></button>`).join('')
      + `<button type="button" data-s="reminders" class="${filter.status === 'reminders' ? 'on' : ''}">⏰ Reminders${due ? ` <span class="due">${due} due</span>` : ''}</button>`;
    panel.querySelectorAll('.ip-tabs [data-s]').forEach((b) => b.addEventListener('click', () => { filter.status = b.dataset.s; drawPanel(); }));
    const allTags = [...new Set(store.ideas.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
    panel.querySelector('.ip-tags').innerHTML = allTags.map((t) => `<button type="button" data-t="${esc(t)}" class="${filter.tag === t ? 'on' : ''}">#${esc(t)}</button>`).join('');
    panel.querySelectorAll('.ip-tags [data-t]').forEach((b) => b.addEventListener('click', () => { filter.tag = filter.tag === b.dataset.t ? '' : b.dataset.t; drawPanel(); }));
    const q = filter.q.trim().toLowerCase();
    let list = store.ideas.filter((i) => (filter.status === 'reminders' ? i.remindAt && i.status !== 'done' : i.status === filter.status)
      && (!filter.tag || i.tags.includes(filter.tag))
      && (!q || i.text.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q))));
    if (filter.status === 'reminders') list = list.slice().sort((a, b) => a.remindAt - b.remindAt);
    const box = panel.querySelector('.ip-list');
    if (!list.length) { box.innerHTML = `<p class="md-note">${filter.status === 'inbox' && !store.ideas.length ? 'No ideas yet. Press Cmd/Ctrl+Shift+I anywhere to capture one.' : 'Nothing here.'}</p>`; return; }
    box.innerHTML = list.map((i) => {
      const [title, ...rest] = i.text.split('\n');
      const overdue = i.remindAt && i.remindAt <= Date.now();
      return `<div class="ip-item${panel.focusId === i.id ? ' focus' : ''}" data-id="${esc(i.id)}">
        <div class="ip-main">
          <div class="ip-title">${esc(title)}</div>
          ${rest.join('\n').trim() ? `<div class="ip-body">${esc(rest.join('\n').trim())}</div>` : ''}
          <div class="ip-meta">
            ${i.tags.map((t) => `<span class="ip-tag">#${esc(t)}</span>`).join('')}
            <span>${esc(new Date(i.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
            ${i.remindAt ? `<span class="ip-rem${overdue ? ' due' : ''}">⏰ ${esc(whenLabel(i.remindAt))}${i.repeat ? ' · ' + esc(REPEAT.find((r) => r.id === i.repeat).label.toLowerCase()) : ''}</span>` : ''}
            ${i.note ? `<a href="#" class="ip-note" data-a="note">📄 ${esc(i.note.split('/').pop())}</a>` : ''}
          </div>
        </div>
        <div class="ip-actions">
          <select data-a="status" aria-label="Status">${STATUS.map((s) => `<option value="${s.id}"${s.id === i.status ? ' selected' : ''}>${s.icon} ${s.label}</option>`).join('')}</select>
          <button type="button" data-a="remind" title="Set reminder">⏰</button>
          <button type="button" data-a="note" title="${i.note ? 'Open note' : 'Open as a markdown note'}">📄</button>
          <button type="button" data-a="edit" title="Edit">✎</button>
          <button type="button" data-a="delete" title="Delete">🗑</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('.ip-item').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-a="status"]').addEventListener('change', (e) => setIdeaStatus(id, e.target.value));
      row.querySelector('.ip-actions [data-a="remind"]').addEventListener('click', (e) => remindMenu(id, e.currentTarget));
      row.querySelectorAll('[data-a="note"]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openNote(id); }));
      row.querySelector('[data-a="edit"]').addEventListener('click', () => editIdea(row, id));
      row.querySelector('[data-a="delete"]').addEventListener('click', async () => {
        if (!(await uiConfirm('Delete this idea?', { title: 'Delete idea', okLabel: 'Delete', danger: true }))) return;
        change((s) => { s.ideas = s.ideas.filter((x) => x.id !== id); });
      });
    });
    const f = box.querySelector('.ip-item.focus');
    if (f) { f.scrollIntoView({ block: 'center' }); panel.focusId = null; }
  }
  // Moving an idea out of the inbox ends its repeating reminder.
  function setIdeaStatus(id, status) {
    const i = ideaOf(id);
    const p = { status };
    if (i && i.repeat && status !== 'inbox') { p.repeat = ''; p.remindAt = null; }
    if (status === 'done') { p.remindAt = null; p.repeat = ''; }
    patch(id, p);
  }
  function editIdea(row, id) {
    const i = ideaOf(id);
    const main = row.querySelector('.ip-main');
    main.innerHTML = `<textarea class="ip-edit" rows="4">${esc(i.text + (i.tags.length ? '\n' + i.tags.map((t) => '#' + t).join(' ') : ''))}</textarea><div class="ip-edit-actions"><button type="button" data-c>Cancel</button><button type="button" class="md-primary" data-s>Save</button></div>`;
    const ta = main.querySelector('textarea');
    ta.focus();
    const save = () => { const { text, tags } = parseTags(ta.value); if (text) patch(id, { text, tags }); else drawPanel(); };
    main.querySelector('[data-s]').addEventListener('click', save);
    main.querySelector('[data-c]').addEventListener('click', drawPanel);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.stopPropagation(); drawPanel(); }
    });
  }
  function remindMenu(id, anchor) {
    document.querySelectorAll('.ip-menu').forEach((m) => m.remove());
    const i = ideaOf(id);
    const m = document.createElement('div');
    m.className = 'ip-menu dh-ctx';
    m.innerHTML = PRESETS.filter((p) => p.id !== 'none' && p.id !== 'custom').map((p) => `<button type="button" data-p="${p.id}">${esc(p.label)}</button>`).join('')
      + `<div class="ip-menu-row"><input type="datetime-local" value="${toLocalInput(i.remindAt || at(1, 9))}"><button type="button" data-p="custom">Set</button></div>`
      + `<div class="ip-menu-row">Repeat <select>${REPEAT.map((r) => `<option value="${r.id}"${r.id === i.repeat ? ' selected' : ''}>${r.label}</option>`).join('')}</select></div>`
      + (i.remindAt ? '<hr><button type="button" data-p="none" class="danger">Clear reminder</button>' : '');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mr = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.right - mr.width, innerWidth - mr.width - 8)) + 'px';
    m.style.top = (r.bottom + mr.height + 8 > innerHeight ? r.top - mr.height - 4 : r.bottom + 4) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    m.querySelector('select').addEventListener('change', (e) => { if (ideaOf(id).remindAt) patch(id, { repeat: e.target.value }); });
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const p = b.dataset.p;
      const repeat = m.querySelector('select').value;
      let when = null;
      if (p === 'custom') { const v = m.querySelector('input').value; if (!v) return; when = new Date(v).getTime(); }
      else if (p !== 'none') when = PRESETS.find((x) => x.id === p).when();
      patch(id, { remindAt: when, repeat: when ? repeat : '' });
      askPermission();
      m.remove();
      document.removeEventListener('mousedown', off, true);
    });
  }
  async function openNote(id) {
    const i = ideaOf(id);
    if (i.note) {
      try { await openFile(i.note); if (panel) { panel.remove(); panel = null; } return; } catch (e) { /* recreate below */ }
    }
    const title = i.text.split('\n')[0].trim();
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'idea';
    const body = i.text.split('\n').slice(1).join('\n').trim();
    const content = [`# ${title}`, '', `_Captured ${new Date(i.created).toLocaleString()}_${i.tags.length ? ' · ' + i.tags.map((t) => '#' + t).join(' ') : ''}`, '',
      body ? body + '\n' : '', '## Problem', '', '- Who has it? How painful is it?', '', '## Solution', '', '', '## Why now / why me', '', '',
      '## Riskiest assumptions', '', '- [ ] ', '', '## Next step', '', '- [ ] ', ''].join('\n');
    let dest = `ideas/${slug}.md`;
    for (let n = 2; n < 100; n++) {
      const r = await fetch('/api/file/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dest }) });
      if (r.ok) break;
      dest = `ideas/${slug}-${n}.md`;
    }
    const { res, data } = await postFileContent(dest, content);
    if (!res.ok) { alert('Could not write the note: ' + (data.error || res.status)); return; }
    patch(id, { note: dest, status: i.status === 'inbox' ? 'exploring' : i.status });
    if (panel) { panel.remove(); panel = null; }
    await loadTree();
    await openFile(dest);
  }

  // ---------- reminders ----------
  function askPermission() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
  function toastBox() {
    let box = document.getElementById('reminder-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'reminder-toasts'; document.body.appendChild(box); }
    return box;
  }
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = chime.ctx || (chime.ctx = new AC());
      [0, 0.15, 0.3].forEach((delay, n) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = [659.3, 784, 1046.5][n];
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.35);
      });
    } catch (e) { /* no audio */ }
  }
  function nextAfter(i) {
    // Repeating reminders move forward past now; one-off ones clear.
    if (!i.repeat) return null;
    let t = i.remindAt;
    while (t <= Date.now()) t += REPEAT_MS[i.repeat];
    return t;
  }
  function showReminder(i) {
    const box = toastBox();
    const old = box.querySelector(`[data-idea="${i.id}"]`);
    if (old) old.remove();
    const [title, ...rest] = i.text.split('\n');
    const card = document.createElement('div');
    card.className = 'rem-toast idea-toast';
    card.dataset.idea = i.id;
    card.setAttribute('role', 'alert');
    card.innerHTML = `
      <div class="rem-head"><span class="rem-icon">💡</span><span class="rem-when">Idea reminder${i.repeat ? ' · ' + esc(REPEAT.find((r) => r.id === i.repeat).label.toLowerCase()) : ''}</span><button type="button" class="rem-x" title="Dismiss" data-a="dismiss">✕</button></div>
      <div class="rem-text"><b>${esc(title)}</b>${rest.join(' ').trim() ? '<br><span class="it-sub">' + esc(rest.join(' ').trim().slice(0, 160)) + '</span>' : ''}</div>
      ${i.tags.length ? `<div class="it-tags">${i.tags.map((t) => '#' + esc(t)).join(' ')}</div>` : ''}
      <div class="rem-actions">
        <button type="button" class="rem-primary" data-a="open">Open</button>
        <button type="button" data-a="explore">🔍 Explore</button>
        <button type="button" data-a="1h">1 hour</button>
        <button type="button" data-a="tomorrow">Tomorrow</button>
        <button type="button" data-a="week">Next week</button>
        <button type="button" data-a="park">🅿 Park</button>
        <button type="button" data-a="done">✓ Done</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      card.remove();
      const a = b.dataset.a;
      if (a === 'open') openPanel(i.id);
      else if (a === 'explore') openNote(i.id);
      else if (a === '1h') patch(i.id, { remindAt: Date.now() + 36e5 });
      else if (a === 'tomorrow') patch(i.id, { remindAt: at(1, 9) });
      else if (a === 'week') patch(i.id, { remindAt: PRESETS.find((p) => p.id === 'week').when() });
      else if (a === 'park') setIdeaStatus(i.id, 'parked');
      else if (a === 'done') setIdeaStatus(i.id, 'done');
    });
    box.appendChild(card);
  }
  function notify(i) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification('💡 ' + i.text.split('\n')[0].slice(0, 80), {
        body: (i.tags.length ? i.tags.map((t) => '#' + t).join(' ') + ' · ' : '') + 'Click to review — snooze, explore, park or done',
        tag: 'idea-' + i.id,
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); openPanel(i.id); };
    } catch (e) { /* unsupported */ }
  }
  function checkReminders() {
    if (!loaded) return;
    const now = Date.now();
    const due = store.ideas.filter((i) => i.remindAt && i.remindAt <= now && i.status !== 'done');
    if (!due.length) return;
    const mine = due.filter((i) => {
      // Only one open tab shows a given reminder.
      const key = 'docviewer-idea-rem:' + i.id + ':' + i.remindAt;
      try {
        if (localStorage.getItem(key)) return false;
        localStorage.setItem(key, String(now));
      } catch (e) { /* fire anyway */ }
      return true;
    });
    // Advance or clear so it doesn't fire again; the card keeps the actions.
    change((s) => due.forEach((d) => { const i = s.ideas.find((x) => x.id === d.id); if (i && i.remindAt === d.remindAt) i.remindAt = nextAfter(i); }));
    mine.forEach((i) => { showReminder(i); notify(i); });
    if (mine.length) chime();
  }
  setInterval(checkReminders, 15000);

  // ---------- entry points ----------
  function refreshBadge() {
    const btn = document.getElementById('idea-btn');
    if (!btn) return;
    const inbox = store.ideas.filter((i) => i.status === 'inbox').length;
    btn.dataset.count = inbox ? String(inbox) : '';
    btn.title = `Capture an idea (Cmd/Ctrl+Shift+I) · ${inbox} in inbox — right-click to open the inbox`;
  }
  const btn = document.getElementById('idea-btn');
  if (btn) {
    btn.addEventListener('click', () => openCapture());
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openPanel(); });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'I' || e.key === 'i' || e.code === 'KeyI')) {
      e.preventDefault();
      e.stopPropagation();
      // Selected text (outside the editor) becomes the idea draft.
      const sel = String(window.getSelection ? window.getSelection() : '').trim();
      openCapture(sel.slice(0, 2000));
    }
  }, true);
  // Monaco swallows keys; register the shortcut there too once it exists.
  const hookEditor = setInterval(() => {
    if (typeof editor === 'undefined' || !editor || !window.monaco) return;
    clearInterval(hookEditor);
    try {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI, () => {
        const sel = editor.getModel() ? editor.getModel().getValueInRange(editor.getSelection()) : '';
        openCapture(sel.slice(0, 2000));
      });
    } catch (e) { /* older monaco */ }
  }, 1000);

  window.openIdeaCapture = openCapture;
  window.openIdeas = openPanel;
  load().then(checkReminders);
})();
