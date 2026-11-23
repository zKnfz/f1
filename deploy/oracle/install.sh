#!/bin/bash
# Installs the Pitwall recorder on an Ubuntu 22.04/24.04 server (ARM64 or x86-64), e.g. an
# Oracle Cloud "Always Free" Ampere A1 instance. Run as root, once; safe to run again to update.
#   sudo bash install.sh
# It does not open any ports: the relay listens on 127.0.0.1 only.
set -euo pipefail
NODE_VERSION=22.23.3          # same as the Mac it was tested on
PLAYWRIGHT_VERSION=1.65.1     # same as the Mac
REPO=https://github.com/zKnfz/f1.git
APP=/opt/pitwall
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
case "$(uname -m)" in aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates xz-utils rclone logrotate chrony unattended-upgrades
timedatectl set-timezone UTC          # all timestamps are UTC anyway; keeps logs readable
systemctl enable --now chrony         # an accurate clock matters: every frame is time-stamped

echo "== Node $NODE_VERSION ($ARCH), checked against nodejs.org's published checksum"
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d); cd "$tmp"
  f="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$f"
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  grep " $f\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "$f" -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
  cd /; rm -rf "$tmp"
fi
node -v

echo "== user and code"
id pitwall >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/pitwall --shell /usr/sbin/nologin pitwall
if [ ! -d "$APP/.git" ]; then git clone -q "$REPO" "$APP"; fi
chown -R pitwall:pitwall "$APP"
sudo -u pitwall git -C "$APP" pull -q --ff-only || echo "(git pull failed; keeping the current code)"
install -d -o pitwall -g pitwall -m 700 "$APP/data"

echo "== headless browser (Playwright's Chromium; Google Chrome has no Linux ARM build)"
cd "$APP"
sudo -u pitwall npm install -q --no-save --no-package-lock "playwright-core@$PLAYWRIGHT_VERSION"
PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" npx -y "playwright-core@$PLAYWRIGHT_VERSION" install-deps chromium
sudo -u pitwall PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" npx -y "playwright-core@$PLAYWRIGHT_VERSION" install chromium

echo "== configuration"
install -d -m 750 -o root -g pitwall /etc/pitwall
[ -f /etc/pitwall/pitwall.env ] || install -m 640 -o root -g pitwall deploy/oracle/pitwall.env.example /etc/pitwall/pitwall.env
install -m 440 -o root -g root deploy/oracle/sudoers /etc/sudoers.d/pitwall
visudo -cf /etc/sudoers.d/pitwall
install -m 644 deploy/oracle/logrotate /etc/logrotate.d/pitwall
install -m 644 deploy/oracle/systemd/*.service deploy/oracle/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload

echo "== self-test (stand-in F1 feed: record, crash, restart, replay, compress)"
sudo -u pitwall PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" node tools/selftest-recording.mjs

echo "== services"
systemctl enable --now pitwall-relay.service pitwall-session.timer pitwall-health.timer pitwall-maintain.timer
sleep 8
systemctl --no-pager --lines=0 status pitwall-relay.service | head -5
curl -s http://127.0.0.1:8765/api/health; echo
echo
echo "Installed. Next: put your F1 TV sign-in on the server (see deploy/oracle/README.md),"
echo "then run:  sudo -u pitwall node /opt/pitwall/tools/server-preflight.mjs"
