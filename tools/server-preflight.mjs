// Checks, from this machine, everything the recorder needs. Run it on a new server before
// relying on it (F1 refuses some data-centre networks, e.g. GitHub's):
//   node tools/server-preflight.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const results = [];
const check = async (name, fn) => {
  const t0 = performance.now();
  try { const note = await fn(); results.push({ name, ok: true, note, ms: Math.round(performance.now() - t0) }); }
  catch (e) { results.push({ name, ok: false, note: e.message, ms: Math.round(performance.now() - t0) }); }
};
const UA = { 'User-Agent': 'pitwall-live-timing' };

await check('F1 live timing feed', async () => {
  const neg = await fetch('https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1', { method: 'POST', signal: AbortSignal.timeout(15000) });
  if (!neg.ok) throw new Error(`negotiate refused: HTTP ${neg.status} (F1 may block this network)`);
  const skew = Date.parse(neg.headers.get('date')) - Date.now();
  const cookie = (neg.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
  const { connectionToken } = await neg.json();
  const ws = new WebSocket(`wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie } });
  const snap = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connected but no snapshot within 15 s')), 15000);
    ws.onerror = () => { clearTimeout(t); rej(new Error('WebSocket refused (F1 may block this network)')); };
    ws.onopen = () => { ws.send('{"protocol":"json","version":1}\x1e'); ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [['SessionInfo', 'SessionStatus', 'Heartbeat']], invocationId: '0' }) + '\x1e'); };
    ws.onmessage = e => { for (const p of String(e.data).split('\x1e')) { try { const m = JSON.parse(p); if (m.type === 3) { clearTimeout(t); res(m.result); } } catch {} } };
  });
  ws.close();
  return `snapshot received: ${snap?.SessionInfo?.Meeting?.Name} ${snap?.SessionInfo?.Name} (${snap?.SessionStatus?.Status}); clock vs F1 ${skew >= 0 ? '+' : ''}${(skew / 1000).toFixed(1)} s (Date header, 1 s resolution)`;
});
await check('F1 TV sign-in on this machine', async () => {
  let tok = process.env.F1TV_TOKEN || '';
  if (!tok) try { tok = fs.readFileSync(path.join(DATA, 'f1tv-token.txt'), 'utf8').trim(); } catch { throw new Error(`none (${path.join(DATA, 'f1tv-token.txt')}); car positions/telemetry won't be recorded`); }
  try { tok = JSON.parse(decodeURIComponent(tok))?.data?.subscriptionToken || tok; } catch {}
  const exp = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).exp * 1000;
  if (exp < Date.now()) throw new Error('expired ' + new Date(exp).toISOString());
  return `present, runs out ${new Date(exp).toISOString()} (in ${((exp - Date.now()) / 3600e3).toFixed(0)} h)`;
});
await check('F1 calendar (Jolpica)', async () => {
  const r = await fetch('https://api.jolpi.ca/ergast/f1/current.json?limit=100', { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return `${(await r.json()).MRData.RaceTable.Races.length} races`;
});
await check('Kalshi public prices', async () => {
  const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXF1RACE&limit=1', { headers: { ...UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return 'reachable';
});
await check('headless browser', async () => {
  const { chromium } = await import('playwright-core');
  const channel = process.env.CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : '');
  const b = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
  const v = b.version(); await b.close();
  return `${channel || 'chromium'} ${v}`;
});
await check('disk space for recordings', async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const s = fs.statfsSync(DATA), gb = s.bavail * s.bsize / 1e9;
  if (gb < 5) throw new Error(`${gb.toFixed(1)} GB free`);
  return `${gb.toFixed(1)} GB free (a full session's size is not measured yet; check after Qatar FP1)`;
});
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.note} (${r.ms} ms)`);
process.exit(results.find(r => r.name.startsWith('F1 live') && !r.ok) ? 1 : 0);
