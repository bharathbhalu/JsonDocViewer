/* Flow canvas / frame export — PNG, SVG, PDF. */
(function (global) {
  const C = global.FlowCore;
  if (!C) return;

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
    let name = target.suggested || ('flow.' + ext);
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

  function overlaps(a, rect) {
    return a.x < rect.x + rect.w && a.x + a.w > rect.x && a.y < rect.y + rect.h && a.y + a.h > rect.y;
  }

  function wrapToWidth(text, font, maxWidth) {
    const ctx = wrapToWidth.ctx || (wrapToWidth.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = font;
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return [];
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
    return lines.slice(0, 12);
  }

  function buildSvg(data, rect) {
    const ox = rect.x;
    const oy = rect.y;
    const w = Math.max(1, rect.w);
    const h = Math.max(1, rect.h);
    const parts = [];
    parts.push(`<rect width="${q(w)}" height="${q(h)}" fill="#eef1f5"/>`);

    (data.frames || []).forEach((f) => {
      if (!overlaps(f, rect)) return;
      const fill = C.hexAlpha(f.fill || '#ffffff', f.fillAlpha == null ? 1 : f.fillAlpha);
      parts.push(`<rect x="${q(f.x - ox)}" y="${q(f.y - oy)}" width="${q(f.w)}" height="${q(f.h)}" rx="16" fill="${escapeXml(fill)}" stroke="${escapeXml(f.border || '#c5c9d1')}" stroke-width="1.5" stroke-dasharray="7 6"/>`);
      parts.push(`<text x="${q(f.x - ox + 10)}" y="${q(f.y - oy - 14)}" fill="#5B7EAE" font-size="28" font-weight="800" font-family="system-ui,sans-serif">${escapeXml(f.title || 'Frame')}</text>`);
    });

    parts.push('<defs>');
    Object.keys(data.connectors || {}).forEach((id) => {
      const c = data.connectors[id];
      const color = C.hexAlpha((c.style && c.style.color) || '#5B7EAE', c.style && c.style.alpha);
      parts.push(`<marker id="ex-arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(color)}"/></marker>`);
    });
    parts.push('</defs>');

    const ranked = C.shapesByZ(data);
    const rankOf = {};
    ranked.forEach((s, i) => { rankOf[s.id] = i; });
    const cons = Object.keys(data.connectors || {}).map((id) => data.connectors[id]);

    function drawConnector(c) {
      const a = data.shapes[c.from.shapeId];
      const b = data.shapes[c.to.shapeId];
      if (!a || !b) return;
      const geo = C.connectorPath(a, c.from.port, b, c.to.port, c.style);
      const shifted = C.pointsToPath(geo.pts.map((p) => ({ x: p.x - ox, y: p.y - oy })), geo.route);
      const dash = C.dashArray(c.style.dash);
      const color = C.hexAlpha(c.style.color || '#5B7EAE', c.style.alpha);
      const arrow = c.style.arrow || 'end';
      const marker = (arrow === 'end' || arrow === 'both') ? `url(#ex-arrow-${c.id})` : '';
      const start = (arrow === 'start' || arrow === 'both') ? `url(#ex-arrow-${c.id})` : '';
      parts.push(`<path d="${shifted}" fill="none" stroke="${escapeXml(color)}" stroke-width="${c.style.width || 2}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="${marker}" marker-start="${start}"/>`);
      if (c.label) {
        const mid = { x: geo.mid.x - ox, y: geo.mid.y - oy };
        parts.push(`<text x="${q(mid.x)}" y="${q(mid.y - 8)}" text-anchor="middle" font-size="12" font-weight="650" fill="#1a2130">${escapeXml(c.label)}</text>`);
      }
    }

    function drawShape(s) {
      if (!overlaps(s, rect)) return;
      const x = s.x - ox;
      const y = s.y - oy;
      if (s.type === 'image') {
        const src = C.safeImageSrc(s.src);
        if (src) parts.push(`<image href="${escapeXml(src)}" x="${q(x)}" y="${q(y)}" width="${q(s.w)}" height="${q(s.h)}" opacity="${C.clamp01(s.style && s.style.opacity, 1)}" preserveAspectRatio="xMidYMid meet"/>`);
        drawNoteCard(s, x, y);
        return;
      }
      const d = C.shapePath(s.type, s.w, s.h);
      const fill = C.hexAlpha(s.style.fill || '#D7E3FC', s.style.fillAlpha);
      const stroke = C.hexAlpha(s.style.border || '#5B7EAE', s.style.borderAlpha);
      const dash = C.dashArray(s.style.borderDash);
      parts.push(`<g transform="translate(${q(x)} ${q(y)})"><path d="${d}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${C.borderStrokeWidth(s.style)}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${s.type === 'sticky' ? `<path d="${C.stickyFoldPath(s.w, s.h)}" fill="rgba(0,0,0,.08)"/>` : ''}</g>`);
      if (s.type === 'sticky' && s.collapsed) {
        const line = C.firstLine(s.text);
        if (line) {
          const fmt = Object.assign(C.defaultFormat(), s.format || {});
          const fs = Number(fmt.fontSize) || 14;
          const fam = C.fontCss(fmt.fontFamily);
          const weight = fmt.bold ? '700' : '650';
          const italic = fmt.italic ? 'italic' : 'normal';
          const extra = (italic === 'italic' ? ' font-style="italic"' : '') + (fmt.underline ? ' text-decoration="underline"' : '');
          parts.push(`<text x="${q(x + 12)}" y="${q(y + s.h / 2 + fs * 0.35)}" text-anchor="start" fill="${escapeXml(C.hexAlpha(s.style.textColor || '#1a2130', s.style.textAlpha))}" font-size="${fs}" font-weight="${weight}" font-family="${escapeXml(fam)}"${extra}>${escapeXml(line)}</text>`);
        }
      } else {
        const fmt = Object.assign(C.defaultFormat(), s.format || {});
        const fs = Number(fmt.fontSize) || 14;
        const fam = C.fontCss(fmt.fontFamily);
        const weight = fmt.bold ? '700' : '650';
        const italic = fmt.italic ? 'italic' : 'normal';
        const deco = fmt.underline ? 'underline' : 'none';
        const font = `${italic === 'italic' ? 'italic ' : ''}${weight} ${fs}px ${fam}`;
        const lines = wrapToWidth(s.text, font, Math.max(20, s.w - 24));
        const lineH = fs * 1.3;
        const block = lines.length * lineH;
        const startY = y + Math.max(fs, (s.type === 'sticky' ? 28 + fs * 0.82 : (s.h - block) / 2 + fs * 0.82));
        const align = fmt.align || 'center';
        const anchor = align === 'right' ? 'end' : align === 'left' ? 'start' : 'middle';
        const tx = align === 'right' ? x + s.w - 12 : align === 'left' ? x + 12 : x + s.w / 2;
        const extra = (italic === 'italic' ? ' font-style="italic"' : '') + (deco === 'underline' ? ' text-decoration="underline"' : '');
        lines.forEach((line, i) => {
          parts.push(`<text x="${q(tx)}" y="${q(startY + i * lineH)}" text-anchor="${anchor}" fill="${escapeXml(C.hexAlpha(s.style.textColor || '#1a2130', s.style.textAlpha))}" font-size="${fs}" font-weight="${weight}" font-family="${escapeXml(fam)}"${extra}>${escapeXml(line)}</text>`);
        });
      }
      drawNoteCard(s, x, y);
    }

    function drawNoteCard(s, x, y) {
      if (s.type === 'sticky' || !s.noteOpen) return;
      const nx = x + s.w + 10;
      const ny = y;
      const nw = 200;
      const nh = 150;
      parts.push(`<rect x="${q(nx)}" y="${q(ny)}" width="${q(nw)}" height="${q(nh)}" rx="8" fill="#fff6c8" stroke="#e0c36a" stroke-width="1"/>`);
      const noteFont = '13px "Segoe Print", "Comic Sans MS", cursive';
      const lines = wrapToWidth(s.note || '', noteFont, nw - 20).slice(0, 8);
      lines.forEach((line, i) => {
        parts.push(`<text x="${q(nx + 10)}" y="${q(ny + 28 + i * 16)}" text-anchor="start" fill="#1a2130" font-size="13">${escapeXml(line)}</text>`);
      });
    }

    ranked.forEach((s, i) => {
      drawShape(s);
      cons.forEach((c) => {
        const ra = rankOf[c.from.shapeId];
        const rb = rankOf[c.to.shapeId];
        if (Math.min(ra == null ? 0 : ra, rb == null ? 0 : rb) === i) drawConnector(c);
      });
    });

    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${q(w)}" height="${q(h)}" viewBox="0 0 ${q(w)} ${q(h)}">${parts.join('')}</svg>`;
  }

  function rasterize(svg, rect) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxEdge = 2200;
        const longest = Math.max(rect.w, rect.h, 1);
        const scale = Math.min(2, maxEdge / longest);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.w * scale));
        canvas.height = Math.max(1, Math.round(rect.h * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#eef1f5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Could not render PNG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  global.FlowExport = {
    async run(format, rect, data) {
      const base = (rect.name || 'flow').replace(/[^\w.-]+/g, '_');
      const ext = format === 'svg' ? 'svg' : format === 'pdf' ? 'pdf' : 'png';
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'pdf' ? 'application/pdf' : 'image/png';
      const target = await beginSave(base + '.' + ext, mime, ext);
      if (target.cancelled) return;
      const svg = buildSvg(data, rect);
      if (format === 'svg') {
        await finishSave(target, new Blob([svg], { type: mime }), ext);
        return;
      }
      const canvas = await rasterize(svg, rect);
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
