/* DocViewer slides engine — editor, presenter, and standalone export. */
(function (global) {
  const C = global.SlidesCore;
  if (!C) return;

  const DRAG = 4;
  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-2',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h2',
    play: 'M8 5v14l11-7z',
    download: 'M12 4v10M8 10l4 4 4-4M5 20h14',
    help: 'M12 18h.01M9.1 9a3 3 0 1 1 4.2 2.7c-.7.4-1.3 1-1.3 1.8V14',
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function eventEl(target) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    return target.parentElement || null;
  }

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[name] || ICONS.plus) + '"/></svg>';
  }

  function btn(cls, label, iconName, title) {
    const b = el('button', 'sl-btn ' + (cls || ''));
    b.type = 'button';
    if (iconName) {
      const span = el('span');
      span.innerHTML = icon(iconName);
      b.appendChild(span);
    }
    if (label) b.appendChild(el('span', null, label));
    if (title) b.title = title;
    return b;
  }

  function isStandaloneDoc() {
    return document.documentElement.getAttribute('data-accretion') === 'standalone';
  }

  function safeStandaloneName(title, fallback) {
    const base = String(title || fallback || 'deck').replace(/[^\w.-]+/g, '_').slice(0, 60);
    return (base || fallback || 'deck') + '.html';
  }

  class SlidesEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = this.opts.onChange || function () {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this._edit = null;
      this._editBefore = null;
      this._emitTimer = 0;
      this._undo = [];
      this._redo = [];
      this._drag = null;
      this._pending = null;
      this._toastTimer = 0;
      this._present = false;
      this._presentFs = false;
      this._embed = null;
      this._stageToken = 0;
      this._cropDrag = null;
      this._cropBefore = null;
      this._cropEls = null;
      this._cropResize = null;
      this._presentClipTimer = 0;
      this._camTimer = 0;
      this._destroyed = false;
      this._buildDom();
      this._bind();
      this.render();
    }

    static isSlidesHtml(html) { return C.isSlidesHtml(html); }
    static parseHtml(html) { return C.parseHtml(html); }
    static serializeToHtml(data) { return C.serializeToHtml(data); }

    destroy() {
      this._destroyed = true;
      this._leavePresentChrome();
      this._destroyEmbed();
      this._teardownEdit();
      this._unbind();
      clearTimeout(this._emitTimer);
      clearTimeout(this._toastTimer);
      clearTimeout(this._camTimer);
      this.container.innerHTML = '';
      this.container.classList.remove('sl-host');
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      this.els.root.classList.toggle('is-readonly', this.readOnly);
      this.render();
    }

    loadFromHtml(html) {
      this._teardownEdit();
      this.exitPresent();
      this.data = C.parseHtml(html) || C.createEmpty();
      this._undo = [];
      this._redo = [];
      this.render();
    }

    serializeToHtml() {
      return C.serializeToHtml(this.data, this.data.title);
    }

    flushEdit() {
      const e = this._edit;
      if (!e || !e.el || !e.el.isConnected) return;
      this._writeEdit(e, e.el.value);
    }

    commitEdit() {
      const e = this._edit;
      if (!e || !e.el) return;
      if (e.el.isConnected) this._writeEdit(e, e.el.value);
      const before = this._editBefore;
      this._teardownEdit();
      if (before && before !== JSON.stringify(this.data)) this._pushHistory(before);
      this.render();
      this._emit();
    }

    _teardownEdit() {
      clearTimeout(this._emitTimer);
      this._edit = null;
      this._editBefore = null;
    }

    _writeEdit(e, value) {
      if (this.readOnly) return;
      if (e.kind === 'board-title') {
        this.data.title = String(value || '').replace(/\n/g, ' ').slice(0, 120);
        return;
      }
      const slide = this.data.slides[e.index];
      if (!slide) return;
      const v = String(value || '');
      if (e.kind === 'title') slide.title = v.slice(0, C.TITLE_MAX);
      else if (e.kind === 'subtitle') slide.subtitle = v.slice(0, C.TITLE_MAX);
      else if (e.kind === 'body') slide.body = v.slice(0, C.TEXT_MAX);
      else if (e.kind === 'right') slide.right = v.slice(0, C.TEXT_MAX);
      else if (e.kind === 'aside') slide.aside = v.slice(0, C.TEXT_MAX);
      else if (e.kind === 'image') slide.image = C.safeImageSrc(v);
      else if (e.kind === 'notes') slide.notes = v.slice(0, C.NOTES_MAX);
      slide.updatedAt = C.nowIso();
    }

    _bindLiveField(node, kind, getIndex) {
      node.addEventListener('focus', () => {
        if (this.readOnly) return;
        this._edit = { kind, el: node, index: getIndex ? getIndex() : C.currentIndex(this.data) };
        this._editBefore = JSON.stringify(this.data);
      });
      node.addEventListener('input', () => {
        if (this.readOnly) return;
        if (!this._edit || this._edit.el !== node) {
          this._edit = { kind, el: node, index: getIndex ? getIndex() : C.currentIndex(this.data) };
          if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
        }
        this._edit.index = getIndex ? getIndex() : this._edit.index;
        this._writeEdit(this._edit, node.value);
        const cur = C.currentSlide(this.data);
        if (cur && cur.kind === 'title') this._paintStage();
        this._paintThumb(this._edit.index);
        clearTimeout(this._emitTimer);
        this._emitTimer = setTimeout(() => {
          if (!this._destroyed) this._emitLive();
        }, 350);
      });
      node.addEventListener('blur', () => {
        if (this._edit && this._edit.el === node) this.commitEdit();
      });
    }

    _emit() {
      if (this.readOnly) return;
      this.onChange(this.data);
    }

    _emitLive() {
      if (this.readOnly) return;
      this.onChange(this.data);
    }

    _pushHistory(snapshot) {
      this._undo.push(snapshot);
      if (this._undo.length > 100) this._undo.shift();
      this._redo.length = 0;
      this._syncHistory();
    }

    _mutate(fn) {
      if (this.readOnly) return false;
      const before = JSON.stringify(this.data);
      if (fn() === false) return false;
      this.data.updatedAt = C.nowIso();
      if (JSON.stringify(this.data) !== before) this._pushHistory(before);
      this.render();
      this._emit();
      return true;
    }

    _patch(fn) {
      if (this.readOnly) return false;
      const before = JSON.stringify(this.data);
      if (fn() === false) return false;
      this.data.updatedAt = C.nowIso();
      if (JSON.stringify(this.data) !== before) this._pushHistory(before);
      this._syncInspector();
      this._syncHistory();
      this._paintFilmstrip();
      this._emit();
      return true;
    }

    undo() {
      if (this.readOnly || !this._undo.length) return;
      const current = JSON.stringify(this.data);
      const snap = this._undo.pop();
      this._redo.push(current);
      this._applySnapshot(snap);
    }

    redo() {
      if (this.readOnly || !this._redo.length) return;
      const current = JSON.stringify(this.data);
      const snap = this._redo.pop();
      this._undo.push(current);
      this._applySnapshot(snap);
    }

    _applySnapshot(snap) {
      this._teardownEdit();
      try {
        this.data = C.normalize(JSON.parse(snap));
      } catch (e) {
        return;
      }
      this.render();
      this._emit();
    }

    _syncHistory() {
      if (!this.els) return;
      this.els.undoBtn.disabled = this.readOnly || !this._undo.length;
      this.els.redoBtn.disabled = this.readOnly || !this._redo.length;
    }

    _buildDom() {
      this.container.classList.add('sl-host');
      const root = el('div', 'sl-root');
      root.tabIndex = -1;

      const top = el('div', 'sl-top');
      const title = document.createElement('input');
      title.className = 'sl-title';
      title.type = 'text';
      title.placeholder = 'Deck';
      title.setAttribute('aria-label', 'Deck title');
      const stats = el('div', 'sl-stats');
      const theme = el('div', 'sl-zoom');
      theme.setAttribute('aria-label', 'Theme');
      C.THEMES.forEach((t) => {
        const b = btn('', t[0].toUpperCase() + t.slice(1));
        b.dataset.theme = t;
        theme.appendChild(b);
      });
      const ratio = el('div', 'sl-zoom');
      ratio.setAttribute('aria-label', 'Ratio');
      [['16x9', '16:9'], ['4x3', '4:3']].forEach((pair) => {
        const b = btn('', pair[1]);
        b.dataset.ratio = pair[0];
        ratio.appendChild(b);
      });
      const addBtn = btn('sl-ghost', 'Slide', 'plus', 'Add a custom slide (N)');
      const frameBtn = btn('sl-primary', 'Frame', null, 'Add a frame from a board');
      const dupBtn = btn('sl-ghost', 'Duplicate', null, 'Duplicate slide (⌘D)');
      const delBtn = btn('sl-ghost sl-danger', 'Delete', null, 'Delete slide');
      const presentBtn = btn('sl-ghost', 'Present', 'play', 'Present (P)');
      const undoBtn = btn('sl-ghost sl-icon', '', 'undo', 'Undo');
      const redoBtn = btn('sl-ghost sl-icon', '', 'redo', 'Redo');
      const exportBtn = btn('sl-ghost sl-icon', '', 'download', 'Export');
      const helpBtn = btn('sl-ghost sl-icon', '', 'help', 'Shortcuts (?)');
      top.append(title, stats, el('div', 'sl-spacer'), theme, ratio, frameBtn, addBtn, dupBtn, delBtn, presentBtn, el('div', 'sl-sep'), undoBtn, redoBtn, exportBtn, helpBtn);

      const main = el('div', 'sl-main');
      const film = el('div', 'sl-film');
      const stageWrap = el('div', 'sl-stage-wrap');
      const board = el('div', 'sl-board');
      const count = el('div', 'sl-present-count');
      board.appendChild(count);
      stageWrap.appendChild(board);

      const inspect = el('div', 'sl-inspect');
      const layout = document.createElement('select');
      layout.className = 'sl-input';
      layout.setAttribute('aria-label', 'Layout');
      C.LAYOUTS.forEach((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = C.LAYOUT_LABEL[id] || id;
        layout.appendChild(opt);
      });
      const layoutField = el('label', 'sl-field');
      layoutField.append(el('span', null, 'Layout'), layout);
      const slideTitle = document.createElement('input');
      slideTitle.className = 'sl-input';
      slideTitle.type = 'text';
      const titleField = el('label', 'sl-field');
      titleField.append(el('span', null, 'Title'), slideTitle);
      const subtitle = document.createElement('input');
      subtitle.className = 'sl-input';
      subtitle.type = 'text';
      const subField = el('label', 'sl-field');
      subField.append(el('span', null, 'Subtitle'), subtitle);
      const body = document.createElement('textarea');
      const bodyField = el('label', 'sl-field');
      bodyField.append(el('span', null, 'Body'), body);
      const right = document.createElement('textarea');
      const rightField = el('label', 'sl-field');
      rightField.append(el('span', null, 'Right column'), right);
      const aside = document.createElement('textarea');
      const asideField = el('label', 'sl-field');
      asideField.append(el('span', null, 'Third column'), aside);
      const image = document.createElement('input');
      image.className = 'sl-input';
      image.type = 'text';
      image.placeholder = 'https://… or drop a file';
      const imagePick = btn('sl-ghost', 'Choose image');
      const imageFile = document.createElement('input');
      imageFile.type = 'file';
      imageFile.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
      imageFile.className = 'sl-file';
      const imageField = el('div', 'sl-field');
      imageField.append(el('span', null, 'Image'), image, imagePick);
      imageField.appendChild(imageFile);
      const notes = document.createElement('textarea');
      notes.className = 'sl-notes';
      const notesField = el('label', 'sl-field');
      notesField.append(el('span', null, 'Speaker notes'), notes);
      const cropTools = el('div', 'sl-crop-tools');
      const fitBtn = btn('sl-primary', 'Fit to frame', null, 'Zoom the board so the source frame fills the window');
      const resetCropBtn = btn('sl-ghost', 'Reset window');
      const zoomInBtn = btn('sl-ghost', '+');
      const zoomOutBtn = btn('sl-ghost', '–');
      const presentLook = el('div', 'sl-zoom sl-present-look');
      const frameLookBtn = btn('', 'Frame fill');
      frameLookBtn.dataset.grid = '0';
      const gridLookBtn = btn('', 'Board grid');
      gridLookBtn.dataset.grid = '1';
      presentLook.append(frameLookBtn, gridLookBtn);
      cropTools.append(
        el('span', null, 'Visible window'),
        el('p', 'sl-crop-help', 'Drag on the board to select what presents. Resize the window or zoom the board. Fit to frame fills the window with the source frame.'),
        fitBtn, resetCropBtn, zoomInBtn, zoomOutBtn,
        el('span', null, 'In present'),
        el('p', 'sl-crop-help', 'Frame fill hides the editor grid. Board grid hides the frame and shows the grid.'),
        presentLook
      );
      inspect.append(layoutField, titleField, subField, bodyField, rightField, asideField, imageField, cropTools, notesField);

      const print = el('div', 'sl-print');
      main.append(film, stageWrap, inspect);
      const menu = el('div', 'sl-menu');
      const toast = el('div', 'sl-toast');
      const help = el('div', 'sl-help');
      const panel = el('div', 'sl-help-panel');
      panel.appendChild(el('h3', null, 'Slides shortcuts'));
      ['N new slide', 'F add frame', 'Drag a window on a frame slide', 'Fit to frame from the inspector', '⌘D duplicate', 'P present', 'Esc exit present', '← → change slide', 'Delete remove slide', '⌘Z undo', '? help'].forEach((line) => {
        panel.appendChild(el('p', null, line));
      });
      const helpClose = btn('sl-ghost', 'Close');
      panel.appendChild(helpClose);
      help.appendChild(panel);
      helpClose.addEventListener('click', () => help.classList.remove('open'));

      root.append(top, main, print, menu, toast, help);
      this.container.appendChild(root);
      this.els = {
        root, title, stats, theme, ratio, addBtn, frameBtn, dupBtn, delBtn, presentBtn, undoBtn, redoBtn, exportBtn, helpBtn,
        film, stageWrap, board, count, inspect, layout, slideTitle, subtitle, body, right, aside, image, imagePick, imageFile, notes,
        titleField, subField, bodyField, rightField, asideField, imageField, cropTools, fitBtn, resetCropBtn, zoomInBtn, zoomOutBtn,
        frameLookBtn, gridLookBtn, presentLook,
        print, menu, toast, help,
      };
    }

    _bind() {
      const e = this.els;
      this._onKey = (ev) => this._handleKey(ev);
      this._onMove = (ev) => this._onDragMove(ev);
      this._onUp = (ev) => this._onDragEnd(ev);
      this._onDocDown = (ev) => {
        if (!e.menu.contains(ev.target)) this._closeMenu();
      };
      this._onAfterPrint = () => e.root.classList.remove('is-print');
      this._onFs = () => {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        if (this._present && this._presentFs && !active) this.exitPresent();
        else if (this._present) {
          requestAnimationFrame(() => this._applyPresentWindow(C.currentSlide(this.data)));
        }
      };
      document.addEventListener('keydown', this._onKey, true);
      document.addEventListener('pointerdown', this._onDocDown, true);
      document.addEventListener('fullscreenchange', this._onFs);
      document.addEventListener('webkitfullscreenchange', this._onFs);
      window.addEventListener('afterprint', this._onAfterPrint);
      this._bindLiveField(e.title, 'board-title', () => 0);
      e.title.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          e.title.blur();
        }
      });
      e.theme.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-theme]');
        if (!b || this.readOnly) return;
        this._mutate(() => C.setTheme(this.data, b.dataset.theme));
      });
      e.ratio.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-ratio]');
        if (!b || this.readOnly) return;
        this._mutate(() => C.setRatio(this.data, b.dataset.ratio));
      });
      e.addBtn.addEventListener('click', () => this.addSlide());
      e.frameBtn.addEventListener('click', () => this._openFramePicker());
      e.dupBtn.addEventListener('click', () => this.duplicateSlide());
      e.delBtn.addEventListener('click', () => this.deleteSlide());
      e.presentBtn.addEventListener('click', () => this.enterPresent());
      e.undoBtn.addEventListener('click', () => this.undo());
      e.redoBtn.addEventListener('click', () => this.redo());
      e.exportBtn.addEventListener('click', () => this._openExportMenu(e.exportBtn));
      e.helpBtn.addEventListener('click', () => e.help.classList.toggle('open'));
      e.layout.addEventListener('change', () => {
        if (this.readOnly) return;
        this._mutate(() => C.setLayout(this.data, C.currentIndex(this.data), e.layout.value));
      });
      this._bindLiveField(e.slideTitle, 'title', () => C.currentIndex(this.data));
      this._bindLiveField(e.subtitle, 'subtitle', () => C.currentIndex(this.data));
      this._bindLiveField(e.body, 'body', () => C.currentIndex(this.data));
      this._bindLiveField(e.right, 'right', () => C.currentIndex(this.data));
      this._bindLiveField(e.aside, 'aside', () => C.currentIndex(this.data));
      this._bindLiveField(e.notes, 'notes', () => C.currentIndex(this.data));
      e.fitBtn.addEventListener('click', () => this._fitToFrame());
      e.resetCropBtn.addEventListener('click', () => this._resetCrop());
      e.zoomInBtn.addEventListener('click', () => this._nudgeZoom(1.15));
      e.zoomOutBtn.addEventListener('click', () => this._nudgeZoom(1 / 1.15));
      e.presentLook.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-grid]');
        if (!b || this.readOnly) return;
        this._patch(() => C.setShowGrid(this.data, C.currentIndex(this.data), b.dataset.grid === '1'));
      });
      e.image.addEventListener('blur', () => this._commitImageUrl(e.image.value));
      e.image.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          e.image.blur();
        }
      });
      e.imagePick.addEventListener('click', () => {
        if (this.readOnly) return;
        e.imageFile.click();
      });
      e.imageFile.addEventListener('change', () => {
        const file = e.imageFile.files && e.imageFile.files[0];
        e.imageFile.value = '';
        if (file) this._setImageFile(file);
      });
      e.film.addEventListener('pointerdown', (ev) => this._onFilmPointerDown(ev));
      e.film.addEventListener('click', (ev) => this._onFilmClick(ev));
      e.stageWrap.addEventListener('click', () => {
        if (this._present) this.next();
      });
      e.help.addEventListener('click', (ev) => {
        if (ev.target === e.help) e.help.classList.remove('open');
      });
    }

    _unbind() {
      document.removeEventListener('keydown', this._onKey, true);
      document.removeEventListener('pointerdown', this._onDocDown, true);
      document.removeEventListener('fullscreenchange', this._onFs);
      document.removeEventListener('webkitfullscreenchange', this._onFs);
      window.removeEventListener('afterprint', this._onAfterPrint);
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointermove', this._onCropMove);
      window.removeEventListener('pointerup', this._onCropUp);
    }

    render() {
      if (this._destroyed) return;
      const e = this.els;
      const idx = C.currentIndex(this.data);
      const n = this.data.slides.length;
      if (document.activeElement !== e.title) e.title.value = this.data.title || '';
      e.title.readOnly = this.readOnly;
      e.stats.textContent = (idx + 1) + ' / ' + n;
      e.root.classList.toggle('is-4x3', this.data.ratio === '4x3');
      e.root.classList.toggle('is-present', this._present);
      e.root.classList.toggle('is-present-grid', this._present && C.showsPresentGrid(C.currentSlide(this.data)));
      e.root.classList.toggle('is-readonly', this.readOnly);
      e.theme.querySelectorAll('[data-theme]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.theme === this.data.theme);
      });
      e.ratio.querySelectorAll('[data-ratio]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.ratio === this.data.ratio);
      });
      [e.addBtn, e.frameBtn, e.dupBtn, e.delBtn].forEach((b) => {
        b.disabled = this.readOnly;
      });
      e.delBtn.disabled = this.readOnly || n <= 1;
      e.layout.disabled = this.readOnly;
      this._syncPresentBoardSize();
      this._paintFilmstrip();
      this._paintStage();
      this._syncInspector();
      this._syncHistory();
    }

    _syncPresentBoardSize() {
      const wrap = this.els && this.els.stageWrap;
      const board = this.els && this.els.board;
      if (!wrap || !board) return;
      if (!this._present) {
        board.style.width = '';
        board.style.height = '';
        board.style.maxHeight = '';
        return;
      }
      const rw = wrap.clientWidth;
      const rh = wrap.clientHeight;
      const ratio = this.data.ratio === '4x3' ? 4 / 3 : 16 / 9;
      let w = rw;
      let h = rw / ratio;
      if (h > rh) {
        h = rh;
        w = rh * ratio;
      }
      board.style.width = Math.max(8, w) + 'px';
      board.style.height = Math.max(8, h) + 'px';
      board.style.maxHeight = 'none';
    }

    _paintFilmstrip() {
      const film = this.els.film;
      const idx = C.currentIndex(this.data);
      film.innerHTML = '';
      this.data.slides.forEach((slide, i) => {
        const thumb = el('button', 'sl-thumb' + (i === idx ? ' is-on' : '') + (slide.kind !== 'title' ? ' is-frame' : ''));
        thumb.type = 'button';
        thumb.dataset.index = String(i);
        if (slide.kind === 'title') {
          const mini = this._slidePage(slide, 'sl-thumb-mini', false);
          mini.style.width = '320px';
          mini.style.height = this.data.ratio === '4x3' ? '240px' : '180px';
          mini.style.transform = 'scale(0.44)';
          thumb.append(mini, el('span', 'sl-thumb-num', String(i + 1)));
        } else {
          const body = el('div', 'sl-thumb-frame');
          body.append(
            el('em', null, slide.board || 'board'),
            el('strong', null, C.slideLabel(slide)),
            el('span', null, slide.path || '')
          );
          if (!C.isFullCrop(slide.crop)) body.appendChild(el('span', 'sl-thumb-crop', 'Window'));
          if (slide.showGrid) body.appendChild(el('span', 'sl-thumb-crop', 'Grid'));
          thumb.append(body, el('span', 'sl-thumb-num', String(i + 1)));
        }
        film.appendChild(thumb);
      });
    }

    _paintThumb(index) {
      this._paintFilmstrip();
    }

    _destroyEmbed() {
      if (this._embed && typeof this._embed.destroy === 'function') {
        try { this._embed.destroy(); } catch (err) { /* ignore */ }
      }
      this._embed = null;
      this._cropEls = null;
      this._cropDrag = null;
      if (this._cropResize) {
        try { this._cropResize.disconnect(); } catch (err) { /* ignore */ }
        this._cropResize = null;
      }
      clearTimeout(this._presentClipTimer);
    }

    _paintStage() {
      const token = ++this._stageToken;
      const e = this.els;
      const slide = C.currentSlide(this.data);
      const idx = C.currentIndex(this.data);
      e.board.className = 'sl-board is-' + (this.data.theme || 'light');
      e.count.textContent = (idx + 1) + ' / ' + this.data.slides.length;
      this._destroyEmbed();
      e.board.innerHTML = '';
      if (!slide) {
        e.board.append(el('div', 'sl-page', 'No slide'), e.count);
        return;
      }
      if (slide.kind === 'title') {
        e.board.append(this._slidePage(slide, '', this._canLiveEdit()), e.count);
        return;
      }
      const shell = el('div', 'sl-embed-shell');
      const host = el('div', 'sl-embed is-' + (slide.board || 'board'));
      const pending = el('div', 'sl-embed-wait', 'Loading ' + (slide.board || 'board') + '…');
      host.appendChild(pending);
      shell.appendChild(host);
      e.board.append(shell, e.count);
      this._cropEls = { shell, host };
      this._loadBoardSlide(slide, host, token);
    }

    _engineFor(board) {
      if (board === 'mindmap') return global.MindmapEngine;
      if (board === 'flow') return global.FlowEngine;
      if (board === 'gantt') return global.GanttEngine;
      return null;
    }

    async _ensureBoard(board) {
      if (this._engineFor(board)) return;
      const load = (src, flag, ready) => new Promise((resolve, reject) => {
        const existing = document.querySelector('script[' + flag + ']');
        if (existing) {
          if (ready()) return resolve();
          existing.addEventListener('load', () => ready() ? resolve() : reject(new Error('missing API')));
          existing.addEventListener('error', () => reject(new Error('failed')));
          return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.setAttribute(flag, '1');
        s.onload = () => ready() ? resolve() : reject(new Error('missing API'));
        s.onerror = () => reject(new Error('failed ' + src));
        document.body.appendChild(s);
      });
      const css = (href, flag) => {
        let link = document.querySelector('link[' + flag + ']');
        if (!link) {
          link = document.createElement('link');
          link.rel = 'stylesheet';
          link.setAttribute(flag, '1');
          document.head.appendChild(link);
        }
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      };
      if (board === 'mindmap') {
        css('/mindmap/engine.css?v=94', 'data-mm-css');
        await load('/mindmap/engine.js?v=122', 'data-mm-js', () => typeof global.MindmapEngine === 'function');
      } else if (board === 'flow') {
        css('/flow/engine.css?v=23', 'data-fl-css');
        await load('/flow/core.js?v=20', 'data-fl-core', () => !!global.FlowCore);
        await load('/flow/engine.js?v=34', 'data-fl-js', () => typeof global.FlowEngine === 'function');
      } else if (board === 'gantt') {
        css('/gantt/engine.css?v=18', 'data-gt-css');
        await load('/gantt/core.js?v=7', 'data-gt-core', () => !!global.GanttCore);
        await load('/gantt/engine.js?v=23', 'data-gt-js', () => typeof global.GanttEngine === 'function');
      }
    }

    async _loadBoardSlide(slide, host, token) {
      try {
        await this._ensureBoard(slide.board);
        const res = await fetch('/api/file?path=' + encodeURIComponent(slide.path));
        const data = await res.json();
        if (token !== this._stageToken || this._destroyed) return;
        if (!res.ok) throw new Error(data.error || 'Could not open board');
        const Engine = this._engineFor(slide.board);
        if (typeof Engine !== 'function') throw new Error('Board engine missing');
        host.innerHTML = '';
        this._embed = new Engine(host, { readOnly: true, onChange: function () {} });
        this._embed.loadFromHtml(data.content);
        if (typeof this._embed.setReadOnly === 'function') this._embed.setReadOnly(true);
        this._setupCrop(slide);
        const runFocus = () => {
          if (token !== this._stageToken || this._destroyed || !this._embed) return;
          if (this._present) {
            this._applyPresentWindow(slide);
            return;
          }
          if (!this._applyCam(slide)) {
            if (slide.frameId && typeof this._embed.focusFrame === 'function') {
              this._embed.focusFrame(slide.frameId);
            } else if (typeof this._embed.fitView === 'function') {
              this._embed.fitView(false);
            }
            this._captureCam(true);
          }
          requestAnimationFrame(() => {
            if (token !== this._stageToken || this._destroyed) return;
            this._syncCropOverlay();
          });
        };
        requestAnimationFrame(() => requestAnimationFrame(runFocus));
      } catch (err) {
        if (token !== this._stageToken || this._destroyed) return;
        host.innerHTML = '';
        const fail = el('div', 'sl-embed-wait');
        fail.append(
          el('strong', null, 'Could not open that board'),
          el('p', null, (err && err.message) || String(err)),
          el('p', null, slide.path || '')
        );
        host.appendChild(fail);
      }
    }

    _applyCam(slide) {
      const vp = this._embed && this._embed.data && this._embed.data.viewport;
      if (!vp || !slide.cam) return false;
      vp.x = slide.cam.x;
      vp.y = slide.cam.y;
      vp.zoom = slide.cam.zoom;
      if (typeof this._embed._applyTransform === 'function') this._embed._applyTransform();
      return true;
    }

    _captureCam(silent) {
      const slide = C.currentSlide(this.data);
      const vp = this._embed && this._embed.data && this._embed.data.viewport;
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board') || !vp) return;
      slide.cam = C.normalizeCam({
        x: vp.x,
        y: vp.y,
        zoom: vp.zoom,
        cw: canvas && canvas.clientWidth,
        ch: canvas && canvas.clientHeight,
      });
      slide.updatedAt = C.nowIso();
      this.data.updatedAt = C.nowIso();
      if (!silent) {
        clearTimeout(this._camTimer);
        this._camTimer = setTimeout(() => {
          if (!this._destroyed) this._emitLive();
        }, 280);
      }
    }

    _boardWorldRect(slide) {
      const d = this._embed && this._embed.data;
      if (!d) return null;
      if (slide.frameId && Array.isArray(d.frames)) {
        const f = d.frames.find((x) => x.id === slide.frameId);
        if (f) return { x: f.x, y: f.y, w: f.w, h: f.h };
      }
      if (typeof this._embed.contentBounds === 'function') {
        const b = this._embed.contentBounds();
        if (b && b.w) return b;
      }
      if (global.FlowCore && typeof global.FlowCore.contentBounds === 'function' && d.shapes) {
        const b = global.FlowCore.contentBounds(d);
        if (b && b.w) return b;
      }
      return null;
    }

    _setupCrop(slide) {
      const shell = this._cropEls && this._cropEls.shell;
      const host = this._cropEls && this._cropEls.host;
      if (!shell || !host || !slide) return;
      if (this._present) {
        this._watchPresentShell(shell);
        return;
      }
      this._clearPresentClip();
      let layer = shell.querySelector('.sl-crop-layer');
      if (layer) layer.remove();
      layer = el('div', 'sl-crop-layer');
      const win = el('div', 'sl-crop-win');
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
        const handle = el('span', 'sl-crop-h is-' + h);
        handle.dataset.handle = h;
        win.appendChild(handle);
      });
      const hint = el('div', 'sl-crop-hint', 'Drag to select the visible region');
      layer.append(win, hint);
      shell.appendChild(layer);
      this._cropEls.layer = layer;
      this._cropEls.win = win;
      this._cropEls.hint = hint;
      this._syncCropOverlay();
      layer.addEventListener('pointerdown', (ev) => this._onCropDown(ev));
      layer.addEventListener('wheel', (ev) => this._onCropWheel(ev), { passive: false });
    }

    _clearPresentClip() {
      const host = this._cropEls && this._cropEls.host;
      const shell = this._cropEls && this._cropEls.shell;
      if (!host || !shell) return;
      host.style.position = 'absolute';
      host.style.left = '0';
      host.style.top = '0';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.transform = '';
      host.style.transformOrigin = '0 0';
      host.style.clipPath = '';
      host.style.webkitClipPath = '';
      shell.classList.remove('is-present-clip');
    }

    _canvasOffsetInHost() {
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      const host = this._cropEls && this._cropEls.host;
      if (!canvas || !host) return { x: 0, y: 0 };
      let x = 0;
      let y = 0;
      let node = canvas;
      while (node && node !== host) {
        x += node.offsetLeft || 0;
        y += node.offsetTop || 0;
        node = node.parentElement;
      }
      return { x, y };
    }

    _worldToShellRect(world) {
      const vp = this._embed && this._embed.data && this._embed.data.viewport;
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      const shell = this._cropEls && this._cropEls.shell;
      if (!world || world.w < 4 || world.h < 4 || !vp || !canvas || !shell) return null;
      const sw = shell.clientWidth;
      const sh = shell.clientHeight;
      if (sw < 8 || sh < 8) return null;
      const off = this._canvasOffsetInHost();
      const left = off.x + world.x * vp.zoom + vp.x;
      const top = off.y + world.y * vp.zoom + vp.y;
      return {
        x: left / sw,
        y: top / sh,
        w: (world.w * vp.zoom) / sw,
        h: (world.h * vp.zoom) / sh,
      };
    }

    _cropToWorld(slide) {
      const crop = C.normalizeCrop(slide && slide.crop);
      const cam = slide && slide.cam;
      if (!cam || !(cam.cw > 0) || !(cam.ch > 0) || !cam.zoom) return null;
      return {
        x: (crop.x * cam.cw - cam.x) / cam.zoom,
        y: (crop.y * cam.ch - cam.y) / cam.zoom,
        w: crop.w * cam.cw / cam.zoom,
        h: crop.h * cam.ch / cam.zoom,
      };
    }

    _presentWorld(slide) {
      if (!slide) return null;
      const stored = C.normalizeCrop(slide.crop);
      if (C.isFullCrop(stored)) return this._boardWorldRect(slide);
      return this._cropToWorld(slide) || this._boardWorldRect(slide);
    }

    _fitWorldToCanvas(world) {
      const vp = this._embed && this._embed.data && this._embed.data.viewport;
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      if (!vp || !canvas || !world || world.w < 1 || world.h < 1) return false;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw < 8 || ch < 8) return false;
      vp.zoom = C.clamp(Math.min(cw / world.w, ch / world.h), 0.05, 8);
      vp.x = (cw - world.w * vp.zoom) / 2 - world.x * vp.zoom;
      vp.y = (ch - world.h * vp.zoom) / 2 - world.y * vp.zoom;
      if (typeof this._embed._applyTransform === 'function') this._embed._applyTransform();
      return true;
    }

    _watchPresentShell(shell) {
      if (typeof ResizeObserver !== 'function') return;
      if (this._cropResize) {
        try { this._cropResize.disconnect(); } catch (err) { /* ignore */ }
      }
      this._cropResize = new ResizeObserver(() => {
        if (!this._present || this._destroyed) return;
        clearTimeout(this._presentClipTimer);
        this._presentClipTimer = setTimeout(() => {
          this._applyPresentWindow(C.currentSlide(this.data));
        }, 40);
      });
      this._cropResize.observe(shell);
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      if (canvas) this._cropResize.observe(canvas);
    }

    _applyPresentWindow(slide, tries) {
      if (!this._present || !slide || this._destroyed) return;
      this._syncPresentBoardSize();
      this._clearPresentClip();
      const canvas = this._embed && this._embed.els && this._embed.els.canvas;
      if (!canvas || canvas.clientWidth < 8 || canvas.clientHeight < 8) {
        if ((tries || 0) < 24) {
          requestAnimationFrame(() => this._applyPresentWindow(slide, (tries || 0) + 1));
        }
        return;
      }
      const world = this._presentWorld(slide);
      if (world && this._fitWorldToCanvas(world)) {
        const clip = () => {
          if (!this._present || this._destroyed) return;
          this._clearPresentClip();
          this._fitWorldToCanvas(world);
          this._clipPresentRect(this._worldToShellRect(world));
        };
        requestAnimationFrame(() => requestAnimationFrame(clip));
        return;
      }
      this._clipPresentRect(C.normalizeCrop(slide.crop));
    }

    _clipPresentRect(rect) {
      const host = this._cropEls && this._cropEls.host;
      const shell = this._cropEls && this._cropEls.shell;
      if (!host || !shell) return;
      const c = rect || { x: 0, y: 0, w: 1, h: 1 };
      const full = !rect || (c.x <= 0.003 && c.y <= 0.003 && c.w >= 0.996 && c.h >= 0.996);
      shell.style.overflow = 'hidden';
      if (full) return;
      const top = Math.max(0, c.y) * 100;
      const right = Math.max(0, 1 - c.x - c.w) * 100;
      const bottom = Math.max(0, 1 - c.y - c.h) * 100;
      const left = Math.max(0, c.x) * 100;
      const clip = 'inset(' + top + '% ' + right + '% ' + bottom + '% ' + left + '%)';
      host.style.clipPath = clip;
      host.style.webkitClipPath = clip;
      host.style.transform = '';
      shell.classList.add('is-present-clip');
    }

    _applyCropTransform(rect, present) {
      if (present) {
        this._clipPresentRect(rect);
        return;
      }
      this._clearPresentClip();
      const shell = this._cropEls && this._cropEls.shell;
      if (shell) shell.style.overflow = '';
    }

    _syncCropOverlay() {
      const els = this._cropEls;
      const slide = C.currentSlide(this.data);
      if (!els || !els.win || !slide) return;
      const c = C.normalizeCrop(slide.crop);
      els.win.style.left = (c.x * 100) + '%';
      els.win.style.top = (c.y * 100) + '%';
      els.win.style.width = (c.w * 100) + '%';
      els.win.style.height = (c.h * 100) + '%';
      els.win.classList.toggle('is-full', C.isFullCrop(c));
      if (els.hint) els.hint.style.display = C.isFullCrop(c) ? '' : 'none';
    }

    _cropPoint(ev) {
      const shell = this._cropEls && this._cropEls.shell;
      if (!shell) return { x: 0, y: 0 };
      const r = shell.getBoundingClientRect();
      return {
        x: C.clamp((ev.clientX - r.left) / Math.max(r.width, 1), 0, 1),
        y: C.clamp((ev.clientY - r.top) / Math.max(r.height, 1), 0, 1),
      };
    }

    _onCropDown(ev) {
      if (this.readOnly || this._present || ev.button !== 0) return;
      const handle = ev.target.closest && ev.target.closest('[data-handle]');
      const onWin = ev.target.closest && ev.target.closest('.sl-crop-win');
      const p = this._cropPoint(ev);
      const slide = C.currentSlide(this.data);
      if (!slide) return;
      ev.preventDefault();
      this._cropBefore = JSON.stringify(this.data);
      if (handle) {
        this._cropDrag = { kind: 'resize', handle: handle.dataset.handle, start: p, crop: C.normalizeCrop(slide.crop) };
      } else if (onWin && !C.isFullCrop(slide.crop)) {
        this._cropDrag = { kind: 'move', start: p, crop: C.normalizeCrop(slide.crop) };
      } else {
        this._cropDrag = { kind: 'draw', start: p };
      }
      window.addEventListener('pointermove', this._onCropMove);
      window.addEventListener('pointerup', this._onCropUp);
    }

    _onCropMove = (ev) => {
      const drag = this._cropDrag;
      const slide = C.currentSlide(this.data);
      if (!drag || !slide) return;
      const p = this._cropPoint(ev);
      if (drag.kind === 'draw') {
        const x0 = Math.min(drag.start.x, p.x);
        const y0 = Math.min(drag.start.y, p.y);
        const x1 = Math.max(drag.start.x, p.x);
        const y1 = Math.max(drag.start.y, p.y);
        const w = Math.max(x1 - x0, 0.12);
        const h = Math.max(y1 - y0, 0.12);
        slide.crop = C.normalizeCrop({ x: x0, y: y0, w, h });
      } else if (drag.kind === 'move') {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        slide.crop = C.normalizeCrop({
          x: drag.crop.x + dx,
          y: drag.crop.y + dy,
          w: drag.crop.w,
          h: drag.crop.h,
        });
      } else if (drag.kind === 'resize') {
        slide.crop = this._resizeCrop(drag.crop, drag.handle, p);
      }
      this._syncCropOverlay();
    };

    _onCropUp = () => {
      window.removeEventListener('pointermove', this._onCropMove);
      window.removeEventListener('pointerup', this._onCropUp);
      const slide = C.currentSlide(this.data);
      if (slide) {
        slide.crop = C.normalizeCrop(slide.crop);
        slide.updatedAt = C.nowIso();
        this.data.updatedAt = C.nowIso();
      }
      if (this._cropBefore && this._cropBefore !== JSON.stringify(this.data)) {
        this._pushHistory(this._cropBefore);
        this._paintFilmstrip();
        this._emit();
      }
      this._cropDrag = null;
      this._cropBefore = null;
      this._syncCropOverlay();
    };

    _resizeCrop(src, handle, p) {
      return C.resizeCrop(src, handle, p);
    }

    _onCropWheel(ev) {
      ev.preventDefault();
      if (!this._embed || !this._embed.data || !this._embed.data.viewport) return;
      if (typeof this._embed._onWheel === 'function') {
        this._embed._onWheel(ev);
      } else {
        const vp = this._embed.data.viewport;
        vp.y -= ev.deltaY;
        vp.x -= ev.deltaX || 0;
        if (typeof this._embed._applyTransform === 'function') this._embed._applyTransform();
      }
      this._captureCam();
    }

    _nudgeZoom(factor) {
      if (this.readOnly || !this._embed || !this._embed.data || !this._embed.data.viewport) return;
      const vp = this._embed.data.viewport;
      if (typeof this._embed.setZoom === 'function') {
        this._embed.setZoom(vp.zoom * factor);
      } else {
        vp.zoom = C.clamp(vp.zoom * factor, 0.05, 8);
        if (typeof this._embed._applyTransform === 'function') this._embed._applyTransform();
      }
      this._captureCam();
    }

    _resetCrop() {
      const slide = C.currentSlide(this.data);
      if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board')) return;
      this._patch(() => {
        slide.crop = C.defaultCrop();
        slide.updatedAt = C.nowIso();
      });
      this._syncCropOverlay();
      this._applyCropTransform(slide.crop, false);
    }

    _fitToFrame() {
      const slide = C.currentSlide(this.data);
      if (!slide || (slide.kind !== 'frame' && slide.kind !== 'board') || !this._embed) return;
      const world = this._boardWorldRect(slide);
      const vp = this._embed.data && this._embed.data.viewport;
      const canvas = this._embed.els && this._embed.els.canvas;
      const shell = this._cropEls && this._cropEls.shell;
      if (!vp || !canvas || !shell) {
        this._toast('Could not fit that board');
        return;
      }
      this._cropBefore = JSON.stringify(this.data);
      if (C.isFullCrop(slide.crop)) {
        slide.crop = C.normalizeCrop({ x: 0.06, y: 0.06, w: 0.88, h: 0.88 });
      }
      const crop = C.normalizeCrop(slide.crop);
      if (world && world.w > 0 && world.h > 0) {
        const shellR = shell.getBoundingClientRect();
        const canvasR = canvas.getBoundingClientRect();
        const ox = canvasR.left - shellR.left;
        const oy = canvasR.top - shellR.top;
        const cropPx = {
          x: crop.x * shellR.width,
          y: crop.y * shellR.height,
          w: crop.w * shellR.width,
          h: crop.h * shellR.height,
        };
        const z = Math.max(0.08, Math.min(cropPx.w / world.w, cropPx.h / world.h, 4));
        vp.zoom = z;
        vp.x = cropPx.x + cropPx.w / 2 - (world.x + world.w / 2) * z - ox;
        vp.y = cropPx.y + cropPx.h / 2 - (world.y + world.h / 2) * z - oy;
        if (typeof this._embed._applyTransform === 'function') this._embed._applyTransform();
      } else if (typeof this._embed.fitView === 'function') {
        this._embed.fitView(false);
      } else {
        this._toast('Drag a window on the board to choose what presents');
      }
      this._captureCam(true);
      slide.updatedAt = C.nowIso();
      this.data.updatedAt = C.nowIso();
      if (this._cropBefore !== JSON.stringify(this.data)) this._pushHistory(this._cropBefore);
      this._cropBefore = null;
      this._syncCropOverlay();
      this._paintFilmstrip();
      this._emit();
    }

    _canLiveEdit() {
      return !this.readOnly && !this._present;
    }

    _field(tag, kind, value, ph, live) {
      const n = el(tag, value ? '' : 'is-ph');
      n.dataset.ph = ph || '';
      if (live) {
        n.contentEditable = 'true';
        n.spellcheck = true;
        if (value) n.textContent = value;
        n.addEventListener('focus', () => {
          if (this.readOnly) return;
          this._edit = { kind, el: n, index: C.currentIndex(this.data) };
          this._editBefore = JSON.stringify(this.data);
          n.classList.remove('is-ph');
        });
        n.addEventListener('input', () => {
          if (this.readOnly) return;
          if (!this._edit || this._edit.el !== n) {
            this._edit = { kind, el: n, index: C.currentIndex(this.data) };
            if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
          }
          const text = n.textContent || '';
          n.classList.toggle('is-ph', !text.trim());
          this._writeEdit(this._edit, text);
          this._paintThumb(this._edit.index);
          clearTimeout(this._emitTimer);
          this._emitTimer = setTimeout(() => {
            if (!this._destroyed) this._emitLive();
          }, 350);
        });
        n.addEventListener('blur', () => {
          if (this._edit && this._edit.el === n) this.commitEdit();
        });
        n.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && kind !== 'body' && kind !== 'right') {
            ev.preventDefault();
            n.blur();
          }
        });
      } else if (value) {
        n.textContent = value;
      } else if (ph && !this._present) {
        n.textContent = ph;
        n.classList.add('is-ph');
      }
      return n;
    }

    _photoBlock(slide, live) {
      const wrap = el('div', 'sl-photo-wrap');
      const src = C.safeImageSrc(slide.image);
      if (src) {
        const img = document.createElement('img');
        img.className = 'sl-photo';
        img.alt = slide.title || '';
        img.src = src;
        wrap.appendChild(img);
      } else {
        wrap.classList.add('is-empty');
        wrap.appendChild(el('p', null, live ? 'Drop, paste, or click to add an image' : 'Image'));
      }
      if (live) {
        wrap.tabIndex = 0;
        wrap.addEventListener('click', (ev) => {
          ev.preventDefault();
          this.els.imageFile.click();
        });
        this._bindImageDrop(wrap);
      }
      return wrap;
    }

    _listBlock(slide, live, numbered) {
      const lines = numbered ? C.numberLines(slide.body) : C.bulletLines(slide.body);
      if (live) {
        const n = this._field('p', 'body', slide.body, numbered ? 'One step per line' : 'One bullet per line', true);
        n.classList.add('sl-bullets-edit');
        return n;
      }
      const list = el(numbered ? 'ol' : 'ul');
      if (lines.length) lines.forEach((line) => list.appendChild(el('li', null, line)));
      else if (!this._present) list.appendChild(el('li', 'is-ph', numbered ? 'One step per line' : 'One bullet per line'));
      return list;
    }

    _slidePage(slide, extraClass, live) {
      const page = el('div', 'sl-page is-' + slide.layout + (extraClass ? ' ' + extraClass : ''));
      const layout = slide.layout;
      const on = !!live;
      if (layout === 'section') {
        page.append(el('div', 'sl-kicker', 'Section'), this._field('h1', 'title', slide.title, 'Section title', on));
        return page;
      }
      if (layout === 'statement') {
        const kick = this._field('div', 'subtitle', slide.subtitle, 'Kicker', on);
        kick.classList.add('sl-kicker');
        page.append(kick, this._field('h1', 'title', slide.title, 'Statement', on));
        return page;
      }
      if (layout === 'quote') {
        page.appendChild(this._field('blockquote', 'title', slide.title, 'Quote', on));
        page.appendChild(this._field('cite', 'subtitle', slide.subtitle, 'Attribution', on));
        return page;
      }
      if (layout === 'blank') {
        page.appendChild(this._field('p', 'body', slide.body, 'Type here', on));
        return page;
      }
      if (layout === 'image') {
        page.appendChild(this._photoBlock(slide, on));
        page.appendChild(this._field('h1', 'title', slide.title, 'Caption', on));
        return page;
      }
      if (layout === 'stats') {
        page.append(
          this._field('h1', 'title', slide.title, '42%', on),
          this._field('h2', 'subtitle', slide.subtitle, 'Label', on),
          this._field('p', 'body', slide.body, 'Context', on)
        );
        return page;
      }
      if (layout === 'photo-left' || layout === 'photo-right') {
        const row = el('div', 'sl-media');
        const text = el('div', 'sl-media-text');
        text.append(
          this._field('h1', 'title', slide.title, 'Title', on),
          this._field('p', 'body', slide.body, 'Body', on)
        );
        const photo = this._photoBlock(slide, on);
        if (layout === 'photo-left') row.append(photo, text);
        else row.append(text, photo);
        page.appendChild(row);
        return page;
      }
      if (layout !== 'blank') {
        page.appendChild(this._field('h1', 'title', slide.title, 'Title', on));
      }
      if (layout === 'title') {
        page.appendChild(this._field('h2', 'subtitle', slide.subtitle, 'Subtitle', on));
      }
      if (layout === 'title-body') {
        page.appendChild(this._field('p', 'body', slide.body, 'Body', on));
      }
      if (layout === 'bullets') page.appendChild(this._listBlock(slide, on, false));
      if (layout === 'agenda' || layout === 'steps') page.appendChild(this._listBlock(slide, on, true));
      if (layout === 'split') {
        const grid = el('div', 'sl-split');
        grid.append(
          this._field('div', 'body', slide.body, 'Left column', on),
          this._field('div', 'right', slide.right, 'Right column', on)
        );
        page.appendChild(grid);
      }
      if (layout === 'compare') {
        const grid = el('div', 'sl-split is-three');
        grid.append(
          this._field('div', 'body', slide.body, 'Column 1', on),
          this._field('div', 'right', slide.right, 'Column 2', on),
          this._field('div', 'aside', slide.aside, 'Column 3', on)
        );
        page.appendChild(grid);
      }
      return page;
    }

    _syncInspector() {
      const e = this.els;
      const slide = C.currentSlide(this.data);
      if (!slide) return;
      const isTitle = slide.kind === 'title';
      const layout = slide.layout;
      e.layout.value = C.LAYOUTS.indexOf(layout) >= 0 ? layout : 'title';
      e.layout.disabled = this.readOnly || !isTitle;
      const titleName = layout === 'quote' ? 'Quote' : layout === 'image' || layout === 'photo-left' || layout === 'photo-right' ? 'Caption' : layout === 'stats' ? 'Number' : layout === 'statement' ? 'Statement' : 'Title';
      e.titleField.querySelector('span').textContent = isTitle ? titleName : 'Label';
      const showTitle = isTitle ? layout !== 'blank' : true;
      const showSub = isTitle && (layout === 'title' || layout === 'quote' || layout === 'statement' || layout === 'stats');
      const showBody = isTitle && (layout === 'title-body' || layout === 'bullets' || layout === 'agenda' || layout === 'steps' || layout === 'split' || layout === 'compare' || layout === 'blank' || layout === 'stats' || layout === 'photo-left' || layout === 'photo-right');
      const showRight = isTitle && (layout === 'split' || layout === 'compare');
      const showAside = isTitle && layout === 'compare';
      const showImage = isTitle && (layout === 'image' || layout === 'photo-left' || layout === 'photo-right');
      e.titleField.style.display = showTitle ? '' : 'none';
      e.subField.style.display = showSub ? '' : 'none';
      e.bodyField.style.display = showBody ? '' : 'none';
      e.rightField.style.display = showRight ? '' : 'none';
      e.asideField.style.display = showAside ? '' : 'none';
      e.imageField.style.display = showImage ? '' : 'none';
      e.cropTools.style.display = isTitle ? 'none' : '';
      e.layout.closest('.sl-field').style.display = isTitle ? '' : 'none';
      e.subField.querySelector('span').textContent = layout === 'statement' ? 'Kicker' : layout === 'stats' ? 'Label' : 'Subtitle';
      e.bodyField.querySelector('span').textContent = layout === 'bullets' || layout === 'agenda' || layout === 'steps' ? 'Items (one per line)' : layout === 'split' || layout === 'compare' ? 'Left column' : 'Body';
      e.rightField.querySelector('span').textContent = layout === 'compare' ? 'Middle column' : 'Right column';
      let source = e.inspect.querySelector('.sl-source');
      if (!source) {
        source = el('div', 'sl-field sl-source');
        source.append(el('span', null, 'Source'), el('p', 'sl-source-path'));
        e.inspect.insertBefore(source, e.cropTools);
      }
      source.style.display = isTitle ? 'none' : '';
      source.querySelector('.sl-source-path').textContent = isTitle ? '' : ((slide.board || '') + ' · ' + (slide.path || '') + (slide.frameId ? ' · ' + slide.frameId : ''));
      const active = document.activeElement;
      if (active !== e.slideTitle) e.slideTitle.value = slide.title || '';
      if (active !== e.subtitle) e.subtitle.value = slide.subtitle || '';
      if (active !== e.body) e.body.value = slide.body || '';
      if (active !== e.right) e.right.value = slide.right || '';
      if (active !== e.aside) e.aside.value = slide.aside || '';
      if (active !== e.image) {
        const img = slide.image || '';
        e.image.value = img.indexOf('data:') === 0 ? '' : img;
        e.image.placeholder = img.indexOf('data:') === 0 ? 'Embedded image' : 'https://… or drop a file';
      }
      if (active !== e.notes) e.notes.value = slide.notes || '';
      [e.slideTitle, e.subtitle, e.body, e.right, e.aside, e.image, e.notes].forEach((n) => {
        n.readOnly = this.readOnly;
      });
      e.imagePick.disabled = this.readOnly;
      [e.fitBtn, e.resetCropBtn, e.zoomInBtn, e.zoomOutBtn, e.frameLookBtn, e.gridLookBtn].forEach((b) => {
        b.disabled = this.readOnly;
      });
      const gridOn = C.showsPresentGrid(slide);
      e.frameLookBtn.classList.toggle('is-on', !gridOn);
      e.gridLookBtn.classList.toggle('is-on', gridOn);
    }

    _onFilmClick(ev) {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      if (this._drag) return;
      const thumb = eventEl(ev.target) && eventEl(ev.target).closest('[data-index]');
      if (!thumb) return;
      const i = Number(thumb.dataset.index);
      if (!Number.isFinite(i) || i === C.currentIndex(this.data)) return;
      C.setIndex(this.data, i);
      this.render();
    }

    _onFilmPointerDown(ev) {
      if (this.readOnly || ev.button !== 0) return;
      const thumb = eventEl(ev.target) && eventEl(ev.target).closest('[data-index]');
      if (!thumb) return;
      this._pending = { index: Number(thumb.dataset.index), x: ev.clientX, y: ev.clientY };
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
    }

    _onDragMove(ev) {
      const p = this._pending;
      if (p && !this._drag) {
        if (Math.abs(ev.clientX - p.x) + Math.abs(ev.clientY - p.y) < DRAG) return;
        this._drag = p;
        this._pending = null;
      }
      if (!this._drag) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const hit = under && eventEl(under) && eventEl(under).closest('.sl-thumb');
      this.els.film.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
      if (hit) hit.classList.add('is-drop');
    }

    _onDragEnd(ev) {
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      const drag = this._drag;
      this._drag = null;
      this._pending = null;
      this.els.film.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
      if (!drag) return;
      this._suppressClick = true;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const hit = under && eventEl(under) && eventEl(under).closest('.sl-thumb');
      if (!hit) return;
      const to = Number(hit.dataset.index);
      if (!Number.isFinite(to) || to === drag.index) return;
      this._mutate(() => C.moveSlide(this.data, drag.index, to));
    }

    addSlide(layout) {
      if (this.readOnly) return;
      if (!layout) {
        this._openLayoutPicker();
        return;
      }
      this._mutate(() => {
        C.addSlide(this.data, C.currentIndex(this.data), layout);
      });
    }

    _openLayoutPicker() {
      if (this.readOnly) return;
      const wrap = el('div', 'sl-dialog open');
      const panel = el('div', 'sl-dialog-panel sl-picker');
      panel.appendChild(el('h3', null, 'Add a slide'));
      panel.appendChild(el('p', null, 'Custom layouts you write here. Use Frame for a board clip.'));
      const grid = el('div', 'sl-layout-grid');
      C.LAYOUTS.forEach((id) => {
        const item = el('button', 'sl-layout-pick');
        item.type = 'button';
        item.append(
          el('strong', null, C.LAYOUT_LABEL[id] || id),
          el('span', null, C.LAYOUT_HINT[id] || '')
        );
        item.addEventListener('click', () => {
          wrap.remove();
          this.addSlide(id);
        });
        grid.appendChild(item);
      });
      panel.appendChild(grid);
      const actions = el('div', 'sl-dialog-actions');
      const cancel = btn('sl-ghost', 'Cancel');
      actions.appendChild(cancel);
      panel.appendChild(actions);
      wrap.appendChild(panel);
      this.els.root.appendChild(wrap);
      cancel.addEventListener('click', () => wrap.remove());
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) wrap.remove();
      });
    }

    _commitImageUrl(raw) {
      if (this.readOnly) return;
      const slide = C.currentSlide(this.data);
      if (!slide || slide.kind !== 'title') return;
      const typed = String(raw || '').trim();
      const next = typed ? C.safeImageSrc(typed) : '';
      if (typed && !next) {
        this._toast('Need an http(s) image URL');
        return;
      }
      if (!typed && (slide.image || '').indexOf('data:') === 0) return;
      if ((slide.image || '') === next) return;
      this._mutate(() => {
        slide.image = next;
        slide.updatedAt = C.nowIso();
      });
    }

    _bindImageDrop(node) {
      node.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        node.classList.add('is-over');
      });
      node.addEventListener('dragleave', () => node.classList.remove('is-over'));
      node.addEventListener('drop', (ev) => {
        ev.preventDefault();
        node.classList.remove('is-over');
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (file) this._setImageFile(file);
      });
      node.addEventListener('paste', (ev) => {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf('image/') === 0) {
            const file = items[i].getAsFile();
            if (file) {
              ev.preventDefault();
              this._setImageFile(file);
              return;
            }
          }
        }
      });
    }

    _setImageFile(file) {
      if (this.readOnly || !file) return;
      if (!/^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/i.test(file.type)) {
        this._toast('Use PNG, JPEG, GIF, WebP, or SVG');
        return;
      }
      if (file.size > 1200000) {
        this._toast('Image is too large (1.2 MB max)');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const src = C.safeImageSrc(String(reader.result || ''));
        if (!src) {
          this._toast('Could not read that image');
          return;
        }
        this._mutate(() => {
          const slide = C.currentSlide(this.data);
          if (!slide || slide.kind !== 'title') return false;
          slide.layout = 'image';
          slide.image = src;
          slide.updatedAt = C.nowIso();
        });
      };
      reader.onerror = () => this._toast('Could not read that image');
      reader.readAsDataURL(file);
    }

    async _openFramePicker() {
      if (this.readOnly) return;
      let boards = [];
      try {
        const res = await fetch('/api/board-frames');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not list frames');
        boards = data.boards || [];
      } catch (err) {
        this._toast((err && err.message) || 'Could not list frames');
        return;
      }
      const wrap = el('div', 'sl-dialog open');
      const panel = el('div', 'sl-dialog-panel sl-picker');
      panel.appendChild(el('h3', null, 'Add a frame'));
      panel.appendChild(el('p', null, 'Pick a mindmap or flow frame, or a Gantt board.'));
      const search = document.createElement('input');
      search.className = 'sl-input';
      search.type = 'search';
      search.placeholder = 'Search boards and frames';
      panel.appendChild(search);
      const list = el('div', 'sl-picker-list');
      panel.appendChild(list);
      const actions = el('div', 'sl-dialog-actions');
      const cancel = btn('sl-ghost', 'Cancel');
      actions.appendChild(cancel);
      panel.appendChild(actions);
      wrap.appendChild(panel);
      this.els.root.appendChild(wrap);
      const close = () => wrap.remove();
      cancel.addEventListener('click', close);
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) close();
      });
      const paint = () => {
        const q = search.value.toLowerCase().trim();
        list.innerHTML = '';
        let n = 0;
        boards.forEach((board) => {
          const frames = (board.frames || []).filter((f) => {
            if (!q) return true;
            return [board.title, board.path, board.kind, f.title].join(' ').toLowerCase().indexOf(q) >= 0;
          });
          if (!frames.length && q && (board.title + board.path).toLowerCase().indexOf(q) < 0) return;
          if (!frames.length && board.kind !== 'gantt') return;
          const group = el('div', 'sl-picker-group');
          group.appendChild(el('div', 'sl-picker-file', (board.kind || '') + ' · ' + (board.path || '')));
          (frames.length ? frames : [{ id: '', title: 'Whole board' }]).forEach((f) => {
            const item = el('button', 'sl-picker-item');
            item.type = 'button';
            item.append(el('strong', null, f.title || 'Frame'), el('span', null, board.title || board.path));
            item.addEventListener('click', () => {
              close();
              this._mutate(() => C.addFrameSlide(this.data, C.currentIndex(this.data), {
                path: board.path,
                board: board.kind,
                frameId: f.id,
                title: f.title || board.title || '',
              }));
            });
            group.appendChild(item);
            n += 1;
          });
          list.appendChild(group);
        });
        if (!n) list.appendChild(el('p', null, 'No frames yet. Draw a frame on a mindmap or flow, then come back.'));
      };
      search.addEventListener('input', paint);
      paint();
      search.focus();
    }

    duplicateSlide() {
      if (this.readOnly) return;
      this._mutate(() => C.duplicateSlide(this.data, C.currentIndex(this.data)));
    }

    async deleteSlide() {
      if (this.readOnly || this.data.slides.length <= 1) return;
      const ok = await this._ask('Delete slide', 'Remove this slide from the deck?', 'Delete');
      if (!ok || this._destroyed) return;
      this._mutate(() => C.deleteSlide(this.data, C.currentIndex(this.data)));
    }

    next() {
      const i = C.currentIndex(this.data);
      if (i >= this.data.slides.length - 1) {
        this._toast('Last slide');
        return;
      }
      C.setIndex(this.data, i + 1);
      this.render();
    }

    prev() {
      const i = C.currentIndex(this.data);
      if (i <= 0) return;
      C.setIndex(this.data, i - 1);
      this.render();
    }

    goToSlide(idOrIndex) {
      const slides = this.data.slides || [];
      let i = -1;
      if (typeof idOrIndex === 'number' && Number.isFinite(idOrIndex)) i = idOrIndex;
      else {
        const key = String(idOrIndex || '');
        i = slides.findIndex((s) => s.id === key);
        if (i < 0 && /^\d+$/.test(key)) i = Number(key) - 1;
      }
      if (i < 0 || i >= slides.length) return;
      C.setIndex(this.data, i);
      this.render();
    }

    enterPresent() {
      this.flushEdit();
      this._present = true;
      this.els.help.classList.remove('open');
      this._closeMenu();
      document.documentElement.classList.add('is-slides-present');
      this.render();
      this.els.root.focus();
      this._requestPresentFullscreen();
    }

    exitPresent() {
      if (!this._present) return;
      this._present = false;
      this._leavePresentChrome();
      this.render();
    }

    _requestPresentFullscreen() {
      const node = this.els && this.els.root;
      if (!node) return;
      const req = node.requestFullscreen || node.webkitRequestFullscreen;
      if (!req) return;
      this._presentFs = true;
      Promise.resolve(req.call(node)).catch(() => {
        this._presentFs = false;
      });
    }

    _leavePresentChrome() {
      document.documentElement.classList.remove('is-slides-present');
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (this._presentFs && active && this.els && this.els.root && (active === this.els.root || this.els.root.contains(active))) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          try { exit.call(document); } catch (err) { /* ignore */ }
        }
      }
      this._presentFs = false;
    }

    _toast(text) {
      const n = this.els.toast;
      n.textContent = text;
      n.classList.add('open');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => n.classList.remove('open'), 1400);
    }

    _closeMenu() {
      this.els.menu.classList.remove('open');
    }

    _menuItem(menu, label, onClick) {
      const item = el('button', 'sl-menu-item', label);
      item.type = 'button';
      item.addEventListener('click', () => {
        this._closeMenu();
        onClick();
      });
      menu.appendChild(item);
    }

    _openExportMenu(anchor) {
      const menu = this.els.menu;
      menu.innerHTML = '';
      menu.appendChild(el('div', 'sl-menu-label', 'Export deck'));
      this._menuItem(menu, 'Standalone HTML', () => this.exportStandalone());
      this._menuItem(menu, 'Print / PDF', () => this.printDeck());
      const box = anchor.getBoundingClientRect();
      const root = this.els.root.getBoundingClientRect();
      menu.style.left = (box.right - root.left - 180) + 'px';
      menu.style.top = (box.bottom - root.top + 6) + 'px';
      menu.classList.add('open');
    }

    printDeck() {
      this.flushEdit();
      const tray = this.els.print;
      tray.innerHTML = '';
      this.data.slides.forEach((slide) => {
        const wrap = el('div', 'sl-print-page sl-board is-' + (this.data.theme || 'light'));
        if (slide.kind === 'title') wrap.appendChild(this._slidePage(slide, '', false));
        else {
          const page = el('div', 'sl-page');
          page.append(
            el('div', 'sl-kicker', slide.board || 'board'),
            el('h1', null, C.slideLabel(slide)),
            el('p', null, slide.path || '')
          );
          wrap.appendChild(page);
        }
        tray.appendChild(wrap);
      });
      this.els.root.classList.add('is-print');
      window.print();
    }

    async exportStandalone(name) {
      this.flushEdit();
      const title = this.data.title || 'Deck';
      const json = JSON.stringify(C.normalize(this.data)).replace(/</g, '\\u003c');
      const html = await buildStandaloneHtml({
        title,
        kind: 'slides',
        dataId: 'slides-data',
        json,
        cssUrls: ['/slides/engine.css'],
        jsUrls: ['/slides/core.js', '/slides/engine.js'],
      });
      downloadStandalone(html, name || safeStandaloneName(title, 'slides'));
    }

    _ask(title, message, confirmLabel) {
      return new Promise((resolve) => {
        const wrap = el('div', 'sl-dialog open');
        const panel = el('div', 'sl-dialog-panel');
        panel.setAttribute('role', 'dialog');
        panel.appendChild(el('h3', null, title));
        if (message) panel.appendChild(el('p', null, message));
        const actions = el('div', 'sl-dialog-actions');
        const cancel = btn('sl-ghost', 'Cancel');
        const ok = btn(confirmLabel === 'Delete' ? 'sl-ghost sl-danger' : 'sl-primary', confirmLabel || 'OK');
        actions.append(cancel, ok);
        panel.appendChild(actions);
        wrap.appendChild(panel);
        this.els.root.appendChild(wrap);
        const done = (value) => {
          document.removeEventListener('keydown', onKey, true);
          wrap.remove();
          resolve(value);
        };
        const onKey = (ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            done(false);
          } else if (ev.key === 'Enter') {
            ev.preventDefault();
            done(true);
          }
        };
        document.addEventListener('keydown', onKey, true);
        wrap.addEventListener('click', (ev) => {
          if (ev.target === wrap) done(false);
        });
        cancel.addEventListener('click', () => done(false));
        ok.addEventListener('click', () => done(true));
      });
    }

    _handleKey(ev) {
      if (this._destroyed) return;
      if (this.els.help.classList.contains('open') && ev.key === 'Escape') {
        this.els.help.classList.remove('open');
        return;
      }
      if (this.els.root.querySelector('.sl-dialog')) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          const dialog = this.els.root.querySelector('.sl-dialog');
          if (dialog) dialog.remove();
        }
        return;
      }
      const active = document.activeElement;
      const typing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.isContentEditable);
      if (this._present) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          this.exitPresent();
          return;
        }
        if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ' || ev.key === 'Enter') {
          ev.preventDefault();
          this.next();
          return;
        }
        if (ev.key === 'ArrowLeft' || ev.key === 'PageUp' || ev.key === 'Backspace') {
          ev.preventDefault();
          this.prev();
          return;
        }
        if (ev.key === 'Home') {
          ev.preventDefault();
          C.setIndex(this.data, 0);
          this.render();
        }
        if (ev.key === 'End') {
          ev.preventDefault();
          C.setIndex(this.data, this.data.slides.length - 1);
          this.render();
        }
        return;
      }
      if (typing) return;
      if (!this.els.root.contains(active) && active !== document.body && this.els.root !== active) {
        if (!this.container.contains(active)) return;
      }
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (meta && ev.key.toLowerCase() === 'd') {
        ev.preventDefault();
        this.duplicateSlide();
        return;
      }
      if (ev.key === 'n' || ev.key === 'N') {
        ev.preventDefault();
        this.addSlide();
        return;
      }
      if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        this._openFramePicker();
        return;
      }
      if (ev.key === 'p' || ev.key === 'P') {
        ev.preventDefault();
        this.enterPresent();
        return;
      }
      if (ev.key === '?' || (ev.key === '/' && ev.shiftKey)) {
        ev.preventDefault();
        this.els.help.classList.toggle('open');
        return;
      }
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        this.next();
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        this.prev();
        return;
      }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && !this.readOnly) {
        ev.preventDefault();
        this.deleteSlide();
      }
    }
  }

  global.SlidesEngine = SlidesEngine;

  function downloadStandalone(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const start = async () => {
      if (!isStandaloneDoc() && location.protocol !== 'file:') {
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          bytes.forEach((b) => { bin += String.fromCharCode(b); });
          const res = await fetch('/api/transient-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: filename, type: 'text/html;charset=utf-8', data: btoa(bin) }),
          });
          if (res.ok) {
            const json = await res.json();
            if (json && json.id) {
              const frame = document.createElement('iframe');
              frame.setAttribute('aria-hidden', 'true');
              frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
              frame.src = '/api/transient-download/' + encodeURIComponent(json.id)
                + '?name=' + encodeURIComponent(filename);
              document.body.appendChild(frame);
              setTimeout(() => frame.remove(), 60000);
              return;
            }
          }
        } catch (err) { /* fall through */ }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    return start();
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
    const standalone = isStandaloneDoc();
    let styles;
    let scripts;
    if (standalone) {
      styles = Array.from(document.querySelectorAll('head style')).map((node) => node.textContent || '');
      scripts = Array.from(document.querySelectorAll('script:not([type="application/json"])')).map((node) => node.textContent || '');
    } else {
      styles = [];
      for (const url of opts.cssUrls) styles.push(await fetchStandaloneAsset(url));
      scripts = [];
      for (const url of opts.jsUrls) scripts.push(await fetchStandaloneAsset(url));
    }
    const title = String(opts.title || 'Deck').replace(/[<>]/g, '');
    return '<!DOCTYPE html>\n<html lang="en" data-theme="light" data-docviewer="' + opts.kind + '" data-accretion="standalone">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + title + '</title>\n<style>html,body,#accretion-root{height:100%;margin:0;overflow:hidden}#accretion-root{position:fixed;inset:0}</style>\n' +
      styles.map((css) => '<style>\n' + css + '\n</style>').join('\n') +
      '\n</head>\n<body>\n<div id="accretion-root"></div>\n<script type="application/json" id="' + opts.dataId + '">\n' + opts.json + '\n</script>\n' +
      scripts.map((js) => '<script>\n' + embedScript(js) + '\n</script>').join('\n') +
      '\n</body>\n</html>\n';
  }

  function bootStandalone() {
    if (global.__accretionStandalone) return;
    const html = document.documentElement;
    if (!html || html.getAttribute('data-accretion') !== 'standalone') return;
    if (html.getAttribute('data-docviewer') !== 'slides') return;
    const host = document.getElementById('accretion-root');
    const dataEl = document.getElementById('slides-data');
    if (!host || !dataEl || typeof SlidesEngine !== 'function' || !global.SlidesCore) return;
    global.__accretionStandalone = true;
    const engine = new SlidesEngine(host, { onChange: function () {} });
    const wrap = '<html data-docviewer="slides"><script type="application/json" id="slides-data">' + dataEl.textContent + '</script></html>';
    engine.loadFromHtml(wrap);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
    else bootStandalone();
  }
})(typeof window !== 'undefined' ? window : this);
