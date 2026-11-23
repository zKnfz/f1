// Alerts: the moments that move markets, shown on the page the instant the feed has them,
// with an optional sound, so you don't have to be watching the right tab.
//   · safety car, virtual safety car, red flag, and the restart
//   · race control: double yellows, penalties and investigations for cars that matter,
//     deleted laps in qualifying
//   · a car out of the session, a car slow or stopped on track (needs live GPS/telemetry)
//   · in a race: pit stops by the top cars, a driver into or out of the top 3, 5 or 10,
//     and a Top 5 / Top 10 / Win chance on the Race call moving 10 points or more in a lap.
// Reads the page's `state`, `tele` and the race call; changes nothing in them.
(function () {
  const PREFS_KEY = 'pitwall-alerts-v1';
  let prefs = { sound: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

  const tla = n => state.DriverList?.[n]?.Tla || '#' + n;
  const lines = () => state.TimingData?.Lines || {};
  const kind = () => sessionKind();
  const running = () => ['Started', 'Aborted'].includes(state.SessionStatus?.Status);
  const posOf = n => +lines()[n]?.Position || 99;
  const lapNow = () => +state.LapCount?.CurrentLap || 0;

  // ---------- UI ----------
  const box = document.createElement('div'); box.id = 'alerts'; document.body.appendChild(box);
  const log = [];
  const btn = document.createElement('button'); btn.id = 'alertBtn'; btn.className = 'alertbtn';
  btn.title = 'Alerts: click for recent alerts and the sound setting';
  const panel = document.createElement('div'); panel.id = 'alertPanel'; panel.hidden = true;
  const anchor = document.getElementById('delay');
  anchor?.parentNode.insertBefore(btn, anchor);
  document.body.appendChild(panel);
  const drawBtn = () => { btn.innerHTML = `${prefs.sound ? '🔔' : '🔕'}<span>${log.length || ''}</span>`; };
  drawBtn();
  const drawPanel = () => {
    panel.innerHTML = `<div class="aphead"><b>Alerts</b><label><input type="checkbox" id="alSound" ${prefs.sound ? 'checked' : ''}> Sound</label></div>`
      + (log.length ? log.slice().reverse().map(a => `<div class="apitem al-${a.level}"><time>${a.time}</time>${a.html}</div>`).join('') : '<p class="note">No alerts yet this session.</p>');
    panel.querySelector('#alSound').onchange = e => { prefs.sound = e.target.checked; savePrefs(); drawBtn(); if (prefs.sound) beep('info'); };
  };
  btn.onclick = e => { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); };
  document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true; });

  // Sound: a short tone, higher for the big ones. Browsers only allow sound after the page
  // has been clicked once, so the first click anywhere unlocks it.
  let ac = null;
  document.addEventListener('pointerdown', () => { try { ac ??= new AudioContext(); ac.resume(); } catch {} }, { once: false });
  function beep(level) {
    if (!prefs.sound || !ac) return;
    const tones = level === 'red' ? [880, 660, 880] : level === 'amber' ? [740, 740] : level === 'green' ? [523, 784] : [660];
    tones.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.16;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.15);
    });
  }

  // Each alert has a key; the same key won't fire again within `quiet` ms.
  const lastFired = new Map();
  function fire(key, level, html, quiet = 30000) {
    const now = Date.now();
    if (now - (lastFired.get(key) || 0) < quiet) return;
    lastFired.set(key, now);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    log.push({ level, html, time }); if (log.length > 60) log.shift();
    drawBtn(); if (!panel.hidden) drawPanel();
    const el = document.createElement('div');
    el.className = `al al-${level}`;
    el.innerHTML = `${html}<time>${time}${kind() === 'race' && lapNow() ? ' · lap ' + lapNow() : ''}</time>`;
    el.onclick = () => el.remove();
    box.prepend(el);
    while (box.children.length > 5) box.lastChild.remove();
    setTimeout(() => el.classList.add('out'), level === 'red' ? 25000 : 14000);
    setTimeout(() => el.remove(), level === 'red' ? 25600 : 14600);
    beep(level);
    es.dispatchEvent(new CustomEvent('alert', { detail: { key, level, text: el.innerText.replace(/\s+/g, ' ').trim() } }));
  }
  window.pitwallAlert = fire; // for testing from the console

  // ---------- Start-up: learn what is already there, alert only on what changes ----------
  let ready = false, readyTimer = null;
  const seenRC = new Set(), outSeen = new Set(), inPit = {}, topSets = { 3: null, 5: null, 10: null };
  let lastTrack = null;
  function prime() {
    ready = false;
    for (const m of arr(state.RaceControlMessages?.Messages)) seenRC.add(rcKey(m));
    for (const [n, L] of Object.entries(lines())) { if (L.Retired || L.Stopped) outSeen.add(n); inPit[n] = !!L.InPit; }
    lastTrack = state.TrackStatus?.Status ?? null;
    for (const k of [3, 5, 10]) topSets[k] = topSet(k);
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { ready = true; }, 3000);
  }
  es.addEventListener('full', () => setTimeout(prime, 0));
  setTimeout(prime, 1500);

  // ---------- Track status ----------
  const TRACK = { 4: ['red', '<b>SAFETY CAR</b> deployed'], 5: ['red', '<b>RED FLAG</b>'], 6: ['amber', '<b>VIRTUAL SAFETY CAR</b> deployed'], 7: ['amber', '<b>VSC ending</b>'] };
  function onTrack() {
    const s = String(state.TrackStatus?.Status ?? '');
    if (s === lastTrack) return;
    const was = lastTrack; lastTrack = s;
    if (!ready) return;
    if (TRACK[s]) fire('track' + s, TRACK[s][0], TRACK[s][1], 20000);
    else if (s === '1' && ['4', '5', '6', '7'].includes(was)) fire('track1', 'green', '<b>GREEN</b> track clear, racing resumes', 20000);
  }

  // ---------- Race control ----------
  const rcKey = m => `${m.Utc}|${m.Message}`;
  // Cars that matter for the markets: in a race the top 12, otherwise the top 10.
  const matters = n => posOf(n) <= (kind() === 'race' ? 12 : 10);
  function onRC() {
    for (const m of arr(state.RaceControlMessages?.Messages)) {
      const k = rcKey(m);
      if (seenRC.has(k)) continue;
      seenRC.add(k);
      if (!ready) continue;
      const msg = String(m.Message || ''), up = msg.toUpperCase();
      const cars = [...up.matchAll(/CARS? ([\d ,AND]+)/g)].flatMap(x => x[1].match(/\d+/g) || []);
      const who = cars.map(n => `<b>${tla(n)}</b> (P${posOf(n)})`).join(', ');
      const short = msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
      if (m.Flag === 'RED') fire('rcred', 'red', '<b>RED FLAG</b> ' + short, 20000);
      else if (m.Category === 'SafetyCar') fire('rcsc' + k, 'amber', short, 0);
      else if (m.Flag === 'DOUBLE YELLOW') fire('rcdy' + (m.Sector || m.Scope), 'amber', `<b>DOUBLE YELLOW</b> ${m.Sector ? 'sector ' + m.Sector : ''}`, 20000);
      else if (/DELETED/.test(up) && cars.some(matters)) fire('rcdel' + k, 'amber', `<b>LAP DELETED</b> ${who} · ${short}`, 0);
      else if (/PENALTY|UNDER INVESTIGATION|NO FURTHER (ACTION|INVESTIGATION)|REPRIMAND/.test(up) && cars.some(matters))
        fire('rcpen' + k, /PENALTY/.test(up) && !/SERVED/.test(up) ? 'amber' : 'info', `${who}: ${short}`, 0);
    }
  }

  // ---------- Timing: cars out, pit stops, top 3/5/10 ----------
  const topSet = k => new Set(Object.entries(lines()).filter(([, L]) => +L.Position <= k && !L.Retired && !L.Stopped).map(([n]) => n));
  const pendingTop = new Map(); // a change in the top N only counts if it lasts 3 s (no flicker)
  function onTiming() {
    if (!ready) { for (const [n, L] of Object.entries(lines())) inPit[n] = !!L.InPit; return; }
    for (const [n, L] of Object.entries(lines())) {
      if ((L.Retired || L.Stopped) && !outSeen.has(n)) {
        outSeen.add(n);
        fire('out' + n, 'red', `<b>${tla(n)}</b> out${kind() === 'race' ? ` (was P${posOf(n)})` : ''}`, 0);
      }
      const p = !!L.InPit;
      if (p && !inPit[n] && kind() === 'race' && running() && lapNow() > 1 && posOf(n) <= 12)
        fire('pit' + n, 'info', `<b>PIT</b> ${tla(n)} (P${posOf(n)}) is in the pits`, 20000);
      inPit[n] = p;
    }
    if (kind() !== 'race' || !running() || lapNow() < 2) { for (const k of [3, 5, 10]) topSets[k] = topSet(k); return; }
    for (const k of [3, 5, 10]) {
      const now = topSet(k), was = topSets[k] || now;
      for (const n of now) if (!was.has(n)) pendingTop.set(`${k}+${n}`, Date.now());
      for (const n of was) if (!now.has(n)) pendingTop.set(`${k}-${n}`, Date.now());
      topSets[k] = now;
    }
  }
  setInterval(() => {
    for (const [key, at] of pendingTop) {
      if (Date.now() - at < 3000) continue;
      pendingTop.delete(key);
      const k = +key.match(/^\d+/)[0], into = key.includes('+'), n = key.split(/[+-]/)[1];
      if (into !== (topSets[k]?.has(n))) continue; // it changed back
      if (inPit[n]) continue; // dropping out while stopping is expected, the pit alert covers it
      fire(`top${k}${n}`, into ? 'green' : 'amber', `${into ? '▲' : '▼'} <b>${tla(n)}</b> ${into ? 'into' : 'out of'} the top ${k} (P${posOf(n)})`, 20000);
    }
  }, 1000);

  // ---------- Slow or stopped on track (live GPS / telemetry) ----------
  const slowSince = {};
  function checkSlow() {
    if (!ready || !running()) return;
    const ts = String(state.TrackStatus?.Status ?? '1');
    if (!['1', '2'].includes(ts)) return; // everyone is slow behind a safety car or a red flag
    const now = Date.now();
    for (const [n, L] of Object.entries(lines())) {
      const v = carSpeed(n);
      if (v == null || L.InPit || L.PitOut || L.Retired || L.Stopped || L.KnockedOut) { delete slowSince[n]; continue; }
      if (v >= 60) { delete slowSince[n]; continue; }
      slowSince[n] ??= now;
      if (now - slowSince[n] >= 1500)
        fire('slow' + n, 'red', `⚠ <b>${tla(n)}</b> ${v < 5 ? 'STOPPED' : 'slow'} on track${v >= 5 ? ` (${Math.round(v)} km/h)` : ''}${kind() === 'race' ? ` · P${posOf(n)}` : ''}`, 45000);
    }
  }
  let slowQueued = false;
  es.addEventListener('tele', () => { if (slowQueued) return; slowQueued = true; setTimeout(() => { slowQueued = false; checkSlow(); }, 250); });

  // ---------- Race call: chances moving fast ----------
  // Compared with the figures from one lap earlier, so a jump shows the lap it happens.
  const byLap = {};
  const MARKETS = [['win', 'Win', 0], ['top5', 'Top 5', 2], ['top10', 'Top 10', 3]];
  setInterval(() => {
    if (!ready || kind() !== 'race' || !running() || typeof raceCall !== 'function') return;
    const r = raceCall();
    if (!r || r.settled || !r.inp.started) return;
    const lap = r.inp.cur;
    byLap[lap] = Object.fromEntries(r.cars.map(c => [c.n, c]));
    const base = byLap[lap - 1];
    if (!base) return;
    for (const c of r.cars) {
      const b = base[c.n]; if (!b) continue;
      for (const [m, label] of MARKETS) {
        const d = Math.round((c[m] - b[m]) * 100);
        if (Math.abs(d) < 10) continue;
        fire(`call${m}${c.n}${d > 0 ? '+' : '-'}`, d > 0 ? 'green' : 'amber',
          `${d > 0 ? '📈' : '📉'} <b>${tla(c.n)}</b> ${label} ${Math.round(b[m] * 100)}% → <b>${Math.round(c[m] * 100)}%</b> (P${c.pos})`, 150000);
      }
    }
    for (const l of Object.keys(byLap)) if (+l < lap - 3) delete byLap[l];
  }, 5000);

  // ---------- Qualifying: on for pole ----------
  // Runs the Pole call (Q3 only) whenever a sector time comes in, on any tab. Alerts when a car
  // on a lap jumps to a real pole chance (25%+, up 15+ points since the lap began), when that
  // lap fades, and when provisional pole changes hands.
  const poleLap = {};   // n -> { lap, base, alerted }
  let poleHolder = null, poleQueued = false;
  function checkPole() {
    poleQueued = false;
    if (!ready || kind() !== 'quali' || typeof poleCall !== 'function') return;
    const p = poleCall();
    if (p) es.dispatchEvent(new CustomEvent('polecall', { detail: p }));
    if (!p || p.part !== 3) { poleHolder = null; return; }
    // Provisional pole: the fastest time set in Q3 so far.
    const timed = p.cars.filter(c => c.best).sort((a, b) => a.best - b.best);
    const top = timed[0];
    if (top && poleHolder && top.n !== poleHolder) {
      const gap = timed[1] ? ` by ${(timed[1].best - top.best).toFixed(3)}` : '';
      fire('ppole' + top.n + top.best, 'green', `🏁 <b>${tla(top.n)}</b> provisional pole ${fmtLapT(top.best)}${gap}`, 0);
    }
    if (top) poleHolder = top.n;
    for (const c of p.cars) {
      const lapNo = typeof secLap === 'object' ? secLap[c.n] : null;
      const onLap = !!c.lap && /on a lap/.test(c.why);
      // A new lap starts at sector 1: its starting point is the chance just before that sector.
      if (!poleLap[c.n] || poleLap[c.n].lap !== lapNo) poleLap[c.n] = { lap: lapNo, base: poleLap[c.n]?.last ?? c.ch, alerted: 0 };
      const st = poleLap[c.n];
      if (onLap && !st.alerted && c.ch >= 0.25 && c.ch - st.base >= 0.15) {
        const done = secLog?.[c.n]?.[lapNo] || [];
        const purple = arr(L_()[c.n]?.Sectors).map((s, i) => done[i] && s?.OverallFastest ? 'S' + (i + 1) : null).filter(Boolean);
        st.alerted = c.ch;
        fire(`onpole${c.n}:${lapNo}`, 'red', `⚡ <b>${tla(c.n)}</b> on for pole${purple.length ? ` · purple ${purple.join(', ')}` : ''} · heading for ${fmtLapT(c.lap.m)} · chance ${Math.round(st.base * 100)}% → <b>${Math.round(c.ch * 100)}%</b>`, 0);
      } else if (st.alerted && !st.faded && c.ch <= st.alerted / 2 && st.alerted - c.ch >= 0.15) {
        fire(`fade${c.n}:${lapNo}`, 'amber', `📉 <b>${tla(c.n)}</b> lap fading · pole chance ${Math.round(st.alerted * 100)}% → <b>${Math.round(c.ch * 100)}%</b>`, 0);
        st.faded = true; // one fade alert per lap
      }
      st.last = c.ch;
    }
  }

  // ---------- Wiring ----------
  es.addEventListener('feed', e => {
    const [topic, data] = e.detail;
    if (topic === 'TrackStatus') onTrack();
    else if (topic === 'RaceControlMessages') onRC();
    else if (topic === 'TimingData') {
      onTiming();
      // A new sector or lap time in qualifying: re-check pole right away (batched per 100 ms).
      if (kind() === 'quali' && !poleQueued && Object.values(data?.Lines || {}).some(u => u?.Sectors || u?.BestLapTime || u?.LastLapTime)) {
        poleQueued = true; setTimeout(checkPole, 100);
      }
    }
  });
})();
