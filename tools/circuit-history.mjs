// Qualifying character of a circuit from OpenF1 history, against every other circuit:
// track evolution (Q1 → Q3 pole-pace improvement), how close the top is, how often pole is
// set on the last run, deleted laps (track limits), red flags, lap time spread.
//   node tools/circuit-history.mjs Lusail
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OF = path.join(process.env.PITWALL_DATA || path.join(ROOT, 'data'), 'openf1');
const want = process.argv[2] || 'Lusail';
const J = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const rows = [];
for (const y of fs.readdirSync(OF).filter(x => /^\d{4}$/.test(x))) for (const k of fs.readdirSync(path.join(OF, y))) {
  const d = path.join(OF, y, k), s = J(path.join(d, 'session.json'));
  if (!s || s.session_type !== 'Qualifying') continue;
  const res = J(path.join(d, 'session_result.json')) || [], rc = J(path.join(d, 'race_control.json')) || [], laps = J(path.join(d, 'laps.json')) || [];
  if (!res.length || !laps.length) continue;
  const best = p => Math.min(...res.map(r => r.duration?.[p - 1]).filter(x => x > 0));
  const q1 = best(1), q3 = best(3);
  const q3t = res.map(r => r.duration?.[2]).filter(x => x > 0).sort((a, b) => a - b);
  const pole = res.find(r => r.position === 1);
  // Was pole set on the driver's last timed lap of the session?
  const pl = laps.filter(l => l.driver_number === pole?.driver_number && l.lap_duration).sort((a, b) => a.lap_number - b.lap_number);
  const poleLap = pl.find(l => Math.abs(l.lap_duration - (pole?.duration?.[2] ?? 0)) < 0.002);
  const lastRun = poleLap && pl.filter(l => l.lap_number > poleLap.lap_number && l.lap_duration < poleLap.lap_duration * 1.05).length === 0 && pl.at(-1).lap_number - poleLap.lap_number <= 2;
  rows.push({ year: y, circuit: s.circuit_short_name, name: s.session_name, key: s.session_key,
    evolutionPct: isFinite(q1) && isFinite(q3) ? 100 * (q1 - q3) / q1 : null,
    gapP1P2: q3t.length > 1 ? q3t[1] - q3t[0] : null, top10SpreadPct: q3t.length >= 10 ? 100 * (q3t[9] - q3t[0]) / q3t[0] : null,
    poleOnFinalRun: lastRun, deleted: rc.filter(m => /DELETED/.test(m.message)).length, reds: rc.filter(m => m.flag === 'RED').length });
}
const pick = rows.filter(r => r.circuit === want), rest = rows.filter(r => r.circuit !== want);
const avg = (a, k) => { const n = a.map(r => r[k]).filter(x => x != null).map(Number).filter(Number.isFinite); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null; };
const f = x => x == null ? '–' : x.toFixed(3);
console.log(`${want}: ${pick.length} qualifying sessions`);
for (const r of pick.sort((a, b) => a.year - b.year)) console.log(`  ${r.year} ${r.name.padEnd(18)} evolution Q1→Q3 ${f(r.evolutionPct)}%  P1–P2 ${f(r.gapP1P2)} s  top-10 spread ${f(r.top10SpreadPct)}%  pole on final run ${r.poleOnFinalRun ? 'yes' : 'no'}  deleted laps ${r.deleted}  red flags ${r.reds}`);
for (const [label, set] of [[want, pick], ['all other circuits', rest]]) console.log(`  mean, ${label.padEnd(20)} evolution ${f(avg(set, 'evolutionPct'))}%  P1–P2 ${f(avg(set, 'gapP1P2'))} s  top-10 spread ${f(avg(set, 'top10SpreadPct'))}%  pole on final run ${(100 * avg(set, 'poleOnFinalRun')).toFixed(0)}%  deleted laps ${f(avg(set, 'deleted'))}  red flags ${f(avg(set, 'reds'))}`);
