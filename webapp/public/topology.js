// "Build network topology…": pick NVUE cache JSON files (a folder, or one
// file), choose how servers are shown, and write a flow board.
// Uses app.js globals and TopologyCore (topology-core.js).
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function jsonFilesUnder(p) {
    const out = [];
    const walk = (nodes) => (nodes || []).forEach((n) => {
      if (n.type === 'dir') walk(n.children);
      else if (/\.json$/i.test(n.path)) out.push(n.path);
    });
    if (/\.json$/i.test(p)) return [p];
    const find = (nodes) => {
      for (const n of nodes || []) {
        if (n.path === p) return n;
        if (n.type === 'dir' && p.startsWith(n.path + '/')) { const hit = find(n.children); if (hit) return hit; }
      }
      return null;
    };
    const node = p ? find(lastTreeChildren) : { children: lastTreeChildren };
    if (node) walk(node.children);
    // NVUE caches first; other JSON files are checked too (by content).
    return out.sort((a, b) => (/nvue-cache/i.test(b) - /nvue-cache/i.test(a)) || a.localeCompare(b));
  }

  async function loadDocs(paths, onStep) {
    const docs = [];
    const used = [];
    for (let i = 0; i < paths.length && i < 200; i++) {
      onStep && onStep(i, paths.length, paths[i]);
      try {
        const res = await fetch('/api/file?path=' + encodeURIComponent(paths[i]), { cache: 'no-store' });
        if (!res.ok) continue;
        const d = JSON.parse((await res.json()).content || 'null');
        if (window.TopologyCore.isNvueCache(d)) { docs.push(d); used.push(paths[i]); }
      } catch (e) { /* not JSON / not NVUE */ }
    }
    return { docs, used };
  }

  function dialog(src, defaultOut) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'topo-overlay';
      ov.innerHTML = `
        <div class="md-dialog-box" role="dialog" aria-modal="true" aria-label="Build network topology">
          <div class="md-dialog-head"><span>Build network topology</span><button type="button" data-x aria-label="Close">×</button></div>
          <div class="md-dialog-body">
            <p class="md-note" style="padding:0 0 8px">From the NVUE cache files in <b>${esc(src || 'the workspace')}</b> (*-vxpd-nvue-cache.json): switches, servers and the links between them.</p>
            <div class="md-form">
              <label>Servers
                <select data-servers>
                  <option value="auto">Automatic (grouped when there are many)</option>
                  <option value="grouped">Grouped by the switches they connect to</option>
                  <option value="individual">One box per server</option>
                  <option value="hidden">Hide servers (switch fabric only)</option>
                </select>
              </label>
              <label>Save as <input type="text" data-out></label>
            </div>
            <div class="md-note" data-status></div>
          </div>
          <div class="md-dialog-actions"><span class="md-spacer"></span><button type="button" data-cancel>Cancel</button><button type="button" class="md-primary" data-go>Build</button></div>
        </div>`;
      document.body.appendChild(ov);
      const out = ov.querySelector('[data-out]');
      out.value = defaultOut;
      const close = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-x]').addEventListener('click', () => close(null));
      ov.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      ov.querySelector('[data-go]').addEventListener('click', () => {
        let path = out.value.trim();
        if (!path) { out.focus(); return; }
        if (!/\.html?$/i.test(path)) path += '.html';
        close({ servers: ov.querySelector('[data-servers]').value, out: path });
      });
      out.focus();
      out.select();
    });
  }

  async function buildTopology(srcPath) {
    const files = jsonFilesUnder(srcPath || '');
    if (!files.length) { alert('No JSON files found here.'); return; }
    const dir = srcPath && !/\.json$/i.test(srcPath) ? srcPath : (srcPath || '').split('/').slice(0, -1).join('/');
    const defaultOut = (dir ? dir + '/' : '') + 'topology.html';
    const choice = await dialog(srcPath, defaultOut);
    if (!choice) return;
    setStatus('Reading NVUE files…');
    const { docs, used } = await loadDocs(files, (i, n) => setStatus(`Reading NVUE files… ${i + 1}/${n}`));
    if (!docs.length) {
      setStatus('No NVUE cache files found', 'dirty');
      alert('None of the JSON files here are NVUE caches (they need "sw" and "ports" sections).');
      return;
    }
    await ensureFlowAssets();
    let result;
    try {
      result = window.TopologyCore.build(docs, window.FlowCore, { servers: choice.servers });
    } catch (err) {
      alert('Could not build the topology: ' + ((err && err.message) || err));
      return;
    }
    const inTree = (nodes, p) => (nodes || []).some((n) => n.path === p || (n.type === 'dir' && p.startsWith(n.path + '/') && inTree(n.children, p)));
    const exists = inTree(lastTreeChildren, choice.out);
    if (exists && !(await uiConfirm(choice.out + ' already exists. Replace it?', { title: 'Replace file', okLabel: 'Replace', danger: true }))) return;
    const title = 'Topology — ' + (srcPath || 'workspace');
    const html = window.FlowCore.serializeToHtml(result.data, title);
    const { res, data } = await postFileContent(choice.out, html);
    if (!res.ok) { alert('Could not save: ' + ((data && data.error) || res.status)); return; }
    await loadTree();
    await openFile(choice.out, undefined, { force: true, skipDirty: false });
    const s = result.stats;
    setStatus(`Topology: ${s.switches} switches, ${s.servers} servers (${s.serverMode}), ${s.links} connections from ${used.length} file${used.length === 1 ? '' : 's'}`, 'ok');
  }

  window.buildTopology = buildTopology;
})();
