#!/usr/bin/env bash
# Keeps the dashboard up: every 30 s, if nothing listens on :8787, start-all.sh
# brings it back (with LP_RESTARTED_BY=watchdog so the server sends one Telegram
# line). Started by start-all.sh, stopped by stop-all.sh; one instance only.
# Log: watchdog.log next to this script.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
LOG="$HERE/watchdog.log"
echo "$(date -Is) watchdog started (pid $$)" >> "$LOG"
while true; do
  sleep 30
  if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8787$'; then
    echo "$(date -Is) dashboard not listening; restarting" >> "$LOG"
    LP_RESTARTED_BY=watchdog LP_RESTART_REASON="not listening on :8787 at $(date +%H:%M)" bash "$HERE/start-all.sh" --no-watchdog >> "$LOG" 2>&1
    sleep 60
  fi
done
