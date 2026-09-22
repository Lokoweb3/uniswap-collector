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
#
# Liveness from OUTSIDE the MACHINE: a dashboard that answers on loopback is not a site
# anyone can reach. See the public probe below.
#
# Liveness from OUTSIDE the process (TASK-66): a port that answers is not a dashboard that
# works. Every 60 s the watchdog fetches /api/positions with a 20 s limit and reads its
# `loops` block. Two timeouts in a row = a wedged event loop → one Telegram line and a
# restart. A loop reporting stale for more than 2 probes → one Telegram line (1 h cooldown),
# no restart: the process is alive, something inside it is not, and server.log has the why.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
LOG="$HERE/watchdog.log"
STATE="$HERE/watchdog-state.json"   # { count, firstAt, lastAt, alertedAt, probeAlertedAt } epoch seconds
PROBE_URL="http://127.0.0.1:8787/api/positions"
PROBE_EVERY=2                        # cycles of 30 s between probes
LOOP_WINDOW=600                      # restarts closer than this are one crash loop
ALERT_COOLDOWN=3600
CURL="${WATCHDOG_CURL:-curl}"        # tests replace curl with a stub
DASH_PORT="${WATCHDOG_PORT:-8787}"   # the self-test points this at an owned stub listener
START_ALL="${WATCHDOG_START_ALL:-}"  # the self-test replaces start-all.sh with a stub command

# The pid listening on the dashboard port (the same lookup stop-all.sh uses).
dash_pid() { ss -ltnp 2>/dev/null | awk -v p=":${DASH_PORT} " 'index($0, p) { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1; }
# Recovery kills ONLY the dashboard process and starts it again. Never stop-all.sh: that
# script kills this watchdog first (and the dashboard after it), so a wedged probe used to
# end with nothing running and no supervisor (TASK-85).
stop_dashboard() {
  local pid i; pid=$(dash_pid); [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null
  for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  kill -9 "$pid" 2>/dev/null; return 0
}
start_dashboard() {  # $1 = reason for the server's own "restarted by watchdog" line
  if [ -n "$START_ALL" ]; then $START_ALL; else LP_RESTARTED_BY=watchdog LP_RESTART_REASON="$1" bash "$HERE/start-all.sh" --no-watchdog; fi
}

read_state() {  # -> COUNT FIRST_AT LAST_AT ALERTED_AT PROBE_ALERTED_AT (0 when unknown)
  COUNT=0; FIRST_AT=0; LAST_AT=0; ALERTED_AT=0; PROBE_ALERTED_AT=0
  [ -f "$STATE" ] || return 0
  local v
  for k in count firstAt lastAt alertedAt probeAlertedAt; do
    v=$(sed -n "s/.*\"$k\":[[:space:]]*\([0-9]*\).*/\1/p" "$STATE" | head -1)
    case "$k" in count) COUNT=${v:-0};; firstAt) FIRST_AT=${v:-0};; lastAt) LAST_AT=${v:-0};; alertedAt) ALERTED_AT=${v:-0};; probeAlertedAt) PROBE_ALERTED_AT=${v:-0};; esac
  done
}
write_state() { printf '{"count":%d,"firstAt":%d,"lastAt":%d,"alertedAt":%d,"probeAlertedAt":%d}\n' "$COUNT" "$FIRST_AT" "$LAST_AT" "$ALERTED_AT" "$PROBE_ALERTED_AT" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"; }

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

# --- public path probe --------------------------------------------------------------------
# Everything above watches the dashboard from this machine. None of it can see the failure
# that took the site down on 2026-09-21: every local port answered, `tailscale funnel status`
# listed every mapping, the serve config was right and the cert was valid, while the public
# address answered nothing for hours. The node's Funnel ingress registration had gone stale
# after the machine's public IP changed; requests reached the relay and were never forwarded.
# Tailing tailscaled.log during a request showed no new lines at all. Only restarting the
# daemon fixed it, so that -- not a dashboard restart -- is this probe's recovery.
#
# It is deliberately slower and more patient than the local probe: the public path crosses a
# relay, and ingress takes ~25 s to propagate after a restart, so a single failure means
# nothing. Three in a row, 5 min apart, is a real outage.
PUBLIC_URL="${WATCHDOG_PUBLIC_URL:-}"
PUBLIC_EVERY="${WATCHDOG_PUBLIC_EVERY:-10}"     # cycles of 30 s between public probes
PUBLIC_MIN_FAILS="${WATCHDOG_PUBLIC_FAILS:-3}"  # consecutive failures before acting
PUBLIC_REPAIR_GAP="${WATCHDOG_PUBLIC_GAP:-1800}" # never restart the tunnel twice within this
PUBLIC_FAILS=0
PUBLIC_REPAIRED_AT=0
TS_BIN="${WATCHDOG_TS_BIN:-$HOME/.local/tailscale/tailscale}"
TS_SOCK="${WATCHDOG_TS_SOCK:-$HOME/.local/state/tailscale/tailscaled.sock}"

# Read the address from the funnel config rather than keeping a copy in step with it.
# No tailscale, or no public mapping, leaves PUBLIC_URL empty and the probe a no-op.
discover_public_url() {
  [ -n "$PUBLIC_URL" ] && return 0
  [ -x "$TS_BIN" ] || return 0
  PUBLIC_URL=$("$TS_BIN" --socket="$TS_SOCK" funnel status 2>/dev/null \
    | sed -n 's|^\(https://[^ ]*:8443\).*|\1|p' | head -1)
  [ -n "$PUBLIC_URL" ] && echo "$(date -Is) public probe watching $PUBLIC_URL" >> "$LOG"
}

# Restart the tunnel daemon and re-apply the serve config. Never touches the dashboard:
# the dashboard was never the fault in the outage this exists for.
repair_tunnel() {
  local pid i
  pid=$(pgrep -x tailscaled 2>/dev/null | head -1)   # -x: exact name, never a pattern match
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    for i in $(seq 1 20); do pgrep -x tailscaled >/dev/null 2>&1 || break; sleep 1; done
  fi
  bash "$HERE/run-tailscale.sh" >> "$LOG" 2>&1
}

# public_probe: one fetch through the relay, exactly as a browser does.
public_probe() {
  [ -n "$PUBLIC_URL" ] || return 0
  local code now
  # The gate answers 200 with its login page to a browser-shaped request. Any HTTP status
  # means the path works; "000" (no answer, or TLS that never completed) is the failure.
  code=$("$CURL" -s -o /dev/null -w '%{http_code}' -m 25 -H 'Accept: text/html' "$PUBLIC_URL/" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    [ "$PUBLIC_FAILS" -gt 0 ] && echo "$(date -Is) public path answering again (HTTP $code)" >> "$LOG"
    PUBLIC_FAILS=0
    return 0
  fi
  PUBLIC_FAILS=$((PUBLIC_FAILS + 1))
  echo "$(date -Is) public probe failed (${PUBLIC_FAILS}x in a row) $PUBLIC_URL" >> "$LOG"
  [ "$PUBLIC_FAILS" -ge "$PUBLIC_MIN_FAILS" ] || return 0
  now=$(date +%s)
  if [ $((now - PUBLIC_REPAIRED_AT)) -lt "$PUBLIC_REPAIR_GAP" ]; then
    echo "$(date -Is) public path still down, but the tunnel was restarted recently; leaving it" >> "$LOG"
    PUBLIC_FAILS=0
    return 0
  fi
  read_state
  if [ $((now - PROBE_ALERTED_AT)) -ge "$ALERT_COOLDOWN" ]; then
    notify "⚠️ $PUBLIC_URL stopped answering (${PUBLIC_FAILS} probes) while the dashboard itself is up — restarting the tunnel"
    PROBE_ALERTED_AT=$now; write_state
  fi
  echo "$(date -Is) public path down; restarting tailscaled and re-applying the funnel" >> "$LOG"
  repair_tunnel
  PUBLIC_REPAIRED_AT=$now
  PUBLIC_FAILS=0
}

# --- liveness probe -----------------------------------------------------------------------
PROBE_TIMEOUTS=0; PROBE_STALE=0
# stale_loops BODY -> prints "label (N min)" per stale loop, one per line; empty when healthy.
stale_loops() {
  printf '%s' "$1" | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
      let j; try { j = JSON.parse(d); } catch { process.exit(2); }
      const loops = j && j.loops && typeof j.loops === "object" ? j.loops : {};
      for (const [k, v] of Object.entries(loops)) if (v && v.stale) console.log(`${v.label || k} (${Math.round(v.ageMin || 0)} min)`);
    });' 2>/dev/null
}
# check_probe STATUS BODY: STATUS is curl's exit code (0 = answered). Updates the counters,
# alerts and restarts as documented above. Returns 0; RESTART_NOW=1 asks the loop to restart.
check_probe() {
  local status="$1" body="$2" now; now=$(date +%s); RESTART_NOW=0
  if [ "$status" != "0" ] || [ -z "$body" ]; then
    PROBE_TIMEOUTS=$((PROBE_TIMEOUTS + 1))
    echo "$(date -Is) probe failed (${PROBE_TIMEOUTS}× in a row, curl exit $status)" >> "$LOG"
    if [ "$PROBE_TIMEOUTS" -ge 2 ]; then
      read_state
      if [ $((now - PROBE_ALERTED_AT)) -ge "$ALERT_COOLDOWN" ]; then notify "⚠️ dashboard is listening but not answering (2 probes timed out) — restarting"; PROBE_ALERTED_AT=$now; write_state; fi
      PROBE_TIMEOUTS=0; RESTART_NOW=1
    fi
    return 0
  fi
  PROBE_TIMEOUTS=0
  local stale; stale=$(stale_loops "$body")
  if [ -z "$stale" ]; then PROBE_STALE=0; return 0; fi
  PROBE_STALE=$((PROBE_STALE + 1))
  if [ "$PROBE_STALE" -gt 2 ]; then
    read_state
    if [ $((now - PROBE_ALERTED_AT)) -ge "$ALERT_COOLDOWN" ]; then
      notify "⚠️ loop stale: $(printf '%s' "$stale" | paste -sd ',' -) — the dashboard is up but this loop stopped reporting; check server.log"
      PROBE_ALERTED_AT=$now; write_state
    else
      echo "$(date -Is) loop still stale (alert cooldown): $(printf '%s' "$stale" | paste -sd ',' -)" >> "$LOG"
    fi
  fi
}
probe() {  # fetch once; feeds check_probe
  local body status
  body=$("$CURL" -s -m 20 "$PROBE_URL"); status=$?
  check_probe "$status" "$body"
}

if [ "${1:-}" = "--self-test" ]; then   # exercise the counters with a stub curl and a temp state file
  STATE="$(mktemp)"; CURL="${WATCHDOG_CURL:-true}"
  # A temp file, not /dev/stdout: under a pipe (the test runner) that device cannot be
  # opened and every log line became a "No such device or address" error instead.
  LOG="$(mktemp)"; SELFTEST_LOG="$LOG"
  record_restart; read_state; echo "after 1: count=$COUNT alertedAt=$ALERTED_AT"
  record_restart; read_state; echo "after 2: count=$COUNT alerted=$([ "$ALERTED_AT" -gt 0 ] && echo yes || echo no)"
  record_restart; read_state; echo "after 3: count=$COUNT (cooldown holds, no second alert)"
  echo "--- probe"
  HEALTHY='{"ok":true,"loops":{"guardian":{"ageMin":1,"staleAfterMin":10,"stale":false,"label":"risk guardian"}}}'
  STALE='{"ok":true,"loops":{"guardian":{"ageMin":1,"stale":false,"label":"risk guardian"},"autoCollect":{"ageMin":52,"staleAfterMin":45,"stale":true,"label":"fee auto-collect"}}}'
  check_probe 0 "$HEALTHY"; echo "healthy: stale=$PROBE_STALE timeouts=$PROBE_TIMEOUTS (nothing sent)"
  check_probe 0 "$STALE"; check_probe 0 "$STALE"; echo "stale x2: stale=$PROBE_STALE (not yet)"
  check_probe 0 "$STALE"; read_state; echo "stale x3: alerted=$([ "$PROBE_ALERTED_AT" -gt 0 ] && echo yes || echo no)"
  check_probe 0 "$STALE"; echo "stale x4 within the hour: no second alert (see 'cooldown' line above)"
  check_probe 0 "$HEALTHY"; echo "healthy again: stale=$PROBE_STALE"
  check_probe 28 ""; echo "timeout 1: restart=$RESTART_NOW"; check_probe 28 ""; echo "timeout 2: restart=$RESTART_NOW (cooldown holds the message, restart still requested)"
  echo "--- public probe (nothing real is touched: repair_tunnel and curl are stubbed)"
  REPAIR_LOG="$(mktemp)"
  repair_tunnel() { echo called >> "$REPAIR_LOG"; }
  # CURL is a command NAME held in a variable, so the stub has to be pointed at by it;
  # defining a function called CURL alone leaves "$CURL" still running the real thing.
  stubcurl() { printf '%s' "$PUBCODE"; }
  CURL_SAVED="$CURL"; CURL=stubcurl
  PUBLIC_URL="https://example.invalid:8443"; PUBLIC_MIN_FAILS=3; PUBLIC_FAILS=0; PUBLIC_REPAIRED_AT=0
  PUBCODE="200"; public_probe
  echo "answering:  fails=$PUBLIC_FAILS (want 0) repaired=$([ -s "$REPAIR_LOG" ] && echo yes || echo no) (want no)"
  PUBCODE="000"; public_probe; public_probe
  echo "down x2:    fails=$PUBLIC_FAILS (want 2) repaired=$([ -s "$REPAIR_LOG" ] && echo yes || echo no) (want no)"
  public_probe
  echo "down x3:    fails=$PUBLIC_FAILS (want 0) repaired=$([ -s "$REPAIR_LOG" ] && echo yes || echo no) (want yes)"
  [ -s "$REPAIR_LOG" ] || { echo "self-test: the tunnel was not repaired after $PUBLIC_MIN_FAILS failures"; exit 1; }
  before_at=$PUBLIC_REPAIRED_AT; : > "$REPAIR_LOG"
  public_probe; public_probe; public_probe
  echo "inside gap: repaired again=$([ -s "$REPAIR_LOG" ] && echo yes || echo no) (want no, one restart per ${PUBLIC_REPAIR_GAP}s)"
  [ -s "$REPAIR_LOG" ] && { echo "self-test: the tunnel was restarted twice inside the gap"; exit 1; }
  [ "$PUBLIC_REPAIRED_AT" = "$before_at" ] || { echo "self-test: the repair timestamp moved inside the gap"; exit 1; }
  PUBCODE="200"; public_probe
  echo "recovered:  fails=$PUBLIC_FAILS (want 0)"
  [ "$PUBLIC_FAILS" = "0" ] || { echo "self-test: the failure count did not reset on recovery"; exit 1; }
  CURL="$CURL_SAVED"; rm -f "$REPAIR_LOG"
  echo "--- wedged recovery (owned stub listener; never the live dashboard)"
  DASH_PORT=$((20000 + RANDOM % 20000)); START_ALL="echo start-all-called"
  before=$(pgrep -fc "^bash $HERE/watchdog.sh$" 2>/dev/null || true)
  node -e "require('http').createServer(() => {}).listen(process.argv[1], '127.0.0.1'); setInterval(() => {}, 1000)" "$DASH_PORT" >/dev/null 2>&1 &
  stub=$!
  for i in $(seq 1 50); do [ -n "$(dash_pid)" ] && break; sleep 0.2; done
  [ "$(dash_pid)" = "$stub" ] || { echo "self-test: stub listener did not appear on :$DASH_PORT"; kill "$stub" 2>/dev/null; exit 1; }
  out=$(stop_dashboard; start_dashboard "self-test")
  sleep 0.5
  alive=$(kill -0 "$stub" 2>/dev/null && echo yes || echo no)
  after=$(pgrep -fc "^bash $HERE/watchdog.sh$" 2>/dev/null || true)
  echo "wedged recovery: stub dashboard alive=$alive port free=$([ -z "$(dash_pid)" ] && echo yes || echo no) start called=$([ "$out" = "start-all-called" ] && echo yes || echo no) watchdogs before=${before:-0} after=${after:-0}"
  [ "$alive" = "no" ] && [ -z "$(dash_pid)" ] && [ "$out" = "start-all-called" ] && [ "${before:-0}" = "${after:-0}" ] || { echo "self-test: wedged recovery FAILED"; kill "$stub" 2>/dev/null; exit 1; }
  rm -f "$STATE" "$SELFTEST_LOG"; exit 0
fi

echo "$(date -Is) watchdog started (pid $$)" >> "$LOG"
discover_public_url
CYCLE=0
while true; do
  sleep 30
  if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8787$'; then
    echo "$(date -Is) dashboard not listening; restarting" >> "$LOG"
    record_restart
    start_dashboard "not listening on :${DASH_PORT} at $(date +%H:%M)" >> "$LOG" 2>&1
    PROBE_TIMEOUTS=0; PROBE_STALE=0
    sleep 60
    continue
  fi
  # The read-only second-chain viewer is not the dashboard: if it is missing, start
  # it and carry on. It never triggers a restart count, an alert or a stop, because
  # nothing depends on it and it cannot move funds.
  ARC_DIR="${LP_ARC_DATA_DIR:-$HOME/arc-data}"; ARC_PORT="${LP_ARC_PORT:-8797}"
  if [ -f "$ARC_DIR/settings.json" ] && ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${ARC_PORT}\$"; then
    echo "$(date -Is) arc viewer not listening; starting" >> "$LOG"
    LP_READONLY=1 nohup node "$HERE/server.js" --data-dir="$ARC_DIR" --port="$ARC_PORT" --no-loops --no-services \
      >> "$ARC_DIR/server.log" 2>&1 < /dev/null &
  fi
  CYCLE=$((CYCLE + 1))
  # The public path, on its own slower clock. Checked before the local probe's restart
  # branch so a tunnel outage is never confused with a dashboard one.
  if [ $((CYCLE % PUBLIC_EVERY)) -eq 0 ]; then
    discover_public_url
    public_probe
  fi
  if [ $((CYCLE % PROBE_EVERY)) -eq 0 ]; then
    probe
    if [ "${RESTART_NOW:-0}" = "1" ]; then
      echo "$(date -Is) dashboard not answering; restarting" >> "$LOG"
      record_restart
      stop_dashboard >> "$LOG" 2>&1
      start_dashboard "listening but not answering at $(date +%H:%M)" >> "$LOG" 2>&1
      PROBE_TIMEOUTS=0; PROBE_STALE=0
      sleep 60
    fi
  fi
done
