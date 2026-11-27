// CLI: node run.js <spec.json> <outDir>  — renders and writes status.txt + log.txt into outDir
const fs = require('fs');
const path = require('path');
const { render } = require('./render');
const [specFile, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const logf = path.join(outDir, 'log.txt');
const log = m => { const line = `[${new Date().toISOString()}] ${m}\n`; fs.appendFileSync(logf, line); process.stdout.write(line); };
fs.writeFileSync(path.join(outDir, 'status.txt'), 'rendering\n');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
// use Cloud Run only when Google already has THIS engine version (else export here as usual)
const rd = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
const cloudReady = () => process.env.CLOUD !== 'off' && require('./cloud').haveKey() && rd('/specs/.engine_rev') && rd('/specs/.engine_rev') === rd('/specs/.cloud_ready');
const cacheRoot = process.env.CACHE_ROOT || (fs.existsSync('/out') ? '/out' : path.dirname(outDir));
const assetsDir = process.env.ASSETS_DIR || path.join(cacheRoot, 'assets-' + (spec.assetsKey || spec.id.replace(/^v1-(edge-ai|ai-world)-/, 'shared-')));
require('./assets').resolveAssets(spec, assetsDir, log)
  .then(() => { const cloud = require('./cloud'); return render(spec, outDir, { log, sfxDir: '/app/sfx', remote: cloudReady() ? cloud.remoteRender : null }); })
  .then(out => { fs.rmSync(path.join(outDir, 'work'), { recursive: true, force: true }); fs.writeFileSync(path.join(outDir, 'status.txt'), 'done ' + path.basename(out) + '\n'); })
  .catch(e => { log('ERROR ' + e.message); fs.writeFileSync(path.join(outDir, 'status.txt'), 'error\n'); process.exit(1); });
