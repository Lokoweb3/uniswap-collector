#!/usr/bin/env bash
# Runs the collector, sourcing the passphrase from the RAM cache when one is
# live, otherwise prompting. Clears it from the environment on exit.
#
#   ./run-collector.sh simulate
#   ./run-collector.sh collect
#   ./run-collector.sh full
#   ./run-collector.sh full --quiet    # for timers: never prompt, skip if locked

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:-simulate}"
shift || true
QUIET=""
# === pool-scout-and-IL: --compound reinvests fees into the same position (see compound.js) ===
COMPOUND=""
for a in "$@"; do
  case "$a" in
    --quiet) QUIET="--quiet" ;;
    --compound) COMPOUND="--compound" ;;
    *) echo "Usage: $0 {simulate|collect|full} [--quiet] [--compound]" >&2; exit 1 ;;
  esac
done
# === end pool-scout-and-IL ===
case "$MODE" in simulate|collect|full) ;; *)
  echo "Usage: $0 {simulate|collect|full} [--quiet] [--compound]" >&2; exit 1 ;;
esac

if [ "$MODE" = "simulate" ]; then
  exec node "$HERE/collector.js" "--mode=$MODE" $COMPOUND
fi

# One signing run at a time. The 09:00 task, the dashboard button and the
# memecoin auto-collect loop all start this script; a second run while one is
# in flight would race the operator's nonce. The lock is released when the
# holder exits (the fd closes), so a crash cannot leave it stuck.
LOCK="$HERE/.collector.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) another collector run is in progress; skipping this $MODE run." | tee -a "$HERE/collector.log"
  exit 0
fi

KEYSTORE="$HOME/.lp-collector/operator-keystore.json"
[ -f "$KEYSTORE" ] || { echo "No keystore. Run ./setup-key.sh first." >&2; exit 1; }

CACHE="/dev/shm/.lp-collector-$(id -u)"
PASS=""

if [ -f "$CACHE" ] && [ -f "$CACHE.ttl" ]; then
  if [ "$(date +%s)" -lt "$(cat "$CACHE.ttl")" ]; then
    PASS="$(cat "$CACHE")"
  else
    rm -f "$CACHE" "$CACHE.ttl"
    echo "Unlock window expired; the cached passphrase was discarded."
  fi
fi

if [ -z "$PASS" ]; then
  if [ "$QUIET" = "--quiet" ] || [ ! -t 0 ]; then
    echo "$(date -Is) locked, skipping $MODE run. Run ./unlock.sh to arm it." \
      | tee -a "$HERE/collector.log"
    "$HERE/sync-to-vm.sh" || true
    exit 0
  fi
  read -r -s -p "Operator passphrase: " PASS; echo
fi

cleanup(){ unset LP_KEYSTORE_PASS LP_KEYSTORE_PATH PASS; "$HERE/sync-to-vm.sh" || true; }
trap cleanup EXIT INT TERM

LP_KEYSTORE_PATH="$KEYSTORE" LP_KEYSTORE_PASS="$PASS" \
  node "$HERE/collector.js" "--mode=$MODE" $COMPOUND
