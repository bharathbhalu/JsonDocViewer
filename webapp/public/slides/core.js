// Slides data model: layouts, normalization and (de)serialization.
// Shared by the browser engine and the server (new-file templates).
(function (global) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.SlidesCore = api;

  function factory() {
    // Slide templates. `visuals` is how many linked frame windows the layout
    // shows; `fields` are the text areas it shows.
    const LAYOUTS = [
      { id: 'title', label: 'Title', visuals: 0, fields: ['title', 'subtitle'] },
      { id: 'title-visual', label: 'Title + visual', visuals: 1, fields: ['title'] },
      { id: 'visual', label: 'Visual only', visuals: 1, fields: [] },
      { id: 'two-visuals', label: 'Two visuals', visuals: 2, fields: ['title'] },
      { id: 'visual-text', label: 'Visual + text', visuals: 1, fields: ['title', 'body'] },
      { id: 'section', label: 'Section header', visuals: 0, fields: ['title', 'subtitle'] },
      { id: 'bullets', label: 'Bullets', visuals: 0, fields: ['title', 'body'] },
      { id: 'text-visual', label: 'Text + visual', visuals: 1, fields: ['title', 'body'] },
      { id: 'three-visuals', label: 'Three visuals', visuals: 3, fields: ['title'] },
      { id: 'four-visuals', label: 'Four visuals (grid)', visuals: 4, fields: ['title'] },
      { id: 'visual-caption', label: 'Visual + caption', visuals: 1, fields: ['subtitle'] },
      { id: 'two-columns', label: 'Two text columns', visuals: 0, fields: ['title', 'body', 'body2'] },
      { id: 'quote', label: 'Quote', visuals: 0, fields: ['body', 'subtitle'] },
      { id: 'big-number', label: 'Big number', visuals: 0, fields: ['title', 'subtitle', 'body'] },
      { id: 'title-only', label: 'Title only', visuals: 0, fields: ['title'] },
      { id: 'blank', label: 'Blank', visuals: 0, fields: [] },
    ];
    const LAYOUT_BY_ID = {};
    LAYOUTS.forEach((l) => { LAYOUT_BY_ID[l.id] = l; });
    const DEFAULT_LAYOUT = 'title-visual';
    // Deck colour themes. `dark` decides whether linked visuals (e.g. gantt
    // views) are rendered with dark colours; 'auto' follows the app theme.
    const THEMES = [
      { id: 'light', label: 'Light', dark: false },
      { id: 'dark', label: 'Dark', dark: true },
      { id: 'auto', label: 'Match app', dark: null },
      { id: 'slate', label: 'Slate', dark: true },
      { id: 'ocean', label: 'Ocean', dark: true },
      { id: 'contrast', label: 'High contrast', dark: true },
      { id: 'sand', label: 'Sand', dark: false },
      { id: 'mint', label: 'Mint', dark: false },
      { id: 'rose', label: 'Rose', dark: false },
    ];
    const THEME_IDS = new Set(THEMES.map((t) => t.id));
    // Gantt files have no frames; a visual picks one of the gantt views.
    const GANTT_VIEWS = [
      { id: 'chart', label: 'Timeline' },
      { id: 'sheet', label: 'Sheet' },
      { id: 'analytics', label: 'Analytics' },
    ];
    // Smallest window side, as a fraction of the frame.
    const MIN_WIN = 0.02;

    function uid(prefix) {
      return prefix + Math.random().toString(36).slice(2, 10);
    }

    function layoutOf(id) {
      return LAYOUT_BY_ID[id] || LAYOUT_BY_ID[DEFAULT_LAYOUT];
    }

    function fullWindow() {
      return { x: 0, y: 0, w: 1, h: 1 };
    }

    // Window = the part of the source frame shown on the slide, as fractions
    // of the frame so it follows the frame if the frame is moved.
    function clampWindow(win) {
      const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      let w = Math.min(1, Math.max(MIN_WIN, n(win && win.w, 1)));
      let h = Math.min(1, Math.max(MIN_WIN, n(win && win.h, 1)));
      const x = Math.min(1 - w, Math.max(0, n(win && win.x, 0)));
      const y = Math.min(1 - h, Math.max(0, n(win && win.y, 0)));
      return { x, y, w, h };
    }

    // An image is either a workspace file ({ path }) or a web address ({ url }).
    function normalizeImage(img, fits) {
      if (!img || typeof img !== 'object') return null;
      const path = typeof img.path === 'string' && img.path ? img.path : null;
      const url = !path && typeof img.url === 'string' && /^(https?:|data:image\/)/i.test(img.url) ? img.url : null;
      if (!path && !url) return null;
      const out = path ? { path } : { url };
      out.fit = fits.includes(img.fit) ? img.fit : fits[0];
      return out;
    }

    // A visual slot shows either a window of a frame (source) or an image.
    function normalizeVisual(v) {
      const src = v && v.source;
      const source = src && typeof src.path === 'string' && src.path
        ? { path: src.path, frameId: typeof src.frameId === 'string' && src.frameId ? src.frameId : '__all__' }
        : null;
      const image = source ? null : normalizeImage(v && v.image, ['contain', 'cover']);
      return { source, image, window: clampWindow(v && v.window) };
    }

    // Slide background image, dimmed with the theme colour so text stays readable.
    function normalizeBackground(bg) {
      const img = normalizeImage(bg, ['cover', 'contain']);
      if (!img) return null;
      const dim = Number(bg.dim);
      img.dim = Number.isFinite(dim) ? Math.min(0.9, Math.max(0, dim)) : 0.35;
      return img;
    }

    function emptyVisual() {
      return { source: null, image: null, window: fullWindow() };
    }

    function createSlide(layoutId, extra) {
      const layout = layoutOf(layoutId);
      const slide = Object.assign({
        id: uid('s_'),
        layout: layout.id,
        title: '',
        subtitle: '',
        body: '',
        body2: '',
        visuals: [],
        background: null,
      }, extra || {});
      while (slide.visuals.length < layout.visuals) slide.visuals.push(emptyVisual());
      return slide;
    }

    function createEmpty(title) {
      return { version: 1, title: title || 'Slides', theme: 'light', slides: [createSlide('title', { title: title || 'Untitled deck' })] };
    }

    function createStarter() {
      return {
        version: 1,
        title: 'Slides',
        theme: 'light',
        slides: [
          createSlide('title', { title: 'Presentation title', subtitle: 'Subtitle or presenter' }),
          createSlide('title-visual', { title: 'Overview' }),
          createSlide('bullets', { title: 'Key points', body: 'First point\nSecond point\nThird point' }),
        ],
      };
    }

    function str(v) {
      return typeof v === 'string' ? v : '';
    }

    function normalize(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const seen = new Set();
      const slides = (Array.isArray(d.slides) ? d.slides : [])
        .filter((s) => s && typeof s === 'object')
        .map((s) => {
          const layout = layoutOf(s.layout);
          let id = typeof s.id === 'string' && s.id ? s.id : uid('s_');
          if (seen.has(id)) id = uid('s_');
          seen.add(id);
          const visuals = (Array.isArray(s.visuals) ? s.visuals : []).map(normalizeVisual);
          while (visuals.length < layout.visuals) visuals.push(emptyVisual());
          return {
            id,
            layout: layout.id,
            title: str(s.title),
            subtitle: str(s.subtitle),
            body: str(s.body),
            body2: str(s.body2),
            visuals,
            background: normalizeBackground(s.background),
          };
        });
      if (!slides.length) slides.push(createSlide('title', { title: 'Untitled deck' }));
      const theme = THEME_IDS.has(d.theme) ? d.theme : 'light';
      return { version: 1, title: str(d.title) || 'Slides', theme, slides };
    }

    function isSlidesHtml(html) {
      return /data-docviewer\s*=\s*["']slides["']/.test(String(html || ''));
    }

    function parseHtml(html) {
      if (!isSlidesHtml(html)) return null;
      const m = String(html).match(/<script[^>]*id=["']slides-data["'][^>]*>([\s\S]*?)<\/script>/i);
      if (!m) return normalize(null);
      try {
        return normalize(JSON.parse(m[1]));
      } catch (e) {
        return normalize(null);
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function serializeToHtml(data, title) {
      const d = normalize(data);
      const name = title || (d.slides[0] && d.slides[0].title) || d.title || 'Slides';
      // Escape "<" so text like "</script>" can't end the data block.
      const json = JSON.stringify(d, null, 2).replace(/</g, '\\u003c');
      return '<!DOCTYPE html>\n<html lang="en" data-docviewer="slides">\n'
        + '<head><meta charset="UTF-8"><title>' + escapeHtml(name) + '</title></head>\n<body>\n'
        + '<script type="application/json" id="slides-data">\n' + json + '\n</script>\n'
        + '</body>\n</html>\n';
    }

    return {
      LAYOUTS,
      THEMES,
      GANTT_VIEWS,
      MIN_WIN,
      layoutOf,
      fullWindow,
      clampWindow,
      normalizeBackground,
      emptyVisual,
      createSlide,
      createEmpty,
      createStarter,
      normalize,
      isSlidesHtml,
      parseHtml,
      serializeToHtml,
      escapeHtml,
      uid,
    };
  }
})(typeof window !== 'undefined' ? window : this);
