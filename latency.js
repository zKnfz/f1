// Latency monitor: measured, not estimated. Click the DELAY figure in the header to open it.
// Local steps use performance.now() (a monotonic clock). "F1 → received" compares F1's send
// time stamp with this computer's clock, so it is only as good as both clocks (macOS keeps its
// clock synced; F1's stamps are its own).
// Each figure shows P50 / P95 / P99 over the last 5 minutes and how many samples that is.
(function () {
  const WINDOW = 5 * 60000, CAP = 3000;
  const series = {};   // name -> [{at, v}]
  function note(name, v) {
    if (!isFinite(v)) return;
    const a = series[name] ??= [];
    a.push({ at: Date.now(), v });
    if (a.length > CAP) a.splice(0, a.length - CAP);
  }
  function stats(name) {
    const cut = Date.now() - WINDOW;
    const v = (series[name] || []).filter(x => x.at >= cut).map(x => x.v).sort((a, b) => a - b);
    const q = f => v.length ? v[Math.min(v.length - 1, Math.floor(f * v.length))] : null;
    return { n: v.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v.length ? v[v.length - 1] : null };
  }

  // ---- Feed pipeline: received → handlers and table redraw done → next frame ----
  let pending = [], frameQueued = false;
  function feed(detail, t0) {
    const sentAt = detail?.[2];
    if (sentAt) { const t = Date.parse(String(sentAt).replace(/(\.\d{3})\d+/, '$1')); if (isFinite(t)) note('f1ToReceived', Date.now() - t); }
    // The table redraw is queued as a microtask during dispatch; this one runs after it.
    queueMicrotask(() => note('processed', performance.now() - t0));
    pending.push(t0);
    if (!frameQueued) {
      frameQueued = true;
      requestAnimationFrame(() => {
        const now = performance.now();
        for (const t of pending) note('toFrame', now - t);
        pending = []; frameQueued = false;
      });
    }
  }

  // ---- Main thread: stalls and event-loop lag ----
  try { new PerformanceObserver(l => l.getEntries().forEach(e => note('longTask', e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
  let tick = performance.now();
  setInterval(() => { const now = performance.now(); if (!document.hidden) note('loopLag', Math.max(0, now - tick - 100)); tick = now; }, 100);

  // ---- Predictions: the pole call is the fast path, timed wherever it runs ----
  window.addEventListener('load', () => {
    if (typeof window.poleCall === 'function') {
      const f = window.poleCall;
      window.poleCall = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { note('poleCall', performance.now() - t); } };
    }
  });

  // ---- Kalshi: how old the latest prices are when they arrive here ----
  es.addEventListener('kalshi', e => { if (e.detail?.fetchMs != null) note('kalshiFetch', e.detail.fetchMs); });

  const ROWS = [
    ['f1ToReceived', 'F1 sent → received', 'F1\'s time stamp vs this computer\'s clock'],
    ['processed', 'Received → processed', 'all handlers and the timing table redraw'],
    ['toFrame', 'Received → on screen', 'until the next frame is drawn'],
    ['poleCall', 'Pole call compute', 'fast path, runs on each sector in qualifying'],
    ['raceCall', 'Race call compute', 'Monte Carlo, in the background worker'],
    ['raceCallTurnaround', 'Race call turnaround', 'asked → result back on the page'],
    ['kalshiFetch', 'Kalshi price fetch', 'request → prices received'],
    ['longTask', 'Main-thread stalls', 'tasks over 50 ms (anything here delays updates)'],
    ['loopLag', 'Event-loop lag', 'how late a 100 ms timer fires'],
  ];
  const fmt = v => v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v >= 10 ? Math.round(v) + ' ms' : v.toFixed(1) + ' ms';
  const panel = document.createElement('div'); panel.id = 'latPanel'; panel.hidden = true; document.body.appendChild(panel);
  function draw() {
    panel.innerHTML = `<div class="aphead"><b>Latency</b><span class="dimt">last 5 min · P50 / P95 / P99</span></div>
      <table class="lat"><thead><tr><th></th><th>P50</th><th>P95</th><th>P99</th><th>n</th></tr></thead><tbody>${ROWS.map(([k, label, hint]) => {
        const s = stats(k);
        return `<tr title="${hint}"><td>${label}<small>${hint}</small></td><td class="mono">${fmt(s.p50)}</td><td class="mono">${fmt(s.p95)}</td><td class="mono">${fmt(s.p99)}</td><td class="mono dimt">${s.n}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="note">Measured on this device. Being ahead of TV doesn't show being ahead of Kalshi; the Kalshi recordings do.</p>`;
  }
  const btn = document.getElementById('delay');
  if (btn) { btn.style.cursor = 'pointer'; btn.title = 'Click for the latency monitor'; btn.addEventListener('click', e => { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) draw(); }); }
  document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true; });
  setInterval(() => { if (!panel.hidden) draw(); }, 1000);

  window.pitwallLatency = { note, feed, stats, snapshot: () => Object.fromEntries(ROWS.map(([k]) => [k, stats(k)])) };
})();
