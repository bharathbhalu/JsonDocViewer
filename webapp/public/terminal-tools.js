// Terminal helpers used across the app: "Open terminal here", "Open in
// Cursor", "Ask Claude about this file", and ▶ Run for shell code blocks in
// markdown. Uses app.js globals (openFile, loadTree, setStatus, …).
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
  const LAST_KEY = 'docviewer-last-terminal';
  const remember = (p) => { try { localStorage.setItem(LAST_KEY, p); } catch (e) { /* ignore */ } };
  const lastTerm = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } };

  async function terminalFiles() {
    const r = await fetch('/api/term/status', { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Terminals are not available');
    return d.files || [];
  }

  // Pick one terminal file (or offer to create one).
  function pick(list, title, emptyText, createLabel, onCreate) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      const last = lastTerm();
      list = list.slice().sort((a, b) => (b.path === last) - (a.path === last));
      ov.innerHTML = `<div class="md-dialog-box tt-pick" role="dialog" aria-modal="true">
        <div class="md-dialog-head"><span>${esc(title)}</span><button type="button" data-x aria-label="Close">×</button></div>
        <div class="md-dialog-body">${list.map((t, i) => `<button type="button" class="tt-item" data-i="${i}"><span class="tt-ic">${t.claude ? '✳' : '>_'}</span><span class="tt-t"><b>${esc(t.title)}</b><span>${t.mode === 'ssh' ? 'SSH · ' + esc(t.host || '?') : 'Local'} · tmux “${esc(t.session)}” · ${esc(t.path)}</span></span>${t.live ? '<span class="tt-live">open</span>' : ''}</button>`).join('') || `<p class="md-note">${esc(emptyText)}</p>`}</div>
        <div class="md-dialog-actions">${createLabel ? `<button type="button" data-create>${esc(createLabel)}</button>` : ''}<span class="md-spacer"></span><button type="button" data-x2>Cancel</button></div></div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-x]').addEventListener('click', () => done(null));
      ov.querySelector('[data-x2]').addEventListener('click', () => done(null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
      ov.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => done(list[Number(b.dataset.i)])));
      const c = ov.querySelector('[data-create]');
      if (c) c.addEventListener('click', async () => { ov.remove(); resolve(await onCreate()); });
      const first = ov.querySelector('[data-i]');
      if (first) first.focus();
    });
  }

  async function createFromTemplate(id, name) {
    let rel = `terminals/${name}.html`;
    for (let i = 2; i < 50; i++) {
      try {
        const r = await post('/api/templates/create', { id, path: rel });
        await loadTree();
        return { path: r.path, title: name, claude: /^claude/.test(id), mode: /remote|ssh/.test(id) ? 'ssh' : 'local', session: name };
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
        rel = `terminals/${name}-${i}.html`;
      }
    }
    throw new Error('Could not create a terminal file');
  }

  async function openTerminalHere(folder) {
    try {
      const r = await post('/api/term/quick', { folder: folder || '' });
      await loadTree();
      remember(r.path);
      await openFile(r.path);
    } catch (err) { uiAlert(err.message); }
  }

  async function openInCursor(p) {
    try { await post('/api/open-in-cursor', { path: p || '' }); setStatus('Opened in Cursor', 'ok'); } catch (err) { uiAlert(err.message, { title: 'Open in Cursor' }); }
  }

  // Send a file to a Claude terminal (local: its full path; remote: the file
  // itself is on this computer, so its text is pasted in when small).
  async function askClaudeAbout(p) {
    let list;
    try { list = (await terminalFiles()).filter((t) => t.claude); } catch (err) { uiAlert(err.message); return; }
    const t = list.length === 1 ? list[0] : await pick(list, 'Ask which Claude?', 'No Claude terminals yet.', '＋ New Claude (local)', () => createFromTemplate('claude-local', 'claude'));
    if (!t) return;
    const question = await uiPrompt('What should Claude do with ' + p.split('/').pop() + '?', 'Review this file and suggest improvements.', { title: 'Ask Claude · ' + t.title, okLabel: 'Send' });
    if (question == null) return;
    let text;
    if (t.mode === 'ssh') {
      let content = '';
      try { const r = await fetch('/api/file?path=' + encodeURIComponent(p), { cache: 'no-store' }); content = (await r.json()).content || ''; } catch (e) { /* path only */ }
      // Bracketed paste keeps a multi-line file as one message in Claude.
      text = content && content.length <= 30000
        ? `\x1b[200~${question}\n\nFile "${p}" (from my local workspace):\n\`\`\`\n${content}\n\`\`\`\x1b[201~`
        : `${question} (file "${p}" is on my local machine, not on this host)`;
    } else {
      let root = '';
      try { root = (await (await fetch('/api/term/info', { cache: 'no-store' })).json()).dataRoot || ''; } catch (e) { /* relative */ }
      text = `${question} File: ${root ? root.replace(/\/$/, '') + '/' : ''}${p}`;
    }
    try {
      remember(t.path);
      await openFile(t.path);
      // Give the pane a moment to attach so the text goes straight into it.
      await new Promise((r) => setTimeout(r, 1500));
      await post('/api/term/send', { path: t.path, text, enter: true });
      setStatus('Sent to ' + t.title, 'ok');
    } catch (err) { uiAlert(err.message); }
  }

  // ▶ Run on a shell code block in markdown.
  async function runInTerminal(code) {
    let list;
    try { list = (await terminalFiles()).filter((t) => !t.claude); } catch (err) { uiAlert(err.message); return; }
    const last = lastTerm();
    const t = list.find((x) => x.path === last && x.live) || await pick(list, 'Run in which terminal?', 'No terminals yet.', '＋ New local terminal', () => createFromTemplate('terminal-local', 'terminal'));
    if (!t) return;
    const cmd = String(code).replace(/^\$ /gm, '').trim();
    if (!(await uiConfirm('Run on “' + t.title + '” (' + (t.mode === 'ssh' ? t.host : 'this computer') + ')?\n\n' + cmd, { title: 'Run command', okLabel: 'Run' }))) return;
    try {
      remember(t.path);
      await post('/api/term/send', { path: t.path, text: cmd, enter: true });
      setStatus('Sent to ' + t.title + ' — open it to see the output', 'ok');
    } catch (err) { uiAlert(err.message); }
  }

  Object.assign(window, { openTerminalHere, openInCursor, askClaudeAbout, runInTerminal, listTerminals: terminalFiles, pickTerminal: pick });
})();
