// Plays recorded or rebuilt sessions through the real relay and the real page (headless
// Chromium), and keeps everything the page predicted, stamped with the session time it was
// made at. Each session gets a fresh browser (no stored learning) and no shared learned files,
// so it knows only the code's starting values and what happened earlier in that session.
//
//   node tools/replay-eval.mjs --out=data/eval/base [--speed=25] [--jobs=4] data/replays/openf1-*
//
// Writes <out>/<session dir name>.jsonl (page records + feedT) and copies the outcome from meta.json.
// Candidate models: run with CANDIDATE=<name> to load models/candidates/<name>.js into the page
// before its own scripts run (see models/candidates/README.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const OUT = path.resolve(arg('out', 'data/eval/base')), SPEED = Number(arg('speed', 25)), JOBS = Number(arg('jobs', 4));
const dirs = process.argv.slice(2).filter(a => !a.startsWith('--')).map(d => path.resolve(d));
const CAND = process.env.CANDIDATE || '';
const candJs = CAND ? fs.readFileSync(path.join(ROOT, 'models', 'candidates', `${CAND}.js`), 'utf8') : '';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const channel = process.env.CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : '');
const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });

async function one(dir, port) {
  const name = path.basename(dir), out = path.join(OUT, `${name}.jsonl`);
  if (fs.existsSync(out) && fs.existsSync(path.join(OUT, `${name}.done`))) return 'cached';
  fs.rmSync(out, { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-eval-'));
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REPLAY: dir, SPEED: String(SPEED), REPLAY_WAIT: '1', REPLAY_OUT: out, PORT: String(port), KALSHI: '0', NO_LEARNED: '1', PITWALL_DATA: tmp, F1TV_TOKEN: '' } });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  const health = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; } };
  for (let i = 0; i < 300 && !(await health()); i++) await sleep(200); // up to 60 s on a busy machine
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  if (candJs) await page.addInitScript(candJs);
  const t0 = Date.now();
  try {
    await page.goto(`http://127.0.0.1:${port}/?mode=relay`, { waitUntil: 'load' });
    for (;;) { const h = await health(); if (h?.replay?.done) break; if (srv.exitCode != null) throw new Error('relay exited: ' + log.slice(-300)); await sleep(1000); }
    await sleep(2500); // the page posts its records every 500 ms
  } finally {
    await ctx.close(); srv.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true });
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, `${name}.meta.json`), JSON.stringify({ ...meta, eval: { speed: SPEED, candidate: CAND || null, wallS: (Date.now() - t0) / 1000, pageErrors: errors, at: new Date().toISOString() } }, null, 1));
  fs.writeFileSync(path.join(OUT, `${name}.done`), '');
  return `${((Date.now() - t0) / 1000).toFixed(0)} s${errors.length ? `, ${errors.length} page errors` : ''}`;
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, dirs.length) }, async (_, j) => {
  while (next < dirs.length) {
    const d = dirs[next++];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { const r = await one(d, 18900 + j); console.log(new Date().toISOString(), path.basename(d), r); break; }
      catch (e) { console.log(new Date().toISOString(), path.basename(d), attempt === 1 ? 'failed, retrying:' : 'FAILED:', e.message.split('\n')[0]); }
    }
  }
}));
await browser.close();
