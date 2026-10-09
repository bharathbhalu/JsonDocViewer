/* DocViewer runbook engine — runnable steps sent to a terminal file's tmux session. */
(function (global) {
  const C = global.RunbookCore;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ICON = { pending: '○', running: '⏳', done: '✅', failed: '❌', skipped: '⏭', sent: '📤', timeout: '⏱' };
  const dur = (a, b) => (a && b ? Math.max(0, Math.round((b - a) / 1000)) + 's' : '');

  class RunbookEngine {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = opts || {};
      this.data = C.normalize({});
      this.readOnly = !!this.opts.readOnly;
      this.terminals = [];
      this.run = null; // current run (also stored in data.runs)
      this.busy = false;
      this.stopReq = false;
      this.dry = false;
      this.root = document.createElement('div');
      this.root.className = 'rb-root';
      stage.innerHTML = '';
      stage.appendChild(this.root);
    }

    // ---------- board API ----------
    loadFromHtml(html) {
      this.data = C.parseHtml(html) || C.normalize({});
      const last = this.data.runs[this.data.runs.length - 1];
      this.run = last && !last.finishedAt ? last : null;
      this.render();
      this._loadTerminals();
    }
    serializeToHtml() { return C.serializeToHtml(this.data); }
    setReadOnly(on) { this.readOnly = !!on; this.render(); }
    flushEdit() {}
    collapseAll() { this.root.querySelectorAll('.rb-step').forEach((s) => s.classList.add('collapsed')); }
    expandAll() { this.root.querySelectorAll('.rb-step').forEach((s) => s.classList.remove('collapsed')); }
    destroy() { this.stopReq = true; this.stage.innerHTML = ''; }

    _changed(rerender) { if (this.opts.onChange) this.opts.onChange(); if (rerender) this.render(); }

    async _loadTerminals() {
      try {
        const r = await fetch('/api/term/status', { cache: 'no-store' });
        if (r.ok) this.terminals = (await r.json()).files || [];
      } catch (e) { /* terminals unavailable */ }
      this.render();
    }

    // ---------- results ----------
    _result(stepId, cmdId) {
      if (!this.run) return null;
      return this.run.results.slice().reverse().find((r) => r.stepId === stepId && (cmdId == null || r.cmdId === cmdId)) || null;
    }
    _stepStatus(st) {
      if (!this.run) return null;
      const rs = st.cmds.map((c) => this._result(st.id, c.id)).filter(Boolean);
      if (st.manual) { const r = this._result(st.id, '_manual'); return r ? r.status : null; }
      if (!rs.length) return null;
      if (rs.some((r) => r.status === 'running')) return 'running';
      if (rs.some((r) => r.status === 'failed' || r.status === 'timeout')) return rs.find((r) => r.status === 'failed' || r.status === 'timeout').status;
      if (rs.length < st.cmds.length) return 'running';
      if (rs.every((r) => r.status === 'skipped')) return 'skipped';
      if (rs.some((r) => r.status === 'sent')) return 'sent';
      return 'done';
    }
    _ensureRun(kind) {
      if (!this.run || this.run.finishedAt || this.run.kind !== kind) {
        this.run = C.normalizeRun({ kind, vars: Object.fromEntries(this.data.vars.map((v) => [v.name, v.value])) });
        this.data.runs.push(this.run);
        if (this.data.runs.length > 20) this.data.runs = this.data.runs.slice(-20);
      }
      return this.run;
    }
    _setResult(stepId, cmdId, patch) {
      const run = this.run;
      let r = run.results.find((x) => x.stepId === stepId && x.cmdId === cmdId && (x.status === 'running' || x.status === 'pending'));
      if (!r) { r = C.normalizeRun({ results: [{ stepId, cmdId }] }).results[0]; run.results.push(r); }
      Object.assign(r, patch);
      this._changed(false);
      this._paintStep(stepId);
      return r;
    }

    // ---------- running ----------
    _targetOf(st) { return st.target || this.data.target; }

    async runCmd(st, c, opts) {
      const target = this._targetOf(st);
      if (!target) { await global.uiAlert('Choose a terminal for this runbook first (top of the page).', { title: 'No terminal' }); return 'stop'; }
      const term = this.terminals.find((t) => t.path === target);
      if (term && term.claude) { await global.uiAlert('“' + target + '” is a Claude-only terminal. Pick a regular terminal for runbook commands.', { title: 'Claude terminal' }); return 'stop'; }
      const { text, missing } = C.fill(c.cmd, this.data.vars);
      if (missing.length) { await global.uiAlert('Fill in these variables first: ' + missing.join(', '), { title: 'Missing variables' }); return 'stop'; }
      if (this.dry) {
        this._ensureRun(opts && opts.kind || 'main');
        this._setResult(st.id, c.id, { status: 'skipped', cmd: text, output: '(dry run — not sent)', target, startedAt: Date.now(), endedAt: Date.now() });
        return 'ok';
      }
      if (c.confirm && !(await global.uiConfirm('Run this command on “' + target + '”?\n\n' + text, { title: 'Confirm step: ' + st.title, okLabel: 'Run', danger: true }))) return 'stop';
      this._ensureRun(opts && opts.kind || 'main');
      const r = this._setResult(st.id, c.id, { status: 'running', cmd: text, output: '', exit: null, target, startedAt: Date.now(), endedAt: null });
      let run;
      try {
        if (typeof global.saveCurrentFile === 'function') { /* results save via autosave */ }
        run = await post('/api/term/run', { path: target, cmd: text, timeoutSec: this.data.timeoutSec });
      } catch (err) {
        this._setResult(st.id, c.id, { status: 'failed', output: err.message, endedAt: Date.now() });
        return 'failed';
      }
      while (run.state === 'running' && !this.stopReq) {
        await sleep(1000);
        try {
          const res = await fetch('/api/term/run/' + run.id, { cache: 'no-store' });
          if (res.ok) run = await res.json();
        } catch (e) { /* keep polling */ }
        Object.assign(r, { output: run.output || '' });
        this._paintStep(st.id);
      }
      if (this.stopReq && run.state === 'running') {
        this._setResult(st.id, c.id, { status: 'failed', output: (run.output || '') + '\n[stopped waiting — the command may still be running in the terminal]', endedAt: Date.now() });
        return 'stop';
      }
      const status = run.state === 'done' ? 'done' : run.state === 'sent' ? 'sent' : run.state === 'timeout' ? 'timeout' : 'failed';
      this._setResult(st.id, c.id, { status, output: run.output || run.error || '', exit: run.exit, endedAt: run.endedAt || Date.now() });
      return status === 'done' || status === 'sent' ? 'ok' : 'failed';
    }

    async runStep(st, opts) {
      if (st.manual) {
        this._ensureRun(opts && opts.kind || 'main');
        if (opts && opts.sequence) {
          const ok = await global.uiConfirm('Manual step: ' + st.title + (st.notes ? '\n\n' + C.fill(st.notes, this.data.vars).text : '') + '\n\nMark it done and continue?', { title: 'Manual step', okLabel: 'Done — continue', cancelLabel: 'Stop here' });
          if (!ok) return 'stop';
        }
        this._setResult(st.id, '_manual', { status: 'done', startedAt: Date.now(), endedAt: Date.now() });
        return 'ok';
      }
      for (const c of st.cmds) {
        if (this.stopReq) return 'stop';
        const r = await this.runCmd(st, c, opts); // eslint-disable-line no-await-in-loop
        if (r !== 'ok') return r;
      }
      return 'ok';
    }

    async runSequence(list, from, kind) {
      if (this.busy) return;
      this.busy = true;
      this.stopReq = false;
      this.render();
      try {
        if (from === 0 && !this.dry) this.run = null; // a full run starts a fresh record
        for (let i = from; i < list.length; i++) {
          if (this.stopReq) break;
          const st = list[i];
          const r = await this.runStep(st, { kind, sequence: true }); // eslint-disable-line no-await-in-loop
          if (r === 'stop') break;
          if (r === 'failed') {
            // eslint-disable-next-line no-await-in-loop
            const go = await global.uiConfirm(`Step ${i + 1} “${st.title}” failed.\n\nContinue with the next step, or stop here (you can fix it and use “Run from here”)?`, { title: 'Step failed', okLabel: 'Continue anyway', cancelLabel: 'Stop' });
            if (!go) break;
          }
        }
        if (this.run && !this.stopReq) {
          const lastIdx = list.length - 1;
          if (list.every((st) => this._stepStatus(st)) || from + 1 > lastIdx) this.run.finishedAt = Date.now();
        }
      } finally {
        this.busy = false;
        this._changed(true);
      }
    }

    // ---------- export ----------
    _download(name, text, type) {
      const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async exportRun(run, fmt) {
      const md = C.runToMarkdown(this.data, run);
      const base = (this.data.title || 'runbook').toLowerCase().replace(/[^\w]+/g, '-') + '-run-' + new Date(run.at).toISOString().slice(0, 16).replace(/[:T]/g, '');
      if (fmt === 'md') return this._download(base + '.md', md, 'text/markdown');
      let body = '<pre>' + esc(md) + '</pre>';
      try {
        if (typeof global.ensureMarkdownLibs === 'function') await global.ensureMarkdownLibs();
        else if (typeof ensureMarkdownLibs === 'function') await ensureMarkdownLibs(); // eslint-disable-line no-undef
        if (global.marked) body = (global.DOMPurify ? global.DOMPurify.sanitize(global.marked.parse(md)) : global.marked.parse(md));
      } catch (e) { /* plain */ }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(this.data.title)} — run</title><style>body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:960px;margin:0 auto;padding:28px 20px;color:#1c2330}pre{background:#f4f6f9;padding:10px 12px;border-radius:8px;overflow:auto;font-size:12.5px}table{border-collapse:collapse}td,th{border:1px solid #d0d5dd;padding:4px 10px}h2{border-bottom:1px solid #e4e7ec;padding-bottom:4px;margin-top:26px}@media(prefers-color-scheme:dark){body{background:#10141c;color:#e8ecf3}pre{background:#1a2030}td,th{border-color:#2a3242}h2{border-color:#2a3242}}</style></head><body>${body}</body></html>`;
      this._download(base + '.html', html, 'text/html');
    }

    // ---------- render ----------
    render() {
      const d = this.data;
      const ro = this.readOnly || this.busy;
      const roAttr = ro ? ' disabled' : '';
      const used = C.varsUsed(d);
      const missingVars = used.filter((n) => !d.vars.some((v) => v.name === n));
      const terms = this.terminals.filter((t) => !t.claude);
      const termOpt = (sel, allowInherit) => (allowInherit ? `<option value="">(runbook default)</option>` : '<option value="">— choose a terminal —</option>')
        + terms.map((t) => `<option value="${esc(t.path)}"${t.path === sel ? ' selected' : ''}>${esc(t.title)} · ${t.mode === 'ssh' ? esc(t.host) : 'local'} (${esc(t.path)})</option>`).join('')
        + (sel && !terms.some((t) => t.path === sel) ? `<option value="${esc(sel)}" selected>${esc(sel)} (missing)</option>` : '');
      const stepHtml = (st, i, list, kind) => {
        const status = this._stepStatus(st);
        return `
        <div class="rb-step ${status ? 'st-' + status : ''}${st.manual ? ' manual' : ''}" data-step="${esc(st.id)}" data-kind="${kind}">
          <div class="rb-step-head">
            <span class="rb-num">${i + 1}</span>
            <span class="rb-status" title="${esc(status || 'not run')}">${ICON[status] || '○'}</span>
            <input class="rb-title" data-sf="title" value="${esc(st.title)}"${roAttr}>
            <span class="rb-spacer"></span>
            ${this.readOnly ? '' : `
            <button type="button" class="rb-go" data-act="runstep" title="Run this step"${this.busy ? ' disabled' : ''}>▶ Run</button>
            <button type="button" data-act="runfrom" title="Run this step and everything after it"${this.busy ? ' disabled' : ''}>▶▶ From here</button>
            <button type="button" class="ic" data-act="up" title="Move up"${i === 0 || ro ? ' disabled' : ''}>↑</button>
            <button type="button" class="ic" data-act="down" title="Move down"${i === list.length - 1 || ro ? ' disabled' : ''}>↓</button>
            <button type="button" class="ic" data-act="del" title="Delete step"${roAttr}>✕</button>`}
          </div>
          <div class="rb-step-body">
            <textarea class="rb-notes" data-sf="notes" rows="${Math.min(6, Math.max(1, (st.notes.match(/\n/g) || []).length + 1))}" placeholder="Notes (what to check, why)…"${roAttr}>${esc(st.notes)}</textarea>
            ${st.manual ? `<div class="rb-manual">Manual step — ${this._result(st.id, '_manual') ? '✅ marked done' : `<button type="button" data-act="manualdone"${this.busy ? ' disabled' : ''}>Mark done</button>`}</div>` : ''}
            ${st.cmds.map((c) => {
              const r = this._result(st.id, c.id);
              return `<div class="rb-cmd" data-cmd="${esc(c.id)}">
                <div class="rb-cmd-row">
                  <button type="button" class="rb-runcmd" data-act="runcmd" title="Run this command"${this.busy || this.readOnly ? ' disabled' : ''}>▶</button>
                  <textarea class="rb-code" data-cf="cmd" rows="${Math.min(8, (c.cmd.match(/\n/g) || []).length + 1)}" spellcheck="false"${roAttr}>${esc(c.cmd)}</textarea>
                  <label class="rb-confirm" title="Ask before running"><input type="checkbox" data-cf="confirm"${c.confirm ? ' checked' : ''}${roAttr}> confirm</label>
                  ${this.readOnly ? '' : `<button type="button" class="ic" data-act="delcmd" title="Remove command"${roAttr}>✕</button>`}
                </div>
                ${r ? `<div class="rb-out ${r.status}"><div class="rb-out-head">${ICON[r.status] || ''} ${esc(r.status)}${r.exit != null ? ' · exit ' + r.exit : ''}${dur(r.startedAt, r.endedAt) ? ' · ' + dur(r.startedAt, r.endedAt) : ''} · on ${esc(r.target)}</div>${r.output ? `<pre>${esc(r.output)}</pre>` : ''}</div>` : ''}
              </div>`;
            }).join('')}
            ${this.readOnly ? '' : `<div class="rb-step-foot">
              <button type="button" data-act="addcmd"${roAttr}>＋ Command</button>
              <label>Run on <select data-sf="target"${roAttr}>${termOpt(st.target, true)}</select></label>
              <label class="rb-confirm"><input type="checkbox" data-sf="manual"${st.manual ? ' checked' : ''}${roAttr}> manual step</label>
            </div>`}
          </div>
        </div>`;
      };
      const run = this.run;
      const totals = run ? d.steps.concat(d.rollback).reduce((a, st) => { const s = this._stepStatus(st); if (s) a[s] = (a[s] || 0) + 1; return a; }, {}) : {};
      this.root.innerHTML = `
        <div class="rb-head">
          <input class="rb-doc-title" data-df="title" value="${esc(d.title)}"${roAttr}>
          <textarea class="rb-summary" data-df="summary" rows="2" placeholder="What this runbook does and when to use it"${roAttr}>${esc(d.summary)}</textarea>
          <div class="rb-target">
            <label>Runs in terminal <select data-df="target"${roAttr}>${termOpt(d.target, false)}</select></label>
            <button type="button" data-act="newterm"${roAttr} title="Create a terminal file">＋ New terminal</button>
            <label>Timeout per command <input type="number" data-df="timeoutSec" min="5" max="14400" value="${d.timeoutSec}"${roAttr}> s</label>
          </div>
          ${!terms.length ? '<p class="rb-warn">No terminal files yet — create one (＋ New terminal) so steps have somewhere to run.</p>' : ''}
        </div>
        <section class="rb-vars">
          <h3>Variables <span class="rb-hint">use as {{name}} in commands</span></h3>
          ${d.vars.map((v, i) => `<div class="rb-var" data-v="${i}"><code>{{${esc(v.name)}}}</code><input data-vf="value" value="${esc(v.value)}" placeholder="value"${this.busy ? ' disabled' : ''}><input data-vf="desc" value="${esc(v.desc)}" placeholder="description"${roAttr}>${this.readOnly ? '' : `<button type="button" class="ic" data-act="delvar" title="Remove"${roAttr}>✕</button>`}</div>`).join('')}
          ${missingVars.length ? `<p class="rb-warn">Used but not defined: ${missingVars.map((n) => `<button type="button" class="rb-addvar" data-addvar="${esc(n)}"${roAttr}>＋ {{${esc(n)}}}</button>`).join(' ')}</p>` : ''}
          ${this.readOnly ? '' : `<button type="button" data-act="addvar"${roAttr}>＋ Variable</button>`}
        </section>
        <div class="rb-bar">
          ${this.busy ? '<button type="button" class="rb-stop" data-act="stop">■ Stop</button><span class="rb-running">Running…</span>' : `
          <button type="button" class="rb-primary" data-act="runall"${this.readOnly ? ' disabled' : ''}>▶ Run all steps</button>
          ${d.rollback.length ? `<button type="button" class="rb-danger" data-act="runrollback"${this.readOnly ? ' disabled' : ''}>↩ Run rollback</button>` : ''}`}
          <label class="rb-dry"><input type="checkbox" data-act="dry"${this.dry ? ' checked' : ''}${this.busy ? ' disabled' : ''}> Dry run</label>
          <span class="rb-spacer"></span>
          ${run ? `<span class="rb-totals">${Object.entries(totals).map(([k, n]) => `${ICON[k]} ${n}`).join(' · ')}</span><button type="button" data-act="clearrun"${this.busy ? ' disabled' : ''}>Clear statuses</button>` : ''}
        </div>
        <section class="rb-steps"><h3>Steps</h3>${d.steps.map((st, i) => stepHtml(st, i, d.steps, 'main')).join('')}${this.readOnly ? '' : `<button type="button" class="rb-addstep" data-act="addstep" data-list="steps"${roAttr}>＋ Add step</button>`}</section>
        <section class="rb-steps rb-rollback"><h3>Rollback</h3>${d.rollback.map((st, i) => stepHtml(st, i, d.rollback, 'rollback')).join('') || '<p class="rb-hint">No rollback steps.</p>'}${this.readOnly ? '' : `<button type="button" class="rb-addstep" data-act="addstep" data-list="rollback"${roAttr}>＋ Add rollback step</button>`}</section>
        <section class="rb-history"><h3>Run history</h3>
          ${d.runs.slice().reverse().map((r) => {
            const counts = r.results.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
            return `<div class="rb-run" data-run="${esc(r.id)}"><span>${esc(new Date(r.at).toLocaleString())}</span><span class="rb-kind ${r.kind}">${r.kind === 'rollback' ? 'rollback' : 'run'}</span><span class="rb-counts">${Object.entries(counts).map(([k, n]) => `${ICON[k] || ''} ${n}`).join(' · ') || 'no results'}</span>${r.finishedAt ? '' : '<span class="rb-open">in progress</span>'}<span class="rb-spacer"></span><button type="button" data-exp="md">⤓ Markdown</button><button type="button" data-exp="html">⤓ HTML</button></div>`;
          }).join('') || '<p class="rb-hint">No runs yet.</p>'}
        </section>`;
      this._bind();
    }

    // Repaint one step in place (while commands run) without losing focus elsewhere.
    _paintStep(stepId) {
      const el = this.root.querySelector(`.rb-step[data-step="${stepId}"]`);
      if (!el) return;
      const kind = el.dataset.kind;
      const list = kind === 'rollback' ? this.data.rollback : this.data.steps;
      const st = list.find((x) => x.id === stepId);
      if (!st) return;
      const status = this._stepStatus(st);
      el.className = 'rb-step ' + (status ? 'st-' + status : '') + (st.manual ? ' manual' : '');
      el.querySelector('.rb-status').textContent = ICON[status] || '○';
      st.cmds.forEach((c) => {
        const box = el.querySelector(`.rb-cmd[data-cmd="${c.id}"]`);
        if (!box) return;
        const r = this._result(st.id, c.id);
        let out = box.querySelector('.rb-out');
        if (!r) { if (out) out.remove(); return; }
        if (!out) { out = document.createElement('div'); box.appendChild(out); }
        out.className = 'rb-out ' + r.status;
        out.innerHTML = `<div class="rb-out-head">${ICON[r.status] || ''} ${esc(r.status)}${r.exit != null ? ' · exit ' + r.exit : ''}${dur(r.startedAt, r.endedAt) ? ' · ' + dur(r.startedAt, r.endedAt) : ''} · on ${esc(r.target)}</div>${r.output ? `<pre>${esc(r.output)}</pre>` : ''}`;
        const pre = out.querySelector('pre');
        if (pre && r.status === 'running') pre.scrollTop = pre.scrollHeight;
      });
    }

    _bind() {
      const R = this.root;
      const d = this.data;
      R.querySelectorAll('[data-df]').forEach((el) => el.addEventListener('change', () => {
        const f = el.dataset.df;
        d[f] = f === 'timeoutSec' ? Math.max(5, Math.min(14400, Number(el.value) || 1800)) : el.value;
        this._changed(f === 'target');
      }));
      R.querySelectorAll('.rb-var').forEach((row) => {
        const v = d.vars[Number(row.dataset.v)];
        row.querySelectorAll('[data-vf]').forEach((el) => el.addEventListener('change', () => { v[el.dataset.vf] = el.value; this._changed(false); }));
        const del = row.querySelector('[data-act="delvar"]');
        if (del) del.addEventListener('click', () => { d.vars.splice(Number(row.dataset.v), 1); this._changed(true); });
      });
      R.querySelectorAll('[data-addvar]').forEach((b) => b.addEventListener('click', () => { d.vars.push({ name: b.dataset.addvar, value: '', desc: '' }); this._changed(true); }));
      const act = (name, fn) => R.querySelectorAll(`[data-act="${name}"]`).forEach((b) => b.addEventListener(b.type === 'checkbox' ? 'change' : 'click', (e) => fn(b, e)));
      act('addvar', async () => {
        const name = await global.uiPrompt('Variable name (letters, digits, _ . -)', '', { title: 'New variable', okLabel: 'Add' });
        const n = String(name || '').replace(/[^\w.-]/g, '');
        if (!n) return;
        if (d.vars.some((v) => v.name === n)) return global.uiAlert('{{' + n + '}} already exists.');
        d.vars.push({ name: n, value: '', desc: '' });
        this._changed(true);
      });
      act('dry', (b) => { this.dry = b.checked; });
      act('stop', () => { this.stopReq = true; });
      act('runall', () => this.runSequence(d.steps, 0, 'main'));
      act('runrollback', async () => {
        if (!(await global.uiConfirm('Run all rollback steps?', { title: 'Rollback', okLabel: 'Run rollback', danger: true }))) return;
        this.run = null;
        this.runSequence(d.rollback, 0, 'rollback');
      });
      act('clearrun', () => { if (this.run) this.run.finishedAt = this.run.finishedAt || Date.now(); this.run = null; this._changed(true); });
      act('newterm', async () => {
        try {
          const r = await post('/api/term/quick', { folder: '' });
          d.target = r.path;
          this._changed(false);
          if (typeof global.loadTree === 'function') await global.loadTree();
          else if (typeof loadTree === 'function') await loadTree(); // eslint-disable-line no-undef
          await this._loadTerminals();
          global.setStatus && global.setStatus('Created ' + r.path + ' — open it to adjust (local / SSH)', 'ok');
        } catch (err) { global.uiAlert(err.message); }
      });
      act('addstep', (b) => {
        const list = d[b.dataset.list];
        list.push(C.normalizeStep({ title: 'New step', cmds: [{ cmd: '' }] }));
        this._changed(true);
        const steps = R.querySelectorAll(`.rb-step[data-kind="${b.dataset.list === 'rollback' ? 'rollback' : 'main'}"]`);
        const last = steps[steps.length - 1];
        if (last) { last.scrollIntoView({ block: 'center' }); const t = last.querySelector('.rb-title'); if (t) { t.focus(); t.select(); } }
      });
      R.querySelectorAll('.rb-run').forEach((row) => {
        const run = d.runs.find((x) => x.id === row.dataset.run);
        row.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => this.exportRun(run, b.dataset.exp)));
      });
      R.querySelectorAll('.rb-step').forEach((el) => {
        const list = el.dataset.kind === 'rollback' ? d.rollback : d.steps;
        const st = list.find((x) => x.id === el.dataset.step);
        const idx = list.indexOf(st);
        el.querySelectorAll('[data-sf]').forEach((inp) => inp.addEventListener('change', () => {
          const f = inp.dataset.sf;
          st[f] = inp.type === 'checkbox' ? inp.checked : inp.value;
          this._changed(f === 'manual');
        }));
        const on = (a, fn) => el.querySelectorAll(`[data-act="${a}"]`).forEach((b) => b.addEventListener('click', (e) => fn(b, e)));
        on('runstep', async () => {
          if (this.busy) return;
          this.busy = true; this.stopReq = false; this.render();
          try { await this.runStep(st, { kind: el.dataset.kind }); } finally { this.busy = false; this._changed(true); }
        });
        on('runfrom', () => this.runSequence(list, idx, el.dataset.kind));
        on('manualdone', () => { this._ensureRun(el.dataset.kind); this._setResult(st.id, '_manual', { status: 'done', startedAt: Date.now(), endedAt: Date.now() }); this.render(); });
        on('up', () => { if (idx > 0) { [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]]; this._changed(true); } });
        on('down', () => { if (idx < list.length - 1) { [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]]; this._changed(true); } });
        on('del', async () => {
          if (!(await global.uiConfirm('Delete step “' + st.title + '”?', { title: 'Delete step', okLabel: 'Delete', danger: true }))) return;
          list.splice(idx, 1);
          this._changed(true);
        });
        on('addcmd', () => { st.cmds.push(C.normalizeCmd({ cmd: '' })); this._changed(true); const boxes = R.querySelectorAll(`.rb-step[data-step="${st.id}"] .rb-code`); const b = boxes[boxes.length - 1]; if (b) b.focus(); });
        el.querySelectorAll('.rb-cmd').forEach((box) => {
          const c = st.cmds.find((x) => x.id === box.dataset.cmd);
          box.querySelectorAll('[data-cf]').forEach((inp) => inp.addEventListener('change', () => { c[inp.dataset.cf] = inp.type === 'checkbox' ? inp.checked : inp.value; this._changed(false); }));
          box.querySelector('.rb-code').addEventListener('input', (e) => { c.cmd = e.target.value; });
          const run = box.querySelector('[data-act="runcmd"]');
          if (run) run.addEventListener('click', async () => {
            if (this.busy) return;
            const code = box.querySelector('.rb-code');
            c.cmd = code.value;
            this.busy = true; this.stopReq = false; this.render();
            try { await this.runCmd(st, c, { kind: el.dataset.kind }); } finally { this.busy = false; this._changed(true); }
          });
          const del = box.querySelector('[data-act="delcmd"]');
          if (del) del.addEventListener('click', () => { st.cmds = st.cmds.filter((x) => x !== c); this._changed(true); });
        });
      });
    }
  }

  global.RunbookEngine = RunbookEngine;
})(typeof window !== 'undefined' ? window : this);
