#!/usr/bin/env bash
# Stops the dashboard process (and with it the loops and the companion
# services it supervises). Tailscale's daemon is left running.
set -u
# The watchdog first, or it would bring the dashboard straight back.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for w in $(pgrep -f "^bash $HERE/watchdog.sh$" 2>/dev/null); do kill "$w" 2>/dev/null && echo "watchdog: stopped (pid $w)"; done
# The read-only second-chain viewer, if one is running.
arcport="${LP_ARC_PORT:-8797}"
arcpid=$(ss -ltnp 2>/dev/null | awk -v p=":${arcport} " 'index($0, p) { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
[ -n "$arcpid" ] && kill "$arcpid" 2>/dev/null && echo "arc viewer: stopped (pid $arcpid)"
# And the Base viewer, by its own port only -- and only a process that really is the Base
# viewer: server.js started with the Base --data-dir. Whatever else holds that port is left alone.
PROC_ROOT=/proc
[ "${LP_TEST:-}" = "1" ] && PROC_ROOT="${LP_PROC_ROOT:-/proc}"   # a test (LP_TEST=1) may present a fake process table; never otherwise
baseport="${LP_BASE_PORT:-8796}"
basedir="${LP_BASE_DATA_DIR:-$HOME/base-data}"
basepid=$(ss -ltnp 2>/dev/null | awk -v p=":${baseport} " 'index($0, p) { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -n "$basepid" ]; then
  basecmd=$(tr "\0" " " 2>/dev/null < "$PROC_ROOT/$basepid/cmdline") || basecmd=""
  case " $basecmd" in
    *"server.js"*" --data-dir=$basedir "*) kill "$basepid" 2>/dev/null && echo "base viewer: stopped (pid $basepid)" ;;
    *) echo "base viewer: port $baseport is held by pid $basepid, which is not the Base viewer (server.js --data-dir=$basedir); left running" ;;
  esac
fi

# And the PulseChain viewer, the same way: its own port only, and only a process that really is it.
pulseport="${LP_PULSE_PORT:-8795}"
pulsedir="${LP_PULSE_DATA_DIR:-$HOME/pulse-data}"
pulsepid=$(ss -ltnp 2>/dev/null | awk -v p=":${pulseport} " 'index($0, p) { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -n "$pulsepid" ]; then
  pulsecmd=$(tr "\0" " " 2>/dev/null < "$PROC_ROOT/$pulsepid/cmdline") || pulsecmd=""
  case " $pulsecmd" in
    *"server.js"*" --data-dir=$pulsedir "*) kill "$pulsepid" 2>/dev/null && echo "pulsechain viewer: stopped (pid $pulsepid)" ;;
    *) echo "pulsechain viewer: port $pulseport is held by pid $pulsepid, which is not the PulseChain viewer (server.js --data-dir=$pulsedir); left running" ;;
  esac
fi

# And the Elysium TESTNET viewer, the same way: its own port only, and only a process that really is it.
elysiumport="${LP_ELYSIUM_TESTNET_PORT:-8794}"
elysiumdir="${LP_ELYSIUM_TESTNET_DATA_DIR:-$HOME/elysium-testnet-data}"
elysiumpid=$(ss -ltnp 2>/dev/null | awk -v p=":${elysiumport} " 'index($0, p) { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -n "$elysiumpid" ]; then
  elysiumcmd=$(tr "\0" " " 2>/dev/null < "$PROC_ROOT/$elysiumpid/cmdline") || elysiumcmd=""
  case " $elysiumcmd" in
    *"server.js"*" --data-dir=$elysiumdir "*) kill "$elysiumpid" 2>/dev/null && echo "elysium testnet viewer: stopped (pid $elysiumpid)" ;;
    *) echo "elysium testnet viewer: port $elysiumport is held by pid $elysiumpid, which is not the Elysium testnet viewer (server.js --data-dir=$elysiumdir); left running" ;;
  esac
fi

pid=$(ss -ltnp 2>/dev/null | awk '/:8787 /{print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -z "$pid" ]; then echo "dashboard: not running"; exit 0; fi
kill "$pid" && echo "dashboard: stopped (pid $pid)"
# Children the old separate-process layout may still have left behind.
for d in "$PROC_ROOT"/[0-9]*; do
  # Processes can exit between the glob and the read; a vanished cmdline is
  # not an error worth printing (the redirect fails before 2> applies, so the
  # 2>/dev/null has to come first).
  [ -r "$d/cmdline" ] || continue
  cmd=$(tr "\0" " " 2>/dev/null < "$d/cmdline") || continue
  case "$cmd" in
    "node memecoin-guardian.js"*|"node memecoin-collect.js"*|*"bash ./nightly.sh"*|"node lp-gate.mjs"*|"node chain-router.js"*|"node approve-serve.js"*|"node "*"lp-mcp-remote.mjs"*) kill "${d#"$PROC_ROOT"/}" 2>/dev/null && echo "stopped: $cmd" ;;
  esac
done
