// What Pitwall knew at a given moment of a recording.
//   node tools/replay-state.mjs data/rec/<dir> 2026-11-28T15:32:10Z   (or seconds from the start, e.g. 900)
// Prints a summary and writes the full state to <dir>/state-at-<time>.json.
// To watch it on the page instead: REPLAY=data/rec/<dir> FROM=900 SPEED=1 node server.mjs
import fs from 'node:fs';
import path from 'node:path';
import { readFeed, stateAt } from '../recorder.mjs';
const [dirArg, when] = process.argv.slice(2);
if (!dirArg) { console.log('usage: node tools/replay-state.mjs data/rec/<dir> <ISO time | seconds from start>'); process.exit(1); }
const dir = path.resolve(dirArg);
let until = Infinity;
if (when != null) {
  if (/^\d+(\.\d+)?$/.test(when)) { for await (const f of readFeed(path.join(dir, 'feed.tsv'))) { until = f.r + Number(when) * 1000; break; } }
  else until = Date.parse(when);
}
const { state, updates, lastAt } = await stateAt(dir, until);
const lines = state.TimingData?.Lines || {};
const order = Object.entries(lines).sort((a, b) => (+a[1].Position || 99) - (+b[1].Position || 99));
console.log(`State at ${isFinite(until) ? new Date(until).toISOString() : 'the end'} (${updates} updates applied, last at ${lastAt ? new Date(lastAt).toISOString() : '–'})`);
console.log(`${state.SessionInfo?.Meeting?.Name ?? ''} ${state.SessionInfo?.Name ?? ''} · ${state.SessionStatus?.Status ?? ''} · lap ${state.LapCount?.CurrentLap ?? '–'}/${state.LapCount?.TotalLaps ?? '–'} · track ${state.TrackStatus?.Status ?? '–'}`);
for (const [n, L] of order.slice(0, 10)) console.log(`  P${L.Position ?? '?'} ${state.DriverList?.[n]?.Tla ?? n}  laps ${L.NumberOfLaps ?? '–'}  last ${L.LastLapTime?.Value ?? '–'}  best ${L.BestLapTime?.Value ?? '–'}  gap ${L.GapToLeader ?? L.TimeDiffToFastest ?? '–'}`);
const out = path.join(dir, `state-at-${isFinite(until) ? new Date(until).toISOString().replace(/[:.]/g, '-') : 'end'}.json`);
fs.writeFileSync(out, JSON.stringify(state));
console.log('full state written to', path.relative(process.cwd(), out));
