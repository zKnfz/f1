// End-to-end test of collector → Oracle backend, with real processes and a stand-in F1 feed:
//   fake F1 → collector relay (server.mjs) → shipper.mjs → [network link we can cut] → ingest.mjs
//   → backend relay (server.mjs FOLLOW=1) → headless page (predictions recorded)
//   node tools/selftest-pipeline.mjs [--no-browser]
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeF1 } from './lib/fake-f1.mjs';
import { readFeed, stateAt } from '../recorder.mjs';
import { compactFolder } from './compact-recordings.mjs';
import { sign } from '../transport.mjs';
import { goldenInput, compare as goldenCompare, FILE as GOLDEN } from '../tests/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (n, cond, msg) => { results.push({ n, ok: !!cond, msg }); console.log(`${cond ? 'ok  ' : 'FAIL'} [${n}] ${msg}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-pipeline-'));
const COL = path.join(tmp, 'collector'), ORA = path.join(tmp, 'oracle');
fs.mkdirSync(COL, { recursive: true }); fs.mkdirSync(ORA, { recursive: true });
const SECRET = crypto.randomBytes(32).toString('hex');
for (const d of [COL, ORA]) fs.writeFileSync(path.join(d, 'ingest-secret'), SECRET, { mode: 0o600 });
const P = { col: 18811, ora: 18812, ingest: 18870, link: 18871 };

// ---------- A network link between collector and backend that can be cut ----------
let linkDown = false; const linkSocks = new Set();
const link = net.createServer(c => {
  if (linkDown) return c.destroy();
  const u = net.connect(P.ingest, '127.0.0.1');
  linkSocks.add(c); linkSocks.add(u);
  c.pipe(u); u.pipe(c);
  const end = () => { c.destroy(); u.destroy(); linkSocks.delete(c); linkSocks.delete(u); };
  c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
});
await new Promise(r => link.listen(P.link, '127.0.0.1', r));
const cutLink = v => { linkDown = v; if (v) for (const s of linkSocks) s.destroy(); };

// ---------- Processes ----------
const f1 = await startFakeF1({ everyMs: 40 });
const procs = {};
function start(name, args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, F1TV_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d);
  procs[name] = p; return p;
}
const stop = (name, sig = 'SIGTERM') => new Promise(r => { const p = procs[name]; if (!p || p.exitCode !== null) return r(); p.on('exit', r); p.kill(sig); });
const env = {
  collector: { PORT: String(P.col), PITWALL_DATA: COL, F1_ORIGIN: f1.origin, KALSHI: '0' },
  shipper: { PORT: String(P.col), PITWALL_DATA: COL, SHIP_URL: `http://127.0.0.1:${P.link}`, SHIP_ID: 'test-collector', INGEST_SECRET_FILE: path.join(COL, 'ingest-secret') },
  ingest: { PITWALL_DATA: ORA, INGEST_PORT: String(P.ingest), INGEST_SECRET_FILE: path.join(ORA, 'ingest-secret') },
  backend: { PORT: String(P.ora), PITWALL_DATA: ORA, FOLLOW: '1', KALSHI: '0' },
};
const startAll = () => { start('collector', ['server.mjs'], env.collector); start('ingest', ['ingest.mjs'], env.ingest); start('shipper', ['shipper.mjs'], env.shipper); start('backend', ['server.mjs'], env.backend); };
const get = async url => { try { return await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };

const sessionDir = () => { const r = path.join(COL, 'rec'); return fs.existsSync(r) ? fs.readdirSync(r).find(d => /^\d{4}-/.test(d)) : null; };
const fileSha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const linesOf = async d => { const out = []; for await (const f of readFeed(d)) out.push(`${f.r}\t${f.m}\t${f.c}\t${f.part}`); return out; };
// Wait until the backend holds exactly what the collector has (all files), or time out.
async function converge(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = sessionDir();
    try {
      const held = JSON.parse(fs.readFileSync(path.join(ORA, 'rec', d, '.ingest.json'), 'utf8')).files;
      const same = ['feed.tsv', 'events.jsonl'].every(f => { const a = path.join(COL, 'rec', d, f); return !fs.existsSync(a) || fs.statSync(a).size === (held[f] || 0); });
      if (same) return Date.now() - t0;
    } catch {}
    await sleep(200);
  }
  return -1;
}
const safeConverge = async ms => { try { return await converge(ms); } catch { await sleep(500); return converge(ms); } };
async function sameContent(label, n) {
  const d = sessionDir();
  // Backend first: the collector only grows, so read later it can only be longer.
  const b = await linesOf(path.join(ORA, 'rec', d)), a = await linesOf(path.join(COL, 'rec', d));
  // While F1 is still sending, the collector may be a few lines ahead: the backend copy must be
  // exactly the collector's first lines (nothing missing, nothing extra, same order).
  const prefix = b.length > 0 && b.length <= a.length && b.every((l, i) => l === a[i]);
  const exact = prefix && a.length === b.length;
  ok(n, prefix && a.length - b.length < 300, `${label}: backend copy ${exact ? 'identical to' : `an exact prefix of (${a.length - b.length} lines still in flight)`} the collector's (${b.length} lines)`);
}
const seqsOf = async dir => { const s = new Set(); for await (const f of readFeed(dir)) { try { const m = JSON.parse(f.part); if (m.target === 'feed' && m.arguments[0] === 'LapCount') s.add(m.arguments[1].CurrentLap); } catch {} } return [...s].sort((x, y) => x - y); };

try {
  // 1. Normal continuous ingestion
  startAll();
  await sleep(8000);
  const d = sessionDir();
  ok(1, !!d, `collector recording ${d}`);
  ok(1, (await safeConverge()) >= 0, 'backend caught up with the collector');
  await sameContent('normal running', 1);
  const bh = await get(`http://127.0.0.1:${P.ora}/api/health`);
  ok(1, bh?.follow?.dir === d && bh.follow.lines > 100 && bh.session === 'Selftest GP Selftest', `backend relay follows the session live (${bh?.follow?.lines} lines, feed ${bh?.feed})`);

  // 2. Collector crash and restart
  await stop('collector', 'SIGKILL'); const killedAt = f1.seq();
  await sleep(2000); start('collector', ['server.mjs'], env.collector); await sleep(5000);
  ok(2, (await safeConverge()) >= 0, 'collector crashed (SIGKILL) and restarted: backend caught up');
  await sameContent('after collector crash', 2);
  const seqs = await seqsOf(path.join(ORA, 'rec', d)); const miss = []; for (let i = seqs[0]; i <= seqs.at(-1); i++) if (!seqs.includes(i)) miss.push(i);
  ok(2, miss.length > 0 && miss[0] >= killedAt - 15 && miss.at(-1) <= killedAt + 120, `only updates F1 sent while the collector was down are missing (${miss[0]}–${miss.at(-1)}, crash at ${killedAt}); recorded as never captured, not lost in transit`);

  // 3. Backend ingest crash and restart
  await stop('ingest', 'SIGKILL'); await sleep(4000);
  start('ingest', ['ingest.mjs'], env.ingest); await sleep(1500);
  ok(3, (await safeConverge()) >= 0, 'ingest crashed (SIGKILL) for 4 s and restarted: backend caught up');
  await sameContent('after ingest crash', 3);

  // 4. Network disconnection and reconnection
  cutLink(true); await sleep(8000);
  const st4 = JSON.parse(fs.readFileSync(path.join(COL, 'shipper-status.json'), 'utf8'));
  ok(4, !!st4.lastError, `link cut for 8 s: shipper noticed (${st4.lastError}) and kept the data on disk`);
  cutLink(false);
  ok(4, (await safeConverge(40000)) >= 0, 'link restored: backlog delivered');
  await sameContent('after network outage', 4);

  // 5 + 6. Duplicate and out-of-order delivery, and bad requests (straight to ingest)
  const call = async (method, q, body = Buffer.alloc(0), opts = {}) => {
    const pq = q; const auth = opts.auth ?? sign(opts.secret || SECRET, 'test-collector', method, pq, body, opts.ts);
    const r = await fetch(`http://127.0.0.1:${P.ingest}${pq}`, { method, body: method === 'GET' ? undefined : body, headers: { Authorization: auth } });
    let j = {}; try { j = await r.json(); } catch {} return { code: r.status, j };
  };
  const T = '2026-test-dedupe-1';
  const l1 = Buffer.from('{"r":1,"ev":"a"}\n'), l2 = Buffer.from('{"r":2,"ev":"b"}\n');
  let r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, l1);
  ok(5, r.code === 200 && r.j.have === l1.length, 'first delivery written');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, l1);
  ok(5, r.code === 200 && r.j.duplicate && r.j.have === l1.length, 'exact duplicate acknowledged, not written again');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, Buffer.concat([l1, l2]));
  ok(5, r.code === 200 && r.j.have === l1.length + l2.length, 'overlapping delivery: only the new part written');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=${l1.length + l2.length + 50}`, l2);
  ok(6, r.code === 409 && r.j.have === l1.length + l2.length, 'out-of-order (gap) refused with the offset needed (409)');
  ok(5, fs.readFileSync(path.join(ORA, 'rec', T, 'events.jsonl'), 'utf8') === l1.toString() + l2.toString(), 'file holds each line exactly once, in order');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, l1, { secret: 'x'.repeat(64) });
  ok(6, r.code === 401, 'wrong secret refused (401)');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, l1, { ts: Date.now() - 600000 });
  ok(6, r.code === 401, 'replayed/old request (10 min) refused (401)');
  r = await call('POST', `/v1/append?dir=${encodeURIComponent('../../etc')}&file=events.jsonl&offset=0`, l1);
  ok(6, r.code === 400, 'path outside the recordings refused (400)');
  r = await call('POST', `/v1/append?dir=${T}&file=passwd&offset=0`, l1);
  ok(6, r.code === 400, 'unknown file name refused (400)');
  r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, Buffer.from('no newline'));
  ok(6, r.code === 422, 'partial line refused (422)');
  r = await call('POST', `/v1/append?dir=${T}&file=feed.tsv&offset=0`, Buffer.from('garbage line\n'));
  ok(6, r.code === 422, 'feed line not in recording format refused (422)');
  const big = Buffer.alloc(17 * 1024 * 1024, 97);
  try { r = await call('POST', `/v1/append?dir=${T}&file=events.jsonl&offset=0`, big); } catch { r = { code: 413 }; }
  ok(6, r.code === 413, 'oversized body refused (413)');

  // 7. Buffer exhaustion: backend unreachable while a large backlog builds; backend disk full
  cutLink(true);
  f1.burst(2500, 2000); await sleep(4000); f1.burst(2500, 2000); await sleep(3000);
  const backlog = fs.statSync(path.join(COL, 'rec', d, 'feed.tsv')).size - JSON.parse(fs.readFileSync(path.join(ORA, 'rec', d, '.ingest.json'), 'utf8')).files['feed.tsv'];
  const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(procs.shipper.pid)]).toString().trim()) / 1024;
  ok(7, backlog > 20e6, `backend unreachable: ${(backlog / 1e6).toFixed(1)} MB spooled on the collector's disk`);
  cutLink(false);
  const t7 = await safeConverge(120000);
  ok(7, t7 >= 0, `backlog of ${(backlog / 1e6).toFixed(1)} MB delivered in ${(t7 / 1000).toFixed(1)} s after reconnecting (shipper memory ${rss.toFixed(0)} MB)`);
  await sameContent('after backlog', 7);
  await stop('ingest'); start('ingest', ['ingest.mjs'], { ...env.ingest, INGEST_MIN_FREE_GB: '1000000' }); await sleep(4000);
  const st7 = JSON.parse(fs.readFileSync(path.join(COL, 'shipper-status.json'), 'utf8'));
  ok(7, /507/.test(st7.lastError || ''), `backend disk "full": ingest refuses (507), collector keeps the data (${st7.lastError})`);
  await stop('ingest'); start('ingest', ['ingest.mjs'], env.ingest);
  ok(7, (await safeConverge(40000)) >= 0, 'space back: everything delivered');

  // 12. Missing telemetry sign-in, reported by the collector's heartbeat
  const hb = JSON.parse(fs.readFileSync(path.join(ORA, 'collectors', 'test-collector.json'), 'utf8'));
  ok(12, hb.token?.state === 'missing' && hb.relay?.feed === 'live', `collector reports no F1 TV sign-in (${hb.token?.state}) while timing keeps flowing (feed ${hb.relay?.feed})`);
  ok(12, !JSON.stringify(hb).match(/eyJ[\w-]{10,}/), 'heartbeat never carries a token');
  const health = execFileSync(process.execPath, ['tools/health.mjs'], { cwd: ROOT, env: { ...process.env, PITWALL_DATA: ORA, PITWALL_ROLE: 'backend', PORT: String(P.ora), INGEST_PORT: String(P.ingest) } }).toString();
  ok(12, /no F1 TV sign-in, car positions and telemetry are not being collected/.test(health), 'backend health check reports the missing telemetry explicitly');

  // 9 + 10 + 11. Backend's live state, predictions, model versions (headless page on the backend)
  if (!process.argv.includes('--no-browser')) {
    const { chromium } = await import('playwright-core');
    const channel = process.env.CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : '');
    const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${P.ora}/?mode=relay`, { waitUntil: 'load' });
    await sleep(5000);
    f1.stopUpdates(); await safeConverge(); await sleep(1500);
    const want = (await stateAt(path.join(ORA, 'rec', d))).state;
    const pageState = await page.evaluate(() => JSON.stringify({ LapCount: state.LapCount, TimingData: state.TimingData, SessionInfo: state.SessionInfo }));
    ok(9, pageState === JSON.stringify({ LapCount: want.LapCount, TimingData: want.TimingData, SessionInfo: want.SessionInfo }), `page on the backend shows exactly the replayed state (lap counter ${want.LapCount?.CurrentLap})`);
    const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const rows = await page.evaluate(inp => RaceSim.run(RaceSim.build(inp)).cars.map(c => [c.n, c.win, c.top3, c.top5, c.top10]), goldenInput());
    const cmp = goldenCompare(rows, g.rows);
    ok(10, cmp.same, `race model on the backend's page matches the reference (${cmp.exact ? 'exactly' : 'within ' + cmp.max.toExponential(1)})`);
    await browser.close();
    const bp = path.join(ORA, 'rec', d, 'backend-page.jsonl');
    const recs = fs.existsSync(bp) ? fs.readFileSync(bp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const models = recs.find(x => x.kind === 'models');
    ok(11, models?.race?.version === g.version && recs.some(x => x.kind === 'registry'), `model version and parameters recorded on the backend (${models?.race?.version}, ${recs.length} records in backend-page.jsonl)`);
    ok(11, !fs.existsSync(path.join(ORA, 'rec', d, 'page.jsonl')) || fileSha(path.join(ORA, 'rec', d, 'page.jsonl')) === fileSha(path.join(COL, 'rec', d, 'page.jsonl')), "backend's own records never mix into the collector's files");
  } else f1.stopUpdates();

  // 13. "Reboot": everything killed at once, then started again
  for (const n of Object.keys(procs)) await stop(n, 'SIGKILL');
  await sleep(1000);
  f1.burst(50, 100);
  startAll(); await sleep(6000);
  ok(13, (await safeConverge()) >= 0, 'all four processes killed at once and restarted: backend caught up');
  await sameContent('after full restart', 13);
  const bh13 = await get(`http://127.0.0.1:${P.ora}/api/health`);
  ok(13, bh13?.follow?.dir === d && bh13.follow.lines > 1000, `backend relay rebuilt the session from its copy after restart (${bh13?.follow?.lines} lines)`);

  // 8. Compression on the backend, then more data arriving for the same session
  for (const n of Object.keys(procs)) await stop(n);
  const before = JSON.stringify((await stateAt(path.join(ORA, 'rec', d))).state);
  compactFolder(path.join(ORA, 'rec', d));
  ok(8, fs.existsSync(path.join(ORA, 'rec', d, 'feed.tsv.gz')) && !fs.existsSync(path.join(ORA, 'rec', d, 'feed.tsv')), 'backend copy compressed');
  ok(8, JSON.stringify((await stateAt(path.join(ORA, 'rec', d))).state) === before, 'state from the compressed copy identical');
  f1.burst(30, 100); startAll(); await sleep(6000);
  ok(8, (await safeConverge()) >= 0, 'late data for a compressed session appended after the .gz (offsets kept)');
  await sameContent('compressed + late data', 8);
  for (const n of Object.keys(procs)) await stop(n);

  // 9. Replay: rebuilding from either copy gives the same state
  const sc = JSON.stringify((await stateAt(path.join(COL, 'rec', d))).state), so = JSON.stringify((await stateAt(path.join(ORA, 'rec', d))).state);
  ok(9, sc === so, 'state rebuilt from the backend copy = from the collector copy');

  // 14. Backup integrity (rclone to a local folder standing in for remote storage)
  let rclone = true; try { execFileSync('rclone', ['version'], { stdio: 'pipe' }); } catch { rclone = false; }
  if (!rclone) ok(14, true, 'SKIPPED here: rclone not installed (runs on the Linux ARM64 check)');
  else {
    const remote = path.join(tmp, 'backup');
    fs.mkdirSync(remote);
    compactFolder(path.join(ORA, 'rec', d));
    execFileSync(process.execPath, ['tools/compact-recordings.mjs'], { cwd: ROOT, env: { ...process.env, PITWALL_DATA: ORA, RCLONE_REMOTE: remote, PORT: '1' } });
    const m = JSON.parse(fs.readFileSync(path.join(ORA, 'maintain.json'), 'utf8'));
    ok(14, m.backedUp.includes(d), `backed up and verified with rclone check (${m.backedUp.length} folder(s))`);
    const restore = path.join(tmp, 'restore');
    execFileSync('rclone', ['copy', path.join(remote, d), path.join(restore, d)]);
    const sr = JSON.stringify((await stateAt(path.join(restore, d))).state);
    ok(14, sr === so, 'restored from the backup: state identical');
  }
} catch (e) {
  ok('x', false, 'test crashed: ' + (e.stack || e.message));
} finally {
  for (const n of Object.keys(procs)) await stop(n, 'SIGKILL');
  f1.close(); link.close(); for (const s of linkSocks) s.destroy();
  if (process.env.KEEP) console.log('kept', tmp); else fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
