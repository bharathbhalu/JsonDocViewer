/* DocViewer terminal engine — a live tmux pane (local or SSH) in a terminal file. */
(function (global) {
  const C = global.TerminalCore;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
  const ask = (m, o) => global.uiConfirm(m, o);
  const prompt = (m, v, o) => global.uiPrompt(m, v, o);

  // Clipboard that also works on plain-http pages (no navigator.clipboard there).
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  const stampOf = (iso) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fileStamp = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  const slug = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  function themeColors() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark
      ? { background: '#0d1117', foreground: '#e6edf3', cursor: '#f0b429', selectionBackground: '#264f78', black: '#484f58', brightBlack: '#6e7681' }
      : { background: '#fbfcfe', foreground: '#1c2330', cursor: '#4f6ef7', selectionBackground: '#cfdcff', black: '#24292f', brightBlack: '#57606a', white: '#6e7781', brightWhite: '#8c959f' };
  }

  class TerminalEngine {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = opts || {};
      this.data = C.normalize({});
      this.readOnly = !!this.opts.readOnly;
      this.ws = null;
      this.state = 'idle'; // idle | connecting | connected | reconnecting | ended
      this.retry = 0;
      this.closing = false;
      this.root = document.createElement('div');
      this.root.className = 'tm-root';
      stage.innerHTML = '';
      stage.appendChild(this.root);
      this.root.innerHTML = `
        <div class="tm-bar">
          <span class="tm-dot"></span><span class="tm-label">Not connected</span>
          <span class="tm-spacer"></span>
          <button type="button" data-a="sessions" title="List tmux sessions and choose one">☰ Sessions</button>
          <button type="button" data-a="reconnect" title="Reconnect">↻ Reconnect</button>
          <button type="button" data-a="font-" title="Smaller text">A−</button>
          <button type="button" data-a="font+" title="Larger text">A+</button>
          <button type="button" data-a="sidebar" class="tm-side-btn" title="Show / hide the settings pane">⚙ Settings</button>
        </div>
        <div class="tm-body">
          <div class="tm-term-wrap"><div class="tm-term"></div><div class="tm-overlay hidden"></div>
            <button type="button" class="tm-side-tab" data-a="sidebar" title="Show the settings pane">‹ Settings</button></div>
          <aside class="tm-side"><button type="button" class="tm-side-close" data-a="sidebar" title="Minimize this pane">Minimize ›</button><div class="tm-side-body"></div></aside>
        </div>`;
      this.termEl = this.root.querySelector('.tm-term');
      this.overlay = this.root.querySelector('.tm-overlay');
      this.side = this.root.querySelector('.tm-side-body');
      this.root.addEventListener('click', (e) => {
        if (!e.target.closest('.tm-bar, .tm-side-tab, .tm-side-close')) return;
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const a = b.dataset.a;
        if (a === 'sessions') this.openPicker();
        else if (a === 'reconnect') this.connect({ fresh: true });
        else if (a === 'sidebar') { this.data.sidebar = !this.data.sidebar; this._changed(); this._layout(); }
        else if (a === 'font-' || a === 'font+') { this.data.fontSize = Math.max(9, Math.min(28, this.data.fontSize + (a === 'font+' ? 1 : -1))); if (this.term) { this.term.options.fontSize = this.data.fontSize; this._fit(); } this._changed(); }
      });
      this._themeObs = new MutationObserver(() => { if (this.term) this.term.options.theme = themeColors(); });
      this._themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // ---------- board API ----------
    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.normalize({});
      this._renderSide();
      this._layout();
      this._initTerm();
      // History previews show the saved settings only — no live connection.
      if (this.readOnly) { this._setState('ended', 'Saved version (not connected)'); this._showOverlay('This is a saved version of the terminal file. Its settings are shown on the right.', []); return; }
      this.connect({});
    }
    serializeToHtml() { return C.serializeToHtml(this.data); }
    setReadOnly(on) { this.readOnly = !!on; this._renderSide(); }
    flushEdit() {}
    collapseAll() {}
    expandAll() {}
    destroy() {
      this.closing = true;
      clearTimeout(this.retryTimer);
      if (this.ws) try { this.ws.close(); } catch (e) { /* closed */ }
      if (this.ro) this.ro.disconnect();
      this._themeObs.disconnect();
      if (this.term) this.term.dispose();
      this.stage.innerHTML = '';
    }

    _path() { return this.opts.getPath ? this.opts.getPath() : null; }
    _changed() { if (this.opts.onChange) this.opts.onChange(); }
    // The server reads the file from disk, so save before (re)connecting.
    async _saveFirst() {
      if (typeof global.isDirty !== 'undefined' && global.isDirty && typeof global.saveCurrentFile === 'function') await global.saveCurrentFile();
      else if (typeof isDirty !== 'undefined' && isDirty && typeof saveCurrentFile === 'function') await saveCurrentFile(); // eslint-disable-line no-undef
    }

    _layout() {
      this.root.classList.toggle('no-side', !this.data.sidebar);
      const b = this.root.querySelector('.tm-side-btn');
      if (b) b.classList.toggle('on', !!this.data.sidebar);
      setTimeout(() => this._fit(), 30);
    }

    // ---------- xterm ----------
    _initTerm() {
      if (this.term) return;
      const T = global.Terminal;
      this.term = new T({
        fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", Consolas, monospace',
        fontSize: this.data.fontSize,
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        // Inside tmux with mouse mode on, ⌥-drag still selects text for copying.
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: false,
        theme: themeColors(),
      });
      this.fit = new global.FitAddon.FitAddon();
      this.term.loadAddon(this.fit);
      try { this.term.loadAddon(new global.WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener'))); } catch (e) { /* optional */ }
      this.term.open(this.termEl);
      this.decoder = new TextDecoder();
      this._initClipboard();
      this.term.onData((d) => this._send(d));
      this.term.onBinary((d) => this._send(d));
      this.ro = new ResizeObserver(() => this._fit());
      this.ro.observe(this.termEl);
      this._fit();
    }
    // ⌘C copies the selection, ⌘V pastes, mouse selection copies itself
    // (copy-on-select), and right-click offers Copy / Paste / Select all.
    _initClipboard() {
      const t = this.term;
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const mod = e.metaKey || (e.ctrlKey && e.shiftKey);
        if (mod && (e.key === 'c' || e.key === 'C') && t.hasSelection()) {
          this._copy(t.getSelection());
          e.preventDefault();
          return false;
        }
        if (e.metaKey && (e.key === 'v' || e.key === 'V')) return false; // let the browser paste
        if (e.metaKey && (e.key === 'a' || e.key === 'A')) { t.selectAll(); e.preventDefault(); return false; }
        return true;
      });
      this.termEl.addEventListener('mouseup', () => {
        if (!this.data.copyOnSelect) return;
        setTimeout(() => { if (t.hasSelection()) { const sel = t.getSelection(); if (sel && sel !== this._lastCopied) this._copy(sel, true); } }, 0);
      });
      // Right-click is ours: keep it from reaching tmux (mouse mode would also
      // pop tmux's own menu). Shift + right-click goes to tmux instead.
      const swallow = (e) => { if (e.button === 2 && !e.shiftKey) { e.stopPropagation(); } };
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((ev) => this.termEl.addEventListener(ev, swallow, true));
      this.termEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.shiftKey) return; // tmux's menu
        e.stopPropagation();
        this._menu(e.clientX, e.clientY);
      }, true);
    }
    async _copy(text, quiet) {
      if (!text) return;
      const ok = await copyText(text);
      this._lastCopied = text;
      const lines = text.split('\n').length;
      this._flash(ok ? `Copied ${lines > 1 ? lines + ' lines' : text.length + ' characters'}` : 'Copy failed — use ⌘C');
      void quiet;
    }
    _flash(msg) {
      let f = this.root.querySelector('.tm-flash');
      if (!f) { f = document.createElement('div'); f.className = 'tm-flash'; this.root.querySelector('.tm-term-wrap').appendChild(f); }
      f.textContent = msg;
      f.classList.add('show');
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => f.classList.remove('show'), 1400);
    }
    _visibleText() {
      const b = this.term.buffer.active;
      const out = [];
      for (let i = b.viewportY; i < b.viewportY + this.term.rows; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); }
      return out.join('\n').replace(/\s+$/, '');
    }
    _menu(x, y) {
      document.querySelectorAll('.tm-ctx').forEach((m) => m.remove());
      const t = this.term;
      const m = document.createElement('div');
      m.className = 'tm-ctx dh-ctx';
      m.innerHTML = `<button type="button" data-c="copy"${t.hasSelection() ? '' : ' disabled'}>Copy <kbd>⌘C</kbd></button>
        <button type="button" data-c="paste">Paste <kbd>⌘V</kbd></button>
        <button type="button" data-c="all">Select all <kbd>⌘A</kbd></button>
        <hr><button type="button" data-c="screen">Copy visible screen</button>
        <button type="button" data-c="save">Save pane output…</button>
        <hr><span class="tm-ctx-hint">⇧ right-click: tmux menu · ⌥ drag: select inside tmux</span>
        <label class="tm-ctx-check"><input type="checkbox" data-c="cos"${this.data.copyOnSelect ? ' checked' : ''}> Copy on select</label>`;
      document.body.appendChild(m);
      const r = m.getBoundingClientRect();
      m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
      m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
      const close = () => { m.remove(); document.removeEventListener('mousedown', off, true); };
      const off = (e) => { if (!m.contains(e.target)) close(); };
      setTimeout(() => document.addEventListener('mousedown', off, true));
      m.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-c]');
        if (!c || c.disabled) return;
        const a = c.dataset.c;
        if (a === 'cos') { this.data.copyOnSelect = c.checked; this._changed(); this._renderSide(); return; }
        close();
        if (a === 'copy') this._copy(t.getSelection());
        else if (a === 'all') t.selectAll();
        else if (a === 'screen') this._copy(this._visibleText());
        else if (a === 'save') this.saveOutput();
        else if (a === 'paste') {
          try { const txt = await navigator.clipboard.readText(); if (txt) t.paste(txt); } catch (err) { this._flash('Use ⌘V to paste'); }
          t.focus();
        }
      });
    }

    _fit() {
      if (!this.term || !this.termEl.offsetWidth) return;
      try { this.fit.fit(); } catch (e) { return; }
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'resize', cols: this.term.cols, rows: this.term.rows }));
    }
    _send(d) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(new TextEncoder().encode(d));
    }

    _setState(state, label) {
      this.state = state;
      this.root.dataset.state = state;
      const l = this.root.querySelector('.tm-label');
      if (l) l.textContent = label || state;
    }
    _where() {
      const d = this.data;
      return (d.claude ? 'Claude · ' : '') + 'tmux “' + (this.sessionName || d.session || '?') + '” ' + (d.mode === 'ssh' ? 'on ' + (d.host || '?') : 'on this computer');
    }

    // ---------- connection ----------
    async connect({ fresh, plain, session } = {}) {
      const p = this._path();
      if (!p || this.closing) return;
      clearTimeout(this.retryTimer);
      this._hideOverlay();
      if (this.ws) { this.intentional = true; try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
      if (fresh) this.retry = 0;
      if (this.data.mode === 'ssh' && !this.data.host) {
        this._setState('ended', 'No SSH host set');
        this._showOverlay('Set the SSH host in ⚙ settings to connect.', [['Open settings', () => { this.data.sidebar = true; this._layout(); this._focusField('host'); }]]);
        return;
      }
      this._setState(this.retry ? 'reconnecting' : 'connecting', (this.retry ? 'Reconnecting… ' : 'Connecting… ') + this._where());
      try {
        await this._saveFirst();
        const { token } = await post('/api/term/token', { path: p });
        if (this.closing) return;
        const qs = new URLSearchParams({ token, cols: String(this.term.cols || 100), rows: String(this.term.rows || 30) });
        if (plain) qs.set('plain', '1');
        if (session) qs.set('session', session);
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/term?' + qs);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.intentional = false;
        this.plain = !!plain;
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') { this.term.write(new Uint8Array(ev.data)); return; }
          let m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.t === 'ready') {
            this.retry = 0;
            try { localStorage.setItem('docviewer-last-terminal', p); } catch (e) { /* ignore */ }
            this.sessionName = m.session;
            this._setState('connected', (m.plain ? 'Plain shell ' + (m.mode === 'ssh' ? 'on ' + m.host : 'on this computer') : this._where()));
            this._fit();
            this.term.focus();
          } else if (m.t === 'event') {
            if (m.ev === 'rebuilt') this._toast('♻ Session “' + this.sessionName + '” was not running — rebuilt it' + (this.data.layout ? ' from the saved layout' : '') + '.');
            if (m.ev === 'notmux') this._toast('tmux is not installed ' + (this.data.mode === 'ssh' ? 'on ' + this.data.host : 'here') + ' — this is a plain shell (it ends when you close it).');
          } else if (m.t === 'exit') {
            this.lastExit = m;
          }
        };
        ws.onclose = () => {
          if (ws !== this.ws || this.closing) return;
          this.ws = null;
          if (this.intentional) return;
          const x = this.lastExit;
          this.lastExit = null;
          if (x) return this._ended(x);
          // Dropped (server restart, sleep): retry with backoff.
          this.retry++;
          const wait = Math.min(15000, 800 * 2 ** Math.min(this.retry, 5));
          this._setState('reconnecting', 'Connection lost — retrying in ' + Math.round(wait / 1000) + 's');
          this._showOverlay('Connection lost. Retrying…', [['Retry now', () => this.connect({ fresh: true })]]);
          this.retryTimer = setTimeout(() => this.connect({}), wait);
        };
      } catch (err) {
        this._setState('ended', 'Could not connect');
        this._showOverlay(String(err.message || err), [['Retry', () => this.connect({ fresh: true })], ['Choose session…', () => this.openPicker()]]);
      }
    }

    // The pane process ended: detached, session killed, SSH failed…
    _ended(x) {
      const d = this.data;
      let msg;
      if (x.reason === 'ssh') msg = `SSH to ${d.host} failed or was closed (exit ${x.code}). Check the host, your network and SSH keys.`;
      else if (x.reason === 'create') msg = `Couldn't create the tmux session “${this.sessionName}”${d.mode === 'ssh' ? ' on ' + d.host : ''}.`;
      else if (x.reason === 'config' || x.reason === 'file' || x.reason === 'spawn') msg = x.message || 'Could not start the terminal.';
      else if (this.plain) msg = 'The shell exited.';
      else msg = `Detached from “${this.sessionName}” — the session ended or you detached (Ctrl-b d).`;
      this._setState('ended', 'Disconnected');
      this.term.write('\r\n\x1b[2m[' + msg + ']\x1b[0m\r\n');
      this._showOverlay(msg, [
        ['Reconnect / rebuild', () => this.connect({ fresh: true }), true],
        ['Create new session…', () => this.newSession()],
        ['Choose session…', () => this.openPicker()],
        ['Plain shell', () => this.connect({ fresh: true, plain: true })],
      ]);
    }

    _showOverlay(text, actions) {
      this.overlay.innerHTML = `<div class="tm-ov-box"><p>${esc(text)}</p><div>${actions.map(([label], i) => `<button type="button" data-i="${i}" class="${actions[i][2] ? 'primary' : ''}">${esc(label)}</button>`).join('')}</div></div>`;
      this.overlay.classList.remove('hidden');
      this.overlay.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => actions[Number(b.dataset.i)][1]()));
    }
    _hideOverlay() { this.overlay.classList.add('hidden'); }
    _toast(t) { if (global.setStatus) global.setStatus(t, 'ok'); }

    // ---------- sessions ----------
    async openPicker() {
      const p = this._path();
      const d = this.data;
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      ov.innerHTML = `<div class="md-dialog-box tm-pick" role="dialog" aria-modal="true" aria-label="tmux sessions">
        <div class="md-dialog-head"><span>tmux sessions ${d.mode === 'ssh' ? 'on ' + esc(d.host) : 'on this computer'}</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body"><div class="tm-pick-list"><p class="md-note">Loading…</p></div></div>
        <div class="md-dialog-actions"><button type="button" data-new>＋ New session…</button><button type="button" data-refresh>↻</button><span class="md-spacer"></span><button type="button" data-x2>Close</button></div>
      </div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('[data-x]').addEventListener('click', close);
      ov.querySelector('[data-x2]').addEventListener('click', close);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      ov.querySelector('[data-new]').addEventListener('click', async () => { close(); await this.newSession(); });
      const list = ov.querySelector('.tm-pick-list');
      const load = async () => {
        list.innerHTML = '<p class="md-note">Loading…</p>';
        try {
          const r = await fetch('/api/term/sessions?path=' + encodeURIComponent(p), { cache: 'no-store' });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Could not list sessions');
          if (data.noTmux) { list.innerHTML = `<p class="md-note">tmux isn't installed ${d.mode === 'ssh' ? 'on ' + esc(d.host) : 'here'}. Install it (brew install tmux / apt install tmux) to keep sessions alive.</p>`; return; }
          const mine = this.sessionName || d.session;
          list.innerHTML = data.sessions.map((s) => `
            <div class="tm-sess${s.name === mine ? ' cur' : ''}" data-s="${esc(s.name)}">
              <div class="tm-sess-main"><b>${esc(s.name)}</b>${s.name === mine ? '<span class="tm-tag">this file</span>' : ''}${s.attached ? `<span class="tm-tag live">${s.attached} attached</span>` : ''}
                <div class="tm-sess-sub">${s.windows} window${s.windows === 1 ? '' : 's'} · active ${ago(s.activity)} · ${esc(s.cwd || '')}</div></div>
              <div class="tm-sess-act">
                <button type="button" data-attach class="primary" title="Bind this file to the session and attach">Attach</button>
                <button type="button" data-adopt title="Attach and save its windows / panes into this file, so it can be rebuilt later">Adopt</button>
                <button type="button" data-rename title="Rename session">✎</button>
                <button type="button" data-kill title="Kill session">✕</button>
              </div>
            </div>`).join('') || '<p class="md-note">No tmux sessions yet. Create one with ＋ New session.</p>';
          list.querySelectorAll('.tm-sess').forEach((row) => {
            const name = row.dataset.s;
            row.querySelector('[data-attach]').addEventListener('click', async () => { close(); await this.useSession(name, false); });
            row.querySelector('[data-adopt]').addEventListener('click', async () => { close(); await this.useSession(name, true); });
            row.querySelector('[data-rename]').addEventListener('click', async () => {
              const to = await prompt('New name for “' + name + '”', name, { title: 'Rename session', okLabel: 'Rename' });
              if (!to || to === name) return;
              try {
                const r2 = await post('/api/term/rename', { path: p, from: name, to });
                if (name === (this.sessionName || d.session)) { this.data.session = r2.session; this.sessionName = r2.session; this._changed(); this._renderSide(); }
                load();
              } catch (err) { global.uiAlert(err.message); }
            });
            row.querySelector('[data-kill]').addEventListener('click', async () => {
              if (!(await ask(`Kill tmux session “${name}”${d.mode === 'ssh' ? ' on ' + d.host : ''}? Everything running in it (including Claude) stops.`, { title: 'Kill session', okLabel: 'Kill', danger: true }))) return;
              try { await post('/api/term/kill', { path: p, session: name }); load(); } catch (err) { global.uiAlert(err.message); }
            });
          });
        } catch (err) {
          list.innerHTML = `<p class="tm-err">${esc(err.message)}</p>`;
        }
      };
      ov.querySelector('[data-refresh]').addEventListener('click', load);
      load();
    }

    async useSession(name, adopt) {
      this.data.session = C.cleanSession(name);
      if (adopt) {
        try {
          const r = await fetch('/api/term/layout?path=' + encodeURIComponent(this._path()) + '&session=' + encodeURIComponent(name), { cache: 'no-store' });
          const d = await r.json();
          if (r.ok && d.layout) this.data.layout = C.normalizeLayout(d.layout);
        } catch (e) { /* attach anyway */ }
      }
      this._changed();
      this._renderSide();
      await this.connect({ fresh: true });
    }

    async newSession() {
      const base = this.data.session || 'main';
      const name = await prompt('Name for the new tmux session' + (this.data.mode === 'ssh' ? ' on ' + this.data.host : ''), base === (this.sessionName || '') ? base + '-2' : base, { title: 'New session', okLabel: 'Create' });
      if (!name) return;
      this.data.session = C.cleanSession(name);
      this._changed();
      this._renderSide();
      await this.connect({ fresh: true });
    }

    async saveLayout() {
      try {
        const r = await fetch('/api/term/layout?path=' + encodeURIComponent(this._path()) + '&session=' + encodeURIComponent(this.sessionName || this.data.session), { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not read the layout');
        this.data.layout = C.normalizeLayout(d.layout);
        this._changed();
        this._renderSide();
        this._toast('Layout saved: ' + this.data.layout.windows.length + ' window(s) — used to rebuild the session if it dies');
      } catch (err) { global.uiAlert(err.message); }
    }

    async saveOutput() {
      try {
        const r = await fetch('/api/term/capture?lines=5000&path=' + encodeURIComponent(this._path()), { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not capture output');
        const list = this.data.outputs;
        list.push({ id: C.uid('o_'), name: '', at: new Date().toISOString(), session: this.sessionName || this.data.session || '', text: d.text });
        let dropped = [];
        while (list.length > C.MAX_OUTPUTS) dropped = dropped.concat(list.splice(0, 1));
        this._changed();
        this._renderSide();
        this._flash('Pane output saved');
        this._toast('Saved pane output (' + list.length + '/' + C.MAX_OUTPUTS + ')' + (dropped.length ? ' — deleted the oldest: ' + dropped.map((o) => o.name || stampOf(o.at)).join(', ') : ''));
        // Open the new one's name for editing.
        setTimeout(() => this._renameOutput(list[list.length - 1].id), 50);
      } catch (err) { global.uiAlert(err.message); }
    }

    _outputText(o) { return o.text; }
    _downloadOutputs(list) {
      const one = list.length === 1;
      const body = list.map((o) => (one ? '' : `===== ${o.name || 'Pane output'} — ${stampOf(o.at)}${o.session ? ' — tmux ' + o.session : ''} =====\n`) + o.text).join('\n\n');
      const name = one
        ? `${slug(list[0].name) || 'pane-output'}-${fileStamp(list[0].at)}.txt`
        : `${slug(this.data.title) || 'terminal'}-outputs-${fileStamp(new Date().toISOString())}.txt`;
      const header = one ? `# ${list[0].name || 'Pane output'} — ${stampOf(list[0].at)}${list[0].session ? ' — tmux ' + list[0].session : ''}${this.data.mode === 'ssh' ? ' on ' + this.data.host : ''}\n\n` : '';
      const url = URL.createObjectURL(new Blob([header + body + '\n'], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    _renameOutput(id) {
      const row = this.side.querySelector(`.tm-out-item[data-id="${id}"]`);
      const o = this.data.outputs.find((x) => x.id === id);
      if (!row || !o) return;
      const nameEl = row.querySelector('.tm-out-name');
      if (!nameEl) return; // already being renamed
      const input = document.createElement('input');
      input.className = 'tm-out-rename';
      input.value = o.name;
      input.placeholder = 'Name this output';
      input.maxLength = 120;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save) { const v = input.value.trim(); if (v !== o.name) { o.name = v; this._changed(); } }
        this._renderSide();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
      input.addEventListener('blur', () => finish(true));
    }
    _viewOutput(o) {
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      ov.innerHTML = `<div class="md-dialog-box tm-out" role="dialog" aria-modal="true">
        <div class="md-dialog-head"><span>${esc(o.name || 'Pane output')} <span class="tm-out-when">· ${esc(stampOf(o.at))}${o.session ? ' · tmux “' + esc(o.session) + '”' : ''}</span></span><button type="button" data-x>×</button></div>
        <pre>${esc(o.text)}</pre>
        <div class="md-dialog-actions"><span class="md-note">${o.text.split('\n').length} lines</span><span class="md-spacer"></span><button type="button" data-copy>⧉ Copy</button><button type="button" data-dl>⤓ Download</button><button type="button" data-x2>Close</button></div></div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('[data-x]').addEventListener('click', close);
      ov.querySelector('[data-x2]').addEventListener('click', close);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      ov.querySelector('[data-copy]').addEventListener('click', async () => { const ok = await copyText(o.text); this._toast(ok ? 'Output copied' : 'Copy failed'); });
      ov.querySelector('[data-dl]').addEventListener('click', () => this._downloadOutputs([o]));
    }

    async sendSnippet(sn) {
      try {
        const r = await post('/api/term/send', { path: this._path(), text: sn.cmd, enter: sn.enter });
        if (r.via === 'pane') this.term.focus();
      } catch (err) { global.uiAlert(err.message); }
    }

    // ---------- sidebar ----------
    _focusField(f) { setTimeout(() => { const el = this.side.querySelector(`[data-f="${f}"]`); if (el) el.focus(); }, 50); }
    _renderSide() {
      const d = this.data;
      const ro = this.readOnly ? ' disabled' : '';
      const lay = d.layout ? d.layout.windows.map((w) => `${esc(w.name || 'window')} (${w.panes.length} pane${w.panes.length === 1 ? '' : 's'})`).join(', ') : '';
      this.side.innerHTML = `
        <section>
          <h4>Connection</h4>
          <div class="tm-seg">
            <label><input type="radio" name="tm-mode" value="local"${d.mode === 'local' ? ' checked' : ''}${ro}> Local</label>
            <label><input type="radio" name="tm-mode" value="ssh"${d.mode === 'ssh' ? ' checked' : ''}${ro}> SSH</label>
          </div>
          ${d.mode === 'ssh' ? `
            <label class="tm-f">Host <input data-f="host" value="${esc(d.host)}" placeholder="user@host or ~/.ssh/config alias" spellcheck="false"${ro}></label>
            <div class="tm-row2"><label class="tm-f">Port <input data-f="port" type="number" value="${d.port || ''}" placeholder="22"${ro}></label>
            <label class="tm-f">Jump host <input data-f="jump" value="${esc(d.jump)}" placeholder="optional" spellcheck="false"${ro}></label></div>` : ''}
          <label class="tm-f">tmux session <input data-f="session" value="${esc(d.session)}" placeholder="name" spellcheck="false"${ro}></label>
          <label class="tm-f">Start folder${d.mode === 'ssh' ? ' (on the host)' : ''} <input data-f="dir" value="${esc(d.dir)}" placeholder="${d.mode === 'ssh' ? '~ (home)' : 'data folder'}" spellcheck="false"${ro}></label>
          <label class="tm-check"><input type="checkbox" data-f="claude"${d.claude ? ' checked' : ''}${ro}> <span><b>Claude-only</b> — the session runs Claude Code ${d.mode === 'ssh' ? '<em>on the host</em>' : '<em>on this computer</em>'}</span></label>
          ${d.claude ? `<label class="tm-check sub"><input type="checkbox" data-f="claudeResume"${d.claudeResume ? ' checked' : ''}${ro}> Resume last conversation on rebuild (<code>claude --continue</code>)</label>` : ''}
          <label class="tm-check"><input type="checkbox" data-f="autoConnect"${d.autoConnect ? ' checked' : ''}${ro}> <span><b>Auto-connect</b> — make sure this session is running when Accretion starts (rebuilt if it died)</span></label>
          <button type="button" class="tm-apply" data-act="apply"${ro}>Apply &amp; reconnect</button>
        </section>
        ${d.claude ? '' : `<section>
          <h4>Startup commands <span class="tm-hint">run when the session is created</span></h4>
          <textarea data-f="startup" rows="3" placeholder="one per line, e.g.&#10;cd ~/project&#10;npm run dev" spellcheck="false"${ro}>${esc(d.startup.join('\n'))}</textarea>
        </section>`}
        <section>
          <h4>Layout <span class="tm-hint">windows &amp; panes to rebuild</span></h4>
          <p class="tm-small">${lay || 'Not saved — a rebuilt session gets one window.'}</p>
          <div class="tm-btns"><button type="button" data-act="savelayout"${ro}>Save current layout</button>${d.layout ? `<button type="button" data-act="clearlayout"${ro}>Clear</button>` : ''}</div>
        </section>
        <section>
          <h4>Snippets <span class="tm-hint">click ▶ to send</span></h4>
          <div class="tm-snips">${d.snippets.map((s) => `<div class="tm-snip" data-id="${esc(s.id)}"><button type="button" class="tm-run" data-run title="Send to the terminal">▶</button><div class="tm-snip-t"><b>${esc(s.name || s.cmd.split('\n')[0])}</b>${s.name ? `<code>${esc(s.cmd.split('\n')[0])}</code>` : ''}</div>${this.readOnly ? '' : '<button type="button" data-edit title="Edit">✎</button><button type="button" data-del title="Delete">✕</button>'}</div>`).join('') || '<p class="tm-small">No snippets yet.</p>'}</div>
          ${this.readOnly ? '' : '<button type="button" class="tm-add" data-act="addsnip">＋ Add snippet</button>'}
        </section>
        <section>
          <h4>Notes</h4>
          <textarea data-f="notes" rows="4" placeholder="What this session is for, hosts, gotchas…"${ro}>${esc(d.notes)}</textarea>
        </section>
        <section>
          <h4>Pane outputs <span class="tm-hint">${d.outputs.length}/${C.MAX_OUTPUTS} · oldest deleted automatically</span></h4>
          <div class="tm-outs">${d.outputs.slice().reverse().map((o) => `
            <div class="tm-out-item" data-id="${esc(o.id)}">
              <div class="tm-out-main">
                <b class="tm-out-name" title="${esc(o.name || 'Untitled output')}">${esc(o.name || 'Untitled output')}</b>
                <span class="tm-out-meta">🕒 ${esc(stampOf(o.at))} · ${o.text.split('\n').length} lines${o.session ? ' · ' + esc(o.session) : ''}</span>
              </div>
              <div class="tm-out-act">
                <button type="button" data-o="view" title="View">👁</button>
                <button type="button" data-o="copy" title="Copy to clipboard">⧉</button>
                <button type="button" data-o="dl" title="Download .txt">⤓</button>
                ${this.readOnly ? '' : '<button type="button" data-o="rename" title="Rename">✎</button><button type="button" data-o="del" title="Delete">✕</button>'}
              </div>
            </div>`).join('') || '<p class="tm-small">None yet — save what\'s on screen (and its scrollback) to keep it with this file.</p>'}</div>
          <div class="tm-btns"><button type="button" data-act="saveoutput"${ro}>＋ Save pane output</button>${d.outputs.length > 1 ? '<button type="button" data-act="dlall">⤓ Download all</button>' : ''}</div>
        </section>`;
      this._bindSide();
    }

    _bindSide() {
      const S = this.side;
      const d = this.data;
      S.querySelectorAll('input[name="tm-mode"]').forEach((r) => r.addEventListener('change', async () => {
        const next = r.value;
        if (next === d.mode) return;
        if (!(await ask(`Switch this terminal to ${next === 'ssh' ? 'an SSH session' : 'a local session'}?${d.claude ? ' Claude will then run ' + (next === 'ssh' ? 'on the SSH host.' : 'on this computer.') : ''} The current session keeps running.`, { title: 'Switch connection', okLabel: 'Switch' }))) { this._renderSide(); return; }
        d.mode = next;
        if (next === 'local') { d.host = ''; d.jump = ''; d.port = null; }
        this._changed();
        this._renderSide();
        if (next === 'ssh' && !d.host) this._focusField('host');
        else this.connect({ fresh: true });
      }));
      S.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
        const f = el.dataset.f;
        if (el.type === 'checkbox') d[f] = el.checked;
        else if (f === 'port') d.port = el.value ? Number(el.value) : null;
        else if (f === 'startup') d.startup = el.value.split('\n').map((x) => x.trimEnd()).filter((x) => x.trim());
        else if (f === 'session') { d.session = C.cleanSession(el.value); el.value = d.session; }
        else if (f === 'host' || f === 'jump') { d[f] = C.cleanHost(el.value); el.value = d[f]; }
        else d[f] = el.value;
        this._changed();
        if (f === 'claude') this._renderSide();
      }));
      const on = (act, fn) => { const b = S.querySelector(`[data-act="${act}"]`); if (b) b.addEventListener('click', fn); };
      on('apply', () => this.connect({ fresh: true }));
      on('savelayout', () => this.saveLayout());
      on('clearlayout', () => { d.layout = null; this._changed(); this._renderSide(); });
      on('saveoutput', () => this.saveOutput());
      on('dlall', () => this._downloadOutputs(d.outputs));
      S.querySelectorAll('.tm-out-item').forEach((row) => {
        const o = d.outputs.find((x) => x.id === row.dataset.id);
        row.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', async () => {
          const a = b.dataset.o;
          if (a === 'view') this._viewOutput(o);
          else if (a === 'copy') { const ok = await copyText(o.text); this._flash(ok ? 'Output copied' : 'Copy failed'); }
          else if (a === 'dl') this._downloadOutputs([o]);
          else if (a === 'rename') this._renameOutput(o.id);
          else if (a === 'del') {
            if (!(await ask('Delete “' + (o.name || 'Untitled output') + '” (' + stampOf(o.at) + ')?', { title: 'Delete output', okLabel: 'Delete', danger: true }))) return;
            d.outputs = d.outputs.filter((x) => x !== o);
            this._changed();
            this._renderSide();
          }
        }));
        row.querySelector('.tm-out-main').addEventListener('dblclick', () => this._viewOutput(o));
      });
      on('addsnip', () => this._editSnippet(null));
      S.querySelectorAll('.tm-snip').forEach((row) => {
        const sn = d.snippets.find((x) => x.id === row.dataset.id);
        row.querySelector('[data-run]').addEventListener('click', () => this.sendSnippet(sn));
        const ed = row.querySelector('[data-edit]');
        if (ed) ed.addEventListener('click', () => this._editSnippet(sn));
        const del = row.querySelector('[data-del]');
        if (del) del.addEventListener('click', () => { d.snippets = d.snippets.filter((x) => x !== sn); this._changed(); this._renderSide(); });
      });
    }

    _editSnippet(sn) {
      const d = this.data;
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      ov.innerHTML = `<div class="md-dialog-box tm-snip-ed" role="dialog" aria-modal="true">
        <div class="md-dialog-head"><span>${sn ? 'Edit' : 'New'} snippet</span><button type="button" data-x>×</button></div>
        <div class="md-dialog-body">
          <label class="tm-f">Name <input data-n value="${esc(sn ? sn.name : '')}" placeholder="optional"></label>
          <label class="tm-f">Command <textarea data-c rows="4" spellcheck="false">${esc(sn ? sn.cmd : '')}</textarea></label>
          <label class="tm-check"><input type="checkbox" data-e${!sn || sn.enter ? ' checked' : ''}> Press Enter after sending</label>
        </div>
        <div class="md-dialog-actions"><span class="md-spacer"></span><button type="button" data-x2>Cancel</button><button type="button" class="md-primary" data-ok>Save</button></div></div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('[data-x]').addEventListener('click', close);
      ov.querySelector('[data-x2]').addEventListener('click', close);
      ov.querySelector('[data-ok]').addEventListener('click', () => {
        const cmd = ov.querySelector('[data-c]').value;
        if (!cmd.trim()) return;
        const val = { id: sn ? sn.id : C.uid('s_'), name: ov.querySelector('[data-n]').value.trim(), cmd, enter: ov.querySelector('[data-e]').checked };
        if (sn) Object.assign(sn, val); else d.snippets.push(val);
        close();
        this._changed();
        this._renderSide();
      });
      ov.querySelector('[data-c]').focus();
    }
  }

  global.TerminalEngine = TerminalEngine;
})(typeof window !== 'undefined' ? window : this);
