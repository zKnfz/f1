// Race call: the chance each driver wins, finishes top 3, top 5 and top 10.
//
// The rest of the race is played out a few thousand times. Each run starts from the real
// gaps and adds, for every driver:
//   · their race pace (recent clean laps, corrected for tyre age, pulled towards the field
//     and towards their qualifying pace while there are few laps to go on),
//   · tyre wear for the laps left,
//   · pit stops still owed (the two-compound rule, or tyres that won't last),
//   · random spread: how unsure the pace is, lap-to-lap noise, slow stops,
//   · a chance of a safety car (closes the gaps and makes a stop cheap) and of retiring.
// Overtaking is not free: a quicker car on the same strategy needs a margin to get by.
//
// Pure functions, shared by the page (window.RaceSim) and the offline test (require).
(function (root) {
  const LIFE = { SOFT: 22, MEDIUM: 34, HARD: 46, INTERMEDIATE: 30, WET: 40 };
  const DRY = ['SOFT', 'MEDIUM', 'HARD'];
  const P = {
    runs: 4000,
    paceSdModel: 0.25,  // s/lap: how far true pace can be from the best estimate, even with many laps
    lapSd: 0.55,        // s: spread of one lap's time, used to judge how much a few laps tell us
    lapNoise: 0.7,      // s per lap of random race noise, adds up as √laps
    shrink: 4,          // laps' worth of pull towards the prior pace
    qualiWeight: 0.6,   // share of a qualifying gap that shows up as race pace
    deg: 0.035,         // s per lap of tyre age, used when the race has not shown its own figure
    pass: 1.2,          // s a quicker car on the same strategy must find to get by
    stopSd: 1.0, slowStop: 0.04, slowStopAdd: 6,
    scPerLap: 0.007,    // chance of a safety car starting on any given lap
    scGap: 0.9,         // s between cars after a safety car restart
    dnfPerLap: 0.002,   // chance of retiring on any given lap
    startSd: 2.0,       // s of extra spread for the start, before the race is under way
    gridGap: 1.0,       // s lost per grid place before the start (lap-1 traffic, not just the distance)
    temp: 0.8,          // softening used only when the correction below is turned off
    cal: 1,             // 1 = correct the chances with CAL (how often each figure came true before)
  };

  // Correction learned from the 2024 and 2025 races (tools/race-calibrate.mjs), so a figure
  // means how often such a figure came true. Before the start: logistic of
  // [1, log-odds of the figure, log of grid place] (a car further back wins less often than the
  // same figure from the front row). During the race: pairs of [figure, how often it came true],
  // read off the straight line between two pairs.
  const CAL = {"pre":{"win":[0.91,0.98,-1.081],"top3":[1.894,0.296,-1.847],"top5":[2.932,0.371,-1.912],"top10":[3.289,0.446,-1.472]},"race":{"win":[[0,0],[0,0.0014],[0.0008,0.0061],[0.0021,0.0103],[0.0092,0.0116],[0.0319,0.0459],[0.085,0.0594],[0.2114,0.0909],[0.3332,0.3636],[0.3601,0.472],[0.4453,0.5257],[0.5761,0.6507],[0.6447,0.7705],[0.7169,0.828],[0.8933,0.8776],[0.9778,0.9333],[0.9875,0.9925]],"top3":[[0,0],[0,0.003],[0.0007,0.009],[0.0103,0.0139],[0.0191,0.033],[0.0411,0.0589],[0.0857,0.0661],[0.1256,0.1377],[0.1569,0.1579],[0.2126,0.2246],[0.2594,0.2507],[0.3232,0.2802],[0.3847,0.3252],[0.4645,0.5342],[0.6396,0.6635],[0.7485,0.6939],[0.8413,0.7983],[0.9079,0.8525],[0.9367,0.8714],[0.9526,0.9184],[0.9693,0.9154],[0.9847,0.9391],[0.9895,0.9644],[0.9955,0.9966]],"top5":[[0,0],[0,0.0038],[0,0.0137],[0.0005,0.0147],[0.0073,0.037],[0.0504,0.0547],[0.1359,0.0982],[0.2272,0.1258],[0.2696,0.2381],[0.2937,0.2441],[0.3567,0.339],[0.4327,0.3645],[0.4708,0.4942],[0.5324,0.5563],[0.6078,0.7426],[0.6352,0.7453],[0.7316,0.8092],[0.8373,0.814],[0.8832,0.8372],[0.9094,0.8834],[0.9339,0.8907],[0.9528,0.9034],[0.9726,0.9041],[0.9835,0.9289],[0.9884,0.9525],[0.9934,0.9978]],"top10":[[0,0],[0,0.0137],[0,0.0166],[0,0.0185],[0.0003,0.0192],[0.0044,0.051],[0.0145,0.0817],[0.039,0.0957],[0.0742,0.1111],[0.1016,0.1304],[0.187,0.1842],[0.2647,0.2946],[0.3242,0.3298],[0.3822,0.4249],[0.4493,0.4937],[0.5771,0.5302],[0.679,0.6132],[0.7226,0.6866],[0.764,0.7604],[0.7748,0.7703],[0.7973,0.7878],[0.8247,0.8531],[0.8538,0.86],[0.9046,0.8983],[0.9279,0.9007],[0.9434,0.9105],[0.9603,0.93],[0.9704,0.9311],[0.982,0.956],[0.988,0.96],[0.991,0.9627],[0.9944,0.9976]]}};
  const lo = p => { p = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(p / (1 - p)); };
  const calRead = (k, p) => {
    if (p <= k[0][0]) return k[0][1] * p / Math.max(k[0][0], 1e-6);
    const last = k[k.length - 1];
    if (p >= last[0]) return last[1] + (p - last[0]) * (1 - last[1]) / Math.max(1e-6, 1 - last[0]);
    for (let i = 1; i < k.length; i++) if (p <= k[i][0]) { const [x0, y0] = k[i - 1], [x1, y1] = k[i]; return y0 + (y1 - y0) * (p - x0) / (x1 - x0); }
  };
  const calFix = (k, p, grid, started) => started ? Math.max(0, Math.min(1, calRead(CAL.race[k], p)))
    : (w => 1 / (1 + Math.exp(-(w[0] + w[1] * lo(p) + w[2] * Math.log(Math.max(1, grid))))))(CAL.pre[k]);

  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

  // inp: { lapsLeft, sprint, started, pitLoss, scLoss, scNow, ref,
  //        cars: [{ n, pos, gap, out, compound, age, used: [compounds], laps: [{ time, age }], qbest }] }
  // laps: this driver's clean racing laps on the current stint and earlier, newest last.
  function build(inp) {
    const cars = inp.cars.filter(c => !c.out);
    // Tyre wear: one slope for the whole field, from time against tyre age within each stint.
    let sxy = 0, sxx = 0;
    for (const c of cars) {
      const by = new Map();
      for (const l of c.laps) { const k = l.stint ?? 0; if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
      for (const g of by.values()) {
        if (g.length < 4) continue;
        const ma = mean(g.map(l => l.age)), mt = mean(g.map(l => l.time));
        for (const l of g) { sxy += (l.age - ma) * (l.time - mt); sxx += (l.age - ma) ** 2; }
      }
    }
    const deg = sxx > 200 ? Math.max(0.005, Math.min(0.12, (sxy / sxx + P.deg * 2) / 3)) : P.deg;
    // Each driver's pace on fresh tyres, from up to their last 8 clean laps.
    for (const c of cars) {
      const recent = c.laps.slice(-8);
      c.k = recent.length;
      c.own = c.k ? mean(recent.map(l => l.time - deg * l.age)) : null;
    }
    const owns = cars.filter(c => c.k >= 3).map(c => c.own);
    const field = owns.length >= 3 ? median(owns) : (inp.ref || 90);
    const qs = cars.map(c => c.qbest).filter(Boolean), qMed = median(qs);
    for (const c of cars) {
      const prior = field + (c.qbest && qMed ? P.qualiWeight * (c.qbest - qMed) : 0);
      c.pace = c.k ? (c.k * c.own + P.shrink * prior) / (c.k + P.shrink) : prior;
      c.paceSd = Math.sqrt(P.paceSdModel ** 2 + P.lapSd ** 2 / (c.k + P.shrink));
      // Stops still owed: the two-dry-compound rule, or a tyre that will not last to the end.
      const L = inp.lapsLeft;
      const wet = (c.used || []).some(x => !DRY.includes(x)) || !DRY.includes(c.compound);
      const dryUsed = new Set((c.used || []).filter(x => DRY.includes(x))).size;
      const rule = !inp.sprint && !wet && dryUsed < 2 && L > 0 ? 1 : 0;
      // A stop for wear is a judgement call, so it is a chance rather than a certainty:
      // none while the tyres are well inside their usual life, certain well beyond it.
      const life = LIFE[c.compound] || 34;
      const x = L <= 3 ? 0 : rule ? (L / 2) / LIFE.HARD : (c.age + L) / life;
      c.rule = rule;
      c.pExtra = Math.max(0, Math.min(1, (x - 0.95) / 0.5));
      // Time for the rest of the race, without noise, for each plan: laps at pace, wear, stops.
      const wearCost = (a, n) => deg * (n * a + n * (n - 1) / 2);
      c.plans = [rule, rule + 1].map(owed => {
        const firstLen = owed ? Math.max(1, Math.min(L - 1, Math.round(L / (owed + 1)))) : L;
        return { owed, firstLen, rest: L * c.pace + wearCost(c.age, firstLen) + (owed ? owed * wearCost(1, (L - firstLen) / owed) : 0) };
      });
      c.owed = rule + (c.pExtra >= 0.5 ? 1 : 0); // the likelier plan, for display
    }
    return { ...inp, cars, deg, field };
  }

  // Seeded random numbers so the same inputs always give the same chances.
  function rng(seed) {
    let s = seed | 0;
    const u = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
    return { u, g };
  }

  function run(b, opts = {}) {
    const runs = opts.runs || P.runs, { u, g } = rng(opts.seed || 1121);
    const L = b.lapsLeft, cars = b.cars.slice().sort((a, c) => a.pos - c.pos);
    const N = cars.length;
    const out = cars.map(c => ({ n: c.n, pos: c.pos, owed: c.owed, pace: c.pace, win: 0, top3: 0, top5: 0, top10: 0, avg: 0 }));
    if (!N) return { cars: out, deg: b.deg, sc: 0 };
    if (L <= 0) {
      cars.forEach((c, i) => { out[i].win = i === 0 ? 1 : 0; out[i].top3 = i < 3 ? 1 : 0; out[i].top5 = i < 5 ? 1 : 0; out[i].top10 = i < 10 ? 1 : 0; out[i].avg = i + 1; });
      return { cars: out, deg: b.deg, sc: 0, settled: true };
    }
    const pScRace = 1 - (1 - P.scPerLap) ** L;
    const plan_ = new Array(N), T = new Float64Array(N), stopsLeft = new Int8Array(N), order = new Int32Array(N);
    for (let r = 0; r < runs; r++) {
      // Safety car: on which lap, if any (one at most; a second is rarer and changes less).
      const sc = !b.scNow && u() < pScRace ? 1 + Math.floor(u() * L) : b.scNow ? 1 : 0;
      for (let i = 0; i < N; i++) {
        const c = cars[i], plan = c.plans[u() < c.pExtra ? 1 : 0];
        plan_[i] = plan;
        const pe = g() * c.paceSd, ln = g() * P.lapNoise * Math.sqrt(L);
        let stops = 0;
        for (let k = 0; k < plan.owed; k++) stops += b.pitLoss + g() * P.stopSd + (u() < P.slowStop ? P.slowStopAdd : 0);
        const restT = plan.rest + pe * L + ln;
        const start = b.started ? 0 : g() * P.startSd;
        if (!sc) T[i] = c.gap + start + restT + stops;
        else {
          // Up to the safety car: a share of the race. Stops due before it are done.
          const f = sc / L, early = plan.owed && sc > plan.firstLen ? 1 : 0;
          T[i] = c.gap + start + f * restT + early * (b.pitLoss + g() * P.stopSd);
          stopsLeft[i] = plan.owed - early;
        }
        if (u() < 1 - (1 - P.dnfPerLap) ** L) T[i] = Infinity;
      }
      if (sc) {
        // Field bunches up behind the safety car; anyone still owing a stop takes it now, cheaply.
        const idx = Array.from({ length: N }, (_, i) => i).filter(i => isFinite(T[i])).sort((a, c) => T[a] - T[c]);
        idx.forEach((i, rank) => {
          const c = cars[i], f = 1 - sc / L;
          let t = rank * P.scGap;
          if (stopsLeft[i] > 0) { t += b.scLoss + g() * P.stopSd; stopsLeft[i]--; }
          t += f * (plan_[i].rest + g() * c.paceSd * L + g() * P.lapNoise * Math.sqrt(L)) + stopsLeft[i] * (b.pitLoss + g() * P.stopSd);
          T[i] = t;
        });
      }
      // Finishing order: by time, but a car stuck behind one on the same plan needs a margin.
      let m = 0;
      for (let i = 0; i < N; i++) {
        let j = m++;
        while (j > 0) {
          const a = order[j - 1], same = !sc && plan_[a].owed === plan_[i].owed;
          if (T[i] < T[a] - (same ? P.pass : 0)) { order[j] = a; j--; } else break;
        }
        order[j] = i;
      }
      // Retired cars go to the back.
      const fin = Array.from(order).filter(i => isFinite(T[i])), dnf = Array.from(order).filter(i => !isFinite(T[i]));
      [...fin, ...dnf].forEach((i, p) => {
        const o = out[i];
        if (p === 0) o.win++;
        if (p < 3) o.top3++;
        if (p < 5) o.top5++;
        if (p < 10) o.top10++;
        o.avg += p + 1;
      });
    }
    for (const o of out) { o.win /= runs; o.top3 /= runs; o.top5 /= runs; o.top10 /= runs; o.avg /= runs; }
    // Correct each figure to how often that figure came true in past races (or, with the
    // correction off, soften it on the log-odds scale), then rescale so they still add up to
    // one winner, three top-3 places, five top-5 places and ten top-10 places.
    if (P.cal || P.temp !== 1) for (const [k, total] of [['win', 1], ['top3', Math.min(3, N)], ['top5', Math.min(5, N)], ['top10', Math.min(10, N)]]) {
      const soft = out.map(o => P.cal ? calFix(k, o[k], o.pos, b.started)
        : (p => 1 / (1 + Math.exp(-P.temp * Math.log(p / (1 - p)))))(Math.min(1 - 1e-4, Math.max(1e-4, o[k]))));
      let f = 1;
      for (let it = 0; it < 30; it++) { const sum = soft.reduce((a, p) => a + Math.min(1, p * f), 0); f *= total / sum; }
      out.forEach((o, i) => { o[k] = Math.min(1, soft[i] * f); });
    }
    return { cars: out, deg: b.deg, sc: pScRace };
  }

  const RaceSim = { P, LIFE, CAL, build, run };
  root.RaceSim = RaceSim;
  if (typeof module !== 'undefined') module.exports = RaceSim;
})(typeof window !== 'undefined' ? window : globalThis);
