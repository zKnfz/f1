// Fits qualifying candidates on training sessions only, and compares them with production on
// held-out sessions. Chronological: training = sessions before --split (default 2026-08-01),
// held out = from --split on. Lusail (Qatar) is never used for fitting, so Qatar can be judged
// cleanly. Reads replay output (tools/replay-eval.mjs) of the production page.
//   node tools/fit-quali.mjs data/eval/base [--split=2026-08-01] [--json=out.json]
//
// Candidates fitted here:
//   sigma-scale  the lap projection's stated uncertainty × c, so that errors/σ have spread 1
//                (fitted per stage). Needs a replay to judge its effect on the pole call.
//   pole-temp    the pole / top-of-part chances sharpened or softened: p_i ∝ p_i^α (renormalised),
//                α fitted per part type (Q3, Q1/Q2) by log loss. Judged directly on held-out calls.
import fs from 'node:fs';
import path from 'node:path';
import { loadEval, probScores, summarize } from './score-quali.mjs';

const dir = path.resolve(process.argv[2] || 'data/eval/base');
const split = Date.parse(process.argv.find(a => a.startsWith('--split='))?.slice(8) || '2026-08-01');
const jsonOut = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const OF = path.resolve('data/openf1');
const sessInfo = key => { for (const y of fs.readdirSync(OF).filter(x => /^\d{4}$/.test(x))) { const f = path.join(OF, y, key, 'session.json'); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } return null; };
const all = loadEval(dir).map(s => ({ ...s, info: sessInfo(s.key) })).filter(s => s.info);
const isQatar = s => s.info.circuit_short_name === 'Lusail';
const train = all.filter(s => Date.parse(s.info.date_start) < split && !isQatar(s));
const held = all.filter(s => Date.parse(s.info.date_start) >= split && !isQatar(s));
const qatar = all.filter(isQatar);
console.log(`training ${train.length} sessions (to ${new Date(split).toISOString().slice(0, 10)}, no Lusail) · held out ${held.length} · Qatar ${qatar.length}`);

// ---- part-bias: the projection's average error by part and stage, on training laps ----
const partBias = {};
for (const part of [1, 2, 3]) for (const after of [1, 2]) {
  const e = train.flatMap(s => s.proj).filter(p => p.part === part && p.after === after).map(p => p.err);
  // shrunk towards 0 with 50 laps' worth of weight, so a small sample cannot move it far
  partBias[`${part}.${after}`] = e.length ? +(e.reduce((a, b) => a + b, 0) / (e.length + 50)).toFixed(3) : 0;
}
console.log('part-bias (training, s):', JSON.stringify(partBias));
// ---- sigma-scale (after removing the part bias) ----
const sigmaScale = {};
for (const after of [1, 2]) {
  const z = train.flatMap(s => s.proj).filter(p => p.after === after && p.sigma).map(p => (p.err - (partBias[`${p.part}.${after}`] || 0)) / p.sigma);
  // Robust spread (so a few laps wrecked by traffic don't decide it): MAD × 1.4826.
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const m = med(z), mad = med(z.map(x => Math.abs(x - m))) * 1.4826, rms = Math.sqrt(z.reduce((a, x) => a + x * x, 0) / z.length);
  sigmaScale[after] = { laps: z.length, rmsZ: rms, robustZ: mad, within1: z.filter(x => Math.abs(x) <= 1).length / z.length, scale: +mad.toFixed(3) };
}
console.log('sigma-scale (training):', JSON.stringify(sigmaScale));

// ---- pole-temp ----
const temper = (ps, a) => { const w = ps.map(([k, p]) => [k, Math.pow(Math.max(p, 1e-6), a)]); const t = w.reduce((x, [, v]) => x + v, 0); return w.map(([k, v]) => [k, v / t]); };
const rowsOf = (ss, parts) => ss.flatMap(s => s.pole).filter(r => parts.includes(r.part) && r.stage !== 'last call');
const fitAlpha = rows => { let best = [1, Infinity]; for (let a = 0.3; a <= 3.001; a += 0.05) { const ll = probScores(rows.map(r => ({ ...r, ps: temper(r.ps, a) }))).logLoss; if (ll < best[1]) best = [+a.toFixed(2), ll]; } return best[0]; };
const alpha = { q3: fitAlpha(rowsOf(train, [3])), q12: fitAlpha(rowsOf(train, [1, 2])) };
console.log('pole-temp α (training):', JSON.stringify(alpha));

const report = {};
for (const [name, set] of [['training', train], ['held out', held], ['Qatar', qatar]]) {
  if (!set.length) continue;
  const prod = summarize(set);
  const cand = {};
  for (const [parts, a, label] of [[[3], alpha.q3, 'pole'], [[1, 2], alpha.q12, 'top of Q1/Q2']]) {
    const rows = rowsOf(set, parts);
    if (!rows.length) continue;
    cand[`${label}, all stages`] = { production: probScores(rows), 'pole-temp': probScores(rows.map(r => ({ ...r, ps: temper(r.ps, a) }))) };
  }
  const proj = {};
  for (const after of [1, 2]) {
    const e0 = set.flatMap(s => s.proj).filter(p => p.after === after);
    if (e0.length) proj[`bias-corrected after S${after}`] = { laps: e0.length, MAE: e0.reduce((a, p) => a + Math.abs(p.err), 0) / e0.length, 'MAE corrected': e0.reduce((a, p) => a + Math.abs(p.err - (partBias[`${p.part}.${after}`] || 0)), 0) / e0.length };
    const e = set.flatMap(s => s.proj).filter(p => p.after === after && p.sigma);
    if (!e.length) continue;
    const c = sigmaScale[after].scale;
    proj[`after S${after}`] = { laps: e.length, within1sigma: e.filter(p => Math.abs(p.err) <= p.sigma).length / e.length, 'within1sigma × scale': e.filter(p => Math.abs(p.err) <= p.sigma * c).length / e.length };
  }
  report[name] = { sessions: set.map(s => `${s.info.year} ${s.info.circuit_short_name} ${s.info.session_name}`), production: prod, poleTemp: cand, sigma: proj };
  console.log(`\n== ${name} (${set.length})`);
  for (const [k, v] of Object.entries(cand)) console.log(`  ${k.padEnd(26)} production ll ${v.production.logLoss.toFixed(3)} brier ${v.production.brier.toFixed(3)} ece ${v.production.ece.toFixed(3)} | pole-temp ll ${v['pole-temp'].logLoss.toFixed(3)} brier ${v['pole-temp'].brier.toFixed(3)} ece ${v['pole-temp'].ece.toFixed(3)}  (n ${v.production.n})`);
  for (const [k, v] of Object.entries(proj)) console.log(k.startsWith('bias') ? `  projection ${k}: MAE ${v.MAE.toFixed(3)} → ${v['MAE corrected'].toFixed(3)} (${v.laps} laps)` : `  projection ${k}: ${v.laps} laps, within ±1σ ${(100 * v.within1sigma).toFixed(0)}% → ×scale ${(100 * v['within1sigma × scale']).toFixed(0)}% (honest: 68%)`);
  for (const k of ['proj after S1', 'proj after S2']) if (prod[k]) console.log(`  ${k}: MAE ${prod[k].MAE.toFixed(3)} RMSE ${prod[k].RMSE.toFixed(3)} bias ${prod[k].bias.toFixed(3)} (${prod[k].laps} laps)`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ split: new Date(split).toISOString(), partBias, sigmaScale, alpha, report }, null, 1));

// Candidate scripts for the replay harness (CANDIDATE=<name> node tools/replay-eval.mjs …):
// they wrap the production functions in the page after it loads; production code is unchanged.
const wrap = (name, what, body) => `// Candidate "${name}" (written by tools/fit-quali.mjs, fitted on sessions before ${new Date(split).toISOString().slice(0, 10)}, Lusail excluded).
// ${what}
addEventListener('DOMContentLoaded', () => {
${body}
  window.pitwallCandidate = ${JSON.stringify(name)};
});
`;
fs.writeFileSync('models/candidates/proj-fit.js', wrap('proj-fit', 'Lap projection: part-specific bias removed (Q1 projects slow, Q3 fast) and uncertainty scaled per stage.', `  const B = ${JSON.stringify(partBias)}, S = ${JSON.stringify({ 1: sigmaScale[1].scale, 2: sigmaScale[2].scale })};
  const origLap = window.liveLap, origSig = window.projSigma;
  window.liveLap = n => { const lv = origLap(n); if (lv?.projected != null && lv.done >= 1) { const part = state.TimingData?.SessionPart || 1; lv.projected -= B[part + '.' + lv.done] || 0; } return lv; };
  window.projSigma = lv => origSig(lv) * (S[lv.done] ?? 1);`));
fs.writeFileSync('models/candidates/sigma-fit.js', wrap('sigma-fit', 'Lap projection uncertainty scaled per stage so errors/σ have spread 1 on training laps.', `  const S = ${JSON.stringify({ 1: sigmaScale[1].scale, 2: sigmaScale[2].scale })};
  const orig = window.projSigma;
  window.projSigma = lv => orig(lv) * (S[lv.done] ?? 1);`));
fs.writeFileSync('models/candidates/pole-temp.js', wrap('pole-temp', 'Pole / top-of-part chances: p ∝ p^α, renormalised (α for Q3, and for Q1/Q2).', `  const A = ${JSON.stringify(alpha)};
  const orig = window.poleCall;
  window.poleCall = () => { const p = orig(); if (!p) return p; const a = p.part === 3 ? A.q3 : A.q12; const w = p.cars.map(c => Math.pow(Math.max(c.ch, 1e-6), a)), t = w.reduce((x, y) => x + y, 0); p.cars.forEach((c, i) => { c.ch = c.ch > 0 ? w[i] / t : 0; }); return p; };`));
console.log('\nwrote models/candidates/sigma-fit.js and pole-temp.js');
