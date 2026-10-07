// Export a folder (or the whole workspace) as
//  - a linked static website (.zip): markdown -> HTML pages, boards ->
//    self-contained pages, other files copied, plus an index page; or
//  - a single PDF: one printable document (cover, contents, every file),
//    saved through the browser's print dialog ("Save as PDF").
// Uses app.js globals (lastTreeChildren, BOARD_TYPES, markdown helpers ...).
(function () {
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const TEXT_EXT = /\.(json|ya?ml|txt|csv|log|xml|ini|conf|cfg|toml|sh|bash|zsh|py|js|ts|go|rs|java|c|h|cpp|hpp|sql|css|env|properties|gradle|mk|makefile|dockerfile)$/i;
  const KIND_LABEL = { mindmap: 'Mindmap', flow: 'Flow', kanban: 'Kanban', gantt: 'Gantt', slides: 'Slides', markdown: 'Markdown', pdf: 'PDF' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- files ----------
  function findNode(nodes, p) {
    for (const n of nodes || []) {
      if (n.path === p) return n;
      if (n.type === 'dir' && p.startsWith(n.path + '/')) {
        const hit = findNode(n.children, p);
        if (hit) return hit;
      }
    }
    return null;
  }
  function filesIn(folder) {
    const out = [];
    const walk = (nodes) => (nodes || []).forEach((n) => (n.type === 'dir' ? walk(n.children) : out.push(n)));
    if (!folder) walk(lastTreeChildren);
    else {
      const node = findNode(lastTreeChildren, folder);
      if (node && node.type === 'dir') walk(node.children);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  function kindOf(f) {
    if (BOARD_TYPES[f.kind]) return f.kind;
    if (isMarkdownPath(f.path)) return 'markdown';
    if (/\.pdf$/i.test(f.path)) return 'pdf';
    if (IMAGE_EXT.test(f.path)) return 'image';
    if (/\.html?$/i.test(f.path)) return 'html';
    if (TEXT_EXT.test(f.path) || /(^|\/)(makefile|dockerfile|readme)$/i.test(f.path)) return 'text';
    return 'other';
  }
  async function readFile(p) {
    const res = await fetch('/api/file?path=' + encodeURIComponent(p), { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read ' + p);
    return data.content || '';
  }
  async function toDataUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load ' + url);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  // Relative URL from one site page to another site path.
  function relUrl(fromPage, to) {
    const from = fromPage.split('/').slice(0, -1);
    const parts = to.split('/');
    let i = 0;
    while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i++;
    return from.slice(i).map(() => '..').concat(parts.slice(i)).map((s) => (s === '..' ? s : encodeURIComponent(s))).join('/');
  }

  // ---------- progress ----------
  let cancelled = false;
  function progress() {
    let box = document.getElementById('export-progress');
    if (!box) {
      box = document.createElement('div');
      box.id = 'export-progress';
      box.setAttribute('role', 'status');
      box.innerHTML = '<div class="xp-card"><div class="xp-title"></div><div class="xp-bar"><i></i></div><div class="xp-step"></div><button type="button">Cancel</button></div>';
      box.querySelector('button').addEventListener('click', () => { cancelled = true; box.querySelector('.xp-step').textContent = 'Cancelling…'; });
      document.body.appendChild(box);
    }
    box.classList.remove('hidden');
    return {
      set(title, i, n, step) {
        box.querySelector('.xp-title').textContent = title;
        box.querySelector('.xp-bar i').style.width = (n ? Math.round((i / n) * 100) : 0) + '%';
        box.querySelector('.xp-step').textContent = step || '';
      },
      done() { box.classList.add('hidden'); },
    };
  }
  function checkCancel() {
    if (cancelled) throw new Error('Export cancelled');
  }

  // ---------- board helpers ----------
  async function withBoard(kind, content, fn) {
    const board = BOARD_TYPES[kind];
    await board.ensure();
    const host = document.createElement('div');
    host.className = 'xp-offscreen';
    document.body.appendChild(host);
    const eng = new window[board.engine](host, Object.assign({}, board.opts, { readOnly: true, onChange() {} }));
    try {
      eng.loadFromHtml(content);
      return await fn(eng);
    } finally {
      try { eng.destroy(); } catch (e) { /* ignore */ }
      host.remove();
    }
  }
  let renderer = null;
  async function boardRenderer() {
    await ensureSlidesAssets();
    if (!renderer) renderer = window.SlidesEngine.createRenderer(SLIDES_SOURCE_ASSETS);
    return renderer;
  }
  let framesIndex = null;
  async function framesFor(p) {
    if (!framesIndex) {
      try { framesIndex = (await (await fetch('/api/frames', { cache: 'no-store' })).json()).items || []; } catch (e) { framesIndex = []; }
    }
    return framesIndex.filter((it) => it.path === p);
  }

  // ---------- markdown ----------
  // Render a markdown file's body. `linkFor(workspacePath, ref)` returns the
  // href for a workspace link (or null to drop the link).
  async function markdownBody(p, source, linkFor) {
    await ensureMarkdownLibs();
    const tpl = markdownTemplate(source);
    for (const img of tpl.content.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      const t = boardTargetOf(p, src);
      try {
        if (t && !t.ref.startsWith('slide=')) {
          const r = await boardRenderer();
          img.setAttribute('src', await r.renderImage(t.path, decodeURIComponent(t.ref.split('=')[1] || '')));
          img.classList.add('md-board-img');
          continue;
        }
        const ws = resolveWorkspaceLink(p, src);
        if (ws) img.setAttribute('src', await toDataUrl('/api/raw?path=' + encodeURIComponent(ws)));
      } catch (e) {
        const note = document.createElement('span');
        note.className = 'md-missing';
        note.textContent = '[' + (img.getAttribute('alt') || src) + ': not available]';
        img.replaceWith(note);
      }
    }
    tpl.content.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) return;
      const ws = resolveWorkspaceLink(p, href);
      if (!ws) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      const t = boardTargetOf(p, href);
      const to = linkFor(ws, t ? t.ref : '');
      if (to) a.setAttribute('href', to);
      else {
        const span = document.createElement('span');
        span.className = 'md-unlinked';
        span.title = 'Not included in this export: ' + ws;
        span.innerHTML = a.innerHTML;
        a.replaceWith(span);
      }
    });
    return tpl.innerHTML;
  }

  const SITE_CSS = `
.site-nav { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 10px 24px; font-size: 13px; background: var(--bg); border-bottom: 1px solid var(--line); }
.site-nav a { color: var(--link); text-decoration: none; font-weight: 600; }
.site-nav span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md .md-unlinked { color: var(--muted); border-bottom: 1px dotted var(--muted); }
.idx { max-width: 900px; margin: 0 auto; padding: 32px 40px 80px; }
.idx h1 { margin: 0 0 4px; font-size: 28px; }
.idx .sub { color: var(--muted); margin: 0 0 24px; }
.idx h2 { margin: 24px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.idx ul { list-style: none; margin: 0; padding: 0; }
.idx li a { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; color: var(--fg); text-decoration: none; }
.idx li a:hover { background: var(--soft); }
.idx .k { min-width: 74px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-align: center; background: var(--soft); color: var(--muted); }
`;
  const THEME_SCRIPT = '<script>if(matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.dataset.theme="dark";<\/script>';

  // ---------- website ----------
  async function exportSite(folder) {
    cancelled = false;
    const ui = progress();
    const title = folder ? folder.split('/').pop() : 'Workspace';
    try {
      framesIndex = null;
      if (renderer) renderer.clear();
      const files = filesIn(folder);
      if (!files.length) throw new Error('This folder is empty');
      const relOf = (p) => (folder ? p.slice(folder.length + 1) : p);
      const exported = new Set(files.map((f) => relOf(f.path)));
      // Site path of every file (markdown becomes .html).
      const siteOf = new Map();
      files.forEach((f) => {
        let sp = relOf(f.path);
        if (kindOf(f) === 'markdown') {
          const html = sp.replace(/\.(md|markdown)$/i, '.html');
          sp = exported.has(html) ? sp + '.html' : html;
        }
        siteOf.set(f.path, sp);
      });
      const indexName = exported.has('index.html') ? 'site-index.html' : 'index.html';
      const pages = [];
      const copy = [];
      let i = 0;
      for (const f of files) {
        checkCancel();
        i++;
        const kind = kindOf(f);
        ui.set('Exporting “' + title + '” as a website', i, files.length + 1, f.path);
        const sp = siteOf.get(f.path);
        if (BOARD_TYPES[kind]) {
          try {
            const content = await readFile(f.path);
            const html = await withBoard(kind, content, (eng) => eng.exportStandalone(null, { returnHtml: true }));
            pages.push({ path: sp, content: html });
          } catch (err) {
            copy.push(f.path); // fall back to the raw file
          }
        } else if (kind === 'markdown') {
          const source = await readFile(f.path);
          const body = await markdownBody(f.path, source, (ws) => (siteOf.has(ws) ? relUrl(sp, siteOf.get(ws)) : null));
          const name = f.path.split('/').pop();
          pages.push({
            path: sp,
            content: `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name.replace(/\.(md|markdown)$/i, ''))}</title>`
              + `<style>${MARKDOWN_CSS}${SITE_CSS}</style>${THEME_SCRIPT}</head><body>`
              + `<nav class="site-nav"><a href="${relUrl(sp, indexName)}">← ${esc(title)}</a><span>${esc(relOf(f.path))}</span></nav>`
              + `<article class="md">${body || '<p class="md-missing">This file is empty.</p>'}</article></body></html>`,
          });
        } else {
          copy.push(f.path);
        }
      }
      checkCancel();
      // Index page: every file grouped by folder.
      const groups = new Map();
      files.forEach((f) => {
        const rel = relOf(f.path);
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(f);
      });
      const idx = [...groups].map(([dir, list]) => `<h2>${esc(dir || title)}</h2><ul>${list.map((f) => {
        const k = kindOf(f);
        const label = KIND_LABEL[k] || (f.path.split('.').pop() || 'file').toUpperCase().slice(0, 6);
        return `<li><a href="${relUrl(indexName, siteOf.get(f.path))}"><span class="k">${esc(label)}</span>${esc(f.path.split('/').pop())}</a></li>`;
      }).join('')}</ul>`).join('');
      pages.push({
        path: indexName,
        content: `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
          + `<style>${MARKDOWN_CSS}${SITE_CSS}</style>${THEME_SCRIPT}</head><body><main class="idx"><h1>${esc(title)}</h1>`
          + `<p class="sub">${files.length} file${files.length === 1 ? '' : 's'} · exported ${esc(new Date().toLocaleString())}</p>${idx}</main></body></html>`,
      });
      ui.set('Exporting “' + title + '” as a website', files.length + 1, files.length + 1, 'Packing zip…');
      const res = await fetch('/api/export-site', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, pages, copy }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Export failed');
      }
      downloadBlob(await res.blob(), title.replace(/[^\w.-]+/g, '-') + '-site.zip');
      setStatus('Website exported: open index.html in the zip', 'ok');
    } catch (err) {
      setStatus(String((err && err.message) || err), 'dirty');
      if (!cancelled) alert('Website export failed: ' + ((err && err.message) || err));
    } finally {
      ui.done();
    }
  }

  // ---------- PDF ----------
  const PDF_CSS = `
@page { size: A4; margin: 14mm; }
html, body { background: #fff !important; color: #1f2328; }
.md { max-width: none; padding: 0; }
.pdf-cover { height: 240mm; display: flex; flex-direction: column; justify-content: center; }
.pdf-cover h1 { font-size: 40px; border: 0; margin: 0 0 8px; }
.pdf-cover p { color: #59636e; margin: 0; }
.pdf-toc { break-after: page; }
.pdf-toc h2 { border: 0; }
.pdf-toc ol { padding-left: 1.4em; }
.pdf-toc a { color: #1f2328; }
.pdf-toc .k, .pdf-sec .k { display: inline-block; min-width: 64px; margin-right: 8px; padding: 1px 6px; border-radius: 999px; background: #eef1f5; color: #59636e; font-size: 10px; font-weight: 700; text-align: center; }
.pdf-sec { break-before: page; }
.pdf-sec > h1 { font-size: 22px; border-bottom: 2px solid #d1d9e0; padding-bottom: 6px; }
.pdf-sec > h1 small { display: block; font-size: 11px; font-weight: 400; color: #59636e; margin-top: 2px; }
.pdf-fig { margin: 0 0 18px; break-inside: avoid; }
.pdf-fig img { display: block; max-width: 100%; max-height: 230mm; margin: 0 auto; border: 1px solid #d1d9e0; border-radius: 6px; }
.pdf-fig figcaption { font-size: 11px; color: #59636e; text-align: center; margin-top: 4px; }
.pdf-slide { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; margin: 0 0 14px; border: 1px solid #d1d9e0; break-inside: avoid; }
.pdf-slide .sl-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.pdf-pre { white-space: pre-wrap; word-break: break-word; font-size: 10.5px; }
.pdf-note { color: #59636e; font-style: italic; }
`;

  async function sectionFor(f, linkFor) {
    const kind = kindOf(f);
    const fig = (src, cap) => `<figure class="pdf-fig"><img src="${src}" alt="">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`;
    if (kind === 'markdown') {
      return `<div class="md">${await markdownBody(f.path, await readFile(f.path), linkFor)}</div>`;
    }
    if (kind === 'mindmap' || kind === 'flow') {
      const r = await boardRenderer();
      const items = (await framesFor(f.path)).filter((it) => it.ref !== 'frame=__all__');
      const out = [];
      if (!items.length) out.push(fig(await r.renderImage(f.path, '__all__'), ''));
      for (const it of items) {
        try { out.push(fig(await r.renderImage(f.path, decodeURIComponent(it.ref.split('=')[1])), it.title)); } catch (e) { /* skip */ }
      }
      return out.join('');
    }
    if (kind === 'gantt') {
      const r = await boardRenderer();
      return fig(await r.renderImage(f.path, 'chart', false), 'Timeline') + fig(await r.renderImage(f.path, 'analytics', false), 'Analytics');
    }
    if (kind === 'kanban') {
      const content = await readFile(f.path);
      await BOARD_TYPES.kanban.ensure();
      if (!window.KanbanExport) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/kanban/export.js?v=1';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Kanban export failed to load'));
          document.body.appendChild(s);
        });
      }
      const svg = window.KanbanExport.buildSvg(window.KanbanCore.parseHtml(content));
      return fig('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), '');
    }
    if (kind === 'slides') {
      const content = await readFile(f.path);
      const { slidesHtml, css } = await withBoard('slides', content, (eng) => eng.buildStaticSlides());
      if (!document.getElementById('xp-slides-css')) {
        // Remember the slide CSS for the print document.
        const holder = document.createElement('template');
        holder.id = 'xp-slides-css';
        holder.dataset.css = css;
        document.body.appendChild(holder);
      }
      return slidesHtml.map((h) => `<div class="pdf-slide">${h}</div>`).join('');
    }
    if (kind === 'image') return fig(await toDataUrl('/api/raw?path=' + encodeURIComponent(f.path)), '');
    if (kind === 'text') {
      const text = await readFile(f.path);
      const clipped = text.length > 200000 ? text.slice(0, 200000) + '\n… (truncated)' : text;
      return `<div class="md"><pre class="pdf-pre"><code>${esc(clipped)}</code></pre></div>`;
    }
    if (kind === 'pdf') return '<p class="pdf-note">PDF file — not embedded. Find it in the folder or the website export.</p>';
    if (kind === 'html') return '<p class="pdf-note">HTML page — open it in the website export.</p>';
    return '<p class="pdf-note">File not shown in the PDF.</p>';
  }

  async function exportPdf(folder) {
    cancelled = false;
    const ui = progress();
    const title = folder ? folder.split('/').pop() : 'Workspace';
    try {
      framesIndex = null;
      if (renderer) renderer.clear();
      const old = document.getElementById('xp-slides-css');
      if (old) old.remove();
      const files = filesIn(folder);
      if (!files.length) throw new Error('This folder is empty');
      const secId = new Map(files.map((f, i) => [f.path, 'sec-' + (i + 1)]));
      const linkFor = (ws) => (secId.has(ws) ? '#' + secId.get(ws) : null);
      const sections = [];
      let i = 0;
      for (const f of files) {
        checkCancel();
        i++;
        ui.set('Building PDF of “' + title + '”', i, files.length + 1, f.path);
        let body;
        try {
          body = await sectionFor(f, linkFor);
        } catch (err) {
          body = `<p class="pdf-note">Could not include this file: ${esc((err && err.message) || err)}</p>`;
        }
        const kind = kindOf(f);
        sections.push(`<section class="pdf-sec" id="${secId.get(f.path)}"><h1><span class="k">${esc(KIND_LABEL[kind] || kind)}</span>${esc(f.path.split('/').pop())}<small>${esc(f.path)}</small></h1>${body}</section>`);
      }
      checkCancel();
      ui.set('Building PDF of “' + title + '”', files.length + 1, files.length + 1, 'Opening print dialog…');
      const slidesCssEl = document.getElementById('xp-slides-css');
      const slidesCss = slidesCssEl ? slidesCssEl.dataset.css : '';
      const toc = files.map((f) => `<li><a href="#${secId.get(f.path)}"><span class="k">${esc(KIND_LABEL[kindOf(f)] || kindOf(f))}</span>${esc(f.path)}</a></li>`).join('');
      const doc = `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><title>${esc(title)}</title>`
        + `<style>${MARKDOWN_CSS}${slidesCss}${PDF_CSS}</style></head><body>`
        + `<div class="md"><div class="pdf-cover"><h1>${esc(title)}</h1><p>${files.length} file${files.length === 1 ? '' : 's'} · ${esc(new Date().toLocaleDateString())}</p></div>`
        + `<div class="pdf-toc"><h2>Contents</h2><ol>${toc}</ol></div></div>${sections.join('')}</body></html>`;
      await printDocument(doc, title);
      setStatus('Choose “Save as PDF” in the print dialog', 'ok');
    } catch (err) {
      setStatus(String((err && err.message) || err), 'dirty');
      if (!cancelled) alert('PDF export failed: ' + ((err && err.message) || err));
    } finally {
      ui.done();
    }
  }

  // Print a document from a hidden frame once its images are ready; the
  // browser's print dialog offers "Save as PDF".
  function printDocument(html, title) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.className = 'xp-print-frame';
      frame.setAttribute('aria-hidden', 'true');
      document.body.appendChild(frame);
      frame.onload = async () => {
        const doc = frame.contentDocument;
        // Scale slides to the page width.
        doc.querySelectorAll('.pdf-slide').forEach((box) => {
          const s = box.querySelector('.sl-slide');
          if (s) s.style.transform = 'scale(' + (box.clientWidth / 1280) + ')';
        });
        await Promise.all([...doc.images].map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
        const prevTitle = document.title;
        document.title = title; // default file name in "Save as PDF"
        const cleanup = () => {
          document.title = prevTitle;
          setTimeout(() => frame.remove(), 1000);
          resolve();
        };
        frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(cleanup, 60000); // safety if afterprint never fires
      };
      frame.srcdoc = html;
    });
  }

  window.exportFolderSite = exportSite;
  window.exportFolderPdf = exportPdf;
})();
