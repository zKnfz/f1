// Durable recording of everything the relay receives, for replay and for training models.
//
// One folder per session: data/rec/<year>-<meeting>-<session>-<key>/
//   feed.tsv     every raw SignalR frame exactly as F1 sent it (all connections, duplicates
//                included), one per line:  receivedEpochMs \t monotonicMs \t connection \t frame
//                F1's own send time stamp is inside each feed frame (third argument).
//   events.jsonl connection opened / live / closed, gaps in the feed, missed-update checks,
//                relay start and stop. Each line has r (epoch ms) and m (monotonic ms).
//   page.jsonl   what the site predicted and alerted (sent by the recorder's page), with
//                model versions.
//   kalshi.jsonl Kalshi prices (written by kalshi.mjs into the same folder).
//   meta.json    session, relay start time, versions.
//
// Writing never holds up the live pipeline: frames are sent to pages first, then appended
// to an in-memory buffer that is written out asynchronously; the file is synced to disk
// every 5 seconds. Lines are self-contained, so a crash loses at most the last few seconds
// and never corrupts what is already written. A restart appends to the same session folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function createRecorder({ dataDir, enabled = true, log = console.log }) {
  const root = path.join(dataDir, 'rec');
  let cur = null; // { key, dir, feed, events, page, kalshiFile, lines, bytes }
  const pending = []; // frames that arrive before the session is known
  const startedAt = Date.now();

  function stream(file) {
    const s = fs.createWriteStream(file, { flags: 'a' });
    s.on('error', e => log('recorder: write failed', file, e.message));
    return s;
  }
  function open(info) {
    if (!enabled || !info?.Key) return;
    if (cur?.key === info.Key) return;
    close('session changed');
    const year = String(info.StartDate || '').slice(0, 4) || new Date().getUTCFullYear();
    const dir = path.join(root, `${year}-${slug(info.Meeting?.Name)}-${slug(info.Name)}-${info.Key}`);
    fs.mkdirSync(dir, { recursive: true });
    cur = { key: info.Key, dir, feed: stream(path.join(dir, 'feed.tsv')), events: stream(path.join(dir, 'events.jsonl')), page: stream(path.join(dir, 'page.jsonl')), lines: 0, bytes: 0 };
    const metaFile = path.join(dir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
    meta.session = { key: info.Key, name: info.Name, type: info.Type, meeting: info.Meeting?.Name, location: info.Meeting?.Location, start: info.StartDate, end: info.EndDate, gmtOffset: info.GmtOffset };
    (meta.relayRuns ??= []).push({ started: new Date(startedAt).toISOString(), opened: new Date().toISOString() });
    meta.format = 1;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
    event('open', { session: `${info.Meeting?.Name} ${info.Name}`, relayStarted: new Date(startedAt).toISOString() });
    log(new Date().toISOString(), 'recording to', path.relative(dataDir, dir));
    for (const p of pending.splice(0)) cur.feed.write(p);
  }
  function close(why) {
    if (!cur) return;
    event('close', { why, lines: cur.lines });
    const c = cur; cur = null;
    for (const s of [c.feed, c.events, c.page]) s.end();
  }
  // A raw frame as received. Cheap: string concatenation only; no parsing or re-encoding.
  function frame(conn, part, receivedAt = Date.now()) {
    if (!enabled) return;
    const line = `${receivedAt}\t${performance.now().toFixed(1)}\t${conn}\t${part}\n`;
    if (!cur) { pending.push(line); if (pending.length > 5000) pending.shift(); return; }
    cur.feed.write(line); cur.lines++; cur.bytes += line.length;
  }
  function event(ev, extra = {}) {
    if (!enabled || !cur) return;
    cur.events.write(JSON.stringify({ r: Date.now(), m: +performance.now().toFixed(1), ev, ...extra }) + '\n');
  }
  function page(rec) {
    if (!enabled || !cur) return;
    cur.page.write(JSON.stringify({ r: Date.now(), m: +performance.now().toFixed(1), ...rec }) + '\n');
  }
  // Flush to disk regularly so a power cut or crash loses at most a few seconds.
  const sync = setInterval(() => {
    if (!cur) return;
    for (const s of [cur.feed, cur.events, cur.page]) if (typeof s.fd === 'number') fs.fsync(s.fd, () => {});
  }, 5000);
  sync.unref?.();

  return {
    enabled, open, close, frame, event, page,
    dir: () => cur?.dir || null,
    stats: () => cur ? { dir: cur.dir, lines: cur.lines, bytes: cur.bytes } : null,
  };
}

// ---------- Reading a recording back ----------
// Yields { r, m, c, part } for every feed line, in file order (which is arrival order).
export async function* readFeed(file) {
  const fh = await fsp.open(file);
  let rest = '';
  for await (const chunk of fh.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const l of lines) {
      if (!l) continue;
      const a = l.indexOf('\t'), b = l.indexOf('\t', a + 1), c = l.indexOf('\t', b + 1);
      if (a < 0 || b < 0 || c < 0) continue; // a line cut short by a crash
      yield { r: +l.slice(0, a), m: +l.slice(a + 1, b), c: l.slice(b + 1, c), part: l.slice(c + 1) };
    }
  }
  await fh.close();
}

// ---------- Rebuilding what the relay knew ----------
// Same rules as the live relay: the first copy of each update across connections counts; a
// connection's snapshot replaces the state only when no other connection is live.
export function merge(target, src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src;
  if (target === null || typeof target !== 'object') target = {};
  for (const [k, v] of Object.entries(src)) if (k !== '_deleted') target[k] = merge(target[k], v);
  return target;
}
export async function stateAt(dir, untilEpochMs = Infinity) {
  let state = {}, n = 0, last = null;
  const live = new Set(), seen = new Set();
  let closes = [];
  try { closes = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.ev === 'closed'); } catch {}
  let ci = 0;
  for await (const f of readFeed(path.join(dir, 'feed.tsv'))) {
    if (f.r > untilEpochMs) break;
    while (ci < closes.length && closes[ci].r <= f.r) live.delete(String(closes[ci++].conn));
    let m; try { m = JSON.parse(f.part); } catch { continue; }
    if (m.type === 1 && m.target === 'feed') {
      if (seen.has(f.part)) continue; seen.add(f.part);
      const [topic, data] = m.arguments;
      if (topic.endsWith('.z')) continue;
      state[topic] = merge(state[topic], data); n++; last = f.r;
    } else if (m.type === 3 && m.invocationId === '0' && !m.error) {
      if (!live.size) { state = m.result || {}; delete state['Position.z']; delete state['CarData.z']; }
      live.add(String(f.c)); last = f.r;
    }
  }
  return { state, updates: n, lastAt: last };
}
