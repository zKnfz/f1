#!/bin/bash
# Linux server (systemd) counterpart of tools/record-and-share.sh. Run by pitwall-session.timer
# every 5 minutes. The relay itself runs all the time as pitwall-relay.service, so this only
# runs the recorder's page (the site's predictions, recorded to page.jsonl) during sessions.
#   1. Is a session on, or starting within 25 min? If not, exit.
#   2. Bring the code up to date with GitHub first (so the predictions recorded are the ones the
#      live site shows), and restart the relay if its own code changed (only before a session).
#   3. Run the page for the session, then check the recording.
#   4. If SHARE_LEARNED=1 (and the server can push to GitHub), share what was learned.
set -uo pipefail
cd "$(dirname "$0")/.."
export PITWALL_DATA="${PITWALL_DATA:-$PWD/data}"
mkdir -p "$PITWALL_DATA"
export SCHEDULE_CACHE="$PITWALL_DATA/schedule-cache.json"

check=$(node tools/session-check.mjs)
case "$check" in *'"record":true'*) ;; *) exit 0 ;; esac
wait=$(echo "$check" | sed -E 's/.*"wait":([0-9]+).*/\1/')
max=$(echo "$check" | sed -E 's/.*"max":([0-9]+).*/\1/')
name="$(echo "$check" | sed -E 's/.*"name":"([^"]*)".*/\1/') $(date -u +%Y)"
grep -qxF "$name" "$PITWALL_DATA/recorded.txt" 2>/dev/null && exit 0
echo "$(date -u +%FT%TZ) session: $name (wait ${wait} min, at most ${max} min)"

if [ "${AUTO_UPDATE:-1}" = "1" ]; then
  before=$(git rev-parse HEAD)
  if git pull -q --ff-only 2>&1; then
    after=$(git rev-parse HEAD)
    if [ "$before" != "$after" ]; then
      echo "updated $before → $after"
      if git diff --name-only "$before" "$after" | grep -qE '^(server|recorder|kalshi)\.mjs$'; then
        sudo -n systemctl restart pitwall-relay.service && echo "relay restarted for the new code"
      fi
    fi
  else echo "git pull failed; recording with the code already here"; fi
fi

node tools/record.mjs --wait="$wait" --max="$max"
grep -q '"note": "session over"' "$PITWALL_DATA/last-run.json" 2>/dev/null && echo "$name" >> "$PITWALL_DATA/recorded.txt"
node tools/recording-report.mjs || true

if [ "${SHARE_LEARNED:-0}" = "1" ]; then
  # Nothing reaches the public site unless it passes the checks (kept here, not shared, if not).
  if ! node tools/validate-learned.mjs; then echo "learned/ failed validation: NOT shared"; exit 0; fi
  git add learned
  if ! git diff --cached --quiet; then
    git -c user.name="pitwall recorder" -c user.email="recorder@localhost" commit -q -m "Recorder (server): $name" -- learned
    git pull -q --rebase && GIT_TERMINAL_PROMPT=0 git push -q && echo "shared what was learned"
  fi
fi
exit 0
