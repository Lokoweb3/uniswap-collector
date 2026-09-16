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
# Only one of these at a time. server.js runs this script on every start, and a
# rapid stop/start (or the watchdog restarting the dashboard while a previous start
# is still applying) put two runs against tailscaled's serve-config at once. The
# config is written whole, so the loser's last command clobbered the winner's
# earlier ones and a mapping silently vanished — twice it was 8443, the public
# dashboard, which then answered nothing while `funnel status` still said "Funnel on".
exec 9>"$ST/tailscale-setup.lock"
flock -w 120 9 || { echo "tailscale: another setup is running; leaving it to finish"; exit 0; }

"$TS/tailscale" --socket="$SOCK" up --hostname=lp-dashboard --accept-dns=false
"$TS/tailscale" --socket="$SOCK" funnel --bg 8788                                  # public: MCP only
"$TS/tailscale" --socket="$SOCK" funnel --bg --https=8443 http://127.0.0.1:8790    # public: dashboard behind lp-gate.mjs (passphrase)
"$TS/tailscale" --socket="$SOCK" funnel --bg --https=10000 http://127.0.0.1:8791   # public: pool scanner behind lp-gate.mjs (passphrase)
# === weekly-digest-and-vault === tailnet-only (no Funnel, no gate): the dashboard itself, e.g. the vault at
# https://<your-node>.<your-tailnet>.ts.net:8444/vault, reachable only from devices logged into this tailnet.
"$TS/tailscale" --socket="$SOCK" serve --bg --https=8444 http://127.0.0.1:8787
# Applying is not the same as being applied: verify every mapping we just asked for
# is actually in the config, and say so loudly if one is not, rather than reporting
# success because the commands exited 0.
missing=0
status="$("$TS/tailscale" --socket="$SOCK" funnel status 2>&1)"
for want in "8443.*8790" "10000.*8791" "8444.*8787"; do
  echo "$status" | tr '\n' ' ' | grep -qE "$want" || { echo "tailscale: WARNING — mapping $want is missing after setup"; missing=1; }
done
echo "$status"
[ "$missing" = "0" ] || exit 1
