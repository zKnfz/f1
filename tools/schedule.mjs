// The F1 calendar from the public Jolpica (Ergast) API, shared by the schedule tools.
// Jolpica refuses requests without a named User-Agent (since Nov 2026), so one is always sent.
// With a cache file, the last good copy is kept and reused for up to `maxAgeMs`, and used
// (however old) when Jolpica can't be reached, so a short outage never stops a recording.
import fs from 'node:fs';
export const LENGTH_MIN = { FirstPractice: 80, SecondPractice: 80, ThirdPractice: 80, Qualifying: 110, SprintQualifying: 80, SprintShootout: 80, Sprint: 80, Race: 230 };

async function fetchRaces() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://api.jolpi.ca/ergast/f1/current.json?limit=100', { headers: { 'User-Agent': 'pitwall-live-timing' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return (await r.json()).MRData.RaceTable.Races;
    } catch {}
    await new Promise(res => setTimeout(res, 3000));
  }
  return null;
}
export async function loadRaces({ cacheFile = null, maxAgeMs = 3600e3 } = {}) {
  let cached = null;
  if (cacheFile) try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.races;
  const races = await fetchRaces();
  if (races && cacheFile) try { fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), races })); } catch {}
  return races || cached?.races || null;
}
// Every session as { kind, name, start, end } (epoch ms), sorted by start.
export function sessionsOf(races) {
  const out = [];
  for (const race of races || []) {
    const s = { Race: { date: race.date, time: race.time } };
    for (const [k, v] of Object.entries(race)) if (v && typeof v === 'object' && v.date && LENGTH_MIN[k]) s[k] = v;
    for (const [kind, v] of Object.entries(s)) {
      if (!v.date || !v.time) continue;
      const start = Date.parse(`${v.date}T${v.time}`);
      out.push({ kind, name: `${race.raceName} ${kind}`, start, end: start + LENGTH_MIN[kind] * 60000 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
