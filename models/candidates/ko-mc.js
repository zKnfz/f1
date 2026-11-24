// Candidate "ko-mc": chance of each car being knocked out of Q1 / Q2. Not in production (the
// page shows only who is in the drop zone now). It reuses the pole call's own inputs for each car
// (time held in this part; the lap on track or the lap still to come, with its spread and the
// chance it happens) and plays the rest of the part out 3000 times, counting how often each car
// ends below the cut. Records go to the replay output (kind "ko"); nothing is shown.
addEventListener('DOMContentLoaded', () => {
  const orig = window.poleCall;
  let queue = [], last = '';
  setInterval(() => { if (!queue.length) return; const body = JSON.stringify(queue); queue = []; fetch('api/record', { method: 'POST', body }).catch(() => {}); }, 500);
  window.poleCall = () => {
    const p = orig();
    try {
      const td = state.TimingData || {}, part = td.SessionPart || 1, ne = arr(td.NoEntries).map(Number);
      const cut = ne[part]; // how many go through
      if (p && part < 3 && cut) {
        // Every car still in this part counts, including those with no time and no lap to come.
        const lines = L_(), inPart = Object.keys(lines).filter(n => !lines[n]?.KnockedOut && !lines[n]?.Retired);
        const by = Object.fromEntries(p.cars.map(c => [c.n, c]));
        let seed = 20261124;
        const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
        const out = Object.fromEntries(inPart.map(n => [n, 0])), R = 3000;
        for (let k = 0; k < R; k++) {
          const t = inPart.map(n => {
            const c = by[n]; let x = c?.best ?? Infinity;
            if (c?.lap && rnd() < c.lap.w) x = Math.min(x, c.lap.m + gauss() * c.lap.s);
            return [n, x];
          }).sort((a, b) => a[1] - b[1]);
          t.forEach(([n], i) => { if (i >= cut) out[n]++; });
        }
        const cars = inPart.map(n => [n, +(out[n] / R).toFixed(4)]);
        const sig = JSON.stringify([part, cars]);
        if (sig !== last) { last = sig; queue.push({ kind: 'ko', part, cut, cars }); }
      }
    } catch (e) {}
    return p;
  };
  window.pitwallCandidate = 'ko-mc';
});
