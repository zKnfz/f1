// Learns the correction (RaceSim CAL) that turns the simulation's figures into how often
// such a figure came true, and checks it on the season it was not fitted on.
//   DUMP=data/race-raw.json node tools/race-backtest.mjs --year=2024,2025 --quiet --set=cal=0,temp=1
//   node tools/race-calibrate.mjs data/race-raw.json      → prints the check, writes data/race-cal.json
// Then paste data/race-cal.json into CAL in racesim.js.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync(process.argv[2] || 'data/race-raw.json', 'utf8'));
const TOT = { win: 1, top3: 3, top5: 5, top10: 10 }, CUT = { win: 1, top3: 3, top5: 5, top10: 10 };
const hit = (m, o) => o <= CUT[m];
// Pool-adjacent-violators on (p, hit), then knots for linear interpolation.
function iso(rows) {
  rows = rows.slice().sort((a, b) => a[0] - b[0]);
  const bl = [];
  for (const [p, h] of rows) { bl.push({ s: +h, n: 1, x: p }); while (bl.length > 1 && bl[bl.length - 2].s / bl[bl.length - 2].n >= bl[bl.length - 1].s / bl[bl.length - 1].n) { const b = bl.pop(), a = bl[bl.length - 1]; a.x = (a.x * a.n + b.x * b.n) / (a.n + b.n); a.s += b.s; a.n += b.n; } }
  // shrink each block a little towards its own mean input (smooths small blocks)
  return bl.map(b => [b.x, (b.s + 3 * b.x) / (b.n + 3)]);
}
const interp = (k, p) => { if (p <= k[0][0]) return k[0][1] * (p / Math.max(k[0][0], 1e-6)); if (p >= k[k.length - 1][0]) return k[k.length - 1][1] + (p - k[k.length - 1][0]) * (1 - k[k.length - 1][1]) / Math.max(1e-6, 1 - k[k.length - 1][0]); for (let i = 1; i < k.length; i++) if (p <= k[i][0]) { const [x0, y0] = k[i - 1], [x1, y1] = k[i]; return y0 + (y1 - y0) * (p - x0) / (x1 - x0); } };
function renorm(q, total) { let f = 1; for (let it = 0; it < 30; it++) { const s = q.reduce((x, p) => x + Math.min(1, p * f), 0); if (!s) break; f *= total / s; } return q.map(p => Math.min(1, p * f)); }
const soft08 = (ps, total) => renorm(ps.map(p => { p = Math.min(1 - 1e-4, Math.max(1e-4, p)); return 1 / (1 + Math.exp(-0.8 * Math.log(p / (1 - p)))); }), total);
const phase = g => g.cp === 0 ? 'pre' : 'race';
function knots(groups, split) { const K = {}; for (const m of Object.keys(TOT)) for (const ph of split ? ['pre', 'race'] : ['all']) { const rows = []; for (const g of groups) if (ph === 'all' || phase(g) === ph) for (const c of g.cars) rows.push([c.p[m], hit(m, c.o)]); K[m + ph] = iso(rows); } return K; }
function predict(g, m, K, split) { const k = K[m + (split ? phase(g) : 'all')]; return renorm(g.cars.map(c => Math.max(0, Math.min(1, interp(k, c.p[m])))), Math.min(TOT[m], g.cars.length)); }
const ll = rows => -rows.reduce((s, [p, h]) => s + Math.log(Math.min(1 - 1e-3, Math.max(1e-3, h ? p : 1 - p))), 0) / rows.length;
const bt = r => [[0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9]].map(([lo, hi]) => { const x = r.filter(v => v[0] >= lo && v[0] < hi); return x.length ? `${Math.round(x.reduce((s, v) => s + v[0], 0) / x.length * 100)}→${Math.round(x.filter(v => v[1]).length / x.length * 100)}(${x.length})` : '–'; }).join(' ');
for (const [tr, te] of [['2025', '2024'], ['2024', '2025']]) {
  const T = D.filter(g => g.year === tr), E = D.filter(g => g.year === te);
  for (const split of [false, true]) {
    const K = knots(T, split); let line = `${te} ${split ? 'split' : 'one  '}`;
    for (const m of Object.keys(TOT)) {
      const a = [], b = [];
      for (const g of E) { const q = predict(g, m, K, split), q0 = soft08(g.cars.map(c => c.p[m]), Math.min(TOT[m], g.cars.length)); g.cars.forEach((c, i) => { a.push([q0[i], hit(m, c.o)]); b.push([q[i], hit(m, c.o)]); }); }
      line += ` | ${m} ${ll(a).toFixed(4)}→${ll(b).toFixed(4)}`;
      if (split) console.log(`   ${te} ${m.padEnd(5)} now: ${bt(a)}\n   ${te} ${m.padEnd(5)} new: ${bt(b)}`);
    }
    console.log(line);
  }
}
const K = knots(D, true);
fs.writeFileSync('data/race-cal.json', JSON.stringify(Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])]))));
console.log('knot counts', Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.length])));
