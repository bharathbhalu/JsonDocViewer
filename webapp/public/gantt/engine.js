/* DocViewer gantt engine — timeline, dependencies, and standalone export. */
(function (global) {
  const C = global.GanttCore;
  if (!C) return;

  const EXPORT_V = 10;
  const ROW = 40;
  const DRAG = 4;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-2',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h2',
    download: 'M12 4v10M8 10l4 4 4-4M5 20h14',
    help: 'M12 18h.01M9.1 9a3 3 0 1 1 4.2 2.7c-.7.4-1.3 1-1.3 1.8V14',
    diamond: 'M12 3l8 9-8 9-8-9 8-9z',
  };
  const PRIORITY_LABEL = { '': 'None', low: 'Low', medium: 'Medium', high: 'High' };
  const SHEET_HEADS = ['Task', 'Type', 'Assignee', 'Priority', 'Labels', '%', 'Start', 'End', 'Days', 'Depends', 'Notes'];

  function chipInk(hex) {
    const s = String(hex || '').replace('#', '');
    if (s.length !== 6) return '#fff';
    const n = parseInt(s, 16);
    if (!Number.isFinite(n)) return '#fff';
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 158 ? '#1c2330' : '#fff';
  }

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

  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function avatarHue(name) {
    const s = String(name || '');
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return n;
  }

  function btn(cls, label, iconName, title) {
    const b = el('button', 'gt-btn ' + (cls || ''));
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

  function shortDate(iso) {
    const ms = C.parseDay(iso);
    if (ms == null) return '';
    const d = new Date(ms);
    return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate();
  }

  function monthLabel(iso) {
    const ms = C.parseDay(iso);
    if (ms == null) return '';
    const d = new Date(ms);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function depPath(x1, y1, x2, y2) {
    if (x2 >= x1 + 14) {
      const mid = Math.round((x1 + x2) / 2);
      return 'M ' + x1 + ' ' + y1 + ' H ' + mid + ' V ' + y2 + ' H ' + x2;
    }
    const out = x1 + 14;
    const back = x2 - 14;
    const midY = y1 + (y2 >= y1 ? 18 : -18);
    return 'M ' + x1 + ' ' + y1 + ' H ' + out + ' V ' + midY + ' H ' + back + ' V ' + y2 + ' H ' + x2;
  }

  class GanttEngine {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.onChange = this.opts.onChange || function () {};
      this.readOnly = !!this.opts.readOnly;
      this.data = C.createEmpty();
      this.selectedId = null;
      this.selectedLink = null;
      this.detailId = null;
      this._edit = null;
      this._editBefore = null;
      this._emitTimer = 0;
      this._undo = [];
      this._redo = [];
      this._drag = null;
      this._pending = null;
      this._ghost = null;
      this._dropLine = null;
      this._suppressClick = false;
      this._lastListClick = null;
      this._scrollLock = false;
      this._toastTimer = 0;
      this._filterTimer = 0;
      this._destroyed = false;
      this._buildDom();
      this._bind();
      this.render();
    }

    static isGanttHtml(html) { return C.isGanttHtml(html); }
    static parseHtml(html) { return C.parseHtml(html); }
    static serializeToHtml(data) { return C.serializeToHtml(data); }

    destroy() {
      this._destroyed = true;
      this._clearReparentUi();
      this._teardownEdit();
      this._unbind();
      clearTimeout(this._emitTimer);
      clearTimeout(this._toastTimer);
      this.container.innerHTML = '';
      this.container.classList.remove('gt-host');
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
      this.selectedLink = null;
      this.detailId = null;
      this._undo = [];
      this._redo = [];
      this._closeDrawer(true);
      this.render();
    }

    serializeToHtml() {
      return C.serializeToHtml(this.data, this.data.title);
    }

    collapseAll() {
      this._mutate(() => {
        Object.keys(this.data.tasks).forEach((id) => {
          if (C.hasChildren(this.data, id)) this.data.tasks[id].collapsed = true;
        });
      });
    }

    expandAll() {
      this._mutate(() => {
        Object.keys(this.data.tasks).forEach((id) => {
          this.data.tasks[id].collapsed = false;
        });
      });
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
      const task = this.data.tasks[e.id];
      if (!task) return;
      if (e.kind === 'task-title' || e.kind === 'detail-title') {
        task.title = String(value || '').slice(0, 200);
        task.updatedAt = C.nowIso();
        return;
      }
      if (e.kind === 'notes') {
        task.notes = String(value || '').slice(0, 20000);
        task.updatedAt = C.nowIso();
        return;
      }
      if (e.kind === 'assignee') {
        task.assignee = String(value || '').slice(0, 80);
        task.updatedAt = C.nowIso();
      }
    }

    _bindLiveField(node, kind, getId) {
      node.addEventListener('focus', () => {
        if (this.readOnly) return;
        this._edit = Object.assign({ kind, el: node }, getId ? getId() : {});
        this._editBefore = JSON.stringify(this.data);
      });
      node.addEventListener('input', () => {
        if (this.readOnly) return;
        if (!this._edit || this._edit.el !== node) {
          this._edit = Object.assign({ kind, el: node }, getId ? getId() : {});
          if (this._editBefore == null) this._editBefore = JSON.stringify(this.data);
        }
        this._writeEdit(this._edit, node.value);
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
      if (this._suppressChange || this.readOnly) return;
      this.onChange(this.data);
    }

    _emitLive() {
      if (this._suppressChange || this.readOnly) return;
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
      if (this.detailId && !this.data.tasks[this.detailId]) this._closeDrawer(true);
      if (this.selectedId && !this.data.tasks[this.selectedId]) this.selectedId = null;
      this.render();
      this._refreshDrawer();
      this._syncHistory();
      this._emit();
    }

    _buildDom() {
      this.container.innerHTML = '';
      this.container.classList.add('gt-host');
      const root = el('div', 'gt-root');
      root.tabIndex = -1;
      if (this.readOnly) root.classList.add('is-readonly');

      const top = el('div', 'gt-top');
      const title = document.createElement('input');
      title.className = 'gt-title';
      title.type = 'text';
      title.placeholder = 'Gantt';
      title.setAttribute('aria-label', 'Chart title');
      const stats = el('div', 'gt-stats');
      const zoom = el('div', 'gt-zoom');
      zoom.setAttribute('role', 'group');
      zoom.setAttribute('aria-label', 'Zoom');
      ['day', 'week', 'month'].forEach((z) => {
        const b = btn('', z[0].toUpperCase() + z.slice(1), null, 'Zoom to ' + z);
        b.dataset.zoom = z;
        zoom.appendChild(b);
      });
      const mode = el('div', 'gt-zoom gt-mode');
      mode.setAttribute('role', 'group');
      mode.setAttribute('aria-label', 'View');
      [['chart', 'Timeline'], ['sheet', 'Sheet'], ['analytics', 'Analytics']].forEach((pair) => {
        const hint = pair[0] === 'sheet'
          ? 'Show task fields in rows'
          : pair[0] === 'analytics'
            ? 'Show progress, risk, and workload'
            : 'Show the Gantt chart';
        const b = btn('', pair[1], null, hint);
        b.dataset.mode = pair[0];
        mode.appendChild(b);
      });
      const todayBtn = btn('gt-ghost gt-today', 'Today', null, 'Scroll to today (T)');
      const addBtn = btn('gt-primary', 'Task', 'plus', 'Add a task (N)');
      const subBtn = btn('gt-ghost', 'Subtask', 'plus', 'Add a subtask under the selected task');
      subBtn.disabled = true;
      const mileBtn = btn('gt-ghost', 'Milestone', 'diamond', 'Add a milestone (M)');
      const undoBtn = btn('gt-ghost gt-icon', '', 'undo', 'Undo');
      const redoBtn = btn('gt-ghost gt-icon', '', 'redo', 'Redo');
      const exportBtn = btn('gt-ghost gt-icon', '', 'download', 'Export');
      const helpBtn = btn('gt-ghost gt-icon', '', 'help', 'Shortcuts (?)');
      top.append(title, stats, el('div', 'gt-spacer'), mode, zoom, todayBtn, addBtn, subBtn, mileBtn, el('div', 'gt-sep'), undoBtn, redoBtn, exportBtn, helpBtn);

      const filterbar = el('div', 'gt-filterbar');
      const search = document.createElement('input');
      search.className = 'gt-filter-search';
      search.type = 'search';
      search.placeholder = 'Search tasks, people, notes';
      search.setAttribute('aria-label', 'Search tasks');
      function filterSelect(key, label, options) {
        const sel = document.createElement('select');
        sel.className = 'gt-filter-select';
        sel.dataset.filter = key;
        sel.setAttribute('aria-label', label);
        options.forEach((pair) => {
          const opt = document.createElement('option');
          opt.value = pair[0];
          opt.textContent = pair[1];
          sel.appendChild(opt);
        });
        return sel;
      }
      const kindSel = filterSelect('kind', 'Type', [['', 'All types'], ['task', 'Tasks'], ['summary', 'Summaries'], ['milestone', 'Milestones']]);
      const priSel = filterSelect('priority', 'Priority', [['', 'All priorities'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['none', 'No priority']]);
      const progSel = filterSelect('progress', 'Progress', [['', 'Any progress'], ['todo', 'Not started'], ['doing', 'In progress'], ['done', 'Done']]);
      const whoSel = filterSelect('assignee', 'Assignee', [['', 'Anyone']]);
      const labelSel = filterSelect('label', 'Label', [['', 'All labels']]);
      const clearBtn = btn('gt-ghost', 'Clear', null, 'Clear search and filters');
      filterbar.append(search, kindSel, priSel, progSel, whoSel, labelSel, clearBtn);

      const main = el('div', 'gt-main');
      const list = el('div', 'gt-list');
      const listPane = el('div', 'gt-list-pane');
      const listHead = el('div', 'gt-list-head', 'Task');
      const listRows = el('div', 'gt-list-rows');
      listPane.append(listHead, listRows);
      list.appendChild(listPane);
      const time = el('div', 'gt-time');
      const headClip = el('div', 'gt-time-head-clip');
      const timeHead = el('div', 'gt-time-head');
      headClip.appendChild(timeHead);
      const timeClip = el('div', 'gt-time-clip');
      const timeBody = el('div', 'gt-time-body');
      timeClip.appendChild(timeBody);
      time.append(headClip, timeClip);
      const analytics = el('div', 'gt-analytics');
      analytics.setAttribute('aria-label', 'Analytics');
      main.append(list, time, analytics);

      const scrim = el('div', 'gt-scrim');
      const drawer = this._buildDrawer();
      const menu = el('div', 'gt-menu');
      const toast = el('div', 'gt-toast');
      const help = el('div', 'gt-help');
      const panel = el('div', 'gt-help-panel');
      panel.appendChild(el('h3', null, 'Gantt shortcuts'));
      ['N new task', 'M milestone', 'Enter rename', 'E details', 'Sheet lists every field', 'Analytics shows progress and risk', 'Labels and custom colours live in details', '/ search', 'Drag a row to nest or reorder', 'Tab indent', 'Shift+Tab outdent', 'Arrows select', '⌘← → move a day', '⌘D duplicate', 'Delete remove task or selected link', 'T today', '⌘Z undo', '? help'].forEach((line) => {
        panel.appendChild(el('p', null, line));
      });
      const helpClose = btn('gt-ghost', 'Close');
      helpClose.type = 'button';
      panel.appendChild(helpClose);
      help.appendChild(panel);
      helpClose.addEventListener('click', () => help.classList.remove('open'));

      root.append(top, filterbar, main, scrim, drawer.el, menu, toast, help);
      this.container.appendChild(root);
      this.els = {
        root, title, stats, mode, zoom, todayBtn, addBtn, subBtn, mileBtn, undoBtn, redoBtn, exportBtn, helpBtn,
        filterbar, search, kindSel, priSel, progSel, whoSel, labelSel, clearBtn,
        list, listPane, listHead, listRows, time, headClip, timeHead, timeClip, timeBody, analytics, scrim, menu, toast, help,
      };
      this.drawer = drawer;
    }

    _buildDrawer() {
      const wrap = el('div', 'gt-drawer');
      const head = el('div', 'gt-drawer-head');
      const closeBtn = btn('gt-ghost gt-icon', '', null, 'Close');
      closeBtn.textContent = '×';
      const headTitle = el('strong', null, 'Task');
      head.append(closeBtn, headTitle);
      const body = el('div', 'gt-drawer-body');
      const title = document.createElement('input');
      title.className = 'gt-input';
      title.type = 'text';
      title.setAttribute('aria-label', 'Task title');
      const dates = el('div', 'gt-split');
      const start = document.createElement('input');
      start.className = 'gt-input';
      start.type = 'date';
      const end = document.createElement('input');
      end.className = 'gt-input';
      end.type = 'date';
      const startField = el('label', 'gt-field');
      startField.append(el('span', null, 'Start'), start);
      const endField = el('label', 'gt-field');
      endField.append(el('span', null, 'End'), end);
      dates.append(startField, endField);
      const progress = document.createElement('input');
      progress.className = 'gt-input';
      progress.type = 'range';
      progress.min = '0';
      progress.max = '100';
      const progressLabel = el('span', null, 'Progress');
      const progressField = el('label', 'gt-field');
      progressField.append(progressLabel, progress);
      const milestone = document.createElement('input');
      milestone.type = 'checkbox';
      const mileField = el('label', 'gt-field');
      const mileRow = el('span');
      mileRow.append(milestone, document.createTextNode(' Milestone'));
      mileField.appendChild(mileRow);
      const assignee = document.createElement('input');
      assignee.className = 'gt-input';
      assignee.type = 'text';
      assignee.placeholder = 'Name';
      const whoField = el('label', 'gt-field');
      whoField.append(el('span', null, 'Assignee'), assignee);
      const priority = document.createElement('select');
      priority.className = 'gt-input';
      C.PRIORITIES.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = PRIORITY_LABEL[p] || 'None';
        priority.appendChild(opt);
      });
      const priField = el('label', 'gt-field');
      priField.append(el('span', null, 'Priority'), priority);
      const labels = el('div', 'gt-label-box');
      const labelApplied = el('div', 'gt-label-applied');
      const labelCatalog = el('div', 'gt-label-catalog');
      const labelNew = el('div', 'gt-label-new');
      const labelName = document.createElement('input');
      labelName.className = 'gt-input';
      labelName.type = 'text';
      labelName.maxLength = 32;
      labelName.placeholder = 'New label';
      labelName.setAttribute('aria-label', 'New label name');
      const labelColor = document.createElement('input');
      labelColor.className = 'gt-color-input';
      labelColor.type = 'color';
      labelColor.value = C.COLORS[0];
      labelColor.setAttribute('aria-label', 'New label colour');
      const labelAdd = btn('gt-ghost', 'Add');
      labelNew.append(labelName, labelColor, labelAdd);
      labels.append(labelApplied, labelCatalog, labelNew);
      const labelsField = el('div', 'gt-field');
      labelsField.append(el('span', null, 'Labels'), labels);
      const notes = document.createElement('textarea');
      notes.placeholder = 'Notes';
      const notesField = el('label', 'gt-field');
      notesField.append(el('span', null, 'Notes'), notes);
      const swatches = el('div', 'gt-swatches');
      const colorField = el('div', 'gt-field');
      colorField.append(el('span', null, 'Colour'), swatches);
      const deps = el('div', 'gt-deps-list');
      const depsField = el('div', 'gt-field');
      depsField.append(el('span', null, 'Depends on'), deps);
      body.append(title, dates, progressField, mileField, whoField, priField, labelsField, colorField, depsField, notesField);
      const foot = el('div', 'gt-drawer-foot');
      const dupBtn = btn('gt-ghost', 'Duplicate');
      const delBtn = btn('gt-ghost gt-danger', 'Delete');
      foot.append(dupBtn, delBtn);
      wrap.append(head, body, foot);
      return {
        el: wrap, closeBtn, headTitle, title, start, end, progress, progressLabel, milestone, assignee, priority,
        notes, swatches, deps, dupBtn, delBtn, labelApplied, labelCatalog, labelName, labelColor, labelAdd,
      };
    }

    _bind() {
      const e = this.els;
      const d = this.drawer;
      this._onDocPointerDown = (ev) => {
        if (!e.menu.contains(ev.target)) this._closeMenu();
      };
      this._onKey = (ev) => this._handleKey(ev);
      this._onMove = (ev) => this._onDragMove(ev);
      this._onUp = (ev) => this._onDragEnd(ev);
      document.addEventListener('pointerdown', this._onDocPointerDown, true);
      document.addEventListener('keydown', this._onKey);
      this._bindLiveField(e.title, 'board-title');
      e.title.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          e.title.blur();
        }
      });
      e.zoom.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-zoom]');
        if (!b || this.readOnly) return;
        this._mutate(() => {
          this.data.view.zoom = b.dataset.zoom;
        });
      });
      e.mode.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-mode]');
        if (!b) return;
        const next = C.MODES.indexOf(b.dataset.mode) >= 0 ? b.dataset.mode : 'chart';
        if (this.readOnly) {
          this.data.view.mode = next;
          this.render();
          return;
        }
        this._mutate(() => {
          this.data.view.mode = next;
        });
      });
      e.todayBtn.addEventListener('click', () => this.scrollToToday());
      e.search.addEventListener('input', () => {
        clearTimeout(this._filterTimer);
        this._filterTimer = setTimeout(() => {
          this._applyFilters({ text: e.search.value.slice(0, 120) });
        }, 80);
      });
      [e.kindSel, e.priSel, e.progSel, e.whoSel, e.labelSel].forEach((sel) => {
        sel.addEventListener('change', () => {
          const patch = {};
          patch[sel.dataset.filter] = sel.value;
          this._applyFilters(patch);
        });
      });
      e.clearBtn.addEventListener('click', () => {
        e.search.value = '';
        this.data.view.filters = C.defaultFilters();
        this._applyFilters(C.defaultFilters());
      });
      e.addBtn.addEventListener('click', () => this.addTask({}));
      e.subBtn.addEventListener('click', () => {
        if (!this.selectedId) return;
        this.addTask({ child: true });
      });
      e.mileBtn.addEventListener('click', () => this.addTask({ milestone: true }));
      e.undoBtn.addEventListener('click', () => this.undo());
      e.redoBtn.addEventListener('click', () => this.redo());
      e.exportBtn.addEventListener('click', () => this._openExportMenu(e.exportBtn));
      e.helpBtn.addEventListener('click', () => e.help.classList.toggle('open'));
      e.listRows.addEventListener('click', (ev) => this._onListClick(ev));
      e.listRows.addEventListener('pointerdown', (ev) => this._onListPointerDown(ev));
      e.listRows.addEventListener('dblclick', (ev) => this._onOpenClick(ev));
      e.timeClip.addEventListener('click', (ev) => this._onTimeClick(ev));
      e.timeClip.addEventListener('dblclick', (ev) => this._onOpenClick(ev));
      e.timeBody.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
      e.root.addEventListener('contextmenu', (ev) => this._onContextMenu(ev));
      e.listRows.addEventListener('scroll', () => this._syncScroll('list'));
      e.timeClip.addEventListener('scroll', () => this._syncScroll('time'));
      e.listRows.addEventListener('mouseover', (ev) => this._hover(ev));
      e.timeClip.addEventListener('mouseover', (ev) => this._hover(ev));
      e.analytics.addEventListener('click', (ev) => this._onAnalyticsClick(ev));
      e.scrim.addEventListener('click', () => this._closeDrawer());
      d.closeBtn.addEventListener('click', () => this._closeDrawer());
      this._bindLiveField(d.title, 'detail-title', () => ({ id: this.detailId }));
      this._bindLiveField(d.notes, 'notes', () => ({ id: this.detailId }));
      this._bindLiveField(d.assignee, 'assignee', () => ({ id: this.detailId }));
      d.start.addEventListener('change', () => this._setDates());
      d.end.addEventListener('change', () => this._setDates());
      d.progress.addEventListener('change', () => {
        if (!this.detailId) return;
        this._mutate(() => C.setProgress(this.data, this.detailId, d.progress.value));
      });
      d.milestone.addEventListener('change', () => this._toggleMilestone());
      d.priority.addEventListener('change', () => {
        if (!this.detailId || this.readOnly) return;
        this._mutate(() => {
          const task = this.data.tasks[this.detailId];
          if (!task) return false;
          task.priority = C.PRIORITIES.indexOf(d.priority.value) >= 0 ? d.priority.value : '';
          task.updatedAt = C.nowIso();
        });
      });
      d.labelAdd.addEventListener('click', () => this._addDrawerLabel());
      d.labelName.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          this._addDrawerLabel();
        }
      });
      d.dupBtn.addEventListener('click', () => {
        if (this.detailId) this.duplicateTask(this.detailId);
      });
      d.delBtn.addEventListener('click', () => {
        if (this.detailId) this.deleteTask(this.detailId);
      });
    }

    _unbind() {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
      document.removeEventListener('keydown', this._onKey);
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
    }

    _syncScroll(from) {
      if (this._scrollLock) return;
      this._scrollLock = true;
      if (from === 'list') this.els.timeClip.scrollTop = this.els.listRows.scrollTop;
      else {
        this.els.listRows.scrollTop = this.els.timeClip.scrollTop;
        this.els.headClip.scrollLeft = this.els.timeClip.scrollLeft;
      }
      this._scrollLock = false;
    }

    _syncHistory() {
      if (!this.els) return;
      this.els.undoBtn.disabled = this.readOnly || !this._undo.length;
      this.els.redoBtn.disabled = this.readOnly || !this._redo.length;
    }

    _hover(ev) {
      const target = eventEl(ev.target);
      const row = target && target.closest('[data-id]');
      const id = row ? row.dataset.id : '';
      this.els.root.querySelectorAll('.is-hover').forEach((n) => n.classList.remove('is-hover'));
      if (!id) return;
      this.els.root.querySelectorAll('[data-id="' + CSS.escape(id) + '"]').forEach((n) => {
        if (n.classList.contains('gt-row') || n.classList.contains('gt-time-row')) n.classList.add('is-hover');
      });
    }

    _viewMode() {
      const m = this.data.view && this.data.view.mode;
      return C.MODES.indexOf(m) >= 0 ? m : 'chart';
    }

    _isSheet() {
      return this._viewMode() === 'sheet';
    }

    _isAnalytics() {
      return this._viewMode() === 'analytics';
    }

    _filters() {
      if (!this.data.view) this.data.view = C.defaultView();
      if (!this.data.view.filters) this.data.view.filters = C.defaultFilters();
      return this.data.view.filters;
    }

    _applyFilters(patch) {
      const next = Object.assign({}, this._filters(), patch || {});
      this.data.view.filters = next;
      this.render();
      this._emitLive();
    }

    _shownTasks() {
      return C.filteredTasks(this.data);
    }

    _syncFilters() {
      const e = this.els;
      const f = this._filters();
      if (document.activeElement !== e.search) e.search.value = f.text || '';
      e.kindSel.value = f.kind || '';
      e.priSel.value = f.priority || '';
      e.progSel.value = f.progress || '';
      const labs = C.labelsList(this.data);
      const keepLab = e.labelSel.value;
      e.labelSel.innerHTML = '';
      [['', 'All labels'], ['__none__', 'No labels']].concat(labs.map((l) => [l.id, l.name])).forEach((pair) => {
        const opt = document.createElement('option');
        opt.value = pair[0];
        opt.textContent = pair[1];
        e.labelSel.appendChild(opt);
      });
      e.labelSel.value = f.label || keepLab || '';
      if (![...e.labelSel.options].some((o) => o.value === e.labelSel.value)) e.labelSel.value = '';
      const people = [];
      Object.keys(this.data.tasks || {}).forEach((id) => {
        const who = String(this.data.tasks[id].assignee || '').trim();
        if (who && people.indexOf(who) < 0) people.push(who);
      });
      people.sort((a, b) => a.localeCompare(b));
      const keep = e.whoSel.value;
      e.whoSel.innerHTML = '';
      [['', 'Anyone'], ['__none__', 'Unassigned']].concat(people.map((n) => [n, n])).forEach((pair) => {
        const opt = document.createElement('option');
        opt.value = pair[0];
        opt.textContent = pair[1];
        e.whoSel.appendChild(opt);
      });
      e.whoSel.value = f.assignee || keep || '';
      if (![...e.whoSel.options].some((o) => o.value === e.whoSel.value)) e.whoSel.value = '';
      e.filterbar.classList.toggle('is-on', C.hasActiveFilter(f));
      e.clearBtn.disabled = !C.hasActiveFilter(f);
    }

    _captureSheetFocus() {
      const n = document.activeElement;
      if (!n || !n.dataset || !n.dataset.gtField || !this.els.root.contains(n)) return null;
      const row = n.closest('[data-id]');
      return {
        id: row && row.dataset.id,
        field: n.dataset.gtField,
        start: n.selectionStart,
        end: n.selectionEnd,
      };
    }

    _restoreSheetFocus(snap) {
      if (!snap || !snap.id || !snap.field) return;
      const node = this.els.listRows.querySelector('[data-id="' + CSS.escape(snap.id) + '"] [data-gt-field="' + snap.field + '"]');
      if (!node || typeof node.focus !== 'function') return;
      node.focus();
      if (node.setSelectionRange && snap.start != null) {
        try { node.setSelectionRange(snap.start, snap.end); } catch (e) { /* ignore */ }
      }
    }

    render() {
      if (this._destroyed) return;
      const focus = this._captureSheetFocus();
      const pane = this.els.listPane;
      const top = this._isSheet() && pane ? pane.scrollTop : this.els.listRows.scrollTop;
      const left = this._isSheet() && pane ? pane.scrollLeft : this.els.timeClip.scrollLeft;
      this._renderTop();
      if (this._isAnalytics()) this._renderAnalytics();
      else this._renderChart();
      if (this._isSheet() && pane) {
        pane.scrollTop = top;
        pane.scrollLeft = left;
      } else if (!this._isAnalytics()) {
        this.els.listRows.scrollTop = top;
        this.els.timeClip.scrollLeft = left;
        this.els.headClip.scrollLeft = left;
      }
      this._restoreSheetFocus(focus);
      this._syncHistory();
    }

    _renderTop() {
      const e = this.els;
      if (document.activeElement !== e.title) e.title.value = this.data.title || '';
      e.title.readOnly = this.readOnly;
      const tasks = this._shownTasks();
      const total = Object.keys(this.data.tasks || {}).length;
      const miles = tasks.filter((t) => t.milestone).length;
      const shown = tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + (miles ? ' · ' + miles + ' milestone' + (miles === 1 ? '' : 's') : '');
      if (this._isAnalytics()) {
        const stats = C.analyze(this.data);
        const extra = stats.health.overdue ? ' · ' + stats.health.overdue + ' overdue' : '';
        e.stats.textContent = stats.total
          ? stats.progress + '% complete' + extra + (C.hasActiveFilter(this._filters()) ? ' · ' + stats.total + ' of ' + total : '')
          : (C.hasActiveFilter(this._filters()) ? 'No matches' : 'No tasks');
      } else {
        e.stats.textContent = C.hasActiveFilter(this._filters()) ? tasks.length + ' of ' + total + ' shown' : shown;
      }
      this._syncFilters();
      const mode = this._viewMode();
      e.root.classList.toggle('is-sheet', mode === 'sheet');
      e.root.classList.toggle('is-analytics', mode === 'analytics');
      e.mode.querySelectorAll('[data-mode]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.mode === mode);
      });
      e.zoom.querySelectorAll('[data-zoom]').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.zoom === (this.data.view.zoom || 'day'));
      });
      [e.addBtn, e.mileBtn].forEach((b) => {
        b.disabled = this.readOnly;
      });
      e.subBtn.disabled = this.readOnly || !this.selectedId || !this.data.tasks[this.selectedId];
    }

    _taskColor(task) {
      if (task.color) return task.color;
      let cur = task;
      const seen = new Set();
      while (cur && cur.parentId && this.data.tasks[cur.parentId] && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = this.data.tasks[cur.parentId];
      }
      if (cur && cur.color) return cur.color;
      const roots = C.childrenOf(this.data, null);
      const at = Math.max(0, roots.findIndex((r) => cur && r.id === cur.id));
      return C.COLORS[at % C.COLORS.length];
    }

    _renderChart() {
      const tasks = this._shownTasks();
      const sheet = this._isSheet();
      this._paintListHead(sheet);
      const range = C.chartBounds(this.data);
      const px = C.pxPerDay(this.data.view.zoom);
      const days = C.diffDays(range.start, range.end) + 1;
      const width = days * px;
      this._range = range;
      this._px = px;
      this.els.listRows.innerHTML = '';
      this.els.timeHead.innerHTML = '';
      this.els.timeBody.innerHTML = '';
      this.els.timeHead.style.width = width + 'px';
      this.els.timeBody.style.width = width + 'px';
      this.els.timeBody.style.minHeight = Math.max(tasks.length * ROW, this.els.timeClip.clientHeight || 0) + 'px';
      this.els.timeBody.style.setProperty('--px', px + 'px');

      if (!tasks.length) {
        const empty = el('div', 'gt-empty');
        if (C.hasActiveFilter(this._filters())) {
          empty.appendChild(el('p', null, 'No tasks match these filters.'));
          const clear = btn('gt-ghost', 'Clear filters');
          clear.addEventListener('click', () => {
            this.els.search.value = '';
            this.data.view.filters = C.defaultFilters();
            this._applyFilters(C.defaultFilters());
          });
          empty.appendChild(clear);
        } else {
          empty.appendChild(el('p', null, 'No tasks yet.'));
          if (!this.readOnly) {
            const b = btn('gt-primary', 'Add a task', 'plus');
            b.addEventListener('click', () => this.addTask({}));
            empty.appendChild(b);
          }
        }
        this.els.listRows.appendChild(empty);
        return;
      }
      if (sheet) {
        tasks.forEach((task) => {
          this.els.listRows.appendChild(this._listRow(task, true));
        });
        return;
      }

      this._paintHead(range, px, days);
      this._paintGrid(range, px, days, tasks.length);
      const boxes = {};
      tasks.forEach((task, index) => {
        this.els.listRows.appendChild(this._listRow(task, false));
        const row = el('div', 'gt-time-row');
        row.dataset.id = task.id;
        row.style.height = ROW + 'px';
        if (task.priority) row.classList.add('is-priority-' + task.priority);
        if (task.id === this.selectedId) row.classList.add('is-selected');
        const color = this._taskColor(task);
        const box = this._barBox(task, range, px);
        boxes[task.id] = { box, index };
        if (task.milestone) {
          const diamond = el('div', 'gt-diamond');
          diamond.dataset.id = task.id;
          diamond.style.left = (box.mid - 7) + 'px';
          diamond.style.setProperty('--bar', color);
          if (task.priority === 'high') diamond.classList.add('is-priority-high');
          diamond.title = task.title || 'Milestone';
          row.appendChild(diamond);
          const label = el('div', 'gt-side-label', task.title || 'Milestone');
          label.style.left = (box.mid + 14) + 'px';
          row.appendChild(label);
        } else {
          const summary = C.hasChildren(this.data, task.id);
          const bar = el('div', 'gt-bar' + (summary ? ' is-summary' : '') + (task.priority === 'high' ? ' is-priority-high' : ''));
          bar.dataset.id = task.id;
          bar.style.left = box.x1 + 'px';
          bar.style.width = Math.max(8, box.x2 - box.x1) + 'px';
          bar.style.setProperty('--bar', color);
          const pct = Math.round(Number(task.progress) || 0);
          bar.title = (task.title || 'Task') + ' · ' + shortDate(task.start) + ' – ' + shortDate(task.end) + ' · ' + pct + '%';
          if (!summary) {
            const fill = el('div', 'gt-bar-fill');
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            if (box.x2 - box.x1 > 64) bar.appendChild(el('span', 'gt-bar-label', task.title || 'Task'));
            if (!this.readOnly) {
              const left = el('div', 'gt-resize left');
              left.dataset.edge = 'start';
              const right = el('div', 'gt-resize right');
              right.dataset.edge = 'end';
              const link = el('div', 'gt-link');
              link.title = 'Drag onto another task to make it depend on this one';
              bar.append(left, right, link);
            }
          }
          row.appendChild(bar);
        }
        this.els.timeBody.appendChild(row);
      });
      this._paintDeps(tasks, boxes);
    }

    _paintHead(range, px, days) {
      const months = el('div', 'gt-months');
      const ticks = el('div', 'gt-ticks');
      let i = 0;
      while (i < days) {
        const iso = C.addDays(range.start, i);
        const key = iso.slice(0, 7);
        let j = i + 1;
        while (j < days && C.addDays(range.start, j).slice(0, 7) === key) j += 1;
        const span = (j - i) * px;
        const monthName = MONTHS[new Date(C.parseDay(iso)).getUTCMonth()];
        const label = span >= 96 ? monthLabel(iso) : span >= 36 ? monthName.slice(0, 3) : '';
        const cell = el('div', 'gt-month', label);
        cell.style.width = span + 'px';
        months.appendChild(cell);
        i = j;
      }
      const zoom = this.data.view.zoom || 'day';
      if (zoom === 'week') {
        ticks.style.position = 'relative';
        for (let d = 0; d < days; d++) {
          const iso = C.addDays(range.start, d);
          const wd = new Date(C.parseDay(iso)).getUTCDay();
          if (wd !== 0 && wd !== 6) continue;
          const tick = el('div', 'gt-tick is-weekend');
          tick.style.position = 'absolute';
          tick.style.left = (d * px) + 'px';
          tick.style.width = px + 'px';
          tick.textContent = String(Number(iso.slice(8)));
          if (iso === range.today) tick.classList.add('is-today');
          ticks.appendChild(tick);
        }
        this.els.timeHead.append(months, ticks);
        return;
      }
      if (zoom === 'month') {
        ticks.style.position = 'relative';
        for (let d = 0; d < days; d++) {
          const iso = C.addDays(range.start, d);
          if (iso.slice(8) !== '01') continue;
          const tick = el('div', 'gt-tick is-month-start');
          tick.style.position = 'absolute';
          tick.style.left = (d * px) + 'px';
          tick.style.width = '48px';
          tick.textContent = MONTHS[new Date(C.parseDay(iso)).getUTCMonth()].slice(0, 3);
          ticks.appendChild(tick);
        }
        this.els.timeHead.append(months, ticks);
        return;
      }
      for (let d = 0; d < days; d++) {
        const iso = C.addDays(range.start, d);
        const show = zoom === 'day';
        if (!show && zoom !== 'month') continue;
        if (zoom === 'month' && iso.slice(8) !== '01' && d !== 0) continue;
        const tick = el('div', 'gt-tick');
        tick.style.width = px + 'px';
        if (zoom === 'day') tick.textContent = String(Number(iso.slice(8)));
        const wd = new Date(C.parseDay(iso)).getUTCDay();
        if (wd === 0 || wd === 6) tick.classList.add('is-weekend');
        if (iso === range.today) tick.classList.add('is-today');
        if (zoom !== 'day') tick.style.position = 'absolute';
        if (zoom !== 'day') tick.style.left = (d * px) + 'px';
        ticks.appendChild(tick);
      }
      if (zoom !== 'day') ticks.style.position = 'relative';
      this.els.timeHead.append(months, ticks);
    }

    _paintGrid(range, px, days, count) {
      const grid = el('div', 'gt-grid');
      grid.style.height = Math.max(count, 1) * ROW + 'px';
      this.els.timeBody.appendChild(grid);
      const zoom = this.data.view.zoom || 'day';
      if (this.data.view.showWeekends !== false && (zoom === 'day' || zoom === 'week')) {
        for (let d = 0; d < days; d++) {
          const iso = C.addDays(range.start, d);
          const wd = new Date(C.parseDay(iso)).getUTCDay();
          if (wd !== 0 && wd !== 6) continue;
          const band = el('div', 'gt-weekend');
          band.style.left = (d * px) + 'px';
          band.style.width = px + 'px';
          this.els.timeBody.appendChild(band);
        }
      }
      if (zoom === 'month') {
        for (let d = 0; d < days; d++) {
          const iso = C.addDays(range.start, d);
          if (iso.slice(8) !== '01') continue;
          const line = el('div', 'gt-month-line');
          line.style.left = (d * px) + 'px';
          this.els.timeBody.appendChild(line);
        }
      }
      const todayAt = C.diffDays(range.start, range.today);
      if (todayAt >= 0 && todayAt < days) {
        const line = el('div', 'gt-today-line');
        line.style.left = (todayAt * px + px / 2) + 'px';
        this.els.timeBody.appendChild(line);
      }
    }

    _barBox(task, range, px) {
      if (task.milestone) {
        const mid = C.diffDays(range.start, task.start) * px + px / 2;
        return { x1: mid - 8, x2: mid + 8, mid };
      }
      const x1 = C.diffDays(range.start, task.start) * px + 2;
      const w = Math.max(px - 4, C.durationDays(task) * px - 4);
      return { x1, x2: x1 + w, mid: x1 + w / 2 };
    }

    _paintDeps(tasks, boxes) {
      const height = Math.max(tasks.length, 1) * ROW;
      const width = this.els.timeBody.clientWidth || 1;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gt-deps');
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const markerId = 'gt-arrow-' + (this._markerSeq = (this._markerSeq || 0) + 1);
      const markerOn = markerId + '-on';
      const accent = (getComputedStyle(this.els.root).getPropertyValue('--gt-accent') || '#4f6ef7').trim();
      function marker(id, fill) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        node.setAttribute('id', id);
        node.setAttribute('viewBox', '0 0 8 8');
        node.setAttribute('refX', '7');
        node.setAttribute('refY', '4');
        node.setAttribute('markerWidth', '7');
        node.setAttribute('markerHeight', '7');
        node.setAttribute('orient', 'auto');
        const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        head.setAttribute('d', 'M0 0 L8 4 L0 8 Z');
        head.setAttribute('fill', fill);
        node.appendChild(head);
        defs.appendChild(node);
      }
      marker(markerId, '#98a2b3');
      marker(markerOn, accent);
      svg.appendChild(defs);
      if (this.selectedLink) {
        const owner = this.data.tasks[this.selectedLink.succ];
        if (!owner || (owner.deps || []).indexOf(this.selectedLink.pred) < 0) this.selectedLink = null;
      }
      tasks.forEach((task) => {
        const to = boxes[task.id];
        if (!to) return;
        (task.deps || []).forEach((predId) => {
          const from = boxes[predId];
          if (!from) return;
          const y1 = from.index * ROW + ROW / 2;
          const y2 = to.index * ROW + ROW / 2;
          const d = depPath(from.box.x2, y1, to.box.x1, y2);
          const selected = this.selectedLink && this.selectedLink.succ === task.id && this.selectedLink.pred === predId;
          const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hit.setAttribute('class', 'gt-dep-hit');
          hit.setAttribute('d', d);
          hit.dataset.succ = task.id;
          hit.dataset.pred = predId;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'gt-dep' + (selected ? ' is-selected' : ''));
          path.setAttribute('d', d);
          path.dataset.succ = task.id;
          path.dataset.pred = predId;
          path.setAttribute('marker-end', 'url(#' + (selected ? markerOn : markerId) + ')');
          svg.append(hit, path);
        });
      });
      this.els.timeBody.appendChild(svg);
    }

    _onAnalyticsClick(ev) {
      const target = eventEl(ev.target);
      if (!target) return;
      const chip = target.closest('[data-label]');
      if (chip) {
        this._setLabelFilter(chip.dataset.label);
        return;
      }
      const row = target.closest('[data-id]');
      if (row && row.dataset.id) this.openTask(row.dataset.id);
    }

    _setLabelFilter(id) {
      const next = id == null ? '' : String(id);
      const cur = this._filters().label || '';
      this._applyFilters({ label: cur === next ? '' : next });
    }

    _anLabelFilter() {
      const labs = C.labelsList(this.data);
      if (!labs.length) return null;
      const cur = this._filters().label || '';
      const base = Object.assign({}, this._filters(), { label: '' });
      const pool = C.matchingTasks(this.data, base);
      const none = pool.filter((t) => !C.taskLabelIds(t).length).length;
      const bar = el('div', 'gt-an-labels');
      bar.setAttribute('aria-label', 'Filter by label');
      function chip(id, name, count, color) {
        const b = el('button', 'gt-an-label' + (cur === id ? ' is-on' : ''));
        b.type = 'button';
        b.dataset.label = id;
        if (color) {
          const dot = el('span', 'gt-an-label-dot');
          dot.style.background = color;
          b.appendChild(dot);
        }
        b.appendChild(el('span', null, name));
        b.appendChild(el('em', null, String(count)));
        return b;
      }
      bar.appendChild(chip('', 'All', pool.length, ''));
      labs.forEach((lab) => {
        const count = pool.filter((t) => C.taskLabelIds(t).indexOf(lab.id) >= 0).length;
        bar.appendChild(chip(lab.id, lab.name, count, lab.color));
      });
      bar.appendChild(chip('__none__', 'No labels', none, ''));
      return bar;
    }

    _anRing(pct) {
      const wrap = el('div', 'gt-an-ring-wrap');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gt-an-ring');
      svg.setAttribute('viewBox', '0 0 80 80');
      const r = 28;
      const c = 2 * Math.PI * r;
      const done = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      function circle(cls, dash) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        node.setAttribute('class', cls);
        node.setAttribute('cx', '40');
        node.setAttribute('cy', '40');
        node.setAttribute('r', String(r));
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke-width', '8');
        if (dash) {
          node.setAttribute('stroke-dasharray', dash);
          node.setAttribute('stroke-dashoffset', '0');
          node.setAttribute('transform', 'rotate(-90 40 40)');
        }
        return node;
      }
      svg.append(circle('gt-an-ring-bg'), circle('gt-an-ring-fg', (c * done / 100) + ' ' + c));
      const label = el('div', 'gt-an-ring-label', done + '%');
      wrap.append(svg, label);
      return wrap;
    }

    _anBar(label, value, total, tone) {
      const row = el('div', 'gt-an-bar-row');
      const top = el('div', 'gt-an-bar-meta');
      top.append(el('span', null, label), el('strong', null, String(value)));
      const track = el('div', 'gt-an-bar-track');
      const fill = el('div', 'gt-an-bar-fill is-' + tone);
      const pct = total ? Math.round((value / total) * 100) : 0;
      fill.style.width = pct + '%';
      track.appendChild(fill);
      row.append(top, track);
      return row;
    }

    _anKpi(tone, value, label) {
      const card = el('div', 'gt-an-kpi is-' + tone);
      card.append(el('strong', null, String(value)), el('span', null, label));
      return card;
    }

    _anList(title, tone, items) {
      const card = el('div', 'gt-an-card');
      card.appendChild(el('h3', null, title));
      if (!items.length) {
        card.appendChild(el('p', 'gt-an-empty', 'Nothing here'));
        return card;
      }
      items.forEach((item) => {
        const row = el('button', 'gt-an-item is-' + tone);
        row.type = 'button';
        row.dataset.id = item.id;
        const left = el('div', 'gt-an-item-main');
        left.append(el('strong', null, item.title || 'Untitled'), el('span', null, (item.end || item.start || '') + (item.assignee ? ' · ' + item.assignee : '')));
        row.append(left, el('em', null, item.progress + '%'));
        card.appendChild(row);
      });
      return card;
    }

    _renderAnalytics() {
      const pane = this.els.analytics;
      pane.innerHTML = '';
      const labelBar = this._anLabelFilter();
      if (labelBar) pane.appendChild(labelBar);
      const stats = C.analyze(this.data);
      const work = stats.work || stats.total;
      if (!stats.total) {
        const empty = el('div', 'gt-empty');
        if (C.hasActiveFilter(this._filters())) {
          empty.appendChild(el('p', null, 'No tasks match these filters.'));
          const clear = btn('gt-ghost', 'Clear filters');
          clear.addEventListener('click', () => {
            this.els.search.value = '';
            this.data.view.filters = C.defaultFilters();
            this._applyFilters(C.defaultFilters());
          });
          empty.appendChild(clear);
        } else {
          empty.appendChild(el('p', null, 'No tasks yet.'));
          if (!this.readOnly) {
            const b = btn('gt-primary', 'Add a task', 'plus');
            b.addEventListener('click', () => this.addTask({}));
            empty.appendChild(b);
          }
        }
        pane.appendChild(empty);
        return;
      }

      const kpis = el('div', 'gt-an-kpis');
      kpis.append(
        this._anKpi('teal', stats.progress + '%', 'Complete'),
        this._anKpi('indigo', stats.status.todo + stats.status.doing, 'Open'),
        this._anKpi('green', stats.status.done, 'Done'),
        this._anKpi('red', stats.health.overdue, 'Overdue'),
        this._anKpi('blue', stats.span.remaining, 'Days left'),
        this._anKpi('purple', stats.assignees.length, 'People')
      );
      pane.appendChild(kpis);

      const grid = el('div', 'gt-an-grid');
      const health = el('div', 'gt-an-card gt-an-health');
      health.appendChild(el('h3', null, 'Plan health'));
      const healthBody = el('div', 'gt-an-health-body');
      healthBody.appendChild(this._anRing(stats.progress));
      const healthMeta = el('div', 'gt-an-health-meta');
      const spanLabel = stats.span.start && stats.span.end
        ? stats.span.start + ' → ' + stats.span.end + ' · ' + stats.span.days + ' days'
        : 'No dates';
      healthMeta.append(
        el('p', 'gt-an-span', spanLabel),
        this._anBar('Elapsed', stats.span.elapsed, stats.span.days || 1, 'blue'),
        this._anBar('Remaining', stats.span.remaining, stats.span.days || 1, 'indigo'),
        this._anBar('At risk', stats.health.atRisk, work, 'orange'),
        this._anBar('Blocked', stats.health.blocked, work, 'red')
      );
      healthBody.appendChild(healthMeta);
      health.appendChild(healthBody);
      grid.appendChild(health);

      const mix = el('div', 'gt-an-card');
      mix.appendChild(el('h3', null, 'Mix'));
      mix.append(
        this._anBar('Tasks', stats.kinds.task, stats.total, 'indigo'),
        this._anBar('Summaries', stats.kinds.summary, stats.total, 'purple'),
        this._anBar('Milestones', stats.kinds.milestone, stats.total, 'amber'),
        this._anBar('Not started', stats.status.todo, work, 'slate'),
        this._anBar('In progress', stats.status.doing, work, 'blue'),
        this._anBar('Done', stats.status.done, work, 'green')
      );
      grid.appendChild(mix);

      const pri = el('div', 'gt-an-card');
      pri.appendChild(el('h3', null, 'Priority'));
      pri.append(
        this._anBar('High', stats.priority.high, work, 'red'),
        this._anBar('Medium', stats.priority.medium, work, 'orange'),
        this._anBar('Low', stats.priority.low, work, 'blue'),
        this._anBar('None', stats.priority.none, work, 'slate')
      );
      grid.appendChild(pri);

      const people = el('div', 'gt-an-card');
      people.appendChild(el('h3', null, 'Workload'));
      if (!stats.assignees.length) people.appendChild(el('p', 'gt-an-empty', 'Nobody assigned yet'));
      stats.assignees.forEach((who) => {
        const row = el('div', 'gt-an-who');
        const avatar = el('span', 'gt-avatar', who.name.charAt(0).toUpperCase());
        avatar.style.background = 'hsl(' + avatarHue(who.name) + ' 62% 46%)';
        const body = el('div', 'gt-an-who-body');
        body.append(
          el('strong', null, who.name),
          el('span', null, who.count + ' item' + (who.count === 1 ? '' : 's') + ' · ' + who.days + ' days · ' + who.avgProgress + '%')
        );
        const track = el('div', 'gt-an-bar-track');
        const fill = el('div', 'gt-an-bar-fill is-teal');
        fill.style.width = who.avgProgress + '%';
        track.appendChild(fill);
        body.appendChild(track);
        row.append(avatar, body);
        people.appendChild(row);
      });
      if (stats.health.unassigned) {
        people.appendChild(el('p', 'gt-an-note', stats.health.unassigned + ' unassigned · ' + stats.health.links + ' dependencies'));
      } else {
        people.appendChild(el('p', 'gt-an-note', stats.health.links + ' dependencies'));
      }
      grid.appendChild(people);

      if (stats.labels && stats.labels.length) {
        const labs = el('div', 'gt-an-card');
        labs.appendChild(el('h3', null, 'Labels'));
        stats.labels.forEach((lab) => {
          const row = el('button', 'gt-an-who is-btn');
          row.type = 'button';
          row.dataset.label = lab.id;
          row.title = 'Filter by ' + lab.name;
          row.appendChild(this._labelChip(lab));
          const body = el('div', 'gt-an-who-body');
          body.append(el('strong', null, lab.name), el('span', null, lab.count + ' item' + (lab.count === 1 ? '' : 's')));
          const track = el('div', 'gt-an-bar-track');
          const fill = el('div', 'gt-an-bar-fill');
          fill.style.background = lab.color;
          fill.style.width = (work ? Math.round((lab.count / work) * 100) : 0) + '%';
          track.appendChild(fill);
          body.appendChild(track);
          row.appendChild(body);
          labs.appendChild(row);
        });
        grid.appendChild(labs);
      }

      grid.append(
        this._anList('Overdue', 'red', stats.lists.overdue),
        this._anList('Due in 3 days', 'orange', stats.lists.atRisk),
        this._anList('Blocked', 'slate', stats.lists.blocked),
        this._anList('High priority open', 'pink', stats.lists.highOpen)
      );
      pane.appendChild(grid);
    }

    _paintListHead(sheet) {
      const head = this.els.listHead;
      head.innerHTML = '';
      head.classList.toggle('is-sheet', !!sheet);
      if (!sheet) {
        head.textContent = 'Task';
        return;
      }
      SHEET_HEADS.forEach((label, i) => {
        head.appendChild(el('span', 'gt-col gt-col-h gt-col-' + i, label));
      });
    }

    _taskKind(task) {
      if (task.milestone) return 'Milestone';
      if (C.hasChildren(this.data, task.id)) return 'Summary';
      return 'Task';
    }

    _depNames(task) {
      return (task.deps || []).map((id) => this.data.tasks[id] && this.data.tasks[id].title).filter(Boolean).join(', ');
    }

    _labelChip(label, opts) {
      const o = opts || {};
      const chip = el(o.tag || 'span', 'gt-label-chip' + (o.on ? ' is-on' : '') + (o.button ? ' is-btn' : ''), label.name);
      if (o.button) {
        chip.type = 'button';
      }
      chip.style.background = label.color;
      chip.style.color = chipInk(label.color);
      chip.title = label.name;
      if (o.onClick) chip.addEventListener('click', o.onClick);
      return chip;
    }

    _appendLabelChips(host, task, max) {
      const tags = C.taskLabels(this.data, task);
      const shown = max ? tags.slice(0, max) : tags;
      shown.forEach((lab) => host.appendChild(this._labelChip(lab)));
      if (max && tags.length > max) host.appendChild(el('span', 'gt-label-more', '+' + (tags.length - max)));
      return tags;
    }

    _addDrawerLabel() {
      if (this.readOnly || !this.detailId) return;
      const d = this.drawer;
      const name = String(d.labelName.value || '').trim();
      if (!name) {
        d.labelName.focus();
        return;
      }
      const color = d.labelColor.value;
      this._mutate(() => {
        const lab = C.addLabel(this.data, { name, color });
        if (!lab) return false;
        const ids = C.taskLabelIds(this.data.tasks[this.detailId]);
        if (ids.indexOf(lab.id) < 0) C.toggleTaskLabel(this.data, this.detailId, lab.id);
      });
      d.labelName.value = '';
    }

    _sheetField(tag, field, id, value) {
      const node = document.createElement(tag);
      node.className = 'gt-sheet-input';
      node.dataset.gtField = field;
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (tag === 'input' && !node.type) node.type = 'text';
      }
      if (value != null) node.value = value;
      if (this.readOnly) {
        if (node.tagName === 'SELECT') node.disabled = true;
        else node.readOnly = true;
      }
      return node;
    }

    _listRow(task, sheet) {
      const row = el('div', 'gt-row' + (sheet ? ' is-sheet' : ''));
      row.dataset.id = task.id;
      if (task.priority) row.classList.add('is-priority-' + task.priority);
      if (!sheet) row.style.paddingLeft = (8 + C.depthOf(this.data, task.id) * 16) + 'px';
      if (task.id === this.selectedId) row.classList.add('is-selected');
      const cluster = el('div', 'gt-task-cell');
      if (sheet) cluster.style.paddingLeft = (4 + C.depthOf(this.data, task.id) * 16) + 'px';
      const grip = el('span', 'gt-grip');
      grip.title = 'Drag to nest or reorder';
      const twist = el('button', 'gt-twist' + (C.hasChildren(this.data, task.id) ? '' : ' is-empty'));
      twist.type = 'button';
      twist.innerHTML = icon('plus').replace('M12 5v14M5 12h14', task.collapsed ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6');
      twist.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!C.hasChildren(this.data, task.id) || this.readOnly) return;
        this._mutate(() => {
          task.collapsed = !task.collapsed;
        });
      });
      const dot = el('span', 'gt-dot');
      dot.style.background = this._taskColor(task);
      const name = el('div', 'gt-name' + (C.hasChildren(this.data, task.id) ? ' is-group' : ''), task.title || 'Untitled');
      cluster.append(grip, twist, dot, name);
      if (!sheet) this._appendLabelChips(cluster, task, 2);
      if (task.priority === 'high') cluster.appendChild(el('span', 'gt-flag', 'High'));
      row.appendChild(cluster);
      if (sheet) {
        this._appendSheetCells(row, task);
        return row;
      }
      const when = task.milestone
        ? shortDate(task.start)
        : shortDate(task.start) + ' – ' + shortDate(task.end);
      if (!task.milestone) row.appendChild(el('span', 'gt-pct-list', Math.round(Number(task.progress) || 0) + '%'));
      row.appendChild(el('span', 'gt-when', when));
      return row;
    }

    _appendSheetCells(row, task) {
      const summary = C.hasChildren(this.data, task.id);
      const kind = this._taskKind(task);
      row.appendChild(el('span', 'gt-pill gt-pill-' + kind.toLowerCase(), kind));
      const whoWrap = el('div', 'gt-who');
      const whoName = String(task.assignee || '').trim();
      const avatar = el('span', 'gt-avatar', whoName ? whoName.charAt(0).toUpperCase() : '·');
      avatar.style.background = whoName ? 'hsl(' + avatarHue(whoName) + ' 62% 46%)' : 'var(--gt-line-strong)';
      const who = this._sheetField('input', 'assignee', task.id, task.assignee || '');
      who.type = 'text';
      who.placeholder = 'Assign';
      who.setAttribute('aria-label', 'Assignee');
      this._bindLiveField(who, 'assignee', () => ({ id: task.id }));
      whoWrap.append(avatar, who);
      row.appendChild(whoWrap);
      const pri = this._sheetField('select', 'priority', task.id, task.priority || '');
      pri.classList.add('gt-pri', 'gt-pri-' + (task.priority || 'none'));
      pri.setAttribute('aria-label', 'Priority');
      C.PRIORITIES.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = PRIORITY_LABEL[p] || 'None';
        pri.appendChild(opt);
      });
      pri.value = task.priority || '';
      pri.addEventListener('change', () => {
        if (this.readOnly) return;
        this._mutate(() => {
          const t = this.data.tasks[task.id];
          if (!t) return false;
          t.priority = C.PRIORITIES.indexOf(pri.value) >= 0 ? pri.value : '';
          t.updatedAt = C.nowIso();
        });
      });
      row.appendChild(pri);
      const tags = el('div', 'gt-label-cell');
      this._appendLabelChips(tags, task, 4);
      const addLab = el('button', 'gt-label-add', '+');
      addLab.type = 'button';
      addLab.title = 'Edit labels';
      addLab.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openTask(task.id);
      });
      tags.appendChild(addLab);
      row.appendChild(tags);
      const pctWrap = el('div', 'gt-pct-cell');
      const pctVal = Math.round(Number(task.progress) || 0);
      const track = el('div', 'gt-pct-track');
      const fill = el('div', 'gt-pct-fill');
      fill.style.width = pctVal + '%';
      track.appendChild(fill);
      const pct = this._sheetField('input', 'progress', task.id, String(pctVal));
      pct.type = 'number';
      pct.min = '0';
      pct.max = '100';
      pct.classList.add('gt-pct-input');
      pct.setAttribute('aria-label', 'Percent complete');
      pct.disabled = this.readOnly || summary;
      pct.addEventListener('change', () => {
        if (this.readOnly || summary) return;
        this._mutate(() => C.setProgress(this.data, task.id, pct.value));
      });
      pctWrap.append(track, pct, el('span', 'gt-pct-unit', '%'));
      row.appendChild(pctWrap);
      const start = this._sheetField('input', 'start', task.id, task.start || '');
      start.type = 'date';
      start.classList.add('gt-date');
      start.setAttribute('aria-label', 'Start date');
      start.disabled = this.readOnly || summary;
      const end = this._sheetField('input', 'end', task.id, task.end || '');
      end.type = 'date';
      end.classList.add('gt-date');
      end.setAttribute('aria-label', 'End date');
      end.disabled = this.readOnly || summary || task.milestone;
      const applyDates = () => {
        if (this.readOnly || summary) return;
        this._mutate(() => C.setRange(this.data, task.id, start.value, end.value));
      };
      start.addEventListener('change', applyDates);
      end.addEventListener('change', applyDates);
      row.append(start, end);
      row.appendChild(el('span', 'gt-pill gt-pill-days', task.milestone ? '—' : C.durationDays(task) + 'd'));
      const deps = this._depNames(task);
      row.appendChild(el('span', 'gt-col gt-col-deps' + (deps ? ' has-deps' : ''), deps || '—'));
      const noteCell = el('div', 'gt-note-cell');
      const preview = el('button', 'gt-note-preview', task.notes ? String(task.notes).replace(/\s+/g, ' ').trim() : 'Add notes');
      preview.type = 'button';
      preview.title = 'Open full notes';
      if (!task.notes) preview.classList.add('is-empty');
      preview.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._openNotes(task.id);
      });
      noteCell.appendChild(preview);
      row.appendChild(noteCell);
    }

    _openNotes(id) {
      const task = this.data.tasks[id];
      if (!task) return;
      const wrap = el('div', 'gt-dialog');
      wrap.innerHTML = '<div class="gt-dialog-panel gt-notes-panel" role="dialog" aria-modal="true">'
        + '<h3>Notes</h3>'
        + '<p>' + escapeXml(task.title || 'Untitled') + '</p>'
        + '<textarea class="gt-dialog-notes" aria-label="Notes"></textarea>'
        + '<div class="gt-dialog-actions"><button type="button" class="gt-btn gt-ghost" data-act="cancel">Cancel</button>'
        + '<button type="button" class="gt-btn gt-primary" data-act="ok">Save</button></div></div>';
      document.body.appendChild(wrap);
      const area = wrap.querySelector('textarea');
      area.value = task.notes || '';
      const close = () => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
      };
      const save = () => {
        if (!this.readOnly) {
          this._mutate(() => {
            const t = this.data.tasks[id];
            if (!t) return false;
            t.notes = String(area.value || '').slice(0, 20000);
            t.updatedAt = C.nowIso();
          });
        }
        close();
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          close();
        }
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) close();
      });
      wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
      wrap.querySelector('[data-act="ok"]').addEventListener('click', save);
      if (this.readOnly) {
        area.readOnly = true;
        wrap.querySelector('[data-act="ok"]').style.display = 'none';
      }
      area.focus();
    }

    _onListClick(ev) {
      if (this._suppressClick) {
        this._suppressClick = false;
        this._lastListClick = null;
        return;
      }
      const target = eventEl(ev.target);
      if (!target || target.closest('button, input, textarea, select')) return;
      const row = target.closest('.gt-row');
      if (!row || !row.dataset.id) return;
      const id = row.dataset.id;
      const now = Date.now();
      const again = this._lastListClick && this._lastListClick.id === id && now - this._lastListClick.t < 450;
      this._lastListClick = { id, t: now };
      this.selectedId = id;
      this.selectedLink = null;
      this._syncSelection();
      if (again) this.openTask(id);
    }

    _onTimeClick(ev) {
      const target = eventEl(ev.target);
      if (!target) return;
      const dep = target.closest('.gt-dep-hit');
      if (dep) {
        this.selectedLink = { succ: dep.dataset.succ, pred: dep.dataset.pred };
        this.selectedId = null;
        this._syncSelection();
        if (this.els.root.tabIndex >= 0 || this.els.root.tabIndex === -1) this.els.root.focus();
        return;
      }
      const bar = target.closest('.gt-bar, .gt-diamond, .gt-time-row');
      if (!bar || !bar.dataset.id) {
        if (this.selectedLink) {
          this.selectedLink = null;
          this._syncSelection();
        }
        return;
      }
      this.selectedId = bar.dataset.id;
      this.selectedLink = null;
      this._syncSelection();
    }

    _onOpenClick(ev) {
      const target = eventEl(ev.target);
      if (!target) return;
      if (target.closest('.gt-twist, .gt-filterbar, .gt-note-preview')) return;
      const row = target.closest('.gt-row, .gt-time-row, .gt-bar, .gt-diamond');
      if (row && row.dataset.id) this.openTask(row.dataset.id);
    }

    _syncSelection() {
      this.els.root.querySelectorAll('.gt-row, .gt-time-row').forEach((n) => {
        n.classList.toggle('is-selected', n.dataset.id === this.selectedId);
      });
      this.els.root.querySelectorAll('.gt-dep').forEach((path) => {
        const on = this.selectedLink && path.dataset.succ === this.selectedLink.succ && path.dataset.pred === this.selectedLink.pred;
        path.classList.toggle('is-selected', !!on);
        const end = path.getAttribute('marker-end') || '';
        const base = end.replace('-on)', ')');
        if (base) path.setAttribute('marker-end', on ? base.replace(')', '-on)') : base);
      });
      if (this.els.subBtn) this.els.subBtn.disabled = this.readOnly || !this.selectedId || !this.data.tasks[this.selectedId];
    }

    _onListPointerDown(ev) {
      if (this.readOnly || ev.button !== 0 || this._drag) return;
      const target = eventEl(ev.target);
      if (!target || target.closest('input, textarea, select, button, a')) return;
      const row = target.closest('.gt-row');
      if (!row || !row.dataset.id || !this.data.tasks[row.dataset.id]) return;
      this._beginReparent(ev, row.dataset.id);
    }

    _onPointerDown(ev) {
      if (this.readOnly || ev.button !== 0 || this._drag) return;
      const target = eventEl(ev.target);
      if (!target || target.closest('input, textarea, select, button, a')) return;
      const link = target.closest('.gt-link');
      const bar = target.closest('.gt-bar, .gt-diamond');
      if (!bar) {
        const row = target.closest('.gt-time-row');
        if (row && row.dataset.id && this.data.tasks[row.dataset.id]) this._beginReparent(ev, row.dataset.id);
        return;
      }
      const id = bar.dataset.id;
      if (!id || !this.data.tasks[id]) return;
      this.selectedId = id;
      this._syncSelection();
      const resize = target.closest('.gt-resize');
      this._pending = {
        type: link ? 'link' : resize ? 'resize' : 'move',
        edge: resize ? resize.dataset.edge : '',
        id,
        x: ev.clientX,
        y: ev.clientY,
        left: parseFloat(bar.style.left) || 0,
        width: parseFloat(bar.style.width) || bar.offsetWidth,
      };
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
    }

    _beginReparent(ev, id) {
      this.selectedId = id;
      this.selectedLink = null;
      this._syncSelection();
      this._pending = { type: 'reparent', id, x: ev.clientX, y: ev.clientY };
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
    }

    _onDragMove(ev) {
      const p = this._pending;
      if (p && !this._drag) {
        if (Math.abs(ev.clientX - p.x) + Math.abs(ev.clientY - p.y) < DRAG) return;
        this._drag = p;
        this._pending = null;
        this.els.root.classList.add('is-dragging');
        if (p.type === 'reparent') this.els.root.classList.add('is-reparenting');
      }
      if (!this._drag) return;
      if (this._drag.type === 'reparent') {
        this._paintReparent(ev);
        return;
      }
      if (this._drag.type === 'link') this._paintLinkLine(ev);
      else {
        const node = this.els.timeBody.querySelector('[data-id="' + CSS.escape(this._drag.id) + '"].gt-bar, [data-id="' + CSS.escape(this._drag.id) + '"].gt-diamond');
        if (node && this._drag.type === 'resize' && node.classList.contains('gt-bar')) {
          const dx = ev.clientX - this._drag.x;
          if (this._drag.edge === 'start') {
            const width = Math.max(this._px || 8, this._drag.width - dx);
            node.style.width = width + 'px';
            node.style.left = (this._drag.left + this._drag.width - width) + 'px';
          } else node.style.width = Math.max(this._px || 8, this._drag.width + dx) + 'px';
        } else if (node) node.style.transform = 'translateX(' + (ev.clientX - this._drag.x) + 'px)';
      }
    }

    _paintLinkLine(ev) {
      let svg = this.els.timeBody.querySelector('.gt-link-line');
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'gt-link-line');
        this.els.timeBody.appendChild(svg);
      }
      const from = this._barBox(this.data.tasks[this._drag.id], this._range, this._px);
      const origin = this.els.timeBody.getBoundingClientRect();
      const x2 = ev.clientX - origin.left + this.els.timeClip.scrollLeft;
      const y2 = ev.clientY - origin.top + this.els.timeClip.scrollTop;
      const tasks = C.visibleTasks(this.data);
      const index = tasks.findIndex((t) => t.id === this._drag.id);
      const y1 = index * ROW + ROW / 2;
      svg.innerHTML = '<path d="' + depPath(from.x2, y1, x2, y2) + '"></path>';
    }

    _paintReparent(ev) {
      const task = this.data.tasks[this._drag.id];
      if (!this._ghost) {
        this._ghost = el('div', 'gt-drag-ghost', (task && task.title) || 'Task');
        this.els.root.appendChild(this._ghost);
        this.els.root.querySelectorAll('.gt-row[data-id="' + CSS.escape(this._drag.id) + '"], .gt-time-row[data-id="' + CSS.escape(this._drag.id) + '"]').forEach((n) => n.classList.add('is-dragging-row'));
      }
      const origin = this.els.root.getBoundingClientRect();
      this._ghost.style.left = (ev.clientX - origin.left + 12) + 'px';
      this._ghost.style.top = (ev.clientY - origin.top + 8) + 'px';
      const clip = this.els.listRows.getBoundingClientRect();
      if (ev.clientY < clip.top + 28) this.els.listRows.scrollTop -= 16;
      else if (ev.clientY > clip.bottom - 28) this.els.listRows.scrollTop += 16;
      const hit = this._hitReparent(ev);
      const place = hit ? this._placeFromHit(this._drag.id, hit) : null;
      this.els.root.querySelectorAll('.is-drop, .is-drop-into, .is-drop-bad').forEach((n) => n.classList.remove('is-drop', 'is-drop-into', 'is-drop-bad'));
      if (!this._dropLine) {
        this._dropLine = el('div', 'gt-drop-line');
        this.els.listRows.appendChild(this._dropLine);
      }
      if (!hit || !hit.id) {
        const last = this.els.listRows.querySelector('.gt-row:last-child');
        this._dropLine.classList.toggle('open', !!last);
        if (last) this._dropLine.style.top = (last.offsetTop + last.offsetHeight - 1) + 'px';
        return;
      }
      const listRow = this.els.listRows.querySelector('.gt-row[data-id="' + CSS.escape(hit.id) + '"]');
      const timeRow = this.els.timeBody.querySelector('.gt-time-row[data-id="' + CSS.escape(hit.id) + '"]');
      if (!place) {
        this._dropLine.classList.remove('open');
        if (listRow) listRow.classList.add('is-drop-bad');
        if (timeRow) timeRow.classList.add('is-drop-bad');
        return;
      }
      if (hit.zone === 'into') {
        this._dropLine.classList.remove('open');
        if (listRow) listRow.classList.add('is-drop-into');
        if (timeRow) timeRow.classList.add('is-drop-into');
        return;
      }
      if (listRow) {
        this._dropLine.classList.add('open');
        this._dropLine.style.top = (hit.zone === 'before' ? listRow.offsetTop : listRow.offsetTop + listRow.offsetHeight - 1) + 'px';
      } else this._dropLine.classList.remove('open');
    }

    _hitReparent(ev) {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const hit = under && eventEl(under);
      if (!hit || !this.els.root.contains(hit)) return null;
      const row = hit.closest('.gt-row, .gt-time-row');
      if (row && row.dataset.id) {
        const box = row.getBoundingClientRect();
        const y = ev.clientY - box.top;
        const h = box.height || ROW;
        const zone = y < h * 0.28 ? 'before' : y > h * 0.72 ? 'after' : 'into';
        return { id: row.dataset.id, zone };
      }
      if (hit.closest('.gt-list-rows, .gt-list, .gt-time-clip, .gt-time-body')) return { id: null, zone: 'root' };
      return null;
    }

    _placeFromHit(dragId, hit) {
      if (!hit || hit.zone === 'root' || !hit.id) return { parentId: null, beforeId: null };
      if (hit.id === dragId) return null;
      if (C.subtreeIds(this.data, dragId).indexOf(hit.id) >= 0) return null;
      if (hit.zone === 'into') return { parentId: hit.id, beforeId: null };
      const target = this.data.tasks[hit.id];
      if (!target) return { parentId: null, beforeId: null };
      if (hit.zone === 'before') return { parentId: target.parentId || null, beforeId: hit.id };
      if (C.hasChildren(this.data, hit.id) && !target.collapsed) {
        const first = C.childrenOf(this.data, hit.id)[0];
        return { parentId: hit.id, beforeId: first ? first.id : null };
      }
      const sibs = C.childrenOf(this.data, target.parentId);
      const i = sibs.findIndex((s) => s.id === hit.id);
      const next = i >= 0 ? sibs[i + 1] : null;
      return { parentId: target.parentId || null, beforeId: next ? next.id : null };
    }

    _placeFromPoint(ev, dragId) {
      const hit = this._hitReparent(ev);
      return hit ? this._placeFromHit(dragId, hit) : null;
    }

    _clearReparentUi() {
      if (this._ghost && this._ghost.remove) this._ghost.remove();
      this._ghost = null;
      if (this._dropLine && this._dropLine.remove) this._dropLine.remove();
      this._dropLine = null;
      if (!this.els || !this.els.root) return;
      this.els.root.classList.remove('is-reparenting');
      this.els.root.querySelectorAll('.is-drop, .is-drop-into, .is-drop-bad, .is-dragging-row').forEach((n) => {
        n.classList.remove('is-drop', 'is-drop-into', 'is-drop-bad', 'is-dragging-row');
      });
    }

    _onDragEnd(ev) {
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      const drag = this._drag || this._pending;
      const wasDrag = !!this._drag;
      this._drag = null;
      this._pending = null;
      if (this.els) this.els.root.classList.remove('is-dragging', 'is-reparenting');
      if (!drag) return;
      if (!wasDrag) return;
      if (drag.type === 'reparent') {
        this._suppressClick = true;
        const place = this._placeFromPoint(ev, drag.id);
        this._clearReparentUi();
        if (!place) {
          this.render();
          return;
        }
        const ok = this._mutate(() => C.reparentTask(this.data, drag.id, place.parentId, place.beforeId) ? undefined : false);
        if (!ok) this.render();
        else this._toast('Task moved', 'Undo', () => this.undo());
        return;
      }
      this._clearReparentUi();
      if (drag.type === 'link') {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const hit = under && eventEl(under);
        const bar = hit && hit.closest('.gt-bar, .gt-diamond, .gt-row');
        const targetId = bar && bar.dataset.id;
        if (targetId && targetId !== drag.id) {
          const ok = this._mutate(() => C.linkDep(this.data, targetId, drag.id) ? undefined : false);
          if (!ok) {
            this.render();
            this._toast('Those tasks can’t depend on each other');
          } else this._toast('Dependency added', 'Undo', () => this.undo());
        } else this.render();
        return;
      }
      const days = Math.round((ev.clientX - drag.x) / (this._px || 28));
      if (!days) {
        this.render();
        return;
      }
      this._mutate(() => {
        if (drag.type === 'resize') return C.resizeTask(this.data, drag.id, drag.edge, days);
        return C.shiftTask(this.data, drag.id, days);
      });
    }

    _onContextMenu(ev) {
      const target = eventEl(ev.target);
      if (!target || !this.els.root.contains(target)) return;
      if (target.closest('.gt-menu')) {
        ev.preventDefault();
        return;
      }
      const field = target.closest('input, textarea, select');
      if (field && document.activeElement === field) return;
      const onChart = target.closest('.gt-main, .gt-list, .gt-time');
      if (!onChart) return;
      ev.preventDefault();
      const point = { x: ev.clientX, y: ev.clientY };
      const dep = target.closest('.gt-dep-hit');
      if (dep && this.data.tasks[dep.dataset.succ]) {
        this.selectedLink = { succ: dep.dataset.succ, pred: dep.dataset.pred };
        this.selectedId = null;
        this._syncSelection();
        if (!this.readOnly) this._openLinkMenu(point);
        return;
      }
      const row = target.closest('.gt-bar, .gt-diamond, .gt-row, .gt-time-row');
      if (row && row.dataset.id && this.data.tasks[row.dataset.id]) {
        this.selectedId = row.dataset.id;
        this.selectedLink = null;
        this._syncSelection();
        if (!this.readOnly) this._openTaskMenu(point, row.dataset.id);
        return;
      }
      if (!this.readOnly) this._openChartMenu(point);
    }

    addTask(opts) {
      if (this.readOnly) return;
      const o = opts || {};
      const sel = this.selectedId && this.data.tasks[this.selectedId];
      let created = null;
      this._mutate(() => {
        const start = sel ? sel.start : C.todayIso();
        created = C.addTask(this.data, {
          title: o.milestone ? 'Milestone' : '',
          start,
          end: o.milestone ? start : C.addDays(sel ? sel.end : start, 4),
          parentId: o.child && sel ? sel.id : (sel ? sel.parentId : null),
          afterId: o.child ? null : (sel ? sel.id : null),
          milestone: !!o.milestone,
        });
      });
      if (!created) return;
      this.selectedId = created.id;
      this._syncSelection();
      this.startTitleEdit(created.id);
    }

    _ask(title, message, confirmLabel) {
      return new Promise((resolve) => {
        const wrap = el('div', 'gt-dialog');
        const panel = el('div', 'gt-dialog-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.appendChild(el('h3', null, title));
        if (message) panel.appendChild(el('p', null, message));
        const actions = el('div', 'gt-dialog-actions');
        const cancel = btn('gt-ghost', 'Cancel');
        const ok = btn(confirmLabel === 'Delete' ? 'gt-ghost gt-danger' : 'gt-primary', confirmLabel || 'OK');
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
          if (ev.key !== 'Escape' && ev.key !== 'Enter') return;
          ev.preventDefault();
          ev.stopPropagation();
          done(ev.key === 'Enter');
        };
        document.addEventListener('keydown', onKey, true);
        cancel.addEventListener('click', () => done(false));
        ok.addEventListener('click', () => done(true));
        wrap.addEventListener('click', (ev) => {
          if (ev.target === wrap) done(false);
        });
        ok.focus();
      });
    }

    async deleteTask(id) {
      const task = this.data.tasks[id];
      if (!task || this.readOnly) return;
      const label = task.title ? '"' + task.title.slice(0, 60) + '"' : 'this task';
      const ok = await this._ask('Delete task', 'Delete ' + label + ' and its subtasks?', 'Delete');
      if (!ok || this._destroyed) return;
      this._mutate(() => C.deleteTask(this.data, id));
      if (this.detailId === id) this._closeDrawer(true);
      if (this.selectedId === id) this.selectedId = null;
      this._toast('Task deleted', 'Undo', () => this.undo());
    }

    duplicateTask(id) {
      if (this.readOnly || !this.data.tasks[id]) return;
      let copy = null;
      this._mutate(() => {
        copy = C.duplicateTask(this.data, id);
      });
      if (copy) {
        this.selectedId = copy.id;
        this._syncSelection();
        this._toast('Task duplicated');
      }
    }

    startTitleEdit(id) {
      if (this.readOnly || !this.data.tasks[id]) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const typing = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
        if (typing && active.blur) active.blur();
      }
      const row = this.els.listRows.querySelector('.gt-row[data-id="' + CSS.escape(id) + '"]');
      if (!row) return;
      const name = row.querySelector('.gt-name');
      if (!name) return;
      if (name.tagName === 'INPUT') {
        name.focus();
        return;
      }
      const input = document.createElement('input');
      input.className = 'gt-name';
      input.type = 'text';
      input.value = this.data.tasks[id].title || '';
      input.placeholder = 'Task name';
      name.replaceWith(input);
      this._bindLiveField(input, 'task-title', () => ({ id }));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          input.blur();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          input.value = this.data.tasks[id].title || '';
          input.blur();
        }
      });
      input.focus();
      input.select();
    }

    openTask(id) {
      if (!this.data.tasks[id]) return;
      this.detailId = id;
      this.selectedId = id;
      this._syncSelection();
      this.els.scrim.classList.add('open');
      this.drawer.el.classList.add('open');
      this._refreshDrawer();
    }

    _closeDrawer(immediate) {
      if (this._edit && this.drawer.el.contains(this._edit.el)) this.commitEdit();
      this.detailId = null;
      this.els.scrim.classList.remove('open');
      this.drawer.el.classList.remove('open');
      if (immediate) this.drawer.el.style.transition = 'none';
    }

    _refreshDrawer() {
      const d = this.drawer;
      const task = this.detailId && this.data.tasks[this.detailId];
      if (!task) return;
      d.headTitle.textContent = task.milestone ? 'Milestone' : (C.hasChildren(this.data, task.id) ? 'Summary' : 'Task');
      if (document.activeElement !== d.title) d.title.value = task.title || '';
      d.start.value = task.start || '';
      d.end.value = task.end || '';
      d.progress.value = String(task.progress || 0);
      d.progressLabel.textContent = 'Progress ' + (task.progress || 0) + '%';
      d.milestone.checked = !!task.milestone;
      if (document.activeElement !== d.assignee) d.assignee.value = task.assignee || '';
      d.priority.value = task.priority || '';
      if (document.activeElement !== d.notes) d.notes.value = task.notes || '';
      const summary = C.hasChildren(this.data, task.id);
      d.start.disabled = this.readOnly || summary;
      d.end.disabled = this.readOnly || summary || task.milestone;
      d.progress.disabled = this.readOnly || summary;
      d.milestone.disabled = this.readOnly || summary;
      d.title.readOnly = this.readOnly;
      d.assignee.readOnly = this.readOnly;
      d.priority.disabled = this.readOnly;
      d.notes.readOnly = this.readOnly;
      d.labelName.readOnly = this.readOnly;
      d.labelColor.disabled = this.readOnly;
      d.labelAdd.disabled = this.readOnly;
      d.labelApplied.innerHTML = '';
      d.labelCatalog.innerHTML = '';
      const applied = C.taskLabelIds(task);
      C.labelsList(this.data).forEach((lab) => {
        const on = applied.indexOf(lab.id) >= 0;
        const wrap = el('span', 'gt-label-edit');
        const chip = this._labelChip(lab, {
          tag: 'button',
          button: true,
          on,
          onClick: () => {
            if (this.readOnly) return;
            this._mutate(() => C.toggleTaskLabel(this.data, task.id, lab.id));
          },
        });
        chip.disabled = this.readOnly;
        const kill = el('button', 'gt-label-x', '×');
        kill.type = 'button';
        kill.title = 'Delete label';
        kill.disabled = this.readOnly;
        kill.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.readOnly) return;
          this._ask('Delete label', 'Remove "' + lab.name + '" from the board?', 'Delete').then((ok) => {
            if (ok) this._mutate(() => C.deleteLabel(this.data, lab.id));
          });
        });
        wrap.append(chip, kill);
        (on ? d.labelApplied : d.labelCatalog).appendChild(wrap);
      });
      if (!C.labelsList(this.data).length) d.labelCatalog.appendChild(el('p', 'gt-an-empty', 'No labels yet'));
      d.swatches.innerHTML = '';
      const clear = el('button', 'gt-swatch is-clear' + (!task.color ? ' is-on' : ''));
      clear.type = 'button';
      clear.title = 'Default colour';
      clear.disabled = this.readOnly;
      clear.addEventListener('click', () => {
        this._mutate(() => C.setTaskColor(this.data, task.id, null));
      });
      d.swatches.appendChild(clear);
      C.COLORS.forEach((hex) => {
        const b = el('button', 'gt-swatch' + (task.color === hex ? ' is-on' : ''));
        b.type = 'button';
        b.style.background = hex;
        b.disabled = this.readOnly;
        b.addEventListener('click', () => {
          this._mutate(() => C.setTaskColor(this.data, task.id, hex));
        });
        d.swatches.appendChild(b);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'gt-color-input';
      custom.value = task.color || this._taskColor(task);
      custom.title = 'Custom colour';
      custom.disabled = this.readOnly;
      custom.setAttribute('aria-label', 'Custom colour');
      if (task.color && C.COLORS.indexOf(task.color) < 0) custom.classList.add('is-on');
      custom.addEventListener('change', () => {
        this._mutate(() => C.setTaskColor(this.data, task.id, custom.value));
      });
      d.swatches.appendChild(custom);
      d.deps.innerHTML = '';
      C.visibleTasks(this.data).forEach((other) => {
        if (other.id === task.id) return;
        const label = el('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = (task.deps || []).indexOf(other.id) >= 0;
        box.disabled = this.readOnly;
        box.addEventListener('change', () => {
          this._mutate(() => {
            if (box.checked) return C.linkDep(this.data, task.id, other.id);
            return C.unlinkDep(this.data, task.id, other.id);
          });
        });
        label.append(box, el('span', null, other.title || 'Untitled'));
        d.deps.appendChild(label);
      });
      d.dupBtn.style.display = this.readOnly ? 'none' : '';
      d.delBtn.style.display = this.readOnly ? 'none' : '';
    }

    _setDates() {
      if (!this.detailId || this.readOnly) return;
      const d = this.drawer;
      this._mutate(() => C.setRange(this.data, this.detailId, d.start.value, d.end.value));
    }

    _toggleMilestone() {
      if (!this.detailId || this.readOnly) return;
      const on = this.drawer.milestone.checked;
      this._mutate(() => {
        const task = this.data.tasks[this.detailId];
        if (!task || C.hasChildren(this.data, task.id)) return false;
        task.milestone = on;
        if (on) task.end = task.start;
        else if (task.end === task.start) task.end = C.addDays(task.start, 4);
        task.updatedAt = C.nowIso();
        C.settle(this.data);
      });
    }

    scrollToToday() {
      const range = this._range || C.chartBounds(this.data);
      const px = this._px || C.pxPerDay(this.data.view.zoom);
      const x = C.diffDays(range.start, range.today) * px - 80;
      this.els.timeClip.scrollLeft = Math.max(0, x);
    }

    _menu(anchor) {
      const menu = this.els.menu;
      menu.innerHTML = '';
      menu.dataset.anchor = (anchor && anchor.title) || '';
      return menu;
    }

    _menuItem(menu, label, onClick) {
      const item = el('button', 'gt-menu-item', label);
      item.type = 'button';
      item.addEventListener('click', () => {
        onClick();
        this._closeMenu();
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
      }
      if (left + box.width > window.innerWidth - 10) left = Math.max(10, window.innerWidth - box.width - 10);
      if (top + box.height > window.innerHeight - 10) top = Math.max(10, window.innerHeight - box.height - 10);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    _closeMenu() {
      if (this.els) this.els.menu.classList.remove('open');
    }

    _deleteSelectedLink() {
      const link = this.selectedLink;
      if (!link || this.readOnly) return;
      const ok = this._mutate(() => (C.unlinkDep(this.data, link.succ, link.pred) ? undefined : false));
      this.selectedLink = null;
      if (ok) this._toast('Dependency removed', 'Undo', () => this.undo());
    }

    _openLinkMenu(point) {
      const link = this.selectedLink;
      if (!link) return;
      const pred = this.data.tasks[link.pred];
      const succ = this.data.tasks[link.succ];
      const menu = this._menu(null);
      menu.appendChild(el('div', 'gt-menu-label', (pred && pred.title ? pred.title : 'Task') + ' → ' + (succ && succ.title ? succ.title : 'Task')));
      const del = this._menuItem(menu, 'Remove dependency', () => this._deleteSelectedLink());
      del.classList.add('is-danger');
      this._showMenu(null, point);
    }

    _openTaskMenu(point, id) {
      const task = this.data.tasks[id];
      if (!task || this.readOnly) return;
      const menu = this._menu(null);
      this._menuItem(menu, 'Open details', () => this.openTask(id));
      this._menuItem(menu, 'Rename', () => this.startTitleEdit(id));
      this._menuItem(menu, 'Add task below', () => {
        this.selectedId = id;
        this.addTask({});
      });
      this._menuItem(menu, '+ Subtask', () => {
        this.selectedId = id;
        this.addTask({ child: true });
      });
      this._menuItem(menu, task.milestone ? 'Convert to task' : 'Mark as milestone', () => {
        this.detailId = id;
        this.drawer.milestone.checked = !task.milestone;
        this._toggleMilestone();
      });
      this._menuItem(menu, 'Indent', () => this._mutate(() => C.indentTask(this.data, id)));
      this._menuItem(menu, 'Outdent', () => this._mutate(() => C.outdentTask(this.data, id)));
      this._menuItem(menu, 'Duplicate', () => this.duplicateTask(id));
      menu.appendChild(el('div', 'gt-menu-sep'));
      const del = this._menuItem(menu, 'Delete', () => this.deleteTask(id));
      del.classList.add('is-danger');
      this._showMenu(null, point);
    }

    _openChartMenu(point) {
      const menu = this._menu(null);
      menu.appendChild(el('div', 'gt-menu-label', 'Zoom'));
      C.ZOOMS.forEach((z) => {
        const item = this._menuItem(menu, z[0].toUpperCase() + z.slice(1), () => {
          this._mutate(() => {
            this.data.view.zoom = z;
          });
        });
        item.classList.toggle('is-on', (this.data.view.zoom || 'day') === z);
      });
      menu.appendChild(el('div', 'gt-menu-sep'));
      this._menuItem(menu, this.data.view.showWeekends === false ? 'Shade weekends' : 'Hide weekend shading', () => {
        this._mutate(() => {
          this.data.view.showWeekends = this.data.view.showWeekends === false;
        });
      });
      this._menuItem(menu, 'Go to today', () => this.scrollToToday());
      menu.appendChild(el('div', 'gt-menu-sep'));
      this._menuItem(menu, 'Add task', () => this.addTask({}));
      this._menuItem(menu, 'Add milestone', () => this.addTask({ milestone: true }));
      this._menuItem(menu, 'Collapse all groups', () => this.collapseAll());
      this._menuItem(menu, 'Expand all groups', () => this.expandAll());
      this._showMenu(null, point);
    }

    _openExportMenu(anchor) {
      const menu = this._menu(anchor);
      menu.appendChild(el('div', 'gt-menu-label', 'Export chart'));
      this._menuItem(menu, 'PNG image', () => this._runExport('png'));
      this._menuItem(menu, 'SVG vector', () => this._runExport('svg'));
      this._menuItem(menu, 'PDF document', () => this._runExport('pdf'));
      this._menuItem(menu, 'CSV spreadsheet', () => this._runExport('csv'));
      menu.appendChild(el('div', 'gt-menu-sep'));
      this._menuItem(menu, 'Standalone HTML', async () => {
        try {
          await this.exportStandalone();
        } catch (err) {
          this._toast('Standalone export failed: ' + ((err && err.message) || err));
        }
      });
      this._showMenu(anchor);
    }

    async _runExport(format) {
      try {
        await this._doExport(format, { name: this.data.title || 'gantt' });
      } catch (err) {
        this._toast('Export failed: ' + ((err && err.message) || err));
      }
    }

    async _doExport(format, opts) {
      const stale = !isStandaloneDoc() && global.GanttExport && global.GanttExport._v !== EXPORT_V;
      if (!global.GanttExport || stale) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/gantt/export.js?v=10';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('Could not load export'));
          document.body.appendChild(s);
        });
      }
      if (!global.GanttExport || typeof global.GanttExport.run !== 'function') {
        throw new Error('Export is unavailable');
      }
      await global.GanttExport.run(format, this.data, opts || {});
    }

    async exportStandalone(filename) {
      const title = (this.data.title || 'Gantt').slice(0, 80);
      const json = JSON.stringify(C.normalize(this.data), null, 2).replace(/</g, '\\u003c');
      const html = await buildStandaloneHtml({
        kind: 'gantt',
        title,
        dataId: 'gantt-data',
        json,
        cssUrls: ['/gantt/engine.css'],
        jsUrls: ['/gantt/core.js', '/gantt/engine.js', '/gantt/export.js'],
      });
      downloadStandalone(html, filename || safeStandaloneName(title, 'gantt'));
    }

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

    _handleKey(ev) {
      if (this._destroyed || !this.els.root.isConnected) return;
      if (document.querySelector('.gt-dialog')) return;
      if (this.container.classList.contains('hidden') || (this.container.closest && this.container.closest('.hidden'))) return;
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
        if (this.detailId) this._closeDrawer();
        return;
      }
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z') && !typing) {
        ev.preventDefault();
        if (ev.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (typing) return;
      if (!this.els.root.contains(active) && active !== document.body && active !== document.documentElement) return;
      if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
        ev.preventDefault();
        this.els.help.classList.toggle('open');
        return;
      }
      if (ev.key === '/') {
        ev.preventDefault();
        if (this.els.search) this.els.search.focus();
        return;
      }
      if (this.readOnly) return;
      if (ev.key === 'n' || ev.key === 'N') {
        ev.preventDefault();
        this.addTask({});
        return;
      }
      if (ev.key === 'm' || ev.key === 'M') {
        ev.preventDefault();
        this.addTask({ milestone: true });
        return;
      }
      if (ev.key === 't' || ev.key === 'T') {
        ev.preventDefault();
        this.scrollToToday();
        return;
      }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && this.selectedLink) {
        ev.preventDefault();
        this._deleteSelectedLink();
        return;
      }
      const task = this.selectedId ? this.data.tasks[this.selectedId] : null;
      if (!task) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.startTitleEdit(task.id);
        return;
      }
      if (ev.key === 'e' || ev.key === 'E') {
        ev.preventDefault();
        this.openTask(task.id);
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        this._mutate(() => (ev.shiftKey ? C.outdentTask(this.data, task.id) : C.indentTask(this.data, task.id)));
        return;
      }
      if (mod && (ev.key === 'd' || ev.key === 'D')) {
        ev.preventDefault();
        this.duplicateTask(task.id);
        return;
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        this.deleteTask(task.id);
        return;
      }
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (mod) {
          this._mutate(() => C.nudgeTask(this.data, task.id, ev.key === 'ArrowDown' ? 1 : -1));
          return;
        }
        const list = this._shownTasks();
        const at = list.findIndex((t) => t.id === task.id);
        const next = list[at + (ev.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          this.selectedId = next.id;
          this._syncSelection();
        }
        return;
      }
      if (mod && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault();
        this._mutate(() => C.shiftTask(this.data, task.id, ev.key === 'ArrowRight' ? 1 : -1));
      }
    }
  }

  global.GanttEngine = GanttEngine;

  function safeStandaloneName(title, fallback) {
    const base = String(title || fallback || 'file').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return (base || fallback || 'file') + '-standalone.html';
  }

  function downloadStandalone(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const start = async () => {
      if (location.protocol !== 'file:') {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Could not prepare file'));
            reader.readAsDataURL(blob);
          });
          const comma = dataUrl.indexOf(',');
          const res = await fetch('/api/transient-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: filename,
              type: 'text/html;charset=utf-8',
              data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
            }),
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
    const title = String(opts.title || 'Gantt').replace(/[<>]/g, '');
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
    if (html.getAttribute('data-docviewer') !== 'gantt') return;
    const host = document.getElementById('accretion-root');
    const dataEl = document.getElementById('gantt-data');
    if (!host || !dataEl || typeof GanttEngine !== 'function' || !global.GanttCore) return;
    global.__accretionStandalone = true;
    const engine = new GanttEngine(host, { onChange: function () {} });
    const wrap = '<html data-docviewer="gantt"><script type="application/json" id="gantt-data">' + dataEl.textContent + '</script></html>';
    engine.loadFromHtml(wrap);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
    else bootStandalone();
  }
})(typeof window !== 'undefined' ? window : this);
