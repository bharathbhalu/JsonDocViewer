/* DocViewer kanban engine — column board with cards, filters, drawer, and standalone export. */
(function (global) {
  const C = global.KanbanCore;
  if (!C) {
    console.error('KanbanCore is missing');
    return;
  }

  const EXPORT_V = 1; // must match KanbanExport._v in export.js
  const DRAG_THRESHOLD = 4;
  const EDGE_SCROLL = 64;
  const HISTORY_MAX = 100;

  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    filter: 'M3 5h18M6 12h12M10 19h4',
    dots: 'M12 5h.01M12 12h.01M12 19h.01',
    close: 'M6 6l12 12M18 6L6 18',
    undo: 'M9 14L4 9l5-5M4 9h9a7 7 0 010 14H7',
    redo: 'M15 14l5-5-5-5M20 9h-9a7 7 0 000 14h6',
    calendar: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z',
    check: 'M4 12l5 5L20 6',
    notes: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h4',
    link: 'M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1',
    download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
    archive: 'M3 7h18v4H3zM5 11v9h14v-9M9 15h6',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
    help: 'M12 17h.01M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 4M12 21a9 9 0 110-18 9 9 0 010 18z',
    collapse: 'M15 5l-6 7 6 7',
    expand: 'M9 5l6 7-6 7',
    print: 'M7 8V3h10v5M7 18H4v-7h16v7h-3M7 14h10v7H7z',
    upload: 'M12 15V3M7 7l5-4 5 4M4 20h16',
  };

  function icon(name, size) {
    const d = ICONS[name];
    if (!d) return '';
    const s = size || 14;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Mouse events can target a text node, which has no closest().
  function eventEl(target) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    return target.parentElement || null;
  }

  function btn(cls, label, iconName, title) {
    const b = el('button', 'kb-btn ' + (cls || ''));
    b.type = 'button';
    if (iconName) {
      const span = el('span', 'kb-ico');
      span.innerHTML = icon(iconName);
      b.appendChild(span);
    }
    if (label) b.appendChild(el('span', null, label));
    if (title) b.title = title;
    return b;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readEditValue(node) {
    if (!node) return '';
    if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') return node.value;
    return String(node.textContent || '');
  }

  function isStandaloneDoc() {
    return document.documentElement.getAttribute('data-accretion') === 'standalone';
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function safeHttpUrl(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    try {
      const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s.replace(/^\/\//, '');
      const u = new URL(withProto);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  function formatDue(iso) {
    if (!iso) return '';
    const parts = iso.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return `${months[d.getMonth()]} ${d.getDate()}` + (sameYear ? '' : ` ${d.getFullYear()}`);
  }

  function relativeStamp(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 30) return days + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function autoSize(node) {
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = node.scrollHeight + 'px';
  }

  // Markdown-lite: enough for notes, no dependency, escaped before any markup.
  function renderMarkdown(src) {
    const text = String(src || '');
    if (!text.trim()) return '';
    const blocks = [];
    const lines = escapeHtml(text).split('\n');
    let i = 0;

    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    }

    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        blocks.push(`<pre><code>${code.join('\n')}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      if (/^#{1,3}\s+/.test(line)) {
        blocks.push(`<h3>${inline(line.replace(/^#{1,3}\s+/, ''))}</h3>`);
        i++;
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          quote.push(inline(lines[i].replace(/^&gt;\s?/, '')));
          i++;
        }
        blocks.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
          i++;
        }
        blocks.push(`<ul>${items.join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
          i++;
        }
        blocks.push(`<ol>${items.join('')}</ol>`);
        continue;
      }
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(```|#{1,3}\s|&gt;|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) {
        para.push(inline(lines[i]));
        i++;
      }
      blocks.push(`<p>${para.join('<br>')}</p>`);
    }
    return blocks.join('');
  }

  class KanbanEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = this.opts.onChange || function () {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this.selectedId = null;
      this.detailId = null;
      this.notesEditing = false;
      this._edit = null;
      this._editBefore = null;
      this._emitTimer = 0;
      this._undo = [];
      this._redo = [];
      this._drag = null;
      this._pending = null;
      this._colEls = new Map();
      this._cardEls = new Map();
      this._suppressChange = false;
      this._destroyed = false;
      this._toastTimer = 0;
      this._buildDom();
      this._bind();
      this.render();
    }

    static isKanbanHtml(html) { return C.isKanbanHtml(html); }
    static parseHtml(html) { return C.parseHtml(html); }
    static serializeToHtml(data) { return C.serializeToHtml(data); }

    // --- lifecycle ---

    destroy() {
      this._destroyed = true;
      this._teardownEdit();
      this._endDrag(true);
      this._unbind();
      clearTimeout(this._emitTimer);
      clearTimeout(this._toastTimer);
      this.container.innerHTML = '';
      this.container.classList.remove('kb-host');
    }

    setReadOnly(v) {
      this.readOnly = !!v;
      this.els.root.classList.toggle('is-readonly', this.readOnly);
      this.render();
    }

    loadFromHtml(html) {
      this._teardownEdit();
      this.data = C.parseHtml(html) || C.createEmpty();
      this.selectedId = null;
      this.detailId = null;
      this.notesEditing = false;
      this._undo = [];
      this._redo = [];
      this._resetCaches();
      this._closeDrawer(true);
      this.render();
    }

    serializeToHtml() {
      return C.serializeToHtml(this.data, this.data.title);
    }

    collapseAll() {
      this._mutate(() => {
        (this.data.columns || []).forEach((c) => { c.collapsed = true; });
      });
    }

    expandAll() {
      this._mutate(() => {
        (this.data.columns || []).forEach((c) => { c.collapsed = false; });
      });
    }

    // --- edit session plumbing ---------------------------------------------
    // Autosave can fire mid-keystroke. flushEdit() must copy the live value
    // into the model and return with focus and caret untouched; only
    // commitEdit() is allowed to tear the editor down.

    flushEdit() {
      const e = this._edit;
      if (!e || !e.el || !e.el.isConnected) return;
      this._writeEdit(e, readEditValue(e.el));
    }

    commitEdit() {
      const e = this._edit;
      if (!e || !e.el) return;
      if (e.el.isConnected) this._writeEdit(e, readEditValue(e.el));
      const before = this._editBefore;
      this._teardownEdit();
      if (before && before !== JSON.stringify(this.data)) this._pushHistory(before);
      this.render();
      this._emit();
    }

    _teardownEdit() {
      clearTimeout(this._emitTimer);
      const e = this._edit;
      this._edit = null;
      this._editBefore = null;
      if (e && e.el && e.el.classList.contains('kb-card-edit') && e.el.isConnected) {
        const card = e.el.closest('.kb-card');
        if (card) card.classList.remove('is-editing');
      }
    }

    _writeEdit(e, value) {
      if (this.readOnly) return;
      if (e.kind === 'board-title') {
        this.data.title = value.replace(/\n/g, ' ').slice(0, 120);
        return;
      }
      if (e.kind === 'column-title') {
        const col = this._column(e.id);
        if (col) col.title = value.replace(/\n/g, ' ').slice(0, 60);
        return;
      }
      const card = this.data.cards[e.id];
      if (!card) return;
      if (e.kind === 'card-title' || e.kind === 'detail-title') {
        card.title = value.slice(0, 200);
        card.updatedAt = C.nowIso();
        return;
      }
      if (e.kind === 'notes') {
        card.notes = value.slice(0, 20000);
        card.updatedAt = C.nowIso();
        return;
      }
      if (e.kind === 'check') {
        const item = (card.checklist || []).find((x) => x.id === e.itemId);
        if (item) item.text = value.replace(/\n/g, ' ').slice(0, 240);
        card.updatedAt = C.nowIso();
      }
    }

    // Any focusable field that edits the model directly registers here, so a
    // single flushEdit() call covers every in-progress edit on the board.
    _bindLiveField(node, kind, getId, onLive) {
      node.addEventListener('focus', () => {
        if (this.readOnly) return;
        this._edit = Object.assign({ kind, el: node }, getId ? getId() : {});
        this._editBefore = JSON.stringify(this.data);
      });
      node.addEventListener('input', () => {
        if (this.readOnly) return;
        if (!this._edit || this._edit.el !== node) {
          // A focus event can go missing (an unfocused window, a field that
          // was already focused when it was bound). Recover here, or an
          // autosave firing mid-keystroke would have nowhere to write.
          this._edit = Object.assign({ kind, el: node }, getId ? getId() : {});
          if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
        }
        this._writeEdit(this._edit, readEditValue(node));
        if (onLive) onLive(node);
        clearTimeout(this._emitTimer);
        this._emitTimer = setTimeout(() => {
          if (!this._destroyed) this._emitLive();
        }, 350);
      });
      node.addEventListener('blur', () => {
        if (this._edit && this._edit.el === node) this.commitEdit();
      });
    }

    // --- change notification ---

    _emit() {
      if (this._suppressChange || this.readOnly) return;
      this.onChange(this.data);
    }

    // Mark the document dirty mid-edit without recording an undo step.
    _emitLive() {
      if (this._suppressChange || this.readOnly) return;
      this.onChange(this.data);
    }

    _pushHistory(snapshot) {
      this._undo.push(snapshot);
      if (this._undo.length > HISTORY_MAX) this._undo.shift();
      this._redo.length = 0;
      this._syncHistoryButtons();
    }

    _mutate(fn) {
      if (this.readOnly) return false;
      const before = JSON.stringify(this.data);
      if (fn() === false) return false;
      this.data.updatedAt = C.nowIso();
      this._pushHistory(before);
      this.render();
      this._refreshDrawer();
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
      if (this.detailId && !this.data.cards[this.detailId]) this._closeDrawer(true);
      this._resetCaches();
      this.render();
      this._refreshDrawer();
      this._syncHistoryButtons();
      this._emit();
    }

    _resetCaches() {
      this._colEls.clear();
      this._cardEls.clear();
      if (this.els && this.els.board) this.els.board.innerHTML = '';
      if (this.els && this.els.lanes) this.els.lanes.innerHTML = '';
    }

    _column(id) {
      return (this.data.columns || []).find((c) => c.id === id) || null;
    }

    _label(id) {
      return (this.data.labels || []).find((l) => l.id === id) || null;
    }

    _member(id) {
      return (this.data.members || []).find((m) => m.id === id) || null;
    }

    // --- DOM scaffold ---

    _buildDom() {
      this.container.innerHTML = '';
      this.container.classList.add('kb-host');
      const root = el('div', 'kb-root');
      root.tabIndex = -1;
      if (this.readOnly) root.classList.add('is-readonly');

      const topbar = el('div', 'kb-topbar');
      const title = document.createElement('input');
      title.className = 'kb-title';
      title.type = 'text';
      title.placeholder = 'Board';
      title.setAttribute('aria-label', 'Board title');
      const stats = el('div', 'kb-stats');
      const spacer = el('div', 'kb-spacer');

      const addColBtn = btn('kb-add-col-btn kb-ghost', 'Column', 'plus', 'Add a column');
      const filterBtn = btn('kb-ghost', 'Filter', 'filter', 'Filter cards (/)');
      const viewBtn = btn('kb-ghost kb-icon', '', 'grid', 'View options');
      const exportBtn = btn('kb-ghost kb-icon', '', 'download', 'Export');
      const undoBtn = btn('kb-ghost kb-icon', '', 'undo', 'Undo');
      const redoBtn = btn('kb-ghost kb-icon', '', 'redo', 'Redo');
      const helpBtn = btn('kb-ghost kb-icon', '', 'help', 'Keyboard shortcuts (?)');

      topbar.append(title, stats, spacer, filterBtn, addColBtn, el('div', 'kb-sep'), viewBtn, exportBtn, el('div', 'kb-sep'), undoBtn, redoBtn, helpBtn);

      const filterbar = el('div', 'kb-filterbar');
      const search = document.createElement('input');
      search.className = 'kb-input kb-filter-search';
      search.type = 'search';
      search.placeholder = 'Find cards';
      const labelChips = el('div', 'kb-chiprow');
      const assigneeSel = el('select', 'kb-select');
      const prioritySel = el('select', 'kb-select');
      const dueSel = el('select', 'kb-select');
      const filterCount = el('span', 'kb-filter-count');
      const clearBtn = btn('kb-ghost', 'Clear', null, 'Clear all filters');
      filterbar.append(search, labelChips, assigneeSel, prioritySel, dueSel, el('div', 'kb-spacer'), filterCount, clearBtn);

      const board = el('div', 'kb-board');
      board.setAttribute('role', 'list');
      // No `hidden` class here: the app's .hidden is display:none !important,
      // which would beat the inline display we toggle for lane mode.
      const lanes = el('div', 'kb-lanes');
      lanes.style.display = 'none';
      const addCol = el('button', 'kb-col-add', '+  Add column');
      addCol.type = 'button';

      const scrim = el('div', 'kb-scrim');
      const drawer = this._buildDrawer();
      const menu = el('div', 'kb-menu');
      const dragLayer = el('div', 'kb-drag-layer');
      const toast = el('div', 'kb-toast');
      const help = this._buildHelp();

      root.append(topbar, filterbar, board, lanes, scrim, drawer, menu, dragLayer, toast, help);
      this.container.appendChild(root);

      this.els = {
        root,
        topbar,
        title,
        stats,
        addColBtn,
        filterBtn,
        viewBtn,
        exportBtn,
        undoBtn,
        redoBtn,
        helpBtn,
        filterbar,
        search,
        labelChips,
        assigneeSel,
        prioritySel,
        dueSel,
        filterCount,
        clearBtn,
        board,
        lanes,
        addCol,
        scrim,
        drawer,
        menu,
        dragLayer,
        toast,
        help,
      };
    }

    _buildHelp() {
      const wrap = el('div', 'kb-help');
      const panel = el('div', 'kb-help-panel');
      panel.appendChild(el('h3', null, 'Keyboard shortcuts'));
      const rows = [
        ['New card in selected column', ['N']],
        ['Edit selected card title', ['Enter']],
        ['Open card detail', ['E']],
        ['Move selection', ['↑', '↓', '←', '→']],
        ['Move card', ['⌘', '↑ ↓ ← →']],
        ['Archive selected card', ['⌫']],
        ['Duplicate selected card', ['⌘', 'D']],
        ['Filter cards', ['/']],
        ['Undo / redo', ['⌘', 'Z']],
        ['Close drawer or editor', ['Esc']],
        ['This help', ['?']],
      ];
      rows.forEach(([desc, keys]) => {
        const row = el('div', 'kb-key-row');
        row.appendChild(el('span', null, desc));
        const kb = el('div', 'kb-keys');
        keys.forEach((k) => kb.appendChild(el('kbd', null, k)));
        row.appendChild(kb);
        panel.appendChild(row);
      });
      const close = btn('kb-primary', 'Got it');
      close.style.marginTop = '12px';
      close.addEventListener('click', () => wrap.classList.remove('open'));
      panel.appendChild(close);
      wrap.appendChild(panel);
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) wrap.classList.remove('open');
      });
      return wrap;
    }

    // --- detail drawer ---

    _buildDrawer() {
      const drawer = el('aside', 'kb-drawer');
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-label', 'Card detail');

      const head = el('div', 'kb-drawer-head');
      const where = el('div', 'kb-drawer-where');
      const menuBtn = btn('kb-ghost kb-icon', '', 'dots', 'Card actions');
      const closeBtn = btn('kb-ghost kb-icon', '', 'close', 'Close (Esc)');
      head.append(where, menuBtn, closeBtn);

      const body = el('div', 'kb-drawer-body');

      const titleField = el('div', 'kb-field');
      const titleInput = el('textarea', 'kb-detail-title');
      titleInput.rows = 1;
      titleInput.placeholder = 'Card title';
      titleField.appendChild(titleInput);

      const metaField = el('div', 'kb-field');
      const metaRow1 = el('div', 'kb-field-row');
      const colWrap = el('div');
      colWrap.appendChild(el('label', 'kb-field-label', 'Column'));
      const colSel = el('select', 'kb-select');
      colWrap.appendChild(colSel);
      const prioWrap = el('div');
      prioWrap.appendChild(el('label', 'kb-field-label', 'Priority'));
      const prioSel = el('select', 'kb-select');
      prioWrap.appendChild(prioSel);
      metaRow1.append(colWrap, prioWrap);
      const metaRow2 = el('div', 'kb-field-row');
      const whoWrap = el('div');
      whoWrap.appendChild(el('label', 'kb-field-label', 'Assignee'));
      const whoSel = el('select', 'kb-select');
      whoWrap.appendChild(whoSel);
      const dueWrap = el('div');
      dueWrap.appendChild(el('label', 'kb-field-label', 'Due date'));
      const dueInput = document.createElement('input');
      dueInput.className = 'kb-input';
      dueInput.type = 'date';
      dueWrap.appendChild(dueInput);
      metaRow2.append(whoWrap, dueWrap);
      metaField.append(metaRow1, metaRow2);
      metaRow2.style.marginTop = '10px';

      const labelField = el('div', 'kb-field');
      const labelHead = el('div', 'kb-notes-head');
      labelHead.appendChild(el('label', 'kb-field-label', 'Labels'));
      const labelManage = btn('kb-ghost', 'Manage', null, 'Create or edit labels');
      labelHead.appendChild(labelManage);
      const labelRow = el('div', 'kb-chiprow');
      labelField.append(labelHead, labelRow);

      const coverField = el('div', 'kb-field');
      const coverHead = el('div', 'kb-notes-head');
      coverHead.appendChild(el('label', 'kb-field-label', 'Cover'));
      coverField.appendChild(coverHead);
      const coverRow = el('div', 'kb-chiprow');
      coverField.appendChild(coverRow);

      const notesField = el('div', 'kb-field');
      const notesHead = el('div', 'kb-notes-head');
      notesHead.appendChild(el('label', 'kb-field-label', 'Notes'));
      const notesToggle = btn('kb-ghost', 'Edit', null, 'Toggle markdown editing');
      notesHead.appendChild(notesToggle);
      const notesView = el('div', 'kb-md');
      const notesInput = el('textarea', 'kb-textarea');
      notesInput.placeholder = 'Markdown supported: **bold**, `code`, - lists, > quotes';
      notesInput.style.display = 'none';
      notesField.append(notesHead, notesView, notesInput);

      const checkField = el('div', 'kb-field');
      const checkHead = el('div', 'kb-notes-head');
      checkHead.appendChild(el('label', 'kb-field-label', 'Checklist'));
      const checkAdd = btn('kb-ghost', 'Add item', 'plus');
      checkHead.appendChild(checkAdd);
      const progress = el('div', 'kb-progress');
      const progressBar = el('div', 'kb-progress-bar');
      progressBar.appendChild(el('i'));
      const progressText = el('span');
      progress.append(progressText, progressBar);
      const checkList = el('div', 'kb-checklist');
      checkField.append(checkHead, progress, checkList);

      const linkField = el('div', 'kb-field');
      const linkHead = el('div', 'kb-notes-head');
      linkHead.appendChild(el('label', 'kb-field-label', 'Links'));
      const linkAdd = btn('kb-ghost', 'Add link', 'plus');
      linkHead.appendChild(linkAdd);
      const linkList = el('div');
      const linkEntry = el('div', 'kb-field-row');
      linkEntry.style.display = 'none';
      linkEntry.style.marginTop = '6px';
      const linkUrl = document.createElement('input');
      linkUrl.className = 'kb-input';
      linkUrl.type = 'text';
      linkUrl.placeholder = 'https://example.com or data/notes.html';
      const linkSave = btn('kb-primary', 'Add');
      linkEntry.append(linkUrl, linkSave);
      linkSave.style.flex = '0 0 auto';
      linkField.append(linkHead, linkList, linkEntry);

      const foot = el('div', 'kb-detail-foot');
      const archiveBtn = btn('kb-ghost', 'Archive', 'archive');
      const dupBtn = btn('kb-ghost', 'Duplicate', 'copy');
      const delBtn = btn('kb-ghost kb-danger', 'Delete', 'trash');
      const stamp = el('div', 'kb-stamp');
      foot.append(archiveBtn, dupBtn, delBtn, el('div', 'kb-spacer'), stamp);

      body.append(titleField, metaField, labelField, coverField, notesField, checkField, linkField, foot);
      drawer.append(head, body);

      this.drawerEls = {
        where,
        menuBtn,
        closeBtn,
        titleInput,
        colSel,
        prioSel,
        whoSel,
        dueInput,
        labelRow,
        labelManage,
        coverRow,
        notesView,
        notesInput,
        notesToggle,
        checkList,
        checkAdd,
        progress,
        progressBar,
        progressText,
        linkList,
        linkEntry,
        linkUrl,
        linkSave,
        linkAdd,
        archiveBtn,
        dupBtn,
        delBtn,
        stamp,
      };
      return drawer;
    }

    // --- event wiring ---

    _bind() {
      const e = this.els;
      const d = this.drawerEls;

      this._onDocPointerDown = (ev) => {
        if (!this.els.menu.contains(ev.target)) this._closeMenu();
      };
      this._onKeyDown = (ev) => this._handleKey(ev);
      this._onWindowPointerMove = (ev) => this._onDragMove(ev);
      this._onWindowPointerUp = (ev) => this._onDragEnd(ev);
      document.addEventListener('pointerdown', this._onDocPointerDown, true);
      document.addEventListener('keydown', this._onKeyDown);

      this._bindLiveField(e.title, 'board-title');
      e.title.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          e.title.blur();
        }
      });

      e.addColBtn.addEventListener('click', () => this.addColumn());
      e.addCol.addEventListener('click', () => this.addColumn());
      e.filterBtn.addEventListener('click', () => this._toggleFilterBar());
      e.viewBtn.addEventListener('click', () => this._openViewMenu(e.viewBtn));
      e.exportBtn.addEventListener('click', () => this._openExportMenu(e.exportBtn));
      e.undoBtn.addEventListener('click', () => this.undo());
      e.redoBtn.addEventListener('click', () => this.redo());
      e.helpBtn.addEventListener('click', () => e.help.classList.toggle('open'));

      let searchTimer = 0;
      e.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          this.data.view.filters.text = e.search.value.slice(0, 120);
          this._renderBody();
          this._renderFilterCount();
          this._emitLive();
        }, 160);
      });
      e.assigneeSel.addEventListener('change', () => this._setFilter('assignee', e.assigneeSel.value));
      e.prioritySel.addEventListener('change', () => this._setFilter('priority', e.prioritySel.value));
      e.dueSel.addEventListener('change', () => this._setFilter('due', e.dueSel.value));
      e.clearBtn.addEventListener('click', () => {
        this.data.view.filters = C.defaultView().filters;
        e.search.value = '';
        this.render();
        this._emitLive();
      });

      e.board.addEventListener('pointerdown', (ev) => this._onBoardPointerDown(ev));
      e.lanes.addEventListener('pointerdown', (ev) => this._onBoardPointerDown(ev));
      e.board.addEventListener('dblclick', (ev) => this._onBoardDblClick(ev));
      e.lanes.addEventListener('dblclick', (ev) => this._onBoardDblClick(ev));
      e.board.addEventListener('click', (ev) => this._onBoardClick(ev));
      e.lanes.addEventListener('click', (ev) => this._onBoardClick(ev));
      e.root.addEventListener('contextmenu', (ev) => this._onContextMenu(ev));

      e.scrim.addEventListener('click', () => this._closeDrawer());
      d.closeBtn.addEventListener('click', () => this._closeDrawer());
      d.menuBtn.addEventListener('click', () => this._openCardMenu(d.menuBtn, this.detailId));

      this._bindLiveField(d.titleInput, 'detail-title', () => ({ id: this.detailId }), (node) => {
        autoSize(node);
        const card = this.data.cards[this.detailId];
        if (card) this._paintCardById(card.id);
      });
      d.titleInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          d.titleInput.blur();
        }
      });

      this._bindLiveField(d.notesInput, 'notes', () => ({ id: this.detailId }), (node) => autoSize(node));
      d.notesToggle.addEventListener('click', () => {
        this.notesEditing = !this.notesEditing;
        this._refreshDrawer();
        if (this.notesEditing) {
          d.notesInput.focus();
          autoSize(d.notesInput);
        }
      });

      d.colSel.addEventListener('change', () => {
        const card = this.data.cards[this.detailId];
        if (card) this._mutate(() => C.moveCard(this.data, card.id, d.colSel.value, null));
      });
      d.prioSel.addEventListener('change', () => this._updateCard(this.detailId, (card) => {
        card.priority = d.prioSel.value || null;
      }));
      d.whoSel.addEventListener('change', () => {
        if (d.whoSel.value === '__new') {
          this._promptNewMember();
          return;
        }
        this._updateCard(this.detailId, (card) => {
          card.assignee = d.whoSel.value || null;
        });
      });
      d.dueInput.addEventListener('change', () => this._updateCard(this.detailId, (card) => {
        card.due = C.isDateIso(d.dueInput.value) ? d.dueInput.value : null;
      }));

      d.labelManage.addEventListener('click', () => this._openLabelManager(d.labelManage));
      d.checkAdd.addEventListener('click', () => this._addChecklistItem());
      d.linkAdd.addEventListener('click', () => {
        d.linkEntry.style.display = d.linkEntry.style.display === 'none' ? 'flex' : 'none';
        if (d.linkEntry.style.display === 'flex') d.linkUrl.focus();
      });
      d.linkSave.addEventListener('click', () => this._addLink());
      d.linkUrl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          this._addLink();
        }
      });
      d.archiveBtn.addEventListener('click', () => this.toggleArchive(this.detailId));
      d.dupBtn.addEventListener('click', () => this.duplicateCard(this.detailId));
      d.delBtn.addEventListener('click', () => this.deleteCard(this.detailId));
    }

    _unbind() {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
      document.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('pointermove', this._onWindowPointerMove);
      window.removeEventListener('pointerup', this._onWindowPointerUp);
    }

    // --- render ---

    render() {
      if (this._destroyed) return;
      this._renderTop();
      this._renderFilterBar();
      this._renderBody();
    }

    _renderTop() {
      const e = this.els;
      if (document.activeElement !== e.title) e.title.value = this.data.title || '';
      e.title.readOnly = this.readOnly;
      const stats = C.boardStats(this.data);
      e.stats.innerHTML = '';
      const add = (text, alert) => {
        const s = el('span', 'kb-stat' + (alert ? ' is-alert' : ''));
        s.innerHTML = text;
        e.stats.appendChild(s);
      };
      add(`<b>${stats.total}</b> card${stats.total === 1 ? '' : 's'}`);
      if (stats.overdue) add(`<b>${stats.overdue}</b> overdue`, true);
      else if (stats.dueToday) add(`<b>${stats.dueToday}</b> due today`);
      if (stats.checklist.total) add(`<b>${stats.checklist.done}/${stats.checklist.total}</b> done`);
      if (stats.archived) add(`<b>${stats.archived}</b> archived`);
      e.filterBtn.classList.toggle('is-active', C.hasActiveFilter(this.data.view.filters));
      this._syncHistoryButtons();
      e.root.setAttribute('data-density', this.data.view.density || 'comfortable');
    }

    _syncHistoryButtons() {
      if (!this.els) return;
      this.els.undoBtn.disabled = this.readOnly || !this._undo.length;
      this.els.redoBtn.disabled = this.readOnly || !this._redo.length;
    }

    _renderFilterBar() {
      const e = this.els;
      const f = this.data.view.filters;
      if (document.activeElement !== e.search) e.search.value = f.text || '';

      e.labelChips.innerHTML = '';
      (this.data.labels || []).forEach((label) => {
        const chip = el('button', 'kb-chip');
        chip.type = 'button';
        const dot = el('span', 'kb-dot');
        dot.style.background = label.color;
        chip.append(dot, el('span', null, label.name));
        const on = (f.labels || []).includes(label.id);
        chip.classList.toggle('is-on', on);
        if (on) chip.style.background = label.color;
        else chip.style.background = '';
        chip.addEventListener('click', () => {
          const list = f.labels || [];
          f.labels = list.includes(label.id) ? list.filter((x) => x !== label.id) : list.concat(label.id);
          this.render();
          this._emitLive();
        });
        e.labelChips.appendChild(chip);
      });

      const fill = (sel, options, value) => {
        sel.innerHTML = '';
        options.forEach(([val, text]) => {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = text;
          sel.appendChild(opt);
        });
        sel.value = value || '';
      };
      fill(e.assigneeSel, [['', 'Anyone']].concat((this.data.members || []).map((m) => [m.id, m.name])), f.assignee);
      fill(e.prioritySel, [['', 'Any priority']].concat(C.PRIORITIES.map((p) => [p.id, p.label])), f.priority);
      fill(e.dueSel, [['', 'Any date'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Next 7 days'], ['none', 'No date']], f.due);
      this._renderFilterCount();
    }

    _renderFilterCount() {
      const f = this.data.view.filters;
      if (!C.hasActiveFilter(f)) {
        this.els.filterCount.textContent = '';
        return;
      }
      let shown = 0;
      let total = 0;
      Object.keys(this.data.cards).forEach((id) => {
        const card = this.data.cards[id];
        if (card.archived && !this.data.view.showArchived) return;
        total += 1;
        if (C.cardMatchesFilter(card, f)) shown += 1;
      });
      this.els.filterCount.textContent = `${shown} of ${total} shown`;
    }

    _toggleFilterBar(force) {
      const open = force != null ? force : !this.els.filterbar.classList.contains('open');
      this.els.filterbar.classList.toggle('open', open);
      this.els.filterBtn.classList.toggle('is-active', open || C.hasActiveFilter(this.data.view.filters));
      if (open) this.els.search.focus();
    }

    _setFilter(key, value) {
      this.data.view.filters[key] = value;
      this.render();
      this._emitLive();
    }

    _renderBody() {
      const grouped = !!this.data.view.groupBy;
      this.els.board.style.display = grouped ? 'none' : '';
      this.els.lanes.style.display = grouped ? 'block' : 'none';
      if (!this.data.columns.length) {
        this._renderEmpty();
        return;
      }
      if (this.els.emptyState) {
        this.els.emptyState.remove();
        this.els.emptyState = null;
        this.els.board.style.display = grouped ? 'none' : '';
      }
      if (grouped) this._renderLanes();
      else this._renderColumns();
      this._pruneCardCache();
    }

    _renderEmpty() {
      this.els.board.style.display = 'none';
      this.els.lanes.style.display = 'none';
      if (this.els.emptyState) return;
      const wrap = el('div', 'kb-empty');
      wrap.appendChild(el('h3', null, 'An empty board'));
      wrap.appendChild(el('p', null, 'Start from a template or add your first column. Everything stays in this one HTML file.'));
      const grid = el('div', 'kb-template-grid');
      C.TEMPLATE_LIST.forEach((t) => {
        const card = el('button', 'kb-template');
        card.type = 'button';
        card.append(el('b', null, t.label), el('span', null, t.hint));
        card.addEventListener('click', () => this.applyTemplate(t.id));
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      this.els.emptyState = wrap;
      this.els.root.insertBefore(wrap, this.els.scrim);
    }

    applyTemplate(id) {
      this._mutate(() => {
        const next = C.buildTemplate(id);
        this.data.columns = next.columns;
        this.data.labels = next.labels.length ? next.labels : this.data.labels;
        this.data.cards = next.cards;
        if (!this.data.title || this.data.title === 'Board') this.data.title = next.title;
        this._resetCaches();
      });
    }

    _renderColumns() {
      const host = this.els.board;
      const live = new Set();
      this.data.columns.forEach((col) => {
        live.add(col.id);
        let node = this._colEls.get(col.id);
        if (!node) {
          node = this._buildColumn(col);
          this._colEls.set(col.id, node);
        }
        this._paintColumn(node, col, this._cardsFor(col));
      });
      this._colEls.forEach((node, id) => {
        if (!live.has(id)) {
          node.remove();
          this._colEls.delete(id);
        }
      });
      const want = this.data.columns.map((c) => this._colEls.get(c.id));
      const have = Array.from(host.children).filter((n) => n.classList.contains('kb-col'));
      const sameOrder = have.length === want.length && want.every((n, i) => have[i] === n);
      if (!sameOrder) want.forEach((n) => host.appendChild(n));
      if (!this.readOnly) host.appendChild(this.els.addCol);
      else if (this.els.addCol.parentNode) this.els.addCol.remove();
    }

    _cardsFor(col, lane) {
      let list = C.columnCards(this.data, col.id);
      if (lane) list = list.filter((c) => lane.match(c));
      return list;
    }

    _renderLanes() {
      const host = this.els.lanes;
      host.innerHTML = '';
      this._colEls.clear();
      const rows = C.groupRows(this.data, this.data.view.groupBy);
      rows.forEach((lane) => {
        const cards = {};
        let any = 0;
        this.data.columns.forEach((col) => {
          cards[col.id] = this._cardsFor(col, lane);
          any += cards[col.id].length;
        });
        if (!any && lane.id === '__none') return;
        const laneEl = el('section', 'kb-lane');
        const head = el('div', 'kb-lane-head');
        if (lane.color) {
          const dot = el('span', 'kb-dot');
          dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${lane.color}`;
          head.appendChild(dot);
        }
        head.appendChild(el('span', null, lane.title));
        head.appendChild(el('span', 'kb-count', String(any)));
        const track = el('div', 'kb-board');
        this.data.columns.forEach((col) => {
          const node = this._buildColumn(col, lane);
          this._paintColumn(node, col, cards[col.id], lane);
          track.appendChild(node);
        });
        laneEl.append(head, track);
        host.appendChild(laneEl);
      });
    }

    // --- column DOM ---

    _buildColumn(col, lane) {
      const node = el('section', 'kb-col');
      node.dataset.col = col.id;
      if (lane) node.dataset.lane = lane.id;
      node.setAttribute('role', 'listitem');

      const head = el('div', 'kb-col-head');
      const accent = el('span', 'kb-col-accent');
      const titleInput = document.createElement('input');
      titleInput.className = 'kb-col-title';
      titleInput.type = 'text';
      titleInput.setAttribute('aria-label', 'Column title');
      const label = el('span', 'kb-col-label');
      const count = el('span', 'kb-count');
      const menuBtn = btn('kb-ghost kb-icon kb-col-menu-btn', '', 'dots', 'Column actions');
      head.append(accent, titleInput, label, count, menuBtn);

      const body = el('div', 'kb-col-body');
      body.dataset.col = col.id;
      if (lane) body.dataset.lane = lane.id;

      const foot = el('div', 'kb-col-foot');
      const addBtn = btn('', '+  Add card', null, 'Add a card (N)');
      foot.appendChild(addBtn);

      node.append(head, body, foot);

      if (!lane) {
        this._bindLiveField(titleInput, 'column-title', () => ({ id: col.id }));
        titleInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            titleInput.blur();
          }
        });
        titleInput.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      } else {
        titleInput.readOnly = true;
      }
      menuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._openColumnMenu(menuBtn, col.id);
      });
      addBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.addCard(col.id, { lane });
      });
      accent.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.toggleColumnCollapsed(col.id);
      });
      return node;
    }

    _paintColumn(node, col, cards, lane) {
      const head = node.querySelector('.kb-col-head');
      const titleInput = node.querySelector('.kb-col-title');
      const label = node.querySelector('.kb-col-label');
      const count = node.querySelector('.kb-count');
      const accent = node.querySelector('.kb-col-accent');
      accent.style.background = col.color;
      accent.title = col.collapsed ? 'Expand column' : 'Collapse column';
      if (document.activeElement !== titleInput) titleInput.value = col.title;
      titleInput.readOnly = this.readOnly || !!lane;
      label.textContent = col.title;
      const total = cards.length;
      count.textContent = col.wip ? `${total}/${col.wip}` : String(total);
      const over = !!(col.wip && total > col.wip);
      count.classList.toggle('is-over', over);
      count.title = col.wip ? `${total} of ${col.wip} allowed` : `${total} cards`;
      node.classList.toggle('is-over-limit', over);
      node.classList.toggle('is-collapsed', !!col.collapsed);
      head.style.cursor = this.readOnly || lane ? 'default' : '';
      this._paintColumnCards(node, col, cards, lane);
    }

    _paintColumnCards(node, col, cards, lane) {
      const body = node.querySelector('.kb-col-body');
      const want = [];
      cards.forEach((card) => {
        const key = lane ? `${lane.id}|${card.id}` : card.id;
        let cardEl = this._cardEls.get(key);
        if (!cardEl) {
          cardEl = this._buildCard(card);
          this._cardEls.set(key, cardEl);
        }
        this._paintCard(cardEl, card);
        want.push(cardEl);
      });
      const have = Array.from(body.children).filter((n) => n.classList.contains('kb-card'));
      const sameOrder = have.length === want.length && want.every((n, i) => have[i] === n);
      if (!sameOrder) {
        have.forEach((n) => {
          if (want.indexOf(n) < 0) n.remove();
        });
        want.forEach((n) => body.appendChild(n));
      }
      const filtered = C.hasActiveFilter(this.data.view.filters);
      const emptyMode = filtered ? 'filter' : 'add';
      let emptyEl = body.querySelector('.kb-col-empty');
      if (!cards.length && !col.collapsed) {
        if (!emptyEl || emptyEl.dataset.mode !== emptyMode) {
          if (emptyEl) emptyEl.remove();
          const label = filtered ? 'No cards match the filter' : 'Add a card';
          if (filtered || this.readOnly) emptyEl = el('div', 'kb-col-empty', label);
          else {
            emptyEl = el('button', 'kb-col-empty', label);
            emptyEl.type = 'button';
            emptyEl.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              this.addCard(col.id, { lane });
            });
          }
          emptyEl.dataset.mode = emptyMode;
          body.appendChild(emptyEl);
        }
      } else if (emptyEl) emptyEl.remove();
    }

    // --- card DOM ---

    _buildCard(card) {
      const node = el('article', 'kb-card');
      node.dataset.id = card.id;
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      return node;
    }

    _cardSig(card) {
      return JSON.stringify([
        card.title,
        card.labels,
        card.assignee,
        card.priority,
        card.due,
        card.cover,
        card.archived,
        (card.checklist || []).map((i) => (i.done ? 1 : 0)).join(''),
        (card.checklist || []).length,
        (card.links || []).length,
        !!card.notes,
        this.data.view.density,
        (this.data.labels || []).map((l) => l.id + l.color + l.name).join(','),
        (this.data.members || []).map((m) => m.id + m.color + m.name).join(','),
      ]);
    }

    _paintCard(node, card) {
      node.classList.toggle('is-selected', this.selectedId === card.id);
      node.classList.toggle('is-archived', !!card.archived);
      // Never rebuild a card that currently hosts the inline editor.
      if (this._edit && this._edit.kind === 'card-title' && this._edit.id === card.id) return;
      const sig = this._cardSig(card);
      if (node.dataset.sig === sig) return;
      node.dataset.sig = sig;
      node.innerHTML = '';
      node.setAttribute('aria-label', card.title || 'Untitled card');

      if (card.cover) {
        const cover = el('div', 'kb-card-cover');
        cover.style.background = card.cover;
        node.appendChild(cover);
      }

      if ((card.labels || []).length) {
        const row = el('div', 'kb-card-labels');
        card.labels.forEach((id) => {
          const label = this._label(id);
          if (!label) return;
          const bar = el('span', 'kb-card-label');
          bar.style.background = label.color;
          bar.title = label.name;
          if (this.data.view.labelText) bar.textContent = label.name;
          row.appendChild(bar);
        });
        node.appendChild(row);
      }

      node.appendChild(el('div', 'kb-card-title', card.title));

      const meta = el('div', 'kb-card-meta');
      const prio = C.priorityMeta(card.priority);
      if (prio) {
        const item = el('span', 'kb-prio');
        const dot = el('span', 'kb-dot');
        dot.style.background = prio.hex;
        item.append(dot, el('span', null, prio.label));
        item.title = prio.label + ' priority';
        meta.appendChild(item);
      }
      if (card.due) {
        const state = C.dueState(card);
        const due = el('span', 'kb-due');
        due.dataset.state = state;
        due.innerHTML = icon('calendar', 11);
        due.appendChild(el('span', null, formatDue(card.due)));
        due.title = state === 'overdue' ? 'Overdue: ' + card.due : 'Due ' + card.due;
        meta.appendChild(due);
      }
      const progress = C.checklistProgress(card);
      if (progress.total) {
        const chk = el('span', 'kb-check' + (progress.done === progress.total ? ' is-done' : ''));
        chk.appendChild(el('span', null, `${progress.done}/${progress.total}`));
        const bar = el('span', 'kb-check-bar');
        const fill = el('i');
        fill.style.width = Math.round(progress.ratio * 100) + '%';
        bar.appendChild(fill);
        chk.appendChild(bar);
        chk.title = `Checklist ${progress.done} of ${progress.total}`;
        meta.appendChild(chk);
      }
      if ((card.links || []).length) {
        const item = el('span', 'kb-meta-item');
        item.innerHTML = icon('link', 12);
        item.appendChild(el('span', null, String(card.links.length)));
        item.title = card.links.length + ' link(s)';
        meta.appendChild(item);
      }
      if (card.notes) {
        const item = el('span', 'kb-meta-item');
        item.innerHTML = icon('notes', 12);
        item.title = 'Has notes';
        meta.appendChild(item);
      }
      const member = this._member(card.assignee);
      if (member) {
        const av = el('span', 'kb-avatar', initials(member.name));
        av.style.background = member.color;
        av.title = member.name;
        meta.appendChild(av);
      }
      node.appendChild(meta);
    }

    _paintCardById(id) {
      const card = this.data.cards[id];
      if (!card) return;
      this._cardEls.forEach((node, key) => {
        if (key === id || key.endsWith('|' + id)) this._paintCard(node, card);
      });
    }

    _pruneCardCache() {
      const liveKeys = new Set();
      if (this.data.view.groupBy) {
        C.groupRows(this.data, this.data.view.groupBy).forEach((lane) => {
          Object.keys(this.data.cards).forEach((id) => liveKeys.add(`${lane.id}|${id}`));
        });
      } else {
        Object.keys(this.data.cards).forEach((id) => liveKeys.add(id));
      }
      this._cardEls.forEach((node, key) => {
        if (!liveKeys.has(key)) {
          node.remove();
          this._cardEls.delete(key);
        }
      });
    }

    // --- board interaction ---

    _onBoardClick(ev) {
      const target = eventEl(ev.target);
      if (!target) return;
      const cardEl = target.closest('.kb-card');
      if (!cardEl) return;
      if (target.closest('textarea, input, button, a')) return;
      this.selectedId = cardEl.dataset.id;
      this._syncSelection();
      if (!this.readOnly && target.closest('.kb-card-title')) this.startTitleEdit(cardEl.dataset.id);
    }

    // Right-click opens the card or column menu at the cursor. The browser
    // menu is suppressed everywhere on the board except a text field that is
    // actually being edited, where copy and paste still belong to the browser.
    _onContextMenu(ev) {
      const target = eventEl(ev.target);
      if (!target || !this.els.root.contains(target)) return;
      if (target.closest('.kb-menu')) {
        ev.preventDefault();
        return;
      }
      const field = target.closest('input, textarea, select');
      if (field && document.activeElement === field) return;
      const cardEl = target.closest('.kb-card');
      const colEl = target.closest('.kb-col');
      const onBoard = cardEl || colEl || target.closest('.kb-board, .kb-lanes');
      if (!onBoard) return;
      ev.preventDefault();
      ev.stopPropagation();
      const point = { x: ev.clientX, y: ev.clientY };
      if (cardEl) {
        this.selectedId = cardEl.dataset.id;
        this._syncSelection();
        if (this.readOnly) {
          this.openCard(cardEl.dataset.id);
          return;
        }
        this._openCardMenu(null, cardEl.dataset.id, point);
        return;
      }
      if (colEl && !this.readOnly) this._openColumnMenu(null, colEl.dataset.col, point);
    }

    _onBoardDblClick(ev) {
      const target = eventEl(ev.target);
      if (!target) return;
      const cardEl = target.closest('.kb-card');
      if (!cardEl) return;
      if (target.closest('textarea, input, button, a')) return;
      this.openCard(cardEl.dataset.id);
    }

    _syncSelection() {
      this._cardEls.forEach((node, key) => {
        const id = key.includes('|') ? key.split('|')[1] : key;
        node.classList.toggle('is-selected', id === this.selectedId);
      });
    }

    _onBoardPointerDown(ev) {
      if (this.readOnly || ev.button !== 0 || this._drag) return;
      const target = eventEl(ev.target);
      if (!target) return;
      if (target.closest('input, textarea, select, button, a, [contenteditable="true"], .kb-col-foot, .kb-col-empty')) return;
      const cardEl = ev.target.closest('.kb-card');
      if (cardEl) {
        this.selectedId = cardEl.dataset.id;
        this._syncSelection();
        const rect = cardEl.getBoundingClientRect();
        this._pending = {
          type: 'card',
          id: cardEl.dataset.id,
          el: cardEl,
          x: ev.clientX,
          y: ev.clientY,
          dx: ev.clientX - rect.left,
          dy: ev.clientY - rect.top,
          w: rect.width,
          h: rect.height,
          lane: cardEl.closest('.kb-col-body') ? cardEl.closest('.kb-col-body').dataset.lane || '' : '',
        };
      } else {
        const head = ev.target.closest('.kb-col-head');
        const colEl = head && head.closest('.kb-col');
        if (!colEl || colEl.dataset.lane) return;
        const rect = colEl.getBoundingClientRect();
        this._pending = {
          type: 'column',
          id: colEl.dataset.col,
          el: colEl,
          x: ev.clientX,
          y: ev.clientY,
          dx: ev.clientX - rect.left,
          dy: ev.clientY - rect.top,
          w: rect.width,
        };
      }
      window.addEventListener('pointermove', this._onWindowPointerMove);
      window.addEventListener('pointerup', this._onWindowPointerUp);
    }

    _onDragMove(ev) {
      if (this._pending && !this._drag) {
        const far = Math.abs(ev.clientX - this._pending.x) + Math.abs(ev.clientY - this._pending.y);
        if (far < DRAG_THRESHOLD) return;
        this._beginDrag(ev);
      }
      if (!this._drag) return;
      ev.preventDefault();
      const d = this._drag;
      d.proxy.style.left = (ev.clientX - d.dx) + 'px';
      d.proxy.style.top = (ev.clientY - d.dy) + 'px';
      if (d.type === 'card') this._updateCardDropTarget(ev);
      else this._updateColumnDropTarget(ev);
      this._edgeScroll(ev);
    }

    _beginDrag(ev) {
      const p = this._pending;
      this._pending = null;
      const proxy = el('div', 'kb-drag-proxy');
      const clone = p.el.cloneNode(true);
      clone.classList.remove('is-selected');
      proxy.style.width = p.w + 'px';
      proxy.style.left = (ev.clientX - p.dx) + 'px';
      proxy.style.top = (ev.clientY - p.dy) + 'px';
      proxy.appendChild(clone);
      this.els.dragLayer.appendChild(proxy);
      this.els.root.classList.add('is-dragging');

      if (p.type === 'card') {
        const placeholder = el('div', 'kb-drop');
        placeholder.style.height = p.h + 'px';
        p.el.after(placeholder);
        p.el.style.display = 'none';
        this._drag = Object.assign({}, p, { proxy, placeholder });
      } else {
        p.el.classList.add('is-dragging');
        this._drag = Object.assign({}, p, { proxy });
      }
    }

    _updateCardDropTarget(ev) {
      const d = this._drag;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!under) return;
      let body = under.closest ? under.closest('.kb-col-body') : null;
      if (!body) {
        const colEl = under.closest ? under.closest('.kb-col') : null;
        if (colEl) body = colEl.querySelector('.kb-col-body');
      }
      if (!body) return;
      const col = this._column(body.dataset.col);
      if (col && col.collapsed) return;
      const cards = Array.from(body.children).filter((n) => n.classList.contains('kb-card') && n.style.display !== 'none');
      let before = null;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          before = cards[i];
          break;
        }
      }
      if (before) body.insertBefore(d.placeholder, before);
      else body.appendChild(d.placeholder);
      const empty = body.querySelector('.kb-col-empty');
      if (empty) empty.remove();
    }

    // Columns reorder live while dragging so the gap follows the pointer.
    _updateColumnDropTarget(ev) {
      const d = this._drag;
      const cols = Array.from(this.els.board.children).filter((n) => n.classList.contains('kb-col'));
      let beforeId = null;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].dataset.col === d.id) continue;
        const rect = cols[i].getBoundingClientRect();
        if (ev.clientX < rect.left + rect.width / 2) {
          beforeId = cols[i].dataset.col;
          break;
        }
      }
      const order = this.data.columns.map((c) => c.id).join(',');
      C.moveColumn(this.data, d.id, beforeId);
      if (this.data.columns.map((c) => c.id).join(',') !== order) this._renderColumns();
    }

    _edgeScroll(ev) {
      const track = this.data.view.groupBy ? this.els.lanes : this.els.board;
      const rect = track.getBoundingClientRect();
      if (ev.clientX > rect.right - EDGE_SCROLL) track.scrollLeft += 18;
      else if (ev.clientX < rect.left + EDGE_SCROLL) track.scrollLeft -= 18;
      if (this._drag && this._drag.type === 'card') {
        const body = this._drag.placeholder.parentElement;
        if (body && body.classList.contains('kb-col-body')) {
          const b = body.getBoundingClientRect();
          if (ev.clientY > b.bottom - 36) body.scrollTop += 14;
          else if (ev.clientY < b.top + 36) body.scrollTop -= 14;
        }
      }
    }

    _onDragEnd() {
      window.removeEventListener('pointermove', this._onWindowPointerMove);
      window.removeEventListener('pointerup', this._onWindowPointerUp);
      if (!this._drag) {
        this._pending = null;
        return;
      }
      const d = this._drag;
      if (d.type === 'card') {
        const body = d.placeholder.parentElement;
        const toCol = body && body.dataset.col;
        let beforeId = null;
        let next = d.placeholder.nextElementSibling;
        while (next && (!next.classList.contains('kb-card') || next.style.display === 'none')) next = next.nextElementSibling;
        if (next) beforeId = next.dataset.id;
        const laneId = body && body.dataset.lane;
        this._endDrag();
        if (toCol) {
          this._mutate(() => {
            const card = this.data.cards[d.id];
            if (!card) return false;
            if (laneId && laneId !== d.lane) this._applyLane(card, laneId);
            return C.moveCard(this.data, d.id, toCol, beforeId);
          });
        } else this.render();
      } else {
        const before = d.beforeOrder;
        this._endDrag();
        const order = this.data.columns.map((c) => c.id).join(',');
        if (before !== order) {
          this._pushHistory(d.snapshot);
          this._emit();
        }
        this.render();
      }
    }

    _endDrag(silent) {
      const d = this._drag;
      this._drag = null;
      this._pending = null;
      if (!d) return;
      if (d.proxy) d.proxy.remove();
      if (d.placeholder) d.placeholder.remove();
      if (d.el) {
        d.el.style.display = '';
        d.el.classList.remove('is-dragging');
      }
      if (this.els) this.els.root.classList.remove('is-dragging');
      if (silent) return;
    }

    // Dropping into a swimlane sets the grouped field on the card.
    _applyLane(card, laneId) {
      const by = this.data.view.groupBy;
      const value = laneId === '__none' ? null : laneId;
      if (by === 'assignee') card.assignee = value;
      else if (by === 'priority') card.priority = value;
      else if (by === 'label') {
        if (!value) card.labels = [];
        else if (!card.labels.includes(value)) card.labels = card.labels.concat(value);
      }
    }

    // --- column actions ---

    addColumn() {
      if (this.readOnly) return;
      const index = this.data.columns.length;
      const col = C.defaultColumn('New column', C.COLUMN_COLORS[(index + 1) % C.COLUMN_COLORS.length]);
      col.title = '';
      this._mutate(() => {
        this.data.columns.push(col);
      });
      const node = this._colEls.get(col.id);
      if (node) {
        node.scrollIntoView({ inline: 'end', block: 'nearest' });
        const input = node.querySelector('.kb-col-title');
        if (input) input.focus();
      }
    }

    toggleColumnCollapsed(id) {
      this._mutate(() => {
        const col = this._column(id);
        if (!col) return false;
        col.collapsed = !col.collapsed;
      });
    }

    deleteColumn(id) {
      const col = this._column(id);
      if (!col) return;
      const cards = C.cardList(this.data, id);
      if (cards.length) {
        const other = this.data.columns.find((c) => c.id !== id);
        if (!other) return;
        const ok = global.confirm(`Delete "${col.title || 'column'}"? Its ${cards.length} card(s) move to "${other.title}".`);
        if (!ok) return;
        this._mutate(() => {
          cards.forEach((card) => {
            card.columnId = other.id;
          });
          this.data.columns = this.data.columns.filter((c) => c.id !== id);
          C.reindex(this.data, other.id);
        });
        this._toast(`Column deleted, ${cards.length} card(s) moved`, 'Undo', () => this.undo());
        return;
      }
      this._mutate(() => {
        this.data.columns = this.data.columns.filter((c) => c.id !== id);
      });
      this._toast('Column deleted', 'Undo', () => this.undo());
    }

    _openColumnMenu(anchor, id, point) {
      const col = this._column(id);
      if (!col || this.readOnly) return;
      const menu = this._menu(anchor);
      menu.appendChild(el('div', 'kb-menu-label', 'Column'));
      this._menuItem(menu, 'Add card', 'plus', () => this.addCard(id));
      this._menuItem(menu, col.collapsed ? 'Expand' : 'Collapse', col.collapsed ? 'expand' : 'collapse', () => this.toggleColumnCollapsed(id));
      this._menuItem(menu, 'Rename', null, () => {
        const node = this._colEls.get(id);
        const input = node && node.querySelector('.kb-col-title');
        if (input) {
          input.focus();
          input.select();
        }
      });

      menu.appendChild(el('div', 'kb-menu-sep'));
      menu.appendChild(el('div', 'kb-menu-label', 'Sort cards by'));
      C.SORTS.forEach((mode) => {
        const labels = { manual: 'Manual order', due: 'Due date', priority: 'Priority', updated: 'Recently updated', title: 'Title' };
        const item = this._menuItem(menu, labels[mode], null, () => this._mutate(() => {
          col.sort = mode;
        }));
        item.classList.toggle('is-on', (col.sort || 'manual') === mode);
      });

      menu.appendChild(el('div', 'kb-menu-sep'));
      menu.appendChild(el('div', 'kb-menu-label', 'Work in progress limit'));
      const wipRow = el('div');
      const wip = document.createElement('input');
      wip.className = 'kb-input';
      wip.type = 'number';
      wip.min = '0';
      wip.placeholder = 'No limit';
      wip.value = col.wip || '';
      wip.addEventListener('change', () => {
        const n = Number(wip.value);
        this._mutate(() => {
          col.wip = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        });
      });
      wipRow.appendChild(wip);
      menu.appendChild(wipRow);

      menu.appendChild(el('div', 'kb-menu-label', 'Colour'));
      const sw = el('div', 'kb-swatches');
      C.COLUMN_COLORS.forEach((hex) => {
        const b = el('button', 'kb-swatch' + (col.color === hex ? ' is-on' : ''));
        b.type = 'button';
        b.style.background = hex;
        b.title = hex;
        b.addEventListener('click', () => {
          this._mutate(() => {
            col.color = hex;
          });
          this._closeMenu();
        });
        sw.appendChild(b);
      });
      menu.appendChild(sw);

      menu.appendChild(el('div', 'kb-menu-sep'));
      const del = this._menuItem(menu, 'Delete column', 'trash', () => this.deleteColumn(id));
      del.classList.add('is-danger');
      this._showMenu(anchor, point);
    }

    // --- card actions ---

    addCard(columnId, opts) {
      if (this.readOnly) return;
      const col = this._column(columnId);
      if (!col) return;
      const o = opts || {};
      const card = C.defaultCard(columnId, '');
      card.order = C.cardList(this.data, columnId).length;
      const lane = o.lane;
      this._mutate(() => {
        this.data.cards[card.id] = card;
        if (lane) this._applyLane(card, lane.id);
        if (col.collapsed) col.collapsed = false;
      });
      this.selectedId = card.id;
      this._syncSelection();
      this.startTitleEdit(card.id);
    }

    duplicateCard(id) {
      const card = this.data.cards[id];
      if (!card || this.readOnly) return;
      const copy = JSON.parse(JSON.stringify(card));
      copy.id = C.uid('card_');
      copy.createdAt = C.nowIso();
      copy.updatedAt = copy.createdAt;
      copy.checklist = (copy.checklist || []).map((item) => Object.assign({}, item, { id: C.uid('chk_') }));
      this._mutate(() => {
        this.data.cards[copy.id] = copy;
        const siblings = C.cardList(this.data, card.columnId).filter((c) => c.id !== copy.id);
        const at = siblings.findIndex((c) => c.id === card.id);
        const before = siblings[at + 1];
        C.moveCard(this.data, copy.id, card.columnId, before ? before.id : null);
      });
      this.selectedId = copy.id;
      this._syncSelection();
      this._toast('Card duplicated');
    }

    toggleArchive(id) {
      const card = this.data.cards[id];
      if (!card || this.readOnly) return;
      const archiving = !card.archived;
      this._mutate(() => {
        card.archived = archiving;
        card.updatedAt = C.nowIso();
      });
      if (archiving && this.detailId === id) this._closeDrawer();
      this._toast(archiving ? 'Card archived' : 'Card restored', 'Undo', () => this.undo());
    }

    deleteCard(id) {
      const card = this.data.cards[id];
      if (!card || this.readOnly) return;
      const label = card.title ? `"${card.title.slice(0, 60)}"` : 'this card';
      if (!global.confirm(`Delete ${label}? Archiving keeps it recoverable on the board.`)) return;
      const columnId = card.columnId;
      this._mutate(() => {
        delete this.data.cards[id];
        C.reindex(this.data, columnId);
      });
      if (this.detailId === id) this._closeDrawer();
      if (this.selectedId === id) this.selectedId = null;
      this._toast('Card deleted', 'Undo', () => this.undo());
    }

    _updateCard(id, fn) {
      const card = this.data.cards[id];
      if (!card) return;
      this._mutate(() => {
        fn(card);
        card.updatedAt = C.nowIso();
      });
    }

    startTitleEdit(id) {
      if (this.readOnly) return;
      // Finish whatever else is focused before the new editor exists. Safari
      // does not focus a button on click, so the board or column title is
      // often still active. Focusing the new field then blurs that title,
      // and its commit re-renders and throws the editor away.
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const typing = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
        if (typing && typeof active.blur === 'function') active.blur();
      }
      const node = this._cardEls.get(id) || this._cardEls.get(`__none|${id}`);
      const cardEl = (node && node.isConnected) ? node : Array.from(this._cardEls.values()).find((n) => n.isConnected && n.dataset.id === id);
      const card = this.data.cards[id];
      if (!cardEl || !card) return;
      const existing = cardEl.querySelector('.kb-card-edit');
      if (existing) {
        existing.focus();
        return;
      }
      const titleEl = cardEl.querySelector('.kb-card-title');
      if (!titleEl) return;
      const ta = el('textarea', 'kb-card-edit');
      ta.rows = 1;
      ta.value = card.title;
      ta.placeholder = 'Card title';
      titleEl.replaceWith(ta);
      cardEl.classList.add('is-editing');
      cardEl.dataset.sig = '';
      this._bindLiveField(ta, 'card-title', () => ({ id }), (node2) => autoSize(node2));
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          const columnId = card.columnId;
          ta.blur();
          if (card.title.trim()) this.addCard(columnId);
          return;
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ta.blur();
        }
      });
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoSize(ta);
      cardEl.scrollIntoView({ block: 'nearest' });
    }

    _openCardMenu(anchor, id, point) {
      const card = this.data.cards[id];
      if (!card || this.readOnly) return;
      const menu = this._menu(anchor);
      const drawerOpen = this.detailId === id && this.els.drawer.classList.contains('open');
      if (!drawerOpen) this._menuItem(menu, 'Open', null, () => this.openCard(id));
      this._menuItem(menu, 'Edit title', null, () => {
        if (this.detailId === id && this.els.drawer.classList.contains('open')) {
          this.drawerEls.titleInput.focus();
          this.drawerEls.titleInput.select();
          return;
        }
        this.startTitleEdit(id);
      });
      this._menuItem(menu, 'Duplicate', 'copy', () => this.duplicateCard(id));
      this._menuItem(menu, card.archived ? 'Restore from archive' : 'Archive', 'archive', () => this.toggleArchive(id));
      const others = (this.data.columns || []).filter((c) => c.id !== card.columnId);
      if (others.length) {
        menu.appendChild(el('div', 'kb-menu-sep'));
        menu.appendChild(el('div', 'kb-menu-label', 'Move to'));
        others.forEach((col) => {
          this._menuItem(menu, col.title || 'Column', null, () => {
            this._mutate(() => C.moveCard(this.data, id, col.id, null));
          });
        });
      }
      menu.appendChild(el('div', 'kb-menu-sep'));
      const del = this._menuItem(menu, 'Delete card', 'trash', () => this.deleteCard(id));
      del.classList.add('is-danger');
      this._showMenu(anchor, point);
    }

    // --- drawer ---

    openCard(id) {
      if (!this.data.cards[id]) return;
      this.detailId = id;
      this.selectedId = id;
      this.notesEditing = false;
      this._syncSelection();
      this.els.scrim.classList.add('open');
      this.els.drawer.classList.add('open');
      this._refreshDrawer();
      setTimeout(() => {
        if (this.detailId === id) this.drawerEls.titleInput.focus();
      }, 180);
    }

    _closeDrawer(immediate) {
      if (this._edit && this.els.drawer.contains(this._edit.el)) this.commitEdit();
      this.detailId = null;
      this.notesEditing = false;
      this.els.scrim.classList.remove('open');
      this.els.drawer.classList.remove('open');
      if (immediate) this.els.drawer.style.transition = 'none';
      else this.els.drawer.style.transition = '';
      if (immediate) {
        requestAnimationFrame(() => {
          this.els.drawer.style.transition = '';
        });
      }
    }

    _refreshDrawer() {
      const d = this.drawerEls;
      const card = this.detailId ? this.data.cards[this.detailId] : null;
      if (!card) return;
      const col = this._column(card.columnId);
      d.where.textContent = `${this.data.title || 'Board'} · ${col ? col.title : ''}` + (card.archived ? ' · archived' : '');

      if (document.activeElement !== d.titleInput) {
        d.titleInput.value = card.title;
        autoSize(d.titleInput);
      }
      d.titleInput.readOnly = this.readOnly;

      d.colSel.innerHTML = '';
      this.data.columns.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.title;
        d.colSel.appendChild(opt);
      });
      d.colSel.value = card.columnId;

      d.prioSel.innerHTML = '';
      [['', 'None']].concat(C.PRIORITIES.map((p) => [p.id, p.label])).forEach(([v, t]) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = t;
        d.prioSel.appendChild(opt);
      });
      d.prioSel.value = card.priority || '';

      d.whoSel.innerHTML = '';
      [['', 'Unassigned']].concat((this.data.members || []).map((m) => [m.id, m.name])).concat([['__new', '+ Add person…']]).forEach(([v, t]) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = t;
        d.whoSel.appendChild(opt);
      });
      d.whoSel.value = card.assignee || '';

      d.dueInput.value = card.due || '';
      [d.colSel, d.prioSel, d.whoSel, d.dueInput].forEach((n) => { n.disabled = this.readOnly; });

      d.labelRow.innerHTML = '';
      (this.data.labels || []).forEach((label) => {
        const chip = el('button', 'kb-chip');
        chip.type = 'button';
        const dot = el('span', 'kb-dot');
        dot.style.background = label.color;
        chip.append(dot, el('span', null, label.name));
        const on = (card.labels || []).includes(label.id);
        chip.classList.toggle('is-on', on);
        chip.style.background = on ? label.color : '';
        chip.addEventListener('click', () => this._updateCard(card.id, (c) => {
          c.labels = (c.labels || []).includes(label.id)
            ? c.labels.filter((x) => x !== label.id)
            : (c.labels || []).concat(label.id);
        }));
        d.labelRow.appendChild(chip);
      });
      if (!this.data.labels.length) d.labelRow.appendChild(el('span', 'kb-stamp', 'No labels yet — use Manage to create one.'));

      d.coverRow.innerHTML = '';
      const none = el('button', 'kb-chip', 'None');
      none.type = 'button';
      none.classList.toggle('is-on', !card.cover);
      if (!card.cover) none.style.background = 'var(--kb-accent)';
      none.addEventListener('click', () => this._updateCard(card.id, (c) => {
        c.cover = null;
      }));
      d.coverRow.appendChild(none);
      C.LABEL_COLORS.forEach((c) => {
        const b = el('button', 'kb-swatch' + (card.cover === c.hex ? ' is-on' : ''));
        b.type = 'button';
        b.style.background = c.hex;
        b.title = c.id;
        b.addEventListener('click', () => this._updateCard(card.id, (x) => {
          x.cover = c.hex;
        }));
        d.coverRow.appendChild(b);
      });

      d.notesToggle.textContent = this.notesEditing ? 'Preview' : 'Edit';
      d.notesToggle.style.display = this.readOnly ? 'none' : '';
      if (this.notesEditing) {
        d.notesView.style.display = 'none';
        d.notesInput.style.display = '';
        if (document.activeElement !== d.notesInput) {
          d.notesInput.value = card.notes || '';
          autoSize(d.notesInput);
        }
      } else {
        d.notesView.style.display = '';
        d.notesInput.style.display = 'none';
        d.notesView.innerHTML = renderMarkdown(card.notes);
      }

      const progress = C.checklistProgress(card);
      d.progress.style.display = progress.total ? 'flex' : 'none';
      d.progress.classList.toggle('is-done', progress.total > 0 && progress.done === progress.total);
      d.progressText.textContent = `${progress.done}/${progress.total}`;
      d.progressBar.firstChild.style.width = Math.round(progress.ratio * 100) + '%';
      d.checkAdd.style.display = this.readOnly ? 'none' : '';

      const activeItem = this._edit && this._edit.kind === 'check' ? this._edit.itemId : null;
      d.checkList.innerHTML = '';
      (card.checklist || []).forEach((item) => {
        const row = el('div', 'kb-check-row' + (item.done ? ' is-done' : ''));
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!item.done;
        box.disabled = this.readOnly;
        box.addEventListener('change', () => this._updateCard(card.id, (c) => {
          const it = (c.checklist || []).find((x) => x.id === item.id);
          if (it) it.done = box.checked;
        }));
        const text = el('textarea', 'kb-check-text');
        text.rows = 1;
        text.value = item.text;
        text.readOnly = this.readOnly;
        this._bindLiveField(text, 'check', () => ({ id: card.id, itemId: item.id }), (n) => autoSize(n));
        text.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            text.blur();
            this._addChecklistItem();
          }
          if (ev.key === 'Backspace' && !text.value) {
            ev.preventDefault();
            this._updateCard(card.id, (c) => {
              c.checklist = (c.checklist || []).filter((x) => x.id !== item.id);
            });
          }
        });
        const del = btn('kb-ghost kb-icon', '', 'close', 'Remove item');
        del.style.display = this.readOnly ? 'none' : '';
        del.addEventListener('click', () => this._updateCard(card.id, (c) => {
          c.checklist = (c.checklist || []).filter((x) => x.id !== item.id);
        }));
        row.append(box, text, del);
        d.checkList.appendChild(row);
        autoSize(text);
        if (activeItem === item.id) {
          text.focus();
          text.setSelectionRange(text.value.length, text.value.length);
        }
      });

      d.linkList.innerHTML = '';
      (card.links || []).forEach((link, i) => {
        const row = el('div', 'kb-link-row');
        const href = safeHttpUrl(link.url);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = link.title || link.url;
          a.title = href;
          row.appendChild(a);
        } else {
          const span = el('span', null, link.title || link.url);
          span.style.flex = '1 1 auto';
          span.title = 'Workspace path';
          row.appendChild(span);
        }
        const del = btn('kb-ghost kb-icon', '', 'close', 'Remove link');
        del.style.display = this.readOnly ? 'none' : '';
        del.addEventListener('click', () => this._updateCard(card.id, (c) => {
          c.links = (c.links || []).filter((x, j) => j !== i);
        }));
        row.appendChild(del);
        d.linkList.appendChild(row);
      });
      d.linkAdd.style.display = this.readOnly ? 'none' : '';

      d.archiveBtn.querySelector('span:last-child').textContent = card.archived ? 'Restore' : 'Archive';
      [d.archiveBtn, d.dupBtn, d.delBtn].forEach((b) => { b.style.display = this.readOnly ? 'none' : ''; });
      d.stamp.textContent = `Updated ${relativeStamp(card.updatedAt)}`;
      d.stamp.title = `Created ${card.createdAt}\nUpdated ${card.updatedAt}`;
    }

    _addChecklistItem() {
      const card = this.data.cards[this.detailId];
      if (!card || this.readOnly) return;
      const item = C.defaultChecklistItem('');
      this._mutate(() => {
        card.checklist = (card.checklist || []).concat(item);
        card.updatedAt = C.nowIso();
      });
      const rows = this.drawerEls.checkList.querySelectorAll('.kb-check-text');
      const last = rows[rows.length - 1];
      if (last) last.focus();
    }

    _addLink() {
      const card = this.data.cards[this.detailId];
      const input = this.drawerEls.linkUrl;
      const raw = input.value.trim();
      if (!card || !raw) return;
      this._updateCard(card.id, (c) => {
        c.links = (c.links || []).concat({ url: raw.slice(0, 600), title: '' });
      });
      input.value = '';
      this.drawerEls.linkEntry.style.display = 'none';
    }

    _promptNewMember() {
      const name = global.prompt('Name of the person');
      this.drawerEls.whoSel.value = this.data.cards[this.detailId] ? (this.data.cards[this.detailId].assignee || '') : '';
      if (!name || !name.trim()) return;
      const member = C.defaultMember(name.trim(), C.MEMBER_COLORS[this.data.members.length % C.MEMBER_COLORS.length]);
      const id = this.detailId;
      this._mutate(() => {
        this.data.members.push(member);
        const card = this.data.cards[id];
        if (card) card.assignee = member.id;
      });
    }

    _openLabelManager(anchor) {
      const menu = this._menu(anchor);
      menu.appendChild(el('div', 'kb-menu-label', 'Labels'));
      (this.data.labels || []).forEach((label) => {
        const row = el('div', 'kb-check-row');
        const dot = el('span', 'kb-dot');
        dot.style.cssText = `width:10px;height:10px;border-radius:50%;flex:0 0 auto;margin-top:5px;background:${label.color}`;
        const name = document.createElement('input');
        name.className = 'kb-check-text';
        name.type = 'text';
        name.value = label.name;
        name.addEventListener('change', () => this._mutate(() => {
          label.name = name.value.slice(0, 40) || 'Label';
        }));
        const cycle = btn('kb-ghost kb-icon', '', 'grid', 'Next colour');
        cycle.addEventListener('click', () => {
          const at = C.LABEL_COLORS.findIndex((c) => c.hex === label.color);
          const next = C.LABEL_COLORS[(at + 1 + C.LABEL_COLORS.length) % C.LABEL_COLORS.length];
          this._mutate(() => {
            label.color = next.hex;
          });
          dot.style.background = next.hex;
        });
        const del = btn('kb-ghost kb-icon', '', 'trash', 'Delete label');
        del.addEventListener('click', () => {
          this._mutate(() => {
            this.data.labels = this.data.labels.filter((l) => l.id !== label.id);
            Object.keys(this.data.cards).forEach((cid) => {
              const c = this.data.cards[cid];
              c.labels = (c.labels || []).filter((x) => x !== label.id);
            });
            const f = this.data.view.filters;
            f.labels = (f.labels || []).filter((x) => x !== label.id);
          });
          row.remove();
        });
        row.append(dot, name, cycle, del);
        menu.appendChild(row);
      });
      menu.appendChild(el('div', 'kb-menu-sep'));
      const add = document.createElement('input');
      add.className = 'kb-input';
      add.type = 'text';
      add.placeholder = 'New label name, then Enter';
      add.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const name = add.value.trim();
        if (!name) return;
        const color = C.LABEL_COLORS[this.data.labels.length % C.LABEL_COLORS.length];
        const label = C.defaultLabel(name, color.id);
        const cardId = this.detailId;
        this._mutate(() => {
          this.data.labels.push(label);
          const card = this.data.cards[cardId];
          if (card) card.labels = (card.labels || []).concat(label.id);
        });
        this._closeMenu();
      });
      menu.appendChild(add);
      this._showMenu(anchor);
      setTimeout(() => add.focus(), 30);
    }

    // --- menus ---

    _menu(anchor) {
      const menu = this.els.menu;
      menu.innerHTML = '';
      menu.dataset.anchor = (anchor && anchor.title) || '';
      return menu;
    }

    _menuItem(menu, label, iconName, onClick) {
      const item = el('button', 'kb-menu-item');
      item.type = 'button';
      if (iconName) {
        const span = el('span');
        span.innerHTML = icon(iconName);
        item.appendChild(span);
      }
      item.appendChild(el('span', null, label));
      item.addEventListener('click', () => {
        onClick();
        if (!menu.dataset.keepOpen) this._closeMenu();
      });
      menu.appendChild(item);
      return item;
    }

    _showMenu(anchor, point) {
      const menu = this.els.menu;
      menu.classList.add('open');
      menu.style.left = '0px';
      menu.style.top = '0px';
      const box = menu.getBoundingClientRect();
      let left;
      let top;
      if (point) {
        left = point.x;
        top = point.y;
      } else {
        const rect = anchor.getBoundingClientRect();
        left = rect.left;
        top = rect.bottom + 6;
        if (left + box.width > window.innerWidth - 10) left = Math.max(10, rect.right - box.width);
        if (top + box.height > window.innerHeight - 10) top = Math.max(10, rect.top - box.height - 6);
      }
      if (left + box.width > window.innerWidth - 10) left = Math.max(10, window.innerWidth - box.width - 10);
      if (top + box.height > window.innerHeight - 10) top = Math.max(10, window.innerHeight - box.height - 10);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    _closeMenu() {
      if (this.els) this.els.menu.classList.remove('open');
    }

    _openViewMenu(anchor) {
      const menu = this._menu(anchor);
      const view = this.data.view;
      menu.appendChild(el('div', 'kb-menu-label', 'Density'));
      C.DENSITIES.forEach((mode) => {
        const item = this._menuItem(menu, mode === 'compact' ? 'Compact' : 'Comfortable', null, () => {
          view.density = mode;
          this.render();
          this._emitLive();
        });
        item.classList.toggle('is-on', (view.density || 'comfortable') === mode);
      });
      menu.appendChild(el('div', 'kb-menu-sep'));
      menu.appendChild(el('div', 'kb-menu-label', 'Group into lanes'));
      [['', 'No lanes'], ['assignee', 'By assignee'], ['label', 'By label'], ['priority', 'By priority']].forEach(([id, label]) => {
        const item = this._menuItem(menu, label, null, () => {
          view.groupBy = id;
          this._resetCaches();
          this.render();
          this._emitLive();
        });
        item.classList.toggle('is-on', (view.groupBy || '') === id);
      });
      menu.appendChild(el('div', 'kb-menu-sep'));
      const arch = this._menuItem(menu, view.showArchived ? 'Hide archived cards' : 'Show archived cards', 'archive', () => {
        view.showArchived = !view.showArchived;
        this.render();
        this._emitLive();
      });
      arch.classList.toggle('is-on', !!view.showArchived);
      const labelText = this._menuItem(menu, view.labelText ? 'Labels as bars' : 'Labels with names', null, () => {
        view.labelText = !view.labelText;
        this.els.root.setAttribute('data-labels', view.labelText ? 'text' : 'bars');
        this._cardEls.forEach((node) => { node.dataset.sig = ''; });
        this.render();
        this._emitLive();
      });
      labelText.classList.toggle('is-on', !!view.labelText);
      menu.appendChild(el('div', 'kb-menu-sep'));
      this._menuItem(menu, 'Collapse all columns', 'collapse', () => this.collapseAll());
      this._menuItem(menu, 'Expand all columns', 'expand', () => this.expandAll());
      this._showMenu(anchor);
    }

    _openExportMenu(anchor) {
      const menu = this._menu(anchor);
      menu.appendChild(el('div', 'kb-menu-label', 'Export board'));
      this._menuItem(menu, 'PNG image', 'download', () => this._runExport('png'));
      this._menuItem(menu, 'SVG vector', 'download', () => this._runExport('svg'));
      this._menuItem(menu, 'PDF document', 'download', () => this._runExport('pdf'));
      this._menuItem(menu, 'CSV spreadsheet', 'download', () => this._runExport('csv'));
      menu.appendChild(el('div', 'kb-menu-sep'));
      this._menuItem(menu, 'Standalone HTML', 'download', async () => {
        try {
          await this.exportStandalone();
        } catch (err) {
          alert('Standalone export failed: ' + ((err && err.message) || err));
        }
      });
      this._menuItem(menu, 'Print', 'print', () => global.print());
      if (!this.readOnly) {
        menu.appendChild(el('div', 'kb-menu-sep'));
        this._menuItem(menu, 'Import cards from CSV', 'upload', () => this._importCsv());
      }
      this._showMenu(anchor);
    }

    // --- export ---

    async _runExport(format) {
      try {
        if (format === 'csv') {
          await this._doExport('csv', { name: this.data.title || 'kanban' });
          return;
        }
        await this._doExport(format, { name: this.data.title || 'kanban' });
      } catch (err) {
        alert('Export failed: ' + ((err && err.message) || err));
      }
    }

    async _doExport(format, opts) {
      // A standalone file has export.js inlined and no server to fetch from.
      const stale = !isStandaloneDoc() && global.KanbanExport && global.KanbanExport._v !== EXPORT_V;
      if (!global.KanbanExport || stale) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/kanban/export.js?v=1';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Export module failed to load'));
          document.body.appendChild(s);
        });
      }
      if (!global.KanbanExport) throw new Error('Export module failed to load');
      return global.KanbanExport.run(format, this.data, opts);
    }

    _importCsv() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const text = String(reader.result || '');
            let added = 0;
            this._mutate(() => {
              added = C.fromCsv(text, this.data).added;
              if (!added) return false;
              this._resetCaches();
            });
            this._toast(added ? `Imported ${added} card(s)` : 'Nothing to import', added ? 'Undo' : null, () => this.undo());
          } catch (err) {
            alert('Could not import CSV: ' + ((err && err.message) || err));
          }
        };
        reader.readAsText(file);
      });
      input.click();
    }

    async exportStandalone(filename) {
      const title = (this.data.title || 'Kanban').slice(0, 80);
      const json = JSON.stringify(C.normalize(this.data), null, 2).replace(/</g, '\\u003c');
      const html = await buildStandaloneHtml({
        kind: 'kanban',
        title,
        dataId: 'kanban-data',
        json,
        cssUrls: ['/kanban/engine.css'],
        jsUrls: ['/kanban/core.js', '/kanban/engine.js', '/kanban/export.js'],
      });
      downloadStandalone(html, filename || safeStandaloneName(title, 'kanban'));
    }

    // --- toast ---

    _toast(message, actionLabel, onAction) {
      const toast = this.els.toast;
      clearTimeout(this._toastTimer);
      toast.innerHTML = '';
      toast.appendChild(el('span', null, message));
      if (actionLabel && onAction) {
        const b = el('button', null, actionLabel);
        b.type = 'button';
        b.addEventListener('click', () => {
          toast.classList.remove('open');
          onAction();
        });
        toast.appendChild(b);
      }
      toast.classList.add('open');
      this._toastTimer = setTimeout(() => toast.classList.remove('open'), actionLabel ? 5200 : 2400);
    }

    // --- keyboard ---

    _handleKey(ev) {
      if (this._destroyed || !this.els.root.isConnected) return;
      if (this.container.classList.contains('hidden') || this.container.closest('.hidden')) return;
      const active = document.activeElement;
      const typing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);

      if (ev.key === 'Escape') {
        if (this.els.help.classList.contains('open')) {
          this.els.help.classList.remove('open');
          return;
        }
        if (this.els.menu.classList.contains('open')) {
          this._closeMenu();
          return;
        }
        if (typing && active.blur) {
          active.blur();
          return;
        }
        if (this.detailId) {
          this._closeDrawer();
          return;
        }
        return;
      }

      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z')) {
        if (typing) return;
        ev.preventDefault();
        if (ev.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && (ev.key === 'y' || ev.key === 'Y') && !typing) {
        ev.preventDefault();
        this.redo();
        return;
      }
      if (typing) return;
      if (!this.els.root.contains(active) && active !== document.body && active !== document.documentElement) return;

      if (ev.key === '?' || (ev.key === '/' && ev.shiftKey)) {
        ev.preventDefault();
        this.els.help.classList.toggle('open');
        return;
      }
      if (ev.key === '/') {
        ev.preventDefault();
        this._toggleFilterBar(true);
        return;
      }
      if (this.readOnly) return;

      const card = this.selectedId ? this.data.cards[this.selectedId] : null;

      if (ev.key === 'n' || ev.key === 'N') {
        ev.preventDefault();
        const colId = card ? card.columnId : (this.data.columns[0] && this.data.columns[0].id);
        if (colId) this.addCard(colId);
        return;
      }
      if (!card) {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
          const first = this.data.columns.map((c) => C.columnCards(this.data, c.id)[0]).find(Boolean);
          if (first) {
            ev.preventDefault();
            this.selectedId = first.id;
            this._syncSelection();
          }
        }
        return;
      }

      if (mod && ev.key.startsWith('Arrow')) {
        ev.preventDefault();
        if (ev.key === 'ArrowUp') this._mutate(() => C.nudgeCard(this.data, card.id, -1));
        else if (ev.key === 'ArrowDown') this._mutate(() => C.nudgeCard(this.data, card.id, 1));
        else if (ev.key === 'ArrowLeft') this._mutate(() => C.shiftCardColumn(this.data, card.id, -1));
        else this._mutate(() => C.shiftCardColumn(this.data, card.id, 1));
        const node = this._cardEls.get(card.id);
        if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
      if (mod && (ev.key === 'd' || ev.key === 'D')) {
        ev.preventDefault();
        this.duplicateCard(card.id);
        return;
      }
      if (ev.key.startsWith('Arrow')) {
        ev.preventDefault();
        this._moveSelection(card, ev.key);
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.startTitleEdit(card.id);
        return;
      }
      if (ev.key === 'e' || ev.key === 'E') {
        ev.preventDefault();
        this.openCard(card.id);
        return;
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        this.toggleArchive(card.id);
      }
    }

    _moveSelection(card, key) {
      const colIndex = this.data.columns.findIndex((c) => c.id === card.columnId);
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const list = C.columnCards(this.data, card.columnId);
        const at = list.findIndex((c) => c.id === card.id);
        const next = list[at + (key === 'ArrowDown' ? 1 : -1)];
        if (next) this.selectedId = next.id;
      } else {
        const dir = key === 'ArrowRight' ? 1 : -1;
        for (let i = colIndex + dir; i >= 0 && i < this.data.columns.length; i += dir) {
          const list = C.columnCards(this.data, this.data.columns[i].id);
          if (list.length) {
            const at = C.columnCards(this.data, card.columnId).findIndex((c) => c.id === card.id);
            this.selectedId = (list[at] || list[list.length - 1]).id;
            break;
          }
        }
      }
      this._syncSelection();
      const node = this._cardEls.get(this.selectedId);
      if (node) {
        node.focus({ preventScroll: true });
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  global.KanbanEngine = KanbanEngine;

  // --- standalone export ---------------------------------------------------

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
    if (html.getAttribute('data-docviewer') !== 'kanban') return;
    const host = document.getElementById('accretion-root');
    const dataEl = document.getElementById('kanban-data');
    if (!host || !dataEl || typeof KanbanEngine !== 'function' || !global.KanbanCore) return;
    global.__accretionStandalone = true;
    const engine = new KanbanEngine(host, { onChange: function () {} });
    const wrap = '<html data-docviewer="kanban"><script type="application/json" id="kanban-data">' + dataEl.textContent + '</script></html>';
    engine.loadFromHtml(wrap);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
    else bootStandalone();
  }
})(typeof window !== 'undefined' ? window : this);
