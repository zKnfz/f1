// Backend ingest (Oracle): receives a collector's recording files and keeps an identical copy in
// data/rec/<session>/, durably, before acknowledging. See transport.mjs for the protocol.
//
//   INGEST_SECRET_FILE=/etc/pitwall/ingest-secret INGEST_HOST=127.0.0.1 node ingest.mjs
//
// Endpoints (all signed, except /healthz):
//   POST /v1/append?dir=&file=&offset=   bytes of feed.tsv / events.jsonl / page.jsonl / kalshi.jsonl
//   PUT  /v1/file?dir=&file=meta.json    replace a small whole file
//   GET  /v1/state?dir=                  bytes held per file (the collector resumes from here)
//   POST /v1/heartbeat                   the collector's own health (JSON, kept in data/collectors/)
//   GET  /healthz                        liveness for the local health check (no details)
// Every acknowledged append is noted in <session>/ingest.jsonl with the backend's receipt time,
// so each byte has three times: F1's (inside the frame), the collector's, and the backend's.
// Only ever listens on a private address (localhost behind an SSH tunnel, or a Tailscale IP).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APPEND_FILES, WHOLE_FILES, MAX_BODY, DIR_RE, ID_RE, readSecret, verify } from './transport.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const REC = path.join(DATA, 'rec');
const HOST = process.env.INGEST_HOST || '127.0.0.1';
const PORT = Number(process.env.INGEST_PORT) || 8770;
const MIN_FREE_GB = Number(process.env.INGEST_MIN_FREE_GB ?? 2);
const SECRET = readSecret(process.env.INGEST_SECRET_FILE || path.join(DATA, 'ingest-secret'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!/^(127\.|10\.|100\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fd)/.test(HOST) && process.env.INGEST_ALLOW_PUBLIC !== '1')
  throw new Error(`refusing to listen on ${HOST}: use localhost (SSH tunnel) or a private/Tailscale address`);

// How many bytes of each file we hold: kept in <session>/.ingest.json, the authority even after
// compaction has moved older lines into .gz (so offsets never restart at 0).
const held = new Map(); // dir -> { files: { name: bytes } }
function stateOf(dir) {
  if (!held.has(dir)) {
    let s = { files: {} };
    try { s = JSON.parse(fs.readFileSync(path.join(REC, dir, '.ingest.json'), 'utf8')); } catch {}
    held.set(dir, s);
  }
  return held.get(dir);
}
function saveState(dir) {
  const f = path.join(REC, dir, '.ingest.json'), tmp = f + '.tmp';
  const fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, JSON.stringify(held.get(dir))); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(tmp, f);
}
// One write at a time per file, in order.
const locks = new Map();
const locked = (key, fn) => { const p = (locks.get(key) || Promise.resolve()).then(fn, fn); locks.set(key, p.catch(() => {})); return p; };

let latestAt = 0;
function noteLatest(dir) { // for the relay in FOLLOW mode: which session is being received now
  const now = Date.now();
  if (now - latestAt < 1000 && latest === dir) return;
  latestAt = now; latest = dir;
  fs.writeFileSync(path.join(DATA, 'ingest-latest.json'), JSON.stringify({ dir, at: new Date(now).toISOString() }));
}
let latest = null;
const stats = { started: new Date().toISOString(), appends: 0, duplicates: 0, gaps: 0, bytes: 0, refused: 0, lastAppendAt: null, collectors: {} };

async function append(dir, file, offset, body, collector) {
  return locked(`${dir}/${file}`, async () => {
    const st = stateOf(dir), have = st.files[file] || 0;
    if (offset > have) { stats.gaps++; return { code: 409, body: { have, error: 'gap: send from `have`' } }; }
    const end = offset + body.length;
    if (end <= have) { stats.duplicates++; return { code: 200, body: { have, duplicate: true } }; }
    const fresh = body.subarray(have - offset);
    const d = path.join(REC, dir);
    await fsp.mkdir(d, { recursive: true });
    const fh = await fsp.open(path.join(d, file), 'a');
    try { await fh.write(fresh); await fh.sync(); } finally { await fh.close(); }
    st.files[file] = end;
    saveState(dir);
    await fsp.appendFile(path.join(d, 'ingest.jsonl'), JSON.stringify({ at: Date.now(), collector, file, offset: have, len: fresh.length, sha256: crypto.createHash('sha256').update(fresh).digest('hex') }) + '\n');
    stats.appends++; stats.bytes += fresh.length; stats.lastAppendAt = new Date().toISOString();
    if (file === 'feed.tsv') noteLatest(dir);
    return { code: 200, body: { have: end } };
  });
}

function freeGB() { try { const s = fs.statfsSync(DATA); return s.bavail * s.bsize / 1e9; } catch { return Infinity; } }

const server = http.createServer(async (req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz' && req.method === 'GET') return reply(200, { ok: true, ...stats, freeGB: +freeGB().toFixed(2) });
  // Read the body with a hard size limit before anything else.
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) { stats.refused++; req.resume(); return reply(413, { error: 'too large' }); }
  const chunks = []; let size = 0;
  try {
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(c); }
  } catch { stats.refused++; return reply(413, { error: 'too large' }); }
  const body = Buffer.concat(chunks);
  let collector;
  try { collector = verify(SECRET, req.headers.authorization, req.method, url.pathname + url.search, body); }
  catch (e) { stats.refused++; log('refused:', e.message, req.socket.remoteAddress); return reply(401, { error: e.message }); }
  if (!ID_RE.test(collector)) return reply(400, { error: 'bad collector id' });
  const dir = url.searchParams.get('dir'), file = url.searchParams.get('file');
  try {
    if (url.pathname === '/v1/append' && req.method === 'POST') {
      const offset = Number(url.searchParams.get('offset'));
      if (!DIR_RE.test(dir || '') || !APPEND_FILES.includes(file) || !Number.isSafeInteger(offset) || offset < 0) return reply(400, { error: 'bad dir, file or offset' });
      if (!body.length || body[body.length - 1] !== 10) return reply(422, { error: 'body must be whole lines' });
      if (body.includes(0)) return reply(422, { error: 'NUL byte' });
      if (file === 'feed.tsv') { // every line starts "receivedMs \t monotonic \t connection \t"
        for (const line of body.toString('utf8').split('\n')) if (line && !/^\d{13}\t[\d.]+\t[\w-]{1,16}\t/.test(line)) return reply(422, { error: 'feed line not in recording format', line: line.slice(0, 80) });
      }
      if (freeGB() < MIN_FREE_GB) { log('refusing appends: disk nearly full'); return reply(507, { error: 'backend disk nearly full; keep spooling' }); }
      const r = await append(dir, file, offset, body, collector);
      (stats.collectors[collector] ??= {}).lastAppendAt = new Date().toISOString();
      return reply(r.code, r.body);
    }
    if (url.pathname === '/v1/file' && req.method === 'PUT') {
      if (!DIR_RE.test(dir || '') || !WHOLE_FILES.includes(file) || body.length > 1e6) return reply(400, { error: 'bad dir or file' });
      try { JSON.parse(body.toString('utf8')); } catch { return reply(422, { error: 'not JSON' }); }
      const d = path.join(REC, dir); await fsp.mkdir(d, { recursive: true });
      const f = path.join(d, file), tmp = f + '.tmp';
      const fh = await fsp.open(tmp, 'w'); try { await fh.write(body); await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(tmp, f);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/v1/state' && req.method === 'GET') {
      if (!DIR_RE.test(dir || '')) return reply(400, { error: 'bad dir' });
      return reply(200, { files: stateOf(dir).files });
    }
    if (url.pathname === '/v1/heartbeat' && req.method === 'POST') {
      if (body.length > 65536) return reply(413, { error: 'too large' });
      let hb; try { hb = JSON.parse(body.toString('utf8')); } catch { return reply(422, { error: 'not JSON' }); }
      await fsp.mkdir(path.join(DATA, 'collectors'), { recursive: true });
      const rec = { receivedAt: Date.now(), collector, ...hb };
      await fsp.writeFile(path.join(DATA, 'collectors', `${collector}.json`), JSON.stringify(rec, null, 1));
      (stats.collectors[collector] ??= {}).lastHeartbeatAt = new Date().toISOString();
      return reply(200, { ok: true, serverTime: Date.now() });
    }
    return reply(404, { error: 'not found' });
  } catch (e) { log('error:', e.stack || e.message); return reply(500, { error: 'internal error' }); }
});
server.requestTimeout = 60000;
server.maxConnections = 16;
fs.mkdirSync(REC, { recursive: true });
server.listen(PORT, HOST, () => log(`ingest listening on ${HOST}:${PORT}, writing to ${REC}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('stopping'); server.close(); setTimeout(() => process.exit(0), 200); });
