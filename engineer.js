// Race engineer panel. Uses the live state and helpers from index.html,
// plus the lap history the relay records (server.mjs).
// Tabs change with the session: race, qualifying, or practice.

// `hist` (lap history) and `engDirty` live in index.html, so no update is missed
// while this file is still loading.
let engTab = {}, engCompare = null, engLastSel;

const ENG_TABS = {
  race: [['driver', 'Driver'], ['battles', 'Battles'], ['laps', 'Lap times'], ['strategy', 'Strategy']],
  quali: [['driver', 'Driver'], ['knockout', 'Knockout'], ['laps', 'Lap times']],
  practice: [['driver', 'Driver'], ['longruns', 'Long runs'], ['laps', 'Lap times'], ['strategy', 'Tyres']],
};

// ---------- Data helpers ----------
const L_ = () => state.TimingData?.Lines || {};
const fmt3 = x => x == null || !isFinite(x) ? '–' : x.toFixed(3);
const fmtLapT = s => { if (s == null || !isFinite(s)) return '–'; const m = Math.floor(s / 60); const r = (s - m * 60).toFixed(3).padStart(6, '0'); return m ? `${m}:${r}` : r; };
const signed = (x, d = 3) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
function engOrder() {
  const lines = L_();
  return drivers().sort((a, b) => (+(lines[a]?.Line ?? 99)) - (+(lines[b]?.Line ?? 99)));
}
function dInfo(n) {
  const d = state.DriverList?.[n] || {};
  return { code: d.Tla || n, color: '#' + (d.TeamColour || '888'), team: d.TeamName || '', name: d.FullName || d.BroadcastName || '' };
}
const chipD = n => { const d = dInfo(n); return `<span class="dchip"><i style="background:${d.color}"></i>${esc(d.code)}</span>`; };
function tyreChip(c, laps) {
  const t = TYRES[c] || ['?', '#666'];
  return `<span class="tchip" style="border-color:${t[1]};color:${t[1]}">${t[0]}</span>${laps != null ? `<span class="dimt"> ${laps}L</span>` : ''}`;
}
function refLap() {
  const lines = L_();
  const t = engOrder().map(n => lapSecs(lines[n]?.LastLapTime?.Value)).filter(Boolean).sort((a, b) => a - b);
  return t.length ? t[Math.floor(t.length / 2)] : 90;
}
// "+4.608" -> 4.608, "1L" / "+1 LAP" -> one lap's time, "LAP 13" (leader) -> 0
function gapSecs(v, ref) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^LAP/i.test(s)) return 0;
  const m = s.match(/^\+?(\d+)\s*L/i);
  if (m) return +m[1] * (ref || 90);
  const x = parseFloat(s.replace('+', ''));
  return isFinite(x) ? x : null;
}
function bestLap(n) {
  const L = L_()[n] || {};
  if (sessionKind() === 'quali') {
    const p = (state.TimingData?.SessionPart || 1) - 1;
    return lapSecs(arr(L.BestLapTimes)[p]?.Value) ?? lapSecs(L.BestLapTime?.Value);
  }
  return lapSecs(L.BestLapTime?.Value);
}
const pbSectors = n => arr(state.TimingStats?.Lines?.[n]?.BestSectors).map(x => lapSecs(x?.Value));
function fieldBestSectors() {
  const out = [Infinity, Infinity, Infinity];
  for (const n of drivers()) pbSectors(n).forEach((v, i) => { if (v && v < out[i]) out[i] = v; });
  return out.map(v => isFinite(v) ? v : null);
}
// Sector times F1 has published for the lap in progress (it clears them at the start of each lap).
function liveLap(n) {
  const cur = arr(L_()[n]?.Sectors).map(s => lapSecs(s?.Value));
  const done = cur.filter(v => v != null).length;
  if (done === 0 || done === 3) return null;
  const pb = pbSectors(n);
  let delta = 0, projected = 0, ok = true;
  for (let i = 0; i < 3; i++) {
    if (cur[i] != null) { projected += cur[i]; if (pb[i] != null) delta += cur[i] - pb[i]; }
    else if (pb[i] != null) projected += pb[i]; else ok = false;
  }
  return { done, cur, delta, projected: ok ? projected : null };
}
function clean(r) { return r.time && !r.pit && (r.ts || '1') === '1'; }
function slope(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}
// Gap of b behind a, per completed lap, from both drivers' recorded gaps to the leader.
function pairTrend(a, b) {
  const ref = refLap();
  const by = n => new Map((hist.laps[n] || []).filter(clean).map(r => [r.lap, gapSecs(r.gap, ref)]).filter(([l, g]) => l && g != null));
  const ga = by(a), gb = by(b);
  const laps = [...gb.keys()].filter(l => ga.has(l)).sort((x, y) => x - y).slice(-4);
  if (laps.length < 2) return null;
  const d = laps.map(l => gb.get(l) - ga.get(l));
  return { perLap: (d.at(-1) - d[0]) / (laps.at(-1) - laps[0]), laps: laps.length };
}
function trendText(gapNow, t, chasing) {
  if (!t || gapNow == null) return '<span class="dimt">building trend…</span>';
  const v = t.perLap;
  if (Math.abs(v) < 0.05) return '<span class="dimt">holding steady</span>';
  const closing = v < 0;
  let s = `${closing ? 'closing' : 'growing'} ${Math.abs(v).toFixed(2)} s/lap`;
  if (closing && gapNow > 1) s += ` · DRS range in ~${Math.ceil((gapNow - 1) / -v)} laps`;
  if (closing && gapNow <= 1) s += ' · in DRS range';
  const good = chasing ? closing : !closing;
  return `<span class="${good ? 'c-green' : 'c-red'}">${s}</span>`;
}
function pitLoss() {
  const pl = circuitInfo?.pitLoss || {};
  const ts = state.TrackStatus?.Status;
  if (ts === '4') return { loss: +pl.sc || 14, why: 'safety car' };
  if (ts === '6' || ts === '7') return { loss: +pl.vsc || 15, why: 'virtual safety car' };
  return { loss: +pl.normal || 22, why: 'green flag' };
}
function pitWindow(n) {
  const lines = L_(), order = engOrder(), ref = refLap();
  const gapOf = m => m === order[0] ? 0 : gapSecs(lines[m]?.GapToLeader, ref);
  const g = gapOf(n);
  if (g == null) return null;
  const { loss, why } = pitLoss();
  const after = g + loss;
  const others = order.filter(m => m !== n && !lines[m]?.Retired && !lines[m]?.Stopped)
    .map(m => ({ m, g: gapOf(m) })).filter(x => x.g != null);
  const ahead = others.filter(x => x.g <= after).sort((a, b) => b.g - a.g)[0];
  const behind = others.filter(x => x.g > after).sort((a, b) => a.g - b.g)[0];
  return { loss, why, pos: others.filter(x => x.g <= after).length + 1,
    ahead: ahead && { n: ahead.m, gap: after - ahead.g }, behind: behind && { n: behind.m, gap: behind.g - after } };
}
function stintsOf(n) {
  const groups = new Map();
  for (const r of hist.laps[n] || []) {
    const k = r.stint || 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, laps]) => ({ k, laps, c: laps.at(-1).c }));
}
function stintPace(laps, best) {
  const ok = laps.filter(r => clean(r) && (!best || r.time <= best * 1.07));
  if (!ok.length) return null;
  const avg = ok.reduce((a, r) => a + r.time, 0) / ok.length;
  return { n: ok.length, avg, best: Math.min(...ok.map(r => r.time)), deg: slope(ok.map(r => r.age), ok.map(r => r.time)) };
}

// ---------- Panels ----------
function card(title, body, extra = '') { return `<div class="ecard ${extra}"><h4>${title}</h4>${body}</div>`; }
function kv(rows) { return `<div class="kv">${rows.map(([k, v]) => `<div><span>${k}</span><b class="mono">${v}</b></div>`).join('')}</div>`; }

function panelDriver(n) {
  const kind = sessionKind();
  const L = L_()[n] || {}, ST = state.TimingStats?.Lines?.[n] || {}, A = state.TimingAppData?.Lines?.[n] || {};
  const d = dInfo(n);
  const best = bestLap(n), pb = pbSectors(n), fb = fieldBestSectors();
  const ideal = pb.every(v => v != null) ? pb.reduce((a, b) => a + b, 0) : null;
  const fieldIdeal = fb.every(v => v != null) ? fb.reduce((a, b) => a + b, 0) : null;
  const live = liveLap(n);
  const stints = arr(A.Stints);
  const cur = stints.at(-1);
  const out = [];

  out.push(card('Lap', kv([
    ['Best lap', fmtLapT(best)],
    ['Ideal lap (best sectors)', fmtLapT(ideal)],
    ['Time left on the table', ideal && best ? signed(best - ideal) : '–'],
    ['Field ideal lap', fmtLapT(fieldIdeal)],
    ['Last lap', esc(L.LastLapTime?.Value || '–')],
  ])));

  const liveBody = live
    ? kv([...live.cur.map((v, i) => [`Sector ${i + 1}`, v != null ? `${fmt3(v)} <span class="${v - (pb[i] ?? v) <= 0 ? 'c-green' : 'c-red'}">${pb[i] != null ? signed(v - pb[i]) : ''}</span>` : '<span class="dimt">on track</span>']),
      ['Delta to best sectors', `<span class="${live.delta <= 0 ? 'c-green' : 'c-red'}">${signed(live.delta)}</span>`],
      ['Projected lap', live.projected ? fmtLapT(live.projected) : '–']])
    : `<p class="note">${L.InPit ? 'In the pits.' : 'Shows once the first sector of a lap is done.'}</p>`;
  out.push(card('Live lap', liveBody));

  out.push(card('Sectors', `<table class="et"><tr><th></th><th>Best</th><th>Rank</th><th>vs field</th></tr>${[0, 1, 2].map(i => {
    const s = arr(ST.BestSectors)[i];
    return `<tr><td>S${i + 1}</td><td class="mono ${s?.Position === 1 ? 'c-purple' : ''}">${fmt3(pb[i])}</td><td class="mono">${s?.Position ? 'P' + s.Position : '–'}</td><td class="mono">${pb[i] && fb[i] ? signed(pb[i] - fb[i]) : '–'}</td></tr>`;
  }).join('')}</table>`));

  const sp = ST.BestSpeeds || {};
  out.push(card('Speed traps (km/h)', `<table class="et"><tr><th></th><th>Best</th><th>Rank</th></tr>${[['ST', 'Speed trap'], ['I1', 'Intermediate 1'], ['I2', 'Intermediate 2'], ['FL', 'Finish line']].map(([k, label]) =>
    `<tr><td>${label}</td><td class="mono ${sp[k]?.Position === 1 ? 'c-purple' : ''}">${esc(sp[k]?.Value || '–')}</td><td class="mono">${sp[k]?.Position ? 'P' + sp[k].Position : '–'}</td></tr>`).join('')}</table>`));

  const pits = hist.pits[n] || [];
  const myStints = stintsOf(n);
  out.push(card('Tyres & stops', `<div class="stintRow">${stints.map(s => tyreChip(s.Compound, s.TotalLaps)).join('<span class="dimt"> → </span>') || '–'}</div>` + kv([
    ['Current tyre age', cur ? `${cur.TotalLaps ?? 0} laps${cur.New === 'false' ? ' (used set)' : ''}` : '–'],
    ['Pit stops', String(L.NumberOfPitStops ?? 0)],
    ['Pit lane times', pits.length ? pits.map(p => `${p.dur.toFixed(1)}s${p.lap ? ' L' + p.lap : ''}`).join(', ') : '–'],
    ['Pace this stint', (() => { const s = myStints.at(-1); const p = s && stintPace(s.laps, best); return p ? `${fmtLapT(p.avg)} avg · ${p.deg != null ? signed(p.deg, 2) + ' s/lap wear' : ''}` : '–'; })()],
  ])));

  if (kind === 'race') {
    const order = engOrder(), i = order.indexOf(n);
    const ref = refLap();
    const pw = pitWindow(n);
    out.push(card('If they pit this lap', pw ? kv([
      ['Rejoins', `P${pw.pos}`],
      ['Car ahead', pw.ahead ? `${chipD(pw.ahead.n)} ${fmt3(pw.ahead.gap)}s ahead` : 'nobody (leads)'],
      ['Car behind', pw.behind ? `${chipD(pw.behind.n)} ${fmt3(pw.behind.gap)}s behind` : '–'],
      ['Traffic', pw.ahead && pw.ahead.gap < 1.5 ? '<span class="c-red">rejoins in dirty air</span>' : '<span class="c-green">clear air</span>'],
      ['Pit loss used', `${pw.loss.toFixed(1)}s (${pw.why})`],
    ]) : '<p class="note">Needs a gap to the leader.</p>', 'wide'));
    const ah = order[i - 1], bh = order[i + 1];
    const gapAhead = gapSecs(L.IntervalToPositionAhead?.Value, ref);
    const gapBehind = bh ? gapSecs(L_()[bh]?.IntervalToPositionAhead?.Value, ref) : null;
    out.push(card('Gaps', kv([
      ['Ahead', ah ? `${chipD(ah)} ${fmt3(gapAhead)}s` : 'leading'],
      ['', ah ? trendText(gapAhead, pairTrend(ah, n), true) : ''],
      ['Behind', bh ? `${chipD(bh)} ${fmt3(gapBehind)}s` : '–'],
      ['', bh ? trendText(gapBehind, pairTrend(n, bh), false) : ''],
    ]), 'wide'));
  }
  if (kind === 'quali') out.push(card('Knockout', qualiStatus(n), 'wide'));
  return `<div class="dhead"><i style="background:${d.color}"></i><b>${esc(d.code)}</b> ${esc(d.name)} <span class="dimt">${esc(d.team)} · P${esc(L.Position || '–')}</span></div><div class="egrid">${out.join('')}</div>`;
}

function panelBattles() {
  const order = engOrder(), lines = L_(), ref = refLap();
  const rowsH = [];
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1], b = order[i];
    if (lines[b]?.Retired || lines[b]?.InPit) continue;
    const gap = gapSecs(lines[b]?.IntervalToPositionAhead?.Value, ref);
    if (gap == null || gap > 3) continue;
    const t = pairTrend(a, b);
    rowsH.push(`<tr><td class="mono">P${i + 1}</td><td>${chipD(b)} <span class="dimt">chasing</span> ${chipD(a)}</td>
      <td class="mono t">${fmt3(gap)}s</td><td>${gap <= 1 ? '<span class="drsb">DRS</span>' : ''}</td><td>${trendText(gap, t, true)}</td></tr>`);
  }
  return `<p class="note">Cars within 3 s of the car ahead. Trends use the last few laps and skip pit and safety car laps.</p>` +
    (rowsH.length ? `<table class="et wide"><tr><th>Pos</th><th>Battle</th><th class="t">Gap</th><th></th><th>Trend</th></tr>${rowsH.join('')}</table>` : '<p class="note">No close battles right now.</p>');
}

function qualiStatus(n) {
  const td = state.TimingData || {}, part = td.SessionPart || 1, cut = arr(td.NoEntries)[part];
  const order = engOrder(), lines = L_();
  if (lines[n]?.KnockedOut) return '<p class="note">Knocked out.</p>';
  const best = bestLap(n), pos = order.indexOf(n) + 1;
  if (!cut) {
    const pole = bestLap(order[0]);
    return kv([['Session', `Q${part} · fight for pole`], ['Gap to pole', best && pole ? signed(best - pole) : '–']]);
  }
  const lastSafe = bestLap(order[cut - 1]), firstOut = bestLap(order[cut]);
  if (!best) return kv([['Status', '<span class="c-red">no time set</span>'], ['Needed to get through', fmtLapT(lastSafe)]]);
  return pos <= cut
    ? kv([['Status', `<span class="c-green">through (P${pos} of top ${cut})</span>`], ['Safe by', firstOut ? signed(firstOut - best) : '–']])
    : kv([['Status', `<span class="c-red">in the drop zone (P${pos})</span>`], ['Needs to find', lastSafe ? signed(best - lastSafe) : '–']]);
}

function panelKnockout() {
  const td = state.TimingData || {}, part = td.SessionPart || 1, cut = arr(td.NoEntries)[part];
  const order = engOrder().filter(n => !L_()[n]?.KnockedOut), lines = L_();
  const ref = cut ? bestLap(order[cut - 1]) : bestLap(order[0]);
  const rowsH = order.map((n, i) => {
    const L = lines[n] || {}, best = bestLap(n), live = liveLap(n);
    let liveTxt = L.InPit ? '<span class="dimt">in pit</span>' : '<span class="dimt">on track</span>';
    if (live?.projected) {
      const projPos = order.filter(m => m !== n && (bestLap(m) ?? Infinity) < live.projected).length + 1;
      liveTxt = `S${live.done} <span class="${live.delta <= 0 ? 'c-green' : 'c-red'}">${signed(live.delta)}</span> → ${fmtLapT(live.projected)} <b>P${projPos}</b>`;
    }
    const line = cut && i === cut ? '<tr class="cutline"><td colspan="5">knockout line · top ' + cut + ' go through</td></tr>' : '';
    return `${line}<tr class="${cut && i >= cut ? 'drop' : ''}"><td class="mono">P${i + 1}</td><td>${chipD(n)}</td><td class="mono t">${fmtLapT(best)}</td>
      <td class="mono t">${best && ref ? signed(best - ref) : '–'}</td><td>${liveTxt}</td></tr>`;
  }).join('');
  return `<p class="note">Q${part}${cut ? ` · the top ${cut} go through` : ' · fight for pole'}. Projected laps assume the driver matches their best sectors for the rest of the lap.</p>
    <table class="et wide"><tr><th>Pos</th><th>Driver</th><th class="t">Best</th><th class="t">${cut ? 'vs cutoff' : 'vs pole'}</th><th>Live lap</th></tr>${rowsH}</table>`;
}

function panelLongRuns() {
  const rowsD = [];
  for (const n of drivers()) {
    const best = Math.min(...(hist.laps[n] || []).filter(clean).map(r => r.time));
    for (const s of stintsOf(n)) {
      const p = stintPace(s.laps, isFinite(best) ? best : null);
      if (p && p.n >= 5) rowsD.push({ n, c: s.c, ...p });
    }
  }
  if (!rowsD.length) return '<p class="note">No long runs yet. A long run is 5 or more clean laps on one set of tyres, recorded since the relay started.</p>';
  const order = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];
  rowsD.sort((a, b) => (order.indexOf(a.c) - order.indexOf(b.c)) || a.avg - b.avg);
  const bestAvg = {};
  for (const r of rowsD) bestAvg[r.c] ??= r.avg;
  return `<p class="note">Clean laps only: no pit laps, no flags, nothing slower than 107% of the driver's best. Wear is how much slower each lap gets as the tyres age.</p>
    <table class="et wide"><tr><th>Driver</th><th>Tyre</th><th class="t">Laps</th><th class="t">Average</th><th class="t">vs best avg</th><th class="t">Best</th><th class="t">Wear / lap</th></tr>
    ${rowsD.map(r => `<tr><td>${chipD(r.n)}</td><td>${tyreChip(r.c)}</td><td class="mono t">${r.n}</td><td class="mono t ${r.avg === bestAvg[r.c] ? 'c-purple' : ''}">${fmtLapT(r.avg)}</td>
      <td class="mono t">${signed(r.avg - bestAvg[r.c])}</td><td class="mono t">${fmtLapT(r.best)}</td><td class="mono t">${r.deg != null ? signed(r.deg, 3) : '–'}</td></tr>`).join('')}</table>`;
}

function panelStrategy() {
  const order = engOrder(), app = state.TimingAppData?.Lines || {};
  const total = sessionKind() === 'race' ? (+state.LapCount?.TotalLaps || 0) : 0;
  const sums = order.map(n => arr(app[n]?.Stints).reduce((a, s) => a + (+s.TotalLaps || 0), 0));
  const scale = Math.max(total, ...sums, 1);
  const curLap = +state.LapCount?.CurrentLap || 0;
  return `<div class="strat">${order.map((n, i) => {
    const stints = arr(app[n]?.Stints);
    return `<div class="srow"><div class="slabel">${chipD(n)}</div><div class="sbar">${stints.map(s => {
      const t = TYRES[s.Compound] || ['?', '#666'];
      const w = (+s.TotalLaps || 0) / scale * 100;
      return `<div class="seg" style="width:${w}%;background:${t[1]}" title="${esc(s.Compound)} · ${s.TotalLaps} laps${s.New === 'false' ? ' · used' : ''}">${w > 4 ? t[0] + ' ' + s.TotalLaps : ''}</div>`;
    }).join('')}${total && curLap ? `<div class="now" style="left:${curLap / scale * 100}%"></div>` : ''}</div></div>`;
  }).join('')}</div><p class="note">${total ? `Bars span the full ${total} laps. The line marks the current lap.` : 'Bar length is laps driven on each set.'} Tyre letters: S soft, M medium, H hard, I intermediate, W wet.</p>`;
}

function panelLaps(n) {
  const kind = sessionKind();
  const series = [n, engCompare && engCompare !== n ? engCompare : null].filter(Boolean)
    .map((m, i) => ({ n: m, d: dInfo(m), dash: i === 1 && dInfo(m).color === dInfo(n).color, laps: (hist.laps[m] || []).filter(r => r.time && r.lap) }));
  const all = series.flatMap(s => s.laps);
  if (!all.length) return `<p class="note">No laps recorded yet for this driver. Lap history builds up from when the relay started.</p>`;
  const cleanT = all.filter(clean).map(r => r.time);
  const best = Math.min(...(cleanT.length ? cleanT : all.map(r => r.time)));
  const yMin = best - 0.3, yMax = best * (kind === 'race' ? 1.06 : 1.09);
  const x0 = Math.min(...all.map(r => r.lap)), x1 = Math.max(...all.map(r => r.lap), x0 + 1);
  const W = 760, H = 260, pl = 58, pr = 12, pt = 12, pb = 28;
  const X = l => pl + (l - x0) / (x1 - x0) * (W - pl - pr);
  // Slower laps sit higher; anything off the scale is pinned to the top edge.
  const Y = t => pt + (yMax - Math.min(t, yMax)) / (yMax - yMin) * (H - pt - pb);
  let g = '';
  const step = (yMax - yMin) > 6 ? 2 : (yMax - yMin) > 3 ? 1 : 0.5;
  for (let t = Math.ceil(yMin / step) * step; t <= yMax; t += step)
    g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${pl - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${fmtLapT(t).replace(/\.\d+$/, m => m.slice(0, 2))}</text>`;
  const xs = Math.max(1, Math.ceil((x1 - x0) / 12));
  for (let l = x0; l <= x1; l += xs) g += `<text x="${X(l)}" y="${H - 8}" class="ax" text-anchor="middle">${l}</text>`;
  for (const s of series) {
    const pts = s.laps.filter(clean).sort((a, b) => a.lap - b.lap);
    let path = '', prev = null;
    for (const r of pts) { path += `${prev && r.lap - prev.lap === 1 && r.stint === prev.stint ? 'L' : 'M'}${X(r.lap).toFixed(1)} ${Y(r.time).toFixed(1)} `; prev = r; }
    g += `<path d="${path}" fill="none" stroke="${s.d.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ''} opacity=".85"/>`;
    for (const r of s.laps) {
      const t = TYRES[r.c] || ['?', '#888'];
      const off = r.time > yMax;
      g += `<circle cx="${X(r.lap)}" cy="${Y(r.time)}" r="${off ? 2.5 : 4}" fill="${clean(r) && !off ? t[1] : 'none'}" stroke="${clean(r) ? s.d.color : '#5b6170'}" stroke-width="1.5"><title>${s.d.code} lap ${r.lap}: ${esc(r.raw)}${r.c ? ' · ' + r.c : ''}${r.pit ? ' · pit lap' : ''}${(r.ts || '1') !== '1' ? ' · under flags' : ''}</title></circle>`;
    }
  }
  const summary = series.map(s => {
    const last5 = s.laps.filter(clean).slice(-5);
    const avg = last5.length ? last5.reduce((a, r) => a + r.time, 0) / last5.length : null;
    const st = stintsOf(s.n).at(-1); const p = st && stintPace(st.laps, best);
    return `<div>${chipD(s.n)} last 5 clean laps <b class="mono">${fmtLapT(avg)}</b> · wear this stint <b class="mono">${p?.deg != null ? signed(p.deg, 3) + ' s/lap' : '–'}</b></div>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}</svg><div class="lsum">${summary}</div>
    <p class="note">Dots are colored by tyre. Hollow dots are pit laps or laps under flags. Very slow laps sit on the top edge.</p>`;
}

// ---------- Mount ----------
function engRender() {
  const kind = sessionKind();
  const tabs = ENG_TABS[kind];
  const tab = tabs.some(t => t[0] === engTab[kind]) ? engTab[kind] : tabs[0][0];
  engTab[kind] = tab;
  const tabsHtml = tabs.map(([k, l]) => `<button class="etab${k === tab ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('');
  if ($('engTabs').innerHTML !== tabsHtml) $('engTabs').innerHTML = tabsHtml;

  const order = engOrder();
  const opts = order.map(n => `<option value="${n}">${esc(dInfo(n).code)}</option>`).join('');
  for (const id of ['engDriver', 'engCompare']) {
    const sel = $(id);
    const want = id === 'engCompare' ? '<option value="">none</option>' + opts : opts;
    if (sel.dataset.opts !== want && document.activeElement !== sel) { sel.innerHTML = want; sel.dataset.opts = want; }
  }
  const n = selected && order.includes(selected) ? selected : order[0];
  if (document.activeElement !== $('engDriver')) $('engDriver').value = n || '';
  if (engCompare == null && n) { const i = order.indexOf(n); engCompare = order[i ? i - 1 : 1] || ''; }
  if (document.activeElement !== $('engCompare')) $('engCompare').value = engCompare || '';
  $('cmpWrap').style.display = tab === 'laps' ? '' : 'none';
  $('drvWrap').style.display = ['driver', 'laps'].includes(tab) ? '' : 'none';

  if (!n) { $('engBody').innerHTML = '<p class="note">Waiting for timing data…</p>'; return; }
  const body = tab === 'driver' ? panelDriver(n) : tab === 'battles' ? panelBattles() : tab === 'knockout' ? panelKnockout()
    : tab === 'longruns' ? panelLongRuns() : tab === 'strategy' ? panelStrategy() : panelLaps(n);
  const recorded = Object.values(hist.laps).reduce((a, l) => a + l.length, 0);
  $('engInfo').textContent = `${recorded} laps recorded`;
  if ($('engBody').dataset.html !== body) { $('engBody').innerHTML = body; $('engBody').dataset.html = body; }
}

$('engTabs').addEventListener('click', e => {
  const k = e.target.dataset?.tab; if (!k) return;
  engTab[sessionKind()] = k; engDirty = true; engRender();
});
$('engDriver').addEventListener('change', e => { selected = e.target.value; engCompare = null; schedule(); engDirty = true; engRender(); });
$('engCompare').addEventListener('change', e => { engCompare = e.target.value; engDirty = true; engRender(); });
setInterval(() => {
  if (selected !== engLastSel) { engLastSel = selected; engCompare = null; engDirty = true; }
  if (engDirty) { engDirty = false; try { engRender(); } catch (err) { console.error(err); } }
}, 250);
