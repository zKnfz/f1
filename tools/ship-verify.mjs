// Does the backend hold every byte the collector recorded? Read-only on both sides: for each
// recording folder here it asks the backend's ingest (signed, with the shipper's own key) how
// many bytes it holds of each file, and compares with this machine's copy.
//   node tools/ship-verify.mjs            (uses the shipper's settings: SHIP_URL, SHIP_ID, key file)
// Equal sizes = complete: ingest only ever appends at the exact offset it reports, refuses
// gaps, partial lines and malformed feed lines, and writes a duplicate once (tools/selftest-
// pipeline.mjs scenarios 5–6), so the same size means the same bytes in the same order.
// A file still growing (a session on now) shows the last few seconds as in flight.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { APPEND_FILES, WHOLE_FILES, DIR_RE, readSecret, sign } from '../transport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Settings as the shipper has them (launchd plist on the Mac, env file on Linux).
let env = { ...process.env };
if (!env.SHIP_URL) try {
  const x = execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(process.env.HOME, 'Library/LaunchAgents/com.pitwall.shipper.plist')], { encoding: 'utf8' });
  env = { ...JSON.parse(x).EnvironmentVariables, ...env };
} catch {}
const DATA = path.resolve(env.PITWALL_DATA || path.join(ROOT, 'data'));
const URL_ = (env.SHIP_URL || '').replace(/\/$/, ''), ID = env.SHIP_ID;
if (!URL_ || !ID) { console.error('SHIP_URL / SHIP_ID not found (run where the shipper runs)'); process.exit(2); }
const SECRET = readSecret(env.INGEST_SECRET_FILE || path.join(DATA, 'ingest-secret'));
const REC = path.join(DATA, 'rec');

async function state(dir) {
  const pq = `/v1/state?dir=${encodeURIComponent(dir)}`;
  const r = await fetch(URL_ + pq, { headers: { Authorization: sign(SECRET, ID, 'GET', pq, undefined) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()).files || {};
}
let bad = 0, ok = 0, total = 0;
try { await fetch(URL_ + '/healthz', { signal: AbortSignal.timeout(8000) }); }
catch (e) { console.log(`FAIL  backend not reachable at ${URL_} (${e.cause?.code || e.message}): is Tailscale up on both machines?`); process.exit(1); }
for (const d of fs.readdirSync(REC).filter(d => DIR_RE.test(d)).sort()) {
  let held;
  try { held = await state(d); } catch (e) { console.log(`FAIL  ${d}: backend state unavailable (${e.message})`); bad++; continue; }
  for (const f of [...APPEND_FILES, ...WHOLE_FILES]) {
    const p = path.join(REC, d, f);
    if (!fs.existsSync(p)) continue;
    const here = fs.statSync(p).size, there = typeof held[f] === 'object' ? held[f]?.bytes ?? held[f]?.size : held[f];
    total += here;
    if (there === here) { ok++; continue; }
    bad++;
    console.log(`${there == null ? 'MISS' : there < here ? 'BEHIND' : 'MORE'}  ${d}/${f}: here ${here} bytes, backend ${there ?? 'nothing'}${there != null && there < here ? ` (${here - there} not delivered yet)` : ''}`);
  }
}
console.log(`${bad ? 'FAIL' : 'PASS'}  ${ok} file(s) identical in size on the backend, ${bad} not; ${(total / 1e6).toFixed(2)} MB recorded here`);
process.exit(bad ? 1 : 0);
