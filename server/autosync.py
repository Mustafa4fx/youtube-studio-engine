#!/usr/bin/env python3
"""Runs every few minutes on the server (cron).
1) Pulls this repo; if it changed, deploys engine/ + specs/ and rebuilds the engine container.
2) Renders every job in jobs/*.json that is not done yet (one at a time).
3) Writes a status page: https://panel.helpanegyptian.com/videos/
No secrets live in this repo: keys stay in /opt/automation/.env on the server.
"""
import fcntl, html, json, os, shutil, subprocess, sys, time, datetime

A = '/opt/automation'; R = A + '/repo'; STATE = A + '/state'; SITE = A + '/site/videos'
LOG = '/root/autosync.log'
os.makedirs(STATE, exist_ok=True); os.makedirs(SITE, exist_ok=True)


def log(m):
    with open(LOG, 'a') as f:
        f.write(f'[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {m}\n')


def sh(cmd, cwd=None, out=None):
    return subprocess.run(cmd, cwd=cwd, shell=True, stdout=out or subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


lock = open('/root/autosync.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(0)  # previous run still busy (rendering)

if not os.path.exists(SITE + '/index.html'):
    open(SITE + '/index.html', 'w').write('<meta charset="utf-8"><meta http-equiv="refresh" content="30"><body style="background:#07060D;color:#fff;font-family:sans-serif;direction:rtl;padding:20px"><h2 style="color:#D4FF3A">🎬 الفيديوهات</h2><p>المحرك بيتجهّز… الصفحة هتتحدّث لوحدها.</p>')

# ---------- 1) update + deploy ----------
sh('git fetch -q origin main', cwd=R)
new = sh('git rev-parse origin/main', cwd=R).stdout.strip()
deployed = open(A + '/.engine_rev').read().strip() if os.path.exists(A + '/.engine_rev') else ''
DEPLOY_ERR = ''
if new and new != deployed:
    try:
        sh('git reset -q --hard origin/main', cwd=R)
        os.makedirs(A + '/engine/specs', exist_ok=True)
        def put(src, dst):  # files AND folders (e.g. engine/sfx)
            if os.path.isdir(src): shutil.copytree(src, dst, dirs_exist_ok=True)
            else: shutil.copy(src, dst)
        for f in os.listdir(R + '/engine'):
            put(os.path.join(R, 'engine', f), os.path.join(A, 'engine', f))
        for f in os.listdir(R + '/specs'):
            put(os.path.join(R, 'specs', f), os.path.join(A, 'engine', 'specs', f))
        if os.path.exists(R + '/server/fonts.html'):
            shutil.copy(R + '/server/fonts.html', SITE + '/fonts.html')
        b = sh('timeout 2400 docker compose build -q engine && docker compose up -d engine', cwd=A)
        if b.returncode == 0:
            open(A + '/.engine_rev', 'w').write(new)
            log(f'deployed {new[:7]}')
        else:
            DEPLOY_ERR = 'build failed: ' + b.stdout[-300:]; log('BUILD FAILED\n' + b.stdout[-2000:])
    except Exception as e:
        DEPLOY_ERR = f'deploy error: {e}'; log(DEPLOY_ERR)

# ---------- 1b) Google Cloud Run (fast parallel export) ----------
KEYF = A + '/engine/specs/.gcp-sa.json'  # mounted in the engine as /specs/.gcp-sa.json (not served on the site, not in git)
GCP_NUM = '658203090079'; REGION = 'us-central1'; BUCKET = 'studio-' + GCP_NUM
CLOUD_MSG = ''

SETUP_KEY = A + '/gcp/setup.key'

def ensure_setup_keypair():
    """RSA key pair for the one-time key handoff: the public half is published on the site, the private half never leaves the server."""
    if os.path.exists(KEYF): return
    os.makedirs(A + '/gcp', exist_ok=True); os.chmod(A + '/gcp', 0o700)
    if not os.path.exists(SETUP_KEY):
        sh(f'openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out {SETUP_KEY}'); os.chmod(SETUP_KEY, 0o600)
    sh(f'openssl pkey -in {SETUP_KEY} -pubout -out {SITE}/gcp-setup.pub.pem')

def fetch_cloud_key():
    """Pick up the service-account key the Cloud Shell setup left in the bucket (RSA-encrypted to this server), then remove the copy."""
    if os.path.exists(KEYF) or not os.path.exists(SETUP_KEY): return False
    import urllib.request, tempfile
    try: data = urllib.request.urlopen(f'https://storage.googleapis.com/{BUCKET}/setup/keys.tgz', timeout=30).read()
    except Exception: return False
    d = tempfile.mkdtemp(); os.chmod(d, 0o700); open(d + '/k.tgz', 'wb').write(data); sh('tar -xzf k.tgz', cwd=d)
    r1 = sh(f'openssl pkeyutl -decrypt -inkey {SETUP_KEY} -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in k.enc -out k', cwd=d)
    r2 = sh(f'openssl enc -d -aes-256-cbc -pbkdf2 -pass file:k -in sa.enc -out sa.json', cwd=d) if r1.returncode == 0 else r1
    ok = False
    if r2.returncode == 0:
        try:
            j = json.load(open(d + '/sa.json'))
            if j.get('type') == 'service_account':
                shutil.copy(d + '/sa.json', KEYF); os.chmod(KEYF, 0o600); ok = True
                log('cloud key installed (' + j.get('client_email', '') + ')')
        except Exception: pass
    if not ok: log('cloud key: found but could not decrypt')
    shutil.rmtree(d, ignore_errors=True)
    if ok:
        try: os.remove(SITE + '/gcp-setup.pub.pem')
        except Exception: pass
    return ok

def cloud_deploy():
    global CLOUD_MSG
    if not os.path.exists(KEYF): CLOUD_MSG = '☁️ Cloud: مستني الإعداد'; return
    rev = open(A + '/.engine_rev').read().strip() if os.path.exists(A + '/.engine_rev') else ''
    if not rev: return
    if os.path.exists(A + '/.cloud_rev') and open(A + '/.cloud_rev').read().strip() == rev:
        CLOUD_MSG = '☁️ Cloud: شغال'; return
    cid = sh('docker compose ps -q engine', cwd=A).stdout.strip()
    img = sh('docker inspect --format "{{.Image}}" ' + cid).stdout.strip()
    pid = json.load(open(KEYF))['project_id']
    uri = f'{REGION}-docker.pkg.dev/{pid}/studio/engine:{rev[:12]}'
    log('cloud: pushing engine image ' + uri)
    try:
        pg = open(SITE + '/index.html').read()
        if '☁️' not in pg: pg = pg.replace('</h1>', '</h1><p style=color:#9cf>☁️ Cloud: جاري رفع المحرك لجوجل (أول مرة بتاخد وقت)…</p>', 1)
        open(SITE + '/index.html', 'w').write(pg.replace('☁️ Cloud: مستني الإعداد', '☁️ Cloud: جاري رفع المحرك لجوجل (أول مرة بتاخد وقت)…'))
    except Exception: pass
    r = sh(f'docker login -u _json_key --password-stdin https://{REGION}-docker.pkg.dev < {KEYF} && docker tag {img} {uri} && timeout 3600 docker push -q {uri} && docker compose exec -T engine node cloud.js deploy {uri}', cwd=A)
    if r.returncode == 0:
        open(A + '/.cloud_rev', 'w').write(rev); log('cloud deployed ' + uri); CLOUD_MSG = '☁️ Cloud: شغال'
    else:
        log('CLOUD DEPLOY FAILED\n' + r.stdout[-1500:]); CLOUD_MSG = '☁️ Cloud: خطأ في التجهيز — ' + r.stdout.strip()[-160:]

try:
    ensure_setup_keypair()
    if fetch_cloud_key():
        sh('docker compose exec -T engine node cloud.js rm setup/keys.tgz', cwd=A)
    cloud_deploy()
except Exception as e:
    log(f'cloud error {e}'); CLOUD_MSG = f'☁️ Cloud: خطأ {e}'

# ---------- 2) jobs ----------
def status_of(out_dir):
    p = os.path.join(SITE, out_dir, 'status.txt')
    return open(p).read().strip() if os.path.exists(p) else ''

jobs = []
jdir = R + '/jobs'
for name in sorted(os.listdir(jdir)) if os.path.isdir(jdir) else []:
    if not name.endswith('.json'):
        continue
    try:
        job = json.load(open(os.path.join(jdir, name)))
    except Exception as e:
        log(f'bad job {name}: {e}'); continue
    job['_id'] = name[:-5]; jobs.append(job)

def write_page():
    cards = []
    for job in reversed(jobs):
        jid = job['_id']; rows = []
        for spec in job.get('specs', []):
            base = os.path.basename(spec)[:-5]; s = status_of(f'{jid}/{base}')
            d = os.path.join(SITE, jid, base); mp4 = [f for f in os.listdir(d) if f.endswith('.mp4')] if os.path.isdir(d) else []
            if s.startswith('done') and mp4:
                rows.append(f'<a class="ok" href="{jid}/{base}/{mp4[0]}">▶ {html.escape(base)}</a>')
            else:
                last = ''
                lp = os.path.join(d, 'log.txt')
                if os.path.exists(lp):
                    lines = [l for l in open(lp).read().splitlines() if l.strip()]
                    last = lines[-1][-140:] if lines else ''
                label = 'جاري التصدير' if s.startswith('rendering') else ('خطأ — هيعيد المحاولة لوحده' if s.startswith('error') else 'في الطابور')
                rows.append(f'<div class="wait">⏳ {html.escape(base)} — {label}<small>{html.escape(last)}</small></div>')
        cards.append(f'<div class="c"><b>{html.escape(job.get("title", jid))}</b>{"".join(rows)}</div>')
    page = f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
    <title>Studio</title><style>body{{margin:0;padding:14px;background:#07060D;color:#fff;font-family:system-ui,sans-serif;direction:rtl}}h1{{color:#D4FF3A;font-size:22px}}
    .c{{background:#14121F;border-radius:16px;padding:14px;margin:12px 0}}.c b{{display:block;font-size:17px;margin-bottom:8px}}
    a.ok{{display:block;background:#D4FF3A;color:#000;font-weight:800;padding:12px;border-radius:12px;margin:8px 0;text-decoration:none;direction:ltr;text-align:left}}
    .wait{{background:#221F33;padding:10px;border-radius:12px;margin:8px 0}}small{{display:block;color:#999;margin-top:4px;direction:ltr;text-align:left;font-size:11px}}</style>
    <h1>🎬 الفيديوهات</h1><p style="color:#999">الصفحة بتتحدّث لوحدها كل دقيقة · آخر تحديث {datetime.datetime.now():%H:%M} · نسخة المحرك {(open(A + "/.engine_rev").read().strip()[:7] if os.path.exists(A + "/.engine_rev") else "-")}</p>{("<p style=color:#f66>⚠ " + html.escape(DEPLOY_ERR) + "</p>") if DEPLOY_ERR else ""}{("<p style=color:#9cf>" + html.escape(CLOUD_MSG) + "</p>") if CLOUD_MSG else ""}{"".join(cards) or "<p>مفيش شغل لسه</p>"}'''
    open(SITE + '/index.html', 'w').write(page)


write_page()  # show 'queued/rendering' right away
for job in jobs:
    jid = job['_id']; st = os.path.join(STATE, jid); os.makedirs(st, exist_ok=True)
    if os.path.exists(st + '/done'):
        continue
    fa = st + '/failed_at'
    if os.path.exists(fa) and time.time() - float(open(fa).read() or 0) < job.get('retryMinutes', 60) * 60:
        continue
    ok = True
    for spec in job.get('specs', []):
        base = os.path.basename(spec)[:-5]; out = f'{jid}/{base}'
        if status_of(out).startswith('done'):
            continue
        log(f'render {jid} {base}')
        with open(st + '/log.txt', 'a') as lf:
            pr = subprocess.Popen(f'docker compose exec -T engine node run.js /specs/{os.path.basename(spec)} /out/{out}', cwd=A, shell=True, stdout=lf, stderr=subprocess.STDOUT)
            t0 = time.time()
            while pr.poll() is None:  # refresh the status page every minute while rendering
                time.sleep(60)
                try: write_page()
                except Exception as e: log(f'page error {e}')
                if time.time() - t0 > 3 * 3600: pr.kill(); log('render timeout'); break
        if pr.returncode != 0 or not status_of(out).startswith('done'):
            ok = False; open(fa, 'w').write(str(time.time())); log(f'failed {jid} {base} (will retry)'); break
    if ok:
        open(st + '/done', 'w').write('1'); log(f'job done {jid}')
    break  # one job per run; cron starts the next


write_page()
