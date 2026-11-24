// Is now a quiet time for heavy offline work (training, historical replays)? Heavy work runs only
// between race weekends: not from MARGIN hours before a weekend's first session to MARGIN hours
// after its last (so recording, the post-session backup and the predictions never compete with it).
// Calendar: tools/schedule.mjs (Jolpica, with the same cache the session scheduler uses).
//   node tools/train-window.mjs            prints the verdict; exit 0 = quiet, 75 = not now
import { loadRaces, sessionsOf } from './schedule.mjs';

export const MARGIN_H = Number(process.env.TRAIN_MARGIN_H ?? 12);

// Weekends as [start, end] (ms): sessions of the same race grouped, widened by the margin.
export function weekends(sessions, marginH = MARGIN_H) {
  const by = new Map();
  for (const s of sessions) { const k = s.name.replace(/ \w+$/, ''); const w = by.get(k) || [Infinity, -Infinity]; by.set(k, [Math.min(w[0], s.start), Math.max(w[1], s.end)]); }
  return [...by.entries()].map(([name, [a, b]]) => ({ name, start: a - marginH * 3600e3, end: b + marginH * 3600e3 })).sort((x, y) => x.start - y.start);
}

// { quiet, why, until (ms, when the current quiet spell ends, or when the busy one ends) }
export async function checkWindow(now = Date.now(), { cacheFile = process.env.SCHEDULE_CACHE || null } = {}) {
  const races = await loadRaces({ cacheFile, maxAgeMs: 6 * 3600e3 });
  if (!races) return { quiet: false, why: 'calendar unavailable (no Jolpica and no cached copy): not starting heavy work blind' };
  const ws = weekends(sessionsOf(races));
  const cur = ws.find(w => now >= w.start && now < w.end);
  if (cur) return { quiet: false, why: `${cur.name} weekend (with ${MARGIN_H} h margin) until ${new Date(cur.end).toISOString()}`, until: cur.end };
  const next = ws.find(w => w.start > now);
  return { quiet: true, why: next ? `quiet until ${new Date(next.start).toISOString()} (${next.name}, ${MARGIN_H} h before its first session)` : 'no more sessions on the calendar', until: next?.start ?? Infinity };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await checkWindow();
  console.log(w.quiet ? 'QUIET' : 'BUSY', '-', w.why);
  process.exit(w.quiet ? 0 : 75);
}
