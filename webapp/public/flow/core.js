/* DocViewer flow core — serialize, shapes, orthogonal connectors. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FlowCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SHAPE_META = {
    process: { label: 'Process', w: 168, h: 72 },
    decision: { label: 'Decision', w: 148, h: 108 },
    terminator: { label: 'Start / End', w: 168, h: 56 },
    data: { label: 'Data', w: 176, h: 72 },
    document: { label: 'Document', w: 160, h: 88 },
    delay: { label: 'Delay', w: 156, h: 72 },
    prep: { label: 'Prepare', w: 176, h: 80 },
    manual: { label: 'Manual', w: 168, h: 76 },
    display: { label: 'Display', w: 176, h: 76 },
    connector: { label: 'On-page', w: 48, h: 48 },
    sticky: { label: 'Sticky note', w: 176, h: 160 },
    textbox: { label: 'Text box', w: 220, h: 88 },
  };
  const SHAPE_TYPES = Object.keys(SHAPE_META);
  const PORTS = ['n', 'e', 's', 'w'];
  const SNAP = 4;
  const STUB = 20;
  const ALIGN = 28;
  const MIN_W = 40;
  const MIN_H = 32;
  const STICKY_MINI = 44;
  const STICKY_MINI_H = 36;
  const STICKY_MINI_H_MAX = 80;
  const STICKY_MINI_W_MIN = 88;
  const STICKY_MINI_W_MAX = 420;
  const STICKY_MINI_CHROME = 48;
  const FONT_SIZE_MIN = 11;
  const FONT_SIZE_MAX = 70;
  const MIN_FRAME_W = 80;
  const MIN_FRAME_H = 60;

  function uid(prefix) {
    return prefix + Math.random().toString(36).slice(2, 10);
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function clamp01(n, fallback) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback == null ? 1 : fallback;
    return clamp(x, 0, 1);
  }

  function snap(n) {
    return Math.round(n / SNAP) * SNAP;
  }

  function defaultFormat() {
    return { bold: false, italic: false, underline: false, fontSize: 14, align: 'center', valign: 'middle', fontFamily: 'sans' };
  }

  function normValign(v, fallback) {
    return (v === 'top' || v === 'middle' || v === 'bottom') ? v : (fallback || 'middle');
  }

  const FONT_FACES = [
    { id: 'sans', label: 'Sans', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
    { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", Times, serif' },
    { id: 'mono', label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
    { id: 'rounded', label: 'Rounded', css: '"Trebuchet MS", "Segoe UI Rounded", sans-serif' },
    { id: 'hand', label: 'Hand', css: '"Segoe Print", "Comic Sans MS", cursive' },
  ];
  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 70];

  function clampFontSize(n) {
    return clamp(Number(n) || 14, FONT_SIZE_MIN, FONT_SIZE_MAX);
  }

  function firstLine(text) {
    return String(text || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  }

  function stickyMiniHeight(s) {
    const fs = clampFontSize(s && s.format && s.format.fontSize);
    return clamp(Math.max(STICKY_MINI_H, Math.round(fs * 1.2 + 16)), STICKY_MINI_H, STICKY_MINI_H_MAX);
  }

  function stickyMiniWidthBounds(s) {
    const fs = clampFontSize(s && s.format && s.format.fontSize);
    const min = Math.max(STICKY_MINI_W_MIN, Math.round(fs * 3.2 + 44));
    const max = Math.max(min, Math.min(STICKY_MINI_W_MAX, Math.round(fs * 14 + 56)));
    return { min, max };
  }

  function estimateStickyTitleWidth(text, fontSize, fontFamily) {
    const fs = clampFontSize(fontSize);
    const line = firstLine(text);
    const face = fontFamily === 'hand' || fontFamily === 'serif' ? 0.68 : fontFamily === 'mono' ? 0.62 : 0.58;
    return Math.ceil(Math.max(1, line.length) * fs * face);
  }

  function stickyMiniWidth(s, measuredTextW) {
    const bounds = stickyMiniWidthBounds(s);
    const fmt = s && s.format || {};
    const auto = clamp(
      (measuredTextW != null ? measuredTextW : estimateStickyTitleWidth(s && s.text, fmt.fontSize, fmt.fontFamily)) + STICKY_MINI_CHROME,
      bounds.min,
      bounds.max
    );
    if (s && Number(s.miniW) > 0) return clamp(Math.round(s.miniW), bounds.min, bounds.max);
    return auto;
  }

  function applyCollapsedStickySize(s, measuredTextW) {
    if (!s || s.type !== 'sticky' || !s.collapsed) return s;
    const bounds = stickyMiniWidthBounds(s);
    s.w = clamp(snap(stickyMiniWidth(s, measuredTextW)), bounds.min, bounds.max);
    s.h = stickyMiniHeight(s);
    return s;
  }

  function fontCss(id) {
    const found = FONT_FACES.find((f) => f.id === id);
    return (found && found.css) || FONT_FACES[0].css;
  }

  function defaultStyle() {
    return {
      fill: '#D7E3FC',
      border: '#5B7EAE',
      textColor: '#1a2130',
      borderWidth: 2,
      fillAlpha: 1,
      borderAlpha: 1,
      textAlpha: 1,
      opacity: 1,
      borderless: false,
      borderDash: 'solid',
    };
  }

  function defaultLineStyle() {
    return {
      color: '#5B7EAE',
      width: 2,
      dash: 'solid',
      arrow: 'end',
      route: 'bent',
      bend: 50,
      alpha: 1,
    };
  }

  const ARROW_MODES = ['none', 'end', 'start', 'both'];
  const ROUTE_MODES = ['straight', 'bent', 'curved'];
  const DASH_MODES = ['solid', 'dashed', 'dotted', 'dashdot', 'longdash'];
  const DASH_LABELS = {
    solid: 'Solid',
    dashed: 'Dashed',
    dotted: 'Dotted',
    dashdot: 'Dash-dot',
    longdash: 'Long dash',
  };

  function normArrow(v) {
    return ARROW_MODES.indexOf(v) >= 0 ? v : 'end';
  }

  function normRoute(v) {
    return ROUTE_MODES.indexOf(v) >= 0 ? v : 'bent';
  }

  function normDash(v) {
    return DASH_MODES.indexOf(v) >= 0 ? v : 'solid';
  }

  function clampBend(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50;
    return clamp(Math.round(n), 0, 100);
  }

  function defaultLine() {
    return { arrow: 'end', route: 'bent', bend: 50 };
  }

  function defaultShape(type, x, y) {
    const t = SHAPE_META[type] ? type : 'process';
    const meta = SHAPE_META[t];
    const shape = {
      id: uid('s_'),
      type: t,
      x: snap(x || 0),
      y: snap(y || 0),
      w: meta.w,
      h: meta.h,
      text: t === 'terminator' ? 'Start' : t === 'decision' ? 'Decision?' : t === 'connector' ? '' : t === 'sticky' ? 'Note' : t === 'textbox' ? 'Text' : meta.label,
      src: '',
      imgAspect: meta.w / meta.h,
      z: 10,
      frameId: null,
      style: defaultStyle(),
      format: defaultFormat(),
      line: defaultLine(),
      note: '',
      noteOpen: false,
      collapsed: false,
      expandW: 0,
      expandH: 0,
      miniW: 0,
      locked: false,
    };
    if (t === 'sticky') {
      shape.style.fill = '#FFE9A8';
      shape.style.border = '#D4B45A';
      shape.format.align = 'left';
      shape.format.fontFamily = 'hand';
    }
    if (t === 'textbox') {
      shape.style.fill = '#ffffff';
      shape.style.fillAlpha = 0;
      shape.style.border = '#c5c9d1';
      shape.style.borderless = true;
      shape.format.align = 'left';
      shape.format.valign = 'top';
      shape.format.fontSize = 16;
    }
    return shape;
  }

  function collapseSticky(s) {
    if (!s || s.type !== 'sticky' || s.collapsed) return s;
    s.expandW = Math.max(MIN_W, s.w || SHAPE_META.sticky.w);
    s.expandH = Math.max(MIN_H, s.h || SHAPE_META.sticky.h);
    s.collapsed = true;
    applyCollapsedStickySize(s);
    return s;
  }

  function expandSticky(s) {
    if (!s || s.type !== 'sticky' || !s.collapsed) return s;
    s.collapsed = false;
    s.w = Math.max(MIN_W, s.expandW || SHAPE_META.sticky.w);
    s.h = Math.max(MIN_H, s.expandH || SHAPE_META.sticky.h);
    return s;
  }

  function defaultFrame(x, y, w, h) {
    return {
      id: uid('f_'),
      x: snap(x || 0),
      y: snap(y || 0),
      w: Math.max(MIN_FRAME_W, w || 240),
      h: Math.max(MIN_FRAME_H, h || 160),
      title: 'Frame',
      z: 0,
      fill: '#ffffff',
      fillAlpha: 1,
      border: '#c5c9d1',
      locked: false,
      categoryId: null,
    };
  }

  function defaultConnector(from, to) {
    return {
      id: uid('c_'),
      from: { shapeId: from.shapeId, port: from.port },
      to: { shapeId: to.shapeId, port: to.port },
      label: '',
      style: defaultLineStyle(),
    };
  }

  function createEmpty() {
    return {
      version: 1,
      viewport: { x: 80, y: 80, zoom: 0.85 },
      shapes: {},
      connectors: {},
      frames: [],
      frameCats: [],
    };
  }

  function createStarter() {
    const start = defaultShape('terminator', 80, 140);
    start.id = 's_start';
    start.text = 'Start';
    const step = defaultShape('process', 320, 132);
    step.id = 's_step';
    step.text = 'Step';
    const end = defaultShape('terminator', 580, 140);
    end.id = 's_end';
    end.text = 'End';
    const c1 = defaultConnector({ shapeId: 's_start', port: 'e' }, { shapeId: 's_step', port: 'w' });
    c1.id = 'c_1';
    const c2 = defaultConnector({ shapeId: 's_step', port: 'e' }, { shapeId: 's_end', port: 'w' });
    c2.id = 'c_2';
    const data = createEmpty();
    data.viewport = { x: 36, y: 48, zoom: 0.9 };
    start.z = 10;
    step.z = 11;
    end.z = 12;
    data.shapes = { [start.id]: start, [step.id]: step, [end.id]: end };
    data.connectors = { [c1.id]: c1, [c2.id]: c2 };
    return data;
  }

  const FILL = {
    blue: { fill: '#D7E3FC', border: '#5B7EAE' },
    green: { fill: '#D8F3DC', border: '#2e7d32' },
    yellow: { fill: '#FFF3C4', border: '#c9a227' },
    pink: { fill: '#FFD6E0', border: '#c62828' },
    purple: { fill: '#E4D5F5', border: '#6a1b9a' },
    cyan: { fill: '#CFF1F5', border: '#00838f' },
    orange: { fill: '#FFE0C2', border: '#e65100' },
    gray: { fill: '#ECEFF3', border: '#546e7a' },
  };

  const TEMPLATE_LIST = [
    { id: 'api', label: 'API call flow' },
    { id: 'workflow', label: 'Workflow diagram' },
    { id: 'dfd', label: 'Data flow diagram' },
    { id: 'swimlane', label: 'Swimlane flowchart' },
    { id: 'decision', label: 'Decision tree' },
    { id: 'system', label: 'System flowchart' },
    { id: 'events', label: 'Event streaming' },
    { id: 'logical', label: 'Logical model' },
    { id: 'mermaid', label: 'Mermaid flowchart' },
    { id: 'sequence', label: 'Sequence diagram' },
  ];

  const ICON_LIST = [
    { id: 'user', label: 'User' },
    { id: 'users', label: 'Users' },
    { id: 'server', label: 'Server' },
    { id: 'database', label: 'Database' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'globe', label: 'API / web' },
    { id: 'lock', label: 'Lock' },
    { id: 'shield', label: 'Security' },
    { id: 'key', label: 'Key' },
    { id: 'mail', label: 'Email' },
    { id: 'message', label: 'Message' },
    { id: 'file', label: 'File' },
    { id: 'folder', label: 'Folder' },
    { id: 'settings', label: 'Settings' },
    { id: 'alert', label: 'Warning' },
    { id: 'check', label: 'Success' },
    { id: 'clock', label: 'Clock' },
    { id: 'phone', label: 'Phone' },
    { id: 'monitor', label: 'Browser' },
    { id: 'smartphone', label: 'Mobile' },
    { id: 'cpu', label: 'Service' },
    { id: 'layers', label: 'Queue' },
    { id: 'zap', label: 'Event' },
    { id: 'radio', label: 'Stream' },
    { id: 'box', label: 'Package' },
    { id: 'truck', label: 'Delivery' },
    { id: 'search', label: 'Search' },
    { id: 'share', label: 'Share' },
    { id: 'git', label: 'Branch' },
    { id: 'terminal', label: 'Terminal' },
  ];

  const ICON_PATHS = {
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 19c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 19c0-2.8 2.7-4.7 6-4.7"/><circle cx="16" cy="8.5" r="2.5"/><path d="M21 19c0-2.4-2-4.2-5-4.6"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1"/><circle cx="7" cy="17" r="1"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    cloud: '<path d="M7 18h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.4-1.6A4 4 0 0 0 7 18z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11.5 12.5 21 3"/><path d="M16 4h4v4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/>',
    message: '<path d="M4 5h16v11H8l-4 4V5z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    folder: '<path d="M3 7h6l2 2h10v10H3z"/><path d="M3 7V5h6l2 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.2 6.2 7.6 7.6M16.4 16.4l1.4 1.4M17.8 6.2 16.4 7.6M7.6 16.4 6.2 17.8"/>',
    alert: '<path d="M12 4 3 20h18z"/><path d="M12 10v5"/><circle cx="12" cy="17.5" r=".8"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 18h4"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    smartphone: '<rect x="8" y="2" width="8" height="20" rx="2"/><path d="M11 18h2"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 1 7 0M6 6a8.5 8.5 0 0 1 12 0M5 19h14"/>',
    box: '<path d="M3 8 12 3l9 5v11l-9 5-9-5z"/><path d="M12 8v11M3 8l9 5 9-5"/>',
    truck: '<path d="M3 8h11v9H3z"/><path d="M14 11h5l3 4v2h-8"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>',
    share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.2 16.5A8 8 0 0 0 16 13"/>',
    terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M13 14h4"/>',
  };
  const ICON_SIZE = 64;

  function iconSrc(id) {
    const inner = ICON_PATHS[id];
    if (!inner) return '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#3d4a5c" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function iconShape(id, x, y) {
    const spec = ICON_LIST.find((i) => i.id === id) || ICON_LIST[0];
    const s = defaultShape('process', x, y);
    s.type = 'image';
    s.w = ICON_SIZE;
    s.h = ICON_SIZE;
    s.text = spec.label;
    s.src = iconSrc(spec.id);
    s.imgAspect = 1;
    s.iconId = spec.id;
    s.style.fill = '#ffffff';
    s.style.border = '#c5c9d1';
    s.style.borderless = true;
    return s;
  }

  function isFlowIcon(s) {
    if (!s || s.type !== 'image') return false;
    if (s.iconId && ICON_PATHS[s.iconId]) return true;
    const src = s.src || '';
    return ICON_LIST.some((i) => iconSrc(i.id) === src);
  }

  function node(id, type, x, y, text, color, extra) {
    const s = defaultShape(type, x, y);
    s.id = id;
    s.text = text;
    if (color && FILL[color]) Object.assign(s.style, FILL[color]);
    if (extra) {
      if (extra.w) s.w = extra.w;
      if (extra.h) s.h = extra.h;
      if (extra.frameId) s.frameId = extra.frameId;
    }
    return s;
  }

  function edge(id, from, fp, to, tp, label, style) {
    const c = defaultConnector({ shapeId: from, port: fp }, { shapeId: to, port: tp });
    c.id = id;
    if (label) c.label = label;
    if (style) Object.assign(c.style, style);
    return c;
  }

  function lane(id, title, x, y, w, h, fill) {
    const f = defaultFrame(x, y, w, h);
    f.id = id;
    f.title = title;
    if (fill) f.fill = fill;
    return f;
  }

  function assemble(nodes, links, frames) {
    const data = createEmpty();
    (nodes || []).forEach((s, i) => {
      s.z = 10 + i;
      data.shapes[s.id] = s;
    });
    (links || []).forEach((c) => { data.connectors[c.id] = c; });
    data.frames = frames || [];
    return normalize(data);
  }

  function wrapInFrame(title, nodes, links) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    (nodes || []).forEach((s) => {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + (s.w || 0));
      y1 = Math.max(y1, s.y + (s.h || 0));
    });
    if (!Number.isFinite(x0)) {
      x0 = 40;
      y0 = 40;
      x1 = 400;
      y1 = 240;
    }
    const padL = 56;
    const padT = 88;
    const padR = 56;
    const padB = 56;
    const f = lane('frame', title, x0 - padL, y0 - padT, (x1 - x0) + padL + padR, (y1 - y0) + padT + padB, '#ffffff');
    (nodes || []).forEach((s) => { s.frameId = 'frame'; });
    return assemble(nodes, links, [f]);
  }

  function templateApi() {
    return wrapInFrame('API call flow', [
      node('client', 'display', 40, 128, 'Client', 'cyan'),
      node('req', 'process', 280, 128, 'HTTP request', 'blue'),
      node('gw', 'process', 520, 128, 'API gateway', 'blue'),
      node('auth', 'decision', 760, 110, 'Auth OK?', 'yellow'),
      node('svc', 'process', 1000, 128, 'Service handler', 'blue'),
      node('db', 'data', 1240, 128, 'Database', 'purple'),
      node('res', 'display', 1480, 128, 'JSON response', 'cyan'),
      node('err', 'process', 1000, 320, '401 / 403', 'pink'),
      node('end', 'terminator', 1720, 136, 'Done', 'green'),
    ], [
      edge('c1', 'client', 'e', 'req', 'w'),
      edge('c2', 'req', 'e', 'gw', 'w'),
      edge('c3', 'gw', 'e', 'auth', 'w'),
      edge('c4', 'auth', 'e', 'svc', 'w', 'Yes'),
      edge('c5', 'svc', 'e', 'db', 'w'),
      edge('c6', 'db', 'e', 'res', 'w'),
      edge('c7', 'res', 'e', 'end', 'w'),
      edge('c8', 'auth', 's', 'err', 'w', 'No'),
      edge('c9', 'err', 'e', 'end', 's', '', { color: '#c62828' }),
    ]);
  }

  function templateWorkflow() {
    return wrapInFrame('Workflow diagram', [
      node('start', 'terminator', 80, 80, 'Start', 'green'),
      node('submit', 'manual', 320, 70, 'Submit request', 'orange'),
      node('review', 'decision', 560, 52, 'Approved?', 'yellow'),
      node('run', 'process', 800, 70, 'Execute work', 'blue'),
      node('done', 'terminator', 1040, 80, 'Complete', 'green'),
      node('reject', 'process', 560, 260, 'Send back', 'pink'),
      node('revise', 'manual', 320, 260, 'Revise', 'orange'),
    ], [
      edge('c1', 'start', 'e', 'submit', 'w'),
      edge('c2', 'submit', 'e', 'review', 'w'),
      edge('c3', 'review', 'e', 'run', 'w', 'Yes'),
      edge('c4', 'run', 'e', 'done', 'w'),
      edge('c5', 'review', 's', 'reject', 'n', 'No'),
      edge('c6', 'reject', 'w', 'revise', 'e'),
      edge('c7', 'revise', 'n', 'submit', 's'),
    ]);
  }

  function templateDfd() {
    return wrapInFrame('Data flow diagram', [
      node('cust', 'display', 40, 160, 'Customer', 'cyan', { w: 160 }),
      node('order', 'process', 320, 80, 'Place order', 'blue'),
      node('pay', 'process', 320, 260, 'Take payment', 'blue'),
      node('orders', 'data', 600, 40, 'Orders', 'purple'),
      node('ledger', 'data', 600, 280, 'Payments', 'purple'),
      node('wh', 'process', 840, 160, 'Fulfill', 'blue'),
      node('stock', 'data', 1080, 80, 'Inventory', 'purple'),
      node('ship', 'process', 1080, 240, 'Ship', 'green'),
    ], [
      edge('c1', 'cust', 'e', 'order', 'w', 'order'),
      edge('c2', 'cust', 'e', 'pay', 'w', 'payment'),
      edge('c3', 'order', 'e', 'orders', 'w', 'write'),
      edge('c4', 'pay', 'e', 'ledger', 'w', 'write'),
      edge('c5', 'order', 'e', 'wh', 'n', 'pick'),
      edge('c6', 'orders', 'e', 'wh', 'n', 'read'),
      edge('c7', 'wh', 'e', 'stock', 'w', 'reserve'),
      edge('c8', 'wh', 'e', 'ship', 'w'),
      edge('c9', 'ship', 's', 'cust', 's', 'parcel', { dash: 'dashed' }),
    ]);
  }

  function templateSwimlane() {
    return wrapInFrame('Swimlane flowchart', [
      node('uh', 'process', 48, 120, 'User', 'gray', { w: 120 }),
      node('u0', 'terminator', 220, 128, 'Start', 'green'),
      node('u1', 'manual', 460, 118, 'Enter details', 'orange'),
      node('u2', 'display', 940, 118, 'See result', 'cyan'),
      node('u3', 'terminator', 1180, 128, 'End', 'green'),
      node('ah', 'process', 48, 360, 'App', 'gray', { w: 120 }),
      node('a1', 'process', 460, 360, 'Validate', 'blue'),
      node('a2', 'decision', 700, 342, 'Valid?', 'yellow'),
      node('a3', 'process', 940, 360, 'Call API', 'blue'),
      node('sh', 'process', 48, 600, 'Server', 'gray', { w: 120 }),
      node('s1', 'process', 940, 600, 'Persist', 'purple'),
      node('s2', 'process', 1180, 600, 'Emit event', 'cyan'),
    ], [
      edge('c1', 'u0', 'e', 'u1', 'w'),
      edge('c2', 'u1', 's', 'a1', 'n'),
      edge('c3', 'a1', 'e', 'a2', 'w'),
      edge('c4', 'a2', 'e', 'a3', 'w', 'Yes'),
      edge('c5', 'a2', 'n', 'u1', 'e', 'No'),
      edge('c6', 'a3', 's', 's1', 'n'),
      edge('c7', 's1', 'e', 's2', 'w'),
      edge('c8', 's2', 'n', 'u2', 's'),
      edge('c9', 'u2', 'e', 'u3', 'w'),
    ]);
  }

  function templateDecision() {
    return wrapInFrame('Decision tree', [
      node('root', 'decision', 420, 40, 'Need review?', 'yellow'),
      node('low', 'terminator', 80, 240, 'Auto approve', 'green'),
      node('amt', 'decision', 700, 220, 'Amount > 10k?', 'yellow'),
      node('mid', 'process', 480, 420, 'Team review', 'blue'),
      node('high', 'process', 920, 420, 'Director review', 'orange'),
      node('ok', 'terminator', 700, 600, 'Approved', 'green'),
      node('highno', 'terminator', 920, 600, 'Declined', 'pink'),
    ], [
      edge('c1', 'root', 'w', 'low', 'n', 'No'),
      edge('c2', 'root', 'e', 'amt', 'n', 'Yes'),
      edge('c3', 'amt', 'w', 'mid', 'n', 'No'),
      edge('c4', 'amt', 'e', 'high', 'n', 'Yes'),
      edge('c5', 'mid', 's', 'ok', 'w'),
      edge('c6', 'high', 's', 'ok', 'e', 'Yes'),
      edge('c7', 'high', 's', 'highno', 'n', 'No'),
    ]);
  }

  function templateSystem() {
    return wrapInFrame('System flowchart', [
      node('in', 'data', 40, 160, 'Input', 'purple'),
      node('val', 'prep', 280, 152, 'Validate', 'orange'),
      node('proc', 'process', 540, 160, 'Process', 'blue'),
      node('ok', 'decision', 780, 142, 'Success?', 'yellow'),
      node('out', 'display', 1040, 80, 'Output', 'cyan'),
      node('store', 'data', 1040, 260, 'Storage', 'purple'),
      node('err', 'process', 780, 360, 'Handle error', 'pink'),
      node('end', 'terminator', 1280, 168, 'End', 'green'),
    ], [
      edge('c1', 'in', 'e', 'val', 'w'),
      edge('c2', 'val', 'e', 'proc', 'w'),
      edge('c3', 'proc', 'e', 'ok', 'w'),
      edge('c4', 'ok', 'n', 'out', 'w', 'Yes'),
      edge('c5', 'ok', 'e', 'store', 'w', 'Yes'),
      edge('c6', 'out', 'e', 'end', 'n'),
      edge('c7', 'store', 'e', 'end', 's'),
      edge('c8', 'ok', 's', 'err', 'n', 'No'),
      edge('c9', 'err', 'w', 'val', 's', 'retry', { dash: 'dashed' }),
    ]);
  }

  function templateEvents() {
    return wrapInFrame('Event streaming', [
      node('prod', 'process', 40, 200, 'Producer', 'blue'),
      node('bus', 'data', 320, 180, 'Event bus / topic', 'purple', { w: 200, h: 88 }),
      node('ca', 'process', 640, 40, 'Consumer A', 'cyan'),
      node('cb', 'process', 640, 200, 'Consumer B', 'cyan'),
      node('cc', 'process', 640, 360, 'Consumer C', 'cyan'),
      node('dlq', 'data', 920, 360, 'Dead letter', 'pink'),
      node('sink', 'data', 920, 120, 'Read model', 'gray'),
    ], [
      edge('c1', 'prod', 'e', 'bus', 'w', 'publish'),
      edge('c2', 'bus', 'e', 'ca', 'w'),
      edge('c3', 'bus', 'e', 'cb', 'w'),
      edge('c4', 'bus', 'e', 'cc', 'w'),
      edge('c5', 'ca', 'e', 'sink', 'w', 'project'),
      edge('c6', 'cb', 'e', 'sink', 'w'),
      edge('c7', 'cc', 'e', 'dlq', 'w', 'fail', { color: '#c62828', dash: 'dashed' }),
    ]);
  }

  function templateLogical() {
    return wrapInFrame('Logical model', [
      node('cust', 'data', 80, 80, 'Customer\nid\nname\nemail', 'cyan', { w: 180, h: 110 }),
      node('ord', 'data', 400, 80, 'Order\nid\ncustomer_id\ntotal', 'blue', { w: 180, h: 110 }),
      node('line', 'data', 720, 80, 'Line item\nid\norder_id\nqty', 'purple', { w: 180, h: 110 }),
      node('prod', 'data', 720, 280, 'Product\nid\nsku\nprice', 'orange', { w: 180, h: 110 }),
      node('pay', 'data', 400, 280, 'Payment\nid\norder_id\nstatus', 'green', { w: 180, h: 110 }),
    ], [
      edge('c1', 'cust', 'e', 'ord', 'w', '1 : N'),
      edge('c2', 'ord', 'e', 'line', 'w', '1 : N'),
      edge('c3', 'prod', 'n', 'line', 's', '1 : N'),
      edge('c4', 'ord', 's', 'pay', 'n', '1 : 1'),
    ]);
  }

  function templateMermaid() {
    return wrapInFrame('Mermaid flowchart', [
      node('a', 'terminator', 400, 40, 'Start', 'green'),
      node('b', 'decision', 400, 160, 'Ready?', 'yellow'),
      node('c', 'process', 160, 340, 'Do work', 'blue'),
      node('d', 'delay', 640, 340, 'Wait', 'orange'),
      node('e', 'process', 160, 500, 'Commit', 'cyan'),
      node('f', 'terminator', 400, 640, 'End', 'green'),
    ], [
      edge('c1', 'a', 's', 'b', 'n'),
      edge('c2', 'b', 'w', 'c', 'n', 'Yes'),
      edge('c3', 'b', 'e', 'd', 'n', 'No'),
      edge('c4', 'c', 's', 'e', 'n'),
      edge('c5', 'e', 's', 'f', 'w'),
      edge('c6', 'd', 'n', 'b', 'e', 'retry', { dash: 'dotted' }),
    ]);
  }

  function templateSequence() {
    const life = { dash: 'dashed', arrow: 'none', color: '#9aa3b2', width: 1.5 };
    const reply = { dash: 'dashed', color: '#5B7EAE' };
    const hw = 160;
    const bw = 48;
    const col = { client: 80, api: 360, auth: 640, db: 920 };
    const cx = (k) => col[k] + (hw - bw) / 2;
    function actor(id, key, text, color) {
      return node(id, 'display', col[key], 40, text, color, { w: hw, h: 56 });
    }
    function blob(id, key, y) {
      return node(id, 'connector', cx(key), y, '', 'gray');
    }
    return wrapInFrame('Sequence diagram', [
      actor('h_client', 'client', 'Client', 'cyan'),
      actor('h_api', 'api', 'API', 'blue'),
      actor('h_auth', 'auth', 'Auth', 'yellow'),
      actor('h_db', 'db', 'DB', 'purple'),
      blob('b1c', 'client', 180),
      blob('b1a', 'api', 180),
      blob('b2a', 'api', 280),
      blob('b2u', 'auth', 280),
      blob('b3u', 'auth', 380),
      blob('b3d', 'db', 380),
      blob('b4d', 'db', 480),
      blob('b4u', 'auth', 480),
      blob('b5u', 'auth', 580),
      blob('b5a', 'api', 580),
      blob('b6a', 'api', 680),
      blob('b6c', 'client', 680),
      blob('t_client', 'client', 800),
      blob('t_api', 'api', 800),
      blob('t_auth', 'auth', 800),
      blob('t_db', 'db', 800),
    ], [
      edge('l1', 'h_client', 's', 'b1c', 'n', '', life),
      edge('l2', 'h_api', 's', 'b1a', 'n', '', life),
      edge('l3', 'h_auth', 's', 'b2u', 'n', '', life),
      edge('l4', 'h_db', 's', 'b3d', 'n', '', life),
      edge('l5', 'b1c', 's', 'b6c', 'n', '', life),
      edge('l6', 'b1a', 's', 'b2a', 'n', '', life),
      edge('l7', 'b2a', 's', 'b5a', 'n', '', life),
      edge('l8', 'b2u', 's', 'b3u', 'n', '', life),
      edge('l9', 'b3u', 's', 'b4u', 'n', '', life),
      edge('l10', 'b3d', 's', 'b4d', 'n', '', life),
      edge('l11', 'b6c', 's', 't_client', 'n', '', life),
      edge('l12', 'b5a', 's', 'b6a', 'n', '', life),
      edge('l13', 'b6a', 's', 't_api', 'n', '', life),
      edge('l14', 'b4u', 's', 'b5u', 'n', '', life),
      edge('l15', 'b5u', 's', 't_auth', 'n', '', life),
      edge('l16', 'b4d', 's', 't_db', 'n', '', life),
      edge('m1', 'b1c', 'e', 'b1a', 'w', 'POST /login'),
      edge('m2', 'b2a', 'e', 'b2u', 'w', 'verify'),
      edge('m3', 'b3u', 'e', 'b3d', 'w', 'SELECT user'),
      edge('m4', 'b4d', 'w', 'b4u', 'e', 'row', reply),
      edge('m5', 'b5u', 'w', 'b5a', 'e', 'token', reply),
      edge('m6', 'b6a', 'w', 'b6c', 'e', '200 OK', reply),
    ]);
  }

  const TEMPLATE_BUILDERS = {
    api: templateApi,
    workflow: templateWorkflow,
    dfd: templateDfd,
    swimlane: templateSwimlane,
    decision: templateDecision,
    system: templateSystem,
    events: templateEvents,
    logical: templateLogical,
    mermaid: templateMermaid,
    sequence: templateSequence,
  };

  function buildTemplate(id) {
    const fn = TEMPLATE_BUILDERS[id];
    return fn ? fn() : null;
  }

  function applyTemplate(data, id) {
    const tpl = buildTemplate(id);
    const created = [];
    const frameIds = [];
    if (!data || !tpl) return { ids: created, frameIds };
    const hasContent = Object.keys(data.shapes || {}).length || (data.frames || []).length;
    const box = contentBounds(tpl);
    const origin = hasContent
      ? { x: snap(contentBounds(data).x + contentBounds(data).w + 96), y: snap(contentBounds(data).y) }
      : { x: 48, y: 80 };
    const dx = origin.x - box.x;
    const dy = origin.y - box.y;
    const z0 = maxZ(data) + 1;
    const sidMap = {};
    const fidMap = {};
    (tpl.frames || []).forEach((f) => {
      const nf = Object.assign({}, f, { id: uid('f_'), x: f.x + dx, y: f.y + dy });
      fidMap[f.id] = nf.id;
      data.frames.push(nf);
      frameIds.push(nf.id);
    });
    Object.keys(tpl.shapes).forEach((sid, i) => {
      const s = JSON.parse(JSON.stringify(tpl.shapes[sid]));
      const nid = uid('s_');
      sidMap[sid] = nid;
      s.id = nid;
      s.x += dx;
      s.y += dy;
      s.z = z0 + i;
      s.frameId = s.frameId && fidMap[s.frameId] ? fidMap[s.frameId] : null;
      data.shapes[nid] = s;
      created.push(nid);
    });
    Object.keys(tpl.connectors).forEach((cid) => {
      const c = JSON.parse(JSON.stringify(tpl.connectors[cid]));
      if (!sidMap[c.from.shapeId] || !sidMap[c.to.shapeId]) return;
      c.id = uid('c_');
      c.from.shapeId = sidMap[c.from.shapeId];
      c.to.shapeId = sidMap[c.to.shapeId];
      data.connectors[c.id] = c;
    });
    return { ids: created, frameIds };
  }

  function normalizeFrameCats(raw) {
    const cats = [];
    const seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach((c) => {
      if (!c || typeof c !== 'object') return;
      const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : uid('fc_');
      if (seen.has(id)) return;
      seen.add(id);
      cats.push({
        id,
        name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 60) : 'Category',
        parentId: typeof c.parentId === 'string' && c.parentId ? c.parentId : null,
        collapsed: !!c.collapsed,
      });
    });
    const ids = new Set(cats.map((c) => c.id));
    cats.forEach((c) => {
      if (c.parentId && !ids.has(c.parentId)) c.parentId = null;
    });
    const byId = new Map(cats.map((c) => [c.id, c]));
    cats.forEach((c) => {
      const walk = new Set();
      let id = c.parentId;
      while (id) {
        if (id === c.id || walk.has(id)) {
          c.parentId = null;
          break;
        }
        walk.add(id);
        const p = byId.get(id);
        if (!p) {
          c.parentId = null;
          break;
        }
        id = p.parentId;
      }
    });
    return cats;
  }

  function normalize(raw) {
    const data = createEmpty();
    if (!raw || typeof raw !== 'object') return data;
    if (raw.viewport && typeof raw.viewport === 'object') {
      data.viewport.x = Number(raw.viewport.x) || 0;
      data.viewport.y = Number(raw.viewport.y) || 0;
      data.viewport.zoom = clamp(Number(raw.viewport.zoom) || 1, 0.08, 2.6);
    }
    const shapes = raw.shapes || {};
    Object.keys(shapes).forEach((id) => {
      const s = shapes[id];
      if (!s || typeof s !== 'object') return;
      const type = s.type === 'image' ? 'image' : (SHAPE_META[s.type] ? s.type : 'process');
      const meta = SHAPE_META[type] || { w: 280, h: 200 };
      const style = Object.assign(defaultStyle(), s.style || {});
      const rawFillAlpha = s.style && s.style.fillAlpha;
      style.fillAlpha = type === 'textbox' && (rawFillAlpha == null || rawFillAlpha === '')
        ? 0
        : clamp01(style.fillAlpha, type === 'textbox' ? 0 : 1);
      style.borderAlpha = clamp01(style.borderAlpha, 1);
      style.textAlpha = clamp01(style.textAlpha, 1);
      style.opacity = clamp01(style.opacity, 1);
      style.borderless = !!style.borderless;
      style.borderDash = normDash(style.borderDash);
      const bw = Number(style.borderWidth);
      style.borderWidth = Number.isFinite(bw) && bw >= 0 ? bw : 2;
      const collapsed = type === 'sticky' && !!s.collapsed;
      const format = Object.assign(defaultFormat(), s.format || {});
      format.fontSize = clampFontSize(format.fontSize);
      format.valign = normValign(format.valign, type === 'textbox' ? 'top' : 'middle');
      if (type === 'textbox' && !(s.format && (s.format.valign === 'top' || s.format.valign === 'middle' || s.format.valign === 'bottom'))) {
        format.valign = 'top';
      }
      const text = typeof s.text === 'string' ? s.text : '';
      const miniW = Number(s.miniW) > 0 ? Number(s.miniW) : 0;
      const collapsedSize = collapsed
        ? applyCollapsedStickySize({ type: 'sticky', collapsed: true, text, format, miniW, w: 0, h: 0 })
        : null;
      data.shapes[id] = {
        id,
        type,
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        w: collapsed ? collapsedSize.w : Math.max(MIN_W, Number(s.w) || meta.w),
        h: collapsed ? collapsedSize.h : Math.max(MIN_H, Number(s.h) || meta.h),
        text,
        src: typeof s.src === 'string' ? s.src : '',
        iconId: typeof s.iconId === 'string' ? s.iconId : '',
        imgAspect: typeof s.imgAspect === 'number' && s.imgAspect > 0.1 ? s.imgAspect : (meta.w / meta.h),
        z: Number(s.z) || 0,
        frameId: s.frameId || null,
        style,
        format,
        line: Object.assign(defaultLine(), {
          arrow: normArrow(s.line && s.line.arrow),
          route: normRoute(s.line && s.line.route),
          bend: clampBend(s.line && s.line.bend),
        }),
        note: typeof s.note === 'string' ? s.note : '',
        noteOpen: !!s.noteOpen,
        collapsed,
        expandW: Number(s.expandW) > 0 ? Number(s.expandW) : 0,
        expandH: Number(s.expandH) > 0 ? Number(s.expandH) : 0,
        miniW,
        locked: !!s.locked,
      };
    });
    const connectors = raw.connectors || {};
    Object.keys(connectors).forEach((id) => {
      const c = connectors[id];
      if (!c || typeof c !== 'object') return;
      const from = c.from || {};
      const to = c.to || {};
      if (!data.shapes[from.shapeId] || !data.shapes[to.shapeId]) return;
      if (from.shapeId === to.shapeId) return;
      const lineStyle = Object.assign(defaultLineStyle(), c.style || {});
      lineStyle.arrow = normArrow(lineStyle.arrow);
      lineStyle.route = normRoute(lineStyle.route);
      lineStyle.bend = clampBend(lineStyle.bend);
      lineStyle.dash = normDash(lineStyle.dash);
      lineStyle.alpha = clamp01(lineStyle.alpha, 1);
      data.connectors[id] = {
        id,
        from: { shapeId: from.shapeId, port: PORTS.includes(from.port) ? from.port : 'e' },
        to: { shapeId: to.shapeId, port: PORTS.includes(to.port) ? to.port : 'w' },
        label: typeof c.label === 'string' ? c.label : '',
        style: lineStyle,
      };
    });
    const frames = Array.isArray(raw.frames) ? raw.frames : [];
    data.frames = frames.filter((f) => f && typeof f === 'object').map((f, i) => ({
      id: f.id || uid('f_'),
      x: Number(f.x) || 0,
      y: Number(f.y) || 0,
      w: Math.max(MIN_FRAME_W, Number(f.w) || 240),
      h: Math.max(MIN_FRAME_H, Number(f.h) || 160),
      title: typeof f.title === 'string' && f.title.trim() ? f.title : 'Frame',
      z: Number(f.z) || i,
      fill: f.fill || '#ffffff',
      fillAlpha: f.fillAlpha == null ? 1 : Number(f.fillAlpha),
      border: f.border || '#c5c9d1',
      locked: !!f.locked,
      categoryId: typeof f.categoryId === 'string' && f.categoryId ? f.categoryId : null,
    }));
    // Frame ids must be unique (the editor finds frames by id). A later
    // duplicate keeps its frame but gets a new id; shapes stay with the first.
    const frameIds = new Set();
    data.frames.forEach((f) => {
      if (frameIds.has(f.id)) f.id = uid('f_');
      frameIds.add(f.id);
    });
    data.frameCats = normalizeFrameCats(raw.frameCats);
    const liveCats = new Set(data.frameCats.map((c) => c.id));
    data.frames.forEach((f) => {
      if (f.categoryId && !liveCats.has(f.categoryId)) f.categoryId = null;
    });
    const liveFrames = new Set(data.frames.map((f) => f.id));
    Object.keys(data.shapes).forEach((id) => {
      const s = data.shapes[id];
      if (s.frameId && !liveFrames.has(s.frameId)) s.frameId = null;
    });
    return data;
  }

  function serializeToHtml(data, title) {
    const json = JSON.stringify(normalize(data)).replace(/</g, '\\u003c');
    const t = String(title || 'Flow').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="flow">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="flow-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }

  function isFlowHtml(html) {
    return typeof html === 'string' && /data-docviewer\s*=\s*["']flow["']/.test(html);
  }

  function parseHtml(html) {
    if (!isFlowHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']flow-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return createEmpty();
    try {
      return normalize(JSON.parse(m[1]));
    } catch (e) {
      return createEmpty();
    }
  }

  function shapePath(type, w, h) {
    const W = Math.max(1, w);
    const H = Math.max(1, h);
    if (type === 'decision') {
      return `M ${W / 2} 0 L ${W} ${H / 2} L ${W / 2} ${H} L 0 ${H / 2} Z`;
    }
    if (type === 'terminator') {
      const r = H / 2;
      return `M ${r} 0 H ${W - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    }
    if (type === 'data') {
      const s = Math.min(22, W * 0.14);
      return `M ${s} 0 L ${W} 0 L ${W - s} ${H} L 0 ${H} Z`;
    }
    if (type === 'document') {
      const wave = Math.max(10, H * 0.14);
      return `M 0 0 H ${W} V ${H - wave} Q ${W * 0.75} ${H + wave * 0.35} ${W / 2} ${H - wave * 0.25} Q ${W * 0.25} ${H - wave * 1.15} 0 ${H - wave} Z`;
    }
    if (type === 'delay') {
      const r = H / 2;
      return `M 0 0 H ${W - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H 0 Z`;
    }
    if (type === 'prep') {
      const x = Math.min(28, W * 0.18);
      return `M ${x} 0 L ${W - x} 0 L ${W} ${H / 2} L ${W - x} ${H} L ${x} ${H} L 0 ${H / 2} Z`;
    }
    if (type === 'manual') {
      const cut = Math.min(18, H * 0.28);
      return `M 0 ${cut} L ${W} 0 V ${H} H 0 Z`;
    }
    if (type === 'display') {
      const r = H / 2;
      const s = Math.min(22, W * 0.14);
      return `M ${s} 0 H ${W - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H ${s} L 0 ${H / 2} Z`;
    }
    if (type === 'connector') {
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2;
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    }
    if (type === 'sticky') {
      const fold = stickyFoldSize(W, H);
      return `M 0 0 H ${W - fold} L ${W} ${fold} V ${H} H 0 Z`;
    }
    if (type === 'textbox') {
      const r = Math.min(8, W / 5, H / 5);
      return `M ${r} 0 H ${W - r} Q ${W} 0 ${W} ${r} V ${H - r} Q ${W} ${H} ${W - r} ${H} H ${r} Q 0 ${H} 0 ${H - r} V ${r} Q 0 0 ${r} 0 Z`;
    }
    const r = Math.min(12, W / 4, H / 4);
    return `M ${r} 0 H ${W - r} Q ${W} 0 ${W} ${r} V ${H - r} Q ${W} ${H} ${W - r} ${H} H ${r} Q 0 ${H} 0 ${H - r} V ${r} Q 0 0 ${r} 0 Z`;
  }

  function stickyFoldSize(w, h) {
    return Math.max(8, Math.min(18, w * 0.2, h * 0.2));
  }

  function stickyFoldPath(w, h) {
    const fold = stickyFoldSize(w, h);
    return `M ${w - fold} 0 L ${w} ${fold} L ${w - fold} ${fold} Z`;
  }

  function portPoint(shape, port) {
    const x = shape.x;
    const y = shape.y;
    const w = shape.w;
    const h = shape.h;
    if (port === 'n') return { x: x + w / 2, y: y };
    if (port === 's') return { x: x + w / 2, y: y + h };
    if (port === 'e') return { x: x + w, y: y + h / 2 };
    return { x: x, y: y + h / 2 };
  }

  function offsetPoint(pt, port, d) {
    if (port === 'n') return { x: pt.x, y: pt.y - d };
    if (port === 's') return { x: pt.x, y: pt.y + d };
    if (port === 'e') return { x: pt.x + d, y: pt.y };
    return { x: pt.x - d, y: pt.y };
  }

  function nearestPort(shape, pt) {
    let best = 'e';
    let bestD = Infinity;
    PORTS.forEach((port) => {
      const p = portPoint(shape, port);
      const dx = p.x - pt.x;
      const dy = p.y - pt.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = port;
      }
    });
    return best;
  }

  function dedupePoints(pts) {
    const out = [];
    pts.forEach((p) => {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.6) out.push(p);
    });
    return out;
  }

  function routePoints(fromShape, fromPort, toShape, toPort, route, bend) {
    const a0 = portPoint(fromShape, fromPort);
    const b0 = portPoint(toShape, toPort);
    const mode = normRoute(route);
    const amount = clampBend(bend);
    const t = amount / 100;
    if (mode === 'straight') return [a0, b0];
    if (mode === 'curved') {
      const dist = Math.max(10, Math.hypot(b0.x - a0.x, b0.y - a0.y) * (0.08 + t * 0.72));
      return [a0, offsetPoint(a0, fromPort, dist), offsetPoint(b0, toPort, dist), b0];
    }
    const opp = { e: 'w', w: 'e', n: 's', s: 'n' };
    const horiz = fromPort === 'e' || fromPort === 'w';
    if (opp[fromPort] === toPort) {
      if (horiz && Math.abs(a0.y - b0.y) <= ALIGN) {
        const y = Math.round((a0.y + b0.y) / 2);
        return [{ x: a0.x, y: y }, { x: b0.x, y: y }];
      }
      if (!horiz && Math.abs(a0.x - b0.x) <= ALIGN) {
        const x = Math.round((a0.x + b0.x) / 2);
        return [{ x: x, y: a0.y }, { x: x, y: b0.y }];
      }
    }
    const stub = Math.round(8 + t * 80);
    const split = 0.22 + t * 0.56;
    const a1 = offsetPoint(a0, fromPort, stub);
    const b1 = offsetPoint(b0, toPort, stub);
    const pts = [a0, a1];
    if (horiz) {
      if (Math.abs(a1.y - b1.y) <= ALIGN) {
        const y = Math.round((a1.y + b1.y) / 2);
        pts[1] = { x: a1.x, y: y };
        pts.push({ x: b1.x, y: y });
      } else {
        const midX = a1.x + (b1.x - a1.x) * split;
        pts.push({ x: midX, y: a1.y }, { x: midX, y: b1.y });
      }
    } else if (Math.abs(a1.x - b1.x) <= ALIGN) {
      const x = Math.round((a1.x + b1.x) / 2);
      pts[1] = { x: x, y: a1.y };
      pts.push({ x: x, y: b1.y });
    } else {
      const midY = a1.y + (b1.y - a1.y) * split;
      pts.push({ x: a1.x, y: midY }, { x: b1.x, y: midY });
    }
    pts.push(b1, b0);
    return dedupePoints(pts);
  }

  function pointsToPath(pts, route) {
    if (!pts.length) return '';
    if (normRoute(route) === 'curved' && pts.length >= 4) {
      const a = pts[0];
      const c1 = pts[1];
      const c2 = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
    }
    return pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
  }

  function cubicAt(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  }

  function connectorPath(fromShape, fromPort, toShape, toPort, style) {
    const route = normRoute(style && style.route);
    const pts = routePoints(fromShape, fromPort, toShape, toPort, route, style && style.bend);
    const d = pointsToPath(pts, route);
    let mid;
    if (route === 'curved' && pts.length >= 4) mid = cubicAt(pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1], 0.5);
    else mid = connectorMid(pts);
    return { pts, d, mid, route };
  }

  function connectorMid(pts) {
    if (!pts.length) return { x: 0, y: 0 };
    let total = 0;
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const len = Math.hypot(dx, dy);
      segs.push(len);
      total += len;
    }
    let remain = total / 2;
    for (let i = 1; i < pts.length; i++) {
      if (remain <= segs[i - 1]) {
        const t = segs[i - 1] ? remain / segs[i - 1] : 0;
        return {
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
        };
      }
      remain -= segs[i - 1];
    }
    return pts[pts.length - 1];
  }

  function contentBounds(data) {
    const ids = Object.keys(data.shapes);
    const frames = data.frames || [];
    if (!ids.length && !frames.length) return { x: 0, y: 0, w: 800, h: 500 };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    ids.forEach((id) => {
      const s = data.shapes[id];
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w + (s.noteOpen ? 220 : 0));
      y1 = Math.max(y1, s.y + s.h, s.noteOpen ? s.y + 168 : s.y + s.h);
    });
    frames.forEach((f) => {
      x0 = Math.min(x0, f.x);
      y0 = Math.min(y0, f.y - 54);
      x1 = Math.max(x1, f.x + f.w);
      y1 = Math.max(y1, f.y + f.h);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function shapesByZ(data) {
    return Object.keys(data.shapes).map((id) => data.shapes[id]).sort((a, b) => (a.z || 0) - (b.z || 0) || String(a.id).localeCompare(String(b.id)));
  }

  function hitShape(data, pt) {
    const list = shapesByZ(data);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h) return s;
    }
    return null;
  }

  function rectsOverlap(a, b, pad) {
    const p = pad || 0;
    return a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
  }

  function rectInside(inner, outer) {
    return inner.x >= outer.x && inner.y >= outer.y
      && inner.x + inner.w <= outer.x + outer.w
      && inner.y + inner.h <= outer.y + outer.h;
  }

  function borderStrokeWidth(style) {
    if (!style || style.borderless) return 0;
    const w = Number(style.borderWidth);
    return Number.isFinite(w) && w > 0 ? w : 2;
  }

  function hexAlpha(hex, a) {
    const h = String(hex || '').replace('#', '');
    const alpha = clamp01(a, 1);
    if (h.length < 6) return `rgba(255,255,255,${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function maxZ(data) {
    let m = 0;
    Object.keys(data.shapes).forEach((id) => { m = Math.max(m, data.shapes[id].z || 0); });
    (data.frames || []).forEach((f) => { m = Math.max(m, f.z || 0); });
    return m;
  }

  function minZ(data) {
    let m = Infinity;
    Object.keys(data.shapes).forEach((id) => { m = Math.min(m, data.shapes[id].z || 0); });
    (data.frames || []).forEach((f) => { m = Math.min(m, f.z || 0); });
    return m === Infinity ? 0 : m;
  }

  function layerItems(data) {
    const items = [];
    Object.keys(data.shapes).forEach((id) => items.push({ kind: 'shape', id, z: data.shapes[id].z || 0 }));
    (data.frames || []).forEach((f) => items.push({ kind: 'frame', id: f.id, z: f.z || 0 }));
    items.sort((a, b) => a.z - b.z || String(a.id).localeCompare(String(b.id)));
    return items;
  }

  function safeImageSrc(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)/i.test(s)) return s;
    try {
      const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s.replace(/^\/\//, '');
      const u = new URL(withProto);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) { /* ignore */ }
    return '';
  }

  function dashArray(dash) {
    if (dash === 'dashed') return '10 7';
    if (dash === 'dotted') return '2 6';
    if (dash === 'dashdot') return '12 6 2 6';
    if (dash === 'longdash') return '18 8';
    return '';
  }

  function cloneData(data) {
    return JSON.parse(JSON.stringify(normalize(data)));
  }

  return {
    SHAPE_META,
    SHAPE_TYPES,
    PORTS,
    FONT_FACES,
    FONT_SIZES,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    ARROW_MODES,
    ROUTE_MODES,
    SNAP,
    ALIGN,
    MIN_W,
    MIN_H,
    MIN_FRAME_W,
    MIN_FRAME_H,
    STICKY_MINI,
    STICKY_MINI_H,
    STICKY_MINI_H_MAX,
    STICKY_MINI_W_MIN,
    STICKY_MINI_W_MAX,
    uid,
    clamp,
    clamp01,
    snap,
    defaultStyle,
    defaultLineStyle,
    defaultLine,
    clampBend,
    defaultFormat,
    normValign,
    defaultShape,
    collapseSticky,
    expandSticky,
    stickyMiniHeight,
    stickyMiniWidth,
    stickyMiniWidthBounds,
    applyCollapsedStickySize,
    clampFontSize,
    stickyFoldPath,
    firstLine,
    defaultConnector,
    defaultFrame,
    fontCss,
    createEmpty,
    createStarter,
    TEMPLATE_LIST,
    ICON_LIST,
    ICON_SIZE,
    iconSrc,
    iconShape,
    isFlowIcon,
    buildTemplate,
    applyTemplate,
    normalize,
    normalizeFrameCats,
    serializeToHtml,
    isFlowHtml,
    parseHtml,
    shapePath,
    portPoint,
    offsetPoint,
    nearestPort,
    routePoints,
    pointsToPath,
    connectorPath,
    connectorMid,
    contentBounds,
    shapesByZ,
    hitShape,
    rectsOverlap,
    rectInside,
    hexAlpha,
    borderStrokeWidth,
    DASH_MODES,
    DASH_LABELS,
    normDash,
    maxZ,
    minZ,
    layerItems,
    safeImageSrc,
    dashArray,
    cloneData,
  };
});
