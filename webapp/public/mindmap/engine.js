/* DocViewer mindmap engine — pan/zoom canvas, 4-direction trees, cells, frames. */
(function (global) {
  const DIRS = ['right', 'left', 'down', 'up'];
  const RELINK_DIRS = ['left', 'right'];
  const OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
  const H_GAP = 128;
  const ROOT_GAP = 224;
  const S_GAP = 18;
  const RELINK_MS = 550;
  const LOCK_HOLD_MS = 560;
  const YT_W = 360;
  const YT_H = 203;
  const IMG_W = 280;
  const IMG_H = 200;
  const CELL_W = 208;
  const CELL_H = 42;
  const CELL_MIN_W = 88;
  const CELL_MAX_H = 520;
  const CELL_MIN_CHARS = 13;
  const CELL_CHARS = 50;
  const ROOT_W = 232;
  const ROOT_H = 42;
  const ROOT_MIN_W = 112;
  const LINK_MIN_W = 188;
  const LINK_MAX_W = 268;
  const LINK_MIN_H = 68;
  const LINK_MAX_H = 108;
  // Below this zoom the world is not kept on a fixed-scale GPU layer (see .is-gpu-world).
  const GPU_WORLD_MIN_ZOOM = 0.35;
  const EXPORT_V = 18; // must match MindmapExport._v in export.js
  const NODE_PALETTE = [
    '#ffffff', '#F3F5F8', '#E8F0FB', '#E5F3EA', '#FBF3DA', '#F8E8EE', '#EEE7F6', '#E1F3F4',
    '#F8E9DC', '#ECEEF2', '#C9D8EE', '#C5E0CD', '#EED9A4', '#E8BFC9', '#D3C2E6', '#B5D8DE',
    '#E5C4A8', '#C7CCD4', '#6E8CB5', '#5E9A76', '#C4A45A', '#B86B76', '#7A649E', '#4E8A93',
  ];
  const TEXT_PALETTE = [
    '#1a2130', '#4b5563', '#6b7280', '#9aa3b2', '#f4f6fa', '#ffffff', '#c62828', '#1565c0',
    '#2e7d32', '#6a1b9a', '#e65100', '#00695c', '#ad1457', '#283593', '#ef6c00', '#000000',
  ];
  const LINK_PALETTE = [
    '#8AA8D4', '#7CBC9A', '#D4B85A', '#D48AA0', '#A88BC8', '#6FB3C0', '#D4A07A', '#90A4AE',
    '#1565c0', '#2e7d32', '#c62828', '#6a1b9a', '#e65100', '#00838f', '#37474f', '#1a2130',
  ];
  const LINK_STYLES = [
    { id: 'solid', label: 'Solid', dash: '' },
    { id: 'dotted', label: 'Dotted', dash: '2 6' },
    { id: 'dashed', label: 'Dashed', dash: '9 7' },
    { id: 'dash-dot', label: 'Dash-dot', dash: '12 6 2.5 6' },
  ];
  const CODE_LANGS = ['auto', 'plaintext', 'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'html', 'css', 'json', 'yaml', 'bash', 'sql', 'markdown', 'c', 'cpp'];
  const CLIP_PREFIX = 'DOCVIEWER_MINDMAP:';

  function uid(prefix) {
    return prefix + Math.random().toString(36).slice(2, 10);
  }

  function hexLum(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length < 6) return 0.5;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastText(fill) {
    if (isTransparent(fill)) return '#1a2130';
    return hexLum(fill) > 0.55 ? '#1a2130' : '#f4f6fa';
  }

  function isTransparent(v) {
    const s = String(v || '').trim().toLowerCase();
    return s === 'transparent' || s === 'none';
  }

  function colorInputValue(v, fallback) {
    const s = String(v || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    if (/^#[0-9a-f]{3}$/i.test(s) && s.length === 4) {
      return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return fallback || '#D7E3FC';
  }

  function transparentSwatch(active, attrs) {
    return `<button type="button" class="mm-color mm-transparent${active ? ' active' : ''}" ${attrs} title="Transparent"></button>`;
  }

  function colorChipHtml(kind, color) {
    if (kind === 'text') {
      const c = isTransparent(color) ? '#1a2130' : (color || '#1a2130');
      return `<span class="mm-color-chip mm-chip-text" style="color:${c}">A</span>`;
    }
    if (kind === 'border') {
      if (isTransparent(color)) return '<span class="mm-color-chip mm-chip-border is-clear"></span>';
      return `<span class="mm-color-chip mm-chip-border" style="border-color:${color}"></span>`;
    }
    if (kind === 'line') {
      return `<span class="mm-color-chip mm-chip-line" style="background:${color || '#8AA8D4'}"></span>`;
    }
    if (isTransparent(color)) return '<span class="mm-color-chip mm-chip-fill is-clear"></span>';
    return `<span class="mm-color-chip mm-chip-fill" style="background:${color}"></span>`;
  }

  function parseHexColor(s) {
    const t = String(s || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(t)) return t;
    if (/^#[0-9a-f]{3}$/i.test(t) && t.length === 4) return '#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
    if (/^[0-9a-f]{6}$/i.test(t)) return '#' + t;
    if (/^[0-9a-f]{3}$/i.test(t)) return '#' + t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
    return '';
  }

  function colorCustomRow(insp, value, fallback, extraAttrs) {
    const hex = colorInputValue(value, fallback);
    const shown = isTransparent(value) ? '' : hex;
    const extra = extraAttrs ? ' ' + extraAttrs : '';
    return `<div class="mm-color-custom-row">
      <label class="mm-color-custom-well" title="Pick a custom color">
        <input type="color" data-insp="${insp}" value="${hex}" class="mm-color-custom"${extra}/>
      </label>
      <input type="text" data-insp-hex="${insp}" value="${shown}" class="mm-color-hex" spellcheck="false" maxlength="9" placeholder="#RRGGBB" title="Custom hex color"/>
    </div>`;
  }

  function menuColorRow(action, palette, current, withClear) {
    const clear = withClear ? transparentSwatch(isTransparent(current), `data-m="${action}" data-color="transparent"`) : '';
    const chips = palette.map((c) => `<button type="button" class="mm-color${String(current || '').toLowerCase() === String(c).toLowerCase() ? ' active' : ''}" data-m="${action}" data-color="${c}" style="background:${c}"></button>`).join('');
    const fallback = action === 'text' ? '#1a2130' : action === 'link' ? '#8AA8D4' : '#D7E3FC';
    return `<div class="mm-menu-label">Presets</div><div class="mm-swatches">${clear}${chips}</div><div class="mm-menu-label">Custom</div>${colorCustomRow(action, current, fallback, `data-m="${action}" data-color-input="${action}"`)}`;
  }

  function colorDropHtml(kind, label, current, swatchesHtml, extraHtml) {
    return `<div class="mm-color-drop" data-drop="${kind}">
      <button type="button" class="mm-color-drop-btn" data-insp-drop="${kind}" title="${label} color">
        ${colorChipHtml(kind, current)}
        <span class="mm-color-drop-label">${label}</span>
      </button>
      <div class="mm-color-panel">
        <div class="mm-color-panel-head">Presets</div>
        <div class="mm-swatches">${swatchesHtml}</div>
        <div class="mm-color-panel-head">Custom</div>
        ${extraHtml || ''}
      </div>
    </div>`;
  }

  function subMenuHtml(label, inner) {
    if (!inner) return '';
    return `<div class="mm-menu-item has-sub"><button type="button" data-sub="1"><span>${escapeHtml(label)}</span><span class="mm-caret">›</span></button><div class="mm-submenu">${inner}</div></div>`;
  }

  function defaultStyle() {
    return { fill: '#D7E3FC', border: '#D7E3FC', textColor: '#1a2130', textColorManual: false, fillColorManual: false, linkColor: '#8AA8D4', linkWidth: 2.25, linkStyle: 'solid', linkCurve: 50, linkColorManual: false };
  }

  const FONT_FACES = [
    { id: 'sans', label: 'Sans', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
    { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", Times, serif' },
    { id: 'mono', label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
    { id: 'rounded', label: 'Rounded', css: '"Trebuchet MS", "Segoe UI Rounded", sans-serif' },
    { id: 'hand', label: 'Hand', css: '"Segoe Print", "Comic Sans MS", cursive' },
  ];
  const FONT_SIZE_MIN = 11;
  const FONT_SIZE_MAX = 70;
  const FONT_SIZE_DEFAULT = 18;
  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 70];

  function fontCss(id) {
    const found = FONT_FACES.find((f) => f.id === id);
    return (found && found.css) || FONT_FACES[0].css;
  }

  function fontSelectHtml(current, attr) {
    const cur = current || 'sans';
    return `<select ${attr} title="Font">${FONT_FACES.map((f) => `<option value="${f.id}"${f.id === cur ? ' selected' : ''}>${f.label}</option>`).join('')}</select>`;
  }

  function sizeSelectHtml(current, attr) {
    const cur = Number(current) || FONT_SIZE_DEFAULT;
    const sizes = FONT_SIZES.slice();
    if (sizes.indexOf(cur) === -1) sizes.push(cur);
    sizes.sort((a, b) => a - b);
    return `<select ${attr} title="Size">${sizes.map((s) => `<option value="${s}"${s === cur ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
  }

  function defaultFormat() {
    return { bold: false, italic: false, underline: false, fontSize: FONT_SIZE_DEFAULT, align: 'center', fontFamily: 'sans' };
  }

  function defaultCollapsed() {
    return { left: false, right: false, up: false, down: false };
  }

  function rootStyle(usedFills) {
    const fill = randomRootFill(usedFills);
    return {
      fill,
      border: fill,
      textColor: contrastText(fill),
      textColorManual: false,
      fillColorManual: true,
      linkColor: '#8AA8D4',
      linkWidth: 2.5,
      linkStyle: 'solid',
      linkCurve: 50,
      linkColorManual: false,
    };
  }

  function nodeDepth(nodes, id) {
    let d = 0;
    let cur = nodes[id];
    const seen = new Set();
    while (cur && cur.parentId && nodes[cur.parentId] && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = nodes[cur.parentId];
      d += 1;
      if (d > 80) break;
    }
    return d;
  }

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function levelHueSeed(data) {
    if (typeof data.linkColorSeed === 'number' && Number.isFinite(data.linkColorSeed)) {
      return ((data.linkColorSeed % 360) + 360) % 360;
    }
    const id = String((data.rootIds && data.rootIds[0]) || 'mm');
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) % 360;
  }

  function randomLevelColor(used) {
    const taken = new Set((used || []).map((c) => String(c).toLowerCase()));
    for (let i = 0; i < 28; i++) {
      const hue = Math.floor(Math.random() * 360);
      const sat = 52 + Math.floor(Math.random() * 26);
      const lit = 40 + Math.floor(Math.random() * 14);
      const hex = hslToHex(hue, sat, lit);
      if (!taken.has(hex.toLowerCase())) return hex;
    }
    return hslToHex(Math.floor(Math.random() * 360), 60, 46);
  }

  function randomLevelFill(used) {
    const taken = new Set((used || []).map((c) => String(c).toLowerCase()));
    for (let i = 0; i < 32; i++) {
      const hue = Math.floor(Math.random() * 360);
      const sat = 44 + Math.floor(Math.random() * 28);
      const lit = 76 + Math.floor(Math.random() * 12);
      const hex = hslToHex(hue, sat, lit);
      if (!taken.has(hex.toLowerCase())) return hex;
    }
    return hslToHex(Math.floor(Math.random() * 360), 52, 82);
  }

  function hueOfHex(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length < 6) return null;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 0.04) return null;
    let hue;
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
    return hue;
  }

  function randomRootFill(used) {
    const usedHues = (used || []).map(hueOfHex).filter((h) => h != null);
    const bases = [210, 198, 168, 148, 38, 22, 350, 328, 268, 186, 16, 250];
    for (let i = 0; i < 48; i++) {
      let hue = bases[Math.floor(Math.random() * bases.length)] + Math.floor(Math.random() * 18) - 9;
      hue = ((hue % 360) + 360) % 360;
      let sat = 36 + Math.floor(Math.random() * 14);
      let lit = 76 + Math.floor(Math.random() * 7);
      if (hue >= 28 && hue <= 70) {
        sat = 30 + Math.floor(Math.random() * 10);
        lit = 80 + Math.floor(Math.random() * 5);
      }
      if (i < 36 && usedHues.some((u) => {
        const d = Math.abs(u - hue) % 360;
        return Math.min(d, 360 - d) < 28;
      })) continue;
      return hslToHex(hue, sat, lit);
    }
    return hslToHex(bases[Math.floor(Math.random() * bases.length)], 42, 78);
  }

  function fillForLevel(data, depth) {
    if (depth < 1) return null;
    if (!data.levelFillColors || typeof data.levelFillColors !== 'object' || Array.isArray(data.levelFillColors)) {
      data.levelFillColors = {};
    }
    const key = String(depth);
    if (data.levelFillColors[key]) return data.levelFillColors[key];
    const used = Object.values(data.levelFillColors);
    const hex = randomLevelFill(used);
    data.levelFillColors[key] = hex;
    return hex;
  }

  function applyHopFill(data, n) {
    if (!n || !n.parentId) return;
    if (!n.style) n.style = defaultStyle();
    if (n.style.fillColorManual) return;
    const fill = fillForLevel(data, nodeDepth(data.nodes, n.id));
    if (!fill) return;
    n.style.fill = fill;
    n.style.border = fill;
    if (!n.style.textColorManual) n.style.textColor = contrastText(fill);
  }

  function colorForLevel(data, depth) {
    if (depth < 1) return '#8AA8D4';
    if (!data.levelLinkColors || typeof data.levelLinkColors !== 'object' || Array.isArray(data.levelLinkColors)) {
      data.levelLinkColors = {};
    }
    const key = String(depth);
    if (data.levelLinkColors[key]) return data.levelLinkColors[key];
    const used = Object.values(data.levelLinkColors);
    const hue = (levelHueSeed(data) + (depth - 1) * 137.508 + used.length * 23) % 360;
    let hex = hslToHex(hue, 56 + (depth % 3) * 8, 43 + (depth % 2) * 6);
    if (used.some((c) => String(c).toLowerCase() === hex.toLowerCase())) hex = randomLevelColor(used);
    data.levelLinkColors[key] = hex;
    return hex;
  }

  function resolveLinkColor(data, child) {
    const style = (child && child.style) || {};
    if (style.linkColorManual && style.linkColor) return style.linkColor;
    return colorForLevel(data, nodeDepth(data.nodes, child.id));
  }

  function hexRgb(hex) {
    const h = parseHexColor(hex);
    if (!h) return null;
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function contrastRatio(a, b) {
    const L1 = hexLum(parseHexColor(a) || a);
    const L2 = hexLum(parseHexColor(b) || b);
    const hi = Math.max(L1, L2);
    const lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function colorDist(a, b) {
    const x = hexRgb(a);
    const y = hexRgb(b);
    if (!x || !y) return 1;
    return Math.hypot((x.r - y.r) / 255, (x.g - y.g) / 255, (x.b - y.b) / 255);
  }

  function hueDelta(a, b) {
    const x = hexRgb(a);
    const y = hexRgb(b);
    if (!x || !y) return 180;
    const ah = rgbToHsl(x.r, x.g, x.b);
    const bh = rgbToHsl(y.r, y.g, y.b);
    if (ah.s < 10 || bh.s < 10) return 180;
    let d = Math.abs(ah.h - bh.h) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  function linkClashesFill(link, fill) {
    const c = parseHexColor(link);
    const f = parseHexColor(fill);
    if (!c || !f) return false;
    const dist = colorDist(c, f);
    if (dist < 0.24) return true;
    const hd = hueDelta(c, f);
    const cl = rgbToHsl(hexRgb(c).r, hexRgb(c).g, hexRgb(c).b);
    const fl = rgbToHsl(hexRgb(f).r, hexRgb(f).g, hexRgb(f).b);
    const ld = Math.abs(cl.l - fl.l);
    if (hd < 26 && ld < 16) return true;
    if (hd < 22 && dist < 0.36) return true;
    if (hd < 34 && ld < 22 && dist < 0.42) return true;
    return false;
  }

  function contrastLinkOnFill(link, fill) {
    const src = parseHexColor(link);
    const bg = parseHexColor(fill);
    if (!src || !bg || !linkClashesFill(src, bg)) return src || link;
    const rgb = hexRgb(src);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const darken = hexLum(bg) > 0.5;
    const tries = darken
      ? [
        [hsl.h, Math.max(hsl.s, 54), 30],
        [hsl.h, Math.min(Math.max(hsl.s, 62), 84), 20],
        [(hsl.h + 28) % 360, 66, 26],
        [(hsl.h + 180) % 360, 58, 28],
      ]
      : [
        [hsl.h, Math.max(hsl.s, 50), 74],
        [hsl.h, Math.min(Math.max(hsl.s, 56), 80), 84],
        [(hsl.h + 28) % 360, 60, 78],
        [(hsl.h + 180) % 360, 54, 80],
      ];
    for (let i = 0; i < tries.length; i++) {
      const hex = hslToHex(tries[i][0], tries[i][1], tries[i][2]);
      if (!linkClashesFill(hex, bg)) return hex;
    }
    return hslToHex(tries[0][0], tries[0][1], tries[0][2]);
  }

  function resolveVisibleLinkColor(data, child, parent, a, b, frameAt) {
    let color = resolveLinkColor(data, child);
    const frames = [];
    const add = (f) => {
      if (f && f.id && !frames.some((x) => x.id === f.id)) frames.push(f);
    };
    if (typeof frameAt === 'function' && a && b) {
      add(frameAt(a.x, a.y));
      add(frameAt(b.x, b.y));
      add(frameAt((a.x + b.x) / 2, (a.y + b.y) / 2));
      add(frameAt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
      add(frameAt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
    }
    (data.frames || []).forEach((f) => {
      if (parent && parent.frameId === f.id) add(f);
      if (child && child.frameId === f.id) add(f);
    });
    let worst = null;
    let worstScore = Infinity;
    frames.forEach((f) => {
      if (!parseHexColor(f.fill)) return;
      const score = contrastRatio(color, f.fill) + colorDist(color, f.fill);
      if (score < worstScore) {
        worstScore = score;
        worst = f;
      }
    });
    if (worst && linkClashesFill(color, worst.fill)) return contrastLinkOnFill(color, worst.fill);
    return color;
  }

  function linkDash(style) {
    const found = LINK_STYLES.find((s) => s.id === style);
    return found ? found.dash : '';
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // Cheap 32-bit string hash (FNV-1a); only used to detect changes.
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function readEditValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    return String(el.textContent || '').replace(/\n$/, '');
  }

  function stripTags(s) {
    return String(s == null ? '' : s).replace(/<[^>]+>/g, '');
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function hexAlpha(hex, a) {
    const h = String(hex || '#C5CAE9').replace('#', '');
    if (h.length < 6) return `rgba(197, 202, 233, ${a})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return `rgba(197, 202, 233, ${a})`;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function defaultFrameStyle() {
    return { fill: '#ffffff', fillAlpha: 1, border: '#c5c9d1', locked: false, categoryId: null };
  }

  function normalizeFrameCats(raw) {
    const cats = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((c) => {
      if (!c || typeof c !== 'object') return;
      const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : uid('fc_');
      if (seen.has(id)) return;
      seen.add(id);
      cats.push({
        id,
        name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 60) : 'Category',
        parentId: typeof c.parentId === 'string' && c.parentId ? c.parentId : null,
        collapsed: !!c.collapsed,
      });
    });
    const ids = new Set(cats.map((c) => c.id));
    cats.forEach((c) => {
      if (c.parentId && !ids.has(c.parentId)) c.parentId = null;
    });
    const byId = new Map(cats.map((c) => [c.id, c]));
    cats.forEach((c) => {
      const walk = new Set();
      let id = c.parentId;
      while (id) {
        if (id === c.id || walk.has(id)) {
          c.parentId = null;
          break;
        }
        walk.add(id);
        const p = byId.get(id);
        if (!p) {
          c.parentId = null;
          break;
        }
        id = p.parentId;
      }
    });
    return cats;
  }

  function normalizeLinks(raw, nodes) {
    const out = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((l) => {
      if (!l || typeof l !== 'object') return;
      const fromId = typeof l.fromId === 'string' ? l.fromId : '';
      const toId = typeof l.toId === 'string' ? l.toId : '';
      if (!fromId || !toId || fromId === toId || !nodes[fromId] || !nodes[toId]) return;
      const pair = fromId < toId ? fromId + '\0' + toId : toId + '\0' + fromId;
      if (seen.has(pair)) return;
      const a = nodes[fromId];
      const b = nodes[toId];
      if (b.parentId === fromId || a.parentId === toId) return;
      seen.add(pair);
      const fromDir = (l.fromDir === 'left' || l.fromDir === 'right') ? l.fromDir : 'right';
      const toDir = (l.toDir === 'left' || l.toDir === 'right') ? l.toDir : (OPP[fromDir] || 'left');
      out.push({
        id: typeof l.id === 'string' && l.id.trim() ? l.id.trim() : uid('lk_'),
        fromId,
        toId,
        fromDir,
        toDir,
      });
    });
    return out;
  }

  function safeHttpUrl(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    try {
      const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s.replace(/^\/\//, '');
      const u = new URL(withProto);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) { /* ignore */ }
    return '';
  }

  function prettyLinkLabel(content) {
    const href = safeHttpUrl(content);
    if (!href) {
      const s = String(content || '').trim();
      if (!s) return 'Link';
      return s.length > 36 ? s.slice(0, 34) + '…' : s;
    }
    try {
      const u = new URL(href);
      let t = u.hostname.replace(/^www\./, '');
      if (u.pathname && u.pathname !== '/') {
        const path = u.pathname.replace(/\/$/, '');
        t += path.length > 18 ? path.slice(0, 16) + '…' : path;
      }
      return t;
    } catch (e) {
      return 'Link';
    }
  }

  function linkCardLabel(n) {
    const custom = String(n.label || '').trim();
    if (custom && custom !== 'Link' && custom !== n.content) return custom;
    return prettyLinkLabel(n.content);
  }

  function measureLinkSize(n) {
    const shown = String(linkCardLabel(n) || 'Link');
    const charW = 7.2;
    const w = clamp(Math.round(Math.min(shown.length, 30) * charW + 52), LINK_MIN_W, LINK_MAX_W);
    const perLine = Math.max(14, Math.floor((w - 44) / charW));
    const lines = clamp(Math.ceil(shown.length / perLine), 1, 3);
    const h = clamp(42 + lines * 18, LINK_MIN_H, LINK_MAX_H);
    return { w, h };
  }

  let _textMeasureCtx = null;
  function textMeasureCtx() {
    if (!_textMeasureCtx) {
      const c = document.createElement('canvas');
      _textMeasureCtx = c.getContext('2d');
    }
    return _textMeasureCtx;
  }

  function countWrappedLines(ctx, text, maxInner) {
    const paras = String(text == null ? '' : text).split('\n');
    let total = 0;
    paras.forEach((para) => {
      if (!para) { total += 1; return; }
      const tokens = para.split(/(\s+)/);
      let lineW = 0;
      let lines = 1;
      tokens.forEach((tok) => {
        const tw = ctx.measureText(tok).width;
        if (tw > maxInner && String(tok).trim()) {
          // Like the browser: the long word starts on a fresh line (the
          // preceding space is a break point), then splits across lines.
          if (lineW > 0) lines += 1;
          let acc = '';
          for (const ch of tok) {
            const next = acc + ch;
            if (ctx.measureText(next).width > maxInner && acc) {
              lines += 1;
              acc = ch;
            } else acc = next;
          }
          lineW = ctx.measureText(acc).width;
          return;
        }
        if (lineW + tw > maxInner && lineW > 0) {
          lines += 1;
          lineW = tw;
        } else lineW += tw;
      });
      total += lines;
    });
    return Math.max(1, total);
  }

  function measureTextCell(n, live) {
    const text = String(n.content || '');
    const fmt = n.format || defaultFormat();
    const fs = clamp(Number(fmt.fontSize) || FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX);
    const ctx = textMeasureCtx();
    ctx.font = `${fmt.italic ? 'italic ' : ''}${fmt.bold ? '700' : '500'} ${fs}px ${fontCss(fmt.fontFamily)}`;
    const padX = 64;
    const padY = 18;
    const minH = n.parentId ? CELL_H : ROOT_H;
    const minInner = ctx.measureText('n'.repeat(CELL_MIN_CHARS)).width;
    const maxInner = ctx.measureText('n'.repeat(CELL_CHARS)).width;
    let contentW = ctx.measureText(' ').width;
    String(text || ' ').split('\n').forEach((line) => {
      contentW = Math.max(contentW, ctx.measureText(line || ' ').width);
    });
    const slack = live ? Math.ceil(ctx.measureText('M').width) + 6 : 8;
    const minW = Math.ceil(minInner + padX);
    const maxW = Math.ceil(maxInner + padX);
    const w = clamp(Math.ceil(Math.min(contentW, maxInner) + padX + slack), minW, maxW);
    const inner = Math.max(24, w - padX);
    const atMax = w >= maxW - 1;
    const lines = atMax ? countWrappedLines(ctx, text, inner) : Math.max(1, String(text || '').split('\n').length);
    const h = clamp(Math.ceil(lines * fs * 1.35 + padY), minH, CELL_MAX_H);
    return { w, h };
  }

  function measureCodeCell(n) {
    const text = String(n.content || '');
    const ctx = textMeasureCtx();
    ctx.font = '12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    const padX = 28;
    const padY = 48;
    if (n.language === 'plaintext') {
      // Plain text (e.g. a pasted diagram): sized to fit, never wrapped.
      const lines = text.split('\n');
      let widest = ctx.measureText(' ').width;
      lines.forEach((line) => { widest = Math.max(widest, ctx.measureText(line || ' ').width); });
      const maxW = ctx.measureText('n'.repeat(160)).width;
      return {
        w: clamp(Math.ceil(Math.min(widest, maxW) + padX + 4), 200, Math.ceil(maxW + padX)),
        h: clamp(Math.ceil(lines.length * 17.4 + 84), 72, 1400),
      };
    }
    const maxInner = ctx.measureText('n'.repeat(CELL_CHARS)).width;
    let contentW = ctx.measureText(' ').width;
    String(text || ' ').split('\n').forEach((line) => {
      contentW = Math.max(contentW, ctx.measureText(line || ' ').width);
    });
    const w = clamp(Math.ceil(Math.min(contentW, maxInner) + padX), 200, Math.ceil(maxInner + padX));
    const inner = Math.max(40, w - padX);
    const lines = countWrappedLines(ctx, text, inner);
    const h = clamp(Math.ceil(lines * 16 + padY), 72, CELL_MAX_H);
    return { w, h };
  }

  function youtubeId(input) {
    if (!input) return '';
    const s = String(input).trim();
    const m =
      s.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
      s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
      s.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/) ||
      s.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/) ||
      s.match(/^([a-zA-Z0-9_-]{11})$/);
    return m ? m[1] : '';
  }

  const TS_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

  function formatTimestamp(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function parseTimestamp(label) {
    const m = String(label || '').trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = m[1] != null ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    if (sec > 59) return null;
    if (m[1] != null && min > 59) return null;
    return h * 3600 + min * 60 + sec;
  }

  function extractTimestamps(text) {
    const out = [];
    const seen = new Set();
    const re = new RegExp(TS_RE.source, 'g');
    let m;
    while ((m = re.exec(String(text || '')))) {
      const seconds = parseTimestamp(m[0]);
      if (seconds == null || seen.has(seconds)) continue;
      seen.add(seconds);
      out.push({ seconds, label: m[0] });
    }
    return out;
  }

  function timestampAtCaret(text, pos) {
    const re = new RegExp(TS_RE.source, 'g');
    let m;
    while ((m = re.exec(String(text || '')))) {
      if (pos >= m.index && pos <= m.index + m[0].length) return parseTimestamp(m[0]);
    }
    return null;
  }

  function ytHttpOrigin() {
    try {
      const o = typeof location !== 'undefined' ? location.origin : '';
      return o && /^https?:\/\//i.test(o) ? o : '';
    } catch (e) {
      return '';
    }
  }

  function isStandaloneDoc() {
    try {
      return document.documentElement.getAttribute('data-accretion') === 'standalone';
    } catch (e) {
      return false;
    }
  }

  function ytEmbedBlocked() {
    try {
      const p = typeof location !== 'undefined' ? location.protocol : '';
      if (p === 'file:' || p === 'blob:' || !ytHttpOrigin()) return true;
      // Embeds from a saved HTML file (and many local servers) hit YouTube error 153.
      if (isStandaloneDoc()) return true;
      return false;
    } catch (e) {
      return true;
    }
  }

  function ytEmbedSrc(id, startSec, autoplay) {
    const start = Math.max(0, Math.floor(Number(startSec) || 0));
    const q = ['rel=0', 'modestbranding=1', 'playsinline=1'];
    if (autoplay) q.push('autoplay=1');
    if (start) q.push('start=' + start);
    const origin = ytHttpOrigin();
    if (origin) q.push('origin=' + encodeURIComponent(origin));
    return 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?' + q.join('&');
  }

  function ytWatchSrc(id, startSec) {
    const start = Math.max(0, Math.floor(Number(startSec) || 0));
    return 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) + (start ? '&t=' + start + 's' : '');
  }

  function ytIframeHtml(id, startSec) {
    const src = ytEmbedSrc(id, startSec, true);
    return `<iframe src="${src}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="YouTube video"></iframe>`;
  }

  function loadYtIframeApi() {
    if (ytEmbedBlocked()) return Promise.reject(new Error('YouTube embeds need http(s)'));
    if (global.YT && global.YT.Player) return Promise.resolve(global.YT);
    if (loadYtIframeApi._p) return loadYtIframeApi._p;
    loadYtIframeApi._p = new Promise((resolve, reject) => {
      const prev = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') prev();
        resolve(global.YT);
      };
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => {
          loadYtIframeApi._p = null;
          reject(new Error('YouTube API failed to load'));
        };
        document.head.appendChild(s);
      }
    });
    return loadYtIframeApi._p;
  }

  function isMediaType(type) {
    return type === 'youtube' || type === 'link' || type === 'image';
  }

  function safeImageSrc(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,/i.test(s)) return s;
    const href = safeHttpUrl(s);
    return href || '';
  }

  function fileToImageDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !String(file.type || '').startsWith('image/')) {
        reject(new Error('Not an image'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1200;
        const scale = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const png = /png|webp|svg|gif/i.test(file.type);
        resolve(png ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image'));
      };
      img.src = url;
    });
  }

  function loadCss(href) {
    if ([...document.querySelectorAll('link')].some((l) => l.href.includes(href))) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src.includes(src))) {
        resolve();
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = reject;
      document.body.appendChild(el);
    });
  }

  let hljsPromise = null;
  function ensureHljs() {
    if (global.hljs) return Promise.resolve(global.hljs);
    if (hljsPromise) return hljsPromise;
    loadCss('https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css');
    hljsPromise = loadScript('https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js').then(() => global.hljs);
    return hljsPromise;
  }

  function highlightCode(code, language) {
    const raw = escapeHtml(code);
    if (!global.hljs) return raw;
    try {
      if (language && language !== 'auto' && global.hljs.getLanguage(language)) {
        return global.hljs.highlight(code, { language }).value;
      }
      return global.hljs.highlightAuto(code).value;
    } catch (e) {
      return raw;
    }
  }

  function createEmpty() {
    const id = uid('n_');
    return {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 0.55 },
      rootIds: [id],
      nodes: {
        [id]: {
          id,
          parentId: null,
          dir: null,
          type: 'text',
          content: '',
          label: '',
          language: 'auto',
          style: rootStyle(),
          format: { bold: true, italic: false, underline: false, fontSize: FONT_SIZE_DEFAULT, align: 'center', fontFamily: 'sans' },
          collapsedDirs: defaultCollapsed(),
          w: ROOT_W,
          h: ROOT_H,
          x: 0,
          y: 0,
          userSized: false,
          locked: false,
          note: '',
          noteOpen: false,
        },
      },
      frames: [],
      frameCats: [],
      links: [],
      levelLinkColors: {},
      linkColorSeed: Math.floor(Math.random() * 360),
    };
  }

  function serializeToHtml(data) {
    const first = data.rootIds && data.nodes[data.rootIds[0]];
    const title = escapeHtml((stripTags(first && first.content) || 'Mindmap').slice(0, 80) || 'Mindmap');
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="mindmap">\n<head><meta charset="UTF-8"><title>${title}</title></head>\n<body>\n<script type="application/json" id="mindmap-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isMindmapHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']mindmap["']/.test(html);
  }

  function parseHtml(html) {
    if (!isMindmapHtml(html)) return null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const el = doc.getElementById('mindmap-data');
      if (!el) return null;
      const data = JSON.parse(el.textContent);
      return normalizeData(data);
    } catch (e) {
      return null;
    }
  }

  function normalizeData(data) {
    const d = data && typeof data === 'object' ? data : createEmpty();
    d.version = 1;
    d.viewport = d.viewport || { x: 0, y: 0, zoom: 1 };
    d.nodes = d.nodes || {};
    d.rootIds = Array.isArray(d.rootIds) ? d.rootIds.filter((id) => d.nodes[id]) : [];
    d.frames = (Array.isArray(d.frames) ? d.frames : []).map((f, i) => Object.assign(defaultFrameStyle(), f, {
      z: typeof f.z === 'number' ? f.z : i,
      fillAlpha: 1,
      locked: !!f.locked,
      categoryId: typeof f.categoryId === 'string' && f.categoryId ? f.categoryId : null,
    }));
    d.frameCats = normalizeFrameCats(d.frameCats);
    const liveCats = new Set(d.frameCats.map((c) => c.id));
    d.frames.forEach((f) => {
      if (f.categoryId && !liveCats.has(f.categoryId)) f.categoryId = null;
    });
    if (!d.levelLinkColors || typeof d.levelLinkColors !== 'object' || Array.isArray(d.levelLinkColors)) {
      d.levelLinkColors = {};
    }
    Object.values(d.nodes).forEach((n) => {
      n.type = n.type || 'text';
      n.content = n.content == null ? '' : n.content;
      n.label = n.label || '';
      n.language = n.language || 'auto';
      n.style = Object.assign(defaultStyle(), n.style || {});
      n.format = Object.assign(defaultFormat(), n.format || {});
      if (!n.format.align) n.format.align = 'center';
      if (!n.format.fontFamily) n.format.fontFamily = 'sans';
      n.format.fontSize = clamp(Number(n.format.fontSize) || FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX);
      if (n.style.fill) n.style.border = n.style.fill;
      n.collapsedDirs = Object.assign(defaultCollapsed(), n.collapsedDirs || {});
      n.w = n.w || CELL_W;
      n.h = n.h || CELL_H;
      n.x = n.x || 0;
      n.y = n.y || 0;
      n.userSized = !!n.userSized;
      n.userPlaced = !!n.userPlaced;
      n.locked = !!n.locked;
      n.note = typeof n.note === 'string' ? n.note : '';
      n.noteOpen = !!n.noteOpen;
      n.imgAspect = (typeof n.imgAspect === 'number' && n.imgAspect > 0.12 && n.imgAspect < 12) ? n.imgAspect : null;
      if (n.frameId && !d.frames.some((f) => f.id === n.frameId)) n.frameId = null;
      if (n.parentId && !d.nodes[n.parentId]) {
        n.parentId = null;
        n.dir = null;
      }
      if (n.parentId && !DIRS.includes(n.dir)) n.dir = 'right';
    });
    // Break parent cycles (A -> B -> A) from imported or hand-edited data;
    // every parent walk in the engine would otherwise loop forever.
    Object.values(d.nodes).forEach((n) => {
      const seen = new Set([n.id]);
      let cur = n;
      while (cur.parentId) {
        if (seen.has(cur.parentId)) {
          cur.parentId = null;
          cur.dir = null;
          break;
        }
        seen.add(cur.parentId);
        cur = d.nodes[cur.parentId];
      }
    });
    // Every parentless node is a root and every root is parentless, so
    // detached nodes are laid out and drawn as top-level nodes.
    d.rootIds = d.rootIds.filter((id) => !d.nodes[id].parentId);
    Object.values(d.nodes).forEach((n) => {
      if (!n.parentId && !d.rootIds.includes(n.id)) d.rootIds.push(n.id);
    });
    const groups = {};
    Object.values(d.nodes).forEach((n) => {
      if (!n.parentId) return;
      const key = n.parentId + ':' + (n.dir || 'right');
      (groups[key] || (groups[key] = [])).push(n);
    });
    Object.keys(groups).forEach((key) => {
      const dir = key.slice(key.indexOf(':') + 1);
      const kids = groups[key];
      const numbered = kids.every((k) => typeof k.order === 'number');
      if (!numbered) {
        if (dir === 'left' || dir === 'right') kids.sort((a, b) => a.y - b.y);
        else kids.sort((a, b) => a.x - b.x);
      } else {
        kids.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
      }
      kids.forEach((k, i) => { k.order = i; });
    });
    if (!d.rootIds.length) {
      const orphans = Object.values(d.nodes).filter((n) => !n.parentId);
      d.rootIds = orphans.map((n) => n.id);
    }
    if (!d.rootIds.length) return createEmpty();
    if (typeof d.linkColorSeed !== 'number' || !Number.isFinite(d.linkColorSeed)) {
      d.linkColorSeed = levelHueSeed(d);
    }
    Object.values(d.nodes).forEach((n) => {
      if (!n.parentId) return;
      if (!n.style) n.style = defaultStyle();
      if (!n.style.linkColorManual) {
        n.style.linkColor = colorForLevel(d, nodeDepth(d.nodes, n.id));
        n.style.linkColorManual = false;
      }
      applyHopFill(d, n);
    });
    d.links = normalizeLinks(d.links, d.nodes);
    return d;
  }

  class MindmapEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.readOnly = !!this.opts.readOnly;
      this.data = createEmpty();
      this.selectedId = null;
      this.selectedIds = new Set();
      this.selectedFrameId = null;
      this.selectedLinkId = null;
      this._connectFrom = null;
      this._menuLinkId = null;
      this._ignorePortClick = false;
      this.tool = 'select';
      this.editingId = null;
      this._layoutPass = 0;
      this._destroyed = false;
      this._relink = null;
      this._menuNodeId = null;
      this._menuFrameId = null;
      this._menuMode = 'node';
      this._spaceDown = false;
      this._batching = false;
      this._exportMenuOpen = false;
      this._suppressChange = false;
      this._undoStack = [];
      this._redoStack = [];
      this._lastSnap = null;
      this._lastHistKey = '';
      this._historyIgnore = false;
      this._colorPicking = false;
      this._colorPickAt = 0;
      this._ytOpen = false;
      this._mediaNodeId = null;
      this._ytPlayer = null;
      this._ytClock = null;
      this._ytVideoId = '';
      this._frameQuery = '';
      this._imgZoom = { scale: 1, x: 0, y: 0 };
      this._imgPan = null;
      this._pointers = new Map();
      this._pinch = null;
      this._gestureActive = false;
      this._gestureZoom = 1;
      this._pinchWheelUntil = 0;
      this._zoomPend = null;
      this._zoomRaf = 0;
      this._buildDom();
      this._bind();
    }

    static isMindmapHtml(html) { return isMindmapHtml(html); }
    static parseHtml(html) { return parseHtml(html); }
    static createEmpty() { return createEmpty(); }
    static serializeToHtml(data) { return serializeToHtml(data); }
    static defaultHtml() { return serializeToHtml(createEmpty()); }

    _buildDom() {
      this.container.innerHTML = '';
      this.container.classList.add('mm-host');
      const root = document.createElement('div');
      root.className = 'mm-root';
      root.innerHTML = `
        <div class="mm-toolbar">
          <button type="button" data-act="tool-frame" title="Draw a frame (click again to select)">Frame</button>
          <button type="button" data-act="tool-connect" title="Connect cells (C)">Connect</button>
          <span class="mm-sep"></span>
          <button type="button" data-act="add-root" title="New topic on the canvas">New</button>
          <span class="mm-sep"></span>
          <button type="button" data-act="undo" title="Undo (Ctrl+Z)" disabled>Undo</button>
          <button type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button>
          <span class="mm-sep"></span>
          <span class="mm-inspector"></span>
          <span class="mm-sep mm-insp-sep" style="display:none"></span>
          <button type="button" data-act="export">Export</button>
          <span class="mm-sep"></span>
          <button type="button" data-act="zoom-out" title="Zoom out">−</button>
          <span class="mm-zoom-label">100%</span>
          <button type="button" data-act="zoom-in" title="Zoom in">+</button>
          <button type="button" data-act="fit" title="Fit to screen">Fit</button>
          <button type="button" data-act="fullscreen" title="Fullscreen">Fullscreen</button>
          <div class="mm-export-menu">
            <button type="button" data-export="standalone">Standalone HTML</button>
            <button type="button" data-export="png">Canvas PNG</button>
            <button type="button" data-export="svg">Canvas SVG</button>
            <button type="button" data-export="pdf">Canvas PDF</button>
            <button type="button" data-export="frame-png">Frame PNG</button>
            <button type="button" data-export="frame-svg">Frame SVG</button>
            <button type="button" data-export="frame-pdf">Frame PDF</button>
          </div>
        </div>
        <div class="mm-frames-dock" hidden>
          <button type="button" data-act="frames" title="Jump to a frame">Frames</button>
          <div class="mm-frames-menu">
            <input class="dv-fcat-search" type="search" placeholder="Search frames" autocomplete="off" spellcheck="false" />
            <div class="dv-fcat-list"></div>
          </div>
        </div>
        <div class="mm-canvas">
          <div class="mm-world">
            <svg class="mm-links"></svg>
            <div class="mm-drop-slot"></div>
          </div>
          <div class="mm-marquee"></div>
          <div class="mm-drop-hint"></div>
          <div class="mm-lock-hold" aria-hidden="true">
            <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18"></circle></svg>
          </div>
        </div>
        <div class="mm-format-bar"></div>
          <div class="mm-hint">Left-drag to select · Connect tool to draw a line · Click a line and Delete to remove it · Two-finger drag to pan · Scroll or pinch to zoom</div>
        <div class="mm-menu"></div>
        <div class="mm-color-layer"></div>
        <div class="mm-yt-modal" hidden>
          <div class="mm-yt-modal-backdrop" data-yt-close></div>
          <div class="mm-yt-modal-box" role="dialog" aria-modal="true" aria-label="YouTube video">
            <div class="mm-yt-modal-bar">
              <span data-media-title>YouTube</span>
              <div class="mm-yt-modal-actions">
                <a class="mm-yt-modal-ext" data-yt-watch hidden target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
                <button type="button" class="mm-yt-modal-ext" data-yt-window hidden>Play on YouTube</button>
                <button type="button" class="mm-yt-modal-close" data-yt-close title="Close (Esc)">Close</button>
              </div>
            </div>
            <div class="mm-yt-modal-body">
              <div class="mm-yt-modal-stage-wrap">
                <div class="mm-yt-modal-stage"></div>
                <button type="button" class="mm-yt-mark" data-yt-stamp hidden title="Add this time to the note">＋ 0:00</button>
              </div>
              <div class="mm-yt-modal-note">
                <div class="mm-yt-modal-note-bar">
                  <span>Note</span>
                  <button type="button" class="mm-yt-stamp-btn" data-yt-stamp hidden title="Insert current video time">＋ 0:00</button>
                </div>
                <textarea data-media-note placeholder="Write a note. Click ＋ to add 1:23, then click a time to jump."></textarea>
                <div class="mm-yt-stamps" data-yt-stamps hidden></div>
              </div>
            </div>
          </div>
        </div>
      `;
      this.container.appendChild(root);
      this.els = {
        root,
        canvas: root.querySelector('.mm-canvas'),
        world: root.querySelector('.mm-world'),
        svg: root.querySelector('.mm-links'),
        toolbar: root.querySelector('.mm-toolbar'),
        inspector: root.querySelector('.mm-inspector'),
        inspSep: root.querySelector('.mm-insp-sep'),
        zoomLabel: root.querySelector('.mm-zoom-label'),
        formatBar: root.querySelector('.mm-format-bar'),
        menu: root.querySelector('.mm-menu'),
        hint: root.querySelector('.mm-hint'),
        exportMenu: root.querySelector('.mm-export-menu'),
        dropSlot: root.querySelector('.mm-drop-slot'),
        dropHint: root.querySelector('.mm-drop-hint'),
        lockHold: root.querySelector('.mm-lock-hold'),
        marquee: root.querySelector('.mm-marquee'),
        bookmarks: root.querySelector('.mm-frames-menu'),
        frameList: root.querySelector('.dv-fcat-list'),
        frameSearch: root.querySelector('.dv-fcat-search'),
        framesBtn: root.querySelector('[data-act="frames"]'),
        framesDock: root.querySelector('.mm-frames-dock'),
        colorLayer: root.querySelector('.mm-color-layer'),
        ytModal: root.querySelector('.mm-yt-modal'),
        ytStage: root.querySelector('.mm-yt-modal-stage'),
        ytStageWrap: root.querySelector('.mm-yt-modal-stage-wrap'),
        ytTitle: root.querySelector('[data-media-title]'),
        ytWatch: root.querySelector('[data-yt-watch]'),
        ytWindow: root.querySelector('[data-yt-window]'),
        ytMark: root.querySelector('.mm-yt-mark'),
        ytStampBtn: root.querySelector('.mm-yt-stamp-btn'),
        ytStamps: root.querySelector('[data-yt-stamps]'),
        mediaNote: root.querySelector('[data-media-note]'),
      };
    }

    _bind() {
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
      this._onWheel = this._onWheel.bind(this);
      this._onGestureStart = this._onGestureStart.bind(this);
      this._onGestureChange = this._onGestureChange.bind(this);
      this._onGestureEnd = this._onGestureEnd.bind(this);
      this._onKey = this._onKey.bind(this);
      this._onKeyUp = this._onKeyUp.bind(this);
      this._onContext = this._onContext.bind(this);
      this._onDblClick = this._onDblClick.bind(this);

      this.els.canvas.addEventListener('pointerdown', this._onPointerDown);
      this.els.canvas.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
      window.addEventListener('gesturestart', this._onGestureStart, { passive: false, capture: true });
      window.addEventListener('gesturechange', this._onGestureChange, { passive: false, capture: true });
      window.addEventListener('gestureend', this._onGestureEnd, { passive: false, capture: true });
      this.els.canvas.addEventListener('contextmenu', this._onContext);
      this.els.canvas.addEventListener('dblclick', this._onDblClick);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onWinBlur = () => {
        this._spaceDown = false;
        this.els.root.classList.remove('is-space');
        this._pointers.clear();
        this._pinch = null;
        this._gestureActive = false;
        clearTimeout(this._gestureTimer);
      });

      this.els.toolbar.addEventListener('click', (e) => this._onToolbarClick(e));
      this.els.exportMenu.addEventListener('click', (e) => this._onExportClick(e));
      this.els.menu.addEventListener('click', (e) => this._onMenuClick(e));
      this.els.framesDock.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.els.framesDock.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="frames"]')) {
          e.stopPropagation();
          this.els.exportMenu.classList.remove('open');
          this.els.bookmarks.classList.toggle('open');
          if (!this.els.bookmarks.classList.contains('open')) this._hideFrameCatPicker();
          else if (this.els.frameSearch) {
            this.els.frameSearch.focus();
            this.els.frameSearch.select();
          }
        }
      });
      this.els.bookmarks.addEventListener('pointerdown', (e) => e.stopPropagation());
      if (this.els.ytModal) {
        this.els.ytModal.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.els.ytModal.addEventListener('wheel', (e) => {
          if (this.els.ytStage && this.els.ytStage.classList.contains('is-image')) this._onMediaImgWheel(e);
        }, { passive: false });
        this.els.ytModal.addEventListener('dblclick', (e) => {
          if (!e.target.closest('.mm-media-zoom-view')) return;
          e.preventDefault();
          this._resetMediaImgZoom();
        });
        this.els.ytModal.addEventListener('click', (e) => {
          if (e.target.closest('[data-yt-close]')) this._closeYoutube();
          if (e.target.closest('[data-yt-window]')) {
            e.preventDefault();
            if (this._ytVideoId) this._openYtWindow(this._ytVideoId, this._ytCurrentSeconds());
          }
          if (e.target.closest('[data-yt-stamp]')) {
            e.preventDefault();
            this._insertYtTimestamp();
          }
          const seekBtn = e.target.closest('[data-yt-seek]');
          if (seekBtn) {
            e.preventDefault();
            this._seekYoutube(Number(seekBtn.getAttribute('data-yt-seek')));
          }
        });
      }
      if (this.els.mediaNote) {
        this.els.mediaNote.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.els.mediaNote.addEventListener('keydown', (e) => e.stopPropagation());
        this.els.mediaNote.addEventListener('input', () => {
          const n = this._mediaNodeId && this.data.nodes[this._mediaNodeId];
          if (!n || this.readOnly) return;
          n.note = this.els.mediaNote.value;
          this._renderYtStamps();
          this._emit();
        });
        this.els.mediaNote.addEventListener('click', () => {
          if (!this._ytVideoId) return;
          const sec = timestampAtCaret(this.els.mediaNote.value, this.els.mediaNote.selectionStart);
          if (sec != null) this._seekYoutube(sec);
        });
      }
      this.els.bookmarks.addEventListener('click', (e) => this._onFramesMenuClick(e));
      this._bindFramesMenuDnD();
      this.els.bookmarks.addEventListener('contextmenu', (e) => this._onFramesMenuContext(e));
      if (this.els.frameSearch) {
        this.els.frameSearch.addEventListener('input', () => {
          this._frameQuery = this.els.frameSearch.value;
          this._renderBookmarks();
        });
        this.els.frameSearch.addEventListener('keydown', (e) => e.stopPropagation());
        this.els.frameSearch.addEventListener('pointerdown', (e) => e.stopPropagation());
      }
      document.addEventListener('fullscreenchange', this._onFs = () => this._syncFullscreenBtn());
      document.addEventListener('webkitfullscreenchange', this._onFs);

      this._canvasSize = { w: this.els.canvas.clientWidth, h: this.els.canvas.clientHeight };
      this._onCanvasResize = () => {
        const canvas = this.els.canvas;
        const vw = canvas.clientWidth || 0;
        const vh = canvas.clientHeight || 0;
        const prev = this._canvasSize || { w: 0, h: 0 };
        if (prev.w > 0 && prev.h > 0 && (prev.w !== vw || prev.h !== vh) && this.data && this.data.viewport) {
          const vp = this.data.viewport;
          const cx = (prev.w / 2 - vp.x) / vp.zoom;
          const cy = (prev.h / 2 - vp.y) / vp.zoom;
          vp.x = vw / 2 - cx * vp.zoom;
          vp.y = vh / 2 - cy * vp.zoom;
          this._applyTransform();
        }
        this._canvasSize = { w: vw, h: vh };
      };
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._onCanvasResize());
        this._ro.observe(this.els.canvas);
      }
      window.addEventListener('resize', this._onCanvasResize);

      document.addEventListener('mousedown', this._onDocDown = (e) => {
        const inColor = this._isColorUi(e.target);
        const inMenu = this.els.menu.contains(e.target);
        if (inColor || inMenu) {
          /* keep open while using the palette or context menu */
        } else if (this._colorPicking && Date.now() - (this._colorPickAt || 0) < 700) {
          /* native color picker click lands outside the menu */
        } else {
          this._closeMenu();
          this._closeColorDrops();
        }
        if (!this.els.exportMenu.contains(e.target) && !e.target.closest('[data-act="export"]')) {
          this.els.exportMenu.classList.remove('open');
        }
        if (this.els.catPick && this.els.catPick.contains(e.target)) return;
        if (!this.els.framesDock.contains(e.target)) {
          this.els.bookmarks.classList.remove('open');
          this._hideFrameCatPicker();
        } else if (!(this.els.catPick && this.els.catPick.contains(e.target))) {
          this._hideFrameCatPicker();
        }
      });
    }

    destroy() {
      this._destroyed = true;
      this._teardownTextEditor();
      this._closeYoutube();
      this._clearLockHold();
      this.els.canvas.removeEventListener('pointerdown', this._onPointerDown);
      this.els.canvas.removeEventListener('wheel', this._onWheel, { capture: true });
      window.removeEventListener('gesturestart', this._onGestureStart, { capture: true });
      window.removeEventListener('gesturechange', this._onGestureChange, { capture: true });
      window.removeEventListener('gestureend', this._onGestureEnd, { capture: true });
      clearTimeout(this._gestureTimer);
      this.els.canvas.removeEventListener('contextmenu', this._onContext);
      this.els.canvas.removeEventListener('dblclick', this._onDblClick);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      if (this._zoomRaf) cancelAnimationFrame(this._zoomRaf);
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onWinBlur);
      document.removeEventListener('mousedown', this._onDocDown);
      document.removeEventListener('fullscreenchange', this._onFs);
      document.removeEventListener('webkitfullscreenchange', this._onFs);
      window.removeEventListener('resize', this._onCanvasResize);
      if (this._ro) this._ro.disconnect();
      this._hideFrameCatPicker();
      this.container.innerHTML = '';
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      this.els.root.classList.toggle('is-readonly', this.readOnly);
      this.render();
    }

    load(data) {
      this.data = normalizeData(clone(data));
      this.selectOnly(this.data.rootIds[0] || null);
      this.editingId = null;
      this._teardownTextEditor();
      this._suppressChange = true;
      this.render();
      this._syncSizes();
      if (!this.data.viewport || (this.data.viewport.x === 0 && this.data.viewport.y === 0 && (this.data.viewport.zoom === 1 || this.data.viewport.zoom === 0.55))) {
        this.fitView(false);
      } else {
        this._applyTransform();
      }
      this._suppressChange = false;
      this._undoStack = [];
      this._redoStack = [];
      this._captureSnap();
      this._updateHistoryButtons();
    }

    loadFromHtml(html) {
      const data = parseHtml(html) || createEmpty();
      this.load(data);
    }

    getData() {
      return this.data;
    }

    serializeToHtml() {
      return serializeToHtml(this.data);
    }

    // opts.returnHtml: give back the page instead of downloading it (folder export).
    async exportStandalone(filename, opts) {
      const first = this.data.rootIds && this.data.nodes[this.data.rootIds[0]];
      const title = (stripTags(first && first.content) || 'Mindmap').slice(0, 80);
      const json = JSON.stringify(this.data, null, 2).replace(/</g, '\\u003c');
      const html = await buildStandaloneHtml({
        kind: 'mindmap',
        title,
        dataId: 'mindmap-data',
        json,
        cssUrls: ['/mindmap/engine.css'],
        jsUrls: ['/mindmap/engine.js', '/mindmap/export.js'],
      });
      const name = filename || safeStandaloneName(title, 'mindmap');
      if (opts && opts.returnHtml) return html;
      downloadStandalone(html, name);
    }

    _histKey(data) {
      const nodes = data.nodes || {};
      const slim = {};
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        if (!n) return;
        const c = n.content;
        // Long content (image data URLs, big code cells) is hashed to keep
        // the key small; every other field is kept so no edit goes unseen.
        if (typeof c === 'string' && c.length > 160) {
          slim[id] = Object.assign({}, n, { content: c.length + ':' + hashString(c) });
        } else slim[id] = n;
      });
      return JSON.stringify({
        rootIds: data.rootIds,
        nodes: slim,
        frames: data.frames,
        frameCats: data.frameCats,
        links: data.links,
      });
    }

    _captureSnap() {
      this._lastSnap = JSON.stringify({
        data: this.data,
        selectedId: this.selectedId,
        selectedIds: [...this.selectedIds],
        selectedFrameId: this.selectedFrameId,
      });
      this._lastHistKey = this._histKey(this.data);
    }

    _updateHistoryButtons() {
      const u = this.els.toolbar.querySelector('[data-act="undo"]');
      const r = this.els.toolbar.querySelector('[data-act="redo"]');
      if (u) u.disabled = this.readOnly || !this._undoStack.length;
      if (r) r.disabled = this.readOnly || !this._redoStack.length;
    }

    _recordHistory() {
      const key = this._histKey(this.data);
      if (key === this._lastHistKey) return;
      const snap = JSON.stringify({
        data: this.data,
        selectedId: this.selectedId,
        selectedIds: [...this.selectedIds],
        selectedFrameId: this.selectedFrameId,
      });
      if (this._lastSnap) {
        this._undoStack.push(this._lastSnap);
        if (this._undoStack.length > 80) this._undoStack.shift();
        this._redoStack = [];
      }
      this._lastSnap = snap;
      this._lastHistKey = key;
      this._updateHistoryButtons();
    }

    _applySnap(snap) {
      const parsed = JSON.parse(snap);
      this._historyIgnore = true;
      this.editingId = null;
      this._teardownTextEditor();
      this.els.formatBar.classList.remove('open');
      this.data = normalizeData(parsed.data);
      this.selectedId = parsed.selectedId;
      this.selectedIds = new Set(parsed.selectedIds || (parsed.selectedId ? [parsed.selectedId] : []));
      this.selectedFrameId = parsed.selectedFrameId;
      this.render();
      this._historyIgnore = false;
      this._lastSnap = snap;
      this._lastHistKey = this._histKey(this.data);
      this._updateHistoryButtons();
      if (typeof this.opts.onChange === 'function') this.opts.onChange(this.data);
    }

    undo() {
      if (this.readOnly || !this._undoStack.length) return;
      if (this._lastSnap) this._redoStack.push(this._lastSnap);
      this._applySnap(this._undoStack.pop());
    }

    redo() {
      if (this.readOnly || !this._redoStack.length) return;
      if (this._lastSnap) this._undoStack.push(this._lastSnap);
      this._applySnap(this._redoStack.pop());
    }

    _emit() {
      if (this._suppressChange || this.readOnly) return;
      if (!this._historyIgnore) this._recordHistory();
      if (typeof this.opts.onChange === 'function') this.opts.onChange(this.data);
    }

    // Mark the document changed mid-edit; history is recorded on commit.
    _emitLive() {
      if (this._suppressChange || this.readOnly) return;
      if (typeof this.opts.onChange === 'function') this.opts.onChange(this.data);
    }

    nodesArr() {
      return Object.values(this.data.nodes);
    }

    selectOnly(id) {
      this.selectedId = id || null;
      this.selectedIds = new Set(id ? [id] : []);
      this.selectedFrameId = null;
      this.selectedLinkId = null;
    }

    selectedList() {
      const out = [];
      this.selectedIds.forEach((id) => {
        if (this.data.nodes[id] && !this.hiddenByCollapse(id)) out.push(id);
      });
      return out;
    }

    _selectionNodes() {
      return this.selectedList().map((id) => this.data.nodes[id]).filter(Boolean);
    }

    _selectionRoots() {
      const set = new Set(this.selectedList());
      return [...set].filter((id) => {
        let p = this.data.nodes[id] && this.data.nodes[id].parentId;
        while (p) {
          if (set.has(p)) return false;
          p = this.data.nodes[p] && this.data.nodes[p].parentId;
        }
        return !!this.data.nodes[id];
      });
    }

    _runBatch(fn) {
      const was = this._batching;
      const wasSuppressed = this._suppressChange;
      this._batching = true;
      this._suppressChange = true;
      try { fn(); } finally {
        this._batching = was;
        this._suppressChange = wasSuppressed;
      }
    }

    _applyToSelected(fn) {
      if (this.readOnly) return;
      const ids = this.selectedList();
      if (!ids.length) return;
      this._runBatch(() => {
        ids.forEach((id) => {
          const n = this.data.nodes[id];
          if (n) fn(id, n);
        });
      });
      this.render();
      this._emit();
      requestAnimationFrame(() => { if (!this._destroyed) this._syncSizes(); });
    }

    _pruneHiddenSelection() {
      [...this.selectedIds].forEach((id) => {
        if (!this.data.nodes[id] || this.hiddenByCollapse(id)) this.selectedIds.delete(id);
      });
      if (this.selectedId && !this.selectedIds.has(this.selectedId)) {
        this.selectedId = this.selectedList()[0] || null;
      }
    }

    childrenOf(id, dir) {
      return this.nodesArr()
        .filter((n) => n.parentId === id && (!dir || n.dir === dir))
        .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
    }

    descendants(id, includeSelf) {
      const out = [];
      const walk = (nid, self) => {
        if (self) out.push(this.data.nodes[nid]);
        this.childrenOf(nid).forEach((c) => walk(c.id, true));
      };
      walk(id, includeSelf);
      return out.filter(Boolean);
    }

    immediateCount(id, dir) {
      return this.childrenOf(id, dir).length;
    }

    treeRoot(id) {
      let n = this.data.nodes[id];
      while (n && n.parentId) n = this.data.nodes[n.parentId];
      return n;
    }

    isRoot(id) {
      const n = this.data.nodes[id];
      return n && !n.parentId;
    }

    screenToWorld(clientX, clientY) {
      const rect = this.els.canvas.getBoundingClientRect();
      const vp = this.data.viewport;
      return {
        x: (clientX - rect.left - vp.x) / vp.zoom,
        y: (clientY - rect.top - vp.y) / vp.zoom,
      };
    }

    _applyTransform() {
      const vp = this.data.viewport;
      this.els.world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
      this.els.canvas.style.setProperty('--z', String(vp.zoom));
      // Grid spacing on screen: 64/256 world units, stepped up 4x whenever
      // the fine lines would sit closer than 16px. Sub-16px 1px lines at
      // fractional positions shimmer (flicker) while zooming far out.
      let minor = 64 * vp.zoom;
      while (minor < 16) minor *= 4;
      this.els.canvas.style.setProperty('--grid-minor', minor + 'px');
      this.els.root.classList.toggle('is-gpu-world', vp.zoom >= GPU_WORLD_MIN_ZOOM);
      this.els.canvas.style.setProperty('--grid-major', minor * 4 + 'px');
      this.els.canvas.style.setProperty('--px', vp.x + 'px');
      this.els.canvas.style.setProperty('--py', vp.y + 'px');
      this.els.zoomLabel.textContent = Math.round(vp.zoom * 100) + '%';
    }

    setZoom(next, sx, sy) {
      this._setZoomAt(next, sx, sy);
      this._scheduleVpEmit();
    }

    _setZoomAt(next, sx, sy) {
      const vp = this.data.viewport;
      const rect = this.els.canvas.getBoundingClientRect();
      const cx = sx == null ? rect.width / 2 : sx;
      const cy = sy == null ? rect.height / 2 : sy;
      const wx = (cx - vp.x) / vp.zoom;
      const wy = (cy - vp.y) / vp.zoom;
      vp.zoom = clamp(next, 0.08, 2.6);
      vp.x = cx - wx * vp.zoom;
      vp.y = cy - wy * vp.zoom;
      this._applyTransform();
    }

    _scheduleVpEmit() {
      /* pan/zoom stays in memory; it is not a document edit */
    }

    fitView(emit) {
      const b = this.contentBounds();
      const pad = 180;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const worldW = Math.max(b.w + pad * 2, vw / 0.5, 3200);
      const worldH = Math.max(b.h + pad * 2, vh / 0.5, 2200);
      const zoom = clamp(Math.min(vw / worldW, vh / worldH), 0.08, 0.7);
      this.data.viewport.zoom = zoom;
      this.data.viewport.x = vw / 2 - (b.x + b.w / 2) * zoom;
      this.data.viewport.y = vh / 2 - (b.y + b.h / 2) * zoom;
      this._applyTransform();
      if (emit !== false) this._emit();
    }

    _nodeOverlapsFrame(n, f) {
      return n.x < f.x + f.w && n.x + n.w > f.x && n.y < f.y + f.h && n.y + n.h > f.y;
    }

    _lockingFrame(n) {
      if (!n) return null;
      const frames = this.data.frames || [];
      const byId = n.frameId ? frames.find((f) => f.id === n.frameId) : null;
      if (byId && byId.locked) return byId;
      const hit = this._frameAtWorld(n.x + (n.w || 0) / 2, n.y + (n.h || 0) / 2);
      return (hit && hit.locked) ? hit : null;
    }

    isNodeLocked(nOrId) {
      const n = typeof nOrId === 'string' ? this.data.nodes[nOrId] : nOrId;
      if (!n) return false;
      if (n.locked) return true;
      return !!this._lockingFrame(n);
    }

    _assignNodeFrame(n) {
      if (!n) return;
      const f = this._frameAtWorld(n.x + n.w / 2, n.y + n.h / 2);
      if (f && f.locked && n.frameId !== f.id) return;
      n.frameId = f ? f.id : null;
    }

    _nodesCarriedByFrame(f) {
      const live = new Set((this.data.frames || []).map((fr) => fr.id));
      const seen = new Set();
      const out = [];
      const take = (n) => {
        if (!n || seen.has(n.id)) return;
        const ownedByOther = n.frameId && live.has(n.frameId) && n.frameId !== f.id;
        if (ownedByOther) return;
        seen.add(n.id);
        out.push({ id: n.id, x: n.x, y: n.y });
      };
      this.nodesArr().forEach((n) => {
        if (this.hiddenByCollapse(n.id)) return;
        if (n.frameId && live.has(n.frameId)) {
          // Take descendants too: collapsed ones are skipped by the
          // hiddenByCollapse check above and would otherwise stay behind.
          if (n.frameId === f.id) this.descendants(n.id, true).forEach((d) => take(d));
          return;
        }
        if (this._nodeOverlapsFrame(n, f)) {
          this.descendants(n.id, true).forEach((d) => take(d));
        }
      });
      return out;
    }

    _startFrameMove(f, w, e) {
      if (!f || f.locked) return;
      this.selectOnly(null);
      this.selectedFrameId = f.id;
      this._drag = {
        kind: 'move-frame',
        id: f.id,
        x0: w.x,
        y0: w.y,
        cx0: e.clientX,
        cy0: e.clientY,
        fx: f.x,
        fy: f.y,
        origins: this._nodesCarriedByFrame(f),
        moved: false,
      };
      // Nodes join the frame only once it is actually moved (see pointerup).
      this.render();
      try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    focusFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      this.selectOnly(null);
      this.selectedFrameId = id;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const pad = 80;
      const topUi = 78;
      const titleLift = 62;
      const zoom = clamp(Math.min(vw / (f.w + pad * 2), (vh - topUi) / (f.h + pad * 2 + titleLift)), 0.25, 1.6);
      this.data.viewport.zoom = zoom;
      this.data.viewport.x = vw / 2 - (f.x + f.w / 2) * zoom;
      this.data.viewport.y = (vh / 2 + topUi * 0.5) - (f.y + f.h / 2) * zoom;
      const topScreen = (f.y - titleLift) * zoom + this.data.viewport.y;
      if (topScreen < topUi) this.data.viewport.y += topUi - topScreen;
      this._applyTransform();
      this.render();
      this._emit();
    }

    _frameCatList() {
      if (!Array.isArray(this.data.frameCats)) this.data.frameCats = [];
      return this.data.frameCats;
    }

    _sortedFrameCats(parentId) {
      return this._frameCatList()
        .filter((c) => (c.parentId || null) === (parentId || null))
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }

    _flatFrameCats(parentId, depth, out) {
      out = out || [];
      this._sortedFrameCats(parentId).forEach((c) => {
        out.push({ cat: c, depth: depth || 0 });
        this._flatFrameCats(c.id, (depth || 0) + 1, out);
      });
      return out;
    }

    _directFrames(catId) {
      return (this.data.frames || [])
        .filter((f) => (f.categoryId || null) === (catId || null))
        .slice()
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')) || String(a.id).localeCompare(String(b.id)));
    }

    _frameQueryText() {
      return String(this._frameQuery || '').trim().toLowerCase();
    }

    _frameVisible(f, q) {
      if (!q) return true;
      if (String(f.title || 'Frame').toLowerCase().includes(q)) return true;
      let cid = f.categoryId;
      const seen = new Set();
      while (cid && !seen.has(cid)) {
        seen.add(cid);
        const cat = this._frameCatList().find((c) => c.id === cid);
        if (!cat) break;
        if (String(cat.name || '').toLowerCase().includes(q)) return true;
        cid = cat.parentId;
      }
      return false;
    }

    _catHasVisible(c, q) {
      if (!q) return true;
      if (String(c.name || '').toLowerCase().includes(q)) return true;
      if (this._directFrames(c.id).some((f) => this._frameVisible(f, q))) return true;
      return this._sortedFrameCats(c.id).some((k) => this._catHasVisible(k, q));
    }

    _catFrameCount(id) {
      const ids = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        this._frameCatList().forEach((c) => {
          if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
            ids.add(c.id);
            grew = true;
          }
        });
      }
      return (this.data.frames || []).filter((f) => f.categoryId && ids.has(f.categoryId)).length;
    }

    _frameItemHtml(f) {
      return `<button type="button" class="dv-frame-item${this.selectedFrameId === f.id ? ' active' : ''}" data-goto-frame="${escapeAttr(f.id)}" draggable="true">${escapeHtml(f.title || 'Frame')}</button>`;
    }

    _catTreeHtml(c, depth) {
      const q = this._frameQueryText();
      const kids = this._sortedFrameCats(c.id).filter((k) => this._catHasVisible(k, q));
      const frames = this._directFrames(c.id).filter((f) => this._frameVisible(f, q));
      const open = !c.collapsed || !!q;
      const count = q ? frames.length + kids.reduce((n, k) => n + this._catFrameCount(k.id), 0) : this._catFrameCount(c.id);
      let body = '';
      if (open) {
        body = kids.map((k) => this._catTreeHtml(k, depth + 1)).join('') + frames.map((f) => this._frameItemHtml(f)).join('');
        if (!kids.length && !frames.length) body = q ? '' : '<div class="dv-fcat-empty">Drop a frame here</div>';
      }
      const ro = this.readOnly;
      return `<div class="dv-fcat" style="--d:${depth}">
        <div class="dv-fcat-head${c.collapsed ? ' is-collapsed' : ''}" data-cat-toggle="${escapeAttr(c.id)}" data-cat-drop="${escapeAttr(c.id)}">
          <span class="dv-fcat-twist">${c.collapsed ? '▸' : '▾'}</span>
          <span class="dv-fcat-label">${escapeHtml(c.name)}</span>
          <span class="dv-fcat-count">${count}</span>
          ${ro || depth >= 6 ? '' : `<button type="button" class="dv-fcat-act" data-cat-add-child="${escapeAttr(c.id)}" title="New subcategory">＋</button>`}
          ${ro ? '' : `<button type="button" class="dv-fcat-act" data-cat-rename="${escapeAttr(c.id)}" title="Rename category">✎</button>`}
          ${ro ? '' : `<button type="button" class="dv-fcat-act" data-cat-delete="${escapeAttr(c.id)}" title="Delete category">✕</button>`}
        </div>
        ${open ? `<div class="dv-fcat-body">${body}</div>` : ''}
      </div>`;
    }

    _renderBookmarks() {
      const box = this.els.bookmarks;
      const list = this.els.frameList || box;
      const btn = this.els.framesBtn;
      const dock = this.els.framesDock;
      if (!box || !list || !dock) return;
      const frames = this.data.frames || [];
      const cats = this._frameCatList();
      const q = this._frameQueryText();
      dock.hidden = !frames.length && !cats.length;
      if (!frames.length && !cats.length) {
        box.classList.remove('open');
        list.innerHTML = '';
        if (btn) btn.textContent = 'Frames';
        return;
      }
      const current = frames.find((f) => f.id === this.selectedFrameId);
      if (btn) btn.textContent = current ? (current.title || 'Frame') : 'Frames';
      if (this.els.frameSearch && this.els.frameSearch.value !== (this._frameQuery || '')) {
        this.els.frameSearch.value = this._frameQuery || '';
      }
      const uncat = this._directFrames(null).filter((f) => this._frameVisible(f, q));
      const tree = this._sortedFrameCats(null).filter((c) => this._catHasVisible(c, q)).map((c) => this._catTreeHtml(c, 0)).join('');
      const visible = frames.filter((f) => this._frameVisible(f, q));
      const flat = visible.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')) || String(a.id).localeCompare(String(b.id))).map((f) => this._frameItemHtml(f)).join('');
      if (q && !visible.length && !tree) {
        list.innerHTML = '<div class="dv-fcat-empty">No frames match</div>';
        return;
      }
      list.innerHTML = [
        this.readOnly || q ? '' : '<button type="button" class="dv-fcat-new" data-cat-add>＋ Category</button>',
        tree,
        cats.length
          ? (uncat.length || !q ? `<div class="dv-fcat-head dv-fcat-uncat" data-cat-drop="">Uncategorized<span class="dv-fcat-count">${uncat.length}</span></div>${uncat.map((f) => this._frameItemHtml(f)).join('')}` : '')
          : flat,
      ].join('');
    }

    _startCatNameEdit(opts) {
      const box = this.els.frameList || this.els.bookmarks;
      if (!box || this.readOnly) return;
      const existing = box.querySelector('.dv-fcat-edit');
      if (existing) existing.remove();
      const row = document.createElement('div');
      row.className = 'dv-fcat-edit';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 60;
      const renameId = opts && opts.renameId;
      const parentId = opts && opts.parentId;
      const cat = renameId && this._frameCatList().find((c) => c.id === renameId);
      input.value = cat ? cat.name : '';
      input.placeholder = renameId ? 'Category name' : (parentId ? 'Subcategory name' : 'Category name');
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        row.remove();
        if (!name) return;
        if (renameId) this._renameFrameCat(renameId, name);
        else this._addFrameCat(name, parentId || null, opts && opts.assignFrameId);
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); done = true; row.remove(); }
      });
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('blur', () => { if (document.body.contains(row)) commit(); });
      row.appendChild(input);
      box.insertBefore(row, box.firstChild);
      input.focus();
      input.select();
    }

    _addFrameCat(name, parentId, assignFrameId) {
      if (this.readOnly) return;
      const trimmed = String(name || '').trim().slice(0, 60);
      if (!trimmed) return;
      const parent = parentId && this._frameCatList().find((c) => c.id === parentId);
      const id = uid('fc_');
      this._frameCatList().push({
        id,
        name: trimmed,
        parentId: parent ? parent.id : null,
        collapsed: false,
      });
      if (assignFrameId) {
        const f = (this.data.frames || []).find((x) => x.id === assignFrameId);
        if (f) f.categoryId = id;
      }
      this._renderBookmarks();
      this._emit();
    }

    _renameFrameCat(id, name) {
      if (this.readOnly) return;
      const cat = this._frameCatList().find((c) => c.id === id);
      const trimmed = String(name || '').trim().slice(0, 60);
      if (!cat || !trimmed || cat.name === trimmed) return;
      cat.name = trimmed;
      this._renderBookmarks();
      this._emit();
    }

    _deleteFrameCat(id) {
      if (this.readOnly) return;
      const cat = this._frameCatList().find((c) => c.id === id);
      if (!cat) return;
      if (!confirm('Remove “' + cat.name + '”? Frames move to the parent category.')) return;
      const parentId = cat.parentId || null;
      this._frameCatList().forEach((c) => {
        if (c.parentId === id) c.parentId = parentId;
      });
      (this.data.frames || []).forEach((f) => {
        if (f.categoryId === id) f.categoryId = parentId;
      });
      this.data.frameCats = this._frameCatList().filter((c) => c.id !== id);
      this._renderBookmarks();
      this._emit();
    }

    _toggleFrameCat(id) {
      const cat = this._frameCatList().find((c) => c.id === id);
      if (!cat) return;
      this._historyIgnore = true;
      cat.collapsed = !cat.collapsed;
      this._renderBookmarks();
      this._emit();
      this._historyIgnore = false;
    }

    _assignFrameCat(frameId, categoryId) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((x) => x.id === frameId);
      if (!f) return;
      const next = categoryId && this._frameCatList().some((c) => c.id === categoryId) ? categoryId : null;
      if ((f.categoryId || null) === next) return;
      f.categoryId = next;
      this._renderBookmarks();
      this._emit();
    }

    _onFramesMenuClick(e) {
      this._hideFrameCatPicker();
      const add = e.target.closest('[data-cat-add]');
      if (add) { e.stopPropagation(); this._startCatNameEdit({}); return; }
      const child = e.target.closest('[data-cat-add-child]');
      if (child) { e.stopPropagation(); this._startCatNameEdit({ parentId: child.getAttribute('data-cat-add-child') }); return; }
      const ren = e.target.closest('[data-cat-rename]');
      if (ren) { e.stopPropagation(); this._startCatNameEdit({ renameId: ren.getAttribute('data-cat-rename') }); return; }
      const del = e.target.closest('[data-cat-delete]');
      if (del) { e.stopPropagation(); this._deleteFrameCat(del.getAttribute('data-cat-delete')); return; }
      if (e.target.closest('.dv-fcat-act')) { e.stopPropagation(); return; }
      const tog = e.target.closest('[data-cat-toggle]');
      if (tog) { e.stopPropagation(); this._toggleFrameCat(tog.getAttribute('data-cat-toggle')); return; }
      const btn = e.target.closest('[data-goto-frame]');
      if (!btn) return;
      this.focusFrame(btn.getAttribute('data-goto-frame'));
      this.els.bookmarks.classList.remove('open');
    }

    _onFramesMenuContext(e) {
      const btn = e.target.closest('[data-goto-frame]');
      if (!btn || this.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      this._openFrameCatPicker(btn.getAttribute('data-goto-frame'), e.clientX, e.clientY);
    }

    _ensureCatPick() {
      if (this.els.catPick) return this.els.catPick;
      const el = document.createElement('div');
      el.className = 'dv-fcat-pick';
      el.hidden = true;
      this.els.root.appendChild(el);
      this.els.catPick = el;
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        const make = e.target.closest('[data-pick-new]');
        if (make) {
          const frameId = this._pickFrameId;
          this._hideFrameCatPicker();
          if (this.els.bookmarks) this.els.bookmarks.classList.add('open');
          this._startCatNameEdit({ assignFrameId: frameId });
          return;
        }
        const pick = e.target.closest('[data-pick-cat]');
        if (!pick || !this._pickFrameId) return;
        this._assignFrameCat(this._pickFrameId, pick.getAttribute('data-pick-cat') || null);
        this._hideFrameCatPicker();
      });
      return el;
    }

    _openFrameCatPicker(frameId, x, y) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((fr) => fr.id === frameId);
      if (!f) return;
      this._pickFrameId = frameId;
      const el = this._ensureCatPick();
      const cats = this._flatFrameCats(null, 0);
      el.innerHTML = [
        `<div class="dv-fcat-pick-label">Add to category</div>`,
        `<button type="button" data-pick-cat="" class="${f.categoryId ? '' : 'active'}">Uncategorized</button>`,
        cats.map(({ cat, depth }) => (
          `<button type="button" data-pick-cat="${escapeAttr(cat.id)}" class="${f.categoryId === cat.id ? 'active' : ''}" style="padding-left:${10 + depth * 14}px">${escapeHtml(cat.name)}</button>`
        )).join(''),
        `<button type="button" class="dv-fcat-pick-new" data-pick-new>＋ New category…</button>`,
      ].join('');
      el.hidden = false;
      el.style.left = '0px';
      el.style.top = '0px';
      const w = el.offsetWidth || 200;
      const h = el.offsetHeight || 160;
      el.style.left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)) + 'px';
      el.style.top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)) + 'px';
    }

    _hideFrameCatPicker() {
      if (this.els.catPick) this.els.catPick.hidden = true;
      this._pickFrameId = null;
    }

    _bindFramesMenuDnD() {
      const box = this.els.bookmarks;
      if (!box) return;
      box.addEventListener('dragstart', (e) => {
        const btn = e.target.closest('[data-goto-frame]');
        if (!btn) return;
        e.dataTransfer.setData('text/frame-id', btn.getAttribute('data-goto-frame'));
        e.dataTransfer.effectAllowed = 'move';
        btn.classList.add('dragging');
      });
      box.addEventListener('dragend', (e) => {
        const btn = e.target.closest('[data-goto-frame]');
        if (btn) btn.classList.remove('dragging');
        box.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
      });
      box.addEventListener('dragover', (e) => {
        const zone = e.target.closest('[data-cat-drop]');
        if (!zone) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.classList.add('drop-target');
      });
      box.addEventListener('dragleave', (e) => {
        const zone = e.target.closest('[data-cat-drop]');
        if (zone) zone.classList.remove('drop-target');
      });
      box.addEventListener('drop', (e) => {
        const zone = e.target.closest('[data-cat-drop]');
        if (!zone) return;
        e.preventDefault();
        zone.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/frame-id');
        if (id) this._assignFrameCat(id, zone.getAttribute('data-cat-drop') || null);
      });
    }

    toggleFullscreen() {
      const el = this.els.root;
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).catch(() => {});
    }

    _syncFullscreenBtn() {
      const btn = this.els.toolbar && this.els.toolbar.querySelector('[data-act="fullscreen"]');
      if (btn) {
        const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
        btn.textContent = on ? 'Exit full' : 'Fullscreen';
        btn.classList.toggle('active', on);
        this.els.root.classList.toggle('is-fullscreen', on);
      }
      requestAnimationFrame(() => { if (!this._destroyed && this._onCanvasResize) this._onCanvasResize(); });
    }

    contentBounds() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this.nodesArr().forEach((n) => {
        if (this.hiddenByCollapse(n.id)) return;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
      });
      (this.data.frames || []).forEach((f) => {
        minX = Math.min(minX, f.x);
        minY = Math.min(minY, f.y);
        maxX = Math.max(maxX, f.x + f.w);
        maxY = Math.max(maxY, f.y + f.h);
      });
      if (!isFinite(minX)) return { x: 0, y: 0, w: 400, h: 300 };
      const pad = 24;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }

    layoutAll() {
      this.data.rootIds.forEach((id) => {
        const n = this.data.nodes[id];
        if (n) this._place(this._measure(n), n.x, n.y);
      });
    }

    _measure(node) {
      const nw = Math.max(node.w || 120, 80);
      const nh = Math.max(node.h || 40, 32);
      const sub = {};
      DIRS.forEach((dir) => {
        const collapsed = node.collapsedDirs && node.collapsedDirs[dir];
        const kids = collapsed ? [] : this.childrenOf(node.id, dir);
        const items = kids.map((k) => this._measure(k));
        if (dir === 'left' || dir === 'right') {
          sub[dir] = {
            items,
            w: items.length ? H_GAP + Math.max(...items.map((m) => m.w)) : 0,
            h: items.length ? items.reduce((s, m) => s + m.h, 0) + S_GAP * (items.length - 1) : 0,
          };
        } else {
          sub[dir] = {
            items,
            w: items.length ? items.reduce((s, m) => s + m.w, 0) + S_GAP * (items.length - 1) : 0,
            h: items.length ? H_GAP + Math.max(...items.map((m) => m.h)) : 0,
          };
        }
      });
      const sideH = Math.max(nh, sub.left.h, sub.right.h);
      const extraAbove = Math.max(0, (sideH - nh) / 2);
      const contentW = Math.max(nw, sub.up.w, sub.down.w);
      const w = sub.left.w + contentW + sub.right.w;
      const h = sub.up.h + sideH + sub.down.h;
      return {
        node, nw, nh, w, h, sub,
        nodeOffX: sub.left.w + (contentW - nw) / 2,
        nodeOffY: sub.up.h + extraAbove,
      };
    }

    _place(m, x, y) {
      const n = m.node;
      n.x = x;
      n.y = y;
      const { sub, nw, nh } = m;
      if (sub.right.items.length) {
        let cy = y + nh / 2 - sub.right.h / 2;
        sub.right.items.forEach((cm) => {
          this._place(cm, x + nw + H_GAP, cy + cm.nodeOffY);
          cy += cm.h + S_GAP;
        });
      }
      if (sub.left.items.length) {
        let cy = y + nh / 2 - sub.left.h / 2;
        sub.left.items.forEach((cm) => {
          this._place(cm, x - H_GAP - cm.nw, cy + cm.nodeOffY);
          cy += cm.h + S_GAP;
        });
      }
      if (sub.down.items.length) {
        let cx = x + nw / 2 - sub.down.w / 2;
        sub.down.items.forEach((cm) => {
          this._place(cm, cx + cm.nodeOffX, y + nh + H_GAP);
          cx += cm.w + S_GAP;
        });
      }
      if (sub.up.items.length) {
        let cx = x + nw / 2 - sub.up.w / 2;
        sub.up.items.forEach((cm) => {
          this._place(cm, cx + cm.nodeOffX, y - H_GAP - cm.nh);
          cx += cm.w + S_GAP;
        });
      }
    }

    inheritProps(parent, dir) {
      const siblings = this.childrenOf(parent.id, dir);
      const source = siblings.length ? siblings[siblings.length - 1] : parent;
      const type = isMediaType(source.type) ? 'text' : (source.type || 'text');
      const style = clone(source.style || defaultStyle());
      style.linkColorManual = false;
      style.fillColorManual = false;
      return {
        type,
        style,
        format: clone(source.format || defaultFormat()),
        language: source.language || 'auto',
      };
    }

    hiddenByCollapse(id) {
      let cur = this.data.nodes[id];
      while (cur && cur.parentId) {
        const p = this.data.nodes[cur.parentId];
        if (!p) return false;
        if (p.collapsedDirs && p.collapsedDirs[cur.dir]) return true;
        cur = p;
      }
      return false;
    }

    _syncLevelLinkColors() {
      this.nodesArr().forEach((n) => {
        if (!n.parentId || !this.data.nodes[n.parentId]) return;
        if (!n.style) n.style = defaultStyle();
        if (!n.style.linkColorManual) {
          n.style.linkColor = colorForLevel(this.data, nodeDepth(this.data.nodes, n.id));
        }
        applyHopFill(this.data, n);
      });
    }

    _rectsOverlap(a, b, pad) {
      const g = pad || 0;
      return a.x < b.x + b.w + g && a.x + a.w + g > b.x && a.y < b.y + b.h + g && a.y + a.h + g > b.y;
    }

    _subtreeBounds(id) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const visit = (nid) => {
        const n = this.data.nodes[nid];
        if (!n) return;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
        this.childrenOf(nid).forEach((c) => {
          if (n.collapsedDirs && n.collapsedDirs[c.dir]) return;
          visit(c.id);
        });
      };
      visit(id);
      if (!isFinite(minX)) {
        const n = this.data.nodes[id];
        return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : { x: 0, y: 0, w: 0, h: 0 };
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    _moveSubtree(id, dx, dy) {
      if (!dx && !dy) return;
      this.descendants(id, true).forEach((n) => {
        n.x += dx;
        n.y += dy;
      });
    }

    _packGap(parent) {
      return parent && !parent.parentId ? ROOT_GAP : H_GAP;
    }

    _clearParentGap(parent, dir, skipPlaced) {
      if (!parent || !dir) return;
      const gap = this._packGap(parent);
      this.childrenOf(parent.id, dir).forEach((k) => {
        if (skipPlaced && k.userPlaced) return;
        const b = this._subtreeBounds(k.id);
        let dx = 0;
        let dy = 0;
        if (dir === 'right') {
          const need = parent.x + parent.w + gap;
          if (b.x < need) dx = need - b.x;
        } else if (dir === 'left') {
          const need = parent.x - gap;
          if (b.x + b.w > need) dx = need - (b.x + b.w);
        } else if (dir === 'down') {
          const need = parent.y + parent.h + gap;
          if (b.y < need) dy = need - b.y;
        } else if (dir === 'up') {
          const need = parent.y - gap;
          if (b.y + b.h > need) dy = need - (b.y + b.h);
        }
        this._moveSubtree(k.id, dx, dy);
      });
    }

    _packSide(parent, dir, skipPlaced, focusId) {
      if (!parent || !dir) return;
      const kids = this.childrenOf(parent.id, dir).slice();
      if (!kids.length) return;
      const horiz = dir === 'right' || dir === 'left';
      const specs = kids.map((k) => ({
        id: k.id,
        b: this._subtreeBounds(k.id),
        skip: !!(skipPlaced && k.userPlaced),
      }));
      specs.sort((a, b) => {
        const da = horiz ? a.b.y : a.b.x;
        const db = horiz ? b.b.y : b.b.x;
        if (da !== db) return da - db;
        return a.id.localeCompare(b.id);
      });
      let focus = focusId ? specs.findIndex((s) => s.id === focusId) : -1;
      if (focus < 0) {
        const pc = horiz ? parent.y + parent.h / 2 : parent.x + parent.w / 2;
        let best = Infinity;
        specs.forEach((s, i) => {
          const c = horiz ? s.b.y + s.b.h / 2 : s.b.x + s.b.w / 2;
          const d = Math.abs(c - pc);
          if (d < best) { best = d; focus = i; }
        });
      }
      const refresh = (s) => { s.b = this._subtreeBounds(s.id); };
      const minP = (s) => horiz ? s.b.y : s.b.x;
      const maxP = (s) => horiz ? s.b.y + s.b.h : s.b.x + s.b.w;
      const shift = (s, delta) => {
        if (!delta || s.skip) return false;
        if (horiz) this._moveSubtree(s.id, 0, delta);
        else this._moveSubtree(s.id, delta, 0);
        refresh(s);
        return true;
      };
      if (focus >= 0) {
        for (let i = focus + 1; i < specs.length; i++) {
          const d = maxP(specs[i - 1]) + S_GAP - minP(specs[i]);
          if (d > 0) shift(specs[i], d);
        }
        for (let i = focus - 1; i >= 0; i--) {
          const d = minP(specs[i + 1]) - S_GAP - maxP(specs[i]);
          if (d < 0) shift(specs[i], d);
        }
      }
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (let i = 1; i < specs.length; i++) {
          const d = maxP(specs[i - 1]) + S_GAP - minP(specs[i]);
          if (d > 0 && shift(specs[i], d)) moved = true;
        }
        for (let i = specs.length - 2; i >= 0; i--) {
          const d = minP(specs[i + 1]) - S_GAP - maxP(specs[i]);
          if (d < 0 && shift(specs[i], d)) moved = true;
        }
        if (!moved) break;
      }
      this._clearParentGap(parent, dir, skipPlaced);
    }

    _spreadAncestors(node) {
      if (!node) return;
      const seen = new Set([node.id]);
      let cur = node;
      while (cur && cur.parentId) {
        const anc = this.data.nodes[cur.parentId];
        const side = cur.dir;
        if (!anc || !side || seen.has(anc.id)) break;
        seen.add(anc.id);
        // Skip user-placed nodes: making room must move the auto-laid-out
        // siblings, never snap a node the user dragged back into line.
        this._packSide(anc, side, true, cur.id);
        cur = anc;
      }
    }

    _balanceSide(parent, dir) {
      if (!parent || !dir) return;
      const kids = this.childrenOf(parent.id, dir).filter((k) => !k.userPlaced);
      if (!kids.length) return;
      const horiz = dir === 'right' || dir === 'left';
      const specs = kids.map((k) => ({ id: k.id, b: this._subtreeBounds(k.id) }));
      const total = specs.reduce((sum, s) => sum + (horiz ? s.b.h : s.b.w), 0)
        + S_GAP * Math.max(0, specs.length - 1);
      const mid = horiz ? parent.y + parent.h / 2 : parent.x + parent.w / 2;
      let cursor = mid - total / 2;
      specs.forEach((s) => {
        if (horiz) this._moveSubtree(s.id, 0, cursor - s.b.y);
        else this._moveSubtree(s.id, cursor - s.b.x, 0);
        cursor += (horiz ? s.b.h : s.b.w) + S_GAP;
      });
      this._clearParentGap(parent, dir, true);
    }

    _slideNodeOnAxis(node, dir) {
      if (!node || !dir || !node.parentId || node.userPlaced) return;
      const kids = this.childrenOf(node.id, dir);
      if (!kids.length) return;
      const horiz = dir === 'right' || dir === 'left';
      let min = Infinity;
      let max = -Infinity;
      kids.forEach((k) => {
        const b = this._subtreeBounds(k.id);
        if (horiz) {
          min = Math.min(min, b.y);
          max = Math.max(max, b.y + b.h);
        } else {
          min = Math.min(min, b.x);
          max = Math.max(max, b.x + b.w);
        }
      });
      if (!isFinite(min)) return;
      const mid = (min + max) / 2;
      let dx = 0;
      let dy = 0;
      if (horiz) dy = mid - (node.y + node.h / 2);
      else dx = mid - (node.x + node.w / 2);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.x += dx;
      node.y += dy;
      this.childrenOf(node.id).forEach((c) => {
        if (c.dir === dir) return;
        this._moveSubtree(c.id, dx, dy);
      });
    }

    _layoutSide(parent, dir) {
      if (!parent || !dir) return;
      this._balanceSide(parent, dir);
      this._packSide(parent, dir, true);
      this._spreadAncestors(parent);
      let tight = this._sideStillTight(parent, dir);
      let walk = parent;
      while (walk && walk.parentId) {
        const side = walk.dir;
        walk = this.data.nodes[walk.parentId];
        if (!walk || !side) break;
        if (this._sideStillTight(walk, side)) tight = true;
      }
      const root = walk && !walk.parentId ? walk : null;
      let packedSide = dir;
      let n = parent;
      while (n && n.parentId) {
        packedSide = n.dir;
        n = this.data.nodes[n.parentId];
      }
      if (!tight || !root) return;
      this._pushSideOut(root, packedSide, 32);
    }

    _sideStillTight(parent, dir) {
      const kids = this.childrenOf(parent.id, dir);
      if (!kids.length) return false;
      const groups = kids.map((k) => this.descendants(k.id, true).filter(Boolean));
      const pad = 8;
      for (let i = 0; i < groups.length; i++) {
        for (const n of groups[i]) {
          if (!n || this.hiddenByCollapse(n.id)) continue;
          if (this._rectsOverlap(n, parent, pad)) return true;
          for (let j = i + 1; j < groups.length; j++) {
            for (const o of groups[j]) {
              if (!o || this.hiddenByCollapse(o.id)) continue;
              if (this._rectsOverlap(n, o, pad)) return true;
            }
          }
        }
      }
      return false;
    }

    _pushSideOut(parent, dir, extra) {
      if (!parent || !dir || extra <= 0) return;
      const dx = dir === 'right' ? extra : dir === 'left' ? -extra : 0;
      const dy = dir === 'down' ? extra : dir === 'up' ? -extra : 0;
      this.childrenOf(parent.id, dir).forEach((k) => {
        if (k.userPlaced) return;
        this._moveSubtree(k.id, dx, dy);
      });
    }

    _snapshotSubtree(id) {
      return this.descendants(id, true).filter(Boolean).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    }

    _applySnapshotDelta(origins, dx, dy) {
      origins.forEach((o) => {
        const n = this.data.nodes[o.id];
        if (n) {
          n.x = o.x + dx;
          n.y = o.y + dy;
        }
      });
    }

    _snapshotSelection() {
      const seen = new Set();
      const origins = [];
      this._selectionRoots().forEach((id) => {
        this._snapshotSubtree(id).forEach((o) => {
          if (!seen.has(o.id)) {
            seen.add(o.id);
            origins.push(o);
          }
        });
      });
      return origins;
    }

    _placeNewChild(parent, dir, id) {
      const n = this.data.nodes[id];
      if (!parent || !n || !dir) return;
      const gap = this._packGap(parent);
      const others = this.childrenOf(parent.id, dir).filter((s) => s.id !== id);
      if (dir === 'right' || dir === 'left') {
        const nx = dir === 'right' ? parent.x + parent.w + gap : parent.x - gap - n.w;
        let ny;
        if (!others.length) ny = parent.y + (parent.h - n.h) / 2;
        else {
          let bottom = -Infinity;
          others.forEach((s) => {
            const b = this._subtreeBounds(s.id);
            bottom = Math.max(bottom, b.y + b.h);
          });
          ny = bottom + S_GAP;
        }
        this._moveSubtree(id, nx - n.x, ny - n.y);
      } else {
        const ny = dir === 'down' ? parent.y + parent.h + gap : parent.y - gap - n.h;
        let nx;
        if (!others.length) nx = parent.x + (parent.w - n.w) / 2;
        else {
          let right = -Infinity;
          others.forEach((s) => {
            const b = this._subtreeBounds(s.id);
            right = Math.max(right, b.x + b.w);
          });
          nx = right + S_GAP;
        }
        this._moveSubtree(id, nx - n.x, ny - n.y);
      }
      this._nudgeNodeClear(parent, dir, id);
    }

    _nudgeNodeClear(parent, dir, id) {
      const n = this.data.nodes[id];
      if (!parent || !n || !dir) return;
      const self = new Set(this.descendants(id, true).map((x) => x && x.id).filter(Boolean));
      const pad = 10;
      const step = dir === 'right' || dir === 'left' ? { dx: 0, dy: 20 } : { dx: 20, dy: 0 };
      for (let i = 0; i < 24; i++) {
        let hit = false;
        outer: for (const a of this.descendants(id, true)) {
          if (!a || this.hiddenByCollapse(a.id)) continue;
          if (this._rectsOverlap(a, parent, pad)) { hit = true; break; }
          for (const o of this.nodesArr()) {
            if (!o || self.has(o.id) || this.hiddenByCollapse(o.id)) continue;
            if (o.parentId === parent.id && o.dir && o.dir !== dir) continue;
            if (this._rectsOverlap(a, o, pad)) { hit = true; break outer; }
          }
        }
        if (!hit) return;
        this._moveSubtree(id, step.dx, step.dy);
      }
    }

    addChild(parentId, dir, extra) {
      if (this.readOnly) return null;
      const parent = this.data.nodes[parentId];
      if (!parent || this.isNodeLocked(parent)) return null;
      if (parent.collapsedDirs && parent.collapsedDirs[dir]) return null;
      const inh = this.inheritProps(parent, dir);
      const id = uid('n_');
      const gap = this._packGap(parent);
      const node = Object.assign({
        id,
        parentId,
        dir,
        content: extra && extra.content != null ? extra.content : '',
        label: '',
        language: inh.language,
        type: (extra && extra.type) || inh.type,
        style: inh.style,
        format: inh.format,
        collapsedDirs: defaultCollapsed(),
        w: CELL_W,
        h: CELL_H,
        x: dir === 'right' ? parent.x + parent.w + gap
          : dir === 'left' ? parent.x - gap - CELL_W
          : parent.x + Math.max(0, (parent.w - CELL_W) / 2),
        y: dir === 'down' ? parent.y + parent.h + gap
          : dir === 'up' ? parent.y - gap - CELL_H
          : parent.y,
        userSized: false,
        order: this.childrenOf(parentId, dir).length,
        frameId: parent.frameId || null,
        locked: false,
        note: '',
        noteOpen: false,
      }, extra || {});
      node.id = id;
      node.parentId = parentId;
      node.dir = dir;
      node.locked = false;
      if (!node.style) node.style = defaultStyle();
      this.data.nodes[id] = node;
      if (!node.style.linkColorManual) {
        node.style.linkColorManual = false;
        node.style.linkColor = colorForLevel(this.data, nodeDepth(this.data.nodes, node.id));
      }
      applyHopFill(this.data, node);
      this._placeNewChild(parent, dir, id);
      this._layoutSide(parent, dir);
      this.selectOnly(id);
      this.render();
      requestAnimationFrame(() => {
        if (this._destroyed || !this.data.nodes[id]) return;
        this._syncSizes({ preserveLayout: true });
        const p = this.data.nodes[parentId];
        if (p && this.data.nodes[id]) this._layoutSide(p, dir);
        this.render();
        this._emit();
      });
      this._emit();
      return node;
    }

    addRootAt(x, y) {
      if (this.readOnly) return null;
      const id = uid('n_');
      const node = {
        id,
        parentId: null,
        dir: null,
        type: 'text',
        content: '',
        label: '',
        language: 'auto',
        style: rootStyle(this.data.rootIds.map((rid) => {
          const r = this.data.nodes[rid];
          return r && r.style && r.style.fill;
        }).filter(Boolean)),
        format: { bold: true, italic: false, underline: false, fontSize: FONT_SIZE_DEFAULT, align: 'center', fontFamily: 'sans' },
        collapsedDirs: defaultCollapsed(),
        w: ROOT_W,
        h: ROOT_H,
        x: x || 0,
        y: y || 0,
        userSized: false,
        userPlaced: false,
        locked: false,
        note: '',
        noteOpen: false,
      };
      this.data.nodes[id] = node;
      this._assignNodeFrame(node);
      this.data.rootIds.push(id);
      this.selectOnly(id);
      this.render();
      this._emit();
      return node;
    }

    addNewRoot() {
      if (this.readOnly) return null;
      const w = 160;
      const h = 52;
      const pos = this._findFreeRootRect(w, h);
      const node = this.addRootAt(pos.x, pos.y);
      if (!node) return null;
      this._centerOnRect(node);
      this.startEdit(node.id);
      return node;
    }

    _centerOnRect(r) {
      if (!r) return;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const z = this.data.viewport.zoom || 1;
      this.data.viewport.x = vw / 2 - (r.x + r.w / 2) * z;
      this.data.viewport.y = vh / 2 - (r.y + r.h / 2) * z;
      this._applyTransform();
      this._emit();
    }

    _rootRectHitsOccupied(rect, skipId) {
      const pad = 36;
      const frames = this.data.frames || [];
      if (frames.some((f) => this._rectsOverlap(rect, { x: f.x, y: f.y - 52, w: f.w, h: f.h + 52 }, pad))) return true;
      return this.nodesArr().some((n) => {
        if (!n || n.id === skipId || this.hiddenByCollapse(n.id)) return false;
        return this._rectsOverlap(rect, n, 28);
      });
    }

    _findFreeRootRect(w, h) {
      const vp = this.data.viewport;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const cx = (vw / 2 - vp.x) / vp.zoom;
      const cy = (vh / 2 - vp.y) / vp.zoom;
      const at = (px, py) => ({ x: px - w / 2, y: py - h / 2, w, h });
      const first = at(cx, cy);
      if (!this._rootRectHitsOccupied(first)) return first;
      const step = 96;
      for (let ring = 1; ring <= 28; ring++) {
        const r = ring * step;
        const count = 8 + ring * 4;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          const cand = at(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          if (!this._rootRectHitsOccupied(cand)) return cand;
        }
      }
      const b = this.contentBounds();
      const frames = this.data.frames || [];
      let right = b.x + b.w;
      frames.forEach((f) => { right = Math.max(right, f.x + f.w); });
      return { x: right + 80, y: b.y, w, h };
    }

    deleteNode(id) {
      if (this.readOnly) return;
      const node = this.data.nodes[id];
      if (!node) return;
      if (this.descendants(id, true).some((n) => this.isNodeLocked(n))) return;
      const ids = this.descendants(id, true).map((n) => n.id);
      ids.forEach((nid) => delete this.data.nodes[nid]);
      this.data.rootIds = this.data.rootIds.filter((rid) => !ids.includes(rid));
      this._pruneLinksForIds(ids);
      if (!this.data.rootIds.length && !Object.keys(this.data.nodes).length) {
        const empty = createEmpty();
        this.data.nodes = empty.nodes;
        this.data.rootIds = empty.rootIds;
      }
      const parentId = node.parentId;
      const parentDir = node.dir;
      if (parentId && this.data.nodes[parentId]) {
        // Close the gap in sibling order so the next added child goes last.
        this.childrenOf(parentId, parentDir).forEach((c, idx) => { c.order = idx; });
        this._layoutSide(this.data.nodes[parentId], parentDir);
      }
      ids.forEach((nid) => this.selectedIds.delete(nid));
      if (this._batching) return;
      this.selectOnly(parentId || this.data.rootIds[0] || null);
      this.render();
      this._emit();
    }

    toggleCollapse(id, dir) {
      if (this.readOnly) return;
      const n = this.data.nodes[id];
      if (!n || this.isNodeLocked(n) || !this.childrenOf(id, dir).length) return;
      n.collapsedDirs[dir] = !n.collapsedDirs[dir];
      this._pruneHiddenSelection();
      this.render();
      this._emit();
    }

    collapseAll() {
      if (this.readOnly) return;
      this.nodesArr().forEach((n) => {
        DIRS.forEach((d) => {
          if (this.childrenOf(n.id, d).length) n.collapsedDirs[d] = true;
        });
      });
      if (this.selectedId && this.hiddenByCollapse(this.selectedId)) this.selectOnly(this.data.rootIds[0] || null);
      this.render();
      this._emit();
    }

    expandAll() {
      if (this.readOnly) return;
      this.nodesArr().forEach((n) => { n.collapsedDirs = defaultCollapsed(); });
      this.render();
      this._emit();
    }

    expandFrame(id) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      const seen = new Set();
      const expandTree = (node) => {
        if (!node || seen.has(node.id)) return;
        seen.add(node.id);
        node.collapsedDirs = defaultCollapsed();
        this.childrenOf(node.id).forEach((c) => expandTree(c));
      };
      this.nodesArr().forEach((node) => {
        if (node.frameId === f.id) expandTree(node);
        else if (!node.frameId && this._nodeOverlapsFrame(node, f)) expandTree(node);
      });
      this.render();
      this._emit();
    }

    setAsRoot(id) {
      if (this.readOnly) return;
      const start = this.data.nodes[id];
      if (!start || this.isNodeLocked(start)) return;
      if (!start.parentId) {
        this.selectOnly(id);
        this.render();
        return;
      }
      const oldRoot = this.treeRoot(id);
      const path = [];
      let n = start;
      while (n) {
        path.push(n);
        n = n.parentId ? this.data.nodes[n.parentId] : null;
      }
      const orig = path.map((p) => ({ parentId: p.parentId, dir: p.dir }));
      path[0].parentId = null;
      path[0].dir = null;
      for (let i = 1; i < path.length; i++) {
        const node = path[i];
        const formerChild = path[i - 1];
        node.parentId = formerChild.id;
        node.dir = OPP[orig[i - 1].dir] || 'right';
      }
      this.data.rootIds = this.data.rootIds.map((rid) => (rid === oldRoot.id ? id : rid));
      this.selectOnly(id);
      this.render();
      this._emit();
    }

    // Mirror a node's descendants left<->right around the node's centre:
    // swap their side (and collapsed flags) and reflect their x positions.
    _mirrorBranch(node) {
      const swap = { left: 'right', right: 'left' };
      const cx = node.x + node.w / 2;
      const flipCollapsed = (n) => {
        if (!n.collapsedDirs) return;
        const l = n.collapsedDirs.left;
        n.collapsedDirs.left = n.collapsedDirs.right;
        n.collapsedDirs.right = l;
      };
      flipCollapsed(node);
      this.descendants(node.id, false).forEach((d) => {
        if (swap[d.dir]) d.dir = swap[d.dir];
        d.x = 2 * cx - (d.x + d.w);
        flipCollapsed(d);
      });
      // Cross-links inside the branch attach to the mirrored sides too.
      const inBranch = new Set(this.descendants(node.id, true).map((n) => n.id));
      (this.data.links || []).forEach((l) => {
        if (inBranch.has(l.fromId) && inBranch.has(l.toId)) {
          if (swap[l.fromDir]) l.fromDir = swap[l.fromDir];
          if (swap[l.toDir]) l.toDir = swap[l.toDir];
        }
      });
    }

    relinkNode(id, newParentId, dir, index) {
      if (this.readOnly) return false;
      const node = this.data.nodes[id];
      const parent = this.data.nodes[newParentId];
      if (!node || !parent || node.id === parent.id || !dir) return false;
      if (this.isNodeLocked(node) || this.isNodeLocked(parent)) return false;
      let p = parent;
      while (p) {
        if (p.id === id) return false;
        p = p.parentId ? this.data.nodes[p.parentId] : null;
      }
      const wasRoot = !node.parentId;
      const oldParent = node.parentId ? this.data.nodes[node.parentId] : null;
      const oldDir = node.dir;
      node.parentId = newParentId;
      node.dir = dir;
      node.userPlaced = false;
      // Like Miro: moving a branch between the left and right of a parent
      // mirrors the whole branch so its children keep growing outward.
      const horiz = (d) => d === 'left' || d === 'right';
      if (!wasRoot && horiz(oldDir) && horiz(dir) && oldDir !== dir) this._mirrorBranch(node);
      if (wasRoot) this.data.rootIds = this.data.rootIds.filter((rid) => rid !== id);
      const siblings = this.childrenOf(newParentId, dir).filter((s) => s.id !== id);
      const i = index == null ? siblings.length : clamp(index, 0, siblings.length);
      siblings.splice(i, 0, node);
      siblings.forEach((s, idx) => { s.order = idx; });
      if (oldParent && oldDir && (oldParent.id !== newParentId || oldDir !== dir)) {
        this.childrenOf(oldParent.id, oldDir).forEach((s, idx) => { s.order = idx; });
        this._layoutSide(oldParent, oldDir);
      }
      this._layoutSide(parent, dir);
      // Depth changed: refresh level colours (skips manual ones) and frame
      // membership for the moved branch at its new position.
      this._syncLevelLinkColors();
      this.descendants(id, true).forEach((d) => this._assignNodeFrame(d));
      this.render();
      this._emit();
      return true;
    }

    setNodeType(id, type) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly || this.isNodeLocked(n)) return;
      const prev = n.type;
      n.type = type;
      // Resize through _setNodeSize so the node's children move with it and
      // left/up nodes grow away from their parent.
      if (type === 'youtube') {
        if (!youtubeId(n.content)) n.content = '';
        this._setNodeSize(n, YT_W, YT_H);
      } else if (type === 'image') {
        if (!safeImageSrc(n.content)) n.content = '';
        this._setNodeSize(n, IMG_W, IMG_H);
      } else if ((prev === 'youtube' || prev === 'image') && type !== 'youtube' && type !== 'image') {
        this._setNodeSize(n, CELL_W, CELL_H);
        n.userSized = false;
      }
      if (type === 'link') {
        n.content = String(n.content || '').trim();
        const href = safeHttpUrl(n.content);
        if (href) n.content = href;
        if (!n.label || n.label === 'Link' || n.label === n.content) {
          n.label = prettyLinkLabel(n.content);
        }
        n.userSized = false;
        this._fitLinkNode(n);
      }
      if (type === 'code' && !n.language) n.language = 'auto';
      if (n.parentId && this.data.nodes[n.parentId]) this._layoutSide(this.data.nodes[n.parentId], n.dir);
      if (this._batching) return;
      this.render();
      this._emit();
      if (type === 'code') ensureHljs().then(() => this.render());
    }

    applyFrameColor(id, fill) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || f.locked) return;
      const white = /^#fff(fff)?$/i.test(String(fill || '').trim());
      f.fill = fill;
      f.border = white ? '#c5c9d1' : fill;
      f.fillAlpha = 1;
      if (this._batching) return;
      this.render();
      this._emit();
    }

    applyFillColor(id, fill) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly) return;
      if (isTransparent(fill)) {
        this.applyStyle(id, { fill: 'transparent', fillColorManual: true });
        return;
      }
      const patch = { fill, fillColorManual: true };
      if (!n.style.textColorManual) patch.textColor = contrastText(fill);
      this.applyStyle(id, patch);
    }

    applyBorderColor(id, border) {
      this.applyStyle(id, { border: isTransparent(border) ? 'transparent' : border });
    }

    applyNodeColor(id, fill) {
      this.applyFillColor(id, fill);
    }

    applyTextColor(id, color) {
      this.applyStyle(id, { textColor: color, textColorManual: true });
    }

    _fitLinkNode(n) {
      if (!n || n.type !== 'link' || n.userSized) return false;
      const size = measureLinkSize(n);
      return this._setNodeSize(n, size.w, size.h);
    }

    _fitAutoNode(n, live) {
      if (!n || n.userSized) return false;
      if (n.type === 'youtube' || n.type === 'image' || n.type === 'link') return false;
      const size = n.type === 'code' ? measureCodeCell(n) : measureTextCell(n, live);
      return this._setNodeSize(n, size.w, size.h);
    }

    _setNodeSize(n, w, h) {
      if (!n) return false;
      const ow = n.w || 0;
      const oh = n.h || 0;
      if (Math.abs(ow - w) <= 1 && Math.abs(oh - h) <= 1) return false;
      n.w = w;
      n.h = h;
      this._nudgeChildrenForSize(n, ow, oh, w, h);
      // Sizes grow from the top-left corner. A node hanging off the left (or
      // top) of its parent must instead grow away from it, or it widens into
      // the parent and its siblings. Shifting the whole subtree back keeps the
      // parent-facing edge fixed; the nudges above already sized the kids.
      if (n.parentId) {
        if (n.dir === 'left') this._moveSubtree(n.id, ow - w, 0);
        else if (n.dir === 'up') this._moveSubtree(n.id, 0, oh - h);
      }
      return true;
    }

    _nudgeChildrenForSize(n, ow, oh, nw, nh) {
      const dw = (nw || 0) - (ow || 0);
      const dh = (nh || 0) - (oh || 0);
      if (!dw && !dh) return;
      this.childrenOf(n.id, 'right').forEach((k) => this._moveSubtree(k.id, dw, dh / 2));
      this.childrenOf(n.id, 'left').forEach((k) => this._moveSubtree(k.id, 0, dh / 2));
      this.childrenOf(n.id, 'down').forEach((k) => this._moveSubtree(k.id, dw / 2, dh));
      this.childrenOf(n.id, 'up').forEach((k) => this._moveSubtree(k.id, dw / 2, 0));
    }

    _paintSubtreeBoxes(id) {
      this.descendants(id, true).forEach((node) => this._paintNodeBox(node));
    }

    _openLink(content) {
      const href = safeHttpUrl(content);
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
      return !!href;
    }

    _canNote(n) {
      return !!(n && (n.type === 'youtube' || n.type === 'image'));
    }

    _showMediaModal(title, html, image, node) {
      if (!this.els.ytModal || !this.els.ytStage) return;
      this._ytOpen = true;
      this._mediaNodeId = node && node.id ? node.id : null;
      if (this.els.ytTitle) this.els.ytTitle.textContent = title;
      this.els.ytStage.classList.toggle('is-image', !!image);
      if (this.els.ytStageWrap) this.els.ytStageWrap.classList.toggle('is-image', !!image);
      this.els.ytModal.classList.toggle('is-image', !!image);
      const box = this.els.ytModal.querySelector('.mm-yt-modal-box');
      if (box) box.setAttribute('aria-label', image ? 'Image' : 'YouTube video');
      this.els.ytStage.innerHTML = html;
      const showStamps = !image;
      const livePlayer = showStamps && !ytEmbedBlocked();
      if (this.els.ytMark) this.els.ytMark.hidden = !livePlayer || this.readOnly;
      if (this.els.ytStampBtn) this.els.ytStampBtn.hidden = !livePlayer || this.readOnly;
      if (this.els.ytStamps) {
        this.els.ytStamps.hidden = !showStamps;
        if (!showStamps) this.els.ytStamps.innerHTML = '';
      }
      this._syncYtExt(image ? '' : this._ytVideoId);
      if (this.els.mediaNote) {
        this.els.mediaNote.value = (node && node.note) || '';
        this.els.mediaNote.readOnly = this.readOnly;
        this.els.mediaNote.placeholder = showStamps
          ? 'Write a note. Click ＋ to add 1:23, then click a time to jump.'
          : 'Write a note…';
      }
      if (showStamps) this._renderYtStamps();
      this.els.ytModal.hidden = false;
      this.els.ytModal.classList.add('is-open');
      this.els.root.classList.add('is-yt-open');
      const closeBtn = this.els.ytModal.querySelector('.mm-yt-modal-close');
      if (closeBtn) closeBtn.focus();
    }

    _stopYtClock() {
      if (this._ytClock) {
        clearInterval(this._ytClock);
        this._ytClock = null;
      }
    }

    _startYtClock() {
      this._stopYtClock();
      this._tickYtClock();
      this._ytClock = setInterval(() => this._tickYtClock(), 400);
    }

    _ytCurrentSeconds() {
      try {
        if (this._ytPlayer && typeof this._ytPlayer.getCurrentTime === 'function') {
          return Math.max(0, this._ytPlayer.getCurrentTime() || 0);
        }
      } catch (e) { /* player not ready */ }
      return 0;
    }

    _tickYtClock() {
      const label = '＋ ' + formatTimestamp(this._ytCurrentSeconds());
      if (this.els.ytMark && !this.els.ytMark.hidden) this.els.ytMark.textContent = label;
      if (this.els.ytStampBtn && !this.els.ytStampBtn.hidden) this.els.ytStampBtn.textContent = label;
    }

    _destroyYtPlayer() {
      this._stopYtClock();
      if (this._ytPlayer) {
        try { this._ytPlayer.destroy(); } catch (e) { /* ignore */ }
        this._ytPlayer = null;
      }
    }

    _renderYtStamps() {
      if (!this.els.ytStamps || this.els.ytStamps.hidden) return;
      const stamps = extractTimestamps(this.els.mediaNote ? this.els.mediaNote.value : '');
      if (!stamps.length) {
        this.els.ytStamps.innerHTML = '<span class="mm-yt-stamps-hint">Click ＋ on the video to drop a time. Click a time to jump.</span>';
        return;
      }
      this.els.ytStamps.innerHTML = stamps.map((s) => (
        `<button type="button" class="mm-yt-chip" data-yt-seek="${s.seconds}">${escapeHtml(s.label)}</button>`
      )).join('');
    }

    _insertYtTimestamp() {
      if (this.readOnly || !this.els.mediaNote || !this._ytVideoId) return;
      const n = this._mediaNodeId && this.data.nodes[this._mediaNodeId];
      if (!n) return;
      const stamp = formatTimestamp(this._ytCurrentSeconds());
      const ta = this.els.mediaNote;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const padL = before && !/\s$/.test(before) ? '\n' : '';
      const insert = padL + stamp + ' ';
      ta.value = before + insert + after;
      const caret = (before + insert).length;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      n.note = ta.value;
      this._renderYtStamps();
      this._emit();
    }

    _syncYtExt(id) {
      const vid = youtubeId(id);
      if (this.els.ytWatch) {
        if (vid) {
          this.els.ytWatch.hidden = false;
          this.els.ytWatch.href = ytWatchSrc(vid, 0);
        } else {
          this.els.ytWatch.hidden = true;
          this.els.ytWatch.removeAttribute('href');
        }
      }
      if (this.els.ytWindow) this.els.ytWindow.hidden = !vid;
    }

    _openYtWindow(id, startSec) {
      const vid = youtubeId(id);
      if (!vid) return;
      try {
        // Watch page, not /embed — embed from file:// is YouTube error 153.
        const w = window.open(ytWatchSrc(vid, startSec), 'accretion-yt');
        if (w) w.focus();
      } catch (e) { /* popup blocked */ }
    }

    _ytLocalHtml(id) {
      return `<div class="mm-yt-local">
        <img class="mm-yt-local-thumb" alt="" src="https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg"/>
        <button type="button" class="mm-yt-local-play" data-yt-window>
          <span class="mm-yt-play-btn" aria-hidden="true"></span>
          Play on YouTube
        </button>
        <p class="mm-yt-local-hint">YouTube blocks embeds in a local file (error 153). The video opens on YouTube instead.</p>
      </div>`;
    }

    _seekYoutube(seconds) {
      const sec = Math.max(0, Number(seconds) || 0);
      if (this._ytPlayer && typeof this._ytPlayer.seekTo === 'function') {
        try {
          this._ytPlayer.seekTo(sec, true);
          if (typeof this._ytPlayer.playVideo === 'function') this._ytPlayer.playVideo();
          return;
        } catch (e) { /* fall through */ }
      }
      if (!this._ytVideoId) return;
      if (ytEmbedBlocked()) {
        this._openYtWindow(this._ytVideoId, sec);
        return;
      }
      if (this.els.ytStage) {
        const iframe = this.els.ytStage.querySelector('iframe');
        const src = ytEmbedSrc(this._ytVideoId, sec, true);
        if (iframe) iframe.src = src;
        else this.els.ytStage.innerHTML = ytIframeHtml(this._ytVideoId, sec);
      }
    }

    _mountYtPlayer(id, startSec) {
      const start = Math.max(0, Math.floor(Number(startSec) || 0));
      const fallback = () => {
        if (!this.els.ytStage || this._ytVideoId !== id) return;
        this.els.ytStage.innerHTML = ytIframeHtml(id, start);
      };
      if (ytEmbedBlocked()) {
        if (this.els.ytStage) this.els.ytStage.innerHTML = this._ytLocalHtml(id);
        return;
      }
      const host = this.els.ytStage && this.els.ytStage.querySelector('.mm-yt-player-host');
      if (!host) {
        fallback();
        return;
      }
      Promise.race([
        loadYtIframeApi(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]).then((YT) => {
        if (this._destroyed || !this._ytOpen || this._ytVideoId !== id || !this.els.ytStage) return;
        const mount = this.els.ytStage.querySelector('.mm-yt-player-host');
        if (!mount) return;
        const origin = ytHttpOrigin();
        const playerVars = {
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: start || undefined,
        };
        if (origin) playerVars.origin = origin;
        this._ytPlayer = new YT.Player(mount, {
          videoId: id,
          width: '100%',
          height: '100%',
          playerVars,
          events: {
            onReady: (e) => {
              if (start > 0) {
                e.target.seekTo(start, true);
                e.target.playVideo();
              }
              this._startYtClock();
            },
          },
        });
      }).catch(() => fallback());
    }

    _openYoutube(vid, node, startSec) {
      const id = youtubeId(vid);
      if (!id) return;
      const seekTo = startSec != null && !Number.isNaN(Number(startSec)) ? Number(startSec) : null;
      if (this._ytOpen && this._ytVideoId === id && (this._ytPlayer || ytEmbedBlocked())) {
        this._mediaNodeId = node && node.id ? node.id : this._mediaNodeId;
        if (this.els.mediaNote && node) {
          this.els.mediaNote.value = node.note || '';
          this._renderYtStamps();
        }
        if (seekTo != null) this._seekYoutube(seekTo);
        else if (ytEmbedBlocked()) this._openYtWindow(id, 0);
        return;
      }
      this._destroyYtPlayer();
      this._ytVideoId = id;
      if (ytEmbedBlocked()) this._openYtWindow(id, seekTo);
      this._showMediaModal('YouTube', ytEmbedBlocked() ? this._ytLocalHtml(id) : '<div class="mm-yt-player-host"></div>', false, node);
      if (!ytEmbedBlocked()) this._mountYtPlayer(id, seekTo);
    }

    _openImage(src, node) {
      const href = safeImageSrc(src);
      if (!href) return;
      this._destroyYtPlayer();
      this._ytVideoId = '';
      this._resetMediaImgZoom();
      this._showMediaModal('Image', `<div class="mm-media-zoom-view"><div class="mm-media-zoom"><img class="mm-media-modal-img" alt="" draggable="false" decoding="async" src="${escapeAttr(href)}"/></div></div>`, true, node);
      this._bindMediaImgBase();
    }

    _mediaImgEls() {
      const view = this.els.ytStage && this.els.ytStage.querySelector('.mm-media-zoom-view');
      const host = view && view.querySelector('.mm-media-zoom');
      const img = host && host.querySelector('img');
      return { view, host, img };
    }

    _bindMediaImgBase() {
      const { img } = this._mediaImgEls();
      if (!img) return;
      const capture = () => {
        if (!img.naturalWidth) return;
        const r = img.getBoundingClientRect();
        this._imgBase = { w: r.width || img.naturalWidth, h: r.height || img.naturalHeight };
        this._applyMediaImgZoom();
      };
      if (img.complete && img.naturalWidth) {
        requestAnimationFrame(capture);
        return;
      }
      img.addEventListener('load', () => requestAnimationFrame(capture), { once: true });
    }

    _resetMediaImgZoom() {
      this._imgZoom = { scale: 1 };
      this._imgBase = null;
      this._applyMediaImgZoom();
    }

    _applyMediaImgZoom() {
      const { view, host, img } = this._mediaImgEls();
      if (!view || !host) return;
      const scale = (this._imgZoom && this._imgZoom.scale) || 1;
      const base = this._imgBase;
      host.style.transform = 'scale(' + scale + ')';
      if (base && base.w && base.h) {
        view.style.width = Math.round(base.w * scale) + 'px';
        view.style.height = Math.round(base.h * scale) + 'px';
      } else if (img) {
        const r = img.getBoundingClientRect();
        if (r.width && r.height) {
          view.style.width = Math.round(r.width) + 'px';
          view.style.height = Math.round(r.height) + 'px';
        }
      }
    }

    _onMediaImgWheel(e) {
      const { view, host, img } = this._mediaImgEls();
      if (!view || !host) return;
      if (!(e.ctrlKey || e.metaKey || this._wheelShouldZoom(e))) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this._imgBase && img) {
        const r = img.getBoundingClientRect();
        const s = (this._imgZoom && this._imgZoom.scale) || 1;
        this._imgBase = { w: r.width / s, h: r.height / s };
      }
      const z = this._imgZoom || (this._imgZoom = { scale: 1 });
      const natural = img && img.naturalWidth && this._imgBase && this._imgBase.w
        ? img.naturalWidth / this._imgBase.w
        : 8;
      const max = clamp(Math.max(2, natural), 2, 8);
      z.scale = clamp(z.scale * Math.exp(-e.deltaY * 0.0025), 1, max);
      this._applyMediaImgZoom();
    }

    _closeYoutube() {
      const id = this._mediaNodeId;
      this._destroyYtPlayer();
      this._ytOpen = false;
      this._mediaNodeId = null;
      this._ytVideoId = '';
      this._resetMediaImgZoom();
      if (this.els.ytStage) {
        this.els.ytStage.innerHTML = '';
        this.els.ytStage.classList.remove('is-image');
      }
      if (this.els.ytStageWrap) this.els.ytStageWrap.classList.remove('is-image');
      if (this.els.ytModal) this.els.ytModal.classList.remove('is-image');
      if (this.els.ytMark) this.els.ytMark.hidden = true;
      if (this.els.ytStampBtn) this.els.ytStampBtn.hidden = true;
      if (this.els.ytStamps) {
        this.els.ytStamps.hidden = true;
        this.els.ytStamps.innerHTML = '';
      }
      if (this.els.mediaNote) this.els.mediaNote.value = '';
      if (this.els.ytTitle) this.els.ytTitle.textContent = 'YouTube';
      this._syncYtExt('');
      if (this.els.ytModal) {
        this.els.ytModal.hidden = true;
        this.els.ytModal.classList.remove('is-open');
      }
      if (this.els.root) this.els.root.classList.remove('is-yt-open');
      if (id && !this._destroyed) this.render();
    }

    _noteChromeHtml(n) {
      if (!this._canNote(n)) return '';
      const has = !!(n.note && String(n.note).trim());
      const pin = `<button type="button" class="mm-note-pin${has || n.noteOpen ? ' has-note' : ''}${n.noteOpen ? ' is-open' : ''}" data-note-toggle title="${n.noteOpen ? 'Minimize note' : (has ? 'Open note' : 'Add note')}">i</button>`;
      if (!n.noteOpen) return pin;
      return `${pin}<div class="mm-note-card">
        <div class="mm-note-card-bar"><span>Note</span><button type="button" data-note-toggle title="Minimize">–</button></div>
        <textarea data-note-body placeholder="Write a note…">${escapeHtml(n.note || '')}</textarea>
      </div>`;
    }

    _toggleNote(n) {
      if (!n || !this._canNote(n)) return;
      n.noteOpen = !n.noteOpen;
      this.render();
      if (!this.readOnly) this._emit();
      if (n.noteOpen) {
        const ta = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(n.id)}"] [data-note-body]`);
        if (ta && !this.readOnly) ta.focus();
      }
    }

    applyLinkColor(id, color) {
      this.applyStyle(id, { linkColor: color, linkColorManual: true });
    }

    applyLinkStyle(id, linkStyle) {
      this.applyStyle(id, { linkStyle });
    }

    applyStyle(id, patch) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly || this.isNodeLocked(n)) return;
      Object.assign(n.style, patch);
      if (this._batching) return;
      if (this.editingId === id) {
        this._paintNodeStyles(n);
        this._emit();
        return;
      }
      this.render();
      this._emit();
    }

    applyFormat(id, patch) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly || this.isNodeLocked(n)) return;
      if (!n.format) n.format = defaultFormat();
      const next = Object.assign({}, patch);
      if (next.fontSize != null) next.fontSize = clamp(Number(next.fontSize) || FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX);
      Object.assign(n.format, next);
      if (this._batching) return;
      if (this.editingId === id) {
        this._paintNodeStyles(n);
        if (!n.userSized && this._fitAutoNode(n, true)) {
          this._paintSubtreeBoxes(n.id);
          this._renderLinks(this.els.svg);
        }
        this._emit();
        return;
      }
      this.render();
      this._emit();
      requestAnimationFrame(() => { if (!this._destroyed) this._syncSizes(); });
    }

    copySubtree(id) {
      const node = this.data.nodes[id];
      if (!node) return null;
      const payload = { v: 1, nodes: {}, rootId: id, dir: node.dir };
      this.descendants(id, true).forEach((n) => { payload.nodes[n.id] = clone(n); });
      payload.links = this._linksInSet(new Set(Object.keys(payload.nodes)));
      const text = CLIP_PREFIX + JSON.stringify(payload);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      this._clip = payload;
      return payload;
    }

    copySelected() {
      const ids = this.selectedList();
      if (!ids.length) return null;
      if (ids.length === 1) return this.copySubtree(ids[0]);
      const trees = this._selectionRoots().map((id) => {
        const node = this.data.nodes[id];
        const tree = { v: 1, nodes: {}, rootId: id, dir: node.dir };
        this.descendants(id, true).forEach((n) => { tree.nodes[n.id] = clone(n); });
        tree.links = this._linksInSet(new Set(Object.keys(tree.nodes)));
        return tree;
      });
      const payload = { v: 2, trees };
      this._clip = payload;
      const text = CLIP_PREFIX + JSON.stringify(payload);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      return payload;
    }

    deleteSelected() {
      if (this.readOnly) return;
      const roots = this._selectionRoots();
      if (!roots.length) return;
      this._runBatch(() => {
        roots.forEach((id) => this.deleteNode(id));
      });
      this.selectOnly(this.data.rootIds[0] || null);
      this.render();
      this._emit();
    }

    alignSelected(mode) {
      const nodes = this._selectionNodes().filter((n) => !this.isNodeLocked(n));
      if (nodes.length < 2 || this.readOnly) return;
      const minX = Math.min(...nodes.map((n) => n.x));
      const maxX = Math.max(...nodes.map((n) => n.x + n.w));
      const minY = Math.min(...nodes.map((n) => n.y));
      const maxY = Math.max(...nodes.map((n) => n.y + n.h));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      nodes.forEach((n) => {
        if (mode === 'left') n.x = minX;
        else if (mode === 'right') n.x = maxX - n.w;
        else if (mode === 'top') n.y = minY;
        else if (mode === 'bottom') n.y = maxY - n.h;
        else if (mode === 'hcenter') n.x = cx - n.w / 2;
        else if (mode === 'vcenter') n.y = cy - n.h / 2;
      });
      this.render();
      this._emit();
    }

    detachNode(id, silent) {
      const n = this.data.nodes[id];
      if (!n || !n.parentId || this.readOnly || this.isNodeLocked(n)) return false;
      const parent = this.data.nodes[n.parentId];
      const dir = n.dir;
      n.parentId = null;
      n.dir = null;
      n.userPlaced = true;
      if (!this.data.rootIds.includes(id)) this.data.rootIds.push(id);
      if (parent && dir) {
        this.childrenOf(parent.id, dir).forEach((s, idx) => { s.order = idx; });
        this._layoutSide(parent, dir);
      }
      if (this.selectedLinkId === id) this.selectedLinkId = null;
      if (!silent) {
        this.render();
        this._emit();
      }
      return true;
    }

    detachSelected() {
      if (this.readOnly) return;
      this._applyToSelected((id) => this.detachNode(id, true));
      this.render();
      this._emit();
    }

    deleteSelectedLink() {
      if (this.readOnly || !this.selectedLinkId) return false;
      if (this._extraLinkById(this.selectedLinkId)) return this._deleteExtraLink(this.selectedLinkId);
      return this.detachNode(this.selectedLinkId);
    }

    _extraLinkById(id) {
      return (this.data.links || []).find((l) => l.id === id) || null;
    }

    _linksInSet(ids) {
      return (this.data.links || []).filter((l) => ids.has(l.fromId) && ids.has(l.toId)).map(clone);
    }

    _remapLinks(links, idMap) {
      (Array.isArray(links) ? links : []).forEach((l) => {
        const fromId = idMap[l.fromId];
        const toId = idMap[l.toId];
        if (!fromId || !toId || fromId === toId) return;
        if (this._hasConnection(fromId, toId)) return;
        this.data.links = this.data.links || [];
        this.data.links.push({
          id: uid('lk_'),
          fromId,
          toId,
          fromDir: (l.fromDir === 'left' || l.fromDir === 'right') ? l.fromDir : 'right',
          toDir: (l.toDir === 'left' || l.toDir === 'right') ? l.toDir : 'left',
        });
      });
    }

    _pruneLinksForIds(ids) {
      const gone = ids instanceof Set ? ids : new Set(ids || []);
      if (!gone.size) return;
      this.data.links = (this.data.links || []).filter((l) => !gone.has(l.fromId) && !gone.has(l.toId));
      if (this.selectedLinkId && this._extraLinkById(this.selectedLinkId) == null && !this.data.nodes[this.selectedLinkId]) {
        this.selectedLinkId = null;
      }
    }

    _hasConnection(fromId, toId) {
      if (!fromId || !toId || fromId === toId) return true;
      const a = this.data.nodes[fromId];
      const b = this.data.nodes[toId];
      if (!a || !b) return true;
      if (b.parentId === fromId || a.parentId === toId) return true;
      return (this.data.links || []).some((l) =>
        (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId)
      );
    }

    _deleteExtraLink(id, silent) {
      if (this.readOnly || !id) return false;
      const before = (this.data.links || []).length;
      this.data.links = (this.data.links || []).filter((l) => l.id !== id);
      if (this.data.links.length === before) return false;
      if (this.selectedLinkId === id) this.selectedLinkId = null;
      if (this._menuLinkId === id) this._menuLinkId = null;
      if (!silent) {
        this.render();
        this._emit();
      }
      return true;
    }

    // Connecting to a free-standing node (e.g. one whose parent line was
    // deleted) makes it a real child again, so it moves with its new tree.
    // A plain cross-link would leave it behind when the root is dragged.
    // It stays where the user put it (userPlaced) rather than being re-laid out.
    _adoptRoot(parent, child, cx, cy, dir) {
      if (child.parentId) return false;
      for (let p = parent; p; p = p.parentId ? this.data.nodes[p.parentId] : null) {
        if (p.id === child.id) return false; // parent is inside child's tree
      }
      const side = DIRS.includes(dir) ? dir : this.nearestSide(parent, cx, cy);
      if (!DIRS.includes(side)) return false;
      child.parentId = parent.id;
      child.dir = side;
      child.userPlaced = true;
      child.order = this.childrenOf(parent.id, side).filter((s) => s.id !== child.id).length;
      this.data.rootIds = this.data.rootIds.filter((rid) => rid !== child.id);
      if (!child.style) child.style = defaultStyle();
      if (!child.style.linkColorManual) {
        child.style.linkColor = colorForLevel(this.data, nodeDepth(this.data.nodes, child.id));
      }
      this._syncLevelLinkColors();
      this.selectedLinkId = child.id;
      this.selectedIds = new Set();
      this.selectedId = null;
      this.selectedFrameId = null;
      this.render();
      this._emit();
      return true;
    }

    _connectNodes(fromId, toId, dir) {
      const parent = this.data.nodes[fromId];
      const child = this.data.nodes[toId];
      if (!parent || !child || fromId === toId) return false;
      if (this.readOnly || this.isNodeLocked(parent) || this.isNodeLocked(child)) return false;
      if (this._hasConnection(fromId, toId)) return false;
      const cx = child.x + child.w / 2;
      const cy = child.y + child.h / 2;
      if (this._adoptRoot(parent, child, cx, cy, dir)) return true;
      const fromDir = (dir === 'left' || dir === 'right') ? dir : this.nearestSide(parent, cx, cy);
      const toDir = OPP[fromDir] || 'left';
      this.data.links = this.data.links || [];
      const link = { id: uid('lk_'), fromId, toId, fromDir, toDir };
      this.data.links.push(link);
      this.selectedLinkId = link.id;
      this.selectedIds = new Set();
      this.selectedId = null;
      this.selectedFrameId = null;
      this.render();
      this._emit();
      return true;
    }

    _groupToggleFormat(key) {
      const nodes = this._selectionNodes();
      if (!nodes.length) return;
      const allOn = nodes.every((n) => n.format && n.format[key]);
      this._applyToSelected((id) => this.applyFormat(id, { [key]: !allOn }));
    }

    async pasteSubtree(atId) {
      if (this.readOnly) return;
      if (atId && this.isNodeLocked(atId)) return;
      let payload = this._clip;
      try {
        const t = await navigator.clipboard.readText();
        if (t && t.startsWith(CLIP_PREFIX)) payload = JSON.parse(t.slice(CLIP_PREFIX.length));
      } catch (e) { /* use memory clip */ }
      if (payload && payload.v === 2 && Array.isArray(payload.trees)) {
        const newIds = [];
        this._runBatch(() => {
          payload.trees.forEach((tree, i) => {
            const rootId = this._pasteTree(tree, atId, i * 28, i * 28);
            if (rootId) newIds.push(rootId);
          });
        });
        this.selectedIds = new Set(newIds);
        this.selectedId = newIds[0] || null;
        this.selectedFrameId = null;
        this.render();
        this._emit();
        return;
      }
      if (!payload || !payload.nodes || !payload.rootId) return;
      const newRootId = this._pasteTree(payload, atId, 0, 0);
      if (newRootId) this.selectOnly(newRootId);
      this.render();
      this._emit();
    }

    _pasteTree(payload, atId, extraDx, extraDy) {
      if (!payload || !payload.nodes || !payload.rootId) return null;
      const idMap = {};
      Object.keys(payload.nodes).forEach((oldId) => { idMap[oldId] = uid('n_'); });
      const created = [];
      Object.values(payload.nodes).forEach((n) => {
        const nn = clone(n);
        nn.id = idMap[n.id];
        nn.parentId = n.parentId ? idMap[n.parentId] : null;
        nn.locked = false;
        // Frame membership is worked out from where the copy lands (below);
        // keeping the source's frameId could tie it to a locked frame.
        nn.frameId = null;
        this.data.nodes[nn.id] = nn;
        created.push(nn);
      });
      const newRoot = this.data.nodes[idMap[payload.rootId]];
      if (!newRoot) return null;
      const target = atId ? this.data.nodes[atId] : null;
      if (target) {
        const dir = newRoot.dir || 'right';
        const inh = this.inheritProps(target, dir);
        newRoot.parentId = target.id;
        newRoot.dir = dir;
        newRoot.order = this.childrenOf(target.id, dir).filter((c) => c.id !== newRoot.id).length;
        newRoot.style = inh.style;
        newRoot.format = inh.format;
        // Lay it out next to the new parent instead of leaving it where it
        // was copied from; a cloned userPlaced flag would also stop packing.
        newRoot.userPlaced = false;
        this._placeNewChild(target, dir, newRoot.id);
        this._layoutSide(target, dir);
      } else {
        newRoot.parentId = null;
        newRoot.dir = null;
        const vp = this.data.viewport;
        const rect = this.els.canvas.getBoundingClientRect();
        const nx = (rect.width / 2 - vp.x) / vp.zoom + (extraDx || 0);
        const ny = (rect.height / 2 - vp.y) / vp.zoom + (extraDy || 0);
        const dx = nx - newRoot.x;
        const dy = ny - newRoot.y;
        created.forEach((nn) => { nn.x += dx; nn.y += dy; });
        this.data.rootIds.push(newRoot.id);
      }
      created.forEach((nn) => this._assignNodeFrame(nn));
      this._remapLinks(payload.links, idMap);
      return newRoot.id;
    }

    _frameWouldOverlap(fr) {
      if (!fr) return false;
      return (this.data.frames || []).some((o) => o.id !== fr.id && this._rectsOverlap(fr, o));
    }

    _rectInside(inner, outer) {
      return inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h;
    }

    _imageAspect(n) {
      if (!n) return IMG_W / IMG_H;
      if (typeof n.imgAspect === 'number' && n.imgAspect > 0.12 && n.imgAspect < 12) return n.imgAspect;
      return Math.max(n.w || IMG_W, 1) / Math.max(n.h || IMG_H, 1);
    }

    _relayoutNode(n) {
      if (!n || !n.parentId || !this.data.nodes[n.parentId]) return;
      const parent = this.data.nodes[n.parentId];
      if (n.dir) this._layoutSide(parent, n.dir);
    }

    _setImageSize(n, nextW, fromCenter) {
      if (!n) return;
      const aspect = this._imageAspect(n);
      let nw = clamp(nextW, 120, 960);
      let nh = nw / aspect;
      if (nh < 90) {
        nh = 90;
        nw = nh * aspect;
      }
      if (nh > 960) {
        nh = 960;
        nw = nh * aspect;
      }
      nw = clamp(nw, 120, 960);
      nh = nw / aspect;
      if (fromCenter) {
        n.x += ((n.w || nw) - nw) / 2;
        n.y += ((n.h || nh) - nh) / 2;
      }
      n.w = nw;
      n.h = nh;
      n.userSized = true;
    }

    _paintNodeBox(n) {
      if (!n) return null;
      const el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(n.id)}"]`);
      if (!el) return null;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.width = (n.w || CELL_W) + 'px';
      el.style.height = (n.h || CELL_H) + 'px';
      el.classList.toggle('is-maxw', n.type === 'text' && String(n.content || '').split('\n').some((line) => line.length >= CELL_CHARS));
      return el;
    }

    _paintMovingNodes() {
      const d = this._drag;
      const ids = new Set();
      (d && d.origins ? d.origins : []).forEach((o) => { if (o && o.id) ids.add(o.id); });
      if (d && d.id) ids.add(d.id);
      this.els.world.querySelectorAll('.mm-node.is-dragging').forEach((el) => {
        if (!ids.has(el.dataset.id)) el.classList.remove('is-dragging');
      });
      ids.forEach((id) => {
        const n = this.data.nodes[id];
        if (!n || this.hiddenByCollapse(id)) return;
        const el = this._paintNodeBox(n);
        if (el) el.classList.add('is-dragging');
      });
      this._renderLinks(this.els.svg);
      this._syncDropUi();
    }

    _beginNodeResize(e, n, corner) {
      if (!n || this.readOnly || this.isNodeLocked(n)) return false;
      const w = this.screenToWorld(e.clientX, e.clientY);
      this.selectOnly(n.id);
      this._drag = {
        kind: 'resize-node',
        id: n.id,
        corner: corner || 'se',
        aspect: n.type === 'image' ? this._imageAspect(n) : null,
        x0: w.x,
        y0: w.y,
        w0: n.w,
        h0: n.h,
        fx: n.x,
        fy: n.y,
      };
      const box = this._paintNodeBox(n);
      if (box) box.classList.add('is-resizing');
      try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return true;
    }

    _applyNodeResize(n, d, w) {
      if (n.type === 'image' && d.aspect) {
        const c = d.corner || 'se';
        let nw = (c === 'se' || c === 'ne') ? d.w0 + (w.x - d.x0) : d.w0 - (w.x - d.x0);
        const dy = (c === 'se' || c === 'sw') ? (w.y - d.y0) : (d.y0 - w.y);
        if (Math.abs(w.y - d.y0) > Math.abs(w.x - d.x0)) nw = (d.h0 + dy) * d.aspect;
        this._setImageSize(n, nw, false);
        n.x = c.indexOf('w') !== -1 ? d.fx + d.w0 - n.w : d.fx;
        n.y = c.indexOf('n') !== -1 ? d.fy + d.h0 - n.h : d.fy;
        return;
      }
      n.w = clamp(d.w0 + (w.x - d.x0), 120, 720);
      n.h = clamp(d.h0 + (w.y - d.y0), 40, 720);
      n.userSized = true;
    }

    _applyFrameResize(f, d, wx, wy) {
      const dx = wx - d.x0;
      const dy = wy - d.y0;
      const c = d.corner || 'se';
      let x = d.fx;
      let y = d.fy;
      let w = d.w0;
      let h = d.h0;
      if (c.indexOf('e') !== -1) w = d.w0 + dx;
      if (c.indexOf('s') !== -1) h = d.h0 + dy;
      if (c.indexOf('w') !== -1) { x = d.fx + dx; w = d.w0 - dx; }
      if (c.indexOf('n') !== -1) { y = d.fy + dy; h = d.h0 - dy; }
      if (w < 80) {
        if (c.indexOf('w') !== -1) x = d.fx + d.w0 - 80;
        w = 80;
      }
      if (h < 60) {
        if (c.indexOf('n') !== -1) y = d.fy + d.h0 - 60;
        h = 60;
      }
      f.x = x;
      f.y = y;
      f.w = w;
      f.h = h;
    }

    nearestSide(node, wx, wy) {
      const cx = node.x + node.w / 2;
      return wx < cx ? 'left' : 'right';
    }

    _stickySide(node, wx, wy, prevParentId, prevSide) {
      const next = this.nearestSide(node, wx, wy);
      if (!prevSide || prevParentId !== node.id) return next;
      if (prevSide !== 'left' && prevSide !== 'right') return next;
      const dx = (wx - (node.x + node.w / 2)) / Math.max(node.w / 2, 1);
      if (Math.abs(dx) < 0.12) return prevSide;
      return next;
    }

    _insertIndex(kids, dir, wx, wy) {
      let index = kids.length;
      if (dir === 'right' || dir === 'left') {
        for (let i = 0; i < kids.length; i++) {
          if (wy < kids[i].y + kids[i].h / 2) { index = i; break; }
        }
      } else {
        for (let i = 0; i < kids.length; i++) {
          if (wx < kids[i].x + kids[i].w / 2) { index = i; break; }
        }
      }
      return index;
    }

    _edgeDist(node, dir, wx, wy) {
      const slack = 18;
      if (dir === 'right') {
        if (wy < node.y - slack || wy > node.y + node.h + slack) return Infinity;
        const d = wx - (node.x + node.w);
        return d >= 0 ? d : Infinity;
      }
      if (dir === 'left') {
        const kids = this.childrenOf(node.id, 'left');
        let y0 = node.y - slack;
        let y1 = node.y + node.h + slack;
        kids.forEach((k) => {
          y0 = Math.min(y0, k.y - slack);
          y1 = Math.max(y1, k.y + k.h + slack);
        });
        if (wy < y0 || wy > y1) return Infinity;
        const d = node.x - wx;
        return d >= 0 ? d : Infinity;
      }
      if (dir === 'down') {
        if (wx < node.x - slack || wx > node.x + node.w + slack) return Infinity;
        const d = wy - (node.y + node.h);
        return d >= 0 ? d : Infinity;
      }
      if (wx < node.x - slack || wx > node.x + node.w + slack) return Infinity;
      const d = node.y - wy;
      return d >= 0 ? d : Infinity;
    }

    _dragSkip(dragId) {
      const skip = new Set();
      this.descendants(dragId, true).forEach((n) => skip.add(n.id));
      return skip;
    }

    _nodeAtClient(clientX, clientY, skip) {
      const stack = document.elementsFromPoint(clientX, clientY) || [];
      for (let i = 0; i < stack.length; i++) {
        const el = stack[i];
        if (!el || !el.closest) continue;
        const nodeEl = el.classList && el.classList.contains('mm-node') ? el : el.closest('.mm-node');
        if (!nodeEl || !this.els.world.contains(nodeEl)) continue;
        const id = nodeEl.dataset.id;
        if (skip.has(id)) continue;
        const n = this.data.nodes[id];
        if (n && !this.hiddenByCollapse(n.id)) return n;
      }
      return null;
    }

    _makeDrop(parent, dir, index, kids, kind) {
      const rect = kind === 'insert' ? this._slotMarker(parent, dir, index, kids) : this._dockMarker(parent, dir);
      return { parentId: parent.id, dir, index, kind, rect };
    }

    _findDropSlot(wx, wy, dragId, clientX, clientY) {
      const skip = this._dragSkip(dragId);
      const over = (typeof clientX === 'number')
        ? this._nodeAtClient(clientX, clientY, skip)
        : this.nodeAtWorld(wx, wy, dragId, 0);
      if (over && !skip.has(over.id) && !this.isNodeLocked(over)) {
        const prev = this._drag || {};
        const dir = this._stickySide(over, wx, wy, prev.dropParentId, prev.dropSide);
        if (dir === 'left' || dir === 'right') {
          if (this._drag) {
            this._drag.dropParentId = over.id;
            this._drag.dropSide = dir;
          }
          const kids = this.childrenOf(over.id, dir).filter((k) => !skip.has(k.id));
          const index = this._insertIndex(kids, dir, wx, wy);
          return this._makeDrop(over, dir, index, kids, 'child');
        }
      }

      let best = null;
      let bestD = 36;
      this.nodesArr().forEach((parent) => {
        if (skip.has(parent.id) || this.hiddenByCollapse(parent.id) || this.isNodeLocked(parent)) return;
        RELINK_DIRS.forEach((dir) => {
          if (parent.collapsedDirs && parent.collapsedDirs[dir]) return;
          const kids = this.childrenOf(parent.id, dir).filter((k) => !skip.has(k.id));
          for (let i = 1; i < kids.length; i++) {
            const a = kids[i - 1];
            const b = kids[i];
            const gx = (dir === 'right' || dir === 'left')
              ? (a.x + a.w / 2 + b.x + b.w / 2) / 2
              : (a.x + a.w + b.x) / 2;
            const gy = (dir === 'right' || dir === 'left')
              ? (a.y + a.h + b.y) / 2
              : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
            const d = Math.hypot(wx - gx, wy - gy);
            if (d < bestD) {
              bestD = d;
              best = this._makeDrop(parent, dir, i, kids, 'insert');
            }
          }
          const edgeD = this._edgeDist(parent, dir, wx, wy);
          if (edgeD < 44 && edgeD < bestD) {
            const index = this._insertIndex(kids, dir, wx, wy);
            bestD = edgeD;
            best = this._makeDrop(parent, dir, index, kids, 'child');
          }
        });
      });
      if (best && this._drag) {
        this._drag.dropParentId = best.parentId;
        this._drag.dropSide = best.dir;
      }
      return best;
    }

    _dockMarker(parent, dir) {
      const t = 9;
      const inset = 10;
      if (dir === 'right') return { x: parent.x + parent.w - t / 2, y: parent.y + inset, w: t, h: Math.max(parent.h - inset * 2, 18) };
      if (dir === 'left') {
        const gap = Math.max(24, Math.min(40, this._packGap(parent)));
        return { x: parent.x - gap - t, y: parent.y + inset, w: t, h: Math.max(parent.h - inset * 2, 18) };
      }
      if (dir === 'down') return { x: parent.x + inset, y: parent.y + parent.h - t / 2, w: Math.max(parent.w - inset * 2, 18), h: t };
      return { x: parent.x + inset, y: parent.y - t / 2, w: Math.max(parent.w - inset * 2, 18), h: t };
    }

    _slotMarker(parent, dir, index, kids) {
      const bar = 6;
      const len = 72;
      if (dir === 'right' || dir === 'left') {
        let y;
        if (!kids.length) y = parent.y + parent.h / 2;
        else if (index <= 0) y = kids[0].y - 10;
        else if (index >= kids.length) y = kids[kids.length - 1].y + kids[kids.length - 1].h + 8;
        else y = (kids[index - 1].y + kids[index - 1].h + kids[index].y) / 2;
        if (kids.length && index > 0 && index < kids.length) {
          const a = kids[index - 1];
          const b = kids[index];
          const gx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
          return { x: gx - len / 2, y: y - bar / 2, w: len, h: bar };
        }
        const x = dir === 'right' ? parent.x + parent.w + 16 : parent.x - len - 16;
        return { x, y: y - bar / 2, w: len, h: bar };
      }
      let x;
      if (!kids.length) x = parent.x + parent.w / 2;
      else if (index <= 0) x = kids[0].x - 10;
      else if (index >= kids.length) x = kids[kids.length - 1].x + kids[kids.length - 1].w + 8;
      else x = (kids[index - 1].x + kids[index - 1].w + kids[index].x) / 2;
      if (kids.length && index > 0 && index < kids.length) {
        const a = kids[index - 1];
        const b = kids[index];
        const gy = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
        return { x: x - bar / 2, y: gy - len / 2, w: bar, h: len };
      }
      const y = dir === 'down' ? parent.y + parent.h + 16 : parent.y - len - 16;
      return { x: x - bar / 2, y, w: bar, h: len };
    }

    _nodeDropLabel(n) {
      const t = stripTags((n && (n.label || n.content)) || '').replace(/\s+/g, ' ').trim();
      return (t || 'topic').slice(0, 32);
    }

    _syncDropUi() {
      const slot = this._drag && this._drag.moved && this._drag.drop;
      const parentId = slot && slot.parentId;
      this.els.world.querySelectorAll('.mm-node').forEach((el) => {
        el.classList.toggle('drop-parent', !!(parentId && el.dataset.id === parentId));
        el.classList.remove('drop-target', 'drop-maybe');
      });
      const mark = this.els.dropSlot;
      if (mark) {
        if (!slot) {
          mark.classList.remove('show');
          mark.removeAttribute('data-kind');
        } else {
          mark.classList.add('show');
          mark.setAttribute('data-kind', slot.kind || 'child');
          mark.style.left = slot.rect.x + 'px';
          mark.style.top = slot.rect.y + 'px';
          mark.style.width = slot.rect.w + 'px';
          mark.style.height = slot.rect.h + 'px';
        }
      }
      const hint = this.els.dropHint;
      if (!hint) return;
      if (!slot) {
        hint.classList.remove('show');
        hint.textContent = '';
        return;
      }
      const parent = this.data.nodes[slot.parentId];
      const name = this._nodeDropLabel(parent);
      hint.textContent = slot.kind === 'insert'
        ? `Insert in "${name}"`
        : `Child of "${name}" · ${slot.dir}`;
      hint.classList.add('show');
    }

    nodeAtWorld(wx, wy, except, pad) {
      const skip = new Set();
      if (except instanceof Set) except.forEach((id) => skip.add(id));
      else if (typeof except === 'string') {
        this.descendants(except, true).forEach((n) => skip.add(n.id));
      }
      const g = pad || 0;
      const list = this.nodesArr();
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (skip.has(n.id) || this.hiddenByCollapse(n.id)) continue;
        if (wx >= n.x - g && wx <= n.x + n.w + g && wy >= n.y - g && wy <= n.y + n.h + g) return n;
      }
      return null;
    }

    nodeAtPointer(clientX, clientY, skipId) {
      const skip = new Set();
      if (skipId) this.descendants(skipId, true).forEach((n) => skip.add(n.id));
      const stack = document.elementsFromPoint(clientX, clientY) || [];
      for (let i = 0; i < stack.length; i++) {
        const el = stack[i];
        if (!el || !el.closest) continue;
        const nodeEl = el.classList && el.classList.contains('mm-node') ? el : el.closest('.mm-node');
        if (!nodeEl || !this.els.world.contains(nodeEl)) continue;
        if (skip.has(nodeEl.dataset.id)) continue;
        const n = this.data.nodes[nodeEl.dataset.id];
        if (n && !this.hiddenByCollapse(n.id)) return n;
      }
      const w = this.screenToWorld(clientX, clientY);
      const PAD = 40;
      let best = null;
      let bestD = Infinity;
      this.nodesArr().forEach((n) => {
        if (skip.has(n.id) || this.hiddenByCollapse(n.id)) return;
        const nx = clamp(w.x, n.x, n.x + n.w);
        const ny = clamp(w.y, n.y, n.y + n.h);
        const dist = Math.hypot(w.x - nx, w.y - ny);
        if (dist <= PAD && dist < bestD) {
          bestD = dist;
          best = n;
        }
      });
      return best;
    }

    _connectTargetAt(clientX, clientY, fromId) {
      const skip = new Set(fromId ? [fromId] : []);
      const stack = document.elementsFromPoint(clientX, clientY) || [];
      for (let i = 0; i < stack.length; i++) {
        const el = stack[i];
        if (!el || !el.closest) continue;
        const nodeEl = el.classList && el.classList.contains('mm-node') ? el : el.closest('.mm-node');
        if (!nodeEl || !this.els.world.contains(nodeEl)) continue;
        if (skip.has(nodeEl.dataset.id)) continue;
        const n = this.data.nodes[nodeEl.dataset.id];
        if (n && !this.hiddenByCollapse(n.id) && !this.isNodeLocked(n)) return n;
      }
      const w = this.screenToWorld(clientX, clientY);
      const PAD = 40;
      let best = null;
      let bestD = Infinity;
      this.nodesArr().forEach((n) => {
        if (skip.has(n.id) || this.hiddenByCollapse(n.id) || this.isNodeLocked(n)) return;
        const nx = clamp(w.x, n.x, n.x + n.w);
        const ny = clamp(w.y, n.y, n.y + n.h);
        const dist = Math.hypot(w.x - nx, w.y - ny);
        if (dist <= PAD && dist < bestD) {
          bestD = dist;
          best = n;
        }
      });
      return best;
    }

    _teardownTextEditor() {
      clearTimeout(this._editEmitTimer);
      if (this._textEdit && this._textEdit.el) this._textEdit.el.remove();
      this._textEdit = null;
    }

    _syncTextEditorBox(n) {
      const ta = this._textEdit && this._textEdit.el;
      if (!ta || !n) return;
      ta.style.left = n.x + 'px';
      ta.style.top = n.y + 'px';
      ta.style.width = (n.w || CELL_W) + 'px';
      ta.style.height = (n.h || CELL_H) + 'px';
    }

    _styleTextEditor(n) {
      const ta = this._textEdit && this._textEdit.el;
      if (!ta || !n) return;
      const fmt = n.format || defaultFormat();
      ta.style.color = n.style.textColor || '#1a2130';
      ta.style.fontWeight = fmt.bold ? '700' : '500';
      ta.style.fontStyle = fmt.italic ? 'italic' : 'normal';
      ta.style.textDecoration = fmt.underline ? 'underline' : 'none';
      ta.style.fontSize = (fmt.fontSize || FONT_SIZE_DEFAULT) + 'px';
      ta.style.fontFamily = fontCss(fmt.fontFamily);
      ta.style.textAlign = fmt.align || 'center';
    }

    _ensureTextEditor(el, n) {
      if (this._textEdit && this._textEdit.id === n.id && this._textEdit.el && this.els.world.contains(this._textEdit.el)) {
        this._styleTextEditor(n);
        this._syncTextEditorBox(n);
        el.classList.add('editing');
        return this._textEdit.el;
      }
      this._teardownTextEditor();
      const ta = document.createElement('textarea');
      ta.className = 'mm-text-edit-overlay';
      ta.setAttribute('data-edit', '1');
      ta.rows = 1;
      ta.spellcheck = true;
      ta.value = n.content || '';
      this.els.world.appendChild(ta);
      this._textEdit = { el: ta, id: n.id };
      el.classList.add('editing');
      this._styleTextEditor(n);
      this._syncTextEditorBox(n);
      // Pasted text: drop invisible characters; a text diagram turns the node
      // into a plain-text code block so it lines up (monospace, no wrapping).
      ta.addEventListener('paste', (ev) => {
        const P = global.DocPaste;
        const raw = P && ev.clipboardData && ev.clipboardData.getData('text/plain');
        if (!raw || this.readOnly) return;
        const diagram = P.isDiagram(raw);
        const text = diagram ? P.cleanDiagram(raw) : P.normalize(raw);
        if (!diagram && text === raw) return;
        ev.preventDefault();
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
        if (diagram) this._convertToDiagram(n.id);
      });
      ta.addEventListener('input', () => {
        if (this.readOnly) return;
        n.content = ta.value;
        clearTimeout(this._editEmitTimer);
        this._editEmitTimer = setTimeout(() => {
          if (!this._destroyed && this.editingId === n.id) this._emitLive();
        }, 400);
        if (n.userSized) return;
        if (this._fitAutoNode(n, true)) {
          this._paintSubtreeBoxes(n.id);
          this._renderLinks(this.els.svg);
          this._syncTextEditorBox(n);
          this._moveFormatBar();
        }
      });
      return ta;
    }

    startEdit(id) {
      if (this.readOnly || this.isNodeLocked(id)) return;
      const n = this.data.nodes[id];
      if (!n) return;
      const same = this.editingId === id;
      this.editingId = id;
      this.selectOnly(id);
      let el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(id)}"]`);
      if (n.type === 'text') {
        if (!el) {
          this.render();
          el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(id)}"]`);
        }
        if (!el) return;
        const body = this._ensureTextEditor(el, n);
        if (!same) {
          body.focus();
          body.select();
        } else if (document.activeElement !== body) {
          body.focus();
        }
        this._positionFormatBar();
        return;
      }
      const existing = el && el.querySelector('[data-edit]');
      if (!same || !existing) this.render();
      el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(id)}"]`);
      if (!el) return;
      const body = el.querySelector('[data-edit]');
      if (body) {
        if (!same || document.activeElement !== body) body.focus();
        if (!same) {
          if (body.select) body.select();
          else if (window.getSelection && body.childNodes.length) {
            const range = document.createRange();
            range.selectNodeContents(body);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      }
    }

    flushEdit() {
      if (!this.editingId) return;
      const n = this.data.nodes[this.editingId];
      if (!n) return;
      if (this._textEdit && this._textEdit.el) {
        n.content = this._textEdit.el.value;
        return;
      }
      const el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(this.editingId)}"]`);
      const body = el && el.querySelector('[data-edit]');
      if (body) n.content = readEditValue(body);
    }

    _convertToDiagram(id) {
      this.commitEdit();
      const n = this.data.nodes[id];
      if (!n) return;
      n.language = 'plaintext';
      if (!n.format) n.format = defaultFormat();
      n.format.align = 'left';
      n.userSized = false;
      this.setNodeType(id, 'code');
      this._fitAutoNode(n);
      this._relayoutAround([n]);
      this.selectOnly(id);
      this.render();
      this._emit();
    }

    commitEdit() {
      if (!this.editingId) return;
      const id = this.editingId;
      const n = this.data.nodes[id];
      const el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(id)}"]`);
      if (n) {
        if (this._textEdit && this._textEdit.el) n.content = this._textEdit.el.value;
        else if (el) {
          const body = el.querySelector('[data-edit]');
          if (body) n.content = readEditValue(body);
        }
        if (el) {
          const lang = el.querySelector('[data-lang]');
          if (lang) n.language = lang.value;
          const label = el.querySelector('[data-label]');
          if (label) n.label = label.value || label.innerText;
        }
        // Through _setNodeSize so children shift with the new size.
        if (n.type === 'youtube' && youtubeId(n.content)) this._setNodeSize(n, YT_W, YT_H);
        if (n.type === 'image' && safeImageSrc(n.content) && !n.userSized) this._setNodeSize(n, IMG_W, IMG_H);
        if (n.type === 'link') {
          const href = safeHttpUrl(n.content);
          if (href) n.content = href;
          if (!n.label || n.label === 'Link') n.label = prettyLinkLabel(n.content);
          this._fitLinkNode(n);
        } else if (n.type === 'text' || n.type === 'code') {
          this._fitAutoNode(n);
        }
        // The node grew while typing without moving its neighbours; make room now.
        this._relayoutAround([n]);
      }
      this._teardownTextEditor();
      this.editingId = null;
      this._hideFormatBar();
      if (el) delete el.dataset.sig;
      this.render();
      this._measureDomThenLayout();
      this._emit();
    }

    render() {
      if (this._destroyed) return;
      const editing = this.editingId && this.data.nodes[this.editingId];
      if (editing && editing.type === 'text') {
        this._paintNodeStyles(editing);
        this._styleTextEditor(editing);
        this._syncTextEditorBox(editing);
        this._moveFormatBar();
        return;
      }
      const world = this.els.world;
      const svg = this.els.svg;
      const keepIds = new Set(Object.keys(this.data.nodes));
      world.querySelectorAll('.mm-node').forEach((el) => {
        if (!keepIds.has(el.dataset.id)) el.remove();
      });
      const frameKeep = new Set((this.data.frames || []).map((f) => f.id));
      world.querySelectorAll('.mm-frame').forEach((el) => {
        if (!frameKeep.has(el.dataset.id)) el.remove();
      });

      (this.data.frames || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((f) => {
        this._renderFrame(f);
        const el = world.querySelector(`.mm-frame[data-id="${CSS.escape(f.id)}"]`);
        if (el) world.insertBefore(el, svg);
      });
      this._syncLevelLinkColors();
      this._renderLinks(svg);
      this.nodesArr().forEach((n) => this._renderNode(n));
      this._syncDropUi();
      if (!this._drag && !this._colorPicking && !this.editingId) this._updateInspector();
      if (!this._drag) this._renderBookmarks();
      this.els.hint.style.display = this.nodesArr().length > 1 ? 'none' : '';
      this._applyTransform();

      if (this.editingId) this._positionFormatBar();
      else this._hideFormatBar();

      const needsCode = this.nodesArr().some((n) => n.type === 'code');
      if (needsCode && !global.hljs) ensureHljs().then(() => { if (!this._destroyed) this.render(); });
    }

    _renderFrame(f) {
      let el = this.els.world.querySelector(`.mm-frame[data-id="${CSS.escape(f.id)}"]`);
      if (el && (!el.querySelector('[data-resize-frame]') || !el.querySelector('.mm-frame-bar') || !el.querySelector('.mm-frame-top') || !el.querySelector('[data-frame-unlock]'))) {
        el.remove();
        el = null;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'mm-frame';
        el.dataset.id = f.id;
        el.innerHTML = `<div class="mm-frame-bar" data-frame-drag title="Drag to move">
            <div class="mm-frame-title" data-frame-unlock contenteditable="false"></div>
            <span class="mm-frame-lock" data-frame-unlock title="Locked · press and hold the name to unlock"></span>
          </div>
          <div class="mm-frame-top" data-frame-drag title="Drag to move"></div>
          <div class="mm-fh mm-fh-nw" data-resize-frame="nw"></div>
          <div class="mm-fh mm-fh-n" data-resize-frame="n"></div>
          <div class="mm-fh mm-fh-ne" data-resize-frame="ne"></div>
          <div class="mm-fh mm-fh-e" data-resize-frame="e"></div>
          <div class="mm-fh mm-fh-se" data-resize-frame="se"></div>
          <div class="mm-fh mm-fh-s" data-resize-frame="s"></div>
          <div class="mm-fh mm-fh-sw" data-resize-frame="sw"></div>
          <div class="mm-fh mm-fh-w" data-resize-frame="w"></div>`;
        this.els.world.insertBefore(el, this.els.svg);
        el.querySelector('.mm-frame-bar').addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.readOnly) return;
          const fr = this.data.frames.find((x) => x.id === el.dataset.id);
          if (fr && fr.locked) return;
          this._drag = null;
          this._beginFrameRename(el.dataset.id);
        });
        el.querySelector('.mm-frame-title').addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.readOnly) return;
          const fr = this.data.frames.find((x) => x.id === el.dataset.id);
          if (fr && fr.locked) return;
          this._drag = null;
          this._beginFrameRename(el.dataset.id);
        });
        el.querySelector('.mm-frame-title').addEventListener('blur', (e) => {
          const fr = this.data.frames.find((x) => x.id === f.id);
          if (fr) {
            fr.title = e.currentTarget.textContent.trim() || 'Frame';
            this._emit();
            this._renderBookmarks();
          }
          e.currentTarget.contentEditable = 'false';
        });
      }
      el.style.left = f.x + 'px';
      el.style.top = f.y + 'px';
      el.style.width = f.w + 'px';
      el.style.height = f.h + 'px';
      el.style.background = hexAlpha(f.fill || '#ffffff', 1);
      el.style.borderColor = f.border || '#c5c9d1';
      el.classList.toggle('selected', this.selectedFrameId === f.id);
      el.classList.toggle('is-locked', !!f.locked);
      el.classList.toggle('is-blocked', !!(this._drag && this._drag.kind === 'draw-frame' && this._drag.tempId === f.id && this._frameWouldOverlap(f)));
      const bar = el.querySelector('.mm-frame-bar');
      if (bar) bar.title = f.locked ? 'Locked · press and hold the name to unlock' : 'Drag to move';
      const top = el.querySelector('.mm-frame-top');
      if (top) top.title = f.locked ? 'Locked · press and hold the name to unlock' : 'Drag to move';
      const lock = el.querySelector('.mm-frame-lock');
      if (lock) lock.title = 'Locked · press and hold to unlock';
      const title = el.querySelector('.mm-frame-title');
      if (title) title.title = f.locked ? 'Locked · press and hold to unlock' : '';
      title.style.color = '#5B7EAE';
      title.style.fontSize = '34px';
      title.style.fontWeight = '800';
      title.style.borderColor = 'rgba(20, 30, 50, 0.12)';
      if (document.activeElement !== title) title.textContent = f.title || 'Frame';
    }

    _renderLinks(svg) {
      const parts = [];
      const hideId = this._drag && this._drag.moved && this._drag.drop ? this._drag.id : null;
      this.nodesArr().forEach((child) => {
        if (!child.parentId) return;
        if (hideId && child.id === hideId) return;
        if (this.hiddenByCollapse(child.id)) return;
        const parent = this.data.nodes[child.parentId];
        if (!parent) return;
        if (parent.collapsedDirs && parent.collapsedDirs[child.dir]) return;
        const a = this._edgePoint(parent, child.dir);
        const b = this._edgePoint(child, OPP[child.dir]);
        const color = resolveVisibleLinkColor(this.data, child, parent, a, b, (x, y) => this._frameAtWorld(x, y));
        const w = child.style.linkWidth || 2.25;
        const dash = linkDash(child.style.linkStyle || parent.style.linkStyle);
        const d = this._bezier(a, b, child.dir, child.style.linkCurve);
        const selected = this.selectedLinkId === child.id;
        parts.push(`<path class="mm-link-hit" data-link="${escapeAttr(child.id)}" d="${d}" fill="none" stroke="transparent" stroke-width="18" stroke-linecap="round"/>`);
        parts.push(`<path class="mm-link-draw${selected ? ' is-selected' : ''}" data-link="${escapeAttr(child.id)}" d="${d}" fill="none" stroke="${escapeAttr(selected ? '#5ea882' : color)}" stroke-width="${selected ? Math.max(w, 3.2) : w}" stroke-linecap="round"${dash && !selected ? ` stroke-dasharray="${escapeAttr(dash)}"` : ''}/>`);
      });
      (this.data.links || []).forEach((l) => {
        const from = this.data.nodes[l.fromId];
        const to = this.data.nodes[l.toId];
        if (!from || !to) return;
        if (this.hiddenByCollapse(from.id) || this.hiddenByCollapse(to.id)) return;
        const dir = l.fromDir || 'right';
        const a = this._edgePoint(from, dir);
        const b = this._edgePoint(to, l.toDir || OPP[dir] || 'left');
        const color = resolveVisibleLinkColor(this.data, from, to, a, b, (x, y) => this._frameAtWorld(x, y));
        const w = (from.style && from.style.linkWidth) || 2.25;
        const dash = linkDash((from.style && from.style.linkStyle) || (to.style && to.style.linkStyle));
        const d = this._bezier(a, b, dir, from.style && from.style.linkCurve);
        const selected = this.selectedLinkId === l.id;
        parts.push(`<path class="mm-link-hit" data-link="${escapeAttr(l.id)}" d="${d}" fill="none" stroke="transparent" stroke-width="18" stroke-linecap="round"/>`);
        parts.push(`<path class="mm-link-draw${selected ? ' is-selected' : ''}" data-link="${escapeAttr(l.id)}" d="${d}" fill="none" stroke="${escapeAttr(selected ? '#5ea882' : color)}" stroke-width="${selected ? Math.max(w, 3.2) : w}" stroke-linecap="round"${dash && !selected ? ` stroke-dasharray="${escapeAttr(dash)}"` : ''}/>`);
      });
      if (this._drag && this._drag.moved && this._drag.drop) {
        const slot = this._drag.drop;
        const parent = this.data.nodes[slot.parentId];
        const child = this.data.nodes[this._drag.id];
        if (parent && child) {
          parts.push(`<path d="${this._dropLinkPath(parent, child, slot.dir)}" fill="none" stroke="#5ea882" stroke-width="2.4" stroke-dasharray="6 5" stroke-linecap="round"/>`);
        }
      }
      if (this._drag && this._drag.kind === 'connect' && this._drag.fromId) {
        const from = this.data.nodes[this._drag.fromId];
        if (from) {
          const dir = this._drag.fromDir || this.nearestSide(from, this._drag.wx, this._drag.wy);
          const a = this._edgePoint(from, dir);
          const to = this._drag.toId && this.data.nodes[this._drag.toId];
          const b = to ? this._edgePoint(to, OPP[dir] || 'left') : { x: this._drag.wx, y: this._drag.wy };
          parts.push(`<path d="${this._bezier(a, b, dir)}" fill="none" stroke="#5ea882" stroke-width="2.4" stroke-linecap="round"/>`);
        }
      }
      svg.innerHTML = parts.join('');
    }

    _edgePoint(node, dir) {
      if (dir === 'right') return { x: node.x + node.w, y: node.y + node.h / 2 };
      if (dir === 'left') return { x: node.x, y: node.y + node.h / 2 };
      if (dir === 'down') return { x: node.x + node.w / 2, y: node.y + node.h };
      return { x: node.x + node.w / 2, y: node.y };
    }

    _outPoint(node, dir, dist) {
      const a = this._edgePoint(node, dir);
      if (dir === 'right') return { x: a.x + dist, y: a.y };
      if (dir === 'left') return { x: a.x - dist, y: a.y };
      if (dir === 'down') return { x: a.x, y: a.y + dist };
      return { x: a.x, y: a.y - dist };
    }

    _clearedSide(parent, child, dir) {
      if (dir === 'right') return child.x >= parent.x + parent.w - 6;
      if (dir === 'left') return child.x + child.w <= parent.x + 6;
      if (dir === 'down') return child.y >= parent.y + parent.h - 6;
      return child.y + child.h <= parent.y + 6;
    }

    _dropLinkPath(parent, child, dir) {
      const a = this._edgePoint(parent, dir);
      const out = this._outPoint(parent, dir, 28);
      if (!this._clearedSide(parent, child, dir) || this._rectsOverlap(parent, child, 4)) {
        return `M ${a.x} ${a.y} L ${out.x} ${out.y}`;
      }
      const b = this._edgePoint(child, OPP[dir]);
      return this._bezier(a, b, dir, child && child.style && child.style.linkCurve);
    }

    _bezier(a, b, dir, curve) {
      const t = clamp(curve == null ? 50 : Number(curve), 0, 100) / 100;
      if (dir === 'right' || dir === 'left') {
        const s = dir === 'right' ? 1 : -1;
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const c = Math.max(52, dx * (0.22 + t * 0.5), Math.min(dy * 0.42, Math.max(dx * 0.85, 52)));
        const e = Math.max(28, Math.min(c, dx * 0.55));
        return `M ${a.x} ${a.y} C ${a.x + s * c} ${a.y}, ${b.x - s * e} ${b.y}, ${b.x} ${b.y}`;
      }
      const s = dir === 'down' ? 1 : -1;
      const dy = Math.abs(b.y - a.y);
      const dx = Math.abs(b.x - a.x);
      const c = Math.max(52, dy * (0.22 + t * 0.5), Math.min(dx * 0.42, Math.max(dy * 0.85, 52)));
      const e = Math.max(28, Math.min(c, dy * 0.55));
      return `M ${a.x} ${a.y} C ${a.x} ${a.y + s * c}, ${b.x} ${b.y - s * e}, ${b.x} ${b.y}`;
    }

    _paintNodeStyles(n) {
      const el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(n.id)}"]`);
      if (!el) return null;
      el.style.background = isTransparent(n.style.fill) ? 'transparent' : n.style.fill;
      el.style.borderColor = isTransparent(n.style.border) ? 'transparent' : (n.style.border || n.style.fill);
      el.style.color = n.style.textColor || '#1a2130';
      const fmt = n.format || defaultFormat();
      el.style.fontWeight = fmt.bold ? '700' : '500';
      el.style.fontStyle = fmt.italic ? 'italic' : 'normal';
      el.style.textDecoration = fmt.underline ? 'underline' : 'none';
      el.style.fontSize = (fmt.fontSize || FONT_SIZE_DEFAULT) + 'px';
      el.style.fontFamily = fontCss(fmt.fontFamily);
      el.style.textAlign = fmt.align || 'center';
      const bodyEl = el.querySelector('.mm-node-body');
      if (bodyEl) {
        bodyEl.style.fontSize = 'inherit';
        bodyEl.style.fontFamily = 'inherit';
        bodyEl.style.color = 'inherit';
        bodyEl.style.fontWeight = 'inherit';
        bodyEl.style.fontStyle = 'inherit';
        bodyEl.style.textDecoration = 'inherit';
      }
      if (this._textEdit && this._textEdit.id === n.id) this._styleTextEditor(n);
      return el;
    }

    _renderNode(n) {
      let el = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(n.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mm-node';
        el.dataset.id = n.id;
        this.els.world.appendChild(el);
      }
      el.dataset.type = n.type;
      const hidden = this.hiddenByCollapse(n.id);
      el.style.display = hidden ? 'none' : '';
      if (hidden) return;
      el.classList.toggle('selected', this.selectedIds.has(n.id) || this.selectedId === n.id);
      el.classList.toggle('is-root', !n.parentId);
      el.classList.toggle('editing', this.editingId === n.id);
      el.classList.toggle('user-sized', !!n.userSized);
      el.classList.toggle('drop-parent', !!(this._drag && this._drag.drop && this._drag.drop.parentId === n.id));
      const dragMoving = this._drag && this._drag.moved && (this._drag.kind === 'node-drag' || this._drag.kind === 'move-subtree' || this._drag.kind === 'move-tree' || this._drag.kind === 'group-drag');
      const inDrag = !!(dragMoving && (this._drag.origins || []).some((o) => o.id === n.id));
      el.classList.toggle('is-dragging', inDrag);
      el.classList.toggle('is-clear', isTransparent(n.style.fill) && isTransparent(n.style.border));
      const locked = this.isNodeLocked(n);
      el.classList.toggle('is-locked', locked);
      el.classList.toggle('has-note-open', !!(n.noteOpen && this._canNote(n)));
      el.title = locked ? 'Locked · press and hold to unlock' : '';
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.width = (n.w || CELL_W) + 'px';
      el.style.height = (n.h || CELL_H) + 'px';
      el.classList.toggle('is-maxw', n.type === 'text' && String(n.content || '').split('\n').some((line) => line.length >= CELL_CHARS));
      this._paintNodeStyles(n);
      const fmt = n.format || defaultFormat();

      const editing = this.editingId === n.id;
      if ((editing && el.querySelector('[data-edit]')) || (this._textEdit && this._textEdit.id === n.id)) return;
      const sig = [
        n.type, n.content, n.label, n.language,
        editing ? 'e' : '',
        this.selectedIds.has(n.id) || this.selectedId === n.id ? 's' : '',
        fmt.fontFamily, fmt.fontSize, fmt.align, fmt.bold, fmt.italic, fmt.underline,
        n.collapsedDirs.left ? 1 : 0, n.collapsedDirs.right ? 1 : 0,
        n.collapsedDirs.up ? 1 : 0, n.collapsedDirs.down ? 1 : 0,
        this.immediateCount(n.id, 'left'), this.immediateCount(n.id, 'right'),
        this.immediateCount(n.id, 'up'), this.immediateCount(n.id, 'down'),
        locked ? 'L' : '',
        n.noteOpen ? 'no' : '',
        (n.note || '').length,
        n.parentId ? '' : 'root',
        global.hljs ? 'hl' : '',
      ].join('|');
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      el.innerHTML = this._nodeInner(n);
      this._bindNodeButtons(el, n);
      const editor = el.querySelector('[data-edit]');
      if (editor && (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') && document.activeElement !== editor) {
        editor.value = n.content || '';
      }
      const bodyAfter = el.querySelector('.mm-node-body');
      if (bodyAfter) {
        bodyAfter.style.fontSize = 'inherit';
        bodyAfter.style.fontFamily = 'inherit';
        bodyAfter.style.color = 'inherit';
        bodyAfter.style.fontWeight = 'inherit';
        bodyAfter.style.fontStyle = 'inherit';
        bodyAfter.style.textDecoration = 'inherit';
      }
    }

    _nodeInner(n) {
      const editing = this.editingId === n.id;
      const locked = this.isNodeLocked(n);
      let body = '';
      if (n.type === 'code') {
        const opts = CODE_LANGS.map((l) => `<option value="${l}"${n.language === l ? ' selected' : ''}>${l}</option>`).join('');
        body = `<div class="mm-code-head"><span>Code</span><select data-lang>${opts}</select></div>`;
        if (editing) body += `<textarea class="mm-code-edit" data-edit>${escapeHtml(n.content)}</textarea>`;
        else body += `<pre class="mm-code${n.language === 'plaintext' ? ' is-plain' : ''}"><code>${highlightCode(n.content || '', n.language)}</code></pre>`;
      } else if (n.type === 'youtube') {
        const vid = youtubeId(n.content);
        body = `<div class="mm-node-chrome">YouTube</div>`;
        if (editing || !vid) {
          body += `<input class="mm-yt-input" data-edit placeholder="Paste YouTube URL" value="${escapeAttr(n.content)}"/>`;
        }
        if (vid) {
          body += `<button type="button" class="mm-yt-play" data-play-yt="${escapeAttr(vid)}" title="Play video">
            <img class="mm-yt-thumb" alt="" src="https://i.ytimg.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg" draggable="false" decoding="async"/>
            <span class="mm-yt-play-btn" aria-hidden="true"></span>
          </button>`;
        }
      } else if (n.type === 'image') {
        const src = safeImageSrc(n.content);
        body = '';
        if (editing || !src) {
          body += `<div class="mm-img-tools">
            <input class="mm-yt-input mm-img-input" data-edit placeholder="Paste image URL" value="${escapeAttr(n.content)}"/>
            <label class="mm-img-file">Choose file<input type="file" accept="image/*" data-img-file hidden /></label>
          </div>`;
        }
        if (src) {
          body += `<button type="button" class="mm-img-box" data-open-img="${escapeAttr(src)}" title="Open image"><img class="mm-img-frame" alt="" src="${escapeAttr(src)}" draggable="false"/></button>`;
          body += `<div class="mm-img-rh mm-img-rh-nw" data-img-resize="nw" title="Resize"></div>
            <div class="mm-img-rh mm-img-rh-ne" data-img-resize="ne" title="Resize"></div>
            <div class="mm-img-rh mm-img-rh-se" data-img-resize="se" title="Resize"></div>
            <div class="mm-img-rh mm-img-rh-sw" data-img-resize="sw" title="Resize"></div>`;
        }
      } else if (n.type === 'link') {
        body = `<div class="mm-node-chrome">Link</div>`;
        if (editing) {
          body += `<input class="mm-link-input" data-label placeholder="Label" value="${escapeAttr(n.label || '')}"/>`;
          body += `<input class="mm-link-input" data-edit placeholder="https://…" value="${escapeAttr(n.content)}"/>`;
        } else {
          const href = safeHttpUrl(n.content);
          const text = escapeHtml(linkCardLabel(n));
          body += `<div class="mm-link-row">`;
          if (href) {
            body += `<a class="mm-link-anchor" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" data-open-link>${text}</a>`;
          } else {
            body += `<div class="mm-link-anchor is-empty">${text}</div>`;
          }
          body += `<button type="button" class="mm-link-open" data-open-link title="Open in new tab">↗</button></div>`;
        }
      } else {
        body = `<div class="mm-node-body">${escapeHtml(n.content || '')}</div>`;
      }

      const ports = DIRS.map((d) => {
        const count = this.immediateCount(n.id, d);
        const collapsed = !!(n.collapsedDirs && n.collapsedDirs[d]);
        const hoverAdd = d === 'left' || d === 'right';
        const add = (!locked && !collapsed && hoverAdd)
          ? `<button type="button" class="mm-handle" data-add="${d}" title="Add ${d}">+</button>`
          : '';
        let badge = '';
        if (count) {
          if (collapsed) {
            badge = `<button type="button" class="mm-badge is-collapsed" data-toggle="${d}" title="Expand ${d}">${count}</button>`;
          } else if (hoverAdd) {
            badge = `<button type="button" class="mm-handle mm-collapse" data-toggle="${d}" title="Collapse ${d}">−</button>`;
          }
        }
        if (!add && !badge) return '';
        return `<div class="mm-ports mm-ports-${d}${collapsed ? ' has-collapsed' : ''}">${add}${badge}</div>`;
      }).join('');
      const dots = locked ? '' : RELINK_DIRS.map((d) => (
        `<button type="button" class="mm-edge-dot mm-edge-dot-${d}" data-connect="${d}" title="Drag to connect ${d}"></button>`
      )).join('');
      return body + ports + dots + this._noteChromeHtml(n) + (locked ? '<span class="mm-node-lock" title="Locked · press and hold to unlock"></span>' : '<div class="mm-resize" data-resize title="Resize"></div>');
    }

    _portSideAt(el, clientX, clientY) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = clientX - r.left;
      return x < r.width / 2 ? 'left' : 'right';
    }

    _setNodePortSide(el, side) {
      DIRS.forEach((d) => {
        el.classList.toggle('ports-side-' + d, d === side);
        const p = el.querySelector('.mm-ports-' + d);
        if (p) p.classList.toggle('is-hot', d === side);
      });
      el.classList.toggle('ports-hot', !!side);
    }

    _bindNodeButtons(el, n) {
      const setSide = (side) => {
        clearTimeout(el._portsHide);
        this._setNodePortSide(el, side);
      };
      const fromEvent = (e) => {
        if (this._ignorePortClick || this.els.root.classList.contains('is-linking') || (this._drag && this._drag.kind === 'connect')) return;
        setSide(this._portSideAt(el, e.clientX, e.clientY));
      };
      const releasePorts = () => {
        clearTimeout(el._portsHide);
        el._portsHide = setTimeout(() => this._setNodePortSide(el, null), 420);
      };
      el.addEventListener('pointerenter', fromEvent);
      el.addEventListener('pointermove', fromEvent);
      el.addEventListener('pointerleave', releasePorts);
      el.querySelectorAll('.mm-ports').forEach((p) => {
        const d = DIRS.find((s) => p.classList.contains('mm-ports-' + s));
        p.addEventListener('pointerenter', () => setSide(d));
        p.addEventListener('pointermove', () => setSide(d));
        p.addEventListener('pointerleave', releasePorts);
      });
      el.querySelectorAll('[data-add]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
          if (this._ignorePortClick || this.els.root.classList.contains('is-linking') || (this._drag && this._drag.kind === 'connect')) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          e.stopPropagation();
          e.preventDefault();
          this.commitEdit();
          const child = this.addChild(n.id, btn.getAttribute('data-add'));
          if (child) this.startEdit(child.id);
        });
      });
      el.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.toggleCollapse(n.id, btn.getAttribute('data-toggle'));
        });
      });
      el.querySelectorAll('[data-open-link]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._openLink(n.content);
        });
      });
      el.querySelectorAll('[data-play-yt]').forEach((btn) => {
        btn.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      el.querySelectorAll('[data-open-img]').forEach((btn) => {
        btn.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      el.querySelectorAll('[data-note-toggle]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._toggleNote(n);
        });
      });
      const noteBody = el.querySelector('[data-note-body]');
      if (noteBody) {
        noteBody.addEventListener('pointerdown', (e) => e.stopPropagation());
        noteBody.addEventListener('mousedown', (e) => e.stopPropagation());
        noteBody.readOnly = this.readOnly;
        noteBody.addEventListener('input', () => {
          if (this.readOnly) return;
          n.note = noteBody.value;
          this._emit();
        });
        noteBody.addEventListener('keydown', (e) => e.stopPropagation());
        if (n.type === 'youtube') {
          noteBody.addEventListener('click', () => {
            const sec = timestampAtCaret(noteBody.value, noteBody.selectionStart);
            if (sec == null) return;
            this._openYoutube(n.content, n, sec);
          });
        }
      }
      const lang = el.querySelector('[data-lang]');
      if (lang) {
        lang.addEventListener('change', () => {
          n.language = lang.value;
          this._emit();
          this.render();
        });
        lang.addEventListener('pointerdown', (e) => e.stopPropagation());
      }
      const yt = el.querySelector('.mm-yt-input');
      if (yt) {
        const applyYt = () => {
          const val = String(yt.value || '').trim();
          if (!youtubeId(val)) return false;
          n.content = val;
          n.w = YT_W;
          n.h = YT_H;
          this.editingId = null;
          this.els.formatBar.classList.remove('open');
          delete el.dataset.sig;
          if (n.parentId && this.data.nodes[n.parentId]) this._layoutSide(this.data.nodes[n.parentId], n.dir);
          this.render();
          this._emit();
          return true;
        };
        yt.addEventListener('paste', () => setTimeout(applyYt, 0));
        yt.addEventListener('change', applyYt);
        yt.addEventListener('input', () => { if (youtubeId(yt.value)) applyYt(); });
        yt.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!applyYt()) this.commitEdit();
          }
        });
        yt.addEventListener('pointerdown', (e) => e.stopPropagation());
      }
      const imgInp = el.querySelector('.mm-img-input');
      if (imgInp) {
        const applyImg = (raw) => {
          const src = safeImageSrc(raw);
          if (!src) return false;
          n.content = src;
          if (!n.userSized) {
            n.w = IMG_W;
            n.h = IMG_H;
          }
          this.editingId = null;
          this.els.formatBar.classList.remove('open');
          delete el.dataset.sig;
          if (n.parentId && this.data.nodes[n.parentId]) this._layoutSide(this.data.nodes[n.parentId], n.dir);
          this.render();
          this._emit();
          return true;
        };
        imgInp.addEventListener('paste', (e) => {
          const file = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
          if (file) {
            e.preventDefault();
            fileToImageDataUrl(file).then((src) => applyImg(src)).catch(() => {});
            return;
          }
          setTimeout(() => applyImg(imgInp.value), 0);
        });
        imgInp.addEventListener('change', () => applyImg(imgInp.value));
        imgInp.addEventListener('input', () => { if (safeImageSrc(imgInp.value)) applyImg(imgInp.value); });
        imgInp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!applyImg(imgInp.value)) this.commitEdit();
          }
        });
        imgInp.addEventListener('pointerdown', (e) => e.stopPropagation());
      }
      const imgFile = el.querySelector('[data-img-file]');
      if (imgFile) {
        const lab = imgFile.closest('.mm-img-file');
        if (lab) lab.addEventListener('pointerdown', (e) => e.stopPropagation());
        imgFile.addEventListener('pointerdown', (e) => e.stopPropagation());
        imgFile.addEventListener('click', (e) => e.stopPropagation());
        imgFile.addEventListener('change', () => {
          const file = imgFile.files && imgFile.files[0];
          if (!file) return;
          fileToImageDataUrl(file).then((src) => {
            n.content = src;
            if (!n.userSized) {
              n.w = IMG_W;
              n.h = IMG_H;
            }
            this.editingId = null;
            delete el.dataset.sig;
            if (n.parentId && this.data.nodes[n.parentId]) this._layoutSide(this.data.nodes[n.parentId], n.dir);
            this.render();
            this._emit();
          }).catch(() => {});
        });
      }
      const imgEl = el.querySelector('.mm-img-frame');
      if (imgEl) {
        const captureAspect = () => {
          const node = this.data.nodes[n.id];
          if (!node || node.imgAspect || this._drag || !imgEl.naturalWidth || !imgEl.naturalHeight) return;
          node.imgAspect = imgEl.naturalWidth / imgEl.naturalHeight;
          if (!node.userSized) {
            this._setImageSize(node, node.w || IMG_W, false);
            this._relayoutNode(node);
            this.render();
          }
        };
        imgEl.addEventListener('load', captureAspect);
        if (imgEl.complete) captureAspect();
      }
      el.querySelectorAll('[data-img-resize]').forEach((h) => {
        h.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this._beginNodeResize(e, this.data.nodes[n.id] || n, h.getAttribute('data-img-resize'));
        });
      });
      el.querySelectorAll('.mm-link-input').forEach((inp) => {
        const applyLink = () => {
          if (inp.hasAttribute('data-edit')) n.content = String(inp.value || '').trim();
          if (inp.hasAttribute('data-label')) n.label = String(inp.value || '').trim();
          const href = safeHttpUrl(n.content);
          if (href) n.content = href;
          if (!n.label) n.label = prettyLinkLabel(n.content);
          this._fitLinkNode(n);
          if (n.parentId && this.data.nodes[n.parentId]) this._layoutSide(this.data.nodes[n.parentId], n.dir);
          this.render();
          this._emit();
        };
        inp.addEventListener('paste', () => setTimeout(applyLink, 0));
        inp.addEventListener('change', applyLink);
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyLink();
            this.commitEdit();
          }
        });
        inp.addEventListener('pointerdown', (e) => e.stopPropagation());
      });
    }

    _syncSizes(opts) {
      if (this._destroyed || this.editingId || this._drag) return;
      let changed = false;
      const grown = [];
      this.els.world.querySelectorAll('.mm-node').forEach((el) => {
        const n = this.data.nodes[el.dataset.id];
        if (!n || n.userSized || this.hiddenByCollapse(n.id)) return;
        if (n.type === 'youtube') {
          if (this._setNodeSize(n, YT_W, YT_H)) {
            changed = true;
            grown.push(n);
          }
          return;
        }
        if (n.type === 'image') {
          if (!n.userSized && this._setNodeSize(n, IMG_W, IMG_H)) {
            changed = true;
            grown.push(n);
          }
          return;
        }
        if (n.type === 'link') {
          if (this._fitLinkNode(n)) {
            changed = true;
            grown.push(n);
          }
          return;
        }
        if (this._fitAutoNode(n)) {
          changed = true;
          grown.push(n);
        }
      });
      // A node that changed size can now overlap its siblings: re-lay out
      // each affected side. addChild passes preserveLayout and does its own.
      if (grown.length && !(opts && opts.preserveLayout)) this._relayoutAround(grown);
      if (changed) {
        this._measuring = true;
        this.render();
        this._measuring = false;
      }
    }

    // Re-pack the parent side of each node (once per parent+side).
    _relayoutAround(nodes) {
      const done = new Set();
      nodes.forEach((n) => {
        if (!n || !n.parentId || !n.dir) return;
        const key = n.parentId + '|' + n.dir;
        if (done.has(key)) return;
        done.add(key);
        const parent = this.data.nodes[n.parentId];
        if (parent) this._layoutSide(parent, n.dir);
      });
    }

    _measureDomThenLayout() {
      this._syncSizes();
      if (this.editingId) this.render();
    }

    _updateFrameInspector() {
      const f = (this.data.frames || []).find((x) => x.id === this.selectedFrameId);
      const box = this.els.inspector;
      const sep = this.els.inspSep;
      if (!f) {
        this._closeColorDrops();
        box.classList.remove('show', 'is-locked');
        sep.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      box.classList.add('show');
      box.classList.toggle('is-locked', !!f.locked);
      sep.style.display = '';
      const keepKind = this._activeColorDropKind();
      this._dockColorPanels();
      const fills = NODE_PALETTE.map((c) => `<button type="button" class="mm-color${f.fill === c ? ' active' : ''}" data-frame-fill="${c}" style="background:${c}" title="Frame fill"></button>`).join('');
      box.innerHTML = `
        <span class="mm-group-count">Frame</span>
        ${colorDropHtml('fill', 'Fill', f.fill || '#ffffff', fills, colorCustomRow('frame-custom', f.fill || '#ffffff', '#ffffff'))}
        <button type="button" data-frame-lock title="${f.locked ? 'Unlock frame' : 'Lock frame'}">${f.locked ? 'Unlock' : 'Lock'}</button>
      `;
      this._bindColorDrops(box);
      box.querySelectorAll('[data-frame-fill]').forEach((b) => {
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.applyFrameColor(f.id, b.getAttribute('data-frame-fill'));
        });
      });
      this._bindCustomColor(box, 'frame-custom', (v) => this.applyFrameColor(f.id, v));
      const lockBtn = box.querySelector('[data-frame-lock]');
      if (lockBtn) {
        lockBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleFrameLock(f.id);
        });
      }
      this._restoreColorDrop(box, keepKind);
    }

    _updateInspector() {
      if (this.selectedFrameId && !this.selectedList().length) {
        this._updateFrameInspector();
        return;
      }
      const ids = this.selectedList();
      const box = this.els.inspector;
      const sep = this.els.inspSep;
      if (!ids.length) {
        this._closeColorDrops();
        box.classList.remove('show', 'is-locked');
        sep.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      const n = this.data.nodes[this.selectedId] || this.data.nodes[ids[0]];
      if (!n) {
        this._closeColorDrops();
        box.classList.remove('show', 'is-locked');
        sep.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      const group = ids.length > 1;
      const fillEq = ids.every((id) => this.data.nodes[id].style.fill === n.style.fill);
      const borderEq = ids.every((id) => this.data.nodes[id].style.border === n.style.border);
      const textEq = ids.every((id) => this.data.nodes[id].style.textColor === n.style.textColor);
      const linkEq = ids.every((id) => this.data.nodes[id].style.linkColor === n.style.linkColor);
      const styleEq = ids.every((id) => (this.data.nodes[id].style.linkStyle || 'solid') === (n.style.linkStyle || 'solid'));
      const anyUnlocked = ids.some((id) => this.data.nodes[id] && !this.isNodeLocked(id));
      box.classList.add('show');
      box.classList.toggle('is-locked', !anyUnlocked);
      sep.style.display = '';
      const keepKind = this._activeColorDropKind();
      this._dockColorPanels();
      const typeOpts = [
        ['text', 'Text'],
        ['code', 'Code'],
        ['youtube', 'YouTube'],
        ['image', 'Image'],
        ['link', 'Link'],
      ].map(([t, label]) => `<option value="${t}"${n.type === t ? ' selected' : ''}>${label}</option>`).join('');
      const fills = transparentSwatch(fillEq && isTransparent(n.style.fill), 'data-fill="transparent"') + NODE_PALETTE.map((c) => `<button type="button" class="mm-color${fillEq && n.style.fill === c ? ' active' : ''}" data-fill="${c}" style="background:${c}" title="Fill"></button>`).join('');
      const borders = transparentSwatch(borderEq && isTransparent(n.style.border), 'data-border="transparent"') + NODE_PALETTE.map((c) => `<button type="button" class="mm-color${borderEq && n.style.border === c ? ' active' : ''}" data-border="${c}" style="background:${c}" title="Border"></button>`).join('');
      const texts = TEXT_PALETTE.map((c) => `<button type="button" class="mm-color${textEq && (n.style.textColor || '').toLowerCase() === c.toLowerCase() ? ' active' : ''}" data-text="${c}" style="background:${c}" title="Text"></button>`).join('');
      const links = LINK_PALETTE.map((c) => `<button type="button" class="mm-color${linkEq && n.style.linkColor === c ? ' active' : ''}" data-link="${c}" style="background:${c}" title="Line"></button>`).join('');
      const dashes = LINK_STYLES.map((s) => `<button type="button" data-insp="link-style" data-style="${s.id}" class="mm-link-style${styleEq && (n.style.linkStyle || 'solid') === s.id ? ' active' : ''}" title="${s.label}">${s.id === 'solid' ? '━' : s.id === 'dotted' ? '···' : s.id === 'dashed' ? '╍' : '┈'}</button>`).join('');
      const align = n.format.align || 'center';
      const allBold = ids.every((id) => this.data.nodes[id].format.bold);
      const allItalic = ids.every((id) => this.data.nodes[id].format.italic);
      const allUnder = ids.every((id) => this.data.nodes[id].format.underline);
      box.innerHTML = `
        ${group ? `<span class="mm-group-count">${ids.length} selected</span>` : ''}
        <button type="button" data-insp="lock" title="${anyUnlocked ? 'Lock selected' : 'Unlock selected'}">${anyUnlocked ? 'Lock' : 'Unlock'}</button>
        ${ids.some((id) => this._canNote(this.data.nodes[id])) ? `<button type="button" data-insp="notes" class="${n.noteOpen ? 'active' : ''}" title="Add a note">${n.note && n.note.trim() ? 'Notes' : 'Add note'}</button>` : ''}
        <select data-insp="type" title="Cell type">${typeOpts}</select>
        <button type="button" data-insp="bold" class="${allBold ? 'active' : ''}" title="Bold"><b>B</b></button>
        <button type="button" data-insp="italic" class="${allItalic ? 'active' : ''}" title="Italic"><i>I</i></button>
        <button type="button" data-insp="underline" class="${allUnder ? 'active' : ''}" title="Underline"><u>U</u></button>
        ${fontSelectHtml(n.format.fontFamily, 'data-insp="font"')}
        ${sizeSelectHtml(n.format.fontSize, 'data-insp="size"')}
        <button type="button" data-insp="align-left" class="${align === 'left' ? 'active' : ''}" title="Align left">L</button>
        <button type="button" data-insp="align-center" class="${align === 'center' ? 'active' : ''}" title="Align center">C</button>
        <button type="button" data-insp="align-right" class="${align === 'right' ? 'active' : ''}" title="Align right">R</button>
        <span class="mm-sep"></span>
        ${colorDropHtml('fill', 'Fill', fillEq ? n.style.fill : '', fills, colorCustomRow('fill-custom', n.style.fill, '#D7E3FC'))}
        ${colorDropHtml('border', 'Border', borderEq ? n.style.border : '', borders, colorCustomRow('border-custom', n.style.border, '#D7E3FC'))}
        ${colorDropHtml('text', 'Text', textEq ? n.style.textColor : '', texts, colorCustomRow('text-custom', n.style.textColor, '#1a2130'))}
        ${colorDropHtml('line', 'Line', linkEq ? n.style.linkColor : '', links, colorCustomRow('link-custom', n.style.linkColor, '#8AA8D4') + `<div class="mm-color-panel-head">Style</div><div class="mm-swatches">${dashes}</div><div class="mm-color-panel-head">Curve</div><label class="mm-link-curve">Curve <input type="range" min="0" max="100" data-insp="link-curve" value="${clamp(Number(n.style.linkCurve != null ? n.style.linkCurve : 50), 0, 100)}"><span>${clamp(Number(n.style.linkCurve != null ? n.style.linkCurve : 50), 0, 100)}</span></label>`)}
      `;
      const each = (fn) => {
        this._runBatch(() => ids.forEach((id) => fn(id)));
        this.render();
        this._emit();
        requestAnimationFrame(() => { if (!this._destroyed) this._syncSizes(); });
      };
      this._bindColorDrops(box);
      box.querySelector('[data-insp="type"]').addEventListener('change', (e) => each((id) => this.setNodeType(id, e.target.value)));
      box.querySelector('[data-insp="bold"]').addEventListener('click', () => this._groupToggleFormat('bold'));
      box.querySelector('[data-insp="italic"]').addEventListener('click', () => this._groupToggleFormat('italic'));
      box.querySelector('[data-insp="underline"]').addEventListener('click', () => this._groupToggleFormat('underline'));
      box.querySelector('[data-insp="font"]').addEventListener('change', (e) => each((id) => this.applyFormat(id, { fontFamily: e.target.value })));
      box.querySelector('[data-insp="size"]').addEventListener('change', (e) => each((id) => this.applyFormat(id, { fontSize: Number(e.target.value) })));
      box.querySelector('[data-insp="align-left"]').addEventListener('click', () => each((id) => this.applyFormat(id, { align: 'left' })));
      box.querySelector('[data-insp="align-center"]').addEventListener('click', () => each((id) => this.applyFormat(id, { align: 'center' })));
      box.querySelector('[data-insp="align-right"]').addEventListener('click', () => each((id) => this.applyFormat(id, { align: 'right' })));
      const pick = (sel, fn) => {
        box.querySelectorAll(sel).forEach((b) => {
          b.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fn(b);
          });
        });
      };
      pick('[data-fill]', (b) => each((id) => this.applyFillColor(id, b.getAttribute('data-fill'))));
      pick('[data-border]', (b) => each((id) => this.applyBorderColor(id, b.getAttribute('data-border'))));
      pick('[data-text]', (b) => each((id) => this.applyTextColor(id, b.getAttribute('data-text'))));
      pick('[data-link]', (b) => each((id) => this.applyLinkColor(id, b.getAttribute('data-link'))));
      pick('[data-insp="link-style"]', (b) => each((id) => this.applyLinkStyle(id, b.getAttribute('data-style'))));
      const curveEl = box.querySelector('[data-insp="link-curve"]');
      if (curveEl) {
        curveEl.addEventListener('input', (e) => {
          const v = clamp(Number(e.target.value), 0, 100);
          const span = e.target.parentElement && e.target.parentElement.querySelector('span');
          if (span) span.textContent = String(v);
          ids.forEach((id) => {
            const node = this.data.nodes[id];
            if (node && node.style) node.style.linkCurve = v;
          });
          this._renderLinks(this.els.svg);
          this._emit();
        });
      }
      this._bindCustomColor(box, 'fill-custom', (v) => each((id) => this.applyFillColor(id, v)));
      this._bindCustomColor(box, 'border-custom', (v) => each((id) => this.applyBorderColor(id, v)));
      this._bindCustomColor(box, 'text-custom', (v) => each((id) => this.applyTextColor(id, v)));
      this._bindCustomColor(box, 'link-custom', (v) => each((id) => this.applyLinkColor(id, v)));
      const lockBtn = box.querySelector('[data-insp="lock"]');
      if (lockBtn) {
        lockBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (anyUnlocked) ids.forEach((id) => this.lockNode(id));
          else ids.forEach((id) => this.unlockNode(id));
        });
      }
      const notesBtn = box.querySelector('[data-insp="notes"]');
      if (notesBtn) {
        notesBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._toggleNote(n);
        });
      }
      this._restoreColorDrop(box, keepKind);
    }

    _isColorUi(el) {
      if (!el) return false;
      if (el.type === 'color') return true;
      if (!el.closest) return false;
      return !!(el.closest('.mm-color-layer')
        || el.closest('.mm-color-panel')
        || el.closest('.mm-color-drop')
        || el.closest('.mm-color-custom-row')
        || el.closest('.mm-color-custom-well'));
    }

    _beginColorPick(fromEl) {
      this._colorPicking = true;
      this._colorPickAt = Date.now();
      if (fromEl && fromEl.closest) {
        const item = fromEl.closest('.has-sub');
        if (item) item.classList.add('open', 'is-picking');
      }
    }

    _endColorPick() {
      this._colorPicking = false;
      if (this.els.menu) {
        this.els.menu.querySelectorAll('.has-sub.is-picking').forEach((el) => el.classList.remove('is-picking'));
      }
    }

    _bindColorDrops(box) {
      box.querySelectorAll('[data-insp-drop]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const drop = btn.closest('.mm-color-drop');
          const was = drop.classList.contains('open');
          this._closeColorDrops();
          if (was) return;
          drop.classList.add('open');
          this._placeColorPanel(drop);
        });
      });
    }

    _activeColorDropKind() {
      const open = this.els.inspector && this.els.inspector.querySelector('.mm-color-drop.open');
      if (open) return open.getAttribute('data-drop');
      const panel = this.els.colorLayer && this.els.colorLayer.querySelector('.mm-color-panel.is-open');
      return panel ? panel.getAttribute('data-for-drop') : null;
    }

    _dockColorPanels() {
      if (!this.els.colorLayer) return;
      [...this.els.colorLayer.querySelectorAll('.mm-color-panel')].forEach((panel) => {
        panel.classList.remove('is-open');
        const kind = panel.getAttribute('data-for-drop');
        const drop = this.els.inspector && this.els.inspector.querySelector(`.mm-color-drop[data-drop="${kind}"]`);
        if (drop) drop.appendChild(panel);
        else panel.remove();
      });
    }

    _placeColorPanel(drop) {
      const btn = drop.querySelector('[data-insp-drop]');
      let panel = drop.querySelector('.mm-color-panel');
      if (!panel && this.els.colorLayer) {
        panel = this.els.colorLayer.querySelector(`.mm-color-panel[data-for-drop="${drop.getAttribute('data-drop')}"]`);
      }
      if (!btn || !panel || !this.els.colorLayer) return;
      const kind = drop.getAttribute('data-drop') || '';
      panel.setAttribute('data-for-drop', kind);
      panel.classList.add('is-open');
      this.els.colorLayer.appendChild(panel);
      const r = btn.getBoundingClientRect();
      const width = Math.max(panel.offsetWidth || 248, 248);
      const height = Math.max(panel.offsetHeight || 220, 80);
      let left = r.left;
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
      let top = r.bottom + 8;
      if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 8);
      panel.style.position = 'fixed';
      panel.style.top = top + 'px';
      panel.style.left = left + 'px';
      panel.style.zIndex = '90';
    }

    _closeColorDrops() {
      this._endColorPick();
      this._dockColorPanels();
      if (!this.els.inspector) return;
      this.els.inspector.querySelectorAll('.mm-color-drop.open').forEach((d) => d.classList.remove('open'));
    }

    _restoreColorDrop(box, kind) {
      if (!kind) return;
      const d = box.querySelector(`.mm-color-drop[data-drop="${kind}"]`);
      if (!d) return;
      d.classList.add('open');
      this._placeColorPanel(d);
    }

    _bindCustomColor(box, insp, apply) {
      const picker = box.querySelector(`input[type="color"][data-insp="${insp}"]`);
      const hex = box.querySelector(`[data-insp-hex="${insp}"]`);
      if (!picker && !hex) return;
      const row = (picker && picker.closest('.mm-color-custom-row')) || (hex && hex.closest('.mm-color-custom-row'));
      const start = (fromEl) => this._beginColorPick(fromEl || picker || hex);
      const finish = () => {
        this._endColorPick();
        if (!this._destroyed) this._updateInspector();
      };
      const applyVal = (raw) => {
        const color = parseHexColor(raw) || (/^#/.test(raw) ? raw : '');
        if (!color) return;
        start();
        apply(color);
        const norm = parseHexColor(color);
        if (norm) {
          if (picker) picker.value = norm;
          if (hex && document.activeElement !== hex) hex.value = norm;
        }
      };
      if (row) {
        row.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          start(row);
        }, true);
        row.addEventListener('mousedown', (e) => e.stopPropagation());
        row.addEventListener('click', (e) => e.stopPropagation());
      }
      if (picker) {
        picker.addEventListener('pointerdown', (e) => { e.stopPropagation(); start(picker); });
        picker.addEventListener('click', (e) => e.stopPropagation());
        picker.addEventListener('input', (e) => applyVal(e.target.value));
        picker.addEventListener('change', finish);
        picker.addEventListener('cancel', () => this._endColorPick());
      }
      if (hex) {
        hex.addEventListener('pointerdown', (e) => { e.stopPropagation(); start(hex); });
        hex.addEventListener('focus', () => start(hex));
        hex.addEventListener('input', (e) => {
          const color = parseHexColor(e.target.value);
          if (color) applyVal(color);
        });
        hex.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const color = parseHexColor(hex.value);
          if (color) applyVal(color);
        });
      }
    }

    _hideFormatBar() {
      this._fmtBarFor = null;
      if (this.els.formatBar) this.els.formatBar.classList.remove('open');
    }

    _buildFormatBar(n) {
      const bar = this.els.formatBar;
      this._fmtBarFor = n.id;
      bar.innerHTML = `
        <button type="button" data-fmt="bold" class="${n.format.bold ? 'active' : ''}"><b>B</b></button>
        <button type="button" data-fmt="italic" class="${n.format.italic ? 'active' : ''}"><i>I</i></button>
        <button type="button" data-fmt="underline" class="${n.format.underline ? 'active' : ''}"><u>U</u></button>
        ${fontSelectHtml(n.format.fontFamily, 'data-fmt="font"')}
        ${sizeSelectHtml(n.format.fontSize, 'data-fmt="size"')}
        <input type="color" data-fmt="text" value="${colorInputValue(n.style.textColor, '#1a2130')}" title="Text color" style="width:22px;height:22px;border:none;background:transparent;cursor:pointer"/>
        <button type="button" data-fmt="align-left" class="${(n.format.align || 'center') === 'left' ? 'active' : ''}">L</button>
        <button type="button" data-fmt="align-center" class="${(n.format.align || 'center') === 'center' ? 'active' : ''}">C</button>
        <button type="button" data-fmt="align-right" class="${(n.format.align || 'center') === 'right' ? 'active' : ''}">R</button>
        <button type="button" data-fmt="smaller">A−</button>
        <button type="button" data-fmt="larger">A+</button>
      `;
      const syncBtns = () => {
        bar.querySelectorAll('[data-fmt]').forEach((btn) => {
          const act = btn.getAttribute('data-fmt');
          if (act === 'bold') btn.classList.toggle('active', !!n.format.bold);
          if (act === 'italic') btn.classList.toggle('active', !!n.format.italic);
          if (act === 'underline') btn.classList.toggle('active', !!n.format.underline);
          if (act === 'align-left') btn.classList.toggle('active', (n.format.align || 'center') === 'left');
          if (act === 'align-center') btn.classList.toggle('active', (n.format.align || 'center') === 'center');
          if (act === 'align-right') btn.classList.toggle('active', (n.format.align || 'center') === 'right');
        });
      };
      const keepFocus = () => {
        const ta = this._textEdit && this._textEdit.el;
        if (ta && document.activeElement !== ta) ta.focus();
      };
      bar.querySelectorAll('button, select').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        if (btn.tagName === 'SELECT') {
          btn.addEventListener('change', (e) => {
            const act = btn.getAttribute('data-fmt');
            if (act === 'font') this.applyFormat(n.id, { fontFamily: e.target.value });
            if (act === 'size') this.applyFormat(n.id, { fontSize: Number(e.target.value) });
            keepFocus();
          });
          return;
        }
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const act = btn.getAttribute('data-fmt');
          if (act === 'bold') this.applyFormat(n.id, { bold: !n.format.bold });
          if (act === 'italic') this.applyFormat(n.id, { italic: !n.format.italic });
          if (act === 'underline') this.applyFormat(n.id, { underline: !n.format.underline });
          if (act === 'smaller') this.applyFormat(n.id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) - 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
          if (act === 'larger') this.applyFormat(n.id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) + 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
          if (act === 'align-left') this.applyFormat(n.id, { align: 'left' });
          if (act === 'align-center') this.applyFormat(n.id, { align: 'center' });
          if (act === 'align-right') this.applyFormat(n.id, { align: 'right' });
          syncBtns();
          keepFocus();
        });
      });
      const textInp = bar.querySelector('[data-fmt="text"]');
      if (textInp) {
        textInp.addEventListener('mousedown', (e) => e.stopPropagation());
        textInp.addEventListener('input', (e) => {
          const next = e.target.value;
          if (next === colorInputValue(n.style.textColor, '#1a2130')) return;
          this.applyTextColor(n.id, next);
        });
      }
    }

    _moveFormatBar() {
      const bar = this.els.formatBar;
      if (!bar.classList.contains('open') || !this.editingId) return;
      const nodeEl = this.els.world.querySelector(`.mm-node[data-id="${CSS.escape(this.editingId)}"]`);
      if (!nodeEl) return;
      const nr = nodeEl.getBoundingClientRect();
      const cr = this.els.root.getBoundingClientRect();
      bar.style.left = (nr.left - cr.left + nr.width / 2 - 80) + 'px';
      bar.style.top = (nr.top - cr.top - 44) + 'px';
    }

    _positionFormatBar() {
      const n = this.data.nodes[this.editingId];
      if (!n || n.type !== 'text') {
        this._hideFormatBar();
        return;
      }
      if (this._fmtBarFor !== n.id) this._buildFormatBar(n);
      this.els.formatBar.classList.add('open');
      this._moveFormatBar();
    }

    _onToolbarClick(e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'tool-frame') this._setTool(this.tool === 'frame' ? 'select' : 'frame');
      if (act === 'tool-connect') this._setTool(this.tool === 'connect' ? 'select' : 'connect');
      if (act === 'add-root') this.addNewRoot();
      if (act === 'undo') this.undo();
      if (act === 'redo') this.redo();
      if (act === 'zoom-in') this.setZoom(this.data.viewport.zoom * 1.12);
      if (act === 'zoom-out') this.setZoom(this.data.viewport.zoom / 1.12);
      if (act === 'fit') this.fitView(true);
      if (act === 'fullscreen') this.toggleFullscreen();
      if (act === 'export') {
        if (this.els.bookmarks) this.els.bookmarks.classList.remove('open');
        this.els.exportMenu.classList.toggle('open');
      }
    }

    _setTool(tool) {
      this.tool = tool;
      this._connectFrom = null;
      this.els.root.dataset.tool = tool;
      this.els.toolbar.querySelectorAll('[data-act="tool-select"],[data-act="tool-frame"],[data-act="tool-connect"]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-act') === 'tool-' + tool);
      });
      if (this.els.hint) {
        this.els.hint.textContent = tool === 'connect'
          ? 'Drag from a cell onto another to connect · Click a line and press Delete to remove it'
          : 'Left-drag to select · Connect tool to draw a line · Click a line and Delete to remove it · Two-finger drag to pan';
      }
    }

    async _onExportClick(e) {
      const btn = e.target.closest('[data-export]');
      if (!btn) return;
      e.stopPropagation();
      this.els.exportMenu.classList.remove('open');
      const kind = btn.getAttribute('data-export');
      if (kind === 'standalone') {
        try { await this.exportStandalone(); } catch (err) {
          alert('Standalone export failed: ' + ((err && err.message) || err));
        }
        return;
      }
      const isFrame = kind.startsWith('frame-');
      const format = isFrame ? kind.slice(6) : kind;
      let rect;
      if (isFrame) {
        const f = this.data.frames.find((x) => x.id === this.selectedFrameId) || this.data.frames[0];
        if (!f) {
          alert('Draw or select a frame first.');
          return;
        }
        rect = this._frameExportRect(f);
      } else {
        rect = Object.assign(this.contentBounds(), { name: 'mindmap' });
        rect.x -= 20;
        rect.y -= 48;
        rect.w += 40;
        rect.h += 68;
      }
      try {
        await this._doExport(format, rect);
      } catch (err) {
        alert('Export failed: ' + (err.message || err));
      }
    }

    async _doExport(format, rect) {
      // A standalone file has export.js inlined and no server to fetch from.
      const stale = !isStandaloneDoc() && global.MindmapExport && global.MindmapExport._v !== EXPORT_V;
      if (!global.MindmapExport || stale) await loadScript('/mindmap/export.js?v=24');
      if (!global.MindmapExport) throw new Error('Export module failed to load');
      const scene = this._exportScene();
      return global.MindmapExport.run(format, rect, scene, this.els);
    }

    _frameExportRect(f) {
      return {
        x: f.x - 16,
        y: f.y - 48,
        w: f.w + 32,
        h: f.h + 64,
        name: (f.title || 'frame').replace(/\s+/g, '-'),
      };
    }

    _exportScene() {
      const links = [];
      this.nodesArr().forEach((child) => {
        if (!child.parentId) return;
        if (this.hiddenByCollapse(child.id)) return;
        const parent = this.data.nodes[child.parentId];
        if (!parent || (parent.collapsedDirs && parent.collapsedDirs[child.dir])) return;
        const a = this._edgePoint(parent, child.dir);
        const b = this._edgePoint(child, OPP[child.dir]);
        links.push({
          a,
          b,
          dir: child.dir,
          color: resolveVisibleLinkColor(this.data, child, parent, a, b, (x, y) => this._frameAtWorld(x, y)),
          width: child.style.linkWidth || 2.25,
          dash: linkDash(child.style.linkStyle || parent.style.linkStyle),
        });
      });
      (this.data.links || []).forEach((l) => {
        const from = this.data.nodes[l.fromId];
        const to = this.data.nodes[l.toId];
        if (!from || !to) return;
        if (this.hiddenByCollapse(from.id) || this.hiddenByCollapse(to.id)) return;
        const dir = l.fromDir || 'right';
        const a = this._edgePoint(from, dir);
        const b = this._edgePoint(to, l.toDir || OPP[dir] || 'left');
        links.push({
          a,
          b,
          dir,
          color: resolveVisibleLinkColor(this.data, from, to, a, b, (x, y) => this._frameAtWorld(x, y)),
          width: (from.style && from.style.linkWidth) || 2.25,
          dash: linkDash((from.style && from.style.linkStyle) || (to.style && to.style.linkStyle)),
        });
      });
      return { nodes: this.nodesArr().filter((n) => !this.hiddenByCollapse(n.id)).map(clone), frames: clone(this.data.frames || []), links };
    }

    _now() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    _overCanvas(e) {
      const canvas = this.els && this.els.canvas;
      if (!canvas || this._destroyed) return false;
      if (e.target && (e.target === canvas || canvas.contains(e.target))) return true;
      if (typeof e.clientX !== 'number') return false;
      const r = canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    _armGestureTimeout() {
      clearTimeout(this._gestureTimer);
      this._gestureTimer = setTimeout(() => { this._gestureActive = false; }, 700);
    }

    _zoomAtClient(clientX, clientY, deltaY, intensity) {
      this._zoomPend = this._zoomPend || { dy: 0, x: clientX, y: clientY, k: intensity || 0.01 };
      this._zoomPend.dy += deltaY;
      this._zoomPend.x = clientX;
      this._zoomPend.y = clientY;
      if (intensity) this._zoomPend.k = intensity;
      if (this._zoomRaf) return;
      this._zoomRaf = requestAnimationFrame(() => {
        this._zoomRaf = 0;
        const p = this._zoomPend;
        this._zoomPend = null;
        if (!p || this._destroyed) return;
        const rect = this.els.canvas.getBoundingClientRect();
        const factor = Math.exp(-p.dy * (p.k || 0.01));
        this._setZoomAt(this.data.viewport.zoom * factor, p.x - rect.left, p.y - rect.top);
        this._scheduleVpEmit();
      });
    }

    _wheelShouldZoom(e) {
      if (e.ctrlKey || e.metaKey) return true;
      if (e.deltaZ && e.deltaZ !== 0) return true;
      if (e.deltaMode === 1 || e.deltaMode === 2) return true;
      return false;
    }

    _onWheel(e) {
      if (this._ytOpen) {
        if (this.els.ytStage && this.els.ytStage.classList.contains('is-image')) this._onMediaImgWheel(e);
        else e.preventDefault();
        return;
      }
      e.preventDefault();
      if (this._pinch && this._pointers.size < 2) this._endPinch();
      if (this._pinch && this._pointers.size >= 2) return;
      const now = this._now();
      let dy = e.deltaY;
      if (!dy && e.deltaZ) dy = e.deltaZ;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 160;
      const pinch = !!(e.ctrlKey || e.metaKey || (e.deltaZ && e.deltaZ !== 0));
      if (pinch && dy) this._pinchWheelUntil = now + 480;
      if (pinch || now < (this._pinchWheelUntil || 0) || this._wheelShouldZoom(e)) {
        if (!dy) return;
        this._zoomAtClient(e.clientX, e.clientY, dy, pinch || now < (this._pinchWheelUntil || 0) ? 0.01 : 0.003);
        return;
      }
      if (this._gestureActive) return;
      let dx = e.deltaX;
      if (e.deltaMode === 1) dx *= 16;
      this.data.viewport.x -= dx;
      this.data.viewport.y -= dy;
      this._applyTransform();
      this._scheduleVpEmit();
    }

    _onGestureStart(e) {
      if (this._ytOpen || !this._overCanvas(e)) return;
      e.preventDefault();
      this._gestureActive = true;
      this._gestureZoom = this.data.viewport.zoom;
      this._armGestureTimeout();
    }

    _onGestureChange(e) {
      if (this._ytOpen || !this._overCanvas(e)) return;
      e.preventDefault();
      this._armGestureTimeout();
      if (this._now() < (this._pinchWheelUntil || 0)) return;
      this._gestureActive = true;
      const rect = this.els.canvas.getBoundingClientRect();
      const sx = (typeof e.clientX === 'number' ? e.clientX : rect.left + rect.width / 2) - rect.left;
      const sy = (typeof e.clientY === 'number' ? e.clientY : rect.top + rect.height / 2) - rect.top;
      this._setZoomAt((this._gestureZoom || 1) * (e.scale || 1), sx, sy);
      this._scheduleVpEmit();
    }

    _onGestureEnd(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      this._gestureActive = false;
      clearTimeout(this._gestureTimer);
      this._scheduleVpEmit();
    }

    // A second finger turns the gesture into a pinch: roll back whatever the
    // one-finger drag had changed so far, since it will never reach pointerup.
    _cancelDrag(d) {
      if (!d) return;
      const restore = (origins) => (origins || []).forEach((o) => {
        const n = this.data.nodes[o.id];
        if (n) { n.x = o.x; n.y = o.y; }
      });
      if (d.kind === 'draw-frame' && d.tempId) {
        this.data.frames = (this.data.frames || []).filter((x) => x.id !== d.tempId);
        if (this.selectedFrameId === d.tempId) this.selectedFrameId = null;
        this.els.root.classList.remove('is-frame-blocked');
      } else if (d.kind === 'move-frame') {
        const f = (this.data.frames || []).find((x) => x.id === d.id);
        if (f) { f.x = d.fx; f.y = d.fy; }
        restore(d.origins);
      } else if (d.kind === 'resize-frame') {
        const f = (this.data.frames || []).find((x) => x.id === d.id);
        if (f) Object.assign(f, { x: d.fx, y: d.fy, w: d.w0, h: d.h0 });
      } else if (d.kind === 'resize-node') {
        const n = this.data.nodes[d.id];
        if (n) Object.assign(n, { x: d.fx, y: d.fy, w: d.w0, h: d.h0 });
      } else if (d.origins) {
        restore(d.origins);
      } else {
        return;
      }
      this.render();
    }

    _beginPinch() {
      const pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      this._hideMarquee();
      this.els.root.classList.remove('is-panning', 'is-moving', 'is-relink', 'is-selecting');
      this._cancelDrag(this._drag);
      this._drag = null;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      this._pinch = {
        dist,
        zoom: this.data.viewport.zoom,
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2,
      };
    }

    _updatePinch() {
      if (!this._pinch) return;
      const pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const rect = this.els.canvas.getBoundingClientRect();
      this._setZoomAt(this._pinch.zoom * (dist / this._pinch.dist), mx - rect.left, my - rect.top);
      this.data.viewport.x += mx - this._pinch.mx;
      this.data.viewport.y += my - this._pinch.my;
      this._pinch.mx = mx;
      this._pinch.my = my;
      this._applyTransform();
      this._scheduleVpEmit();
    }

    _endPinch() {
      this._pinch = null;
      this._scheduleVpEmit();
    }

    _onDblClick(e) {
      if (this.readOnly) return;
      const t = (e.target && e.target.closest) ? e.target : (e.target && e.target.parentElement);
      if (t && t.closest && (t.closest('.mm-toolbar') || t.closest('.mm-frames-dock') || t.closest('.mm-frames-menu') || t.closest('.mm-menu') || t.closest('.mm-format-bar') || t.closest('[data-edit]') || t.closest('textarea') || t.closest('[data-play-yt]') || t.closest('[data-open-img]') || t.closest('[data-note-toggle]') || t.closest('.mm-note-card') || t.closest('.mm-yt-modal'))) return;
      if (t && t.closest && (t.closest('.mm-frame-title') || t.closest('[data-frame-drag]') || t.closest('.mm-frame'))) {
        e.preventDefault();
        e.stopPropagation();
        this._drag = null;
        const host = t.closest('.mm-frame');
        if (host) this._beginFrameRename(host.dataset.id);
        return;
      }
      clearTimeout(this._relinkTimer);
      this._drag = null;
      this.els.root.classList.remove('is-panning', 'is-relink', 'is-moving');
      const nodeEl = t && t.closest && t.closest('.mm-node');
      const hit = (nodeEl && this.data.nodes[nodeEl.dataset.id]) || this.nodeAtPointer(e.clientX, e.clientY);
      if (hit && !this.hiddenByCollapse(hit.id)) {
        e.preventDefault();
        e.stopPropagation();
        this.startEdit(hit.id);
        return;
      }
      const w = this.screenToWorld(e.clientX, e.clientY);
      const named = (this.data.frames || []).slice().sort((a, b) => (b.z || 0) - (a.z || 0)).find((f) => (
        w.x >= f.x && w.x <= f.x + f.w && w.y >= f.y - 52 && w.y <= f.y + 12
      ));
      if (named) {
        e.preventDefault();
        this._beginFrameRename(named.id);
        return;
      }
      if (this._frameAtWorld(w.x, w.y)) return;
      this.addRootAt(w.x, w.y);
    }

    _onContext(e) {
      e.preventDefault();
    }

    _openCanvasContext(clientX, clientY, target) {
      const t = target && target.closest ? target : (target && target.parentElement);
      if (t && t.closest && (t.closest('.mm-toolbar') || t.closest('.mm-frames-dock') || t.closest('.mm-menu') || t.closest('.mm-format-bar') || t.closest('.mm-frames-menu'))) return;
      const linkEl = t && t.closest && t.closest('[data-link]');
      if (linkEl) {
        this._openLinkMenu(linkEl.getAttribute('data-link'), clientX, clientY);
        return;
      }
      const nodeEl = t && t.closest && t.closest('.mm-node');
      const frameEl = t && t.closest && t.closest('.mm-frame');
      this.commitEdit();
      if (nodeEl) {
        const id = nodeEl.dataset.id;
        const n = this.data.nodes[id];
        const lockedFrame = n && this._lockingFrame(n);
        if (lockedFrame) {
          this.selectOnly(null);
          this.selectedFrameId = lockedFrame.id;
          this.render();
          this._openFrameMenu(lockedFrame.id, clientX, clientY);
          return;
        }
        if (!this.selectedIds.has(id) || this.selectedIds.size <= 1) this.selectOnly(id);
        else this.selectedId = id;
        this.selectedFrameId = null;
        this.render();
        if (this.selectedIds.size > 1) this._openGroupMenu(clientX, clientY);
        else this._openMenu(id, clientX, clientY);
        return;
      }
      if (frameEl) {
        const f = this.data.frames.find((x) => x.id === frameEl.dataset.id);
        if (f) {
          this.selectOnly(null);
          this.selectedFrameId = f.id;
          this.render();
          this._openFrameMenu(f.id, clientX, clientY);
          return;
        }
      }
      const w = this.screenToWorld(clientX, clientY);
      const hitFrame = this._frameAtWorld(w.x, w.y);
      if (hitFrame) {
        this.selectOnly(null);
        this.selectedFrameId = hitFrame.id;
        this.render();
        this._openFrameMenu(hitFrame.id, clientX, clientY);
        return;
      }
      if (this.selectedList().length > 1) {
        this._openGroupMenu(clientX, clientY);
        return;
      }
      this._closeMenu();
    }

    _openLinkMenu(id, x, y) {
      const extra = this._extraLinkById(id);
      if (extra) {
        this._menuLinkId = extra.id;
        this._menuNodeId = null;
        this._menuMode = 'link';
        this.selectedLinkId = extra.id;
        this.selectedIds = new Set();
        this.selectedId = null;
        this.selectedFrameId = null;
        this.render();
        this.els.menu.innerHTML = `
          <div class="mm-menu-label">Connection</div>
          <button type="button" data-m="disconnect">Delete connection</button>
        `;
        this._placeMenu(x, y);
        return;
      }
      const n = this.data.nodes[id];
      if (!n || !n.parentId) return;
      this._menuLinkId = null;
      this._menuNodeId = id;
      this._menuMode = 'link';
      this.selectedLinkId = id;
      this.selectedIds = new Set();
      this.selectedId = null;
      this.selectedFrameId = null;
      this.render();
      this.els.menu.innerHTML = `
        <div class="mm-menu-label">Connection</div>
        <button type="button" data-m="disconnect">Delete connection</button>
      `;
      this._placeMenu(x, y);
    }

    _placeMenu(x, y) {
      const menu = this.els.menu;
      menu.classList.add('open');
      const mw = 220;
      const mh = Math.min(menu.scrollHeight || 420, window.innerHeight - 16);
      menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
      this._flipSubmenus();
    }

    _flipSubmenus() {
      const menu = this.els.menu;
      const r = menu.getBoundingClientRect();
      menu.classList.toggle('flip-sub', r.right + 210 > window.innerWidth);
    }

    _bindMenuColors(handlers) {
      const h = handlers || {};
      this.els.menu.querySelectorAll('.mm-color-custom-row').forEach((row) => {
        row.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this._beginColorPick(row);
        }, true);
        row.addEventListener('mousedown', (ev) => ev.stopPropagation());
        row.addEventListener('click', (ev) => ev.stopPropagation());
      });
      this.els.menu.querySelectorAll('input[type="color"]').forEach((inp) => {
        inp.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this._beginColorPick(inp);
        });
        inp.addEventListener('input', () => {
          const kind = inp.getAttribute('data-color-input');
          const fn = h[kind];
          if (fn) fn(inp.value);
        });
        inp.addEventListener('change', () => this._endColorPick());
        inp.addEventListener('cancel', () => this._endColorPick());
        inp.addEventListener('click', (ev) => ev.stopPropagation());
      });
      this.els.menu.querySelectorAll('[data-insp-hex]').forEach((inp) => {
        inp.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this._beginColorPick(inp);
        });
        inp.addEventListener('input', () => {
          const color = parseHexColor(inp.value);
          if (!color) return;
          const kind = inp.getAttribute('data-insp-hex');
          const fn = h[kind];
          if (fn) fn(color);
        });
        inp.addEventListener('click', (ev) => ev.stopPropagation());
      });
    }

    _openMenu(id, x, y) {
      const n = this.data.nodes[id];
      if (!n) return;
      this._menuNodeId = id;
      this._menuMode = 'node';
      const counts = {};
      DIRS.forEach((d) => { counts[d] = this.immediateCount(id, d); });
      const addInner = DIRS.filter((d) => !(n.collapsedDirs && n.collapsedDirs[d])).map((d) => `<button type="button" data-m="add" data-dir="${d}">${d[0].toUpperCase() + d.slice(1)}${d === 'right' ? ' <span class="mm-kbd">→</span>' : ''}</button>`).join('');
      const collapseInner = DIRS.filter((d) => counts[d]).map((d) => `<button type="button" data-m="toggle" data-dir="${d}">${n.collapsedDirs && n.collapsedDirs[d] ? 'Expand' : 'Collapse'} ${d} (${counts[d]})</button>`).join('');
      const typeInner = `
        <button type="button" data-m="type" data-type="text">Text</button>
        <button type="button" data-m="type" data-type="code">Code snippet</button>
        <button type="button" data-m="type" data-type="youtube">YouTube</button>
        <button type="button" data-m="type" data-type="image">Image</button>
        <button type="button" data-m="type" data-type="link">External link</button>
      `;
      const textInner = `
        ${menuColorRow('text', TEXT_PALETTE, n.style.textColor, false)}
        <div class="mm-menu-label">Font</div>
        <div class="mm-swatches">${FONT_FACES.map((f) => `<button type="button" data-m="font" data-font="${f.id}" class="mm-link-style${(n.format.fontFamily || 'sans') === f.id ? ' active' : ''}">${f.label}</button>`).join('')}</div>
        <button type="button" data-m="align-left">${(n.format.align || 'center') === 'left' ? '✓ ' : ''}Align left</button>
        <button type="button" data-m="align-center">${(n.format.align || 'center') === 'center' ? '✓ ' : ''}Align center</button>
        <button type="button" data-m="align-right">${(n.format.align || 'center') === 'right' ? '✓ ' : ''}Align right</button>
        <button type="button" data-m="bold">${n.format.bold ? '✓ ' : ''}Bold</button>
        <button type="button" data-m="italic">${n.format.italic ? '✓ ' : ''}Italic</button>
        <button type="button" data-m="underline">${n.format.underline ? '✓ ' : ''}Underline</button>
        <button type="button" data-m="size-up">Larger text</button>
        <button type="button" data-m="size-down">Smaller text</button>
      `;
      const lineInner = `
        ${menuColorRow('link', LINK_PALETTE, n.style.linkColor, false)}
        <div class="mm-menu-label">Style</div>
        <div class="mm-swatches">${LINK_STYLES.map((s) => `<button type="button" data-m="link-style" data-style="${s.id}" class="mm-link-style${(n.style.linkStyle || 'solid') === s.id ? ' active' : ''}">${s.label}</button>`).join('')}</div>
        <button type="button" data-m="link-w-up">Thicker line</button>
        <button type="button" data-m="link-w-down">Thinner line</button>
      `;
      const menu = this.els.menu;
      menu.innerHTML = `
        ${addInner ? subMenuHtml('Add child', addInner) : '<div class="mm-menu-label">Expand a side to add there</div>'}
        ${subMenuHtml('Collapse / Expand', collapseInner)}
        ${n.parentId ? '<button type="button" data-m="disconnect">Delete connection</button>' : ''}
        ${n.parentId ? '<button type="button" data-m="root">Set as root</button>' : '<div class="mm-menu-label">This is a root · drag to move tree</div>'}
        ${subMenuHtml('Type', typeInner)}
        ${subMenuHtml('Fill', menuColorRow('fill', NODE_PALETTE, n.style.fill, true))}
        ${subMenuHtml('Border', menuColorRow('border', NODE_PALETTE, n.style.border, true))}
        ${subMenuHtml('Text', textInner)}
        ${subMenuHtml('Line', lineInner)}
        <div class="mm-menu-sep"></div>
        ${this._canNote(n) ? `<button type="button" data-m="notes">${n.noteOpen ? 'Hide note' : (n.note && n.note.trim() ? 'Notes' : 'Add note')}</button>` : ''}
        ${(n.type === 'image' || n.type === 'youtube') && !this.isNodeLocked(n) ? '<button type="button" data-m="edit">Edit URL</button>' : ''}
        <button type="button" data-m="lock">${n.locked ? 'Unlock' : 'Lock'}</button>
        <button type="button" data-m="copy">Copy <span class="mm-kbd">⌘C</span></button>
        <button type="button" data-m="paste"${this.isNodeLocked(n) ? ' disabled' : ''}>Paste as child</button>
        <button type="button" data-m="delete"${this.isNodeLocked(n) ? ' disabled' : ''}>Delete <span class="mm-kbd">⌫</span></button>
      `;
      this._placeMenu(x, y);
      this._bindMenuColors({
        fill: (v) => this.applyFillColor(this._menuNodeId, v),
        border: (v) => this.applyBorderColor(this._menuNodeId, v),
        text: (v) => this.applyTextColor(this._menuNodeId, v),
        link: (v) => this.applyLinkColor(this._menuNodeId, v),
      });
    }

    _openGroupMenu(x, y) {
      const ids = this.selectedList();
      if (!ids.length) return;
      const n = this.data.nodes[this.selectedId] || this.data.nodes[ids[0]];
      this._menuMode = 'group';
      this._menuNodeId = n ? n.id : null;
      const typeInner = `
        <button type="button" data-m="type" data-type="text">Text</button>
        <button type="button" data-m="type" data-type="code">Code snippet</button>
        <button type="button" data-m="type" data-type="youtube">YouTube</button>
        <button type="button" data-m="type" data-type="image">Image</button>
        <button type="button" data-m="type" data-type="link">External link</button>
      `;
      const textInner = `
        ${menuColorRow('text', TEXT_PALETTE, n.style.textColor, false)}
        <div class="mm-menu-label">Font</div>
        <div class="mm-swatches">${FONT_FACES.map((f) => `<button type="button" data-m="font" data-font="${f.id}" class="mm-link-style">${f.label}</button>`).join('')}</div>
        <button type="button" data-m="align-left">Align left</button>
        <button type="button" data-m="align-center">Align center</button>
        <button type="button" data-m="align-right">Align right</button>
        <button type="button" data-m="bold">Bold</button>
        <button type="button" data-m="italic">Italic</button>
        <button type="button" data-m="underline">Underline</button>
        <button type="button" data-m="size-up">Larger text</button>
        <button type="button" data-m="size-down">Smaller text</button>
      `;
      const lineInner = `
        ${menuColorRow('link', LINK_PALETTE, n.style.linkColor, false)}
        <div class="mm-menu-label">Style</div>
        <div class="mm-swatches">${LINK_STYLES.map((s) => `<button type="button" data-m="link-style" data-style="${s.id}" class="mm-link-style">${s.label}</button>`).join('')}</div>
        <button type="button" data-m="link-w-up">Thicker line</button>
        <button type="button" data-m="link-w-down">Thinner line</button>
      `;
      const arrangeInner = `
        <button type="button" data-m="align-box" data-box="left">Align left edges</button>
        <button type="button" data-m="align-box" data-box="right">Align right edges</button>
        <button type="button" data-m="align-box" data-box="top">Align tops</button>
        <button type="button" data-m="align-box" data-box="bottom">Align bottoms</button>
        <button type="button" data-m="align-box" data-box="hcenter">Center horizontally</button>
        <button type="button" data-m="align-box" data-box="vcenter">Center vertically</button>
        <button type="button" data-m="detach">Detach as roots</button>
      `;
      const menu = this.els.menu;
      menu.innerHTML = `
        <div class="mm-menu-label">Group · ${ids.length} cells</div>
        ${subMenuHtml('Fill', menuColorRow('fill', NODE_PALETTE, n.style.fill, true))}
        ${subMenuHtml('Border', menuColorRow('border', NODE_PALETTE, n.style.border, true))}
        ${subMenuHtml('Text', textInner)}
        ${subMenuHtml('Line', lineInner)}
        ${subMenuHtml('Type', typeInner)}
        ${subMenuHtml('Arrange', arrangeInner)}
        <div class="mm-menu-sep"></div>
        <button type="button" data-m="lock">${ids.some((id) => this.data.nodes[id] && !this.isNodeLocked(id)) ? 'Lock' : 'Unlock'}</button>
        <button type="button" data-m="copy">Copy <span class="mm-kbd">⌘C</span></button>
        <button type="button" data-m="delete">Delete <span class="mm-kbd">⌫</span></button>
      `;
      this._placeMenu(x, y);
      this._bindMenuColors({
        fill: (v) => {
          this._runBatch(() => this.selectedList().forEach((id) => this.applyFillColor(id, v)));
          this.render();
          this._emit();
        },
        border: (v) => {
          this._runBatch(() => this.selectedList().forEach((id) => this.applyBorderColor(id, v)));
          this.render();
          this._emit();
        },
        text: (v) => {
          this._runBatch(() => this.selectedList().forEach((id) => this.applyTextColor(id, v)));
          this.render();
          this._emit();
        },
        link: (v) => {
          this._runBatch(() => this.selectedList().forEach((id) => this.applyLinkColor(id, v)));
          this.render();
          this._emit();
        },
      });
    }

    _openFrameMenu(id, x, y) {
      const f = (this.data.frames || []).find((fr) => fr.id === id);
      if (!f) return;
      this._menuMode = 'frame';
      this._menuFrameId = id;
      this._menuNodeId = null;
      const exportInner = `
        <button type="button" data-m="export" data-format="png">Export PNG</button>
        <button type="button" data-m="export" data-format="svg">Export SVG</button>
        <button type="button" data-m="export" data-format="pdf">Export PDF</button>
      `;
      const menu = this.els.menu;
      menu.innerHTML = `
        <div class="mm-menu-label">Frame${f.title ? ' · ' + escapeHtml(f.title) : ''}</div>
        ${subMenuHtml('Color', menuColorRow('fill', NODE_PALETTE, f.fill || '#ffffff', false))}
        ${subMenuHtml('Export', exportInner)}
        ${this._frameCatList().length ? subMenuHtml('Category', [
          `<button type="button" data-m="cat" data-cat=""${f.categoryId ? '' : ' class="active"'}>Uncategorized</button>`,
          ...this._flatFrameCats(null, 0).map(({ cat, depth }) => (
            `<button type="button" data-m="cat" data-cat="${escapeAttr(cat.id)}" class="${f.categoryId === cat.id ? 'active' : ''}">${'· '.repeat(depth)}${escapeHtml(cat.name)}</button>`
          )),
        ].join('')) : ''}
        <div class="mm-menu-sep"></div>
        <button type="button" data-m="lock">${f.locked ? 'Unlock' : 'Lock'}</button>
        <button type="button" data-m="rename"${f.locked ? ' disabled' : ''}>Rename</button>
        <button type="button" data-m="fit"${f.locked ? ' disabled' : ''}>Fit to content</button>
        <button type="button" data-m="expand">Expand all children</button>
        <button type="button" data-m="duplicate">Duplicate</button>
        <button type="button" data-m="front">Bring to front</button>
        <button type="button" data-m="back">Send to back</button>
        <div class="mm-menu-sep"></div>
        <button type="button" data-m="delete"${f.locked ? ' disabled' : ''}>Delete frame</button>
      `;
      this._placeMenu(x, y);
      this._bindMenuColors({
        fill: (v) => this.applyFrameColor(this._menuFrameId, v),
      });
    }

    deleteFrame(id) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (f && f.locked) return;
      this.data.frames = (this.data.frames || []).filter((fr) => fr.id !== id);
      this.nodesArr().forEach((n) => {
        if (n.frameId === id) n.frameId = null;
      });
      if (this.selectedFrameId === id) this.selectedFrameId = null;
      this.render();
      this._emit();
    }

    lockFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || f.locked) return;
      f.locked = true;
      this.nodesArr().forEach((n) => {
        if (this.hiddenByCollapse(n.id)) return;
        if (n.frameId && n.frameId !== f.id) return;
        if (n.frameId === f.id || this._nodeOverlapsFrame(n, f)) n.frameId = f.id;
      });
      this.render();
      this._emit();
    }

    unlockFrame(id, fromHold) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || !f.locked) return;
      f.locked = false;
      this.selectOnly(null);
      this.selectedFrameId = id;
      this.render();
      this._emit();
      if (fromHold) this._flashUnlockHint('Frame unlocked');
    }

    toggleFrameLock(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      if (f.locked) this.unlockFrame(id);
      else this.lockFrame(id);
    }

    lockNode(id) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly || n.locked || this._lockingFrame(n)) return;
      n.locked = true;
      this.render();
      this._emit();
    }

    unlockNode(id, fromHold) {
      const n = this.data.nodes[id];
      if (!n || this.readOnly || !n.locked || this._lockingFrame(n)) return;
      n.locked = false;
      this.selectOnly(id);
      this.selectedFrameId = null;
      this.render();
      this._emit();
      if (fromHold) this._flashUnlockHint('Object unlocked');
    }

    toggleNodeLock(id) {
      const n = this.data.nodes[id];
      if (!n || this._lockingFrame(n)) return;
      if (n.locked) this.unlockNode(id);
      else this.lockNode(id);
    }

    _clearLockHold() {
      if (this._lockHold && this._lockHold.timer) clearTimeout(this._lockHold.timer);
      this._lockHold = null;
      if (this.els.lockHold) this.els.lockHold.classList.remove('show');
    }

    _beginLockHold(kind, id, e) {
      if (this.readOnly || !id || !e) return;
      if (kind === 'frame') {
        const f = (this.data.frames || []).find((x) => x.id === id);
        if (!f || !f.locked) return;
      } else if (kind === 'node') {
        const n = this.data.nodes[id];
        if (!n || !n.locked || this._lockingFrame(n)) return;
      } else return;
      this._clearLockHold();
      const hold = { kind, id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      const ring = this.els.lockHold;
      if (ring && this.els.canvas) {
        const rect = this.els.canvas.getBoundingClientRect();
        ring.style.left = (e.clientX - rect.left) + 'px';
        ring.style.top = (e.clientY - rect.top) + 'px';
        ring.classList.add('show');
      }
      hold.timer = setTimeout(() => {
        const t = this._lockHold;
        this._clearLockHold();
        if (!t) return;
        if (t.kind === 'frame') this.unlockFrame(t.id, true);
        else this.unlockNode(t.id, true);
      }, LOCK_HOLD_MS);
      this._lockHold = hold;
    }

    _beginNodeLockHold(n, e) {
      if (!n) return false;
      if (e && e.target && e.target.closest && (e.target.closest('[data-note-toggle]') || e.target.closest('.mm-note-card'))) return false;
      const frame = this._lockingFrame(n);
      if (frame) {
        e.preventDefault();
        this.selectOnly(null);
        this.selectedFrameId = frame.id;
        this.render();
        return true;
      }
      if (n.locked) {
        e.preventDefault();
        this.selectOnly(n.id);
        this.selectedFrameId = null;
        this.render();
        this._beginLockHold('node', n.id, e);
        return true;
      }
      return false;
    }

    _flashUnlockHint(text) {
      const hint = this.els.dropHint;
      if (!hint) return;
      hint.textContent = text || 'Unlocked';
      hint.classList.add('show');
      clearTimeout(this._unlockHint);
      this._unlockHint = setTimeout(() => {
        if (this.els.dropHint && !(this._drag && this._drag.drop)) this.els.dropHint.classList.remove('show');
      }, 1400);
    }

    duplicateFrame(id) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      // Put the copy beside the original, stepping right until it doesn't
      // overlap any frame (frames may not overlap).
      let dx = f.w + 48;
      const dy = 0;
      for (let i = 0; i < 50 && this._frameBlocked({ id: null, x: f.x + dx, y: f.y + dy, w: f.w, h: f.h }); i++) {
        dx += f.w + 48;
      }
      const carried = this._nodesCarriedByFrame(f);
      const copyId = uid('f_');
      const idMap = {};
      carried.forEach((o) => { idMap[o.id] = uid('n_'); });
      carried.forEach((o) => {
        const src = this.data.nodes[o.id];
        if (!src) return;
        src.frameId = f.id;
        const nn = clone(src);
        nn.id = idMap[src.id];
        if (src.parentId && idMap[src.parentId]) {
          nn.parentId = idMap[src.parentId];
        } else {
          nn.parentId = null;
          nn.dir = null;
          if (!this.data.rootIds.includes(nn.id)) this.data.rootIds.push(nn.id);
        }
        nn.x = src.x + dx;
        nn.y = src.y + dy;
        nn.frameId = copyId;
        nn.locked = false;
        this.data.nodes[nn.id] = nn;
      });
      this._remapLinks(this._linksInSet(new Set(carried.map((o) => o.id))), idMap);
      const copy = Object.assign({}, clone(f), {
        id: copyId,
        x: f.x + dx,
        y: f.y + dy,
        title: (f.title || 'Frame') + ' copy',
        z: (this.data.frames || []).length,
        locked: false,
      });
      this.data.frames.push(copy);
      this.selectOnly(null);
      this.selectedFrameId = copy.id;
      this.render();
      this._emit();
    }

    _frameZ(id, where) {
      const frames = this.data.frames || [];
      const i = frames.findIndex((f) => f.id === id);
      if (i < 0) return;
      const [f] = frames.splice(i, 1);
      if (where === 'front') frames.push(f);
      else frames.unshift(f);
      frames.forEach((fr, idx) => { fr.z = idx; });
      this.render();
      this._emit();
    }

    fitFrameToContent(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || f.locked) return;
      const items = this.nodesArr().filter((n) => {
        if (this.hiddenByCollapse(n.id)) return false;
        return n.x < f.x + f.w && n.x + n.w > f.x && n.y < f.y + f.h && n.y + n.h > f.y;
      });
      if (!items.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      items.forEach((n) => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + n.h);
      });
      const pad = 32;
      f.x = minX - pad;
      f.y = minY - pad - 10;
      f.w = Math.max(80, maxX - minX + pad * 2);
      f.h = Math.max(60, maxY - minY + pad * 2 + 10);
      this.render();
      this._emit();
    }

    async _exportOneFrame(id, format) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) {
        alert('Select a frame first.');
        return;
      }
      const rect = this._frameExportRect(f);
      try {
        await this._doExport(format, rect);
      } catch (err) {
        alert('Export failed: ' + (err.message || err));
      }
    }

    _closeMenu() {
      this.els.menu.classList.remove('open', 'flip-sub');
      this.els.menu.querySelectorAll('.has-sub.open, .has-sub.is-picking').forEach((el) => {
        el.classList.remove('open', 'is-picking');
      });
      this._menuNodeId = null;
      this._menuFrameId = null;
      this._menuLinkId = null;
      this._menuMode = 'node';
    }

    _onMenuClick(e) {
      if (e.target.closest('.mm-color-custom-row')) {
        this._beginColorPick(e.target);
        return;
      }
      const sub = e.target.closest('[data-sub]');
      if (sub && this.els.menu.contains(sub)) {
        e.preventDefault();
        e.stopPropagation();
        const item = sub.closest('.has-sub');
        const open = item.classList.contains('open');
        this.els.menu.querySelectorAll('.has-sub.open, .has-sub.is-picking').forEach((el) => {
          el.classList.remove('open', 'is-picking');
        });
        if (!open) item.classList.add('open');
        this._flipSubmenus();
        return;
      }
      const btn = e.target.closest('[data-m]');
      if (!btn) return;
      if (this._menuMode === 'link') {
        if (btn.getAttribute('data-m') === 'disconnect') {
          if (this._menuLinkId) this._deleteExtraLink(this._menuLinkId);
          else this.detachNode(this._menuNodeId);
        }
        this._closeMenu();
        return;
      }
      if (this._menuMode === 'frame') {
        this._onFrameMenuClick(btn);
        return;
      }
      if (this._menuMode === 'group') {
        this._onGroupMenuClick(btn);
        return;
      }
      const id = this._menuNodeId;
      const n = this.data.nodes[id];
      if (!n) return;
      const m = btn.getAttribute('data-m');
      if (m === 'add') {
        const child = this.addChild(id, btn.getAttribute('data-dir'));
        this._closeMenu();
        if (child) this.startEdit(child.id);
        return;
      }
      if (m === 'toggle') this.toggleCollapse(id, btn.getAttribute('data-dir'));
      if (m === 'disconnect') { this.detachNode(id); this._closeMenu(); return; }
      if (m === 'root') this.setAsRoot(id);
      if (m === 'type') this.setNodeType(id, btn.getAttribute('data-type'));
      if (btn.tagName === 'INPUT') {
        if (m === 'fill') this.applyFillColor(id, btn.value);
        if (m === 'border') this.applyBorderColor(id, btn.value);
        if (m === 'text') this.applyTextColor(id, btn.value);
        if (m === 'link') this.applyLinkColor(id, btn.value);
        return;
      }
      if (m === 'fill') this.applyFillColor(id, btn.getAttribute('data-color') || btn.value);
      if (m === 'border') this.applyBorderColor(id, btn.getAttribute('data-color') || btn.value);
      if (m === 'text') this.applyTextColor(id, btn.getAttribute('data-color'));
      if (m === 'link') this.applyLinkColor(id, btn.getAttribute('data-color'));
      if (m === 'link-style') this.applyLinkStyle(id, btn.getAttribute('data-style'));
      if (m === 'align-left') this.applyFormat(id, { align: 'left' });
      if (m === 'align-center') this.applyFormat(id, { align: 'center' });
      if (m === 'align-right') this.applyFormat(id, { align: 'right' });
      if (m === 'font') this.applyFormat(id, { fontFamily: btn.getAttribute('data-font') });
      if (m === 'bold') this.applyFormat(id, { bold: !n.format.bold });
      if (m === 'italic') this.applyFormat(id, { italic: !n.format.italic });
      if (m === 'underline') this.applyFormat(id, { underline: !n.format.underline });
      if (m === 'size-up') this.applyFormat(id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) + 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
      if (m === 'size-down') this.applyFormat(id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) - 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
      if (m === 'link-w-up') this.applyStyle(id, { linkWidth: clamp((n.style.linkWidth || 2.25) + 0.5, 1, 6) });
      if (m === 'link-w-down') this.applyStyle(id, { linkWidth: clamp((n.style.linkWidth || 2.25) - 0.5, 1, 6) });
      if (m === 'copy') this.copySubtree(id);
      if (m === 'notes') {
        this._toggleNote(n);
        this._closeMenu();
        return;
      }
      if (m === 'edit') {
        this._closeMenu();
        this.startEdit(id);
        return;
      }
      if (m === 'lock') {
        this.toggleNodeLock(id);
        this._closeMenu();
        return;
      }
      if (m === 'paste') this.pasteSubtree(id);
      if (m === 'delete') this.deleteNode(id);
      this._closeMenu();
    }

    _onGroupMenuClick(btn) {
      const ids = this.selectedList();
      if (!ids.length) { this._closeMenu(); return; }
      const m = btn.getAttribute('data-m');
      const each = (fn) => {
        this._runBatch(() => ids.forEach((id) => {
          const n = this.data.nodes[id];
          if (n) fn(id, n);
        }));
        this.render();
        this._emit();
        requestAnimationFrame(() => { if (!this._destroyed) this._syncSizes(); });
      };
      if (btn.tagName === 'INPUT') {
        if (m === 'fill') each((id) => this.applyFillColor(id, btn.value));
        if (m === 'border') each((id) => this.applyBorderColor(id, btn.value));
        if (m === 'text') each((id) => this.applyTextColor(id, btn.value));
        if (m === 'link') each((id) => this.applyLinkColor(id, btn.value));
        return;
      }
      if (m === 'fill') each((id) => this.applyFillColor(id, btn.getAttribute('data-color')));
      if (m === 'border') each((id) => this.applyBorderColor(id, btn.getAttribute('data-color')));
      if (m === 'text') each((id) => this.applyTextColor(id, btn.getAttribute('data-color')));
      if (m === 'link') each((id) => this.applyLinkColor(id, btn.getAttribute('data-color')));
      if (m === 'link-style') each((id) => this.applyLinkStyle(id, btn.getAttribute('data-style')));
      if (m === 'align-left') each((id) => this.applyFormat(id, { align: 'left' }));
      if (m === 'align-center') each((id) => this.applyFormat(id, { align: 'center' }));
      if (m === 'align-right') each((id) => this.applyFormat(id, { align: 'right' }));
      if (m === 'font') each((id) => this.applyFormat(id, { fontFamily: btn.getAttribute('data-font') }));
      if (m === 'bold') { this._groupToggleFormat('bold'); this._closeMenu(); return; }
      if (m === 'italic') { this._groupToggleFormat('italic'); this._closeMenu(); return; }
      if (m === 'underline') { this._groupToggleFormat('underline'); this._closeMenu(); return; }
      if (m === 'size-up') each((id, n) => this.applyFormat(id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) + 1, FONT_SIZE_MIN, FONT_SIZE_MAX) }));
      if (m === 'size-down') each((id, n) => this.applyFormat(id, { fontSize: clamp((n.format.fontSize || FONT_SIZE_DEFAULT) - 1, FONT_SIZE_MIN, FONT_SIZE_MAX) }));
      if (m === 'link-w-up') each((id, n) => this.applyStyle(id, { linkWidth: clamp((n.style.linkWidth || 2.25) + 0.5, 1, 6) }));
      if (m === 'link-w-down') each((id, n) => this.applyStyle(id, { linkWidth: clamp((n.style.linkWidth || 2.25) - 0.5, 1, 6) }));
      if (m === 'type') each((id) => this.setNodeType(id, btn.getAttribute('data-type')));
      if (m === 'align-box') { this.alignSelected(btn.getAttribute('data-box')); this._closeMenu(); return; }
      if (m === 'detach') { this.detachSelected(); this._closeMenu(); return; }
      if (m === 'copy') { this.copySelected(); this._closeMenu(); return; }
      if (m === 'lock') {
        const anyUnlocked = ids.some((id) => this.data.nodes[id] && !this.isNodeLocked(id));
        if (anyUnlocked) ids.forEach((id) => this.lockNode(id));
        else ids.forEach((id) => this.unlockNode(id));
        this._closeMenu();
        return;
      }
      if (m === 'delete') { this.deleteSelected(); this._closeMenu(); return; }
      this._closeMenu();
    }

    _onFrameMenuClick(btn) {
      const id = this._menuFrameId;
      const f = (this.data.frames || []).find((fr) => fr.id === id);
      if (!f) { this._closeMenu(); return; }
      const m = btn.getAttribute('data-m');
      if (btn.tagName === 'INPUT') {
        if (m === 'fill') this.applyFrameColor(id, btn.value);
        return;
      }
      if (m === 'fill') this.applyFrameColor(id, btn.getAttribute('data-color'));
      if (m === 'export') {
        const format = btn.getAttribute('data-format');
        this._closeMenu();
        this._exportOneFrame(id, format);
        return;
      }
      if (m === 'rename') {
        this._closeMenu();
        this._beginFrameRename(id);
        return;
      }
      if (m === 'lock') {
        this.toggleFrameLock(id);
        this._closeMenu();
        return;
      }
      if (m === 'fit') this.fitFrameToContent(id);
      if (m === 'expand') this.expandFrame(id);
      if (m === 'duplicate') this.duplicateFrame(id);
      if (m === 'front') this._frameZ(id, 'front');
      if (m === 'back') this._frameZ(id, 'back');
      if (m === 'cat') {
        this._assignFrameCat(id, btn.getAttribute('data-cat') || null);
        this._closeMenu();
        return;
      }
      if (m === 'delete') this.deleteFrame(id);
      this._closeMenu();
    }

    _beginFrameRename(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || f.locked) return;
      const el = this.els.world.querySelector(`.mm-frame[data-id="${CSS.escape(id)}"] .mm-frame-title`);
      if (!el) return;
      el.contentEditable = 'true';
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    _frameAtWorld(wx, wy) {
      let best = null;
      let bestZ = -Infinity;
      (this.data.frames || []).forEach((f) => {
        if (wx < f.x || wy < f.y || wx > f.x + f.w || wy > f.y + f.h) return;
        const z = f.z || 0;
        if (!best || z >= bestZ) {
          best = f;
          bestZ = z;
        }
      });
      return best;
    }

    _nodesInRect(x0, y0, x1, y1) {
      const l = Math.min(x0, x1);
      const r = Math.max(x0, x1);
      const t = Math.min(y0, y1);
      const b = Math.max(y0, y1);
      return this.nodesArr().filter((n) => {
        if (this.hiddenByCollapse(n.id) || this.isNodeLocked(n)) return false;
        return n.x < r && n.x + n.w > l && n.y < b && n.y + n.h > t;
      }).map((n) => n.id);
    }

    _updateMarqueeEl(cx0, cy0, cx1, cy1) {
      const el = this.els.marquee;
      if (!el) return;
      const rect = this.els.canvas.getBoundingClientRect();
      const x = Math.min(cx0, cx1) - rect.left;
      const y = Math.min(cy0, cy1) - rect.top;
      el.classList.add('show');
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = Math.abs(cx1 - cx0) + 'px';
      el.style.height = Math.abs(cy1 - cy0) + 'px';
    }

    _paintSelection() {
      this.els.world.querySelectorAll('.mm-node').forEach((el) => {
        el.classList.toggle('selected', this.selectedIds.has(el.dataset.id) || this.selectedId === el.dataset.id);
      });
    }

    _hideMarquee() {
      if (this.els.marquee) this.els.marquee.classList.remove('show');
      this.els.root.classList.remove('is-selecting');
    }

    _startPan(e) {
      this._drag = {
        kind: 'pan',
        x0: e.clientX,
        y0: e.clientY,
        vx: this.data.viewport.x,
        vy: this.data.viewport.y,
        button: e.button,
        moved: false,
        target: e.target,
      };
      this.els.root.classList.add('is-panning');
      try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    _onPointerDown(e) {
      const t = e.target && e.target.closest ? e.target : (e.target && e.target.parentElement);
      if (!t || !t.closest) return;
      if (t.closest('.mm-toolbar') || t.closest('.mm-frames-dock') || t.closest('.mm-menu') || t.closest('.mm-format-bar') || t.closest('.mm-frames-menu')) return;
      if (t.closest('.mm-yt-modal')) return;

      if (e.pointerType === 'touch') {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size >= 2) {
          e.preventDefault();
          this._beginPinch();
          return;
        }
      }

      if (t.closest('[data-connect]') && e.button === 0 && !this.readOnly) {
        const host = t.closest('.mm-node');
        const n = host && this.data.nodes[host.dataset.id];
        if (n && !this.isNodeLocked(n)) {
          e.preventDefault();
          this.commitEdit();
          this._closeMenu();
          const dir = t.closest('[data-connect]').getAttribute('data-connect');
          const w = this.screenToWorld(e.clientX, e.clientY);
          this._connectFrom = n.id;
          this.selectOnly(n.id);
          this.els.root.classList.add('is-linking');
          this.render();
          this._drag = { kind: 'connect', fromId: n.id, fromDir: dir, toId: null, x0: w.x, y0: w.y, wx: w.x, wy: w.y, moved: false };
          try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          return;
        }
      }
      if (t.closest('[data-add]') || t.closest('[data-toggle]') || t.closest('.mm-ports') || t.closest('[data-open-link]') || t.closest('[data-note-toggle]') || t.closest('.mm-note-card')) return;
      if (t.closest('[data-edit]') || t.closest('input') || t.closest('textarea') || t.closest('select') || t.isContentEditable) return;

      if (e.button === 1 || e.button === 2 || (e.button === 0 && this._spaceDown)) {
        e.preventDefault();
        this._closeMenu();
        this._startPan(e);
        return;
      }
      if (e.button !== 0) return;

      const imgHandle = t.closest('[data-img-resize]');
      const handle = t.closest('[data-resize-frame]');
      const resizeEl = t.closest('[data-resize]');
      const frameEl = t.closest('.mm-frame');
      const nodeEl = t.closest('.mm-node');
      const w = this.screenToWorld(e.clientX, e.clientY);

      const linkEl = t.closest('[data-link]');
      if (linkEl) {
        e.preventDefault();
        const cid = linkEl.getAttribute('data-link');
        this.selectedLinkId = cid;
        this.selectedIds = new Set();
        this.selectedId = null;
        this.selectedFrameId = null;
        this._connectFrom = null;
        this.render();
        return;
      }

      if (this.tool === 'connect' && nodeEl && !this.readOnly) {
        const id = nodeEl.dataset.id;
        const n = this.data.nodes[id];
        if (!n || this.isNodeLocked(n)) return;
        e.preventDefault();
        if (this._connectFrom && this._connectFrom !== id) {
          this._connectNodes(this._connectFrom, id);
          this._connectFrom = null;
          this.render();
          return;
        }
        this._connectFrom = id;
        this.selectOnly(id);
        this.els.root.classList.add('is-linking');
        this.render();
        this._drag = { kind: 'connect', fromId: id, fromDir: this.nearestSide(n, w.x, w.y), toId: null, x0: w.x, y0: w.y, wx: w.x, wy: w.y, moved: false };
        try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }

      if (this.editingId && (!nodeEl || nodeEl.dataset.id !== this.editingId)) this.commitEdit();
      this._closeMenu();

      const unlockEl = t.closest('[data-frame-unlock]');
      if (unlockEl && !this.readOnly) {
        const host = unlockEl.closest('.mm-frame');
        const uf = host && this.data.frames.find((x) => x.id === host.dataset.id);
        if (uf && uf.locked) {
          e.preventDefault();
          this.selectOnly(null);
          this.selectedFrameId = uf.id;
          this.render();
          this._beginLockHold('frame', uf.id, e);
          return;
        }
      }

      if (handle && !this.readOnly) {
        const host = handle.closest('.mm-frame');
        const f = this.data.frames.find((x) => x.id === host.dataset.id);
        if (!f) return;
        if (f.locked) {
          e.preventDefault();
          this.selectOnly(null);
          this.selectedFrameId = f.id;
          this.render();
          return;
        }
        this.selectOnly(null);
        this.selectedFrameId = f.id;
        this._drag = {
          kind: 'resize-frame',
          id: f.id,
          corner: handle.getAttribute('data-resize-frame'),
          x0: w.x,
          y0: w.y,
          fx: f.x,
          fy: f.y,
          w0: f.w,
          h0: f.h,
        };
        this.render();
        try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }

      if (this.tool === 'frame' && !nodeEl && !frameEl && !this.readOnly) {
        this._drag = { kind: 'draw-frame', x0: w.x, y0: w.y, pointerId: e.pointerId };
        try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }

      if ((imgHandle || resizeEl) && nodeEl && !this.readOnly) {
        const n = this.data.nodes[nodeEl.dataset.id];
        if (n && this._beginNodeLockHold(n, e)) return;
        if (n && this._beginNodeResize(e, n, imgHandle ? imgHandle.getAttribute('data-img-resize') : 'se')) return;
      }

      const frameDrag = t.closest('[data-frame-drag]');
      if (frameDrag && !this.readOnly) {
        const host = frameDrag.closest('.mm-frame');
        const f = this.data.frames.find((x) => x.id === host.dataset.id);
        if (f && f.locked) {
          e.preventDefault();
          this.selectOnly(null);
          this.selectedFrameId = f.id;
          this.render();
          return;
        }
        if (f) {
          this._startFrameMove(f, w, e);
          return;
        }
      }

      if (nodeEl) {
        const id = nodeEl.dataset.id;
        const n = this.data.nodes[id];
        if (n && this.isNodeLocked(n) && !t.closest('[data-note-toggle]') && !t.closest('.mm-note-card')) {
          if (n.type === 'youtube' && youtubeId(n.content)) {
            e.preventDefault();
            this._openYoutube(n.content, n);
            return;
          }
          if (n.type === 'image' && safeImageSrc(n.content)) {
            e.preventDefault();
            this._openImage(n.content, n);
            return;
          }
        }
        if (n && this._beginNodeLockHold(n, e)) return;
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        if (additive) {
          if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
            if (this.selectedId === id) this.selectedId = this.selectedList()[0] || null;
          } else {
            this.selectedIds.add(id);
            this.selectedId = id;
          }
          this.selectedFrameId = null;
          this.render();
          return;
        }
        const inGroup = this.selectedIds.has(id) && this.selectedIds.size > 1;
        if (!inGroup) this.selectOnly(id);
        else this.selectedId = id;
        this.selectedFrameId = null;
        this.render();
        if (this.readOnly) return;
        this._drag = {
          kind: inGroup ? 'group-drag' : 'node-drag',
          id,
          x0: w.x,
          y0: w.y,
          cx0: e.clientX,
          cy0: e.clientY,
          // Locked nodes (or nodes in a locked frame) stay put, same as a group drag.
          origins: (inGroup ? this._snapshotSelection() : this._snapshotSubtree(id)).filter((o) => !this.isNodeLocked(o.id)),
          moved: false,
          drop: null,
        };
        try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }

      if (!nodeEl && !this.readOnly) {
        if (this.tool === 'connect') {
          this._connectFrom = null;
          this.selectOnly(null);
          this.render();
          return;
        }
        const locked = this._frameAtWorld(w.x, w.y);
        if (locked && locked.locked) {
          e.preventDefault();
          this.selectOnly(null);
          this.selectedFrameId = locked.id;
          this.render();
          return;
        }
      }

      this._drag = {
        kind: 'marquee',
        x0: w.x,
        y0: w.y,
        cx0: e.clientX,
        cy0: e.clientY,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        base: (e.shiftKey || e.metaKey || e.ctrlKey) ? [...this.selectedIds] : [],
        moved: false,
      };
      try { this.els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    _onPointerMove(e) {
      if (this._lockHold && (this._lockHold.pointerId == null || e.pointerId === this._lockHold.pointerId)) {
        if (Math.hypot(e.clientX - this._lockHold.x, e.clientY - this._lockHold.y) > 10) this._clearLockHold();
      }
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size >= 2) {
        if (!this._pinch) this._beginPinch();
        this._updatePinch();
        return;
      }
      const d = this._drag;
      if (!d) return;
      const w = this.screenToWorld(e.clientX, e.clientY);

      if (d.kind === 'pan') {
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) d.moved = true;
        this.data.viewport.x = d.vx + (e.clientX - d.x0);
        this.data.viewport.y = d.vy + (e.clientY - d.y0);
        this._applyTransform();
        return;
      }
      if (d.kind === 'marquee') {
        const dist = Math.hypot(e.clientX - (d.cx0 || 0), e.clientY - (d.cy0 || 0));
        if (dist <= 4 && !d.moved) return;
        d.moved = true;
        this.els.root.classList.add('is-selecting');
        this._updateMarqueeEl(d.cx0, d.cy0, e.clientX, e.clientY);
        const a = this.screenToWorld(d.cx0, d.cy0);
        const b = this.screenToWorld(e.clientX, e.clientY);
        const hits = this._nodesInRect(a.x, a.y, b.x, b.y);
        this.selectedIds = new Set(d.additive ? d.base.concat(hits) : hits);
        this.selectedId = hits[hits.length - 1] || (d.additive ? d.base[d.base.length - 1] : null) || this.selectedList()[0] || null;
        this.selectedFrameId = null;
        this._paintSelection();
        return;
      }
      if (d.kind === 'group-drag') {
        if (!d.moved) {
          if (Math.hypot(e.clientX - (d.cx0 || 0), e.clientY - (d.cy0 || 0)) <= 8) return;
          d.moved = true;
          this.els.root.classList.add('is-moving');
        }
        this._applySnapshotDelta(d.origins, w.x - d.x0, w.y - d.y0);
        this._paintMovingNodes();
        return;
      }
      if (d.kind === 'node-drag' || d.kind === 'move-subtree' || d.kind === 'move-tree') {
        if (d.kind === 'node-drag' && !d.moved) {
          const dist = Math.hypot((e.clientX - (d.cx0 || 0)), (e.clientY - (d.cy0 || 0)));
          if (dist <= 8) return;
          d.moved = true;
          this.els.root.classList.add('is-moving');
        }
        if (d.kind !== 'node-drag') this.els.root.classList.add('is-moving');
        this._applySnapshotDelta(d.origins, w.x - d.x0, w.y - d.y0);
        if (d.kind === 'node-drag') {
          d.drop = this._findDropSlot(w.x, w.y, d.id, e.clientX, e.clientY);
          this.els.root.classList.toggle('is-relink', !!d.drop);
        }
        this._paintMovingNodes();
        return;
      }
      if (d.kind === 'relink') {
        const target = this.nodeAtPointer(e.clientX, e.clientY, d.id);
        this.els.world.querySelectorAll('.mm-node').forEach((el) => {
          el.classList.toggle('drop-target', !!(target && el.dataset.id === target.id));
        });
        return;
      }
      if (d.kind === 'connect') {
        d.wx = w.x;
        d.wy = w.y;
        if (!d.moved && Math.hypot(e.clientX - (d.cx0 || e.clientX), e.clientY - (d.cy0 || e.clientY)) > 6) d.moved = true;
        if (Math.hypot(w.x - d.x0, w.y - d.y0) > 4) d.moved = true;
        const target = this._connectTargetAt(e.clientX, e.clientY, d.fromId);
        d.toId = target ? target.id : null;
        this.els.world.querySelectorAll('.mm-node').forEach((el) => {
          el.classList.toggle('drop-target', !!(target && el.dataset.id === target.id));
        });
        this._renderLinks(this.els.svg);
        return;
      }
      if (d.kind === 'draw-frame') {
        const x = Math.min(d.x0, w.x);
        const y = Math.min(d.y0, w.y);
        const fw = Math.abs(w.x - d.x0);
        const fh = Math.abs(w.y - d.y0);
        if (!d.tempId) {
          d.tempId = uid('f_');
          this.data.frames.push(Object.assign({ id: d.tempId, x, y, w: fw, h: fh, title: 'Frame', z: (this.data.frames || []).length }, defaultFrameStyle()));
          this.selectedFrameId = d.tempId;
        } else {
          const fr = this.data.frames.find((frame) => frame.id === d.tempId);
          if (fr) Object.assign(fr, { x, y, w: Math.max(fw, 40), h: Math.max(fh, 40) });
        }
        this.render();
        return;
      }
      if (d.kind === 'move-frame') {
        if (!d.moved) {
          if (Math.hypot(e.clientX - (d.cx0 || 0), e.clientY - (d.cy0 || 0)) <= 4) return;
          d.moved = true;
          this.els.root.classList.add('is-moving');
        }
        const f = this.data.frames.find((x) => x.id === d.id);
        if (!f) return;
        const dx = w.x - d.x0;
        const dy = w.y - d.y0;
        f.x = d.fx + dx;
        f.y = d.fy + dy;
        (d.origins || []).forEach((o) => {
          const n = this.data.nodes[o.id];
          if (n) {
            n.x = o.x + dx;
            n.y = o.y + dy;
          }
        });
        this.render();
        return;
      }
      if (d.kind === 'resize-frame') {
        const f = this.data.frames.find((x) => x.id === d.id);
        if (!f) return;
        this._applyFrameResize(f, d, w.x, w.y);
        this.render();
        return;
      }
      if (d.kind === 'resize-node') {
        const n = this.data.nodes[d.id];
        if (!n) return;
        this._applyNodeResize(n, d, w);
        this._paintNodeBox(n);
        return;
      }
    }

    _onPointerUp(e) {
      if (this._lockHold && (this._lockHold.pointerId == null || this._lockHold.pointerId === e.pointerId)) {
        this._clearLockHold();
      }
      this._pointers.delete(e.pointerId);
      if (this._pinch) {
        if (this._pointers.size < 2) this._endPinch();
        return;
      }
      const d = this._drag;
      clearTimeout(this._relinkTimer);
      this.els.root.classList.remove('is-panning', 'is-relink', 'is-moving');
      this._hideMarquee();
      this._drag = null;
      this._syncDropUi();
      if (!d) {
        this.els.root.classList.remove('is-linking');
        return;
      }

      if (d.kind === 'connect') {
        this._ignorePortClick = true;
        setTimeout(() => { this._ignorePortClick = false; }, 400);
        this.els.world.querySelectorAll('.mm-node').forEach((el) => el.classList.remove('drop-target'));
        const fromId = d.fromId;
        if (d.moved) {
          const target = this._connectTargetAt(e.clientX, e.clientY, fromId);
          this._connectFrom = null;
          if (target) this._connectNodes(fromId, target.id, d.fromDir);
          else this.render();
        } else {
          this._connectFrom = fromId;
          this.render();
        }
        this.els.root.classList.remove('is-linking');
        return;
      }
      this.els.root.classList.remove('is-linking');

      if (d.kind === 'marquee') {
        if (!d.moved && !d.additive) {
          this.selectOnly(null);
          const at = this.screenToWorld(d.cx0, d.cy0);
          const f = this._frameAtWorld(at.x, at.y);
          this.selectedFrameId = f ? f.id : null;
          this.render();
        } else {
          this.render();
        }
        return;
      }
      if (d.kind === 'group-drag') {
        if (d.moved) {
          this.selectedList().forEach((id) => {
            const n = this.data.nodes[id];
            if (n) n.userPlaced = true;
          });
          (d.origins || []).forEach((o) => this._assignNodeFrame(this.data.nodes[o.id]));
          this._emit();
        } else this.render();
        return;
      }
      if (d.kind === 'node-drag') {
        if (d.moved) {
          const dragged = this.data.nodes[d.id];
          if (dragged) dragged.userPlaced = true;
          (d.origins || []).forEach((o) => this._assignNodeFrame(this.data.nodes[o.id]));
        }
        if (d.moved && d.drop) {
          const dragged = this.data.nodes[d.id];
          if (dragged) dragged.userPlaced = true;
          this.relinkNode(d.id, d.drop.parentId, d.drop.dir, d.drop.index);
        } else {
          if (!d.moved) {
            const n = this.data.nodes[d.id];
            if (n && n.type === 'youtube' && youtubeId(n.content)) this._openYoutube(n.content, n);
            else if (n && n.type === 'image' && safeImageSrc(n.content)) this._openImage(n.content, n);
          }
          this.render();
          this._emit();
        }
        return;
      }
      if (d.kind === 'relink') {
        const target = this.nodeAtPointer(e.clientX, e.clientY, d.id);
        if (target) this.relinkNode(d.id, target.id, this.nearestSide(target, this.screenToWorld(e.clientX, e.clientY).x, this.screenToWorld(e.clientX, e.clientY).y));
        return;
      }
      if (d.kind === 'draw-frame') {
        const fr = this.data.frames.find((x) => x.id === d.tempId);
        this.els.root.classList.remove('is-frame-blocked');
        if (fr) {
          const overlap = this._frameWouldOverlap(fr);
          const nested = (this.data.frames || []).some((o) => o.id !== fr.id && this._rectInside(fr, o));
          if (overlap || nested || fr.w < 48 || fr.h < 40) {
            this.data.frames = this.data.frames.filter((x) => x.id !== fr.id);
            this.selectedFrameId = null;
            this.render();
          }
        }
        this._setTool('select');
        this._emit();
        return;
      }
      if (d.kind === 'pan') {
        if (d.button === 2 && !d.moved) this._openCanvasContext(e.clientX, e.clientY, d.target || e.target);
        else this._emit();
        return;
      }
      if (d.kind === 'resize-node') {
        const n = this.data.nodes[d.id];
        if (n) {
          const el = this._paintNodeBox(n);
          if (el) el.classList.remove('is-resizing');
          this._relayoutNode(n);
        }
        this.render();
        this._emit();
        return;
      }
      if (d.kind === 'move-frame') {
        this.els.root.classList.remove('is-moving');
        if (!d.moved) return; // a click only selects; nothing changed
        const f = this.data.frames.find((x) => x.id === d.id);
        if (f && this._frameBlocked(f)) {
          // Same rule as drawing: frames may not overlap or nest. Undo the move.
          f.x = d.fx;
          f.y = d.fy;
          (d.origins || []).forEach((o) => {
            const n = this.data.nodes[o.id];
            if (n) { n.x = o.x; n.y = o.y; }
          });
          this.render();
          return;
        }
        (d.origins || []).forEach((o) => {
          const n = this.data.nodes[o.id];
          if (n && !n.frameId) n.frameId = d.id;
        });
        this._emit();
        return;
      }
      if (d.kind === 'resize-frame') {
        const f = this.data.frames.find((x) => x.id === d.id);
        if (!f) return;
        if (f.x === d.fx && f.y === d.fy && f.w === d.w0 && f.h === d.h0) return;
        if (this._frameBlocked(f)) {
          Object.assign(f, { x: d.fx, y: d.fy, w: d.w0, h: d.h0 });
          this.render();
          return;
        }
        // Nodes left outside the resized frame stop belonging to it.
        this.nodesArr().forEach((n) => {
          if (n.frameId !== f.id) return;
          n.frameId = null;
          this._assignNodeFrame(n);
        });
        this.render();
        this._emit();
        return;
      }
      if (d.kind === 'move-tree' || d.kind === 'move-subtree') {
        this._emit();
      }
    }

    // A frame may not overlap or sit inside another frame.
    _frameBlocked(fr) {
      return this._frameWouldOverlap(fr)
        || (this.data.frames || []).some((o) => o.id !== fr.id && (this._rectInside(fr, o) || this._rectInside(o, fr)));
    }

    _onKeyUp(e) {
      if (e.code === 'Space') {
        this._spaceDown = false;
        this.els.root.classList.remove('is-space');
      }
    }

    _onKey(e) {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      const inChrome = e.target && e.target.closest && (e.target.closest('.monaco-editor') || e.target.closest('#sidebar') || e.target.closest('.modal') || e.target.closest('.mm-yt-modal'));
      if (e.key === 'Escape' && this._ytOpen) {
        e.preventDefault();
        this._closeYoutube();
        return;
      }
      if (e.code === 'Space' && !typing && !inChrome && !this._ytOpen) {
        this._spaceDown = true;
        this.els.root.classList.add('is-space');
        if (!e.repeat) e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        if (inChrome) return;
        if (typing && this.editingId && e.key.toLowerCase() === 'z' && !e.shiftKey) return;
        e.preventDefault();
        if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) this.redo();
        else this.undo();
        return;
      }
      if (e.key === 'Escape') {
        this._clearLockHold();
        this.commitEdit();
        this._closeColorDrops();
        this._closeMenu();
        this._hideMarquee();
        this._connectFrom = null;
        this.selectOnly(null);
        this._setTool('select');
        this.render();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing && !inChrome) {
        e.preventDefault();
        const ids = this.nodesArr().filter((n) => !this.hiddenByCollapse(n.id)).map((n) => n.id);
        this.selectedIds = new Set(ids);
        this.selectedId = (this.selectedId && this.selectedIds.has(this.selectedId)) ? this.selectedId : ids[0] || null;
        this.selectedFrameId = null;
        this.render();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && this.selectedList().length && !typing && !inChrome) {
        e.preventDefault();
        this.copySelected();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && !typing && !inChrome) {
        e.preventDefault();
        this.pasteSubtree(this.selectedId);
        return;
      }
      if (this.readOnly) return;
      if (!typing && !inChrome && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        this._setTool(this.tool === 'connect' ? 'select' : 'connect');
        return;
      }
      if (typing && this.editingId) {
        const editing = this.data.nodes[this.editingId];
        if (e.key === 'Enter' && !e.shiftKey && !(editing && editing.type === 'code')) {
          e.preventDefault();
          this.commitEdit();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedLinkId && !this.selectedList().length && !typing) {
        e.preventDefault();
        this.deleteSelectedLink();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedFrameId && !this.selectedList().length && !typing) {
        e.preventDefault();
        this.deleteFrame(this.selectedFrameId);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedList().length && !typing) {
        e.preventDefault();
        this.deleteSelected();
      }
      if (e.key === 'Enter' && this.selectedId && !typing) {
        e.preventDefault();
        this.startEdit(this.selectedId);
      }
      if (e.key === 'Tab' && this.selectedId && !typing) {
        e.preventDefault();
        // Keep growing the branch the way it already points: a node hanging
        // off the left of its parent gets a left child, and so on. Roots
        // have no direction, so they default to the right.
        const sel = this.data.nodes[this.selectedId];
        const dir = sel && sel.parentId && DIRS.includes(sel.dir) ? sel.dir : 'right';
        const child = this.addChild(this.selectedId, dir);
        if (child) this.startEdit(child.id);
      }
    }
  }

  global.MindmapEngine = MindmapEngine;

  function safeStandaloneName(title, fallback) {
    const base = String(title || fallback || 'file').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return (base || fallback || 'file') + '-standalone.html';
  }

  function downloadStandalone(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function isStandaloneDoc() {
    return document.documentElement.getAttribute('data-accretion') === 'standalone';
  }

  async function fetchStandaloneAsset(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load ' + url);
    return res.text();
  }

  function embedScript(src) {
    return String(src || '').replace(/<\/script/gi, '<\\/script');
  }

  async function buildStandaloneHtml(opts) {
    const standalone = document.documentElement.getAttribute('data-accretion') === 'standalone';
    let styles;
    let scripts;
    if (standalone) {
      styles = Array.from(document.querySelectorAll('head style')).map((el) => el.textContent || '');
      scripts = Array.from(document.querySelectorAll('script:not([type="application/json"])')).map((el) => el.textContent || '');
    } else {
      styles = [];
      for (const url of opts.cssUrls) styles.push(await fetchStandaloneAsset(url));
      scripts = [];
      for (const url of opts.jsUrls) scripts.push(await fetchStandaloneAsset(url));
    }
    const title = String(opts.title || opts.kind || 'Accretion').replace(/[<>]/g, '');
    return `<!DOCTYPE html>
<html lang="en" data-theme="light" data-docviewer="${opts.kind}" data-accretion="standalone">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body,#accretion-root{height:100%;margin:0;overflow:hidden}#accretion-root{position:fixed;inset:0}</style>
${styles.map((css) => `<style>\n${css}\n</style>`).join('\n')}
</head>
<body>
<div id="accretion-root"></div>
<script type="application/json" id="${opts.dataId}">
${opts.json}
</script>
${scripts.map((js) => `<script>\n${embedScript(js)}\n</script>`).join('\n')}
</body>
</html>
`;
  }

  function bootStandalone() {
    if (global.__accretionStandalone) return;
    const html = document.documentElement;
    if (!html || html.getAttribute('data-accretion') !== 'standalone') return;
    if (html.getAttribute('data-docviewer') !== 'mindmap') return;
    const host = document.getElementById('accretion-root');
    const dataEl = document.getElementById('mindmap-data');
    if (!host || !dataEl || typeof MindmapEngine !== 'function') return;
    global.__accretionStandalone = true;
    const engine = new MindmapEngine(host, { onChange: function () {} });
    const wrap = '<html data-docviewer="mindmap"><script type="application/json" id="mindmap-data">' + dataEl.textContent + '</script></html>';
    engine.loadFromHtml(wrap);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
  else bootStandalone();
})(window);
