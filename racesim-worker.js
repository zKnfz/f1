// Runs the race call's Monte Carlo (racesim.js) off the page's main thread, so a new timing
// update never waits behind a 40-50 ms simulation. The page sends the inputs; this sends back
// the same result the page used to compute itself, plus how long it took.
importScripts('racesim.js' + self.location.search);
// Shadow models (challengers) run on the same inputs only after the production answer has been
// sent, so they never delay it. Their answers are recorded, never shown.
const PROD_P = { ...RaceSim.P }, PROD_CAL = JSON.parse(JSON.stringify(RaceSim.CAL));
self.onmessage = e => {
  const { id, inp, P, shadow } = e.data;
  const t0 = performance.now();
  try {
    Object.assign(RaceSim.P, PROD_P, P || {});
    const b = RaceSim.build(inp), res = RaceSim.run(b);
    self.postMessage({ id, ms: performance.now() - t0, version: RaceSim.VERSION, v: { ...res, inp, byN: Object.fromEntries(b.cars.map(c => [c.n, c])) } });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
    return;
  }
  for (const s of shadow || []) {
    const t1 = performance.now();
    try {
      Object.assign(RaceSim.P, PROD_P, P || {}, s.P || {});
      if (s.CAL) Object.assign(RaceSim.CAL, s.CAL);
      const r = RaceSim.run(RaceSim.build(inp));
      self.postMessage({ id, shadow: s.name, ms: performance.now() - t1, cars: r.cars.map(c => ({ n: c.n, win: c.win, top3: c.top3, top5: c.top5, top10: c.top10 })) });
    } catch (err) { self.postMessage({ id, shadow: s.name, error: String(err && err.message || err) }); }
    finally { Object.assign(RaceSim.P, PROD_P); Object.assign(RaceSim.CAL, JSON.parse(JSON.stringify(PROD_CAL))); }
  }
};
