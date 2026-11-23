// Scores the production race model against its shadow challengers on recorded sessions.
//   node tools/evaluate-shadow.mjs            all recordings in data/rec with race calls
// For each race call recorded live (page.jsonl: kind race, and kind shadow with the same id),
// compares the chances with the final classification (the recording's last state) and reports
// log loss and Brier score per model and market. Lower is better. A challenger should only be
// promoted (racesim.js, models/registry.json) when it is better across sessions it was not
// tuned on, and only between race weekends.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, stateAt } from '../recorder.mjs';

const root = path.resolve('data/rec');
const dirs = fs.existsSync(root) ? fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.readdirSync(d).some(f => f.startsWith('page.jsonl'))) : [];
const K = ['win', 'top3', 'top5', 'top10'], CUT = { win: 1, top3: 3, top5: 5, top10: 10 };
const score = {}; // model -> market -> {ll, br, n}
const add = (model, mk, p, y) => { const s = (score[model] ??= {})[mk] ??= { ll: 0, br: 0, n: 0 }; const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); s.ll += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); s.br += (p - y) ** 2; s.n++; };
let sessions = 0;
for (const dir of dirs) {
  const page = readJsonl(dir, 'page.jsonl');
  const race = page.filter(p => p.kind === 'race'), shadow = page.filter(p => p.kind === 'shadow' && p.cars);
  if (!race.length) continue;
  const { state } = await stateAt(dir);
  if (!/Finished|Finalised|Ends/.test(state.SessionStatus?.Status || '')) { console.log('skipped (not finished):', path.basename(dir)); continue; }
  const fin = {}; for (const [n, L] of Object.entries(state.TimingData?.Lines || {})) if (!L.Retired && +L.Position) fin[state.DriverList?.[n]?.Tla] = +L.Position;
  sessions++;
  const byId = {}; for (const r of race) byId[r.id] = r;
  for (const r of race) for (const c of r.cars) K.forEach((k, i) => add('production', k, c[2 + i], (fin[c[0]] ?? 99) <= CUT[k] ? 1 : 0));
  for (const s of shadow) if (byId[s.id]) for (const c of s.cars) K.forEach((k, i) => add(s.name, k, c[1 + i], (fin[c[0]] ?? 99) <= CUT[k] ? 1 : 0));
}
if (!sessions) { console.log('No finished races with recorded race calls yet.'); process.exit(0); }
console.log(`${sessions} race session(s). Log loss (Brier) per market; lower is better.`);
for (const [m, s] of Object.entries(score)) console.log(`${m.padEnd(20)} ${K.map(k => s[k] ? `${k} ${(s[k].ll / s[k].n).toFixed(3)} (${(s[k].br / s[k].n).toFixed(3)})` : '').join('  ')}  n=${s.win?.n ?? 0}`);
