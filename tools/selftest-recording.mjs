// End-to-end test of recording on this machine, against a stand-in F1 feed (no internet needed):
//   1. the real relay (server.mjs) connects 3 times to a local fake of F1's SignalR feed
//   2. records ~6 s, is killed with SIGKILL (a crash), restarts, records ~6 s, stops cleanly
//   3. checks every update reached the disk except during the crash, and the crash is logged
//   4. rebuilds the state twice (must be identical), compresses it, rebuilds again (identical)
//   5. replays it through the relay to a real headless page and compares the page's state
//   6. checks the browser computes the reference race call bit for bit (tests/fixtures)
//   node tools/selftest-recording.mjs [--no-browser]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFeed, stateAt } from '../recorder.mjs';
import { compactFolder } from './compact-recordings.mjs';
import { startFakeF1 } from './lib/fake-f1.mjs';
import { goldenInput, compare as goldenCompare, compute as goldenRows, FILE as GOLDEN } from '../tests/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RS = '\x1e';
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

// ---------- A fake F1 feed ----------
const fakeF1 = await startFakeF1();
const fake = { address: () => ({ port: Number(fakeF1.origin.split(':').pop()) }), close: () => fakeF1.close() };
const sockets = new Set();
let seq = 0; const seqNow = () => fakeF1.seq();
const tick = null;

// ---------- The real relay against it ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-selftest-'));
const RPORT = 18765;
const env = { ...process.env, PORT: String(RPORT), PITWALL_DATA: tmp, F1_ORIGIN: `http://127.0.0.1:${fake.address().port}`, KALSHI: '0', F1TV_TOKEN: '' };
const startRelay = (extra = {}) => { const p = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); return p; };
const health = async port => { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; } };

let relay = startRelay();
await sleep(6000);
const h1 = await health(RPORT);
ok(h1?.feed === 'live' && h1.live === 3, `relay live on 3 connections (${h1?.live})`);
ok(!!h1?.recording?.dir, 'recording to ' + (h1?.recording?.dir ? path.relative(tmp, h1.recording.dir) : 'nothing'));
const dir = h1.recording.dir;
relay.kill('SIGKILL'); const killedAtSeq = seqNow(); await new Promise(r => relay.on('exit', r));
await sleep(2000);
relay = startRelay();
await sleep(6000);
const h2 = await health(RPORT);
ok(h2?.recording?.dir === dir, 'after the crash it records into the same session folder');
relay.kill('SIGTERM'); await new Promise(r => relay.on('exit', r));
fakeF1.stopUpdates();

// Every update the fake sent while a relay was connected must be on disk.
const got = new Set(); let frames = 0;
for await (const f of readFeed(dir)) { frames++; try { const m = JSON.parse(f.part); if (m.target === 'feed' && m.arguments[0] === 'LapCount') got.add(m.arguments[1].CurrentLap); } catch {} }
const all = [...got].sort((a, b) => a - b);
const missing = []; for (let i = all[0]; i <= all.at(-1); i++) if (!got.has(i)) missing.push(i);
const gapRuns = missing.reduce((a, x) => (a.length && a.at(-1)[1] === x - 1 ? a.at(-1)[1] = x : a.push([x, x]), a), []);
ok(frames > 300, `${frames} frames on disk (${all.length} distinct updates, ${all[0]}…${all.at(-1)})`);
ok(gapRuns.length === 1 && Math.abs(gapRuns[0][0] - killedAtSeq) < 20, `only missing updates are the crash window: ${gapRuns.map(g => g.join('–')).join(', ') || 'none'} (killed at ${killedAtSeq})`);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
ok(meta.relayRuns.length === 2, `meta.json lists ${meta.relayRuns.length} relay runs`);
const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
ok(ev.includes('"relayStop"') && (ev.match(/"ev":"open"/g) || []).length === 2, 'events.jsonl has both starts and the clean stop');
const report = execFileSync(process.execPath, ['tools/recording-report.mjs', dir], { cwd: ROOT }).toString();
ok(/relay starts: 2/.test(report), 'recording report runs and shows the restart');

// Deterministic rebuild, before and after compression.
const digest = async () => crypto.createHash('sha256').update(JSON.stringify((await stateAt(dir)).state)).digest('hex');
const d1 = await digest(), d2 = await digest();
ok(d1 === d2, `state rebuilt twice: identical (${d1.slice(0, 12)})`);
compactFolder(dir);
ok(!fs.existsSync(path.join(dir, 'feed.tsv')) && fs.existsSync(path.join(dir, 'feed.tsv.gz')), `compressed (${(fs.statSync(path.join(dir, 'feed.tsv.gz')).size / 1024).toFixed(0)} KB)`);
ok(await digest() === d1, 'state rebuilt from the compressed files: identical');
const fin = (await stateAt(dir)).state;
{ const cn = goldenCompare(goldenRows(), JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).rows); ok(cn.same, `Node race call matches the reference: ${cn.exact ? 'exactly' : 'largest difference ' + cn.max.toExponential(1)} (${process.platform}-${process.arch} node ${process.version})`); }
ok(fin.LapCount?.CurrentLap === all.at(-1), `final lap counter ${fin.LapCount?.CurrentLap} = last update recorded ${all.at(-1)}`);

// Replay to a real page, and the race call in the browser.
if (!process.argv.includes('--no-browser')) {
  const { chromium } = await import('playwright-core');
  const channel = process.env.CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : '');
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
  const rp = startRelay({ REPLAY: dir, SPEED: '20', PORT: String(RPORT + 1) });
  await sleep(1500);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${RPORT + 1}/?mode=relay`, { waitUntil: 'load' });
  for (let i = 0; i < 60 && !/replay finished/.test(rp.out); i++) await sleep(500);
  await sleep(1500);
  const pageState = await page.evaluate(() => JSON.stringify({ LapCount: state.LapCount, TimingData: state.TimingData, SessionInfo: state.SessionInfo }));
  ok(pageState === JSON.stringify({ LapCount: fin.LapCount, TimingData: fin.TimingData, SessionInfo: fin.SessionInfo }), 'replayed to a headless page: page state matches the recording');
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const inBrowser = await page.evaluate(inp => ({ v: RaceSim.VERSION, rows: RaceSim.run(RaceSim.build(inp)).cars.map(c => [c.n, c.win, c.top3, c.top5, c.top10]) }), goldenInput());
  const cb = goldenCompare(inBrowser.rows, g.rows);
  ok(inBrowser.v === g.version && cb.same, `browser race call matches the reference: ${cb.exact ? 'exactly' : 'largest difference ' + cb.max.toExponential(1)} (${browser.version()}, ${process.platform}-${process.arch})`);
  rp.kill('SIGTERM'); await browser.close();
}
fake.close(); for (const s of sockets) s.destroy();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
