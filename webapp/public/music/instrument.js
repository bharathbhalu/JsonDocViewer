/* DocViewer music instrument panel (phase 3): fretboard / piano view,
 * chord timeline + chord diagrams (alternative shapes, lock), chord library,
 * chord sheet (print), MIDI note import, tuner and metronome, and a plucked
 * string synth for hearing notes and chords. Lives under the player. */
(function (global) {
  const T = global.MusicTheory;
  const U = global.MusicPlayerUtil;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- plucked-string synth (Karplus–Strong) ----------
  const Synth = {
    ctx() {
      if (!this._ctx) { const AC = global.AudioContext || global.webkitAudioContext; this._ctx = new AC(); this._cache = new Map(); }
      if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
      return this._ctx;
    },
    buffer(midi, kind) {
      const ctx = this.ctx();
      const k = kind + ':' + midi;
      if (this._cache.has(k)) return this._cache.get(k);
      const sr = ctx.sampleRate;
      const f = T.freqOf(midi);
      const len = Math.floor(sr * (kind === 'piano' ? 2.2 : 1.8));
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      if (kind === 'piano') {
        for (let i = 0; i < len; i++) { const t = i / sr; const env = Math.exp(-t * 2.2) * Math.min(1, t * 400); d[i] = env * (Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(4 * Math.PI * f * t) * 0.25 + Math.sin(6 * Math.PI * f * t) * 0.1) * 0.5; }
      } else {
        const N = Math.max(2, Math.round(sr / f));
        const ring = new Float32Array(N);
        for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
        const damp = kind === 'bass' ? 0.994 : 0.996;
        let p = 0;
        for (let i = 0; i < len; i++) { const nx = (p + 1) % N; const v = damp * 0.5 * (ring[p] + ring[nx]); d[i] = ring[p] * 0.55; ring[p] = v; p = nx; }
      }
      this._cache.set(k, buf);
      if (this._cache.size > 160) this._cache.delete(this._cache.keys().next().value);
      return buf;
    },
    play(midi, when, kind, gain) {
      const ctx = this.ctx();
      const s = ctx.createBufferSource();
      s.buffer = this.buffer(midi, kind || 'guitar');
      const g = ctx.createGain();
      g.gain.value = gain == null ? 0.7 : gain;
      s.connect(g).connect(ctx.destination);
      s.start(when || ctx.currentTime);
    },
    // Note with a set length (fades out at the end).
    playFor(midi, when, kind, gain, dur) {
      const ctx = this.ctx();
      const s = ctx.createBufferSource();
      s.buffer = this.buffer(midi, kind || 'guitar');
      const g = ctx.createGain();
      const end = when + Math.max(0.08, Math.min(dur || 0.3, 1.7));
      g.gain.setValueAtTime(gain == null ? 0.6 : gain, when);
      g.gain.setValueAtTime(gain == null ? 0.6 : gain, Math.max(when, end - 0.05));
      g.gain.linearRampToValueAtTime(0, end);
      s.connect(g).connect(ctx.destination);
      s.start(when);
      s.stop(end + 0.02);
    },
    // Sustained, voice-like tone for melodies: soft attack, holds for the
    // note's length, glides from the previous pitch when notes join up.
    voice(midi, when, dur, gain, fromMidi) {
      const ctx = this.ctx();
      const f = T.freqOf(midi);
      const end = when + Math.max(0.06, dur);
      const out = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(4000, f * 5);
      lp.Q.value = 0.4;
      const g = gain == null ? 0.35 : gain;
      const att = fromMidi != null ? 0.015 : 0.04;
      out.gain.setValueAtTime(0.0001, when);
      out.gain.linearRampToValueAtTime(g, when + att);
      out.gain.setValueAtTime(g, Math.max(when + att, end - 0.04));
      out.gain.linearRampToValueAtTime(0.0001, end + 0.06);
      const vib = ctx.createOscillator();
      const vibG = ctx.createGain();
      vib.frequency.value = 5.2;
      vibG.gain.setValueAtTime(0, when);
      vibG.gain.linearRampToValueAtTime(f * 0.006, when + Math.min(0.4, dur));
      vib.connect(vibG);
      [['triangle', 1], ['sine', 0.5]].forEach(([type, mul]) => {
        const o = ctx.createOscillator();
        o.type = type;
        const og = ctx.createGain();
        og.gain.value = mul;
        if (fromMidi != null && fromMidi !== midi) {
          o.frequency.setValueAtTime(T.freqOf(fromMidi) * (type === 'sine' ? 2 : 1), when);
          o.frequency.exponentialRampToValueAtTime(f * (type === 'sine' ? 2 : 1), when + 0.06);
        } else o.frequency.setValueAtTime(f * (type === 'sine' ? 2 : 1), when);
        vibG.connect(o.frequency);
        o.connect(og).connect(lp);
        o.start(when);
        o.stop(end + 0.1);
      });
      vib.start(when);
      vib.stop(end + 0.1);
      lp.connect(out).connect(ctx.destination);
    },
    strum(midis, kind, down) {
      const ctx = this.ctx();
      const list = down === false ? midis.slice().reverse() : midis;
      list.forEach((m, i) => this.play(m, ctx.currentTime + 0.02 + i * 0.028, kind, 0.55));
    },
  };

  // ---------- chord diagram (SVG) ----------
  function diagramSvg(v, nStrings, opts) {
    const o = Object.assign({ w: 92, h: 108, labels: 'fingers' }, opts);
    const frets = 4;
    const left = 14; const top = 22; const right = o.w - 10; const bottom = o.h - 12;
    const sw = (right - left) / Math.max(1, nStrings - 1);
    const fh = (bottom - top) / frets;
    const base = v.base > 1 ? v.base : 1;
    let s = `<svg viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}" class="mi-diag">`;
    s += base === 1 ? `<rect x="${left - 1}" y="${top - 3}" width="${right - left + 2}" height="3.5" fill="currentColor"/>` : `<text x="${left - 4}" y="${top + fh * 0.65}" font-size="9" text-anchor="end" fill="currentColor">${base}</text>`;
    for (let i = 0; i < nStrings; i++) s += `<line x1="${left + i * sw}" y1="${top}" x2="${left + i * sw}" y2="${bottom}" stroke="currentColor" stroke-opacity=".55"/>`;
    for (let f = 1; f <= frets; f++) s += `<line x1="${left}" y1="${top + f * fh}" x2="${right}" y2="${top + f * fh}" stroke="currentColor" stroke-opacity=".35"/>`;
    if (v.barre) {
      const y = top + (v.barre.fret - base + 0.5) * fh;
      s += `<rect x="${left + v.barre.from * sw - 5}" y="${y - 5}" width="${(v.barre.to - v.barre.from) * sw + 10}" height="10" rx="5" fill="currentColor"/>`;
    }
    v.frets.forEach((f, i) => {
      const x = left + i * sw;
      if (f < 0) s += `<text x="${x}" y="${top - 7}" font-size="9" text-anchor="middle" fill="currentColor" opacity=".7">×</text>`;
      else if (f === 0) s += `<circle cx="${x}" cy="${top - 10}" r="3" fill="none" stroke="currentColor" opacity=".8"/>`;
      else {
        const y = top + (f - base + 0.5) * fh;
        const inBarre = v.barre && f === v.barre.fret && i >= v.barre.from && i <= v.barre.to;
        if (!inBarre) s += `<circle cx="${x}" cy="${y}" r="5.4" fill="currentColor"/>`;
        const lab = o.labels === 'fingers' ? (v.fingers[i] || '') : '';
        if (lab && !inBarre) s += `<text x="${x}" y="${y + 3}" font-size="7.5" text-anchor="middle" fill="var(--mi-diag-ink, #fff)">${lab}</text>`;
      }
    });
    return s + '</svg>';
  }

  class InstrumentPanel {
    constructor(player, collection, opts) {
      this.player = player;
      this.t = player.t;
      this.col = collection;
      this.opts = opts || {};
      this.readOnly = !!this.opts.readOnly;
      let tab = 'fretboard';
      try { tab = localStorage.getItem('docviewer-music-tab') || tab; } catch (e) { /* default */ }
      this.tab = tab;
      this.voiceIdx = {}; // chord → index of the shape being shown
      this.el = document.createElement('div');
      this.el.className = 'mi-root';
      this.render();
      this.loadStems(false);
    }

    changed() { if (this.opts.onChange) this.opts.onChange(); }
    get inst() { return this.col.instrument; }
    get kind() { return this.inst.kind; }
    get tuning() { return T.tuningNotes(this.kind, this.t.tuning || this.inst.tuning); }
    get capo() { return this.t.capo != null && this.t.capo !== 0 ? this.t.capo : (this.inst.capo || 0); }
    get synthKind() { return this.kind === 'piano' ? 'piano' : this.kind === 'bass' ? 'bass' : 'guitar'; }

    // Chord sounding at a time, and the next one.
    chordAt(sec) {
      const list = this.t.chords;
      let cur = null; let next = null;
      for (let i = 0; i < list.length; i++) { if (list[i].t <= sec + 0.02) cur = list[i]; else { next = list[i]; break; } }
      return { cur, next };
    }

    // Shape for a chord, honouring capo (shape name = chord − capo) and lock.
    shapeFor(name) {
      const shapeName = this.capo ? T.transposeChord(name, -this.capo) : name;
      const all = T.voicings(shapeName, this.tuning, { maxFret: Math.max(12, this.inst.frets - 2), max: 8 });
      const lockKey = this.kind + ':' + (this.t.tuning || this.inst.tuning) + ':' + shapeName;
      const locked = this.col.chordLocks[lockKey];
      let idx = this.voiceIdx[shapeName];
      if (idx == null) { const li = locked ? all.findIndex((v) => v.frets.join(',') === locked) : -1; idx = li >= 0 ? li : 0; }
      return { shapeName, all, v: all[idx] || null, idx, lockKey, locked: !!locked && all[idx] && all[idx].frets.join(',') === locked };
    }

    // ---------- render ----------
    render() {
      const t = this.t;
      const tabs = [['fretboard', this.kind === 'piano' ? 'Keyboard' : 'Fretboard'], ['chords', 'Chords'], ['sheet', 'Chord sheet'], ['library', 'Chord library'], ['roll', 'Piano roll'], ['notes', 'Notes / MIDI'], ['stems', 'Stems'], ['tools', 'Tuner & metronome']];
      const capoTxt = this.capo ? ` · Capo ${this.capo}` : '';
      this.el.innerHTML = `
        <div class="mi-head">
          <div class="mi-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${this.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <span class="mi-sp"></span>
          <span class="mi-inst">${esc(({ guitar: 'Guitar', ukulele: 'Ukulele', bass: 'Bass', piano: 'Piano' })[this.kind])}${this.kind !== 'piano' ? ' · ' + esc(T.tuningLabel(this.kind, t.tuning || this.inst.tuning)) : ''}${capoTxt}</span>
        </div>
        <div class="mi-strip" data-strip></div>
        <div class="mi-body" data-body></div>`;
      this.el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        this.tab = b.dataset.tab;
        try { localStorage.setItem('docviewer-music-tab', this.tab); } catch (e) { /* ignore */ }
        if (this.tab !== 'tools') this._stopTools();
        this.render();
        if (this.tab === 'roll' && this.roll) this.roll.canvas.focus();
      }));
      this._renderStrip();
      if (this.roll) { this.roll.destroy(); this.roll = null; }
      const body = this.el.querySelector('[data-body]');
      if (this.tab === 'fretboard') this._renderBoard(body);
      else if (this.tab === 'chords') this._renderChords(body);
      else if (this.tab === 'sheet') this._renderSheet(body);
      else if (this.tab === 'library') this._renderLibrary(body);
      else if (this.tab === 'notes') this._renderNotes(body);
      else if (this.tab === 'roll') { this.roll = new global.MusicPianoRoll(this); body.appendChild(this.roll.el); requestAnimationFrame(() => this.roll && this.roll.draw()); }
      else if (this.tab === 'stems') this._renderStems(body);
      else this._renderTools(body);
      this.tick(this.player.media.currentTime, true);
    }

    // Chord timeline strip (current highlighted), clickable to jump.
    _renderStrip() {
      const strip = this.el.querySelector('[data-strip]');
      const list = this.t.chords;
      if (!list.length) { strip.innerHTML = `<span class="mi-muted">No chords yet — add them in <b>Chords</b> (or import MIDI and detect them).</span>`; return; }
      strip.innerHTML = list.map((c) => `<button type="button" class="mi-chip" data-cid="${esc(c.id)}" data-t="${c.t}" title="${U.fmt(c.t)} — click to jump, double-click to hear">${esc(c.name)}<small>${U.fmt(c.t)}</small></button>`).join('');
      strip.querySelectorAll('[data-cid]').forEach((b) => {
        b.addEventListener('click', () => { this.player.media.currentTime = Number(b.dataset.t); });
        b.addEventListener('dblclick', () => this.hearChord(this.t.chords.find((c) => c.id === b.dataset.cid).name));
      });
    }

    hearChord(name) {
      if (this.kind === 'piano') {
        const ch = T.parseChord(name);
        if (ch) Synth.strum(ch.intervals.map((i) => 60 + ch.root + i), 'piano');
        return;
      }
      const s = this.shapeFor(name);
      if (!s.v) return;
      const midis = s.v.frets.map((f, i) => (f < 0 ? null : this.tuning[i] + f + this.capo)).filter((x) => x != null);
      Synth.strum(midis, this.synthKind);
    }

    // ---------- fretboard / keyboard ----------
    _renderBoard(body) {
      const inst = this.inst;
      body.innerHTML = `<div class="mi-board-tools">
          <label>Labels <select data-opt="labels">${[['notes', 'Note names'], ['degrees', 'Scale degrees'], ['frets', 'Fret numbers'], ['fingers', 'Fingers']].map(([k, l]) => `<option value="${k}"${inst.labels === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Scale <select data-opt="scale"><option value="">None</option>${Object.keys(T.SCALES).map((k) => `<option value="${k}"${inst.scale === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
          <span class="mi-muted">${this.t.key ? 'Key ' + esc(this.t.key) : 'Set the track key in Details for scale and degrees'}</span>
          <span class="mi-sp"></span>
          <span class="mi-now" data-now></span>
        </div>
        <div class="mi-board" data-board></div>
        <div class="mi-diags" data-diags></div>`;
      body.querySelectorAll('[data-opt]').forEach((s) => s.addEventListener('change', () => { this.inst[s.dataset.opt] = s.value; this.changed(); this.render(); }));
      this._drawBoard();
      this._renderDiagStrip(body.querySelector('[data-diags]'));
    }

    _keyInfo() {
      const k = T.parseKey(this.t.key);
      if (!k) return null;
      const scale = this.inst.scale || '';
      let iv = scale && T.SCALES[scale];
      if (scale === 'major' && k.minor) iv = T.SCALES.minor;
      return { root: k.root, minor: k.minor, scale: iv || null };
    }

    _drawBoard() {
      const box = this.el.querySelector('[data-board]');
      if (!box) return;
      if (this.kind === 'piano') { box.innerHTML = this._pianoSvg(); this._bindBoard(box); return; }
      const tun = this.tuning;
      const n = tun.length;
      const frets = this.inst.frets || 15;
      const W = 980; const H = 30 + n * 26; const L = 48; const R = W - 10;
      const fx = (f) => L + (R - L) * (1 - Math.pow(2, -f / 12)) / (1 - Math.pow(2, -frets / 12));
      const lh = this.inst.leftHanded;
      const X = (x) => (lh ? W - x : x);
      const sy = (s) => 18 + (n - 1 - s) * 26; // high string on top
      const key = this._keyInfo();
      let g = `<svg viewBox="0 0 ${W} ${H}" class="mi-neck" preserveAspectRatio="xMidYMid meet"><rect x="${Math.min(X(L), X(R))}" y="6" width="${R - L}" height="${H - 12}" rx="6" fill="var(--mi-wood)"/>`;
      for (let f = 1; f <= frets; f++) g += `<line x1="${X(fx(f))}" y1="8" x2="${X(fx(f))}" y2="${H - 8}" stroke="var(--mi-fret)" stroke-width="2"/>`;
      g += `<line x1="${X(L)}" y1="6" x2="${X(L)}" y2="${H - 6}" stroke="var(--mi-nut)" stroke-width="6"/>`;
      [3, 5, 7, 9, 15, 17, 19, 21].filter((f) => f <= frets).forEach((f) => { g += `<circle cx="${X((fx(f - 1) + fx(f)) / 2)}" cy="${H / 2}" r="5" fill="var(--mi-inlay)"/>`; });
      if (frets >= 12) { const x = X((fx(11) + fx(12)) / 2); g += `<circle cx="${x}" cy="${H / 2 - 22}" r="5" fill="var(--mi-inlay)"/><circle cx="${x}" cy="${H / 2 + 22}" r="5" fill="var(--mi-inlay)"/>`; }
      if (this.capo) { const x = X((fx(this.capo - 1) + fx(this.capo)) / 2 + 9); g += `<rect x="${x - 5}" y="4" width="10" height="${H - 8}" rx="4" fill="#1a2130" opacity=".85"/><text x="${x}" y="${H - 1}" font-size="9" text-anchor="middle" fill="var(--muted)">capo</text>`; }
      for (let s = 0; s < n; s++) {
        g += `<line x1="${X(L)}" y1="${sy(s)}" x2="${X(R)}" y2="${sy(s)}" stroke="var(--mi-string)" stroke-width="${1 + (n - s) * 0.25}"/>`;
        g += `<text x="${lh ? W - 12 : 12}" y="${sy(s) + 4}" font-size="11" font-weight="700" text-anchor="middle" fill="var(--muted)">${T.noteName(tun[s])}</text>`;
      }
      // Scale overlay
      if (key && key.scale) {
        for (let s = 0; s < n; s++) for (let f = 0; f <= frets; f++) {
          const pc = (tun[s] + f) % 12;
          if (!key.scale.includes((pc - key.root + 12) % 12)) continue;
          const x = f === 0 ? L - 12 : (fx(f - 1) + fx(f)) / 2;
          g += `<circle cx="${X(x)}" cy="${sy(s)}" r="7" fill="${(pc - key.root + 12) % 12 === 0 ? 'rgba(229,72,77,.35)' : 'rgba(79,110,247,.22)'}" data-pos="${s}:${f}"/>`;
        }
      }
      g += `<g data-live></g>`;
      // click targets
      for (let s = 0; s < n; s++) for (let f = 0; f <= frets; f++) { const x = f === 0 ? L - 12 : (fx(f - 1) + fx(f)) / 2; const w = f === 0 ? 20 : fx(f) - fx(f - 1); g += `<rect x="${X(x) - w / 2}" y="${sy(s) - 12}" width="${w}" height="24" fill="transparent" data-play="${tun[s] + f}"/>`; }
      g += '</svg>';
      box.innerHTML = g;
      this._geom = { fx, X, sy, L, n };
      this._bindBoard(box);
      this._liveKey = '';
    }

    _pianoSvg() {
      const lo = 48; const hi = 84; // C3..C6
      const whites = []; for (let m = lo; m <= hi; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
      const W = 980; const ww = W / whites.length; const H = 120;
      let g = `<svg viewBox="0 0 ${W} ${H}" class="mi-neck">`;
      whites.forEach((m, i) => { g += `<rect x="${i * ww}" y="0" width="${ww - 1}" height="${H}" fill="#fff" stroke="#bbb" data-play="${m}" data-key="${m}"/>`; if (m % 12 === 0) g += `<text x="${i * ww + ww / 2}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#999">C${Math.floor(m / 12) - 1}</text>`; });
      whites.forEach((m, i) => { if ([0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= hi) g += `<rect x="${(i + 1) * ww - ww * 0.3}" y="0" width="${ww * 0.6}" height="${H * 0.62}" fill="#1a2130" data-play="${m + 1}" data-key="${m + 1}"/>`; });
      g += `<g data-live></g></svg>`;
      this._geom = { piano: true, whites, ww, H };
      return g;
    }

    _bindBoard(box) {
      box.addEventListener('click', (e) => { const r = e.target.closest('[data-play]'); if (r) Synth.play(Number(r.dataset.play) + (this.kind === 'piano' ? 0 : this.capo * 0), 0, this.synthKind); });
    }

    // Live layer: current chord shape + MIDI notes sounding now.
    _drawLive(sec) {
      const live = this.el.querySelector('[data-live]');
      if (!live || !this._geom) return;
      const { cur, next } = this.chordAt(sec);
      const off = this.t.noteEventsOffset || 0;
      const sounding = this.t.noteEvents.filter((n) => sec >= n.t + off && sec < n.t + off + Math.max(n.d, 0.12));
      const keyStr = (cur ? cur.id : '') + '|' + sounding.map((n) => n.p + '@' + n.t).join(',');
      const nowEl = this.el.querySelector('[data-now]');
      if (nowEl) nowEl.innerHTML = cur ? `Now: <b>${esc(cur.name)}</b>${this.capo ? ` <small>(shape ${esc(T.transposeChord(cur.name, -this.capo))})</small>` : ''}${next ? ` · next ${esc(next.name)}` : ''}` : (next ? 'Next: <b>' + esc(next.name) + '</b>' : '');
      if (keyStr === this._liveKey) return;
      this._liveKey = keyStr;
      const key = this._keyInfo();
      const label = (midi, finger, fret) => {
        const lab = this.inst.labels;
        if (lab === 'frets') return String(fret);
        if (lab === 'fingers') return finger ? String(finger) : (fret === 0 ? '○' : '');
        if (lab === 'degrees' && key) return T.DEGREE[(midi - key.root + 120) % 12];
        return T.noteName(midi);
      };
      let g = '';
      if (this._geom.piano) {
        const mark = (m, cls) => { const el = this.el.querySelector(`[data-key="${m}"]`); if (!el) return; const x = Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2; const y = Number(el.getAttribute('height')) - 22; g += `<circle cx="${x}" cy="${y}" r="8" class="${cls}"/><text x="${x}" y="${y + 3.5}" font-size="9" text-anchor="middle" fill="#fff">${T.noteName(m)}</text>`; };
        if (cur) { const ch = T.parseChord(cur.name); if (ch) ch.intervals.forEach((i) => mark(60 + ch.root + i, 'mi-dot chord')); }
        sounding.forEach((n) => mark(n.p, 'mi-dot note'));
        live.innerHTML = g;
        return;
      }
      const { fx, X, sy, L } = this._geom;
      const posX = (f) => (f === 0 ? L - 12 : (fx(f - 1) + fx(f)) / 2);
      if (cur) {
        const s = this.shapeFor(cur.name);
        if (s.v) {
          s.v.frets.forEach((f, i) => {
            if (f < 0) { g += `<text x="${X(L - 12)}" y="${sy(i) + 4}" font-size="12" text-anchor="middle" fill="var(--muted)">×</text>`; return; }
            const fret = f + (f > 0 || this.capo ? this.capo : 0);
            const midi = this.tuning[i] + fret;
            g += `<circle cx="${X(posX(fret))}" cy="${sy(i)}" r="11" class="mi-dot chord"/><text x="${X(posX(fret))}" y="${sy(i) + 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${esc(label(midi, s.v.fingers[i], fret))}</text>`;
          });
        }
      }
      if (sounding.length) {
        const posKey = this._notesPos();
        sounding.forEach((n) => {
          const p = posKey.get(n);
          if (!p) return;
          g += `<circle cx="${X(posX(p.f))}" cy="${sy(p.s)}" r="11" class="mi-dot note"/><text x="${X(posX(p.f))}" y="${sy(p.s) + 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${esc(label(n.p, 0, p.f))}</text>`;
        });
      }
      live.innerHTML = g;
    }

    // Fret positions for imported notes (solved once per track/tuning/capo).
    _notesPos() {
      const sig = this.t.noteEvents.length + '|' + this.tuning.join(',') + '|' + this.capo + '|' + (this.inst.frets || 15);
      if (this._posSig === sig) return this._posMap;
      const pos = T.positionsFor(this.t.noteEvents.map((n) => n.p), this.tuning, { capo: this.capo, maxFret: this.inst.frets || 15 });
      this._posMap = new Map(this.t.noteEvents.map((n, i) => [n, pos[i]]));
      this._posSig = sig;
      return this._posMap;
    }

    // Diagrams of the song's chords (current highlighted, next previewed).
    _renderDiagStrip(box) {
      if (!box) return;
      if (this.kind === 'piano') { box.innerHTML = ''; return; }
      const names = [...new Set(this.t.chords.map((c) => c.name))];
      box.innerHTML = names.length ? names.map((nm) => this._diagCard(nm)).join('') : '<span class="mi-muted">Chord diagrams for this song appear here once it has chords.</span>';
      this._bindDiagCards(box);
    }

    _diagCard(name, big) {
      const s = this.shapeFor(name);
      const n = this.tuning.length;
      return `<div class="mi-card${big ? ' big' : ''}" data-card="${esc(name)}">
        <div class="mi-card-name">${esc(name)}${this.capo ? `<small>shape ${esc(s.shapeName)}</small>` : ''}</div>
        ${s.v ? diagramSvg(s.v, n, big ? { w: 120, h: 140 } : {}) : '<div class="mi-muted">No shape</div>'}
        <div class="mi-card-acts">
          <button type="button" data-strum title="Hear it">▶</button>
          ${s.all.length > 1 ? `<button type="button" data-next title="Other shapes (${s.idx + 1}/${s.all.length})">⇄ ${s.idx + 1}/${s.all.length}</button>` : ''}
          ${this.readOnly || !s.v ? '' : `<button type="button" data-lock class="${s.locked ? 'on' : ''}" title="${s.locked ? 'Locked — always use this shape' : 'Lock this shape for this chord'}">${s.locked ? '🔒' : '🔓'}</button>`}
        </div></div>`;
    }

    _bindDiagCards(box) {
      box.querySelectorAll('[data-card]').forEach((card) => {
        const name = card.dataset.card;
        const s = () => this.shapeFor(name);
        card.querySelector('[data-strum]').addEventListener('click', () => this.hearChord(name));
        const nx = card.querySelector('[data-next]');
        if (nx) nx.addEventListener('click', () => { const sh = s(); this.voiceIdx[sh.shapeName] = (sh.idx + 1) % sh.all.length; this._liveKey = ''; card.outerHTML = this._diagCard(name, card.classList.contains('big')); this._bindDiagCards(box); this.tick(this.player.media.currentTime, true); });
        const lk = card.querySelector('[data-lock]');
        if (lk) lk.addEventListener('click', () => {
          const sh = s();
          if (sh.locked) delete this.col.chordLocks[sh.lockKey]; else this.col.chordLocks[sh.lockKey] = sh.v.frets.join(',');
          this.changed();
          card.outerHTML = this._diagCard(name, card.classList.contains('big'));
          this._bindDiagCards(box);
        });
      });
    }

    // ---------- chords editor ----------
    _renderChords(body) {
      const ro = this.readOnly;
      body.innerHTML = `
        ${ro ? '' : `<div class="mi-row">
          <input data-cname placeholder="Chord, e.g. Am, F#m7, C/G" list="mi-common" spellcheck="false">
          <datalist id="mi-common">${T.COMMON.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <button type="button" class="mi-primary" data-add title="Add at the current time (K)">＋ At now</button>
          <span class="mi-sep"></span>
          <button type="button" data-tr="-1" title="Transpose all chords down a semitone">♭ −1</button>
          <button type="button" data-tr="1" title="Transpose all chords up a semitone">♯ +1</button>
          ${this.t.noteEvents.length ? '<button type="button" data-detect title="Name chords from the imported MIDI notes, one per beat">Detect from MIDI</button>' : ''}
          <span class="mi-sp"></span>
          ${this.t.chords.length ? '<button type="button" data-clear class="danger">Clear all</button>' : ''}
        </div>
        <div class="mi-muted">Play the song and add each chord as it changes (type the name, press Enter or K). Times can be edited below.</div>`}
        <div class="mi-clist">${this.t.chords.map((c) => `<div class="mi-crow" data-row="${esc(c.id)}">
          <input class="mi-ct" data-ct value="${U.fmt(c.t, true)}" ${ro ? 'readonly' : ''} title="Time">
          <input class="mi-cn" data-cn value="${esc(c.name)}" ${ro ? 'readonly' : ''} list="mi-common" title="Chord">
          <span class="${T.parseChord(c.name) ? 'mi-ok' : 'mi-bad'}">${T.parseChord(c.name) ? '' : 'unknown chord'}</span>
          <span class="mi-sp"></span>
          <button type="button" data-go title="Jump here">▶︎ ${U.fmt(c.t)}</button><button type="button" data-hear title="Hear">♪</button>${ro ? '' : '<button type="button" data-del title="Delete">×</button>'}
        </div>`).join('') || '<div class="mi-muted">No chords yet.</div>'}</div>`;
      const add = () => {
        const inp = body.querySelector('[data-cname]');
        const name = inp.value.trim();
        if (!name) return;
        if (!T.parseChord(name) && global.setStatus) global.setStatus('Unknown chord "' + name + '" — added anyway', 'dirty');
        this.t.chords.push({ id: Math.random().toString(36).slice(2, 9), t: Math.round(this.player.media.currentTime * 10) / 10, name });
        this.t.chords.sort((a, b) => a.t - b.t);
        this.changed();
        this.render();
        const ni = this.el.querySelector('[data-cname]'); if (ni) ni.focus();
      };
      const q = (s) => body.querySelector(s);
      if (q('[data-add]')) q('[data-add]').addEventListener('click', add);
      if (q('[data-cname]')) q('[data-cname]').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') add(); });
      body.querySelectorAll('[data-tr]').forEach((b) => b.addEventListener('click', () => { const d = Number(b.dataset.tr); this.t.chords.forEach((c) => { c.name = T.transposeChord(c.name, d); }); if (this.t.key) this.t.key = T.transposeChord(this.t.key, d); this.changed(); this.render(); }));
      if (q('[data-clear]')) q('[data-clear]').addEventListener('click', async () => { if (await global.uiConfirm('Remove all ' + this.t.chords.length + ' chords from this track?', { title: 'Clear chords', okLabel: 'Clear', danger: true })) { this.t.chords = []; this.changed(); this.render(); } });
      if (q('[data-detect]')) q('[data-detect]').addEventListener('click', () => this._detectFromNotes());
      body.querySelectorAll('[data-row]').forEach((row) => {
        const c = this.t.chords.find((x) => x.id === row.dataset.row);
        row.querySelector('[data-go]').addEventListener('click', () => { this.player.media.currentTime = c.t; });
        row.querySelector('[data-hear]').addEventListener('click', () => this.hearChord(c.name));
        const del = row.querySelector('[data-del]');
        if (del) del.addEventListener('click', () => { this.t.chords = this.t.chords.filter((x) => x !== c); this.changed(); this.render(); });
        row.querySelectorAll('input').forEach((inp) => {
          inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
          inp.addEventListener('change', () => {
            if (inp.dataset.ct !== undefined) { const v = U.parseTime(inp.value); if (v != null) c.t = v; this.t.chords.sort((a, b) => a.t - b.t); }
            else c.name = inp.value.trim() || c.name;
            this.changed();
            this.render();
          });
        });
      });
    }

    _detectFromNotes() {
      const notes = this.t.noteEvents;
      if (!notes.length) return;
      const beat = 60 / (this.t.bpm || 100);
      const win = beat * 2;
      const end = Math.max(...notes.map((n) => n.t + n.d));
      const out = [];
      for (let t0 = 0; t0 < end; t0 += win) {
        const pcs = notes.filter((n) => n.t < t0 + win && n.t + n.d > t0).map((n) => n.p % 12);
        if (pcs.length < 2) continue;
        const name = T.nameChord(pcs);
        if (name && (!out.length || out[out.length - 1].name !== name)) out.push({ id: Math.random().toString(36).slice(2, 9), t: Math.round((t0 + (this.t.noteEventsOffset || 0)) * 10) / 10, name });
      }
      this.t.chords = out;
      this.changed();
      this.render();
      if (global.setStatus) global.setStatus('Detected ' + out.length + ' chord changes from the MIDI notes — check and edit them', 'ok');
    }

    // ---------- chord sheet ----------
    _sheetModel() {
      // Chords outside any section go in unnamed blocks between them.
      const named = this.t.sectionsTimeline.slice().sort((a, b) => a.a - b.a);
      const secs = [];
      let at = 0;
      named.forEach((s) => { if (s.a > at) secs.push({ name: '', a: at, b: s.a }); secs.push(s); at = Math.max(at, s.b); });
      secs.push({ name: '', a: at, b: Infinity });
      return secs.map((s) => ({ name: s.name, chords: this.t.chords.filter((c) => c.t >= s.a && c.t < s.b).map((c) => c.name) })).filter((s) => s.chords.length || s.name);
    }
    _renderSheet(body) {
      const model = this._sheetModel();
      const names = [...new Set(this.t.chords.map((c) => c.name))];
      body.innerHTML = `<div class="mi-row"><b>${esc(this.t.title)}</b>${this.t.artist ? ' · ' + esc(this.t.artist) : ''}${this.t.key ? ' · Key ' + esc(this.t.key) : ''}${this.capo ? ' · Capo ' + this.capo : ''}<span class="mi-sp"></span><button type="button" data-print>🖨 Print chord sheet</button></div>
        <div class="mi-sheet">${model.length && this.t.chords.length ? model.map((s) => `<div class="mi-sheet-sec">${s.name ? `<h5>${esc(s.name)}</h5>` : ''}<div class="mi-sheet-line">${s.chords.map((c) => `<span>${esc(c)}</span>`).join('')}</div></div>`).join('') : '<div class="mi-muted">Add chords (and sections in the player) to build the sheet.</div>'}
        ${this.t.lyrics ? `<h5>Lyrics</h5><pre class="mi-lyrics">${esc(this.t.lyrics)}</pre>` : ''}</div>
        <div class="mi-diags">${this.kind === 'piano' ? '' : names.map((n) => this._diagCard(n)).join('')}</div>`;
      this._bindDiagCards(body.querySelector('.mi-diags'));
      body.querySelector('[data-print]').addEventListener('click', () => this._print(model, names));
    }
    _print(model, names) {
      const n = this.tuning.length;
      const diags = this.kind === 'piano' ? '' : names.map((nm) => { const s = this.shapeFor(nm); return `<div class="d"><b>${esc(nm)}</b>${s.v ? diagramSvg(s.v, n) : ''}</div>`; }).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(this.t.title)} — chords</title><style>
        body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;margin:28px}h1{margin:0}h2{font-size:13px;color:#555;margin:2px 0 18px}
        h5{margin:14px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#444}.l span{display:inline-block;min-width:54px;font-weight:700;font-size:16px;margin-right:8px}
        .ds{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.d{text-align:center;color:#111}.d b{display:block}pre{font:inherit;white-space:pre-wrap}</style></head><body>
        <h1>${esc(this.t.title)}</h1><h2>${esc([this.t.artist, this.t.key && 'Key ' + this.t.key, this.capo && 'Capo ' + this.capo, ({ guitar: 'Guitar', ukulele: 'Ukulele', bass: 'Bass', piano: 'Piano' })[this.kind] + (this.kind !== 'piano' ? ' · ' + T.tuningLabel(this.kind, this.t.tuning || this.inst.tuning) : '')].filter(Boolean).join(' · '))}</h2>
        ${model.map((s) => `${s.name ? `<h5>${esc(s.name)}</h5>` : ''}<div class="l">${s.chords.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`).join('')}
        ${this.t.lyrics ? `<h5>Lyrics</h5><pre>${esc(this.t.lyrics)}</pre>` : ''}
        <div class="ds">${diags}</div><script>setTimeout(()=>print(),300)<\/script></body></html>`;
      const w = global.open('', '_blank');
      if (!w) { global.uiAlert('Allow pop-ups to print the chord sheet.'); return; }
      w.document.write(html);
      w.document.close();
    }

    // ---------- chord library ----------
    _renderLibrary(body) {
      body.innerHTML = `<div class="mi-row"><input data-libq placeholder="Search a chord: Am7, F#m, Cadd9, D/F#…" list="mi-common2" spellcheck="false" value="${esc(this._libQ || '')}">
          <datalist id="mi-common2">${T.COMMON.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <span class="mi-muted">${esc(({ guitar: 'Guitar', ukulele: 'Ukulele', bass: 'Bass', piano: 'Piano' })[this.kind])} · ${esc(T.tuningLabel(this.kind, this.t.tuning || this.inst.tuning))}${this.capo ? ' · capo ' + this.capo : ''} — change in the Instrument menu</span></div>
        <div class="mi-lib" data-lib></div>`;
      const inp = body.querySelector('[data-libq]');
      const draw = () => {
        const q = inp.value.trim();
        this._libQ = q;
        const box = body.querySelector('[data-lib]');
        if (this.kind === 'piano') { const ch = T.parseChord(q); box.innerHTML = ch ? `<div class="mi-muted">${esc(q)} = ${ch.pcs.map((p) => T.noteName(p)).join(' · ')}</div>` : '<div class="mi-muted">Type a chord name.</div>'; return; }
        if (!q) {
          box.innerHTML = '<div class="mi-diags">' + ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Am', 'Bm', 'Dm', 'Em', 'F#m', 'C7', 'D7', 'E7', 'G7', 'A7', 'B7'].map((n) => this._diagCard(n)).join('') + '</div>';
          this._bindDiagCards(box.querySelector('.mi-diags'));
          return;
        }
        if (!T.parseChord(q)) { box.innerHTML = '<div class="mi-muted">Unknown chord name. Try e.g. Am, Cmaj7, F#m7b5, Dsus4, G/B.</div>'; return; }
        const shapeName = this.capo ? T.transposeChord(q, -this.capo) : q;
        const all = T.voicings(shapeName, this.tuning, { maxFret: 15, max: 8 });
        const ch = T.parseChord(q);
        box.innerHTML = `<div class="mi-muted">${esc(q)} = ${ch.pcs.map((p) => T.noteName(p)).join(' · ')}${this.capo ? ' · shapes for capo ' + this.capo + ' (' + esc(shapeName) + ')' : ''}</div>
          <div class="mi-diags">${all.map((v, i) => `<div class="mi-card big" data-libv="${i}"><div class="mi-card-name">${esc(q)} <small>#${i + 1}</small></div>${diagramSvg(v, this.tuning.length, { w: 120, h: 140 })}<div class="mi-card-acts"><button type="button" data-hearv="${i}">▶</button>${this.readOnly ? '' : `<button type="button" data-lockv="${i}" title="Use this shape for ${esc(q)}">🔒 Use</button>`}</div></div>`).join('') || '<div class="mi-muted">No playable shape found in this tuning.</div>'}</div>`;
        box.querySelectorAll('[data-hearv]').forEach((b) => b.addEventListener('click', () => { const v = all[Number(b.dataset.hearv)]; Synth.strum(v.frets.map((f, i) => (f < 0 ? null : this.tuning[i] + f + this.capo)).filter((x) => x != null), this.synthKind); }));
        box.querySelectorAll('[data-lockv]').forEach((b) => b.addEventListener('click', () => {
          const v = all[Number(b.dataset.lockv)];
          this.col.chordLocks[this.kind + ':' + (this.t.tuning || this.inst.tuning) + ':' + shapeName] = v.frets.join(',');
          delete this.voiceIdx[shapeName];
          this.changed();
          if (global.setStatus) global.setStatus('This shape is now used for ' + q, 'ok');
        }));
      };
      inp.addEventListener('input', draw);
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      draw();
    }

    // ---------- notes / MIDI ----------
    _renderNotes(body) {
      const n = this.t.noteEvents;
      const range = n.length ? T.midiName(Math.min(...n.map((x) => x.p))) + '–' + T.midiName(Math.max(...n.map((x) => x.p))) : '';
      body.innerHTML = `<div class="mi-row">
          ${this.readOnly ? '' : '<button type="button" class="mi-primary" data-midi>⇪ Import MIDI…</button><input type="file" accept=".mid,.midi,audio/midi" data-midifile hidden>'}
          ${n.length ? `<span>${n.length} notes · ${range}</span>` : '<span class="mi-muted">No notes. Import a MIDI file of the melody / riff to see it on the fretboard (note extraction from audio comes with the analysis add-on).</span>'}
          <span class="mi-sp"></span>
          ${n.length ? '<button type="button" data-exp="midi">⇩ MIDI</button><button type="button" data-exp="musicxml">⇩ MusicXML</button><button type="button" data-exp="tab">⇩ Tab (txt)</button>' : ''}
          ${n.length && !this.readOnly ? `<label>Sync offset <input type="number" step="0.05" data-off value="${this.t.noteEventsOffset || 0}"> s</label><button type="button" data-clearnotes class="danger">Clear notes</button>` : ''}
        </div>
        ${n.length ? `<div class="mi-muted">Notes light up on the fretboard while the track plays (orange). Positions are chosen to keep your hand still${this.capo ? ', above the capo' : ''}.</div>
        <div class="mi-noteprev">${n.slice(0, 120).map((x) => `<span title="${U.fmt(x.t, true)}">${T.midiName(x.p)}</span>`).join('')}${n.length > 120 ? '<span>…</span>' : ''}</div>` : ''}`;
      const q = (s) => body.querySelector(s);
      if (q('[data-midi]')) q('[data-midi]').addEventListener('click', () => q('[data-midifile]').click());
      body.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => { const X = global.MusicAnalysis && global.MusicAnalysis.Export; if (X) X[b.dataset.exp](this.t, this.inst); }));
      if (q('[data-midifile]')) q('[data-midifile]').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          let notes = T.parseMidi(await f.arrayBuffer());
          const chans = [...new Set(notes.map((x) => x.ch))];
          if (chans.includes(9) && chans.length > 1) notes = notes.filter((x) => x.ch !== 9); // drop drums
          this.t.noteEvents = notes.slice(0, 20000).map((x) => ({ p: x.p, t: x.t, d: x.d }));
          this.changed();
          this.render();
          if (global.setStatus) global.setStatus('Imported ' + this.t.noteEvents.length + ' notes from ' + f.name, 'ok');
        } catch (err) { global.uiAlert('Could not read that MIDI file: ' + ((err && err.message) || err)); }
      });
      if (q('[data-off]')) q('[data-off]').addEventListener('change', (e) => { this.t.noteEventsOffset = Number(e.target.value) || 0; this._liveKey = ''; this.changed(); });
      if (q('[data-off]')) q('[data-off]').addEventListener('keydown', (e) => e.stopPropagation());
      if (q('[data-clearnotes]')) q('[data-clearnotes]').addEventListener('click', () => { this.t.noteEvents = []; this.changed(); this.render(); });
    }

    // ---------- tuner & metronome ----------
    _renderTools(body) {
      const tun = this.kind === 'piano' ? [] : this.tuning;
      body.innerHTML = `<div class="mi-tools">
        <div class="mi-tool">
          <h5>Tuner</h5>
          <div class="mi-tuner" data-tuner><div class="mi-tnote" data-tnote>—</div><div class="mi-tcents"><i data-tneedle></i></div><div class="mi-tinfo" data-tinfo>Uses the microphone</div></div>
          <div class="mi-row"><button type="button" class="mi-primary" data-tstart>🎤 Start tuner</button>${tun.length ? '<span class="mi-muted">Strings: ' + tun.map((m) => T.midiName(m)).join(' ') + '</span>' : ''}</div>
        </div>
        <div class="mi-tool">
          <h5>Metronome</h5>
          <div class="mi-metro"><button type="button" data-bpm="-5">−5</button><input type="number" min="30" max="300" data-bpmv value="${this.t.bpm || 90}"><button type="button" data-bpm="5">+5</button><span>BPM</span>
            <select data-beats>${[2, 3, 4, 6].map((b) => `<option value="${b}"${b === 4 ? ' selected' : ''}>${b}/4</option>`).join('')}</select>
            <button type="button" data-tap title="Tap a few times">Tap</button></div>
          <div class="mi-beats" data-beatsui></div>
          <div class="mi-row"><button type="button" class="mi-primary" data-mstart>▶ Start metronome</button><label><input type="checkbox" data-mfollow> Follow playback speed</label></div>
        </div></div>`;
      const q = (s) => body.querySelector(s);
      q('[data-tstart]').addEventListener('click', () => (this._tuner ? this._stopTuner() : this._startTuner()));
      q('[data-mstart]').addEventListener('click', () => (this._metro ? this._stopMetro() : this._startMetro()));
      body.querySelectorAll('[data-bpm]').forEach((b) => b.addEventListener('click', () => { const i = q('[data-bpmv]'); i.value = Math.max(30, Math.min(300, Number(i.value) + Number(b.dataset.bpm))); }));
      q('[data-bpmv]').addEventListener('keydown', (e) => e.stopPropagation());
      const taps = [];
      q('[data-tap]').addEventListener('click', () => {
        const now = performance.now();
        taps.push(now);
        while (taps.length > 6) taps.shift();
        if (taps.length >= 3) { const gaps = taps.slice(1).map((x, i) => x - taps[i]); const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length; q('[data-bpmv]').value = Math.round(60000 / avg); }
      });
      this._drawBeats(-1);
    }
    _drawBeats(cur) {
      const ui = this.el.querySelector('[data-beatsui]');
      if (!ui) return;
      const n = Number((this.el.querySelector('[data-beats]') || {}).value || 4);
      ui.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i === cur ? 'on' : ''}${i === 0 ? ' first' : ''}"></i>`).join('');
    }
    _startMetro() {
      const ctx = Synth.ctx();
      const btn = this.el.querySelector('[data-mstart]');
      if (btn) btn.textContent = '■ Stop metronome';
      let beat = 0;
      let next = ctx.currentTime + 0.1;
      const tick = () => {
        const bpmIn = Number((this.el.querySelector('[data-bpmv]') || {}).value) || this.t.bpm || 90;
        const follow = (this.el.querySelector('[data-mfollow]') || {}).checked;
        const bpm = bpmIn * (follow ? (this.t.rate || 1) : 1);
        const beats = Number((this.el.querySelector('[data-beats]') || {}).value || 4);
        while (next < ctx.currentTime + 0.12) {
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.frequency.value = beat % beats === 0 ? 1600 : 1000;
          g.gain.setValueAtTime(0.0001, next); g.gain.exponentialRampToValueAtTime(0.5, next + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, next + 0.06);
          o.connect(g).connect(ctx.destination); o.start(next); o.stop(next + 0.08);
          const shown = beat % beats;
          setTimeout(() => this._drawBeats(shown), Math.max(0, (next - ctx.currentTime) * 1000));
          next += 60 / bpm;
          beat++;
        }
      };
      this._metro = setInterval(tick, 25);
      tick();
    }
    _stopMetro() {
      clearInterval(this._metro); this._metro = null;
      const btn = this.el.querySelector('[data-mstart]');
      if (btn) btn.textContent = '▶ Start metronome';
      this._drawBeats(-1);
    }
    async _startTuner() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const ctx = Synth.ctx();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 4096;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        this._tuner = { stream, src, an };
        const btn = this.el.querySelector('[data-tstart]');
        if (btn) btn.textContent = '■ Stop tuner';
        const loop = () => {
          if (!this._tuner) return;
          an.getFloatTimeDomainData(buf);
          const f = detectPitch(buf, ctx.sampleRate);
          this._showTuner(f);
          this._tuner.raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        global.uiAlert('The microphone is not available: ' + ((e && e.message) || e) + (location.protocol === 'http:' && !/^(localhost|127\.)/.test(location.hostname) ? '\n\nOn other devices the microphone needs HTTPS.' : ''), { title: 'Tuner' });
      }
    }
    _showTuner(f) {
      const note = this.el.querySelector('[data-tnote]');
      const needle = this.el.querySelector('[data-tneedle]');
      const info = this.el.querySelector('[data-tinfo]');
      if (!note) return;
      if (!f) { note.textContent = '—'; info.textContent = 'Play a single string'; needle.style.left = '50%'; needle.className = ''; return; }
      const midiF = 69 + 12 * Math.log2(f / 440);
      const midi = Math.round(midiF);
      const cents = Math.round((midiF - midi) * 100);
      note.textContent = T.midiName(midi);
      needle.style.left = (50 + cents) + '%';
      needle.className = Math.abs(cents) <= 5 ? 'ok' : '';
      let str = '';
      if (this.kind !== 'piano') {
        const tun = this.tuning.map((m) => m + this.capo);
        const near = tun.reduce((a, m, i) => (Math.abs(m - midiF) < Math.abs(tun[a] - midiF) ? i : a), 0);
        const diff = Math.round((midiF - tun[near]) * 100);
        str = ' · string ' + (tun.length - near) + ' (' + T.midiName(tun[near]) + ') ' + (Math.abs(diff) <= 5 ? 'in tune ✓' : diff > 0 ? diff + '¢ sharp — tune down' : -diff + '¢ flat — tune up');
      }
      info.textContent = f.toFixed(1) + ' Hz · ' + (cents > 0 ? '+' : '') + cents + '¢' + str;
    }
    _stopTuner() {
      if (!this._tuner) return;
      cancelAnimationFrame(this._tuner.raf);
      this._tuner.stream.getTracks().forEach((t) => t.stop());
      try { this._tuner.src.disconnect(); } catch (e) { /* ignore */ }
      this._tuner = null;
      const btn = this.el.querySelector('[data-tstart]');
      if (btn) btn.textContent = '🎤 Start tuner';
    }
    _stopTools() { this._stopTuner(); if (this._metro) this._stopMetro(); }

    // Called by the player on every frame / seek.
    tick(sec, force) {
      if (force) this._liveKey = '';
      this._sonify(sec);
      if (this.roll) this.roll.tick(sec);
      if (this.tab === 'fretboard') this._drawLive(sec);
      const strip = this.el.querySelector('[data-strip]');
      if (strip && this.t.chords.length) {
        const { cur } = this.chordAt(sec);
        const id = cur ? cur.id : '';
        if (id !== this._stripCur || force) {
          this._stripCur = id;
          strip.querySelectorAll('[data-cid]').forEach((b) => b.classList.toggle('on', b.dataset.cid === id));
          const on = strip.querySelector('.on');
          if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
          const cards = this.el.querySelectorAll('[data-card]');
          const { next } = this.chordAt(sec);
          cards.forEach((c) => { c.classList.toggle('cur', !!cur && c.dataset.card === cur.name); c.classList.toggle('next', !!next && c.dataset.card === next.name && (!cur || cur.name !== next.name)); });
        }
      }
    }

    // K: add the typed chord at the current time (handled by the player keys).
    key(e) {
      if (e.key === 'k' || e.key === 'K') { this.tab = 'chords'; this.render(); const i = this.el.querySelector('[data-cname]'); if (i) i.focus(); return true; }
      return false;
    }

    destroy() { this._stopTools(); if (this.roll) this.roll.destroy(); }

    // Notes edited (piano roll / import): refresh positions; save if asked.
    notesChanged(save) { this._posSig = null; this._liveKey = ''; if (save) this.changed(); }
    hear(p) { if (this.t.noteSound === 'voice') Synth.voice(p + (this.t.pitch || 0), Synth.ctx().currentTime + 0.01, 0.4, 0.35); else Synth.play(p + (this.t.pitch || 0), 0, this.synthKind, 0.6); }

    // "Notes only" / "Both": play note events with the synth as they pass.
    _sonify(sec) {
      const m = this.player.media;
      const last = this._sonLast;
      this._sonLast = sec;
      if (this.t.playMode === 'original' || m.paused || last == null || sec <= last || sec - last > 0.5) return;
      const off = this.t.notesOffset || 0;
      const minC = this.t.minConf || 0;
      const rate = m.playbackRate || 1;
      const ctx = Synth.ctx();
      const voice = this.t.noteSound === 'voice';
      const tr = this.t.pitch || 0;
      this.t.noteEvents.forEach((n) => {
        const at = n.t + off;
        if (!(at > last && at <= sec && (n.c == null || n.c >= minC))) return;
        const vel = n.v == null ? 0.7 : n.v;
        if (voice) {
          // Glide in from the previous note if it ends right where this starts.
          const prev = this._sonPrev;
          const joined = prev && Math.abs(prev.t + prev.d - n.t) < 0.06 ? prev.p + tr : null;
          Synth.voice(n.p + tr, ctx.currentTime + 0.01, n.d / rate, 0.18 + 0.22 * vel, joined);
          this._sonPrev = n;
        } else Synth.playFor(n.p + tr, ctx.currentTime + 0.01, this.synthKind, 0.25 + 0.5 * vel, n.d / rate);
      });
    }

    // ---------- stems ----------
    async loadStems(force) {
      const t = this.t;
      if (!t.analysis && !force) return;
      try {
        const r = await fetch('/api/music/analysis?media=' + encodeURIComponent(t.media));
        const st = await r.json();
        this.stemFiles = st.stems || [];
      } catch (e) { this.stemFiles = []; }
      if (this.player._dead) return;
      await this.player.setStems(this.stemFiles);
      if (this.tab === 'stems') this.render();
    }
    _renderStems(body) {
      const t = this.t;
      const files = this.stemFiles || [];
      const eng = this.opts.engine;
      if (!files.length) {
        body.innerHTML = `<div class="mi-row"><span class="mi-muted">No stems for this track yet. Separating needs the music analysis add-on; it splits the song into vocals, drums, bass, guitar, piano and other.</span><span class="mi-sp"></span>${this.readOnly || !eng ? '' : '<button type="button" class="mi-primary" data-sep>Separate stems…</button>'}</div>`;
        const b = body.querySelector('[data-sep]');
        if (b) b.addEventListener('click', () => global.MusicAnalysis.analyzeDialog(eng, [t], ['stems']));
        return;
      }
      const mix = t.stems.mix;
      const get = (n) => mix[n] || (mix[n] = { vol: 1, mute: false, solo: false });
      const PRESETS = [['all', 'All'], ['karaoke', 'No vocals'], ['noguitar', 'No guitar'], ['vocals', 'Vocals only'], ['guitar', 'Guitar only'], ['rhythm', 'Drums + bass']];
      body.innerHTML = `<div class="mi-row"><label class="mi-switch"><input type="checkbox" data-son${t.stems.on ? ' checked' : ''}> <b>Play stems</b> (instead of the original)</label><span class="mi-sp"></span>${PRESETS.map(([k, l]) => `<button type="button" data-preset="${k}">${l}</button>`).join('')}</div>
        <div class="mi-stems">${files.map((f) => { const m = get(f.name); return `<div class="mi-stem" data-stem="${esc(f.name)}"><b>${esc(f.name[0].toUpperCase() + f.name.slice(1))}</b>
          <button type="button" data-mute class="${m.mute ? 'on' : ''}" title="Mute">M</button><button type="button" data-solo class="${m.solo ? 'on' : ''}" title="Solo">S</button>
          <input type="range" min="0" max="1.5" step="0.05" value="${m.vol}" data-vol><span>${Math.round(m.vol * 100)}%</span>
          <a href="${U.rawUrl(f.path)}" download="${esc(t.title + ' - ' + f.name)}.mp3" title="Download">⇩</a></div>`; }).join('')}</div>
        <div class="mi-muted">Loops, speed and pitch apply to the stem mix.</div>`;
      const apply = (save) => { this.player.applyStemMix(); if (save !== false) this.changed(); };
      body.querySelector('[data-son]').addEventListener('change', (e) => { t.stems.on = e.target.checked; apply(); });
      body.querySelectorAll('[data-stem]').forEach((row) => {
        const m = get(row.dataset.stem);
        row.querySelector('[data-mute]').addEventListener('click', (e) => { m.mute = !m.mute; e.target.classList.toggle('on', m.mute); if (!t.stems.on) { t.stems.on = true; body.querySelector('[data-son]').checked = true; } apply(); });
        row.querySelector('[data-solo]').addEventListener('click', (e) => { m.solo = !m.solo; e.target.classList.toggle('on', m.solo); if (!t.stems.on) { t.stems.on = true; body.querySelector('[data-son]').checked = true; } apply(); });
        const vol = row.querySelector('[data-vol]');
        vol.addEventListener('input', () => { m.vol = Number(vol.value); row.querySelector('span').textContent = Math.round(m.vol * 100) + '%'; apply(false); });
        vol.addEventListener('change', () => this.changed());
      });
      body.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.preset;
        files.forEach((f) => {
          const m = get(f.name);
          m.solo = false; m.vol = 1;
          m.mute = k === 'karaoke' ? f.name === 'vocals' : k === 'noguitar' ? f.name === 'guitar' : k === 'vocals' ? f.name !== 'vocals' : k === 'guitar' ? f.name !== 'guitar' : k === 'rhythm' ? !['drums', 'bass'].includes(f.name) : false;
        });
        t.stems.on = true;
        apply();
        this.render();
      }));
    }
  }

  // Autocorrelation pitch detection (YIN-style difference function).
  function detectPitch(buf, sr) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / buf.length) < 0.01) return null;
    const half = Math.floor(buf.length / 2);
    const d = new Float32Array(half);
    for (let tau = 1; tau < half; tau++) { let s = 0; for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + tau]; s += x * x; } d[tau] = s; }
    let run = 0; d[0] = 1;
    for (let tau = 1; tau < half; tau++) { run += d[tau]; d[tau] = d[tau] * tau / (run || 1); }
    const minTau = Math.floor(sr / 1400); const maxTau = Math.min(half - 1, Math.floor(sr / 35));
    let tau = -1;
    for (let t = minTau; t < maxTau; t++) if (d[t] < 0.12) { while (t + 1 < maxTau && d[t + 1] < d[t]) t++; tau = t; break; }
    if (tau < 0) return null;
    const a = d[tau - 1]; const b = d[tau]; const c = d[tau + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    return sr / (tau + (Number.isFinite(shift) ? shift : 0));
  }

  global.MusicInstrument = InstrumentPanel;
  global.MusicSynth = Synth;
  global.MusicDiagram = diagramSvg;
})(typeof window !== 'undefined' ? window : this);
