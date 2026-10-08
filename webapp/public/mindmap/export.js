(function (global) {
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
    let name = target.suggested || ('mindmap.' + ext);
    try {
      const typed = window.uiPrompt ? await window.uiPrompt('File name', name, { title: 'Save as', okLabel: 'Save' }) : name;
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

  function bezier(a, b, dir) {
    if (dir === 'right' || dir === 'left') {
      const s = dir === 'right' ? 1 : -1;
      const c = Math.max(40, Math.abs(b.x - a.x) * 0.45);
      return `M ${q(a.x)} ${q(a.y)} C ${q(a.x + s * c)} ${q(a.y)}, ${q(b.x - s * c)} ${q(b.y)}, ${q(b.x)} ${q(b.y)}`;
    }
    const s = dir === 'down' ? 1 : -1;
    const c = Math.max(40, Math.abs(b.y - a.y) * 0.45);
    return `M ${q(a.x)} ${q(a.y)} C ${q(a.x)} ${q(a.y + s * c)}, ${q(b.x)} ${q(b.y - s * c)}, ${q(b.x)} ${q(b.y)}`;
  }

  function isTransparent(v) {
    const s = String(v || '').trim().toLowerCase();
    return !s || s === 'transparent' || s === 'none' || s === 'rgba(0, 0, 0, 0)' || s === 'rgba(0,0,0,0)';
  }

  function channelTo255(v) {
    const s = String(v).trim();
    if (s.endsWith('%')) return Math.round(Math.max(0, Math.min(100, parseFloat(s))) * 2.55);
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return 0;
    if (n <= 1) return Math.round(Math.max(0, Math.min(1, n)) * 255);
    return Math.round(Math.max(0, Math.min(255, n)));
  }

  function srgbToCss(r, g, b, a) {
    const R = channelTo255(r);
    const G = channelTo255(g);
    const B = channelTo255(b);
    if (a == null || a === '') return 'rgb(' + R + ', ' + G + ', ' + B + ')';
    const alpha = String(a).trim().endsWith('%') ? Math.max(0, Math.min(100, parseFloat(a))) / 100 : parseFloat(a);
    if (!Number.isFinite(alpha) || alpha >= 1) return 'rgb(' + R + ', ' + G + ', ' + B + ')';
    return 'rgba(' + R + ', ' + G + ', ' + B + ', ' + Math.max(0, Math.min(1, alpha)) + ')';
  }

  let colorCtx;
  function cssColor(value, fallback) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || isTransparent(raw)) return 'none';
    try {
      if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = raw;
      const parsed = colorCtx.fillStyle;
      if (parsed && !/color\s*\(|color-mix|oklch|oklab/i.test(parsed)) return parsed;
    } catch (e) { /* ignore */ }
    const srgb = raw.match(/color\(\s*srgb(?:-linear)?\s+([^\s,/]+)\s+([^\s,/]+)\s+([^\s,/]+)(?:\s*\/\s*([^\s)]+))?\s*\)/i);
    if (srgb) return srgbToCss(srgb[1], srgb[2], srgb[3], srgb[4]);
    if (/^#|^rgb|^hsl/i.test(raw)) return raw;
    return fallback || '#1a2130';
  }

  function fontFamilyOf(format) {
    const id = format && format.fontFamily;
    if (id === 'serif') return 'Georgia, "Times New Roman", Times, serif';
    if (id === 'mono') return 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    if (id === 'hand') return '"Segoe Print", "Comic Sans MS", cursive';
    if (id === 'rounded') return '"Trebuchet MS", "Segoe UI Rounded", sans-serif';
    return 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  }

  let measureCtx;
  function wrapToWidth(text, font, maxWidth) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let line = '';
    const pushHard = (word) => {
      let chunk = '';
      for (let i = 0; i < word.length; i++) {
        const next = chunk + word[i];
        if (chunk && measureCtx.measureText(next).width > maxWidth) {
          lines.push(chunk);
          chunk = word[i];
        } else chunk = next;
      }
      return chunk;
    };
    words.forEach((word) => {
      const trial = line ? line + ' ' + word : word;
      if (measureCtx.measureText(trial).width <= maxWidth) {
        line = trial;
        return;
      }
      if (line) lines.push(line);
      if (measureCtx.measureText(word).width > maxWidth) line = pushHard(word);
      else line = word;
    });
    if (line) lines.push(line);
    return lines;
  }

  // Code keeps its line breaks and indentation; long lines hard-wrap.
  function wrapCodeToWidth(text, font, maxWidth) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const out = [];
    String(text || '').replace(/\t/g, '  ').split('\n').forEach((raw) => {
      let chunk = '';
      for (let i = 0; i < raw.length; i++) {
        const next = chunk + raw[i];
        if (chunk && measureCtx.measureText(next).width > maxWidth) {
          out.push(chunk);
          chunk = raw[i];
        } else chunk = next;
      }
      out.push(chunk);
    });
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  // An SVG drawn through <img> (PNG/PDF export) can't load outside URLs, so
  // embed http(s) images as data URLs first. Failures (e.g. CORS) keep the URL.
  async function inlineImages(scene) {
    const map = {};
    const urls = [...new Set((scene.nodes || [])
      .filter((n) => n && n.type === 'image' && /^https?:/i.test(String(n.content || '')))
      .map((n) => String(n.content)))];
    await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return;
        const blob = await res.blob();
        map[url] = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
      } catch (e) { /* leave as URL */ }
    }));
    return map;
  }

  function nodeLabel(n, el) {
    if (n) {
      if (n.type === 'link') return String(n.label || n.content || 'Link');
      if (n.type === 'youtube') return 'YouTube';
      if (n.type === 'image') return 'Image';
      if (n.type === 'code') return String(n.content || '');
      return String(n.content || '');
    }
    if (!el) return '';
    const body = el.querySelector('.mm-node-body, .mm-link-anchor, .mm-code');
    return body ? String(body.textContent || '').trim() : '';
  }

  function overlaps(a, rect) {
    return a.x < rect.x + rect.w && a.x + a.w > rect.x && a.y < rect.y + rect.h && a.y + a.h > rect.y;
  }

  function linkOverlaps(l, rect) {
    const pad = 90;
    const minX = Math.min(l.a.x, l.b.x) - pad;
    const maxX = Math.max(l.a.x, l.b.x) + pad;
    const minY = Math.min(l.a.y, l.b.y) - pad;
    const maxY = Math.max(l.a.y, l.b.y) + pad;
    return minX < rect.x + rect.w && maxX > rect.x && minY < rect.y + rect.h && maxY > rect.y;
  }

  function linksGroup(scene, rect, ox, oy) {
    const parts = [];
    (scene.links || []).forEach((l) => {
      if (!linkOverlaps(l, rect)) return;
      const a = { x: l.a.x - ox, y: l.a.y - oy };
      const b = { x: l.b.x - ox, y: l.b.y - oy };
      const dash = l.dash ? ` stroke-dasharray="${escapeXml(l.dash)}"` : '';
      parts.push(`<path d="${bezier(a, b, l.dir)}" fill="none" stroke="${escapeXml(cssColor(l.color, '#8AA8D4'))}" stroke-width="${q(l.width || 2.25)}" stroke-linecap="round"${dash}/>`);
    });
    return parts.join('');
  }

  function buildSvg(scene, rect, els, opts) {
    const compact = !!(opts && opts.compact);
    const imageData = (opts && opts.images) || {};
    const ox = rect.x;
    const oy = rect.y;
    const w = Math.max(1, rect.w);
    const h = Math.max(1, rect.h);
    const parts = [];
    parts.push(`<rect width="${q(w)}" height="${q(h)}" fill="#fafafa"/>`);
    if (!compact) {
      parts.push(`<defs><pattern id="mmDots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="0.8" cy="0.8" r="0.7" fill="rgba(15,23,42,0.06)"/></pattern></defs>`);
      parts.push(`<rect width="${q(w)}" height="${q(h)}" fill="url(#mmDots)"/>`);
    }

    const frames = (els && els.world)
      ? [...els.world.querySelectorAll('.mm-frame')].map((el) => {
        const x = parseFloat(el.style.left) || 0;
        const y = parseFloat(el.style.top) || 0;
        const fw = parseFloat(el.style.width) || el.offsetWidth;
        const fh = parseFloat(el.style.height) || el.offsetHeight;
        const cs = getComputedStyle(el);
        const title = el.querySelector('.mm-frame-title');
        return {
          x, y, w: fw, h: fh,
          fill: cssColor(el.style.background || cs.backgroundColor, '#ffffff'),
          border: cssColor(el.style.borderColor || cs.borderColor, '#c5c9d1'),
          title: title ? title.textContent.trim() : 'Frame',
          titleColor: title ? cssColor(title.style.color || getComputedStyle(title).color, '#5B7EAE') : '#5B7EAE',
          dashed: (cs.borderStyle || 'dashed') !== 'solid',
        };
      })
      : (scene.frames || []).map((f) => {
        const fill = isTransparent(f.fill) ? 'none' : (f.fill || '#ffffff');
        return {
          x: f.x, y: f.y, w: f.w, h: f.h,
          fill, border: isTransparent(f.border) ? 'none' : (f.border || '#c5c9d1'),
          title: f.title || 'Frame',
          titleColor: '#5B7EAE',
          dashed: true,
        };
      });

    frames.forEach((f) => {
      if (!overlaps(f, rect)) return;
      const dash = f.dashed ? ' stroke-dasharray="7 6"' : '';
      const fill = isTransparent(f.fill) ? 'none' : f.fill;
      const stroke = isTransparent(f.border) ? 'none' : f.border;
      parts.push(`<rect x="${q(f.x - ox)}" y="${q(f.y - oy)}" width="${q(f.w)}" height="${q(f.h)}" rx="16" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1.5"${dash}/>`);
      parts.push(`<text x="${q(f.x - ox + 10)}" y="${q(f.y - oy - 18)}" fill="#5B7EAE" font-size="34" font-weight="800" font-family="system-ui,sans-serif">${escapeXml(f.title)}</text>`);
    });

    parts.push(linksGroup(scene, rect, ox, oy));

    const nodeById = {};
    (scene.nodes || []).forEach((n) => { nodeById[n.id] = n; });
    const nodeEls = (els && els.world) ? [...els.world.querySelectorAll('.mm-node')] : [];
    const nodeList = nodeEls.length
      ? nodeEls.map((el) => ({ el, n: nodeById[el.dataset.id] }))
      : (scene.nodes || []).map((n) => ({ el: null, n }));

    nodeList.forEach(({ el, n: node }) => {
      if (el && el.style.display === 'none') return;
      const x = node ? node.x : parseFloat(el.style.left) || 0;
      const y = node ? node.y : parseFloat(el.style.top) || 0;
      const nw = node ? node.w : (el.offsetWidth || 148);
      const nh = node ? node.h : (el.offsetHeight || 48);
      if (!overlaps({ x, y, w: nw, h: nh }, rect)) return;
      let fill = node && node.style ? node.style.fill : '#D7E3FC';
      let border = node && node.style ? node.style.border : fill;
      let color = node && node.style ? node.style.textColor : '#1a2130';
      if (el) {
        const cs = getComputedStyle(el);
        fill = el.style.background || cs.backgroundColor || fill;
        border = el.style.borderColor || cs.borderColor || border;
        color = el.style.color || cs.color || color;
      }
      fill = isTransparent(fill) ? 'none' : cssColor(fill, '#D7E3FC');
      border = isTransparent(border) ? 'none' : cssColor(border, fill === 'none' ? '#c5c9d1' : fill);
      color = cssColor(color, '#1a2130');
      const fmt = (node && node.format) || {};
      const fs = Number(fmt.fontSize) || (el ? parseFloat(getComputedStyle(el).fontSize) : 18) || 18;
      const weight = fmt.bold ? '700' : (el && getComputedStyle(el).fontWeight) || '500';
      const italic = fmt.italic ? 'italic' : 'normal';
      const deco = fmt.underline ? 'underline' : 'none';
      const fam = fontFamilyOf(fmt);
      const align = fmt.align || (el && el.style.textAlign) || 'center';
      const pad = 16;
      parts.push(`<rect x="${q(x - ox)}" y="${q(y - oy)}" width="${q(nw)}" height="${q(nh)}" rx="18" fill="${escapeXml(fill)}" stroke="${escapeXml(border)}" stroke-width="1.5"/>`);
      if (node && node.type === 'image' && node.content) {
        const href = imageData[String(node.content)] || String(node.content);
        if (/^(https?:|data:image\/)/i.test(href)) {
          parts.push(`<image href="${escapeXml(href)}" x="${q(x - ox + 6)}" y="${q(y - oy + 6)}" width="${q(nw - 12)}" height="${q(nh - 12)}" preserveAspectRatio="xMidYMid slice"/>`);
        }
        return;
      }
      const label = nodeLabel(node, el);
      const isCode = !!(node && node.type === 'code');
      const family = isCode ? fontFamilyOf({ fontFamily: 'mono' }) : fam;
      const font = `${italic === 'italic' ? 'italic ' : ''}${weight} ${fs}px ${family}`;
      const lineH = fs * 1.4;
      const all = isCode
        ? wrapCodeToWidth(label, font, Math.max(20, nw - pad * 2))
        : wrapToWidth(label, font, Math.max(20, nw - pad * 2));
      // Show as many lines as fit in the node, like the canvas does.
      const lines = all.slice(0, Math.max(1, Math.floor((nh - 8) / lineH)));
      const block = lines.length * lineH;
      const startY = y - oy + Math.max(fs, (nh - block) / 2 + fs * 0.82);
      const lineAlign = isCode ? 'left' : align;
      const anchor = lineAlign === 'right' ? 'end' : lineAlign === 'left' ? 'start' : 'middle';
      const tx = lineAlign === 'right' ? x - ox + nw - pad : lineAlign === 'left' ? x - ox + pad : x - ox + nw / 2;
      lines.forEach((line, i) => {
        const extra = (italic === 'italic' ? ' font-style="italic"' : '') + (deco === 'underline' ? ' text-decoration="underline"' : '')
          + (isCode ? ' xml:space="preserve"' : '');
        const svgFamily = isCode ? 'ui-monospace,Menlo,Consolas,monospace' : 'system-ui,sans-serif';
        parts.push(`<text x="${q(tx)}" y="${q(startY + i * lineH)}" text-anchor="${anchor}" fill="${escapeXml(color)}" font-size="${fs}" font-weight="${weight}" font-family="${svgFamily}"${extra}>${escapeXml(line)}</text>`);
      });
    });

    const vw = q(w);
    const vh = q(h);
    let size = `width="${vw}" height="${vh}"`;
    if (compact) {
      const maxEdge = 900;
      const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
      size = `width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${vw} ${vh}">${parts.join('')}</svg>`;
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
        ctx.fillStyle = '#fafafa';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Could not render PNG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  global.MindmapExport = {
    _v: 18,
    // Used by slides to render a live window of a frame.
    buildSvg,
    inlineImages,
    async run(format, rect, scene, els) {
      const base = (rect.name || 'mindmap').replace(/[^\w.-]+/g, '_');
      const ext = format === 'svg' ? 'svg' : format === 'pdf' ? 'pdf' : 'png';
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'pdf' ? 'application/pdf' : 'image/png';
      const target = await beginSave(base + '.' + ext, mime, ext);
      if (target.cancelled) return;
      // SVG files can reference image URLs; PNG/PDF need them embedded.
      const images = format === 'svg' ? {} : await inlineImages(scene);
      const svg = buildSvg(scene, rect, els, { compact: format === 'svg', images });
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
      if (format === 'pdf') {
        await finishSave(target, await pdfBlobFromCanvas(canvas), ext);
      }
    },
  };
})(window);
