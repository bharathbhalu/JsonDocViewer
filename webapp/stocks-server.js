// Stocks: live quotes (Google Finance pages, Yahoo Finance as fallback) and
// price alerts that are checked on the server — so they fire even when no
// stocks file is open. Alerts are defined in stocks files (data-docviewer=
// "stocks"); their runtime state and the alert log live in
// <data>/.accretion/stock-alerts.json. A triggered alert raises a macOS
// notification (when the server runs on a Mac) and an in-app card in every
// open Accretion window (they poll /api/stocks/events).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const StocksCore = require(path.join(__dirname, 'public', 'stocks', 'core.js'));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const QUOTE_TTL_MS = 20 * 1000;
const US_EXCHANGES = ['NASDAQ', 'NYSE', 'NYSEARCA', 'NYSEAMERICAN', 'BATS'];

module.exports = function setupStocks(app, deps) {
  const { dataRoot, stateFile, writeJsonAtomic, safeReaddir, peekFileKind, commitFile, resolveSafe } = deps;

  // ---------- quote fetching ----------
  const cache = new Map(); // key -> { at, quote, error }
  const inflight = new Map();
  const usExchange = new Map(); // US symbol -> exchange that worked on Google
  let yahooDownUntil = 0;
  let googleDownUntil = 0;

  async function get(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) }, opts || {}));
    if (r.status === 429) { const e = new Error('rate limited'); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  // Google Finance embeds its data as AF_initDataCallback({key:'ds:N', data:[…]}).
  function dsBlock(html, n) {
    const re = new RegExp("AF_initDataCallback\\(\\{key: 'ds:" + n + "'[\\s\\S]*?data:([\\s\\S]*?), sideChannel");
    const m = re.exec(html);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function parseGoogle(html) {
    const d = dsBlock(html, 2);
    const e = d && d[0] && d[0][0] && d[0][0][0];
    if (!Array.isArray(e) || !Array.isArray(e[1]) || !Array.isArray(e[5])) return null;
    const offset = Number(e[13]) || 0;
    let openAt = null;
    let closeAt = null;
    try {
      const h = e[19] && e[19][0];
      const toMs = (a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] || 0, a[4] || 0) - offset * 1000;
      if (h && h[1] && h[2]) { openAt = toMs(h[1]); closeAt = toMs(h[2]); }
    } catch (err) { /* no hours */ }
    const quote = {
      name: e[2] || '',
      currency: e[4] || '',
      price: Number(e[5][0]),
      change: Number(e[5][1]),
      pct: Number(e[5][2]),
      prevClose: Number(e[7]),
      time: e[11] && e[11][0] ? Number(e[11][0]) * 1000 : Date.now(),
      tz: e[12] || '',
      openAt,
      closeAt,
      source: 'google',
      exchange: e[1][1],
    };
    // Intraday candles [open, close, high, low, "ISO time", volume].
    const block = /AF_initDataCallback\(\{key: 'ds:10'[\s\S]*?sideChannel/.exec(html);
    const points = [];
    if (block) {
      const re = /\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),"([^"]+)",(\d+)\]/g;
      let m;
      while ((m = re.exec(block[0])) && points.length < 500) points.push([Date.parse(m[5]), Number(m[2]), Number(m[3]), Number(m[4])]);
    }
    if (points.length) {
      quote.points = points.map((p) => [p[0], p[1]]);
      quote.dayHigh = Math.max(...points.map((p) => p[2]));
      quote.dayLow = Math.min(...points.map((p) => p[3]));
    }
    return Number.isFinite(quote.price) ? quote : null;
  }

  async function fromGoogle(symbol, market) {
    if (Date.now() < googleDownUntil) throw new Error('Google Finance unavailable');
    const tries = market === 'NSE' ? [symbol + ':NSE']
      : market === 'BSE' ? (/^\d+$/.test(symbol) ? [symbol + ':BOM'] : [])
        : [usExchange.get(symbol), ...US_EXCHANGES].filter((x, i, a) => x && a.indexOf(x) === i).map((ex) => symbol + ':' + ex);
    for (const q of tries) {
      try {
        const html = await get('https://www.google.com/finance/quote/' + encodeURIComponent(q) + '?hl=en');
        const quote = parseGoogle(html);
        if (quote) {
          if (market === 'US') usExchange.set(symbol, q.split(':')[1]);
          return quote;
        }
      } catch (err) {
        if (err.rateLimited) { googleDownUntil = Date.now() + 10 * 60000; throw err; }
      }
    }
    throw new Error('not found on Google Finance');
  }

  async function fromYahoo(symbol, market) {
    if (Date.now() < yahooDownUntil) throw new Error('Yahoo Finance unavailable');
    const ysym = market === 'NSE' ? symbol + '.NS' : market === 'BSE' ? symbol + '.BO' : symbol;
    try {
      const txt = await get('https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ysym) + '?interval=5m&range=1d');
      const j = JSON.parse(txt);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.meta) throw new Error('not found on Yahoo Finance');
      const m = r.meta;
      const prev = Number(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
      const price = Number(m.regularMarketPrice);
      const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const points = (r.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter((p) => p[1] != null);
      const period = m.currentTradingPeriod && m.currentTradingPeriod.regular;
      return {
        name: m.longName || m.shortName || '',
        currency: m.currency || '',
        price,
        change: price - prev,
        pct: prev ? ((price - prev) / prev) * 100 : null,
        prevClose: prev,
        time: (m.regularMarketTime || 0) * 1000 || Date.now(),
        tz: m.exchangeTimezoneName || '',
        openAt: period ? period.start * 1000 : null,
        closeAt: period ? period.end * 1000 : null,
        dayHigh: m.regularMarketDayHigh,
        dayLow: m.regularMarketDayLow,
        points,
        source: 'yahoo',
        exchange: m.exchangeName || market,
      };
    } catch (err) {
      if (err.rateLimited) yahooDownUntil = Date.now() + 15 * 60000;
      throw err;
    }
  }

  async function fetchQuote(market, symbol) {
    // BSE symbols (not codes) only resolve on Yahoo.
    const order = market === 'BSE' && !/^\d+$/.test(symbol) ? [fromYahoo] : [fromGoogle, fromYahoo];
    const errors = [];
    for (const fn of order) {
      try { return await fn(symbol, market); } catch (err) { errors.push(err); }
    }
    // "Not found" from any source beats "rate limited" from another.
    if (errors.some((e) => /not found/i.test(e.message))) throw new Error('symbol not found on ' + market);
    throw errors[errors.length - 1] || new Error('no data');
  }

  // Cached, single-flight quote lookup. maxAge lets alert checks reuse a
  // fresh-enough quote fetched for an open stocks view and vice versa.
  function quote(market, symbol, maxAge) {
    const key = market + ':' + symbol;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (maxAge || QUOTE_TTL_MS)) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchQuote(market, symbol)
      .then((q) => ({ at: Date.now(), quote: Object.assign({ key, symbol, market }, q) }))
      .catch((err) => ({ at: Date.now(), error: err.message, quote: hit && hit.quote ? Object.assign({}, hit.quote, { stale: true }) : null }))
      .then((res) => { cache.set(key, res); inflight.delete(key); return res; });
    inflight.set(key, p);
    return p;
  }

  async function quotes(keys, withPoints) {
    const out = {};
    // At most 4 lookups at a time.
    const list = keys.slice();
    const worker = async () => {
      while (list.length) {
        const key = list.shift();
        const [market, symbol] = key.split(':');
        const res = await quote(market, symbol);
        const q = res.quote ? Object.assign({}, res.quote) : null;
        if (q && !withPoints) delete q.points;
        out[key] = { quote: q, error: res.error || null, at: res.at };
      }
    };
    await Promise.all([1, 2, 3, 4].map(worker));
    return out;
  }

  const marketOpen = (q) => !!(q && q.openAt && q.closeAt && Date.now() >= q.openAt && Date.now() <= q.closeAt);

  app.get('/api/stocks/quotes', async (req, res) => {
    try {
      const keys = String(req.query.keys || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 100)
        .map((k) => { const [m, s] = k.split(':'); return (['NSE', 'BSE', 'US'].includes(m) ? m : 'NSE') + ':' + StocksCore.cleanSymbol(s); })
        .filter((k) => k.split(':')[1]);
      const data = await quotes([...new Set(keys)], req.query.points === '1');
      Object.values(data).forEach((d) => { if (d.quote) d.quote.open = marketOpen(d.quote); });
      res.json({ quotes: data, now: Date.now() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- alerts ----------
  const STATE_NAME = 'stock-alerts.json';
  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(STATE_NAME), 'utf8'));
      return { alerts: s.alerts && typeof s.alerts === 'object' ? s.alerts : {}, events: Array.isArray(s.events) ? s.events : [] };
    } catch (e) {
      return { alerts: {}, events: [] };
    }
  }
  function writeState(s) {
    s.events = s.events.slice(-300);
    try { writeJsonAtomic(stateFile(STATE_NAME), s); } catch (e) { console.error('stock alerts state:', e.message); }
  }

  // All stocks files in the workspace (mtime-cached parse).
  const parsed = new Map(); // full path -> { mtime, data }
  function stocksFiles() {
    const root = dataRoot();
    const out = [];
    (function walk(dir, depth) {
      if (depth > 12) return;
      for (const e of safeReaddir(dir)) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.html?$/i.test(e.name) || peekFileKind(full, e.name) !== 'stocks') continue;
        try {
          const mtime = fs.statSync(full).mtimeMs;
          let p = parsed.get(full);
          if (!p || p.mtime !== mtime) {
            p = { mtime, data: StocksCore.parseHtml(fs.readFileSync(full, 'utf8')) };
            parsed.set(full, p);
          }
          if (p.data) out.push({ rel: path.relative(root, full).split(path.sep).join('/'), data: p.data });
        } catch (err) { /* unreadable */ }
      }
    })(root, 0);
    return out;
  }

  function notifyNative(title, message) {
    if (process.platform !== 'darwin' || process.env.ACCRETION_NO_NATIVE_NOTIFY) return false;
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], () => {});
    return true;
  }

  const money = (n, cur) => (cur === 'INR' ? '₹' : cur === 'USD' ? '$' : '') + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

  let checking = false;
  let lastCheck = 0;
  let nextFullFetch = new Map(); // key -> time we may fetch again
  async function checkAlerts() {
    if (checking) return;
    checking = true;
    try {
      const files = stocksFiles();
      const watch = []; // { file, ticker, alert }
      files.forEach((f) => f.data.tickers.forEach((t) => t.alerts.forEach((a) => { if (a.enabled && a.value != null) watch.push({ file: f.rel, title: f.data.title, ticker: t, alert: a }); })));
      const state = readState();
      const liveIds = new Set(watch.map((w) => w.file + '#' + w.alert.id));
      Object.keys(state.alerts).forEach((k) => { if (!liveIds.has(k)) delete state.alerts[k]; });
      if (!watch.length) { writeState(state); return; }

      // Fetch each ticker at most once a minute while its market is open,
      // every 15 minutes while it's closed (prices don't move then).
      const keys = [...new Set(watch.map((w) => StocksCore.keyOf(w.ticker)))];
      const now = Date.now();
      const due = keys.filter((k) => !nextFullFetch.has(k) || now >= nextFullFetch.get(k));
      const got = {};
      await Promise.all(due.map(async (k) => {
        const [m, s] = k.split(':');
        const r = await quote(m, s, 55000);
        got[k] = r;
        nextFullFetch.set(k, now + (r.quote && !marketOpen(r.quote) && r.quote.closeAt ? 15 * 60000 : 60000));
      }));

      let changed = false;
      for (const w of watch) {
        const k = StocksCore.keyOf(w.ticker);
        const r = got[k] || cache.get(k);
        const q = r && r.quote;
        if (!q || q.stale) continue;
        const id = w.file + '#' + w.alert.id;
        const sig = [w.alert.type, w.alert.value, w.alert.mode].join('|');
        let st = state.alerts[id];
        if (!st || st.sig !== sig) { st = { sig, cond: null, firedAt: null }; state.alerts[id] = st; changed = true; }
        const cond = StocksCore.alertCondition(w.alert, q);
        if (cond == null) continue;
        let fire = false;
        if (w.alert.mode === 'once') fire = cond && !st.firedAt;
        else fire = cond && st.cond !== true && (!st.firedAt || now - st.firedAt > 10 * 60000);
        if (cond !== st.cond) { st.cond = cond; changed = true; }
        if (!fire) continue;
        st.firedAt = now;
        changed = true;
        const name = w.ticker.name || q.name || w.ticker.symbol;
        const what = StocksCore.describeAlert(w.alert, q.currency);
        const message = `${w.ticker.symbol} ${money(q.price, q.currency)} (${q.pct >= 0 ? '+' : ''}${q.pct.toFixed(2)}%) — ${what}${w.alert.note ? ' · ' + w.alert.note : ''}`;
        const ev = {
          id: 'e_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
          time: now,
          file: w.file,
          tickerId: w.ticker.id,
          alertId: w.alert.id,
          symbol: w.ticker.symbol,
          market: w.ticker.market,
          name,
          type: w.alert.type,
          value: w.alert.value,
          mode: w.alert.mode,
          price: q.price,
          pct: q.pct,
          currency: q.currency,
          note: w.alert.note,
          message,
          native: false,
        };
        ev.native = notifyNative('Accretion · ' + w.ticker.symbol + ' ' + what, message);
        state.events.push(ev);
        console.log('Stock alert: ' + message);
      }
      if (changed) writeState(state);
    } catch (err) {
      console.error('Stock alert check failed:', err.message);
    } finally {
      checking = false;
      lastCheck = Date.now();
    }
  }
  setInterval(checkAlerts, 30000).unref();
  setTimeout(checkAlerts, 5000).unref();

  app.get('/api/stocks/events', (req, res) => {
    const since = Number(req.query.since) || 0;
    const s = readState();
    res.json({ events: s.events.filter((e) => e.time > since), now: Date.now(), lastCheck });
  });

  // Alert state per file (fired / currently true), for the stocks view.
  app.get('/api/stocks/alert-state', (req, res) => {
    const file = String(req.query.path || '');
    const s = readState();
    const out = {};
    Object.entries(s.alerts).forEach(([k, v]) => { if (k.startsWith(file + '#')) out[k.slice(file.length + 1)] = v; });
    res.json({ alerts: out, events: s.events.filter((e) => e.file === file).slice(-50) });
  });

  // Re-arm a "once" alert so it can fire again.
  app.post('/api/stocks/rearm', (req, res) => {
    const { path: file, alertId } = req.body || {};
    const s = readState();
    const k = file + '#' + alertId;
    if (s.alerts[k]) { s.alerts[k].firedAt = null; s.alerts[k].cond = null; writeState(s); }
    res.json({ ok: true });
    setTimeout(checkAlerts, 200);
  });

  // Turn an alert off from a notification card (edits the stocks file).
  app.post('/api/stocks/disable-alert', (req, res) => {
    try {
      const { path: file, alertId } = req.body || {};
      const full = resolveSafe(String(file || ''));
      const data = StocksCore.parseHtml(fs.readFileSync(full, 'utf8'));
      if (!data) return res.status(400).json({ error: 'Not a stocks file' });
      let hit = false;
      data.tickers.forEach((t) => t.alerts.forEach((a) => { if (a.id === alertId) { a.enabled = false; hit = true; } }));
      if (!hit) return res.status(404).json({ error: 'Alert not found' });
      fs.writeFileSync(full, StocksCore.serializeToHtml(data));
      commitFile(file, 'Turn off stock alert');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Summary across every watchlist (for the Today screen).
  app.get('/api/stocks/overview', async (req, res) => {
    try {
      const files = stocksFiles();
      const seen = new Map();
      files.forEach((f) => f.data.tickers.forEach((t) => {
        const k = StocksCore.keyOf(t);
        if (!seen.has(k)) seen.set(k, { key: k, symbol: t.symbol, market: t.market, name: t.name, file: f.rel, alerts: 0 });
        seen.get(k).alerts += t.alerts.filter((a) => a.enabled).length;
      }));
      const keys = [...seen.keys()].slice(0, 60);
      const got = await quotes(keys, true);
      const list = keys.map((k) => {
        const q = got[k] && got[k].quote;
        return Object.assign({}, seen.get(k), q ? { price: q.price, change: q.change, pct: q.pct, currency: q.currency, name: seen.get(k).name || q.name, open: marketOpen(q), points: (q.points || []).filter((p, i, a) => i % Math.max(1, Math.floor(a.length / 40)) === 0), prevClose: q.prevClose } : { error: got[k] && got[k].error });
      });
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const events = readState().events.filter((e) => e.time >= dayStart.getTime());
      res.json({ files: files.map((f) => ({ path: f.rel, title: f.data.title, count: f.data.tickers.length })), tickers: list, events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check now (after the stocks view saves new alerts).
  app.post('/api/stocks/check', (req, res) => { res.json({ ok: true }); setTimeout(checkAlerts, 100); });

  return { checkAlerts, quote };
};
