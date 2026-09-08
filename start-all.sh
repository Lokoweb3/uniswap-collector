#!/usr/bin/env bash
# After a WSL restart: bring up the dashboard, the user-space Tailscale
# tunnel, and the remote MCP server, each only if it is not already running.
# Logs: dashboard.log, mcp-remote.log, ~/.local/state/tailscale/tailscaled.log
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
# Secrets for the dashboard (Telegram alerts, Blockscout key) live in ./.env as
# KEY=value lines; exported into the server's environment only, never printed.
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

# Process checks. `pgrep -f` would match this script's own command line (and
# any shell that mentions the pattern), so processes are found by their exact
# argv[0..] with pgrep -x on the command name plus an anchored full-line match
# over /proc, and ports by ss. listening PORT -> 0 when something listens.
listening() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }
running() { # running <regex over the full command line>, excluding this shell and its children
  for d in /proc/[0-9]*; do
    [ "${d#/proc/}" = "$$" ] && continue
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$cmd" in *"$0"*) continue ;; esac
    printf '%s' "$cmd" | grep -Eq "$1" && return 0
  done
  return 1
}

if listening 8787; then
  echo "dashboard: running (port 8787 in use$(running '^node server\.js --port=8787 ' || echo ', by a process not started by this script'))"
elif running '^node server\.js'; then
  echo "dashboard: a 'node server.js' is running but port 8787 is not listening; check dashboard.log"
else
  nohup node server.js --port=8787 > dashboard.log 2>&1 &
  echo "dashboard: started"
fi
./run-tailscale.sh >/dev/null 2>&1 && echo "tailscale: funnel on" || echo "tailscale: check ~/.local/state/tailscale/tailscaled.log"
if ! running '^node .*lp-mcp-remote\.mjs' && ! listening 8788; then
  nohup ./run-mcp-remote.sh > mcp-remote.log 2>&1 &
  echo "remote mcp: started"
else echo "remote mcp: running"; fi
if ! running '^node lp-gate\.mjs'; then
  nohup node lp-gate.mjs > gate.log 2>&1 < /dev/null &
  echo "gate: started"
else echo "gate: running"; fi
# Robinhood LP pool scanner (separate project on the Windows drive). Its chat
# panel needs OLLAMA_API_KEY (or OLLAMA_HOST / ANTHROPIC_API_KEY); put those in
# <scanner dir>/.env or ~/.config/robinhood-lp.env as KEY=value lines.
SCANNER_DIR="${SCANNER_DIR:-/mnt/c/Users/<you>/Robinhood-LP}"
if [ -f "$SCANNER_DIR/server.js" ]; then
  if ! curl -sf http://127.0.0.1:3847/api/pools >/dev/null 2>&1; then
    ( set -a
      [ -f "$HOME/.config/robinhood-lp.env" ] && . "$HOME/.config/robinhood-lp.env"
      [ -f "$SCANNER_DIR/.env" ] && . "$SCANNER_DIR/.env"
      set +a
      cd "$SCANNER_DIR" && mkdir -p .cache && nohup setsid node server.js >> .cache/server.log 2>&1 < /dev/null & )
    echo "scanner: started"
  else echo "scanner: running"; fi
fi
# Nightly ledger backup at 02:00 (see nightly.sh / backup-ledgers.sh).
if ! running '^(/usr/bin/env )?bash \./nightly\.sh'; then
  nohup ./nightly.sh > /dev/null 2>&1 < /dev/null &
  echo "nightly: started"
else echo "nightly: running"; fi

# === memecoin-guardian ===
# Real-time watcher for the positions listed under `memecoins` in config.json.
if ! running '^node memecoin-guardian\.js'; then
  nohup node memecoin-guardian.js >> memecoin-guardian.log 2>&1 < /dev/null &
  echo "memecoin guardian: started"
else echo "memecoin guardian: running"; fi
# === end memecoin-guardian ===
