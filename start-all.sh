#!/usr/bin/env bash
# After a WSL restart: one command, one process, one log.
#
#   ./start-all.sh
#
# server.js is the dashboard and, in the same process, the risk guardian (60 s),
# fee auto-collect (15 min), the nightly ledger backup (02:00 local) and the
# supervisor for the companion services: the passphrase gate (lp-gate.mjs), the
# remote MCP server (run-mcp-remote.sh, when .env.mcp exists), the Tailscale
# funnel (run-tailscale.sh) and the pool scanner (when SCANNER_DIR is set).
# Everything logs to server.log. The 09:00 collector task is separate
# (windows-task.ps1 / crontab).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
# Secrets (Telegram, Blockscout, chat provider) live in ./.env as KEY=value
# lines; exported into the server's environment only, never printed.
# A .env that does not parse (an unbalanced quote after a hand edit) must not keep the
# dashboard down: check it in a subshell first, start without it if it is broken, and say so.
if [ -f "$HERE/.env" ]; then
  if envErr=$( (set -a; . "$HERE/.env") 2>&1 ); then set -a; . "$HERE/.env"; set +a;
  else echo "start-all: .env could not be read (${envErr##*: }) — starting WITHOUT it: no Telegram, no explorer key, no VPS sync until it is fixed"; fi
fi
# In-site chat (chat.js) needs ANTHROPIC_API_KEY or OLLAMA_API_KEY. When ./.env
# has neither, reuse the scanner's chat settings (same variable names).
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OLLAMA_API_KEY:-}" ]; then
  for f in "$HOME/.config/robinhood-lp.env" "${SCANNER_DIR:-/nonexistent}/.env"; do
    [ -f "$f" ] || continue
    set -a; . <(grep -E '^(ANTHROPIC_API_KEY|OLLAMA_API_KEY|OLLAMA_HOST|CHAT_MODEL|CHAT_PROVIDER|CHAT_EFFORT)=' "$f"); set +a
  done
fi
export SCANNER_DIR="${SCANNER_DIR:-}"

# The watchdog (watchdog.sh) restarts the dashboard within a minute if the process
# exits; started here unless --no-watchdog (the watchdog's own call), stopped by stop-all.sh.
if [ "${1:-}" != "--no-watchdog" ] && ! pgrep -f "^bash $HERE/watchdog.sh$" >/dev/null 2>&1; then
  nohup bash "$HERE/watchdog.sh" >/dev/null 2>&1 < /dev/null &
  echo "watchdog: started (pid $!) — restarts the dashboard if it exits; log in watchdog.log"
fi
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8787$'; then
  echo "dashboard: already running on :8787 (stop it first to restart: ./stop-all.sh)"
  exit 0
fi
nohup node server.js --port=8787 >> server.log 2>&1 < /dev/null &
echo "dashboard: started (pid $!) — everything logs to server.log"
