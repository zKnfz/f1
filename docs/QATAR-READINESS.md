# Qatar readiness: audit, data, baselines, candidates

Written 24 Nov 2026, before the Qatar GP. Schedule (UTC):
- FP1: 27 Nov 13:30
- FP2: 27 Nov 17:00
- FP3: 28 Nov 14:30
- **Qualifying: 28 Nov 18:00**
- **Race: 29 Nov 16:00**

Every number below is labelled with how it was obtained:

- **[simulated]** comes from a test with a stand-in feed. It proves the machinery works, not how accurate the model is.
- **[historical]** comes from past sessions replayed or backtested through the production code. Nothing was learned from the session being scored.
- **[live]** comes from a real session as it happened. **There is no live validation yet.** The first will be Qatar.

## 1. How the public site gets its data (audit)

| Capability | Public visitor (zknfz.github.io/f1) | How | Works today? |
|---|---|---|---|
| Live timing | Yes | The visitor's own browser connects straight to F1 (`direct.js`). Nothing of ours is in between. | Yes, from home networks. F1's CDN refuses datacenter networks (and may refuse some VPNs or corporate networks), so a visitor on one of those gets nothing. |
| Car positions / telemetry | Only with the visitor's own F1 TV sign-in, pasted into the page | Stays in that browser, sent only to F1 | Yes. We never redistribute anyone's sign-in or F1 TV telemetry. |
| Predictions (projections, pole call, race call, alerts) | Yes | Computed in the visitor's browser by the same code the recorder runs. Race call in a Web Worker. | Yes |
| Learned parameters | Yes | The page reads `learned/*.json` from the repo (`raw.githubusercontent.com/zKnfz/f1/main/learned/`) and adopts a file when it has learned from more laps than the browser itself | Yes. Published by the **Mac recorder** (`tools/record-and-share.sh`, launchd `com.pitwall.recorder`). Oracle has `SHARE_LEARNED=0`, so it doesn't publish. |
| Kalshi prices | Yes | Cloudflare Worker `pitwall-kalshi.zknfzpitwall.workers.dev`: public F1 market data only, read-only, no key, CORS limited to the site, cached 1 s | Yes. All five Qatar markets resolve: pole `KXF1POLE-LUSA26`, winner/podium/top 5/top 10 `…-QATA26`. |
| Lap history while the page is closed | No | Only a relay keeps history while no page is open | By design |
| Recordings, replays, the backend, ingest | No | Private: Mac + Oracle over Tailscale. Never public. | By design |

**What changed for public distribution (this round):**
- **Before:** whatever landed in `learned/` was adopted by every visitor. Nothing checked it.
- **Now, `tools/validate-learned.mjs`** runs before anything is shared, from both the Mac and the server scripts. It refuses:
  - tokens, credentials, e-mail and IP addresses
  - raw car positions or telemetry (`Position.z`/`CarData.z`, which come from an F1 TV sign-in and are not ours to redistribute)
  - raw feed frames
  - non-finite or out-of-range numbers, unknown file kinds, and lap models whose solved weights are implausible
  If it passes, it writes `learned/manifest.json` (SHA-256 of each file, the code commit and the time).
- **In the visitor's browser,** a final check (`sharedOk` in `engineer.js`) refuses a shared file with the wrong key, broken numbers or the wrong shape before using it.
- **A stale file was removed:** `pitwall-model-v3-152-other.json` (the page reads v4 only).
- **What is published:** derived parameters only (lap-model sums, calibration points, best qualifying times, the site's own past calls). Never raw F1 data or anyone's credentials.

**Your brother (or anyone)** opens https://zknfz.github.io/f1/ and gets live timing, every prediction, and the shared learned parameters with nothing to install. He doesn't get car GPS without his own F1 TV account, or a replay of past sessions.

**Model distribution in future** (recommendation, not done):
- Promote a model by changing the code, after the replay comparison in §4. The site is the code, so every visitor gets the promoted version at once, and the version is in the page (`RaceSim.VERSION`, `quali-proj-v4`).
- Keep `learned/` for slowly-learned, per-circuit sums.
- Choose one publisher:
  - Either keep the Mac (as now), or move publishing to Oracle (`SHARE_LEARNED=1` with a deploy key limited to this repo) and stop the Mac's `com.pitwall.recorder`.
  - Not both, or they will fight over `learned/`.

## 2. Historical data inventory

Fetched this round with `tools/fetch-openf1.mjs` and `tools/fetch-races.mjs`, from public sources only. Everything stays in `data/` (gitignored, local, never published). `tools/data-inventory.mjs` prints this table.

| Source | What | Coverage |
|---|---|---|
| OpenF1 public historical API (free, no key; 2023 on) | Laps with sector times, mini-sectors and speed traps; stints (compound, tyre age); race control (with the Q1/Q2/Q3 phase); weather; results; pit stops; grid | Qualifying: 2023 (22 + 6 sprint), 2024 (24 + 6), 2025 (24 + 6), 2026 (21 + 6, to Las Vegas). Races and sprints: 2025 and 2026 (45 + 12). About 70% of qualifying laps have all three sectors (out-laps and in-laps don't); 99% of race laps do. |
| Jolpica (Ergast successor; free) | Race lap times and positions, pit stops, qualifying results. No sectors, no tyres. | 2024 (24), 2025 (24), 2026 (21) races |
| Our own recordings | The raw F1 feed as the page saw it | **Las Vegas 2026 only, and only after the race (0.73 MB).** No full real session is recorded yet. |
| `learned/` (shared) | Derived parameters | Built only from Las Vegas weekend sessions |

**Gaps:**
- F1's own static archive (`livetiming.formula1.com/static`) now refuses requests (401), so it isn't used.
- 2025 Baku qualifying has no laps on OpenF1.
- 2024 races have no OpenF1 download; Jolpica covers them.
- There is no historical car-position or car-telemetry data. That needs an F1 TV sign-in, and isn't ours to store or share.

**What is available historically against live:**
- Sector times, speed traps, tyres, race control, track status and weather exist both historically and live.
- Mini-sector timing exists live, but historically only as a coarse segment status. `tools/openf1-to-recording.mjs` spreads mini-sectors evenly across each sector, so features that rely on mini-sector *timing* can't be judged on history.
- Car position and gaps-on-track are live only, with F1 TV.
- Traffic can be judged only roughly, from sector-time gaps.

**Which models can be trained or calibrated on this data:**
- Qualifying lap projection: its error and uncertainty, by part, tyre, season, circuit and time into the part.
- The pole call and the "who tops Qn" call (calibration).
- A new knockout chance for Q1/Q2.
- Race win/podium/top 5/top 10 calibration.
- Race pace, tyre wear and pit stops (backtest).

**How the history is used:**
- Each historical qualifying session is rebuilt into the same feed the page reads (`openf1-to-recording.mjs`, labelled `synthetic` in its metadata) and replayed through the real page.
- Each replay is a fresh browser with **no learned files**, so the page starts from the code's priors and learns only from that session, as it did live.
- Races are backtested through the same race simulator the page uses (`racesim.js`), with laps cut off at each checkpoint (`tools/race-backtest.mjs`).

**Circuit history for Lusail** (`tools/circuit-history.mjs`, 6 qualifying sessions from 2023 to 2025, against all other circuits):

| | Lusail | Other circuits |
|---|---|---|
| Track gain Q1 → Q3 (best lap) | 1.02% | 1.20% |
| Pole margin P1–P2 | 0.13 s | 0.20 s |
| Top-10 spread | 1.39% | 1.83% |
| Pole set on the final run | 100% | 84% |
| Laps deleted per session | 15.3 | 8.0 |
| Red flags per session | 0.17 | 0.48 |

So Lusail is a tight, track-limits-heavy circuit where pole is decided on the last run. Expect deleted laps to move the call late, and a close pole.

## 3. Baselines (production, before any change) [historical]

### Race: win / podium / top 5 / top 10

How this was measured:
- `tools/race-backtest.mjs` runs 69 races (2024: 24, 2025: 24, 2026: 21) through `racesim.js`, the same simulator the page uses, with the production calibration of 23 Nov.
- The race is cut off at 0, 25, 50, 75 and 90% of its distance.
- Each call is compared with the classification, scored by `tools/score-race.mjs`.
- **"Naive"** is a reference that uses only the running order at that point. For each place, it takes how often a car in that place went on to win / finish top 5 / finish top 10 in the *other* seasons.

**A flaw in the backtest was found and fixed first:**
- The backtest's data (Jolpica) has no track status, so laps under a safety car were kept as normal laps.
- A car that pitted under the safety car had its slow laps dropped as pit laps, kept only its fast laps, and looked 4–13 s/lap quicker than the leaders.
- 15 calls in 69 races made a car running P10–P21 a 17–79% favourite. None of those cars won.
- The live page was never affected: it drops safety-car and VSC laps using track status.
- The backtest now drops laps where the whole field ran 7%+ slow. All numbers below use the corrected backtest.

Remaining leakage, which flatters the backtest slightly: the pit-loss estimate and the reference pace come from the whole race.

Summary by distance (Brier, lower is better; all 69 races; production calibration of 23 Nov):

| Market | 0% (grid) | 25% | 50% | 75% | 90% |
|---|---|---|---|---|---|
| win | 0.028 | 0.023 | 0.017 | 0.013 | 0.005 |
| top 5 | 0.088 | 0.068 | 0.055 | 0.042 | 0.023 |
| top 10 | 0.149 | 0.110 | 0.091 | 0.063 | 0.039 |
| favourite won | 61% | 67% | 84% | 86% | 96% |

Calibration (all distances, said → happened):

| Market | 10–30% | 30–50% | 50–70% | 70–90% | 90–100% |
|---|---|---|---|---|---|
| win | 19 → 11% | 42 → 43% | 58 → 75% | 80 → 93% | 93 → 95% |
| top 5 | 18 → 11% | 39 → 44% | 60 → 76% | 82 → 84% | 96 → 94% |

**Favourites were under-called:** chances of 50–90% came true more often than stated, and long shots of 10–30% less often. The refit in §4 corrects much of this.

Against the naive running-order reference:
- From 25% distance on, the model is better than or equal to naive in almost every season, market and distance.
- **Win at 25%:** 2024: 0.024 vs 0.030; 2025: 0.022 vs 0.027; 2026: 0.024 vs 0.032.
- **Top 10 at 25%:** 2024: 0.099 vs 0.126; 2025: 0.123 vs 0.142; 2026: 0.109 vs 0.121.
- The only clear exception is top 5 at 90% in 2024–25, where the running order is as good or slightly better (2024: 0.018 vs 0.014).
- **At the grid**, top 5 and top 10 are about level with naive. The model adds little before the start, and most from the first stops onwards.

### Race: pace, tyres, pit stops (all 69 races)

| Distance | Pace error (s/lap vs field, next 10 clean laps) | Pace rank correlation | Pit stops still to make: exactly right | Tyre wear predicted → realised (s/lap per lap of age) |
|---|---|---|---|---|
| 25% | 0.42 | 0.75 | 45% | 0.021 → 0.037 |
| 50% | 0.46 | 0.75 | 51% | 0.020 → 0.043 |
| 75% | 0.51 | 0.78 | 83% | 0.019 → 0.047 |
| 90% | 0.48 | 0.76 | 96% | 0.021 → 0.089 |

- **Tyre wear is under-predicted at every distance.** Part of the "realised" figure is wear the driver *chose* to tolerate late in a stint, so it overstates true wear a little, but the gap is too large and consistent to be only that. This is the clearest place to improve the race model, after Qatar.
- **Pit-stop count early in the race** is exactly right only about half the time. The backtest assumes tyres (Jolpica has none), so this is a lower bound on the live figure, which sees real compounds.
- **Known live risk, not covered by the backtest:** a car's pace is the average of its own recent clean laps, not compared with the field lap by lap. If rain arrives or clears mid-race, cars whose recent laps fall on different sides of the change are compared unfairly until they have fresh laps. Under a safety car this is handled; in changing weather it isn't.

### Qualifying [historical]

How this was measured:
- 88 qualifying and sprint-qualifying sessions (2023 Qatar, 2024–2026) were rebuilt from OpenF1 and replayed at 10× through the real page.
- Each replay used a fresh browser with no learned files (`tools/replay-eval.mjs`), and was scored by `tools/score-quali.mjs`.
- **Lap projection:** only push laps are counted (within 2% of the driver's best).
- **Pole / "tops Qn":** the call at fixed points of each part, scored against who actually topped it.
  - "Last call" is the final call before the part's outcome was certain. It is mostly decided by then, so it says little.

| Lap projection | Laps | Average error | RMSE | Bias | Within the stated ± (68% if honest) |
|---|---|---|---|---|---|
| after sector 1 | 6,234 | 0.29 s | 0.55 s | +0.02 s | **90%** |
| after sector 2 | 5,141 | 0.16 s | 0.29 s | −0.01 s | **89%** |

- **The stated ± is about twice as wide as it needs to be.** In fitting, about half the width gave the honest 68% (§4).
- **The bias depends on the part:** Q1 laps project about 0.14 s slow and Q3 laps about 0.15 s fast (fitted on training sessions). That cancels out in the overall average.
- **Late 2026 is harder:** on sessions from August on, the error after sector 1 is 0.43 s against 0.28 s before. A handful of very large misses (RMSE 1.0 s) account for most of that.

| Pole call (Q3) | Sessions | Favourite took pole | Pole-sitter's average chance | Log loss | Calibration error |
|---|---|---|---|---|---|
| start of Q3 | 55 | 44% | 23% | 1.69 | 0.026 |
| 25% | 81 | 46% | 29% | 1.65 | 0.019 |
| 50% | 84 | 57% | 44% | 1.65 | 0.032 |
| 75% | 88 | 55% | 44% | 1.68 | 0.027 |
| 90% | 88 | 56% | 44% | 1.72 | 0.035 |
| last call | 88 | 89% | 82% | 0.34 | 0.010 |

- **The pole call is honest but not decisive.** Its chances are well calibrated (calibration error about 0.02–0.03), and its favourite takes pole a little over half the time from mid-Q3.
- **It doesn't sharpen between 50% and 90% of Q3.** Pole is settled on the final runs, so the picture only clears in the last minute.
- **"Who tops Q1/Q2" is weaker:** its favourite is right 29–58% of the time from mid-part.

**Knockout (who goes out in Q1/Q2):** production shows only who is in the drop zone now. It gives no chance of going out.

## 4. Candidates against production

Rule: fit on data before 1 Aug 2026 (and never on Lusail), judge on 1 Aug 2026 onward, promote only on a clear held-out gain, and never during a race weekend.

### Race calibration refit — **promoted** (`race-2026-11-24`) [historical]
- **What:** the calibration layer of `racesim.js` was refitted on raw simulator output from 2024, 2025 and 2026 rounds 1–11, from the corrected backtest, with Qatar left out (`tools/race-calibrate.mjs`). The production calibration had been fitted on the flawed backtest output.
- **Held-out 2026 rounds 12–21** (all four markets at all five distances):
  - Better in **8 of 10 races** (worse at Brazil and Mexico City).
  - Log loss per race −0.112, with a 95% bootstrap interval over races of −0.209 to −0.005.
  - Brier summed over markets and distances: 1.051 → 1.015.
  - **Win improved at every distance:** e.g. 50%: 0.0200 → 0.0176; 90%: 0.0057 → 0.0040.
- **Qatar 2024 and 2025, never fitted:**
  - 2024: 4.215 → 4.218.
  - 2025: 3.659 → 3.625.
  - About level.
- **Decision:** promoted on 24 Nov, before the race weekend. The previous calibration is kept in `models/candidates/race-cal-2026-11-23.json`.
  - The golden reference test was regenerated.
  - The change is constants only, so the race call's cost per update is unchanged.
- **Label:** historical validation. No live race has used it yet; Qatar will be the first.

### Qualifying candidates — **none promoted** [historical]

The split: fitted on 70 sessions before 1 Aug 2026 (no Lusail), judged on the 12 sessions from 1 Aug on and on the 6 Lusail sessions (`tools/fit-quali.mjs`).

| Candidate | What | Held out | Qatar | Decision |
|---|---|---|---|---|
| Pole temperature (Q3) | Pole chances sharpened or softened (p^α) | The fitted α is 0.95, effectively no change: log loss 2.262 → 2.238 | 1.382 → 1.369 | **No change needed.** The pole call's confidence is already about right. |
| Top-of-Q1/Q2 temperature | Those chances softened (α = 0.35) | Overall log loss 2.746 → 2.564, calibration error 0.032 → 0.011. But it was better in only 6 of 12 sessions, and the 95% interval for the gain includes zero. It helps at 25–50% of a part and hurts at the start and at 90%. | 2.335 → 2.152; 3 of 6 sessions better | **Shadow.** Not a clear held-out gain. |
| Knockout chance (`ko-mc`, new) | A Monte Carlo of the rest of Q1/Q2 from the pole call's inputs | **Worse than the running order** at every stage after the start: Brier 0.215 vs 0.165, calibration error 0.16–0.32 | 0.199 vs 0.166 | **Shadow.** It is overconfident because it allows each car at most one more lap. A naive running-order table beats it. |
| Projection bias by part + narrower ± (`proj-fit`) | Remove the part bias, and scale ± by 0.51 (sector 1) and 0.49 (sector 2) | Measured offline on the recorded projections: average error 0.432 → 0.425 (sector 1), 0.241 → 0.237 (sector 2). The ± becomes 62% / 53% (somewhat too narrow). | 0.220 → 0.200; ± 67% / 66% (honest) | **Not judged.** Its replay (which is needed to see the effect on the pole call) was invalid: on an overloaded Mac the page captured only part of the records, and none for one session, with no errors reported. Re-run after the Qatar weekend, on an idle machine. |

Scripts for every candidate are in `models/candidates/`. The production page is unchanged for qualifying.

## 5. Qatar

Lusail was never used to fit anything, so these are clean out-of-sample results.

### Race: the 2024 and 2025 Qatar GPs, production model [historical]
| Race | Distance | Favourite's win chance (running place → finish) | Top-5 picks that finished top 5 |
|---|---|---|---|
| 2024 | grid | 45% (P1 → P4) | 4/5 |
| 2024 | 25% | 57% (P1 → P1) | 4/5 |
| 2024 | 50% | 60% (P1 → P1) | 3/5 |
| 2024 | 75% | 64% (P1 → P1) | 4/5 |
| 2024 | 90% | 91% (P1 → P1) | 5/5 |
| 2025 | grid | 52% (P1 → P2) | 4/5 |
| 2025 | 25% | 61% (P1 → P2) | 5/5 |
| 2025 | 50% | 73% (P1 → P1) | 5/5 |
| 2025 | 75% | 55% (P1 → P4) | 5/5 |
| 2025 | 90% | 92% (P1 → P1) | 5/5 |

- Production calibration of 23 Nov, corrected backtest.
- The leader was the favourite throughout both races, and won from 50% on in 2024, and in 2025 at 50% and 90%.
- The 2025 leader at 75% finished P4. I haven't checked why.
- The tyre-wear under-prediction (§3) probably matters more at Lusail than at most circuits, because it is hard on tyres. **Treat mid-race top-5 and top-10 chances at Qatar with some caution.**

### Qualifying: the six Lusail sessions, production model [historical]

These are 2023, 2024 and 2025 qualifying and sprint qualifying, never fitted.

| | Lusail | All 88 sessions |
|---|---|---|
| Projection error after sector 1 | **0.22 s** | 0.29 s |
| Projection error after sector 2 | **0.12 s** | 0.16 s |
| Within the stated ± (sector 1 / 2) | 92% / 93% | 90% / 89% |
| Pole call, all stages before the last call: favourite took pole | 52% (15 of 29 calls) | 52% |
| Pole call log loss (lower is better) | 1.38 | 1.68 |
| Last call right | 5 of 6 | 89% |

What this means for the weekend:
- **Lap projections have been more accurate at Lusail than on average** (0.22 s against 0.29 s after sector 1). The ± shown will look wide, because it is: about 9 laps in 10 land inside it.
- **The pole call is about as good as anywhere** (better log loss, small sample). It still only names the eventual pole-sitter about half the time before the final runs. Lusail's history (§2) points the same way: pole was always decided on the last run, and margins are small (P1–P2 0.13 s).
- **Deleted laps are twice as common at Lusail** (15 per session against 8). A projection or a pole chance can vanish when race control deletes the lap, so treat early-part calls with care.
- **For betting the pole market:** the page's pole chance is a fair estimate, not an edge by itself. It has been honest on average; whether it beats the Kalshi price is something only live data can show, and the first such data comes from this weekend.
 Deployment safeguards

- **Why the Las Vegas recording was never backed up (found and fixed):**
  - The cause: after a session ends, the recorder stays pointed at the session folder for good. `/api/recording` kept reporting it as active, and maintenance never compresses or backs up the active folder. On the always-on backend, the last session stayed "active" indefinitely, so it was never compressed and never backed up.
  - The fix: once the session has been over for 30 min, the recorder closes its files and reports nothing active. Maintenance then compresses the folder, backs it up and verifies it. A unit test covers this, and the pipeline self-test backs up and restores a real folder (CI, with rclone).
  - Oracle picks this up when it next pulls code. `AUTO_UPDATE=1` pulls before each session; to pick it up sooner, pull by hand and restart the relay (§8).
  - The **Las Vegas recording itself is only 0.73 MB.** The relay started recording at 20:11 on 23 Nov, after the race had finished, so the folder holds the post-race state, not the race. There is no real recording of a full session yet.
- **Backup storage cap:** `BACKUP_MAX_GB` (default 15; Oracle Object Storage is free to 20 GB).
  - Before each upload, maintenance measures the remote (`rclone size`) and skips any folder that would cross the cap.
  - Skipped folders stay local and are reported in `maintain.json` and by `verify-deploy`. Nothing is ever deleted remotely to make room.
  - The CI pipeline test checks this.
- **Verifying the deployment against the repo:** `tools/verify-deploy.mjs` is read-only and prints no secrets. It checks:
  - the code against origin/main
  - the role and its required settings
  - private listen addresses
  - secret permissions and length
  - installed systemd units against the repo copies
  - enabled/active state
  - NTP
  - the relay, ingest and collector heartbeats
  - the F1 TV sign-in expiry
  - the last maintenance, backup usage and folders not yet backed up

  Run on the Mac collector (24 Nov): **no FAIL, 2 WARN**:
  - the Mac can sleep on its own
  - the F1 TV sign-in expires 26 Nov 06:25 UTC

  I can't reach the Oracle VM. **You need to run it there** (§8).
- **Collector link:** the Mac's shipper log shows the Tailscale connection to Oracle timing out about every 10–15 min (74 times on 24 Nov). It reconnected within ~4 s each time, with no backlog. Nothing was lost: the files are the spool. But it is worth knowing during a session.
- **Latency (Priority 0) preserved:**
  - The page changes are a session-clock function (the same `Date.now()` when not replaying), and a shared-file check that runs once per file, at adoption.
  - The projection log runs only on the recorder's headless page (`navigator.webdriver`), never on a visitor's page.
  - Nothing new runs on the feed → screen path.

## 7. Historical replay (Objective 5)

What exists now:
- **Through the real prediction engine:** `tools/replay-eval.mjs` starts the relay in replay mode (`REPLAY=<folder>`) and opens the real page in a headless browser. It feeds the session in time order at a chosen speed. The page only ever sees what had happened by that moment in the feed.
  - Each session gets a fresh browser profile, with no learned files (`NO_LEARNED=1`) and no Kalshi.
- **The page's own clock follows the feed** (`feedNow()`). Without this, a replay at 10× would have reported the wrong time left in each part, and called the end of a part far too early.
- **What is recorded:** the page logs every projection at each sector end, every lap end, every pole / top-of-part call and any page error, with the feed time (`REPLAY_OUT`).
- **Scoring:** `tools/score-quali.mjs` compares these with the outcome. `tools/fit-quali.mjs` fits candidates and compares them with production.
- **Production against candidate:** `CANDIDATE=<name>` loads `models/candidates/<name>.js` into the page before it starts. It wraps a production function; production code is never edited to try something.
- **Accelerated:**
  - All scored runs use 10×. Projections are identical at any speed.
  - The pole call is recomputed on wall-clock timers, so its snapshot at a given moment shifts a little with speed. Comparisons are therefore always made at the same speed.
- **Whole-session simulation before Qatar:** every 2023–2026 qualifying session on OpenF1 has been rebuilt and is replayable, including the six Lusail sessions.
  - To watch one: `REPLAY=data/replays/openf1-9841 SPEED=5 node server.mjs`, then open http://127.0.0.1:8765.
- **Market data:** historical Kalshi prices aren't available to us, so replays carry none. Live sessions record Kalshi prices next to the feed (`kalshi.jsonl`), so that comparison becomes possible from Qatar on.
- **Race replay:** races are judged with the race backtest (§3), not page replay. OpenF1 has no race-length feed detailed enough to rebuild what the page reads (car positions, live gaps) without F1 TV data.

## 8. Remaining deployment steps (you; I have no access to Oracle)

1. **Oracle: pull today's code and restart.** This fixes the backup gap, and adds the backup cap, verify-deploy and the learned-file check:
   ```
   sudo -u pitwall git -C /opt/pitwall pull --ff-only
   sudo systemctl restart pitwall-relay pitwall-ingest
   ```
   (`AUTO_UPDATE=1` would also pull before the next session.)
2. **Oracle: set the backup cap**, if not 15 GB: add `BACKUP_MAX_GB=15` to `/etc/pitwall/pitwall.env`.
3. **Oracle: check the deployment against the repo:**
   ```
   sudo -u pitwall node /opt/pitwall/tools/verify-deploy.mjs
   ```
   It should end with no FAIL.
4. **Oracle: confirm the Las Vegas folder was backed up.** After the next maintenance run (or `sudo systemctl start pitwall-maintain`):
   - `/opt/pitwall/data/maintain.json` should list it under backed-up folders.
   - `rclone ls oracle:pitwall-backups | grep las-vegas` should list it.
5. **Mac: restart the relay**, so it runs today's code. It was started before the changes:
   ```
   launchctl kickstart -k gui/$(id -u)/com.pitwall.relay
   ```
6. **Mac: renew the F1 TV sign-in now.** It **expired on 26 Nov at 06:25 UTC** (`verify-deploy`: FAIL). Without it, car positions and telemetry are missing; timing and every prediction still work. Renew before FP1 (27 Nov 13:30 UTC).
7. **Mac: keep it awake on power for the weekend** (your command; I don't change system settings):
   ```
   sudo pmset -c sleep 0
   ```
   or run `caffeinate -s` in a terminal during sessions.
8. **One publisher for `learned/`:** decide Mac (as now) or Oracle (§1). Until you decide, nothing changes.

## 9. Live-session readiness checklist

**Before FP1 (27 Nov 13:30 UTC):**
- [ ] Steps 1–7 above are done.
- [ ] `node tools/verify-deploy.mjs` passes on the Mac and on Oracle.
- [ ] Open https://zknfz.github.io/f1/ on a home network (not a VPN): the session list shows Qatar, and Kalshi prices show for the Qatar markets.
- [ ] Your brother's device: the same page loads with no sign-in. Live timing works from his network.

**At FP1, as the first live end-to-end test.** Practice carries no betting market, so it is the right one to test on:
- [ ] The Mac recorder opens `data/rec/2026-qatar-grand-prix-practice-1-11421/` and `feed.tsv` grows.
- [ ] The shipper reports the session on Oracle (ingest heartbeat). Oracle's copy of `feed.tsv` matches the Mac's byte count, give or take the last few seconds.
- [ ] The following relay on Oracle serves the session to a page opened over Tailscale.
- [ ] 30 min after FP1 ends, the folder is closed. Maintenance then compresses it and backs it up: `maintain.json` lists it, and so does `rclone ls`.
- [ ] Any of these failing: fix before qualifying. The pole and knockout calls depend on the same path.

**Qualifying (28 Nov 18:00 UTC) and race (29 Nov 16:00 UTC):**
- [ ] No code or model changes from FP1 to the end of the race.
- [ ] Afterwards, score the live calls in the same way as the history (`node tools/score-quali.mjs` on the recording's page log). That is the first **[live]** result.

**Before betting on any call:**
- Read §3 and §5 for how good the call has been at that stage of a session.
