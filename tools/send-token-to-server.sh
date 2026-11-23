#!/bin/bash
# Copies your F1 TV sign-in from this Mac (data/f1tv-token.txt) to the recorder server, readable
# only by the recorder. Never commit the token; it is only ever in data/ (gitignored).
#   tools/send-token-to-server.sh ubuntu@<server address> [ssh key file]
set -euo pipefail
cd "$(dirname "$0")/.."
host=${1:?usage: tools/send-token-to-server.sh ubuntu@<server> [key]}
key=${2:+-i $2}
[ -s data/f1tv-token.txt ] || { echo "no data/f1tv-token.txt here: sign in first (see README, F1 TV)"; exit 1; }
remote=/tmp/pitwall-token-$$
# shellcheck disable=SC2086
scp -q $key data/f1tv-token.txt "$host:$remote"
# shellcheck disable=SC2086
ssh $key "$host" "sudo install -o pitwall -g pitwall -m 600 $remote /opt/pitwall/data/f1tv-token.txt && rm -f $remote && sudo systemctl restart pitwall-relay.service && echo 'token installed, relay restarted'"
