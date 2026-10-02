/* DocViewer gantt core — tasks, dates, dependencies, hierarchy. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GanttCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TITLE_MAX = 200;
  const NOTES_MAX = 20000;
  const LABEL_NAME_MAX = 32;
  const LABEL_MAX = 48;
  const TASK_LABEL_MAX = 8;
  const DAY = 86400000;
  const ZOOMS = ['day', 'week', 'month'];
  const MODES = ['chart', 'sheet', 'analytics'];
  const PRIORITIES = ['', 'low', 'medium', 'high'];
  const PX = { day: 28, week: 14, month: 5 };
  const COLORS = ['#4f6ef7', '#0ea5e9', '#12b76a', '#f79009', '#f04438', '#a855f7', '#ec4899', '#64748b'];

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

  function isDateIso(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  function isHex(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  }

  function parseDay(iso) {
    if (!isDateIso(iso)) return null;
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    const ms = Date.UTC(y, m - 1, d);
    const check = new Date(ms);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return ms;
  }

  function formatDay(ms) {
    const d = new Date(ms);
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + m + '-' + day;
  }

  function todayIso() {
    const d = new Date();
    return formatDay(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function addDays(iso, n) {
    const ms = parseDay(iso);
    if (ms == null || !Number.isFinite(n)) return iso;
    return formatDay(ms + Math.round(n) * DAY);
  }

  function diffDays(a, b) {
    const ma = parseDay(a);
    const mb = parseDay(b);
    if (ma == null || mb == null) return 0;
    return Math.round((mb - ma) / DAY);
  }

  function durationDays(task) {
    if (!task || !isDateIso(task.start) || !isDateIso(task.end)) return 1;
    return Math.max(1, diffDays(task.start, task.end) + 1);
  }

  function pxPerDay(zoom) {
    return PX[zoom] || PX.day;
  }

  function touch(task) {
    if (task) task.updatedAt = nowIso();
  }

  function defaultFilters() {
    return { text: '', priority: '', kind: '', progress: '', assignee: '', label: '' };
  }

  function normalizeFilters(raw) {
    const f = defaultFilters();
    if (!raw || typeof raw !== 'object') return f;
    f.text = str(raw.text, 120);
    if (PRIORITIES.indexOf(raw.priority) >= 0 || raw.priority === 'none') f.priority = raw.priority;
    if (['', 'task', 'summary', 'milestone'].indexOf(raw.kind) >= 0) f.kind = raw.kind;
    if (['', 'todo', 'doing', 'done'].indexOf(raw.progress) >= 0) f.progress = raw.progress;
    f.assignee = str(raw.assignee, 80);
    f.label = str(raw.label, 80);
    return f;
  }

  function hasActiveFilter(f) {
    return !!(f && (f.text || f.priority || f.kind || f.progress || f.assignee || f.label));
  }

  function labelsList(data) {
    return Object.keys((data && data.labels) || {}).map((id) => data.labels[id]).filter(Boolean)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  }

  function normalizeLabels(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach((key) => {
      if (Object.keys(out).length >= LABEL_MAX) return;
      const src = raw[key];
      if (!src || typeof src !== 'object') return;
      const id = str(src.id || key, 80);
      if (!id || out[id]) return;
      const name = str(src.name, LABEL_NAME_MAX).trim();
      if (!name) return;
      out[id] = {
        id,
        name,
        color: isHex(src.color) ? src.color : COLORS[Object.keys(out).length % COLORS.length],
      };
    });
    return out;
  }

  function normalizeLabelIds(raw, catalog) {
    const seen = {};
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((id) => {
      const key = str(id, 80);
      if (!key || !catalog || !catalog[key] || seen[key] || out.length >= TASK_LABEL_MAX) return;
      seen[key] = true;
      out.push(key);
    });
    return out;
  }

  function taskLabelIds(task) {
    return Array.isArray(task && task.labelIds) ? task.labelIds.filter(Boolean) : [];
  }

  function taskLabels(data, task) {
    return taskLabelIds(task).map((id) => data && data.labels && data.labels[id]).filter(Boolean);
  }

  function addLabel(data, props) {
    if (!data.labels) data.labels = {};
    const o = props || {};
    const name = str(o.name, LABEL_NAME_MAX).trim();
    if (!name) return null;
    const existing = labelsList(data).find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (isHex(o.color)) existing.color = o.color;
      return existing;
    }
    if (Object.keys(data.labels).length >= LABEL_MAX) return null;
    const label = {
      id: str(o.id, 80) && !data.labels[o.id] ? str(o.id, 80) : uid('lab_'),
      name,
      color: isHex(o.color) ? o.color : COLORS[Object.keys(data.labels).length % COLORS.length],
    };
    data.labels[label.id] = label;
    return label;
  }

  function setLabelColor(data, id, color) {
    const label = data.labels && data.labels[id];
    if (!label || !isHex(color)) return false;
    label.color = color;
    return true;
  }

  function renameLabel(data, id, name) {
    const label = data.labels && data.labels[id];
    const next = str(name, LABEL_NAME_MAX).trim();
    if (!label || !next) return false;
    label.name = next;
    return true;
  }

  function deleteLabel(data, id) {
    if (!data.labels || !data.labels[id]) return false;
    delete data.labels[id];
    taskValues(data).forEach((t) => {
      t.labelIds = (t.labelIds || []).filter((x) => x !== id);
    });
    return true;
  }

  function toggleTaskLabel(data, taskId, labelId) {
    const task = data.tasks[taskId];
    const label = data.labels && data.labels[labelId];
    if (!task || !label) return false;
    const ids = taskLabelIds(task).slice();
    const at = ids.indexOf(labelId);
    if (at >= 0) ids.splice(at, 1);
    else {
      if (ids.length >= TASK_LABEL_MAX) return false;
      ids.push(labelId);
    }
    task.labelIds = ids;
    touch(task);
    return true;
  }

  function setTaskColor(data, taskId, color) {
    const task = data.tasks[taskId];
    if (!task) return false;
    task.color = isHex(color) ? color : null;
    touch(task);
    return true;
  }

  function taskKind(data, task) {
    if (!task) return 'task';
    if (task.milestone) return 'milestone';
    if (hasChildren(data, task.id)) return 'summary';
    return 'task';
  }

  function taskMatches(data, task, f) {
    if (!task || !hasActiveFilter(f)) return true;
    if (f.priority === 'none') {
      if (task.priority) return false;
    } else if (f.priority && (task.priority || '') !== f.priority) return false;
    if (f.kind && taskKind(data, task) !== f.kind) return false;
    if (f.progress) {
      const p = Math.round(Number(task.progress) || 0);
      if (f.progress === 'todo' && p !== 0) return false;
      if (f.progress === 'doing' && (p <= 0 || p >= 100)) return false;
      if (f.progress === 'done' && p < 100) return false;
    }
    if (f.assignee) {
      const who = String(task.assignee || '').trim();
      if (f.assignee === '__none__') {
        if (who) return false;
      } else if (who.toLowerCase() !== f.assignee.toLowerCase()) return false;
    }
    if (f.label === '__none__') {
      if (taskLabelIds(task).length) return false;
    } else if (f.label && taskLabelIds(task).indexOf(f.label) < 0) return false;
    if (f.text) {
      const q = f.text.toLowerCase();
      const deps = (task.deps || []).map((id) => data.tasks[id] && data.tasks[id].title).filter(Boolean).join(' ');
      const tags = taskLabels(data, task).map((l) => l.name).join(' ');
      const blob = [task.title, task.assignee, task.notes, task.priority, deps, tags].join(' ').toLowerCase();
      if (blob.indexOf(q) < 0) return false;
    }
    return true;
  }

  function allTasksInOrder(data) {
    const out = [];
    const walk = (parentId) => {
      childrenOf(data, parentId).forEach((t) => {
        out.push(t);
        walk(t.id);
      });
    };
    walk(null);
    return out;
  }

  function filteredTasks(data) {
    const f = data.view && data.view.filters;
    if (!hasActiveFilter(f)) return visibleTasks(data);
    const all = allTasksInOrder(data);
    const hit = new Set();
    all.forEach((t) => {
      if (taskMatches(data, t, f)) hit.add(t.id);
    });
    const keep = new Set();
    hit.forEach((id) => {
      let cur = data.tasks[id];
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        keep.add(cur.id);
        seen.add(cur.id);
        cur = cur.parentId ? data.tasks[cur.parentId] : null;
      }
    });
    return all.filter((t) => keep.has(t.id));
  }

  function matchingTasks(data, filters) {
    const f = filters || (data && data.view && data.view.filters);
    const all = allTasksInOrder(data);
    if (!hasActiveFilter(f)) return all;
    return all.filter((t) => taskMatches(data, t, f));
  }

  function slimTask(task) {
    if (!task) return null;
    return {
      id: task.id,
      title: task.title || 'Untitled',
      start: task.start || '',
      end: task.end || '',
      progress: clamp(Math.round(Number(task.progress) || 0), 0, 100),
      assignee: String(task.assignee || '').trim(),
      priority: task.priority || '',
    };
  }

  function analyze(data) {
    const tasks = matchingTasks(data);
    const today = todayIso();
    const kinds = { task: 0, summary: 0, milestone: 0 };
    const status = { todo: 0, doing: 0, done: 0 };
    const priority = { high: 0, medium: 0, low: 0, none: 0 };
    const health = { overdue: 0, atRisk: 0, upcoming: 0, unassigned: 0, links: 0, blocked: 0 };
    const people = {};
    const lists = { overdue: [], atRisk: [], blocked: [], highOpen: [] };
    let weightedDone = 0;
    let weightedDays = 0;
    let spanStart = null;
    let spanEnd = null;
    tasks.forEach((t) => {
      const kind = taskKind(data, t);
      kinds[kind] += 1;
      const p = clamp(Math.round(Number(t.progress) || 0), 0, 100);
      const work = kind !== 'summary';
      if (work) {
        if (p <= 0) status.todo += 1;
        else if (p >= 100) status.done += 1;
        else status.doing += 1;
      }
      const pri = t.priority || '';
      const who = String(t.assignee || '').trim();
      if (work) {
        if (pri === 'high' || pri === 'medium' || pri === 'low') priority[pri] += 1;
        else priority.none += 1;
        if (!who) health.unassigned += 1;
        else {
          if (!people[who]) people[who] = { name: who, count: 0, done: 0, days: 0, progress: 0 };
          people[who].count += 1;
          people[who].days += durationDays(t);
          people[who].progress += p;
          if (p >= 100) people[who].done += 1;
        }
        health.links += (t.deps || []).length;
        const days = durationDays(t);
        weightedDays += days;
        weightedDone += days * p;
      }
      if (t.start && (!spanStart || t.start < spanStart)) spanStart = t.start;
      if (t.end && (!spanEnd || t.end > spanEnd)) spanEnd = t.end;
      if (!work) return;
      const open = p < 100;
      const blocked = (t.deps || []).some((id) => {
        const pred = data.tasks[id];
        return pred && clamp(Math.round(Number(pred.progress) || 0), 0, 100) < 100;
      });
      if (open && blocked) {
        health.blocked += 1;
        lists.blocked.push(slimTask(t));
      }
      if (open && t.end && t.end < today) {
        health.overdue += 1;
        lists.overdue.push(slimTask(t));
      } else if (open && t.end && t.end <= addDays(today, 3)) {
        health.atRisk += 1;
        lists.atRisk.push(slimTask(t));
      }
      if (p === 0 && t.start && t.start >= today && t.start <= addDays(today, 7)) health.upcoming += 1;
      if (open && pri === 'high') lists.highOpen.push(slimTask(t));
    });
    let elapsed = 0;
    let remaining = 0;
    const spanDays = spanStart && spanEnd ? diffDays(spanStart, spanEnd) + 1 : 0;
    if (spanStart && spanEnd) {
      if (today < spanStart) remaining = spanDays;
      else if (today > spanEnd) elapsed = spanDays;
      else {
        elapsed = diffDays(spanStart, today);
        remaining = diffDays(today, spanEnd);
      }
    }
    const labels = labelsList(data).map((lab) => ({
      id: lab.id,
      name: lab.name,
      color: lab.color,
      count: tasks.filter((t) => taskLabelIds(t).indexOf(lab.id) >= 0).length,
    })).filter((l) => l.count);
    const assignees = Object.keys(people).sort((a, b) => a.localeCompare(b)).map((name) => {
      const row = people[name];
      return {
        name: row.name,
        count: row.count,
        done: row.done,
        days: row.days,
        avgProgress: row.count ? Math.round(row.progress / row.count) : 0,
      };
    });
    return {
      total: tasks.length,
      work: kinds.task + kinds.milestone,
      progress: weightedDays ? Math.round(weightedDone / weightedDays) : 0,
      today,
      span: { start: spanStart, end: spanEnd, days: spanDays, elapsed, remaining },
      kinds,
      status,
      priority,
      health,
      assignees,
      labels,
      lists,
    };
  }

  function defaultView() {
    return { zoom: 'day', mode: 'chart', showWeekends: true, filters: defaultFilters() };
  }

  function normPriority(v) {
    const s = String(v || '').toLowerCase().trim();
    return PRIORITIES.indexOf(s) >= 0 ? s : '';
  }

  function defaultTask(title, start, end) {
    const ts = nowIso();
    const s = isDateIso(start) ? start : todayIso();
    let e = isDateIso(end) ? end : addDays(s, 4);
    if (e < s) e = s;
    return {
      id: uid('task_'),
      title: str(title, TITLE_MAX),
      start: s,
      end: e,
      milestone: false,
      progress: 0,
      parentId: null,
      collapsed: false,
      order: 0,
      color: null,
      assignee: '',
      priority: '',
      notes: '',
      deps: [],
      labelIds: [],
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function createEmpty() {
    const ts = nowIso();
    return {
      version: 1,
      title: 'Gantt',
      tasks: {},
      labels: {},
      view: defaultView(),
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function taskValues(data) {
    return Object.keys(data.tasks || {}).map((id) => data.tasks[id]).filter(Boolean);
  }

  function childrenOf(data, parentId) {
    const pid = parentId || null;
    return taskValues(data)
      .filter((t) => (t.parentId || null) === pid)
      .sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
  }

  function hasChildren(data, id) {
    return taskValues(data).some((t) => t.parentId === id);
  }

  function subtreeIds(data, id) {
    const out = [];
    const walk = (cur) => {
      out.push(cur);
      childrenOf(data, cur).forEach((c) => walk(c.id));
    };
    if (data.tasks[id]) walk(id);
    return out;
  }

  function subtreeLeaves(data, id) {
    return subtreeIds(data, id).map((i) => data.tasks[i]).filter((t) => t && !hasChildren(data, t.id));
  }

  function isAncestor(data, ancestorId, id) {
    let cur = data.tasks[id];
    const seen = new Set();
    while (cur && cur.parentId) {
      if (cur.parentId === ancestorId) return true;
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
      cur = data.tasks[cur.parentId];
    }
    return false;
  }

  function depthOf(data, id) {
    let n = 0;
    let cur = data.tasks[id];
    const seen = new Set();
    while (cur && cur.parentId && data.tasks[cur.parentId] && !seen.has(cur.id)) {
      seen.add(cur.id);
      n += 1;
      cur = data.tasks[cur.parentId];
    }
    return n;
  }

  function visibleTasks(data) {
    const out = [];
    const walk = (parentId) => {
      childrenOf(data, parentId).forEach((t) => {
        out.push(t);
        if (!t.collapsed) walk(t.id);
      });
    };
    walk(null);
    return out;
  }

  function reindexGroups(data) {
    const parents = new Set([null]);
    taskValues(data).forEach((t) => parents.add(t.parentId || null));
    parents.forEach((pid) => {
      childrenOf(data, pid).forEach((t, i) => {
        t.order = i;
      });
    });
  }

  function breakParentCycles(data) {
    taskValues(data).forEach((t) => {
      const seen = new Set([t.id]);
      let cur = t;
      while (cur && cur.parentId) {
        if (!data.tasks[cur.parentId] || seen.has(cur.parentId)) {
          cur.parentId = null;
          break;
        }
        seen.add(cur.parentId);
        cur = data.tasks[cur.parentId];
      }
    });
  }

  function depReaches(data, fromId, targetId) {
    const stack = [fromId];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = data.tasks[id];
      if (!t) continue;
      (t.deps || []).forEach((d) => stack.push(d));
    }
    return false;
  }

  function rollup(data) {
    const tasks = taskValues(data);
    tasks.forEach((t) => {
      if (hasChildren(data, t.id)) t.milestone = false;
      else if (t.milestone) t.end = t.start;
    });
    const pending = new Set(tasks.filter((t) => hasChildren(data, t.id)).map((t) => t.id));
    let guard = 0;
    while (pending.size && guard < 80) {
      guard += 1;
      let progressed = false;
      Array.from(pending).forEach((id) => {
        const kids = childrenOf(data, id);
        if (kids.some((k) => pending.has(k.id))) return;
        let minS = null;
        let maxE = null;
        let weight = 0;
        let prog = 0;
        subtreeLeaves(data, id).forEach((leaf) => {
          if (!minS || leaf.start < minS) minS = leaf.start;
          if (!maxE || leaf.end > maxE) maxE = leaf.end;
          const w = durationDays(leaf);
          weight += w;
          prog += w * (Number(leaf.progress) || 0);
        });
        const t = data.tasks[id];
        if (minS) t.start = minS;
        if (maxE) t.end = maxE;
        t.progress = weight ? Math.round(prog / weight) : 0;
        pending.delete(id);
        progressed = true;
      });
      if (!progressed) break;
    }
  }

  function settle(data) {
    rollup(data);
    let guard = 0;
    let changed = true;
    while (changed && guard < 40) {
      guard += 1;
      changed = false;
      taskValues(data).forEach((t) => {
        let minStart = null;
        (t.deps || []).forEach((pid) => {
          const p = data.tasks[pid];
          if (!p) return;
          const next = addDays(p.end, 1);
          if (!minStart || next > minStart) minStart = next;
        });
        if (minStart && t.start < minStart) {
          const delta = diffDays(t.start, minStart);
          if (!delta) return;
          subtreeLeaves(data, t.id).forEach((leaf) => {
            leaf.start = addDays(leaf.start, delta);
            leaf.end = addDays(leaf.end, delta);
          });
          changed = true;
        }
      });
      if (changed) rollup(data);
    }
  }

  function normalizeView(raw) {
    const view = defaultView();
    if (!raw || typeof raw !== 'object') return view;
    if (ZOOMS.includes(raw.zoom)) view.zoom = raw.zoom;
    if (MODES.includes(raw.mode)) view.mode = raw.mode;
    view.showWeekends = raw.showWeekends !== false;
    view.filters = normalizeFilters(raw.filters);
    return view;
  }

  function normalize(raw) {
    const data = createEmpty();
    if (!raw || typeof raw !== 'object') return data;
    data.title = str(raw.title, 120) || 'Gantt';
    data.view = normalizeView(raw.view);
    data.labels = normalizeLabels(raw.labels);
    data.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
    data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : data.createdAt;
    const src = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
    Object.keys(src).forEach((key) => {
      const t = src[key];
      if (!t || typeof t !== 'object') return;
      const id = str(t.id || key, 80);
      if (!id || data.tasks[id]) return;
      const task = defaultTask(t.title, null, null);
      task.id = id;
      const start = isDateIso(t.start) && parseDay(t.start) != null ? t.start : todayIso();
      let end = isDateIso(t.end) && parseDay(t.end) != null ? t.end : addDays(start, 4);
      if (end < start) end = start;
      task.title = str(t.title, TITLE_MAX);
      task.start = start;
      task.end = end;
      task.milestone = !!t.milestone;
      task.progress = clamp(Math.round(Number(t.progress) || 0), 0, 100);
      task.parentId = typeof t.parentId === 'string' ? t.parentId : null;
      task.collapsed = !!t.collapsed;
      task.order = Number.isFinite(Number(t.order)) ? Number(t.order) : 0;
      task.color = isHex(t.color) ? t.color : null;
      task.assignee = str(t.assignee, 80);
      task.priority = normPriority(t.priority);
      task.notes = str(t.notes, NOTES_MAX);
      task.deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string').slice(0, 40) : [];
      task.labelIds = normalizeLabelIds(t.labelIds, data.labels);
      task.createdAt = typeof t.createdAt === 'string' ? t.createdAt : data.createdAt;
      task.updatedAt = typeof t.updatedAt === 'string' ? t.updatedAt : task.createdAt;
      if (task.milestone) task.end = task.start;
      data.tasks[id] = task;
    });
    breakParentCycles(data);
    taskValues(data).forEach((t) => {
      const kept = [];
      (t.deps || []).forEach((depId) => {
        if (!data.tasks[depId] || depId === t.id || kept.indexOf(depId) >= 0) return;
        if (isAncestor(data, t.id, depId) || isAncestor(data, depId, t.id)) return;
        const prev = t.deps;
        t.deps = kept.slice();
        if (depReaches(data, depId, t.id)) {
          t.deps = prev;
          return;
        }
        t.deps = prev;
        kept.push(depId);
      });
      t.deps = kept;
    });
    reindexGroups(data);
    settle(data);
    return data;
  }

  function addTask(data, props) {
    const o = props || {};
    const parentId = o.parentId && data.tasks[o.parentId] ? o.parentId : null;
    const task = defaultTask(o.title, o.start, o.end);
    task.parentId = parentId;
    if (o.milestone) {
      task.milestone = true;
      task.end = task.start;
    }
    if (isHex(o.color)) task.color = o.color;
    if (o.assignee) task.assignee = str(o.assignee, 80);
    if (o.priority) task.priority = normPriority(o.priority);
    if (o.labelIds) task.labelIds = normalizeLabelIds(o.labelIds, data.labels);
    const sibs = childrenOf(data, parentId);
    if (o.afterId) {
      const after = sibs.find((s) => s.id === o.afterId);
      task.order = after ? after.order + 0.5 : sibs.length;
    } else task.order = sibs.length;
    data.tasks[task.id] = task;
    if (parentId && data.tasks[parentId]) data.tasks[parentId].collapsed = false;
    reindexGroups(data);
    settle(data);
    return task;
  }

  function deleteTask(data, id) {
    if (!data.tasks[id]) return false;
    const ids = new Set(subtreeIds(data, id));
    ids.forEach((i) => {
      delete data.tasks[i];
    });
    taskValues(data).forEach((t) => {
      t.deps = (t.deps || []).filter((d) => !ids.has(d) && data.tasks[d]);
    });
    reindexGroups(data);
    settle(data);
    return true;
  }

  function duplicateTask(data, id) {
    const src = data.tasks[id];
    if (!src) return null;
    const ids = subtreeIds(data, id);
    const map = {};
    ids.forEach((oldId) => {
      map[oldId] = uid('task_');
    });
    const ts = nowIso();
    ids.forEach((oldId) => {
      const t = data.tasks[oldId];
      const copy = JSON.parse(JSON.stringify(t));
      copy.id = map[oldId];
      copy.createdAt = ts;
      copy.updatedAt = ts;
      if (oldId === id) copy.parentId = t.parentId;
      else copy.parentId = map[t.parentId] || t.parentId;
      copy.deps = (t.deps || []).map((d) => map[d]).filter(Boolean);
      if (oldId === id) copy.order = t.order + 0.5;
      data.tasks[copy.id] = copy;
    });
    reindexGroups(data);
    settle(data);
    return data.tasks[map[id]];
  }

  function shiftTask(data, id, days) {
    if (!data.tasks[id] || !days) return false;
    subtreeLeaves(data, id).forEach((leaf) => {
      leaf.start = addDays(leaf.start, days);
      leaf.end = addDays(leaf.end, days);
      touch(leaf);
    });
    settle(data);
    return true;
  }

  function resizeTask(data, id, edge, days) {
    const t = data.tasks[id];
    if (!t || !days || t.milestone || hasChildren(data, id)) return false;
    if (edge === 'start') {
      const next = addDays(t.start, days);
      t.start = next > t.end ? t.end : next;
    } else {
      const next = addDays(t.end, days);
      t.end = next < t.start ? t.start : next;
    }
    touch(t);
    settle(data);
    return true;
  }

  function setRange(data, id, start, end) {
    const t = data.tasks[id];
    if (!t || hasChildren(data, id)) return false;
    let s = isDateIso(start) && parseDay(start) != null ? start : t.start;
    let e = isDateIso(end) && parseDay(end) != null ? end : t.end;
    if (e < s) e = s;
    if (t.milestone) e = s;
    t.start = s;
    t.end = e;
    touch(t);
    settle(data);
    return true;
  }

  function setProgress(data, id, value) {
    const t = data.tasks[id];
    if (!t || hasChildren(data, id)) return false;
    t.progress = clamp(Math.round(Number(value) || 0), 0, 100);
    touch(t);
    rollup(data);
    return true;
  }

  function linkDep(data, taskId, predId) {
    const task = data.tasks[taskId];
    const pred = data.tasks[predId];
    if (!task || !pred || taskId === predId) return false;
    if (isAncestor(data, taskId, predId) || isAncestor(data, predId, taskId)) return false;
    if ((task.deps || []).indexOf(predId) >= 0) return true;
    if (depReaches(data, predId, taskId)) return false;
    task.deps = (task.deps || []).concat(predId);
    touch(task);
    settle(data);
    return true;
  }

  function unlinkDep(data, taskId, predId) {
    const task = data.tasks[taskId];
    if (!task) return false;
    task.deps = (task.deps || []).filter((d) => d !== predId);
    touch(task);
    return true;
  }

  function indentTask(data, id) {
    const t = data.tasks[id];
    if (!t) return false;
    const sibs = childrenOf(data, t.parentId);
    const idx = sibs.findIndex((s) => s.id === id);
    if (idx <= 0) return false;
    const prev = sibs[idx - 1];
    if (isAncestor(data, id, prev.id)) return false;
    t.parentId = prev.id;
    prev.collapsed = false;
    t.order = childrenOf(data, prev.id).length;
    reindexGroups(data);
    settle(data);
    return true;
  }

  function outdentTask(data, id) {
    const t = data.tasks[id];
    if (!t || !t.parentId || !data.tasks[t.parentId]) return false;
    const parent = data.tasks[t.parentId];
    t.parentId = parent.parentId || null;
    t.order = parent.order + 0.5;
    reindexGroups(data);
    settle(data);
    return true;
  }

  function nudgeTask(data, id, dir) {
    const t = data.tasks[id];
    if (!t) return false;
    const sibs = childrenOf(data, t.parentId);
    const i = sibs.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sibs.length) return false;
    const tmp = sibs[i].order;
    sibs[i].order = sibs[j].order;
    sibs[j].order = tmp;
    reindexGroups(data);
    return true;
  }

  function canReparent(data, id, parentId) {
    if (!data.tasks[id]) return false;
    const pid = parentId && data.tasks[parentId] ? parentId : null;
    if (!pid) return true;
    if (pid === id) return false;
    return subtreeIds(data, id).indexOf(pid) < 0;
  }

  function reparentTask(data, id, parentId, beforeId) {
    const t = data.tasks[id];
    if (!t) return false;
    const pid = parentId && data.tasks[parentId] ? parentId : null;
    if (!canReparent(data, id, pid)) return false;
    let before = beforeId && data.tasks[beforeId] ? beforeId : null;
    if (before === id) before = null;
    if (before && (data.tasks[before].parentId || null) !== pid) before = null;
    const sameParent = (t.parentId || null) === pid;
    const current = childrenOf(data, t.parentId);
    const at = current.findIndex((s) => s.id === id);
    if (sameParent) {
      if (before) {
        const dest = current.findIndex((s) => s.id === before);
        if (dest === at + 1) return false;
      } else if (at === current.length - 1) return false;
    }
    t.parentId = pid;
    if (pid) data.tasks[pid].collapsed = false;
    touch(t);
    const sibs = childrenOf(data, pid).filter((s) => s.id !== id);
    if (before) {
      const dest = sibs.find((s) => s.id === before);
      t.order = dest ? dest.order - 0.5 : sibs.length;
    } else {
      t.order = sibs.length ? sibs[sibs.length - 1].order + 1 : 0;
    }
    taskValues(data).forEach((task) => {
      task.deps = (task.deps || []).filter((d) => {
        if (!data.tasks[d] || d === task.id) return false;
        return !isAncestor(data, task.id, d) && !isAncestor(data, d, task.id);
      });
    });
    reindexGroups(data);
    settle(data);
    return true;
  }

  function chartBounds(data) {
    const today = todayIso();
    let start = today;
    let end = addDays(today, 14);
    taskValues(data).forEach((t) => {
      if (isDateIso(t.start) && t.start < start) start = t.start;
      if (isDateIso(t.end) && t.end > end) end = t.end;
    });
    const zoom = (data.view && data.view.zoom) || 'day';
    const pad = zoom === 'month' ? 14 : zoom === 'week' ? 7 : 2;
    start = addDays(start, -pad);
    end = addDays(end, pad);
    if (today < start) start = addDays(today, -1);
    if (today > end) end = addDays(today, 1);
    return { start, end, today };
  }

  function createStarter() {
    const data = createEmpty();
    data.title = 'Product launch';
    const t0 = todayIso();
    const add = (title, startOff, dur, parent, opts) => {
      const start = addDays(t0, startOff);
      const end = addDays(start, Math.max(0, dur - 1));
      const task = defaultTask(title, start, end);
      if (parent) task.parentId = parent.id;
      const extra = opts || {};
      if (extra.color) task.color = extra.color;
      if (extra.milestone) {
        task.milestone = true;
        task.end = task.start;
      }
      if (extra.progress) task.progress = extra.progress;
      if (extra.priority) task.priority = normPriority(extra.priority);
      if (extra.assignee) task.assignee = str(extra.assignee, 80);
      if (extra.deps) task.deps = extra.deps;
      data.tasks[task.id] = task;
      return task;
    };
    const discovery = add('Discovery', 0, 1, null, { color: COLORS[0] });
    const research = add('Research', 0, 4, discovery, { progress: 40, priority: 'medium', assignee: 'Alex' });
    const brief = add('Write brief', 4, 3, discovery, { deps: [research.id] });
    const build = add('Build', 0, 1, null, { color: COLORS[1] });
    const design = add('Design', 7, 4, build, { deps: [brief.id], progress: 10, priority: 'high', assignee: 'Sam' });
    design.notes = 'Lock the brand colours and type before implementation starts.';
    const impl = add('Implement', 11, 6, build, { deps: [design.id] });
    const review = add('Review', 17, 2, build, { deps: [impl.id] });
    add('Launch', 19, 1, null, { milestone: true, color: COLORS[3], deps: [review.id] });
    const brand = addLabel(data, { name: 'Brand', color: '#a855f7' });
    const risk = addLabel(data, { name: 'Risk', color: '#f04438' });
    if (brand) design.labelIds = [brand.id];
    if (risk) research.labelIds = [risk.id];
    return normalize(data);
  }

  function buildTemplate(name) {
    if (name === 'blank') {
      const data = createEmpty();
      data.title = 'Gantt';
      addTask(data, { title: 'New task', start: todayIso(), end: addDays(todayIso(), 4) });
      return data;
    }
    return createStarter();
  }

  const TEMPLATE_LIST = [
    { id: 'project', label: 'Product launch', hint: 'Phases, dependencies, and a milestone' },
    { id: 'blank', label: 'Blank', hint: 'One task, starting today' },
  ];

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 120);
    norm.updatedAt = nowIso();
    const json = JSON.stringify(norm).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Gantt').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="gantt">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="gantt-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isGanttHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']gantt["']/.test(html);
  }

  function parseHtml(html) {
    if (!isGanttHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']gantt-data["'][^>]*>([\s\S]*?)<\/script>/i);
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

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CSV_HEADERS = ['Title', 'Start', 'End', 'Progress', 'Milestone', 'Parent', 'Predecessors', 'Assignee', 'Priority', 'Labels', 'Color', 'Notes'];

  function toCsv(data) {
    const rows = [CSV_HEADERS.join(',')];
    const nameOf = (id) => (data.tasks[id] ? data.tasks[id].title : '');
    visibleTasks(data).forEach((task) => {
      const parent = task.parentId ? nameOf(task.parentId) : '';
      const preds = (task.deps || []).map(nameOf).filter(Boolean).join('; ');
      rows.push([
        task.title,
        task.start,
        task.end,
        task.progress || 0,
        task.milestone ? 'yes' : '',
        parent,
        preds,
        task.assignee || '',
        task.priority || '',
        taskLabels(data, task).map((l) => l.name).join('; '),
        task.color || '',
        task.notes || '',
      ].map(csvCell).join(','));
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
            i += 1;
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

  function fromCsv(text, data) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0 };
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const at = (name) => header.indexOf(name);
    const idx = {
      title: at('title'),
      start: at('start'),
      end: at('end'),
      progress: at('progress'),
      milestone: at('milestone'),
      parent: at('parent'),
      preds: at('predecessors'),
      assignee: at('assignee'),
      priority: at('priority'),
      labels: at('labels'),
      color: at('color'),
      notes: at('notes'),
    };
    const body = idx.title >= 0 ? rows.slice(1) : rows;
    if (idx.title < 0) idx.title = 0;
    const byTitle = {};
    taskValues(data).forEach((t) => {
      byTitle[t.title.toLowerCase()] = t;
    });
    const pending = [];
    let added = 0;
    body.forEach((r) => {
      const title = String(r[idx.title] || '').trim();
      if (!title) return;
      const start = idx.start >= 0 ? String(r[idx.start] || '').trim() : todayIso();
      const end = idx.end >= 0 ? String(r[idx.end] || '').trim() : addDays(isDateIso(start) ? start : todayIso(), 4);
      const parentName = idx.parent >= 0 ? String(r[idx.parent] || '').trim() : '';
      const parent = parentName ? byTitle[parentName.toLowerCase()] : null;
      const task = addTask(data, {
        title,
        start: isDateIso(start) ? start : todayIso(),
        end: isDateIso(end) ? end : undefined,
        parentId: parent ? parent.id : null,
        milestone: idx.milestone >= 0 && /^(y|yes|true|1)$/i.test(String(r[idx.milestone] || '').trim()),
        assignee: idx.assignee >= 0 ? String(r[idx.assignee] || '').trim() : '',
        priority: idx.priority >= 0 ? String(r[idx.priority] || '').trim() : '',
      });
      if (idx.notes >= 0) task.notes = str(r[idx.notes], NOTES_MAX);
      if (idx.progress >= 0) task.progress = clamp(Math.round(Number(r[idx.progress]) || 0), 0, 100);
      if (idx.color >= 0 && isHex(String(r[idx.color] || '').trim())) task.color = String(r[idx.color]).trim();
      if (idx.labels >= 0) {
        String(r[idx.labels] || '').split(/[;|,]/).map((x) => x.trim()).filter(Boolean).forEach((name) => {
          const lab = addLabel(data, { name });
          if (lab) toggleTaskLabel(data, task.id, lab.id);
        });
      }
      byTitle[title.toLowerCase()] = task;
      const preds = idx.preds >= 0 ? String(r[idx.preds] || '') : '';
      pending.push({ task, preds });
      added += 1;
    });
    pending.forEach((item) => {
      item.preds.split(/[;|]/).map((x) => x.trim()).filter(Boolean).forEach((name) => {
        const pred = byTitle[name.toLowerCase()];
        if (pred) linkDep(data, item.task.id, pred.id);
      });
    });
    settle(data);
    return { added };
  }

  return {
    ZOOMS,
    MODES,
    PRIORITIES,
    COLORS,
    PX,
    CSV_HEADERS,
    TEMPLATE_LIST,
    uid,
    clamp,
    nowIso,
    todayIso,
    isDateIso,
    isHex,
    parseDay,
    formatDay,
    addDays,
    diffDays,
    durationDays,
    pxPerDay,
    defaultView,
    defaultFilters,
    defaultTask,
    createEmpty,
    createStarter,
    buildTemplate,
    normalize,
    childrenOf,
    hasChildren,
    subtreeIds,
    depthOf,
    visibleTasks,
    filteredTasks,
    matchingTasks,
    analyze,
    hasActiveFilter,
    taskMatches,
    taskKind,
    labelsList,
    taskLabels,
    taskLabelIds,
    addLabel,
    setLabelColor,
    renameLabel,
    deleteLabel,
    toggleTaskLabel,
    setTaskColor,
    addTask,
    deleteTask,
    duplicateTask,
    shiftTask,
    resizeTask,
    setRange,
    setProgress,
    linkDep,
    unlinkDep,
    indentTask,
    outdentTask,
    nudgeTask,
    canReparent,
    reparentTask,
    chartBounds,
    settle,
    serializeToHtml,
    isGanttHtml,
    parseHtml,
    cloneData,
    toCsv,
    parseCsv,
    fromCsv,
  };
});
