const assert = require('assert');
const path = require('path');
const KanbanCore = require(path.join(__dirname, 'core.js'));

function testSerializeRoundtrip() {
  const empty = KanbanCore.createEmpty();
  const html = KanbanCore.serializeToHtml(empty, 'Demo');
  assert.ok(KanbanCore.isKanbanHtml(html));
  assert.ok(html.includes('data-docviewer="kanban"'));
  assert.ok(html.includes('id="kanban-data"'));
  const parsed = KanbanCore.parseHtml(html);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.columns, []);
  assert.deepEqual(Object.keys(parsed.cards), []);
}

function testStarterRoundtrip() {
  const starter = KanbanCore.createStarter();
  const html = KanbanCore.serializeToHtml(starter);
  const parsed = KanbanCore.parseHtml(html);
  assert.equal(parsed.columns.length, 3);
  assert.equal(Object.keys(parsed.cards).length, 2);
  assert.equal(parsed.labels.length, 3);
  const titles = parsed.columns.map((c) => c.title);
  assert.deepEqual(titles, ['To do', 'In progress', 'Done']);
}

function testSerializeAppliesTitleToModel() {
  const data = KanbanCore.createStarter();
  const html = KanbanCore.serializeToHtml(data, 'Sprint 14');
  assert.ok(html.includes('<title>Sprint 14</title>'));
  assert.equal(KanbanCore.parseHtml(html).title, 'Sprint 14', 'document title and model must agree');
  // Without an explicit title the model keeps its own.
  data.title = 'Roadmap';
  assert.equal(KanbanCore.parseHtml(KanbanCore.serializeToHtml(data)).title, 'Roadmap');
}

function testSerializeEscapesAngleBrackets() {
  const data = KanbanCore.createStarter();
  const firstId = Object.keys(data.cards)[0];
  data.cards[firstId].title = 'Close </script> tag & <b>markup</b>';
  const html = KanbanCore.serializeToHtml(data);
  assert.ok(!/<\/script>\s*tag/.test(html), 'raw closing tag must not survive serialization');
  const parsed = KanbanCore.parseHtml(html);
  assert.equal(parsed.cards[firstId].title, 'Close </script> tag & <b>markup</b>');
}

function testNormalizeRejectsGarbage() {
  assert.deepEqual(KanbanCore.normalize(null).columns, []);
  assert.deepEqual(KanbanCore.normalize('nope').columns, []);
  const data = KanbanCore.normalize({ columns: [{}, null, 7], cards: { a: null, b: 'x' } });
  assert.equal(data.columns.length, 1);
  assert.deepEqual(Object.keys(data.cards), []);
}

function testOrphanCardsParkInFirstColumn() {
  const data = KanbanCore.normalize({
    columns: [{ id: 'col_a', title: 'A' }, { id: 'col_b', title: 'B' }],
    cards: {
      c1: { id: 'c1', columnId: 'col_a', title: 'Keeps column' },
      c2: { id: 'c2', columnId: 'col_gone', title: 'Rescued' },
    },
  });
  assert.equal(data.cards.c1.columnId, 'col_a');
  assert.equal(data.cards.c2.columnId, 'col_a', 'orphan is parked, not dropped');
}

function testOrphanCardsDroppedWithoutColumns() {
  const data = KanbanCore.normalize({
    columns: [],
    cards: { c1: { id: 'c1', columnId: 'col_gone', title: 'Nowhere to go' } },
  });
  assert.deepEqual(Object.keys(data.cards), []);
}

function testNormalizeDropsDeadReferences() {
  const data = KanbanCore.normalize({
    columns: [{ id: 'col_a', title: 'A' }],
    labels: [{ id: 'lab_live', name: 'Live', color: 'blue' }],
    members: [{ id: 'mem_live', name: 'Ada' }],
    cards: {
      c1: {
        id: 'c1',
        columnId: 'col_a',
        title: 'Card',
        labels: ['lab_live', 'lab_gone'],
        assignee: 'mem_gone',
        priority: 'nonsense',
        due: '12-31-2026',
      },
    },
  });
  assert.deepEqual(data.cards.c1.labels, ['lab_live']);
  assert.equal(data.cards.c1.assignee, null);
  assert.equal(data.cards.c1.priority, null);
  assert.equal(data.cards.c1.due, null, 'non-ISO dates are rejected');
}

function board() {
  const data = KanbanCore.createEmpty();
  const a = KanbanCore.defaultColumn('A');
  const b = KanbanCore.defaultColumn('B');
  a.id = 'col_a';
  b.id = 'col_b';
  data.columns = [a, b];
  ['c1', 'c2', 'c3'].forEach((id, i) => {
    const card = KanbanCore.defaultCard('col_a', id.toUpperCase());
    card.id = id;
    card.order = i;
    data.cards[id] = card;
  });
  return data;
}

function testReindexCompactsOrder() {
  const data = board();
  data.cards.c1.order = 50;
  data.cards.c2.order = 12;
  data.cards.c3.order = 99;
  KanbanCore.reindex(data, 'col_a');
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c2', 'c1', 'c3']);
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.order), [0, 1, 2]);
}

function testMoveCardWithinColumn() {
  const data = board();
  KanbanCore.moveCard(data, 'c3', 'col_a', 'c1');
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c3', 'c1', 'c2']);
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.order), [0, 1, 2]);
}

function testMoveCardAppendsWhenNoSibling() {
  const data = board();
  KanbanCore.moveCard(data, 'c1', 'col_a', null);
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c2', 'c3', 'c1']);
}

function testMoveCardAcrossColumnsReindexesSource() {
  const data = board();
  KanbanCore.moveCard(data, 'c2', 'col_b', null);
  assert.equal(data.cards.c2.columnId, 'col_b');
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c1', 'c3']);
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.order), [0, 1]);
  assert.deepEqual(KanbanCore.cardList(data, 'col_b').map((c) => c.order), [0]);
}

function testMoveCardRejectsUnknownTargets() {
  const data = board();
  assert.equal(KanbanCore.moveCard(data, 'c1', 'col_nope', null), false);
  assert.equal(KanbanCore.moveCard(data, 'nope', 'col_b', null), false);
}

function testMoveCardToOwnPositionIsStable() {
  const data = board();
  KanbanCore.moveCard(data, 'c2', 'col_a', 'c2');
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c1', 'c2', 'c3']);
}

function testMoveColumn() {
  const data = board();
  KanbanCore.moveColumn(data, 'col_b', 'col_a');
  assert.deepEqual(data.columns.map((c) => c.id), ['col_b', 'col_a']);
  KanbanCore.moveColumn(data, 'col_b', null);
  assert.deepEqual(data.columns.map((c) => c.id), ['col_a', 'col_b']);
}

function testNudgeAndShift() {
  const data = board();
  assert.equal(KanbanCore.nudgeCard(data, 'c1', -1), false, 'first card cannot move up');
  KanbanCore.nudgeCard(data, 'c1', 1);
  assert.deepEqual(KanbanCore.cardList(data, 'col_a').map((c) => c.id), ['c2', 'c1', 'c3']);
  KanbanCore.shiftCardColumn(data, 'c1', 1);
  assert.equal(data.cards.c1.columnId, 'col_b');
  assert.equal(KanbanCore.shiftCardColumn(data, 'c1', 1), false, 'last column has no neighbour');
}

function testDueState() {
  const today = '2026-10-02';
  const card = (due) => ({ due });
  assert.equal(KanbanCore.dueState(card('2026-10-01'), today), 'overdue');
  assert.equal(KanbanCore.dueState(card('2026-10-02'), today), 'today');
  assert.equal(KanbanCore.dueState(card('2026-10-07'), today), 'soon');
  assert.equal(KanbanCore.dueState(card('2026-11-20'), today), 'later');
  assert.equal(KanbanCore.dueState(card(null), today), '');
}

function testFilters() {
  const today = '2026-10-02';
  const data = board();
  data.labels = [KanbanCore.defaultLabel('Bug', 'red')];
  const labelId = data.labels[0].id;
  data.cards.c1.labels = [labelId];
  data.cards.c1.notes = 'needle in the notes';
  data.cards.c2.priority = 'high';
  data.cards.c3.due = '2026-09-01';

  assert.ok(KanbanCore.cardMatchesFilter(data.cards.c1, { text: 'NEEDLE' }));
  assert.ok(!KanbanCore.cardMatchesFilter(data.cards.c2, { text: 'needle' }));
  assert.ok(KanbanCore.cardMatchesFilter(data.cards.c1, { labels: [labelId] }));
  assert.ok(!KanbanCore.cardMatchesFilter(data.cards.c2, { labels: [labelId] }));
  assert.ok(KanbanCore.cardMatchesFilter(data.cards.c2, { priority: 'high' }));
  assert.ok(KanbanCore.cardMatchesFilter(data.cards.c3, { due: 'overdue' }, today));
  assert.ok(!KanbanCore.cardMatchesFilter(data.cards.c1, { due: 'overdue' }, today));
  assert.ok(KanbanCore.cardMatchesFilter(data.cards.c1, { due: 'none' }, today));
  assert.ok(!KanbanCore.hasActiveFilter({ text: '  ', labels: [] }));
  assert.ok(KanbanCore.hasActiveFilter({ text: 'x' }));
}

function testColumnCardsRespectsArchiveAndFilter() {
  const data = board();
  data.cards.c2.archived = true;
  assert.deepEqual(KanbanCore.columnCards(data, 'col_a').map((c) => c.id), ['c1', 'c3']);
  assert.deepEqual(
    KanbanCore.columnCards(data, 'col_a', { showArchived: true }).map((c) => c.id),
    ['c1', 'c2', 'c3']
  );
  data.cards.c3.title = 'Findable';
  assert.deepEqual(
    KanbanCore.columnCards(data, 'col_a', { filters: { text: 'findable' } }).map((c) => c.id),
    ['c3']
  );
}

function testColumnSortModes() {
  const data = board();
  data.cards.c1.priority = 'low';
  data.cards.c2.priority = 'urgent';
  data.cards.c3.due = '2026-01-01';
  data.cards.c1.due = '2026-06-01';
  assert.deepEqual(KanbanCore.columnCards(data, 'col_a', { sort: 'priority' }).map((c) => c.id), ['c2', 'c1', 'c3']);
  assert.deepEqual(KanbanCore.columnCards(data, 'col_a', { sort: 'due' }).map((c) => c.id), ['c3', 'c1', 'c2']);
  assert.deepEqual(KanbanCore.columnCards(data, 'col_a', { sort: 'manual' }).map((c) => c.id), ['c1', 'c2', 'c3']);
}

function testStats() {
  const today = '2026-10-02';
  const data = board();
  data.columns[0].wip = 2;
  data.cards.c1.due = '2026-09-01';
  data.cards.c2.archived = true;
  data.cards.c3.checklist = [
    { id: 'k1', text: 'a', done: true },
    { id: 'k2', text: 'b', done: false },
  ];
  const stats = KanbanCore.boardStats(data, today);
  assert.equal(stats.total, 2);
  assert.equal(stats.archived, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.checklist.done, 1);
  assert.equal(stats.checklist.total, 2);
  assert.equal(stats.perColumn.col_a.count, 2);
  assert.equal(stats.perColumn.col_a.overLimit, false);
  data.columns[0].wip = 1;
  assert.equal(KanbanCore.boardStats(data, today).perColumn.col_a.overLimit, true);
}

function testChecklistProgress() {
  assert.deepEqual(KanbanCore.checklistProgress({ checklist: [] }), { done: 0, total: 0, ratio: 0 });
  const p = KanbanCore.checklistProgress({ checklist: [{ done: true }, { done: false }] });
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
  assert.equal(p.ratio, 0.5);
}

function testCsvRoundtrip() {
  const data = KanbanCore.createStarter();
  const firstId = Object.keys(data.cards)[0];
  data.cards[firstId].title = 'Quote " and, comma';
  data.cards[firstId].notes = 'line one\nline two';
  const csv = KanbanCore.toCsv(data);
  assert.ok(csv.startsWith('Title,Column,'));
  const fresh = KanbanCore.normalize({ columns: [{ id: 'col_x', title: 'To do' }] });
  const result = KanbanCore.fromCsv(csv, fresh);
  assert.equal(result.added, 2);
  const titles = KanbanCore.cardList(fresh, 'col_x').map((c) => c.title);
  assert.ok(titles.includes('Quote " and, comma'), 'quoted cells survive the roundtrip');
}

function testCsvImportCreatesColumnsLabelsMembers() {
  const data = KanbanCore.createEmpty();
  const csv = [
    'Title,Column,Labels,Assignee,Priority,Due',
    'Ship it,Release,Feature; Chore,Ada,high,2026-12-01',
  ].join('\n');
  const result = KanbanCore.fromCsv(csv, data);
  assert.equal(result.added, 1);
  assert.equal(data.columns.length, 1);
  assert.equal(data.columns[0].title, 'Release');
  assert.equal(data.labels.length, 2);
  assert.equal(data.members.length, 1);
  const card = Object.values(data.cards)[0];
  assert.equal(card.priority, 'high');
  assert.equal(card.due, '2026-12-01');
  assert.equal(card.labels.length, 2);
}

function testTemplates() {
  KanbanCore.TEMPLATE_LIST.forEach((t) => {
    const data = KanbanCore.buildTemplate(t.id);
    assert.ok(data.columns.length >= 3, t.id + ' needs columns');
    const html = KanbanCore.serializeToHtml(data);
    assert.ok(KanbanCore.isKanbanHtml(html), t.id + ' must serialize');
  });
  assert.equal(KanbanCore.buildTemplate('sprint').columns.length, 5);
}

function testViewNormalizeClampsUnknowns() {
  const view = KanbanCore.normalizeView({
    density: 'huge',
    groupBy: 'nonsense',
    filters: { priority: 'nope', due: 'nope', labels: 'nope' },
  });
  assert.equal(view.density, 'comfortable');
  assert.equal(view.groupBy, '');
  assert.equal(view.filters.priority, '');
  assert.equal(view.filters.due, '');
  assert.deepEqual(view.filters.labels, []);
}

function testParseHtmlFallbacks() {
  assert.equal(KanbanCore.parseHtml('<html></html>'), null);
  assert.equal(KanbanCore.parseHtml(null), null);
  const noScript = '<html data-docviewer="kanban"></html>';
  assert.deepEqual(KanbanCore.parseHtml(noScript).columns, []);
  const broken = '<html data-docviewer="kanban"><script type="application/json" id="kanban-data">{oops</script></html>';
  assert.deepEqual(KanbanCore.parseHtml(broken).columns, []);
}

const tests = [
  testSerializeRoundtrip,
  testStarterRoundtrip,
  testSerializeAppliesTitleToModel,
  testSerializeEscapesAngleBrackets,
  testNormalizeRejectsGarbage,
  testOrphanCardsParkInFirstColumn,
  testOrphanCardsDroppedWithoutColumns,
  testNormalizeDropsDeadReferences,
  testReindexCompactsOrder,
  testMoveCardWithinColumn,
  testMoveCardAppendsWhenNoSibling,
  testMoveCardAcrossColumnsReindexesSource,
  testMoveCardRejectsUnknownTargets,
  testMoveCardToOwnPositionIsStable,
  testMoveColumn,
  testNudgeAndShift,
  testDueState,
  testFilters,
  testColumnCardsRespectsArchiveAndFilter,
  testColumnSortModes,
  testStats,
  testChecklistProgress,
  testCsvRoundtrip,
  testCsvImportCreatesColumnsLabelsMembers,
  testTemplates,
  testViewNormalizeClampsUnknowns,
  testParseHtmlFallbacks,
];

let failed = 0;
tests.forEach((fn) => {
  try {
    fn();
    console.log('ok  ' + fn.name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + fn.name + ': ' + err.message);
  }
});
if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('\n' + tests.length + ' kanban core tests passed');
