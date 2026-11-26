// Measures how well this machine runs the offline workloads (training, historical replays), so the
// Mac and the Oracle VM can be compared on the same numbers. Read-only for production: it writes
// only into a temporary folder and data/bench/, starts no service, and changes no setting.
//   nice -n 19 node tools/bench-workload.mjs [--replay=data/replays/openf1-9215] [--force] [--quick]
//     [--guard [--max-p95=50] [--min-free-gb=2] [--deadline=ISO]] [--expect=lapEnd:N,proj:M]
//   --guard stops the heavy part at once (exit 3) if the relay slows past --max-p95 ms, free
//   memory falls below --min-free-gb, a production unit restarts, ingest stops answering, or the
//   deadline passes. On the server run it inside the training unit's limits (docs/ORACLE-WORKLOADS.md).
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
import { spawn, execFileSync } from 'node:child_process';
import { ALWAYS_ON, SCHEDULED, PROPS, parseShow, unitProblem } from './bench-guard.mjs';
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

// ---- interference probes ----
// health: /api/health round trip. stream: a fresh connection to the relay's live stream
// (/events) until its first full-state message arrives, i.e. the path that forwards the feed
// to every page (serialise the state, write it to a socket). Both are what a slowed relay
// would show; a live session's forwarding itself can only be timed during a session (and heavy
// work never runs during one: tools/train-window.mjs).
const probe = async () => { const t = performance.now(); try { const r = await fetch(`${RELAY}/api/health`, { signal: AbortSignal.timeout(5000) }); await r.text(); return performance.now() - t; } catch { return null; } };
const streamProbe = async () => {
  const t = performance.now(), ac = new AbortController(); const to = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(`${RELAY}/events`, { signal: ac.signal }); const rd = r.body.getReader(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) return null; buf += Buffer.from(value).toString(); if (/event: (full|history|kalshi)/.test(buf)) { const ms = performance.now() - t; ac.abort(); return ms; } }
  } catch { return null; } finally { clearTimeout(to); }
};
const relayUp = (await probe()) != null;
const idle = { health: [], stream: [] }, busy = { health: [], stream: [] };
const sample = async (into, stop) => { while (!stop()) { const h = await probe(); if (h != null) into.health.push(h); const s = await streamProbe(); if (s != null) into.stream.push(s); await sleep(1000); } };
if (relayUp) { const end = Date.now() + (QUICK ? 6000 : 20000); await sample(idle, () => Date.now() > end); }
const stat = a => a.length ? { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: pct(a, 1) } : null;

// ---- guard (--guard): abort the heavy part at once if production could be affected ----
const GUARD = has('guard'), P95_MAX = Number(arg('max-p95') || 50), MIN_FREE_GB = Number(arg('min-free-gb') || 2);
const DEADLINE = arg('deadline') ? Date.parse(arg('deadline')) : null;
const shx = (...a) => { try { return execFileSync(a[0], a.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); } catch { return null; } };
const memAvailGB = () => {
  try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); if (m) return +m[1] / 2 ** 20; } catch {}
  // macOS: free + inactive + speculative + purgeable pages (what can be had without swapping).
  try { const v = execFileSync('vm_stat', { encoding: 'utf8' }); const pg = +v.match(/page size of (\d+)/)[1], n = k => +(v.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] || 0); return (n('free') + n('inactive') + n('speculative') + n('purgeable')) * pg / 2 ** 30; } catch {}
  return os.freemem() / 2 ** 30;
};
const unitStamp = () => process.platform === 'linux' ? Object.fromEntries([...ALWAYS_ON, ...SCHEDULED].map(u => {
  const v = shx('systemctl', 'show', '-p', PROPS.join(','), u); if (v == null) return [u, null];
  return [u, parseShow(v)];
})) : null;
const units0 = unitStamp();
const ingestOk = async () => { try { return (await fetch('http://127.0.0.1:8770/healthz', { signal: AbortSignal.timeout(3000) })).ok; } catch { return null; } };
const ingest0 = await ingestOk();
const memSeen = [];
let abortWhy = null;
function guardCheck() {
  if (!GUARD) return null;
  const free = memAvailGB(); memSeen.push(free);
  if (free < MIN_FREE_GB) return `available memory ${free.toFixed(2)} GB < ${MIN_FREE_GB} GB`;
  const recent = a => a.slice(-30);
  for (const k of ['health', 'stream']) { const r = recent(busy[k]); if (r.length >= 10 && pct(r, 0.95) > P95_MAX) return `relay ${k} p95 ${pct(r, 0.95)} ms > ${P95_MAX} ms`; }
  const u = unitStamp(); if (u && units0) { const why = unitProblem(units0, u); if (why) return `production unit: ${why}`; }
  if (DEADLINE && Date.now() > DEADLINE) return `deadline ${new Date(DEADLINE).toISOString()} reached`;
  return null;
}
if (GUARD) {
  console.log(`guard: abort if relay p95 > ${P95_MAX} ms, available memory < ${MIN_FREE_GB} GB, a production unit restarts, ingest stops answering${DEADLINE ? `, or at ${new Date(DEADLINE).toISOString()}` : ''}`);
  if (relayUp && (pct(idle.health, 0.95) > P95_MAX || pct(idle.stream, 0.95) > P95_MAX)) { abortWhy = `relay already slow before starting (health p95 ${pct(idle.health, 0.95)} ms, stream p95 ${pct(idle.stream, 0.95)} ms)`; }
  if (units0) for (const [n, v] of Object.entries(units0)) if (v?.ActiveState === 'failed' || (v?.Result && v.Result !== 'success')) console.log(`note: ${n} was already ${v.ActiveState} (Result ${v.Result}) before the benchmark`);
  if (memAvailGB() < MIN_FREE_GB + 1) abortWhy ??= `only ${memAvailGB().toFixed(2)} GB available before starting`;
}

// ---- backtest ----
const run = (cmd, args, env = {}, onTick) => new Promise(res => {
  const t = Date.now(); const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let o = '';
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
  const iv = onTick ? setInterval(async () => { const why = await onTick(); if (why && !abortWhy) { abortWhy = why; p.kill('SIGTERM'); } }, 2000) : null;
  p.on('close', code => { if (iv) clearInterval(iv); res({ code, s: (Date.now() - t) / 1000, tail: o.trim().split('\n').slice(-2).join(' | ') }); });
});
const tick = async () => { const g = guardCheck(); if (g) return g; if (GUARD && ingest0 && !(await ingestOk())) return 'ingest stopped answering'; return null; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-bench-'));
if (abortWhy) say('backtest', 'skipped: ' + abortWhy);
else if (fs.existsSync(path.join(ROOT, 'data/races/2025-01.json'))) {
  const r = await run(process.execPath, ['tools/race-backtest.mjs', '--year=2025', '--quiet'], { ROUNDS: '2025:1-4', DUMP: path.join(tmp, 'dump.json') }, tick);
  say('backtest', { races: 4, seconds: +r.s.toFixed(1), ok: r.code === 0 && !abortWhy });
} else say('backtest', 'skipped: no data/races (transfer it first, see docs/ORACLE-WORKLOADS.md)');

// ---- replay through the real page, with the relay probed meanwhile ----
const replay = path.resolve(ROOT, arg('replay') || 'data/replays/openf1-9215');
if (abortWhy) say('replay', 'skipped: ' + abortWhy);
else if (fs.existsSync(path.join(replay, 'feed.tsv'))) {
  let done = false;
  const probing = relayUp ? sample(busy, () => done) : Promise.resolve();
  const r = await run(process.execPath, ['tools/replay-eval.mjs', `--out=${path.join(tmp, 'eval')}`, '--speed=40', '--jobs=1', `--port=${arg('port') || 19400}`, replay], {}, tick);
  done = true; await probing;
  const name = path.basename(replay);
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'eval', name + '.meta.json'), 'utf8')); } catch { return null; } })();
  // Completeness: records by kind, against the session's real laps (OpenF1) and, if given, the
  // counts another machine produced for the same session (--expect=lapEnd:N,proj:M).
  const recs = (() => { try { return fs.readFileSync(path.join(tmp, 'eval', name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
  const kinds = {}; for (const x of recs) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const key = name.replace('openf1-', '');
  let realLaps = null; for (const y of fs.existsSync(path.join(ROOT, 'data/openf1')) ? fs.readdirSync(path.join(ROOT, 'data/openf1')) : []) { const f = path.join(ROOT, 'data/openf1', y, key, 'laps.json'); if (fs.existsSync(f)) realLaps = JSON.parse(fs.readFileSync(f, 'utf8')).filter(l => l.lap_duration).length; }
  const expect = Object.fromEntries((arg('expect') || '').split(',').filter(Boolean).map(x => x.split(':')).map(([k, v]) => [k, +v]));
  const mismatch = Object.entries(expect).filter(([k, v]) => (kinds[k] || 0) !== v).map(([k, v]) => `${k} ${kinds[k] || 0} (expected ${v})`);
  const feedS = (() => { try { const ls = fs.readFileSync(path.join(replay, 'feed.tsv'), 'utf8').trim().split('\n'); return (+ls.at(-1).split('\t')[0] - +ls[0].split('\t')[0]) / 1000; } catch { return null; } })();
  say('replay', { session: name, speed: 40, seconds: +r.s.toFixed(1), feedMinutes: feedS && +(feedS / 60).toFixed(1), throughput: feedS ? `${(feedS / r.s).toFixed(1)}× real time` : null, ok: r.code === 0 && !!meta && !abortWhy, pageErrors: meta?.eval?.pageErrors?.length ?? null, ...(r.code && !abortWhy ? { error: r.tail.slice(0, 200) } : {}) });
  say('records', { byKind: kinds, timedLapsInSession: realLaps, lapEndVsTimedLaps: realLaps ? +((kinds.lapEnd || 0) / realLaps).toFixed(3) : null, complete: !!(kinds.lapEnd && kinds.proj && kinds.pole) && !mismatch.length, ...(mismatch.length ? { mismatch } : {}) });
} else say('replay', `skipped: ${path.relative(ROOT, replay)} not found (transfer data/replays first)`);
if (relayUp) say('interference', { relay: RELAY, idle: { healthMs: stat(idle.health), streamMs: stat(idle.stream) }, duringWork: { healthMs: stat(busy.health), streamMs: stat(busy.stream) } });
else say('interference', `no relay answering at ${RELAY} (nothing to interfere with, or set RELAY_URL)`);
// Resources this benchmark used (Linux: its own cgroup, i.e. the systemd-run unit's limits).
{
  const res = { minAvailableGB: memSeen.length ? +Math.min(...memSeen).toFixed(2) : +memAvailGB().toFixed(2) };
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m)?.[1];
    if (cg) {
      const base = path.join('/sys/fs/cgroup', cg), rd = f => { try { return fs.readFileSync(path.join(base, f), 'utf8').trim(); } catch { return null; } };
      const peak = rd('memory.peak'), cpu = rd('cpu.stat')?.match(/usage_usec (\d+)/)?.[1];
      Object.assign(res, { cgroup: cg, memoryPeakGB: peak ? +(+peak / 2 ** 30).toFixed(2) : null, cpuSeconds: cpu ? +(+cpu / 1e6).toFixed(1) : null, cpuMax: rd('cpu.max'), memoryMax: rd('memory.max') });
    }
  } catch {}
  res.cpuUtilisation = res.cpuSeconds ? `${(100 * res.cpuSeconds / ((Date.now() - Date.parse(out.at)) / 1000)).toFixed(0)}% of one core over the run` : null;
  say('resources', res);
}
if (abortWhy) say('ABORTED', abortWhy);
// ---- disk ----
if (!abortWhy) {
  const f = path.join(tmp, 'disk.bin'), MB = QUICK ? 64 : 256, buf = Buffer.alloc(1 << 20, 7);
  let t = performance.now(); const fd = fs.openSync(f, 'w'); for (let i = 0; i < MB; i++) fs.writeSync(fd, buf); fs.fsyncSync(fd); fs.closeSync(fd); const wS = (performance.now() - t) / 1000;
  t = performance.now(); fs.readFileSync(f); const rS = (performance.now() - t) / 1000;
  say('disk', { MB, writeMBs: +(MB / wS).toFixed(0), readMBs: +(MB / rS).toFixed(0), note: 'read may come from the page cache' });
}
try { const st = fs.statfsSync(ROOT), du = shx('du', '-sk', path.join(ROOT, 'data')); say('storage', { dataGB: du ? +(+du.split(/\s/)[0] / 2 ** 20).toFixed(2) : null, freeGB: +(st.bavail * st.bsize / 2 ** 30).toFixed(1), evalOutputMB: +(+(shx('du', '-sk', tmp)?.split(/\s/)[0] || 0) / 1024).toFixed(1) }); } catch {}
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
process.exitCode = abortWhy ? 3 : 0;
