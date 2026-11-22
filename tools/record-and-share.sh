#!/bin/bash
# Records the F1 session that is on now (or about to start) and shares what the site learned.
# Run it from a computer on a normal home connection: F1 refuses connections from GitHub's
# own servers, so this cannot run as a GitHub Actions job.
#
#   tools/record-and-share.sh          record if a session is on, then commit and push learned/
#   tools/record-and-share.sh --test   only check that the recorder can reach the F1 feed
#
# Safe to run every 15 minutes from a scheduler: it exits straight away when no session is on,
# and it will not record the same session twice. It also starts the local relay (server.mjs)
# for each session and stops it afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

# A scheduler starts with a bare PATH, so find git and a recent Node ourselves.
# Prefer the newest Node installed with nvm; an old system Node cannot run the recorder.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
newest=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
[ -n "$newest" ] && export PATH="$newest:$PATH"
command -v node >/dev/null || { echo "$(date) Node not found"; exit 1; }
if [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" != "true" ]; then echo "$(date) Node $(node -v) is too old (need 18 or newer)"; exit 1; fi

[ -d node_modules/playwright-core ] || npm install --no-save --no-package-lock playwright-core

if [ "${1:-}" = "--test" ]; then node tools/record.mjs --test; exit $?; fi

check=$(node tools/session-check.mjs)

# The local relay (server.mjs, http://127.0.0.1:8765) follows the F1 schedule too: started from
# 25 minutes before a session until it is over, then stopped. Only a relay this script started
# (data/relay.pid) is ever stopped, so one you start yourself is left alone.
mkdir -p data
relay_pid() { [ -f data/relay.pid ] && kill -0 "$(cat data/relay.pid)" 2>/dev/null && cat data/relay.pid; }
case "$check" in
  *'"record":true'*)
    if ! lsof -ti tcp:8765 >/dev/null 2>&1; then
      nohup node server.mjs >> data/relay.log 2>&1 &
      echo $! > data/relay.pid
      echo "$(date) Relay started (pid $!)"
    fi ;;
  *'schedule unavailable'*) ;; # don't stop anything on a failed schedule lookup
  *)
    if pid=$(relay_pid); then kill "$pid" && echo "$(date) Relay stopped (no session on)"; rm -f data/relay.pid; fi ;;
esac

case "$check" in *'"record":true'*) ;; *) exit 0 ;; esac
wait=$(echo "$check" | sed -E 's/.*"wait":([0-9]+).*/\1/')
max=$(echo "$check" | sed -E 's/.*"max":([0-9]+).*/\1/')
name="$(echo "$check" | sed -E 's/.*"name":"([^"]*)".*/\1/') $(date -u +%Y)"

mkdir -p data
if grep -qxF "$name" data/recorded.txt 2>/dev/null; then exit 0; fi
echo "$(date) Recording: $name (wait ${wait} min, at most ${max} min)"

# Keep the Mac from going to sleep on its own while recording (a closed lid still sleeps it).
keep=""; command -v caffeinate >/dev/null && keep="caffeinate -i"
$keep node tools/record.mjs --wait="$wait" --max="$max" || true
grep -q '"note": "session over"' data/last-run.json 2>/dev/null && echo "$name" >> data/recorded.txt

git add learned
if git diff --cached --quiet; then echo "$(date) Nothing new to share."; exit 0; fi
git commit -q -m "Recorder: $name" -- learned
git pull -q --rebase --autostash
GIT_TERMINAL_PROMPT=0 git push -q
echo "$(date) Shared what was learned from: $name"
