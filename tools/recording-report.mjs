// Checks a recording for completeness and problems.
//   node tools/recording-report.mjs                 the most recent recording
//   node tools/recording-report.mjs data/rec/<dir>  a given one
// Reports: duration, frames per connection, duplicates, F1 send → receive delay, the longest
// silences while the session was running, disconnects, missed-update checks, laps seen per driver
// against F1's own lap count, the site's records (page.jsonl) and Kalshi coverage.
import fs from 'node:fs';
import path from 'node:path';
import { readFeed, readJsonl, stateAt } from '../recorder.mjs';

const root = path.resolve('data/rec');
let dir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!dir) {
  const all = fs.existsSync(root) ? fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.existsSync(path.join(d, 'meta.json'))) : [];
  dir = all.sort((a, b) => fs.statSync(path.join(b, 'meta.json')).mtimeMs - fs.statSync(path.join(a, 'meta.json')).mtimeMs)[0];
}
if (!dir) { console.log('No recordings in data/rec yet.'); process.exit(1); }
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };
const fmtS = ms => ms == null ? '–' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;

const per = {}, topics = {}, delays = [], seen = new Set();
let first = null, last = null, frames = 0, unique = 0, dup = 0, bad = 0, snaps = 0, status = null;
const silences = []; let lastData = null; const lapEnds = {}; let base = null; // laps already done when recording began
for await (const f of readFeed(dir)) {
  frames++; first ??= f.r; last = f.r;
  const p = per[f.c] ??= { frames: 0, data: 0, first: 0 };
  p.frames++;
  let m; try { m = JSON.parse(f.part); } catch { bad++; continue; }
  if (m.type === 3) { snaps++; if (!base) { base = {}; for (const [n, L] of Object.entries(m.result?.TimingData?.Lines || {})) base[n] = +L.NumberOfLaps || 0; } continue; }
  if (!(m.type === 1 && m.target === 'feed')) continue;
  p.data++;
  if (seen.has(f.part)) { dup++; continue; }
  seen.add(f.part); unique++; p.first++;
  const [topic, data, sentAt] = m.arguments;
  topics[topic] = (topics[topic] || 0) + 1;
  const t = Date.parse(String(sentAt).replace(/(\.\d{3})\d+/, '$1'));
  if (isFinite(t)) delays.push(f.r - t);
  if (topic === 'SessionStatus' && data?.Status) status = data.Status;
  if (lastData != null && /Started|Aborted/.test(status || '')) silences.push({ ms: f.r - lastData, at: new Date(lastData).toISOString() });
  lastData = f.r;
  if (topic === 'TimingData') for (const [n, u] of Object.entries(data?.Lines || {})) if (u?.LastLapTime?.Value) lapEnds[n] = (lapEnds[n] || 0) + 1;
}
const ev = readJsonl(dir, 'events.jsonl');
const count = k => ev.filter(e => e.ev === k).length;
const drift = ev.filter(e => e.ev === 'driftCheck');
// A collector's page (page.jsonl) and/or the backend's (backend-page.jsonl); Kalshi likewise.
const page = [...readJsonl(dir, 'page.jsonl'), ...readJsonl(dir, 'backend-page.jsonl')];
const kal = [...readJsonl(dir, 'kalshi.jsonl'), ...readJsonl(dir, 'backend-kalshi.jsonl')].filter(k => k.type === 'kalshi').sort((a, b) => a.t - b.t);
const ingest = readJsonl(dir, 'ingest.jsonl');
const { state } = await stateAt(dir);

console.log(`Recording ${path.relative(process.cwd(), dir)}`);
console.log(`  ${new Date(first).toISOString()} → ${new Date(last).toISOString()} (${fmtS(last - first)}), ${frames} frames, ${(fs.readdirSync(dir).filter(f => f.startsWith('feed.tsv')).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0) / 1e6).toFixed(1)} MB on disk`);
console.log(`  connections: ${Object.entries(per).map(([c, p]) => `#${c} ${p.frames} frames, first with ${p.first} of ${unique} updates`).join(' · ')}`);
console.log(`  updates: ${unique} unique, ${dup} duplicate copies, ${snaps} snapshots, ${bad} unreadable lines`);
console.log(`  topics: ${Object.entries(topics).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
console.log(`  F1 send → received: P50 ${q(delays, .5) ?? '–'} ms · P95 ${q(delays, .95) ?? '–'} · P99 ${q(delays, .99) ?? '–'} (F1's clock vs this Mac's)`);
const worst = silences.sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log(`  longest silences while running: ${worst.map(s => `${fmtS(s.ms)} at ${s.at.slice(11, 19)}`).join(', ') || 'none'}`);
console.log(`  connection drops: ${count('closed')} · failed connects: ${count('connectFailed')} · gaps over 15 s: ${count('gap')} · relay starts: ${count('open')} · errors: ${count('error')}`);
console.log(`  missed-update checks: ${drift.length} run, ${drift.filter(d => d.differences).length} found differences${drift.some(d => d.differences) ? ' (' + drift.filter(d => d.differences).map(d => d.sample?.[0]).slice(0, 2).join('; ') + ')' : ''}`);
// Laps: F1's own count per driver against lap times seen in the feed.
const lines = state.TimingData?.Lines || {}, short = [];
for (const [n, L] of Object.entries(lines)) { const want = (+L.NumberOfLaps || 0) - (base?.[n] || 0), got = lapEnds[n] || 0; if (want > 0 && got < want) short.push(`${state.DriverList?.[n]?.Tla || n} ${got}/${want}`); }
console.log(`  laps since recording began: ${Object.keys(lines).length} drivers; lap times seen vs F1's lap count: ${short.length ? 'MISSING for ' + short.join(', ') : 'complete'}`);
const kinds = {}; page.forEach(p => kinds[p.kind] = (kinds[p.kind] || 0) + 1);
console.log(`  site records: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
const kg = kal.slice(1).map((k, i) => k.t - kal[i].t);
console.log(`  Kalshi: ${kal.length} price changes${kal.length ? `, longest without a change ${fmtS(Math.max(0, ...kg))}` : ''}`);
if (ingest.length) { const lag = ingest.map(i => i.at); console.log(`  backend copy: ${ingest.length} appends from ${[...new Set(ingest.map(i => i.collector))].join(', ')}, first ${new Date(Math.min(...lag)).toISOString()}, last ${new Date(Math.max(...lag)).toISOString()}`); }
console.log(`  session: ${state.SessionInfo?.Meeting?.Name ?? '?'} ${state.SessionInfo?.Name ?? ''}, last status ${state.SessionStatus?.Status ?? '?'}`);
