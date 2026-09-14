#!/usr/bin/env bash
# Keeps the dashboard up: every 30 s, if nothing listens on :8787, start-all.sh
# brings it back (with LP_RESTARTED_BY=watchdog so the server sends one Telegram
# line). Started by start-all.sh, stopped by stop-all.sh; one instance only.
# Log: watchdog.log next to this script.
#
# A server that dies again within 10 min of a restart is a crash loop (a bad patch, a
# missing module): the restarted process never lives long enough to send its own line,
# so the watchdog sends one itself on the 2nd consecutive restart, then at most once an
# hour while the loop continues. Telegram token/chat come from .env exactly as alerts.js
# reads them; nothing from .env is ever echoed or logged.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
LOG="$HERE/watchdog.log"
STATE="$HERE/watchdog-state.json"   # { count, firstAt, lastAt, alertedAt } epoch seconds
LOOP_WINDOW=600                      # restarts closer than this are one crash loop
ALERT_COOLDOWN=3600
CURL="${WATCHDOG_CURL:-curl}"        # tests replace curl with a stub

read_state() {  # -> COUNT FIRST_AT LAST_AT ALERTED_AT (0 when unknown)
  COUNT=0; FIRST_AT=0; LAST_AT=0; ALERTED_AT=0
  [ -f "$STATE" ] || return 0
  local v
  for k in count firstAt lastAt alertedAt; do
    v=$(sed -n "s/.*\"$k\":[[:space:]]*\([0-9]*\).*/\1/p" "$STATE" | head -1)
    case "$k" in count) COUNT=${v:-0};; firstAt) FIRST_AT=${v:-0};; lastAt) LAST_AT=${v:-0};; alertedAt) ALERTED_AT=${v:-0};; esac
  done
}
write_state() { printf '{"count":%d,"firstAt":%d,"lastAt":%d,"alertedAt":%d}\n' "$COUNT" "$FIRST_AT" "$LAST_AT" "$ALERTED_AT" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"; }

notify() {  # $1 = text; silent no-op when .env has no token/chat
  local token="" chat=""
  if [ -f "$HERE/.env" ]; then
    token=$( (set -a; . "$HERE/.env" 2>/dev/null; printf '%s' "${TELEGRAM_TOKEN:-}") )
    chat=$( (set -a; . "$HERE/.env" 2>/dev/null; printf '%s' "${TELEGRAM_CHAT_ID:-}") )
  fi
  [ -n "$token" ] && [ -n "$chat" ] || { echo "$(date -Is) alert not sent (no Telegram in .env): $1" >> "$LOG"; return 0; }
  "$CURL" -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" \
    && echo "$(date -Is) alert sent: $1" >> "$LOG" \
    || echo "$(date -Is) alert FAILED to send: $1" >> "$LOG"
}

# Called once per restart: counts consecutive restarts and alerts on the 2nd within the window.
record_restart() {
  local now; now=$(date +%s)
  read_state
  if [ "$LAST_AT" -gt 0 ] && [ $((now - LAST_AT)) -le "$LOOP_WINDOW" ]; then
    COUNT=$((COUNT + 1))
  else
    COUNT=1; FIRST_AT=$now
  fi
  LAST_AT=$now
  if [ "$COUNT" -ge 2 ] && [ $((now - ALERTED_AT)) -ge "$ALERT_COOLDOWN" ]; then
    local mins=$(( (now - FIRST_AT + 59) / 60 ))
    notify "⚠️ dashboard restarted ${COUNT}× in ${mins} min — check server.log"
    ALERTED_AT=$now
  fi
  write_state
}

if [ "${1:-}" = "--self-test" ]; then   # exercise the counter with a stub curl and a temp state file
  STATE="$(mktemp)"; LOG="/dev/stdout"; CURL="${WATCHDOG_CURL:-true}"
  record_restart; read_state; echo "after 1: count=$COUNT alertedAt=$ALERTED_AT"
  record_restart; read_state; echo "after 2: count=$COUNT alerted=$([ "$ALERTED_AT" -gt 0 ] && echo yes || echo no)"
  record_restart; read_state; echo "after 3: count=$COUNT (cooldown holds, no second alert)"
  rm -f "$STATE"; exit 0
fi

echo "$(date -Is) watchdog started (pid $$)" >> "$LOG"
while true; do
  sleep 30
  if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8787$'; then
    echo "$(date -Is) dashboard not listening; restarting" >> "$LOG"
    record_restart
    LP_RESTARTED_BY=watchdog LP_RESTART_REASON="not listening on :8787 at $(date +%H:%M)" bash "$HERE/start-all.sh" --no-watchdog >> "$LOG" 2>&1
    sleep 60
  fi
done
