// Resolve beat.media requests into local files (runs on the server, before render).
//  {kind:'stock', query, video:true|false, mode:'bg'|'full'}  -> Pexels, filtered by Gemini vision (no people / animals / living beings)
//  {kind:'web', urls:[...], find:'text', mode:'full', fallback:{kind:'news',...}} -> Playwright screenshot, images on the page blurred
//  {kind:'news', items:[{source,title,date}]} -> no fetch needed
const fs = require('fs'); const path = require('path'); const { sh } = require('./lib');
const PIXABAY = process.env.PIXABAY_API_KEY, PEXELS = process.env.PEXELS_API_KEY, GK = process.env.GEMINI_API_KEY;
let visionModel = process.env.GEMINI_VISION_MODEL || null; let visionDead = false; let visionList = []; const visionTired = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pickVisionModel(log) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GK } });
    const j = await r.json(); const ms = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', '')).filter(n => /flash/.test(n) && !/(tts|image|live|audio|embed|thinking|exp)/.test(n));
    const score = n => { const v = parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [0, 0])[1]); return v * 10 + (/preview/.test(n) ? 0 : 3) + (/lite/.test(n) ? 1 : 2) + (/-\d{3,}/.test(n) ? -1 : 0); };
    // lite models first: cheapest and the most generous free limits
    ms.sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || (score(b) - score(a))); visionList = ms; log('vision models available: ' + ms.slice(0, 6).join(', '));
    return ms.find(m => !visionTired.has(m)) || null;
  } catch (e) { log('model list failed ' + e.message); return null; }
}
async function isClean(jpgBuf, log) {
  if (!GK || visionDead) return false; // never use unchecked stock media
  if (!visionModel) { visionModel = await pickVisionModel(log); if (!visionModel) { visionDead = true; log('NO VISION MODEL -> stock media disabled'); return false; } log('vision model: ' + visionModel); }
  const prompt = 'Check this image carefully and answer YES if ANY of these is true, otherwise NO: (1) it shows any woman, girl or female person, even partially (hands, hair, silhouette, reflection, far in the background, on a poster or screen); (2) it is NOT a real camera photograph - e.g. a drawing, illustration, cartoon, painting, 3D render, CGI or AI-generated image - AND it depicts a human, animal or any living being with a head (statues, dolls and toys of living beings count too); (3) it shows a religious symbol of any religion, alcohol, gambling, or immodest content. Real camera photos of men or real animals are allowed. Reply with exactly one word: YES or NO.';
  let fails = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': GK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpgBuf.toString('base64') } }, { text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 5 } }) });
    const j = await r.json().catch(() => ({}));
    const t = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim().toUpperCase();
    if (r.ok && t) return t.startsWith('NO');
    log(`vision error ${r.status}: ${JSON.stringify(j.error || j).slice(0, 220)}`);
    if (r.status === 404 || r.status === 400) { const m = await pickVisionModel(log); if (m && m !== visionModel) { visionModel = m; continue; } visionDead = true; return false; }
    if (r.status === 429) { visionTired.add(visionModel); const next = visionList.find(m => !visionTired.has(m)); if (next) { log('switching vision model -> ' + next); visionModel = next; continue; } if (++fails >= 2) { visionDead = true; log('vision quota exhausted on all models -> stock media disabled for this run'); return false; } }
    await sleep(6000 * (attempt + 1));
  }
  return false;
}
async function getBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error('GET ' + r.status + ' ' + url); return Buffer.from(await r.arrayBuffer()); }


async function framesClean(mp4, dir, id, log) { // check 3 frames from the actual clip
  const d = await require('./lib').duration(mp4).catch(() => 6); const tmp = path.join(dir, id + '-chk.jpg');
  for (const f of [0.12, 0.5, 0.88]) { await sh('ffmpeg', ['-y', '-v', 'error', '-ss', String(d * f), '-i', mp4, '-frames:v', '1', '-vf', 'scale=640:-2', tmp]);
    if (!(await isClean(fs.readFileSync(tmp), log))) { fs.rmSync(tmp, { force: true }); return false; } }
  fs.rmSync(tmp, { force: true }); return true;
}
async function pixabay(req, dir, id, log, used) {
  for (const q of [req.query, ...(req.alt || [])]) {
    const base = req.video ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
    const url = `${base}?key=${PIXABAY}&q=${encodeURIComponent(q)}&safesearch=true&per_page=20` + (req.video ? '&video_type=film' : '&image_type=photo&orientation=horizontal&min_width=1600');
    const r = await fetch(url); if (!r.ok) { log('pixabay ' + r.status); continue; }
    const hits = (await r.json()).hits || [];
    for (const h of hits) {
      if (used.has('x' + h.id)) continue;
      try {
        if (req.video) {
          const v = h.videos?.medium?.url ? h.videos.medium : (h.videos?.large?.url ? h.videos.large : h.videos?.small); if (!v || !v.url) continue;
          if (v.thumbnail && !(await isClean(await getBuf(v.thumbnail), log))) continue;
          const mp4 = path.join(dir, `${id}.mp4`); fs.writeFileSync(mp4, await getBuf(v.url));
          if (!(await framesClean(mp4, dir, id, log))) { fs.rmSync(mp4); continue; }
          const fd = path.join(dir, `${id}-frames`); fs.rmSync(fd, { recursive: true, force: true }); fs.mkdirSync(fd);
          await sh('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-t', String(req.seconds || 12), '-vf', 'fps=30,scale=1280:-2', '-q:v', '4', path.join(fd, '%04d.jpg')]);
          const n = fs.readdirSync(fd).length; fs.rmSync(mp4); used.add('x' + h.id);
          log(`stock video "${q}" -> pixabay ${h.id} (${n} frames)`);
          return { kind: 'video', frames: fd, n, mode: req.mode || 'bg', credit: `Pixabay / ${h.user || ''}` };
        } else {
          if (!(await isClean(await getBuf(h.webformatURL), log))) continue;
          const out = path.join(dir, `${id}.jpg`); fs.writeFileSync(out, await getBuf(h.largeImageURL)); used.add('x' + h.id);
          log(`stock photo "${q}" -> pixabay ${h.id}`);
          return { kind: 'photo', src: out, mode: req.mode || 'bg', credit: `Pixabay / ${h.user || ''}` };
        }
      } catch (e) { log('stock item error ' + e.message); }
    }
  }
  throw new Error('no clean pixabay media for ' + req.query);
}
async function stock(req, dir, id, log, used) {
  if (visionDead) throw new Error('vision unavailable');
  if (PIXABAY) return pixabay(req, dir, id, log, used);
  if (!PEXELS) throw new Error('no stock API key (PIXABAY_API_KEY)');
  const qs = [req.query, ...(req.alt || [])];
  for (const q of qs) {
    const isVid = !!req.video;
    const url = isVid ? `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(q)}&per_page=15&orientation=landscape&size=medium`
                      : `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=15&orientation=landscape`;
    const r = await fetch(url, { headers: { Authorization: PEXELS } }); if (!r.ok) { log('pexels ' + r.status); continue; }
    const j = await r.json(); const list = isVid ? (j.videos || []) : (j.photos || []);
    for (const it of list) {
      if (used.has(it.id)) continue;
      try {
        if (isVid) {
          const pics = (it.video_pictures || []).map(p => p.picture); if (!pics.length) continue;
          // check 3 frames across the clip
          const picks = [pics[0], pics[Math.floor(pics.length / 2)], pics[pics.length - 1]];
          let ok = true; for (const p of picks) { if (!(await isClean(await getBuf(p), log))) { ok = false; break; } }
          if (!ok) continue;
          const f = (it.video_files || []).filter(v => v.link && v.width && v.width >= 960 && v.width <= 1920).sort((a, b) => a.width - b.width)[0] || (it.video_files || [])[0];
          if (!f) continue;
          const mp4 = path.join(dir, `${id}.mp4`); fs.writeFileSync(mp4, await getBuf(f.link));
          const fd = path.join(dir, `${id}-frames`); fs.rmSync(fd, { recursive: true, force: true }); fs.mkdirSync(fd);
          await sh('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-t', String(req.seconds || 12), '-vf', 'fps=30,scale=1280:-2', '-q:v', '4', path.join(fd, '%04d.jpg')]);
          const n = fs.readdirSync(fd).length; fs.rmSync(mp4); used.add(it.id);
          log(`stock video "${q}" -> pexels ${it.id} (${n} frames)`);
          return { kind: 'video', frames: fd, n, mode: req.mode || 'bg', credit: `Pexels / ${it.user?.name || ''}` };
        } else {
          const prev = await getBuf(it.src.medium); if (!(await isClean(prev, log))) continue;
          const out = path.join(dir, `${id}.jpg`); fs.writeFileSync(out, await getBuf(it.src.large2x || it.src.large)); used.add(it.id);
          log(`stock photo "${q}" -> pexels ${it.id}`);
          return { kind: 'photo', src: out, mode: req.mode || 'bg', credit: `Pexels / ${it.photographer || ''}` };
        }
      } catch (e) { log('stock item error ' + e.message); }
    }
  }
  throw new Error('no clean stock media for ' + req.query);
}

async function web(req, dir, id, log, browser) {
  for (const url of req.urls || []) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' });
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || resp.status() >= 400) throw new Error('status ' + (resp && resp.status()));
      await page.waitForTimeout(3500);
      // privacy + rules: blur every picture/video on the page, drop popups and sticky overlays
      await page.addStyleTag({ content: 'img,picture,video,svg image,iframe,canvas,[style*="background-image"]{filter:blur(28px) grayscale(1)!important} *{animation:none!important;transition:none!important}' });
      await page.evaluate(() => { for (const e of document.querySelectorAll('body *')) { const s = getComputedStyle(e); if ((s.position === 'fixed' || s.position === 'sticky') && e.getBoundingClientRect().height < innerHeight * 0.95) e.remove(); }
        document.querySelectorAll('[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[class*=newsletter i],[class*=modal i]').forEach(e => e.remove()); document.body.style.overflow = 'auto'; });
      const box = req.find ? await page.evaluate(txt => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) { const i = n.textContent.toLowerCase().indexOf(txt.toLowerCase()); if (i >= 0 && n.parentElement && n.parentElement.offsetParent !== null) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + txt.length); const b = r.getBoundingClientRect(); if (b.width > 0) return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; } } return null; }, req.find) : null;
      if (req.find && !box) throw new Error('text not found: ' + req.find);
      const clipY = Math.max(0, Math.round((box ? box.y : 0) - 420)); const H = 1800;
      const out = path.join(dir, `${id}.png`);
      await page.screenshot({ path: out, fullPage: true, clip: { x: 0, y: clipY, width: 1440, height: H } }).catch(async () => { await page.screenshot({ path: out, fullPage: true }); });
      await page.close();
      log(`web shot ${url} ok`);
      return { kind: 'shot', src: out, url, host: new URL(url).hostname.replace(/^www\./, ''), w: 1440, h: H, box: box ? { x: box.x, y: box.y - clipY, w: box.w, h: box.h } : null, find: req.find, mode: 'full' };
    } catch (e) { log(`web shot ${url} failed: ${e.message}`); await page.close().catch(() => {}); }
  }
  if (req.fallback) return req.fallback;
  throw new Error('web shot failed');
}

async function resolveAssets(spec, outDir, log) {
  const dir = path.join(outDir, 'assets'); fs.mkdirSync(dir, { recursive: true });
  const cacheFile = path.join(dir, 'cache.json'); const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const used = new Set(); let browser = null; const credits = new Set();
  for (let i = 0; i < spec.beats.length; i++) {
    const b = spec.beats[i]; if (!b.media) continue; const key = JSON.stringify(b.media);
    if (cache[key]) { b.media = cache[key]; continue; }
    try {
      let res;
      if (b.media.kind === 'stock') res = await stock(b.media, dir, 'b' + i, log, used);
      else if (b.media.kind === 'web') { if (!browser) browser = await require('playwright').chromium.launch({ args: ['--no-sandbox'] }); res = await web(b.media, dir, 'b' + i, log, browser); }
      else res = b.media;
      cache[key] = res; b.media = res; if (res.credit) credits.add(res.credit);
    } catch (e) { log(`beat ${i + 1} media skipped: ${e.message}`); b.media = b.media.fallback || null; }
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  if (browser) await browser.close();
  fs.writeFileSync(path.join(outDir, 'credits.txt'), ['Stock media: Pixabay (pixabay.com)', ...credits].join('\n'));
  return spec;
}
module.exports = { resolveAssets };
