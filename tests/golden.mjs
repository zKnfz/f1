// A fixed race-call input and the exact answer this model gives for it, so any machine
// (the Mac, the Linux ARM server, a browser) can check it computes the same chances.
//   node tests/golden.mjs --write   after a deliberate model change (racesim.js VERSION bump)
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RaceSim = require('../racesim.js');
export const FILE = new URL('./fixtures/race-golden.json', import.meta.url);

export function goldenInput() {
  let s = 11; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cars = Array.from({ length: 20 }, (_, i) => {
    const pace = 92 + i * 0.08 + r() * 0.4;
    return { n: String(i + 1), pos: i + 1, gap: i * 2.5 + r(), out: false, compound: r() < 0.5 ? 'MEDIUM' : 'HARD',
      age: Math.floor(r() * 25), used: r() < 0.6 ? ['MEDIUM'] : ['MEDIUM', 'HARD'], qbest: 80 + i * 0.1,
      laps: Array.from({ length: 12 }, (_, l) => ({ time: pace + r() * 0.6, age: l + 1, stint: 0 })) };
  });
  return { lapsLeft: 18, sprint: false, started: true, pitLoss: 22, scLoss: 12, ref: 93, cars };
}
// The chances as [n, win, top3, top5, top10] rows.
export const rowsOf = cars => cars.map(c => [c.n, c.win, c.top3, c.top5, c.top10]);
export function compute() { return rowsOf(RaceSim.run(RaceSim.build(goldenInput())).cars); }
// Different JavaScript engines (Node's and Chrome's are different V8 versions) can differ in the
// last binary digit of a few values (seen: 2.2e-16). Anything above 1e-12 is a real difference.
export const TOL = 1e-12;
export function compare(rows, ref) {
  let max = 0;
  if (rows.length !== ref.length) return { same: false, exact: false, max: Infinity };
  rows.forEach((r, i) => { if (r[0] !== ref[i][0]) max = Infinity; for (let k = 1; k < 5; k++) max = Math.max(max, Math.abs(r[k] - ref[i][k])); });
  return { same: max <= TOL, exact: max === 0, max };
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(FILE, JSON.stringify({ version: RaceSim.VERSION, rows: compute(), madeOn: `${process.platform}-${process.arch} node ${process.version}` }, null, 1) + '\n');
  console.log('written', FILE.pathname);
}
