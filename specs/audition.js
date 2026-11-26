// Voice audition: node audition.js <outDir>  -> mp3 samples + index.html
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const AR = 'في هذه اللحظة، هناك من يسأل تشات جي بي تي: أين أُنفق مالي؟ والجواب يأتي في ثوانٍ. لا روابط. لا إعلانات. ثلاثة أسماء فقط. فهل اسمك بينها؟';
const EN = 'Right now, someone near you is asking ChatGPT where to spend their money. And it answers in seconds. No links. No ads. Just three names. Is yours one of them?';
const STYLE_AR = 'Read the following Modern Standard Arabic (fusha) text as a high-energy YouTube narrator: fast pace, punchy, exciting and confident, short pauses only, clear classical pronunciation:\n';
const STYLE_EN = 'Read this as a high-energy YouTube narrator: fast pace, punchy, exciting and confident, short pauses only:\n';
const results = [];
const AZ = process.env.AZURE_SPEECH_KEY, REG = process.env.AZURE_SPEECH_REGION || 'swedencentral', GK = process.env.GEMINI_API_KEY;
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
async function azure(name, voice, lang, text, rate) {
  const inner = voice.includes(':') || voice.includes('Multilingual') ? `<lang xml:lang="${lang}">${xml(text)}</lang>` : xml(text);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate}">${inner}</prosody></voice></speak>`;
  const r = await fetch(`https://${REG}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZ, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3', 'User-Agent': 'mustafa-studio' }, body: ssml });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  fs.writeFileSync(path.join(out, name + '.mp3'), Buffer.from(await r.arrayBuffer()));
}
const MODELS = ['gemini-3.8-flash-tts-preview', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts'];
let goodModel = null;
async function gemini(name, voice, text) {
  const tryModels = goodModel ? [goodModel] : MODELS; let last = '';
  for (const m of tryModels) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': GK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }) });
    const j = await r.json().catch(() => ({}));
    const part = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (r.ok && part) { goodModel = m; const pcm = path.join(out, name + '.pcm'); fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-b:a', '160k', path.join(out, name + '.mp3')]); fs.rmSync(pcm); return m; }
    last = `${m}: ${r.status} ${JSON.stringify(j.error || j).slice(0, 140)}`;
    if (r.status === 429) { await new Promise(s => setTimeout(s, 20000)); }
  }
  throw new Error(last);
}
const jobs = [];
if (GK) for (const v of ['Fenrir', 'Puck', 'Orus', 'Charon', 'Sadachbia', 'Algenib']) {
  jobs.push(['Gemini ' + v + ' — عربي', 'g-' + v + '-ar', () => gemini('g-' + v + '-ar', v, STYLE_AR + AR)]);
  jobs.push(['Gemini ' + v + ' — English', 'g-' + v + '-en', () => gemini('g-' + v + '-en', v, STYLE_EN + EN)]);
}
if (AZ) {
  for (const v of ['en-US-Andrew:DragonHDLatestNeural', 'en-US-Brian:DragonHDLatestNeural', 'en-US-Davis:DragonHDLatestNeural', 'en-US-AndrewMultilingualNeural']) {
    const s = v.split(':')[0].replace('en-US-', '');
    jobs.push(['Azure HD ' + v + ' — عربي', 'a-' + s + (v.includes(':') ? 'HD' : 'ML') + '-ar', () => azure('a-' + s + (v.includes(':') ? 'HD' : 'ML') + '-ar', v, 'ar-SA', AR, '+10%')]);
    jobs.push(['Azure HD ' + v + ' — English', 'a-' + s + (v.includes(':') ? 'HD' : 'ML') + '-en', () => azure('a-' + s + (v.includes(':') ? 'HD' : 'ML') + '-en', v, 'en-US', EN, '+12%')]);
  }
  jobs.push(['Azure ar-SA-Hamed (الحالي)', 'a-hamed-ar', () => azure('a-hamed-ar', 'ar-SA-HamedNeural', 'ar-SA', AR, '+14%')]);
  jobs.push(['Azure ar-EG-Shakir', 'a-shakir-ar', () => azure('a-shakir-ar', 'ar-EG-ShakirNeural', 'ar-EG', AR, '+14%')]);
}
(async () => {
  for (const [label, file, fn] of jobs) {
    try { const m = await fn(); results.push({ label: label + (typeof m === 'string' ? ` (${m})` : ''), file }); console.log('OK ', label); }
    catch (e) { results.push({ label, err: e.message }); console.log('ERR', label, e.message); }
  }
  const rows = results.map(r => r.err ? `<div class="r bad"><b>${r.label}</b><small>غير متاح: ${r.err.replace(/</g, '')}</small></div>`
    : `<div class="r"><b>${r.label}</b><audio controls preload="none" src="${r.file}.mp3"></audio></div>`).join('\n');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voices</title>
<style>body{font-family:system-ui;background:#07060D;color:#fff;margin:0;padding:16px}h1{color:#D4FF3A;font-size:22px}.r{background:#14121F;border-radius:14px;padding:12px;margin:10px 0;display:flex;flex-direction:column;gap:8px}.r b{font-size:15px}audio{width:100%}.bad{opacity:.5}small{color:#aaa}</style>
<h1>اختيار الصوت — اسمع واختار</h1>${rows}`);
  console.log('AUDITION_DONE');
})();
