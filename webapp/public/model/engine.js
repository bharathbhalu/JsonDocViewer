/* 3D Model viewport. Separate from public/cad/engine.js.
 *
 * Desktop: the left button selects and drags the gizmo. Right-drag orbits,
 * middle-drag pans, Shift / Ctrl / ⌘ with the right button pans. The wheel
 * zooms toward the pointer. A trackpad: two-finger scroll orbits, Shift pans,
 * pinch zooms.
 * iPad: one finger orbits, a tap selects, two fingers pan, pinch zooms.
 * Apple Pencil never orbits — it selects, drags the gizmo, and hover highlights.
 * The corner cube turns with the view on mouse, finger, and Pencil.
 */
(function (global) {
  const C = () => global.ModelCore;
  const VENDOR = '/model/vendor/';
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
  // One turn is the same pose. Keep each axis inside -180°..180° so 360° does not pile up.
  function wrapDeg(d) {
    if (!Number.isFinite(d)) return 0;
    let x = ((d % 360) + 360) % 360;
    if (x > 180) x -= 360;
    return r3(x);
  }
  function evalNum(s, fallback) {
    const t = String(s == null ? '' : s).trim().replace(/,/g, '.');
    if (!t) return fallback;
    if (!/^[\d+\-*/(). ]+$/.test(t)) return fallback;
    try { const v = Function('"use strict";return (' + t + ')')(); return Number.isFinite(v) ? v : fallback; } catch (e) { return fallback; }
  }
  const ICON = {
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z"/><path d="M12 12.2 20 8.5M12 12.2 4 8.5M12 12.2V20"/></svg>',
    cylinder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="6.5" rx="6.5" ry="2.4"/><path d="M5.5 6.5v11c0 1.3 2.9 2.4 6.5 2.4s6.5-1.1 6.5-2.4v-11"/></svg>',
    sphere: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.2"/><ellipse cx="12" cy="12" rx="7.2" ry="2.6"/><path d="M12 4.8v14.4"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    xray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 8.5 12 4.5l7 4v7l-7 4-7-4z" opacity=".35"/><path d="M8 10.2 12 8l4 2.2v4.4L12 16.8l-4-2.2z"/><path d="M12 8v8.8M8 10.2l4 2.2 4-2.2"/></svg>',
    sketch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5 15.5 5l3.5 3.5L7.5 20H4z"/><path d="M13 7.5 16.5 11"/></svg>',
    face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 8.5 12 4.5l7 4v7l-7 4-7-4z"/><path d="M12 12V4.5M12 12l7-3.5"/></svg>',
    join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h7v8H4zM13 8h7v8h-7z"/></svg>',
    import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4v10"/><path d="M8 10.5 12 14.5 16 10.5"/><path d="M5 18h14"/></svg>',
    export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 14V4"/><path d="m8 7.5 4-4 4 4"/><path d="M5 18h14"/></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8 4 12l4 4"/><path d="M4 12h9a5 5 0 0 1 0 10h-2"/></svg>',
    redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8l4 4-4 4"/><path d="M20 12h-9a5 5 0 0 0 0 10h2"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18"/><path d="m8 7 4-4 4 4M8 17l4 4 4-4M7 8 3 12l4 4M17 8l4 4-4 4"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v4h-4"/></svg>',
    scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M9.5 6.8A9 9 0 0 1 12 6.5C18 6.5 21.5 12 21.5 12a17 17 0 0 1-3.2 3.6"/><path d="M6.2 8.2A17 17 0 0 0 2.5 12S6 17.5 12 17.5a9 9 0 0 0 3.2-.6"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.2L6 20V5a1 1 0 0 1 1-1z"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M8 7l.7 12h6.6L16 7"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5 15.5 5l3.5 3.5L7.5 20H4z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><path d="M15 15h4M17 13v4"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L19 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="7" width="14" height="10" rx="1.2"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="6.5"/></svg>',
    line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 18 18 6"/></svg>',
    dim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15h14"/><path d="m5 15 2.4-2.4M5 15l2.4 2.4M19 15l-2.4-2.4M19 15l-2.4 2.4"/><path d="M8 15V8M16 15V8"/></svg>',
    extrude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 15 12 11l8 4-8 4z"/><path d="M12 11V5M9 7.2 12 5l3 2.2"/></svg>',
    cut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="16" r="2.2"/><circle cx="17" cy="16" r="2.2"/><path d="m8.4 14.6 7-8M15.6 14.6l-7-8"/></svg>',
    bodies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 8.5 9 5.5l5 3v6l-5 3-5-3z"/><path d="M14 9.5 19 6.5v6L14 16"/></svg>',
    flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 16a6 6 0 1 1 1.6-4"/><path d="M8 8v4h4"/></svg>',
  };

  function ModelEngine(host, opts) {
    this.host = host;
    this.opts = opts || {};
    this.destroyed = false;
    this.ready = false;
    this.data = C().createStarter();
    this.sel = null;
    this.multi = [];
    this.hov = null;
    this.xfMode = 'translate';
    this._rotAxis = 'z';
    this._splitPlane = 'yz';
    this.faceOn = false;
    this.mode = 'object';
    this._faceTool = C().faceTool('extrude');
    this._cutHow = 'delete';
    this._xray = false;
    this.sk = null;
    this.objs = {};
    this._shapeSigs = {};
    this.disposers = [];
    this.buildSeq = 0;
    this.root = document.createElement('div');
    this.root.className = 'mdl-root';
    this.root.tabIndex = 0;
    host.appendChild(this.root);
    this._boot();
  }

  ModelEngine.prototype._on = function (el, ev, fn, o) {
    el.addEventListener(ev, fn, o);
    this.disposers.push(() => el.removeEventListener(ev, fn, o));
  };
  function modelSnap(objects) {
    return JSON.stringify(C().snapObjects(objects));
  }
  ModelEngine.prototype._changed = function () {
    if (!this.data.history) this.data.history = { past: [], future: [] };
    const now = modelSnap(this.data.objects);
    if (!this._quiet && this._snap != null && this._snap !== now) {
      this.data.history.past.push(JSON.parse(this._snap));
      if (this.data.history.past.length > 50) this.data.history.past.shift();
      this.data.history.future = [];
    }
    this._snap = now;
    this._syncHist();
    if (this.opts.onChange) this.opts.onChange();
  };
  ModelEngine.prototype._syncHist = function () {
    const h = this.data.history || { past: [], future: [] };
    const u = this.root.querySelector('[data-undo]');
    const r = this.root.querySelector('[data-redo]');
    if (u) u.disabled = !h.past.length;
    if (r) r.disabled = !h.future.length;
  };
  ModelEngine.prototype._restore = function (objects) {
    this._quiet = true;
    this.data.objects = (objects || []).map((o) => C().normObject(o));
    const ids = new Set(this.data.objects.map((o) => o.id));
    this.multi = this.multi.filter((id) => ids.has(id));
    if (!ids.has(this.sel)) this.sel = this.multi[this.multi.length - 1] || null;
    this.root.dataset.sel = this.sel || '';
    this._snap = modelSnap(this.data.objects);
    this._quiet = false;
    if (this.itemsGroup) {
      for (const id of Object.keys(this.objs)) {
        if (ids.has(id)) continue;
        const o = this.objs[id];
        this.itemsGroup.remove(o.group);
        o.mesh.geometry.dispose();
        o.edges.geometry.dispose();
        o.mesh.material.dispose();
        o.edges.material.dispose();
        (o.picks || []).forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
        delete this.objs[id];
      }
      for (const o of this.data.objects) {
        if (this.objs[o.id]) this._place(this.objs[o.id], o);
        else this._preview(o);
      }
    }
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._syncHist();
    this._requestBuild();
    if (this.opts.onChange) this.opts.onChange();
  };
  ModelEngine.prototype._undo = function () {
    const h = this.data.history;
    if (!h || !h.past.length || !this._snap) return;
    h.future.push(JSON.parse(this._snap));
    if (h.future.length > 50) h.future.shift();
    this._restore(h.past.pop());
  };
  ModelEngine.prototype._redo = function () {
    const h = this.data.history;
    if (!h || !h.future.length || !this._snap) return;
    h.past.push(JSON.parse(this._snap));
    this._restore(h.future.pop());
  };
  ModelEngine.prototype._setBusy = function (kind) {
    const card = this.root.querySelector('[data-load]');
    const bar = this.root.querySelector('[data-loadbar]');
    if (card) card.classList.toggle('hidden', kind !== 'load');
    if (bar) bar.classList.toggle('hidden', kind !== 'update');
  };
  const ORANGE = 0xe06a12;
  ModelEngine.prototype._tip = function (btn) {
    let tip = this.root.querySelector('[data-tip]');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'mdl-tip';
      tip.setAttribute('data-tip', '');
      this.root.appendChild(tip);
    }
    if (!btn) { tip.classList.remove('show'); return; }
    const name = btn.getAttribute('aria-label') || '';
    if (!name) { tip.classList.remove('show'); return; }
    tip.textContent = name;
    const r = btn.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    const rightSide = r.left - host.left > host.width * 0.55;
    tip.style.top = (r.top - host.top + r.height / 2) + 'px';
    if (rightSide) {
      tip.style.left = (r.left - host.left - 8) + 'px';
      tip.style.transform = 'translate(-100%, -50%)';
    } else {
      tip.style.left = (r.right - host.left + 8) + 'px';
      tip.style.transform = 'translateY(-50%)';
    }
    tip.classList.add('show');
  };
  ModelEngine.prototype._bindTips = function (scope) {
    (scope || this.root).querySelectorAll('button[aria-label]').forEach((b) => {
      if (b.dataset.tipBound) return;
      b.dataset.tipBound = '1';
      b.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') this._tip(b); });
      b.addEventListener('pointerleave', () => this._tip(null));
    });
  };
  ModelEngine.prototype._toast = function (msg) {
    const t = this.root.querySelector('.mdl-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'mdl-toast show';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.className = 'mdl-toast'; }, 2800);
  };
  ModelEngine.prototype._obj = function (id) { return this.data.objects.find((o) => o.id === id); };

  ModelEngine.prototype.destroy = function () {
    this.destroyed = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._buildT);
    clearInterval(this._installPoll);
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* gone */ }
    this.disposers.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    try { if (this.renderer) this.renderer.dispose(); } catch (e) { /* ignore */ }
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  };

  ModelEngine.prototype.loadFromHtml = function (html) {
    this._pendingHtml = html;
    if (this.ready) this._applyHtml(html);
  };
  ModelEngine.prototype.serializeToHtml = function () {
    return C().serializeToHtml(this.data, this.data.title);
  };
  ModelEngine.prototype._applyHtml = function (html) {
    const doc = C().parseHtml(html);
    if (!doc) return;
    this.data = doc;
    this.sel = null;
    this.multi = [];
    this._fitted = false;
    this._shapeSigs = {};
    this._snap = modelSnap(this.data.objects);
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._syncHist();
    const primed = [];
    for (const o of this.data.objects) {
      if (o.hidden || !o.view || !o.view.vertices || o.view.vertices.length < 9) continue;
      primed.push({
        id: o.id,
        vertices: Float32Array.from(o.view.vertices),
        triangles: Uint32Array.from(o.view.triangles || []),
        faces: o.view.faces || [],
        normals: o.view.normals && o.view.normals.length === o.view.vertices.length ? Float32Array.from(o.view.normals) : null,
        edges: o.view.edges && o.view.edges.length >= 6 ? Float32Array.from(o.view.edges) : null,
      });
    }
    if (primed.length) this._showBodies(primed);
    this._warming = primed.length > 0;
    if (primed.length) this._clearBusy();
    else this._setBusy('load');
    this._requestBuild();
  };

  ModelEngine.prototype._boot = async function () {
    this.root.innerHTML = '<div class="mdl-center"><p>Loading 3D model…</p></div>';
    let st = { installed: true, versions: { installed: '1' } };
    try { st = await api('/api/cad/addon'); } catch (e) { /* libraries may already be on disk */ }
    if (this.destroyed) return;
    if (st && st.installed === false) { this._installCard(st); return; }
    this.version = (st.versions && st.versions.installed) || '1';
    try {
      this.T = await import(VENDOR + 'three-bundle.js?v=' + encodeURIComponent(this.version));
    } catch (e) { this._fatal('Could not load the 3D viewer. ' + e.message); return; }
    if (this.destroyed) return;
    this._buildDom();
    try { this._initThree(); }
    catch (e) { this._fatal('This browser could not start the 3D view. ' + (e && e.message ? e.message : e)); return; }
    this._initWorker();
    this.ready = true;
    if (this._pendingHtml != null) this._applyHtml(this._pendingHtml);
    else this._requestBuild();
  };
  ModelEngine.prototype._fatal = function (msg) {
    this.root.innerHTML = '<div class="mdl-center"><div class="mdl-card"><p class="mdl-err">' + esc(msg) + '</p></div></div>';
  };
  ModelEngine.prototype._installCard = function (st) {
    const render = (s) => {
      this.root.innerHTML = '<div class="mdl-center"><div class="mdl-card"><h3>3D modeling is not installed yet</h3><p>A one-time setup builds OpenCascade and Three.js on this computer. The same libraries serve this view and the older 3D design.</p>'
        + (s.error ? '<p class="mdl-err">' + esc(s.error) + '</p>' : '')
        + '<button type="button" data-install ' + (s.busy ? 'disabled' : '') + '>' + (s.busy ? 'Installing…' : 'Install 3D modeling') + '</button></div></div>';
      const b = this.root.querySelector('[data-install]');
      if (b) b.onclick = async () => { try { await api('/api/cad/addon/install', {}); poll(); } catch (e) { s.error = e.message; render(s); } };
    };
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
  };

  ModelEngine.prototype._buildDom = function () {
    this.root.innerHTML = `
      <div class="mdl-view" data-view>
        <div class="mdl-dims" data-dims></div>
        <div class="mdl-skmeas" data-skmeas></div>
      </div>
      <div class="mdl-rail" role="toolbar" aria-label="Bodies">
        <button type="button" data-add="box" title="Box" aria-label="Box">${ICON.box}</button>
        <button type="button" data-add="cylinder" title="Cylinder" aria-label="Cylinder">${ICON.cylinder}</button>
        <button type="button" data-add="sphere" title="Sphere" aria-label="Sphere">${ICON.sphere}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-sketch title="Sketch" aria-label="Sketch">${ICON.sketch}</button>
        <button type="button" data-mode="object" class="on" title="Objects" aria-label="Objects">${ICON.bodies}</button>
        <button type="button" data-mode="face" title="Faces" aria-label="Faces">${ICON.face}</button>
        <button type="button" data-mode="edge" title="Edges" aria-label="Edges">${ICON.line}</button>
        <button type="button" data-import title="Import STL or OBJ" aria-label="Import">${ICON.import}</button>
        <button type="button" data-export title="Export mesh" aria-label="Export">${ICON.export}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-fit title="Fit" aria-label="Fit">${ICON.fit}</button>
        <button type="button" data-xray title="X-ray view" aria-label="X-ray view">${ICON.xray}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-undo title="Undo" aria-label="Undo" disabled>${ICON.undo}</button>
        <button type="button" data-redo title="Redo" aria-label="Redo" disabled>${ICON.redo}</button>
      </div>
      <div class="mdl-skbar hidden" data-facebar>
        <div class="mdl-op">
          <span class="mdl-opk">On this face</span>
          <span class="mdl-chip" data-facedim>Select a face</span>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Sketch</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-ico" data-sketchface aria-label="New sketch on this face">${ICON.sketch}</button>
            <button type="button" class="mdl-ico" data-fromface aria-label="Sketch from the face outline">${ICON.pencil}</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Tool</span>
          <div class="mdl-oprow mdl-picks">
            <button type="button" class="mdl-pick on" data-facetool="extrude" title="Push or pull this face">Extrude</button>
            <button type="button" class="mdl-pick" data-facetool="cut" title="Cut the body with a plane">Cut by plane</button>
          </div>
        </div>
        <span class="mdl-vsep" data-faceextrude></span>
        <div class="mdl-op" data-faceextrude>
          <span class="mdl-opk">Extrude</span>
          <div class="mdl-oprow">
            <label class="mdl-len">Length<input data-exdist type="text" inputmode="decimal" value=""></label>
            <button type="button" class="mdl-word" data-exgo>Extrude</button>
          </div>
        </div>
        <span class="mdl-vsep hidden" data-facecut></span>
        <div class="mdl-op hidden" data-facecut>
          <span class="mdl-opk">Cut by plane</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-plane on" data-splitplane="yz" aria-label="Cutting plane YZ">YZ</button>
            <button type="button" class="mdl-plane" data-splitplane="xz" aria-label="Cutting plane XZ">XZ</button>
            <button type="button" class="mdl-plane" data-splitplane="xy" aria-label="Cutting plane XY">XY</button>
            <button type="button" class="mdl-ico" data-cutnudge="-1" aria-label="Move the plane backward">${ICON.down}</button>
            <label class="mdl-len">Offset<input data-splitoff type="text" inputmode="decimal" value="0"></label>
            <button type="button" class="mdl-ico" data-cutnudge="1" aria-label="Move the plane forward">${ICON.up}</button>
            <button type="button" class="mdl-word" data-split>Cut by plane</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <button type="button" class="mdl-word mdl-ghost" data-facedone>Objects</button>
      </div>
      <div class="mdl-skbar hidden" data-edgebar>
        <div class="mdl-op">
          <span class="mdl-opk">On this edge</span>
          <span class="mdl-chip" data-edgedim>Select an edge</span>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Round</span>
          <div class="mdl-oprow">
            <label class="mdl-len">Radius<input data-edger type="text" inputmode="decimal" value="1"></label>
            <button type="button" class="mdl-word" data-edgeop="fillet">Round</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Chamfer</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-word" data-edgeop="chamfer">Chamfer</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Sharp</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-word" data-edgeop="sharp">Remove round</button>
          </div>
        </div>
        <button type="button" class="mdl-word mdl-ghost" data-edgeobj>Objects</button>
      </div>
      <div class="mdl-skbar mdl-multibar hidden" data-cutbar>
        <div class="mdl-op mdl-joinop">
          <span class="mdl-opk">Join</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-word" data-barjoin title="Join the selected bodies into one">Join bodies</button>
          </div>
        </div>
        <div class="mdl-cutgroup hidden" data-cutops>
          <span class="mdl-cutgroup-k">Cut</span>
          <div class="mdl-cutgroup-body">
            <div class="mdl-op">
              <span class="mdl-opk">Overlap</span>
              <div class="mdl-oprow mdl-picks">
                <button type="button" class="mdl-pick on" data-cuthow="delete" title="Remove the shared volume">Delete</button>
                <button type="button" class="mdl-pick" data-cuthow="split" title="Divide into separate bodies">Split</button>
              </div>
            </div>
            <span class="mdl-vsep"></span>
            <div class="mdl-op">
              <span class="mdl-opk">Which body</span>
              <div class="mdl-oprow">
                <button type="button" class="mdl-word mdl-cutway" data-cuta>First cuts second</button>
                <button type="button" class="mdl-word mdl-cutway" data-cutb>Second cuts first</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="mdl-skbar hidden" data-skbar>
        <div class="mdl-op">
          <span class="mdl-opk">Draw</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-ico" data-sktool="rect" aria-label="Rectangle">${ICON.rect}</button>
            <button type="button" class="mdl-ico" data-sktool="circle" aria-label="Circle">${ICON.circle}</button>
            <button type="button" class="mdl-ico" data-sktool="line" aria-label="Line">${ICON.line}</button>
            <button type="button" class="mdl-ico" data-skperp aria-label="Lock 90° to the last line" title="Lock 90°">${ICON.flip}</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Measure</span>
          <div class="mdl-oprow"><span data-skdims></span></div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Extrude</span>
          <div class="mdl-oprow">
            <label class="mdl-len">Length<input data-skh type="text" inputmode="decimal" value="1"></label>
            <button type="button" class="mdl-word hidden" data-sksplit>Split face</button>
            <button type="button" class="mdl-word" data-skdone>Done</button>
          </div>
        </div>
        <button type="button" class="mdl-word mdl-ghost" data-skcancel>Cancel</button>
      </div>
      <input data-file type="file" accept=".stl,.obj,model/stl" hidden>
      <div class="mdl-exportmenu hidden" data-exportmenu role="menu" aria-label="Export">
        <button type="button" data-exfmt="stl" role="menuitem">Download STL</button>
        <button type="button" data-exfmt="obj" role="menuitem">Download OBJ</button>
        <button type="button" data-exfmt="3mf" role="menuitem">Download 3MF</button>
      </div>
      <aside class="mdl-side">
        <header class="mdl-sidehead"><span>Bodies</span><div class="mdl-iconrow"><button type="button" class="mdl-ico" data-hideall aria-label="Hide all">${ICON.eyeOff}</button><button type="button" class="mdl-ico" data-showall aria-label="Show all">${ICON.eye}</button><button type="button" class="mdl-ico" data-point aria-label="Save checkpoint">${ICON.bookmark}</button><button type="button" class="mdl-ico" data-more aria-label="Select more">${ICON.more}</button></div></header>
        <div class="mdl-list" data-list></div>
        <div class="mdl-points" data-points>
          <div class="mdl-composer hidden" data-pointnew>
            <input class="mdl-pointname" data-pointname type="text" maxlength="80" aria-label="Checkpoint name" autocomplete="off" autocorrect="off" spellcheck="false">
            <button type="button" class="mdl-ico mdl-go" data-pointok aria-label="Save checkpoint">${ICON.check}</button>
            <button type="button" class="mdl-ico" data-pointcancel aria-label="Cancel">${ICON.close}</button>
          </div>
          <div data-pointlist></div>
        </div>
        <div data-insp></div>
      </aside>
      <div class="mdl-pill" data-viewname>Perspective</div>
      <p class="mdl-hint"><span class="mdl-hint-desk">Right-drag orbits · middle-drag pans · scroll zooms · two-finger scroll orbits</span><span class="mdl-hint-touch">Drag to orbit · two fingers pan · pinch zooms · Pencil selects</span></p>
      <div class="mdl-cube" data-cube title="Drag to turn the view. Tap a face to look from that side.">
        <div class="mdl-spin">
          <button type="button" class="mdl-face cv-right" data-cubeview="right">Right</button>
          <button type="button" class="mdl-face cv-left" data-cubeview="left">Left</button>
          <button type="button" class="mdl-face cv-top" data-cubeview="top">Top</button>
          <button type="button" class="mdl-face cv-bottom" data-cubeview="bottom">Bottom</button>
          <button type="button" class="mdl-face cv-front" data-cubeview="front">Front</button>
          <button type="button" class="mdl-face cv-back" data-cubeview="back">Back</button>
        </div>
      </div>
      <div class="mdl-load" data-load>
        <div class="mdl-card">
          <h3>Loading the model</h3>
          <p>Building the shapes. This can take a moment.</p>
        </div>
      </div>
      <div class="mdl-loadbar hidden" data-loadbar>Updating the model…</div>
      <div class="mdl-toast"></div>`;
    this.viewEl = this.root.querySelector('[data-view]');
    this._cubeSpin = this.root.querySelector('.mdl-spin');
    this._bindTips(this.root);
    this.root.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => this._add(b.dataset.add); });
    this.root.querySelector('[data-fit]').onclick = () => this._fit();
    this.root.querySelector('[data-xray]').onclick = () => this._setXray(!this._xray);
    this.root.querySelector('[data-undo]').onclick = () => this._undo();
    this.root.querySelector('[data-redo]').onclick = () => this._redo();
    this.root.querySelector('[data-sketch]').onclick = () => this._sketchStart();
    this.root.querySelectorAll('.mdl-rail [data-mode]').forEach((b) => { b.onclick = () => this._setMode(b.dataset.mode); });
    this.root.querySelector('[data-sketchface]').onclick = () => this._sketchStart();
    this.root.querySelector('[data-fromface]').onclick = () => this._sketchFromFace();
    this.root.querySelector('[data-exgo]').onclick = () => this._extrudeLength();
    this.root.querySelector('[data-exdist]').addEventListener('change', () => this._extrudeLength());
    this.root.querySelectorAll('[data-facetool]').forEach((b) => { b.onclick = () => this._setFaceTool(b.dataset.facetool); });
    this.root.querySelectorAll('[data-splitplane]').forEach((b) => b.onclick = () => {
      this._splitPlane = b.dataset.splitplane;
      this.root.querySelectorAll('[data-splitplane]').forEach((x) => x.classList.toggle('on', x === b));
      this._showCutPlane();
    });
    this.root.querySelectorAll('[data-cutnudge]').forEach((b) => b.onclick = () => this._nudgeCut(Number(b.dataset.cutnudge)));
    const splitOff = this.root.querySelector('[data-splitoff]');
    if (splitOff) splitOff.addEventListener('input', () => this._showCutPlane());
    this.root.querySelector('[data-split]').onclick = () => this._splitFace();
    this.root.querySelector('[data-facedone]').onclick = () => this._setMode('object');
    this._syncFaceTool();
    this.root.querySelector('[data-edgeobj]').onclick = () => this._setMode('object');
    this.root.querySelectorAll('[data-edgeop]').forEach((b) => { b.onclick = () => this._edgeApply(b.dataset.edgeop); });
    const edgeR = this.root.querySelector('[data-edger]');
    if (edgeR) edgeR.addEventListener('change', () => this._edgeApply('fillet'));
    this.root.querySelector('[data-cuta]').onclick = () => this._cutPair(0);
    this.root.querySelector('[data-cutb]').onclick = () => this._cutPair(1);
    this.root.querySelectorAll('[data-cuthow]').forEach((b) => { b.onclick = () => this._cutHowSet(b.dataset.cuthow); });
    const barJoin = this.root.querySelector('[data-barjoin]');
    if (barJoin) barJoin.onclick = () => this._join();
    this.root.querySelector('[data-skperp]').onclick = () => this._sketchPerpToggle();
    this.root.querySelector('[data-import]').onclick = () => this.root.querySelector('[data-file]').click();
    this.root.querySelector('[data-export]').onclick = (e) => {
      e.stopPropagation();
      this._toggleExportMenu();
    };
    this.root.querySelectorAll('[data-exfmt]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        this._hideExportMenu();
        this._exportMesh(b.dataset.exfmt);
      };
    });
    this.root.querySelector('[data-more]').onclick = () => this._setAdding(!this.adding);
    this.root.querySelector('[data-hideall]').onclick = () => this._setAllHidden(true);
    this.root.querySelector('[data-showall]').onclick = () => this._setAllHidden(false);
    this.root.querySelector('[data-point]').onclick = () => this._askPoint();
    const pointName = this.root.querySelector('[data-pointname]');
    this.root.querySelector('[data-pointok]').onclick = () => this._savePoint(pointName.value);
    this.root.querySelector('[data-pointcancel]').onclick = () => this._cancelPoint();
    pointName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._savePoint(pointName.value); }
      else if (e.key === 'Escape') { e.preventDefault(); this._cancelPoint(); }
    });
    this.root.querySelector('[data-file]').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) this._importFile(f); };
    this.root.querySelectorAll('[data-sktool]').forEach((b) => { b.onclick = () => this._sketchTool(b.dataset.sktool); });
    this.root.querySelector('[data-skdone]').onclick = () => this._sketchDone();
    this.root.querySelector('[data-sksplit]').onclick = () => this._sketchSplit();
    this.root.querySelector('[data-skcancel]').onclick = () => this._sketchCancel();
    this._on(this.root, 'keydown', (e) => this._key(e));
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
    this._bindCube(this.root.querySelector('[data-cube]'));
    this._renderList();
    this._renderInsp();
  };

  ModelEngine.prototype._initThree = function () {
    const T = this.T;
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
    if (T.SRGBColorSpace) renderer.outputColorSpace = T.SRGBColorSpace;
    // The dimension overlay sits on this same view. Orbit and the gizmo listen
    // on the view, so a drag that starts on a label still turns the camera.
    const dims = this.viewEl.querySelector('[data-dims]');
    if (dims) this.viewEl.insertBefore(renderer.domElement, dims);
    else this.viewEl.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    this.renderer = renderer;
    const scene = new T.Scene();
    this.scene = scene;
    const cam = new T.PerspectiveCamera(40, 1, 0.5, 20000);
    cam.up.set(0, 0, 1);
    cam.position.set(160, -200, 140);
    this.camera = cam;
    this.persp = cam;
    this.ortho = new T.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
    this.ortho.up.set(0, 0, 1);
    this.target = new T.Vector3(0, 0, 10);
    cam.lookAt(this.target);
    this.hemi = new T.HemisphereLight(0xffffff, 0xb7c0cc, 1.25);
    scene.add(this.hemi);
    const key = new T.DirectionalLight(0xffffff, 1.2); key.position.set(-80, -140, 180); scene.add(key);
    const fill = new T.DirectionalLight(0xffffff, 0.4); fill.position.set(120, 60, 40); scene.add(fill);
    this.itemsGroup = new T.Group();
    scene.add(this.itemsGroup);

    const controls = new T.OrbitControls(cam, this.viewEl);
    controls.target = this.target;
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.enableZoom = false;
    controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: -1, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.ROTATE };
    controls.touches = { ONE: -1, TWO: T.TOUCH.PAN };
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    this.controls = controls;

    const tc = new T.TransformControls(cam, this.viewEl);
    tc.setSpace('world');
    tc.size = matchMedia('(pointer: coarse)').matches ? 1.25 : 0.9;
    scene.add(tc.getHelper());
    this.tc = tc;
    tc.addEventListener('dragging-changed', (e) => {
      this.dragging = e.value;
      if (e.value) this.controls.enabled = false;
      else {
        this._freeNav();
        this._renderList();
        this._changed();
      }
    });
    tc.addEventListener('objectChange', () => this._readGizmo());

    let startDir = null;
    controls.addEventListener('start', () => { startDir = this.camera.position.clone().sub(this.target).normalize(); });
    controls.addEventListener('change', () => {
      if (!this.isOrtho || !startDir) return;
      const d = this.camera.position.clone().sub(this.target).normalize();
      if (d.angleTo(startDir) > 0.01) { startDir = null; this._setOrtho(false); this._markView(null); }
    });
    controls.addEventListener('end', () => { startDir = null; });

    this._bindPointer();
    this._bindWheel();
    this._on(this.viewEl, 'touchmove', (e) => this._pinch(e), { passive: false });
    let gs = 1;
    this._on(this.viewEl, 'gesturestart', (e) => { e.preventDefault(); gs = 1; });
    this._on(this.viewEl, 'gesturechange', (e) => { e.preventDefault(); this._zoom(gs / (e.scale || 1), e); gs = e.scale || 1; });

    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.viewEl);
    this.disposers.push(() => this.ro.disconnect());
    this.mo = new MutationObserver(() => this._applyTheme());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.disposers.push(() => this.mo.disconnect());
    this._applyTheme();
    this._resize();
    const loop = () => {
      if (this.destroyed) return;
      this._raf = requestAnimationFrame(loop);
      if (!(this.isOrtho && controls.state === -1)) controls.update();
      if (this.isOrtho) this._orthoFrustum();
      this._cubeSync();
      this._layoutDims();
      if (this.sk) this._syncSketchOverlay();
      renderer.render(scene, this.camera);
    };
    loop();
  };

  // The view turns again when no tool holds the pointer. Ending a drag on a
  // body list or menu must not leave the orbit locked against the app chrome.
  ModelEngine.prototype._freeNav = function () {
    if (!C().navIdle({ dragging: this.dragging, sketch: !!this._skDrag, face: !!this._faceDrag })) return;
    if (!this.controls) return;
    this.controls.enabled = true;
    if (this.controls.state !== undefined) this.controls.state = -1;
    this._calmNav();
  };
  // Desktop pointer, finger, and Pencil. A finger orbits after a short move.
  // Pencil and the left mouse button select and drive the gizmo. They never orbit.
  ModelEngine.prototype._bindPointer = function () {
    const el = this.viewEl;
    let down = null;
    let finger = null;
    const onDim = (e) => !!(e && e.target && e.target.closest && e.target.closest('.mdl-dim, .mdl-skm'));
    // iPad sends a mouse or touch pointer just after the pencil. That second
    // pointer lands on a different face and steals the selection.
    const notePen = (e) => { if (e.pointerType === 'pen') this._penAt = performance.now(); };
    const penEcho = (e) => e.pointerType !== 'pen' && this._penAt && performance.now() - this._penAt < 800;
    const endFinger = (e) => {
      if (!finger) return false;
      if (e && e.pointerId != null && e.pointerId !== finger.id) return false;
      const moved = finger.moved;
      finger = null;
      this._freeNav();
      return moved;
    };
    this._on(el, 'pointerdown', (e) => {
      notePen(e);
      if (penEcho(e)) return;
      // Dimension chips edit on double-click. A primary press on a chip must not
      // start a sketch or selection, or the second click never lands on the label.
      if (onDim(e) && C().dimPressEdits(e.button, e.pointerType)) {
        if (this._dimEdit || this._skDimEdit) return;
        this._dimArmEdit(e);
        return;
      }
      this.root.focus({ preventScroll: true });
      if (e.button === 1) {
        const mod = e.shiftKey || e.ctrlKey || e.metaKey;
        this.controls.mouseButtons.MIDDLE = mod ? this.T.MOUSE.ROTATE : this.T.MOUSE.PAN;
      }
      if (e.pointerType === 'touch' && !e.isPrimary) { finger = null; this._freeNav(); return; }
      // Sketch owns the main pointer: mouse, Pencil, and one finger. A second finger still pans.
      if (this.sk && (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen')) {
        this._sketchDown(e);
        return;
      }
      if (this.faceOn && e.pointerType !== 'touch' && (e.button === 0 || e.pointerType === 'pen')) {
        this._facePress = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
        return;
      }
      if (this.mode === 'edge' && e.pointerType !== 'touch' && (e.button === 0 || e.pointerType === 'pen')) {
        this._edgePress = { id: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      if (e.pointerType === 'touch') {
        finger = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
      }
      down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, shift: e.shiftKey || e.metaKey || e.ctrlKey };
    }, true);
    this._on(el, 'pointermove', (e) => {
      notePen(e);
      if (penEcho(e)) return;
      if (this._skDrag && e.pointerId === this._skDrag.id) { this._sketchMove(e); return; }
      if (this._faceDrag && e.pointerId === this._faceDrag.id) { this._faceMove(e); return; }
      if (this._facePress && e.pointerId === this._facePress.id) {
        if (Math.hypot(e.clientX - this._facePress.x, e.clientY - this._facePress.y) > 6) {
          this._facePress.dragged = true;
          this._beginFaceDrag(this._facePress);
          if (this._faceDrag) this._faceMove(e);
        }
        return;
      }
      if (finger && e.pointerId === finger.id && down) {
        if (this.dragging) { finger.moved = true; return; }
        const dx = e.clientX - finger.x, dy = e.clientY - finger.y;
        if (!finger.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return;
        if (!finger.moved) {
          try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
        }
        finger.moved = true;
        finger.x = e.clientX;
        finger.y = e.clientY;
        this.controls.enabled = false;
        this._orbit(dx, dy);
        return;
      }
      if (e.buttons !== 0 || e.pointerType === 'touch') return;
      if (this.sk) { this._sketchHover(e); return; }
      this._hover(this._pick(e));
    }, true);
    this._on(el, 'pointerup', (e) => {
      notePen(e);
      if (penEcho(e)) return;
      const movedFinger = !!(finger && finger.id === e.pointerId && finger.moved);
      endFinger(e);
      if (this._skDrag && e.pointerId === this._skDrag.id) { this._sketchUp(e); down = null; return; }
      if (this._faceDrag && e.pointerId === this._faceDrag.id) { this._faceUp(e); this._facePress = null; down = null; return; }
      if (this._facePress && e.pointerId === this._facePress.id) {
        const press = this._facePress;
        this._facePress = null;
        down = null;
        if (!press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 6) this._faceTap(e);
        return;
      }
      if (this._edgePress && e.pointerId === this._edgePress.id) {
        const press = this._edgePress;
        this._edgePress = null;
        down = null;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 6) this._edgeTap(e);
        return;
      }
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = Date.now() - down.t < 500;
      const shift = down.shift;
      down = null;
      if (movedFinger || moved > 6 || !quick || this.dragging) return;
      if (e.button > 0) return;
      if (this.tc && this.tc.axis) return;
      if (this.sk) { this._sketchClick(e); return; }
      if (this.faceOn) {
        if (e.pointerType === 'touch') {
          this._setMode('object', true);
          this._select(this._pick(e), false);
        }
        return;
      }
      if (this.mode === 'edge') {
        if (e.pointerType === 'touch') {
          this._setMode('object', true);
          this._select(this._pick(e), false);
        }
        return;
      }
      this._select(this._pick(e), shift);
    });
    this._on(el, 'pointercancel', (e) => {
      endFinger(e);
      down = null;
      if (this._skDrag && (!e || e.pointerId === this._skDrag.id)) this._sketchUp(e);
      if (this._faceDrag && (!e || e.pointerId === this._faceDrag.id)) this._faceUp(e);
      this._facePress = null;
      this._edgePress = null;
      this._freeNav();
    });
    // A drag that ends on the body list or another app chrome still frees the view.
    this._on(window, 'pointerup', (e) => { endFinger(e); this._freeNav(); }, true);
    this._on(window, 'pointercancel', (e) => { endFinger(e); this._freeNav(); }, true);
    this._on(window, 'blur', () => { finger = null; down = null; this._facePress = null; this._edgePress = null; this._freeNav(); });
    this._on(el, 'pointerleave', () => this._hover(null));
    this._on(el, 'contextmenu', (e) => e.preventDefault());
  };

  ModelEngine.prototype._overMenu = function (e) {
    const t = e && e.target;
    return !!(t && t.closest && t.closest('.mdl-rail, .mdl-side, .mdl-skbar, .mdl-exportmenu, .mdl-pill, .mdl-toast, input, textarea, select'));
  };
  ModelEngine.prototype._bindWheel = function () {
    const wheel = (e) => this._viewWheel(e);
    this._on(this.viewEl, 'wheel', wheel, { passive: false });
    this._on(this.root.querySelector('[data-cube]'), 'wheel', wheel, { passive: false });
    // A pinch or ⌘-scroll zooms the view. It must not zoom the page, or the
    // menus and the rest of the app slide off and only a corner of the grid remains.
    this._on(this.root, 'wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cube = this.root.querySelector('[data-cube]');
      if ((this.viewEl && this.viewEl.contains(e.target)) || (cube && cube.contains(e.target)) || this._overMenu(e)) return;
      this._zoom(Math.exp(e.deltaY * 0.012), e);
    }, { passive: false, capture: true });
    let gesture = 1;
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
      this._on(this.root, type, (e) => {
        e.preventDefault();
        if ((this.viewEl && this.viewEl.contains(e.target)) || this._overMenu(e)) return;
        if (type === 'gesturestart') gesture = 1;
        else if (type === 'gesturechange') {
          const scale = e.scale || 1;
          this._zoom(gesture / scale, e);
          gesture = scale;
        }
      }, { passive: false, capture: true });
    });
  };
  ModelEngine.prototype._viewWheel = function (e) {
    e.preventDefault();
    const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || Math.abs(e.deltaY) < 40) && !e.ctrlKey;
    if (e.ctrlKey) this._zoom(Math.exp(e.deltaY * 0.012), e);
    else if (trackpad && e.shiftKey) this._pan(-e.deltaX, -e.deltaY);
    else if (trackpad) this._orbit(e.deltaX, e.deltaY);
    else this._zoom(Math.exp(e.deltaY * 0.0015), e);
  };
  ModelEngine.prototype._pinch = function (e) {
    if (e.cancelable) e.preventDefault();
    if (e.touches.length !== 2) { this._pinchD = 0; return; }
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (this._pinchD) {
      const mid = { clientX: (e.touches[0].clientX + e.touches[1].clientX) / 2, clientY: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      this._zoom(clamp(this._pinchD / d, 0.85, 1.18), mid);
    }
    this._pinchD = d;
  };
  ModelEngine.prototype._calmNav = function () {
    const c = this.controls;
    if (!c) return;
    if (c._sphericalDelta) c._sphericalDelta.set(0, 0, 0);
    if (c._panOffset) c._panOffset.set(0, 0, 0);
    c._scale = 1;
  };
  ModelEngine.prototype._orbit = function (dx, dy, scale) {
    if (this.isOrtho) { this._setOrtho(false); this._markView(null); }
    const s = scale || 1;
    const off = this.camera.position.clone().sub(this.target);
    const r = off.length() || 1;
    let th = Math.atan2(off.y, off.x);
    let ph = Math.acos(clamp(off.z / r, -1, 1));
    th -= dx * 0.006 * s;
    ph -= dy * 0.006 * s;
    ph = clamp(ph, 0.02, Math.PI - 0.02);
    off.set(r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph));
    this.camera.position.copy(this.target).add(off);
    this.camera.lookAt(this.target);
    this._calmNav();
    this._markView(null);
  };
  ModelEngine.prototype._pan = function (dx, dy) {
    const T = this.T;
    const dist = this.camera.position.distanceTo(this.target);
    const k = dist * Math.tan((this.persp.fov * DEG) / 2) * 2 / (this.viewEl.clientHeight || 1);
    this.camera.updateMatrixWorld();
    const right = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(-dx * k);
    const up = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).multiplyScalar(dy * k);
    this.camera.position.add(right).add(up);
    this.target.add(right).add(up);
    this._calmNav();
  };
  ModelEngine.prototype._zoom = function (f, e) {
    f = clamp(f, 0.5, 2);
    const dir = this.camera.position.clone().sub(this.target);
    const len0 = Math.max(dir.length(), 0.001);
    const len = clamp(len0 * f, 8, 8000);
    const applied = len / len0;
    if (e && e.clientX != null && Math.abs(applied - 1) > 1e-4) {
      const hit = this._zoomAnchor(e);
      if (hit) this.target.addScaledVector(hit.clone().sub(this.target), 1 - applied);
    }
    dir.setLength(len);
    this.camera.position.copy(this.target).add(dir);
    this.camera.lookAt(this.target);
    this._calmNav();
  };
  ModelEngine.prototype._zoomAnchor = function (e) {
    const hit = this._pickPoint(e);
    if (hit) return hit;
    const n = this.camera.getWorldDirection(new this.T.Vector3());
    const plane = new this.T.Plane().setFromNormalAndCoplanarPoint(n, this.target);
    return this._ray(e).ray.intersectPlane(plane, new this.T.Vector3());
  };
  ModelEngine.prototype._ray = function (e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new this.T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new this.T.Raycaster();
    rc.setFromCamera(v, this.camera);
    return rc;
  };
  ModelEngine.prototype._bodyMeshes = function () {
    return Object.values(this.objs).filter((o) => o.group.visible).map((o) => o.mesh);
  };
  ModelEngine.prototype._pick = function (e) {
    const hits = this._ray(e).intersectObjects(this._bodyMeshes(), false);
    return hits.length ? hits[0].object.userData.id : null;
  };
  ModelEngine.prototype._pickPoint = function (e) {
    const hits = this._ray(e).intersectObjects(this._bodyMeshes(), false);
    return hits.length ? hits[0].point : null;
  };
  ModelEngine.prototype._hover = function (id) {
    if (id) {
      this._dimShown = id;
      if (this._dimTimer) { clearTimeout(this._dimTimer); this._dimTimer = null; }
    } else this._armDimHide();
    if (id === this.hov) return;
    this.hov = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this._paint();
  };
  ModelEngine.prototype._armDimHide = function () {
    if (this._dimEdit || this._dimHold) return;
    if (this._dimTimer) clearTimeout(this._dimTimer);
    this._dimTimer = setTimeout(() => {
      this._dimTimer = null;
      if (!this.hov && !this._dimHold && !this._dimEdit) this._dimShown = null;
    }, 800);
  };

  ModelEngine.prototype._orthoFrustum = function () {
    const c = this.ortho;
    const dist = Math.max(c.position.distanceTo(this.target), 8);
    const hh = dist * Math.tan((this.persp.fov * DEG) / 2);
    const hw = hh * (this.persp.aspect || 1);
    c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh;
    c.updateProjectionMatrix();
  };
  ModelEngine.prototype._setOrtho = function (on) {
    if (!!on === !!this.isOrtho) return;
    const from = this.camera, to = on ? this.ortho : this.persp;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    this.camera = to;
    this.isOrtho = !!on;
    this.controls.object = to;
    this.tc.camera = to;
    if (on) this._orthoFrustum();
    to.lookAt(this.target);
  };
  ModelEngine.prototype._markView = function (v) {
    const names = { iso: 'Perspective', top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right' };
    const pill = this.root.querySelector('[data-viewname]');
    if (pill) pill.textContent = names[v] || 'Perspective';
    const face = { right: 'right', left: 'left', back: 'back', front: 'front', top: 'top', bottom: 'bottom' }[v] || null;
    this.root.querySelectorAll('[data-cubeview]').forEach((b) => b.classList.toggle('on', b.dataset.cubeview === face));
  };
  ModelEngine.prototype._fit = function () {
    const T = this.T;
    const box = new T.Box3();
    Object.values(this.objs).forEach((o) => box.expandByObject(o.group));
    if (box.isEmpty()) box.set(new T.Vector3(-40, -40, 0), new T.Vector3(40, 40, 40));
    const c = box.getCenter(new T.Vector3());
    const size = box.getSize(new T.Vector3()).length() || 40;
    const dir = this.camera.position.clone().sub(this.target);
    if (dir.length() < 1) dir.set(0.75, -1, 0.75);
    dir.normalize();
    const dist = (size / 2) / Math.tan((this.persp.fov * DEG) / 2) * 1.7;
    this.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(Math.max(dist, 40)));
    this.camera.lookAt(c);
    this._calmNav();
    if (this.isOrtho) this._orthoFrustum();
  };
  ModelEngine.prototype._view = function (v) {
    const e = 0.007;
    const dirs = { iso: [0.75, -1, 0.75], top: [0, -e, 1], bottom: [0, -e, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
    this._look(new this.T.Vector3(...(dirs[v] || dirs.iso)), v !== 'iso');
    this._markView(v);
  };
  ModelEngine.prototype._look = function (dir, ortho) {
    this._setOrtho(!!ortho);
    const d = dir.clone().normalize();
    if (Math.abs(d.z) > 0.999) d.set(d.x, d.y - 1e-4, d.z).normalize();
    const dist = Math.max(this.camera.position.distanceTo(this.target) || 200, 40);
    this.camera.position.copy(this.target).add(d.multiplyScalar(dist));
    this.camera.lookAt(this.target);
    this._calmNav();
    this._fit();
  };
  ModelEngine.prototype._cubeSync = function () {
    const spin = this._cubeSpin;
    if (!spin || !this.camera) return;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    spin.style.transform = `matrix3d(${e[0]},${-e[4]},${e[8]},0,${e[1]},${-e[5]},${e[9]},0,${e[2]},${-e[6]},${e[10]},0,0,0,0,1)`;
  };
  ModelEngine.prototype._bindCube = function (cube) {
    let drag = null;
    this._on(cube, 'pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      this._cubeDragMoved = false;
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      try { cube.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    });
    this._on(cube, 'pointermove', (e) => {
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        drag.x = e.clientX;
        drag.y = e.clientY;
        this._orbit(dx, dy, 2.4);
        return;
      }
      if (e.buttons !== 0) return;
      const hot = this._cubeFaceAt(e);
      cube.querySelectorAll('[data-cubeview]').forEach((b) => b.classList.toggle('hot', b.dataset.cubeview === hot));
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return;
      if (drag.moved) this._cubeDragMoved = true;
      drag = null;
    };
    this._on(cube, 'pointerup', end);
    this._on(cube, 'pointercancel', end);
    this._on(cube, 'click', (e) => {
      if (this._cubeDragMoved) { this._cubeDragMoved = false; e.preventDefault(); return; }
      this._cubeActivate(e);
    });
    this._on(cube, 'contextmenu', (e) => e.preventDefault());
  };
  ModelEngine.prototype._cubeFacePoint = function (name) {
    const n = { right: [1, 0, 0], left: [-1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0] }[name];
    if (!n) return null;
    const normal = new this.T.Vector3(...n);
    const toCam = this.camera.position.clone().sub(this.target);
    if (normal.dot(toCam) <= 0.12 * toCam.length()) return null;
    this.camera.updateMatrixWorld();
    const right = new this.T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new this.T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    return { name, x: normal.dot(right) * 30, y: -normal.dot(up) * 30, normal };
  };
  ModelEngine.prototype._cubeCentre = function () {
    const r = this._cubeSpin.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  ModelEngine.prototype._cubeFaceAt = function (e) {
    const c = this._cubeCentre();
    let best = null, bestD = 1e9;
    for (const name of ['right', 'left', 'top', 'bottom', 'front', 'back']) {
      const p = this._cubeFacePoint(name);
      if (!p) continue;
      const d = Math.hypot(e.clientX - (c.x + p.x), e.clientY - (c.y + p.y));
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  };
  ModelEngine.prototype._cubeActivate = function (e) {
    const c = this._cubeCentre();
    const faces = ['right', 'left', 'top', 'bottom', 'front', 'back'].map((n) => this._cubeFacePoint(n)).filter(Boolean);
    if (!faces.length) return;
    let best = faces[0], bestD = 1e9;
    for (const p of faces) {
      const d = Math.hypot(e.clientX - (c.x + p.x), e.clientY - (c.y + p.y));
      if (d < bestD) { bestD = d; best = p; }
    }
    if (bestD < 22) { this._view(best.name); return; }
    const dir = new this.T.Vector3();
    faces.forEach((p) => dir.add(p.normal));
    dir.add(best.normal);
    this._look(dir, false);
    this._markView(null);
  };

  ModelEngine.prototype._resize = function () {
    if (!this.renderer || !this.viewEl) return;
    const w = this.viewEl.clientWidth || 1;
    const h = this.viewEl.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    if (this.isOrtho) this._orthoFrustum();
  };
  ModelEngine.prototype._css = function (name, fb) {
    return getComputedStyle(this.root).getPropertyValue(name).trim() || fb;
  };
  ModelEngine.prototype._applyTheme = function () {
    const T = this.T;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.dark = dark;
    this.colors = {
      body: new T.Color(this._css('--mdl-body', '#d7dbe3')),
      edge: new T.Color(this._css('--mdl-edge', '#3e4654')),
      sel: new T.Color(this._css('--mdl-sel', '#1a56c4')),
      selBody: new T.Color(this._css('--mdl-sel-body', '#d5e4fb')),
    };
    this.renderer.setClearColor(dark ? 0x17191d : 0xe7e9ee, 1);
    if (this.grid) this.scene.remove(this.grid);
    this.grid = new T.GridHelper(800, 80, dark ? 0x4a5160 : 0xc5cad3, dark ? 0x2c313a : 0xdde1e8);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.2;
    this.scene.add(this.grid);
    this._paint();
  };
  ModelEngine.prototype._setXray = function (on) {
    this._xray = !!on;
    const btn = this.root.querySelector('[data-xray]');
    if (btn) btn.classList.toggle('on', this._xray);
    this._paint();
    this._toast(this._xray ? 'X-ray on. Internal faces and slots show through.' : 'X-ray off.');
  };
  ModelEngine.prototype._paint = function () {
    if (!this.colors) return;
    const xray = !!this._xray;
    for (const [id, o] of Object.entries(this.objs)) {
      const obj = this._obj(id);
      const show = !obj || !obj.hidden;
      o.group.visible = show;
      (o.picks || []).forEach((m) => { m.visible = show; });
      if (!o.mesh || !o.mesh.material || !o.edges || !o.edges.material) continue;
      if (o.group.scale) {
        const flipped = o.group.scale.x < 0 || o.group.scale.y < 0 || o.group.scale.z < 0;
        o.mesh.material.side = (xray || flipped) ? this.T.DoubleSide : this.T.FrontSide;
      } else {
        o.mesh.material.side = xray ? this.T.DoubleSide : this.T.FrontSide;
      }
      const on = this.multi.indexOf(id) >= 0 && !this.faceOn;
      const hot = id === this.hov && !on && !this.faceOn;
      o.mesh.material.color.copy(on ? this.colors.selBody : this.colors.body);
      o.mesh.material.transparent = xray;
      o.mesh.material.opacity = xray ? (on ? 0.42 : 0.28) : 1;
      o.mesh.material.depthWrite = !xray;
      o.mesh.material.needsUpdate = true;
      o.edges.material.color.copy(on || hot ? this.colors.sel : this.colors.edge);
      o.edges.material.opacity = xray ? (on ? 1 : hot ? 0.9 : 0.72) : (on ? 0.95 : hot ? 0.7 : 0.38);
      o.edges.material.depthTest = !xray;
      o.edges.renderOrder = xray ? 3 : 0;
    }
  };

  ModelEngine.prototype._initWorker = function () {
    this.worker = new Worker(VENDOR + 'model-worker.js?v=' + encodeURIComponent(this.version) + '-28', { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data || {});
    this.worker.onerror = (e) => {
      this.building = false;
      this.pendingBuild = false;
      this._clearBusy();
      this._toast('3D engine failed' + (e.message ? ': ' + e.message : ''));
    };
  };
  ModelEngine.prototype._shapeSig = function (o) {
    return JSON.stringify({
      k: o.kernel, t: o.type, s: o.size, pr: o.profiles, h: o.height, f: o.features, parts: o.parts,
      cut: o.type === 'cut' ? (o.cut === 'split' ? 'split' : 'delete') : undefined,
      mesh: (o.kernel === 'mesh' || o.type === 'mesh') ? o.mesh : undefined,
    });
  };
  ModelEngine.prototype._clearBusy = function () {
    clearTimeout(this._slowT);
    this._setBusy(false);
  };
  ModelEngine.prototype._requestBuild = function () {
    if (!this.worker) return;
    clearTimeout(this._buildT);
    this._buildT = setTimeout(() => this._build(), 16);
  };
  ModelEngine.prototype._build = function () {
    if (this.building) { this.pendingBuild = true; return; }
    this.building = true;
    this.pendingBuild = false;
    const id = ++this.buildSeq;
    this._sentId = id;
    const visible = this.data.objects.filter((o) => !o.hidden);
    const sigs = {};
    const objects = [];
    for (const o of visible) {
      const sig = this._shapeSig(o);
      sigs[o.id] = sig;
      if (this._shapeSigs[o.id] === sig && this.objs[o.id]) continue;
      objects.push({
        id: o.id, kernel: o.kernel, type: o.type, size: o.size, pos: o.pos, rot: o.rot, scale: o.scale,
        profiles: o.profiles, height: o.height, features: o.features, parts: o.parts, mesh: o.mesh,
        brep: o.brep, brepHash: o.brepHash, cut: o.cut,
      });
    }
    this._pendingSigs = sigs;
    if (!objects.length) {
      this.building = false;
      if (this.pendingBuild) this._build();
      else this._clearBusy();
      return;
    }
    clearTimeout(this._slowT);
    if (!Object.keys(this.objs).length) this._setBusy('load');
    else if (!this._warming) this._slowT = setTimeout(() => { if (this.building) this._setBusy('update'); }, 400);
    try {
      this.worker.postMessage({ type: 'build', id, objects, alive: visible.map((o) => o.id) });
    } catch (e) {
      this.building = false;
      this._clearBusy();
      this._toast('Could not update the model. ' + (e && e.message ? e.message : e));
    }
  };
  ModelEngine.prototype._onWorker = function (m) {
    if (m.type === 'ready') return;
    if (m.type === 'init-error') { this.building = false; this._clearBusy(); this._toast('3D engine failed: ' + m.message); return; }
    if (m.type !== 'result') return;
    const current = m.id === this._sentId;
    if (!current) {
      if (this.pendingBuild && !this.building) this._build();
      return;
    }
    this.building = false;
    try {
      if (m.error) this._toast(m.error);
      const notes = (m.bodies || []).filter((b) => b.error).map((b) => b.error);
      if (notes.length) this._toast(notes[0]);
      for (const b of m.bodies || []) {
        const missed = b && b.notes && b.notes.find((t) => t === 'That sketch does not split the face.' || t === 'That curve was not extruded, because a polyline would leave a gap.' || t === 'That edge could not be changed.' || t === 'Those bodies do not overlap.' || t === 'That body does not split the other.');
        if (missed) { this._toast(missed); break; }
      }
      let remember = false;
      const splitShown = [];
      for (const b of m.bodies || []) {
        if (this._revertCut(b)) continue;
        const extra = this._adoptSplit(b);
        if (extra) { splitShown.push(...extra); continue; }
        this._finishCut(b);
      }
      for (const b of m.bodies || []) {
        if (!b || !b.vertices || !this._obj(b.id)) continue;
        if (this._pendingSigs && this._pendingSigs[b.id]) this._shapeSigs[b.id] = this._pendingSigs[b.id];
        remember = this._remember(b) || remember;
      }
      this._showBodies((m.bodies || []).concat(splitShown));
      if (remember && this.opts.onChange) this.opts.onChange();
    } catch (e) {
      this._toast('Could not update the model. ' + (e && e.message ? e.message : e));
    }
    this._warming = false;
    if (this.pendingBuild) this._build();
    else this._clearBusy();
  };
  ModelEngine.prototype._finishCut = function (b) {
    if (!b || !b.vertices) return;
    const obj = this._obj(b.id);
    if (!obj || obj.type !== 'cut' || !obj.parts || !obj.parts[1]) return;
    const missed = (b.notes || []).some((t) => t === 'Those bodies do not overlap.' || t === 'That body does not split the other.');
    if (missed) return;
    const tool = this._obj(obj.parts[1].id);
    if (!tool || tool.hidden || tool.id === obj.id) return;
    tool.hidden = true;
    this.multi = this.multi.filter((id) => id !== tool.id);
    if (this.sel === tool.id) this.sel = obj.id;
    this.root.dataset.sel = this.sel || '';
    this._renderList();
    this._syncCutBar();
    this._syncGizmo();
  };
  ModelEngine.prototype._remember = function (b) {
    const obj = this._obj(b.id);
    if (!obj) return false;
    const nextSurface = b.faces && b.faces.some((f) => f.surface && f.surface.vertices && f.surface.vertices.length >= 9);
    const storedSurface = obj.view && obj.view.faces && obj.view.faces.some((f) => f.surface && f.surface.vertices && f.surface.vertices.length >= 9);
    if (!b.brep && obj.view && obj.view.edges && obj.view.edges.length >= 6 && obj.view.vertices && obj.view.vertices.length > 8 && (!nextSurface || storedSurface)) return false;
    let changed = false;
    const keepBase = obj.type === 'solid' && (obj.features || []).length;
    if (!keepBase && b.brep && b.brepHash && (obj.brep !== b.brep || obj.brepHash !== b.brepHash)) {
      obj.brep = b.brep;
      obj.brepHash = b.brepHash;
      changed = true;
    }
    const verts = b.vertices;
    const tris = b.triangles;
    const prev = obj.view;
    const hasLines = b.edges && b.edges.length >= 6;
    const faceEdges = (faces) => {
      let n = 0;
      for (const f of faces || []) {
        for (const w of f.exact || []) n += (w.edges || []).length;
        n += (f.measures || []).length;
      }
      return n;
    };
    const same = prev && prev.vertices && prev.vertices.length === verts.length && prev.triangles && prev.triangles.length === tris.length
      && prev.vertices[0] === verts[0] && prev.vertices[verts.length - 1] === verts[verts.length - 1]
      && (!hasLines || (prev.edges && prev.edges.length === b.edges.length))
      && (!nextSurface || storedSurface)
      && faceEdges(prev.faces) === faceEdges(b.faces);
    if (!same) {
      obj.view = {
        vertices: Array.from(verts), triangles: Array.from(tris), faces: b.faces || [],
        ...(hasLines ? { edges: Array.from(b.edges) } : {}),
        ...(b.normals && b.normals.length === verts.length ? { normals: Array.from(b.normals) } : {}),
      };
      changed = true;
    }
    return changed;
  };
  ModelEngine.prototype._geom = function (b) {
    const T = this.T;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(b.vertices, 3));
    g.setIndex(new T.BufferAttribute(b.triangles, 1));
    if (b.normals && b.normals.length === b.vertices.length) g.setAttribute('normal', new T.BufferAttribute(b.normals, 3));
    else g.computeVertexNormals();
    return g;
  };
  ModelEngine.prototype._edgeGeom = function (b, g) {
    const T = this.T;
    if (b.edges && b.edges.length >= 6) {
      const eg = new T.BufferGeometry();
      eg.setAttribute('position', new T.BufferAttribute(b.edges, 3));
      return eg;
    }
    return new T.EdgesGeometry(g, 25);
  };
  ModelEngine.prototype._bodyCenter = function (slot) {
    const g = slot && slot.mesh && slot.mesh.geometry;
    if (!g) return new this.T.Vector3();
    if (!g.boundingBox) g.computeBoundingBox();
    const box = g.boundingBox;
    if (!box || box.isEmpty()) return new this.T.Vector3();
    return box.getCenter(new this.T.Vector3());
  };
  ModelEngine.prototype._ensureLocal = function (slot) {
    if (!slot.local) {
      slot.local = new this.T.Group();
      slot.group.add(slot.local);
    }
    const move = (obj) => { if (obj && obj.parent === slot.group) slot.local.add(obj); };
    move(slot.mesh);
    move(slot.edges);
    (slot.picks || []).forEach(move);
    (this._faceMarks || []).forEach((m) => { if (m.parent === slot.group) slot.local.add(m); });
    if (this._facePrev && this._facePrev.parent === slot.group) slot.local.add(this._facePrev);
  };
  // Shape-local center, scaled and rotated. The group sits on the world center,
  // so a turn keeps that center still and the stored origin follows it.
  ModelEngine.prototype._spinOf = function (obj, center) {
    const T = this.T;
    const s = obj.scale || [1, 1, 1];
    const e = new T.Euler((obj.rot[0] || 0) * DEG, (obj.rot[1] || 0) * DEG, (obj.rot[2] || 0) * DEG, 'ZYX');
    return new T.Vector3(center.x * (s[0] || 1), center.y * (s[1] || 1), center.z * (s[2] || 1)).applyQuaternion(new T.Quaternion().setFromEuler(e));
  };
  ModelEngine.prototype._worldCenter = function (slot, obj) {
    const spun = this._spinOf(obj, this._bodyCenter(slot));
    return new this.T.Vector3((obj.pos[0] || 0) + spun.x, (obj.pos[1] || 0) + spun.y, (obj.pos[2] || 0) + spun.z);
  };
  ModelEngine.prototype._applySpin = function (slot, obj, next) {
    const center = next && next.center ? next.center.clone() : this._worldCenter(slot, obj);
    if (next && next.rot) obj.rot = next.rot;
    if (next && next.scale) obj.scale = next.scale;
    const spun = this._spinOf(obj, this._bodyCenter(slot));
    obj.pos = [r3(center.x - spun.x), r3(center.y - spun.y), r3(center.z - spun.z)];
    this._place(slot, obj);
  };
  ModelEngine.prototype._shapeMatrix = function (slot) {
    const node = (slot && slot.local) || slot.group;
    slot.group.updateMatrixWorld(true);
    return node.matrixWorld;
  };
  ModelEngine.prototype._place = function (slot, obj) {
    if (!slot || !slot.group || !obj) return;
    this._ensureLocal(slot);
    const C = this._bodyCenter(slot);
    const spun = this._spinOf(obj, C);
    const p = obj.pos || [0, 0, 0];
    slot.group.position.set(p[0] + spun.x, p[1] + spun.y, p[2] + spun.z);
    slot.group.rotation.order = 'ZYX';
    slot.group.rotation.set((obj.rot[0] || 0) * DEG, (obj.rot[1] || 0) * DEG, (obj.rot[2] || 0) * DEG);
    const s = obj.scale || [1, 1, 1];
    slot.group.scale.set(s[0] || 1, s[1] || 1, s[2] || 1);
    slot.local.position.set(-C.x, -C.y, -C.z);
    slot.local.rotation.set(0, 0, 0);
    slot.local.scale.set(1, 1, 1);
  };
  ModelEngine.prototype._showBodies = function (bodies, opts) {
    const T = this.T;
    const seen = new Set();
    for (const b of bodies) {
      if (!b.vertices || !b.vertices.length) continue;
      const obj = this._obj(b.id);
      if (!obj) continue;
      seen.add(b.id);
      const g = this._geom(b);
      let slot = this.objs[b.id];
      if (!slot) {
        const mesh = new T.Mesh(g, new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.04 }));
        mesh.userData.id = b.id;
        const edges = new T.LineSegments(this._edgeGeom(b, g), new T.LineBasicMaterial({ transparent: true }));
        const group = new T.Group();
        const local = new T.Group();
        local.add(mesh, edges);
        group.add(local);
        slot = { group, local, mesh, edges, picks: [] };
        this.objs[b.id] = slot;
        this.itemsGroup.add(group);
      } else {
        slot.mesh.geometry.dispose();
        slot.edges.geometry.dispose();
        slot.mesh.geometry = g;
        slot.edges.geometry = this._edgeGeom(b, g);
      }
      this._place(slot, obj);
      slot.group.visible = !obj.hidden;
      this._setFaces(slot, b);
    }
    const live = new Set(this.data.objects.map((o) => o.id));
    for (const id of Object.keys(this.objs)) {
      if (seen.has(id) || live.has(id)) continue;
      this._dropSlot(id);
    }
    this._paint();
    this._syncGizmo();
    if (!this._fitted && seen.size && !(opts && opts.fit === false)) { this._fitted = true; this._fit(); this._view('iso'); }
    this.root.dataset.built = (seen.size || Object.keys(this.objs).length) ? '1' : '0';
  };
  ModelEngine.prototype._inView = function (lift) {
    if (!this.target) return [0, 0, 0];
    return [r3(this.target.x), r3(this.target.y), r3(Math.max(0, this.target.z - (lift || 0)))];
  };
  ModelEngine.prototype._preview = function (obj) {
    if (!this.T || !this.itemsGroup || this.objs[obj.id]) return;
    const T = this.T;
    const geom = this._previewGeom(obj);
    if (!geom) return;
    const mesh = new T.Mesh(geom, new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.04 }));
    mesh.userData.id = obj.id;
    const edges = new T.LineSegments(new T.EdgesGeometry(geom, 25), new T.LineBasicMaterial({ transparent: true }));
    const group = new T.Group();
    const local = new T.Group();
    local.add(mesh, edges);
    group.add(local);
    const slot = { group, local, mesh, edges, picks: [] };
    this.objs[obj.id] = slot;
    this.itemsGroup.add(group);
    this._place(slot, obj);
    this._paint();
    this._syncGizmo();
    if (this.building) this._setBusy('update');
  };
  ModelEngine.prototype._previewGeom = function (obj) {
    const T = this.T;
    if (obj.type === 'box' && obj.size) {
      const g = new T.BoxGeometry(obj.size.x, obj.size.y, obj.size.z);
      g.translate(0, 0, obj.size.z / 2);
      return g;
    }
    if (obj.type === 'cylinder' && obj.size) {
      const g = new T.CylinderGeometry(obj.size.d / 2, obj.size.d / 2, obj.size.z, 48);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, obj.size.z / 2);
      return g;
    }
    if (obj.type === 'sphere' && obj.size) {
      const r = obj.size.d / 2;
      const g = new T.SphereGeometry(r, 32, 24);
      g.translate(0, 0, r);
      return g;
    }
    if (obj.type === 'sketch') return this._sketchPreviewGeom(obj);
    return null;
  };
  ModelEngine.prototype._circum = function (a, m, b) {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a[0] * a[0] + a[1] * a[1], m2 = m[0] * m[0] + m[1] * m[1], b2 = b[0] * b[0] + b[1] * b[1];
    const ux = (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d;
    const uy = (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d;
    return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
  };
  ModelEngine.prototype._arcPoints = function (a, mid, b) {
    const c = this._circum(a, mid, b);
    if (!c || c.r < 1e-6) return [a, mid, b];
    const ang = (p) => Math.atan2(p[1] - c.c[1], p[0] - c.c[0]);
    const turn = (from, to) => {
      let d = to - from;
      while (d < 0) d += Math.PI * 2;
      while (d >= Math.PI * 2) d -= Math.PI * 2;
      return d;
    };
    const a0 = ang(a), total = turn(a0, ang(mid)) + turn(ang(mid), ang(b));
    const n = Math.max(8, Math.ceil(total / (Math.PI / 24)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const th = a0 + total * i / n;
      pts.push([c.c[0] + Math.cos(th) * c.r, c.c[1] + Math.sin(th) * c.r]);
    }
    return pts;
  };
  ModelEngine.prototype._exactChains = function (edges) {
    const chains = [];
    for (const e of edges) {
      if (e.k === 'circle') {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const a = i / 48 * Math.PI * 2;
          pts.push([e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]);
        }
        chains.push(pts);
      } else if (e.k === 'arc') chains.push(this._arcPoints(e.a, e.mid, e.b));
      else if (e.k === 'line') chains.push([e.a, e.b]);
    }
    return chains;
  };
  ModelEngine.prototype._exactPreview = function (profile, depth, z0) {
    const T = this.T;
    const wires = profile.wires || [];
    const outer = wires[0] && wires[0].edges;
    if (!outer || !outer.length || !T.Shape || !T.ExtrudeGeometry) return null;
    const write = (path, edges) => {
      if (edges.length === 1 && edges[0].k === 'circle') {
        const e = edges[0];
        path.absarc(e.c[0], e.c[1], Math.max(0.05, e.r), 0, Math.PI * 2, false);
        return;
      }
      path.moveTo(edges[0].a[0], edges[0].a[1]);
      for (const e of edges) {
        if (e.k === 'arc') {
          const pts = this._arcPoints(e.a, e.mid, e.b);
          for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        } else path.lineTo(e.b[0], e.b[1]);
      }
    };
    try {
      const shape = new T.Shape();
      write(shape, outer);
      for (let i = 1; i < wires.length; i++) {
        if (!wires[i].edges || !wires[i].edges.length || !T.Path) continue;
        const hole = new T.Path();
        write(hole, wires[i].edges);
        shape.holes.push(hole);
      }
      const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
      g.translate(0, 0, z0);
      return g;
    } catch (e) { return null; }
  };
  ModelEngine.prototype._sketchPreviewGeom = function (obj) {
    const T = this.T;
    const h = obj.height || 1;
    const depth = Math.max(Math.abs(h), 0.001);
    const z0 = h >= 0 ? 0 : h;
    const geos = [];
    for (const p of obj.profiles || []) {
      if (p.k === 'rect') {
        const g = new T.BoxGeometry(p.w, p.h, depth);
        g.translate(p.x, p.y, z0 + depth / 2);
        geos.push(g);
      } else if (p.k === 'circle') {
        const g = new T.CylinderGeometry(p.r, p.r, depth, 40);
        g.rotateX(Math.PI / 2);
        g.translate(p.x, p.y, z0 + depth / 2);
        geos.push(g);
      } else if (p.k === 'exact') {
        const g = this._exactPreview(p, depth, z0);
        if (g) geos.push(g);
      }
    }
    if (!geos.length) return null;
    if (geos.length === 1) return geos[0];
    let count = 0;
    const parts = geos.map((g) => { const n = g.index ? g.toNonIndexed() : g; count += n.getAttribute('position').count; return n; });
    const pos = new Float32Array(count * 3);
    const idx = [];
    let at = 0;
    for (const g of parts) {
      const a = g.getAttribute('position').array;
      pos.set(a, at * 3);
      const n = a.length / 3;
      for (let i = 0; i < n; i++) idx.push(at + i);
      at += n;
      g.dispose();
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setIndex(idx);
    return out;
  };

  ModelEngine.prototype._key = function (e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && key === 'a') {
      e.preventDefault();
      if (window.getSelection) window.getSelection().removeAllRanges();
      if (!this.faceOn && !this.sk) this._selectAll();
      return;
    }
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) this._redo(); else this._undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); this._redo(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this._deleteSel(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (this.sk) this._sketchEscape();
      else if (this.faceOn || this.mode === 'edge') this._setMode('object');
      else this._select(null);
    }
  };
  ModelEngine.prototype._selectAll = function () {
    const ids = (this.data.objects || []).filter((o) => o && !o.hidden).map((o) => o.id);
    if (!ids.length) return;
    this.sel = ids[ids.length - 1];
    this.multi = ids.slice();
    this.root.dataset.sel = this.sel || '';
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._syncCutBar();
    this._paint();
  };
  ModelEngine.prototype._select = function (id, toggle) {
    const ok = id && this._obj(id) ? id : null;
    if ((toggle || this.adding) && ok) {
      const i = this.multi.indexOf(ok);
      if (i >= 0) this.multi.splice(i, 1);
      else this.multi.push(ok);
      this.sel = this.multi[this.multi.length - 1] || null;
    } else if (this.adding && !ok) {
      return;
    } else {
      this.sel = ok;
      this.multi = ok ? [ok] : [];
    }
    this.root.dataset.sel = this.sel || '';
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._syncCutBar();
    this._paint();
  };
  ModelEngine.prototype._syncGizmo = function () {
    if (!this.tc) return;
    const slot = this.sel && this.objs[this.sel];
    if (!slot || this.sk || this.faceOn || this.mode === 'edge' || this.multi.length > 1) { this.tc.detach(); return; }
    if (this.xfMode !== 'rotate' && this.xfMode !== 'scale') this.xfMode = 'translate';
    this.tc.setMode(this.xfMode === 'rotate' ? 'rotate' : this.xfMode === 'scale' ? 'scale' : 'translate');
    this.tc.attach(slot.group);
  };
  ModelEngine.prototype._readGizmo = function () {
    const it = this._obj(this.sel);
    const slot = this.sel && this.objs[this.sel];
    if (!it || !slot) return;
    const g = slot.group;
    const eu = new this.T.Euler().setFromQuaternion(g.quaternion, 'ZYX');
    it.rot = [eu.x, eu.y, eu.z].map((v) => wrapDeg(v / DEG));
    it.scale = [g.scale.x, g.scale.y, g.scale.z].map((v) => r3(Math.abs(v) < 0.05 ? (v < 0 ? -0.05 : 0.05) : v));
    const spun = this._spinOf(it, this._bodyCenter(slot));
    it.pos = [r3(g.position.x - spun.x), r3(g.position.y - spun.y), r3(g.position.z - spun.z)];
    this._syncFields();
  };
  ModelEngine.prototype._syncFields = function () {
    const it = this._obj(this.sel);
    if (!it) return;
    const set = (sel, value) => {
      const el = this.root.querySelector(sel);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    const sc = it.scale || [1, 1, 1];
    const slot = this.objs[it.id];
    const c = slot ? this._worldCenter(slot, it) : { x: it.pos[0], y: it.pos[1], z: it.pos[2] };
    set('[data-pos="x"]', r3(c.x)); set('[data-pos="y"]', r3(c.y)); set('[data-pos="z"]', r3(c.z));
    set('[data-rot="x"]', wrapDeg(it.rot[0])); set('[data-rot="y"]', wrapDeg(it.rot[1])); set('[data-rot="z"]', wrapDeg(it.rot[2]));
    set('[data-scale="x"]', sc[0]); set('[data-scale="y"]', sc[1]); set('[data-scale="z"]', sc[2]);
  };

  ModelEngine.prototype._sizeText = function (o) {
    if (o.type === 'box') return o.size.x + ' × ' + o.size.y + ' × ' + o.size.z;
    if (o.type === 'cylinder') return 'Ø ' + o.size.d + ' × ' + o.size.z;
    if (o.type === 'sphere') return 'Ø ' + o.size.d;
    if (o.type === 'sketch') return 'Extrude ' + o.height;
    if (o.type === 'join') return (o.parts ? o.parts.length : 0) + ' bodies';
    if (o.mesh) return Math.round((o.mesh.triangles.length || 0) / 3) + ' triangles';
    return '';
  };
  ModelEngine.prototype._renderList = function () {
    const list = this.root.querySelector('[data-list]');
    if (!list) return;
    if (!this.data.objects.length) { list.innerHTML = '<p class="mdl-empty">Add a body from the left.</p>'; return; }
    list.innerHTML = this.data.objects.map((o) =>
      '<div class="mdl-item' + (o.hidden ? ' off' : '') + '"><button type="button" class="mdl-row' + (this.multi.indexOf(o.id) >= 0 ? ' on' : '') + '" data-id="' + esc(o.id) + '"><b>' + esc(o.name) + '</b><span>' + esc(this._sizeText(o)) + '</span></button><button type="button" class="mdl-ico' + (o.dims === false ? '' : ' on') + '" data-dims="' + esc(o.id) + '" aria-label="' + (o.dims === false ? 'Show dimensions' : 'Hide dimensions') + '">' + ICON.dim + '</button><button type="button" class="mdl-ico" data-hide="' + esc(o.id) + '" aria-label="' + (o.hidden ? 'Show ' : 'Hide ') + esc(o.name) + '">' + (o.hidden ? ICON.eyeOff : ICON.eye) + '</button></div>'
    ).join('');
    list.querySelectorAll('[data-id]').forEach((b) => { b.onclick = (e) => this._select(b.dataset.id, e.shiftKey || e.metaKey || e.ctrlKey); });
    list.querySelectorAll('[data-dims]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); this._toggleDims(b.dataset.dims); }; });
    list.querySelectorAll('[data-hide]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); this._toggleHidden(b.dataset.hide); }; });
    this._bindTips(list);
    this._renderPoints();
  };
  ModelEngine.prototype._renderPoints = function () {
    const host = this.root.querySelector('[data-points]');
    const list = this.root.querySelector('[data-pointlist]');
    if (!host || !list) return;
    const cps = this.data.checkpoints || [];
    list.innerHTML = cps.length ? '<div class="mdl-k">Saved</div>' + cps.map((cp) =>
      '<div class="mdl-item"><input class="mdl-pointname" data-pointrename="' + esc(cp.id) + '" value="' + esc(cp.name) + '" maxlength="80" aria-label="Rename ' + esc(cp.name) + '" autocomplete="off" autocorrect="off" spellcheck="false"><button type="button" class="mdl-ico" data-restore="' + esc(cp.id) + '" aria-label="Restore ' + esc(cp.name) + '">' + ICON.restore + '</button><button type="button" class="mdl-ico mdl-danger" data-pointdel="' + esc(cp.id) + '" aria-label="Delete ' + esc(cp.name) + '">' + ICON.trash + '</button></div>'
    ).join('') : '';
    list.querySelectorAll('[data-pointrename]').forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') {
          e.preventDefault();
          const cp = (this.data.checkpoints || []).find((p) => p.id === el.dataset.pointrename);
          if (cp) el.value = cp.name;
          el.blur();
        }
      });
      el.addEventListener('change', () => this._renamePoint(el.dataset.pointrename, el.value, el));
    });
    list.querySelectorAll('[data-restore]').forEach((b) => { b.onclick = () => this._restorePoint(b.dataset.restore); });
    list.querySelectorAll('[data-pointdel]').forEach((b) => { b.onclick = () => this._deletePoint(b.dataset.pointdel); });
    this._bindTips(list);
    this._pointSectionOn();
  };
  ModelEngine.prototype._pointSectionOn = function () {
    const host = this.root.querySelector('[data-points]');
    const box = this.root.querySelector('[data-pointnew]');
    if (!host) return;
    const open = box && !box.classList.contains('hidden');
    host.classList.toggle('on', ((this.data.checkpoints || []).length > 0) || open);
  };
  ModelEngine.prototype._askPoint = function () {
    const box = this.root.querySelector('[data-pointnew]');
    const input = this.root.querySelector('[data-pointname]');
    if (!box || !input) return;
    const n = (this.data.checkpoints || []).length + 1;
    input.value = 'Point ' + n;
    box.classList.remove('hidden');
    this._pointSectionOn();
    input.focus();
    input.select();
  };
  ModelEngine.prototype._cancelPoint = function () {
    const box = this.root.querySelector('[data-pointnew]');
    if (box) box.classList.add('hidden');
    this._pointSectionOn();
  };
  ModelEngine.prototype._savePoint = function (name) {
    if (!this.data.checkpoints) this.data.checkpoints = [];
    const n = this.data.checkpoints.length + 1;
    const label = String(name || '').trim().slice(0, 80) || ('Point ' + n);
    this.data.checkpoints.push({
      id: 'cp' + Math.random().toString(36).slice(2, 8),
      name: label,
      at: new Date().toISOString(),
      objects: JSON.parse(modelSnap(this.data.objects)),
    });
    if (this.data.checkpoints.length > 20) this.data.checkpoints.shift();
    this._cancelPoint();
    this._renderPoints();
    if (this.opts.onChange) this.opts.onChange();
    this._toast('Saved ' + label + '.');
  };
  ModelEngine.prototype._renamePoint = function (id, name, el) {
    const cp = (this.data.checkpoints || []).find((p) => p.id === id);
    if (!cp) return;
    const next = String(name || '').trim().slice(0, 80);
    if (!next) {
      if (el) el.value = cp.name;
      return;
    }
    if (next === cp.name) return;
    cp.name = next;
    if (el) el.setAttribute('aria-label', 'Rename ' + next);
    if (this.opts.onChange) this.opts.onChange();
  };
  ModelEngine.prototype._deletePoint = function (id) {
    const cps = this.data.checkpoints || [];
    const cp = cps.find((p) => p.id === id);
    if (!cp) return;
    this.data.checkpoints = cps.filter((p) => p.id !== id);
    this._renderPoints();
    if (this.opts.onChange) this.opts.onChange();
    this._toast('Deleted ' + cp.name + '.');
  };
  ModelEngine.prototype._restorePoint = function (id) {
    const cp = (this.data.checkpoints || []).find((p) => p.id === id);
    if (!cp) return;
    if (!this.data.history) this.data.history = { past: [], future: [] };
    if (this._snap) {
      this.data.history.past.push(JSON.parse(this._snap));
      if (this.data.history.past.length > 50) this.data.history.past.shift();
      this.data.history.future = [];
    }
    this._restore(cp.objects);
    this._toast('Restored ' + cp.name + '.');
  };
  ModelEngine.prototype._toggleDims = function (id) {
    const obj = this._obj(id);
    if (!obj) return;
    if (obj.dims === false) delete obj.dims;
    else obj.dims = false;
    this._renderList();
    this._changed();
  };
  ModelEngine.prototype._setAllHidden = function (hidden) {
    const list = this.data.objects || [];
    if (!list.length) { this._toast('There are no bodies.'); return; }
    C().setAllHidden(list, hidden);
    if (hidden) {
      this.multi = [];
      this.sel = null;
      this.root.dataset.sel = '';
    }
    let rebuild = false;
    for (const o of list) {
      const slot = this.objs[o.id];
      if (slot) slot.group.visible = !o.hidden;
      else if (!o.hidden) rebuild = true;
    }
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._paint();
    this._changed();
    if (rebuild) this._requestBuild();
  };
  ModelEngine.prototype._dropToFloor = function (id) {
    const obj = this._obj(id);
    const slot = obj && this.objs[obj.id];
    if (!obj || !slot || !slot.mesh) { this._toast('That body is not ready.'); return; }
    this._place(slot, obj);
    slot.group.updateMatrixWorld(true);
    const box = new this.T.Box3().setFromObject(slot.mesh);
    if (!box || box.isEmpty()) { this._toast('That body is not ready.'); return; }
    const shift = C().floorShift(box.min.z, 0);
    if (Math.abs(shift) < 0.05) { this._toast('That body is already on the floor.'); return; }
    obj.pos[2] = r3((obj.pos[2] || 0) + shift);
    this._place(slot, obj);
    this._renderInsp();
    this._syncGizmo();
    this._paint();
    this._changed();
  };
  ModelEngine.prototype._toggleHidden = function (id) {
    const obj = this._obj(id);
    if (!obj) return;
    if (obj.hidden) delete obj.hidden;
    else {
      obj.hidden = true;
      this.multi = this.multi.filter((x) => x !== id);
      if (this.sel === id) this.sel = this.multi[this.multi.length - 1] || null;
      this.root.dataset.sel = this.sel || '';
    }
    const slot = this.objs[id];
    if (slot) slot.group.visible = !obj.hidden;
    else if (!obj.hidden) this._requestBuild();
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._paint();
    this._changed();
  };
  ModelEngine.prototype._renderInsp = function () {
    const host = this.root.querySelector('[data-insp]');
    if (!host) return;
    const it = this._obj(this.sel);
    if (!it) { host.innerHTML = ''; return; }
    const size = it.type === 'box'
      ? '<label>Width<input data-size="x" inputmode="decimal" value="' + it.size.x + '"></label><label>Depth<input data-size="y" inputmode="decimal" value="' + it.size.y + '"></label><label>Height<input data-size="z" inputmode="decimal" value="' + it.size.z + '"></label>'
      : it.type === 'cylinder'
        ? '<label>Diameter<input data-size="d" inputmode="decimal" value="' + it.size.d + '"></label><label>Height<input data-size="z" inputmode="decimal" value="' + it.size.z + '"></label>'
        : it.type === 'sphere'
          ? '<label>Diameter<input data-size="d" inputmode="decimal" value="' + it.size.d + '"></label>'
          : it.type === 'sketch'
            ? '<label>Length<input data-height inputmode="decimal" value="' + it.height + '"></label>'
            : '';
    const slotNow = this.objs[it.id];
    const centerNow = slotNow ? this._worldCenter(slotNow, it) : { x: it.pos[0], y: it.pos[1], z: it.pos[2] };
    const centerVals = [r3(centerNow.x), r3(centerNow.y), r3(centerNow.z)];
    if (this.xfMode !== 'rotate' && this.xfMode !== 'scale') this.xfMode = 'translate';
    const on = (mode) => this.xfMode === mode ? ' class="on"' : '';
    const sc = it.scale || [1, 1, 1];
    const axisRow = (attr, vals) => ['x', 'y', 'z'].map((k, i) => {
      const active = attr === 'rot' && this._rotAxis === k;
      const letter = attr === 'rot'
        ? '<button type="button" class="mdl-ax ' + k + (active ? ' on' : '') + '" data-raxis="' + k + '" aria-label="Around ' + k.toUpperCase() + '">' + k.toUpperCase() + '</button>'
        : '<span class="mdl-ax ' + k + '">' + k.toUpperCase() + '</span>';
      return '<div class="mdl-axis' + (active ? ' on' : '') + '">' + letter
        + '<button type="button" class="mdl-nudge" data-nudge="' + attr + ':' + k + ':-1" aria-label="Decrease ' + k.toUpperCase() + '">' + ICON.minus + '</button>'
        + '<input data-' + attr + '="' + k + '" inputmode="decimal" value="' + vals[i] + '" aria-label="' + k.toUpperCase() + '">'
        + '<button type="button" class="mdl-nudge" data-nudge="' + attr + ':' + k + ':1" aria-label="Increase ' + k.toUpperCase() + '">' + ICON.plus + '</button></div>';
    }).join('');
    const channel = this.xfMode === 'rotate'
      ? '<div class="mdl-k">Rotate</div><div class="mdl-axes">' + axisRow('rot', it.rot.map(wrapDeg)) + '</div>'
        + '<div class="mdl-presets">'
        + '<button type="button" data-rpreset="90" aria-label="Rotate 90 degrees">90°</button>'
        + '<button type="button" data-rpreset="-90" aria-label="Rotate minus 90 degrees">−90°</button>'
        + '<button type="button" data-rpreset="180" aria-label="Turn 180 degrees">180°</button>'
        + '<button type="button" data-rpreset="360" aria-label="Turn a full circle">360°</button></div>'
        + '<div class="mdl-flips">'
        + '<button type="button" class="mdl-flip x" data-flip="x" aria-label="Flip around X"><span>X</span>' + ICON.flip + '</button>'
        + '<button type="button" class="mdl-flip y" data-flip="y" aria-label="Flip around Y"><span>Y</span>' + ICON.flip + '</button>'
        + '<button type="button" class="mdl-flip z" data-flip="z" aria-label="Flip around Z"><span>Z</span>' + ICON.flip + '</button></div>'
      : this.xfMode === 'scale'
        ? '<div class="mdl-k">Scale</div><div class="mdl-axes">' + axisRow('scale', sc) + '</div>'
        : '<div class="mdl-k">Move</div><div class="mdl-axes">' + axisRow('pos', centerVals) + '</div>';
    host.innerHTML = '<div class="mdl-insp">'
      + '<input class="mdl-name" data-name value="' + esc(it.name) + '" aria-label="Name" autocomplete="off" autocorrect="off">'
      + (size ? '<div class="mdl-k">Size</div><div class="mdl-fields">' + size + '</div>' : '')
      + '<div class="mdl-modes"><button type="button" data-mode="translate"' + on('translate') + ' aria-label="Move">' + ICON.move + '</button><button type="button" data-mode="rotate"' + on('rotate') + ' aria-label="Rotate">' + ICON.rotate + '</button><button type="button" data-mode="scale"' + on('scale') + ' aria-label="Scale">' + ICON.scale + '</button></div>'
      + channel
      + '<div class="mdl-actions">'
      + '<button type="button" class="mdl-text" data-floor>Drop to floor</button>'
      + (it.type === 'sketch' ? '<button type="button" class="mdl-ico" data-edit aria-label="Edit sketch">' + ICON.pencil + '</button>' : '')
      + '<button type="button" class="mdl-ico mdl-danger" data-del aria-label="Delete">' + ICON.trash + '</button></div></div>';
    const commitSize = () => {
      const cur = this._obj(this.sel);
      if (!cur) return;
      host.querySelectorAll('[data-size]').forEach((el) => { cur.size[el.dataset.size] = r3(Math.max(0.1, evalNum(el.value, cur.size[el.dataset.size]))); });
      this._renderList();
      this._changed();
      this._requestBuild();
    };
    host.querySelectorAll('[data-size]').forEach((el) => { el.addEventListener('change', commitSize); });
    const hIn = host.querySelector('[data-height]');
    if (hIn) hIn.addEventListener('change', () => {
      const cur = this._obj(this.sel);
      if (!cur) return;
      let h = evalNum(hIn.value, cur.height);
      if (Math.abs(h) < 0.001) h = h < 0 ? -0.001 : 0.001;
      cur.height = r3(h);
      this._renderList();
      this._changed();
      this._requestBuild();
    });
    host.querySelector('[data-name]').addEventListener('change', (e) => {
      const cur = this._obj(this.sel);
      if (!cur) return;
      cur.name = String(e.target.value || 'Body').slice(0, 80);
      this._renderList();
      this._changed();
    });
    const commitXform = () => {
      const cur = this._obj(this.sel);
      const slot = cur && this.objs[cur.id];
      if (!cur || !slot) return;
      const next = {};
      const posEls = host.querySelectorAll('[data-pos]');
      if (posEls.length === 3) {
        next.center = new this.T.Vector3(
          r3(evalNum(posEls[0].value, 0)),
          r3(evalNum(posEls[1].value, 0)),
          r3(evalNum(posEls[2].value, 0))
        );
      }
      const rotEls = host.querySelectorAll('[data-rot]');
      if (rotEls.length === 3) next.rot = [0, 1, 2].map((i) => wrapDeg(evalNum(rotEls[i].value, cur.rot[i])));
      const scEls = host.querySelectorAll('[data-scale]');
      if (scEls.length === 3) {
        next.scale = [0, 1, 2].map((i) => {
          const prev = (cur.scale || [1, 1, 1])[i];
          let v = evalNum(scEls[i].value, prev);
          if (Math.abs(v) < 0.05) v = v < 0 ? -0.05 : 0.05;
          return r3(v);
        });
      }
      this._applySpin(slot, cur, next);
      this._paint();
      this._changed();
    };
    host.querySelectorAll('[data-pos], [data-rot], [data-scale]').forEach((el) => el.addEventListener('change', commitXform));
    host.querySelectorAll('[data-nudge]').forEach((b) => b.onclick = () => {
      const parts = b.dataset.nudge.split(':');
      this._nudge(parts[0], parts[1], Number(parts[2]));
    });
    host.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
      this.xfMode = b.dataset.mode;
      this._renderInsp();
      this._syncGizmo();
    });
    host.querySelectorAll('[data-raxis]').forEach((b) => b.onclick = () => {
      this._rotAxis = b.dataset.raxis;
      this._renderInsp();
    });
    host.querySelectorAll('[data-rpreset]').forEach((b) => b.onclick = () => this._rotateBy(Number(b.dataset.rpreset)));
    host.querySelectorAll('[data-flip]').forEach((b) => b.onclick = () => {
      this._rotAxis = b.dataset.flip;
      this._rotateBy(180);
      this._renderInsp();
    });
    const edit = host.querySelector('[data-edit]');
    if (edit) edit.onclick = () => this._sketchEdit();
    host.querySelector('[data-floor]').onclick = () => this._dropToFloor(this.sel);
    host.querySelector('[data-del]').onclick = () => this._deleteSel();
    this._bindTips(host);
  };

  ModelEngine.prototype._nudge = function (attr, axis, dir) {
    const cur = this._obj(this.sel);
    const slot = cur && this.objs[cur.id];
    if (!cur || !slot) return;
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const step = attr === 'scale' ? 0.1 : 1;
    if (attr === 'pos') {
      cur.pos[i] = r3(cur.pos[i] + dir * step);
      this._place(slot, cur);
    } else if (attr === 'rot') {
      const next = cur.rot.slice();
      next[i] = wrapDeg((next[i] || 0) + dir * step);
      this._applySpin(slot, cur, { rot: next });
    } else {
      const next = (cur.scale || [1, 1, 1]).slice();
      let v = next[i] + dir * step;
      if (Math.abs(v) < 0.05) v = v < 0 ? -0.05 : 0.05;
      next[i] = r3(v);
      this._applySpin(slot, cur, { scale: next });
    }
    this._syncFields();
    this._paint();
    this._changed();
  };
  ModelEngine.prototype._rotateBy = function (deg) {
    const cur = this._obj(this.sel);
    const slot = cur && this.objs[cur.id];
    if (!cur || !slot || !Number.isFinite(deg)) return;
    const i = this._rotAxis === 'x' ? 0 : this._rotAxis === 'y' ? 1 : 2;
    const next = cur.rot.slice();
    next[i] = wrapDeg((next[i] || 0) + deg);
    this._applySpin(slot, cur, { rot: next });
    this._syncFields();
    this._changed();
  };
  ModelEngine.prototype._add = function (type) {
    const size = Object.assign({}, C().DEFAULT_SIZE[type] || C().DEFAULT_SIZE.box);
    const lift = type === 'sphere' ? size.d / 2 : (size.z || 0) / 2;
    const pos = this.data.objects.length ? this._inView(lift) : [0, 0, 0];
    const label = { box: 'Body', cylinder: 'Cylinder', sphere: 'Sphere' }[type] || 'Body';
    const names = new Set(this.data.objects.map((o) => o.name));
    let name = label, i = 2;
    while (names.has(name)) { name = label + ' ' + i; i++; }
    const obj = C().normObject({ name, kernel: 'brep', type, size, pos, rot: [0, 0, 0], features: [] });
    this.data.objects.push(obj);
    this.sel = obj.id;
    this.multi = [obj.id];
    this._preview(obj);
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._changed();
    this._requestBuild();
  };
  ModelEngine.prototype._dropSlot = function (id) {
    delete this._shapeSigs[id];
    const o = this.objs[id];
    if (!o) return;
    this.itemsGroup.remove(o.group);
    o.mesh.geometry.dispose();
    o.edges.geometry.dispose();
    o.mesh.material.dispose();
    o.edges.material.dispose();
    (o.picks || []).forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
    delete this.objs[id];
  };
  ModelEngine.prototype._deleteSel = function () {
    const ids = this.multi.length ? this.multi.slice() : (this.sel ? [this.sel] : []);
    if (!ids.length) return;
    const drop = new Set(ids);
    this.data.objects = this.data.objects.filter((o) => !drop.has(o.id));
    ids.forEach((id) => this._dropSlot(id));
    this.sel = null;
    this.multi = [];
    this.root.dataset.sel = '';
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._paint();
    if (this.worker) {
      const alive = this.data.objects.filter((o) => !o.hidden).map((o) => o.id);
      try { this.worker.postMessage({ type: 'drop', alive }); } catch (e) { /* the picture is already gone */ }
    }
    this._changed();
  };

  ModelEngine.prototype._faceGeom = function (face) {
    const T = this.T;
    const s = face.surface;
    if (s && s.vertices && s.vertices.length >= 9 && s.triangles && s.triangles.length >= 3) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(s.vertices, 3));
      g.setIndex(s.triangles);
      return g;
    }
    if (!face.loop || face.loop.length < 3) return null;
    const g = new T.BufferGeometry();
    const c = face.center;
    const pos = [c[0], c[1], c[2]];
    const idx = [];
    face.loop.forEach((p, k) => { pos.push(p[0], p[1], p[2]); idx.push(0, k + 1, (k + 1) % face.loop.length + 1); });
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  };
  ModelEngine.prototype._setFaces = function (slot, body) {
    const T = this.T;
    (slot.picks || []).forEach((m) => { if (m.parent) m.parent.remove(m); m.geometry.dispose(); m.material.dispose(); });
    slot.faces = body.faces || [];
    slot.picks = [];
    slot.faces.forEach((face, i) => {
      const g = this._faceGeom(face);
      if (!g) return;
      const m = new T.Mesh(g, new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide }));
      m.userData.id = body.id;
      m.userData.face = i;
      (slot.local || slot.group).add(m);
      slot.picks.push(m);
    });
    this._markFace();
  };
  ModelEngine.prototype._clearFaceMark = function () {
    (this._faceMarks || []).forEach((m) => {
      if (m.parent) m.parent.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this._faceMarks = [];
    this._faceLine = null;
  };
  ModelEngine.prototype._markFace = function () {
    const T = this.T;
    this._clearFaceMark();
    const hit = this._faceHit;
    const chip = this.root.querySelector('[data-facedim]');
    if (!hit) {
      if (chip) chip.textContent = 'Select a face';
      this._paint();
      this._showCutPlane();
      return;
    }
    const slot = this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    if (chip) chip.textContent = face ? this._faceDimText(face, slot && this._shapeMatrix(slot)) : 'Face';
    if (!slot || !face) { this._paint(); this._showCutPlane(); return; }
    const n = face.normal;
    const lift = 0.08;
    const fill = new T.BufferGeometry();
    const s = face.surface;
    if (s && s.vertices && s.vertices.length >= 9 && s.triangles && s.triangles.length >= 3) {
      const nrm = s.normals && s.normals.length === s.vertices.length ? s.normals : null;
      const pos = new Float32Array(s.vertices.length);
      for (let i = 0; i < s.vertices.length; i += 3) {
        const nx = nrm ? nrm[i] : n[0];
        const ny = nrm ? nrm[i + 1] : n[1];
        const nz = nrm ? nrm[i + 2] : n[2];
        pos[i] = s.vertices[i] + nx * lift;
        pos[i + 1] = s.vertices[i + 1] + ny * lift;
        pos[i + 2] = s.vertices[i + 2] + nz * lift;
      }
      fill.setAttribute('position', new T.BufferAttribute(pos, 3));
      fill.setIndex(s.triangles.slice());
    } else if (face.loop && face.loop.length >= 3) {
      const at = (p) => [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift];
      const c = at(face.center);
      const loop = face.loop.map(at);
      const pos = [];
      for (let i = 0; i < loop.length; i++) {
        const q = loop[(i + 1) % loop.length];
        const p = loop[i];
        pos.push(c[0], c[1], c[2], p[0], p[1], p[2], q[0], q[1], q[2]);
      }
      fill.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    } else { this._paint(); this._showCutPlane(); return; }
    const mesh = new T.Mesh(fill, new T.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.55, depthTest: false, side: T.DoubleSide }));
    mesh.renderOrder = 3;
    (slot.local || slot.group).add(mesh);
    this._faceMarks = [mesh];
    if (face.loop && face.loop.length >= 3) {
      const atLine = (p) => [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift];
      const pts = face.loop.map((p) => { const q = atLine(p); return new T.Vector3(q[0], q[1], q[2]); });
      pts.push(pts[0].clone());
      const line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: ORANGE, depthTest: false }));
      line.renderOrder = 4;
      (slot.local || slot.group).add(line);
      this._faceMarks.push(line);
      this._faceLine = line;
    }
    this._paint();
    this._showCutPlane();
  };
  ModelEngine.prototype._setAdding = function (on) {
    this.adding = !!on;
    const more = this.root.querySelector('[data-more]');
    if (more) more.classList.toggle('on', this.adding);
  };
  ModelEngine.prototype._sub3 = function (a, b) {
    return [a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0)];
  };
  ModelEngine.prototype._dot3 = function (a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  };
  ModelEngine.prototype._cross3 = function (a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  };
  ModelEngine.prototype._circum3 = function (a, b, c) {
    const ab = this._sub3(b, a), ac = this._sub3(c, a);
    const n = this._cross3(ab, ac);
    const n2 = this._dot3(n, n);
    if (n2 < 1e-10) return null;
    const center = [0, 1, 2].map((i) => a[i] + (this._dot3(ac, ac) * this._cross3(n, ab)[i] - this._dot3(ab, ab) * this._cross3(n, ac)[i]) / (2 * n2));
    return { c: center, r: Math.hypot(a[0] - center[0], a[1] - center[1], (a[2] || 0) - center[2]), n };
  };
  ModelEngine.prototype._arcLen = function (a, mid, b) {
    const hit = this._circum3(a, mid, b);
    if (!hit) return Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0));
    const ca = this._sub3(a, hit.c), cm = this._sub3(mid, hit.c), cb = this._sub3(b, hit.c);
    const turn = Math.atan2(this._dot3(this._cross3(ca, cb), hit.n), this._dot3(ca, cb));
    const via = Math.atan2(this._dot3(this._cross3(ca, cm), hit.n), this._dot3(ca, cm));
    let sweep = turn;
    if (sweep * via < 0) sweep += sweep > 0 ? -Math.PI * 2 : Math.PI * 2;
    return Math.abs(sweep) * hit.r;
  };
  ModelEngine.prototype._bodyEdges = function (id) {
    const slot = this.objs[id];
    if (!slot) return [];
    const byKey = new Map();
    const out = [];
    const keyOf = (pts) => pts.map((p) => p.map((v) => Math.round(v * 100)).join(',')).sort().join('|');
    const add = (key, edge, face) => {
      const prev = byKey.get(key);
      if (prev) { prev.faces.push(face); return; }
      edge.faces = [face];
      byKey.set(key, edge);
      out.push(edge);
    };
    for (const face of slot.faces || []) {
      const wires = (face.exact && face.exact.length) ? face.exact : (face.measures && face.measures.length ? [{ edges: face.measures }] : []);
      for (const wire of wires) {
        for (const e of wire.edges || []) {
          if (e.k === 'line' && e.a && e.b) {
            const at = e.a.map((v, i) => (v + e.b[i]) / 2);
            const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], (e.b[2] || 0) - (e.a[2] || 0));
            add(id + ':' + keyOf([e.a, e.b]), { id, key: id + ':' + keyOf([e.a, e.b]), k: 'line', a: e.a, b: e.b, at, len }, face);
          } else if (e.k === 'arc' && e.a && e.b && e.mid) {
            const key = id + ':' + keyOf([e.a, e.b, e.mid]);
            add(key, { id, key, k: 'arc', a: e.a, b: e.b, mid: e.mid, at: e.mid.slice(), len: this._arcLen(e.a, e.mid, e.b) }, face);
          } else if (e.k === 'circle' && e.c) {
            const key = id + ':c' + e.c.map((v) => Math.round(v * 100)).join(',') + ':' + Math.round(e.r * 100);
            const round = { id, key, k: 'circle', c: e.c, r: e.r, ...(e.n ? { n: e.n } : {}), faces: [face], len: Math.PI * 2 * e.r };
            const onEdge = this._circlePts(round)[0];
            round.at = onEdge || e.c.slice();
            add(key, round, face);
          } else if (e.k === 'curve' && e.mid && e.pts && e.pts.length >= 2) {
            const key = id + ':u' + keyOf([e.a || e.pts[0], e.mid, e.b || e.pts[e.pts.length - 1]]);
            add(key, { id, key, k: 'curve', a: e.a, b: e.b, mid: e.mid, pts: e.pts, at: e.mid.slice(), len: e.len || 0 }, face);
          }
        }
      }
    }
    return out;
  };
  ModelEngine.prototype._seesCamera = function (normal, at) {
    const to = this.camera.position.clone().sub(at);
    const len = to.length();
    const n = normal.clone().normalize();
    if (len < 1e-6 || n.lengthSq() < 1e-8) return false;
    return n.dot(to) / len > 0.08;
  };
  ModelEngine.prototype._openToCamera = function (at, meshes) {
    const origin = this.camera.position;
    const dir = at.clone().sub(origin);
    const dist = dir.length();
    if (dist < 1e-4) return false;
    dir.multiplyScalar(1 / dist);
    if (!this._dimRay) this._dimRay = new this.T.Raycaster();
    this._dimRay.set(origin, dir);
    this._dimRay.far = dist;
    const hits = this._dimRay.intersectObjects(meshes, false);
    return !hits.length || hits[0].distance > dist - 0.8;
  };
  ModelEngine.prototype._screenOf = function (local, world) {
    const T = this.T;
    const p = new T.Vector3(local[0], local[1], local[2] || 0).applyMatrix4(world).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (p.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-p.y * 0.5 + 0.5) * rect.height + rect.top,
      z: p.z,
    };
  };
  ModelEngine.prototype._edgeSamples = function (edge) {
    if (edge.k === 'line') {
      const pts = [];
      for (let i = 0; i <= 8; i++) pts.push(edge.a.map((v, k) => v + (edge.b[k] - v) * i / 8));
      return pts;
    }
    if (edge.k === 'curve' && edge.pts && edge.pts.length >= 2) return edge.pts;
    if (edge.k === 'arc') return [edge.a, edge.mid, edge.b];
    if (edge.k === 'circle') return this._circlePts(edge);
    return edge.pts || [];
  };
  ModelEngine.prototype._edgeTap = function (e) {
    let best = null;
    let bestD = 22;
    for (const o of this.data.objects) {
      if (o.hidden) continue;
      const slot = this.objs[o.id];
      if (!slot || !slot.group.visible) continue;
      const world = this._shapeMatrix(slot);
      for (const edge of this._bodyEdges(o.id)) {
        for (const p of this._edgeSamples(edge)) {
          const s = this._screenOf(p, world);
          if (s.z < -1 || s.z > 1) continue;
          const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
          if (d < bestD) { bestD = d; best = edge; }
        }
      }
    }
    this._edgeHit = best;
    if (!best) this._toast('Tap an edge.');
    this._markEdge();
  };
  ModelEngine.prototype._clearEdgeMark = function () {
    if (!this._edgeMark) return;
    if (this._edgeMark.parent) this._edgeMark.parent.remove(this._edgeMark);
    this._edgeMark.geometry.dispose();
    this._edgeMark.material.dispose();
    this._edgeMark = null;
  };
  ModelEngine.prototype._markEdge = function () {
    const T = this.T;
    this._clearEdgeMark();
    const hit = this._edgeHit;
    const chip = this.root.querySelector('[data-edgedim]');
    const slot = hit && this.objs[hit.id];
    const world = slot && T && this._shapeMatrix(slot);
    const measured = hit && this._measureEdge(hit, world);
    if (chip) {
      chip.classList.toggle('on', !!hit);
      if (!hit) chip.textContent = 'Select an edge';
      else if (measured && measured.kind === 'diameter') chip.textContent = 'Ø ' + r3(measured.value);
      else if (measured) chip.textContent = String(r3(measured.value));
      else chip.textContent = 'Edge';
    }
    if (!hit || !T || !slot) {
      this._paint();
      return;
    }
    const pts = this._edgeSamples(hit).map((p) => new T.Vector3(p[0], p[1], p[2] || 0));
    if (hit.k === 'circle' && pts.length) pts.push(pts[0].clone());
    if (pts.length < 2) { this._paint(); return; }
    // Bright selected edge. WebGL lines are 1px, so a thin tube stands in for ~2× thickness.
    const curve = pts.length === 2
      ? new T.LineCurve3(pts[0], pts[1])
      : new T.CatmullRomCurve3(pts, false, 'catmullrom', 0.05);
    const geom = slot.mesh && slot.mesh.geometry;
    if (geom && !geom.boundingBox) geom.computeBoundingBox();
    const size = geom && geom.boundingBox ? geom.boundingBox.getSize(new T.Vector3()) : null;
    const span = size ? Math.max(size.x, size.y, size.z, 8) : 40;
    const r = Math.max(0.18, Math.min(1.2, span * 0.01));
    const mesh = new T.Mesh(
      new T.TubeGeometry(curve, Math.max(8, pts.length * 3), r, 6, false),
      new T.MeshBasicMaterial({ color: 0xff9a2e, depthTest: false })
    );
    mesh.renderOrder = 5;
    mesh.raycast = () => {};
    (slot.local || slot.group).add(mesh);
    this._edgeMark = mesh;
    this._paint();
  };
  ModelEngine.prototype._edgeApply = function (kind) {
    const hit = this._edgeHit;
    if (!hit) { this._toast('Select an edge.'); return; }
    const obj = this._obj(hit.id);
    if (!obj || obj.kernel === 'mesh' || obj.type === 'mesh') { this._toast('Edge tools work on an exact body.'); return; }
    if (kind === 'sharp') {
      let best = -1;
      let bestD = Infinity;
      (obj.features || []).forEach((f, i) => {
        if (!f || (f.op !== 'fillet' && f.op !== 'chamfer') || !f.at) return;
        const d = Math.hypot(f.at[0] - hit.at[0], f.at[1] - hit.at[1], (f.at[2] || 0) - (hit.at[2] || 0));
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0 || bestD > Math.max(hit.len, 4)) { this._toast('This edge has no round to remove.'); return; }
      obj.features.splice(best, 1);
    } else {
      const field = this.root.querySelector('[data-edger]');
      const r = evalNum(field && field.value, 1);
      if (!(r >= 0.05)) { this._toast('Use a radius of at least 0.05 mm.'); return; }
      obj.features.push({ op: kind === 'chamfer' ? 'chamfer' : 'fillet', at: hit.at.slice(), r: r3(r) });
    }
    this._dropBuilt(obj);
    this._edgeHit = null;
    this._markEdge();
    this._changed();
    this._requestBuild();
    this._toast(kind === 'sharp' ? 'The round is removed.' : kind === 'chamfer' ? 'The edge is chamfered.' : 'The edge is rounded.');
  };
  ModelEngine.prototype._syncCutBar = function () {
    const bar = this.root.querySelector('[data-cutbar]');
    if (!bar) return;
    const n = this.multi.length;
    const show = this.mode === 'object' && !this.sk && n >= 2;
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const cutOn = n === 2;
    bar.querySelectorAll('[data-cutops]').forEach((el) => el.classList.toggle('hidden', !cutOn));
    if (!cutOn) return;
    const a = this._obj(this.multi[0]);
    const b = this._obj(this.multi[1]);
    const na = (a && a.name) || 'First';
    const nb = (b && b.name) || 'Second';
    const ba = bar.querySelector('[data-cuta]');
    const bb = bar.querySelector('[data-cutb]');
    if (ba) ba.textContent = na + ' cuts ' + nb;
    if (bb) bb.textContent = nb + ' cuts ' + na;
  };
  ModelEngine.prototype._cutHowSet = function (how) {
    this._cutHow = how === 'split' ? 'split' : 'delete';
    this.root.querySelectorAll('[data-cuthow]').forEach((b) => b.classList.toggle('on', b.dataset.cuthow === this._cutHow));
  };
  // The group is what is on screen. Write that pose back before a cut so the
  // boolean uses the overlap the user sees, and a later place cannot jump.
  ModelEngine.prototype._syncPlacement = function (obj) {
    const slot = obj && this.objs[obj.id];
    const geom = slot && slot.mesh && slot.mesh.geometry;
    if (!slot || !slot.group || !geom) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox || geom.boundingBox.isEmpty()) return;
    const g = slot.group;
    const eu = new this.T.Euler().setFromQuaternion(g.quaternion, 'ZYX');
    obj.rot = [eu.x, eu.y, eu.z].map((v) => wrapDeg(v / DEG));
    obj.scale = [g.scale.x, g.scale.y, g.scale.z].map((v) => r3(Math.abs(v) < 0.05 ? (v < 0 ? -0.05 : 0.05) : v));
    const spun = this._spinOf(obj, this._bodyCenter(slot));
    obj.pos = [r3(g.position.x - spun.x), r3(g.position.y - spun.y), r3(g.position.z - spun.z)];
  };
  ModelEngine.prototype._cutPair = function (toolIndex) {
    if (this.multi.length !== 2) { this._toast('Select two bodies.'); return; }
    const roles = C().cutRoles(this.multi, toolIndex);
    const tool = this._obj(roles.tool);
    const target = this._obj(roles.target);
    if (!tool || !target) return;
    if (tool.kernel === 'mesh' || target.kernel === 'mesh' || tool.type === 'mesh' || target.type === 'mesh') {
      this._toast('A mesh cannot cut an exact body.');
      return;
    }
    this._syncPlacement(tool);
    this._syncPlacement(target);
    const how = this._cutHow === 'split' ? 'split' : 'delete';
    const kept = C().normObject(target);
    const cut = C().normObject({
      name: target.name, kernel: 'brep', type: 'cut', cut: how,
      pos: target.pos.slice(), rot: target.rot.slice(), scale: (target.scale || [1, 1, 1]).slice(),
      ...(target.hidden ? { hidden: true } : {}),
      ...(target.dims === false ? { dims: false } : {}),
      features: [],
      parts: [C().normObject(target, 0, false), C().normObject(tool, 0, false)],
    });
    const idx = this.data.objects.findIndex((o) => o.id === target.id);
    if (idx < 0) return;
    this._pendingCut = { cutId: cut.id, target: kept, toolId: tool.id };
    this.data.objects.splice(idx, 1, cut);
    this.sel = cut.id;
    this.multi = [cut.id, tool.id];
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._syncCutBar();
    this._changed();
    this._requestBuild();
    this._toast(how === 'split'
      ? tool.name + ' divides ' + target.name + ' into separate bodies.'
      : tool.name + ' deletes from ' + target.name + '.');
  };
  ModelEngine.prototype._adoptSplit = function (b) {
    if (!b || !b.pieces || b.pieces.length < 2) return null;
    const obj = this._obj(b.id);
    if (!obj || obj.type !== 'cut' || obj.cut !== 'split') return null;
    const pos = (obj.pos || [0, 0, 0]).slice();
    const rot = (obj.rot || [0, 0, 0]).slice();
    const scale = (obj.scale || [1, 1, 1]).slice();
    const toolId = obj.parts && obj.parts[1] && obj.parts[1].id;
    const viewOf = (p) => ({
      vertices: Array.from(p.vertices),
      triangles: Array.from(p.triangles),
      faces: p.faces || [],
      ...(p.edges && p.edges.length >= 6 ? { edges: Array.from(p.edges) } : {}),
      ...(p.normals && p.vertices && p.normals.length === p.vertices.length ? { normals: Array.from(p.normals) } : {}),
    });
    const solid = C().normObject({
      id: obj.id, name: obj.name + ' 1', kernel: 'brep', type: 'solid',
      pos, rot, scale, features: [], brep: b.brep, brepHash: b.brepHash,
    });
    const rest = b.pieces.slice(1).map((p, i) => {
      const body = C().normObject({
        name: obj.name + ' ' + (i + 2), kernel: 'brep', type: 'solid',
        pos: pos.slice(), rot: rot.slice(), scale: scale.slice(), features: [],
        brep: p.brep, brepHash: p.brepHash,
      });
      body.view = viewOf(p);
      return body;
    });
    const idx = this.data.objects.findIndex((o) => o.id === obj.id);
    if (idx < 0) return null;
    this.data.objects.splice(idx, 1, solid, ...rest);
    const tool = toolId && this._obj(toolId);
    if (tool && tool.id !== solid.id) tool.hidden = true;
    this._pendingCut = null;
    this.sel = solid.id;
    this.multi = [solid.id, ...rest.map((o) => o.id)];
    this.root.dataset.sel = this.sel || '';
    this._snap = modelSnap(this.data.objects);
    this._syncHist();
    this._renderList();
    this._renderInsp();
    this._syncCutBar();
    this._syncGizmo();
    if (this.opts.onChange) this.opts.onChange();
    return rest.map((body, i) => Object.assign({ id: body.id }, b.pieces[i + 1]));
  };
  ModelEngine.prototype._revertCut = function (b) {
    const pending = this._pendingCut;
    if (!pending || !b || pending.cutId !== b.id) return false;
    const missed = !b.vertices || b.error || (b.notes || []).some((t) => t === 'Those bodies do not overlap.' || t === 'That body does not split the other.');
    if (!missed) { this._pendingCut = null; return false; }
    const idx = this.data.objects.findIndex((o) => o.id === b.id);
    const restored = C().normObject(pending.target);
    if (idx >= 0) this.data.objects[idx] = restored;
    this._pendingCut = null;
    this.sel = restored.id;
    this.multi = [restored.id, pending.toolId].filter((id) => this._obj(id));
    this.root.dataset.sel = this.sel || '';
    const slot = this.objs[restored.id];
    if (slot) this._place(slot, restored);
    const now = modelSnap(this.data.objects);
    const past = this.data.history && this.data.history.past;
    if (past && past.length && modelSnap(past[past.length - 1]) === now) past.pop();
    this._snap = now;
    this._syncHist();
    this._renderList();
    this._renderInsp();
    this._syncCutBar();
    this._syncGizmo();
    if (this.opts.onChange) this.opts.onChange();
    return true;
  };
  ModelEngine.prototype._setMode = function (mode, quiet) {
    const next = mode === 'face' || mode === 'edge' ? mode : 'object';
    if (this.sk && next !== 'object') this._sketchCancel();
    this.mode = next;
    this.faceOn = next === 'face';
    if (next !== 'face') {
      this._faceHit = null;
      this._faceHeld = 0;
      this._facePress = null;
      this._faceDrag = null;
      this._hideCutPlane();
    } else {
      this._setFaceTool('extrude', true);
    }
    if (next !== 'edge') {
      this._edgeHit = null;
      this._edgePress = null;
      this._clearEdgeMark();
      const chip = this.root.querySelector('[data-edgedim]');
      if (chip) { chip.classList.remove('on'); chip.textContent = 'Select an edge'; }
    }
    if (next !== 'object') this._setAdding(false);
    this.root.querySelectorAll('.mdl-rail [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === next));
    const facebar = this.root.querySelector('[data-facebar]');
    if (facebar) facebar.classList.toggle('hidden', next !== 'face');
    const edgebar = this.root.querySelector('[data-edgebar]');
    if (edgebar) edgebar.classList.toggle('hidden', next !== 'edge');
    this._syncCutBar();
    this._markFace();
    if (next === 'edge') this._markEdge();
    this._syncGizmo();
    if (!quiet) this._toast(next === 'face' ? 'Select a face to extrude, or switch to cut by plane.' : next === 'edge' ? 'These tools act on the selected edge.' : 'Selecting bodies.');
  };
  ModelEngine.prototype._setFaceTool = function (kind, quiet) {
    this._faceTool = C().faceTool(kind);
    this._syncFaceTool();
    this._showCutPlane();
    if (!quiet) {
      this._toast(this._faceTool === 'cut'
        ? 'Cut by plane is ready. Choose a plane and cut.'
        : 'Extrude is ready. Drag the face or enter a length.');
    }
  };
  ModelEngine.prototype._syncFaceTool = function () {
    const tool = C().faceTool(this._faceTool);
    this._faceTool = tool;
    this.root.querySelectorAll('[data-facetool]').forEach((b) => b.classList.toggle('on', b.dataset.facetool === tool));
    this.root.querySelectorAll('[data-faceextrude]').forEach((el) => el.classList.toggle('hidden', tool !== 'extrude'));
    this.root.querySelectorAll('[data-facecut]').forEach((el) => el.classList.toggle('hidden', tool !== 'cut'));
  };
  ModelEngine.prototype._faceToggle = function (quiet) {
    this._setMode(this.faceOn ? 'object' : 'face', quiet);
  };
  ModelEngine.prototype._pickFace = function (e) {
    const picks = [];
    Object.values(this.objs).forEach((o) => (o.picks || []).forEach((m) => { if (m.visible !== false && o.group.visible) picks.push(m); }));
    const hits = this._ray(e).intersectObjects(picks, false);
    if (!hits.length) return null;
    const m = hits[0].object;
    return { id: m.userData.id, index: m.userData.face };
  };
  ModelEngine.prototype._faceTap = function (e) {
    if (this._faceHeld && performance.now() - this._faceHeld < 500) return;
    const hit = this._pickFace(e);
    if (!hit) return;
    const slot = this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    const obj = this._obj(hit.id);
    if (!slot || !face || !obj || obj.kernel === 'mesh') { this._toast('Face push works on an exact body.'); return; }
    this._faceHeld = performance.now();
    this._faceHit = hit;
    this._markFace();
  };
  ModelEngine.prototype._beginFaceDrag = function (press) {
    // Extrude owns the drag. Cut by plane uses its own controls.
    if (C().faceTool(this._faceTool) !== 'extrude') return;
    // The face was chosen by the tap. The drag never raycasts, so turning the
    // view and pulling from another angle cannot switch to a different face.
    const hit = this._faceHit;
    const slot = hit && this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    const obj = hit && this._obj(hit.id);
    if (!slot || !face || !face.loop || face.loop.length < 3 || !obj || obj.kernel === 'mesh') return;
    const axis = this._faceAxis(slot, face);
    this._faceDrag = { id: press.id, x: press.x, y: press.y, dist: 0, hit: { id: hit.id, index: hit.index }, axis };
    this.controls.enabled = false;
    try { this.viewEl.setPointerCapture(press.id); } catch (err) { /* synthetic events */ }
  };
  ModelEngine.prototype._faceAxis = function (slot, face) {
    const T = this.T;
    const world = this._shapeMatrix(slot);
    const n = new T.Vector3(face.normal[0], face.normal[1], face.normal[2]).transformDirection(world).normalize();
    const o = new T.Vector3(face.center[0], face.center[1], face.center[2]).applyMatrix4(world);
    const a = o.clone().project(this.camera);
    const b = o.clone().add(n).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const dx = (b.x - a.x) * rect.width / 2;
    const dy = -(b.y - a.y) * rect.height / 2;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len, mm: clamp(1 / len, 0.02, 2) };
  };
  ModelEngine.prototype._faceMove = function (e) {
    const d = this._faceDrag;
    if (!d) return;
    const along = (e.clientX - d.x) * d.axis.x + (e.clientY - d.y) * d.axis.y;
    const step = e.shiftKey ? 0.01 : 0.1;
    d.dist = r3(Math.round((along * d.axis.mm) / step) * step);
    const field = this.root.querySelector('[data-exdist]');
    if (field && document.activeElement !== field) field.value = String(d.dist);
    this._facePreview(d);
  };
  ModelEngine.prototype._facePreview = function (d) {
    const T = this.T;
    const slot = this.objs[d.hit.id];
    const face = slot && slot.faces[d.hit.index];
    if (this._facePrev && this._facePrev.parent) { this._facePrev.parent.remove(this._facePrev); this._facePrev.geometry.dispose(); this._facePrev.material.dispose(); this._facePrev = null; }
    if (!slot || !face || Math.abs(d.dist) < 0.001) return;
    const n = face.normal;
    const loop = face.loop;
    const c = face.center;
    const top = loop.map((p) => [p[0] + n[0] * d.dist, p[1] + n[1] * d.dist, p[2] + n[2] * d.dist]);
    const topC = [c[0] + n[0] * d.dist, c[1] + n[1] * d.dist, c[2] + n[2] * d.dist];
    const pos = [];
    const push = (a, b, c0) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c0[0], c0[1], c0[2]); };
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      push(c, loop[i], loop[j]);
      push(topC, top[j], top[i]);
    }
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      push(loop[i], loop[j], top[j]);
      push(loop[i], top[j], top[i]);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this._facePrev = new T.Mesh(g, new T.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.45, depthTest: false, side: T.DoubleSide }));
    this._facePrev.renderOrder = 2;
    (slot.local || slot.group).add(this._facePrev);
  };
  ModelEngine.prototype._faceUp = function (e) {
    const d = this._faceDrag;
    this._faceDrag = null;
    this._freeNav();
    if (!d) return;
    const slot = this.objs[d.hit.id];
    if (this._facePrev && this._facePrev.parent) { this._facePrev.parent.remove(this._facePrev); this._facePrev.geometry.dispose(); this._facePrev.material.dispose(); this._facePrev = null; }
    this._commitFaceDist(d.hit, d.dist);
  };
  ModelEngine.prototype._extrudeLength = function () {
    const field = this.root.querySelector('[data-exdist]');
    const dist = r3(evalNum(field && field.value, 0));
    if (!this._faceHit) { this._toast('Select a face first.'); return; }
    if (Math.abs(dist) < 0.05) { this._toast('Enter a length of at least 0.05 mm.'); return; }
    this._commitFaceDist(this._faceHit, dist);
  };
  ModelEngine.prototype._cutNormal = function () {
    if (this._splitPlane === 'xy') return [0, 0, 1];
    if (this._splitPlane === 'xz') return [0, 1, 0];
    return [1, 0, 0];
  };
  ModelEngine.prototype._hideCutPlane = function () {
    const group = this._cutPlane;
    if (!group) return;
    if (group.parent) group.parent.remove(group);
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    this._cutPlane = null;
  };
  ModelEngine.prototype._nudgeCut = function (dir) {
    const field = this.root.querySelector('[data-splitoff]');
    if (!field || !Number.isFinite(dir)) return;
    field.value = String(r3(evalNum(field.value, 0) + dir));
    this._showCutPlane();
  };
  ModelEngine.prototype._showCutPlane = function () {
    this._hideCutPlane();
    if (!this.faceOn || !this._faceHit || !this.T || !C().faceCutPlaneOn(this._faceTool)) return;
    const T = this.T;
    const slot = this.objs[this._faceHit.id];
    const face = slot && slot.faces[this._faceHit.index];
    if (!slot || !face || !face.center) return;
    const n = this._cutNormal();
    const field = this.root.querySelector('[data-splitoff]');
    const offset = r3(evalNum(field && field.value, 0));
    const origin = face.center.map((c, i) => c + n[i] * offset);
    const u = this._splitPlane === 'yz' ? [0, 1, 0] : [1, 0, 0];
    const v = this._splitPlane === 'xy' ? [0, 1, 0] : [0, 0, 1];
    const geom = slot.mesh && slot.mesh.geometry;
    if (geom && !geom.boundingBox) geom.computeBoundingBox();
    const size = geom && geom.boundingBox ? geom.boundingBox.getSize(new T.Vector3()) : new T.Vector3(40, 40, 40);
    const span = Math.max(size.x, size.y, size.z, 10) * 1.6;
    const half = span / 2;
    const corner = (su, sv) => [
      origin[0] + (u[0] * su + v[0] * sv) * half,
      origin[1] + (u[1] * su + v[1] * sv) * half,
      origin[2] + (u[2] * su + v[2] * sv) * half,
    ];
    const a = corner(-1, -1);
    const b = corner(1, -1);
    const c = corner(1, 1);
    const d = corner(-1, 1);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    const sheet = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0x2f6fed, transparent: true, opacity: 0.28, depthTest: false, side: T.DoubleSide }));
    sheet.renderOrder = 2;
    const edgePts = [a, b, c, d, a].map((p) => new T.Vector3(p[0], p[1], p[2]));
    const edge = new T.Line(new T.BufferGeometry().setFromPoints(edgePts), new T.LineBasicMaterial({ color: 0x2f6fed, depthTest: false }));
    edge.renderOrder = 4;
    const reach = Math.min(span * 0.22, 24);
    const tip = origin.map((p, i) => p + n[i] * reach);
    const back = tip.map((p, i) => p - n[i] * reach * 0.28);
    const side = reach * 0.12;
    const barb = (su, sv) => [
      back[0] + (u[0] * su + v[0] * sv) * side,
      back[1] + (u[1] * su + v[1] * sv) * side,
      back[2] + (u[2] * su + v[2] * sv) * side,
    ];
    const arrowPts = [
      new T.Vector3(origin[0], origin[1], origin[2]),
      new T.Vector3(tip[0], tip[1], tip[2]),
      new T.Vector3(...barb(1, 0)),
      new T.Vector3(tip[0], tip[1], tip[2]),
      new T.Vector3(...barb(-1, 0)),
      new T.Vector3(tip[0], tip[1], tip[2]),
      new T.Vector3(...barb(0, 1)),
      new T.Vector3(tip[0], tip[1], tip[2]),
      new T.Vector3(...barb(0, -1)),
    ];
    const arrow = new T.Line(new T.BufferGeometry().setFromPoints(arrowPts), new T.LineBasicMaterial({ color: 0x2f6fed, depthTest: false }));
    arrow.renderOrder = 5;
    const group = new T.Group();
    group.add(sheet, edge, arrow);
    group.traverse((obj) => { obj.raycast = () => {}; });
    (slot.local || slot.group).add(group);
    this._cutPlane = group;
  };
  ModelEngine.prototype._splitFace = function () {
    const hit = this._faceHit;
    const slot = hit && this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    const obj = hit && this._obj(hit.id);
    if (!obj || !face || !face.center) { this._toast('Select a face first.'); return; }
    const planeN = this._splitPlane === 'xy' ? [0, 0, 1] : this._splitPlane === 'xz' ? [0, 1, 0] : [1, 0, 0];
    const faceN = face.normal || [0, 0, 1];
    const dot = Math.abs(planeN[0] * faceN[0] + planeN[1] * faceN[1] + planeN[2] * faceN[2]);
    if (dot > 0.98) { this._toast('That plane is parallel to this face. Choose another one.'); return; }
    const field = this.root.querySelector('[data-splitoff]');
    const offset = r3(evalNum(field && field.value, 0));
    const origin = [0, 1, 2].map((i) => r3(face.center[i] + planeN[i] * offset));
    obj.features.push({ op: 'split', origin, normal: planeN.slice() });
    this._changed();
    this._requestBuild();
  };
  ModelEngine.prototype._commitFaceDist = function (hit, dist) {
    if (!hit || Math.abs(dist) < 0.05) return;
    const slot = this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    const obj = this._obj(hit.id);
    if (!obj || !face || !face.loop || face.loop.length < 3) { this._toast('This face cannot be extruded by a length.'); return; }
    obj.features.push({ op: 'push', loop: face.loop.map((p) => p.slice()), normal: face.normal.slice(), center: (face.center || face.loop[0]).slice(), dist: r3(dist), exact: true });
    this._changed();
    this._requestBuild();
  };

  ModelEngine.prototype._openSketch = function (plane, profiles, opts) {
    const o = opts || {};
    if (this.mode !== 'object') this._setMode('object', true);
    const list = (profiles || []).slice();
    this.sk = { tool: o.tool || 'rect', profiles: list, plane, chain: [], base: o.base != null ? o.base : list.length };
    const bar = this.root.querySelector('[data-skbar]');
    if (bar) bar.classList.remove('hidden');
    this._sketchTool(this.sk.tool);
    this._syncSketchDims();
    this._sketchSourceBar();
    this._syncGizmo();
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchStart = function () {
    const plane = this._sketchPlane();
    this._openSketch(plane, []);
  };
  ModelEngine.prototype._sketchTo2 = function (plane, slot) {
    const T = this.T;
    if (!T || !plane || !slot) return null;
    const world = this._shapeMatrix(slot);
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    if (y.lengthSq() < 1e-8) return null;
    return (p) => {
      const w = new T.Vector3(p[0] || 0, p[1] || 0, p[2] || 0).applyMatrix4(world);
      const d = w.sub(plane.origin);
      return [r3(d.dot(plane.xDir)), r3(d.dot(y))];
    };
  };
  // The face outline, in the sketch plane, as lines, circles, and arcs.
  // Prefer exact edges; fall back to the face loop so a sketch always opens.
  ModelEngine.prototype._projectExact = function (face, slot) {
    const plane = this._sketchPlane();
    if (!plane || !face || !face.exact || !face.exact.length) return null;
    const to2 = this._sketchTo2(plane, slot);
    if (!to2) return null;
    const wires = [];
    for (const w of face.exact) {
      const edges = [];
      for (const e of w.edges || []) {
        if (e.k === 'line' && e.a && e.b) edges.push({ k: 'line', a: to2(e.a), b: to2(e.b) });
        else if (e.k === 'circle' && e.c) edges.push({ k: 'circle', c: to2(e.c), r: r3(e.r) });
        else if (e.k === 'arc' && e.a && e.b && e.mid) edges.push({ k: 'arc', a: to2(e.a), b: to2(e.b), mid: to2(e.mid) });
        else return null;
      }
      if (!edges.length) return null;
      wires.push({ edges });
    }
    return { plane, wires };
  };
  ModelEngine.prototype._projectLoop = function (face, slot, plane) {
    const loop = face && face.loop;
    if (!plane || !loop || loop.length < 3) return null;
    const to2 = this._sketchTo2(plane, slot);
    if (!to2) return null;
    const pts = [];
    for (const p of loop) {
      const q = to2(p);
      if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.02) pts.push(q);
    }
    if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.02) pts.pop();
    return pts.length >= 3 ? [{ k: 'poly', pts }] : null;
  };
  ModelEngine.prototype._faceSketchProfiles = function (face, slot) {
    const plane = this._sketchPlane();
    if (!plane || !face || !slot) return null;
    const exact = this._projectExact(face, slot);
    if (exact && exact.wires && exact.wires.length) {
      return { plane: exact.plane, profiles: C().faceOutlineProfiles(exact.wires) };
    }
    const loop = this._projectLoop(face, slot, plane);
    if (loop) return { plane, profiles: loop };
    return null;
  };
  ModelEngine.prototype._sketchFromFace = function () {
    const hit = this._faceHit;
    const slot = hit && this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    if (!slot || !face) { this._toast('Select a face first.'); return; }
    const made = this._faceSketchProfiles(face, slot);
    if (!made || !made.profiles.length) { this._toast('This face cannot be sketched yet.'); return; }
    // Auto-create the face outline sketch, ready to edit and split into regions.
    this._openSketch(made.plane, made.profiles, { tool: 'line', base: made.profiles.length });
    if (this.sk) {
      this.sk.source = {
        id: hit.id,
        center: (face.center || (face.loop && face.loop[0]) || [0, 0, 0]).slice(),
        normal: (face.normal || [0, 0, 1]).slice(),
        loop: face.loop ? face.loop.map((p) => p.slice()) : null,
      };
      this.sk.outlineKey = this._profileKey(this.sk.profiles[0]);
    }
    this._sketchSourceBar();
    this._syncSketchDims();
    this._toast('Face sketch created. Draw a cut, then Split face. Tap a region to extrude.');
  };
  ModelEngine.prototype._planeBasis = function (normal) {
    const T = this.T;
    const n = normal.clone().normalize();
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
    const ref = Math.abs(n.z) < 0.9 ? new T.Vector3(0, 0, 1) : new T.Vector3(1, 0, 0);
    return new T.Vector3().crossVectors(ref, n).normalize();
  };
  ModelEngine.prototype._sketchPlane = function () {
    const T = this.T;
    const hit = this._faceHit;
    const slot = hit && this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    if (slot && face) {
      const world = this._shapeMatrix(slot);
      const surf = face.surface;
      const onFace = (face.loop && face.loop.length >= 2) ? face.loop
        : (surf && surf.vertices && surf.vertices.length >= 6) ? [[surf.vertices[0], surf.vertices[1], surf.vertices[2]], [surf.vertices[3], surf.vertices[4], surf.vertices[5]]]
        : null;
      const localN = (surf && surf.normals && surf.normals.length >= 3 && !(face.loop && face.loop.length >= 2))
        ? [surf.normals[0], surf.normals[1], surf.normals[2]] : (face.normal || [0, 0, 1]);
      const n = new T.Vector3(localN[0], localN[1], localN[2]).transformDirection(world);
      if (n.lengthSq() < 1e-8) n.set(0, 0, 1); else n.normalize();
      const p0 = onFace ? onFace[0] : (face.center || [0, 0, 0]);
      const origin = new T.Vector3(p0[0], p0[1], p0[2]).applyMatrix4(world);
      let x = null;
      if (onFace && onFace.length >= 2) {
        const p1 = new T.Vector3(onFace[1][0], onFace[1][1], onFace[1][2]).applyMatrix4(world);
        x = p1.sub(origin);
        x.addScaledVector(n, -x.dot(n));
        if (x.lengthSq() < 1e-8) x = null; else x.normalize();
      }
      if (!x) x = this._planeBasis(n);
      return { origin, normal: n, xDir: x };
    }
    const look = this.target || new T.Vector3();
    return { origin: new T.Vector3(look.x, look.y, 0), normal: new T.Vector3(0, 0, 1), xDir: new T.Vector3(1, 0, 0) };
  };
  ModelEngine.prototype._sketchTool = function (tool) {
    if (!this.sk) return;
    this.sk.tool = tool;
    this.sk.chain = [];
    this.root.querySelectorAll('[data-sktool]').forEach((b) => b.classList.toggle('on', b.dataset.sktool === tool));
  };
  ModelEngine.prototype._sketchPoint = function (e) {
    const T = this.T;
    const plane = this.sk && this.sk.plane;
    if (!plane) return null;
    const sheet = new T.Plane().setFromNormalAndCoplanarPoint(plane.normal, plane.origin);
    const ray = this._ray(e).ray;
    let hit = ray.intersectPlane(sheet, new T.Vector3());
    if (!hit) {
      const viewN = this.camera.getWorldDirection(new T.Vector3());
      const at = ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(viewN, this.target), new T.Vector3());
      if (!at) return null;
      hit = at.addScaledVector(sheet.normal, -sheet.distanceToPoint(at));
    }
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    if (y.lengthSq() < 1e-8) return null;
    const d = hit.clone().sub(plane.origin);
    return [r3(d.dot(plane.xDir)), r3(d.dot(y))];
  };
  ModelEngine.prototype._sketchSnapTol = function () {
    const plane = this.sk && this.sk.plane;
    const at = plane && plane.origin ? plane.origin : (this.target || { x: 0, y: 0, z: 0 });
    const px = this._worldPerPx(at);
    return Math.max(0.7, Math.min(5, px * 12));
  };
  ModelEngine.prototype._sketchSegments = function () {
    const segs = [];
    if (!this.sk) return segs;
    const add = (a, b) => {
      if (!a || !b) return;
      if (C().sketchSegLen(a, b) < 0.05) return;
      segs.push({ a: [a[0], a[1]], b: [b[0], b[1]] });
    };
    const addLoop = (pts, closed) => {
      if (!pts || pts.length < 2) return;
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) add(pts[i], pts[(i + 1) % pts.length]);
    };
    for (const p of this.sk.profiles || []) {
      if (p.k === 'rect') {
        const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.h / 2, y1 = p.y + p.h / 2;
        addLoop([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
      } else if (p.k === 'poly') addLoop(p.pts, true);
      else if (p.k === 'path') addLoop(p.pts, false);
      else if (p.k === 'exact') {
        for (const w of p.wires || []) {
          for (const e of w.edges || []) {
            if (e.k === 'line' && e.a && e.b) add(e.a, e.b);
          }
        }
      }
    }
    addLoop(this.sk.chain, false);
    return segs;
  };
  // Raw plane hit, then snap onto an existing sketch line / end / mid when close.
  ModelEngine.prototype._sketchPick = function (e, opts) {
    const raw = this._sketchPoint(e);
    if (!raw) return null;
    const o = opts || {};
    const geom = C().sketchSnapToLines(raw, this._sketchSegments(), { tol: this._sketchSnapTol() });
    if (geom.snapped && !o.skipGeom) {
      return {
        point: [r3(geom.point[0]), r3(geom.point[1])],
        snapped: true,
        kind: geom.kind || 'line',
        raw,
      };
    }
    return { point: raw, snapped: false, kind: 'free', raw };
  };
  ModelEngine.prototype._sketchDown = function (e) {
    const picked = this._sketchPick(e);
    if (!picked || !this.sk) return;
    const prev = this.sk.chain.length ? this.sk.chain[this.sk.chain.length - 1] : null;
    let guided;
    if (this.sk.tool === 'line' && prev && !picked.snapped) guided = this._sketchGuide(prev, picked.point);
    else guided = { point: picked.point, snapped: !!picked.snapped, kind: picked.kind || 'free' };
    const p = guided.point;
    this._skDrag = { id: e.pointerId, p0: p, p, moved: false, guide: guided };
    this.sk.guide = guided;
    this.controls.enabled = false;
    try { this.viewEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  };
  ModelEngine.prototype._sketchHover = function (e) {
    if (!this.sk) return;
    const picked = this._sketchPick(e);
    if (!picked) { this.sk.hover = null; this.sk.guide = null; this._sketchDraw(); return; }
    if (this.sk.tool === 'line' && this.sk.chain.length && !picked.snapped) {
      const guided = this._sketchGuide(this.sk.chain[this.sk.chain.length - 1], picked.point);
      this.sk.hover = guided.point;
      this.sk.guide = guided;
    } else {
      this.sk.hover = picked.point;
      this.sk.guide = picked.snapped ? { point: picked.point, snapped: true, kind: picked.kind } : null;
    }
    this._sketchDraw();
    this._syncSketchDims();
  };
  ModelEngine.prototype._sketchMove = function (e) {
    const d = this._skDrag;
    if (!d || !this.sk) return;
    const picked = this._sketchPick(e);
    if (!picked) return;
    if (Math.hypot(picked.point[0] - d.p0[0], picked.point[1] - d.p0[1]) > 0.4) d.moved = true;
    if (this.sk.tool === 'line') {
      const guided = picked.snapped
        ? { point: picked.point, snapped: true, kind: picked.kind }
        : this._sketchGuide(d.p0, picked.point);
      d.p = guided.point;
      d.guide = guided;
      this.sk.guide = guided;
    } else {
      d.p = picked.point;
      d.guide = picked.snapped ? { point: picked.point, snapped: true, kind: picked.kind } : null;
      this.sk.guide = d.guide;
    }
    this.sk.hover = d.p;
    this._sketchDraw();
    this._syncSketchDims();
  };
  ModelEngine.prototype._sketchPerpToggle = function () {
    if (!this.sk) return;
    this.sk.perp = !this.sk.perp;
    const b = this.root.querySelector('[data-skperp]');
    if (b) b.classList.toggle('on', !!this.sk.perp);
    if (this.sk.perp) this._sketchTool('line');
    this._toast(this.sk.perp ? 'Next line is locked at 90°.' : 'Lines snap near 0° / 45° / 90°.');
  };
  ModelEngine.prototype._lastSketchDir = function () {
    const chain = this.sk.chain || [];
    if (chain.length >= 2) return C().sketchDir(chain[chain.length - 2], chain[chain.length - 1]);
    for (let i = this.sk.profiles.length - 1; i >= 0; i--) {
      const p = this.sk.profiles[i];
      const pts = p.k === 'path' || p.k === 'poly' ? p.pts : null;
      if (pts && pts.length >= 2) return C().sketchDir(pts[pts.length - 2], pts[pts.length - 1]);
    }
    return [1, 0];
  };
  ModelEngine.prototype._sketchGuide = function (origin, raw) {
    const prev = this._lastSketchDir();
    if (this.sk && this.sk.perp) {
      const point = C().sketchPerpPoint(origin, prev, raw).map(r3);
      return { point, angle: 90, snapped: true, kind: 'perp' };
    }
    const hit = C().sketchSnapPoint(origin, prev, raw, { tol: 10 });
    return {
      point: [r3(hit.point[0]), r3(hit.point[1])],
      angle: hit.angle,
      snapped: !!hit.snapped,
      kind: hit.kind || 'free',
    };
  };
  ModelEngine.prototype._sketchClick = function (e) {
    if (!this.sk || this.sk.tool !== 'line') return;
    const picked = this._sketchPick(e);
    if (!picked) return;
    const c = this.sk.chain;
    if (c.length >= 3 && Math.hypot(picked.point[0] - c[0][0], picked.point[1] - c[0][1]) < 2) { this._sketchClose(); return; }
    const p = (c.length && !picked.snapped)
      ? this._sketchGuide(c[c.length - 1], picked.point).point
      : picked.point;
    if (c.length >= 3 && Math.hypot(p[0] - c[0][0], p[1] - c[0][1]) < 2) { this._sketchClose(); return; }
    c.push(p);
    this.sk.guide = null;
    this._syncSketchDims();
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchUp = function (e) {
    const d = this._skDrag;
    this._skDrag = null;
    this._freeNav();
    if (!d || !this.sk) return;
    // Lines are click-to-click: one press places one point. A drag must not
    // invent the start and end together as a finished segment.
    if (this.sk.tool === 'line') {
      if (!d.moved) this._sketchClick(e);
      else if (!this.sk.chain.length) {
        this.sk.chain.push(d.p0.slice());
        this.sk.hover = d.p;
        this.sk.guide = d.guide || null;
        this._syncSketchDims();
        this._sketchDraw();
      } else {
        const p = this._sketchGuide(this.sk.chain[this.sk.chain.length - 1], d.p).point;
        if (C().sketchSegLen(this.sk.chain[this.sk.chain.length - 1], p) >= 0.05) {
          this.sk.chain.push(p);
          this.sk.guide = null;
          this._syncSketchDims();
          this._sketchDraw();
        }
      }
      return;
    }
    if (!d.moved) return;
    if (this.sk.tool === 'rect') this._sketchAddRect(d.p0, d.p);
    else if (this.sk.tool === 'circle') this._sketchAddCircle(d.p0, d.p);
    this._syncSketchDims();
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchAddRect = function (a, b) {
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    if (w < 0.05 || h < 0.05) return;
    this.sk.profiles.push({ k: 'rect', x: r3((a[0] + b[0]) / 2), y: r3((a[1] + b[1]) / 2), w: r3(w), h: r3(h) });
  };
  ModelEngine.prototype._sketchAddCircle = function (a, b) {
    const rad = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rad < 0.05) return;
    this.sk.profiles.push({ k: 'circle', x: a[0], y: a[1], r: r3(rad) });
  };
  ModelEngine.prototype._sketchClose = function () {
    if (!this.sk || this.sk.chain.length < 3) return;
    this.sk.profiles.push({ k: 'poly', pts: this.sk.chain.map((p) => p.slice()) });
    this.sk.chain = [];
    this._syncSketchDims();
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchDraw = function () {
    const T = this.T;
    if (this._skLines) { this.scene.remove(this._skLines); this._skLines.geometry.dispose(); this._skLines = null; }
    if (!this.sk) { this._clearSketchOverlay(); return; }
    const plane = this.sk.plane;
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    const at = (p) => plane.origin.clone().addScaledVector(plane.xDir, p[0]).addScaledVector(y, p[1]);
    const pts = [];
    const add = (a, b) => { const A = at(a), B = at(b); pts.push(A.x, A.y, A.z, B.x, B.y, B.z); };
    for (const p of this.sk.profiles) {
      if (p.k === 'rect') {
        const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.h / 2, y1 = p.y + p.h / 2;
        add([x0, y0], [x1, y0]); add([x1, y0], [x1, y1]); add([x1, y1], [x0, y1]); add([x0, y1], [x0, y0]);
      } else if (p.k === 'circle') {
        for (let i = 0; i < 32; i++) {
          const a0 = i / 32 * Math.PI * 2, a1 = (i + 1) / 32 * Math.PI * 2;
          add([p.x + Math.cos(a0) * p.r, p.y + Math.sin(a0) * p.r], [p.x + Math.cos(a1) * p.r, p.y + Math.sin(a1) * p.r]);
        }
      } else if (p.k === 'poly' || p.k === 'path') {
        const n = p.k === 'poly' ? p.pts.length : p.pts.length - 1;
        for (let i = 0; i < n; i++) add(p.pts[i], p.pts[(i + 1) % p.pts.length]);
      } else if (p.k === 'exact') {
        for (const wire of p.wires || []) {
          for (const chain of this._exactChains(wire.edges || [])) {
            for (let i = 1; i < chain.length; i++) add(chain[i - 1], chain[i]);
          }
        }
      }
    }
    const live = this._skDrag && this._skDrag.moved ? this._skDrag : null;
    if (live && this.sk.tool === 'rect') {
      add(live.p0, [live.p[0], live.p0[1]]); add([live.p[0], live.p0[1]], live.p); add(live.p, [live.p0[0], live.p[1]]); add([live.p0[0], live.p[1]], live.p0);
    } else if (live && this.sk.tool === 'circle') {
      const rad = Math.hypot(live.p[0] - live.p0[0], live.p[1] - live.p0[1]);
      for (let i = 0; i < 32; i++) {
        const a0 = i / 32 * Math.PI * 2, a1 = (i + 1) / 32 * Math.PI * 2;
        add([live.p0[0] + Math.cos(a0) * rad, live.p0[1] + Math.sin(a0) * rad], [live.p0[0] + Math.cos(a1) * rad, live.p0[1] + Math.sin(a1) * rad]);
      }
    }
    const chain = this.sk.chain.slice();
    // Preview the line from the pressed start before that point is committed.
    if (this.sk.tool === 'line' && this._skDrag && !chain.length) chain.push(this._skDrag.p0);
    if (this.sk.hover && this.sk.tool === 'line') chain.push(this.sk.hover);
    for (let i = 1; i < chain.length; i++) add(chain[i - 1], chain[i]);
    // Mark when the cursor has snapped onto an existing line, end, or mid.
    const snap = this.sk.guide;
    if (snap && snap.snapped && (snap.kind === 'line' || snap.kind === 'end' || snap.kind === 'mid') && snap.point) {
      const s = this._sketchSnapTol() * 0.45;
      add([snap.point[0] - s, snap.point[1]], [snap.point[0] + s, snap.point[1]]);
      add([snap.point[0], snap.point[1] - s], [snap.point[0], snap.point[1] + s]);
    }
    if (pts.length) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      this._skLines = new T.LineSegments(g, new T.LineBasicMaterial({ color: ORANGE, depthTest: false }));
      this._skLines.renderOrder = 4;
      this.scene.add(this._skLines);
    }
    this._syncSketchOverlay();
  };
  ModelEngine.prototype._planeOf = function (obj) {
    const T = this.T;
    const eu = new T.Euler((obj.rot[0] || 0) * DEG, (obj.rot[1] || 0) * DEG, (obj.rot[2] || 0) * DEG, 'ZYX');
    const basis = new T.Matrix4().makeRotationFromEuler(eu);
    return {
      origin: new T.Vector3(obj.pos[0], obj.pos[1], obj.pos[2]),
      normal: new T.Vector3(0, 0, 1).transformDirection(basis),
      xDir: new T.Vector3(1, 0, 0).transformDirection(basis),
    };
  };
  ModelEngine.prototype._sketchEdit = function () {
    const it = this._obj(this.sel);
    if (!it || it.type !== 'sketch' || !this.T) return;
    if (this.mode !== 'object') this._setMode('object', true);
    const hIn = this.root.querySelector('[data-skh]');
    if (hIn) hIn.value = String(it.height);
    this._openSketch(this._planeOf(it), JSON.parse(JSON.stringify(it.profiles || [])));
    if (this.sk) this.sk.editId = it.id;
  };
  ModelEngine.prototype._axisRect = function (edges) {
    if (!edges || edges.length !== 4 || edges.some((e) => e.k !== 'line')) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of edges) {
      if (Math.abs(e.b[0] - e.a[0]) > 0.02 && Math.abs(e.b[1] - e.a[1]) > 0.02) return null;
      for (const p of [e.a, e.b]) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
    }
    const w = maxX - minX, h = maxY - minY;
    if (w < 0.05 || h < 0.05) return null;
    return { w, h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  ModelEngine.prototype._profileMeasure = function (p) {
    if (!p) return null;
    if (p.k === 'circle') return { kind: 'circle', r: p.r, target: p };
    if (p.k === 'rect') return { kind: 'rect', w: p.w, h: p.h, target: p };
    if (p.k !== 'exact' || !p.wires || p.wires.length !== 1) return null;
    const edges = p.wires[0].edges || [];
    if (edges.length === 1 && edges[0].k === 'circle') return { kind: 'xcircle', r: edges[0].r, edge: edges[0] };
    const rect = this._axisRect(edges);
    return rect ? { kind: 'xrect', w: rect.w, h: rect.h, cx: rect.cx, cy: rect.cy } : null;
  };
  ModelEngine.prototype._liveSketchSeg = function () {
    if (!this.sk || this.sk.tool !== 'line') return null;
    const chain = this.sk.chain || [];
    const tip = (this._skDrag && this._skDrag.moved) ? this._skDrag.p : this.sk.hover;
    if (!tip) return null;
    const origin = chain.length ? chain[chain.length - 1] : (this._skDrag && this._skDrag.moved ? this._skDrag.p0 : null);
    if (!origin) return null;
    if (C().sketchSegLen(origin, tip) < 0.05) return null;
    const guide = (this._skDrag && this._skDrag.guide) || this.sk.guide || null;
    const prevDir = chain.length >= 2 ? C().sketchDir(chain[chain.length - 2], chain[chain.length - 1])
      : (chain.length === 1 ? this._lastSketchDir() : [1, 0]);
    const angle = guide && guide.angle != null ? guide.angle : C().sketchSignedAngle(prevDir, C().sketchDir(origin, tip));
    return {
      a: origin,
      b: tip,
      len: C().sketchSegLen(origin, tip),
      angle,
      snapped: !!(guide && guide.snapped),
      kind: guide && guide.kind,
    };
  };
  ModelEngine.prototype._syncSketchDims = function () {
    const host = this.root.querySelector('[data-skdims]');
    if (!host) return;
    if (this._skDimEdit || host.querySelector('input:focus')) return;
    const live = this._liveSketchSeg();
    if (live) {
      const ang = Math.round(Math.abs(live.angle) * 10) / 10;
      const guide = this.sk.guide;
      const onLine = guide && guide.snapped && (guide.kind === 'line' || guide.kind === 'end' || guide.kind === 'mid');
      const snapLabel = onLine
        ? (guide.kind === 'end' ? 'On end' : guide.kind === 'mid' ? 'On mid' : 'On line')
        : (live.snapped ? (Math.abs(Math.abs(live.angle) - 90) < 0.6 ? '90°' : 'Snap') : '');
      host.innerHTML = '<label>Length<input data-skdim="live-len" inputmode="decimal" value="' + r3(live.len) + '"></label>'
        + '<label>Angle<input data-skdim="live-ang" inputmode="decimal" value="' + ang + '"></label>'
        + (snapLabel ? '<span class="mdl-chip on">' + snapLabel + '</span>' : '');
      host.querySelectorAll('[data-skdim]').forEach((el) => el.addEventListener('change', () => this._applySketchDim(el)));
      return;
    }
    const guide = this.sk && this.sk.guide;
    if (guide && guide.snapped && (guide.kind === 'line' || guide.kind === 'end' || guide.kind === 'mid')) {
      host.innerHTML = '<span class="mdl-chip on">' + (guide.kind === 'end' ? 'On end' : guide.kind === 'mid' ? 'On mid' : 'On line') + '</span>';
      return;
    }
    const m = this.sk && this._profileMeasure(this.sk.profiles[this.sk.profiles.length - 1]);
    if (!m) { host.innerHTML = '<span class="mdl-chip">Snap to a line, end, or mid</span>'; return; }
    if (m.kind === 'circle' || m.kind === 'xcircle') host.innerHTML = '<label>Ø<input data-skdim="d" inputmode="decimal" value="' + r3(m.r * 2) + '"></label>';
    else host.innerHTML = '<label>Width<input data-skdim="w" inputmode="decimal" value="' + r3(m.w) + '"></label><label>Height<input data-skdim="h" inputmode="decimal" value="' + r3(m.h) + '"></label>';
    host.querySelectorAll('[data-skdim]').forEach((el) => el.addEventListener('change', () => this._applySketchDim(el)));
  };
  ModelEngine.prototype._applySketchDim = function (el) {
    if (!this.sk) return;
    const v = evalNum(el.value, NaN);
    if (!Number.isFinite(v)) return;
    if (el.dataset.skdim === 'live-len' || el.dataset.skdim === 'live-ang') {
      const live = this._liveSketchSeg();
      if (!live) return;
      const next = el.dataset.skdim === 'live-len'
        ? C().sketchSetSegLen(live.a, live.b, v)
        : C().sketchSetAngle(live.a, this._lastSketchDir(), v * Math.sign(live.angle || 1) || v, live.len);
      const p = [r3(next[0]), r3(next[1])];
      if (this._skDrag) { this._skDrag.p = p; this._skDrag.moved = true; }
      this.sk.hover = p;
      this.sk.guide = { point: p, angle: el.dataset.skdim === 'live-ang' ? v : live.angle, snapped: true, kind: 'edit' };
      this._sketchDraw();
      return;
    }
    if (!this.sk.profiles.length) return;
    const p = this.sk.profiles[this.sk.profiles.length - 1];
    const m = this._profileMeasure(p);
    if (!m) return;
    if (el.dataset.skdim === 'd') {
      const r = r3(Math.max(0.05, v / 2));
      if (m.kind === 'circle') m.target.r = r;
      else m.edge.r = r;
    } else if (m.kind === 'rect') {
      m.target[el.dataset.skdim] = r3(Math.max(0.05, v));
    } else if (m.kind === 'xrect') {
      const w = el.dataset.skdim === 'w' ? Math.max(0.05, v) : m.w;
      const h = el.dataset.skdim === 'h' ? Math.max(0.05, v) : m.h;
      const x0 = r3(m.cx - w / 2), x1 = r3(m.cx + w / 2), y0 = r3(m.cy - h / 2), y1 = r3(m.cy + h / 2);
      p.wires[0].edges = [
        { k: 'line', a: [x0, y0], b: [x1, y0] },
        { k: 'line', a: [x1, y0], b: [x1, y1] },
        { k: 'line', a: [x1, y1], b: [x0, y1] },
        { k: 'line', a: [x0, y1], b: [x0, y0] },
      ];
    }
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchWorld = function (p2) {
    const T = this.T;
    const plane = this.sk && this.sk.plane;
    if (!T || !plane || !p2) return null;
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    if (y.lengthSq() < 1e-8) return null;
    return plane.origin.clone().addScaledVector(plane.xDir, p2[0]).addScaledVector(y, p2[1]);
  };
  ModelEngine.prototype._sketchScreen = function (p2) {
    const w = this._sketchWorld(p2);
    if (!w) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = w.clone().project(this.camera);
    if (p.z < -1 || p.z > 1) return null;
    return {
      x: (p.x * 0.5 + 0.5) * rect.width,
      y: (-p.y * 0.5 + 0.5) * rect.height,
    };
  };
  ModelEngine.prototype._sketchMeasureList = function () {
    if (!this.sk) return [];
    const items = [];
    const pushSeg = (a, b, key, editable, move) => {
      const len = C().sketchSegLen(a, b);
      if (len < 0.05) return;
      items.push({
        key: key + ':len',
        kind: 'len',
        text: String(r3(len)),
        value: len,
        at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        a, b, move: move || null, editable: !!editable,
      });
    };
    const pushAng = (prev, corner, next, key, editable, snap, move) => {
      const ang = C().sketchAngleBetween(C().sketchDir(prev, corner), C().sketchDir(corner, next));
      if (!(ang >= 0.5)) return;
      const d0 = C().sketchDir(prev, corner);
      const d1 = C().sketchDir(corner, next);
      const bis = C().sketchDir([0, 0], [d0[0] + d1[0], d0[1] + d1[1]]);
      // Keep the number off the vertex so it does not cover the point.
      const reach = Math.min(C().sketchSegLen(prev, corner), C().sketchSegLen(corner, next));
      const along = Math.max(6, Math.min(16, reach * 0.28));
      items.push({
        key: key + ':ang',
        kind: 'ang',
        text: Math.round(ang * 10) / 10 + '°',
        value: ang,
        at: [corner[0] + bis[0] * along, corner[1] + bis[1] * along],
        corner, prev, next, move: move || null, editable: !!editable, snap: !!snap,
      });
    };
    (this.sk.profiles || []).forEach((p, pi) => {
      if (p.k === 'rect') {
        const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.h / 2, y1 = p.y + p.h / 2;
        items.push({
          key: 'p' + pi + 's0:len', kind: 'len', text: String(r3(p.w)), value: p.w,
          at: [(x0 + x1) / 2, y0], rect: p, dim: 'w', editable: true,
        });
        items.push({
          key: 'p' + pi + 's1:len', kind: 'len', text: String(r3(p.h)), value: p.h,
          at: [x1, (y0 + y1) / 2], rect: p, dim: 'h', editable: true,
        });
      } else if (p.k === 'circle') {
        items.push({
          key: 'p' + pi + ':dia',
          kind: 'len',
          text: 'Ø ' + r3(p.r * 2),
          value: p.r * 2,
          at: [p.x, p.y + p.r],
          circle: p, editable: true,
        });
      } else if (p.k === 'path' || p.k === 'poly') {
        const pts = p.pts || [];
        const n = p.k === 'poly' ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          const i1 = (i + 1) % pts.length;
          const a = pts[i], b = pts[i1];
          // Move only this segment's end so a snapped outline point stays put.
          pushSeg(a, b, 'p' + pi + 's' + i, true, { kind: 'pts', pi, i0: i, i1 });
          if (i >= 1 || p.k === 'poly') {
            const iPrev = (i - 1 + pts.length) % pts.length;
            const prev = pts[iPrev];
            pushAng(prev, a, b, 'p' + pi + 'v' + i, true, Math.abs(C().sketchAngleBetween(C().sketchDir(prev, a), C().sketchDir(a, b)) - 90) < 0.6, { kind: 'pts', pi, iPrev, i0: i, i1 });
          }
        }
      }
    });
    const chain = this.sk.chain || [];
    for (let i = 1; i < chain.length; i++) {
      pushSeg(chain[i - 1], chain[i], 'c' + i, true, { kind: 'chain', i0: i - 1, i1: i });
      if (i >= 2) {
        const ang = C().sketchAngleBetween(C().sketchDir(chain[i - 2], chain[i - 1]), C().sketchDir(chain[i - 1], chain[i]));
        pushAng(chain[i - 2], chain[i - 1], chain[i], 'cv' + i, true, Math.abs(ang - 90) < 0.6, { kind: 'chain', iPrev: i - 2, i0: i - 1, i1: i });
      }
    }
    const live = this._liveSketchSeg();
    if (live) {
      pushSeg(live.a, live.b, 'live', true, { kind: 'live' });
      // Live angle stays in the measure bar so it does not cover the point.
    }
    const drag = this._skDrag && this._skDrag.moved ? this._skDrag : null;
    if (drag && this.sk.tool === 'rect') {
      pushSeg(drag.p0, [drag.p[0], drag.p0[1]], 'rw', false);
      pushSeg([drag.p[0], drag.p0[1]], drag.p, 'rh', false);
    } else if (drag && this.sk.tool === 'circle') {
      const rad = C().sketchSegLen(drag.p0, drag.p);
      items.push({
        key: 'rc',
        kind: 'len',
        text: 'Ø ' + r3(rad * 2),
        value: rad * 2,
        at: [drag.p0[0], drag.p0[1] + rad],
        editable: false,
      });
    }
    return items;
  };
  ModelEngine.prototype._clearSketchOverlay = function () {
    const host = this.root.querySelector('[data-skmeas]');
    if (host) host.innerHTML = '';
    this._skMeasMeta = null;
  };
  ModelEngine.prototype._syncSketchOverlay = function () {
    const host = this.root.querySelector('[data-skmeas]');
    if (!host || !this.sk || !this.renderer) { this._clearSketchOverlay(); return; }
    if (this._skDimEdit) return;
    const items = this._sketchMeasureList();
    this._skMeasMeta = new Map();
    const keep = new Set();
    for (const it of items) {
      const s = this._sketchScreen(it.at);
      if (!s) continue;
      keep.add(it.key);
      this._skMeasMeta.set(it.key, it);
      let el = host.querySelector('[data-skm="' + CSS.escape(it.key) + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'mdl-skm';
        el.dataset.skm = it.key;
        el.addEventListener('dblclick', (e) => {
          const meta = this._skMeasMeta && this._skMeasMeta.get(el.dataset.skm);
          if (!meta || !meta.editable) return;
          e.stopPropagation();
          e.preventDefault();
          this._openSketchMeasEdit(el);
        });
        el.addEventListener('pointerdown', (e) => {
          // Let a single press place sketch points under the label.
          if (el.classList.contains('editing')) e.stopPropagation();
        });
        host.appendChild(el);
      }
      // Only rewrite the label when the value changes. Setting text every frame
      // resets the node and cancels double-click.
      if (this._skDimEdit !== it.key && el.textContent !== it.text) el.textContent = it.text;
      el.classList.toggle('ang', it.kind === 'ang');
      el.classList.toggle('snap', !!it.snap || (it.kind === 'ang' && /90/.test(it.text)));
      el.style.left = s.x + 'px';
      el.style.top = s.y + 'px';
      el.hidden = false;
    }
    host.querySelectorAll('[data-skm]').forEach((el) => {
      if (el.dataset.skm === this._skDimEdit) return;
      if (!keep.has(el.dataset.skm)) el.remove();
    });
  };
  ModelEngine.prototype._dimArmEdit = function (e) {
    const el = e && e.target && e.target.closest && e.target.closest('.mdl-dim, .mdl-skm');
    if (!el || el.classList.contains('editing')) return;
    const now = performance.now();
    const prev = this._dimClickArm;
    const near = prev && prev.el === el && (now - prev.t) < 400
      && Math.hypot((e.clientX || 0) - prev.x, (e.clientY || 0) - prev.y) < 12;
    if (near) {
      this._dimClickArm = null;
      e.preventDefault();
      e.stopPropagation();
      if (el.classList.contains('mdl-skm')) this._openSketchMeasEdit(el);
      else this._openDimEdit(el);
      return;
    }
    this._dimClickArm = { el, t: now, x: e.clientX || 0, y: e.clientY || 0 };
  };
  ModelEngine.prototype._openSketchMeasEdit = function (el) {
    if (!el || el.querySelector('input') || !this._skMeasMeta) return;
    const meta = this._skMeasMeta.get(el.dataset.skm);
    if (!meta || !meta.editable) return;
    this._skDimEdit = el.dataset.skm;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = String(r3(meta.value));
    input.setAttribute('aria-label', meta.kind === 'ang' ? 'Angle' : 'Length');
    el.textContent = '';
    el.classList.add('editing');
    el.appendChild(input);
    input.focus();
    input.select();
    let closed = false;
    let live = false;
    setTimeout(() => { live = true; }, 250);
    const done = (commit) => {
      if (closed) return;
      closed = true;
      if (this._skDimEdit === el.dataset.skm) this._skDimEdit = null;
      el.classList.remove('editing');
      if (commit) this._commitSketchMeas(meta, input.value);
      else this._syncSketchOverlay();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => {
      if (this._skDimEdit !== el.dataset.skm) return;
      if (!live) { input.focus(); return; }
      done(true);
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  };
  ModelEngine.prototype._commitSketchMeas = function (meta, raw) {
    if (!this.sk || !meta) return;
    const v = evalNum(raw, meta.value);
    if (!(v >= 0)) { this._syncSketchOverlay(); return; }
    if (meta.circle) {
      meta.circle.r = r3(Math.max(0.05, v / 2));
      this._sketchDraw();
      return;
    }
    if (meta.rect && meta.dim) {
      meta.rect[meta.dim] = r3(Math.max(0.05, v));
      this._sketchDraw();
      return;
    }
    if (meta.kind === 'len' && meta.move) {
      this._applySketchMove(meta.move, 'len', v);
      this._sketchDraw();
      return;
    }
    if (meta.kind === 'ang' && meta.move) {
      this._applySketchMove(meta.move, 'ang', v);
      this._sketchDraw();
    }
  };
  // Apply the edit only to the segment that was labeled. A cut snapped onto the
  // face outline shares coordinates, so a global rewrite would move the outline too.
  ModelEngine.prototype._applySketchMove = function (move, kind, value) {
    if (!this.sk || !move) return;
    if (move.kind === 'live') {
      const live = this._liveSketchSeg();
      if (!live) return;
      const next = kind === 'ang'
        ? C().sketchSetAngle(live.a, this._lastSketchDir(), value * Math.sign(live.angle || 1) || value, live.len)
        : C().sketchSetSegLen(live.a, live.b, value);
      const p = [r3(next[0]), r3(next[1])];
      this.sk.hover = p;
      if (this._skDrag) { this._skDrag.p = p; this._skDrag.moved = true; }
      this.sk.guide = { point: p, snapped: true, kind: 'edit', angle: kind === 'ang' ? value : (live.angle || 0) };
      return;
    }
    if (move.kind === 'chain') {
      const pts = this.sk.chain;
      if (!pts || pts[move.i0] == null || pts[move.i1] == null) return;
      const next = kind === 'ang'
        ? C().sketchEditAngle(pts, move.iPrev, move.i0, move.i1, value)
        : C().sketchEditSegLen(pts, move.i0, move.i1, value);
      this.sk.chain = next;
      return;
    }
    if (move.kind === 'pts') {
      const prof = this.sk.profiles && this.sk.profiles[move.pi];
      if (!prof || !prof.pts) return;
      prof.pts = kind === 'ang'
        ? C().sketchEditAngle(prof.pts, move.iPrev, move.i0, move.i1, value)
        : C().sketchEditSegLen(prof.pts, move.i0, move.i1, value);
    }
  };
  ModelEngine.prototype._measureEdge = function (edge, world) {
    const T = this.T;
    const place = (p) => {
      if (!p) return [0, 0, 0];
      if (!world || !T) return [p[0] || 0, p[1] || 0, p[2] || 0];
      const v = new T.Vector3(p[0] || 0, p[1] || 0, p[2] || 0).applyMatrix4(world);
      return [v.x, v.y, v.z];
    };
    return C().drawnMeasure(edge, place);
  };
  ModelEngine.prototype._faceDimText = function (face, world) {
    const edges = face && face.exact && face.exact[0] && face.exact[0].edges;
    if (!edges || !edges.length) return 'Face';
    const measures = edges.map((e) => this._measureEdge(Object.assign({ faces: [face] }, e), world)).filter(Boolean);
    if (measures.length === 1 && measures[0].kind === 'diameter') return 'Ø ' + r3(measures[0].value);
    const lens = [];
    for (const m of measures) {
      if (m.kind !== 'length') continue;
      if (!lens.some((u) => Math.abs(u - m.value) < 0.05)) lens.push(m.value);
    }
    if (lens.length === 1) return r3(lens[0]) + ' × ' + r3(lens[0]);
    if (lens.length === 2) return r3(Math.max(lens[0], lens[1])) + ' × ' + r3(Math.min(lens[0], lens[1]));
    return 'Face';
  };
  ModelEngine.prototype._edgeAxis = function (edge) {
    if (!edge || edge.k === 'circle' || !edge.a || !edge.b) return 0;
    const d = [edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], (edge.b[2] || 0) - (edge.a[2] || 0)];
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    if (ax >= ay && ax >= az) return 0;
    if (ay >= az) return 1;
    return 2;
  };
  ModelEngine.prototype._alignedAxis = function (dir) {
    const len = Math.hypot(dir[0] || 0, dir[1] || 0, dir[2] || 0) || 1;
    const a = [Math.abs(dir[0] || 0) / len, Math.abs(dir[1] || 0) / len, Math.abs(dir[2] || 0) / len];
    const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : (a[1] >= a[2] ? 1 : 2);
    return a[i] > 0.98 ? i : -1;
  };
  ModelEngine.prototype._worldPerPx = function (at) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cam = this.camera;
    if (this.isOrtho) return ((cam.top - cam.bottom) / (cam.zoom || 1)) / Math.max(1, rect.height);
    const dist = Math.max(1e-3, cam.position.distanceTo(at));
    return 2 * dist * Math.tan((cam.fov * Math.PI / 180) / 2) / Math.max(1, rect.height);
  };
  ModelEngine.prototype._openDimEdit = function (el) {
    if (!el || el.querySelector('input')) return;
    const meta = this._dimMeta && this._dimMeta.get(el.dataset.dim);
    if (!meta) return;
    this._dimEdit = el.dataset.dim;
    this._dimShown = meta.id;
    this._dimHold = meta.id;
    if (this._dimTimer) { clearTimeout(this._dimTimer); this._dimTimer = null; }
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = String(r3(meta.measure));
    input.setAttribute('aria-label', 'Dimension');
    el.textContent = '';
    el.classList.add('editing');
    el.appendChild(input);
    input.focus();
    input.select();
    let closed = false;
    let live = false;
    setTimeout(() => { live = true; }, 250);
    const done = (commit) => {
      if (closed) return;
      closed = true;
      if (this._dimEdit === el.dataset.dim) this._dimEdit = null;
      el.classList.remove('editing');
      this._dimHold = null;
      this._armDimHide();
      if (commit) this._commitDim(meta, input.value);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => {
      if (this._dimEdit !== el.dataset.dim) return;
      if (!live) { input.focus(); return; }
      done(true);
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  };
  ModelEngine.prototype._dropBuilt = function (obj) {
    C().dropBuiltCache(obj);
    if (obj) delete this._shapeSigs[obj.id];
  };
  ModelEngine.prototype._commitDim = function (meta, raw) {
    const obj = meta && this._obj(meta.id);
    const next = evalNum(raw, meta && meta.measure);
    if (!obj || !(next >= 0.1) || !(meta.measure > 1e-6)) return;
    if (Math.abs(next - meta.measure) < 0.05) return;
    const rebuild = () => {
      this._dropBuilt(obj);
      this._renderList();
      this._renderInsp();
      this._changed();
      this._requestBuild();
    };
    if (meta.circle) this._commitRound(obj, meta, next, rebuild);
    else this._commitLength(obj, meta, next, rebuild);
  };
  // A dimension edit always changes every parallel edge. A plain box or
  // cylinder has one size for that direction, so that size changes. Any body
  // that is no longer a plain primitive gets a parallel length feature.
  ModelEngine.prototype._commitLength = function (obj, meta, next, rebuild) {
    const edge = meta.edge;
    if (!edge || !edge.a || !edge.b) { this._toast('That edge could not be changed.'); return; }
    const dir = [edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], (edge.b[2] || 0) - (edge.a[2] || 0)];
    const delta = C().lengthDelta(meta.measure, next, dir, obj.scale);
    if (Math.abs(delta) < 0.05) return;
    const plain = !((obj.features || []).length);
    const axis = this._alignedAxis(dir);
    if (plain && axis >= 0 && obj.type === 'box' && obj.size) {
      const k = 'xyz'[axis];
      obj.size[k] = r3(Math.max(0.1, obj.size[k] + delta));
      rebuild();
      return;
    }
    if (plain && axis === 2 && obj.type === 'cylinder' && obj.size) {
      obj.size.z = r3(Math.max(0.1, obj.size.z + delta));
      rebuild();
      return;
    }
    if (plain && axis === 2 && obj.type === 'sketch') {
      const sign = obj.height < 0 ? -1 : 1;
      obj.height = r3(sign * Math.max(0.001, Math.abs(obj.height) + delta));
      rebuild();
      return;
    }
    const at = edge.a.map((v, i) => (v + (edge.b[i] || 0)) / 2);
    obj.features = obj.features || [];
    obj.features.push({
      op: 'length',
      scope: 'parallel',
      at: at.map((v) => r3(v)),
      a: [r3(edge.a[0]), r3(edge.a[1]), r3(edge.a[2] || 0)],
      b: [r3(edge.b[0]), r3(edge.b[1]), r3(edge.b[2] || 0)],
      dir: dir.map((v) => r3(v)),
      delta: r3(delta),
    });
    rebuild();
  };
  ModelEngine.prototype._loopSamples = function (pts, count) {
    const src = pts || [];
    if (src.length <= count) return src.map((p) => p.slice());
    const out = [];
    for (let i = 0; i < count; i++) out.push(src[Math.round(i * (src.length - 1) / (count - 1))].slice());
    return out;
  };
  ModelEngine.prototype._commitRound = function (obj, meta, next, rebuild) {
    const factor = next / meta.measure;
    if (Math.abs(factor - 1) < 1e-4) return;
    const plain = !((obj.features || []).length);
    if (plain && obj.type === 'cylinder' && obj.size) {
      obj.size.d = r3(Math.max(0.1, obj.size.d * factor));
      rebuild();
      return;
    }
    if (plain && obj.type === 'sphere' && obj.size) {
      obj.size.d = r3(Math.max(0.1, obj.size.d * factor));
      rebuild();
      return;
    }
    const slot = this.objs[obj.id];
    const world = slot && this._shapeMatrix(slot);
    const loops = [];
    let dir = null;
    for (const edge of this._bodyEdges(obj.id)) {
      const pts = this._roundLocal(edge);
      if (!pts || pts.length < 8) continue;
      if (!world || !this._drawnRound(edge, world)) continue;
      const n = C().planeNormal(pts);
      if (!n) continue;
      if (!dir) dir = n;
      else if (!C().sameDirection(n, dir)) continue;
      loops.push(this._loopSamples(pts, 24));
    }
    if (!loops.length || !dir) { this._toast('That edge could not be changed.'); return; }
    const anchor = meta.edge.c || meta.edge.mid || meta.edge.at || [0, 0, 0];
    obj.features = obj.features || [];
    obj.features.push({
      op: 'length',
      round: true,
      scope: 'parallel',
      at: anchor.slice(0, 3).map((v) => r3(v)),
      dir: dir.map((v) => r3(v)),
      factor: Math.round(factor * 10000) / 10000,
      loops,
    });
    rebuild();
  };
  // Points around a circle, in the circle's own plane. Offset along X is the
  // axis of a circle that stands on its side, so that point is not on the edge.
  ModelEngine.prototype._circlePts = function (edge) {
    const c = edge.c || [0, 0, 0];
    const r = edge.r || 0;
    let n = edge.n;
    if (!n && edge.faces) {
      const face = edge.faces.find((f) => f.normal);
      if (face) n = face.normal;
    }
    if (!n) n = [0, 0, 1];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let x = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([
        c[0] + r * (ca * x[0] + sa * y[0]),
        c[1] + r * (ca * x[1] + sa * y[1]),
        (c[2] || 0) + r * (ca * x[2] + sa * y[2]),
      ]);
    }
    return pts;
  };
  ModelEngine.prototype._worldLen = function (pts, world, close) {
    const T = this.T;
    let sum = 0;
    let prev = null;
    for (const p of pts || []) {
      const w = new T.Vector3(p[0], p[1], p[2] || 0).applyMatrix4(world);
      if (prev) sum += prev.distanceTo(w);
      prev = w;
    }
    if (close && prev && pts.length > 2) {
      const a = new T.Vector3(pts[0][0], pts[0][1], pts[0][2] || 0).applyMatrix4(world);
      sum += prev.distanceTo(a);
    }
    return sum;
  };
  // Points on a circular edge in the body frame: a full circle, an arc, or a
  // curve that may only be part of the circle. A circle split into arcs is
  // still that circle.
  ModelEngine.prototype._roundLocal = function (edge) {
    if (!edge) return null;
    if (edge.k === 'circle' && edge.c && edge.r) return this._circlePts(edge);
    if (edge.k === 'arc' && edge.a && edge.mid && edge.b) return this._arcPts(edge);
    if ((edge.k === 'curve' || edge.pts) && edge.pts && edge.pts.length >= 8) return edge.pts;
    return null;
  };
  ModelEngine.prototype._arcPts = function (edge) {
    const hit = this._circum3(edge.a, edge.mid, edge.b);
    if (!hit || !(hit.r > 0.05)) return null;
    const n = hit.n;
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn = [n[0] / nl, n[1] / nl, n[2] / nl];
    const ref = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let x = [ref[1] * nn[2] - ref[2] * nn[1], ref[2] * nn[0] - ref[0] * nn[2], ref[0] * nn[1] - ref[1] * nn[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [nn[1] * x[2] - nn[2] * x[1], nn[2] * x[0] - nn[0] * x[2], nn[0] * x[1] - nn[1] * x[0]];
    const ang = (p) => {
      const v = this._sub3(p, hit.c);
      return Math.atan2(this._dot3(v, y), this._dot3(v, x));
    };
    const wrap = (d) => {
      let t = d;
      while (t <= -Math.PI) t += Math.PI * 2;
      while (t > Math.PI) t -= Math.PI * 2;
      return t;
    };
    const a0 = ang(edge.a);
    let sweep = wrap(ang(edge.b) - a0);
    const via = wrap(ang(edge.mid) - a0);
    if (sweep * via < 0) sweep += sweep > 0 ? -Math.PI * 2 : Math.PI * 2;
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const t = a0 + sweep * i / 11;
      const ca = Math.cos(t), sa = Math.sin(t);
      pts.push([
        hit.c[0] + hit.r * (ca * x[0] + sa * y[0]),
        hit.c[1] + hit.r * (ca * x[1] + sa * y[1]),
        (hit.c[2] || 0) + hit.r * (ca * x[2] + sa * y[2]),
      ]);
    }
    return pts;
  };
  // Diameter of a round edge after the same scale and turn that draw the body.
  // A stretched body stores the cutter's circle as an ellipse, then draws it
  // round again. An arc is the same circle, so it gets that drawn diameter.
  ModelEngine.prototype._drawnRound = function (edge, world) {
    const T = this.T;
    const pts = this._roundLocal(edge);
    if (!pts) return null;
    const w = pts.map((p) => new T.Vector3(p[0], p[1], p[2] || 0).applyMatrix4(world));
    const fit = C().fitCircle(w.map((p) => [p.x, p.y, p.z]));
    if (!fit) return null;
    const center = new T.Vector3(fit.c[0], fit.c[1], fit.c[2]);
    const axis = w[0].clone().sub(center);
    if (axis.lengthSq() < 1e-8) return null;
    axis.setLength(fit.r);
    const normal = new T.Vector3(fit.n[0], fit.n[1], fit.n[2]);
    if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
    return { d: fit.d, a: center.clone().sub(axis), b: center.clone().add(axis), dir: normal.normalize(), samples: w, center };
  };
  ModelEngine.prototype._layoutDims = function () {
    const host = this.root.querySelector('[data-dims]');
    if (!host || !this.camera || !this.renderer || !this.T) return;
    const T = this.T;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let svg = host.querySelector('.mdl-dimsvg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'mdl-dimsvg');
      host.prepend(svg);
    }
    svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
    const editing = this._dimEdit && this._dimMeta ? this._dimMeta.get(this._dimEdit) : null;
    const shown = new Set();
    for (const o of this.data.objects) if (o.dims !== false && !o.hidden) shown.add(o.id);
    if (editing && editing.id) shown.add(editing.id);
    if (this.sk || !shown.size) {
      svg.textContent = '';
      host.querySelectorAll('[data-dim]').forEach((el) => {
        if (editing && el.dataset.dim === this._dimEdit) return;
        el.remove();
      });
      return;
    }
    const items = [];
    const meshes = [];
    for (const o of this.data.objects) {
      if (o.hidden) continue;
      const slot = this.objs[o.id];
      if (slot && slot.mesh && slot.group.visible) meshes.push(slot.mesh);
    }
    const worldNormal = (world, n) => new T.Vector3(n[0], n[1], n[2] || 0).transformDirection(world).normalize();
    for (const o of this.data.objects) {
      if (o.hidden || !shown.has(o.id)) continue;
      const slot = this.objs[o.id];
      if (!slot || !slot.group.visible || !slot.mesh.geometry) continue;
      const world = this._shapeMatrix(slot);
      const center = slot.group.getWorldPosition(new T.Vector3());
      const groups = new Map();
      for (const edge of this._bodyEdges(o.id)) {
        let worldA;
        let worldB;
        let dir;
        let text;
        let circle = false;
        let curveLen = null;
        const round = this._drawnRound(edge, world);
        let samples = null;
        if (round) {
          circle = true;
          worldA = round.a;
          worldB = round.b;
          dir = round.dir;
          samples = round.samples;
          text = 'Ø ' + r3(round.d);
        } else if (edge.k === 'curve' && edge.pts && edge.pts.length >= 2 && edge.len > 0.2) {
          const p0 = edge.pts[0];
          const plast = edge.pts[edge.pts.length - 1];
          const pmid = edge.pts[Math.floor(edge.pts.length / 2)];
          const closed = Math.hypot(plast[0] - p0[0], plast[1] - p0[1], (plast[2] || 0) - (p0[2] || 0)) < Math.max(0.5, edge.len * 0.08);
          const start = closed ? p0 : (edge.a || p0);
          const end = closed ? pmid : (edge.b || plast);
          worldA = new T.Vector3(start[0], start[1], start[2] || 0).applyMatrix4(world);
          worldB = new T.Vector3(end[0], end[1], end[2] || 0).applyMatrix4(world);
          dir = worldB.clone().sub(worldA);
          if (dir.lengthSq() < 1e-8) continue;
          curveLen = this._worldLen(edge.pts, world, closed);
          text = String(r3(curveLen));
        } else if (edge.a && edge.b) {
          worldA = new T.Vector3(edge.a[0], edge.a[1], edge.a[2] || 0).applyMatrix4(world);
          worldB = new T.Vector3(edge.b[0], edge.b[1], edge.b[2] || 0).applyMatrix4(world);
          dir = worldB.clone().sub(worldA);
          if (dir.lengthSq() < 1e-8) continue;
          text = String(r3(worldA.distanceTo(worldB)));
        } else continue;
        let measure = round ? round.d : (curveLen != null ? curveLen : worldA.distanceTo(worldB));
        const measured = this._measureEdge(edge, world);
        if (measured && measured.value > 0) {
          measure = measured.value;
          if (measured.kind === 'diameter') {
            circle = true;
            text = 'Ø ' + r3(measure);
          } else if (!circle) text = String(r3(measure));
        }
        if (measure < 0.2) continue;
        // Straight edges of one length share a label. Each circle keeps its own,
        // so both rims of a cylinder are labeled and arcs of one circle share one.
        const sig = C().dimGroupKey(
          measure,
          [dir.x, dir.y, dir.z],
          round ? [round.center.x, round.center.y, round.center.z] : null
        );
        if (!sig) continue;
        let list = groups.get(sig);
        if (!list) { list = []; groups.set(sig, list); }
        list.push({ edge, worldA, worldB, dir, text, measure, circle, samples, id: o.id, axis: this._edgeAxis(edge) });
      }
      groups.forEach((list) => {
        const cands = list.map((item) => {
          const mid = item.worldA.clone().add(item.worldB).multiplyScalar(0.5);
          const facing = (item.edge.faces || []).some((face) => face.normal && this._seesCamera(worldNormal(world, face.normal), mid));
          const probes = item.samples && item.samples.length ? item.samples : [mid, item.worldA, item.worldB];
          return { item, mid, key: item.edge.key, facing, open: probes.some((p) => this._openToCamera(p, meshes)) };
        });
        const picked = C().pickDim(cands);
        const chosen = picked == null ? null : cands.find((c) => c.key === picked);
        if (!chosen) return;
        const item = chosen.item;
        const mid = chosen.mid;
        const edgeDir = item.worldB.clone().sub(item.worldA);
        let off = mid.clone().sub(center);
        if (edgeDir.lengthSq() > 1e-8) off.addScaledVector(edgeDir, -off.dot(edgeDir) / edgeDir.lengthSq());
        if (off.lengthSq() < 1e-6) {
          const face = (item.edge.faces || []).find((f) => f.normal);
          off = face ? worldNormal(world, face.normal) : new T.Vector3(0, 0, 1);
        }
        off.normalize();
        const gap = item.circle ? 0 : 22 * this._worldPerPx(mid);
        const past = item.circle ? 0 : 6 * this._worldPerPx(mid);
        item.dimA = item.worldA.clone().addScaledVector(off, gap);
        item.dimB = item.worldB.clone().addScaledVector(off, gap);
        item.extA = item.dimA.clone().addScaledVector(off, past);
        item.extB = item.dimB.clone().addScaledVector(off, past);
        item.at = item.dimA.clone().add(item.dimB).multiplyScalar(0.5);
        item.key = item.edge.key;
        item.text = item.circle ? 'Ø ' + r3(item.measure) : String(r3(item.measure));
        items.push(item);
      });
    }
    items.sort((a, b) => b.measure - a.measure || (a.key < b.key ? -1 : 1));
    const placed = [];
    const visible = [];
    const project = (v) => {
      const p = v.clone().project(this.camera);
      return {
        x: (p.x * 0.5 + 0.5) * rect.width,
        y: (-p.y * 0.5 + 0.5) * rect.height,
        ok: p.z >= -1 && p.z <= 1,
      };
    };
    for (const it of items) {
      const a = project(it.dimA);
      const b = project(it.dimB);
      const m = project(it.at);
      if (!a.ok || !b.ok || !m.ok) continue;
      if (m.x < 0 || m.y < 0 || m.x > rect.width || m.y > rect.height) continue;
      const hw = Math.max(18, it.text.length * 3.4 + 10);
      const hh = 14;
      if (placed.some((q) => Math.abs(q.x - m.x) < q.hw + hw && Math.abs(q.y - m.y) < q.hh + hh)) continue;
      placed.push({ x: m.x, y: m.y, hw, hh });
      visible.push({ it, x: m.x, y: m.y, a, b, ea: project(it.worldA), eb: project(it.worldB), xa: project(it.extA), xb: project(it.extB) });
    }
    const arrow = (tip, ux, uy) => {
      const L = Math.hypot(ux, uy) || 1;
      const x = ux / L, y = uy / L;
      const s = 5.5, w = 1.8;
      const bx = tip.x - x * s, by = tip.y - y * s;
      return tip.x.toFixed(1) + ',' + tip.y.toFixed(1) + ' ' + (bx - y * w).toFixed(1) + ',' + (by + x * w).toFixed(1) + ' ' + (bx + y * w).toFixed(1) + ',' + (by - x * w).toFixed(1);
    };
    const line = (p, q) => '<line class="mdl-dimline" x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '"/>';
    const parts = [];
    for (const row of visible) {
      const a = row.a, b = row.b;
      const dx = b.x - a.x, dy = b.y - a.y;
      const span = Math.hypot(dx, dy) || 1;
      const ux = dx / span, uy = dy / span;
      const outside = span < 42;
      if (!row.it.circle) {
        parts.push('<line class="mdl-ext" x1="' + row.ea.x.toFixed(1) + '" y1="' + row.ea.y.toFixed(1) + '" x2="' + row.xa.x.toFixed(1) + '" y2="' + row.xa.y.toFixed(1) + '"/>');
        parts.push('<line class="mdl-ext" x1="' + row.eb.x.toFixed(1) + '" y1="' + row.eb.y.toFixed(1) + '" x2="' + row.xb.x.toFixed(1) + '" y2="' + row.xb.y.toFixed(1) + '"/>');
      }
      const gap = Math.min(span * 0.42, Math.max(26, row.it.text.length * 6.8));
      if (!outside && span > gap + 14) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const h = gap / 2;
        parts.push(line(a, { x: mx - ux * h, y: my - uy * h }));
        parts.push(line({ x: mx + ux * h, y: my + uy * h }, b));
      } else if (outside) {
        const pad = 12;
        parts.push(line({ x: a.x - ux * pad, y: a.y - uy * pad }, { x: b.x + ux * pad, y: b.y + uy * pad }));
      } else parts.push(line(a, b));
      if (outside) {
        parts.push('<polygon class="mdl-arrow" points="' + arrow(a, ux, uy) + '"/>');
        parts.push('<polygon class="mdl-arrow" points="' + arrow(b, -ux, -uy) + '"/>');
      } else {
        parts.push('<polygon class="mdl-arrow" points="' + arrow(a, -ux, -uy) + '"/>');
        parts.push('<polygon class="mdl-arrow" points="' + arrow(b, ux, uy) + '"/>');
      }
    }
    svg.innerHTML = parts.join('');
    this._dimMeta = new Map(visible.map((row) => [row.it.key, row.it]));
    const keep = new Set(visible.map((row) => row.it.key));
    for (const row of visible) {
      const it = row.it;
      let el = host.querySelector('[data-dim="' + CSS.escape(it.key) + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'mdl-dim';
        el.dataset.dim = it.key;
        el.dataset.body = it.id;
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this._openDimEdit(el);
        });
        el.addEventListener('pointerdown', (e) => {
          if (el.classList.contains('editing')) e.stopPropagation();
        });
        el.addEventListener('pointerenter', () => {
          this._dimHold = el.dataset.body;
          this._dimShown = el.dataset.body;
          if (this._dimTimer) { clearTimeout(this._dimTimer); this._dimTimer = null; }
        });
        el.addEventListener('pointerleave', () => {
          if (this._dimEdit) return;
          if (this._dimHold === el.dataset.body) this._dimHold = null;
          this._armDimHide();
        });
        host.appendChild(el);
      }
      if (this._dimEdit !== it.key && el.textContent !== it.text) el.textContent = it.text;
      el.hidden = false;
      el.style.left = row.x + 'px';
      el.style.top = row.y + 'px';
      // Keep values upright; measure lines already show the edge direction.
      el.style.transform = 'translate(-50%, -50%)';
    }
    host.querySelectorAll('[data-dim]').forEach((el) => {
      if (el.dataset.dim === this._dimEdit) return;
      if (!keep.has(el.dataset.dim)) el.remove();
    });
  };
  ModelEngine.prototype._sketchDone = function () {
    if (!this.sk) return;
    if (this.sk.chain.length >= 3) this._sketchClose();
    else if (this.sk.chain.length >= 2) {
      this.sk.profiles.push({ k: 'path', pts: this.sk.chain.map((p) => p.slice()) });
      this.sk.chain = [];
    }
    if (this.sk.source && this.sk.base) {
      const added = this.sk.profiles.slice(this.sk.base).filter((p) => p.k !== 'path');
      const same = this._profileKey(this.sk.profiles[0]) === this.sk.outlineKey;
      if (same && !added.length) {
        const hIn = this.root.querySelector('[data-skh]');
        this._extrudeSourceFace(evalNum(hIn && hIn.value, 1));
        return;
      }
      if (same) this.sk.profiles = this.sk.profiles.slice(this.sk.base);
    }
    if (!this.sk.profiles.some((p) => p.k !== 'path')) { this._toast('Draw a closed shape to extrude.'); return; }
    const hIn = this.root.querySelector('[data-skh]');
    let height = evalNum(hIn && hIn.value, 1);
    if (Math.abs(height) < 0.001) height = height < 0 ? -0.001 : 0.001;
    const plane = this.sk.plane;
    const T = this.T;
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    const m = new T.Matrix4().makeBasis(plane.xDir, y, plane.normal);
    const eu = new T.Euler().setFromRotationMatrix(m, 'ZYX');
    const pos = [r3(plane.origin.x), r3(plane.origin.y), r3(plane.origin.z)];
    const rot = [r3(eu.x / DEG), r3(eu.y / DEG), r3(eu.z / DEG)];
    if (this.sk.editId) {
      const cur = this._obj(this.sk.editId);
      if (!cur) { this._sketchCancel(); return; }
      cur.profiles = this.sk.profiles;
      cur.height = r3(height);
      cur.pos = pos;
      cur.rot = rot;
      this._dropBuilt(cur);
      this.sel = cur.id;
      this.multi = [cur.id];
      this._sketchCancel();
      if (this.objs[cur.id]) this._place(this.objs[cur.id], cur);
      this._renderList();
      this._renderInsp();
      this._syncGizmo();
      this._changed();
      this._requestBuild();
      return;
    }
    const names = new Set(this.data.objects.map((o) => o.name));
    let name = 'Sketch', i = 2;
    while (names.has(name)) { name = 'Sketch ' + i; i++; }
    const obj = C().normObject({
      name, kernel: 'brep', type: 'sketch', height: r3(height), profiles: this.sk.profiles,
      pos, rot,
      features: [],
    });
    this.data.objects.push(obj);
    this.sel = obj.id;
    this.multi = [obj.id];
    this._sketchCancel();
    this._preview(obj);
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._changed();
    this._requestBuild();
  };
  ModelEngine.prototype._profileKey = function (p) {
    return JSON.stringify(p || null);
  };
  // The outline is the face. Extruding a rebuilt copy of it, in either
  // direction, leaves the original curve behind. Grow or cut the face itself.
  ModelEngine.prototype._extrudeSourceFace = function (height) {
    const src = this.sk && this.sk.source;
    const obj = src && this._obj(src.id);
    if (!obj || !src.loop || src.loop.length < 3) { this._toast('This face cannot be extruded exactly.'); return; }
    if (Math.abs(height) < 0.05) { this._toast('Use a length of at least 0.05 mm.'); return; }
    obj.features.push({
      op: 'push',
      loop: src.loop.map((p) => p.slice()),
      normal: src.normal.slice(),
      center: src.center.slice(),
      dist: r3(height),
      exact: true,
    });
    this._dropBuilt(obj);
    const id = obj.id;
    this._sketchCancel();
    this.sel = id;
    this.multi = [id];
    if (!this.faceOn) this._faceToggle(true);
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._changed();
    this._requestBuild();
    this._toast(height < 0 ? 'The face is cut.' : 'The face is extruded.');
  };
  ModelEngine.prototype._sketchSourceBar = function () {
    const split = this.root.querySelector('[data-sksplit]');
    const done = this.root.querySelector('[data-skdone]');
    const on = !!(this.sk && this.sk.source);
    if (split) split.classList.toggle('hidden', !on);
    if (done) done.textContent = on ? 'Extrude' : 'Done';
  };
  // Sketch points are on the world plane. The solid's faces are in the body's
  // own frame, which is the inverse of the shape on screen.
  ModelEngine.prototype._sketchLocal = function (p) {
    const T = this.T;
    const plane = this.sk && this.sk.plane;
    const slot = this.sk && this.sk.source && this.objs[this.sk.source.id];
    if (!plane || !slot) return null;
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    if (y.lengthSq() < 1e-8) return null;
    const world = plane.origin.clone().addScaledVector(plane.xDir, p[0]).addScaledVector(y, p[1]);
    const inv = new T.Matrix4().copy(this._shapeMatrix(slot)).invert();
    world.applyMatrix4(inv);
    return [r3(world.x), r3(world.y), r3(world.z)];
  };
  ModelEngine.prototype._sketchCuts = function () {
    const cuts = [];
    const profiles = this.sk.profiles.slice(this.sk.base || 0);
    if (this.sk.chain.length >= 2) profiles.push({ k: 'path', pts: this.sk.chain.map((p) => p.slice()) });
    for (const p of profiles) {
      if (p.k === 'path' || p.k === 'poly') {
        const pts = (p.pts || []).map((q) => this._sketchLocal(q)).filter(Boolean);
        if (pts.length >= 2) cuts.push({ k: 'poly', pts, ...(p.k === 'poly' ? { closed: true } : {}) });
      } else if (p.k === 'rect') {
        const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.h / 2, y1 = p.y + p.h / 2;
        const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => this._sketchLocal(q)).filter(Boolean);
        if (pts.length === 4) cuts.push({ k: 'poly', pts, closed: true });
      } else if (p.k === 'circle') {
        const c = this._sketchLocal([p.x, p.y]);
        const edge = this._sketchLocal([p.x + p.r, p.y]);
        if (!c || !edge) continue;
        const rad = Math.hypot(edge[0] - c[0], edge[1] - c[1], edge[2] - c[2]);
        if (rad >= 0.05) cuts.push({ k: 'circle', c, r: r3(rad) });
      }
    }
    return cuts;
  };
  ModelEngine.prototype._sketchSplit = function () {
    if (!this.sk || !this.sk.source) return;
    const cuts = this._sketchCuts();
    if (!cuts.length) { this._toast('Draw a line, rectangle, or circle across the face.'); return; }
    const obj = this._obj(this.sk.source.id);
    if (!obj) { this._toast('That body is gone.'); this._sketchCancel(); return; }
    const id = obj.id;
    obj.features.push({
      op: 'imprint',
      center: this.sk.source.center.slice(),
      normal: this.sk.source.normal.slice(),
      cuts,
    });
    this._dropBuilt(obj);
    this._sketchCancel();
    this.sel = id;
    this.multi = [id];
    if (!this.faceOn) this._faceToggle(true);
    this._renderList();
    this._renderInsp();
    this._syncGizmo();
    this._changed();
    this._requestBuild();
    this._toast('The face is split. Tap a region and extrude it in or out.');
  };
  ModelEngine.prototype._sketchEscape = function () {
    if (!this.sk) return;
    if (this._skDrag) {
      this._skDrag = null;
      this._freeNav();
      this._sketchDraw();
      return;
    }
    if (this.sk.chain.length) {
      this.sk.chain.pop();
      this._sketchDraw();
      return;
    }
    if (this.sk.profiles.length > (this.sk.base || 0)) {
      this.sk.profiles.pop();
      this._syncSketchDims();
      this._sketchDraw();
    }
  };
  ModelEngine.prototype._sketchCancel = function () {
    this.sk = null;
    this._skDrag = null;
    this._skDimEdit = null;
    const bar = this.root.querySelector('[data-skbar]');
    if (bar) bar.classList.add('hidden');
    if (this._skLines) { this.scene.remove(this._skLines); this._skLines.geometry.dispose(); this._skLines = null; }
    this._clearSketchOverlay();
    this._sketchSourceBar();
    this._freeNav();
    this._syncGizmo();
  };

  ModelEngine.prototype._join = function () {
    if (this.sk) this._sketchCancel();
    if (this.faceOn) this._faceToggle();
    if (this.multi.length < 2) {
      this._setAdding(true);
      this._toast('Select more bodies, then tap Join bodies.');
      return;
    }
    const ids = this.multi.slice();
    const parts = ids.map((id) => this._obj(id)).filter(Boolean);
    const mesh = parts.some((p) => p.kernel === 'mesh' || p.type === 'mesh');
    const names = new Set(this.data.objects.map((o) => o.name));
    let name = 'Joined', i = 2;
    while (names.has(name)) { name = 'Joined ' + i; i++; }
    const join = C().normObject({
      name, kernel: mesh ? 'mesh' : 'brep', type: 'join', pos: [0, 0, 0], rot: [0, 0, 0], features: [], parts,
    });
    const drop = new Set(ids);
    this.data.objects = this.data.objects.filter((o) => !drop.has(o.id));
    this.data.objects.push(join);
    this.sel = join.id;
    this.multi = [join.id];
    this._setAdding(false);
    this._renderList();
    this._renderInsp();
    this._changed();
    this._requestBuild();
  };

  ModelEngine.prototype._toggleExportMenu = function () {
    const menu = this.root.querySelector('[data-exportmenu]');
    const btn = this.root.querySelector('[data-export]');
    if (!menu || !btn) return;
    const open = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    if (open) {
      const hide = (e) => {
        if (e && e.target && (menu.contains(e.target) || btn.contains(e.target))) return;
        this._hideExportMenu();
        window.removeEventListener('pointerdown', hide, true);
      };
      window.addEventListener('pointerdown', hide, true);
    }
  };
  ModelEngine.prototype._hideExportMenu = function () {
    const menu = this.root.querySelector('[data-exportmenu]');
    const btn = this.root.querySelector('[data-export]');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.classList.remove('on');
  };
  ModelEngine.prototype._exportIds = function () {
    if (this.multi.length) return this.multi.slice();
    if (this.sel) return [this.sel];
    return (this.data.objects || []).filter((o) => o && !o.hidden).map((o) => o.id);
  };
  ModelEngine.prototype._meshFromSlot = function (slot) {
    const T = this.T;
    if (!T || !slot || !slot.mesh || !slot.mesh.geometry) return null;
    slot.group.updateMatrixWorld(true);
    const g = slot.mesh.geometry;
    const pos = g.getAttribute('position');
    if (!pos || pos.count < 3) return null;
    const vertices = [];
    const triangles = [];
    const v = new T.Vector3();
    const m = slot.mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      vertices.push(r3(v.x), r3(v.y), r3(v.z));
    }
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) triangles.push(idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) triangles.push(i);
    }
    return triangles.length >= 3 ? { vertices, triangles } : null;
  };
  ModelEngine.prototype._collectExportMesh = function (ids) {
    const vertices = [];
    const triangles = [];
    for (const id of ids || []) {
      const obj = this._obj(id);
      const slot = this.objs[id];
      if (!obj || obj.hidden || !slot) continue;
      const part = this._meshFromSlot(slot);
      if (!part) continue;
      const base = vertices.length / 3;
      for (let i = 0; i < part.vertices.length; i++) vertices.push(part.vertices[i]);
      for (let i = 0; i < part.triangles.length; i++) triangles.push(base + part.triangles[i]);
    }
    return triangles.length >= 3 ? { vertices, triangles } : null;
  };
  ModelEngine.prototype._collectExportParts = function (ids) {
    const parts = [];
    for (const id of ids || []) {
      const obj = this._obj(id);
      const slot = this.objs[id];
      if (!obj || obj.hidden || !slot) continue;
      const mesh = this._meshFromSlot(slot);
      if (!mesh) continue;
      parts.push({ name: obj.name || ('Body ' + (parts.length + 1)), vertices: mesh.vertices, triangles: mesh.triangles });
    }
    return parts;
  };
  ModelEngine.prototype._downloadBlob = function (blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  ModelEngine.prototype._exportMesh = function (fmt) {
    const kind = fmt === 'obj' ? 'obj' : (fmt === '3mf' ? '3mf' : 'stl');
    const ids = this._exportIds();
    const base = String((this.data && this.data.title) || 'Model').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'Model';
    if (kind === '3mf') {
      const parts = this._collectExportParts(ids);
      const buf = C().meshTo3mf(parts, base);
      if (!buf) {
        this._toast('Nothing to export. Build a body first.');
        return;
      }
      this._downloadBlob(new Blob([buf], { type: 'model/3mf' }), base + '.3mf');
      this._toast('Downloaded ' + base + '.3mf');
      return;
    }
    const mesh = this._collectExportMesh(ids);
    if (!mesh) {
      this._toast('Nothing to export. Build a body first.');
      return;
    }
    if (kind === 'obj') {
      const text = C().meshToObj(mesh.vertices, mesh.triangles, base);
      this._downloadBlob(new Blob([text], { type: 'text/plain' }), base + '.obj');
      this._toast('Downloaded ' + base + '.obj');
      return;
    }
    const buf = C().meshToBinaryStl(mesh.vertices, mesh.triangles, base);
    this._downloadBlob(new Blob([buf], { type: 'model/stl' }), base + '.stl');
    this._toast('Downloaded ' + base + '.stl');
  };
  ModelEngine.prototype._importFile = function (file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const mesh = /\.obj$/i.test(file.name) ? this._parseOBJ(String(reader.result || '')) : this._parseSTL(reader.result);
        if (!mesh) { this._toast('Could not read that file. Use an STL or OBJ.'); return; }
        if (mesh.triangles.length / 3 > 1500000) { this._toast('That mesh is too large to keep in the file.'); return; }
        const names = new Set(this.data.objects.map((o) => o.name));
        let name = (file.name || 'Mesh').replace(/\.(stl|obj)$/i, ''), i = 2;
        while (names.has(name)) { name = name + ' ' + i; i++; }
        const obj = C().normObject({
          name: name.slice(0, 80), kernel: 'mesh', type: 'mesh', mesh,
          pos: this.data.objects.length ? this._inView() : [0, 0, 0], rot: [0, 0, 0], features: [],
        });
        this.data.objects.push(obj);
        this.sel = obj.id;
        this.multi = [obj.id];
        this._showBodies([{ id: obj.id, vertices: Float32Array.from(mesh.vertices), triangles: Uint32Array.from(mesh.triangles), faces: [] }], { fit: false });
        this._renderList();
        this._renderInsp();
        this._changed();
        this._requestBuild();
      } catch (err) { this._toast(err.message || 'Could not read that file.'); }
    };
    if (/\.obj$/i.test(file.name)) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  };
  ModelEngine.prototype._parseSTL = function (buf) {
    const dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (84 + n * 50 === buf.byteLength && n > 0) {
        const vertices = new Array(n * 9);
        const triangles = new Array(n * 3);
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 9; k++) vertices[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
          triangles[i * 3] = i * 3; triangles[i * 3 + 1] = i * 3 + 1; triangles[i * 3 + 2] = i * 3 + 2;
        }
        return { vertices, triangles };
      }
    }
    const text = new TextDecoder().decode(buf);
    const vertices = [];
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) vertices.push(+m[1], +m[2], +m[3]);
    if (vertices.length < 9) return null;
    const triangles = [];
    for (let i = 0; i < vertices.length / 3; i++) triangles.push(i);
    return { vertices, triangles };
  };
  ModelEngine.prototype._parseOBJ = function (text) {
    const vs = [];
    const vertices = [];
    const triangles = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('v ')) {
        const p = t.split(/\s+/);
        vs.push([+p[1] || 0, +p[2] || 0, +p[3] || 0]);
      } else if (t.startsWith('f ')) {
        const idx = t.split(/\s+/).slice(1).map((s) => (parseInt(s, 10) || 1) - 1).filter((i) => i >= 0 && i < vs.length);
        for (let i = 1; i < idx.length - 1; i++) {
          const tri = [idx[0], idx[i], idx[i + 1]];
          for (const k of tri) {
            triangles.push(vertices.length / 3);
            vertices.push(vs[k][0], vs[k][1], vs[k][2]);
          }
        }
      }
    }
    return vertices.length >= 9 ? { vertices, triangles } : null;
  };

  global.ModelEngine = ModelEngine;
})(typeof window !== 'undefined' ? window : globalThis);
