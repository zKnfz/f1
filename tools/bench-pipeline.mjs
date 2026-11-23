// Benchmarks the page's live pipeline in headless Chrome against the local relay.
// Usage: node server.mjs &  then  node tools/bench-pipeline.mjs [label]
// It replays timing updates into the loaded page, mid-race, and measures with performance.now():
//   · update → handlers done (feed processing incl. table redraw)
//   · update → next frame (when it can be on screen)
//   · the race call (Monte Carlo) and pole call compute times
//   · main-thread stalls (long tasks > 50 ms) while alerts and timers run as in a live race
import { chromium } from '../node_modules/playwright-core/index.mjs';
const label = process.argv[2] || 'run';
const channel = process.env.CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : '');
const b = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto('http://127.0.0.1:8765/', { waitUntil: 'load' });
await p.waitForTimeout(5000);
const r = await p.evaluate(async () => {
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2) : null; };
  const stats = a => ({ n: a.length, p50: q(a, 0.5), p95: q(a, 0.95), p99: q(a, 0.99), max: a.length ? +Math.max(...a).toFixed(2) : null });
  // Mid-race: lap 25 of 50, session running.
  state.LapCount = { CurrentLap: 25, TotalLaps: 50 };
  state.SessionStatus = { Status: 'Started' };
  state.RaceControlMessages = { Messages: [] };
  const long = []; new PerformanceObserver(l => l.getEntries().forEach(e => long.push(e.duration))).observe({ entryTypes: ['longtask'] });
  // Replay 400 timing updates (one driver's sector / gap each) at ~40 per second.
  const nums = Object.keys(state.TimingData.Lines), proc = [], toFrame = [];
  for (let i = 0; i < 400; i++) {
    const n = nums[i % nums.length], t0 = performance.now();
    (typeof emit === 'function' ? emit : (t, d) => es.dispatchEvent(new CustomEvent(t, { detail: d })))('feed', ['TimingData', { Lines: { [n]: { Sectors: { [i % 3]: { Value: (28 + Math.random()).toFixed(3) } }, IntervalToPositionAhead: { Value: '+' + (Math.random() * 3).toFixed(3) } } } }, new Date().toISOString()]);
    await Promise.resolve(); // let the microtask redraw run
    proc.push(performance.now() - t0);
    requestAnimationFrame(() => toFrame.push(performance.now() - t0));
    await wait(25);
  }
  await wait(6000); // let the 5-second timers (alerts' race call) run as they would live
  const longDuringReplay = long.slice();
  // Race call compute on the main thread (fresh inputs each time), measured after the replay.
  const rc = [];
  for (let i = 0; i < 8; i++) { raceMemo = { id: null, v: null }; const t = performance.now(); const v = raceCall(); rc.push(performance.now() - t); await wait(200); }
  // Race call answer: worker vs computing directly on the page (seeded, so they must match).
  let same = null;
  if (typeof raceWorker !== 'undefined' && raceWorker) {
    raceCall(); await wait(1500); const v = raceCall();
    if (v) { const b = RaceSim.build(v.inp), d = RaceSim.run(b); same = JSON.stringify(d.cars) === JSON.stringify(v.cars); }
  }
  return { workerResultMatches: same, latencyMonitor: window.pitwallLatency?.snapshot(), raceCallMainThreadMs: stats(rc), updateProcessedMs: stats(proc), updateToFrameMs: stats(toFrame), longTasksMs: stats(longDuringReplay) };
});
console.log(label, JSON.stringify(r, null, 1));
await b.close();
