// Scores race-call backtests (DUMP output of tools/race-backtest.mjs) by season, market and
// race distance: Brier, log loss, calibration error (ECE, 10 bands), and how often the
// favourite was right. Also a naive comparison: chances from grid / running order alone.
//   DUMP=data/race-dump.json node tools/race-backtest.mjs --year=2024,2025,2026 --quiet
//   node tools/score-race.mjs data/race-dump.json [--json=out.json]
import fs from 'node:fs';
import { ece } from './score-quali.mjs';

const dump = JSON.parse(fs.readFileSync(process.argv[2] || 'data/race-dump.json', 'utf8'));
const jsonOut = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const M = { win: 1, top3: 3, top5: 5, top10: 10 };
const clip = p => Math.min(1 - 1e-3, Math.max(1e-3, p));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const metrics = pairs => ({ n: pairs.length, brier: mean(pairs.map(([p, y]) => (p - y) ** 2)), logLoss: mean(pairs.map(([p, y]) => -Math.log(y ? clip(p) : 1 - clip(p)))), ece: ece(pairs) });
// Naive reference: the chance a car in position k (grid before the start, running order after)
// finishes in the top N, from the other seasons in the dump (never the same season).
function naiveTable(rows) {
  const t = {};
  for (const r of rows) for (const c of r.cars) for (const [m, N] of Object.entries(M)) { const k = `${r.cp}|${Math.min(c.g, 22)}|${m}`; (t[k] ??= [0, 0])[0] += c.o <= N ? 1 : 0; t[k][1]++; }
  return (cp, g, m) => { const x = t[`${cp}|${Math.min(g, 22)}|${m}`]; return x ? (x[0] + 0.5) / (x[1] + 1) : 0.01; };
}
const out = {};
const years = [...new Set(dump.map(r => r.year))].sort();
for (const year of [...years, 'all']) {
  const rows = dump.filter(r => year === 'all' || r.year === year);
  const others = dump.filter(r => year === 'all' || r.year !== year);
  const naive = naiveTable(others);
  for (const m of Object.keys(M)) for (const cp of [...new Set(rows.map(r => r.cp))].sort((a, b) => a - b)) {
    const rs = rows.filter(r => r.cp === cp);
    const pairs = rs.flatMap(r => r.cars.map(c => [c.p[m], c.o <= M[m] ? 1 : 0]));
    const npairs = rs.flatMap(r => r.cars.map(c => [naive(cp, c.g, m), c.o <= M[m] ? 1 : 0]));
    const fav = m === 'win' ? mean(rs.map(r => { const f = r.cars.slice().sort((a, b) => b.p.win - a.p.win)[0]; return f.o === 1 ? 1 : 0; })) : null;
    out[`${year} ${m} @${Math.round(cp * 100)}%`] = { races: rs.length, model: metrics(pairs), naive: year === 'all' ? null : metrics(npairs), favouriteWon: fav };
  }
}
const f = x => x == null ? '' : x.toFixed(3);
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(22), `races ${v.races}`.padEnd(9), `brier ${f(v.model.brier)} ll ${f(v.model.logLoss)} ece ${f(v.model.ece)}`, v.naive ? `| naive brier ${f(v.naive.brier)} ll ${f(v.naive.logLoss)}` : '', v.favouriteWon != null ? `| fav won ${(v.favouriteWon * 100).toFixed(0)}%` : '');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
