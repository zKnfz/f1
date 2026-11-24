// Scores what the page predicted during replayed qualifying sessions (tools/replay-eval.mjs
// output) against what happened.
//   node tools/score-quali.mjs data/eval/base [--only=11241,11249] [--json=out.json]
//
// Lap projection: the projection shown when each sector ended (after S1, after S2) against the
//   lap time. Push laps only (lap within 2% of the driver's best of the session; aborted and
//   cool-down laps excluded), plus the stated uncertainty: share of laps within ±1σ (68% if honest).
// Pole and "who tops Qn": the page's chances at fixed points of each part (start, 25/50/75/90%
//   of the part's clock, and its last call before the part ends), against the fastest time of
//   that part. Brier (multi-class), log loss (of the winner's chance), top pick right, and
//   calibration (ECE over all driver-chance pairs in 10 bands).
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'data/eval/base');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const jsonOut = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const secs = v => { if (!v) return null; const p = String(v).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
const PART_S = { false: [1080, 900, 720], true: [720, 600, 480] };
const STAGES = [['start', 0.02], ['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['90%', 0.9], ['last call', null]];

export function scoreSession(recs, meta) {
  const out = { proj: [], pole: [], ko: [] };
  const o = meta.outcome;
  // ---- lap projection ----
  const byDrv = {};
  for (const r of recs) if (r.kind === 'proj' || r.kind === 'lapEnd') (byDrv[r.num] ??= []).push(r);
  for (const [n, rs] of Object.entries(byDrv)) {
    const times = rs.filter(r => r.kind === 'lapEnd').map(r => secs(r.time)).filter(Boolean);
    const best = Math.min(...times);
    let pend = [];
    for (const r of rs) {
      if (r.kind === 'proj') { if (r.proj != null && !r.slow && r.done === r.after) pend.push(r); continue; }
      const t = secs(r.time);
      if (t && t <= best * 1.02) for (const after of [1, 2]) {
        const p = pend.filter(x => x.after === after).at(-1);
        if (p) out.proj.push({ after, err: p.proj - t, sigma: p.sigma, n, t, part: Object.entries(o.partStart || {}).filter(([, s]) => r.feedT >= s).map(([k]) => +k).pop() || 1 });
      }
      pend = [];
    }
  }
  // ---- pole / top of part ----
  const sprint = /Sprint/i.test(meta.session?.name || '');
  for (const part of [1, 2, 3]) {
    const winner = o.partTop?.[part - 1], start = o.partStart?.[part];
    if (!winner || !start) continue;
    const calls = recs.filter(r => r.kind === 'pole' && r.part === part && r.feedT >= start).sort((a, b) => a.feedT - b.feedT);
    if (!calls.length) continue;
    const len = PART_S[sprint][part - 1] * 1000;
    const nextStart = o.partStart?.[part + 1] ?? Infinity;
    for (const [stage, f] of STAGES) {
      const at = f == null ? Math.min(nextStart, Infinity) : start + f * len;
      // The last unsettled call: chances before the part's outcome was certain.
      const pool = f == null ? calls.filter(c => c.feedT < nextStart && !c.settled) : calls.filter(c => c.feedT <= at);
      const c = pool.at(-1);
      if (!c) continue;
      const code = Object.fromEntries((meta._codes || []).map(x => x));
      const ps = c.cars.map(([tla, ch]) => [tla, ch]);
      out.pole.push({ part, stage, ps, winner: code[winner] || winner, t: c.feedT });
      // Knockout: who is out at the end of Q1/Q2 (classification beyond the cut), the running
      // order at this moment (from the time each car held), and the candidate's chances if any.
      if (part < 3 && o.noEntries?.[part]) {
        const cut = o.noEntries[part], inv = Object.fromEntries(Object.entries(code).map(([n, t]) => [t, n]));
        const cls = o.classification || [];
        const alive = cls.filter(r => part === 1 || r.pos <= o.noEntries[1]).map(r => r.n);
        const outSet = new Set(cls.filter(r => alive.includes(r.n) && r.pos > cut).map(r => r.n));
        const held = c.cars.filter(x => x[2] != null).sort((a, b) => a[2] - b[2]).map(x => inv[x[0]] || x[0]);
        const rank = Object.fromEntries(alive.map(n => [n, held.includes(n) ? held.indexOf(n) + 1 : alive.length]));
        const ko = recs.filter(r => r.kind === 'ko' && r.part === part && r.feedT <= (f == null ? c.feedT : at)).at(-1);
        out.ko.push({ part, stage, cut, alive, out: [...outSet], rank, ps: ko ? ko.cars : null });
      }
    }
  }
  return out;
}

function summarize(sessions) {
  const proj = sessions.flatMap(s => s.proj), pole = sessions.flatMap(s => s.pole);
  const R = {};
  for (const after of [1, 2]) {
    const e = proj.filter(x => x.after === after);
    if (!e.length) continue;
    const abs = e.map(x => Math.abs(x.err)).sort((a, b) => a - b);
    R[`proj after S${after}`] = { laps: e.length, MAE: mean(abs), RMSE: Math.sqrt(mean(e.map(x => x.err ** 2))), bias: mean(e.map(x => x.err)), median: abs[Math.floor(abs.length / 2)], p90: abs[Math.floor(abs.length * 0.9)],
      within1sigma: mean(e.filter(x => x.sigma).map(x => (Math.abs(x.err) <= x.sigma ? 1 : 0))) };
  }
  for (const part of [1, 2, 3]) for (const [stage] of STAGES) {
    const rows = pole.filter(x => x.part === part && x.stage === stage);
    if (!rows.length) continue;
    R[`${part === 3 ? 'pole' : 'top of Q' + part} @ ${stage}`] = probScores(rows);
  }
  const all3 = pole.filter(x => x.part === 3 && x.stage !== 'last call');
  if (all3.length) R['pole, all stages before the last call'] = probScores(all3);
  return R;
}
export function probScores(rows) {
  const pairs = [];
  let brier = 0, ll = 0, top = 0;
  for (const r of rows) {
    const m = new Map(r.ps);
    const pw = m.get(r.winner) ?? 0;
    ll += -Math.log(Math.max(1e-3, pw));
    let b = (1 - pw) ** 2; for (const [k, p] of m) if (k !== r.winner) b += p * p;
    brier += b;
    const best = [...m].sort((a, b) => b[1] - a[1])[0];
    if (best && best[0] === r.winner) top++;
    for (const [k, p] of m) pairs.push([p, k === r.winner ? 1 : 0]);
  }
  return { n: rows.length, brier: brier / rows.length, logLoss: ll / rows.length, topPick: top / rows.length, ece: ece(pairs), winnerChanceMean: mean(rows.map(r => new Map(r.ps).get(r.winner) ?? 0)) };
}
export function ece(pairs, bins = 10) {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const s = pairs.filter(([p]) => (b === bins - 1 ? p >= b / bins : p >= b / bins && p < (b + 1) / bins));
    if (!s.length) continue;
    e += s.length / pairs.length * Math.abs(mean(s.map(x => x[0])) - mean(s.map(x => x[1])));
  }
  return e;
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

export function loadEval(d, filter) {
  const out = [];
  for (const f of fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).sort()) {
    const name = f.replace('.jsonl', '');
    const key = name.split('-').pop();
    if (filter && !filter.includes(key)) continue;
    if (!fs.existsSync(path.join(d, name + '.done'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, name + '.meta.json'), 'utf8'));
    const recs = fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Driver number → code, as the page names them.
    meta._codes = [...new Map(recs.filter(r => r.kind === 'proj' || r.kind === 'lapEnd').map(r => [r.num, r.n]))];
    out.push({ key, name, meta, ...scoreSession(recs, meta) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = loadEval(dir, only);
  const R = summarize(sessions);
  console.log(`${sessions.length} sessions from ${path.relative(process.cwd(), dir)}`);
  const f = x => typeof x === 'number' ? (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(3)) : x;
  for (const [k, v] of Object.entries(R)) console.log(k.padEnd(40), Object.entries(v).map(([a, b]) => `${a} ${f(b)}`).join('  '));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ sessions: sessions.map(s => s.key), metrics: R }, null, 1));
}
export { summarize };

// Knockout chances: binary per car (out at the end of this part or not), against a naive
// reference from other sessions: how often a car in running position r at this stage went out.
export function koScores(rows, naiveFrom) {
  const tbl = {};
  for (const r of naiveFrom) for (const n of r.alive) { const k = `${r.part}|${r.stage}|${Math.min(r.rank[n], 22)}`; (tbl[k] ??= [0, 0])[0] += r.out.includes(n) ? 1 : 0; tbl[k][1]++; }
  const naiveP = (r, n) => { const x = tbl[`${r.part}|${r.stage}|${Math.min(r.rank[n], 22)}`]; return x ? (x[0] + 0.5) / (x[1] + 1) : 0.3; };
  const m = pairs => { const c = p => Math.min(1 - 1e-3, Math.max(1e-3, p)); return { n: pairs.length, brier: pairs.reduce((a, [p, y]) => a + (p - y) ** 2, 0) / pairs.length, logLoss: pairs.reduce((a, [p, y]) => a - Math.log(y ? c(p) : 1 - c(p)), 0) / pairs.length, ece: ece(pairs) }; };
  const withC = rows.filter(r => r.ps);
  const cand = withC.flatMap(r => r.ps.map(([n, p]) => [p, r.out.includes(n) ? 1 : 0]));
  const naive = withC.flatMap(r => r.ps.map(([n]) => [naiveP(r, n), r.out.includes(n) ? 1 : 0]));
  return { candidate: cand.length ? m(cand) : null, naive: naive.length ? m(naive) : null };
}
