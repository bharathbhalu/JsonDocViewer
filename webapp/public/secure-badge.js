// Connection badge next to the app title: 🔒 Secure (https), Local (http on
// this computer — traffic never leaves it) or ⚠ Not secure (http from another
// device). Click for details and, when HTTPS mode is available, a switch.
(function () {
  const brand = document.querySelector('#sidebar-header .sidebar-brand');
  if (!brand) return;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const secure = location.protocol === 'https:';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const state = secure ? 'secure' : local ? 'local' : 'insecure';
  const LABEL = { secure: '🔒 Secure', local: 'Local', insecure: '⚠ Not secure' };
  const TITLE = {
    secure: 'Encrypted HTTPS connection',
    local: 'HTTP on this computer — the connection never leaves this Mac',
    insecure: 'Plain HTTP over the network — not encrypted',
  };

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.id = 'conn-badge';
  badge.className = 'conn-badge ' + state;
  badge.textContent = LABEL[state];
  badge.title = TITLE[state] + ' — click for details';
  const title = brand.querySelector('.sidebar-title');
  (title || brand).insertAdjacentElement('afterend', badge);
  if (state !== 'local' && !/^[🔒⚠]/.test(document.title)) document.title = (secure ? '🔒 ' : '⚠ ') + document.title;

  let https = null; // /api/https (this computer only)
  async function loadHttps() {
    if (!local && !secure) return null;
    try { const r = await fetch('/api/https', { cache: 'no-store' }); if (r.ok) https = await r.json(); } catch (e) { /* not available */ }
    // HTTPS mode on and trusted here, but this window is on http → nudge.
    badge.classList.toggle('nudge', !!(https && https.running && https.trustedHere === true && !secure));
    badge.title = TITLE[state] + (badge.classList.contains('nudge') ? ' — HTTPS is available: click to switch' : ' — click for details');
    return https;
  }

  function secureUrl() {
    const host = location.hostname === '127.0.0.1' ? 'localhost' : location.hostname;
    return 'https://' + host + (location.port ? ':' + location.port : '') + location.pathname + location.search + location.hash;
  }

  async function open() {
    await loadHttps();
    const h = https;
    const rows = [
      ['Connection', secure ? 'HTTPS (TLS) — encrypted' : 'HTTP — not encrypted'],
      ['Address', location.protocol + '//' + location.host],
      ['From', local ? 'this computer' : 'another device on the network'],
      ['HTTPS mode', h ? (h.running ? 'on' : 'off') + (h.running && h.httpsOnly ? ' · other devices must use https' : '') : (secure ? 'on' : 'unknown from this device')],
    ];
    if (h && h.running) rows.push(['Certificate', h.trustedHere === true ? 'trusted on this Mac' : h.trustedHere === false ? 'not trusted on this Mac yet' : 'installed per device']);
    const canSwitch = !secure && (h ? h.running : true);
    const ov = document.createElement('div');
    ov.className = 'topo-overlay';
    ov.innerHTML = `<div class="md-dialog-box conn-box" role="dialog" aria-modal="true" aria-label="Connection">
      <div class="md-dialog-head"><span class="conn-head ${state}">${esc(LABEL[state])}</span><button type="button" data-x aria-label="Close">×</button></div>
      <div class="md-dialog-body">
        <p class="conn-lead">${state === 'secure' ? 'This connection is encrypted. Pages, files, terminal keystrokes and your password are protected on the network.'
          : state === 'local' ? 'You are using Accretion on this computer over http. The traffic stays inside this Mac, so it is not exposed on the network.'
            : 'This connection is <b>not encrypted</b>. Anyone on the same network could read what you open or type, including your password.'}</p>
        <table class="conn-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
        ${h && h.running && h.trustedHere === false && !secure ? '<p class="md-note">To open securely here without a browser warning, first click <b>Trust on this Mac…</b> in ⚙ Settings → HTTPS.</p>' : ''}
        ${!secure && h && !h.running ? '<p class="md-note">Turn on <b>HTTPS mode</b> in ⚙ Settings to encrypt connections.</p>' : ''}
      </div>
      <div class="md-dialog-actions">
        ${local ? '<button type="button" data-settings>⚙ HTTPS settings</button>' : ''}
        <span class="md-spacer"></span>
        ${canSwitch ? `<button type="button" class="md-primary" data-switch>🔒 Switch to HTTPS</button>` : ''}
        <button type="button" data-x2>Close</button>
      </div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.querySelector('[data-x2]').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    const sw = ov.querySelector('[data-switch]');
    if (sw) sw.addEventListener('click', async () => {
      if (typeof isDirty !== 'undefined' && isDirty && typeof saveCurrentFile === 'function') await saveCurrentFile();
      location.href = secureUrl();
    });
    const st = ov.querySelector('[data-settings]');
    if (st) st.addEventListener('click', () => { close(); if (window.openDataFolder) openDataFolder(); });
  }

  badge.addEventListener('click', open);
  loadHttps();
  setInterval(loadHttps, 60000);
})();
