// Downloads past race data (lap-by-lap positions and times, pit stops, qualifying and
// results) from the public Jolpica F1 API, for testing the race call offline.
// Usage: node tools/fetch-races.mjs 2025   → data/races/2025-<round>.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'races');
const API = 'https://api.jolpi.ca/ergast/f1';
const year = process.argv[2] || '2025';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 6; i++) {
    await sleep(700); // stay well inside the API's rate limit
    const r = await fetch(url);
    if (r.ok) return (await r.json()).MRData;
    if (r.status === 429) { await sleep(20000 * (i + 1)); continue; }
    throw new Error(`${r.status} ${url}`);
  }
  throw new Error('rate limited: ' + url);
}
async function all(url, pick) {
  const out = [];
  for (let off = 0; ; off += 100) {
    const d = await get(`${url}${url.includes('?') ? '&' : '?'}limit=100&offset=${off}`);
    out.push(...pick(d));
    if (off + 100 >= +d.total) return out;
  }
}
await fs.mkdir(OUT, { recursive: true });
const sched = await get(`${API}/${year}.json?limit=100`);
for (const race of sched.RaceTable.Races) {
  const file = path.join(OUT, `${year}-${String(race.round).padStart(2, '0')}.json`);
  try { await fs.access(file); continue; } catch {}
  if (Date.parse(race.date) > Date.now() - 2 * 864e5) continue;
  const base = `${API}/${year}/${race.round}`;
  try {
    const results = (await get(`${base}/results.json?limit=100`)).RaceTable.Races[0]?.Results || [];
    if (!results.length) continue;
    const quali = (await get(`${base}/qualifying.json?limit=100`)).RaceTable.Races[0]?.QualifyingResults || [];
    const pits = (await get(`${base}/pitstops.json?limit=100`)).RaceTable.Races[0]?.PitStops || [];
    // Laps come back lap by lap, each with every driver's timing; pages can split a lap.
    const lapsRaw = await all(`${base}/laps.json`, d => d.RaceTable.Races[0]?.Laps || []);
    const laps = {};
    for (const l of lapsRaw) for (const t of l.Timings) (laps[t.driverId] ??= []).push({ lap: +l.number, pos: +t.position, time: t.time });
    await fs.writeFile(file, JSON.stringify({ name: race.raceName, round: +race.round, circuit: race.Circuit.circuitId, results, quali, pits, laps }));
    console.log('saved', file, Object.keys(laps).length, 'drivers');
  } catch (e) { console.log('skip', race.raceName, e.message); }
}
