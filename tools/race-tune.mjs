// Tries the race call's main settings on past races and prints the best by log loss
// (lower is better: it punishes being sure and wrong). Slow: runs the test many times.
import { execFileSync } from 'node:child_process';
const grid = {
  paceSdModel: [0.25, 0.35, 0.45],
  lapNoise: [0.7, 1.0],
  pass: [0.8, 1.2],
  dnfPerLap: [0.0014, 0.002],
  temp: [0.8, 0.65],
};
const keys = Object.keys(grid);
const combos = keys.reduce((acc, k) => acc.flatMap(c => grid[k].map(v => ({ ...c, [k]: v }))), [{}]);
const res = [];
for (const c of combos) {
  const set = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(',');
  const year = process.argv.find(a => a.startsWith('--year='));
  const out = execFileSync(process.execPath, ['tools/race-backtest.mjs', '--quiet', `--set=${set}`, ...(year ? [year] : [])], { encoding: 'utf8' });
  const s = JSON.parse(out.match(/SCORE (.*)/)[1]);
  res.push({ ...c, ll: s.logloss });
  process.stderr.write('.');
}
res.sort((a, b) => a.ll - b.ll);
console.log('\nbest:'); for (const r of res.slice(0, 8)) console.log(JSON.stringify(r));
console.log('worst:', JSON.stringify(res.at(-1)));
