// Publish package: node /specs/publish.js <outDir> <package.json>
// -> 3 thumbnails per language (1280x720 PNG, rendered with the real fonts) + index.html with copy buttons
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const out = process.argv[2]; const pkgFile = process.argv[3] || '/specs/publish-v2.json';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'status.txt'), 'rendering\n');
const log = m => { fs.appendFileSync(path.join(out, 'log.txt'), `[${new Date().toISOString()}] ${m}\n`); console.log(m); };
const P = JSON.parse(fs.readFileSync(pkgFile.startsWith('/') ? pkgFile : path.join(__dirname, pkgFile), 'utf8'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mark = s => esc(s).replace(/\*([^*]+)\*/g, '<b class="y">$1</b>').replace(/~([^~]+)~/g, '<b class="r">$1</b>').replace(/&lt;br&gt;/g, '<br>');

// ---------- thumbnail designs (objects/UI only: no people, no logos) ----------
function thumbHTML(t, L) {
  const rtl = L.dir === 'rtl'; const F = L.font;
  const base = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700;900&family=Inter:wght@600;800;900&family=Alexandria:wght@600;800;900&display=block">
<style>*{box-sizing:border-box;margin:0}body{width:1280px;height:720px;overflow:hidden;font-family:${F};direction:ltr;background:#07060D;color:#fff;position:relative}
.y{color:#0B0A12;background:#D4FF3A;padding:0 .14em;border-radius:.12em}.r{color:#fff;background:#FF2E4D;padding:0 .14em;border-radius:.12em}
.glow{position:absolute;border-radius:50%;filter:blur(90px);opacity:.75}
.chat{direction:${L.dir};position:absolute;background:#14121F;border:3px solid #2b2840;border-radius:28px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.q{background:#6E2EFF;color:#fff;font-weight:800;font-size:30px;border-radius:18px;padding:12px 20px;display:inline-block;margin-bottom:18px}
.row{display:flex;align-items:center;gap:14px;background:#1f1c2e;border-radius:14px;padding:14px 18px;margin:10px 0;font-size:28px;font-weight:800}
.n{width:40px;height:40px;border-radius:50%;background:#D4FF3A;color:#000;display:flex;align-items:center;justify-content:center;font-size:24px;flex:none}
.blur{filter:blur(7px);opacity:.9}
.miss{border:4px solid #FF2E4D;box-shadow:0 0 40px rgba(255,46,77,.7);background:#2a1220}
.big{direction:${L.dir};position:absolute;font-weight:900;line-height:1.02;text-shadow:0 10px 40px rgba(0,0,0,.8)}
.x{position:absolute;font-size:170px;filter:drop-shadow(0 10px 30px rgba(0,0,0,.6))}
.bug{position:absolute;top:26px;${rtl ? 'left' : 'right'}:30px;background:#D4FF3A;color:#000;font-weight:900;font-size:24px;padding:6px 14px;border-radius:10px;font-family:'Unbounded',${F}}
</style>`;
  const names = L.names.map((n, i) => `<div class="row"><span class="n">${i + 1}</span><span class="blur">${esc(n)}</span></div>`).join('');
  const side = rtl ? 'right' : 'left', other = rtl ? 'left' : 'right';
  if (t.design === 'list') return base + `<div class="glow" style="width:620px;height:620px;background:#6E2EFF;top:-120px;${other}:-100px"></div><div class="glow" style="width:420px;height:420px;background:#FF2E4D;bottom:-160px;${side}:260px;opacity:.5"></div>
<div class="chat" style="left:${rtl ? 640 : 40}px;top:90px;width:600px;transform:rotate(${rtl ? 2 : -2}deg)"><div class="q">${esc(L.q)}</div>${names}<div class="row miss"><span class="n" style="background:#FF2E4D;color:#fff">4</span>${esc(L.you)} ❌</div></div>
<div class="big" style="left:${rtl ? 30 : 670}px;top:140px;width:580px;font-size:${t.size || 92}px;text-align:center">${mark(t.text)}</div><div class="bug">${esc(L.bug)}</div>`;
  if (t.design === 'versus') return base + `<div class="glow" style="width:560px;height:560px;background:#D4FF3A;top:-180px;${side}:-120px;opacity:.35"></div><div class="glow" style="width:560px;height:560px;background:#FF2E4D;bottom:-200px;${other}:-120px;opacity:.55"></div>
<div class="chat" style="${side}:60px;top:210px;width:520px;text-align:center;font-size:52px;font-weight:900;padding:44px;border-color:#D4FF3A;border-width:5px">${esc(L.them)}<div style="font-size:170px;margin-top:10px">✅</div></div>
<div class="chat" style="${other}:60px;top:210px;width:520px;text-align:center;font-size:52px;font-weight:900;padding:44px;border-color:#FF2E4D;border-width:5px">${esc(L.you)}<div style="font-size:170px;margin-top:10px">❌</div></div>
<div class="big" style="left:0;right:0;top:40px;text-align:center;font-size:${t.size || 96}px">${mark(t.text)}</div><div class="bug" style="top:auto;bottom:26px">${esc(L.bug)}</div>`;
  // 'empty': one huge empty slot
  return base + `<div class="glow" style="width:700px;height:700px;background:#6E2EFF;top:-200px;left:290px;opacity:.6"></div>
<div class="big" style="left:0;right:0;top:56px;text-align:center;font-size:${t.size || 104}px">${mark(t.text)}</div>
<div class="chat" style="left:190px;right:190px;top:330px;padding:30px"><div class="row miss" style="font-size:54px;padding:28px 30px;justify-content:center">${esc(L.you)}&nbsp;<span style="color:#FF2E4D">?</span></div></div>
<div class="x" style="${other}:70px;top:300px">❌</div><div class="x" style="${side}:70px;top:330px;font-size:130px">🔍</div><div class="bug" style="top:auto;bottom:26px">${esc(L.bug)}</div>`;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const L of P.langs) for (let i = 0; i < L.thumbs.length; i++) {
    const f = `thumb-${L.code}-${i + 1}.png`;
    await page.setContent(thumbHTML(L.thumbs[i], L), { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => 1));
    await page.screenshot({ path: path.join(out, f) }); log('thumb ' + f);
  }
  await browser.close();
  const copy = (label, text, big) => `<div class="f"><div class="h"><b>${label}</b><button onclick="cp(this)">نسخ</button></div><${big ? 'pre' : 'div'} class="t">${esc(text)}</${big ? 'pre' : 'div'}></div>`;
  const sections = P.langs.map(L => `<section dir="${L.dir}"><h2>${esc(L.label)}</h2>
${L.video ? `<a class="vid" href="${L.video}" download>⬇️ تنزيل الفيديو</a>` : ''}
<h3>🏷️ العناوين — اختار واحد</h3>${L.titles.map((t, i) => copy('عنوان ' + (i + 1) + ` <small>(${[...t].length} حرف)</small>`, t)).join('')}
<h3>🖼️ الصور المصغرة — اضغط لتنزيل</h3><div class="th">${L.thumbs.map((t, i) => `<a href="thumb-${L.code}-${i + 1}.png" download><img src="thumb-${L.code}-${i + 1}.png"><span>${i + 1}</span></a>`).join('')}</div>
<h3>📝 الوصف</h3>${copy('الوصف كامل', L.description, true)}
<h3>#️⃣ الهاشتاجات والكلمات المفتاحية</h3>${copy('Tags (خانة الكلمات المفتاحية)', L.tags.join(', '))}${copy('هاشتاجات', L.hashtags.join(' '))}
<h3>⚙️ الإعدادات</h3><ul>${(P.settings || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></section>`).join('');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(P.title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#07060D;color:#fff;margin:0;padding:16px;direction:rtl}h1{color:#D4FF3A;font-size:22px}h2{color:#9cf;border-bottom:1px solid #333;padding-bottom:8px;margin-top:30px}h3{font-size:16px;margin:22px 0 6px;color:#ddd}
.f{background:#14121F;border-radius:14px;padding:12px;margin:8px 0}.h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}.h small{color:#999;font-weight:400}
button{background:#D4FF3A;color:#000;border:0;border-radius:10px;padding:8px 16px;font-weight:800;font-size:15px}button.ok{background:#3c3}
.t{font-size:16px;line-height:1.5;user-select:all}pre.t{white-space:pre-wrap;font-family:inherit;margin:0;max-height:260px;overflow:auto}
.th{display:grid;grid-template-columns:1fr;gap:10px}.th a{position:relative;display:block}.th img{width:100%;border-radius:12px;display:block}.th span{position:absolute;top:8px;right:8px;background:#D4FF3A;color:#000;font-weight:900;border-radius:8px;padding:2px 10px}
.vid{display:block;background:#6E2EFF;color:#fff;text-align:center;padding:12px;border-radius:12px;font-weight:800;text-decoration:none}ul{color:#ccc;line-height:1.7}section[dir=ltr] .t{direction:ltr;text-align:left}</style>
<h1>🚀 ${esc(P.title)}</h1><p style="color:#bbb">لكل قناة: نزّل الفيديو ← ارفعه من YouTube Studio ← الصق العنوان والوصف والتاجز ← نزّل الصورة المصغرة وارفعها ← انشر.</p>${sections}
<script>function cp(b){const t=b.parentElement.nextElementSibling.innerText;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(()=>{const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove()});b.textContent='✓ اتنسخ';b.className='ok';setTimeout(()=>{b.textContent='نسخ';b.className=''},1500)}</script>`);
  fs.writeFileSync(path.join(out, 'status.txt'), 'done index.html\n');
  log('PUBLISH_DONE');
})().catch(e => { log('ERROR ' + e.message); fs.writeFileSync(path.join(out, 'status.txt'), 'error\n'); process.exit(1); });
