/* DocViewer wiki engine — editor, preview, and backlinks. */
(function (global) {
  const C = global.WikiCore;
  if (!C) return;

  const HISTORY_MAX = 100;
  const ICONS = {
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-2',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h2',
    link: 'M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1',
    help: 'M12 18h.01M9.1 9a3 3 0 1 1 4.2 2.7c-.7.4-1.3 1-1.3 1.8V14',
    edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
    done: 'M5 13l4 4L19 7',
  };

  const KIND_FILTERS = [
    { id: '', label: 'All' },
    { id: 'wiki', label: 'Wiki' },
    { id: 'mindmap', label: 'Mindmap' },
    { id: 'flow', label: 'Flow' },
    { id: 'kanban', label: 'Kanban' },
    { id: 'gantt', label: 'Gantt' },
    { id: 'slides', label: 'Slides' },
    { id: 'json', label: 'JSON' },
    { id: 'yaml', label: 'YAML' },
    { id: 'pdf', label: 'PDF' },
    { id: 'file', label: 'File' },
  ];

  const ITEM_FILTERS = [
    { id: '', label: 'All items' },
    { id: 'file', label: 'Files' },
    { id: 'frame', label: 'Frames' },
    { id: 'card', label: 'Cards' },
    { id: 'task', label: 'Tasks' },
    { id: 'slide', label: 'Slides' },
  ];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[name] || ICONS.link) + '"/></svg>';
  }

  function btn(cls, label, iconName, title) {
    const b = el('button', 'wk-btn ' + (cls || ''));
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

  class WikiEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = this.opts.onChange || function () {};
      this.onOpenPath = this.opts.onOpenPath || null;
      this.onCreatePage = this.opts.onCreatePage || null;
      this.filePath = this.opts.path || '';
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this._pages = [];
      this._undo = [];
      this._redo = [];
      this._emitTimer = 0;
      this._toastTimer = 0;
      this._graphTimer = 0;
      this._editBefore = null;
      this._destroyed = false;
      this.editing = false;
      this.container.classList.add('wk-host');
      this._buildDom();
      this._bind();
      this.render();
      this._loadGraph();
    }

    static isWikiHtml(html) { return C.isWikiHtml(html); }
    static parseHtml(html) { return C.parseHtml(html); }
    static serializeToHtml(data) { return C.serializeToHtml(data); }

    destroy() {
      this._destroyed = true;
      this._unbind();
      clearTimeout(this._emitTimer);
      clearTimeout(this._toastTimer);
      clearTimeout(this._graphTimer);
      this.container.innerHTML = '';
      this.container.classList.remove('wk-host');
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      if (this.readOnly) this.editing = false;
      this.render();
    }

    setEditing(on) {
      if (this.readOnly) on = false;
      if (this.editing && !on) this._commitField();
      this.editing = !!on;
      this.render();
    }

    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.createEmpty();
      this._undo = [];
      this._redo = [];
      this.editing = false;
      this.render();
      this._loadGraph();
    }

    serializeToHtml() {
      this.flushEdit();
      return C.serializeToHtml(this.data, this.data.title);
    }

    flushEdit() {
      const e = this.els;
      if (!e) return;
      this.data.title = C.str(e.title.value, C.TITLE_MAX) || 'New page';
      this.data.body = C.str(e.body.value, C.BODY_MAX);
    }

    commitEdit() {
      this.flushEdit();
      this.data.updatedAt = C.nowIso();
    }

    _buildDom() {
      const root = el('div', 'wk-root');
      root.tabIndex = 0;
      const top = el('div', 'wk-top');
      const title = document.createElement('input');
      title.className = 'wk-title';
      title.type = 'text';
      title.placeholder = 'Page title';
      const editBtn = btn('wk-ghost', 'Edit', 'edit', 'Edit this page');
      const linkBtn = btn('wk-ghost', 'Link', 'link', 'Search files and insert a link');
      const undoBtn = btn('wk-ghost wk-icon wk-edit-only', '', 'undo', 'Undo');
      const redoBtn = btn('wk-ghost wk-icon wk-edit-only', '', 'redo', 'Redo');
      const helpBtn = btn('wk-ghost wk-icon', '', 'help', 'Help');
      top.append(title, editBtn, linkBtn, undoBtn, redoBtn, helpBtn);

      const main = el('div', 'wk-main');
      const editCol = el('div', 'wk-edit-col');
      editCol.appendChild(el('div', 'wk-col-label', 'Write'));
      const body = document.createElement('textarea');
      body.className = 'wk-body';
      body.placeholder = 'Write here. Use [[Page title]] or [[file.html#frame:id]] to link.';
      body.spellcheck = true;
      editCol.appendChild(body);

      const previewCol = el('div', 'wk-preview-col');
      previewCol.appendChild(el('div', 'wk-col-label', 'Preview'));
      const preview = el('div', 'wk-preview');
      const article = el('div', 'wk-article');
      preview.appendChild(article);
      previewCol.appendChild(preview);

      const side = el('div', 'wk-side');
      const backBlock = el('div', 'wk-side-block');
      backBlock.appendChild(el('h3', null, 'Backlinks'));
      const backList = el('div', 'wk-back-list');
      backBlock.appendChild(backList);
      const outBlock = el('div', 'wk-side-block');
      outBlock.appendChild(el('h3', null, 'Outgoing'));
      const outList = el('div', 'wk-out-list');
      outBlock.appendChild(outList);
      side.append(backBlock, outBlock);

      main.append(editCol, previewCol, side);
      const toast = el('div', 'wk-toast');
      const help = el('div', 'wk-help');
      const panel = el('div', 'wk-help-panel');
      panel.appendChild(el('h3', null, 'Wiki shortcuts'));
      [
        'Preview is the default. Edit shows Write and Preview together',
        'Link searches files, frames, cards, tasks, and slides by type',
        '[[file.html#frame:id|label]] jumps to a mindmap or flow frame',
        '[[deck.html#slide:id]] a slide, [[chart.html#task:id]] a Gantt task, [[board.html#card:id]] a card',
        'Missing wiki titles are red — click to create the page',
        'Backlinks list wiki pages that mention this one',
        '# ## ### headings, - bullets, 1. numbered',
        '**bold**, *italic*, `code`',
        '⌘Z undo, ⌘⇧Z redo',
      ].forEach((line) => panel.appendChild(el('p', null, line)));
      const helpClose = btn('wk-ghost', 'Close');
      panel.appendChild(helpClose);
      help.appendChild(panel);
      helpClose.addEventListener('click', () => help.classList.remove('open'));

      root.append(top, main, toast, help);
      this.container.appendChild(root);
      this.els = {
        root, title, body, article, backList, outList, toast, help,
        editBtn, linkBtn, undoBtn, redoBtn, helpBtn,
      };
    }

    _bind() {
      const e = this.els;
      this._onKey = (ev) => this._handleKey(ev);
      document.addEventListener('keydown', this._onKey, true);
      e.title.addEventListener('focus', () => {
        if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
      });
      e.title.addEventListener('input', () => {
        this.data.title = C.str(e.title.value, C.TITLE_MAX) || 'New page';
        this._paintPreview();
        this._paintLinks();
        this._emitLive();
      });
      e.title.addEventListener('blur', () => this._commitField());
      e.body.addEventListener('focus', () => {
        if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
      });
      e.body.addEventListener('input', () => {
        this.data.body = C.str(e.body.value, C.BODY_MAX);
        this._paintPreview();
        this._paintLinks();
        this._emitLive();
      });
      e.body.addEventListener('blur', () => this._commitField());
      e.linkBtn.addEventListener('click', () => {
        if (!this.editing) this.setEditing(true);
        this._openLinkPicker();
      });
      e.editBtn.addEventListener('click', () => this.setEditing(!this.editing));
      e.undoBtn.addEventListener('click', () => this.undo());
      e.redoBtn.addEventListener('click', () => this.redo());
      e.helpBtn.addEventListener('click', () => e.help.classList.toggle('open'));
      e.article.addEventListener('click', (ev) => this._onPreviewClick(ev));
      e.article.addEventListener('dblclick', (ev) => {
        if (this.readOnly || this.editing) return;
        if (ev.target.closest && ev.target.closest('a.wk-link')) return;
        this.setEditing(true);
      });
      this._onVis = () => {
        if (document.visibilityState === 'visible') this._loadGraph();
      };
      document.addEventListener('visibilitychange', this._onVis);
    }

    _unbind() {
      document.removeEventListener('keydown', this._onKey, true);
      document.removeEventListener('visibilitychange', this._onVis);
    }

    _emit() {
      if (this._destroyed) return;
      this.onChange();
    }

    _emitLive() {
      clearTimeout(this._emitTimer);
      this._emitTimer = setTimeout(() => {
        if (!this._destroyed) this._emit();
      }, 350);
    }

    _pushHistory(snapshot) {
      this._undo.push(snapshot);
      if (this._undo.length > HISTORY_MAX) this._undo.shift();
      this._redo.length = 0;
      this._syncHistory();
    }

    _commitField() {
      this.flushEdit();
      this.data.updatedAt = C.nowIso();
      if (this._editBefore && this._editBefore !== JSON.stringify(this.data)) {
        this._pushHistory(this._editBefore);
        this._emit();
      }
      this._editBefore = null;
    }

    _applySnapshot(snap) {
      try {
        this.data = C.normalize(JSON.parse(snap));
      } catch (err) {
        return;
      }
      this.render();
      this._emit();
    }

    undo() {
      if (this.readOnly || !this.editing || !this._undo.length) return;
      this.flushEdit();
      const current = JSON.stringify(this.data);
      const snap = this._undo.pop();
      this._redo.push(current);
      this._applySnapshot(snap);
    }

    redo() {
      if (this.readOnly || !this.editing || !this._redo.length) return;
      this.flushEdit();
      const current = JSON.stringify(this.data);
      const snap = this._redo.pop();
      this._undo.push(current);
      this._applySnapshot(snap);
    }

    _syncHistory() {
      this.els.undoBtn.disabled = this.readOnly || !this.editing || !this._undo.length;
      this.els.redoBtn.disabled = this.readOnly || !this.editing || !this._redo.length;
    }

    _syncChrome() {
      const e = this.els;
      const canEdit = !this.readOnly;
      e.root.classList.toggle('is-readonly', this.readOnly);
      e.root.classList.toggle('is-editing', this.editing && canEdit);
      e.title.readOnly = this.readOnly || !this.editing;
      e.body.readOnly = this.readOnly || !this.editing;
      e.linkBtn.disabled = this.readOnly;
      e.editBtn.disabled = this.readOnly;
      e.editBtn.title = this.editing ? 'Done editing' : 'Edit this page';
      e.editBtn.innerHTML = '';
      const iconWrap = el('span');
      iconWrap.innerHTML = icon(this.editing ? 'done' : 'edit');
      e.editBtn.append(iconWrap, el('span', null, this.editing ? 'Done' : 'Edit'));
    }

    render() {
      if (this._destroyed) return;
      const e = this.els;
      this._syncChrome();
      if (document.activeElement !== e.title) e.title.value = this.data.title || '';
      if (document.activeElement !== e.body) e.body.value = this.data.body || '';
      this._paintPreview();
      this._paintLinks();
      this._syncHistory();
    }

    _pagesForResolve() {
      const pages = (this._pages || []).slice();
      const self = C.pageSummary(this.filePath || '_current.html', this.data);
      const idx = pages.findIndex((p) => C.pathKey(p.path) === C.pathKey(self.path));
      if (idx >= 0) pages[idx] = self;
      else if (self.path) pages.push(self);
      return pages;
    }

    _paintPreview() {
      const html = C.renderHtml(this.data.body, this._pagesForResolve(), this.filePath);
      this.els.article.innerHTML = html || '<p class="wk-empty">Nothing to preview yet.</p>';
    }

    _paintLinks() {
      const pages = this._pagesForResolve();
      const outgoing = C.outgoingLinks(this.data.body, pages, this.filePath);
      const back = C.incomingLinks(this.filePath, this.data.title, pages);
      this._fillLinkList(this.els.outList, outgoing, 'No outgoing links yet. Type [[Page title]] or pick Link.');
      this._fillLinkList(this.els.backList, back, 'No backlinks yet. Other wiki pages that mention this one will show up here.');
    }

    _destOf(item) {
      if (!item) return {};
      return {
        frameId: item.frameId || '',
        slideId: item.slideId || '',
        slideIndex: item.slideIndex,
        taskId: item.taskId || '',
        cardId: item.cardId || '',
      };
    }

    _fillLinkList(list, items, emptyText) {
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el('p', 'wk-side-empty', emptyText));
        return;
      }
      items.forEach((item) => {
        const b = el('button', 'wk-side-item' + (item.missing ? ' is-missing' : ''));
        b.type = 'button';
        const sub = item.missing
          ? (C.looksLikePath(item.target) || (item.target || '').indexOf('#') >= 0
            ? 'Missing file'
            : 'Missing · click to create')
          : [item.anchor ? C.kindLabel(item.anchor) : C.kindLabel(item.kind), item.path].filter(Boolean).join(' · ');
        b.append(
          el('strong', null, item.title || item.label || item.target || 'Page'),
          el('span', null, sub)
        );
        b.addEventListener('click', () => {
          if (item.missing) this._createMissing(item.target || item.title);
          else this._openDest(item);
        });
        list.appendChild(b);
      });
    }

    async _loadGraph() {
      if (Array.isArray(this.opts.pages)) {
        this._pages = this.opts.pages;
        this._paintPreview();
        this._paintLinks();
        return;
      }
      if (isStandaloneDoc()) {
        this._pages = [];
        this._paintPreview();
        this._paintLinks();
        return;
      }
      try {
        const res = await fetch('/api/wiki-graph');
        const data = await res.json();
        if (this._destroyed) return;
        this._pages = Array.isArray(data.pages) ? data.pages : [];
      } catch (err) {
        if (this._destroyed) return;
        this._pages = [];
      }
      this._paintPreview();
      this._paintLinks();
      this._scheduleGraph();
    }

    _scheduleGraph() {
      clearTimeout(this._graphTimer);
      if (this._destroyed || Array.isArray(this.opts.pages) || isStandaloneDoc()) return;
      this._graphTimer = setTimeout(() => {
        if (!this._destroyed) this._loadGraph();
      }, 8000);
    }

    _openDest(item) {
      if (!item || !item.path) return;
      if (typeof this.onOpenPath === 'function') this.onOpenPath(item.path, this._destOf(item));
    }

    _openPath(relPath, dest) {
      if (!relPath) return;
      if (typeof this.onOpenPath === 'function') this.onOpenPath(relPath, dest || {});
    }

    async _onPreviewClick(ev) {
      const a = ev.target.closest && ev.target.closest('a.wk-link');
      if (!a) return;
      ev.preventDefault();
      if (a.getAttribute('data-missing') === '1') {
        await this._createMissing(a.getAttribute('data-target') || a.textContent);
        return;
      }
      const p = a.getAttribute('data-path');
      if (p) {
        this._openDest({
          path: p,
          frameId: a.getAttribute('data-frame') || '',
          slideId: a.getAttribute('data-slide') || '',
          taskId: a.getAttribute('data-task') || '',
          cardId: a.getAttribute('data-card') || '',
        });
      }
    }

    async _createMissing(target) {
      if (this.readOnly || !target) return;
      if (C.looksLikePath(target) || String(target).indexOf('#') >= 0) {
        this._toast('That file is not in the workspace');
        return;
      }
      const title = String(target).split('/').pop().replace(/\.html?$/i, '') || 'New page';
      const ok = await this._ask('Create page', 'Create a wiki page named “' + title + '”?', 'Create');
      if (!ok || this._destroyed) return;
      if (typeof this.onCreatePage === 'function') {
        try {
          await this.onCreatePage(title);
          if (!this._destroyed) await this._loadGraph();
        } catch (err) {
          this._toast((err && err.message) || 'Could not create that page');
        }
        return;
      }
      this._toast('Open this wiki in Accretion to create pages');
    }

    _insertAtCursor(text) {
      if (this.readOnly) return;
      if (!this.editing) this.setEditing(true);
      const ta = this.els.body;
      const before = this._editBefore || JSON.stringify(this.data);
      const value = ta.value;
      const focused = document.activeElement === ta;
      if (focused) {
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        ta.value = value.slice(0, start) + text + value.slice(end);
        const pos = start + text.length;
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
      } else {
        const pad = value && !value.endsWith('\n') ? '\n' : '';
        ta.value = value + pad + text;
      }
      ta.focus();
      this.data.body = C.str(ta.value, C.BODY_MAX);
      this._editBefore = before;
      this._paintPreview();
      this._paintLinks();
      this._commitField();
    }

    _wikiMarkup(page, child) {
      if (!page || !page.path) return '';
      if (!child) {
        const label = page.title && page.title !== page.path ? page.title : '';
        return label ? '[[' + page.path + '|' + label + ']]' : '[[' + page.path + ']]';
      }
      const hash = child.type + ':' + child.id;
      const label = child.title || page.title || child.id;
      return '[[' + page.path + '#' + hash + '|' + label + ']]';
    }

    _openLinkPicker() {
      if (this.readOnly) return;
      if (!this.editing) this.setEditing(true);
      const wrap = el('div', 'wk-dialog open');
      const panel = el('div', 'wk-dialog-panel wk-picker');
      panel.appendChild(el('h3', null, 'Insert link'));
      panel.appendChild(el('p', null, 'Search, filter by type, then click to insert the tag.'));
      const search = document.createElement('input');
      search.className = 'wk-title';
      search.type = 'search';
      search.placeholder = 'Search files, frames, cards, tasks, slides';
      search.style.width = '100%';
      search.style.borderBottom = '1px solid var(--wk-line)';
      panel.appendChild(search);
      const kindRow = el('div', 'wk-filters');
      const itemRow = el('div', 'wk-filters');
      panel.append(kindRow, itemRow);
      const list = el('div', 'wk-picker-list');
      panel.appendChild(list);
      const actions = el('div', 'wk-dialog-actions');
      const cancel = btn('wk-ghost', 'Cancel');
      const insert = btn('wk-primary', 'Insert');
      actions.append(cancel, insert);
      panel.appendChild(actions);
      wrap.appendChild(panel);
      this.els.root.appendChild(wrap);
      let kind = '';
      let itemType = '';
      const close = () => wrap.remove();
      const pickMarkup = (markup) => {
        if (!markup) return;
        this._insertAtCursor(markup);
        close();
      };
      const pickTyped = (text) => {
        const t = String(text || '').trim();
        if (!t) return;
        if (/^\[\[/.test(t)) pickMarkup(t);
        else pickMarkup('[[' + t + ']]');
      };
      const paintChips = (row, filters, current, onPick) => {
        row.innerHTML = '';
        filters.forEach((f) => {
          const b = el('button', 'wk-filter' + (f.id === current ? ' is-on' : ''));
          b.type = 'button';
          b.textContent = f.label;
          b.addEventListener('click', () => onPick(f.id));
          row.appendChild(b);
        });
      };
      const addItem = (parent, page, child, extraCls) => {
        const item = el('button', 'wk-side-item' + (extraCls ? ' ' + extraCls : ''));
        item.type = 'button';
        const title = child ? (child.title || child.id) : (page.title || page.path);
        const markup = this._wikiMarkup(page, child);
        const sub = child
          ? (C.kindLabel(child.type) + ' · ' + page.path)
          : ((C.kindLabel(page.kind) + ' · ' + (page.path || '')).trim());
        const strong = el('strong', null, title);
        if (!child && page.kind && page.kind !== 'wiki') {
          strong.appendChild(el('span', 'wk-kind', C.kindLabel(page.kind)));
        }
        item.append(strong, el('span', null, sub), el('span', 'wk-tag', markup));
        item.addEventListener('click', () => pickMarkup(markup));
        parent.appendChild(item);
      };
      const childrenOf = (p) => {
        const out = [];
        (p.frames || []).forEach((f) => out.push({ type: 'frame', id: f.id, title: f.title }));
        (p.slides || []).forEach((s) => out.push({ type: 'slide', id: s.id, title: s.title || ('Slide ' + ((s.index || 0) + 1)) }));
        (p.tasks || []).forEach((t) => out.push({ type: 'task', id: t.id, title: t.title }));
        (p.cards || []).forEach((c) => out.push({ type: 'card', id: c.id, title: c.title }));
        return out;
      };
      const paintList = () => {
        const q = search.value.toLowerCase().trim();
        list.innerHTML = '';
        const order = { wiki: 0, mindmap: 1, flow: 2, kanban: 3, gantt: 4, slides: 5, json: 6, yaml: 7, pdf: 8, file: 9 };
        const pages = (this._pages || []).slice().sort((a, b) => {
          const d = (order[a.kind] || 9) - (order[b.kind] || 9);
          if (d) return d;
          return String(a.title || a.path).localeCompare(String(b.title || b.path));
        });
        let n = 0;
        pages.forEach((p) => {
          if (C.pathKey(p.path) === C.pathKey(this.filePath)) return;
          if (kind && p.kind !== kind) return;
          const allKids = childrenOf(p);
          const typeKids = itemType === 'file' ? [] : allKids.filter((k) => !itemType || k.type === itemType);
          const fileHay = ((p.title || '') + ' ' + (p.path || '') + ' ' + (p.kind || '')).toLowerCase();
          const fileHit = !q || fileHay.indexOf(q) >= 0;
          const kidHits = !q ? typeKids : typeKids.filter((k) => ((k.title || '') + ' ' + k.type + ' ' + k.id).toLowerCase().indexOf(q) >= 0);
          const wantFile = !itemType || itemType === 'file';
          const showFileRow = wantFile && fileHit;
          if (!showFileRow && !kidHits.length) return;
          const group = el('div', 'wk-picker-group');
          group.appendChild(el('div', 'wk-picker-file', C.kindLabel(p.kind) + ' · ' + (p.path || '')));
          if (showFileRow) {
            addItem(group, p, null);
            n += 1;
          }
          kidHits.forEach((k) => {
            addItem(group, p, k, 'is-child');
            n += 1;
          });
          list.appendChild(group);
        });
        if (!n) list.appendChild(el('p', 'wk-side-empty', q || kind || itemType ? 'No matches. Insert will use the search text as a wiki title.' : 'No other files yet.'));
      };
      const paintFilters = () => {
        paintChips(kindRow, KIND_FILTERS, kind, (id) => { kind = id; paintFilters(); paintList(); });
        paintChips(itemRow, ITEM_FILTERS, itemType, (id) => { itemType = id; paintFilters(); paintList(); });
      };
      search.addEventListener('input', paintList);
      search.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          pickTyped(search.value.trim());
        }
      });
      insert.addEventListener('click', () => pickTyped(search.value.trim()));
      cancel.addEventListener('click', close);
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) close();
      });
      paintFilters();
      paintList();
      search.focus();
    }

    _ask(title, message, confirmLabel) {
      return new Promise((resolve) => {
        const wrap = el('div', 'wk-dialog open');
        const panel = el('div', 'wk-dialog-panel');
        panel.appendChild(el('h3', null, title));
        if (message) panel.appendChild(el('p', null, message));
        const actions = el('div', 'wk-dialog-actions');
        const cancel = btn('wk-ghost', 'Cancel');
        const ok = btn('wk-primary', confirmLabel || 'OK');
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
      if (this.els.root.querySelector('.wk-dialog')) {
        if (ev.key === 'Escape') {
          const dlg = this.els.root.querySelector('.wk-dialog');
          if (dlg) dlg.remove();
        }
        return;
      }
      if (ev.key === 'Escape' && this.editing && !this.readOnly) {
        this.setEditing(false);
        return;
      }
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) this.redo();
        else this.undo();
      }
    }

    _toast(text) {
      const n = this.els.toast;
      n.textContent = text;
      n.classList.add('open');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => n.classList.remove('open'), 1600);
    }
  }

  global.WikiEngine = WikiEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
