// Records an F1 session for the site's self-tuning model.
//
// It serves this folder on a local port, opens the real page in a headless Chrome and
// leaves it open for the session. The page does all the learning exactly as it does in
// a person's browser. When the session is over, this script copies what the page learned
// out of the browser's storage into learned/*.json, which the site then loads for everyone.
//
// Usage: node tools/record.mjs [--wait=40] [--max=120] [--test]
//   --wait  minutes to wait for the session to start before giving up
//   --max   minutes to run at most
//   --test  open the page for a minute, write data/last-run.json and stop
// Needs playwright-core (npm install --no-save playwright-core) and Google Chrome.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'learned');
const PORT = 8799;
const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const TEST = process.argv.includes('--test');
const WAIT_MIN = arg('wait', 40), MAX_MIN = arg('max', 120);
const KEYS = /^pitwall-(model-v3-|calib-v1$|score-v1-)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- Static server for this folder ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel);
  // Only files inside this folder, and never the relay's API (so the page connects to F1 itself).
  if (!file.startsWith(ROOT + path.sep) || rel.startsWith('/api/') || rel.includes('/.')) { res.writeHead(404); return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// ---------- The page ----------
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => log('page error:', e.message));
const open = async () => {
  await page.goto(`http://127.0.0.1:${PORT}/?mode=direct`, { waitUntil: 'domcontentloaded' });
  await sleep(8000); // connect to the feed and take the first snapshot
};
// What the page currently knows. `state`, `hist` and the learning stores are the page's own.
const look = () => page.evaluate(() => {
  const size = k => { try { const d = JSON.parse(localStorage.getItem(k)); return d?.laps?.length ?? d?.laps ?? d?.pts?.length ?? 0; } catch { return 0; } };
  const keys = Object.keys(localStorage).filter(k => /^pitwall-(model-v3-|calib-v1$|score-v1-)/.test(k));
  return {
    feed: typeof feedStatus === 'undefined' ? null : feedStatus,
    meeting: state.SessionInfo?.Meeting?.Name ?? null,
    session: state.SessionInfo?.Name ?? null,
    sessionKey: state.SessionInfo?.Key ?? null,
    status: state.SessionStatus?.Status ?? null,
    drivers: Object.keys(state.TimingData?.Lines || {}).length,
    lapsRecorded: Object.values(hist.laps || {}).reduce((a, l) => a + l.length, 0),
    learned: Object.fromEntries(keys.map(k => [k, size(k)])),
  };
});

async function save(info, note) {
  await fs.mkdir(OUT, { recursive: true });
  let index = { files: {} };
  try { index = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')); } catch {}
  index.files ??= {};
  if (!TEST) {
    const dump = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
    for (const [key, text] of Object.entries(dump)) {
      if (!KEYS.test(key)) continue;
      let d; try { d = JSON.parse(text); } catch { continue; }
      const size = Array.isArray(d.laps) ? d.laps.length : d.laps ?? d.pts?.length ?? 0;
      // Never replace a file with one that has learned from less.
      if (!(size > (index.files[key] ?? 0))) continue;
      await fs.writeFile(path.join(OUT, `${key}.json`), JSON.stringify(d));
      index.files[key] = size;
      log(`saved ${key} (${size})`);
    }
    index.updated = new Date().toISOString();
    await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  }
  // A note about this run, kept out of git (data/ is ignored).
  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'data', 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), test: TEST, note, ...info }, null, 1));
}

let exitCode = 0;
try {
  await open();
  let info = await look();
  log('opened:', JSON.stringify(info));

  if (TEST) {
    await sleep(40000);
    info = await look();
    const ok = info.feed === 'live' && !!info.session;
    await save(info, ok ? 'test ok: the page connected to the F1 feed' : 'test failed: the page did not get data from the F1 feed');
    log(ok ? 'TEST OK' : 'TEST FAILED', JSON.stringify(info));
    if (!ok) exitCode = 1;
  } else {
    const t0 = Date.now(), mins = () => (Date.now() - t0) / 60000;
    const running = s => s === 'Started' || s === 'Aborted' || s === 'Finished'; // Finished also sits between qualifying parts
    const over = s => s === 'Finalised' || s === 'Ends';
    const firstKey = info.sessionKey, firstOver = over(info.status);
    let started = false, note = '';

    // Wait for the session to start. Until F1 switches its feed over, the page still shows
    // the previous session as over, so reload now and then to pick up the new one.
    let lastReload = Date.now();
    while (!started) {
      info = await look();
      const isNew = info.sessionKey !== firstKey || !firstOver;
      if (isNew && running(info.status)) { started = true; break; }
      if (mins() > WAIT_MIN) { note = 'the session did not start in time'; break; }
      if (Date.now() - lastReload > 4 * 60000) { await open(); lastReload = Date.now(); log('waiting:', info.session, info.status); }
      await sleep(15000);
    }

    if (started) {
      log('recording:', info.meeting, info.session);
      let lastLog = 0;
      while (true) {
        await sleep(20000);
        info = await look();
        if (Date.now() - lastLog > 5 * 60000) { lastLog = Date.now(); log('status:', info.status, 'laps:', info.lapsRecorded, 'feed:', info.feed, JSON.stringify(info.learned)); }
        if (over(info.status)) { note = 'session over'; break; }
        if (mins() > MAX_MIN) { note = 'stopped at the time limit'; break; }
      }
      // Let the page finish judging the last laps (it waits two minutes) and save.
      await sleep(150000);
      info = await look();
    }
    await save(info, note || 'nothing to record');
    log('done:', note, JSON.stringify(info));
  }
} catch (e) {
  log('failed:', e.stack || e.message);
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
process.exit(exitCode);
