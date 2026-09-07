#!/usr/bin/env bash
# Unlocks the operator keystore for a limited window.
#
# The passphrase is held in /dev/shm (RAM-backed, never written to disk) with a
# time-to-live. Scheduled runs inside the window proceed unattended; runs after
# it expires skip and log, rather than falling back to a passphrase at rest.
#
#   ./unlock.sh          unlock for the default TTL
#   ./unlock.sh 240      unlock for 240 minutes
#   ./unlock.sh --lock   forget it now

set -euo pipefail

TTL_MIN="${1:-120}"
CACHE="/dev/shm/.lp-collector-$(id -u)"

if [ "$TTL_MIN" = "--lock" ]; then
  rm -f "$CACHE" "$CACHE.ttl"
  echo "Locked. The passphrase is no longer cached."
  exit 0
fi

if ! [ -d /dev/shm ]; then
  echo "/dev/shm is unavailable, so there is nowhere RAM-backed to cache." >&2
  echo "Run the collector interactively instead: ./run-collector.sh simulate" >&2
  exit 1
fi

KEYSTORE="$HOME/.lp-collector/operator-keystore.json"
[ -f "$KEYSTORE" ] || { echo "No keystore. Run ./setup-key.sh first." >&2; exit 1; }

read -r -s -p "Operator passphrase: " PASS; echo

# Verify before caching, so a typo surfaces now rather than at 9am.
if ! LP_VERIFY_PASS="$PASS" node -e '
const fs=require("fs"),{ethers}=require("ethers");
ethers.Wallet.fromEncryptedJson(fs.readFileSync(process.argv[1],"utf8"),process.env.LP_VERIFY_PASS)
  .then(w=>{console.log("Unlocked "+w.address);})
  .catch(()=>{console.error("Wrong passphrase.");process.exit(1);});
' "$KEYSTORE"; then
  unset PASS
  exit 1
fi

umask 077
printf '%s' "$PASS" > "$CACHE"
chmod 600 "$CACHE"
date -d "+${TTL_MIN} minutes" +%s > "$CACHE.ttl" 2>/dev/null || \
  echo $(( $(date +%s) + TTL_MIN * 60 )) > "$CACHE.ttl"
chmod 600 "$CACHE.ttl"
unset PASS

echo "Cached in RAM for ${TTL_MIN} minutes. ./unlock.sh --lock to forget it sooner."
