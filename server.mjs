// Pitwall live timing relay.
// Connects to Formula 1's public live timing feed (SignalR Core), keeps the
// merged state in memory, and streams it to the browser with Server-Sent Events.
// Run: node server.mjs   then open http://127.0.0.1:8765
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const F1 = 'livetiming.formula1.com';
const RS = '\x1e'; // SignalR record separator
const TOPICS = [
  'Heartbeat', 'SessionInfo', 'SessionData', 'SessionStatus', 'TrackStatus', 'LapCount',
  'ExtrapolatedClock', 'DriverList', 'TimingData', 'TimingAppData', 'TimingStats',
  'RaceControlMessages', 'WeatherData', 'TopThree', 'PitLaneTimeCollection',
];

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
    const neg = await fetch(`https://${F1}/signalrcore/negotiate?negotiateVersion=1`, { method: 'POST' });
    if (!neg.ok) throw new Error(`negotiate ${neg.status}`);
    const cookie = (neg.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
    const { connectionToken } = await neg.json();
    ws = c.ws = new WebSocket(`wss://${F1}/signalrcore?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie } });
  } catch (e) {
    console.error(`feed ${c.id} connect failed:`, e.message);
    return reconnect(c);
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [TOPICS], invocationId: '0' }) + RS);
    clearInterval(c.ping);
    c.ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":6}' + RS), 15000);
  };
  ws.onmessage = e => {
    const now = Date.now();
    for (const part of String(e.data).split(RS)) {
      if (!part) continue;
      let m;
      try { m = JSON.parse(part); } catch { continue; }
      if (m.type === 1 && m.target === 'feed') {
        // Live update: only the first copy across all connections counts.
        if (seen.has(part)) continue;
        seen.set(part, now);
        const [topic, data, sentAt] = m.arguments;
        broadcast('feed', [topic, data, sentAt]); // send first, store after
        state[topic] = merge(state[topic], data);
        afterFeed(topic, data);
      } else if (m.type === 3 && m.invocationId === '0') {
        if (m.error) { console.error('subscribe error:', m.error); continue; }
        // Take the full snapshot only when no other connection is already live,
        // so a reconnecting feed never rolls the state back.
        if (!liveCount()) { state = m.result || {}; broadcast('full', state); ensureHistory(); }
        c.live = true; c.retry = 0;
        console.log(new Date().toISOString(), `feed ${c.id}: live (${liveCount()}/${FEEDS})`);
        updateStatus();
      } else if (m.type === 7) {
        console.error(`feed ${c.id} closed by server:`, m.error);
      }
    }
  };
  ws.onclose = () => { clearInterval(c.ping); c.live = false; updateStatus(); reconnect(c); };
  ws.onerror = () => {};
}
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
const DATA = path.join(DIR, 'data');
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
  if (topic === 'SessionInfo') return ensureHistory();
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
    c: stint.Compound || null, age: Number(stint.TotalLaps) || 0, stint: arr(state.TimingAppData?.Lines?.[num]?.Stints).length,
    pos: Number(line.Position) || null,
    gap: line.GapToLeader ?? null, int: line.IntervalToPositionAhead?.Value ?? null,
    pit: w.sawPit, ts: state.TrackStatus?.Status || '1', part: state.TimingData?.SessionPart || null,
    at: Date.now(),
  };
  w.sawPit = !!(line.InPit || line.PitOut);
  const list = history.laps[num] ??= [];
  if (rec.lap && list.at(-1)?.lap === rec.lap) list[list.length - 1] = rec; else list.push(rec);
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
    circuits.set(id, { x: d.x, y: d.y, rotation: d.rotation, corners: d.corners, name: d.circuitName, pitLoss: d.pitLoss });
  }
  return circuits.get(id);
}

// ---------- HTTP ----------
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/sim': 'sim.html', '/sim.html': 'sim.html', '/engineer.js': 'engineer.js', '/direct.js': 'direct.js' };
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
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
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
  const file = PAGES[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  res.end(await fs.readFile(path.join(DIR, file)));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Pitwall live timing on http://127.0.0.1:${PORT}  (simulator: /sim)`);
  startFeeds();
});
