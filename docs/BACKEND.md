# Always-on backend: design, evidence, operations

Status 2026-11-23: built and tested end to end with a stand-in F1 feed (Mac and GitHub's
Linux ARM64). **Not deployed. The Oracle services stay disabled** until you approve.
How to deploy: [deploy/README.md](../deploy/README.md).

## 1. The 403: evidence and assumptions

`tools/f1-net-preflight.mjs` sends the same requests from any machine and records who answers
each one: F1's CDN (`Server: CloudFront`, CloudFront error page) or F1's application
(`Server: Kestrel`).

| Network | Static file `/static/StreamingStatus.json` | SignalR Core negotiate | Answered by |
|---|---|---|---|
| Home Mac | 200 | 200 (`NO_SESSION`: works, no session live) | CDN serves the file; **Kestrel** answers negotiate |
| GitHub Actions, Azure, Linux ARM64 | **403** | **403** | **CloudFront** error page (`X-Cache: Error from cloudfront`) for every request, including the static file |
| Oracle VM, us-chicago-1 | not yet measured by the tool | 403 (your earlier test) | **unknown: run the tool there** |

**Established (evidence):**

- From a datacenter network (GitHub/Azure), the 403 comes from **CloudFront, before F1's
  application**. A plain static JSON file, which needs no sign-in and no SignalR, is refused
  the same way. So the refusal is about the network the request comes from, not about the
  request, the protocol, or any token.
- The same code and the same requests work from the home network.
- `www.formula1.com` itself answers 200 from GitHub, so it isn't a general DNS or outbound
  network failure.

**Assumed (not proven):**

- Oracle is refused for the same reason (a CDN rule against cloud and datacenter address
  ranges). This is very likely, but only the preflight run on the VM will show
  `answeredBy=cdn` for Oracle.
- That this rule is deliberate and will stay. We have no statement from F1.

**Therefore:**

- Moving the F1 TV token to Oracle can't help: the 403 happens before anything looks at a token.
- Changing Oracle region, IP or user agent to get around it would be an attempt to defeat an
  access restriction, so the design doesn't do it.
- The connection to F1 has to come from a network F1 accepts. That is the collector.

**To close the gap, on the VM:**

```bash
node /opt/pitwall/tools/f1-net-preflight.mjs
```

It reads no secrets. Paste the verdict line here.

## 2. Architecture

```
F1 ─(SignalR Core over WSS)─► collector relay ─► data/rec/<s>/feed.tsv  (fsync ≤5 s; the spool)
                                                  │ shipper.mjs: ≤1 MB line-aligned chunks,
                                                  │ HMAC-signed, one in flight, resumes at the
                                                  ▼ backend's byte offset
            Tailscale/WireGuard or SSH tunnel (encrypted, never a public port)
                                                  ▼
Oracle: ingest.mjs ─► data/rec/<s>/feed.tsv (identical bytes; fsync before ack) + ingest.jsonl
        server.mjs FOLLOW=1 ─► same handleFrame as a direct connection ─► SSE to pages
        record.mjs (session timer) ─► headless Chromium page ─► backend-page.jsonl (predictions, model versions)
        Kalshi ─► backend-kalshi.jsonl · health (2 min) · compaction + rclone backup (hourly)
```

Main choices and their reasons:

- **The collector's recording files are the queue.** There is no second buffer to lose or fill
  up: a backlog is bytes on the collector's disk, sent in order once the backend is reachable.
  Ordering and exactly-once delivery come from byte offsets:
  - A repeat is acknowledged without being written.
  - An overlap is written only from where the backend's copy ends.
  - A gap is refused with the offset the backend needs (409).
  - The backend keeps how much it holds in `.ingest.json`, saved to disk after the data.
- **The backend holds an identical byte copy**, so replay, reports, datasets and the
  self-tests work on it unchanged. Its own outputs go in `backend-*.jsonl` and never mix into
  the collector's files.
- **Same code path for live state.** FOLLOW mode feeds each received line to the relay's
  normal frame handler. The page and the models can't tell this apart from a direct
  connection, and the test checks the page state against a replay.
- **Latency:** the collector writes every frame immediately, and the shipper polls every
  250 ms (20 ms when busy). The relay on the backend reads new lines every 100 ms. The added
  delay is roughly 0.1–0.5 s plus the network trip. Bets placed from the home Mac should still
  use the Mac's own relay or a direct connection, which is the fastest path. The backend is
  for always-on recording and predictions, not the fastest screen.

### Time semantics (no look-ahead)

Each recorded byte carries up to three times:

1. **Event time:** F1's own timestamp inside the frame.
2. **Knowledge time:** when the collector received it (`feed.tsv` column 1). The replay,
   `stateAt` and the datasets use this.
3. **Backend ingestion time:** in `ingest.jsonl`, per byte range.

`tools/build-dataset.mjs` builds training rows where every feature has a knowledge time at or
before the row's cutoff. Labels carry their own `knownAt`. A unit test builds a recording where
a personal best arrives 1 ms after a sector and checks that the row doesn't see it.

Each dataset's manifest records the SHA-256 of every source file, the code commit and the
rules. Model versions in use are recorded live (`kind: models` / `registry` records), so a
prediction can be traced back to its model, and the model to its training data.

## 3. Security

- Ingest has no public port.
  - It binds to 127.0.0.1 (SSH tunnel with a key that can only forward to that port) or a
    Tailscale address.
  - It refuses to start on a public address.
  - No Oracle firewall change is needed for either option.
- Every request is signed with HMAC-SHA256.
  - The signature covers the collector id, the time, the method, the path with its query
    (directory, file, offset) and the SHA-256 of the body.
  - Requests outside a ±5 min window are refused, and signatures are compared in constant time.
  - The secret is 32 random bytes in `/etc/pitwall/ingest-secret` (root:pitwall 640) and
    `data/ingest-secret` on the collector (600). It is never in git and never logged.
- Inputs are checked:
  - directory names against the recorder's naming pattern, which blocks paths like `..`
  - file names against a fixed list
  - whole lines only, no NUL bytes
  - every feed line must match the recording format
  - bodies up to 16 MB
  - 507 when the backend disk is low, so the collector keeps the data
- The F1 TV token stays on the collector. The heartbeat sends only `valid/expired/missing`
  and the expiry date; a test checks that no token-shaped string is in it.
- The systemd units run as the `pitwall` user with `NoNewPrivileges`, `ProtectSystem=strict`
  and write access to `data/` only. The relay still listens on 127.0.0.1 only.

## 4. What the tests prove (`tools/selftest-pipeline.mjs`)

These are real processes: a stand-in F1 feed, the collector relay, the shipper, a TCP link the
test can cut, ingest, the FOLLOW relay and headless Chromium. Results: 45/45 checks on macOS
arm64 (rclone not installed); **46/46 on GitHub's Linux ARM64** with rclone (run 45297191887).

| # | Scenario | Result |
|---|---|---|
| 1 | Normal ingestion | Backend copy byte-identical (or an exact prefix while F1 is still sending); FOLLOW relay live |
| 2 | Collector SIGKILL + restart | Identical copies. Only the updates F1 sent while the collector was down are missing, and they are recorded as a gap in capture, not as lost in transit |
| 3 | Ingest SIGKILL for 4 s | Caught up, identical |
| 4 | Network cut 8 s | Shipper notices and keeps the data on disk; backlog delivered, identical |
| 5 | Duplicates | Exact repeat acknowledged, not written; overlap writes only the new part |
| 6 | Out of order / bad requests | Gap → 409 with the needed offset; wrong secret, 10-min-old request, `../`, unknown file, partial line, bad feed line, 17 MB body → all refused |
| 7 | Buffer exhaustion | 34 MB spooled during an outage, delivered in 3 s (Mac) / 11 s (Linux ARM64), shipper 68–89 MB memory; backend "disk full" → 507, collector keeps everything, delivered after |
| 8 | Compression | Backend copy gzipped, same state; late data appended after the .gz with offsets kept |
| 9 | Replay | Page state on the backend = replayed state; state from the backend copy = from the collector copy |
| 10 | Prediction consistency | Race model in the backend's headless page matches the golden reference (≤2.2e-16) |
| 11 | Model version persistence | Model versions and parameters recorded in `backend-page.jsonl` |
| 12 | Missing telemetry auth | Heartbeat says `missing`, timing keeps flowing, backend health warns explicitly, no token in the heartbeat |
| 13 | VM reboot (all killed at once) | All four restart; backend relay rebuilds the session from its copy |
| 14 | Backup integrity | rclone copy + `rclone check`, restore → identical state (runs where rclone is installed: CI) |

Unit tests (`tests/core.test.mjs`) cover the signature (tampered offset, body, secret or time
→ refused), directory validation, and the no-look-ahead dataset rule.

## 5. Backup and disaster recovery

| Copy | Where | When |
|---|---|---|
| 1 | Collector `data/rec/` (never compressed or deleted automatically) | Live |
| 2 | Backend `data/rec/` | Seconds behind |
| 3 | Object storage via rclone (Oracle Object Storage Always Free 20 GB, or Cloudflare R2) | Hourly, after a session goes idle for 2 h; verified with `rclone check` |

- Local copies on the backend are removed only when they are backed up and verified, and
  only when disk is below `MIN_FREE_PCT`. A removed folder's received-byte counts are kept
  in `data/ingest-archive/`, so a collector that restarts doesn't resend the whole session.
- **Lose the VM:**
  1. New VM.
  2. `PITWALL_ROLE=backend install.sh`, then restore `/etc/pitwall/*`.
  3. `rclone copy <remote> /opt/pitwall/data/rec`.
  4. The collector resends anything newer, because it asks the backend what it holds.
- **Lose the collector:** the backend and the backup still have everything up to the last
  acknowledgement (seconds). Any new machine on an accepted network becomes the collector.
- **Lose both during a session:** what F1 sent in that window was never captured. The
  recording shows the gap, and nothing claims otherwise.
- **Never back up `/etc/pitwall/ingest-secret` to object storage.** If it's lost, generate a
  new one and put it on both machines.
- **Restore drill:** test 14 does exactly this each CI run. Do it by hand once after setting
  `RCLONE_REMOTE`: `rclone copy <remote>/<session> /tmp/r/<session>`, then
  `node tools/replay-state.mjs /tmp/r/<session>`.

## 6. Manual actions (yours; nothing below has been done)

1. On the VM: `node /opt/pitwall/tools/f1-net-preflight.mjs` → paste the verdict here.
2. Decide on the collector machine.
   - The Mac works only while awake and logged in.
   - A Raspberry Pi or home Linux box is the 24/7 option.
   - Run the preflight on it.
3. Tailscale on both machines (recommended), or the restricted SSH tunnel user (deploy/README.md §3).
4. On the VM:
   - `git pull`
   - `sudo PITWALL_ROLE=backend bash deploy/oracle/install.sh`
   - edit `/etc/pitwall/pitwall.env` (FOLLOW, PAGE_URL, INGEST_HOST)
5. Copy `/etc/pitwall/ingest-secret` to the collector over SSH (or `scp`). Don't put it in
   chat or git.
6. Optional: rclone remote for backups (Object Storage: create a bucket and a Customer Secret
   Key; both are Always Free within limits).
7. Approve and enable the services (deploy/README.md §4).
8. F1 TV sign-in on the collector. **The current token expires 2026-11-26 06:25 UTC; Qatar FP1
   is 2026-11-27 13:30 UTC.** Renew it before then.

## 7. Working vs unverified

**Working (tested here):**
- the whole collector → backend pipeline and all 14 failure scenarios, with a stand-in feed
- install on Linux ARM64
- restart after kill -9 under systemd
- FOLLOW state identical to replay
- models identical in the backend's page
- no-look-ahead datasets

**Unverified:**
- The Oracle 403 cause (see §1).
- A real F1 session through the pipeline. The first will be Qatar if the collector is up.
- Whether the Oracle VM can reach Kalshi's API (health will say).
- The Tailscale and SSH tunnel steps on your machines.
- rclone against real Oracle Object Storage or R2.
- Real session sizes, and so how many seasons fit in 20 GB. There are no full real recordings
  here yet.
- The ingest systemd unit on the real VM. CI runs it under systemd on Ubuntu 24.04 ARM64
  (localhost only, unsigned request refused, restart after kill -9), but not on your VM.

**Honest limits:**
- 24/7 needs an always-on collector at home (or another accepted network). With only the
  Mac, the backend records only while the Mac is awake.
- No design can recover what F1 sent while no collector was connected.
