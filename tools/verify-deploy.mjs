// Read-only check of a deployed machine against this repository. Changes nothing, prints no
// secrets. Run on the Oracle backend (or a Linux collector):
//   sudo -u pitwall node /opt/pitwall/tools/verify-deploy.mjs
// On the Mac collector:  node tools/verify-deploy.mjs
// Each line: PASS, WARN (works, but look at it) or FAIL (fix before a live session).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// systemd reads /etc/pitwall/pitwall.env; read it the same way (values never printed).
try { for (const l of fs.readFileSync('/etc/pitwall/pitwall.env', 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && env[m[1]] == null) env[m[1]] = m[2]; } } catch {}
const ROLE = env.PITWALL_ROLE || (process.platform === 'darwin' ? 'collector' : 'standalone');
const DATA = path.resolve(env.PITWALL_DATA || path.join(ROOT, 'data'));
const res = [];
const say = (lvl, what, detail = '') => res.push([lvl, what, detail]);
const sh = (cmd, ...a) => { try { return execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString().trim(); } catch (e) { return null; } };
const get = async url => { try { return await (await fetch(url, { signal: AbortSignal.timeout(4000) })).json(); } catch { return null; } };
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const linux = process.platform === 'linux';

// ---- code ----
sh('git', '-C', ROOT, 'fetch', '-q', 'origin', 'main');
const head = sh('git', '-C', ROOT, 'rev-parse', 'HEAD'), remote = sh('git', '-C', ROOT, 'rev-parse', 'origin/main');
if (!head) say('FAIL', 'code', 'not a git checkout');
else if (remote && head !== remote) { const behind = sh('git', '-C', ROOT, 'rev-list', '--count', `HEAD..origin/main`); say('WARN', 'code', `${head.slice(0, 7)} is ${behind} commit(s) behind origin/main ${remote.slice(0, 7)} (AUTO_UPDATE pulls before each session; or: git pull --ff-only)`); }
else say('PASS', 'code', `at ${head.slice(0, 7)}${remote ? ' = origin/main' : ' (could not reach GitHub to compare)'}`);
const dirty = sh('git', '-C', ROOT, 'status', '--porcelain', '--untracked-files=no');
if (dirty) say('WARN', 'local changes to tracked files', dirty.split('\n').slice(0, 5).join('; '));

// ---- configuration ----
say('PASS', 'role', ROLE);
const need = { backend: { FOLLOW: '1', PITWALL_ROLE: 'backend' }, collector: {}, standalone: {} }[ROLE] || {};
for (const [k, v] of Object.entries(need)) env[k] === v ? say('PASS', `${k}=${v}`) : say('FAIL', k, `is ${env[k] ? `"${env[k]}"` : 'unset'}, needs ${v}`);
if (ROLE === 'backend') {
  /\/\?mode=relay/.test(env.PAGE_URL || '') ? say('PASS', 'PAGE_URL uses the backend relay') : say('FAIL', 'PAGE_URL', 'must be http://127.0.0.1:8765/?mode=relay so predictions run on the collector\'s data');
  const host = env.INGEST_HOST || '127.0.0.1';
  /^(127\.|100\.|10\.|192\.168\.)/.test(host) ? say('PASS', 'ingest address is private', host.startsWith('100.') ? 'Tailscale' : host) : say('FAIL', 'ingest address', `${host} is not private`);
  env.SHARE_LEARNED === '1' ? say('WARN', 'SHARE_LEARNED=1', 'this machine pushes learned/ to GitHub; make sure the Mac does not too') : say('PASS', 'SHARE_LEARNED=0', 'this machine does not publish models (see docs/QATAR-READINESS.md for how publishing works)');
  env.RCLONE_REMOTE ? say('PASS', 'backup remote set', env.RCLONE_REMOTE) : say('FAIL', 'RCLONE_REMOTE', 'unset: recordings are not backed up');
  const cap = Number(env.BACKUP_MAX_GB ?? 15); say(cap <= 18 ? 'PASS' : 'WARN', 'backup cap', `BACKUP_MAX_GB=${cap}${env.BACKUP_MAX_GB == null ? ' (default)' : ''}; Oracle Object Storage is free to 20 GB`);
}
if (ROLE === 'collector') {
  let ce = {};
  try { for (const l of fs.readFileSync(path.join(DATA, 'collector.env'), 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) ce[m[1]] = m[2]; } } catch {}
  const url = env.SHIP_URL || ce.SHIP_URL;
  url ? say('PASS', 'SHIP_URL set', /\/\/(100\.|127\.)/.test(url) ? 'private address' : 'CHECK: not a Tailscale/localhost address') : say('FAIL', 'SHIP_URL', 'unset');
}

// ---- the shared secret (never printed) ----
const secretFile = env.INGEST_SECRET_FILE || (linux ? '/etc/pitwall/ingest-secret' : path.join(DATA, 'ingest-secret'));
try {
  const st = fs.statSync(secretFile), mode = st.mode & 0o777, len = fs.readFileSync(secretFile, 'utf8').trim().length;
  (mode & 0o007) ? say('FAIL', 'secret permissions', `${secretFile} is readable by everyone (${mode.toString(8)}); chmod 640 (Linux) or 600 (Mac)`) : say('PASS', 'secret permissions', mode.toString(8));
  len >= 64 ? say('PASS', 'secret length', `${len} characters`) : say('FAIL', 'secret length', `${len} characters; regenerate with openssl rand -hex 32`);
} catch (e) { say(ROLE === 'standalone' ? 'PASS' : 'FAIL', 'secret', ROLE === 'standalone' ? 'not needed' : `cannot read ${secretFile} (${e.code})`); }

// ---- services ----
if (linux) {
  const units = { backend: ['pitwall-ingest.service', 'pitwall-relay.service', 'pitwall-session.timer', 'pitwall-health.timer', 'pitwall-maintain.timer'], collector: ['pitwall-relay.service', 'pitwall-shipper.service', 'pitwall-health.timer'], standalone: ['pitwall-relay.service', 'pitwall-session.timer', 'pitwall-health.timer', 'pitwall-maintain.timer'] }[ROLE];
  for (const u of fs.readdirSync(path.join(ROOT, 'deploy/oracle/systemd'))) {
    const inst = `/etc/systemd/system/${u}`;
    if (!fs.existsSync(inst)) { if (units.includes(u)) say('FAIL', u, 'not installed'); continue; }
    sha(inst) === sha(path.join(ROOT, 'deploy/oracle/systemd', u)) ? null : say('WARN', u, 'installed copy differs from the repo (re-run install.sh to update; it enables nothing)');
  }
  for (const u of units) {
    const en = sh('systemctl', 'is-enabled', u) || 'disabled', ac = sh('systemctl', 'is-active', u) || 'inactive';
    en === 'enabled' && ac === 'active' ? say('PASS', u, 'enabled, active') : say('FAIL', u, `${en}, ${ac}`);
  }
  const listen = sh('ss', '-ltnH') || '';
  for (const [port, name] of [[8765, 'relay'], [8770, 'ingest']]) {
    const ls = listen.split('\n').filter(l => new RegExp(`:${port}\\b`).test(l)).map(l => l.split(/\s+/)[3]);
    if (!ls.length) { if (name === 'relay' || ROLE === 'backend') say('FAIL', `${name} :${port}`, 'not listening'); continue; }
    ls.every(a => /^(127\.|\[::1\]|100\.)/.test(a)) ? say('PASS', `${name} listens privately`, ls.join(' ')) : say('FAIL', `${name} listens publicly`, ls.join(' '));
  }
  const tz = sh('timedatectl', 'show', '-p', 'NTPSynchronized', '--value');
  tz === 'yes' ? say('PASS', 'clock synchronised (NTP)') : say('WARN', 'clock', `NTPSynchronized=${tz}`);
} else {
  const l = sh('launchctl', 'list') || '';
  for (const a of ['com.pitwall.relay', 'com.pitwall.shipper']) { const m = new RegExp(`^(\\S+)\\s+(\\S+)\\s+${a.replace(/\./g, '\\.')}$`, 'm').exec(l); m && m[1] !== '-' ? say('PASS', a, `running (pid ${m[1]})`) : say('FAIL', a, m ? `loaded, not running (last exit ${m[2]})` : 'not loaded'); }
  const pm = sh('pmset', '-g');
  if (pm && /^\s*sleep\s+[1-9]/m.test(pm)) say('WARN', 'Mac sleeps on its own', 'a sleeping Mac collects nothing; keep it on power with sleep off during the weekend (System Settings → Battery/Energy)');
}

// ---- running state ----
const h = await get('http://127.0.0.1:8765/api/health');
if (!h) say('FAIL', 'relay health', 'not answering on 127.0.0.1:8765');
else {
  say('PASS', 'relay answering', `feed ${h.feed}, session "${h.session}", status ${h.status}`);
  if (ROLE === 'backend') h.follow?.dir ? say('PASS', 'backend follows', `${h.follow.dir} (${h.follow.lines} lines)`) : say('WARN', 'backend follows', 'nothing yet (no session received)');
  if (h.disk) say(h.disk.freePct > 15 ? 'PASS' : 'WARN', 'disk', `${h.disk.freeGB} GB free (${h.disk.freePct}%)`);
}
if (ROLE === 'backend') {
  const ing = await get(`http://${env.INGEST_HOST || '127.0.0.1'}:${env.INGEST_PORT || 8770}/healthz`);
  ing ? say('PASS', 'ingest answering', `${ing.appends} appends, last ${ing.lastAppendAt || 'never'}`) : say('FAIL', 'ingest', 'not answering');
  try {
    for (const f of fs.readdirSync(path.join(DATA, 'collectors'))) {
      const c = JSON.parse(fs.readFileSync(path.join(DATA, 'collectors', f), 'utf8')), age = (Date.now() - c.receivedAt) / 1000;
      say(age < 90 ? 'PASS' : 'WARN', `collector ${c.collector}`, `heard ${Math.round(age)} s ago; F1 feed ${c.relay?.feed ?? '?'}; backlog ${((c.shipper?.backlogBytes || 0) / 1e6).toFixed(1)} MB; F1 TV sign-in ${c.token?.state}${c.token?.expiresAt ? ' until ' + c.token.expiresAt : ''}`);
    }
  } catch { say('FAIL', 'collectors', 'no collector has ever sent a heartbeat'); }
}
if (ROLE === 'collector') {
  try { const s = JSON.parse(fs.readFileSync(path.join(DATA, 'shipper-status.json'), 'utf8')), age = (Date.now() - fs.statSync(path.join(DATA, 'shipper-status.json')).mtimeMs) / 1000; say(age < 60 && !s.lastError ? 'PASS' : 'WARN', 'shipper', `status ${Math.round(age)} s old, backlog ${(s.backlogBytes / 1e6).toFixed(1)} MB${s.lastError ? ', last error ' + s.lastError : ''}`); } catch { say('FAIL', 'shipper', 'no status file'); }
}
// F1 TV sign-in (where this machine connects to F1)
if (ROLE !== 'backend') {
  try {
    let t = fs.readFileSync(path.join(DATA, 'f1tv-token.txt'), 'utf8').trim();
    try { t = JSON.parse(decodeURIComponent(t))?.data?.subscriptionToken || t; } catch {}
    const exp = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000, days = (exp - Date.now()) / 864e5;
    say(days > 3 ? 'PASS' : days > 0 ? 'WARN' : 'FAIL', 'F1 TV sign-in', `${days > 0 ? 'expires' : 'EXPIRED'} ${new Date(exp).toISOString()} (${days.toFixed(1)} days)`);
  } catch { say('WARN', 'F1 TV sign-in', 'none: timing is collected, car positions and telemetry are not'); }
}
// ---- recordings and backups ----
try {
  const m = JSON.parse(fs.readFileSync(path.join(DATA, 'maintain.json'), 'utf8'));
  say(m.errors?.length ? 'WARN' : 'PASS', 'last maintenance', `${m.at}: backed up ${m.backedUp?.length || 0}, not yet backed up ${(m.notBackedUp || []).length}${m.backupGB != null ? `, remote ${m.backupGB} of ${m.backupMaxGB} GB` : ''}${m.errors?.length ? '; ' + m.errors.slice(0, 2).join('; ') : ''}`);
  for (const d of m.notBackedUp || []) if (!d.startsWith('_')) say('WARN', 'not backed up yet', d);
} catch { if (ROLE !== 'collector') say('WARN', 'maintenance', 'has not run yet (data/maintain.json missing)'); }

// ---- freeze and versions in use ----
{
  const fz = path.join(DATA, 'FREEZE');
  if (fs.existsSync(fz)) {
    say('PASS', 'freeze', fs.readFileSync(fz, 'utf8').split('\n')[0]);
    if (ROLE !== 'collector' && env.AUTO_UPDATE !== '0') say('INFO', 'AUTO_UPDATE', `${env.AUTO_UPDATE ?? '1 (default)'}: no effect while frozen (session script skips the pull); set AUTO_UPDATE=0 as well to be safe`);
    if (env.SHARE_LEARNED === '1') say('INFO', 'SHARE_LEARNED=1', 'no effect while frozen (nothing is published)');
  } else say('INFO', 'freeze', `off (no ${path.relative(ROOT, fz) || fz}): code updates and model publishing follow AUTO_UPDATE / SHARE_LEARNED`);
  const port = env.PORT || 8765;
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools/versions.mjs'), `--relay=http://127.0.0.1:${port}`, '--public'], { encoding: 'utf8', timeout: 90000, env: { ...process.env, PITWALL_DATA: DATA } });
    for (const l of out.split('\n')) { const m = l.match(/^(PASS|WARN|FAIL|INFO)\s+(.{24})\s(.*)$/); if (m) say(m[1], 'version: ' + m[2].trim(), m[3]); }
  } catch (e) { for (const l of String(e.stdout || '').split('\n')) { const m = l.match(/^(PASS|WARN|FAIL|INFO)\s+(.{24})\s(.*)$/); if (m) say(m[1], 'version: ' + m[2].trim(), m[3]); } if (!e.stdout) say('WARN', 'versions', 'could not run tools/versions.mjs: ' + e.message.slice(0, 80)); }
}

const w = Math.max(...res.map(r => r[1].length));
for (const [l, what, d] of res) console.log(`${l.padEnd(4)}  ${what.padEnd(w)}  ${d}`);
const fails = res.filter(r => r[0] === 'FAIL').length;
console.log(`\n${fails ? fails + ' FAIL' : 'no FAIL'}, ${res.filter(r => r[0] === 'WARN').length} WARN`);
process.exitCode = fails ? 1 : 0;
