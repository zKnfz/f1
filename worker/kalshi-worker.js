// Pitwall: Kalshi price relay for the public site (https://zknfz.github.io/f1/).
// Kalshi doesn't let other websites read its API from the browser, so this tiny Cloudflare
// Worker fetches Kalshi's PUBLIC F1 market data and passes it on. Read only: no account, no key,
// no trading. Only F1 series are allowed, and answers are cached for a second at Cloudflare, so
// any number of viewers cost Kalshi about one request per second.
//   GET /events?series=KXF1POLE          -> the series' recent events (cached 60 s)
//   GET /prices?events=KXF1POLE-LUSA26,…  -> { event: { CODE: [bid¢, ask¢, last¢] } } (cached 1 s)
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const ORIGINS = [/^https:\/\/zknfz\.github\.io$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const SERIES = /^KXF1[A-Z0-9]{1,30}$/, EVENT = /^KXF1[A-Z0-9]{1,30}-[A-Z0-9]{1,20}$/;

const cents = v => (v == null || v === '' ? null : Math.round(parseFloat(v) * 100));

async function kalshi(path, ttl) {
  const r = await fetch(API + path, { headers: { Accept: 'application/json', 'User-Agent': 'pitwall-live-timing' }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw Object.assign(new Error('kalshi ' + r.status), { status: r.status });
  return r.json();
}

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = ORIGINS.some(re => re.test(origin)) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const reply = (status, body, maxAge = 0) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}`, ...cors },
    });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET') return reply(405, { error: 'GET only' });
    if (origin && !cors['Access-Control-Allow-Origin']) return reply(403, { error: 'origin not allowed' });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/events') {
        const s = url.searchParams.get('series') || '';
        if (!SERIES.test(s)) return reply(400, { error: 'bad series' });
        const d = await kalshi(`/events?series_ticker=${s}&limit=10`, 60);
        return reply(200, { events: (d.events || []).map(e => ({ event_ticker: e.event_ticker, title: e.title, sub_title: e.sub_title, status: e.status })) }, 60);
      }
      if (url.pathname === '/prices') {
        const evs = (url.searchParams.get('events') || '').split(',').filter(Boolean);
        if (!evs.length || evs.length > 6 || !evs.every(e => EVENT.test(e))) return reply(400, { error: 'bad events' });
        const out = {};
        await Promise.all(evs.map(async ev => {
          const d = await kalshi(`/markets?event_ticker=${ev}&limit=60`, 1);
          out[ev] = Object.fromEntries((d.markets || []).map(x => [String(x.ticker).split('-').pop(), [cents(x.yes_bid_dollars), cents(x.yes_ask_dollars), cents(x.last_price_dollars)]]));
        }));
        return reply(200, { at: Date.now(), prices: out }, 1);
      }
      return reply(404, { error: 'not found' });
    } catch (e) {
      return reply(e.status === 429 ? 429 : 502, { error: String(e.message || e) });
    }
  },
};
