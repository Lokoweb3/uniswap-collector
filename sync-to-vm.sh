#!/usr/bin/env bash
# Pushes the collector's results (state.json, collector.log) to the VM that
# serves the dashboard, so its ops strip shows the last run and gas spend.
# Configured by .env.sync next to this script:
#   LP_SYNC_TARGET=lp@203.0.113.5:/home/lp/uniswap-collector
#   LP_SYNC_KEY=~/.ssh/lp-vm      # key made by deploy-vm.sh
# Silent no-op when unconfigured, so run-collector.sh can always call it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.env.sync" ] || exit 0
set -a; . "$HERE/.env.sync"; set +a
[ -n "${LP_SYNC_TARGET:-}" ] || exit 0
scp -q -o BatchMode=yes -o ConnectTimeout=15 -i "${LP_SYNC_KEY:-$HOME/.ssh/lp-vm}" \
  "$HERE/state.json" "$HERE/collector.log" "$LP_SYNC_TARGET/" \
  || echo "$(date -Is) sync to VM failed" >> "$HERE/collector.log"
