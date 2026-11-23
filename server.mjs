// Pitwall live timing relay.
// Connects to Formula 1's public live timing feed (SignalR Core), keeps the
// merged state in memory, and streams it to the browser with Server-Sent Events.
// Run: node server.mjs   then open http://127.0.0.1:8765
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { startKalshi } from './kalshi.mjs';
import { createRecorder, readFeed, readJsonl } from './recorder.mjs';
import os from 'node:os';

// Replay: REPLAY=data/rec/<session folder> node server.mjs  plays a recording back to the page
// exactly as it arrived (SPEED=4 for 4x, FROM=600 to start 600 s in). Nothing is recorded or
// saved over real data while replaying.
const REPLAY = process.env.REPLAY || '';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const F1 = 'livetiming.formula1.com';
// F1_ORIGIN points the relay at a stand-in feed (tools/selftest-recording.mjs only).
const F1_HTTP = process.env.F1_ORIGIN || `https://${F1}`, F1_WS = F1_HTTP.replace(/^http/, 'ws');
// Where recordings, lap history and the F1 TV sign-in live (data/ next to this file by default).
const DATA_ROOT = path.resolve(process.env.PITWALL_DATA || path.join(DIR, 'data'));
const RS = '\x1e'; // SignalR record separator
const TOPICS = [
  'Heartbeat', 'SessionInfo', 'SessionData', 'SessionStatus', 'TrackStatus', 'LapCount',
  'ExtrapolatedClock', 'DriverList', 'TimingData', 'TimingAppData', 'TimingStats',
  'RaceControlMessages', 'WeatherData', 'TopThree', 'PitLaneTimeCollection',
  // Car GPS positions and telemetry (speed, throttle, brake). Compressed, and since 2025 only
  // sent to connections signed in with an F1 TV account (see f1tvToken below).
  'Position.z', 'CarData.z',
];

// Your own F1 TV sign-in, to unlock car positions and telemetry. Put it in the F1TV_TOKEN
// environment variable or in data/f1tv-token.txt (not committed). Either the token itself or
// the whole value of formula1.com's "login-session" cookie works. Without it everything else
// still works; positions are then estimated from the timing.
async function f1tvToken() {
  let raw = process.env.F1TV_TOKEN || '';
  if (!raw) try { raw = (await fs.readFile(path.join(DATA_ROOT, 'f1tv-token.txt'), 'utf8')).trim(); } catch {}
  return parseF1tv(raw);
}
export function parseF1tv(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;
  try { const j = JSON.parse(decodeURIComponent(raw)); return j?.data?.subscriptionToken || null; } catch {}
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw) ? raw : null;
}
// When the sign-in runs out (seconds since 1970), or null. Never exposes the token itself.
export function jwtExp(tok) {
  try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url')).exp || null; } catch { return null; }
}
// "Position.z" / "CarData.z" arrive as base64 of raw-deflated JSON.
function unz(b64) { try { return JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64'))); } catch { return null; } }
let teleSeen = 0;

let state = {};
let feedStatus = 'connecting';
const clients = new Set();

// Feed updates are partial objects. Arrays are patched with {"index": value}.
export function merge(target, src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src;
  if (target === null || typeof target !== 'object') target = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '_deleted') continue;
    target[k] = merge(target[k], v);
  }
  return target;
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
function setStatus(s) {
  feedStatus = s;
  broadcast('status', { status: s });
  console.log(new Date().toISOString(), 'feed:', s);
}

// ---------- F1 feed connection ----------
// Several connections race each other. F1's servers deliver the same update at
// slightly different times, so the relay forwards whichever copy arrives first.
const FEEDS = Math.max(1, Number(process.env.FEEDS) || 3);
const conns = [];
const seen = new Map(); // raw update text -> time first seen
setInterval(() => { const cut = Date.now() - 20000; for (const [k, t] of seen) if (t < cut) seen.delete(k); }, 5000);

function liveCount() { return conns.filter(c => c.live).length; }
function updateStatus() {
  const n = liveCount();
  const s = n ? 'live' : 'reconnecting';
  if (s !== feedStatus) setStatus(s);
}

async function connect(c) {
  c.live = false;
  let ws;
  try {
    const tok = await f1tvToken(), auth = tok ? { Authorization: `Bearer ${tok}` } : {};
    const neg = await fetch(`${F1_HTTP}/signalrcore/negotiate?negotiateVersion=1`, { method: 'POST', headers: auth });
    if (!neg.ok) throw new Error(`negotiate ${neg.status}`);
    const cookie = (neg.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
    const { connectionToken } = await neg.json();
    ws = c.ws = new WebSocket(`${F1_WS}/signalrcore?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie, ...auth } });
    if (c.id === 1) {
      const exp = tok && jwtExp(tok), left = exp ? (exp * 1000 - Date.now()) / 3600e3 : null;
      console.log(!tok ? 'No F1 TV sign-in: car positions will be estimated'
        : left != null && left <= 0 ? `F1 TV sign-in EXPIRED on ${new Date(exp * 1000).toString()}: renew data/f1tv-token.txt`
        : `F1 TV sign-in found${left != null ? ` (runs out in ${left.toFixed(0)} h)` : ''}: asking for car positions and telemetry`);
    }
  } catch (e) {
    console.error(`feed ${c.id} connect failed:`, e.message);
    rec.event('connectFailed', { conn: c.id, error: e.message });
    return reconnect(c);
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [TOPICS], invocationId: '0' }) + RS);
    clearInterval(c.ping);
    c.ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":6}' + RS), 15000);
  };
  ws.onmessage = e => {
    const now = Date.now(), parts = String(e.data).split(RS);
    for (const part of parts) if (part) handleFrame(c, part, now);
    // Recorded after the updates have gone out to the pages, so recording never delays them.
    for (const part of parts) if (part) rec.frame(c.id, part, now);
  };
  ws.onclose = () => { clearInterval(c.ping); c.live = false; rec.event('closed', { conn: c.id }); updateStatus(); reconnect(c); };
  ws.onerror = () => {};
}
let lastFrameAt = Date.now(), gapOpen = null;
function handleFrame(c, part, now) {
      let m;
      try { m = JSON.parse(part); } catch { return; }
      if (m.type === 1 && m.target === 'feed') {
        lastFrameAt = now; // for gap detection: data, not keep-alive pings
        // Live update: only the first copy across all connections counts.
        if (seen.has(part)) return;
        seen.set(part, now);
        const [topic, data, sentAt] = m.arguments;
        if (topic.endsWith('.z')) {
          // Positions and telemetry: decompressed here, sent on, never kept in the state.
          const d = unz(data);
          if (d) { broadcast('feed', [topic.slice(0, -2), d, sentAt]); if (!teleSeen++) console.log(new Date().toISOString(), `receiving ${topic.slice(0, -2)} (F1 TV sign-in works)`); }
          return;
        }
        broadcast('feed', [topic, data, sentAt]); // send first, store after
        state[topic] = merge(state[topic], data);
        afterFeed(topic, data);
      } else if (m.type === 3 && m.invocationId === '0') {
        if (m.error) { console.error('subscribe error:', m.error); return; }
        // Take the full snapshot only when no other connection is already live,
        // so a reconnecting feed never rolls the state back.
        if (!liveCount()) { state = m.result || {}; delete state['Position.z']; delete state['CarData.z']; broadcast('full', state); ensureHistory(); rec.open(state.SessionInfo); }
        else driftCheck(c, m.result || {});
        c.live = true; c.retry = 0;
        rec.event('live', { conn: c.id, live: liveCount() });
        console.log(new Date().toISOString(), `feed ${c.id}: live (${liveCount()}/${FEEDS})`);
        updateStatus();
      } else if (m.type === 7) {
        console.error(`feed ${c.id} closed by server:`, m.error);
        rec.event('serverClosed', { conn: c.id, error: m.error || null });
      }
}
// Missed updates: a connection that (re)subscribes while another is live gets F1's full
// snapshot. If that differs from the state built up from updates, some updates were lost.
function driftCheck(c, snap) {
  const diffs = [];
  const a = snap.TimingData?.Lines || {}, b = state.TimingData?.Lines || {};
  for (const n of Object.keys(a)) for (const k of ['Position', 'NumberOfLaps', 'InPit', 'Retired']) {
    const x = a[n]?.[k], y = b[n]?.[k];
    if (x !== undefined && String(x) !== String(y)) diffs.push(`${n}.${k}: snapshot ${x} vs ours ${y}`);
  }
  for (const [t, k] of [['LapCount', 'CurrentLap'], ['TrackStatus', 'Status'], ['SessionStatus', 'Status']])
    if (snap[t]?.[k] !== undefined && String(snap[t][k]) !== String(state[t]?.[k])) diffs.push(`${t}.${k}: snapshot ${snap[t][k]} vs ours ${state[t]?.[k]}`);
  // A difference can also be an update that is simply in flight; record it, don't overwrite.
  rec.event('driftCheck', { conn: c.id, differences: diffs.length, sample: diffs.slice(0, 10) });
  if (diffs.length) console.log(new Date().toISOString(), `feed ${c.id}: snapshot differs from our state in ${diffs.length} places`, diffs.slice(0, 3).join('; '));
}
// Gaps: no frame from any connection for 15 s while a session is running.
setInterval(() => {
  const running = /Started|Aborted/.test(state.SessionStatus?.Status || '');
  const quiet = Date.now() - lastFrameAt;
  if (!gapOpen && running && quiet > 15000) { gapOpen = lastFrameAt; rec.event('gap', { since: new Date(lastFrameAt).toISOString() }); console.log(new Date().toISOString(), 'feed: nothing received for 15 s'); }
  else if (gapOpen && quiet < 5000) { rec.event('gapEnd', { seconds: +((Date.now() - gapOpen) / 1000).toFixed(1) }); gapOpen = null; }
}, 2000).unref?.();
// Running all the time (a server): between sessions F1 sends nothing new, and an open
// connection may keep showing the old session. So once a session has been over for 15 minutes,
// or nothing has arrived for 10, reconnect every 10 minutes to pick up the next one, and pause
// recording (nothing useful to keep) until a session that isn't over appears.
let overSince = null, lastRefresh = Date.now();
const OVER = /Finalised|Ends/;
setInterval(() => {
  const now = Date.now();
  if (OVER.test(state.SessionStatus?.Status || '')) overSince ??= now; else overSince = null;
  rec.setIdle(!!overSince && now - overSince > 30 * 60000);
  const stale = (overSince && now - overSince > 15 * 60000) || now - lastFrameAt > 10 * 60000;
  if (!REPLAY && conns.length && stale && now - lastRefresh > 10 * 60000) {
    lastRefresh = now;
    console.log(new Date().toISOString(), 'feed: no session running, reconnecting to look for the next one');
    for (const c of conns) { c.live = false; c.retry = 0; try { c.ws?.close(); } catch {} }
  }
}, 30000).unref?.();
function reconnect(c) {
  const wait = Math.min(30000, 2000 * 2 ** c.retry++) + Math.random() * 1000;
  setTimeout(() => connect(c), wait);
}
function startFeeds() {
  setStatus('connecting');
  for (let i = 0; i < FEEDS; i++) { const c = { id: i + 1, retry: 0, live: false }; conns.push(c); connect(c); }
}

// ---------- Lap history ----------
// F1's archive needs a login, so the relay keeps its own record of every completed
// lap from the moment it starts. It is saved to data/ so a restart keeps it.
const DATA = REPLAY ? path.join(os.tmpdir(), 'pitwall-replay') : DATA_ROOT;
const rec = createRecorder({ dataDir: DATA_ROOT, enabled: !REPLAY });
let history = { key: null, laps: {}, pits: {} };
const watch = {}; // per driver: last recorded lap time, pit seen this lap, pending timer
let saveTimer = null;

const arr = x => Array.isArray(x) ? x : (x && typeof x === 'object')
  ? Object.keys(x).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => x[k]) : [];
function secs(v) {
  if (!v) return null;
  const p = String(v).split(':');
  const s = p.length > 1 ? Number(p[0]) * 60 + Number(p[1]) : Number(p[0]);
  return Number.isFinite(s) && s > 0 ? s : null;
}

async function ensureHistory() {
  const key = state.SessionInfo?.Key;
  if (!key || history.key === key) return;
  let loaded = null;
  try { loaded = JSON.parse(await fs.readFile(path.join(DATA, `session-${key}.json`), 'utf8')); } catch {}
  history = loaded?.key === key ? loaded : { key, laps: {}, pits: {} };
  for (const k in watch) delete watch[k];
  for (const [num, laps] of Object.entries(history.laps)) watch[num] = { last: laps.at(-1)?.raw, sawPit: false };
  console.log(`lap history for session ${key}: ${Object.values(history.laps).reduce((a, l) => a + l.length, 0)} laps loaded`);
  broadcast('history', history);
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.mkdir(DATA, { recursive: true });
      await fs.writeFile(path.join(DATA, `session-${history.key}.json`), JSON.stringify(history));
    } catch (e) { console.error('save failed:', e.message); }
  }, 3000);
}

function afterFeed(topic, data) {
  if (topic === 'SessionInfo') { rec.open(state.SessionInfo); return ensureHistory(); }
  if (!history.key) return;
  if (topic === 'TimingData') {
    for (const [num, u] of Object.entries(data?.Lines || {})) {
      const w = watch[num] ??= { last: null, sawPit: false };
      if (u.InPit === true || u.PitOut === true) w.sawPit = true;
      // Lap time, final sector and lap count arrive together at the line.
      // Wait a moment so the gap to the leader has updated too.
      if (u.LastLapTime?.Value) { clearTimeout(w.timer); w.timer = setTimeout(() => recordLap(num), 1000); }
    }
  } else if (topic === 'PitLaneTimeCollection') {
    for (const [num, p] of Object.entries(data?.PitTimes || {})) {
      if (!p?.Duration) continue;
      const list = history.pits[num] ??= [];
      const rec = { lap: Number(p.Lap) || null, dur: Number(p.Duration) };
      if (list.some(x => x.lap === rec.lap && x.dur === rec.dur)) continue;
      list.push(rec);
      broadcast('pit', [num, rec]);
      saveSoon();
    }
  }
}

function recordLap(num) {
  const line = state.TimingData?.Lines?.[num];
  const w = watch[num];
  const raw = line?.LastLapTime?.Value;
  if (!line || !raw || raw === w.last) return;
  w.last = raw;
  const stint = arr(state.TimingAppData?.Lines?.[num]?.Stints).at(-1) || {};
  const rec = {
    lap: Number(line.NumberOfLaps) || null,
    raw, time: secs(raw),
    s: arr(line.Sectors).map(x => secs(x?.Value || x?.PreviousValue)),
    v: ['I1', 'I2', 'FL', 'ST'].map(k => Number(line.Speeds?.[k]?.Value) || null), // speed traps
    c: stint.Compound || null, age: Number(stint.TotalLaps) || 0, stint: arr(state.TimingAppData?.Lines?.[num]?.Stints).length,
    pos: Number(line.Position) || null,
    gap: line.GapToLeader ?? null, int: line.IntervalToPositionAhead?.Value ?? null,
    pit: w.sawPit, ts: state.TrackStatus?.Status || '1', part: state.TimingData?.SessionPart || null,
    at: Date.now(),
  };
  w.sawPit = !!(line.InPit || line.PitOut);
  // A new lap time is always a new lap. F1's lap counter sometimes lags by one when the time
  // arrives, so never let a lap replace the one before it: number it after that one instead.
  const list = history.laps[num] ??= [];
  const prev = list.at(-1);
  if (rec.lap && prev?.lap && rec.lap <= prev.lap) rec.lap = prev.lap + 1;
  list.push(rec);
  broadcast('lap', [num, rec]);
  saveSoon();
}

// ---------- Circuit outline (cached) ----------
const circuits = new Map();
async function circuit(key, year) {
  const id = `${key}/${year}`;
  if (!circuits.has(id)) {
    const r = await fetch(`https://api.multiviewer.app/api/v1/circuits/${key}/${year}`, { headers: { 'User-Agent': 'pitwall-live-timing' } });
    if (!r.ok) throw new Error(`circuit ${r.status}`);
    const d = await r.json();
    circuits.set(id, { x: d.x, y: d.y, rotation: d.rotation, corners: d.corners, name: d.circuitName, pitLoss: d.pitLoss, marshalSectors: d.marshalSectors });
  }
  return circuits.get(id);
}

const kalshi = startKalshi({ getState: () => state, broadcast, dataDir: DATA, recDir: () => rec.dir(), enabled: !REPLAY && process.env.KALSHI !== '0' });

// ---------- HTTP ----------
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/sim': 'sim.html', '/sim.html': 'sim.html', '/engineer.js': 'engineer.js', '/direct.js': 'direct.js', '/rain.js': 'rain.js', '/racesim.js': 'racesim.js', '/alerts.js': 'alerts.js', '/kalshi-web.js': 'kalshi-web.js', '/racesim-worker.js': 'racesim-worker.js', '/latency.js': 'latency.js', '/pagelog.js': 'pagelog.js', '/lapstory.js': 'lapstory.js', '/models/registry.json': 'models/registry.json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.socket.setNoDelay(true); // send each update right away instead of batching small packets
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    clients.add(res);
    send(res, 'status', { status: feedStatus });
    if (Object.keys(state).length) send(res, 'full', state);
    if (history.key) send(res, 'history', history);
    send(res, 'kalshi', kalshi.prices());
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  if (url.pathname === '/api/record' && req.method === 'POST') { // predictions, alerts, model versions from the recorder's page
    let body = '';
    req.on('data', ch => { body += ch; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { try { for (const r of JSON.parse(body)) rec.page(r); } catch {} res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/api/health') { // for tools/health.mjs (server monitoring)
    let disk = null;
    try { const s = await fs.statfs(DATA_ROOT); disk = { freeGB: +(s.bavail * s.bsize / 1e9).toFixed(2), freePct: +(100 * s.bavail / s.blocks).toFixed(1) }; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, replay: !!REPLAY, feed: feedStatus, live: liveCount(), feeds: FEEDS,
      session: state.SessionInfo ? `${state.SessionInfo.Meeting?.Name} ${state.SessionInfo.Name}` : null, status: state.SessionStatus?.Status ?? null,
      lastDataAgoS: +((Date.now() - lastFrameAt) / 1000).toFixed(1), recording: rec.stats(), idle: rec.idle(),
      uptimeS: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1e6), disk,
    }));
  }
  if (url.pathname === '/api/recording') { // what is being recorded (for the recorder's status checks)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ replay: REPLAY || null, recording: rec.stats() }));
  }
  if (url.pathname === '/api/sitelog' && req.method === 'POST') { // the site's own figures, for the Kalshi replay
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => { try { kalshi.logSite(JSON.parse(body)); } catch {} res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === '/api/f1tv') { // only whether there is a sign-in and when it runs out
    const tok = await f1tvToken();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ signedIn: !!tok, exp: tok ? jwtExp(tok) : null }));
  }
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"relay":true}');
  }
  if (url.pathname === '/api/circuit') {
    try {
      const data = await circuit(Number(url.searchParams.get('key')), Number(url.searchParams.get('year')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502); return res.end(e.message);
    }
  }
  // Shared learning files (see tools/record.mjs).
  const lm = /^\/learned\/([\w.-]+\.json)$/.exec(url.pathname);
  if (lm) {
    try { const body = await fs.readFile(path.join(DIR, 'learned', lm[1])); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(body); }
    catch { res.writeHead(404); return res.end('not found'); }
  }
  const file = PAGES[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
  res.end(await fs.readFile(path.join(DIR, file)));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Pitwall live timing on http://127.0.0.1:${PORT}  (simulator: /sim)`);
  if (REPLAY) startReplay(); else startFeeds();
});

// A bug in one handler must not take the whole relay (and the recording) down.
process.on('uncaughtException', e => { console.error(new Date().toISOString(), 'error:', e.stack || e); rec.event('error', { error: String(e.message || e) }); });
process.on('unhandledRejection', e => { console.error(new Date().toISOString(), 'error:', e?.stack || e); rec.event('error', { error: String(e?.message || e) }); });
// Stop cleanly: note it in the recording and flush the files.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  rec.event('relayStop', { signal: sig });
  rec.close('relay stopped');
  setTimeout(() => process.exit(0), 300);
});

// ---------- Replay ----------
async function startReplay() {
  const dir = path.resolve(REPLAY), speed = Number(process.env.SPEED) || 1, from = (Number(process.env.FROM) || 0) * 1000;
  console.log(`replaying ${dir} at ${speed}x${from ? `, from ${from / 1000} s in` : ''}`);
  setStatus('connecting');
  // Connection events (a connection dropping) are part of what the relay knew, so replay them too.
  const events = readJsonl(dir, 'events.jsonl').filter(e => e.ev === 'closed');
  const kal = readJsonl(dir, 'kalshi.jsonl').filter(e => e.type === 'kalshi');
  const prices = {};
  const pseudo = {};
  const connOf = id => pseudo[id] ??= (conns.push({ id, retry: 0, live: false }), conns.at(-1));
  let t0 = null, wall0 = null, n = 0, ei = 0, ki = 0;
  for await (const { r, c, part } of readFeed(dir)) {
    t0 ??= r;
    const at = r - t0;
    if (at >= from) {
      wall0 ??= Date.now() - (at - from) / speed;
      const due = wall0 + (at - from) / speed - Date.now();
      if (due > 2) await new Promise(res => setTimeout(res, due));
    }
    while (ei < events.length && events[ei].r <= r) { const pc = pseudo[events[ei].conn]; if (pc) pc.live = false; ei++; }
    while (ki < kal.length && kal[ki].t <= r) { const k = kal[ki++]; Object.assign(prices[k.m] ??= {}, Object.fromEntries(Object.entries(k.p).map(([code, v]) => [code, Array.isArray(v) ? v : v.p]))); broadcast('kalshi', { at: Date.now(), prices, replay: true }); }
    handleFrame(connOf(c), part, Date.now());
    n++;
  }
  console.log(`replay finished: ${n} frames`);
}
