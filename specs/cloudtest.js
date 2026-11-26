// node /specs/cloudtest.js /out/<dir> -> Cloud TTS samples (Sadachbia) + index.html
const fs = require('fs'), path = require('path'); const { tts } = require('/app/lib');
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const AR = 'في هذه اللحظة، هناك من يسأل ChatGPT: أين أُنفق مالي؟ والجواب يأتي في ثوانٍ. لا روابط. لا إعلانات. ثلاثة أسماء فقط. فهل اسمك بينها؟';
const EN = 'Right now, someone near you is asking ChatGPT where to spend their money. And it answers in seconds. No links. No ads. Just three names. Is yours one of them?';
const ST_AR = 'Read in Modern Standard Arabic (fusha) with clear classical pronunciation, as a high-energy YouTube narrator: fast, punchy, exciting, short pauses only.';
const ST_EN = 'Read as a high-energy YouTube narrator: fast, punchy, exciting, short pauses only.';
(async () => { const rows = [];
  for (const [n, t, l, st] of [['ar', AR, 'ar-SA', ST_AR], ['en', EN, 'en-US', ST_EN]]) {
    try { await tts({ text: t, voice: 'Sadachbia', lang: l, out: path.join(out, n + '.mp3'), provider: 'gemini', style: st }); rows.push(`<p><b>${n}</b><br><audio controls src="${n}.mp3"></audio></p>`); console.log('OK', n); }
    catch (e) { rows.push(`<p>${n}: ${e.message.replace(/</g, '')}</p>`); console.log('ERR', n, e.message); } }
  fs.writeFileSync(path.join(out, 'index.html'), `<meta charset=utf-8><meta name=viewport content="width=device-width"><body style="background:#111;color:#fff;font-family:sans-serif;padding:16px"><h3>Cloud TTS — Sadachbia</h3>${rows.join('')}`);
  console.log('CLOUDTEST_DONE');
})();
