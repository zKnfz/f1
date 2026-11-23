# Pitwall architecture and audit

Last updated: 23 Nov 2026 (after the Las Vegas GP, before Qatar; recording added, section 8).
Everything below was checked in the code or measured; nothing is estimated unless it says so.

## 1. How data flows today

```
F1 live timing (SignalR Core, wss://livetiming.formula1.com/signalrcore)
 ├─ GitHub site (direct.js): the browser connects to F1 itself. No intermediary.
 │    Position.z / CarData.z only with the viewer's own F1 TV sign-in (browser storage).
 └─ Local relay (server.mjs, 127.0.0.1:8765): connects to F1, rebroadcasts to the page by SSE,
      records lap history (data/session-*.json). One extra local hop.

page (index.html): emit() → state merge → table redraw in a microtask (same tick)
   ├─ engineer.js: projections, pole call, race call, panels (250 ms timer; Lap times and
   │   Driver tabs redraw on the next frame for the drivers being watched)
   ├─ racesim-worker.js: race Monte Carlo, off the main thread (new, see 4)
   ├─ alerts.js: on-page alerts, sound
   ├─ latency.js: measured latency, P50/P95/P99 (new, see 4)
   └─ kalshi-web.js → Cloudflare Worker (worker/kalshi-worker.js) → Kalshi public REST
        (the relay instead polls Kalshi itself in kalshi.mjs and records to data/kalshi-*.jsonl)
```

The recorder (tools/record.mjs via launchd, every 15 min) starts the relay 25 min before each
session, keeps a headless page open, and shares what was learned to learned/*.json.

## 2. What the models do

| Thing | Where | How |
|---|---|---|
| Lap projection (qualifying) | engineer.js `liveLap`, `lapInputs` | Sectors done + this driver's best for the sectors left, adjusted by a small learned linear model (`theta`, features from mini-sectors, speed traps, tyres) plus a per-driver nudge, clipped to −2%…+15%. Learns online from every lap recorded. |
| Pole / top-of-part chance | engineer.js `poleCall` | 3000 seeded Monte Carlo runs. Cars on a lap: Normal(projection, `projSigma`) weighted by flag risk. Cars not on a lap: chance of another run from the session clock and pit status, pace from best sectors × recent lap/sector ratio + tyre cost. Only this part's times count. |
| Race chances | racesim.js | 4000 seeded runs: pace from clean laps shrunk towards field and quali pace, tyre wear, stops owed (two-compound rule, tyre life), safety car and retirement chances, overtaking margin. Logistic correction per market, before and after the start, then rescaled to 1/3/5/10. |
| Practice | — | No predictions yet. |
| Kalshi | kalshi.mjs, kalshi-web.js | Public REST, top of book only (yes bid, yes ask, last), every 1.5 s. Shown as the bid/ask midpoint under each chance. |

Accuracy so far: race call on 48 races (2024–25, fitted on one season, tested on the other)
log loss 0.6012 (was 0.6054 before this week), calibration within a few points in most bands.
Pole call: tracked per session in the page (few sessions, too early to judge).

## 3. What works and should be kept

Direct connection from the browser (no hop); the microtask table redraw; the mini-sector lap
projection and its online learning; seeded (non-flickering) Monte Carlo for pole and race;
the race calibration and backtest; the recorder and shared learning; alerts; the Kalshi
recorder (relay) and Worker (site).

## 4. Latency: measured before and after

Benchmark: `node server.mjs` then `node tools/bench-pipeline.mjs`. Headless Chrome, mid-race
state, 400 timing updates replayed through the page's real entry point at ~40/s, then the 5-s
timers left to run as live. Times in ms, monotonic clock.

| | Before | After |
|---|---|---|
| Race call on the main thread | P50 45.2 · max 47.6 | P50 0.4 · max 0.6 |
| Main-thread stalls > 50 ms during the replay | 1 (54 ms, the race call) | 0 |
| Update received → processed (handlers + table) | P50 1.9 · P99 2.6 | P50 1.6 · P99 2.6 |
| Update received → next frame | P50 9.3 · P99 16.8 | P50 10.2 · P99 16.6 |
| Race call in the worker (off the page) | — | P50 39 · P95 44 |

Reading it: an update is on screen within one frame (≤ 17 ms) either way; what changed is
that no update can now be held up by the race Monte Carlo (it used to block for ~45–55 ms
every 5 s). The worker returns bit-identical results (checked by the benchmark and a test).

Not yet measured live (needs a session): F1 → received, the pole call's compute time, Kalshi
fetch times. The page now records all of these; click DELAY in the header during a session.

Remaining latency sources, in order:
1. Kalshi prices are polled every 1.5 s. Kalshi's WebSocket pushes changes, but it needs an
   API key even for public data. A key limited to market data can stream prices and the
   full order book and cannot trade. It would live only on the relay (data/, not committed).
2. Pole call runs on the main thread per sector batch (100 ms batching in alerts). Expected a
   few ms; to be measured in Qatar qualifying before deciding to move it to the worker.
3. Track map redraws every frame (~2 ms/frame measured). Could skip unchanged frames.
4. Engineer panels other than Lap times/Driver redraw on a 250 ms timer.
5. Relay vs direct: the relay adds a local hop (expected sub-millisecond; not yet measured).

## 5. Model weaknesses found

- Race: tyre life was a fixed table; a car on old tyres late in a race was treated as certain to
  stop (Antonelli, Las Vegas: 0% top 5 from P2 with 5 laps left). Fixed 22 Nov.
- Race: markets corrected separately could break win ≤ top 3 ≤ top 5 ≤ top 10 (2 of 100 rows at
  Las Vegas, up to 2.3 points). Fixed 23 Nov (pool-adjacent averaging; also improved log loss).
- Race backtest uses assumed tyres (the Ergast data has no compounds); real tyre data exists
  only for sessions the recorder has captured.
- Qualifying: the lap projection has no explicit track-evolution term, and the pole call's
  calibration has not been measured over many sessions. No historical replay of qualifying yet.
- No practice model.
- Recorder lost 19% of qualifying laps (lap counter lag); fixed 22 Nov.

## 6. Kalshi integration weaknesses

Polling instead of push; top of book only (no depth, no NO side); midpoint shown rather than
the executable ask/bid; no fee estimate; no record of how long a gap stayed open. Market
settlement rules have not been checked market by market against what the site models (e.g.
classified finish vs. running at the end).

## 7. Plan (in order)

0. Latency (done this phase): instrumentation, race call off the main thread, benchmark.
1. Qualifying: projection momentum (projected position and pole chance through the lap, shown
   on the Projected tab), explanations for each change, clear states (on a lap / aborted /
   deleted / completed / no data), and a replay of recorded qualifying sessions to measure lap
   projection error by sector and pole-call calibration.
2. Historical data: OpenF1 laps with sector times (2023+) to build partial-lap training sets
   (lap after S1, after S2), grouped by event, split chronologically.
3. Train simple models first (linear / gradient boosting offline, small JSON artifacts for the
   page), compare against the current projection, deploy only if better on unseen events.
4. Race/sprint/practice: practice pace model; tyre degradation from recorded sessions.
5. Kalshi: executable prices, depth, fees, divergence board, reaction timing from recordings.
6. Strategy what-ifs; trading interface only if wanted, manual confirmation, never automatic.

Rule kept throughout: no model changes during a race weekend.

## 8. Recording and replay (added 23 Nov, before Qatar)

**Before:** only lap summaries (data/session-*.json) and Kalshi changes were saved. There was no raw feed, so nothing could be replayed. The relay ran only while the recorder job was running, and the Mac sleeps after 1 minute idle.

**Now:** recorder.mjs, inside the relay, writes one folder per session, data/rec/<year>-<meeting>-<session>-<key>/:

| File | What | Timestamps |
|---|---|---|
| feed.tsv | every raw frame from all 3 F1 connections, duplicates included, including Position.z/CarData.z | receipt epoch ms + monotonic ms; F1's send time is inside each frame |
| events.jsonl | relay start/stop, connection live/closed/failed, gaps > 15 s, missed-update checks (each reconnect's snapshot compared with our state), errors | epoch + monotonic |
| page.jsonl | the recorder page's race calls, shadow-model calls, pole calls, alerts, model versions and learned weights | page epoch + monotonic, relay receipt |
| kalshi.jsonl | every Kalshi price change, with bid/ask sizes and status | Kalshi's updated_time + our receipt + fetch ms |
| meta.json | session, every relay run | |

- **Cost:** 0.5 µs per frame on the relay. It is written after the frame is broadcast. The page benchmark is unchanged (processed P99 3.0 ms, on screen P99 18 ms, no stalls).
- **Durability:** files are fsynced every 5 s. A crash loses at most a few seconds, and a cut-off line is skipped on read. A restart appends to the same folder; tested with kill -9 against the live feed. record-and-share.sh restarts a crashed relay within 2 s and holds the Mac awake (`caffeinate -is -w`) while the relay runs.
- **Sleep:** launchd cannot wake a sleeping Mac. `node tools/schedule-wakes.mjs | sudo sh` schedules a wake 35 min before every session in the next 3 weeks. It only works on power, with the lid open or a display attached.
- **Replay:** `REPLAY=data/rec/<dir> SPEED=10 FROM=600 node server.mjs` plays the frames through the same handler the live relay uses, to the normal page. Nothing is recorded or saved over real data. The page state was checked identical to the recording's final state, on a real F1 recording and on a synthetic one with duplicates and a dropped connection. `node tools/replay-state.mjs <dir> <time|seconds>` gives the exact state at any moment.
- **Checks:** `node tools/recording-report.mjs [dir]` reports frames per connection, duplicates, F1 send→receipt delay, silences, drops, gaps, missed-update checks, laps seen vs F1's lap count, site records and Kalshi coverage. It runs automatically after each session (data/recorder.log).
- **Shadow models:** models/registry.json lists challengers. The recorder page's worker runs them after the production answer has been sent. Their answers go only to page.jsonl, never to the screen. `node tools/evaluate-shadow.mjs` scores production against the challengers on finished races. Promotion happens only between race weekends.
- **Found and fixed:** Jolpica (the schedule) started refusing requests without a named User-Agent, so the recorder's schedule check was saying "schedule unavailable" and would not have started for Qatar. All Jolpica calls now send one.

## 9. Server deployment (prepared 23 Nov, not deployed)

The recorder can run on an always-on Linux server (Oracle Cloud Always Free, ARM64 Ubuntu). See deploy/oracle/README.md. The Mac recorder stays as a fallback, and the GitHub site doesn't change.

- **Always on:** the relay runs all the time under systemd (`Restart=always`). While no session is on, it reconnects every 10 min to pick up the next one. 30 min after a session ends, recording pauses until a new session appears.
- **Sessions:** a 5-min systemd timer reads the F1 calendar, which is cached so a Jolpica outage doesn't block a recording. It runs the site's page in Chromium from 25 min before each session to its end, and that page's predictions are recorded.
- **Health:** every 2 min. Restarts the relay if it isn't answering, if the feed isn't live during a session, or if nothing has arrived for 60 s; starts the page if it's missing. Warns about low disk space, the F1 TV sign-in running out and backups; can alert a phone through ntfy.
- **Storage:** finished sessions are gzipped and checked by reading them back before the plain file is removed. They're backed up with rclone and verified by `rclone check`. Local copies are removed only once backed up, and only when space is short.
- **Portability:** `PITWALL_DATA` sets the data folder. Chrome runs on the Mac, Playwright's Chromium elsewhere. When the relay reopens a recording after a crash, it first ends any line cut off mid-write.
- **Verification:** `tools/selftest-recording.mjs` runs a stand-in F1 feed against the real relay. It records, crashes with SIGKILL, restarts, checks that only the crash window is missing, rebuilds the state twice and after compression (identical each time), replays to a headless page (identical), and runs the race call in the browser. A GitHub ARM64 Ubuntu workflow runs the tests, this self-test and the full install with real systemd, including systemd restarting a killed relay.
- **Cross-engine results:** for the same input, Chrome's race call differs from Node's in 10 of 80 values, by at most 2.2e-16 (the last binary digit; different V8 versions). The reference check (tests/fixtures/race-golden.json) allows 1e-12.
- **Effect on the browser's latency:** a server has none, because the browser never connects to it. When the recorder runs on the same Mac, the page benchmark was unchanged in 4 of 5 runs. In 1 run, while the recorder's headless Chrome was starting, frames were delayed by up to 268 ms (P99 186 ms); update processing and main-thread stalls were unaffected. On the Mac, the recorder starts 25 min before a session.
- **Unknown until tried:** whether F1 accepts connections from Oracle Cloud (it refuses GitHub's). Check with `tools/server-preflight.mjs` first.
