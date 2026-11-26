#!/usr/bin/env python3
"""Word-level alignment of a known script to one continuous narration.
usage: align.py <audio.wav> <beats.json> <lang en|ar> <out.json>
beats.json = ["beat 1 text", "beat 2 text", ...]
out.json   = [{"start":s,"end":e,"words":[{"w":..,"s":..,"e":..}]}, ...]  (seconds, absolute)
"""
import json, os, re, sys, unicodedata, difflib

audio, beats_f, lang, out_f = sys.argv[1:5]
beats = json.load(open(beats_f))

AR_DIAC = re.compile('[ؐ-ًؚ-ٰٟۖ-ۭـ]')
def norm(w):
    w = unicodedata.normalize('NFKC', w.lower())
    w = AR_DIAC.sub('', w)
    w = w.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه').replace('ى', 'ي').replace('ؤ', 'و').replace('ئ', 'ي')
    return re.sub(r'[^\w]', '', w)

script = []  # (beat index, original word)
for bi, t in enumerate(beats):
    for w in t.split():
        script.append((bi, w))

from faster_whisper import WhisperModel
model = WhisperModel(os.environ.get('WHISPER_MODEL', 'small'), device='cpu', compute_type='int8',
                     download_root=os.environ.get('WHISPER_DIR', '/out/_models'))
segs, info = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=False, beam_size=1,
                              initial_prompt=' '.join(b for b in beats)[:800])
heard = [(w.word.strip(), w.start, w.end) for s in segs for w in (s.words or []) if w.word.strip()]

a = [norm(w) for _, w in script]; b = [norm(h[0]) for h in heard]
times = [None] * len(script)
sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
for blk in sm.get_matching_blocks():
    for k in range(blk.size):
        times[blk.a + k] = (heard[blk.b + k][1], heard[blk.b + k][2])
# fuzzy pass for near-matches inside replaced regions
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == 'replace':
        for i in range(i1, i2):
            best, bj = 0, None
            for j in range(j1, j2):
                r = difflib.SequenceMatcher(a=a[i], b=b[j]).ratio()
                if r > best: best, bj = r, j
            if bj is not None and best >= 0.6:
                times[i] = (heard[bj][1], heard[bj][2])
# enforce monotonic + interpolate gaps
total = heard[-1][2] if heard else 1.0
last = 0.0
for i, t in enumerate(times):
    if t and t[0] >= last - 0.05: last = t[1]
    else: times[i] = None
i = 0
while i < len(times):
    if times[i] is None:
        j = i
        while j < len(times) and times[j] is None: j += 1
        s0 = times[i - 1][1] if i > 0 else 0.0
        s1 = times[j][0] if j < len(times) else total
        n = j - i; step = max(0.05, (s1 - s0) / n)
        for k in range(n): times[i + k] = (s0 + k * step, s0 + (k + 1) * step - 0.02)
        i = j
    else: i += 1

out = []
for bi in range(len(beats)):
    ws = [{'w': script[k][1], 's': times[k][0], 'e': times[k][1]} for k in range(len(script)) if script[k][0] == bi]
    out.append({'words': ws, 'start': ws[0]['s'] if ws else None, 'end': ws[-1]['e'] if ws else None})
matched = sum(1 for blk in sm.get_matching_blocks() for _ in range(blk.size))
json.dump({'beats': out, 'matched': matched, 'total_words': len(script), 'audio_end': total}, open(out_f, 'w'), ensure_ascii=False)
print(f'aligned {matched}/{len(script)} words')
