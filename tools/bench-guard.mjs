// Which systemd changes during a benchmark are production problems (used by tools/bench-workload.mjs --guard).
// Always-on services: any restart, new main process or leaving 'active' is a production event.
// Timer-driven ones (pitwall-session runs every 5 min from its timer, checks the calendar and
// exits; maintain and health run on their timers) start and stop on their own: only a restart
// after a failure (NRestarts up) or a failed run (Result not success / state failed) counts.
export const ALWAYS_ON = ['pitwall-relay.service', 'pitwall-ingest.service'];
export const SCHEDULED = ['pitwall-session.service', 'pitwall-maintain.service', 'pitwall-health.service'];
export const PROPS = ['LoadState', 'ActiveState', 'NRestarts', 'Result', 'ExecMainStartTimestampMonotonic', 'ExecMainPID'];
// `systemctl show -p A,B unit` output (A=x lines) → { A: 'x', ... }
export const parseShow = text => Object.fromEntries(text.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
export function unitProblem(before, now) {
  for (const n of ALWAYS_ON) {
    const a = before?.[n], b = now?.[n];
    if (!a || a.LoadState !== 'loaded') continue; // not installed on this machine
    if (!b) return `${n}: state unreadable`;
    if (b.ActiveState !== 'active') return `${n} is ${b.ActiveState}`;
    if (+b.NRestarts > +a.NRestarts) return `${n} restarted (NRestarts ${a.NRestarts} → ${b.NRestarts})`;
    if (b.ExecMainStartTimestampMonotonic !== a.ExecMainStartTimestampMonotonic || b.ExecMainPID !== a.ExecMainPID) return `${n} main process replaced (pid ${a.ExecMainPID} → ${b.ExecMainPID})`;
  }
  for (const n of SCHEDULED) {
    const a = before?.[n], b = now?.[n];
    if (!a || a.LoadState !== 'loaded' || !b) continue;
    if (+b.NRestarts > +a.NRestarts) return `${n} restarted after a failure (NRestarts ${a.NRestarts} → ${b.NRestarts})`;
    if ((b.ActiveState === 'failed' && a.ActiveState !== 'failed') || (b.Result !== 'success' && b.Result !== a.Result)) return `${n} failed (Result ${b.Result}, ${b.ActiveState})`;
  }
  return null;
}
