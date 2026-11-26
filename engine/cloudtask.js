// Runs INSIDE one Cloud Run task: download this task's bundle, export its scenes, upload the segments.
const fs = require('fs');
const path = require('path');
const { sh } = require('./lib');
const cloud = require('./cloud');
const { render } = require('./render');

const RUN = process.env.RUN_ID; const T = +(process.env.CLOUD_RUN_TASK_INDEX || 0);
const log = m => console.log(`[t${T}] ${m}`);
(async () => {
  if (!RUN) throw new Error('RUN_ID missing');
  fs.mkdirSync('/tmp/plan', { recursive: true });
  await cloud.get(`runs/${RUN}/plan.json`, '/tmp/plan/plan.json');
  const plan = JSON.parse(fs.readFileSync('/tmp/plan/plan.json', 'utf8'));
  const mine = plan.groups[T] || []; if (!mine.length) return log('nothing to do');
  await cloud.get(`runs/${RUN}/in/t${T}.tgz`, '/tmp/plan/in.tgz');
  await sh('tar', ['-xzf', '/tmp/plan/in.tgz', '-C', '/']); fs.rmSync('/tmp/plan/in.tgz');
  const spec = JSON.parse(fs.readFileSync(plan.specFile, 'utf8'));
  log(`scenes ${mine.join(',')}`);
  const segs = await render(spec, plan.outDir, { only: mine, noVoice: true, segmentsOnly: true, sfxDir: '/app/sfx', log });
  for (const i of mine) { if (!segs[i]) continue; await cloud.put(`runs/${RUN}/out/${path.basename(segs[i])}`, segs[i]); }
  log('uploaded');
})().catch(e => { console.error(`[t${T}] ERROR ${e.message}`); process.exit(1); });
