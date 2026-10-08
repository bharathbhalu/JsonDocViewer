/* Gantt export — PNG, SVG, PDF, CSV. */
(function (global) {
  const C = global.GanttCore;
  if (!C) return;

  const PAD = 28;
  const ROW = 36;
  const LABEL_W = 220;
  const MONTH_H = 24;
  const DAY_H = 28;
  const HEAD = MONTH_H + DAY_H;
  const BG = '#f4f6fa';
  const INK = '#1c2330';
  const MUTED = '#667085';
  const LINE = '#e4e7ec';
  const TODAY = '#f04438';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FONT = 'ui-sans-serif,system-ui,-apple-system,&quot;Segoe UI&quot;,Inter,sans-serif';

  function q(n) {
    return Math.round(n * 100) / 100;
  }

  function escapeXml(s) {
    return String(s == null ? '' : s)
      // Control characters are not allowed in XML and break the SVG.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not prepare file'));
      reader.readAsDataURL(blob);
    });
  }

  async function prepareSave(blob, filename) {
    if (location.protocol !== 'file:') {
      try {
        const dataUrl = await readAsDataUrl(blob);
        const comma = dataUrl.indexOf(',');
        const res = await fetch('/api/transient-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: filename,
            type: blob.type || 'application/octet-stream',
            data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
          }),
        });
        if (res.ok) {
          const json = await res.json();
          if (json && json.id) return { kind: 'id', id: json.id };
        }
      } catch (err) { /* standalone or offline */ }
    }
    return { kind: 'data', href: await readAsDataUrl(blob) };
  }

  function triggerSave(token, filename) {
    if (token.kind === 'id') {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
      frame.src = '/api/transient-download/' + encodeURIComponent(token.id)
        + '?name=' + encodeURIComponent(filename);
      document.body.appendChild(frame);
      setTimeout(() => frame.remove(), 60000);
      return;
    }
    const a = document.createElement('a');
    a.href = token.href;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function saveBlob(blob, suggested, ext, label) {
    const token = await prepareSave(blob, suggested);
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'gt-dialog';
      wrap.innerHTML = '<div class="gt-dialog-panel" role="dialog" aria-modal="true">'
        + '<h3>Save ' + escapeXml(label) + '</h3>'
        + '<p>Choose a file name. The file downloads when you save.</p>'
        + '<input class="gt-dialog-input" type="text" aria-label="File name">'
        + '<div class="gt-dialog-actions"><button type="button" class="gt-btn gt-ghost" data-act="cancel">Cancel</button>'
        + '<button type="button" class="gt-btn gt-primary" data-act="ok">Save</button></div></div>';
      document.body.appendChild(wrap);
      const input = wrap.querySelector('input');
      input.value = suggested;
      const dot = suggested.lastIndexOf('.');
      const close = () => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve();
      };
      const commit = () => {
        let name = String(input.value || '').trim() || suggested;
        if (!name.toLowerCase().endsWith('.' + ext)) name += '.' + ext;
        triggerSave(token, name);
        close();
      };
      const onKey = (ev) => {
        if (ev.key !== 'Escape' && ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Enter') commit();
        else close();
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', (ev) => {
        if (ev.target === wrap) close();
      });
      wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
      wrap.querySelector('[data-act="ok"]').addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        commit();
      });
      input.focus();
      input.setSelectionRange(0, dot > 0 ? dot : suggested.length);
    });
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) reject(new Error('Could not create PDF image'));
        else resolve(blob);
      }, 'image/jpeg', quality || 0.92);
    });
  }

  async function pdfBlobFromCanvas(canvas) {
    const jpeg = new Uint8Array(await (await canvasToJpeg(canvas, 0.92)).arrayBuffer());
    const w = canvas.width;
    const h = canvas.height;
    const enc = new TextEncoder();
    const parts = [];
    let pos = 0;
    const offs = [];
    function push(data) {
      const u8 = typeof data === 'string' ? enc.encode(data) : data;
      parts.push(u8);
      pos += u8.length;
    }
    function obj(num, body) {
      offs[num] = pos;
      push(String(num) + ' 0 obj\n' + body + '\nendobj\n');
    }
    push('%PDF-1.3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>');
    const stream = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
    obj(4, '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    offs[5] = pos;
    push('5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
    push(jpeg);
    push('\nendstream\nendobj\n');
    const xref = pos;
    push('xref\n0 6\n0000000000 65535 f \n');
    for (let i = 1; i <= 5; i++) push(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
    push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
    return new Blob(parts, { type: 'application/pdf' });
  }

  function colorOf(data, task) {
    if (task.color) return task.color;
    let cur = task;
    const seen = new Set();
    while (cur && cur.parentId && data.tasks[cur.parentId] && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = data.tasks[cur.parentId];
    }
    if (cur && cur.color) return cur.color;
    const roots = C.childrenOf(data, null);
    const at = Math.max(0, roots.findIndex((r) => cur && r.id === cur.id));
    return C.COLORS[at % C.COLORS.length];
  }

  function layout(data) {
    const tasks = C.visibleTasks(data);
    const range = C.chartBounds(data);
    const px = Math.max(8, C.pxPerDay(data.view && data.view.zoom));
    const days = C.diffDays(range.start, range.end) + 1;
    const width = PAD + LABEL_W + days * px + PAD;
    const height = PAD + 36 + HEAD + Math.max(tasks.length, 1) * ROW + PAD;
    return { tasks, range, px, days, width, height };
  }

  function depPath(x1, y1, x2, y2) {
    if (x2 >= x1 + 14) {
      const mid = Math.round((x1 + x2) / 2);
      return 'M ' + q(x1) + ' ' + q(y1) + ' H ' + q(mid) + ' V ' + q(y2) + ' H ' + q(x2);
    }
    const out = x1 + 14;
    const back = x2 - 14;
    const midY = y1 + (y2 >= y1 ? 14 : -14);
    return 'M ' + q(x1) + ' ' + q(y1) + ' H ' + q(out) + ' V ' + q(midY) + ' H ' + q(back) + ' V ' + q(y2) + ' H ' + q(x2);
  }

  function buildSvg(data) {
    const plan = layout(data);
    const zoom = (data.view && data.view.zoom) || 'day';
    const parts = [];
    const boxes = {};
    parts.push('<rect x="0" y="0" width="' + q(plan.width) + '" height="' + q(plan.height) + '" fill="' + BG + '"/>');
    parts.push('<text x="' + PAD + '" y="' + (PAD + 18) + '" fill="' + INK + '" font-size="18" font-weight="700" font-family="' + FONT + '">' + escapeXml(data.title || 'Gantt') + '</text>');
    const top = PAD + 36;
    const x0 = PAD + LABEL_W;
    const bodyTop = top + HEAD;
    const bodyH = Math.max(plan.tasks.length, 1) * ROW;
    parts.push('<rect x="' + PAD + '" y="' + top + '" width="' + LABEL_W + '" height="' + HEAD + '" fill="#ffffff"/>');
    parts.push('<text x="' + (PAD + 12) + '" y="' + (top + 32) + '" fill="' + MUTED + '" font-size="11" font-weight="700" font-family="' + FONT + '">TASK</text>');
    let i = 0;
    while (i < plan.days) {
      const iso = C.addDays(plan.range.start, i);
      const key = iso.slice(0, 7);
      let j = i + 1;
      while (j < plan.days && C.addDays(plan.range.start, j).slice(0, 7) === key) j += 1;
      const x = x0 + i * plan.px;
      const w = (j - i) * plan.px;
      parts.push('<rect x="' + q(x) + '" y="' + top + '" width="' + q(w) + '" height="' + MONTH_H + '" fill="#ffffff" stroke="' + LINE + '"/>');
      const full = MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4);
      const label = w >= 96 ? full : w >= 36 ? MONTHS[Number(iso.slice(5, 7)) - 1] : '';
      if (label) parts.push('<text x="' + q(x + 8) + '" y="' + (top + 16) + '" fill="' + INK + '" font-size="12" font-weight="700" font-family="' + FONT + '">' + escapeXml(label) + '</text>');
      i = j;
    }
    parts.push('<rect x="' + q(x0) + '" y="' + (top + MONTH_H) + '" width="' + q(plan.days * plan.px) + '" height="' + DAY_H + '" fill="#ffffff"/>');
    for (let d = 0; d < plan.days; d++) {
      const iso = C.addDays(plan.range.start, d);
      const x = x0 + d * plan.px;
      const wd = new Date(C.parseDay(iso)).getUTCDay();
      const weekend = wd === 0 || wd === 6;
      const monthStart = zoom === 'month' && iso.slice(8) === '01';
      const show = zoom === 'day' || (zoom === 'week' && weekend) || monthStart;
      const shade = (!data.view || data.view.showWeekends !== false) && ((zoom === 'day' || zoom === 'week') && weekend);
      if (monthStart) {
        parts.push('<rect x="' + q(x) + '" y="' + (top + MONTH_H) + '" width="1" height="' + q(DAY_H + bodyH) + '" fill="#d0d5dd"/>');
      }
      if (shade) {
        parts.push('<rect x="' + q(x) + '" y="' + (top + MONTH_H) + '" width="' + q(plan.px) + '" height="' + q(DAY_H + bodyH) + '" fill="#e8ebf0"/>');
      }
      if (!show) continue;
      const dayNum = Number(iso.slice(8));
      const text = zoom === 'day' || monthStart ? (monthStart ? MONTHS[Number(iso.slice(5, 7)) - 1] : String(dayNum)) : MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + dayNum;
      const fill = iso === plan.range.today ? TODAY : weekend ? MUTED : INK;
      const anchor = monthStart ? 'start' : 'middle';
      const textX = monthStart ? x + 3 : x + plan.px / 2;
      parts.push('<text x="' + q(textX) + '" y="' + (top + MONTH_H + 18) + '" text-anchor="' + anchor + '" fill="' + fill + '" font-size="11" font-weight="700" font-family="' + FONT + '">' + escapeXml(text) + '</text>');
    }
    const todayAt = C.diffDays(plan.range.start, plan.range.today);
    if (todayAt >= 0 && todayAt < plan.days) {
      const x = x0 + todayAt * plan.px + plan.px / 2;
      parts.push('<rect x="' + q(x - 1) + '" y="' + (top + MONTH_H) + '" width="2" height="' + q(bodyTop + bodyH - top - MONTH_H) + '" fill="' + TODAY + '"/>');
    }
    plan.tasks.forEach((task, index) => {
      const y = bodyTop + index * ROW;
      const shade = index % 2 ? '#f8f9fb' : '#ffffff';
      parts.push('<rect x="' + PAD + '" y="' + y + '" width="' + LABEL_W + '" height="' + ROW + '" fill="' + shade + '"/>');
      const depth = C.depthOf(data, task.id);
      const name = task.title || 'Untitled';
      parts.push('<text x="' + (PAD + 12 + depth * 14) + '" y="' + (y + 23) + '" fill="' + INK + '" font-size="12" font-weight="' + (C.hasChildren(data, task.id) ? '700' : '550') + '" font-family="' + FONT + '">' + escapeXml(name) + '</text>');
      const color = colorOf(data, task);
      const cy = y + ROW / 2;
      if (task.milestone) {
        const cx = x0 + C.diffDays(plan.range.start, task.start) * plan.px + plan.px / 2;
        boxes[task.id] = { x1: cx - 8, x2: cx + 8, y: cy };
        parts.push('<polygon points="' + q(cx) + ',' + q(cy - 7) + ' ' + q(cx + 7) + ',' + q(cy) + ' ' + q(cx) + ',' + q(cy + 7) + ' ' + q(cx - 7) + ',' + q(cy) + '" fill="' + color + '"/>');
      } else {
        const x = x0 + C.diffDays(plan.range.start, task.start) * plan.px + 2;
        const w = Math.max(plan.px - 4, C.durationDays(task) * plan.px - 4);
        boxes[task.id] = { x1: x, x2: x + w, y: cy };
        const barY = C.hasChildren(data, task.id) ? y + 15 : y + 8;
        const barH = C.hasChildren(data, task.id) ? 6 : 18;
        parts.push('<rect x="' + q(x) + '" y="' + barY + '" width="' + q(w) + '" height="' + barH + '" rx="4" fill="' + color + '"/>');
        const pct = Math.round(Number(task.progress) || 0);
        const summary = C.hasChildren(data, task.id);
        if (!summary && pct) {
          parts.push('<rect x="' + q(x) + '" y="' + barY + '" width="' + q(w * (pct / 100)) + '" height="' + barH + '" rx="4" fill="#ffffff" fill-opacity="0.28"/>');
        }
      }
    });
    plan.tasks.forEach((task) => {
      const to = boxes[task.id];
      if (!to) return;
      (task.deps || []).forEach((predId) => {
        const from = boxes[predId];
        if (!from) return;
        parts.push('<path d="' + depPath(from.x2, from.y, to.x1, to.y) + '" fill="none" stroke="#98a2b3" stroke-width="1.4"/>');
        parts.push('<polygon points="' + q(to.x1) + ',' + q(to.y) + ' ' + q(to.x1 - 7) + ',' + q(to.y - 3.5) + ' ' + q(to.x1 - 7) + ',' + q(to.y + 3.5) + '" fill="#98a2b3"/>');
      });
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + q(plan.width) + '" height="' + q(plan.height) + '" viewBox="0 0 ' + q(plan.width) + ' ' + q(plan.height) + '">' + parts.join('') + '</svg>';
  }

  function rasterize(svg, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const finish = (err, canvas) => {
        URL.revokeObjectURL(url);
        if (err) reject(err);
        else resolve(canvas);
      };
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) {
          finish(new Error('Could not render image'));
          return;
        }
        const scale = Math.min(2, 4200 / Math.max(width, height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        finish(null, canvas);
      };
      img.onerror = () => finish(new Error('Could not render image'));
      img.src = url;
    });
  }

  global.GanttExport = {
    _v: 10,
    buildSvg,
    layout,
    async run(format, data, opts) {
      const o = opts || {};
      const base = String(o.name || data.title || 'gantt').replace(/[^\w.-]+/g, '_');
      if (format === 'csv') {
        await saveBlob(new Blob([C.toCsv(data)], { type: 'text/csv;charset=utf-8' }), base + '.csv', 'csv', 'CSV');
        return;
      }
      const ext = format === 'svg' ? 'svg' : format === 'pdf' ? 'pdf' : 'png';
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'pdf' ? 'application/pdf' : 'image/png';
      const svg = buildSvg(data);
      if (format === 'svg') {
        await saveBlob(new Blob([svg], { type: mime }), base + '.svg', ext, 'SVG');
        return;
      }
      const plan = layout(data);
      const canvas = await rasterize(svg, plan.width, plan.height);
      if (format === 'png') {
        const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => {
          if (!b) reject(new Error('Could not create PNG'));
          else resolve(b);
        }, 'image/png'));
        await saveBlob(blob, base + '.png', ext, 'PNG');
        return;
      }
      if (format === 'pdf') await saveBlob(await pdfBlobFromCanvas(canvas), base + '.pdf', ext, 'PDF');
    },
  };

})(typeof window !== 'undefined' ? window : this);
