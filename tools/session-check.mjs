// Decides whether an F1 session is on, or about to start, so the recorder should run.
// Uses the public Jolpica (Ergast) schedule. Jolpica refuses requests without a named
// User-Agent (since Nov 2026), so every request sends one. Prints the answer and, on GitHub Actions,
// writes it to the step outputs: record=true|false, wait=<minutes to wait for the start>,
// max=<minutes to record at most>, name=<session>.
import { appendFileSync } from 'node:fs';

const LEAD_MIN = 25; // start this long before a session
// How long each kind of session can run, with room for delays and red flags.
const LENGTH_MIN = { FirstPractice: 80, SecondPractice: 80, ThirdPractice: 80, Qualifying: 110, SprintQualifying: 80, SprintShootout: 80, Sprint: 80, Race: 230 };

function out(o) {
  console.log(JSON.stringify(o));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(''));
}

async function schedule() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://api.jolpi.ca/ergast/f1/current.json?limit=100', { headers: { 'User-Agent': 'pitwall-live-timing' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return (await r.json()).MRData.RaceTable.Races;
    } catch {}
    await new Promise(res => setTimeout(res, 3000));
  }
  return null;
}

const races = await schedule();
if (!races) {
  // No schedule: say no instead of guessing. The next run, 15 minutes later, tries again.
  out({ record: false, reason: 'schedule unavailable' });
  process.exit(0);
}
const now = Date.now();
let pick = null;
for (const race of races) {
  const sessions = { Race: { date: race.date, time: race.time } };
  for (const [k, v] of Object.entries(race)) if (v && typeof v === 'object' && v.date && LENGTH_MIN[k]) sessions[k] = v;
  for (const [kind, v] of Object.entries(sessions)) {
    if (!v.date || !v.time) continue;
    const start = Date.parse(`${v.date}T${v.time}`);
    const end = start + LENGTH_MIN[kind] * 60000;
    if (now >= start - LEAD_MIN * 60000 && now <= end && (!pick || start > pick.start)) pick = { kind, start, end, name: `${race.raceName} ${kind}` };
  }
}
if (!pick) out({ record: false, reason: 'no session now' });
else out({
  record: true,
  name: pick.name.replace(/[^\w ]/g, ''),
  wait: Math.max(20, Math.round((pick.start - now) / 60000) + 35), // give up if it has not started by then
  max: Math.max(30, Math.round((pick.end - now) / 60000) + 20),
});
