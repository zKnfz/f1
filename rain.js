// Rain watch: answers "is it about to rain at the track?"
// Combines F1's own track sensor, F1 race control's rain messages, a 15-minute
// rain forecast for the next 2 hours (Open-Meteo, loaded in index.html as `rain15`)
// and a radar loop of the last hour around the circuit (RainViewer).

// ---------- Track temperature trend (from F1's sensor readings) ----------
const wxSamples = []; // {t, track}
let wxLastKey = '';
function sampleWeather() {
  const w = state.WeatherData;
  if (!w) return;
  const key = `${w.AirTemp}|${w.TrackTemp}|${w.Humidity}|${w.Rainfall}`;
  if (key === wxLastKey) return;
  wxLastKey = key;
  wxSamples.push({ t: Date.now(), track: +w.TrackTemp });
  while (wxSamples.length && Date.now() - wxSamples[0].t > 30 * 60 * 1000) wxSamples.shift();
}
// Change in track temperature over roughly the last 10 minutes.
function trackTrend() {
  if (wxSamples.length < 2) return null;
  const now = wxSamples.at(-1);
  const old = wxSamples.find(s => now.t - s.t <= 12 * 60 * 1000);
  if (!old || now.t - old.t < 4 * 60 * 1000) return null;
  return { delta: now.track - old.track, mins: Math.round((now.t - old.t) / 60000) };
}

// ---------- Assessment ----------
const intensity = mm15 => { const rate = mm15 * 4; return rate < 2.5 ? 'light' : rate < 7.6 ? 'moderate' : 'heavy'; };
function rainStatus() {
  const w = state.WeatherData;
  const raining = !!w && (w.Rainfall === '1' || w.Rainfall === 1);
  const now = Date.now() / 1000;
  let soon = null, soonMm = 0, peak = 0;
  if (rain15) {
    rain15.time.forEach((t, i) => {
      if (t + 900 < now) return; // slot already over
      const mm = rain15.precipitation?.[i] ?? 0;
      if (mm >= 0.1 && soon == null) { soon = Math.max(0, Math.round((t - now) / 60)); soonMm = mm; }
      if (mm > peak) peak = mm;
    });
  }
  const rc = arr(state.RaceControlMessages?.Messages).filter(m => /RAIN/i.test(m.Message || '')).at(-1);
  return { raining, soon, soonMm, peak, rc, trend: trackTrend() };
}

// ---------- Wet-sector detector ----------
// Rain shows up in lap times before radar catches it. Every sector time is compared
// with that driver's own recent normal time for the same sector. If one sector gets
// slower for most of the field while the others don't, that part of the track is
// probably wet.
const secSamples = {}; // driver -> [sector1[], sector2[], sector3[]] of {t, at, pit, flag}
const WATCH_WINDOW = 120 * 1000; // "now" = sector times from the last 2 minutes
const median = a => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

es.addEventListener('feed', e => {
  const [topic, data] = e.detail;
  if (topic !== 'TimingData' || !data?.Lines) return;
  const flag = (state.TrackStatus?.Status || '1') !== '1';
  const now = Date.now();
  for (const [n, u] of Object.entries(data.Lines)) {
    if (!u?.Sectors) continue;
    for (const [k, sec] of Object.entries(u.Sectors)) {
      const i = Number(k);
      const t = lapSecs(sec?.Value);
      if (!(i >= 0 && i < 3) || !t) continue;
      const L = state.TimingData?.Lines?.[n] || {};
      // Pit entry and exit make a sector slow for reasons that have nothing to do with rain.
      const pit = !!(L.InPit || (i === 0 && L.PitOut) || (i === 2 && L.InPit));
      const list = (secSamples[n] ??= [[], [], []])[i];
      const last = list.at(-1);
      if (last && last.t === t && now - last.at < 30000) continue; // same time sent twice
      list.push({ t, at: now, pit, flag });
      if (list.length > 15) list.shift();
    }
  }
});

function sectorWatch() {
  const race = sessionKind() === 'race';
  const now = Date.now();
  // Practice and qualifying have slow out-laps and cool-down laps, so they need a bigger signal.
  const need = race ? 4 : 5, warn = race ? 1.0 : 2.0, wet = race ? 2.0 : 3.0;
  const out = [0, 1, 2].map(i => {
    const deltas = [];
    let learning = 0;
    for (const [n, arrs] of Object.entries(secSamples)) {
      if (state.TimingData?.Lines?.[n]?.Retired) continue;
      const list = arrs[i].filter(s => !s.pit);
      if (!list.length) continue;
      const best = Math.min(...list.map(s => s.t));
      let base = list.filter(s => now - s.at > WATCH_WINDOW && !s.flag);
      if (!race) base = base.filter(s => s.t <= best * 1.03);
      base = base.slice(-6);
      if (base.length < 3) { learning++; continue; }
      const cur = list.filter(s => now - s.at <= WATCH_WINDOW).at(-1);
      if (!cur || cur.flag) continue;
      if (!race && cur.t > best * 1.15) continue; // a cool-down lap, not a push
      deltas.push(cur.t - median(base.map(s => s.t)));
    }
    const med = deltas.length ? median(deltas) : null;
    const slowShare = deltas.length ? deltas.filter(d => d >= warn).length / deltas.length : 0;
    let status = 'learning';
    if (deltas.length >= need) {
      status = med >= wet && slowShare >= 0.6 ? 'wet' : med >= warn && slowShare >= 0.5 ? 'slowing' : med <= -1.0 ? 'faster' : 'normal';
    }
    return { i, cars: deltas.length, med, status, learning };
  });
  const flagged = out.filter(x => x.status === 'wet' || x.status === 'slowing');
  return { sectors: out, flagged, whole: flagged.length === 3, paused: (state.TrackStatus?.Status || '1') !== '1' };
}

// Colour the slowing part of the track map. Sector lengths follow the timing segments.
function paintWetSectors(w) {
  if (!trackPath || !window.wetPath) return;
  const any = Object.values(state.TimingData?.Lines || {}).find(L => arr(L.Sectors).length === 3);
  const counts = any ? arr(any.Sectors).map(s => arr(s.Segments).length || 1) : [1, 1, 1];
  const total = counts.reduce((a, b) => a + b, 0);
  const bounds = []; let acc = 0;
  for (const c of counts) { bounds.push([acc / total * trackLen, (acc + c) / total * trackLen]); acc += c; }
  const hit = w.paused ? [] : w.flagged.map(x => x.i).sort();
  if (!hit.length) { wetPath.setAttribute('stroke', 'transparent'); return; }
  const dash = ['0']; let pos = 0;
  for (const i of hit) { const [a, b] = bounds[i]; dash.push((a - pos).toFixed(1), (b - a).toFixed(1)); pos = b; }
  dash.push((trackLen - pos + 1).toFixed(1));
  wetPath.setAttribute('stroke-dasharray', dash.join(' '));
  wetPath.setAttribute('stroke', w.flagged.some(x => x.status === 'wet') ? '#3b82f6' : '#7db4ff');
}

function sectorWatchHtml(w) {
  const label = { wet: 'likely wet', slowing: 'slowing', faster: 'getting faster', normal: 'normal', learning: 'learning' };
  const chips = w.sectors.map(x => `<span class="sw ${w.paused ? 'learning' : x.status}" title="${x.cars} cars compared with their own recent times">S${x.i + 1} ${x.med == null || x.status === 'learning' ? '·' : (x.med >= 0 ? '+' : '−') + Math.abs(x.med).toFixed(1) + 's'} <em>${w.paused && x.status !== 'learning' ? 'paused' : label[x.status]}</em></span>`).join('');
  const learningNote = w.sectors.every(x => x.status === 'learning')
    ? '<div class="swNote">Learning each driver\'s normal sector times. This takes about 3 laps after the page opens.</div>'
    : w.paused ? '<div class="swNote">Paused while flags are out, since everyone slows down.</div>' : '';
  return `<div class="swRow"><span class="swLbl">Sector watch</span>${chips}</div>${learningNote}`;
}

// ---------- Header alert + rain card ----------
let rainHtml = '', pillHtml = '';
function renderRain() {
  sampleWeather();
  const r = rainStatus();
  const w = sectorWatch();
  paintWetSectors(w);
  const wetSecs = w.paused ? [] : w.flagged;
  const secNames = wetSecs.map(x => 'S' + (x.i + 1)).join(' + ');
  let pill = '', cls = '';
  if (r.raining) { pill = '🌧 RAINING AT TRACK'; cls = 'now'; }
  else if (w.whole && !w.paused) { pill = '🌧 WHOLE TRACK SLOWING · WET?'; cls = 'now'; }
  else if (wetSecs.length) { pill = `🌧 ${secNames} SLOWING · WET?`; cls = wetSecs.some(x => x.status === 'wet') ? 'now' : 'soon'; }
  else if (r.soon != null && r.soon <= 5) { pill = '🌧 RAIN FORECAST NOW'; cls = 'soon'; }
  else if (r.soon != null) { pill = `🌧 RAIN IN ~${r.soon} MIN`; cls = 'soon'; }
  const pHtml = pill ? `<button class="rainPill ${cls}" id="rainPillBtn" title="Open the rain watch">${pill}</button>` : '';
  if (pHtml !== pillHtml) {
    pillHtml = pHtml;
    $('rainPill').innerHTML = pHtml;
    const b = document.getElementById('rainPillBtn');
    if (b) b.onclick = () => $('rainBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let head, headCls;
  if (r.raining) { head = 'Raining at the track now'; headCls = 'now'; }
  else if (wetSecs.length) {
    const worst = wetSecs.reduce((a, b) => (b.med > a.med ? b : a));
    head = w.whole ? `Whole track slowing (+${worst.med.toFixed(1)}s) · rain likely` : `${secNames} slowing across the field (+${worst.med.toFixed(1)}s) · probably wet there`;
    headCls = 'now';
  }
  else if (r.soon != null && r.soon <= 5) { head = `Rain forecast now · ${intensity(r.soonMm)}`; headCls = 'soon'; }
  else if (r.soon != null) { head = `Rain likely in ~${r.soon} min · ${intensity(r.soonMm)}`; headCls = 'soon'; }
  else if (rain15) { head = 'No rain expected in the next 2 hours'; headCls = 'dry'; }
  else { head = 'Rain forecast loading…'; headCls = 'dry'; }

  const lines = [];
  if (state.WeatherData) lines.push(`F1 track sensor: <b>${r.raining ? 'wet' : 'dry'}</b>`);
  if (r.trend && Math.abs(r.trend.delta) >= 0.5) {
    const drop = r.trend.delta < 0;
    lines.push(`Track temperature <b class="${drop && r.trend.delta <= -1.5 ? 'wet' : ''}">${drop ? '▼' : '▲'} ${Math.abs(r.trend.delta).toFixed(1)}°</b> in ${r.trend.mins} min${drop && r.trend.delta <= -1.5 ? ' · clouds or rain may be arriving' : ''}`);
  }
  if (r.rc) lines.push(`Race control: <b>${esc(r.rc.Message)}</b>`);

  let bars = '';
  if (rain15) {
    const max = Math.max(0.5, ...rain15.precipitation);
    bars = `<div class="r15">${rain15.time.map((t, i) => {
      const mm = rain15.precipitation[i] ?? 0;
      const h = mm > 0 ? Math.max(8, mm / max * 100) : 0;
      return `<div title="${esc(new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }))}: ${mm} mm in 15 min"><i style="height:${h}%" class="${mm >= 0.1 ? 'on' : ''}"></i>
        <small>${i % 2 ? '' : esc(new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[AP]M$/i, ''))}</small></div>`;
    }).join('')}</div><div class="r15cap">Rain in 15-minute steps, next 2 hours</div>`;
  }
  const html = `<div class="rainHead ${headCls}">${head}</div>${sectorWatchHtml(w)}${lines.length ? `<div class="rainLines">${lines.map(l => `<div>${l}</div>`).join('')}</div>` : ''}${bars}`;
  if (html !== rainHtml) { rainHtml = html; $('rainBox').innerHTML = html; }
}

// ---------- Radar loop (RainViewer) ----------
const RADAR_Z = 7; // the most detail the free radar offers
let radarKey = '', radarFrames = [], radarIdx = 0, radarHold = 0, radarW = 0;
async function loadRadar() {
  const p = forecastPlace;
  if (!p) return;
  try {
    const d = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    const frames = (d.radar?.past || []).slice(-7); // last hour, 10-minute steps
    const box = $('radar');
    const key = `${p.lat},${p.lon}|${frames.map(f => f.path).join(',')}|${box.clientWidth}`;
    if (key === radarKey || !frames.length) return;
    radarKey = key;
    buildRadar(d.host, frames, p);
  } catch { $('radarTime').textContent = 'radar unavailable'; }
}
function buildRadar(host, frames, p) {
  const box = $('radar');
  const W = box.clientWidth || 340, H = 260, n = 2 ** RADAR_Z;
  radarW = W;
  const px = (p.lon + 180) / 360 * n * 256;
  const py = (1 - Math.asinh(Math.tan(p.lat * Math.PI / 180)) / Math.PI) / 2 * n * 256;
  const left = px - W / 2, top = py - H / 2;
  const tiles = [];
  for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H) / 256); ty++)
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W) / 256); tx++)
      if (ty >= 0 && ty < n) tiles.push({ tx, ty, x: ((tx % n) + n) % n });
  const layer = (url, cls, style = '') => `<div class="rl ${cls}" style="${style}">${tiles.map(t =>
    `<img alt="" loading="eager" src="${url(t)}" style="left:${(t.tx * 256 - left).toFixed(0)}px;top:${(t.ty * 256 - top).toFixed(0)}px">`).join('')}</div>`;
  const pxPerKm = 256 * n / (40075 * Math.cos(p.lat * Math.PI / 180));
  box.style.height = H + 'px';
  box.innerHTML =
    layer(t => `https://tile.openstreetmap.org/${RADAR_Z}/${t.x}/${t.ty}.png`, 'base') +
    frames.map((f, i) => layer(t => `${host}${f.path}/256/${RADAR_Z}/${t.x}/${t.ty}/2/1_1.png`, 'frame', `opacity:${i === frames.length - 1 ? 0.85 : 0}`)).join('') +
    `<svg class="rmark" viewBox="0 0 ${W} ${H}"><circle cx="${W / 2}" cy="${H / 2}" r="${(50 * pxPerKm).toFixed(1)}" class="ring2"/><circle cx="${W / 2}" cy="${H / 2}" r="${(25 * pxPerKm).toFixed(1)}" class="ring"/><circle cx="${W / 2}" cy="${H / 2}" r="4" class="dot"/></svg>`;
  radarFrames = frames;
  radarIdx = frames.length - 1;
  radarHold = 4;
  showRadarFrame();
}
function showRadarFrame() {
  const layers = $('radar').querySelectorAll('.frame');
  layers.forEach((l, i) => { l.style.opacity = i === radarIdx ? 0.85 : 0; });
  const f = radarFrames[radarIdx];
  if (f) {
    const ago = Math.round((Date.now() / 1000 - f.time) / 60);
    $('radarTime').textContent = `${new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })} · ${ago <= 1 ? 'latest' : ago + ' min ago'}`;
  }
}
// Play the last hour on a loop, pausing on the newest picture.
setInterval(() => {
  if (!radarFrames.length || document.hidden) return;
  if (radarIdx === radarFrames.length - 1 && radarHold-- > 0) return;
  radarIdx = (radarIdx + 1) % radarFrames.length;
  if (radarIdx === radarFrames.length - 1) radarHold = 4;
  showRadarFrame();
}, 600);
setInterval(loadRadar, 5 * 60 * 1000);
let radarResize;
addEventListener('resize', () => { clearTimeout(radarResize); radarResize = setTimeout(() => { if ($('radar').clientWidth !== radarW) { radarKey = ''; loadRadar(); } }, 300); });
// Keep the "rain in ~N min" countdown current between data updates.
// Also refreshes the sector watch as its 2-minute window moves on.
setInterval(renderRain, 10 * 1000);
