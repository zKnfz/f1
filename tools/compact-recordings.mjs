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
const FILES = ['feed.tsv', 'events.jsonl', 'page.jsonl', 'kalshi.jsonl', 'backend-events.jsonl', 'backend-page.jsonl', 'backend-kalshi.jsonl', 'ingest.jsonl'];
const IDLE_MS = 2 * 3600e3, MIN_FREE = Number(process.env.MIN_FREE_PCT) || 15;
const REMOTE = process.env.RCLONE_REMOTE || '';
// A collector never compresses or removes: the shipper reads its files by byte offset, and its
// copy is the fallback until the backend's copy is backed up. It only reports space.
const COLLECTOR = process.env.PITWALL_ROLE === 'collector';
// Never let backups grow past this (GB) on the remote: Oracle Object Storage is free up to
// 20 GB in total, so the default leaves room. A folder that would cross it is not uploaded
// (it stays local and is reported), never anything deleted remotely to make room.
const MAX_GB = Number(process.env.BACKUP_MAX_GB ?? 15);
const dirBytes = d => fs.readdirSync(d, { recursive: true }).reduce((s, f) => { const st = fs.statSync(path.join(d, f)); return s + (st.isFile() ? st.size : 0); }, 0);
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
  if (COLLECTOR) {
    const s = fs.statfsSync(DATA), pct = 100 * s.bavail / s.blocks;
    fs.writeFileSync(path.join(DATA, 'maintain.json'), JSON.stringify({ ...status, role: 'collector', freePct: +pct.toFixed(1), note: 'collector: nothing compressed or removed' }, null, 1));
    if (pct < MIN_FREE) log(`LOW SPACE on the collector: ${pct.toFixed(1)}% free; move old data/rec folders off after checking the backend has them`);
    process.exit(0);
  }
  const dirs = fs.existsSync(REC) ? fs.readdirSync(REC).map(d => path.join(REC, d)).filter(d => fs.statSync(d).isDirectory()) : [];
  for (const d of dirs) {
    if (d === active || Date.now() - newest(d) < IDLE_MS || compacted(d)) continue;
    try { const n = compactFolder(d); status.compressed.push(path.basename(d)); log('compressed', path.basename(d), n, 'lines'); }
    catch (e) { status.errors.push(e.message); log(e.message); }
  }
  let remoteBytes = null;
  if (REMOTE) {
    try { remoteBytes = JSON.parse(execFileSync('rclone', ['size', REMOTE, '--json'], { stdio: 'pipe', timeout: 600e3 }).toString()).bytes; }
    catch (e) { status.errors.push(`backup: could not measure ${REMOTE}: ${String(e.stderr || e.message).slice(0, 200)}`); }
    status.backupGB = remoteBytes == null ? null : +(remoteBytes / 1e9).toFixed(3);
    status.backupMaxGB = MAX_GB;
  }
  if (REMOTE && remoteBytes != null) for (const d of dirs) {
    if (d === active || !fs.existsSync(d) || !compacted(d) || backedUp(d)) continue;
    const dest = `${REMOTE.replace(/\/$/, '')}/${path.basename(d)}`;
    const size = dirBytes(d);
    if ((remoteBytes + size) / 1e9 > MAX_GB) {
      status.errors.push(`backup limit: ${path.basename(d)} (${(size / 1e6).toFixed(0)} MB) not uploaded; remote holds ${(remoteBytes / 1e9).toFixed(2)} GB of BACKUP_MAX_GB=${MAX_GB}`);
      log('backup limit reached, not uploading', path.basename(d)); continue;
    }
    try {
      execFileSync('rclone', ['copy', d, dest, '--exclude', '.backed-up.json'], { stdio: 'pipe', timeout: 3600e3 });
      execFileSync('rclone', ['check', d, dest, '--one-way', '--exclude', '.backed-up.json'], { stdio: 'pipe', timeout: 3600e3 });
      fs.writeFileSync(marker(d), JSON.stringify({ at: new Date().toISOString(), remote: dest, signature: signature(d) }));
      remoteBytes += size;
      status.backedUp.push(path.basename(d)); log('backed up', path.basename(d), '→', dest);
    } catch (e) { status.errors.push(`backup ${path.basename(d)}: ${String(e.stderr || e.message).slice(0, 300)}`); log('backup failed', path.basename(d), String(e.stderr || e.message).slice(0, 300)); }
  }
  const freePct = () => { const s = fs.statfsSync(DATA); return 100 * s.bavail / s.blocks; };
  status.freePctBefore = +freePct().toFixed(1);
  const removable = dirs.filter(d => fs.existsSync(d) && d !== active && compacted(d) && backedUp(d)).sort((a, b) => newest(a) - newest(b));
  while (freePct() < MIN_FREE && removable.length) {
    const d = removable.shift();
    // Backend: keep how much of each file was received, so a collector that restarts does not
    // send the whole session again (ingest.mjs reads this when the folder is gone).
    const held = path.join(d, '.ingest.json');
    if (fs.existsSync(held)) { fs.mkdirSync(path.join(DATA, 'ingest-archive'), { recursive: true }); fs.copyFileSync(held, path.join(DATA, 'ingest-archive', path.basename(d) + '.json')); }
    fs.rmSync(d, { recursive: true, force: true });
    status.removed.push(path.basename(d)); log('removed local copy (backed up):', path.basename(d));
  }
  status.freePct = +freePct().toFixed(1);
  status.notBackedUp = dirs.filter(d => fs.existsSync(d) && !backedUp(d)).map(d => path.basename(d));
  status.backupConfigured = !!REMOTE;
  fs.writeFileSync(path.join(DATA, 'maintain.json'), JSON.stringify(status, null, 1));
  if (freePct() < MIN_FREE) log(`LOW SPACE: ${freePct().toFixed(1)}% free and nothing more can be removed safely`);
  if (status.errors.length) process.exitCode = 1;
}
