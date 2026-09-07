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
if ! curl -sf http://127.0.0.1:8787/api/positions >/dev/null 2>&1 && ! pgrep -f "^node server.js --port=8787" >/dev/null; then
  nohup node server.js --port=8787 > dashboard.log 2>&1 &
  echo "dashboard: started"
else echo "dashboard: running"; fi
./run-tailscale.sh >/dev/null 2>&1 && echo "tailscale: funnel on" || echo "tailscale: check ~/.local/state/tailscale/tailscaled.log"
if ! pgrep -f "lp-mcp-remote.mjs" >/dev/null; then
  nohup ./run-mcp-remote.sh > mcp-remote.log 2>&1 &
  echo "remote mcp: started"
else echo "remote mcp: running"; fi
if ! pgrep -f "lp-gate.mjs" >/dev/null; then
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
if ! pgrep -f "nightly.sh" >/dev/null; then
  nohup ./nightly.sh > /dev/null 2>&1 < /dev/null &
  echo "nightly: started"
else echo "nightly: running"; fi
