// Collector → backend transport, shared by shipper.mjs (collector) and ingest.mjs (Oracle).
//
// What travels: the collector's recording files themselves (data/rec/<session>/feed.tsv etc.),
// appended in order, byte for byte. The backend ends up with an identical copy, so everything
// that works on a recording (replay, reports, datasets) works on the backend's copy unchanged.
//
// Each request is signed: HMAC-SHA256 over the collector id, a timestamp, the method, the path
// with its query and the SHA-256 of the body, with a secret both sides hold in a file
// (never in git, never logged). Requests older or newer than 5 minutes are refused. The channel
// itself is also meant to be private and encrypted (Tailscale/WireGuard or an SSH tunnel): the
// ingest port is never opened to the internet.
//
// Delivery is idempotent and ordered: an append names the byte offset it starts at; the backend
// keeps how many bytes of each file it holds and only ever appends at that point. A repeat is
// acknowledged without writing; a gap is refused with the offset it needs (409).
import crypto from 'node:crypto';
import fs from 'node:fs';

export const PROTOCOL = 1;
export const APPEND_FILES = ['feed.tsv', 'events.jsonl', 'page.jsonl', 'kalshi.jsonl'];
export const WHOLE_FILES = ['meta.json'];
export const MAX_BODY = 16 * 1024 * 1024;   // a single F1 snapshot frame can be ~1 MB
export const SKEW_MS = 5 * 60 * 1000;
// Session folders as recorder.mjs names them, plus frames kept before a session was known.
export const DIR_RE = /^(?:[0-9]{4}-[a-z0-9-]{1,140}-[0-9]{1,8}|_unsessioned\/[0-9]{4}-[0-9]{2}-[0-9]{2})$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function readSecret(file) {
  const s = fs.readFileSync(file, 'utf8').trim();
  if (s.length < 32) throw new Error(`secret in ${file} is too short (need 32+ characters, e.g. openssl rand -hex 32)`);
  return s;
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
export function sign(secret, id, method, pathWithQuery, body = Buffer.alloc(0), ts = Date.now()) {
  const mac = crypto.createHmac('sha256', secret).update(`${PROTOCOL}\n${id}\n${ts}\n${method}\n${pathWithQuery}\n${sha(body)}`).digest('hex');
  return `Pitwall ${id}:${ts}:${mac}`;
}
// Returns the collector id, or throws with the reason.
export function verify(secret, header, method, pathWithQuery, body, now = Date.now()) {
  const m = /^Pitwall ([a-z0-9-]{1,32}):(\d{13}):([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) throw new Error('missing or malformed authorization');
  const [, id, ts, mac] = m;
  if (Math.abs(now - Number(ts)) > SKEW_MS) throw new Error(`clock difference over 5 min (${Math.round((now - Number(ts)) / 1000)} s)`);
  const want = crypto.createHmac('sha256', secret).update(`${PROTOCOL}\n${id}\n${ts}\n${method}\n${pathWithQuery}\n${sha(body)}`).digest();
  if (!crypto.timingSafeEqual(want, Buffer.from(mac, 'hex'))) throw new Error('bad signature');
  return id;
}
