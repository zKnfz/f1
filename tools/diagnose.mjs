// Checks how F1's live timing answers from this machine, and saves the result to
// learned/diagnose.json. Used to find out why the recorder cannot connect from GitHub.
import fs from 'node:fs/promises';
const out = { at: new Date().toISOString(), node: process.version };
const brief = async r => ({ status: r.status, server: r.headers.get('server'), via: r.headers.get('via'), cf: r.headers.get('cf-ray'), type: r.headers.get('content-type'), body: (await r.text()).slice(0, 300) });
const tryFetch = async (name, url, init) => { try { out[name] = await brief(await fetch(url, { signal: AbortSignal.timeout(20000), ...init })); } catch (e) { out[name] = { error: String(e.cause?.code || e.message) }; } };
await tryFetch('ip', 'https://api.ipify.org?format=json');
await tryFetch('home', 'https://livetiming.formula1.com/');
await tryFetch('negotiate', 'https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1', { method: 'POST' });
await tryFetch('negotiateBrowserLike', 'https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', origin: 'https://www.formula1.com' } });
if (typeof WebSocket !== 'undefined') {
  out.websocket = await new Promise(res => {
    const ws = new WebSocket('wss://livetiming.formula1.com/signalrcore');
    const t = setTimeout(() => { res({ result: 'timeout' }); ws.close(); }, 20000);
    ws.onopen = () => { ws.send('{"protocol":"json","version":1}\x1e'); ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [['SessionInfo']], invocationId: '0' }) + '\x1e'); };
    ws.onmessage = e => { if (String(e.data).includes('"type":3')) { clearTimeout(t); res({ result: 'ok', got: String(e.data).slice(0, 120) }); ws.close(); } };
    ws.onerror = e => { clearTimeout(t); res({ result: 'error', message: String(e.message || e.error?.message || 'error') }); };
    ws.onclose = e => { clearTimeout(t); res({ result: 'closed', code: e.code, reason: e.reason }); };
  });
} else out.websocket = { result: 'no WebSocket in this Node' };
await fs.mkdir('learned', { recursive: true });
await fs.writeFile('learned/diagnose.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
