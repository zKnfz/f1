// Collector side: sends this machine's recordings (data/rec/) to the backend as they grow.
//
//   SHIP_URL=http://127.0.0.1:8770 SHIP_ID=home-pi INGEST_SECRET_FILE=data/ingest-secret node shipper.mjs
//
// The recording files ARE the spool: the relay writes them to disk first (fsync every 5 s), and
// this only reads them. If the backend or the network is down, nothing is lost: the files keep
// growing here and are sent, in order, when the backend is back (from the byte offset the
// backend says it holds, so a restart of either side resumes exactly). One request in flight,
// at most ~1 MB each, so memory stays small however big the backlog.
// It never deletes or compresses anything here; keep the collector's copy until the backend's
// copy is backed up.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { APPEND_FILES, WHOLE_FILES, MAX_BODY, DIR_RE, readSecret, sign } from './transport.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const REC = path.join(DATA, 'rec');
const URL_ = (process.env.SHIP_URL || '').replace(/\/$/, '');
const ID = process.env.SHIP_ID || os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
const SECRET = readSecret(process.env.INGEST_SECRET_FILE || path.join(DATA, 'ingest-secret'));
const CHUNK = Number(process.env.SHIP_CHUNK) || 1024 * 1024;
const RELAY = `http://127.0.0.1:${process.env.PORT || 8765}`;
if (!URL_) throw new Error('SHIP_URL is not set');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cursor = new Map();   // `${dir}/${file}` -> bytes the backend holds
const metaHash = new Map(); // dir -> sha of meta.json last sent
const status = { id: ID, started: new Date().toISOString(), lastAckAt: null, lastError: null, sentBytes: 0, backlogBytes: 0, backlogFiles: 0 };
let backoff = 0;

async function call(method, pathQ, body = Buffer.alloc(0)) {
  const r = await fetch(URL_ + pathQ, { method, body: method === 'GET' ? undefined : body, headers: { Authorization: sign(SECRET, ID, method, pathQ, body), 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(60000) });
  let j = {}; try { j = await r.json(); } catch {}
  return { code: r.status, j };
}
const q = o => '?' + new URLSearchParams(o).toString();

function sessionDirs() {
  const out = [];
  const add = (rel) => { const full = path.join(REC, rel); try { out.push({ rel, full, mtime: fs.statSync(full).mtimeMs }); } catch {} };
  if (!fs.existsSync(REC)) return out;
  for (const d of fs.readdirSync(REC)) {
    if (d === '_unsessioned') { for (const day of fs.readdirSync(path.join(REC, d))) add(`${d}/${day}`); continue; }
    if (DIR_RE.test(d)) add(d);
  }
  // The session being recorded now first, then any backlog, oldest first.
  out.sort((a, b) => b.mtime - a.mtime);
  return [out[0], ...out.slice(1).reverse()].filter(Boolean);
}

// Next piece of a file to send: from the backend's offset, whole lines only, up to CHUNK
// (a single longer line is sent whole, up to MAX_BODY).
async function nextChunk(file, from, size) {
  const fh = await fsp.open(file, 'r');
  try {
    let want = Math.min(size - from, CHUNK);
    for (;;) {
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, from);
      const last = buf.subarray(0, bytesRead).lastIndexOf(10);
      if (last >= 0) return buf.subarray(0, last + 1);
      if (from + bytesRead >= size) return null;           // a line still being written
      if (want >= MAX_BODY) throw new Error(`line longer than ${MAX_BODY} bytes in ${file} at ${from}`);
      want = Math.min(size - from, want * 4, MAX_BODY);
    }
  } finally { await fh.close(); }
}

async function shipOnce() {
  let backlog = 0, files = 0, did = false;
  for (const d of sessionDirs()) {
    for (const name of APPEND_FILES) {
      const f = path.join(d.full, name);
      let size; try { size = fs.statSync(f).size; } catch { continue; }
      const key = `${d.rel}/${name}`;
      if (!cursor.has(key)) { // ask the backend what it already holds
        const r = await call('GET', '/v1/state' + q({ dir: d.rel }));
        if (r.code !== 200) throw new Error(`state ${r.code} ${r.j.error || ''}`);
        for (const n of APPEND_FILES) cursor.set(`${d.rel}/${n}`, r.j.files?.[n] || 0);
      }
      let at = cursor.get(key);
      if (at > size) { log(`backend holds more of ${key} (${at}) than exists here (${size}); not resending`); continue; }
      if (at === size) continue;
      backlog += size - at; files++;
      const chunk = await nextChunk(f, at, size);
      if (!chunk) continue;
      const r = await call('POST', '/v1/append' + q({ dir: d.rel, file: name, offset: at }), chunk);
      if (r.code === 200 || r.code === 409) { cursor.set(key, r.j.have); status.lastAckAt = new Date().toISOString(); if (r.code === 200) status.sentBytes += chunk.length; did = true; }
      else throw new Error(`append ${key}@${at}: ${r.code} ${r.j.error || ''}`);
    }
    for (const name of WHOLE_FILES) {
      const f = path.join(d.full, name);
      let body; try { body = fs.readFileSync(f); } catch { continue; }
      const h = crypto.createHash('sha256').update(body).digest('hex');
      if (metaHash.get(d.rel) === h) continue;
      const r = await call('PUT', '/v1/file' + q({ dir: d.rel, file: name }), body);
      if (r.code !== 200) throw new Error(`put ${d.rel}/${name}: ${r.code} ${r.j.error || ''}`);
      metaHash.set(d.rel, h); did = true;
    }
  }
  status.backlogBytes = backlog; status.backlogFiles = files;
  return did;
}

// The collector's own health, sent to the backend (which does the alerting) every 15 s.
async function heartbeat() {
  let relay = null; try { relay = await (await fetch(`${RELAY}/api/health`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
  // The F1 TV sign-in: only whether there is one and when it runs out, never the token.
  let token = { state: 'missing' };
  try {
    let t = fs.readFileSync(path.join(DATA, 'f1tv-token.txt'), 'utf8').trim();
    try { t = JSON.parse(decodeURIComponent(t))?.data?.subscriptionToken || t; } catch {}
    const exp = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000;
    token = { state: exp > Date.now() ? 'valid' : 'expired', expiresAt: new Date(exp).toISOString() };
  } catch {}
  const body = Buffer.from(JSON.stringify({ sentAt: Date.now(), platform: `${process.platform}-${process.arch}`, node: process.version, shipper: status, relay, token }));
  const r = await call('POST', '/v1/heartbeat', body);
  if (r.code === 200 && r.j.serverTime) status.clockOffsetMs = r.j.serverTime - Date.now(); // rough: includes the trip time
}

const writeStatus = () => { try { fs.writeFileSync(path.join(DATA, 'shipper-status.json'), JSON.stringify(status, null, 1)); } catch {} };
let lastBeat = 0, stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });
log(`shipping ${REC} to ${URL_} as ${ID}`);
while (!stopping) {
  try {
    if (Date.now() - lastBeat > 15000) { lastBeat = Date.now(); await heartbeat(); }
    const busy = await shipOnce();
    if (backoff) log('backend reachable again'); backoff = 0; status.lastError = null;
    writeStatus();
    await sleep(busy ? 20 : 250);
  } catch (e) {
    status.lastError = `${new Date().toISOString()} ${e.cause?.code || e.message}`;
    backoff = Math.min(30000, backoff ? backoff * 2 : 1000);
    if (backoff >= 1000) log(`send failed (${e.cause?.code || e.message}); retrying in ${backoff / 1000} s, ${(status.backlogBytes / 1e6).toFixed(1)} MB waiting`);
    cursor.clear(); // re-ask the backend where it is, in case it restarted
    writeStatus();
    await sleep(backoff);
  }
}
writeStatus();
log('stopped');
