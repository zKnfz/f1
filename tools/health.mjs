// Health check for the always-on recorder (server). Run every 2 minutes by pitwall-health.timer.
// Checks, and fixes what it can:
//   relay not answering twice in a row          → restart it
//   a session is on but the feed isn't live, or
//     nothing has arrived for 60 s while running → restart the relay (once per 5 min at most)
//   a session is on but the recorder page isn't  → start it
//   disk space low                               → run compaction, warn
//   F1 TV sign-in runs out within 30 h / expired → warn
//   finished recordings not backed up for 2 days → warn
// Writes data/health.json (latest) and data/health.log (changes only). Warnings go to the log
// and, if NTFY_URL is set (e.g. https://ntfy.sh/<your-private-topic>), to your phone.
// Restarting services uses `sudo -n systemctl ...`, allowed for these two units only
// (deploy/oracle/sudoers). On a Mac (no systemd) it only reports.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRaces, sessionsOf } from './schedule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const PORT = process.env.PORT || 8765;
// PITWALL_ROLE=backend (Oracle): no F1 connection here; data comes from collectors through
// ingest.mjs. Then the checks are about the collectors, ingestion and the relay following it.
const BACKEND = process.env.PITWALL_ROLE === 'backend';
const INGEST = process.env.INGEST_HEALTH_URL || `http://${process.env.INGEST_HOST || '127.0.0.1'}:${process.env.INGEST_PORT || 8770}/healthz`;
const SYSTEMD = fs.existsSync('/run/systemd/system');
const now = Date.now();
const memFile = path.join(DATA, 'health-state.json');
let mem = {}; try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch {}
const warnings = [], actions = [];

const sh = (...a) => { try { return execFileSync(a[0], a.slice(1), { stdio: 'pipe', timeout: 30000 }).toString().trim(); } catch (e) { return null; } };
const systemctl = (verb, unit) => SYSTEMD ? sh('sudo', '-n', 'systemctl', verb, unit) !== null : false;
const active = unit => SYSTEMD && sh('systemctl', 'is-active', unit) === 'active';

let h = null;
try { h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) })).json(); } catch {}
const races = await loadRaces({ cacheFile: path.join(DATA, 'schedule-cache.json'), maxAgeMs: 6 * 3600e3 });
const sess = sessionsOf(races);
const on = sess.find(s => now >= s.start - 25 * 60000 && now <= s.end);
const running = on && now >= on.start && now <= on.end;
const next = sess.find(s => s.start > now);

const restartRelay = why => {
  if (now - (mem.lastRelayRestart || 0) < 5 * 60000) return warnings.push(`relay: ${why} (restarted recently, waiting)`);
  mem.lastRelayRestart = now;
  actions.push(`restarted relay: ${why}`);
  if (!systemctl('restart', 'pitwall-relay.service')) warnings.push(`relay: ${why}, and could not restart it`);
};
if (!h) {
  mem.relayDown = (mem.relayDown || 0) + 1;
  if (mem.relayDown >= 2) restartRelay('not answering');
  else warnings.push('relay: not answering (will restart if it happens again)');
} else if (BACKEND) {
  mem.relayDown = 0;
  // The relay must keep up with what arrives (it follows the session's feed.tsv).
  if (running && h.follow && h.follow.lastLineAgoS != null && h.follow.lastLineAgoS > 30 && (h.follow.behindBytes || 0) > 0) restartRelay(`not keeping up with incoming data (${h.follow.behindBytes} bytes behind)`);
  if (h.disk && h.disk.freePct < 15) {
    warnings.push(`disk: ${h.disk.freePct}% free (${h.disk.freeGB} GB)`);
    if (!active('pitwall-maintain.service')) systemctl('start', 'pitwall-maintain.service') && actions.push('started compaction for space');
  }
} else {
  mem.relayDown = 0;
  if (running && h.feed !== 'live') {
    mem.notLive = (mem.notLive || 0) + 1;
    if (mem.notLive >= 2) restartRelay(`session on, feed ${h.feed}`);
  } else mem.notLive = 0;
  if (running && /Started/.test(h.status || '') && h.lastDataAgoS > 60) restartRelay(`nothing from F1 for ${h.lastDataAgoS} s during the session`);
  if (h.disk && h.disk.freePct < 15) {
    warnings.push(`disk: ${h.disk.freePct}% free (${h.disk.freeGB} GB)`);
    if (!active('pitwall-maintain.service')) systemctl('start', 'pitwall-maintain.service') && actions.push('started compaction for space');
  }
}
if (on && SYSTEMD && !active('pitwall-session.service') && !fs.readFileSync(path.join(DATA, 'recorded.txt'), { flag: 'a+' }).toString().includes(on.name)) {
  if (systemctl('start', 'pitwall-session.service')) actions.push(`started the recorder page for ${on.name}`);
  else warnings.push(`recorder page not running for ${on.name}`);
}
if (BACKEND) {
  // Ingestion
  let ing = null;
  try { ing = await (await fetch(INGEST, { signal: AbortSignal.timeout(5000) })).json(); } catch {}
  if (!ing) {
    mem.ingestDown = (mem.ingestDown || 0) + 1;
    if (mem.ingestDown >= 2) { actions.push('restarted ingest: not answering'); if (!systemctl('restart', 'pitwall-ingest.service')) warnings.push('ingest not answering, and could not restart it'); }
    else warnings.push('ingest: not answering (will restart if it happens again)');
  } else {
    mem.ingestDown = 0;
    const age = ing.lastAppendAt ? (now - Date.parse(ing.lastAppendAt)) / 1000 : Infinity;
    if (running && age > 30) warnings.push(`no data arriving from any collector for ${isFinite(age) ? Math.round(age) + ' s' : 'this whole run'} during ${on.name}`);
    if (ing.freeGB < 3) warnings.push(`ingest: only ${ing.freeGB} GB free; collectors are being asked to keep their data`);
  }
  // Collectors: what each says about itself (heartbeats every 15 s)
  let hbs = [];
  try { hbs = fs.readdirSync(path.join(DATA, 'collectors')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(DATA, 'collectors', f), 'utf8'))); } catch {}
  if (!hbs.length) warnings.push('no collector has ever connected');
  for (const c of hbs) {
    const age = (now - c.receivedAt) / 1000, who = `collector ${c.collector}`;
    if (on && age > 60) warnings.push(`${who} offline: last heard ${age < 3600 ? Math.round(age) + ' s' : (age / 3600).toFixed(1) + ' h'} ago, ${on.name} ${running ? 'running' : 'about to start'}`);
    else if (!on && age > 6 * 3600) warnings.push(`${who} offline for ${(age / 3600).toFixed(1)} h`);
    if (age < 120) {
      if (running && c.relay && c.relay.feed !== 'live') warnings.push(`${who}: F1 feed ${c.relay.feed || 'down'} during the session`);
      if (!c.relay) warnings.push(`${who}: its relay is not answering`);
      if ((c.shipper?.backlogBytes || 0) > 5e6) warnings.push(`${who}: ${(c.shipper.backlogBytes / 1e6).toFixed(1)} MB waiting to be sent${c.shipper.lastError ? ` (${c.shipper.lastError})` : ''}`);
      if (c.token?.state === 'missing') warnings.push(`${who}: no F1 TV sign-in, car positions and telemetry are not being collected (timing is)`);
      else if (c.token?.state === 'expired') warnings.push(`${who}: F1 TV sign-in expired, telemetry not collected (timing is)`);
      else if (c.token?.expiresAt && Date.parse(c.token.expiresAt) - now < 30 * 3600e3) warnings.push(`${who}: F1 TV sign-in runs out ${c.token.expiresAt}`);
      if (Math.abs(c.shipper?.clockOffsetMs || 0) > 2000) warnings.push(`${who}: clock ${(c.shipper.clockOffsetMs / 1000).toFixed(1)} s off the backend's (check NTP on both)`);
    }
  }
}
if (process.env.PITWALL_ROLE === 'collector') {
  // Is the data getting to the backend? (The backend alerts too; this works if it is unreachable.)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, 'shipper-status.json'), 'utf8'));
    const age = (now - fs.statSync(path.join(DATA, 'shipper-status.json')).mtimeMs) / 1000;
    if (age > 120) { warnings.push(`shipper not running (status ${Math.round(age)} s old)`); if (systemctl('restart', 'pitwall-shipper.service')) actions.push('restarted shipper'); }
    else if (s.lastError) warnings.push(`cannot reach the backend: ${s.lastError}; ${(s.backlogBytes / 1e6).toFixed(1)} MB kept here until it can`);
  } catch { warnings.push('shipper has never run'); }
}
// F1 TV sign-in (only where this machine connects to F1 itself)
if (!BACKEND) try {
  let tok = fs.readFileSync(path.join(DATA, 'f1tv-token.txt'), 'utf8').trim();
  try { tok = JSON.parse(decodeURIComponent(tok))?.data?.subscriptionToken || tok; } catch {}
  const exp = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).exp * 1000;
  const left = (exp - now) / 3600e3;
  if (left <= 0) warnings.push('F1 TV sign-in expired: car positions and telemetry are not being recorded');
  else if (left < 30) warnings.push(`F1 TV sign-in runs out in ${left.toFixed(0)} h`);
} catch { warnings.push('no F1 TV sign-in on this server (car positions and telemetry not recorded)'); }
// Backups
let maint = null; try { maint = JSON.parse(fs.readFileSync(path.join(DATA, 'maintain.json'), 'utf8')); } catch {}
if (maint && !maint.backupConfigured) warnings.push('no off-server backup set up (RCLONE_REMOTE)');
if (maint?.errors?.length) warnings.push(`maintenance: ${maint.errors[0]}`);
if (maint && now - Date.parse(maint.at) > 3 * 3600e3) warnings.push('maintenance has not run for 3 h');
const stale = (maint?.notBackedUp || []).filter(d => { try { return now - fs.statSync(path.join(DATA, 'rec', d)).mtimeMs > 2 * 86400e3; } catch { return false; } });
if (maint?.backupConfigured && stale.length) warnings.push(`not backed up after 2 days: ${stale.join(', ')}`);

const report = { at: new Date(now).toISOString(), ok: !!h && !warnings.length, relay: h, sessionOn: on?.name || null, running: !!running, next: next ? { name: next.name, start: new Date(next.start).toISOString() } : null, warnings, actions };
fs.writeFileSync(path.join(DATA, 'health.json'), JSON.stringify(report, null, 1));
const sig = JSON.stringify([warnings, actions]);
if (sig !== mem.lastSig || actions.length) {
  fs.appendFileSync(path.join(DATA, 'health.log'), `${report.at} ${warnings.length || actions.length ? [...actions, ...warnings].join(' | ') : 'all good'}\n`);
  // Phone notification for anything new (each message at most every 6 h).
  if (process.env.NTFY_URL) for (const m of [...actions, ...warnings]) {
    mem.sent ??= {};
    if (now - (mem.sent[m] || 0) < 6 * 3600e3) continue;
    mem.sent[m] = now;
    try { await fetch(process.env.NTFY_URL, { method: 'POST', body: `Pitwall recorder: ${m}`, signal: AbortSignal.timeout(10000) }); } catch {}
  }
}
mem.lastSig = sig;
fs.writeFileSync(memFile, JSON.stringify(mem));
console.log(JSON.stringify({ ok: report.ok, sessionOn: report.sessionOn, warnings, actions }));
