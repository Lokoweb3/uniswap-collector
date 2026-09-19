#!/usr/bin/env bash
# run-collector-arc.sh — the collector, pointed at the Arc instance.
#
# Robinhood's recurring run is not a cron entry: memecoin-collect.js calls
# run-collector.sh from a timer inside the dashboard process, and that timer only
# exists when the process is the main one (port 8787, not LP_READONLY, not
# --no-loops). The Arc viewer is all three of those things on purpose -- a
# read-only page on its own port -- so it cannot carry the schedule. A cron entry
# calling this script is the equivalent for Arc.
#
#   ./run-collector-arc.sh                  # simulate: reads, signs nothing
#   ./run-collector-arc.sh full --quiet     # what a timer would run
#
# ARMING: run-collector.sh takes the passphrase from the /dev/shm unlock cache and
# skips when it has expired, rather than keeping a passphrase at rest. So a cron
# entry alone does not make Arc collect unattended: it collects during an unlock
# window and logs a skip outside one. `./unlock.sh 240` arms it for four hours.
#
# The lock in run-collector.sh is one-at-a-time across the whole checkout, so an Arc
# run can land while Robinhood's 15-minute timer holds it. A single attempt would
# then skip the day entirely, so this retries a few times before giving up.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${LP_ARC_DATA_DIR:-$HOME/arc-data}"
MODE="${1:-simulate}"
shift || true

[ -f "$DATA/settings.json" ] || { echo "no Arc settings at $DATA/settings.json" >&2; exit 1; }
LOG="$DATA/collector.log"

for attempt in 1 2 3; do
  out="$(LP_DATA_DIR="$DATA" "$HERE/run-collector.sh" "$MODE" "$@" 2>&1)" && status=0 || status=$?
  printf '%s\n' "$out" | tee -a "$LOG"
  # "another collector run is in progress" is the only case worth retrying: every
  # other outcome, including a skip because the window is locked, is final.
  if printf '%s' "$out" | grep -q "another collector run is in progress"; then
    [ "$attempt" -lt 3 ] || { echo "$(date -Is) arc: gave up after 3 attempts, the collector was busy each time" | tee -a "$LOG"; exit 0; }
    sleep 120
    continue
  fi
  exit "$status"
done
