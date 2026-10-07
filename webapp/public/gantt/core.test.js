const assert = require('assert');
const path = require('path');
const GanttCore = require(path.join(__dirname, 'core.js'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('roundtrip empty', () => {
  const html = GanttCore.serializeToHtml(GanttCore.createEmpty(), 'Demo');
  assert.ok(GanttCore.isGanttHtml(html));
  assert.ok(html.includes('id="gantt-data"'));
  assert.ok(html.includes('data-docviewer="gantt"'));
  const parsed = GanttCore.parseHtml(html);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.title, 'Demo');
  assert.deepEqual(parsed.tasks, {});
});

test('title is written into the model', () => {
  const data = GanttCore.createStarter();
  const html = GanttCore.serializeToHtml(data, 'Roadmap');
  assert.ok(html.includes('<title>Roadmap</title>'));
  assert.equal(GanttCore.parseHtml(html).title, 'Roadmap');
});

test('angle brackets in a title cannot break the script', () => {
  const data = GanttCore.createStarter();
  const id = GanttCore.visibleTasks(data)[0].id;
  data.tasks[id].title = 'Close </script> & <b>';
  const html = GanttCore.serializeToHtml(data);
  assert.ok(!html.includes('</script> &'));
  assert.equal(GanttCore.parseHtml(html).tasks[id].title, 'Close </script> & <b>');
});

test('starter has a hierarchy, a dependency, and a milestone', () => {
  const data = GanttCore.createStarter();
  const tasks = GanttCore.visibleTasks(data);
  assert.ok(tasks.length >= 6);
  const launch = tasks.find((t) => t.milestone);
  assert.ok(launch);
  assert.equal(launch.start, launch.end);
  const brief = Object.values(data.tasks).find((t) => t.title === 'Write brief');
  const research = Object.values(data.tasks).find((t) => t.title === 'Research');
  assert.ok(brief.deps.indexOf(research.id) >= 0);
  assert.ok(brief.start > research.end);
});

test('normalize parks bad dates and drops cycles', () => {
  const data = GanttCore.normalize({
    title: 'X',
    tasks: {
      a: { id: 'a', title: 'A', start: 'nope', end: '2026-01-01', parentId: 'b' },
      b: { id: 'b', title: 'B', start: '2026-02-01', end: '2026-01-01', parentId: 'a', deps: ['a', 'a', 'missing'] },
    },
  });
  const aParent = data.tasks.a.parentId;
  const bParent = data.tasks.b.parentId;
  assert.ok(!(aParent === 'b' && bParent === 'a'), 'parent cycle must be broken');
  assert.deepEqual(data.tasks.b.deps, []);
  assert.ok(data.tasks.b.end >= data.tasks.b.start);
  assert.ok(GanttCore.isDateIso(data.tasks.a.start));
});

test('parent dates roll up from children', () => {
  const data = GanttCore.createEmpty();
  const parent = GanttCore.addTask(data, { title: 'Phase', start: '2026-01-01', end: '2026-01-02' });
  GanttCore.addTask(data, { title: 'A', start: '2026-01-03', end: '2026-01-05', parentId: parent.id });
  GanttCore.addTask(data, { title: 'B', start: '2026-01-06', end: '2026-01-08', parentId: parent.id });
  assert.equal(data.tasks[parent.id].start, '2026-01-03');
  assert.equal(data.tasks[parent.id].end, '2026-01-08');
  assert.equal(data.tasks[parent.id].milestone, false);
});

test('shifting a predecessor pushes the successor', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-01-01', end: '2026-01-03' });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-01-06', end: '2026-01-08' });
  assert.equal(GanttCore.linkDep(data, b.id, a.id), true);
  GanttCore.shiftTask(data, a.id, 5);
  assert.equal(data.tasks[a.id].start, '2026-01-06');
  assert.equal(data.tasks[a.id].end, '2026-01-08');
  assert.equal(data.tasks[b.id].start, '2026-01-09');
});

test('a dependency cycle is rejected', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-03-01', end: '2026-03-02' });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-03-04', end: '2026-03-05' });
  assert.equal(GanttCore.linkDep(data, b.id, a.id), true);
  assert.equal(GanttCore.linkDep(data, a.id, b.id), false);
  assert.ok(data.tasks[a.id].deps.indexOf(b.id) < 0);
});

test('resize clamps inside the task and cascades', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-04-01', end: '2026-04-03' });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-04-06', end: '2026-04-07' });
  GanttCore.linkDep(data, b.id, a.id);
  GanttCore.resizeTask(data, a.id, 'end', 4);
  assert.equal(data.tasks[a.id].end, '2026-04-07');
  assert.ok(data.tasks[b.id].start > data.tasks[a.id].end);
  GanttCore.resizeTask(data, a.id, 'start', 20);
  assert.equal(data.tasks[a.id].start, data.tasks[a.id].end);
});

test('indent and outdent', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-05-01', end: '2026-05-02' });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-05-03', end: '2026-05-04' });
  assert.equal(GanttCore.indentTask(data, b.id), true);
  assert.equal(data.tasks[b.id].parentId, a.id);
  assert.equal(data.tasks[a.id].end >= '2026-05-04', true);
  assert.equal(GanttCore.outdentTask(data, b.id), true);
  assert.equal(data.tasks[b.id].parentId, null);
  const order = GanttCore.visibleTasks(data).map((t) => t.title);
  assert.deepEqual(order, ['A', 'B']);
});

test('delete removes the subtree and dangling dependencies', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-06-01', end: '2026-06-02' });
  const child = GanttCore.addTask(data, { title: 'Child', start: '2026-06-01', end: '2026-06-01', parentId: a.id });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-06-04', end: '2026-06-05' });
  GanttCore.linkDep(data, b.id, child.id);
  GanttCore.deleteTask(data, a.id);
  assert.equal(data.tasks[a.id], undefined);
  assert.equal(data.tasks[child.id], undefined);
  assert.deepEqual(data.tasks[b.id].deps, []);
});

test('collapsed parent hides its children', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-07-01', end: '2026-07-02' });
  GanttCore.addTask(data, { title: 'Child', start: '2026-07-01', end: '2026-07-01', parentId: a.id });
  data.tasks[a.id].collapsed = true;
  const titles = GanttCore.visibleTasks(data).map((t) => t.title);
  assert.deepEqual(titles, ['A']);
});

test('csv roundtrip keeps quotes and a dependency', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'Say "hi"', start: '2026-08-01', end: '2026-08-02' });
  a.notes = 'line\n2';
  const b = GanttCore.addTask(data, { title: 'Next', start: '2026-08-04', end: '2026-08-05' });
  GanttCore.linkDep(data, b.id, a.id);
  const fresh = GanttCore.createEmpty();
  const result = GanttCore.fromCsv(GanttCore.toCsv(data), fresh);
  assert.equal(result.added, 2);
  const titles = Object.values(fresh.tasks).map((t) => t.title).sort();
  assert.deepEqual(titles, ['Next', 'Say "hi"']);
  const next = Object.values(fresh.tasks).find((t) => t.title === 'Next');
  const hi = Object.values(fresh.tasks).find((t) => t.title === 'Say "hi"');
  assert.ok(next.deps.indexOf(hi.id) >= 0);
  assert.equal(hi.notes, 'line\n2');
});

test('parseHtml falls back on garbage', () => {
  assert.equal(GanttCore.parseHtml('<html></html>'), null);
  const empty = GanttCore.parseHtml('<html data-docviewer="gantt"></html>');
  assert.deepEqual(empty.tasks, {});
  const broken = GanttCore.parseHtml('<html data-docviewer="gantt"><script type="application/json" id="gantt-data">{oops</script></html>');
  assert.deepEqual(broken.tasks, {});
});

test('chart bounds include today and the tasks', () => {
  const data = GanttCore.createEmpty();
  GanttCore.addTask(data, { title: 'Far', start: '2030-01-01', end: '2030-01-10' });
  const bounds = GanttCore.chartBounds(data);
  assert.ok(bounds.start <= GanttCore.todayIso());
  assert.ok(bounds.end >= '2030-01-10');
  assert.equal(GanttCore.pxPerDay('week'), 14);
});

test('reparent nests, reorders, and rejects cycles', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-09-01', end: '2026-09-02' });
  const b = GanttCore.addTask(data, { title: 'B', start: '2026-09-03', end: '2026-09-04' });
  const c = GanttCore.addTask(data, { title: 'C', start: '2026-09-05', end: '2026-09-06' });
  const mile = GanttCore.addTask(data, { title: 'Gate', start: '2026-09-07', end: '2026-09-07', milestone: true });
  GanttCore.linkDep(data, b.id, a.id);
  assert.equal(GanttCore.reparentTask(data, b.id, a.id, null), true);
  assert.equal(data.tasks[b.id].parentId, a.id);
  assert.deepEqual(data.tasks[b.id].deps, []);
  assert.equal(data.tasks[a.id].milestone, false);
  assert.equal(GanttCore.reparentTask(data, a.id, b.id, null), false);
  assert.equal(data.tasks[a.id].parentId, null);
  assert.equal(GanttCore.reparentTask(data, mile.id, a.id, b.id), true);
  assert.equal(data.tasks[mile.id].parentId, a.id);
  assert.equal(data.tasks[mile.id].milestone, true);
  const kids = GanttCore.childrenOf(data, a.id).map((t) => t.title);
  assert.deepEqual(kids, ['Gate', 'B']);
  assert.equal(GanttCore.reparentTask(data, c.id, null, a.id), true);
  assert.deepEqual(GanttCore.visibleTasks(data).map((t) => t.title), ['C', 'A', 'Gate', 'B']);
});

test('sheet view and priority survive normalize', () => {
  const data = GanttCore.createEmpty();
  data.view.mode = 'sheet';
  const a = GanttCore.addTask(data, { title: 'A', start: '2026-10-01', end: '2026-10-02', priority: 'high', assignee: 'Pat' });
  const parsed = GanttCore.parseHtml(GanttCore.serializeToHtml(data, 'Sheet'));
  assert.equal(parsed.view.mode, 'sheet');
  const task = Object.values(parsed.tasks)[0];
  assert.equal(task.priority, 'high');
  assert.equal(task.assignee, 'Pat');
  assert.equal(a.title, 'A');
});

test('filters match text and keep ancestors', () => {
  const data = GanttCore.createStarter();
  data.view.filters.text = 'brief';
  const titles = GanttCore.filteredTasks(data).map((t) => t.title);
  assert.ok(titles.indexOf('Write brief') >= 0);
  assert.ok(titles.indexOf('Discovery') >= 0);
  data.view.filters = { text: '', priority: 'high', kind: '', progress: '', assignee: '' };
  const high = GanttCore.filteredTasks(data).map((t) => t.title);
  assert.ok(high.indexOf('Design') >= 0);
  assert.ok(high.indexOf('Build') >= 0);
});

test('analytics mode survives normalize', () => {
  const data = GanttCore.createEmpty();
  data.view.mode = 'analytics';
  const parsed = GanttCore.parseHtml(GanttCore.serializeToHtml(data, 'Stats'));
  assert.equal(parsed.view.mode, 'analytics');
});

test('analyze reports progress, kinds, and overdue work', () => {
  const data = GanttCore.createStarter();
  const stats = GanttCore.analyze(data);
  assert.equal(stats.total, 8);
  assert.equal(stats.kinds.summary, 2);
  assert.equal(stats.kinds.milestone, 1);
  assert.equal(stats.kinds.task, 5);
  assert.equal(stats.status.doing, 2);
  assert.equal(stats.priority.high, 1);
  assert.equal(stats.progress, 10);
  assert.ok(stats.assignees.some((a) => a.name === 'Alex' && a.count === 1));
  const late = GanttCore.createEmpty();
  GanttCore.addTask(late, { title: 'Late', start: '2020-01-01', end: '2020-01-05' });
  GanttCore.addTask(late, { title: 'Done old', start: '2020-01-01', end: '2020-01-05' });
  const done = Object.values(late.tasks).find((t) => t.title === 'Done old');
  GanttCore.setProgress(late, done.id, 100);
  const risk = GanttCore.analyze(late);
  assert.equal(risk.health.overdue, 1);
  assert.equal(risk.lists.overdue[0].title, 'Late');
  assert.equal(risk.progress, 50);
});

test('custom labels and colours survive normalize', () => {
  const data = GanttCore.createEmpty();
  const a = GanttCore.addTask(data, { title: 'Paint', start: '2026-10-01', end: '2026-10-03' });
  GanttCore.setTaskColor(data, a.id, '#12b76a');
  const lab = GanttCore.addLabel(data, { name: 'Ops', color: '#f79009' });
  assert.ok(GanttCore.toggleTaskLabel(data, a.id, lab.id));
  const parsed = GanttCore.parseHtml(GanttCore.serializeToHtml(data, 'Tagged'));
  const task = Object.values(parsed.tasks)[0];
  assert.equal(task.color, '#12b76a');
  const tags = GanttCore.taskLabels(parsed, task);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].name, 'Ops');
  assert.equal(tags[0].color, '#f79009');
  parsed.view.filters = GanttCore.defaultFilters();
  parsed.view.filters.label = tags[0].id;
  assert.equal(GanttCore.filteredTasks(parsed).length, 1);
  assert.ok(GanttCore.deleteLabel(parsed, tags[0].id));
  assert.deepEqual(Object.values(parsed.tasks)[0].labelIds, []);
  assert.equal(GanttCore.labelsList(parsed).length, 0);
});

test('blank template is a single task', () => {
  const data = GanttCore.buildTemplate('blank');
  assert.equal(Object.keys(data.tasks).length, 1);
});

let failed = 0;
tests.forEach((t) => {
  try {
    t.fn();
    console.log('ok   ' + t.name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + t.name);
    console.log('     ' + (err && err.stack ? err.stack : err));
  }
});
if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\n' + tests.length + ' gantt core tests passed');
