// Rebuilds a qualifying (or sprint qualifying) session from OpenF1's historical data
// (data/openf1/<year>/<key>/, from tools/fetch-openf1.mjs) as a replayable recording
// (data/rec format), so it can be played through the real page and its predictions scored.
//
//   node tools/openf1-to-recording.mjs data/openf1/2025/9846 [outDir]
//
// What it reproduces, each at the time F1 would have sent it:
//   - every sector time (lap start + sector durations), mini-sector colours (spread evenly over
//     the sector), speed traps, lap times, personal-best sectors and lap times per part
//   - the session clock per part (Q1 18 / Q2 15 / Q3 12 min; sprint 12 / 10 / 8), stopped by red
//     flags and restarted, from race control's SESSION STARTED / ABORTED messages
//   - parts, knocked-out cars (from the classification, sent at the start of the next part)
//   - pit in / out, tyre stints (compound, new or used, laps on the set), weather, track status,
//     every race control message (deleted laps take the lap's time away when the message comes)
// What it cannot: timing of individual mini-sectors, positions on track, car data, F1's own
// ordering ties. It is an approximation of the live feed, labelled `synthetic` in meta.json;
// its receipt times are F1's event times (no network delay).
import fs from 'node:fs';
import path from 'node:path';

export function buildQualiRecording(src) {
  const J = f => { try { return JSON.parse(fs.readFileSync(path.join(src, f + '.json'), 'utf8')); } catch { return []; } };
  const s = J('session'), drivers = J('drivers'), laps = J('laps'), stints = J('stints'), rc = J('race_control'), weather = J('weather'), result = J('session_result');
  if (!laps.length || !rc.length) throw new Error(`${src}: no laps or race control`);
  const sprint = /Sprint/i.test(s.session_name);
  const PART_S = sprint ? [720, 600, 480] : [1080, 900, 720];
  const T = d => Date.parse(d);
  const fmt = x => { const m = Math.floor(x / 60), r = (x - m * 60).toFixed(3).padStart(6, '0'); return m ? `${m}:${r}` : r; };
  const hms = ms => { const t = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const nums = [...new Set(drivers.map(d => String(d.driver_number)))];
  const ev = []; // { t, topic, data, seq }
  let seq = 0;
  const at = (t, topic, data) => ev.push({ t, topic, data, seq: seq++ });

  // ---- clock and parts, from race control ----
  const phases = rc.filter(m => m.category === 'SessionStatus' || /SESSION (STARTED|ABORTED|FINISHED|SUSPENDED|RESUMED)/.test(m.message)).sort((a, b) => T(a.date) - T(b.date));
  const starts = phases.filter(m => /STARTED|RESUMED/.test(m.message));
  if (!starts.length) throw new Error(`${src}: no SESSION STARTED`);
  const t0 = T(starts[0].date) - 5 * 60000;
  let part = 0, remain = 0, runningSince = null;
  const partStart = {};
  for (const m of phases) {
    const t = T(m.date), p = m.qualifying_phase || part || 1;
    if (/STARTED|RESUMED/.test(m.message)) {
      if (p !== part) { part = p; remain = PART_S[p - 1] * 1000; partStart[p] = t; at(t - 2000, 'TimingData', { SessionPart: p }); }
      runningSince = t;
      at(t, 'ExtrapolatedClock', { Utc: new Date(t).toISOString(), Remaining: hms(remain), Extrapolating: true });
      at(t, 'SessionStatus', { Status: 'Started' });
    } else if (/ABORTED|SUSPENDED/.test(m.message)) {
      if (runningSince != null) remain -= t - runningSince; runningSince = null;
      at(t, 'ExtrapolatedClock', { Utc: new Date(t).toISOString(), Remaining: hms(remain), Extrapolating: false });
      at(t, 'SessionStatus', { Status: 'Aborted' });
    } else if (/FINISHED/.test(m.message)) {
      runningSince = null; remain = 0;
      at(t, 'ExtrapolatedClock', { Utc: new Date(t).toISOString(), Remaining: '00:00:00', Extrapolating: false });
      at(t, 'SessionStatus', { Status: p >= 3 ? 'Finished' : 'Inactive' });
    }
  }
  // Knocked out: at the start of part p, everyone without a time in part p of the classification.
  for (const p of [2, 3]) {
    if (!partStart[p]) continue;
    const inPart = new Set(result.filter(r => Array.isArray(r.duration) && r.duration[p - 1] != null).map(r => String(r.driver_number)));
    const out = Object.fromEntries(result.map(r => String(r.driver_number)).filter(n => !inPart.has(n)).map(n => [n, { KnockedOut: true }]));
    at(partStart[p] - 60000, 'TimingData', { Lines: out });
  }
  const noEntries = [result.length || nums.length, ...[2, 3].map(p => result.filter(r => Array.isArray(r.duration) && r.duration[p - 1] != null).length)];

  // ---- laps: sectors, mini-sectors, speeds, lap times, bests ----
  const partAt = t => { let p = 1; for (const [k, v] of Object.entries(partStart)) if (t >= v) p = Math.max(p, +k); return p; };
  const byDrv = {};
  for (const l of laps) (byDrv[l.driver_number] ??= []).push(l);
  const lapEnds = []; // { t, n, time, part, pitIn }
  for (const [n, ls] of Object.entries(byDrv)) {
    ls.sort((a, b) => a.lap_number - b.lap_number);
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i], next = ls[i + 1];
      if (!l.date_start) continue;
      const start = T(l.date_start);
      if (l.is_pit_out_lap) at(start, 'TimingData', { Lines: { [n]: { InPit: false, PitOut: true } } });
      // A new lap: the previous lap's bars go dark as the car gets to them.
      const durs = [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3];
      const segs = [l.segments_sector_1, l.segments_sector_2, l.segments_sector_3].map(x => Array.isArray(x) ? x : []);
      let t = start;
      for (let k = 0; k < 3; k++) {
        const d = durs[k];
        if (k === 0 || durs[k - 1] != null) at(t + 1, 'TimingData', { Lines: { [n]: { Sectors: { [k]: { Segments: Object.fromEntries(segs[k].map((_, j) => [j, { Status: 0 }])) } } } } });
        if (d == null) break;
        segs[k].forEach((st, j) => { if (st) at(t + d * 1000 * (j + 1) / segs[k].length - 1, 'TimingData', { Lines: { [n]: { Sectors: { [k]: { Segments: { [j]: { Status: st } } } } } } }); });
        if (k === 0 && l.i1_speed) at(t + d * 600, 'TimingData', { Lines: { [n]: { Speeds: { I1: { Value: String(l.i1_speed) } } } } });
        if (k === 1 && l.i2_speed) at(t + d * 600, 'TimingData', { Lines: { [n]: { Speeds: { I2: { Value: String(l.i2_speed) } } } } });
        t += d * 1000;
        if (k < 2) at(t, 'TimingData', { Lines: { [n]: { Sectors: { [k]: { Value: d.toFixed(3) } } } } });
        else lapEnds.push({ t, n, s3: d, time: l.lap_duration, lap: l.lap_number, st: l.st_speed });
      }
      // Ended in the pits: in the garage until the next out lap (or for good).
      const pitIn = !next || next.is_pit_out_lap;
      if (pitIn) at((l.lap_duration ? start + l.lap_duration * 1000 : t) + 5000, 'TimingData', { Lines: { [n]: { InPit: true } } });
      if (!l.lap_duration && next?.date_start) at(T(next.date_start) - 1, 'TimingData', { Lines: { [n]: { Sectors: { 0: { Value: '' }, 1: { Value: '' }, 2: { Value: '' } } } } });
    }
  }
  // Deleted lap times (race control), applied when the message comes.
  const deleted = rc.map(m => [T(m.date), /CAR (\d+).*?TIME (\d+):(\d{2}\.\d{3}) DELETED/i.exec(m.message || '')]).filter(([, g]) => g).map(([t, g]) => ({ t, n: g[1], time: +g[2] * 60 + +g[3] }));
  // Bests (per part and overall) and laps completed, in time order, as F1 updates them.
  lapEnds.sort((a, b) => a.t - b.t);
  const counted = {}; // n -> [{time, part, t}]
  const nlaps = {};
  const bestOf = (n, p, upTo) => { const ok = (counted[n] || []).filter(x => (p == null || x.part === p) && !deleted.some(d => d.n === n && d.t <= upTo && Math.abs(d.time - x.time) < 0.0015)); return ok.length ? Math.min(...ok.map(x => x.time)) : null; };
  for (const e of lapEnds) {
    nlaps[e.n] = (nlaps[e.n] || 0) + 1;
    const u = { Sectors: { 2: { Value: e.s3.toFixed(3) } }, NumberOfLaps: nlaps[e.n] };
    if (e.st) u.Speeds = { ST: { Value: String(e.st) } };
    if (e.time) {
      u.LastLapTime = { Value: fmt(e.time) };
      const p = partAt(e.t);
      const before = bestOf(e.n, p, e.t);
      (counted[e.n] ??= []).push({ time: e.time, part: p, t: e.t });
      if (before == null || e.time < before) {
        u.BestLapTimes = { [p - 1]: { Value: fmt(e.time) } };
        const all = bestOf(e.n, null, e.t);
        if (all === e.time) u.BestLapTime = { Value: fmt(e.time) };
      }
    }
    at(e.t, 'TimingData', { Lines: { [e.n]: u } });
  }
  for (const d of deleted) {
    const p = partAt(d.t), b = bestOf(d.n, p, d.t), all = bestOf(d.n, null, d.t);
    at(d.t + 1, 'TimingData', { Lines: { [d.n]: { BestLapTimes: { [p - 1]: { Value: b ? fmt(b) : '' } }, BestLapTime: { Value: all ? fmt(all) : '' } } } });
  }
  // Personal best sectors (TimingStats) as sector times arrive.
  const sectorEvents = ev.filter(e => e.topic === 'TimingData' && e.data.Lines).flatMap(e => Object.entries(e.data.Lines).flatMap(([n, u]) => Object.entries(u.Sectors || {}).filter(([, v]) => v.Value).map(([k, v]) => ({ t: e.t, n, k, v: +v.Value })))).concat(lapEnds.map(e => ({ t: e.t, n: e.n, k: '2', v: e.s3 })));
  sectorEvents.sort((a, b) => a.t - b.t);
  const pb = {};
  for (const x of sectorEvents) { const key = `${x.n}:${x.k}`; if (!pb[key] || x.v < pb[key]) { pb[key] = x.v; at(x.t + 1, 'TimingStats', { Lines: { [x.n]: { BestSectors: { [x.k]: { Value: x.v.toFixed(3) } } } } }); } }

  // ---- tyres ----
  for (const st of stints) {
    const n = String(st.driver_number), ls = byDrv[st.driver_number] || [];
    const first = ls.find(l => l.lap_number === st.lap_start);
    const t = first?.date_start ? T(first.date_start) - 1000 : null;
    if (t == null) continue;
    at(t, 'TimingAppData', { Lines: { [n]: { Stints: { [st.stint_number - 1]: { Compound: st.compound, New: String(st.tyre_age_at_start === 0), TotalLaps: st.tyre_age_at_start, StartLaps: st.tyre_age_at_start } } } } });
    for (const l of ls.filter(l => l.lap_number >= st.lap_start && l.lap_number <= st.lap_end && l.date_start && l.lap_duration)) {
      at(T(l.date_start) + l.lap_duration * 1000 + 2, 'TimingAppData', { Lines: { [n]: { Stints: { [st.stint_number - 1]: { TotalLaps: st.tyre_age_at_start + (l.lap_number - st.lap_start) + 1 } } } } });
    }
  }
  // ---- race control, track status, weather ----
  const yellow = new Set(); let red = false;
  // Messages from before the replay starts are in the snapshot; later ones follow on, numbered on.
  const rcMsg = m => ({ Utc: m.date.replace('+00:00', ''), Category: m.category, Message: m.message, ...(m.flag ? { Flag: m.flag } : {}), ...(m.scope ? { Scope: m.scope } : {}), ...(m.sector ? { Sector: m.sector } : {}), ...(m.driver_number ? { RacingNumber: String(m.driver_number) } : {}) });
  const rcSorted = rc.slice().sort((a, b) => T(a.date) - T(b.date));
  const earlyMsgs = rcSorted.filter(m => T(m.date) < t0).map(rcMsg);
  rcSorted.forEach((m, i) => {
    const t = T(m.date);
    if (t >= t0) at(t, 'RaceControlMessages', { Messages: { [i]: rcMsg(m) } });
    if (m.category !== 'Flag') return;
    if (m.flag === 'RED') red = true;
    else if (/GREEN|CLEAR/.test(m.flag || '') && m.scope === 'Track') { red = false; yellow.clear(); }
    else if (/YELLOW/.test(m.flag || '')) yellow.add(m.sector ?? 'track');
    else if (m.flag === 'CLEAR') yellow.delete(m.sector ?? 'track');
    const status = red ? '5' : yellow.size ? '2' : '1';
    at(t, 'TrackStatus', { Status: status, Message: { 1: 'AllClear', 2: 'Yellow', 5: 'Red' }[status] });
  });
  for (const w of weather) at(T(w.date), 'WeatherData', { AirTemp: String(w.air_temperature), TrackTemp: String(w.track_temperature), Humidity: String(w.humidity), Pressure: String(w.pressure), Rainfall: String(w.rainfall ? 1 : 0), WindDirection: String(w.wind_direction), WindSpeed: String(w.wind_speed) });

  // ---- the snapshot a page gets on connecting, before the session ----
  const info = { Key: s.session_key, Name: s.session_name, Type: 'Qualifying', StartDate: s.date_start.slice(0, 19), EndDate: s.date_end?.slice(0, 19), GmtOffset: s.gmt_offset, Meeting: { Key: s.meeting_key, Name: `${s.country_name} Grand Prix`, Location: s.location, Circuit: { Key: s.circuit_key, ShortName: s.circuit_short_name } } };
  const segCount = k => Math.max(1, ...laps.map(l => (l[`segments_sector_${k + 1}`] || []).length));
  const blankSectors = [0, 1, 2].map(k => ({ Value: '', Segments: Array.from({ length: segCount(k) }, () => ({ Status: 0 })) }));
  const snap = {
    SessionInfo: info, SessionStatus: { Status: 'Inactive' }, TrackStatus: { Status: '1', Message: 'AllClear' },
    ExtrapolatedClock: { Utc: new Date(t0).toISOString(), Remaining: hms(PART_S[0] * 1000), Extrapolating: false },
    DriverList: Object.fromEntries(drivers.map((d, i) => [String(d.driver_number), { RacingNumber: String(d.driver_number), Tla: d.name_acronym, BroadcastName: d.broadcast_name, FullName: d.full_name, TeamName: d.team_name, TeamColour: d.team_colour, Line: i + 1 }])),
    TimingData: { SessionPart: 1, NoEntries: noEntries, Lines: Object.fromEntries(nums.map((n, i) => [n, { RacingNumber: n, Line: i + 1, Position: String(i + 1), NumberOfLaps: 0, InPit: true, Sectors: JSON.parse(JSON.stringify(blankSectors)), BestLapTime: { Value: '' }, LastLapTime: { Value: '' }, BestLapTimes: [{ Value: '' }, { Value: '' }, { Value: '' }], Speeds: {} }])) },
    TimingStats: { Lines: Object.fromEntries(nums.map(n => [n, { BestSectors: [{ Value: '' }, { Value: '' }, { Value: '' }], BestSpeeds: {} }])) },
    TimingAppData: { Lines: Object.fromEntries(nums.map(n => [n, { Stints: [] }])) },
    RaceControlMessages: { Messages: earlyMsgs }, WeatherData: {}, LapCount: {},
  };
  ev.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const out = [`${t0}\t0\t1\t${JSON.stringify({ type: 3, invocationId: '0', result: snap })}`];
  for (const e of ev) if (e.t >= t0) out.push(`${Math.round(e.t)}\t0\t1\t${JSON.stringify({ type: 1, target: 'feed', arguments: [e.topic, e.data, new Date(e.t).toISOString()] })}`);
  // Outcomes, for scoring (not part of what the page sees).
  const partTop = [1, 2, 3].map(p => { const c = result.filter(r => r.duration?.[p - 1] > 0).sort((a, b) => a.duration[p - 1] - b.duration[p - 1]); return c[0] ? String(c[0].driver_number) : null; });
  const outcome = { pole: String(result.find(r => r.position === 1)?.driver_number ?? ''), partTop, partStart, noEntries,
    classification: result.map(r => ({ n: String(r.driver_number), pos: r.position, q: r.duration })) };
  return { lines: out, info, outcome, t0, end: ev.at(-1).t };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = path.resolve(process.argv[2]);
  const r = buildQualiRecording(src);
  const dir = process.argv[3] ? path.resolve(process.argv[3]) : path.join('data', 'replays', `openf1-${path.basename(src)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'feed.tsv'), r.lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: { key: r.info.Key, name: r.info.Name, meeting: r.info.Meeting.Name }, synthetic: 'rebuilt from OpenF1 historical data by tools/openf1-to-recording.mjs (sector-level timing, evenly spread mini-sectors)', outcome: r.outcome }, null, 1));
  console.log(`${dir}: ${r.lines.length} frames, ${((r.end - r.t0) / 60000).toFixed(0)} min`);
}
