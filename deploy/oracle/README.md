# Running the recorder on an Oracle Cloud server

The recorder records every F1 session without your Mac or browser being on. It is prepared here
but **not deployed**: nothing below has been created or paid for. Each step is yours to run.

What runs on the server (Ubuntu, ARM64, Oracle's "Always Free" Ampere A1):

| Service | What | When |
|---|---|---|
| `pitwall-relay` | the relay (`server.mjs`): 3 connections to F1, records every session to `/opt/pitwall/data/rec/` | always; restarted by systemd within 2 s of any exit |
| `pitwall-session.timer` → `pitwall-session` | the site's page in headless Chromium for the session: its race calls, pole calls, alerts and model versions go into the recording | checks the F1 calendar every 5 min; runs from 25 min before each session to its end |
| `pitwall-health.timer` | checks the relay, feed, page, disk, F1 TV sign-in, backups; restarts what's broken; can alert your phone | every 2 min |
| `pitwall-maintain.timer` | compresses finished recordings, backs them up, frees space (only ever deleting what is backed up) | hourly |

Your Mac keeps working exactly as before (launchd + `tools/record-and-share.sh`) as a fallback.
The GitHub site is unchanged and never talks to the server: your browser connects to F1 directly.

## Before you start: the one big unknown

F1 refuses connections from some data-centre networks (it refuses GitHub's). Whether it accepts
Oracle Cloud is **not known** until tried. Step 3 checks it first, before you rely on anything.
If F1 refuses Oracle, stop there and delete the instance; the Mac recorder carries on.

## 1. Create the instance (you, in the Oracle Cloud console)

- Sign up at cloud.oracle.com (needs a card for identity; Always Free resources are not charged.
  Keep the account on "Free Tier", don't upgrade to Pay As You Go, and Oracle won't bill).
- Compute → Instances → Create: image **Canonical Ubuntu 24.04**, shape **VM.Standard.A1.Flex**
  (Ampere, ARM64), 1 OCPU and 6 GB memory is plenty (Always Free allows up to 4 OCPU / 24 GB
  in total). Boot volume: the default ~47 GB is enough to start (Always Free: 200 GB in total).
- Networking: a public IP so you can SSH in. **No inbound ports other than SSH (22)**: the relay
  only listens on 127.0.0.1. Better still, limit port 22 to your home IP in the security list.
- Add your SSH public key (`~/.ssh/id_ed25519.pub`; make one with `ssh-keygen -t ed25519`).
- Always Free A1 capacity is sometimes "out of capacity" in a region; trying again later or another
  availability domain usually works.

## 2. Install (on the server)

```
ssh ubuntu@<server address>
curl -fsSLO https://raw.githubusercontent.com/zKnfz/f1/main/deploy/oracle/install.sh
less install.sh            # read it first
sudo bash install.sh
```

It installs Node 22 (checked against nodejs.org's checksums), Playwright's Chromium, the
`pitwall` system user, `/opt/pitwall`, the services and a sudo rule that lets the recorder restart
only its own services. It then runs the self-test (a stand-in F1 feed: record, crash, restart,
replay, compress, browser) and starts the services. The same script is tested on every change
on GitHub's ARM64 Ubuntu runners (`.github/workflows/recorder-linux-arm64.yml`).

## 3. Check F1 accepts the server (on the server)

```
sudo -u pitwall node /opt/pitwall/tools/server-preflight.mjs
```

`OK F1 live timing feed: snapshot received …` means go. `FAIL … refused` means Oracle is
blocked: stop here (`sudo systemctl disable --now pitwall-relay pitwall-session.timer`).

## 4. Your F1 TV sign-in (from your Mac)

Car positions and telemetry need your own F1 TV sign-in, the same token as on the Mac. It lasts
about 4 days, so send it again before each race weekend (the health check warns 30 h before):

```
cd ~/f1 && tools/send-token-to-server.sh ubuntu@<server address>
```

It goes into `/opt/pitwall/data/f1tv-token.txt` (owner `pitwall`, mode 600). It is never in git,
never in the environment file, never in logs.

## 5. Optional: off-server backup

Recordings live on the server's disk. To also keep them elsewhere, set up rclone with any
storage you have (Cloudflare R2, Backblaze B2, Google Drive, Oracle Object Storage…):

```
sudo -u pitwall rclone config        # create a remote, e.g. "r2"; its keys stay in rclone's own config
sudoedit /etc/pitwall/pitwall.env    # RCLONE_REMOTE=r2:pitwall-recordings
```

The hourly job then copies each finished, compressed session and checks it with `rclone check`.
A local copy is only ever removed if it is backed up *and* space is short (`MIN_FREE_PCT`).

## 6. Optional: alerts on your phone

Install the ntfy app, subscribe to a long random topic name, and set
`NTFY_URL=https://ntfy.sh/<that topic>` in `/etc/pitwall/pitwall.env`. You then get a message when
the relay had to be restarted, the feed is down during a session, space is low, the sign-in is
running out or a backup fails. (Anyone who knows the topic name can read it; make it unguessable.)

## Everyday use

```
curl -s localhost:8765/api/health                 # on the server: feed, recording, disk
cat /opt/pitwall/data/health.json                 # last health check, warnings, next session
node /opt/pitwall/tools/recording-report.mjs      # the latest recording: gaps, drops, laps, Kalshi
journalctl -u pitwall-session -n 50; tail -f /opt/pitwall/data/relay.log
```

Copy a recording to the Mac and replay it there:

```
rsync -a ubuntu@<server>:/opt/pitwall/data/rec/<session>/ ~/f1/data/rec/<session>/
cd ~/f1 && REPLAY=data/rec/<session> SPEED=10 node server.mjs      # http://127.0.0.1:8765
```

## Secrets: where they are, and where they never are

| Secret | Lives in | Never in |
|---|---|---|
| F1 TV token | `/opt/pitwall/data/f1tv-token.txt` (600, pitwall) and your Mac's `data/` | git, env file, logs |
| rclone keys | `~pitwall/.config/rclone/rclone.conf` | git |
| ntfy topic | `/etc/pitwall/pitwall.env` (640, root:pitwall) | git |
| GitHub push key (only if `SHARE_LEARNED=1`) | `~pitwall/.ssh/` as a *deploy key* for this repo only | git |

`data/` is gitignored; the repo has only `pitwall.env.example` with empty values.

## What the server's recorded predictions are, exactly

The page in headless Chromium is the same code as the live site (pulled from GitHub before each
session) and computes the same predictions, recorded with their model version. Limits:

- **Same model, own learning.** The lap projection learns in the browser. The server's page starts
  each session from the shared `learned/*.json` (like any new visitor) and learns during the
  session; your own browser may have learned a bit more locally, so qualifying projections can
  differ slightly from what you saw. The weights used are recorded (`models` lines in page.jsonl).
- **Race calls** are the same calculation; across different JavaScript engines a few values can
  differ in the last binary digit (measured: 2.2e-16), never visibly.
- **One page, one clock.** Predictions are recorded when the server's page made them; your browser
  may have made the same one a few milliseconds earlier or later.
- **No F1 TV sign-in → no telemetry**: positions, car data and the slow-car alert are missing then.
- **Kalshi** is recorded by the relay (public prices); the page's own Kalshi tags are not needed.
- If the site's code changes during a race weekend, the server picks it up before the next session
  (`AUTO_UPDATE=1`), the same as every visitor's browser. Set `AUTO_UPDATE=0` to freeze it.

## Turning it off / removing it

```
sudo systemctl disable --now pitwall-relay pitwall-session.timer pitwall-health.timer pitwall-maintain.timer
```
Then terminate the instance in the Oracle console (and its boot volume) if you no longer want it.
