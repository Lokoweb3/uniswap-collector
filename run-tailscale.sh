#!/usr/bin/env bash
# Starts a user-space Tailscale daemon (no root needed) from ~/.local/tailscale
# and, once logged in, publishes the remote MCP server with Funnel. Run it
# whenever WSL starts, before ./run-mcp-remote.sh.
set -euo pipefail
TS="$HOME/.local/tailscale"; ST="$HOME/.local/state/tailscale"
SOCK="$ST/tailscaled.sock"
mkdir -p "$ST"
if ! "$TS/tailscale" --socket="$SOCK" status >/dev/null 2>&1; then
  nohup "$TS/tailscaled" --tun=userspace-networking --socket="$SOCK" --statedir="$ST" --port=41641 \
    > "$ST/tailscaled.log" 2>&1 &
  for i in $(seq 1 30); do "$TS/tailscale" --socket="$SOCK" status >/dev/null 2>&1 && break; sleep 0.5; done
fi
"$TS/tailscale" --socket="$SOCK" up --hostname=lp-dashboard --accept-dns=false
"$TS/tailscale" --socket="$SOCK" funnel --bg 8788                                  # public: MCP only
"$TS/tailscale" --socket="$SOCK" funnel --bg --https=8443 http://127.0.0.1:8790    # public: dashboard behind lp-gate.mjs (passphrase)
"$TS/tailscale" --socket="$SOCK" funnel --bg --https=10000 http://127.0.0.1:8791   # public: pool scanner behind lp-gate.mjs (passphrase)
# === weekly-digest-and-vault === tailnet-only (no Funnel, no gate): the dashboard itself, e.g. the vault at
# https://<your-node>.<your-tailnet>.ts.net:8444/vault, reachable only from devices logged into this tailnet.
"$TS/tailscale" --socket="$SOCK" serve --bg --https=8444 http://127.0.0.1:8787
"$TS/tailscale" --socket="$SOCK" funnel status
