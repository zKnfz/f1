// Offline training / evaluation job, for the quiet time between race weekends. Every step is
// resumable (a step skips what it already did; an unfinished replay is simply replayed again), so
// an interrupted run picks up where it stopped. It never changes production: it writes only to
// data/ (data/train/ for results, data/eval/base for replays). Promoting a candidate stays a human
// decision (docs/QATAR-READINESS.md §4: held-out comparison first, never during a race weekend).
//
//   nice -n 19 node tools/train-job.mjs [--only=fetch,build,race,replay,score] [--dry-run]
//
// Steps:
//   fetch   new OpenF1 sessions (qualifying, races) and Jolpica races of this season (polite, resumable)
//   build   historical qualifying sessions not yet rebuilt into replayable recordings
//   race    race backtest of every season: production scores, and a calibration refit (candidate)
//   replay  every rebuilt qualifying session through the real page (cached per session)
//   score   qualifying scores and candidate fits from the replays
//
// Guard: before each step and every 30 s during it, tools/train-window.mjs is asked whether this
// is still a quiet spell. When a race weekend gets near, the running step is stopped and the job
// exits with 75 ("try later"); the systemd unit treats that as normal and does not restart.
// Settings (environment): TRAIN_JOBS (parallel replays, default 1), TRAIN_YEARS (default: this
// year), TRAIN_MARGIN_H (hours kept clear around a weekend, default 12).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkWindow } from './train-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
// The tools read and write the repo's data/ folder (on the server PITWALL_DATA is that same folder).
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'train');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const DRY = process.argv.includes('--dry-run');
const JOBS = Math.max(1, Number(process.env.TRAIN_JOBS || 1));
const YEARS = (process.env.TRAIN_YEARS || String(new Date().getUTCFullYear())).split(',');
fs.mkdirSync(OUT, { recursive: true });
try { os.setPriority(19); } catch {} // lowest CPU priority; children inherit it

const log = (...a) => { const l = `${new Date().toISOString()} ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'train.log'), l + '\n'); };
const stateFile = path.join(OUT, 'state.json');
const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { steps: {} }; } })();
const save = () => { if (!DRY) fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); };

// One job at a time (the timer and a manual run must not overlap).
const lock = path.join(OUT, 'lock');
try { const pid = +fs.readFileSync(lock, 'utf8'); process.kill(pid, 0); log(`another training job is running (pid ${pid}); leaving it`); process.exit(0); } catch {}
fs.writeFileSync(lock, String(process.pid));
const unlock = () => { try { if (+fs.readFileSync(lock, 'utf8') === process.pid) fs.rmSync(lock); } catch {} };
process.on('exit', unlock);

let child = null, stopping = null;
const stop = (why, code) => { stopping = { why, code }; if (child) child.kill('SIGTERM'); };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop(`stopped by ${sig}`, 143); setTimeout(() => process.exit(143), 15000).unref(); });

// TRAIN_IGNORE_CALENDAR=1 is for tests only (CI may run during a real race weekend).
async function quiet() { const w = process.env.TRAIN_IGNORE_CALENDAR === '1' ? { quiet: true, why: 'calendar ignored (test)' } : await checkWindow(); if (!w.quiet) stop(w.why, 75); return w; }
setInterval(() => { quiet().catch(() => {}); }, 30000).unref();

// Runs a tool; resolves with its exit code. Output goes to data/train/<step>.log.
function run(step, args, env = {}) {
  if (DRY) { log(`[dry-run] ${step}: node ${args.join(' ')}`); return Promise.resolve(0); }
  return new Promise(res => {
    const out = fs.openSync(path.join(OUT, `${step}.log`), 'a');
    child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
    child.on('close', code => { child = null; fs.closeSync(out); res(code ?? 1); });
  });
}
const listQuali = () => {
  const out = [];
  for (const y of fs.existsSync(path.join(DATA, 'openf1')) ? fs.readdirSync(path.join(DATA, 'openf1')).filter(y => /^\d{4}$/.test(y)) : []) for (const k of fs.readdirSync(path.join(DATA, 'openf1', y))) {
    try { const s = JSON.parse(fs.readFileSync(path.join(DATA, 'openf1', y, k, 'session.json'), 'utf8')); if (/Qualifying/.test(s.session_name) && Date.parse(s.date_end) < Date.now() - 2 * 3600e3) out.push({ key: k, dir: path.join(DATA, 'openf1', y, k) }); } catch {}
  }
  return out;
};

const STEPS = {
  async fetch() {
    let bad = 0;
    for (const y of YEARS) {
      bad += (await run('fetch', ['tools/fetch-openf1.mjs', y])) ? 1 : 0;
      if (stopping) return 1;
      bad += (await run('fetch', ['tools/fetch-races.mjs', y])) ? 1 : 0;
      if (stopping) return 1;
    }
    // A source being down is not fatal: the other steps work on what is already here.
    if (bad) log('fetch: a source failed (see data/train/fetch.log); carrying on with the data already here');
    return 0;
  },
  async build() {
    // meta.json is written after feed.tsv, so it marks a finished rebuild (a killed one is redone).
    // A session OpenF1 has no usable data for (e.g. 2025 Baku: no laps) is noted and not retried.
    const failed = new Set(state.buildFailed || []);
    const todo = listQuali().filter(s => !failed.has(s.key) && !fs.existsSync(path.join(DATA, 'replays', `openf1-${s.key}`, 'meta.json')));
    log(`build: ${todo.length} sessions to rebuild`);
    for (const s of todo) {
      if (stopping) return 1;
      if (await run('build', ['tools/openf1-to-recording.mjs', s.dir]) && !DRY) { failed.add(s.key); log(`build: ${s.key} could not be rebuilt (see data/train/build.log); not retried`); }
    }
    state.buildFailed = [...failed];
    return 0;
  },
  async race() {
    if (!fs.existsSync(path.join(DATA, 'races'))) { log('race: no data/races yet (fetch or transfer it first)'); return 0; }
    const years = fs.readdirSync(path.join(DATA, 'races')).map(f => f.slice(0, 4)).filter((y, i, a) => a.indexOf(y) === i).join(',');
    let c = await run('race', ['tools/race-backtest.mjs', `--year=${years}`, '--quiet'], { DUMP: path.join(OUT, 'race-dump.json'), PACE_DUMP: path.join(OUT, 'race-pace.json') });
    if (c || stopping) return c || 1;
    c = await run('race', ['tools/score-race.mjs', path.join(OUT, 'race-dump.json'), `--pace=${path.join(OUT, 'race-pace.json')}`, `--json=${path.join(OUT, 'race-score.json')}`]);
    if (c || stopping) return c || 1;
    c = await run('race', ['tools/race-backtest.mjs', `--year=${years}`, '--quiet', '--set=cal=0,temp=1'], { DUMP: path.join(OUT, 'race-raw.json') });
    if (c || stopping) return c || 1;
    if (DRY) return 0;
    // Qatar is never fitted on (kept clean for judging); the refit is a candidate only.
    const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'race-raw.json'), 'utf8')).filter(r => !/Qatar/.test(r.race));
    fs.writeFileSync(path.join(OUT, 'race-raw-fit.json'), JSON.stringify(raw));
    return run('race', ['tools/race-calibrate.mjs', path.join(OUT, 'race-raw-fit.json')], { CAL_OUT: path.join(OUT, 'race-cal-candidate.json') });
  },
  async replay() {
    const dirs = fs.existsSync(path.join(DATA, 'replays')) ? fs.readdirSync(path.join(DATA, 'replays')).filter(d => d.startsWith('openf1-')).map(d => path.join(DATA, 'replays', d)).sort() : [];
    log(`replay: ${dirs.length} sessions (finished ones are skipped)`);
    return dirs.length ? run('replay', ['tools/replay-eval.mjs', `--out=${path.join(DATA, 'eval', 'base')}`, '--speed=10', `--jobs=${JOBS}`, '--port=18900', ...dirs]) : 0;
  },
  async score() {
    const ev = path.join(DATA, 'eval', 'base');
    if (!fs.existsSync(ev)) return 0;
    const c = await run('score', ['tools/score-quali.mjs', ev, `--json=${path.join(OUT, 'quali-score.json')}`]);
    if (c || stopping) return c || 1;
    return run('score', ['tools/fit-quali.mjs', ev, `--json=${path.join(OUT, 'quali-fit.json')}`], { CAND_DIR: path.join(OUT, 'candidates') });
  },
};

const w = await quiet();
log(`training job start (${os.hostname().split('.')[0]}, ${os.cpus().length} cores, ${JOBS} replay job(s)): ${w.why}`);
if (stopping) { log('not starting:', stopping.why); process.exit(stopping.code); }
for (const [name, fn] of Object.entries(STEPS)) {
  if (only && !only.includes(name)) continue;
  await quiet();
  if (stopping) break;
  const t = Date.now();
  log(`step ${name}`);
  let code;
  try { code = await fn(); } catch (e) { log(`step ${name} error: ${e.message}`); code = 1; }
  if (stopping) { log(`step ${name} interrupted: ${stopping.why} (it resumes on the next run)`); break; }
  state.steps[name] = { at: new Date().toISOString(), ok: code === 0, seconds: Math.round((Date.now() - t) / 1000) };
  save();
  log(`step ${name} ${code === 0 ? 'done' : `FAILED (exit ${code}, see data/train/${name}.log)`} in ${state.steps[name].seconds} s`);
  if (code !== 0) { unlock(); process.exit(1); } // systemd retries later; finished steps are skipped by their own caches
}
if (stopping) { log('training job paused:', stopping.why); process.exit(stopping.code); }
state.lastComplete = new Date().toISOString(); save();
log('training job complete; results in', path.relative(ROOT, OUT), '(candidates are never promoted automatically)');
process.exit(0);
