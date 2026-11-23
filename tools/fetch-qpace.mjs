// Saves the official qualifying times for a race weekend as shared qualifying pace, so the
// pre-race call uses them instead of what a browser happened to catch live.
//   node tools/fetch-qpace.mjs <year> <round> <meetingKey>
// meetingKey is the number in the page's pitwall-qpace-<key> (state.SessionInfo.Meeting.Key).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [year, round, meeting] = process.argv.slice(2);
if (!meeting) { console.error('usage: node tools/fetch-qpace.mjs <year> <round> <meetingKey>'); process.exit(1); }
const r = await fetch(`https://api.jolpi.ca/ergast/f1/${year}/${round}/qualifying.json`, { headers: { 'User-Agent': 'pitwall-live-timing' } });
const race = (await r.json()).MRData.RaceTable.Races[0];
if (!race) { console.error('No qualifying results yet.'); process.exit(1); }
const secs = t => { if (!t) return null; const p = String(t).split(':'); return p.length === 2 ? +p[0] * 60 + +p[1] : +p[0]; };
const best = {};
for (const q of race.QualifyingResults) {
  const t = [q.Q1, q.Q2, q.Q3].map(secs).filter(Boolean);
  if (t.length) best[q.number] = Math.min(...t);
}
const key = `pitwall-qpace-${meeting}`;
// "laps" is how the page decides whose copy wins; official times always beat a live capture.
const doc = { key, laps: 1000, official: true, race: race.raceName, best };
fs.writeFileSync(path.join(ROOT, 'learned', key + '.json'), JSON.stringify(doc));
const idxPath = path.join(ROOT, 'learned', 'index.json');
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
idx.files[key] = 1000; idx.updated = new Date().toISOString();
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));
console.log(`${race.raceName}: ${Object.keys(best).length} drivers saved to learned/${key}.json`);
console.log(Object.entries(best).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([n, t]) => `#${n} ${t.toFixed(3)}`).join('  '));
