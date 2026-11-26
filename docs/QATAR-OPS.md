# Qatar 2026: operations (infrastructure, deployment, readiness)

Written 26 Nov 2026 ~17:10 UTC. Evaluation methodology is Grok's and is not covered here.
Legend: **implemented** = in the code; **deployed** = running on that machine; **historical** =
tested on recorded or replayed data; **live** = observed during a real session (none yet for Qatar).

## 1. Production versions (verified 26 Nov, Mac and public site)

| | Value | Where verified |
|---|---|---|
| Code | commit `827a3fa`, tag `qatar-2026` | Mac checkout (`tools/versions.mjs`) |
| Page bundle (all prediction code) | `785d587dbabf7012`, 11 files, assets `v=55` | Mac checkout = Mac relay page = https://zknfz.github.io/f1/ |
| Race model | `race-2026-11-24` (`racesim.js` VERSION) | same |
| Shared learned models | 5 files, manifest validated 2026-11-24T19:57:16Z | published files match their manifest and the checkout |
| Mac relay process | started 16:59Z, after its code last changed | `/api/health` uptime |
| Oracle | **not verified** (unreachable: Tailscale stopped on the Mac; I have no SSH) | run §3 step 3 |

Dynamic predictions (every lap, sector and pole call) and in-browser adaptation (each page
learning within the session from these starting models) are not versions: they continue during
the freeze. What the freeze stops is **publishing**: no `git pull` on Oracle, and no learned/ push
from the Mac. Anything learned stays in the Mac's `learned/` folder, unpublished.

## 2. Freeze

- **Implemented and deployed on the Mac:** `data/FREEZE` exists. `tools/record-and-share.sh` keeps
  learned/ local, and a local pre-commit hook refuses commits that touch page, model or relay
  files (override `FREEZE_OVERRIDE=1`). Recording, the relay and the recorder's page all run on.
- **Implemented, not yet deployed on Oracle:** `tools/server-session.sh` skips `git pull` and
  publishing while `$PITWALL_DATA/FREEZE` exists. It needs commit 827a3fa on Oracle (§3).
- Lift it after **30 Nov 07:50 UTC**: `rm data/FREEZE` (Mac) and `/opt/pitwall/data/FREEZE` (Oracle).

## 3. Your manual steps, in order

1. **Mac power** (it is on battery, 63 %, and sleeps on its own):
   plug it in, then run `sudo pmset -c sleep 0` (optionally `sudo pmset -c standby 0 powernap 0`).
2. **Start Tailscale on the Mac** (menu bar → Connect). It has been **stopped since ~16:33Z**, and
   nothing reaches Oracle until it is back. Then run:
   `tail -3 ~/f1/data/shipper.log` (look for "backend reachable again" and 0 MB waiting), then
   `node tools/ship-verify.mjs` (PASS = Oracle holds exactly as many bytes of every file as the Mac).
3. **Oracle update, freeze, verify** (SSH in):
   ```
   sudo -u pitwall git -C /opt/pitwall fetch --tags
   sudo -u pitwall git -C /opt/pitwall merge --ff-only qatar-2026
   sudo -u pitwall touch /opt/pitwall/data/FREEZE
   sudo sed -i 's/^AUTO_UPDATE=.*/AUTO_UPDATE=0/' /etc/pitwall/pitwall.env; grep -q ^AUTO_UPDATE= /etc/pitwall/pitwall.env || echo AUTO_UPDATE=0 | sudo tee -a /etc/pitwall/pitwall.env
   sudo systemctl restart pitwall-relay pitwall-ingest
   systemctl is-active pitwall-relay pitwall-ingest; systemctl list-timers 'pitwall*'
   sudo -u pitwall bash -c 'set -a; . /etc/pitwall/pitwall.env; cd /opt/pitwall && node tools/verify-deploy.mjs'
   ```
   Expected: the freeze shows PASS; version lines show `827a3fa`, the same bundle and `race-2026-11-24`;
   `pitwall-train.timer` is **not** listed (it is installed, never enabled).
   Restarting ingest is safe: the shipper keeps the data and resumes at ingest's offset.
4. **Backups and storage** (on Oracle):
   `cat /opt/pitwall/data/maintain.json` (the last run has no errors; the Las Vegas folders are in `backedUp`) and
   `sudo -u pitwall rclone size <your remote>` (it must stay under `BACKUP_MAX_GB`=15 GB; the Always Free allowance is 20 GB).
5. **F1 TV sign-in** (expired 26 Nov 06:25Z). Without it you get no car positions or telemetry; timing still works.
   Sign in to F1 TV in a browser, copy the `login-session` cookie value, save it to
   `~/f1/data/f1tv-token.txt` (never commit it), then run
   `launchctl kickstart -k gui/$(id -u)/com.pitwall.relay` and `node tools/verify-deploy.mjs` (the F1 TV line shows PASS).

## 4. Oracle benchmark (today, before 23:30 UTC)

Run it only after step 3 passes. `tools/bench-workload.mjs --guard` (**implemented**, tested on the Mac)
stops the heavy part at once and exits 3 in any of these cases:
- relay `/api/health` or `/events` (live-stream first message) p95 > 50 ms, over the last 30 probes
- available memory < 2 GB
- any production unit's restart count or start time changes
- ingest stops answering
- the deadline passes

It reports:
- replay throughput (× real time)
- record completeness against the Mac's run of the same session (`--expect`) and against OpenF1's timed laps
- the cgroup's memory peak and CPU seconds
- disk use, and network reachability

```
# from the Mac (43 MB):
cd ~/f1 && tar -czf - data/openf1 data/races data/replays | ssh <oracle> 'sudo -u pitwall tar -xzf - -C /opt/pitwall'
# on Oracle, inside the training limits (one core, 4 GB, nice 19, idle IO):
sudo systemd-run --uid=pitwall --gid=pitwall --wait --collect --pipe \
  -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=100% -p MemoryHigh=3G -p MemoryMax=4G \
  -p WorkingDirectory=/opt/pitwall -p EnvironmentFile=/etc/pitwall/pitwall.env \
  /usr/bin/node tools/bench-workload.mjs --force --guard --deadline=2026-11-26T23:30:00Z \
  --replay=data/replays/openf1-9215 --expect=lapEnd:245,proj:506
```
`--force` is needed only because the training window opens at 01:30Z. The quick test takes about 5 min.
Send me `data/bench/*.json` (it holds no secrets or addresses).

**Results so far: none from Oracle.** I could not run it: no SSH, and Tailscale is down.

Mac, measured today with the same guard, **while busy** (load 5, other work running):

| Measurement | Result |
|---|---|
| Race call | 40 ms; 149 calls/s on 8 cores |
| Backtest (4 races) | 0.4 s |
| Replay of 9215 | stopped by the guard at 32 s, when the relay's stream p95 reached 74 ms (health p95 49 ms, max 257 ms; idle 10–16 ms) |

So the guard works, and it confirms again that replays should not share a machine with a live relay.
The completeness check correctly flagged the stopped run (lapEnd 68 of 245).

CI reference (GitHub Linux ARM64, not your VM): replay at 40× in 115 s; relay p95 1.7 ms during it.

Training stays **disabled**. To enable it after Qatar (once the Oracle benchmark passes):
`sudo systemctl enable --now pitwall-train.timer` (docs/ORACLE-WORKLOADS.md).

## 5. Recording reliability (Tailscale disconnects)

Evidence, from existing logs only (`data/shipper.log`, `pmset -g log`, `tailscale status`):
- 283 send failures between 24 and 26 Nov, in 183 outages.
- **182 of 183 outages began within 2 minutes of a Mac sleep/wake (DarkWake) event.** The Mac slept
  45 h of that window (567 sleep entries), on battery with `sleep 1`.
  - Short blips (median 3 s, roughly every 15 min) are DarkWake maintenance wakes: the network comes up before Tailscale reconnects.
  - Long outages (up to 8.3 h on 25 Nov) are real sleep.
- **Cause: the Mac sleeping, not Oracle or the network path.** Fix: §3 step 1 (no networking change needed).
- **Separately, Tailscale is stopped right now** (since ~16:33Z): fix in §3 step 2.

What protects the data, and how far each point is verified:

| | Status |
|---|---|
| No loss during outages | **Implemented; historical (self-test).** The recorder writes to the Mac's disk first; the shipper only copies. The self-test cuts the link, kills ingest and fills the backend's disk; nothing goes missing (`tools/selftest-pipeline.mjs`, 41/41 passed today). |
| Shipper resumes | **Deployed (Mac); seen live.** The log shows "backend reachable again" after each outage on 24–26 Nov. |
| Backlog delivered completely | **Historical** (self-test scenario 7). Live check: `tools/ship-verify.mjs` (new), compares every file's size on Oracle and the Mac. **Not run yet** (Oracle unreachable). |
| Duplicates | **Implemented**: ingest acknowledges an exact or overlapping resend without rewriting it (scenarios 5–6). **Known gap:** if ingest is killed in the instant after writing a chunk but before saving its offset, it accepts that chunk again after the restart. One run of the self-test hit this; I reproduced it on purpose. The result is a duplicated chunk in Oracle's copy only: the Mac's copy is unaffected, nothing is lost, and `ship-verify` shows "MORE". **Not fixed before FP1** (it is a change to production ingest); fix after Qatar. |
| Oracle = collector | `tools/ship-verify.mjs` (sizes, from the Mac) and `tools/ship-latency.mjs` (hash of every chunk from ingest.jsonl, on Oracle or from a copy). **Not run yet.** |
| Backup bug fixed in the deployed version | Fixed in the code (self-test scenario 14 covers the 15 GB cap); **deployment unverified** until §3 steps 3–4. |
| Within Always Free | The cap is 15 GB against a 20 GB allowance; actual use is unverified (§3 step 4). |

## 6. FP1 validation checklist (27 Nov, 13:30 UTC)

The **page** rows read from the page's latency panel (click DELAY):

| Measure | How (existing instrumentation) | Pass |
|---|---|---|
| Source → collector | page: F1 sent → received; after the session `node tools/recording-report.mjs` (F1 send → received P50/P95/P99) | P95 under ~1 s (it includes F1's clock offset) |
| Collector → processing | page: received → processed | P95 < 16 ms |
| Processing → screen | page: received → on screen; main-thread stalls | P95 < 50 ms; few stalls |
| Prediction compute | page: pole call compute, race call turnaround | as before (pole < 10 ms) |
| Mac → Oracle transfer | on Oracle: `node tools/ship-latency.mjs /opt/pitwall/data/rec/<fp1 dir>` | P95 < 2 s; 0 chunks differ |
| Completeness | `recording-report.mjs`: laps seen against F1's lap count, missed-update checks, gaps over 15 s | complete, 0 differences |
| Interruptions | `recording-report.mjs` (connection drops); `data/shipper.log` (send failed / reachable again); `pmset -g log \| grep -i sleep` (must be empty during the session) | no sleep; drops recovered |
| Oracle = Mac | `node tools/ship-verify.mjs` after the session | PASS |
| CPU and memory | Mac: `top -l 1 -o cpu \| head -15` mid-session; Oracle: `systemctl status pitwall-relay pitwall-ingest` (memory), `uptime` | relay < 1 core; free memory > 2 GB |
| Storage | `df -h ~` (Mac), `df -h /opt/pitwall` (Oracle) | > 10 GB free |
| Backup | Oracle `maintain.json` after the next maintenance run | FP1 folder in `backedUp`, no errors |
| First upstream connection | `recording-report.mjs`: frames per connection and "first with N of M updates" (each update goes to whichever of the 3 connections delivers it first) | report which connection wins most |

Gaps (not measurable today; I have not invented numbers for them):
- the delay from the relay to a public visitor's screen (visitors connect to F1 directly, and their pages report nothing back);
- Oracle CPU over time (no metrics agent: only a point sample);
- a single end-to-end trace ID across Mac → Oracle → page (each hop has its own clock).

## 7. After Qatar (plan; not to be deployed during the weekend)

1. **Ingest crash-window fix** (§5): at load, rebuild offsets from the .gz plus the plain file and cut a tail that has no saved offset, with a self-test that kills ingest between the two writes.
2. **Event-driven page updates**: batch pole alerts at 100 ms, refresh panels at 250 ms, and recompute the race call on a 5 s cadence (or when something material changes) instead of per message.
3. **Dedup before parse** in the relay: the `seen` check already uses the raw text. Move it ahead of `JSON.parse` so duplicate copies from the 3 connections cost no parsing.
4. **Pole Monte Carlo in a worker**, like the race call, so a qualifying burst cannot stall the main thread.
5. **Long-tail stalls**: use the latency panel's main-thread stalls and loop-lag rows to find the >50 ms tasks; the target is P99 < 50 ms.
6. **End-to-end instrumentation**: carry F1's `sentAt` and the collector receipt time through to the page's "on screen" stamp, and have the recorder's page report P50/P95 into page.jsonl, so every session leaves a latency record.
7. **Mac power and link watchdog**: verify-deploy WARNs (already) and the shipper logs a "Mac slept" note when an outage matches a wake event.
8. **Enable `pitwall-train.timer`** if the Oracle benchmark passes (§4).

Each one ships only with a before/after measurement on a replay, and outside a race weekend.

## 8. Long-term architecture

- **Collector (Mac):** only connects to F1 (3 connections, first copy wins), writes to its disk and forwards to Oracle. No heavy work while a session is live.
- **Oracle:** the archive (recording, compaction, backups within Always Free), historical replay, training and evaluation, and **validated** model publication: candidates are published only after a held-out comparison and never during a race weekend, as versioned files with a manifest.
- **Public visitors:** keep connecting to F1 directly from their browsers (the lowest latency, and no redistribution of raw authenticated telemetry). They download only the static site and the versioned models from GitHub Pages: **no Oracle hop** on the live path.
