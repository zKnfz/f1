// Checks every file in learned/ before it is shared with the public site, and writes
// learned/manifest.json (what was checked, each file's SHA-256, the code it was checked with).
// Everyone who opens the site adopts these files, so a broken or leaky one must never go out.
//   node tools/validate-learned.mjs            exit 1 (and no manifest) if anything fails
//   node tools/validate-learned.mjs --check    same, without writing the manifest
//
// Refused: unknown file kinds, bad JSON, keys not matching the file name, non-finite or
// out-of-range numbers, a lap model whose solved weights are implausible, files over 1 MB,
// and anything that looks private: tokens (JWTs), secrets, keys, e-mail or IP addresses,
// raw car telemetry or positions (Position.z / CarData.z, which need an F1 TV sign-in and are
// not ours to redistribute), or raw feed frames.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.LEARNED_DIR || path.join(ROOT, 'learned');
const fin = x => typeof x === 'number' && Number.isFinite(x);
const allFinite = v => Array.isArray(v) ? v.every(allFinite) : v && typeof v === 'object' ? Object.values(v).every(allFinite) : typeof v === 'number' ? Number.isFinite(v) : true;
const FORBIDDEN = [
  [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'a token (JWT)'],
  [/subscriptionToken|login-session|ingest-secret|Authorization|BEGIN [A-Z ]*PRIVATE KEY/i, 'a credential'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, 'an e-mail address'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IP address'],
  [/Position\.z|CarData\.z|"Entries"\s*:|"Channels"\s*:/, 'raw car positions or telemetry'],
  [/"target"\s*:\s*"feed"|invocationId/, 'raw feed frames'],
];

// Solve the lap model's weights the way the page does (prior pull omitted: the raw fit is the
// stricter test), to catch a model that would push projections to the clip limits.
function solve(A, b) {
  const n = 6, M = A.map(r => r.slice()), v = b.slice();
  for (let i = 0; i < n; i++) M[i][i] += 15 * [1, 0.02, 0.15, 0.1, 0.8, 1][i] ** 2;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; v[r] -= f * v[c]; }
  }
  return v.map((x, i) => x / M[i][i]);
}
const KINDS = [
  [/^pitwall-model-v4-[\w]+-(quali|race|other)$/, d => {
    if (!(Array.isArray(d.A) && d.A.length === 6 && d.A.every(r => Array.isArray(r) && r.length === 6))) return 'A is not 6×6';
    if (!(Array.isArray(d.b) && d.b.length === 6)) return 'b is not 6 long';
    if (!Number.isInteger(d.laps) || d.laps < 0) return 'laps';
    const th = solve(d.A, d.b);
    if (!th || !th.every(fin)) return 'weights cannot be solved';
    if (Math.abs(th[0]) > 0.05 || Math.abs(th[1]) > 2 || th.slice(2).some(x => Math.abs(x) > 0.2)) return `implausible weights ${th.map(x => x.toFixed(4)).join(',')}`;
  }],
  [/^pitwall-model-v3-[\w]+-(quali|race|other)$/, () => 'v3 lap models are no longer read by the page; remove the file'],
  [/^pitwall-calib-v1$/, d => (Array.isArray(d.pts) && d.pts.every(p => Array.isArray(p) && p.length === 2 && p[0] >= 0 && p[0] <= 1 && (p[1] === 0 || p[1] === 1)) ? null : 'pts must be [chance 0–1, 0|1]')],
  [/^pitwall-score-v1-\d+$/, d => (Array.isArray(d.laps) && d.laps.every(l => (l.ch == null || (l.ch >= 0 && l.ch <= 1)) && (l.err == null || Math.abs(l.err) < 60)) ? null : 'laps must hold chances 0–1 and errors under 60 s')],
  [/^pitwall-qpace-\d+$/, d => (d.best && Object.values(d.best).every(t => fin(t) && t > 50 && t < 200) ? null : 'best laps must be 50–200 s')],
  [/^pitwall-race-v1$/, d => (Array.isArray(d.laps) && d.laps.every(l => l.p && Object.values(l.p).every(a => Array.isArray(a) && a.every(x => x >= 0 && x <= 1))) ? null : 'race calls must be chances 0–1')],
  [/^pitwall-pole-v1$/, d => (Array.isArray(d.laps) ? null : 'laps must be a list')],
];

export function validate(dir = DIR) {
  const problems = [], files = {};
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json' && f !== 'manifest.json');
  for (const f of names) {
    const key = f.replace(/\.json$/, ''), raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const bad = m => problems.push(`${f}: ${m}`);
    if (raw.length > 1e6) { bad('over 1 MB'); continue; }
    for (const [re, what] of FORBIDDEN) if (re.test(raw)) bad(`contains ${what}`);
    let d; try { d = JSON.parse(raw); } catch { bad('not JSON'); continue; }
    if (d.key != null && d.key !== key) bad(`key ${d.key} does not match the file name`);
    if (!allFinite(d)) bad('non-finite number');
    const kind = KINDS.find(([re]) => re.test(key));
    if (!kind) { bad('unknown kind of file'); continue; }
    const why = kind[1](d); if (why) bad(why);
    files[key] = { sha256: crypto.createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
  }
  // index.json tells the page how much each file holds; it must list exactly these files.
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    for (const k of Object.keys(idx.files || {})) if (!files[k] && !problems.some(p => p.startsWith(k + '.json'))) problems.push(`index.json lists ${k}, which is missing`);
  } catch { problems.push('index.json missing or not JSON'); }
  return { problems, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, files } = validate();
  if (problems.length) { console.log('NOT shareable:\n  ' + problems.join('\n  ')); process.exit(1); }
  let commit = null; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch {}
  if (!process.argv.includes('--check')) fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify({ validated: new Date().toISOString(), validator: 'validate-learned-1', codeCommit: commit, files }, null, 1) + '\n');
  console.log(`ok: ${Object.keys(files).length} files shareable`);
}
