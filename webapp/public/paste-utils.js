// Clean-up for text pasted from chat tools (ChatGPT etc.) and detection of
// text diagrams (box-drawing / ASCII art) that only line up in a monospace
// font with every space kept. Used by the mindmap, flow and markdown editors
// as `window.DocPaste` (they work without it, e.g. in standalone exports).
(function (global) {
  // Spaces that look like spaces but break alignment / matching.
  const ODD_SPACES = /[  -   　]/g;
  // Invisible characters: zero-width space/joiners, word joiner, BOM, soft hyphen.
  const INVISIBLE = /[​-‍⁠﻿­]/g;
  const BOX_CHARS = /[─-▟]/;
  const ARROWS = /[←-⇿⟰-⟿⤀-⥿▲-◄►▼]|-{2,}>|<-{2,}|={2,}>|<={2,}|-->|<--/;

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(INVISIBLE, '')
      .replace(ODD_SPACES, ' ');
  }

  function expandTabs(text, size) {
    const n = size || 4;
    return text.split('\n').map((line) => {
      let out = '';
      for (const ch of line) {
        if (ch === '\t') out += ' '.repeat(n - (out.length % n));
        else out += ch;
      }
      return out;
    }).join('\n');
  }

  // True when the text is a drawing made of characters, e.g.
  //   ┌────────┐      +--------+
  //   │ Client │──▶   | Client |-->
  //   └────────┘      +--------+
  function isDiagram(text) {
    const lines = normalize(text).split('\n').filter((l) => l.trim());
    if (lines.length < 2) return false;
    const boxLines = lines.filter((l) => BOX_CHARS.test(l)).length;
    if (boxLines >= 2) return true;
    // ASCII boxes / edges: +----+, |    |, arrows, and aligned gaps.
    const edge = lines.filter((l) => /[+*][-=_~]{3,}[+*]|^\s*[-=_]{4,}\s*$/.test(l)).length;
    const pipes = lines.filter((l) => /(^|\s)\|(\s|$)|\|\s{2,}\S|\S\s{2,}\|/.test(l)).length;
    const arrows = lines.filter((l) => ARROWS.test(l)).length;
    const gaps = lines.filter((l) => /\S {3,}\S/.test(l)).length;
    if (edge >= 2 && pipes >= 1) return true;
    if (arrows >= 1 && (pipes >= 2 || edge >= 1) && gaps >= 1) return true;
    // Mostly lines of only drawing characters with arrows (flow-style art).
    const art = lines.filter((l) => /^[\s|/\\_\-=+<>^v.:*'`~()[\]#o0]+$/.test(l)).length;
    return arrows >= 1 && art >= Math.max(2, Math.ceil(lines.length / 3));
  }

  // Prepare a diagram for monospace display: normalized, tabs expanded,
  // trailing spaces and surrounding blank lines removed.
  function cleanDiagram(text) {
    return expandTabs(normalize(text))
      .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
      .replace(/^\n+|\n+$/g, '');
  }

  // Widest line, in characters (for sizing monospace boxes).
  function maxLineLength(text) {
    return String(text || '').split('\n').reduce((m, l) => Math.max(m, [...l].length), 0);
  }

  global.DocPaste = { normalize, isDiagram, cleanDiagram, expandTabs, maxLineLength };
  if (typeof module === 'object' && module.exports) module.exports = global.DocPaste;
})(typeof window !== 'undefined' ? window : globalThis);
