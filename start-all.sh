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
# A second chain, read-only: its own data directory, its own port, its loops and
# companion services off, and LP_READONLY so it can never collect or arm. Started
# before the check below so a running main dashboard does not skip it. Skipped
# entirely when the data directory is absent, which is the single-chain install.
start_arc() {
  local dir="${LP_ARC_DATA_DIR:-$HOME/arc-data}" port="${LP_ARC_PORT:-8797}"
  [ -f "$dir/settings.json" ] || return 0
  # Retired chain: a file named .disabled in its data directory keeps the viewer off and
  # the chain out of the picker and the Portfolio page. Delete the file to bring it back.
  [ -f "$dir/.disabled" ] && { echo "arc viewer: disabled ($dir/.disabled)"; return 0; }
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    echo "arc viewer: already running on :${port}"
    return 0
  fi
  LP_READONLY=1 nohup node server.js --data-dir="$dir" --port="$port" --no-loops --no-services --claim-scan \
    >> "$dir/server.log" 2>&1 < /dev/null &
  echo "arc viewer: started (pid $!) on :${port} — read-only, logs in $dir/server.log"
}
start_arc

# Base (Aerodrome Slipstream, Uniswap v3/v4), the same way and for the same reasons as
# Arc: read-only, its own data directory and port, no loops, no companion services.
# Opt-in: nothing starts unless $dir/settings.json exists (copy settings.base.example.json
# there). BLOCKSCOUT_API_KEY / LP_BASE_RPC_URL, when wanted, come from ./.env above.
start_base() {
  local dir="${LP_BASE_DATA_DIR:-$HOME/base-data}" port="${LP_BASE_PORT:-8796}"
  [ -f "$dir/settings.json" ] || return 0
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    echo "base viewer: already running on :${port}"
    return 0
  fi
  LP_READONLY=1 nohup node server.js --data-dir="$dir" --port="$port" --no-loops --no-services \
    >> "$dir/server.log" 2>&1 < /dev/null &
  echo "base viewer: started (pid $!) on :${port} — read-only, logs in $dir/server.log"
}
start_base

# PulseChain (PulseX v1/v2 LP), the same way and for the same reasons: read-only, its own
# data directory and port, no loops, no companion services. Opt-in: nothing starts unless
# $dir/settings.json exists (copy settings.pulsechain.example.json there). LP_PULSE_RPC_URL,
# when wanted, comes from ./.env above.
start_pulse() {
  local dir="${LP_PULSE_DATA_DIR:-$HOME/pulse-data}" port="${LP_PULSE_PORT:-8795}"
  [ -f "$dir/settings.json" ] || return 0
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    echo "pulsechain viewer: already running on :${port}"
    return 0
  fi
  LP_READONLY=1 nohup node server.js --data-dir="$dir" --port="$port" --no-loops --no-services \
    >> "$dir/server.log" 2>&1 < /dev/null &
  echo "pulsechain viewer: started (pid $!) on :${port} — read-only, logs in $dir/server.log"
}
start_pulse

# Elysium TESTNET (an Arbitrum Orbit chain), the same way: read-only, its own data directory and
# port, no loops, no companion services, native balances only. Opt-in: nothing starts unless
# $dir/settings.json exists (copy settings.elysium-testnet.example.json there). The mainnet is
# disabled (awaiting verification) and has no variables here. LP_ELYSIUM_TESTNET_RPC_URL, when
# wanted, comes from ./.env above.
start_elysium_testnet() {
  local dir="${LP_ELYSIUM_TESTNET_DATA_DIR:-$HOME/elysium-testnet-data}" port="${LP_ELYSIUM_TESTNET_PORT:-8794}"
  [ -f "$dir/settings.json" ] || return 0
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    echo "elysium testnet viewer: already running on :${port}"
    return 0
  fi
  LP_READONLY=1 nohup node server.js --data-dir="$dir" --port="$port" --no-loops --no-services \
    >> "$dir/server.log" 2>&1 < /dev/null &
  echo "elysium testnet viewer: started (pid $!) on :${port} — TESTNET, read-only, logs in $dir/server.log"
}
start_elysium_testnet

# One URL for every chain: the router proxies to each chain's dashboard, namespaces
# their cookies so a session on one is never presented to the other, and injects the
# chain picker. The public gate (lp-gate.mjs) fronts this rather than a single
# chain's port, so without it the public address serves Robinhood alone. Only worth
# running when there is a second chain to switch to.
start_router() {
  local port="${LP_ROUTER_PORT:-8800}" chains="robinhood,arc"
  local arc_on=0 base_on=0 pulse_on=0 elysium_on=0
  [ -f "${LP_ARC_DATA_DIR:-$HOME/arc-data}/settings.json" ] && arc_on=1
  [ -f "${LP_BASE_DATA_DIR:-$HOME/base-data}/settings.json" ] && base_on=1
  [ -f "${LP_PULSE_DATA_DIR:-$HOME/pulse-data}/settings.json" ] && pulse_on=1
  [ -f "${LP_ELYSIUM_TESTNET_DATA_DIR:-$HOME/elysium-testnet-data}/settings.json" ] && elysium_on=1
  [ "$arc_on" = 1 ] || [ "$base_on" = 1 ] || [ "$pulse_on" = 1 ] || [ "$elysium_on" = 1 ] || return 0
  [ "$base_on" = 1 ] && chains="robinhood,arc,base"
  if [ -f "${LP_ARC_DATA_DIR:-$HOME/arc-data}/.disabled" ]; then # see start_arc
    arc_on=0; chains="${chains/,arc/}"
  fi
  [ "$pulse_on" = 1 ] && chains="${chains},pulsechain"
  [ "$elysium_on" = 1 ] && chains="${chains},elysium-testnet"
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    echo "chain router: already running on :${port}"
    return 0
  fi
  nohup node chain-router.js --port="$port" --chains="$chains" >> chain-router.log 2>&1 < /dev/null &
  echo "chain router: started (pid $!) on :${port} — one URL for every chain, logs in chain-router.log"
}
start_router

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8787$'; then
  echo "dashboard: already running on :8787 (stop it first to restart: ./stop-all.sh)"
  exit 0
fi
nohup node server.js --port=8787 >> server.log 2>&1 < /dev/null &
echo "dashboard: started (pid $!) — everything logs to server.log"
