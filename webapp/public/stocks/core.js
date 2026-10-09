/* DocViewer stocks core — watchlist model, alerts, serialize. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StocksCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Markets: NSE / BSE (India) and US (NASDAQ, NYSE, NYSE Arca… tried in turn).
  const MARKETS = [
    { id: 'NSE', label: 'NSE (India)', currency: 'INR', hint: 'e.g. RELIANCE, TCS, INFY' },
    { id: 'BSE', label: 'BSE (India)', currency: 'INR', hint: 'scrip code e.g. 500325, or symbol' },
    { id: 'US', label: 'US', currency: 'USD', hint: 'e.g. AAPL, MSFT, SPY' },
  ];
  const ALERT_TYPES = [
    { id: 'above', label: 'Price rises to or above', unit: 'price' },
    { id: 'below', label: 'Price falls to or below', unit: 'price' },
    { id: 'pctUp', label: 'Day change up by at least', unit: '%' },
    { id: 'pctDown', label: 'Day change down by at least', unit: '%' },
  ];
  const ALERT_MODES = [
    { id: 'once', label: 'Once' },
    { id: 'repeat', label: 'Every time it crosses' },
  ];
  const REFRESH_CHOICES = [15, 30, 60, 120, 300];

  const uid = (p) => (p || 'x') + Math.random().toString(36).slice(2, 9);
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 200);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  function cleanSymbol(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9.&_-]/g, '').slice(0, 24);
  }

  function normalizeAlert(a) {
    const src = a && typeof a === 'object' ? a : {};
    const type = ALERT_TYPES.some((t) => t.id === src.type) ? src.type : 'above';
    return {
      id: str(src.id, 40) || uid('a_'),
      type,
      value: num(src.value),
      mode: src.mode === 'repeat' ? 'repeat' : 'once',
      enabled: src.enabled !== false,
      note: str(src.note, 300),
    };
  }

  function normalizeTicker(t) {
    const src = t && typeof t === 'object' ? t : {};
    const market = MARKETS.some((m) => m.id === src.market) ? src.market : 'NSE';
    return {
      id: str(src.id, 40) || uid('t_'),
      symbol: cleanSymbol(src.symbol),
      market,
      name: str(src.name, 160),
      note: str(src.note, 1000),
      qty: num(src.qty),
      cost: num(src.cost),
      alerts: (Array.isArray(src.alerts) ? src.alerts : []).map(normalizeAlert).filter((x) => x.value != null).slice(0, 50),
    };
  }

  function normalize(data) {
    const src = data && typeof data === 'object' ? data : {};
    const tickers = (Array.isArray(src.tickers) ? src.tickers : []).map(normalizeTicker).filter((t) => t.symbol).slice(0, 200);
    const refreshSec = REFRESH_CHOICES.includes(Number(src.refreshSec)) ? Number(src.refreshSec) : 60;
    return { version: 1, title: str(src.title, 120) || 'Watchlist', refreshSec, tickers, updatedAt: str(src.updatedAt, 40) };
  }

  function createEmpty() { return normalize({}); }

  function createStarter() {
    return normalize({
      title: 'Watchlist',
      tickers: [
        { symbol: 'RELIANCE', market: 'NSE', name: 'Reliance Industries' },
        { symbol: 'TCS', market: 'NSE', name: 'Tata Consultancy Services' },
        { symbol: 'AAPL', market: 'US', name: 'Apple Inc' },
        { symbol: 'MSFT', market: 'US', name: 'Microsoft' },
      ],
    });
  }

  const keyOf = (t) => t.market + ':' + t.symbol;

  // Is the alert's condition true for this quote?
  function alertCondition(alert, quote) {
    if (!quote || alert.value == null) return null;
    const v = Number(alert.value);
    if (alert.type === 'above') return quote.price != null ? quote.price >= v : null;
    if (alert.type === 'below') return quote.price != null ? quote.price <= v : null;
    if (alert.type === 'pctUp') return quote.pct != null ? quote.pct >= Math.abs(v) : null;
    if (alert.type === 'pctDown') return quote.pct != null ? quote.pct <= -Math.abs(v) : null;
    return null;
  }

  function describeAlert(alert, currency) {
    const v = Number(alert.value);
    const money = (n) => (currency === 'INR' ? '₹' : currency === 'USD' ? '$' : '') + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (alert.type === 'above') return '≥ ' + money(v);
    if (alert.type === 'below') return '≤ ' + money(v);
    if (alert.type === 'pctUp') return 'up ≥ ' + Math.abs(v) + '% today';
    if (alert.type === 'pctDown') return 'down ≥ ' + Math.abs(v) + '% today';
    return '';
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 120);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 2).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Watchlist').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="stocks">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="stocks-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isStocksHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']stocks["']/.test(html);
  }

  function parseHtml(html) {
    if (!isStocksHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']stocks-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return createEmpty();
    try { return normalize(JSON.parse(m[1])); } catch (e) { return createEmpty(); }
  }

  return {
    MARKETS,
    ALERT_TYPES,
    ALERT_MODES,
    REFRESH_CHOICES,
    uid,
    cleanSymbol,
    normalize,
    normalizeTicker,
    normalizeAlert,
    createEmpty,
    createStarter,
    keyOf,
    alertCondition,
    describeAlert,
    serializeToHtml,
    isStocksHtml,
    parseHtml,
  };
});
