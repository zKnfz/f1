// Where is the lap projection wrong? Joins each scored push lap (tools/score-quali.mjs) to
// OpenF1's lap and stint data and breaks the error down by part, compound, new/used tyre,
// season, circuit, and how late in the part the lap was (track evolution).
//   node tools/proj-residuals.mjs data/eval/base [--only=keys]
import fs from 'node:fs';
import path from 'node:path';
import { loadEval } from './score-quali.mjs';

const dir = path.resolve(process.argv[2] || 'data/eval/base');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const OF = path.resolve('data/openf1');
const find = key => { for (const y of fs.readdirSync(OF).filter(x => /^\d{4}$/.test(x))) { const d = path.join(OF, y, key); if (fs.existsSync(d)) return d; } };
const J = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };
const rows = [];
for (const s of loadEval(dir, only)) {
  const d = find(s.key); if (!d) continue;
  const info = J(path.join(d, 'session.json')), laps = J(path.join(d, 'laps.json')), stints = J(path.join(d, 'stints.json'));
  const ps = s.meta.outcome.partStart || {};
  for (const p of s.proj) {
    const l = laps.find(x => String(x.driver_number) === p.n && x.lap_duration && Math.abs(x.lap_duration - p.t) < 0.0015);
    if (!l) continue;
    const st = stints.find(x => x.driver_number === l.driver_number && l.lap_number >= x.lap_start && l.lap_number <= x.lap_end);
    const start = Date.parse(l.date_start);
    const part = Object.entries(ps).filter(([, t]) => start >= t).map(([k]) => +k).pop() || 1;
    const intoPart = (start - ps[part]) / 1000;
    rows.push({ ...p, part, compound: st?.compound ?? '?', used: st ? (st.tyre_age_at_start > 0 || l.lap_number > st.lap_start + 1 ? 'used' : 'new') : '?',
      year: info.year, circuit: info.circuit_short_name, late: intoPart < 0 ? '?' : intoPart < 240 ? 'first 4 min' : intoPart < 480 ? '4–8 min' : 'after 8 min' });
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const show = (label, key) => {
  console.log(`\nby ${label}`);
  for (const after of [1, 2]) {
    const g = {};
    for (const r of rows.filter(r => r.after === after)) (g[r[key]] ??= []).push(r.err);
    for (const [k, e] of Object.entries(g).sort()) if (e.length >= 20) console.log(`  after S${after}  ${String(k).padEnd(14)} laps ${String(e.length).padStart(5)}  bias ${mean(e).toFixed(3)} s  MAE ${mean(e.map(Math.abs)).toFixed(3)} s`);
  }
};
console.log(`${rows.length} projections joined to OpenF1 laps (positive bias = projected slower than the real lap)`);
show('part', 'part'); show('compound', 'compound'); show('new or used tyre', 'used'); show('time into the part', 'late'); show('season', 'year');
const byC = {};
for (const r of rows.filter(r => r.after === 1)) (byC[r.circuit] ??= []).push(r.err);
console.log('\nafter S1, by circuit (worst MAE first)');
for (const [c, e] of Object.entries(byC).filter(([, e]) => e.length >= 20).sort((a, b) => mean(b[1].map(Math.abs)) - mean(a[1].map(Math.abs)))) console.log(`  ${c.padEnd(18)} laps ${String(e.length).padStart(4)}  bias ${mean(e).toFixed(3)}  MAE ${mean(e.map(Math.abs)).toFixed(3)}`);
