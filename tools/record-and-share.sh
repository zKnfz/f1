#!/bin/bash
# Records the F1 session that is on now (or about to start) and shares what the site learned.
# Run it from a computer on a normal home connection: F1 refuses connections from GitHub's
# own servers, so this cannot run as a GitHub Actions job.
#
#   tools/record-and-share.sh          record if a session is on, then commit and push learned/
#   tools/record-and-share.sh --test   only check that the recorder can reach the F1 feed
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules/playwright-core ] || npm install --no-save --no-package-lock playwright-core

if [ "${1:-}" = "--test" ]; then node tools/record.mjs --test; exit $?; fi

check=$(node tools/session-check.mjs)
echo "$check"
case "$check" in *'"record":true'*) ;; *) exit 0 ;; esac
wait=$(echo "$check" | sed -E 's/.*"wait":([0-9]+).*/\1/')
max=$(echo "$check" | sed -E 's/.*"max":([0-9]+).*/\1/')
name=$(echo "$check" | sed -E 's/.*"name":"([^"]*)".*/\1/')

node tools/record.mjs --wait="$wait" --max="$max" || true

git add learned
if git diff --cached --quiet; then echo "Nothing new to share."; exit 0; fi
git commit -q -m "Recorder: $name"
git pull -q --rebase
GIT_TERMINAL_PROMPT=0 git push -q
echo "Shared what was learned from: $name"
