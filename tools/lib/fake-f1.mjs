// A stand-in for F1's SignalR Core feed, for tests only (no internet). Speaks just enough of the
// protocol for the relay: negotiate, the WebSocket handshake, the subscribe snapshot, and a
// stream of updates. Every update carries a sequence number (LapCount.CurrentLap) so tests can
// tell exactly which updates reached the disk.
import http from 'node:http';
import crypto from 'node:crypto';
const RS = '\x1e';

export async function startFakeF1({ everyMs = 50, session = {}, drivers = ['1', '4', '16'] } = {}) {
  let seq = 0, timer = null, down = false;
  const sockets = new Set();
  const SESSION = { Key: 99901, Name: 'Selftest', Type: 'Race', StartDate: '2026-01-01T12:00:00', Meeting: { Name: 'Selftest GP', Location: 'Nowhere' }, ...session };
  const snapshot = () => ({ SessionInfo: SESSION, SessionStatus: { Status: 'Started' }, LapCount: { CurrentLap: seq, TotalLaps: 1e6 },
    DriverList: Object.fromEntries(drivers.map((n, i) => [n, { RacingNumber: n, Tla: ['VER', 'NOR', 'LEC', 'PIA', 'HAM'][i] || 'D' + n }])),
    TimingData: { Lines: Object.fromEntries(drivers.map((n, i) => [n, { Position: String(i + 1), NumberOfLaps: seq }])) } });
  const send = (sock, text) => {
    const p = Buffer.from(text), n = p.length;
    const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
    try { sock.write(Buffer.concat([head, p])); } catch {}
  };
  const server = http.createServer((req, res) => {
    if (down) { res.writeHead(503); return res.end(); }
    if (req.url.startsWith('/signalrcore/negotiate')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ connectionToken: crypto.randomUUID(), negotiateVersion: 1 })); }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, sock) => {
    if (down) return sock.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 128; if (buf.length < off + (masked ? 4 : 0) + len) break;
        const mask = masked ? buf.subarray(off, off + 4) : null; off += masked ? 4 : 0;
        const p = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        buf = buf.subarray(off + len);
        if (op === 8) { sockets.delete(sock); sock.end(); return; }
        for (const m of p.toString().split(RS)) {
          if (m.includes('"protocol"')) send(sock, '{}' + RS);
          if (m.includes('"Subscribe"')) { send(sock, JSON.stringify({ type: 3, invocationId: '0', result: snapshot() }) + RS); sockets.add(sock); }
        }
      }
    });
    sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sockets.delete(sock));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const emit = (extra = '') => {
    seq++;
    const n = drivers[seq % drivers.length], at = new Date().toISOString();
    const msg = JSON.stringify({ type: 1, target: 'feed', arguments: ['LapCount', { CurrentLap: seq }, at] }) + RS
      + JSON.stringify({ type: 1, target: 'feed', arguments: ['TimingData', { Lines: { [n]: { NumberOfLaps: seq } }, ...(extra ? { Note: extra } : {}) }, at] }) + RS;
    for (const s of sockets) send(s, msg);
  };
  timer = setInterval(() => emit(), everyMs);
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seq: () => seq,
    // A burst of large updates (to build a backlog quickly): `n` updates of `bytes` each.
    burst(n, bytes) { const pad = 'x'.repeat(bytes); for (let i = 0; i < n; i++) emit(pad); },
    // F1 itself unreachable: drop every connection and refuse new ones.
    setDown(v) { down = v; if (v) for (const s of sockets) s.destroy(); },
    stopUpdates() { clearInterval(timer); },
    close() { clearInterval(timer); for (const s of sockets) s.destroy(); server.close(); },
  };
}
