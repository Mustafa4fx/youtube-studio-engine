// Renders a video spec (JSON) into an MP4: TTS per beat + animated HTML scenes + SFX
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sh, duration, ensureSfx, tts, estimateWords, geminiBatch, geminiRequest } = require('./lib');

const FPS = 30;

async function render(spec, outDir, opts = {}) {
  const log = opts.log || console.log;
  const mock = !!opts.mock;
  const vertical = !!spec.vertical;
  const W = vertical ? 1080 : 1920, H = vertical ? 1920 : 1080;
  fs.mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, 'work'); fs.mkdirSync(work, { recursive: true });
  const sfxDir = opts.sfxDir || path.join(__dirname, 'sfx');
  await ensureSfx(sfxDir);

  // FAST capture: Chrome's deterministic BeginFrame mode (one CDP call = paint + screenshot), ~1.5x faster than page.screenshot.
  // If anything goes wrong in that mode, the whole render is retried automatically with the classic capture.
  const FAST = !opts.legacyCapture && process.env.CAPTURE !== 'screenshot';
  const baseArgs = ['--no-sandbox', '--font-render-hinting=none', '--disable-gpu', '--disable-gpu-compositing', '--disable-dev-shm-usage'];
  const fastArgs = ['--deterministic-mode', '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging', '--disable-image-animation-resync', '--enable-surface-synchronization'];
  // fast mode: one Chrome process per worker (BeginFrame control is per browser); classic: one shared browser
  const browsers = []; opts._browsers = browsers;
  const launch = async () => { const b = await chromium.launch({ args: FAST ? [...baseArgs, ...fastArgs] : baseArgs }); browsers.push(b); return b; };
  const browser = FAST ? null : await launch();
  const STEP = 1000 / FPS;
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('BEGINFRAME timeout: ' + what)), ms))]);
  const fams = Object.values(spec.theme.vars || {}).filter(v => /'/.test(v)).flatMap(v => v.match(/'([^']+)'/g) || []).map(x => x.replace(/'/g, ''));
  const makePage = async () => {
    const pg = await (FAST ? await launch() : browser).newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    if (FAST) {
      const cdp = await pg.context().newCDPSession(pg);
      let tick = 0, chain = Promise.resolve(), pending = 0;
      const bf = params => { pending++; const p = chain.then(() => cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: (tick += STEP), interval: STEP, ...params })); chain = p.catch(() => {}).then(() => { pending--; }); return p; };
      // keep the page's event loop/compositor alive while loading/decoding (only when no capture is queued)
      pg._pump = setInterval(() => { if (!pending) bf({ noDisplayUpdates: true }).catch(() => {}); }, 33); pg._pump.unref();
      let last = null; const SS = { screenshot: { format: 'jpeg', quality: 88, optimizeForSpeed: true } };
      pg._shot = async file => {
        let r = await withTimeout(bf(SS), 30000, 'frame');
        if (!r.screenshotData) { // nothing changed on screen -> Chrome returns no image: nudge an invisible pixel and retry, else reuse last frame
          await pg.evaluate(() => { let d = document.getElementById('__nudge'); if (!d) { d = document.createElement('div'); d.id = '__nudge'; d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647'; document.body.appendChild(d); } d.style.background = d.style.background === 'rgba(0, 0, 0, 0.004)' ? 'rgba(0, 0, 0, 0.005)' : 'rgba(0, 0, 0, 0.004)'; });
          r = await withTimeout(bf(SS), 30000, 'frame');
        }
        const buf = r.screenshotData ? Buffer.from(r.screenshotData, 'base64') : last;
        if (!buf) throw new Error('BEGINFRAME no image ' + JSON.stringify(r).slice(0, 120) + ' file=' + path.basename(file)); last = buf; fs.writeFileSync(file, buf); };
    } else pg._shot = file => pg.screenshot({ path: file, type: 'jpeg', quality: 88 });
    await pg.goto('file://' + path.join(__dirname, 'stage.html'), { waitUntil: FAST ? 'load' : 'domcontentloaded' });
    if (!FAST) { try { await pg.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {} }
    await pg.evaluate(() => document.fonts.ready.then(() => true));
    // make sure theme fonts are actually downloaded before the first frame
    await pg.evaluate(async fs => { for (const f of fs) for (const w of [600, 700, 800, 900]) await document.fonts.load(`${w} 48px "${f}"`, 'عربي ABC 123').catch(() => {}); }, [...new Set(fams)]);
    return pg;
  };
  const only = opts.only ? new Set(opts.only) : null;
  // voice cache + batch synthesis (6 beats per request) to stay inside the TTS request limits
  const cdir = path.join(process.env.CACHE_ROOT || (fs.existsSync('/out') ? '/out' : path.dirname(path.resolve(outDir))), 'tts-cache'); fs.mkdirSync(cdir, { recursive: true });
  const cacheOf = beat => path.join(cdir, require('crypto').createHash('sha1').update([spec.provider, spec.voice, spec.lang, spec.style, beat.rate || spec.rate, beat.say].join('|')).digest('hex') + (mock ? '.mock' : '') + '.mp3');
  // ONE continuous narration for the whole video (natural flow), then Whisper word-alignment cuts it per beat
  let continuousOk = false;
  if (!opts.noVoice && !mock && spec.provider === 'gemini' && spec.continuous !== false && !only) {
    try {
      const said = spec.beats.map(b => (b.say || '').trim());
      const full = said.filter(Boolean).join('\n');
      const tempo = spec.tempo || 1.1;
      const key = require('crypto').createHash('sha1').update(['full', spec.voice, spec.style, tempo, full].join('|')).digest('hex');
      const wav = path.join(cdir, 'full-' + key + '.wav');
      if (!fs.existsSync(wav)) {
        log('voice: one continuous narration');
        const sys = (spec.style ? spec.style + ' ' : '') + 'Speak ONLY the user text, word for word, never these instructions. Read the whole text as ONE continuous, flowing, energetic narration: connect the sentences naturally, keep every pause short and tight, never a long pause.';
        const pcm = await geminiRequest(full, spec.voice, sys, log);
        if (!pcm) throw new Error('empty audio');
        const raw = wav + '.pcm'; fs.writeFileSync(raw, pcm);
        await sh('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-af',
          `silenceremove=start_periods=1:start_threshold=-45dB,silenceremove=stop_periods=-1:stop_duration=0.28:stop_threshold=-42dB,atempo=${tempo},aresample=48000`, wav + '.tmp.wav']);
        fs.rmSync(raw); fs.renameSync(wav + '.tmp.wav', wav);
      }
      const aj = wav.replace(/\.wav$/, '.align.json');
      let al = null;
      try {
        if (!fs.existsSync(aj)) {
          log('voice: aligning words (whisper)');
          const bj = wav + '.beats.json'; fs.writeFileSync(bj, JSON.stringify(said));
          const o = await sh('python3', [path.join(__dirname, 'align.py'), wav, bj, (spec.lang || 'en').slice(0, 2), aj], { env: { ...process.env, WHISPER_DIR: path.join(cdir, '..', '_models') } });
          log(String(o).trim().slice(-300));
        }
        al = JSON.parse(fs.readFileSync(aj, 'utf8'));
        if (al.matched / Math.max(1, al.total_words) < 0.5) throw new Error(`alignment too weak (${al.matched}/${al.total_words})`);
      } catch (e) {
        // whisper not available/weak -> keep the SAME continuous narration and cut it at its real pauses
        log('whisper failed (' + String(e.message).slice(-400).replace(/\s+/g, ' ') + ') -> cutting the continuous voice at its pauses');
        al = await splitAtPauses(wav, said);
      }
      const B = al.beats; const audioEnd = await duration(wav);
      // cut points: middle of the gap between consecutive spoken beats
      const starts = []; let prevEnd = 0;
      for (let i = 0; i < B.length; i++) {
        if (B[i].start == null) { starts.push(null); continue; }
        starts.push(i === 0 ? 0 : (prevEnd + B[i].start) / 2); prevEnd = B[i].end;
      }
      const idx = starts.map((s, i) => s == null ? -1 : i).filter(i => i >= 0);
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n]; const s0 = starts[i]; const s1 = n + 1 < idx.length ? starts[idx[n + 1]] : audioEnd;
        const id = String(i).padStart(3, '0'); const vf = path.join(work, `v${id}.mp3`);
        await sh('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ss', s0.toFixed(3), '-to', s1.toFixed(3), '-b:a', '192k', vf]);
        fs.writeFileSync(vf.replace(/\.mp3$/, '.words.json'), JSON.stringify(B[i].words.map(w => ({ w: w.w, s: Math.max(0, w.s - s0), e: Math.max(0, w.e - s0) }))));
      }
      spec.lead = 0; spec.pause = 0; continuousOk = true;
      log(`voice: continuous ok (${al.matched}/${al.total_words} words matched)`);
    } catch (e) { if (/DAILY/.test(e.message)) throw e; log('continuous voice failed -> per-chunk: ' + e.message.slice(0, 300)); }
  }
  if (!opts.noVoice && !continuousOk && !mock && spec.provider === 'gemini') {
    const todo = spec.beats.map((b, i) => ({ b, i })).filter(x => (!only || only.has(x.i)) && x.b.say && x.b.say.trim() && !fs.existsSync(cacheOf(x.b)));
    for (let k = 0; k < todo.length; k += 6) { const grp = todo.slice(k, k + 6);
      log(`voice batch ${k / 6 + 1}/${Math.ceil(todo.length / 6)}`);
      const outs = grp.map(x => cacheOf(x.b) + '.tmp.mp3');
      const ok = await geminiBatch({ texts: grp.map(x => x.b.say), voice: spec.voice, style: spec.style, outs, log, lang: spec.cloudLang || (spec.lang && spec.lang.startsWith('ar') ? 'ar-EG' : 'en-US') }).catch(e => { if (/DAILY/.test(e.message)) throw e; log('batch error ' + e.message); return false; });
      if (ok) grp.forEach((x, j) => fs.renameSync(outs[j], cacheOf(x.b))); }
  }
  // parallel export: several browser pages render different beats at the same time
  const segs = [];
  // CLOUD: send the scenes to Google Cloud Run (many machines at once); anything that fails there is rendered here
  const remoteDone = new Set();
  if (opts.remote && !only) {
    try { const got = await opts.remote({ spec, work, log, FPS });
      for (const [i, f] of Object.entries(got)) { segs[+i] = f; remoteDone.add(+i); }
      log(`cloud: ${remoteDone.size}/${spec.beats.length} scenes rendered in the cloud`);
    } catch (e) { log('cloud render failed -> local: ' + String(e.message).slice(0, 300)); }
  }
  const left = spec.beats.map((_, i) => i).filter(i => !remoteDone.has(i) && (!only || only.has(i)));
  const WORKERS = Math.max(1, Math.min(+(process.env.RENDER_WORKERS || 3), left.length || 1));
  const pages = left.length ? await Promise.all(Array.from({ length: WORKERS }, () => makePage())) : [];
  let next = 0, done = 0;
  const doBeat = async (i, page) => {
    if (only && !only.has(i)) return;
    const beat = spec.beats[i];
    const id = String(i).padStart(3, '0');
    log(`beat ${i + 1}/${spec.beats.length}`);
    // 1) narration
    const voiceFile = path.join(work, `v${id}.mp3`);
    if (beat.say && beat.say.trim()) {
      if (!opts.noVoice && (!fs.existsSync(voiceFile) || opts.force)) {
        // persistent voice cache: a sentence is synthesized once, ever (saves quota and time on re-renders)
        const cf = cacheOf(beat);
        if (!fs.existsSync(cf)) await tts({ text: beat.say, voice: spec.voice, lang: spec.lang, rate: beat.rate || spec.rate, out: cf + '.tmp.mp3', mock, provider: spec.provider, style: spec.style }).then(() => fs.renameSync(cf + '.tmp.mp3', cf));
        if (continuousOk) fs.copyFileSync(cf, voiceFile);
        else await sh('ffmpeg', ['-y', '-v', 'error', '-i', cf, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=stop_periods=-1:stop_duration=0.25:stop_threshold=-42dB', '-b:a', '192k', voiceFile]).catch(() => fs.copyFileSync(cf, voiceFile));
      }
    }
    const lead = beat.lead ?? spec.lead ?? 0.06, pad = beat.pause ?? spec.pause ?? 0.12;
    const vdur = fs.existsSync(voiceFile) ? await duration(voiceFile) : 0;
    const total = Math.max(beat.min || 1.2, lead + vdur + pad);

    // 2) word timing (provider timestamps if present, else estimate) -> fully animated frames for the whole beat
    const wordsFile = voiceFile.replace(/\.mp3$/, '.words.json');
    let words = fs.existsSync(wordsFile) ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')) : estimateWords(beat.say || '', vdur);
    words = words.map(w => ({ w: w.w, s: Math.round((lead + w.s) * 1000), e: Math.round((lead + w.e) * 1000) }));
    const tm = { words, total: Math.round(total * 1000), voiceStart: Math.round(lead * 1000), voiceEnd: Math.round((lead + vdur) * 1000) };
    await page.evaluate(([b, t, v, m]) => window.setup(b, t, v, m), [{ ...beat, _i: i + 1 }, { ...spec.theme, speed: spec.speed || 1 }, vertical, tm]);
    await page.evaluate(() => window.ready && window.ready());
    await page.waitForTimeout(40);
    const nFrames = Math.max(1, Math.ceil(total * FPS));
    const fdir = path.join(work, `f${id}`); fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir);
    for (let f = 0; f < nFrames; f++) {
      await page.evaluate(ms => window.seek(ms), (f / FPS) * 1000);
      await page._shot(path.join(fdir, `${String(f).padStart(5, '0')}.jpg`));
    }
    const segV = path.join(work, `s${id}.mp4`);
    const vArgs = ['-y', '-framerate', String(FPS), '-i', path.join(fdir, '%05d.jpg')];
    const filter = `[0:v]format=yuv420p[v]`;
    // auto sfx: whoosh on every cut + pop on each emphasised word / icon
    const hl = new Set((beat.hl || []).map(x => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')));
    const auto = [{ name: 'whoosh', at: 0, vol: 0.35 }];
    for (const w of words) { const n = w.w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); if (hl.has(n) || /\d/.test(w.w)) auto.push({ name: 'pop', at: w.s / 1000 / (spec.speed || 1), vol: 0.45 }); }
    (beat.icons || []).forEach((ic, j, arr) => { const wi = (typeof ic === 'object' && ic.at != null) ? ic.at : Math.floor((j + 0.5) * words.length / Math.max(1, arr.length)); const w = words[Math.min(words.length - 1, Math.max(0, wi))]; if (w) auto.push({ name: 'zap', at: w.s / 1000 / (spec.speed || 1), vol: 0.4 }); });
    words.forEach((w, i) => { if (i < words.length - 1 && /[.!?؟…:]$/.test(w.w)) auto.push({ name: 'whoosh', at: (words[i + 1].s - 60) / 1000 / (spec.speed || 1), vol: 0.28 }); });
    beat.sfx = [...(beat.sfx || []), ...auto];
    // 3) audio: narration + sfx
    const aIn = [], aLabels = [];
    let k = vArgs.filter(a => a === '-i').length;
    if (vdur > 0) { vArgs.push('-i', voiceFile); aIn.push(`[${k}:a]adelay=${Math.round(lead * 1000)}|${Math.round(lead * 1000)},aformat=channel_layouts=stereo,aresample=48000[a${k}]`); aLabels.push(`[a${k}]`); k++; }
    for (const s of beat.sfx || []) {
      const name = typeof s === 'string' ? s : s.name; const at = (typeof s === 'string' ? 0 : (s.at || 0)) * (spec.speed || 1); const vol = typeof s === 'string' ? 0.55 : (s.vol ?? 0.55);
      const f = path.join(sfxDir, name + '.wav'); if (!fs.existsSync(f)) continue;
      vArgs.push('-i', f); aIn.push(`[${k}:a]volume=${vol},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[a${k}]`); aLabels.push(`[a${k}]`); k++;
    }
    let afilter;
    if (aLabels.length) afilter = `${aIn.join(';')};${aLabels.join('')}amix=inputs=${aLabels.length}:normalize=0,apad,atrim=0:${total.toFixed(3)}[a]`;
    else { vArgs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'); afilter = `[${k}:a]anull[a]`; }
    vArgs.push('-filter_complex', `${filter};${afilter}`, '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', segV);
    await sh('ffmpeg', vArgs);
    fs.rmSync(fdir, { recursive: true, force: true });
    segs[i] = segV;
    };
  await Promise.all(pages.map(async pg => { while (next < left.length) { const i = left[next++]; await doBeat(i, pg); done++; } }));
  for (const pg of pages) clearInterval(pg._pump);
  await Promise.all(browsers.map(b => b.close().catch(() => {})));
  if (opts.segmentsOnly) return segs; // cloud task: the server joins the pieces

  // 4) join + loudness normalisation
  const list = path.join(work, 'list.txt');
  fs.writeFileSync(list, segs.filter(Boolean).map(s => `file '${s}'`).join('\n'));
  const out = path.join(outDir, (spec.id || 'video') + '.mp4');
  await sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);
  log('done ' + out);
  return out;
}

// Fallback alignment without Whisper: cut ONE continuous narration at its real pauses, matching each beat's share of the text
async function splitAtPauses(wav, said) {
  const total = await duration(wav);
  const det = await new Promise(res => require('child_process').execFile('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'silencedetect=noise=-36dB:d=0.09', '-f', 'null', '-'], { maxBuffer: 32 << 20 }, (e, o, er) => res(String(er || ''))));
  const txt = String(det); const gaps = []; let st = null;
  for (const line of txt.split('\n')) { let m = line.match(/silence_start: ([\d.]+)/); if (m) st = +m[1]; m = line.match(/silence_end: ([\d.]+)/); if (m && st != null) { gaps.push((st + +m[1]) / 2); st = null; } }
  const w = said.map(t => [...(t || '')].length); const sum = w.reduce((a, b) => a + b, 0) || 1;
  const spoken = said.map((t, i) => (t || '').trim() ? i : -1).filter(i => i >= 0);
  const cuts = [0]; let acc = 0, used = -1;
  for (let n = 0; n < spoken.length - 1; n++) {
    acc += w[spoken[n]]; const exp = total * acc / sum;
    let best = -1, bd = 1e9; for (let g = used + 1; g < gaps.length; g++) { const d = Math.abs(gaps[g] - exp); if (d < bd) { bd = d; best = g; } }
    if (best >= 0 && bd < 1.6) { cuts.push(gaps[best]); used = best; } else cuts.push(Math.max(cuts[cuts.length - 1] + 0.3, exp));
  }
  cuts.push(total);
  const beats = said.map(() => ({ start: null, end: null, words: [] }));
  spoken.forEach((i, n) => { const a = cuts[n], b = cuts[n + 1];
    beats[i] = { start: a, end: b, words: estimateWords(said[i], b - a).map(x => ({ w: x.w, s: a + x.s, e: a + x.e })) }; });
  return { beats, matched: 1, total_words: 1, audio_end: total, method: 'pauses' };
}

async function renderSafe(spec, outDir, opts = {}) {
  try { return await render(spec, outDir, opts); }
  catch (e) { await Promise.all((opts._browsers || []).map(b => b.close().catch(() => {})));
    if (opts.legacyCapture || process.env.CAPTURE === 'screenshot' || !/BEGINFRAME|beginFrame|HeadlessExperimental|Target closed|Timeout/i.test(e.message)) throw e;
    (opts.log || console.log)('fast capture failed (' + e.message.slice(0, 160) + ') -> retrying with classic capture');
    return render(spec, outDir, { ...opts, legacyCapture: true });
  }
}
module.exports = { render: renderSafe };

if (require.main === module) {
  const [specFile, outDir, ...flags] = process.argv.slice(2);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const onlyArg = flags.find(f => f.startsWith('--only='));
  render(spec, outDir, { mock: flags.includes('--mock'), only: onlyArg ? onlyArg.slice(7).split(',').map(Number) : null })
    .catch(e => { console.error(e); process.exit(1); });
}
