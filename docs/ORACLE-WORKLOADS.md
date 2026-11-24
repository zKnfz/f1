# Running training and historical replays on the Oracle backend

Question: can the heavy offline work (historical replays through the real page, backtests,
fitting candidates) run on the Oracle VM instead of the Mac, without disturbing live recording
and predictions, and without paying for anything?

Short answer: **yes on every requirement that can be checked without the VM**; the last three
numbers (speed on Oracle's cores, interference with its relay, whether OpenF1 answers from
Oracle's network) need one benchmark run there (step 2 below). Nothing has been enabled.

## What was checked, and how

| Requirement | Answer | Evidence |
|---|---|---|
| Historical replay without F1 live timing | **Yes.** Replays read rebuilt sessions from disk (`data/replays/`), built from OpenF1's public archive. The relay runs in `REPLAY` mode and never contacts F1. | Code: `server.mjs` replay mode, `tools/replay-eval.mjs` (sets `NO_LEARNED=1`, `KALSHI=0`, no F1 TV token). CI on Linux ARM64 fetches one OpenF1 session, rebuilds and replays it while F1 itself refuses that network. |
| Dependencies on Linux ARM64 | **Yes.** The whole toolchain is Node.js (no native modules, no Python) plus Playwright's bundled Chromium, which `install.sh` already installs on the VM for the session recorder. On Linux the harness uses that Chromium (on the Mac, Google Chrome). | CI job `Recorder on Linux ARM64` (GitHub's `ubuntu-24.04-arm`, the same architecture as the VM): tests, replay, training job under systemd. The race simulator gives the **identical** answer on both (golden test, to 1e-12). |
| Moving the datasets | **Yes, cheaply.** All historical data is 449 MB on disk and **43 MB compressed** (OpenF1 31 MB, rebuilt replays 11 MB, Jolpica races 1 MB). Over Tailscale that is seconds. Alternatively the VM fetches it itself (if OpenF1 answers there, see the benchmark), which takes hours because OpenF1's free limit is 30 requests a minute. | `du`, `tar | gzip` on the Mac (24 Nov). |
| Low priority, no interference | **Designed in, to be measured on the VM.** `pitwall-train.service`: `Nice=19`, batch scheduling, `CPUWeight=10`, **at most one core** (`CPUQuota=100%` of the VM's two), idle disk priority, memory capped at 4 GB (soft 3 GB) of 12, first to be killed if memory runs out (`OOMScoreAdjust=900`), one replay at a time. And it only runs **between race weekends** (next row), so it never overlaps a session at all. | Unit file; CI prints the applied limits. On the Mac (busy, 24 Nov) a replay pushed the relay's health answer from 4 ms (p95) to 238 ms: that is why heavy work should not share a machine with a live relay during sessions. |
| Interrupted jobs resume | **Yes.** Every step skips what it already finished: OpenF1 and Jolpica downloads skip files already there; a rebuilt session is marked done by its `meta.json` (written last); each replayed session by its `.done` marker (an unfinished one is replayed again from the start, ~5–10 min). A crash is retried by systemd after 20 min (at most 4 times in 12 h); a stop takes its relays and browser down with it. | Tested on the Mac: stopped mid-step → no leftover processes, lock released, resumes. CI: `kill -9` mid-replay → systemd restarts it → replay finishes, no relay left on a port. |
| Only between race weekends | **Yes.** `tools/train-window.mjs` reads the F1 calendar (Jolpica, the same cached copy the session scheduler uses) and calls a weekend busy from **12 h before its first session to 12 h after its last** (`TRAIN_MARGIN_H`). The job checks before each step and every 30 s; when a weekend gets near it stops what it is doing and exits 75 ("not now"), which the unit treats as normal. The timer starts it nightly at 02:00 UTC; on race weeks it just exits. If the calendar can't be read at all it does not start. | Qatar: busy from 27 Nov 01:30 to 30 Nov 07:50 UTC; quiet again until 3 Dec 21:30 (Abu Dhabi). CI: busy window → exit 75. |
| No paid resources | **Yes.** Runs inside the existing free-tier VM (2 OCPU, 12 GB) and its existing disk; data is ~0.5 GB of the ~42 GB free. Nothing is uploaded to Object Storage by training. | — |

What the job does (`tools/train-job.mjs`, every step resumable):

1. **fetch**: new OpenF1 sessions and Jolpica races of this season;
2. **build**: rebuild new qualifying sessions into replayable recordings;
3. **race**: race backtest of every season, production scores, and a calibration refit (Qatar never fitted);
4. **replay**: every rebuilt qualifying session through the real page, one at a time, at 10×;
5. **score**: qualifying scores and candidate fits.

Results go to `data/train/` (logs, `state.json`, scores, candidates). **Nothing is promoted
automatically**: a candidate only reaches the site through a code change, after a held-out
comparison, never during a race weekend. It also never writes into the repo's tracked files, so
`AUTO_UPDATE`'s `git pull` is never blocked.

## Mac (measured) vs Oracle (to measure)

`tools/bench-workload.mjs` measures the same things on any machine and saves
`data/bench/<host>-<arch>-<time>.json`.

| | Mac (M1, 8 cores, 16 GB) — **measured while overloaded** (load 11, 0.1 GB free, other replays running) | GitHub Linux ARM64 runner (4 cores) — **CI, a stand-in for the architecture, not your VM** | Oracle (2 OCPU Ampere, 12 GB) |
|---|---|---|---|
| Race call, one core (ms per call) | 65 | 30 | run step 3 |
| Race calls per second, all cores | 55 (8 cores, ×3.2) | 129 (4 cores, ×3.8) | |
| One qualifying replay at 40× | 88 s (2023 Qatar *sprint shootout*, 55 min) | 115 s (2023 Qatar *qualifying*, 74 min) | |
| Relay health while replaying, p95 (idle p95) | **238 ms** (4 ms) | **1.7 ms** (3.1 ms), replay at nice 19 | |
| Same race-call answer as the Mac | — | yes (identical) | |
| OpenF1 / Jolpica / F1 live timing | 200 / 200 / 200 | 200 / 200 / **403** (refused; not needed) | |

The Mac figures will be re-measured on the same session once tonight's evaluations finish; the
interference row is the striking one either way: on a loaded Mac the live relay slowed to a quarter
of a second, on the low-priority Linux setup it did not move.
## Steps (yours; I have no access to the VM)

1. **Get the code there**: `sudo -u pitwall git -C /opt/pitwall pull --ff-only`, then
   `sudo bash /opt/pitwall/deploy/oracle/install.sh` with your usual `PITWALL_ROLE=backend`
   (it installs the new unit files and enables nothing).
2. **Copy the datasets** from the Mac (43 MB over Tailscale; replace `<oracle>` with your SSH host):
   ```
   cd ~/f1 && tar -czf - data/openf1 data/races data/replays | ssh <oracle> 'sudo -u pitwall tar -xzf - -C /opt/pitwall'
   ```
3. **Benchmark on Oracle, outside a race weekend** (it refuses during one; read-only for production):
   ```
   sudo -u pitwall bash -c 'set -a; . /etc/pitwall/pitwall.env; cd /opt/pitwall && nice -n 19 node tools/bench-workload.mjs'
   ```
   and send me the saved `data/bench/*.json` (it holds no secrets or addresses).
4. **Decide** with both benchmarks side by side. The rule I'd apply: Oracle if one replay takes less
   than about 3× the Mac's and the relay's p95 stays under ~50 ms while replaying; otherwise keep
   replays on the Mac between weekends and run only the race backtest (CPU only, no browser) on Oracle.
5. **Turn it on** (only if 4 says so): `sudo systemctl enable --now pitwall-train.timer`.
   Check with `systemctl list-timers pitwall-train.timer` and `tail /opt/pitwall/data/train/train.log`.
   Turn off: `sudo systemctl disable --now pitwall-train.timer`.

Not during the Qatar weekend: steps 1–3 can wait until after 30 Nov 07:50 UTC (the benchmark refuses to run before then anyway, without `--force`).
