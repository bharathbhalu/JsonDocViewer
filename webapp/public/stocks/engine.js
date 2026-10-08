/* DocViewer stocks engine — watchlist with live quotes and price alerts. */
(function (global) {
  const C = global.StocksCore;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sym = (cur) => (cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur ? cur + ' ' : '');
  const fmt = (n, d) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }));
  const money = (n, cur) => (n == null || !Number.isFinite(Number(n)) ? '—' : sym(cur) + fmt(n));
  const signed = (n, d) => (n == null || !Number.isFinite(Number(n)) ? '—' : (n > 0 ? '+' : '') + fmt(n, d));
  const timeOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ask = (m, o) => (global.uiConfirm ? global.uiConfirm(m, o) : Promise.resolve(true));

  function sparkline(points, prevClose, w, h) {
    if (!points || points.length < 2) return '<span class="sk-none">—</span>';
    const ys = points.map((p) => p[1]).concat(prevClose != null ? [prevClose] : []);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const span = hi - lo || 1;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0] || t0 + 1;
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - 2) + 1;
    const y = (v) => h - 1 - ((v - lo) / span) * (h - 2);
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
    const up = points[points.length - 1][1] >= (prevClose != null ? prevClose : points[0][1]);
    const base = prevClose != null ? `<line x1="0" x2="${w}" y1="${y(prevClose).toFixed(1)}" y2="${y(prevClose).toFixed(1)}" class="sk-base"/>` : '';
    return `<svg class="sk ${up ? 'up' : 'down'}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${base}<path d="${d}"/></svg>`;
  }

  class StocksEngine {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = opts || {};
      this.data = C.createEmpty();
      this.quotes = {};
      this.alertState = {};
      this.events = [];
      this.open = new Set(); // tickers whose alert editor is open
      this.readOnly = !!this.opts.readOnly;
      this.lastFetch = 0;
      this.fetching = false;
      this.root = document.createElement('div');
      this.root.className = 'stk-root';
      stage.innerHTML = '';
      stage.appendChild(this.root);
      this._onVis = () => { if (!document.hidden) this.refresh(); };
      document.addEventListener('visibilitychange', this._onVis);
      this.timer = setInterval(() => this._tick(), 1000);
    }

    // ---------- board API ----------
    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.createEmpty();
      this.render();
      this.refresh();
      this._loadAlertState();
    }
    serializeToHtml() { return C.serializeToHtml(this.data); }
    setReadOnly(on) { this.readOnly = !!on; this.render(); }
    flushEdit() {}
    destroy() {
      clearInterval(this.timer);
      clearTimeout(this.checkTimer);
      document.removeEventListener('visibilitychange', this._onVis);
      this.stage.innerHTML = '';
    }
    collapseAll() {}
    expandAll() {}

    _changed(rerender) {
      if (this.opts.onChange) this.opts.onChange();
      if (rerender !== false) this.render();
      // Let the server re-check alerts once the file is saved.
      clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => {
        fetch('/api/stocks/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
        this._loadAlertState();
      }, 4000);
    }

    // ---------- data ----------
    _tick() {
      const left = Math.max(0, Math.round((this.lastFetch + this.data.refreshSec * 1000 - Date.now()) / 1000));
      const el = this.root.querySelector('.stk-next');
      if (el) el.textContent = this.fetching ? 'updating…' : this.lastFetch ? `next in ${left}s` : '';
      if (!document.hidden && !this.fetching && Date.now() - this.lastFetch >= this.data.refreshSec * 1000) this.refresh();
      if (Date.now() - (this.lastStateLoad || 0) > 30000) this._loadAlertState();
    }

    async refresh() {
      if (this.fetching || !this.data.tickers.length) { this.lastFetch = Date.now(); return; }
      this.fetching = true;
      try {
        const keys = [...new Set(this.data.tickers.map(C.keyOf))].join(',');
        const r = await fetch('/api/stocks/quotes?points=1&keys=' + encodeURIComponent(keys), { cache: 'no-store' });
        const d = await r.json();
        if (r.ok) {
          this.quotes = d.quotes || {};
          // Fill in names the first time we learn them.
          let named = false;
          this.data.tickers.forEach((t) => {
            const q = this.quotes[C.keyOf(t)];
            if (q && q.quote && q.quote.name && !t.name) { t.name = q.quote.name.slice(0, 160); named = true; }
          });
          if (named) this._changed(false);
        }
      } catch (e) { /* offline: keep last */ }
      this.fetching = false;
      this.lastFetch = Date.now();
      this._updateQuotes();
    }

    // Refresh only the live cells, so typing in an editor isn't disturbed.
    _updateQuotes() {
      const anyHold = this.data.tickers.some((t) => t.qty);
      const tbody = this.root.querySelector('.stk-table tbody');
      const headCols = this.root.querySelectorAll('.stk-table thead th').length;
      const wantCols = anyHold ? 9 : 7;
      if (!tbody || headCols !== wantCols) { this.render(); return; }
      const tmp = document.createElement('tbody');
      tmp.innerHTML = this.data.tickers.map((t, i) => this._row(t, i, anyHold)).join('');
      tmp.querySelectorAll('tr.stk-row').forEach((fresh) => {
        const row = tbody.querySelector(`tr.stk-row[data-id="${fresh.dataset.id}"]`);
        if (!row) return;
        row.className = fresh.className;
        const a = row.children;
        const b = fresh.children;
        for (let i = 0; i < b.length && i < a.length; i++) {
          if (b[i].classList.contains('c-alerts') || b[i].classList.contains('c-act')) continue;
          if (a[i].innerHTML !== b[i].innerHTML) a[i].innerHTML = b[i].innerHTML;
          a[i].className = b[i].className;
        }
      });
      const markets = {};
      Object.values(this.quotes).forEach((x) => { if (x.quote) markets[x.quote.market] = markets[x.quote.market] || x.quote.open; });
      const mk = this.root.querySelector('.stk-markets');
      if (mk) mk.innerHTML = ['NSE', 'BSE', 'US'].filter((m) => m in markets).map((m) => `<span class="stk-mkt ${markets[m] ? 'open' : ''}">${m} ${markets[m] ? 'open' : 'closed'}</span>`).join('');
      const up = this.root.querySelector('.stk-updated');
      if (up) up.innerHTML = 'Updated ' + timeOf(this.lastFetch) + ' · <span class="stk-next"></span>';
    }

    async _loadAlertState() {
      this.lastStateLoad = Date.now();
      const p = this.opts.getPath && this.opts.getPath();
      if (!p) return;
      try {
        const r = await fetch('/api/stocks/alert-state?path=' + encodeURIComponent(p), { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        this.alertState = d.alerts || {};
        this.events = d.events || [];
        this._renderLog();
        this.root.querySelectorAll('[data-alert-chip]').forEach((c) => this._paintChip(c));
      } catch (e) { /* ignore */ }
    }

    _ticker(id) { return this.data.tickers.find((t) => t.id === id); }

    // ---------- render ----------
    render() {
      const d = this.data;
      const ro = this.readOnly;
      const markets = {};
      Object.values(this.quotes).forEach((x) => { if (x.quote) markets[x.quote.market] = markets[x.quote.market] || x.quote.open; });
      const anyHold = d.tickers.some((t) => t.qty);
      const focus = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
      this.root.innerHTML = `
        <div class="stk-head">
          <input class="stk-title" value="${esc(d.title)}" ${ro ? 'disabled' : ''} aria-label="Watchlist name" data-focus-key="title">
          <span class="stk-markets">${['NSE', 'BSE', 'US'].filter((m) => m in markets).map((m) => `<span class="stk-mkt ${markets[m] ? 'open' : ''}">${m} ${markets[m] ? 'open' : 'closed'}</span>`).join('')}</span>
          <span class="stk-spacer"></span>
          <span class="stk-updated">${this.lastFetch ? 'Updated ' + timeOf(this.lastFetch) : ''} · <span class="stk-next"></span></span>
          <label class="stk-every">Every <select data-refresh ${ro ? 'disabled' : ''}>${C.REFRESH_CHOICES.map((s) => `<option value="${s}"${s === d.refreshSec ? ' selected' : ''}>${s < 60 ? s + 's' : s / 60 + ' min'}</option>`).join('')}</select></label>
          <button type="button" class="stk-btn" data-refresh-now title="Refresh now">↻</button>
        </div>
        ${ro ? '' : `<form class="stk-add">
          <select data-market aria-label="Market">${C.MARKETS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select>
          <input data-symbol placeholder="${esc(C.MARKETS[0].hint)}" aria-label="Ticker symbol" autocomplete="off" spellcheck="false" data-focus-key="add">
          <button type="submit" class="stk-btn primary">＋ Add ticker</button>
          <span class="stk-add-msg"></span>
        </form>`}
        <div class="stk-table-wrap">
          <table class="stk-table">
            <thead><tr>
              <th class="c-sym">Ticker</th><th class="c-num">Price</th><th class="c-num">Change</th><th class="c-range">Day range</th><th class="c-spark">Today</th>
              ${anyHold ? '<th class="c-num">Holding</th><th class="c-num">P&amp;L</th>' : ''}
              <th class="c-alerts">Alerts</th><th class="c-act"></th>
            </tr></thead>
            <tbody>${d.tickers.map((t, i) => this._row(t, i, anyHold)).join('') || `<tr><td colspan="9" class="stk-empty">No tickers yet — add one above.</td></tr>`}</tbody>
          </table>
        </div>
        <details class="stk-log"${this.logOpen ? ' open' : ''}><summary>Alert log <span class="stk-log-n"></span></summary><div class="stk-log-list"></div></details>
        <p class="stk-foot">Quotes from Google Finance (Yahoo Finance as fallback), may be delayed up to 15–20 min. Alerts are checked by the app's server about every minute while a market is open — even when this file isn't open — and show as a desktop notification plus a card in Accretion.</p>`;
      this._bind();
      this._renderLog();
      this.root.querySelectorAll('[data-alert-chip]').forEach((c) => this._paintChip(c));
      if (focus) { const el = this.root.querySelector(`[data-focus-key="${focus}"]`); if (el) el.focus(); }
    }

    _row(t, i, anyHold) {
      const res = this.quotes[C.keyOf(t)];
      const q = res && res.quote;
      const cur = (q && q.currency) || (C.MARKETS.find((m) => m.id === t.market) || {}).currency;
      const dir = q && q.change > 0 ? 'up' : q && q.change < 0 ? 'down' : '';
      const ro = this.readOnly;
      let range = '<span class="sk-none">—</span>';
      if (q && q.dayLow != null && q.dayHigh != null && q.dayHigh > q.dayLow) {
        const pos = Math.min(100, Math.max(0, ((q.price - q.dayLow) / (q.dayHigh - q.dayLow)) * 100));
        range = `<div class="rg"><span>${fmt(q.dayLow)}</span><div class="rg-bar"><i style="left:${pos.toFixed(1)}%"></i></div><span>${fmt(q.dayHigh)}</span></div>`;
      }
      const hold = t.qty && q ? q.price * t.qty : null;
      const pnl = t.qty && t.cost != null && q ? (q.price - t.cost) * t.qty : null;
      const open = this.open.has(t.id);
      return `
        <tr class="stk-row ${dir}${res && res.error && !q ? ' err' : ''}" data-id="${esc(t.id)}">
          <td class="c-sym">
            <div class="sym"><b>${esc(t.symbol)}</b><span class="mk mk-${t.market}">${t.market}</span>${q && q.stale ? '<span class="stale" title="Showing the last known price — the latest fetch failed">stale</span>' : ''}</div>
            <div class="nm" title="${esc(t.name || (q && q.name) || '')}">${esc(t.name || (q && q.name) || (res && res.error ? 'Not found: ' + res.error : 'Loading…'))}</div>
            ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}
          </td>
          <td class="c-num price">${q ? money(q.price, cur) : '—'}</td>
          <td class="c-num chg">${q ? `<div>${signed(q.change)}</div><div class="pct">${signed(q.pct)}%</div>` : '—'}</td>
          <td class="c-range">${range}</td>
          <td class="c-spark">${q ? sparkline(q.points, q.prevClose, 120, 34) : '<span class="sk-none">—</span>'}</td>
          ${anyHold ? `<td class="c-num">${t.qty ? `<div>${money(hold, cur)}</div><div class="pct">${fmt(t.qty, 0)} × ${t.cost != null ? money(t.cost, cur) : '—'}</div>` : ''}</td>
          <td class="c-num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${pnl != null ? `<div>${signed(pnl)}</div><div class="pct">${signed((pnl / (t.cost * t.qty)) * 100)}%</div>` : ''}</td>` : ''}
          <td class="c-alerts">
            ${t.alerts.map((a) => `<button type="button" class="al-chip${a.enabled ? '' : ' off'}" data-alert-chip="${esc(a.id)}" data-t="${esc(t.id)}" title="${esc((C.ALERT_TYPES.find((x) => x.id === a.type) || {}).label + ' ' + a.value + (a.note ? ' · ' + a.note : '') + ' · ' + (a.mode === 'once' ? 'once' : 'every crossing'))}">🔔 ${esc(C.describeAlert(a, cur))}</button>`).join('')}
            ${ro ? '' : `<button type="button" class="al-add" data-edit="${esc(t.id)}">${open ? 'Close' : t.alerts.length ? 'Edit' : '＋ Alert'}</button>`}
          </td>
          <td class="c-act">${ro ? '' : `
            <button type="button" class="ic" data-up="${esc(t.id)}" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="ic" data-down="${esc(t.id)}" title="Move down"${i === this.data.tickers.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="ic" data-del="${esc(t.id)}" title="Remove ticker">✕</button>`}
          </td>
        </tr>
        ${open && !ro ? `<tr class="stk-edit-row"><td colspan="9">${this._editor(t, q, cur)}</td></tr>` : ''}`;
    }

    _editor(t, q, cur) {
      const price = q ? q.price : null;
      const presets = price ? [
        ['above', +(price * 1.05).toFixed(2), '+5%'], ['below', +(price * 0.95).toFixed(2), '−5%'],
        ['above', +(price * 1.1).toFixed(2), '+10%'], ['below', +(price * 0.9).toFixed(2), '−10%'],
        ['pctUp', 3, 'day +3%'], ['pctDown', 3, 'day −3%'],
      ] : [];
      return `
        <div class="stk-editor" data-t="${esc(t.id)}">
          <div class="ed-alerts">
            ${t.alerts.map((a) => `
              <div class="ed-alert" data-a="${esc(a.id)}">
                <label class="ed-on" title="Alert on/off"><input type="checkbox" data-f="enabled"${a.enabled ? ' checked' : ''}></label>
                <select data-f="type">${C.ALERT_TYPES.map((x) => `<option value="${x.id}"${x.id === a.type ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
                <input type="number" step="any" data-f="value" value="${a.value}" aria-label="Value"><span class="ed-unit">${a.type === 'pctUp' || a.type === 'pctDown' ? '%' : esc(cur || '')}</span>
                <select data-f="mode">${C.ALERT_MODES.map((x) => `<option value="${x.id}"${x.id === a.mode ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
                <input type="text" data-f="note" value="${esc(a.note)}" placeholder="Note (optional)" maxlength="300">
                <span class="ed-state" data-alert-chip="${esc(a.id)}" data-t="${esc(t.id)}" data-plain="1"></span>
                <button type="button" class="ic" data-rearm="${esc(a.id)}" title="Re-arm: let a fired 'once' alert fire again">⟲</button>
                <button type="button" class="ic" data-del-alert="${esc(a.id)}" title="Delete alert">✕</button>
              </div>`).join('') || '<p class="ed-none">No alerts yet.</p>'}
          </div>
          <div class="ed-add">
            <button type="button" class="stk-btn" data-new-alert>＋ Add alert</button>
            ${presets.length ? `<span class="ed-presets">Quick: ${presets.map(([type, v, label]) => `<button type="button" data-preset="${type}|${v}">${label}${type === 'above' || type === 'below' ? ' (' + money(v, cur) + ')' : ''}</button>`).join('')}</span>` : ''}
          </div>
          <div class="ed-meta">
            <label>Note <input type="text" data-tf="note" value="${esc(t.note)}" placeholder="Why you're watching it" maxlength="1000"></label>
            <label>Qty <input type="number" step="any" data-tf="qty" value="${t.qty == null ? '' : t.qty}" placeholder="—"></label>
            <label>Avg cost <input type="number" step="any" data-tf="cost" value="${t.cost == null ? '' : t.cost}" placeholder="—"></label>
          </div>
        </div>`;
    }

    // Redraw one ticker's alert chips (after editing an alert in place).
    _refreshChips(t) {
      const row = this.root.querySelector(`tr.stk-row[data-id="${t.id}"]`);
      if (!row) return;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = this._row(t, this.data.tickers.indexOf(t), this.data.tickers.some((x) => x.qty));
      const fresh = tmp.querySelector('.c-alerts');
      const cell = row.querySelector('.c-alerts');
      if (!fresh || !cell) return;
      cell.innerHTML = fresh.innerHTML;
      cell.querySelectorAll('[data-alert-chip]').forEach((c) => this._paintChip(c));
      cell.querySelectorAll('.al-chip').forEach((b) => b.addEventListener('click', () => { this.open.add(b.dataset.t); this.render(); }));
      const ed = cell.querySelector('[data-edit]');
      if (ed) ed.addEventListener('click', () => { if (this.open.has(t.id)) this.open.delete(t.id); else this.open.add(t.id); this.render(); });
    }

    _paintChip(el) {
      const st = this.alertState[el.getAttribute('data-alert-chip')];
      const t = this._ticker(el.dataset.t);
      const a = t && t.alerts.find((x) => x.id === el.getAttribute('data-alert-chip'));
      el.classList.remove('fired', 'live');
      let text = '';
      if (a && !a.enabled) text = 'off';
      else if (st && st.firedAt && a && a.mode === 'once') { el.classList.add('fired'); text = 'fired ' + new Date(st.firedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
      else if (st && st.cond) { el.classList.add('live'); text = 'condition true now'; }
      else if (st) text = 'armed';
      else text = 'waiting for first check';
      if (el.dataset.plain) el.textContent = text;
      else el.title = el.title.replace(/ · \[.*\]$/, '') + ' · [' + text + ']';
    }

    _renderLog() {
      const list = this.root.querySelector('.stk-log-list');
      if (!list) return;
      const n = this.root.querySelector('.stk-log-n');
      if (n) n.textContent = this.events.length ? '(' + this.events.length + ')' : '';
      list.innerHTML = this.events.slice().reverse().map((e) => `
        <div class="lg"><span class="lg-t">${esc(new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${esc(e.message)}</span></div>`).join('') || '<p class="ed-none">No alerts have fired yet.</p>';
    }

    // ---------- events ----------
    _bind() {
      const R = this.root;
      const title = R.querySelector('.stk-title');
      title.addEventListener('change', () => { this.data.title = title.value.trim().slice(0, 120) || 'Watchlist'; this._changed(false); });
      R.querySelector('[data-refresh]').addEventListener('change', (e) => { this.data.refreshSec = Number(e.target.value); this._changed(false); });
      R.querySelector('[data-refresh-now]').addEventListener('click', () => { this.lastFetch = 0; this.refresh(); });
      R.querySelector('.stk-log').addEventListener('toggle', (e) => { this.logOpen = e.target.open; });
      const add = R.querySelector('.stk-add');
      if (add) {
        const mk = add.querySelector('[data-market]');
        const input = add.querySelector('[data-symbol]');
        mk.value = this.lastMarket || 'NSE';
        input.placeholder = (C.MARKETS.find((m) => m.id === mk.value) || {}).hint || '';
        mk.addEventListener('change', () => { this.lastMarket = mk.value; input.placeholder = (C.MARKETS.find((m) => m.id === mk.value) || {}).hint || ''; input.focus(); });
        add.addEventListener('submit', (e) => { e.preventDefault(); this._addTicker(mk.value, input.value); });
      }
      R.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.edit;
        if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
        this.render();
      }));
      R.querySelectorAll('.al-chip').forEach((b) => b.addEventListener('click', () => { if (this.readOnly) return; this.open.add(b.dataset.t); this.render(); }));
      R.querySelectorAll('[data-up],[data-down]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.up || b.dataset.down;
        const i = this.data.tickers.findIndex((t) => t.id === id);
        const j = b.dataset.up ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= this.data.tickers.length) return;
        const list = this.data.tickers;
        [list[i], list[j]] = [list[j], list[i]];
        this._changed();
      }));
      R.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const t = this._ticker(b.dataset.del);
        if (!t) return;
        if (!(await ask(`Remove ${t.symbol}${t.alerts.length ? ` and its ${t.alerts.length} alert${t.alerts.length === 1 ? '' : 's'}` : ''} from this watchlist?`, { title: 'Remove ticker', okLabel: 'Remove', danger: true }))) return;
        this.data.tickers = this.data.tickers.filter((x) => x.id !== t.id);
        this._changed();
      }));
      R.querySelectorAll('.stk-editor').forEach((ed) => this._bindEditor(ed));
    }

    _bindEditor(ed) {
      const t = this._ticker(ed.dataset.t);
      if (!t) return;
      ed.querySelectorAll('.ed-alert').forEach((row) => {
        const a = t.alerts.find((x) => x.id === row.dataset.a);
        row.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          if (f === 'enabled') a.enabled = inp.checked;
          else if (f === 'value') { const v = Number(inp.value); if (Number.isFinite(v)) a.value = v; else { inp.value = a.value; return; } }
          else a[f] = inp.value;
          this._changed(f === 'type' || f === 'enabled');
          if (f !== 'type' && f !== 'enabled') this._refreshChips(t);
        }));
        row.querySelector('[data-del-alert]').addEventListener('click', () => { t.alerts = t.alerts.filter((x) => x.id !== a.id); this._changed(); });
        row.querySelector('[data-rearm]').addEventListener('click', async () => {
          const p = this.opts.getPath && this.opts.getPath();
          await fetch('/api/stocks/rearm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, alertId: a.id }) }).catch(() => {});
          if (global.setStatus) global.setStatus('Alert re-armed', 'ok');
          setTimeout(() => this._loadAlertState(), 1500);
        });
      });
      const newAlert = (type, value) => {
        const q = this.quotes[C.keyOf(t)] && this.quotes[C.keyOf(t)].quote;
        const v = value != null ? value : type === 'pctUp' || type === 'pctDown' ? 3 : q ? +(q.price * 1.05).toFixed(2) : 0;
        t.alerts.push(C.normalizeAlert({ type, value: v, mode: 'once', enabled: true }));
        this._changed();
        const inputs = this.root.querySelectorAll(`.stk-editor[data-t="${t.id}"] [data-f="value"]`);
        const last = inputs[inputs.length - 1];
        if (last) { last.focus(); last.select(); }
      };
      ed.querySelector('[data-new-alert]').addEventListener('click', () => newAlert('above'));
      ed.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { const [type, v] = b.dataset.preset.split('|'); newAlert(type, Number(v)); }));
      ed.querySelectorAll('[data-tf]').forEach((inp) => inp.addEventListener('change', () => {
        const f = inp.dataset.tf;
        if (f === 'note') t.note = inp.value.slice(0, 1000);
        else { const v = inp.value === '' ? null : Number(inp.value); t[f] = Number.isFinite(v) ? v : null; }
        this._changed(f !== 'note');
      }));
    }

    async _addTicker(market, raw) {
      const msg = this.root.querySelector('.stk-add-msg');
      const symbols = String(raw || '').split(/[,\s]+/).map(C.cleanSymbol).filter(Boolean);
      if (!symbols.length) { this.root.querySelector('[data-symbol]').focus(); return; }
      msg.textContent = 'Looking up…';
      msg.className = 'stk-add-msg';
      const keys = symbols.map((s) => market + ':' + s);
      let quotes = {};
      try {
        const r = await fetch('/api/stocks/quotes?points=1&keys=' + encodeURIComponent(keys.join(',')), { cache: 'no-store' });
        quotes = (await r.json()).quotes || {};
      } catch (e) { /* offline */ }
      const added = [];
      const missing = [];
      for (const s of symbols) {
        const key = market + ':' + s;
        if (this.data.tickers.some((t) => C.keyOf(t) === key)) continue;
        const q = quotes[key] && quotes[key].quote;
        if (!q) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await ask(`Couldn't find a price for ${s} on ${market}${quotes[key] && quotes[key].error ? ' (' + quotes[key].error + ')' : ''}.\n\nAdd it anyway?`, { title: 'Ticker not found', okLabel: 'Add anyway' }))) { missing.push(s); continue; }
        }
        this.data.tickers.push(C.normalizeTicker({ symbol: s, market, name: q ? q.name : '' }));
        if (q) this.quotes[key] = quotes[key];
        added.push(s);
      }
      this.lastMarket = market;
      if (added.length) this._changed();
      const m2 = this.root.querySelector('.stk-add-msg');
      if (m2) {
        m2.textContent = added.length ? 'Added ' + added.join(', ') : missing.length ? 'Not added: ' + missing.join(', ') : 'Already in the list';
        m2.className = 'stk-add-msg ' + (added.length ? 'ok' : 'err');
      }
      const inp = this.root.querySelector('[data-symbol]');
      if (inp) { inp.value = ''; inp.focus(); }
    }
  }

  global.StocksEngine = StocksEngine;
})(typeof window !== 'undefined' ? window : this);
