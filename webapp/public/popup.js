// In-page popups that replace the browser's alert / confirm / prompt boxes.
//   uiAlert(message, opts)            -> Promise<void>
//   uiConfirm(message, opts)          -> Promise<boolean>
//   uiPrompt(message, value, opts)    -> Promise<string|null>
// opts: { title, okLabel, cancelLabel, danger, placeholder }
// window.alert is replaced too (it no longer blocks; nothing relies on that).
// Self-contained (injects its own styles) so standalone exports can bundle it.
(function (global) {
  if (global.uiConfirm) return;
  const doc = global.document;
  const CSS = `
.ui-pop-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,20,30,.38);animation:uiPopFade .12s ease-out}
.ui-pop{width:min(440px,100%);max-height:80vh;display:flex;flex-direction:column;background:var(--panel,#fff);color:var(--ink,#1c2330);border:1px solid var(--line-strong,rgba(28,35,48,.14));border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.25);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:uiPopIn .14s ease-out}
.ui-pop-title{padding:14px 16px 0;font-weight:700;font-size:15px}
.ui-pop-msg{padding:10px 16px 4px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere}
.ui-pop-in{margin:6px 16px 0;padding:8px 10px;font:inherit;border:1px solid var(--line-strong,rgba(28,35,48,.2));border-radius:8px;background:var(--bg,#f3f5f8);color:inherit;outline:none}
.ui-pop-in:focus{border-color:var(--accent,#4f6ef7);box-shadow:0 0 0 3px var(--accent-soft,rgba(79,110,247,.15))}
.ui-pop-acts{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px}
.ui-pop-acts button{padding:6px 14px;border-radius:8px;border:1px solid var(--line-strong,rgba(28,35,48,.2));background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.ui-pop-acts button:focus-visible{outline:2px solid var(--accent,#4f6ef7);outline-offset:2px}
.ui-pop-acts .ui-pop-ok{background:var(--accent,#4f6ef7);border-color:var(--accent,#4f6ef7);color:#fff}
.ui-pop-acts .ui-pop-ok.danger{background:#d64545;border-color:#d64545}
@media (prefers-color-scheme:dark){html:not([data-theme=light]) .ui-pop{background:var(--panel,#171c26);color:var(--ink,#e8ecf3)}}
@keyframes uiPopFade{from{opacity:0}}@keyframes uiPopIn{from{opacity:0;transform:translateY(6px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.ui-pop-ov,.ui-pop{animation:none}}`;
  function ensureStyle() {
    if (doc.getElementById('ui-pop-style')) return;
    const st = doc.createElement('style');
    st.id = 'ui-pop-style';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  const queue = [];
  let showing = false;
  function open(kind, message, value, opts) {
    return new Promise((resolve) => {
      queue.push({ kind, message, value, opts: opts || {}, resolve });
      next();
    });
  }
  function next() {
    if (showing || !queue.length) return;
    if (!doc.body) { doc.addEventListener('DOMContentLoaded', next, { once: true }); return; }
    showing = true;
    ensureStyle();
    const { kind, message, value, opts, resolve } = queue.shift();
    const prevFocus = doc.activeElement;
    const ov = doc.createElement('div');
    ov.className = 'ui-pop-ov';
    const box = doc.createElement('div');
    box.className = 'ui-pop';
    box.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (opts.title) {
      const t = doc.createElement('div');
      t.className = 'ui-pop-title';
      t.textContent = opts.title;
      box.appendChild(t);
    }
    const msg = doc.createElement('div');
    msg.className = 'ui-pop-msg';
    msg.textContent = message == null ? '' : String(message);
    box.appendChild(msg);
    let input = null;
    if (kind === 'prompt') {
      input = doc.createElement('input');
      input.className = 'ui-pop-in';
      input.type = 'text';
      input.value = value == null ? '' : String(value);
      if (opts.placeholder) input.placeholder = opts.placeholder;
      box.appendChild(input);
    }
    const acts = doc.createElement('div');
    acts.className = 'ui-pop-acts';
    let cancel = null;
    if (kind !== 'alert') {
      cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = opts.cancelLabel || 'Cancel';
      acts.appendChild(cancel);
    }
    const ok = doc.createElement('button');
    ok.type = 'button';
    ok.className = 'ui-pop-ok' + (opts.danger ? ' danger' : '');
    ok.textContent = opts.okLabel || 'OK';
    acts.appendChild(ok);
    box.appendChild(acts);
    ov.appendChild(box);
    doc.body.appendChild(ov);

    const finish = (result) => {
      ov.remove();
      doc.removeEventListener('keydown', onKey, true);
      showing = false;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* gone */ }
      resolve(result);
      next();
    };
    const cancelValue = kind === 'confirm' ? false : kind === 'prompt' ? null : undefined;
    const okValue = () => (kind === 'confirm' ? true : kind === 'prompt' ? input.value : undefined);
    // Capture phase so the page's own Escape / Enter handlers don't fire.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelValue); }
      else if (e.key === 'Enter' && (doc.activeElement === input || doc.activeElement === ok || !box.contains(doc.activeElement))) { e.preventDefault(); e.stopPropagation(); finish(okValue()); }
      else if (e.key === 'Tab') {
        const items = [input, cancel, ok].filter(Boolean);
        const i = items.indexOf(doc.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
      } else e.stopPropagation();
    };
    doc.addEventListener('keydown', onKey, true);
    ok.addEventListener('click', () => finish(okValue()));
    if (cancel) cancel.addEventListener('click', () => finish(cancelValue));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(cancelValue); });
    (input || (opts.danger && cancel) || ok).focus();
    if (input) input.select();
  }

  // Over the network: an expired sign-in sends the page back to /login.
  if (global.fetch && global.location && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(global.location.hostname)) {
    const realFetch = global.fetch.bind(global);
    global.fetch = async (...args) => {
      const res = await realFetch(...args);
      if (res.status === 401 && !/\/login$/.test(global.location.pathname)) global.location.href = '/login';
      return res;
    };
  }
  global.uiAlert = (message, opts) => open('alert', message, null, opts);
  global.uiConfirm = (message, opts) => open('confirm', message, null, opts);
  global.uiPrompt = (message, value, opts) => open('prompt', message, value, opts);
  global.alert = (message) => { open('alert', message, null, {}); };
})(typeof window !== 'undefined' ? window : this);
