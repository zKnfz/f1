// Kalshi prices on the public site. Kalshi blocks websites from reading its API directly, so
// the site asks a small Cloudflare Worker (worker/kalshi-worker.js) that passes on Kalshi's
// public F1 prices. With the local relay this file does nothing: the relay sends the prices.
// The prices go out as the same 'kalshi' event the relay sends, so the Race call and Pole call
// show "K 44¢" either way.
(function () {
  const WORKER = 'https://pitwall-kalshi.zknfzpitwall.workers.dev';
  const url = (() => { try { return localStorage.getItem('pitwall-kalshi-url') || WORKER; } catch { return WORKER; } })();
  if (/REPLACE/.test(url)) return;
  const SERIES = {
    Qualifying: { pole: 'KXF1POLE' },
    'Sprint Qualifying': { pole: 'KXF1SPRINTPOLE' },
    'Sprint Shootout': { pole: 'KXF1SPRINTPOLE' },
    Race: { win: 'KXF1RACE', top3: 'KXF1RACEPODIUM', top5: 'KXF1TOP5', top10: 'KXF1TOP10' },
    Sprint: { win: 'KXF1RACESPRINT', top5: 'KXF1SPRINTTOP5', top10: 'KXF1SPRINTTOP10' },
  };
  const words = s => String(s || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !['grand', 'prix'].includes(w));
  const get = async path => { const r = await fetch(url + path, { cache: 'no-store' }); if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status }); return r.json(); };

  let key = null, setupAt = 0, events = {}, slowUntil = 0;
  async function setup(info) {
    key = info.Key; setupAt = Date.now(); events = {};
    const want = new Set([...words(info.Meeting?.Name), ...words(info.Meeting?.Location), ...words(info.Meeting?.Country?.Name), ...words(info.Meeting?.Circuit?.ShortName)]);
    for (const [m, series] of Object.entries(SERIES[info.Name] || {})) {
      try {
        const d = await get(`/events?series=${series}`);
        const ok = (d.events || []).filter(e => words(e.title + ' ' + e.sub_title).some(w => want.has(w)));
        const e = ok.find(e => !/settled|finalized|closed/i.test(e.status || '')) || ok[0];
        if (e) events[m] = e.event_ticker;
      } catch {}
    }
  }
  async function poll() {
    if (!DIRECT) return; // the relay does it
    const info = state.SessionInfo;
    if (!info?.Key || Date.now() < slowUntil) return;
    if (info.Key !== key || (!Object.keys(events).length && Date.now() - setupAt > 300000)) await setup(info);
    if (/Finalised|Ends/.test(state.SessionStatus?.Status || '') || !Object.keys(events).length) return;
    try {
      const t0 = performance.now();
      const d = await get(`/prices?events=${Object.values(events).join(',')}`);
      const fetchMs = performance.now() - t0;
      const prices = {};
      for (const [m, ev] of Object.entries(events)) if (d.prices?.[ev]) prices[m] = d.prices[ev];
      es.dispatchEvent(new CustomEvent('kalshi', { detail: { at: Date.now(), prices, fetchMs } }));
    } catch (e) { if (e.status === 429) slowUntil = Date.now() + 10000; }
  }
  // Every 1.5 s while the page is visible, every 10 s when it is in the background.
  const loop = async () => { try { await poll(); } catch {} setTimeout(loop, document.hidden ? 10000 : 1500); };
  setTimeout(loop, 2000);
})();
