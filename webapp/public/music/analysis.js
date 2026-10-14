/* DocViewer music analysis (phase 4, front end): add-on install / remove,
 * analyze dialog, background job dock with live progress (SSE), analysis
 * versions (apply any run's key / tempo / chords / sections / notes, delete
 * runs), stems listing, and exports (MIDI, MusicXML, text tab, chord sheet). */
(function (global) {
  const T = global.MusicTheory;
  const U = global.MusicPlayerUtil;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STEP_LABELS = { stems: 'Separate stems (vocals, drums, bass, guitar, piano, other)', notes: 'Extract notes', tempo: 'Tempo & beats', key: 'Key', chords: 'Chords', sections: 'Song sections' };
  const PART_LABELS = { mix: 'Full mix', vocals: 'Vocals', guitar: 'Guitar', bass: 'Bass', piano: 'Piano', other: 'Other' };

  async function api(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function modal(title, html, opts) {
    const ov = document.createElement('div');
    ov.className = 'mu-modal';
    ov.innerHTML = `<div class="mu-modal-box ma-box${opts && opts.wide ? ' wide' : ''}"><div class="mu-modal-head"><b>${esc(title)}</b><button type="button" data-x>×</button></div><div class="ma-body">${html}</div></div>`;
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc, true); };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onEsc, true);
    ov.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());
    return { ov, close, q: (s) => ov.querySelector(s), qa: (s) => ov.querySelectorAll(s) };
  }
  const status = (msg, kind) => { if (global.setStatus) global.setStatus(msg, kind || 'ok'); };
  const fmtDate = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? String(s || '') : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

  // ---------- job dock ----------
  const Jobs = {
    items: new Map(),
    el: null,
    ensureEl() {
      if (this.el && this.el.isConnected) return this.el;
      this.el = document.createElement('div');
      this.el.className = 'ma-dock';
      document.body.appendChild(this.el);
      return this.el;
    },
    watch(job, meta) {
      if (this.items.has(job.id)) return;
      const it = { job, meta: meta || {}, es: null };
      this.items.set(job.id, it);
      const es = new EventSource('/api/music/jobs/' + encodeURIComponent(job.id));
      it.es = es;
      es.onmessage = (e) => {
        let j;
        try { j = JSON.parse(e.data); } catch (err) { return; }
        it.job = j;
        this.draw();
        if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
          es.close();
          if (j.status === 'done' && it.meta.onDone) it.meta.onDone(j);
          if (j.status === 'done') Analysis.emit('done', j);
          if (j.status === 'done' && j.kind !== 'analyze') setTimeout(() => { this.items.delete(j.id); this.draw(); }, 6000);
        }
      };
      es.onerror = () => { /* the browser retries; the job keeps running on the server */ };
      this.draw();
    },
    draw() {
      const el = this.ensureEl();
      const list = [...this.items.values()];
      el.hidden = !list.length;
      el.innerHTML = list.map(({ job: j }) => {
        const pct = Math.round((j.progress || 0) * 100);
        const st = j.status === 'done' ? '✓ Done' : j.status === 'error' ? '✕ Failed' : j.status === 'cancelled' ? 'Cancelled' : j.status === 'queued' ? 'Queued' : pct + '%';
        return `<div class="ma-job ${j.status}" data-job="${esc(j.id)}">
          <div class="ma-job-h"><b title="${esc(j.label)}">${esc(j.label)}</b><span>${st}</span></div>
          <div class="ma-bar"><i style="width:${j.status === 'done' ? 100 : pct}%"></i></div>
          <div class="ma-job-msg" title="${esc(j.error || j.msg)}">${esc(j.status === 'error' ? (j.error || 'Failed') : j.msg || '')}</div>
          <div class="ma-job-acts">
            ${j.status === 'running' || j.status === 'queued' ? '<button type="button" data-cancel>Cancel</button>' : ''}
            ${j.status === 'done' && j.kind === 'analyze' ? '<button type="button" class="mu-primary" data-review>Review & apply</button>' : ''}
            ${j.status !== 'running' && j.status !== 'queued' ? '<button type="button" data-dismiss>Dismiss</button>' : ''}
          </div></div>`;
      }).join('');
      el.querySelectorAll('[data-job]').forEach((row) => {
        const it = this.items.get(row.dataset.job);
        const b = (s, f) => { const x = row.querySelector(s); if (x) x.addEventListener('click', f); };
        b('[data-cancel]', () => api('/api/music/jobs/' + encodeURIComponent(it.job.id) + '/cancel', {}).catch(() => {}));
        b('[data-dismiss]', () => { this.items.delete(it.job.id); this.draw(); });
        b('[data-review]', () => Analysis.review(it.job));
      });
    },
    async reattach() {
      try {
        const { jobs } = await api('/api/music/jobs');
        jobs.filter((j) => j.status === 'running' || j.status === 'queued').forEach((j) => this.watch(j));
      } catch (e) { /* server without the add-on API */ }
    },
  };

  const Analysis = {
    engine: null,
    listeners: {},
    on(ev, f) { (this.listeners[ev] = this.listeners[ev] || []).push(f); },
    emit(ev, x) { (this.listeners[ev] || []).forEach((f) => { try { f(x); } catch (e) { /* ignore */ } }); },
    attach(engine) {
      this.engine = engine;
      if (!this._reattached) { this._reattached = true; Jobs.reattach(); }
    },
    detach(engine) { if (this.engine === engine) this.engine = null; },
    status() { return api('/api/music/addon'); },

    // ---------- add-on dialog ----------
    async addonDialog() {
      const m = modal('Music analysis add-on', '<div class="mu-empty">Checking…</div>');
      const draw = async (check) => {
        let info;
        try { info = await api('/api/music/addon' + (check ? '?check=1' : '')); } catch (e) { m.q('.ma-body').innerHTML = '<div class="mu-empty">' + esc(e.message) + '</div>'; return; }
        const v = info.versions;
        m.q('.ma-body').innerHTML = `
          <p>Separates stems (vocals, drums, bass, guitar, piano, other), extracts notes, and finds key, tempo, beats, chords and song sections — on this computer, offline after install.</p>
          <div class="ma-kv"><span>Status</span><b class="${info.installed ? 'ma-ok' : ''}">${info.installed ? 'Ready' + (info.installedAt ? ' · installed ' + esc(fmtDate(info.installedAt)) : '') : 'Not installed'}</b>
            <span>Location</span><code>${esc(info.dir)}</code>
            <span>Size</span><span>about 1.5–2.5 GB (Python 3.11, PyTorch, Demucs, Basic Pitch, librosa, models); ffmpeg and uv via Homebrew if missing</span>
            ${v ? `<span>Versions</span><span>${esc(Object.entries(v).filter(([, x]) => x).map(([k, x]) => k + ' ' + (k === 'ffmpeg' ? '✓' : x)).join(' · '))}</span>` : ''}</div>
          <p class="mu-hint">Also from the terminal: <code>./setup.sh --music</code> (and <code>--remove-music</code>).</p>
          <div class="mu-modal-acts">${info.installed ? '<button type="button" data-check>Check</button><button type="button" data-remove class="danger">Remove</button><span class="mu-sp"></span><button type="button" data-install>Reinstall / update</button>' : '<span class="mu-sp"></span><button type="button" class="mu-primary" data-install>Install (≈2 GB)</button>'}</div>`;
        const b = (s, f) => { const x = m.q(s); if (x) x.addEventListener('click', f); };
        b('[data-check]', () => draw(true));
        b('[data-install]', async () => {
          if (!(await global.uiConfirm('Download and install the music analysis add-on (about 2 GB) into ' + info.dir + '? It can take 5–15 minutes. You can keep working meanwhile.', { title: 'Install music analysis', okLabel: 'Install' }))) return;
          try { const { job } = await api('/api/music/addon/install', {}); Jobs.watch(job, { onDone: () => status('Music analysis is ready') }); m.close(); } catch (e) { global.uiAlert(e.message); }
        });
        b('[data-remove]', async () => {
          if (!(await global.uiConfirm('Remove the music analysis add-on from ' + info.dir + '? Analysis results already saved in your data folder stay.', { title: 'Remove add-on', okLabel: 'Remove', danger: true }))) return;
          try { const { job } = await api('/api/music/addon/remove', {}); Jobs.watch(job); m.close(); } catch (e) { global.uiAlert(e.message); }
        });
      };
      draw(false);
    },

    // ---------- analyze dialog ----------
    async analyzeDialog(engine, tracks, preset) {
      let info;
      try { info = await this.status(); } catch (e) { global.uiAlert('Could not reach the server: ' + e.message); return; }
      if (!info.installed) {
        if (await global.uiConfirm('Analysis needs the music analysis add-on (about 2 GB, installed once into ~/.accretion/music). Set it up now?', { title: 'Music analysis', okLabel: 'Set up…' })) this.addonDialog();
        return;
      }
      const steps = preset || ['stems', 'notes', 'tempo', 'key', 'chords', 'sections'];
      const one = tracks.length === 1 ? tracks[0] : null;
      const m = modal(one ? 'Analyze “' + one.title + '”' : 'Analyze ' + tracks.length + ' tracks', `
        <div class="ma-checks">${Object.keys(STEP_LABELS).map((k) => `<label><input type="checkbox" data-step="${k}"${steps.includes(k) ? ' checked' : ''}> ${STEP_LABELS[k]}</label>`).join('')}</div>
        <div data-partsbox><h5>Notes from</h5><div class="ma-checks row">${Object.keys(PART_LABELS).map((k) => `<label><input type="checkbox" data-part="${k}"${k === 'mix' ? ' checked' : ''}> ${PART_LABELS[k]}</label>`).join('')}</div>
        <p class="mu-hint">A single instrument or voice works best: tick <b>Separate stems</b> and choose Vocals, Guitar or Bass.</p></div>
        <p class="mu-hint">Runs in the background, one track at a time (a 4-minute song takes about 1–3 minutes). Results are saved next to the media file in <code>&lt;name&gt;.analysis/</code>; earlier runs are kept.</p>
        <div class="mu-modal-acts"><span class="mu-sp"></span><button type="button" data-x>Cancel</button><button type="button" class="mu-primary" data-go>Analyze</button></div>`);
      const sync = () => { m.q('[data-partsbox]').hidden = !m.q('[data-step="notes"]').checked; };
      m.qa('[data-step]').forEach((x) => x.addEventListener('change', sync));
      sync();
      m.q('[data-go]').addEventListener('click', async () => {
        const st = [...m.qa('[data-step]:checked')].map((x) => x.dataset.step);
        const parts = [...m.qa('[data-part]:checked')].map((x) => x.dataset.part);
        if (!st.length) return;
        m.close();
        for (const t of tracks) {
          try {
            const { job } = await api('/api/music/analyze', { media: t.media, steps: st, parts: parts.length ? parts : ['mix'], label: t.title });
            Jobs.watch(job, { media: t.media });
          } catch (e) { global.uiAlert(t.title + ': ' + e.message); }
        }
      });
    },

    // A finished job: open the versions dialog on that run.
    review(job) {
      const eng = this.engine;
      const media = job.result && job.result.media;
      const t = eng && eng.data.tracks.find((x) => x.media === media);
      if (!t) { global.uiAlert('Open the music collection with this track to apply the results.'); return; }
      eng._select(t.id);
      this.applyDialog(eng, t, job.result.run);
    },

    // ---------- versions ----------
    async versionsDialog(engine, t) {
      const m = modal('Analysis — ' + t.title, '<div class="mu-empty">Loading…</div>', { wide: true });
      const draw = async () => {
        let st;
        try { st = await api('/api/music/analysis?media=' + encodeURIComponent(t.media)); } catch (e) { m.q('.ma-body').innerHTML = '<div class="mu-empty">' + esc(e.message) + '</div>'; return; }
        m.q('.ma-body').innerHTML = `
          ${st.runs.length ? `<table class="ma-runs"><thead><tr><th>Run</th><th>Found</th><th></th></tr></thead><tbody>${st.runs.map((r) => `<tr class="${t.analysisRun === r.run ? 'cur' : ''}">
            <td><b>${esc(fmtDate(r.date))}</b>${t.analysisRun === r.run ? ' <span class="ma-tag">applied</span>' : ''}<br><small>${esc((r.steps || []).join(', '))}</small></td>
            <td>${[r.key && 'Key ' + esc(r.key), r.bpm && Math.round(r.bpm) + ' BPM', r.chords && r.chords.length + ' chord changes', r.sections && r.sections.length + ' sections', ...(r.parts || []).map((p) => esc(PART_LABELS[p.name] || p.name) + ': ' + p.count + ' notes')].filter(Boolean).join(' · ') || '—'}</td>
            <td class="ma-acts"><button type="button" class="mu-primary" data-apply="${esc(r.run)}">Apply…</button><button type="button" data-delrun="${esc(r.run)}" class="danger" title="Delete this run">×</button></td></tr>`).join('')}</tbody></table>` : '<div class="mu-empty">No analysis yet for this track.</div>'}
          <h5>Stems</h5>
          ${st.stems.length ? `<div class="ma-stems">${st.stems.map((s) => `<a href="${U.rawUrl(s.path)}" download="${esc(t.title + ' - ' + s.name)}.mp3">⇩ ${esc(s.name)}</a>`).join('')}<span class="mu-sp"></span><button type="button" data-delstems class="danger">Delete stems</button></div>` : '<div class="mu-empty">None — run “Separate stems”.</div>'}
          <div class="mu-modal-acts"><span class="mu-hint">${esc(st.dir)}</span><span class="mu-sp"></span>${engine.readOnly ? '' : '<button type="button" data-new>New analysis…</button>'}</div>`;
        m.qa('[data-apply]').forEach((b) => b.addEventListener('click', () => { m.close(); this.applyDialog(engine, t, b.dataset.apply); }));
        m.qa('[data-delrun]').forEach((b) => b.addEventListener('click', async () => {
          if (!(await global.uiConfirm('Delete this analysis run? Values already applied to the track stay.', { title: 'Delete run', okLabel: 'Delete', danger: true }))) return;
          await api('/api/music/analysis/delete', { media: t.media, run: b.dataset.delrun }).catch((e) => global.uiAlert(e.message));
          draw();
        }));
        const ds = m.q('[data-delstems]');
        if (ds) ds.addEventListener('click', async () => {
          if (!(await global.uiConfirm('Delete the separated stems for this track (they can be made again)?', { title: 'Delete stems', okLabel: 'Delete', danger: true }))) return;
          await api('/api/music/analysis/delete', { media: t.media, stems: true }).catch((e) => global.uiAlert(e.message));
          t.stems.on = false;
          engine._changed(false);
          if (engine.inst) engine.inst.loadStems(true);
          draw();
        });
        const nb = m.q('[data-new]');
        if (nb) nb.addEventListener('click', () => { m.close(); this.analyzeDialog(engine, [t]); });
      };
      draw();
    },

    async applyDialog(engine, t, runId) {
      let r;
      try { r = await api('/api/music/analysis/run?media=' + encodeURIComponent(t.media) + '&run=' + encodeURIComponent(runId)); } catch (e) { global.uiAlert('Could not read the analysis: ' + e.message); return; }
      const parts = Object.keys(r.notes || {}).sort((a, b) => Object.keys(PART_LABELS).indexOf(a) - Object.keys(PART_LABELS).indexOf(b));
      const has = (k) => r[k] != null && !(Array.isArray(r[k]) && !r[k].length);
      const row = (k, label, val, on) => `<label class="ma-apply"><input type="checkbox" data-ap="${k}"${on ? ' checked' : ''}> <b>${label}</b> <span>${val}</span></label>`;
      const m = modal('Apply analysis — ' + t.title, `
        <p class="mu-hint">${esc(fmtDate(r.date))}. Applied values replace the track's current ones (you can edit them afterwards; the run itself stays unchanged).</p>
        ${has('key') ? row('key', 'Key', esc(r.key) + (t.key && t.key !== r.key ? ' <small>(now ' + esc(t.key) + ')</small>' : ''), true) : ''}
        ${has('bpm') ? row('bpm', 'Tempo', Math.round(r.bpm) + ' BPM · beat grid' + (t.bpm ? ' <small>(now ' + t.bpm + ')</small>' : ''), true) : ''}
        ${has('chords') ? row('chords', 'Chords', r.chords.length + ' changes' + (t.chords.length ? ' <small>(replaces ' + t.chords.length + ')</small>' : '') + ' · <label class="ma-inline"><input type="checkbox" data-simplify> simplify (Am7 → Am)</label>', true) : ''}
        ${has('sections') ? row('sections', 'Sections', r.sections.map((s) => esc(s.name)).join(', ') + (t.sectionsTimeline.length ? ' <small>(replaces ' + t.sectionsTimeline.length + ')</small>' : ''), !t.sectionsTimeline.length) : ''}
        ${parts.length ? `<label class="ma-apply"><input type="checkbox" data-ap="notes" checked> <b>Notes</b> <select data-part>${parts.map((p) => `<option value="${p}">${esc(PART_LABELS[p] || p)} (${r.notes[p].length})</option>`).join('')}</select>${t.noteEvents.length ? ' <small>(replaces ' + t.noteEvents.length + ')</small>' : ''}</label>` : ''}
        ${(r.stems || []).length ? row('stems', 'Stems mixer', r.stems.join(', '), true) : ''}
        <div class="mu-modal-acts"><span class="mu-sp"></span><button type="button" data-x>Cancel</button><button type="button" class="mu-primary" data-ok>Apply</button></div>`);
      m.q('[data-ok]').addEventListener('click', () => {
        const on = (k) => { const x = m.q('[data-ap="' + k + '"]'); return !!(x && x.checked); };
        if (on('key')) t.key = r.key;
        if (on('bpm')) { t.bpm = Math.round(r.bpm); t.beatOffset = r.beats && r.beats.length ? r.beats[0] : 0; if (!t.timeSig) t.timeSig = r.timeSig || '4/4'; }
        if (on('chords')) {
          const simp = m.q('[data-simplify]') && m.q('[data-simplify]').checked;
          let last = '';
          t.chords = r.chords.map((c) => ({ id: 'c_' + Math.random().toString(36).slice(2, 9), t: c.t, name: simp ? simplifyChord(c.name) : c.name })).filter((c) => { const keep = c.name !== last; last = c.name; return keep; });
        }
        if (on('sections')) t.sectionsTimeline = r.sections.map((s) => ({ id: 'r_' + Math.random().toString(36).slice(2, 9), name: s.name, a: s.a, b: s.b }));
        if (on('notes')) { const p = m.q('[data-part]').value; t.noteEvents = (r.notes[p] || []).slice(0, 20000); t.notesOffset = 0; }
        if (on('stems')) t.stems.on = true;
        t.analysis = r.analysis || ('/' + String(t.media).replace(/^\/+/, '').replace(/\.[^./]+$/, '') + '.analysis');
        t.analysisRun = r.run;
        m.close();
        Jobs.items.forEach((it, id) => { if (it.job.result && it.job.result.run === r.run && it.job.result.media === t.media) Jobs.items.delete(id); });
        Jobs.draw();
        engine._changed();
        if (engine.inst) engine.inst.loadStems(true);
        status('Applied the analysis to “' + t.title + '”');
      });
    },
  };

  function simplifyChord(name) {
    const m = /^([A-G][#b]?)(.*?)(?:\/.*)?$/.exec(String(name || ''));
    if (!m) return name;
    const q = m[2];
    if (/^dim/.test(q)) return m[1] + 'dim';
    if (/^aug/.test(q)) return m[1] + 'aug';
    if (/^m(?!aj)/.test(q)) return m[1] + 'm';
    return m[1];
  }

  // ---------- exports ----------
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]+/g, '-');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const visibleNotes = (t) => t.noteEvents.filter((n) => n.c == null || n.c >= (t.minConf || 0));

  function midiBytes(t) {
    const bpm = t.bpm || 120;
    const tpq = 480;
    const tk = (sec) => Math.max(0, Math.round((sec + (t.notesOffset || 0)) * bpm / 60 * tpq));
    const ev = [];
    visibleNotes(t).forEach((n) => {
      const vel = Math.max(1, Math.min(127, Math.round((n.v == null ? 0.7 : n.v) * 127)));
      ev.push({ at: tk(n.t), b: [0x90, n.p, vel], o: 1 });
      ev.push({ at: tk(n.t + n.d), b: [0x80, n.p, 0], o: 0 });
    });
    const enc = (s) => Array.from(new TextEncoder().encode(s));
    t.chords.forEach((c) => { const txt = enc(c.name); ev.push({ at: tk(c.t - (t.notesOffset || 0)), b: [0xff, 0x06, txt.length].concat(txt), o: 2 }); });
    ev.sort((a, b) => a.at - b.at || a.o - b.o);
    const vlq = (n) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
    const us = Math.round(60000000 / bpm);
    const name = enc(t.title || 'Track');
    let data = [0, 0xff, 0x03, name.length].concat(name, [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
    const [num, den] = String(t.timeSig || '4/4').split('/').map(Number);
    data = data.concat([0, 0xff, 0x58, 4, num || 4, Math.round(Math.log2(den || 4)), 24, 8]);
    let last = 0;
    ev.forEach((e) => { data = data.concat(vlq(e.at - last), e.b); last = e.at; });
    data = data.concat([0, 0xff, 0x2f, 0]);
    const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, tpq >> 8, tpq & 255];
    const len = data.length;
    return new Uint8Array(head.concat([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255], data));
  }

  // Notes quantised to 16ths in 4/4-style bars: [{ start, len, pitches[] }].
  function quantise(t, unitsPerBar) {
    const bpm = t.bpm || 120;
    const q = 60 / bpm / 4;
    const off = (t.beatOffset || 0) - (t.notesOffset || 0);
    const groups = new Map();
    visibleNotes(t).forEach((n) => {
      const s = Math.max(0, Math.round((n.t - off) / q));
      const l = Math.max(1, Math.round(n.d / q));
      const g = groups.get(s) || { start: s, len: l, pitches: [] };
      g.len = Math.max(g.len, l);
      if (!g.pitches.includes(n.p)) g.pitches.push(n.p);
      groups.set(s, g);
    });
    const list = [...groups.values()].sort((a, b) => a.start - b.start);
    list.forEach((g, i) => { if (list[i + 1]) g.len = Math.max(1, Math.min(g.len, list[i + 1].start - g.start)); g.pitches.sort((a, b) => a - b); });
    return { list, q, off, unitsPerBar };
  }

  const STEP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const DURS = [[16, 'whole', 0], [12, 'half', 1], [8, 'half', 0], [6, 'quarter', 1], [4, 'quarter', 0], [3, 'eighth', 1], [2, 'eighth', 0], [1, '16th', 0]];
  const pieces = (u) => { const out = []; while (u > 0) { const d = DURS.find((x) => x[0] <= u); out.push(d); u -= d[0]; } return out; };

  function musicXml(t) {
    const { list } = quantise(t, 16);
    const [num, den] = String(t.timeSig || '4/4').split('/').map(Number);
    const bar = Math.round(16 * (num || 4) / (den || 4));
    const key = T.parseKey(t.key);
    const fifths = key ? ({ 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 })[(key.root + (key.minor ? 3 : 0)) % 12] : 0;
    // Flatten to a timeline of events (notes / rests) split at bar lines.
    const evs = [];
    let at = 0;
    list.forEach((g) => { if (g.start > at) evs.push({ start: at, len: g.start - at, pitches: [] }); evs.push(g); at = g.start + g.len; });
    const total = Math.max(bar, Math.ceil(at / bar) * bar);
    if (at < total) evs.push({ start: at, len: total - at, pitches: [] });
    const measures = [];
    evs.forEach((e) => {
      let s = e.start;
      let left = e.len;
      let first = true;
      while (left > 0) {
        const mi = Math.floor(s / bar);
        const room = (mi + 1) * bar - s;
        const len = Math.min(left, room);
        (measures[mi] = measures[mi] || []).push({ len, pitches: e.pitches, tieStart: left > len, tieStop: !first });
        s += len; left -= len; first = false;
      }
    });
    const chordAt = (mi) => t.chords.filter((c) => { const u = Math.round((c.t - (t.beatOffset || 0)) / (60 / (t.bpm || 120) / 4)); return u >= mi * bar && u < (mi + 1) * bar; }).map((c) => c.name);
    const noteXml = (p, d, rest, chord, tieS, tieE) => `<note>${chord ? '<chord/>' : ''}${rest ? '<rest/>' : `<pitch><step>${STEP[p % 12]}</step>${ALTER[p % 12] ? '<alter>1</alter>' : ''}<octave>${Math.floor(p / 12) - 1}</octave></pitch>`}<duration>${d[0]}</duration>${tieE ? '<tie type="stop"/>' : ''}${tieS ? '<tie type="start"/>' : ''}<voice>1</voice><type>${d[1]}</type>${d[2] ? '<dot/>' : ''}${tieS || tieE ? `<notations>${tieE ? '<tied type="stop"/>' : ''}${tieS ? '<tied type="start"/>' : ''}</notations>` : ''}</note>`;
    const body = measures.map((ms, mi) => {
      let x = `<measure number="${mi + 1}">`;
      if (mi === 0) x += `<attributes><divisions>4</divisions><key><fifths>${fifths || 0}</fifths>${key && key.minor ? '<mode>minor</mode>' : ''}</key><time><beats>${num || 4}</beats><beat-type>${den || 4}</beat-type></time><clef><sign>G</sign><line>2</line>${t.noteEvents.length && Math.max(...t.noteEvents.map((n) => n.p)) < 60 ? '<clef-octave-change>-1</clef-octave-change>' : ''}</clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(t.bpm || 120)}</per-minute></metronome></direction-type><sound tempo="${Math.round(t.bpm || 120)}"/></direction>`;
      const ch = chordAt(mi);
      if (ch.length) x += `<direction placement="above"><direction-type><words>${esc(ch.join('  '))}</words></direction-type></direction>`;
      (ms || []).forEach((e) => {
        const ps = pieces(e.len);
        ps.forEach((d, k) => {
          const tieS = (k < ps.length - 1) || e.tieStart;
          const tieE = (k > 0) || e.tieStop;
          if (!e.pitches.length) x += noteXml(0, d, true, false, false, false);
          else e.pitches.forEach((p, j) => { x += noteXml(p, d, false, j > 0, tieS, tieE); });
        });
      });
      return x + '</measure>';
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(t.title)}</work-title></work><identification>${t.artist ? `<creator type="composer">${esc(t.artist)}</creator>` : ''}<encoding><software>Accretion</software></encoding></identification>
<part-list><score-part id="P1"><part-name>${esc(t.title)}</part-name></score-part></part-list>
<part id="P1">
${body}
</part></score-partwise>
`;
  }

  // Plain text tab: one column per 16th, bars of 16, 4 bars per line.
  function textTab(t, instrument) {
    const kind = instrument.kind === 'piano' ? 'guitar' : instrument.kind;
    const tuning = T.tuningNotes(kind, t.tuning || instrument.tuning);
    const capo = t.capo || instrument.capo || 0;
    const { list } = quantise(t, 16);
    const flat = [];
    list.forEach((g) => g.pitches.forEach((p) => flat.push({ g, p })));
    const pos = T.positionsFor(flat.map((x) => x.p), tuning, { capo, maxFret: instrument.frets || 15 });
    const cols = new Map();
    flat.forEach((x, i) => { const ps = pos[i]; if (!ps) return; const c = cols.get(x.g.start) || {}; if (c[ps.s] == null) c[ps.s] = ps.f - capo; cols.set(x.g.start, c); });
    const lastCol = list.length ? list[list.length - 1].start + 1 : 16;
    const bars = Math.max(1, Math.ceil(lastCol / 16));
    const n = tuning.length;
    const names = tuning.map((m) => T.noteName(m).padEnd(2));
    const lines = [`${t.title}${t.artist ? ' — ' + t.artist : ''}`, `Tuning: ${T.tuningLabel(kind, t.tuning || instrument.tuning)}${capo ? ' · Capo ' + capo + ' (frets relative to the capo)' : ''}${t.bpm ? ' · ' + t.bpm + ' BPM' : ''}`, ''];
    const unmatched = flat.length - pos.filter(Boolean).length;
    for (let b0 = 0; b0 < bars; b0 += 4) {
      const rows = Array.from({ length: n }, (_, s) => names[s] + '|');
      let chordRow = '   ';
      for (let b = b0; b < Math.min(bars, b0 + 4); b++) {
        for (let u = b * 16; u < b * 16 + 16; u++) {
          const c = cols.get(u) || {};
          const w = Math.max(2, ...Object.values(c).map((f) => String(f).length + 1));
          for (let s = 0; s < n; s++) rows[s] += (c[s] != null ? String(c[s]) : '').padEnd(w, '-');
          const ch = t.chords.find((x) => Math.round((x.t - (t.beatOffset || 0)) / (60 / (t.bpm || 120) / 4)) === u);
          chordRow += (ch ? ch.name : '').padEnd(w).slice(0, w);
        }
        for (let s = 0; s < n; s++) rows[s] += '|';
        chordRow += ' ';
      }
      if (chordRow.trim()) lines.push(chordRow.replace(/\s+$/, ''));
      for (let s = n - 1; s >= 0; s--) lines.push(rows[s]);
      lines.push('');
    }
    if (unmatched) lines.push(`(${unmatched} notes are out of range for this instrument and were left out)`);
    return lines.join('\n');
  }

  function chordSheetText(t, instrument) {
    const secs = t.sectionsTimeline.slice().sort((a, b) => a.a - b.a);
    const blocks = [];
    let at = 0;
    secs.forEach((s) => { if (s.a > at) blocks.push({ name: '', a: at, b: s.a }); blocks.push(s); at = Math.max(at, s.b); });
    blocks.push({ name: '', a: at, b: Infinity });
    const capo = t.capo || instrument.capo || 0;
    const out = [t.title + (t.artist ? ' — ' + t.artist : ''), [t.key && 'Key ' + t.key, capo && 'Capo ' + capo, t.bpm && t.bpm + ' BPM'].filter(Boolean).join(' · '), ''];
    blocks.forEach((s) => {
      const ch = t.chords.filter((c) => c.t >= s.a && c.t < s.b).map((c) => c.name);
      if (!ch.length) return;
      if (s.name) out.push('[' + s.name + ']');
      for (let i = 0; i < ch.length; i += 8) out.push(ch.slice(i, i + 8).map((c) => c.padEnd(7)).join(' ').trimEnd());
      out.push('');
    });
    if (t.lyrics) out.push('Lyrics', '', t.lyrics);
    return out.join('\n');
  }

  const Export = {
    midi(t) { if (!t.noteEvents.length && !t.chords.length) return global.uiAlert('This track has no notes or chords to export.'); download(t.title + '.mid', new Blob([midiBytes(t)], { type: 'audio/midi' })); },
    musicxml(t) { if (!t.noteEvents.length) return global.uiAlert('This track has no notes to export.'); download(t.title + '.musicxml', musicXml(t), 'application/vnd.recordare.musicxml+xml'); },
    tab(t, inst) { if (!t.noteEvents.length) return global.uiAlert('This track has no notes to export.'); download(t.title + ' (tab).txt', textTab(t, inst)); },
    chords(t, inst) { if (!t.chords.length) return global.uiAlert('This track has no chords to export.'); download(t.title + ' (chords).txt', chordSheetText(t, inst)); },
    _midiBytes: midiBytes,
    _musicXml: musicXml,
    _textTab: textTab,
    _chordSheet: chordSheetText,
  };

  Analysis.Jobs = Jobs;
  Analysis.Export = Export;
  Analysis.simplifyChord = simplifyChord;
  Analysis.api = api;
  global.MusicAnalysis = Analysis;
})(typeof window !== 'undefined' ? window : this);
