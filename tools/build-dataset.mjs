// Training datasets from recordings, with no look-ahead.
//
// Times, as the recordings keep them:
//   event time      when F1 says something happened (sent time inside each feed frame)
//   knowledge time  when Pitwall had it: the collector's receipt time (first field of feed.tsv);
//                   the backend's own receipt is in ingest.jsonl per byte range
// Rule: every feature in a row comes from data with knowledge time ≤ the row's cutoff. Labels
// (what happened next) may come later; each row says when its label became known.
//
//   node tools/build-dataset.mjs laps [data/rec/<dir> ...]   lap-in-progress rows (cutoff: end of S1, end of S2)
//   node tools/build-dataset.mjs pole [data/rec/<dir> ...]   Pitwall's pole chances vs Kalshi vs the result
// Writes data/datasets/<kind>-<time>/rows.jsonl and manifest.json (sources with SHA-256 of every
// file, code commit, rules), so any model trained on it can say exactly what it learned from.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFeed, readJsonl, merge } from '../recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
export const SCHEMA = { laps: 1, pole: 1 };
const secs = v => { if (v == null || v === '') return null; const p = String(v).split(':').map(Number); const s = p.length === 2 ? p[0] * 60 + p[1] : p[0]; return isFinite(s) && s > 0 ? s : null; };
const arr = x => Array.isArray(x) ? x : x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]) : [];

// Walks a recording in knowledge-time order, keeping the state exactly as the relay would have
// it, and calls onFrame(state, frame) after each update is applied.
export async function walk(dir, onFrame) {
  let state = {};
  const seen = new Set(), live = new Set();
  const closes = readJsonl(dir, 'events.jsonl').filter(e => e.ev === 'closed');
  let ci = 0;
  for await (const f of readFeed(dir)) {
    while (ci < closes.length && closes[ci].r <= f.r) live.delete(String(closes[ci++].conn));
    let m; try { m = JSON.parse(f.part); } catch { continue; }
    if (m.type === 1 && m.target === 'feed') {
      if (seen.has(f.part)) continue; seen.add(f.part);
      const [topic, data, sentAt] = m.arguments;
      if (topic.endsWith('.z')) continue;
      state[topic] = merge(state[topic], data);
      onFrame(state, { r: f.r, topic, data, sentAt });
    } else if (m.type === 3 && m.invocationId === '0' && !m.error) {
      if (!live.size) { state = m.result || {}; delete state['Position.z']; delete state['CarData.z']; onFrame(state, { r: f.r, topic: '_snapshot', data: null }); }
      live.add(String(f.c));
    }
  }
  return state;
}

// Rows for the lap projection: one at the end of S1 and one at the end of S2 of every lap,
// with what was known at that moment; the label is the lap time when the lap ended.
export async function lapRows(dir) {
  const rows = [], open = {}; // n -> { lap, cut: [rowS1, rowS2] }
  const session = { dir: path.basename(dir) };
  const final = await walk(dir, (st, fr) => {
    if (fr.topic === '_snapshot') { session.key = st.SessionInfo?.Key; session.name = `${st.SessionInfo?.Meeting?.Name} ${st.SessionInfo?.Name}`; session.type = st.SessionInfo?.Type; return; }
    if (fr.topic !== 'TimingData' || !fr.data?.Lines) return;
    for (const [n, u] of Object.entries(fr.data.Lines)) {
      const L = st.TimingData.Lines[n] || {};
      const lapEnd = secs(u?.LastLapTime?.Value);
      if (lapEnd) {
        const o = open[n];
        if (o) for (const row of o.cut) if (row) rows.push({ ...row, label: { lapTime: lapEnd, knownAt: fr.r } });
        delete open[n];
      }
      for (const [k, sec] of Object.entries(u?.Sectors || {})) {
        const i = Number(k), v = secs(sec?.Value);
        if (!(i === 0 || i === 1) || !v || (lapEnd && i === 2)) continue;
        if (i === 0) open[n] = { cut: [null, null] };
        if (!open[n]) continue;
        const cur = arr(L.Sectors).map(s => secs(s?.Value));
        const stint = arr(st.TimingAppData?.Lines?.[n]?.Stints).at(-1) || {};
        const pb = arr(st.TimingStats?.Lines?.[n]?.BestSectors).map(s => secs(s?.Value));
        const fieldBest = [0, 1, 2].map(j => Math.min(...Object.values(st.TimingStats?.Lines || {}).map(x => secs(arr(x?.BestSectors)[j]?.Value) ?? Infinity)));
        open[n].cut[i] = {
          session, driver: n, tla: st.DriverList?.[n]?.Tla ?? null, cutoff: fr.r, eventTime: fr.sentAt ?? null, after: `S${i + 1}`,
          lapNumber: (+L.NumberOfLaps || 0) + 1, part: st.TimingData?.SessionPart ?? null,
          sectors: cur.map((x, j) => (j <= i ? x : null)), pbSectors: pb, fieldBestSectors: fieldBest.map(x => (isFinite(x) ? x : null)),
          bestLap: secs(L.BestLapTime?.Value), compound: stint.Compound ?? null, tyreAge: stint.TotalLaps ?? null, newTyre: stint.New ?? null,
          speeds: Object.fromEntries(Object.entries(L.Speeds || {}).map(([k2, s]) => [k2, Number(s?.Value) || null])),
          trackStatus: st.TrackStatus?.Status ?? null, weather: st.WeatherData ? { air: +st.WeatherData.AirTemp, track: +st.WeatherData.TrackTemp, rain: st.WeatherData.Rainfall } : null,
          clockRemaining: st.ExtrapolatedClock?.Remaining ?? null,
        };
      }
    }
  });
  // Lap deletions (race control), matched to the lap time; a label, so it may come later.
  const del = arr(final.RaceControlMessages?.Messages).map(m => /CAR (\d+).*?TIME (\d+:\d{2}\.\d{3}) DELETED/i.exec(m?.Message || '')).filter(Boolean).map(g => `${g[1]}:${secs(g[2]).toFixed(3)}`);
  for (const r of rows) r.label.deleted = del.includes(`${r.driver}:${r.label.lapTime.toFixed(3)}`);
  return rows;
}

// Rows for pole: each pole call Pitwall recorded in Q3, the Kalshi prices known at that moment,
// and who took pole.
export async function poleRows(dir) {
  const page = [...readJsonl(dir, 'page.jsonl'), ...readJsonl(dir, 'backend-page.jsonl')].filter(p => p.kind === 'pole' && p.part === 3).sort((a, b) => a.r - b.r);
  if (!page.length) return [];
  const kal = [...readJsonl(dir, 'kalshi.jsonl'), ...readJsonl(dir, 'backend-kalshi.jsonl')].filter(k => k.type === 'kalshi' && k.m === 'pole').sort((a, b) => a.t - b.t);
  const final = await walk(dir, () => {});
  const q3 = Object.entries(final.TimingData?.Lines || {}).map(([n, L]) => ({ tla: final.DriverList?.[n]?.Tla, t: secs(arr(L.BestLapTimes)[2]?.Value) })).filter(x => x.t).sort((a, b) => a.t - b.t);
  const pole = q3[0]?.tla ?? null;
  const rows = [], prices = {};
  let ki = 0;
  for (const p of page) {
    while (ki < kal.length && kal[ki].t <= p.r) { for (const [code, v] of Object.entries(kal[ki].p)) prices[code] = Array.isArray(v) ? v : v.p; ki++; }
    for (const [tla, ch] of p.cars) {
      const k = prices[tla];
      rows.push({ session: path.basename(dir), cutoff: p.r, driver: tla, pitwall: ch, kalshiBid: k?.[0] ?? null, kalshiAsk: k?.[1] ?? null, kalshiMid: k && k[0] != null && k[1] != null ? (k[0] + k[1]) / 200 : null, label: { pole: tla === pole, knownAt: null } });
    }
  }
  return rows;
}

function manifest(kind, dirs, rows) {
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  let commit = null; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch {}
  return {
    kind, schema: SCHEMA[kind], created: new Date().toISOString(), codeCommit: commit, rows,
    rules: 'features: only data with knowledge time (collector receipt) <= cutoff; labels may be known later (label.knownAt)',
    sources: dirs.map(d => ({ dir: path.basename(d), files: Object.fromEntries(fs.readdirSync(d).filter(f => !f.startsWith('.') && !f.startsWith('state-at')).sort().map(f => [f, sha(path.join(d, f))])) })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, ...args] = process.argv.slice(2);
  if (!SCHEMA[kind]) { console.log('usage: node tools/build-dataset.mjs laps|pole [data/rec/<dir> ...]'); process.exit(1); }
  const root = path.join(DATA, 'rec');
  const dirs = (args.length ? args.map(a => path.resolve(a)) : fs.readdirSync(root).filter(d => /^\d{4}-/.test(d)).map(d => path.join(root, d)));
  const all = [];
  for (const d of dirs) { const rows = kind === 'laps' ? await lapRows(d) : await poleRows(d); console.log(`${path.basename(d)}: ${rows.length} rows`); all.push(...rows); }
  const out = path.join(DATA, 'datasets', `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'rows.jsonl'), all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(kind, dirs, all.length), null, 1));
  console.log(`${all.length} rows → ${path.relative(process.cwd(), out)}`);
}
