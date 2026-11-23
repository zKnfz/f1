// Compresses finished recordings and, if set up, copies them off the machine; frees space.
//   node tools/compact-recordings.mjs                 compress sessions untouched for 2 h, back up, check space
//   node tools/compact-recordings.mjs --force <dir>   compress one folder now (tests)
// Compression: each file's lines are gzipped and appended to <file>.gz (a valid multi-part gzip),
// written to a temporary file, synced and renamed into place, checked by reading it back, and
// only then is the plain file removed. A crash at any point leaves the recording complete.
// Backup (optional): RCLONE_REMOTE=name:bucket/path in the environment (rclone must be set up
// on this machine; its credentials stay in rclone's own config, never in this repo). A folder
// is marked backed up only after `rclone check` confirms every file arrived.
// Space: when free space drops below MIN_FREE_PCT (default 15), the oldest folders that are
// compressed AND backed up are removed locally. Nothing that isn't backed up is ever deleted.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.PITWALL_DATA || path.join(ROOT, 'data'));
const REC = path.join(DATA, 'rec');
const FILES = ['feed.tsv', 'events.jsonl', 'page.jsonl', 'kalshi.jsonl'];
const IDLE_MS = 2 * 3600e3, MIN_FREE = Number(process.env.MIN_FREE_PCT) || 15;
const REMOTE = process.env.RCLONE_REMOTE || '';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const lines = s => s ? s.split('\n').filter(Boolean).length : 0;

export function compactFolder(dir) {
  let moved = 0;
  for (const name of FILES) {
    const plain = path.join(dir, name), gz = plain + '.gz';
    if (!fs.existsSync(plain)) continue;
    const raw = fs.readFileSync(plain, 'utf8');
    if (!raw) { fs.unlinkSync(plain); continue; }
    // A line cut off by a crash is kept as it is (readers skip it) but ended, so the next
    // part of the archive starts on a line of its own.
    const text = raw.endsWith('\n') ? raw : raw + '\n';
    const old = fs.existsSync(gz) ? fs.readFileSync(gz) : Buffer.alloc(0);
    const before = old.length ? lines(zlib.gunzipSync(old).toString('utf8')) : 0;
    const tmp = gz + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, old); fs.writeSync(fd, zlib.gzipSync(text, { level: 6 })); fs.fsyncSync(fd); fs.closeSync(fd);
    const after = lines(zlib.gunzipSync(fs.readFileSync(tmp)).toString('utf8'));
    if (after !== before + lines(text)) { fs.unlinkSync(tmp); throw new Error(`${dir}/${name}: check failed (${after} vs ${before}+${lines(text)}), left uncompressed`); }
    fs.renameSync(tmp, gz);
    fs.unlinkSync(plain);
    moved += lines(text);
  }
  return moved;
}
const newest = dir => Math.max(...fs.readdirSync(dir).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
const compacted = dir => !FILES.some(f => fs.existsSync(path.join(dir, f)));
const marker = dir => path.join(dir, '.backed-up.json');
const signature = dir => fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort().map(f => `${f}:${fs.statSync(path.join(dir, f)).size}`).join(',');
const backedUp = dir => { try { return JSON.parse(fs.readFileSync(marker(dir), 'utf8')).signature === signature(dir); } catch { return false; } };

async function current() { // the folder the relay is writing to now, never touched
  try { const r = await fetch(`http://127.0.0.1:${process.env.PORT || 8765}/api/recording`, { signal: AbortSignal.timeout(3000) }); return (await r.json()).recording?.dir || null; } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--force') { log('compressed', compactFolder(path.resolve(process.argv[3])), 'lines'); process.exit(0); }
  const status = { at: new Date().toISOString(), compressed: [], backedUp: [], removed: [], errors: [] };
  const active = await current();
  const dirs = fs.existsSync(REC) ? fs.readdirSync(REC).map(d => path.join(REC, d)).filter(d => fs.statSync(d).isDirectory()) : [];
  for (const d of dirs) {
    if (d === active || Date.now() - newest(d) < IDLE_MS || compacted(d)) continue;
    try { const n = compactFolder(d); status.compressed.push(path.basename(d)); log('compressed', path.basename(d), n, 'lines'); }
    catch (e) { status.errors.push(e.message); log(e.message); }
  }
  if (REMOTE) for (const d of dirs) {
    if (d === active || !fs.existsSync(d) || !compacted(d) || backedUp(d)) continue;
    const dest = `${REMOTE.replace(/\/$/, '')}/${path.basename(d)}`;
    try {
      execFileSync('rclone', ['copy', d, dest, '--exclude', '.backed-up.json'], { stdio: 'pipe', timeout: 3600e3 });
      execFileSync('rclone', ['check', d, dest, '--one-way', '--exclude', '.backed-up.json'], { stdio: 'pipe', timeout: 3600e3 });
      fs.writeFileSync(marker(d), JSON.stringify({ at: new Date().toISOString(), remote: dest, signature: signature(d) }));
      status.backedUp.push(path.basename(d)); log('backed up', path.basename(d), '→', dest);
    } catch (e) { status.errors.push(`backup ${path.basename(d)}: ${String(e.stderr || e.message).slice(0, 300)}`); log('backup failed', path.basename(d), String(e.stderr || e.message).slice(0, 300)); }
  }
  const freePct = () => { const s = fs.statfsSync(DATA); return 100 * s.bavail / s.blocks; };
  status.freePctBefore = +freePct().toFixed(1);
  const removable = dirs.filter(d => fs.existsSync(d) && d !== active && compacted(d) && backedUp(d)).sort((a, b) => newest(a) - newest(b));
  while (freePct() < MIN_FREE && removable.length) {
    const d = removable.shift(); fs.rmSync(d, { recursive: true, force: true });
    status.removed.push(path.basename(d)); log('removed local copy (backed up):', path.basename(d));
  }
  status.freePct = +freePct().toFixed(1);
  status.notBackedUp = dirs.filter(d => fs.existsSync(d) && !backedUp(d)).map(d => path.basename(d));
  status.backupConfigured = !!REMOTE;
  fs.writeFileSync(path.join(DATA, 'maintain.json'), JSON.stringify(status, null, 1));
  if (freePct() < MIN_FREE) log(`LOW SPACE: ${freePct().toFixed(1)}% free and nothing more can be removed safely`);
  if (status.errors.length) process.exitCode = 1;
}
