/* DocViewer flow engine — flowchart canvas with frames, layers, and media. */
(function (global) {
  const C = global.FlowCore;
  if (!C) {
    console.error('FlowCore is missing');
    return;
  }

  const FILL_PALETTE = ['#ffffff', '#D7E3FC', '#D8F3DC', '#FFF3C4', '#FFD6E0', '#E4D5F5', '#CFF1F5', '#FFE0C2', '#90CAF9', '#A5D6A7'];
  const LINE_PALETTE = ['#5B7EAE', '#1565c0', '#2e7d32', '#c62828', '#6a1b9a', '#e65100', '#37474f', '#1a2130'];
  const FLOW_SHAPES = C.SHAPE_TYPES.filter((t) => t !== 'image' && t !== 'sticky' && t !== 'textbox');
  const IMG_W = 280;
  const FRAME_Z = 1;
  const CELL_Z = 10;
  const CLIP_PREFIX = 'DOCVIEWER_FLOW:';
  const LOCK_HOLD_MS = 560;

  function iconPath(type) {
    return C.shapePath(type, 22, 16);
  }

  function fileToImageSrc(file) {
    return new Promise((resolve, reject) => {
      const isSvg = (file && (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')));
      if (isSvg) {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read SVG'));
        reader.readAsDataURL(file);
        return;
      }
      if (!file || !String(file.type || '').startsWith('image/')) {
        reject(new Error('Not an image'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const png = /png|webp|gif/i.test(file.type);
        resolve(png ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image'));
      };
      img.src = url;
    });
  }

  class FlowEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = this.opts.onChange || function () {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this.selected = new Set();
      this.selectedLink = null;
      this.selectedFrameId = null;
      this.tool = 'select';
      this._undo = [];
      this._redo = [];
      this._drag = null;
      this._lockHold = null;
      this._spaceDown = false;
      this._linkPreview = null;
      this._edit = null;
      this._imageAt = null;
      this._clip = null;
      this._pointers = new Map();
      this._pinch = null;
      this._gestureActive = false;
      this._gestureZoom = 1;
      this._pinchWheelUntil = 0;
      this._zoomPend = null;
      this._zoomRaf = 0;
      this._buildDom();
      this._bind();
      this.render();
      this._applyTransform();
    }

    static isFlowHtml(html) { return C.isFlowHtml(html); }
    static parseHtml(html) { return C.parseHtml(html); }
    static serializeToHtml(data) { return C.serializeToHtml(data); }

    destroy() {
      this._clearLockHold();
      this._unbind();
      this.container.innerHTML = '';
      this.container.classList.remove('fl-host');
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      this.els.root.classList.toggle('is-readonly', this.readOnly);
      this._syncToolbar();
    }

    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.createEmpty();
      this.selected.clear();
      this.selectedLink = null;
      this.selectedFrameId = null;
      this._undo = [];
      this._redo = [];
      this.render();
      this._applyTransform();
    }

    serializeToHtml() { return C.serializeToHtml(this.data); }

    async exportStandalone(filename) {
      const shapes = this.data.shapes || {};
      const first = Object.keys(shapes).map((id) => shapes[id]).find((s) => s && String(s.text || '').trim());
      const title = (first && first.text ? String(first.text).trim() : 'Flow').slice(0, 80);
      const json = JSON.stringify(C.normalize(this.data), null, 2).replace(/</g, '\\u003c');
      const html = await buildStandaloneHtml({
        kind: 'flow',
        title,
        dataId: 'flow-data',
        json,
        cssUrls: ['/flow/engine.css'],
        jsUrls: ['/flow/core.js', '/flow/engine.js', '/flow/export.js'],
      });
      downloadStandalone(html, filename || safeStandaloneName(title, 'flow'));
    }
    collapseAll() { this.setZoom(0.4); }
    expandAll() { this.fitView(); }

    fitView(emit) {
      const b = C.contentBounds(this.data);
      const pad = 120;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const zoom = C.clamp(Math.min(vw / Math.max(b.w + pad * 2, 400), vh / Math.max(b.h + pad * 2, 280)), 0.12, 1.2);
      this.data.viewport.zoom = zoom;
      this.data.viewport.x = vw / 2 - (b.x + b.w / 2) * zoom;
      this.data.viewport.y = vh / 2 - (b.y + b.h / 2) * zoom;
      this._applyTransform();
      if (emit !== false) this._emit();
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
        const f = (this.data.frames || []).find((x) => x.id === this.selectedFrameId) || (this.data.frames || [])[0];
        if (!f) {
          alert('Draw or select a frame first.');
          return;
        }
        rect = this._frameExportRect(f);
      } else {
        rect = Object.assign(C.contentBounds(this.data), { name: 'flow' });
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

    _frameExportRect(f) {
      return {
        x: f.x - 16,
        y: f.y - 48,
        w: f.w + 32,
        h: f.h + 64,
        name: (f.title || 'frame').replace(/\s+/g, '-'),
      };
    }

    async _exportOneFrame(id, format) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) {
        alert('Select a frame first.');
        return;
      }
      try {
        await this._doExport(format, this._frameExportRect(f));
      } catch (err) {
        alert('Export failed: ' + (err.message || err));
      }
    }

    async _doExport(format, rect) {
      if (!global.FlowExport) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/flow/export.js?v=13';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Export module failed to load'));
          document.body.appendChild(s);
        });
      }
      if (!global.FlowExport) throw new Error('Export module failed to load');
      return global.FlowExport.run(format, rect, this.data);
    }

    _buildDom() {
      this.container.innerHTML = '';
      this.container.classList.add('fl-host');
      const root = document.createElement('div');
      root.className = 'fl-root';
      root.setAttribute('data-tool', 'select');
      const shapeBtns = FLOW_SHAPES.map((type) => {
        const meta = C.SHAPE_META[type];
        return `<button type="button" class="fl-shape-btn" data-tool="shape-${type}" title="${meta.label}">
          <svg viewBox="0 0 22 16"><path d="${iconPath(type)}" fill="#5b6576" stroke="#9aa3b2" stroke-width="1"/></svg>
        </button>`;
      }).join('');
      root.innerHTML = `
        <div class="fl-toolbar">
          <button type="button" data-tool="select" title="Select (V)">Select</button>
          <button type="button" data-tool="connect" title="Connect (C)">Connect</button>
          <button type="button" data-tool="frame" title="Draw a frame">Frame</button>
          <button type="button" data-tool="image" title="Place image or SVG">Image</button>
          <button type="button" data-tool="shape-sticky" title="Sticky note">Sticky</button>
          <button type="button" data-tool="shape-textbox" title="Text box (T)">Text</button>
          <div class="fl-palette">
            <button type="button" data-act="shapes" title="Flow shapes">Shapes</button>
            <div class="fl-palette-menu">${shapeBtns}</div>
          </div>
          <div class="fl-palette">
            <button type="button" data-act="templates" title="Insert a starter diagram">Templates</button>
            <div class="fl-templates-menu">${(C.TEMPLATE_LIST || []).map((t) => `<button type="button" data-template="${t.id}">${t.label}</button>`).join('')}</div>
          </div>
          <div class="fl-palette">
            <button type="button" data-act="icons" title="Add a common icon">Icons</button>
            <div class="fl-icons-menu">${(C.ICON_LIST || []).map((ic) => `<button type="button" data-icon="${ic.id}" title="${ic.label}"><img alt="" src="${C.iconSrc(ic.id)}"/><span>${ic.label}</span></button>`).join('')}</div>
          </div>
          <span class="fl-sep"></span>
          <button type="button" data-act="undo" title="Undo (Ctrl+Z)" disabled>Undo</button>
          <button type="button" data-act="redo" title="Redo" disabled>Redo</button>
          <button type="button" data-act="delete" title="Delete">Delete</button>
          <span class="fl-sep"></span>
          <button type="button" data-z="front" title="Bring cell to front">Front</button>
          <button type="button" data-z="forward" title="Bring cell forward">Forward</button>
          <button type="button" data-z="backward" title="Send cell backward">Back</button>
          <button type="button" data-z="back" title="Send cell to back">Bottom</button>
          <span class="fl-sep"></span>
          <button type="button" data-act="export">Export</button>
          <span class="fl-sep"></span>
          <button type="button" data-act="zoom-out">−</button>
          <span class="fl-zoom-label">85%</span>
          <button type="button" data-act="zoom-in">+</button>
          <button type="button" data-act="fit">Fit</button>
          <button type="button" data-act="fullscreen" title="Fullscreen">Fullscreen</button>
          <div class="fl-export-menu">
            <button type="button" data-export="standalone">Standalone HTML</button>
            <button type="button" data-export="png">Canvas PNG</button>
            <button type="button" data-export="svg">Canvas SVG</button>
            <button type="button" data-export="pdf">Canvas PDF</button>
            <button type="button" data-export="frame-png">Frame PNG</button>
            <button type="button" data-export="frame-svg">Frame SVG</button>
            <button type="button" data-export="frame-pdf">Frame PDF</button>
          </div>
        </div>
        <div class="fl-frames-dock" hidden>
          <button type="button" data-act="frames" title="Jump to a frame">Frames</button>
          <div class="fl-frames-menu">
            <input class="dv-fcat-search" type="search" placeholder="Search frames" autocomplete="off" spellcheck="false" />
            <div class="dv-fcat-list"></div>
          </div>
        </div>
        <div class="fl-inspector"></div>
        <div class="fl-canvas">
          <div class="fl-world"><div class="fl-links-host"></div></div>
          <div class="fl-marquee"></div>
          <div class="fl-lock-hold" aria-hidden="true">
            <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18"></circle></svg>
          </div>
        </div>
        <div class="fl-hint">Frame to group · Text boxes (T) · Sticky notes · Notes on cells · Connect via blue ports · Export from the top menu</div>
        <div class="fl-menu"></div>
        <input class="fl-file" type="file" accept="image/*,.svg,image/svg+xml" />
      `;
      this.container.appendChild(root);
      this.els = {
        root,
        toolbar: root.querySelector('.fl-toolbar'),
        inspector: root.querySelector('.fl-inspector'),
        canvas: root.querySelector('.fl-canvas'),
        world: root.querySelector('.fl-world'),
        linksHost: root.querySelector('.fl-links-host'),
        marquee: root.querySelector('.fl-marquee'),
        lockHold: root.querySelector('.fl-lock-hold'),
        zoomLabel: root.querySelector('.fl-zoom-label'),
        hint: root.querySelector('.fl-hint'),
        palette: root.querySelector('.fl-palette-menu'),
        templates: root.querySelector('.fl-templates-menu'),
        icons: root.querySelector('.fl-icons-menu'),
        framesDock: root.querySelector('.fl-frames-dock'),
        framesBtn: root.querySelector('[data-act="frames"]'),
        bookmarks: root.querySelector('.fl-frames-menu'),
        frameList: root.querySelector('.dv-fcat-list'),
        frameSearch: root.querySelector('.dv-fcat-search'),
        menu: root.querySelector('.fl-menu'),
        file: root.querySelector('.fl-file'),
        exportMenu: root.querySelector('.fl-export-menu'),
      };
      this.els.root.classList.toggle('is-readonly', this.readOnly);
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
      this._onDblClick = this._onDblClick.bind(this);
      this._onContext = this._onContext.bind(this);
      this._onPaste = this._onPaste.bind(this);
      this._onDrop = this._onDrop.bind(this);
      this.els.canvas.addEventListener('pointerdown', this._onPointerDown);
      this.els.canvas.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
      window.addEventListener('gesturestart', this._onGestureStart, { passive: false, capture: true });
      window.addEventListener('gesturechange', this._onGestureChange, { passive: false, capture: true });
      window.addEventListener('gestureend', this._onGestureEnd, { passive: false, capture: true });
      this.els.canvas.addEventListener('dblclick', this._onDblClick);
      this.els.canvas.addEventListener('contextmenu', this._onContext);
      this.els.canvas.addEventListener('dragover', (e) => { e.preventDefault(); });
      this.els.canvas.addEventListener('drop', this._onDrop);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerUp);
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('paste', this._onPaste);
      window.addEventListener('blur', this._onWinBlur = () => {
        this._spaceDown = false;
        if (this.els.root) this.els.root.classList.remove('is-space');
        this._pointers.clear();
        this._pinch = null;
        this._gestureActive = false;
        clearTimeout(this._gestureTimer);
      });
      this.els.toolbar.addEventListener('click', (e) => this._onToolbar(e));
      this.els.inspector.addEventListener('input', (e) => this._onInspector(e));
      this.els.inspector.addEventListener('change', (e) => this._onInspector(e));
      this.els.inspector.addEventListener('click', (e) => this._onInspectorClick(e));
      this.els.framesDock.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.els.framesDock.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="frames"]')) {
          this.els.bookmarks.classList.toggle('open');
          this.els.palette.classList.remove('open');
          if (this.els.templates) this.els.templates.classList.remove('open');
          if (this.els.icons) this.els.icons.classList.remove('open');
          if (!this.els.bookmarks.classList.contains('open')) this._hideFrameCatPicker();
          else if (this.els.frameSearch) {
            this.els.frameSearch.focus();
            this.els.frameSearch.select();
          }
        }
      });
      this.els.bookmarks.addEventListener('click', (e) => this._onFramesMenuClick(e));
      this._bindFramesMenuDnD();
      this.els.bookmarks.addEventListener('contextmenu', (e) => this._onFramesMenuContext(e));
      this._frameQuery = '';
      if (this.els.frameSearch) {
        this.els.frameSearch.addEventListener('input', () => {
          this._frameQuery = this.els.frameSearch.value;
          this._renderBookmarks();
        });
        this.els.frameSearch.addEventListener('keydown', (e) => e.stopPropagation());
        this.els.frameSearch.addEventListener('pointerdown', (e) => e.stopPropagation());
      }
      this.els.menu.addEventListener('click', (e) => this._onMenu(e));
      this.els.file.addEventListener('change', () => this._onFilePicked());
      this.els.exportMenu.addEventListener('click', (e) => this._onExportClick(e));
      document.addEventListener('mousedown', this._onDocDown = (e) => {
        if (this.els.catPick && this.els.catPick.contains(e.target)) return;
        if (!this.els.menu.contains(e.target)) this.els.menu.classList.remove('open');
        if (!this.els.palette.contains(e.target) && !e.target.closest('[data-act="shapes"]')) this.els.palette.classList.remove('open');
        if (this.els.templates && !this.els.templates.contains(e.target) && !e.target.closest('[data-act="templates"]')) this.els.templates.classList.remove('open');
        if (this.els.icons && !this.els.icons.contains(e.target) && !e.target.closest('[data-act="icons"]')) this.els.icons.classList.remove('open');
        if (this.els.framesDock && !this.els.framesDock.contains(e.target)) {
          this.els.bookmarks.classList.remove('open');
          this._hideFrameCatPicker();
        } else {
          this._hideFrameCatPicker();
        }
        if (this.els.exportMenu && !this.els.exportMenu.contains(e.target) && !e.target.closest('[data-act="export"]')) {
          this.els.exportMenu.classList.remove('open');
        }
      });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._applyTransform());
        this._ro.observe(this.els.canvas);
      }
      document.addEventListener('fullscreenchange', this._onFs = () => this._syncFullscreenBtn());
      document.addEventListener('webkitfullscreenchange', this._onFs);
    }

    _unbind() {
      this.els.canvas.removeEventListener('pointerdown', this._onPointerDown);
      this.els.canvas.removeEventListener('wheel', this._onWheel, { capture: true });
      window.removeEventListener('gesturestart', this._onGestureStart, { capture: true });
      window.removeEventListener('gesturechange', this._onGestureChange, { capture: true });
      window.removeEventListener('gestureend', this._onGestureEnd, { capture: true });
      clearTimeout(this._gestureTimer);
      this.els.canvas.removeEventListener('dblclick', this._onDblClick);
      this.els.canvas.removeEventListener('contextmenu', this._onContext);
      this.els.canvas.removeEventListener('drop', this._onDrop);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      if (this._zoomRaf) cancelAnimationFrame(this._zoomRaf);
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('paste', this._onPaste);
      window.removeEventListener('blur', this._onWinBlur);
      document.removeEventListener('mousedown', this._onDocDown);
      document.removeEventListener('fullscreenchange', this._onFs);
      document.removeEventListener('webkitfullscreenchange', this._onFs);
      if (this._ro) this._ro.disconnect();
    }

    _active() { return this.container && !this.container.classList.contains('hidden'); }
    _emit() { this.onChange(); }

    _pushUndo() {
      this._undo.push(C.cloneData(this.data));
      if (this._undo.length > 80) this._undo.shift();
      this._redo = [];
      this._syncToolbar();
    }

    undo() {
      if (!this._undo.length) return;
      this._redo.push(C.cloneData(this.data));
      // Pan/zoom isn't an edit: keep the current view.
      const vp = this.data.viewport;
      this.data = this._undo.pop();
      this.data.viewport = vp;
      this.selected.clear();
      this.selectedLink = null;
      this.selectedFrameId = null;
      this.render();
      this._applyTransform();
      this._emit();
    }

    redo() {
      if (!this._redo.length) return;
      this._undo.push(C.cloneData(this.data));
      const vp = this.data.viewport;
      this.data = this._redo.pop();
      this.data.viewport = vp;
      this.selected.clear();
      this.selectedLink = null;
      this.selectedFrameId = null;
      this.render();
      this._applyTransform();
      this._emit();
    }

    _clientToWorld(clientX, clientY) {
      const rect = this.els.canvas.getBoundingClientRect();
      const vp = this.data.viewport;
      return { x: (clientX - rect.left - vp.x) / vp.zoom, y: (clientY - rect.top - vp.y) / vp.zoom };
    }

    _applyTransform() {
      const vp = this.data.viewport;
      this.els.world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
      this.els.canvas.style.setProperty('--z', String(vp.zoom));
      // Fine grid: 4 world units (4px at 100%). Zoomed out it would pack lines
      // under 4px apart and shimmer, so step the spacing up 10x instead.
      let minor = 4 * vp.zoom;
      while (minor < 4) minor *= 10;
      this.els.canvas.style.setProperty('--grid-minor', minor + 'px');
      this.els.canvas.style.setProperty('--grid-major', minor * 10 + 'px');
      this.els.root.classList.toggle('is-gpu-world', vp.zoom >= 0.35);
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
      vp.zoom = C.clamp(next, 0.08, 2.6);
      vp.x = cx - wx * vp.zoom;
      vp.y = cy - wy * vp.zoom;
      this._applyTransform();
    }

    _scheduleVpEmit() {
      /* pan/zoom stays in memory; it is not a document edit */
    }

    _setTool(tool) {
      this.tool = tool;
      this.els.root.setAttribute('data-tool', tool);
      this._syncToolbar();
    }

    _syncToolbar() {
      this.els.toolbar.querySelectorAll('[data-tool]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-tool') === this.tool);
      });
      const undo = this.els.toolbar.querySelector('[data-act="undo"]');
      const redo = this.els.toolbar.querySelector('[data-act="redo"]');
      if (undo) undo.disabled = this.readOnly || !this._undo.length;
      if (redo) redo.disabled = this.readOnly || !this._redo.length;
    }

    _onToolbar(e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      const tool = btn.getAttribute('data-tool');
      const act = btn.getAttribute('data-act');
      const z = btn.getAttribute('data-z');
      if (act === 'shapes') {
        this.els.palette.classList.toggle('open');
        if (this.els.templates) this.els.templates.classList.remove('open');
        if (this.els.icons) this.els.icons.classList.remove('open');
        this.els.exportMenu.classList.remove('open');
        return;
      }
      if (act === 'templates') {
        if (this.els.templates) this.els.templates.classList.toggle('open');
        this.els.palette.classList.remove('open');
        if (this.els.icons) this.els.icons.classList.remove('open');
        this.els.exportMenu.classList.remove('open');
        return;
      }
      if (act === 'icons') {
        if (this.els.icons) this.els.icons.classList.toggle('open');
        this.els.palette.classList.remove('open');
        if (this.els.templates) this.els.templates.classList.remove('open');
        this.els.exportMenu.classList.remove('open');
        return;
      }
      const tpl = btn.getAttribute('data-template');
      if (tpl) {
        if (this.els.templates) this.els.templates.classList.remove('open');
        this._insertTemplate(tpl);
        return;
      }
      const iconId = btn.getAttribute('data-icon');
      if (iconId) {
        if (this.els.icons) this.els.icons.classList.remove('open');
        this._insertIcon(iconId);
        return;
      }
      if (tool) {
        this._setTool(tool);
        this.els.palette.classList.remove('open');
        if (this.els.templates) this.els.templates.classList.remove('open');
        if (this.els.icons) this.els.icons.classList.remove('open');
        if (tool === 'image') this._imageAt = null;
        return;
      }
      if (z) this._applyZ(z);
      if (act === 'undo') this.undo();
      if (act === 'redo') this.redo();
      if (act === 'delete') this._deleteSelected();
      if (act === 'zoom-in') this.setZoom(this.data.viewport.zoom * 1.15);
      if (act === 'zoom-out') this.setZoom(this.data.viewport.zoom / 1.15);
      if (act === 'export') {
        this.els.bookmarks.classList.remove('open');
        this.els.palette.classList.remove('open');
        if (this.els.templates) this.els.templates.classList.remove('open');
        if (this.els.icons) this.els.icons.classList.remove('open');
        this.els.exportMenu.classList.toggle('open');
        return;
      }
      if (act === 'fit') this.fitView();
      if (act === 'fullscreen') this.toggleFullscreen();
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
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (btn) {
        btn.textContent = on ? 'Exit full' : 'Fullscreen';
        btn.classList.toggle('active', on);
      }
      if (this.els.root) this.els.root.classList.toggle('is-fullscreen', on);
      this._applyTransform();
    }

    _insertIcon(id) {
      if (this.readOnly) return;
      const src = C.iconSrc(id);
      if (!src) return;
      this._pushUndo();
      const rect = this.els.canvas.getBoundingClientRect();
      const w = this._clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const size = C.ICON_SIZE || 64;
      const s = C.iconShape(id, C.snap(w.x - size / 2), C.snap(w.y - size / 2));
      s.id = C.uid('s_');
      s.z = C.maxZ(this.data) + 1;
      this._assignFrame(s);
      this.data.shapes[s.id] = s;
      this._selectOnly(s.id);
      this.render();
      this._emit();
    }

    _insertTemplate(id) {
      if (this.readOnly) return;
      this._pushUndo();
      const result = C.applyTemplate(this.data, id);
      this.selected = new Set(result.ids || []);
      this.selectedLink = null;
      this.selectedFrameId = null;
      this.render();
      this._emit();
      if (result.ids && result.ids.length) {
        const slice = { shapes: {}, frames: [], connectors: {} };
        result.ids.forEach((sid) => {
          if (this.data.shapes[sid]) slice.shapes[sid] = this.data.shapes[sid];
        });
        (result.frameIds || []).forEach((fid) => {
          const f = (this.data.frames || []).find((x) => x.id === fid);
          if (f) slice.frames.push(f);
        });
        this._focusBounds(C.contentBounds(slice));
      }
    }

    _focusBounds(b) {
      if (!b) return;
      const pad = 80;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const zoom = C.clamp(Math.min(vw / Math.max(b.w + pad * 2, 400), vh / Math.max(b.h + pad * 2, 280)), 0.12, 1.2);
      this.data.viewport.zoom = zoom;
      this.data.viewport.x = vw / 2 - (b.x + b.w / 2) * zoom;
      this.data.viewport.y = vh / 2 - (b.y + b.h / 2) * zoom;
      this._applyTransform();
    }

    _selectedShapes() {
      return [...this.selected].map((id) => this.data.shapes[id]).filter(Boolean);
    }

    _layerTarget() {
      if (this.selectedFrameId) {
        const f = (this.data.frames || []).find((x) => x.id === this.selectedFrameId);
        if (f) return { kind: 'frame', obj: f };
      }
      const s = this._selectedShapes()[0];
      if (s) return { kind: 'shape', obj: s };
      return null;
    }

    _applyZ(mode) {
      if (this.readOnly) return;
      const items = C.layerItems(this.data).filter((it) => it.kind === 'shape');
      const targets = [];
      this.selected.forEach((id) => {
        if (this.data.shapes[id] && !this.isShapeLocked(id)) targets.push({ kind: 'shape', id });
      });
      if (!targets.length) return;
      this._pushUndo();
      const zs = items.map((it) => it.z);
      const max = zs.length ? Math.max.apply(null, zs) : 10;
      const min = zs.length ? Math.min.apply(null, zs) : 10;
      if (mode === 'front') {
        let z = max + 1;
        targets.forEach((t) => this._writeZ(t, z++));
      } else if (mode === 'back') {
        let z = min - targets.length;
        targets.forEach((t) => this._writeZ(t, z++));
      } else {
        targets.forEach((t) => {
          const idx = items.findIndex((it) => it.id === t.id);
          if (idx < 0) return;
          const swapWith = mode === 'forward' ? items[idx + 1] : items[idx - 1];
          if (!swapWith) return;
          const a = this._readZ(t);
          const b = this._readZ(swapWith);
          this._writeZ(t, b);
          this._writeZ(swapWith, a);
        });
      }
      this.render();
      this._emit();
    }

    _readZ(t) {
      if (t.kind === 'frame') {
        const f = (this.data.frames || []).find((x) => x.id === t.id);
        return f ? (f.z || 0) : 0;
      }
      const s = this.data.shapes[t.id];
      return s ? (s.z || 0) : 0;
    }

    _writeZ(t, z) {
      if (t.kind === 'frame') {
        const f = (this.data.frames || []).find((x) => x.id === t.id);
        if (f) f.z = z;
      } else if (this.data.shapes[t.id]) this.data.shapes[t.id].z = z;
    }

    _assignFrame(shape) {
      if (!shape) return;
      const f = this._frameAt(shape.x + shape.w / 2, shape.y + shape.h / 2);
      if (f && f.locked && shape.frameId !== f.id) return;
      shape.frameId = f ? f.id : null;
    }

    _frameAt(wx, wy) {
      let best = null;
      let bestZ = -Infinity;
      (this.data.frames || []).forEach((f) => {
        if (wx < f.x || wy < f.y || wx > f.x + f.w || wy > f.y + f.h) return;
        if ((f.z || 0) >= bestZ) {
          best = f;
          bestZ = f.z || 0;
        }
      });
      return best;
    }

    _lockingFrame(s) {
      if (!s) return null;
      const frames = this.data.frames || [];
      const byId = s.frameId ? frames.find((f) => f.id === s.frameId) : null;
      if (byId && byId.locked) return byId;
      const hit = this._frameAt(s.x + (s.w || 0) / 2, s.y + (s.h || 0) / 2);
      return (hit && hit.locked) ? hit : null;
    }

    isShapeLocked(sOrId) {
      const s = typeof sOrId === 'string' ? this.data.shapes[sOrId] : sOrId;
      if (!s) return false;
      if (s.locked) return true;
      return !!this._lockingFrame(s);
    }

    lockFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || f.locked) return;
      this._pushUndo();
      f.locked = true;
      Object.keys(this.data.shapes).forEach((sid) => {
        const s = this.data.shapes[sid];
        if (s.frameId && s.frameId !== f.id) return;
        const overlap = s.x < f.x + f.w && s.x + s.w > f.x && s.y < f.y + f.h && s.y + s.h > f.y;
        if (s.frameId === f.id || overlap) s.frameId = f.id;
      });
      this.render();
      this._emit();
    }

    unlockFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || this.readOnly || !f.locked) return;
      this._pushUndo();
      f.locked = false;
      this.selected.clear();
      this.selectedLink = null;
      this.selectedFrameId = id;
      this.render();
      this._emit();
    }

    toggleFrameLock(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      if (f.locked) this.unlockFrame(id);
      else this.lockFrame(id);
    }

    lockShape(id) {
      const s = this.data.shapes[id];
      if (!s || this.readOnly || s.locked || this._lockingFrame(s)) return;
      this._pushUndo();
      s.locked = true;
      this.render();
      this._emit();
    }

    unlockShape(id) {
      const s = this.data.shapes[id];
      if (!s || this.readOnly || !s.locked || this._lockingFrame(s)) return;
      this._pushUndo();
      s.locked = false;
      this._selectOnly(id);
      this.render();
      this._emit();
    }

    toggleShapeLock(id) {
      const s = this.data.shapes[id];
      if (!s || this._lockingFrame(s)) return;
      if (s.locked) this.unlockShape(id);
      else this.lockShape(id);
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
      } else if (kind === 'shape') {
        const s = this.data.shapes[id];
        if (!s || !s.locked || this._lockingFrame(s)) return;
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
        if (t.kind === 'frame') this.unlockFrame(t.id);
        else this.unlockShape(t.id);
      }, LOCK_HOLD_MS);
      this._lockHold = hold;
    }

    _beginShapeLockHold(s, e) {
      if (!s) return false;
      const frame = this._lockingFrame(s);
      if (frame) {
        e.preventDefault();
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = frame.id;
        this.render();
        return true;
      }
      if (s.locked) {
        e.preventDefault();
        this._selectOnly(s.id);
        this.render();
        this._beginLockHold('shape', s.id, e);
        return true;
      }
      return false;
    }

    _frameWouldOverlap(fr) {
      return (this.data.frames || []).some((o) => o.id !== fr.id && C.rectsOverlap(fr, o));
    }

    _shapesCarriedByFrame(f) {
      const out = [];
      Object.keys(this.data.shapes).forEach((id) => {
        const s = this.data.shapes[id];
        const owned = s.frameId === f.id;
        const overlap = s.x < f.x + f.w && s.x + s.w > f.x && s.y < f.y + f.h && s.y + s.h > f.y;
        if (owned || (!s.frameId && overlap)) out.push({ id, x: s.x, y: s.y });
      });
      return out;
    }

    focusFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      this.selected.clear();
      this.selectedLink = null;
      this.selectedFrameId = id;
      const vw = this.els.canvas.clientWidth || 800;
      const vh = this.els.canvas.clientHeight || 600;
      const pad = 80;
      const zoom = C.clamp(Math.min(vw / (f.w + pad * 2), (vh - 78) / (f.h + pad * 2 + 62)), 0.25, 1.6);
      this.data.viewport.zoom = zoom;
      this.data.viewport.x = vw / 2 - (f.x + f.w / 2) * zoom;
      this.data.viewport.y = vh / 2 - (f.y + f.h / 2) * zoom;
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
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
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
      const frames = this._directFrames(c.id).filter((fr) => this._frameVisible(fr, q));
      const open = !c.collapsed || !!q;
      const count = q ? frames.length + kids.reduce((n, k) => n + this._catFrameCount(k.id), 0) : this._catFrameCount(c.id);
      let body = '';
      if (open) {
        body = kids.map((k) => this._catTreeHtml(k, depth + 1)).join('') + frames.map((fr) => this._frameItemHtml(fr)).join('');
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
      const frames = this.data.frames || [];
      const cats = this._frameCatList();
      const list = this.els.frameList || this.els.bookmarks;
      const q = this._frameQueryText();
      this.els.framesDock.hidden = !frames.length && !cats.length;
      if (!frames.length && !cats.length) {
        this.els.bookmarks.classList.remove('open');
        list.innerHTML = '';
        this.els.framesBtn.textContent = 'Frames';
        return;
      }
      const current = frames.find((f) => f.id === this.selectedFrameId);
      this.els.framesBtn.textContent = current ? (current.title || 'Frame') : 'Frames';
      if (this.els.frameSearch && this.els.frameSearch.value !== (this._frameQuery || '')) {
        this.els.frameSearch.value = this._frameQuery || '';
      }
      const uncat = this._directFrames(null).filter((f) => this._frameVisible(f, q));
      const tree = this._sortedFrameCats(null).filter((c) => this._catHasVisible(c, q)).map((c) => this._catTreeHtml(c, 0)).join('');
      const visible = frames.filter((f) => this._frameVisible(f, q));
      const flat = visible.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''))).map((f) => this._frameItemHtml(f)).join('');
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
      const id = C.uid('fc_');
      this._pushUndo();
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
      this._pushUndo();
      cat.name = trimmed;
      this._renderBookmarks();
      this._emit();
    }

    _deleteFrameCat(id) {
      if (this.readOnly) return;
      const cat = this._frameCatList().find((c) => c.id === id);
      if (!cat) return;
      if (!confirm('Remove “' + cat.name + '”? Frames move to the parent category.')) return;
      this._pushUndo();
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
      cat.collapsed = !cat.collapsed;
      this._renderBookmarks();
      this._emit();
    }

    _assignFrameCat(frameId, categoryId) {
      if (this.readOnly) return;
      const f = (this.data.frames || []).find((x) => x.id === frameId);
      if (!f) return;
      const next = categoryId && this._frameCatList().some((c) => c.id === categoryId) ? categoryId : null;
      if ((f.categoryId || null) === next) return;
      this._pushUndo();
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

    _deleteSelected() {
      if (this.readOnly) return;
      if (!this.selected.size && !this.selectedLink && !this.selectedFrameId) return;
      const frame = this.selectedFrameId && (this.data.frames || []).find((x) => x.id === this.selectedFrameId);
      const unlockedIds = [...this.selected].filter((id) => !this.isShapeLocked(id));
      if (frame && frame.locked && !unlockedIds.length && !this.selectedLink) return;
      this._pushUndo();
      if (this.selectedFrameId && !(frame && frame.locked)) this._deleteFrame(this.selectedFrameId, true);
      if (this.selectedLink && this.data.connectors[this.selectedLink]) delete this.data.connectors[this.selectedLink];
      this.selectedLink = null;
      unlockedIds.forEach((id) => {
        delete this.data.shapes[id];
        Object.keys(this.data.connectors).forEach((cid) => {
          const c = this.data.connectors[cid];
          if (c.from.shapeId === id || c.to.shapeId === id) delete this.data.connectors[cid];
        });
      });
      this.selected.clear();
      this.render();
      this._emit();
    }

    _deleteFrame(id, silent) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (f && f.locked) return;
      this.data.frames = (this.data.frames || []).filter((f) => f.id !== id);
      Object.keys(this.data.shapes).forEach((sid) => {
        if (this.data.shapes[sid].frameId === id) this.data.shapes[sid].frameId = null;
      });
      if (this.selectedFrameId === id) this.selectedFrameId = null;
      if (!silent) {
        this.render();
        this._emit();
      }
    }

    duplicateFrame(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f) return;
      this._pushUndo();
      const copy = Object.assign({}, f, { id: C.uid('f_'), x: f.x + 48, y: f.y + 48, title: (f.title || 'Frame') + ' copy', z: C.maxZ(this.data) + 1, locked: false });
      const map = {};
      this._shapesCarriedByFrame(f).forEach((o) => {
        const src = this.data.shapes[o.id];
        const nn = JSON.parse(JSON.stringify(src));
        nn.id = C.uid('s_');
        nn.x = src.x + 48;
        nn.y = src.y + 48;
        nn.frameId = copy.id;
        nn.z = (src.z || 0) + 1;
        nn.locked = false;
        this.data.shapes[nn.id] = nn;
        map[src.id] = nn.id;
      });
      Object.keys(this.data.connectors).slice().forEach((cid) => {
        const c = this.data.connectors[cid];
        if (map[c.from.shapeId] && map[c.to.shapeId]) {
          const nc = C.defaultConnector({ shapeId: map[c.from.shapeId], port: c.from.port }, { shapeId: map[c.to.shapeId], port: c.to.port });
          nc.style = Object.assign({}, c.style);
          nc.label = c.label;
          this.data.connectors[nc.id] = nc;
        }
      });
      this.data.frames.push(copy);
      this.selectedFrameId = copy.id;
      this.selected.clear();
      this.render();
      this._emit();
    }

    fitFrameToContent(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || f.locked) return;
      const carried = this._shapesCarriedByFrame(f);
      if (!carried.length) return;
      this._pushUndo();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      carried.forEach((o) => {
        const s = this.data.shapes[o.id];
        x0 = Math.min(x0, s.x);
        y0 = Math.min(y0, s.y);
        x1 = Math.max(x1, s.x + s.w);
        y1 = Math.max(y1, s.y + s.h);
      });
      const pad = 36;
      f.x = x0 - pad;
      f.y = y0 - pad;
      f.w = Math.max(C.MIN_FRAME_W, x1 - x0 + pad * 2);
      f.h = Math.max(C.MIN_FRAME_H, y1 - y0 + pad * 2);
      this.render();
      this._emit();
    }

    _beginFrameRename(id) {
      const f = (this.data.frames || []).find((x) => x.id === id);
      if (!f || f.locked) return;
      const el = this.els.world.querySelector(`.fl-frame[data-id="${CSS.escape(id)}"] .fl-frame-title`);
      if (!el) return;
      el.contentEditable = 'true';
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    _duplicateSelected() {
      if (this.readOnly) return;
      if (this.selectedFrameId && !this.selected.size) return this.duplicateFrame(this.selectedFrameId);
      if (!this.selected.size) return;
      this._pushUndo();
      const map = {};
      const created = [];
      this._selectedShapes().forEach((s) => {
        const copy = JSON.parse(JSON.stringify(s));
        copy.id = C.uid('s_');
        copy.x = C.snap(s.x + 24);
        copy.y = C.snap(s.y + 24);
        copy.z = C.maxZ(this.data) + 1;
        copy.locked = false;
        this.data.shapes[copy.id] = copy;
        map[s.id] = copy.id;
        created.push(copy.id);
      });
      Object.keys(this.data.connectors).slice().forEach((cid) => {
        const c = this.data.connectors[cid];
        if (map[c.from.shapeId] && map[c.to.shapeId]) {
          const nc = C.defaultConnector({ shapeId: map[c.from.shapeId], port: c.from.port }, { shapeId: map[c.to.shapeId], port: c.to.port });
          nc.style = Object.assign({}, c.style);
          nc.label = c.label;
          this.data.connectors[nc.id] = nc;
        }
      });
      this.selected = new Set(created);
      this.selectedLink = null;
      this.render();
      this._emit();
    }

    _copyPayload() {
      const payload = { v: 1, shapes: {}, connectors: {}, frames: [] };
      if (this.selectedFrameId && !this.selected.size && !this.selectedLink) {
        const f = (this.data.frames || []).find((x) => x.id === this.selectedFrameId);
        if (f) payload.frames.push(JSON.parse(JSON.stringify(f)));
      } else {
        this.selected.forEach((id) => {
          const s = this.data.shapes[id];
          if (s) payload.shapes[id] = JSON.parse(JSON.stringify(s));
        });
        if (this.selectedLink && this.data.connectors[this.selectedLink] && !this.selected.size) {
          const c = this.data.connectors[this.selectedLink];
          payload.connectors[c.id] = JSON.parse(JSON.stringify(c));
          [c.from.shapeId, c.to.shapeId].forEach((sid) => {
            if (this.data.shapes[sid] && !payload.shapes[sid]) payload.shapes[sid] = JSON.parse(JSON.stringify(this.data.shapes[sid]));
          });
        }
        Object.keys(this.data.connectors).forEach((cid) => {
          const c = this.data.connectors[cid];
          if (payload.shapes[c.from.shapeId] && payload.shapes[c.to.shapeId]) {
            payload.connectors[cid] = JSON.parse(JSON.stringify(c));
          }
        });
      }
      if (!Object.keys(payload.shapes).length && !payload.frames.length) return null;
      return payload;
    }

    _copySelected() {
      if (this.readOnly) return;
      const payload = this._copyPayload();
      if (!payload) return;
      this._clip = payload;
      const text = CLIP_PREFIX + JSON.stringify(payload);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    }

    _applyPastePayload(payload) {
      if (!payload || payload.v !== 1) return;
      this._pushUndo();
      const map = {};
      const created = [];
      const frameMap = {};
      (payload.frames || []).forEach((f) => {
        const copy = JSON.parse(JSON.stringify(f));
        copy.id = C.uid('f_');
        copy.x = C.snap((f.x || 0) + 24);
        copy.y = C.snap((f.y || 0) + 24);
        copy.title = (f.title || 'Frame') + ' copy';
        copy.locked = false;
        this.data.frames.push(copy);
        frameMap[f.id] = copy.id;
        this.selectedFrameId = copy.id;
      });
      Object.keys(payload.shapes || {}).forEach((id) => {
        const s = payload.shapes[id];
        const copy = JSON.parse(JSON.stringify(s));
        copy.id = C.uid('s_');
        copy.x = C.snap((s.x || 0) + 24);
        copy.y = C.snap((s.y || 0) + 24);
        copy.z = C.maxZ(this.data) + 1;
        copy.locked = false;
        if (copy.frameId && frameMap[copy.frameId]) copy.frameId = frameMap[copy.frameId];
        else if (copy.frameId && !(this.data.frames || []).some((f) => f.id === copy.frameId)) copy.frameId = null;
        this.data.shapes[copy.id] = copy;
        map[id] = copy.id;
        created.push(copy.id);
      });
      Object.keys(payload.connectors || {}).forEach((cid) => {
        const c = payload.connectors[cid];
        if (!map[c.from.shapeId] || !map[c.to.shapeId]) return;
        const nc = C.defaultConnector(
          { shapeId: map[c.from.shapeId], port: c.from.port },
          { shapeId: map[c.to.shapeId], port: c.to.port }
        );
        nc.style = Object.assign(C.defaultLineStyle(), c.style || {});
        nc.label = c.label || '';
        this.data.connectors[nc.id] = nc;
      });
      if (created.length) {
        this.selected = new Set(created);
        this.selectedLink = null;
        if (!payload.frames || !payload.frames.length) this.selectedFrameId = null;
      }
      this.render();
      this._emit();
    }

    _pasteSelected(rawText) {
      if (this.readOnly) return;
      let payload = this._clip;
      const text = rawText || '';
      if (text.indexOf(CLIP_PREFIX) === 0) {
        try { payload = JSON.parse(text.slice(CLIP_PREFIX.length)); } catch (err) { /* keep clip */ }
      }
      if (payload) this._applyPastePayload(payload);
    }

    render() {
      this._rankCache = null;
      this._renderFrames();
      this._renderLinks();
      this._renderShapes();
      this._renderInspector();
      this._renderBookmarks();
      this._syncToolbar();
      this.els.hint.style.display = Object.keys(this.data.shapes).length > 2 ? 'none' : '';
    }

    _renderFrames() {
      const world = this.els.world;
      const keep = new Set((this.data.frames || []).map((f) => f.id));
      world.querySelectorAll('.fl-frame').forEach((el) => { if (!keep.has(el.dataset.id)) el.remove(); });
      (this.data.frames || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((f) => this._paintFrame(f));
    }

    _paintFrame(f) {
      let el = this.els.world.querySelector(`.fl-frame[data-id="${CSS.escape(f.id)}"]`);
      if (el && (!el.querySelector('[data-frame-unlock]') || !el.querySelector('[data-resize-frame]'))) {
        el.remove();
        el = null;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'fl-frame';
        el.dataset.id = f.id;
        el.innerHTML = `<div class="fl-frame-bar" data-frame-drag>
            <div class="fl-frame-title" data-frame-unlock contenteditable="false"></div>
            <span class="fl-frame-lock" data-frame-unlock title="Locked · press and hold the name to unlock"></span>
          </div>
          <div class="fl-frame-top" data-frame-drag></div>
          <div class="fl-fh fl-fh-nw" data-resize-frame="nw"></div>
          <div class="fl-fh fl-fh-n" data-resize-frame="n"></div>
          <div class="fl-fh fl-fh-ne" data-resize-frame="ne"></div>
          <div class="fl-fh fl-fh-e" data-resize-frame="e"></div>
          <div class="fl-fh fl-fh-se" data-resize-frame="se"></div>
          <div class="fl-fh fl-fh-s" data-resize-frame="s"></div>
          <div class="fl-fh fl-fh-sw" data-resize-frame="sw"></div>
          <div class="fl-fh fl-fh-w" data-resize-frame="w"></div>`;
        this.els.world.insertBefore(el, this.els.linksHost);
        el.querySelector('.fl-frame-title').addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const fr = this.data.frames.find((x) => x.id === el.dataset.id);
          if (fr && fr.locked) return;
          if (!this.readOnly) this._beginFrameRename(el.dataset.id);
        });
        el.querySelector('.fl-frame-title').addEventListener('blur', (e) => {
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
      el.style.zIndex = String(FRAME_Z);
      el.style.background = C.hexAlpha(f.fill || '#ffffff', f.fillAlpha == null ? 1 : f.fillAlpha);
      el.style.borderColor = f.border || '#c5c9d1';
      el.classList.toggle('selected', this.selectedFrameId === f.id);
      el.classList.toggle('is-locked', !!f.locked);
      el.classList.toggle('is-blocked', !!(this._drag && this._drag.kind === 'draw-frame' && this._drag.tempId === f.id && this._frameWouldOverlap(f)));
      const bar = el.querySelector('.fl-frame-bar');
      if (bar) bar.title = f.locked ? 'Locked · press and hold the name to unlock' : 'Drag to move';
      const title = el.querySelector('.fl-frame-title');
      if (title) title.title = f.locked ? 'Locked · press and hold to unlock' : '';
      if (document.activeElement !== title) title.textContent = f.title || 'Frame';
    }

    _shapeRanks() {
      if (this._rankCache) return this._rankCache;
      const map = {};
      C.shapesByZ(this.data).forEach((s, i) => { map[s.id] = i; });
      this._rankCache = map;
      return map;
    }

    _shapeZ(s) {
      return CELL_Z + 2 * (this._shapeRanks()[s.id] || 0);
    }

    _linkZ(c) {
      const ranks = this._shapeRanks();
      const ra = ranks[c.from.shapeId];
      const rb = ranks[c.to.shapeId];
      const r = Math.min(ra == null ? 0 : ra, rb == null ? 0 : rb);
      return CELL_Z + 2 * r + 1;
    }

    _arrowMarks(arrow, id) {
      const url = `url(#fl-arrow-${id})`;
      return {
        end: arrow === 'end' || arrow === 'both' ? url : '',
        start: arrow === 'start' || arrow === 'both' ? url : '',
      };
    }

    _alphaSlider(key, alpha, label) {
      const pct = Math.round(C.clamp01(alpha, 1) * 100);
      return `<label class="fl-alpha">${label} <input type="range" min="0" max="100" data-insp="${key}" value="${pct}" title="${pct}%"><span class="fl-alpha-val">${pct}%</span></label>`;
    }

    _lineSelectHtml(arrow, route, bend) {
      const a = arrow || 'end';
      const r = route || 'bent';
      const b = C.clampBend(bend);
      const bendLabel = r === 'curved' ? 'Curve' : 'Bend';
      return `
        <label>Ends <select data-insp="arrow">
          <option value="none"${a === 'none' ? ' selected' : ''}>Line</option>
          <option value="end"${a === 'end' ? ' selected' : ''}>Arrow</option>
          <option value="start"${a === 'start' ? ' selected' : ''}>Reverse</option>
          <option value="both"${a === 'both' ? ' selected' : ''}>Both</option>
        </select></label>
        <label>Path <select data-insp="route">
          <option value="straight"${r === 'straight' ? ' selected' : ''}>Straight</option>
          <option value="bent"${r === 'bent' ? ' selected' : ''}>Bent</option>
          <option value="curved"${r === 'curved' ? ' selected' : ''}>Curved</option>
        </select></label>
        ${r === 'straight' ? '' : `<label class="fl-alpha">${bendLabel} <input type="range" min="0" max="100" data-insp="bend" value="${b}" title="${b}"><span class="fl-alpha-val">${b}</span></label>`}`;
    }

    _dashSelectHtml(value, key, label) {
      const v = C.normDash(value);
      const opts = C.DASH_MODES.map((d) => `<option value="${d}"${v === d ? ' selected' : ''}>${C.DASH_LABELS[d] || d}</option>`).join('');
      return `<label>${label || 'Style'} <select data-insp="${key}">${opts}</select></label>`;
    }

    _ensureLinkSvg(id) {
      let svg = this.els.linksHost.querySelector(`.fl-links[data-link="${CSS.escape(id)}"]`);
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'fl-links');
        svg.setAttribute('data-link', id);
        svg.setAttribute('overflow', 'visible');
        this.els.linksHost.appendChild(svg);
      }
      return svg;
    }

    _renderLinks() {
      this._rankCache = null;
      const host = this.els.linksHost;
      const keep = new Set(Object.keys(this.data.connectors));
      if (this._linkPreview) keep.add('__preview__');
      host.querySelectorAll('.fl-links').forEach((el) => {
        if (!keep.has(el.getAttribute('data-link'))) el.remove();
      });
      Object.keys(this.data.connectors).forEach((id) => {
        const c = this.data.connectors[id];
        const a = this.data.shapes[c.from.shapeId];
        const b = this.data.shapes[c.to.shapeId];
        if (!a || !b) return;
        const geo = C.connectorPath(a, c.from.port, b, c.to.port, c.style);
        const dash = C.dashArray(c.style.dash);
        const sel = this.selectedLink === id;
        const color = C.hexAlpha(c.style.color || '#5B7EAE', c.style.alpha);
        const marks = this._arrowMarks(c.style.arrow, id);
        const svg = this._ensureLinkSvg(id);
        svg.style.zIndex = String(this._linkZ(c));
        svg.innerHTML = `<defs><marker id="fl-arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"></path></marker></defs>`
          + `<path class="fl-link-hit" data-link="${id}" d="${geo.d}" fill="none" stroke="transparent" stroke-width="14"/>`
          + `<path data-link="${id}" d="${geo.d}" fill="none" stroke="${color}" stroke-width="${sel ? (c.style.width || 2) + 1 : (c.style.width || 2)}" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${dash}" marker-end="${marks.end}" marker-start="${marks.start}" pointer-events="none"/>`
          + (c.label ? `<text x="${geo.mid.x}" y="${geo.mid.y - 8}" text-anchor="middle" font-size="12" font-weight="650" fill="#1a2130">${escapeXml(c.label)}</text>` : '');
      });
      if (this._linkPreview) {
        const svg = this._ensureLinkSvg('__preview__');
        svg.style.zIndex = String(CELL_Z + 2 * Object.keys(this.data.shapes).length + 5);
        svg.innerHTML = `<path d="${this._linkPreview.d || C.pointsToPath(this._linkPreview.pts || this._linkPreview)}" fill="none" stroke="#4f6ef7" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>`;
      }
    }

    _renderShapes() {
      const world = this.els.world;
      const keep = new Set(Object.keys(this.data.shapes));
      world.querySelectorAll('.fl-shape').forEach((el) => { if (!keep.has(el.dataset.id)) el.remove(); });
      C.shapesByZ(this.data).forEach((s) => this._paintShape(s));
    }

    _paintShape(s) {
      let el = this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(s.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'fl-shape';
        el.dataset.id = s.id;
        this.els.world.appendChild(el);
      }
      el.dataset.type = s.type;
      el.classList.toggle('is-selected', this.selected.has(s.id));
      el.classList.toggle('is-collapsed', s.type === 'sticky' && !!s.collapsed);
      const locked = this.isShapeLocked(s);
      el.classList.toggle('is-locked', locked);
      el.classList.toggle('is-borderless', !!(s.style && s.style.borderless));
      el.classList.toggle('is-editing', !!(this._edit && !this._edit.link && this._edit.id === s.id));
      el.title = locked ? 'Locked · press and hold to unlock' : '';
      el.style.left = s.x + 'px';
      el.style.top = s.y + 'px';
      el.style.width = s.w + 'px';
      el.style.height = s.h + 'px';
      el.style.zIndex = String(this._shapeZ(s) + (s.noteOpen ? 40 : 0));
      const handles = locked ? '' : ((s.type === 'image' || s.type === 'sticky' || s.type === 'textbox')
        ? ['nw', 'ne', 'se', 'sw'].map((h) => `<span class="fl-handle" data-h="${h}"></span>`).join('')
        : '<span class="fl-handle" data-h="se"></span>');
      const lockBadge = locked ? '<span class="fl-shape-lock" title="Locked · press and hold to unlock"></span>' : '';
      if (s.type === 'image') {
        const src = C.safeImageSrc(s.src);
        const op = C.clamp01(s.style && s.style.opacity, 1);
        el.innerHTML = src
          ? `<img class="fl-img" alt="" src="${escapeAttr(src)}" draggable="false" style="opacity:${op}"/>`
          : `<div class="fl-img-empty">Drop image or SVG</div>`;
        el.innerHTML += `<div class="fl-ports">${C.PORTS.map((p) => `<span class="fl-port" data-port="${p}"></span>`).join('')}</div><div class="fl-handles">${handles}</div>${this._noteChromeHtml(s)}${lockBadge}`;
        this._bindNoteUi(el, s);
      } else {
        const d = C.shapePath(s.type, s.w, s.h);
        const fill = C.hexAlpha(s.style.fill, s.style.fillAlpha);
        const stroke = C.hexAlpha(s.style.border, s.style.borderAlpha);
        const fold = s.type === 'sticky' ? `<path class="fl-sticky-fold" d="${C.stickyFoldPath(s.w, s.h)}" fill="rgba(0,0,0,.08)" stroke="none"/>` : '';
        el.innerHTML = `
          <svg class="fl-body" viewBox="0 0 ${s.w} ${s.h}" preserveAspectRatio="none">
            <path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${C.borderStrokeWidth(s.style)}" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${C.dashArray(s.style.borderDash)}"/>
            ${fold}
          </svg>
          ${this._stickyBarHtml(s)}
          <div class="fl-label">${escapeHtml(s.type === 'sticky' && s.collapsed ? C.firstLine(s.text) : s.text)}</div>
          <div class="fl-ports">${C.PORTS.map((p) => `<span class="fl-port" data-port="${p}"></span>`).join('')}</div>
          <div class="fl-handles">${handles}</div>
          ${this._noteChromeHtml(s)}
          ${lockBadge}
        `;
        this._applyLabelFormat(el, s);
        this._bindNoteUi(el, s);
      }
    }

    _applyLabelFormat(el, s) {
      const label = el.querySelector('.fl-label');
      if (!label) return;
      const fmt = Object.assign(C.defaultFormat(), s.format || {});
      label.style.color = C.hexAlpha(s.style.textColor || '#1a2130', s.style.textAlpha);
      label.style.fontFamily = C.fontCss(fmt.fontFamily);
      label.style.fontSize = (fmt.fontSize || 14) + 'px';
      if (s.type === 'sticky' && s.collapsed) {
        label.style.lineHeight = (s.h || C.stickyMiniHeight(s)) + 'px';
      } else {
        label.style.lineHeight = '';
        const valign = C.normValign(fmt.valign, s.type === 'textbox' ? 'top' : 'middle');
        label.style.alignItems = valign === 'top' ? 'flex-start' : valign === 'bottom' ? 'flex-end' : 'center';
      }
      label.style.fontWeight = fmt.bold ? '800' : '650';
      label.style.fontStyle = fmt.italic ? 'italic' : 'normal';
      label.style.textDecoration = fmt.underline ? 'underline' : 'none';
      label.style.justifyContent = fmt.align === 'left' ? 'flex-start' : fmt.align === 'right' ? 'flex-end' : 'center';
      label.style.textAlign = fmt.align || 'center';
      // Monospace text (e.g. pasted diagrams) keeps every space and line as-is.
      const mono = fmt.fontFamily === 'mono';
      label.style.whiteSpace = mono ? 'pre' : s.type === 'textbox' ? 'pre-wrap' : '';
      label.style.wordBreak = mono ? 'normal' : '';
    }

    // A text diagram was pasted into a shape: monospace, left-aligned, and
    // big enough to show it without wrapping. One undo step with the text.
    _makeDiagramShape(shape, ta) {
      if (!this._edit || this._edit.pushed) return;
      this._pushUndo();
      this._edit.pushed = true;
      shape.format = Object.assign(C.defaultFormat(), shape.format || {}, { fontFamily: 'mono', align: 'left', valign: 'top' });
      const fs = Number(shape.format.fontSize) || 14;
      const P = global.DocPaste;
      const lines = String(ta.value).split('\n');
      const cols = P ? P.maxLineLength(ta.value) : Math.max(...lines.map((l) => l.length));
      shape.w = C.snap(Math.max(shape.w, Math.ceil(cols * fs * 0.62 + 36)));
      shape.h = C.snap(Math.max(shape.h, Math.ceil(lines.length * fs * 1.3 + 32)));
      Object.assign(ta.style, {
        fontFamily: C.fontCss('mono'), textAlign: 'left', whiteSpace: 'pre',
        width: Math.max(80, shape.w) + 'px', height: Math.max(40, shape.h) + 'px',
      });
    }

    _stickyBarHtml(s) {
      if (s.type !== 'sticky') return '';
      const collapsed = !!s.collapsed;
      return `<div class="fl-sticky-bar"><button type="button" data-sticky-toggle title="${collapsed ? 'Expand sticky' : 'Minimize sticky'}">${collapsed ? '+' : '–'}</button></div>`;
    }

    _noteChromeHtml(s) {
      if (s.type === 'sticky') return '';
      const has = !!(s.note && String(s.note).trim());
      const show = has || s.noteOpen || this.selected.has(s.id);
      if (!show) return '';
      const pin = `<button type="button" class="fl-note-pin${has || s.noteOpen ? ' has-note' : ''}${s.noteOpen ? ' is-open' : ''}" data-note-toggle title="${s.noteOpen ? 'Minimize note' : (has ? 'Open note' : 'Add note')}">i</button>`;
      if (!s.noteOpen) return pin;
      return `${pin}<div class="fl-note-card">
        <div class="fl-note-card-bar"><span>Note</span><button type="button" data-note-toggle title="Minimize">–</button></div>
        <textarea data-note-body placeholder="Write a note…">${escapeHtml(s.note || '')}</textarea>
      </div>`;
    }

    _bindNoteUi(el, s) {
      el.querySelectorAll('[data-note-toggle]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleNote(s);
        });
      });
      const ta = el.querySelector('[data-note-body]');
      if (ta) {
        ta.addEventListener('pointerdown', (e) => e.stopPropagation());
        ta.addEventListener('mousedown', (e) => e.stopPropagation());
        ta.readOnly = this.readOnly;
        ta.addEventListener('input', () => {
          if (this.readOnly) return;
          if (!this._inspUndo) { this._pushUndo(); this._inspUndo = true; }
          s.note = ta.value;
          this._emit();
        });
        ta.addEventListener('change', () => { this._inspUndo = false; });
        ta.addEventListener('keydown', (e) => e.stopPropagation());
      }
      el.querySelectorAll('[data-sticky-toggle]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleSticky(s);
        });
      });
    }

    _toggleNote(s) {
      if (!s || s.type === 'sticky' || this.isShapeLocked(s)) return;
      if (!this.readOnly) this._pushUndo();
      s.noteOpen = !s.noteOpen;
      this.render();
      if (!this.readOnly) this._emit();
      if (s.noteOpen) {
        const ta = this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(s.id)}"] [data-note-body]`);
        if (ta) ta.focus();
      }
    }

    _applyCollapsedSticky(s) {
      if (!s || s.type !== 'sticky' || !s.collapsed) return;
      let measured = null;
      try {
        const line = C.firstLine(s.text);
        const fmt = Object.assign(C.defaultFormat(), s.format || {});
        const canvas = this._textMeasure || (this._textMeasure = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        ctx.font = `${fmt.bold ? '800' : '650'} ${fmt.fontSize || 14}px ${C.fontCss(fmt.fontFamily)}`;
        measured = Math.ceil(ctx.measureText(line || ' ').width);
      } catch (e) { measured = null; }
      C.applyCollapsedStickySize(s, measured);
    }

    _toggleSticky(s) {
      if (!s || s.type !== 'sticky' || this.isShapeLocked(s)) return;
      if (!this.readOnly) this._pushUndo();
      if (s.collapsed) C.expandSticky(s);
      else {
        C.collapseSticky(s);
        this._applyCollapsedSticky(s);
      }
      this.render();
      if (!this.readOnly) this._emit();
    }

    _setImageSize(s, nextW, fromCenter) {
      const aspect = s.imgAspect > 0.1 ? s.imgAspect : (s.w / Math.max(s.h, 1));
      let nw = C.clamp(nextW, 80, 1200);
      let nh = nw / aspect;
      if (nh < 60) { nh = 60; nw = nh * aspect; }
      if (fromCenter) {
        s.x += ((s.w || nw) - nw) / 2;
        s.y += ((s.h || nh) - nh) / 2;
      }
      s.w = nw;
      s.h = nh;
    }

    _renderInspector() {
      const box = this.els.inspector;
      const layerBtns = `<button type="button" data-z="front">Front</button><button type="button" data-z="forward">Forward</button><button type="button" data-z="backward">Backward</button><button type="button" data-z="back">Back</button>`;
      const fontSelect = (fmt) => `<select data-insp="font" title="Font">${C.FONT_FACES.map((f) => `<option value="${f.id}"${(fmt.fontFamily || 'sans') === f.id ? ' selected' : ''}>${f.label}</option>`).join('')}</select>`;
      const sizeSelect = (fmt) => {
        const cur = Number(fmt.fontSize) || 14;
        const sizes = C.FONT_SIZES.slice();
        if (sizes.indexOf(cur) === -1) sizes.push(cur);
        sizes.sort((a, b) => a - b);
        return `<select data-insp="size" title="Size">${sizes.map((n) => `<option value="${n}"${n === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
      };
      if (this.selectedFrameId && !this.selected.size) {
        const f = (this.data.frames || []).find((x) => x.id === this.selectedFrameId);
        if (!f) { box.classList.remove('show', 'is-locked'); box.innerHTML = ''; return; }
        box.classList.add('show');
        box.classList.toggle('is-locked', !!f.locked);
        box.innerHTML = `
          <span>Frame</span>
          <button type="button" data-act="lock">${f.locked ? 'Unlock' : 'Lock'}</button>
          <label>Fill <input type="color" data-insp="frame-fill" value="${toColor(f.fill, '#ffffff')}"></label>
          ${FILL_PALETTE.map((col) => `<button type="button" data-frame-fill="${col}" style="width:16px;height:16px;border-radius:4px;background:${col};padding:0;border:1px solid rgba(0,0,0,.12)"></button>`).join('')}
        `;
        return;
      }
      if (this.selectedLink && this.data.connectors[this.selectedLink]) {
        const c = this.data.connectors[this.selectedLink];
        box.classList.remove('is-locked');
        box.classList.add('show');
        box.innerHTML = `
          <label>Line <input type="color" data-insp="line" value="${toColor(c.style.color, '#5B7EAE')}"></label>
          ${this._alphaSlider('lineAlpha', c.style.alpha, 'Opacity')}
          <label>Width <select data-insp="width">${[1.5, 2, 2.5, 3, 4].map((w) => `<option value="${w}"${Number(c.style.width) === w ? ' selected' : ''}>${w}</option>`).join('')}</select></label>
          ${this._dashSelectHtml(c.style.dash, 'dash', 'Style')}
          ${this._lineSelectHtml(c.style.arrow, c.style.route, c.style.bend)}
          ${LINE_PALETTE.map((col) => `<button type="button" data-line-chip="${col}" style="width:16px;height:16px;border-radius:50%;background:${col};padding:0;border:1px solid rgba(255,255,255,.3)"></button>`).join('')}
        `;
        return;
      }
      const shapes = this._selectedShapes();
      if (!shapes.length) {
        box.classList.remove('show', 'is-locked');
        box.innerHTML = '';
        return;
      }
      const s = shapes[0];
      const anyUnlocked = shapes.some((sh) => !this.isShapeLocked(sh));
      box.classList.add('show');
      box.classList.toggle('is-locked', !anyUnlocked);
      if (s.type === 'image') {
        const line = Object.assign(C.defaultLine(), s.line || {});
        box.innerHTML = `<button type="button" data-act="lock">${anyUnlocked ? 'Lock' : 'Unlock'}</button>${layerBtns}${this._lineSelectHtml(line.arrow, line.route, line.bend)}${this._alphaSlider('opacity', s.style.opacity, 'Opacity')}<button type="button" data-act="notes" class="${s.noteOpen ? 'active' : ''}" title="Add a note to this object">${s.note && s.note.trim() ? 'Notes' : 'Add note'}</button><button type="button" data-act="replace-image">Replace</button>`;
        return;
      }
      const fmt = Object.assign(C.defaultFormat(), s.format || {});
      const line = Object.assign(C.defaultLine(), s.line || {});
      const isSticky = s.type === 'sticky';
      const isTextbox = s.type === 'textbox';
      const shapeOpts = FLOW_SHAPES.map((t) => `<option value="${t}"${s.type === t ? ' selected' : ''}>${C.SHAPE_META[t].label}</option>`).join('');
      const valign = C.normValign(fmt.valign, isTextbox ? 'top' : 'middle');
      box.innerHTML = `
        <button type="button" data-act="lock">${anyUnlocked ? 'Lock' : 'Unlock'}</button>
        ${isSticky || isTextbox ? '' : `<label>Shape <select data-insp="kind">${shapeOpts}</select></label>`}
        ${isSticky ? `<button type="button" data-act="sticky-toggle">${s.collapsed ? 'Expand' : 'Minimize'}</button>` : this._lineSelectHtml(line.arrow, line.route, line.bend)}
        <label>Fill <input type="color" data-insp="fill" value="${toColor(s.style.fill, '#D7E3FC')}"></label>
        ${this._alphaSlider('fillAlpha', s.style.fillAlpha, 'Fill opacity')}
        <label>Border <input type="color" data-insp="border" value="${toColor(s.style.border, '#5B7EAE')}"></label>
        ${this._dashSelectHtml(s.style.borderDash, 'borderDash', 'Border style')}
        <button type="button" data-style="borderless" class="${s.style.borderless ? 'active' : ''}" title="Hide the outline">Borderless</button>
        ${this._alphaSlider('borderAlpha', s.style.borderAlpha, 'Line opacity')}
        <label>Text <input type="color" data-insp="textColor" value="${toColor(s.style.textColor, '#1a2130')}"></label>
        ${this._alphaSlider('textAlpha', s.style.textAlpha, 'Text opacity')}
        ${FILL_PALETTE.map((col) => `<button type="button" data-fill-chip="${col}" style="width:16px;height:16px;border-radius:4px;background:${col};padding:0;border:1px solid rgba(0,0,0,.12)"></button>`).join('')}
        <span class="fl-sep"></span>
        <button type="button" data-fmt="bold" class="${fmt.bold ? 'active' : ''}" title="Bold"><b>B</b></button>
        <button type="button" data-fmt="italic" class="${fmt.italic ? 'active' : ''}" title="Italic"><i>I</i></button>
        <button type="button" data-fmt="underline" class="${fmt.underline ? 'active' : ''}" title="Underline"><u>U</u></button>
        ${fontSelect(fmt)}
        ${sizeSelect(fmt)}
        <button type="button" data-fmt="align-left" class="${fmt.align === 'left' ? 'active' : ''}">L</button>
        <button type="button" data-fmt="align-center" class="${fmt.align === 'center' ? 'active' : ''}">C</button>
        <button type="button" data-fmt="align-right" class="${fmt.align === 'right' ? 'active' : ''}">R</button>
        ${isTextbox ? `<button type="button" data-fmt="valign-top" class="${valign === 'top' ? 'active' : ''}" title="Align top">Top</button>
        <button type="button" data-fmt="valign-middle" class="${valign === 'middle' ? 'active' : ''}" title="Align middle">Mid</button>
        <button type="button" data-fmt="valign-bottom" class="${valign === 'bottom' ? 'active' : ''}" title="Align bottom">Bot</button>
        <button type="button" data-act="fit-text" title="Shrink or grow the box to the text">Fit</button>` : ''}
        ${isSticky ? '' : `<button type="button" data-act="notes" class="${s.noteOpen ? 'active' : ''}" title="Add a note to this object">${s.note && s.note.trim() ? 'Notes' : 'Add note'}</button>`}
        <span class="fl-sep"></span>
        ${layerBtns}
      `;
    }

    _patchSelectedStyle(fn, opts) {
      if (this.readOnly) return;
      const shapes = this._selectedShapes().filter((s) => !this.isShapeLocked(s));
      if (!shapes.length) return;
      if (!(opts && opts.noUndo)) this._pushUndo();
      shapes.forEach(fn);
      if (opts && opts.live) this._paintLive();
      else this.render();
      this._emit();
    }

    _onInspector(e) {
      const el = e.target;
      const key = el.getAttribute('data-insp');
      if (!key) return;
      if ((el.type === 'color' || el.type === 'range') && e.type === 'change') {
        this._inspUndo = false;
        return;
      }
      const live = e.type === 'input';
      if (key === 'frame-fill' && this.selectedFrameId) {
        const f = this.data.frames.find((x) => x.id === this.selectedFrameId);
        if (!f || f.locked) return;
        if (!live || !this._inspUndo) this._pushUndo();
        this._inspUndo = true;
        f.fill = el.value;
        f.fillAlpha = 1;
        this._paintFrame(f);
        this._emit();
        return;
      }
      if (this.selectedLink && this.data.connectors[this.selectedLink]) {
        if (!live) this._pushUndo();
        else if (!this._inspUndo) { this._pushUndo(); this._inspUndo = true; }
        const c = this.data.connectors[this.selectedLink];
        if (key === 'line') c.style.color = el.value;
        if (key === 'lineAlpha') c.style.alpha = C.clamp01(Number(el.value) / 100);
        if (key === 'width') c.style.width = Number(el.value);
        if (key === 'dash') c.style.dash = el.value;
        if (key === 'arrow') c.style.arrow = el.value;
        if (key === 'route') c.style.route = el.value;
        if (key === 'bend') c.style.bend = C.clampBend(el.value);
        if (key === 'lineAlpha' || key === 'bend') {
          const val = el.parentElement && el.parentElement.querySelector('.fl-alpha-val');
          if (val) val.textContent = key === 'bend' ? String(c.style.bend) : el.value + '%';
        }
        this._renderLinks();
        this._emit();
        if (key === 'route' && !live) this._renderInspector();
        return;
      }
      if ((key === 'fillAlpha' || key === 'borderAlpha' || key === 'textAlpha' || key === 'opacity') && this.selected.size) {
        const val = el.parentElement && el.parentElement.querySelector('.fl-alpha-val');
        if (val) val.textContent = el.value + '%';
        this._patchSelectedStyle((s) => {
          s.style = Object.assign(C.defaultStyle(), s.style);
          const a = C.clamp01(Number(el.value) / 100);
          if (key === 'opacity') s.style.opacity = a;
          else s.style[key] = a;
        }, { noUndo: live && this._inspUndo, live: true });
        if (live) this._inspUndo = true;
        return;
      }
      if ((key === 'arrow' || key === 'route' || key === 'bend') && this.selected.size) {
        if (!live) this._pushUndo();
        else if (!this._inspUndo) { this._pushUndo(); this._inspUndo = true; }
        const bend = key === 'bend' ? C.clampBend(el.value) : null;
        this._selectedShapes().forEach((s) => {
          s.line = Object.assign(C.defaultLine(), s.line);
          if (key === 'arrow') s.line.arrow = el.value;
          if (key === 'route') s.line.route = el.value;
          if (key === 'bend') s.line.bend = bend;
        });
        const ids = this.selected;
        Object.keys(this.data.connectors).forEach((cid) => {
          const c = this.data.connectors[cid];
          if (!ids.has(c.from.shapeId) && !ids.has(c.to.shapeId)) return;
          if (key === 'arrow') c.style.arrow = el.value;
          if (key === 'route') c.style.route = el.value;
          if (key === 'bend') c.style.bend = bend;
        });
        if (key === 'bend') {
          const val = el.parentElement && el.parentElement.querySelector('.fl-alpha-val');
          if (val) val.textContent = String(bend);
          this._renderLinks();
        } else {
          this.render();
        }
        this._emit();
        if (live) this._inspUndo = true;
        return;
      }
      this._patchSelectedStyle((s) => {
        if (key === 'fill') s.style.fill = el.value;
        if (key === 'border') {
          s.style.border = el.value;
          s.style.borderless = false;
        }
        if (key === 'borderDash') {
          s.style.borderDash = C.normDash(el.value);
          s.style.borderless = false;
        }
        if (key === 'textColor') s.style.textColor = el.value;
        if (key === 'font') {
          s.format = Object.assign(C.defaultFormat(), s.format, { fontFamily: el.value });
          if (s.type === 'sticky' && s.collapsed) this._applyCollapsedSticky(s);
        }
        if (key === 'size') {
          s.format = Object.assign(C.defaultFormat(), s.format, { fontSize: C.clampFontSize(el.value) });
          if (s.type === 'sticky' && s.collapsed) this._applyCollapsedSticky(s);
        }
        if (key === 'kind' && C.SHAPE_META[el.value] && s.type !== 'image' && s.type !== 'sticky' && s.type !== 'textbox') {
          s.type = el.value;
        }
      }, { noUndo: live && this._inspUndo, live: live && key !== 'kind' && key !== 'font' && key !== 'size' });
      if (live) this._inspUndo = true;
    }

    _onInspectorClick(e) {
      const lockBtn = e.target.closest('[data-act="lock"]');
      if (lockBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedFrameId && !this.selected.size) {
          this.toggleFrameLock(this.selectedFrameId);
          return;
        }
        const shapes = this._selectedShapes();
        const anyUnlocked = shapes.some((s) => !this.isShapeLocked(s));
        if (anyUnlocked) shapes.forEach((s) => this.lockShape(s.id));
        else shapes.forEach((s) => this.unlockShape(s.id));
        return;
      }
      const borderlessBtn = e.target.closest('[data-style="borderless"]');
      if (borderlessBtn) {
        this._patchSelectedStyle((s) => {
          if (s.type === 'image') return;
          s.style = Object.assign(C.defaultStyle(), s.style);
          s.style.borderless = !s.style.borderless;
        });
        return;
      }
      const notesBtn = e.target.closest('[data-act="notes"]');
      if (notesBtn) {
        const targets = this._selectedShapes().filter((s) => s.type !== 'sticky');
        if (!targets.length) return;
        this._pushUndo();
        const open = !targets[0].noteOpen;
        targets.forEach((s) => { s.noteOpen = open; });
        this.render();
        this._emit();
        if (open) {
          const ta = this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(targets[0].id)}"] [data-note-body]`);
          if (ta) ta.focus();
        }
        return;
      }
      const fitTextBtn = e.target.closest('[data-act="fit-text"]');
      if (fitTextBtn) {
        const boxes = this._selectedShapes().filter((s) => s.type === 'textbox' && !this.isShapeLocked(s));
        if (!boxes.length) return;
        this._pushUndo();
        boxes.forEach((s) => this._fitTextBox(s));
        this.render();
        this._emit();
        return;
      }
      const stickyBtn = e.target.closest('[data-act="sticky-toggle"]');
      if (stickyBtn) {
        const s = this._selectedShapes().find((x) => x.type === 'sticky');
        if (s) this._toggleSticky(s);
        return;
      }
      const z = e.target.closest('[data-z]');
      if (z) { this._applyZ(z.getAttribute('data-z')); return; }
      const fmtBtn = e.target.closest('[data-fmt]');
      if (fmtBtn) {
        const act = fmtBtn.getAttribute('data-fmt');
        this._pushUndo();
        this._selectedShapes().forEach((s) => {
          if (s.type === 'image' || this.isShapeLocked(s)) return;
          s.format = Object.assign(C.defaultFormat(), s.format);
          if (act === 'bold') s.format.bold = !s.format.bold;
          if (act === 'italic') s.format.italic = !s.format.italic;
          if (act === 'underline') s.format.underline = !s.format.underline;
          if (act === 'align-left') s.format.align = 'left';
          if (act === 'align-center') s.format.align = 'center';
          if (act === 'align-right') s.format.align = 'right';
          if (act === 'valign-top') s.format.valign = 'top';
          if (act === 'valign-middle') s.format.valign = 'middle';
          if (act === 'valign-bottom') s.format.valign = 'bottom';
          if (s.type === 'sticky' && s.collapsed) this._applyCollapsedSticky(s);
        });
        this.render();
        this._emit();
        return;
      }
      if (e.target.closest('[data-act="replace-image"]')) {
        const img = this._selectedShapes()[0];
        if (!img || this.isShapeLocked(img)) return;
        this._imageAt = { replace: img.id };
        this.els.file.click();
        return;
      }
      const frameFill = e.target.closest('[data-frame-fill]');
      if (frameFill && this.selectedFrameId) {
        const f = this.data.frames.find((x) => x.id === this.selectedFrameId);
        if (!f || f.locked) return;
        this._pushUndo();
        f.fill = frameFill.getAttribute('data-frame-fill');
        f.fillAlpha = 1;
        this.render();
        this._emit();
        return;
      }
      const fill = e.target.closest('[data-fill-chip]');
      if (fill) this._patchSelectedStyle((s) => {
        s.style.fill = fill.getAttribute('data-fill-chip');
      });
      const line = e.target.closest('[data-line-chip]');
      if (line && this.selectedLink && this.data.connectors[this.selectedLink]) {
        this._pushUndo();
        this.data.connectors[this.selectedLink].style.color = line.getAttribute('data-line-chip');
        this.render();
        this._emit();
      }
    }

    _selectOnly(id) {
      this._inspUndo = false;
      this.selectedLink = null;
      this.selectedFrameId = null;
      this.selected.clear();
      if (id) this.selected.add(id);
    }

    _openMenu(x, y, html) {
      this.els.menu.innerHTML = html;
      this.els.menu.classList.add('open');
      const pad = 8;
      const w = this.els.menu.offsetWidth || 200;
      const h = this.els.menu.offsetHeight || 240;
      this.els.menu.style.left = Math.min(x, window.innerWidth - w - pad) + 'px';
      this.els.menu.style.top = Math.min(y, window.innerHeight - h - pad) + 'px';
    }

    _onContext(e) {
      e.preventDefault();
    }

    _onMenu(e) {
      const btn = e.target.closest('[data-m]');
      if (!btn) return;
      const m = btn.getAttribute('data-m');
      this.els.menu.classList.remove('open');
      if (m === 'front' || m === 'back' || m === 'forward' || m === 'backward') this._applyZ(m);
      if (m === 'export') {
        this._exportOneFrame(this.selectedFrameId, btn.getAttribute('data-format'));
        return;
      }
      if (m === 'lock') {
        if (this.selectedFrameId && !this.selected.size) this.toggleFrameLock(this.selectedFrameId);
        else {
          const shapes = this._selectedShapes();
          const anyUnlocked = shapes.some((s) => !this.isShapeLocked(s));
          if (anyUnlocked) shapes.forEach((s) => this.lockShape(s.id));
          else shapes.forEach((s) => this.unlockShape(s.id));
        }
        return;
      }
      if (m === 'delete') this._deleteSelected();
      if (m === 'duplicate') this._duplicateSelected();
      if (m === 'copy') this._copySelected();
      if (m === 'paste') this._pasteSelected();
      if (m === 'notes') {
        const s = this._selectedShapes()[0];
        if (s) this._toggleNote(s);
      }
      if (m === 'sticky-toggle') {
        const s = this._selectedShapes().find((x) => x.type === 'sticky');
        if (s) this._toggleSticky(s);
      }
      if (m === 'edit-text') {
        const s = this._selectedShapes()[0];
        if (s) this._beginEdit(s);
      }
      if (m === 'fit-text') {
        const boxes = this._selectedShapes().filter((s) => s.type === 'textbox' && !this.isShapeLocked(s));
        if (boxes.length) {
          this._pushUndo();
          boxes.forEach((s) => this._fitTextBox(s));
          this.render();
          this._emit();
        }
      }
      if (m === 'rename' && this.selectedFrameId) this._beginFrameRename(this.selectedFrameId);
      if (m === 'fit' && this.selectedFrameId) this.fitFrameToContent(this.selectedFrameId);
      if (m === 'cat' && this.selectedFrameId) this._assignFrameCat(this.selectedFrameId, btn.getAttribute('data-cat') || null);
    }

    _contextFor(target, x, y) {
      const frameEl = target.closest && target.closest('.fl-frame');
      const shapeEl = target.closest && target.closest('.fl-shape');
      if (shapeEl) {
        const s = this.data.shapes[shapeEl.dataset.id];
        const lockedFrame = s && this._lockingFrame(s);
        if (lockedFrame) {
          this.selected.clear();
          this.selectedLink = null;
          this.selectedFrameId = lockedFrame.id;
          this.render();
          this._openMenu(x, y, this._frameMenuHtml(lockedFrame));
          return;
        }
        this._selectOnly(shapeEl.dataset.id);
        this.render();
        this._openMenu(x, y, `<div class="fl-menu-label">${s && s.type === 'sticky' ? 'Sticky' : s && s.type === 'textbox' ? 'Text box' : 'Shape'}</div>
          <button type="button" data-m="lock">${s && s.locked ? 'Unlock' : 'Lock'}</button>
          ${s && s.type === 'textbox' ? `<button type="button" data-m="edit-text"${s && this.isShapeLocked(s) ? ' disabled' : ''}>Edit text</button><button type="button" data-m="fit-text"${s && this.isShapeLocked(s) ? ' disabled' : ''}>Fit to text</button>` : ''}
          ${s && s.type === 'sticky' ? `<button type="button" data-m="sticky-toggle"${s && this.isShapeLocked(s) ? ' disabled' : ''}>${s.collapsed ? 'Expand' : 'Minimize'}</button>` : `<button type="button" data-m="notes"${s && this.isShapeLocked(s) ? ' disabled' : ''}>Notes</button>`}
          <button type="button" data-m="front">Bring to front</button>
          <button type="button" data-m="forward">Bring forward</button>
          <button type="button" data-m="backward">Send backward</button>
          <button type="button" data-m="back">Send to back</button>
          <div class="fl-menu-sep"></div>
          <button type="button" data-m="copy">Copy</button>
          <button type="button" data-m="paste">Paste</button>
          <button type="button" data-m="duplicate">Duplicate</button>
          <button type="button" data-m="delete"${s && this.isShapeLocked(s) ? ' disabled' : ''}>Delete</button>`);
        return;
      }
      if (frameEl) {
        const f = this.data.frames.find((x) => x.id === frameEl.dataset.id);
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = frameEl.dataset.id;
        this.render();
        this._openMenu(x, y, this._frameMenuHtml(f));
      }
    }

    _frameMenuHtml(f) {
      const locked = !!(f && f.locked);
      const catBtns = this._frameCatList().length
        ? `<div class="fl-menu-sep"></div><div class="fl-menu-label">Category</div>
          <button type="button" data-m="cat" data-cat="" class="${f && f.categoryId ? '' : 'active'}">Uncategorized</button>
          ${this._flatFrameCats(null, 0).map(({ cat, depth }) => (
            `<button type="button" data-m="cat" data-cat="${escapeAttr(cat.id)}" class="${f && f.categoryId === cat.id ? 'active' : ''}">${'· '.repeat(depth)}${escapeHtml(cat.name)}</button>`
          )).join('')}`
        : '';
      return `<div class="fl-menu-label">Frame</div>
          <button type="button" data-m="lock">${locked ? 'Unlock' : 'Lock'}</button>
          <button type="button" data-m="rename"${locked ? ' disabled' : ''}>Rename</button>
          <button type="button" data-m="fit"${locked ? ' disabled' : ''}>Fit to content</button>
          <button type="button" data-m="copy">Copy</button>
          <button type="button" data-m="paste">Paste</button>
          <button type="button" data-m="duplicate">Duplicate</button>
          <div class="fl-menu-sep"></div>
          <button type="button" data-m="export" data-format="png">Export PNG</button>
          <button type="button" data-m="export" data-format="svg">Export SVG</button>
          <button type="button" data-m="export" data-format="pdf">Export PDF</button>
          ${catBtns}
          <div class="fl-menu-sep"></div>
          <button type="button" data-m="delete"${locked ? ' disabled' : ''}>Delete frame</button>`;
    }

    _onDblClick(e) {
      if (this.readOnly) return;
      const shapeEl = e.target.closest('.fl-shape');
      if (shapeEl) {
        const s = this.data.shapes[shapeEl.dataset.id];
        if (s && s.type === 'sticky' && s.collapsed) {
          this._toggleSticky(s);
        }
        if (s && s.type !== 'image' && !s.collapsed) this._beginEdit(s);
        return;
      }
      if (e.target.closest('[data-link]')) {
        const id = e.target.getAttribute('data-link') || e.target.closest('[data-link]').getAttribute('data-link');
        const c = this.data.connectors[id];
        if (!c) return;
        this.selected.clear();
        this.selectedFrameId = null;
        this.selectedLink = id;
        this.render();
        this._beginLinkEdit(c);
      }
    }

    _beginLinkEdit(c) {
      if (!c) return;
      this._endEdit(true);
      const a = this.data.shapes[c.from.shapeId];
      const b = this.data.shapes[c.to.shapeId];
      if (!a || !b) return;
      const geo = C.connectorPath(a, c.from.port, b, c.to.port, c.style);
      const mid = geo.mid;
      const ta = document.createElement('textarea');
      ta.className = 'fl-edit';
      ta.value = c.label || '';
      ta.style.left = (mid.x - 70) + 'px';
      ta.style.top = (mid.y - 18) + 'px';
      ta.style.width = '140px';
      ta.style.height = '36px';
      this.els.world.appendChild(ta);
      this._edit = { el: ta, id: c.id, link: true };
      ta.focus();
      ta.select();
      ta.addEventListener('blur', () => this._endEdit(true));
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this._endEdit(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); this._endEdit(false); }
      });
    }

    _beginEdit(shape) {
      if (!shape || this.isShapeLocked(shape)) return;
      this._endEdit(true);
      const ta = document.createElement('textarea');
      ta.className = 'fl-edit' + (shape.type === 'textbox' ? ' is-textbox' : '');
      ta.value = shape.text || '';
      ta.style.left = shape.x + 'px';
      ta.style.top = shape.y + 'px';
      ta.style.width = Math.max(80, shape.w) + 'px';
      ta.style.height = Math.max(40, shape.h) + 'px';
      const fmt = Object.assign(C.defaultFormat(), shape.format || {});
      ta.style.color = (shape.style && shape.style.textColor) || '#1a2130';
      ta.style.fontFamily = C.fontCss(fmt.fontFamily);
      ta.style.fontSize = (fmt.fontSize || 14) + 'px';
      ta.style.fontWeight = fmt.bold ? '800' : '650';
      ta.style.fontStyle = fmt.italic ? 'italic' : 'normal';
      ta.style.textAlign = fmt.align || (shape.type === 'textbox' ? 'left' : 'center');
      ta.style.textDecoration = fmt.underline ? 'underline' : 'none';
      if (shape.type === 'textbox') {
        ta.style.background = C.hexAlpha((shape.style && shape.style.fill) || '#ffffff', shape.style && shape.style.fillAlpha);
      }
      this.els.world.appendChild(ta);
      this._edit = { el: ta, id: shape.id, type: shape.type, startH: shape.h };
      const host = this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(shape.id)}"]`);
      if (host) host.classList.add('is-editing');
      ta.focus();
      if (shape.type !== 'textbox') ta.select();
      else ta.setSelectionRange(0, ta.value.length);
      const grow = () => {
        if (shape.type !== 'textbox') return;
        ta.style.height = '0px';
        const next = Math.max(shape.h, Math.min(900, ta.scrollHeight + 10));
        ta.style.height = next + 'px';
      };
      ta.addEventListener('input', grow);
      grow();
      // Pasted text: drop invisible characters; a text diagram also switches
      // the shape to a monospace, no-wrap layout so it lines up.
      ta.addEventListener('paste', (ev) => {
        const P = global.DocPaste;
        const raw = P && ev.clipboardData && ev.clipboardData.getData('text/plain');
        if (!raw) return;
        const diagram = P.isDiagram(raw);
        const text = diagram ? P.cleanDiagram(raw) : P.normalize(raw);
        if (!diagram && text === raw) return;
        ev.preventDefault();
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        if (diagram) this._makeDiagramShape(shape, ta);
        ta.dispatchEvent(new Event('input'));
      });
      ta.addEventListener('blur', () => this._endEdit(true));
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); this._endEdit(false); return; }
        if (ev.key === 'Enter' && (shape.type === 'textbox' ? (ev.metaKey || ev.ctrlKey) : !ev.shiftKey)) {
          ev.preventDefault();
          this._endEdit(true);
        }
      });
    }

    _endEdit(commit) {
      if (!this._edit) return;
      const { el, id, link, pushed } = this._edit;
      const next = el.value;
      const grownH = el.offsetHeight;
      const host = !link && this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(id)}"]`);
      el.remove();
      this._edit = null;
      if (host) host.classList.remove('is-editing');
      if (!commit) return;
      if (link) {
        const c = this.data.connectors[id];
        if (c && next !== c.label) {
          this._pushUndo();
          c.label = next.trim();
          this.render();
          this._emit();
        }
        return;
      }
      const shape = this.data.shapes[id];
      if (!shape) return;
      const grew = shape.type === 'textbox' && grownH > shape.h + 4 && !pushed;
      if (next !== shape.text || grew || pushed) {
        if (!pushed) this._pushUndo();
        shape.text = next;
        if (grew) shape.h = C.snap(Math.max(C.MIN_H, grownH));
        if (shape.type === 'sticky' && shape.collapsed) this._applyCollapsedSticky(shape);
        this.render();
        this._emit();
      }
    }

    _fitTextBox(s) {
      if (!s || s.type !== 'textbox') return;
      const fmt = Object.assign(C.defaultFormat(), s.format || {});
      const fs = Number(fmt.fontSize) || 16;
      const canvas = this._measureCanvas || (this._measureCanvas = document.createElement('canvas'));
      const ctx = canvas.getContext('2d');
      ctx.font = `${fmt.italic ? 'italic ' : ''}${fmt.bold ? 800 : 650} ${fs}px ${C.fontCss(fmt.fontFamily)}`;
      const lines = String(s.text || 'Text').split(/\n/);
      let maxW = 0;
      lines.forEach((line) => {
        maxW = Math.max(maxW, ctx.measureText(line || ' ').width);
      });
      s.w = C.snap(C.clamp(Math.ceil(maxW + 28), 72, 720));
      s.h = C.snap(C.clamp(Math.ceil(Math.max(1, lines.length) * fs * 1.38 + 22), 36, 900));
    }

    _placeImage(src, x, y, replaceId) {
      const finish = (naturalW, naturalH) => {
        this._pushUndo();
        const aspect = Math.max(naturalW || IMG_W, 1) / Math.max(naturalH || 200, 1);
        if (replaceId && this.data.shapes[replaceId]) {
          const s = this.data.shapes[replaceId];
          s.src = src;
          s.imgAspect = aspect;
          this._setImageSize(s, s.w, false);
        } else {
          const w = IMG_W;
          const h = w / aspect;
          const s = {
            id: C.uid('s_'),
            type: 'image',
            x: C.snap((x || 0) - w / 2),
            y: C.snap((y || 0) - h / 2),
            w, h,
            text: '',
            src,
            imgAspect: aspect,
            z: C.maxZ(this.data) + 1,
            frameId: null,
            style: C.defaultStyle(),
            format: C.defaultFormat(),
            line: C.defaultLine(),
            note: '',
            noteOpen: false,
            collapsed: false,
            expandW: 0,
            expandH: 0,
            locked: false,
          };
          this._assignFrame(s);
          this.data.shapes[s.id] = s;
          this._selectOnly(s.id);
        }
        this.render();
        this._emit();
      };
      const img = new Image();
      img.onload = () => finish(img.naturalWidth, img.naturalHeight);
      img.onerror = () => finish(IMG_W, 200);
      img.src = src;
    }

    _onFilePicked() {
      const file = this.els.file.files && this.els.file.files[0];
      this.els.file.value = '';
      if (!file) return;
      fileToImageSrc(file).then((src) => {
        const at = this._imageAt || {};
        this._placeImage(src, at.x, at.y, at.replace);
        this._imageAt = null;
        this._setTool('select');
      }).catch((err) => alert(err.message || err));
    }

    _onDrop(e) {
      e.preventDefault();
      if (this.readOnly) return;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const w = this._clientToWorld(e.clientX, e.clientY);
      fileToImageSrc(file).then((src) => this._placeImage(src, w.x, w.y)).catch((err) => alert(err.message || err));
    }

    _onPaste(e) {
      if (!this._active() || this.readOnly) return;
      if (this._edit) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      const text = e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/plain');
      if (text && text.indexOf(CLIP_PREFIX) === 0) {
        e.preventDefault();
        this._pasteSelected(text);
        return;
      }
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          const file = items[i].getAsFile();
          if (!file) continue;
          e.preventDefault();
          const rect = this.els.canvas.getBoundingClientRect();
          const w = this._clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
          fileToImageSrc(file).then((src) => this._placeImage(src, w.x, w.y)).catch(() => {});
          return;
        }
      }
    }

    _onPointerDown(e) {
      if (!this._active()) return;
      if (e.target.closest('.fl-toolbar') || e.target.closest('.fl-inspector') || e.target.closest('.fl-edit') || e.target.closest('.fl-frames-dock') || e.target.closest('.fl-menu') || e.target.closest('.fl-note-card') || e.target.closest('[data-note-toggle]') || e.target.closest('[data-sticky-toggle]')) return;
      this._endEdit(true);
      this.els.menu.classList.remove('open');
      if (e.pointerType === 'touch') {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size >= 2) {
          e.preventDefault();
          this._beginPinch();
          return;
        }
      }
      const w = this._clientToWorld(e.clientX, e.clientY);
      if (e.button === 1 || e.button === 2 || (e.button === 0 && this._spaceDown)) {
        this._drag = { kind: 'pan', x: e.clientX, y: e.clientY, vx: this.data.viewport.x, vy: this.data.viewport.y, pointerId: e.pointerId, button: e.button, moved: false, target: e.target };
        this.els.root.classList.add('is-panning');
        e.preventDefault();
        return;
      }
      if (e.button !== 0 || this.readOnly) return;

      const unlockEl = e.target.closest('[data-frame-unlock]');
      if (unlockEl) {
        const host = unlockEl.closest('.fl-frame');
        const uf = host && this.data.frames.find((x) => x.id === host.dataset.id);
        if (uf && uf.locked) {
          e.preventDefault();
          this.selected.clear();
          this.selectedLink = null;
          this.selectedFrameId = uf.id;
          this.render();
          this._beginLockHold('frame', uf.id, e);
          return;
        }
      }

      const port = e.target.closest('.fl-port');
      if (port) {
        const shape = this.data.shapes[port.closest('.fl-shape').dataset.id];
        if (!shape || this.isShapeLocked(shape)) return;
        this._drag = { kind: 'link', from: { shapeId: shape.id, port: port.dataset.port }, pointerId: e.pointerId };
        this.els.root.classList.add('is-linking');
        e.preventDefault();
        return;
      }

      const handle = e.target.closest('.fl-handle');
      if (handle) {
        const shape = this.data.shapes[handle.closest('.fl-shape').dataset.id];
        if (!shape || this.isShapeLocked(shape)) return;
        // Undo is recorded on the first real movement (a click changes nothing).
        this._drag = {
          kind: 'resize',
          didUndo: false,
          id: shape.id,
          h: handle.dataset.h,
          start: { x: w.x, y: w.y, sx: shape.x, sy: shape.y, sw: shape.w, sh: shape.h },
          aspect: shape.type === 'image' ? (shape.imgAspect || shape.w / shape.h) : null,
          pointerId: e.pointerId,
        };
        return;
      }

      const frameHandle = e.target.closest('[data-resize-frame]');
      if (frameHandle) {
        const f = this.data.frames.find((x) => x.id === frameHandle.closest('.fl-frame').dataset.id);
        if (!f) return;
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = f.id;
        if (f.locked) {
          this.render();
          return;
        }
        this._drag = { kind: 'resize-frame', didUndo: false, id: f.id, h: frameHandle.getAttribute('data-resize-frame'), start: { x: w.x, y: w.y, sx: f.x, sy: f.y, sw: f.w, sh: f.h } };
        this.render();
        return;
      }

      const frameDrag = e.target.closest('[data-frame-drag]');
      if (frameDrag) {
        const f = this.data.frames.find((x) => x.id === frameDrag.closest('.fl-frame').dataset.id);
        if (!f) return;
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = f.id;
        if (f.locked) {
          this.render();
          return;
        }
        // Shapes join the frame only if it is actually moved (see pointerup).
        const origins = this._shapesCarriedByFrame(f);
        this._drag = { kind: 'move-frame', id: f.id, start: { x: w.x, y: w.y }, fx: f.x, fy: f.y, origins, didUndo: false };
        this.render();
        return;
      }

      const linkEl = e.target.closest('[data-link]');
      if (linkEl && this.tool === 'select') {
        this.selected.clear();
        this.selectedFrameId = null;
        this.selectedLink = linkEl.getAttribute('data-link');
        this.render();
        return;
      }

      const shapeEl = e.target.closest('.fl-shape');
      if (this.tool === 'frame' && !shapeEl) {
        this._drag = { kind: 'draw-frame', x0: w.x, y0: w.y };
        return;
      }
      if (this.tool === 'image' && !shapeEl) {
        this._imageAt = { x: w.x, y: w.y };
        this.els.file.click();
        return;
      }
      if (this.tool.startsWith('shape-') && !shapeEl && !linkEl) {
        this._drag = { kind: 'draw-shape', type: this.tool.slice('shape-'.length), x0: w.x, y0: w.y };
        return;
      }
      if (this.tool === 'connect') {
        const shape = shapeEl ? this.data.shapes[shapeEl.dataset.id] : C.hitShape(this.data, w);
        if (shape && !this.isShapeLocked(shape)) {
          this._drag = { kind: 'link', from: { shapeId: shape.id, port: C.nearestPort(shape, w) } };
          this.els.root.classList.add('is-linking');
        }
        return;
      }
      if (shapeEl) {
        const id = shapeEl.dataset.id;
        const shape = this.data.shapes[id];
        if (shape && this._beginShapeLockHold(shape, e)) return;
        const tapEdit = !!(shape && shape.type === 'textbox' && this.selected.has(id) && this.selected.size === 1 && !e.shiftKey);
        if (!this.selected.has(id) && !e.shiftKey) this._selectOnly(id);
        else if (e.shiftKey) {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
          this.selectedLink = null;
          this.selectedFrameId = null;
        }
        this._drag = {
          kind: 'move',
          start: { x: w.x, y: w.y },
          items: this._selectedShapes().filter((s) => !this.isShapeLocked(s)).map((s) => ({ id: s.id, x: s.x, y: s.y })),
          tapEdit,
        };
        this.render();
        return;
      }
      const lockedFrame = this._frameAt(w.x, w.y);
      if (lockedFrame && lockedFrame.locked) {
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = lockedFrame.id;
        this.render();
        return;
      }
      if (!e.shiftKey) {
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = null;
      }
      this._drag = { kind: 'marquee', x0: w.x, y0: w.y, cx0: e.clientX, cy0: e.clientY };
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
      if (d.kind === 'pan') {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) d.moved = true;
        this.data.viewport.x = d.vx + (e.clientX - d.x);
        this.data.viewport.y = d.vy + (e.clientY - d.y);
        this._applyTransform();
        return;
      }
      const w = this._clientToWorld(e.clientX, e.clientY);
      if (d.kind === 'move') {
        const dx = w.x - d.start.x;
        const dy = w.y - d.start.y;
        if (!d.didUndo && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        if (!d.didUndo) { this._pushUndo(); d.didUndo = true; }
        d.items.forEach((it) => {
          const s = this.data.shapes[it.id];
          if (!s) return;
          s.x = C.snap(it.x + dx);
          s.y = C.snap(it.y + dy);
        });
        this._paintLive();
        return;
      }
      if (d.kind === 'resize') {
        if (!d.didUndo && Math.abs(w.x - d.start.x) < 1 && Math.abs(w.y - d.start.y) < 1) return;
        if (!d.didUndo) { this._pushUndo(); d.didUndo = true; }
        this._applyResize(d, w);
        this._paintLive();
        return;
      }
      if (d.kind === 'resize-frame') {
        const f = this.data.frames.find((x) => x.id === d.id);
        if (!f) return;
        if (!d.didUndo && Math.abs(w.x - d.start.x) < 1 && Math.abs(w.y - d.start.y) < 1) return;
        if (!d.didUndo) { this._pushUndo(); d.didUndo = true; }
        this._resizeRect(f, d, w, C.MIN_FRAME_W, C.MIN_FRAME_H);
        this._paintFrame(f);
        return;
      }
      if (d.kind === 'move-frame') {
        const f = this.data.frames.find((x) => x.id === d.id);
        if (!f) return;
        const dx = w.x - d.start.x;
        const dy = w.y - d.start.y;
        if (!d.didUndo && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        if (!d.didUndo) { this._pushUndo(); d.didUndo = true; }
        f.x = d.fx + dx;
        f.y = d.fy + dy;
        (d.origins || []).forEach((o) => {
          const s = this.data.shapes[o.id];
          if (s) { s.x = o.x + dx; s.y = o.y + dy; }
        });
        this._paintLive();
        this._paintFrame(f);
        return;
      }
      if (d.kind === 'draw-shape') {
        const x = Math.min(d.x0, w.x);
        const y = Math.min(d.y0, w.y);
        const sw = Math.abs(w.x - d.x0);
        const sh = Math.abs(w.y - d.y0);
        if (sw < 3 && sh < 3) return;
        if (!d.tempId) {
          this._pushUndo();
          d.didUndo = true;
          const s = C.defaultShape(d.type, x, y);
          s.x = C.snap(x);
          s.y = C.snap(y);
          s.w = Math.max(C.MIN_W, C.snap(sw));
          s.h = Math.max(C.MIN_H, C.snap(sh));
          s.z = C.maxZ(this.data) + 1;
          this.data.shapes[s.id] = s;
          d.tempId = s.id;
          this._selectOnly(s.id);
        } else {
          const s = this.data.shapes[d.tempId];
          if (s) {
            s.x = C.snap(x);
            s.y = C.snap(y);
            s.w = Math.max(C.MIN_W, C.snap(sw));
            s.h = Math.max(C.MIN_H, C.snap(sh));
          }
        }
        const s = this.data.shapes[d.tempId];
        if (s) {
          this._rankCache = null;
          this._paintShape(s);
        }
        return;
      }
      if (d.kind === 'draw-frame') {
        const x = Math.min(d.x0, w.x);
        const y = Math.min(d.y0, w.y);
        const fw = Math.abs(w.x - d.x0);
        const fh = Math.abs(w.y - d.y0);
        if (!d.tempId) {
          this._pushUndo();
          d.didUndo = true;
          const fr = C.defaultFrame(x, y, Math.max(fw, 40), Math.max(fh, 40));
          d.tempId = fr.id;
          fr.z = C.maxZ(this.data) + 1;
          this.data.frames.push(fr);
          this.selectedFrameId = fr.id;
        } else {
          const fr = this.data.frames.find((frame) => frame.id === d.tempId);
          if (fr) Object.assign(fr, { x, y, w: Math.max(fw, 40), h: Math.max(fh, 40) });
        }
        this._renderFrames();
        return;
      }
      if (d.kind === 'link') {
        const from = this.data.shapes[d.from.shapeId];
        if (!from) return;
        const hover = C.hitShape(this.data, w);
        const toShape = hover && hover.id !== from.id && !this.isShapeLocked(hover) ? hover : null;
        const fakeTo = toShape || { x: w.x - 4, y: w.y - 4, w: 8, h: 8 };
        const toPort = toShape ? C.nearestPort(toShape, w) : 'w';
        this._linkPreview = C.connectorPath(from, d.from.port, fakeTo, toPort, from.line || { route: 'bent', bend: 50 });
        this._renderLinks();
        return;
      }
      if (d.kind === 'marquee') {
        const x = Math.min(d.x0, w.x);
        const y = Math.min(d.y0, w.y);
        const rw = Math.abs(w.x - d.x0);
        const rh = Math.abs(w.y - d.y0);
        const rect = this.els.canvas.getBoundingClientRect();
        const cx0 = d.cx0 != null ? d.cx0 : e.clientX;
        const cy0 = d.cy0 != null ? d.cy0 : e.clientY;
        this.els.marquee.classList.add('show');
        this.els.marquee.style.left = (Math.min(cx0, e.clientX) - rect.left) + 'px';
        this.els.marquee.style.top = (Math.min(cy0, e.clientY) - rect.top) + 'px';
        this.els.marquee.style.width = Math.abs(e.clientX - cx0) + 'px';
        this.els.marquee.style.height = Math.abs(e.clientY - cy0) + 'px';
        const a = this._clientToWorld(cx0, cy0);
        const b = this._clientToWorld(e.clientX, e.clientY);
        d.box = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x),
          h: Math.abs(b.y - a.y),
        };
      }
    }

    _resizeRect(obj, d, w, minW, minH) {
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      let x = d.start.sx, y = d.start.sy, ww = d.start.sw, hh = d.start.sh;
      const h = d.h;
      if (h.includes('e')) ww = d.start.sw + dx;
      if (h.includes('s')) hh = d.start.sh + dy;
      if (h.includes('w')) { x = d.start.sx + dx; ww = d.start.sw - dx; }
      if (h.includes('n')) { y = d.start.sy + dy; hh = d.start.sh - dy; }
      if (ww < minW) { if (h.includes('w')) x = d.start.sx + d.start.sw - minW; ww = minW; }
      if (hh < minH) { if (h.includes('n')) y = d.start.sy + d.start.sh - minH; hh = minH; }
      obj.x = x;
      obj.y = y;
      obj.w = ww;
      obj.h = hh;
    }

    _applyResize(d, w) {
      const s = this.data.shapes[d.id];
      if (!s) return;
      if (d.aspect) {
        const c = d.h || 'se';
        let nw = (c === 'se' || c === 'ne') ? d.start.sw + (w.x - d.start.x) : d.start.sw - (w.x - d.start.x);
        this._setImageSize(s, nw, false);
        s.x = c.indexOf('w') !== -1 ? d.start.sx + d.start.sw - s.w : d.start.sx;
        s.y = c.indexOf('n') !== -1 ? d.start.sy + d.start.sh - s.h : d.start.sy;
        return;
      }
      if (s.type === 'sticky' && s.collapsed) {
        const bounds = C.stickyMiniWidthBounds(s);
        const miniH = C.stickyMiniHeight(s);
        this._resizeRect(s, d, w, bounds.min, miniH);
        s.x = C.snap(s.x);
        s.y = C.snap(s.y);
        s.w = C.clamp(C.snap(s.w), bounds.min, bounds.max);
        s.h = miniH;
        s.miniW = s.w;
        return;
      }
      this._resizeRect(s, d, w, C.MIN_W, C.MIN_H);
      s.x = C.snap(s.x);
      s.y = C.snap(s.y);
      s.w = Math.max(C.MIN_W, C.snap(s.w));
      s.h = Math.max(C.MIN_H, C.snap(s.h));
    }

    _paintLive() {
      this._renderLinks();
      Object.keys(this.data.shapes).forEach((id) => {
        const s = this.data.shapes[id];
        const el = this.els.world.querySelector(`.fl-shape[data-id="${CSS.escape(id)}"]`);
        if (!el) return;
        el.style.left = s.x + 'px';
        el.style.top = s.y + 'px';
        el.style.width = s.w + 'px';
        el.style.height = s.h + 'px';
        el.style.zIndex = String(this._shapeZ(s) + (s.noteOpen ? 40 : 0));
        const path = el.querySelector('svg.fl-body path:not(.fl-sticky-fold)');
        const fold = el.querySelector('svg.fl-body path.fl-sticky-fold');
        const svg = el.querySelector('svg.fl-body');
        if (svg) svg.setAttribute('viewBox', `0 0 ${s.w} ${s.h}`);
        if (path && s.type !== 'image' && s.style) {
          path.setAttribute('d', C.shapePath(s.type, s.w, s.h));
          path.setAttribute('fill', C.hexAlpha(s.style.fill, s.style.fillAlpha));
          path.setAttribute('stroke', C.hexAlpha(s.style.border, s.style.borderAlpha));
          path.setAttribute('stroke-width', String(C.borderStrokeWidth(s.style)));
          path.setAttribute('stroke-dasharray', C.dashArray(s.style.borderDash) || 'none');
        }
        if (fold && s.type === 'sticky') fold.setAttribute('d', C.stickyFoldPath(s.w, s.h));
        const img = el.querySelector('.fl-img');
        if (img) img.style.opacity = String(C.clamp01(s.style && s.style.opacity, 1));
        this._applyLabelFormat(el, s);
      });
    }

    _onPointerUp(e) {
      if (this._lockHold && (this._lockHold.pointerId == null || this._lockHold.pointerId === e.pointerId)) {
        this._clearLockHold();
      }
      this._pointers.delete(e.pointerId);
      if (this._pinch) {
        if (this._pointers.size < 2) {
          this._pinch = null;
          this._scheduleVpEmit();
        }
        return;
      }
      const d = this._drag;
      if (!d) return;
      this._drag = null;
      this.els.root.classList.remove('is-panning', 'is-linking');
      this.els.marquee.classList.remove('show');
      if (d.kind === 'pan') {
        if (d.button === 2 && !d.moved) this._contextFor(d.target || e.target, e.clientX, e.clientY);
        else this._emit();
        return;
      }
      if (d.kind === 'move') {
        this._selectedShapes().forEach((s) => this._assignFrame(s));
        this.render();
        if (d.didUndo) this._emit();
        else if (d.tapEdit) {
          const s = this.data.shapes[d.items && d.items[0] && d.items[0].id];
          if (s && s.type === 'textbox' && !this.isShapeLocked(s)) this._beginEdit(s);
        }
        return;
      }
      if (d.kind === 'resize' || d.kind === 'resize-frame' || d.kind === 'move-frame') {
        if (!d.didUndo) return; // a click without dragging changes nothing
        if (d.kind === 'move-frame') {
          (d.origins || []).forEach((o) => {
            const s = this.data.shapes[o.id];
            if (s && !s.frameId) s.frameId = d.id;
          });
        }
        if (d.kind === 'resize-frame') {
          // Shapes now outside the frame stop belonging to it.
          Object.values(this.data.shapes).forEach((s) => { if (s.frameId === d.id) this._assignFrame(s); });
        }
        this.render();
        this._emit();
        return;
      }
      if (d.kind === 'draw-shape') {
        let created = null;
        if (!d.tempId) {
          this._pushUndo();
          const s = C.defaultShape(d.type, d.x0, d.y0);
          s.x = C.snap(d.x0 - s.w / 2);
          s.y = C.snap(d.y0 - s.h / 2);
          s.z = C.maxZ(this.data) + 1;
          this._assignFrame(s);
          this.data.shapes[s.id] = s;
          this._selectOnly(s.id);
          created = s;
        } else {
          const s = this.data.shapes[d.tempId];
          if (s) this._assignFrame(s);
          created = s;
        }
        this._setTool('select');
        this.render();
        this._emit();
        if (created && created.type === 'textbox' && !this.isShapeLocked(created)) {
          requestAnimationFrame(() => this._beginEdit(created));
        }
        return;
      }
      if (d.kind === 'draw-frame') {
        const fr = this.data.frames.find((x) => x.id === d.tempId);
        if (fr) {
          const overlap = this._frameWouldOverlap(fr);
          const nested = (this.data.frames || []).some((o) => o.id !== fr.id && C.rectInside(fr, o));
          if (overlap || nested || fr.w < 48 || fr.h < 40) {
            // Rejected: drop the undo step taken when drawing began.
            this.data.frames = this.data.frames.filter((x) => x.id !== fr.id);
            this.selectedFrameId = null;
            if (d.didUndo) this._undo.pop();
            this._setTool('select');
            this.render();
            this._syncToolbar();
            return;
          } else {
            Object.keys(this.data.shapes).forEach((id) => this._assignFrame(this.data.shapes[id]));
          }
        }
        this._setTool('select');
        this.render();
        this._emit();
        return;
      }
      if (d.kind === 'link') {
        const w = this._clientToWorld(e.clientX, e.clientY);
        const hover = C.hitShape(this.data, w);
        this._linkPreview = null;
        if (hover && hover.id !== d.from.shapeId && !this.isShapeLocked(hover)) {
          this._pushUndo();
          const c = C.defaultConnector(d.from, { shapeId: hover.id, port: C.nearestPort(hover, w) });
          const src = this.data.shapes[d.from.shapeId];
          if (src && src.line) {
            c.style.arrow = src.line.arrow || c.style.arrow;
            c.style.route = src.line.route || c.style.route;
            if (src.line.bend != null) c.style.bend = C.clampBend(src.line.bend);
          }
          this.data.connectors[c.id] = c;
          this.selected.clear();
          this.selectedFrameId = null;
          this.selectedLink = c.id;
        }
        this.render();
        this._emit();
        return;
      }
      if (d.kind === 'marquee') {
        if (d.box) {
          Object.keys(this.data.shapes).forEach((id) => {
            const s = this.data.shapes[id];
            if (this.isShapeLocked(s)) return;
            if (s.x < d.box.x + d.box.w && s.x + s.w > d.box.x && s.y < d.box.y + d.box.h && s.y + s.h > d.box.y) this.selected.add(id);
          });
          this.selectedLink = null;
        }
        this.render();
      }
    }

    _now() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    _overCanvas(e) {
      const canvas = this.els && this.els.canvas;
      if (!canvas || !this._active()) return false;
      if (e.target && (e.target === canvas || canvas.contains(e.target))) return true;
      if (typeof e.clientX !== 'number') return false;
      const r = canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    _armGestureTimeout() {
      clearTimeout(this._gestureTimer);
      this._gestureTimer = setTimeout(() => { this._gestureActive = false; }, 700);
    }

    _onWheel(e) {
      if (!this._active()) return;
      e.preventDefault();
      if (this._pinch && this._pointers.size < 2) {
        this._pinch = null;
        this._scheduleVpEmit();
      }
      if (this._pinch && this._pointers.size >= 2) return;
      const now = this._now();
      let dy = e.deltaY;
      if (!dy && e.deltaZ) dy = e.deltaZ;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 160;
      const pinch = !!(e.ctrlKey || e.metaKey || (e.deltaZ && e.deltaZ !== 0));
      if (pinch && dy) this._pinchWheelUntil = now + 480;
      if (pinch || now < (this._pinchWheelUntil || 0) || e.deltaMode === 1 || e.deltaMode === 2) {
        if (!dy) return;
        this._zoomPend = this._zoomPend || { dy: 0, x: e.clientX, y: e.clientY, k: 0.01 };
        this._zoomPend.dy += dy;
        this._zoomPend.x = e.clientX;
        this._zoomPend.y = e.clientY;
        this._zoomPend.k = pinch || now < (this._pinchWheelUntil || 0) ? 0.01 : 0.003;
        if (!this._zoomRaf) {
          this._zoomRaf = requestAnimationFrame(() => {
            this._zoomRaf = 0;
            const p = this._zoomPend;
            this._zoomPend = null;
            if (!p) return;
            const rect = this.els.canvas.getBoundingClientRect();
            this._setZoomAt(this.data.viewport.zoom * Math.exp(-p.dy * (p.k || 0.01)), p.x - rect.left, p.y - rect.top);
            this._scheduleVpEmit();
          });
        }
        return;
      }
      if (this._gestureActive) return;
      this.data.viewport.x -= e.deltaX;
      this.data.viewport.y -= e.deltaY;
      this._applyTransform();
      this._scheduleVpEmit();
    }

    _onGestureStart(e) {
      if (!this._overCanvas(e)) return;
      e.preventDefault();
      this._gestureActive = true;
      this._gestureZoom = this.data.viewport.zoom;
      this._armGestureTimeout();
    }

    _onGestureChange(e) {
      if (!this._overCanvas(e)) return;
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

    _beginPinch() {
      const pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      this.els.marquee && this.els.marquee.classList.remove('show');
      this.els.root.classList.remove('is-panning', 'is-linking');
      // The one-finger drag will never reach pointerup: undo what it changed.
      const d = this._drag;
      this._drag = null;
      if (d && d.didUndo && this._undo.length) {
        const vp = this.data.viewport;
        this.data = this._undo.pop();
        this.data.viewport = vp;
        if (d.tempId) { this.selected.delete(d.tempId); if (this.selectedFrameId === d.tempId) this.selectedFrameId = null; }
        if (d.kind === 'draw-frame' || d.kind === 'draw-shape') this._setTool('select');
        this.render();
        this._syncToolbar();
      }
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

    _onKey(e) {
      if (!this._active()) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      // Only when focus is on the page itself or inside the flow; otherwise
      // e.g. Backspace after clicking the sidebar would delete shapes.
      if (e.target && e.target !== document.body && e.target !== document.documentElement
        && !(this.container && this.container.contains(e.target))) return;
      if (e.code === 'Space') {
        this._spaceDown = true;
        this.els.root.classList.add('is-space');
        e.preventDefault();
        return;
      }
      if (this.readOnly) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === ']') { e.preventDefault(); this._applyZ(e.shiftKey ? 'front' : 'forward'); return; }
      if (meta && e.key === '[') { e.preventDefault(); this._applyZ(e.shiftKey ? 'back' : 'backward'); return; }
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); this._duplicateSelected(); return; }
      if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); this._copySelected(); return; }
      if (meta && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((t) => this._pasteSelected(t)).catch(() => this._pasteSelected());
        } else this._pasteSelected();
        return;
      }
      if (meta && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selected = new Set(Object.keys(this.data.shapes).filter((id) => !this.isShapeLocked(id)));
        this.selectedFrameId = null;
        this.render();
        return;
      }
      if (e.key === 'Escape') {
        this._clearLockHold();
        this._setTool('select');
        this.selected.clear();
        this.selectedLink = null;
        this.selectedFrameId = null;
        this._linkPreview = null;
        this.render();
        return;
      }
      if ((e.key === 'v' || e.key === 'V') && !meta) this._setTool('select');
      if ((e.key === 'c' || e.key === 'C') && !meta) this._setTool('connect');
      if ((e.key === 'f' || e.key === 'F') && !meta) this._setTool('frame');
      if ((e.key === 't' || e.key === 'T') && !meta) this._setTool('shape-textbox');
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._deleteSelected(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && this.selected.size) {
        e.preventDefault();
        const movable = this._selectedShapes().filter((s) => !this.isShapeLocked(s));
        if (!movable.length) return; // only locked shapes: nothing to do
        this._pushUndo();
        const step = e.shiftKey ? 16 : C.SNAP;
        movable.forEach((s) => {
          if (e.key === 'ArrowUp') s.y -= step;
          if (e.key === 'ArrowDown') s.y += step;
          if (e.key === 'ArrowLeft') s.x -= step;
          if (e.key === 'ArrowRight') s.x += step;
          this._assignFrame(s);
        });
        this.render();
        this._emit();
      }
    }

    _onKeyUp(e) {
      if (e.code === 'Space') {
        this._spaceDown = false;
        this.els.root.classList.remove('is-space');
      }
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function escapeXml(s) { return escapeHtml(s); }
  function escapeAttr(s) { return escapeHtml(s); }
  function toColor(v, fallback) {
    return /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fallback;
  }

  global.FlowEngine = FlowEngine;

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
    if (html.getAttribute('data-docviewer') !== 'flow') return;
    const host = document.getElementById('accretion-root');
    const dataEl = document.getElementById('flow-data');
    if (!host || !dataEl || typeof FlowEngine !== 'function' || !global.FlowCore) return;
    global.__accretionStandalone = true;
    const engine = new FlowEngine(host, { onChange: function () {} });
    const wrap = '<html data-docviewer="flow"><script type="application/json" id="flow-data">' + dataEl.textContent + '</script></html>';
    engine.loadFromHtml(wrap);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
    else bootStandalone();
  }
})(typeof window !== 'undefined' ? window : this);
