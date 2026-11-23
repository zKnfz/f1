// Prints the commands that wake this Mac 35 minutes before each F1 session in the next 21 days,
// so a sleeping Mac still records. Waking needs admin rights, so you run them yourself:
//   node tools/schedule-wakes.mjs            show the commands
//   node tools/schedule-wakes.mjs | sudo sh  schedule them (asks for your Mac password)
// Check with: pmset -g sched     Remove all with: sudo pmset schedule cancelall
const DAYS = Number(process.argv[2]) || 21, LEAD_MIN = 35;
const r = await fetch('https://api.jolpi.ca/ergast/f1/current.json?limit=100', { headers: { 'User-Agent': 'pitwall-live-timing' }, signal: AbortSignal.timeout(20000) });
const races = (await r.json()).MRData.RaceTable.Races;
const now = Date.now(), until = now + DAYS * 86400e3, out = [];
const KINDS = ['FirstPractice', 'SecondPractice', 'ThirdPractice', 'SprintQualifying', 'SprintShootout', 'Sprint', 'Qualifying'];
for (const race of races) {
  const s = [['Race', race]];
  for (const k of KINDS) if (race[k]) s.push([k, race[k]]);
  for (const [kind, v] of s) {
    if (!v.date || !v.time) continue;
    const wake = Date.parse(`${v.date}T${v.time}`) - LEAD_MIN * 60000;
    if (wake < now + 60000 || wake > until) continue;
    const d = new Date(wake), p = n => String(n).padStart(2, '0');
    // pmset wants local time: MM/dd/yy HH:mm:ss
    out.push({ wake, line: `pmset schedule wake "${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:00"  # ${race.raceName} ${kind}` });
  }
}
out.sort((a, b) => a.wake - b.wake).forEach(o => console.log(o.line));
if (!out.length) console.error('No sessions in the next', DAYS, 'days.');
