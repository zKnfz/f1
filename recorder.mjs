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
import zlib from 'node:zlib';

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// The folder name for a session, the same on every machine (collector and backend agree on it).
export function dirNameFor(info) {
  const year = String(info.StartDate || '').slice(0, 4) || new Date().getUTCFullYear();
  return `${year}-${slug(info.Meeting?.Name)}-${slug(info.Name)}-${info.Key}`;
}
// A collector writes feed.tsv, events.jsonl, meta.json (and page/kalshi if it runs them).
// The backend (FOLLOW mode) receives those files from the collector, so it must never write
// them itself: `backend: true` turns off the raw feed and writes its own records to
// backend-events.jsonl, backend-page.jsonl and backend-meta.json in the same session folder.
export function createRecorder({ dataDir, enabled = true, log = console.log, backend = false }) {
  const root = path.join(dataDir, 'rec');
  const NAME = backend ? { events: 'backend-events.jsonl', page: 'backend-page.jsonl', meta: 'backend-meta.json' } : { events: 'events.jsonl', page: 'page.jsonl', meta: 'meta.json' };
  let cur = null; // { key, dir, feed, events, page, kalshiFile, lines, bytes }
  const pending = []; // frames that arrive before the session is known
  const startedAt = Date.now();
  let idle = false; // between sessions on an always-on server: keep nothing

  function stream(file) {
    // After a crash the file may end in the middle of a line: end it, so the first line written
    // after the restart is not glued onto the broken one.
    try {
      const size = fs.statSync(file).size;
      if (size) { const fd = fs.openSync(file, 'r+'), b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 10) fs.writeSync(fd, '\n', size); fs.closeSync(fd); }
    } catch {}
    const s = fs.createWriteStream(file, { flags: 'a' });
    s.on('error', e => log('recorder: write failed', file, e.message));
    return s;
  }
  let lastInfo = null;
  function open(info) {
    if (!enabled || !info?.Key) return;
    lastInfo = info;
    if (cur?.key === info.Key) return;
    close('session changed');
    idle = false; // a new session: record it
    const dir = path.join(root, dirNameFor(info));
    fs.mkdirSync(dir, { recursive: true });
    cur = { key: info.Key, dir, feed: backend ? null : stream(path.join(dir, 'feed.tsv')), events: stream(path.join(dir, NAME.events)), page: stream(path.join(dir, NAME.page)), lines: 0, bytes: 0 };
    const metaFile = path.join(dir, NAME.meta);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
    meta.session = { key: info.Key, name: info.Name, type: info.Type, meeting: info.Meeting?.Name, location: info.Meeting?.Location, start: info.StartDate, end: info.EndDate, gmtOffset: info.GmtOffset };
    (meta.relayRuns ??= []).push({ started: new Date(startedAt).toISOString(), opened: new Date().toISOString() });
    meta.format = 1;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
    event('open', { session: `${info.Meeting?.Name} ${info.Name}`, relayStarted: new Date(startedAt).toISOString() });
    log(new Date().toISOString(), 'recording to', path.relative(dataDir, dir));
    if (cur.feed) for (const p of pending.splice(0)) cur.feed.write(p);
    if (spill) { spill.end(); spill = null; }
  }
  // Frames that arrive before any session is known are held in memory; past 5000 they go to
  // rec/_unsessioned/<date>/feed.tsv instead of being dropped.
  let spill = null;
  function spillLine(line) {
    if (!spill) {
      const d = path.join(root, '_unsessioned', new Date().toISOString().slice(0, 10));
      fs.mkdirSync(d, { recursive: true });
      spill = stream(path.join(d, 'feed.tsv'));
      log(new Date().toISOString(), 'recorder: no session known yet, keeping frames in', path.relative(dataDir, d));
    }
    spill.write(line);
  }
  function close(why) {
    if (!cur) return;
    event('close', { why, lines: cur.lines });
    const c = cur; cur = null;
    for (const s of [c.feed, c.events, c.page]) s?.end();
  }
  // A raw frame as received. Cheap: string concatenation only; no parsing or re-encoding.
  function frame(conn, part, receivedAt = Date.now()) {
    if (!enabled || idle || backend) return;
    const line = `${receivedAt}\t${performance.now().toFixed(1)}\t${conn}\t${part}\n`;
    if (!cur) { pending.push(line); if (pending.length > 5000) spillLine(pending.shift()); return; }
    cur.feed.write(line); cur.lines++; cur.bytes += line.length;
  }
  function event(ev, extra = {}) {
    if (!enabled || !cur || idle) return;
    cur.events.write(JSON.stringify({ r: Date.now(), m: +performance.now().toFixed(1), ev, ...extra }) + '\n');
  }
  function page(rec) {
    if (!enabled || !cur) return;
    cur.page.write(JSON.stringify({ r: Date.now(), m: +performance.now().toFixed(1), ...rec }) + '\n');
  }
  // Flush to disk regularly so a power cut or crash loses at most a few seconds.
  const sync = setInterval(() => {
    if (!cur) return;
    for (const s of [cur.feed, cur.events, cur.page]) if (s && typeof s.fd === 'number') fs.fsync(s.fd, () => {});
  }, 5000);
  sync.unref?.();

  return {
    enabled, backend, open, close, frame, event, page,
    // Idle (the session has been over for 30 min): close the files, so the folder counts as
    // finished and maintenance can compress and back it up. Resuming reopens the same folder.
    setIdle(v) {
      if (v === idle) return;
      if (v) { event('idle', { why: 'session over for 30 min' }); close('idle'); idle = true; }
      else { idle = false; if (!cur && lastInfo) open(lastInfo); event('resumed'); }
    },
    idle: () => idle,
    dir: () => cur?.dir || null,
    stats: () => cur ? { dir: cur.dir, lines: cur.lines, bytes: cur.bytes } : null,
  };
}

// ---------- Reading a recording back ----------
// A recording's files may be compressed (tools/compact-recordings.mjs moves feed.tsv into
// feed.tsv.gz, appending if it already exists). Readers take <name>.gz first, then <name>:
// compaction only ever moves older lines into the .gz, so this is arrival order.
function sources(file) {
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'feed.tsv');
  const base = file.replace(/\.gz$/, '');
  return [base + '.gz', base].filter(f => fs.existsSync(f));
}
export function readText(dir, name) {
  return sources(path.join(dir, name)).map(f => f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8')).join('');
}
export function readJsonl(dir, name) {
  const out = [];
  for (const l of readText(dir, name).split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} } // a cut-off last line is skipped
  return out;
}
// Yields { r, m, c, part } for every feed line, in file order (which is arrival order).
// Takes the feed file or the recording folder.
export async function* readFeed(file) {
  for (const f of sources(file)) yield* readOne(f);
}
async function* readOne(file) {
  const fh = await fsp.open(file);
  let rest = '';
  const raw = fh.createReadStream({ highWaterMark: 1 << 20 });
  const src = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  src.setEncoding('utf8');
  for await (const chunk of src) {
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
  const closes = readJsonl(dir, 'events.jsonl').filter(e => e.ev === 'closed');
  let ci = 0;
  for await (const f of readFeed(dir)) {
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
