// Quit Accretion: save, stop the Node.js server, and close the window when the
// browser allows it (otherwise show a "stopped" screen). This computer only.
// Entry points: Settings → Quit, the palette ("Quit Accretion"), Cmd/Ctrl+Shift+Q.
(function () {
  const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  function stoppedScreen() {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg,#f3f5f8);color:var(--ink,#1c2330);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:440px;text-align:center">
          <img src="icon.svg" alt="" width="72" height="72" style="border-radius:18px;margin-bottom:12px;opacity:.85">
          <h1 style="margin:0 0 6px;font-size:22px">Accretion has stopped</h1>
          <p id="acc-stop-msg" style="margin:0 0 18px;color:var(--muted,#667085)">The server is no longer running. Start it again and this window reconnects by itself.</p>
          <button type="button" id="acc-start" style="font:inherit;font-weight:600;padding:10px 22px;border-radius:10px;border:0;background:#4f6ef7;color:#fff;cursor:pointer">Start Accretion</button>
          <p style="margin:18px 0 0;font-size:13px;color:var(--muted,#667085)">Or double-click <b>Accretion.app</b>, or run <code>./run.sh</code> in the app folder.</p>
        </div>
      </div>`;
    document.title = 'Accretion — stopped';
    const msg = document.getElementById('acc-stop-msg');
    const btn = document.getElementById('acc-start');
    let tries = 0;
    let started = false;
    let wasDown = false;
    // accretion://start is handled by Accretion.app (built by setup.sh --app);
    // it starts the server in the background.
    btn.addEventListener('click', () => {
      started = true;
      tries = 0;
      btn.disabled = true;
      btn.textContent = 'Starting…';
      msg.textContent = 'Starting Accretion — this window reconnects when it is ready.';
      location.href = 'accretion://start';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Start Accretion'; }, 8000);
    });
    // Reconnect as soon as the server answers (started here or elsewhere).
    (function poll() {
      fetch('/api/config', { cache: 'no-store' }).then((r) => {
        // Only after it has really gone down: right after Quit the old server
        // can still answer for a moment.
        if (r.status < 500 && wasDown) { location.reload(); return; }
        if (r.status < 500) { setTimeout(poll, 500); return; }
        throw new Error('down');
      }).catch(() => {
        wasDown = true;
        tries++;
        if (started && tries === 10) msg.textContent = 'Still waiting — is Accretion.app installed? You can also run ./run.sh in the app folder.';
        setTimeout(poll, 1500);
      });
    })();
  }

  async function quitApp() {
    if (!isLocal()) {
      uiAlert('Quit is only available on the computer running Accretion.', { title: 'Quit' });
      return;
    }
    const choice = await new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      ov.innerHTML = `<div class="md-dialog-box" role="dialog" aria-modal="true" aria-label="Quit Accretion" style="width:min(460px,100%)">
        <div class="md-dialog-head"><span>⏻ Quit Accretion</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <p style="margin:0 0 10px">This saves your work and stops the Accretion server. Every open Accretion window or tab stops working until you start it again.</p>
          <p class="md-note" style="margin:0 0 10px">Reminders, stock alerts and auto-connect checks pause while it's stopped. tmux sessions (and Claude in them) keep running on their own.</p>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;cursor:pointer"><input type="checkbox" data-kill style="margin-top:3px"> Also stop the tmux sessions of auto-connect terminals</label>
        </div>
        <div class="md-dialog-actions"><span class="md-spacer"></span><button type="button" data-cancel>Cancel</button><button type="button" class="md-primary" data-quit style="background:#e5484d;border-color:#e5484d">Quit</button></div>
      </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-x]').addEventListener('click', () => done(null));
      ov.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') done({ kill: ov.querySelector('[data-kill]').checked }); });
      ov.querySelector('[data-quit]').addEventListener('click', () => done({ kill: ov.querySelector('[data-kill]').checked }));
      ov.querySelector('[data-quit]').focus();
    });
    if (!choice) return;

    // Save the open file first.
    try {
      if (typeof isDirty !== 'undefined' && isDirty && typeof saveCurrentFile === 'function') {
        setStatus('Saving…');
        const ok = await saveCurrentFile();
        if (ok === false && !(await uiConfirm('The open file could not be saved. Quit anyway and lose those changes?', { title: 'Unsaved changes', okLabel: 'Quit anyway', danger: true }))) return;
      }
    } catch (e) { /* asked above */ }
    setStatus('Stopping Accretion…');
    // To-dos, habits and ideas save on short timers; let them finish.
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const r = await fetch('/api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ killSessions: !!choice.kill }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not stop the server'); }
    } catch (err) {
      uiAlert(String((err && err.message) || err), { title: 'Quit' });
      return;
    }
    // Stay on a "stopped" screen with a Start button (the window is kept open
    // so Accretion can be started again from here).
    setTimeout(stoppedScreen, 400);
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'q' || e.key === 'Q')) {
      e.preventDefault();
      e.stopPropagation();
      quitApp();
    }
  }, true);

  // Hard reload: save, drop the offline caches, and reload everything from
  // the server (scripts, styles, boards) — like ⌘⇧R, from inside the app.
  async function hardReload() {
    try {
      if (typeof isDirty !== 'undefined' && isDirty && typeof saveCurrentFile === 'function') {
        if (typeof setStatus === 'function') setStatus('Saving…');
        await saveCurrentFile();
      }
    } catch (e) { /* reload anyway */ }
    if (typeof setStatus === 'function') setStatus('Reloading…');
    try { if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k))); } catch (e) { /* none */ }
    try {
      if (navigator.serviceWorker) await Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => r.unregister()));
    } catch (e) { /* none */ }
    // A fresh URL makes the page itself skip any cached copy; the app's
    // scripts and styles are revalidated with the server on load.
    const u = new URL(location.href);
    u.searchParams.set('reload', Date.now().toString(36));
    location.replace(u.toString());
  }

  // Drop the ?reload= marker once the fresh page is up.
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('reload')) { u.searchParams.delete('reload'); history.replaceState(null, '', u.toString()); }
  } catch (e) { /* ignore */ }

  window.hardReload = hardReload;
  window.quitApp = quitApp;
})();
