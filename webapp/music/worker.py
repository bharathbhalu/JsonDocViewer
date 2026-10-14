#!/usr/bin/env python3
"""Accretion music analysis worker (optional add-on).

Runs inside the add-on's private venv (~/.accretion/music/venv), spawned by
server.js. Prints one JSON object per line on stdout:
  {"progress": 0.42, "msg": "Detecting chords"}
  {"result": {...}}                         (last line on success)
  {"error": "..."}                          (on failure, exit code 1)

Commands:
  worker.py check
  worker.py warmup                          download / load the models once
  worker.py analyze --input SONG --out DIR --steps stems,notes,tempo,key,chords,sections
                    [--parts mix,vocals,bass,guitar,piano,other] [--stems-model htdemucs_6s]

Writes into DIR (the "<song>.analysis" folder):
  stems/<name>.mp3                          separated stems (shared by all runs)
  runs/<run>/analysis.json                  key, tempo, beats, sections, chords
  runs/<run>/notes-<part>.json              [{p, t, d, v, c}]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

STEM_NAMES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
FLAT_KEYS = {'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm'}


def emit(**kw):
    sys.stdout.write(json.dumps(kw) + '\n')
    sys.stdout.flush()


def progress(p, msg):
    emit(progress=round(max(0.0, min(1.0, p)), 3), msg=msg)


def ffmpeg_bin():
    for p in (os.environ.get('ACCRETION_FFMPEG'), shutil.which('ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'):
        if p and os.path.exists(p):
            return p
    raise RuntimeError('ffmpeg is not installed (brew install ffmpeg)')


def to_wav(src, dst, mono=False):
    cmd = [ffmpeg_bin(), '-v', 'error', '-y', '-i', src, '-vn', '-ar', '44100']
    cmd += ['-ac', '1'] if mono else ['-ac', '2']
    cmd += [dst]
    subprocess.run(cmd, check=True)


def versions():
    out = {'python': sys.version.split()[0]}
    for mod in ('torch', 'demucs', 'basic_pitch', 'librosa', 'numpy'):
        try:
            m = __import__(mod)
            out[mod] = getattr(m, '__version__', 'ok')
        except Exception as e:  # noqa: BLE001
            out[mod] = None
    try:
        out['ffmpeg'] = ffmpeg_bin()
    except Exception:  # noqa: BLE001
        out['ffmpeg'] = None
    try:
        import torch
        out['gpu'] = 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
    except Exception:  # noqa: BLE001
        out['gpu'] = None
    return out


# ---------------------------------------------------------------- stems
def separate(wav, out_dir, model, p0, p1):
    progress(p0, 'Separating stems (' + model + ') — this is the slow part')
    tmp = tempfile.mkdtemp(prefix='acc-stems-')
    try:
        cmd = [sys.executable, '-m', 'demucs', '-n', model, '--mp3', '--mp3-bitrate', '192', '-o', tmp, wav]
        try:
            import torch
            if torch.backends.mps.is_available():
                cmd[3:3] = ['-d', 'mps']
        except Exception:  # noqa: BLE001
            pass
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        buf = ''
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in '\r\n':
                # tqdm lines look like " 45%|████      | ..."
                s = buf.strip()
                buf = ''
                if '%|' in s:
                    try:
                        pct = float(s.split('%|')[0].split()[-1]) / 100.0
                        progress(p0 + (p1 - p0) * pct, 'Separating stems ' + str(int(pct * 100)) + '%')
                    except ValueError:
                        pass
            else:
                buf += ch
        if proc.wait() != 0:
            raise RuntimeError('Demucs failed (exit ' + str(proc.returncode) + ')')
        stem_dir = os.path.join(out_dir, 'stems')
        os.makedirs(stem_dir, exist_ok=True)
        found = []
        for root, _dirs, files in os.walk(tmp):
            for f in files:
                name, ext = os.path.splitext(f)
                if ext == '.mp3' and name in STEM_NAMES:
                    shutil.move(os.path.join(root, f), os.path.join(stem_dir, f))
                    found.append(name)
        if not found:
            raise RuntimeError('Demucs produced no stems')
        return sorted(found, key=STEM_NAMES.index)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- notes
def extract_notes(wav):
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH
    _out, _midi, events = predict(wav, ICASSP_2022_MODEL_PATH)
    notes = []
    for ev in events:
        start, end, pitch, amp = float(ev[0]), float(ev[1]), int(ev[2]), float(ev[3])
        if end - start < 0.03:
            continue
        notes.append({'p': pitch, 't': round(start, 3), 'd': round(end - start, 3), 'v': round(min(1.0, amp), 2), 'c': round(min(1.0, amp * 1.4), 2)})
    notes.sort(key=lambda n: (n['t'], n['p']))
    return notes


# ---------------------------------------------------------------- tempo / key / chords / sections
def load_mono(wav):
    import librosa
    y, sr = librosa.load(wav, sr=22050, mono=True)
    return y, sr


def tempo_beats(y, sr):
    import librosa
    import numpy as np
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
    tempo = float(np.atleast_1d(tempo)[0])
    times = librosa.frames_to_time(frames, sr=sr)
    return round(tempo, 1), [round(float(t), 3) for t in times], frames


# Krumhansl–Schmuckler key profiles.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def chroma_of(y, sr):
    import librosa
    harm = librosa.effects.harmonic(y)
    return librosa.feature.chroma_cqt(y=harm, sr=sr, hop_length=512)


def detect_key(chroma):
    import numpy as np
    prof = chroma.mean(axis=1)
    best = (-2, 0, False)
    for minor, base in ((False, MAJOR_PROFILE), (True, MINOR_PROFILE)):
        for r in range(12):
            c = np.corrcoef(prof, np.roll(base, r))[0, 1]
            if c > best[0]:
                best = (c, r, minor)
    _c, root, minor = best
    name = SHARP[root] + ('m' if minor else '')
    if (FLAT[root] + ('m' if minor else '')) in FLAT_KEYS:
        name = FLAT[root] + ('m' if minor else '')
    return name, round(float(best[0]), 3)


CHORD_TYPES = [
    ('', [0, 4, 7], 1.0), ('m', [0, 3, 7], 1.0), ('7', [0, 4, 7, 10], 0.92), ('maj7', [0, 4, 7, 11], 0.9),
    ('m7', [0, 3, 7, 10], 0.92), ('sus2', [0, 2, 7], 0.84), ('sus4', [0, 5, 7], 0.86), ('dim', [0, 3, 6], 0.82),
    ('aug', [0, 4, 8], 0.8), ('6', [0, 4, 7, 9], 0.84), ('add9', [0, 2, 4, 7], 0.84),
]


def detect_chords(chroma, sr, beat_frames, use_flats):
    """Beat-synchronous chroma matched against chord templates, then merged."""
    import librosa
    import numpy as np
    names = FLAT if use_flats else SHARP
    if len(beat_frames) < 2:
        beat_frames = np.arange(0, chroma.shape[1], 43)
    sync = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    bounds = librosa.util.fix_frames(beat_frames, x_max=chroma.shape[1])
    times = librosa.frames_to_time(bounds, sr=sr, hop_length=512)
    templates = []
    for root in range(12):
        for suffix, ivs, w in CHORD_TYPES:
            v = np.zeros(12)
            for i in ivs:
                v[(root + i) % 12] = 1.0
            v /= np.linalg.norm(v)
            templates.append((names[root] + suffix, v, w))
    labels = []
    for k in range(sync.shape[1]):
        col = sync[:, k]
        n = np.linalg.norm(col)
        if n < 1e-6 or col.max() < 0.15:
            labels.append(('N', 0.0))
            continue
        col = col / n
        best = max(((float(np.dot(col, v)) * w, nm) for nm, v, w in templates))
        labels.append((best[1], best[0]))
    # Smooth: a chord must last two beats unless it is strong.
    for i in range(1, len(labels) - 1):
        if labels[i][0] != labels[i - 1][0] and labels[i - 1][0] == labels[i + 1][0] and labels[i][1] < 0.9:
            labels[i] = labels[i - 1]
    out = []
    for i, (nm, conf) in enumerate(labels):
        if nm == 'N':
            continue
        t = float(times[i]) if i < len(times) else 0.0
        if out and out[-1]['name'] == nm:
            continue
        out.append({'t': round(t, 2), 'name': nm, 'c': round(conf, 2)})
    return out


def detect_sections(y, sr, beat_frames, duration):
    """Self-similarity segmentation; repeated parts get the same letter."""
    import librosa
    import numpy as np
    if len(beat_frames) < 16:
        return []
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    feat = np.vstack([librosa.util.normalize(chroma, axis=0), librosa.util.normalize(mfcc, axis=1) * 0.5])
    sync = librosa.util.sync(feat, beat_frames)
    k = int(max(3, min(10, round(duration / 25))))
    k = min(k, sync.shape[1] - 1)
    bounds = librosa.segment.agglomerative(sync, k)
    beat_times = librosa.frames_to_time(librosa.util.fix_frames(beat_frames, x_max=chroma.shape[1]), sr=sr)
    segs = []
    for i, b in enumerate(bounds):
        e = bounds[i + 1] if i + 1 < len(bounds) else sync.shape[1]
        a_t = float(beat_times[min(b, len(beat_times) - 1)]) if b > 0 else 0.0
        b_t = float(beat_times[min(e, len(beat_times) - 1)]) if e < sync.shape[1] else duration
        if b_t - a_t < 4:
            if segs:
                segs[-1]['b'] = round(b_t, 2)
            continue
        segs.append({'a': round(a_t, 2), 'b': round(b_t, 2), 'vec': sync[:, b:e].mean(axis=1)})
    letters = []
    protos = []
    for s in segs:
        v = s['vec'] / (np.linalg.norm(s['vec']) or 1)
        hit = None
        for j, pv in enumerate(protos):
            if float(np.dot(v, pv)) > 0.97:
                hit = j
                break
        if hit is None:
            protos.append(v)
            hit = len(protos) - 1
        letters.append(chr(65 + min(hit, 25)))
    seen = {}
    out = []
    for s, letter in zip(segs, letters):
        seen[letter] = seen.get(letter, 0) + 1
        out.append({'name': 'Part ' + letter + (str(seen[letter]) if letters.count(letter) > 1 else ''), 'a': s['a'], 'b': s['b']})
    return out


# ---------------------------------------------------------------- commands
def cmd_analyze(a):
    steps = [s for s in a.steps.split(',') if s]
    parts = [p for p in (a.parts or '').split(',') if p]
    out_dir = os.path.abspath(a.out)
    run_id = a.run or time.strftime('%Y%m%d-%H%M%S')
    run_dir = os.path.join(out_dir, 'runs', run_id)
    os.makedirs(run_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix='acc-music-')
    result = {'run': run_id, 'date': time.strftime('%Y-%m-%dT%H:%M:%S'), 'steps': steps, 'parts': [], 'stems': [], 'tools': versions()}
    try:
        progress(0.01, 'Converting audio')
        wav = os.path.join(work, 'mix.wav')
        to_wav(a.input, wav)
        import soundfile as sf
        info = sf.info(wav)
        duration = float(info.frames) / float(info.samplerate)
        result['duration'] = round(duration, 2)

        # Plan the progress bar: stems are slow, notes per part next.
        weights = {'stems': 0.5 if 'stems' in steps else 0, 'notes': 0.25 * max(1, len(parts)) if 'notes' in steps else 0}
        rest = 0.15 if set(steps) & {'tempo', 'key', 'chords', 'sections'} else 0
        total = weights['stems'] + weights['notes'] + rest or 1
        at = 0.03

        stem_dir = os.path.join(out_dir, 'stems')
        if 'stems' in steps:
            span = 0.94 * weights['stems'] / total
            result['stems'] = separate(wav, out_dir, a.stems_model, at, at + span)
            at += span
        elif os.path.isdir(stem_dir):
            result['stems'] = sorted([os.path.splitext(f)[0] for f in os.listdir(stem_dir) if f.endswith('.mp3')], key=lambda n: STEM_NAMES.index(n) if n in STEM_NAMES else 99)

        if set(steps) & {'tempo', 'key', 'chords', 'sections'}:
            progress(at, 'Finding beats and tempo')
            y, sr = load_mono(wav)
            bpm, beats, beat_frames = tempo_beats(y, sr)
            result['bpm'] = bpm
            result['beats'] = beats
            result['timeSig'] = '4/4'
            chroma = chroma_of(y, sr) if set(steps) & {'key', 'chords'} else None
            if 'key' in steps or 'chords' in steps:
                progress(at + 0.03, 'Detecting key')
                key, kc = detect_key(chroma)
                result['key'] = key
                result['keyConfidence'] = kc
            if 'chords' in steps:
                progress(at + 0.06, 'Detecting chords')
                result['chords'] = detect_chords(chroma, sr, beat_frames, result.get('key') in FLAT_KEYS)
            if 'sections' in steps:
                progress(at + 0.1, 'Finding song sections')
                result['sections'] = detect_sections(y, sr, beat_frames, duration)
            at += 0.94 * rest / total

        if 'notes' in steps:
            for part in parts or ['mix']:
                progress(at, 'Extracting notes: ' + part)
                if part == 'mix':
                    src = wav
                else:
                    stem = os.path.join(stem_dir, part + '.mp3')
                    if not os.path.exists(stem):
                        emit(warning='No ' + part + ' stem — separate stems first; skipped')
                        continue
                    src = os.path.join(work, part + '.wav')
                    to_wav(stem, src, mono=True)
                notes = extract_notes(src)
                with open(os.path.join(run_dir, 'notes-' + part + '.json'), 'w') as f:
                    json.dump(notes, f)
                result['parts'].append({'name': part, 'count': len(notes)})
                at += 0.94 * 0.25 / total

        with open(os.path.join(run_dir, 'analysis.json'), 'w') as f:
            json.dump(result, f, indent=1)
        progress(1.0, 'Done')
        emit(result=result)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cmd_warmup(_a):
    progress(0.1, 'Loading the stem separation model (first time downloads ~300 MB)')
    from demucs.pretrained import get_model
    get_model('htdemucs_6s')
    progress(0.6, 'Loading the note model')
    from basic_pitch import ICASSP_2022_MODEL_PATH  # noqa: F401
    from basic_pitch.inference import Model
    Model(ICASSP_2022_MODEL_PATH)
    progress(0.9, 'Loading librosa')
    import librosa  # noqa: F401
    progress(1.0, 'Models ready')
    emit(result=versions())


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check')
    sub.add_parser('warmup')
    an = sub.add_parser('analyze')
    an.add_argument('--input', required=True)
    an.add_argument('--out', required=True)
    an.add_argument('--run')
    an.add_argument('--steps', default='stems,notes,tempo,key,chords,sections')
    an.add_argument('--parts', default='')
    an.add_argument('--stems-model', default='htdemucs_6s')
    a = ap.parse_args()
    try:
        if a.cmd == 'check':
            emit(result=versions())
        elif a.cmd == 'warmup':
            cmd_warmup(a)
        else:
            cmd_analyze(a)
    except Exception as e:  # noqa: BLE001
        emit(error=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
