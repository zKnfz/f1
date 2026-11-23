// Builds a replayable recording (data/rec format) from a lap-summary file (data/session-*.json),
// for sessions recorded before raw recording existed. Sector-level only: each sector time is
// sent when that sector ended (worked back from the lap's end time), no mini-sectors, no car
// positions, no clock. Good for testing the qualifying displays; not a substitute for a real
// recording when measuring accuracy.
//   node tools/laps-to-recording.mjs data/session-11416.json "Las Vegas Grand Prix" Qualifying [circuitKey]
import fs from 'node:fs';
import path from 'node:path';
const [file, meeting = 'Test GP', name = 'Qualifying', circuitKey = '0'] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const fmt = s => { const m = Math.floor(s / 60), r = (s - m * 60).toFixed(3).padStart(6, '0'); return `${m}:${r}`; };
const RS = '';
// Driver names from F1's current snapshot (the TLA and team colour for each number).
let drivers = {};
try {
  const neg = await fetch('https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1', { method: 'POST' });
  const cookie = (neg.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
  const { connectionToken } = await neg.json();
  const ws = new WebSocket(`wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie } });
  drivers = await new Promise((res, rej) => {
    setTimeout(() => rej(new Error('timeout')), 15000);
    ws.onopen = () => { ws.send('{"protocol":"json","version":1}\x1e'); ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [['DriverList']], invocationId: '0' }) + '\x1e'); };
    ws.onmessage = e => { for (const p of String(e.data).split('\x1e')) { try { const m = JSON.parse(p); if (m.type === 3) res(m.result.DriverList); } catch {} } };
  });
  ws.close();
} catch (e) { console.error('driver list unavailable, numbers only:', e.message); }

const ev = [];
const nums = Object.keys(d.laps);
for (const [n, laps] of Object.entries(d.laps)) for (const l of laps) {
  if (!l.s || l.s.some(x => !x) || !l.at) continue;
  const end = l.at, t2 = end - l.s[2] * 1000, t1 = t2 - l.s[1] * 1000;
  ev.push({ t: t1, n, part: l.part, u: { Sectors: { 0: { Value: l.s[0].toFixed(3) } } } });
  ev.push({ t: t2, n, part: l.part, u: { Sectors: { 1: { Value: l.s[1].toFixed(3) } } } });
  ev.push({ t: end, n, part: l.part, lap: l, u: { Sectors: { 2: { Value: l.s[2].toFixed(3) } }, LastLapTime: { Value: l.raw }, NumberOfLaps: l.lap } });
}
ev.sort((a, b) => a.t - b.t);
const t0 = ev[0].t - 60000;
const key = d.key;
const info = { Key: key, Name: name, Type: name, StartDate: new Date(t0).toISOString().slice(0, 19), Meeting: { Name: meeting, Circuit: { Key: Number(circuitKey) } } };
const lines = Object.fromEntries(nums.map((n, i) => [n, { RacingNumber: n, Position: String(i + 1), NumberOfLaps: 0, Sectors: { 0: { Value: '' }, 1: { Value: '' }, 2: { Value: '' } }, BestLapTime: { Value: '' }, LastLapTime: { Value: '' }, BestLapTimes: [{ Value: '' }, { Value: '' }, { Value: '' }], InPit: false }]));
const snap = { TimingStats: { Lines: Object.fromEntries(nums.map(n => [n, { BestSectors: [{ Value: '' }, { Value: '' }, { Value: '' }] }])) }, SessionInfo: info, SessionStatus: { Status: 'Started' }, DriverList: Object.fromEntries(nums.map(n => [n, drivers[n] || { RacingNumber: n, Tla: '#' + n }])), TimingData: { SessionPart: 1, NoEntries: [20, 15, 10], Lines: lines } };
const out = [];
const frame = (t, obj) => out.push(`${Math.round(t)}\t0\t1\t${JSON.stringify(obj)}`);
const feed = (t, topic, data) => frame(t, { type: 1, target: 'feed', arguments: [topic, data, new Date(t).toISOString()] });
frame(t0, { type: 3, invocationId: '0', result: snap });
let part = 1;
const best = {}, bestPart = {}, pbSec = {};
const later = p => new Set(ev.filter(e => e.part >= p).map(e => e.n));
for (const e of ev) {
  if (e.part !== part) {
    // A new part: drivers with no laps from here on are knocked out; best times start again.
    part = e.part;
    const stay = later(part), upd = {};
    for (const n of nums) if (!stay.has(n)) upd[n] = { KnockedOut: true };
    feed(e.t - 30000, 'TimingData', { SessionPart: part, Lines: upd });
  }
  const u = JSON.parse(JSON.stringify(e.u));
  if (e.lap) {
    const k = `${e.n}:${part}`, t = e.lap.time;
    if (!e.lap.pit && (e.lap.ts || '1') === '1' && (!bestPart[k] || t < bestPart[k])) {
      bestPart[k] = t;
      u.BestLapTimes = { [part - 1]: { Value: e.lap.raw } };
      if (!best[e.n] || t < best[e.n]) { best[e.n] = t; u.BestLapTime = { Value: e.lap.raw }; }
    }
  }
  feed(e.t, 'TimingData', { Lines: { [e.n]: u } });
  // Personal best sectors (TimingStats), as F1 sends them: the projection is measured against these.
  const bs = {};
  for (const [k, v] of Object.entries(e.u.Sectors)) { const x = Number(v.Value), key = `${e.n}:${k}`; if (x && (!pbSec[key] || x < pbSec[key])) { pbSec[key] = x; bs[k] = { Value: v.Value }; } }
  if (Object.keys(bs).length) feed(e.t + 1, 'TimingStats', { Lines: { [e.n]: { BestSectors: bs } } });
  // Into the pits at the end of this lap, out again after the recorded stop time.
  const stop = e.lap && (d.pits?.[e.n] || []).find(p => p.lap === e.lap.lap);
  if (stop) { feed(e.t + 2, 'TimingData', { Lines: { [e.n]: { InPit: true } } }); feed(e.t + stop.dur * 1000, 'TimingData', { Lines: { [e.n]: { InPit: false, PitOut: true } } }); }
}
feed(ev.at(-1).t + 60000, 'SessionStatus', { Status: 'Finished' });
const dir = path.join('data', 'rec', `synthetic-${key}`);
fs.mkdirSync(dir, { recursive: true });
out.sort((a, b) => Number(a.split('\t')[0]) - Number(b.split('\t')[0])); // pit exits were added ahead of time
fs.writeFileSync(path.join(dir, 'feed.tsv'), out.join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: { key, name, meeting }, synthetic: `from ${file}: sector level only` }, null, 1));
console.log(`${dir}: ${out.length} frames, ${((ev.at(-1).t - t0) / 60000).toFixed(0)} min`);
