// Direct mode: the browser connects straight to Formula 1's live timing feed.
// Used when the page is hosted on its own (for example GitHub Pages) with no relay.
// It does the same job as server.mjs: several connections race, the first copy of
// each update wins, and completed laps are recorded (here, in this browser's storage).
//
// startDirect(emit) sends the same events the relay would:
//   status, full, feed, history, lap, pit
// It reads the page's merged `state` after each update, so it never keeps a second copy.

function startDirect(emit) {
  const URL_ = 'wss://livetiming.formula1.com/signalrcore';
  const RS = '\x1e';
  const FEEDS = Math.max(1, Number(new URLSearchParams(location.search).get('feeds')) || 3);
  const TOPICS = [
    'Heartbeat', 'SessionInfo', 'SessionData', 'SessionStatus', 'TrackStatus', 'LapCount',
    'ExtrapolatedClock', 'DriverList', 'TimingData', 'TimingAppData', 'TimingStats',
    'RaceControlMessages', 'WeatherData', 'TopThree', 'PitLaneTimeCollection',
  ];
  const conns = [];
  const seen = new Map();
  let status = 'connecting';

  setInterval(() => { const cut = Date.now() - 20000; for (const [k, t] of seen) if (t < cut) seen.delete(k); }, 5000);
  const liveCount = () => conns.filter(c => c.live).length;
  function setStatus(s) { if (s !== status) { status = s; emit('status', { status: s }); } }
  emit('status', { status });

  function connect(c) {
    c.live = false;
    const ws = c.ws = new WebSocket(URL_);
    const ping = () => { if (ws.readyState === 1) { ws.send('{"type":6}' + RS); c.lastPing = Date.now(); } };
    ws.onopen = () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [TOPICS], invocationId: '0' }) + RS);
      c.lastPing = Date.now();
      clearInterval(c.timer);
      c.timer = setInterval(ping, 15000);
    };
    ws.onmessage = e => {
      const now = Date.now();
      // Background tabs slow timers down, so also keep the connection alive from here.
      if (now - c.lastPing > 10000) ping();
      for (const part of String(e.data).split(RS)) {
        if (!part) continue;
        let m;
        try { m = JSON.parse(part); } catch { continue; }
        if (m.type === 1 && m.target === 'feed') {
          if (seen.has(part)) continue;
          seen.set(part, now);
          const [topic, data, sentAt] = m.arguments;
          emit('feed', [topic, data, sentAt]); // the page merges it into `state`
          afterFeed(topic, data);
        } else if (m.type === 3 && m.invocationId === '0') {
          if (m.error) { console.error('subscribe error:', m.error); continue; }
          // Take the full snapshot only when no other connection is already live,
          // so a reconnecting feed never rolls the state back.
          if (!liveCount()) emit('full', m.result || {});
          c.live = true; c.retry = 0;
          setStatus('live');
          ensureHistory();
        }
      }
    };
    ws.onclose = () => {
      clearInterval(c.timer);
      c.live = false;
      if (!liveCount()) setStatus('reconnecting');
      const wait = Math.min(30000, 2000 * 2 ** c.retry++) + Math.random() * 1000;
      setTimeout(() => connect(c), wait);
    };
    ws.onerror = () => {};
  }
  for (let i = 0; i < FEEDS; i++) { const c = { id: i + 1, retry: 0, live: false }; conns.push(c); connect(c); }

  // ---------- Lap history (saved in this browser) ----------
  const PREFIX = 'pitwall-session-';
  let history = { key: null, laps: {}, pits: {} };
  const watch = {};
  let saveTimer = null;

  function ensureHistory() {
    const key = state.SessionInfo?.Key;
    if (!key || history.key === key) return;
    let loaded = null;
    try { loaded = JSON.parse(localStorage.getItem(PREFIX + key)); } catch {}
    history = loaded?.key === key ? loaded : { key, laps: {}, pits: {} };
    for (const k in watch) delete watch[k];
    for (const [num, laps] of Object.entries(history.laps)) watch[num] = { last: laps.at(-1)?.raw, sawPit: false };
    pruneOld(key);
    emit('history', structuredClone(history)); // the page keeps its own copy
  }
  // Keep the five most recent sessions so storage never fills up.
  function pruneOld(current) {
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX) && k !== PREFIX + current)
        .map(k => ({ k, n: Number(k.slice(PREFIX.length)) })).sort((a, b) => b.n - a.n);
      for (const { k } of keys.slice(4)) localStorage.removeItem(k);
    } catch {}
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { localStorage.setItem(PREFIX + history.key, JSON.stringify(history)); } catch {}
    }, 3000);
  }

  function afterFeed(topic, data) {
    if (topic === 'SessionInfo') return ensureHistory();
    if (!history.key) return;
    if (topic === 'TimingData') {
      for (const [num, u] of Object.entries(data?.Lines || {})) {
        const w = watch[num] ??= { last: null, sawPit: false };
        if (u.InPit === true || u.PitOut === true) w.sawPit = true;
        // Lap time, final sector and lap count arrive together at the line.
        // Wait a moment so the gap to the leader has updated too.
        if (u.LastLapTime?.Value) { clearTimeout(w.timer); w.timer = setTimeout(() => recordLap(num), 1000); }
      }
    } else if (topic === 'PitLaneTimeCollection') {
      for (const [num, p] of Object.entries(data?.PitTimes || {})) {
        if (!p?.Duration) continue;
        const list = history.pits[num] ??= [];
        const rec = { lap: Number(p.Lap) || null, dur: Number(p.Duration) };
        if (list.some(x => x.lap === rec.lap && x.dur === rec.dur)) continue;
        list.push(rec);
        emit('pit', [num, rec]);
        saveSoon();
      }
    }
  }

  function recordLap(num) {
    const line = state.TimingData?.Lines?.[num];
    const w = watch[num];
    const raw = line?.LastLapTime?.Value;
    if (!line || !raw || raw === w.last) return;
    w.last = raw;
    const stints = arr(state.TimingAppData?.Lines?.[num]?.Stints);
    const stint = stints.at(-1) || {};
    const rec = {
      lap: Number(line.NumberOfLaps) || null,
      raw, time: lapSecs(raw),
      s: arr(line.Sectors).map(x => lapSecs(x?.Value || x?.PreviousValue)),
      c: stint.Compound || null, age: Number(stint.TotalLaps) || 0, stint: stints.length,
      pos: Number(line.Position) || null,
      gap: line.GapToLeader ?? null, int: line.IntervalToPositionAhead?.Value ?? null,
      pit: w.sawPit, ts: state.TrackStatus?.Status || '1', part: state.TimingData?.SessionPart || null,
      at: Date.now(),
    };
    w.sawPit = !!(line.InPit || line.PitOut);
    // The page's own 'lap' listener adds it to `hist`; keep this copy for saving.
    const list = history.laps[num] ??= [];
    if (rec.lap && list.at(-1)?.lap === rec.lap) list[list.length - 1] = rec; else list.push(rec);
    emit('lap', [num, rec]);
    saveSoon();
  }
}
