const assert = require('assert');
const path = require('path');
const WikiCore = require(path.join(__dirname, 'core.js'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('roundtrip empty', () => {
  const html = WikiCore.serializeToHtml(WikiCore.createEmpty(), 'Home');
  assert.ok(WikiCore.isWikiHtml(html));
  assert.ok(html.includes('id="wiki-data"'));
  const parsed = WikiCore.parseHtml(html);
  assert.equal(parsed.title, 'Home');
});

test('angle brackets cannot break the script', () => {
  const data = WikiCore.createEmpty();
  data.body = '</script><img>';
  const html = WikiCore.serializeToHtml(data, 'Safe');
  assert.ok(!html.includes('</script><img>'));
  assert.ok(WikiCore.parseHtml(html).body.indexOf('<') >= 0);
});

test('extract wiki links with labels', () => {
  const links = WikiCore.extractWikiLinks('See [[Alpha]] and [[folder/beta.html|Beta]].');
  assert.equal(links.length, 2);
  assert.equal(links[0].target, 'Alpha');
  assert.equal(links[1].target, 'folder/beta.html');
  assert.equal(links[1].label, 'Beta');
});

test('resolve by path, relative path, and unique title', () => {
  const pages = [
    { path: 'notes/alpha.html', title: 'Alpha' },
    { path: 'notes/beta.html', title: 'Beta' },
    { path: 'other.html', title: 'Other' },
  ];
  assert.equal(WikiCore.resolveLink('notes/alpha.html', pages).path, 'notes/alpha.html');
  assert.equal(WikiCore.resolveLink('beta', pages, 'notes/alpha.html').path, 'notes/beta.html');
  assert.equal(WikiCore.resolveLink('Other', pages).path, 'other.html');
  assert.equal(WikiCore.resolveLink('Missing', pages).missing, true);
});

test('backlinks find pages that mention this one', () => {
  const pages = [
    { path: 'a.html', title: 'A', body: 'Hello [[B]]' },
    { path: 'b.html', title: 'B', body: 'No link here' },
    { path: 'c.html', title: 'C', body: 'Also [[b.html|Bee]]' },
  ];
  const back = WikiCore.incomingLinks('b.html', 'B', pages);
  assert.equal(back.length, 2);
  assert.ok(back.some((p) => p.path === 'a.html'));
  assert.ok(back.some((p) => p.path === 'c.html'));
});

test('render turns wiki links into anchors', () => {
  const pages = [{ path: 'a.html', title: 'A' }];
  const html = WikiCore.renderHtml('Go [[A]] and [[Ghost]].', pages, 'b.html');
  assert.ok(html.indexOf('wk-link') >= 0);
  assert.ok(html.indexOf('is-missing') >= 0);
  assert.ok(html.indexOf('data-path="a.html"') >= 0);
  assert.ok(!html.includes('<script'));
});

test('slug from title', () => {
  assert.equal(WikiCore.slug('Hello World!'), 'hello-world');
  assert.equal(WikiCore.slug('***'), 'page');
});

test('backlinks work from graph link lists', () => {
  const pages = [
    { path: 'a.html', title: 'A', links: [{ target: 'B', label: 'B' }] },
    { path: 'b.html', title: 'B', links: [] },
  ];
  const back = WikiCore.incomingLinks('b.html', 'B', pages);
  assert.equal(back.length, 1);
  assert.equal(back[0].path, 'a.html');
});

test('starter mentions backlinks', () => {
  const data = WikiCore.createStarter('Home');
  assert.equal(data.title, 'Home');
  assert.ok(data.body.indexOf('[[') >= 0);
});

test('resolve other files, frames, slides, and tasks', () => {
  const pages = [
    { path: 'notes.html', title: 'Notes', kind: 'wiki' },
    {
      path: 'idea.html', title: 'idea', kind: 'mindmap',
      frames: [{ id: 'f_ovy23q44', title: 'bharath' }, { id: 'f_shppoh9s', title: 'Frame' }],
    },
    {
      path: 'sample.html', title: 'Review deck', kind: 'slides',
      slides: [{ id: 'slide_a', title: 'Intro', index: 0 }, { id: 'slide_b', title: 'Frame shot', index: 1 }],
    },
    {
      path: 'chart.html', title: 'Product launch', kind: 'gantt',
      tasks: [{ id: 'task_1', title: 'Discovery' }],
    },
    { path: 'data.json', title: 'data.json', kind: 'json' },
  ];
  assert.equal(WikiCore.resolveLink('idea.html', pages).kind, 'mindmap');
  assert.equal(WikiCore.resolveLink('data.json', pages).kind, 'json');
  const frame = WikiCore.resolveLink('idea.html#frame:f_ovy23q44', pages);
  assert.equal(frame.missing, false);
  assert.equal(frame.frameId, 'f_ovy23q44');
  assert.equal(frame.title, 'bharath');
  const bare = WikiCore.resolveLink('idea.html#f_ovy23q44', pages);
  assert.equal(bare.frameId, 'f_ovy23q44');
  const slide = WikiCore.resolveLink('sample.html#slide:2', pages);
  assert.equal(slide.slideId, 'slide_b');
  assert.equal(slide.slideIndex, 1);
  const task = WikiCore.resolveLink('chart.html#task:task_1', pages);
  assert.equal(task.taskId, 'task_1');
  const unique = WikiCore.resolveLink('Discovery', pages);
  assert.equal(unique.taskId, 'task_1');
  assert.equal(WikiCore.resolveLink('idea.html#frame:nope', pages).missing, true);
  assert.equal(WikiCore.looksLikePath('idea.html'), true);
  assert.equal(WikiCore.looksLikePath('New topic'), false);
});

test('render stores frame and slide data attributes', () => {
  const pages = [{
    path: 'idea.html', title: 'idea', kind: 'mindmap',
    frames: [{ id: 'f_ovy23q44', title: 'bharath' }],
  }];
  const html = WikiCore.renderHtml('See [[idea.html#frame:f_ovy23q44|Board]].', pages, 'notes.html');
  assert.ok(html.indexOf('data-frame="f_ovy23q44"') >= 0);
  assert.ok(html.indexOf('data-path="idea.html"') >= 0);
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
console.log('\n' + tests.length + ' wiki core tests passed');
