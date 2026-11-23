// Runs the race call's Monte Carlo (racesim.js) off the page's main thread, so a new timing
// update never waits behind a 40-50 ms simulation. The page sends the inputs; this sends back
// the same result the page used to compute itself, plus how long it took.
importScripts('racesim.js' + self.location.search);
self.onmessage = e => {
  const { id, inp, P } = e.data;
  const t0 = performance.now();
  try {
    Object.assign(RaceSim.P, P || {});
    const b = RaceSim.build(inp), res = RaceSim.run(b);
    self.postMessage({ id, ms: performance.now() - t0, v: { ...res, inp, byN: Object.fromEntries(b.cars.map(c => [c.n, c])) } });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
