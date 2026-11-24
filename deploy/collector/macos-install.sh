#!/bin/bash
# Makes this Mac a collector: the relay records F1 and the shipper sends it to the backend.
# User-level launchd agents (no sudo). They run while you are logged in and the Mac is awake;
# a sleeping Mac collects nothing (see deploy/README.md: "Mac as collector").
#   bash deploy/collector/macos-install.sh            writes the agents, does not load them
#   launchctl load -w ~/Library/LaunchAgents/com.pitwall.*.plist      start
#   launchctl unload -w ~/Library/LaunchAgents/com.pitwall.*.plist    stop
# Needs, in data/ (never in git):  ingest-secret (same as the backend's)  and  collector.env:
#   SHIP_URL=http://<backend tailscale name>:8770     SHIP_ID=mac
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node)
[ -f "$REPO/data/collector.env" ] || { echo "create $REPO/data/collector.env first (SHIP_URL=..., SHIP_ID=...)"; exit 1; }
[ -f "$REPO/data/ingest-secret" ] || { echo "put the backend's secret in $REPO/data/ingest-secret (chmod 600)"; exit 1; }
chmod 600 "$REPO/data/ingest-secret" "$REPO/data/collector.env"
set -a; . "$REPO/data/collector.env"; set +a
mk() { # label script extra-env-xml
  cat > "$HOME/Library/LaunchAgents/com.pitwall.$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pitwall.$1</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/$2</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PITWALL_ROLE</key><string>collector</string>$3</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$REPO/data/$1.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/$1.log</string>
</dict></plist>
PL
  echo "wrote ~/Library/LaunchAgents/com.pitwall.$1.plist"
}
mk relay server.mjs ""
mk shipper shipper.mjs "<key>SHIP_URL</key><string>$SHIP_URL</string><key>SHIP_ID</key><string>$SHIP_ID</string><key>INGEST_SECRET_FILE</key><string>$REPO/data/ingest-secret</string>"
echo "Not loaded. To start:  launchctl load -w ~/Library/LaunchAgents/com.pitwall.relay.plist ~/Library/LaunchAgents/com.pitwall.shipper.plist"
echo "If you already run 'node server.mjs' yourself, load only the shipper (it ships whatever that relay records)."
