#!/usr/bin/env bash
# Stops the dashboard process (and with it the loops and the companion
# services it supervises). Tailscale's daemon is left running.
set -u
pid=$(ss -ltnp 2>/dev/null | awk '/:8787 /{print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -z "$pid" ]; then echo "dashboard: not running"; exit 0; fi
kill "$pid" && echo "dashboard: stopped (pid $pid)"
# Children the old separate-process layout may still have left behind.
for d in /proc/[0-9]*; do
  cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    "node memecoin-guardian.js"*|"node memecoin-collect.js"*|*"bash ./nightly.sh"*|"node lp-gate.mjs"*|"node "*"lp-mcp-remote.mjs"*) kill "${d#/proc/}" 2>/dev/null && echo "stopped: $cmd" ;;
  esac
done
