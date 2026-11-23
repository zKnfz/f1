// End-to-end test of recording on this machine, against a stand-in F1 feed (no internet needed):
//   1. the real relay (server.mjs) connects 3 times to a local fake of F1's SignalR feed
//   2. records ~6 s, is killed with SIGKILL (a crash), restarts, records ~6 s, stops cleanly
//   3. checks every update reached the disk except during the crash, and the crash is logged
//   4. rebuilds the state twice (must be identical), compresses it, rebuilds again (identical)
//   5. replays it through the relay to a real headless page and compares the page's state
//   6. checks the browser computes the reference race call bit for bit (tests/fixtures)
//   node tools/selftest-recording.mjs [--no-browser]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFeed, stateAt } from '../recorder.mjs';
import { compactFolder } from './compact-recordings.mjs';
import { goldenInput, compare as goldenCompare, compute as goldenRows, FILE as GOLDEN } from '../tests/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RS = '\x1e';
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

// ---------- A fake F1 feed ----------
let seq = 0;
const sockets = new Set();
const SESSION = { Key: 99901, Name: 'Selftest', Type: 'Race', StartDate: '2026-01-01T12:00:00', Meeting: { Name: 'Selftest GP', Location: 'Nowhere' } };
const drivers = ['1', '4', '16'];
const snapshot = () => ({ SessionInfo: SESSION, SessionStatus: { Status: 'Started' }, LapCount: { CurrentLap: seq, TotalLaps: 1e6 },
  DriverList: Object.fromEntries(drivers.map((n, i) => [n, { RacingNumber: n, Tla: ['VER', 'NOR', 'LEC'][i] }])),
  TimingData: { Lines: Object.fromEntries(drivers.map((n, i) => [n, { Position: String(i + 1), NumberOfLaps: seq }])) } });
function wsSend(sock, text) {
  const p = Buffer.from(text), n = p.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  try { sock.write(Buffer.concat([head, p])); } catch {}
}
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/signalrcore/negotiate')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ connectionToken: crypto.randomUUID(), negotiateVersion: 1 })); }
  res.writeHead(404); res.end();
});
fake.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128; if (buf.length < off + (masked ? 4 : 0) + len) break;
      const mask = masked ? buf.subarray(off, off + 4) : null; off += masked ? 4 : 0;
      const p = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) { sockets.delete(sock); sock.end(); return; }
      for (const m of p.toString().split(RS)) {
        if (m.includes('"protocol"')) wsSend(sock, '{}' + RS);
        if (m.includes('"Subscribe"')) { wsSend(sock, JSON.stringify({ type: 3, invocationId: '0', result: snapshot() }) + RS); sockets.add(sock); }
      }
    }
  });
  sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sockets.delete(sock));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const tick = setInterval(() => {
  seq++;
  const n = drivers[seq % 3];
  const msg = JSON.stringify({ type: 1, target: 'feed', arguments: ['LapCount', { CurrentLap: seq }, new Date().toISOString()] }) + RS
    + JSON.stringify({ type: 1, target: 'feed', arguments: ['TimingData', { Lines: { [n]: { NumberOfLaps: seq } } }, new Date().toISOString()] }) + RS;
  for (const s of sockets) wsSend(s, msg);
}, 50);

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
relay.kill('SIGKILL'); const killedAtSeq = seq; await new Promise(r => relay.on('exit', r));
await sleep(2000);
relay = startRelay();
await sleep(6000);
const h2 = await health(RPORT);
ok(h2?.recording?.dir === dir, 'after the crash it records into the same session folder');
relay.kill('SIGTERM'); await new Promise(r => relay.on('exit', r));
const lastSeq = seq;
clearInterval(tick);

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
