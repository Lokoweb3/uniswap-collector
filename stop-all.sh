#!/usr/bin/env bash
# Stops the dashboard process (and with it the loops and the companion
# services it supervises). Tailscale's daemon is left running.
set -u
pid=$(ss -ltnp 2>/dev/null | awk '/:8787 /{print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -z "$pid" ]; then echo "dashboard: not running"; exit 0; fi
kill "$pid" && echo "dashboard: stopped (pid $pid)"
# Children the old separate-process layout may still have left behind.
for d in /proc/[0-9]*; do
  # Processes can exit between the glob and the read; a vanished cmdline is
  # not an error worth printing (the redirect fails before 2> applies, so the
  # 2>/dev/null has to come first).
  [ -r "$d/cmdline" ] || continue
  cmd=$(tr "\0" " " 2>/dev/null < "$d/cmdline") || continue
  case "$cmd" in
    "node memecoin-guardian.js"*|"node memecoin-collect.js"*|*"bash ./nightly.sh"*|"node lp-gate.mjs"*|"node "*"lp-mcp-remote.mjs"*) kill "${d#/proc/}" 2>/dev/null && echo "stopped: $cmd" ;;
  esac
done
