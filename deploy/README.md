# Deploying Pitwall: backend + collector

Why two machines, and everything else about the design: [docs/BACKEND.md](../docs/BACKEND.md).

```
F1 live timing ──► COLLECTOR (a network F1 accepts: home Mac / Raspberry Pi / home Linux box)
                     server.mjs  records every frame to data/rec/<session>/feed.tsv (fsync 5 s)
                     shipper.mjs sends those files, in order, signed, resumable
                        │  private encrypted link: Tailscale (recommended) or SSH tunnel
                        ▼
                   BACKEND (Oracle VM, always on)
                     ingest.mjs        identical copy in data/rec/, fsync before ack
                     server.mjs FOLLOW=1   live state from that copy (same code as direct)
                     record.mjs (session timer) headless page → predictions in backend-page.jsonl
                     Kalshi prices → backend-kalshi.jsonl; health; compaction + backup
```

Nothing here enables a service by itself. `install.sh` prints the `systemctl enable` line;
you run it when you decide to.

## 1. Backend (Oracle) — upgrade the existing install

On the VM (you, over SSH):

```bash
cd /opt/pitwall && sudo -u pitwall git pull --ff-only
sudo PITWALL_ROLE=backend bash deploy/oracle/install.sh        # installs, tests, enables nothing
sudo nano /etc/pitwall/pitwall.env
```

Set in `/etc/pitwall/pitwall.env` (an existing file is never overwritten by the installer):

```
PITWALL_ROLE=backend
FOLLOW=1
PAGE_URL=http://127.0.0.1:8765/?mode=relay
INGEST_HOST=127.0.0.1          # or the VM's Tailscale address, 100.x.y.z (step 3)
INGEST_PORT=8770
INGEST_SECRET_FILE=/etc/pitwall/ingest-secret
RCLONE_REMOTE=                 # step 5
```

The installer generated `/etc/pitwall/ingest-secret` (root:pitwall, 640). Don't print it in a
shared terminal; you copy it to the collector in step 3.

Check the services are still off: `systemctl is-enabled pitwall-relay pitwall-ingest` → `disabled`.

## 2. Collector — pick one machine on a network F1 accepts

First prove the network works (no install needed, Node 18+, no token used):

```bash
node tools/f1-net-preflight.mjs        # want: OK or NO_SESSION
```

`EDGE_REFUSED*` = F1's CDN refuses this network: that machine can't be the collector.

**Mac (you have it already):**

```bash
cp /path/to/secret data/ingest-secret && chmod 600 data/ingest-secret
printf 'SHIP_URL=http://<backend>:8770\nSHIP_ID=mac\n' > data/collector.env
bash deploy/collector/macos-install.sh     # writes launchd agents, doesn't load them
```

**Raspberry Pi 4/5 or any home Linux box (Ubuntu/Debian, ARM64 or x86-64)** — the reliable
choice, since it never sleeps:

```bash
git clone https://github.com/zKnfz/f1.git /tmp/f1 && cd /tmp/f1
sudo PITWALL_ROLE=collector bash deploy/oracle/install.sh
sudo install -m 640 -o root -g pitwall /dev/stdin /etc/pitwall/ingest-secret   # paste the secret, Ctrl-D
sudo nano /etc/pitwall/pitwall.env       # SHIP_URL, SHIP_ID, KALSHI=0
```

## 3. The private link (pick one)

**Tailscale (recommended):** free personal plan, WireGuard encryption, no public port,
survives home IP changes.

1. Install Tailscale on the VM and the collector, and sign both into your tailnet
   (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`).
2. On the VM: `tailscale ip -4` → put that 100.x address in `INGEST_HOST`.
3. On the collector: `SHIP_URL=http://<vm tailscale name or 100.x>:8770`.
4. Optional, tighter: a Tailscale ACL allowing only the collector → VM port 8770.

No Oracle security-list or iptables change is needed: Tailscale connects outward from both ends.

**SSH tunnel (no new software on the VM):** ingest stays on 127.0.0.1.

1. On the VM, create a user that can only forward to the ingest port:
   ```bash
   sudo useradd --system --create-home --shell /usr/sbin/nologin pitwall-tunnel
   sudo install -d -m 700 -o pitwall-tunnel ~pitwall-tunnel/.ssh
   # one line in ~pitwall-tunnel/.ssh/authorized_keys (mode 600, owner pitwall-tunnel):
   restrict,port-forwarding,permitopen="127.0.0.1:8770" ssh-ed25519 AAAA... collector
   ```
2. On the collector (a key made only for this): `autossh -M 0 -N -o ServerAliveInterval=15
   -o ExitOnForwardFailure=yes -L 8770:127.0.0.1:8770 pitwall-tunnel@<oracle-public-ip>`
   and `SHIP_URL=http://127.0.0.1:8770`.

Uses the SSH port the VM already has open. Either way, the ingest port is never public, and
`ingest.mjs` refuses to start on a public address.

## 4. Turn it on (when you approve)

Backend: `sudo systemctl enable --now pitwall-ingest pitwall-relay pitwall-session.timer pitwall-health.timer pitwall-maintain.timer`

Collector (Linux): `sudo systemctl enable --now pitwall-relay pitwall-shipper pitwall-health.timer`
Collector (Mac): `launchctl load -w ~/Library/LaunchAgents/com.pitwall.relay.plist ~/Library/LaunchAgents/com.pitwall.shipper.plist`

Check from the backend:

```bash
curl -s 127.0.0.1:8770/healthz                     # appends, lastAppendAt
cat /opt/pitwall/data/collectors/*.json             # collector heartbeat: feed, backlog, token expiry
curl -s 127.0.0.1:8765/api/health | head -c 600     # follow.dir, lastLineAgoS
sudo -u pitwall PITWALL_ROLE=backend node /opt/pitwall/tools/health.mjs
```

## 5. Backups

Backend: `RCLONE_REMOTE=` an rclone remote, configured as the pitwall user
(`sudo -u pitwall rclone config`). Oracle Object Storage (Always Free: 20 GB) through its S3
API with a Customer Secret Key, or Cloudflare R2 (free tier 10 GB). The hourly
`pitwall-maintain` compresses finished sessions, copies them, verifies with `rclone check`, and
only then may remove local copies (when disk is low). The collector never compresses or
deletes: its copy is the second one.

## 6. F1 TV sign-in (car positions and telemetry)

Goes on the **collector** (`data/f1tv-token.txt`, mode 600), because the collector is what
connects to F1. Without it, timing is still collected; health says so explicitly. The backend
never needs it. Do not copy it to Oracle expecting that to fix the 403: the 403 happens before
F1's server ever sees a token (docs/BACKEND.md).
