// Slides editor: a deck of slides built from layouts (templates). Visual
// slots show a live, cropped "window" of a frame from a mindmap or flow, or
// of a gantt chart. Present mode shows only the slides (and so only the
// windows), full screen.
(function (global) {
  const C = global.SlidesCore;
  const SLIDE_W = 1280;
  const SLIDE_H = 720;
  const WHOLE = '__all__';
  const SOURCE_KINDS = { mindmap: 'Mindmap', flow: 'Flow', gantt: 'Gantt' };
  const EXPORT_URLS = {
    mindmap: '/mindmap/export.js?v=25',
    flow: '/flow/export.js?v=14',
  };

  const esc = (s) => C.escapeHtml(s == null ? '' : s);
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const PPTX_URL = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
  const PX_PER_IN = 96; // 1280x720 px slide == 13.333x7.5 in (PowerPoint widescreen)

  // Layout pictograms on a 36x20 grid: t = text line, v = visual, a = accent.
  const LAYOUT_ICONS = {
    title: [['t', 8, 7, 20, 3], ['t', 11, 12, 14, 2]],
    'title-visual': [['t', 4, 3, 14, 2], ['v', 4, 7, 28, 10]],
    visual: [['v', 3, 3, 30, 14]],
    'two-visuals': [['t', 4, 3, 14, 2], ['v', 4, 7, 13, 10], ['v', 19, 7, 13, 10]],
    'visual-text': [['t', 4, 3, 14, 2], ['v', 4, 7, 16, 10], ['t', 23, 8, 9, 2], ['t', 23, 12, 7, 2]],
    section: [['a', 0, 0, 4, 20], ['t', 9, 8, 20, 3]],
    bullets: [['t', 4, 3, 14, 2], ['t', 6, 8, 22, 2], ['t', 6, 12, 18, 2]],
    'text-visual': [['t', 4, 3, 14, 2], ['t', 4, 8, 9, 2], ['t', 4, 12, 7, 2], ['v', 16, 7, 16, 10]],
    'three-visuals': [['t', 4, 3, 14, 2], ['v', 4, 7, 8, 10], ['v', 14, 7, 8, 10], ['v', 24, 7, 8, 10]],
    'four-visuals': [['t', 4, 2, 14, 2], ['v', 4, 6, 13, 5], ['v', 19, 6, 13, 5], ['v', 4, 12, 13, 5], ['v', 19, 12, 13, 5]],
    'visual-caption': [['v', 3, 3, 30, 11], ['t', 10, 16, 16, 2]],
    'two-columns': [['t', 4, 3, 14, 2], ['t', 4, 8, 12, 2], ['t', 4, 12, 10, 2], ['t', 20, 8, 12, 2], ['t', 20, 12, 10, 2]],
    quote: [['a', 5, 5, 3, 4], ['t', 10, 6, 20, 2], ['t', 10, 10, 16, 2], ['t', 18, 15, 12, 1.5]],
    'big-number': [['a', 11, 5, 14, 6], ['t', 12, 13, 12, 2]],
    'title-only': [['t', 4, 3, 14, 2]],
    blank: [],
  };

  function layoutIcon(id) {
    const rects = (LAYOUT_ICONS[id] || []).map(([k, x, y, w, h]) => {
      const fill = k === 'a' ? 'var(--sl-accent)' : 'currentColor';
      const op = k === 'v' ? 0.35 : k === 't' ? 0.75 : 1;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.8" fill="${fill}" opacity="${op}"/>`;
    }).join('');
    return `<svg class="sl-layout-icon" viewBox="0 0 36 20" aria-hidden="true"><rect x="0.5" y="0.5" width="35" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>${rects}</svg>`;
  }

  // Where an image ({ path } in the workspace or { url }) is loaded from.
  function imageUrl(img) {
    return img.path ? '/api/raw?path=' + encodeURIComponent(img.path) : img.url;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not load image'));
      im.src = src;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function urlToDataUrl(url) {
    if (/^data:/i.test(url)) return url;
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('Could not load image');
    return blobToDataUrl(await res.blob());
  }

  // Draw an image into a w x h PNG, fitted (contain) or filled (cover),
  // optionally covered by a colour overlay at `dim` opacity.
  async function rasterize(src, w, h, fit, overlay) {
    const im = await loadImage(src);
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    const iw = im.naturalWidth || im.width || 1;
    const ih = im.naturalHeight || im.height || 1;
    const k = fit === 'cover' ? Math.max(canvas.width / iw, canvas.height / ih) : Math.min(canvas.width / iw, canvas.height / ih);
    const dw = iw * k;
    const dh = ih * k;
    ctx.drawImage(im, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    if (overlay && overlay.dim > 0) {
      ctx.globalAlpha = overlay.dim;
      ctx.fillStyle = overlay.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL('image/png');
  }

  function cssColorToHex(c) {
    const m = String(c || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!m) return '000000';
    return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  // `umd`: the app page has Monaco's AMD loader, which a UMD bundle would
  // register with instead of defining a global. Run such a bundle with
  // `define` shadowed for that script only (hiding window.define would break
  // Monaco's own loads happening at the same time).
  // `umd` may list top-level `var` names the bundle declares (they would stay
  // local to the wrapper); those are copied onto the page.
  async function loadScriptOnce(src, ready, umd) {
    if (ready()) return;
    if (umd) {
      const res = await fetch(src);
      if (!res.ok) throw new Error('Failed to load ' + src);
      const code = await res.text();
      const names = Array.isArray(umd) ? umd : [];
      const exportVars = names.map((n) => `if(typeof ${n}!=='undefined')this.${n}=${n};`).join('');
      // eslint-disable-next-line no-new-func
      new Function('define', 'module', 'exports', code + '\n;' + exportVars + '\n//# sourceURL=' + src).call(global, undefined, undefined, undefined);
      if (!ready()) throw new Error('Loaded ' + src + ' without its API');
      return;
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (ready() ? resolve() : reject(new Error('Loaded ' + src + ' without its API')));
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.body.appendChild(s);
    });
  }

  function kindOfHtml(html) {
    const m = String(html || '').match(/data-docviewer\s*=\s*["'](\w+)["']/);
    return m && SOURCE_KINDS[m[1]] ? m[1] : null;
  }

  function svgDataUrl(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // Crop a rendered frame SVG (W x H user units) to a window given in
  // fractions of the frame, by rewriting the root viewBox.
  function cropSvg(svg, W, H, win) {
    const w = C.clampWindow(win);
    const vx = w.x * W;
    const vy = w.y * H;
    const vw = Math.max(1, w.w * W);
    const vh = Math.max(1, w.h * H);
    return svg.replace(/<svg\b[^>]*>/, (tag) => tag
      .replace(/\s(width|height|viewBox|preserveAspectRatio)="[^"]*"/g, '')
      .replace(/^<svg/, `<svg width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet"`));
  }

  // The mindmap/flow exports paint an opaque canvas background; drop it so the
  // visual sits on the slide's theme colour (frames keep their own fill).
  function stripBackground(svg) {
    return svg.replace(/<rect width="[^"]*" height="[^"]*" fill="(?:#fafafa|#eef1f5|url\(#mmDots\))"\/>/g, '');
  }

  function boundsOf(rects, pad) {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    rects.forEach((r) => {
      if (!r) return;
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + (r.w || 0)); y2 = Math.max(y2, r.y + (r.h || 0));
    });
    if (!isFinite(x1)) return { x: 0, y: 0, w: 800, h: 450 };
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }

  // Frame rect padded the same way the mindmap/flow frame exports do, so
  // the frame title (drawn above the frame) is included.
  function frameRect(f) {
    return { x: f.x - 16, y: f.y - 48, w: f.w + 32, h: f.h + 64 };
  }

  class SlidesEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = typeof this.opts.onChange === 'function' ? this.opts.onChange : () => {};
      this.ensure = this.opts.ensureAssets || {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this.current = 0;
      this._undo = [];
      this._redo = [];
      this._sources = new Map(); // path -> Promise<source>
      this._frames = new Map(); // path|frameId -> Promise<{svg,W,H}>
      this._destroyed = false;
      this._present = null;
      this._build();
      this._onKey = this._onKey.bind(this);
      this._onResize = () => this._fitStage();
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('resize', this._onResize);
      this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._fitStage()) : null;
      if (this._ro) this._ro.observe(this.els.stage);
      // 'Match app' theme: re-render when the app switches light/dark.
      this._themeObs = typeof MutationObserver === 'function' ? new MutationObserver(() => {
        if (this.data.theme !== 'auto') return;
        // Don't rebuild the slide under the user's cursor: wait for the
        // text field to lose focus.
        const a = document.activeElement;
        if (a && a.closest && a.closest('.sl-slide [data-field]') && this.container.contains(a)) {
          a.addEventListener('blur', () => this.render(), { once: true });
        } else this.render();
        if (this._present) this._presentShow();
      }) : null;
      if (this._themeObs) this._themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // ---- public API used by the app ----
    loadFromHtml(html) {
      // Dialogs and present mode point at the old slides: close / refresh them.
      if (this.els && !this.els.modal.classList.contains('hidden')) this._closeModal();
      this.data = C.parseHtml(html) || C.createEmpty();
      this.current = Math.min(this.current, this.data.slides.length - 1);
      if (this._present) {
        this._present.index = Math.min(this._present.index, this.data.slides.length - 1);
        this._presentShow();
      }
      this._undo = [];
      this._redo = [];
      this._sources.clear();
      this._frames.clear();
      this.render();
    }

    serializeToHtml() {
      return C.serializeToHtml(this.data);
    }

    getData() {
      return this.data;
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      this.render();
    }

    flushEdit() {
      const a = document.activeElement;
      if (a && this.container.contains(a) && a.blur) a.blur();
    }

    destroy() {
      this._destroyed = true;
      this._exitPresent();
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('resize', this._onResize);
      document.removeEventListener('mousedown', this._onDocDown);
      if (this._themeObs) this._themeObs.disconnect();
      clearTimeout(this._railTimer);
      if (this._ro) this._ro.disconnect();
      this.container.innerHTML = '';
    }

    // ---- theme ----
    // Resolved theme id ('auto' becomes light or dark from the app).
    _themeId() {
      const t = this.data.theme || 'light';
      if (t !== 'auto') return t;
      return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    _isDark() {
      const t = C.THEMES.find((x) => x.id === this._themeId());
      return !!(t && t.dark);
    }

    _setTheme(id) {
      if (this.data.theme === id) return;
      this._change(() => { this.data.theme = id; });
    }

    // ---- data helpers ----
    _slide() {
      return this.data.slides[this.current];
    }

    _snapshot() {
      return JSON.stringify({ data: this.data, current: this.current });
    }

    _pushUndo() {
      this._undo.push(this._snapshot());
      if (this._undo.length > 80) this._undo.shift();
      this._redo = [];
    }

    _restore(snap) {
      const s = JSON.parse(snap);
      this.data = C.normalize(s.data);
      this.current = Math.min(s.current, this.data.slides.length - 1);
      this.render();
      this.onChange();
    }

    undo() {
      if (!this._undo.length) return;
      this._redo.push(this._snapshot());
      this._restore(this._undo.pop());
    }

    redo() {
      if (!this._redo.length) return;
      this._undo.push(this._snapshot());
      this._restore(this._redo.pop());
    }

    // Apply a change as one undo step, then re-render and mark dirty.
    _change(fn) {
      if (this.readOnly) return;
      this._pushUndo();
      fn();
      this.render();
      this.onChange();
    }

    // ---- DOM ----
    _build() {
      const layoutOpts = C.LAYOUTS.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('');
      this.container.innerHTML = `
        <div class="sl-root">
          <div class="sl-toolbar">
            <button type="button" data-act="add" title="Add a slide from a layout">＋ Slide</button>
            <label class="sl-layout-pick">Layout <select data-act="layout">${layoutOpts}</select></label>
            <label class="sl-layout-pick">Theme <select data-act="theme">${C.THEMES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></label>
            <button type="button" data-act="dup" title="Duplicate slide">Duplicate</button>
            <button type="button" data-act="up" title="Move slide up">↑</button>
            <button type="button" data-act="down" title="Move slide down">↓</button>
            <button type="button" data-act="del" class="sl-danger" title="Delete slide">Delete</button>
            <button type="button" data-act="background" title="Background image for this slide">Background</button>
            <span class="sl-spacer"></span>
            <button type="button" data-act="refresh" title="Refresh visuals: re-read linked mindmaps, flows and gantt charts" aria-label="Refresh visuals">↻</button>
            <button type="button" data-act="pptx" title="Download as a PowerPoint file (.pptx)">⤓ .pptx</button>
            <button type="button" data-act="present" class="sl-primary" title="Present (F5)">▶ Present</button>
          </div>
          <div class="sl-body">
            <div class="sl-rail" role="listbox" aria-label="Slides"></div>
            <div class="sl-stage"><div class="sl-slide-host"></div></div>
          </div>
          <div class="sl-menu hidden" role="menu"></div>
          <div class="sl-modal hidden" role="dialog" aria-modal="true">
            <div class="sl-modal-box">
              <div class="sl-modal-head"><span class="sl-modal-title"></span><button type="button" data-modal="close" aria-label="Close">×</button></div>
              <div class="sl-modal-body"></div>
              <div class="sl-modal-foot"></div>
            </div>
          </div>
        </div>`;
      const root = this.container.querySelector('.sl-root');
      this.els = {
        root,
        toolbar: root.querySelector('.sl-toolbar'),
        layout: root.querySelector('[data-act="layout"]'),
        theme: root.querySelector('[data-act="theme"]'),
        rail: root.querySelector('.sl-rail'),
        stage: root.querySelector('.sl-stage'),
        host: root.querySelector('.sl-slide-host'),
        menu: root.querySelector('.sl-menu'),
        modal: root.querySelector('.sl-modal'),
        modalTitle: root.querySelector('.sl-modal-title'),
        modalBody: root.querySelector('.sl-modal-body'),
        modalFoot: root.querySelector('.sl-modal-foot'),
      };
      this.els.toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (btn) this._toolbarAction(btn.getAttribute('data-act'), btn);
      });
      this.els.layout.addEventListener('change', () => this._setLayout(this.els.layout.value));
      this.els.theme.addEventListener('change', () => this._setTheme(this.els.theme.value));
      this.els.modal.addEventListener('click', (e) => {
        if (e.target === this.els.modal || e.target.closest('[data-modal="close"]')) this._closeModal();
      });
      document.addEventListener('mousedown', this._onDocDown = (e) => {
        if (!this.els.menu.classList.contains('hidden') && !this.els.menu.contains(e.target)
          && !e.target.closest('[data-act="add"]')) this._closeMenu();
      });
    }

    _toolbarAction(act, btn) {
      if (act === 'present') return this.present();
      if (act === 'pptx') return this._exportPptxFromToolbar(btn);
      if (act === 'refresh') {
        this._sources.clear();
        this._frames.clear();
        this.render();
        return;
      }
      if (this.readOnly) return;
      if (act === 'add') return this._openLayoutMenu(btn);
      if (act === 'background') return this._openBackgroundEditor();
      if (act === 'dup') {
        return this._change(() => {
          const copy = JSON.parse(JSON.stringify(this._slide()));
          copy.id = C.uid('s_');
          this.data.slides.splice(this.current + 1, 0, copy);
          this.current += 1;
        });
      }
      if (act === 'del') {
        if (this.data.slides.length <= 1) return;
        return this._change(() => {
          this.data.slides.splice(this.current, 1);
          this.current = Math.min(this.current, this.data.slides.length - 1);
        });
      }
      if (act === 'up' || act === 'down') {
        const to = this.current + (act === 'up' ? -1 : 1);
        if (to < 0 || to >= this.data.slides.length) return;
        this._moveSlide(this.current, to);
      }
    }

    _moveSlide(from, to) {
      if (from === to) return;
      this._change(() => {
        const [s] = this.data.slides.splice(from, 1);
        this.data.slides.splice(to, 0, s);
        this.current = to;
      });
    }

    _setLayout(id) {
      const slide = this._slide();
      if (!slide || slide.layout === id) return;
      this._change(() => {
        slide.layout = id;
        const need = C.layoutOf(id).visuals;
        // Keep existing visuals (they come back if the layout is switched back).
        while (slide.visuals.length < need) slide.visuals.push(C.emptyVisual());
      });
    }

    _openLayoutMenu(btn) {
      const r = btn.getBoundingClientRect();
      const host = this.els.root.getBoundingClientRect();
      this.els.menu.innerHTML = C.LAYOUTS.map((l) => `
        <button type="button" role="menuitem" data-layout="${l.id}">
          ${layoutIcon(l.id)}${esc(l.label)}
        </button>`).join('');
      this.els.menu.style.left = (r.left - host.left) + 'px';
      this.els.menu.style.top = (r.bottom - host.top + 4) + 'px';
      this.els.menu.classList.remove('hidden');
      this.els.menu.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => {
        const id = b.getAttribute('data-layout');
        this._closeMenu();
        this._change(() => {
          this.data.slides.splice(this.current + 1, 0, C.createSlide(id));
          this.current += 1;
        });
      }));
    }

    _closeMenu() {
      this.els.menu.classList.add('hidden');
    }

    // ---- rendering ----
    render() {
      if (this._destroyed) return;
      const slide = this._slide();
      this.els.layout.value = slide ? slide.layout : C.LAYOUTS[0].id;
      this.els.root.classList.toggle('is-readonly', this.readOnly);
      this.els.toolbar.querySelectorAll('button[data-act]').forEach((b) => {
        const act = b.getAttribute('data-act');
        b.disabled = this.readOnly && act !== 'present' && act !== 'refresh' && act !== 'pptx';
      });
      this.els.layout.disabled = this.readOnly;
      this.els.theme.value = this.data.theme || 'light';
      this.els.theme.disabled = this.readOnly;
      this._renderRail();
      this._renderStage();
    }

    _renderRail() {
      const rail = this.els.rail;
      rail.innerHTML = '';
      this.data.slides.forEach((s, i) => {
        const item = document.createElement('div');
        item.className = 'sl-thumb' + (i === this.current ? ' active' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', i === this.current ? 'true' : 'false');
        item.draggable = !this.readOnly;
        item.innerHTML = `<span class="sl-thumb-num">${i + 1}</span><div class="sl-thumb-frame"></div>`;
        const frame = item.querySelector('.sl-thumb-frame');
        const el = this._slideEl(s, { editable: false });
        frame.appendChild(el);
        this._scaleInto(el, frame);
        item.addEventListener('click', () => {
          if (this.current === i) return;
          this.flushEdit();
          this.current = i;
          this.render();
        });
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/x-slide', String(i));
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragover', (e) => {
          if (![...e.dataTransfer.types].includes('text/x-slide')) return;
          e.preventDefault();
          item.classList.add('drop-target');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
        item.addEventListener('drop', (e) => {
          item.classList.remove('drop-target');
          const from = Number(e.dataTransfer.getData('text/x-slide'));
          if (!Number.isInteger(from)) return;
          e.preventDefault();
          this._moveSlide(from, i);
        });
        rail.appendChild(item);
      });
      const active = rail.querySelector('.sl-thumb.active');
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }

    _renderStage() {
      const host = this.els.host;
      host.innerHTML = '';
      const slide = this._slide();
      if (!slide) return;
      const el = this._slideEl(slide, { editable: !this.readOnly });
      host.appendChild(el);
      this._stageSlide = el;
      this._fitStage();
    }

    _fitStage() {
      if (!this._stageSlide) return;
      const r = this.els.stage.getBoundingClientRect();
      const k = Math.max(0.1, Math.min((r.width - 48) / SLIDE_W, (r.height - 48) / SLIDE_H));
      this.els.host.style.width = SLIDE_W * k + 'px';
      this.els.host.style.height = SLIDE_H * k + 'px';
      this._stageSlide.style.transform = `scale(${k})`;
    }

    _scaleInto(el, box) {
      const k = (box.clientWidth || 176) / SLIDE_W;
      el.style.transform = `scale(${k})`;
    }

    // Build a 1280x720 slide element (scaled by the caller).
    _slideEl(slide, { editable, present }) {
      const layout = C.layoutOf(slide.layout);
      const el = document.createElement('div');
      el.className = `sl-slide sl-layout-${layout.id} sl-theme-${this._themeId()}` + (editable ? ' is-editable' : '');
      const field = (name, cls, ph) => {
        const value = slide[name] || '';
        if (!editable && !value && present) return '';
        const bullets = !editable && cls.includes('sl-bullets');
        return `<div class="${cls}" data-field="${name}" data-ph="${esc(ph)}"${editable ? ' contenteditable="plaintext-only" spellcheck="true"' : ''}>${bullets ? this._bulletsHtml(value) : esc(value)}</div>`;
      };
      const title = () => field('title', 'sl-title', 'Slide title');
      const visual = (i) => `<div class="sl-visual" data-vi="${i}"></div>`;
      let inner = '';
      switch (layout.id) {
        case 'title':
          inner = `<div class="sl-center">${field('title', 'sl-title sl-title-xl', 'Presentation title')}${field('subtitle', 'sl-subtitle', 'Subtitle')}</div>`;
          break;
        case 'section':
          inner = `<div class="sl-section-band"></div><div class="sl-section-text">${field('title', 'sl-title sl-title-xl', 'Section title')}${field('subtitle', 'sl-subtitle', 'Optional description')}</div>`;
          break;
        case 'bullets':
          inner = `${field('title', 'sl-title', 'Slide title')}${field('body', 'sl-body-text sl-bullets', 'One point per line')}`;
          break;
        case 'visual':
          inner = `<div class="sl-visuals one full">${visual(0)}</div>`;
          break;
        case 'two-visuals':
          inner = `${field('title', 'sl-title', 'Slide title')}<div class="sl-visuals two">${visual(0)}${visual(1)}</div>`;
          break;
        case 'visual-text':
          inner = `${field('title', 'sl-title', 'Slide title')}<div class="sl-split"><div class="sl-visuals one">${visual(0)}</div>${field('body', 'sl-body-text sl-bullets', 'One point per line')}</div>`;
          break;
        case 'text-visual':
          inner = `${title()}<div class="sl-split sl-split-rev">${field('body', 'sl-body-text sl-bullets', 'One point per line')}<div class="sl-visuals one">${visual(0)}</div></div>`;
          break;
        case 'three-visuals':
          inner = `${title()}<div class="sl-visuals three">${visual(0)}${visual(1)}${visual(2)}</div>`;
          break;
        case 'four-visuals':
          inner = `${title()}<div class="sl-visuals grid">${visual(0)}${visual(1)}${visual(2)}${visual(3)}</div>`;
          break;
        case 'visual-caption':
          inner = `<div class="sl-visuals one">${visual(0)}</div>${field('subtitle', 'sl-caption', 'Caption')}`;
          break;
        case 'two-columns':
          inner = `${title()}<div class="sl-columns">${field('body', 'sl-body-text sl-bullets', 'Left column, one point per line')}${field('body2', 'sl-body-text sl-bullets', 'Right column, one point per line')}</div>`;
          break;
        case 'quote':
          inner = `<div class="sl-quote">${field('body', 'sl-quote-text', 'Quote')}${field('subtitle', 'sl-quote-by', '— Who said it')}</div>`;
          break;
        case 'big-number':
          inner = `<div class="sl-center sl-big">${field('title', 'sl-big-number', '42%')}${field('subtitle', 'sl-big-label', 'What the number means')}${field('body', 'sl-big-note', 'Optional detail')}</div>`;
          break;
        case 'title-only':
          inner = title();
          break;
        case 'blank':
          inner = '';
          break;
        default:
          inner = `${title()}<div class="sl-visuals one">${visual(0)}</div>`;
      }
      el.innerHTML = inner;
      if (slide.background) {
        // Image layer + theme-coloured dim layer, under the content.
        const bg = document.createElement('div');
        bg.className = 'sl-bg';
        bg.style.backgroundImage = `url("${imageUrl(slide.background).replace(/"/g, '%22')}")`;
        bg.style.backgroundSize = slide.background.fit === 'contain' ? 'contain' : 'cover';
        const dim = document.createElement('div');
        dim.className = 'sl-bg-dim';
        dim.style.opacity = String(slide.background.dim);
        el.prepend(bg, dim);
        el.classList.add('has-bg');
      }
      el.querySelectorAll('.sl-visual').forEach((vEl) => {
        const i = Number(vEl.getAttribute('data-vi'));
        this._fillVisual(vEl, slide, i, { editable, present });
      });
      if (editable) this._wireFields(el, slide);
      return el;
    }

    _bulletsHtml(text) {
      const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      return '<ul>' + lines.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>';
    }

    _wireFields(el, slide) {
      el.querySelectorAll('[data-field]').forEach((f) => {
        const name = f.getAttribute('data-field');
        let started = false;
        f.addEventListener('focus', () => { started = false; });
        f.addEventListener('input', () => {
          // One undo step per editing session of a field.
          if (!started) { this._pushUndo(); started = true; }
          slide[name] = f.innerText.replace(/\n$/, '');
          this.onChange();
          clearTimeout(this._railTimer);
          this._railTimer = setTimeout(() => this._renderRail(), 300);
        });
        f.addEventListener('keydown', (e) => {
          // Enter ends single-line fields; the body takes new lines.
          if (e.key === 'Enter' && name !== 'body' && name !== 'body2') { e.preventDefault(); f.blur(); }
          if (e.key === 'Escape') f.blur();
        });
      });
    }

    _fillVisual(vEl, slide, i, { editable, present }) {
      const v = slide.visuals[i] || C.emptyVisual();
      vEl.innerHTML = '';
      if (v.image) {
        this._fillImageVisual(vEl, slide, i, v, editable);
        return;
      }
      if (!v.source) {
        if (present) return;
        vEl.classList.add('is-empty');
        if (editable) {
          vEl.innerHTML = `<div class="sl-pick-row">
            <button type="button" class="sl-pick" data-pick="frame">＋ Frame…<small>mindmap · flow · gantt</small></button>
            <button type="button" class="sl-pick" data-pick="image">＋ Image…<small>upload · workspace · web</small></button>
          </div>`;
          vEl.querySelector('[data-pick="frame"]').addEventListener('click', () => this._openPicker(slide, i));
          vEl.querySelector('[data-pick="image"]').addEventListener('click', () => this._pickVisualImage(slide, i));
        } else vEl.innerHTML = '<span class="sl-empty-label">Visual</span>';
        return;
      }
      const img = document.createElement('img');
      img.className = 'sl-visual-img';
      img.alt = '';
      vEl.appendChild(img);
      vEl.classList.add('is-loading');
      this._renderVisual(v).then((url) => {
        vEl.classList.remove('is-loading');
        img.src = url;
      }).catch((err) => {
        vEl.classList.remove('is-loading');
        vEl.classList.add('is-error');
        img.remove();
        const msg = document.createElement('span');
        msg.className = 'sl-empty-label';
        msg.textContent = (err && err.message) || 'Could not render';
        vEl.appendChild(msg);
      });
      if (editable) {
        const bar = document.createElement('div');
        bar.className = 'sl-visual-bar';
        bar.innerHTML = `
          <span class="sl-visual-src" title="${esc(v.source.path)}">${esc(v.source.path.split('/').pop())}</span>
          <button type="button" data-v="window" title="Choose the part of the frame shown">Adjust window</button>
          <button type="button" data-v="change" title="Pick a different frame">Change</button>
          <button type="button" data-v="remove" title="Remove visual">✕</button>`;
        bar.addEventListener('click', (e) => {
          const b = e.target.closest('[data-v]');
          if (!b) return;
          const act = b.getAttribute('data-v');
          if (act === 'window') this._openWindowEditor(slide, i, v.source);
          if (act === 'change') this._openPicker(slide, i);
          if (act === 'remove') this._change(() => { slide.visuals[i] = C.emptyVisual(); });
        });
        vEl.appendChild(bar);
      }
    }

    _fillImageVisual(vEl, slide, i, v, editable) {
      const img = document.createElement('img');
      img.className = 'sl-visual-img';
      img.alt = '';
      img.style.objectFit = v.image.fit === 'cover' ? 'cover' : 'contain';
      img.addEventListener('error', () => {
        vEl.classList.add('is-error');
        img.remove();
        const msg = document.createElement('span');
        msg.className = 'sl-empty-label';
        msg.textContent = 'Image not found: ' + (v.image.path || v.image.url);
        vEl.prepend(msg);
      });
      img.src = imageUrl(v.image);
      vEl.appendChild(img);
      if (!editable) return;
      const bar = document.createElement('div');
      bar.className = 'sl-visual-bar';
      const name = (v.image.path || v.image.url || '').split('/').pop().slice(0, 60);
      bar.innerHTML = `
        <span class="sl-visual-src" title="${esc(v.image.path || v.image.url)}">${esc(name)}</span>
        <button type="button" data-v="fit" title="Fit inside or fill the area">${v.image.fit === 'cover' ? 'Fit' : 'Fill'}</button>
        <button type="button" data-v="change" title="Pick a different image">Change</button>
        <button type="button" data-v="remove" title="Remove image">✕</button>`;
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        const act = b.getAttribute('data-v');
        if (act === 'fit') this._change(() => { slide.visuals[i].image.fit = v.image.fit === 'cover' ? 'contain' : 'cover'; });
        if (act === 'change') this._pickVisualImage(slide, i);
        if (act === 'remove') this._change(() => { slide.visuals[i] = C.emptyVisual(); });
      });
      vEl.appendChild(bar);
    }

    _pickVisualImage(slide, i) {
      this._openImageChooser('Insert an image', (img) => {
        this._change(() => {
          slide.visuals[i] = { source: null, image: Object.assign({ fit: 'contain' }, img), window: C.fullWindow() };
        });
      });
    }

    // ---- image chooser: upload / workspace file / web address ----
    // Uploads are saved next to the deck in "<deck>-assets/" so the deck
    // links to workspace files rather than embedding large data.
    _assetsFolder() {
      const p = typeof this.opts.getPath === 'function' ? this.opts.getPath() : '';
      if (!p) return 'slide-assets';
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      const base = p.split('/').pop().replace(/\.html?$/i, '');
      return (dir ? dir + '/' : '') + base + '-assets';
    }

    async _uploadImage(file) {
      const content = (await blobToDataUrl(file)).split(',')[1] || '';
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest: this._assetsFolder(), files: [{ name: file.name || 'image.png', content, encoding: 'base64' }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.imported || !data.imported.length) throw new Error(data.error || 'Upload failed');
      return data.imported[0].path;
    }

    _openImageChooser(title, onPick) {
      const body = document.createElement('div');
      body.className = 'sl-imgpick';
      body.innerHTML = `
        <div class="sl-tabs" role="tablist">
          <button type="button" role="tab" data-tab="upload" class="is-on">Upload</button>
          <button type="button" role="tab" data-tab="workspace">From workspace</button>
          <button type="button" role="tab" data-tab="url">Web address</button>
        </div>
        <div class="sl-tab" data-pane="upload">
          <label class="sl-drop">
            <input type="file" accept="image/*" hidden>
            <strong>Choose an image</strong><span>or drop it here · PNG, JPG, GIF, WebP, SVG</span>
          </label>
          <div class="sl-picker-note" data-status></div>
        </div>
        <div class="sl-tab hidden" data-pane="workspace">
          <input type="search" class="sl-picker-search" placeholder="Filter images…">
          <div class="sl-img-grid"><div class="sl-picker-note">Loading…</div></div>
        </div>
        <div class="sl-tab hidden" data-pane="url">
          <input type="url" class="sl-picker-search" placeholder="https://example.com/picture.png" data-url>
          <div class="sl-url-preview"></div>
          <div class="sl-modal-actions"><button type="button" class="sl-primary" data-use-url disabled>Use image</button></div>
        </div>`;
      this._openModal(title, body);
      const token = this._modalToken;
      const pick = (img) => {
        if (token !== this._modalToken || this.els.modal.classList.contains('hidden')) return; // cancelled meanwhile
        this._closeModal();
        onPick(img);
      };
      const tabs = body.querySelectorAll('[data-tab]');
      let wsLoaded = false;
      const show = (name) => {
        tabs.forEach((t) => t.classList.toggle('is-on', t.getAttribute('data-tab') === name));
        body.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.getAttribute('data-pane') !== name));
        if (name === 'workspace' && !wsLoaded) { wsLoaded = true; loadWorkspace(); }
        if (name === 'url') body.querySelector('[data-url]').focus();
      };
      tabs.forEach((t) => t.addEventListener('click', () => show(t.getAttribute('data-tab'))));

      // Upload
      const input = body.querySelector('input[type="file"]');
      const status = body.querySelector('[data-status]');
      const drop = body.querySelector('.sl-drop');
      const upload = async (file) => {
        if (!file || !/^image\//.test(file.type || '') && !IMAGE_EXT.test(file.name || '')) {
          status.textContent = 'Please choose an image file.';
          return;
        }
        status.textContent = 'Uploading ' + file.name + '…';
        try {
          pick({ path: await this._uploadImage(file) });
        } catch (err) {
          status.textContent = (err && err.message) || 'Upload failed';
        }
      };
      input.addEventListener('change', () => upload(input.files && input.files[0]));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('is-over');
        upload(e.dataTransfer.files && e.dataTransfer.files[0]);
      });

      // Workspace
      const grid = body.querySelector('.sl-img-grid');
      const filter = body.querySelector('[data-pane="workspace"] .sl-picker-search');
      let images = [];
      const drawGrid = () => {
        const q = filter.value.trim().toLowerCase();
        const shown = images.filter((p) => !q || p.toLowerCase().includes(q));
        if (!shown.length) {
          grid.innerHTML = '<div class="sl-picker-note">No images in the workspace yet. Use Upload or import some.</div>';
          return;
        }
        grid.innerHTML = shown.map((p) => `
          <button type="button" class="sl-img-card" data-path="${esc(p)}" title="${esc(p)}">
            <img alt="" loading="lazy" src="${esc(imageUrl({ path: p }))}"><span>${esc(p.split('/').pop())}</span>
          </button>`).join('');
        grid.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => pick({ path: b.getAttribute('data-path') })));
      };
      const loadWorkspace = async () => {
        try {
          const tree = await (await fetch('/api/tree', { cache: 'no-store' })).json();
          const walk = (nodes) => (nodes || []).forEach((n) => {
            if (n.type === 'dir') walk(n.children);
            else if (IMAGE_EXT.test(n.name || n.path)) images.push(n.path);
          });
          walk(tree.children);
          drawGrid();
        } catch (e) {
          grid.innerHTML = '<div class="sl-picker-note">Could not load files.</div>';
        }
      };
      filter.addEventListener('input', drawGrid);

      // URL
      const urlIn = body.querySelector('[data-url]');
      const useUrl = body.querySelector('[data-use-url]');
      const prev = body.querySelector('.sl-url-preview');
      urlIn.addEventListener('input', () => {
        const ok = /^https?:\/\/\S+$/i.test(urlIn.value.trim());
        useUrl.disabled = !ok;
        prev.innerHTML = ok ? `<img alt="" src="${esc(urlIn.value.trim())}">` : '';
      });
      useUrl.addEventListener('click', () => pick({ url: urlIn.value.trim() }));
    }

    // ---- background editor ----
    // `chosen` is a freshly picked image to edit before applying.
    _openBackgroundEditor(chosen) {
      const slide = this._slide();
      if (!slide) return;
      const before = JSON.stringify(slide.background || null);
      const draft = chosen || (slide.background ? Object.assign({}, slide.background) : null);
      const body = document.createElement('div');
      body.className = 'sl-bgedit';
      const foot = document.createElement('div');
      const draw = () => {
        body.innerHTML = `
          <div class="sl-bg-preview">${draft ? `<img alt="" src="${esc(imageUrl(draft))}" style="object-fit:${draft.fit === 'contain' ? 'contain' : 'cover'}"><div class="sl-bg-preview-dim" style="opacity:${draft.dim}"></div>` : '<span class="sl-picker-note">No background image</span>'}</div>
          <div class="sl-bg-controls">
            <button type="button" data-bg="choose">${draft ? 'Change image…' : 'Choose image…'}</button>
            ${draft ? `
              <label>Fit <select data-bg="fit"><option value="cover"${draft.fit !== 'contain' ? ' selected' : ''}>Fill slide</option><option value="contain"${draft.fit === 'contain' ? ' selected' : ''}>Fit whole image</option></select></label>
              <label>Dim <input type="range" min="0" max="90" step="5" value="${Math.round(draft.dim * 100)}" data-bg="dim"><span data-bg="dimv">${Math.round(draft.dim * 100)}%</span></label>
              <button type="button" data-bg="remove" class="sl-danger">Remove</button>` : ''}
          </div>
          <p class="sl-picker-note">Dim lays the theme's background colour over the image so slide text stays readable.</p>`;
        body.querySelector('[data-bg="choose"]').addEventListener('click', () => {
          this._openImageChooser('Background image', (img) => {
            this._openBackgroundEditor(Object.assign({ fit: 'cover', dim: draft ? draft.dim : 0.35 }, img));
          });
        });
        const fit = body.querySelector('[data-bg="fit"]');
        if (fit) fit.addEventListener('change', () => { draft.fit = fit.value; draw(); });
        const dim = body.querySelector('[data-bg="dim"]');
        if (dim) {
          dim.addEventListener('input', () => {
            draft.dim = Number(dim.value) / 100;
            body.querySelector('[data-bg="dimv"]').textContent = dim.value + '%';
            body.querySelector('.sl-bg-preview-dim').style.opacity = String(draft.dim);
          });
        }
        const rm = body.querySelector('[data-bg="remove"]');
        if (rm) rm.addEventListener('click', () => { this._applyBackground([slide], null); this._closeModal(); });
      };
      foot.innerHTML = `
        <span class="sl-spacer"></span>
        <button type="button" data-cancel>Cancel</button>
        <button type="button" data-all title="Use this background on every slide">Apply to all slides</button>
        <button type="button" data-apply class="sl-primary">Apply</button>`;
      foot.querySelector('[data-cancel]').addEventListener('click', () => this._closeModal());
      foot.querySelector('[data-apply]').addEventListener('click', () => {
        this._closeModal();
        if (JSON.stringify(draft) !== before) this._applyBackground([slide], draft);
      });
      if (!draft) foot.querySelector('[data-all]').textContent = 'Remove from all slides';
      foot.querySelector('[data-all]').addEventListener('click', () => {
        this._closeModal();
        this._applyBackground(this.data.slides, draft);
      });
      this._openModal('Slide background', body, foot);
      draw();
    }

    _applyBackground(slides, bg) {
      this._change(() => {
        slides.forEach((s) => { s.background = bg ? C.normalizeBackground(bg) : null; });
      });
    }

    // ---- live sources ----
    _loadSource(path) {
      if (!this._sources.has(path)) {
        const p = fetch('/api/file?path=' + encodeURIComponent(path), { cache: 'no-store' })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Missing: ' + path);
            const kind = kindOfHtml(data.content);
            if (!kind) throw new Error(path.split('/').pop() + ' is not a mindmap, flow or gantt');
            return { path, kind, content: data.content };
          });
        p.catch(() => { if (this._sources.get(path) === p) this._sources.delete(path); });
        this._sources.set(path, p);
      }
      return this._sources.get(path);
    }

    async _listFrames(path) {
      const src = await this._loadSource(path);
      if (src.kind === 'gantt') return C.GANTT_VIEWS.map((v) => ({ id: v.id, title: v.label }));
      let frames = [];
      if (src.kind === 'mindmap') {
        const m = src.content.match(/<script[^>]*id=["']mindmap-data["'][^>]*>([\s\S]*?)<\/script>/i);
        try { frames = (JSON.parse(m[1]).frames || []); } catch (e) { frames = []; }
      } else if (src.kind === 'flow') {
        await this._ensureKind('flow');
        const data = global.FlowCore.parseHtml(src.content);
        frames = (data && data.frames) || [];
      }
      const list = frames
        .filter((f) => f && f.id)
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
        .map((f) => ({ id: f.id, title: f.title || 'Frame' }));
      list.push({ id: WHOLE, title: src.kind === 'mindmap' ? 'Whole mindmap' : 'Whole flow' });
      return list;
    }

    async _ensureKind(kind) {
      const fn = this.ensure[kind];
      if (typeof fn === 'function') await fn();
      if (kind === 'mindmap') await loadScriptOnce(EXPORT_URLS.mindmap, () => !!(global.MindmapExport && global.MindmapExport.buildSvg));
      if (kind === 'flow') await loadScriptOnce(EXPORT_URLS.flow, () => !!(global.FlowExport && global.FlowExport.buildSvg));
    }

    // Render a whole frame (or whole board, or a gantt view) to SVG:
    // { svg, W, H }. `dark` picks dark colours where the source has them.
    _renderFrame(path, frameId, dark) {
      const isDark = dark == null ? this._isDark() : !!dark;
      const key = path + '|' + frameId + '|' + (isDark ? 'd' : 'l');
      if (!this._frames.has(key)) {
        const p = (async () => {
          const src = await this._loadSource(path);
          await this._ensureKind(src.kind);
          if (src.kind === 'mindmap') return this._renderMindmapFrame(src, frameId);
          if (src.kind === 'flow') return this._renderFlowFrame(src, frameId);
          return this._renderGanttView(src, frameId, isDark);
        })();
        p.catch(() => { if (this._frames.get(key) === p) this._frames.delete(key); });
        this._frames.set(key, p);
      }
      return this._frames.get(key);
    }

    async _renderMindmapFrame(src, frameId) {
      // The mindmap export needs a live engine (layout, link geometry), so
      // load the file into a hidden, read-only engine and destroy it after.
      const host = document.createElement('div');
      host.className = 'sl-offscreen';
      document.body.appendChild(host);
      const eng = new global.MindmapEngine(host, { readOnly: true });
      try {
        eng.loadFromHtml(src.content);
        let rect;
        if (frameId !== WHOLE) {
          const f = (eng.data.frames || []).find((x) => x.id === frameId);
          if (!f) throw new Error('Frame was removed from ' + src.path.split('/').pop());
          rect = eng._frameExportRect(f);
        } else {
          const b = eng.contentBounds();
          rect = { x: b.x - 20, y: b.y - 48, w: b.w + 40, h: b.h + 68 };
        }
        const scene = eng._exportScene();
        const images = await global.MindmapExport.inlineImages(scene);
        const svg = stripBackground(global.MindmapExport.buildSvg(scene, rect, eng.els, { images }));
        return { svg, W: rect.w, H: rect.h };
      } finally {
        eng.destroy();
        host.remove();
      }
    }

    async _renderFlowFrame(src, frameId) {
      const data = global.FlowCore.parseHtml(src.content);
      if (!data) throw new Error('Could not read ' + src.path);
      let rect;
      if (frameId !== WHOLE) {
        const f = (data.frames || []).find((x) => x.id === frameId);
        if (!f) throw new Error('Frame was removed from ' + src.path.split('/').pop());
        rect = frameRect(f);
      } else {
        rect = boundsOf(Object.values(data.shapes || {}).concat(data.frames || []), 48);
      }
      const images = await global.FlowExport.inlineImages(data);
      const svg = stripBackground(global.FlowExport.buildSvg(data, rect, { images }));
      return { svg, W: rect.w, H: rect.h };
    }

    // Gantt visuals capture the gantt editor's own Timeline / Sheet /
    // Analytics view (read-only, offscreen) as an SVG <foreignObject>, with
    // the gantt stylesheet inlined and switched to light or dark colours.
    async _renderGanttView(src, view, dark) {
      const mode = view === 'sheet' || view === 'analytics' ? view : 'chart';
      const css = await this._ganttCss();
      const host = document.createElement('div');
      host.className = 'sl-offscreen sl-offscreen-gantt';
      document.body.appendChild(host);
      const eng = new global.GanttEngine(host, { readOnly: true });
      try {
        eng.loadFromHtml(src.content);
        if (!eng.data.view) eng.data.view = {};
        eng.data.view.mode = mode;
        const root = eng.els.root;
        // Only the view itself: no toolbar or filter bar.
        root.querySelectorAll('.gt-top, .gt-filterbar').forEach((n) => { n.style.display = 'none'; });
        // Sheet's last column stretches to fill, so lay it out at a normal width.
        host.style.width = (mode === 'analytics' ? 1280 : mode === 'sheet' ? 1600 : 2400) + 'px';
        host.style.height = '1200px';
        eng.render();
        const e = eng.els;
        // Panes stretch to fill the host, so measure the content itself.
        const bottomOf = (parent) => [...parent.children].reduce((m, c) => Math.max(m, c.offsetTop + c.offsetHeight), 0);
        const rightOf = (parent) => [...parent.children].reduce((m, c) => Math.max(m, c.offsetLeft + c.offsetWidth), 0);
        let W;
        let H;
        if (mode === 'chart') {
          W = e.list.offsetWidth + (e.timeBody.offsetWidth || e.timeClip.scrollWidth);
          H = e.headClip.offsetHeight + bottomOf(e.listRows) + 8;
        } else if (mode === 'sheet') {
          W = rightOf(e.listHead) || e.listPane.scrollWidth;
          H = e.listHead.offsetHeight + bottomOf(e.listRows) + 8;
        } else {
          W = 1280;
          H = bottomOf(e.analytics) + 24;
        }
        // Grow the host to the full content so nothing scrolls, then redraw.
        W = Math.min(12000, Math.max(320, Math.ceil(W) + 2));
        H = Math.min(12000, Math.max(200, Math.ceil(H) + 2));
        host.style.width = W + 'px';
        host.style.height = H + 'px';
        eng.render();
        const clone = root.cloneNode(true);
        // Cloned form fields lose their live values; copy them into attributes
        // (before removing any parts, so live and cloned fields line up).
        const live = root.querySelectorAll('input, textarea, select');
        const copies = clone.querySelectorAll('input, textarea, select');
        live.forEach((field, i) => {
          const c = copies[i];
          if (!c) return;
          if (field.tagName === 'TEXTAREA') c.textContent = field.value;
          else if (field.tagName === 'SELECT') {
            [...c.options].forEach((o, j) => { if (field.options[j] && field.options[j].selected) o.setAttribute('selected', 'selected'); });
          } else {
            c.setAttribute('value', field.value);
            if (field.checked) c.setAttribute('checked', 'checked');
          }
        });
        clone.querySelectorAll('.gt-top, .gt-filterbar, .gt-scrim, .gt-drawer, .gt-menu, .gt-toast, .gt-help').forEach((n) => n.remove());
        const wrap = document.createElement('div');
        wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        wrap.className = 'gt-snap ' + (dark ? 'gt-snap-dark' : 'gt-snap-light');
        wrap.setAttribute('style', `position:relative;width:${W}px;height:${H}px;overflow:hidden`);
        const style = document.createElement('style');
        style.textContent = css;
        wrap.appendChild(style);
        wrap.appendChild(clone);
        const xhtml = new XMLSerializer().serializeToString(wrap);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`;
        return { svg, W, H };
      } finally {
        eng.destroy();
        host.remove();
      }
    }

    // Gantt stylesheet with its dark-mode rules keyed to the snapshot wrapper
    // instead of the page, so a capture can be dark while the app is light.
    _ganttCss() {
      if (!SlidesEngine._ganttCssP) {
        SlidesEngine._ganttCssP = fetch('/gantt/engine.css', { cache: 'no-store' })
          .then((r) => (r.ok ? r.text() : ''))
          .then((css) => css
            .replace(/html\[data-theme="dark"\]/g, '.gt-snap-dark')
            .replace(/html\[data-theme="light"\]/g, '.gt-snap-light')
            // A still image has nothing to scroll.
            + '\n.gt-snap *{scrollbar-width:none!important}.gt-snap ::-webkit-scrollbar{display:none}')
          .catch(() => '');
      }
      return SlidesEngine._ganttCssP;
    }

    async _renderVisual(v) {
      const fr = await this._renderFrame(v.source.path, v.source.frameId);
      return svgDataUrl(cropSvg(fr.svg, fr.W, fr.H, v.window));
    }

    // ---- picker: file -> frame -> window ----
    // Each opened dialog gets a token; async work started by a dialog checks
    // it so a late result can't land after Cancel or in a newer dialog.
    _openModal(title, bodyEl, footEl) {
      this._modalToken = (this._modalToken || 0) + 1;
      this.els.modalTitle.textContent = title;
      this.els.modalBody.innerHTML = '';
      this.els.modalFoot.innerHTML = '';
      if (bodyEl) this.els.modalBody.appendChild(bodyEl);
      if (footEl) this.els.modalFoot.appendChild(footEl);
      this.els.modal.classList.remove('hidden');
    }

    _closeModal() {
      this.els.modal.classList.add('hidden');
      this.els.modalBody.innerHTML = '';
      this.els.modalFoot.innerHTML = '';
      this._winEdit = null;
    }

    async _openPicker(slide, i) {
      const body = document.createElement('div');
      body.className = 'sl-picker';
      body.innerHTML = '<input type="search" class="sl-picker-search" placeholder="Filter files…" /><div class="sl-picker-list"><div class="sl-picker-note">Loading files…</div></div>';
      this._openModal('Choose a mindmap, flow or gantt', body);
      const list = body.querySelector('.sl-picker-list');
      const search = body.querySelector('.sl-picker-search');
      let files = [];
      try {
        const res = await fetch('/api/tree', { cache: 'no-store' });
        const tree = await res.json();
        const walk = (nodes) => (nodes || []).forEach((n) => {
          if (n.type === 'dir') walk(n.children);
          else if (SOURCE_KINDS[n.kind]) files.push(n);
        });
        walk(tree.children);
      } catch (e) {
        list.innerHTML = '<div class="sl-picker-note">Could not load files.</div>';
        return;
      }
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q));
        if (!shown.length) {
          list.innerHTML = '<div class="sl-picker-note">No mindmaps, flows or gantt charts found.</div>';
          return;
        }
        list.innerHTML = shown.map((f) => `
          <button type="button" class="sl-picker-item" data-path="${esc(f.path)}">
            <span class="sl-kind sl-kind-${f.kind}">${SOURCE_KINDS[f.kind]}</span>
            <span class="sl-picker-path">${esc(f.path)}</span>
          </button>`).join('');
        list.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => {
          this._openFramePicker(slide, i, b.getAttribute('data-path'));
        }));
      };
      search.addEventListener('input', draw);
      draw();
      search.focus();
    }

    async _openFramePicker(slide, i, path) {
      const body = document.createElement('div');
      body.className = 'sl-frames';
      body.innerHTML = '<div class="sl-picker-note">Loading frames…</div>';
      const foot = document.createElement('div');
      foot.innerHTML = '<button type="button" data-back>← Back</button>';
      foot.querySelector('[data-back]').addEventListener('click', () => this._openPicker(slide, i));
      this._openModal('Choose a frame in ' + path.split('/').pop(), body, foot);
      let frames;
      try {
        frames = await this._listFrames(path);
      } catch (err) {
        body.innerHTML = `<div class="sl-picker-note">${esc((err && err.message) || 'Could not open file')}</div>`;
        return;
      }
      // Gantt has no frames: go straight to the window.
      if (frames.length === 1) {
        this._openWindowEditor(slide, i, { path, frameId: frames[0].id }, true);
        return;
      }
      body.innerHTML = frames.map((f) => `
        <button type="button" class="sl-frame-card" data-frame="${esc(f.id)}">
          <span class="sl-frame-thumb"><span class="sl-spinner"></span></span>
          <span class="sl-frame-title">${esc(f.title)}</span>
        </button>`).join('');
      body.querySelectorAll('[data-frame]').forEach((b) => {
        const id = b.getAttribute('data-frame');
        b.addEventListener('click', () => this._openWindowEditor(slide, i, { path, frameId: id }, true));
        this._renderFrame(path, id).then((fr) => {
          b.querySelector('.sl-frame-thumb').innerHTML = `<img alt="" src="${svgDataUrl(fr.svg)}">`;
        }).catch(() => {
          b.querySelector('.sl-frame-thumb').textContent = '—';
        });
      });
    }

    // Window editor: the whole frame with a draggable, resizable box. Only
    // the area inside the box is shown on the slide and in present mode.
    async _openWindowEditor(slide, i, source, fromPicker) {
      const current = slide.visuals[i];
      const sameSource = current && current.source && current.source.path === source.path
        && current.source.frameId === source.frameId;
      const win = sameSource ? Object.assign({}, current.window) : C.fullWindow();
      const body = document.createElement('div');
      body.className = 'sl-win';
      body.innerHTML = `
        <div class="sl-win-help">Drag the box to move it, drag its corners or edges to resize. Only the area inside the box appears on the slide.</div>
        <div class="sl-win-stage"><div class="sl-win-canvas"><img class="sl-win-img" alt=""><div class="sl-win-shade"></div>
          <div class="sl-win-box">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="sl-win-h" data-h="${h}"></span>`).join('')}</div>
        </div><div class="sl-picker-note sl-win-loading">Rendering…</div></div>`;
      const foot = document.createElement('div');
      foot.innerHTML = `
        ${fromPicker ? '<button type="button" data-back>← Back</button>' : ''}
        <button type="button" data-fit-slot title="Match the box shape to the slide area">Fit slide shape</button>
        <button type="button" data-whole>Whole frame</button>
        <span class="sl-spacer"></span>
        <button type="button" data-cancel>Cancel</button>
        <button type="button" data-done class="sl-primary">Use this window</button>`;
      this._openModal('Window on ' + source.path.split('/').pop(), body, foot);
      const canvas = body.querySelector('.sl-win-canvas');
      const img = body.querySelector('.sl-win-img');
      const box = body.querySelector('.sl-win-box');
      const shade = body.querySelector('.sl-win-shade');
      let fr;
      const token = this._modalToken;
      try {
        fr = await this._renderFrame(source.path, source.frameId);
      } catch (err) {
        if (token === this._modalToken) body.querySelector('.sl-win-loading').textContent = (err && err.message) || 'Could not render';
        return;
      }
      if (token !== this._modalToken) return; // this dialog was closed or replaced
      body.querySelector('.sl-win-loading').remove();
      img.src = svgDataUrl(fr.svg);
      const stage = body.querySelector('.sl-win-stage');
      const fit = () => {
        const sw = stage.clientWidth || 900;
        const sh = stage.clientHeight || 520;
        const k = Math.min(sw / fr.W, sh / fr.H);
        canvas.style.width = fr.W * k + 'px';
        canvas.style.height = fr.H * k + 'px';
        paint();
      };
      const paint = () => {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        Object.assign(box.style, {
          left: win.x * cw + 'px', top: win.y * ch + 'px', width: win.w * cw + 'px', height: win.h * ch + 'px',
        });
        // Dim everything outside the window.
        shade.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${win.x * 100}% ${win.y * 100}%, ${win.x * 100}% ${(win.y + win.h) * 100}%, ${(win.x + win.w) * 100}% ${(win.y + win.h) * 100}%, ${(win.x + win.w) * 100}% ${win.y * 100}%, ${win.x * 100}% ${win.y * 100}%)`;
      };
      this._winEdit = { fit };
      requestAnimationFrame(fit);
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const h = e.target.closest('[data-h]');
        drag = { h: h ? h.getAttribute('data-h') : 'move', x0: e.clientX, y0: e.clientY, start: Object.assign({}, win) };
        box.setPointerCapture(e.pointerId);
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.x0) / canvas.clientWidth;
        const dy = (e.clientY - drag.y0) / canvas.clientHeight;
        const s = drag.start;
        const min = C.MIN_WIN;
        let { x, y, w, h } = s;
        if (drag.h === 'move') {
          x = Math.min(1 - w, Math.max(0, s.x + dx));
          y = Math.min(1 - h, Math.max(0, s.y + dy));
        } else {
          if (drag.h.includes('w')) { x = Math.min(s.x + s.w - min, Math.max(0, s.x + dx)); w = s.x + s.w - x; }
          if (drag.h.includes('e')) w = Math.min(1 - s.x, Math.max(min, s.w + dx));
          if (drag.h.includes('n')) { y = Math.min(s.y + s.h - min, Math.max(0, s.y + dy)); h = s.y + s.h - y; }
          if (drag.h.includes('s')) h = Math.min(1 - s.y, Math.max(min, s.h + dy));
        }
        Object.assign(win, { x, y, w, h });
        paint();
      });
      const end = (e) => {
        if (!drag) return;
        drag = null;
        try { box.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
      const back = foot.querySelector('[data-back]');
      if (back) back.addEventListener('click', () => this._openFramePicker(slide, i, source.path));
      foot.querySelector('[data-whole]').addEventListener('click', () => { Object.assign(win, C.fullWindow()); paint(); });
      foot.querySelector('[data-fit-slot]').addEventListener('click', () => {
        // Reshape the box (around its centre) to the slot's aspect ratio so
        // the window fills the slide area without empty bars.
        const slot = this._stageSlide && this._stageSlide.querySelector(`.sl-visual[data-vi="${i}"]`);
        const aspect = slot && slot.offsetHeight ? slot.offsetWidth / slot.offsetHeight : 16 / 9;
        const cx = win.x + win.w / 2;
        const cy = win.y + win.h / 2;
        let w = win.w;
        let h = (w * fr.W) / aspect / fr.H;
        if (h > 1) { h = 1; w = (h * fr.H * aspect) / fr.W; }
        Object.assign(win, C.clampWindow({ x: cx - w / 2, y: cy - h / 2, w, h }));
        paint();
      });
      foot.querySelector('[data-cancel]').addEventListener('click', () => this._closeModal());
      foot.querySelector('[data-done]').addEventListener('click', () => {
        this._closeModal();
        this._change(() => {
          slide.visuals[i] = { source: { path: source.path, frameId: source.frameId }, window: C.clampWindow(win) };
        });
      });
    }

    // ---- present mode ----
    present(startAt) {
      if (this._present) return;
      this.flushEdit();
      // Live link: re-read sources so the deck shows the latest diagrams.
      this._sources.clear();
      this._frames.clear();
      const ov = document.createElement('div');
      ov.className = 'sl-present';
      ov.tabIndex = -1;
      ov.innerHTML = '<div class="sl-present-host"></div><div class="sl-present-count"></div>';
      document.body.appendChild(ov);
      this._present = { ov, index: startAt == null ? this.current : startAt };
      ov.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        this._presentGo(e.clientX < window.innerWidth / 4 ? -1 : 1);
      });
      this._onFs = () => {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) this._exitPresent();
      };
      document.addEventListener('fullscreenchange', this._onFs);
      document.addEventListener('webkitfullscreenchange', this._onFs);
      this._onPresentResize = () => this._presentFit();
      window.addEventListener('resize', this._onPresentResize);
      const req = ov.requestFullscreen || ov.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(ov);
          if (p && p.catch) p.catch(() => { /* stays as a full-window overlay */ });
        } catch (e) { /* stays as a full-window overlay */ }
      }
      ov.focus();
      this._presentShow();
    }

    _presentShow() {
      const p = this._present;
      if (!p) return;
      const host = p.ov.querySelector('.sl-present-host');
      host.innerHTML = '';
      const el = this._slideEl(this.data.slides[p.index], { editable: false, present: true });
      host.appendChild(el);
      p.el = el;
      p.ov.querySelector('.sl-present-count').textContent = `${p.index + 1} / ${this.data.slides.length}`;
      // Letterbox in the theme's background colour.
      p.ov.className = 'sl-present sl-theme-' + this._themeId();
      this._presentFit();
    }

    _presentFit() {
      const p = this._present;
      if (!p || !p.el) return;
      const k = Math.min(window.innerWidth / SLIDE_W, window.innerHeight / SLIDE_H);
      const host = p.ov.querySelector('.sl-present-host');
      host.style.width = SLIDE_W * k + 'px';
      host.style.height = SLIDE_H * k + 'px';
      p.el.style.transform = `scale(${k})`;
    }

    _presentGo(delta) {
      const p = this._present;
      if (!p) return;
      const next = p.index + delta;
      if (next < 0 || next >= this.data.slides.length) return;
      p.index = next;
      this._presentShow();
    }

    _exitPresent() {
      const p = this._present;
      if (!p) return;
      this._present = null;
      document.removeEventListener('fullscreenchange', this._onFs);
      document.removeEventListener('webkitfullscreenchange', this._onFs);
      window.removeEventListener('resize', this._onPresentResize);
      if (document.fullscreenElement === p.ov || document.webkitFullscreenElement === p.ov) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) { try { exit.call(document); } catch (e) { /* ignore */ } }
      }
      p.ov.remove();
      if (!this._destroyed) {
        this.current = p.index;
        this.render();
      }
    }

    // ---- keyboard ----
    _onKey(e) {
      if (this._present) {
        const k = e.key;
        if (k === 'Escape') { e.preventDefault(); this._exitPresent(); return; }
        if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) { e.preventDefault(); this._presentGo(1); return; }
        if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); this._presentGo(-1); return; }
        if (k === 'Home') { e.preventDefault(); this._present.index = 0; this._presentShow(); return; }
        if (k === 'End') { e.preventDefault(); this._present.index = this.data.slides.length - 1; this._presentShow(); }
        return;
      }
      if (this._destroyed || !this.container.offsetParent) return;
      if (!this.els.modal.classList.contains('hidden')) {
        if (e.key === 'Escape') this._closeModal();
        return;
      }
      const t = e.target;
      const tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      // Only when focus is on the page itself or inside the slides editor.
      if (t && t !== document.body && t !== document.documentElement && !this.container.contains(t)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === 'F5' || (meta && e.key === 'Enter')) { e.preventDefault(); this.present(); return; }
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (this.current < this.data.slides.length - 1) { e.preventDefault(); this.current += 1; this.render(); }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (this.current > 0) { e.preventDefault(); this.current -= 1; this.render(); }
      }
    }

    // Replace workspace/web image references with data URLs so an exported
    // file needs nothing from the app.
    async _inlineMedia(el) {
      for (const img of el.querySelectorAll('img.sl-visual-img')) {
        const src = img.getAttribute('src') || '';
        if (!src || /^data:/i.test(src)) continue;
        try { img.setAttribute('src', await urlToDataUrl(src)); } catch (e) { /* keep the link */ }
      }
      const bg = el.querySelector('.sl-bg');
      if (bg) {
        const m = /url\("?([^")]+)"?\)/.exec(bg.style.backgroundImage || '');
        if (m && !/^data:/i.test(m[1])) {
          try { bg.style.backgroundImage = `url("${await urlToDataUrl(m[1].replace(/%22/g, '"'))}")`; } catch (e) { /* keep */ }
        }
      }
    }

    // ---- PowerPoint export (.pptx) ----
    async _exportPptxFromToolbar(btn) {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Building…';
      try {
        await this.exportPptx();
      } catch (err) {
        alert('PowerPoint export failed: ' + ((err && err.message) || err));
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    // Each slide is laid out offscreen at its real 1280x720 size and every
    // element is placed in the .pptx at the same position (96 px = 1 in).
    // Text stays editable text; frame windows and gantt views become
    // pictures; backgrounds are pre-cropped and dimmed.
    async exportPptx(filename) {
      await loadScriptOnce(PPTX_URL, () => typeof global.PptxGenJS === 'function', ['PptxGenJS']);
      this.flushEdit();
      const pptx = new global.PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      const deckTitle = (this.data.slides[0] && this.data.slides[0].title) || this.data.title || 'Slides';
      pptx.title = deckTitle;
      const host = document.createElement('div');
      host.className = 'sl-offscreen sl-offscreen-pptx';
      document.body.appendChild(host);
      const inch = (px) => px / PX_PER_IN;
      try {
        for (const slide of this.data.slides) {
          host.innerHTML = '';
          const el = this._slideEl(slide, { editable: false, present: true });
          el.style.transform = 'none';
          host.appendChild(el);
          const base = el.getBoundingClientRect();
          const box = (n) => {
            const r = n.getBoundingClientRect();
            return { x: inch(r.left - base.left), y: inch(r.top - base.top), w: inch(r.width), h: inch(r.height), pw: r.width, ph: r.height };
          };
          const cs = getComputedStyle(el);
          const bgHex = cssColorToHex(cs.backgroundColor);
          const ps = pptx.addSlide();
          ps.background = { color: bgHex };
          if (slide.background) {
            try {
              ps.background = {
                data: await rasterize(imageUrl(slide.background), 1280, 720, slide.background.fit, { dim: slide.background.dim, color: cs.backgroundColor }),
              };
            } catch (e) { /* keep the colour */ }
          }
          const band = el.querySelector('.sl-section-band');
          if (band) {
            const b = box(band);
            ps.addShape(pptx.ShapeType.rect, { x: b.x, y: b.y, w: b.w, h: b.h, fill: { color: cssColorToHex(getComputedStyle(band).backgroundColor) }, line: { type: 'none' } });
          }
          for (const f of el.querySelectorAll('[data-field]')) {
            const name = f.getAttribute('data-field');
            const text = String(slide[name] || '').trim();
            if (!text) continue;
            const b = box(f);
            const fcs = getComputedStyle(f);
            const opts = {
              x: b.x, y: b.y, w: b.w, h: Math.max(b.h, inch(parseFloat(fcs.fontSize) * 1.4)),
              fontFace: 'Calibri',
              fontSize: Math.round(parseFloat(fcs.fontSize) * 0.75),
              color: cssColorToHex(fcs.color),
              bold: Number(fcs.fontWeight) >= 600,
              valign: 'top',
              margin: 0,
              fit: 'shrink',
            };
            if (f.classList.contains('sl-bullets')) {
              const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
              ps.addText(lines.map((l) => ({ text: l, options: { bullet: true, breakLine: true } })), Object.assign(opts, { paraSpaceAfter: 6 }));
            } else {
              ps.addText(text, opts);
            }
          }
          for (const slot of el.querySelectorAll('.sl-visual')) {
            const v = slide.visuals[Number(slot.getAttribute('data-vi'))];
            if (!v || (!v.source && !v.image)) continue;
            const b = box(slot);
            try {
              let src;
              let fit = 'contain';
              if (v.image) {
                src = imageUrl(v.image);
                fit = v.image.fit;
              } else {
                src = await this._renderVisual(v);
              }
              ps.addImage({ data: await rasterize(src, b.pw, b.ph, fit), x: b.x, y: b.y, w: b.w, h: b.h });
            } catch (err) {
              ps.addText('[' + ((err && err.message) || 'Visual could not be exported') + ']', {
                x: b.x, y: b.y, w: b.w, h: b.h, align: 'center', valign: 'middle', fontSize: 14, color: '888888',
              });
            }
          }
        }
      } finally {
        host.remove();
      }
      const name = filename || (String(deckTitle).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'slides') + '.pptx';
      await pptx.writeFile({ fileName: name });
    }

    // ---- standalone export: a self-contained deck with rendered visuals ----
    // Every slide as static HTML (visuals and images embedded as data URLs)
    // plus the slides stylesheet. Used by standalone and folder exports.
    async buildStaticSlides() {
      this._sources.clear();
      this._frames.clear();
      const slidesHtml = [];
      for (const slide of this.data.slides) {
        const el = this._slideEl(slide, { editable: false, present: true });
        const slots = [...el.querySelectorAll('.sl-visual')];
        for (const slot of slots) {
          const v = slide.visuals[Number(slot.getAttribute('data-vi'))];
          slot.innerHTML = '';
          if (!v || (!v.source && !v.image)) continue;
          try {
            // Image visuals keep their fit; _inlineMedia embeds them below.
            const url = v.image ? imageUrl(v.image) : await this._renderVisual(v);
            const fit = v.image && v.image.fit === 'cover' ? ' style="object-fit:cover"' : '';
            slot.innerHTML = `<img class="sl-visual-img" alt=""${fit} src="${esc(url)}">`;
          } catch (err) {
            slot.innerHTML = `<span class="sl-empty-label">${esc((err && err.message) || 'Could not render')}</span>`;
          }
          slot.classList.remove('is-loading');
        }
        await this._inlineMedia(el);
        slidesHtml.push(el.outerHTML);
      }
      let css = '';
      try { css = await (await fetch('/slides/engine.css', { cache: 'no-store' })).text(); } catch (e) { css = ''; }
      return { slidesHtml, css };
    }

    // opts.returnHtml: give back the page instead of downloading it.
    async exportStandalone(filename, opts) {
      const { slidesHtml, css } = await this.buildStaticSlides();
      const title = (this.data.slides[0] && this.data.slides[0].title) || this.data.title || 'Slides';
      // Keep the data block so the file can be imported back as slides.
      const json = JSON.stringify(this.data, null, 2).replace(/</g, '\\u003c');
      const html = `<!DOCTYPE html>
<html lang="en" data-docviewer="slides" data-accretion="standalone">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${css}
html,body{margin:0;height:100%;background:#0b0e14}
.sl-deck .sl-present-host{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);overflow:hidden}
.sl-deck .sl-slide{position:absolute;left:0;top:0;transform-origin:0 0}
</style></head>
<body>
<script type="application/json" id="slides-data">
${json}
</script>
<div class="sl-present sl-deck sl-theme-${this._themeId()}"><div class="sl-present-host"></div><div class="sl-present-count"></div></div>
<template id="sl-slides">${slidesHtml.join('\n')}</template>
<script>
(function(){
  var slides=[].slice.call(document.getElementById('sl-slides').content.children);
  var host=document.querySelector('.sl-present-host'), count=document.querySelector('.sl-present-count'), i=0;
  function fit(){var k=Math.min(innerWidth/${SLIDE_W},innerHeight/${SLIDE_H});host.style.width=${SLIDE_W}*k+'px';host.style.height=${SLIDE_H}*k+'px';var el=host.firstChild;if(el)el.style.transform='scale('+k+')';}
  function show(){host.innerHTML='';host.appendChild(slides[i].cloneNode(true));count.textContent=(i+1)+' / '+slides.length;fit();}
  function go(d){var n=i+d;if(n<0||n>=slides.length)return;i=n;show();}
  addEventListener('resize',fit);
  addEventListener('keydown',function(e){var k=e.key;
    if(['ArrowRight','ArrowDown','PageDown',' ','Enter'].indexOf(k)>=0){e.preventDefault();go(1);}
    else if(['ArrowLeft','ArrowUp','PageUp','Backspace'].indexOf(k)>=0){e.preventDefault();go(-1);}
    else if(k==='Home'){i=0;show();} else if(k==='End'){i=slides.length-1;show();}
    else if(k==='f'||k==='F'){var d=document.documentElement;(d.requestFullscreen||d.webkitRequestFullscreen||function(){}).call(d);}});
  document.querySelector('.sl-present').addEventListener('click',function(e){go(e.clientX<innerWidth/4?-1:1);});
  show();
})();
</script>
</body>
</html>
`;
      const name = filename || (String(title).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'slides') + '-standalone.html';
      if (opts && opts.returnHtml) return html;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  }

  // Frame/gantt-view rendering without an editor UI (used by markdown files
  // to embed live board images). Shares the engine's rendering code but has
  // no DOM, listeners or deck. Theme 'auto' follows the app's light/dark.
  SlidesEngine.createRenderer = function createRenderer(ensureAssets) {
    const r = Object.create(SlidesEngine.prototype);
    r.ensure = ensureAssets || {};
    r.opts = {};
    r.data = { theme: 'auto' };
    r._sources = new Map();
    r._frames = new Map();
    return {
      // frameId: a mindmap/flow frame id, '__all__', or a gantt view id.
      async renderImage(path, frameId, dark) {
        const fr = await r._renderFrame(path, frameId, dark);
        return svgDataUrl(fr.svg);
      },
      clear() {
        r._sources.clear();
        r._frames.clear();
      },
    };
  };

  global.SlidesEngine = SlidesEngine;
})(typeof window !== 'undefined' ? window : this);
