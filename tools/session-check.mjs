// Decides whether an F1 session is on, or about to start, so the recorder should run.
// Uses the public Jolpica (Ergast) schedule. Jolpica refuses requests without a named
// User-Agent (since Nov 2026), so every request sends one. Prints the answer and, on GitHub Actions,
// writes it to the step outputs: record=true|false, wait=<minutes to wait for the start>,
// max=<minutes to record at most>, name=<session>.
import { appendFileSync } from 'node:fs';
import { loadRaces, sessionsOf } from './schedule.mjs';

const LEAD_MIN = 25; // start this long before a session

function out(o) {
  console.log(JSON.stringify(o));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(''));
}

// SCHEDULE_CACHE=<file> keeps the last good calendar (the server sets it).
const races = await loadRaces({ cacheFile: process.env.SCHEDULE_CACHE || null });
if (!races) {
  // No schedule: say no instead of guessing. The next run tries again.
  out({ record: false, reason: 'schedule unavailable' });
  process.exit(0);
}
const now = Date.now();
let pick = null;
for (const s of sessionsOf(races)) if (now >= s.start - LEAD_MIN * 60000 && now <= s.end && (!pick || s.start > pick.start)) pick = s;
if (!pick) out({ record: false, reason: 'no session now' });
else out({
  record: true,
  name: pick.name.replace(/[^\w ]/g, ''),
  wait: Math.max(20, Math.round((pick.start - now) / 60000) + 35), // give up if it has not started by then
  max: Math.max(30, Math.round((pick.end - now) / 60000) + 20),
});
