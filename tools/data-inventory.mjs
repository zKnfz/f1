// What historical data is on this machine, and how complete it is.
//   node tools/data-inventory.mjs [--json=out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const J = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const out = { openf1: {}, jolpica: {}, recordings: [], lapSummaries: [], learned: [] };

// OpenF1 sessions
const of = path.join(DATA, 'openf1');
if (fs.existsSync(of)) for (const y of fs.readdirSync(of).filter(x => /^\d{4}$/.test(x)).sort()) {
  for (const k of fs.readdirSync(path.join(of, y))) {
    const d = path.join(of, y, k), s = J(path.join(d, 'session.json')); if (!s) continue;
    const laps = J(path.join(d, 'laps.json')) || [];
    const kind = s.session_name;
    const row = (out.openf1[y] ??= {})[kind] ??= { sessions: 0, complete: 0, laps: 0, withSectors: 0, withSegments: 0, missing: [] };
    row.sessions++;
    const files = ['laps', 'stints', 'race_control', 'session_result', 'weather'].filter(f => !fs.existsSync(path.join(d, f + '.json')) || (J(path.join(d, f + '.json')) || []).length === 0);
    if (!files.length) row.complete++; else row.missing.push(`${s.circuit_short_name}: no ${files.join(', ')}`);
    row.laps += laps.length;
    row.withSectors += laps.filter(l => l.duration_sector_1 && l.duration_sector_2 && l.duration_sector_3).length;
    row.withSegments += laps.filter(l => Array.isArray(l.segments_sector_1) && l.segments_sector_1.length).length;
  }
}
// Jolpica race histories
const jr = path.join(DATA, 'races');
if (fs.existsSync(jr)) for (const f of fs.readdirSync(jr).filter(f => f.endsWith('.json')).sort()) {
  const d = J(path.join(jr, f)), y = f.slice(0, 4);
  const r = out.jolpica[y] ??= { races: 0, lapRows: 0, pitStops: 0, withQuali: 0, names: [] };
  r.races++; r.lapRows += Object.values(d.laps || {}).reduce((a, l) => a + l.length, 0); r.pitStops += (d.pits || []).length; if ((d.quali || []).length) r.withQuali++; r.names.push(d.name);
}
// Raw recordings and older lap summaries
const rec = path.join(DATA, 'rec');
if (fs.existsSync(rec)) for (const d of fs.readdirSync(rec)) {
  const p = path.join(rec, d); if (!fs.statSync(p).isDirectory()) continue;
  const meta = J(path.join(p, 'meta.json')) || {};
  const size = fs.readdirSync(p).reduce((s, f) => s + fs.statSync(path.join(p, f)).size, 0);
  out.recordings.push({ dir: d, bytes: size, synthetic: !!meta.synthetic, runs: meta.relayRuns?.length ?? 0, files: fs.readdirSync(p) });
}
for (const f of fs.readdirSync(DATA).filter(f => /^session-\d+\.json$/.test(f))) { const d = J(path.join(DATA, f)); out.lapSummaries.push({ file: f, key: d?.key, drivers: Object.keys(d?.laps || {}).length, laps: Object.values(d?.laps || {}).reduce((a, l) => a + l.length, 0) }); }
for (const f of fs.readdirSync(path.join(ROOT, 'learned'))) out.learned.push(f);

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('OpenF1 (sector times, mini-sectors, speeds, tyres, race control, weather):');
  for (const [y, kinds] of Object.entries(out.openf1)) for (const [k, r] of Object.entries(kinds)) console.log(`  ${y} ${k.padEnd(18)} ${r.sessions} sessions (${r.complete} complete), ${r.laps} laps, ${(100 * r.withSectors / Math.max(1, r.laps)).toFixed(0)}% with all 3 sectors${r.missing.length ? ' · gaps: ' + r.missing.join('; ') : ''}`);
  console.log('Jolpica (race lap times and positions, pit stops, qualifying results; no sectors, no tyres):');
  for (const [y, r] of Object.entries(out.jolpica)) console.log(`  ${y} ${r.races} races, ${r.lapRows} driver-laps, ${r.pitStops} pit stops, qualifying for ${r.withQuali}`);
  console.log('Raw recordings (data/rec):'); for (const r of out.recordings) console.log(`  ${r.dir}: ${(r.bytes / 1e6).toFixed(2)} MB${r.synthetic ? ' (synthetic)' : ''}, ${r.files.join(' ')}`);
  console.log('Lap summaries (data/session-*.json):'); for (const r of out.lapSummaries) console.log(`  ${r.file}: ${r.drivers} drivers, ${r.laps} laps`);
  console.log('Shared learned files:', out.learned.join(', '));
  const j = process.argv.find(a => a.startsWith('--json='))?.slice(7); if (j) fs.writeFileSync(j, JSON.stringify(out, null, 1));
}
