/* DocViewer music core — a collection (songbook / setlist / practice set) of
 * audio and video tracks. Media files live in the data folder (normally
 * assets/media/music/); the collection only references them, by data-root
 * link ("/assets/media/music/song.mp3"). Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MusicCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const uid = (p) => (p || 'x') + Math.random().toString(36).slice(2, 9);
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 200);
  const num = (v, lo, hi) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(hi == null ? n : hi, Math.max(lo == null ? n : lo, n));
  };

  const STATUSES = [
    { id: 'to-learn', label: 'To learn' },
    { id: 'learning', label: 'Learning' },
    { id: 'can-play', label: 'Can play' },
    { id: 'ready', label: 'Performance-ready' },
  ];
  const INSTRUMENTS = [
    { id: 'guitar', label: 'Guitar', tuning: 'std' },
    { id: 'ukulele', label: 'Ukulele', tuning: 'std' },
    { id: 'bass', label: 'Bass', tuning: 'std' },
    { id: 'piano', label: 'Piano', tuning: 'std' },
  ];
  const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
  const MEDIA_DIR = 'assets/media/music';

  function mediaKind(path) {
    if (VIDEO_EXT.test(path || '')) return 'video';
    if (AUDIO_EXT.test(path || '')) return 'audio';
    return null;
  }

  // "Artist - Title.mp3" → { artist, title }; otherwise the file name.
  function guessFromName(path) {
    const base = String(path || '').split('/').pop().replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base || 'Untitled' };
  }

  function normRange(x, fallback) {
    if (!x || typeof x !== 'object') return null;
    let a = num(x.a, 0);
    let b = num(x.b, 0);
    if (a == null || b == null) return null;
    if (b < a) { const t = a; a = b; b = t; }
    if (b - a < 0.2) return null;
    return { id: str(x.id, 40) || uid('r_'), name: str(x.name, 80) || fallback, a, b };
  }
  function normLoop(l) {
    const s = l && typeof l === 'object' ? l : {};
    const a = num(s.a, 0);
    const b = num(s.b, 0);
    const ok = a != null && b != null && b - a >= 0.2;
    return { on: !!s.on && ok, a: a == null ? null : a, b: b == null ? null : b, gap: num(s.gap, 0, 10) || 0, countIn: !!s.countIn, repeats: Math.round(num(s.repeats, 0, 999) || 0) };
  }
  function normVideo(v) {
    const s = v && typeof v === 'object' ? v : {};
    const z = s.zoom && typeof s.zoom === 'object' ? s.zoom : {};
    return { mirror: !!s.mirror, show: s.show !== false, zoom: { s: num(z.s, 1, 6) || 1, x: num(z.x, 0, 1) == null ? 0.5 : num(z.x, 0, 1), y: num(z.y, 0, 1) == null ? 0.5 : num(z.y, 0, 1) } };
  }

  function normalizeTrack(t, sectionIds) {
    const s = t && typeof t === 'object' ? t : {};
    const media = str(s.media, 1000);
    const kind = s.kind === 'video' || s.kind === 'audio' ? s.kind : (mediaKind(media) || 'audio');
    const status = STATUSES.some((x) => x.id === s.status) ? s.status : 'to-learn';
    return {
      id: str(s.id, 40) || uid('t_'),
      sectionId: sectionIds && sectionIds.includes(s.sectionId) ? s.sectionId : (sectionIds && sectionIds[0]) || '',
      media,
      kind,
      title: str(s.title, 200) || guessFromName(media).title,
      artist: str(s.artist, 200),
      album: str(s.album, 200),
      year: num(s.year, 0, 3000),
      duration: num(s.duration, 0),
      status,
      difficulty: num(s.difficulty, 0, 5) || 0,
      rating: num(s.rating, 0, 5) || 0,
      tags: (Array.isArray(s.tags) ? s.tags : []).map((x) => str(x, 40).trim()).filter(Boolean).slice(0, 20),
      key: str(s.key, 12),
      bpm: num(s.bpm, 20, 400),
      timeSig: str(s.timeSig, 8),
      capo: num(s.capo, 0, 12) || 0,
      tuning: str(s.tuning, 24),
      source: str(s.source, 1000),
      lyrics: str(s.lyrics, 50000),
      notes: typeof s.notes === 'string' ? str(s.notes, 50000) : '',
      added: str(s.added, 40) || new Date().toISOString(),
      lastPlayed: str(s.lastPlayed, 40),
      // Practice (phase 2): markers, song sections, A–B loop, saved loops,
      // speed / pitch, video view and speed trainer.
      markers: (Array.isArray(s.markers) ? s.markers : []).map((m) => ({ id: str(m && m.id, 40) || uid('m_'), t: num(m && m.t, 0) || 0, name: str(m && m.name, 80) })).sort((a, b) => a.t - b.t).slice(0, 500),
      sectionsTimeline: (Array.isArray(s.sectionsTimeline) ? s.sectionsTimeline : []).map((x) => normRange(x, 'Section')).filter(Boolean).sort((a, b) => a.a - b.a).slice(0, 200),
      loop: normLoop(s.loop),
      rate: num(s.rate, 0.25, 2) || 1,
      pitch: Math.round(num(s.pitch, -12, 12) || 0),
      savedLoops: (Array.isArray(s.savedLoops) ? s.savedLoops : []).map((x) => {
        const r = normRange(x, 'Loop');
        if (!r) return null;
        return Object.assign(r, { rate: num(x.rate, 0.25, 2) || 1, pitch: Math.round(num(x.pitch, -12, 12) || 0), video: normVideo(x.video), note: str(x.note, 2000) });
      }).filter(Boolean).slice(0, 200),
      video: normVideo(s.video),
      trainer: {
        from: num(s.trainer && s.trainer.from, 0.25, 2) || 0.6,
        to: num(s.trainer && s.trainer.to, 0.25, 2) || 1,
        step: num(s.trainer && s.trainer.step, 0.01, 0.5) || 0.05,
        every: Math.round(num(s.trainer && s.trainer.every, 1, 50) || 4),
      },
      // Phase 3: chord timeline (entered by hand or from analysis) and notes
      // imported from MIDI ({ p: midi, t, d } seconds).
      chords: (Array.isArray(s.chords) ? s.chords : []).map((c) => ({ id: str(c && c.id, 40) || uid('c_'), t: num(c && c.t, 0) || 0, name: str(c && c.name, 24).trim() })).filter((c) => c.name).sort((a, b) => a.t - b.t).slice(0, 2000),
      // Note events ({ p: midi, t, d } seconds, optional v velocity 0–1 and c
      // confidence 0–1) from MIDI import or analysis. Older files kept them
      // in "notes" (which is the text notes field), so migrate those.
      noteEvents: (Array.isArray(s.noteEvents) ? s.noteEvents : Array.isArray(s.notes) ? s.notes : []).filter((x) => x && Number.isFinite(x.p) && Number.isFinite(x.t)).slice(0, 20000).map((x) => {
        const o = { p: Math.round(x.p), t: Math.round(x.t * 1000) / 1000, d: Math.max(0.02, Math.round((x.d || 0.25) * 1000) / 1000) };
        if (Number.isFinite(x.v)) o.v = Math.round(Math.min(1, Math.max(0, x.v)) * 100) / 100;
        if (Number.isFinite(x.c)) o.c = Math.round(Math.min(1, Math.max(0, x.c)) * 100) / 100;
        return o;
      }).sort((a, b) => a.t - b.t || a.p - b.p),
      notesOffset: num(s.notesOffset, -600, 600) || 0,
      // Phase 4: analysis folder ("/assets/media/music/song.analysis"), the
      // run applied last, beat grid start, stem mix and what is heard.
      analysis: str(s.analysis, 1000),
      analysisRun: str(s.analysisRun, 40),
      beatOffset: num(s.beatOffset, 0, 600) || 0,
      stems: normStems(s.stems),
      playMode: ['original', 'notes', 'both'].includes(s.playMode) ? s.playMode : 'original',
      noteSound: s.noteSound === 'voice' ? 'voice' : 'instrument',
      minConf: num(s.minConf, 0, 1) || 0,
      extra: s.extra && typeof s.extra === 'object' ? s.extra : undefined,
    };
  }

  const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  function normStems(x) {
    const s = x && typeof x === 'object' ? x : {};
    const mix = {};
    const m = s.mix && typeof s.mix === 'object' ? s.mix : {};
    Object.keys(m).slice(0, 12).forEach((k) => { const v = m[k] || {}; mix[str(k, 20)] = { vol: num(v.vol, 0, 1.5) == null ? 1 : num(v.vol, 0, 1.5), mute: !!v.mute, solo: !!v.solo }; });
    return { on: !!s.on, mix };
  }

  // Old files stored "EADGBE"; presets are ids, custom tunings a note list.
  function normTuning(t) {
    const v = str(t, 60).trim();
    if (!v || /^(EADGBE|GCEA|EADG)$/i.test(v)) return 'std';
    return v;
  }

  function normalize(data) {
    const s = data && typeof data === 'object' ? data : {};
    let sections = (Array.isArray(s.sections) ? s.sections : []).map((x) => ({
      id: str(x && x.id, 40) || uid('s_'),
      name: str(x && x.name, 80) || 'Section',
      collapsed: !!(x && x.collapsed),
    }));
    if (!sections.length) sections = [{ id: 's_main', name: 'Tracks', collapsed: false }];
    const ids = sections.map((x) => x.id);
    const inst = INSTRUMENTS.find((x) => x.id === (s.instrument && s.instrument.kind)) || INSTRUMENTS[0];
    return {
      version: 1,
      title: str(s.title, 120) || 'Music',
      instrument: {
        kind: inst.id,
        tuning: normTuning(s.instrument && s.instrument.tuning),
        capo: num(s.instrument && s.instrument.capo, 0, 12) || 0,
        frets: Math.round(num(s.instrument && s.instrument.frets, 12, 24) || 15),
        leftHanded: !!(s.instrument && s.instrument.leftHanded),
        labels: ['notes', 'degrees', 'frets', 'fingers'].includes(s.instrument && s.instrument.labels) ? s.instrument.labels : 'notes',
        scale: str(s.instrument && s.instrument.scale, 30),
      },
      // Preferred shape per chord: { "guitar:std:Am": "x,0,2,2,1,0" }.
      chordLocks: s.chordLocks && typeof s.chordLocks === 'object' && !Array.isArray(s.chordLocks) ? Object.fromEntries(Object.entries(s.chordLocks).slice(0, 2000).map(([k, v]) => [str(k, 80), str(v, 60)])) : {},
      sections,
      tracks: (Array.isArray(s.tracks) ? s.tracks : []).map((t) => normalizeTrack(t, ids)).filter((t) => t.media).slice(0, 5000),
      view: {
        filter: STATUSES.some((x) => x.id === (s.view && s.view.filter)) ? s.view.filter : '',
        kindFilter: ['audio', 'video'].includes(s.view && s.view.kindFilter) ? s.view.kindFilter : '',
        selected: str(s.view && s.view.selected, 40),
      },
      updatedAt: str(s.updatedAt, 40),
    };
  }

  const TEMPLATES = {
    songbook: { title: 'Songbook', sections: ['To learn', 'Learning', 'Can play'] },
    practice: { title: 'Practice set', sections: ['Warm-ups', 'Lessons', 'Songs'] },
    setlist: { title: 'Setlist', sections: ['Set 1', 'Set 2', 'Encore'] },
  };

  function createStarter(kind) {
    const tpl = TEMPLATES[kind] || TEMPLATES.songbook;
    return normalize({ title: tpl.title, sections: tpl.sections.map((name) => ({ id: uid('s_'), name })) });
  }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 120);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 2).replace(/</g, '\\u003c');
    const t = String(norm.title || 'Music').replace(/[<>&]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="music">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="music-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }
  function isMusicHtml(html) { return typeof html === 'string' && /data-docviewer\s*=\s*["']music["']/.test(html); }
  function parseHtml(html) {
    if (!isMusicHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']music-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  return { STATUSES, INSTRUMENTS, STEMS, MEDIA_DIR, AUDIO_EXT, VIDEO_EXT, uid, mediaKind, guessFromName, normalize, normalizeTrack, createStarter, serializeToHtml, isMusicHtml, parseHtml, fmtTime };
});
