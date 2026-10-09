// Stock alerts in every open Accretion window. The server checks alerts
// (stocks-server.js); this polls its event log and shows a card with actions
// (open watchlist, re-arm, turn off). If the server couldn't raise a native
// macOS notification, a browser notification is shown too.
(function () {
  const SEEN_KEY = 'docviewer-stock-seen';
  let since = Date.now() - 5 * 60000; // pick up anything from the last few minutes
  try { const v = Number(localStorage.getItem(SEEN_KEY)); if (v) since = Math.max(since, v); } catch (e) { /* ignore */ }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function box() {
    let b = document.getElementById('reminder-toasts');
    if (!b) { b = document.createElement('div'); b.id = 'reminder-toasts'; document.body.appendChild(b); }
    return b;
  }
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = chime.ctx || (chime.ctx = new AC());
      [0, 0.12].forEach((delay, n) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = n ? 880 : 660;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.35);
      });
    } catch (e) { /* no audio */ }
  }
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function show(ev) {
    const up = ev.type === 'above' || ev.type === 'pctUp';
    const card = document.createElement('div');
    card.className = 'rem-toast stock-toast ' + (up ? 'up' : 'down');
    card.setAttribute('role', 'alert');
    const cur = ev.currency === 'INR' ? '₹' : ev.currency === 'USD' ? '$' : '';
    card.innerHTML = `
      <div class="rem-head"><span class="rem-icon">${up ? '📈' : '📉'}</span><span class="rem-when">Stock alert · ${esc(new Date(ev.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span><button type="button" class="rem-x" data-a="x" title="Dismiss">✕</button></div>
      <div class="rem-text"><b>${esc(ev.symbol)}</b> <span class="st-mk">${esc(ev.market)}</span> ${esc(cur + Number(ev.price).toLocaleString(undefined, { maximumFractionDigits: 2 }))}
        <span class="st-pct ${ev.pct >= 0 ? 'up' : 'down'}">${ev.pct >= 0 ? '+' : ''}${Number(ev.pct).toFixed(2)}%</span><br>
        <span class="st-sub">${esc(ev.name || '')}${ev.note ? ' · ' + esc(ev.note) : ''}</span><br>
        <span class="st-sub">${esc(ev.message.split(' — ').slice(1).join(' — '))}</span></div>
      <div class="rem-actions">
        <button type="button" class="rem-primary" data-a="open">Open watchlist</button>
        ${ev.mode === 'once' ? '<button type="button" data-a="rearm">Alert me again</button>' : ''}
        <button type="button" data-a="off">Turn alert off</button>
      </div>`;
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      card.remove();
      try {
        if (b.dataset.a === 'open') await openFile(ev.file);
        else if (b.dataset.a === 'rearm') { await post('/api/stocks/rearm', { path: ev.file, alertId: ev.alertId }); setStatus(ev.symbol + ' alert re-armed', 'ok'); }
        else if (b.dataset.a === 'off') {
          const r = await post('/api/stocks/disable-alert', { path: ev.file, alertId: ev.alertId });
          if (r.ok) {
            setStatus(ev.symbol + ' alert turned off', 'ok');
            // Reload the watchlist if it's open, so the file shows the change.
            if (typeof currentPath !== 'undefined' && currentPath === ev.file && typeof openFile === 'function' && !isDirty) openFile(ev.file);
          } else uiAlert('Could not turn the alert off.');
        }
      } catch (err) { /* ignore */ }
    });
    box().appendChild(card);
    if (!ev.native) {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification((up ? '📈 ' : '📉 ') + ev.symbol + ' ' + cur + Number(ev.price).toLocaleString(undefined, { maximumFractionDigits: 2 }), { body: ev.message, tag: 'stock-' + ev.id });
          n.onclick = () => { window.focus(); n.close(); openFile(ev.file); };
        }
      } catch (e) { /* unsupported */ }
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/stocks/events?since=' + since, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const fresh = (d.events || []).filter((e) => {
        // One window per event.
        const k = 'docviewer-stock-ev:' + e.id;
        try { if (localStorage.getItem(k)) return false; localStorage.setItem(k, '1'); } catch (err) { /* show anyway */ }
        return true;
      });
      (d.events || []).forEach((e) => { since = Math.max(since, e.time); });
      try { localStorage.setItem(SEEN_KEY, String(since)); } catch (e) { /* ignore */ }
      fresh.forEach(show);
      if (fresh.length) chime();
    } catch (e) { /* offline */ }
  }
  setInterval(poll, 15000);
  setTimeout(poll, 3000);
})();
