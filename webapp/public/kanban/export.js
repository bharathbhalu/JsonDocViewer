/* Kanban board export — PNG, SVG, PDF, CSV. */
(function (global) {
  const C = global.KanbanCore;
  if (!C) return;

  const PAD = 24;
  const COL_W = 288;
  const COL_GAP = 14;
  const HEAD_H = 42;
  const CARD_PAD = 11;
  const TITLE_SIZE = 13;
  const TITLE_LH = 18;
  const META_H = 18;
  const LABEL_H = 8;
  const CARD_GAP = 8;
  const FOOT_H = 10;
  const BG = '#eef1f6';
  const COL_BG = '#f4f6fa';
  const CARD_BG = '#ffffff';
  const INK = '#1c2330';
  const MUTED = '#667085';
  const LINE = '#dfe3ea';
  // The CSS form feeds canvas text measurement; the XML form goes into SVG
  // attributes, where a raw double quote would terminate the attribute.
  const FONT_CSS = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif';
  const FONT = 'ui-sans-serif,system-ui,-apple-system,&quot;Segoe UI&quot;,Inter,sans-serif';

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function beginSave(defaultName, mime, ext) {
    const suggested = defaultName.toLowerCase().endsWith('.' + ext) ? defaultName : defaultName + '.' + ext;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: ext.toUpperCase() + ' file', accept: { [mime]: ['.' + ext] } }],
        });
        return { handle };
      } catch (err) {
        if (err && err.name === 'AbortError') return { cancelled: true };
      }
    }
    return { fallback: true, suggested };
  }

  async function finishSave(target, blob, ext) {
    if (!target || target.cancelled) return;
    if (target.handle) {
      const writable = await target.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    let name = target.suggested || ('kanban.' + ext);
    try {
      const typed = window.prompt('File name', name);
      if (typed == null) return;
      name = typed.trim() || name;
    } catch (e) { /* ignore */ }
    if (!name.toLowerCase().endsWith('.' + ext)) name += '.' + ext;
    download(blob, name);
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

  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function q(v) {
    return Math.round(Number(v) * 10) / 10;
  }

  function wrapToWidth(text, font, maxWidth, maxLines) {
    const ctx = wrapToWidth.ctx || (wrapToWidth.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = font;
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return [];
    const words = source.split(' ');
    const lines = [];
    let line = '';
    words.forEach((word) => {
      const trial = line ? line + ' ' + word : word;
      if (ctx.measureText(trial).width <= maxWidth) {
        line = trial;
        return;
      }
      if (line) lines.push(line);
      line = word;
    });
    if (line) lines.push(line);
    const cap = maxLines || 8;
    if (lines.length <= cap) return lines;
    const kept = lines.slice(0, cap);
    kept[cap - 1] = kept[cap - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }

  function formatDue(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[Number(p[1]) - 1]} ${Number(p[2])}`;
  }

  // Lay the board out from the data model so export never depends on the DOM.
  function layout(data) {
    const titleFont = `500 ${TITLE_SIZE}px ${FONT_CSS}`;
    const columns = [];
    let maxBody = 0;
    (data.columns || []).forEach((col) => {
      const cards = C.columnCards(data, col.id, { filters: null, showArchived: data.view && data.view.showArchived });
      let y = HEAD_H + 6;
      const laid = cards.map((card) => {
        const hasLabels = !!(card.labels || []).length;
        const lines = wrapToWidth(card.title || 'Untitled', titleFont, COL_W - CARD_PAD * 2 - 16, 6);
        const meta = [];
        const prio = C.priorityMeta(card.priority);
        if (prio) meta.push({ type: 'prio', text: prio.label, color: prio.hex });
        if (card.due) meta.push({ type: 'due', text: formatDue(card.due), state: C.dueState(card) });
        const progress = C.checklistProgress(card);
        if (progress.total) meta.push({ type: 'check', text: `${progress.done}/${progress.total}`, ratio: progress.ratio });
        const member = (data.members || []).find((m) => m.id === card.assignee);
        if (member) meta.push({ type: 'who', text: member.name, color: member.color });
        const h = CARD_PAD * 2
          + (hasLabels ? LABEL_H : 0)
          + Math.max(1, lines.length) * TITLE_LH
          + (meta.length ? META_H : 0);
        const item = { card, lines, meta, y, h, hasLabels };
        y += h + CARD_GAP;
        return item;
      });
      const bodyH = Math.max(y - CARD_GAP + FOOT_H, HEAD_H + 54);
      maxBody = Math.max(maxBody, bodyH);
      columns.push({ col, cards: laid, h: bodyH, count: cards.length });
    });
    const width = PAD * 2 + Math.max(COL_W, columns.length * COL_W + Math.max(0, columns.length - 1) * COL_GAP);
    const height = PAD * 2 + 44 + maxBody;
    return { columns, width, height, bodyH: maxBody };
  }

  function buildSvg(data) {
    const plan = layout(data);
    const parts = [];
    const w = plan.width;
    const h = plan.height;
    parts.push(`<rect width="${q(w)}" height="${q(h)}" fill="${BG}"/>`);
    parts.push(`<text x="${PAD}" y="${PAD + 20}" fill="${INK}" font-size="19" font-weight="700" font-family="${FONT}">${escapeXml(data.title || 'Board')}</text>`);

    const stats = C.boardStats(data);
    const summary = [`${stats.total} cards`]
      .concat(stats.overdue ? [`${stats.overdue} overdue`] : [])
      .concat(stats.checklist.total ? [`${stats.checklist.done}/${stats.checklist.total} checklist done`] : [])
      .join('  ·  ');
    parts.push(`<text x="${q(w - PAD)}" y="${PAD + 19}" text-anchor="end" fill="${MUTED}" font-size="11.5" font-weight="600" font-family="${FONT}">${escapeXml(summary)}</text>`);

    const top = PAD + 44;
    plan.columns.forEach((entry, i) => {
      const x = PAD + i * (COL_W + COL_GAP);
      parts.push(`<rect x="${q(x)}" y="${q(top)}" width="${COL_W}" height="${q(plan.bodyH)}" rx="12" fill="${COL_BG}" stroke="${LINE}" stroke-width="1"/>`);
      parts.push(`<circle cx="${q(x + 18)}" cy="${q(top + 21)}" r="4.5" fill="${escapeXml(entry.col.color || '#8c93a8')}"/>`);
      parts.push(`<text x="${q(x + 30)}" y="${q(top + 25)}" fill="${INK}" font-size="12.5" font-weight="700" font-family="${FONT}">${escapeXml(entry.col.title || 'Column')}</text>`);
      const countText = entry.col.wip ? `${entry.count}/${entry.col.wip}` : String(entry.count);
      parts.push(`<text x="${q(x + COL_W - 14)}" y="${q(top + 25)}" text-anchor="end" fill="${MUTED}" font-size="11.5" font-weight="700" font-family="${FONT}">${escapeXml(countText)}</text>`);

      if (!entry.cards.length) {
        parts.push(`<text x="${q(x + COL_W / 2)}" y="${q(top + HEAD_H + 26)}" text-anchor="middle" fill="#98a2b3" font-size="11.5" font-family="${FONT}">No cards</text>`);
      }

      entry.cards.forEach((item) => {
        const cy = top + item.y;
        const cx = x + 10;
        const cw = COL_W - 20;
        const opacity = item.card.archived ? 0.6 : 1;
        parts.push(`<g opacity="${opacity}">`);
        parts.push(`<rect x="${q(cx)}" y="${q(cy)}" width="${q(cw)}" height="${q(item.h)}" rx="9" fill="${CARD_BG}" stroke="${LINE}" stroke-width="1"/>`);
        if (item.card.cover) {
          parts.push(`<path d="M${q(cx)} ${q(cy + 9)} a9 9 0 0 1 9 -9 h${q(cw - 18)} a9 9 0 0 1 9 9 v2 h-${q(cw)} z" fill="${escapeXml(item.card.cover)}"/>`);
        }
        let ty = cy + CARD_PAD;
        if (item.hasLabels) {
          let lx = cx + CARD_PAD;
          (item.card.labels || []).forEach((id) => {
            const label = (data.labels || []).find((l) => l.id === id);
            if (!label) return;
            parts.push(`<rect x="${q(lx)}" y="${q(ty)}" width="30" height="4" rx="2" fill="${escapeXml(label.color)}"/>`);
            lx += 34;
          });
          ty += LABEL_H;
        }
        item.lines.forEach((line, li) => {
          const deco = item.card.archived ? ' text-decoration="line-through"' : '';
          parts.push(`<text x="${q(cx + CARD_PAD)}" y="${q(ty + TITLE_LH * li + TITLE_SIZE)}" fill="${INK}" font-size="${TITLE_SIZE}" font-weight="500" font-family="${FONT}"${deco}>${escapeXml(line)}</text>`);
        });
        ty += Math.max(1, item.lines.length) * TITLE_LH;

        if (item.meta.length) {
          let mx = cx + CARD_PAD;
          const my = ty + 11;
          item.meta.forEach((m) => {
            if (m.type === 'prio') {
              parts.push(`<circle cx="${q(mx + 3)}" cy="${q(my - 3)}" r="3.5" fill="${escapeXml(m.color)}"/>`);
              parts.push(`<text x="${q(mx + 10)}" y="${q(my)}" fill="${MUTED}" font-size="10.5" font-weight="650" font-family="${FONT}">${escapeXml(m.text)}</text>`);
              mx += 14 + m.text.length * 5.6;
              return;
            }
            if (m.type === 'due') {
              const color = m.state === 'overdue' ? '#f04438' : m.state === 'today' ? '#b75c00' : MUTED;
              parts.push(`<text x="${q(mx)}" y="${q(my)}" fill="${color}" font-size="10.5" font-weight="650" font-family="${FONT}">${escapeXml(m.text)}</text>`);
              mx += 10 + m.text.length * 5.6;
              return;
            }
            if (m.type === 'check') {
              parts.push(`<text x="${q(mx)}" y="${q(my)}" fill="${MUTED}" font-size="10.5" font-weight="650" font-family="${FONT}">${escapeXml(m.text)}</text>`);
              const bw = 26;
              const bx = mx + m.text.length * 5.8 + 4;
              parts.push(`<rect x="${q(bx)}" y="${q(my - 5)}" width="${bw}" height="3" rx="1.5" fill="#dfe3ea"/>`);
              parts.push(`<rect x="${q(bx)}" y="${q(my - 5)}" width="${q(bw * m.ratio)}" height="3" rx="1.5" fill="${m.ratio >= 1 ? '#12b76a' : '#4f6ef7'}"/>`);
              mx = bx + bw + 8;
              return;
            }
            if (m.type === 'who') {
              const ax = cx + cw - CARD_PAD - 9;
              parts.push(`<circle cx="${q(ax)}" cy="${q(my - 4)}" r="9" fill="${escapeXml(m.color)}"/>`);
              const parts2 = String(m.text).trim().split(/\s+/);
              const ini = parts2.length > 1
                ? (parts2[0][0] + parts2[parts2.length - 1][0]).toUpperCase()
                : parts2[0].slice(0, 2).toUpperCase();
              parts.push(`<text x="${q(ax)}" y="${q(my - 1)}" text-anchor="middle" fill="#ffffff" font-size="8.5" font-weight="700" font-family="${FONT}">${escapeXml(ini)}</text>`);
            }
          });
        }
        parts.push('</g>');
      });
    });

    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${q(w)}" height="${q(h)}" viewBox="0 0 ${q(w)} ${q(h)}">${parts.join('')}</svg>`;
  }

  function rasterize(svg, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxEdge = 4200;
        const scale = Math.min(2, maxEdge / Math.max(width, height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Could not render image'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  global.KanbanExport = {
    _v: 1,
    buildSvg,
    layout,
    async run(format, data, opts) {
      const o = opts || {};
      const base = String(o.name || data.title || 'kanban').replace(/[^\w.-]+/g, '_');

      if (format === 'csv') {
        const target = await beginSave(base + '.csv', 'text/csv', 'csv');
        if (target.cancelled) return;
        await finishSave(target, new Blob([C.toCsv(data)], { type: 'text/csv;charset=utf-8' }), 'csv');
        return;
      }

      const ext = format === 'svg' ? 'svg' : format === 'pdf' ? 'pdf' : 'png';
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'pdf' ? 'application/pdf' : 'image/png';
      const target = await beginSave(base + '.' + ext, mime, ext);
      if (target.cancelled) return;

      const svg = buildSvg(data);
      if (format === 'svg') {
        await finishSave(target, new Blob([svg], { type: mime }), ext);
        return;
      }
      const plan = layout(data);
      const canvas = await rasterize(svg, plan.width, plan.height);
      if (format === 'png') {
        const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => {
          if (!b) reject(new Error('Could not create PNG'));
          else resolve(b);
        }, 'image/png'));
        await finishSave(target, blob, ext);
        return;
      }
      if (format === 'pdf') await finishSave(target, await pdfBlobFromCanvas(canvas), ext);
    },
  };
})(typeof window !== 'undefined' ? window : this);
