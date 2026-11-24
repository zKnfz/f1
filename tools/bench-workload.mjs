// Measures how well this machine runs the offline workloads (training, historical replays), so the
// Mac and the Oracle VM can be compared on the same numbers. Read-only for production: it writes
// only into a temporary folder and data/bench/, starts no service, and changes no setting.
//   nice -n 19 node tools/bench-workload.mjs [--replay=data/replays/openf1-9298] [--force] [--quick]
//
// What it measures:
//   host          arch, cores, memory, load, Node version
//   race call     the race simulator on a fixed input (tests/golden.mjs): ms per call on one core,
//                 and calls per second on every core at once (worker threads); answers are checked
//                 against the golden answer, so a different result on ARM shows up here
//   backtest      4 past races through tools/race-backtest.mjs (if data/races is there)
//   replay        one historical qualifying session through the real page at 40× (if present)
//   disk          256 MB written with fsync, then read back
//   network       OpenF1, Jolpica (both needed for history) and F1 live timing (expected refused
//                 from a datacenter)
//   interference  the local relay's /api/health response time while idle and during the replay
//                 (the relay is what serves live predictions; a slower answer = interference)
// Refuses to run during a race weekend (tools/train-window.mjs) unless --force.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkWindow } from './train-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = k => process.argv.includes(`--${k}`);
const QUICK = has('quick');
const RELAY = process.env.RELAY_URL || `http://127.0.0.1:${process.env.PORT || 8765}`;
const out = { at: new Date().toISOString(), host: {}, results: {} };
const say = (k, v) => { out.results[k] = v; console.log(k.padEnd(14), typeof v === 'string' ? v : JSON.stringify(v)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };

const w = await checkWindow();
if (!w.quiet && !has('force')) { console.log('Not now:', w.why, '(heavy work waits for a quiet spell; --force to override)'); process.exit(75); }

// ---- host ----
out.host = { name: os.hostname().split('.')[0], platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeGB: +(os.freemem() / 2 ** 30).toFixed(1), load: os.loadavg().map(x => +x.toFixed(2)), node: process.version };
console.log('host', JSON.stringify(out.host));
if (out.host.load[0] > out.host.cpus * 0.5) console.log(`note: the machine is busy (load ${out.host.load[0]} on ${out.host.cpus} cores); figures will be pessimistic`);

// ---- race call ----
const { goldenInput, compute, compare } = await import(path.join(ROOT, 'tests/golden.mjs'));
const RaceSim = createRequire(import.meta.url)(path.join(ROOT, 'racesim.js'));
const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/race-golden.json'), 'utf8'));
const same = compare(compute(), ref.rows);
const N = QUICK ? 5 : 20, times = [];
for (let i = 0; i < N; i++) { const t = performance.now(); RaceSim.run(RaceSim.build(goldenInput())); times.push(performance.now() - t); }
say('race call', { msPerCall: pct(times, 0.5), p90: pct(times, 0.9), sameAnswerAsGolden: same.same, goldenMadeOn: ref.madeOn });
// All cores at once: throughput (calls / s) and how well it scales.
const workerSrc = `const { parentPort, workerData } = require('node:worker_threads'); const R = require(workerData.sim); const g = require(workerData.inp);
  const end = Date.now() + workerData.ms; let n = 0; while (Date.now() < end) { R.run(R.build(g())); n++; } parentPort.postMessage(n);`;
const inpFile = path.join(os.tmpdir(), `pitwall-bench-input-${process.pid}.cjs`);
fs.writeFileSync(inpFile, `module.exports = ${goldenInput.toString()};`);
const par = async k => (await Promise.all(Array.from({ length: k }, () => new Promise((res, rej) => { const wk = new Worker(workerSrc, { eval: true, workerData: { sim: path.join(ROOT, 'racesim.js'), inp: inpFile, ms: QUICK ? 3000 : 8000 } }); wk.on('message', res); wk.on('error', rej); })))).reduce((a, b) => a + b, 0) / (QUICK ? 3 : 8);
const one = await par(1), all = await par(out.host.cpus);
fs.rmSync(inpFile, { force: true });
say('race call ×N', { cores: out.host.cpus, callsPerSecOneCore: +one.toFixed(2), callsPerSecAllCores: +all.toFixed(2), scaling: +(all / one).toFixed(2) });

// ---- interference probe (relay health latency) ----
const probe = async () => { const t = performance.now(); try { const r = await fetch(`${RELAY}/api/health`, { signal: AbortSignal.timeout(5000) }); await r.text(); return performance.now() - t; } catch { return null; } };
const relayUp = (await probe()) != null;
const sample = async (ms, into) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await probe(); if (v != null) into.push(v); await sleep(500); } };
const idle = [];
if (relayUp) await sample(QUICK ? 5000 : 15000, idle);

// ---- backtest ----
const run = (cmd, args, env = {}) => new Promise(res => { const t = Date.now(); const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('close', code => res({ code, s: (Date.now() - t) / 1000, tail: o.trim().split('\n').slice(-2).join(' | ') })); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-bench-'));
if (fs.existsSync(path.join(ROOT, 'data/races/2025-01.json'))) {
  const r = await run(process.execPath, ['tools/race-backtest.mjs', '--year=2025', '--quiet'], { ROUNDS: '2025:1-4', DUMP: path.join(tmp, 'dump.json') });
  say('backtest', { races: 4, seconds: +r.s.toFixed(1), ok: r.code === 0 });
} else say('backtest', 'skipped: no data/races (transfer it first, see docs/ORACLE-WORKLOADS.md)');

// ---- replay through the real page, with the relay probed meanwhile ----
const replay = path.resolve(ROOT, arg('replay') || 'data/replays/openf1-9298');
const busy = [];
if (fs.existsSync(path.join(replay, 'feed.tsv'))) {
  let done = false;
  const probing = (async () => { while (!done && relayUp) { const v = await probe(); if (v != null) busy.push(v); await sleep(500); } })();
  const r = await run(process.execPath, ['tools/replay-eval.mjs', `--out=${path.join(tmp, 'eval')}`, '--speed=40', '--jobs=1', `--port=${arg('port') || 19400}`, replay]);
  done = true; await probing;
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'eval', path.basename(replay) + '.meta.json'), 'utf8')); } catch { return null; } })();
  say('replay', { session: path.basename(replay), speed: 40, seconds: +r.s.toFixed(1), ok: r.code === 0 && !!meta, pageErrors: meta?.eval?.pageErrors?.length ?? null, ...(r.code ? { error: r.tail.slice(0, 200) } : {}) });
} else say('replay', `skipped: ${path.relative(ROOT, replay)} not found (transfer data/replays first)`);
if (relayUp) say('interference', { relay: RELAY, idleMs: { p50: pct(idle, 0.5), p95: pct(idle, 0.95), max: pct(idle, 1) }, duringReplayMs: busy.length ? { p50: pct(busy, 0.5), p95: pct(busy, 0.95), max: pct(busy, 1) } : null });
else say('interference', `no relay answering at ${RELAY} (nothing to interfere with, or set RELAY_URL)`);

// ---- disk ----
{
  const f = path.join(tmp, 'disk.bin'), MB = QUICK ? 64 : 256, buf = Buffer.alloc(1 << 20, 7);
  let t = performance.now(); const fd = fs.openSync(f, 'w'); for (let i = 0; i < MB; i++) fs.writeSync(fd, buf); fs.fsyncSync(fd); fs.closeSync(fd); const wS = (performance.now() - t) / 1000;
  t = performance.now(); fs.readFileSync(f); const rS = (performance.now() - t) / 1000;
  say('disk', { MB, writeMBs: +(MB / wS).toFixed(0), readMBs: +(MB / rS).toFixed(0), note: 'read may come from the page cache' });
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---- network (history sources must be reachable; F1 live timing is not needed for replays) ----
const net = {};
for (const [k, u] of [['openf1', 'https://api.openf1.org/v1/sessions?year=2023&session_name=Qualifying&country_name=Qatar'], ['jolpica', 'https://api.jolpi.ca/ergast/f1/2023/1.json'], ['f1-livetiming', 'https://livetiming.formula1.com/static/StreamingStatus.json']]) {
  const t = performance.now();
  try { const r = await fetch(u, { headers: { 'User-Agent': 'pitwall-live-timing (benchmark)' }, signal: AbortSignal.timeout(15000) }); const b = await r.arrayBuffer(); net[k] = { status: r.status, ms: Math.round(performance.now() - t), bytes: b.byteLength }; }
  catch (e) { net[k] = { error: String(e.cause?.code || e.message).slice(0, 60), ms: Math.round(performance.now() - t) }; }
}
say('network', net);

fs.mkdirSync(path.join(ROOT, 'data/bench'), { recursive: true });
const file = path.join(ROOT, 'data/bench', `${out.host.name}-${process.arch}-${out.at.slice(0, 16).replace(/[:T]/g, '')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log('\nsaved', path.relative(ROOT, file), '(no secrets, hostnames or addresses beyond the machine\'s short name)');
