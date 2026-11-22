// Race engineer panel. Uses the live state and helpers from index.html,
// plus the lap history the relay records (server.mjs).
// Tabs change with the session: race, qualifying, or practice.

// `hist` (lap history) and `engDirty` live in index.html, so no update is missed
// while this file is still loading.
let engTab = {}, engCompare = null, engLastSel;

const ENG_TABS = {
  race: [['call', 'Race call'], ['driver', 'Driver'], ['proj', 'Projected'], ['battles', 'Battles'], ['laps', 'Lap times'], ['strategy', 'Strategy']],
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
// The sector times a projection is measured against: the driver's own best sectors. A driver
// with no proper lap yet only has slow ones (an out lap, a cool-down lap), which used to give
// projections many seconds out. `loose` marks that: a best sector missing or more than 4%
// off the quickest in the field. Those laps are projected from the field's sectors instead.
const REF_CAP = 1.04;
function refSectors(n) {
  const pb = pbSectors(n), fb = fieldBestSectors();
  const loose = fb.every(Boolean) && [0, 1, 2].some(i => pb[i] == null || pb[i] > fb[i] * REF_CAP);
  return { pb: loose ? pb.map((v, i) => (v == null || v > fb[i] * REF_CAP ? fb[i] * REF_CAP : v)) : pb, loose, fb };
}
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

// Speed at the first intermediate this lap, tracked the same way, to spot laps where a
// driver is not pushing before any sector time is in.
const i1Track = {};
es.addEventListener('feed', e => {
  const [topic, data] = e.detail;
  if (topic !== 'TimingData' || !data?.Lines) return;
  for (const [n, u] of Object.entries(data.Lines)) {
    if (u?.LastLapTime?.Value) i1Track[n] = null;
    const v = Number(u?.Speeds?.I1?.Value);
    if (v) i1Track[n] = v;
  }
});

// ---------- Shared learning ----------
// A scheduled job on GitHub opens this same page during every session and saves what it
// learned into the repo's learned/ folder. Each browser picks that up when it has learned
// from more laps than the browser itself, so nobody starts from zero or misses a session.
const SHARED_BASE = (() => {
  const h = location.hostname;
  if (!h.endsWith('.github.io')) return 'learned/';
  // Read straight from the repo so it is fresh even before the site itself is rebuilt.
  return `https://raw.githubusercontent.com/${h.split('.')[0]}/${location.pathname.split('/')[1]}/main/learned/`;
})();
let sharedIndex = null;
const sharedTried = {};
function sharedAdopt(key, localSize, apply) {
  if (sharedTried[key]) return;
  sharedTried[key] = 1;
  sharedIndex ??= fetch(SHARED_BASE + 'index.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  sharedIndex.then(idx => {
    if (!(idx.files?.[key] > localSize())) return;
    return fetch(`${SHARED_BASE}${key}.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(d => { if (d) apply(d); });
  }).catch(() => {});
}

// ---------- Lap projection (self-tuning) ----------
// A lap in progress is projected as:
//   time so far + (driver's best times for the rest of the lap) × (1 + adjustment)
// The adjustment is a weighted sum of inputs (pace so far, coloured bars, tyres), plus a
// per-driver nudge. The weights start from values fitted on recorded laps, then the site keeps
// refitting them after every completed lap, saved per track in this browser. Newer laps count
// more, so it follows the track getting faster.
const SEG_PURPLE = 2051, SEG_GREEN = 2049, SEG_YELLOW = 2048, SEG_PIT = 2064;
// Inputs: [constant, pace in finished sectors, share of the rest driven on yellow bars,
//          share on purple bars, tyre age (per 10 laps), compound vs the one they set their best on]
const FEATS = ['base', 'pace so far', 'yellow bars', 'purple bars', 'tyre age', 'harder tyre'];
const PRIOR = {
  quali: [-0.003, 0.15, 0.0065, -0.002, 0.003, 0.005], // the track gets quicker through qualifying
  race:  [0.0075, 0.2,  0.0065, -0.002, 0.001, 0.004],
  other: [0.004,  0.12, 0.0065, -0.002, 0.003, 0.005],
};
// How strongly the starting values hold before enough laps are in (in laps' worth), and the
// typical size of each input so that strength means the same thing for each.
const PRIOR_LAPS = 15, FEAT_SCALE = [1, 0.02, 0.15, 0.1, 0.8, 1];
const FORGET = 0.997; // each new sample makes older ones count a little less
// Usual error per second of lap still to go (learned; starts from the recorded laps).
// Separate for a lap still in S1, one with S1 done, and one with S2 done.
const SIGMA_PRIOR = [0.0125, 0.009, 0.0105], SIGMA_PRIOR_N = 15;
// Beyond these, a practice or qualifying lap is a cool-down or an aborted lap.
const SLOW_AFTER = [0.07, 0.045], SLOW_I1 = 0.9;
const COMPOUND = { SOFT: 0, MEDIUM: 1, HARD: 2 };

const modelGroup = () => { const k = sessionKind(); return k === 'race' ? 'race' : k === 'quali' ? 'quali' : 'other'; };
const modelKey = () => `pitwall-model-v4-${state.SessionInfo?.Meeting?.Circuit?.Key ?? 'x'}-${modelGroup()}`;
const MAX_Y = 0.05;
let model = null; // { key, A (6×6), b (6), laps, used: {lapId: 1}, theta, drv: {n: [residuals]} }

function blankModel(key) {
  return { key, A: Array.from({ length: 6 }, () => Array(6).fill(0)), b: Array(6).fill(0), laps: 0, used: {}, drv: {}, theta: null, e2: 0, en: 0 };
}
function loadModel() {
  const key = modelKey();
  if (model?.key === key) return model;
  let m = null;
  try { m = JSON.parse(localStorage.getItem(key)); } catch {}
  model = m?.key === key ? m : blankModel(key);
  model.theta = null;
  trainFromHistory();
  sharedAdopt(key, () => (model?.key === key ? model.laps : 0), d => {
    if (d.key !== key || model?.key !== key || !(d.laps > model.laps)) return;
    model = { ...blankModel(key), ...d, theta: null };
    trainFromHistory(); // add any laps this browser has that the shared one has not seen
    engDirty = true;
  });
  return model;
}
let saveModelTimer = null;
function saveModel() {
  if (saveModelTimer) return;
  saveModelTimer = setTimeout(() => {
    saveModelTimer = null;
    try {
      const ids = Object.keys(model.used);
      if (ids.length > 3000) for (const id of ids.slice(0, ids.length - 3000)) delete model.used[id];
      localStorage.setItem(model.key, JSON.stringify({ ...model, theta: null }));
    } catch {}
  }, 2000);
}
// Solve (A + prior) θ = b + prior·θ0 by Gaussian elimination.
function solveTheta(m) {
  const p = PRIOR[modelGroup()];
  const M = m.A.map((row, i) => row.slice()), v = m.b.slice();
  for (let i = 0; i < 6; i++) { const lam = PRIOR_LAPS * FEAT_SCALE[i] ** 2; M[i][i] += lam; v[i] += lam * p[i]; }
  for (let c = 0; c < 6; c++) {
    let piv = c; for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]]; [v[c], v[piv]] = [v[piv], v[c]];
    if (Math.abs(M[c][c]) < 1e-12) return p.slice();
    for (let r = 0; r < 6; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      if (f) { for (let k = c; k < 6; k++) M[r][k] -= f * M[c][k]; v[r] -= f * v[c]; }
    }
  }
  const th = v.map((x, i) => x / M[i][i]);
  return th.every(isFinite) ? th : p.slice();
}
function theta() { const m = loadModel(); return (m.theta ??= solveTheta(m)); }
function addSample(m, f, y, w, n, stage = 1) {
  if (!(Math.abs(y) < MAX_Y)) return; // a lap this far from its reference was not a like-for-like lap
  const pred = f.reduce((a, x, i) => a + x * (m.theta ?? solveTheta(m))[i], 0);
  for (let i = 0; i < 6; i++) {
    m.b[i] = m.b[i] * FORGET + w * f[i] * y;
    for (let j = 0; j < 6; j++) m.A[i][j] = m.A[i][j] * FORGET + w * f[i] * f[j];
  }
  m.theta = null;
  const r = (m.drv[n] ??= []); r.push(y - pred); if (r.length > 12) r.shift();
  const g = ((m.sg ??= {})[stage] ??= { e2: 0, en: 0 });
  g.e2 = g.e2 * FORGET + w * (y - pred) ** 2; g.en = g.en * FORGET + w;
}
function driverNudge(n) {
  const r = loadModel().drv[n] || [];
  return r.length ? Math.max(-0.01, Math.min(0.02, r.reduce((a, b) => a + b, 0) / (r.length + 6))) : 0;
}

// Tyre inputs: age in tens of laps, and compound steps harder than the set their best came on.
function bestCompound(n) {
  let best = null;
  for (const r of hist.laps[n] || []) if (r.time && !r.pit && (!best || r.time < best.time)) best = r;
  return best?.c ?? null;
}
function tyreFeats(compound, age, n) {
  const c = COMPOUND[compound], pc = COMPOUND[bestCompound(n)];
  return [Math.min(Math.max((Number(age) || 1) - 1, 0), 20) / 10, c != null && pc != null ? c - pc : 0];
}

// Learn from the laps already saved for this session (sector times only, no bars).
function trainFromHistory() {
  const m = model;
  if (!hist.key) return;
  for (const [n, laps] of Object.entries(hist.laps)) {
    let pb = [null, null, null], best = null;
    for (const r of laps) {
      const sc = r.s || [];
      const ok = sc.length === 3 && sc.every(x => x > 0) && !r.pit && (r.ts || '1') === '1';
      if (!ok) continue;
      const id = `${hist.key}:${n}:${r.lap}`;
      // The saved history can start partway through a session, so only learn once the
      // best sectors seen so far are close to the driver's real ones.
      const real = pbSectors(n), realSum = real.every(Boolean) ? real.reduce((a, b) => a + b, 0) : null;
      const settled = realSum && pb.every(Boolean) && pb.reduce((a, b) => a + b, 0) <= realSum * 1.01;
      if (settled && best && r.time < best * 1.03 && !m.used[id]) {
        m.used[id] = 1; m.laps++;
        const tf = tyreFeats(r.c, r.age, n);
        for (const done of [1, 2]) {
          const doneT = sc.slice(0, done).reduce((a, b) => a + b, 0), donePb = pb.slice(0, done).reduce((a, b) => a + b, 0);
          const pbRest = pb.slice(done).reduce((a, b) => a + b, 0);
          addSample(m, [1, doneT / donePb - 1, 0, 0, ...tf], (r.time - doneT) / pbRest - 1, 1, n, done);
        }
      }
      pb = pb.map((p, i) => (p == null || sc[i] < p ? sc[i] : p));
      best = best == null || r.time < best ? r.time : best;
    }
  }
  saveModel();
}
es.addEventListener('history', () => setTimeout(() => { model = null; }, 0));

// Snapshots of each lap in progress, turned into learning samples once the lap time is in.
const lapSnaps = {}, doneSnaps = {};
es.addEventListener('feed', e => {
  const [topic, data] = e.detail;
  if (topic !== 'TimingData' || !data?.Lines) return;
  for (const n of Object.keys(data.Lines)) {
    if (data.Lines[n]?.LastLapTime?.Value) { doneSnaps[n] = lapSnaps[n]; lapSnaps[n] = {}; continue; }
    const p = lapInputs(n);
    if (!p || p.slow) continue;
    // Keep one snapshot per quarter of each sector, so every lap counts about the same.
    if (p.loose) continue; // no proper reference lap yet: nothing to learn from
    (lapSnaps[n] ??= {})[`${p.done}:${Math.min(3, Math.floor(p.frac * 4))}`] = { f: p.f, doneT: p.doneT, pbRest: p.pbRest, done: p.done };
  }
});
es.addEventListener('lap', e => {
  const [n, rec] = e.detail;
  const snaps = Object.values(doneSnaps[n] || {}); doneSnaps[n] = null;
  if (!snaps.length || !rec?.time || rec.pit || (rec.ts || '1') !== '1') return;
  const best = bestLap(n);
  if (best && rec.time > best * 1.03) return; // not a push lap
  if (flagDone[n]?.hit) return; // lifted for a yellow flag
  const m = loadModel(), id = `${hist.key}:${n}:${rec.lap}`;
  if (m.used[id]) return;
  m.used[id] = 1; m.laps++;
  for (const s of snaps) addSample(m, s.f, (rec.time - s.doneT) / s.pbRest - 1, 3 / snaps.length, n, s.done);
  saveModel();
});

// Where a driver is on the current lap and the model inputs for it.
function lapInputs(n) {
  const secs = arr(L_()[n]?.Sectors);
  const raw = secs.map(s => lapSecs(s?.Value));
  const segsOf = i => arr(secs[i]?.Segments).map(x => Number(x?.Status) || 0);
  let done = 0;
  const t = lapTrack[n];
  if (t?.known) { while (done < 3 && t.fresh[done] && raw[done] != null) done++; }
  else {
    // Before the first lap end since the page opened, go by which sector's bars are lit.
    const litIdx = [0, 1, 2].filter(i => segsOf(i).some(Boolean));
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
  const { pb, loose, fb } = refSectors(n);
  let doneT = 0, donePb = 0;
  for (let i = 0; i < done; i++) { doneT += cur[i]; donePb += pb[i] ?? cur[i]; }
  if (loose && done) {
    // No proper lap of their own to go by: assume the rest of the lap is as far off the
    // field's best sectors as the part already done.
    const k = doneT / fb.slice(0, done).reduce((a, b) => a + b, 0);
    for (let i = 0; i < 3; i++) pb[i] = i < done ? cur[i] : fb[i] * k;
    donePb = doneT;
  }
  const segCounts = [0, 1, 2].map(i => segsOf(i).length), segAll = segCounts.reduce((a, b) => a + b, 0);
  const lapFrac = segAll ? (segCounts.slice(0, done).reduce((a, b) => a + b, 0) + last + 1) / segAll : null;
  const out = { done, cur, doneT, lapFrac, loose, delta: doneT - donePb, frac: inSegs.length ? (last + 1) / inSegs.length : 0, segDone: lit.length, segTotal: inSegs.length };
  if (pb.some(v => v == null)) return out;

  // Not pushing? Only in practice and qualifying, where not every lap is a flying lap.
  if (sessionKind() !== 'race') {
    const bestI1 = Number(state.TimingStats?.Lines?.[n]?.BestSpeeds?.I1?.Value), i1 = i1Track[n];
    if ((done && out.delta / donePb > SLOW_AFTER[done - 1]) || (i1 && bestI1 && i1 < bestI1 * SLOW_I1)) return { ...out, slow: true };
  }
  const pbRest = pb.slice(done).reduce((a, b) => a + b, 0);
  const share = k => inSegs.length ? lit.filter(v => v === k).length / inSegs.length * pb[done] / pbRest : 0;
  const st = arr(state.TimingAppData?.Lines?.[n]?.Stints).at(-1) || {};
  const f = [1, done ? doneT / donePb - 1 : 0, share(SEG_YELLOW), share(SEG_PURPLE), ...tyreFeats(st.Compound, st.TotalLaps, n)];
  return { ...out, f, pbRest };
}

function liveLap(n) {
  const p = lapInputs(n);
  if (!p) return null;
  const base = { done: p.done, cur: p.cur, delta: p.delta, segDone: p.segDone, segTotal: p.segTotal, lapFrac: p.lapFrac, loose: p.loose };
  if (p.slow) return { ...base, projected: null, slow: true };
  if (!p.f) return { ...base, projected: null };
  const th = theta();
  const adj = p.loose && p.done ? 0 : p.f.reduce((a, x, i) => a + x * th[i], 0) + driverNudge(n);
  return { ...base, left: p.pbRest, projected: p.doneT + p.pbRest * (1 + Math.max(-0.02, Math.min(0.15, adj))) };
}
// What the model has learned, for display.
function modelInfo() {
  const m = loadModel();
  return { laps: m.laps, theta: theta() };
}

// Compare a lap in progress with the fastest lap of the session.
function flRows(n, live) {
  const f = window.sessionFastest;
  if (!f || !live?.projected || live.done < 1) return []; // too early to call before sector 1 is in
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
    return lv?.projected && lv.done >= 1 ? { n, lv } : null;
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
      ['Projected lap', live.slow ? '<span class="dimt">slow lap · not pushing</span>' : live.projected ? `<b>${live.done === 0 ? '≈' : ''}${fmtLapT(live.projected)}</b>${live.done === 0 ? ' <span class="dimt">rough until S1 is done</span>' : ''}` : '–'],
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
// ---------- Flags and deleted laps ----------
// Race control names yellow flags by marshal sector. The circuit data says where each marshal
// sector starts around the lap, so a yellow can be placed ahead of, or on top of, each car.
let flagCache = { key: '' }, trackTotalCache = { c: null, v: 0 };
function trackTotal() {
  if (trackTotalCache.c === circuitInfo) return trackTotalCache.v;
  const x = circuitInfo?.x || [], y = circuitInfo?.y || [];
  let t = 0;
  for (let i = 0; i < x.length; i++) { const j = (i + 1) % x.length; t += Math.hypot(x[j] - x[i], y[j] - y[i]); }
  trackTotalCache = { c: circuitInfo, v: t };
  return t;
}
function flagState() {
  const msgs = arr(state.RaceControlMessages?.Messages);
  const key = `${state.SessionInfo?.Key}:${msgs.length}:${circuitInfo ? 1 : 0}`;
  if (flagCache.key === key) return flagCache;
  const active = {}, deleted = {};
  for (const m of msgs) {
    if (m.Category === 'Flag' && m.Scope === 'Sector' && m.Sector != null) {
      if (m.Flag === 'CLEAR') delete active[m.Sector];
      else if (/YELLOW/.test(m.Flag || '')) active[m.Sector] = m.Flag === 'DOUBLE YELLOW' ? 2 : 1;
    } else if (m.Category === 'Flag' && m.Scope === 'Track' && (m.Flag === 'GREEN' || m.Flag === 'CLEAR')) {
      for (const k in active) delete active[k];
    }
    const d = /^CAR (\d+) \(\w+\) (?:LAP|TIME [\d:.]+) DELETED\b.*?\bLAP (\d+)/.exec(m.Message || '');
    if (d) (deleted[d[1]] ??= new Set()).add(Number(d[2]));
  }
  // Each active yellow as a stretch of the lap, 0 to 1.
  const ms = arr(circuitInfo?.marshalSectors).slice().sort((a, b) => a.number - b.number), total = trackTotal();
  const zones = [];
  for (const [sec, level] of Object.entries(active)) {
    const i = ms.findIndex(s => s.number === Number(sec));
    if (i < 0 || !total) { zones.push({ level, a: null, b: null }); continue; }
    zones.push({ level, a: ms[i].length / total, b: i + 1 < ms.length ? ms[i + 1].length / total : 1 });
  }
  return (flagCache = { key, zones, deleted });
}
// What flags do to a lap in progress: a multiplier on its chance, and a short label.
const flagNow = {}, flagDone = {};
function flagRisk(n, lv) {
  const fs = flagState();
  const lapNo = (Number(L_()[n]?.NumberOfLaps) || 0) + 1;
  if (fs.deleted[n]?.has(lapNo)) return { mult: 0, label: 'lap deleted', cls: 'r' };
  const ts = state.TrackStatus?.Status || '1';
  if (ts === '5') return { mult: 0, label: 'red flag', cls: 'r' };
  if (ts === '4' || ts === '6' || ts === '7') return { mult: 0.02, label: 'safety car', cls: 'y' };
  const st = (flagNow[n] ??= { hit: 0 });
  let ahead = 0, near = 0;
  // Sector yellows only count while the track status itself says yellow, so one that race
  // control never cleared in the messages cannot linger.
  for (const z of ts === '2' ? fs.zones : []) {
    if (z.a == null || lv.lapFrac == null) { ahead = Math.max(ahead, z.level); continue; } // no map: assume it matters
    // The position moves in steps (one per bar), and the car is really up to a step further on.
    // So a zone counts as driven through if it overlaps anything from the last known position
    // to one step past the current one.
    if (z.a < lv.lapFrac + 0.05 && z.b > (st.prev ?? lv.lapFrac)) st.hit = Math.max(st.hit, z.level);
    else if (z.a >= lv.lapFrac) { ahead = Math.max(ahead, z.level); if (z.a - lv.lapFrac < 0.25) near = Math.max(near, z.level); }
  }
  if (lv.lapFrac != null) st.prev = lv.lapFrac;
  if (st.hit) return { mult: st.hit === 2 ? 0.03 : 0.08, label: 'drove through yellow', cls: 'y' };
  if (near) return { mult: near === 2 ? 0.1 : 0.25, label: 'yellow just ahead', cls: 'y' };
  if (ahead) return { mult: ahead === 2 ? 0.4 : 0.6, label: 'yellow ahead', cls: 'y' };
  return { mult: 1, label: '', cls: '' };
}

// ---------- Projected tab (animated) ----------
// How unsure a projection is, in seconds. Errors grow with how much of the lap is left;
// the size per second of lap left is learned along with the model (see addSample).
function projSigma(lv) {
  const g = loadModel().sg?.[lv.done] || { e2: 0, en: 0 }, p0 = SIGMA_PRIOR[lv.done] ?? 0.01;
  const k = Math.sqrt((g.e2 + p0 ** 2 * SIGMA_PRIOR_N) / (g.en + SIGMA_PRIOR_N));
  return Math.max(0.06, k * (lv.left ?? 30)) * (lv.loose ? 2.5 : 1);
}

// ---------- Chance calibration ----------
// Makes the chances honest: if laps shown at 80% only come true 6 times in 10, later ones
// are shown lower. It fits a correction (shift and stretch on the log-odds scale) to every
// checked lap from all race weekends, and stays close to "no correction" until there is
// enough evidence.
const CALIB_KEY = 'pitwall-calib-v1', CALIB_PRIOR = 12;
let calib = null;
function loadCalib() {
  if (calib) return calib;
  let c = null;
  try { c = JSON.parse(localStorage.getItem(CALIB_KEY)); } catch {}
  calib = Array.isArray(c?.pts) ? c : { pts: [] };
  calib.fit = null;
  sharedAdopt(CALIB_KEY, () => calib.pts.length, d => {
    if (!Array.isArray(d.pts) || d.pts.length <= calib.pts.length) return;
    calib = { pts: d.pts, fit: null };
    try { localStorage.setItem(CALIB_KEY, JSON.stringify({ pts: calib.pts })); } catch {}
    engDirty = true;
  });
  return calib;
}
const logit = p => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
function fitCalib(pts) {
  // Logistic fit of "came true" on the raw chance, pulled towards a = 0, b = 1 (no change).
  let a = 0, b = 1;
  for (let it = 0; it < 25; it++) {
    let ga = -CALIB_PRIOR * a * 0.25, gb = -CALIB_PRIOR * (b - 1), haa = CALIB_PRIOR * 0.25, hab = 0, hbb = CALIB_PRIOR;
    for (const [raw, hit] of pts) {
      const x = logit(raw), p = 1 / (1 + Math.exp(-(a + b * x))), w = p * (1 - p);
      ga += hit - p; gb += (hit - p) * x; haa += w; hab += w * x; hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 1e-9)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += Math.max(-1, Math.min(1, da)); b += Math.max(-0.5, Math.min(0.5, db));
    if (Math.abs(da) + Math.abs(db) < 1e-5) break;
  }
  return { a, b: Math.max(0.2, Math.min(3, b)) };
}
function calibrate(raw) {
  if (!(raw > 0)) return 0;
  const c = loadCalib();
  c.fit ??= fitCalib(c.pts);
  return 1 / (1 + Math.exp(-(c.fit.a + c.fit.b * logit(raw))));
}
function addCalib(raw, hit) {
  const c = loadCalib();
  c.pts.push([+raw.toFixed(4), hit ? 1 : 0]);
  if (c.pts.length > 6000) c.pts = c.pts.slice(-6000);
  c.fit = null;
  try { localStorage.setItem(CALIB_KEY, JSON.stringify({ pts: c.pts })); } catch {}
}

// Normal distribution helpers.
const npdf = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * 2.5066282746);
function ncdf(x, m, s) {
  const z = (x - m) / (s * Math.SQRT2), t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (z >= 0 ? y : -y));
}
// Chance each lap in progress ends up as the fastest lap of the session: it has to beat the
// fastest lap so far and every other lap in progress.
function fastestChances(list, fastest) {
  const out = {};
  for (const a of list) {
    const lo = a.p - 4 * a.s, hi = Math.min(a.p + 4 * a.s, fastest ?? Infinity);
    if (!(hi > lo)) { out[a.n] = 0; continue; }
    const steps = 160, dx = (hi - lo) / steps;
    let pr = 0;
    for (let k = 0; k <= steps; k++) {
      const x = lo + k * dx;
      let q = npdf(x, a.p, a.s) * (k === 0 || k === steps ? 0.5 : 1);
      for (const b of list) if (b !== a) q *= 1 - ncdf(x, b.p, b.s);
      pr += q * dx;
    }
    out[a.n] = Math.max(0, Math.min(1, pr));
  }
  return out;
}

// Smoothly counting lap times: each shown number eases towards its latest value.
const twShown = {};
function twTick() {
  const els = document.querySelectorAll('#engBody .tw');
  let moving = false;
  for (const el of els) {
    const key = el.dataset.k, target = Number(el.dataset.v);
    const cur = twShown[key] ?? target;
    const next = Math.abs(target - cur) < 0.0015 ? target : cur + (target - cur) * 0.18;
    if (next !== target) moving = true;
    twShown[key] = next;
    const txt = fmtLapT(next);
    if (el.textContent !== txt) el.textContent = txt;
  }
  if (moving) requestAnimationFrame(twTick); else twRunning = false;
}
let twRunning = false;
const twKick = () => { if (!twRunning) { twRunning = true; requestAnimationFrame(twTick); } };
const tw = (key, v) => `<span class="tw" data-k="${key}" data-v="${v}">${fmtLapT(twShown[key] ?? v)}</span>`;

// Update a table's rows in place, keyed by id, and slide moved rows to their new spot.
function keyedRows(tbody, items) {
  const before = new Map();
  for (const tr of tbody.children) before.set(tr.dataset.k, tr.getBoundingClientRect().top);
  const keep = new Set(items.map(i => i.k));
  for (const tr of [...tbody.children]) if (!keep.has(tr.dataset.k)) tr.remove();
  const byKey = new Map([...tbody.children].map(tr => [tr.dataset.k, tr]));
  items.forEach((it, idx) => {
    let tr = byKey.get(it.k);
    if (!tr) { tr = document.createElement('tr'); tr.dataset.k = it.k; tr.classList.add('pjnew'); }
    if (tr.dataset.h !== it.html) { tr.innerHTML = it.html; tr.dataset.h = it.html; }
    if (tr.dataset.c !== it.cls) { tr.className = it.cls + (tr.classList.contains('pjnew') ? ' pjnew' : ''); tr.dataset.c = it.cls; }
    if (tbody.children[idx] !== tr) tbody.insertBefore(tr, tbody.children[idx] || null);
  });
  // FLIP: start each moved row where it was, then let it glide into place.
  for (const tr of tbody.children) {
    const was = before.get(tr.dataset.k);
    if (was == null) continue;
    const dy = was - tr.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    tr.style.transition = 'none';
    tr.style.transform = `translateY(${dy}px)`;
    tr.getBoundingClientRect();
    tr.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)';
    tr.style.transform = '';
  }
  requestAnimationFrame(() => { for (const tr of tbody.querySelectorAll('.pjnew')) tr.classList.remove('pjnew'); });
}

// ---------- Pole call ----------
// One plain answer for qualifying: who ends this part on top. Every driver still in gets a
// spread of possible final times, then the part is played out a few thousand times:
//   · the time they already hold,
//   · a lap in progress (its projection and usual error),
//   · or, if they are likely to run again, a lap near the sum of their best sectors.
const POLE_RUNS = 3000;
// How a push lap compares with the sum of the driver's best sectors going into it, learned
// from this session's recent laps. Below 1 means the track is getting quicker run to run.
const RUN_PRIOR = { m: 1.0015, s: 0.0035, n: 5 };
let runPaceMemo = { id: null, v: null };
function runPace() {
  const id = `${hist.key}:${Object.values(hist.laps || {}).reduce((a, l) => a + l.length, 0)}`;
  if (runPaceMemo.id === id) return runPaceMemo.v;
  const got = [];
  for (const laps of Object.values(hist.laps || {})) {
    let pb = [null, null, null];
    for (const r of laps) {
      const sc = r.s || [];
      if (sc.length !== 3 || !sc.every(x => x > 0)) continue;
      if (pb.every(Boolean) && r.time && !r.pit && (r.ts || '1') === '1') {
        const k = r.time / pb.reduce((a, b) => a + b, 0);
        if (k > 0.985 && k < 1.02) got.push({ k, at: r.at || 0 });
      }
      pb = pb.map((p, i) => (p == null || sc[i] < p ? sc[i] : p));
    }
  }
  const ks = got.sort((a, b) => a.at - b.at).slice(-20).map(x => x.k);
  const P = RUN_PRIOR, n = ks.length;
  const m = (ks.reduce((a, b) => a + b, 0) + P.m * P.n) / (n + P.n);
  const v = (ks.reduce((a, k) => a + (k - m) ** 2, 0) + P.s ** 2 * P.n) / (n + P.n);
  const out = { m, s: Math.min(0.008, Math.max(0.002, Math.sqrt(v))), n };
  runPaceMemo = { id, v: out };
  return out;
}
// What the fitted tyres cost against a new set of softs. Fixed starting values, not learned.
function tyreCost(n) {
  const st = arr(state.TimingAppData?.Lines?.[n]?.Stints).at(-1) || {};
  const c = String(st.Compound || '').toUpperCase(), used = st.New === 'false' || st.New === false || Number(st.StartLaps) >= 2;
  const step = c === 'MEDIUM' ? 0.005 : c === 'HARD' ? 0.01 : 0;
  return { add: step + (used ? 0.0025 : 0), label: [used ? 'used' : '', step ? c.toLowerCase() + 's' : (used ? 'tyres' : '')].filter(Boolean).join(' ') };
}

// ---------- Pole call track record ----------
// Every call is logged at fixed moments of each qualifying part and scored once the part is
// over, so the chances can be checked against what happened. Kept across weekends.
const POLE_LOG = 'pitwall-pole-v1';
const POLE_CPS = [['start', 'at the start'], ['5min', '5 min left'], ['2min', '2 min left'], ['flag', 'at the flag']];
let poleLog = null;
function loadPoleLog() {
  if (poleLog) return poleLog;
  try { poleLog = JSON.parse(localStorage.getItem(POLE_LOG)); } catch {}
  if (!Array.isArray(poleLog?.laps)) poleLog = { key: POLE_LOG, laps: [] };
  sharedAdopt(POLE_LOG, () => poleLog.laps.length, d => {
    if (!Array.isArray(d.laps) || d.laps.length <= poleLog.laps.length) return;
    poleLog = { key: POLE_LOG, laps: d.laps }; savePoleLog(); engDirty = true;
  });
  return poleLog;
}
function savePoleLog() { try { poleLog.laps = poleLog.laps.slice(-600); localStorage.setItem(POLE_LOG, JSON.stringify(poleLog)); } catch {} }
setInterval(() => {
  if (sessionKind() !== 'quali' || !hist.key || !state.TimingData?.Lines) return;
  const log = loadPoleLog(), part = state.TimingData.SessionPart || 1, status = state.SessionStatus?.Status;
  let changed = false;
  // Score earlier calls once their part is over: who really ended it on top?
  for (const e of log.laps) {
    if (e.hit !== null || e.k !== hist.key) continue;
    if (!(e.part < part || (e.part === part && (status === 'Finalised' || status === 'Ends')))) continue;
    let win = null, t = Infinity;
    for (const [n, L] of Object.entries(L_())) { const v = lapSecs(arr(L.BestLapTimes)[e.part - 1]?.Value); if (v && v < t) { t = v; win = n; } }
    if (win) { e.hit = win; changed = true; }
  }
  if (status === 'Started') {
    const c = state.ExtrapolatedClock;
    let left = c?.Remaining ? parseHms(c.Remaining) / 1000 : null;
    if (left != null && c.Extrapolating && c.Utc) left -= (Date.now() - Date.parse(c.Utc)) / 1000;
    const anyTime = Object.values(L_()).some(L => lapSecs(arr(L.BestLapTimes)[part - 1]?.Value));
    // Only log a moment the page actually saw, never one it opened too late for.
    const cp = left == null ? null : left <= 3 ? 'flag' : left <= 120 && left > 90 ? '2min' : left <= 300 && left > 240 ? '5min' : !anyTime && left > 300 ? 'start' : null;
    if (cp && !log.laps.some(e => e.k === hist.key && e.part === part && e.cp === cp)) {
      const p = poleCall();
      if (p && !p.settled) {
        log.laps.push({ k: hist.key, part, cp, at: Date.now(), fav: p.cars[0].n, calls: p.cars.filter(x => x.ch >= 0.02).map(x => ({ n: x.n, ch: +x.ch.toFixed(3) })), hit: null });
        changed = true;
      }
    }
  }
  if (changed) { savePoleLog(); engDirty = true; }
}, 1000);
function poleRecordHtml() {
  const done = loadPoleLog().laps.filter(e => e.hit);
  if (!done.length) return '<p class="note polerec"><b>Track record</b> · none yet. Each call is logged at the start, with 5 and 2 minutes left and at the flag, then checked once the part is over.</p>';
  const favs = POLE_CPS.map(([cp, label]) => { const g = done.filter(e => e.cp === cp); return g.length ? `${label} <b>${g.filter(e => e.fav === e.hit).length} of ${g.length}</b>` : ''; }).filter(Boolean).join(' · ');
  const all = done.flatMap(e => e.calls.map(c => ({ ch: c.ch, hit: c.n === e.hit })));
  const bands = [[0.5, 1.01, '50% or more'], [0.25, 0.5, '25–50%'], [0.02, 0.25, 'under 25%']].map(([lo, hi, label]) => {
    const g = all.filter(x => x.ch >= lo && x.ch < hi);
    return g.length ? `said ${label}: came true <b>${g.filter(x => x.hit).length} of ${g.length}</b>` : '';
  }).filter(Boolean).join(' · ');
  return `<p class="note polerec"><b>Track record</b> · favourite was right: ${favs}.<br>${bands}.${done.length < 12 ? ' Too few calls so far to judge it.' : ''}</p>`;
}
function poleCall() {
  const td = state.TimingData || {}, part = td.SessionPart || 1, lines = L_();
  // 'Inactive' is the wait before a part starts: laps are still to come, so give the early estimate.
  const running = ['Started', 'Inactive'].includes(state.SessionStatus?.Status);
  const c = state.ExtrapolatedClock;
  let left = c ? parseHms(c.Remaining) : null;
  if (left != null && c.Extrapolating && c.Utc) left -= Date.now() - Date.parse(c.Utc);
  const leftS = left == null ? null : left / 1000;
  const cars = [];
  let anyLive = false, anyGuess = false;
  for (const n of engOrder()) {
    const L = lines[n] || {};
    if (L.KnockedOut || L.Retired || L.Stopped) continue;
    // Only a time set in this part counts: Q3 starts from nothing.
    const parts = arr(L.BestLapTimes);
    const best = parts.length ? lapSecs(parts[part - 1]?.Value) : bestLap(n), lv = L.InPit ? null : liveLap(n);
    let lap = null, why = best ? `holding ${fmtLapT(best)}` : 'no time yet';
    if (lv?.projected && lv.done >= 1) {
      const risk = flagRisk(n, lv);
      lap = { m: lv.projected, s: projSigma(lv), w: risk.mult };
      why = `on a lap · heading for ${fmtLapT(lv.projected)}`;
      if (risk.label) why += ` · ${risk.label}`;
      anyLive = true;
    } else if (running) {
      // Not on a push lap. Will they get another one in? A guess from where they are and the clock.
      const ref = refSectors(n);
      const ideal = !ref.loose && ref.pb.every(Boolean) ? ref.pb.reduce((a, b) => a + b, 0) : null;
      const w = leftS == null ? 0.5 : L.InPit ? (leftS > 240 ? 0.7 : leftS > 110 ? 0.35 : 0) : (leftS > 20 ? 0.8 : 0.5);
      if (ideal && w > 0) {
        // A lap still in sector 1 is too early to read, so it counts as a lap to come.
        const started = !!lv?.projected;
        // How laps have compared with best sectors lately, and what this car has fitted.
        const pace = runPace(), ty = L.InPit ? { add: 0, label: '' } : tyreCost(n);
        lap = { m: ideal * (pace.m + ty.add), s: ideal * pace.s, w: started ? 0.9 * flagRisk(n, lv).mult : w };
        why = `${best ? `holding ${fmtLapT(best)}` : 'no time yet'} · ${started ? 'in sector 1, too early to read' : L.InPit ? (best ? 'may run again' : 'yet to run') : 'on track, lap to come'}${ty.label ? ` · ${ty.label}` : ''}`;
        anyGuess = true;
      }
    }
    if (best || lap) cars.push({ n, best, lap, why, wins: 0 });
  }
  if (!cars.length) return null;
  // Same inputs give the same answer: a fixed-seed random stream, so the numbers don't flicker.
  let seed = 20261121;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  let runs = 0;
  for (let k = 0; k < POLE_RUNS; k++) {
    let win = null, t = Infinity;
    for (const car of cars) {
      let x = car.best ?? Infinity;
      if (car.lap) { const u = rnd(), g = gauss(); if (u < car.lap.w) x = Math.min(x, car.lap.m + g * car.lap.s); }
      if (x < t) { t = x; win = car; }
    }
    if (win) { win.wins++; runs++; }
  }
  if (!runs) return null;
  for (const car of cars) car.ch = car.wins / runs;
  cars.sort((a, b) => b.ch - a.ch || (a.best ?? Infinity) - (b.best ?? Infinity));
  return { part, cars, running, anyLive, anyGuess, settled: !cars.some(c => c.lap) };
}
function poleHtml() {
  const p = poleCall();
  if (!p) return '';
  const top = p.cars[0], pct = x => { const v = Math.round(x * 100); return v === 100 && x < 0.995 ? 99 : v < 1 && x > 0 ? '<1' : v; };
  const what = p.part === 3 ? 'pole' : `top of Q${p.part}`;
  const title = p.part === 3 ? 'Pole call' : `Who tops Q${p.part}`;
  let verdict, cls;
  if (p.settled) { verdict = `${esc(dInfo(top.n).code)} has ${p.part === 3 ? 'pole' : `topped Q${p.part}`}`; cls = 'hi'; }
  else if (top.ch >= 0.75) { verdict = `Strong favourite for ${what}`; cls = 'hi'; }
  else if (top.ch >= 0.5) { verdict = `Favourite for ${what}`; cls = 'mid'; }
  else { verdict = `Open: no clear favourite for ${what}`; cls = 'lo'; }
  const basis = p.settled ? 'No laps left to come.'
    : p.anyLive ? `<b>Live</b> · based on the laps on track now${p.anyGuess ? ', plus a guess at who still runs again' : ''}. It firms up as each car passes sector 1.`
    : '<b>Early estimate</b> · nobody is on a lap. Based on each driver\'s best sectors and who is likely to run again, so treat it as a rough guide.';
  const rows = p.cars.slice(0, 5).map(c => {
    const k = c.ch >= 0.5 ? 'hi' : c.ch >= 0.15 ? 'mid' : 'lo';
    return `<tr><td>${chipD(c.n)}</td><td class="pjch"><div class="chbar ${k}"><i style="width:${Math.max(Math.round(c.ch * 100), c.ch > 0 ? 2 : 0)}%"></i></div><span class="mono">${pct(c.ch)}%</span></td><td class="dimt polewhy">${c.why}</td></tr>`;
  }).join('');
  return `<div class="ecard pole ${cls}"><h4>${title}</h4>
    <div class="polehead"><span class="polepct mono">${p.settled ? '🏁' : pct(top.ch) + '%'}</span><div><b class="polename">${chipD(top.n)}</b><span class="polev">${verdict}</span></div></div>
    <table class="et polet">${rows}</table>
    <p class="note">${basis}${p.part === 3 ? '' : ' Pole itself is decided in Q3.'} These are chances, not certainties.</p>${poleRecordHtml()}</div>`;
}

// Time left in the session, shown at the top of the Projected tab and kept ticking.
function sessionLeftMs() {
  const c = state.ExtrapolatedClock;
  if (!c?.Remaining) return null;
  let ms = parseHms(c.Remaining);
  if (c.Extrapolating && c.Utc) ms -= Date.now() - Date.parse(c.Utc);
  return Math.max(0, ms);
}
function pjClockTick() {
  const el = document.getElementById('pjClock');
  if (!el) return;
  const ms = sessionLeftMs(), st = state.SessionStatus?.Status;
  let h = '';
  if (ms != null) {
    const t = Math.ceil(ms / 1000), mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    const what = sessionKind() === 'quali' ? `Q${state.TimingData?.SessionPart || 1}` : 'the session';
    const run = st === 'Started' && state.ExtrapolatedClock?.Extrapolating;
    const cls = !run ? 'dimt' : t <= 120 ? 'c-red' : t <= 300 ? 'c-yellow' : '';
    h = `<div class="pjclock"><span>Time left in ${what}</span><b class="mono ${cls}">${mm}:${ss}</b>${run ? (t <= 120 ? '<span class="dimt">last laps only</span>' : '') : `<span class="dimt">${t === 0 ? 'time is up' : 'clock stopped'}</span>`}</div>`;
  }
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
setInterval(pjClockTick, 500);

const lapBarW = {};
function projMount(el) {
  const lines = L_(), race = sessionKind() === 'race';
  const f = window.sessionFastest;
  const all = engOrder();
  const fin = arr(state.RaceControlMessages?.Messages).some(m => m.Flag === 'CHEQUERED');
  const cars = all.map(n => {
    const L = lines[n] || {};
    if (L.InPit || L.Retired || L.Stopped || L.KnockedOut || (fin && (Number(L.Status) & 1024))) return null;
    return { n, L, lv: liveLap(n), pb: pbSectors(n), best: bestLap(n) };
  }).filter(Boolean);
  const posFor = (n, t) => all.filter(m => m !== n && !lines[m]?.KnockedOut && (bestLap(m) ?? Infinity) < t).length + 1; // knocked-out cars keep an old time
  const posNow = n => { const b = bestLap(n); return b ? posFor(n, b) : null; };

  // Chance of the fastest lap, from how far off each projection usually is at that point in a lap.
  const live = cars.filter(c => c.lv?.projected).map(c => ({ n: c.n, p: c.lv.projected, s: projSigma(c.lv) }));
  const chance = fastestChances(live, f?.t);
  const risk = {};
  for (const c of cars) if (c.lv?.projected) { risk[c.n] = flagRisk(c.n, c.lv); chance[c.n] = (chance[c.n] ?? 0) * risk[c.n].mult; }

  const early = c => (!c.lv?.projected ? 2 : c.lv.done === 0 ? 1 : 0);
  cars.sort((a, b) => early(a) - early(b) || (a.lv?.projected ?? Infinity) - (b.lv?.projected ?? Infinity) || (b.lv?.done ?? 0) - (a.lv?.done ?? 0) || a.n - b.n);
  const secCell = (v, pb, i, cur, purple) => {
    if (v != null) return `<td class="mono t ${purple ? 'c-purple' : pb != null && v <= pb ? 'c-green' : 'c-yellow'}">${fmt3(v)}</td>`;
    const later = cur && cur.slice(i + 1).some(x => x != null);
    const next = cur && !later && cur.findIndex(x => x == null) === i;
    return `<td class="mono t dimt${i === 2 ? ' pjs3' : ''}">${later ? '–' : next ? 'on it' : ''}</td>`;
  };
  const span = race ? 3 : 4;
  // The one lap in progress (sector 1 done) that would go quickest of all: on for pole in Q3,
  // top of the part in Q1 and Q2, the fastest lap in other sessions.
  const quali = sessionKind() === 'quali', qPart = state.TimingData?.SessionPart || 1;
  const prize = quali ? (qPart === 3 ? 'POLE' : 'P1') : 'FASTEST LAP';
  // In qualifying the last column shows the same figure as the pole card, so the two agree.
  const poleCh = quali ? Object.fromEntries((poleCall()?.cars || []).map(c => [c.n, c.ch])) : null;
  const lead = cars.filter(c => c.lv?.projected && c.lv.done >= 1 && c.lv.projected < (f?.t ?? Infinity) && !(risk[c.n]?.mult < 0.5))[0]?.n ?? null;
  // Where the car is on its lap: a bar split at the sector lines, filled as mini-sectors light up.
  const lapCell = (n, L, lv) => {
    const counts = arr(L.Sectors).map(s => arr(s?.Segments).length), total = counts.reduce((a, b) => a + b, 0);
    const frac = lv?.lapFrac ?? null, pct = frac == null ? 0 : Math.round(Math.min(1, frac) * 100);
    let at = 0;
    const ticks = total ? counts.slice(0, -1).map(c => { at += c; return `<u style="left:${(at / total * 100).toFixed(1)}%"></u>`; }).join('') : '';
    return `<td class="pjlap"><div class="lapbar${lv?.slow ? ' slow' : ''}"><i data-lap="${n}" data-w="${pct}"></i>${ticks}</div><span class="mono dimt">${frac == null ? '–' : pct + '%'}</span></td>`;
  };
  const rows = cars.map(({ n, L, lv, pb, best }) => {
    const cur = lv?.cur || [null, null, null];
    const bestCell = `<td class="mono t pjbest">${best ? fmtLapT(best) : '<span class="dimt">no time</span>'}</td>`;
    let tail = `<td class="mono t dimt" colspan="${span}">${lv?.slow ? 'slow lap · not pushing' : L.PitOut ? 'out lap' : 'starting a lap'}</td>`;
    if (lv?.projected && lv.done === 0) {
      // Sector 1 isn't in yet: show a rough time only, and make no call on it.
      tail = `<td class="mono t rough">≈${tw('p' + n, lv.projected)}</td><td class="mono t dimt" colspan="${span - 1}">too early · wait for S1</td>`;
    } else if (lv?.projected) {
      const p = lv.projected, beatFL = f && p < f.t;
      const dBest = best ? p - best : null;
      let posTxt = '';
      if (!race) {
        const pNew = posFor(n, p), pNow = posNow(n);
        posTxt = !best ? `<b>P${pNew}</b>` : dBest < 0 && pNew < pNow ? `P${pNow} → <b class="c-green">P${pNew}</b>` : `P${pNow} <span class="dimt pjstay">stays</span>`;
      }
      const ch = poleCh ? (poleCh[n] ?? 0) : calibrate(chance[n] ?? 0), pct = Math.round(ch * 100);
      const chCls = ch >= 0.5 ? 'hi' : ch >= 0.15 ? 'mid' : 'lo';
      tail = `<td class="mono t ${beatFL ? 'c-purple' : ''}${lv.loose ? ' rough' : ''}"><b>${lv.loose ? '≈' : ''}${tw('p' + n, p)}</b> <span class="dimt pjsig">±${projSigma(lv).toFixed(1)}</span></td>`
        + `<td class="mono t pjvs ${dBest == null ? 'dimt' : dBest < 0 ? 'c-green' : 'c-red'}">${dBest == null ? 'first' : signed(dBest)}</td>`
        + (race ? '' : `<td class="mono t">${posTxt}</td>`)
        + `<td class="pjch"><div class="chbar ${chCls}"><i style="width:${Math.max(pct, ch > 0 ? 2 : 0)}%"></i></div><span class="mono">${pct < 1 && ch > 0 ? '<1' : pct}%</span></td>`;
    }
    const onIt = n === lead ? ` <span class="pjpole">⚡ ON FOR ${prize}</span>` : '';
    return { k: n, cls: (n === selected ? 'selrow' : '') + (n === lead ? ' pjtop' : ''), html: `<td>${chipD(n)}${onIt}${risk[n]?.label ? ` <span class="pjflag ${risk[n].cls}">${risk[n].label}</span>` : ''}</td>${lapCell(n, L, lv)}${[0, 1, 2].map(i => secCell(cur[i], pb[i], i, lv?.cur, !!arr(L.Sectors)[i]?.OverallFastest)).join('')}${bestCell}${tail}` };
  });

  // Build the frame once; after that only rows and notes change.
  if (!el.querySelector('#pjFrame') || el.dataset.pjRace !== `${race}:${prize}`) {
    el.innerHTML = `<div id="pjFrame"><div id="pjClock"></div><div id="pjPole"></div><p class="note" id="pjNote"></p>
      <div class="${race ? '' : 'pjgrid'}"><div><p class="note" id="pjEmpty"></p>
      <table class="et wide pj"><thead><tr><th>Driver</th><th title="How far round the lap the car is. The marks are the sector lines.">Lap</th><th class="t">S1</th><th class="t">S2</th><th class="t pjs3">S3</th><th class="t pjbest">Best now</th><th class="t">Projected</th><th class="t pjvs">vs best</th>${race ? '' : '<th class="t">Position</th>'}<th class="t" title="Chance this lap ends up as the quickest: pole in Q3, top of the part in Q1 and Q2, the fastest lap in other sessions">${quali ? (qPart === 3 ? 'Pole?' : 'P1?') : 'Fastest?'}</th></tr></thead><tbody id="pjBody"></tbody></table><div id="pjScore"></div><div id="pjLearn"></div></div>
      ${race ? '' : `<div class="ecard"><h4>Leaderboard + laps in progress</h4><p class="note">Best laps so far. Highlighted rows are laps happening now, placed where they would land.</p><table class="et"><tbody id="pjBoard"></tbody></table></div>`}</div></div>`;
    el.dataset.pjRace = `${race}:${prize}`;
    el.dataset.html = '';
  }
  const setHtml = (id, h) => { const x = el.querySelector('#' + id); if (x && x.dataset.h !== h) { x.innerHTML = h; x.dataset.h = h; } };
  const mi = modelInfo(), lapT = f?.t || 90;
  const sec = x => (x >= 0 ? '+' : '−') + Math.abs(x * lapT).toFixed(2) + 's';
  setHtml('pjLearn', `<p class="note learn">🧠 <b>Self-tuning</b> · learned from <b>${mi.laps}</b> push lap${mi.laps === 1 ? '' : 's'} at this track${mi.laps < 10 ? ' (still mostly using its starting values)' : ''}. `
    + `Right now: drivers finish <b>${sec(mi.theta[0])}</b> off their best sectors · tyres <b>${sec(mi.theta[4])}</b> per 10 laps of age · <b>${sec(mi.theta[5])}</b> per step harder than the tyre of their best lap.</p>`);
  setHtml('pjNote', `${f ? `Fastest lap: <b>${fmtLapT(f.t)}</b> ${esc(dInfo(f.n).code)}. ` : ''}Projections update with every mini-sector. ± is the usual error at that point in the lap. The row marked <b>⚡ ON FOR ${prize}</b> is the lap that would go quickest of all right now. The last column is the chance that lap really ends up quickest, corrected against past results so 80% should come true about 8 times in 10. Until a driver finishes sector 1 the time is only a rough guide (≈), so no call is made on that lap yet. A driver with no proper lap of their own yet is also marked ≈, with a wider ±.`);
  pjClockTick();
  setHtml('pjPole', sessionKind() === 'quali' ? poleHtml() : '');
  setHtml('pjEmpty', cars.length ? '' : 'No cars are out on track right now.');
  setHtml('pjScore', scoreHtml());
  const pjBody = el.querySelector('#pjBody');
  pjBody.closest('table').style.display = cars.length ? '' : 'none';
  keyedRows(pjBody, rows);
  // Grow each lap bar from where it was, so progress glides instead of jumping.
  for (const bar of pjBody.querySelectorAll('i[data-lap]')) {
    const k = bar.dataset.lap, w = Number(bar.dataset.w);
    if (bar.dataset.set === String(w)) continue;
    if (!bar.dataset.set) { const from = lapBarW[k] ?? 0; bar.style.transition = 'none'; bar.style.width = (from <= w ? from : 0) + '%'; bar.getBoundingClientRect(); bar.style.transition = ''; }
    bar.style.width = w + '%'; bar.dataset.set = String(w); lapBarW[k] = w;
  }

  const board = el.querySelector('#pjBoard');
  if (board) {
    const entries = all.filter(n => bestLap(n)).map(n => ({ n, t: bestLap(n), live: false }));
    for (const c of cars) {
      const p = c.lv?.projected;
      if (p && c.lv.done >= 1 && (!c.best || p < c.best)) entries.push({ n: c.n, t: p, live: true, done: c.lv.done });
    }
    entries.sort((a, b) => a.t - b.t);
    const top = entries.find(e => !e.live)?.t;
    const cut = sessionKind() === 'quali' ? arr(state.TimingData?.NoEntries)[(state.TimingData?.SessionPart || 1)] : null;
    let pos = 0;
    const items = [];
    for (const e of entries) {
      if (!e.live) pos++;
      if (cut && !e.live && pos === cut + 1) items.push({ k: 'cut', cls: 'cutline', html: '<td colspan="3">knockout line</td>' });
      const gap = top ? (e.t === top && !e.live ? 'P1' : signed(e.t - top)) : '';
      items.push(e.live
        ? { k: 'L' + e.n, cls: 'pjlive', html: `<td class="mono">↳</td><td>${chipD(e.n)} <span class="dimt">in S${Math.min(3, e.done + 1)}</span></td><td class="mono t">${tw('b' + e.n, e.t)} <span class="dimt">${gap}</span></td>` }
        : { k: 'B' + e.n, cls: '', html: `<td class="mono">P${pos}</td><td>${chipD(e.n)}</td><td class="mono t">${fmtLapT(e.t)} <span class="dimt">${gap}</span></td>` });
    }
    keyedRows(board, items);
  }
  twKick();
}

// ---------- Scorecard: how good the projections and chances really are ----------
// At the end of S1 and of S2 the site notes each lap's projection and fastest-lap chance.
// When the lap is done it checks the projection against the real time, and two minutes later
// (so laps running at the same time can finish, and deleted laps are announced) whether it
// ended up the fastest.
// Saved per race weekend in this browser.
const SCORE_WAIT = 120 * 1000;
const scoreKey = () => `pitwall-score-v1-${state.SessionInfo?.Meeting?.Key ?? 'x'}`;
let score = null;
function loadScore() {
  const key = scoreKey();
  if (score?.key === key) return score;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(key)); } catch {}
  score = s?.key === key ? s : { key, laps: [] };
  sharedAdopt(key, () => (score?.key === key ? score.laps.length : 0), d => {
    if (d.key !== key || score?.key !== key || !Array.isArray(d.laps) || d.laps.length <= score.laps.length) return;
    score = { key, laps: d.laps };
    saveScore();
    engDirty = true;
  });
  return score;
}
function saveScore() {
  try {
    if (score.laps.length > 3000) score.laps = score.laps.slice(-3000);
    localStorage.setItem(score.key, JSON.stringify(score));
  } catch {}
}
const predNow = {}, predDone = {};
es.addEventListener('feed', e => {
  const [topic, data] = e.detail;
  if (topic !== 'TimingData' || !data?.Lines) return;
  for (const n of Object.keys(data.Lines)) if (data.Lines[n]?.LastLapTime?.Value) { predDone[n] = predNow[n]; predNow[n] = {}; flagDone[n] = flagNow[n]; flagNow[n] = null; }
});
setInterval(() => {
  if (!state.TimingData?.Lines || !window.sessionFastest) return;
  const live = [];
  for (const n of drivers()) {
    const L = L_()[n];
    if (!L || L.InPit || L.Retired || L.Stopped) continue;
    const lv = liveLap(n);
    if (lv?.projected) live.push({ n, lv, p: lv.projected, s: projSigma(lv) });
  }
  const ch = fastestChances(live, window.sessionFastest.t);
  for (const c of live) {
    const st = c.lv.done; // 1 = just finished S1, 2 = just finished S2
    if (st < 1) { flagRisk(c.n, c.lv); continue; }
    const p = (predNow[c.n] ??= {});
    const raw = (ch[c.n] ?? 0) * flagRisk(c.n, c.lv).mult;
    if (!p[st]) p[st] = { proj: c.p, sig: c.s, raw, ch: calibrate(raw) };
  }
}, 500);
es.addEventListener('lap', e => {
  const [n, rec] = e.detail;
  const preds = predDone[n]; predDone[n] = null;
  if (!preds || !rec?.time) return;
  const stages = Object.entries(preds);
  if (!stages.length) return;
  const sessionKey = hist.key, best = bestLap(n);
  // Aborted, pit and flag laps still count for the chances (they are misses), but not for the error.
  const push = !rec.pit && (rec.ts || '1') === '1' && (!best || rec.time < best * 1.03);
  setTimeout(() => {
    const f = window.sessionFastest;
    const hit = !!f && f.n === n && Math.abs(f.t - rec.time) < 0.0005;
    const s = loadScore();
    for (const [st, p] of stages) {
      s.laps.push({ k: sessionKey, st: +st, err: push ? +(p.proj - rec.time).toFixed(3) : null, ch: +p.ch.toFixed(3), raw: +p.raw.toFixed(3), hit, at: Date.now() });
      addCalib(p.raw, hit);
    }
    saveScore();
    engDirty = true;
  }, SCORE_WAIT);
});

function calibLine() {
  const n = loadCalib().pts.length;
  if (n < 10) return `<p class="note">🎯 <b>Self-correcting chances</b> · ${n} checks so far. Not enough yet to correct anything, so chances are shown as calculated.</p>`;
  const show = r => Math.round(calibrate(r) * 100) + '%';
  return `<p class="note">🎯 <b>Self-correcting chances</b> · tuned on <b>${n}</b> checks from all weekends, so the number shown matches how often it really happens. Right now a calculated 50% is shown as <b>${show(0.5)}</b>, 80% as <b>${show(0.8)}</b> and 95% as <b>${show(0.95)}</b>.</p>`;
}
function scoreHtml() {
  const s = loadScore();
  if (!s.laps.length) return `<div class="ecard"><h4>Scorecard</h4><p class="note">Nothing checked yet this weekend. Once laps finish, this shows how far off the projections were and how often each chance level actually came good.</p>${calibLine()}</div>`;
  const mae = a => a.length ? (a.reduce((x, y) => x + Math.abs(y), 0) / a.length).toFixed(2) + 's' : '–';
  const errLine = laps => {
    const e1 = laps.filter(l => l.st === 1 && l.err != null).map(l => l.err), e2 = laps.filter(l => l.st === 2 && l.err != null).map(l => l.err);
    return `off by <b>${mae(e1)}</b> after S1 <span class="dimt">(${e1.length})</span> · <b>${mae(e2)}</b> after S2 <span class="dimt">(${e2.length})</span>`;
  };
  const now = s.laps.filter(l => l.k === hist.key);
  const buckets = [[0, 0.1, 'under 10%'], [0.1, 0.3, '10–30%'], [0.3, 0.5, '30–50%'], [0.5, 0.7, '50–70%'], [0.7, 0.9, '70–90%'], [0.9, 1.01, '90%+']];
  const rows = buckets.map(([lo, hi, label]) => {
    const g = s.laps.filter(l => l.ch >= lo && l.ch < hi);
    if (!g.length) return '';
    const hits = g.filter(l => l.hit).length, rate = hits / g.length;
    const said = g.reduce((a, l) => a + l.ch, 0) / g.length;
    const ok = g.length < 5 ? 'dimt' : Math.abs(rate - said) <= 0.15 ? 'c-green' : 'c-yellow';
    return `<tr><td>Said ${label}</td><td class="mono t">${hits} of ${g.length}</td><td class="mono t ${ok}">${Math.round(rate * 100)}%</td></tr>`;
  }).join('');
  return `<div class="ecard"><h4>Scorecard</h4>
    <p class="note">Projections checked against real lap times (push laps only), and how often each fastest-lap chance came good. Each lap is checked twice, at the end of S1 and of S2, so counts are checks rather than laps.</p>
    <div class="kv"><div><span>This session</span><b>${errLine(now)}</b></div><div><span>This weekend</span><b>${errLine(s.laps)}</b></div></div>
    <table class="et sc"><tr><th>Fastest? said</th><th class="t">Came true</th><th class="t">Hit rate</th></tr>${rows}</table>
    <p class="note">The chances are trustworthy when the hit rate is close to what it said (green). Grey means too few laps to tell yet.</p>${calibLine()}</div>`;
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

// ---------- Race call (winner, top 5, top 10) ----------
// The simulation itself is in racesim.js. This part gathers what the feed knows now,
// keeps qualifying pace for the start of the race, and keeps a track record.
const qpaceKey = () => `pitwall-qpace-${state.SessionInfo?.Meeting?.Key ?? 'x'}`;
let qpace = null;
setInterval(() => {
  // During qualifying, keep each driver's best lap for the race call.
  if (sessionKind() !== 'quali' || !state.TimingData?.Lines) return;
  const key = qpaceKey(), best = {};
  for (const [n, L] of Object.entries(L_())) {
    const t = Math.min(...arr(L.BestLapTimes).map(x => lapSecs(x?.Value)).filter(Boolean), lapSecs(L.BestLapTime?.Value) ?? Infinity);
    if (isFinite(t)) best[n] = t;
  }
  if (!Object.keys(best).length) return;
  let old = null; try { old = JSON.parse(localStorage.getItem(key)); } catch {}
  for (const [n, t] of Object.entries(old?.best || {})) if (!(best[n] <= t)) best[n] = t;
  qpace = { key, laps: Object.keys(best).length, best };
  try { localStorage.setItem(key, JSON.stringify(qpace)); } catch {}
}, 10000);
function qualiPace() {
  const key = qpaceKey();
  if (qpace?.key === key) return qpace.best;
  try { const d = JSON.parse(localStorage.getItem(key)); if (d?.key === key) qpace = d; } catch {}
  if (qpace?.key !== key) qpace = { key, laps: 0, best: {} };
  sharedAdopt(key, () => qpace.laps, d => { if (d.key === key && d.laps > qpace.laps) { qpace = d; try { localStorage.setItem(key, JSON.stringify(d)); } catch {} engDirty = true; } });
  return qpace.best;
}

function raceInputs() {
  const lines = L_(), app = state.TimingAppData?.Lines || {}, order = engOrder();
  const lc = state.LapCount || {}, total = +lc.TotalLaps || 0, cur = +lc.CurrentLap || 0;
  const status = state.SessionStatus?.Status;
  const started = cur >= 1 && ['Started', 'Finished', 'Finalised', 'Ends', 'Aborted'].includes(status) && Object.values(lines).some(L => +L.NumberOfLaps >= 1);
  const ref = refLap(), q = qualiPace(), pl = circuitInfo?.pitLoss || {};
  const cars = order.map((n, i) => {
    const L = lines[n] || {}, stints = arr(app[n]?.Stints), st = stints.at(-1) || {};
    // Clean racing laps: green flag, not in or out of the pits, not the first lap, and not far
    // off the driver's own usual pace (an in-lap or a moment in traffic).
    const ok = (hist.laps[n] || []).filter(r => clean(r) && r.lap > 1 && r.age > 1);
    const med = ok.length ? ok.map(r => r.time).sort((a, b) => a - b)[Math.floor((ok.length - 1) / 2)] : null;
    const laps = ok.filter(r => r.time < med + 1.5).slice(-12).map(r => ({ time: r.time, age: r.age, stint: r.stint }));
    const gap = i === 0 ? 0 : gapSecs(L.GapToLeader, ref);
    // Before the start the feed's running order shuffles as cars leave the pits, so the
    // starting grid (GridPos) is used instead.
    const grid = +app[n]?.GridPos || null;
    return { n, grid, pos: started ? +L.Position || i + 1 : grid || +L.Position || i + 1, gap: started ? (gap ?? i * 1.5) : ((grid || i + 1) - 1) * RaceSim.P.gridGap, out: !!(L.Retired || L.Stopped),
      compound: String(st.Compound || 'MEDIUM').toUpperCase(), age: +st.TotalLaps || 0, used: stints.map(x => String(x.Compound || '').toUpperCase()), laps, qbest: q[n] };
  });
  return { lapsLeft: total ? Math.max(0, total - Math.max(cur, 1) + (started ? 1 : 1)) : 50, total, cur, started, status,
    sprint: /sprint/i.test(state.SessionInfo?.Name || ''), pitLoss: +pl.normal || 22, scLoss: +pl.sc || 13,
    scNow: state.TrackStatus?.Status === '4', ref, cars };
}
let raceMemo = { id: null, v: null };
function raceCall() {
  if (!window.RaceSim || !state.TimingData?.Lines) return null;
  // Over once the leader has taken the flag on the last lap.
  const lc = state.LapCount || {}, fin = +lc.CurrentLap >= +lc.TotalLaps && arr(state.RaceControlMessages?.Messages).some(m => m.Flag === 'CHEQUERED');
  const id = `${hist.key}:${lc.CurrentLap}:${state.TrackStatus?.Status}:${Object.keys(qualiPace()).length}:${Math.floor(Date.now() / 5000)}`;
  if (raceMemo.id === id) return raceMemo.v;
  const inp = raceInputs();
  if (fin) inp.lapsLeft = 0;
  const b = RaceSim.build(inp), res = RaceSim.run(b);
  const v = { ...res, inp, fin, byN: Object.fromEntries(b.cars.map(c => [c.n, c])) };
  raceMemo = { id, v };
  return v;
}

const RACE_LOG = 'pitwall-race-v1';
const RACE_CPS = [['start', 0, 'lap 1'], ['q1', 0.25, 'quarter distance'], ['half', 0.5, 'half distance'], ['q3', 0.75, 'three-quarter distance'], ['late', 0.9, '90% distance']];
let raceLog = null;
function loadRaceLog() {
  if (raceLog) return raceLog;
  try { raceLog = JSON.parse(localStorage.getItem(RACE_LOG)); } catch {}
  if (!Array.isArray(raceLog?.laps)) raceLog = { key: RACE_LOG, laps: [] };
  sharedAdopt(RACE_LOG, () => raceLog.laps.length, d => {
    if (!Array.isArray(d.laps) || d.laps.length <= raceLog.laps.length) return;
    raceLog = { key: RACE_LOG, laps: d.laps }; saveRaceLog(); engDirty = true;
  });
  return raceLog;
}
function saveRaceLog() { try { raceLog.laps = raceLog.laps.slice(-300); localStorage.setItem(RACE_LOG, JSON.stringify(raceLog)); } catch {} }
setInterval(() => {
  if (sessionKind() !== 'race' || !hist.key || !state.LapCount) return;
  const log = loadRaceLog(), status = state.SessionStatus?.Status;
  let changed = false;
  if (status === 'Finalised' || status === 'Ends') {
    const pos = Object.fromEntries(Object.entries(L_()).map(([n, L]) => [n, +L.Position || 99]));
    for (const e of log.laps) if (e.k === hist.key && !e.fin) { e.fin = pos; changed = true; }
  } else if (status === 'Started') {
    const { CurrentLap: cur, TotalLaps: tot } = state.LapCount;
    const f = (+cur - 1) / (+tot || 1);
    // Only a moment the page actually saw: within a couple of laps of it.
    const cp = RACE_CPS.find(([, at]) => f >= at && f < at + 2.5 / (+tot || 50))?.[0];
    if (cp && +cur >= 1 && !log.laps.some(e => e.k === hist.key && e.cp === cp)) {
      const r = raceCall();
      if (r && !r.settled) {
        log.laps.push({ k: hist.key, cp, at: Date.now(), p: Object.fromEntries(r.cars.map(c => [c.n, [+c.win.toFixed(3), +c.top5.toFixed(3), +c.top10.toFixed(3), +c.top3.toFixed(3)]])), fin: null });
        changed = true;
      }
    }
  }
  if (changed) { saveRaceLog(); engDirty = true; }
}, 2000);
function raceRecordHtml() {
  const done = loadRaceLog().laps.filter(e => e.fin);
  if (!done.length) return '<p class="note polerec"><b>Track record</b> · none yet. Each call is logged at lap 1, a quarter, half, three quarters and 90% of the race, then checked against the result.</p>';
  const fav = RACE_CPS.map(([cp, , label]) => {
    const g = done.filter(e => e.cp === cp);
    if (!g.length) return '';
    const right = g.filter(e => { const top = Object.entries(e.p).sort((a, b) => b[1][0] - a[1][0])[0]?.[0]; return e.fin[top] === 1; }).length;
    return `${label} <b>${right} of ${g.length}</b>`;
  }).filter(Boolean).join(' · ');
  const band = (i, cut) => {
    const all = done.flatMap(e => Object.entries(e.p).filter(([, p]) => p[i] != null).map(([n, p]) => ({ p: p[i], hit: (e.fin[n] ?? 99) <= cut })));
    return [[0.7, 1.01, '70%+'], [0.3, 0.7, '30–70%']].map(([lo, hi, l]) => { const g = all.filter(x => x.p >= lo && x.p < hi); return g.length ? `${l} came true <b>${g.filter(x => x.hit).length} of ${g.length}</b>` : ''; }).filter(Boolean).join(', ');
  };
  return `<p class="note polerec"><b>Track record</b> · favourite to win was right: ${fav}.<br>Top 3 said ${band(3, 3) || '–'}. Top 5 said ${band(1, 5) || '–'}. Top 10 said ${band(2, 10) || '–'}.${done.length < 15 ? ' Too few races so far to judge it.' : ''}</p>`;
}

function panelRaceCall() {
  const r = raceCall();
  if (!r) return '<p class="note">Waiting for timing data…</p>';
  const { inp } = r;
  const pct = x => { const v = Math.round(x * 100); return r.settled ? v : x >= 0.995 ? '>99' : x > 0 && x < 0.005 ? '<1' : v; };
  const cls = x => r.settled ? (x ? 'c-green' : 'dimt') : x >= 0.7 ? 'c-green' : x >= 0.3 ? '' : x >= 0.1 ? 'c-yellow' : 'dimt';
  // Rows in starting-grid order; the "Now" column shows where each driver is running.
  const gridOf = c => r.byN[c.n]?.grid || 99;
  const cars = r.cars.slice().sort((a, b) => gridOf(a) - gridOf(b) || a.pos - b.pos);
  const top = r.cars.slice().sort((a, b) => b.win - a.win)[0];
  let verdict, k;
  if (r.settled) { verdict = 'won the race'; k = 'hi'; }
  else if (top.win >= 0.7) { verdict = 'strong favourite to win'; k = 'hi'; }
  else if (top.win >= 0.45) { verdict = 'favourite to win'; k = 'mid'; }
  else { verdict = 'open race: no clear favourite'; k = 'lo'; }
  const rows = cars.map(c => {
    const d = r.byN[c.n] || {}, L = L_()[c.n] || {}, out = L.Retired || L.Stopped;
    const moved = d.grid && inp.started && !out ? d.grid - c.pos : 0;
    const mv = moved > 0 ? `<span class="c-green rcmv">▲${moved}</span>` : moved < 0 ? `<span class="c-red rcmv">▼${-moved}</span>` : '';
    const plan = r.settled ? '' : out ? '<span class="dimt">out</span>' : `${tyreChip(d.compound, d.age)} ${d.owed ? `<span class="c-yellow">${d.owed} stop${d.owed > 1 ? 's' : ''} to make</span>` : '<span class="dimt">no stop needed</span>'}`;
    const cell = x => `<td class="mono t ${cls(x)}">${pct(x)}%</td>`;
    return `<tr class="${c.n === selected ? 'selrow' : ''}${out ? ' rcout' : ''}"><td class="mono dimt">${d.grid || '–'}</td><td class="mono">${out ? 'OUT' : 'P' + c.pos}${mv}</td><td>${chipD(c.n)}</td>
      ${cell(c.win)}${cell(c.top3)}${cell(c.top5)}${cell(c.top10)}<td class="rcplan">${plan}</td></tr>`;
  }).join('');
  const lapTxt = inp.total ? (inp.started ? `Lap ${inp.cur} of ${inp.total}` : `Before the start · ${inp.total} laps`) : '';
  const early = !inp.started || inp.cur < Math.max(6, inp.total * 0.15);
  const qn = Object.keys(qualiPace()).length;
  const basis = r.settled ? 'Race over.'
    : `<b>${lapTxt}</b> · ${Math.round(r.sc * 100)}% chance of a safety car`
      + (early ? `<br><b>Early:</b> mostly ${inp.started ? 'the order and ' : 'the grid and '}${qn ? 'qualifying pace' : 'little else (no qualifying pace saved)'}, so these move a lot in the first laps.` : '');
  return `<div class="ecard pole ${k}"><h4>Race call</h4>
    <div class="polehead"><span class="polepct mono">${r.settled ? '🏁' : pct(top.win) + '%'}</span><div><b class="polename">${chipD(top.n)}</b><span class="polev">${verdict}</span></div></div>
    <p class="note">${basis}</p>
    <details class="rcabout"><summary>How it works and how well it has done</summary>
      <p class="note">The rest of the race is played out ${RaceSim.P.runs.toLocaleString()} times, with pit stops still to make, tyre wear, safety cars and retirements. Each figure is corrected to how often that figure came true in the 48 races of 2024 and 2025 (checked on a season it wasn't fitted on), so 25% should mean about 1 in 4. Before the start it also counts the grid place: cars starting 4th or lower almost never won.</p>
      <p class="note">The favourite to win won 27 of 48 from the grid, 37 of 48 at half distance and 43 of 48 at 90% distance. Win figures are the roughest, and calls from the grid are the least reliable. These are chances, not certainties.</p>
    </details>${raceRecordHtml()}</div>
    <div class="rcwrap"><table class="et rc"><thead><tr><th>Grid</th><th>Now</th><th>Driver</th><th class="t">Win</th><th class="t">Top 3</th><th class="t">Top 5</th><th class="t">Top 10</th><th class="rcplan">Tyres · plan</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">In starting-grid order. Green is 70% or more, yellow 10–30%. Stops to make come from the rule that every dry race needs two tyre types, or tyres past their usual life.</p>`;
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
  const body = tab === 'driver' ? panelDriver(n) : tab === 'battles' ? panelBattles() : tab === 'knockout' ? panelKnockout() : tab === 'proj' ? null
    : tab === 'longruns' ? panelLongRuns() : tab === 'call' ? panelRaceCall() : tab === 'strategy' ? panelStrategy() : panelLaps(n);
  const recorded = Object.values(hist.laps).reduce((a, l) => a + l.length, 0);
  $('engInfo').textContent = `${recorded} laps recorded`;
  if (tab === 'proj') projMount($('engBody'));
  else if ($('engBody').dataset.html !== body) { $('engBody').innerHTML = body; $('engBody').dataset.html = body; }
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
