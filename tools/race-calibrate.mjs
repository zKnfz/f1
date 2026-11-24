// Learns the correction (CAL in racesim.js) that turns the simulation's figures into how often
// such a figure came true in past races, and checks it on the season it was not fitted on.
//   DUMP=data/race-raw.json node tools/race-backtest.mjs --year=2024,2025 --quiet --set=cal=0,temp=1
//   node tools/race-calibrate.mjs data/race-raw.json   → prints the check, writes data/race-cal.json
// Then paste data/race-cal.json into CAL in racesim.js.
// chance = logistic(a + b·log-odds(figure) + c·log(place)), fitted separately before the start
// (place = grid slot) and during the race (place = running position), because a driver further
// back wins less often than the same figure from the front.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync(process.argv[2] || 'data/race-raw.json', 'utf8'));
const CUT = { win: 1, top3: 3, top5: 5, top10: 10 };
const lg = p => { p = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(p / (1 - p)); };
const sig = z => 1 / (1 + Math.exp(-z));
const hit = (m, o) => o <= CUT[m];
function renorm(q, t) { let f = 1; for (let i = 0; i < 30; i++) { const s = q.reduce((x, p) => x + Math.min(1, p * f), 0); if (!s) break; f *= t / s; } return q.map(p => Math.min(1, p * f)); }
function fitPre(groups, m) {
  const w = [0, 1, 0], X = [], Y = [];
  for (const g of groups) for (const c of g.cars) { X.push([1, lg(c.p[m]), Math.log(c.g)]); Y.push(hit(m, c.o) ? 1 : 0); }
  for (let it = 0; it < 3000; it++) { const gr = [0, 0, 0]; X.forEach((x, i) => { const e = sig(w[0] + w[1] * x[1] + w[2] * x[2]) - Y[i]; for (let j = 0; j < 3; j++) gr[j] += e * x[j]; }); for (let j = 0; j < 3; j++) w[j] -= 0.5 * gr[j] / X.length + 0.002 * (j === 1 ? w[j] - 1 : j === 2 ? w[j] : 0); }
  return w.map(x => +x.toFixed(3));
}
function fitRace(groups, m) { // pool-adjacent-violators, lightly pulled towards the figure itself
  const rows = []; for (const g of groups) for (const c of g.cars) rows.push([c.p[m], hit(m, c.o)]);
  rows.sort((a, b) => a[0] - b[0]);
  const bl = [];
  for (const [p, h] of rows) { bl.push({ s: +h, n: 1, x: p }); while (bl.length > 1 && bl.at(-2).s / bl.at(-2).n >= bl.at(-1).s / bl.at(-1).n) { const b = bl.pop(), a = bl.at(-1); a.x = (a.x * a.n + b.x * b.n) / (a.n + b.n); a.s += b.s; a.n += b.n; } }
  return bl.map(b => [+b.x.toFixed(4), +((b.s + 3 * b.x) / (b.n + 3)).toFixed(4)]);
}
const readCurve = (k, p) => { if (p <= k[0][0]) return k[0][1] * p / Math.max(k[0][0], 1e-6); const l = k.at(-1); if (p >= l[0]) return l[1] + (p - l[0]) * (1 - l[1]) / Math.max(1e-6, 1 - l[0]); for (let i = 1; i < k.length; i++) if (p <= k[i][0]) { const [x0, y0] = k[i - 1], [x1, y1] = k[i]; return y0 + (y1 - y0) * (p - x0) / (x1 - x0); } };
const predict = (g, m, C) => renorm(g.cars.map(c => { const w = C[g.cp === 0 ? 'pre' : 'race'][m]; return sig(w[0] + w[1] * lg(c.p[m]) + w[2] * Math.log(c.g)); }), Math.min(CUT[m], g.cars.length));
const fitAll = gs => ({ pre: Object.fromEntries(Object.keys(CUT).map(m => [m, fitPre(gs.filter(g => g.cp === 0), m)])), race: Object.fromEntries(Object.keys(CUT).map(m => [m, fitPre(gs.filter(g => g.cp > 0), m)])) });
const ll = r => -r.reduce((s, [p, h]) => s + Math.log(Math.min(.999, Math.max(.001, h ? p : 1 - p))), 0) / r.length;
const bands = r => [[0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9]].map(([lo, hi]) => { const x = r.filter(v => v[0] >= lo && v[0] < hi); return x.length ? `${Math.round(x.reduce((s, v) => s + v[0], 0) / x.length * 100)}→${Math.round(x.filter(v => v[1]).length / x.length * 100)}` : '–'; }).join('  ');
console.log('said→happened (%), bands 10-20 20-30 30-50 50-70 70-90; fitted on the other season');
for (const [tr, te] of [['2025', '2024'], ['2024', '2025']]) {
  const C = fitAll(D.filter(g => g.year === tr)), E = D.filter(g => g.year === te);
  for (const m of Object.keys(CUT)) {
    const a = [], b = [];
    for (const g of E) { const q = predict(g, m, C); g.cars.forEach((c, i) => { a.push([c.p[m], hit(m, c.o)]); b.push([q[i], hit(m, c.o)]); }); }
    console.log(`${te} ${m.padEnd(5)} log loss ${ll(a).toFixed(4)} → ${ll(b).toFixed(4)}   before ${bands(a)}   after ${bands(b)}`);
  }
}
fs.writeFileSync(process.env.CAL_OUT || 'data/race-cal.json', JSON.stringify(fitAll(D)));
console.log('wrote ' + (process.env.CAL_OUT || 'data/race-cal.json'));
