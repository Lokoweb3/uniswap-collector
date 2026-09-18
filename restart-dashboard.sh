#!/usr/bin/env bash
# Restart a dashboard instance, one instance only.
#
#   ./restart-dashboard.sh                                  # Arc, :8797
#   PORT=8787 DATA=/home/steven/uniswap-collector FLAGS="" ./restart-dashboard.sh
#
# FLAGS matters: the Arc instance runs --no-loops --no-services, the Robinhood one
# runs its background work. Restarting the latter with Arc's flags would silently
# stop every loop it is responsible for, so the caller states them.
#
# Two earlier restarts raced: a new process was launched while the old one still
# held the port, the newcomer died with EADDRINUSE, and the surviving process was
# whichever won. This waits for the port to be free before starting, and verifies
# exactly one listener afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8797}"
DATA="${DATA:-/home/steven/arc-data}"
FLAGS="${FLAGS---no-loops --no-services}"   # unset -> Arc's read-only pair; FLAGS="" -> none
LOG="${LOG:-$HERE/dashboard-$PORT.log}"

pids() { ss -ltnp 2>/dev/null | grep ":$PORT " | sed 's/.*pid=\([0-9]*\).*/\1/' | sort -u; }

for p in $(pids); do echo "stopping pid $p on :$PORT"; kill "$p" 2>/dev/null || true; done
for _ in $(seq 1 30); do [ -z "$(pids)" ] && break; sleep 1; done
if [ -n "$(pids)" ]; then
  for p in $(pids); do echo "pid $p did not stop; sending KILL"; kill -9 "$p" 2>/dev/null || true; done
  sleep 2
fi
[ -z "$(pids)" ] || { echo "port $PORT is still held by: $(pids)" >&2; exit 1; }

cd "$HERE"
# shellcheck disable=SC2086
nohup node server.js --data-dir="$DATA" --port="$PORT" $FLAGS >> "$LOG" 2>&1 &
started=$!
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/chain" >/dev/null 2>&1; then break; fi
  kill -0 "$started" 2>/dev/null || { echo "the process exited during startup; tail of $LOG:" >&2; tail -5 "$LOG" >&2; exit 1; }
  sleep 1
done

n=$(pids | wc -l)
[ "$n" -eq 1 ] || { echo "expected one listener on :$PORT, found $n: $(pids)" >&2; exit 1; }
echo "started pid $(pids) on :$PORT  (data $DATA, flags: ${FLAGS:-none}, log $LOG)"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/chain"; echo
