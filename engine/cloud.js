// Google Cloud Run rendering: the server prepares voice + assets, then every scene is exported on its own
// Cloud Run task (many machines at the same time). Results come back as segment files the server joins.
// Credentials: service-account key at /specs/.gcp-sa.json on the server (never in git); inside Cloud Run the
// metadata server gives the token.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sh, duration } = require('./lib');

const KEYF = process.env.GCP_SA || '/specs/.gcp-sa.json';
const NUM = '658203090079';
const REGION = process.env.GCP_REGION || 'us-central1';
const BUCKET = process.env.BUCKET || `studio-${NUM}`;
const JOB = 'studio-render';
const MAX_TASKS = +(process.env.CLOUD_TASKS || 24);

let tok = null, projectId = null;
const haveKey = () => fs.existsSync(KEYF);
async function token() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.t;
  if (haveKey()) {
    const k = JSON.parse(fs.readFileSync(KEYF, 'utf8')); projectId = k.project_id;
    const now = Math.floor(Date.now() / 1000); const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), k.private_key).toString('base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(60000), body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + sig });
    const j = await r.json(); if (!j.access_token) throw new Error('gcp auth ' + JSON.stringify(j).slice(0, 200));
    tok = { t: j.access_token, exp: Date.now() + 3500e3 }; return tok.t;
  }
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  const j = await r.json(); tok = { t: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 }; return tok.t;
}
async function api(url, opt = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000), ...opt, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
  if (!r.ok) { const e = new Error(`${r.status} ${url.split('?')[0]} ${txt.slice(0, 300)}`); e.status = r.status; throw e; }
  return j;
}
const enc = encodeURIComponent;
async function put(name, file) {
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${enc(name)}`, { method: 'POST', signal: AbortSignal.timeout(900000), headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
  if (!r.ok) throw new Error('gcs upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
async function putJson(name, obj) { const f = path.join(require('os').tmpdir(), 'up-' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(f, JSON.stringify(obj)); await put(name, f); fs.rmSync(f); }
async function get(name, file) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${enc(name)}?alt=media`, { signal: AbortSignal.timeout(900000), headers: { Authorization: 'Bearer ' + await token() } });
  if (!r.ok) throw new Error('gcs download ' + r.status + ' ' + name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
async function list(prefix) { const j = await api(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?prefix=${enc(prefix)}`); return (j.items || []).map(x => x.name); }
async function rm(name) { try { await api(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${enc(name)}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; } }

const jobUrl = () => `https://run.googleapis.com/v2/projects/${projectId || NUM}/locations/${REGION}/jobs`;

// create / update the Cloud Run job with a new engine image (called by the server after each engine build)
async function deploy(image) {
  await token(); const k = JSON.parse(fs.readFileSync(KEYF, 'utf8'));
  const body = { template: { taskCount: 1, template: { maxRetries: 1, timeout: '1800s', serviceAccount: k.client_email,
    containers: [{ image, command: ['node', 'cloudtask.js'], resources: { limits: { cpu: '2', memory: '4Gi' } },
      env: [{ name: 'BUCKET', value: BUCKET }, { name: 'RENDER_WORKERS', value: '1' }] }] } } };
  let op;
  try { await api(`${jobUrl()}/${JOB}`); op = await api(`${jobUrl()}/${JOB}`, { method: 'PATCH', body: JSON.stringify(body) }); }
  catch (e) { if (e.status !== 404) throw e; op = await api(`${jobUrl()}?jobId=${JOB}`, { method: 'POST', body: JSON.stringify(body) }); }
  for (let t = 0; t < 60 && op && !op.done; t++) { await new Promise(r => setTimeout(r, 5000)); op = await api(`https://run.googleapis.com/v2/${op.name}`); }
  if (op && op.error) throw new Error('deploy ' + JSON.stringify(op.error).slice(0, 300));
  return 'job ready: ' + image;
}

// server side: render all scenes of a prepared spec on Cloud Run; returns { beatIndex: localSegmentFile }
async function remoteRender({ spec, work, log, FPS }) {
  if (!haveKey()) throw new Error('no cloud key yet');
  if (process.env.CLOUD === 'off') throw new Error('cloud disabled');
  await api(`${jobUrl()}/${JOB}`); // job must exist (deployed by the server)
  const run = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
  // balance scenes across tasks by length (longest first)
  const lens = [];
  for (let i = 0; i < spec.beats.length; i++) { const v = path.join(work, `v${String(i).padStart(3, '0')}.mp3`); lens.push({ i, d: fs.existsSync(v) ? await duration(v) : 1.5 }); }
  const N = Math.max(1, Math.min(MAX_TASKS, spec.beats.length));
  const groups = Array.from({ length: N }, () => ({ d: 0, b: [] }));
  for (const x of lens.sort((a, b) => b.d - a.d)) { const g = groups.reduce((m, g) => g.d < m.d ? g : m); g.d += x.d + 1; g.b.push(x.i); }
  const specFile = path.join(work, 'spec.cloud.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
  // one small bundle per task: only that task's voice, word timings and pictures
  const filesOf = i => { const id = String(i).padStart(3, '0'); const fl = [];
    for (const f of [`v${id}.mp3`, `v${id}.words.json`]) if (fs.existsSync(path.join(work, f))) fl.push(path.join(work, f));
    JSON.stringify(spec.beats[i]).replace(/"(\/out\/[^"]+)"/g, (_, p) => { if (fs.existsSync(p)) fl.push(p); return _; });
    return fl; };
  log(`cloud: uploading ${N} task bundles`);
  await Promise.all(groups.map(async (g, t) => {
    const fl = [specFile, ...g.b.flatMap(filesOf)]; const tgz = path.join(work, `cloud-t${t}.tgz`);
    await sh('tar', ['-czf', tgz, '-C', '/', ...[...new Set(fl)].map(f => path.resolve(f).slice(1))]);
    await put(`runs/${run}/in/t${t}.tgz`, tgz); fs.rmSync(tgz);
  }));
  await putJson(`runs/${run}/plan.json`, { specFile, outDir: path.dirname(work), groups: groups.map(g => g.b) });
  log(`cloud: starting ${N} machines (run ${run})`);
  let op = await api(`${jobUrl()}/${JOB}:run`, { method: 'POST', body: JSON.stringify({ overrides: { taskCount: N, containerOverrides: [{ env: [{ name: 'RUN_ID', value: run }] }] } }) });
  const t0 = Date.now(); let lastMsg = '';
  while (!op.done) {
    if (Date.now() - t0 > 45 * 60e3) throw new Error('cloud timeout');
    await new Promise(r => setTimeout(r, 8000));
    op = await api(`https://run.googleapis.com/v2/${op.name}`);
    const m = op.metadata || {}; const msg = `cloud: ${m.succeededCount || 0}/${N} done, ${m.runningCount || 0} running${m.failedCount ? ', ' + m.failedCount + ' failed' : ''}`;
    if (msg !== lastMsg) { log(msg); lastMsg = msg; }
  }
  const got = {};
  for (const name of await list(`runs/${run}/out/`)) {
    const m = name.match(/s(\d{3})\.mp4$/); if (!m) continue;
    const f = path.join(work, `s${m[1]}.mp4`); await get(name, f); got[+m[1]] = f;
  }
  if (!Object.keys(got).length) throw new Error('cloud returned nothing' + (op.error ? ' ' + JSON.stringify(op.error).slice(0, 200) : ''));
  log(`cloud: finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  return got;
}

module.exports = { token, put, get, list, rm, deploy, remoteRender, haveKey, BUCKET };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  (async () => {
    if (cmd === 'deploy') console.log(await deploy(arg));
    else if (cmd === 'rm') { await rm(arg); console.log('removed ' + arg); }
    else if (cmd === 'check') { await token(); console.log('ok project=' + projectId + ' bucket=' + BUCKET + ' objects=' + (await list('')).length); }
    else console.log('usage: node cloud.js deploy <image> | rm <object> | check');
  })().catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
}
