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

// ---------- Recording and replay ----------
import os from 'node:os';
import path from 'node:path';
import { createRecorder, readFeed, stateAt } from '../recorder.mjs';

const frameOf = (topic, data, sent) => JSON.stringify({ type: 1, target: 'feed', arguments: [topic, data, sent] });
async function sampleRecording() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-'));
  const rec = createRecorder({ dataDir: tmp, log: () => {} });
  const snapshot = JSON.stringify({ type: 3, invocationId: '0', result: { SessionInfo: { Key: 9, Name: 'Qualifying', Meeting: { Name: 'Test GP' } }, TimingData: { Lines: { '1': { Position: '1', NumberOfLaps: 3 } } } } });
  rec.frame(1, snapshot, 1000);            // arrives before the session is known: held, then written
  rec.open({ Key: 9, Name: 'Qualifying', Meeting: { Name: 'Test GP' }, StartDate: '2026-11-28T16:00:00' });
  const u1 = frameOf('TimingData', { Lines: { '1': { NumberOfLaps: 4 } } }, '2026-11-28T16:00:01.000Z');
  rec.frame(1, u1, 2000); rec.frame(2, u1, 2005); // same update from two connections
  rec.frame(1, frameOf('TimingData', { Lines: { '1': { Position: '2' } } }, '2026-11-28T16:00:02.000Z'), 3000);
  rec.page({ kind: 'pole', cars: [] });
  rec.close('test');
  await new Promise(r => setTimeout(r, 100));
  return path.join(tmp, 'rec', fs.readdirSync(path.join(tmp, 'rec'))[0]);
}

test('recorder: every frame is written with receipt time and connection, in order', async () => {
  const dir = await sampleRecording();
  const got = []; for await (const f of readFeed(path.join(dir, 'feed.tsv'))) got.push(f);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map(f => f.r), [1000, 2000, 2005, 3000]);
  assert.deepEqual(got.map(f => f.c), ['1', '1', '2', '1']);
  assert.ok(fs.readFileSync(path.join(dir, 'page.jsonl'), 'utf8').includes('"kind":"pole"'));
  assert.ok(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('"ev":"open"'));
});

test('replay: state at a moment uses only what had arrived by then, duplicates counted once', async () => {
  const dir = await sampleRecording();
  const at1 = await stateAt(dir, 1500), at2 = await stateAt(dir, 2500), end = await stateAt(dir);
  assert.equal(at1.state.TimingData.Lines['1'].NumberOfLaps, 3);
  assert.equal(at2.state.TimingData.Lines['1'].NumberOfLaps, 4);
  assert.equal(at2.updates, 1); // the copy from connection 2 is not applied twice
  assert.equal(end.state.TimingData.Lines['1'].Position, '2');
});

test('replay: a line cut short by a crash is skipped, the rest still read', async () => {
  const dir = await sampleRecording();
  fs.appendFileSync(path.join(dir, 'feed.tsv'), '4000\t12.5\t1\t{"type":1,"tar'); // no newline, cut off
  const got = []; for await (const f of readFeed(path.join(dir, 'feed.tsv'))) got.push(f);
  assert.equal(got.length, 4);
  const end = await stateAt(dir);
  assert.equal(end.state.TimingData.Lines['1'].Position, '2');
});

test('restart: a second recorder appends to the same session folder', async () => {
  const dir = await sampleRecording();
  const dataDir = path.dirname(path.dirname(dir));
  const rec2 = createRecorder({ dataDir, log: () => {} });
  rec2.open({ Key: 9, Name: 'Qualifying', Meeting: { Name: 'Test GP' }, StartDate: '2026-11-28T16:00:00' });
  rec2.frame(1, frameOf('TimingData', { Lines: { '1': { Position: '1' } } }, '2026-11-28T16:00:05.000Z'), 6000);
  rec2.close('test'); await new Promise(r => setTimeout(r, 100));
  const got = []; for await (const f of readFeed(path.join(dir, 'feed.tsv'))) got.push(f);
  assert.equal(got.length, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).relayRuns.length, 2);
});

// ---------- Same answer on every machine ----------
import { compute as goldenRows, compare as goldenCompare, FILE as GOLDEN } from './golden.mjs';
test('race call matches the reference answer (Mac, Linux ARM, browser)', () => {
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(g.version, RaceSim.VERSION, 'model version changed: run node tests/golden.mjs --write after checking the change');
  const c = goldenCompare(goldenRows(), g.rows);
  assert.ok(c.same, 'largest difference ' + c.max);
});

test('restart after a crash mid-line: the first line after the restart is kept', async () => {
  const dir = await sampleRecording();
  fs.appendFileSync(path.join(dir, 'feed.tsv'), '4000\t12.5\t1\t{"type":1,"tar'); // crash mid-write
  const rec2 = createRecorder({ dataDir: path.dirname(path.dirname(dir)), log: () => {} });
  rec2.open({ Key: 9, Name: 'Qualifying', Meeting: { Name: 'Test GP' }, StartDate: '2026-11-28T16:00:00' });
  rec2.frame(1, frameOf('TimingData', { Lines: { '1': { Position: '7' } } }, '2026-11-28T16:00:05.000Z'), 6000);
  rec2.close('test'); await new Promise(r => setTimeout(r, 100));
  assert.equal((await stateAt(dir)).state.TimingData.Lines['1'].Position, '7');
});

test('compressed recordings read back identically, including after more is appended', async () => {
  const { compactFolder } = await import('../tools/compact-recordings.mjs');
  const dir = await sampleRecording();
  const before = JSON.stringify(await stateAt(dir));
  compactFolder(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'feed.tsv')) && fs.existsSync(path.join(dir, 'feed.tsv.gz')));
  assert.equal(JSON.stringify(await stateAt(dir)), before);
  // The relay reopens the session (restart) and writes more: plain file after the .gz
  const rec2 = createRecorder({ dataDir: path.dirname(path.dirname(dir)), log: () => {} });
  rec2.open({ Key: 9, Name: 'Qualifying', Meeting: { Name: 'Test GP' }, StartDate: '2026-11-28T16:00:00' });
  rec2.frame(1, frameOf('TimingData', { Lines: { '1': { Position: '5' } } }, '2026-11-28T16:00:09.000Z'), 9000);
  rec2.close('test'); await new Promise(r => setTimeout(r, 100));
  assert.equal((await stateAt(dir)).state.TimingData.Lines['1'].Position, '5');
  compactFolder(dir); // second compaction appends a second gzip part
  assert.equal((await stateAt(dir)).state.TimingData.Lines['1'].Position, '5');
  const got = []; for await (const f of readFeed(dir)) got.push(f.r);
  assert.deepEqual(got, [1000, 2000, 2005, 3000, 9000]);
});

// ---------- Collector → backend transport ----------
import { sign as tSign, verify as tVerify, DIR_RE } from '../transport.mjs';
test('transport: signed requests verify; any change, wrong secret or old time is refused', () => {
  const S = 'k'.repeat(64), body = Buffer.from('line\n'), now = Date.now();
  const h = tSign(S, 'home-pi', 'POST', '/v1/append?dir=x&file=feed.tsv&offset=0', body, now);
  assert.equal(tVerify(S, h, 'POST', '/v1/append?dir=x&file=feed.tsv&offset=0', body, now), 'home-pi');
  assert.throws(() => tVerify(S, h, 'POST', '/v1/append?dir=x&file=feed.tsv&offset=5', body, now));   // offset changed
  assert.throws(() => tVerify(S, h, 'POST', '/v1/append?dir=x&file=feed.tsv&offset=0', Buffer.from('other\n'), now));
  assert.throws(() => tVerify('j'.repeat(64), h, 'POST', '/v1/append?dir=x&file=feed.tsv&offset=0', body, now));
  assert.throws(() => tVerify(S, h, 'POST', '/v1/append?dir=x&file=feed.tsv&offset=0', body, now + 6 * 60000));
  assert.ok(DIR_RE.test('2026-qatar-grand-prix-qualifying-11423') && DIR_RE.test('_unsessioned/2026-11-27'));
  for (const bad of ['../etc', '2026-x/../../y', '/abs', '', '2026-qatar-grand-prix-qualifying-11423/x']) assert.ok(!DIR_RE.test(bad), bad);
});

// ---------- Training data: nothing from the future ----------
test('dataset rows use only what was known at their cutoff (no look-ahead)', async () => {
  const { lapRows } = await import('../tools/build-dataset.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-ds-'));
  const rec = createRecorder({ dataDir: tmp, log: () => {} });
  const info = { Key: 7, Name: 'Qualifying', Type: 'Qualifying', Meeting: { Name: 'Leak GP' }, StartDate: '2026-11-28T16:00:00' };
  rec.frame(1, JSON.stringify({ type: 3, invocationId: '0', result: { SessionInfo: info, TimingData: { Lines: { '4': { NumberOfLaps: 2, Sectors: [{ Value: '' }, { Value: '' }, { Value: '' }] } } }, TimingStats: { Lines: { '4': { BestSectors: [{ Value: '30.000' }, { Value: '31.000' }, { Value: '32.000' }] } } } } }), 1000);
  rec.open(info);
  rec.frame(1, frameOf('TimingData', { Lines: { '4': { Sectors: { 0: { Value: '29.500' } } } } }, 'a'), 2000);           // S1
  rec.frame(1, frameOf('TimingStats', { Lines: { '4': { BestSectors: { 0: { Value: '29.500' } } } } }, 'a'), 2001);
  rec.frame(1, frameOf('TimingData', { Lines: { '4': { Sectors: { 1: { Value: '30.100' } } } } }, 'a'), 3000);           // S2
  rec.frame(1, frameOf('TimingStats', { Lines: { '4': { BestSectors: { 1: { Value: '30.100' } } } } }, 'a'), 3001);
  rec.frame(1, frameOf('TimingData', { Lines: { '4': { Sectors: { 2: { Value: '31.900' } }, LastLapTime: { Value: '1:31.500' }, NumberOfLaps: 3 } } }, 'a'), 4000);
  rec.close('t'); await new Promise(r => setTimeout(r, 100));
  const dir = path.join(tmp, 'rec', fs.readdirSync(path.join(tmp, 'rec'))[0]);
  const rows = await lapRows(dir);
  assert.equal(rows.length, 2);
  const [s1, s2] = rows;
  assert.equal(s1.after, 'S1'); assert.equal(s1.cutoff, 2000);
  assert.deepEqual(s1.sectors, [29.5, null, null]);          // S2 had not happened
  assert.deepEqual(s1.pbSectors, [30, 31, 32]);              // best S1 not yet updated at 2000 (it came at 2001)
  assert.deepEqual(s2.sectors, [29.5, 30.1, null]);
  assert.deepEqual(s2.pbSectors, [29.5, 31, 32]);            // knows the new best S1 (2001 < 3000), not S2's (3001)
  assert.equal(s1.label.lapTime, 91.5); assert.equal(s1.label.knownAt, 4000);
  assert.ok(rows.every(r => r.label.knownAt > r.cutoff));
});

test('recorder: idle closes the session folder (so it can be backed up); resuming reopens it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-idle-'));
  const rec = createRecorder({ dataDir: tmp, log: () => {} });
  const info = { Key: 5, Name: 'Race', Meeting: { Name: 'Idle GP' }, StartDate: '2026-11-22T06:00:00' };
  rec.open(info); rec.frame(1, 'a', 1000);
  assert.ok(rec.stats());
  rec.setIdle(true);
  assert.equal(rec.stats(), null);   // /api/recording reports nothing active: compaction may proceed
  rec.frame(1, 'ignored', 2000);
  rec.setIdle(false);
  rec.frame(1, 'b', 3000);                 // straight away: held until the folder is reopened
  await new Promise(r => setTimeout(r, 100));
  assert.ok(rec.stats()); rec.close('t');
  await new Promise(r => setTimeout(r, 100));
  const dir = path.join(tmp, 'rec', fs.readdirSync(path.join(tmp, 'rec'))[0]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'feed.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t')[3]), ['a', 'b']);
  const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.match(evs, /"idle"/); assert.match(evs, /"resumed"/);
});

// ---------- Public model distribution ----------
test('learned/ as committed passes the sharing checks', async () => {
  const { validate } = await import('../tools/validate-learned.mjs');
  assert.deepEqual(validate().problems, []);
});
test('sharing checks refuse private or broken files', async () => {
  const { validate } = await import('../tools/validate-learned.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-learned-'));
  const A = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 10 : 0)));
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify({ files: {} }));
  fs.writeFileSync(path.join(d, 'pitwall-model-v4-150-quali.json'), JSON.stringify({ key: 'pitwall-model-v4-150-quali', A, b: [0, 0, 0, 0, 0, 0], laps: 3 }));
  assert.deepEqual(validate(d).problems, []);
  fs.writeFileSync(path.join(d, 'pitwall-calib-v1.json'), JSON.stringify({ pts: [[0.5, 1]], note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' }));
  fs.writeFileSync(path.join(d, 'pitwall-qpace-9.json'), JSON.stringify({ key: 'pitwall-qpace-9', best: { 1: 1e9 } }));
  fs.writeFileSync(path.join(d, 'pitwall-model-v4-150-race.json'), JSON.stringify({ key: 'pitwall-model-v4-150-race', A, b: [5, 0, 0, 0, 0, 0], laps: 3 }));
  fs.writeFileSync(path.join(d, 'stolen.json'), JSON.stringify({ 'Position.z': 'x' }));
  const p = validate(d).problems.join('\n');
  assert.match(p, /calib.*token/); assert.match(p, /qpace.*50–200/); assert.match(p, /150-race.*implausible/); assert.match(p, /stolen.*telemetry/);
});
