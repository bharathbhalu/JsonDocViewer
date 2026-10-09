/* DocViewer terminal core — terminal file model (local or SSH tmux session). Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TerminalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);
  const uid = (p) => (p || 'x') + Math.random().toString(36).slice(2, 9);

  // tmux session names: no dots or colons (tmux target syntax).
  function cleanSession(s) {
    return String(s || '').trim().replace(/[.:]/g, '-').replace(/[^\w@+=-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }
  // SSH host: an alias from ~/.ssh/config or user@host; no spaces/shell chars.
  function cleanHost(s) {
    return String(s || '').trim().replace(/[^\w.@%:[\]-]/g, '').slice(0, 200);
  }

  function normalizeLayout(l) {
    if (!l || !Array.isArray(l.windows)) return null;
    const windows = l.windows.slice(0, 20).map((w) => ({
      name: str(w && w.name, 60),
      dir: str(w && w.dir, 500),
      panes: (Array.isArray(w && w.panes) ? w.panes : []).slice(0, 12).map((p) => ({
        dir: str(p && p.dir, 500),
        cmd: str(p && p.cmd, 1000),
        split: p && p.split === 'v' ? 'v' : 'h',
      })),
    }));
    return windows.length ? { windows } : null;
  }

  const MAX_OUTPUTS = 10;
  function normalizeOutputs(list, legacy) {
    const src = Array.isArray(list) ? list.slice() : [];
    if (!src.length && legacy && typeof legacy === 'object' && legacy.text) src.push({ name: '', at: legacy.at, text: legacy.text });
    return src.filter((o) => o && typeof o.text === 'string').map((o) => ({
      id: str(o.id, 40) || uid('o_'),
      name: str(o.name, 120),
      at: str(o.at, 40) || new Date().toISOString(),
      session: str(o.session, 80),
      text: str(o.text, 500000),
    })).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-MAX_OUTPUTS);
  }

  function normalize(data) {
    const s = data && typeof data === 'object' ? data : {};
    const mode = s.mode === 'ssh' ? 'ssh' : 'local';
    const out = {
      version: 1,
      title: str(s.title, 120) || 'Terminal',
      mode,
      // Claude-only: the session always runs Claude Code (locally or on the host).
      claude: !!s.claude,
      claudeResume: !!s.claudeResume,
      host: mode === 'ssh' ? cleanHost(s.host) : '',
      port: Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : null,
      jump: mode === 'ssh' ? cleanHost(s.jump) : '',
      session: cleanSession(s.session),
      dir: str(s.dir, 500),
      shell: str(s.shell, 120),
      startup: (Array.isArray(s.startup) ? s.startup : []).map((c) => str(c, 2000)).filter((c) => c.trim()).slice(0, 30),
      autoConnect: !!s.autoConnect,
      layout: normalizeLayout(s.layout),
      snippets: (Array.isArray(s.snippets) ? s.snippets : []).slice(0, 200).map((x) => ({
        id: str(x && x.id, 40) || uid('s_'),
        name: str(x && x.name, 120),
        cmd: str(x && x.cmd, 5000),
        enter: !(x && x.enter === false),
      })).filter((x) => x.cmd.trim()),
      notes: str(s.notes, 50000),
      // Saved pane outputs (newest last), at most MAX_OUTPUTS. The old single
      // "savedOutput" becomes the first one.
      outputs: normalizeOutputs(s.outputs, s.savedOutput),
      copyOnSelect: s.copyOnSelect !== false,
      fontSize: Number.isInteger(s.fontSize) && s.fontSize >= 9 && s.fontSize <= 28 ? s.fontSize : 13,
      sidebar: s.sidebar !== false,
      updatedAt: str(s.updatedAt, 40),
    };
    return out;
  }

  // What runs when the session is (re)created.
  function startupCommands(d) {
    if (d.claude) return [d.claudeResume ? 'claude --continue' : 'claude'];
    return d.startup.slice();
  }

  function describe(d) {
    const where = d.mode === 'ssh' ? (d.host || '(no host)') : 'this computer';
    return (d.claude ? 'Claude · ' : '') + 'tmux “' + (d.session || '?') + '” on ' + where;
  }

  function createStarter(kind) {
    const base = { title: 'Terminal', mode: 'local', session: 'main', dir: '', startup: [] };
    if (kind === 'ssh') Object.assign(base, { title: 'SSH terminal', mode: 'ssh', host: '', session: 'main' });
    if (kind === 'claude-local') Object.assign(base, { title: 'Claude', claude: true, session: 'claude' });
    if (kind === 'claude-remote') Object.assign(base, { title: 'Claude (remote)', mode: 'ssh', claude: true, session: 'claude' });
    return normalize(base);
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 120);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 2).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Terminal').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="terminal">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="terminal-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }
  function isTerminalHtml(html) { return typeof html === 'string' && /data-docviewer\s*=\s*["']terminal["']/.test(html); }
  function parseHtml(html) {
    if (!isTerminalHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']terminal-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  return { MAX_OUTPUTS, uid, cleanSession, cleanHost, normalize, normalizeLayout, startupCommands, describe, createStarter, serializeToHtml, isTerminalHtml, parseHtml };
});
