// Records what the site predicted, for replay and model training. Runs only on the recorder's
// headless page (the relay starts it for each session), so viewers' pages do no extra work.
// Sends batches to the local relay (http://127.0.0.1:8765/api/record), which writes data/rec/<session>/page.jsonl.
//   models  production model versions and the learned lap-projection weights (start, every 5 min)
//   race    the race call each time a new one is ready (all drivers, all four markets)
//   shadow  challenger models' race calls on the same inputs (never shown)
//   pole    the pole call whenever it changes (chance, best, projected lap, why)
//   alert   every alert shown
// Each record carries the page's clock (pt, epoch ms) and monotonic clock (pm); the relay adds
// its own receipt time.
(function () {
  if (typeof DIRECT === 'undefined') return;
  const isRecorder = navigator.webdriver === true;
  let queue = [];
  const push = rec => { if (isRecorder) queue.push({ pt: Date.now(), pm: +performance.now().toFixed(1), session: state.SessionInfo?.Key ?? null, ...rec }); };
  setInterval(() => {
    if (!queue.length) return;
    const body = JSON.stringify(queue); queue = [];
    // The recorder's page may run on its own server, so post to the relay's address directly.
    fetch(DIRECT ? 'http://127.0.0.1:8765/api/record' : 'api/record', { method: 'POST', body, mode: DIRECT ? 'no-cors' : 'cors', keepalive: true }).catch(() => {});
  }, 500);
  if (!isRecorder) return;

  // Challengers for shadow mode (models/registry.json).
  fetch('models/registry.json', { cache: 'no-store' }).then(r => r.json()).then(reg => { window.pitwallShadow = reg.shadow || {}; push({ kind: 'registry', registry: reg }); }).catch(() => {});

  const models = () => {
    let quali = null;
    try { const m = modelInfo(); quali = { version: 'quali-proj-v4', laps: m.laps, theta: m.theta }; } catch {}
    push({ kind: 'models', race: { version: window.RaceSim?.VERSION, P: window.RaceSim?.P, CAL: window.RaceSim?.CAL }, quali });
  };
  setTimeout(models, 3000); setInterval(models, 300000);

  const r4 = x => Math.round(x * 10000) / 10000;
  es.addEventListener('racecall', () => {
    const r = raceMemo?.v; if (!r) return;
    push({ kind: 'race', id: raceMemo.id, version: window.RaceSim?.VERSION, lap: r.inp?.cur, lapsLeft: r.inp?.lapsLeft, sc: r.sc,
      cars: r.cars.map(c => [dInfo(c.n).code, c.pos, r4(c.win), r4(c.top3), r4(c.top5), r4(c.top10), c.owed ?? null]) });
  });
  es.addEventListener('raceshadow', e => {
    const d = e.detail; if (d.error) return push({ kind: 'shadow', name: d.shadow, error: d.error });
    push({ kind: 'shadow', id: d.id, name: d.shadow, ms: +d.ms.toFixed(1), cars: d.cars.map(c => [dInfo(c.n).code, r4(c.win), r4(c.top3), r4(c.top5), r4(c.top10)]) });
  });
  let lastPole = '';
  es.addEventListener('polecall', e => {
    const p = e.detail;
    const cars = p.cars.map(c => [dInfo(c.n).code, r4(c.ch), c.best ?? null, c.lap ? +c.lap.m.toFixed(3) : null, String(c.why || '').replace(/<[^>]+>/g, '')]);
    const sig = JSON.stringify([p.part, cars]);
    if (sig === lastPole) return; lastPole = sig;
    push({ kind: 'pole', part: p.part, settled: p.settled, cars });
  });
  es.addEventListener('alert', e => push({ kind: 'alert', ...e.detail }));
})();
