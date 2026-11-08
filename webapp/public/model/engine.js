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
    sketch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5 15.5 5l3.5 3.5L7.5 20H4z"/><path d="M13 7.5 16.5 11"/></svg>',
    face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 8.5 12 4.5l7 4v7l-7 4-7-4z"/><path d="M12 12V4.5M12 12l7-3.5"/></svg>',
    join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h7v8H4zM13 8h7v8h-7z"/></svg>',
    import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4v10"/><path d="M8 10.5 12 14.5 16 10.5"/><path d="M5 18h14"/></svg>',
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
    return JSON.stringify((objects || []).map((o) => {
      if (!o || (o.view == null && o.brep == null && o.brepHash == null)) return o;
      const c = Object.assign({}, o);
      delete c.view;
      delete c.brep;
      delete c.brepHash;
      return c;
    }));
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
      <div class="mdl-view" data-view></div>
      <div class="mdl-rail" role="toolbar" aria-label="Bodies">
        <button type="button" data-add="box" title="Box" aria-label="Box">${ICON.box}</button>
        <button type="button" data-add="cylinder" title="Cylinder" aria-label="Cylinder">${ICON.cylinder}</button>
        <button type="button" data-add="sphere" title="Sphere" aria-label="Sphere">${ICON.sphere}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-sketch title="Sketch" aria-label="Sketch">${ICON.sketch}</button>
        <button type="button" data-face title="Face push or pull" aria-label="Face">${ICON.face}</button>
        <button type="button" data-join title="Join selected bodies" aria-label="Join">${ICON.join}</button>
        <button type="button" data-import title="Import STL or OBJ" aria-label="Import">${ICON.import}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-fit title="Fit" aria-label="Fit">${ICON.fit}</button>
        <div class="mdl-gap"></div>
        <button type="button" data-undo title="Undo" aria-label="Undo" disabled>${ICON.undo}</button>
        <button type="button" data-redo title="Redo" aria-label="Redo" disabled>${ICON.redo}</button>
      </div>
      <div class="mdl-dims" data-dims></div>
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
          <span class="mdl-opk">Extrude</span>
          <div class="mdl-oprow">
            <label class="mdl-len">Length<input data-exdist type="text" inputmode="decimal" value=""></label>
            <button type="button" class="mdl-word" data-exgo>Extrude</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
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
        <button type="button" class="mdl-word mdl-ghost" data-facedone>Bodies</button>
      </div>
      <div class="mdl-skbar hidden" data-skbar>
        <div class="mdl-op">
          <span class="mdl-opk">Draw</span>
          <div class="mdl-oprow">
            <button type="button" class="mdl-ico" data-sktool="rect" aria-label="Rectangle">${ICON.rect}</button>
            <button type="button" class="mdl-ico" data-sktool="circle" aria-label="Circle">${ICON.circle}</button>
            <button type="button" class="mdl-ico" data-sktool="line" aria-label="Line">${ICON.line}</button>
          </div>
        </div>
        <span class="mdl-vsep"></span>
        <div class="mdl-op">
          <span class="mdl-opk">Size</span>
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
      <aside class="mdl-side">
        <header class="mdl-sidehead"><span>Bodies</span><div class="mdl-iconrow"><button type="button" class="mdl-ico" data-point aria-label="Save checkpoint">${ICON.bookmark}</button><button type="button" class="mdl-ico" data-more aria-label="Select more">${ICON.more}</button></div></header>
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
    this.root.querySelector('[data-undo]').onclick = () => this._undo();
    this.root.querySelector('[data-redo]').onclick = () => this._redo();
    this.root.querySelector('[data-sketch]').onclick = () => this._sketchStart();
    this.root.querySelector('[data-face]').onclick = () => this._faceToggle();
    this.root.querySelector('[data-sketchface]').onclick = () => this._sketchStart();
    this.root.querySelector('[data-fromface]').onclick = () => this._sketchFromFace();
    this.root.querySelector('[data-exgo]').onclick = () => this._extrudeLength();
    this.root.querySelector('[data-exdist]').addEventListener('change', () => this._extrudeLength());
    this.root.querySelectorAll('[data-splitplane]').forEach((b) => b.onclick = () => {
      this._splitPlane = b.dataset.splitplane;
      this.root.querySelectorAll('[data-splitplane]').forEach((x) => x.classList.toggle('on', x === b));
      this._showCutPlane();
    });
    this.root.querySelectorAll('[data-cutnudge]').forEach((b) => b.onclick = () => this._nudgeCut(Number(b.dataset.cutnudge)));
    const splitOff = this.root.querySelector('[data-splitoff]');
    if (splitOff) splitOff.addEventListener('input', () => this._showCutPlane());
    this.root.querySelector('[data-split]').onclick = () => this._splitFace();
    this.root.querySelector('[data-facedone]').onclick = () => { if (this.faceOn) this._faceToggle(); };
    this.root.querySelector('[data-join]').onclick = () => this._join();
    this.root.querySelector('[data-import]').onclick = () => this.root.querySelector('[data-file]').click();
    this.root.querySelector('[data-more]').onclick = () => this._setAdding(!this.adding);
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
    this.viewEl.appendChild(renderer.domElement);
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

    const controls = new T.OrbitControls(cam, renderer.domElement);
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

    const tc = new T.TransformControls(cam, renderer.domElement);
    tc.setSpace('world');
    tc.size = matchMedia('(pointer: coarse)').matches ? 1.25 : 0.9;
    scene.add(tc.getHelper());
    this.tc = tc;
    tc.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      this.dragging = e.value;
      if (!e.value) { this._renderList(); this._changed(); }
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
    this._on(renderer.domElement, 'touchmove', (e) => this._pinch(e), { passive: false });
    let gs = 1;
    this._on(renderer.domElement, 'gesturestart', (e) => { e.preventDefault(); gs = 1; });
    this._on(renderer.domElement, 'gesturechange', (e) => { e.preventDefault(); this._zoom(gs / (e.scale || 1), e); gs = e.scale || 1; });

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
      renderer.render(scene, this.camera);
    };
    loop();
  };

  // Desktop pointer, finger, and Pencil. A finger orbits after a short move.
  // Pencil and the left mouse button select and drive the gizmo. They never orbit.
  ModelEngine.prototype._bindPointer = function () {
    const el = this.renderer.domElement;
    let down = null;
    let finger = null;
    // iPad sends a mouse or touch pointer just after the pencil. That second
    // pointer lands on a different face and steals the selection.
    const notePen = (e) => { if (e.pointerType === 'pen') this._penAt = performance.now(); };
    const penEcho = (e) => e.pointerType !== 'pen' && this._penAt && performance.now() - this._penAt < 800;
    this._on(el, 'pointerdown', (e) => {
      notePen(e);
      if (penEcho(e)) return;
      this.root.focus({ preventScroll: true });
      if (e.button === 1) {
        const mod = e.shiftKey || e.ctrlKey || e.metaKey;
        this.controls.mouseButtons.MIDDLE = mod ? this.T.MOUSE.ROTATE : this.T.MOUSE.PAN;
      }
      if (e.pointerType === 'touch' && !e.isPrimary) { finger = null; this.controls.enabled = true; return; }
      // Sketch owns the main pointer: mouse, Pencil, and one finger. A second finger still pans.
      if (this.sk && (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen')) {
        this._sketchDown(e);
        return;
      }
      if (this.faceOn && e.pointerType !== 'touch' && (e.button === 0 || e.pointerType === 'pen')) {
        this._facePress = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
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
    const endFinger = (e) => {
      if (!finger) return;
      if (e && e.pointerId != null && e.pointerId !== finger.id) return;
      const moved = finger.moved;
      finger = null;
      if (!this.dragging) this.controls.enabled = true;
      return moved;
    };
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
          this._faceToggle();
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
    });
    this._on(el, 'pointerleave', () => this._hover(null));
    this._on(el, 'contextmenu', (e) => e.preventDefault());
  };

  ModelEngine.prototype._bindWheel = function () {
    const wheel = (e) => this._viewWheel(e);
    this._on(this.renderer.domElement, 'wheel', wheel, { passive: false });
    this._on(this.root.querySelector('[data-cube]'), 'wheel', wheel, { passive: false });
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
    if (id === this.hov) return;
    this.hov = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this._paint();
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
  ModelEngine.prototype._paint = function () {
    if (!this.colors) return;
    for (const [id, o] of Object.entries(this.objs)) {
      const obj = this._obj(id);
      const show = !obj || !obj.hidden;
      o.group.visible = show;
      (o.picks || []).forEach((m) => { m.visible = show; });
      if (o.mesh && o.mesh.material && o.group.scale) {
        const flipped = o.group.scale.x < 0 || o.group.scale.y < 0 || o.group.scale.z < 0;
        o.mesh.material.side = flipped ? this.T.DoubleSide : this.T.FrontSide;
      }
      const on = this.multi.indexOf(id) >= 0 && !this.faceOn;
      const hot = id === this.hov && !on && !this.faceOn;
      o.mesh.material.color.copy(on ? this.colors.selBody : this.colors.body);
      o.edges.material.color.copy(on || hot ? this.colors.sel : this.colors.edge);
      o.edges.material.opacity = on ? 0.95 : hot ? 0.7 : 0.38;
    }
  };

  ModelEngine.prototype._initWorker = function () {
    this.worker = new Worker(VENDOR + 'model-worker.js?v=' + encodeURIComponent(this.version) + '-11', { type: 'module' });
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
        id: o.id, kernel: o.kernel, type: o.type, size: o.size, pos: o.pos, rot: o.rot,
        profiles: o.profiles, height: o.height, features: o.features, parts: o.parts, mesh: o.mesh,
        brep: o.brep, brepHash: o.brepHash,
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
        const missed = b && b.notes && b.notes.find((t) => t === 'That sketch does not split the face.');
        if (missed) { this._toast(missed); break; }
      }
      let remember = false;
      for (const b of m.bodies || []) {
        if (b && b.vertices && this._pendingSigs && this._pendingSigs[b.id]) this._shapeSigs[b.id] = this._pendingSigs[b.id];
        if (b && b.vertices) remember = this._remember(b) || remember;
      }
      this._showBodies(m.bodies || []);
      if (remember && this.opts.onChange) this.opts.onChange();
    } catch (e) {
      this._toast('Could not update the model. ' + (e && e.message ? e.message : e));
    }
    this._warming = false;
    if (this.pendingBuild) this._build();
    else this._clearBusy();
  };
  ModelEngine.prototype._remember = function (b) {
    const obj = this._obj(b.id);
    if (!obj) return false;
    const nextSurface = b.faces && b.faces.some((f) => f.surface && f.surface.vertices && f.surface.vertices.length >= 9);
    const storedSurface = obj.view && obj.view.faces && obj.view.faces.some((f) => f.surface && f.surface.vertices && f.surface.vertices.length >= 9);
    if (!b.brep && obj.view && obj.view.edges && obj.view.edges.length >= 6 && obj.view.vertices && obj.view.vertices.length > 8 && (!nextSurface || storedSurface)) return false;
    let changed = false;
    if (b.brep && b.brepHash && (obj.brep !== b.brep || obj.brepHash !== b.brepHash)) {
      obj.brep = b.brep;
      obj.brepHash = b.brepHash;
      changed = true;
    }
    const verts = b.vertices;
    const tris = b.triangles;
    const prev = obj.view;
    const hasLines = b.edges && b.edges.length >= 6;
    const same = prev && prev.vertices && prev.vertices.length === verts.length && prev.triangles && prev.triangles.length === tris.length
      && prev.vertices[0] === verts[0] && prev.vertices[verts.length - 1] === verts[verts.length - 1]
      && (!hasLines || (prev.edges && prev.edges.length === b.edges.length))
      && (!nextSurface || storedSurface);
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
      else if (this.faceOn) this._faceToggle();
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
    this._paint();
  };
  ModelEngine.prototype._syncGizmo = function () {
    if (!this.tc) return;
    const slot = this.sel && this.objs[this.sel];
    if (!slot || this.sk || this.faceOn || this.multi.length > 1) { this.tc.detach(); return; }
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
      '<div class="mdl-item' + (o.hidden ? ' off' : '') + '"><button type="button" class="mdl-row' + (this.multi.indexOf(o.id) >= 0 ? ' on' : '') + '" data-id="' + esc(o.id) + '"><b>' + esc(o.name) + '</b><span>' + esc(this._sizeText(o)) + '</span></button><button type="button" class="mdl-ico" data-hide="' + esc(o.id) + '" aria-label="' + (o.hidden ? 'Show ' : 'Hide ') + esc(o.name) + '">' + (o.hidden ? ICON.eyeOff : ICON.eye) + '</button></div>'
    ).join('');
    list.querySelectorAll('[data-id]').forEach((b) => { b.onclick = (e) => this._select(b.dataset.id, e.shiftKey || e.metaKey || e.ctrlKey); });
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
    if (!hit) { this._paint(); this._showCutPlane(); return; }
    const slot = this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
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
    const join = this.root.querySelector('[data-join]');
    if (join) join.classList.toggle('on', this.adding);
  };
  ModelEngine.prototype._faceToggle = function (quiet) {
    if (this.sk) this._sketchCancel();
    this.faceOn = !this.faceOn;
    if (this.faceOn) this._setAdding(false);
    this._faceHit = null;
    this._faceHeld = 0;
    this._facePress = null;
    this._faceDrag = null;
    const b = this.root.querySelector('[data-face]');
    if (b) b.classList.toggle('on', this.faceOn);
    const bar = this.root.querySelector('[data-facebar]');
    if (bar) bar.classList.toggle('hidden', !this.faceOn);
    this._markFace();
    this._syncGizmo();
    if (!quiet) this._toast(this.faceOn ? 'These tools act on the selected face.' : 'Selecting bodies.');
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
    try { this.renderer.domElement.setPointerCapture(press.id); } catch (err) { /* synthetic events */ }
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
    if (!this.dragging) this.controls.enabled = true;
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
    if (!this.faceOn || !this._faceHit || !this.T) return;
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
    obj.features.push({ op: 'push', loop: face.loop.map((p) => p.slice()), normal: face.normal.slice(), center: (face.center || face.loop[0]).slice(), dist: r3(dist) });
    this._changed();
    this._requestBuild();
  };

  ModelEngine.prototype._openSketch = function (plane, profiles) {
    if (this.faceOn) this._faceToggle(true);
    this.sk = { tool: 'rect', profiles: profiles || [], plane, chain: [], base: (profiles || []).length };
    const bar = this.root.querySelector('[data-skbar]');
    if (bar) bar.classList.remove('hidden');
    this._sketchTool('rect');
    this._syncSketchDims();
    this._sketchSourceBar();
    this._syncGizmo();
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchStart = function () {
    const plane = this._sketchPlane();
    this._openSketch(plane, []);
  };
  // The face outline, in the sketch plane, as lines, circles, and arcs.
  // A sampled loop would extrude inside the real curve and leave gaps.
  ModelEngine.prototype._projectExact = function (face, slot) {
    const T = this.T;
    const plane = this._sketchPlane();
    if (!plane || !face || !face.exact || !face.exact.length) return null;
    const world = this._shapeMatrix(slot);
    const y = new T.Vector3().crossVectors(plane.normal, plane.xDir).normalize();
    if (y.lengthSq() < 1e-8) return null;
    const to2 = (p) => {
      const w = new T.Vector3(p[0], p[1], p[2]).applyMatrix4(world);
      const d = w.sub(plane.origin);
      return [r3(d.dot(plane.xDir)), r3(d.dot(y))];
    };
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
  ModelEngine.prototype._sketchFromFace = function () {
    const hit = this._faceHit;
    const slot = hit && this.objs[hit.id];
    const face = slot && slot.faces[hit.index];
    if (!slot || !face) { this._toast('Select a face first.'); return; }
    const made = this._projectExact(face, slot);
    if (!made) { this._toast('This face cannot be copied exactly yet.'); return; }
    this._openSketch(made.plane, [{ k: 'exact', wires: made.wires }]);
    if (this.sk) {
      this.sk.source = {
        id: hit.id,
        center: (face.center || (face.loop && face.loop[0]) || [0, 0, 0]).slice(),
        normal: (face.normal || [0, 0, 1]).slice(),
      };
    }
    this._sketchSourceBar();
    this._toast('Draw across the face, then Split face. Each region can be extruded in or out.');
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
  ModelEngine.prototype._sketchDown = function (e) {
    const p = this._sketchPoint(e);
    if (!p || !this.sk) return;
    this._skDrag = { id: e.pointerId, p0: p, p, moved: false };
    this.controls.enabled = false;
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  };
  ModelEngine.prototype._sketchHover = function (e) {
    if (!this.sk) return;
    this.sk.hover = this._sketchPoint(e);
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchMove = function (e) {
    const d = this._skDrag;
    if (!d || !this.sk) return;
    const p = this._sketchPoint(e);
    if (!p) return;
    if (Math.hypot(p[0] - d.p0[0], p[1] - d.p0[1]) > 0.4) d.moved = true;
    d.p = p;
    this.sk.hover = p;
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchClick = function (e) {
    if (!this.sk || this.sk.tool !== 'line') return;
    const p = this._sketchPoint(e);
    if (!p) return;
    const c = this.sk.chain;
    if (c.length >= 3 && Math.hypot(p[0] - c[0][0], p[1] - c[0][1]) < 2) { this._sketchClose(); return; }
    c.push(p);
    this._sketchDraw();
  };
  ModelEngine.prototype._sketchUp = function (e) {
    const d = this._skDrag;
    this._skDrag = null;
    if (!this.dragging) this.controls.enabled = true;
    if (!d || !this.sk) return;
    if (!d.moved) { this._sketchClick(e); return; }
    if (this.sk.tool === 'rect') this._sketchAddRect(d.p0, d.p);
    else if (this.sk.tool === 'circle') this._sketchAddCircle(d.p0, d.p);
    else if (this.sk.tool === 'line') {
      const a = d.p0, b = d.p;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.05) this.sk.profiles.push({ k: 'path', pts: [a.slice(), b.slice()] });
    }
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
    if (!this.sk) return;
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
    if (this.sk.hover && this.sk.tool === 'line') chain.push(this.sk.hover);
    for (let i = 1; i < chain.length; i++) add(chain[i - 1], chain[i]);
    if (!pts.length) return;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
    this._skLines = new T.LineSegments(g, new T.LineBasicMaterial({ color: ORANGE, depthTest: false }));
    this._skLines.renderOrder = 4;
    this.scene.add(this._skLines);
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
    if (this.faceOn) this._faceToggle(true);
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
  ModelEngine.prototype._syncSketchDims = function () {
    const host = this.root.querySelector('[data-skdims]');
    if (!host) return;
    const m = this.sk && this._profileMeasure(this.sk.profiles[this.sk.profiles.length - 1]);
    if (!m) { host.innerHTML = ''; return; }
    if (m.kind === 'circle' || m.kind === 'xcircle') host.innerHTML = '<label>Ø<input data-skdim="d" inputmode="decimal" value="' + r3(m.r * 2) + '"></label>';
    else host.innerHTML = '<label>Width<input data-skdim="w" inputmode="decimal" value="' + r3(m.w) + '"></label><label>Height<input data-skdim="h" inputmode="decimal" value="' + r3(m.h) + '"></label>';
    host.querySelectorAll('[data-skdim]').forEach((el) => el.addEventListener('change', () => this._applySketchDim(el)));
  };
  ModelEngine.prototype._applySketchDim = function (el) {
    if (!this.sk || !this.sk.profiles.length) return;
    const p = this.sk.profiles[this.sk.profiles.length - 1];
    const m = this._profileMeasure(p);
    const v = evalNum(el.value, NaN);
    if (!m || !Number.isFinite(v)) return;
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
  ModelEngine.prototype._faceDimText = function (face) {
    const edges = face && face.exact && face.exact[0] && face.exact[0].edges;
    if (!edges || !edges.length) return 'Face';
    if (edges.length === 1 && edges[0].k === 'circle') return 'Ø ' + r3(edges[0].r * 2);
    if (edges.every((e) => e.k === 'line')) {
      const lens = [];
      for (const e of edges) {
        const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], (e.b[2] || 0) - (e.a[2] || 0));
        if (!lens.some((u) => Math.abs(u - L) < 0.05)) lens.push(L);
      }
      if (lens.length === 1) return r3(lens[0]) + ' × ' + r3(lens[0]);
      if (lens.length === 2) return r3(Math.max(lens[0], lens[1])) + ' × ' + r3(Math.min(lens[0], lens[1]));
    }
    return 'Face';
  };
  ModelEngine.prototype._layoutDims = function () {
    const host = this.root.querySelector('[data-dims]');
    if (!host || !this.camera || !this.renderer || !this.T) return;
    const T = this.T;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const items = [];
    for (const o of this.data.objects) {
      if (o.hidden) continue;
      const slot = this.objs[o.id];
      if (!slot || !slot.group.visible || !slot.mesh.geometry) continue;
      const at = slot.group.getWorldPosition(new T.Vector3());
      items.push({ key: 'b' + o.id, text: this._sizeText(o), at });
    }
    if (this.faceOn && this._faceHit) {
      const slot = this.objs[this._faceHit.id];
      const face = slot && slot.faces[this._faceHit.index];
      const label = this.root.querySelector('[data-facedim]');
      const text = face ? this._faceDimText(face) : 'Face';
      if (label) label.textContent = text;
      if (slot && face && face.center) {
        items.push({ key: 'face', text, at: new T.Vector3(face.center[0], face.center[1], face.center[2]).applyMatrix4(this._shapeMatrix(slot)) });
      }
    }
    const keep = new Set(items.map((it) => it.key));
    for (const it of items) {
      let el = host.querySelector('[data-dim="' + it.key + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'mdl-dim';
        el.dataset.dim = it.key;
        host.appendChild(el);
      }
      el.textContent = it.text;
      const p = it.at.clone().project(this.camera);
      const hidden = p.z < -1 || p.z > 1;
      el.hidden = hidden;
      el.style.left = ((p.x * 0.5 + 0.5) * rect.width) + 'px';
      el.style.top = ((-p.y * 0.5 + 0.5) * rect.height) + 'px';
    }
    host.querySelectorAll('[data-dim]').forEach((el) => { if (!keep.has(el.dataset.dim)) el.remove(); });
  };
  ModelEngine.prototype._sketchDone = function () {
    if (!this.sk) return;
    if (this.sk.chain.length >= 3) this._sketchClose();
    else if (this.sk.chain.length >= 2) {
      this.sk.profiles.push({ k: 'path', pts: this.sk.chain.map((p) => p.slice()) });
      this.sk.chain = [];
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
      delete cur.brep;
      delete cur.brepHash;
      delete cur.view;
      delete this._shapeSigs[cur.id];
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
    delete obj.brep;
    delete obj.brepHash;
    delete obj.view;
    delete this._shapeSigs[id];
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
      if (!this.dragging) this.controls.enabled = true;
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
    const bar = this.root.querySelector('[data-skbar]');
    if (bar) bar.classList.add('hidden');
    if (this._skLines) { this.scene.remove(this._skLines); this._skLines.geometry.dispose(); this._skLines = null; }
    this._sketchSourceBar();
    if (!this.dragging) this.controls.enabled = true;
    this._syncGizmo();
  };

  ModelEngine.prototype._join = function () {
    if (this.sk) this._sketchCancel();
    if (this.faceOn) this._faceToggle();
    if (this.multi.length < 2) {
      this._setAdding(true);
      this._toast('Tap each body, then tap Join again. That selects the body, not a face.');
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
