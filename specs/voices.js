// Voice & style audition (Gemini TTS via Vertex): node /specs/voices.js <outDir>  -> mp3 samples + index.html
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const { geminiRequest } = fs.existsSync('/app/lib.js') ? require('/app/lib.js') : require('../engine/lib.js');
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'status.txt'), 'rendering\n');
const log = m => { fs.appendFileSync(path.join(out, 'log.txt'), `[${new Date().toISOString()}] ${m}\n`); console.log(m); };

const TXT = {
  en: "ChatGPT just recommended your competitor. Not you. Here's why — and the three-minute fix. Open Google, search your business name, and look at what's missing. That gap? That's exactly what's costing you customers.",
  ar: 'تشات جي بي تي رشّح منافسك… وليس أنت. والسبب بسيط، والحل يأخذ ثلاث دقائق فقط. افتح جوجل، واكتب اسم نشاطك، وانظر ما الذي ينقصك. هذه الفجوة بالضبط… هي التي تُضيّع عليك العملاء.',
};
// Vertex rejects systemInstruction for TTS (it silently falls back to "no style"), so the style goes INLINE
// as a short spoken-direction prefix, the way Google documents it for Gemini TTS.
const STYLES = {
  auto: { label: 'تلقائي — بدون أي توجيه', dir: null },
  natural: { label: 'طبيعي — حكّاء بيكلم صاحبه', dir: 'Say this naturally, like a friendly real person telling a friend a story — warm, relaxed, conversational' },
  energetic: { label: 'حماسي طبيعي — يوتيوبر متحمس بجد', dir: 'Say this like an excited, charismatic YouTuber — lively, expressive, smiling, natural and human' },
  doc: { label: 'وثائقي — واثق وفيه تشويق', dir: 'Say this like a confident documentary narrator — calm authority, smooth, with subtle suspense' },
  current: { label: 'زي الفيديو الحالي بالظبط (تلقائي + تسريع 1.12 + قص السكتات) — للمقارنة', dir: null, post: 'atempo=1.12,silenceremove=stop_periods=-1:stop_duration=0.28:stop_threshold=-42dB' },
};
// male voices only
const OTHERS = ['Charon', 'Fenrir', 'Orus', 'Puck', 'Algenib', 'Iapetus', 'Schedar', 'Enceladus'];
const plan = [];
for (const lang of ['ar', 'en']) {
  for (const st of ['auto', 'natural', 'energetic', 'doc', 'current']) plan.push({ lang, voice: 'Sadachbia', st, group: `${lang === 'ar' ? 'عربي' : 'English'} — صوت Sadachbia (الحالي) بأساليب مختلفة` });
  for (const v of OTHERS) for (const st of ['auto', 'energetic']) plan.push({ lang, voice: v, st, group: `${lang === 'ar' ? 'عربي' : 'English'} — أصوات رجالي تانية` });
}
(async () => {
  const res = [];
  for (const p of plan) {
    const name = `${p.lang}-${p.voice}-${p.st}`; const S = STYLES[p.st];
    try {
      const pcm = await geminiRequest(S.dir ? `${S.dir}: ${TXT[p.lang]}` : TXT[p.lang], p.voice, null, log);
      if (!pcm) throw new Error('empty audio');
      const raw = path.join(out, name + '.pcm'); fs.writeFileSync(raw, pcm);
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, ...(S.post ? ['-af', S.post] : []), '-b:a', '160k', path.join(out, name + '.mp3')]);
      fs.rmSync(raw); res.push({ ...p, name, ok: true }); log('ok ' + name);
    } catch (e) { res.push({ ...p, name, err: String(e.message).slice(0, 160) }); log('ERR ' + name + ' ' + e.message.slice(0, 200)); }
  }
  let html = '', g = '';
  res.forEach((r, i) => {
    if (r.group !== g) { g = r.group; html += `<h2>${g}</h2>`; }
    const tag = `#${i + 1}`;
    html += r.ok ? `<div class="r"><b><span>${tag}</span> ${r.voice} — ${STYLES[r.st].label}</b><audio controls preload="none" src="${r.name}.mp3"></audio></div>`
      : `<div class="r bad"><b><span>${tag}</span> ${r.voice} — ${STYLES[r.st].label}</b><small>مش متاح: ${r.err.replace(/</g, '')}</small></div>`;
  });
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>الأصوات</title>
<style>body{font-family:system-ui;background:#07060D;color:#fff;margin:0;padding:16px;direction:rtl}h1{color:#D4FF3A;font-size:22px}h2{color:#9cf;font-size:17px;margin-top:26px}
.r{background:#14121F;border-radius:14px;padding:12px;margin:10px 0;display:flex;flex-direction:column;gap:8px}.r b{font-size:15px}.r b span{background:#D4FF3A;color:#000;border-radius:8px;padding:1px 8px;margin-left:6px}
audio{width:100%}.bad{opacity:.5}small{color:#aaa}p{color:#bbb}</style>
<h1>🎙️ اختار الصوت والأسلوب</h1><p>نفس الجملة بكل الأصوات. اسمع وقولّي رقم اللي عجبك (مثلاً: عربي #3 وإنجليزي #14).</p>${html}`);
  fs.writeFileSync(path.join(out, 'status.txt'), 'done index.html\n');
})().catch(e => { log('ERROR ' + e.message); fs.writeFileSync(path.join(out, 'status.txt'), 'error\n'); process.exit(1); });
