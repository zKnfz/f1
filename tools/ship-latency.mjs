// Collector → backend: how late each recorded line reached the backend, and whether the bytes
// are identical. Read-only. Uses the backend's ingest.jsonl (one entry per append: arrival time,
// offset, length, SHA-256 of the bytes written) and a copy of the recording.
//   on the backend:   node tools/ship-latency.mjs /opt/pitwall/data/rec/<dir>
//   on the collector: node tools/ship-latency.mjs data/rec/<dir> --ingest=<copy of the backend's ingest.jsonl>
// The second form proves the collector's bytes are the ones the backend stored (every chunk's
// hash must match), as well as giving the delays.
// Delay per line = backend arrival (its clock) − collector receipt (the line's first field, the
// collector's clock); both machines keep NTP time, so expect a few ms of clock error.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const dir = path.resolve(process.argv[2] || '');
const ingestArg = process.argv.find(a => a.startsWith('--ingest='))?.slice(9);
const ingestFile = ingestArg || path.join(dir, 'ingest.jsonl');
if (!fs.existsSync(ingestFile)) { console.error(`no ${ingestFile}: run on the backend, or pass --ingest=<copy>`); process.exit(2); }
const readAll = f => { const gz = path.join(dir, f + '.gz'), raw = path.join(dir, f); return Buffer.concat([fs.existsSync(gz) ? zlib.gunzipSync(fs.readFileSync(gz)) : Buffer.alloc(0), fs.existsSync(raw) ? fs.readFileSync(raw) : Buffer.alloc(0)]); };
const entries = fs.readFileSync(ingestFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
let bad = 0, checked = 0;
const delays = [], chunkDelays = [];
const files = {};
for (const e of entries) {
  const buf = files[e.file] ??= readAll(e.file);
  if (e.offset + e.len > buf.length) { console.log(`SHORT ${e.file}: backend wrote up to ${e.offset + e.len}, this copy has ${buf.length}`); bad++; continue; }
  const piece = buf.subarray(e.offset, e.offset + e.len);
  checked++;
  if (crypto.createHash('sha256').update(piece).digest('hex') !== e.sha256) { bad++; if (bad < 5) console.log(`DIFF  ${e.file} bytes ${e.offset}–${e.offset + e.len}: not what the backend stored`); }
  if (e.file !== 'feed.tsv') continue;
  let first = null;
  for (const line of piece.toString().split('\n')) { const t = +line.split('\t')[0]; if (t > 1e12) { delays.push(e.at - t); first ??= t; } }
  if (first) chunkDelays.push(e.at - first);
}
const s = a => a.length ? `P50 ${pct(a, 0.5)} ms · P95 ${pct(a, 0.95)} · P99 ${pct(a, 0.99)} · max ${pct(a, 1)} (${a.length})` : 'none';
console.log(`${path.basename(dir)}: ${entries.length} appends`);
console.log(`  bytes: ${checked} chunks checked against the backend's hashes, ${bad} differ${bad ? '  ← FAIL' : ' (identical)'}`);
console.log(`  collector receipt → backend, per feed line:   ${s(delays)}`);
console.log(`  oldest line in each delivery (worst case):    ${s(chunkDelays)}`);
const neg = delays.filter(d => d < 0).length; if (neg) console.log(`  note: ${neg} negative delays = clocks differ by up to ${-Math.min(...delays)} ms`);
process.exit(bad ? 1 : 0);
