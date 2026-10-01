const assert = require('assert');
const path = require('path');
const FlowCore = require(path.join(__dirname, 'core.js'));

function testSerializeRoundtrip() {
  const empty = FlowCore.createEmpty();
  const html = FlowCore.serializeToHtml(empty, 'Demo');
  assert.ok(FlowCore.isFlowHtml(html));
  assert.ok(html.includes('data-docviewer="flow"'));
  const parsed = FlowCore.parseHtml(html);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.shapes), []);
  assert.deepEqual(Object.keys(parsed.connectors), []);
}

function testShapeAndRoute() {
  const a = FlowCore.defaultShape('process', 0, 0);
  const b = FlowCore.defaultShape('process', 280, 0);
  a.id = 's_a';
  b.id = 's_b';
  const pts = FlowCore.routePoints(a, 'e', b, 'w');
  assert.equal(pts.length, 2, 'aligned cells should be a straight connector');
  const start = FlowCore.portPoint(a, 'e');
  const end = FlowCore.portPoint(b, 'w');
  assert.equal(pts[0].x, start.x);
  assert.equal(pts[pts.length - 1].x, end.x);
  assert.ok(Math.abs(pts[0].y - pts[1].y) < 1);
}

function testElbowWhenOffset() {
  const a = FlowCore.defaultShape('process', 0, 0);
  const b = FlowCore.defaultShape('process', 280, 120);
  const pts = FlowCore.routePoints(a, 'e', b, 'w');
  assert.ok(pts.length > 2, 'offset cells keep an elbow');
}

function testNormalizeDropsBrokenConnectors() {
  const data = FlowCore.normalize({
    shapes: {
      s_a: { id: 's_a', type: 'process', x: 0, y: 0, w: 100, h: 40, text: 'A' },
    },
    connectors: {
      c_bad: { from: { shapeId: 's_a', port: 'e' }, to: { shapeId: 'missing', port: 'w' } },
    },
  });
  assert.ok(data.shapes.s_a);
  assert.equal(Object.keys(data.connectors).length, 0);
}

function testNearestPort() {
  const s = { x: 0, y: 0, w: 100, h: 80 };
  assert.equal(FlowCore.nearestPort(s, { x: 120, y: 40 }), 'e');
  assert.equal(FlowCore.nearestPort(s, { x: -10, y: 40 }), 'w');
  assert.equal(FlowCore.nearestPort(s, { x: 50, y: -8 }), 'n');
  assert.equal(FlowCore.nearestPort(s, { x: 50, y: 90 }), 's');
}

function testAllShapePaths() {
  FlowCore.SHAPE_TYPES.forEach((type) => {
    const d = FlowCore.shapePath(type, 100, 60);
    assert.ok(d && d[0] === 'M', type);
  });
}

function testHitShape() {
  const data = FlowCore.normalize({
    shapes: {
      a: { id: 'a', type: 'process', x: 10, y: 10, w: 50, h: 40 },
      b: { id: 'b', type: 'process', x: 80, y: 10, w: 50, h: 40 },
    },
  });
  assert.equal(FlowCore.hitShape(data, { x: 20, y: 20 }).id, 'a');
  assert.equal(FlowCore.hitShape(data, { x: 90, y: 20 }).id, 'b');
  assert.equal(FlowCore.hitShape(data, { x: 0, y: 0 }), null);
}

testSerializeRoundtrip();
testShapeAndRoute();
testElbowWhenOffset();
testNormalizeDropsBrokenConnectors();
testNearestPort();
testAllShapePaths();
testHitShape();
function testStarterRoundtrip() {
  const html = FlowCore.serializeToHtml(FlowCore.createStarter(), 'Flow');
  const parsed = FlowCore.parseHtml(html);
  assert.equal(Object.keys(parsed.shapes).length, 3);
  assert.equal(Object.keys(parsed.connectors).length, 2);
  assert.ok(Array.isArray(parsed.frames));
  assert.ok(parsed.shapes.s_start);
  assert.ok(parsed.connectors.c_1);
}

function testFormatNormalize() {
  const data = FlowCore.normalize({
    shapes: {
      a: { id: 'a', type: 'process', x: 0, y: 0, w: 100, h: 40, text: 'A', format: { bold: true, fontFamily: 'mono', fontSize: 18 } },
    },
  });
  assert.equal(data.shapes.a.format.bold, true);
  assert.equal(data.shapes.a.format.italic, false);
  assert.equal(data.shapes.a.format.fontFamily, 'mono');
  assert.equal(data.shapes.a.format.fontSize, 18);
  assert.equal(data.shapes.a.format.align, 'center');
  const html = FlowCore.serializeToHtml(data, 'Fmt');
  const parsed = FlowCore.parseHtml(html);
  assert.equal(parsed.shapes.a.format.bold, true);
  assert.equal(parsed.shapes.a.format.fontFamily, 'mono');
  assert.equal(FlowCore.fontCss('mono').indexOf('monospace') !== -1, true);
}

function testAlphaNormalize() {
  const data = FlowCore.normalize({
    shapes: {
      a: { id: 'a', type: 'process', x: 0, y: 0, w: 80, h: 40, style: { fill: '#ff0000', fillAlpha: 0.4, opacity: 2 } },
    },
  });
  assert.equal(data.shapes.a.style.fillAlpha, 0.4);
  assert.equal(data.shapes.a.style.opacity, 1);
  assert.ok(FlowCore.hexAlpha('#ff0000', 0.4).indexOf('0.4') !== -1);
  const none = FlowCore.normalize({
    shapes: { b: { id: 'b', type: 'process', x: 0, y: 0, w: 80, h: 40, style: { borderless: true } } },
  });
  assert.equal(none.shapes.b.style.borderless, true);
  assert.equal(FlowCore.borderStrokeWidth(none.shapes.b.style), 0);
  const dots = FlowCore.normalize({
    shapes: { c: { id: 'c', type: 'process', x: 0, y: 0, w: 80, h: 40, style: { borderDash: 'dotted' } } },
  });
  assert.equal(dots.shapes.c.style.borderDash, 'dotted');
  assert.equal(FlowCore.dashArray('dotted'), '2 6');
  assert.equal(FlowCore.dashArray('dashdot'), '12 6 2 6');
  assert.equal(FlowCore.normDash('nope'), 'solid');
}

function testNotesAndSticky() {
  const s = FlowCore.defaultShape('sticky', 10, 10);
  assert.equal(s.type, 'sticky');
  assert.equal(s.collapsed, false);
  assert.equal(s.note, '');
  const ow = s.w;
  const oh = s.h;
  FlowCore.collapseSticky(s);
  assert.equal(s.collapsed, true);
  assert.equal(s.w, FlowCore.applyCollapsedStickySize({ type: 'sticky', collapsed: true, text: s.text, format: s.format, miniW: 0 }).w);
  assert.equal(s.h, FlowCore.STICKY_MINI_H);
  assert.ok(s.w < ow);
  assert.equal(FlowCore.firstLine('Hello there\nSecond'), 'Hello there');
  FlowCore.expandSticky(s);
  assert.equal(s.collapsed, false);
  assert.equal(s.w, ow);
  assert.equal(s.h, oh);
  const long = FlowCore.defaultShape('sticky', 0, 0);
  long.text = 'A very long sticky title that should not grow without a cap';
  FlowCore.collapseSticky(long);
  assert.ok(long.w <= FlowCore.stickyMiniWidthBounds(long).max);
  const sized = FlowCore.defaultShape('sticky', 0, 0);
  sized.miniW = 200;
  FlowCore.collapseSticky(sized);
  assert.equal(sized.w, 200);
  const data = FlowCore.normalize({
    shapes: {
      n: { id: 'n', type: 'process', x: 0, y: 0, w: 80, h: 40, note: 'hello', noteOpen: true },
      st: { id: 'st', type: 'sticky', x: 8, y: 8, w: 120, h: 90, collapsed: true, expandW: 160, expandH: 140, text: 'Keep', miniW: 200 },
    },
  });
  assert.equal(data.shapes.n.note, 'hello');
  assert.equal(data.shapes.n.noteOpen, true);
  assert.equal(data.shapes.st.type, 'sticky');
  assert.equal(data.shapes.st.collapsed, true);
  assert.equal(data.shapes.st.w, 200);
  assert.equal(data.shapes.st.h, FlowCore.STICKY_MINI_H);
  assert.ok(FlowCore.shapePath('sticky', 80, 80).indexOf('L') !== -1);
  const big = FlowCore.defaultShape('sticky', 0, 0);
  big.format.fontSize = 48;
  FlowCore.collapseSticky(big);
  assert.equal(big.h, FlowCore.stickyMiniHeight(big));
  assert.ok(big.h > FlowCore.STICKY_MINI_H);
  assert.ok(FlowCore.FONT_SIZES.indexOf(70) !== -1);
  assert.equal(FlowCore.clampFontSize(200), 70);
}

testStarterRoundtrip();
testFormatNormalize();
testAlphaNormalize();
testNotesAndSticky();

function testRoutesAndArrows() {
  const a = FlowCore.defaultShape('process', 0, 0);
  const b = FlowCore.defaultShape('process', 280, 120);
  const straight = FlowCore.routePoints(a, 'e', b, 'w', 'straight');
  assert.equal(straight.length, 2);
  const curved = FlowCore.routePoints(a, 'e', b, 'w', 'curved');
  assert.equal(curved.length, 4);
  const tight = FlowCore.routePoints(a, 'e', b, 'w', 'curved', 0);
  const loose = FlowCore.routePoints(a, 'e', b, 'w', 'curved', 100);
  assert.ok(Math.hypot(loose[1].x - tight[1].x, loose[1].y - tight[1].y) > 1);
  assert.equal(FlowCore.clampBend(200), 100);
  const d = FlowCore.pointsToPath(curved, 'curved');
  assert.ok(d.indexOf(' C ') !== -1);
  const geo = FlowCore.connectorPath(a, 'e', b, 'w', { route: 'curved', arrow: 'both' });
  assert.ok(geo.d.indexOf('C') !== -1);
  assert.ok(geo.mid.x > 0);
  const data = FlowCore.normalize({
    shapes: { a: { id: 'a', type: 'process', x: 0, y: 0, w: 80, h: 40 }, b: { id: 'b', type: 'process', x: 200, y: 0, w: 80, h: 40 } },
    connectors: { c: { from: { shapeId: 'a', port: 'e' }, to: { shapeId: 'b', port: 'w' }, style: { arrow: 'both', route: 'straight' } } },
  });
  assert.equal(data.connectors.c.style.arrow, 'both');
  assert.equal(data.connectors.c.style.route, 'straight');
  assert.equal(data.shapes.a.line.route, 'bent');
}

testRoutesAndArrows();

function testTemplates() {
  assert.ok(FlowCore.TEMPLATE_LIST.length >= 10);
  FlowCore.TEMPLATE_LIST.forEach((t) => {
    const d = FlowCore.buildTemplate(t.id);
    assert.ok(d, t.id);
    assert.equal(d.frames.length, 1, t.id);
    assert.ok(Object.keys(d.shapes).length >= 4, t.id);
    assert.ok(Object.keys(d.connectors).length >= 3, t.id);
    const fid = d.frames[0].id;
    Object.keys(d.shapes).forEach((id) => {
      assert.equal(d.shapes[id].frameId, fid, t.id + ' ' + id);
    });
  });
  const empty = FlowCore.createEmpty();
  const r = FlowCore.applyTemplate(empty, 'api');
  assert.equal(Object.keys(empty.shapes).length, r.ids.length);
  assert.equal(empty.frames.length, 1);
  assert.ok(r.ids.length >= 8);
  const seq = FlowCore.buildTemplate('sequence');
  assert.ok(seq.shapes.h_client);
  assert.ok(FlowCore.ICON_LIST.length >= 20);
  assert.ok(FlowCore.iconSrc('database').indexOf('data:image/svg+xml') === 0);
  const ic = FlowCore.iconShape('cloud', 10, 10);
  assert.equal(ic.type, 'image');
  assert.ok(ic.src);
  assert.equal(ic.iconId, 'cloud');
  assert.equal(FlowCore.isFlowIcon(ic), true);
}

testTemplates();

function testLockedNormalize() {
  const data = FlowCore.normalize({
    shapes: { a: { id: 'a', type: 'process', x: 0, y: 0, w: 80, h: 40, locked: true } },
    frames: [{ id: 'f1', x: 0, y: 0, w: 200, h: 160, locked: true }],
  });
  assert.equal(data.shapes.a.locked, true);
  assert.equal(data.frames[0].locked, true);
  const parsed = FlowCore.parseHtml(FlowCore.serializeToHtml(data, 'Lock'));
  assert.equal(parsed.shapes.a.locked, true);
  assert.equal(parsed.frames[0].locked, true);
  assert.equal(FlowCore.defaultShape('process', 0, 0).locked, false);
  assert.equal(FlowCore.defaultFrame(0, 0).locked, false);
}

testLockedNormalize();

function testFrameCats() {
  const data = FlowCore.normalize({
    frames: [
      { id: 'f1', x: 0, y: 0, w: 200, h: 160, title: 'A', categoryId: 'c1' },
      { id: 'f2', x: 0, y: 0, w: 200, h: 160, title: 'B', categoryId: 'missing' },
    ],
    frameCats: [
      { id: 'c1', name: 'Work', parentId: 'c2' },
      { id: 'c2', name: 'Root', parentId: 'c1' },
      { id: 'c3', name: 'Orphan parent', parentId: 'gone' },
    ],
  });
  assert.equal(data.frameCats.length, 3);
  assert.ok(data.frameCats.every((c) => !c.parentId || data.frameCats.some((p) => p.id === c.parentId)));
  assert.ok(data.frameCats.some((c) => c.id === 'c1' && !c.parentId) || data.frameCats.some((c) => c.id === 'c2' && !c.parentId));
  assert.equal(data.frames.find((f) => f.id === 'f1').categoryId, 'c1');
  assert.equal(data.frames.find((f) => f.id === 'f2').categoryId, null);
  assert.equal(data.frameCats.find((c) => c.id === 'c3').parentId, null);
  const parsed = FlowCore.parseHtml(FlowCore.serializeToHtml(data, 'Cats'));
  assert.equal(parsed.frameCats.length, 3);
  assert.equal(parsed.frames.find((f) => f.id === 'f1').categoryId, 'c1');
}

testFrameCats();

function testTextBox() {
  const s = FlowCore.defaultShape('textbox', 12, 20);
  assert.equal(s.type, 'textbox');
  assert.equal(s.text, 'Text');
  assert.equal(s.format.align, 'left');
  assert.equal(s.format.valign, 'top');
  assert.equal(s.style.borderless, true);
  assert.equal(s.style.fillAlpha, 0);
  assert.ok(s.w >= 120);
  assert.ok(FlowCore.shapePath('textbox', 200, 80).indexOf('M') === 0);
  const data = FlowCore.normalize({
    shapes: { t: { id: 't', type: 'textbox', x: 0, y: 0, w: 180, h: 60, text: 'Hello\nWorld' } },
  });
  assert.equal(data.shapes.t.type, 'textbox');
  assert.equal(data.shapes.t.style.fillAlpha, 0);
  assert.equal(data.shapes.t.format.valign, 'top');
  assert.equal(data.shapes.t.text, 'Hello\nWorld');
  const parsed = FlowCore.parseHtml(FlowCore.serializeToHtml(data, 'Text'));
  assert.equal(parsed.shapes.t.type, 'textbox');
  assert.equal(parsed.shapes.t.format.valign, 'top');
  assert.equal(FlowCore.normValign('bottom'), 'bottom');
  assert.equal(FlowCore.normValign('nope', 'top'), 'top');
}

testTextBox();
console.log('flow core tests ok');
