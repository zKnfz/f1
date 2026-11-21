// Race engineer panel. Uses the live state and helpers from index.html,
// plus the lap history the relay records (server.mjs).
// Tabs change with the session: race, qualifying, or practice.

// `hist` (lap history) and `engDirty` live in index.html, so no update is missed
// while this file is still loading.
let engTab = {}, engCompare = null, engLastSel;

const ENG_TABS = {
  race: [['driver', 'Driver'], ['proj', 'Projected'], ['battles', 'Battles'], ['laps', 'Lap times'], ['strategy', 'Strategy']],
  quali: [['driver', 'Driver'], ['proj', 'Projected'], ['knockout', 'Knockout'], ['laps', 'Lap times']],
  practice: [['driver', 'Driver'], ['proj', 'Projected'], ['longruns', 'Long runs'], ['laps', 'Lap times'], ['strategy', 'Tyres']],
};

// ---------- Data helpers ----------
const L_ = () => state.TimingData?.Lines || {};
const fmt3 = x => x == null || !isFinite(x) ? '–' : x.toFixed(3);
const fmtLapT = s => { if (s == null || !isFinite(s)) return '–'; const m = Math.floor(s / 60); const r = (s - m * 60).toFixed(3).padStart(6, '0'); return m ? `${m}:${r}` : r; };
const signed = (x, d = 3) => {
  if (x == null || !isFinite(x)) return '–';
  if (Math.abs(x) < 0.5 * 10 ** -d) x = 0; // no "−0.000"
  return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
};
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
// Which sector times belong to the lap in progress. F1 does not always clear last lap's
// sector times when a new lap starts, so watch the feed: a lap ends when LastLapTime arrives,
// and a sector counts once a new time for it arrives after that.
const lapTrack = {};
es.addEventListener('feed', e => {
  const [topic, data] = e.detail;
  if (topic !== 'TimingData' || !data?.Lines) return;
  for (const [n, u] of Object.entries(data.Lines)) {
    const t = lapTrack[n] ??= { known: false, fresh: [false, false, false] };
    const lapEnd = !!u?.LastLapTime?.Value;
    if (lapEnd) { t.known = true; t.fresh = [false, false, false]; }
    for (const [k, sec] of Object.entries(u?.Sectors || {})) {
      const i = Number(k);
      if (!(i >= 0 && i < 3) || sec?.Value === undefined) continue;
      if (lapEnd && i === 2) continue; // the final sector of the lap that just ended
      t.fresh[i] = !!sec.Value;
    }
  }
});
es.addEventListener('full', () => { for (const k in lapTrack) delete lapTrack[k]; });

// The lap in progress, projected from sector times and the coloured mini-sector bars.
// Purple and green bars mean matching or beating their best there, yellow means slower.
// The rest of the lap is assumed to go at the pace of the lap so far.
// Tuned on real laps from the 2026 Las Vegas FP3: about 0.6s average error in S1,
// 0.4s in S2 and 0.3s in S3, with no lean towards too fast or too slow.
const SEG_PURPLE = 2051, SEG_GREEN = 2049, SEG_YELLOW = 2048, SEG_PIT = 2064;
const YELLOW_COST = 0.006, PACE_WEIGHT = 0.75;
function liveLap(n) {
  const secs = arr(L_()[n]?.Sectors);
  const raw = secs.map(s => lapSecs(s?.Value));
  const segsOf = i => arr(secs[i]?.Segments).map(x => Number(x?.Status) || 0);
  const anyLit = i => segsOf(i).some(Boolean);
  let done = 0;
  const t = lapTrack[n];
  if (t?.known) { while (done < 3 && t.fresh[done] && raw[done] != null) done++; }
  else {
    // Before the first lap end since the page opened, go by which sector's bars are lit.
    const litIdx = [0, 1, 2].filter(anyLit);
    if (!litIdx.length) return null;
    done = Math.max(...litIdx);
    if ([0, 1, 2].slice(0, done).some(i => raw[i] == null)) return null;
  }
  if (done === 3) return null;
  const cur = [0, 1, 2].map(i => (i < done ? raw[i] : null));
  const inSegs = segsOf(done), last = inSegs.reduce((m, v, j) => (v ? j : m), -1);
  const lit = inSegs.slice(0, last + 1).filter(Boolean);
  if (done === 0 && !lit.length) return null;
  if ([0, 1, 2].slice(0, done + 1).flatMap(segsOf).includes(SEG_PIT)) return null; // out lap
  const pb = pbSectors(n);
  let doneT = 0, donePb = 0, nDone = 0;
  for (let i = 0; i < done; i++) { doneT += cur[i]; donePb += pb[i] ?? cur[i]; nDone += segsOf(i).filter(Boolean).length || 1; }
  const delta = doneT - donePb;
  if (pb.some(v => v == null)) return { done, cur, delta, projected: null, segDone: lit.length };

  const segR = v => v === SEG_PURPLE ? 1 - YELLOW_COST / 3 : v === SEG_GREEN ? 1 : v === SEG_YELLOW ? 1 + YELLOW_COST : null;
  const litR = lit.map(segR).filter(v => v != null);
  const curR = litR.length ? litR.reduce((a, b) => a + b, 0) / litR.length : null;
  let w = 0, sum = 0;
  if (done) { sum += (doneT / donePb) * nDone; w += nDone; }
  if (curR != null) { sum += curR * litR.length; w += litR.length; }
  const soften = x => 1 + (x - 1) * PACE_WEIGHT;
  const r = Math.min(1.15, Math.max(0.98, soften(w ? sum / w : 1)));
  const frac = inSegs.length ? (last + 1) / inSegs.length : 0;
  let projected = doneT + pb[done] * (curR != null ? frac * soften(curR) + (1 - frac) * r : r);
  for (let i = done + 1; i < 3; i++) projected += pb[i] * r;
  return { done, cur, delta, projected, segDone: lit.length, segTotal: inSegs.length, pace: r };
}
// Compare a lap in progress with the fastest lap of the session.
function flRows(n, live) {
  const f = window.sessionFastest;
  if (!f || !live?.projected) return [];
  const d = live.projected - f.t;
  const left = live.cur.map((v, i) => v == null ? 'S' + (i + 1) : null).filter(Boolean).join(' + ');
  const who = f.n === n ? 'their own' : (state.DriverList?.[f.n]?.Tla || '#' + f.n) + "'s";
  const verdict = d < 0
    ? `<b class="c-purple">⚡ On for the fastest lap (${signed(d)})</b>`
    : `<span class="${d < 0.3 ? 'c-yellow' : 'dimt'}">No, ${fmt3(d)}s too slow${left ? ` · must find it in ${left}` : ''}</span>`;
  return [
    ['Fastest lap', `${fmtLapT(f.t)} <span class="dimt">${esc(who)}</span>`],
    ['Beat it?', verdict],
    ...(left ? [['', `<span class="dimt">Updates with each mini-sector of ${esc(left)}.</span>`]] : []),
  ];
}
// Every car partway through a lap, ranked by projected lap against the session's fastest.
function flWatch(sel) {
  const f = window.sessionFastest;
  const cars = drivers().map(n => {
    const L = L_()[n] || {};
    if (L.InPit || L.Retired || L.Stopped) return null;
    const lv = liveLap(n);
    return lv?.projected ? { n, lv } : null;
  }).filter(Boolean).sort((a, b) => a.lv.projected - b.lv.projected);
  const head = f ? `<p class="note">Fastest lap: <b>${fmtLapT(f.t)}</b> ${esc(state.DriverList?.[f.n]?.Tla || '')}</p>` : '';
  if (!cars.length) return head + '<p class="note">No one is partway through a lap right now. Cars show here after their first sector.</p>';
  return head + `<table class="et"><tr><th></th><th>Done</th><th>Projected</th><th>vs fastest</th></tr>${cars.slice(0, 8).map(({ n, lv }) => {
    const d = f ? lv.projected - f.t : null;
    const cls = d != null && d < 0 ? 'c-purple' : d != null && d < 0.3 ? 'c-yellow' : '';
    return `<tr class="${n === sel ? 'selrow' : ''}"><td><b>${esc(state.DriverList?.[n]?.Tla || n)}</b></td><td class="mono">in S${Math.min(3, lv.done + 1)}</td><td class="mono">${fmtLapT(lv.projected)}</td><td class="mono ${cls}">${d != null && d < 0 ? '⚡ ' : ''}${signed(d)}</td></tr>`;
  }).join('')}</table>`;
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

  // Between laps (or in the garage) show the last completed lap instead of a blank card.
  const prev = arr(L.Sectors).map(x => lapSecs(x?.PreviousValue));
  const lastSecs = prev.every(v => v != null) ? prev : null;
  const secRow = (v, i, wait) => [`Sector ${i + 1}`, v != null
    ? `${fmt3(v)} <span class="${v - (pb[i] ?? v) <= 0 ? 'c-green' : 'c-red'}">${pb[i] != null ? signed(v - pb[i]) : ''}</span>`
    : `<span class="dimt">${wait}</span>`];
  let liveBody;
  if (live) {
    liveBody = kv([...live.cur.map((v, i) => secRow(v, i, 'on track')),
      ['Delta to best sectors', `<span class="${live.delta <= 0 ? 'c-green' : 'c-red'}">${signed(live.delta)}</span>`],
      ['Projected lap', live.projected ? `<b>${live.done === 0 ? '≈' : ''}${fmtLapT(live.projected)}</b>${live.done === 0 ? ' <span class="dimt">rough until S1 is done</span>' : ''}` : '–'],
      ...flRows(n, live)]);
  } else if (lastSecs) {
    const total = lastSecs.reduce((a, b) => a + b, 0);
    const dBest = pb.every(v => v != null) ? total - pb.reduce((a, b) => a + b, 0) : null;
    liveBody = `<p class="note">${L.InPit ? 'In the pits. Showing their last lap.' : 'New lap started. Showing their last lap until sector 1 is done.'}</p>`
      + kv([...lastSecs.map((v, i) => secRow(v, i, '')),
        ['Delta to best sectors', dBest == null ? '–' : `<span class="${dBest <= 0 ? 'c-green' : 'c-red'}">${signed(dBest)}</span>`],
        ['Last lap', esc(L.LastLapTime?.Value || fmtLapT(total))]]);
  } else {
    liveBody = `<p class="note">${L.InPit ? 'In the pits.' : 'Shows once the first sector of a lap is done.'}</p>`;
  }
  out.push(card('Live lap', liveBody));
  out.push(card('Fastest-lap watch', flWatch(n)));

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
      liveTxt = `in S${Math.min(3, live.done + 1)} <span class="${live.delta <= 0 ? 'c-green' : 'c-red'}">${signed(live.delta)}</span> → ${fmtLapT(live.projected)} <b>P${projPos}</b>`;
    }
    const line = cut && i === cut ? '<tr class="cutline"><td colspan="5">knockout line · top ' + cut + ' go through</td></tr>' : '';
    return `${line}<tr class="${cut && i >= cut ? 'drop' : ''}"><td class="mono">P${i + 1}</td><td>${chipD(n)}</td><td class="mono t">${fmtLapT(best)}</td>
      <td class="mono t">${best && ref ? signed(best - ref) : '–'}</td><td>${liveTxt}</td></tr>`;
  }).join('');
  return `<p class="note">Q${part}${cut ? ` · the top ${cut} go through` : ' · fight for pole'}. Projected laps update with every mini-sector, at the pace of the lap so far.</p>
    <table class="et wide"><tr><th>Pos</th><th>Driver</th><th class="t">Best</th><th class="t">${cut ? 'vs cutoff' : 'vs pole'}</th><th>Live lap</th></tr>${rowsH}</table>`;
}

// Every car out on track, with the lap time it is heading for.
function panelProjected() {
  const lines = L_(), race = sessionKind() === 'race';
  const f = window.sessionFastest;
  const all = engOrder();
  const fin = arr(state.RaceControlMessages?.Messages).some(m => m.Flag === 'CHEQUERED');
  const cars = all.map(n => {
    const L = lines[n] || {};
    if (L.InPit || L.Retired || L.Stopped || L.KnockedOut || (fin && (Number(L.Status) & 1024))) return null;
    return { n, L, lv: liveLap(n), pb: pbSectors(n), best: bestLap(n) };
  }).filter(Boolean);
  // Where a time would land among the best laps already set (ignoring the driver's own).
  const posFor = (n, t) => all.filter(m => m !== n && (bestLap(m) ?? Infinity) < t).length + 1;
  const posNow = n => { const b = bestLap(n); return b ? posFor(n, b) : null; };

  cars.sort((a, b) => (a.lv?.projected ?? Infinity) - (b.lv?.projected ?? Infinity) || (b.lv?.done ?? 0) - (a.lv?.done ?? 0));
  const secCell = (v, pb, i, cur) => {
    if (v != null) return `<td class="mono t ${pb != null && v <= pb ? 'c-green' : 'c-yellow'}">${fmt3(v)}</td>`;
    const later = cur && cur.slice(i + 1).some(x => x != null);
    const next = cur && !later && cur.findIndex(x => x == null) === i;
    return `<td class="mono t dimt">${later ? '–' : next ? 'on it' : ''}</td>`;
  };
  const rowsH = cars.map(({ n, L, lv, pb, best }) => {
    const cur = lv?.cur || [null, null, null];
    const pNow = race ? null : posNow(n);
    const bestCell = `<td class="mono t pjbest">${best ? fmtLapT(best) : '<span class="dimt">no time</span>'}</td>`;
    let tail = `<td class="mono t dimt" colspan="${race ? 2 : 3}">${L.PitOut ? 'out lap' : 'starting a lap'}</td>`;
    if (lv?.projected) {
      const p = lv.projected, beatFL = f && p < f.t;
      const dBest = best ? p - best : null;
      let posTxt = '';
      if (!race) {
        const pNew = posFor(n, p);
        posTxt = !best ? `<b>P${pNew}</b>` : dBest < 0 && pNew < pNow ? `P${pNow} → <b class="c-green">P${pNew}</b>` : `P${pNow} <span class="dimt">stays</span>`;
      }
      tail = `<td class="mono t ${beatFL ? 'c-purple' : ''}${lv.done === 0 ? ' rough' : ''}" title="${lv.done === 0 ? 'Rough until sector 1 is done' : ''}"><b>${beatFL ? '⚡ ' : ''}${lv.done === 0 ? '≈' : ''}${fmtLapT(p)}</b></td>`
        + `<td class="mono t ${dBest == null ? 'dimt' : dBest < 0 ? 'c-green' : 'c-red'}">${dBest == null ? 'first' : signed(dBest)}</td>`
        + (race ? '' : `<td class="mono t">${posTxt}</td>`);
    }
    return `<tr class="${n === selected ? 'selrow' : ''}"><td>${chipD(n)}</td>${[0, 1, 2].map(i => secCell(cur[i], pb[i], i, lv?.cur)).join('')}${bestCell}${tail}</tr>`;
  }).join('');
  const table = cars.length
    ? `<table class="et wide pj"><tr><th>Driver</th><th class="t">S1</th><th class="t">S2</th><th class="t">S3</th><th class="t pjbest">Best now</th><th class="t">Projected</th><th class="t">vs best</th>${race ? '' : '<th class="t">Position</th>'}</tr>${rowsH}</table>`
    : '<p class="note">No cars are out on track right now.</p>';

  // Leaderboard of best laps so far, with laps in progress slotted in where they would land.
  let board = '';
  if (!race) {
    const entries = all.filter(n => bestLap(n)).map(n => ({ n, t: bestLap(n), live: false }));
    for (const c of cars) {
      const p = c.lv?.projected;
      if (p && (!c.best || p < c.best)) entries.push({ n: c.n, t: p, live: true, done: c.lv.done });
    }
    entries.sort((a, b) => a.t - b.t);
    const top = entries.find(e => !e.live)?.t;
    const cut = sessionKind() === 'quali' ? arr(state.TimingData?.NoEntries)[(state.TimingData?.SessionPart || 1)] : null;
    let pos = 0;
    board = entries.map(e => {
      if (!e.live) pos++;
      const line = cut && !e.live && pos === cut + 1 ? `<tr class="cutline"><td colspan="3">knockout line</td></tr>` : '';
      const gap = top ? (e.t === top && !e.live ? 'P1' : signed(e.t - top)) : '';
      return line + (e.live
        ? `<tr class="pjlive"><td class="mono">↳</td><td>${chipD(e.n)} <span class="dimt">in S${Math.min(3, e.done + 1)}</span></td><td class="mono t">${fmtLapT(e.t)} <span class="dimt">${gap}</span></td></tr>`
        : `<tr><td class="mono">P${pos}</td><td>${chipD(e.n)}</td><td class="mono t">${fmtLapT(e.t)} <span class="dimt">${gap}</span></td></tr>`);
    }).join('');
    board = `<div class="ecard"><h4>Leaderboard + laps in progress</h4><p class="note">Best laps so far. Highlighted rows are laps happening now, placed where they would land.</p><table class="et">${board}</table></div>`;
  }
  return `<p class="note">${f ? `Fastest lap: <b>${fmtLapT(f.t)}</b> ${esc(dInfo(f.n).code)}. ` : ''}Projections update with every mini-sector: yellow bars make it slower, green and purple keep it on pace, and the rest of the lap is assumed to go at the pace so far. ≈ means rough: before sector 1 is done it can be a second or two out. Green sector times beat their best, yellow ones don't.</p>
    <div class="${race ? '' : 'pjgrid'}"><div>${table}</div>${board}</div>`;
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
  const body = tab === 'driver' ? panelDriver(n) : tab === 'battles' ? panelBattles() : tab === 'knockout' ? panelKnockout() : tab === 'proj' ? panelProjected()
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
