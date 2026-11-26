// Which prediction code and which shared models are actually in use, compared across this
// checkout, a running relay and the public website. Read-only; prints no secrets.
//   node tools/versions.mjs                         this checkout
//   node tools/versions.mjs --relay=http://127.0.0.1:8765 --public
//
// "Page bundle" = SHA-256 over index.html and every script it loads (plus the race worker),
// i.e. the code that makes every prediction in a browser, the recorder's page included.
// Shared models = learned/*.json as published (what browsers may adopt), checked against
// learned/manifest.json. Dynamic, in-session learning in each browser is not a version: it
// starts from these files and adapts locally, and is never published while data/FREEZE exists.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const PUBLIC = 'https://zknfz.github.io/f1/';
const RAW = 'https://raw.githubusercontent.com/zKnfz/f1/main/';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const git = (...a) => { try { return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let fails = 0;
const say = (lvl, what, detail) => { if (lvl === 'FAIL') fails++; console.log(`${lvl.padEnd(5)} ${what.padEnd(24)} ${detail}`); };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"?]+)(\?v=(\d+))?"/g)].map(m => m[1]).filter(f => !/^https?:/.test(f));
const cacheV = html.match(/\?v=(\d+)/)?.[1];
const FILES = ['index.html', ...scripts, 'racesim-worker.js'].filter(f => fs.existsSync(path.join(ROOT, f)));
const bundle = get => { const h = crypto.createHash('sha256'); for (const f of FILES) { const b = get(f); if (b == null) return null; h.update(f + '\0').update(b); } return h.digest('hex').slice(0, 16); };
const localBundle = bundle(f => fs.readFileSync(path.join(ROOT, f)));
const raceVersion = fs.readFileSync(path.join(ROOT, 'racesim.js'), 'utf8').match(/VERSION = '([^']+)'/)?.[1];
const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', ...FILES, 'learned', 'server.mjs', 'recorder.mjs').split('\n').filter(Boolean);

console.log(`checkout ${ROOT}`);
say('INFO', 'code commit', `${head.slice(0, 12)}${git('describe', '--tags', '--exact-match', 'HEAD') ? ' (tag ' + git('describe', '--tags', '--exact-match', 'HEAD') + ')' : ''}`);
say('INFO', 'race model', `${raceVersion} (racesim.js)`);
say('INFO', 'page assets', `v=${cacheV}, bundle ${localBundle} (${FILES.length} files)`);
const dCode = dirty.filter(l => !/ learned\//.test(l)), dLearn = dirty.filter(l => / learned\//.test(l));
dCode.length ? say(fs.existsSync(path.join(ROOT, 'data', 'FREEZE')) ? 'FAIL' : 'WARN', 'uncommitted code', dCode.join(' | ')) : say('PASS', 'working tree', 'prediction code and relay match the commit');
if (dLearn.length) say('INFO', 'local learning', `${dLearn.length} learned/ file(s) updated here, not published (${fs.existsSync(path.join(ROOT, 'data', 'FREEZE')) ? 'frozen' : 'published after validation by the recorder'})`);
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'learned', 'manifest.json'), 'utf8'));
const bad = Object.entries(man.files).filter(([k, v]) => { try { return sha(fs.readFileSync(path.join(ROOT, 'learned', `${k}.json`))) !== v.sha256; } catch { return true; } });
bad.length ? say('WARN', 'shared models (local)', `${bad.map(([k]) => k).join(', ')} differ from learned/manifest.json`) : say('PASS', 'shared models (local)', `${Object.keys(man.files).length} files match learned/manifest.json (validated ${man.validated})`);
const fz = path.join(ROOT, 'data', 'FREEZE');
fs.existsSync(fz) ? say('INFO', 'freeze', `ON: ${fs.readFileSync(fz, 'utf8').split('\n')[0]}`) : say('INFO', 'freeze', 'off (data/FREEZE absent)');

async function fetchBuf(u) { try { const r = await fetch(u, { signal: AbortSignal.timeout(15000), cache: 'no-store' }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; } }
async function remoteBundle(base) {
  const got = {};
  for (const f of FILES) { got[f] = await fetchBuf(base + (f === 'index.html' ? '' : f) + (f === 'index.html' ? '' : `?v=${cacheV}`)); if (!got[f]) got[f] = await fetchBuf(base + f); }
  const missing = FILES.filter(f => !got[f]);
  return { b: missing.length ? null : bundle(f => got[f]), missing, diff: FILES.filter(f => got[f] && sha(got[f]) !== sha(fs.readFileSync(path.join(ROOT, f)))) };
}
const relay = arg('relay');
if (relay) {
  const base = relay.replace(/\/?$/, '/');
  const r = await remoteBundle(base);
  r.b === localBundle ? say('PASS', 'relay page', `${base} serves bundle ${r.b} (same as this checkout)`) : say('FAIL', 'relay page', r.missing.length ? `missing: ${r.missing.join(', ')}` : `differs: ${r.diff.join(', ')}`);
  // The relay's own code (server.mjs, recorder.mjs) is loaded when the process starts: older
  // than the last commit that changed it = still running old code.
  const changed = Number(git('log', '-1', '--format=%ct', '--', 'server.mjs', 'recorder.mjs', 'transport.mjs')) * 1000;
  let started = null;
  try { const h = JSON.parse((await fetchBuf(base + 'api/health')).toString()); if (h.uptimeS != null) started = Date.now() - h.uptimeS * 1000; } catch {}
  if (started == null) say('WARN', 'relay process', 'no uptime in /api/health');
  else started >= changed ? say('PASS', 'relay process', `started ${new Date(started).toISOString().slice(0, 16)}Z, after its code last changed (${new Date(changed).toISOString().slice(0, 16)}Z)`) : say('FAIL', 'relay process', `started ${new Date(started).toISOString().slice(0, 16)}Z, BEFORE its code last changed (${new Date(changed).toISOString().slice(0, 16)}Z): restart it`);
}
if (process.argv.includes('--public')) {
  const r = await remoteBundle(PUBLIC);
  r.b === localBundle ? say('PASS', 'public website', `${PUBLIC} serves bundle ${r.b} (same as this checkout)`) : say('WARN', 'public website', r.missing.length ? `missing: ${r.missing.join(', ')}` : `differs from this checkout: ${r.diff.join(', ')} (GitHub Pages can take a few minutes after a push)`);
  const rm = await fetchBuf(RAW + 'learned/manifest.json');
  if (!rm) say('WARN', 'public shared models', 'could not read the published manifest');
  else {
    const pm = JSON.parse(rm.toString());
    const off = [];
    for (const [k, v] of Object.entries(pm.files)) { const b = await fetchBuf(RAW + `learned/${k}.json`); if (!b || sha(b) !== v.sha256 || man.files[k]?.sha256 !== v.sha256) off.push(k); }
    off.length ? say('WARN', 'public shared models', `differ from this checkout or their manifest: ${off.join(', ')}`) : say('PASS', 'public shared models', `${Object.keys(pm.files).length} published files match their manifest and this checkout`);
  }
}
process.exit(fails ? 1 : 0);
