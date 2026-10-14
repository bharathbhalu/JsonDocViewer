/* DocViewer music player (phase 2) — one track: transport, speed and pitch,
 * waveform with song sections / markers / loop region, A–B loop with saved
 * loops (edit / update / rename / delete), speed trainer, count-in, video
 * tools (mirror, zoom & pan, frame step, picture-in-picture), keyboard
 * shortcuts, and hand-off to a mini-player that keeps playing when you switch
 * files. Used by MusicEngine; all state lives on the track object. */
(function (global) {
  const C = global.MusicCore;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const relOf = (media) => String(media || '').replace(/^\/+/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } }).join('/');
  const rawUrl = (media) => '/api/raw?path=' + encodeURIComponent(relOf(media));
  const fmt = (sec, tenths) => {
    if (!(sec >= 0)) return '–';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = String(s % 60).padStart(2, '0');
    return m + ':' + r + (tenths ? '.' + Math.floor((sec - s) * 10) : '');
  };
  // "1:23", "1:02:03", "83", "83.5" → seconds
  const parseTime = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    if (!m) return null;
    return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  const RATES = [0.25, 0.5, 0.6, 0.75, 0.85, 1, 1.25, 1.5, 2];
  const peaksCache = new Map();

  // ---------- pitch shifter (AudioWorklet, two crossfaded delay taps) ----------
  const WORKLET = `class AccPitch extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4 }]; }
    constructor() { super(); this.N = 16384; this.win = 2400; this.buf = [new Float32Array(this.N), new Float32Array(this.N)]; this.w = 0; this.ph = 0; }
    read(b, d) { let i = this.w - d; while (i < 0) i += this.N; const i0 = Math.floor(i); const f = i - i0; return b[i0 % this.N] * (1 - f) + b[(i0 + 1) % this.N] * f; }
    process(inputs, outputs, params) {
      const inp = inputs[0]; const out = outputs[0];
      if (!inp || !inp.length) return true;
      const ratio = params.ratio[0];
      for (let i = 0; i < out[0].length; i++) {
        for (let c = 0; c < out.length; c++) this.buf[c & 1][this.w] = (inp[c] || inp[0])[i];
        this.ph += (1 - ratio) / this.win; if (this.ph >= 1) this.ph -= 1; if (this.ph < 0) this.ph += 1;
        const p2 = (this.ph + 0.5) % 1;
        const g1 = Math.sin(Math.PI * this.ph) ** 2; const g2 = Math.sin(Math.PI * p2) ** 2;
        for (let c = 0; c < out.length; c++) { const b = this.buf[c & 1]; out[c][i] = this.read(b, this.ph * this.win + 1) * g1 + this.read(b, p2 * this.win + 1) * g2; }
        this.w = (this.w + 1) % this.N;
      }
      return true;
    }
  }
  registerProcessor('acc-pitch', AccPitch);`;

  class MusicPlayer {
    constructor(track, opts) {
      this.t = track;
      this.opts = opts || {};
      this.readOnly = !!this.opts.readOnly;
      this.editLoopId = null;
      this.repeatCount = 0;
      this.trainerOn = false;
      this.el = document.createElement('div');
      this.el.className = 'mp-root';
      this._build();
    }

    get media() { return this.mediaEl; }
    changed() { if (this.opts.onChange) this.opts.onChange(); }

    // ---------- DOM ----------
    _build() {
      const t = this.t;
      const video = t.kind === 'video';
      this.el.innerHTML = `
        ${video ? `<div class="mp-video-wrap" data-vwrap><video class="mp-video" data-media preload="metadata" playsinline src="${rawUrl(t.media)}"></video>
          <div class="mp-vbadge" data-vbadge></div></div>
          <div class="mp-vtools">
            <button type="button" data-v="mirror" title="Flip left–right (⇧V)">⇋ Mirror</button>
            <span class="mp-vzoom">🔍 <input type="range" min="1" max="4" step="0.05" data-vzoom title="Zoom (drag the picture to pan)"></span>
            <button type="button" data-v="zreset" title="Reset zoom">Reset</button>
            <button type="button" data-v="fprev" title="Previous frame (,)">⏮︎ Frame</button>
            <button type="button" data-v="fnext" title="Next frame (.)">Frame ⏭︎</button>
            <span class="mp-sp"></span>
            <button type="button" data-v="pip" title="Picture-in-picture">⧉ Pop out</button>
            <button type="button" data-v="full" title="Fullscreen">⛶</button>
            <button type="button" data-v="hide" title="Hide / show video (V)">Hide video</button>
          </div>` : `<audio data-media preload="metadata" src="${rawUrl(t.media)}"></audio>`}
        <div class="mp-transport">
          <button type="button" class="mp-play" data-act="play" title="Play / pause (Space)">▶</button>
          <button type="button" data-act="back" title="Back 5 s (←)">↺5</button>
          <button type="button" data-act="fwd" title="Forward 5 s (→)">5↻</button>
          <span class="mp-time" data-time>0:00 / 0:00</span>
          <span class="mp-sep"></span>
          <button type="button" class="mp-loopbtn" data-act="loop" title="Loop on / off (L)">⟳ Loop</button>
          <span class="mp-sep"></span>
          <span class="mp-lbl">Speed</span>
          <button type="button" data-act="slower" title="Slower (−)">−</button>
          <select data-rate title="Speed">${RATES.map((r) => `<option value="${r}">${r}×</option>`).join('')}<option value="custom">Custom</option></select>
          <button type="button" data-act="faster" title="Faster (+)">+</button>
          <span class="mp-sep"></span>
          <span class="mp-lbl">Pitch</span>
          <button type="button" data-act="pdown" title="Pitch down a semitone (⇧−)">−</button>
          <b class="mp-pitch" data-pitch>0</b>
          <button type="button" data-act="pup" title="Pitch up a semitone (⇧+)">+</button>
          <span class="mp-sp"></span>
          <span class="mp-vol">🔊 <input type="range" min="0" max="1" step="0.01" data-vol></span>
        </div>
        <div class="mp-wave" data-wave tabindex="-1" title="Click to seek · drag to make a loop · drag the loop edges to adjust">
          <div class="mp-secs" data-secs></div>
          <canvas data-canvas></canvas>
          <div class="mp-loopr" data-loopr><span class="mp-h l" data-h="a"></span><span class="mp-h r" data-h="b"></span></div>
          <div class="mp-marks" data-marks></div>
          <div class="mp-head" data-head></div>
          <div class="mp-wave-msg" data-wmsg>Reading waveform…</div>
        </div>
        <div class="mp-cols">
          <div class="mp-col">
            <h4>A–B loop <label class="mp-on"><input type="checkbox" data-loop-on> on</label></h4>
            <div class="mp-ab">
              <input data-a placeholder="start" spellcheck="false"><button type="button" data-set="a" title="Start here ([)">now</button>
              <span>→</span>
              <input data-b placeholder="end" spellcheck="false"><button type="button" data-set="b" title="End here (])">now</button>
            </div>
            <div class="mp-opts">
              <label>Gap <input type="number" min="0" max="10" step="0.5" data-gap> s</label>
              <label><input type="checkbox" data-countin> Count-in</label>
              <label>Repeat <input type="number" min="0" max="999" data-repeats title="0 = forever"> ×</label>
            </div>
            <div class="mp-row-acts">
              <button type="button" data-act="mksec" title="Name this range as a song section">＋ Section from loop</button>
              <button type="button" data-act="clearloop">Clear</button>
            </div>
            <h4>Saved loops <span class="mp-acts"><button type="button" data-act="cancel-edit" hidden>Cancel</button><button type="button" class="mp-primary" data-act="save-loop">＋ Save loop</button></span></h4>
            <div class="mp-saved" data-saved></div>
            <h4>Speed trainer <label class="mp-on"><input type="checkbox" data-trainer> on</label></h4>
            <div class="mp-opts">
              <label>From <input type="number" min="0.25" max="2" step="0.05" data-tr="from">×</label>
              <label>to <input type="number" min="0.25" max="2" step="0.05" data-tr="to">×</label>
              <label>+<input type="number" min="0.01" max="0.5" step="0.01" data-tr="step"> every <input type="number" min="1" max="50" data-tr="every"> loops</label>
            </div>
            <div class="mp-trainer-bar" data-trbar><i></i><span></span></div>
          </div>
          <div class="mp-col">
            <h4>Sections <span class="mp-hint">click to loop</span></h4>
            <div class="mp-list" data-seclist></div>
            <h4>Markers <span class="mp-acts"><button type="button" data-act="marker" title="Add a marker here (M)">＋ Marker</button></span></h4>
            <div class="mp-list" data-marklist></div>
          </div>
        </div>`;
      this.mediaEl = this.el.querySelector('[data-media]');
      this._stemTick = 0;
      this.mediaEl.addEventListener('ratechange', () => this._syncStems());
      this.mediaEl.addEventListener('volumechange', () => this._syncStems());
      this.canvas = this.el.querySelector('[data-canvas]');
      this._bind();
      this._applyState();
      this._loadPeaks();
      this._syncAll();
    }

    _q(s) { return this.el.querySelector(s); }

    // ---------- audio graph (pitch) ----------
    // media → srcGain ─┐
    // stems → gains ────┴→ bus → (pitch shifter) → destination
    _ensureGraph() {
      if (this.ctx) return this._workletReady || Promise.resolve();
      try {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
        this.src = this.ctx.createMediaElementSource(this.mediaEl);
        this.srcGain = this.ctx.createGain();
        this.bus = this.ctx.createGain();
        this.src.connect(this.srcGain).connect(this.bus);
        this.bus.connect(this.ctx.destination);
        this._applyMute();
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        this._workletReady = this.ctx.audioWorklet.addModule(url).then(() => { this.shifter = new AudioWorkletNode(this.ctx, 'acc-pitch', { outputChannelCount: [2] }); }).catch(() => { this.shifter = null; });
        return this._workletReady;
      } catch (e) { return Promise.resolve(); }
    }
    async _applyPitch() {
      const p = this.t.pitch || 0;
      this._q('[data-pitch]').textContent = (p > 0 ? '+' : '') + p;
      if (!p && !this.ctx) return;
      await this._ensureGraph();
      if (!this.ctx) return;
      try { this.bus.disconnect(); if (this.shifter) this.shifter.disconnect(); } catch (e) { /* ignore */ }
      if (p && this.shifter) {
        this.shifter.parameters.get('ratio').value = Math.pow(2, p / 12);
        this.bus.connect(this.shifter).connect(this.ctx.destination);
      } else this.bus.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    // ---------- stems (from the analysis add-on) ----------
    // list: [{ name, path }]. Stems play as hidden media elements kept in
    // sync with the main one (which stays the clock, muted while stems play).
    async setStems(list) {
      this._dropStems();
      this.stemList = list || [];
      if (!this.stemList.length) return;
      await this._ensureGraph();
      if (!this.ctx || this._dead) return;
      this.stems = this.stemList.map((st) => {
        const el = new Audio();
        el.preload = 'auto';
        el.preservesPitch = true;
        el.src = rawUrl(st.path);
        const node = this.ctx.createMediaElementSource(el);
        const gain = this.ctx.createGain();
        node.connect(gain).connect(this.bus);
        return { name: st.name, el, node, gain };
      });
      this.applyStemMix();
    }
    _dropStems() {
      (this.stems || []).forEach((s) => { try { s.el.pause(); s.node.disconnect(); s.gain.disconnect(); s.el.removeAttribute('src'); s.el.load(); } catch (e) { /* ignore */ } });
      this.stems = [];
    }
    get stemsOn() { return !!(this.t.stems.on && this.stems && this.stems.length); }
    applyStemMix() {
      const mix = this.t.stems.mix;
      const anySolo = (this.stems || []).some((s) => mix[s.name] && mix[s.name].solo);
      (this.stems || []).forEach((s) => {
        const m = mix[s.name] || { vol: 1 };
        const v = anySolo ? (m.solo ? m.vol : 0) : (m.mute ? 0 : (m.vol == null ? 1 : m.vol));
        s.gain.gain.value = this.stemsOn ? v : 0;
      });
      this._applyMute();
      this._syncStems(true);
    }
    // What is heard: "notes" mode silences the recording (synth only).
    _applyMute() {
      if (!this.srcGain) return;
      const silent = this.t.playMode === 'notes';
      this.srcGain.gain.value = silent || this.stemsOn ? 0 : 1;
      this.bus.gain.value = silent ? 0 : 1;
    }
    async setPlayMode(mode) {
      this.t.playMode = mode;
      if (mode !== 'original' || this.ctx) { await this._ensureGraph(); this._applyMute(); }
      this.changed();
    }
    _syncStems(force) {
      if (!this.stems || !this.stems.length) return;
      const m = this.mediaEl;
      const on = this.stemsOn;
      this.stems.forEach((s) => {
        const el = s.el;
        el.volume = m.volume;
        if (el.playbackRate !== m.playbackRate) el.playbackRate = m.playbackRate;
        if (!on || m.paused) { if (!el.paused) el.pause(); if (force && on) el.currentTime = m.currentTime; return; }
        if (force || Math.abs(el.currentTime - m.currentTime) > 0.08) el.currentTime = m.currentTime;
        if (el.paused) el.play().catch(() => {});
      });
    }

    // ---------- state → media ----------
    _applyState() {
      const m = this.mediaEl;
      const t = this.t;
      m.preservesPitch = true;
      m.playbackRate = t.rate || 1;
      let vol = 1;
      try { const sv = localStorage.getItem('docviewer-music-vol'); vol = sv == null || sv === '' ? 1 : Number(sv); if (!(vol >= 0 && vol <= 1)) vol = 1; } catch (e) { /* default */ }
      m.volume = vol;
      this._q('[data-vol]').value = vol;
      if (t.pitch) this._applyPitch();
      if (t.playMode === 'notes') this.setPlayMode('notes');
      if (t.kind === 'video') this._applyVideo();
    }

    _applyVideo() {
      const v = this.t.video;
      const vid = this.mediaEl;
      const z = v.zoom.s || 1;
      vid.style.transformOrigin = (v.zoom.x * 100) + '% ' + (v.zoom.y * 100) + '%';
      vid.style.transform = `scale(${v.mirror ? -z : z}, ${z})`;
      const wrap = this._q('[data-vwrap]');
      if (wrap) wrap.classList.toggle('hidden', !v.show);
      const zr = this._q('[data-vzoom]');
      if (zr) zr.value = z;
      const mb = this.el.querySelector('[data-v="mirror"]');
      if (mb) mb.classList.toggle('on', v.mirror);
      const hb = this.el.querySelector('[data-v="hide"]');
      if (hb) hb.textContent = v.show ? 'Hide video' : 'Show video';
      const badge = this._q('[data-vbadge]');
      if (badge) {
        const bits = [];
        if ((this.t.rate || 1) !== 1) bits.push(this.t.rate + '×');
        if (this.t.loop.on) bits.push('⟳ ' + fmt(this.t.loop.a) + '–' + fmt(this.t.loop.b));
        if (v.mirror) bits.push('Mirrored ⇋');
        if (z > 1.01) bits.push('Zoom ' + z.toFixed(1) + '×');
        badge.textContent = bits.join(' · ');
        badge.hidden = !bits.length;
      }
    }

    setRate(r) {
      const t = this.t;
      t.rate = Math.max(0.25, Math.min(2, Math.round(r * 100) / 100));
      this.mediaEl.playbackRate = t.rate;
      this._syncRate();
      if (t.kind === 'video') this._applyVideo();
      this.changed();
    }
    setPitch(p) {
      this.t.pitch = Math.max(-12, Math.min(12, Math.round(p)));
      this._applyPitch();
      this.changed();
    }

    // ---------- loop ----------
    setLoop(patch) {
      const l = this.t.loop;
      Object.assign(l, patch);
      if (l.a != null && l.b != null && l.b < l.a) { const x = l.a; l.a = l.b; l.b = x; }
      if (('a' in patch || 'b' in patch) && l.a != null && l.b != null && !('on' in patch)) l.on = true;
      if (l.on && (l.a == null || l.b == null || l.b - l.a < 0.2)) l.on = false;
      this.repeatCount = 0;
      if (l.on) {
        const cur = this.mediaEl.currentTime;
        if (cur < l.a || cur >= l.b) this.mediaEl.currentTime = l.a;
      }
      this._syncLoop();
      this.drawOverlay();
      if (this.t.kind === 'video') this._applyVideo();
      this.changed();
    }

    _onTime() {
      const m = this.mediaEl;
      const l = this.t.loop;
      if (l.on && !this._looping && m.currentTime >= l.b - 0.05) this._wrapLoop();
      this._syncTime();
    }

    async _wrapLoop() {
      const m = this.mediaEl;
      const l = this.t.loop;
      this.repeatCount++;
      if (l.repeats && this.repeatCount >= l.repeats) {
        m.pause();
        m.currentTime = l.a;
        this.repeatCount = 0;
        if (global.setStatus) global.setStatus('Loop finished (' + l.repeats + '×)', 'ok');
        return;
      }
      // Speed trainer: speed up every N loops until the target.
      if (this.trainerOn && this.repeatCount % this.t.trainer.every === 0 && (this.t.rate || 1) < this.t.trainer.to) {
        this.setRate(Math.min(this.t.trainer.to, (this.t.rate || 1) + this.t.trainer.step));
        if (global.setStatus) global.setStatus('Speed trainer: ' + Math.round(this.t.rate * 100) + '%', 'ok');
      }
      this._syncTrainer();
      if (!l.gap && !l.countIn) { m.currentTime = l.a; return; }
      this._looping = true;
      m.pause();
      m.currentTime = l.a;
      if (l.gap) await new Promise((r) => setTimeout(r, l.gap * 1000));
      if (l.countIn) await this._countIn();
      this._looping = false;
      if (this.t.loop.on) m.play().catch(() => {});
    }

    // Four clicks at the song tempo (or 90 BPM).
    async _countIn() {
      await this._ensureGraph();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      const beat = 60 / ((this.t.bpm || 90) * (this.t.rate || 1));
      const t0 = this.ctx.currentTime + 0.05;
      for (let i = 0; i < 4; i++) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.value = i === 0 ? 1500 : 1000;
        g.gain.setValueAtTime(0.0001, t0 + i * beat);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + i * beat + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * beat + 0.08);
        o.connect(g).connect(this.ctx.destination);
        o.start(t0 + i * beat);
        o.stop(t0 + i * beat + 0.1);
      }
      await new Promise((r) => setTimeout(r, beat * 4000));
    }

    // ---------- saved loops ----------
    async saveLoop() {
      if (this.readOnly) return;
      const l = this.t.loop;
      if (l.a == null || l.b == null) { global.uiAlert('Set a loop start and end first ([ and ] keys, the now buttons, or drag on the waveform).', { title: 'Save loop' }); return; }
      if (this.editLoopId) return this._updateLoop();
      const suggest = this._sectionNameAt((l.a + l.b) / 2) || 'Loop ' + (this.t.savedLoops.length + 1);
      const name = await global.uiPrompt(`Name for ${fmt(l.a)} → ${fmt(l.b)} at ${this.t.rate || 1}×${this.t.pitch ? ', pitch ' + (this.t.pitch > 0 ? '+' : '') + this.t.pitch : ''}`, suggest, { title: 'Save loop', okLabel: 'Save' });
      if (name == null) return;
      this.t.savedLoops.push({ id: C.uid('l_'), name: String(name).trim().slice(0, 80) || suggest, a: l.a, b: l.b, rate: this.t.rate || 1, pitch: this.t.pitch || 0, video: JSON.parse(JSON.stringify(this.t.video)), note: '' });
      this._syncSaved();
      this.changed();
    }
    useLoop(id) {
      const s = this.t.savedLoops.find((x) => x.id === id);
      if (!s) return;
      this.setRate(s.rate || 1);
      this.setPitch(s.pitch || 0);
      if (this.t.kind === 'video' && s.video) { this.t.video = Object.assign(this.t.video, JSON.parse(JSON.stringify(s.video)), { show: this.t.video.show }); this._applyVideo(); }
      this.setLoop({ a: s.a, b: s.b, on: true });
      this.mediaEl.currentTime = s.a;
      this._syncSaved();
    }
    editLoop(id) {
      if (this.readOnly) return;
      this.useLoop(id);
      this.editLoopId = id;
      this._syncSaved();
    }
    _updateLoop() {
      const s = this.t.savedLoops.find((x) => x.id === this.editLoopId);
      this.editLoopId = null;
      if (s) {
        Object.assign(s, { a: this.t.loop.a, b: this.t.loop.b, rate: this.t.rate || 1, pitch: this.t.pitch || 0, video: JSON.parse(JSON.stringify(this.t.video)) });
        if (global.setStatus) global.setStatus('Updated loop "' + s.name + '"', 'ok');
        this.changed();
      }
      this._syncSaved();
    }
    async renameLoop(id) {
      const s = this.t.savedLoops.find((x) => x.id === id);
      if (!s || this.readOnly) return;
      const n = await global.uiPrompt('Loop name', s.name, { title: 'Rename loop', okLabel: 'Rename' });
      if (n == null || !String(n).trim()) return;
      s.name = String(n).trim().slice(0, 80);
      this._syncSaved();
      this.changed();
    }

    // ---------- markers & sections ----------
    addMarker() {
      if (this.readOnly) return;
      const time = Math.round(this.mediaEl.currentTime * 10) / 10;
      this.t.markers.push({ id: C.uid('m_'), t: time, name: 'Marker ' + (this.t.markers.length + 1) });
      this.t.markers.sort((a, b) => a.t - b.t);
      this._syncMarkers();
      this.drawOverlay();
      this.changed();
    }
    async sectionFromLoop() {
      const l = this.t.loop;
      if (this.readOnly || l.a == null || l.b == null) { if (!this.readOnly) global.uiAlert('Set a loop range first, then name it as a section.', { title: 'Section' }); return; }
      const n = await global.uiPrompt('Section name (e.g. Intro, Verse 1, Chorus, Solo)', 'Chorus', { title: 'New section', okLabel: 'Add' });
      if (n == null || !String(n).trim()) return;
      this.t.sectionsTimeline.push({ id: C.uid('r_'), name: String(n).trim().slice(0, 80), a: l.a, b: l.b });
      this.t.sectionsTimeline.sort((a, b) => a.a - b.a);
      this._syncSections();
      this.drawOverlay();
      this.changed();
    }
    _sectionNameAt(sec) {
      const s = this.t.sectionsTimeline.find((x) => sec >= x.a && sec < x.b);
      return s ? s.name : '';
    }

    // ---------- waveform ----------
    async _loadPeaks() {
      const key = this.t.media;
      const msg = this._q('[data-wmsg]');
      try {
        let peaks = peaksCache.get(key);
        if (!peaks) {
          const buf = await (await fetch(rawUrl(this.t.media))).arrayBuffer();
          const AC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
          const ctx = new AC(1, 44100, 44100);
          const audio = await ctx.decodeAudioData(buf);
          const N = 1600;
          const ch = audio.getChannelData(0);
          const ch2 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
          const step = Math.max(1, Math.floor(ch.length / N));
          peaks = new Float32Array(N);
          let max = 0;
          for (let i = 0; i < N; i++) {
            let m = 0;
            const end = Math.min(ch.length, (i + 1) * step);
            for (let j = i * step; j < end; j += 4) { const v = Math.abs(ch[j]) + (ch2 ? Math.abs(ch2[j]) : 0); if (v > m) m = v; }
            peaks[i] = m;
            if (m > max) max = m;
          }
          if (max > 0) for (let i = 0; i < N; i++) peaks[i] /= max;
          peaksCache.set(key, peaks);
          if (peaksCache.size > 30) peaksCache.delete(peaksCache.keys().next().value);
        }
        this.peaks = peaks;
        if (msg) msg.hidden = true;
      } catch (e) {
        this.peaks = null;
        if (msg) msg.textContent = 'No waveform for this file (it still plays).';
      }
      this.drawWave();
    }

    drawWave() {
      const cv = this.canvas;
      if (!cv || !cv.isConnected) return;
      const dpr = global.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const dark = document.documentElement.dataset.theme === 'dark';
      const p = this.peaks;
      const dur = this.mediaEl.duration || this.t.duration || 0;
      const played = dur ? this.mediaEl.currentTime / dur : 0;
      const bars = Math.floor(w / 2);
      for (let i = 0; i < bars; i++) {
        const v = p ? p[Math.floor((i / bars) * p.length)] : 0.15;
        const bh = Math.max(1.5, v * (h - 6));
        g.fillStyle = i / bars < played ? (dark ? '#8aa8d4' : '#4f6ef7') : (dark ? 'rgba(170,185,215,.45)' : 'rgba(79,110,247,.32)');
        g.fillRect(i * 2, (h - bh) / 2, 1.4, bh);
      }
      this.drawOverlay();
    }

    drawOverlay() {
      const dur = this.mediaEl.duration || this.t.duration || 0;
      const pct = (s) => (dur ? Math.max(0, Math.min(100, (s / dur) * 100)) : 0);
      const l = this.t.loop;
      const lr = this._q('[data-loopr]');
      if (lr) {
        const show = l.a != null && l.b != null && dur;
        lr.hidden = !show;
        if (show) { lr.style.left = pct(l.a) + '%'; lr.style.width = (pct(l.b) - pct(l.a)) + '%'; lr.classList.toggle('off', !l.on); }
      }
      const secs = this._q('[data-secs]');
      if (secs) secs.innerHTML = dur ? this.t.sectionsTimeline.map((s) => `<div class="mp-sec" data-secid="${esc(s.id)}" style="left:${pct(s.a)}%;width:${pct(s.b) - pct(s.a)}%" title="${esc(s.name)} ${fmt(s.a)}–${fmt(s.b)} · click to loop">${esc(s.name)}</div>`).join('') : '';
      const marks = this._q('[data-marks]');
      if (marks) marks.innerHTML = dur ? this.t.markers.map((m) => `<div class="mp-mark" data-mid="${esc(m.id)}" style="left:${pct(m.t)}%" title="${esc(m.name)} · ${fmt(m.t)} · click to jump, drag to move"><span>${esc(m.name)}</span></div>`).join('') : '';
      this._syncHead();
    }

    _syncHead() {
      const dur = this.mediaEl.duration || this.t.duration || 0;
      const head = this._q('[data-head]');
      if (head) head.style.left = (dur ? (this.mediaEl.currentTime / dur) * 100 : 0) + '%';
    }

    _xToTime(clientX) {
      const r = this.canvas.getBoundingClientRect();
      const dur = this.mediaEl.duration || this.t.duration || 0;
      return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
    }

    // ---------- sync UI ----------
    _syncAll() { this._syncTime(); this._syncRate(); this._syncLoop(); this._syncSaved(); this._syncSections(); this._syncMarkers(); this._syncTrainer(); }
    _syncTime() {
      const m = this.mediaEl;
      const tm = this._q('[data-time]');
      if (tm) tm.textContent = fmt(m.currentTime) + ' / ' + fmt(m.duration || this.t.duration || 0);
      const pb = this._q('[data-act="play"]');
      if (pb) pb.textContent = m.paused ? '▶' : '❚❚';
      this._syncHead();
      const now = Date.now();
      if (this.peaks && (!this._lastDraw || now - this._lastDraw > 250)) { this._lastDraw = now; this.drawWave(); }
    }
    _syncRate() {
      const sel = this._q('[data-rate]');
      const r = this.t.rate || 1;
      if (!RATES.includes(r)) {
        let o = sel.querySelector('option[data-cur]');
        if (!o) { o = document.createElement('option'); o.dataset.cur = '1'; sel.insertBefore(o, sel.lastChild); }
        o.value = r; o.textContent = r + '×';
      } else { const o = sel.querySelector('option[data-cur]'); if (o) o.remove(); }
      sel.value = String(r);
    }
    _syncLoop() {
      const l = this.t.loop;
      const a = this._q('[data-a]');
      const b = this._q('[data-b]');
      if (document.activeElement !== a) a.value = l.a == null ? '' : fmt(l.a, true);
      if (document.activeElement !== b) b.value = l.b == null ? '' : fmt(l.b, true);
      this._q('[data-loop-on]').checked = l.on;
      this._q('[data-loop-on]').disabled = this.readOnly || l.a == null || l.b == null;
      this._q('[data-gap]').value = l.gap || 0;
      this._q('[data-countin]').checked = !!l.countIn;
      this._q('[data-repeats]').value = l.repeats || 0;
      this.el.querySelector('.mp-loopbtn').classList.toggle('on', l.on);
      this.el.classList.toggle('looping', l.on);
    }
    _syncSaved() {
      const box = this._q('[data-saved]');
      const l = this.t.loop;
      const rate = this.t.rate || 1;
      box.innerHTML = this.t.savedLoops.length ? this.t.savedLoops.map((s, i) => {
        const active = l.on && Math.abs(l.a - s.a) < 0.05 && Math.abs(l.b - s.b) < 0.05 && Math.abs(rate - s.rate) < 0.001;
        const editing = this.editLoopId === s.id;
        return `<div class="mp-saved-item${active ? ' on' : ''}${editing ? ' editing' : ''}" data-use="${esc(s.id)}" title="${i < 9 ? 'Key ' + (i + 1) + ' · ' : ''}play this loop · double-click to rename">
          <b>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}${esc(s.name)}</b><span>${fmt(s.a)}–${fmt(s.b)}${s.rate !== 1 ? ' · ' + s.rate + '×' : ''}${s.pitch ? ' · ' + (s.pitch > 0 ? '+' : '') + s.pitch : ''}${s.video && s.video.mirror ? ' · ⇋' : ''}</span>
          ${this.readOnly ? '' : `<i data-edit="${esc(s.id)}" title="Edit start, end, speed (then Update)">✎</i><i data-del="${esc(s.id)}" title="Delete">×</i>`}</div>`;
      }).join('') : '<div class="mp-empty">Set a loop and speed, then ＋ Save loop.</div>';
      const editing = this.editLoopId && this.t.savedLoops.find((x) => x.id === this.editLoopId);
      if (!editing) this.editLoopId = null;
      const sb = this._q('[data-act="save-loop"]');
      sb.textContent = editing ? '✓ Update "' + editing.name.slice(0, 16) + '"' : '＋ Save loop';
      sb.hidden = this.readOnly;
      this._q('[data-act="cancel-edit"]').hidden = !editing;
      this.el.classList.toggle('editing-loop', !!editing);
    }
    _syncSections() {
      const box = this._q('[data-seclist]');
      box.innerHTML = this.t.sectionsTimeline.length ? this.t.sectionsTimeline.map((s) => `<div class="mp-li" data-loopsec="${esc(s.id)}"><b>${esc(s.name)}</b><span>${fmt(s.a)}–${fmt(s.b)}</span>${this.readOnly ? '' : `<i data-rensec="${esc(s.id)}" title="Rename">✎</i><i data-delsec="${esc(s.id)}" title="Delete">×</i>`}</div>`).join('') : '<div class="mp-empty">Make a loop, then ＋ Section from loop (Intro, Verse, Chorus…).</div>';
    }
    _syncMarkers() {
      const box = this._q('[data-marklist]');
      box.innerHTML = this.t.markers.length ? this.t.markers.map((m) => `<div class="mp-li" data-jump="${m.t}"><span>${fmt(m.t, true)}</span><b>${esc(m.name)}</b>${this.readOnly ? '' : `<i data-renmark="${esc(m.id)}" title="Rename">✎</i><i data-delmark="${esc(m.id)}" title="Delete">×</i>`}</div>`).join('') : '<div class="mp-empty">Press M while playing to drop a marker.</div>';
    }
    _syncTrainer() {
      const tr = this.t.trainer;
      ['from', 'to', 'step', 'every'].forEach((k) => { const i = this._q(`[data-tr="${k}"]`); if (i && document.activeElement !== i) i.value = tr[k]; });
      this._q('[data-trainer]').checked = this.trainerOn;
      const bar = this._q('[data-trbar]');
      const span = Math.max(0.0001, tr.to - tr.from);
      const pct = Math.max(0, Math.min(100, (((this.t.rate || 1) - tr.from) / span) * 100));
      bar.querySelector('i').style.width = (this.trainerOn ? pct : 0) + '%';
      bar.querySelector('span').textContent = this.trainerOn ? Math.round((this.t.rate || 1) * 100) + '% (target ' + Math.round(tr.to * 100) + '%) · loop ' + this.repeatCount : 'Off — loops speed up automatically while on';
    }

    // ---------- events ----------
    _bind() {
      const m = this.mediaEl;
      ['timeupdate', 'seeked', 'play', 'pause', 'durationchange', 'loadedmetadata'].forEach((ev) => m.addEventListener(ev, () => {
        if (ev === 'timeupdate') this._onTime(); else this._syncTime();
        if (ev === 'play' || ev === 'pause' || ev === 'seeked') this._syncStems(ev !== 'pause');
        if (ev === 'loadedmetadata' || ev === 'durationchange') { this.drawWave(); if (this.opts.onDuration) this.opts.onDuration(m.duration); }
        if (ev === 'play') { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); if (this.opts.onPlay) this.opts.onPlay(); }
      }));
      // Smoother playhead than timeupdate (4×/s) alone.
      const tick = () => { if (!this._dead) { if (!m.paused) { this._syncHead(); if (this.stemsOn && ++this._stemTick % 15 === 0) this._syncStems(); if (this.t.loop.on && !this._looping && m.currentTime >= this.t.loop.b - 0.03) this._wrapLoop(); } this._raf = requestAnimationFrame(tick); } };
      this._raf = requestAnimationFrame(tick);
      m.addEventListener('error', () => { const w = this._q('[data-wmsg]'); if (w) { w.hidden = false; w.textContent = /\.(mkv|avi)$/i.test(this.t.media) ? "Can't play MKV/AVI here — convert to MP4." : "Can't play this file (missing or unsupported format)."; } });
      this._ro = new ResizeObserver(() => this.drawWave());
      this._ro.observe(this.canvas);

      this.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act], [data-v], [data-set], [data-use], [data-edit], [data-del], [data-loopsec], [data-rensec], [data-delsec], [data-jump], [data-renmark], [data-delmark]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'play') this.toggle();
        else if (act === 'back') this.seekBy(-5);
        else if (act === 'fwd') this.seekBy(5);
        else if (act === 'loop') this.setLoop({ on: !this.t.loop.on });
        else if (act === 'slower') this.setRate((this.t.rate || 1) - 0.05);
        else if (act === 'faster') this.setRate((this.t.rate || 1) + 0.05);
        else if (act === 'pdown') this.setPitch((this.t.pitch || 0) - 1);
        else if (act === 'pup') this.setPitch((this.t.pitch || 0) + 1);
        else if (act === 'save-loop') this.saveLoop();
        else if (act === 'cancel-edit') { this.editLoopId = null; this._syncSaved(); }
        else if (act === 'mksec') this.sectionFromLoop();
        else if (act === 'clearloop') this.setLoop({ a: null, b: null, on: false });
        else if (act === 'marker') this.addMarker();
        else if (b.dataset.set) this.setLoop({ [b.dataset.set]: Math.round(m.currentTime * 10) / 10 });
        else if (b.dataset.edit) { e.stopPropagation(); this.editLoop(b.dataset.edit); }
        else if (b.dataset.del) { e.stopPropagation(); this.t.savedLoops = this.t.savedLoops.filter((x) => x.id !== b.dataset.del); this._syncSaved(); this.changed(); }
        else if (b.dataset.use) this.useLoop(b.dataset.use);
        else if (b.dataset.rensec) { e.stopPropagation(); this._renameIn('sectionsTimeline', b.dataset.rensec, 'Section name'); }
        else if (b.dataset.delsec) { e.stopPropagation(); this.t.sectionsTimeline = this.t.sectionsTimeline.filter((x) => x.id !== b.dataset.delsec); this._syncSections(); this.drawOverlay(); this.changed(); }
        else if (b.dataset.loopsec) { const s = this.t.sectionsTimeline.find((x) => x.id === b.dataset.loopsec); if (s) { this.setLoop({ a: s.a, b: s.b, on: true }); m.currentTime = s.a; } }
        else if (b.dataset.renmark) { e.stopPropagation(); this._renameIn('markers', b.dataset.renmark, 'Marker name'); }
        else if (b.dataset.delmark) { e.stopPropagation(); this.t.markers = this.t.markers.filter((x) => x.id !== b.dataset.delmark); this._syncMarkers(); this.drawOverlay(); this.changed(); }
        else if (b.dataset.jump) { m.currentTime = Number(b.dataset.jump); }
        else if (b.dataset.v) this._videoAct(b.dataset.v);
      });
      this.el.addEventListener('dblclick', (e) => { const s = e.target.closest('[data-use]'); if (s) this.renameLoop(s.dataset.use); });
      this._q('[data-rate]').addEventListener('change', async (e) => {
        if (e.target.value === 'custom') {
          const v = await global.uiPrompt('Speed (0.25 – 2, e.g. 0.7)', String(this.t.rate || 1), { title: 'Custom speed', okLabel: 'Set' });
          if (v != null && Number(v) > 0) this.setRate(Number(v)); else this._syncRate();
        } else this.setRate(Number(e.target.value));
      });
      this._q('[data-vol]').addEventListener('input', (e) => { m.volume = Number(e.target.value); try { localStorage.setItem('docviewer-music-vol', String(m.volume)); } catch (err) { /* ignore */ } });
      const ab = (k) => this._q('[data-' + k + ']').addEventListener('change', (e) => { const v = parseTime(e.target.value); this.setLoop({ [k]: v }); });
      ab('a'); ab('b');
      this._q('[data-loop-on]').addEventListener('change', (e) => this.setLoop({ on: e.target.checked }));
      this._q('[data-gap]').addEventListener('change', (e) => this.setLoop({ gap: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }));
      this._q('[data-countin]').addEventListener('change', (e) => this.setLoop({ countIn: e.target.checked }));
      this._q('[data-repeats]').addEventListener('change', (e) => this.setLoop({ repeats: Math.max(0, Math.round(Number(e.target.value) || 0)) }));
      this._q('[data-trainer]').addEventListener('change', (e) => {
        this.trainerOn = e.target.checked;
        this.repeatCount = 0;
        if (this.trainerOn) {
          if (!this.t.loop.on) global.uiAlert('The speed trainer speeds up each time a loop repeats — set and turn on an A–B loop too.', { title: 'Speed trainer' });
          this.setRate(this.t.trainer.from);
        }
        this._syncTrainer();
      });
      this.el.querySelectorAll('[data-tr]').forEach((inp) => inp.addEventListener('change', () => {
        const k = inp.dataset.tr;
        const v = Number(inp.value);
        if (v > 0) { this.t.trainer[k] = k === 'every' ? Math.round(v) : v; this.changed(); }
        this._syncTrainer();
      }));
      this.el.querySelectorAll('.mp-root input, .mp-root select').forEach(() => {});
      this.el.addEventListener('keydown', (e) => { if (e.target.matches('input, select')) e.stopPropagation(); });
      this._bindWave();
      if (this.t.kind === 'video') this._bindVideo();
    }

    async _renameIn(list, id, label) {
      const it = this.t[list].find((x) => x.id === id);
      if (!it || this.readOnly) return;
      const n = await global.uiPrompt(label, it.name, { title: 'Rename', okLabel: 'Rename' });
      if (n == null || !String(n).trim()) return;
      it.name = String(n).trim().slice(0, 80);
      if (list === 'markers') this._syncMarkers(); else this._syncSections();
      this.drawOverlay();
      this.changed();
    }

    _bindWave() {
      const wave = this._q('[data-wave]');
      let drag = null;
      wave.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const handle = e.target.closest('[data-h]');
        const mark = e.target.closest('[data-mid]');
        const sec = e.target.closest('[data-secid]');
        const time = this._xToTime(e.clientX);
        if (handle && !this.readOnly) drag = { kind: 'handle', which: handle.dataset.h };
        else if (mark) drag = { kind: 'mark', id: mark.dataset.mid, x0: e.clientX, moved: false };
        else if (sec) { const s = this.t.sectionsTimeline.find((x) => x.id === sec.dataset.secid); if (s) { this.setLoop({ a: s.a, b: s.b, on: true }); this.mediaEl.currentTime = s.a; } return; }
        else drag = { kind: 'range', t0: time, x0: e.clientX, moved: false };
        wave.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      wave.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const time = Math.round(this._xToTime(e.clientX) * 10) / 10;
        if (drag.kind === 'handle') {
          this.t.loop[drag.which] = time;
          if (this.t.loop.a != null && this.t.loop.b != null && this.t.loop.b < this.t.loop.a) { const x = this.t.loop.a; this.t.loop.a = this.t.loop.b; this.t.loop.b = x; drag.which = drag.which === 'a' ? 'b' : 'a'; }
          this._syncLoop(); this.drawOverlay();
        } else if (drag.kind === 'mark' && !this.readOnly) {
          if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
          if (drag.moved) { const mk = this.t.markers.find((x) => x.id === drag.id); if (mk) { mk.t = time; this.drawOverlay(); } }
        } else if (drag.kind === 'range' && !this.readOnly) {
          if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
          if (drag.moved) { this.t.loop.a = Math.min(drag.t0, time); this.t.loop.b = Math.max(drag.t0, time); this._syncLoop(); this.drawOverlay(); }
        }
      });
      wave.addEventListener('pointerup', (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.kind === 'handle') { this.setLoop({ a: this.t.loop.a, b: this.t.loop.b }); }
        else if (d.kind === 'mark') {
          const mk = this.t.markers.find((x) => x.id === d.id);
          if (d.moved) { this.t.markers.sort((a, b) => a.t - b.t); this._syncMarkers(); this.changed(); } else if (mk) this.mediaEl.currentTime = mk.t;
        } else if (d.kind === 'range') {
          if (d.moved && this.t.loop.b - this.t.loop.a >= 0.2) this.setLoop({ a: this.t.loop.a, b: this.t.loop.b, on: true });
          else this.mediaEl.currentTime = this._xToTime(e.clientX);
        }
      });
    }

    // ---------- video ----------
    _videoAct(v) {
      const vid = this.mediaEl;
      const st = this.t.video;
      if (v === 'mirror') { st.mirror = !st.mirror; this._applyVideo(); this.changed(); }
      else if (v === 'zreset') { st.zoom = { s: 1, x: 0.5, y: 0.5 }; this._applyVideo(); this.changed(); }
      else if (v === 'fprev') this.frameStep(-1);
      else if (v === 'fnext') this.frameStep(1);
      else if (v === 'pip') { try { if (document.pictureInPictureElement) document.exitPictureInPicture(); else vid.requestPictureInPicture(); } catch (e) { /* not supported */ } }
      else if (v === 'full') { const w = this._q('[data-vwrap]'); try { (w.requestFullscreen || w.webkitRequestFullscreen).call(w); } catch (e) { /* ignore */ } }
      else if (v === 'hide') { st.show = !st.show; this._applyVideo(); this.changed(); }
    }
    frameStep(dir) {
      const vid = this.mediaEl;
      vid.pause();
      vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + dir / 30));
    }
    _bindVideo() {
      const wrap = this._q('[data-vwrap]');
      const zr = this._q('[data-vzoom]');
      zr.addEventListener('input', () => { this.t.video.zoom.s = Number(zr.value); this._applyVideo(); });
      zr.addEventListener('change', () => this.changed());
      // Drag the picture to pan when zoomed; click toggles play.
      let pan = null;
      wrap.addEventListener('pointerdown', (e) => { pan = { x: e.clientX, y: e.clientY, zx: this.t.video.zoom.x, zy: this.t.video.zoom.y, moved: false }; wrap.setPointerCapture(e.pointerId); });
      wrap.addEventListener('pointermove', (e) => {
        if (!pan) return;
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
        if (!pan.moved || this.t.video.zoom.s <= 1.01) return;
        const r = wrap.getBoundingClientRect();
        const k = 1 / (this.t.video.zoom.s - 1 || 1);
        this.t.video.zoom.x = Math.max(0, Math.min(1, pan.zx - (dx / r.width) * k * (this.t.video.mirror ? -1 : 1)));
        this.t.video.zoom.y = Math.max(0, Math.min(1, pan.zy - (dy / r.height) * k));
        this._applyVideo();
      });
      wrap.addEventListener('pointerup', () => { if (pan && !pan.moved) this.toggle(); else if (pan) this.changed(); pan = null; });
      wrap.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.t.video.zoom.s = Math.max(1, Math.min(4, this.t.video.zoom.s * Math.exp(-Math.max(-24, Math.min(24, e.deltaY)) * 0.01)));
        this._applyVideo();
        clearTimeout(this._zt); this._zt = setTimeout(() => this.changed(), 400);
      }, { passive: false });
    }

    // ---------- transport ----------
    toggle() { const m = this.mediaEl; if (m.paused) m.play().catch(() => {}); else m.pause(); }
    seekBy(s) { const m = this.mediaEl; m.currentTime = Math.max(0, Math.min(m.duration || 0, m.currentTime + s)); }

    // Keys while the music view has focus (called by the engine).
    key(e) {
      const k = e.key;
      const m = this.mediaEl;
      if (k === ' ' || e.code === 'Space') { this.toggle(); return true; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const dir = k === 'ArrowLeft' ? -1 : 1;
        if (this.t.kind === 'video' && m.paused && e.altKey) this.frameStep(dir); else this.seekBy(dir * (e.shiftKey ? 1 : 5));
        return true;
      }
      if (k === ',' || k === '.') { if (this.t.kind === 'video') { this.frameStep(k === ',' ? -1 : 1); return true; } return false; }
      if (k === '[') { this.setLoop({ a: Math.round(m.currentTime * 10) / 10 }); return true; }
      if (k === ']') { this.setLoop({ b: Math.round(m.currentTime * 10) / 10 }); return true; }
      if (k === 'l' || k === 'L') { this.setLoop({ on: !this.t.loop.on }); return true; }
      if (k === '_' || (k === '-' && e.shiftKey)) { this.setPitch((this.t.pitch || 0) - 1); return true; }
      if (k === '+' && e.shiftKey && e.code === 'Equal') { this.setPitch((this.t.pitch || 0) + 1); return true; }
      if (k === '-') { this.setRate((this.t.rate || 1) - 0.05); return true; }
      if (k === '=' || k === '+') { this.setRate((this.t.rate || 1) + 0.05); return true; }
      if (k === 'm' || k === 'M') { this.addMarker(); return true; }
      if (/^[1-9]$/.test(k)) { const s = this.t.savedLoops[Number(k) - 1]; if (s) { this.useLoop(s.id); m.play().catch(() => {}); return true; } return false; }
      if (this.t.kind === 'video' && (k === 'v' || k === 'V')) { this._videoAct(e.shiftKey ? 'mirror' : 'hide'); return true; }
      return false;
    }

    // Deep link: ?loop=<id or name>&t=<sec>
    openRef(params) {
      const loop = params.get('loop');
      const tt = params.get('t');
      if (loop) {
        const s = this.t.savedLoops.find((x) => x.id === loop) || this.t.savedLoops.find((x) => x.name.toLowerCase() === loop.toLowerCase());
        if (s) this.useLoop(s.id);
      }
      if (tt != null && parseTime(tt) != null) this.mediaEl.currentTime = parseTime(tt);
    }

    isPlaying() { return !this.mediaEl.paused; }

    destroy(keepMedia) {
      this._dead = true;
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      this._dropStems();
      // The mini-player only carries the main media: let it be heard again.
      if (keepMedia && this.srcGain) { this.srcGain.gain.value = 1; this.bus.gain.value = 1; }
      if (!keepMedia) {
        try { this.mediaEl.pause(); } catch (e) { /* ignore */ }
        if (this.ctx) this.ctx.close().catch(() => {});
      }
    }
  }

  // ---------- mini-player: keeps playing after leaving the collection ----------
  const Mini = {
    adopt(player, info) {
      this.close();
      const m = player.mediaEl;
      const bar = document.createElement('div');
      bar.className = 'mp-mini';
      bar.innerHTML = `<button type="button" data-mini="play">❚❚</button>
        <div class="mp-mini-t"><b>${esc(player.t.title)}</b><small data-mini-time></small></div>
        <button type="button" data-mini="open" title="Open the collection">↗</button>
        <button type="button" data-mini="close" title="Stop">×</button>
        <div class="mp-mini-media"></div>`;
      document.body.appendChild(bar);
      if (m.tagName === 'VIDEO') { m.style.transform = ''; bar.querySelector('.mp-mini-media').appendChild(m); m.controls = false; } else bar.querySelector('.mp-mini-media').appendChild(m);
      this.bar = bar; this.media = m; this.player = player; this.info = info;
      const loop = player.t.loop;
      const sync = () => {
        if (!this.bar) return;
        bar.querySelector('[data-mini="play"]').textContent = m.paused ? '▶' : '❚❚';
        bar.querySelector('[data-mini-time]').textContent = fmt(m.currentTime) + ' / ' + fmt(m.duration) + (loop.on ? ' · ⟳ ' + fmt(loop.a) + '–' + fmt(loop.b) : '') + ((player.t.rate || 1) !== 1 ? ' · ' + player.t.rate + '×' : '');
        if (loop.on && m.currentTime >= loop.b - 0.05) m.currentTime = loop.a;
      };
      this._onT = sync;
      m.addEventListener('timeupdate', sync);
      m.addEventListener('play', sync);
      m.addEventListener('pause', sync);
      sync();
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mini]');
        if (!b) return;
        if (b.dataset.mini === 'play') { if (m.paused) m.play().catch(() => {}); else m.pause(); }
        else if (b.dataset.mini === 'close') this.close();
        else if (b.dataset.mini === 'open' && info && info.path && typeof global.openFileAt === 'function') {
          const at = m.currentTime;
          const ref = 'track=' + encodeURIComponent(player.t.id) + '&t=' + at.toFixed(1) + '&play=' + (m.paused ? 0 : 1);
          this.close();
          global.openFileAt(info.path, ref);
        }
      });
    },
    // Hand the media back if the same track is opened again.
    take(track) {
      if (!this.media || !this.player || this.player.t.media !== track.media) return null;
      const out = { time: this.media.currentTime, playing: !this.media.paused };
      this.close();
      return out;
    },
    close() {
      if (!this.bar) return;
      try { this.media.removeEventListener('timeupdate', this._onT); this.media.pause(); } catch (e) { /* ignore */ }
      if (this.player && this.player.ctx) this.player.ctx.close().catch(() => {});
      this.bar.remove();
      this.bar = this.media = this.player = this.info = null;
    },
  };

  global.MusicPlayer = MusicPlayer;
  global.MusicMini = Mini;
  global.MusicPlayerUtil = { parseTime, fmt, rawUrl, relOf };
})(typeof window !== 'undefined' ? window : this);
