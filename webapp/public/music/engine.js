/* DocViewer music engine — Music collections (phase 1): library of audio and
 * video tracks in sections, import into assets/media/music, track details,
 * search and filters, menus, and a simple player. Board API like the others:
 * loadFromHtml / serializeToHtml / destroy / setReadOnly. */
(function (global) {
  const C = global.MusicCore;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rawUrl = (media) => '/api/raw?path=' + encodeURIComponent(String(media || '').replace(/^\/+/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/'));
  const relOf = (media) => String(media || '').replace(/^\/+/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
  const linkOf = (rel) => '/' + String(rel).split('/').map((s) => encodeURIComponent(s).replace(/%2E/g, '.')).join('/');
  const STATUS_LABEL = Object.fromEntries(C.STATUSES.map((s) => [s.id, s.label]));

  class MusicEngine {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = opts || {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.normalize({});
      this.query = '';
      this.root = document.createElement('div');
      this.root.className = 'mu-root';
      stage.innerHTML = '';
      stage.appendChild(this.root);
      this._onDocDown = (e) => { if (this._menu && !this._menu.contains(e.target)) this._closeMenu(); };
      document.addEventListener('pointerdown', this._onDocDown, true);
      this._onKey = (e) => this._key(e);
      document.addEventListener('keydown', this._onKey);
      if (global.MusicAnalysis) global.MusicAnalysis.attach(this);
    }

    // ---------- board API ----------
    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.normalize({});
      this.render();
    }
    serializeToHtml() { return C.serializeToHtml(this.data); }
    setReadOnly(on) { this.readOnly = !!on; this.render(); }
    flushEdit() {}
    collapseAll() { this.data.sections.forEach((s) => { s.collapsed = true; }); this._changed(); }
    expandAll() { this.data.sections.forEach((s) => { s.collapsed = false; }); this._changed(); }
    destroy() {
      this._closeMenu();
      document.removeEventListener('pointerdown', this._onDocDown, true);
      document.removeEventListener('keydown', this._onKey);
      if (global.MusicAnalysis) global.MusicAnalysis.detach(this);
      if (this.inst) { this.inst.destroy(); cancelAnimationFrame(this._instRaf); this.inst = null; }
      if (this.player) {
        if (this.player.isPlaying() && global.MusicMini) {
          this.player.destroy(true);
          global.MusicMini.adopt(this.player, { path: this.opts.getPath && this.opts.getPath() });
        } else this.player.destroy();
        this.player = null;
      }
      this.stage.innerHTML = '';
    }

    _changed(rerender) {
      if (this.opts.onChange) this.opts.onChange();
      if (rerender !== false) this.render();
    }

    // ---------- helpers ----------
    _track(id) { return this.data.tracks.find((t) => t.id === id) || null; }
    _selected() { return this._track(this.data.view.selected); }
    _visible(t) {
      const v = this.data.view;
      if (v.filter && t.status !== v.filter) return false;
      if (v.kindFilter && t.kind !== v.kindFilter) return false;
      const q = this.query.trim().toLowerCase();
      if (!q) return true;
      const hay = [t.title, t.artist, t.album, t.key, t.tags.join(' '), t.notes, t.lyrics, relOf(t.media)].join(' ').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    }

    // ---------- render ----------
    render() {
      const keep = this.player && this.player.el;
      if (keep && keep.parentNode) keep.parentNode.removeChild(keep);
      const d = this.data;
      const sel = this._selected();
      const ro = this.readOnly;
      const chip = (val, label, cur, attr) => `<button type="button" class="mu-chip${cur === val ? ' on' : ''}" ${attr}="${val}">${label}</button>`;
      const counts = (sid) => d.tracks.filter((t) => t.sectionId === sid);
      this.root.innerHTML = `
        <div class="mu-bar">
          <input class="mu-title" data-title value="${esc(d.title)}" ${ro ? 'readonly' : ''} spellcheck="false" title="Collection name"/>
          <span class="mu-count">${d.tracks.length} track${d.tracks.length === 1 ? '' : 's'}</span>
          <span class="mu-sep"></span>
          ${ro ? '' : '<button type="button" class="mu-menu-btn" data-menu="file">File ▾</button><button type="button" class="mu-menu-btn" data-menu="add">Add ▾</button><button type="button" class="mu-menu-btn" data-menu="analyze">Analyze ▾</button>'}
          <button type="button" class="mu-menu-btn" data-menu="export">Export ▾</button>
          <button type="button" class="mu-menu-btn" data-menu="instrument">${esc((C.INSTRUMENTS.find((i) => i.id === d.instrument.kind) || {}).label || 'Guitar')}${d.instrument.capo ? ' · Capo ' + d.instrument.capo : ''} ▾</button>
          <span class="mu-sp"></span>
          <input class="mu-search" data-search type="search" placeholder="Search title, artist, key, tag, lyrics…" value="${esc(this.query)}" spellcheck="false"/>
        </div>
        <div class="mu-filters">
          ${chip('', 'All', d.view.filter, 'data-filter')}${C.STATUSES.map((s) => chip(s.id, s.label, d.view.filter, 'data-filter')).join('')}
          <span class="mu-sep"></span>
          ${chip('', 'Audio + video', d.view.kindFilter, 'data-kind')}${chip('audio', '🎵 Audio', d.view.kindFilter, 'data-kind')}${chip('video', '🎬 Video', d.view.kindFilter, 'data-kind')}
        </div>
        <div class="mu-body">
          <div class="mu-lib" data-lib>
            ${d.sections.map((s) => {
              const all = counts(s.id);
              const shown = all.filter((t) => this._visible(t));
              return `<div class="mu-sec" data-sec="${esc(s.id)}">
                <div class="mu-sec-head" data-sec-head="${esc(s.id)}">
                  <button type="button" class="mu-twisty" data-toggle-sec="${esc(s.id)}">${s.collapsed ? '▸' : '▾'}</button>
                  <span class="mu-sec-name">${esc(s.name)}</span><span class="mu-sec-n">${shown.length}${shown.length !== all.length ? '/' + all.length : ''}</span>
                  ${ro ? '' : `<button type="button" class="mu-dots" data-sec-menu="${esc(s.id)}" title="Section actions">⋯</button>`}
                </div>
                ${s.collapsed ? '' : `<div class="mu-tracks" data-drop-sec="${esc(s.id)}">${shown.map((t) => `
                  <div class="mu-trk${sel && sel.id === t.id ? ' on' : ''}" data-trk="${esc(t.id)}" draggable="${ro ? 'false' : 'true'}" title="${esc(relOf(t.media))}">
                    <span class="mu-thumb ${t.kind}">${t.kind === 'video' ? '🎬' : '🎵'}</span>
                    <span class="mu-trk-main"><b>${esc(t.title)}</b><small>${esc([t.artist, t.duration ? C.fmtTime(t.duration) : ''].filter(Boolean).join(' · ') || relOf(t.media).split('/').pop())}</small></span>
                    <span class="mu-trk-side">${t.key ? `<i>${esc(t.key)}</i>` : ''}<span class="mu-st st-${t.status}">${esc(STATUS_LABEL[t.status])}</span></span>
                  </div>`).join('') || `<div class="mu-empty">${all.length ? 'No matches' : (ro ? 'Empty' : 'Drop audio or video files here')}</div>`}</div>`}
              </div>`;
            }).join('')}
            ${ro ? '' : '<button type="button" class="mu-add-sec" data-add-sec>＋ New section</button>'}
          </div>
          <div class="mu-main">${sel ? this._trackPane(sel) : this._emptyPane()}</div>
        </div>
        <input type="file" data-file accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.aiff,.aif,.mp4,.m4v,.mov,.webm" multiple hidden>`;
      this._mountPlayer(sel);
      this._bind();
    }

    // One player per selected track; kept across re-renders (details edits),
    // replaced when another track is selected.
    _mountPlayer(sel) {
      const slot = this.root.querySelector('[data-player-slot]');
      if (!sel || !slot) {
        if (this.player) { this.player.destroy(); this.player = null; }
        return;
      }
      if (this.player && this.player.t === sel) { slot.replaceWith(this.player.el); if (this.inst) this.inst.render(); return; }
      if (this.inst) { this.inst.destroy(); this.inst = null; }
      if (this.player) this.player.destroy();
      const P = global.MusicPlayer;
      this.player = new P(sel, {
        readOnly: this.readOnly,
        onChange: () => this._changed(false),
        onDuration: (d) => {
          const dd = Math.round(d * 10) / 10;
          if (Number.isFinite(dd) && dd > 0 && Math.abs((sel.duration || 0) - dd) > 0.5 && !this.readOnly) { sel.duration = dd; this._changed(false); this._refreshRow(sel); }
        },
        onPlay: () => { if (!this.readOnly) { sel.lastPlayed = new Date().toISOString(); this._changed(false); } },
      });
      slot.replaceWith(this.player.el);
      this._mountInstrument();
      // Coming back from the mini-player: continue where it was.
      const back = global.MusicMini && global.MusicMini.take(sel);
      if (back) { const m = this.player.media; m.currentTime = back.time; if (back.playing) m.play().catch(() => {}); }
      requestAnimationFrame(() => this.player && this.player.drawWave());
    }

    // Instrument panel (fretboard, chords, tools) under the player.
    _mountInstrument() {
      if (this.inst) { this.inst.destroy(); cancelAnimationFrame(this._instRaf); this.inst = null; }
      if (!this.player || !global.MusicInstrument) return;
      const player = this.player;
      const inst = new global.MusicInstrument(player, this.data, { readOnly: this.readOnly, engine: this, onChange: () => this._changed(false) });
      this.inst = inst;
      player.el.appendChild(inst.el);
      const m = player.media;
      m.addEventListener('seeked', () => inst.tick(m.currentTime));
      const loop = () => { if (this.inst !== inst || this.player !== player) return; if (!m.paused) inst.tick(m.currentTime); this._instRaf = requestAnimationFrame(loop); };
      this._instRaf = requestAnimationFrame(loop);
    }

    // Deep link from openFileAt: "track=<id>&loop=<id|name>&t=<sec>&play=1"
    openRef(ref) {
      const params = new URLSearchParams(String(ref || ''));
      const id = params.get('track');
      const t = id && (this._track(id) || this.data.tracks.find((x) => x.title.toLowerCase() === id.toLowerCase()));
      if (!t) return;
      this.data.view.selected = t.id;
      this.render();
      if (this.player) {
        this.player.openRef(params);
        if (params.get('play') === '1') this.player.media.play().catch(() => {});
      }
    }

    _emptyPane() {
      const n = this.data.tracks.length;
      return `<div class="mu-welcome"><div class="mu-big">🎸</div>
        <h2>${n ? 'Pick a track' : 'Add your first track'}</h2>
        <p>${n ? 'Choose a track in the library to play it and edit its details.' : 'Import audio (MP3, WAV, M4A, FLAC…) or video (MP4, MOV, WebM). Files are stored in <code>assets/media/music/</code>; this collection keeps the list.'}</p>
        ${this.readOnly ? '' : '<div class="mu-welcome-acts"><button type="button" class="mu-primary" data-act="add-files">＋ Add audio / video files</button><button type="button" data-act="add-ws">From workspace…</button></div><p class="mu-hint">Tip: drop files anywhere on the library.</p>'}
      </div>`;
    }

    _trackPane(t) {
      const ro = this.readOnly ? 'readonly' : '';
      const dis = this.readOnly ? 'disabled' : '';
      const statusOpts = C.STATUSES.map((s) => `<option value="${s.id}"${t.status === s.id ? ' selected' : ''}>${s.label}</option>`).join('');
      const stars = (field, val) => `<span class="mu-stars" data-stars="${field}">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" class="${i <= val ? 'on' : ''}" ${dis}>${field === 'rating' ? '★' : '●'}</button>`).join('')}</span>`;
      return `
        <div class="mu-now">
          <div class="mu-now-head"><span class="mu-thumb big ${t.kind}">${t.kind === 'video' ? '🎬' : '🎵'}</span>
            <div><h2>${esc(t.title)}</h2><div class="mu-now-meta">${esc([t.artist, t.album, t.year].filter(Boolean).join(' · ') || 'Unknown artist')}${t.duration ? ' · ' + C.fmtTime(t.duration) : ''}${t.key ? ` · <b>${esc(t.key)}</b>` : ''}${t.bpm ? ' · ' + t.bpm + ' BPM' : ''}${t.capo ? ' · Capo ' + t.capo : ''}</div></div>
            <span class="mu-sp"></span>
            <button type="button" class="mu-dots" data-trk-menu="${esc(t.id)}" title="Track actions">⋯</button>
          </div>
          <div data-player-slot></div>
        </div>
        <div class="mu-details">
          <h3>Details</h3>
          <div class="mu-grid">
            <label>Title<input data-f="title" value="${esc(t.title)}" ${ro}></label>
            <label>Artist<input data-f="artist" value="${esc(t.artist)}" ${ro}></label>
            <label>Album<input data-f="album" value="${esc(t.album)}" ${ro}></label>
            <label>Year<input data-f="year" type="number" value="${t.year == null ? '' : t.year}" ${ro}></label>
            <label>Status<select data-f="status" ${dis}>${statusOpts}</select></label>
            <label>Section<select data-f="sectionId" ${dis}>${this.data.sections.map((s) => `<option value="${esc(s.id)}"${s.id === t.sectionId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
            <label>Key<input data-f="key" value="${esc(t.key)}" placeholder="e.g. F#m" ${ro}></label>
            <label>Tempo (BPM)<input data-f="bpm" type="number" value="${t.bpm == null ? '' : t.bpm}" ${ro}></label>
            <label>Time signature<input data-f="timeSig" value="${esc(t.timeSig)}" placeholder="4/4" ${ro}></label>
            <label>Capo<input data-f="capo" type="number" min="0" max="12" value="${t.capo || 0}" ${ro}></label>
            <label>Tuning<input data-f="tuning" value="${esc(t.tuning)}" placeholder="${esc(this.data.instrument.tuning)}" ${ro}></label>
            <label>Tags<input data-f="tags" value="${esc(t.tags.join(', '))}" placeholder="comma separated" ${ro}></label>
            <label>Difficulty${stars('difficulty', t.difficulty)}</label>
            <label>Rating${stars('rating', t.rating)}</label>
            <label class="wide">Source / link<input data-f="source" value="${esc(t.source)}" placeholder="where it came from (optional)" ${ro}></label>
            <label class="wide">Notes<textarea data-f="notes" rows="3" ${ro}>${esc(t.notes)}</textarea></label>
            <label class="wide">Lyrics<textarea data-f="lyrics" rows="5" ${ro}>${esc(t.lyrics)}</textarea></label>
          </div>
          <div class="mu-file">File: <a href="#" data-open-media>${esc(relOf(t.media))}</a> · added ${esc(new Date(t.added).toLocaleDateString())}${t.lastPlayed ? ' · last played ' + esc(new Date(t.lastPlayed).toLocaleDateString()) : ''}</div>
        </div>`;
    }

    // ---------- events ----------
    _bind() {
      const R = this.root;
      const q = (s) => R.querySelector(s);
      const title = q('[data-title]');
      title.addEventListener('change', () => { this.data.title = title.value.trim().slice(0, 120) || 'Music'; this._changed(false); });
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
      const search = q('[data-search]');
      search.addEventListener('input', () => { this.query = search.value; const pos = search.selectionStart; this.render(); const s2 = this.root.querySelector('[data-search]'); s2.focus(); s2.setSelectionRange(pos, pos); });
      R.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { this.data.view.filter = b.dataset.filter; this._changed(); }));
      R.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { this.data.view.kindFilter = b.dataset.kind; this._changed(); }));
      R.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this._openBarMenu(b.dataset.menu, b); }));
      R.querySelectorAll('[data-toggle-sec]').forEach((b) => b.addEventListener('click', () => {
        const s = this.data.sections.find((x) => x.id === b.dataset.toggleSec);
        if (s) { s.collapsed = !s.collapsed; this._changed(); }
      }));
      R.querySelectorAll('[data-sec-menu]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this._openSectionMenu(b.dataset.secMenu, b); }));
      R.querySelectorAll('[data-trk]').forEach((row) => {
        row.addEventListener('click', () => this._select(row.dataset.trk));
        row.addEventListener('dblclick', () => { this._select(row.dataset.trk); if (this.player) this.player.media.play().catch(() => {}); });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); this._openTrackMenu(row.dataset.trk, e.clientX, e.clientY); });
        row.addEventListener('dragstart', (e) => { this._dragId = row.dataset.trk; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/x-mu-track', row.dataset.trk); } catch (err) { /* ignore */ } row.classList.add('dragging'); });
        row.addEventListener('dragend', () => { this._dragId = null; row.classList.remove('dragging'); });
      });
      const addSec = q('[data-add-sec]');
      if (addSec) addSec.addEventListener('click', () => this._newSection());
      R.querySelectorAll('[data-act="add-files"]').forEach((b) => b.addEventListener('click', () => q('[data-file]').click()));
      R.querySelectorAll('[data-act="add-ws"]').forEach((b) => b.addEventListener('click', () => this._addFromWorkspace()));
      q('[data-file]').addEventListener('change', (e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) this._importFiles(files); });
      // Drag & drop: reorder / move tracks between sections; drop files to import.
      const lib = q('[data-lib]');
      lib.addEventListener('dragover', (e) => {
        const files = e.dataTransfer && [...e.dataTransfer.types].includes('Files');
        if (!files && !this._dragId) return;
        e.preventDefault();
        lib.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into'));
        const row = e.target.closest('[data-trk]');
        const sec = e.target.closest('[data-sec]');
        if (row && this._dragId) row.classList.add('drop-before');
        else if (sec) sec.classList.add('drop-into');
      });
      lib.addEventListener('dragleave', (e) => { if (!lib.contains(e.relatedTarget)) lib.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into')); });
      lib.addEventListener('drop', (e) => {
        e.preventDefault();
        lib.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into'));
        const sec = e.target.closest('[data-sec]');
        const secId = sec ? sec.dataset.sec : this.data.sections[0].id;
        if (this.readOnly) return;
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
        if (files.length) { this._importFiles(files, secId); return; }
        if (!this._dragId) return;
        const t = this._track(this._dragId);
        const row = e.target.closest('[data-trk]');
        if (!t || (row && row.dataset.trk === t.id)) return;
        const list = this.data.tracks.filter((x) => x.id !== t.id);
        t.sectionId = secId;
        let at = row ? list.findIndex((x) => x.id === row.dataset.trk) : -1;
        if (at < 0) { const last = list.map((x) => x.sectionId).lastIndexOf(secId); at = last + 1 || list.length; }
        list.splice(at, 0, t);
        this.data.tracks = list;
        this._changed();
      });
      // Track pane
      const sel = this._selected();
      if (!sel) return;
      R.querySelectorAll('[data-f]').forEach((inp) => {
        const ev = inp.tagName === 'SELECT' ? 'change' : 'change';
        inp.addEventListener(ev, () => {
          if (this.readOnly) return;
          const f = inp.dataset.f;
          let v = inp.value;
          if (f === 'tags') v = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
          else if (['year', 'bpm', 'capo'].includes(f)) v = v === '' ? null : Number(v);
          else if (f === 'title') v = v.trim() || sel.title;
          sel[f] = v;
          Object.assign(sel, C.normalizeTrack(sel, this.data.sections.map((s) => s.id)));
          const rerender = ['title', 'artist', 'status', 'sectionId', 'key', 'bpm', 'capo', 'album', 'year'].includes(f);
          this._changed(false);
          if (rerender) this.render();
        });
      });
      R.querySelectorAll('[data-stars]').forEach((box) => box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-star]');
        if (!b || this.readOnly) return;
        const f = box.dataset.stars;
        const v = Number(b.dataset.star);
        sel[f] = sel[f] === v ? 0 : v;
        this._changed(false);
        box.querySelectorAll('[data-star]').forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= sel[f]));
      }));
      const tm = q('[data-trk-menu]');
      if (tm) tm.addEventListener('click', (e) => { e.stopPropagation(); const r = tm.getBoundingClientRect(); this._openTrackMenu(sel.id, r.right - 200, r.bottom + 4); });
      const om = q('[data-open-media]');
      if (om) om.addEventListener('click', (e) => { e.preventDefault(); if (typeof global.openFile === 'function') global.openFile(relOf(sel.media)); });
    }

    _refreshRow(t) {
      const row = this.root.querySelector(`[data-trk="${CSS.escape(t.id)}"] small`);
      if (row) row.textContent = [t.artist, t.duration ? C.fmtTime(t.duration) : ''].filter(Boolean).join(' · ') || relOf(t.media).split('/').pop();
    }

    _select(id) {
      if (this.data.view.selected === id) return;
      this.data.view.selected = id;
      this.render();
    }

    _key(e) {
      if (!this.root.isConnected) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey) return;
      if (document.querySelector('.ui-pop-ov, .mu-modal, .topo-overlay')) return;
      if (this.player && this.player.key(e)) { e.preventDefault(); return; }
      if (this.inst && !e.altKey && this.inst.key(e)) { e.preventDefault(); return; }
      if (e.altKey) return;
      if ((e.key === 'n' || e.key === 'p') && this.data.tracks.length) {
        const vis = this.data.sections.flatMap((s) => (s.collapsed ? [] : this.data.tracks.filter((t) => t.sectionId === s.id && this._visible(t))));
        if (!vis.length) return;
        const i = vis.findIndex((t) => t.id === this.data.view.selected);
        const next = vis[(i + (e.key === 'n' ? 1 : -1) + vis.length) % vis.length];
        this._select(next.id);
      }
    }

    // ---------- sections ----------
    async _newSection() {
      const name = await global.uiPrompt('Section name', 'New section', { title: 'New section', okLabel: 'Add' });
      if (name == null || !String(name).trim()) return;
      this.data.sections.push({ id: C.uid('s_'), name: String(name).trim().slice(0, 80), collapsed: false });
      this._changed();
    }

    _openSectionMenu(id, anchor) {
      const s = this.data.sections.find((x) => x.id === id);
      if (!s) return;
      const i = this.data.sections.indexOf(s);
      const r = anchor.getBoundingClientRect();
      this._showMenu(r.left, r.bottom + 4, [
        ['Rename…', async () => { const n = await global.uiPrompt('Section name', s.name, { title: 'Rename section', okLabel: 'Rename' }); if (n != null && String(n).trim()) { s.name = String(n).trim().slice(0, 80); this._changed(); } }],
        ['Add files here…', () => { this._importTarget = s.id; this.root.querySelector('[data-file]').click(); }],
        ['Move up', () => { if (i > 0) { this.data.sections.splice(i, 1); this.data.sections.splice(i - 1, 0, s); this._changed(); } }, i === 0],
        ['Move down', () => { if (i < this.data.sections.length - 1) { this.data.sections.splice(i, 1); this.data.sections.splice(i + 1, 0, s); this._changed(); } }, i === this.data.sections.length - 1],
        ['Sort by title', () => this._sortSection(s.id, 'title')],
        ['Sort by artist', () => this._sortSection(s.id, 'artist')],
        null,
        ['Delete section…', async () => {
          if (this.data.sections.length === 1) { global.uiAlert('A collection needs at least one section.', { title: 'Delete section' }); return; }
          const n = this.data.tracks.filter((t) => t.sectionId === s.id).length;
          const to = this.data.sections.find((x) => x.id !== s.id);
          if (n && !(await global.uiConfirm(`Delete "${s.name}"? Its ${n} track${n === 1 ? '' : 's'} move to "${to.name}". No files are deleted.`, { title: 'Delete section', okLabel: 'Delete', danger: true }))) return;
          this.data.tracks.forEach((t) => { if (t.sectionId === s.id) t.sectionId = to.id; });
          this.data.sections = this.data.sections.filter((x) => x.id !== s.id);
          this._changed();
        }, false, true],
      ]);
    }

    _sortSection(sid, field) {
      const inSec = this.data.tracks.filter((t) => t.sectionId === sid).sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || '')) || a.title.localeCompare(b.title));
      const rest = this.data.tracks.filter((t) => t.sectionId !== sid);
      this.data.tracks = rest.concat(inSec);
      this._changed();
    }

    // ---------- track menu ----------
    _openTrackMenu(id, x, y) {
      const t = this._track(id);
      if (!t) return;
      const ro = this.readOnly;
      const items = [
        ['▶ Play', () => { this._select(id); if (this.player) this.player.media.play().catch(() => {}); }],
        ['Open file', () => { if (typeof global.openFile === 'function') global.openFile(relOf(t.media)); }],
        ['Copy link', () => { const href = linkOf(relOf(t.media)); try { navigator.clipboard.writeText(href); } catch (e) { /* ignore */ } if (global.setStatus) global.setStatus('Copied ' + href, 'ok'); }],
      ];
      if (!ro) {
        items.push(null);
        this.data.sections.filter((s) => s.id !== t.sectionId).forEach((s) => items.push(['Move to "' + s.name + '"', () => { t.sectionId = s.id; this._changed(); }]));
        items.push(null);
        C.STATUSES.forEach((s) => items.push([(t.status === s.id ? '✓ ' : '　') + s.label, () => { t.status = s.id; this._changed(); }]));
        items.push(null);
        items.push(['Duplicate entry', () => { const c = C.normalizeTrack(Object.assign({}, JSON.parse(JSON.stringify(t)), { id: C.uid('t_'), title: t.title + ' (copy)' }), this.data.sections.map((s) => s.id)); this.data.tracks.splice(this.data.tracks.indexOf(t) + 1, 0, c); this._changed(); }]);
        items.push(['Remove from collection', () => { this.data.tracks = this.data.tracks.filter((x) => x.id !== t.id); if (this.data.view.selected === t.id) this.data.view.selected = ''; this._changed(); }]);
        items.push(['Delete file…', async () => {
          const rel = relOf(t.media);
          if (!(await global.uiConfirm(`Delete "${rel}" from the data folder and remove it from this collection? Other collections using it will show it as missing. It stays in version history.`, { title: 'Delete file', okLabel: 'Delete', danger: true }))) return;
          const r = await fetch('/api/file/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rel }) });
          if (!r.ok) { const d = await r.json().catch(() => ({})); global.uiAlert('Could not delete: ' + (d.error || r.status)); return; }
          this.data.tracks = this.data.tracks.filter((x) => x.id !== t.id);
          if (this.data.view.selected === t.id) this.data.view.selected = '';
          this._changed();
          if (typeof global.loadTree === 'function') global.loadTree();
        }, false, true]);
      }
      this._showMenu(x, y, items);
    }

    // ---------- bar menus ----------
    _openBarMenu(which, anchor) {
      const r = anchor.getBoundingClientRect();
      const d = this.data;
      if (which === 'file') {
        this._showMenu(r.left, r.bottom + 4, [
          ['Rename collection…', async () => { const n = await global.uiPrompt('Collection name', d.title, { title: 'Rename collection', okLabel: 'Rename' }); if (n != null && String(n).trim()) { d.title = String(n).trim().slice(0, 120); this._changed(); } }],
          ['New section…', () => this._newSection()],
          null,
          ['Expand all sections', () => this.expandAll()],
          ['Collapse all sections', () => this.collapseAll()],
          null,
          ['Export track list (CSV)', () => this._exportCsv()],
          ['Find missing files', () => this._checkMissing()],
        ]);
      } else if (which === 'add') {
        this._showMenu(r.left, r.bottom + 4, [
          ['Audio / video files…', () => { this._importTarget = null; this.root.querySelector('[data-file]').click(); }],
          ['From workspace…', () => this._addFromWorkspace()],
          ['New section…', () => this._newSection()],
        ]);
      } else if (which === 'analyze') {
        const A = global.MusicAnalysis;
        const sel = this._selected();
        const all = this.data.tracks.filter((t) => t.kind === 'audio' || t.kind === 'video');
        this._showMenu(r.left, r.bottom + 4, [
          ['Analyze track…', () => A.analyzeDialog(this, [sel]), !sel],
          ['Analyze all (' + all.length + ')…', () => A.analyzeDialog(this, all), !all.length],
          null,
          ['Separate stems', () => A.analyzeDialog(this, [sel], ['stems']), !sel],
          ['Extract notes…', () => A.analyzeDialog(this, [sel], ['notes']), !sel],
          ['Re-detect chords', () => A.analyzeDialog(this, [sel], ['tempo', 'key', 'chords']), !sel],
          ['Re-detect tempo & key', () => A.analyzeDialog(this, [sel], ['tempo', 'key']), !sel],
          null,
          ['Analysis versions…', () => A.versionsDialog(this, sel), !sel],
          ['Music analysis add-on…', () => A.addonDialog()],
        ]);
      } else if (which === 'export') {
        const X = global.MusicAnalysis.Export;
        const sel = this._selected();
        const inst = this.data.instrument;
        this._showMenu(r.left, r.bottom + 4, [
          ['MIDI (.mid)', () => X.midi(sel), !sel],
          ['MusicXML (.musicxml)', () => X.musicxml(sel), !sel],
          ['Tab (.txt)', () => X.tab(sel, inst), !sel],
          ['Chord sheet (.txt)', () => X.chords(sel, inst), !sel],
          null,
          ['Stems…', () => global.MusicAnalysis.versionsDialog(this, sel), !sel],
          ['Track list (CSV)', () => this._exportCsv && this._exportCsv()],
        ]);
      } else if (which === 'instrument') {
        const Th = global.MusicTheory;
        const items = C.INSTRUMENTS.map((i) => [(d.instrument.kind === i.id ? '✓ ' : '　') + i.label, () => { d.instrument.kind = i.id; d.instrument.tuning = 'std'; this._changed(); }, this.readOnly]);
        const presets = Th && Th.TUNINGS[d.instrument.kind];
        if (presets && d.instrument.kind !== 'piano') {
          items.push(null);
          presets.forEach((pr) => items.push([(d.instrument.tuning === pr.id ? '✓ ' : '　') + pr.label, () => { d.instrument.tuning = pr.id; this._changed(); }, this.readOnly]));
        }
        items.push(null);
        items.push([(d.instrument.leftHanded ? '✓ ' : '　') + 'Left-handed', () => { d.instrument.leftHanded = !d.instrument.leftHanded; this._changed(); }, this.readOnly]);
        items.push(['Frets shown…', async () => { const v = await global.uiPrompt('Frets to show (5–24)', String(d.instrument.frets || 15), { title: 'Fretboard', okLabel: 'Set' }); if (v != null) { d.instrument.frets = Math.max(5, Math.min(24, Number(v) || 15)); this._changed(); } }, this.readOnly]);
        items.push(['Capo…', async () => { const v = await global.uiPrompt('Capo fret (0 = none)', String(d.instrument.capo || 0), { title: 'Capo', okLabel: 'Set' }); if (v != null) { d.instrument.capo = Math.max(0, Math.min(12, Number(v) || 0)); this._changed(); } }, this.readOnly]);
        items.push(['Tuning…', async () => { const v = await global.uiPrompt('Tuning (low to high, e.g. EADGBE, DADGBE, GCEA)', d.instrument.tuning, { title: 'Tuning', okLabel: 'Set' }); if (v != null && String(v).trim()) { d.instrument.tuning = String(v).trim().slice(0, 24); this._changed(); } }, this.readOnly]);
        this._showMenu(r.left, r.bottom + 4, items);
      }
    }

    _showMenu(x, y, items) {
      this._closeMenu();
      const m = document.createElement('div');
      m.className = 'mu-pop';
      items.forEach((it) => {
        if (!it) { const s = document.createElement('div'); s.className = 'mu-pop-sep'; m.appendChild(s); return; }
        const [label, fn, disabled, danger] = it;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (disabled) b.disabled = true;
        if (danger) b.className = 'danger';
        b.addEventListener('click', () => { this._closeMenu(); fn(); });
        m.appendChild(b);
      });
      document.body.appendChild(m);
      const w = m.offsetWidth;
      const h = m.offsetHeight;
      m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
      m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
      this._menu = m;
    }
    _closeMenu() { if (this._menu) { this._menu.remove(); this._menu = null; } }

    // ---------- import ----------
    async _importFiles(files, sectionId) {
      if (this.readOnly) return;
      const ok = files.filter((f) => C.mediaKind(f.name));
      const skipped = files.length - ok.length;
      if (!ok.length) { global.uiAlert('Only audio and video files can be added (MP3, WAV, M4A, FLAC, OGG, MP4, MOV, WebM…).', { title: 'Add tracks' }); return; }
      const secId = sectionId || this._importTarget || (this._selected() && this._selected().sectionId) || this.data.sections[0].id;
      this._importTarget = null;
      if (global.setStatus) global.setStatus(`Importing ${ok.length} file${ok.length === 1 ? '' : 's'}…`);
      const payload = [];
      for (const f of ok) {
        const content = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
        payload.push({ name: f.name, content, encoding: 'base64' });
      }
      try {
        const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dest: C.MEDIA_DIR, files: payload }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.imported) throw new Error(d.error || 'Import failed');
        const added = d.imported.map((x) => x.path).filter((p) => C.mediaKind(p));
        this._addPaths(added, secId);
        if (typeof global.loadTree === 'function') global.loadTree();
        if (global.setStatus) global.setStatus(`Added ${added.length} track${added.length === 1 ? '' : 's'}${skipped ? ' · ' + skipped + ' non-media file' + (skipped === 1 ? '' : 's') + ' skipped' : ''}`, 'ok');
      } catch (err) {
        global.uiAlert('Could not import: ' + ((err && err.message) || err) + (/large|limit/i.test(String(err)) ? '\n\nVery large files (over ~40 MB) can be copied into assets/media/music/ in Finder, then added with Add → From workspace.' : ''), { title: 'Add tracks' });
      }
    }

    _addPaths(paths, secId) {
      const have = new Set(this.data.tracks.map((t) => relOf(t.media)));
      const ids = this.data.sections.map((s) => s.id);
      let first = null;
      let dup = 0;
      paths.forEach((p) => {
        if (have.has(p)) { dup++; return; }
        const g = C.guessFromName(p);
        const t = C.normalizeTrack({ media: linkOf(p), kind: C.mediaKind(p), title: g.title, artist: g.artist, sectionId: secId }, ids);
        this.data.tracks.push(t);
        have.add(p);
        if (!first) first = t;
        this._probeDuration(t);
      });
      if (first) this.data.view.selected = first.id;
      this._changed();
      if (dup && global.setStatus) global.setStatus(dup + ' file' + (dup === 1 ? ' is' : 's are') + ' already in this collection', 'dirty');
    }

    _probeDuration(t) {
      const el = document.createElement(t.kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && el.duration > 0) { t.duration = Math.round(el.duration * 10) / 10; this._changed(false); this._refreshRow(t); }
        el.removeAttribute('src');
      }, { once: true });
      el.src = rawUrl(t.media);
    }

    async _addFromWorkspace() {
      if (this.readOnly) return;
      let tree;
      try { tree = await (await fetch('/api/tree')).json(); } catch (e) { global.uiAlert('Could not read the workspace.'); return; }
      const all = [];
      (function walk(nodes) { (nodes || []).forEach((n) => { if (n.type === 'dir' || n.children) walk(n.children); else if (n.path && C.mediaKind(n.path)) all.push(n.path); }); })(Array.isArray(tree) ? tree : (tree.children || tree.tree || []));
      const have = new Set(this.data.tracks.map((t) => relOf(t.media)));
      const choices = all.filter((p) => !have.has(p));
      const ov = document.createElement('div');
      ov.className = 'mu-modal';
      ov.innerHTML = `<div class="mu-modal-box"><div class="mu-modal-head"><b>Add from workspace</b><button type="button" data-x>×</button></div>
        <input type="search" class="mu-search" data-q placeholder="Filter ${choices.length} audio / video files…">
        <div class="mu-pick">${choices.length ? choices.map((p) => `<label><input type="checkbox" value="${esc(p)}"> <span>${C.mediaKind(p) === 'video' ? '🎬' : '🎵'} ${esc(p)}</span></label>`).join('') : '<div class="mu-empty">No audio or video files in the workspace that aren\'t already in this collection.</div>'}</div>
        <div class="mu-modal-acts"><span class="mu-sp"></span><button type="button" data-x>Cancel</button><button type="button" class="mu-primary" data-add>Add selected</button></div></div>`;
      document.body.appendChild(ov);
      const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc, true); };
      const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
      document.addEventListener('keydown', onEsc, true);
      ov.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
      ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
      ov.querySelector('[data-q]').addEventListener('input', (e) => {
        const t = e.target.value.toLowerCase();
        ov.querySelectorAll('.mu-pick label').forEach((l) => { l.hidden = !!t && !l.textContent.toLowerCase().includes(t); });
      });
      ov.querySelector('[data-add]').addEventListener('click', () => {
        const picked = [...ov.querySelectorAll('.mu-pick input:checked')].map((x) => x.value);
        close();
        if (picked.length) this._addPaths(picked, (this._selected() && this._selected().sectionId) || this.data.sections[0].id);
      });
      ov.querySelector('[data-q]').focus();
    }

    // ---------- export / checks ----------
    _exportCsv() {
      const cols = ['title', 'artist', 'album', 'year', 'section', 'status', 'key', 'bpm', 'capo', 'tuning', 'duration', 'tags', 'file'];
      const secName = Object.fromEntries(this.data.sections.map((s) => [s.id, s.name]));
      const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const rows = [cols.join(',')].concat(this.data.tracks.map((t) => [t.title, t.artist, t.album, t.year, secName[t.sectionId], STATUS_LABEL[t.status], t.key, t.bpm, t.capo, t.tuning, t.duration ? C.fmtTime(t.duration) : '', t.tags.join('; '), relOf(t.media)].map(cell).join(',')));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
      a.download = (this.data.title || 'music').replace(/[^\w.-]+/g, '-') + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    }

    async _checkMissing() {
      const missing = [];
      await Promise.all(this.data.tracks.map(async (t) => {
        try { const r = await fetch('/api/file-info?path=' + encodeURIComponent(relOf(t.media))); if (!r.ok) missing.push(t); } catch (e) { missing.push(t); }
      }));
      if (!missing.length) { global.uiAlert('All ' + this.data.tracks.length + ' files are present.', { title: 'Check files' }); return; }
      global.uiAlert(missing.length + ' file' + (missing.length === 1 ? ' is' : 's are') + ' missing:\n\n' + missing.slice(0, 20).map((t) => '• ' + t.title + ' — ' + relOf(t.media)).join('\n') + (missing.length > 20 ? '\n…' : ''), { title: 'Check files' });
    }
  }

  global.MusicEngine = MusicEngine;
})(typeof window !== 'undefined' ? window : this);
