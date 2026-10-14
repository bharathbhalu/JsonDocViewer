/* DocViewer music theory (phase 3): notes, scales, chord parsing and naming,
 * tunings, chord-shape (voicing) generator for any fretted instrument and
 * tuning, note → fret position solver, and a small Standard MIDI File reader.
 * No data tables of chord shapes: voicings are searched on the fretboard. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MusicTheory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function pcOf(name) {
    const m = /^([A-Ga-g])([#b♯♭]*)/.exec(String(name || '').trim());
    if (!m) return null;
    let p = PC[m[1].toUpperCase()];
    for (const c of m[2]) p += (c === '#' || c === '♯') ? 1 : -1;
    return ((p % 12) + 12) % 12;
  }
  function noteName(pc, flats) { return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12]; }
  function midiName(m, flats) { return noteName(m, flats) + (Math.floor(m / 12) - 1); }
  function parseMidiNote(s) {
    const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(String(s || '').trim());
    if (!m) return null;
    return pcOf(m[1]) + (Number(m[2]) + 1) * 12;
  }
  const freqOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  // ---------- tunings ----------
  const TUNINGS = {
    guitar: [
      { id: 'std', label: 'Standard (EADGBE)', notes: 'E2 A2 D3 G3 B3 E4' },
      { id: 'dropd', label: 'Drop D', notes: 'D2 A2 D3 G3 B3 E4' },
      { id: 'dadgad', label: 'DADGAD', notes: 'D2 A2 D3 G3 A3 D4' },
      { id: 'openg', label: 'Open G', notes: 'D2 G2 D3 G3 B3 D4' },
      { id: 'opend', label: 'Open D', notes: 'D2 A2 D3 F#3 A3 D4' },
      { id: 'opene', label: 'Open E', notes: 'E2 B2 E3 G#3 B3 E4' },
      { id: 'half', label: 'Half step down', notes: 'D#2 G#2 C#3 F#3 A#3 D#4' },
    ],
    ukulele: [
      { id: 'std', label: 'Standard GCEA (high G)', notes: 'G4 C4 E4 A4' },
      { id: 'lowg', label: 'Low G', notes: 'G3 C4 E4 A4' },
      { id: 'bari', label: 'Baritone DGBE', notes: 'D3 G3 B3 E4' },
      { id: 'd', label: 'D tuning ADF#B', notes: 'A4 D4 F#4 B4' },
    ],
    bass: [
      { id: 'std', label: 'Standard EADG', notes: 'E1 A1 D2 G2' },
      { id: 'five', label: '5-string BEADG', notes: 'B0 E1 A1 D2 G2' },
      { id: 'dropd', label: 'Drop D', notes: 'D1 A1 D2 G2' },
    ],
    piano: [{ id: 'std', label: 'Piano', notes: '' }],
  };
  // A tuning value is a preset id or a custom "E2 A2 D3 …" list.
  function tuningNotes(instrument, tuning) {
    const list = TUNINGS[instrument] || TUNINGS.guitar;
    const preset = list.find((t) => t.id === tuning) || null;
    const txt = preset ? preset.notes : String(tuning || '');
    const notes = txt.split(/[\s,]+/).map(parseMidiNote).filter((n) => n != null);
    if (notes.length >= 3) return notes;
    return (list[0].notes || TUNINGS.guitar[0].notes).split(' ').map(parseMidiNote);
  }
  function tuningLabel(instrument, tuning) {
    const p = (TUNINGS[instrument] || []).find((t) => t.id === tuning);
    return p ? p.label : String(tuning || '');
  }

  // ---------- scales ----------
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    'major pentatonic': [0, 2, 4, 7, 9],
    'minor pentatonic': [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
  };
  // "F#m" / "Am" / "G" / "D minor" → { root, minor }
  function parseKey(k) {
    const s = String(k || '').trim();
    const r = pcOf(s);
    if (r == null) return null;
    const minor = /^[A-Ga-g][#b]?\s*(m(?!aj)|min|minor)/i.test(s);
    return { root: r, minor };
  }
  const DEGREE = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];

  // ---------- chords ----------
  const QUALITIES = [
    ['maj7', [0, 4, 7, 11]], ['M7', [0, 4, 7, 11]], ['Δ', [0, 4, 7, 11]],
    ['m7b5', [0, 3, 6, 10]], ['ø', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]], ['°7', [0, 3, 6, 9]],
    ['mmaj7', [0, 3, 7, 11]], ['m9', [0, 3, 7, 10, 14]], ['m7', [0, 3, 7, 10]], ['m6', [0, 3, 7, 9]], ['madd9', [0, 3, 7, 14]],
    ['7sus4', [0, 5, 7, 10]], ['9', [0, 4, 7, 10, 14]], ['add9', [0, 4, 7, 14]], ['6', [0, 4, 7, 9]], ['7', [0, 4, 7, 10]],
    ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['sus', [0, 5, 7]], ['dim', [0, 3, 6]], ['°', [0, 3, 6]],
    ['aug', [0, 4, 8]], ['+', [0, 4, 8]], ['5', [0, 7]], ['min', [0, 3, 7]], ['m', [0, 3, 7]], ['maj', [0, 4, 7]], ['', [0, 4, 7]],
  ];
  // "Am7", "F#m", "C/G", "Bbmaj7" → { name, root, bass, intervals, pcs }
  function parseChord(name) {
    const s = String(name || '').trim();
    const m = /^([A-Ga-g][#b♯♭]?)([^/]*)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(s);
    if (!m) return null;
    const root = pcOf(m[1]);
    const q = m[2].trim();
    const found = QUALITIES.find(([k]) => k === q);
    if (!found) return null;
    const intervals = found[1];
    const bass = m[3] ? pcOf(m[3]) : root;
    const pcs = [...new Set(intervals.map((i) => (root + i) % 12))];
    if (!pcs.includes(bass)) pcs.push(bass);
    return { name: s, root, bass, quality: q, intervals, pcs };
  }
  function transposeChord(name, semis) {
    const c = /^([A-Ga-g][#b♯♭]?)([^/]*)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(String(name || '').trim());
    if (!c) return name;
    const flats = /b/.test(c[1].slice(1));
    const r = noteName(pcOf(c[1]) + semis, flats);
    return r + c[2] + (c[3] ? '/' + noteName(pcOf(c[3]) + semis, flats) : '');
  }
  // Name a set of pitch classes (for notes → chord).
  function nameChord(pcsIn) {
    const pcs = [...new Set(pcsIn.map((p) => ((p % 12) + 12) % 12))];
    let best = null;
    for (const r of pcs) {
      for (const [q, iv] of QUALITIES) {
        if (q === 'M7' || q === 'Δ' || q === 'ø' || q === '°7' || q === '°' || q === '+' || q === 'min' || q === 'maj' || q === 'sus') continue;
        const want = iv.map((i) => (r + i) % 12);
        const hit = want.filter((p) => pcs.includes(p)).length;
        const extra = pcs.filter((p) => !want.includes(p)).length;
        const score = hit * 3 - (want.length - hit) * 4 - extra * 2 - iv.length * 0.1;
        if (!best || score > best.score) best = { score, name: noteName(r) + q };
      }
    }
    return best ? best.name : '';
  }
  const COMMON = (() => {
    const out = [];
    const qs = ['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'add9', '6', 'm6', 'dim', 'aug', '9', '7sus4', 'm7b5', '5'];
    SHARP.forEach((r, i) => qs.forEach((q) => out.push((FLAT[i] !== r && ['A#', 'D#', 'G#'].includes(r) ? FLAT[i] : r) + q)));
    return out;
  })();

  // ---------- voicings ----------
  // Search shapes for a chord on a fretted instrument. Returns up to `max`
  // voicings sorted best-first: { frets: [..per string, -1 = muted], fingers,
  // barre: {fret, from, to} | null, base, key }.
  function voicings(chordName, tuning, opts) {
    const o = Object.assign({ maxFret: 15, span: 3, max: 8 }, opts);
    const ch = parseChord(chordName);
    if (!ch || !tuning || !tuning.length) return [];
    const n = tuning.length;
    const needed = ch.intervals.map((i) => (ch.root + i) % 12);
    const optional = new Set(ch.intervals.length >= 4 ? [(ch.root + 7) % 12] : []);
    const results = [];
    const seen = new Set();
    for (let base = 0; base <= o.maxFret - o.span; base++) {
      const opts2 = tuning.map((open) => {
        const c = [-1];
        for (let f = base === 0 ? 0 : base; f <= base + o.span; f++) if (needed.includes((open + f) % 12) || (ch.bass !== ch.root && (open + f) % 12 === ch.bass)) c.push(f);
        if (base > 0 && needed.includes(open % 12)) c.push(0);
        return [...new Set(c)];
      });
      const cur = new Array(n);
      const walk = (s) => {
        if (s === n) {
          const sounding = cur.map((f, i) => (f < 0 ? null : tuning[i] + f)).filter((x) => x != null);
          if (sounding.length < Math.min(3, n - 1)) return;
          const pcs = new Set(sounding.map((x) => x % 12));
          if (!needed.every((p) => pcs.has(p) || optional.has(p))) return;
          // Lowest sounding note must be the bass (root or slash bass).
          const low = Math.min(...sounding);
          if (n >= 6 && low % 12 !== ch.bass) return;
          if (n < 6 && ch.bass !== ch.root && low % 12 !== ch.bass) return;
          // No muted strings between sounding ones (except outer low strings).
          const firstOn = cur.findIndex((f) => f >= 0);
          for (let i = firstOn; i < n; i++) if (cur[i] < 0 && n >= 6 && i < n - 1) return;
          const fretted = cur.filter((f) => f > 0);
          const minF = fretted.length ? Math.min(...fretted) : 0;
          const maxF = fretted.length ? Math.max(...fretted) : 0;
          if (maxF - minF > o.span) return;
          const fing = assignFingers(cur);
          if (!fing) return;
          const key = cur.join(',');
          if (seen.has(key)) return;
          seen.add(key);
          const opens = cur.filter((f) => f === 0).length;
          const muted = cur.filter((f) => f < 0).length;
          // Awkward shapes: an open string right above a fretted bass note,
          // or an open string between strings fretted at 2+.
          let awk = 0;
          if (firstOn >= 0 && cur[firstOn] > 0 && cur[firstOn + 1] === 0) awk += 2;
          for (let i = 1; i < n - 1; i++) if (cur[i] === 0 && cur[i - 1] >= 2 && cur[i + 1] >= 2) awk += 1.6;
          const mutePenalty = n <= 4 ? 3.2 : 1.1;
          const pos = minF <= 3 ? minF * 0.3 : minF * 1.4;
          const score = pos + (maxF - minF) * 0.8 - opens * 0.6 + muted * mutePenalty + (fing.barre ? 1.2 : 0) + (pcs.size < needed.length ? 1.5 : 0) + awk;
          results.push({ frets: cur.slice(), fingers: fing.fingers, barre: fing.barre, base: minF > 2 ? minF : 1, score, key });
          return;
        }
        for (const f of opts2[s]) { cur[s] = f; walk(s + 1); }
      };
      walk(0);
    }
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, o.max);
  }

  // Fingers 1–4 for a shape; a barre on the lowest fret when needed.
  function assignFingers(frets) {
    const pos = frets.map((f, s) => ({ f, s })).filter((x) => x.f > 0);
    if (!pos.length) return { fingers: frets.map(() => 0), barre: null };
    const minF = Math.min(...pos.map((x) => x.f));
    const atMin = pos.filter((x) => x.f === minF);
    let barre = null;
    let rest = pos;
    let next = 1;
    const fingers = frets.map(() => 0);
    if (pos.length > 4 || (atMin.length >= 2 && pos.length > 4 - 0)) {
      // Barre across the strings from the first to the last at the lowest fret.
      const from = Math.min(...atMin.map((x) => x.s));
      const to = Math.max(...atMin.map((x) => x.s));
      const blocked = frets.slice(from, to + 1).some((f) => f >= 0 && f < minF);
      if (atMin.length >= 2 && !blocked) {
        barre = { fret: minF, from, to };
        atMin.forEach((x) => { fingers[x.s] = 1; });
        rest = pos.filter((x) => x.f !== minF);
        next = 2;
      }
    }
    rest.sort((a, b) => a.f - b.f || a.s - b.s);
    for (const x of rest) {
      if (next > 4) return null;
      fingers[x.s] = next++;
    }
    return { fingers, barre };
  }

  // ---------- note → position (melody / riff on a fretted instrument) ----------
  // Picks a string and fret for each note so the hand moves as little as
  // possible (dynamic programming over candidate positions).
  function positionsFor(notes, tuning, opts) {
    const o = Object.assign({ maxFret: 15, capo: 0 }, opts);
    const cands = notes.map((midi) => {
      const out = [];
      tuning.forEach((open, s) => { const f = midi - open; if (f >= o.capo && f <= o.maxFret) out.push({ s, f }); });
      return out;
    });
    const cost = [];
    const back = [];
    cands.forEach((list, i) => {
      cost[i] = []; back[i] = [];
      list.forEach((c, j) => {
        const here = c.f === 0 ? 0 : c.f * 0.05;
        if (i === 0 || !cands[i - 1].length) { cost[i][j] = here; back[i][j] = -1; return; }
        let best = Infinity; let bk = 0;
        cands[i - 1].forEach((p, k) => {
          const pf = p.f || c.f;
          const v = cost[i - 1][k] + Math.abs((c.f || pf) - pf) + Math.abs(c.s - p.s) * 0.3 + here;
          if (v < best) { best = v; bk = k; }
        });
        cost[i][j] = best; back[i][j] = bk;
      });
    });
    const out = new Array(notes.length).fill(null);
    let i = notes.length - 1;
    while (i >= 0 && !cands[i].length) i--;
    if (i < 0) return out;
    let j = cost[i].indexOf(Math.min(...cost[i]));
    for (; i >= 0; i--) {
      if (!cands[i].length) continue;
      out[i] = cands[i][j];
      j = back[i][j] >= 0 ? back[i][j] : 0;
    }
    return out;
  }

  // ---------- Standard MIDI File → notes [{ p, t, d, v, ch }] in seconds ----------
  function parseMidi(buf) {
    const b = new Uint8Array(buf);
    let p = 0;
    const u32 = () => (b[p++] << 24 | b[p++] << 16 | b[p++] << 8 | b[p++]) >>> 0;
    const u16 = () => (b[p++] << 8 | b[p++]);
    const vlq = () => { let v = 0; let c; do { c = b[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'MThd') throw new Error('Not a MIDI file');
    p = 4; const hl = u32(); u16(); const ntr = u16(); const div = u16(); p = 8 + hl;
    const events = [];
    const tempos = [{ tick: 0, us: 500000 }];
    for (let tr = 0; tr < ntr && p < b.length; tr++) {
      if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) !== 'MTrk') break;
      p += 4; const len = u32(); const end = p + len;
      let tick = 0; let status = 0;
      while (p < end) {
        tick += vlq();
        let st = b[p];
        if (st & 0x80) { p++; status = st; } else st = status;
        const type = st & 0xf0;
        if (st === 0xff) { const mt = b[p++]; const l = vlq(); if (mt === 0x51) tempos.push({ tick, us: (b[p] << 16) | (b[p + 1] << 8) | b[p + 2] }); p += l; }
        else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
        else if (type === 0x90 || type === 0x80) { const n = b[p++]; const v = b[p++]; events.push({ tick, on: type === 0x90 && v > 0, n, v, ch: st & 0x0f }); }
        else if (type === 0xc0 || type === 0xd0) p += 1;
        else p += 2;
      }
      p = end;
    }
    tempos.sort((a, x) => a.tick - x.tick);
    const toSec = (tick) => {
      let sec = 0; let last = 0; let us = 500000;
      for (const t of tempos) { if (t.tick > tick) break; sec += ((t.tick - last) / div) * (us / 1e6); last = t.tick; us = t.us; }
      return sec + ((tick - last) / div) * (us / 1e6);
    };
    events.sort((a, x) => a.tick - x.tick);
    const open = new Map();
    const notes = [];
    for (const e of events) {
      const k = e.ch + ':' + e.n;
      if (e.on) open.set(k, e);
      else if (open.has(k)) { const s = open.get(k); open.delete(k); const t = toSec(s.tick); notes.push({ p: s.n, t: Math.round(t * 1000) / 1000, d: Math.max(0.03, Math.round((toSec(e.tick) - t) * 1000) / 1000), v: s.v, ch: s.ch }); }
    }
    notes.sort((a, x) => a.t - x.t || a.p - x.p);
    return notes;
  }

  return { SHARP, FLAT, TUNINGS, SCALES, DEGREE, COMMON, pcOf, noteName, midiName, parseMidiNote, freqOf, tuningNotes, tuningLabel, parseKey, parseChord, transposeChord, nameChord, voicings, assignFingers, positionsFor, parseMidi };
});
