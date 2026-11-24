// Downloads historical session data from OpenF1's free public API (api.openf1.org) into
// data/openf1/<year>/<session_key>/<endpoint>.json. Local only, never committed or published.
// Resumable: files already downloaded are skipped. Polite: one request at a time, ≥2.2 s apart
// (OpenF1's free limit is 30 requests a minute), backs off on 429.
//   node tools/fetch-openf1.mjs 2023 2024 2025 2026            qualifying-type sessions, then races
//   node tools/fetch-openf1.mjs 2026 --kinds=quali              only qualifying / sprint qualifying
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(process.env.PITWALL_DATA || path.join(ROOT, 'data'), 'openf1');
const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(Number);
const kinds = (process.argv.find(a => a.startsWith('--kinds='))?.slice(8) || 'quali,race').split(',');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
async function get(endpoint, q) {
  const url = `https://api.openf1.org/v1/${endpoint}?${new URLSearchParams(q)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + 2200 - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'pitwall-live-timing (historical research)' }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (attempt === 7) throw e; await sleep(5000 * (attempt + 1)); }
  }
}
const ENDPOINTS = {
  quali: ['drivers', 'laps', 'stints', 'race_control', 'weather', 'session_result', 'pit'],
  race: ['drivers', 'laps', 'stints', 'race_control', 'weather', 'session_result', 'pit', 'starting_grid', 'position', 'intervals'],
};
const now = Date.now();
const index = [];
for (const year of years) {
  const sessions = (await get('sessions', { year })).filter(s => Date.parse(s.date_end) < now - 3 * 3600e3 && !s.is_cancelled);
  for (const kind of kinds) {
    const pick = sessions.filter(s => kind === 'quali' ? s.session_type === 'Qualifying' : s.session_type === 'Race');
    for (const s of pick) {
      const dir = path.join(OUT, String(year), String(s.session_key));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s));
      for (const ep of ENDPOINTS[kind]) {
        const f = path.join(dir, `${ep}.json`);
        if (fs.existsSync(f)) continue;
        const d = await get(ep, { session_key: s.session_key });
        fs.writeFileSync(f + '.tmp', JSON.stringify(d)); fs.renameSync(f + '.tmp', f);
      }
      index.push({ year, key: s.session_key, name: s.session_name, circuit: s.circuit_short_name, date: s.date_start });
      console.log(new Date().toISOString(), year, s.circuit_short_name, s.session_name, s.session_key);
    }
  }
}
fs.writeFileSync(path.join(OUT, `index-${years.join('-')}-${kinds.join('-')}.json`), JSON.stringify(index, null, 1));
console.log(`done: ${index.length} sessions`);
