// Renders a video spec (JSON) into an MP4: TTS per beat + animated HTML scenes + SFX
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sh, duration, ensureSfx, tts, estimateWords, geminiBatch } = require('./lib');

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

  const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'stage.html'), { waitUntil: 'domcontentloaded' });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {}
  await page.evaluate(() => document.fonts.ready.then(() => true));

  // make sure theme fonts are actually downloaded before the first frame
  const fams = Object.values(spec.theme.vars || {}).filter(v => /'/.test(v)).flatMap(v => v.match(/'([^']+)'/g) || []).map(x => x.replace(/'/g, ''));
  await page.evaluate(async fs => { for (const f of fs) for (const w of [600, 700, 800, 900]) await document.fonts.load(`${w} 48px "${f}"`, 'عربي ABC 123').catch(() => {}); }, [...new Set(fams)]);
  const only = opts.only ? new Set(opts.only) : null;
  // voice cache + batch synthesis (6 beats per request) to stay inside the TTS request limits
  const cdir = path.join(process.env.CACHE_ROOT || (fs.existsSync('/out') ? '/out' : path.dirname(path.resolve(outDir))), 'tts-cache'); fs.mkdirSync(cdir, { recursive: true });
  const cacheOf = beat => path.join(cdir, require('crypto').createHash('sha1').update([spec.provider, spec.voice, spec.lang, spec.style, beat.rate || spec.rate, beat.say].join('|')).digest('hex') + (mock ? '.mock' : '') + '.mp3');
  if (!mock && spec.provider === 'gemini') {
    const todo = spec.beats.map((b, i) => ({ b, i })).filter(x => (!only || only.has(x.i)) && x.b.say && x.b.say.trim() && !fs.existsSync(cacheOf(x.b)));
    for (let k = 0; k < todo.length; k += 6) { const grp = todo.slice(k, k + 6);
      log(`voice batch ${k / 6 + 1}/${Math.ceil(todo.length / 6)}`);
      const outs = grp.map(x => cacheOf(x.b) + '.tmp.mp3');
      const ok = await geminiBatch({ texts: grp.map(x => x.b.say), voice: spec.voice, style: spec.style, outs, log, lang: spec.cloudLang || (spec.lang && spec.lang.startsWith('ar') ? 'ar-EG' : 'en-US') }).catch(e => { if (/DAILY/.test(e.message)) throw e; log('batch error ' + e.message); return false; });
      if (ok) grp.forEach((x, j) => fs.renameSync(outs[j], cacheOf(x.b))); }
  }
  const segs = [];
  for (let i = 0; i < spec.beats.length; i++) {
    if (only && !only.has(i)) continue;
    const beat = spec.beats[i];
    const id = String(i).padStart(3, '0');
    log(`beat ${i + 1}/${spec.beats.length}`);
    // 1) narration
    const voiceFile = path.join(work, `v${id}.mp3`);
    if (beat.say && beat.say.trim()) {
      if (!fs.existsSync(voiceFile) || opts.force) {
        // persistent voice cache: a sentence is synthesized once, ever (saves quota and time on re-renders)
        const cf = cacheOf(beat);
        if (!fs.existsSync(cf)) await tts({ text: beat.say, voice: spec.voice, lang: spec.lang, rate: beat.rate || spec.rate, out: cf + '.tmp.mp3', mock, provider: spec.provider, style: spec.style }).then(() => fs.renameSync(cf + '.tmp.mp3', cf));
        fs.copyFileSync(cf, voiceFile);
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
      await page.screenshot({ path: path.join(fdir, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 88 });
    }
    const segV = path.join(work, `s${id}.mp4`);
    const vArgs = ['-y', '-framerate', String(FPS), '-i', path.join(fdir, '%05d.jpg')];
    const filter = `[0:v]format=yuv420p[v]`;
    // auto sfx: whoosh on every cut + pop on each emphasised word / icon
    const hl = new Set((beat.hl || []).map(x => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')));
    const auto = [{ name: 'whoosh', at: 0, vol: 0.35 }];
    for (const w of words) { const n = w.w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); if (hl.has(n) || /\d/.test(w.w)) auto.push({ name: 'pop', at: w.s / 1000 / (spec.speed || 1), vol: 0.45 }); }
    (beat.icons || []).forEach((ic, j, arr) => { const wi = (typeof ic === 'object' && ic.at != null) ? ic.at : Math.floor((j + 0.5) * words.length / Math.max(1, arr.length)); const w = words[Math.min(words.length - 1, Math.max(0, wi))]; if (w) auto.push({ name: 'zap', at: w.s / 1000 / (spec.speed || 1), vol: 0.4 }); });
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
    segs.push(segV);
  }
  await browser.close();

  // 4) join + loudness normalisation
  const list = path.join(work, 'list.txt');
  fs.writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
  const out = path.join(outDir, (spec.id || 'video') + '.mp4');
  await sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);
  log('done ' + out);
  return out;
}

module.exports = { render };

if (require.main === module) {
  const [specFile, outDir, ...flags] = process.argv.slice(2);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const onlyArg = flags.find(f => f.startsWith('--only='));
  render(spec, outDir, { mock: flags.includes('--mock'), only: onlyArg ? onlyArg.slice(7).split(',').map(Number) : null })
    .catch(e => { console.error(e); process.exit(1); });
}
