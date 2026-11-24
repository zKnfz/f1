// Tests the race call on past races (downloaded by tools/fetch-races.mjs).
// At set points in each race it rebuilds what was known then, asks the race call for its
// chances, and compares them with the real result.
// Usage: node tools/race-backtest.mjs [--year=2024,2025] [--set=key=value,...] [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RaceSim = createRequire(import.meta.url)(path.join(ROOT, 'racesim.js'));
const setArg = process.argv.find(a => a.startsWith('--set='));
if (setArg) for (const kv of setArg.slice(6).split(',')) { const [k, v] = kv.split('='); RaceSim.P[k] = +v; }
const quiet = process.argv.includes('--quiet');
// CAL_FILE: try a different calibration (candidate) in place of the one in racesim.js.
if (process.env.CAL_FILE) { const c = JSON.parse(fs.readFileSync(process.env.CAL_FILE, 'utf8')); RaceSim.CAL.pre = c.pre; RaceSim.CAL.race = c.race; }
// ROUNDS=2026:15-24 limits a season to some rounds (e.g. the held-out part of 2026).
const ROUNDS = process.env.ROUNDS ? Object.fromEntries(process.env.ROUNDS.split(',').map(x => { const [y, r] = x.split(':'); const [a, b] = r.split('-').map(Number); return [y, [a, b ?? a]]; })) : null;
const secs = t => { if (!t) return null; const p = String(t).split(':'); return p.length === 2 ? +p[0] * 60 + +p[1] : +p[0]; };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const CPS = process.env.CPS ? process.env.CPS.split(",").map(Number) : [0, 0.25, 0.5, 0.75, 0.9];

const dir = path.join(ROOT, 'data', 'races');
const yearArg = process.argv.find(a => a.startsWith('--year='))?.slice(7);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && (!yearArg || yearArg.split(',').some(y => f.startsWith(y + '-')))).filter(f => { const [y, r] = f.replace('.json', '').split('-'); return !ROUNDS?.[y] || (+r >= ROUNDS[y][0] && +r <= ROUNDS[y][1]); }).sort();
const rows = []; // { cp, market, p, hit }
const favs = {};
const paceDump = [], degDump = [];
const dump = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const total = +d.results[0].laps;
  const finish = {}; d.results.forEach(r => { finish[r.Driver.driverId] = { order: +r.position, finished: /Finished|Lap/.test(r.status) || +r.laps >= total - 3 }; });
  const grid = {}; d.results.forEach(r => { grid[r.Driver.driverId] = +r.grid || 25; });
  const qbest = {}; d.quali.forEach(q => { const t = [q.Q1, q.Q2, q.Q3].map(secs).filter(Boolean); if (t.length) qbest[q.Driver.driverId] = Math.min(...t); });
  const pitsBy = {}; for (const p of d.pits) (pitsBy[p.driverId] ??= []).push(+p.lap);
  const durs = d.pits.map(p => secs(p.duration)).filter(x => x && x < 40);
  const pitLoss = durs.length ? median(durs) : 22;
  // Lap times and cumulative times.
  const ids = Object.keys(d.laps);
  const lapT = {}, cum = {};
  for (const id of ids) { lapT[id] = {}; cum[id] = {}; let c = 0; for (const l of d.laps[id]) { const t = secs(l.time); lapT[id][l.lap] = { t, pos: l.pos }; c += t; cum[id][l.lap] = c; } }
  const fieldMed = {}; for (let l = 1; l <= total; l++) { const ts = ids.map(id => lapT[id][l]?.t).filter(Boolean); if (ts.length) fieldMed[l] = median(ts); }
  const ref = median(Object.values(fieldMed));
  for (const cp of CPS) {
    const k = Math.round(cp * total);
    const lead = k ? Math.min(...ids.map(id => cum[id][k] ?? Infinity)) : 0;
    const cars = Object.keys(finish).map(id => {
      const pits = (pitsBy[id] || []).filter(l => l <= k);
      const lastStop = pits.length ? Math.max(...pits) : 0;
      const out = k > 0 && !lapT[id]?.[k];
      const laps = [];
      for (let l = 2; l <= k; l++) {
        const x = lapT[id]?.[l];
        if (!x || (pitsBy[id] || []).some(p => p === l || p === l - 1) || x.t > fieldMed[l] * 1.07) continue;
        const ps = (pitsBy[id] || []).filter(p => p < l);
        laps.push({ time: x.t, age: l - (ps.length ? Math.max(...ps) : 0), stint: ps.length });
      }
      return { n: id, pos: k ? (lapT[id]?.[k]?.pos ?? 99) : grid[id], gap: k && !out ? cum[id][k] - lead : 0, out,
        compound: pits.length ? 'HARD' : 'MEDIUM', age: k - lastStop, used: pits.length ? ['MEDIUM', 'HARD'] : ['MEDIUM'], laps, qbest: qbest[id] };
    });
    if (!k) cars.forEach(c => { c.gap = (c.pos - 1) * RaceSim.P.gridGap; });
    const b = RaceSim.build({ lapsLeft: total - k, sprint: false, started: k > 0, pitLoss, scLoss: pitLoss * 0.55, ref, cars });
    const res = RaceSim.run(b, { runs: 2000 });
    const got = Object.fromEntries(res.cars.map(c => [c.n, c]));
    // PACE_DUMP: the model's other forecasts against what followed (only once the race has
    // laps): each car's pace against the field over the next 10 clean laps, the field's tyre
    // wear per lap, and pit stops still to make (tyres are assumed here: Jolpica has none).
    if (process.env.PACE_DUMP && k > 0) {
      const alive = b.cars.filter(c => !c.out);
      const predMed = median(alive.map(c => c.pace + b.deg * (c.age + 5)));
      const pitOf = id => pitsBy[id] || [];
      for (const c of alive) {
        const rel = [];
        for (let l = k + 1; l <= Math.min(total, k + 10); l++) { const x = lapT[c.n]?.[l]; if (x && fieldMed[l] && !pitOf(c.n).some(p => p === l || p === l - 1) && x.t < fieldMed[l] * 1.07) rel.push(x.t - fieldMed[l]); }
        paceDump.push({ year: f.slice(0, 4), race: d.name, cp, n: c.n, predRel: c.pace + b.deg * (c.age + 5) - predMed, realRel: rel.length >= 5 ? median(rel) : null, owed: c.owed, stopsAfter: pitOf(c.n).filter(p => p > k).length, finished: finish[c.n]?.finished ?? false });
      }
      // Realised wear: slope of lap time on tyre age over the rest of the race, within stints.
      let sxy = 0, sxx = 0;
      for (const id of ids) {
        const st = {};
        for (let l = k + 1; l <= total; l++) { const x = lapT[id]?.[l]; if (!x || !fieldMed[l] || pitOf(id).some(p => p === l || p === l - 1) || x.t > fieldMed[l] * 1.07) continue; const s = pitOf(id).filter(p => p < l).length, age = l - Math.max(0, ...pitOf(id).filter(p => p < l)); (st[s] ??= []).push([age, x.t - fieldMed[l]]); }
        for (const g of Object.values(st)) { if (g.length < 6) continue; const ma = g.reduce((a, x) => a + x[0], 0) / g.length, mt = g.reduce((a, x) => a + x[1], 0) / g.length; for (const [a, t] of g) { sxy += (a - ma) * (t - mt); sxx += (a - ma) ** 2; } }
      }
      degDump.push({ year: f.slice(0, 4), race: d.name, cp, predDeg: b.deg, realDeg: sxx > 200 ? sxy / sxx : null });
    }
    if (process.env.DUMP) dump.push({ year: f.slice(0, 4), round: +d.round, race: d.name, cp, cars: Object.keys(finish).map(id => ({ p: got[id] ? { win: got[id].win, top3: got[id].top3, top5: got[id].top5, top10: got[id].top10 } : { win: 0, top3: 0, top5: 0, top10: 0 }, o: finish[id].order, g: got[id]?.pos ?? 25 })) });
    for (const id of Object.keys(finish)) {
      const p = got[id] || { win: 0, top3: 0, top5: 0, top10: 0 }, o = finish[id].order;
      if (process.env.DBG && ((p.top10 > 0.9 && o > 10) || (p.top5 > 0.9 && o > 5) || (p.top10 < 0.1 && o <= 10))) { const c = b.cars.find(x => x.n === id); console.log(d.name.slice(0, 12), cp, id, "top5", p.top5.toFixed(2), "top10", p.top10.toFixed(2), "got P" + o, "status", d.results.find(r => r.Driver.driverId === id).status, "posNow", c?.pos, "gap", c?.gap?.toFixed(1), "owed", c?.owed, "pace", c?.pace?.toFixed(2)); }
      rows.push({ cp, m: 'win', p: p.win, hit: o === 1 }, { cp, m: 'top3', p: p.top3, hit: o <= 3 }, { cp, m: 'top5', p: p.top5, hit: o <= 5 }, { cp, m: 'top10', p: p.top10, hit: o <= 10 });
    }
    const fav = res.cars.slice().sort((a, c) => c.win - a.win)[0];
    (favs[cp] ??= []).push(finish[fav.n]?.order === 1);
    if (!quiet && cp === 0.5) console.log(`${d.name.padEnd(28)} lap ${k}: fav ${fav.n} ${(fav.win * 100).toFixed(0)}% → ${finish[fav.n]?.order === 1 ? 'won' : 'P' + finish[fav.n]?.order}`);
  }
}
const brier = a => a.reduce((s, r) => s + (r.p - r.hit) ** 2, 0) / a.length;
const ll = a => -a.reduce((s, r) => s + Math.log(Math.min(1 - 1e-3, Math.max(1e-3, r.hit ? r.p : 1 - r.p))), 0) / a.length;
console.log(`\n${files.length} races`);
for (const m of ['win', 'top3', 'top5', 'top10']) {
  const line = CPS.map(cp => { const a = rows.filter(r => r.m === m && r.cp === cp); return `${(cp * 100).toFixed(0).padStart(2)}%: ${brier(a).toFixed(3)}`; }).join('  ');
  console.log(`${m.padEnd(6)} brier by race distance  ${line}   log loss ${ll(rows.filter(r => r.m === m)).toFixed(3)}`);
}
console.log('favourite to win was right: ' + CPS.map(cp => `${(cp * 100).toFixed(0)}% ${favs[cp].filter(Boolean).length}/${favs[cp].length}`).join(' · '));
for (const m of ['win', 'top3', 'top5', 'top10']) {
  const bands = [[0, 0.1], [0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];
  console.log(`${m.padEnd(6)} calibration  ` + bands.map(([lo, hi]) => { const a = rows.filter(r => r.m === m && r.p >= lo && r.p < hi); if (!a.length) return ''; return `${(lo * 100).toFixed(0)}-${Math.min(100, hi * 100).toFixed(0)}%: said ${(a.reduce((s, r) => s + r.p, 0) / a.length * 100).toFixed(0)} got ${(a.filter(r => r.hit).length / a.length * 100).toFixed(0)} (${a.length})`; }).filter(Boolean).join(' | '));
}
const tot = ['win', 'top5', 'top10'].reduce((a, m) => a + ll(rows.filter(r => r.m === m)), 0);
console.log('SCORE ' + JSON.stringify({ logloss: +tot.toFixed(4), races: files.length }));
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(dump));
if (process.env.PACE_DUMP) fs.writeFileSync(process.env.PACE_DUMP, JSON.stringify({ pace: paceDump, deg: degDump }));
