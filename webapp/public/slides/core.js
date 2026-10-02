/* DocViewer slides core — playlist of title cards and board frames. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SlidesCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TITLE_MAX = 200;
  const TEXT_MAX = 8000;
  const NOTES_MAX = 20000;
  const PATH_MAX = 400;
  const IMAGE_MAX = 1800000;
  const SLIDE_MAX = 80;
  const KINDS = ['title', 'frame', 'board'];
  const BOARDS = ['mindmap', 'flow', 'gantt'];
  const LAYOUTS = [
    'title', 'section', 'statement', 'title-body', 'bullets', 'agenda', 'steps',
    'quote', 'stats', 'split', 'compare', 'image', 'photo-left', 'photo-right', 'blank',
  ];
  const THEMES = ['light', 'ink', 'dusk', 'paper', 'mint'];
  const RATIOS = ['16x9', '4x3'];
  const LAYOUT_LABEL = {
    title: 'Title',
    section: 'Section',
    statement: 'Statement',
    'title-body': 'Title + body',
    bullets: 'Bullets',
    agenda: 'Agenda',
    steps: 'Steps',
    quote: 'Quote',
    stats: 'Stat',
    split: 'Two columns',
    compare: 'Three columns',
    image: 'Image',
    'photo-left': 'Image left',
    'photo-right': 'Image right',
    blank: 'Blank',
  };
  const LAYOUT_HINT = {
    title: 'Big title and subtitle',
    section: 'Chapter or section break',
    statement: 'Kicker and a bold claim',
    'title-body': 'Title with a paragraph',
    bullets: 'Title and a list',
    agenda: 'Numbered agenda',
    steps: 'Numbered steps',
    quote: 'Pull quote',
    stats: 'Big number and label',
    split: 'Title and two columns',
    compare: 'Three columns',
    image: 'Picture and caption',
    'photo-left': 'Picture with text',
    'photo-right': 'Text with picture',
    blank: 'Free text',
  };

  let seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function clamp(n, a, b) {
    return Math.min(b, Math.max(a, n));
  }

  function str(v, max) {
    const s = typeof v === 'string' ? v : '';
    return max ? s.slice(0, max) : s;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function safeImageSrc(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)/i.test(s)) {
      return s.length > IMAGE_MAX ? '' : s;
    }
    try {
      const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s.replace(/^\/\//, '');
      const u = new URL(withProto);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.slice(0, 2000);
    } catch (e) { /* ignore */ }
    return '';
  }

  function defaultView() {
    return { index: 0 };
  }

  function defaultCrop() {
    return { x: 0, y: 0, w: 1, h: 1 };
  }

  function normalizeCrop(raw) {
    const crop = defaultCrop();
    if (!raw || typeof raw !== 'object') return crop;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    crop.w = clamp(Number.isFinite(w) ? w : 1, 0.12, 1);
    crop.h = clamp(Number.isFinite(h) ? h : 1, 0.12, 1);
    crop.x = clamp(Number.isFinite(x) ? x : 0, 0, 1 - crop.w);
    crop.y = clamp(Number.isFinite(y) ? y : 0, 0, 1 - crop.h);
    return crop;
  }

  function resizeCrop(src, handle, point) {
    const crop = normalizeCrop(src);
    const p = point || { x: 0, y: 0 };
    const px = Number.isFinite(Number(p.x)) ? Number(p.x) : crop.x;
    const py = Number.isFinite(Number(p.y)) ? Number(p.y) : crop.y;
    const min = 0.12;
    let x1 = crop.x;
    let y1 = crop.y;
    let x2 = crop.x + crop.w;
    let y2 = crop.y + crop.h;
    const side = String(handle || '');
    if (side.indexOf('w') >= 0) x1 = clamp(px, 0, x2 - min);
    if (side.indexOf('e') >= 0) x2 = clamp(px, x1 + min, 1);
    if (side.indexOf('n') >= 0) y1 = clamp(py, 0, y2 - min);
    if (side.indexOf('s') >= 0) y2 = clamp(py, y1 + min, 1);
    return normalizeCrop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }

  function isFullCrop(crop) {
    const c = normalizeCrop(crop);
    return c.x <= 0.002 && c.y <= 0.002 && c.w >= 0.996 && c.h >= 0.996;
  }

  function normalizeCam(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const zoom = Number(raw.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
    const cam = { x, y, zoom: clamp(zoom, 0.05, 8) };
    const cw = Number(raw.cw);
    const ch = Number(raw.ch);
    if (Number.isFinite(cw) && cw > 0) cam.cw = Math.round(cw);
    if (Number.isFinite(ch) && ch > 0) cam.ch = Math.round(ch);
    return cam;
  }

  function defaultSlide(kind, props) {
    const o = props || {};
    const ts = nowIso();
    const k = KINDS.indexOf(kind) >= 0 ? kind : 'title';
    const board = BOARDS.indexOf(o.board) >= 0 ? o.board : '';
    return {
      id: uid('slide_'),
      kind: k === 'frame' && board === 'gantt' ? 'board' : k,
      layout: LAYOUTS.indexOf(o.layout) >= 0 ? o.layout : 'title',
      title: str(o.title, TITLE_MAX),
      subtitle: str(o.subtitle, TITLE_MAX),
      body: str(o.body, TEXT_MAX),
      right: str(o.right, TEXT_MAX),
      aside: str(o.aside, TEXT_MAX),
      image: safeImageSrc(o.image),
      notes: str(o.notes, NOTES_MAX),
      path: str(o.path, PATH_MAX),
      board,
      frameId: board === 'gantt' ? '' : str(o.frameId, 80),
      crop: normalizeCrop(o.crop),
      cam: normalizeCam(o.cam),
      showGrid: !!o.showGrid && k !== 'title',
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function createEmpty() {
    const ts = nowIso();
    return {
      version: 1,
      title: 'Deck',
      theme: 'light',
      ratio: '16x9',
      slides: [defaultSlide('title', { title: 'New deck', subtitle: 'Custom slides, plus frames from your boards' })],
      view: defaultView(),
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function normalizeView(raw, slideCount) {
    const view = defaultView();
    const n = Math.max(1, slideCount || 1);
    if (raw && typeof raw === 'object') {
      const idx = Number(raw.index);
      view.index = Number.isFinite(idx) ? clamp(Math.round(idx), 0, n - 1) : 0;
    }
    return view;
  }

  function normalizeSlide(raw) {
    if (!raw || typeof raw !== 'object') return defaultSlide('title');
    const kind = raw.kind === 'frame' || raw.kind === 'board' ? raw.kind : 'title';
    const slide = defaultSlide(kind, raw);
    if (typeof raw.id === 'string' && raw.id) slide.id = str(raw.id, 80);
    if (typeof raw.createdAt === 'string') slide.createdAt = raw.createdAt;
    if (typeof raw.updatedAt === 'string') slide.updatedAt = raw.updatedAt;
    if (slide.kind !== 'title' && !slide.path) {
      slide.kind = 'title';
      slide.board = '';
      slide.frameId = '';
      slide.showGrid = false;
    }
    if (slide.board === 'gantt') {
      slide.kind = 'board';
      slide.frameId = '';
    }
    return slide;
  }

  function normalize(raw) {
    const data = createEmpty();
    if (!raw || typeof raw !== 'object') return data;
    data.title = str(raw.title, 120) || 'Deck';
    data.theme = THEMES.indexOf(raw.theme) >= 0 ? raw.theme : 'light';
    data.ratio = RATIOS.indexOf(raw.ratio) >= 0 ? raw.ratio : '16x9';
    data.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
    data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : data.createdAt;
    const src = Array.isArray(raw.slides) ? raw.slides : [];
    const seen = {};
    const slides = [];
    src.forEach((item) => {
      if (slides.length >= SLIDE_MAX) return;
      const slide = normalizeSlide(item);
      if (seen[slide.id]) slide.id = uid('slide_');
      seen[slide.id] = true;
      slides.push(slide);
    });
    data.slides = slides.length ? slides : [defaultSlide('title', { title: 'New deck' })];
    data.view = normalizeView(raw.view, data.slides.length);
    return data;
  }

  function currentIndex(data) {
    const n = (data.slides || []).length;
    if (!n) return 0;
    return clamp(Math.round(Number(data.view && data.view.index) || 0), 0, n - 1);
  }

  function currentSlide(data) {
    return (data.slides || [])[currentIndex(data)] || null;
  }

  function setIndex(data, index) {
    if (!data.view) data.view = defaultView();
    data.view.index = clamp(Math.round(Number(index) || 0), 0, Math.max(0, data.slides.length - 1));
    return data.view.index;
  }

  function insertSlide(data, afterIndex, slide) {
    if ((data.slides || []).length >= SLIDE_MAX) return null;
    const at = Number.isFinite(Number(afterIndex)) ? Number(afterIndex) : currentIndex(data);
    const insert = clamp(Math.round(at) + 1, 0, data.slides.length);
    data.slides.splice(insert, 0, slide);
    setIndex(data, insert);
    data.updatedAt = nowIso();
    return slide;
  }

  function addSlide(data, afterIndex, layout) {
    return insertSlide(data, afterIndex, defaultSlide('title', { layout: layout || 'title-body', title: '' }));
  }

  function addFrameSlide(data, afterIndex, spec) {
    const o = spec || {};
    if (!o.path || BOARDS.indexOf(o.board) < 0) return null;
    const kind = o.board === 'gantt' || !o.frameId ? 'board' : 'frame';
    return insertSlide(data, afterIndex, defaultSlide(kind, o));
  }

  function duplicateSlide(data, index) {
    const i = Number.isFinite(Number(index)) ? Number(index) : currentIndex(data);
    const src = data.slides[i];
    if (!src) return null;
    if (data.slides.length >= SLIDE_MAX) return null;
    const copy = normalizeSlide(src);
    copy.id = uid('slide_');
    copy.createdAt = nowIso();
    copy.updatedAt = copy.createdAt;
    data.slides.splice(i + 1, 0, copy);
    setIndex(data, i + 1);
    data.updatedAt = nowIso();
    return copy;
  }

  function deleteSlide(data, index) {
    if ((data.slides || []).length <= 1) return false;
    const i = Number.isFinite(Number(index)) ? Number(index) : currentIndex(data);
    if (!data.slides[i]) return false;
    data.slides.splice(i, 1);
    setIndex(data, Math.min(i, data.slides.length - 1));
    data.updatedAt = nowIso();
    return true;
  }

  function moveSlide(data, from, to) {
    const n = data.slides.length;
    const a = clamp(Math.round(Number(from) || 0), 0, n - 1);
    const b = clamp(Math.round(Number(to) || 0), 0, n - 1);
    if (a === b) return false;
    const cur = data.slides[currentIndex(data)];
    const [slide] = data.slides.splice(a, 1);
    data.slides.splice(b, 0, slide);
    if (cur) setIndex(data, data.slides.indexOf(cur));
    data.updatedAt = nowIso();
    return true;
  }

  function setLayout(data, index, layout) {
    const slide = data.slides[index];
    if (!slide || slide.kind !== 'title' || LAYOUTS.indexOf(layout) < 0) return false;
    slide.layout = layout;
    slide.updatedAt = nowIso();
    data.updatedAt = nowIso();
    return true;
  }

  function setTheme(data, theme) {
    if (THEMES.indexOf(theme) < 0) return false;
    data.theme = theme;
    data.updatedAt = nowIso();
    return true;
  }

  function setRatio(data, ratio) {
    if (RATIOS.indexOf(ratio) < 0) return false;
    data.ratio = ratio;
    data.updatedAt = nowIso();
    return true;
  }

  function bulletLines(text) {
    return str(text, TEXT_MAX).split(/\n+/).map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 16);
  }

  function numberLines(text) {
    return str(text, TEXT_MAX).split(/\n+/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 16);
  }

  function setCrop(data, index, crop) {
    const slide = data.slides[index];
    if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board')) return false;
    slide.crop = normalizeCrop(crop);
    slide.updatedAt = nowIso();
    data.updatedAt = nowIso();
    return true;
  }

  function setCam(data, index, cam) {
    const slide = data.slides[index];
    if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board')) return false;
    slide.cam = normalizeCam(cam);
    slide.updatedAt = nowIso();
    data.updatedAt = nowIso();
    return true;
  }

  function setShowGrid(data, index, on) {
    const slide = data.slides[index];
    if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board')) return false;
    slide.showGrid = !!on;
    slide.updatedAt = nowIso();
    data.updatedAt = nowIso();
    return true;
  }

  function showsPresentGrid(slide) {
    return !!(slide && (slide.kind === 'frame' || slide.kind === 'board') && slide.showGrid);
  }

  function slideLabel(slide) {
    if (!slide) return 'Slide';
    if (slide.title) return slide.title;
    if (slide.kind === 'frame') return slide.frameId ? 'Frame' : 'Board';
    if (slide.kind === 'board') return slide.board ? slide.board : 'Board';
    return 'Untitled';
  }

  function createStarter() {
    const data = createEmpty();
    data.title = 'Review deck';
    data.slides = [
      defaultSlide('title', { title: 'Review', subtitle: 'Frames from the boards, in order' }),
      defaultSlide('title', { layout: 'section', title: 'How this works' }),
      defaultSlide('title', {
        layout: 'bullets',
        title: 'Build a playlist',
        body: 'Write title, bullets, quote, or two-column slides\nAdd a picture slide, or a blank one\nDrop in a frame from a mindmap, flow, or Gantt',
        notes: 'Custom slides are authored here. Frame slides embed a live, read-only copy of a board.',
      }),
    ];
    data.view.index = 0;
    return normalize(data);
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 120);
    norm.updatedAt = nowIso();
    const json = JSON.stringify(norm).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Deck').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="slides">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="slides-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isSlidesHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']slides["']/.test(html);
  }

  function parseHtml(html) {
    if (!isSlidesHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']slides-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return createEmpty();
    try {
      return normalize(JSON.parse(m[1]));
    } catch (e) {
      return createEmpty();
    }
  }

  function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
  }

  return {
    KINDS,
    BOARDS,
    LAYOUTS,
    THEMES,
    RATIOS,
    LAYOUT_LABEL,
    LAYOUT_HINT,
    TITLE_MAX,
    TEXT_MAX,
    NOTES_MAX,
    IMAGE_MAX,
    SLIDE_MAX,
    uid,
    clamp,
    nowIso,
    defaultSlide,
    defaultView,
    defaultCrop,
    normalizeCrop,
    resizeCrop,
    isFullCrop,
    normalizeCam,
    createEmpty,
    createStarter,
    normalize,
    currentIndex,
    currentSlide,
    setIndex,
    addSlide,
    addFrameSlide,
    duplicateSlide,
    deleteSlide,
    moveSlide,
    setLayout,
    setTheme,
    setRatio,
    setCrop,
    setCam,
    setShowGrid,
    showsPresentGrid,
    bulletLines,
    numberLines,
    safeImageSrc,
    slideLabel,
    serializeToHtml,
    isSlidesHtml,
    parseHtml,
    cloneData,
  };
});
