const assert = require('assert');
const path = require('path');
const SlidesCore = require(path.join(__dirname, 'core.js'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('roundtrip empty', () => {
  const html = SlidesCore.serializeToHtml(SlidesCore.createEmpty(), 'Demo');
  assert.ok(SlidesCore.isSlidesHtml(html));
  assert.ok(html.includes('id="slides-data"'));
  const parsed = SlidesCore.parseHtml(html);
  assert.equal(parsed.title, 'Demo');
  assert.equal(parsed.slides.length, 1);
  assert.equal(parsed.slides[0].kind, 'title');
});

test('title is written into the model', () => {
  const html = SlidesCore.serializeToHtml(SlidesCore.createStarter(), 'Review');
  assert.equal(SlidesCore.parseHtml(html).title, 'Review');
});

test('angle brackets cannot break the script', () => {
  const data = SlidesCore.createEmpty();
  data.slides[0].title = '</script><img>';
  const html = SlidesCore.serializeToHtml(data, 'Safe');
  assert.ok(!html.includes('</script><img>'));
  assert.ok(SlidesCore.parseHtml(html).slides[0].title.indexOf('<') >= 0);
});

test('starter is title cards that explain frames', () => {
  const data = SlidesCore.createStarter();
  assert.ok(data.slides.length >= 3);
  assert.ok(data.slides.every((s) => s.kind === 'title'));
  assert.ok(data.slides.some((s) => s.layout === 'bullets'));
});

test('addFrameSlide stores a mindmap frame and a gantt board', () => {
  const data = SlidesCore.createEmpty();
  const frame = SlidesCore.addFrameSlide(data, 0, {
    path: 'maps/plan.html',
    board: 'mindmap',
    frameId: 'f_1',
    title: 'North star',
  });
  assert.equal(frame.kind, 'frame');
  assert.equal(frame.frameId, 'f_1');
  const gantt = SlidesCore.addFrameSlide(data, 1, { path: 'plan.html', board: 'gantt', frameId: 'ignored' });
  assert.equal(gantt.kind, 'board');
  assert.equal(gantt.frameId, '');
  assert.equal(SlidesCore.addFrameSlide(data, 0, { path: '', board: 'mindmap' }), null);
  const parsed = SlidesCore.parseHtml(SlidesCore.serializeToHtml(data, 'Deck'));
  assert.equal(parsed.slides[1].path, 'maps/plan.html');
  assert.equal(parsed.slides[1].board, 'mindmap');
  assert.equal(parsed.slides[2].kind, 'board');
});

test('a frame slide without a path becomes a title card', () => {
  const parsed = SlidesCore.normalize({
    slides: [{ kind: 'frame', board: 'flow', title: 'Lost' }],
  });
  assert.equal(parsed.slides[0].kind, 'title');
});

test('add, duplicate, and delete slides', () => {
  const data = SlidesCore.createEmpty();
  const added = SlidesCore.addSlide(data, 0, 'bullets');
  assert.equal(added.kind, 'title');
  assert.equal(data.slides.length, 2);
  SlidesCore.duplicateSlide(data, 1);
  assert.equal(data.slides.length, 3);
  assert.equal(SlidesCore.deleteSlide(data, 0), true);
  assert.equal(SlidesCore.deleteSlide(data, 0), true);
  assert.equal(SlidesCore.deleteSlide(data, 0), false);
});

test('moveSlide keeps the current slide selected', () => {
  const data = SlidesCore.createEmpty();
  data.slides[0].title = 'A';
  SlidesCore.addSlide(data, 0).title = 'B';
  SlidesCore.addSlide(data, 1).title = 'C';
  SlidesCore.setIndex(data, 2);
  assert.equal(SlidesCore.moveSlide(data, 2, 0), true);
  assert.deepEqual(data.slides.map((s) => s.title), ['C', 'A', 'B']);
  assert.equal(SlidesCore.currentSlide(data).title, 'C');
});

test('setLayout only applies to title slides', () => {
  const data = SlidesCore.createEmpty();
  assert.equal(SlidesCore.setLayout(data, 0, 'quote'), true);
  SlidesCore.addFrameSlide(data, 0, { path: 'a.html', board: 'flow', frameId: 'f' });
  assert.equal(SlidesCore.setLayout(data, 1, 'quote'), false);
});

test('parseHtml falls back on garbage', () => {
  assert.equal(SlidesCore.parseHtml('<html data-docviewer="slides"></html>').slides.length, 1);
  assert.equal(SlidesCore.parseHtml('<html></html>'), null);
});

test('custom layouts persist split and image', () => {
  const data = SlidesCore.createEmpty();
  const split = SlidesCore.addSlide(data, 0, 'split');
  split.body = 'Left';
  split.right = 'Right';
  const img = SlidesCore.addSlide(data, 1, 'image');
  img.image = 'https://example.com/a.png';
  img.title = 'Caption';
  const blank = SlidesCore.addSlide(data, 2, 'blank');
  blank.body = 'Notes only';
  const parsed = SlidesCore.parseHtml(SlidesCore.serializeToHtml(data, 'Deck'));
  assert.equal(parsed.slides[1].layout, 'split');
  assert.equal(parsed.slides[1].right, 'Right');
  assert.equal(parsed.slides[2].layout, 'image');
  assert.equal(parsed.slides[2].image, 'https://example.com/a.png');
  assert.equal(parsed.slides[3].layout, 'blank');
  assert.equal(parsed.slides[3].body, 'Notes only');
});

test('unsafe image src is stripped', () => {
  const parsed = SlidesCore.normalize({
    slides: [{ kind: 'title', layout: 'image', image: 'javascript:void(0)' }],
  });
  assert.equal(parsed.slides[0].image, '');
  assert.ok(SlidesCore.safeImageSrc('https://cdn.example/p.png').indexOf('https://') === 0);
});

test('setLayout accepts split and rejects it on frames', () => {
  const data = SlidesCore.createEmpty();
  assert.equal(SlidesCore.setLayout(data, 0, 'split'), true);
  SlidesCore.addFrameSlide(data, 0, { path: 'a.html', board: 'flow', frameId: 'f' });
  assert.equal(SlidesCore.setLayout(data, 1, 'image'), false);
});

test('crop and camera roundtrip on a frame slide', () => {
  const data = SlidesCore.createEmpty();
  const frame = SlidesCore.addFrameSlide(data, 0, { path: 'a.html', board: 'mindmap', frameId: 'f' });
  assert.equal(SlidesCore.isFullCrop(frame.crop), true);
  assert.equal(SlidesCore.setCrop(data, 1, { x: 0.2, y: 0.1, w: 0.4, h: 0.9 }), true);
  assert.equal(data.slides[1].crop.w, 0.4);
  assert.equal(data.slides[1].crop.h, 0.9);
  assert.equal(SlidesCore.setCam(data, 1, { x: 12, y: -8, zoom: 1.4 }), true);
  assert.equal(SlidesCore.setCrop(data, 0, { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }), false);
  const parsed = SlidesCore.parseHtml(SlidesCore.serializeToHtml(data, 'Deck'));
  assert.ok(parsed.slides[1].crop.w < 1);
  assert.equal(parsed.slides[1].cam.zoom, 1.4);
  const bad = SlidesCore.normalizeCrop({ x: -2, y: 3, w: 0.01, h: 0.01 });
  assert.ok(bad.w >= 0.12);
  assert.ok(bad.x >= 0 && bad.x + bad.w <= 1.0001);
});

test('showGrid persists on frame slides', () => {
  const data = SlidesCore.createEmpty();
  SlidesCore.addFrameSlide(data, 0, { path: 'a.html', board: 'mindmap', frameId: 'f' });
  assert.equal(data.slides[1].showGrid, false);
  assert.equal(SlidesCore.setShowGrid(data, 1, true), true);
  assert.equal(SlidesCore.showsPresentGrid(data.slides[1]), true);
  assert.equal(SlidesCore.setShowGrid(data, 0, true), false);
  const parsed = SlidesCore.parseHtml(SlidesCore.serializeToHtml(data, 'Deck'));
  assert.equal(parsed.slides[1].showGrid, true);
  assert.equal(parsed.slides[0].showGrid, false);
});

test('side handles change only that edge', () => {
  const src = { x: 0.2, y: 0.2, w: 0.4, h: 0.5 };
  const east = SlidesCore.resizeCrop(src, 'e', { x: 0.8, y: 0.4 });
  assert.equal(east.x, 0.2);
  assert.ok(Math.abs(east.w - 0.6) < 0.001);
  assert.ok(Math.abs(east.h - 0.5) < 0.001);
  const north = SlidesCore.resizeCrop(src, 'n', { x: 0.4, y: 0.05 });
  assert.ok(Math.abs(north.y - 0.05) < 0.001);
  assert.ok(Math.abs(north.h - 0.65) < 0.001);
  assert.ok(Math.abs(north.w - 0.4) < 0.001);
});

test('compare layout keeps a third column', () => {
  const data = SlidesCore.createEmpty();
  const slide = SlidesCore.addSlide(data, 0, 'compare');
  slide.body = 'A';
  slide.right = 'B';
  slide.aside = 'C';
  const parsed = SlidesCore.parseHtml(SlidesCore.serializeToHtml(data, 'Deck'));
  assert.equal(parsed.slides[1].layout, 'compare');
  assert.equal(parsed.slides[1].aside, 'C');
  assert.deepEqual(SlidesCore.numberLines('1. One\n2. Two'), ['One', 'Two']);
});

test('cam keeps canvas size with the viewport', () => {
  const cam = SlidesCore.normalizeCam({ x: 10, y: 20, zoom: 1.5, cw: 800.4, ch: 450.6 });
  assert.equal(cam.x, 10);
  assert.equal(cam.cw, 800);
  assert.equal(cam.ch, 451);
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
console.log('\n' + tests.length + ' slides core tests passed');
