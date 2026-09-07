#!/usr/bin/env bash
# Runs the nightly jobs at 02:00 local time every day. WSL has no cron daemon
# for this user, so start-all.sh keeps one copy of this loop alive instead.
# The crontab entry (crontab -l) mirrors it in case cron is enabled later.
set -u
cd "$(dirname "$0")"
while true; do
  now=$(date +%s)
  next=$(date -d "today 02:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow 02:00" +%s)
  sleep $(( next - now ))
  ./backup-ledgers.sh >> backup.log 2>&1 || echo "$(date -u +%FT%TZ) nightly: backup exited $?" >> backup.log
  sleep 60
done
