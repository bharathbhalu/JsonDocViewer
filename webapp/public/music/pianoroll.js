/* DocViewer music piano roll (phase 4): edit a track's note events — add
 * (double-click), move / resize (drag, right edge), split (⌥-click), merge,
 * delete, box-select, snap & quantise to the beat grid, transpose, hide
 * low-confidence notes, undo / redo. Click the ruler to seek. */
(function (global) {
  const T = global.MusicTheory;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BLACK = [1, 3, 6, 8, 10];
  const KEYW = 38; // piano key column
  const RULER = 22; // ruler + chords strip
  const ROWH = 11;

  class PianoRoll {
    constructor(panel) {
      this.panel = panel;
      this.t = panel.t;
      this.player = panel.player;
      this.ro = panel.readOnly;
      this.sel = new Set();
      this.undoStack = [];
      this.redoStack = [];
      let grid = 4;
      try { grid = Number(localStorage.getItem('docviewer-music-grid') || 4); } catch (e) { /* default */ }
      this.grid = grid; // divisions per beat; 0 = off
      this.follow = true;
      const ps = this.t.noteEvents.map((n) => n.p);
      const lo = ps.length ? Math.min(...ps) : 52;
      const hi = ps.length ? Math.max(...ps) : 76;
      this.pHi = Math.min(108, Math.max(hi + 3, lo + 26));
      this.pLo = Math.max(21, this.pHi - Math.max(26, hi - lo + 6));
      this.pps = 80; // pixels per second
      this.x0 = Math.max(0, (this.player.media.currentTime || 0) - 2);
      this.el = document.createElement('div');
      this.el.className = 'pr-root';
      this.build();
    }

    get notes() { return this.t.noteEvents; }
    get off() { return this.t.notesOffset || 0; }
    get beat() { return 60 / (this.t.bpm || 120); }
    get gridSec() { return this.grid ? this.beat / this.grid : 0; }
    visible(n) { return n.c == null || n.c >= (this.t.minConf || 0); }

    build() {
      const t = this.t;
      const ro = this.ro;
      this.el.innerHTML = `<div class="pr-tools">
          ${ro ? '' : `<button type="button" data-a="undo" title="Undo (⌘Z)">↶</button><button type="button" data-a="redo" title="Redo (⇧⌘Z)">↷</button><span class="mi-sep"></span>`}
          <label>Grid <select data-grid>${[[0, 'Off'], [1, '1 beat'], [2, '1/2 beat'], [4, '1/4 beat'], [3, 'Triplets']].map(([v, l]) => `<option value="${v}"${this.grid === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          ${ro ? '' : `<button type="button" data-a="quant" title="Snap starts and lengths to the grid (Q); selected notes or all">Quantise</button>
          <button type="button" data-a="tr" data-v="-12" title="Octave down (⇧↓)">−8va</button><button type="button" data-a="tr" data-v="-1" title="Semitone down (↓)">−1</button><button type="button" data-a="tr" data-v="1" title="Semitone up (↑)">+1</button><button type="button" data-a="tr" data-v="12" title="Octave up (⇧↑)">+8va</button>
          <button type="button" data-a="merge" title="Join selected notes of the same pitch (J)">Merge</button>
          <button type="button" data-a="del" title="Delete selected (⌫)">Delete</button>
          <button type="button" data-a="smooth" title="Clean up a sung / played melody: drop blips, join fragments, one note at a time, close small gaps (undoable)">✨ Smooth line</button>`}
          <span class="mi-sep"></span>
          <label title="Hide notes the analysis is unsure about">Confidence ≥ <input type="range" min="0" max="0.9" step="0.05" data-conf value="${t.minConf || 0}"><span data-confv>${Math.round((t.minConf || 0) * 100)}%</span></label>
          <span class="mi-sp"></span>
          <label>Sound <select data-sound>${[['instrument', 'Instrument'], ['voice', 'Smooth voice']].map(([v, l]) => `<option value="${v}"${t.noteSound === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Hear <select data-mode>${[['original', 'Recording'], ['notes', 'Notes only'], ['both', 'Both']].map(([v, l]) => `<option value="${v}"${t.playMode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label><input type="checkbox" data-follow checked> Follow</label>
          <button type="button" data-a="zout" title="Zoom out">−</button><button type="button" data-a="zin" title="Zoom in">+</button>
        </div>
        <div class="pr-canvas-wrap"><canvas tabindex="0" data-c></canvas></div>
        <div class="mi-muted pr-help">${ro ? '' : 'Double-click to add · drag to move · drag the right edge to resize · ⌥-click to split · drag on empty space to select · '}${esc(this.notes.length + ' notes')}${t.bpm ? ' · grid ' + t.bpm + ' BPM' : ' · set the tempo (BPM) in Details for a beat grid'}</div>`;
      this.canvas = this.el.querySelector('[data-c]');
      const q = (s) => this.el.querySelector(s);
      this.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.a, Number(b.dataset.v))));
      q('[data-grid]').addEventListener('change', (e) => { this.grid = Number(e.target.value); try { localStorage.setItem('docviewer-music-grid', this.grid); } catch (err) { /* ignore */ } this.draw(); });
      q('[data-conf]').addEventListener('input', (e) => { t.minConf = Number(e.target.value); q('[data-confv]').textContent = Math.round(t.minConf * 100) + '%'; this.panel.notesChanged(false); this.draw(); });
      q('[data-conf]').addEventListener('change', () => this.panel.changed());
      q('[data-mode]').addEventListener('change', (e) => this.player.setPlayMode(e.target.value));
      q('[data-sound]').addEventListener('change', (e) => { t.noteSound = e.target.value; this.panel.changed(); });
      q('[data-follow]').addEventListener('change', (e) => { this.follow = e.target.checked; });
      this.bindCanvas();
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(this.canvas);
    }

    // ---------- geometry ----------
    X(sec) { return KEYW + (sec + this.off - this.x0) * this.pps; }
    secAt(x) { return (x - KEYW) / this.pps + this.x0 - this.off; }
    Y(p) { return RULER + (this.pHi - p) * ROWH; }
    pAt(y) { return this.pHi - Math.floor((y - RULER) / ROWH); }
    snap(sec) {
      const g = this.gridSec;
      if (!g) return Math.max(0, Math.round(sec * 100) / 100);
      const b0 = (this.t.beatOffset || 0) - this.off;
      return Math.max(0, Math.round((Math.round((sec - b0) / g) * g + b0) * 1000) / 1000);
    }
    hit(x, y) {
      const p = this.pAt(y);
      for (let i = this.notes.length - 1; i >= 0; i--) {
        const n = this.notes[i];
        if (n.p !== p || !this.visible(n)) continue;
        const a = this.X(n.t);
        const b = this.X(n.t + n.d);
        if (x >= a - 1 && x <= b + 1) return { n, edge: x > b - 6 && b - a > 10 };
      }
      return null;
    }

    // ---------- drawing ----------
    draw() {
      const c = this.canvas;
      if (!c || !c.isConnected) return;
      const w = c.clientWidth;
      const rows = this.pHi - this.pLo + 1;
      const h = RULER + rows * ROWH;
      c.style.height = h + 'px';
      const dpr = global.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(this.el);
      const ink = css.getPropertyValue('--ink').trim() || '#222';
      const muted = css.getPropertyValue('--muted').trim() || '#888';
      const dark = matchMedia && document.documentElement.dataset.theme === 'dark';
      g.clearRect(0, 0, w, h);
      // rows
      for (let p = this.pHi; p >= this.pLo; p--) {
        const y = this.Y(p);
        g.fillStyle = BLACK.includes(p % 12) ? (dark ? 'rgba(255,255,255,.035)' : 'rgba(20,30,50,.06)') : 'transparent';
        g.fillRect(KEYW, y, w - KEYW, ROWH);
        if (p % 12 === 0) { g.fillStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(20,30,50,.14)'; g.fillRect(KEYW, y + ROWH - 1, w - KEYW, 1); }
        g.fillStyle = BLACK.includes(p % 12) ? '#1a2130' : '#f1f3f7';
        g.fillRect(0, y, KEYW - 2, ROWH - 1);
        if (p % 12 === 0) { g.fillStyle = '#666'; g.font = '9px sans-serif'; g.fillText(T.midiName(p), 3, y + ROWH - 2); }
      }
      // beat grid
      const tEnd = this.secAt(w);
      if (this.t.bpm) {
        const beat = this.beat;
        const b0 = (this.t.beatOffset || 0);
        const [num] = String(this.t.timeSig || '4/4').split('/').map(Number);
        const sub = this.grid > 1 ? this.grid : 1;
        const step = beat / sub;
        const k0 = Math.floor((this.x0 - b0) / step);
        for (let k = k0; ; k++) {
          const sec = b0 + k * step - this.off;
          const x = this.X(sec);
          if (x > w) break;
          if (x < KEYW) continue;
          const isBeat = k % sub === 0;
          const isBar = isBeat && (k / sub) % (num || 4) === 0;
          g.fillStyle = isBar ? (dark ? 'rgba(255,255,255,.28)' : 'rgba(20,30,50,.28)') : isBeat ? (dark ? 'rgba(255,255,255,.12)' : 'rgba(20,30,50,.12)') : (dark ? 'rgba(255,255,255,.05)' : 'rgba(20,30,50,.05)');
          g.fillRect(Math.round(x), RULER, 1, h - RULER);
          if (isBar && k >= 0) { g.fillStyle = muted; g.font = '9px sans-serif'; g.fillText(String(k / sub / (num || 4) + 1), x + 2, 9); }
        }
      }
      // ruler: chords + sections
      g.fillStyle = dark ? 'rgba(255,255,255,.04)' : 'rgba(20,30,50,.04)';
      g.fillRect(KEYW, 0, w - KEYW, RULER);
      g.font = '600 10px sans-serif';
      this.t.sectionsTimeline.forEach((s) => { const x = this.X(s.a - 0 + 0) + 0; if (x > KEYW - 200 && x < w) { g.fillStyle = 'rgba(79,110,247,.18)'; g.fillRect(Math.max(KEYW, this.X(s.a)), 11, Math.max(0, Math.min(w, this.X(s.b)) - Math.max(KEYW, this.X(s.a))), 10); g.fillStyle = muted; g.fillText(s.name, Math.max(KEYW, this.X(s.a)) + 3, 20); } });
      this.t.chords.forEach((ch) => { const x = KEYW + (ch.t - this.x0) * this.pps; if (x >= KEYW && x < w) { g.fillStyle = ink; g.fillText(ch.name, x + 2, 9); } });
      // notes
      const minC = this.t.minConf || 0;
      this.notes.forEach((n) => {
        if (n.p < this.pLo || n.p > this.pHi) return;
        const a = this.X(n.t);
        const b = this.X(n.t + n.d);
        if (b < KEYW || a > w) return;
        const y = this.Y(n.p);
        const hidden = n.c != null && n.c < minC;
        const alpha = hidden ? 0.08 : (n.c == null ? 1 : 0.45 + 0.55 * n.c);
        g.globalAlpha = alpha;
        g.fillStyle = this.sel.has(n) ? '#f08c2b' : '#4f6ef7';
        g.fillRect(Math.max(KEYW, a), y + 1, Math.max(2, b - Math.max(KEYW, a) - 1), ROWH - 2);
        g.globalAlpha = 1;
        if (this.sel.has(n)) { g.strokeStyle = '#b85e10'; g.strokeRect(Math.max(KEYW, a) + 0.5, y + 1.5, Math.max(2, b - Math.max(KEYW, a) - 2), ROWH - 3); }
      });
      // box select
      if (this._box) { const b = this._box; g.strokeStyle = '#4f6ef7'; g.setLineDash([4, 3]); g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0)); g.setLineDash([]); }
      // playhead
      const ph = KEYW + ((this.player.media.currentTime || 0) - this.x0) * this.pps;
      if (ph >= KEYW && ph <= w) { g.fillStyle = '#e5484d'; g.fillRect(Math.round(ph), 0, 2, h); }
      this._tEnd = tEnd;
    }

    // Keep the playhead in view while playing.
    tick(sec) {
      if (this.follow && !this.player.media.paused && !this._drag) {
        const w = this.canvas.clientWidth;
        const span = (w - KEYW) / this.pps;
        if (sec < this.x0 || sec > this.x0 + span * 0.85) this.x0 = Math.max(0, sec - span * 0.15);
      }
      this.draw();
    }

    // ---------- editing ----------
    snapshot() {
      this.undoStack.push(JSON.stringify(this.notes));
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    commit() {
      this.notes.sort((a, b) => a.t - b.t || a.p - b.p);
      this.panel.notesChanged(true);
      this.draw();
    }
    restore(json) {
      const sel = new Set([...this.sel].map((n) => n.p + '@' + n.t));
      this.t.noteEvents = JSON.parse(json);
      this.sel = new Set(this.t.noteEvents.filter((n) => sel.has(n.p + '@' + n.t)));
      this.commit();
    }
    targets() { return this.sel.size ? [...this.sel] : this.notes.filter((n) => this.visible(n)); }

    act(a, v) {
      if (this.ro && !['zin', 'zout'].includes(a)) return;
      if (a === 'zin' || a === 'zout') { const c = (this.player.media.currentTime || this.x0); const k = a === 'zin' ? 1.4 : 1 / 1.4; this.pps = Math.max(10, Math.min(800, this.pps * k)); this.x0 = Math.max(0, c - (c - this.x0) / k); this.draw(); return; }
      if (a === 'undo') { if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.notes)); this.restore(this.undoStack.pop()); return; }
      if (a === 'redo') { if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.notes)); this.restore(this.redoStack.pop()); return; }
      if (a === 'del') { if (!this.sel.size) return; this.snapshot(); this.t.noteEvents = this.notes.filter((n) => !this.sel.has(n)); this.sel.clear(); this.commit(); return; }
      if (a === 'tr') { const ns = this.targets(); if (!ns.length) return; this.snapshot(); ns.forEach((n) => { n.p = Math.max(0, Math.min(127, n.p + v)); }); this.commit(); return; }
      if (a === 'quant') {
        if (!this.gridSec) { global.uiAlert('Choose a grid first (and set the track tempo in Details).'); return; }
        const ns = this.targets();
        if (!ns.length) return;
        this.snapshot();
        ns.forEach((n) => { const s = this.snap(n.t); const e = this.snap(n.t + n.d); n.t = s; n.d = Math.max(this.gridSec, Math.round((e - s) * 1000) / 1000); });
        this.commit();
        return;
      }
      if (a === 'smooth') {
        const before = this.notes.length;
        const ns = this.targets().slice().sort((x, y) => x.t - y.t || (y.c == null ? 1 : y.c) - (x.c == null ? 1 : x.c));
        if (!ns.length) return;
        this.snapshot();
        const r = smoothLine(ns);
        const keep = new Set(ns);
        this.t.noteEvents = this.notes.filter((n) => !keep.has(n)).concat(r);
        this.sel = new Set(this.sel.size ? r : []);
        this.commit();
        if (global.setStatus) global.setStatus('Smoothed: ' + before + ' → ' + this.notes.length + ' notes (⌘Z to undo)', 'ok');
        return;
      }
      if (a === 'merge') {
        const ns = [...this.sel].sort((x, y) => x.p - y.p || x.t - y.t);
        if (ns.length < 2) return;
        this.snapshot();
        const drop = new Set();
        for (let i = 1; i < ns.length; i++) {
          const prev = ns[i - 1];
          const n = ns[i];
          if (drop.has(prev) || n.p !== prev.p) continue;
          const end = Math.max(prev.t + prev.d, n.t + n.d);
          prev.d = Math.round((end - prev.t) * 1000) / 1000;
          drop.add(n);
          ns[i] = prev;
        }
        this.t.noteEvents = this.notes.filter((n) => !drop.has(n));
        drop.forEach((n) => this.sel.delete(n));
        this.commit();
      }
    }

    bindCanvas() {
      const c = this.canvas;
      const pt = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { const { x } = pt(e); const at = this.secAt(x) + this.off; const k = Math.exp(-e.deltaY * 0.01); this.pps = Math.max(10, Math.min(800, this.pps * k)); this.x0 = Math.max(0, at - (x - KEYW) / this.pps); }
        else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.x0 = Math.max(0, this.x0 + (e.deltaX || e.deltaY) / this.pps); this.follow = false; const f = this.el.querySelector('[data-follow]'); if (f) f.checked = false; }
        else { const d = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30)); const span = this.pHi - this.pLo; this.pHi = Math.max(21 + span, Math.min(108, this.pHi - d)); this.pLo = this.pHi - span; }
        this.draw();
      }, { passive: false });
      c.addEventListener('dblclick', (e) => {
        if (this.ro) return;
        const { x, y } = pt(e);
        if (y < RULER || x < KEYW || this.hit(x, y)) return;
        this.snapshot();
        const len = this.gridSec || this.beat / 2;
        const n = { p: this.pAt(y), t: this.snap(this.secAt(x) - (this.gridSec ? this.gridSec / 2 : 0)), d: Math.round(len * 1000) / 1000, v: 0.8 };
        this.t.noteEvents.push(n);
        this.sel = new Set([n]);
        this.panel.hear(n.p);
        this.commit();
      });
      c.addEventListener('pointerdown', (e) => {
        c.focus();
        const { x, y } = pt(e);
        if (x < KEYW) { const p = this.pAt(y); if (p >= this.pLo && p <= this.pHi) this.panel.hear(p); return; }
        if (y < RULER) { this.player.media.currentTime = Math.max(0, this.secAt(x) + this.off); this.draw(); return; }
        const h = this.hit(x, y);
        if (h && e.altKey && !this.ro) {
          const at = this.snap(this.secAt(x));
          if (at > h.n.t + 0.02 && at < h.n.t + h.n.d - 0.02) {
            this.snapshot();
            const right = Object.assign({}, h.n, { t: at, d: Math.round((h.n.t + h.n.d - at) * 1000) / 1000 });
            h.n.d = Math.round((at - h.n.t) * 1000) / 1000;
            this.t.noteEvents.push(right);
            this.commit();
          }
          return;
        }
        if (h) {
          if (e.shiftKey || e.metaKey) { if (this.sel.has(h.n)) this.sel.delete(h.n); else this.sel.add(h.n); this.draw(); return; }
          if (!this.sel.has(h.n)) this.sel = new Set([h.n]);
          this.panel.hear(h.n.p);
          if (this.ro) { this.draw(); return; }
          const start = [...this.sel].map((n) => ({ n, t: n.t, p: n.p, d: n.d }));
          this._drag = { kind: h.edge ? 'resize' : 'move', x, y, start, anchor: h.n, moved: false };
        } else {
          if (!e.shiftKey) this.sel.clear();
          this._drag = { kind: 'box', x, y };
          this._box = { x0: x, y0: y, x1: x, y1: y };
        }
        c.setPointerCapture(e.pointerId);
        this.draw();
      });
      c.addEventListener('pointermove', (e) => {
        const d = this._drag;
        const { x, y } = pt(e);
        if (!d) { const h = y > RULER && x > KEYW && this.hit(x, y); c.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : (y < RULER ? 'pointer' : 'default'); return; }
        if (d.kind === 'box') {
          this._box.x1 = x; this._box.y1 = y;
          const [xa, xb] = [Math.min(d.x, x), Math.max(d.x, x)];
          const [pa, pb] = [this.pAt(Math.max(d.y, y)), this.pAt(Math.min(d.y, y))];
          const ta = this.secAt(xa); const tb = this.secAt(xb);
          this.sel = new Set(this.notes.filter((n) => this.visible(n) && n.p >= pa && n.p <= pb && n.t + n.d >= ta && n.t <= tb));
          this.draw();
          return;
        }
        const dt = (x - d.x) / this.pps;
        if (!d.moved && Math.abs(x - d.x) < 3 && Math.abs(y - d.y) < 3) return;
        if (!d.moved) { d.moved = true; this.snapshot(); }
        if (d.kind === 'move') {
          const dp = Math.round((d.y - y) / ROWH);
          const a0 = d.start.find((s) => s.n === d.anchor);
          const shift = this.snap(a0.t + dt) - a0.t;
          d.start.forEach((s) => { s.n.t = Math.max(0, Math.round((s.t + shift) * 1000) / 1000); s.n.p = Math.max(0, Math.min(127, s.p + dp)); });
          if (dp !== d.lastDp) { d.lastDp = dp; this.panel.hear(d.anchor.p); }
        } else {
          d.start.forEach((s) => { const end = this.snap(s.t + s.d + dt); s.n.d = Math.max(this.gridSec || 0.03, Math.round((end - s.t) * 1000) / 1000); });
        }
        this.draw();
      });
      const up = () => {
        const d = this._drag;
        this._drag = null;
        this._box = null;
        if (d && d.moved) this.commit(); else this.draw();
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('keydown', (e) => {
        const k = e.key;
        const mod = e.metaKey || e.ctrlKey;
        let done = true;
        if (mod && k.toLowerCase() === 'z') this.act(e.shiftKey ? 'redo' : 'undo');
        else if (mod && k.toLowerCase() === 'y') this.act('redo');
        else if (mod && k.toLowerCase() === 'a') { this.sel = new Set(this.notes.filter((n) => this.visible(n))); this.draw(); }
        else if (k === 'Delete' || k === 'Backspace') this.act('del');
        else if (k === 'ArrowUp' && this.sel.size) this.act('tr', e.shiftKey ? 12 : 1);
        else if (k === 'ArrowDown' && this.sel.size) this.act('tr', e.shiftKey ? -12 : -1);
        else if (k === 'q' || k === 'Q') this.act('quant');
        else if (k === 'j' || k === 'J') this.act('merge');
        else if (k === 'Escape') { this.sel.clear(); this.draw(); }
        else done = false;
        if (done) { e.preventDefault(); e.stopPropagation(); }
      });
    }

    destroy() { if (this._ro) this._ro.disconnect(); }
  }

  // Melody clean-up: one note at a time (the more confident wins), drop
  // blips under 70 ms, join same-pitch fragments across gaps < 120 ms,
  // re-join notes split by a one-semitone wobble, and stretch notes over
  // gaps < 150 ms so the line plays legato.
  function smoothLine(input) {
    const ns = input.map((n) => Object.assign({}, n)).sort((a, b) => a.t - b.t);
    const conf = (n) => (n.c == null ? 1 : n.c);
    // monophonic: at overlaps keep the stronger note, trim the other
    const mono = [];
    ns.forEach((n) => {
      const prev = mono[mono.length - 1];
      if (prev && n.t < prev.t + prev.d - 0.02) {
        if (conf(n) > conf(prev) + 0.1 && n.d > 0.08) { prev.d = Math.max(0, n.t - prev.t); if (prev.d < 0.05) mono.pop(); mono.push(n); }
        return;
      }
      mono.push(n);
    });
    let out = mono.filter((n) => n.d >= 0.07);
    const joinPass = (maxGap, wobble) => {
      const res = [];
      out.forEach((n) => {
        const prev = res[res.length - 1];
        const gap = prev ? n.t - (prev.t + prev.d) : 1;
        const close = prev && gap < maxGap && (prev.p === n.p || (wobble && Math.abs(prev.p - n.p) === 1 && Math.min(prev.d, n.d) < 0.12));
        if (close) {
          const keepP = prev.d >= n.d ? prev.p : n.p;
          prev.d = Math.round((n.t + n.d - prev.t) * 1000) / 1000;
          prev.p = keepP;
          prev.c = Math.max(conf(prev), conf(n));
          return;
        }
        res.push(n);
      });
      out = res;
    };
    joinPass(0.12, false);
    joinPass(0.05, true);
    out.forEach((n, i) => {
      const next = out[i + 1];
      if (next) { const gap = next.t - (n.t + n.d); if (gap > 0 && gap < 0.15) n.d = Math.round((next.t - n.t) * 1000) / 1000; }
    });
    return out;
  }
  PianoRoll.smoothLine = smoothLine;

  global.MusicPianoRoll = PianoRoll;
})(typeof window !== 'undefined' ? window : this);
