// Keep references working when files or folders move or are renamed.
// Links are written from the data folder root ("/assets/images/x.png"), so
// they stay valid wherever the linking file lives. After a move:
//  - Markdown links / images / <img src> / <a href> that pointed at the old
//    path (or anything under a moved folder) are rewritten to the new path.
//  - Relative links inside a file that itself moved are pinned to the data
//    root, so they keep pointing at the same targets.
//  - Boards (mindmap, flow, kanban, slides, ... saved as HTML with a JSON
//    payload) have path strings in their JSON rewritten.
const fs = require('fs');
const path = require('path');

const MD_LINK_RE = /(!?\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+["'][^"']*["'])?\s*\))/g;
const ATTR_RE = /(\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi;

const isExternal = (href) => !href || /^([a-z][\w+.-]*:|#|\/\/)/i.test(href);

function encodeRootLink(p) {
  return '/' + p.split('/').map((seg) => encodeURIComponent(seg).replace(/%2E/g, '.')).join('/');
}

// Resolve a link written in `fromRel` to a data-root path ({path, suffix}).
function resolve(fromRel, href) {
  if (isExternal(href)) return null;
  const cut = href.search(/[#?]/);
  const suffix = cut >= 0 ? href.slice(cut) : '';
  let p = cut >= 0 ? href.slice(0, cut) : href;
  if (!p) return null;
  try { p = decodeURIComponent(p); } catch (e) { /* keep as written */ }
  const base = p.startsWith('/') ? '' : path.posix.dirname(fromRel);
  const resolved = path.posix.normalize(path.posix.join(base === '.' ? '' : base, p.replace(/^\/+/, '')));
  if (!resolved || resolved === '.' || resolved.startsWith('..')) return null;
  return { path: resolved, suffix };
}

function mapPath(p, from, to) {
  if (p === from) return to;
  if (p.startsWith(from + '/')) return to + p.slice(from.length);
  return null;
}

// Rewrite one link. `before`/`now` are where the linking file was / is.
function rewriteHref(href, before, now, from, to) {
  const r = resolve(before, href);
  if (!r) return href;
  const moved = mapPath(r.path, from, to);
  if (moved) return encodeRootLink(moved) + r.suffix;
  // The linking file moved: pin its relative links to the data root.
  if (before !== now && !href.startsWith('/')) return encodeRootLink(r.path) + r.suffix;
  return href;
}

function rewriteMarkdown(text, before, now, from, to) {
  const fix = (pre, href, post) => pre + rewriteHref(href, before, now, from, to) + post;
  return text
    .replace(MD_LINK_RE, (m, pre, href, post) => fix(pre, href, post))
    .replace(ATTR_RE, (m, pre, href, post) => fix(pre, href, post));
}

// Board HTML: rewrite JSON string values that are data-root paths
// ("notes/a.png") or root links ("/notes/a.html#frame=x").
function rewriteBoard(html, from, to) {
  const m = html.match(/(<script[^>]*type=["']application\/json["'][^>]*>)([\s\S]*?)(<\/script>)/i);
  if (!m) return html;
  const json = m[2].replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner) => {
    let s;
    try { s = JSON.parse('"' + inner + '"'); } catch (e) { return whole; }
    let out = null;
    if (s.startsWith('/') && !s.startsWith('//')) {
      const r = resolve('', s);
      const moved = r && mapPath(r.path, from, to);
      if (moved) out = encodeRootLink(moved) + r.suffix;
    } else if (!/^[a-z][\w+.-]*:/i.test(s) && !s.includes('\n') && (s.includes('/') || /\.[a-z0-9]{1,6}$/i.test(s))) {
      // Only path-looking strings: a node that just says "notes" is text.
      const moved = mapPath(s, from, to);
      if (moved) out = moved;
    }
    if (out == null) return whole;
    return JSON.stringify(out).replace(/</g, '\\u003c');
  });
  if (json === m[2]) return html;
  return html.slice(0, m.index) + m[1] + json + m[3] + html.slice(m.index + m[0].length);
}

// Walk the data folder after `from` was moved to `to` (both data-root
// relative). Returns the list of files that were rewritten.
function rewriteAfterMove(root, from, to, opts) {
  const changed = [];
  const skip = (opts && opts.skip) || (() => false);
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const now = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { if (!skip(now)) walk(full); continue; }
      const isMd = /\.(md|markdown)$/i.test(entry.name);
      const isHtml = /\.html?$/i.test(entry.name);
      if (!isMd && !isHtml) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.size > 8 * 1024 * 1024) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      // Where this file was before the move.
      const before = mapPath(now, to, from) || now;
      let next = text;
      if (isMd) next = rewriteMarkdown(text, before, now, from, to);
      else if (/data-docviewer\s*=/.test(text)) next = rewriteBoard(text, from, to);
      if (next !== text) {
        fs.writeFileSync(full, next);
        changed.push(now);
      }
    }
  })(root);
  return changed;
}

// Turn every relative link in a markdown file into a data-root link.
function normalizeMarkdown(text, rel) {
  const fix = (pre, href, post) => {
    if (isExternal(href) || href.startsWith('/')) return pre + href + post;
    const r = resolve(rel, href);
    return pre + (r ? encodeRootLink(r.path) + r.suffix : href) + post;
  };
  return text.replace(MD_LINK_RE, (m, a, h, b) => fix(a, h, b)).replace(ATTR_RE, (m, a, h, b) => fix(a, h, b));
}

const ASSET_KIND = (name) => {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/.test(n)) return 'images';
  if (/\.(mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac)$/.test(n)) return 'media';
  if (/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|rtf)$/.test(n)) return 'docs';
  if (/\.(md|markdown|html?|mmd|json|ya?ml|txt|js|ts|py|go|sh)$/.test(n)) return null; // documents, not assets
  return 'files';
};

// Plan moving assets into assets/<kind>/: files referenced from notes or
// boards, and everything inside per-note "*-assets" folders.
function planAssetTidy(root) {
  const refs = new Set();
  const all = [];
  const relLinkFiles = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { walk(full); continue; }
      all.push(rel);
      if (!/\.(md|markdown|html?)$/i.test(entry.name)) continue;
      let text;
      try { if (fs.statSync(full).size > 8 * 1024 * 1024) continue; text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      if (/\.(md|markdown)$/i.test(entry.name)) {
        let relative = false;
        const see = (href) => { const r = resolve(rel, href); if (r) refs.add(r.path); if (!isExternal(href) && !href.startsWith('/')) relative = true; };
        text.replace(MD_LINK_RE, (m, a, h) => { see(h); return m; }).replace(ATTR_RE, (m, a, h) => { see(h); return m; });
        if (relative) relLinkFiles.push(rel);
      } else {
        const j = text.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
        if (j) j[1].replace(/"((?:[^"\\]|\\.)*)"/g, (w, inner) => {
          let v; try { v = JSON.parse('"' + inner + '"'); } catch (e) { return w; }
          const r = v.startsWith('/') ? resolve('', v) : (v.includes('/') || /\.[a-z0-9]{1,6}$/i.test(v) ? { path: v } : null);
          if (r) refs.add(r.path);
          return w;
        });
      }
    }
  })(root);
  const taken = new Set(all.map((p) => p.toLowerCase()));
  const moves = [];
  all.forEach((p) => {
    if (p.startsWith('assets/')) return;
    const name = p.split('/').pop();
    const kind = ASSET_KIND(name);
    if (!kind) return;
    const inNoteAssets = p.split('/').slice(0, -1).some((seg) => /-assets$/i.test(seg));
    if (!refs.has(p) && !inNoteAssets) return;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let to = `assets/${kind}/${name}`;
    for (let i = 2; taken.has(to.toLowerCase()); i++) to = `assets/${kind}/${stem}-${i}${ext}`;
    taken.add(to.toLowerCase());
    moves.push({ from: p, to });
  });
  return { moves, relLinkFiles };
}

module.exports = { normalizeMarkdown, planAssetTidy, rewriteAfterMove, rewriteMarkdown, rewriteBoard, rewriteHref, resolve, encodeRootLink };
