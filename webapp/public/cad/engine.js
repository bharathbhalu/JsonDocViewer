/* DocViewer CAD engine — quick 3D prototyping for 3D printing.
 *
 * A big viewport, a floating shape toolbar and a small inspector for the
 * selected shape. Modelling runs in a Web Worker (vendor/cad-worker.js):
 * OpenCascade builds drawn shapes, manifold joins and cuts everything.
 *
 * Input: mouse (left orbit, right pan, wheel zoom), trackpad (two-finger
 * scroll orbits, shift pans, pinch zooms), touch (one finger orbits, two pan /
 * pinch), Apple Pencil (tap selects, drag the gizmo, hover highlights) and a
 * keyboard on desktop.
 */
(function (global) {
  const C = global.CadCore;
  const VENDOR = '/cad/vendor/';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, body) => {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const DEG = Math.PI / 180;
  // Number fields accept simple maths, e.g. "41.2 + 2*0.4".
  function evalNum(s, fallback) {
    const t = String(s).trim().replace(/,/g, '.');
    if (!t) return fallback;
    if (!/^[\d+\-*/(). ]+$/.test(t)) return fallback;
    try { const v = Function('"use strict";return (' + t + ')')(); return Number.isFinite(v) ? v : fallback; } catch (e) { return fallback; } // eslint-disable-line no-new-func
  }
  const ICON = {
    box: '<svg viewBox="0 0 24 24"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 2.2L17.6 8 12 10.8 6.4 8 12 5.2ZM6 9.6l5 2.5v6.6l-5-2.5V9.6Zm7 9.1v-6.6l5-2.5v6.6l-5 2.5Z"/></svg>',
    cylinder: '<svg viewBox="0 0 24 24"><path d="M12 3C7.6 3 5 4.6 5 6.5v11C5 19.4 7.6 21 12 21s7-1.6 7-3.5v-11C19 4.6 16.4 3 12 3Zm0 2c3.4 0 5 1.1 5 1.5S15.4 8 12 8 7 6.9 7 6.5 8.6 5 12 5Zm0 14c-3.4 0-5-1.1-5-1.5V9.2C8.3 9.8 10 10 12 10s3.7-.2 5-.8v8.3c0 .4-1.6 1.5-5 1.5Z"/></svg>',
    sphere: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 0 1 6.9 6c-1.5.9-4 1.5-6.9 1.5S6.6 11.9 5.1 11A7 7 0 0 1 12 5Zm0 14a7 7 0 0 1-6.8-5.6c1.8.7 4.2 1.1 6.8 1.1s5-.4 6.8-1.1A7 7 0 0 1 12 19Z"/></svg>',
    import: '<svg viewBox="0 0 24 24"><path d="M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3V3ZM4 15h2v4h12v-4h2v6H4v-6Z"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="m8.6 7.4-1.4-1.4L1.2 12l6 6 1.4-1.4L4 12l4.6-4.6Zm6.8 0L20 12l-4.6 4.6 1.4 1.4 6-6-6-6-1.4 1.4Z"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A7.9 7.9 0 0 1 20.1 16l2.4-.8A10.5 10.5 0 0 0 12.5 8Z"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M18.4 10.6A10.4 10.4 0 0 0 1.5 15.2l2.4.8A7.9 7.9 0 0 1 16.6 12.4L13 16h9V7l-3.6 3.6Z"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="M12 2 8.5 5.5h2.5V11H5.5V8.5L2 12l3.5 3.5V13H11v5.5H8.5L12 22l3.5-3.5H13V13h5.5v2.5L22 12l-3.5-3.5V11H13V5.5h2.5L12 2Z"/></svg>',
    rotate: '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M12 5C6.5 5 2.7 9.4 1.5 12c1.2 2.6 5 7 10.5 7s9.3-4.4 10.5-7C21.3 9.4 17.5 5 12 5Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="m3.3 2 18.7 18.7-1.4 1.4-3.4-3.4A11.3 11.3 0 0 1 12 19c-5.5 0-9.3-4.4-10.5-7a14.3 14.3 0 0 1 4-4.9L1.9 3.4 3.3 2ZM12 5c5.5 0 9.3 4.4 10.5 7-.5 1.2-1.6 2.8-3 4.1L16 12.6a4 4 0 0 0-4.6-4.6L8.8 5.4C9.8 5.2 10.9 5 12 5Z"/></svg>',
    export: '<svg viewBox="0 0 24 24"><path d="M12 2 6.3 7.7l1.4 1.4L11 5.8V16h2V5.8l3.3 3.3 1.4-1.4L12 2ZM4 14h2v5h12v-5h2v7H4v-7Z"/></svg>',
    ruler: '<svg viewBox="0 0 24 24"><path d="M2.6 15.8 15.8 2.6l5.6 5.6L8.2 21.4l-5.6-5.6Zm2.8 0 2.8 2.8 1.4-1.4-1.4-1.4 1.4-1.4 1.4 1.4 1.4-1.4-1.4-1.4 1.4-1.4 2.1 2.1 1.4-1.4-2.1-2.1 1.4-1.4 1.4 1.4 1.4-1.4-1.4-1.4 1.4-1.4 1.4 1.4 1.4-1.4-2.8-2.8L5.4 15.8Z"/></svg>',
    sketch: '<svg viewBox="0 0 24 24"><path d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7L3 17.3Zm17.7-10.2a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7 1.9-1.7ZM3 23h18v-1H3v1Z"/></svg>',
    line: '<svg viewBox="0 0 24 24"><path d="M4 18 18 4l1.4 1.4-14 14L4 18Zm-1 1a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm14-14a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3V5Zm2 2v10h14V7H5Z"/></svg>',
    circle: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z"/></svg>',
    multi: '<svg viewBox="0 0 24 24"><path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm0 10h8v8h-8v-8ZM3 13h8v8H3v-8Zm2.3 4.2 1.4-1.4L8 17.1l3.3-3.3 1.4 1.4L8 19.9l-2.7-2.7Z"/></svg>',
    all: '<svg viewBox="0 0 24 24"><path d="M3 3h4v2H5v2H3V3Zm6 0h6v2H9V3Zm8 0h4v4h-2V5h-2V3ZM3 9h2v6H3V9Zm16 0h2v6h-2V9ZM3 17h2v2h2v2H3v-4Zm16 0h2v4h-4v-2h2v-2ZM9 19h6v2H9v-2Zm-1-11h8v8H8V8Z"/></svg>',
    slot: '<svg viewBox="0 0 24 24"><path d="M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7Zm0 2a3 3 0 0 0 0 6h10a3 3 0 0 0 0-6H7Z"/></svg>',
    ngon: '<svg viewBox="0 0 24 24"><path d="M7.5 3h9l4.5 9-4.5 9h-9L3 12l4.5-9Zm1.2 2L5.2 12l3.5 7h6.6l3.5-7-3.5-7H8.7Z"/></svg>',
    arc: '<svg viewBox="0 0 24 24"><path d="M4 18a8 8 0 0 1 16 0h-2a6 6 0 0 0-12 0H4Z"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/></svg>',
    cut: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" fill-rule="evenodd"/></svg>',
    face: '<svg viewBox="0 0 24 24"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.5 8 12 11.6 5.5 8 12 4.3Z"/><path d="M12 13v8" stroke="currentColor" stroke-width="2"/></svg>',
    scale: '<svg viewBox="0 0 24 24"><path d="M3 3h8v2H6.4l4.3 4.3-1.4 1.4L5 6.4V11H3V3Zm18 18h-8v-2h4.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2v8Z"/></svg>',
    mirrorx: '<svg viewBox="0 0 24 24"><path d="M11 2h2v20h-2zM9 6v12L3 12zm6 0 6 6-6 6z" opacity=".9"/></svg>',
    mirrory: '<svg viewBox="0 0 24 24"><path d="M2 11h20v2H2zM6 9h12l-6-6zm0 6h12l-6 6z" opacity=".9"/></svg>',
    mirrorz: '<svg viewBox="0 0 24 24"><path d="M3 11.5l9-4 9 4-9 4zM12 2v3m0 14v3" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    flip: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.7 6H22l-3 4-3-4h1.6A6 6 0 0 0 6.3 9.2L4.6 8A8 8 0 0 1 12 4Zm-7.7 10H2l3-4 3 4H6.4a6 6 0 0 0 11.3 1.8l1.7 1.2A8 8 0 0 1 4.3 14Z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h2v2H4V6Zm4 0h12v2H8V6Zm-4 5h2v2H4v-2Zm4 0h12v2H8v-2Zm-4 5h2v2H4v-2Zm4 0h12v2H8v-2Z"/></svg>',
  };
  const ROLE_LABEL = { solid: 'Solid', hole: 'Hole', ref: 'Reference' };
  const ROLE_HINT = { solid: 'Part of the print', hole: 'Cut out of the solids', ref: 'Only shown — for fitting' };

  class CadEngine {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = opts || {};
      this.data = C.normalize({});
      this.readOnly = !!this.opts.readOnly;
      this.sel = null;              // selected item id (single selection)
      this.multi = [];              // ids when 2+ objects are selected (then sel is null)
      this.multiMode = false;       // iPad: every tap adds / removes
      this.mode = 'translate';      // gizmo mode
      this.showHoles = true;
      this.undoStack = []; this.redoStack = [];
      this.meshes = {};             // id -> {vertices, triangles} (local frame)
      this.errors = {}; this.notes = {};
      this.stepOk = true;
      this.buildSeq = 0; this.building = false; this.pendingBuild = false;
      this.disposers = [];
      this.root = document.createElement('div');
      this.root.className = 'cad-root';
      this.root.tabIndex = 0;
      stage.innerHTML = '';
      stage.appendChild(this.root);
      this._boot();
    }

    // ---------- board API ----------
    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.normalize({});
      this.undoStack = []; this.redoStack = [];
      this.sel = null; this.multi = [];
      this._fitOnNextResult = true;
      if (this.ready) { this._syncAll(); this._requestBuild(); }
    }
    serializeToHtml() { return C.serializeToHtml(this.data); }
    setReadOnly(on) { this.readOnly = !!on; this.root.classList.toggle('cad-ro', this.readOnly); if (this.ready) { this._select(null); this._renderChrome(); } }
    // Called by the app before every save. Commit a half-typed number field
    // without moving focus — blurring here kicked you out of whatever you were
    // typing in (e.g. the script editor) on every autosave.
    flushEdit() {
      const a = document.activeElement;
      if (a && this.inspEl && this.inspEl.contains(a) && a.matches && a.matches('input[data-f], input[data-name]')) a.dispatchEvent(new Event('change'));
    }
    destroy() {
      this.destroyed = true;
      if (this._codeEd) { try { this._codeEd.dispose(); } catch (e) { /* gone */ } }
      clearInterval(this._installPoll);
      this.disposers.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
      if (this.worker) this.worker.terminate();
      if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss && this.renderer.forceContextLoss(); }
      this.stage.innerHTML = '';
    }

    _on(el, ev, fn, o) { el.addEventListener(ev, fn, o); this.disposers.push(() => el.removeEventListener(ev, fn, o)); }
    _changed() { if (this.opts.onChange) this.opts.onChange(); }
    _toast(msg, kind) {
      const t = this.root.querySelector('.cad-toast');
      if (!t) return;
      t.textContent = msg; t.className = 'cad-toast show ' + (kind || '');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { t.className = 'cad-toast'; }, kind === 'err' ? 6000 : 2600);
    }
    _docPath() { return (this.opts.getPath && this.opts.getPath()) || ''; }
    _docDir() { const p = this._docPath(); return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }
    _docBase() { return (this._docPath().split('/').pop() || 'design').replace(/\.html?$/i, ''); }

    // ---------- boot: add-on check, libraries, worker ----------
    async _boot() {
      this.root.innerHTML = '<div class="cad-center"><div class="cad-spin"></div><p>Loading 3D modeling…</p></div>';
      let st;
      try { st = await api('/api/cad/addon'); } catch (e) { this._fatal('Could not reach the server: ' + e.message); return; }
      if (this.destroyed) return;
      if (!st.installed) { this._installCard(st); return; }
      this.version = (st.versions && st.versions.installed) || '1';
      try {
        this.T = await import(VENDOR + 'three-bundle.js?v=' + encodeURIComponent(this.version));
      } catch (e) { this._fatal('Could not load the 3D viewer: ' + e.message); return; }
      if (this.destroyed) return;
      this._buildDom();
      this._initThree();
      this._initWorker();
      this.ready = true;
      this._syncAll();
      this._requestBuild();
    }
    _fatal(msg) { this.root.innerHTML = '<div class="cad-center"><p class="cad-err">' + esc(msg) + '</p></div>'; }
    _installCard(st) {
      const render = (s) => {
        const log = (s.log || []).slice(-6).map(esc).join('\n');
        this.root.innerHTML = `<div class="cad-center"><div class="cad-card">
          <h3>3D modeling isn't installed yet</h3>
          <p>A one-time setup builds the modeling libraries on this computer (about 30 MB): OpenCascade, manifold and Three.js. You can also manage it in <b>Settings → 3D modeling</b>.</p>
          ${s.npm === false ? '<p class="cad-err">npm was not found. Install Node.js first (for example <code>brew install node</code>).</p>' : ''}
          ${s.error ? '<p class="cad-err">' + esc(s.error) + '</p>' : ''}
          ${s.busy || log ? '<pre class="cad-log">' + log + '</pre>' : ''}
          <button type="button" class="cad-primary" data-install ${s.busy || s.npm === false ? 'disabled' : ''}>${s.busy ? 'Installing…' : 'Install 3D modeling'}</button>
        </div></div>`;
        const b = this.root.querySelector('[data-install]');
        if (b) b.onclick = async () => { try { await api('/api/cad/addon/install', {}); poll(); } catch (e) { this._toastless(e.message); } };
      };
      this._toastless = (m) => { st.error = m; render(st); };
      const poll = () => {
        clearInterval(this._installPoll);
        this._installPoll = setInterval(async () => {
          let s; try { s = await api('/api/cad/addon'); } catch (e) { return; }
          if (this.destroyed) { clearInterval(this._installPoll); return; }
          if (s.installed && !s.busy) { clearInterval(this._installPoll); this._boot(); return; }
          render(s);
          if (!s.busy) clearInterval(this._installPoll);
        }, 1000);
      };
      render(st);
      if (st.busy) poll();
    }

    // ---------- DOM ----------
    _buildDom() {
      this.root.innerHTML = `
        <div class="cad-view"></div>
        <div class="cad-tools" role="toolbar" aria-label="Shapes">
          <button type="button" data-add="box" title="Box (B)">${ICON.box}<span>Box</span></button>
          <button type="button" data-add="cylinder" title="Cylinder (C)">${ICON.cylinder}<span>Cylinder</span></button>
          <button type="button" data-add="sphere" title="Sphere">${ICON.sphere}<span>Sphere</span></button>
          <button type="button" data-sketch title="Sketch — draw a 2D shape, then give it height (S)">${ICON.sketch}<span>Sketch</span></button>
          <button type="button" data-import title="Import a model (STL, 3MF, OBJ, STEP) or an image to trace (I)">${ICON.import}<span>Import</span></button>
          <button type="button" data-add="code" title="Script shape (replicad code)" class="cad-minor">${ICON.code}<span>Script</span></button>
          <div class="cad-sep"></div>
          <button type="button" data-face title="Face — tap a flat face to push / pull it, sketch on it or lay it flat (E)">${ICON.face}<span>Face</span></button>
          <button type="button" data-measure title="Measure (D) — tap two points">${ICON.ruler}<span>Measure</span></button>
          <button type="button" data-multimode title="Select several — every tap adds or removes (or Shift / ⌘-click; ⌘A selects all)">${ICON.multi}<span>Multi</span></button>
          <button type="button" data-selall title="Select all objects (⌘A) — tap again to clear">${ICON.all}<span>All</span></button>
          <div class="cad-sep"></div>
          <button type="button" data-undo title="Undo (⌘Z)">${ICON.undo}</button>
          <button type="button" data-redo title="Redo (⇧⌘Z)">${ICON.redo}</button>
        </div>
        <div class="cad-top">
          <span class="cad-status"></span>
          <div class="cad-menu-wrap">
            <button type="button" class="cad-primary cad-export-btn" data-export>${ICON.export}<span>Export</span></button>
            <div class="cad-menu hidden">
              <button type="button" data-ex="3mf">Save 3MF <small>separate named objects — Bambu, Orca, Prusa</small></button>
              <button type="button" data-ex="stl">Save STL <small>one file, all solids — any slicer</small></button>
              <button type="button" data-ex="step">Save STEP <small>exact CAD — Fusion, Shapr3D, FreeCAD</small></button>
              <button type="button" data-ex="dl3mf">Download 3MF <small>to this device</small></button>
              <button type="button" data-ex="dl">Download STL <small>to this device</small></button>
            </div>
          </div>
        </div>
        <div class="cad-axes" aria-label="Look along an axis">
          <button type="button" data-axis="x" class="ax-x" title="Look along X — tap again for the other side">X</button>
          <button type="button" data-axis="y" class="ax-y" title="Look along Y — tap again for the other side">Y</button>
          <button type="button" data-axis="z" class="ax-z" title="Look along Z (top) — tap again for the bottom">Z</button>
        </div>
        <div class="cad-skbar hidden">
          <div class="cad-seg">
            <button type="button" data-sktool="line" title="Line — tap points, tap the first point to close (L)">${ICON.line}<span>Line</span></button>
            <button type="button" data-sktool="rect" title="Rectangle — tap two corners (R)">${ICON.rect}<span>Rectangle</span></button>
            <button type="button" data-sktool="circle" title="Circle — tap the centre, then the edge (C)">${ICON.circle}<span>Circle</span></button>
            <button type="button" data-sktool="slot" title="Slot — tap the centre of one end, then the other (O)">${ICON.slot}<span>Slot</span></button>
            <button type="button" data-sktool="ngon" title="Polygon — tap the centre, then a corner (P)">${ICON.ngon}<span>Polygon</span></button>
          </div>
          <div class="cad-seg cad-skopts">
            <button type="button" data-skarc title="Arc: the next Line segment curves — tap its end, then a point it bends through (A)">${ICON.arc}<span>Arc</span></button>
            <button type="button" data-skcut title="Cut: shapes drawn now are holes in the sketch (X)">${ICON.cut}<span>Cut</span></button>
            <label class="cad-skopt" data-skslotw-wrap title="Slot width">W<input type="text" inputmode="decimal" data-skslotw value="6"><em>mm</em></label>
            <label class="cad-skopt" data-sksides-wrap title="Polygon sides">Sides<input type="text" inputmode="numeric" data-sksides value="6"></label>
          </div>
          <div class="cad-seg cad-skplane" title="Sketch plane (choose before drawing)">
            <button type="button" data-skplane="xy">XY</button><button type="button" data-skplane="xz">XZ</button><button type="button" data-skplane="yz">YZ</button>
            <label class="cad-skopt">at<input type="text" inputmode="decimal" data-skoff value="0"><em>mm</em></label>
          </div>
          <span class="cad-skhint"></span>
          <button type="button" data-skundo title="Undo last point or shape (⌫)">${ICON.undo}</button>
          <button type="button" data-skcancel>Cancel</button>
          <button type="button" class="cad-primary" data-skdone>Done</button>
        </div>
        <div class="cad-inspector hidden"></div>
        <div class="cad-list collapsed">
          <button type="button" class="cad-list-head" data-listtoggle>${ICON.list}<span>Shapes</span><b class="cad-count"></b></button>
          <div class="cad-list-body"></div>
        </div>
        <div class="cad-scalebar hidden">
          <span class="cad-sb-t">Scale</span>
          ${['x', 'y', 'z'].map((a, i) => `<label class="cad-sb-f ax${i}"><b>${a.toUpperCase()}</b>×<input type="text" inputmode="decimal" data-sbf="${i}" value="1"></label>`).join('')}
          <label class="cad-sb-f all"><b>All</b>×<input type="text" inputmode="decimal" data-sball value="1"></label>
          <button type="button" data-sbreset title="Back to ×1">Reset</button>
          <button type="button" class="cad-primary cad-small" data-sbapply>Apply</button>
        </div>
        <div class="cad-viewbar">
          <div class="cad-seg cad-gizmo hidden">
            <button type="button" data-mode="translate" title="Move (M)">${ICON.move}</button>
            <button type="button" data-mode="rotate" title="Rotate (R)">${ICON.rotate}</button>
            <button type="button" data-mode="scale" title="Scale / resize along X, Y, Z (T)">${ICON.scale}</button>
          </div>
          <div class="cad-seg">
            <button type="button" data-view="iso" title="3D view (1)">3D</button>
            <button type="button" data-view="top" title="Top (2)">Top</button>
            <button type="button" data-view="bottom" title="Bottom (⇧2)">Bottom</button>
            <button type="button" data-view="front" title="Front (3)">Front</button>
            <button type="button" data-view="back" title="Back (⇧3)">Back</button>
            <button type="button" data-view="left" title="Left (⇧4)">Left</button>
            <button type="button" data-view="right" title="Right (4)">Right</button>
            <button type="button" data-fit title="Fit everything (F)">${ICON.fit}</button>
          </div>
          <div class="cad-seg">
            <button type="button" data-holes title="Show holes (H)" class="on">Holes</button>
            <button type="button" data-snap title="Snap to grid">Snap</button>
          </div>
        </div>
        <div class="cad-mlayer"></div>
        <div class="cad-mbar hidden"><span class="cad-mhint">Tap two points to measure — corners snap</span><button type="button" data-mclear>Clear</button><button type="button" data-mdone>Done</button></div>
        <div class="cad-drop hidden"><div>Drop STL, 3MF, OBJ, STEP or image files to import</div></div>
        <div class="cad-toast"></div>
        <input type="file" class="cad-file" multiple accept=".stl,.3mf,.obj,.step,.stp,.png,.jpg,.jpeg,.webp,.gif,image/*" hidden>`;
      this.viewEl = this.root.querySelector('.cad-view');
      this.inspEl = this.root.querySelector('.cad-inspector');
      this.listEl = this.root.querySelector('.cad-list');
      this.statusEl = this.root.querySelector('.cad-status');
      const q = (s) => this.root.querySelector(s);

      this.root.querySelectorAll('[data-add]').forEach((b) => this._on(b, 'click', () => this._add(b.dataset.add)));
      this._on(q('[data-import]'), 'click', () => q('.cad-file').click());
      this._on(q('.cad-file'), 'change', (e) => { const f = [...e.target.files]; e.target.value = ''; this._importFiles(f); });
      this._on(q('[data-undo]'), 'click', () => this._undo());
      this._on(q('[data-redo]'), 'click', () => this._redo());
      this._on(q('[data-export]'), 'click', (e) => { e.stopPropagation(); q('.cad-menu').classList.toggle('hidden'); });
      this._on(document, 'pointerdown', (e) => { if (!e.target.closest('.cad-menu-wrap')) q('.cad-menu').classList.add('hidden'); });
      this.root.querySelectorAll('[data-ex]').forEach((b) => this._on(b, 'click', () => { q('.cad-menu').classList.add('hidden'); this._export(b.dataset.ex); }));
      this.root.querySelectorAll('[data-mode]').forEach((b) => this._on(b, 'click', () => this._setMode(b.dataset.mode)));
      this.root.querySelectorAll('[data-view]').forEach((b) => this._on(b, 'click', () => this._view(b.dataset.view)));
      this._on(q('[data-fit]'), 'click', () => this._fit());
      this._on(q('[data-holes]'), 'click', () => this._toggleHoles());
      this._on(q('[data-snap]'), 'click', () => { this.snapOn = !this.snapOn; this._applySnap(); this._renderChrome(); });
      this._on(q('[data-sketch]'), 'click', () => this._sketchStart(null));
      this._on(q('[data-selall]'), 'click', () => {
        const vis = this.data.items.filter((it) => !it.hidden).map((it) => it.id);
        const ids = this._selIds();
        if (vis.length && ids.length === vis.length && vis.every((id) => ids.includes(id))) this._select(null); else this._selectAll();
      });
      this._on(q('[data-multimode]'), 'click', () => { this.multiMode = !this.multiMode; this._renderChrome(); this._toast(this.multiMode ? 'Multi-select on — tap objects to add or remove them' : 'Multi-select off'); });
      this.root.querySelectorAll('[data-sktool]').forEach((b) => this._on(b, 'click', () => this._sketchTool(b.dataset.sktool)));
      this._on(q('[data-skarc]'), 'click', () => this._sketchOpt('arc'));
      this.root.querySelectorAll('[data-skplane]').forEach((b) => this._on(b, 'click', () => this._sketchPlane(b.dataset.skplane)));
      this._on(q('[data-skoff]'), 'change', () => this._sketchPlane(this._skPlane || 'xy'));
      this._on(q('[data-skcut]'), 'click', () => this._sketchOpt('cut'));
      this._on(q('[data-skslotw]'), 'change', (e) => { this._skSlotW = Math.max(0.1, evalNum(e.target.value, this._skSlotW || 6)); e.target.value = this._skSlotW; this._sketchDraw(); });
      this._on(q('[data-sksides]'), 'change', (e) => { this._skSides = Math.max(3, Math.min(64, Math.round(evalNum(e.target.value, this._skSides || 6)))); e.target.value = this._skSides; this._sketchDraw(); });
      this._on(q('[data-skundo]'), 'click', () => this._sketchUndo());
      this._on(q('[data-skcancel]'), 'click', () => this._sketchEnd(false));
      this._on(q('[data-skdone]'), 'click', () => this._sketchEnd(true));
      this.root.querySelectorAll('[data-axis]').forEach((b) => this._on(b, 'click', () => {
        const a = b.dataset.axis;
        this._axisFlip = this._lastAxis === a ? !this._axisFlip : false;
        this._lastAxis = a;
        this._view((this._axisFlip ? '-' : '') + a, true);
        this.root.querySelectorAll('[data-axis]').forEach((x) => { x.classList.toggle('on', x === b); x.textContent = (x === b && this._axisFlip ? '−' : '') + x.dataset.axis.toUpperCase(); });
      }));
      this._on(q('[data-face]'), 'click', () => this._faceMode(!this.faceOn));
      this._on(q('[data-measure]'), 'click', () => this._measureMode(!this.measureOn));
      this._on(q('[data-mclear]'), 'click', () => this._measureClear());
      this._on(q('[data-mdone]'), 'click', () => this._measureMode(false));
      // scale bar: × factors per axis, or All (sets all three)
      const sbIn = () => [0, 1, 2].map((i) => this.root.querySelector(`[data-sbf="${i}"]`));
      this.root.querySelectorAll('[data-sbf]').forEach((inp) => {
        this._on(inp, 'focus', () => setTimeout(() => inp.select(), 0));
        this._on(inp, 'keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') q('[data-sbapply]').click(); });
        this._on(inp, 'input', () => { const v = sbIn().map((x) => x.value); q('[data-sball]').value = v.every((x) => x === v[0]) ? v[0] : ''; this._scalePreview(); });
      });
      this._on(q('[data-sball]'), 'focus', (e) => setTimeout(() => e.target.select(), 0));
      this._on(q('[data-sball]'), 'keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') q('[data-sbapply]').click(); });
      this._on(q('[data-sball]'), 'input', (e) => { sbIn().forEach((x) => { x.value = e.target.value; }); this._scalePreview(); });
      this._on(q('[data-sbreset]'), 'click', () => { sbIn().forEach((x) => { x.value = '1'; }); q('[data-sball]').value = '1'; this._scalePreview(); });
      this._on(q('[data-sbapply]'), 'click', () => {
        const S = sbIn().map((x) => evalNum(x.value, 1)).map((v) => (v > 0 ? v : 1));
        sbIn().forEach((x) => { x.value = '1'; }); q('[data-sball]').value = '1'; this._scalePreview(true);
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        this.root.focus({ preventScroll: true }); this._active = true; // ⌘Z now undoes the scale, not the typing
        this._scaleSelection(S);
      });
      this._on(q('[data-listtoggle]'), 'click', () => this.listEl.classList.toggle('collapsed'));
      this._on(this.root, 'keydown', (e) => this._key(e));
      // Pinch / ⌘-scroll anywhere in the 3D area must not zoom the page: over the
      // picture it zooms the model, over a panel it is ignored.
      this._on(this.root, 'wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        if (this.renderer && e.target !== this.renderer.domElement && !e.target.closest('.cad-tools, .cad-inspector, .cad-list, .cad-viewbar, .cad-top, .cad-menu, .cad-codeov')) this._zoom(Math.exp(e.deltaY * 0.012), e);
      }, { passive: false });
      ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => this._on(this.root, t, (e) => e.preventDefault(), { passive: false }));
      // Dimension labels: double-click (mouse / trackpad) or a tap (touch / Pencil) edits.
      // Delegated so a label refreshed between the two clicks still gets the double-click.
      this._on(this.root, 'dblclick', (e) => { const l = e.target.closest && e.target.closest('.cad-dimlabel'); if (!l || e.target.closest('input')) return; e.preventDefault(); e.stopPropagation(); this._dimEdit(+l.dataset.dim); });
      this._on(this.root, 'pointerup', (e) => { if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return; const l = e.target.closest && e.target.closest('.cad-dimlabel'); if (!l || e.target.closest('input')) return; this._dimEdit(+l.dataset.dim); });
      // Shortcuts keep working after a panel button re-renders (its focus falls
      // back to <body>): the 3D view stays "active" from the last tap / click in
      // it until you tap or click somewhere else on the page. ⌘A over the view
      // never selects the page's text.
      this._on(this.root, 'pointerenter', () => { this._hovering = true; });
      this._on(this.root, 'pointerleave', () => { this._hovering = false; });
      this._on(document, 'pointerdown', (e) => { this._active = this.root.contains(e.target); }, true);
      this._on(document, 'keydown', (e) => {
        if (this.root.contains(e.target) || !this.root.isConnected) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const selectAll = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a';
        const onBody = !t || t === document.body || t === document.documentElement;
        if (!((this._active && onBody) || (selectAll && this._hovering))) return;
        if (selectAll) e.preventDefault();
        this.root.focus({ preventScroll: true });
        this._key(e);
      });

      // Desktop: drag files in.
      const drop = q('.cad-drop');
      let depth = 0;
      this._on(this.root, 'dragenter', (e) => { if (this.readOnly || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); depth++; drop.classList.remove('hidden'); });
      this._on(this.root, 'dragover', (e) => { if (!drop.classList.contains('hidden')) e.preventDefault(); });
      this._on(this.root, 'dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.add('hidden'); } });
      this._on(this.root, 'drop', (e) => { if (drop.classList.contains('hidden')) return; e.preventDefault(); depth = 0; drop.classList.add('hidden'); this._importFiles([...e.dataTransfer.files]); });
      this.snapOn = true;
      this.root.classList.toggle('cad-ro', this.readOnly);
    }

    // ---------- Three.js scene and input ----------
    _initThree() {
      const T = this.T;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
      this.viewEl.appendChild(renderer.domElement);
      renderer.domElement.style.touchAction = 'none';
      this.renderer = renderer;
      const scene = new T.Scene();
      this.scene = scene;
      const cam = new T.PerspectiveCamera(40, 1, 0.5, 20000);
      cam.up.set(0, 0, 1);
      cam.position.set(160, -200, 150);
      this.camera = cam;
      this.persp = cam;
      // Flat, true-scale camera for Top / Bottom / Front / Back / Left / Right and the axis boxes.
      this.ortho = new T.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
      this.ortho.up.set(0, 0, 1);
      scene.add(new T.HemisphereLight(0xffffff, 0x8a92a0, 1.6));
      const key = new T.DirectionalLight(0xffffff, 1.5); key.position.set(-1, -2, 3); scene.add(key);
      const fill = new T.DirectionalLight(0xffffff, 0.5); fill.position.set(2, 1.5, 1); scene.add(fill);
      this.target = new T.Vector3(0, 0, 0);

      this.grid = new T.Group(); scene.add(this.grid);
      this.itemsGroup = new T.Group(); scene.add(this.itemsGroup);
      this.designGroup = new T.Group(); scene.add(this.designGroup);
      this.objs = {}; // id -> {group, mesh, edges}

      const controls = new T.OrbitControls(cam, renderer.domElement);
      controls.target = this.target;
      controls.enableDamping = true; controls.dampingFactor = 0.15;
      controls.enableZoom = false; // our own wheel handling (trackpad vs mouse)
      controls.screenSpacePanning = true;
      controls.touches = { ONE: T.TOUCH.ROTATE, TWO: T.TOUCH.DOLLY_PAN };
      controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.PAN };
      this.controls = controls;

      const tc = new T.TransformControls(cam, renderer.domElement);
      tc.setSpace('world');
      tc.size = matchMedia('(pointer: coarse)').matches ? 1.35 : 1;
      scene.add(tc.getHelper());
      this.tc = tc;
      // Orbiting an orthographic view turns perspective back on.
      let startDir = null;
      controls.addEventListener('start', () => { startDir = this.camera.position.clone().sub(this.target).normalize(); });
      controls.addEventListener('change', () => {
        if (!this.isOrtho || !startDir) return;
        const d = this.camera.position.clone().sub(this.target).normalize();
        if (d.angleTo(startDir) > 0.01) { startDir = null; this._setOrtho(false); this._markView(null); }
      });
      controls.addEventListener('end', () => { startDir = null; });
      tc.addEventListener('dragging-changed', (e) => {
        controls.enabled = !e.value;
        this.dragging = e.value;
        if (e.value) { this._snapshot(); if (this.multi.length) this._multiDragStart(); }
        else if (this.multi.length) this._multiDragApply(true);
        else { this._readGizmo(true); }
      });
      tc.addEventListener('objectChange', () => {
        if (this.tc.mode === 'scale' && !this.multi.length) { this._dimUpdate(true); return; }
        if (this.multi.length) this._multiDragApply(false); else this._readGizmo(false);
      });
      this._applySnap();

      // Wheel: pinch (ctrl) zooms; trackpad scroll orbits (shift pans); mouse wheel zooms.
      this._on(renderer.domElement, 'wheel', (e) => {
        e.preventDefault();
        const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || Math.abs(e.deltaY) < 40) && !e.ctrlKey;
        if (e.ctrlKey) this._zoom(Math.exp(e.deltaY * 0.012), e);
        else if (trackpad && e.shiftKey) this._pan(-e.deltaX, -e.deltaY);
        else if (trackpad) this._orbit(e.deltaX, e.deltaY);
        else this._zoom(Math.exp(e.deltaY * 0.0015), e);
      }, { passive: false });
      // Safari trackpad pinch arrives as gesture events.
      let gs = 1;
      this._on(renderer.domElement, 'gesturestart', (e) => { e.preventDefault(); gs = 1; });
      this._on(renderer.domElement, 'gesturechange', (e) => { e.preventDefault(); this._zoom(gs / e.scale); gs = e.scale; });

      // Tap / click to select; hover highlight for mouse and Pencil hover.
      let down = null;
      this._on(renderer.domElement, 'pointerdown', (e) => {
        this._faceDragged = false; // a new press: only a drag that starts now suppresses the tap
        if (!this.faceOn || !this.face || !this._faceArrow) return;
        // grab near the arrow: within 40 px of its line on screen
        const f = this.face; const r = renderer.domElement.getBoundingClientRect();
        const toS = (p) => { const q = p.clone().project(this.camera); return [(q.x + 1) / 2 * r.width + r.left, (1 - q.y) / 2 * r.height + r.top]; };
        const a = toS(f.center), b = toS(f.center.clone().addScaledVector(f.n, this._faceArrow.line.scale.y + 4 + (this._faceDist > 0 ? this._faceDist : 0)));
        const t = Math.max(0, Math.min(1, ((e.clientX - a[0]) * (b[0] - a[0]) + (e.clientY - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1)));
        if (Math.hypot(a[0] + (b[0] - a[0]) * t - e.clientX, a[1] + (b[1] - a[1]) * t - e.clientY) > 40) return;
        e.stopPropagation(); this.controls.enabled = false; this._faceDrag = { d0: this._faceDist || 0 }; renderer.domElement.setPointerCapture(e.pointerId);
      }, true);
      this._on(renderer.domElement, 'pointermove', (e) => {
        if (!this._faceDrag) return;
        // distance along the normal: closest point between the pointer ray and the normal line
        const f = this.face; const ray = this._ray(e).ray; const d = f.n.clone();
        const w0 = f.center.clone().sub(ray.origin); const b = d.dot(ray.direction), dd = d.dot(w0), ee = ray.direction.dot(w0);
        const den = 1 - b * b; if (Math.abs(den) < 1e-6) return;
        let s = (b * ee - dd) / den; const g = this.snapOn && this.data.settings.snap ? this.data.settings.snap : 0;
        if (g) s = Math.round(s / g) * g;
        this._faceDragged = true; this._faceApply(r3(s), false);
      }, true);
      // End the arrow drag however the pointer is released — on the canvas, elsewhere
      // on the page, or if the browser cancels / drops the capture — so the camera
      // never stays locked.
      const endFaceDrag = () => { if (!this._faceDrag) return; this._faceDrag = null; this.controls.enabled = true; this._faceApply(this._faceDist || 0, true); };
      this._on(window, 'pointerup', endFaceDrag, true);
      this._on(window, 'pointercancel', endFaceDrag, true);
      this._on(renderer.domElement, 'lostpointercapture', endFaceDrag);
      this._on(window, 'blur', endFaceDrag);
      this._on(renderer.domElement, 'pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, multi: !e.isPrimary }; this.root.focus({ preventScroll: true }); });
      this._on(renderer.domElement, 'pointerup', (e) => {
        if (!down || down.id !== e.pointerId) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const quick = Date.now() - down.t < 450;
        const d = down; down = null;
        if (d.multi || moved > 6 || !quick || this.dragging || (this.tc.axis && (this.sel || this.multi.length))) return;
        if (e.button === 2) return;
        if (this.sk) { this._sketchClick(e); return; }
        if (this.faceOn) { if (!this._faceDragged) this._facePick(e); this._faceDragged = false; return; }
        if (this.edgeMode) { this._edgeClick(e); return; }
        if (this.cutMode) { const hit = this._pick(e); if (hit) this._cutToggle(hit); return; }
        if (this.exMode) { const o = this.objs[this.exMode.id]; if (o && o.fills) { const h = this._ray(e).intersectObjects(o.fills, false)[0]; if (h) this._extrudeToggle(h.object.userData.region); } return; }
        if (this.measureOn) { this._measureClick(e); return; }
        const add = e.shiftKey || e.metaKey || e.ctrlKey || this.multiMode;
        { const so = this.sel && this.objs[this.sel]; if (so && so.draft && so.fills && so.fills.length && !this.readOnly) { const h = this._ray(e).intersectObjects(so.fills, false)[0]; if (h) { const ri = h.object.userData.region; this._extrudeStart(this.sel).then(() => { if (this.exMode && !this.exMode.sel.has(ri)) this._extrudeToggle(ri); }); return; } } }
        const hit = this._pick(e);
        if (add && hit) this._toggleSel(hit); else if (!add || !hit) this._select(hit);
      });
      this._on(renderer.domElement, 'pointermove', (e) => {
        if (e.buttons !== 0 || e.pointerType === 'touch') return;
        if (this.faceOn && !this._faceDrag) { this._faceHover(e); return; }
        if (this.edgeMode) { this._edgeHover(e); return; }
        if (this.sk) this._sketchMove(e); else if (this.measureOn) this._measureHover(e); else this._hover(this._pick(e));
      });
      this._on(renderer.domElement, 'pointerleave', () => this._hover(null));
      this._on(renderer.domElement, 'contextmenu', (e) => e.preventDefault());

      this.ro = new ResizeObserver(() => this._resize());
      this.ro.observe(this.viewEl);
      this.disposers.push(() => this.ro.disconnect());
      this.mo = new MutationObserver(() => this._applyTheme());
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
      this.disposers.push(() => this.mo.disconnect());
      this._applyTheme();
      this._resize();
      const loop = () => {
        if (this.destroyed) return;
        this._raf = requestAnimationFrame(loop);
        controls.update();
        if (this.isOrtho) this._orthoFrustum();
        renderer.render(scene, this.camera);
        if ((this.measures && this.measures.length) || this._mLive) this._measureLabels();
        if (this._dimLabels && this._dimLabels.length) this._dimPlace();
      };
      loop();
      this.disposers.push(() => cancelAnimationFrame(this._raf));
    }
    _resize() {
      const w = this.viewEl.clientWidth || 1, h = this.viewEl.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
      if (this.isOrtho) this._orthoFrustum();
    }
    // The ortho view shows what the perspective view would at the target's distance,
    // so zooming (camera distance) works the same in both.
    _orthoFrustum() {
      const c = this.ortho;
      if (c.zoom !== 1) { // touch pinch through OrbitControls changes zoom: fold it into distance
        const off = c.position.clone().sub(this.target); off.setLength(clamp(off.length() / c.zoom, 2, 8000));
        c.position.copy(this.target).add(off); c.zoom = 1;
      }
      const dist = c.position.distanceTo(this.target);
      const hh = dist * Math.tan((this.persp.fov * DEG) / 2);
      const hw = hh * this.persp.aspect;
      if (c.top !== hh || c.right !== hw) { c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh; c.updateProjectionMatrix(); }
    }
    _setOrtho(on) {
      if (!!on === !!this.isOrtho) return;
      const from = this.camera, to = on ? this.ortho : this.persp;
      to.position.copy(from.position); to.quaternion.copy(from.quaternion);
      this.camera = to; this.isOrtho = !!on;
      this.controls.object = to;
      this.tc.camera = to;
      if (on) this._orthoFrustum();
      to.lookAt(this.target);
    }
    _markView(v) {
      this.root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
      if (!v || !String(v).match(/^-?[xyz]$/)) { this._lastAxis = null; this._axisFlip = false; this.root.querySelectorAll('[data-axis]').forEach((x) => { x.classList.remove('on'); x.textContent = x.dataset.axis.toUpperCase(); }); }
    }
    _css(name, fb) { return getComputedStyle(this.root).getPropertyValue(name).trim() || fb; }
    _applyTheme() {
      const T = this.T;
      const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.getAttribute('data-theme'));
      this.dark = dark;
      this.colors = {
        part: new T.Color(dark ? 0xc9d1de : 0xdfe4ec),
        edge: new T.Color(dark ? 0x0d1117 : 0x3a4352),
        accent: new T.Color(this._css('--accent', '#4f6ef7')),
        hole: new T.Color(this._css('--danger', '#f04438')),
        ref: new T.Color(dark ? 0x6ea8ff : 0x2f6fde),
        grid: new T.Color(dark ? 0x2a3140 : 0xd5dae3),
        grid2: new T.Color(dark ? 0x394254 : 0xbfc6d2),
      };
      this._buildGrid();
      this._refreshDesign();
      this._refreshItems();
    }
    _buildGrid(span) {
      const T = this.T;
      this.grid.clear();
      const s = Math.max(200, Math.ceil((span || 200) / 50) * 50 * 2);
      const minor = new T.GridHelper(s, s / 10, this.colors.grid, this.colors.grid);
      const major = new T.GridHelper(s, s / 50, this.colors.grid2, this.colors.grid2);
      [minor, major].forEach((g) => { g.rotation.x = Math.PI / 2; g.material.transparent = true; g.material.opacity = 0.9; g.material.depthWrite = false; this.grid.add(g); });
      const ax = (a, b, c) => { const g = new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]); return new T.Line(g, new T.LineBasicMaterial({ color: c, transparent: true, opacity: 0.6 })); };
      this.grid.add(ax([0, 0, 0.01], [s / 2, 0, 0.01], 0xe5484d), ax([0, 0, 0.01], [0, s / 2, 0.01], 0x30a46c));
      this._gridSpan = s;
    }

    // camera helpers
    _orbit(dx, dy) {
      if (this.isOrtho) { this._setOrtho(false); this._markView(null); }
      const off = this.camera.position.clone().sub(this.target);
      const r = off.length();
      let th = Math.atan2(off.y, off.x); let ph = Math.acos(clamp(off.z / r, -1, 1));
      th -= dx * 0.006; ph = clamp(ph - dy * 0.006, 0.02, Math.PI - 0.02);
      off.set(r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph));
      this.camera.position.copy(this.target).add(off);
      this.camera.lookAt(this.target);
    }
    _pan(dx, dy) {
      const T = this.T;
      const dist = this.camera.position.distanceTo(this.target);
      const k = dist * Math.tan((this.persp.fov * DEG) / 2) * 2 / (this.viewEl.clientHeight || 1);
      const right = new T.Vector3().setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(-dx * k);
      const up = new T.Vector3().setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * k);
      this.camera.position.add(right).add(up); this.target.add(right).add(up);
    }
    _zoom(f, e) {
      const T = this.T;
      f = clamp(f, 0.5, 2);
      const off = this.camera.position.clone().sub(this.target);
      const len = clamp(off.length() * f, 2, 8000);
      // Zoom toward the pointer: move the target a little toward what is under it.
      if (e && f < 1 && e.clientX != null) {
        const hit = this._rayHit(e);
        if (hit) this.target.lerp(hit, 1 - f);
      }
      off.setLength(len);
      this.camera.position.copy(this.target).add(off);
    }
    _ray(e) {
      const T = this.T;
      const r = this.renderer.domElement.getBoundingClientRect();
      const v = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const rc = new T.Raycaster(); rc.setFromCamera(v, this.camera);
      return rc;
    }
    _rayHit(e) {
      const rc = this._ray(e);
      const hits = rc.intersectObjects([...this.designGroup.children, ...this.itemsGroup.children], true).filter((h) => h.object.isMesh);
      return hits.length ? hits[0].point : null;
    }
    _pick(e) {
      const rc = this._ray(e);
      const meshes = []; Object.entries(this.objs).forEach(([id, o]) => { const it = this._item(id); if (!it || it.hidden || !(it.role !== 'hole' || this.showHoles || this._isSel(id))) return; if (o.draft) (o.fills || []).forEach((f) => meshes.push(f)); else meshes.push(o.mesh); });
      const hits = rc.intersectObjects(meshes, false);
      if (!hits.length) return null;
      // Prefer the selected item when hits are (nearly) coincident, so it can be re-grabbed.
      const near = hits.filter((h) => h.distance - hits[0].distance < 0.05);
      const pick = near.find((h) => h.object.userData.id === this.sel) || near.find((h) => this._item(h.object.userData.id).role !== 'hole') || hits[0];
      return pick.object.userData.id;
    }
    _bounds(onlyVisible) {
      const T = this.T;
      const box = new T.Box3();
      this.designGroup.children.forEach((o) => box.expandByObject(o));
      Object.entries(this.objs).forEach(([id, o]) => { const it = this._item(id); if (it && !it.hidden && (!onlyVisible || it.role === 'ref')) box.expandByObject(o.group); });
      return box;
    }
    _fit() {
      const T = this.T;
      const box = this._bounds(true);
      if (box.isEmpty()) { box.set(new T.Vector3(-40, -40, 0), new T.Vector3(40, 40, 40)); }
      const c = box.getCenter(new T.Vector3()); const size = box.getSize(new T.Vector3()).length();
      const dir = this.camera.position.clone().sub(this.target).normalize();
      const dist = (size / 2) / Math.tan((this.persp.fov * DEG) / 2) * 1.25;
      this.target.copy(c);
      this.camera.position.copy(c).add(dir.multiplyScalar(Math.max(dist, 30)));
      this.camera.lookAt(c);
    }
    _view(v) {
      const T = this.T;
      // Top / bottom keep a hair of -Y so "up" on screen stays +Y (camera up is +Z).
      const e = 1e-4;
      const dirs = { iso: [0.75, -1, 0.75], top: [0, -e, 1], bottom: [0, -e, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
        x: [1, 0, 0], '-x': [-1, 0, 0], y: [0, 1, 0], '-y': [0, -1, 0], z: [0, -e, 1], '-z': [0, -e, -1] };
      this._setOrtho(v !== 'iso');
      const d = new T.Vector3(...(dirs[v] || dirs.iso)).normalize();
      const dist = this.camera.position.distanceTo(this.target) || 200;
      this.camera.position.copy(this.target).add(d.multiplyScalar(dist));
      this.camera.lookAt(this.target);
      if (!arguments[1]) this._fit();
      this._markView(v);
    }

    // ---------- items in the scene ----------
    _item(id) { return this.data.items.find((i) => i.id === id); }
    _geom(m) {
      const T = this.T;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(m.vertices, 3));
      g.setIndex(new T.BufferAttribute(m.triangles, 1));
      g.computeVertexNormals();
      return g;
    }
    _refreshDesign() {
      if (!this.T || !this.designGroup) return;
      const T = this.T;
      this.designGroup.children.forEach((o) => o.geometry && o.geometry.dispose());
      this.designGroup.clear();
      if (!this.result) return;
      const g = this._geom(this.result).toNonIndexed(); g.computeVertexNormals(); // triangle i here = triangle i of this.result
      this._faceAdj = null; // result changed: rebuild face adjacency lazily
      const mesh = new T.Mesh(g, new T.MeshStandardMaterial({ color: this.colors.part, roughness: 0.55, metalness: 0.05, flatShading: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      let eg; if (this.result.lines) { eg = new T.BufferGeometry(); eg.setAttribute('position', new T.BufferAttribute(this.result.lines, 3)); } else eg = new T.EdgesGeometry(g, 28);
      const edges = new T.LineSegments(eg, new T.LineBasicMaterial({ color: this.colors.edge, transparent: true, opacity: this.dark ? 0.55 : 0.45 }));
      this.designGroup.add(mesh, edges);
    }
    _refreshItems() {
      if (!this.T || !this.itemsGroup) return;
      const T = this.T;
      const live = new Set(this.data.items.map((i) => i.id));
      // Remove only objects that are gone. A rebuilt shape keeps its scene object
      // (just new geometry): replacing the object mid-drag used to drop it at
      // 0,0,0 and the gizmo jumped to the centre with it.
      for (const [id, o] of Object.entries(this.objs)) if (!live.has(id) || (!o.image && !o.draft && !this.meshes[id]) || (o.draft && !(this._item(id) || {}).draft)) { if (this.tc.object === o.group) this.tc.detach(); this.itemsGroup.remove(o.group); o.mesh.geometry.dispose(); o.edges.geometry.dispose(); delete this.objs[id]; }
      for (const it of this.data.items) {
        if (it.type === 'image') { this._imageObj(it); continue; }
        if (it.type === 'sketch' && it.draft) { this._draftObj(it); continue; }
        const m = this.meshes[it.id];
        if (!m) continue;
        let o = this.objs[it.id];
        if (o && !o.image && o.src !== m) {
          const g = this._geom(m);
          o.mesh.geometry.dispose(); o.edges.geometry.dispose();
          o.mesh.geometry = g; o.edges.geometry = new T.EdgesGeometry(g, 28);
          o.src = m;
        }
        if (!o) {
          const g = this._geom(m);
          // Ghost / highlight: drawn just in front of the model's surface (polygon
          // offset) so a selected solid's tint doesn't flicker against the part.
          const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
          mesh.userData.id = it.id;
          const edges = new T.LineSegments(new T.EdgesGeometry(g, 28), new T.LineBasicMaterial({ transparent: true }));
          const group = new T.Group(); group.rotation.order = 'ZYX'; group.add(mesh, edges); group.userData.id = it.id;
          this.itemsGroup.add(group);
          o = this.objs[it.id] = { group, mesh, edges, src: m };
          this._placeObj(group, it); // a new object always starts where the item is
        }
        if (!(this.dragging && this._isSel(it.id))) this._placeObj(o.group, it);
        this._styleObj(o, it);
      }
      if (this.readOnly || this.edgeMode || this.faceOn || this.cutMode || this.exMode) { if (this.tc.object) this.tc.detach(); }
      else if (this.multi.length) { if (!this.dragging) this._placeProxy(); if (this.tc.object !== this.proxy) this.tc.attach(this.proxy); }
      else if (this.sel && this.objs[this.sel]) { if (this.tc.object !== this.objs[this.sel].group) this.tc.attach(this.objs[this.sel].group); }
      else if (this.tc.object) this.tc.detach();
    }
    // Reference image: a plane on the item's XY, `width` mm wide, aspect from the picture.
    _imageObj(it) {
      const T = this.T;
      let o = this.objs[it.id];
      if (o && o.path !== it.file.path) { this.itemsGroup.remove(o.group); o.mesh.geometry.dispose(); delete this.objs[it.id]; o = null; }
      if (!o) {
        const mesh = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ transparent: true, side: T.DoubleSide, depthWrite: false, color: 0xffffff }));
        mesh.userData.id = it.id;
        mesh.position.z = 0.02;
        const edges = new T.LineSegments(new T.EdgesGeometry(mesh.geometry), new T.LineBasicMaterial({ transparent: true }));
        edges.position.z = 0.02;
        const group = new T.Group(); group.rotation.order = 'ZYX'; group.add(mesh, edges); group.userData.id = it.id; group.userData.image = true;
        this.itemsGroup.add(group);
        o = this.objs[it.id] = { group, mesh, edges, image: true, path: it.file.path, aspect: 1 };
        new T.TextureLoader().load('/api/cad/mesh?path=' + encodeURIComponent(it.file.path), (tex) => {
          tex.colorSpace = T.SRGBColorSpace;
          mesh.material.map = tex; mesh.material.needsUpdate = true;
          o.aspect = tex.image && tex.image.width ? tex.image.height / tex.image.width : 1;
          this._refreshItems();
        }, undefined, () => { this.errors[it.id] = 'Could not load the image ' + it.file.path; this._renderList(); });
      }
      o.group.scale.set(it.width, it.width * o.aspect, 1);
      if (!(this.dragging && this._isSel(it.id))) this._placeObj(o.group, it);
      this._styleObj(o, it);
    }
    // A 2D sketch on its plane: outlines plus a light fill per separate area
    // (areas come from the worker). In Extrude mode the areas are tappable.
    async _sketchRegions(it) {
      const key = JSON.stringify(it.profiles);
      this._regionCache = this._regionCache || new Map();
      if (this._regionCache.has(key)) return this._regionCache.get(key);
      const outlines = it.profiles.map((p) => this._outline(p));
      const id = 'r' + (++this.buildSeq);
      const regions = await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ type: 'regions', id, outlines }); });
      this._regionCache.set(key, regions);
      return regions;
    }
    _draftObj(it) {
      const T = this.T;
      let o = this.objs[it.id];
      const key = JSON.stringify(it.profiles) + '|' + (this.exMode && this.exMode.id === it.id ? [...this.exMode.sel].join(',') : '') + '|' + this._isSel(it.id) + '|' + (this.hov === it.id);
      if (!o) {
        const group = new T.Group(); group.rotation.order = 'ZYX'; group.userData.id = it.id;
        this.itemsGroup.add(group);
        // an invisible pick target covering the sketch, so it can be tapped / selected
        const mesh = new T.Mesh(new T.BufferGeometry(), new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide }));
        mesh.userData.id = it.id;
        const edges = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ transparent: true, depthTest: false }));
        edges.renderOrder = 11;
        group.add(mesh, edges);
        o = this.objs[it.id] = { group, mesh, edges, draft: true, key: null, fills: [] };
      }
      this._placeObj(o.group, it);
      o.group.visible = !it.hidden;
      if (o.key === key) return;
      o.key = key;
      const sel = this._isSel(it.id) || (this.exMode && this.exMode.id === it.id), hov = this.hov === it.id;
      // outlines
      const segs = [];
      for (const p of it.profiles) { const ol = this._outline(p); for (let i = 0; i < ol.length; i++) { const a = ol[i], b = ol[(i + 1) % ol.length]; segs.push(a[0], a[1], 0.03, b[0], b[1], 0.03); } }
      o.edges.geometry.dispose(); o.edges.geometry = new T.BufferGeometry(); o.edges.geometry.setAttribute('position', new T.Float32BufferAttribute(segs, 3));
      o.edges.material.color.copy(sel || hov ? this.colors.accent : this.colors.edge); o.edges.material.opacity = sel || hov ? 1 : 0.8; o.edges.material.needsUpdate = true;
      // areas (async): light fills; in Extrude mode, picked areas are strong
      this._sketchRegions(it).then((regions) => {
        if (!this.objs[it.id] || this.objs[it.id] !== o) return;
        o.fills.forEach((f) => { o.group.remove(f); f.geometry.dispose(); }); o.fills = [];
        o.regions = regions;
        const geoms = [];
        regions.forEach((r, ri) => {
          const outer = r.polys.filter((poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a > 0; });
          const holes = r.polys.filter((poly) => !outer.includes(poly));
          for (const ob of outer) {
            const sh = new T.Shape(ob.map((q) => new T.Vector2(q[0], q[1])));
            holes.forEach((h) => sh.holes.push(new T.Path(h.map((q) => new T.Vector2(q[0], q[1])))));
            const g = new T.ShapeGeometry(sh); geoms.push(g);
            const picked = this.exMode && this.exMode.id === it.id && this.exMode.sel.has(ri);
            const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: picked ? this.colors.accent : this.colors.ref, transparent: true, opacity: picked ? 0.55 : sel ? 0.22 : 0.12, side: T.DoubleSide, depthWrite: false }));
            m.position.z = 0.02; m.renderOrder = 9; m.userData.id = it.id; m.userData.region = ri;
            o.group.add(m); o.fills.push(m);
          }
        });
        // pick target = all areas together
        if (geoms.length) { o.mesh.geometry.dispose(); o.mesh.geometry = geoms[0].clone(); for (let i = 1; i < geoms.length; i++) { /* the picker uses the fills directly */ } }
      });
    }
    _placeObj(g, it) {
      g.position.set(it.pos[0], it.pos[1], it.pos[2]); g.rotation.set(it.rot[0] * DEG, it.rot[1] * DEG, it.rot[2] * DEG, 'ZYX');
      if (!g.userData.image) { const f = it.flip || []; g.scale.set(f[0] ? -1 : 1, f[1] ? -1 : 1, f[2] ? -1 : 1); }
    }
    _styleObj(o, it) {
      if (o.draft) return;
      const sel = this._isSel(it.id), hov = it.id === this.hov && !sel;
      const mm = o.mesh.material, em = o.edges.material;
      o.group.visible = !it.hidden;
      let color = this.colors.accent, op = 0, eop = 0;
      if (it.type === 'image') {
        mm.opacity = it.opacity; mm.colorWrite = true; mm.needsUpdate = true;
        em.color.copy(this.colors.accent); em.opacity = sel || hov ? 1 : 0; em.visible = sel || hov;
        o.group.visible = !it.hidden;
        return;
      }
      // Unselected: references blue, holes red (when shown), solids invisible (the part shows them).
      if (it.role === 'ref') { color = this.colors.ref; op = 0.18; eop = 0.35; }
      else if (it.role === 'hole') { color = this.colors.hole; op = this.showHoles ? 0.12 : 0; eop = this.showHoles ? 0.45 : 0; }
      // Selected: a clear accent tint plus a full-strength outline drawn through other parts.
      if (sel) { color = this.colors.accent; op = 0.38; eop = 1; }
      else if (hov) { color = this.colors.accent; op = Math.max(op, 0.16); eop = 0.8; }
      if (this.errors[it.id] && !sel) { color = this.colors.hole; eop = Math.max(eop, 0.6); }
      mm.color.copy(color); mm.opacity = op; mm.colorWrite = op > 0; mm.needsUpdate = true;
      em.color.copy(sel || hov ? this.colors.accent : color); em.opacity = eop; em.visible = eop > 0;
      em.depthTest = !sel; // a selected outline stays visible even behind other geometry
      o.edges.renderOrder = sel ? 5 : 0;
      em.needsUpdate = true;
    }
    _hover(id) { if (id === this.hov) return; const prev = this.hov; this.hov = id; [prev, id].forEach((x) => { const o = x && this.objs[x]; if (o && o.draft) o.key = null; }); this.renderer.domElement.style.cursor = id ? 'pointer' : ''; this._refreshItems(); }

    // ---------- selection & gizmo ----------
    _isSel(id) { return id === this.sel || this.multi.includes(id); }
    _selIds() { return this.multi.length ? this.multi.slice() : this.sel ? [this.sel] : []; }
    // Combined objects (items sharing `group`) are picked as a whole; `part`
    // selects one part of it on purpose (from the combined object's panel).
    _gid(id) { const it = this._item(id); return (it && it.group) || ''; }
    _members(gid) { return gid ? this.data.items.filter((it) => it.group === gid).map((it) => it.id) : []; }
    _expand(ids) { const out = []; ids.forEach((id) => { const g = this._gid(id); (g ? this._members(g) : [id]).forEach((x) => { if (!out.includes(x)) out.push(x); }); }); return out; }
    // The one combined object that is exactly the current selection, if any.
    _soleGroup() {
      const ids = this._selIds(); if (ids.length < 2) return '';
      const g = this._gid(ids[0]); if (!g) return '';
      const mem = this._members(g);
      return ids.every((id) => this._gid(id) === g) && mem.length === ids.length ? g : '';
    }
    _select(id, part) {
      setTimeout(() => this._dimUpdate(), 0);
      Object.values(this.objs).forEach((o) => { if (o.draft) o.key = null; });
      if (this.edgeMode && id !== this.edgeMode.id) { const em = this.edgeMode; this.edgeMode = null; this.root.classList.remove('cad-edging'); if (this._edgeObj) { this._edgeObj.parent && this._edgeObj.parent.remove(this._edgeObj); this._edgeObj = null; } void em; }
      if (id && !part && this._gid(id)) { this._setSel(this._members(this._gid(id))); return; }
      if (this.codeOv && this.codeOv.id !== id) this._codeClose();
      this.sel = id && this._item(id) ? id : null;
      this.multi = [];
      this._refreshItems();
      this._renderChrome();
    }
    // Shift / Cmd-click or Multi mode: add or remove one object.
    _toggleSel(id) {
      if (!this._item(id)) return;
      const ids = this._selIds();
      const unit = this._expand([id]);
      if (unit.every((x) => ids.includes(x))) this._setSel(ids.filter((x) => !unit.includes(x)));
      else this._setSel(ids.concat(unit.filter((x) => !ids.includes(x))));
    }
    _setSel(ids, exact) {
      setTimeout(() => this._dimUpdate(), 0);
      Object.values(this.objs).forEach((o) => { if (o.draft) o.key = null; });
      ids = (exact ? ids : this._expand(ids)).filter((id) => this._item(id));
      this.sel = ids.length === 1 ? ids[0] : null;
      this.multi = ids.length > 1 ? ids : [];
      this._refreshItems();
      this._renderChrome();
    }
    _selectAll() {
      const ids = this.data.items.filter((it) => !it.hidden).map((it) => it.id);
      if (!ids.length) return;
      this._setSel(ids);
      if (this.listEl) this.listEl.classList.remove('collapsed');
    }
    // World-space bounds of objects (precise, after rotation).
    _boundsOf(ids, fast) {
      const T = this.T; const b = new T.Box3();
      for (const id of ids) { const o = this.objs[id]; if (!o) continue; o.group.updateMatrixWorld(true); b.union(new T.Box3().setFromObject(o.mesh, !fast)); }
      return b;
    }
    // The gizmo for a multi-selection drives this pivot at the selection's centre.
    _placeProxy() {
      const T = this.T;
      if (!this.proxy) { this.proxy = new T.Object3D(); this.proxy.rotation.order = 'ZYX'; this.scene.add(this.proxy); }
      const b = this._boundsOf(this.multi);
      const c = b.isEmpty() ? new T.Vector3() : b.getCenter(new T.Vector3());
      this.proxy.position.copy(c); this.proxy.rotation.set(0, 0, 0); this.proxy.scale.set(1, 1, 1);
      this.proxy.updateMatrixWorld(true);
    }
    _multiDragStart() {
      const T = this.T;
      this.proxy.updateMatrixWorld(true);
      this._mStart = { inv: this.proxy.matrixWorld.clone().invert(), items: this.multi.map((id) => {
        const it = this._item(id); const tmp = new T.Object3D(); tmp.rotation.order = 'ZYX'; this._placeObj(tmp, it); tmp.updateMatrixWorld(true);
        return { id, m: tmp.matrixWorld.clone() };
      }) };
    }
    // New placement of each object = (pivot motion) × (its start placement).
    _multiDragApply(final) {
      const T = this.T; const st = this._mStart; if (!st) return;
      if (this.tc.mode === 'scale') { this._multiScaleApply(final); return; }
      this.proxy.updateMatrixWorld(true);
      const delta = this.proxy.matrixWorld.clone().multiply(st.inv);
      const pos = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3(), eu = new T.Euler();
      for (const s0 of st.items) {
        const it = this._item(s0.id); if (!it) continue;
        const f = it.flip || []; const F = new T.Matrix4().makeScale(f[0] ? -1 : 1, f[1] ? -1 : 1, f[2] ? -1 : 1);
        new T.Matrix4().multiplyMatrices(delta, s0.m).multiply(F).decompose(pos, q, sc);
        eu.setFromQuaternion(q, 'ZYX');
        it.pos = [r3(pos.x), r3(pos.y), r3(pos.z)];
        it.rot = [r3(eu.x / DEG), r3(eu.y / DEG), r3(eu.z / DEG)].map((v) => (Math.abs(v) < 1e-6 ? 0 : v));
        const o = this.objs[s0.id]; if (o) this._placeObj(o.group, it);
      }
      this._renderDims(); this._dimUpdate(!final);
      if (final) { this._mStart = null; this._changed(); this._requestBuild(); this._placeProxy(); } else this._requestBuild(true);
    }
    // Mirror the selection across a plane through its centre (axis 0/1/2 = X/Y/Z):
    // makes mirror-image copies. World mirror M of T·R·F is T'·(M R M)·(M F):
    // the position reflects, two Euler angles change sign, and the item's own
    // flip on that axis toggles.
    _mirror(axis) {
      const ids = this._selIds(); if (!ids.length || this.readOnly) return;
      // Across the whole design's centre (e.g. a button on the front → the back),
      // or around the selection itself when "around itself" is ticked.
      const all = this.data.items.filter((x) => !x.hidden && x.role !== 'ref' && x.type !== 'image').map((x) => x.id);
      const self = true; // Flip: around itself, in place
      const b = this._boundsOf(self || !all.length ? ids : all); if (b.isEmpty()) return;
      const c = b.getCenter(new this.T.Vector3()).getComponent(axis);
      const sign = [[1, -1, -1], [-1, 1, -1], [-1, -1, 1]][axis];
      const mirrored = (src) => ({
        pos: src.pos.map((v, i) => (i === axis ? r3(2 * c - v) : v)),
        rot: src.rot.map((v, i) => r3(v * sign[i]) || 0),
        flip: [0, 1, 2].map((i) => !!(src.flip && src.flip[i]) !== (i === axis)),
      });
      if (false) {
        this._copies(ids, (src) => [Object.assign(JSON.parse(JSON.stringify(src)), mirrored(src), { name: src.name.replace(/ \d+$/, '') + ' mirror' })], 'Mirrored copy added');
        return;
      }
      this._editMany(ids, (it) => Object.assign(it, mirrored(it)));
      this._toast('Flipped ' + 'XYZ'[axis], 'ok');
    }
    // Mirror = "the same on the other side". A feature (hole, slot, small solid on a
    // part) is copied to the other side of the part it sits on. A part itself gets
    // its cuts, holes and features reflected across its own centre (symmetric).
    _symMirror(axis) {
      const ids = this._selIds(); if (!ids.length || this.readOnly) return;
      const T = this.T;
      const vol = (b) => { const s3 = b.getSize(new T.Vector3()); return s3.x * s3.y * s3.z; };
      const solids = this.data.items.filter((x) => x.role === 'solid' && !x.hidden && x.type !== 'image');
      const hostOf = (id) => { const b = this._boundsOf([id]); let best = null, bv = vol(b) * 1.0001; for (const h of solids) { if (ids.includes(h.id)) continue; const hb = this._boundsOf([h.id]); if (hb.isEmpty() || !hb.intersectsBox(b)) continue; const v = vol(hb); if (v > bv) { best = h; bv = v; } } return best; };
      const sign = [[1, -1, -1], [-1, 1, -1], [-1, -1, 1]][axis];
      const mirrorItem = (src, c) => C.normalizeItem(Object.assign(JSON.parse(JSON.stringify(src)), {
        id: C.uid('i_'), name: this._uniqueName(src.name.replace(/ \d+$/, '').replace(/ mirror$/, '') + ' mirror'),
        pos: src.pos.map((v, i) => (i === axis ? r3(2 * c - v) : v)), rot: src.rot.map((v, i) => r3(v * sign[i]) || 0),
        flip: [0, 1, 2].map((i) => !!(src.flip && src.flip[i]) !== (i === axis)),
      }));
      const sameSpot = (a, b) => a.type === b.type && a.pos.every((v, i) => Math.abs(v - b.pos[i]) < 1e-3) && a.rot.every((v, i) => Math.abs(v - b.rot[i]) < 1e-3) && JSON.stringify(a.flip || null) === JSON.stringify(b.flip || null);
      this._snapshot();
      const made = []; let cutsAdded = 0;
      const addCopy = (src, c) => { const m = mirrorItem(src, c); if (!this.data.items.some((x) => x.id !== src.id && sameSpot(x, m)) && !sameSpot(src, m)) { delete m.group; this.data.items.push(m); made.push(m.id); } };
      for (const id of ids) {
        const it = this._item(id); if (!it) continue;
        const host = it.role === 'solid' ? hostOf(id) : hostOf(id) || null;
        if (host || it.role === 'hole') {
          const hb = this._boundsOf([(host || it).id]); addCopy(it, hb.getCenter(new T.Vector3()).getComponent(axis));
          continue;
        }
        // a part: reflect what belongs to it across its own centre
        const b = this._boundsOf([id]); const c = b.getCenter(new T.Vector3()).getComponent(axis);
        const Wm = new T.Matrix4().makeTranslation(...[0, 1, 2].map((i) => (i === axis ? c : 0))).multiply(new T.Matrix4().makeScale(...[0, 1, 2].map((i) => (i === axis ? -1 : 1)))).multiply(new T.Matrix4().makeTranslation(...[0, 1, 2].map((i) => (i === axis ? -c : 0))));
        const M = this._placeMatrix(it); const Minv = M.clone().invert();
        const cuts = (it.cuts || []).slice();
        for (const cut of it.cuts || []) {
          const world = M.clone().multiply(new T.Matrix4().fromArray(cut.m));
          const m2 = Array.from(Minv.clone().multiply(Wm.clone().multiply(world)).elements).map((v) => Math.round(v * 1e9) / 1e9);
          if (!cuts.some((x) => x.keep === cut.keep && x.m.every((v, i) => Math.abs(v - m2[i]) < 1e-4))) { cuts.push({ keep: cut.keep, m: m2, shape: cut.shape }); cutsAdded++; }
        }
        if (cuts.length !== (it.cuts || []).length) { it.cuts = cuts; Object.assign(it, C.normalizeItem(it)); }
        // holes and smaller solids sitting on this part
        for (const f of this.data.items.slice()) {
          if (f.id === id || ids.includes(f.id) || f.hidden || f.type === 'image' || f.role === 'ref') continue;
          const fb = this._boundsOf([f.id]); if (fb.isEmpty() || !fb.intersectsBox(b)) continue;
          if (f.role === 'solid' && vol(fb) >= vol(b)) continue;
          addCopy(f, c);
        }
      }
      if (!made.length && !cutsAdded) { this.undoStack.pop(); this._toast('Already symmetric — nothing to mirror on ' + 'XYZ'[axis], 'ok'); return; }
      this._tidyGroups(); this._commit(); this._refreshItems();
      this._toast('Mirrored ' + 'XYZ'[axis] + ': ' + [made.length ? made.length + ' feature' + (made.length > 1 ? 's' : '') : '', cutsAdded ? cutsAdded + ' cut' + (cutsAdded > 1 ? 's' : '') : ''].filter(Boolean).join(' + ') + ' added on the other side', 'ok');
    }
    // Linear: n−1 copies stepping by (dx, dy, dz). Circular: n copies spread over
    // `angle` degrees around a vertical axis through (cx, cy).
    _pattern(o) {
      const ids = this._selIds(); if (!ids.length || this.readOnly) return;
      const n = Math.max(2, Math.min(100, Math.round(o.n || 2)));
      const make = (src) => {
        const out = [];
        for (let k = 1; k < n; k++) {
          const c = JSON.parse(JSON.stringify(src));
          if (o.kind === 'circular') {
            const step = (o.angle >= 360 ? 360 / n : o.angle / (n - 1)) * k;
            const t = step * DEG, dx = src.pos[0] - o.cx, dy = src.pos[1] - o.cy;
            c.pos = [r3(o.cx + dx * Math.cos(t) - dy * Math.sin(t)), r3(o.cy + dx * Math.sin(t) + dy * Math.cos(t)), src.pos[2]];
            c.rot = [src.rot[0], src.rot[1], r3((((src.rot[2] + step) % 360) + 540) % 360 - 180)];
          } else c.pos = src.pos.map((v, i) => r3(v + [o.dx, o.dy, o.dz][i] * k));
          out.push(c);
        }
        return out;
      };
      this._copies(ids, make, (n - 1) + ' cop' + (n === 2 ? 'y' : 'ies') + ' added');
    }
    // Adds copies made by `make(src) → [items]`; a copied combined object gets its own new group.
    _copies(ids, make, msg) {
      if (this._skipSnap) this._skipSnap = false; else this._snapshot();
      const made = []; const newGid = {};
      for (const id of ids) {
        const src = this._item(id); if (!src) continue;
        make(src).forEach((c, k) => {
          c.id = C.uid('i_');
          // keep a name the copy was given (e.g. "… mirror", "… piece"); plain copies get "Name 2"
          c.name = this._uniqueName(c.name !== src.name ? c.name : src.name.replace(/ \d+$/, ''));
          if (src.group) {
            const key = src.group + '#' + k;
            if (!newGid[key]) { newGid[key] = C.uid('g_'); this.data.groups[newGid[key]] = { name: ((this.data.groups[src.group] || {}).name || 'Combined') + ' copy' }; }
            c.group = newGid[key];
          }
          const ni = C.normalizeItem(c); this.data.items.push(ni); made.push(ni.id);
        });
      }
      this._tidyGroups();
      this._commit(); this._setSel(made);
      if (msg) this._toast(msg, 'ok');
    }
    // ---------- split other objects with a shape ----------
    // Every Solid this shape overlaps becomes two objects: the outside (with the
    // shape's hole) and the inside (the plug). Both remember the cutter relative
    // to themselves, so they fit exactly and stay right when moved.
    // Holes that cut these objects become part of them (as cuts relative to each
    // object), so a piece keeps its holes when it is moved after a split. Holes
    // that cut nothing else are then removed.
    _bakeHoles(targetIds) {
      const holes = this.data.items.filter((h) => h.role === 'hole' && !h.hidden && h.type !== 'image');
      const used = new Set();
      for (const id of targetIds) {
        const it = this._item(id); if (!it) continue;
        const tb = this._boundsOf([id]); if (tb.isEmpty()) continue;
        const Mt = this._placeMatrix(it).invert();
        for (const h of holes) {
          const hb = this._boundsOf([h.id]); if (hb.isEmpty() || !hb.intersectsBox(tb)) continue;
          const shape = JSON.parse(JSON.stringify(h)); ['id', 'name', 'pos', 'rot', 'hidden', 'group', 'flip', 'cuts'].forEach((k) => delete shape[k]);
          shape.role = 'hole';
          const m = Array.from(Mt.clone().multiply(this._placeMatrix(h)).elements).map((v) => Math.round(v * 1e9) / 1e9);
          it.cuts = (it.cuts || []).concat([{ keep: 'outside', m, shape }]);
          used.add(h.id);
        }
      }
      // a baked hole that still overlaps some other solid stays as a hole
      const others = this.data.items.filter((x) => x.role === 'solid' && !x.hidden && !targetIds.includes(x.id));
      const drop = [...used].filter((hid) => { const hb = this._boundsOf([hid]); return !others.some((o) => { const ob = this._boundsOf([o.id]); return !ob.isEmpty() && ob.intersectsBox(hb); }); });
      this.data.items = this.data.items.filter((x) => !drop.includes(x.id));
      return drop.length;
    }
    _separate(id, noUndo) {
      const it = this._item(id); const n = this.pieces && this.pieces[id];
      if (!it || !(n > 1) || this.readOnly) return [];
      if (!noUndo) this._snapshot();
      const made = [];
      const base = it.name.replace(/ part \d+$/, '');
      for (let k = 1; k < n; k++) {
        const c = C.normalizeItem(Object.assign(JSON.parse(JSON.stringify(it)), { id: C.uid('i_'), name: this._uniqueName(base + ' part ' + (k + 1)), piece: { k, n } }));
        if (it.group) delete c.group; // separated pieces are their own objects
        this.data.items.push(c); made.push(c.id);
      }
      it.piece = { k: 0, n }; it.name = this._uniqueName(base + ' part 1'); if (it.group) delete it.group;
      Object.assign(it, C.normalizeItem(it));
      this._tidyGroups();
      if (!noUndo) { this._commit(); this._refreshItems(); this._setSel([id].concat(made)); this._toast('Separated into ' + n + ' objects', 'ok'); }
      return [id].concat(made);
    }
    // After a split: objects that came out in several chunks become one object per chunk
    // (part of the same undo step as the split).
    _autoSeparate(ids) {
      this._afterBuild(() => {
        let all = [];
        ids.forEach((id) => { if (this.pieces && this.pieces[id] > 1) all = all.concat(this._separate(id, true)); });
        if (all.length) { this._commit(); this._refreshItems(); this._toast('Some parts came apart — each separate piece is now its own object', 'ok'); }
      });
    }
    // Extrude areas of a 2D sketch: tap areas (or All), set a distance (− = into the
    // face), choose New object / Cut / Split. The sketch stays for later use.
    async _extrudeStart(id) {
      const it = this._item(id); if (!it || !it.draft || this.readOnly) return;
      const regions = await this._sketchRegions(it);
      if (!regions.length) { this._toast('This sketch has no closed areas to extrude', 'err'); return; }
      this.exMode = { id, sel: new Set(regions.length === 1 ? [0] : []), dist: this._exDist || 5, op: this._exOp || 'new', regions };
      if (this.tc.object) this.tc.detach();
      const o = this.objs[id]; if (o) o.key = null; this._refreshItems();
      this._renderExtrudePanel();
    }
    _extrudeEnd() {
      if (!this.exMode) return; const id = this.exMode.id; this.exMode = null;
      const o = this.objs[id]; if (o) o.key = null; this._inspFor = null; this._select(id);
    }
    _extrudeToggle(ri) { const ex = this.exMode; if (!ex) return; if (ex.sel.has(ri)) ex.sel.delete(ri); else ex.sel.add(ri); const o = this.objs[ex.id]; if (o) o.key = null; this._refreshItems(); this._renderExtrudePanel(); }
    _renderExtrudePanel() {
      const ex = this.exMode; const el = this.inspEl; if (!ex) return;
      this._inspFor = 'extrude'; el.classList.remove('hidden');
      const n = ex.regions.length, k = ex.sel.size;
      el.innerHTML = `
        <div class="cad-insp-head"><div class="cad-name">Extrude</div><button type="button" class="cad-icon-btn" data-exx title="Cancel (Esc)">✕</button></div>
        <p class="cad-hint">Tap areas of the sketch to pick them${n > 1 ? ' — overlaps are separate areas' : ''}.</p>
        <p class="cad-combo-tag"><b>${k}</b> of ${n} area${n > 1 ? 's' : ''} picked · <a href="#" data-exall>${k === n ? 'none' : 'all'}</a></p>
        <div class="cad-grid"><label class="cad-field wide"><span class="cad-scrub">Distance</span><input type="text" inputmode="decimal" data-exdist value="${ex.dist}"><em>mm</em></label></div>
        <p class="cad-hint">− goes the other way (into the face it was drawn on).</p>
        <div class="cad-seg2 cad-seg3">${[['new', 'New object'], ['cut', 'Cut'], ['split', 'Split']].map(([v, t]) => `<button type="button" data-exop="${v}" class="${ex.op === v ? 'on' : ''}" title="${v === 'new' ? 'A new solid object' : v === 'cut' ? 'Cut it out of whatever it passes through' : 'Divide what it passes through into the part inside and outside (no gap)'}">${t}</button>`).join('')}</div>
        <button type="button" class="cad-wide-btn cad-combine" data-exgo ${k ? '' : 'disabled'}>Extrude ${k ? k + ' area' + (k > 1 ? 's' : '') : ''}</button>`;
      el.querySelector('[data-exx]').onclick = () => this._extrudeEnd();
      el.querySelector('[data-exall]').onclick = (e) => { e.preventDefault(); ex.sel = k === n ? new Set() : new Set(ex.regions.map((_, i) => i)); const o = this.objs[ex.id]; if (o) o.key = null; this._refreshItems(); this._renderExtrudePanel(); };
      const inp = el.querySelector('[data-exdist]');
      inp.onchange = () => { const v = evalNum(inp.value, ex.dist); if (Math.abs(v) >= 0.05) ex.dist = this._exDist = r3(v); inp.value = ex.dist; };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { inp.dispatchEvent(new Event('change')); el.querySelector('[data-exgo]').click(); } };
      el.querySelectorAll('[data-exop]').forEach((b) => { b.onclick = () => { ex.op = this._exOp = b.dataset.exop; this._renderExtrudePanel(); }; });
      el.querySelector('[data-exgo]').onclick = () => { inp.dispatchEvent(new Event('change')); this._extrudeApply(); };
    }
    _extrudeApply() {
      const ex = this.exMode; if (!ex || !ex.sel.size) return;
      const sk = this._item(ex.id); if (!sk) return;
      const area = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
      const profiles = [];
      [...ex.sel].sort((a, b) => a - b).forEach((ri) => { (ex.regions[ri] || { polys: [] }).polys.forEach((poly) => profiles.push(area(poly) >= 0 ? { k: 'poly', pts: poly } : { k: 'poly', pts: poly, cut: true })); });
      this._snapshot();
      const shape = C.newItem('sketch', { name: this._uniqueName(ex.op === 'cut' ? 'Cut' : ex.op === 'split' ? 'Splitter' : 'Extrude'), pos: sk.pos.slice(), rot: sk.rot.slice(), flip: sk.flip, height: ex.dist, profiles, role: ex.op === 'cut' ? 'hole' : 'solid' });
      this.data.items.push(shape);
      const op = ex.op; this.exMode = null;
      const o = this.objs[ex.id]; if (o) o.key = null;
      this._inspFor = null;
      if (op === 'split') {
        this._commit(); this._refreshItems(); this._select(shape.id);
        this._afterBuild(() => { this.undoStack.pop(); this._splitWith(shape.id); }); // one undo step for extrude + split
        this._requestBuild();
        return;
      }
      this._commit(); this._refreshItems(); this._select(shape.id);
      this._toast(op === 'cut' ? 'Cut extruded ' + Math.abs(ex.dist) + ' mm' : 'Extruded ' + Math.abs(ex.dist) + ' mm — the sketch stays for more', 'ok');
    }
    _placeMatrix(it) {
      const T = this.T; const o = new T.Object3D(); o.rotation.order = 'ZYX'; this._placeObj(o, it); o.updateMatrixWorld(true);
      return o.matrixWorld.clone();
    }
    _splitWith(cutterId) {
      const cutter = this._item(cutterId); if (!cutter || this.readOnly) return;
      const cb = this._boundsOf([cutterId]); if (cb.isEmpty()) return;
      const targets = this.data.items.filter((x) => x.id !== cutterId && x.role === 'solid' && !x.hidden && x.type !== 'image' && (() => { const b = this._boundsOf([x.id]); return !b.isEmpty() && b.intersectsBox(cb); })()).map((x) => x.id);
      if (!targets.length) { this._toast('This shape doesn\'t overlap any Solid object — move it into the part you want to split', 'err'); return; }
      const shape = JSON.parse(JSON.stringify(cutter));
      ['id', 'name', 'pos', 'rot', 'hidden', 'group', 'flip', 'role', 'cuts'].forEach((k) => delete shape[k]);
      this._snapshot(); this._bakeHoles(targets); this._skipSnap = true;
      const Mc = this._placeMatrix(cutter);
      const rel = (t) => Array.from(this._placeMatrix(t).clone().invert().multiply(Mc).elements).map((v) => Math.round(v * 1e9) / 1e9);
      this._copies(targets, (src) => [Object.assign(JSON.parse(JSON.stringify(src)), { name: src.name.replace(/ \d+$/, '') + ' piece', cuts: (src.cuts || []).concat([{ keep: 'inside', m: rel(src), shape }]) })], null);
      const pieces = this._selIds();
      targets.forEach((id) => { const it = this._item(id); it.cuts = (it.cuts || []).concat([{ keep: 'outside', m: rel(it), shape }]); Object.assign(it, C.normalizeItem(it)); });
      pieces.forEach((id) => { const it = this._item(id); Object.assign(it, C.normalizeItem(it)); });
      this.data.items = this.data.items.filter((x) => x.id !== cutterId);
      this._tidyGroups();
      this._commit(); this._refreshItems(); this._setSel(pieces);
      this._toast('Split ' + targets.length + ' object' + (targets.length > 1 ? 's' : '') + ' — the inside piece is selected; move it out', 'ok');
      this._autoSeparate(targets.concat(pieces));
    }

    // ---------- cut with a plane ----------
    _cutStart() {
      const ids = this._selIds().filter((id) => { const it = this._item(id); return it && it.type !== 'image'; });
      if (!ids.length || this.readOnly) return;
      const b = this._boundsOf(ids); if (b.isEmpty()) return;
      const c = b.getCenter(new this.T.Vector3());
      this.cutMode = { ids, on: new Set(ids.filter((id) => (this._item(id) || {}).role === 'solid')), axis: this._cutAxis == null ? 2 : this._cutAxis, at: 0, box: b, center: c };
      this._cutShowSel();
      this.cutMode.at = r3(c.getComponent(this.cutMode.axis));
      if (this.tc.object) this.tc.detach();
      this._cutPreview(); this._renderCutPanel();
    }
    _cutEnd() {
      if (!this.cutMode) return;
      const ids = this.cutMode.ids; this.cutMode = null;
      if (this._cutPlane) { this.scene.remove(this._cutPlane); this._cutPlane.traverse((o) => o.geometry && o.geometry.dispose()); this._cutPlane = null; }
      this._inspFor = null; this._setSel(ids.filter((id) => this._item(id)));
    }
    // Chosen objects are highlighted like a selection; bounds follow the choice.
    _cutShowSel() {
      const cm = this.cutMode; if (!cm) return;
      const on = [...cm.on].filter((id) => this._item(id));
      this.sel = on.length === 1 ? on[0] : null; this.multi = on.length > 1 ? on : [];
      const b = this._boundsOf(on.length ? on : cm.ids);
      if (!b.isEmpty()) { cm.box = b; cm.center = b.getCenter(new this.T.Vector3()); }
      this._refreshItems();
    }
    _cutToggle(id) {
      const cm = this.cutMode; const it = this._item(id); if (!cm || !it) return;
      const unit = this._expand([id]);
      const turnOn = !unit.every((x) => cm.on.has(x));
      unit.forEach((x) => { if (!cm.ids.includes(x)) cm.ids.push(x); if (turnOn && (this._item(x) || {}).role === 'solid') cm.on.add(x); else cm.on.delete(x); });
      if (turnOn && !unit.some((x) => (this._item(x) || {}).role === 'solid')) this._toast('Only Solid objects can be cut', 'err');
      this._cutShowSel(); this._cutPreview(); this._renderCutPanel();
    }
    _cutPreview() {
      const T = this.T; const cm = this.cutMode; if (!cm) return;
      if (this._cutPlane) { this.scene.remove(this._cutPlane); this._cutPlane.traverse((o) => o.geometry && o.geometry.dispose()); }
      const sz = cm.box.getSize(new T.Vector3()); const pad = 1.25;
      const dims = [[sz.y, sz.z], [sz.x, sz.z], [sz.x, sz.y]][cm.axis].map((v) => Math.max(5, v * pad));
      const g = new T.PlaneGeometry(dims[0], dims[1]);
      const grp = new T.Group();
      const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: this.colors.hole, transparent: true, opacity: 0.22, side: T.DoubleSide, depthWrite: false }));
      const e = new T.LineSegments(new T.EdgesGeometry(g), new T.LineBasicMaterial({ color: this.colors.hole, depthTest: false, transparent: true }));
      m.renderOrder = 7; e.renderOrder = 8; grp.add(m, e);
      // the plane faces along the chosen axis
      if (cm.axis === 0) grp.rotation.set(0, Math.PI / 2, 0);
      else if (cm.axis === 1) grp.rotation.set(Math.PI / 2, 0, 0);
      const p = cm.center.clone(); p.setComponent(cm.axis, cm.at); grp.position.copy(p);
      this.scene.add(grp); this._cutPlane = grp;
    }
    _renderCutPanel() {
      const cm = this.cutMode; const el = this.inspEl; if (!cm) return;
      this._inspFor = 'cut'; el.classList.remove('hidden');
      const lo = r3(cm.box.min.getComponent(cm.axis)), hi = r3(cm.box.max.getComponent(cm.axis));
      const AX = 'XYZ'[cm.axis];
      const sideName = [['Right (+X)', 'Left (−X)'], ['Back (+Y)', 'Front (−Y)'], ['Top (+Z)', 'Bottom (−Z)']][cm.axis];
      el.innerHTML = `
        <div class="cad-insp-head"><div class="cad-name">Cut ${cm.ids.length > 1 ? cm.ids.length + ' objects' : esc((this._item(cm.ids[0]) || {}).name || '')}</div><button type="button" class="cad-icon-btn" data-cutx title="Cancel (Esc)">✕</button></div>
        <div class="cad-sec-t">Objects to cut</div>
        <div class="cad-sel-list cad-cutlist">${cm.ids.map((id) => this._item(id)).filter(Boolean).map((x) => `<button type="button" data-cuton="${esc(x.id)}" class="${cm.on.has(x.id) ? 'on' : ''}" ${x.role !== 'solid' ? 'disabled title="Only Solid objects can be cut"' : 'title="Tap to include / leave out"'}><span class="cad-dot ${x.role}"></span>${esc(x.name)}</button>`).join('')}</div>
        <p class="cad-hint">Tap objects here or in the view to choose which are cut (${cm.on.size} chosen).</p>
        <div class="cad-sec-t">Plane across</div>
        <div class="cad-seg2 cad-seg3">${['X', 'Y', 'Z'].map((a, i) => `<button type="button" data-cutaxis="${i}" class="${cm.axis === i ? 'on' : ''}">${a}</button>`).join('')}</div>
        <div class="cad-grid"><label class="cad-field wide"><span class="cad-scrub" data-cutscrub>${AX} at</span><input type="text" inputmode="decimal" data-cutat value="${cm.at}"><em>mm</em></label></div>
        <p class="cad-hint">The selection spans ${AX} ${lo} → ${hi}. The red plane shows the cut.</p>
        <div class="cad-quick"><button type="button" data-cutmid>Middle</button><button type="button" data-cutstep="-1">−1</button><button type="button" data-cutstep="1">+1</button></div>
        <div class="cad-sec">
          <button type="button" class="cad-wide-btn cad-combine" data-cutdo="split">Split into 2 objects</button>
          <div class="cad-quick"><button type="button" data-cutdo="keep+">Keep ${sideName[0]}</button><button type="button" data-cutdo="keep-">Keep ${sideName[1]}</button></div>
          <p class="cad-hint">Holes and references are not cut — holes still cut whatever they overlap.</p>
        </div>`;
      el.querySelector('[data-cutx]').onclick = () => this._cutEnd();
      el.querySelectorAll('[data-cuton]').forEach((b) => { b.onclick = () => this._cutToggle(b.dataset.cuton); });
      el.querySelectorAll('[data-cutdo]').forEach((b) => { b.disabled = !cm.on.size; });
      el.querySelectorAll('[data-cutaxis]').forEach((b) => { b.onclick = () => { cm.axis = this._cutAxis = +b.dataset.cutaxis; cm.at = r3(cm.center.getComponent(cm.axis)); this._cutPreview(); this._renderCutPanel(); }; });
      const inp = el.querySelector('[data-cutat]');
      const setAt = (v) => { cm.at = r3(v); inp.value = cm.at; this._cutPreview(); };
      inp.onchange = () => setAt(evalNum(inp.value, cm.at));
      inp.onkeydown = (e) => { if (e.key === 'Enter') { inp.dispatchEvent(new Event('change')); inp.select(); } };
      el.querySelector('[data-cutmid]').onclick = () => setAt(cm.center.getComponent(cm.axis));
      el.querySelectorAll('[data-cutstep]').forEach((b) => { b.onclick = () => setAt(cm.at + +b.dataset.cutstep); });
      const lab = el.querySelector('[data-cutscrub]');
      lab.onpointerdown = (e) => { e.preventDefault(); lab.setPointerCapture(e.pointerId); const x0 = e.clientX, a0 = cm.at; lab.onpointermove = (ev2) => setAt(Math.round((a0 + (ev2.clientX - x0) / 4) * 2) / 2); lab.onpointerup = () => { lab.onpointermove = null; lab.onpointerup = null; }; };
      el.querySelectorAll('[data-cutdo]').forEach((b) => { b.onclick = () => this._cutApply(b.dataset.cutdo); });
    }
    // The world plane (axis, at) in an object's own frame: { n, d } keeping n·x ≥ d.
    _cutLocal(it, axis, at, sign) {
      const T = this.T;
      const o = new T.Object3D(); o.rotation.order = 'ZYX'; this._placeObj(o, it); o.updateMatrixWorld(true);
      const inv = o.matrixWorld.clone().invert();
      const nW = new T.Vector3(); nW.setComponent(axis, sign);
      const pW = new T.Vector3(); pW.setComponent(axis, at);
      const nL = nW.clone().transformDirection(inv); const pL = pW.clone().applyMatrix4(inv);
      return { n: [r3(nL.x * 1e3) / 1e3, r3(nL.y * 1e3) / 1e3, r3(nL.z * 1e3) / 1e3].map((v) => (Math.abs(v) < 1e-9 ? 0 : v)), d: r3(nL.dot(pL)) };
    }
    _cutApply(how) {
      const cm = this.cutMode; if (!cm || this.readOnly) return;
      const targets = [...cm.on].filter((id) => { const it = this._item(id); return it && it.role === 'solid'; });
      if (!targets.length) { this._toast('Choose at least one Solid object to cut', 'err'); return; }
      const { axis, at } = cm;
      if (how === 'split') {
        this._snapshot(); this._bakeHoles(targets); this._skipSnap = true;
        this._copies(targets, (src) => [Object.assign(JSON.parse(JSON.stringify(src)), { clip: (src.clip || []).concat([this._cutLocal(src, axis, at, -1)]) })], null);
        // _copies took the undo snapshot; now trim the originals to the other side
        targets.forEach((id) => { const it = this._item(id); it.clip = (it.clip || []).concat([this._cutLocal(it, axis, at, 1)]); });
        const copies = this._selIds();
        this._commit(); this._refreshItems();
        this.cutMode = null;
        if (this._cutPlane) { this.scene.remove(this._cutPlane); this._cutPlane = null; }
        this._inspFor = null; this._setSel(copies);
        this._toast('Split into 2 — the selected half is the new object; move it to see the gap', 'ok');
        this._autoSeparate(targets.concat(copies));
      } else {
        const sign = how === 'keep+' ? 1 : -1;
        this._editMany(targets, (it) => { it.clip = (it.clip || []).concat([this._cutLocal(it, axis, at, sign)]); });
        this._cutEnd();
        this._toast('Cut — one side kept', 'ok');
      }
    }
    _combine() {
      const ids = this._selIds(); if (ids.length < 2 || this.readOnly) return;
      this._snapshot();
      const gid = C.uid('g_');
      const names = [];
      ids.forEach((id) => { const g = this._gid(id); const n = g ? (this.data.groups[g] || {}).name : this._item(id).name; if (n && !names.includes(n)) names.push(n); });
      let name = names.join(' + ');
      if (name.length > 40) name = names[0] + ' + ' + (names.length - 1) + ' more';
      ids.forEach((id) => { this._item(id).group = gid; });
      this.data.groups[gid] = { name: name || 'Combined' };
      this._tidyGroups();
      this._commit(); this._setSel(ids);
      this._toast('Combined into one object — exports as one part');
    }
    _uncombine(gid) {
      if (!gid || this.readOnly) return;
      this._snapshot();
      const ids = this._members(gid);
      ids.forEach((id) => { delete this._item(id).group; });
      delete this.data.groups[gid];
      this._commit(); this._setSel(ids, true);
      this._toast('Uncombined — ' + ids.length + ' separate objects again');
    }
    // Drop groups left with fewer than 2 parts (after delete / uncombine of parts).
    _tidyGroups() {
      const n = C.normalize({ items: this.data.items, groups: this.data.groups });
      this.data.items.forEach((it, i) => { if (n.items[i].group) it.group = n.items[i].group; else delete it.group; });
      this.data.groups = n.groups;
    }
    // Scaling several objects (or a combined object) as one: each object's centre
    // moves away from / towards the pivot, and its size scales along the world
    // axes (mapped to its own axes when it is turned by 0° / 90°).
    _multiScaleApply(final) {
      const T = this.T; const st = this._mStart; if (!st) return;
      const S = [Math.abs(this.proxy.scale.x), Math.abs(this.proxy.scale.y), Math.abs(this.proxy.scale.z)];
      const pivot = this.proxy.position.clone();
      if (!st.scaleInfo) {
        st.scaleInfo = st.items.map((s0) => {
          const it = this._item(s0.id); const o = this.objs[s0.id];
          const c = this._boundsOf([s0.id]).getCenter(new T.Vector3());
          const m = new T.Matrix4(); m.copy(s0.m);
          // which world axis each local axis lies along (or -1 if turned at an angle)
          const map = [0, 1, 2].map((k) => { const v = new T.Vector3(); v.setComponent(k, 1); v.transformDirection(m); const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)]; const i = a.indexOf(Math.max(...a)); return a[i] > 0.9999 ? i : -1; });
          return { id: s0.id, pos: it.pos.slice(), center: c, map, scale0: o ? o.group.scale.clone() : null };
        });
      }
      for (const si of st.scaleInfo) {
        const it = this._item(si.id); const o = this.objs[si.id]; if (!it || !o) continue;
        const nc = new T.Vector3(...[0, 1, 2].map((k) => pivot.getComponent(k) + (si.center.getComponent(k) - pivot.getComponent(k)) * S[k]));
        const d = nc.clone().sub(si.center);
        const local = si.map.map((w) => (w < 0 ? Math.cbrt(S[0] * S[1] * S[2]) : S[w]));
        if (!final) { o.group.position.set(si.pos[0] + d.x, si.pos[1] + d.y, si.pos[2] + d.z); o.group.scale.set(si.scale0.x * local[0], si.scale0.y * local[1], si.scale0.z * local[2]); }
        si.final = { d, local };
      }
      this._dimUpdate(true);
      if (!final) return;
      // turn the preview into real sizes and positions (the snapshot was taken at drag start)
      for (const si of st.scaleInfo) {
        const it = this._item(si.id); const o = this.objs[si.id]; if (!it || !si.final) continue;
        if (o) { const fl = it.flip || []; o.group.scale.set(fl[0] ? -1 : 1, fl[1] ? -1 : 1, fl[2] ? -1 : 1); }
        it.pos = [r3(si.pos[0] + si.final.d.x), r3(si.pos[1] + si.final.d.y), r3(si.pos[2] + si.final.d.z)];
        if (it.type !== 'image') this._scaleItem(si.id, si.final.local, true);
      }
      this._mStart = null; this.proxy.scale.set(1, 1, 1);
      this._commit(); this._refreshItems(); this._placeProxy();
    }
    // Scale the selection by world factors S = [x, y, z] about its centre, as one
    // (used by the scale bar). One undo step.
    _scaleSelection(S) {
      const ids = this._selIds(); if (!ids.length || this.readOnly) return;
      if (S.every((x) => Math.abs(x - 1) < 1e-9)) return;
      if (ids.length === 1 && !this.multi.length) {
        const it = this._item(ids[0]); if (!it || it.type === 'image') return;
        const M = this._placeMatrix(it); const T = this.T;
        const local = [0, 1, 2].map((k) => { const v = new T.Vector3(); v.setComponent(k, 1); v.transformDirection(M); const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)]; const i = a.indexOf(Math.max(...a)); return a[i] > 0.9999 ? S[i] : Math.cbrt(S[0] * S[1] * S[2]); });
        // keep it centred where it is: the centre moves back after the size change
        const c0 = this._boundsOf(ids).getCenter(new T.Vector3());
        this._scaleItem(ids[0], local);
        this._afterBuild(() => { const c1 = this._boundsOf(ids).getCenter(new T.Vector3()); const d = c0.clone().sub(c1); if (d.length() > 1e-6) { const x = this._item(ids[0]); x.pos = x.pos.map((v, i) => r3(v + d.getComponent(i))); this._refreshItems(); this._changed(); this._requestBuild(); } });
        return;
      }
      this._snapshot();
      this._placeProxy(); this._multiDragStart();
      this.proxy.scale.set(S[0], S[1], S[2]); this.proxy.updateMatrixWorld(true);
      const prevMode = this.tc.mode; this.tc.mode = 'scale';
      this._multiScaleApply(true);
      this.tc.mode = prevMode;
    }
    // Live preview of the scale bar's factors: the selection's size on the dimension labels.
    _scalePreview(clear) {
      const ins = [0, 1, 2].map((i) => this.root.querySelector(`[data-sbf="${i}"]`));
      const S = clear ? [1, 1, 1] : ins.map((x) => { const v = evalNum(x.value, 1); return v > 0 ? v : 1; });
      if (!this._dimLabels || !this._dimSize) return;
      const sz = this._dimSize;
      this._dimLabels.forEach((L, i) => { if (L.editing) return; const v = sz.getComponent(i) * S[i]; const html = '<b>' + 'XYZ'[i] + '</b> ' + (Math.round(v * 100) / 100) + ' mm' + (Math.abs(S[i] - 1) > 1e-9 ? ' <em>×' + S[i] + '</em>' : ''); if (L.html !== html) { L.el.innerHTML = html; L.html = html; } });
    }
    // Run fn once the next build result has arrived (fresh meshes / bounds).
    _afterBuild(fn) { (this._afterBuildQ = this._afterBuildQ || []).push(fn); }
    _deleteMany(ids) { if (!ids.length || this.readOnly) return; this._snapshot(); this.data.items = this.data.items.filter((x) => !ids.includes(x.id)); this._tidyGroups(); this.sel = null; this.multi = []; this._commit(); this._refreshItems(); }
    _duplicateMany(ids) {
      if (!ids.length || this.readOnly) return;
      this._snapshot();
      const newGid = {}; // a copied combined object gets its own new group
      const copies = ids.map((id) => this._item(id)).filter(Boolean).map((it) => {
        const c = C.normalizeItem(Object.assign(JSON.parse(JSON.stringify(it)), { id: C.uid('i_'), name: this._uniqueName(it.name.replace(/ \d+$/, '')) }));
        if (it.group) {
          if (!newGid[it.group]) { newGid[it.group] = C.uid('g_'); this.data.groups[newGid[it.group]] = { name: ((this.data.groups[it.group] || {}).name || 'Combined') + ' copy' }; }
          c.group = newGid[it.group];
        }
        c.pos = [r3(c.pos[0] + 10), c.pos[1], c.pos[2]]; this.data.items.push(c); return c.id;
      });
      this._tidyGroups();
      this._commit(); this._setSel(copies);
    }
    _editMany(ids, fn) {
      if (this.readOnly) return;
      this._snapshot();
      ids.forEach((id) => { const it = this._item(id); if (it) { fn(it); Object.assign(it, C.normalizeItem(it)); } });
      this._refreshItems(); this._commit();
    }
    // Move / rotate the whole selection as one rigid object (relative positions kept).
    _groupAction(kind) {
      const ids = this._selIds(); if (!ids.length || this.readOnly) return;
      if (kind === 'rx' || kind === 'ry' || kind === 'rz') {
        if (!this.multi.length) return;
        this._snapshot();
        this._placeProxy();
        this._multiDragStart();
        this.proxy.rotation[kind[1]] = Math.PI / 2;
        this._multiDragApply(true);
        this._renderChrome();
        return;
      }
      const b = this._boundsOf(ids); if (b.isEmpty()) return;
      const c = b.getCenter(new this.T.Vector3());
      const d = [0, 0, 0];
      if (kind === 'center' || kind === 'cx') d[0] = -c.x;
      if (kind === 'center' || kind === 'cy') d[1] = -c.y;
      if (kind === 'floor') d[2] = -b.min.z;
      if (!d[0] && !d[1] && !d[2]) return;
      this._editMany(ids, (it) => { it.pos = it.pos.map((v, i) => r3(v + d[i])); });
    }
    // Align the selection's objects to the selection's own bounds.
    _align(axis, where) {
      const ids = this._selIds(); if (ids.length < 2 && where !== 'floor') return;
      const k = { x: 0, y: 1, z: 2 }[axis];
      const all = this._boundsOf(ids);
      if (all.isEmpty()) return;
      const lo = all.min.getComponent(k), hi = all.max.getComponent(k), mid = (lo + hi) / 2;
      this._editMany(ids, (it) => {
        const b = this._boundsOf([it.id]); if (b.isEmpty()) return;
        const a = b.min.getComponent(k), z = b.max.getComponent(k);
        const d = where === 'min' ? lo - a : where === 'max' ? hi - z : where === 'floor' ? -a : mid - (a + z) / 2;
        it.pos[k] = r3(it.pos[k] + d);
      });
    }
    _setMode(m) {
      this.mode = m; this.tc.setMode(m); this._renderChrome(); this._dimUpdate();
    }
    _applySnap() {
      if (!this.tc) return;
      const s = this.data.settings;
      this.tc.setTranslationSnap(this.snapOn && s.snap ? s.snap : null);
      this.tc.setRotationSnap(this.snapOn && s.angleSnap ? s.angleSnap * DEG : null);
    }
    _readGizmo(final) {
      const it = this._item(this.sel); const o = this.objs[this.sel];
      if (!it || !o) return;
      const g = o.group;
      if (this.tc.mode === 'scale') { if (final) this._applyScale(); return; }
      it.pos = [r3(g.position.x), r3(g.position.y), r3(g.position.z)];
      g.rotation.reorder ? g.rotation.reorder('ZYX') : null;
      it.rot = [r3(g.rotation.x / DEG), r3(g.rotation.y / DEG), r3(g.rotation.z / DEG)];
      this._fillTransform();
      this._dimUpdate(!final);
      if (final) { this._changed(); this._requestBuild(); } else this._requestBuild(true);
    }

    // ---------- editing ----------
    _state() { return JSON.stringify({ items: this.data.items, groups: this.data.groups || {} }); }
    // Undo / redo put back exactly what was saved (it came from this design, so it
    // needs no cleaning); only an old-style array snapshot is normalised.
    _restore(json) {
      const st = JSON.parse(json);
      if (Array.isArray(st)) { const n = C.normalize({ items: st, groups: this.data.groups }); this.data.items = n.items; this.data.groups = n.groups; return; }
      this.data.items = Array.isArray(st.items) ? st.items : []; this.data.groups = st.groups && typeof st.groups === 'object' ? st.groups : {};
    }
    // A run of arrow / Page Up nudges on the same selection is one undo step.
    _nudgeSnap() {
      const key = this._selIds().join(','); const now = Date.now();
      if (!(this._lastNudge && this._lastNudge.key === key && now - this._lastNudge.t < 1500 && this.undoStack.length === this._lastNudge.depth)) this._snapshot();
      this._lastNudge = { key, t: now, depth: this.undoStack.length };
    }
    _snapshot() { this.undoStack.push(this._state()); if (this.undoStack.length > 1000) this.undoStack.shift(); this.redoStack = []; }
    _commit(rebuild) { this._changed(); this._renderChrome(); if (rebuild !== false) this._requestBuild(); }
    _undo() { if (!this.undoStack.length) return; this.redoStack.push(this._state()); this._restore(this.undoStack.pop()); if (!this._item(this.sel)) this.sel = null; this.multi = this.multi.filter((id) => this._item(id)); if (this.multi.length < 2) this.multi = []; this._commit(); this._refreshItems(); }
    _redo() { if (!this.redoStack.length) return; this.undoStack.push(this._state()); this._restore(this.redoStack.pop()); if (!this._item(this.sel)) this.sel = null; this.multi = this.multi.filter((id) => this._item(id)); if (this.multi.length < 2) this.multi = []; this._commit(); this._refreshItems(); }
    _uniqueName(base) { const names = new Set(this.data.items.map((i) => i.name)); if (!names.has(base)) return base; for (let k = 2; ; k++) if (!names.has(base + ' ' + k)) return base + ' ' + k; }
    _add(type, extra) {
      if (this.readOnly) return;
      this._snapshot();
      // New shapes land on the floor where you are looking.
      const t = this.target || { x: 0, y: 0 };
      const snap = (v) => (this.snapOn && this.data.settings.snap ? Math.round(v / this.data.settings.snap) * this.data.settings.snap : r3(v));
      const it = C.newItem(type, Object.assign({ name: this._uniqueName(C.TYPE_LABEL[type]), pos: [snap(t.x), snap(t.y), 0] }, extra || {}));
      this.data.items.push(it);
      this.sel = it.id; this.multi = [];
      this._setMode('translate');
      this._commit();
      return it;
    }
    _delete(id) { const i = this.data.items.findIndex((x) => x.id === id); if (i < 0) return; this._snapshot(); this.data.items.splice(i, 1); if (this.sel === id) this.sel = null; this._commit(); this._refreshItems(); }
    _duplicate(id) {
      const it = this._item(id); if (!it) return;
      this._snapshot();
      const copy = C.normalizeItem(Object.assign(JSON.parse(JSON.stringify(it)), { id: C.uid('i_'), name: this._uniqueName(it.name.replace(/ \d+$/, '')) }));
      copy.pos = [r3(copy.pos[0] + 10), copy.pos[1], copy.pos[2]];
      this.data.items.push(copy); this.sel = copy.id; this._commit();
    }
    _edit(id, fn, rebuild) {
      const it = this._item(id); if (!it || this.readOnly) return;
      this._snapshot();
      fn(it);
      Object.assign(it, C.normalizeItem(it));
      this._refreshItems(); // place it first, so the panel's Size row reads the new placement
      this._commit(rebuild);
    }
    _toggleHoles() { this.showHoles = !this.showHoles; this._refreshItems(); this._renderChrome(); }

    // ---------- import ----------
    async _importFiles(files) {
      if (this.readOnly) return;
      const extOf = (f) => f.name.split('.').pop().toLowerCase();
      const ok = files.filter((f) => C.MODEL_EXT.includes(extOf(f)) || C.IMAGE_EXT.includes(extOf(f)));
      if (!ok.length) { this._toast('Pick an STL, 3MF, OBJ, STEP or image file', 'err'); return; }
      const dest = (this._docDir() ? this._docDir() + '/' : '') + this._docBase() + '-models';
      for (const f of ok) {
        this._toast('Importing ' + f.name + '…');
        try {
          const buf = await f.arrayBuffer();
          if (buf.byteLength > 38 * 1024 * 1024) throw new Error('File is too large (limit 38 MB)');
          const bytes = new Uint8Array(buf); let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          const res = await api('/api/import', { dest, files: [{ name: f.name, encoding: 'base64', content: btoa(bin) }] });
          const rel = res.imported && res.imported[0] && res.imported[0].path;
          if (!rel) throw new Error('Import failed');
          const ext = rel.split('.').pop().toLowerCase();
          if (C.IMAGE_EXT.includes(ext)) {
            this._add('image', { name: this._uniqueName(f.name.replace(/\.[^.]+$/, '')), file: { path: rel }, width: 100, opacity: 0.6 });
            this._toast('Image added — set its width in mm, then trace it with Sketch', 'ok');
            continue;
          }
          this._add('model', { name: this._uniqueName(f.name.replace(/\.[^.]+$/, '')), role: 'ref', file: { path: rel, ext, key: rel + '#' + buf.byteLength + '#' + Date.now() } });
          this._fitOnNextResult = true;
          this._toast('Imported — choose Solid, Hole or Reference', 'ok');
        } catch (e) { this._toast(f.name + ': ' + e.message, 'err'); }
      }
    }

    // ---------- building ----------
    _initWorker() {
      this.worker = new Worker(VENDOR + 'cad-worker.js?v=' + encodeURIComponent(this.version), { type: 'module' });
      this._needAll = true;
      this.pending = new Map();
      this.worker.onmessage = (e) => this._onWorker(e.data || {});
      this.worker.onerror = (e) => { if (this._restarts) { this._restartWorker(e.message || 'error'); return; } this._setStatus('3D engine failed to start: ' + (e.message || 'error'), 'err'); };
      this._setStatus('Starting 3D engine…', 'busy');
    }
    // The modelling libraries hit a fatal WebAssembly error (e.g. out of memory):
    // start a fresh engine and rebuild from the design, which is untouched.
    _restartWorker(why) {
      this._restarts = (this._restarts || 0) + 1;
      try { this.worker.terminate(); } catch (e) { /* gone */ }
      for (const [, p] of this.pending) { try { p.reject(new Error('The 3D engine restarted — please try again.')); } catch (e) { /* ignore */ } }
      this.pending.clear();
      this.building = false; this.pendingBuild = false;
      this._initWorker();
      this._toast('The 3D engine ran out of memory and was restarted — your design is safe.', 'err');
      console.warn('CAD worker restarted:', why);
      this._requestBuild();
    }
    _requestBuild(live) {
      if (this.sk) this._sketchDraw();
      if (!this.worker) return;
      clearTimeout(this._buildT);
      if (live && this._lastBuildMs > 120) return; // heavy design: rebuild once the drag ends
      this._buildT = setTimeout(() => this._build(), live ? 90 : 10);
    }
    _build(files) {
      if (this.building && !files) { this.pendingBuild = true; return; }
      this.building = true; this.pendingBuild = false;
      const id = ++this.buildSeq;
      this._setStatus('Building…', 'busy');
      const msg = { type: 'build', id, items: this.data.items, groups: this.data.groups || {}, files: files || {}, quality: 'normal', all: !!this._needAll };
      this._needAll = false;
      this.worker.postMessage(msg, Object.values(files || {}));
    }
    async _onWorker(m) {
      if (m.type === 'ready') return;
      if (m.type === 'fatal' || (m.type === 'error' && /memory access out of bounds|out of memory|RuntimeError/i.test(m.message || ''))) { this._restartWorker(m.message); return; }
      if (m.type === 'init-error') { this._setStatus('3D engine failed: ' + m.message, 'err'); return; }
      if (m.type === 'need') {
        const files = {};
        try {
          for (const key of m.keys) {
            const it = this.data.items.find((i) => i.file && i.file.key === key) || this.data.items.flatMap((i) => (i.cuts || []).map((c) => c.shape)).find((sh) => sh && sh.file && sh.file.key === key);
            if (!it) continue;
            const r = await fetch('/api/cad/mesh?path=' + encodeURIComponent(it.file.path), { cache: 'no-store' });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load ' + it.file.path);
            files[key] = await r.arrayBuffer();
          }
        } catch (e) { this.building = false; this._setStatus(e.message, 'err'); return; }
        this.building = false;
        this._build(files);
        return;
      }
      if (m.type === 'result') {
        this.building = false;
        this._lastBuildMs = m.ms;
        // items not re-sent kept their mesh (only changed items are sent)
        { const nm = {}; (m.keep || []).forEach((id) => { if (this.meshes && this.meshes[id]) nm[id] = this.meshes[id]; }); this.meshes = Object.assign(nm, m.items || {}); }
        if ((m.keep || []).some((id) => !this.meshes[id])) { this._needAll = true; this._requestBuild(); }
        this.result = m.result; this.errors = m.errors || {}; this.notes = m.notes || {}; this.stepOk = m.stepOk; this.groupPieces = m.groupPieces || {};
        const infoKey = JSON.stringify(m.info || {}) + JSON.stringify(m.pieces || {}); if (infoKey !== this._infoKey) { this._infoKey = infoKey; this._inspFor = null; }
        this.info = m.info || {}; this.floating = m.floating || {}; this.edges = m.edges || {}; this.pieces = m.pieces || {};
        if (this.edgeMode) this._edgeDraw();
        this._refreshDesign(); this._refreshItems(); this._renderList(); this._renderInspector(true); this._dimUpdate();
        if (this._afterBuildQ && this._afterBuildQ.length) { const q = this._afterBuildQ; this._afterBuildQ = []; q.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
        if (this.faceOn && this.face && !this._faceItem) this._faceDrawRegion(this.face, 'sel');
        this._codeStatus();
        const nErr = Object.keys(this.errors).length;
        this._setStatus(nErr ? nErr + ' shape' + (nErr > 1 ? 's' : '') + ' need attention' : (this.result ? 'Ready · ' + m.ms + ' ms' : 'Add a shape to start'), nErr ? 'warn' : 'ok');
        if (this._fitOnNextResult) { this._fitOnNextResult = false; const b = this._bounds(); if (!b.isEmpty()) { this._buildGrid(b.getSize(new this.T.Vector3()).length()); this._fit(); } }
        if (this.pendingBuild) this._build();
        return;
      }
      if (m.type === 'file') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m.buffer); } return; }
      if (m.type === 'regions') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m.regions || []); } return; }
      if (m.type === 'check') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m.overlaps || []); } return; }
      if (m.type === 'error') {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); return; }
        this.building = false;
        this._setStatus(m.message, 'err');
        if (this.pendingBuild) this._build();
      }
    }
    _setStatus(text, kind) { if (this.statusEl) { this.statusEl.textContent = text; this.statusEl.className = 'cad-status ' + (kind || ''); } }

    // ---------- export ----------
    // Ask the worker which solids share volume (they'd be fused into one piece).
    _checkOverlaps() {
      const id = 'c' + (++this.buildSeq);
      return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ type: 'check', id }); });
    }
    async _export(kind) {
      try { await this._exportInner(kind); } finally { this._active = true; if (this.root.isConnected) this.root.focus({ preventScroll: true }); }
    }
    async _exportInner(kind) {
      // kind: stl | 3mf | step (save next to the doc), dl | dl3mf (download)
      const format = kind === 'step' ? 'step' : kind === '3mf' || kind === 'dl3mf' ? '3mf' : 'stl';
      const download = kind === 'dl' || kind === 'dl3mf';
      try {
        // Overlap warning before every export.
        if (this.building || this.pendingBuild) await new Promise((r) => { const t = setInterval(() => { if (!this.building && !this.pendingBuild) { clearInterval(t); r(); } }, 50); });
        const overlaps = await this._checkOverlaps();
        const floatIds = Object.keys(this.floating || {}).filter((id) => this._item(id));
        if (floatIds.length) {
          const names = []; floatIds.forEach((id) => { const g = this._gid(id); const nm = g ? (this.data.groups[g] || {}).name : this._item(id).name; if (!names.includes(nm)) names.push(nm); });
          const ok = await global.uiConfirm('Floating above the build plate (needs support):\n\n' + names.map((n2) => '•  ' + n2).join('\n') + '\n\nCancel to select them — then use Drop to floor.',
            { title: 'Floating solids', okLabel: 'Export anyway', cancelLabel: 'Cancel' });
          if (!ok) { this._setSel(floatIds); this._toast('Floating solids selected'); return; }
        }
        if (overlaps.length) {
          const lines = overlaps.slice(0, 12).map((o) => '•  ' + o.aName + '  ↔  ' + o.bName + '   (' + o.volume + ' mm³ shared)');
          if (overlaps.length > 12) lines.push('…and ' + (overlaps.length - 12) + ' more');
          const what = format === '3mf' ? 'Each overlapping group becomes ONE object in the 3MF.' : 'They will be fused into one piece in the ' + format.toUpperCase() + '.';
          const go = await global.uiConfirm(overlaps.length + ' overlapping solid' + (overlaps.length > 1 ? ' pairs' : ' pair') + ':\n\n' + lines.join('\n') + '\n\n' + what + '\nThat is right if you meant to join them; otherwise Cancel to select them and move them apart.',
            { title: 'Overlapping solids', okLabel: 'Export anyway', cancelLabel: 'Cancel' });
          if (!go) {
            this._setSel([...new Set(overlaps.flatMap((o) => [o.a, o.b]))]);
            this._toast('Overlapping solids selected');
            return;
          }
        }
      } catch (e) { this._toast(e.message, 'err'); return; }
      const id = 'x' + (++this.buildSeq);
      this._toast('Preparing ' + format.toUpperCase() + '…');
      try {
        const buf = await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ type: 'export', id, format, name: this._docBase() }); });
        const name = this._docBase() + '.' + format;
        if (download) {
          const url = URL.createObjectURL(new Blob([buf], { type: format === '3mf' ? 'model/3mf' : 'model/stl' }));
          const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          this._toast('Downloaded ' + name, 'ok');
          return;
        }
        const bytes = new Uint8Array(buf); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const rel = (this._docDir() ? this._docDir() + '/' : '') + name;
        await api('/api/cad/export', { path: rel, content: btoa(bin), message: 'Export ' + rel });
        this._toast('Saved ' + rel + ' (' + Math.round(buf.byteLength / 1024) + ' KB)', 'ok');
      } catch (e) { this._toast(e.message, 'err'); }
    }

    // ---------- chrome: toolbar state, inspector, list ----------
    _syncAll() { this._applySnap(); this._refreshItems(); this._renderChrome(); }
    _renderChrome() {
      if (!this.inspEl) return;
      if (this.T) this._dimUpdate();
      const q = (s) => this.root.querySelector(s);
      q('[data-undo]').disabled = !this.undoStack.length || this.readOnly;
      q('[data-redo]').disabled = !this.redoStack.length || this.readOnly;
      q('.cad-gizmo').classList.toggle('hidden', !(this.sel || this.multi.length) || this.readOnly);
      q('.cad-scalebar').classList.toggle('hidden', this.mode !== 'scale' || !(this.sel || this.multi.length) || this.readOnly || !!(this.sk || this.faceOn || this.edgeMode || this.cutMode));
      q('[data-multimode]').classList.toggle('on', this.multiMode);
      { const vis = this.data.items.filter((it) => !it.hidden); const ids = this._selIds();
        q('[data-selall]').classList.toggle('on', vis.length > 1 && ids.length === vis.length);
        q('[data-selall]').disabled = !vis.length; }
      this.root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
      q('[data-holes]').classList.toggle('on', this.showHoles);
      q('[data-snap]').classList.toggle('on', this.snapOn);
      q('[data-snap]').textContent = this.snapOn ? 'Snap ' + this.data.settings.snap + ' mm' : 'Snap off';
      this._renderList();
      this._renderInspector();
    }
    _renderList() {
      const body = this.listEl.querySelector('.cad-list-body');
      const seen = new Set(); const rows = [];
      this.data.items.forEach((it) => { if (!it.group) rows.push(it); else if (!seen.has(it.group)) { seen.add(it.group); rows.push(it); } });
      this.listEl.querySelector('.cad-count').textContent = rows.length || '';
      body.innerHTML = rows.length ? rows.map((it) => {
        const g = it.group; const mem = g ? this._members(g).map((x) => this._item(x)) : null;
        const hidden = g ? mem.every((x) => x.hidden) : it.hidden;
        return `
        <div class="cad-row ${this._isSel(it.id) ? 'sel' : ''} ${hidden ? 'off' : ''} ${g ? 'grp' : ''}" data-id="${esc(it.id)}">
          <span class="cad-dot ${g ? 'combo' : it.role}"></span>
          <span class="cad-row-name">${esc(g ? (this.data.groups[g] || {}).name || 'Combined' : it.name)}${g ? ' <em>' + mem.length + ' parts</em>' : ''}</span>
          ${this.errors[it.id] ? '<span class="cad-flag err" title="' + esc(this.errors[it.id]) + '">!</span>' : this.notes[it.id] ? '<span class="cad-flag" title="' + esc(this.notes[it.id]) + '">i</span>' : ''}
          ${(g ? mem.some((x) => this.floating && this.floating[x.id] != null) : this.floating && this.floating[it.id] != null) ? '<span class="cad-flag float" title="Floating above the build plate — needs support">⤒</span>' : ''}
          <button type="button" class="cad-icon-btn" data-vis title="${hidden ? 'Show' : 'Hide'}">${hidden ? ICON.eyeOff : ICON.eye}</button>
        </div>`; }).join('') : '<p class="cad-empty">No shapes yet. Add a box or import a model.</p>';
      body.querySelectorAll('.cad-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          const id = row.dataset.id;
          if (e.target.closest('[data-vis]')) {
            const unit = this._expand([id]); const hide = !unit.every((x) => this._item(x).hidden);
            this._editMany(unit, (it) => { it.hidden = hide; }); return;
          }
          if (e.shiftKey || e.metaKey || e.ctrlKey || this.multiMode) this._toggleSel(id); else this._select(id);
        });
      });
    }
    _fillTransform() {
      if (!this.inspEl) return;
      const it = this._item(this.sel); if (!it) return;
      this.inspEl.querySelectorAll('[data-f]').forEach((inp) => {
        const [k, i] = inp.dataset.f.split('.');
        if ((k === 'pos' || k === 'rot') && document.activeElement !== inp) inp.value = it[k][+i];
      });
      this._renderDims();
    }
    _field(label, f, value, opts) {
      const o = opts || {};
      return `<label class="cad-field${o.wide ? ' wide' : ''}"><span class="cad-scrub" data-scrub="${f}" data-step="${o.step || 0.5}" ${o.min != null ? 'data-min="' + o.min + '"' : ''}>${label}</span><input type="text" inputmode="decimal" data-f="${f}" value="${esc(value)}" ${this.readOnly ? 'disabled' : ''}>${o.unit ? '<em>' + o.unit + '</em>' : ''}</label>`;
    }
    _renderInspector(fromBuild) {
      if (this.exMode) { if (!fromBuild) this._renderExtrudePanel(); return; }
      if (this.cutMode) { if (!fromBuild) this._renderCutPanel(); return; }
      if (this.faceOn) { if (!fromBuild) this._renderFacePanel(); return; }
      if (this.edgeMode) { if (!fromBuild || !this.inspEl.contains(document.activeElement)) this._renderEdgePanel(); return; }
      if (this.multi.length) { this._renderMultiInspector(fromBuild); return; }
      const it = this._item(this.sel);
      const el = this.inspEl;
      el.classList.toggle('hidden', !it);
      if (!it) { el.innerHTML = ''; this._inspFor = null; return; }
      // Rebuilds only refresh messages when the inspector already shows this item.
      if (fromBuild && this._inspFor === it.id + ':' + this._inspVersion) { this._renderMsgs(); return; }
      if (fromBuild && el.contains(document.activeElement)) { this._renderMsgs(); return; }
      this._inspVersion = (this._inspVersion || 0) + 1;
      this._inspFor = it.id + ':' + this._inspVersion;
      const ro = this.readOnly;
      const sz = it.size || {};
      let dims = '';
      if (it.type === 'box') dims = this._field('W', 'size.x', sz.x, { unit: 'mm', min: 0.1 }) + this._field('D', 'size.y', sz.y, { unit: 'mm', min: 0.1 }) + this._field('H', 'size.z', sz.z, { unit: 'mm', min: 0.1 }) + this._field('Corner', 'size.corner', sz.corner, { unit: 'mm', min: 0, step: 0.25 });
      if (it.type === 'cylinder') dims = this._field('Ø', 'size.d', sz.d, { unit: 'mm', min: 0.1 }) + this._field('H', 'size.z', sz.z, { unit: 'mm', min: 0.1 });
      if (it.type === 'sphere') dims = this._field('Ø', 'size.d', sz.d, { unit: 'mm', min: 0.1 });
      const drawn = it.type === 'box' || it.type === 'cylinder' || it.type === 'sphere';
      el.innerHTML = `
        <div class="cad-insp-head">
          <input class="cad-name" data-name value="${esc(it.name)}" ${ro ? 'disabled' : ''} spellcheck="false">
          <button type="button" class="cad-icon-btn" data-close title="Done (Esc)">✕</button>
        </div>
        <div class="cad-roles ${it.type === 'image' || it.draft ? 'hidden' : ''}" role="radiogroup">${C.ROLES.map((r) => `<button type="button" data-role="${r}" class="${it.role === r ? 'on ' + r : ''}" title="${ROLE_HINT[r]}" ${ro ? 'disabled' : ''}>${ROLE_LABEL[r]}</button>`).join('')}</div>
        ${this.pieces && this.pieces[it.id] > 1 ? `<p class="cad-msg">This object is <b>${this.pieces[it.id]} separate pieces</b>. <button type="button" class="cad-msg-btn" data-separate>Separate</button></p>` : ''}
        ${(it.clip && it.clip.length) || (it.cuts && it.cuts.length) ? `<p class="cad-combo-tag">Cut ${(it.clip || []).length + (it.cuts || []).length} time${(it.clip || []).length + (it.cuts || []).length > 1 ? 's' : ''}${it.cuts && it.cuts.length ? ' (' + it.cuts.map((c) => c.keep).join(', ') + ' of a shape)' : ''} · <a href="#" data-uncut>remove cuts</a></p>` : ''}
        ${it.group ? `<p class="cad-combo-tag">Part of <b>${esc((this.data.groups[it.group] || {}).name || 'Combined')}</b> · <a href="#" data-selgroup>select whole object</a></p>` : ''}
        <div class="cad-msgs"></div>
        <div class="cad-dims" title="Overall size along each axis, after rotation"></div>
        ${dims ? '<div class="cad-sec"><div class="cad-sec-t">Size</div><div class="cad-grid">' + dims + '</div></div>' : ''}
        ${drawn || (it.type === 'sketch' && !it.draft) ? `<div class="cad-sec"><div class="cad-sec-t">Shape</div><div class="cad-grid">
          ${this._field('Round', 'round', it.round, { unit: 'mm', min: 0, step: 0.25 })}
          ${this._field('Chamfer', 'chamfer', it.chamfer, { unit: 'mm', min: 0, step: 0.25 })}
          ${this._field('Hollow', 'hollow', it.hollow, { unit: 'mm', min: 0, step: 0.2 })}
        </div><p class="cad-hint">Hollow = wall thickness, open at the top. 0 = solid.</p>
        <button type="button" class="cad-wide-btn" data-edgemode ${ro ? 'disabled' : ''} title="Tap edges to round or chamfer just those">Round / chamfer edges…${it.edges && it.edges.length ? ' <b>(' + it.edges.length + ')</b>' : ''}</button></div>` : ''}
        ${it.type === 'sketch' && it.draft ? `<div class="cad-sec"><div class="cad-sec-t">2D sketch</div>
          <p class="cad-hint">Outlines only — nothing is solid yet. Extrude its areas (all, or the ones you tap) into shapes.</p>
          <button type="button" class="cad-wide-btn cad-combine" data-extrude ${ro ? 'disabled' : ''}>Extrude…</button>
          <button type="button" class="cad-wide-btn" data-editsketch ${ro ? 'disabled' : ''}>${ICON.sketch} Edit sketch</button>
          <div class="cad-sec-t">Plane</div>
          <div class="cad-seg cad-seg3">${[['xy', 'XY · floor'], ['xz', 'XZ · front'], ['yz', 'YZ · side']].map(([v, t]) => `<button type="button" data-dplane="${v}" class="${this._planeOf(it) === v ? 'on' : ''}" ${ro ? 'disabled' : ''}>${t}</button>`).join('')}</div>
          <div class="cad-grid"><label class="cad-field wide"><span>Offset</span><input type="text" inputmode="decimal" data-doff value="${this._planeOff(it)}" ${ro ? 'disabled' : ''}><em>mm</em></label></div>
          <p class="cad-hint">Or turn it freely with the rotate tool (R).</p>
        </div>` : ''}
        ${it.type === 'sketch' && !it.draft ? `<div class="cad-sec"><div class="cad-sec-t">Sketch</div>
          <div class="cad-grid">${this._field('Height', 'height', it.height, { unit: 'mm', min: 0.05, wide: true })}</div>
          ${it.profiles.map((pr, i) => {
            const f = (L, k, v, o) => this._field(L, 'profiles.' + i + '.' + k, v, o);
            const icon = { rect: '▭', circle: '◯', slot: '⬭', ngon: '⬡', poly: '⬠' }[pr.k];
            const body = pr.k === 'rect' ? f('W', 'w', pr.w, { unit: 'mm', min: 0.05 }) + f('H', 'h', pr.h, { unit: 'mm', min: 0.05 })
              : pr.k === 'circle' ? f('Ø', 'd', r3(pr.r * 2), { unit: 'mm', min: 0.1 })
              : pr.k === 'slot' ? f('L', 'w', pr.w, { unit: 'mm', min: 0.1 }) + f('W', 'h', pr.h, { unit: 'mm', min: 0.05 }) + f('∠', 'a', pr.a, { unit: '°', step: 5 })
              : pr.k === 'ngon' ? f('Ø', 'd', r3(pr.r * 2), { unit: 'mm', min: 0.1 }) + f('Sides', 'n', pr.n, { min: 3, step: 1 }) + f('∠', 'a', pr.a, { unit: '°', step: 5 })
              : '<em>' + pr.pts.length + '-point shape' + (pr.pts.some((q) => q.length >= 4) ? ' with arcs' : '') + '</em>';
            return `<div class="cad-prof ${pr.cut ? 'cut' : ''}"><span title="${pr.cut ? 'Cut-out' : 'Shape'}">${icon}</span><div class="cad-grid">${body}</div>
              <div class="cad-prof-acts"><button type="button" data-pcut="${i}" class="${pr.cut ? 'on' : ''}" title="${pr.cut ? 'Cut-out — tap to make it solid' : 'Solid — tap to make it a cut-out (hole)'}" ${ro ? 'disabled' : ''}>${pr.cut ? 'Cut' : 'Solid'}</button>
              <button type="button" data-pdel="${i}" title="Remove this shape from the sketch" ${ro || it.profiles.length < 2 ? 'disabled' : ''}>✕</button></div></div>`;
          }).join('')}
          <button type="button" class="cad-wide-btn" data-editsketch ${ro ? 'disabled' : ''}>${ICON.sketch} Edit sketch</button>
        </div>` : ''}
        ${it.type === 'image' ? `<div class="cad-sec"><div class="cad-sec-t">Image</div>
          <div class="cad-file-name" title="${esc(it.file.path)}">${esc(it.file.path.split('/').pop())}</div>
          <div class="cad-grid">${this._field('Width', 'width', it.width, { unit: 'mm', min: 1 })}${this._field('Opacity', 'opacity', it.opacity, { min: 0.05, step: 0.05 })}</div>
          <p class="cad-hint">Set the width to the real size, then trace it with Sketch. Rotate X by 90° to stand it up.</p>
        </div>` : ''}
        ${it.type === 'model' ? `<div class="cad-sec"><div class="cad-sec-t">Model</div>
          <div class="cad-file-name" title="${esc(it.file.path)}">${esc(it.file.path.split('/').pop())}</div>
          ${(() => {
            const base = this.info && this.info[it.id] && this.info[it.id].base;
            const u = { mm: 1, cm: 10, in: 25.4, m: 1000 }[it.units] || 1;
            const real = base ? base.map((b, i) => r3(b * u * it.scale * it.stretch[i])) : null;
            const fmt = (v) => String(Math.round(v * 100) / 100);
            return `<p class="cad-hint cad-filesize">In the file: <b>${base ? base.map(fmt).join(' × ') : '…'}</b> ${it.units === 'mm' ? 'units (read as mm)' : it.units}</p>
              <div class="cad-sec-t">File units</div>
              <div class="cad-seg4">${['mm', 'cm', 'in', 'm'].map((x) => `<button type="button" data-units="${x}" class="${it.units === x ? 'on' : ''}" ${ro ? 'disabled' : ''} title="The file's numbers are ${x === 'in' ? 'inches' : x === 'm' ? 'metres' : x === 'cm' ? 'centimetres' : 'millimetres'}">${x === 'in' ? 'inch' : x}</button>`).join('')}</div>
              <div class="cad-sec-t cad-msize-t">Real size <button type="button" class="cad-lock ${this._lockProp === false ? '' : 'on'}" data-lock title="${this._lockProp === false ? 'Proportions unlocked — each axis scales on its own' : 'Proportions locked — typing one size scales all three'}">${this._lockProp === false ? '🔓' : '🔒'}</button></div>
              <div class="cad-grid">${['W', 'D', 'H'].map((L, i) => `<label class="cad-field"><span class="cad-scrub">${L}</span><input type="text" inputmode="decimal" data-msize="${i}" value="${real ? real[i] : ''}" ${ro || !real ? 'disabled' : ''}><em>mm</em></label>`).join('')}
                ${this._field('Scale', 'scale', it.scale, { min: 0.001, step: 0.01 })}</div>
              ${it.scale !== 1 || it.stretch.some((v) => v !== 1) || it.units !== 'mm' ? `<button type="button" class="cad-wide-btn" data-resetsize ${ro ? 'disabled' : ''}>Reset to file size</button>` : ''}`;
          })()}
          ${it.role !== 'ref' ? `<div class="cad-seg2"><button type="button" data-fit="exact" class="${it.fit === 'exact' ? 'on' : ''}" ${ro ? 'disabled' : ''}>Exact</button><button type="button" data-fit="outline" class="${it.fit === 'outline' ? 'on' : ''}" ${ro ? 'disabled' : ''}>Outline</button></div>
          <p class="cad-hint">${it.fit === 'outline' ? 'Outline wraps the model in a tight shell — always works, ideal for device pockets.' : 'Exact uses the model as-is (needs a watertight mesh).'}</p>` : ''}
        </div>` : ''}
        ${it.role === 'hole' ? `<div class="cad-sec"><div class="cad-grid">${this._field('Clearance', 'clearance', it.clearance, { unit: 'mm', min: 0, step: 0.05, wide: true })}</div><p class="cad-hint">Extra room on every side so parts fit. 0.2–0.4 mm is typical.</p></div>` : ''}
        ${it.type === 'code' ? `<div class="cad-sec"><div class="cad-sec-t">Script <a href="https://replicad.xyz/docs/intro" target="_blank" rel="noopener">replicad docs</a></div>
          <pre class="cad-code-peek" data-editcode title="Open the code editor">${esc(it.code.split('\n').filter((l) => l.trim()).slice(0, 5).join('\n'))}</pre>
          <button type="button" class="cad-wide-btn" data-editcode>${ICON.code} ${ro ? 'View script' : 'Edit script'}</button>
          <button type="button" class="cad-wide-btn" data-edgemode ${ro ? 'disabled' : ''}>Round / chamfer edges…${it.edges && it.edges.length ? ' <b>(' + it.edges.length + ')</b>' : ''}</button></div>` : ''}
        <div class="cad-sec"><div class="cad-sec-t">Position</div><div class="cad-grid">
          ${this._field('X', 'pos.0', it.pos[0], { unit: 'mm' })}${this._field('Y', 'pos.1', it.pos[1], { unit: 'mm' })}${this._field('Z', 'pos.2', it.pos[2], { unit: 'mm' })}
        </div>
        <div class="cad-sec-t">Rotation</div><div class="cad-grid">
          ${this._field('X', 'rot.0', it.rot[0], { unit: '°', step: 5 })}${this._field('Y', 'rot.1', it.rot[1], { unit: '°', step: 5 })}${this._field('Z', 'rot.2', it.rot[2], { unit: '°', step: 5 })}
        </div>
        <div class="cad-quick">
          <button type="button" data-q="floor" title="Drop onto the build plate">Drop to floor</button>
          <button type="button" data-q="center" title="Centre on X and Y">Center</button>
          <button type="button" data-q="rx" title="Rotate 90° about X">↻X</button><button type="button" data-q="ry" title="Rotate 90° about Y">↻Y</button><button type="button" data-q="rz" title="Rotate 90° about Z">↻Z</button>
        </div></div>

        <div class="cad-sec"><div class="cad-sec-t">Mirror — same on the other side</div>
          <div class="cad-iconrow">
            <button type="button" data-sym="0" title="Mirror X: what is on the left also on the right (cuts, holes, features)" ${ro ? 'disabled' : ''}>${ICON.mirrorx}<span>X</span></button>
            <button type="button" data-sym="1" title="Mirror Y: what is on the front also on the back" ${ro ? 'disabled' : ''}>${ICON.mirrory}<span>Y</span></button>
            <button type="button" data-sym="2" title="Mirror Z: what is on the bottom also on the top" ${ro ? 'disabled' : ''}>${ICON.mirrorz}<span>Z</span></button>
          </div>
          <div class="cad-sec-t">Flip in place</div>
          <div class="cad-iconrow">
            <button type="button" data-mirror="0" title="Flip X: turn it over left ↔ right" ${ro ? 'disabled' : ''}>${ICON.flip}<span>X</span></button>
            <button type="button" data-mirror="1" title="Flip Y: turn it over front ↔ back" ${ro ? 'disabled' : ''}>${ICON.flip}<span>Y</span></button>
            <button type="button" data-mirror="2" title="Flip Z: turn it over top ↔ bottom" ${ro ? 'disabled' : ''}>${ICON.flip}<span>Z</span></button>
            <button type="button" data-cutstart title="Cut with a plane: split into 2 objects or keep one side" ${ro ? 'disabled' : ''}>Cut…</button>
          </div>
          ${this.sel && !this.multi.length && (this._item(this.sel) || {}).type !== 'image' ? `<button type="button" class="cad-wide-btn cad-combine" data-splitwith ${ro ? 'disabled' : ''} title="Every Solid this shape overlaps is split into the part outside it and the part inside it — no gap">Split objects with this shape</button>` : ''}
          <details class="cad-pattern"><summary>Pattern…</summary>
            <div class="cad-seg2"><button type="button" data-pkind="linear" class="${this._pkind !== 'circular' ? 'on' : ''}">Row</button><button type="button" data-pkind="circular" class="${this._pkind === 'circular' ? 'on' : ''}">Circle</button></div>
            <div class="cad-grid">
              <label class="cad-field wide"><span class="cad-scrub">Count</span><input type="text" inputmode="numeric" data-pn value="${this._pn || 4}"><em>total</em></label>
              ${this._pkind === 'circular'
                ? `<label class="cad-field"><span class="cad-scrub">Angle</span><input type="text" inputmode="decimal" data-pangle value="${this._pangle == null ? 360 : this._pangle}"><em>°</em></label>
                   <label class="cad-field"><span class="cad-scrub">X</span><input type="text" inputmode="decimal" data-pcx value="${this._pcx || 0}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">Y</span><input type="text" inputmode="decimal" data-pcy value="${this._pcy || 0}"><em>mm</em></label>`
                : `<label class="cad-field"><span class="cad-scrub">ΔX</span><input type="text" inputmode="decimal" data-pdx value="${this._pdx == null ? 10 : this._pdx}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">ΔY</span><input type="text" inputmode="decimal" data-pdy value="${this._pdy || 0}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">ΔZ</span><input type="text" inputmode="decimal" data-pdz value="${this._pdz || 0}"><em>mm</em></label>`}
            </div>
            <p class="cad-hint">${this._pkind === 'circular' ? 'Copies around a vertical axis through X, Y (360° spreads them evenly).' : 'Each copy steps by ΔX / ΔY / ΔZ from the previous one.'}</p>
            <button type="button" class="cad-wide-btn" data-pmake ${ro ? 'disabled' : ''}>Make copies</button>
          </details>
        </div>
        <div class="cad-actions">
          <button type="button" data-dup ${ro ? 'disabled' : ''}>Duplicate</button>
          <button type="button" data-del class="danger" ${ro ? 'disabled' : ''}>Delete</button>
        </div>`;
      this._renderMsgs();
      this._wireInspector(it.id);
    }
    _renderMultiInspector(fromBuild) {
      const el = this.inspEl; const ids = this.multi; const ro = this.readOnly;
      el.classList.remove('hidden');
      const key = 'multi:' + ids.join(',') + ':' + JSON.stringify(this.groupPieces || {});
      if (fromBuild && this._inspFor === key) { this._renderDims(); return; }
      this._inspFor = key;
      const items = ids.map((id) => this._item(id)).filter(Boolean);
      const roles = new Set(items.map((i) => i.role));
      const gid = this._soleGroup();
      const pieces = gid && this.groupPieces ? this.groupPieces[gid] : 0;
      const al = (axis, label, hint) => `<div class="cad-align"><b class="ax-${axis}">${axis.toUpperCase()}</b>${label.map(([w, t, h]) => `<button type="button" data-align="${axis}:${w}" title="${h}" ${ro ? 'disabled' : ''}>${t}</button>`).join('')}</div>`;
      el.innerHTML = `
        <div class="cad-insp-head">${gid
          ? `<input class="cad-name" data-gname value="${esc((this.data.groups[gid] || {}).name || 'Combined')}" ${ro ? 'disabled' : ''} spellcheck="false">`
          : `<div class="cad-name">${ids.length} objects</div>`}<button type="button" class="cad-icon-btn" data-close title="Clear selection (Esc)">✕</button></div>
        ${gid ? `<p class="cad-combo-tag">Combined object · ${ids.length} parts · exports as one part</p>` : ''}
        ${gid && pieces > 1 ? `<p class="cad-msg">The parts don't touch — this prints as <b>${pieces} separate pieces</b>. Move them together (touching or overlapping) to make one piece.</p>` : ''}
        <div class="cad-roles" role="radiogroup">${C.ROLES.map((r) => `<button type="button" data-role="${r}" class="${roles.size === 1 && roles.has(r) ? 'on ' + r : ''}" title="Set all to ${ROLE_LABEL[r]}" ${ro ? 'disabled' : ''}>${ROLE_LABEL[r]}</button>`).join('')}</div>
        <div class="cad-dims" title="Size of the whole selection"></div>
        <div class="cad-sec"><div class="cad-sec-t">Move as one</div>
          <div class="cad-quick">
            <button type="button" data-g="center" title="Centre the whole selection on the build plate (X and Y)" ${ro ? 'disabled' : ''}>Center</button>
            <button type="button" data-g="cx" title="Centre the selection on X" ${ro ? 'disabled' : ''}>Center X</button>
            <button type="button" data-g="cy" title="Centre the selection on Y" ${ro ? 'disabled' : ''}>Center Y</button>
            <button type="button" data-g="floor" title="Lowest point of the selection onto the build plate" ${ro ? 'disabled' : ''}>Drop to floor</button>
            <button type="button" data-g="rx" title="Rotate the selection 90° about X, around its centre" ${ro ? 'disabled' : ''}>↻X</button>
            <button type="button" data-g="ry" title="Rotate the selection 90° about Y, around its centre" ${ro ? 'disabled' : ''}>↻Y</button>
            <button type="button" data-g="rz" title="Rotate the selection 90° about Z, around its centre" ${ro ? 'disabled' : ''}>↻Z</button>
            <button type="button" data-mq="hide">Hide</button>
          </div>
          <p class="cad-hint">The objects keep their positions relative to each other. Drag the gizmo to move or rotate them together.</p>
        </div>
        <details class="cad-sec cad-align-sec"><summary class="cad-sec-t">Align to each other</summary>
          ${al('x', [['min', 'Left', 'Line up left edges'], ['mid', 'Center', 'Line up centres on X'], ['max', 'Right', 'Line up right edges']])}
          ${al('y', [['min', 'Front', 'Line up front edges'], ['mid', 'Center', 'Line up centres on Y'], ['max', 'Back', 'Line up back edges']])}
          ${al('z', [['min', 'Bottom', 'Line up bottoms'], ['mid', 'Middle', 'Line up centres on Z'], ['max', 'Top', 'Line up tops']])}
          <p class="cad-hint">Moves each object separately so their edges or centres line up — e.g. centre a pocket in a body.</p>
        </details>
        <div class="cad-sec"><div class="cad-sec-t">Mirror — same on the other side</div>
          <div class="cad-iconrow">
            <button type="button" data-sym="0" title="Mirror X: what is on the left also on the right (cuts, holes, features)" ${ro ? 'disabled' : ''}>${ICON.mirrorx}<span>X</span></button>
            <button type="button" data-sym="1" title="Mirror Y: what is on the front also on the back" ${ro ? 'disabled' : ''}>${ICON.mirrory}<span>Y</span></button>
            <button type="button" data-sym="2" title="Mirror Z: what is on the bottom also on the top" ${ro ? 'disabled' : ''}>${ICON.mirrorz}<span>Z</span></button>
          </div>
          <div class="cad-sec-t">Flip in place</div>
          <div class="cad-iconrow">
            <button type="button" data-mirror="0" title="Flip X: turn it over left ↔ right" ${ro ? 'disabled' : ''}>${ICON.flip}<span>X</span></button>
            <button type="button" data-mirror="1" title="Flip Y: turn it over front ↔ back" ${ro ? 'disabled' : ''}>${ICON.flip}<span>Y</span></button>
            <button type="button" data-mirror="2" title="Flip Z: turn it over top ↔ bottom" ${ro ? 'disabled' : ''}>${ICON.flip}<span>Z</span></button>
            <button type="button" data-cutstart title="Cut with a plane: split into 2 objects or keep one side" ${ro ? 'disabled' : ''}>Cut…</button>
          </div>
          ${this.sel && !this.multi.length && (this._item(this.sel) || {}).type !== 'image' ? `<button type="button" class="cad-wide-btn cad-combine" data-splitwith ${ro ? 'disabled' : ''} title="Every Solid this shape overlaps is split into the part outside it and the part inside it — no gap">Split objects with this shape</button>` : ''}
          <details class="cad-pattern"><summary>Pattern…</summary>
            <div class="cad-seg2"><button type="button" data-pkind="linear" class="${this._pkind !== 'circular' ? 'on' : ''}">Row</button><button type="button" data-pkind="circular" class="${this._pkind === 'circular' ? 'on' : ''}">Circle</button></div>
            <div class="cad-grid">
              <label class="cad-field wide"><span class="cad-scrub">Count</span><input type="text" inputmode="numeric" data-pn value="${this._pn || 4}"><em>total</em></label>
              ${this._pkind === 'circular'
                ? `<label class="cad-field"><span class="cad-scrub">Angle</span><input type="text" inputmode="decimal" data-pangle value="${this._pangle == null ? 360 : this._pangle}"><em>°</em></label>
                   <label class="cad-field"><span class="cad-scrub">X</span><input type="text" inputmode="decimal" data-pcx value="${this._pcx || 0}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">Y</span><input type="text" inputmode="decimal" data-pcy value="${this._pcy || 0}"><em>mm</em></label>`
                : `<label class="cad-field"><span class="cad-scrub">ΔX</span><input type="text" inputmode="decimal" data-pdx value="${this._pdx == null ? 10 : this._pdx}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">ΔY</span><input type="text" inputmode="decimal" data-pdy value="${this._pdy || 0}"><em>mm</em></label>
                   <label class="cad-field"><span class="cad-scrub">ΔZ</span><input type="text" inputmode="decimal" data-pdz value="${this._pdz || 0}"><em>mm</em></label>`}
            </div>
            <p class="cad-hint">${this._pkind === 'circular' ? 'Copies around a vertical axis through X, Y (360° spreads them evenly).' : 'Each copy steps by ΔX / ΔY / ΔZ from the previous one.'}</p>
            <button type="button" class="cad-wide-btn" data-pmake ${ro ? 'disabled' : ''}>Make copies</button>
          </details>
        </div>
        <div class="cad-sec-t" style="margin-top:8px">${gid ? 'Parts — tap one to edit it' : 'Selected'}</div>
        <div class="cad-sel-list">${items.map((i) => `<button type="button" data-only="${esc(i.id)}" title="${gid ? 'Edit just this part' : 'Select only this'}"><span class="cad-dot ${i.role}"></span>${esc(i.name)}</button>`).join('')}</div>
        ${gid
          ? `<button type="button" class="cad-wide-btn" data-uncombine ${ro ? 'disabled' : ''}>Uncombine</button>`
          : `<button type="button" class="cad-wide-btn cad-combine" data-combine ${ro ? 'disabled' : ''} title="Make these one object — positions and sizes stay the same">Combine into one object</button>`}
        <div class="cad-actions">
          <button type="button" data-mdup ${ro ? 'disabled' : ''}>Duplicate</button>
          <button type="button" data-mdel class="danger" ${ro ? 'disabled' : ''}>Delete</button>
        </div>`;
      this._renderDims();
      el.querySelector('[data-close]').onclick = () => this._select(null);
      el.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => { this._editMany(this.multi.slice(), (it) => { if (it.type !== 'image') it.role = b.dataset.role; }); this._inspFor = null; this._renderInspector(); }; });
      el.querySelectorAll('[data-align]').forEach((b) => { b.onclick = () => { const [a, w] = b.dataset.align.split(':'); this._align(a, w); }; });
      el.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => this._groupAction(b.dataset.g); });
      el.querySelector('[data-mq="hide"]').onclick = () => { const ids2 = this.multi.slice(); this._editMany(ids2, (it) => { it.hidden = true; }); this._select(null); };
      el.querySelectorAll('[data-only]').forEach((b) => { b.onclick = () => this._select(b.dataset.only, true); });
      const cb = el.querySelector('[data-combine]'); if (cb) cb.onclick = () => this._combine();
      el.querySelectorAll('[data-mirror]').forEach((b) => { b.onclick = () => this._mirror(+b.dataset.mirror); });
      el.querySelectorAll('[data-sym]').forEach((b) => { b.onclick = () => this._symMirror(+b.dataset.sym); });
      el.querySelectorAll('[data-cutstart]').forEach((b) => { b.onclick = () => this._cutStart(); });
      el.querySelectorAll('[data-splitwith]').forEach((b) => { b.onclick = () => this._splitWith(this.sel); });
      const pat = el.querySelector('.cad-pattern');
      if (pat) {
        if (this._patOpen) pat.open = true;
        pat.addEventListener('toggle', () => { this._patOpen = pat.open; });
        pat.querySelectorAll('[data-pkind]').forEach((b) => { b.onclick = () => { this._pkind = b.dataset.pkind; this._inspFor = null; this._renderInspector(); }; });
        const val = (sel, d) => { const i = pat.querySelector(sel); return i ? evalNum(i.value, d) : d; };
        const keep = () => { this._pn = val('[data-pn]', this._pn || 4); this._pangle = val('[data-pangle]', this._pangle == null ? 360 : this._pangle); this._pcx = val('[data-pcx]', this._pcx || 0); this._pcy = val('[data-pcy]', this._pcy || 0); this._pdx = val('[data-pdx]', this._pdx == null ? 10 : this._pdx); this._pdy = val('[data-pdy]', this._pdy || 0); this._pdz = val('[data-pdz]', this._pdz || 0); };
        pat.querySelectorAll('input').forEach((i) => { i.onchange = keep; i.onkeydown = (e) => { if (e.key === 'Enter') { keep(); i.blur(); } }; });
        pat.querySelector('[data-pmake]').onclick = () => { keep(); this._pattern(this._pkind === 'circular' ? { kind: 'circular', n: this._pn, angle: this._pangle, cx: this._pcx, cy: this._pcy } : { kind: 'linear', n: this._pn, dx: this._pdx, dy: this._pdy, dz: this._pdz }); };
      }
      const ub = el.querySelector('[data-uncombine]'); if (ub) ub.onclick = () => this._uncombine(gid);
      const gn = el.querySelector('[data-gname]');
      if (gn) { gn.onchange = () => { const v = gn.value.trim(); if (!v || !this.data.groups[gid]) return; this._snapshot(); this.data.groups[gid].name = v.slice(0, 80); this._changed(); this._renderList(); }; gn.onkeydown = (e) => { if (e.key === 'Enter') gn.blur(); }; }
      el.querySelector('[data-mdup]').onclick = () => this._duplicateMany(this.multi.slice());
      el.querySelector('[data-mdel]').onclick = () => this._deleteMany(this.multi.slice());
    }
    _renderMsgs() {
      const box = this.inspEl.querySelector('.cad-msgs'); if (!box) return;
      const e = this.errors[this.sel], n = this.notes[this.sel];
      const fl = this.floating && this.floating[this.sel];
      box.innerHTML = (e ? '<p class="cad-msg err">' + esc(e) + '</p>' : '') + (n ? '<p class="cad-msg">' + esc(n) + '</p>' : '')
        + (fl != null ? '<p class="cad-msg">Floating ' + fl + ' mm above the build plate — it would need support. <button type="button" class="cad-msg-btn" data-dropfloat>Drop to floor</button></p>' : '');
      const db = box.querySelector('[data-dropfloat]');
      if (db) db.onclick = () => { const o = this.objs[this.sel]; if (!o) return; const b = this._boundsOf(this._gid(this.sel) ? this._members(this._gid(this.sel)) : [this.sel]); const dz = b.min.z; this._editMany(this._gid(this.sel) ? this._members(this._gid(this.sel)) : [this.sel], (it) => { it.pos[2] = r3(it.pos[2] - dz); }); };
      this._renderDims();
    }
    // Overall size of the selected object along X / Y / Z, measured from its
    // geometry after rotation (what you would measure on the print bed).
    _renderDims() {
      const box = this.inspEl && this.inspEl.querySelector('.cad-dims'); if (!box) return;
      let d = null;
      if (this.T) { const b = this._boundsOf(this._selIds()); if (!b.isEmpty()) d = b.getSize(new this.T.Vector3()); }
      const f = (v) => (d ? String(Math.round(v * 100) / 100) : '–');
      box.innerHTML = '<span class="cad-sec-t">Size</span>'
        + '<span class="dx"><i>X</i>' + f(d && d.x) + '</span><span class="dy"><i>Y</i>' + f(d && d.y) + '</span><span class="dz"><i>Z</i>' + f(d && d.z) + '</span><em>mm</em>';
    }
    _wireInspector(id) {
      const el = this.inspEl;
      const setPath = (it, f, v) => {
        const parts = f.split('.');
        if (parts[0] === 'profiles') { const pr = it.profiles[+parts[1]]; if (!pr) return; if (parts[2] === 'd') pr.r = v / 2; else pr[parts[2]] = v; return; }
        const [k, i] = parts; if (i == null) it[k] = v; else if (Array.isArray(it[k])) it[k][+i] = v; else it[k] = Object.assign({}, it[k], { [i]: v }); };
      const getPath = (it, f) => {
        const parts = f.split('.');
        if (parts[0] === 'profiles') { const pr = it.profiles[+parts[1]] || {}; return parts[2] === 'd' ? r3((pr.r || 0) * 2) : pr[parts[2]]; }
        const [k, i] = parts; return i == null ? it[k] : it[k][Array.isArray(it[k]) ? +i : i]; };
      el.querySelector('[data-close]').onclick = () => this._select(null);
      const sepb = el.querySelector('[data-separate]'); if (sepb) sepb.onclick = () => this._separate(id);
      const uc = el.querySelector('[data-uncut]'); if (uc) uc.onclick = (e) => { e.preventDefault(); this._edit(id, (x) => { delete x.clip; delete x.cuts; }); };
      const sg = el.querySelector('[data-selgroup]'); if (sg) sg.onclick = (e) => { e.preventDefault(); this._select(id); };
      const nm = el.querySelector('[data-name]');
      nm.onchange = () => this._edit(id, (it) => { it.name = nm.value.trim() || it.name; }, false);
      nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); };
      el.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => { this._edit(id, (it) => { it.role = b.dataset.role; if (it.type === 'model' && it.role !== 'ref' && it.fit === 'exact' && !it._fitChosen) it.fit = 'exact'; }); this._renderInspector(); }; });
      el.querySelectorAll('[data-fit]').forEach((b) => { b.onclick = () => { this._edit(id, (it) => { it.fit = b.dataset.fit; }); this._renderInspector(); }; });
      el.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        const apply = () => {
          const it = this._item(id); if (!it) return;
          const v = evalNum(inp.value, getPath(it, f));
          if (v === getPath(it, f)) { inp.value = v; return; }
          this._edit(id, (x) => setPath(x, f, v));
          const now = getPath(this._item(id), f); inp.value = now;
        };
        inp.onchange = apply;
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') { apply(); inp.select(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = (+inp.parentElement.querySelector('[data-scrub]').dataset.step || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            inp.value = r3(evalNum(inp.value, 0) + step); apply();
          }
        };
        inp.onfocus = () => setTimeout(() => inp.select(), 0);
      });
      // Drag a field's label left/right to change it — works with mouse, trackpad, Pencil and touch.
      el.querySelectorAll('[data-scrub]').forEach((lab) => {
        if (this.readOnly) return;
        const f = lab.dataset.scrub; const step = +lab.dataset.step || 0.5; const min = lab.dataset.min != null ? +lab.dataset.min : -1e5;
        lab.onpointerdown = (e) => {
          const it = this._item(id); if (!it) return;
          e.preventDefault(); lab.setPointerCapture(e.pointerId);
          const x0 = e.clientX; const v0 = +getPath(it, f) || 0; let moved = false; let snapped = false;
          const inp = lab.parentElement.querySelector('input');
          lab.onpointermove = (ev) => {
            const dx = ev.clientX - x0;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) { moved = true; this._snapshot(); }
            const v = Math.max(min, r3(Math.round((v0 + (dx / 4) * step) / step) * step));
            const cur = this._item(id); if (!cur) return;
            setPath(cur, f, v); Object.assign(cur, C.normalizeItem(cur)); inp.value = getPath(cur, f); snapped = true;
            if (f.startsWith('pos') || f.startsWith('rot')) this._refreshItems();
            this._requestBuild(true);
          };
          lab.onpointerup = () => {
            lab.onpointermove = null; lab.onpointerup = null;
            if (!moved) { inp.focus(); return; }
            if (snapped) { this._changed(); this._renderChrome(); this._refreshItems(); }
          };
        };
      });
      el.querySelectorAll('[data-q]').forEach((b) => {
        b.onclick = () => {
          const k = b.dataset.q;
          if (k === 'floor') {
            const o = this.objs[id]; if (!o) return;
            const box = new this.T.Box3().setFromObject(o.mesh);
            this._edit(id, (it) => { it.pos[2] = r3(it.pos[2] - box.min.z); });
          } else if (k === 'center') this._edit(id, (it) => { it.pos[0] = 0; it.pos[1] = 0; });
          else { const ax = { rx: 0, ry: 1, rz: 2 }[k]; this._edit(id, (it) => { it.rot[ax] = r3(((it.rot[ax] + 90 + 180) % 360) - 180); }); }
          this._fillTransform();
        };
      });
      el.querySelectorAll('[data-editcode]').forEach((b) => { b.onclick = () => this._codeEditor(id); });
      el.querySelectorAll('[data-units]').forEach((b) => { b.onclick = () => this._edit(id, (it) => { it.units = b.dataset.units; }); });
      const lk = el.querySelector('[data-lock]'); if (lk) lk.onclick = () => { this._lockProp = this._lockProp === false; this._inspFor = null; this._renderInspector(); };
      const rs = el.querySelector('[data-resetsize]'); if (rs) rs.onclick = () => this._edit(id, (it) => { it.scale = 1; it.stretch = [1, 1, 1]; it.units = 'mm'; });
      el.querySelectorAll('[data-msize]').forEach((inp) => {
        const i = +inp.dataset.msize;
        const apply = () => {
          const it = this._item(id); const base = this.info && this.info[id] && this.info[id].base; if (!it || !base) return;
          const u = { mm: 1, cm: 10, in: 25.4, m: 1000 }[it.units] || 1;
          const cur = base[i] * u * it.scale * it.stretch[i];
          const v = evalNum(inp.value, cur);
          if (!(v > 0) || Math.abs(v - cur) < 1e-9 || !(cur > 0)) { inp.value = r3(cur); return; }
          const f = v / cur;
          // Locked: all three scale together. Unlocked: only this axis stretches.
          this._edit(id, (x) => { if (this._lockProp === false) x.stretch[i] = x.stretch[i] * f; else x.scale = x.scale * f; });
        };
        inp.onchange = apply;
        inp.onkeydown = (e) => { if (e.key === 'Enter') { apply(); inp.select(); } };
        inp.onfocus = () => setTimeout(() => inp.select(), 0);
      });
      el.querySelectorAll('[data-pcut]').forEach((b) => { b.onclick = () => this._edit(id, (it) => { const pr = it.profiles[+b.dataset.pcut]; if (pr) pr.cut = !pr.cut; }); });
      el.querySelectorAll('[data-pdel]').forEach((b) => { b.onclick = () => this._edit(id, (it) => { it.profiles.splice(+b.dataset.pdel, 1); }); });
      el.querySelectorAll('[data-mirror]').forEach((b) => { b.onclick = () => this._mirror(+b.dataset.mirror); });
      el.querySelectorAll('[data-sym]').forEach((b) => { b.onclick = () => this._symMirror(+b.dataset.sym); });
      el.querySelectorAll('[data-cutstart]').forEach((b) => { b.onclick = () => this._cutStart(); });
      el.querySelectorAll('[data-splitwith]').forEach((b) => { b.onclick = () => this._splitWith(this.sel); });
      const pat = el.querySelector('.cad-pattern');
      if (pat) {
        if (this._patOpen) pat.open = true;
        pat.addEventListener('toggle', () => { this._patOpen = pat.open; });
        pat.querySelectorAll('[data-pkind]').forEach((b) => { b.onclick = () => { this._pkind = b.dataset.pkind; this._inspFor = null; this._renderInspector(); }; });
        const val = (sel, d) => { const i = pat.querySelector(sel); return i ? evalNum(i.value, d) : d; };
        const keep = () => { this._pn = val('[data-pn]', this._pn || 4); this._pangle = val('[data-pangle]', this._pangle == null ? 360 : this._pangle); this._pcx = val('[data-pcx]', this._pcx || 0); this._pcy = val('[data-pcy]', this._pcy || 0); this._pdx = val('[data-pdx]', this._pdx == null ? 10 : this._pdx); this._pdy = val('[data-pdy]', this._pdy || 0); this._pdz = val('[data-pdz]', this._pdz || 0); };
        pat.querySelectorAll('input').forEach((i) => { i.onchange = keep; i.onkeydown = (e) => { if (e.key === 'Enter') { keep(); i.blur(); } }; });
        pat.querySelector('[data-pmake]').onclick = () => { keep(); this._pattern(this._pkind === 'circular' ? { kind: 'circular', n: this._pn, angle: this._pangle, cx: this._pcx, cy: this._pcy } : { kind: 'linear', n: this._pn, dx: this._pdx, dy: this._pdy, dz: this._pdz }); };
      }
      const em = el.querySelector('[data-edgemode]'); if (em) em.onclick = () => this._edgeModeStart(id);
      const exb = el.querySelector('[data-extrude]'); if (exb) exb.onclick = () => this._extrudeStart(id);
      el.querySelectorAll('[data-dplane]').forEach((b) => { b.onclick = () => this._setDraftPlane(id, b.dataset.dplane); });
      const doff = el.querySelector('[data-doff]'); if (doff) doff.onchange = () => this._setDraftPlane(id, this._planeOf(this._item(id)) || 'xy', evalNum(doff.value, 0));
      const es = el.querySelector('[data-editsketch]');
      if (es) es.onclick = () => this._sketchStart(id);
      el.querySelector('[data-dup]').onclick = () => this._duplicate(id);
      el.querySelector('[data-del]').onclick = () => this._delete(id);
    }

    // ---------- sketch ----------
    // Draw on the sketch item's own XY plane (the floor for a new sketch):
    // Line (tap points, tap the first to close), Rectangle (two corners),
    // Circle (centre, edge). Taps snap to existing points, then to the grid.
    // Done re-centres the profiles on the item and builds it with its height.
    _sketchStart(id, onFace) {
      if (this.readOnly) return;
      if (this.faceOn) this._faceMode(false);
      if (this.measureOn) this._measureMode(false);
      let it = id ? this._item(id) : null;
      this._snapshot();
      let isNew = false;
      if (!it) {
        const t = this.target || { x: 0, y: 0 };
        const sn = (v) => (this.snapOn && this.data.settings.snap ? Math.round(v / this.data.settings.snap) * this.data.settings.snap : r3(v));
        it = C.newItem('sketch', onFace ? { name: this._uniqueName('Sketch'), pos: onFace.pos, rot: onFace.rot, height: 0.05, draft: true } : { name: this._uniqueName('Sketch'), pos: [sn(t.x), sn(t.y), 0], height: 0.05, draft: true });
        this.data.items.push(it);
        isNew = true;
      }
      const T = this.T;
      const frame = new T.Object3D(); frame.rotation.order = 'ZYX'; this._placeObj(frame, it); frame.updateMatrixWorld(true);
      this.sk = { id: it.id, isNew, before: JSON.stringify(it.profiles), tool: this._skTool || 'rect', pts: [], hover: null, frame, group: new T.Group() };
      this.sk.group.matrixAutoUpdate = false; this.sk.group.matrix.copy(frame.matrixWorld);
      this.scene.add(this.sk.group);
      this.sel = null; this.multi = []; this._refreshItems();
      // Look straight at the sketch plane.
      const n = new T.Vector3(0, 0, 1).applyQuaternion(frame.quaternion);
      const c = new T.Vector3().setFromMatrixPosition(frame.matrixWorld);
      const dist = Math.max(120, this.camera.position.distanceTo(this.target));
      this._setOrtho(true);
      this.target.copy(c);
      this.camera.position.copy(c).add(n.clone().multiplyScalar(dist)).add(new T.Vector3(0, -1e-4, 0));
      this.camera.lookAt(c);
      this._markView(null);
      this.root.classList.add('cad-sketching');
      this.root.querySelectorAll('[data-skplane]').forEach((b) => b.classList.toggle('on', b.dataset.skplane === (onFace ? '' : (this._skPlane || 'xy'))));
      this.root.querySelector('.cad-skplane').classList.toggle('hidden', !isNew || !!(onFace && !onFace.plane));
      this.root.querySelector('.cad-skbar').classList.remove('hidden');
      this._sketchTool(this.sk.tool);
      this._renderChrome();
    }
    _sketchTool(t) {
      if (!this.sk) return;
      this.sk.tool = this._skTool = t; this.sk.pts = []; this.sk.pend = null;
      if (t !== 'line' && this.sk.arc) this.sk.arc = false;
      this.root.querySelectorAll('[data-sktool]').forEach((b) => b.classList.toggle('on', b.dataset.sktool === t));
      this._sketchDraw();
    }
    _sketchItem() { return this.sk && this._item(this.sk.id); }
    // Pointer -> point on the sketch plane, in sketch coordinates, snapped.
    _sketchPoint(e) {
      const T = this.T;
      const rc = this._ray(e);
      const m = this.sk.frame.matrixWorld;
      const n = new T.Vector3(0, 0, 1).transformDirection(m);
      const o = new T.Vector3().setFromMatrixPosition(m);
      const hit = new T.Vector3();
      if (!rc.ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(n, o), hit)) return null;
      const inv = m.clone().invert();
      const l = hit.clone().applyMatrix4(inv);
      let x = l.x, y = l.y, snapped = false;
      // Snap to existing points within ~12 px.
      const r = this.renderer.domElement.getBoundingClientRect();
      let best = 12;
      for (const q of this._sketchVertices()) {
        const sp = new T.Vector3(q[0], q[1], 0).applyMatrix4(m).project(this.camera);
        const d = Math.hypot((sp.x + 1) / 2 * r.width + r.left - e.clientX, (1 - sp.y) / 2 * r.height + r.top - e.clientY);
        if (d < best) { best = d; x = q[0]; y = q[1]; snapped = true; }
      }
      const g = this.snapOn ? this.data.settings.snap : 0;
      if (!snapped && g) { x = Math.round(x / g) * g; y = Math.round(y / g) * g; }
      return { x: r3(x), y: r3(y), snapped };
    }
    // Outline of a profile as a closed list of [x, y] points (arcs sampled).
    _arcPts(a, m, b, N) {
      const ax = a[0], ay = a[1], bx = b[0], by = b[1], mx = m[0], my = m[1];
      const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
      if (Math.abs(d) < 1e-9) return [[bx, by]]; // collinear: straight
      const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
      const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
      const r = Math.hypot(ax - ux, ay - uy);
      const t0 = Math.atan2(ay - uy, ax - ux), tm = Math.atan2(my - uy, mx - ux), t1 = Math.atan2(by - uy, bx - ux);
      const norm = (t) => { while (t < 0) t += 2 * Math.PI; while (t >= 2 * Math.PI) t -= 2 * Math.PI; return t; };
      let sweep = norm(t1 - t0); if (norm(tm - t0) > sweep) sweep -= 2 * Math.PI; // go the way that passes through m
      const n = N || Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
      const out = []; for (let i = 1; i <= n; i++) { const t = t0 + sweep * i / n; out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]); }
      return out;
    }
    _outline(p) {
      const rot = (pts, a, x, y) => { const c = Math.cos(a * DEG), sn = Math.sin(a * DEG); return pts.map(([u, v]) => [x + u * c - v * sn, y + u * sn + v * c]); };
      if (p.k === 'rect') { const a = p.w / 2, b = p.h / 2; return [[p.x - a, p.y - b], [p.x + a, p.y - b], [p.x + a, p.y + b], [p.x - a, p.y + b]]; }
      if (p.k === 'circle') { const N = 72; return [...Array(N)].map((_, i) => [p.x + p.r * Math.cos(i / N * 2 * Math.PI), p.y + p.r * Math.sin(i / N * 2 * Math.PI)]); }
      if (p.k === 'slot') {
        const R = p.h / 2, sh = (p.w - p.h) / 2, pts = [];
        for (let i = 0; i <= 18; i++) { const t = -Math.PI / 2 + Math.PI * i / 18; pts.push([sh + R * Math.cos(t), R * Math.sin(t)]); }
        for (let i = 0; i <= 18; i++) { const t = Math.PI / 2 + Math.PI * i / 18; pts.push([-sh + R * Math.cos(t), R * Math.sin(t)]); }
        return rot(pts, p.a || 0, p.x, p.y);
      }
      if (p.k === 'ngon') return rot([...Array(p.n)].map((_, i) => { const t = -(2 * Math.PI / p.n) * i; return [p.r * Math.sin(t), p.r * Math.cos(t)]; }), p.a || 0, p.x, p.y);
      // poly with optional arcs
      const P = p.pts; const out = [[P[0][0], P[0][1]]];
      for (let i = 1; i <= P.length; i++) {
        const q = P[i % P.length]; const prev = out[out.length - 1];
        if (q.length >= 4) out.push(...this._arcPts(prev, [q[2], q[3]], [q[0], q[1]]));
        else if (i < P.length) out.push([q[0], q[1]]);
      }
      if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
      return out;
    }
    _sketchVertices() {
      const it = this._sketchItem(); const out = [];
      if (!it) return out;
      for (const p of it.profiles) {
        if (p.k === 'rect') { this._outline(p).forEach((q) => out.push(q)); out.push([p.x, p.y]); }
        else if (p.k === 'circle') out.push([p.x, p.y], [p.x + p.r, p.y], [p.x - p.r, p.y], [p.x, p.y + p.r], [p.x, p.y - p.r]);
        else if (p.k === 'slot') { const c = Math.cos((p.a || 0) * DEG), sn = Math.sin((p.a || 0) * DEG), sh = (p.w - p.h) / 2; out.push([p.x, p.y], [p.x + sh * c, p.y + sh * sn], [p.x - sh * c, p.y - sh * sn]); }
        else if (p.k === 'ngon') { out.push([p.x, p.y]); this._outline(p).forEach((q) => out.push(q)); }
        else p.pts.forEach((q) => out.push([q[0], q[1]]));
      }
      this.sk.pts.forEach((q) => out.push([q[0], q[1]]));
      if (this.sk.pend) out.push(this.sk.pend);
      return out;
    }
    // Move a new, still-empty sketch onto another plane: XY (floor, normal +Z),
    // XZ (front, normal −Y) or YZ (side, normal +X), at an offset along the normal.
    _planeOf(it) { const r = (it.rot || [0, 0, 0]).map((v) => ((Math.round(v) % 360) + 360) % 360).join(','); return { '0,0,0': 'xy', '90,0,0': 'xz', '0,90,0': 'yz' }[r] || ''; }
    _planeOff(it) { const pl = this._planeOf(it); return r3(pl === 'xz' ? -it.pos[1] : pl === 'yz' ? it.pos[0] : it.pos[2]); }
    // Move a 2D sketch onto XY / XZ / YZ, keeping its drawing.
    _setDraftPlane(id, pl, off) {
      const it = this._item(id); if (!it || this.readOnly) return;
      if (off == null) off = this._planeOf(it) === pl ? this._planeOff(it) : 0;
      this._edit(id, (x) => {
        x.rot = { xy: [0, 0, 0], xz: [90, 0, 0], yz: [0, 90, 0] }[pl];
        const c = x.pos.slice();
        x.pos = ({ xy: [c[0], c[1], off], xz: [c[0], -off, c[2]], yz: [off, c[1], c[2]] })[pl].map(r3);
      });
      this._inspFor = null; this._select(id);
    }
    _sketchPlane(pl) {
      const sk = this.sk; const it = this._sketchItem(); if (!sk || !it || !sk.isNew || it.profiles.length || sk.pts.length) { this._toast('Pick the plane before drawing', 'err'); return; }
      const off = evalNum(this.root.querySelector('[data-skoff]').value, 0);
      this._skPlane = pl;
      const rot = { xy: [0, 0, 0], xz: [90, 0, 0], yz: [0, 90, 0] }[pl];
      const pos = { xy: [it.pos[0], it.pos[1], off], xz: [it.pos[0], -off, it.pos[2] || 0], yz: [off, it.pos[1], it.pos[2] || 0] }[pl];
      it.rot = rot; it.pos = pos.map(r3);
      const id = it.id; const keepUndo = this.undoStack.length;
      this._sketchEnd(false, true); // discard the empty sketch quietly…
      this.undoStack.length = Math.min(this.undoStack.length, keepUndo);
      this._sketchStart(null, { pos: it.pos, rot: it.rot }); // …and start again on the new plane
      void id;
      this.root.querySelectorAll('[data-skplane]').forEach((b) => b.classList.toggle('on', b.dataset.skplane === pl));
    }
    _sketchOpt(k) {
      if (!this.sk) return;
      if (k === 'arc') { this.sk.arc = !this.sk.arc; if (!this.sk.arc) this.sk.pend = null; if (this.sk.arc && this.sk.tool !== 'line') this._sketchTool('line'); }
      if (k === 'cut') this.sk.cut = !this.sk.cut;
      this._sketchChrome(); this._sketchDraw();
    }
    _sketchChrome() {
      const sk = this.sk; if (!sk) return;
      const q = (x) => this.root.querySelector(x);
      this.root.querySelectorAll('[data-sktool]').forEach((b) => b.classList.toggle('on', b.dataset.sktool === sk.tool));
      q('[data-skarc]').classList.toggle('on', !!sk.arc);
      q('[data-skcut]').classList.toggle('on', !!sk.cut);
      q('[data-skslotw-wrap]').classList.toggle('hidden', sk.tool !== 'slot');
      q('[data-sksides-wrap]').classList.toggle('hidden', sk.tool !== 'ngon');
      q('[data-skslotw]').value = this._skSlotW || 6; q('[data-sksides]').value = this._skSides || 6;
      this.root.classList.toggle('cad-skcut', !!sk.cut);
    }
    _sketchMove(e) { this.sk.hover = this._sketchPoint(e); this._sketchDraw(); }
    _sketchClick(e) {
      const p = this._sketchPoint(e);
      if (!p) return;
      const it = this._sketchItem(); const sk = this.sk;
      const add = (prof) => { const pr = C.normalizeProfile(Object.assign(prof, sk.cut ? { cut: true } : {})); if (pr) it.profiles.push(pr); sk.pts = []; sk.pend = null; };
      const same = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
      if (sk.tool === 'line') {
        const first = sk.pts[0]; const pt = [p.x, p.y];
        if (sk.pend) { // second tap of an arc: the point it bends through
          const end = sk.pend; sk.pend = null;
          if (same(end, first)) { sk.pts[0] = [first[0], first[1], pt[0], pt[1]]; add({ k: 'poly', pts: sk.pts.slice() }); }
          else sk.pts.push([end[0], end[1], pt[0], pt[1]]);
        } else if (sk.arc && sk.pts.length) {
          if (!same(pt, sk.pts[sk.pts.length - 1])) sk.pend = pt;
        } else if (first && sk.pts.length >= 3 && same(pt, first)) add({ k: 'poly', pts: sk.pts.slice() });
        else if (!sk.pts.length || !same(pt, sk.pts[sk.pts.length - 1])) sk.pts.push(pt);
      } else if (!sk.pts.length) sk.pts.push([p.x, p.y]);
      else {
        const [ax, ay] = sk.pts[0];
        const dist = Math.hypot(p.x - ax, p.y - ay), ang = Math.atan2(p.y - ay, p.x - ax) / DEG;
        if (sk.tool === 'rect') { const w = Math.abs(p.x - ax), h = Math.abs(p.y - ay); if (w > 0.04 && h > 0.04) add({ k: 'rect', x: (ax + p.x) / 2, y: (ay + p.y) / 2, w, h }); }
        else if (sk.tool === 'circle') { if (dist > 0.04) add({ k: 'circle', x: ax, y: ay, r: dist }); }
        else if (sk.tool === 'slot') { const W = this._skSlotW || 6; if (dist > 0.04) add({ k: 'slot', x: (ax + p.x) / 2, y: (ay + p.y) / 2, w: r3(dist + W), h: W, a: r3(ang) }); }
        else if (sk.tool === 'ngon') { if (dist > 0.04) add({ k: 'ngon', x: ax, y: ay, r: r3(dist), n: this._skSides || 6, a: r3(ang - 90) }); }
      }
      sk.hover = p;
      this._sketchDraw();
    }
    _sketchUndo() {
      const sk = this.sk; if (!sk) return;
      if (sk.pend) sk.pend = null;
      else if (sk.pts.length) sk.pts.pop();
      else { const it = this._sketchItem(); if (it && it.profiles.length) it.profiles.pop(); }
      this._sketchDraw();
    }
    _sketchDraw() {
      const sk = this.sk; if (!sk) return;
      const T = this.T; const it = this._sketchItem(); if (!it) return;
      sk.group.children.forEach((o) => o.geometry && o.geometry.dispose());
      sk.group.clear();
      const lineMat = (c, op) => new T.LineBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: op });
      const ls = (arr, mat) => { if (!arr.length) return; const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(arr, 3)); const l = new T.LineSegments(g, mat); l.renderOrder = 11; sk.group.add(l); };
      const loopSegs = (pts, closed) => { const out = []; const n = pts.length; for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n]; out.push(a[0], a[1], 0.05, b[0], b[1], 0.05); } return out; };
      const solid = [], cuts = [];
      for (const p of it.profiles) {
        const o = this._outline(p);
        (p.cut ? cuts : solid).push(...loopSegs(o, true));
        const m = new T.Mesh(new T.ShapeGeometry(new T.Shape(o.map((q) => new T.Vector2(q[0], q[1]))), 1), new T.MeshBasicMaterial({ color: p.cut ? this.colors.hole : this.colors.accent, transparent: true, opacity: p.cut ? 0.22 : 0.14, depthTest: false, side: T.DoubleSide }));
        m.position.z = p.cut ? 0.06 : 0.04; m.renderOrder = 10; sk.group.add(m);
      }
      ls(solid, lineMat(this.colors.accent, 1));
      ls(cuts, lineMat(this.colors.hole, 1));
      // Rubber band to the pointer.
      const h = sk.hover; let draft = []; let hint = '';
      const col = sk.cut ? this.colors.hole : this.colors.accent;
      if (h && sk.tool === 'line' && sk.pts.length) {
        const pts = this._outline({ k: 'poly', pts: sk.pts.length > 1 ? sk.pts : [sk.pts[0], sk.pts[0], sk.pts[0]] }).slice(0, sk.pts.length > 1 ? undefined : 1);
        const open = []; // the drawn polyline so far (without the closing segment)
        open.push([sk.pts[0][0], sk.pts[0][1]]);
        for (let i = 1; i < sk.pts.length; i++) { const q = sk.pts[i]; if (q.length >= 4) open.push(...this._arcPts(open[open.length - 1], [q[2], q[3]], [q[0], q[1]])); else open.push([q[0], q[1]]); }
        void pts;
        draft = loopSegs(open, false);
        const last = open[open.length - 1];
        if (sk.pend) { const arc = [last, ...this._arcPts(last, [h.x, h.y], sk.pend)]; draft.push(...loopSegs(arc, false)); hint = 'Tap where the arc bends through'; }
        else { draft.push(last[0], last[1], 0.05, h.x, h.y, 0.05); hint = r3(Math.hypot(h.x - last[0], h.y - last[1])) + ' mm' + (sk.arc ? ' · arc: tap its end' : '') + (sk.pts.length >= 3 || (sk.arc && sk.pts.length >= 2) ? ' · tap the first point to close' : ''); }
      } else if (h && sk.pts.length) {
        const [ax, ay] = sk.pts[0]; const dist = Math.hypot(h.x - ax, h.y - ay), ang = Math.atan2(h.y - ay, h.x - ax) / DEG;
        let o = null;
        if (sk.tool === 'rect') { o = this._outline({ k: 'rect', x: (ax + h.x) / 2, y: (ay + h.y) / 2, w: Math.abs(h.x - ax), h: Math.abs(h.y - ay) }); hint = r3(Math.abs(h.x - ax)) + ' × ' + r3(Math.abs(h.y - ay)) + ' mm'; }
        else if (sk.tool === 'circle') { o = this._outline({ k: 'circle', x: ax, y: ay, r: dist }); hint = 'Ø ' + r3(dist * 2) + ' mm'; }
        else if (sk.tool === 'slot') { const W = this._skSlotW || 6; o = this._outline({ k: 'slot', x: (ax + h.x) / 2, y: (ay + h.y) / 2, w: dist + W, h: W, a: ang }); hint = 'Slot ' + r3(dist + W) + ' × ' + W + ' mm · ' + r3(ang) + '°'; }
        else if (sk.tool === 'ngon') { o = this._outline({ k: 'ngon', x: ax, y: ay, r: dist, n: this._skSides || 6, a: ang - 90 }); hint = (this._skSides || 6) + '-sided · Ø ' + r3(dist * 2) + ' mm (corners)'; }
        if (o) draft = loopSegs(o, true);
      }
      ls(draft, lineMat(col, 0.65));
      const pts = sk.pts.map((q) => [q[0], q[1]]); if (sk.pend) pts.push(sk.pend); if (h) pts.push([h.x, h.y]);
      if (pts.length) {
        const g = new T.BufferGeometry().setFromPoints(pts.map((q) => new T.Vector3(q[0], q[1], 0.05)));
        const pm = new T.Points(g, new T.PointsMaterial({ color: h && h.snapped ? this.colors.hole : col, size: 9, sizeAttenuation: false, depthTest: false }));
        pm.renderOrder = 12; sk.group.add(pm);
      }
      const tips = { line: 'Tap points — tap the first point to close', rect: 'Tap two corners', circle: 'Tap the centre, then the edge', slot: 'Tap the centre of one end, then the other', ngon: 'Tap the centre, then a corner' };
      const n = it.profiles.length;
      this.root.querySelector('.cad-skhint').textContent = hint || ((sk.cut ? 'Cut: ' : '') + tips[sk.tool] + (n ? ' · ' + n + ' shape' + (n > 1 ? 's' : '') : ''));
      this._sketchChrome();
    }
    _sketchEnd(keep, quiet) {
      const sk = this.sk; if (!sk) return;
      const it = this._sketchItem();
      this.scene.remove(sk.group); sk.group.traverse((o) => o.geometry && o.geometry.dispose());
      this.sk = null;
      this.root.classList.remove('cad-sketching', 'cad-skcut');
      this.root.querySelector('.cad-skbar').classList.add('hidden');
      if (it && (!keep || !it.profiles.length)) {
        if (sk.isNew) this.data.items = this.data.items.filter((x) => x.id !== it.id);
        else it.profiles = JSON.parse(sk.before);
        this.undoStack.pop();
        this._renderChrome(); this._refreshItems(); this._requestBuild();
        if (keep && !quiet) this._toast('Draw at least one closed shape', 'err');
        return;
      }
      // Re-centre the profiles on the item so it moves and rotates about its middle.
      const vs = [];
      it.profiles.filter((p) => !p.cut).forEach((p) => this._outline(p).forEach((q) => vs.push(q)));
      if (!vs.length) it.profiles.forEach((p) => this._outline(p).forEach((q) => vs.push(q)));
      const cx = r3((Math.min(...vs.map((v) => v[0])) + Math.max(...vs.map((v) => v[0]))) / 2);
      const cy = r3((Math.min(...vs.map((v) => v[1])) + Math.max(...vs.map((v) => v[1]))) / 2);
      if (cx || cy) {
        it.profiles.forEach((p) => { if (p.k === 'poly') p.pts = p.pts.map((q) => (q.length >= 4 ? [r3(q[0] - cx), r3(q[1] - cy), r3(q[2] - cx), r3(q[3] - cy)] : [r3(q[0] - cx), r3(q[1] - cy)])); else { p.x = r3(p.x - cx); p.y = r3(p.y - cy); } });
        const off = new this.T.Vector3(cx, cy, 0).applyQuaternion(sk.frame.quaternion);
        it.pos = [r3(it.pos[0] + off.x), r3(it.pos[1] + off.y), r3(it.pos[2] + off.z)];
      }
      Object.assign(it, C.normalizeItem(it));
      this.sel = it.id;
      this._view('iso');
      this._commit();
      this._refreshItems();
      this._toast(it.draft ? 'Sketch saved — tap Extrude… to turn its areas into shapes' : 'Set the height in the panel — or drag the Height label', 'ok');
    }

    // ---------- script editor ----------
    // A wide editor over the 3D view: Monaco (already loaded by Accretion) when
    // available, else a plain no-wrap textarea. Keys typed here never reach the
    // 3D view's or the app's shortcuts. Esc closes and keeps the draft.
    _codeEditor(id) {
      const it = this._item(id); if (!it || it.type !== 'code') return;
      this._codeClose();
      this._codeDrafts = this._codeDrafts || {};
      const ro = this.readOnly;
      const ov = document.createElement('div');
      ov.className = 'cad-codeov';
      ov.innerHTML = `<div class="cad-codebox">
        <div class="cad-codehead">
          <b>${ICON.code} ${esc(it.name)}</b>
          <a href="https://replicad.xyz/docs/intro" target="_blank" rel="noopener">replicad docs</a>
          <span class="cad-codemsg"></span>
          ${ro ? '' : '<button type="button" data-capply title="Rebuild with this code (⌘↵)">Apply <kbd>⌘↵</kbd></button>'}
          <button type="button" class="cad-primary" data-cdone>${ro ? 'Close' : 'Done'}</button>
        </div>
        <div class="cad-codebody"></div>
      </div>`;
      this.root.appendChild(ov);
      const body = ov.querySelector('.cad-codebody');
      const start = this._codeDrafts[id] != null ? this._codeDrafts[id] : it.code;
      let get;
      if (global.monaco && global.monaco.editor) {
        const m = global.monaco;
        const ed = m.editor.create(body, {
          value: start, language: 'javascript', readOnly: ro, automaticLayout: true, minimap: { enabled: false },
          fontSize: 13, tabSize: 2, insertSpaces: true, wordWrap: 'off', scrollBeyondLastLine: false, lineNumbersMinChars: 3, fixedOverflowWidgets: true,
        });
        ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => apply(false));
        this._codeEd = ed;
        get = () => ed.getValue();
        setTimeout(() => ed.focus(), 0);
      } else {
        const ta = document.createElement('textarea');
        ta.className = 'cad-code-full'; ta.spellcheck = false; ta.value = start; ta.readOnly = ro; ta.wrap = 'off';
        body.appendChild(ta);
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply(false); }
        });
        get = () => ta.value;
        setTimeout(() => ta.focus(), 0);
      }
      const apply = (close) => {
        if (ro) { this._codeClose(); return; }
        const v = get();
        delete this._codeDrafts[id];
        const cur = this._item(id);
        if (cur && cur.code !== v) { this._edit(id, (x) => { x.code = v; }); this._codeStatus('Building…', ''); }
        if (close) this._codeClose();
      };
      // Keep every key inside the editor (no 3D / app shortcuts while typing).
      ov.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && !(this._codeEd && document.querySelector('.cad-codeov .suggest-widget.visible'))) { e.preventDefault(); this._codeDrafts[id] = get(); this._codeClose(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault();
      });
      ['keyup', 'keypress'].forEach((t) => ov.addEventListener(t, (e) => e.stopPropagation()));
      ov.addEventListener('pointerdown', (e) => { if (e.target === ov) { this._codeDrafts[id] = get(); this._codeClose(); } });
      const ab = ov.querySelector('[data-capply]'); if (ab) ab.onclick = () => apply(false);
      ov.querySelector('[data-cdone]').onclick = () => apply(true);
      this.codeOv = { el: ov, id };
      this._codeStatus();
    }
    _codeStatus(text, kind) {
      const ov = this.codeOv; if (!ov) return;
      const m = ov.el.querySelector('.cad-codemsg');
      const err = this.errors[ov.id];
      if (text != null) { m.textContent = text; m.className = 'cad-codemsg ' + (kind || ''); return; }
      m.textContent = err ? err : (this.meshes[ov.id] ? 'Built ✓' : '');
      m.className = 'cad-codemsg ' + (err ? 'err' : 'ok');
    }
    _codeClose() {
      if (this._codeEd) { try { this._codeEd.dispose(); } catch (e) { /* gone */ } this._codeEd = null; }
      if (this.codeOv) { this.codeOv.el.remove(); this.codeOv = null; }
      this.root.focus({ preventScroll: true });
      this._inspFor = null; this._renderInspector();
    }

    // ---------- face tools: push / pull, sketch on face, lay flat ----------
    // A face is a flat region of the printed result: connected triangles in one
    // plane. Its outline (and holes in it) become a sketch on that plane.
    _faceMode(on) {
      this.faceOn = !!on && !this.readOnly;
      if (this.faceOn) { if (this.measureOn) this._measureMode(false); this._select(null); }
      this._faceSet(null);
      this.root.classList.toggle('cad-facing', this.faceOn);
      const b = this.root.querySelector('[data-face]'); if (b) b.classList.toggle('on', this.faceOn);
      if (this.faceOn) this._toast('Tap a flat face of your part');
    }
    _faceAdjacency() {
      if (this._faceAdj) return this._faceAdj;
      const r = this.result; if (!r) return null;
      const v = r.vertices, t = r.triangles, n = t.length / 3;
      const normals = new Float64Array(n * 3); const edge = new Map();
      for (let i = 0; i < n; i++) {
        const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1;
        normals[i * 3] = nx / l; normals[i * 3 + 1] = ny / l; normals[i * 3 + 2] = nz / l;
        for (let k = 0; k < 3; k++) { const p = t[i * 3 + k], q = t[i * 3 + (k + 1) % 3]; const key = p < q ? p + ',' + q : q + ',' + p; (edge.get(key) || edge.set(key, []).get(key)).push(i); }
      }
      this._faceAdj = { normals, edge };
      return this._faceAdj;
    }
    // Flat region containing triangle `tri`, with its outline loops in plane coordinates.
    _faceRegion(tri) {
      const A = this._faceAdjacency(); if (!A) return null;
      const v = this.result.vertices, t = this.result.triangles, N = A.normals;
      const n0 = [N[tri * 3], N[tri * 3 + 1], N[tri * 3 + 2]];
      const p0 = [v[t[tri * 3] * 3], v[t[tri * 3] * 3 + 1], v[t[tri * 3] * 3 + 2]];
      const onPlane = (i) => {
        if (N[i * 3] * n0[0] + N[i * 3 + 1] * n0[1] + N[i * 3 + 2] * n0[2] < 0.99999) return false;
        for (let k = 0; k < 3; k++) { const q = t[i * 3 + k] * 3; if (Math.abs((v[q] - p0[0]) * n0[0] + (v[q + 1] - p0[1]) * n0[1] + (v[q + 2] - p0[2]) * n0[2]) > 2e-3) return false; }
        return true;
      };
      const inR = new Set([tri]); const stack = [tri];
      while (stack.length) {
        const i = stack.pop();
        for (let k = 0; k < 3; k++) {
          const p = t[i * 3 + k], q = t[i * 3 + (k + 1) % 3]; const key = p < q ? p + ',' + q : q + ',' + p;
          for (const j of A.edge.get(key) || []) if (!inR.has(j) && onPlane(j)) { inR.add(j); stack.push(j); }
        }
      }
      // Boundary edges keep the triangles' winding: outer loop CCW, holes CW (seen from outside).
      const count = new Map(); const dir = [];
      for (const i of inR) for (let k = 0; k < 3; k++) { const p = t[i * 3 + k], q = t[i * 3 + (k + 1) % 3]; const key = p < q ? p + ',' + q : q + ',' + p; count.set(key, (count.get(key) || 0) + 1); dir.push([p, q, key]); }
      const next = new Map(); for (const [p, q, key] of dir) if (count.get(key) === 1) next.set(p, q);
      // A facet of a curved surface (cylinder side, sphere…) meets its neighbours at
      // shallow angles all round: that is not a flat face of the part.
      let shallow = 0, total = 0;
      for (const [p, q, key] of dir) {
        if (count.get(key) !== 1) continue;
        const nb = (A.edge.get(key) || []).find((j) => !inR.has(j)); if (nb == null) continue;
        const len = Math.hypot(v[p * 3] - v[q * 3], v[p * 3 + 1] - v[q * 3 + 1], v[p * 3 + 2] - v[q * 3 + 2]); // weigh by edge length
        total += len; if (N[nb * 3] * n0[0] + N[nb * 3 + 1] * n0[1] + N[nb * 3 + 2] * n0[2] > Math.cos(25 * DEG)) shallow += len;
      }
      const smoothAround = total && shallow / total > 0.5; // decided below, once the region's size is known
      // plane basis: u along the world axis least aligned with the normal
      const T = this.T; const nv = new T.Vector3(...n0);
      const ref = Math.abs(nv.z) < 0.9 ? new T.Vector3(0, 0, 1) : new T.Vector3(0, 1, 0);
      const u = new T.Vector3().crossVectors(ref, nv).normalize(); const w = new T.Vector3().crossVectors(nv, u).normalize();
      const P = (i) => new T.Vector3(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      const loops = []; const seen = new Set();
      for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop = []; let c = start; let guard = 0;
        while (!seen.has(c) && guard++ < 1e6) { seen.add(c); loop.push(c); c = next.get(c); if (c === undefined) break; }
        if (loop.length >= 3) loops.push(loop);
      }
      if (!loops.length) return null;
      const origin = new T.Vector3(...p0);
      const to2 = (i) => { const d = P(i).sub(origin); return [d.dot(u), d.dot(w)]; };
      const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
      const simplify = (pts) => pts.filter((p, i) => { const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length]; return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-6 * (1 + Math.hypot(b[0] - a[0], b[1] - a[1])); });
      let L = loops.map((l) => { const pts = simplify(l.map(to2)); return { pts, area: area(pts) }; }).filter((l) => l.pts.length >= 3);
      const outer = L.reduce((m, l) => (l.area > (m ? m.area : -Infinity) ? l : m), null);
      if (!outer || outer.area <= 0) return null;
      const holes = L.filter((l) => l !== outer && l.area < 0);
      if (smoothAround) {
        // A flat face can blend smoothly into rounded edges (fillets). Only a thin
        // strip (cylinder side) or a tiny patch (sphere) is a facet of a curved surface.
        const xs0 = outer.pts.map((p) => p[0]), ys0 = outer.pts.map((p) => p[1]);
        const w0 = Math.max(...xs0) - Math.min(...xs0), h0 = Math.max(...ys0) - Math.min(...ys0);
        const r = this.result.vertices; let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < r.length; i += 3) for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], r[i + q]); hi[q] = Math.max(hi[q], r[i + q]); }
        const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        if (Math.min(w0, h0) < 0.2 * Math.max(w0, h0) || Math.max(w0, h0) < 0.2 * diag) return { curved: true };
      }
      // centre the sketch on the outer loop's bounding box
      const xs = outer.pts.map((p) => p[0]), ys = outer.pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const sh = (pts) => pts.map((p) => [r3(p[0] - cx), r3(p[1] - cy)]);
      const center = origin.clone().addScaledVector(u, cx).addScaledVector(w, cy);
      const m = new T.Matrix4().makeBasis(u, w, nv); const eu = new T.Euler().setFromRotationMatrix(m, 'ZYX');
      return { tris: inR, n: nv, u, w, center, rot: [r3(eu.x / DEG), r3(eu.y / DEG), r3(eu.z / DEG)], outer: sh(outer.pts), holes: holes.map((h) => sh(h.pts)), size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
    }
    _faceHit(e) {
      const mesh = this.designGroup.children.find((o) => o.isMesh); if (!mesh) return null;
      const hit = this._ray(e).intersectObject(mesh, false)[0];
      const f = hit ? this._faceRegion(hit.faceIndex) : null;
      return f && f.curved ? (e.type === 'pointermove' ? null : f) : f;
    }
    _faceHover(e) {
      const f = this._faceHit(e);
      const key = f ? [...f.tris].slice(0, 3).join(',') + f.tris.size : '';
      if (key === this._faceHovKey) return;
      this._faceHovKey = key;
      this._faceDrawRegion(f, 'hover');
    }
    _faceDrawRegion(f, kind) {
      const T = this.T;
      const prop = kind === 'hover' ? '_faceHovMesh' : '_faceSelMesh';
      if (this[prop]) { this.scene.remove(this[prop]); this[prop].traverse((o) => o.geometry && o.geometry.dispose()); this[prop] = null; }
      if (!f) return;
      const v = this.result.vertices, t = this.result.triangles; const pos = [];
      for (const i of f.tris) for (let k = 0; k < 3; k++) { const q = t[i * 3 + k] * 3; pos.push(v[q] + f.n.x * 0.03, v[q + 1] + f.n.y * 0.03, v[q + 2] + f.n.z * 0.03); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      const grp = new T.Group();
      const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: this.colors.accent, transparent: true, opacity: kind === 'hover' ? 0.22 : 0.45, side: T.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -8 }));
      m.renderOrder = 6; grp.add(m);
      if (kind !== 'hover') {
        const arrow = new T.ArrowHelper(f.n, f.center, Math.max(8, Math.min(30, (f.size[0] + f.size[1]) / 3)), this.colors.accent.getHex(), 4, 3);
        arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 9; } });
        grp.add(arrow); this._faceArrow = arrow;
      }
      this.scene.add(grp); this[prop] = grp;
    }
    _facePick(e) {
      const f = this._faceHit(e);
      if (!f) return;
      if (f.curved) { this._toast('That is a curved surface — Push / Pull works on flat faces', 'err'); return; }
      this._faceSet(f);
    }
    // Is this face the actual side of a box / sketch / cylinder (along one of its own
    // axes)? Then push / pull resizes that shape, so rounded or chamfered edges move with it.
    _faceOwner(f) {
      const T = this.T;
      for (const it of this.data.items) {
        if (it.role !== 'solid' || it.hidden || !['box', 'sketch', 'cylinder'].includes(it.type) || (it.clip && it.clip.length) || (it.cuts && it.cuts.length)) continue;
        const M = this._placeMatrix(it); const inv = M.clone().invert();
        const nl = f.n.clone().transformDirection(inv); const cl = f.center.clone().applyMatrix4(inv);
        const a = [Math.abs(nl.x), Math.abs(nl.y), Math.abs(nl.z)]; const k = a.indexOf(Math.max(...a));
        if (a[k] < 0.9999) continue;
        const sign = nl.getComponent(k) > 0 ? 1 : -1;
        if (it.type !== 'box' && k !== 2) continue;
        if (it.type === 'sketch' && it.height < 0) continue;
        const hw = it.type === 'box' ? [it.size.x / 2, it.size.y / 2] : null;
        const H = it.type === 'box' ? it.size.z : it.type === 'sketch' ? it.height : it.size.z;
        const onSide = k === 2 ? Math.abs(cl.z - (sign > 0 ? H : 0)) < 0.01 : Math.abs(Math.abs(cl.getComponent(k)) - hw[k]) < 0.01;
        if (!onSide) continue;
        if (it.type === 'box' && (Math.abs(cl.x) > hw[0] + 0.01 || Math.abs(cl.y) > hw[1] + 0.01 || cl.z < -0.01 || cl.z > H + 0.01)) continue;
        const what = it.type === 'box' ? ['width (X)', 'depth (Y)', 'height (Z)'][k] : 'height';
        return { id: it.id, k, sign, what, base: JSON.parse(JSON.stringify({ size: it.size, height: it.height, pos: it.pos })), M };
      }
      return null;
    }
    _faceSet(f) {
      this.face = f; this._faceItem = null; this._faceDist = 0;
      this._faceOwn = f ? this._faceOwner(f) : null;
      this._faceDrawRegion(null, 'hover'); this._faceHovKey = '';
      this._faceDrawRegion(f, 'sel');
      if (!f) this._faceArrow = null;
      this._renderFacePanel();
    }
    _renderFacePanel() {
      const el = this.inspEl; const f = this.face;
      if (!this.faceOn) { if (this._facePanel) { this._facePanel = false; this._inspFor = null; this._renderInspector(); } return; }
      this._facePanel = true; this._inspFor = 'face';
      el.classList.remove('hidden');
      if (!f) { el.innerHTML = `<div class="cad-insp-head"><div class="cad-name">Face</div><button type="button" class="cad-icon-btn" data-fclose title="Done (Esc)">✕</button></div><p class="cad-hint">Tap a flat face of your part. Then push / pull it, sketch on it, or lay it flat on the build plate.</p>`; el.querySelector('[data-fclose]').onclick = () => this._faceMode(false); return; }
      const d = this._faceDist || 0;
      el.innerHTML = `
        <div class="cad-insp-head"><div class="cad-name">Face</div><button type="button" class="cad-icon-btn" data-fclose title="Done (Esc)">✕</button></div>
        <p class="cad-hint">Flat face · about ${r3(f.size[0])} × ${r3(f.size[1])} mm${f.holes.length ? ' · ' + f.holes.length + ' hole' + (f.holes.length > 1 ? 's' : '') : ''}</p>
        <div class="cad-sec"><div class="cad-sec-t">Push / Pull</div>
          <div class="cad-grid"><label class="cad-field wide"><span class="cad-scrub" data-fscrub>Distance</span><input type="text" inputmode="decimal" data-fdist value="${d}"><em>mm</em></label></div>
          <p class="cad-hint">${this._faceOwn ? 'Resizes <b>' + esc((this._item(this._faceOwn.id) || {}).name || '') + '</b> (' + this._faceOwn.what + ') — its rounded / chamfered edges move with the face. + grows, − shrinks.' : '+ pulls out (adds material in the face\'s shape), − pushes in (cuts a pocket). Or drag the arrow.'}</p>
          <div class="cad-quick">${[-5, -1, 1, 5].map((x) => `<button type="button" data-fstep="${x}">${x > 0 ? '+' : ''}${x}</button>`).join('')}</div>
        </div>
        <div class="cad-sec"><div class="cad-quick">
          <button type="button" data-fsketch title="Start a sketch on this face">Sketch on face</button>
          <button type="button" data-fflat title="Turn the whole design so this face rests on the build plate">Lay flat</button>
        </div></div>
        ${this._faceItem ? `<button type="button" class="cad-wide-btn" data-fdone>Done — keep it</button>` : ''}`;
      el.querySelector('[data-fclose]').onclick = () => this._faceMode(false);
      const inp = el.querySelector('[data-fdist]');
      inp.onchange = () => this._faceApply(evalNum(inp.value, this._faceDist || 0), true);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { inp.dispatchEvent(new Event('change')); inp.select(); } };
      inp.onfocus = () => setTimeout(() => inp.select(), 0);
      el.querySelectorAll('[data-fstep]').forEach((b) => { b.onclick = () => this._faceApply(r3((this._faceDist || 0) + +b.dataset.fstep), true); });
      el.querySelector('[data-fsketch]').onclick = () => { const ff = this.face; this._faceMode(false); this._sketchStart(null, { pos: [r3(ff.center.x), r3(ff.center.y), r3(ff.center.z)], rot: ff.rot }); };
      el.querySelector('[data-fflat]').onclick = () => this._layFlat(this.face);
      const dn = el.querySelector('[data-fdone]'); if (dn) dn.onclick = () => { const id = this._faceItem; this._faceMode(false); if (id) this._select(id); };
      // drag the Distance label, like other fields
      const lab = el.querySelector('[data-fscrub]');
      lab.onpointerdown = (e) => {
        e.preventDefault(); lab.setPointerCapture(e.pointerId); const x0 = e.clientX; const d0 = this._faceDist || 0; let moved = false;
        lab.onpointermove = (ev2) => { const dx = ev2.clientX - x0; if (!moved && Math.abs(dx) < 3) return; moved = true; this._faceApply(r3(Math.round((d0 + dx / 8) * 2) / 2), false); inp.value = this._faceDist; };
        lab.onpointerup = () => { lab.onpointermove = null; lab.onpointerup = null; if (moved) this._faceApply(this._faceDist, true); else inp.focus(); };
      };
    }
    // Create / update the push-pull shape for distance d (mm along the face normal).
    _faceApply(d, final) {
      const f = this.face; if (!f || this.readOnly) return;
      d = r3(d);
      const own = this._faceOwn;
      if (own) { // resize the shape the face belongs to
        const it = this._item(own.id); if (!it) return;
        if (!this._faceItem) { if (!d) return; this._snapshot(); this._faceItem = it.id; }
        else if (final && d !== this._faceDist) this._snapshot();
        const T = this.T; const b = own.base;
        const grow = Math.max(0.1 - (own.k === 2 ? (it.type === 'box' ? b.size.z : it.type === 'sketch' ? b.height : b.size.z) : (own.k === 0 ? b.size.x : b.size.y)), d);
        if (it.type === 'box') it.size = Object.assign({}, b.size, { [['x', 'y', 'z'][own.k]]: r3(b.size[['x', 'y', 'z'][own.k]] + grow) });
        else if (it.type === 'sketch') it.height = r3(b.height + grow);
        else it.size = Object.assign({}, b.size, { z: r3(b.size.z + grow) });
        // keep the opposite side where it is: shift along the shape's own axis
        const shift = new T.Vector3(); shift.setComponent(own.k, own.k === 2 ? (own.sign > 0 ? 0 : -grow) : own.sign * grow / 2);
        const o0 = new T.Vector3().applyMatrix4(own.M); const ws = shift.clone().applyMatrix4(own.M).sub(o0);
        it.pos = [r3(b.pos[0] + ws.x), r3(b.pos[1] + ws.y), r3(b.pos[2] + ws.z)];
        Object.assign(it, C.normalizeItem(it));
        this._faceDist = d;
        this._refreshItems(); this._changed(); this._requestBuild(!final);
        if (final) this._renderFacePanel(); else { const i = this.inspEl.querySelector('[data-fdist]'); if (i) i.value = d; }
        return;
      }
      if (!this._faceItem && !d) return;
      const eps = 0.02; // overlap the part a hair so the new shape joins / cuts cleanly
      const depth = Math.abs(d);
      const n = f.n; const base = d >= 0 ? f.center.clone().addScaledVector(n, -eps) : f.center.clone().addScaledVector(n, -depth);
      const fields = {
        role: d >= 0 ? 'solid' : 'hole',
        height: r3(depth + eps),
        pos: [r3(base.x), r3(base.y), r3(base.z)], rot: f.rot.slice(),
        profiles: [{ k: 'poly', pts: f.outer }].concat(f.holes.map((h) => ({ k: 'poly', pts: h, cut: true }))),
      };
      if (!this._faceItem) {
        if (!d) return;
        this._snapshot();
        const it = C.newItem('sketch', Object.assign({ name: this._uniqueName(d >= 0 ? 'Pull' : 'Push') }, fields));
        this.data.items.push(it); this._faceItem = it.id;
      } else {
        const it = this._item(this._faceItem); if (!it) return;
        if (!d) { this.data.items = this.data.items.filter((x) => x.id !== it.id); this._faceItem = null; }
        else { if (final) this._snapshot(); Object.assign(it, C.normalizeItem(Object.assign(it, fields, { name: /^(Pull|Push)( \d+)?$/.test(it.name) ? it.name.replace(/^(Pull|Push)/, d >= 0 ? 'Pull' : 'Push') : it.name }))); }
      }
      this._faceDist = d;
      this._refreshItems(); this._changed(); this._requestBuild(!final);
      if (final) this._renderFacePanel();
      else { const i = this.inspEl.querySelector('[data-fdist]'); if (i) i.value = d; }
    }
    // Turn every object so the face points down, then put the lowest point on the plate.
    _layFlat(f) {
      if (!f || this.readOnly) return;
      const T = this.T; const ids = this.data.items.map((x) => x.id);
      if (!ids.length) return;
      this._snapshot();
      const keepMulti = this.multi; this.multi = ids;
      if (!this.proxy) this._placeProxy();
      this.proxy.position.copy(f.center); this.proxy.quaternion.identity(); this.proxy.scale.set(1, 1, 1); this.proxy.updateMatrixWorld(true);
      this._multiDragStart();
      this.proxy.quaternion.setFromUnitVectors(f.n.clone().normalize(), new T.Vector3(0, 0, -1));
      this._multiDragApply(true);
      this.multi = keepMulti;
      const b = this._boundsOf(ids.filter((id) => (this._item(id) || {}).role !== 'ref'));
      if (!b.isEmpty()) { const dz = b.min.z; this.data.items.forEach((it) => { it.pos[2] = r3(it.pos[2] - dz); }); }
      this._faceMode(false);
      this._commit(); this._refreshItems();
      this._view('iso');
      this._toast('Laid flat — that face is now on the build plate', 'ok');
    }

    // ---------- per-edge rounding / chamfer ----------
    // Edges come from the shape before any rounding; each is identified by its
    // middle point in the shape's own frame.
    _edgeKey(p) { return p.map((x) => Math.round(x * 1000) / 1000).join(','); }
    _edgeModeStart(id) {
      const it = this._item(id); if (!it || this.readOnly) return;
      if (this.faceOn) this._faceMode(false);
      if (this.measureOn) this._measureMode(false);
      if (it.round > 0 || it.chamfer > 0) this._toast('"Round" / "Chamfer" for all edges is set — set it to 0 to round single edges', 'err');
      this.edgeMode = { id, sel: new Set(), r: this._edgeR || 1 };
      this.root.classList.add('cad-edging');
      if (this.tc.object) this.tc.detach();
      this._edgeDraw(); this._renderEdgePanel();
    }
    _edgeModeEnd() {
      if (!this.edgeMode) return;
      const id = this.edgeMode.id;
      this.edgeMode = null;
      this.root.classList.remove('cad-edging');
      if (this._edgeObj) { this._edgeObj.parent && this._edgeObj.parent.remove(this._edgeObj); this._edgeObj.traverse((o) => o.geometry && o.geometry.dispose()); this._edgeObj = null; }
      this._inspFor = null; this._select(id);
    }
    _edgeDraw() {
      const em = this.edgeMode; if (!em) return;
      const T = this.T; const o = this.objs[em.id]; const list = this.edges && this.edges[em.id];
      if (this._edgeObj) { this._edgeObj.parent && this._edgeObj.parent.remove(this._edgeObj); this._edgeObj.traverse((x) => x.geometry && x.geometry.dispose()); this._edgeObj = null; }
      if (!o || !list) return;
      const it = this._item(em.id); const done = new Map((it.edges || []).map((e) => [this._edgeKey(e.p), e]));
      const grp = new T.Group(); grp.userData.edges = true;
      list.forEach((e, i) => {
        const key = this._edgeKey(e.p);
        const segs = []; for (let k = 0; k + 3 < e.pts.length; k += 3) segs.push(e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3], e.pts[k + 4], e.pts[k + 5]);
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(segs, 3));
        const picked = em.sel.has(key), edited = done.get(key), hov = em.hov === key;
        const col = picked ? this.colors.hole : edited ? this.colors.accent : hov ? this.colors.accent : this.colors.edge;
        const l = new T.LineSegments(g, new T.LineBasicMaterial({ color: col, transparent: true, opacity: picked || edited || hov ? 1 : 0.55, depthTest: false }));
        l.renderOrder = 12; l.userData.key = key; l.userData.p = e.p;
        grp.add(l);
        if (picked || edited || hov) { // a dot in the middle makes thin edges easy to see
          const d = new T.Points(new T.BufferGeometry().setFromPoints([new T.Vector3(...e.p)]), new T.PointsMaterial({ color: col, size: picked ? 10 : 7, sizeAttenuation: false, depthTest: false }));
          d.renderOrder = 13; grp.add(d);
        }
      });
      o.group.add(grp); this._edgeObj = grp;
    }
    _edgeAt(e) {
      if (!this._edgeObj) return null;
      const rc = this._ray(e);
      // ~10 px pick tolerance, in model units at the target distance
      const px = this.camera.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / (this.viewEl.clientHeight || 1) : this.camera.position.distanceTo(this.target) * Math.tan((this.persp.fov * DEG) / 2) * 2 / (this.viewEl.clientHeight || 1);
      rc.params.Line = { threshold: px * 10 };
      const hits = rc.intersectObjects(this._edgeObj.children.filter((c) => c.isLineSegments), false);
      return hits.length ? hits[0].object.userData : null;
    }
    _edgeHover(e) {
      const em = this.edgeMode; const h = this._edgeAt(e); const k = h ? h.key : null;
      if (k === em.hov) return; em.hov = k; this.renderer.domElement.style.cursor = k ? 'pointer' : ''; this._edgeDraw();
    }
    _edgeClick(e) {
      const em = this.edgeMode; const h = this._edgeAt(e);
      if (!h) return;
      if (em.sel.has(h.key)) em.sel.delete(h.key); else em.sel.add(h.key);
      this._edgeDraw(); this._renderEdgePanel();
    }
    _edgeApply(kind) {
      const em = this.edgeMode; if (!em || !em.sel.size) return;
      const list = (this.edges && this.edges[em.id]) || [];
      const r = Math.max(0.01, em.r);
      this._edit(em.id, (it) => {
        const ops = (it.edges || []).filter((x) => !em.sel.has(this._edgeKey(x.p)));
        if (kind !== 'remove') list.filter((x) => em.sel.has(this._edgeKey(x.p))).forEach((x) => ops.push({ p: x.p.slice(), r, kind }));
        it.edges = ops;
      });
      em.sel.clear(); this._edgeR = r;
      this._edgeDraw(); this._renderEdgePanel();
    }
    _renderEdgePanel() {
      const em = this.edgeMode; const el = this.inspEl; if (!em) return;
      const it = this._item(em.id); if (!it) { this._edgeModeEnd(); return; }
      this._inspFor = 'edges';
      el.classList.remove('hidden');
      const ops = it.edges || [];
      const nr = ops.filter((x) => x.kind === 'round').length, nc = ops.length - nr;
      el.innerHTML = `
        <div class="cad-insp-head"><div class="cad-name">Edges · ${esc(it.name)}</div><button type="button" class="cad-icon-btn" data-eclose title="Done (Esc)">✕</button></div>
        <p class="cad-hint">Tap edges to pick them (tap again to unpick), then round or chamfer them.</p>
        <p class="cad-combo-tag"><b>${em.sel.size}</b> edge${em.sel.size === 1 ? '' : 's'} picked</p>
        <div class="cad-grid"><label class="cad-field wide"><span class="cad-scrub">Size</span><input type="text" inputmode="decimal" data-er value="${em.r}"><em>mm</em></label></div>
        <div class="cad-quick">
          <button type="button" data-eapply="round" ${em.sel.size ? '' : 'disabled'}>Round</button>
          <button type="button" data-eapply="chamfer" ${em.sel.size ? '' : 'disabled'}>Chamfer</button>
          <button type="button" data-eapply="remove" ${em.sel.size ? '' : 'disabled'} title="Make the picked edges sharp again">Sharp</button>
        </div>
        ${this.notes[em.id] ? '<p class="cad-msg">' + esc(this.notes[em.id]) + '</p>' : ''}
        ${this.errors[em.id] ? '<p class="cad-msg err">' + esc(this.errors[em.id]) + '</p>' : ''}
        <div class="cad-sec"><div class="cad-sec-t">On this shape</div>
          <p class="cad-hint">${ops.length ? nr + ' rounded, ' + nc + ' chamfered edge' + (ops.length === 1 ? '' : 's') : 'No edges changed yet.'}</p>
          ${ops.length ? '<button type="button" class="cad-wide-btn" data-eclear>Make all edges sharp</button>' : ''}
        </div>
        <button type="button" class="cad-wide-btn cad-combine" data-edone>Done</button>`;
      const ri = el.querySelector('[data-er]');
      ri.onchange = () => { em.r = Math.max(0.01, evalNum(ri.value, em.r)); ri.value = em.r; };
      ri.onkeydown = (e) => { if (e.key === 'Enter') ri.dispatchEvent(new Event('change')); };
      el.querySelectorAll('[data-eapply]').forEach((b) => { b.onclick = () => { ri.dispatchEvent(new Event('change')); this._edgeApply(b.dataset.eapply); }; });
      const cl = el.querySelector('[data-eclear]'); if (cl) cl.onclick = () => { this._edit(em.id, (x) => { x.edges = []; }); this._edgeDraw(); this._renderEdgePanel(); };
      el.querySelector('[data-eclose]').onclick = () => this._edgeModeEnd();
      el.querySelector('[data-edone]').onclick = () => this._edgeModeEnd();
    }

    // ---------- dimensions on the selected object ----------
    // Three dimension lines along the selection's box (X front-bottom, Y right-
    // bottom, Z front-right), each with a midpoint dot, plus a centre dot.
    // Double-click a label to type that size.
    _dimClear() {
      if (this._dimObj) { this.scene.remove(this._dimObj); this._dimObj.traverse((o) => o.geometry && o.geometry.dispose()); this._dimObj = null; }
      (this._dimLabels || []).forEach((l) => l.el.remove()); this._dimLabels = [];
    }
    _dimUpdate(fast) {
      if (!this.T || !this.scene) return;
      const ids = this._selIds();
      const busy = this.sk || this.faceOn || this.edgeMode || this.cutMode || this.measureOn || !ids.length;
      if (busy) { this._dimClear(); return; }
      const T = this.T;
      const b = this._boundsOf(ids, fast); if (b.isEmpty()) { this._dimClear(); return; }
      const lo = b.min, hi = b.max, sz = b.getSize(new T.Vector3());
      const off = Math.max(2, sz.length() * 0.06);
      const lines = [
        { axis: 0, a: new T.Vector3(lo.x, lo.y - off, lo.z), b: new T.Vector3(hi.x, lo.y - off, lo.z), ext: [[new T.Vector3(lo.x, lo.y, lo.z), new T.Vector3(lo.x, lo.y - off * 1.3, lo.z)], [new T.Vector3(hi.x, lo.y, lo.z), new T.Vector3(hi.x, lo.y - off * 1.3, lo.z)]] },
        { axis: 1, a: new T.Vector3(hi.x + off, lo.y, lo.z), b: new T.Vector3(hi.x + off, hi.y, lo.z), ext: [[new T.Vector3(hi.x, lo.y, lo.z), new T.Vector3(hi.x + off * 1.3, lo.y, lo.z)], [new T.Vector3(hi.x, hi.y, lo.z), new T.Vector3(hi.x + off * 1.3, hi.y, lo.z)]] },
        { axis: 2, a: new T.Vector3(hi.x + off, lo.y - off, lo.z), b: new T.Vector3(hi.x + off, lo.y - off, hi.z), ext: [] },
      ];
      if (!this._dimObj) {
        const grp = new T.Group(); this.scene.add(grp); this._dimObj = grp;
        const colors = [0xe5484d, 0x30a46c, 0x3e63dd];
        this._dimLabels = lines.map((ln, i) => {
          const segs = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color: colors[i], depthTest: false, transparent: true, opacity: 0.85 }));
          segs.renderOrder = 14; grp.add(segs);
          const mid = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({ color: colors[i], size: 8, sizeAttenuation: false, depthTest: false }));
          mid.renderOrder = 15; grp.add(mid);
          const el = document.createElement('div'); el.className = 'cad-dimlabel ax' + i; el.dataset.dim = String(i);
          el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
          this.root.querySelector('.cad-mlayer').appendChild(el);
          return { el, segs, mid };
        });
        const c = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({ color: this.colors.accent, size: 9, sizeAttenuation: false, depthTest: false }));
        c.renderOrder = 15; grp.add(c); this._dimCenter = c;
      }
      const fmt = (v) => String(Math.round(v * 100) / 100);
      lines.forEach((ln, i) => {
        const L = this._dimLabels[i];
        const pts = [ln.a, ln.b]; ln.ext.forEach((e) => pts.push(e[0], e[1]));
        L.segs.geometry.setFromPoints(pts);
        const m = ln.a.clone().add(ln.b).multiplyScalar(0.5);
        L.mid.geometry.setFromPoints([m]); L.pos = m;
        // only touch the label when its text changes: rewriting it between the two
        // clicks of a double-click would swallow the double-click
        if (!L.editing) { const ed = this._dimEditable(i); const html = '<b>' + 'XYZ'[i] + '</b> ' + fmt(sz.getComponent(i)) + ' mm'; if (L.html !== html) { L.el.innerHTML = html; L.html = html; } L.el.title = ed.ok ? 'Double-click to type this size · midpoint ' + 'XYZ'[i] + ' ' + fmt(b.getCenter(new T.Vector3()).getComponent(i)) : ed.why; L.el.classList.toggle('ro', !ed.ok); }
      });
      this._dimCenter.geometry.setFromPoints([b.getCenter(new T.Vector3())]);
      this._dimSize = sz; this._dimBox = b;
    }
    _dimPlace() {
      if (!this._dimLabels || !this._dimLabels.length) return;
      const r = this.viewEl.getBoundingClientRect();
      // Keep labels out from under the floating panels so they can be clicked.
      const block = ['.cad-inspector:not(.hidden)', '.cad-tools', '.cad-viewbar', '.cad-list', '.cad-top', '.cad-axes'].map((q) => this.root.querySelector(q)).filter(Boolean).map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.height);
      const placed = [];
      for (const L of this._dimLabels) {
        if (!L.pos) continue;
        const p = L.pos.clone().project(this.camera);
        L.el.style.display = p.z < 1 ? '' : 'none';
        const w = L.el.offsetWidth || 70, h = L.el.offsetHeight || 22;
        let x = (p.x + 1) / 2 * r.width, y = (1 - p.y) / 2 * r.height;
        const hits = (cx, cy) => block.concat(placed).find((b) => cx + w / 2 + 4 > b.left - r.left && cx - w / 2 - 4 < b.right - r.left && cy + h / 2 + 4 > b.top - r.top && cy - h / 2 - 4 < b.bottom - r.top);
        for (let k = 0; k < 6; k++) {
          const b = hits(x, y); if (!b) break;
          const left = b.left - r.left - w / 2 - 6, right = b.right - r.left + w / 2 + 6, up = b.top - r.top - h / 2 - 6;
          // move to the nearest free side (prefer sideways, then up)
          const opts = [left, right].filter((v) => v > w / 2 && v < r.width - w / 2).sort((a, c) => Math.abs(a - x) - Math.abs(c - x));
          if (opts.length && Math.abs(opts[0] - x) < r.width / 2) x = opts[0]; else y = Math.max(h / 2, up);
        }
        x = Math.min(Math.max(x, w / 2 + 2), r.width - w / 2 - 2); y = Math.min(Math.max(y, h / 2 + 2), r.height - h / 2 - 2);
        placed.push({ left: r.left + x - w / 2, right: r.left + x + w / 2, top: r.top + y - h / 2, bottom: r.top + y + h / 2 });
        L.el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px) translate(-50%, -50%)';
      }
    }
    // Which parameter a world axis maps to for the selected object, if any.
    _dimMap(axis) {
      const ids = this._selIds(); if (ids.length !== 1) return { why: 'Select one object to edit its size' };
      const it = this._item(ids[0]); if (!it) return { why: '' };
      const T = this.T;
      const o = new T.Object3D(); o.rotation.order = 'ZYX'; this._placeObj(o, it); o.updateMatrixWorld(true);
      const w = new T.Vector3(); w.setComponent(axis, 1);
      let local = -1;
      for (let k = 0; k < 3; k++) { const v = new T.Vector3(); v.setComponent(k, 1); v.transformDirection(o.matrixWorld); if (Math.abs(v.dot(w)) > 0.9999) local = k; }
      if (local < 0) return { why: 'Rotated at an angle — set its rotation to 0° / 90° to type this size' };
      if (it.type === 'image') return { why: 'Set the image width in the panel' };
      return { it, local };
    }
    _dimEditable(axis) { const m = this._dimMap(axis); return m.it ? { ok: true } : { ok: false, why: m.why }; }
    _dimEdit(axis) {
      const L = this._dimLabels[axis]; if (!L || L.editing) return; const m = this._dimMap(axis);
      if (!m.it || this.readOnly) { if (m.why) this._toast(m.why, 'err'); return; }
      L.editing = true; L.html = null;
      L.el.innerHTML = '<b>' + 'XYZ'[axis] + '</b> <input type="text" inputmode="decimal" class="cad-dim-in" value="' + (Math.round(this._dimSize.getComponent(axis) * 100) / 100) + '"><em>mm</em>';
      const inp = L.el.querySelector('input');
      const done = (apply) => { if (!L.editing) return; L.editing = false; if (apply) { const v = evalNum(inp.value, NaN); if (v > 0) this._dimSet(axis, v); } this._dimUpdate(); this.root.focus({ preventScroll: true }); };
      inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }
    // Set the object's world size along `axis` to v mm (scales its own parameter).
    _dimSet(axis, v) {
      const m = this._dimMap(axis); if (!m.it) return;
      const cur = this._dimSize.getComponent(axis); if (!(cur > 0)) return;
      const f = v / cur; const k = m.local;
      this._scaleItem(m.it.id, [0, 1, 2].map((i) => (i === k ? f : 1)));
    }
    // Scale an object's own parameters by f = [fx, fy, fz] (in its own frame).
    _scaleItem(id, f, noUndo) {
      f = f.slice();
      if (f.every((x) => Math.abs(x - 1) < 1e-9)) return;
      const edit = noUndo ? (iid, fn) => { const x = this._item(iid); if (x) { fn(x); Object.assign(x, C.normalizeItem(x)); } } : this._edit.bind(this);
      edit(id, (it) => {
        const s3 = (v, k) => r3(v * f[k]);
        if ((it.clip && it.clip.length) || (it.cuts && it.cuts.length) || it.type === 'code' || it.sxyz) { it.sxyz = (it.sxyz || [1, 1, 1]).map((x, k) => Math.round(x * f[k] * 1e6) / 1e6); return; }
        if (it.type === 'box') it.size = Object.assign({}, it.size, { x: s3(it.size.x, 0), y: s3(it.size.y, 1), z: s3(it.size.z, 2) });
        else if (it.type === 'cylinder') { const fd = Math.abs(f[0] - 1) > Math.abs(f[1] - 1) ? f[0] : f[1]; it.size = Object.assign({}, it.size, { d: r3(it.size.d * fd), z: s3(it.size.z, 2) }); }
        else if (it.type === 'sphere') { const fd = [f[0], f[1], f[2]].reduce((a, x) => (Math.abs(x - 1) > Math.abs(a - 1) ? x : a), 1); it.size = Object.assign({}, it.size, { d: r3(it.size.d * fd) }); }
        else if ((it.clip && it.clip.length) || (it.cuts && it.cuts.length) || it.type === 'code' || it.sxyz) it.sxyz = (it.sxyz || [1, 1, 1]).map((x, k) => Math.round(x * f[k] * 1e6) / 1e6);
        else if (it.type === 'model') it.stretch = it.stretch.map((x, k) => r3(x * f[k] * 1e4) / 1e4);
        else if (it.type === 'sketch') {
          // circles / slots / polygons can't stretch on one axis: scale the outline evenly
          if (it.profiles.some((p) => p.k === 'circle' || p.k === 'slot' || p.k === 'ngon') && (Math.abs(f[0] - 1) < 1e-9) !== (Math.abs(f[1] - 1) < 1e-9)) { const g = Math.abs(f[0] - 1) > 1e-9 ? f[0] : f[1]; f = [g, g, f[2]]; }
          it.height = s3(it.height, 2);
          if (Math.abs(f[0] - 1) > 1e-9 || Math.abs(f[1] - 1) > 1e-9) {
            const fu = Math.sqrt(f[0] * f[1]);
            it.profiles = it.profiles.map((p) => {
              const q = Object.assign({}, p);
              if (p.k === 'poly') q.pts = p.pts.map((pt) => (pt.length >= 4 ? [s3(pt[0], 0), s3(pt[1], 1), s3(pt[2], 0), s3(pt[3], 1)] : [s3(pt[0], 0), s3(pt[1], 1)]));
              else { q.x = s3(p.x, 0); q.y = s3(p.y, 1); if (p.k === 'rect') { q.w = s3(p.w, 0); q.h = s3(p.h, 1); } else if (p.k === 'circle' || p.k === 'ngon') q.r = r3(p.r * fu); else if (p.k === 'slot') { q.w = r3(p.w * fu); q.h = r3(p.h * fu); } }
              return q;
            });
          }
        }
      });
    }
    // Scale gizmo released: the group's scale becomes real sizes; the group resets.
    _applyScale() {
      const id = this.sel; const o = this.objs[id]; const it = this._item(id); if (!o || !it) return;
      const fl = it.flip || [];
      const f = [Math.abs(o.group.scale.x), Math.abs(o.group.scale.y), Math.abs(o.group.scale.z)];
      o.group.scale.set(fl[0] ? -1 : 1, fl[1] ? -1 : 1, fl[2] ? -1 : 1);
      if (it.type === 'image') { this._toast('Set the image width in the panel', 'err'); this._dimUpdate(); return; }
      const ff = f.map((x) => (Math.abs(x - 1) < 1e-4 ? 1 : x));
      if (ff.some((x) => x !== 1)) this.undoStack.pop(); // the drag's snapshot: _edit takes the same one again
      this._scaleItem(id, ff);
      this._dimUpdate();
    }

    // ---------- measure ----------
    // Tap two points: distance plus ΔX / ΔY / ΔZ. Points snap to a triangle
    // corner within ~12 px, so box corners and edges measure exactly. With
    // nothing under the pointer the point lands on the build plate (Z = 0).
    _measureMode(on) {
      this.measureOn = !!on;
      if (!this.measures) this.measures = [];
      if (on) this._select(null);
      if (!on && this.mFirst) { this.scene.remove(this.mFirst.mk); this.mFirst = null; }
      if (!on) this._measureLiveClear();
      this._measureCursor(null);
      this.root.classList.toggle('cad-measuring', this.measureOn);
      this.root.querySelector('[data-measure]').classList.toggle('on', this.measureOn);
      this.root.querySelector('[data-mdone]').classList.toggle('hidden', !this.measureOn);
      this.root.querySelector('.cad-mbar').classList.toggle('hidden', !this.measureOn && !this.measures.length);
      this._measureHint();
    }
    _measureHint() {
      const h = this.root.querySelector('.cad-mhint');
      if (!h) return;
      const n = this.measures.length;
      h.textContent = !this.measureOn ? n + ' measurement' + (n === 1 ? '' : 's') : this.mFirst ? 'Now tap the second point' : 'Tap two points to measure — corners snap';
    }
    _measureHit(e) {
      const T = this.T;
      const rc = this._ray(e);
      const targets = this.designGroup.children.filter((o) => o.isMesh);
      Object.entries(this.objs).forEach(([id, o]) => { const it = this._item(id); if (it && !it.hidden && o.mesh.material.opacity > 0) targets.push(o.mesh); });
      const hits = rc.intersectObjects(targets, false);
      if (!hits.length) {
        const p = new T.Vector3();
        return rc.ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), 0), p) ? { point: p, snapped: false } : null;
      }
      const h = hits[0];
      const pos = h.object.geometry.attributes.position;
      const r = this.renderer.domElement.getBoundingClientRect();
      let best = null, bestD = 12;
      if (h.face) for (const i of [h.face.a, h.face.b, h.face.c]) {
        const v = new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld);
        const sp = v.clone().project(this.camera);
        const d = Math.hypot((sp.x + 1) / 2 * r.width + r.left - e.clientX, (1 - sp.y) / 2 * r.height + r.top - e.clientY);
        if (d < bestD) { bestD = d; best = v; }
      }
      return { point: best || h.point.clone(), snapped: !!best };
    }
    _marker(p, snapped) {
      const T = this.T;
      const m = new T.Points(new T.BufferGeometry().setFromPoints([p]), new T.PointsMaterial({ color: snapped ? this.colors.accent : this.colors.edge, size: snapped ? 12 : 8, sizeAttenuation: false, depthTest: false, transparent: true }));
      m.renderOrder = 10;
      return m;
    }
    _measureCursor(hit) {
      if (this.mCursor) { this.scene.remove(this.mCursor); this.mCursor.geometry.dispose(); this.mCursor = null; }
      if (hit) { this.mCursor = this._marker(hit.point, hit.snapped); this.scene.add(this.mCursor); }
    }
    _measureHover(e) {
      const hit = this._measureHit(e);
      this._measureCursor(hit);
      if (this.mFirst && hit && !(this._mLive && this._mLive.editing)) this._measureLive(hit.point);
    }
    // Live distance from the first point to the pointer. Double-click the label
    // to type an exact distance: the second point goes that far along the
    // current direction.
    _measureLive(b) {
      const T = this.T; const a = this.mFirst.p;
      let L = this._mLive;
      if (!L) {
        const line = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), new T.LineDashedMaterial({ color: this.colors.accent, dashSize: 1.5, gapSize: 1, depthTest: false, transparent: true, opacity: 0.9 }));
        line.renderOrder = 10; this.scene.add(line);
        const label = document.createElement('div');
        label.className = 'cad-mlabel cad-mlive';
        label.title = 'Double-click to type an exact distance';
        label.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); this._measureEdit(); });
        label.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        this.root.querySelector('.cad-mlayer').appendChild(label);
        L = this._mLive = { line, label };
      }
      L.b = b.clone();
      L.line.geometry.setFromPoints([a, b]); L.line.computeLineDistances();
      if (!L.editing) {
        const d = b.clone().sub(a); const fmt = (x) => (Math.abs(x) < 0.005 ? '0' : x.toFixed(2).replace(/\.?0+$/, ''));
        L.label.innerHTML = '<b>' + fmt(d.length()) + ' mm</b><span>ΔX ' + fmt(Math.abs(d.x)) + ' · ΔY ' + fmt(Math.abs(d.y)) + ' · ΔZ ' + fmt(Math.abs(d.z)) + '</span><i>double-click to type</i>';
      }
    }
    _measureLiveClear() {
      const L = this._mLive; if (!L) return;
      this.scene.remove(L.line); L.line.geometry.dispose(); L.label.remove(); this._mLive = null;
    }
    _measureEdit() {
      const L = this._mLive; if (!L || !this.mFirst || !L.b) return;
      const dir = L.b.clone().sub(this.mFirst.p);
      if (dir.length() < 1e-6) { this._toast('Move the pointer to set a direction first', 'err'); return; }
      L.editing = true; L.dir = dir.normalize();
      L.label.innerHTML = '<input type="text" inputmode="decimal" class="cad-mlive-in" value="' + r3(L.b.distanceTo(this.mFirst.p)) + '"><em>mm</em>';
      const inp = L.label.querySelector('input');
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { const v = evalNum(inp.value, NaN); if (v > 0) this._measureFinish(this.mFirst.p.clone().addScaledVector(L.dir, v), false); }
        if (ev.key === 'Escape') { L.editing = false; this._measureLive(L.b); this.root.focus({ preventScroll: true }); }
      });
      inp.addEventListener('blur', () => { if (this._mLive && this._mLive.editing) { this._mLive.editing = false; this._measureLive(this._mLive.b); } });
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }
    _measureClick(e) {
      const T = this.T;
      const hit = this._measureHit(e);
      if (!hit) return;
      if (!this.mFirst) {
        const mk = this._marker(hit.point, hit.snapped);
        this.scene.add(mk);
        this.mFirst = { p: hit.point.clone(), mk };
        this._measureHint();
        this._measureLive(hit.point.clone());
        return;
      }
      this._measureFinish(hit.point.clone(), hit.snapped);
    }
    _measureFinish(b, snapped) {
      const T = this.T;
      this._measureLiveClear();
      const a = this.mFirst.p;
      const hit = { snapped };
      this.scene.remove(this.mFirst.mk);
      const grp = new T.Group();
      grp.add(this.mFirst.mk, this._marker(b, hit.snapped));
      const line = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), new T.LineBasicMaterial({ color: this.colors.accent, depthTest: false, transparent: true }));
      line.renderOrder = 10;
      grp.add(line);
      this.scene.add(grp);
      const d = b.clone().sub(a);
      const fmt = (x) => (Math.abs(x) < 0.005 ? '0' : x.toFixed(2).replace(/\.?0+$/, ''));
      const label = document.createElement('div');
      label.className = 'cad-mlabel';
      label.innerHTML = '<b>' + fmt(d.length()) + ' mm</b><span>ΔX ' + fmt(Math.abs(d.x)) + ' · ΔY ' + fmt(Math.abs(d.y)) + ' · ΔZ ' + fmt(Math.abs(d.z)) + '</span>';
      this.root.querySelector('.cad-mlayer').appendChild(label);
      this.measures.push({ a, b, grp, label, d: d.length() });
      this.mFirst = null;
      this._measureHint();
      this._measureLabels();
    }
    _measureClear() {
      (this.measures || []).forEach((m) => { this.scene.remove(m.grp); m.grp.traverse((o) => o.geometry && o.geometry.dispose()); m.label.remove(); });
      this.measures = [];
      if (this.mFirst) { this.scene.remove(this.mFirst.mk); this.mFirst = null; }
      this._measureLiveClear();
      this._measureHint();
      if (!this.measureOn) this.root.querySelector('.cad-mbar').classList.add('hidden');
    }
    _measureLabels() {
      const r = this.viewEl.getBoundingClientRect();
      const L = this._mLive;
      if (L && this.mFirst && L.b) {
        const mid = this.mFirst.p.clone().add(L.b).multiplyScalar(0.5).project(this.camera);
        L.label.style.display = mid.z < 1 ? '' : 'none';
        L.label.style.transform = 'translate(' + Math.round((mid.x + 1) / 2 * r.width) + 'px,' + Math.round((1 - mid.y) / 2 * r.height) + 'px) translate(-50%, -130%)';
      }
      for (const m of this.measures) {
        const mid = m.a.clone().add(m.b).multiplyScalar(0.5).project(this.camera);
        const vis = mid.z < 1;
        m.label.style.display = vis ? '' : 'none';
        if (vis) m.label.style.transform = 'translate(' + Math.round((mid.x + 1) / 2 * r.width) + 'px,' + Math.round((1 - mid.y) / 2 * r.height) + 'px) translate(-50%, -130%)';
      }
    }

    // ---------- keyboard (desktop) ----------
    _key(e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { if (e.key === 'Escape') t.blur(); return; }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (this.sk) {
        if (k === 'escape') { if (this.sk.pend) { this.sk.pend = null; this._sketchDraw(); } else if (this.sk.pts.length) { this.sk.pts = []; this._sketchDraw(); } else this._sketchEnd(false); }
        else if (k === 'enter') this._sketchEnd(true);
        else if (k === 'backspace' || k === 'delete' || (mod && k === 'z')) { e.preventDefault(); this._sketchUndo(); }
        else if (k === 'l') this._sketchTool('line');
        else if (k === 'r') this._sketchTool('rect');
        else if (k === 'c') this._sketchTool('circle');
        else if (k === 'o') this._sketchTool('slot');
        else if (k === 'p') this._sketchTool('ngon');
        else if (k === 'a') this._sketchOpt('arc');
        else if (k === 'x') this._sketchOpt('cut');
        return;
      }
      if (k === 's' && !mod) { this._sketchStart(null); return; }
      if (k === 'e' && !mod) { this._faceMode(!this.faceOn); return; }
      if (k === 'escape' && this.exMode) { this._extrudeEnd(); return; }
      if (k === 'escape' && this.cutMode) { this._cutEnd(); return; }
      if (k === 'escape' && this.faceOn) { this._faceMode(false); return; }
      if (k === 'escape' && this.edgeMode) { this._edgeModeEnd(); return; }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this._redo() : this._undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this._redo(); return; }
      // Never let the browser select the page's text from inside the 3D view.
      if (mod && k === 'a') { e.preventDefault(); window.getSelection && window.getSelection().removeAllRanges(); this._selectAll(); return; }
      if (mod && k === 'g') { e.preventDefault(); if (e.shiftKey) this._uncombine(this._soleGroup() || this._gid(this.sel)); else this._combine(); return; }
      if (mod && k === 'd' && this.multi.length) { e.preventDefault(); this._duplicateMany(this.multi.slice()); return; }
      if (mod && k === 'd' && this.sel) { e.preventDefault(); this._duplicate(this.sel); return; }
      if (mod) return;
      if ((k === 'delete' || k === 'backspace') && this.multi.length && !this.readOnly) { e.preventDefault(); this._deleteMany(this.multi.slice()); return; }
      if ((k === 'delete' || k === 'backspace') && this.sel && !this.readOnly) { e.preventDefault(); this._delete(this.sel); return; }
      if (k === 'escape') { if (this.measureOn) { this._measureMode(false); return; } this._select(null); return; }
      if (k === 'd') { this._measureMode(!this.measureOn); return; }
      if (k === 'm' || k === 'g') { this._setMode('translate'); return; }
      if (k === 'r') { this._setMode('rotate'); return; }
      if (k === 't') { this._setMode('scale'); return; }
      if (k === 'f') { this._fit(); return; }
      if (k === 'h') { this._toggleHoles(); return; }
      if (k === 'b') { this._add('box'); return; }
      if (k === 'c') { this._add('cylinder'); return; }
      if (k === 'i') { this.root.querySelector('.cad-file').click(); return; }
      const code = (e.code || '').replace('Digit', '');
      if (['1', '2', '3', '4'].includes(code)) { this._view((e.shiftKey ? ['iso', 'bottom', 'back', 'left'] : ['iso', 'top', 'front', 'right'])[+code - 1]); return; }
      // Arrow keys nudge the selection (Shift = 10×).
      if (this.multi.length && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pageup', 'pagedown'].includes(k)) {
        e.preventDefault();
        const st = (this.data.settings.snap || 1) * (e.shiftKey ? 10 : 1);
        const dv = { arrowleft: [-st, 0, 0], arrowright: [st, 0, 0], arrowup: [0, st, 0], arrowdown: [0, -st, 0], pageup: [0, 0, st], pagedown: [0, 0, -st] }[k];
        this._nudgeSnap();
        this.multi.slice().forEach((id) => { const it = this._item(id); if (it) it.pos = it.pos.map((v, i) => r3(v + dv[i])); });
        this._refreshItems(); this._commit();
        return;
      }
      if (this.sel && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pageup', 'pagedown'].includes(k)) {
        e.preventDefault();
        const s = (this.data.settings.snap || 1) * (e.shiftKey ? 10 : 1);
        const d = { arrowleft: [-s, 0, 0], arrowright: [s, 0, 0], arrowup: [0, s, 0], arrowdown: [0, -s, 0], pageup: [0, 0, s], pagedown: [0, 0, -s] }[k];
        this._nudgeSnap();
        const it0 = this._item(this.sel); if (it0) it0.pos = it0.pos.map((v, i) => r3(v + d[i]));
        this._refreshItems(); this._commit();
        this._fillTransform();
      }
    }
  }

  global.CadEngine = CadEngine;
})(typeof window !== 'undefined' ? window : globalThis);
