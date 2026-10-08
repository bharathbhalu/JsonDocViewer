/* DocViewer kanban core — serialize, columns, cards, filters. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KanbanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TITLE_MAX = 200;
  const COLUMN_TITLE_MAX = 60;
  const NOTES_MAX = 20000;

  const COLUMN_COLORS = ['#8c93a8', '#4f6ef7', '#0ea5e9', '#12b76a', '#f79009', '#f04438', '#a855f7', '#ec4899'];

  const LABEL_COLORS = [
    { id: 'slate', hex: '#64748b' },
    { id: 'blue', hex: '#4f6ef7' },
    { id: 'sky', hex: '#0ea5e9' },
    { id: 'teal', hex: '#14b8a6' },
    { id: 'green', hex: '#12b76a' },
    { id: 'lime', hex: '#84cc16' },
    { id: 'amber', hex: '#f79009' },
    { id: 'red', hex: '#f04438' },
    { id: 'pink', hex: '#ec4899' },
    { id: 'purple', hex: '#a855f7' },
  ];

  const MEMBER_COLORS = ['#4f6ef7', '#12b76a', '#f79009', '#ec4899', '#0ea5e9', '#a855f7', '#f04438', '#14b8a6'];

  const PRIORITIES = [
    { id: 'urgent', label: 'Urgent', hex: '#f04438', rank: 4 },
    { id: 'high', label: 'High', hex: '#f79009', rank: 3 },
    { id: 'medium', label: 'Medium', hex: '#4f6ef7', rank: 2 },
    { id: 'low', label: 'Low', hex: '#8c93a8', rank: 1 },
  ];
  const PRIORITY_IDS = PRIORITIES.map((p) => p.id);

  const SORTS = ['manual', 'due', 'priority', 'updated', 'title'];
  const DENSITIES = ['comfortable', 'compact'];
  const GROUP_BYS = ['', 'assignee', 'label', 'priority'];
  const DUE_FILTERS = ['', 'overdue', 'today', 'week', 'none'];

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

  function todayIso() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function isDateIso(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  function isHex(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  }

  function priorityMeta(id) {
    return PRIORITIES.find((p) => p.id === id) || null;
  }

  function priorityRank(id) {
    const meta = priorityMeta(id);
    return meta ? meta.rank : 0;
  }

  function labelColor(idOrHex) {
    if (isHex(idOrHex)) return idOrHex;
    const found = LABEL_COLORS.find((c) => c.id === idOrHex);
    return (found && found.hex) || LABEL_COLORS[0].hex;
  }

  // --- factories ---

  function defaultColumn(title, color) {
    return {
      id: uid('col_'),
      title: str(title, COLUMN_TITLE_MAX) || 'New column',
      color: isHex(color) ? color : COLUMN_COLORS[0],
      wip: null,
      collapsed: false,
      sort: 'manual',
    };
  }

  function defaultCard(columnId, title) {
    const ts = nowIso();
    return {
      id: uid('card_'),
      columnId: columnId || null,
      order: 0,
      title: str(title, TITLE_MAX),
      notes: '',
      labels: [],
      assignee: null,
      priority: null,
      due: null,
      checklist: [],
      links: [],
      cover: null,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function defaultLabel(name, color) {
    return { id: uid('lab_'), name: str(name, 40) || 'Label', color: labelColor(color) };
  }

  function defaultMember(name, color) {
    return { id: uid('mem_'), name: str(name, 40) || 'Member', color: isHex(color) ? color : MEMBER_COLORS[0] };
  }

  function defaultChecklistItem(text) {
    return { id: uid('chk_'), text: str(text, 240), done: false };
  }

  function defaultView() {
    return {
      filters: { text: '', labels: [], assignee: '', priority: '', due: '' },
      density: 'comfortable',
      groupBy: '',
      showArchived: false,
    };
  }

  function createEmpty() {
    return {
      version: 1,
      title: 'Board',
      columns: [],
      cards: {},
      labels: [],
      members: [],
      view: defaultView(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  function createStarter() {
    const data = createEmpty();
    const todo = defaultColumn('To do', COLUMN_COLORS[1]);
    const doing = defaultColumn('In progress', COLUMN_COLORS[4]);
    const done = defaultColumn('Done', COLUMN_COLORS[3]);
    data.columns = [todo, doing, done];
    data.labels = [
      defaultLabel('Feature', 'blue'),
      defaultLabel('Bug', 'red'),
      defaultLabel('Chore', 'slate'),
    ];
    const first = defaultCard(todo.id, 'Write down what needs doing');
    first.notes = 'Double-click a card to open it. Drag cards between columns.';
    const second = defaultCard(todo.id, 'Drag me to another column');
    data.cards = { [first.id]: first, [second.id]: second };
    return normalize(data);
  }

  // --- normalize ---

  function normalizeChecklist(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    raw.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : uid('chk_');
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, text: str(item.text, 240), done: !!item.done });
    });
    return out;
  }

  function normalizeLinks(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach((item) => {
      if (!item) return;
      if (typeof item === 'string') {
        if (item.trim()) out.push({ url: item.trim().slice(0, 600), title: '' });
        return;
      }
      if (typeof item !== 'object') return;
      const url = str(item.url, 600).trim();
      if (!url) return;
      out.push({ url, title: str(item.title, 120) });
    });
    return out.slice(0, 20);
  }

  function normalizeLabels(raw) {
    const out = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((l) => {
      if (!l || typeof l !== 'object') return;
      const id = typeof l.id === 'string' && l.id.trim() ? l.id.trim() : uid('lab_');
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: str(l.name, 40) || 'Label', color: labelColor(l.color) });
    });
    return out.slice(0, 60);
  }

  function normalizeMembers(raw) {
    const out = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : uid('mem_');
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        name: str(m.name, 40) || 'Member',
        color: isHex(m.color) ? m.color : MEMBER_COLORS[i % MEMBER_COLORS.length],
      });
    });
    return out.slice(0, 60);
  }

  function normalizeColumns(raw) {
    const out = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : uid('col_');
      if (seen.has(id)) return;
      seen.add(id);
      const wipRaw = Number(c.wip);
      out.push({
        id,
        title: str(c.title, COLUMN_TITLE_MAX) || `Column ${i + 1}`,
        color: isHex(c.color) ? c.color : COLUMN_COLORS[i % COLUMN_COLORS.length],
        wip: Number.isFinite(wipRaw) && wipRaw > 0 ? Math.min(999, Math.round(wipRaw)) : null,
        collapsed: !!c.collapsed,
        sort: SORTS.includes(c.sort) ? c.sort : 'manual',
      });
    });
    return out.slice(0, 40);
  }

  function normalizeView(raw) {
    const view = defaultView();
    if (!raw || typeof raw !== 'object') return view;
    const f = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
    view.filters.text = str(f.text, 120);
    view.filters.labels = Array.isArray(f.labels) ? f.labels.filter((x) => typeof x === 'string').slice(0, 30) : [];
    view.filters.assignee = str(f.assignee, 80);
    view.filters.priority = PRIORITY_IDS.includes(f.priority) ? f.priority : '';
    view.filters.due = DUE_FILTERS.includes(f.due) ? f.due : '';
    view.density = DENSITIES.includes(raw.density) ? raw.density : 'comfortable';
    view.groupBy = GROUP_BYS.includes(raw.groupBy) ? raw.groupBy : '';
    view.showArchived = !!raw.showArchived;
    return view;
  }

  function normalize(raw) {
    const data = createEmpty();
    if (!raw || typeof raw !== 'object') return data;
    data.title = str(raw.title, 120) || 'Board';
    data.columns = normalizeColumns(raw.columns);
    data.labels = normalizeLabels(raw.labels);
    data.members = normalizeMembers(raw.members);
    data.view = normalizeView(raw.view);
    data.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
    data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : data.createdAt;

    const liveLabels = new Set(data.labels.map((l) => l.id));
    const liveMembers = new Set(data.members.map((m) => m.id));
    // A saved filter on a label/person that no longer exists would hide every
    // card with no way to clear it from the filter chips.
    data.view.filters.labels = data.view.filters.labels.filter((id) => liveLabels.has(id));
    if (data.view.filters.assignee && data.view.filters.assignee !== '__none' && !liveMembers.has(data.view.filters.assignee)) data.view.filters.assignee = '';
    const liveColumns = new Set(data.columns.map((c) => c.id));
    const fallbackColumn = data.columns.length ? data.columns[0].id : null;

    const cards = raw.cards && typeof raw.cards === 'object' ? raw.cards : {};
    Object.keys(cards).forEach((id) => {
      const c = cards[id];
      if (!c || typeof c !== 'object') return;
      // A card whose column vanished is kept and parked in the first column
      // rather than silently dropped; only a board with no columns loses it.
      const columnId = liveColumns.has(c.columnId) ? c.columnId : fallbackColumn;
      if (!columnId) return;
      const createdAt = typeof c.createdAt === 'string' ? c.createdAt : nowIso();
      data.cards[id] = {
        id,
        columnId,
        order: Number.isFinite(Number(c.order)) ? Number(c.order) : 0,
        title: str(c.title, TITLE_MAX),
        notes: str(c.notes, NOTES_MAX),
        labels: Array.isArray(c.labels) ? c.labels.filter((x) => liveLabels.has(x)).slice(0, 30) : [],
        assignee: liveMembers.has(c.assignee) ? c.assignee : null,
        priority: PRIORITY_IDS.includes(c.priority) ? c.priority : null,
        due: isDateIso(c.due) ? c.due : null,
        checklist: normalizeChecklist(c.checklist),
        links: normalizeLinks(c.links),
        cover: isHex(c.cover) ? c.cover : null,
        archived: !!c.archived,
        createdAt,
        updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : createdAt,
      };
    });

    data.columns.forEach((col) => reindex(data, col.id));
    return data;
  }

  // --- ordering ---

  function cardList(data, columnId) {
    const out = [];
    const cards = data.cards || {};
    Object.keys(cards).forEach((id) => {
      if (cards[id] && cards[id].columnId === columnId) out.push(cards[id]);
    });
    out.sort((a, b) => (a.order - b.order) || String(a.createdAt).localeCompare(String(b.createdAt)));
    return out;
  }

  function reindex(data, columnId) {
    cardList(data, columnId).forEach((card, i) => {
      card.order = i;
    });
  }

  function columnOf(data, cardId) {
    const card = data.cards[cardId];
    return card ? card.columnId : null;
  }

  // Insert before `beforeCardId`, or append when it is null. Working with a
  // sibling id instead of an index keeps drops correct while filters hide rows.
  function moveCard(data, cardId, toColumnId, beforeCardId) {
    const card = data.cards[cardId];
    if (!card) return false;
    const target = (data.columns || []).find((c) => c.id === toColumnId);
    if (!target) return false;
    const from = card.columnId;
    // Dropping a card just above itself means "stay put".
    if (beforeCardId === cardId && from === toColumnId) return true;
    const list = cardList(data, toColumnId).filter((c) => c.id !== cardId);
    let at = list.length;
    if (beforeCardId) {
      const idx = list.findIndex((c) => c.id === beforeCardId);
      if (idx >= 0) at = idx;
    }
    list.splice(at, 0, card);
    card.columnId = toColumnId;
    card.updatedAt = nowIso();
    list.forEach((c, i) => {
      c.order = i;
    });
    if (from !== toColumnId) reindex(data, from);
    return true;
  }

  function moveColumn(data, columnId, beforeColumnId) {
    const cols = data.columns || [];
    const idx = cols.findIndex((c) => c.id === columnId);
    if (idx < 0) return false;
    const [col] = cols.splice(idx, 1);
    let at = cols.length;
    if (beforeColumnId) {
      const before = cols.findIndex((c) => c.id === beforeColumnId);
      if (before >= 0) at = before;
    }
    cols.splice(at, 0, col);
    return true;
  }

  function nudgeCard(data, cardId, delta) {
    const card = data.cards[cardId];
    if (!card) return false;
    const list = cardList(data, card.columnId).filter((c) => !c.archived);
    const idx = list.findIndex((c) => c.id === cardId);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= list.length) return false;
    const before = delta > 0 ? list[next + 1] : list[next];
    return moveCard(data, cardId, card.columnId, before ? before.id : null);
  }

  function shiftCardColumn(data, cardId, delta) {
    const card = data.cards[cardId];
    if (!card) return false;
    const cols = data.columns || [];
    const idx = cols.findIndex((c) => c.id === card.columnId);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= cols.length) return false;
    return moveCard(data, cardId, cols[next].id, null);
  }

  // --- filtering, sorting, stats ---

  function cardText(card) {
    if (!card) return '';
    const checks = (card.checklist || []).map((i) => i.text).join(' ');
    const links = (card.links || []).map((l) => `${l.title} ${l.url}`).join(' ');
    return `${card.title} ${card.notes} ${checks} ${links}`;
  }

  function dueState(card, today) {
    if (!card || !card.due) return '';
    const ref = isDateIso(today) ? today : todayIso();
    if (card.due < ref) return 'overdue';
    if (card.due === ref) return 'today';
    const soon = new Date(ref + 'T00:00:00');
    soon.setDate(soon.getDate() + 7);
    // Local calendar date (toISOString would shift it by the UTC offset).
    const soonIso = soon.getFullYear() + '-' + String(soon.getMonth() + 1).padStart(2, '0') + '-' + String(soon.getDate()).padStart(2, '0');
    if (card.due <= soonIso) return 'soon';
    return 'later';
  }

  function hasActiveFilter(filters) {
    const f = filters || {};
    return !!(String(f.text || '').trim() || (f.labels && f.labels.length) || f.assignee || f.priority || f.due);
  }

  function cardMatchesFilter(card, filters, today) {
    if (!card) return false;
    const f = filters || {};
    const text = String(f.text || '').trim().toLowerCase();
    if (text && !cardText(card).toLowerCase().includes(text)) return false;
    if (f.labels && f.labels.length) {
      const own = new Set(card.labels || []);
      if (!f.labels.some((id) => own.has(id))) return false;
    }
    if (f.assignee && card.assignee !== f.assignee) return false;
    if (f.priority && card.priority !== f.priority) return false;
    if (f.due) {
      const state = dueState(card, today);
      if (f.due === 'none' && card.due) return false;
      if (f.due === 'overdue' && state !== 'overdue') return false;
      if (f.due === 'today' && state !== 'today') return false;
      if (f.due === 'week' && !(state === 'overdue' || state === 'today' || state === 'soon')) return false;
    }
    return true;
  }

  function sortCards(list, mode) {
    if (mode === 'due') {
      return list.slice().sort((a, b) => {
        if (!a.due && !b.due) return a.order - b.order;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due.localeCompare(b.due) || (a.order - b.order);
      });
    }
    if (mode === 'priority') {
      return list.slice().sort((a, b) => (priorityRank(b.priority) - priorityRank(a.priority)) || (a.order - b.order));
    }
    if (mode === 'updated') {
      return list.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || (a.order - b.order));
    }
    if (mode === 'title') {
      return list.slice().sort((a, b) => String(a.title).localeCompare(String(b.title)) || (a.order - b.order));
    }
    return list;
  }

  // Cards for rendering: ordered, archive-aware, filtered, then column-sorted.
  function columnCards(data, columnId, opts) {
    const o = opts || {};
    const view = data.view || defaultView();
    const showArchived = o.showArchived != null ? o.showArchived : view.showArchived;
    const filters = o.filters !== undefined ? o.filters : view.filters;
    const col = (data.columns || []).find((c) => c.id === columnId);
    let list = cardList(data, columnId);
    if (!showArchived) list = list.filter((c) => !c.archived);
    if (hasActiveFilter(filters)) list = list.filter((c) => cardMatchesFilter(c, filters, o.today));
    return sortCards(list, (o.sort || (col && col.sort)) || 'manual');
  }

  function checklistProgress(card) {
    const items = (card && card.checklist) || [];
    const done = items.filter((i) => i.done).length;
    return { done, total: items.length, ratio: items.length ? done / items.length : 0 };
  }

  function boardStats(data, today) {
    const cards = Object.keys(data.cards || {}).map((id) => data.cards[id]);
    const live = cards.filter((c) => !c.archived);
    let checkDone = 0;
    let checkTotal = 0;
    live.forEach((c) => {
      const p = checklistProgress(c);
      checkDone += p.done;
      checkTotal += p.total;
    });
    const perColumn = {};
    (data.columns || []).forEach((col) => {
      const list = live.filter((c) => c.columnId === col.id);
      perColumn[col.id] = {
        count: list.length,
        overLimit: !!(col.wip && list.length > col.wip),
      };
    });
    return {
      total: live.length,
      archived: cards.length - live.length,
      overdue: live.filter((c) => dueState(c, today) === 'overdue').length,
      dueToday: live.filter((c) => dueState(c, today) === 'today').length,
      unassigned: live.filter((c) => !c.assignee).length,
      checklist: { done: checkDone, total: checkTotal },
      perColumn,
    };
  }

  function groupRows(data, groupBy) {
    if (groupBy === 'assignee') {
      const rows = (data.members || []).map((m) => ({ id: m.id, title: m.name, color: m.color, match: (c) => c.assignee === m.id }));
      rows.push({ id: '__none', title: 'Unassigned', color: '', match: (c) => !c.assignee });
      return rows;
    }
    if (groupBy === 'label') {
      const rows = (data.labels || []).map((l) => ({ id: l.id, title: l.name, color: l.color, match: (c) => (c.labels || []).includes(l.id) }));
      rows.push({ id: '__none', title: 'No label', color: '', match: (c) => !(c.labels || []).length });
      return rows;
    }
    if (groupBy === 'priority') {
      const rows = PRIORITIES.map((p) => ({ id: p.id, title: p.label, color: p.hex, match: (c) => c.priority === p.id }));
      rows.push({ id: '__none', title: 'No priority', color: '', match: (c) => !c.priority });
      return rows;
    }
    return [];
  }

  // --- serialize ---

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    // Keep the document title and the model in step; otherwise a board saved
    // under one name reopens under another.
    if (title) norm.title = str(title, 120);
    norm.updatedAt = nowIso();
    const json = JSON.stringify(norm).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Kanban').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="kanban">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="kanban-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isKanbanHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']kanban["']/.test(html);
  }

  function parseHtml(html) {
    if (!isKanbanHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']kanban-data["'][^>]*>([\s\S]*?)<\/script>/i);
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

  // --- CSV ---

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const CSV_HEADERS = ['Title', 'Column', 'Labels', 'Assignee', 'Priority', 'Due', 'Checklist', 'Notes', 'Archived'];

  function toCsv(data) {
    const labelName = (id) => {
      const l = (data.labels || []).find((x) => x.id === id);
      return l ? l.name : '';
    };
    const rows = [CSV_HEADERS.join(',')];
    (data.columns || []).forEach((col) => {
      cardList(data, col.id).forEach((card) => {
        const p = checklistProgress(card);
        rows.push([
          card.title,
          col.title,
          (card.labels || []).map(labelName).filter(Boolean).join('; '),
          (() => {
            const m = (data.members || []).find((x) => x.id === card.assignee);
            return m ? m.name : '';
          })(),
          card.priority || '',
          card.due || '',
          p.total ? `${p.done}/${p.total}` : '',
          card.notes,
          card.archived ? 'yes' : '',
        ].map(csvCell).join(','));
      });
    });
    return rows.join('\n') + '\n';
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const s = String(text || '').replace(/\r\n?/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === ',') {
        row.push(cell);
        cell = '';
        continue;
      }
      if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        continue;
      }
      cell += ch;
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => String(c).trim()));
  }

  // Import rows as new cards, creating columns and labels that do not exist yet.
  function fromCsv(text, data) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0 };
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const at = (name) => header.indexOf(name);
    const idx = {
      title: at('title'),
      column: at('column'),
      labels: at('labels'),
      assignee: at('assignee'),
      priority: at('priority'),
      due: at('due'),
      notes: at('notes'),
    };
    const body = idx.title >= 0 ? rows.slice(1) : rows;
    if (idx.title < 0) idx.title = 0;
    let added = 0;
    body.forEach((r) => {
      const title = String(r[idx.title] || '').trim();
      if (!title) return;
      const colTitle = idx.column >= 0 ? String(r[idx.column] || '').trim() : '';
      let col = colTitle
        ? (data.columns || []).find((c) => c.title.toLowerCase() === colTitle.toLowerCase())
        : data.columns[0];
      if (!col) {
        col = defaultColumn(colTitle || 'Imported', COLUMN_COLORS[data.columns.length % COLUMN_COLORS.length]);
        data.columns.push(col);
      }
      const card = defaultCard(col.id, title);
      card.order = cardList(data, col.id).length;
      if (idx.notes >= 0) card.notes = str(r[idx.notes], NOTES_MAX);
      if (idx.due >= 0 && isDateIso(String(r[idx.due]).trim())) card.due = String(r[idx.due]).trim();
      if (idx.priority >= 0) {
        const p = String(r[idx.priority] || '').trim().toLowerCase();
        if (PRIORITY_IDS.includes(p)) card.priority = p;
      }
      if (idx.assignee >= 0) {
        const name = String(r[idx.assignee] || '').trim();
        if (name) {
          let m = (data.members || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!m) {
            m = defaultMember(name, MEMBER_COLORS[data.members.length % MEMBER_COLORS.length]);
            data.members.push(m);
          }
          card.assignee = m.id;
        }
      }
      if (idx.labels >= 0) {
        String(r[idx.labels] || '')
          .split(/[;|]/)
          .map((x) => x.trim())
          .filter(Boolean)
          .forEach((name) => {
            let l = (data.labels || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!l) {
              l = defaultLabel(name, LABEL_COLORS[data.labels.length % LABEL_COLORS.length].id);
              data.labels.push(l);
            }
            if (!card.labels.includes(l.id)) card.labels.push(l.id);
          });
      }
      data.cards[card.id] = card;
      added += 1;
    });
    (data.columns || []).forEach((c) => reindex(data, c.id));
    return { added };
  }

  // --- templates ---

  const TEMPLATE_LIST = [
    { id: 'blank', label: 'Blank', hint: 'Three empty columns' },
    { id: 'sprint', label: 'Sprint', hint: 'Backlog through Done' },
    { id: 'bugs', label: 'Bug triage', hint: 'Triage, confirmed, fixing' },
    { id: 'personal', label: 'Personal', hint: 'Today, this week, later' },
    { id: 'content', label: 'Content pipeline', hint: 'Idea to published' },
  ];

  function buildFromColumns(title, columnTitles, labels) {
    const data = createEmpty();
    data.title = title;
    data.columns = columnTitles.map((t, i) => defaultColumn(t, COLUMN_COLORS[(i + 1) % COLUMN_COLORS.length]));
    data.labels = (labels || []).map((l, i) => defaultLabel(l, LABEL_COLORS[(i + 1) % LABEL_COLORS.length].id));
    return data;
  }

  function buildTemplate(id) {
    if (id === 'sprint') {
      return normalize(buildFromColumns('Sprint', ['Backlog', 'Ready', 'In progress', 'Review', 'Done'], ['Feature', 'Bug', 'Chore', 'Spike']));
    }
    if (id === 'bugs') {
      return normalize(buildFromColumns('Bug triage', ['Reported', 'Triaged', 'Fixing', 'Verifying', 'Closed'], ['Blocker', 'Major', 'Minor', 'Regression']));
    }
    if (id === 'personal') {
      return normalize(buildFromColumns('Personal', ['Today', 'This week', 'Later', 'Done'], ['Home', 'Work', 'Errand']));
    }
    if (id === 'content') {
      return normalize(buildFromColumns('Content pipeline', ['Ideas', 'Drafting', 'Editing', 'Scheduled', 'Published'], ['Post', 'Video', 'Newsletter']));
    }
    if (id === 'blank') {
      return normalize(buildFromColumns('Board', ['To do', 'In progress', 'Done'], []));
    }
    return createStarter();
  }

  return {
    COLUMN_COLORS,
    LABEL_COLORS,
    MEMBER_COLORS,
    PRIORITIES,
    PRIORITY_IDS,
    SORTS,
    DENSITIES,
    GROUP_BYS,
    DUE_FILTERS,
    CSV_HEADERS,
    uid,
    clamp,
    nowIso,
    todayIso,
    isDateIso,
    isHex,
    priorityMeta,
    priorityRank,
    labelColor,
    defaultColumn,
    defaultCard,
    defaultLabel,
    defaultMember,
    defaultChecklistItem,
    defaultView,
    createEmpty,
    createStarter,
    normalize,
    normalizeView,
    cardList,
    reindex,
    columnOf,
    moveCard,
    moveColumn,
    nudgeCard,
    shiftCardColumn,
    cardText,
    dueState,
    hasActiveFilter,
    cardMatchesFilter,
    sortCards,
    columnCards,
    checklistProgress,
    boardStats,
    groupRows,
    serializeToHtml,
    isKanbanHtml,
    parseHtml,
    cloneData,
    toCsv,
    parseCsv,
    fromCsv,
    TEMPLATE_LIST,
    buildTemplate,
  };
});
