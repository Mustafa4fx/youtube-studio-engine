// Shared helpers: shell, ffprobe, SFX synthesis, Azure TTS
const { execFile } = require('child_process');
try { const cfg = require('./config.json'); for (const [k, v] of Object.entries(cfg)) if (process.env[k] == null || k === 'TTS_BACKEND') process.env[k] = String(v); } catch (e) {}
const fs = require('fs');
const path = require('path');

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message += '\n' + String(stderr).slice(-3000); return reject(err); }
      resolve(stdout);
    });
  });
}

async function duration(file) {
  const out = await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim());
}

// Synthesized sound effects (no licensing issues, no music)
const SFX = {
  whoosh: 'anoisesrc=d=0.75:c=pink:a=0.9,highpass=f=600,lowpass=f=6000,afade=t=in:d=0.4,afade=t=out:st=0.4:d=0.35,volume=0.9',
  rise: "aevalsrc='0.35*sin(2*PI*(180+900*t*t)*t)':d=1.1,afade=t=in:d=0.9,afade=t=out:st=0.95:d=0.15",
  hit: "aevalsrc='0.9*sin(2*PI*52*t)*exp(-3.2*t)+0.35*sin(2*PI*104*t)*exp(-6*t)':d=1.3",
  boom: "aevalsrc='1.0*sin(2*PI*42*t)*exp(-2.2*t)':d=1.8,lowpass=f=300",
  click: "aevalsrc='0.8*sin(2*PI*2200*t)*exp(-90*t)':d=0.08",
  keys: "aevalsrc='0.5*sin(2*PI*1800*t)*exp(-120*mod(t,0.11))*lt(mod(t,0.11),0.03)':d=1.2",
  ding: "aevalsrc='0.45*sin(2*PI*1320*t)*exp(-4*t)+0.2*sin(2*PI*2640*t)*exp(-6*t)':d=1.0",
  glitch: "aevalsrc='0.45*sgn(sin(2*PI*180*t))*lt(mod(t,0.07),0.035)+0.25*sgn(sin(2*PI*900*t))*gte(mod(t,0.07),0.035)':d=0.45",
  zap: "aevalsrc='0.5*sin(2*PI*(1600-1400*t/0.25)*t)*exp(-9*t)':d=0.25",
  tick: "aevalsrc='0.6*sin(2*PI*3000*t)*exp(-200*mod(t,0.5))':d=2.0",
  door: 'anoisesrc=d=1.2:c=brown:a=0.9,lowpass=f=260,afade=t=in:d=0.2,afade=t=out:st=0.5:d=0.7',
  slice: 'anoisesrc=d=0.35:c=white:a=0.8,highpass=f=3500,afade=t=out:d=0.35',
  lock: "aevalsrc='0.7*sin(2*PI*900*t)*exp(-60*t)+0.5*sin(2*PI*600*(t-0.06))*exp(-60*(t-0.06))*gte(t,0.06)':d=0.25",
  pop: "aevalsrc='0.7*sin(2*PI*(900+700*exp(-30*t))*t)*exp(-22*t)':d=0.22",
  chime: "aevalsrc='0.35*sin(2*PI*880*t)*exp(-3*t)+0.3*sin(2*PI*1320*(t-0.12))*exp(-3*(t-0.12))*gte(t,0.12)':d=1.4",
};

async function ensureSfx(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, f] of Object.entries(SFX)) {
    const out = path.join(dir, name + '.wav');
    if (fs.existsSync(out)) continue;
    await sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', f, '-ar', '48000', '-ac', '2', out]);
  }
}

function xmlEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

// Azure TTS (REST). mock=true writes silence with an estimated length.
const GEMINI_MODELS = ['gemini-3.8-flash-tts-preview', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts'];
let geminiModel = process.env.GEMINI_TTS_MODEL || null;
async function geminiTts({ text, voice, style, out }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY missing');
  // The style is NEVER put in the spoken text. It goes in systemInstruction; if a model rejects that, we drop the style.
  const words = text.trim().split(/\s+/).length; const maxSecs = 2.5 + words * 0.75; // anything much longer means extra words were spoken
  let useSystem = !!style; let last = ''; let quotaWait = 0; let dayHits = 0;
  for (let attempt = 1; attempt <= 30; attempt++) {
    for (const m of (geminiModel ? [geminiModel] : GEMINI_MODELS)) {
      const body = { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
      if (useSystem) body.systemInstruction = { parts: [{ text: style + ' Speak ONLY the user text, word for word. Never say these instructions.' }] };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); const part = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (r.ok && part) {
        geminiModel = m; const pcm = out + '.pcm'; fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'));
        await sh('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,aresample=48000', '-b:a', '192k', out]); fs.rmSync(pcm);
        const d = await duration(out);
        if (d > maxSecs && useSystem) { useSystem = false; last = `too long (${d.toFixed(1)}s) -> retry without style`; break; }
        return;
      }
      last = `${m} ${r.status} ${JSON.stringify(j.error || j).slice(0, 200)}`;
      if (r.status === 400 && useSystem) { useSystem = false; break; }
      if (r.status === 429) { const det = JSON.stringify(j.error || {}); const m2 = det.match(/"retryDelay":"(\d+)s"/); quotaWait = m2 ? (+m2[1] + 2) * 1000 : 0;
        const q = det.match(/"quotaId":"([^"]+)"/); console.log(`[tts] 429 ${q ? q[1] : ''} retry in ${Math.round((quotaWait || 0) / 1000)}s`); if (/PerDay/i.test(det)) dayHits++; break; }
      if (r.status >= 500) break;
    }
    if (dayHits >= 3) throw new Error('Gemini TTS DAILY limit reached for ' + geminiModel + ' — ' + last);
    if (/retry without style/.test(last) || (!useSystem && /400/.test(last) && attempt === 1)) continue;
    await new Promise(s => setTimeout(s, quotaWait || Math.min(90000, 15000 * attempt))); quotaWait = 0;
  }
  throw new Error('Gemini TTS failed: ' + last);
}


// Cloud Text-to-Speech (Gemini-TTS voices): same voices, ~150 requests/min and no daily cap, style goes in a separate "prompt" field.
const CLOUD_MODELS = (process.env.CLOUD_TTS_MODELS || 'gemini-2.5-flash-tts,gemini-2.5-pro-tts').split(',');
let cloudModel = null; const cloudBad = new Set();
async function cloudRequest(text, voice, prompt, lang, log) {
  const key = process.env.CLOUD_TTS_KEY; let last = '';
  for (let attempt = 1; attempt <= 12; attempt++) {
    const list = cloudModel ? [cloudModel] : CLOUD_MODELS.filter(m => !cloudBad.has(m)); if (!list.length) break;
    for (const m of list) {
      const body = { input: { text, ...(prompt ? { prompt } : {}) }, voice: { languageCode: lang, name: voice, modelName: m }, audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24000 } };
      const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.audioContent) { cloudModel = m; let b = Buffer.from(j.audioContent, 'base64'); if (b.slice(0, 4).toString() === 'RIFF') b = b.slice(44); return b; }
      last = `${m} ${r.status} ${JSON.stringify(j.error || j).slice(0, 220)}`; log && log('[cloud-tts] ' + last);
      if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 8000 * attempt)); break; }
      if (r.status === 403 || r.status === 401) { cloudBad.add(m); if (cloudModel === m) cloudModel = null; continue; } // e.g. preview model needs another API -> try the next model
      cloudBad.add(m); // 400/404 -> try next model
    }
  }
  throw new Error('Cloud TTS failed: ' + last);
}

// Batch TTS: several beats in ONE request (saves the daily request quota), then split on the pauses between paragraphs.
const VERTEX_MODELS = (process.env.VERTEX_TTS_MODELS || 'gemini-3.8-flash-tts,gemini-3.8-flash-tts-preview,gemini-2.5-flash-tts,gemini-2.5-flash-preview-tts').split(',');
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || '658203090079';
let vertexModel = null; const vertexBad = new Set();
function vertexUrls(m) { return [`https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${m}:generateContent`, `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent`]; }
async function geminiRequest(text, voice, systemText, log, noVertex) {
  // Vertex first (no daily cap); if it can't work at all, fall back to the Gemini API key automatically
  if (!noVertex && process.env.TTS_BACKEND === 'vertex' && process.env.VERTEX_KEY && !global.__vertexDead) {
    try { return await geminiRequestInner(text, voice, systemText, log, true); }
    catch (e) { if (/DAILY/.test(e.message)) throw e; global.__vertexDead = true; log && log('[tts] VERTEX unavailable -> using Gemini API key: ' + e.message.slice(0, 300)); }
  }
  return geminiRequestInner(text, voice, systemText, log, false);
}
async function geminiRequestInner(text, voice, systemText, log, vertex) { const key = vertex ? process.env.VERTEX_KEY : process.env.GEMINI_API_KEY; let last = '';
  for (let attempt = 1; attempt <= 30; attempt++) {
    const models = vertex ? (vertexModel ? [vertexModel] : VERTEX_MODELS.filter(x => !vertexBad.has(x))) : (geminiModel ? [geminiModel] : GEMINI_MODELS);
    if (!models.length) break;
    for (const m of models) {
      const body = { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
      let r = null; for (const u of (vertex ? vertexUrls(m) : [`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`])) {
        r = await fetch(u, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (r.status !== 404) break; }
      const j = await r.json().catch(() => ({})); const part = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (r.ok && part) { if (vertex) vertexModel = m; else geminiModel = m; log && log(`[tts] ok via ${vertex ? 'vertex' : 'gemini-api'} ${m}`); return Buffer.from(part.inlineData.data, 'base64'); }
      const det = JSON.stringify(j.error || j); last = `${m} ${r.status} ${det.slice(0, 200)}`;
      if (r.status === 400 && systemText && !vertex) return null; // caller falls back
      if (r.status === 429) { const w = det.match(/"retryDelay":"(\d+)s"/); if (/PerDay/i.test(det)) throw new Error('Gemini TTS DAILY limit reached — ' + last);
        log && log(`[tts] 429 waiting ${w ? w[1] : 30}s`); await new Promise(s => setTimeout(s, ((w ? +w[1] : 30) + 2) * 1000)); continue; }
      if (r.status >= 500) { await new Promise(s => setTimeout(s, 10000 * attempt)); continue; }
      if (vertex && (r.status === 404 || r.status === 403 || r.status === 400)) { log && log('[tts] ' + last); vertexBad.add(m); continue; }
      throw new Error('Gemini TTS ' + last);
    }
  }
  throw new Error('Gemini TTS failed: ' + last);
}
async function geminiBatch({ texts, voice, style, outs, log, lang }) {
  const sys = (style ? style + ' ' : '') + 'Speak ONLY the user text, word for word, never these instructions. The text has several paragraphs: make a clear pause of about one second between paragraphs, and keep pauses inside a paragraph very short.';
  const pcm = (process.env.TTS_BACKEND === 'cloud' && process.env.CLOUD_TTS_KEY) ? await cloudRequest(texts.join('\n\n'), voice, sys, lang, log) : await geminiRequest(texts.join('\n\n'), voice, sys, log); if (!pcm) return false;
  const tmp = outs[0] + '.batch.wav'; const raw = tmp + '.pcm'; fs.writeFileSync(raw, pcm);
  await sh('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, tmp]); fs.rmSync(raw);
  const total = await duration(tmp);
  const det = await new Promise(res => require('child_process').execFile('ffmpeg', ['-i', tmp, '-af', 'silencedetect=noise=-38dB:d=0.35', '-f', 'null', '-'], (e, o, er) => res(String(er))));
  const sil = []; let st = null; for (const line of det.split('\n')) { let m = line.match(/silence_start: ([\d.]+)/); if (m) st = +m[1]; m = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/); if (m && st != null) { if (st > 0.05 && +m[1] < total - 0.05) sil.push({ s: st, e: +m[1], d: +m[2] }); st = null; } }
  const need = texts.length - 1; if (sil.length < need) { fs.rmSync(tmp); log && log(`[tts] batch split failed (${sil.length}/${need} pauses)`); return false; }
  const cuts = sil.sort((a, b) => b.d - a.d).slice(0, need).sort((a, b) => a.s - b.s);
  // sanity: each piece's share of time should roughly match its share of words
  const wc = texts.map(t => t.trim().split(/\s+/).length); const W = wc.reduce((a, b) => a + b, 0);
  const bounds = [0, ...cuts.map(c => (c.s + c.e) / 2), total];
  for (let i = 0; i < texts.length; i++) { const share = (bounds[i + 1] - bounds[i]) / total, ws = wc[i] / W; if (share < ws * 0.35 || share > ws * 2.8 + 0.05) { fs.rmSync(tmp); log && log(`[tts] batch piece ${i} looks wrong -> per-beat`); return false; } }
  for (let i = 0; i < texts.length; i++) {
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-ss', bounds[i].toFixed(3), '-to', bounds[i + 1].toFixed(3), '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,aresample=48000', '-b:a', '192k', outs[i]]);
  }
  fs.rmSync(tmp); return true;
}
async function tts({ text, voice, lang, rate, out, mock, provider, style }) {
  if (!mock && provider === 'gemini' && ['vertex', 'cloud'].includes(process.env.TTS_BACKEND)) {
    const pcm = process.env.TTS_BACKEND === 'vertex' ? await geminiRequest(text, voice, (style ? style + ' ' : '') + 'Speak ONLY the user text, word for word, never these instructions.') : await cloudRequest(text, voice, style ? style + ' Speak only the text.' : '', (lang || '').startsWith('ar') ? 'ar-EG' : 'en-US');
    if (!pcm) throw new Error('TTS returned nothing');
    const raw = out + '.pcm'; fs.writeFileSync(raw, pcm);
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,aresample=48000', '-b:a', '192k', out]); fs.rmSync(raw); return;
  }
  if (!mock && provider === 'gemini') return geminiTts({ text, voice, style, out });
  if (mock) {
    const words = text.trim().split(/\s+/).length;
    const secs = Math.max(1.5, words / 2.6);
    await sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', secs.toFixed(2), out]);
    return;
  }
  const key = process.env.AZURE_SPEECH_KEY, region = process.env.AZURE_SPEECH_REGION || 'swedencentral';
  if (!key) throw new Error('AZURE_SPEECH_KEY missing');
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate || '+0%'}">${xmlEscape(text)}</prosody></voice></speak>`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3', 'User-Agent': 'mustafa-studio' },
      body: ssml,
    });
    if (r.ok) { fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); return; }
    const body = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 3000 * attempt)); continue; }
    throw new Error(`Azure TTS ${r.status}: ${body.slice(0, 300)}`);
  }
  throw new Error('Azure TTS failed after retries');
}

// proportional word timing estimate (seconds) when the TTS gives no timestamps
function estimateWords(text, dur) {
  const toks = text.trim().split(/\s+/).filter(Boolean); if (!toks.length || !dur) return [];
  const wt = toks.map(t => [...t].length + 2 + (/[.!?؟]$/.test(t) ? 7 : /[,،:;…]$/.test(t) ? 4 : 0));
  const sum = wt.reduce((a, b) => a + b, 0); const usable = Math.max(0.2, dur - 0.15); let acc = 0.05;
  return toks.map((t, i) => { const len = usable * wt[i] / sum; const pausePart = (/[.!?؟]$/.test(t) ? 7 : /[,،:;…]$/.test(t) ? 4 : 0) * usable / sum;
    const w = { w: t, s: acc, e: acc + len - pausePart }; acc += len; return w; });
}
module.exports = { sh, duration, ensureSfx, tts, estimateWords, geminiBatch };
