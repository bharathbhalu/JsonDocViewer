// Data folder: shows where the workspace lives and switches it to any folder
// on disk. The choice is remembered by the server (~/.accretion/config.json).
// Files, their git history and the workspace's state (<data>/.accretion/)
// all live in that folder; the app folder holds only code.
(function () {
  const btn = document.getElementById('data-folder-btn');
  const kicker = document.querySelector('#sidebar-header .sidebar-kicker');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let info = null;
  // Chrome/Edge offer to install the app (own Dock icon) via this event.
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; setStatus('Installed — Accretion now has its own Dock icon', 'ok'); });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches;

  async function load() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) info = await r.json();
    } catch (e) { /* offline */ }
    if (info && kicker) {
      kicker.textContent = info.dataDir.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
      kicker.title = 'Data folder: ' + info.dataDir;
    }
    return info;
  }

  async function switchTo(p, create) {
    const r = await fetch('/api/config/data-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, create: !!create }) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 404 && data.missing) {
      if (await uiConfirm(`${p}\n\ndoesn't exist. Create it and use it as the data folder?`, { title: 'Create folder', okLabel: 'Create' })) return switchTo(p, true);
      return false;
    }
    if (!r.ok) { await uiAlert(data.error || 'Could not switch the data folder', { title: 'Data folder' }); return false; }
    // Everything (tree, bookmarks, to-dos, habits, ideas…) belongs to the
    // folder, so start fresh.
    try { localStorage.removeItem('docviewer-last-file'); } catch (e) { /* ignore */ }
    location.reload();
    return true;
  }

  async function open() {
    await load();
    if (!info) { uiAlert('Could not read the data folder settings.'); return; }
    const locked = info.source === 'env';
    const ov = document.createElement('div');
    ov.className = 'topo-overlay';
    ov.innerHTML = `
      <div class="md-dialog-box df-box" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="md-dialog-head"><span>⚙ Settings</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">
          <p class="df-label">Data folder</p>
          <div class="df-current"><code>${esc(info.dataDir)}</code><button type="button" data-copy title="Copy path">Copy</button></div>
          <p class="md-note">Your files, their version history (git), bookmarks, tags, to-dos, habits, standups and ideas all live in this folder${info.gitEnabled ? '' : ' · <b>git history is unavailable here</b>'}. The app's own folder holds only code.
            ${info.source === 'env' ? '<br><b>Set by the DATA_DIR environment variable</b> — unset it to choose here.' : info.source === 'default' ? '<br>Using the default folder next to the app.' : ''}</p>
          <p class="df-label">Opens as</p>
          <div class="df-open">
            <label><input type="radio" name="df-open" value="window"${info.openAs === 'window' ? ' checked' : ''}${info.windowAvailable ? '' : ' disabled'}> Its own window</label>
            <label><input type="radio" name="df-open" value="browser"${info.openAs !== 'window' ? ' checked' : ''}> A browser tab</label>
            <span class="md-spacer"></span>
            <button type="button" data-open="window"${info.windowAvailable ? '' : ' disabled'}>⧉ Open window now</button>
            <button type="button" data-open="browser">↗ Open in browser</button>
          </div>
          <div class="df-install">
            <img src="icon.svg" alt="" width="40" height="40">
            <div>
              ${info.installedApp ? `<b>Installed with its own Dock icon.</b><br><span class="md-note">The window opens as <code>${esc(info.installedApp.split('/').pop())}</code>.</span>`
                : `<b>Dock icon</b><br><span class="md-note">Install Accretion as an app so its window shows this logo in the Dock and app switcher.</span>`}
            </div>
            ${info.installedApp ? '' : '<button type="button" data-install>Install…</button>'}
          </div>
          <p class="md-note">${info.windowAvailable ? 'Used when you start the app (<code>./run.sh</code>). <code>--window</code> or <code>--browser</code> overrides it once.' : 'A separate window needs Google Chrome, Microsoft Edge or Brave.'}</p>
          <p class="df-label">Switch to</p>
          <div class="df-row"><input type="text" class="df-input" placeholder="/Users/you/Ideas or ~/Ideas" spellcheck="false"${locked ? ' disabled' : ''}><button type="button" data-browse${locked ? ' disabled' : ''}>📂 Browse…</button><button type="button" class="md-primary" data-go${locked ? ' disabled' : ''}>Switch</button></div>
          <p class="md-note">Any folder on this computer. Existing files there show up as-is; a git history is started if the folder doesn't have one.</p>
          ${info.recent.length || info.dataDir !== info.defaultDir ? `<p class="df-label">Recent</p><div class="df-recent">${[...info.recent, ...(info.recent.includes(info.defaultDir) || info.dataDir === info.defaultDir ? [] : [info.defaultDir])].map((r) => `<button type="button" data-p="${esc(r)}"${locked ? ' disabled' : ''}>📁 ${esc(r)}${r === info.defaultDir ? ' <em>default</em>' : ''}</button>`).join('')}</div>` : ''}
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    ov.querySelector('[data-copy]').addEventListener('click', () => { navigator.clipboard.writeText(info.dataDir).then(() => setStatus('Path copied', 'ok'), () => {}); });
    ov.querySelectorAll('input[name="df-open"]').forEach((r) => r.addEventListener('change', async () => {
      const res = await fetch('/api/config/open-as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openAs: r.value }) });
      if (res.ok) setStatus('Opens as ' + (r.value === 'window' ? 'a window' : 'a browser tab') + ' from now on', 'ok');
      else uiAlert('Could not save that setting.');
    }));
    const inst = ov.querySelector('[data-install]');
    if (inst) inst.addEventListener('click', async () => {
      if (installEvent) {
        // Chrome/Edge show their own install confirmation here — it's the
        // browser installing the app, so it can't be an in-page popup.
        installEvent.prompt();
        const choice = await installEvent.userChoice.catch(() => null);
        installEvent = null;
        if (choice && choice.outcome === 'accepted') { close(); setTimeout(() => fetch('/api/config/open-as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openAs: 'window' }) }), 0); }
        return;
      }
      uiAlert(isStandalone()
        ? 'This window is already running as an installed app.'
        : 'To install with a Dock icon:\n\n• Chrome or Edge: open the ⋮ menu → "Cast, save and share" → "Install page as app…" (or the install icon at the right of the address bar).\n• Safari: File → "Add to Dock…".\n\nAfter that, the Accretion launcher and "Open window now" open the installed app.', { title: 'Install Accretion' });
    });
    ov.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      const res = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as: b.dataset.open }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) uiAlert(d.error || 'Could not open it.');
    }));
    const input = ov.querySelector('.df-input');
    const go = async (p) => {
      if (!p) { input.focus(); return; }
      if (!(await uiConfirm(`Switch the data folder to\n${p}?\n\nThe page reloads with that folder's files.`, { title: 'Switch data folder', okLabel: 'Switch' }))) return;
      await switchTo(p);
    };
    ov.querySelector('[data-go]').addEventListener('click', () => go(input.value.trim()));
    ov.querySelector('[data-browse]').addEventListener('click', async () => {
      const picked = await browse(input.value.trim() || info.dataDir.replace(/[\\/][^\\/]*$/, ''));
      if (picked) { input.value = picked; go(picked); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value.trim()); } });
    ov.querySelectorAll('.df-recent [data-p]').forEach((b) => b.addEventListener('click', () => go(b.dataset.p)));
    if (!locked) input.focus();
  }

  // ---------- folder browser ----------
  // Resolves with the chosen absolute path, or null.
  function browse(start) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'topo-overlay fb-ov';
      ov.innerHTML = `
        <div class="md-dialog-box fb-box" role="dialog" aria-modal="true" aria-label="Choose a folder">
          <div class="md-dialog-head"><span>📂 Choose a data folder</span><button type="button" data-x aria-label="Close">×</button></div>
          <div class="fb-main">
            <nav class="fb-places"></nav>
            <div class="fb-right">
              <div class="fb-bar"><button type="button" data-up title="Parent folder">↑</button><div class="fb-crumbs"></div></div>
              <input type="text" class="fb-path" spellcheck="false" aria-label="Path" title="Type a path and press Enter">
              <div class="fb-list" tabindex="0"></div>
              <div class="fb-status"></div>
            </div>
          </div>
          <div class="md-dialog-actions">
            <label class="fb-hidden"><input type="checkbox"> Show hidden</label>
            <button type="button" data-mk>＋ New folder</button>
            <span class="md-spacer"></span>
            <button type="button" data-cancel>Cancel</button>
            <button type="button" class="md-primary" data-use>Use this folder</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const list = ov.querySelector('.fb-list');
      const pathIn = ov.querySelector('.fb-path');
      const status = ov.querySelector('.fb-status');
      const useBtn = ov.querySelector('[data-use]');
      let cur = null;
      let sel = -1;
      const done = (v) => { ov.remove(); resolve(v); };

      async function go(p) {
        const hidden = ov.querySelector('.fb-hidden input').checked ? '&hidden=1' : '';
        const r = await fetch('/api/fs/list?path=' + encodeURIComponent(p || '') + hidden, { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { status.textContent = d.error || 'Cannot open that folder'; status.classList.add('err'); return; }
        cur = d;
        sel = -1;
        status.classList.remove('err');
        pathIn.value = d.path;
        ov.querySelector('[data-up]').disabled = !d.parent;
        // Breadcrumbs
        const parts = d.path.split(d.sep).filter(Boolean);
        const root = d.path.startsWith(d.sep) ? d.sep : parts.shift() + d.sep;
        let acc = root;
        const crumbs = [{ name: root === '/' ? '/' : root, path: root }].concat(parts.map((n) => { acc = acc.endsWith(d.sep) ? acc + n : acc + d.sep + n; return { name: n, path: acc }; }));
        ov.querySelector('.fb-crumbs').innerHTML = crumbs.map((c, i) => `<button type="button" data-p="${esc(c.path)}"${i === crumbs.length - 1 ? ' class="on"' : ''}>${esc(c.name)}</button>`).join('<span>›</span>');
        ov.querySelectorAll('.fb-crumbs [data-p]').forEach((b) => b.addEventListener('click', () => go(b.dataset.p)));
        ov.querySelector('.fb-crumbs').scrollLeft = 1e6;
        ov.querySelector('.fb-places').innerHTML = d.places.map((pl) => `<button type="button" data-p="${esc(pl.path)}" class="${d.path === pl.path ? 'on' : ''}">${esc(pl.name)}</button>`).join('')
          + (info && info.recent && info.recent.length ? '<div class="fb-sub">Recent</div>' + info.recent.map((r) => `<button type="button" data-p="${esc(r)}" title="${esc(r)}">${esc(r.split(/[\\/]/).pop())}</button>`).join('') : '');
        ov.querySelectorAll('.fb-places [data-p]').forEach((b) => b.addEventListener('click', () => go(b.dataset.p)));
        list.innerHTML = d.dirs.length ? d.dirs.map((x, i) => `<div class="fb-item" data-i="${i}" title="${esc(x.path)}"><span class="fb-ic">📁</span><span class="fb-name">${esc(x.name)}</span>${x.isWorkspace ? '<span class="fb-badge ws">workspace</span>' : ''}${x.isGit ? '<span class="fb-badge">git</span>' : ''}<span class="fb-go">›</span></div>`).join('')
          : '<div class="fb-empty">No sub-folders</div>';
        list.scrollTop = 0;
        const notes = [];
        if (d.isAppFolder) notes.push('This is inside the app folder — choose another folder.');
        else if (!d.writable) notes.push('Read-only folder — choose another folder.');
        else if (d.isWorkspace) notes.push('This folder is already a workspace.');
        else if (d.isGit) notes.push('Has a git history — new versions are added to it.');
        status.textContent = notes.join(' ');
        useBtn.disabled = d.isAppFolder || !d.writable;
        useBtn.textContent = 'Use “' + (parts[parts.length - 1] || root) + '”';
      }
      const items = () => [...list.querySelectorAll('.fb-item')];
      const mark = (i) => {
        const all = items();
        if (!all.length) return;
        sel = Math.max(0, Math.min(all.length - 1, i));
        all.forEach((el, n) => el.classList.toggle('sel', n === sel));
        all[sel].scrollIntoView({ block: 'nearest' });
      };
      list.addEventListener('click', (e) => { const it = e.target.closest('.fb-item'); if (it) mark(Number(it.dataset.i)); });
      list.addEventListener('dblclick', (e) => { const it = e.target.closest('.fb-item'); if (it) go(cur.dirs[Number(it.dataset.i)].path); });
      list.addEventListener('click', (e) => { if (e.target.closest('.fb-go')) go(cur.dirs[Number(e.target.closest('.fb-item').dataset.i)].path); });
      list.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); mark(sel + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); mark(sel - 1); }
        else if ((e.key === 'Enter' || e.key === 'ArrowRight') && sel >= 0) { e.preventDefault(); go(cur.dirs[sel].path); }
        else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && cur.parent) { e.preventDefault(); go(cur.parent); }
        else if (/^[\w.-]$/.test(e.key)) {
          const k = e.key.toLowerCase();
          const i = cur.dirs.findIndex((x, n) => n > sel && x.name.toLowerCase().startsWith(k));
          const j = i >= 0 ? i : cur.dirs.findIndex((x) => x.name.toLowerCase().startsWith(k));
          if (j >= 0) mark(j);
        }
      });
      pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(pathIn.value.trim()); } });
      ov.querySelector('[data-up]').addEventListener('click', () => cur && cur.parent && go(cur.parent));
      ov.querySelector('.fb-hidden input').addEventListener('change', () => go(cur ? cur.path : start));
      ov.querySelector('[data-mk]').addEventListener('click', async () => {
        if (!cur) return;
        const name = await uiPrompt('Name of the new folder in\n' + cur.path, '', { title: 'New folder', okLabel: 'Create' });
        if (!name || !name.trim()) return;
        const r = await fetch('/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: cur.path, name: name.trim() }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { uiAlert(d.error || 'Could not create the folder'); return; }
        go(d.path);
      });
      // "Use" takes the highlighted sub-folder if one is selected.
      useBtn.addEventListener('click', () => { if (cur) done(sel >= 0 && cur.dirs[sel] ? cur.dirs[sel].path : cur.path); });
      list.addEventListener('click', () => {
        if (sel >= 0 && cur.dirs[sel]) useBtn.textContent = 'Use “' + cur.dirs[sel].name + '”';
      });
      ov.querySelector('[data-x]').addEventListener('click', () => done(null));
      ov.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      go(start).then(() => { if (!cur) go(''); list.focus(); });
    });
  }

  if (btn) btn.addEventListener('click', open);
  window.openDataFolder = open;
  load();
})();
