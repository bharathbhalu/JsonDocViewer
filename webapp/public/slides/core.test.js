const assert = require('assert');
const path = require('path');
const SlidesCore = require(path.join(__dirname, 'core.js'));

(function testRoundtrip() {
  const data = SlidesCore.createStarter();
  const html = SlidesCore.serializeToHtml(data);
  assert.ok(SlidesCore.isSlidesHtml(html));
  const parsed = SlidesCore.parseHtml(html);
  assert.equal(parsed.slides.length, data.slides.length);
  assert.equal(parsed.slides[2].body, 'First point\nSecond point\nThird point');
})();

(function testScriptTextIsEscaped() {
  const data = SlidesCore.createEmpty();
  data.slides[0].title = '</script><b>x</b>';
  const html = SlidesCore.serializeToHtml(data);
  assert.equal(html.indexOf('</script><b>'), -1);
  assert.equal(SlidesCore.parseHtml(html).slides[0].title, '</script><b>x</b>');
})();

(function testNormalizeFillsVisualsAndClampsWindow() {
  const data = SlidesCore.normalize({
    slides: [
      { id: 'a', layout: 'two-visuals', visuals: [{ source: { path: 'x.html', frameId: 'f1' }, window: { x: 0.9, y: -1, w: 0.5, h: 5 } }] },
      { id: 'a', layout: 'nope' },
    ],
  });
  const s = data.slides[0];
  assert.equal(s.visuals.length, 2);
  assert.deepEqual(s.visuals[0].source, { path: 'x.html', frameId: 'f1' });
  assert.deepEqual(s.visuals[0].window, { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.equal(s.visuals[1].source, null);
  assert.notEqual(data.slides[1].id, 'a');
  assert.equal(data.slides[1].layout, 'title-visual');
})();

(function testEmptyDeckGetsASlide() {
  assert.equal(SlidesCore.normalize({ slides: [] }).slides.length, 1);
  assert.equal(SlidesCore.parseHtml('<html data-docviewer="slides"></html>').slides.length, 1);
})();

(function testTheme() {
  assert.equal(SlidesCore.normalize({}).theme, 'light');
  assert.equal(SlidesCore.normalize({ theme: 'dark' }).theme, 'dark');
  assert.equal(SlidesCore.normalize({ theme: 'bogus' }).theme, 'light');
  const html = SlidesCore.serializeToHtml(Object.assign(SlidesCore.createEmpty(), { theme: 'ocean' }));
  assert.equal(SlidesCore.parseHtml(html).theme, 'ocean');
})();

(function testImagesAndBackground() {
  const d = SlidesCore.normalize({ slides: [{
    layout: 'two-visuals',
    visuals: [{ image: { path: 'a/pic.png', fit: 'cover' } }, { image: { url: 'javascript:alert(1)' } }],
    background: { url: 'https://example.com/bg.jpg', dim: 5 },
  }] });
  const s = d.slides[0];
  assert.deepEqual(s.visuals[0].image, { path: 'a/pic.png', fit: 'cover' });
  assert.equal(s.visuals[1].image, null);
  assert.deepEqual(s.background, { url: 'https://example.com/bg.jpg', fit: 'cover', dim: 0.9 });
  assert.equal(SlidesCore.normalize({ slides: [{ background: { path: '' } }] }).slides[0].background, null);
})();

console.log('slides core tests ok');
