// Automated tests: node --test tests/
// No dependencies; uses Node's built-in test runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RaceSim = require('../racesim.js');

// A plausible mid-race field: 20 cars, gaps growing down the order, mixed tyres.
function field(seed = 1, lapsLeft = 25) {
  let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cars = Array.from({ length: 20 }, (_, i) => {
    const pace = 92 + i * 0.08 + r() * 0.4;
    return { n: String(i + 1), pos: i + 1, gap: i * 2.5 + r(), out: false, compound: r() < 0.5 ? 'MEDIUM' : 'HARD',
      age: Math.floor(r() * 25), used: r() < 0.6 ? ['MEDIUM'] : ['MEDIUM', 'HARD'], qbest: 80 + i * 0.1,
      laps: Array.from({ length: 12 }, (_, l) => ({ time: pace + r() * 0.6, age: l + 1, stint: 0 })) };
  });
  return { lapsLeft, sprint: false, started: true, pitLoss: 22, scLoss: 12, ref: 93, cars };
}

test('race chances stay in order: win ≤ top 3 ≤ top 5 ≤ top 10, all in [0, 1]', () => {
  for (let seed = 1; seed <= 15; seed++) for (const left of [40, 20, 8, 2]) {
    const res = RaceSim.run(RaceSim.build(field(seed, left)), { runs: 1500 });
    for (const c of res.cars) {
      assert.ok(c.win <= c.top3 + 1e-9 && c.top3 <= c.top5 + 1e-9 && c.top5 <= c.top10 + 1e-9, `car ${c.n}: ${c.win} ${c.top3} ${c.top5} ${c.top10}`);
      for (const k of ['win', 'top3', 'top5', 'top10']) assert.ok(c[k] >= 0 && c[k] <= 1);
    }
  }
});

test('race chances add up to about 1 / 3 / 5 / 10 across the field', () => {
  const res = RaceSim.run(RaceSim.build(field(7, 30)), { runs: 2000 });
  const sum = k => res.cars.reduce((a, c) => a + c[k], 0);
  assert.ok(Math.abs(sum('win') - 1) < 0.05, 'win ' + sum('win'));
  assert.ok(Math.abs(sum('top3') - 3) < 0.15, 'top3 ' + sum('top3'));
  assert.ok(Math.abs(sum('top10') - 10) < 0.4, 'top10 ' + sum('top10'));
});

test('same inputs give the same answer (seeded, so the worker matches the page)', () => {
  const a = RaceSim.run(RaceSim.build(field(3)), { runs: 1000 }), b = RaceSim.run(RaceSim.build(field(3)), { runs: 1000 });
  assert.deepEqual(a.cars, b.cars);
});

test('no forced wear stop in the last laps: old softs at P2 with 5 to go (Las Vegas 2026)', () => {
  const inp = field(5, 5);
  Object.assign(inp.cars[1], { compound: 'SOFT', age: 28, used: ['MEDIUM', 'SOFT'] });
  const b = RaceSim.build(inp), car = b.cars.find(c => c.n === '2');
  assert.ok(car.pExtra < 0.3, 'chance of a wear stop ' + car.pExtra);
  const res = RaceSim.run(b, { runs: 2000 });
  assert.ok(res.cars.find(c => c.n === '2').top5 > 0.5);
});

test('F1 TV sign-in: cookie value or token accepted, anything else refused', async () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const parse = new Function('return ' + src.match(/function parseF1tv[\s\S]*?\n}/)[0])();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig-_';
  assert.equal(parse(encodeURIComponent(JSON.stringify({ data: { subscriptionToken: jwt } }))), jwt);
  assert.equal(parse(jwt), jwt);
  assert.equal(parse('nonsense'), null);
  assert.equal(parse(''), null);
});

test('Kalshi Worker: only this site, only F1 markets, GET only', async () => {
  const w = (await import('../worker/kalshi-worker.js')).default;
  const call = (path, origin, method = 'GET') => w.fetch(new Request('https://x.workers.dev' + path, { method, headers: origin ? { Origin: origin } : {} }));
  assert.equal((await call('/prices?events=KXF1POLE-LUSA26', 'https://evil.example')).status, 403);
  assert.equal((await call('/prices?events=KXNBAGAME-ABC', 'https://zknfz.github.io')).status, 400);
  assert.equal((await call('/events?series=KXBTC', 'https://zknfz.github.io')).status, 400);
  assert.equal((await call('/prices?events=KXF1POLE-LUSA26', 'https://zknfz.github.io', 'POST')).status, 405);
  assert.equal((await call('/anything', 'https://zknfz.github.io')).status, 404);
});
