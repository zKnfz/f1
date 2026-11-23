// Lap story (qualifying and practice): how each lap's projection and pole chance move as it
// happens, why they moved, and how the lap ended. Display only: it reads the existing
// projection (liveLap) and pole call (poleCall, via the 'polecall' event alerts.js sends after
// each sector batch) and changes neither.
//
// Per driver:
//   cur   the lap in progress: points {t, done, frac, proj, ch, target} as it goes
//   last  the last lap that ended: completed (with the real time vs what was projected),
//         aborted (slowed or pitted before the line), or deleted (race control)
// Moves of 5 points or more in the pole chance, and every sector, are explained in plain words
// (sector vs the driver's reference, the time to beat moving, a flag) and kept in `story`
// (newest first), shown on the Projected tab and recorded by the recorder's page.
(function () {
  if (typeof es === 'undefined' || typeof liveLap !== 'function') return;
  const VERSION = 'lapstory-1';
  const S = {};          // n -> { cur, last }
  const story = [];      // { t, n, kind, text, from, to }
  const KEEP_MS = 90000; // how long an ended lap's result stays on the driver's row
  const pts100 = x => Math.round(x * 100);
  const code = n => dInfo(n).code;
  const kindNow = () => sessionKind();

  function note(n, kind, text, from = null, to = null) {
    const e = { t: Date.now(), n, kind, text, from, to };
    story.unshift(e); if (story.length > 40) story.pop();
    es.dispatchEvent(new CustomEvent('lapstory', { detail: e }));
    engDirty = true;
  }

  // Why a lap's chance or projection moved between two points of the same lap.
  function explain(n, a, b, lv) {
    const why = [];
    if (b.done > a.done) {
      // Against their best before this sector (F1 updates the best at the same moment).
      const i = b.done - 1, v = lv.cur?.[i], c = secCmp[n]?.[i];
      const purple = !!arr(L_()[n]?.Sectors)[i]?.OverallFastest;
      const ref = c && v != null && Math.abs(c.v - v) < 0.0005 ? c.before : null;
      if (v != null && ref != null) why.push(`S${i + 1} ${signed(v - ref)}${v < ref ? ', a personal best' : ' off their best'}${purple ? ' (fastest of anyone)' : ''}`);
      else if (v != null) why.push(`S${i + 1} ${v.toFixed(3)}${purple ? ' (fastest of anyone)' : ''}`);
    }
    if (a.target != null && b.target != null && b.target < a.target - 0.0005) {
      const who = b.targetBy ? code(b.targetBy) : 'someone';
      why.push(b.target > b.proj ? `${who} set ${fmtLapT(b.target)}, slower than this lap` : `${who} set ${fmtLapT(b.target)}: this lap now needs ${signed(b.target - b.proj)}`);
    }
    if (b.rival && (!a.rival || b.rival.m < a.rival.m - 0.05) && (b.ch ?? 0) < (a.ch ?? 0)) why.push(`${code(b.rival.n)} on a lap heading for ${fmtLapT(b.rival.m)}`);
    else if (a.rival && (!b.rival || b.rival.m > a.rival.m + 0.05) && (b.ch ?? 0) > (a.ch ?? 0)) why.push(a.rival && (!b.rival || b.rival.n !== a.rival.n) ? `${code(a.rival.n)}'s lap no longer a threat` : `${code(a.rival.n)}'s lap slowing`);
    if (b.flag !== a.flag) why.push(b.flag ? b.flag : 'flag cleared');
    // Still nothing for a drop: say who it is losing to.
    if (why.length < 2 && b.ch != null && a.ch != null && b.ch < a.ch - 0.04 && b.rival && b.rival.m < b.proj && !why.some(w => w.includes(code(b.rival.n)))) why.push(`${code(b.rival.n)}'s lap is quicker (heading for ${fmtLapT(b.rival.m)})`);
    if (!why.length && Math.abs(b.proj - a.proj) >= 0.05) why.push(`mini-sectors ${b.proj < a.proj ? 'quicker' : 'slower'} than their best`);
    return why;
  }

  function update(p) {
    const t0 = performance.now();
    try { updateInner(p); } finally { window.pitwallLatency?.note?.('lapStory', performance.now() - t0); }
  }
  function updateInner(p) {
    const k = kindNow();
    if (k !== 'quali' && k !== 'practice') return;
    const now = Date.now(), lines = L_();
    const byN = p ? Object.fromEntries(p.cars.map(c => [c.n, c])) : {};
    // The time each lap has to beat: the best in this part (qualifying) or of the session.
    let target = null, targetBy = null;
    if (p) for (const c of p.cars) if (c.best && (target == null || c.best < target)) { target = c.best; targetBy = c.n; }
    if (target == null && window.sessionFastest) { target = window.sessionFastest.t; targetBy = window.sessionFastest.n; }
    for (const n of engOrder()) {
      const L = lines[n] || {}, s = S[n] ??= { cur: null, last: null };
      const lv = L.InPit || L.KnockedOut || L.Retired || L.Stopped ? null : liveLap(n);
      const on = !!lv?.projected && !lv.slow;
      const lapNo = typeof secLap === 'object' ? secLap[n] ?? null : null;
      if (on && lapNo != null && s.abortedLap === lapNo) continue; // a lap already given up stays given up
      if (on) {
        if (s.cur && lv.done < (s.cur.pts.at(-1)?.done ?? 0)) s.cur = null; // a new lap began unseen
        if (!s.cur) s.cur = { start: now, lap: lapNo, pts: [] };
        // The quickest lap someone else has going (from the pole call), the other thing that moves a chance.
        let rival = null;
        if (p) for (const c of p.cars) if (c.n !== n && c.lap && /on a lap/.test(c.why) && (!rival || c.lap.m < rival.m)) rival = { n: c.n, m: c.lap.m };
        const pt = { t: now, done: lv.done, frac: lv.lapFrac, proj: lv.projected, ch: byN[n]?.ch ?? null, target, targetBy, rival, flag: flagRisk(n, lv).label || '' };
        const prev = s.cur.pts.at(-1);
        const moved = !prev || pt.done !== prev.done || Math.abs(pt.proj - prev.proj) >= 0.005 || (pt.ch != null && Math.abs(pt.ch - (prev.ch ?? 0)) >= 0.005) || pt.target !== prev.target || pt.flag !== prev.flag;
        if (!moved) continue;
        s.cur.pts.push(pt);
        if (s.cur.pts.length > 200) s.cur.pts.splice(1, 1);
        if (!prev || lv.done < 1) continue;
        const dCh = pt.ch != null && prev.ch != null ? pt.ch - prev.ch : 0;
        // Explain every sector completed, and any big move in the chance in between.
        if (pt.done > prev.done || Math.abs(dCh) >= 0.05) {
          const why = explain(n, prev, pt, lv);
          if (why.length) {
            const chTxt = pt.ch != null && prev.ch != null && Math.abs(dCh) >= 0.01 ? ` · chance ${pts100(prev.ch)}% → ${pts100(pt.ch)}%` : '';
            note(n, 'move', `${why.join(' · ')} · heading for ${fmtLapT(pt.proj)}${chTxt}`, prev.ch, pt.ch);
          }
        }
      } else if (s.cur) {
        const lastPt = s.cur.pts.at(-1);
        if (lastPt && lastPt.done >= 1 && (lv?.slow || L.InPit)) {
          s.last = { ...s.cur, state: 'aborted', at: now, where: `S${Math.min(3, lastPt.done + 1)}` };
          s.abortedLap = s.cur.lap;
          note(n, 'aborted', `lap aborted in ${s.last.where}${L.InPit ? ' (into the pits)' : ' (backed off)'} · was heading for ${fmtLapT(lastPt.proj)}`, lastPt.ch, 0);
        }
        s.cur = null;
      }
    }
  }

  // Each sector as it is set, with the driver's best for it just before (secCmp), so a sector
  // can be compared with what it had to beat even after F1 has made it the new best.
  const secBest = {}, secCmp = {};
  // Lap ends: the real time against what was projected after S1 and after S2.
  es.addEventListener('feed', e => {
    const [topic, data] = e.detail;
    if (topic === 'TimingData' && data?.Lines) {
      for (const [n, u] of Object.entries(data.Lines)) {
        for (const [k, sec] of Object.entries(u?.Sectors || {})) {
          const i = Number(k), v = lapSecs(sec?.Value);
          if (!(i >= 0 && i < 3) || !v) continue;
          const best = secBest[n] ??= pbSectors(n).slice(0, 3);
          if (secCmp[n]?.[i]?.v === v) continue;
          (secCmp[n] ??= [])[i] = { v, before: best[i] ?? null };
          if (best[i] == null || v < best[i]) best[i] = v;
        }
        const t = lapSecs(u?.LastLapTime?.Value);
        if (!t) continue;
        const s = S[n] ??= { cur: null, last: null };
        if (s.cur?.pts.some(p => p.done >= 1)) {
          const at = d => s.cur.pts.filter(p => p.done === d).at(-1)?.proj ?? null;
          const p1 = at(1), p2 = at(2), lastPt = s.cur.pts.at(-1);
          s.last = { ...s.cur, state: 'completed', at: Date.now(), time: t, projS1: p1, projS2: p2, chBefore: lastPt?.ch ?? null };
          const err = p2 ?? p1;
          note(n, 'completed', `finished ${fmtLapT(t)}${err != null ? ` · projected ${fmtLapT(err)} after S${p2 != null ? 2 : 1} (${signed(t - err)})` : ''}`, lastPt?.ch ?? null, null);
        }
        s.cur = null;
      }
      // Practice has no pole call: follow the projection on sector changes (batched).
      if (kindNow() === 'practice' && !queued) { queued = true; setTimeout(() => { queued = false; update(null); }, 120); }
    } else if (topic === 'RaceControlMessages') {
      for (const m of arr(data?.Messages)) {
        // "CAR 4 (NOR) TIME 1:21.902 DELETED - TRACK LIMITS AT TURN 12 LAP 5 15:04:11"
        const g = /CAR (\d+)[^T]*TIME (\d+:\d{2}\.\d{3}) DELETED(?: - (.*?))?(?: LAP \d+.*)?$/i.exec(m?.Message || '');
        if (!g) continue;
        const [, n, time, why] = g, s = S[n];
        const t = lapSecs(time);
        if (s?.last?.time && Math.abs(s.last.time - t) < 0.0015) { s.last.state = 'deleted'; s.last.deletedWhy = (why || '').toLowerCase(); s.last.at = Date.now(); }
        note(n, 'deleted', `lap ${time} deleted${why ? ' · ' + why.toLowerCase() : ''}`);
      }
    }
  });
  let queued = false;
  es.addEventListener('polecall', e => update(e.detail));
  es.addEventListener('full', () => { for (const o of [S, secBest, secCmp]) for (const k in o) delete o[k]; story.length = 0; });

  // ---------- Display helpers for the Projected tab ----------
  // A small line of the pole chance (qualifying) or of the projection vs the time to beat
  // (practice) across this lap, plus the move since sector 1.
  function trend(n) {
    const c = S[n]?.cur;
    if (!c) return '';
    const pts = c.pts.filter(p => p.done >= 1);
    if (pts.length < 2) return '';
    const useCh = pts.every(p => p.ch != null);
    const vals = useCh ? pts.map(p => p.ch) : pts.map(p => (p.target ? p.target - p.proj : 0));
    const first = vals[0], lastV = vals.at(-1), d = lastV - first;
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const W = 46, H = 14;
    const xy = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - 1 - (v - lo) / span * (H - 2)).toFixed(1)}`).join(' ');
    const cls = Math.abs(d) < (useCh ? 0.02 : 0.03) ? 'flat' : d > 0 ? 'up' : 'down';
    const label = useCh ? `${d > 0 ? '▲' : d < 0 ? '▼' : ''}${Math.abs(pts100(d))}` : `${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(2)}`;
    const title = useCh ? `Chance this lap: ${pts100(first)}% after S1 → ${pts100(lastV)}% now` : `Projection vs the time to beat: ${signed(-first)} after S1 → ${signed(-lastV)} now`;
    return `<span class="lsx ${cls}" title="${title}"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${xy}"/></svg><b class="mono">${label}</b></span>`;
  }
  // How the driver's last lap ended, for a short while after it did.
  function ended(n) {
    const l = S[n]?.last;
    if (!l || Date.now() - l.at > KEEP_MS) return null;
    if (l.state === 'deleted') return `<span class="lsend del">lap deleted</span>${l.deletedWhy ? ` <span class="dimt">${esc(l.deletedWhy)}</span>` : ''}`;
    if (l.state === 'aborted') return `<span class="lsend abt">aborted in ${l.where}</span> <span class="dimt">was heading for ${fmtLapT(l.pts.at(-1).proj)}</span>`;
    const ref = l.projS2 ?? l.projS1;
    return `<span class="lsend ok">finished ${fmtLapT(l.time)}</span>${ref != null ? ` <span class="dimt">projected ${fmtLapT(ref)} (${signed(l.time - ref)})</span>` : ''}`;
  }
  function storyHtml() {
    if (!story.length) return '';
    const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; };
    const icon = { move: '•', completed: '🏁', aborted: '↩', deleted: '✖' };
    const rows = story.slice(0, 8).map(e => {
      const d = e.from != null && e.to != null ? e.to - e.from : null;
      const cls = d == null || Math.abs(d) < 0.01 ? '' : d > 0 ? 'c-green' : 'c-red';
      return `<tr><td class="dimt mono">${ago(e.t)}</td><td>${chipD(e.n)}</td><td class="${cls}">${icon[e.kind] || ''} ${e.text}</td></tr>`;
    }).join('');
    return `<div class="ecard lstory"><h4>What changed</h4><table class="et">${rows}</table><p class="note">Each sector and every move of 5 points or more in a lap's chance, with the reason. Newest first.</p></div>`;
  }
  window.lapStory = { VERSION, state: S, story, trend, ended, storyHtml, update };
})();
