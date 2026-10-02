/* DocViewer wiki core — pages, [[links]], backlinks. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WikiCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TITLE_MAX = 160;
  const BODY_MAX = 120000;
  const PATH_MAX = 400;

  let seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function str(v, max) {
    const s = typeof v === 'string' ? v : '';
    return max ? s.slice(0, max) : s;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function posixPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  }

  function stripExt(p) {
    return posixPath(p).replace(/\.html?$/i, '');
  }

  function pathKey(p) {
    return stripExt(p).toLowerCase();
  }

  function titleKey(t) {
    return String(t || '').trim().toLowerCase();
  }

  function slug(title) {
    const s = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'page';
  }

  const KIND_LABEL = {
    mindmap: 'Mindmap', flow: 'Flow', kanban: 'Kanban', gantt: 'Gantt',
    slides: 'Slides', wiki: 'Wiki', json: 'JSON', yaml: 'YAML', pdf: 'PDF',
    file: 'File', frame: 'Frame', slide: 'Slide', task: 'Task', card: 'Card',
  };

  function kindLabel(kind) {
    return KIND_LABEL[kind] || 'File';
  }

  function looksLikePath(t) {
    const s = String(t || '').split('#')[0].trim();
    if (!s) return false;
    if (s.indexOf('/') >= 0) return true;
    return /\.(html?|json|ya?ml|pdf|md|txt|csv)$/i.test(s);
  }

  function splitTarget(target) {
    const raw = String(target || '');
    const i = raw.indexOf('#');
    if (i < 0) return { file: posixPath(raw).trim(), hash: '' };
    return { file: posixPath(raw.slice(0, i)).trim(), hash: raw.slice(i + 1).trim() };
  }

  function parseHash(hash) {
    const h = String(hash || '').trim();
    if (!h) return { type: '', id: '' };
    const m = h.match(/^(frame|slide|task|card)[:\/](.+)$/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2].trim() };
    return { type: '', id: h };
  }

  function parseWikiLink(inner) {
    const raw = String(inner || '');
    const pipe = raw.indexOf('|');
    const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    const label = (pipe >= 0 ? raw.slice(pipe + 1) : '').trim();
    return { target, label: label || target };
  }

  function extractWikiLinks(body) {
    const text = String(body || '');
    const re = /\[\[([^[\]]+)\]\]/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const parsed = parseWikiLink(m[1]);
      if (!parsed.target) continue;
      out.push({
        raw: m[0],
        target: parsed.target.slice(0, PATH_MAX),
        label: parsed.label.slice(0, TITLE_MAX),
        index: m.index,
      });
    }
    return out;
  }

  function dirOf(filePath) {
    const p = posixPath(filePath);
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  }

  function joinPath(dir, name) {
    const n = posixPath(name);
    if (!dir) return n;
    if (n.indexOf('/') === 0) return n.replace(/^\//, '');
    return posixPath(dir + '/' + n);
  }

  function emptyResolve(target) {
    return {
      path: '',
      title: target || '',
      missing: true,
      target: target || '',
      kind: '',
      hash: '',
      frameId: '',
      slideId: '',
      slideIndex: null,
      taskId: '',
      cardId: '',
      anchor: '',
    };
  }

  function matchNamed(item, id) {
    if (!item || !id) return false;
    if (String(item.id) === id) return true;
    if (String(item.id).toLowerCase() === String(id).toLowerCase()) return true;
    return titleKey(item.title) === titleKey(id);
  }

  function resolveAnchor(page, hash) {
    const parsed = parseHash(hash);
    const type = parsed.type;
    const id = parsed.id;
    if (!page || !id) return { ok: true, title: page && page.title, anchor: '' };
    const specs = [
      { type: 'frame', key: 'frames', idKey: 'frameId' },
      { type: 'slide', key: 'slides', idKey: 'slideId' },
      { type: 'task', key: 'tasks', idKey: 'taskId' },
      { type: 'card', key: 'cards', idKey: 'cardId' },
    ];
    function hit(spec, item, index) {
      const out = {
        ok: true,
        title: item.title || page.title,
        anchor: spec.type,
        kind: page.kind || '',
      };
      out[spec.idKey] = item.id;
      if (spec.type === 'slide') out.slideIndex = typeof item.index === 'number' ? item.index : index;
      return out;
    }
    if (type === 'slide' && /^\d+$/.test(id)) {
      const n = Number(id) - 1;
      const slides = page.slides || [];
      if (slides[n]) return hit(specs[1], slides[n], n);
    }
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      if (type && type !== spec.type) continue;
      const list = page[spec.key] || [];
      const found = list.find((item) => matchNamed(item, id));
      if (found) return hit(spec, found, list.indexOf(found));
    }
    return { ok: false };
  }

  function findFile(file, pages, fromPath) {
    const list = Array.isArray(pages) ? pages : [];
    if (!file) return null;
    const exact = list.find((p) => posixPath(p.path) === file || pathKey(p.path) === pathKey(file));
    if (exact) return exact;
    if (fromPath) {
      const joined = joinPath(dirOf(fromPath), file);
      const rel = list.find((p) => pathKey(p.path) === pathKey(joined));
      if (rel) return rel;
    }
    const tk = titleKey(file);
    const matches = list.filter((p) => titleKey(p.title) === tk);
    if (matches.length === 1) return matches[0];
    return null;
  }

  function findGlobalAnchor(id, pages) {
    const list = Array.isArray(pages) ? pages : [];
    const hits = [];
    const seen = {};
    function add(page, a) {
      if (!a || !a.ok || !a.anchor) return;
      const k = page.path + '|' + a.anchor + '|' + (a.frameId || a.slideId || a.taskId || a.cardId);
      if (seen[k]) return;
      seen[k] = true;
      hits.push({ page, a });
    }
    list.forEach((page) => {
      add(page, resolveAnchor(page, id));
      if (id.indexOf(':') >= 0 || id.indexOf('/') >= 0) return;
      ['frame', 'slide', 'task', 'card'].forEach((type) => add(page, resolveAnchor(page, type + ':' + id)));
    });
    return hits.length === 1 ? hits[0] : null;
  }

  function finishResolve(page, a, target, file, hash) {
    return {
      path: page.path,
      title: (a && a.title) || page.title,
      missing: false,
      target: file || page.path,
      kind: page.kind || '',
      hash: hash || '',
      frameId: (a && a.frameId) || '',
      slideId: (a && a.slideId) || '',
      slideIndex: a && a.slideIndex != null ? a.slideIndex : null,
      taskId: (a && a.taskId) || '',
      cardId: (a && a.cardId) || '',
      anchor: (a && a.anchor) || '',
    };
  }

  function resolveLink(target, pages, fromPath) {
    const split = splitTarget(target);
    const file = split.file;
    const hash = split.hash;
    const list = Array.isArray(pages) ? pages : [];
    if (!file && !hash) return emptyResolve('');
    let page = file ? findFile(file, list, fromPath) : null;
    if (!page && file) {
      const g = findGlobalAnchor(file, list);
      if (g) {
        if (!hash) return finishResolve(g.page, g.a, target, g.page.path, g.a.anchor + ':' + (g.a.frameId || g.a.slideId || g.a.taskId || g.a.cardId));
        page = g.page;
      }
    }
    if (!page && hash) {
      const g = findGlobalAnchor(hash, list);
      if (g) page = g.page;
    }
    if (!page) {
      const r = emptyResolve(target);
      r.title = file || target;
      r.hash = hash;
      return r;
    }
    if (!hash) return finishResolve(page, { title: page.title, anchor: '' }, target, file, '');
    const a = resolveAnchor(page, hash);
    if (!a.ok) {
      const r = emptyResolve(target);
      r.path = page.path;
      r.title = page.title;
      r.kind = page.kind || '';
      r.hash = hash;
      return r;
    }
    return finishResolve(page, a, target, file, hash);
  }

  function outgoingLinks(body, pages, fromPath) {
    return extractWikiLinks(body).map((link) => {
      const r = resolveLink(link.target, pages, fromPath);
      return {
        raw: link.raw,
        target: link.target,
        label: link.label,
        path: r.path,
        title: r.title,
        missing: r.missing,
        kind: r.kind,
        hash: r.hash,
        frameId: r.frameId,
        slideId: r.slideId,
        slideIndex: r.slideIndex,
        taskId: r.taskId,
        cardId: r.cardId,
        anchor: r.anchor,
      };
    });
  }

  function incomingLinks(path, title, pages) {
    const key = pathKey(path);
    const tk = titleKey(title);
    const list = Array.isArray(pages) ? pages : [];
    const seen = {};
    const out = [];
    list.forEach((page) => {
      if (pathKey(page.path) === key) return;
      const links = Array.isArray(page.links) ? page.links : extractWikiLinks(page.body);
      links.forEach((link) => {
        const r = resolveLink(link.target, list, page.path);
        const hit = (!r.missing && pathKey(r.path) === key)
          || (r.missing && (pathKey(link.target) === key || titleKey(link.target) === tk));
        if (!hit || seen[page.path]) return;
        seen[page.path] = true;
        out.push({
          path: page.path,
          title: page.title || page.path,
          label: link.label || page.title || '',
        });
      });
    });
    out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return out;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderHtml(body, pages, fromPath) {
    const extracted = extractWikiLinks(body);
    let masked = String(body || '');
    extracted.slice().reverse().forEach((link, i) => {
      const id = extracted.length - 1 - i;
      masked = masked.slice(0, link.index) + '%%WK' + id + '%%' + masked.slice(link.index + link.raw.length);
    });
    const escaped = escapeHtml(masked);
    const lines = escaped.split('\n');
    const blocks = [];
    let i = 0;

    function restore(s) {
      return s.replace(/%%WK(\d+)%%/g, (m, n) => {
        const link = extracted[Number(n)];
        if (!link) return m;
        const r = resolveLink(link.target, pages, fromPath);
        const cls = 'wk-link' + (r.missing ? ' is-missing' : '');
        const label = escapeHtml(link.label || r.title || link.target);
        const path = escapeHtml(r.path || '');
        const target = escapeHtml(link.target);
        return '<a class="' + cls + '" href="#"'
          + ' data-path="' + path + '"'
          + ' data-target="' + target + '"'
          + ' data-kind="' + escapeHtml(r.kind || '') + '"'
          + ' data-anchor="' + escapeHtml(r.anchor || '') + '"'
          + ' data-frame="' + escapeHtml(r.frameId || '') + '"'
          + ' data-slide="' + escapeHtml(r.slideId || '') + '"'
          + ' data-task="' + escapeHtml(r.taskId || '') + '"'
          + ' data-card="' + escapeHtml(r.cardId || '') + '"'
          + ' data-missing="' + (r.missing ? '1' : '0') + '">' + label + '</a>';
      });
    }

    function inline(s) {
      return restore(s)
        .replace(/`([^`]+)`/g, (m, code) => '<code>' + code + '</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="wk-ext" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }

    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        blocks.push('<pre><code>' + restore(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }
      if (/^#{1,3}\s+/.test(line)) {
        const level = (line.match(/^#+/) || ['#'])[0].length;
        const tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
        blocks.push('<' + tag + '>' + inline(line.replace(/^#{1,3}\s+/, '')) + '</' + tag + '>');
        i += 1;
        continue;
      }
      if (/^---+$/.test(line)) {
        blocks.push('<hr>');
        i += 1;
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          quote.push(inline(lines[i].replace(/^&gt;\s?/, '')));
          i += 1;
        }
        blocks.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i += 1;
        }
        blocks.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i += 1;
        }
        blocks.push('<ol>' + items.join('') + '</ol>');
        continue;
      }
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(```|#{1,3}\s|&gt;|---+|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) {
        para.push(inline(lines[i]));
        i += 1;
      }
      blocks.push('<p>' + para.join('<br>') + '</p>');
    }
    return blocks.join('');
  }

  function createEmpty(title) {
    const ts = nowIso();
    return {
      version: 1,
      title: str(title, TITLE_MAX) || 'New page',
      body: '',
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function createStarter(title) {
    const data = createEmpty(title);
    data.body = [
      'Start writing.',
      '',
      'Link any file with [[path/to/file]] or pick one from Link.',
      'Jump to a frame with [[file.html#frame:id|Frame name]], a slide with [[deck.html#slide:id]], or a Gantt task with [[chart.html#task:id]].',
      '',
      'Backlinks on the right list wiki pages that mention this one.',
    ].join('\n');
    return data;
  }

  function normalize(raw) {
    const data = createEmpty();
    if (!raw || typeof raw !== 'object') return data;
    data.title = str(raw.title, TITLE_MAX) || 'New page';
    data.body = str(raw.body, BODY_MAX);
    data.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : data.createdAt;
    data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : data.createdAt;
    return data;
  }

  function pageSummary(path, data, extra) {
    const page = normalize(data);
    extra = extra || {};
    return {
      path: posixPath(path).slice(0, PATH_MAX),
      title: page.title,
      kind: extra.kind || 'wiki',
      links: extractWikiLinks(page.body).map((l) => ({ target: l.target, label: l.label })),
      frames: Array.isArray(extra.frames) ? extra.frames : [],
      slides: Array.isArray(extra.slides) ? extra.slides : [],
      tasks: Array.isArray(extra.tasks) ? extra.tasks : [],
      cards: Array.isArray(extra.cards) ? extra.cards : [],
    };
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, TITLE_MAX) || norm.title;
    norm.updatedAt = nowIso();
    const json = JSON.stringify(norm).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Page').replace(/[<>]/g, '');
    return '<!DOCTYPE html>\n<html lang="en" data-docviewer="wiki">\n<head><meta charset="UTF-8"><title>'
      + t + '</title></head>\n<body>\n<script type="application/json" id="wiki-data">\n'
      + json + '\n</script>\n</body>\n</html>\n';
  }

  function isWikiHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']wiki["']/.test(html);
  }

  function parseHtml(html) {
    if (!isWikiHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']wiki-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return createEmpty();
    try {
      return normalize(JSON.parse(m[1]));
    } catch (e) {
      return createEmpty();
    }
  }

  return {
    TITLE_MAX,
    BODY_MAX,
    PATH_MAX,
    uid,
    str,
    nowIso,
    posixPath,
    pathKey,
    titleKey,
    slug,
    kindLabel,
    looksLikePath,
    splitTarget,
    parseHash,
    parseWikiLink,
    extractWikiLinks,
    resolveLink,
    outgoingLinks,
    incomingLinks,
    escapeHtml,
    renderHtml,
    createEmpty,
    createStarter,
    normalize,
    pageSummary,
    serializeToHtml,
    isWikiHtml,
    parseHtml,
  };
});
