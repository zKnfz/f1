#!/bin/bash
# Installs the Pitwall recorder on an Ubuntu 22.04/24.04 server (ARM64 or x86-64), e.g. an
# Oracle Cloud "Always Free" Ampere A1 instance. Run as root, once; safe to run again to update.
#   sudo PITWALL_ROLE=backend bash install.sh      Oracle: data arrives from a collector (ingest)
#   sudo PITWALL_ROLE=collector bash install.sh    a machine F1 allows: relay + shipper to the backend
#   sudo PITWALL_ROLE=standalone bash install.sh   one machine that reaches F1 itself (the original setup)
# It installs and checks everything but does NOT enable or start any service, unless
# ENABLE_SERVICES=1 is given: it prints the commands instead.
# It does not open any ports: the relay listens on 127.0.0.1, ingest on localhost or a Tailscale IP.
set -euo pipefail
NODE_VERSION=22.23.3          # same as the Mac it was tested on
PLAYWRIGHT_VERSION=1.65.1     # same as the Mac
REPO=https://github.com/zKnfz/f1.git
APP=/opt/pitwall
ROLE=${PITWALL_ROLE:-}
case "$ROLE" in backend|collector|standalone) ;; *) echo "set PITWALL_ROLE=backend, collector or standalone"; exit 1 ;; esac
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
# Log files belong to the recorder (systemd would otherwise create them as root, and the
# recorder and logrotate could not write or rotate them).
for f in relay session maintain health ingest shipper; do touch "$APP/data/$f.log"; chown pitwall:pitwall "$APP/data/$f.log"; chmod 640 "$APP/data/$f.log"; done

echo "== headless browser (Playwright's Chromium; Google Chrome has no Linux ARM build)"
cd "$APP"
sudo -u pitwall npm install -q --no-save --no-package-lock "playwright-core@$PLAYWRIGHT_VERSION"
PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" npx -y "playwright-core@$PLAYWRIGHT_VERSION" install-deps chromium
sudo -u pitwall PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" npx -y "playwright-core@$PLAYWRIGHT_VERSION" install chromium

echo "== configuration"
install -d -m 750 -o root -g pitwall /etc/pitwall
if [ ! -f /etc/pitwall/pitwall.env ]; then
  install -m 640 -o root -g pitwall deploy/oracle/pitwall.env.example /etc/pitwall/pitwall.env
  sed -i "s/^PITWALL_ROLE=.*/PITWALL_ROLE=$ROLE/" /etc/pitwall/pitwall.env
fi
grep -q "^PITWALL_ROLE=$ROLE\$" /etc/pitwall/pitwall.env || echo "NOTE: /etc/pitwall/pitwall.env has a different PITWALL_ROLE than $ROLE; check it"
# The shared secret for collector → backend (same value on both; generated once on the backend,
# copied to the collector by you). Never in git, never printed.
if [ "$ROLE" = backend ] && [ ! -f /etc/pitwall/ingest-secret ]; then
  umask 077; openssl rand -hex 32 > /etc/pitwall/ingest-secret; umask 022
  echo "generated /etc/pitwall/ingest-secret (copy it to the collector over SSH; see deploy/README.md)"
fi
[ -f /etc/pitwall/ingest-secret ] && chown root:pitwall /etc/pitwall/ingest-secret && chmod 640 /etc/pitwall/ingest-secret
install -m 440 -o root -g root deploy/oracle/sudoers /etc/sudoers.d/pitwall
visudo -cf /etc/sudoers.d/pitwall
install -m 644 deploy/oracle/logrotate /etc/logrotate.d/pitwall
install -m 644 deploy/oracle/systemd/*.service deploy/oracle/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload

echo "== self-test (stand-in F1 feed: record, crash, restart, replay, compress)"
sudo -u pitwall PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" node tools/selftest-recording.mjs

echo "== F1 reachability from this network (informational)"
sudo -u pitwall node tools/f1-net-preflight.mjs || true

case "$ROLE" in
  backend)    UNITS="pitwall-ingest.service pitwall-relay.service pitwall-session.timer pitwall-health.timer pitwall-maintain.timer" ;;
  collector)  UNITS="pitwall-relay.service pitwall-shipper.service pitwall-health.timer" ;;
  standalone) UNITS="pitwall-relay.service pitwall-session.timer pitwall-health.timer pitwall-maintain.timer" ;;
esac
echo "== services ($ROLE)"
if [ "${ENABLE_SERVICES:-0}" = 1 ]; then
  systemctl enable --now $UNITS
  sleep 8; systemctl --no-pager --lines=0 status $UNITS | grep -E "●|Active" || true
else
  echo "Not enabled (nothing was started). When you are ready:"
  echo "  sudo systemctl enable --now $UNITS"
fi
echo
echo "Installed as $ROLE. See deploy/README.md for the next steps."
