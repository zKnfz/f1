// Kalshi prices for the session that is on, read from Kalshi's public market data (no account,
// no key, read only: this never trades). The relay polls them, sends them to the page and
// records every change next to the site's own figures, so a session can be replayed afterwards:
// what the site said, what Kalshi said, and how many seconds apart.
//
// Kalshi blocks other websites from reading its API, so only the relay can do this; the page
// served by the relay (http://127.0.0.1:8765) shows the prices, the GitHub site doesn't.
import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const EVERY = 1500; // ms between price checks for each market
// Kalshi series for each kind of session, and which figure on the site they match.
const SERIES = {
  Qualifying: { pole: 'KXF1POLE' },
  'Sprint Qualifying': { pole: 'KXF1SPRINTPOLE' },
  'Sprint Shootout': { pole: 'KXF1SPRINTPOLE' },
  Race: { win: 'KXF1RACE', top3: 'KXF1RACEPODIUM', top5: 'KXF1TOP5', top10: 'KXF1TOP10' },
  Sprint: { win: 'KXF1RACESPRINT', top5: 'KXF1SPRINTTOP5', top10: 'KXF1SPRINTTOP10' },
};

async function get(url) {
  const r = await fetch(API + url, { headers: { Accept: 'application/json', 'User-Agent': 'pitwall-live-timing' } });
  if (r.status === 429) throw Object.assign(new Error('rate limited'), { slow: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const cents = v => (v == null || v === '' ? null : Math.round(parseFloat(v) * 100));
const words = s => String(s || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !['grand', 'prix'].includes(w));

// The open event in a series that belongs to this meeting ("Lusail", "Qatar", "Las Vegas"…).
async function findEvent(series, info) {
  const want = new Set([...words(info.Meeting?.Name), ...words(info.Meeting?.Location), ...words(info.Meeting?.Country?.Name), ...words(info.Meeting?.Circuit?.ShortName)]);
  const d = await get(`/events?series_ticker=${series}&limit=10`);
  const ok = (d.events || []).filter(e => words(e.title + ' ' + e.sub_title).some(w => want.has(w)));
  return ok.find(e => !/settled|finalized|closed/i.test(e.status || '')) || ok[0] || null;
}

export function startKalshi({ getState, broadcast, dataDir, recDir = () => null, enabled = true }) {
  let setupAt = 0, sessionKey = null, events = {}, prices = {}, file = null, lastSite = 0, timer = null, slowUntil = 0;
  // Into the session's recording folder when there is one (recorder.mjs), else data/.
  const write = rec => { const f = recDir() ? path.join(recDir(), 'kalshi.jsonl') : file; return f && fs.appendFile(f, JSON.stringify(rec) + '\n').catch(() => {}); };

  async function setup(info) {
    sessionKey = info.Key; setupAt = Date.now(); events = {}; prices = {};
    file = path.join(dataDir, `kalshi-${sessionKey}.jsonl`);
    const map = SERIES[info.Name] || {};
    for (const [m, series] of Object.entries(map)) {
      try {
        const e = await findEvent(series, info);
        if (e) events[m] = e.event_ticker;
      } catch (err) { console.log(new Date().toISOString(), 'kalshi: could not look up', series, err.message); }
    }
    const found = Object.entries(events).map(([m, t]) => `${m} ${t}`).join(', ');
    console.log(new Date().toISOString(), found ? `kalshi: recording ${found}` : `kalshi: no open markets found for ${info.Meeting?.Name} ${info.Name}`);
    if (found) write({ t: Date.now(), type: 'start', session: `${info.Meeting?.Name} ${info.Name}`, events });
  }

  async function poll() {
    const st = getState(), info = st.SessionInfo;
    if (!info?.Key) return;
    // Markets sometimes open late: look again every 5 minutes until some are found.
    if (info.Key !== sessionKey || (!Object.keys(events).length && Date.now() - setupAt > 300000)) await setup(info);
    if (/Finalised|Ends/.test(st.SessionStatus?.Status || '') || Date.now() < slowUntil) return;
    let fetchMs = null;
    for (const [m, ev] of Object.entries(events)) {
      try {
        const t0 = performance.now();
        const d = await get(`/markets?event_ticker=${ev}&limit=60`);
        fetchMs = performance.now() - t0;
        const now = {}, changed = {};
        for (const x of d.markets || []) {
          const code = String(x.ticker).split('-').pop();
          const p = [cents(x.yes_bid_dollars), cents(x.yes_ask_dollars), cents(x.last_price_dollars)];
          now[code] = p;
          // Recorded with Kalshi's own update time (source) next to ours (t, on receipt).
          if (String(prices[m]?.[code]) !== String(p)) changed[code] = { p, u: x.updated_time || null, bidSize: +x.yes_bid_size_fp || null, askSize: +x.yes_ask_size_fp || null, status: x.status };
        }
        prices[m] = now;
        if (Object.keys(changed).length) {
          write({ t: Date.now(), type: 'kalshi', m, fetchMs: +fetchMs.toFixed(1), p: changed });
          broadcast('kalshi', { at: Date.now(), prices, fetchMs });
        }
      } catch (err) {
        if (err.slow) { slowUntil = Date.now() + 10000; console.log(new Date().toISOString(), 'kalshi: rate limited, pausing 10 s'); return; }
      }
    }
  }
  const loop = async () => { try { await poll(); } catch {} timer = setTimeout(loop, EVERY); };
  if (enabled) loop();

  return {
    prices: () => ({ at: Date.now(), prices }),
    // The page posts the site's own figures; keep at most one set every 2 s.
    logSite(rec) {
      if (!file || Date.now() - lastSite < 2000) return;
      lastSite = Date.now();
      write({ t: Date.now(), type: 'site', ...rec });
    },
  };
}
